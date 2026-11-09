/**
 * Auto-compaction and the number behind it.
 *
 * The rule this file exists to hold: a conversation that outgrows its window is
 * summarised and continued, not refused - and the summary is honest about what it is.
 *
 *   - the parts the meter shows are the parts the request is made of, and they add up
 *   - a provider's own `prompt_tokens` wins over our estimate for the messages row
 *   - under the threshold nothing is touched
 *   - over it, the system prompt and the newest turns survive verbatim, the dropped
 *     middle becomes one checkpoint, and the checkpoint is in the run's log
 *   - a summariser the router refuses degrades to a mechanical digest that says so
 *
 * A real `node:http` router answers every call, and every run writes into a temp
 * directory, so nothing here reads the real machine's stores.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import {
  COMPACT_AT,
  DEFAULT_CONTEXT_WINDOW,
  contextThreshold,
  estimateTokens,
  measureContext,
  weightFor,
} from "../src/context.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "harness-ctx-"));
const RUNS = join(ROOT, "runs");
mkdirSync(RUNS, { recursive: true });
writeFileSync(join(ROOT, "hello.txt"), "line one\nline two\n", "utf8");

const memFile = () => join(mkdtempSync(join(tmpdir(), "harness-ctx-mem-")), "memory.jsonl");
const routers = [];
after(() => Promise.all(routers.map((r) => r.close())));

// ---------------------------------------------------------------- the fake router

const reply = (content, usage = { prompt_tokens: 300, completion_tokens: 12 }) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage,
});

/**
 * A real HTTP router: the loop is not given a stubbed fetch, it is given an origin.
 *
 * `script` is consumed in order; an entry is either a reply object, a function of the
 * parsed body (so a test can answer the summariser differently from the step), or
 * `{ status }` to make the call fail the way a real router would.
 */
async function startRouter(script) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push({ url: req.url, body });
    let next = script.length > 1 ? script.shift() : script[0];
    if (typeof next === "function") next = next(body);
    if (!next) next = reply("(script exhausted)");
    if (next.status) {
      res.writeHead(next.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: next.error ?? "refused" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(next));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const router = {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    close: () => new Promise((done) => server.close(done)),
  };
  routers.push(router);
  return router;
}

const summaryCall = (calls) => calls.filter((c) => c.body.model === "fast");
const lastStep = (calls) => calls.filter((c) => c.body.model !== "fast").at(-1);

// ---------------------------------------------------------------- the numbers

test("the window is 32K by default and compaction fires at 55% of it", () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 32_768);
  assert.equal(COMPACT_AT, 0.55);
  // 32768 * 0.55 = 18022.4, rounded: a threshold is a token count, not a fraction.
  assert.equal(contextThreshold(32_768), 18_022);
  // The floor: a 2000-token window must not compact at 1100 when there is nothing
  // droppable to win back, and the summariser itself needs room.
  assert.equal(contextThreshold(2000), 2000);
  assert.equal(contextThreshold(100_000, 0.9), 90_000);
  // An out-of-range fraction is clamped, never trusted: at 9 the run would compact
  // only when the window was already gone.
  assert.equal(contextThreshold(100_000, 9), 90_000);
  // An explicit 0 is read as "not given" (a falsy number), not as "never compact":
  // silently turning compaction off is the one setting that would refill the window.
  assert.equal(contextThreshold(100_000, 0), 55_000);
  // A fraction small enough to be real is clamped to 0.1 and then floored at 2000, so
  // a tiny test window cannot ask compaction to win back less than the summary costs.
  assert.equal(contextThreshold(10_000, 0.001), 2_000);
});

test("the meter splits the prompt into system, tools and messages, and the parts add up", () => {
  const messages = [
    { role: "system", content: "s".repeat(400) },
    { role: "user", content: "u".repeat(400) },
    { role: "assistant", content: "a".repeat(400) },
  ];
  const tools = [{ type: "function", function: { name: "read_file", description: "read a file", parameters: { type: "object" } } }];
  const meter = measureContext({ messages, tools, window: 10_000 });

  assert.deepEqual(Object.keys(meter.parts).sort(), ["messages", "system", "tools"]);
  assert.equal(meter.used, meter.parts.system + meter.parts.tools + meter.parts.messages);
  assert.equal(meter.percent, Math.round((meter.used / 10_000) * 100));
  assert.equal(meter.window, 10_000);
  // Two message bodies cost more than the one system body, and the schema costs
  // something: all three rows are real numbers, not placeholders.
  assert.ok(meter.parts.messages > meter.parts.system, `${meter.parts.messages} vs ${meter.parts.system}`);
  assert.ok(meter.parts.tools > 0, "the tool schemas cost tokens");
  // Nothing has been sent, so nothing has been measured by a provider.
  assert.equal(meter.source, "estimate");
  assert.equal(meter.threshold, 5_500);
});

