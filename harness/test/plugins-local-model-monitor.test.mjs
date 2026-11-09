// The local-model-monitor plugin, tested against real loopback servers.
//
// There is no mocked fetch here on purpose: the plugin's whole job is an HTTP
// conversation with llama.cpp, and the interesting failures are HTTP failures -
// a port with nothing behind it, a server that answers too slowly, a 500, a build
// without /slots. A stubbed fetch would only ever test the stub.
//
// Nothing here needs a GPU or the real model: the stubs answer /health, /props,
// /slots and /metrics with the shapes llama.cpp actually returns.

import test from "node:test";
import { detectServerRoots } from "../src/local-paths.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import localModelMonitor, {
  baseUrlOf,
  deferredFromMetrics,
  formatDuration,
  formatReport,
  formatRequests,
  logFilesOf,
  parsePromptProgress,
  probeLocalModel,
  promptProgressFor,
  recordHarnessCall,
  resetHarnessCalls,
  timeoutOf,
} from "../plugins/rosa-local-model-monitor/plugin.mjs";

// Captured from the live server on this box (llama-server 0.1.2-dev, build
// 10517): the fields the plugin reads and nothing else.
const PROPS = {
  default_generation_settings: { n_ctx: 131072, params: { n_predict: 4096 } },
  total_slots: 1,
  model_alias: "qwen3.8-27b",
  model_ftype: "Q4_K - Medium",
  model_path: "D:\\models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf",
  endpoint_slots: true,
  endpoint_metrics: false,
};

const busySlot = (task, { prompt = 1958, processed = 0, cached = 0, decoded = 37, remain = 4059 } = {}) => ({
  id: 0,
  n_ctx: 131072,
  speculative: true,
  is_processing: true,
  id_task: task,
  n_prompt_tokens: prompt,
  n_prompt_tokens_processed: processed,
  n_prompt_tokens_cache: cached,
  params: { n_predict: 4096, max_tokens: 4096 },
  next_token: [{ has_next_token: true, has_new_line: false, n_remain: remain, n_decoded: decoded }],
});

// llama.cpp keeps the last task id on an idle slot and resets the token counters,
// which is exactly the trap the ledger has to avoid trusting.
const idleSlot = (task) => ({
  id: 0,
  n_ctx: 131072,
  is_processing: false,
  id_task: task,
  n_prompt_tokens: 1958,
  n_prompt_tokens_processed: 0,
  n_prompt_tokens_cache: 0,
  params: { n_predict: 4096 },
  next_token: [{ has_next_token: false, has_new_line: false, n_remain: -1, n_decoded: 0 }],
});

/**
 * A llama.cpp-shaped stub whose answers are mutable on purpose: the request
 * ledger can only be tested by making the server answer differently between two
 * probes, and that is also how the real server behaves.
 */
