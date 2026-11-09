/**
 * 2026-11-08: goal runs that stopped after one or two of five items, a Context window
 * change that only reached the next message, Steer for queued messages, and empty replies
 * from a cloud model whose whole output budget went on thinking.
 *
 * No network: the router is a scripted fetch.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GOAL_RUN, openTodos, outputGrowth, runAgent } from "../src/agent.mjs";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-goal-"));
  writeFileSync(join(dir, "hello.txt"), "hi\n", "utf8");
  return dir;
};

const say = (content, finish = "stop", usage = { prompt_tokens: 1, completion_tokens: 1 }) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: finish }],
  usage,
});
const useTool = (name, args, id = "c1") => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
  usage: {},
});

function routedTo(target, script) {
  const calls = [];
  const fn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const entry = script[Math.min(calls.length - 1, script.length - 1)];
    const payload = typeof entry === "function" ? entry(body, calls) : entry;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": target } });
  };
  fn.calls = calls;
  return fn;
}

const lastUser = (body) => [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";

test("a cloud reply that is empty because it hit the output limit is asked again with more room", async () => {
  const empty = say("", "length", { prompt_tokens: 4, completion_tokens: 4096 });
  const f = routedTo("anthropic/claude-opus-5-5", [empty, say("done")]);
  const result = await runAgent({ root: fresh(), task: "write a big file", fetchImpl: f, onEvent: () => {} });
  assert.equal(result.answer, "done");
  assert.deepEqual(f.calls.map((c) => c.max_tokens), [4096, 16384]);
  assert.equal(outputGrowth({ finishReason: "length", message: { content: "" }, cap: 4096, target: "local/qwen" }), null, "never for a local model");
  assert.equal(outputGrowth({ finishReason: "length", message: { content: "half an answer" }, cap: 4096, target: "anthropic/x" }), null, "a cut-off text answer is kept as it is");
});

test("openTodos reads the unfinished items of the latest todo_write", () => {
  const call = (todos) => ({ role: "assistant", content: "", tool_calls: [{ id: "t", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ todos }) } }] });
  const messages = [
    call([{ content: "old", status: "pending" }]),
    { role: "tool", content: "ok" },
    call([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ]),
  ];
  assert.deepEqual(openTodos(messages), ["b", "c"]);
  assert.deepEqual(openTodos([]), []);
});

test("a goal run that answers with items still open is sent back, naming the next items", async () => {
  const root = fresh();
  const plan = useTool("todo_write", { todos: [{ content: "item one", status: "completed" }, { content: "item two", status: "pending" }, { content: "item three", status: "pending" }] }, "p1");
  const f = routedTo("anthropic/claude-sonnet-5-5", [plan, say("Item one is done. What next?"), useTool("goal_update", { done: true, summary: "all three done" }, "g1"), say("All done.")]);
  const events = [];
  const result = await runAgent({ root, task: "do three items", goal: true, maxSteps: 2, fetchImpl: f, onEvent: (e) => events.push(e) });
  const nudge = events.find((e) => e.type === "goal_continue");
  assert.ok(nudge, "the early answer did not end the run");
  assert.match(lastUser(f.calls[2]), /2 unfinished item\(s\): 1\. item two; 2\. item three/);
  assert.ok(result.steps > 2, "a goal run is not held to the page's step limit");
  assert.equal(GOAL_RUN.steps, 800, "goals are long-horizon: 800 steps a round");
});

test("a Context window change reaches the running chat at its next step", async () => {
  let wanted = null;
  const f = routedTo("anthropic/claude-sonnet-5-5", [
    () => {
      wanted = 50_000;
      return useTool("read_file", { path: "hello.txt" });
    },
    say("read it"),
  ]);
  const events = [];
  await runAgent({ root: fresh(), task: "read hello", contextWindow: 131_072, liveContextWindow: () => wanted, fetchImpl: f, onEvent: (e) => events.push(e) });
  const change = events.find((e) => e.type === "context_window");
  assert.deepEqual({ from: change?.from, to: change?.to }, { from: 131_072, to: 50_000 });
  const meters = events.filter((e) => e.type === "ui/context");
  assert.equal(meters.at(-1).window, 50_000, "the gauge shows the new window");
});

test("Steer messages enter the run at the next step, and one that arrives with the answer keeps it going", async () => {
  const waiting = [];
  const f = routedTo("anthropic/claude-sonnet-5-5", [
    () => {
      waiting.push("use tabs, not spaces");
      return useTool("read_file", { path: "hello.txt" });
    },
    () => {
      waiting.push("and add a header");
      return say("first answer");
    },
    say("final answer"),
  ]);
  const events = [];
  const result = await runAgent({ root: fresh(), task: "tidy hello", takeSteer: () => waiting.splice(0), fetchImpl: f, onEvent: (e) => events.push(e) });
  assert.match(lastUser(f.calls[1]), /use tabs, not spaces/, "taken in at the step after it was sent");
  assert.match(lastUser(f.calls[2]), /and add a header/, "an answer written before the steer arrived does not end the run");
  assert.equal(result.answer, "final answer");
  assert.equal(events.filter((e) => e.type === "steer").length, 2);
});
