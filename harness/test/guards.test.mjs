// The loop hooks, and the four behavioural plugins that ship with the harness.
//
// The router is stubbed and scripted, so every claim here is about real loop
// behaviour - what the model was sent, when the run stopped, what the history
// looked like - rather than about a plugin merely loading.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/agent.mjs";
import { releaseMessageSink, setMessageSink } from "../src/message-log.mjs";
import { HOOK_NAMES, createHookRunner, loadPlugins, pluginRoot } from "../src/plugins.mjs";
import { judge, opening } from "../plugins/rosa-finish-loop-guard/plugin.mjs";
import { normalizePin, isTarget } from "../plugins/rosa-model-pin/plugin.mjs";
import { describeLeftovers, findLeftovers, mergeLedger, parsePs, parseSnapshot } from "../plugins/rosa-process-tracker/plugin.mjs";
import { normalizeTodos, renderList } from "../plugins/rosa-todo-guard/plugin.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-guards-"));
writeFileSync(join(WS, "hello.txt"), "one\ntwo\n", "utf8");

const say = (content) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

function toolReply({ content = "", name, args = {}, id = "call_1" }) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: {},
  };
}

const useTool = (name, args, id = "call_1") => toolReply({ name, args, id });

/** Replies in order, repeating the last entry when the script runs out. */
function scripted(script) {
  const bodies = [];
  const fn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const entry = script[Math.min(bodies.length - 1, script.length - 1)];
    const payload = typeof entry === "function" ? await entry(bodies[bodies.length - 1]) : entry;
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/test-model" },
    });
  };
  fn.bodies = bodies;
  return fn;
}

const base = { root: WS, onEvent: () => {} };
/** The real shipped host, with the process tracker kept out of the test's home. */
const NO_TRACKER = { plugins: { "rosa-process-tracker": { enabled: false } } };

// ---------------------------------------------------------------- the runner

test("a hook may return a bare string, which is read as a note", async () => {
  const runner = createHookRunner([{ plugin: "a", name: "beforeStep", fn: () => "look at the plan" }]);
  const { notes, stop } = await runner.fire("beforeStep", {});
  assert.deepEqual(notes, [{ plugin: "a", note: "look at the plan" }]);
  assert.equal(stop, null);
});

test("the first stop wins, and every note is still collected", async () => {
  const runner = createHookRunner([
    { plugin: "first", name: "beforeStep", fn: () => ({ note: "one", stop: "first reason" }) },
    { plugin: "second", name: "beforeStep", fn: () => ({ note: "two", stop: "second reason" }) },
  ]);
  const { notes, stop } = await runner.fire("beforeStep", {});
  assert.equal(stop.plugin, "first");
  assert.equal(stop.reason, "first reason");
  assert.deepEqual(notes.map((n) => n.plugin), ["first", "second"]);
});

test("a hook that throws is disabled for the rest of the run and reported once", async () => {
  const logged = [];
  let thrown = 0;
  const runner = createHookRunner(
    [
      {
        plugin: "broken",
        name: "beforeStep",
        fn: () => {
          thrown += 1;
          throw new Error("boom");
        },
      },
      { plugin: "fine", name: "beforeStep", fn: () => "still here" },
    ],
    { log: (m) => logged.push(m) },
  );
  const first = await runner.fire("beforeStep", {});
  const second = await runner.fire("beforeStep", {});
  assert.equal(thrown, 1, "a broken hook must not be called again in the same run");
  assert.equal(logged.length, 1);
  assert.match(logged[0], /broken: beforeStep\(\) threw/);
  assert.deepEqual(first.notes, [{ plugin: "fine", note: "still here" }]);
  assert.deepEqual(second.notes, [{ plugin: "fine", note: "still here" }]);
});

test("a nonsense return value is ignored with a log, never a crash", async () => {
  const logged = [];
  const runner = createHookRunner(
    [
      { plugin: "odd", name: "beforeStep", fn: () => 42 },
      { plugin: "empty", name: "beforeStep", fn: () => ({ note: "   " }) },
    ],
    { log: (m) => logged.push(m) },
  );
  const { notes } = await runner.fire("beforeStep", {});
  assert.deepEqual(notes, []);
  assert.match(logged[0], /returned number/);
});