async function startServer(options = {}) {
  const state = {
    health: options.health ?? "ok", // ok | loading | missing
    slots: options.slots ?? [idleSlot(1)],
    slotsStatus: options.slotsStatus ?? 0, // non-zero: answer that status instead
    props: options.props ?? PROPS,
    metrics: options.metrics ?? null, // null: 501, the default build
    failAll: options.failAll ?? 0,
    delayMs: options.delayMs ?? 0,
  };
  const seen = [];

  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, "http://stub").pathname;
    seen.push(`${req.method} ${path}`);
    // A client that gave up mid-answer (the timeout test) leaves this socket
    // destroyed; writing to it must not crash the stub.
    res.on("error", () => {});
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (state.delayMs) await sleep(state.delayMs);
      if (state.failAll) return json(state.failAll, { error: { code: state.failAll, message: "boom" } });
      if (path === "/health") {
        if (state.health === "missing") return json(404, { error: { code: 404, message: "File Not Found" } });
        if (state.health === "loading") return json(503, { error: { code: 503, message: "Loading model" } });
        return json(200, { status: "ok" });
      }
      if (path === "/props") return json(200, state.props);
      if (path === "/slots") {
        if (state.slotsStatus) {
          return json(state.slotsStatus, { error: { code: state.slotsStatus, message: "This server does not support slots endpoint." } });
        }
        return json(200, state.slots);
      }
      if (path === "/metrics") {
        if (state.metrics === null) return json(501, { error: { code: 501, message: "This server does not support metrics endpoint." } });
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        return res.end(state.metrics);
      }
      return json(404, { error: { code: 404, message: "not found" } });
    } catch {
      /* the client went away; that is the timeout test, not a stub failure */
    }
  });

  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  return {
    state,
    seen,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ------------------------------------------------------------------ the probe

test("a healthy server is read from /health, /props and /slots, and only by GET", async (t) => {
  const stub = await startServer({ slots: [busySlot(239070)] });
  t.after(() => stub.close());

  const probe = await probeLocalModel({ baseUrl: stub.baseUrl });

  assert.equal(probe.up, true);
  assert.equal(probe.error, null);
  assert.equal(probe.model, "qwen3.8-27b");
  assert.equal(probe.modelFtype, "Q4_K - Medium");
  assert.equal(probe.ctx, 131072);
  assert.equal(probe.totalSlots, 1);
  assert.equal(probe.busy, 1);
  assert.equal(probe.slots.length, 1);

  const slot = probe.slots[0];
  assert.equal(slot.busy, true);
  assert.equal(slot.task, 239070);
  assert.equal(slot.nCtx, 131072);
  assert.equal(slot.promptTokens, 1958);
  assert.equal(slot.promptProcessed, 0);
  assert.equal(slot.promptCached, 0);
  assert.equal(slot.decoded, 37);
  assert.equal(slot.remain, 4059);
  // The first sample that saw the task is when its duration starts, and the
  // report says so instead of pretending to know when it began.
  assert.equal(slot.busyForMs, 0);
  assert.equal(slot.samples, 1);

  // This build answers 501 for /metrics, so the queue is unmeasured - not zero.
  assert.equal(probe.queued, null);
  assert.match(probe.queuedNote, /no queue length/);
  assert.match(probe.queuedNote, /HTTP 501/);

  assert.deepEqual(probe.lastEnded, []);
  assert.equal(probe.requests.length, 1);
  assert.equal(probe.requests[0].state, "running");

  assert.ok(stub.seen.length >= 4, `expected the probe to reach every endpoint, saw ${stub.seen.join(", ")}`);
  assert.deepEqual([...new Set(stub.seen.map((line) => line.split(" ")[0]))], ["GET"], "the monitor must never write to the server");
});

test("a task that leaves its slot is recorded as ended, with the last numbers measured while busy", async (t) => {
  const stub = await startServer({ slots: [busySlot(7, { decoded: 512 })] });
  t.after(() => stub.close());

  const first = await probeLocalModel({ baseUrl: stub.baseUrl });
  assert.equal(first.slots[0].samples, 1);

  await sleep(60);
  stub.state.slots = [idleSlot(7)]; // the slot keeps the task id but stops processing
  const second = await probeLocalModel({ baseUrl: stub.baseUrl });

  assert.equal(second.busy, 0);
  assert.equal(second.lastEnded.length, 1);
  const ended = second.lastEnded[0];
  assert.equal(ended.task, 7);
  assert.equal(ended.slot, 0);
  assert.equal(ended.state, "ended");
  assert.equal(ended.how, "idle");
  assert.ok(ended.elapsedMs >= 40, `the span is measured, not guessed (got ${ended.elapsedMs}ms)`);
  // The idle sample resets n_decoded to 0; the ledger must keep what it measured.
  assert.equal(ended.decoded, 512);
  assert.equal(second.requests[0].state, "ended");
  assert.equal(second.requests[0].elapsedMs, ended.elapsedMs);

  const report = formatReport(second);
  assert.match(report, /1 recently finished/);
  assert.match(report, /the slot went idle; llama\.cpp reports no stop reason/);
});

test("a task replaced without an idle sample is reported as replaced", async (t) => {
  const stub = await startServer({ slots: [busySlot(7)] });
  t.after(() => stub.close());

  await probeLocalModel({ baseUrl: stub.baseUrl });
  stub.state.slots = [busySlot(8)];
  const second = await probeLocalModel({ baseUrl: stub.baseUrl });

  assert.equal(second.lastEnded.length, 1);
  assert.equal(second.lastEnded[0].task, 7);
  assert.equal(second.lastEnded[0].how, "replaced");
  assert.equal(second.requests.find((row) => row.state === "running").task, 8);
});

test("a probe that cannot read /slots leaves the task unconfirmed instead of finishing it", async (t) => {
  const stub = await startServer({ slots: [busySlot(7)] });
  t.after(() => stub.close());

  await probeLocalModel({ baseUrl: stub.baseUrl });
  stub.state.slotsStatus = 501;
  const blind = await probeLocalModel({ baseUrl: stub.baseUrl });
  assert.equal(blind.lastEnded.length, 0, "nothing is declared finished while /slots is unreadable");
  assert.equal(blind.requests.find((row) => row.task === 7).state, "unknown");
  assert.equal(blind.slotsAvailable, false);

  stub.state.slotsStatus = 0;
  stub.state.slots = [idleSlot(7)];
  const later = await probeLocalModel({ baseUrl: stub.baseUrl });
  assert.equal(later.lastEnded.length, 1);
  assert.equal(later.lastEnded[0].unseenProbes, 1);
  assert.match(formatReport(later), /1 probe could not read \/slots while it ran/);
});

// ---------------------------------------------------------------- the failures

test("a server that is not listening is a reported problem, never a throw", async () => {
  const stub = await startServer({});
  await stub.close();

  const probe = await probeLocalModel({ baseUrl: stub.baseUrl, timeoutMs: 500 });

  assert.equal(probe.up, false);
  assert.match(probe.error, /connection refused/);
  assert.equal(probe.slotsAvailable, false);
  assert.deepEqual(probe.slots, []);
  assert.equal(probe.busy, null, "no slot count is invented when no slot was read");
  assert.equal(probe.queued, null);
  assert.equal(probe.model, null);
  assert.equal(probe.ctx, null);
  assert.deepEqual(probe.lastEnded, []);
});

test("a slow server times out instead of hanging the caller", async (t) => {
  const stub = await startServer({ slots: [busySlot(7)], delayMs: 400 });
  t.after(() => stub.close());

  const started = Date.now();
  const probe = await probeLocalModel({ baseUrl: stub.baseUrl, timeoutMs: 80 });
  const elapsed = Date.now() - started;

  assert.equal(probe.up, false);
  assert.match(probe.error, /timed out after 80ms/);
  assert.ok(elapsed < 1000, `the probe gave up at its deadline, took ${elapsed}ms`);
});

test("a server that answers 500 everywhere is reported, not read as up", async (t) => {
  const stub = await startServer({ failAll: 500 });
  t.after(() => stub.close());

  const probe = await probeLocalModel({ baseUrl: stub.baseUrl });

  assert.equal(probe.up, false);
  assert.match(probe.error, /HTTP 500/);
  assert.equal(probe.healthStatus, 500);
  assert.equal(probe.slotsAvailable, false);
  assert.deepEqual(probe.requests, []);
  assert.match(formatReport(probe), /is not answering \(GET \/health answered HTTP 500 - boom\)/);
});

test("a build without /slots says so instead of inventing numbers", async (t) => {
  const stub = await startServer({ slotsStatus: 501 });
  t.after(() => stub.close());

  const probe = await probeLocalModel({ baseUrl: stub.baseUrl });

  assert.equal(probe.up, true, "the server is up; only the slot endpoint is missing");
  assert.equal(probe.model, "qwen3.8-27b");
  assert.equal(probe.slotsAvailable, false);
  assert.equal(probe.busy, null);
  assert.deepEqual(probe.slots, []);
  assert.match(probe.slotsError, /does not support slots endpoint/);
  assert.equal(probe.error, probe.slotsError);

  const report = formatReport(probe);
  assert.match(report, /up - qwen3\.8-27b/);
  assert.match(report, /slots\s+unavailable - GET \/slots answered HTTP 501/);
  assert.match(report, /a made-up number would be worse than no number/);
  assert.doesNotMatch(report, /\d+ of \d+ slot/, "no busy/total count may be printed without /slots");
});

test("a server still loading its model is distinguished from one that is down", async (t) => {
  const stub = await startServer({ health: "loading" });
  t.after(() => stub.close());

  const probe = await probeLocalModel({ baseUrl: stub.baseUrl });

  assert.equal(probe.up, false);
  assert.equal(probe.loading, true);
  assert.match(probe.error, /HTTP 503 - Loading model/);
  assert.equal(probe.ctx, 131072, "props answered, so the model that is loading can still be named");
  assert.match(formatReport(probe), /up but still loading its model/);
});

// ----------------------------------------------------------------- the queue

test("deferredFromMetrics reads the gauge it is given and nothing else", () => {
  assert.equal(deferredFromMetrics("llamacpp:requests_deferred 3\n"), 3);
  assert.equal(deferredFromMetrics('llamacpp:requests_deferred{model="qwen"} 4\n'), 4);
  assert.equal(deferredFromMetrics("# HELP llamacpp:requests_deferred x\n# TYPE llama gauge\nllamacpp:requests_processing 1\n"), null);
  assert.equal(deferredFromMetrics("not prometheus at all"), null);
  assert.equal(deferredFromMetrics(""), null);
  assert.equal(deferredFromMetrics(null), null);
});

test("the queue is a real number only when the build publishes metrics", async (t) => {
  const metrics = [
    "# HELP llamacpp:requests_deferred Number of requests deferred.",
    "# TYPE llamacpp:requests_deferred gauge",
    "llamacpp:requests_deferred 2",
    "llamacpp:requests_processing 1",
    "",
  ].join("\n");
  const stub = await startServer({ slots: [busySlot(7)], metrics });
  t.after(() => stub.close());

  const probe = await probeLocalModel({ baseUrl: stub.baseUrl });

  assert.equal(probe.queued, 2);
  assert.match(probe.queuedSource, /\/metrics/);
  assert.equal(probe.queuedNote, null);
  assert.match(formatReport(probe), /queued\s+2 \(GET \/metrics llamacpp:requests_deferred\)/);
});

// ------------------------------------------------------------------- the tools

test("the plugin offers exactly the two tools it promises, plus a status line", () => {
  const tools = localModelMonitor.tools({ config: {} });
  assert.deepEqual(tools.map((tool) => tool.name), ["local_model_monitor", "local_model_requests"]);
  assert.equal(localModelMonitor.id, "rosa-local-model-monitor");

  // The status hook is a description, not a probe: loading the harness must not
  // depend on the model server being awake.
  const text = localModelMonitor.status({ config: { baseUrl: "http://127.0.0.1:9" } });
  assert.match(text, /read-only monitor of http:\/\/127\.0\.0\.1:9/);
  assert.match(text, /probe timeout 1500ms/);
  assert.equal(timeoutOf({ timeoutMs: 10 }), 1500, "a timeout below 50ms falls back to the default");
  assert.equal(baseUrlOf({ baseUrl: "http://127.0.0.1:8080/" }), "http://127.0.0.1:8080");
});

test("the monitor tool answers in one call, and degrades when the server is down", async (t) => {
  const stub = await startServer({ slots: [busySlot(239070)] });
  t.after(() => stub.close());

  const tool = localModelMonitor.tools({ config: { baseUrl: stub.baseUrl } }).find((entry) => entry.name === "local_model_monitor");
  const text = await tool.run();
  assert.match(text, /up - qwen3\.8-27b \(Q4_K - Medium\)/);
  assert.match(text, /131072 tokens per slot, 1 slot/);
  assert.match(text, /1 of 1 slot busy/);
  assert.match(text, /task 239070/);
  assert.match(text, /prompt 1958 tokens/);
  assert.match(text, /37 decoded/);
  assert.match(text, /queued/);
  assert.match(text, /llama\.cpp reports no start time/);

  const dead = await startServer({});
  await dead.close();
  const deadTool = localModelMonitor.tools({ config: { baseUrl: dead.baseUrl, timeoutMs: 500 } }).find((entry) => entry.name === "local_model_monitor");
  const downText = await deadTool.run();
  assert.match(downText, /is not answering \(GET \/health failed: connection refused\)/);
  assert.match(downText, /Read-only/);
});

test("local_model_requests lists what was seen, newest first and bounded", async (t) => {
  const stub = await startServer({ slots: [busySlot(1)] });
  t.after(() => stub.close());

  const tool = localModelMonitor.tools({ config: { baseUrl: stub.baseUrl } }).find((entry) => entry.name === "local_model_requests");
  const one = await tool.run({});
  assert.match(one, /running\s+slot 0\s+task 1/);

  stub.state.slots = [busySlot(2)];
  const two = await tool.run({ limit: 2 });
  const rows = two.split("\n").filter((line) => line.includes("slot 0"));
  assert.equal(rows.length, 2, two);
  assert.match(rows[0], /task 2/, "newest start first");
  assert.match(rows[1], /task 1/);
  assert.match(two, /ended\s+slot 0\s+task 1/);
  assert.match(two, /another task took the slot before a probe saw it idle/);

  stub.state.slots = [busySlot(3)];
  const three = await tool.run({ limit: 1 });
  assert.equal(three.split("\n").filter((line) => line.includes("slot 0")).length, 1, "the limit is honoured");
});

test("durations read like durations", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(12_340), "12.3s");
  assert.equal(formatDuration(125_000), "2m 05s");
  assert.equal(formatDuration(-1), "?");
});

