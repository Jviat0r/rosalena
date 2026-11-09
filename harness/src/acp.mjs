/**
 * Agent Client Protocol (ACP) server: lets an editor (Zed, JetBrains, Neovim, ...) drive
 * the harness the way it drives Claude Code, Gemini CLI or Codex.
 *
 * Spec followed: ACP protocol version 1, JSON schema release schema-v1.29.1
 * (github.com/agentclientprotocol/agent-client-protocol, schema/v1/schema.json, read
 * 2026-11-03) and the prose at agentclientprotocol.com/protocol/*.
 *
 *   node src/cli.mjs --acp            the editor spawns this and talks over stdio
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout carries protocol
 * messages and NOTHING else - one stray log line and the editor drops the connection -
 * so every diagnostic goes to stderr, and while the server owns process.stdout the
 * console methods are pointed at stderr too (a plugin that console.logs must not be able
 * to break the session).
 *
 * What is implemented (agent side):
 *   initialize            protocolVersion 1; capabilities below; no auth methods
 *   authenticate          accepted and answered {} (there is nothing to sign in to)
 *   session/new           cwd -> the run's root; a session keeps the engine's message
 *                         history, so a second prompt continues the first
 *   session/load          only when a `sessionsDir` is given: sessions are written there
 *                         after every turn and the visible transcript is replayed as
 *                         user_message_chunk / agent_message_chunk / tool_call updates
 *   session/prompt        one runAgent call per turn, streamed as session/update
 *   session/cancel        stops the turn (see "Cancelling" below)
 *   session/set_mode      the access modes: workspace, full, read, plan
 *   session/close         cancels the turn and forgets the session
 * Client methods used: session/request_permission (every approval the engine asks for)
 * and session/update. fs/* and terminal/* are NOT used even when the client offers them:
 * the engine's own tools read, write and run inside the workspace, with its own
 * permission rules, and routing them through the editor would be a second
 * implementation of the same tools with different failure modes. Client-supplied MCP
 * servers are accepted and ignored (logged): the harness's MCP client (mcp-manager)
 * only runs servers a human registered, and that rule is not ours to bypass.
 *
 * Mapping from engine events (agent.mjs `emit`) to session/update:
 *   delta              -> agent_message_chunk (a delegated worker's prose: agent_thought_chunk)
 *   approval asked     -> tool_call (pending) + session/request_permission
 *   tool about to run  -> tool_call / tool_call_update (in_progress), via a beforeTool hook,
 *                         because the engine emits `tool` only after the tool ran
 *   tool               -> tool_call_update (completed | failed), or a whole tool_call when
 *                         nothing announced it (a refused call)
 *   todo_write         -> plan (the todo list IS the agent plan; no tool_call for it)
 *   plan (plan mode)   -> plan, then a permission request to approve it
 *   notice             -> agent_thought_chunk
 *
 * Cancelling. The engine checks for a cancel only between steps, and only when the run is
 * recorded to disk (`cancelRequested`). That is too coarse for an editor's stop button, so
 * a turn is stopped three ways at once: the router call in flight is aborted (fetchImpl
 * is wrapped with the turn's AbortSignal), a beforeStep hook stops the loop at the next
 * step and a beforeTool hook refuses any further tool, and the run-store flag is written
 * too when runs are on. A tool that is already running (a long build) is not killed: it
 * finishes, and the turn ends right after it. Whatever the engine reports, a turn the
 * client cancelled answers stopReason "cancelled", as the spec requires.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { runAgent } from "./agent.mjs";
import { newRunId, requestCancel } from "./runs.mjs";

export const ACP_PROTOCOL_VERSION = 1;

// JSON-RPC 2.0 plus the two ACP-specific codes (schema ErrorCode).
export const ERR = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  AUTH_REQUIRED: -32000,
  NOT_FOUND: -32002,
});

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/**
 * The access modes the composer offers, as ACP session modes. "plan" is plan mode on top
 * of the workspace mode: read-only until the plan is approved, then workspace rules.
 */
