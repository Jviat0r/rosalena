/**
 * The judge -> fix failure loop.
 *
 * `--judge` used to produce a verdict that nothing acted on. These tests hold the
 * loop to the rest of §5.2: a rejection comes back with its reasons, the model gets
 * a bounded chance to fix the cause, and the run says honestly whether it passed.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { evidenceDigest, judgeAnswer, runAgent } from "../src/agent.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-judge-"));
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

/** A judge reply. `pass:false` is what the fix loop exists for. */
const verdictOf = (pass, reasons = "not verified", next = "") =>
  say(JSON.stringify({ pass, reasons, ...(next ? { next } : {}) }));

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

/** The user messages the model was sent on its Nth call, for reading the fix prompt. */
const userMessages = (call) => call.body.messages.filter((m) => m.role === "user").map((m) => m.content);

const base = { root: WS, onEvent: () => {}, useJudge: true };

test("a rejected answer comes back with its reasons and the corrected answer passes", async () => {
  const f = scripted([
    say("the answer is 42"),
    verdictOf(false, "42 is not in the file", "read hello.txt and count"),
    say("the file has two lines"),
    verdictOf(true, "verified against the file"),
  ]);
  const result = await runAgent({ ...base, task: "how many lines", fetchImpl: f });

  assert.equal(result.answer, "the file has two lines");
  assert.equal(result.verdict.pass, true);
  assert.equal(result.fixes, 1, "one fix round was spent");
  assert.equal(result.steps, 2);
  assert.equal(f.calls.length, 4, "model, judge, model, judge");
});

test("the fix prompt carries the reasons and tells the model to fix the cause", async () => {
  const f = scripted([
    say("done, I wrote the file"),
    verdictOf(false, "no write_file call was made", "actually write it"),
    say("now written"),
    verdictOf(true, "ok"),
  ]);
  await runAgent({ ...base, task: "write the report", fetchImpl: f });

  const users = userMessages(f.calls[2]);
  assert.equal(users.length, 2, "the task, then the reviewer");
  assert.equal(users[0], "write the report", "the original task is untouched");
  assert.match(users[1], /no write_file call was made/);
  assert.match(users[1], /actually write it/);
  assert.match(users[1], /Fix the cause rather than the wording/);
  // The rejected answer stays in the history: the model must be able to see what it said.
  const roles = f.calls[2].body.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
});

test("a fix round buys its own steps instead of fitting into what is left", async () => {
  const f = scripted([
    useTool("read_file", { path: "hello.txt" }),
    say("two lines"),
    verdictOf(false, "you counted but did not say which line is last", "name the last line"),
    say("the last line is 'line two'"),
    verdictOf(true, "correct"),
  ]);
  const result = await runAgent({ ...base, task: "which line is last", fetchImpl: f, maxSteps: 2 });

  assert.equal(result.answer, "the last line is 'line two'");
  assert.equal(result.steps, 3, "step 3 happened past the original maxSteps of 2");
  assert.equal(result.stopped, undefined, "the run was not cut off at max_steps");
});

test("maxFixes: 0 leaves the judge as a verdict nothing acts on", async () => {
  const f = scripted([say("an answer"), verdictOf(false, "not good enough")]);
  const result = await runAgent({ ...base, task: "x", fetchImpl: f, maxFixes: 0 });

  assert.equal(f.calls.length, 2, "no second model call was made");
  assert.equal(result.fixes, 0);
  assert.equal(result.verdict.pass, false);
  assert.equal(result.answer, "an answer");
});

test("the fix rounds stop at the limit and the run ends rejected", async () => {
  const events = [];
  const f = scripted([say("still wrong"), verdictOf(false, "still not verified")]);
  const result = await runAgent({ ...base, task: "x", fetchImpl: f, maxFixes: 2, onEvent: (e) => events.push(e) });

  assert.equal(result.fixes, 2);
  assert.equal(result.verdict.pass, false, "a rejection after the last fix round is reported as a rejection");
  assert.equal(f.calls.length, 6, "3 model calls, 3 judge calls");
  const fixes = events.filter((e) => e.type === "fix");
  assert.deepEqual(fixes.map((e) => e.attempt), [1, 2]);
  assert.equal(fixes[0].of, 2);
  assert.match(fixes[0].reasons, /not verified/);
});

test("a judge that cannot be reached does not spend a fix round", async () => {
  const f = scripted([say("an answer"), new Response("judge is down", { status: 503 })]);
  const result = await runAgent({ ...base, task: "x", fetchImpl: f });

  assert.equal(f.calls.length, 2, "an unreachable judge must not send the model back to work");
  assert.equal(result.fixes, 0);
  assert.equal(result.verdict.pass, null);
  assert.match(result.verdict.reasons, /judge unavailable/);
});

