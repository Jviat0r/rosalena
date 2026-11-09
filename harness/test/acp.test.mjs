/**
 * ACP server tests. The editor is a scripted client on in-memory streams, and the
 * engine is a fake that emits what agent.mjs emits (deltas, tool events, approvals,
 * hook calls) - plus two runs of the REAL runAgent over a scripted router, so the
 * wiring between the two is proved and not just assumed.
 *
 *   node --import ./test/isolate.mjs --test test/acp.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { ERR, describeTool, planEntries, promptToTask, serveAcp, todoEntries } from "../src/acp.mjs";

const WS = mkdtempSync(join(tmpdir(), "acp-test-"));
writeFileSync(join(WS, "hello.txt"), "line one\nline two\n", "utf8");

/**
 * A scripted editor. Every line the agent writes must parse as JSON-RPC 2.0 - that IS
 * the stdout rule - so the listener asserts it on every message. `permit` answers
 * session/request_permission: an optionId, "cancelled", or null to leave it unanswered.
 */
function connect({ runAgentImpl, defaults = {}, sessionsDir = null, permit = () => "allow" } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs = [];
  const done = serveAcp({ input, output, runAgentImpl, defaults: { runs: false, ...defaults }, sessionsDir, log: (m) => logs.push(m) });
  const inbox = [];
  const waiters = new Set();
  let ids = 0;
  const send = (msg) => input.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  createInterface({ input: output }).on("line", (line) => {
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, "2.0", `not JSON-RPC: ${line}`);
    inbox.push(msg);
    if (msg.method === "session/request_permission") {
      const choice = permit(msg.params);
      if (choice === "cancelled") send({ id: msg.id, result: { outcome: { outcome: "cancelled" } } });
      else if (choice) send({ id: msg.id, result: { outcome: { outcome: "selected", optionId: choice } } });
    }
    for (const w of waiters) w();
  });
  const waitFor = (pred, ms = 4000) =>
    new Promise((res, rej) => {
      const hit = () => inbox.find(pred);
      const found = hit();
      if (found) return res(found);
      const timer = setTimeout(() => {
        waiters.delete(check);
        rej(new Error(`timed out; inbox: ${JSON.stringify(inbox).slice(0, 1500)}`));
      }, ms);
      const check = () => {
        const m = hit();
        if (m) {
          clearTimeout(timer);
          waiters.delete(check);
          res(m);
        }
      };
      waiters.add(check);
    });
  const call = async (method, params) => {
    const id = `c${++ids}`;
    send({ id, method, params });
    return waitFor((m) => m.id === id && m.method === undefined);
  };
  const updates = (sessionId) => inbox.filter((m) => m.method === "session/update" && m.params.sessionId === sessionId).map((m) => m.params.update);
  const close = async () => {
    input.end();
    await done;
  };
  return { send, call, waitFor, inbox, updates, logs, close };
}

const hook = (opts, name) => opts.extraHooks.find((h) => h.plugin === "acp" && h.name === name).fn;

/** A fake engine turn: text, one tool that needs approval, one that doesn't. */
function fakeEngine(calls, answers) {
  return async (opts) => {
    calls.push(opts);
    opts.onEvent({ type: "delta", text: "Hel" });
    opts.onEvent({ type: "delta", text: "" }); // a tool-call fragment: no prose, nothing sent
    opts.onEvent({ type: "delta", text: "lo" });
    const answer = await opts.approve({ kind: "tool", tool: "run_command", subject: "npm test", reason: "a shell command", args: { command: "npm test" } });
    answers.push(answer);
    const allowed = answer.decision === "allow" || answer.decision === "always";
    if (allowed) await hook(opts, "beforeTool")({ depth: 0, tool: "run_command", args: { command: "npm test" } });
    opts.onEvent({ type: "tool", name: "run_command", args: { command: "npm test" }, ok: allowed, ms: 5, preview: allowed ? "exit 0\nok" : "refused" });
    await hook(opts, "beforeTool")({ depth: 0, tool: "read_file", args: { path: "hello.txt" } });
    opts.onEvent({ type: "tool", name: "read_file", args: { path: "hello.txt" }, ok: true, ms: 1, preview: "line one" });
    return {
      answer: "Hello",
      steps: 2,
      messages: [...(opts.messages ?? []), { role: "user", content: opts.task }, { role: "assistant", content: "Hello" }],
    };
  };
}

