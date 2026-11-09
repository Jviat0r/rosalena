/**
 * Harness tests. The router is scripted - each entry is the next reply the
 * "model" gives - so the loop, the tool execution and the role split are all
 * deterministic and free.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { baseOf, chatRequest, routerAuthHeaders, runAgent, systemPrompt } from "../src/agent.mjs";
import { logDay, releaseMessageSink, setMessageSink } from "../src/message-log.mjs";
import { createTools, runToolCall } from "../src/tools.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-test-"));
writeFileSync(join(WS, "hello.txt"), "line one\nline two\nline three\n", "utf8");

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

/** Replies in order, repeating the last entry when the script runs out. */
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

const base = { root: WS, onEvent: () => {} };

test("baseOf strips the /v1 suffix so /admin/status can be reached", () => {
  assert.equal(baseOf("http://127.0.0.1:8077/v1"), "http://127.0.0.1:8077");
  assert.equal(baseOf("http://127.0.0.1:8077/v1/"), "http://127.0.0.1:8077");
  assert.equal(baseOf("http://127.0.0.1:8077"), "http://127.0.0.1:8077");
});

test("the system prompt names the root, the tools, and the injection rule", () => {
  const prompt = systemPrompt(WS, ["read_file", "run_command"]);
  assert.match(prompt, /Workspace root/);
  assert.match(prompt, /read_file, run_command/);
  assert.match(prompt, /untrusted DATA/);
});

test("a plain answer ends the loop in one step", async () => {
  const f = scripted([say("all done")]);
  const result = await runAgent({ ...base, task: "say hi", fetchImpl: f });
  assert.equal(result.answer, "all done");
  assert.equal(result.steps, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.model, "orchestrate", "the loop runs on the orchestrator class");
  assert.ok(f.calls[0].body.tools.length >= 5, "tools are advertised to the model");
});

test("a tool call is executed and its real output is fed back", async () => {
  const events = [];
  const f = scripted([useTool("read_file", { path: "hello.txt" }), say("read it")]);
  const result = await runAgent({ ...base, task: "read hello.txt", fetchImpl: f, onEvent: (e) => events.push(e) });

  assert.equal(result.answer, "read it");
  assert.equal(result.steps, 2);
  const toolEvent = events.find((e) => e.type === "tool");
  assert.equal(toolEvent.name, "read_file");
  assert.equal(toolEvent.ok, true);
  assert.match(toolEvent.preview, /line one/);

  // The second request must carry the tool result, or the model is answering blind.
  const second = f.calls[1].body.messages;
  const toolMessage = second.find((m) => m.role === "tool");
  assert.ok(toolMessage, "the tool result is in the conversation");
  assert.equal(toolMessage.tool_call_id, "call_1");
  assert.match(toolMessage.content, /line three/);
});

test("a tool result is clipped instead of flooding the context", async () => {
  const big = "x".repeat(50_000);
  writeFileSync(join(WS, "big.txt"), big, "utf8");
  const f = scripted([useTool("read_file", { path: "big.txt" }), say("ok")]);
  const result = await runAgent({ ...base, task: "read big.txt", fetchImpl: f });
  const toolMessage = result.messages.find((m) => m.role === "tool");
  assert.ok(toolMessage.content.length < 10_000, `clipped, got ${toolMessage.content.length}`);
  assert.match(toolMessage.content, /truncated/);
});

test("a path escape is refused as a tool error, not a crash", async () => {
  const events = [];
  const f = scripted([useTool("read_file", { path: "../../secret.txt" }), say("could not read it")]);
  const result = await runAgent({ ...base, task: "read outside", fetchImpl: f, onEvent: (e) => events.push(e) });
  const toolEvent = events.find((e) => e.type === "tool");
  assert.equal(toolEvent.ok, false);
  assert.match(toolEvent.preview, /refused/);
  // The loop keeps going: a refused tool is information, not a dead end.
  assert.equal(result.answer, "could not read it");
});