test("model and retry advice is carried through, and malformed advice is refused", async () => {
  const runner = createHookRunner([
    { plugin: "p", name: "beforeStep", fn: () => ({ model: "local/qwen3.8-27b", retry: { maxAttempts: 2 } }) },
    { plugin: "q", name: "beforeStep", fn: () => ({ model: "other/model", retry: { maxAttempts: 9 } }) },
  ]);
  const advice = await runner.fire("beforeStep", {});
  assert.equal(advice.model, "local/qwen3.8-27b", "the first model advice wins");
  assert.equal(advice.retry.maxAttempts, 2, "the first retry advice wins");

  const junk = createHookRunner([{ plugin: "j", name: "beforeStep", fn: () => ({ model: 7, retry: "soon" }) }]);
  const out = await junk.fire("beforeStep", {});
  assert.equal(out.model, undefined);
  assert.equal(out.retry, undefined);
});

test("hooks only fire for their own phase", async () => {
  const calls = [];
  const runner = createHookRunner([
    { plugin: "p", name: "afterStep", fn: () => calls.push("after") },
    { plugin: "p", name: "onRunEnd", fn: () => calls.push("end") },
  ]);
  await runner.fire("beforeStep", {});
  await runner.fire("afterStep", {});
  assert.deepEqual(calls, ["after"]);
  assert.deepEqual(runner.names, ["afterStep", "onRunEnd"]);
});

test("two plugins can use the same state key without reading each other's values", async () => {
  const runner = createHookRunner([
    {
      plugin: "a",
      name: "beforeStep",
      fn: (info) => {
        info.run.state.set("k", "from-a");
      },
    },
    { plugin: "b", name: "beforeStep", fn: (info) => `b saw ${info.run.state.get("k")}` },
    { plugin: "a", name: "afterStep", fn: (info) => `a stored ${info.run.state.get("k")}` },
  ]);
  const run = { id: "r", state: new Map() };
  const first = await runner.fire("beforeStep", { run });
  assert.deepEqual(first.notes, [{ plugin: "b", note: "b saw undefined" }]);
  const later = await runner.fire("afterStep", { run });
  assert.deepEqual(later.notes, [{ plugin: "a", note: "a stored from-a" }], "a plugin keeps its own state across steps");
  assert.deepEqual([...run.state.keys()], ["a\0k"], "the run's map holds only namespaced keys");
});

// ------------------------------------------------------------- the loop itself

test("a hook's note reaches the model before its next call", async () => {
  const noter = { plugin: "noter", name: "beforeStep", fn: (info) => (info.step === 2 ? "PLAN CHECK: say the word" : undefined) };
  const f = scripted([useTool("read_file", { path: "hello.txt" }), say("ok")]);
  const events = [];
  const result = await runAgent({ ...base, task: "x", fetchImpl: f, extraHooks: [noter], onEvent: (e) => events.push(e) });

  assert.equal(result.answer, "ok");
  assert.equal(f.bodies.length, 2);
  const second = f.bodies[1].messages;
  assert.ok(
    second.some((m) => m.role === "user" && String(m.content).includes("[noter] PLAN CHECK")),
    "the note must arrive as a user message",
  );
  assert.equal(f.bodies[0].messages.some((m) => String(m.content).includes("PLAN CHECK")), false, "and not one step early");
  const notice = events.find((e) => e.type === "notice");
  assert.deepEqual(notice.from, ["noter"]);
  assert.equal(notice.step, 2);
});

test("a hook can end the run, and the loop reports it as the guard that did it", async () => {
  const stopper = { plugin: "stopper", name: "beforeStep", fn: (info) => (info.step >= 3 ? { stop: "enough data" } : undefined) };
  const f = scripted([useTool("read_file", { path: "hello.txt" })]);
  const events = [];
  const result = await runAgent({ ...base, task: "x", fetchImpl: f, extraHooks: [stopper], onEvent: (e) => events.push(e), maxSteps: 12 });

  assert.equal(result.stopped, "guard:stopper");
  assert.equal(result.plugin, "stopper");
  assert.equal(result.reason, "enough data");
  assert.equal(result.steps, 3);
  assert.equal(f.bodies.length, 2, "the step the guard refused never reached the model");
  assert.ok(events.some((e) => e.type === "stopped" && e.reason === "guard" && e.plugin === "stopper"));
});

