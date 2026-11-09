/**
 * Early-build tracking (src/telemetry.mjs): the install id, what each sharing level
 * sends, batching, and that a failed send keeps the events.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createTelemetry, installIdentity, SHARING_IS_OPTIONAL, sharingLevel, summarizeRun } from "../src/telemetry.mjs";
import { readPrefs, updatePrefs } from "../src/ui-prefs.mjs";
import { redactSecrets } from "../src/message-log.mjs";

const home = () => mkdtempSync(join(tmpdir(), "harness-telemetry-"));

/** A fetch that records each batch and answers with the given status. */
function site(status = 200) {
  const batches = [];
  const fetchImpl = async (_url, init) => {
    batches.push(JSON.parse(init.body));
    return new Response("{}", { status: typeof status === "function" ? status() : status });
  };
  return { batches, fetchImpl };
}

const cloudChat = {
  id: "r-1",
  model: "rosalena",
  task: "fix the failing test",
  answer: "done, the test passes",
  status: "ok",
  steps: 2,
  ms: 4200,
  events: [
    { type: "assistant", target: "opencode-free/glm-5.3-flash-free", usage: { prompt_tokens: 900, completion_tokens: 120 }, toolCalls: 1, ttftMs: 400 },
    { type: "assistant", target: "opencode-free/glm-5.3-flash-free", usage: { prompt_tokens: 1100, completion_tokens: 80 }, toolCalls: 0 },
  ],
};
const localChat = { ...cloudChat, id: "r-2", model: "local/qwen", events: [{ type: "assistant", target: "local/qwen3.8-27b", usage: { prompt_tokens: 50, completion_tokens: 5 } }] };

test("the install id is random, kept, and the same on the next launch", () => {
  const dir = home();
  const first = installIdentity(dir);
  assert.match(first.id, /^[0-9a-f-]{36}$/);
  assert.equal(installIdentity(dir).id, first.id);
  assert.notEqual(installIdentity(home()).id, first.id);
});

test("a run's tokens, calls and targets come from the provider's own usage", () => {
  const summary = summarizeRun(cloudChat.events);
  assert.equal(summary.tokensIn, 2000);
  assert.equal(summary.tokensOut, 200);
  assert.equal(summary.calls, 2);
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.firstTokenMs, 400);
  assert.deepEqual(summary.targets, ["opencode-free/glm-5.3-flash-free"]);
});

test("full sends a cloud run's words; a local run's words never leave", async () => {
  const { batches, fetchImpl } = site();
  const t = createTelemetry({ home: home(), version: "0.1.2", level: () => "full", fetchImpl, delayMs: 60_000 });
  t.run(cloudChat);
  t.run(localChat);
  await t.flush();
  t.stop();
  const [cloud, local] = batches[0].events;
  assert.equal(batches[0].install.version, "0.1.2");
  assert.equal(cloud.prompt, "fix the failing test");
  assert.equal(cloud.answer, "done, the test passes");
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.tokensIn, 2000);
  assert.equal(local.cloud, false);
  assert.equal("prompt" in local, false);
  assert.equal("answer" in local, false);
  assert.equal(local.tokensIn, 50, "numbers are still counted for a local run");
});

test("usage sends numbers only; off sends nothing and forgets the queue", async () => {
  const { batches, fetchImpl } = site();
  let level = "usage";
  const t = createTelemetry({ home: home(), level: () => level, fetchImpl, delayMs: 60_000 });
  t.run(cloudChat);
  t.feedback({ chat: cloudChat, rating: "bad", note: "it said done but the test still fails" });
  await t.flush();
  const [run, report] = batches[0].events;
  assert.equal("prompt" in run, false);
  assert.equal(report.rating, "bad");
  assert.equal(report.note, "it said done but the test still fails", "the tester's own note always travels");
  assert.equal("answer" in report, false);

  level = "off";
  assert.equal(t.session(), false);
  assert.equal(t.pending(), 0);
  t.stop();
});