// ----------------------------------------------------------- the llm/stream hook
//
// The hook is the one thing here the harness drives: the loop calls it twice per
// model call (phase "start", then "end"). These tests call it exactly the way the
// loop does - same field names, no server of their own - and then read the ledger
// back through the probe, which is how the page and the tools see it.

const hookOf = () => localModelMonitor.hooks({ config: {} })["llm/stream"];

// A server that is definitely not listening: reading the ledger needs no stub, and a
// refused connection is the fastest way to get a probe that says so.
const OFFLINE = "http://127.0.0.1:9";
const readCalls = async (extra = {}) => (await probeLocalModel({ baseUrl: OFFLINE, timeoutMs: 200, ...extra })).harnessCalls;

test("one call reported at both ends is one exact row, with the loop's own numbers", async () => {
  resetHarnessCalls();
  const hook = hookOf();
  const start = { run: { id: "run-1" }, step: 1, attempt: 1, cls: "orchestrate", target: "local/qwen3.8-27b", stream: true, phase: "start" };
  assert.equal(hook(start), undefined, "the hook returns nothing: an observer must not advise the loop");
  assert.equal(
    hook({ ...start, phase: "end", ok: true, ms: 4321, ttftMs: 900, usage: { prompt_tokens: 1958, completion_tokens: 37, total_tokens: 1995 } }),
    undefined,
  );

  const calls = await readCalls();
  assert.equal(calls.length, 1, "a start and its end are one call, not two");
  const call = calls[0];
  assert.equal(call.source, "harness");
  assert.equal(call.state, "ended");
  assert.equal(call.ok, true);
  assert.equal(call.ms, 4321, "the loop measured the duration; this plugin does not second-guess it");
  assert.equal(call.ttftMs, 900);
  assert.equal(call.target, "local/qwen3.8-27b");
  assert.equal(call.streamed, true);
  assert.deepEqual(call.usage, { prompt: 1958, completion: 37, total: 1995 });
});