test("the loop stops at maxSteps when the model keeps calling tools", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" })]);
  const events = [];
  const result = await runAgent({ ...base, task: "loop forever", fetchImpl: f, maxSteps: 3, onEvent: (e) => events.push(e) });
  assert.equal(result.stopped, "max_steps");
  assert.equal(result.steps, 3);
  assert.equal(f.calls.length, 3, "no fourth call");
  assert.ok(events.some((e) => e.type === "stopped" && e.reason === "max_steps"));
});

test("the wall-clock budget stops the loop", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" })]);
  const result = await runAgent({ ...base, task: "slow", fetchImpl: f, maxSteps: 50, maxWallMs: -1 });
  assert.equal(result.stopped, "wall_clock");
});

test("a router failure is reported, not thrown", async () => {
  const f = async () => new Response("all targets failed", { status: 503 });
  const result = await runAgent({ ...base, task: "anything", fetchImpl: f });
  assert.equal(result.stopped, "router_error");
  assert.match(result.error, /router returned 503/);
});

test("a router failure carries the error key and what to do, after the original message", async () => {
  const body = JSON.stringify({ type: "server_error", message: "Upstream request failed: Endpoint is unavailable." });
  const f = async () => new Response(body, { status: 429 });
  const events = [];
  const result = await runAgent({ ...base, task: "anything", fetchImpl: f, onEvent: (e) => events.push(e) });
  assert.equal(result.stopped, "router_error");
  assert.match(result.error, /^router returned 429/, "the provider's message stays first");
  assert.match(result.error, /\[Rosalena error OC-UPSTREAM-DOWN\]/,"an outage sent as 429 is not called a rate limit");
  assert.match(result.error, /What to do:/);
  assert.ok(events.some((e) => e.type === "error" && /OC-UPSTREAM-DOWN/.test(e.message)), "the error event shows it too");
});