test("the history a guard sees is always valid: every tool call has its answer", async () => {
  const seen = [];
  const collector = {
    plugin: "collector",
    name: "afterStep",
    fn: (info) => {
      seen.push(info);
      return info.step >= 2 ? { stop: "collected" } : undefined;
    },
  };
  const f = scripted([useTool("read_file", { path: "hello.txt" })]);
  const result = await runAgent({ ...base, task: "x", fetchImpl: f, extraHooks: [collector], maxSteps: 9 });

  assert.equal(result.stopped, "guard:collector");
  const answered = new Set(result.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const m of result.messages) {
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const call of m.tool_calls) assert.ok(answered.has(call.id), `tool call ${call.id} lost its answer`);
  }
  assert.equal(seen.length, 2);
  assert.deepEqual(
    Object.keys(seen[0]).sort(),
    ["cls", "content", "depth", "messages", "root", "router", "run", "step", "target", "task", "toolCallKeys", "toolCalls", "toolNames", "toolResults", "toolResultsOk", "tools"],
  );
  assert.match(seen[0].toolCallKeys[0], /^read_file\(\{"path":"hello\.txt"\}\)$/);
  assert.equal(seen[0].toolResultsOk, true);
  // One per call, in call order: a command's exit code is what "the tests passed" means.
  assert.deepEqual(seen[0].toolResults, [{ name: "read_file", ok: true, exit: null }]);
  assert.equal(seen[0].run.depth, 0);
});

test("retry advice re-runs the failed step on the same target, then succeeds", async () => {
  const bodies = [];
  let n = 0;
  const f = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    n += 1;
    if (n < 3) return new Response("upstream is unwell", { status: 503 });
    return new Response(JSON.stringify(say("recovered")), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/qwen3.8-27b" },
    });
  };
  const retrier = {
    plugin: "retrier",
    name: "beforeStep",
    fn: () => ({ model: "local/qwen3.8-27b", retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }),
  };
  const events = [];
  // The early-build tracking sees both failed attempts even though the run recovered.
  const errors = [];
  const sink = (line) => {
    if (line.kind === "model_error") errors.push(line);
  };
  setMessageSink(sink);
  let result;
  try {
    result = await runAgent({ ...base, task: "x", fetchImpl: f, extraHooks: [retrier], onEvent: (e) => events.push(e) });
  } finally {
    releaseMessageSink(sink);
  }

  assert.equal(result.answer, "recovered");
  assert.equal(n, 3);
  assert.ok(bodies.every((b) => b.model === "local/qwen3.8-27b"), "every attempt named the pin");
  assert.ok(events.some((e) => e.type === "retry" && e.attempt === 1 && e.of === 3 && e.model === "local/qwen3.8-27b"));
  assert.ok(events.some((e) => e.type === "retry_ok" && e.attempt === 3));
  assert.deepEqual(errors.map((e) => e.attempt), [1, 2]);
  assert.equal(errors[0].target, "local/qwen3.8-27b");
  assert.equal(errors[0].cloud, false);
  assert.equal("prompt" in errors[0], false);
});

test("when the retry budget is spent the run fails on that target instead of falling back", async () => {
  let n = 0;
  const f = async () => {
    n += 1;
    return new Response("no target answered", { status: 503 });
  };
  const retrier = {
    plugin: "retrier",
    name: "beforeStep",
    fn: () => ({ retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } }),
  };
  const result = await runAgent({ ...base, task: "x", fetchImpl: f, extraHooks: [retrier] });
  assert.equal(n, 2);
  assert.equal(result.stopped, "router_error");
  assert.match(result.error, /503/);
});

test("onRunEnd fires exactly once, on every way out of the loop", async () => {
  const ends = [];
  const watcher = { plugin: "w", name: "onRunEnd", fn: (info) => ends.push(info.stopped) };
  const started = [];
  const opener = { plugin: "w", name: "onRunStart", fn: (info) => started.push(info.run.id) };

  await runAgent({ ...base, task: "x", fetchImpl: scripted([say("hi")]), extraHooks: [watcher, opener] });
  await runAgent({
    ...base,
    task: "x",
    fetchImpl: scripted([useTool("read_file", { path: "hello.txt" })]),
    extraHooks: [watcher, opener],
    maxSteps: 2,
  });
  await runAgent({ ...base, task: "x", fetchImpl: async () => new Response("dead", { status: 500 }), extraHooks: [watcher, opener] });

  assert.deepEqual(ends, [undefined, "max_steps", "router_error"]);
  assert.equal(started.length, 3);
  assert.equal(new Set(started).size, 3, "every run gets its own token");
});

