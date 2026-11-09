/**
 * Run store tests.
 *
 * The store exists so that a task started by ONE process can be inspected by
 * ANOTHER — which is what the interop contract promises. So the tests care about the
 * properties that make that true, not about the file format for its own sake:
 *
 *   - the log is readable WHILE the run is still going (a poller has to see progress)
 *   - the caller can choose the id, because it must know it before the run ends
 *   - a torn line, a missing record or an unwritable directory never breaks a run
 *   - a sub-agent is a separate run with a parent link, not merged into its parent
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runAgent } from "../src/agent.mjs";
import { listRuns, newRunId, openRun, readRun, requestCancel, resolveRunId, runStatus, runsDir } from "../src/runs.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-runs-"));
const DIR = () => mkdtempSync(join(WS, "runs-"));
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const say = (content) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const useTool = (name, args, id = "call_1") => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {},
});

function scripted(script) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const entry = script[Math.min(calls.length - 1, script.length - 1)];
    const payload = typeof entry === "function" ? await entry(body, calls) : entry;
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/test-model" },
    });
  };
  fn.calls = calls;
  return fn;
}

test("a run id is sortable, readable and unique even in one millisecond", () => {
  const at = new Date(2026, 9, 19, 18, 5, 7);
  assert.equal(newRunId(at, () => 0.5), "r-20261019-180507-8001");
  const ids = new Set();
  for (let i = 0; i < 500; i += 1) ids.add(newRunId(at, () => 0.5));
  assert.equal(ids.size, 500, "the same clock and the same random draw must still give distinct ids");
});

test("runsDir: explicit beats ROSALENA_RUNS beats the default, read per call", () => {
  const before = process.env.ROSALENA_RUNS;
  const context = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.ROSALENA_RUNS;
    // Inside the test runner the default is a throwaway folder (see the next test), so the
    // real default is checked with the runner's marker switched off.
    delete process.env.NODE_TEST_CONTEXT;
    const fallback = runsDir();
    assert.match(fallback, /runs$/, "the default is <ROSALENA_HOME>/runs");
    assert.equal(runsDir("X:/explicit"), "X:/explicit");
    process.env.ROSALENA_RUNS = "X:/from-env";
    assert.equal(runsDir(), "X:/from-env", "the env override is read at call time, not at import");
    assert.equal(runsDir("X:/explicit"), "X:/explicit");
  } finally {
    if (before === undefined) delete process.env.ROSALENA_RUNS;
    else process.env.ROSALENA_RUNS = before;
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = context;
  }
});

// 2026-11-06: a plain `node --test`, run from inside the app, wrote 212 fake chats into the
// app's own Recent list. Under the test runner the default store is a temp folder.
test("runsDir: inside the test runner, with no override, runs never go to the real store", () => {
  const before = process.env.ROSALENA_RUNS;
  const context = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.ROSALENA_RUNS;
    process.env.NODE_TEST_CONTEXT = "child";
    const dir = runsDir();
    assert.ok(dir.toLowerCase().startsWith(tmpdir().toLowerCase()), `a temp folder, not ${dir}`);
    assert.equal(runsDir(), dir, "one folder per test process");
  } finally {
    if (before === undefined) delete process.env.ROSALENA_RUNS;
    else process.env.ROSALENA_RUNS = before;
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = context;
  }
});

test("the event log exists and is complete BEFORE the run finishes", async () => {
  const dir = DIR();
  const run = openRun({ dir, id: "r-20261019-180000-aaaa", meta: { task: "half a run" } });
  run.event({ type: "step_start", step: 1 });
  run.event({ type: "tool", step: 1, name: "read_file", ok: true });

  const live = join(dir, "r-20261019-180000-aaaa.jsonl");
  assert.ok(existsSync(live), "the log is on disk while the run is still going");
  const lines = readFileSync(live, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["step_start", "tool"]);
  assert.ok(lines[0].at, "every event carries a timestamp");

  const status = runStatus({ dir, id: "r-20261019-180000-aaaa" });
  assert.equal(status.status, "running");
  assert.equal(status.running, true);
  assert.equal(status.answer, null, "a running run has no answer to report yet");
  assert.equal(status.tools, 1);
  assert.equal(status.lastTool, "read_file");
});

test("finish writes the record and one index line, and cannot write twice", () => {
  const dir = DIR();
  const run = openRun({ dir, id: "r-20261019-180001-bbbb", meta: { task: "finish me", root: WS, cls: "code" } });
  run.event({ type: "run_end", run: "r-20261019-180001-bbbb", steps: 2 });
  const record = run.finish({ answer: "done", steps: 2, ms: 1234, target: "local/qwen3.8-27b" });
  assert.equal(record.status, "ok");
  assert.equal(record.ok, true);
  assert.equal(record.model, "local/qwen3.8-27b");
  assert.equal(record.events, 1);

  const stored = JSON.parse(readFileSync(join(dir, "r-20261019-180001-bbbb.json"), "utf8"));
  assert.equal(stored.answer, "done");
  assert.equal(stored.task, "finish me");
  run.finish({ answer: "a second exit" });
  const index = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n");
  assert.equal(index.length, 1, "one run, one index line - even if finish is reached twice");
  assert.equal(JSON.parse(index[0]).id, "r-20261019-180001-bbbb");
});

test("an errored or stopped run is recorded as such, not as ok", () => {
  const dir = DIR();
  openRun({ dir, id: "r-20261019-180002-cccc" }).finish({ error: "router said no", steps: 1 });
  openRun({ dir, id: "r-20261019-180003-dddd" }).finish({ stopped: "stalled", steps: 4 });
  const runs = listRuns({ dir });
  const byId = new Map(runs.map((r) => [r.id, r]));
  assert.equal(byId.get("r-20261019-180002-cccc").status, "failed");
  assert.equal(byId.get("r-20261019-180002-cccc").ok, false);
  assert.equal(byId.get("r-20261019-180003-dddd").status, "stopped");
});

test("listRuns is newest first, filters by status, and still shows a live run", () => {
  const dir = DIR();
  openRun({ dir, id: "r-20261019-180010-live" }).event({ type: "tool", step: 1, name: "search" });
  openRun({ dir, id: "r-20261019-180011-done1" }).finish({ answer: "a", steps: 1 });
  openRun({ dir, id: "r-20261019-180011-done2" }).finish({ answer: "b", steps: 3 });

  const all = listRuns({ dir });
  assert.equal(all.length, 3, "a run with a log but no record is listed as running");
  assert.equal(all.filter((r) => r.status === "running").length, 1);
  assert.deepEqual(listRuns({ dir, status: "ok" }).map((r) => r.id).sort(), ["r-20261019-180011-done1", "r-20261019-180011-done2"]);
  assert.equal(listRuns({ dir, limit: 1 }).length, 1);
  assert.deepEqual(listRuns({ dir: join(WS, "does-not-exist") }), []);
});

test("readRun resolves a unique prefix, refuses an ambiguous one, and knows nothing of a stranger", () => {
  const dir = DIR();
  const first = openRun({ dir, id: "r-20261019-180020-aaaa" });
  first.event({ type: "tool", step: 1, name: "read_file" });
  first.finish({ answer: "one", steps: 1 });
  openRun({ dir, id: "r-20261019-180020-bbbb" }).finish({ answer: "two", steps: 2 });

  const full = readRun({ dir, id: "r-20261019-180020-aaaa" });
  assert.equal(full.record.answer, "one");
  assert.equal(full.events.length, 1, "the record's own events come back with it");
  assert.equal(readRun({ dir, id: "r-20261019-180020-b" }).record.answer, "two", "a unique prefix is enough to type");
  assert.throws(() => resolveRunId({ dir, id: "r-20261019-180020" }), /ambiguous/);
  assert.equal(readRun({ dir, id: "r-19990101-000000-nope" }), null);
});

test("a torn last line and a corrupt record are survived, not fatal", () => {
  const dir = DIR();
  const run = openRun({ dir, id: "r-20261019-180030-torn" });
  run.event({ type: "step_start", step: 1 });
  // A process killed mid-append leaves exactly this.
  writeFileSync(join(dir, "r-20261019-180030-torn.jsonl"), `${readFileSync(join(dir, "r-20261019-180030-torn.jsonl"), "utf8")}{"type":"tool","st`, "utf8");
  const status = runStatus({ dir, id: "r-20261019-180030-torn" });
  assert.equal(status.status, "running");
  assert.equal(status.events, 1, "the good lines are still readable");

  writeFileSync(join(dir, "r-20261019-180031-broken.json"), "{ not json", "utf8");
  const found = readRun({ dir, id: "r-20261019-180031-broken" });
  assert.ok(found, "the id still resolves");
  assert.equal(found.record.status, "running", "an unreadable record is treated as unfinished, not as a crash");
});

test("an unusable store directory reports itself instead of failing the run", () => {
  const file = join(WS, "not-a-dir");
  writeFileSync(file, "x", "utf8");
  const errors = [];
  const run = openRun({ dir: file, onError: (m) => errors.push(m) });
  assert.match(run.error, /cannot create/);
  assert.equal(errors.length, 1, "the reason is reported to the caller");
  run.event({ type: "tool" });
  const record = run.finish({ answer: "still answered", steps: 1 });
  assert.equal(record.answer, "still answered", "the run keeps its result even with nowhere to write it");
});

test("a real run records itself, and the caller can pick the id it will poll", async () => {
  const dir = DIR();
  const events = [];
  const f = scripted([useTool("read_file", { path: "hello.txt" }, "c1"), say("read it")]);
  const result = await runAgent({
    task: "read hello.txt",
    root: WS,
    runsDir: dir,
    runId: "r-20261019-180040-chosen",
    fetchImpl: f,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.run, "r-20261019-180040-chosen", "the id the caller chose is the id of the run");
  const record = JSON.parse(readFileSync(join(dir, "r-20261019-180040-chosen.json"), "utf8"));
  assert.equal(record.status, "ok");
  assert.equal(record.answer, "read it");
  assert.equal(record.steps, 2);
  assert.equal(record.task, "read hello.txt");
  assert.equal(record.model, "local/test-model");
  const stored = readFileSync(join(dir, "r-20261019-180040-chosen.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(stored.some((e) => e.type === "tool" && e.name === "read_file"), "tool calls are in the log");
  assert.ok(stored.some((e) => e.type === "run_end"), "the log ends with the run's own end event");
  assert.equal(readRun({ dir, id: result.run }).events.length, stored.length);
  assert.equal(result.runFile, join(dir, "r-20261019-180040-chosen.json"));
});

test("a subagent is its own run with a parent link, never merged into the parent", async () => {
  const dir = DIR();
  const f = scripted([useTool("delegate", { task: "count the words" }, "d1"), say("worker did it"), say("parent done")]);
  const result = await runAgent({
    task: "delegate the counting",
    root: WS,
    runsDir: dir,
    runId: "r-20261019-180050-parent",
    fetchImpl: f,
  });
  assert.equal(result.answer, "parent done");

  const runs = listRuns({ dir });
  assert.equal(runs.length, 2, "two runs, two records");
  const parent = runs.find((r) => r.id === "r-20261019-180050-parent");
  const child = runs.find((r) => r.id !== "r-20261019-180050-parent");
  assert.equal(parent.depth, 0);
  assert.equal(child.depth, 1);
  assert.equal(child.parent, "r-20261019-180050-parent", "the tree stays visible from the child's record");
  assert.match(child.task, /count the words/);

  const parentEvents = readRun({ dir, id: "r-20261019-180050-parent" }).events;
  assert.ok(parentEvents.some((e) => e.type === "tool" && e.name === "delegate"));
  assert.ok(parentEvents.some((e) => e.sub === true), "the child's events are visible in the parent's log, marked as sub");
});

test("runs: false writes nothing at all, for a caller that does not want a record", async () => {
  const dir = DIR();
  const f = scripted([say("quiet")]);
  const result = await runAgent({ task: "say nothing", root: WS, runs: false, runsDir: dir, fetchImpl: f });
  assert.equal(result.answer, "quiet");
  assert.equal(result.runFile, null);
  assert.deepEqual(listRuns({ dir }), []);
  assert.ok(result.run, "the run still has an internal id for hooks");
});

/**
 * "Running" is a claim about the world, and the store can only make it while the log is
 * still growing. A run whose process died leaves events and no record — reported as
 * `running` forever that would be a lie with no expiry, which is exactly what happened
 * to an orphan in `data\runs` before `ROSALENA_RUN_STALE_MS` existed.
 */
