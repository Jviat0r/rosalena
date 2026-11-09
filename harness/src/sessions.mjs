// Reading OTHER harnesses' sessions.
//
// The interop contract runs in both directions. Rosalena can be started and polled
// by another agent (that is `runs.mjs`), and it can also read the conversations the
// other harnesses on this machine already recorded - Claude Code, Codex, opencode
// and DSH itself. The second half is read-only on purpose: those directories belong
// to other tools, they change shape between versions, and a harness that writes into
// a competitor's store is a harness nobody should install.
//
// Every adapter is defensive. A file that moved, a schema that shifted, a compressed
// log with a torn frame - all of it returns "nothing here" instead of throwing,
// because the caller is a UI listing many sources at once and one broken source must
// not empty the list.
//
// Measured shapes (2026-10-19, this machine):
//   claude    ~/.claude/projects/<project>/<session>.jsonl
//             {"type":"custom-title","customTitle":...} / {"type":"ai-title",...}
//             {"type":"user"|"assistant","message":{"role","content":[...]}}
//   codex     ~/.codex/sessions/**/rollout-*.jsonl  (not installed here: 0 rows)
//             {"type":"session_meta","payload":{...}} / {"type":"response_item",...}
//   opencode  ~/.local/share/opencode/opencode.db (sqlite)
//             session(id,title,directory,time_updated)
//             message(id,session_id,data{role,time}) + part(message_id,data{type,text})
//   dsh       ~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd
//             a chain of independent zstd frames; frame 0 is the header
//             rows: user/message, assistant/message, session/title, model/selection

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { zstdDecompressSync } from "node:zlib";

const H = () => homedir();

export const SOURCES = ["rosalena", "claude", "codex", "opencode", "dsh"];

/** Where each adapter looks. Every root can be redirected for tests or a moved install. */
export function roots() {
  return {
    claude: process.env.ROSALENA_CLAUDE_DIR || join(H(), ".claude", "projects"),
    codex: process.env.ROSALENA_CODEX_DIR || join(H(), ".codex", "sessions"),
    opencode: process.env.ROSALENA_OPENCODE_DB || join(H(), ".local", "share", "opencode", "opencode.db"),
    dsh: process.env.ROSALENA_DSH_DIR || join(H(), ".dsh", "sessions"),
  };
}

const textOf = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (value.content !== undefined) return textOf(value.content);
    if (value.message !== undefined) return textOf(value.message);
    if (value.payload !== undefined) return textOf(value.payload);
    if (typeof value.message === "string") return value.message;
    return "";
  }
  return "";
};

const clip = (s, n) => {
  const flat = String(s ?? "").replace(/\r/g, "").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** Parsed JSON lines from a text file, tolerant of a torn last line. */
function jsonLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a killed writer leaves a partial line; skip it */
    }
  }
  return out;
}

/**
 * Read at most `maxBytes` from a file as lines. Claude logs reach 100 MB+, so the
 * whole file is never loaded: a session view needs the beginning, not the tail.
 */
async function headLines(file, { maxBytes = 2_000_000, maxLines = 4000 } = {}) {
  const lines = [];
  let bytes = 0;
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lines.push(line);
      bytes += line.length + 1;
      if (lines.length >= maxLines || bytes >= maxBytes) break;
    }
  } catch {
    /* unreadable file: whatever was read so far is still useful */
  } finally {
    rl.close();
    stream.destroy();
  }
  return { lines, truncated: lines.length >= maxLines || bytes >= maxBytes };
}

/**
 * The first `n` bytes of a file, as text. Titles live in the first lines, so listing
 * hundreds of sessions costs a few KB each instead of the whole transcript.
 */
function headBytes(file, n = 4096) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** DSH names a project folder after its workspace path: --D-AppDev-Ai~0020Ecosystem-- */
function dshProjectLabel(slug) {
  const inner = slug.replace(/^--/, "").replace(/--$/, "");
  return inner.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/-/g, "\\");
}

/** A title derived from a transcript, skipping the harness's own injected notices. */
const NOISE = /^(<system-reminder>|The approval policy changed|You are an AI agent|# (Instructions|Standing policies))/;
const titleFrom = (messages, fallback) => {
  const first = messages.find((m) => m.role === "user" && m.text.trim() && !NOISE.test(m.text.trim()));
  return clip(first?.text ?? fallback ?? "(no messages)", 80) || "(no messages)";
};

// ---------------------------------------------------------------- claude

const claudeList = ({ max = 100, titles = true } = {}) => {
  const root = roots().claude;
  if (!existsSync(root)) return [];
  const found = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      found.push({ source: "claude", id: basename(name, ".jsonl"), project: project.name, path, at: st.mtimeMs, bytes: st.size });
    }
  }
  found.sort((a, b) => b.at - a.at);
  const page = found.slice(0, max);
  // Titles ride in the first lines of the file, so only the page that is returned pays
  // for them; a caller that just wants a path (claudeRead) passes titles:false.
  return titles
    ? page.flatMap((row) => {
        const head = claudeHead(row.path);
        // A session file can exist with nothing in it (Claude Code creates one the
        // moment a project opens). Left in, those shells sit at the top of the list
        // forever, because their mtime keeps moving while their transcript is empty.
        if (!head.title && !head.sawMessage && (row.bytes ?? 0) < 8192) return [];
        return [{ ...row, title: head.title ?? head.first ?? row.id }];
      })
    : page;
};