test("delegate runs a worker on the worker class and tags its events", async () => {
  const events = [];
  const f = scripted([useTool("delegate", { task: "find the thing" }), say("worker: found it"), say("done via worker")]);
  const result = await runAgent({
    ...base,
    task: "orchestrate a search",
    workerClass: "code",
    fetchImpl: f,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.answer, "done via worker");
  // Call 2 is the worker's own loop, on the worker class.
  assert.equal(f.calls[1].body.model, "code");
  assert.ok(events.some((e) => e.sub === true && e.type === "assistant"), "worker events are tagged sub");
  const delegateEvent = events.find((e) => e.type === "tool" && e.name === "delegate");
  assert.equal(delegateEvent.ok, true);
  assert.match(delegateEvent.preview, /found it/);
});

test("a worker cannot delegate again, so the agent tree stays two levels deep", async () => {
  const f = scripted([useTool("delegate", { task: "sub-task" }), useTool("delegate", { task: "sub-sub-task" }), say("done")]);
  const events = [];
  await runAgent({ ...base, task: "recurse", fetchImpl: f, onEvent: (e) => events.push(e) });
  const workerTools = f.calls[1].body.tools.map((t) => t.function.name);
  assert.ok(!workerTools.includes("delegate"), `worker tools: ${workerTools.join(", ")}`);
});

test("the judge verdict is parsed and returned", async () => {
  const f = scripted([say("the answer"), say('{"pass": true, "reasons": "evidence checks out"}')]);
  const result = await runAgent({ ...base, task: "be judged", useJudge: true, fetchImpl: f });
  assert.equal(result.answer, "the answer");
  assert.equal(result.verdict.pass, true);
  assert.match(result.verdict.reasons, /evidence/);
  assert.equal(f.calls[1].body.model, "judge", "the judge runs on the judge class");
});

test("malformed tool arguments become a readable tool error", async () => {
  const tools = createTools({ root: WS });
  const result = await runToolCall({ id: "c", function: { name: "read_file", arguments: "{not json" } }, tools);
  assert.equal(result.ok, false);
  assert.match(result.text, /not valid JSON/);
});

test("an unknown tool name is reported with the available list", async () => {
  const tools = createTools({ root: WS });
  const result = await runToolCall({ id: "c", function: { name: "rm_rf", arguments: "{}" } }, tools);
  assert.equal(result.ok, false);
  assert.match(result.text, /unknown tool "rm_rf"/);
  assert.match(result.text, /read_file/);
});

test("run_command reports the exit code and both streams", async () => {
  const tools = createTools({ root: WS });
  const result = await runToolCall(
    { id: "c", function: { name: "run_command", arguments: JSON.stringify({ command: 'node -e "console.log(41+1)"' }) } },
    tools,
  );
  assert.equal(result.ok, true);
  assert.match(result.text, /exit 0/);
  assert.match(result.text, /42/);
});

test("search finds a match inside the workspace and skips nothing important", async () => {
  const tools = createTools({ root: WS });
  const result = await runToolCall({ id: "c", function: { name: "search", arguments: JSON.stringify({ pattern: "line two" }) } }, tools);
  assert.equal(result.ok, true);
  assert.match(result.text, /hello\.txt:2/);
});

test("write_file creates parent directories and list_dir sees the result", async () => {
  const tools = createTools({ root: WS });
  const wrote = await runToolCall(
    { id: "c", function: { name: "write_file", arguments: JSON.stringify({ path: "deep/nested/out.txt", content: "hi" }) } },
    tools,
  );
  assert.equal(wrote.ok, true);
  const listed = await runToolCall({ id: "c2", function: { name: "list_dir", arguments: JSON.stringify({ path: "deep/nested" }) } }, tools);
  assert.match(listed.text, /out\.txt/);
});

// A live run on 2026-10-19 asked the model to write outside the workspace. It was
// refused by write_file, and then did it through run_command - correctly, because the
// shell is not confined. These tests hold the harness to saying that plainly, and to
// offering the one confinement that is real: removing the shell.

test("the shell is not a boundary, and the tool description says so", () => {
  const tools = createTools({ root: WS });
  const described = tools.byName.run_command.description;
  assert.match(described, /working directory, not a boundary/);
  assert.match(described, /explicitly requires it/);
});

test("the file tools still refuse to leave the workspace", async () => {
  const tools = createTools({ root: WS });
  const out = await runToolCall({ id: "c", function: { name: "write_file", arguments: JSON.stringify({ path: "../escaped.txt", content: "x" }) } }, tools);
  assert.equal(out.ok, false);
  assert.match(out.text, /outside the workspace root/);
});

test("a run's attachments are readable without making the workspace porous", async () => {
  // The browser window writes attachments into the harness home, which is outside the
  // workspace. Measured: read_file refused the file the task had just named, and the
  // model's next step opened it with `powershell -Command Get-Content` instead - the
  // opposite of the confinement, and slower. `extraReadRoots` widens reading only.
  const home = mkdtempSync(join(tmpdir(), "rosalena-attach-"));
  const attached = join(home, "attachments", "run-1");
  mkdirSync(attached, { recursive: true });
  writeFileSync(join(attached, "probe.txt"), "ATTACH-PROBE\n");
  const root = join(home, "workspace");
  mkdirSync(root, { recursive: true });

  const tools = createTools({ root, extraReadRoots: [attached] });
  const read = await tools.byName.read_file.run({ path: join(attached, "probe.txt") });
  assert.match(read, /ATTACH-PROBE/, "the attached file is readable by its absolute path");
  assert.match(await tools.byName.list_dir.run({ path: attached }), /probe\.txt/, "and the folder can be listed");

  // Widening is read-only, and limited to that folder.
  const wrote = await runToolCall({ id: "w", function: { name: "write_file", arguments: JSON.stringify({ path: join(attached, "probe.txt"), content: "x" }) } }, tools);
  assert.equal(wrote.ok, false);
  assert.match(wrote.text, /outside the workspace root/);
  const escaped = await runToolCall({ id: "r", function: { name: "read_file", arguments: JSON.stringify({ path: join(home, "secrets.txt") }) } }, tools);
  assert.equal(escaped.ok, false);
  assert.match(escaped.text, /outside the workspace root/);

  // Without the grant the same read is refused, so this is the option, not a new default.
  // (The tools throw synchronously, so the arrow has to be async for assert.rejects to
  // see a rejection rather than throwing straight through the assertion.)
  const plain = createTools({ root });
  await assert.rejects(async () => plain.byName.read_file.run({ path: join(attached, "probe.txt") }), /outside the workspace root/);
});

test("shell: false removes run_command from the tool list the model sees", () => {
  const tools = createTools({ root: WS, allowShell: false });
  assert.equal(tools.byName.run_command, undefined);
  const names = tools.schemas.map((s) => s.function.name);
  assert.ok(!names.includes("run_command"), `schemas: ${names.join(", ")}`);
  assert.ok(names.includes("read_file"), "the file tools are unaffected");
});

test("with the shell gone, a model that asks for it is told it is unknown", async () => {
  const events = [];
  const f = scripted([useTool("run_command", { command: "echo hi" }), say("I cannot run commands")]);
  const result = await runAgent({ ...base, task: "run a command", fetchImpl: f, shell: false, onEvent: (e) => events.push(e) });
  const call = events.find((e) => e.type === "tool");
  assert.equal(call.ok, false);
  assert.match(call.preview, /unknown tool "run_command"/);
  assert.equal(result.answer, "I cannot run commands");
});

test("a seeded run ends its transcript with the new task, and leaves the seed alone", async () => {
  // A follow-up in the same chat hands the previous transcript back in. Without the new
  // question appended, the model sees a conversation that ends on its own last answer
  // and just continues that sentence - which is exactly what happened in the UI.
  const seed = [
    { role: "system", content: "you are a test" },
    { role: "user", content: "what is the first heading?" },
    { role: "assistant", content: "The Harness (v0)" },
  ];
  const frozen = JSON.parse(JSON.stringify(seed));
  const f = scripted([say("it routes")]);
  const result = await runAgent({ ...base, task: "what does the router do?", messages: seed, fetchImpl: f });

  assert.equal(result.answer, "it routes");
  const sent = f.calls[0].body.messages;
  assert.deepEqual(sent.at(-1), { role: "user", content: "what does the router do?" });
  assert.deepEqual(sent.slice(0, 3), frozen, "the parent's turns are carried over unchanged");
  assert.deepEqual(seed, frozen, "the caller's array is not mutated by the child run");

  // The returned transcript is the child's own, so the next follow-up can use it.
  assert.ok(result.messages.length > sent.length || result.messages.length >= sent.length);
  assert.equal(result.messages.at(-1).role, "assistant");
});

test("a seeded run with no task continues the transcript as it stands", async () => {
  const seed = [
    { role: "system", content: "you are a test" },
    { role: "user", content: "hello" },
  ];
  const f = scripted([say("hi")]);
  await runAgent({ ...base, task: "", messages: seed, fetchImpl: f });
  assert.equal(f.calls[0].body.messages.length, 2, "no empty user turn is appended");
});

test("a seed rebuilt from a stored log gets this run's system turn in front", async () => {
  // A chat loaded from disk comes back as plain user/assistant turns. The continuation
  // must still know its root and its tools, so the system prompt is not skipped just
  // because a transcript was supplied.
  const seed = [
    { role: "user", content: "what is the first heading?" },
    { role: "assistant", content: "The Harness (v0)" },
  ];
  const f = scripted([say("it routes")]);
  await runAgent({ ...base, task: "and the router?", messages: seed, fetchImpl: f });
  const sent = f.calls[0].body.messages;
  assert.equal(sent[0].role, "system");
  assert.match(sent[0].content, /Workspace root/);
  assert.deepEqual(sent.slice(1, 3), seed);
  assert.deepEqual(sent.at(-1), { role: "user", content: "and the router?" });
});

test("the system prompt states which tools are confined and which are not", () => {
  const prompt = systemPrompt(WS, ["read_file", "run_command"]);
  assert.match(prompt, /refuse any path that resolves outside/);
  assert.match(prompt, /real shell holding the user's own permissions/);
  assert.doesNotMatch(prompt, /Refuse to touch anything outside the workspace root/);
});

test("the router token travels in the request when ROSALENA_ROUTER_TOKEN is set", () => {
  // The router's gate is only useful if its one client actually presents the
  // secret. An empty variable must produce no header at all rather than
  // "Bearer " - a blank Authorization header makes some servers reject instead of
  // ignore, and the open-on-loopback default has to stay byte-for-byte unchanged.
  assert.deepEqual(routerAuthHeaders({}), {});
  assert.deepEqual(routerAuthHeaders({ ROSALENA_ROUTER_TOKEN: "   " }), {});
  assert.deepEqual(routerAuthHeaders({ ROSALENA_ROUTER_TOKEN: "abc123" }), { authorization: "Bearer abc123" });

  const withToken = chatRequest({ cls: "code", messages: [], env: { ROSALENA_ROUTER_TOKEN: "abc123" } });
  assert.equal(withToken.init.headers.authorization, "Bearer abc123");
  assert.equal(withToken.url, "http://127.0.0.1:8077/v1/chat/completions");

  const without = chatRequest({ cls: "code", messages: [], env: {} });
  assert.equal(without.init.headers.authorization, undefined);
  assert.equal(without.init.headers["content-type"], "application/json");
});

test("running out of time keeps the step count and the last thing said", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" })]);
  const result = await runAgent({ ...base, task: "slow", fetchImpl: f, maxSteps: 50, maxWallMs: -1 });
  assert.equal(result.stopped, "wall_clock");
  assert.equal(result.steps, 0, "stopped before the first step, and says so");
});

test("a time limit of 0 means no limit", async () => {
  const f = scripted([say("done")]);
  const result = await runAgent({ ...base, task: "quick", fetchImpl: f, maxWallMs: 0 });
  assert.equal(result.stopped, undefined);
  assert.equal(result.answer, "done");
});

test("the system prompt names the real shell", () => {
  assert.match(systemPrompt(WS, ["run_command"], "", { platform: "win32" }), /cmd\.exe.*not ls, cat, grep/);
  assert.match(systemPrompt(WS, ["run_command"], "", { platform: "linux" }), /\/bin\/sh/);
  assert.doesNotMatch(systemPrompt(WS, ["read_file"], "", { platform: "win32" }), /cmd\.exe/, "no shell, no shell line");
});

test("a long run is reminded of the request every focusEvery steps", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" })]);
  const events = [];
  const result = await runAgent({ ...base, task: "find the bug", fetchImpl: f, maxSteps: 7, focusEvery: 3, onEvent: (e) => events.push(e) });
  assert.equal(result.stopped, "max_steps");
  assert.deepEqual(events.filter((e) => e.type === "focus").map((e) => e.step), [4, 7]);
  const reminders = result.messages.filter((m) => m.role === "user" && String(m.content).startsWith("[harness reminder"));
  assert.equal(reminders.length, 2);
  assert.match(reminders[0].content, /find the bug/);
  assert.match(reminders[0].content, /Workspace root:/);
});

