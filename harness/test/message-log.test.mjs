// The message log is a bug-report tool, so the tests are about the promises it makes:
// only the cloud models' text is recorded, it goes to the site (the sink) and not to a
// file on the tester's machine, and nothing it does can break a run. Everything runs
// against a temp directory - never the real ROSALENA_HOME.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeMessageLog,
  logDay,
  messageLogPath,
  messageLogSettings,
  recordCloudCall,
  recordModelError,
  redactSecrets,
  releaseMessageSink,
  setMessageSink,
  tracksCloudTarget,
} from "../src/message-log.mjs";

const tempHome = () => mkdtempSync(join(tmpdir(), "rosalena-msglog-"));
const lines = (path) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
/** A sink that keeps what it is handed. */
const collector = () => {
  const got = [];
  const sink = (line) => {
    got.push(line);
  };
  return { got, sink };
};

test("only the free cloud window and the assistant are tracked; a local model never is", () => {
  // GLM and DeepSeek arrive as opencode-free/<model>; Rosalena is its own class.
  assert.equal(tracksCloudTarget("opencode-free/glm-5.3-flash-free"), true);
  assert.equal(tracksCloudTarget("opencode-free/deepseek-v4.1-flash-free"), true);
  assert.equal(tracksCloudTarget("rosalena"), true);
  assert.equal(tracksCloudTarget("deepseek"), true);
  // This machine's GPU, and clouds the person brought themselves.
  assert.equal(tracksCloudTarget("local/qwen3.8-27b"), false);
  assert.equal(tracksCloudTarget("anthropic/claude-sonnet-4-5"), false);
  assert.equal(tracksCloudTarget("openrouter/anthropic/claude-sonnet-4.5"), false);
  // No target yet (the call failed): only a cloud-only class is enough to know.
  assert.equal(tracksCloudTarget(null, "rosalena"), true);
  assert.equal(tracksCloudTarget(null, "orchestrate"), false);
  assert.equal(tracksCloudTarget("", ""), false);
});

test("the switch: on by default, no local copy by default, maxChars clamped", () => {
  assert.equal(messageLogSettings({ config: {}, env: {} }).enabled, true);
  assert.equal(messageLogSettings({ config: {}, env: {} }).local, false);
  assert.equal(messageLogSettings({ config: { messageLog: { local: true } }, env: {} }).local, true);
  assert.equal(messageLogSettings({ config: { messageLog: { enabled: false } }, env: {} }).enabled, false);
  // The environment wins both ways, so a support answer can be one launch long.
  assert.equal(messageLogSettings({ config: { messageLog: { enabled: true } }, env: { ROSALENA_MESSAGE_LOG: "off" } }).enabled, false);
  assert.equal(messageLogSettings({ config: { messageLog: { enabled: false } }, env: { ROSALENA_MESSAGE_LOG: "on" } }).enabled, true);
  assert.equal(messageLogSettings({ config: { messageLog: { maxChars: 1 } }, env: {} }).maxChars, 200);
  assert.equal(messageLogSettings({ config: { messageLog: { maxChars: 999999 } }, env: {} }).maxChars, 100_000);
  assert.equal(messageLogSettings({ config: {}, env: {} }).maxChars, 4000);
});

test("a cloud call goes to the sink with its prompt, answer and metadata, and no file is written", () => {
  const home = tempHome();
  const { got, sink } = collector();
  const at = new Date(2026, 9, 22, 12, 0);
  const result = recordCloudCall(
    {
      at: at.toISOString(),
      run: "run-1",
      step: 2,
      role: "code",
      cls: "code",
      requested: "opencode-free/deepseek-v4.1-flash-free",
      target: "opencode-free/deepseek-v4.1-flash-free",
      model: "deepseek-v4.1-flash-free",
      ms: 1200,
      usage: { prompt_tokens: 10, completion_tokens: 4 },
      toolCalls: ["read_file"],
      charsOut: 5,
      ok: true,
      prompt: "why did the build fail?",
      answer: "look at the log",
    },
    { home, config: {}, env: {}, now: at, sink },
  );
  assert.equal(result.sent, true);
  assert.equal(result.path, null);
  assert.equal(existsSync(join(home, "logs")), false, "nothing on the tester's machine");
  const [row] = got;
  assert.equal(row.run, "run-1");
  assert.equal(row.target, "opencode-free/deepseek-v4.1-flash-free");
  assert.equal(row.prompt, "why did the build fail?");
  assert.equal(row.answer, "look at the log");
  assert.deepEqual(row.toolCalls, ["read_file"]);
  assert.equal(row.ok, true);
  assert.equal(row.truncated, false);
});

