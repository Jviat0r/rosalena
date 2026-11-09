/**
 * Reading the other harnesses' sessions.
 *
 * This is the half of interop that faces the OTHER tools' stores, so the tests are
 * written against the properties that matter when you do not control the files:
 *
 *   - a source that is missing, empty or broken produces a note, never a throw
 *   - the list is cheap: a title comes from the head of the log, not the transcript
 *   - a DSH log is a CHAIN of zstd frames, so a single-frame reader reports one row
 *   - opencode is a SQLite database in two shapes, and both are read
 *
 * Every root is redirected through ROSALENA_* env vars, so nothing here touches the
 * real machine and the fixtures are the only input.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";

import { SOURCES, listExternalSessions, readExternalSession, roots, sessionCounts } from "../src/sessions.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-sessions-"));
const CLAUDE = join(WS, "claude");
const CODEX = join(WS, "codex");
const DSH = join(WS, "dsh");

// ---------------------------------------------------------------- fixtures

const write = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

const user = (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

mkdirSync(join(CLAUDE, "proj-a"), { recursive: true });
// 1. the normal shape: a title row first, then the transcript
write(
  join(CLAUDE, "proj-a", "s-titled.jsonl"),
  jsonl({ type: "custom-title", customTitle: "Tessaly build" }, user("fix the domain"), assistant("done")),
);
// 2. no custom title, an ai-title later in the head
write(
  join(CLAUDE, "proj-a", "s-ai.jsonl"),
  jsonl(user("plan the audit"), { type: "ai-title", aiTitle: "Practice audit" }, assistant("ok")),
);
// 3. neither: the opening line is the only label available
write(join(CLAUDE, "proj-a", "s-first.jsonl"), jsonl(user("make a bat file to start this game"), assistant("ok")));
// 4. an empty shell - Claude Code writes one the moment a project opens
write(join(CLAUDE, "proj-a", "s-shell.jsonl"), jsonl({ type: "mode", mode: "default" }));
// 5. a transcript whose opening line is the harness's own injected notice
write(
  join(CLAUDE, "proj-a", "s-noise.jsonl"),
  jsonl(user("<system-reminder> The user started this session without choosing a project"), assistant("ok")),
);

mkdirSync(CODEX, { recursive: true });

const dshDir = join(DSH, "--D-AppDev-Ai~0020Ecosystem--", "session-abc");
mkdirSync(dshDir, { recursive: true });
/** One DSH write is one independent zstd frame appended to the file. */
const dshFile = (rows, { torn = false } = {}) => {
  const frames = rows.map((chunk) => zstdCompressSync(Buffer.from(jsonl(...chunk), "utf8")));
  if (torn) frames.push(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02])); // magic, then junk
  return Buffer.concat(frames);
};
writeFileSync(
  join(dshDir, "session.v4.jsonl.zstd"),
  dshFile(
    [
      [{ type: "session/header", data: { v: 4 } }, { type: "session/title", data: { title: "Rosalena roadmap" } }],
      [{ type: "user/message", data: { message: { role: "user", content: "build the router" } }, time: 1 }],
      [
        { type: "assistant/message", data: { message: { role: "assistant", content: "on it" } }, time: 2 },
        { type: "model/selection", data: { model: { id: "local/qwen3.8-27b" } } },
      ],
    ],
    { torn: true },
  ),
);

const makeV1Db = (path) => {
  const db = new DatabaseSync(path);
  db.exec(`
    create table session (id text primary key, title text, directory text, time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, data text, time_created integer);
    create table part (id text primary key, message_id text, data text, time_created integer);
  `);
  db.prepare("insert into session values (?,?,?,?,?)").run("ses_v1", "Datamax intake", "/work/datamax", 10, 20);
  db.prepare("insert into message values (?,?,?,?)").run("m1", "ses_v1", JSON.stringify({ role: "user" }), 11);
  db.prepare("insert into part values (?,?,?,?)").run("p1", "m1", JSON.stringify({ type: "text", text: "hello there" }), 11);
  db.prepare("insert into message values (?,?,?,?)").run("m2", "ses_v1", JSON.stringify({ role: "assistant" }), 12);
  db.prepare("insert into part values (?,?,?,?)").run("p2", "m2", JSON.stringify({ type: "text", text: "general kenobi" }), 12);
  db.close();
};
const makeV2Db = (path) => {
  const db = new DatabaseSync(path);
  // The v2 shape has neither `session` nor `message`/`part`: every query written for
  // v1 throws "no such table" here, which is exactly the case that used to read as
  // "this store is empty".
  db.exec(`
    create table session_v2 (id text primary key, title text, directory text, time_created integer, time_updated integer);
    create table session_message (id text primary key, session_id text, type text, data text, time_created integer);
  `);
  db.prepare("insert into session_v2 values (?,?,?,?,?)").run("ses_v2", "VoiceOS dials", "/work/voiceos", 30, 40);
  db.prepare("insert into session_message values (?,?,?,?,?)").run("n1", "ses_v2", "user", JSON.stringify({ content: "put the dials live" }), 31);
  db.prepare("insert into session_message values (?,?,?,?,?)").run("n2", "ses_v2", "assistant", JSON.stringify({ content: "gated on consent" }), 32);
  db.close();
};
const V1 = join(WS, "v1.db");
const V2 = join(WS, "v2.db");
makeV1Db(V1);
makeV2Db(V2);