test("an empty reply is not an answer: the model is asked to continue", async () => {
  const f = scripted([say(""), say("finished the work")]);
  const events = [];
  const result = await runAgent({ ...base, task: "do it", fetchImpl: f, onEvent: (e) => events.push(e) });
  assert.equal(result.answer, "finished the work");
  assert.equal(events.filter((e) => e.type === "empty_reply").length, 1);
  assert.ok(result.messages.some((m) => m.role === "user" && /Your last reply was empty/.test(m.content)));
  assert.ok(!result.messages.some((m) => m.role === "assistant" && m.content === "" && !m.tool_calls), "the empty reply is not kept in the history");
});

test("an empty reply is retried, and a run that never answers is not reported as done", async () => {
  const f = scripted([say("")]);
  const result = await runAgent({ ...base, task: "do it", fetchImpl: f, maxSteps: 20 });
  // Not "ok": the run produced nothing, so the record says so instead of claiming the
  // task finished (measured 2026-11-06: three empty replies ended a run "ok").
  assert.equal(result.stopped, "empty_reply");
  assert.equal(result.answer, "");
  assert.equal(f.calls.length, 1 + 5, "the first reply and the retries");
});

test("a run that only reads is told to start changing things", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" })]);
  const events = [];
  const result = await runAgent({ ...base, task: "fix the typo", fetchImpl: f, maxSteps: 6, nudgeAfterReads: 3, focusEvery: 0, repeatLimit: 0, onEvent: (e) => events.push(e) });
  assert.equal(result.stopped, "max_steps");
  assert.deepEqual(events.filter((e) => e.type === "nudge").map((e) => e.step), [3, 6]);
  assert.ok(result.messages.some((m) => m.role === "user" && /only read, listed or searched/.test(m.content)));
});