test("a failed call says how it failed, and an end with no start is still a row", async () => {
  resetHarnessCalls();
  const hook = hookOf();
  const base = { run: { id: "run-2" }, step: 3, attempt: 2, cls: "orchestrate", stream: false };

  hook({ ...base, phase: "start", target: "local/qwen3.8-27b" });
  hook({ ...base, phase: "end", ok: false, ms: 1500, reason: "step_timeout", error: "the router did not answer in 60000ms" });
  // Half an observation is still worth reporting: a row with no measured start beats
  // silently dropping a call the harness definitely made.
  hook({ run: { id: "run-2" }, step: 4, attempt: 1, phase: "end", ok: true, ms: 88 });

  const calls = await readCalls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].step, 4, "newest first");
  assert.equal(calls[0].ms, 88);
  assert.equal(calls[1].ok, false);
  assert.equal(calls[1].how, "step_timeout");
  assert.match(calls[1].error, /did not answer/);
  assert.equal(calls[1].usage, null, "no usage was reported, so none is invented");
});

test("the call ledger is bounded, and the hook never throws on a shape it did not expect", async () => {
  resetHarnessCalls();
  const hook = hookOf();
  assert.deepEqual(Object.keys(localModelMonitor.hooks({ config: {} })), ["llm/stream"], "the monitor registers this hook and no other");

  // The loop awaits this inside its own step: junk from a future harness must not
  // become a crashed run, and must not take the monitor down with it.
  for (const junk of [undefined, null, {}, { phase: "end" }, { phase: "start" }, 42, "x", { run: null, step: "one" }]) {
    assert.doesNotThrow(() => hook(junk));
  }
  resetHarnessCalls();

  for (let i = 0; i < 60; i += 1) {
    hook({ run: { id: "flood" }, step: i, attempt: 1, phase: "start" });
    hook({ run: { id: "flood" }, step: i, attempt: 1, phase: "end", ok: true, ms: i });
  }
  const calls = await readCalls({ recentLimit: 100 });
  // Two bounds, both real: the ledger keeps a window of calls, and one answer shows
  // at most MAX_ROWS of them (the same cap the requests list uses). Sixty calls in,
  // the newest twenty-five out - and never a growing list in a page that polls.
  assert.equal(calls.length, 25, "the probe returns at most a bounded window, not everything ever seen");
  assert.equal(calls[0].step, 59);
  assert.equal(calls.at(-1).step, 35);
  assert.equal(typeof recordHarnessCall, "function", "the recorder is reachable for callers that report their own calls");
});