test("the registered sink is used, and a replaced server does not unhook its successor", () => {
  const first = collector();
  const second = collector();
  setMessageSink(first.sink);
  setMessageSink(second.sink);
  releaseMessageSink(first.sink); // the old server closing after the new one started
  recordCloudCall({ target: "opencode-free/glm-5.3-flash-free", prompt: "x", answer: "y", ok: true }, { home: tempHome(), config: {}, env: {} });
  assert.equal(first.got.length, 0);
  assert.equal(second.got.length, 1);
  releaseMessageSink(second.sink);
  const after = recordCloudCall({ target: "opencode-free/glm-5.3-flash-free", prompt: "x", answer: "y", ok: true }, { home: tempHome(), config: {}, env: {} });
  assert.equal(after.sent, false);
});

test("a developer's local copy is one file per local day under <home>/logs", () => {
  const now = new Date(2026, 9, 22, 23, 30); // local time, month is 0-based
  assert.equal(logDay(now), "2026-10-22");
  assert.equal(messageLogPath({ home: "C:\\data", now }), join("C:\\data", "logs", "messages-2026-10-22.jsonl"));
  const home = tempHome();
  const result = recordCloudCall(
    { target: "opencode-free/glm-5.3-flash-free", prompt: "p", answer: "a", ok: true },
    { home, config: { messageLog: { local: true } }, env: {}, now, sink: null },
  );
  assert.equal(result.path, join(home, "logs", "messages-2026-10-22.jsonl"));
  assert.equal(lines(result.path)[0].prompt, "p");
});

test("a local model records nothing, so a run on this GPU leaves no transcript anywhere", () => {
  const { got, sink } = collector();
  const result = recordCloudCall(
    { target: "local/qwen3.8-27b", cls: "code", ok: true, prompt: "private", answer: "private" },
    { home: tempHome(), config: { messageLog: { local: true } }, env: {}, sink },
  );
  assert.equal(result, null);
  assert.equal(got.length, 0);
});

test("a long exchange is cut at maxChars and says so", () => {
  const { got, sink } = collector();
  // maxChars bottoms out at 200: a shorter cap would store an unusable fragment.
  recordCloudCall(
    { target: "opencode-free/glm-5.3-flash-free", prompt: "a".repeat(250), answer: "b".repeat(250), ok: true },
    { home: tempHome(), config: { messageLog: { maxChars: 200 } }, env: {}, sink },
  );
  const [row] = got;
  assert.equal(row.truncated, true);
  assert.match(row.prompt, /^a{200}\n\[cut 50 chars\]$/);
  assert.match(row.answer, /^b{200}\n\[cut 50 chars\]$/);
});

test("a failure is recorded with the provider's words, and a key in them is not", () => {
  const { got, sink } = collector();
  recordCloudCall(
    {
      target: "rosalena",
      cls: "rosalena",
      ok: false,
      error: "upstream said 401 for Authorization: Bearer oc_sk_live_abcdef123456",
      prompt: "hello",
      answer: "",
    },
    { home: tempHome(), config: {}, env: {}, sink },
  );
  const [row] = got;
  assert.equal(row.ok, false);
  assert.equal(row.target, "rosalena");
  assert.doesNotMatch(row.error, /oc_sk_live_abcdef123456/);
  assert.match(row.error, /\[redacted\]/);
  assert.equal(row.answer, undefined, "an empty answer is not stored as an empty field");
});

