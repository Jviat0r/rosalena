/**
 * Memory: the rolling summary (session) and the store that outlives it (global).
 *
 * `MASTER-PLAN.md` 5.2 asks for both, and for compaction at a fraction of the
 * effective context rather than the usual 80% (the harness now compacts at 0.55,
 * see src/context.mjs). The tests below hold the two failure modes that would make
 * it worse than not having it at all:
 *
 *   - a compaction that orphans a tool result produces a request a provider
 *     rejects, so the cut must land on a user boundary or not happen;
 *   - a compaction that depends on the summarizer being up would lose the run
 *     whenever the summarizer is not, so the mechanical fallback is a path, not
 *     an error case.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import {
  compactMessages,
  estimateTokens,
  forget,
  formatRecords,
  isSummaryMessage,
  loadMemory,
  mechanicalSummary,
  memoryPrompt,
  memoryTools,
  planCompaction,
  recall,
  remember,
  summaryRequest,
} from "../src/memory.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-memory-"));
writeFileSync(join(WS, "hello.txt"), "line one\nline two\n", "utf8");
const memFile = () => join(mkdtempSync(join(tmpdir(), "harness-mem-")), "memory.jsonl");

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

/** A history long enough that the token estimate crosses a small window. */
function longHistory({ pairs = 6, chars = 700 } = {}) {
  const messages = [{ role: "system", content: "You are the orchestrator of the Rosalena harness." }];
  for (let i = 0; i < pairs; i += 1) {
    messages.push({ role: "user", content: `STEP ${i} please do the thing: ${"u".repeat(chars)}` });
    messages.push({ role: "assistant", content: `did step ${i}: ${"a".repeat(chars)}` });
  }
  messages.push({ role: "user", content: "now answer DONE" });
  return messages;
}

// --- the estimate and the cut -------------------------------------------------

test("the token estimate counts tool-call arguments, not just content", () => {
  const withCall = [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x".repeat(400) }) } }],
    },
  ];
  assert.ok(estimateTokens(withCall) > 100, `got ${estimateTokens(withCall)}`);
  assert.equal(estimateTokens([]), 0);
});

test("a short history is never compacted", () => {
  const messages = [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  assert.equal(planCompaction(messages, { keepLast: 8 }), null);
});

test("the cut keeps the last N verbatim when that lands on a turn boundary", () => {
  const messages = [
    { role: "system", content: "s" },
    { role: "user", content: "read it" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "the contents" },
    { role: "assistant", content: "it says hello" },
    { role: "user", content: "now write it" },
    { role: "assistant", content: "", tool_calls: [{ id: "c2", function: { name: "write_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c2", content: "wrote 5 bytes" },
    { role: "assistant", content: "done" },
  ];
  const plan = planCompaction(messages, { keepLast: 4 });
  assert.ok(plan, "expected a plan");
  assert.equal(messages[plan.cut].content, "now write it");
  assert.equal(plan.dropped, 4);
  assert.equal(plan.kept, 4);
});

test("a tool result is never kept without the assistant call that asked for it", () => {
  // Every shape of history: a parallel tool block, a turn boundary, and no turn
  // boundary at all. Whichever cut comes out, a retained `tool` message must have
  // its call retained with it, and the tail must never begin with one.
  const shapes = [
    (() => {
      const m = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
      for (let i = 0; i < 6; i += 1) {
        m.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, function: { name: "read_file", arguments: "{}" } }] });
        m.push({ role: "tool", tool_call_id: `c${i}`, content: "output" });
      }
      return m;
    })(),
    // One assistant call whose results are three separate messages.
    (() => {
      const m = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
      m.push({
        role: "assistant",
        content: "",
        tool_calls: [0, 1, 2].map((i) => ({ id: `p${i}`, function: { name: "read_file", arguments: "{}" } })),
      });
      for (const i of [0, 1, 2]) m.push({ role: "tool", tool_call_id: `p${i}`, content: "output" });
      m.push({ role: "assistant", content: "done" });
      return m;
    })(),
  ];
  for (const messages of shapes) {
    for (const keepLast of [1, 2, 3, 4, 7]) {
      const plan = planCompaction(messages, { keepLast });
      if (!plan) continue;
      const tail = messages.slice(plan.cut);
      assert.notEqual(tail[0].role, "tool", `keepLast=${keepLast} left an orphan at the head`);
      const keptIds = new Set(tail.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
      for (const m of tail) {
        if (m.role === "tool") assert.ok(keptIds.has(m.tool_call_id), `keepLast=${keepLast} orphaned ${m.tool_call_id}`);
      }
    }
  }
});

test("a single long turn with no user boundary still compacts", () => {
  // The case that matters: one task, many tool calls, no second user message. The
  // tail starts at an assistant message, which is valid because the summary that
  // replaces the dropped span is itself a user message.
  const messages = [{ role: "system", content: "s" }, { role: "user", content: "the one task" }];
  for (let i = 0; i < 5; i += 1) {
    messages.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, function: { name: "read_file", arguments: "{}" } }] });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: "output" });
  }
  const plan = planCompaction(messages, { keepLast: 4 });
  assert.ok(plan, "a single-turn history must still be compactable");
  assert.equal(messages[plan.cut].role, "assistant");
  assert.equal(plan.kept, 4);
  // Nothing droppable but the system prompt means no plan.
  assert.equal(planCompaction(messages.slice(0, 3), { keepLast: 2 }), null);
});