// ------------------------------------------------------------ shipped plugins

test("every bundled plugin loads clean, and says that it is bundled", async () => {
  const host = await loadPlugins({ root: WS });
  assert.deepEqual(host.errors, [], `unexpected plugin errors: ${JSON.stringify(host.errors)}`);

  // The set is discovered, not declared: every folder with a manifest, plus a bare
  // .mjs, is a module that ships. A folder that fails to load is missing from
  // `host.plugins` and shows up in this comparison by name.
  const dir = pluginRoot();
  const shipped = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".mjs") || (entry.isDirectory() && existsSync(join(dir, entry.name, "plugin.json"))))
    .map((entry) => entry.name.replace(/\.mjs$/, ""))
    .sort();
  assert.deepEqual(host.plugins.map((p) => p.id).sort(), shipped);

  for (const p of host.plugins) assert.equal(p.bundled, true, `${p.id} should be marked bundled`);

  // Every hook a plugin registers must be one the loop actually fires, and the four
  // behavioural points must have at least one subscriber or they are dead seams.
  const names = [...new Set(host.hooks.map((h) => h.name))];
  for (const name of names) assert.ok(HOOK_NAMES.includes(name), `registered an unknown hook name: ${name}`);
  for (const required of ["onRunStart", "beforeStep", "afterStep", "onRunEnd"]) {
    assert.ok(names.includes(required), `${required} must be registered by a shipped plugin`);
  }

  assert.match(host.describe(), /process-tracker\s+v0\.1\.1\s+1 tool, 3 hooks/);
  assert.match(host.describe(), /bundled/);
});

test("an unknown hook name is refused at load and reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-hooks-"));
  mkdirSync(join(dir, "weird"), { recursive: true });
  writeFileSync(join(dir, "weird", "plugin.json"), JSON.stringify({ id: "weird" }), "utf8");
  writeFileSync(
    join(dir, "weird", "plugin.mjs"),
    `export default { id: "weird", hooks: () => ({ onTurn: () => {}, beforeStep: () => "ok", afterStep: 3 }) };`,
    "utf8",
  );
  const host = await loadPlugins({ dir, root: WS });
  assert.equal(host.plugins.length, 1);
  assert.deepEqual(host.plugins[0].hooks, ["beforeStep"]);
  assert.equal(host.hooks.length, 1);
  assert.equal(host.errors.length, 2);
  assert.match(host.errors[0].reason, /does not call that hook/);
  assert.match(host.errors[1].reason, /not a function/);
});

// --------------------------------------------------------- finish-loop-guard

test("the loop judge trips on repetition, on a done-streak, and on a repeated call", () => {
  const s = (o, done = false, keys = []) => ({ opening: o, done, toolKeys: keys });

  assert.equal(judge([s("a"), s("a")], { textRepeats: 3 }).loop, false, "two is not a loop");
  const repeated = judge([s("a"), s("a"), s("a")], { textRepeats: 3 });
  assert.equal(repeated.loop, true);
  assert.match(repeated.why, /same message 3 times in a row/);

  const done = judge([s("a", true), s("b", true), s("c", true)], { doneStreak: 3 });
  assert.equal(done.loop, true);
  assert.match(done.why, /3 steps in a row announcing the work is finished/);

  const sameTool = judge([s("a", false, ["f(1)"]), s("b", false, ["f(1)"]), s("c", false, ["f(1)"])], { sameToolRepeats: 3 });
  assert.equal(sameTool.loop, true);
  assert.match(sameTool.why, /same tool call 3 times in a row/);

  assert.equal(judge([s("a"), s("b"), s("c")]).loop, false, "distinct steps are not a loop");
  assert.equal(judge([]).loop, false);
  assert.equal(opening("  Hello, WORLD!!  again "), "hello world again");
});