test("a log that stops growing is reported as stale, not as running forever", async () => {
  const dir = DIR();
  const handle = openRun({ dir, id: "r-20261019-190000-gone" });
  handle.event({ type: "run", task: "die quietly" });
  const previous = process.env.ROSALENA_RUN_STALE_MS;
  try {
    assert.equal(runStatus({ dir, id: handle.id }).status, "running", "a fresh log is a live run");

    process.env.ROSALENA_RUN_STALE_MS = "60";
    await new Promise((r) => setTimeout(r, 120));

    const status = runStatus({ dir, id: handle.id });
    assert.equal(status.status, "stale");
    assert.equal(status.running, false, "a poller must not wait on a dead process");
    assert.equal(status.stale, true);
    assert.ok(status.idleMs >= 60, "it says how long the log has been quiet");
    assert.equal(status.events, 1, "the events it did write are still readable");
    assert.equal(readRun({ dir, id: handle.id }).record.status, "stale");

    const listed = listRuns({ dir }).find((r) => r.id === handle.id);
    assert.equal(listed.status, "stale", "the list agrees with the single-run view");
  } finally {
    if (previous === undefined) delete process.env.ROSALENA_RUN_STALE_MS;
    else process.env.ROSALENA_RUN_STALE_MS = previous;
  }
});