test("the report and the requests list keep exact rows apart from sampled ones", async (t) => {
  resetHarnessCalls();
  const hook = hookOf();
  const base = { run: { id: "run-9" }, step: 1, attempt: 1, cls: "orchestrate", stream: true, target: "local/qwen3.8-27b" };
  hook({ ...base, phase: "start" });
  hook({ ...base, phase: "end", ok: true, ms: 2500, usage: { prompt_tokens: 1958, completion_tokens: 37 } });

  // A slot that was busy too, so both sources appear in one answer.
  const stub = await startServer({ slots: [busySlot(77)] });
  t.after(() => stub.close());
  const probe = await probeLocalModel({ baseUrl: stub.baseUrl });

  const report = formatReport(probe);
  assert.match(report, /harness\s+1 model call\(s\) reported by the loop, newest first:/);
  assert.match(report, /2\.5s ok - local\/qwen3\.8-27b, 1958 in \/ 37 out/);
  assert.match(report, /exact: the loop reported each start and end/);

  const requests = formatRequests(probe, 10);
  const callRow = requests.split("\n").find((line) => line.includes("harness"));
  assert.match(callRow, /ended\s+harness\s+local\/qwen3\.8-27b\s+2\.5s/, "exact rows are labelled harness, not merged into a slot");
  assert.match(requests, /finished; 1958 in \/ 37 out/);
  assert.match(requests, /running\s+slot 0\s+task 77/, "the sampled row is still reported, and still labelled slot");
});