test("edit_file replaces exactly one match and refuses misses and ambiguity", async () => {
  const { createTools } = await import("../src/tools.mjs");
  writeFileSync(join(WS, "edit-me.txt"), "alpha\r\nbeta\r\nbeta\r\n", "utf8");
  const tools = createTools({ root: WS });
  const edit = (args) => tools.byName.edit_file.run(args);
  await assert.rejects(edit({ path: "edit-me.txt", old_text: "gamma", new_text: "x" }), /not found/);
  await assert.rejects(edit({ path: "edit-me.txt", old_text: "beta", new_text: "x" }), /appears 2 times/);
  assert.match(await edit({ path: "edit-me.txt", old_text: "alpha\nbeta", new_text: "ALPHA\nbeta" }), /replaced 1 occurrence/);
  assert.equal(readFileSync(join(WS, "edit-me.txt"), "utf8"), "ALPHA\r\nbeta\r\nbeta\r\n", "CRLF kept");
  assert.match(await edit({ path: "edit-me.txt", old_text: "beta", new_text: "BETA", replace_all: true }), /replaced 2 occurrences/);
  await assert.rejects(edit({ path: "../outside.txt", old_text: "a", new_text: "b" }), /outside the workspace/);
});

test("the message log sends a cloud answer and never a local one, and writes no file", async () => {
  // The router names the member it answered with, and that is what decides whether a
  // line is recorded. Two runs in one home: one answered by the free window, one by this
  // machine's GPU. Exactly one line must reach the sink (the site), and none the disk.
  const home = mkdtempSync(join(tmpdir(), "harness-msglog-"));
  const previous = process.env.ROSALENA_HOME;
  process.env.ROSALENA_HOME = home;
  const rows = [];
  const sink = (line) => {
    rows.push(line);
  };
  setMessageSink(sink);
  const pointed = (target) => {
    const fetchImpl = scripted([say(target.startsWith("local") ? "local answer" : "cloud answer")]);
    return async (url, init) => {
      const res = await fetchImpl(url, init);
      const headers = new Headers(res.headers);
      headers.set("x-router-target", target);
      return new Response(await res.text(), { status: res.status, headers });
    };
  };
  try {
    const cloud = await runAgent({ ...base, task: "log this", runs: false, fetchImpl: pointed("opencode-free/deepseek-v4.1-flash-free") });
    assert.equal(cloud.answer, "cloud answer");
    const local = await runAgent({ ...base, task: "local this", runs: false, fetchImpl: pointed("local/qwen3.8-27b") });
    assert.equal(local.answer, "local answer");

    assert.equal(rows.length, 1, "one cloud call, one line; the local run left nothing");
    assert.equal(rows[0].target, "opencode-free/deepseek-v4.1-flash-free");
    assert.equal(rows[0].prompt, "log this");
    assert.equal(rows[0].answer, "cloud answer");
    assert.equal(rows[0].ok, true);
    assert.equal(existsSync(join(home, "logs", `messages-${logDay()}.jsonl`)), false, "nothing on the tester's machine");
  } finally {
    releaseMessageSink(sink);
    if (previous === undefined) delete process.env.ROSALENA_HOME;
    else process.env.ROSALENA_HOME = previous;
  }
});