async function newSession(c, cwd = WS) {
  const r = await c.call("session/new", { cwd, mcpServers: [] });
  assert.ok(r.result?.sessionId, JSON.stringify(r));
  return r.result.sessionId;
}

test("initialize advertises protocol 1 and only what is implemented", async () => {
  const c = connect({ runAgentImpl: async () => ({}) });
  const r = await c.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
  assert.equal(r.result.protocolVersion, 1);
  assert.equal(r.result.agentCapabilities.loadSession, false, "no sessions dir, no session/load");
  assert.deepEqual(r.result.agentCapabilities.promptCapabilities, { image: true, audio: false, embeddedContext: true });
  assert.deepEqual(r.result.agentCapabilities.mcpCapabilities, { http: false, sse: false });
  assert.deepEqual(r.result.agentCapabilities.sessionCapabilities, { close: {} });
  assert.equal(r.result.agentInfo.name, "rosalena");
  assert.match(r.result.agentInfo.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(r.result.authMethods, []);
  assert.deepEqual((await c.call("authenticate", { methodId: "x" })).result, {});
  await c.close();
});

test("a prompt streams chunks, tool calls and a permission round trip, then ends the turn", async () => {
  const calls = [];
  const answers = [];
  const asked = [];
  const c = connect({ runAgentImpl: fakeEngine(calls, answers), permit: (p) => (asked.push(p), "allow") });
  await c.call("initialize", { protocolVersion: 1 });
  const s = await newSession(c);
  const r = await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "run the tests" }] });
  assert.deepEqual(r.result, { stopReason: "end_turn" });

  assert.equal(calls[0].task, "run the tests");
  assert.equal(calls[0].root, WS, "session cwd is the run's root");
  assert.equal(calls[0].accessMode, "workspace");
  assert.equal(calls[0].planMode, false);
  assert.equal(calls[0].messages, null, "a new session starts with no history");

  const u = c.updates(s);
  const chunks = u.filter((x) => x.sessionUpdate === "agent_message_chunk").map((x) => x.content.text);
  assert.deepEqual(chunks, ["Hel", "lo"], "streamed text is not repeated at the end");

  const run = u.find((x) => x.sessionUpdate === "tool_call" && x.title === "Run npm test");
  assert.equal(run.kind, "execute");
  assert.equal(run.status, "pending");
  assert.deepEqual(run.rawInput, { command: "npm test" });

  assert.equal(asked.length, 1);
  assert.equal(asked[0].sessionId, s);
  assert.equal(asked[0].toolCall.toolCallId, run.toolCallId, "the permission request names the announced call");
  assert.deepEqual(asked[0].options.map((o) => o.kind), ["allow_once", "allow_always", "reject_once", "reject_always"]);
  assert.equal(answers[0].decision, "allow");

  const runUpdates = u.filter((x) => x.sessionUpdate === "tool_call_update" && x.toolCallId === run.toolCallId);
  assert.deepEqual(runUpdates.map((x) => x.status), ["in_progress", "completed"]);
  assert.equal(runUpdates[1].content[0].content.text, "exit 0\nok");

  const read = u.find((x) => x.sessionUpdate === "tool_call" && x.title === "Read hello.txt");
  assert.equal(read.kind, "read");
  assert.equal(read.status, "in_progress");
  assert.equal(read.locations[0].path, join(WS, "hello.txt"), "ACP paths are absolute");

  // The response comes after every update of the turn.
  const respAt = c.inbox.indexOf(r);
  const lastUpdateAt = c.inbox.findLastIndex((m) => m.method === "session/update");
  assert.ok(respAt > lastUpdateAt);
  await c.close();
});