test("the mechanical summary names each turn, the tools it called and clips", () => {
  const span = [
    { role: "user", content: `the task ${"x".repeat(400)}` },
    { role: "assistant", content: "reading", tool_calls: [{ id: "c1", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "line one" },
    { role: "assistant", content: "done" },
  ];
  const text = mechanicalSummary(span, { perMessage: 40 });
  assert.match(text, /- user: the task x{10}/);
  assert.match(text, /…/);
  assert.match(text, /- assistant: reading \[called read_file\]/);
  assert.match(text, /- read_file result: line one/);
  assert.equal(mechanicalSummary([], {}), "(nothing to summarize)");
});

test("the summarizer is handed the dropped span, task first", () => {
  const span = [
    { role: "user", content: "ORIGINAL TASK: fix the parser" },
    { role: "assistant", content: "step one done" },
  ];
  const prompt = summaryRequest(span);
  assert.match(prompt, /ORIGINAL TASK: fix the parser/);
  assert.match(prompt, /assistant: step one done/);
  const huge = summaryRequest(
    Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `message ${i} ${"z".repeat(600)}` })),
    { maxChars: 2000 },
  );
  assert.match(huge, /^user: message 0/);
  assert.match(huge, /\(\d+ message\(s\) omitted\)/);
});

// --- compaction ---------------------------------------------------------------

test("a compaction replaces the old span with the model's summary", async () => {
  const messages = longHistory();
  const prompts = [];
  const result = await compactMessages({
    messages,
    keepLast: 4,
    summarize: async (prompt) => {
      prompts.push(prompt);
      return "We did steps 0-5; the parser is fixed; hello.txt holds the fixture.";
    },
  });

  assert.equal(result.compacted, true);
  assert.equal(result.how, "model");
  assert.ok(result.dropped >= 6, `dropped ${result.dropped}`);
  assert.ok(result.tokensAfter < result.tokensBefore);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /STEP 0 please do the thing/, "the summarizer must see what is being dropped");

  assert.equal(result.messages[0].role, "system");
  assert.ok(isSummaryMessage(result.messages[1]));
  assert.match(result.messages[1].content, /^\[summary of \d+ earlier message\(s\)/);
  assert.match(result.messages[1].content, /the parser is fixed/);
  assert.equal(result.messages.at(-1).content, "now answer DONE");
  // Two guarantees, not one. The dropped span's bulk must be gone - that is what
  // compaction is for - but the user's own request is carried verbatim, because a
  // model summary is free to decide it was already "covered by the bullets". So this
  // asserts the dropped turns are absent AND the first request is present, instead of
  // asserting the whole span (including the request) is absent.
  const kept = JSON.stringify(result.messages);
  // Indices 2..9 are the dropped assistant replies and the STEP 4 turn: everything the
  // cut removed except the request at index 1, which the checkpoint keeps on purpose.
  for (const turn of messages.slice(2, 10)) {
    assert.ok(!kept.includes(String(turn.content).slice(0, 40)), `dropped turn must be gone: ${String(turn.content).slice(0, 24)}…`);
  }
  assert.match(result.messages[1].content, /Original request \(kept verbatim\): STEP 0 please do the thing/);
});

test("a summarizer that throws falls back to the mechanical digest and keeps the run", async () => {
  const result = await compactMessages({
    messages: longHistory(),
    keepLast: 4,
    summarize: async () => {
      throw new Error("router returned 503 for class \"fast\"");
    },
  });
  assert.equal(result.compacted, true);
  assert.equal(result.how, "mechanical");
  assert.match(result.note, /summarizer failed: router returned 503/);
  assert.match(result.messages[1].content, /written mechanically from them; summarizer failed/);
  assert.match(result.messages[1].content, /- user: STEP 0/);
});