test("the finish guard warns once, then ends the run, against a real looping model", async () => {
  const host = await loadPlugins({ root: WS, config: NO_TRACKER });
  // Distinct words each step, all claiming completion - the way a model actually
  // loops (it rephrases), and the case the text-repeat signal cannot catch.
  const f = scripted([
    toolReply({ content: "All done with the first pass.", name: "read_file", args: { path: "hello.txt" } }),
    toolReply({ content: "The work is complete now.", name: "read_file", args: { path: "hello.txt" } }),
    toolReply({ content: "Everything is finished.", name: "read_file", args: { path: "hello.txt" } }),
  ]);
  const events = [];
  const result = await runAgent({
    ...base,
    task: "x",
    fetchImpl: f,
    extraTools: host.tools,
    extraHooks: host.hooks,
    maxSteps: 12,
    onEvent: (e) => events.push(e),
  });

  const notice = events.find((e) => e.type === "notice" && e.from.includes("rosa-finish-loop-guard"));
  assert.ok(notice, "the model should have been warned");
  assert.match(notice.text, /announcing the work is finished/);
  assert.equal(result.stopped, "guard:rosa-finish-loop-guard");
  assert.equal(result.steps, 4, "one warning, then the run ends");
  assert.equal(f.bodies.length, 4, "the loop stopped at 4 of 12 allowed steps");
});

// ----------------------------------------------------------------- todo-guard

test("todo_write and todo_read hold one list, and refuse items with no content", async () => {
  const { items, dropped } = normalizeTodos([
    { content: "read the code", status: "in_progress" },
    { content: "  ", status: "pending" },
    { content: "ship it", status: "nonsense" },
    "a bare string is a task",
  ]);
  assert.equal(dropped.length, 1);
  assert.deepEqual(
    items.map((t) => [t.content, t.status]),
    [
      ["read the code", "in_progress"],
      ["ship it", "pending"],
      ["a bare string is a task", "pending"],
    ],
  );
  assert.equal(renderList(items), "[~] read the code; [ ] ship it; [ ] a bare string is a task");
  assert.equal(renderList([]), "(the list is empty)");
});

test("the todo guard nudges when the list goes stale with work still open", async () => {
  const host = await loadPlugins({
    root: WS,
    config: { plugins: { "rosa-process-tracker": { enabled: false }, "rosa-todo-guard": { config: { every: 2, cooldown: 0 } } } },
  });
  const f = scripted([
    useTool("todo_write", { todos: [{ content: "step A", status: "pending" }] }, "c1"),
    useTool("read_file", { path: "hello.txt" }, "c2"),
    useTool("read_file", { path: "hello.txt" }, "c3"),
    say("done"),
  ]);
  const events = [];
  await runAgent({
    ...base,
    task: "x",
    fetchImpl: f,
    extraTools: host.tools,
    extraHooks: host.hooks,
    onEvent: (e) => events.push(e),
  });

  const notices = events.filter((e) => e.type === "notice" && e.from.includes("rosa-todo-guard"));
  const stale = notices.filter((n) => /steps without updating the task list/.test(n.text));
  assert.equal(stale.length, 1, "exactly one stale nudge, not one per step");
  assert.match(stale[0].text, /2 steps without updating the task list/);
  assert.match(stale[0].text, /step A/);
  // And the "done" answer is not the end while that item is open: it is sent back with
  // the list (2026-11-06: a nine-item plan ended at 1/9).
  assert.ok(
    notices.some((n) => /still has 1 unfinished item/.test(n.text)),
    "the final answer with the item still open should be sent back",
  );
  // and the tool really is the model's to call
  const written = f.bodies[0].tools.find((t) => t.function?.name === "todo_write" || t.name === "todo_write");
  assert.ok(written, "todo_write should be offered to the model");
});

test("the todo guard stays silent when every item is complete", async () => {
  const host = await loadPlugins({
    root: WS,
    config: { plugins: { "rosa-process-tracker": { enabled: false }, "rosa-todo-guard": { config: { every: 2, cooldown: 0 } } } },
  });
  const f = scripted([
    useTool("todo_write", { todos: [{ content: "step A", status: "completed" }] }, "c1"),
    useTool("read_file", { path: "hello.txt" }, "c2"),
    useTool("read_file", { path: "hello.txt" }, "c3"),
    say("done"),
  ]);
  const events = [];
  await runAgent({ ...base, task: "x", fetchImpl: f, extraTools: host.tools, extraHooks: host.hooks, onEvent: (e) => events.push(e) });
  assert.equal(events.filter((e) => e.type === "notice" && e.from.includes("rosa-todo-guard")).length, 0);
  // the list is per session, not per run: the second run sees what the first left
  assert.match(await host.commands.get("rosa-todo-guard:show")(), /\[x\] step A/);
});