// ------------------------------------------------------- prompt-read progress (0.1.1)

// Four real lines from D:\llama.cpp\logs\qwen.log (2026-10-21, task 55749, a 73,598-token
// prompt of which ~68k was reused from cache), ANSI colours as written.
const REAL_LINES = [
  "\x1b[34m101.35.894.482\x1b[0m \x1b[32mI \x1b[0mslot print_timing: id  0 | task 55749 | prompt processing, n_tokens =   4096, progress = 0.98, t =   5.16 s / 794.49 tokens per second",
  "\x1b[34m101.36.961.558\x1b[0m \x1b[32mI \x1b[0mslot print_timing: id  0 | task 55749 | prompt processing, n_tokens =   4862, progress = 0.99, t =   6.45 s / 754.09 tokens per second",
  "\x1b[34m101.37.284.057\x1b[0m \x1b[32mI \x1b[0mslot print_timing: id  0 | task 55749 | prompt processing, n_tokens =   4983, progress = 0.99, t =   6.87 s / 725.02 tokens per second",
  "\x1b[34m101.38.007.712\x1b[0m \x1b[32mI \x1b[0mslot print_timing: id  0 | task 55749 | prompt processing, n_tokens =   5374, progress = 1.00, t =   7.42 s / 724.30 tokens per second",
];

// Measured live 2026-10-21 on an uncached 19,707-token prompt (task 8904). /slots said
// n_prompt_tokens = 2048, 4096, ... during the read, so only the log can size the prompt.
const UNCACHED = [[4096, 0.21], [6144, 0.31], [8192, 0.42], [10240, 0.52], [12288, 0.62], [14336, 0.73], [16384, 0.83]]
  .map(([n, p]) => `slot print_timing: id  0 | task 8904 | prompt processing, n_tokens = ${n}, progress = ${p}, t = 1 s / 1300.00 tokens per second`);