test("a provider's own count is preferred, and only the unsent tail is estimated", () => {
  const messages = [
    { role: "system", content: "rules ".repeat(60) },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "tool", tool_call_id: "c1", content: "x".repeat(4000) },
  ];
  const reported = 1200;
  const counted = measureContext({ messages, window: 10_000, usage: { prompt_tokens: reported }, sent: 3, tools: [] });
  const estimated = measureContext({ messages, window: 10_000, tools: [] });

  assert.equal(counted.source, "provider");
  // The system prompt costs the same either way: the provider's total covers it, and
  // the meter shows it under its own row rather than folding it into messages.
  assert.equal(counted.parts.system, estimated.parts.system);
  const tail = estimateTokens(messages.slice(3), { weightFor });
  assert.equal(counted.parts.messages, Math.max(0, reported + tail - counted.parts.system));
  // A 4000-char tool result is a third of a small window; the estimate that sees it
  // and the provider count that does not are genuinely different numbers.
  assert.notEqual(counted.parts.messages, estimated.parts.messages);
  // A count with no boundary to apply it to is ignored rather than trusted blindly.
  const noBoundary = measureContext({ messages, window: 10_000, usage: { prompt_tokens: reported }, sent: 0, tools: [] });
  assert.equal(noBoundary.source, "estimate");
});

// ---------------------------------------------------------------- through the loop

const say = (content, usage) => () => reply(content, usage);