test("a fix round can use tools, and the judge is asked again about the result", async () => {
  const f = scripted([
    say("the report is written"),
    verdictOf(false, "there is no report on disk", "write report.txt"),
    useTool("write_file", { path: "report.txt", content: "real work\n" }),
    say("report.txt now says real work"),
    verdictOf(true, "the file exists"),
  ]);
  const result = await runAgent({ ...base, task: "write the report", fetchImpl: f });

  assert.equal(result.fixes, 1);
  assert.equal(result.steps, 3);
  assert.equal(readFileSync(join(WS, "report.txt"), "utf8"), "real work\n");
  assert.equal(result.verdict.pass, true);
});

test("the judge is given the evidence of what the run did", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" }), say("two lines"), verdictOf(true, "ok")]);
  await runAgent({ ...base, task: "count the lines", fetchImpl: f });

  const judgePrompt = f.calls[2].body.messages[1].content;
  assert.match(judgePrompt, /EVIDENCE:/);
  assert.match(judgePrompt, /read_file\(\{"path":"hello\.txt"\}\)/);
  assert.match(judgePrompt, /line one/, "the tool result is quoted back to the judge");
  assert.match(judgePrompt, /ANSWER:\n\s*two lines/, "the answer being judged is the one after the evidence");
});

test("a run that called no tools says so rather than showing an empty evidence block", async () => {
  const f = scripted([say("I definitely did it"), verdictOf(true, "ok")]);
  await runAgent({ ...base, task: "do the thing", fetchImpl: f });
  assert.match(f.calls[1].body.messages[1].content, /no tools were called in this run/);
});

test("the evidence digest is bounded, and says what it dropped", () => {
  const messages = [];
  for (let i = 0; i < 20; i += 1) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: `c${i}`, function: { name: "read_file", arguments: JSON.stringify({ path: `f${i}.txt` }) } }],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: `contents of f${i} `.repeat(40) });
  }
  const digest = evidenceDigest(messages);
  assert.ok(digest.length <= 2400, `digest was ${digest.length} chars`);
  assert.match(digest, /8 earlier call\(s\) omitted/);
  assert.match(digest, /read_file\(\{"path":"f19\.txt"\}\)/, "the newest call is kept");
  assert.ok(!digest.includes("f0.txt"), "the oldest calls are the ones dropped");
});

test("the digest reports a tool that never returned a result", () => {
  const digest = evidenceDigest([
    { role: "assistant", content: "", tool_calls: [{ id: "gone", function: { name: "run_command", arguments: '{"command":"x"}' } }] },
  ]);
  assert.match(digest, /no result recorded/);
});

test("judgeAnswer sees the evidence it is handed, and survives a judge that is not JSON", async () => {
  const f = scripted([say("prose, not JSON at all")]);
  const verdict = await judgeAnswer({ routerUrl: "http://x/v1", task: "t", answer: "a", evidence: "read_file() -> ok", fetchImpl: f });
  assert.equal(verdict.pass, null, "unparseable judge output is not a pass");
  assert.equal(verdict.raw, "prose, not JSON at all");
  assert.match(f.calls[0].body.messages[1].content, /EVIDENCE:\nread_file\(\) -> ok/);
});

test("a passed answer never spends a fix round or emits a fix event", async () => {
  const events = [];
  const f = scripted([say("a good answer"), verdictOf(true, "verified")]);
  const result = await runAgent({ ...base, task: "x", fetchImpl: f, onEvent: (e) => events.push(e) });
  assert.equal(result.fixes, 0);
  assert.equal(events.some((e) => e.type === "fix"), false);
  const judge = events.find((e) => e.type === "judge");
  assert.equal(judge.pass, true);
  assert.equal(judge.fixable, false);
  assert.equal(judge.of, 2, "the log says how many judgments the judge was allowed");
});

test("a run that fails at the model call never reaches the judge", async () => {
  const f = scripted([new Response("router exploded", { status: 500 })]);
  const result = await runAgent({ ...base, task: "x", fetchImpl: f });
  assert.equal(result.stopped, "router_error");
  assert.equal(f.calls.length, 1);
  assert.equal(result.verdict, undefined, "nothing was judged, because nothing was answered");
});

test("the worker never judges itself, however the parent was configured", async () => {
  const f = scripted([
    useTool("delegate", { task: "sub-task" }),
    say("worker answer"),
    say("orchestrator answer"),
    verdictOf(true, "ok"),
  ]);
  const result = await runAgent({ ...base, task: "delegate it", fetchImpl: f });
  assert.equal(result.answer, "orchestrator answer");
  const judgeCalls = f.calls.filter((c) => c.body.model === "judge");
  assert.equal(judgeCalls.length, 1, "only the orchestrator's answer was judged");
  assert.match(judgeCalls[0].body.messages[1].content, /orchestrator answer/);
});