test("prompt-read % is over the NEW tokens, sized from the log, not from /slots", () => {
  // /slots' partial n_prompt_tokens (2048 ahead of the read) must not size the prompt.
  const reading = { slot: 0, task: 8904, busy: true, decoded: 0, promptTokens: 18432 };
  const one = promptProgressFor(reading, parsePromptProgress(UNCACHED[0]));
  assert.equal(one.overNewTokens, false, "one line can't be fitted: llama.cpp's own figure, labelled as such");
  assert.equal(Math.round(one.progress * 100), 21);
  const all = promptProgressFor(reading, parsePromptProgress(UNCACHED.join("\n")));
  assert.equal(all.overNewTokens, true);
  assert.ok(Math.abs(all.newTokens - 19707) < 400, `sized ${all.newTokens}, real 19707`);
  assert.ok(all.reused < 400, "uncached: nothing (or rounding noise) reused");
  assert.equal(Math.round(all.progress * 100), 83);

  // Mostly cached (0.98 -> 1.00): too little spread to size it, so no invented split.
  const slot = { slot: 0, task: 55749, busy: true, decoded: 0, promptTokens: 73598 };
  const cached = promptProgressFor(slot, parsePromptProgress(REAL_LINES.join("\n")));
  assert.equal(cached.overNewTokens, false);
  assert.equal(cached.newTokens, null);
  assert.equal(Math.round(cached.progress * 100), 100);
  assert.equal(cached.done, 5374);
  // A line for another task, a generating slot, or an idle slot claims nothing.
  assert.equal(promptProgressFor({ ...slot, task: 1 }, parsePromptProgress(REAL_LINES[0])), null);
  assert.equal(promptProgressFor({ ...slot, decoded: 3 }, parsePromptProgress(REAL_LINES[0])), null);
  assert.equal(promptProgressFor({ ...slot, busy: false }, parsePromptProgress(REAL_LINES[0])), null);
});

test("a probe reads the newest server log only while a prompt is being read", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "rh-monitor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const older = join(dir, "older.log");
  const newer = join(dir, "server.log");
  writeFileSync(older, "slot print_timing: id  0 | task 55749 | prompt processing, n_tokens = 1, progress = 0.01, t = 1 s / 1 tokens per second\n");
  writeFileSync(newer, `startup noise\n${UNCACHED.slice(0, 4).join("\n")}\n`);
  utimesSync(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

  const stub = await startServer({ slots: [busySlot(8904, { prompt: 12288, processed: 10240, cached: 0, decoded: 0 })] });
  t.after(() => stub.close());
  const probe = await probeLocalModel({ baseUrl: stub.baseUrl, logFiles: [older, newer, join(dir, "missing.log")] });
  const slot = probe.slots[0];
  assert.equal(slot.promptProgressSource, "server.log", "the newest existing log wins");
  assert.ok(Math.abs(Math.round(slot.promptProgress.progress * 100) - 52) <= 1, `got ${slot.promptProgress.progress}`);
  assert.match(formatReport(probe), /reading the prompt: 5\d% \(10240 of \d+ new tokens\), 1300 tok\/s, about .* left - from llama-server's log \(server\.log\)/);

  // No progress line yet (short prompt, or the first batch not done): say so, claim no %.
  const quiet = await probeLocalModel({ baseUrl: stub.baseUrl, logFiles: [join(dir, "missing.log")] });
  assert.equal(quiet.slots[0].promptProgress, null);
  assert.match(formatReport(quiet), /reading the prompt \(no progress line yet/);

  // A generating slot never reads the log at all.
  stub.state.slots = [busySlot(8904, { decoded: 40 })];
  const writing = await probeLocalModel({ baseUrl: stub.baseUrl, logFiles: [newer] });
  assert.equal(writing.slots[0].promptProgress, null);
  assert.equal(writing.slots[0].hasNextToken, true, "has_next_token is read (it was always null before 0.1.1)");
});

test("the log list defaults to the suite's and the launchers' llama-server logs", () => {
  const files = logFilesOf({});
  assert.ok(files.some((f) => /local-server\.log$/.test(f)));
  // The launchers' logs come from the llama.cpp actually installed here, if any.
  for (const dir of detectServerRoots()) {
    assert.ok(files.some((f) => f.startsWith(dir) && /server-err\.log$/.test(f)), `no server-err.log under ${dir}`);
  }
  assert.ok(!files.some((f) => /^D:\\llama\.cpp/i.test(f)) || detectServerRoots().some((d) => /^D:\\llama\.cpp/i.test(d)), "no D:\\ default unless that folder exists");
  assert.deepEqual(logFilesOf({ logFiles: ["X:\\only.log"] }), ["X:\\only.log"]);
});