// ------------------------------------------------------------ process-tracker

test("findLeftovers reports only what nothing living owns", () => {
  const before = [{ pid: 1, ppid: 0, name: "explorer.exe", start: "", cmd: "" }];
  const after = [
    { pid: 1, ppid: 0, name: "explorer.exe", start: "", cmd: "" },
    { pid: 10, ppid: 1, name: "user-app.exe", start: "s", cmd: "the user opened this" },
    { pid: 20, ppid: 999, name: "node.exe", start: "s", cmd: "orphaned server" },
    { pid: 30, ppid: 0, name: "node.exe", start: "s", cmd: "no parent at all" },
    // 0.1.1: a live child of the harness belongs to the harness. Between steps the
    // only live children are plugin-managed (llama-server from local-model-host, MCP
    // servers); reporting them told the model to Stop-Process its own model server.
    { pid: 40, ppid: 777, name: "node.exe", start: "s", cmd: "still a live child of the harness" },
  ];
  const out = findLeftovers(before, after, { selfPid: 777 });
  assert.deepEqual(out.map((p) => p.pid), [20, 30]);
  assert.equal(findLeftovers(after, after, { selfPid: 777 }).length, 0, "nothing new, nothing reported");
  // an ignored name is never reported, however orphaned it looks
  assert.deepEqual(findLeftovers(before, after, { selfPid: 777, ignore: ["node.exe"] }).map((p) => p.pid), []);
});

test("app helpers, desktop apps and ContentFarm are never leftovers; orphans are", () => {
  const T = (m) => new Date(Date.parse("2026-10-21T20:00:00Z") + m * 60000).toISOString();
  const before = [{ pid: 4, ppid: 0, name: "brave.exe", start: T(-500), cmd: "brave.exe" }];
  const after = [
    ...before,
    { pid: 5, ppid: 4, name: "brave.exe", start: T(1), cmd: "brave.exe --type=renderer" }, // helper of a living app
    { pid: 6, ppid: 4, name: "python.exe", start: T(2), cmd: "python helper.py" }, // child of a living non-harness app
    { pid: 7, ppid: 9001, name: "Spotify.exe", start: T(3), cmd: "Spotify.exe" }, // orphaned desktop app
    { pid: 8, ppid: 9002, name: "python.exe", start: T(4), cmd: '"D:\\ComfyUI\\media-tts\\.venv\\Scripts\\python.exe" D:\\ComfyUI\\media-tts\\server.py' },
    { pid: 9, ppid: 9003, name: "node.exe", start: T(5), cmd: "node server.js" }, // true orphan: REPORTED
    { pid: 11, ppid: 12, name: "node.exe", start: T(6), cmd: "parent pid recycled" },
    { pid: 12, ppid: 4, name: "svc.exe", start: T(30), cmd: "newer process holding the old parent pid" },
  ];
  assert.deepEqual(findLeftovers(before, after, { selfPid: 777 }).map((p) => p.pid), [9, 11]);
  assert.deepEqual(findLeftovers(before, after, { selfPid: 777, excludePatterns: [/server\.js/] }).map((p) => p.pid), [11]);
});

test("the ledger drops entries recorded under the old rules", () => {
  const now = "2026-10-21T20:00:00.000Z";
  const ledger = {
    entries: [
      { pid: 5, name: "brave.exe", start: "a", cmd: "brave", ended: false },
      { pid: 6, name: "python.exe", start: "b", cmd: "python helper.py", ended: false },
      { pid: 7, name: "node.exe", start: "c", cmd: "node server.js", ended: false },
      { pid: 8, name: "Spotify.exe", start: "d", cmd: "Spotify.exe", ended: false, keep: true },
    ],
  };
  const snap = [
    { pid: 1, ppid: 0, name: "app.exe", start: "", cmd: "" },
    { pid: 5, ppid: 1, name: "brave.exe", start: "a", cmd: "brave" },
    { pid: 6, ppid: 1, name: "python.exe", start: "b", cmd: "python helper.py" },
    { pid: 7, ppid: 999, name: "node.exe", start: "c", cmd: "node server.js" },
    { pid: 8, ppid: 999, name: "Spotify.exe", start: "d", cmd: "Spotify.exe" },
  ];
  const live = new Set(snap.map((p) => `${p.pid}:${p.start}`));
  const out = mergeLedger(ledger, { live, now, snapshot: snap });
  assert.deepEqual(out.entries.map((e) => e.pid).sort(), [7, 8], "app gone, owned helper gone, orphan and kept entry stay");
  assert.ok(mergeLedger({ entries: [] }, { discovered: [{ pid: 1, name: "n.exe", start: "s", cmd: "x".repeat(500) }], live: new Set(["1:s"]), now }).entries[0].cmd.length <= 240);
});