const pointAt = ({ claude = CLAUDE, codex = CODEX, opencode = V1, dsh = DSH } = {}) => {
  process.env.ROSALENA_CLAUDE_DIR = claude;
  process.env.ROSALENA_CODEX_DIR = codex;
  process.env.ROSALENA_OPENCODE_DB = opencode;
  process.env.ROSALENA_DSH_DIR = dsh;
};
pointAt();

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// ---------------------------------------------------------------- claude

test("claude: a title row wins, then ai-title, then the opening line", async () => {
  const { sessions } = await listExternalSessions({ sources: ["claude"], max: 50 });
  const s = byId(sessions);
  assert.equal(s["s-titled"].title, "Tessaly build");
  assert.equal(s["s-ai"].title, "Practice audit");
  assert.equal(s["s-first"].title, "make a bat file to start this game");
});

test("claude: a session file with nothing in it never reaches the list", async () => {
  const { sessions } = await listExternalSessions({ sources: ["claude"], max: 50 });
  assert.equal(sessions.find((s) => s.id === "s-shell"), undefined);
  assert.equal(sessions.length, 4);
});

test("claude: an injected harness notice is not used as a title", async () => {
  const { sessions } = await listExternalSessions({ sources: ["claude"], max: 50 });
  const noise = sessions.find((s) => s.id === "s-noise");
  // The id is ugly, but it is honest: better than showing a prompt-injection banner
  // as the name of the conversation.
  assert.equal(noise.title, "s-noise");
});

test("claude: reading one session returns the transcript, not the title rows", async () => {
  const one = await readExternalSession({ source: "claude", id: "s-titled" });
  assert.equal(one.meta.title, "Tessaly build");
  assert.deepEqual(
    one.messages.map((m) => [m.role, m.text]),
    [
      ["user", "fix the domain"],
      ["assistant", "done"],
    ],
  );
  assert.equal(one.truncated, false);
});

test("claude: an unknown id is null, not an exception", async () => {
  assert.equal(await readExternalSession({ source: "claude", id: "nope" }), null);
  assert.equal(await readExternalSession({ source: "claude", id: "" }), null);
  assert.equal(await readExternalSession({ source: "not-a-source", id: "x" }), null);
});

// ---------------------------------------------------------------- codex

test("codex: an empty root reports no sessions, a missing root reports not installed", async () => {
  const empty = await listExternalSessions({ sources: ["codex"] });
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.notes.length, 1);
  assert.match(empty.notes[0].note, /no sessions found/);

  pointAt({ codex: join(WS, "does-not-exist") });
  const missing = await listExternalSessions({ sources: ["codex"] });
  assert.match(missing.notes[0].note, /not installed/);
  pointAt();
});

test("codex: a rollout log is found and its two message shapes are both read", async () => {
  const dir = join(CODEX, "2026", "10", "19");
  mkdirSync(dir, { recursive: true });
  write(
    join(dir, "rollout-2026-10-19T10-00-00-abc.jsonl"),
    jsonl(
      { type: "session_meta", payload: { id: "abc" } },
      { type: "event_msg", payload: { type: "user_message", message: "ship it" }, timestamp: "t1" },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "shipped" }] }, timestamp: "t2" },
    ),
  );
  const { sessions } = await listExternalSessions({ sources: ["codex"] });
  assert.equal(sessions.length, 1);
  const one = await readExternalSession({ source: "codex", id: "rollout-2026-10-19T10-00-00-abc" });
  assert.deepEqual(
    one.messages.map((m) => [m.role, m.text]),
    [
      ["user", "ship it"],
      ["assistant", "shipped"],
    ],
  );
  assert.equal(one.meta.title, "ship it");
});