/** The title line of a Claude Code log, without reading the transcript. */
function claudeHead(file) {
  const head = headBytes(file, 8192);
  let ai = null;
  let sawMessage = false;
  let first = null;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === "custom-title" && row.customTitle) return { title: row.customTitle, sawMessage, first };
    if (row.type === "ai-title" && row.aiTitle) ai = row.aiTitle;
    if (row.type === "user" || row.type === "assistant") {
      sawMessage = true;
      // No title row in the head: the opening line is a better label than a uuid,
      // unless that line is one of the harness's own injected notices.
      if (!first && row.type === "user") {
        const said = clip(textOf(row.message ?? row).replace(/\s+/g, " "), 70);
        if (said && !NOISE.test(said)) first = said;
      }
    }
  }
  return { title: ai, sawMessage, first };
}

const claudeRead = async (id, { max = 400, full = false } = {}) => {
  const row = claudeList({ max: 5000, titles: false }).find((r) => r.id === id);
  if (!row) return null;
  const { lines, truncated } = await headLines(
    row.path,
    full ? { maxBytes: Infinity, maxLines: Infinity } : { maxBytes: 6_000_000, maxLines: 4000 },
  );
  const messages = [];
  const calls = new Map(); // tool_use id -> its message, so the result lands on its call
  let title = null;
  let spoken = 0; // tool rows do not count toward the message cap
  for (const line of lines) {
    let row2;
    try {
      row2 = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row2.type;
    if (type === "custom-title" && row2.customTitle) title = title ?? row2.customTitle;
    else if (type === "ai-title" && row2.aiTitle) title = row2.aiTitle;
    if (type !== "user" && type !== "assistant") continue;
    // Injected notices (command caveats, hook output) are not something anyone said.
    if (row2.isMeta) continue;
    const content = row2.message?.content ?? row2.message ?? row2;
    const at = row2.timestamp ?? null;
    if (!Array.isArray(content)) {
      const text = clip(textOf(content), 20000);
      if (text) { messages.push({ role: type, text, at }); spoken++; }
    } else {
      // Claude stores tool results as "user" rows: those are the tool talking, not
      // the person, so each block is sorted by what it is rather than by the row's type.
      const said = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && block.text) said.push(block.text);
        else if (block.type === "tool_use") {
          const msg = { role: "tool", name: block.name ?? "tool", args: block.input ?? null, text: "", ok: true, at };
          calls.set(block.id, msg);
          messages.push(msg);
        } else if (block.type === "tool_result") {
          const result = clip(textOf(block.content), 8000);
          const call = calls.get(block.tool_use_id);
          if (call) {
            call.text = result;
            call.ok = block.is_error !== true;
          } else messages.push({ role: "tool", name: "result", args: null, text: result, ok: block.is_error !== true, at });
        }
        // thinking blocks are skipped: they are not part of the conversation shown
      }
      const text = clip(said.join("\n"), 20000);
      if (text) { messages.push({ role: type, text, at }); spoken++; }
    }
    if (spoken >= max) break;
  }
  return {
    meta: { source: "claude", id, title: title ?? titleFrom(messages, id), at: row.at, path: row.path, bytes: row.bytes },
    messages,
    truncated: truncated || spoken >= max,
  };
};

// ---------------------------------------------------------------- codex

const codexList = ({ max = 100 } = {}) => {
  const root = roots().codex;
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl")) {
        try {
          const st = statSync(p);
          found.push({ source: "codex", id: basename(e.name, ".jsonl"), path: p, at: st.mtimeMs, bytes: st.size });
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root);
  found.sort((a, b) => b.at - a.at);
  return found.slice(0, max);
};