test("a snapshot parses as one object or as an array, and survives being empty", () => {
  assert.deepEqual(parseSnapshot(""), []);
  const one = parseSnapshot(JSON.stringify({ pid: 5, ppid: 1, name: "a.exe", start: "s", cmd: "run" }));
  assert.deepEqual(one, [{ pid: 5, ppid: 1, name: "a.exe", start: "s", cmd: "run" }]);
  const many = parseSnapshot(JSON.stringify([{ pid: 5, name: "a.exe" }, { pid: 0, name: "bad" }, { name: "no pid" }]));
  assert.deepEqual(many, [{ pid: 5, ppid: 0, name: "a.exe", start: "", cmd: "" }], "a row with no usable pid is dropped");
  const ps = parsePs("  5     1 node      node server.mjs\n  6     5 pwsh      pwsh -File x.ps1\n");
  assert.deepEqual(ps.map((p) => [p.pid, p.ppid, p.name]), [[5, 1, "node"], [6, 5, "pwsh"]]);
});

test("the ledger marks what exited, prunes the old, and stays bounded", () => {
  const t1 = "2026-10-19T10:00:00.000Z";
  const l1 = mergeLedger(
    { entries: [] },
    { discovered: [{ pid: 5, name: "n.exe", start: "s", cmd: "x" }], live: new Set(["5:s"]), runId: "r1", now: t1 },
  );
  assert.equal(l1.entries.length, 1);
  assert.equal(l1.entries[0].ended, false);
  assert.equal(l1.entries[0].runId, "r1");

  const t2 = "2026-10-19T11:00:00.000Z";
  const l2 = mergeLedger(l1, { discovered: [], live: new Set(), now: t2 });
  assert.equal(l2.entries[0].ended, true);
  assert.equal(l2.entries[0].endedAt, t2);

  const seenAgain = mergeLedger(l2, { discovered: [], live: new Set(["5:s"]), now: t2 });
  assert.equal(seenAgain.entries[0].ended, false, "a process that came back is running again");

  const pruned = mergeLedger(l2, { discovered: [], live: new Set(), now: "2026-10-27T11:00:00.000Z", keepDays: 7 });
  assert.equal(pruned.entries.length, 0);

  const many = mergeLedger(
    { entries: [] },
    {
      discovered: Array.from({ length: 10 }, (_, i) => ({ pid: 100 + i, name: "n.exe", start: "s", cmd: "" })),
      live: new Set(Array.from({ length: 10 }, (_, i) => `${100 + i}:s`)),
      maxEntries: 3,
      now: t1,
    },
  );
  assert.equal(many.entries.length, 3);
  assert.equal(describeLeftovers(many.entries).split("\n").length, 3);
});

test("the process tracker takes a real snapshot and writes only the ledger it was given", async () => {
  const ledgerFile = join(WS, "ledger.json");
  const { default: tracker } = await import("../plugins/rosa-process-tracker/plugin.mjs");
  const ctx = { config: { ledgerFile, sweepEveryMs: 0, keepDays: 7, maxEntries: 50, ignore: [] }, log: () => {} };

  const empty = await tracker.tools({ config: { ledgerFile: join(WS, "nothing-here.json") } })[0].run({});
  assert.equal(empty, "no leftover processes are recorded as running");

  const hooks = tracker.hooks(ctx);
  const run = { id: "test-run", state: new Map() };
  // The baseline is taken in the background (a promise), so a run starts without waiting
  // for PowerShell; and the final sweep writes the ledger after the run has ended.
  await hooks.onRunStart({ run, depth: 0 });
  assert.ok((await run.state.get("base")).length > 0, "the snapshot should see this machine's processes");
  await hooks.onRunEnd({ run, depth: 0, stopped: "answer" });
  for (let i = 0; i < 300 && !existsSync(ledgerFile); i += 1) await new Promise((done) => setTimeout(done, 100));

  const ledger = JSON.parse(readFileSync(ledgerFile, "utf8"));
  assert.ok(Array.isArray(ledger.entries), "the ledger is a list of entries");
  assert.equal(ledger.version, 1);
  for (const e of ledger.entries) assert.ok(Number.isInteger(e.pid) && typeof e.name === "string");
});