// ---------------------------------------------------------------- dsh

test("dsh: the log is a frame chain, so every frame is decoded", async () => {
  const one = await readExternalSession({ source: "dsh", id: "session-abc" });
  // A reader that decompressed from the file start would see only frame 0: the
  // header and the title, zero messages.
  assert.equal(one.messages.length, 2);
  assert.equal(one.meta.title, "Rosalena roadmap");
  assert.equal(one.meta.model, "local/qwen3.8-27b");
  assert.deepEqual(one.messages.map((m) => m.role), ["user", "assistant"]);
});

test("dsh: a torn trailing frame costs nothing that was already written", async () => {
  // The fixture's last frame is 7 bytes of junk behind a valid magic.
  const one = await readExternalSession({ source: "dsh", id: "session-abc" });
  assert.equal(one.messages.at(-1).text, "on it");
});

test("dsh: the sidebar label is the decoded project path, without opening the log", async () => {
  const { sessions } = await listExternalSessions({ sources: ["dsh"] });
  // --D-AppDev-Ai~0020Ecosystem--  ->  D:\AppDev\Ai Ecosystem
  const bs = String.fromCharCode(92);
  assert.equal(sessions[0].title, ["D", "AppDev", "Ai Ecosystem"].join(bs));
});

// ---------------------------------------------------------------- opencode

test("opencode v1: sessions list from the db and parts are joined back to messages", async () => {
  const { sessions } = await listExternalSessions({ sources: ["opencode"] });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "Datamax intake");
  assert.equal(sessions[0].project, "/work/datamax");

  const one = await readExternalSession({ source: "opencode", id: "ses_v1" });
  assert.deepEqual(
    one.messages.map((m) => [m.role, m.text]),
    [
      ["user", "hello there"],
      ["assistant", "general kenobi"],
    ],
  );
});

test("opencode v2: session_message rows are read when the v1 tables have nothing", async () => {
  pointAt({ opencode: V2 });
  const one = await readExternalSession({ source: "opencode", id: "ses_v2" });
  assert.deepEqual(
    one.messages.map((m) => [m.role, m.text]),
    [
      ["user", "put the dials live"],
      ["assistant", "gated on consent"],
    ],
  );
  assert.equal(one.meta.title, "VoiceOS dials");
  pointAt();
});

test("opencode: a db that is not there and a db that is not sqlite both yield nothing", async () => {
  pointAt({ opencode: join(WS, "nope.db") });
  assert.deepEqual((await listExternalSessions({ sources: ["opencode"] })).sessions, []);
  pointAt({ opencode: CLAUDE }); // a directory, not a database
  assert.deepEqual((await listExternalSessions({ sources: ["opencode"] })).sessions, []);
  pointAt();
});

// ---------------------------------------------------------------- facade

test("every source is counted, and counts never throw", async () => {
  const counts = await sessionCounts({ max: 200 });
  assert.deepEqual(Object.keys(counts).sort(), ["claude", "codex", "dsh", "opencode"]);
  assert.equal(counts.claude, 4);
  assert.equal(counts.opencode, 1);
  assert.equal(counts.dsh, 1);
});

test("a machine with no external harness installed still answers", async () => {
  pointAt({ claude: join(WS, "x1"), codex: join(WS, "x2"), opencode: join(WS, "x3"), dsh: join(WS, "x4") });
  const all = await listExternalSessions();
  assert.deepEqual(all.sessions, []);
  assert.equal(all.notes.length, 4);
  assert.deepEqual(Object.keys(all).sort(), ["notes", "roots", "sessions"]);
  pointAt();
});

test("roots() reports where each adapter looks, with the env override applied", () => {
  const r = roots();
  assert.deepEqual(r, { claude: CLAUDE, codex: CODEX, opencode: V1, dsh: DSH });
  assert.deepEqual(SOURCES, ["rosalena", "claude", "codex", "opencode", "dsh"]);
});

test("rosalena is listed as a source but has no adapter: it is the run store", async () => {
  const { sessions, notes } = await listExternalSessions({ sources: ["rosalena"] });
  assert.deepEqual(sessions, []);
  assert.deepEqual(notes, []);
});