test("a second prompt continues the first, and 'always allow' lasts for the session", async () => {
  const calls = [];
  const answers = [];
  let asks = 0;
  const c = connect({ runAgentImpl: fakeEngine(calls, answers), permit: () => (asks++, "always") });
  await c.call("initialize", { protocolVersion: 1 });
  const s = await newSession(c);
  await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "first" }] });
  const r2 = await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "second" }] });
  assert.equal(r2.result.stopReason, "end_turn");
  assert.deepEqual(calls[1].messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "Hello" },
  ]);
  assert.equal(calls[1].task, "second");
  assert.equal(asks, 1, "the second run did not ask again");
  assert.equal(answers[1].decision, "allow");
  await c.close();
});

test("a denied tool is reported failed, and 'always deny' is remembered", async () => {
  const calls = [];
  const answers = [];
  const c = connect({ runAgentImpl: fakeEngine(calls, answers), permit: () => "never" });
  const s = await newSession(c);
  await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "x" }] });
  await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "y" }] });
  assert.equal(answers[0].decision, "deny");
  assert.equal(answers[1].decision, "deny");
  assert.equal(c.inbox.filter((m) => m.method === "session/request_permission").length, 1);
  const failed = c.updates(s).filter((x) => x.status === "failed");
  assert.equal(failed.length, 2, "one failed run_command per turn");
  await c.close();
});

test("session/cancel answers the pending permission, stops the loop and ends 'cancelled'", async () => {
  let seen = null;
  const engine = async (opts) => {
    const answer = await opts.approve({ kind: "tool", tool: "write_file", subject: "a.txt", reason: "x", args: { path: "a.txt", content: "hi" } });
    const stop = await hook(opts, "beforeStep")({ step: 2 });
    const deny = await hook(opts, "beforeTool")({ depth: 0, tool: "read_file", args: {} });
    let fetchError = null;
    await opts.fetchImpl("http://127.0.0.1:1/v1/chat/completions", {}).catch((err) => (fetchError = err));
    seen = { answer, stop, deny, fetchError };
    return { stopped: "guard:acp", answer: "", messages: [{ role: "user", content: opts.task }] };
  };
  const c = connect({ runAgentImpl: engine, permit: () => null });
  const s = await newSession(c);
  const id = "p1";
  c.send({ id, method: "session/prompt", params: { sessionId: s, prompt: [{ type: "text", text: "write it" }] } });
  const req = await c.waitFor((m) => m.method === "session/request_permission");
  const pending = c.updates(s).find((x) => x.sessionUpdate === "tool_call");
  assert.equal(pending.kind, "edit");
  assert.equal(pending.content[0].type, "diff", "a write shows its diff");
  assert.equal(req.params.toolCall.toolCallId, pending.toolCallId);
  c.send({ method: "session/cancel", params: { sessionId: s } });
  const r = await c.waitFor((m) => m.id === id);
  assert.deepEqual(r.result, { stopReason: "cancelled" });
  assert.equal(seen.answer.decision, "deny");
  assert.ok(seen.stop?.stop, "beforeStep stops the loop");
  assert.ok(seen.deny?.deny, "beforeTool refuses further tools");
  assert.ok(seen.fetchError, "router calls after a cancel fail at once");
  // A late answer from the client to the already-settled request is harmless.
  c.send({ id: req.id, result: { outcome: { outcome: "cancelled" } } });
  // The session is free for the next prompt: it is not refused as "already running".
  c.send({ id: "p2", method: "session/prompt", params: { sessionId: s, prompt: [{ type: "text", text: "again" }] } });
  await c.waitFor((m) => m.method === "session/request_permission" && m.id !== req.id);
  c.send({ method: "session/cancel", params: { sessionId: s } });
  assert.deepEqual((await c.waitFor((m) => m.id === "p2")).result, { stopReason: "cancelled" });
  await c.close();
});