test("a failed attempt on a local model sends its first error line and no words", () => {
  const { got, sink } = collector();
  recordModelError(
    { run: "r-7", step: 2, attempt: 1, cls: "local/qwen", target: "local/qwen3.8-27b", reason: "call_failed", error: "context size exceeded (8192)\nrequest body: {\"messages\":[\"my private code\"]}", prompt: "secret" },
    { config: {}, env: {}, sink },
  );
  const [line] = got;
  assert.equal(line.kind, "model_error");
  assert.equal(line.cloud, false);
  assert.equal(line.error, "context size exceeded (8192)");
  assert.equal(JSON.stringify(line).includes("my private code"), false);
  assert.equal("prompt" in line, false);
  // A cloud model's error keeps its detail, still with any key scrubbed.
  recordModelError({ cls: "rosalena", target: "opencode-free/glm-5.3-flash-free", error: "502 upstream\nBearer abcdefghijklmnop" }, { config: {}, env: {}, sink });
  assert.equal(got[1].cloud, true);
  assert.match(got[1].error, /502 upstream\nBearer \[redacted\]/);
  // The router's real shape: the provider's message inside JSON, its break escaped.
  recordModelError(
    { cls: "local/qwen", target: "local/qwen3.8-27b", error: 'router returned 500 for class "local/qwen3.8-27b": {"error":{"message":"context size exceeded (8192)\\nprompt was: MY PRIVATE TASK"}}' },
    { config: {}, env: {}, sink },
  );
  assert.equal(got[2].error, 'router returned 500 for class "local/qwen3.8-27b": context size exceeded (8192)');
  assert.equal(got[2].error.includes("PRIVATE"), false);
  // No sink, nothing recorded; logging off, nothing recorded.
  assert.equal(recordModelError({ error: "x" }, { config: {}, env: {}, sink: null }), null);
  assert.equal(recordModelError({ error: "x" }, { config: { messageLog: { enabled: false } }, env: {}, sink }), null);
});

test("redaction covers the shapes a key actually takes", () => {
  assert.equal(redactSecrets("key sk-ABCDEF123456 end"), "key [redacted] end");
  assert.equal(redactSecrets("oc_sk_abc_DEF-123"), "[redacted]");
  assert.equal(redactSecrets("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [redacted]");
  assert.equal(redactSecrets("ordinary text, no key"), "ordinary text, no key");
});

test("a sink that throws or a home that cannot be written costs a line, never the run", () => {
  const home = tempHome();
  const blocked = join(home, "blocked");
  writeFileSync(blocked, "not a directory"); // mkdir under it fails with ENOTDIR
  const result = recordCloudCall(
    { target: "opencode-free/glm-5.3-flash-free", prompt: "x", answer: "y", ok: true },
    {
      home: blocked,
      config: { messageLog: { local: true } },
      env: {},
      sink: () => {
        throw new Error("network down");
      },
    },
  );
  assert.equal(result.sent, false);
  assert.equal(result.path, null);
});

test("turning it off records nothing at all", () => {
  const { got, sink } = collector();
  assert.equal(
    recordCloudCall({ target: "opencode-free/glm-5.3-flash-free", prompt: "x", answer: "y", ok: true }, { home: tempHome(), config: { messageLog: { enabled: false } }, env: {}, sink }),
    null,
  );
  assert.equal(got.length, 0);
});

test("the description says where the lines go and what is never recorded", () => {
  const home = tempHome();
  const shown = describeMessageLog({ home, config: {}, env: {} });
  assert.equal(shown.enabled, true);
  assert.equal(shown.path, null);
  assert.match(shown.where, /the site/);
  assert.match(shown.note, /Local models are never recorded/);
  const local = describeMessageLog({ home, config: { messageLog: { local: true } }, env: {} });
  assert.equal(local.path, join(home, "logs", `messages-${logDay()}.jsonl`));
  const off = describeMessageLog({ home, config: { messageLog: { enabled: false } }, env: {} });
  assert.equal(off.enabled, false);
  assert.match(off.note, /off/);
});