// ----------------------------------------------------------------- model-pin

test("a pin is a class or a provider/model target, and nothing with a space in it", () => {
  assert.equal(normalizePin("local/qwen3.8-27b"), "local/qwen3.8-27b");
  assert.equal(normalizePin("  code  "), "code");
  assert.equal(normalizePin(""), null);
  assert.equal(normalizePin(null), null);
  assert.equal(normalizePin("local/qwen 3.8"), null);
  assert.equal(isTarget("local/qwen3.8-27b"), true);
  assert.equal(isTarget("orchestrate"), false);
});

test("the pin applies to the orchestrator by default, and to every run when asked", async () => {
  const { default: pin } = await import("../plugins/rosa-model-pin/plugin.mjs");
  const run = { id: "r", state: new Map() };

  const root = pin.hooks({ config: { pin: "local/qwen3.8-27b", depth: "root", maxAttempts: 2, backoff: {} }, log: () => {} });
  await root.onRunStart({ run, depth: 0 });
  assert.equal(await root.beforeStep({ run, depth: 1 }), undefined, "a delegated worker keeps its own class");
  const advised = await root.beforeStep({ run, depth: 0 });
  assert.equal(advised.model, "local/qwen3.8-27b");
  assert.equal(advised.retry.maxAttempts, 2);

  const all = pin.hooks({ config: { pin: "code", depth: "all" }, log: () => {} });
  await all.onRunStart({ run, depth: 0 });
  assert.equal((await all.beforeStep({ run, depth: 1 })).model, "code");

  // A fresh run token per instance: these are direct calls, so the runner's
  // per-plugin state isolation is not in play (it is covered in its own test).
  const off = pin.hooks({ config: {}, log: () => {} });
  const clean = { id: "clean", state: new Map() };
  await off.onRunStart({ run: clean, depth: 0 });
  assert.equal(await off.beforeStep({ run: clean, depth: 0 }), undefined, "no pin, no interference");
  assert.match(pin.status({ config: {} }), /no pin/);
});

test("a pinned run names the target on every request, and retries it instead of drifting", async () => {
  const host = await loadPlugins({
    root: WS,
    config: {
      plugins: {
        "rosa-process-tracker": { enabled: false },
        "rosa-model-pin": {
          config: { pin: "local/qwen3.8-27b", maxAttempts: 2, backoff: { initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } },
        },
      },
    },
  });
  const bodies = [];
  let n = 0;
  const f = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    n += 1;
    if (n === 1) return new Response("slot busy", { status: 503 });
    return new Response(JSON.stringify(say("pinned ok")), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/qwen3.8-27b" },
    });
  };

  const result = await runAgent({ ...base, task: "x", fetchImpl: f, extraTools: host.tools, extraHooks: host.hooks });
  assert.equal(result.answer, "pinned ok");
  assert.equal(bodies.length, 2, "the failed step was retried rather than handed to another model");
  assert.ok(bodies.every((b) => b.model === "local/qwen3.8-27b"), "the class was replaced by the pin");
  assert.match(host.describe(), /pinned to local\/qwen3\.8-27b/);
});

test("onRunEnd sees the same run object as onRunStart, with its state", async () => {
  const seen = {};
  const starter = { plugin: "keeper", name: "onRunStart", fn: ({ run }) => run.state.set("base", "kept") };
  const ender = {
    plugin: "keeper",
    name: "onRunEnd",
    fn: ({ run }) => {
      seen.type = typeof run;
      seen.base = run.state?.get("base");
      seen.id = run.id;
    },
  };
  const events = [];
  const result = await runAgent({ ...base, task: "x", fetchImpl: scripted([say("hi")]), extraHooks: [starter, ender], onEvent: (e) => events.push(e) });
  assert.equal(seen.type, "object", "run must be the run object, not its id string");
  assert.equal(seen.base, "kept", "state written at the start is readable at the end");
  assert.equal(seen.id, result.run);
  assert.ok(!events.some((e) => e.type === "hook" && /threw/.test(e.message ?? "")), "no hook threw");
});