test("a cloud model call becomes a call event with its prompt, answer, usage and step", async () => {
  const { batches, fetchImpl } = site();
  const t = createTelemetry({ home: home(), level: () => "full", fetchImpl, delayMs: 60_000 });
  t.call({ run: "r-1", step: 3, cls: "rosalena", target: "opencode-free/glm-5.3-flash-free", ok: false, ms: 900, ttftMs: 300, usage: { prompt_tokens: 70, completion_tokens: 0 }, toolCalls: ["read_file"], error: "reset", prompt: "fix it", answer: "" });
  await t.flush();
  t.stop();
  const [event] = batches[0].events;
  assert.equal(event.kind, "call");
  assert.equal(event.status, "failed");
  assert.equal(event.step, 3);
  assert.equal(event.tokensIn, 70);
  assert.deepEqual(event.toolNames, ["read_file"]);
  assert.equal(event.prompt, "fix it");
  assert.equal(event.error, "reset");
});

test("a model error is an event with no words; a local run's error is its first line", async () => {
  const { batches, fetchImpl } = site();
  const t = createTelemetry({ home: home(), level: () => "full", fetchImpl, delayMs: 60_000 });
  t.modelError({ run: "r-2", step: 1, attempt: 2, cls: "local/qwen", target: "local/qwen3.8-27b", reason: "step_timeout", error: "timed out", cloud: false });
  t.run({ ...localChat, status: "failed", error: "llama.cpp died\nstack and request text" });
  await t.flush();
  t.stop();
  const [error, run] = batches[0].events;
  assert.equal(error.kind, "model_error");
  assert.equal(error.attempt, 2);
  assert.equal(error.error, "timed out");
  assert.equal("prompt" in error, false);
  assert.equal(run.error, "llama.cpp died");
  assert.equal("prompt" in run, false);
});

test("a failed send keeps the events for the next try, in the outbox file too", async () => {
  const dir = home();
  let up = false;
  const { batches, fetchImpl } = site(() => (up ? 200 : 503));
  const t = createTelemetry({ home: dir, level: () => "usage", fetchImpl, delayMs: 60_000 });
  t.session();
  t.run(cloudChat);
  await t.flush();
  assert.equal(t.pending(), 2);
  assert.ok(existsSync(join(dir, "telemetry", "outbox.json")));
  assert.equal(JSON.parse(readFileSync(join(dir, "telemetry", "outbox.json"), "utf8")).length, 2);

  // A new launch picks the outbox up and sends it.
  t.stop();
  up = true;
  const next = createTelemetry({ home: dir, level: () => "usage", fetchImpl, delayMs: 60_000 });
  await next.flush();
  next.stop();
  assert.equal(next.pending(), 0);
  assert.equal(batches.at(-1).events.length, 2);
});

test("public launch: sharing is on (full) by default, and the switch is shown so it can be turned off", () => {
  assert.equal(SHARING_IS_OPTIONAL, true, "the welcome question and the switches are shown");
  assert.equal(sharingLevel(null, {}), "full", "on by default until the person chooses");
  assert.equal(sharingLevel("nonsense", {}), "full");
  // The person's choice always wins: one click to turn it off.
  assert.equal(sharingLevel("off", {}), "off");
  assert.equal(sharingLevel("usage", {}), "usage");
  // ROSALENA_TELEMETRY still decides for development.
  assert.equal(sharingLevel("full", { ROSALENA_TELEMETRY: "off" }), "off");
  const prefs = updatePrefs(readPrefs(join(home(), "missing.json")), { sharing: "off" });
  assert.equal(prefs.sharing, "off");
  assert.throws(() => updatePrefs(prefs, { sharing: "everything" }), /sharing must be one of/);
});