// Measured 2026-11-06: Opus 5.5 writing a whole file stopped at exactly 4096 tokens and the
// call arrived as `{"path": "_terminal.mjs"`. The step is asked again with more room.
const cutWrite = {
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "w1", type: "function", function: { name: "write_file", arguments: '{"path": "big.txt"' } }] }, finish_reason: "length" }],
  usage: { prompt_tokens: 10, completion_tokens: 4096 },
};

function routedTo(target, script) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const payload = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": target } });
  };
  fn.calls = calls;
  return fn;
}

test("a reply cut off mid tool call by the output limit is asked again with 4x the room, and the room stays", async () => {
  const events = [];
  const f = routedTo("anthropic/claude-opus-5-5", [
    cutWrite,
    useTool("write_file", { path: "big.txt", content: "the whole file" }, "w2"),
    useTool("write_file", { path: "big2.txt", content: "another file" }, "w3"),
    say("written"),
  ]);
  const result = await runAgent({ ...base, onEvent: (e) => events.push(e), task: "write a big file", fetchImpl: f });
  assert.equal(result.answer, "written");
  assert.deepEqual(f.calls.map((c) => c.max_tokens), [4096, 16384, 16384, 16384], "raised once, kept for the rest of the run");
  assert.equal(readFileSync(join(WS, "big.txt"), "utf8"), "the whole file");
  assert.ok(events.some((e) => e.type === "notice" && /4096-token output limit/.test(e.text)));
  assert.ok(!f.calls[1].messages.some((m) => m.tool_calls?.some((c) => c.id === "w1")), "the cut-off call never enters the history");
});