export const MODES = Object.freeze([
  { id: "workspace", name: "Workspace", description: "Change files in the project; ask before anything outside it." },
  { id: "auto", name: "Auto", description: "Workspace rules, but a reviewer model decides what would have asked you; after 3 refusals in a row it asks you again." },
  { id: "full", name: "Full access", description: "Act without asking, except where an approval rule says to ask." },
  { id: "read", name: "Read only", description: "Investigate only: writes, edits and changing commands are refused." },
  { id: "plan", name: "Plan", description: "Read-only until you approve the plan, then workspace rules." },
]);
const MODE_IDS = new Set(MODES.map((m) => m.id));

/** The app's version, so the editor's "about this agent" says which build it talks to. */
function harnessVersion() {
  for (const rel of ["../../desktop/package.json", "../package.json"]) {
    try {
      const v = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")).version;
      if (typeof v === "string" && v) return v;
    } catch {
      // the next candidate, then the fallback
    }
  }
  return "0.0.0";
}

// ------------------------------------------------------------------ tool presentation

const READ_TOOLS = new Set(["read_file", "list_dir", "read_image", "todo_read", "recall", "job_output", "job_list", "session_search", "skill", "goal_state", "leftover_processes"]);
const SEARCH_TOOLS = new Set(["search", "glob", "web_search"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file", "remember", "goal_update"]);
const EXECUTE_TOOLS = new Set(["run_command", "job_kill"]);

/** ToolKind for a tool name: the icon the editor shows. Unknown plugin tools are "other". */
export function toolKind(name) {
  const n = String(name ?? "");
  if (READ_TOOLS.has(n)) return "read";
  if (SEARCH_TOOLS.has(n)) return "search";
  if (EDIT_TOOLS.has(n)) return "edit";
  if (EXECUTE_TOOLS.has(n)) return "execute";
  if (n === "web_fetch") return "fetch";
  if (n === "exit_plan_mode") return "switch_mode";
  if (n === "delegate" || n === "todo_write") return "think";
  if (/delete|remove|unlink/i.test(n)) return "delete";
  if (/move|rename/i.test(n)) return "move";
  return "other";
}

const parseArgs = (args) => {
  if (args && typeof args === "object") return args;
  try {
    const parsed = JSON.parse(String(args ?? "") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const clip = (text, n) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * Title, kind, locations and (for edits) a diff for one call. ACP paths must be absolute,
 * and the engine's are relative to the workspace, so they are resolved against the root.
 */
export function describeTool(name, rawArgs, root) {
  const args = parseArgs(rawArgs);
  const abs = (p) => (typeof p === "string" && p ? (isAbsolute(p) ? p : resolve(root, p)) : null);
  const path = abs(args.path);
  const kind = toolKind(name);
  let title = name;
  if (name === "read_file") title = `Read ${args.path ?? ""}`;
  else if (name === "write_file") title = `Write ${args.path ?? ""}`;
  else if (name === "edit_file") title = `Edit ${args.path ?? ""}`;
  else if (name === "list_dir") title = `List ${args.path ?? "."}`;
  else if (name === "search") title = `Search /${clip(args.pattern, 60)}/${args.path ? ` in ${args.path}` : ""}`;
  else if (name === "glob") title = `Find ${clip(args.pattern, 60)}`;
  else if (name === "run_command") title = `Run ${clip(args.command, 100)}`;
  else if (name === "web_fetch") title = `Fetch ${clip(args.url, 100)}`;
  else if (name === "web_search") title = `Search the web: ${clip(args.query, 80)}`;
  else if (name === "delegate") title = `Delegate: ${clip(args.task, 80)}`;
  else if (name === "exit_plan_mode") title = "Approve the plan";
  const out = { title: title.trim() || name, kind };
  if (path) out.locations = [{ path, ...(Number.isInteger(args.offset) && args.offset > 0 ? { line: args.offset } : {}) }];
  if (path && name === "edit_file" && typeof args.new_text === "string") {
    out.content = [{ type: "diff", path, oldText: typeof args.old_text === "string" ? args.old_text : null, newText: args.new_text }];
  } else if (path && name === "write_file" && typeof args.content === "string") {
    out.content = [{ type: "diff", path, oldText: null, newText: args.content }];
  }
  return out;
}

/** The engine's plan text as ACP plan entries: one per list item, or the whole text. */
export function planEntries(plan) {
  const lines = String(plan ?? "").split(/\r?\n/);
  const items = [];
  for (const l of lines) {
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(l);
    if (m) items.push(m[1].trim());
  }
  const texts = items.length ? items : [clip(plan, 500)].filter(Boolean);
  return texts.map((content) => ({ content, priority: "medium", status: "pending" }));
}

/** todo_write's list as plan entries. Unknown statuses read as pending, never dropped. */
export function todoEntries(todos) {
  if (!Array.isArray(todos)) return [];
  return todos
    .filter((t) => t && typeof t.content === "string" && t.content.trim())
    .map((t) => ({
      content: t.content.trim(),
      priority: "medium",
      status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
    }));
}

// ------------------------------------------------------------------ prompt content

const IMAGE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };

function uriToPath(uri) {
  try {
    return String(uri).startsWith("file:") ? fileURLToPath(uri) : String(uri);
  } catch {
    return String(uri);
  }
}

/**
 * ContentBlock[] -> the task text plus image paths for runAgent. Images are written to a
 * temp file because the engine takes images as paths (images.mjs), the same as the
 * window's attachments. Embedded resources become fenced text; a link becomes its path,
 * which the model can read with its own tools.
 */
export function promptToTask(blocks, { imageDir = join(tmpdir(), "rosalena-acp-images") } = {}) {
  if (!Array.isArray(blocks)) throw new RpcError(ERR.INVALID_PARAMS, "prompt must be an array of content blocks");
  const parts = [];
  const images = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") parts.push(String(b.text ?? ""));
    else if (b.type === "resource_link") parts.push(`[attached: ${uriToPath(b.uri)}]`);
    else if (b.type === "resource") {
      const r = b.resource ?? {};
      if (typeof r.text === "string") parts.push(`Attached ${uriToPath(r.uri)}:\n\`\`\`\n${r.text}\n\`\`\``);
      else parts.push(`[attached binary resource ${uriToPath(r.uri)} - not readable here]`);
    } else if (b.type === "image" && typeof b.data === "string" && IMAGE_EXT[b.mimeType]) {
      mkdirSync(imageDir, { recursive: true });
      const file = join(imageDir, `${randomUUID()}${IMAGE_EXT[b.mimeType]}`);
      writeFileSync(file, Buffer.from(b.data, "base64"));
      images.push(file);
    } else {
      parts.push(`[a ${b.type} block was attached; this agent cannot read that kind]`);
    }
  }
  const text = parts.join("\n\n").trim();
  // runAgent needs words to act on; a picture pasted on its own still means "look at this".
  return { task: text || (images.length ? "Look at the attached image(s)." : ""), images };
}

// ------------------------------------------------------------------ the server

/**
 * Serve ACP until `input` ends. Resolves once every running turn has settled.
 *
 * `defaults` is spread into every runAgent call (routerUrl, cls, maxSteps, extraTools,
 * extraHooks, ...); the session supplies root, messages, accessMode and planMode.
 * `sessionsDir` turns on session/load: each session is saved there as JSON after each turn.
 */
export function serveAcp({
  input = process.stdin,
  output = process.stdout,
  runAgentImpl = runAgent,
  defaults = {},
  sessionsDir = null,
  log = (m) => process.stderr.write(`[acp] ${m}\n`),
} = {}) {
  const sessions = new Map();
  const waiting = new Map(); // our outgoing request id -> { resolve }
  const inflight = new Set(); // promises of requests still being handled
  let nextId = 1;

  // While this server owns the real stdout, nothing else may write prose to it.
  const restoreConsole = output === process.stdout ? routeConsoleToStderr() : () => {};

  const send = (msg) => {
    try {
      output.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    } catch (err) {
      log(`write failed: ${err?.message ?? err}`);
    }
  };
  const notify = (method, params) => send({ method, params });
  const update = (sessionId, u) => notify("session/update", { sessionId, update: u });
  const request = (method, params) => {
    const id = nextId++;
    const p = new Promise((res) => waiting.set(id, { resolve: res }));
    send({ id, method, params });
    return { id, promise: p };
  };

  const sessionFile = (id) => {
    // Ids come from the client on session/load: never let one name a path.
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(id))) throw new RpcError(ERR.NOT_FOUND, `no such session: ${id}`);
    return join(sessionsDir, `${id}.json`);
  };
  const persist = (s) => {
    if (!sessionsDir) return;
    try {
      mkdirSync(sessionsDir, { recursive: true });
      const file = sessionFile(s.id);
      const body = JSON.stringify({ id: s.id, cwd: s.cwd, mode: s.mode, messages: s.messages, transcript: s.transcript, updated: new Date().toISOString() });
      // Write-then-rename: a crash mid-write must not leave a session that cannot load.
      writeFileSync(`${file}.tmp`, body, "utf8");
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      log(`could not save session ${s.id}: ${err?.message ?? err}`);
    }
  };

  const newSession = (id, cwd, saved = null) => {
    const defaultMode = defaults.planMode ? "plan" : MODE_IDS.has(defaults.accessMode) ? defaults.accessMode : "workspace";
    const s = {
      id,
      cwd,
      mode: saved?.mode && MODE_IDS.has(saved.mode) ? saved.mode : defaultMode,
      messages: Array.isArray(saved?.messages) ? saved.messages : null,
      // What the editor was shown, for session/load. The engine's history holds system
      // prompts and plugin notes as user messages; replaying those would put words in
      // the user's mouth.
      transcript: Array.isArray(saved?.transcript) ? saved.transcript : [],
      // "Always allow" / "always deny" for the life of the session. The engine's own
      // allow-list is per run, and here every prompt is a new run.
      always: new Set(),
      never: new Set(),
      turn: null,
      seq: 0,
    };
    sessions.set(id, s);
    return s;
  };

  const getSession = (id) => {
    const s = sessions.get(id);
    if (!s) throw new RpcError(ERR.NOT_FOUND, `no such session: ${id}`);
    return s;
  };

  const modeState = (s) => ({ currentModeId: s.mode, availableModes: MODES.map((m) => ({ ...m })) });

  const absoluteCwd = (cwd) => {
    if (typeof cwd !== "string" || !cwd.trim()) throw new RpcError(ERR.INVALID_PARAMS, "cwd is required");
    if (!isAbsolute(cwd)) throw new RpcError(ERR.INVALID_PARAMS, `cwd must be an absolute path: ${cwd}`);
    return resolve(cwd);
  };

  const noteMcp = (servers) => {
    if (Array.isArray(servers) && servers.length) {
      log(`ignoring ${servers.length} client MCP server(s) (${servers.map((m) => m?.name ?? "?").join(", ")}): register them with /mcp-manager instead`);
    }
  };

  /** Stop a turn. Pending permission prompts are answered "cancelled" here, without
   *  waiting on the client: it must answer them too, but the turn may not hang if it doesn't. */
  const cancelTurn = (s) => {
    const turn = s.turn;
    if (!turn || turn.ac.signal.aborted) return;
    turn.ac.abort(new Error("cancelled by the client"));
    for (const id of turn.permissionIds) {
      const w = waiting.get(id);
      if (w) {
        waiting.delete(id);
        w.resolve({ result: { outcome: { outcome: "cancelled" } } });
      }
    }
    if (turn.runId && defaults.runs !== false) {
      const r = requestCancel({ dir: defaults.runsDir ?? undefined, id: turn.runId });
      if (!r.ok) log(`run-store cancel: ${r.reason}`);
    }
  };

  async function runTurn(s, params) {
    if (s.turn) throw new RpcError(ERR.INVALID_REQUEST, "a prompt is already running in this session; cancel it first");
    const { task, images } = promptToTask(params?.prompt);
    if (!task) throw new RpcError(ERR.INVALID_PARAMS, "the prompt is empty");

    const sid = s.id;
    const ac = new AbortController();
    const runId = defaults.runs === false ? null : newRunId();
    // Tool calls announced but not finished, per depth: 0 is the run, 1 a delegated worker.
    // Calls run one at a time at each depth, so one slot per depth is exact.
    const current = [null, null];
    const turn = { ac, runId, permissionIds: new Set(), streamed: false, agentText: "" };
    s.turn = turn;
    s.transcript.push({ role: "user", text: task });

    const flushAgentText = () => {
      if (turn.agentText) s.transcript.push({ role: "agent", text: turn.agentText });
      turn.agentText = "";
    };
    const say = (text) => {
      if (!text) return;
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      turn.agentText += text;
    };
    const think = (text) => {
      if (text) update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
    };

    const openCall = (depth, name, args, status) => {
      const id = `${sid}:${++s.seq}`;
      const info = describeTool(name, args, s.cwd);
      const call = { id, name, status, title: info.title, kind: info.kind };
      current[depth] = call;
      update(sid, { sessionUpdate: "tool_call", toolCallId: id, ...info, status, rawInput: parseArgs(args) });
      return { call, info };
    };
    const closeCall = (depth, e) => {
      const status = e.ok ? "completed" : "failed";
      const preview = String(e.preview ?? "");
      const c = current[depth];
      current[depth] = null;
      // An edit keeps the diff it opened with; everything else shows what the tool said.
      const content = c && toolKind(c.name) === "edit" ? undefined : preview ? [{ type: "content", content: { type: "text", text: preview } }] : undefined;
      const rawOutput = { ok: Boolean(e.ok), ms: e.ms ?? null, preview };
      if (c && c.name === e.name) {
        update(sid, { sessionUpdate: "tool_call_update", toolCallId: c.id, status, ...(content ? { content } : {}), rawOutput });
        flushAgentText();
        s.transcript.push({ role: "tool", title: c.title, kind: c.kind, status });
        return;
      }
      // Nothing announced it (the gate refused it outright): report it whole.
      const id = `${sid}:${++s.seq}`;
      const info = describeTool(e.name, e.args, s.cwd);
      update(sid, { sessionUpdate: "tool_call", toolCallId: id, ...info, status, ...(content ? { content } : {}), rawInput: parseArgs(e.args), rawOutput });
      flushAgentText();
      s.transcript.push({ role: "tool", title: info.title, kind: info.kind, status });
    };

    const onEvent = (e) => {
      try {
        defaults.onEvent?.(e);
      } catch {
        // a logging callback must never change the protocol stream
      }
      if (!e || typeof e !== "object") return;
      const depth = e.sub ? 1 : 0;
      if (e.type === "delta") {
        if (!e.text) return;
        if (e.sub) think(e.text);
        else {
          turn.streamed = true;
          say(e.text);
        }
      } else if (e.type === "tool") {
        if (e.name === "todo_write") {
          if (e.ok) update(sid, { sessionUpdate: "plan", entries: todoEntries(parseArgs(e.args).todos) });
          if (current[depth]?.name === "todo_write") current[depth] = null;
          return;
        }
        closeCall(depth, e);
      } else if (e.type === "plan" && !e.sub) {
        update(sid, { sessionUpdate: "plan", entries: planEntries(e.plan) });
      } else if (e.type === "notice") {
        think(`${Array.isArray(e.from) && e.from.length ? `[${e.from.join(", ")}] ` : ""}${e.text ?? ""}\n`);
      } else if (e.type === "error") {
        log(`run error: ${e.message}`);
      }
    };

    const approve = async (req) => {
      if (ac.signal.aborted) return { decision: "deny", note: "the turn was cancelled", by: "acp" };
      // A worker asks while its parent's delegate call is already running.
      const depth = current[0]?.status === "in_progress" ? 1 : 0;
      const isPlan = req?.kind === "plan";
      const name = isPlan ? "exit_plan_mode" : String(req?.tool ?? "?");
      const key = `${name}\u0000${req?.subject ?? ""}`;
      if (!isPlan && s.always.has(key)) return { decision: "allow", by: "acp:always" };
      if (!isPlan && s.never.has(key)) return { decision: "deny", note: "the user chose to always deny this", by: "acp:never" };
      const { call, info } = openCall(depth, name, isPlan ? { plan: req.plan } : req?.args ?? {}, "pending");
      const body = isPlan
        ? [{ type: "content", content: { type: "text", text: String(req.plan ?? "") } }]
        : info.content ?? (req?.reason ? [{ type: "content", content: { type: "text", text: `Needs approval: ${req.reason}` } }] : undefined);
      const options = isPlan
        ? [
            { optionId: "approve", name: "Approve the plan and start", kind: "allow_once" },
            { optionId: "reject", name: "Keep planning", kind: "reject_once" },
          ]
        : [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always allow in this session", kind: "allow_always" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
            { optionId: "never", name: "Always deny in this session", kind: "reject_always" },
          ];
      const { id, promise } = request("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: call.id, title: call.title, kind: call.kind, status: "pending", rawInput: isPlan ? { plan: req.plan } : req?.args ?? {}, ...(body ? { content: body } : {}) },
        options,
      });
      turn.permissionIds.add(id);
      const reply = await promise;
      turn.permissionIds.delete(id);
      const outcome = reply?.result?.outcome;
      const picked = outcome?.outcome === "selected" ? outcome.optionId : null;
      if (!picked || ac.signal.aborted) return { decision: "deny", note: reply?.error ? `the editor could not ask: ${reply.error.message ?? "error"}` : "the turn was cancelled", by: "acp" };
      if (isPlan) {
        if (picked !== "approve") return { decision: "deny", by: "user" };
        // Approved: the session leaves plan mode, as the window's composer does.
        if (s.mode === "plan") {
          s.mode = "workspace";
          update(sid, { sessionUpdate: "current_mode_update", currentModeId: s.mode });
        }
        return { decision: "allow", by: "user" };
      }
      if (picked === "always") s.always.add(key);
      if (picked === "never") s.never.add(key);
      return picked === "allow" || picked === "always" ? { decision: picked, by: "user" } : { decision: "deny", by: "user" };
    };

    // The hooks are how a turn sees a tool start, and how a cancel reaches the loop
    // between steps without the run store. Delegated workers inherit them (agent.mjs
    // spreads its options into the child), which is why `depth` is read from the info.
    const hooks = [
      {
        plugin: "acp",
        name: "beforeStep",
        fn: () => (ac.signal.aborted ? { stop: "the editor cancelled the turn" } : null),
      },
      {
        plugin: "acp",
        name: "beforeTool",
        fn: (info) => {
          if (ac.signal.aborted) return { deny: "the editor cancelled the turn" };
          const depth = Number(info?.depth) > 0 ? 1 : 0;
          if (info?.tool === "todo_write") return null;
          const c = current[depth];
          if (c && c.name === info?.tool && c.status === "pending") {
            c.status = "in_progress";
            update(sid, { sessionUpdate: "tool_call_update", toolCallId: c.id, status: "in_progress" });
          } else {
            openCall(depth, String(info?.tool ?? "?"), info?.args ?? {}, "in_progress");
          }
          return null;
        },
      },
    ];

    const baseFetch = defaults.fetchImpl ?? fetch;
    const fetchImpl = (url, init = {}) => {
      if (ac.signal.aborted) return Promise.reject(ac.signal.reason ?? new Error("cancelled"));
      const signal = init.signal ? AbortSignal.any([init.signal, ac.signal]) : ac.signal;
      return baseFetch(url, { ...init, signal });
    };

    const planning = s.mode === "plan";
    let result;
    try {
      result = await runAgentImpl({
        ...defaults,
        task,
        root: s.cwd,
        messages: s.messages,
        ...(images.length ? { images } : {}),
        accessMode: planning ? "workspace" : s.mode,
        planMode: planning,
        approve,
        onEvent,
        fetchImpl,
        extraHooks: [...(Array.isArray(defaults.extraHooks) ? defaults.extraHooks : []), ...hooks],
        ...(runId ? { runId } : {}),
      });
    } catch (err) {
      if (ac.signal.aborted) {
        flushAgentText();
        persist(s);
        return { stopReason: "cancelled" };
      }
      flushAgentText();
      throw new RpcError(ERR.INTERNAL, `the run failed: ${err?.message ?? err}`);
    } finally {
      s.turn = null;
    }

    if (Array.isArray(result?.messages)) s.messages = result.messages;
    const stopped = String(result?.stopped ?? "");
    if (ac.signal.aborted || stopped === "cancelled" || stopped === "killed" || stopped === "guard:acp") {
      flushAgentText();
      persist(s);
      return { stopReason: "cancelled" };
    }
    // A buffered (non-streaming) run sends no deltas: its answer goes out whole.
    if (!turn.streamed && result?.answer) say(String(result.answer));
    if (result?.error && !result?.answer) {
      flushAgentText();
      persist(s);
      throw new RpcError(ERR.INTERNAL, String(result.error), { stopped: result.stopped ?? null });
    }
    if (stopped === "max_steps") {
      flushAgentText();
      persist(s);
      return { stopReason: "max_turn_requests" };
    }
    // The other ways a run ends early (wall clock, cost cap, stall, a plugin's stop) have
    // no stop reason of their own in ACP; the reader still deserves to know.
    if (stopped) say(`\n\n_(Rosalena stopped: ${stopped}${result?.reason ? ` - ${result.reason}` : ""})_`);
    flushAgentText();
    persist(s);
    return { stopReason: "end_turn" };
  }

  const handlers = {
    // The client's fs/terminal capabilities are read and deliberately not used: see the
    // header - the engine's own tools do the file and shell work.
    initialize() {
      return {
        // We speak exactly one version; a client asking for another gets ours and decides.
        protocolVersion: ACP_PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: Boolean(sessionsDir),
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { close: {} },
        },
        agentInfo: { name: "rosalena", title: "Rosalena Harness", version: harnessVersion() },
        authMethods: [],
      };
    },
    authenticate() {
      return {};
    },
    "session/new"(params) {
      const cwd = absoluteCwd(params?.cwd);
      noteMcp(params?.mcpServers);
      const s = newSession(`sess_${randomUUID()}`, cwd);
      persist(s);
      return { sessionId: s.id, modes: modeState(s) };
    },
    "session/load"(params) {
      if (!sessionsDir) throw new RpcError(ERR.METHOD_NOT_FOUND, "session/load is not enabled (the agent was started without a sessions directory)");
      const id = String(params?.sessionId ?? "");
      const cwd = absoluteCwd(params?.cwd);
      noteMcp(params?.mcpServers);
      let s = sessions.get(id);
      if (!s) {
        const file = sessionFile(id);
        if (!existsSync(file)) throw new RpcError(ERR.NOT_FOUND, `no such session: ${id}`);
        let saved;
        try {
          saved = JSON.parse(readFileSync(file, "utf8"));
        } catch (err) {
          throw new RpcError(ERR.INTERNAL, `session ${id} could not be read: ${err?.message ?? err}`);
        }
        s = newSession(id, cwd, saved);
      }
      s.cwd = cwd;
      // The whole conversation goes out before the response, as the spec requires.
      let n = 0;
      for (const t of s.transcript) {
        if (t.role === "user") update(id, { sessionUpdate: "user_message_chunk", content: { type: "text", text: String(t.text ?? "") } });
        else if (t.role === "agent") update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(t.text ?? "") } });
        else if (t.role === "tool") update(id, { sessionUpdate: "tool_call", toolCallId: `${id}:replay-${++n}`, title: String(t.title ?? "tool"), kind: t.kind ?? "other", status: t.status ?? "completed" });
      }
      return { modes: modeState(s) };
    },
    "session/prompt"(params) {
      return runTurn(getSession(params?.sessionId), params);
    },
    "session/set_mode"(params) {
      const s = getSession(params?.sessionId);
      if (!MODE_IDS.has(params?.modeId)) throw new RpcError(ERR.INVALID_PARAMS, `unknown mode: ${params?.modeId} (one of ${[...MODE_IDS].join(", ")})`);
      // Takes effect from the next prompt: a run's access mode is fixed when it starts.
      s.mode = params.modeId;
      persist(s);
      return {};
    },
    "session/close"(params) {
      const s = getSession(params?.sessionId);
      cancelTurn(s);
      sessions.delete(s.id);
      return {};
    },
  };

  const notifications = {
    "session/cancel"(params) {
      const s = sessions.get(params?.sessionId);
      if (s) cancelTurn(s);
      else log(`cancel for unknown session ${params?.sessionId}`);
    },
  };

  const handle = (msg) => {
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
      send({ id: msg?.id ?? null, error: { code: ERR.INVALID_REQUEST, message: "not a JSON-RPC 2.0 message" } });
      return;
    }
    // A response to one of our requests (session/request_permission).
    if (msg.method === undefined && msg.id !== undefined) {
      const w = waiting.get(msg.id);
      if (w) {
        waiting.delete(msg.id);
        w.resolve(msg);
      }
      return;
    }
    const isNotification = msg.id === undefined;
    if (isNotification) {
      const fn = notifications[msg.method];
      // Unknown notifications ($/cancel_request, _vendor/...) are ignored, as JSON-RPC says.
      if (fn) {
        try {
          fn(msg.params);
        } catch (err) {
          log(`${msg.method} failed: ${err?.message ?? err}`);
        }
      }
      return;
    }
    const fn = handlers[msg.method];
    if (!fn) {
      send({ id: msg.id, error: { code: ERR.METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } });
      return;
    }
    // Not awaited here: a prompt runs for minutes, and the cancel for it arrives on the
    // same stream behind it.
    const p = Promise.resolve()
      .then(() => fn(msg.params ?? {}))
      .then(
        (result) => send({ id: msg.id, result: result ?? {} }),
        (err) => {
          const code = err instanceof RpcError ? err.code : ERR.INTERNAL;
          if (!(err instanceof RpcError)) log(`${msg.method} threw: ${err?.stack ?? err}`);
          send({ id: msg.id, error: { code, message: String(err?.message ?? err), ...(err?.data !== undefined ? { data: err.data } : {}) } });
        },
      )
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  return new Promise((resolveDone) => {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        send({ id: null, error: { code: ERR.PARSE, message: `parse error: ${err.message}` } });
        return;
      }
      handle(msg);
    });
    rl.on("close", async () => {
      // The editor hung up: nobody is left to read a running turn's output.
      for (const s of sessions.values()) cancelTurn(s);
      for (const [id, w] of waiting) {
        waiting.delete(id);
        w.resolve({ result: { outcome: { outcome: "cancelled" } } });
      }
      while (inflight.size) await Promise.allSettled([...inflight]);
      restoreConsole();
      resolveDone();
    });
  });
}

/** Point console.log/info/debug at stderr; returns the undo. */
function routeConsoleToStderr() {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  const toErr = (...args) => console.error(...args);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
  return () => Object.assign(console, saved);
}
