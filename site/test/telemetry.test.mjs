/**
 * POST /api/telemetry against a real SQLite database built from the real migrations, so
 * the SQL itself is tested, not a double that agrees with whatever the code expects.
 *
 *   node --test test/telemetry.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DAILY_EVENT_CAP, MAX_EVENTS, handleTelemetry } from "../functions/api/_lib/telemetry.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}
const skip = sqlite ? false : "node:sqlite is not available in this Node";

/** The D1 surface the endpoint uses (prepare/bind/first/all/run, batch), over node:sqlite. */
function d1() {
  const db = new sqlite.DatabaseSync(":memory:");
  for (const file of readdirSync(join(SITE, "migrations")).sort()) db.exec(readFileSync(join(SITE, "migrations", file), "utf8"));
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => db.prepare(s.sql).run(...s.args));
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const post = (body, headers = {}) =>
  new Request("https://rosalena.pages.dev/api/telemetry", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const install = { id: ID, version: "0.1.2", platform: "win32", arch: "x64", os: "10.0.19045" };

test("a session and a run land as rows, and the install's totals add up", { skip }, async () => {
  const env = { TRIAL_DB: d1() };
  const now = Date.parse("2026-10-22T20:00:00Z");
  const events = [
    { kind: "session", at: "2026-10-22T19:59:00Z" },
    {
      kind: "run", at: "2026-10-22T19:59:30Z", run: "r-1", model: "rosalena", status: "failed", stopped: "router_error", steps: 3, ms: 9000,
      tokensIn: 1200, tokensOut: 300, calls: 3, toolCalls: 2, targets: ["opencode-free/deepseek-v4.1-flash-free"], cloud: true,
      error: "upstream reset", prompt: "fix the build", answer: "",
    },
  ];
  const result = await handleTelemetry({ request: post({ v: 1, install, events }), env, now });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { ok: true, stored: 2 });
  const row = env.TRIAL_DB.raw.prepare("SELECT * FROM tel_install").get();
  assert.equal(row.id, ID);
  assert.equal(row.sessions, 1);
  assert.equal(row.runs, 1);
  assert.equal(row.failed_runs, 1);
  assert.equal(row.tokens_in, 1200);
  assert.equal(row.version, "0.1.2");
  const run = env.TRIAL_DB.raw.prepare("SELECT * FROM tel_event WHERE kind = 'run'").get();
  assert.equal(run.prompt, "fix the build");
  assert.equal(run.error, "upstream reset");
  assert.equal(run.day, "2026-10-22");
  assert.equal(JSON.parse(run.targets)[0], "opencode-free/deepseek-v4.1-flash-free");

  // A second batch adds to the totals instead of replacing them.
  await handleTelemetry({ request: post({ v: 1, install, events: [{ kind: "run", status: "ok", tokensIn: 100, tokensOut: 10 }] }), env, now });
  const again = env.TRIAL_DB.raw.prepare("SELECT runs, failed_runs, tokens_in FROM tel_install").get();
  assert.deepEqual({ ...again }, { runs: 2, failed_runs: 1, tokens_in: 1300 });
});

test("words are dropped from a run that is not on a cloud model", { skip }, async () => {
  const env = { TRIAL_DB: d1() };
  await handleTelemetry({ request: post({ v: 1, install, events: [{ kind: "run", status: "ok", cloud: false, prompt: "my private task", answer: "local answer" }] }), env });
  const run = env.TRIAL_DB.raw.prepare("SELECT prompt, answer FROM tel_event").get();
  assert.equal(run.prompt, null);
  assert.equal(run.answer, null);
});

test("a bad-answer report counts on the install and keeps the tester's note", { skip }, async () => {
  const env = { TRIAL_DB: d1() };
  await handleTelemetry({ request: post({ v: 1, install, events: [{ kind: "feedback", rating: "bad", note: "it looped", run: "r-9", cloud: true, prompt: "q", answer: "a" }] }), env });
  const row = env.TRIAL_DB.raw.prepare("SELECT status, note FROM tel_event").get();
  assert.deepEqual({ ...row }, { status: "bad", note: "it looped" });
  assert.equal(env.TRIAL_DB.raw.prepare("SELECT reports FROM tel_install").get().reports, 1);
});