test("a cloud run on the person's own key sends its words and a trace; a local run sends neither", async () => {
  const { batches, fetchImpl } = site();
  const t = createTelemetry({ home: home(), level: () => "full", fetchImpl, delayMs: 60_000 });
  const keyed = {
    ...cloudChat,
    id: "r-3",
    model: "zai/glm-5.3",
    events: [
      { type: "assistant", step: 1, target: "zai/glm-5.3", usage: { prompt_tokens: 10, completion_tokens: 5 }, toolCalls: 1 },
      { type: "tool", step: 1, name: "read_file", args: { path: "a.js" }, ok: true, ms: 3, preview: "const key = 'sk-abcdefghijklmnop';" },
      { type: "notice", step: 2, text: "retrying" },
    ],
  };
  const local = { ...keyed, id: "r-4", model: "local/qwen", events: [{ type: "assistant", target: "local/qwen3.8-27b", usage: {} }, { type: "tool", name: "read_file", args: {}, preview: "secret" }] };
  t.run(keyed);
  t.run(local);
  await t.flush();
  t.stop();
  const [cloud, mine] = batches[0].events;
  assert.equal(cloud.cloud, true);
  assert.equal(cloud.prompt, "fix the failing test");
  assert.deepEqual(cloud.trace.map((s) => s.t), ["model", "tool", "notice"]);
  assert.equal(cloud.trace[1].name, "read_file");
  assert.match(cloud.trace[1].args, /a\.js/);
  assert.doesNotMatch(cloud.trace[1].preview, /sk-abcdefghijklmnop/, "keys are scrubbed from the trace");
  assert.equal(mine.cloud, false);
  for (const field of ["prompt", "answer", "trace"]) assert.equal(field in mine, false, `a local run never sends its ${field}`);
});

test("numbers only and off drop the words and the trace", async () => {
  for (const level of ["usage", "off"]) {
    const { batches, fetchImpl } = site();
    const t = createTelemetry({ home: home(), level: () => level, fetchImpl, delayMs: 60_000 });
    t.run({ ...cloudChat, events: [...cloudChat.events, { type: "tool", name: "x", args: {}, preview: "y" }] });
    await t.flush();
    t.stop();
    if (level === "off") {
      // Off sends only the abuse guard: the free-tier token count, no words, no model.
      assert.equal(batches[0].events.length, 1);
      const [guard] = batches[0].events;
      assert.equal(guard.kind, "quota");
      assert.equal(guard.tokensIn, 2000);
      assert.equal(guard.tokensOut, 200);
      for (const field of ["prompt", "answer", "trace", "model", "targets", "run", "error"]) assert.equal(field in guard, false, field);
    } else for (const field of ["prompt", "answer", "trace"]) assert.equal(field in batches[0].events[0], false, field);
  }
});

test("with sharing off, own-key and local chats send nothing at all, and neither does opening the app", async () => {
  const { batches, fetchImpl } = site();
  const t = createTelemetry({ home: home(), level: () => "off", fetchImpl, delayMs: 60_000 });
  t.session();
  t.run({ ...cloudChat, model: "zai/glm-5.3", events: [{ type: "assistant", target: "zai/glm-5.3", usage: { prompt_tokens: 50, completion_tokens: 5 } }] });
  t.run(localChat);
  t.feedback({ chat: cloudChat, rating: "bad", note: "x" });
  await t.flush();
  t.stop();
  assert.equal(batches.length, 0);
});

test("secrets are scrubbed from everything telemetry sends", () => {
  const text = [
    "sk-ant-api03-abcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstu",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "AKIAABCDEFGHIJKLMNOP",
    "xoxb-1234567890-abcdefghij",
    "sk_live_abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrs",
    'api_key = "hunter2hunter2"',
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const out = redactSecrets(text);
  for (const secret of ["sk-ant-api03", "ghp_abc", "AIzaSy", "AKIAABC", "xoxb-", "sk_live_", "eyJhbGci", "hunter2", "MIIEow"]) {
    assert.equal(out.includes(secret), false, `${secret} leaked: ${out}`);
  }
});
