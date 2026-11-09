/**
 * A server that refuses a prompt it cannot hold must not end the turn.
 *
 * The failure this file exists for (measured 2026-11-06): the llama-server on :8080 was
 * started with `-c 32768` by something other than start-qwen.ps1, the run had been
 * launched believing 131072, so the meter never crossed its threshold, nothing compacted,
 * and a 36,630-token request came back as
 *
 *   request (36630 tokens) exceeds the available context size (32768 tokens), try increasing it
 *
 * ... and the chat stopped there. The refusal names the real window, so the loop adopts
 * that number, summarises the oldest turns to fit, and asks the same step again.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import { isContextOverflow, reportedContextWindow } from "../src/context.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "harness-overflow-"));
const RUNS = join(ROOT, "runs");
mkdirSync(RUNS, { recursive: true });
writeFileSync(join(ROOT, "hello.txt"), "hi\n", "utf8");

const routers = [];
after(() => Promise.all(routers.map((r) => r.close())));

const reply = (content, usage = { prompt_tokens: 300, completion_tokens: 8 }) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage,
});

/** The exact body llama.cpp sends on `exceed_context_size_error`. */
const refuse = (promptTokens, window) => ({
  status: 400,
  error: `request (${promptTokens} tokens) exceeds the available context size (${window} tokens), try increasing it`,
});

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
      return res.end(JSON.stringify({ error: { message: next.error ?? "refused", type: "invalid_request_error" } }));
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

// ---------------------------------------------------------------- the reading

test("the refusal is read as a window, not as a bad request", () => {
  const failure = { message: 'router returned 400 for class "local/qwen3.8-27b": {"error":{"message":"request (36630 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"invalid_request_error"}}' };
  const reported = reportedContextWindow(failure);
  assert.deepEqual(reported, { promptTokens: 36_630, window: 32_768, asked: 3_862 });
  assert.equal(isContextOverflow(failure), true);
  // Not every 400 is an overflow, and a plain malformed request must keep failing fast.
  assert.equal(isContextOverflow({ message: "router returned 400: unsupported parameter" }), false);
});

// ---------------------------------------------------------------- through the loop

/** A history that fits the assumed 32K window but not the 4K one the server really has. */
function fitsTheWrongWindow() {
  const messages = [{ role: "system", content: "SYSTEM RULES: be terse." }];
  for (let i = 1; i <= 8; i += 1) {
    messages.push({ role: "user", content: `TASK ${i}: ${"u".repeat(700)}` });
    messages.push({ role: "assistant", content: `did step ${i}: ${"a".repeat(700)}` });
  }
  return messages;
}

test("an overflow is compacted and the same step retried, under the server's real window", async () => {
  const router = await startRouter([
    // The step: refused, because the server's window is 4,000 and the prompt is bigger.
    () => refuse(5_200, 4_000),
    // The summariser: a real answer, so the compaction is a model summary.
    () => reply("We were listing the TASK steps one through eight."),
    // The retried step: now it fits.
    () => reply("DONE"),
  ]);
  const events = [];
  const result = await runAgent({
    root: ROOT,
    task: "now answer DONE",
    messages: fitsTheWrongWindow(),
    routerUrl: router.url,
    memoryFile: join(mkdtempSync(join(tmpdir(), "harness-overflow-mem-")), "memory.jsonl"),
    contextWindow: 32_768,
    runId: "r-overflow",
    runsDir: RUNS,
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.error, undefined, `the run must not end in an error: ${result.error}`);

  const compact = events.find((event) => event.type === "compaction");
  assert.ok(compact, "the refusal must produce a compaction, not an error");
  assert.equal(compact.afterOverflow, true);
  assert.equal(compact.window, 4_000, "the server's own window replaces the assumed one");
  assert.equal(compact.threshold, 2_200);
  assert.ok(compact.dropped >= 4, `dropped ${compact.dropped}`);
  assert.ok(compact.tokensAfter < compact.tokensBefore, `${compact.tokensAfter} < ${compact.tokensBefore}`);

  // No "This turn failed": the person sees a notice about the window and the answer.
  const failure = events.find((event) => event.type === "error");
  assert.equal(failure, undefined, `unexpected error event: ${failure?.message}`);
  const notice = events.find((event) => event.type === "notice" && (event.from ?? []).includes("context"));
  assert.ok(notice, "the person is told why the step was repeated");
  assert.match(notice.text, /only has 4,000 tokens/);
  // Advice that holds on any PC (a launcher path from one machine means nothing elsewhere).
  assert.match(notice.text, /bigger context window/);

  // Every later reading is against the real window, so the next step compacts in time.
  const readings = events.filter((event) => event.type === "ui/context");
  assert.equal(readings.at(-1).window, 4_000);
});

test("a second refusal in the same run is not retried a third time", async () => {
  // One function, not a script: every step call is refused, every summary is answered.
  const router = await startRouter([
    (body) => (body.model === "fast" ? reply("summary of the earlier turns") : refuse(5_200, 4_000)),
  ]);
  const events = [];
  const result = await runAgent({
    root: ROOT,
    task: "keep going",
    messages: fitsTheWrongWindow(),
    routerUrl: router.url,
    memoryFile: join(mkdtempSync(join(tmpdir(), "harness-overflow-mem-")), "memory.jsonl"),
    contextWindow: 32_768,
    runId: "r-overflow-twice",
    runsDir: RUNS,
    onEvent: (event) => events.push(event),
  });

  // Two rewinds at most, then the honest error with its explanation. A second rewind that
  // finds nothing safely droppable reports `compact_skipped` instead of a compaction, so
  // both count as the attempt.
  const rewinds = events.filter((event) => event.afterOverflow === true);
  assert.ok(rewinds.length <= 2, `expected at most two rewinds, saw ${rewinds.length}`);
  assert.ok(rewinds.length >= 1, "the first refusal is still retried");
  assert.ok(result.error, "a window that cannot hold the history still ends the turn");
  assert.match(result.error, /LOCAL-CTX-TOO-SMALL|CONTEXT-FULL/);
});

test("a local run never assumes more window than the server has", async () => {
  const { runContextWindow } = await import("../src/context.mjs");
  // The measured 2026-11-06 case: a 65,536 preference over a 32,768 server.
  assert.equal(runContextWindow(65_536, 32_768), 32_768);
  // A smaller preference is the person's own choice and still fits: leave it alone.
  assert.equal(runContextWindow(16_384, 131_072), 16_384);
  // No answer from the server (down, loading, a cloud model): the preference stands.
  assert.equal(runContextWindow(65_536, null), 65_536);
  assert.equal(runContextWindow(65_536, 0), 65_536);
  // A nonsense answer is not a window either.
  assert.equal(runContextWindow(65_536, 12), 65_536);
  assert.equal(runContextWindow(65_536, 32_768.7), 32_768);
});
