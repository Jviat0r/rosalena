/**
 * The watchdog: three ways a long-horizon run goes wrong without ever failing.
 *
 *   1. A step that never returns - proven against the real runAgent loop with a
 *      fetch that hangs and a small step deadline. The run fails loudly with a
 *      router error, and the event log shows exactly two watchdog firings
 *      (the step's spare attempt included).
 *   2. A tool that never returns - proven with a hanging extra tool. The call is
 *      ANSWERED with a timeout result so the `tool_call_id` never dangles, and
 *      the run moves on to the next model step.
 *   3. A run that keeps succeeding at the same thing - proven two ways: the pure
 *      detector (repeats, resets on progress, never fires at limit 0) and one
 *      live run with `repeatLimit: 3` explicitly enabled. The detector is off by
 *      default on purpose: loop policy belongs to the bundled finish-loop-guard
 *      plugin (nudge first, then stop), and this coarse core version would stop
 *      the run before the plugin had said a word.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import {
  DEFAULT_REPEAT_LIMIT,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  TimeoutError,
  abortAfter,
  callKey,
  deadlines,
  makeStallDetector,
  stepSignature,
  withTimeout,
} from "../src/watchdog.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-watchdog-"));
writeFileSync(join(WS, "hello.txt"), "line one\nline two\n", "utf8");

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
    if (entry instanceof Response) return entry;
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/test-model" },
    });
  };
  fn.calls = calls;
  return fn;
}

/** The call the model "makes" in a unit test, shaped like the router's. */
const call = (name, arguments_ = "") => [{ function: { name, arguments: arguments_ } }];

// ---------------------------------------------------------------- defaults

test("watchdog defaults: the clocks are generous, the stall detector is off", () => {
  assert.equal(DEFAULT_STEP_TIMEOUT_MS, 300_000); // the local reasoning model can sit ~200 s thinking
  assert.equal(DEFAULT_TOOL_TIMEOUT_MS, 300_000); // five minutes: a whole-tree search or a test suite, not a file read
  assert.equal(DEFAULT_REPEAT_LIMIT, 0); // loop policy is the finish-loop-guard plugin's job by default
});

test("deadlines(): unset values fall back, an explicit 0 means off, garbage and negatives are safe", () => {
  assert.deepEqual(deadlines(), { stepTimeoutMs: 300_000, toolTimeoutMs: 300_000, repeatLimit: 0 });
  assert.deepEqual(deadlines({ stepTimeoutMs: 0, toolTimeoutMs: 0, repeatLimit: 0 }), {
    stepTimeoutMs: 0,
    toolTimeoutMs: 0,
    repeatLimit: 0,
  });
  assert.deepEqual(deadlines({ stepTimeoutMs: "soon", toolTimeoutMs: NaN, repeatLimit: Number.POSITIVE_INFINITY }), {
    stepTimeoutMs: 300_000,
    toolTimeoutMs: 300_000,
    repeatLimit: 0,
  });
  assert.deepEqual(deadlines({ stepTimeoutMs: -5 }), { stepTimeoutMs: 0, toolTimeoutMs: 300_000, repeatLimit: 0 });
  assert.deepEqual(deadlines({ stepTimeoutMs: 1234.9, repeatLimit: 2.9 }), {
    stepTimeoutMs: 1234,
    toolTimeoutMs: 300_000,
    repeatLimit: 2,
  });
});

// ---------------------------------------------------------------- abortAfter

test("abortAfter: fires at the deadline and says so", async () => {
  let fired = 0;
  const { signal, timedOut, cancel } = abortAfter(30, { onFire: () => fired += 1 });
  assert.ok(signal);
  assert.equal(timedOut(), false);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(signal.aborted, true);
  assert.equal(timedOut(), true);
  assert.equal(fired, 1);
  cancel(); // a no-op once it has fired; must not throw
});

test("abortAfter: a bare callback is honoured, not silently dropped", async () => {
  // A callback passed as the second argument instead of `{onFire}` was silently
  // ignored, so the step-timeout event never reached the log. It must fire.
  let fired = 0;
  abortAfter(25, () => fired += 1);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(fired, 1);
});

test("abortAfter: cancel stops it before it fires", async () => {
  const { signal, timedOut, cancel } = abortAfter(40);
  cancel();
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(signal.aborted, false);
  assert.equal(timedOut(), false);
});

test("abortAfter: 0 means off - no signal, no timer, nothing to cancel", () => {
  const { signal, timedOut, cancel } = abortAfter(0);
  assert.equal(signal, undefined);
  assert.equal(timedOut(), false);
  cancel();
});

// ---------------------------------------------------------------- withTimeout

