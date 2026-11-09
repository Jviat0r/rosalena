/**
 * Long goals (src/goal-runner.mjs and goal mode in agent.mjs):
 *
 *   - a mission runs round after round, each with a fresh context, until the goal is done
 *   - it stops when a round is blocked on the person, after two failing rounds, at the
 *     round limit, and when cancelled
 *   - within one run, an answer that leaves the goal open is sent back to carry on, and
 *     marking the goal done ends it; "I'm blocked" is allowed to stop
 *   - after a compaction the goal and its latest state are put back in front of the model
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { continuationTask, runGoal } from "../src/goal-runner.mjs";
import { runAgent, saysBlocked } from "../src/agent.mjs";

const fake = (outcomes) => {
  const calls = [];
  const impl = async (opts) => {
    calls.push(opts);
    const o = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    return { answer: o.answer ?? "worked on it", steps: 3, error: o.error ?? null, stopped: o.stopped ?? null, goal: { done: o.done === true }, run: `r${calls.length}` };
  };
  impl.calls = calls;
  return impl;
};

test("a mission runs fresh rounds until the goal is done", async () => {
  const impl = fake([{}, {}, { done: true }]);
  const out = await runGoal({ task: "build the thing", runAgentImpl: impl, maxRounds: 10 });
  assert.equal(out.stopped, "done");
  assert.equal(out.done, true);
  assert.equal(out.rounds.length, 3);
  assert.equal(impl.calls[0].task, "build the thing");
  assert.equal(impl.calls[1].task, continuationTask("build the thing", 2));
  assert.ok(impl.calls.every((c) => c.goal === true && c.messages === null), "every round is goal mode with a fresh context");
});

test("a mission stops when blocked, after two failing rounds, at the limit, and when cancelled", async () => {
  assert.equal((await runGoal({ task: "x", runAgentImpl: fake([{}, { answer: "I'm blocked on the API key you have to create." }]) })).stopped, "blocked");
  assert.equal((await runGoal({ task: "x", runAgentImpl: fake([{ error: "router down" }, { error: "router down" }]) })).stopped, "failing");
  const one = await runGoal({ task: "x", runAgentImpl: fake([{ error: "hiccup" }, {}, { done: true }]) });
  assert.equal(one.stopped, "done", "a single failed round does not end it");
  assert.equal((await runGoal({ task: "x", maxRounds: 2, runAgentImpl: fake([{}]) })).stopped, "max_rounds");
  let n = 0;
  const cancelled = await runGoal({ task: "x", runAgentImpl: fake([{}]), isCancelled: () => ++n > 2 });
  assert.equal(cancelled.stopped, "cancelled");
  assert.equal(cancelled.rounds.length, 2);
});

test("blocked means the person is needed; 'what next?' is not blocked", () => {
  assert.ok(saysBlocked("I need your API key to continue."));
  assert.ok(saysBlocked("Blocked on the database password."));
  assert.ok(!saysBlocked("Done with step 2. What should I do next?"));
  assert.ok(!saysBlocked("All tests pass."));
});

const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });
const useTool = (name, args) => ({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: {} });
function scripted(script) {
  const bodies = [];
  const fn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(script[Math.min(bodies.length - 1, script.length - 1)]), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  fn.bodies = bodies;
  return fn;
}

test("in goal mode an early 'done for now' is sent back; marking the goal done ends the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-loop-"));
  const f = scripted([say("I made a start. What should I do next?"), useTool("goal_update", { summary: "finished it", evidence: "tests pass", done: true }), say("The goal is done.")]);
  const events = [];
  const result = await runAgent({ root, task: "finish the goal", goal: true, fetchImpl: f, stream: false, runs: false, memory: false, onEvent: (e) => events.push(e) });
  assert.equal(result.answer, "The goal is done.");
  assert.equal(result.goal.done, true);
  assert.ok(events.some((e) => e.type === "goal_continue"));
  assert.match(String(f.bodies[1].messages.at(-1).content), /goal is not recorded as done/);
  assert.match(readFileSync(join(root, ".goal-state.md"), "utf8"), /finished it/);
});

test("in goal mode a blocked answer may stop, and the continuation is bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-block-"));
  const blocked = scripted([say("I need your approval to delete the old table.")]);
  await runAgent({ root, task: "x", goal: true, fetchImpl: blocked, stream: false, runs: false, memory: false, onEvent: () => {} });
  assert.equal(blocked.bodies.length, 1, "not sent back");

  const root2 = mkdtempSync(join(tmpdir(), "goal-bound-"));
  const lazy = scripted([say("Done for now.")]);
  await runAgent({ root: root2, task: "x", goal: true, goalContinue: 2, fetchImpl: lazy, stream: false, runs: false, memory: false, onEvent: () => {} });
  assert.equal(lazy.bodies.length, 3, "one answer plus two continuations, then it ends");
});

test("after a compaction in goal mode, the goal and its state come back", async () => {
  const root = mkdtempSync(join(tmpdir(), "goal-compact-"));
  const replies = [useTool("goal_update", { summary: "step one done", next: "do step two" }), useTool("list_dir", { path: "." }), useTool("list_dir", { path: "." }), useTool("goal_update", { summary: "all done", done: true }), say("done")];
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const isSummary = !body.tools;
    const payload = isSummary ? say("Summary: did step one.") : replies[Math.min(bodies.filter((b) => b.tools).length - 1, replies.length - 1)];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  const events = [];
  await runAgent({ root, task: `reach the goal ${"pad ".repeat(900)}`, goal: true, memory: true, memoryFile: join(root, "m.jsonl"), contextWindow: 2500, keepLast: 2, fetchImpl, stream: false, runs: false, onEvent: (e) => events.push(e) });
  assert.ok(events.some((e) => e.type === "compaction"), "it compacted");
  assert.ok(events.some((e) => e.type === "goal_restored"));
  const afterCompaction = bodies.filter((b) => b.tools).find((b) => b.messages.some((m) => m.role === "user" && /The goal still stands/.test(String(m.content))));
  assert.ok(afterCompaction, "the restore note reached the model");
  assert.match(afterCompaction.messages.map((m) => String(m.content)).join("\n"), /step one done/);
});