/**
 * The other half of the same problem: closing the record at the moment the process ends,
 * so a killed run is not merely detectable but resolved. A child process starts a run
 * whose model never answers and exits without the agent's `finish`.
 */
test("a process that ends mid-run leaves a closed record, not a claim that it is running", async () => {
  const dir = DIR();
  const id = "r-20261019-190100-cut";
  const child = spawn(process.execPath, [join(FIXTURES, "interrupted-run.mjs"), dir, id], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  // Wait for the run to exist before the child is allowed to die, so this tests the
  // interruption rather than a process that never got as far as writing anything.
  for (let i = 0; i < 200 && !existsSync(join(dir, `${id}.json`)); i += 1) await new Promise((r) => setTimeout(r, 25));
  await exited;

  const record = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
  assert.equal(record.status, "failed");
  assert.equal(record.stopped, "killed");
  assert.match(record.error, /ended before the run finished/);
  assert.equal(record.ok, false);
  assert.ok(record.events >= 1, "the record counts the events the run did write");

  const status = runStatus({ dir, id });
  assert.equal(status.running, false, "a poller sees it settle instead of waiting out the staleness window");
  assert.equal(status.status, "failed");
});

test("a finished run does not leave an exit handler behind in a long-lived host", async () => {
  const dir = DIR();
  const before = process.listenerCount("exit");
  const f = scripted([say("done")]);
  await runAgent({ task: "say done", root: WS, runsDir: dir, fetchImpl: f });
  await runAgent({ task: "say done again", root: WS, runsDir: dir, fetchImpl: scripted([say("done")]) });
  assert.equal(process.listenerCount("exit"), before, "the UI server runs many runs in one process");
});

/**
 * Cancellation across processes: the canceller is never the run's owner (the UI starts a
 * run, a shell cancels it; a parent harness starts one, its client cancels it), so the
 * only channel that works is the shared store. A file is a request, not a kill: the run
 * stops itself at a step boundary and records why.
 */
test("another process can cancel a live run, and the run records that it was cancelled", async () => {
  const dir = DIR();
  const id = "r-20261019-190200-cancelled";
  const child = spawn(process.execPath, [join(FIXTURES, "cancellable-run.mjs"), dir, id], { stdio: ["ignore", "pipe", "ignore"] });
  let printed = "";
  child.stdout.on("data", (chunk) => { printed += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));

  // Wait until the run is genuinely stepping (two events: run + one assistant), so this
  // tests a live cancellation rather than a flag planted before the run began.
  for (let i = 0; i < 400 && !existsSync(join(dir, `${id}.jsonl`)); i += 1) await new Promise((r) => setTimeout(r, 25));
  for (let i = 0; i < 400; i += 1) {
    const lines = readFileSync(join(dir, `${id}.jsonl`), "utf8").trim().split("\n").filter(Boolean);
    if (lines.length >= 3) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(runStatus({ dir, id }).running, true, "the run is live before the cancel");

  const asked = requestCancel({ dir, id });
  assert.equal(asked.ok, true, asked.reason);
  await exited;

  const record = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
  assert.equal(record.stopped, "cancelled", "the run says it was cancelled, not that it failed");
  assert.equal(record.status, "stopped");
  assert.equal(record.ok, false);
  assert.match(printed, /"stopped":"cancelled"/, "and the child process agrees");

  // A cancel that arrives after the fact is an answer, not an error state.
  const late = requestCancel({ dir, id });
  assert.equal(late.ok, false);
  assert.match(late.reason, /already finished/);
  assert.equal(requestCancel({ dir, id: "r-nope" }).ok, false);
});

/**
 * A stale log has no owner, so a cancel flag would be planted where no one reads it.
 * Refusing is the honest answer; saying "will stop at its next step" is not.
 */
test("cancelling a stale run is refused instead of planting a flag nobody reads", async () => {
  const dir = DIR();
  const id = "r-20261019-100000-dead";
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "run", at: new Date().toISOString() })}\n`);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(join(dir, `${id}.jsonl`), old, old);

  assert.equal(runStatus({ dir, id }).status, "stale");
  const asked = requestCancel({ dir, id });
  assert.equal(asked.ok, false);
  assert.match(asked.reason, /stale/);
  assert.equal(existsSync(join(dir, `${id}.cancel`)), false, "no flag is left behind");
});