const codexRead = async (id, { max = 400, full = false } = {}) => {
  const row = codexList({ max: 5000 }).find((r) => r.id === id);
  if (!row) return null;
  const { lines, truncated } = await headLines(
    row.path,
    full ? { maxBytes: Infinity, maxLines: Infinity } : { maxBytes: 4_000_000, maxLines: 4000 },
  );
  const messages = [];
  for (const line of lines) {
    let row2;
    try {
      row2 = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = row2.payload ?? {};
    // Two shapes: event_msg carries a plain string, response_item a content array.
    if (row2.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
      const text = clip(textOf(payload.message ?? payload.text), 20000);
      if (text) messages.push({ role: payload.type === "user_message" ? "user" : "assistant", text, at: row2.timestamp ?? null });
    } else if (row2.type === "response_item" && payload.type === "message" && payload.role) {
      const text = clip(textOf(payload.content), 20000);
      if (text) messages.push({ role: payload.role, text, at: row2.timestamp ?? null });
    }
    if (messages.length >= max) break;
  }
  return {
    meta: { source: "codex", id, title: titleFrom(messages, id), at: row.at, path: row.path, bytes: row.bytes },
    messages,
    truncated: truncated || messages.length >= max,
  };
};

// ---------------------------------------------------------------- opencode

let sqliteModule;
async function sqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = await import("node:sqlite");
  } catch {
    sqliteModule = null; // older Node: opencode rows are simply unavailable
  }
  return sqliteModule;
}

const opencodeOpen = async ({ readOnly = true } = {}) => {
  const mod = await sqlite();
  if (!mod?.DatabaseSync) return null;
  const dbPath = roots().opencode;
  if (!existsSync(dbPath)) return null;
  try {
    return new mod.DatabaseSync(dbPath, { readOnly });
  } catch {
    return null;
  }
};

/**
 * Which of two table names a store actually has. opencode changed its schema
 * between releases (`session`/`message`/`part` in v1, `session_v2`/`session_message`
 * in v2), and a store that has only the new names throws "no such table" on the old
 * query - which used to be swallowed as "no sessions", so a v2 store looked empty.
 */
const hasTable = (db, name) => {
  try {
    return Boolean(db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(name));
  } catch {
    return false;
  }
};