test("a summarizer that returns nothing is treated as a failure, not as a summary", async () => {
  const result = await compactMessages({ messages: longHistory(), keepLast: 4, summarize: async () => "   " });
  assert.equal(result.how, "mechanical");
  assert.equal(result.note, "summarizer returned nothing");
  assert.ok(result.summary.length > 0, "the mechanical digest is never empty");
});

test("with nothing safely droppable, the same array comes back untouched", async () => {
  const messages = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
  const result = await compactMessages({ messages, keepLast: 8, summarize: async () => "never called" });
  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test("a tail that is over budget on its own is not re-summarized every step", async () => {
  const messages = longHistory({ pairs: 3, chars: 2000 });
  const first = await compactMessages({ messages, keepLast: 4, summarize: async () => "summary one" });
  assert.equal(first.compacted, true);

  let calls = 0;
  const again = await compactMessages({
    messages: first.messages,
    keepLast: 4,
    summarize: async () => {
      calls += 1;
      return "summary two";
    },
  });
  assert.equal(again.compacted, false, "the only thing droppable was the summary itself");
  assert.match(again.reason, /retained tail alone is over the threshold/);
  assert.equal(calls, 0, "no model call is spent on it");
});

// --- the global store ---------------------------------------------------------

test("remember appends one JSON line per record and loadMemory reads them back", () => {
  const file = memFile();
  const a = remember({ kind: "decision", text: "Chose JSONL over SQLite for the memory store." }, { file });
  const b = remember({ kind: "fact", text: "The router listens on 8077.", project: "D:\\proj" }, { file });
  assert.equal(a.added, true);
  assert.equal(b.added, true);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, "utf8").trim().split(/\r?\n/).length, 2, "append-only, one record per line");

  const loaded = loadMemory({ file });
  assert.equal(loaded.records.length, 2);
  assert.equal(loaded.skipped, 0);
  assert.equal(loaded.records[0].kind, "decision");
  assert.equal(loaded.records[1].project, "D:\\proj");
});

test("a missing file is an empty store, not an error", () => {
  const loaded = loadMemory({ file: join(tmpdir(), "definitely-not-here", "memory.jsonl") });
  assert.deepEqual(loaded.records, []);
  assert.equal(loaded.exists, false);
});

test("a corrupt line is skipped and counted, and the rest survives", () => {
  const file = memFile();
  remember({ text: "first" }, { file });
  writeFileSync(file, `${readFileSync(file, "utf8")}{ this is not json\n`, "utf8");
  remember({ text: "third" }, { file });
  const loaded = loadMemory({ file });
  assert.deepEqual(loaded.records.map((r) => r.text), ["first", "third"]);
  assert.equal(loaded.skipped, 1);
});

test("the same note twice is refused, whitespace and case included", () => {
  const file = memFile();
  const first = remember({ kind: "constraint", text: "Never cold-call mobiles with AI voice." }, { file });
  const again = remember({ kind: "constraint", text: "  never   cold-call   mobiles with ai voice.  " }, { file });
  assert.equal(first.added, true);
  assert.equal(again.added, false);
  assert.equal(again.reason, "already known");
  assert.equal(again.record.id, first.record.id);
  assert.equal(loadMemory({ file }).records.length, 1);
  // A different kind is a different note: the fact and the constraint can coexist.
  assert.equal(remember({ kind: "fact", text: "Never cold-call mobiles with AI voice." }, { file }).added, true);
});

test("empty text is refused, unknown kinds become facts, and long text is capped", () => {
  const file = memFile();
  assert.equal(remember({ text: "   " }, { file }).added, false);
  const odd = remember({ kind: "gossip", text: "the port is 8090" }, { file });
  assert.equal(odd.record.kind, "fact");
  const long = remember({ text: "x".repeat(5000) }, { file });
  assert.equal(long.record.truncated, true);
  assert.equal(long.record.text.length, 2000);
});

test("recall filters by substring, kind and project, newest first", () => {
  const file = memFile();
  remember({ kind: "fact", text: "Tessaly domain is dead", project: "A" }, { file });
  remember({ kind: "decision", text: "Use Twilio for the business line", project: "A" }, { file });
  remember({ kind: "decision", text: "Use Focusrite for the mic", project: "B" }, { file });

  assert.equal(recall({ query: "twilio" }, { file }).matched, 1);
  assert.equal(recall({ kind: "decision" }, { file }).matched, 2);
  assert.equal(recall({ project: "A" }, { file }).matched, 2);
  assert.equal(recall({ kind: "decision", project: "A" }, { file }).matched, 1);
  assert.equal(recall({}, { file }).records[0].text, "Use Focusrite for the mic", "newest first");
  assert.equal(recall({ limit: 2 }, { file }).records.length, 2);
  assert.equal(recall({ query: "nothing here" }, { file }).matched, 0);
});