test("withTimeout: resolves when the work finishes first", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), { ms: 200, label: "x" }), "ok");
});

test("withTimeout: a hanging work becomes a labelled TimeoutError", async () => {
  let noted = 0;
  await assert.rejects(
    withTimeout(new Promise(() => {}), { ms: 25, label: "tool hang", onTimeout: () => noted += 1 }),
    (err) => {
      assert.ok(err instanceof TimeoutError);
      assert.equal(err.code, "timeout");
      assert.match(err.message, /tool hang did not finish within 25ms/);
      assert.equal(noted, 1);
      return true;
    },
  );
});

test("withTimeout: 0 means off - late work still arrives", async () => {
  const p = new Promise((r) => setTimeout(() => r("late"), 30));
  assert.equal(await withTimeout(p, { ms: 0 }), "late");
});

// ---------------------------------------------------------------- signatures

test("callKey: both argument shapes, and a sensible fallback", () => {
  assert.equal(callKey({ function: { name: "read_file", arguments: '{"path":"a.txt"}' } }), 'read_file({"path":"a.txt"})');
  assert.equal(callKey({ name: "t", args: { a: 1 } }), 't({"a":1})');
  assert.equal(callKey({}), "?()");
});

test("stepSignature: stable across ids, sensitive to the calls AND the results", () => {
  const a = stepSignature([{ id: "1", function: { name: "read_file", arguments: "{}" } }], ["line one"]);
  const b = stepSignature([{ id: "2", function: { name: "read_file", arguments: "{}" } }], ["line one"]);
  assert.equal(a, b); // the call id is not part of the signature
  assert.notEqual(a, stepSignature([{ id: "1", function: { name: "read_file", arguments: "{}" } }], ["line two"]));
  assert.notEqual(a, stepSignature([{ id: "1", function: { name: "list_dir", arguments: "{}" } }], ["line one"]));
});

// ---------------------------------------------------------------- stall detector

test("stall detector: stalls exactly at the explicit limit, resets on progress", () => {
  const d = makeStallDetector({ limit: 3 });
  assert.equal(d.note(call("read_file"), ["same"]).stalled, false); // 1
  assert.equal(d.note(call("read_file"), ["same"]).stalled, false); // 2
  const third = d.note(call("read_file"), ["same"]);
  assert.equal(third.stalled, true); // 3
  assert.equal(third.repeat, 3);
  assert.equal(d.repeat, 3);
  // The same call with a DIFFERENT result is progress: polling a build that
  // gets further must never stall.
  assert.equal(d.note(call("read_file"), ["different"]).stalled, false);
  assert.equal(d.repeat, 1);
  // A step that made no calls is progress: the model answered.
  assert.equal(d.note([], []).stalled, false);
  assert.equal(d.repeat, 0);
  assert.equal(d.note([], []).key, null);
});

test("stall detector: different calls never count toward each other", () => {
  const d = makeStallDetector({ limit: 2 });
  assert.equal(d.note(call("a"), ["x"]).stalled, false);
  assert.equal(d.note(call("b"), ["x"]).stalled, false);
  assert.equal(d.note(call("a"), ["x"]).stalled, false);
  assert.equal(d.repeat, 1);
});

test("stall detector: limit 0 (the default) never stalls", () => {
  const d = makeStallDetector({ limit: 0 });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(d.note(call("a"), ["x"]).stalled, false);
  }
  assert.equal(d.repeat, 0);
  assert.equal(d.note(call("a"), ["x"]).key, null);
});

test("stall detector: reset() clears the count", () => {
  const d = makeStallDetector({ limit: 2 });
  d.note(call("a"), ["x"]);
  d.reset();
  const r = d.note(call("a"), ["x"]);
  assert.equal(r.stalled, false);
  assert.equal(r.repeat, 1);
});

// ---------------------------------------------------------------- the live loop

test("agent: a step the watchdog aborts costs the step, and the run fails loudly", async () => {
  // The router accepts the request and then goes quiet. The stub has to reject
  // on abort the way real fetch does: a promise that simply never settles would
  // ignore the deadline and hang the loop forever, which is not what fetch does.
  const never = (url, init) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
    });
  const events = [];
  const result = await runAgent({
    root: WS,
    task: "do the thing",
    fetchImpl: never,
    memory: false,
    useJudge: false,
    stream: false,
    maxSteps: 2,
    stepTimeoutMs: 50,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.stopped, "router_error");
  assert.match(String(result.error), /abort/i);
  const wd = events.filter((e) => e.type === "watchdog");
  assert.equal(wd.length, 2); // the step's one spare attempt included
  assert.ok(wd.every((e) => e.kind === "step_timeout" && e.ms === 50));
  const retries = events.filter((e) => e.type === "retry" && e.reason === "step_timeout");
  assert.equal(retries.length, 1);
});