const opencodeList = async ({ max = 100 } = {}) => {
  const db = await opencodeOpen();
  if (!db) return [];
  try {
    const table = hasTable(db, "session") ? "session" : hasTable(db, "session_v2") ? "session_v2" : null;
    if (!table) return [];
    // `select *` on purpose: the v2 table carries the same logical columns under
    // names that have already moved once, and an unknown extra column is harmless.
    const rows = db.prepare(`select * from ${table} order by time_updated desc limit ?`).all(max);
    return rows.map((r) => ({
      source: "opencode",
      id: r.id,
      title: clip(r.title ?? r.id, 80),
      project: r.directory ?? r.worktree ?? r.path ?? null,
      at: Number(r.time_updated ?? r.time_created ?? 0),
      path: roots().opencode,
      bytes: null,
    }));
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
};

const opencodeRead = async (id, { max = 400 } = {}) => {
  const db = await opencodeOpen();
  if (!db) return null;
  try {
    const sessionTable = hasTable(db, "session") ? "session" : hasTable(db, "session_v2") ? "session_v2" : null;
    const session = sessionTable ? db.prepare(`select * from ${sessionTable} where id = ?`).get(id) : undefined;
    const messages = [];
    // v1 store: message rows carry the role, part rows carry the text. Both tables
    // are checked first: on a v2 store the old query throws "no such table" and the
    // fallback below would never be reached.
    const msgs = hasTable(db, "message") && hasTable(db, "part")
      ? db.prepare("select id, data, time_created from message where session_id = ? order by time_created limit ?").all(id, max)
      : [];
    for (const m of msgs) {
      let data;
      try {
        data = JSON.parse(m.data);
      } catch {
        continue;
      }
      const parts = db.prepare("select data from part where message_id = ? order by time_created").all(m.id);
      const text = parts
        .map((p) => {
          try {
            const d = JSON.parse(p.data);
            return d.type === "text" ? textOf(d) : "";
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join("\n");
      if (text.trim()) messages.push({ role: data.role ?? "assistant", text: clip(text, 20000), at: data.time?.created ?? Number(m.time_created) });
    }
    // v2 store, used by newer opencode builds: session_message(type, data.content).
    if (!messages.length && hasTable(db, "session_message")) {
      const rows = db.prepare("select type, data, time_created from session_message where session_id = ? order by time_created limit ?").all(id, max);
      for (const r of rows) {
        if (r.type !== "user" && r.type !== "assistant") continue;
        let data;
        try {
          data = JSON.parse(r.data);
        } catch {
          continue;
        }
        const text = clip(textOf(data.content ?? data.message ?? data), 20000);
        if (text.trim()) messages.push({ role: r.type, text, at: data.time?.created ?? Number(r.time_created) });
      }
    }
    if (!session && !messages.length) return null;
    return {
      meta: {
        source: "opencode",
        id,
        title: clip(session?.title ?? titleFrom(messages, id), 80),
        project: session?.directory ?? session?.worktree ?? null,
        at: Number(session?.time_updated ?? session?.time_created ?? 0),
        path: roots().opencode,
        bytes: null,
      },
      messages,
      truncated: messages.length >= max,
    };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
};

// ---------------------------------------------------------------- dsh

/**
 * DSH appends one independent zstd frame per write, so a log is a chain, not a
 * single stream: decompressing from the file start stops after frame 0 and reports
 * a one-row session. Each frame is decoded from its own offset (the frame magic).
 */
function dshRows(file, { maxFrames = 6000 } = {}) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return [];
  }
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  for (let i = 0; (i = buf.indexOf(magic, i)) !== -1; i += 4) offsets.push(i);
  const rows = [];
  for (const offset of offsets.slice(0, maxFrames)) {
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(offset)).toString("utf8");
    } catch {
      continue; // a false-positive magic inside compressed bytes, or a torn frame
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  }
  return rows;
}

const dshList = ({ max = 100 } = {}) => {
  const root = roots().dsh;
  if (!existsSync(root)) return [];
  const found = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const dir = join(root, project.name);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = join(dir, e.name, "session.v4.jsonl.zstd");
      if (!existsSync(file)) continue;
      try {
        const st = statSync(file);
        found.push({
          source: "dsh",
          id: e.name,
          project: project.name,
          // A real title lives inside the compressed rows; decoding every log to fill a
          // sidebar costs a second each. The project label is honest and free.
          title: dshProjectLabel(project.name),
          path: file,
          at: st.mtimeMs,
          bytes: st.size,
        });
      } catch {
        /* skip */
      }
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found.slice(0, max);
};

const dshRead = (id, { max = 400 } = {}) => {
  const row = dshList({ max: 5000 }).find((r) => r.id === id);
  if (!row) return null;
  const rows = dshRows(row.path);
  const messages = [];
  let title = null;
  let model = null;
  for (const r of rows) {
    const data = r.data ?? {};
    if (r.type === "session/title" && data.title) title = data.title;
    else if (r.type === "model/selection") model = data.model?.id ?? data.model ?? data.modelID ?? model;
    else if (r.type === "user/message" || r.type === "assistant/message") {
      const text = clip(textOf(data.message ?? data), 20000);
      if (text.trim()) messages.push({ role: r.type === "user/message" ? "user" : "assistant", text, at: r.time ?? null });
      if (messages.length >= max) break;
    }
  }
  return {
    meta: { source: "dsh", id, title: clip(title ?? titleFrom(messages, id), 80), model, at: row.at, path: row.path, bytes: row.bytes },
    messages,
    truncated: messages.length >= max,
  };
};

// ---------------------------------------------------------------- facade

const ADAPTERS = {
  claude: { list: claudeList, read: claudeRead },
  codex: { list: codexList, read: codexRead },
  opencode: { list: opencodeList, read: opencodeRead },
  dsh: { list: dshList, read: dshRead },
};

/**
 * Every session this machine has, oldest-harness-agnostic, newest first per source.
 * A source that is missing or broken contributes an empty list plus a `note`, so the
 * UI can say "Codex: not installed" instead of silently showing nothing.
 */
export async function listExternalSessions({ sources = ["claude", "codex", "opencode", "dsh"], max = 60 } = {}) {
  const out = [];
  const notes = [];
  for (const source of sources) {
    const adapter = ADAPTERS[source];
    if (!adapter) continue;
    try {
      const rows = await adapter.list({ max });
      out.push(...rows);
      if (!rows.length) {
        const root = roots()[source];
        notes.push({ source, note: existsSync(root) ? "no sessions found" : `not installed (${root})` });
      }
    } catch (err) {
      notes.push({ source, note: `unreadable: ${err?.message ?? err}` });
    }
  }
  return { sessions: out, notes, roots: roots() };
}

/** One session, by source and id. Returns null when it cannot be found or read. */
export async function readExternalSession({ source, id, max = 400, full = false } = {}) {
  const adapter = ADAPTERS[source];
  if (!adapter || !id) return null;
  try {
    return await adapter.read(id, { max: full ? 1_000_000 : max, full });
  } catch {
    return null;
  }
}

/** Counts per source without reading any transcript - what the UI footer shows. */
export async function sessionCounts({ max = 1000 } = {}) {
  const counts = {};
  for (const [source, adapter] of Object.entries(ADAPTERS)) {
    try {
      counts[source] = (await adapter.list({ max })).length;
    } catch {
      counts[source] = 0;
    }
  }
  return counts;
}