test("forget removes exactly one record", () => {
  const file = memFile();
  const a = remember({ text: "one" }, { file });
  remember({ text: "two" }, { file });
  assert.equal(forget(a.record.id, { file }).removed, 1);
  assert.deepEqual(loadMemory({ file }).records.map((r) => r.text), ["two"]);
  assert.equal(forget("nope", { file }).removed, 0);
});

test("the prompt block puts this project's facts first and respects its budget", () => {
  const records = [
    { kind: "fact", text: "other project note", project: "B", at: "2026-10-19T10:00:00.000Z" },
    { kind: "fact", text: "this project note", project: "A", at: "2026-10-19T09:00:00.000Z" },
    { kind: "constraint", text: "never x", project: "B", at: "2026-10-19T11:00:00.000Z" },
  ];
  const block = memoryPrompt(records, { project: "A", maxChars: 400 });
  assert.match(block, /What you already know from earlier sessions/);
  assert.ok(block.indexOf("this project note") < block.indexOf("never x"), "own project first");

  const capped = memoryPrompt(
    Array.from({ length: 20 }, (_, i) => ({ kind: "fact", text: `note ${i} ${"y".repeat(200)}` })),
    { maxChars: 500 },
  );
  assert.ok(capped.length < 900, `capped block was ${capped.length} chars`);
  assert.match(capped, /\(\d+ older not shown\)/);
  assert.equal(memoryPrompt([]), "");
});

// --- the tools ----------------------------------------------------------------