test("a cloud model call (the message log) is stored with its step and tools, and adds no run", { skip }, async () => {
  const env = { TRIAL_DB: d1() };
  const event = { kind: "call", run: "r-3", step: 4, model: "rosalena", targets: ["opencode-free/glm-5.3-flash-free"], status: "ok", tokensIn: 50, tokensOut: 7, toolCalls: 1, toolNames: ["edit_file"], cloud: true, prompt: "rename it", answer: "" };
  await handleTelemetry({ request: post({ v: 1, install, events: [event] }), env });
  const row = env.TRIAL_DB.raw.prepare("SELECT kind, run, prompt, tool_calls, data FROM tel_event").get();
  assert.equal(row.kind, "call");
  assert.equal(row.prompt, "rename it");
  assert.equal(row.tool_calls, 1);
  assert.deepEqual(JSON.parse(row.data), { step: 4, toolNames: ["edit_file"] });
  assert.equal(env.TRIAL_DB.raw.prepare("SELECT runs, tokens_in FROM tel_install").get().runs, 0, "a call is not a run");
});

test("a model error is stored with attempt and reason, and never with words", { skip }, async () => {
  const env = { TRIAL_DB: d1() };
  const event = { kind: "model_error", run: "r-4", step: 2, attempt: 1, model: "local/qwen", targets: ["local/qwen3.8-27b"], status: "failed", reason: "call_failed", error: "out of memory", cloud: false, prompt: "should not land" };
  await handleTelemetry({ request: post({ v: 1, install, events: [event] }), env });
  const row = env.TRIAL_DB.raw.prepare("SELECT kind, status, error, prompt, data FROM tel_event").get();
  assert.deepEqual({ kind: row.kind, status: row.status, error: row.error, prompt: row.prompt }, { kind: "model_error", status: "failed", error: "out of memory", prompt: null });
  assert.deepEqual(JSON.parse(row.data), { step: 2, attempt: 1, reason: "call_failed" });
});

test("shape and size are enforced before anything is written", { skip }, async () => {
  const env = { TRIAL_DB: d1() };
  const status = async (request) => (await handleTelemetry({ request, env })).status;
  assert.equal(await status(post({ v: 1, install: { id: "not-a-uuid" }, events: [{ kind: "session" }] })), 400);
  assert.equal(await status(post({ v: 1, install, events: [] })), 400);
  assert.equal(await status(post({ v: 1, install, events: [{ kind: "nonsense" }] })), 400);
  assert.equal(await status(post({ v: 1, install, events: Array.from({ length: MAX_EVENTS + 1 }, () => ({ kind: "session" })) })), 413);
  assert.equal(await status(post("{not json")), 400);
  assert.equal(await status(post({ v: 1, install, events: [{ kind: "session" }] }, { origin: "https://evil.example" })), 403);
  assert.equal(await status(new Request("https://rosalena.pages.dev/api/telemetry")), 405);
  assert.equal(env.TRIAL_DB.raw.prepare("SELECT COUNT(*) AS n FROM tel_event").get().n, 0);
});

test("one install cannot pass the daily cap; the switch turns the endpoint off", { skip }, async () => {
  const env = { TRIAL_DB: d1() };
  const now = Date.parse("2026-10-22T12:00:00Z");
  const insert = env.TRIAL_DB.raw.prepare("INSERT INTO tel_event (id, install, day, stamp, kind) VALUES (?, ?, '2026-10-22', ?, 'session')");
  for (let i = 0; i < DAILY_EVENT_CAP; i += 1) insert.run(`e${i}`, ID, now);
  const capped = await handleTelemetry({ request: post({ v: 1, install, events: [{ kind: "session" }] }), env, now });
  assert.equal(capped.status, 429);
  const off = await handleTelemetry({ request: post({ v: 1, install, events: [{ kind: "session" }] }), env: { ...env, TELEMETRY: "off" }, now });
  assert.equal(off.status, 204);
});
