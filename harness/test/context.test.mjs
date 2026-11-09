/**
 * Per-tool context sizing and the tool-output cache.
 *
 * The two rules under test are the ones that decide whether a long run survives its
 * own context: an estimate that does not under-count, and a cache that never claims
 * freshness it has not checked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CALIBRATION, DEFAULT_PROFILE, TOOL_PROFILES, budgetFor, clipForTool, createToolCache, weightFor } from "../src/context.mjs";
import { createTools, runToolCall } from "../src/tools.mjs";
import { estimateMessageTokens, estimateTokens, toolNamesById } from "../src/memory.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-context-"));
const write = (name, text) => {
  const p = join(WS, name);
  writeFileSync(p, text, "utf8");
  return p;
};
const newTools = (opts = {}) => createTools({ root: WS, allowShell: true, ...opts });

// ---------------------------------------------------------------------------
// The profiles
// ---------------------------------------------------------------------------

test("every built-in tool has a profile, and unknown tools get the pessimistic default", () => {
  for (const name of ["read_file", "write_file", "list_dir", "search", "run_command", "delegate"]) {
    assert.ok(TOOL_PROFILES[name], `${name} has no profile`);
    assert.ok(TOOL_PROFILES[name].budget > 0, `${name} has no budget`);
  }
  assert.equal(weightFor("a-plugin-tool-nobody-measured"), DEFAULT_PROFILE.charsPerToken);
  assert.ok(DEFAULT_PROFILE.charsPerToken < CALIBRATION.folklore, "the default weight must beat the flat 4");
});

test("no weight exceeds the measurement it came from", () => {
  // This is the rule the module promises: a weight is the measured value floored,
  // so the estimate can only err toward "more tokens". A hand-tuned weight that
  // buys room by lying about the cost fails here.
  const shapeOf = { read_file: "source code", read_hashed: "source code", write_file: "prose", edit_file: "prose", delegate: "prose", list_dir: "directory listing", run_command: "command output", search: "search hits" };
  const measured = new Map(CALIBRATION.samples.map((s) => [s.shape, s.charsPerToken]));
  for (const [tool, profile] of Object.entries(TOOL_PROFILES)) {
    const m = measured.get(shapeOf[tool]);
    assert.ok(m, `${tool} maps to no calibration sample`);
    assert.ok(profile.charsPerToken <= m, `${tool}: weight ${profile.charsPerToken} exceeds the measured ${m}`);
  }
});

test("the measured table is self-consistent, and every sample beat the flat guess", () => {
  for (const s of CALIBRATION.samples) {
    assert.ok(Math.abs(s.chars - s.tokens * s.charsPerToken) / s.chars < 0.01, `${s.shape}: ${s.chars}/${s.tokens} != ${s.charsPerToken}`);
    assert.ok(s.charsPerToken < CALIBRATION.folklore, `${s.shape} measured ${s.charsPerToken}, which is not below the folklore ${CALIBRATION.folklore}`);
  }
});

test("an explicit global budget flattens the per-tool budgets", () => {
  assert.equal(budgetFor("read_file"), TOOL_PROFILES.read_file.budget);
  assert.equal(budgetFor("read_file", 1234), 1234);
  assert.equal(budgetFor("run_command", 1234), 1234);
  assert.equal(budgetFor("read_file", 0), TOOL_PROFILES.read_file.budget, "0 is not a budget, it is a missing flag");
  assert.equal(budgetFor("read_file", Number.NaN), TOOL_PROFILES.read_file.budget);
});

test("clipping keeps the end that tool's output wants", () => {
  const long = "START" + "x".repeat(9000) + "END";
  const head = clipForTool("read_file", long);
  assert.ok(head.startsWith("START"), "a file read keeps the head");
  assert.ok(head.includes("truncated"));
  const tail = clipForTool("run_command", long);
  assert.ok(tail.endsWith("END"), "command output keeps the tail, where the error is");
  assert.ok(clipForTool("read_file", "short") === "short", "a result under budget is untouched");
});

// ---------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------

test("a tool result is priced by the tool that produced it", () => {
  const log = "x".repeat(4000);
  const asCommand = { role: "tool", tool_call_id: "c1", content: log };
  const messages = [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "run_command", arguments: "{}" } }] },
    asCommand,
  ];
  assert.deepEqual([...toolNamesById(messages)], [["c1", "run_command"]]);
  const weighted = estimateTokens(messages, { weightFor });
  const flat = estimateTokens(messages);
  assert.ok(weighted > flat, `weighted ${weighted} should exceed the flat ${flat}`);
  // 4000 chars at the measured 2.0 chars/token, not at the flat 4.
  assert.equal(weighted - flat, 2000 - 1000, "a log costs double what chars/4 claims");
});

test("a tool call's own arguments are still counted, and an unknown tool falls back", () => {
  const withArgs = [{ role: "assistant", content: null, tool_calls: [{ id: "c9", function: { name: "mystery", arguments: '{"a":"' + "y".repeat(800) + '"}' } }] }];
  assert.ok(estimateMessageTokens(withArgs[0], { weightFor, toolName: null }) > 200);
  const asTool = [{ ...withArgs[0] }, { role: "tool", tool_call_id: "c9", content: "z".repeat(800) }];
  const priced = estimateTokens(asTool, { weightFor });
  assert.ok(priced > estimateTokens(asTool), "an unknown tool is priced at the pessimistic default, below 4");
  assert.equal(estimateTokens([]), 0);
  assert.equal(estimateTokens(null), 0);
});

test("without a weight the estimate is exactly the old flat one", () => {
  const m = [{ role: "tool", tool_call_id: "c1", content: "a".repeat(400) }];
  assert.equal(estimateMessageTokens(m[0]), Math.ceil(400 / 4) + 4);
  assert.equal(estimateTokens(m), Math.ceil(400 / 4) + 4);
});

// ---------------------------------------------------------------------------
// The tool layer actually applies them
// ---------------------------------------------------------------------------

test("read_file clips at its own budget, and a huge line range cannot walk past it", async () => {
  write("big.txt", "A".repeat(40_000));
  const tools = newTools();
  const full = await runToolCall({ function: { name: "read_file", arguments: JSON.stringify({ path: "big.txt" }) } }, tools);
  assert.ok(full.text.length < 12_000, `full read was ${full.text.length} chars`);
  assert.ok(full.text.length > 7000, "the head of the file should survive up to the budget");
  assert.ok(full.text.includes("truncated"));
  // The range path used to return everything it was asked for.
  const ranged = await runToolCall(
    { function: { name: "read_file", arguments: JSON.stringify({ path: "big.txt", offset: 1, limit: 40_000 }) } },
    tools,
  );
  assert.ok(ranged.text.length <= 9_000, `a 40000-line request produced ${ranged.text.length} chars`);
});

test("run_command keeps the tail of a chatty command", async () => {
  const tools = newTools();
  const r = await runToolCall(
    { function: { name: "run_command", arguments: JSON.stringify({ command: "node -e \"console.log('x'.repeat(9000) + 'THE-END')\"" }) } },
    tools,
  );
  assert.ok(r.ok, r.text);
  assert.ok(r.text.includes("THE-END"), "the end of stdout must survive the clip");
  assert.ok(r.text.length < 5000, `expected the run_command budget, got ${r.text.length} chars`);
});

test("a plugin tool's output is clipped too - it used to be unbounded", async () => {
  const tools = newTools({ extraTools: [{ name: "greedy", description: "dumps", parameters: { type: "object", properties: {} }, run: async () => "G".repeat(50_000) }] });
  const r = await runToolCall({ function: { name: "greedy", arguments: "{}" } }, tools);
  assert.ok(r.text.length < 7000, `plugin output was ${r.text.length} chars`);
  assert.ok(r.text.includes("truncated"));
});

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

test("a second identical read of an unchanged file is a stub, not the bytes", async () => {
  write("seen.txt", "the content of the file ".repeat(200));
  const hits = [];
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache, onCacheHit: (i) => hits.push(i) });
  const call = { function: { name: "read_file", arguments: JSON.stringify({ path: "seen.txt" }) } };
  const first = await runToolCall(call, tools);
  const second = await runToolCall(call, tools);
  assert.ok(first.text.startsWith("the content"), "the first read is real content");
  assert.ok(second.text.startsWith("[unchanged]"), `second read was: ${second.text.slice(0, 60)}`);
  assert.ok(second.text.length < first.text.length / 10, "the stub must be much smaller than the content");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tool, "read_file");
  assert.equal(hits[0].bytes, first.text.length);
  assert.deepEqual(
    { hits: cache.stats().hits, stubbedBytes: cache.stats().stubbedBytes },
    { hits: 1, stubbedBytes: first.text.length },
  );
});

test("argument order does not defeat the cache, but different arguments do", async () => {
  write("keys.txt", Array.from({ length: 100 }, (_, i) => `line ${i + 1} of the file`).join("\n"));
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const a = { function: { name: "read_file", arguments: JSON.stringify({ path: "keys.txt", offset: 1, limit: 5 }) } };
  const b = { function: { name: "read_file", arguments: JSON.stringify({ limit: 5, offset: 1, path: "keys.txt" }) } };
  const c = { function: { name: "read_file", arguments: JSON.stringify({ path: "keys.txt", offset: 2, limit: 5 }) } };
  await runToolCall(a, tools);
  const same = await runToolCall(b, tools);
  const other = await runToolCall(c, tools);
  assert.ok(same.text.startsWith("[unchanged]"), "the same call with reordered keys is the same call");
  assert.ok(other.text.startsWith("2: line 2"), `a different range must re-read, got: ${other.text.slice(0, 20)}`);
});

test("a changed file is re-read: size and mtime are the validity token", async () => {
  const p = write("changing.txt", "first version ".repeat(50));
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const call = { function: { name: "read_file", arguments: JSON.stringify({ path: "changing.txt" }) } };
  await runToolCall(call, tools);
  // A different size is the easy case.
  writeFileSync(p, "second version, and longer ".repeat(60), "utf8");
  const afterWrite = await runToolCall(call, tools);
  assert.ok(afterWrite.text.startsWith("second version"), "a rewritten file must not be served from the cache");
  // Same size, different content, and an mtime moved by hand: the token must notice.
  await runToolCall(call, tools);
  writeFileSync(p, "x".repeat(readFileSync(p, "utf8").length), "utf8");
  const future = new Date(Date.now() + 5000);
  utimesSync(p, future, future);
  const afterTouch = await runToolCall(call, tools);
  assert.ok(!afterTouch.text.startsWith("[unchanged]"), "an externally modified file must be re-read");
});

test("a write invalidates every cached read, even of a different file", async () => {
  write("other.txt", "unchanged throughout ".repeat(50));
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const read = { function: { name: "read_file", arguments: JSON.stringify({ path: "other.txt" }) } };
  await runToolCall(read, tools);
  assert.ok((await runToolCall(read, tools)).text.startsWith("[unchanged]"));
  await runToolCall({ function: { name: "write_file", arguments: JSON.stringify({ path: "unrelated.txt", content: "new" }) } }, tools);
  const after = await runToolCall(read, tools);
  assert.ok(after.text.startsWith("unchanged throughout"), "a write anywhere invalidates the run's cached reads");
});

test("a compaction invalidates the cache - the copy the stub points at may be gone", async () => {
  write("compacted.txt", "the bytes a stub would point at ".repeat(50));
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const call = { function: { name: "read_file", arguments: JSON.stringify({ path: "compacted.txt" }) } };
  await runToolCall(call, tools);
  assert.ok((await runToolCall(call, tools)).text.startsWith("[unchanged]"));
  cache.invalidateAll(); // exactly what agent.mjs does after compacting
  const after = await runToolCall(call, tools);
  assert.ok(after.text.startsWith("the bytes a stub"), "after a compaction the bytes must be sent again");
  assert.ok(cache.stats().stale >= 0);
});

test("nothing without an exact validity check is cached: run_command always runs", async () => {
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const marker = join(WS, "runs.txt");
  const call = {
    function: { name: "run_command", arguments: JSON.stringify({ command: `node -e "require('fs').appendFileSync('runs.txt','x')"` }) },
  };
  await runToolCall(call, tools);
  await runToolCall(call, tools);
  const ran = readFileSync(marker, "utf8");
  assert.equal(ran, "xx", "a shell command with side effects must never be answered from a cache");
  assert.equal(cache.stats().hits, 0);
});

test("the cache is bounded, and eviction is not a correctness problem", async () => {
  const cache = createToolCache({ root: WS, limit: 2 });
  const tools = newTools({ cache });
  for (const name of ["a.txt", "b.txt", "c.txt"]) {
    write(name, `content of ${name} `.repeat(20));
    await runToolCall({ function: { name: "read_file", arguments: JSON.stringify({ path: name }) } }, tools);
  }
  assert.ok(cache.stats().entries <= 2, `entries grew to ${cache.stats().entries}`);
  write("a.txt", "content of a.txt ".repeat(20));
  const reread = await runToolCall({ function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }, tools);
  assert.ok(reread.text.startsWith("content of a.txt"), "an evicted entry simply re-reads");
});

test("a failed read is not cached, so a later legitimate read is real", async () => {
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const call = { function: { name: "read_file", arguments: JSON.stringify({ path: "later.txt" }) } };
  const missing = await runToolCall(call, tools);
  assert.equal(missing.ok, false);
  write("later.txt", "it exists now ".repeat(30));
  const real = await runToolCall(call, tools);
  assert.ok(real.ok && real.text.startsWith("it exists now"), "a refused read must not be remembered as the file's content");
});

test("the cache never applies to a tool whose profile says no", async () => {
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const call = { function: { name: "list_dir", arguments: JSON.stringify({ path: "." }) } };
  await runToolCall(call, tools);
  await runToolCall(call, tools);
  assert.equal(cache.stats().hits, 0, "list_dir is not cacheable");
  assert.equal(cache.stats().entries, 0);
});

test("a run with no cache behaves exactly as before", async () => {
  write("nocache.txt", "plain ".repeat(100));
  const tools = newTools();
  const call = { function: { name: "read_file", arguments: JSON.stringify({ path: "nocache.txt" }) } };
  const a = await runToolCall(call, tools);
  const b = await runToolCall(call, tools);
  assert.equal(a.text, b.text);
  assert.ok(!b.text.startsWith("[unchanged]"));
});

test("peek reports the text a hit stands for, without counting it as one", async () => {
  write("peek.txt", "peeked at ".repeat(40));
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const args = { path: "peek.txt" };
  assert.equal(cache.peek("read_file", args), null, "nothing is remembered before the read");
  const first = await runToolCall({ function: { name: "read_file", arguments: JSON.stringify(args) } }, tools);
  // This is what the stall detector hashes: the same identity for the read and for
  // every stub that stands in for it, so a spinning loop cannot hide behind a save.
  assert.equal(cache.peek("read_file", args).text, first.text);
  const before = JSON.stringify(cache.stats());
  assert.equal(cache.peek("read_file", args).text, first.text);
  assert.equal(JSON.stringify(cache.stats()), before, "peeking must not move the counters");
  assert.equal(cache.peek("run_command", { command: "echo hi" }), null, "an uncacheable tool has nothing to peek at");
});

test("the workspace root is still enforced with a cache in play", async () => {
  const cache = createToolCache({ root: WS });
  const tools = newTools({ cache });
  const escape = await runToolCall({ function: { name: "read_file", arguments: JSON.stringify({ path: "../../etc/passwd" }) } }, tools);
  assert.equal(escape.ok, false);
  assert.match(escape.text, /outside the workspace/);
  assert.equal(cache.stats().entries, 0, "a refused path must not be cached");
});

test("the cache root resolves relative paths the same way the tools do", () => {
  // agent.mjs passes the same root to both, and a mismatch would silently never hit.
  const cache = createToolCache({ root: resolve(WS) });
  write("resolve.txt", "resolved ".repeat(20));
  cache.put("read_file", { path: "resolve.txt" }, "text");
  assert.ok(cache.get("read_file", { path: "resolve.txt" }), "the same root must produce a hit");
});