test("unknown methods, unknown sessions, bad JSON and bad params get JSON-RPC errors", async () => {
  const c = connect({ runAgentImpl: async () => ({ answer: "x", messages: [] }) });
  const r1 = await c.call("session/fly", {});
  assert.equal(r1.error.code, ERR.METHOD_NOT_FOUND);
  const r2 = await c.call("session/prompt", { sessionId: "sess_nope", prompt: [{ type: "text", text: "x" }] });
  assert.equal(r2.error.code, ERR.NOT_FOUND);
  const r3 = await c.call("session/new", { cwd: "relative/path", mcpServers: [] });
  assert.equal(r3.error.code, ERR.INVALID_PARAMS);
  const r4 = await c.call("session/load", { sessionId: "x", cwd: WS, mcpServers: [] });
  assert.equal(r4.error.code, ERR.METHOD_NOT_FOUND, "load is off without a sessions dir");
  // An unknown notification is ignored: no reply of any kind.
  const before = c.inbox.length;
  c.send({ method: "_vendor/whatever", params: {} });
  const s = await newSession(c);
  assert.equal(c.inbox.length, before + 1, "only the session/new reply arrived");
  const r5 = await c.call("session/prompt", { sessionId: s, prompt: [] });
  assert.equal(r5.error.code, ERR.INVALID_PARAMS, "an empty prompt is refused");
  await c.close();

  // Parse errors need a raw line, not the helper's JSON.
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serveAcp({ input, output, runAgentImpl: async () => ({}), log: () => {} });
  const first = new Promise((res) => createInterface({ input: output }).once("line", res));
  input.write("{not json\n");
  const msg = JSON.parse(await first);
  assert.equal(msg.error.code, ERR.PARSE);
  assert.equal(msg.id, null);
  input.end();
  await done;
});

test("stop reasons: max_steps -> max_turn_requests, a failed run -> a JSON-RPC error", async () => {
  const results = [
    { stopped: "max_steps", answer: "partial", messages: [] },
    { stopped: "router_error", error: "router unreachable", messages: [] },
    { stopped: "wall_clock", answer: "ran out of time", messages: [] },
  ];
  const c = connect({ runAgentImpl: async () => results.shift() });
  const s = await newSession(c);
  const p = (text) => c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text }] });
  assert.equal((await p("a")).result.stopReason, "max_turn_requests");
  const failed = await p("b");
  assert.equal(failed.error.code, ERR.INTERNAL);
  assert.match(failed.error.message, /router unreachable/);
  assert.equal((await p("c")).result.stopReason, "end_turn");
  const said = c.updates(s).filter((x) => x.sessionUpdate === "agent_message_chunk").map((x) => x.content.text).join("|");
  assert.match(said, /partial/, "a buffered answer is sent whole");
  assert.match(said, /stopped: wall_clock/, "an early stop is said out loud");
  await c.close();
});