test("agent: a hung tool is answered with a timeout result, and the run moves on", async () => {
  const fn = scripted([useTool("hang", {}), say("moved on")]);
  const events = [];
  const result = await runAgent({
    root: WS,
    task: "call the hanging tool, then say you moved on",
    fetchImpl: fn,
    memory: false,
    useJudge: false,
    stream: false,
    maxSteps: 3,
    toolTimeoutMs: 50,
    extraTools: [
      {
        name: "hang",
        description: "Never resolves; exists to test the tool watchdog.",
        parameters: { type: "object", properties: {}, required: [] },
        run: () => new Promise(() => {}),
      },
    ],
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.answer, "moved on");
  const wd = events.filter((e) => e.type === "watchdog");
  assert.equal(wd.length, 1);
  assert.equal(wd[0].kind, "tool_timeout");
  assert.equal(wd[0].name, "hang");
  // The tool_call_id got an answer instead of dangling: the next request is well-formed.
  const toolMsgs = fn.calls[1].body.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 1);
  assert.match(toolMsgs[0].content, /did not finish within 50ms/);
  assert.match(toolMsgs[0].content, /still running/);
});

test("agent: the explicit repeat backstop stops a loop of identical steps", async () => {
  const fn = scripted([
    useTool("read_file", { path: "hello.txt" }),
    useTool("read_file", { path: "hello.txt" }),
    useTool("read_file", { path: "hello.txt" }),
    say("unreachable"),
  ]);
  const events = [];
  const result = await runAgent({
    root: WS,
    task: "read hello.txt",
    fetchImpl: fn,
    memory: false,
    useJudge: false,
    stream: false,
    maxSteps: 6,
    repeatLimit: 3,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.stopped, "stalled");
  assert.equal(result.stall.count, 3);
  assert.equal(fn.calls.length, 3); // the model was never given a fourth identical chance
  const wd = events.filter((e) => e.type === "watchdog");
  assert.equal(wd.length, 1);
  assert.equal(wd[0].kind, "repeat");
});

test("agent: without an explicit limit the same loop runs to max_steps, not a stall", async () => {
  const fn = scripted([
    useTool("read_file", { path: "hello.txt" }),
    useTool("read_file", { path: "hello.txt" }),
    useTool("read_file", { path: "hello.txt" }),
    useTool("read_file", { path: "hello.txt" }),
  ]);
  const result = await runAgent({
    root: WS,
    task: "read hello.txt",
    fetchImpl: fn,
    memory: false,
    useJudge: false,
    stream: false,
    maxSteps: 4,
    // repeatLimit left at its default (0): the core detector is a backstop,
    // not the default owner of loop policy.
  });
  assert.equal(result.stopped, "max_steps");
  assert.equal(fn.calls.length, 4);
});

// ---------------------------------------------------------------- per-tool deadline

test("escalatedToolTimeout: five minutes by default, ten once a tool has proved it needs it", async () => {
  const { escalatedToolTimeout, TOOL_TIMEOUT_CEILING_MS } = await import("../src/watchdog.mjs");
  assert.equal(TOOL_TIMEOUT_CEILING_MS, 600_000);
  // The base is what a file read, a listing or a plugin call gets.
  assert.equal(escalatedToolTimeout(300_000), 300_000);
  // A tool whose honest work is minutes starts higher: the midpoint the ceiling allows.
  assert.equal(escalatedToolTimeout(300_000, { known: true }), 450_000);
  // A tool that already used most of its deadline (or was killed at it) gets the ceiling,
  // so the retry is not killed at the same place twice - measured 2026-11-06.
  assert.equal(escalatedToolTimeout(300_000, { slow: true }), 600_000);
  assert.equal(escalatedToolTimeout(300_000, { slow: true, known: true }), 600_000);
  // A call that ASKED for a longer deadline gets that plus grace, so the tool's own kill
  // message reaches the model instead of losing a race with the watchdog.
  assert.equal(escalatedToolTimeout(300_000, { requested: 600_000 }), 630_000);
  assert.equal(escalatedToolTimeout(300_000, { requested: 45_000 }), 330_000);
  // Nothing above the ceiling plus grace, whatever was asked for.
  assert.equal(escalatedToolTimeout(300_000, { requested: 3_600_000 }), 630_000);
  // Off is off, at every level.
  assert.equal(escalatedToolTimeout(0, { slow: true, known: true }), 0);
  // Garbage falls back to the base.
  assert.equal(escalatedToolTimeout("soon"), 300_000);
});
