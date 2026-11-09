/**
 * The other two 503s from the 2026-11-06 session must read as themselves:
 *
 *   - `anthropic/claude-opus-5-5` skipped with `over_budget` (cap 40, spent 40.1498):
 *     the router never sent the request, so "retry later" is the one wrong answer.
 *   - `local/nemotron-3-nano-omni` answered 500 in 89 ms because the server on :8080 was
 *     serving qwen: a model mismatch, not a broken server.
 *
 * Both now come with a sentence from the router (src/router.mjs), and both need a rule
 * here so the annotation stops saying "the provider had a server error".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { explain } from "../src/error-explain.mjs";

test("a spent monthly cap is explained as a cap, not as a server error", () => {
  const message =
    'router returned 503 for class "anthropic/claude-opus-5-5": {"error":{"message":"every target in the chain failed","type":"router_error","code":503,"router":{"attempts":[{"target":"anthropic/claude-opus-5-5","ok":false,"reason":"over_budget","skipped":true,"capUsd":40,"spentUsd":40.149774}]}}}';
  const e = explain({ message }, "anthropic/claude-opus-5-5");
  assert.equal(e.key, "OVER-BUDGET");
  assert.equal(e.retryHelps, false);
  assert.match(e.meaning, /\$40\.15 spent against a \$40\.00 monthly cap/);
  assert.match(e.action, /Settings > Spend limits/);
});

test("the router's own cap sentence is matched even without the attempts JSON", () => {
  const message =
    'router returned 503 for class "rosalena": The monthly spend cap for anthropic is used up ($40.15 spent, cap $40.00), so the request was never sent. {"error":{"message":"every target in the chain failed"}}';
  const e = explain({ message }, "rosalena");
  assert.equal(e.key, "OVER-BUDGET");
  assert.doesNotMatch(e.action, /Retry later/);
});

test("a local model mismatch names the loaded model instead of blaming the server", () => {
  const message =
    'router returned 503 for class "local/nemotron-3-nano-omni": The local server on :8080 has "qwen3.8-27b" loaded, not "nemotron-3-nano-omni". Pick qwen3.8-27b in the model picker, or start nemotron-3-nano-omni before using it. {"error":{"message":"every target in the chain failed","type":"router_error","code":503,"router":{"attempts":[{"target":"local/nemotron-3-nano-omni","ok":false,"reason":"upstream_500","status":500,"ms":89,"loadedModel":"qwen3.8-27b"}]}}}';
  const e = explain({ message }, "local/nemotron-3-nano-omni", { local: true });
  assert.equal(e.key, "LOCAL-WRONG-MODEL");
  assert.equal(e.retryHelps, false);
  assert.match(e.meaning, /serving qwen3\.8-27b/);
  assert.match(e.action, /Pick qwen3\.8-27b/);
});

test("a local 500 with no evidence still reads as a server error", () => {
  // No probe answer: do not invent a model mismatch that was never observed.
  const message =
    'router returned 503 for class "local/qwen3.8-27b": {"error":{"message":"every target in the chain failed","type":"router_error","code":503,"router":{"attempts":[{"target":"local/qwen3.8-27b","ok":false,"reason":"upstream_500","status":500,"ms":89}]}}}';
  const e = explain({ message }, "local/qwen3.8-27b", { local: true });
  assert.equal(e.key, "SERVER-ERROR");
  assert.equal(e.retryHelps, true);
});

test("the small-window refusal says what the run did about it", () => {
  const message =
    'router returned 400 for class "local/qwen3.8-27b": {"error":{"message":"request (36630 tokens) exceeds the available context size (32768 tokens), try increasing it","type":"invalid_request_error"}}';
  const e = explain({ message }, "local/qwen3.8-27b", { local: true });
  assert.equal(e.key, "LOCAL-CTX-TOO-SMALL");
  assert.match(e.meaning, /32,768/);
  assert.match(e.action, /start-qwen\.ps1/);
});