test("plan mode: set_mode plan, the plan becomes entries, approving it leaves plan mode", async () => {
  const calls = [];
  const engine = async (opts) => {
    calls.push(opts);
    opts.onEvent({ type: "plan", plan: "1. read the code\n2. fix the bug" });
    const answer = await opts.approve({ kind: "plan", plan: "1. read the code\n2. fix the bug" });
    opts.onEvent({ type: "tool", name: "exit_plan_mode", args: { plan: "..." }, ok: true, ms: 0, preview: "approved" });
    opts.onEvent({ type: "tool", name: "todo_write", args: { todos: [{ content: "read the code", status: "completed" }, { content: "fix the bug", status: "in_progress" }] }, ok: true, ms: 0, preview: "" });
    return { answer: answer.decision, messages: [] };
  };
  let asked = null;
  const c = connect({ runAgentImpl: engine, permit: (p) => ((asked = p), "approve") });
  const s = await newSession(c);
  const created = c.inbox.find((m) => m.result?.sessionId === s);
  assert.deepEqual(created.result.modes.availableModes.map((m) => m.id), ["workspace", "auto", "full", "read", "plan"]);
  assert.equal(created.result.modes.currentModeId, "workspace");
  assert.deepEqual((await c.call("session/set_mode", { sessionId: s, modeId: "plan" })).result, {});
  assert.equal((await c.call("session/set_mode", { sessionId: s, modeId: "yolo" })).error.code, ERR.INVALID_PARAMS);
  await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "fix it" }] });
  assert.equal(calls[0].planMode, true);
  assert.equal(calls[0].accessMode, "workspace");
  assert.equal(asked.toolCall.kind, "switch_mode");
  assert.deepEqual(asked.options.map((o) => o.optionId), ["approve", "reject"]);
  const u = c.updates(s);
  const plans = u.filter((x) => x.sessionUpdate === "plan");
  assert.deepEqual(plans[0].entries, [
    { content: "read the code", priority: "medium", status: "pending" },
    { content: "fix the bug", priority: "medium", status: "pending" },
  ]);
  assert.deepEqual(plans[1].entries.map((e) => e.status), ["completed", "in_progress"], "todo_write is the live plan");
  assert.ok(u.some((x) => x.sessionUpdate === "current_mode_update" && x.currentModeId === "workspace"));
  assert.ok(!u.some((x) => x.sessionUpdate === "tool_call" && x.title === "todo_write"), "todo_write is not a tool card");
  await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "go on" }] });
  assert.equal(calls[1].planMode, false, "the next turn runs with the plan approved");
  await c.close();
});

test("session/load replays the visible transcript and continues the history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-sessions-"));
  const calls = [];
  const c1 = connect({ runAgentImpl: fakeEngine(calls, []), sessionsDir: dir });
  assert.equal((await c1.call("initialize", { protocolVersion: 1 })).result.agentCapabilities.loadSession, true);
  const s = await newSession(c1);
  await c1.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "first" }] });
  await c1.close();

  // A fresh process, as when the editor restarts.
  const c2 = connect({ runAgentImpl: fakeEngine(calls, []), sessionsDir: dir });
  const r = await c2.call("session/load", { sessionId: s, cwd: WS, mcpServers: [] });
  assert.equal(r.result.modes.currentModeId, "workspace");
  const replay = c2.updates(s);
  assert.deepEqual(replay.map((x) => x.sessionUpdate), ["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call"]);
  assert.equal(replay[0].content.text, "first");
  assert.equal(replay[1].content.text, "Hello");
  assert.ok(c2.inbox.indexOf(r) > c2.inbox.findLastIndex((m) => m.method === "session/update"), "replay comes before the response");
  await c2.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "second" }] });
  assert.deepEqual(calls[1].messages, [{ role: "user", content: "first" }, { role: "assistant", content: "Hello" }]);
  assert.equal((await c2.call("session/load", { sessionId: "../../etc", cwd: WS, mcpServers: [] })).error.code, ERR.NOT_FOUND);
  assert.deepEqual((await c2.call("session/close", { sessionId: s })).result, {});
  assert.equal((await c2.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "x" }] })).error.code, ERR.NOT_FOUND);
  await c2.close();
});

