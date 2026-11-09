/**
 * The finer-grained hooks (plugins.mjs, 2026-11-03): beforeTool, afterTool, beforeCompact,
 * afterCompact, onPermission, onSubagentStart/End and onError, plus the time limit on
 * every hook call.
 *
 *   - beforeTool can refuse one call; a beforeTool that throws or hangs refuses it too
 *   - afterTool sees each result with its exit code, and its notes arrive after every
 *     tool result, so the history stays valid
 *   - afterCompact notes reach the model after a compaction
 *   - onPermission, onSubagentStart/End and onError fire where they say they do
 *   - a hook that hangs is cut off and disabled for the run
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/agent.mjs";
import { HOOK_NAMES, createHookRunner } from "../src/plugins.mjs";

const WS = mkdtempSync(join(tmpdir(), "hooks-ext-"));
writeFileSync(join(WS, "hello.txt"), "one\ntwo\n", "utf8");

const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });
const useTool = (name, args, id = "call_1") => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
  usage: {},
});
function scripted(script) {
  const bodies = [];
  const fn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const payload = script[Math.min(bodies.length - 1, script.length - 1)];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  fn.bodies = bodies;
  return fn;
}
const opts = { root: WS, onEvent: () => {}, stream: false, runs: false, memory: false, instructions: false };
const hook = (name, fn, plugin = "t") => ({ plugin, name, fn });
const toolText = (body) => body.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n");
const userText = (body) => body.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");

test("there are 14 hooks", () => {
  for (const name of ["beforeTool", "afterTool", "beforeCompact", "afterCompact", "onPermission", "onSubagentStart", "onSubagentEnd", "onError"]) assert.ok(HOOK_NAMES.includes(name), name);
  assert.equal(HOOK_NAMES.length, 14);
});

test("beforeTool can refuse one call, and the model reads why", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" }), say("ok")]);
  const seen = [];
  await runAgent({ ...opts, task: "x", fetchImpl: f, extraHooks: [hook("beforeTool", (i) => { seen.push(i.tool, i.args.path); return { deny: "no reading today" }; }, "veto")] });
  assert.deepEqual(seen, ["read_file", "hello.txt"]);
  assert.match(toolText(f.bodies[1]), /refused by veto: no reading today/);
  assert.doesNotMatch(toolText(f.bodies[1]), /one\ntwo/);
});

test("a beforeTool that throws refuses the call (fails closed)", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" }), say("ok")]);
  await runAgent({ ...opts, task: "x", fetchImpl: f, extraHooks: [hook("beforeTool", () => { throw new Error("boom"); }, "broken")] });
  assert.match(toolText(f.bodies[1]), /refused by broken: its check failed \(boom\)/);
});

test("a hook that hangs is cut off, disabled, and a hung beforeTool is a refusal", async () => {
  const logs = [];
  const runner = createHookRunner([hook("beforeTool", () => new Promise(() => {}), "slow"), hook("afterStep", () => new Promise(() => {}), "slow2")], { log: (m) => logs.push(m), timeoutMs: 50, beforeToolTimeoutMs: 50 });
  const pre = await runner.fire("beforeTool", { tool: "x" });
  assert.equal(pre.deny?.plugin, "slow");
  const after = await runner.fire("afterStep", {});
  assert.equal(after.deny, null);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /no answer within 50 ms/);
  // Disabled for the rest of the run: not called again.
  assert.equal((await runner.fire("beforeTool", { tool: "x" })).deny, null);
});

test("afterTool sees the exit code, and its note comes after every tool result", async () => {
  const f = scripted([useTool("run_command", { command: "node -e \"process.exit(3)\"" }), say("ok")]);
  const seen = [];
  await runAgent({ ...opts, task: "x", fetchImpl: f, extraHooks: [hook("afterTool", (i) => { seen.push({ tool: i.tool, exit: i.exit }); return "that command failed"; }, "watch")] });
  assert.deepEqual(seen, [{ tool: "run_command", exit: 3 }]);
  const msgs = f.bodies[1].messages;
  const toolAt = msgs.findIndex((m) => m.role === "tool");
  const noteAt = msgs.findIndex((m) => m.role === "user" && String(m.content).includes("[watch] that command failed"));
  assert.ok(toolAt > 0 && noteAt > toolAt, "the note follows the tool result");
});

test("afterCompact puts a note back in front of the model after a compaction", async () => {
  const long = "x".repeat(4000);
  const replies = [useTool("read_file", { path: "hello.txt" }, "a"), useTool("read_file", { path: "hello.txt", offset: 1 }, "b"), useTool("read_file", { path: "hello.txt", offset: 2 }, "c"), say("done")];
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    // The summary request (fast class) answers with a summary; the rest follow the script.
    const isSummary = body.messages.some((m) => m.role === "system" && /summar/i.test(String(m.content))) && !body.tools;
    const payload = isSummary ? say("Summary: read hello.txt twice.") : replies[Math.min(bodies.filter((b) => b.tools).length - 1, replies.length - 1)];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  const events = [];
  const fired = [];
  await runAgent({
    ...opts,
    memory: true,
    memoryFile: join(WS, "mem.jsonl"),
    task: `read the file ${long}`,
    contextWindow: 2000,
    keepLast: 2,
    fetchImpl,
    onEvent: (e) => events.push(e),
    extraHooks: [hook("beforeCompact", (i) => { fired.push(`before:${i.tokens > 0}`); }, "goal"), hook("afterCompact", (i) => { fired.push(`after:${i.dropped > 0}`); return "GOAL STILL: finish the task"; }, "goal")],
  });
  assert.ok(events.some((e) => e.type === "compaction"), "a compaction happened");
  // beforeCompact fires for every attempt (an early one may find nothing to drop yet);
  // afterCompact only for one that happened, and always after a beforeCompact.
  const afterAt = fired.indexOf("after:true");
  assert.ok(afterAt > 0 && fired[afterAt - 1] === "before:true", fired.join(", "));
  const after = bodies.filter((b) => b.tools).at(-1);
  assert.match(userText(after), /\[goal\] GOAL STILL: finish the task/);
});

test("onPermission hears a refusal; onSubagentStart/End frame a delegated worker; onError hears a failed run", async () => {
  const heard = [];
  const listen = ["onPermission", "onSubagentStart", "onSubagentEnd", "onError"].map((name) => hook(name, (i) => { heard.push({ name, ...("decision" in i ? { decision: i.decision } : {}), ...("task" in i && name !== "onError" ? { task: i.task } : {}) }); }));

  const f1 = scripted([useTool("write_file", { path: "a.txt", content: "a" }), say("ok")]);
  await runAgent({ ...opts, task: "x", accessMode: "read", fetchImpl: f1, extraHooks: listen });
  assert.ok(heard.some((h) => h.name === "onPermission" && h.decision === "deny"));

  heard.length = 0;
  const f2 = scripted([useTool("delegate", { task: "count to two" }), say("worker says two"), say("done")]);
  await runAgent({ ...opts, task: "x", fetchImpl: f2, extraHooks: listen });
  assert.deepEqual(heard.filter((h) => h.name.startsWith("onSubagent")).map((h) => h.name), ["onSubagentStart", "onSubagentEnd"]);
  assert.equal(heard[0].task, "count to two");

  heard.length = 0;
  await runAgent({ ...opts, task: "x", fetchImpl: async () => { throw new TypeError("fetch failed"); }, reconnectBudgetMs: 0, extraHooks: listen });
  assert.ok(heard.some((h) => h.name === "onError"));
});