test("the remember and recall tools round-trip through the store", async () => {
  const file = memFile();
  const [rememberTool, recallTool] = memoryTools({ file, project: "D:\\proj" });
  const wrote = await rememberTool.run({ kind: "decision", text: "The harness compacts at 50% of the window." });
  assert.match(wrote, /^remembered as decision \(/);
  assert.equal((await rememberTool.run({ kind: "decision", text: "The harness compacts at 50% of the window." })), `not written (already known): ${loadMemory({ file }).records[0].id}`);

  const found = await recallTool.run({ query: "compacts" });
  assert.match(found, /1 of 1 stored/);
  assert.match(found, /The harness compacts at 50%/);
  assert.match(await recallTool.run({ query: "the moon" }), /no memories match "the moon" \(1 stored\)/);
  assert.match(formatRecords([]), /\(nothing\)/);
});

test("a fact written in one run is in the system prompt of the next", async () => {
  const file = memFile();
  const first = scripted([
    useTool("remember", { kind: "constraint", text: "Tessaly's public site is frozen until the domain moves." }, "call_r"),
    say("noted"),
  ]);
  const run1 = await runAgent({ root: WS, task: "note the Tessaly rule", fetchImpl: first, memoryFile: file, onEvent: () => {} });
  assert.equal(run1.answer, "noted");
  assert.ok(first.calls[0].body.tools.some((t) => t.function.name === "remember"), "the tool is offered");

  const second = scripted([say("ok")]);
  await runAgent({ root: WS, task: "do something else", fetchImpl: second, memoryFile: file, onEvent: () => {} });
  const system = second.calls[0].body.messages.find((m) => m.role === "system").content;
  assert.match(system, /What you already know from earlier sessions/);
  assert.match(system, /\[constraint\] Tessaly's public site is frozen/);
  assert.match(system, /Keep `remember` notes short and self-contained/);
});

// --- through the loop ---------------------------------------------------------

test("the loop compacts before a step, and the model only ever sees the summary", async () => {
  const events = [];
  const f = scripted([say("We did steps 0-5; hello.txt holds the fixture."), say("DONE")]);
  const result = await runAgent({
    root: WS,
    messages: longHistory(),
    fetchImpl: f,
    memory: true,
    memoryFile: memFile(),
    contextWindow: 3200,
    compactAt: 0.5,
    keepLast: 4,
    onEvent: (e) => events.push(e),
  });

  const compact = events.find((e) => e.type === "compaction");
  assert.ok(compact, "expected a compaction event");
  assert.equal(compact.how, "model");
  assert.equal(compact.step, 1);
  assert.ok(compact.tokensAfter < compact.tokensBefore);

  // Call 1 is the summary (cheap class), call 2 is the step.
  const summaryCall = f.calls[0].body;
  assert.equal(summaryCall.model, "fast");
  assert.match(summaryCall.messages.at(-1).content, /STEP 0 please do the thing/);
  assert.equal(summaryCall.tools, undefined, "the summarizer is asked for prose, not tools");

  const stepCall = f.calls[1].body;
  const sent = JSON.stringify(stepCall.messages);
  assert.match(sent, /\[summary of \d+ earlier message\(s\)/);
  // The dropped middle is not re-sent, with one deliberate exception: the user's own
  // request rides along verbatim, so a summary that forgets it cannot lose the task.
  assert.match(sent, /Original request \(kept verbatim\): STEP 0 please do the thing/);
  assert.ok(!sent.includes("STEP 4 please do the thing"), "the dropped span must not be sent again");
  assert.match(sent, /now answer DONE/);
  assert.equal(result.answer, "DONE");
  assert.equal(result.steps, 1);
});

test("a summarizer the router refuses still compacts, mechanically", async () => {
  const events = [];
  const f = scripted([new Response("no capacity", { status: 503 }), say("DONE")]);
  const result = await runAgent({
    root: WS,
    messages: longHistory(),
    fetchImpl: f,
    memoryFile: memFile(),
    contextWindow: 3200,
    keepLast: 4,
    onEvent: (e) => events.push(e),
  });
  const compact = events.find((e) => e.type === "compaction");
  assert.equal(compact?.how, "mechanical");
  assert.match(compact.note, /summarizer failed: router returned 503/);
  assert.equal(result.answer, "DONE", "the run survives a dead summarizer");
  assert.equal(events.some((e) => e.type === "error"), false);
});

test("a tail that cannot be compacted under the window is reported once, not re-summarized", async () => {
  const events = [];
  // Step 1 calls a tool so the run reaches a second step boundary: a run that
  // answers immediately never gets there, which is the normal case.
  const f = scripted([say("summary one"), useTool("read_file", { path: "hello.txt" }), say("DONE"), say("four")]);
  // The shape that matters: big messages, and a tail whose bulk is a single call
  // plus its result. Once step 1 has compacted, those two messages alone are still
  // over the threshold, and no further summary can change that.
  const history = longHistory({ pairs: 3, chars: 6000 });
  history[history.length - 1] = { role: "user", content: `now answer DONE ${"d".repeat(6000)}` };
  history.push({
    role: "assistant",
    content: `thinking ${"k".repeat(6000)}`,
    tool_calls: [{ id: "ch", function: { name: "read_file", arguments: "{}" } }],
  });
  history.push({ role: "tool", tool_call_id: "ch", content: `earlier output ${"t".repeat(6000)}` });

  const result = await runAgent({
    root: WS,
    messages: history,
    fetchImpl: f,
    maxSteps: 3,
    memoryFile: memFile(),
    contextWindow: 3200,
    keepLast: 2,
    onEvent: (e) => events.push(e),
  });

  const compacts = events.filter((e) => e.type === "compaction");
  const skipped = events.filter((e) => e.type === "compact_skipped");
  assert.equal(compacts.length, 1, "one compaction is all the run can use");
  assert.ok(skipped.length >= 1);
  assert.match(skipped[0].reason, /compaction cannot get under the 2000-token threshold/);
  assert.match(skipped[0].reason, /lower --keep-last or raise --context-window/);
  // The invariant that matters: no summarizer call is ever spent without a
  // compaction to show for it, and giving up is not a failure of the run.
  const summaryCalls = f.calls.filter((c) => c.body.model === "fast").length;
  assert.equal(summaryCalls, compacts.filter((e) => e.how === "model").length);
  assert.equal(result.answer, "DONE");
  assert.equal(events.some((e) => e.type === "error"), false);
});

test("memory: false offers no memory tools and never compacts", async () => {
  const events = [];
  const f = scripted([say("DONE")]);
  const result = await runAgent({
    root: WS,
    messages: longHistory(),
    fetchImpl: f,
    memory: false,
    contextWindow: 1000,
    compactAt: 0.1,
    keepLast: 2,
    onEvent: (e) => events.push(e),
  });
  const names = f.calls[0].body.tools.map((t) => t.function.name);
  assert.ok(!names.includes("remember") && !names.includes("recall"), names.join(", "));
  assert.equal(events.some((e) => e.type === "compaction"), false);
  assert.equal(result.answer, "DONE");
});