test("prompt content: resources inline, links by path, images to files", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "acp-img-"));
  const { task, images } = promptToTask(
    [
      { type: "text", text: "look" },
      { type: "resource", resource: { uri: "file:///C:/x/a.txt", text: "body" } },
      { type: "resource_link", uri: "file:///C:/x/b.txt", name: "b.txt" },
      { type: "image", mimeType: "image/png", data: png },
    ],
    { imageDir: dir },
  );
  assert.match(task, /^look/);
  assert.match(task, /```\nbody\n```/);
  assert.match(task, /\[attached: .*b\.txt\]/);
  assert.equal(images.length, 1);
  assert.match(images[0], /\.png$/);
  assert.equal(describeTool("edit_file", { path: "a.js", old_text: "x", new_text: "y" }, WS).content[0].type, "diff");
  assert.equal(describeTool("web_fetch", { url: "https://a.b" }, WS).kind, "fetch");
  assert.deepEqual(planEntries("just do it").map((e) => e.content), ["just do it"]);
  assert.deepEqual(todoEntries([{ content: "a", status: "weird" }, { content: "" }]), [{ content: "a", priority: "medium", status: "pending" }]);
});

// ------------------------------------------------------------------ the real engine

/** OpenAI-style replies in order, repeating the last one. */
function scriptedRouter(script) {
  const bodies = [];
  const fn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const payload = script[Math.min(bodies.length - 1, script.length - 1)];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  fn.bodies = bodies;
  return fn;
}
const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });
const useTool = (name, args) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
  usage: {},
});
const REAL = { stream: false, runs: false, memory: false, instructions: false };

test("end to end with the real runAgent: answer, history, stop reason", async () => {
  const router = scriptedRouter([say("hi")]);
  const c = connect({ defaults: { ...REAL, fetchImpl: router } }); // runAgentImpl defaults to runAgent
  await c.call("initialize", { protocolVersion: 1 });
  const s = await newSession(c);
  const r = await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "say hi" }] });
  assert.deepEqual(r.result, { stopReason: "end_turn" }, JSON.stringify(r));
  const chunks = c.updates(s).filter((x) => x.sessionUpdate === "agent_message_chunk").map((x) => x.content.text);
  assert.deepEqual(chunks, ["hi"]);
  const r2 = await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "again" }] });
  assert.equal(r2.result.stopReason, "end_turn");
  const sent = router.bodies[1].messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : ""}`);
  assert.ok(sent.includes("user:say hi") && sent.includes("assistant:hi") && sent.at(-1) === "user:again", sent.join(" | "));
  await c.close();
});

test("end to end with the real runAgent: cancel aborts the model call in flight", async () => {
  let started;
  const begun = new Promise((res) => (started = res));
  // A model that never answers on its own: only the abort signal ends the call.
  const hanging = (url, init) =>
    new Promise((_, reject) => {
      started();
      init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")), { once: true });
    });
  const c = connect({ defaults: { ...REAL, fetchImpl: hanging } });
  const s = await newSession(c);
  c.send({ id: "p", method: "session/prompt", params: { sessionId: s, prompt: [{ type: "text", text: "think forever" }] } });
  await begun;
  c.send({ method: "session/cancel", params: { sessionId: s } });
  const r = await c.waitFor((m) => m.id === "p", 15000);
  assert.deepEqual(r.result, { stopReason: "cancelled" }, JSON.stringify(r));
  await c.close();
});

test("end to end with the real runAgent: a tool call shows up in_progress then completed", async () => {
  const router = scriptedRouter([useTool("read_file", { path: "hello.txt" }), say("read it")]);
  const c = connect({ defaults: { ...REAL, fetchImpl: router } });
  const s = await newSession(c);
  const r = await c.call("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "read hello.txt" }] });
  assert.equal(r.result.stopReason, "end_turn", JSON.stringify(r));
  const u = c.updates(s);
  const open = u.find((x) => x.sessionUpdate === "tool_call");
  assert.equal(open.title, "Read hello.txt");
  assert.equal(open.kind, "read");
  assert.equal(open.status, "in_progress");
  const done = u.find((x) => x.sessionUpdate === "tool_call_update" && x.toolCallId === open.toolCallId);
  assert.equal(done.status, "completed");
  assert.match(done.content[0].content.text, /line one/);
  assert.equal(u.filter((x) => x.sessionUpdate === "agent_message_chunk").at(-1).content.text, "read it");
  await c.close();
});