test("a run that fits never compacts, and still reports what it costs", async () => {
  const router = await startRouter([say("pong", { prompt_tokens: 600, completion_tokens: 3 })]);
  const events = [];
  const result = await runAgent({
    root: ROOT,
    task: "Reply with exactly: pong",
    routerUrl: router.url,
    memoryFile: memFile(),
    contextWindow: 32_768,
    runId: "r-under",
    runsDir: RUNS,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.answer, "pong");
  assert.equal(events.some((event) => event.type === "compaction"), false);
  assert.equal(events.some((event) => event.type === "compact_skipped"), false);

  const readings = events.filter((event) => event.type === "ui/context");
  assert.deepEqual(
    readings.map((event) => event.phase),
    ["start", "step", "final"],
    "one reading at the start, one at the step boundary, one at the end",
  );
  for (const reading of readings) {
    assert.equal(reading.used, reading.parts.system + reading.parts.tools + reading.parts.messages);
    assert.equal(reading.window, 32_768);
    assert.equal(reading.threshold, 18_022);
  }
  // The last reading is the provider's count plus nothing appended since: the step
  // that answered was the last request.
  const final = readings.at(-1);
  assert.equal(final.source, "provider");
  assert.equal(result.contextMeter.used, final.used);
  assert.ok(final.used < final.threshold, `${final.used} < ${final.threshold}`);

  // The record carries the same numbers, which is what a reloaded page reads.
  const record = JSON.parse(readFileSync(join(RUNS, "r-under.json"), "utf8"));
  assert.equal(record.contextMeter.used, final.used);
  assert.equal(record.contextMeter.percent, final.percent);
});

/** A history long enough to overflow a 3200-token window, with findable text in it. */
function overflowingHistory() {
  const messages = [{ role: "system", content: "SYSTEM RULES: be terse." }];
  for (let i = 1; i <= 10; i += 1) {
    messages.push({ role: "user", content: `FILLER ${i} please do the thing: ${"u".repeat(900)}` });
    messages.push({ role: "assistant", content: `did step ${i}: ${"a".repeat(900)}` });
  }
  return messages;
}

test("an overflowing run compacts: system prompt and newest turns survive, the checkpoint is in the log", async () => {
  const seed = overflowingHistory();
  const router = await startRouter([
    (body) => (body.model === "fast" ? reply("We fixed the parser and read hello.txt.") : reply("DONE", { prompt_tokens: 900 })),
  ]);
  const events = [];
  const result = await runAgent({
    root: ROOT,
    task: "now answer DONE",
    messages: seed,
    routerUrl: router.url,
    memoryFile: memFile(),
    contextWindow: 9_000,
    keepLast: 4,
    runId: "r-over",
    runsDir: RUNS,
    onEvent: (event) => events.push(event),
  });

  const compact = events.find((event) => event.type === "compaction");
  assert.ok(compact, "expected a compaction event");
  assert.equal(compact.how, "model");
  assert.equal(compact.step, 1);
  assert.equal(compact.kept, 4);
  assert.ok(compact.dropped >= 10, `dropped ${compact.dropped}`);
  assert.ok(compact.tokensAfter < compact.tokensBefore, `${compact.tokensAfter} < ${compact.tokensBefore}`);
  // The event carries the threshold it fired against, not a number the reader has to
  // derive: 9000 * 0.55 = 4950. (9000, not 8000, since move_file, delete_file and edit_file's edits list grew the tool schemas by ~300 tokens, 2026-11-08.)
  assert.equal(compact.threshold, 4_950);
  assert.equal(compact.window, 9_000);
  assert.match(compact.summary, /parser/);
  // Requirement: never lose the user's original request.
  assert.match(compact.originalRequest, /^FILLER 1 please do the thing/);

  // The summariser was asked for prose about the dropped span, on the cheap class.
  assert.equal(summaryCall(router.calls).length, 1);
  assert.equal(summaryCall(router.calls)[0].body.tools, undefined);

  // What the answering step was actually sent.
  const step = lastStep(router.calls).body.messages;
  assert.equal(step[0].role, "system");
  assert.equal(step[0].content, seed[0].content, "the system prompt is untouched");
  assert.equal(step[1].role, "user");
  assert.match(step[1].content, /^\[summary of \d+ earlier message\(s\)/);
  assert.match(step[1].content, /We fixed the parser and read hello\.txt\./);
  assert.match(step[1].content, /Original request \(kept verbatim\): FILLER 1 please do the thing/);
  assert.ok(!JSON.stringify(step).includes("FILLER 5 please do the thing"), "the dropped middle must not be sent again");
  assert.match(JSON.stringify(step), /now answer DONE/);
  assert.equal(step.at(-1).role, "user");
  assert.equal(step.at(-1).content, "now answer DONE");

  // Every reading after the compaction is under the threshold again, and the one taken
  // right after it is an estimate: the provider's last count described a history that
  // no longer exists.
  const afterCompaction = events.filter((event) => event.type === "ui/context" && event.phase === "compaction");
  assert.equal(afterCompaction.length, 1);
  assert.equal(afterCompaction[0].source, "estimate");
  assert.ok(afterCompaction[0].used < afterCompaction[0].threshold, `${afterCompaction[0].used} < ${afterCompaction[0].threshold}`);

  // The audit line is in the run's own log, with the checkpoint text in it - the run
  // can be read back later without the model that wrote the summary.
  const log = readFileSync(join(RUNS, "r-over.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const logged = log.filter((event) => event.type === "compaction");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].summary, compact.summary);
  assert.equal(logged[0].tokensBefore, compact.tokensBefore);
  assert.equal(logged[0].originalRequest, compact.originalRequest);
  // And the conversation the caller gets back is the compacted one, not the seed.
  assert.ok(result.messages.length < seed.length, `${result.messages.length} < ${seed.length}`);
  assert.ok(result.contextMeter.used < 4_950, `${result.contextMeter.used} < 4950`);
});

test("a summariser the router refuses still compacts, and says the checkpoint is mechanical", async () => {
  const seed = overflowingHistory();
  const router = await startRouter([{ status: 503, error: "no capacity" }, say("DONE", { prompt_tokens: 900 })]);
  const events = [];
  const result = await runAgent({
    root: ROOT,
    task: "now answer DONE",
    messages: seed,
    routerUrl: router.url,
    memoryFile: memFile(),
    contextWindow: 3_200,
    keepLast: 4,
    runId: "r-mech",
    runsDir: RUNS,
    onEvent: (event) => events.push(event),
  });

  const compact = events.find((event) => event.type === "compaction");
  assert.ok(compact, "the run compacts even when the summariser is down");
  assert.equal(compact.how, "mechanical");
  assert.match(compact.note, /summarizer failed/);
  // The checkpoint is not empty and not a lie: it is built from the messages that were
  // dropped, and it carries the original request verbatim.
  assert.ok(compact.summary.length > 0);
  assert.match(compact.originalRequest, /^FILLER 1 please do the thing/);
  assert.match(JSON.stringify(lastStep(router.calls).body.messages), /written mechanically from them/);
  assert.equal(result.answer, "DONE", "the run survives a dead summariser");
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("a provider that reports no usage still gets a number, and it says it is an estimate", async () => {
  const router = await startRouter([() => ({ choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] })]);
  const events = [];
  const result = await runAgent({
    root: ROOT,
    task: "Reply with exactly: pong",
    routerUrl: router.url,
    memoryFile: memFile(),
    contextWindow: 32_768,
    runId: "r-nousage",
    runsDir: RUNS,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.answer, "pong");
  const final = events.filter((event) => event.type === "ui/context").at(-1);
  assert.equal(final.source, "estimate", "no provider count was reported, so nothing claims to be measured");
  assert.ok(final.used > 0, "the estimate is still a real projection of the request");
  assert.equal(result.contextMeter.source, "estimate");
  assert.equal(existsSync(join(RUNS, "r-nousage.jsonl")), true);
});
