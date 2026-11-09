/**
 * Usage and spend per run (usage.mjs, agent.mjs, runs.mjs, stream.mjs):
 *
 *   - the tally adds tokens and dollars per call, by kind and by target, and folds a
 *     worker's own tally in; a reply without usage is counted, never given tokens
 *   - the router's price arrives as `x-router-cost-usd` on a buffered reply and as a
 *     closing `: x-router-cost` comment on a stream, and both reach the run's total
 *   - the result, the run record and the index line carry it
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/agent.mjs";
import { listRuns, openRun } from "../src/runs.mjs";
import { readStreamedCompletion } from "../src/stream.mjs";
import { createUsageTally, formatUsage } from "../src/usage.mjs";

test("the tally adds calls by kind and target, and folds a worker in", () => {
  const t = createUsageTally();
  t.add({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } }, { kind: "step", target: "groq/a", usd: 0.001 });
  t.add({ prompt_tokens: 500, completion_tokens: 50 }, { kind: "step", target: "local/q", usd: 0 });
  t.add(null, { kind: "judge", target: "groq/a", usd: null });
  const child = createUsageTally();
  child.add({ prompt_tokens: 100, completion_tokens: 10 }, { kind: "step", target: "local/q", usd: 0 });
  t.addRun(child.snapshot());
  const s = t.snapshot();
  assert.deepEqual(s.total, { calls: 4, prompt: 1600, completion: 260, cached: 600, unmeasured: 1, usd: 0.001, priced: 3 });
  assert.equal(s.byKind.step.calls, 2);
  assert.equal(s.byKind.judge.unmeasured, 1);
  assert.equal(s.byKind.workers.prompt, 100);
  assert.equal(s.byTarget["local/q"].calls, 2);
  assert.match(formatUsage(s), /^1\.6k in \(600 cached\) \/ 260 out, 4 call\(s\), 1 without token counts, \$0\.0010 \(1 call\(s\) unpriced\)$/);
  assert.equal(formatUsage(createUsageTally().snapshot()), "no model calls");
});

test("a streamed reply picks up the router's closing cost comment; data-only readers ignore it", async () => {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
    "data: [DONE]\n\n",
    `: x-router-cost ${JSON.stringify({ usd: 0.0042, measured: true, target: "cerebras/x" })}\n\n`,
  ];
  const res = new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  const out = await readStreamedCompletion(res);
  assert.equal(out.message.content, "hi");
  assert.equal(out.costUsd, 0.0042);
  assert.equal(out.frames, 2, "the comment is not counted as a data frame");
});

test("a run's result and record carry its own tokens and dollars", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-usage-"));
  const fetchImpl = async (url) => {
    if (!String(url).endsWith("/chat/completions")) return new Response("{}", { status: 404 });
    return new Response(
      JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 2000, completion_tokens: 40 } }),
      { headers: { "content-type": "application/json", "x-router-target": "groq/m", "x-router-cost-usd": "0.0007" } },
    );
  };
  const result = await runAgent({ root: process.cwd(), task: "say done", cls: "fast", stream: false, fetchImpl, runsDir: dir, extraHooks: [], onEvent: () => {} });
  assert.equal(result.answer, "done");
  assert.equal(result.usage.total.calls, 1);
  assert.equal(result.usage.total.prompt, 2000);
  assert.equal(result.usage.total.usd, 0.0007);
  assert.equal(result.usage.byTarget["groq/m"].completion, 40);
  const record = JSON.parse(readFileSync(result.runFile, "utf8"));
  assert.equal(record.usage.total.usd, 0.0007);
  const row = listRuns({ dir }).find((r) => r.id === result.run);
  assert.equal(row.tokens, 2040);
  assert.equal(row.usd, 0.0007);
});

test("a run with no priced call records usd as unknown, not $0", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-usage-idx-"));
  const t = createUsageTally();
  t.add({ prompt_tokens: 10, completion_tokens: 2 }, { target: "x/y" });
  openRun({ dir, id: "r-20261104-020000-aaaa", meta: { task: "t" } }).finish({ answer: "a", steps: 1, usage: t.snapshot() });
  const row = listRuns({ dir })[0];
  assert.equal(row.tokens, 12);
  assert.equal(row.usd, null);
});