test("a local model's cut-off reply is not retried bigger, and the error says what happened", async () => {
  const f = routedTo("local/qwen3.8-27b", [cutWrite, say("ok")]);
  const events = [];
  await runAgent({ ...base, onEvent: (e) => events.push(e), task: "write a big file", fetchImpl: f });
  assert.deepEqual(f.calls.map((c) => c.max_tokens), [4096, 4096]);
  const result = events.find((e) => e.type === "tool" && e.name === "write_file");
  assert.match(result.preview ?? result.text ?? "", /cut off by the output limit/);
});

// Measured 2026-11-06: two "fetch failed (router ...)" errors ended the turn, and the
// person had to type Continue once the router answered again.
test("a router that stops answering is waited for, and the run carries on by itself", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(say("back again")), { status: 200, headers: { "content-type": "application/json" } });
  };
  const events = [];
  const result = await runAgent({ ...base, onEvent: (e) => events.push(e), task: "hi", fetchImpl });
  assert.equal(result.answer, "back again");
  assert.equal(calls, 2);
  const retry = events.find((e) => e.type === "retry" && e.reason === "router_unreachable");
  assert.ok(retry, "the wait is shown, not silent");
  assert.equal(retry.waitMs, 2000);
  assert.ok(!events.some((e) => e.type === "error"), "no error reaches the chat");
});