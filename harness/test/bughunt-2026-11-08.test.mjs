// Regression checks for the 2026-11-08 bug hunt: each one is a bug that was found in the
// running code and fixed, so it cannot quietly come back.
import assert from "node:assert/strict";
import { test } from "node:test";

import { growthCeiling, outputGrowth, GOAL_RUN } from "../src/agent.mjs";
import { isAffirmative, isDeferral, deferredNow, parkedSignature } from "../plugins/rosa-commit-cadence/plugin.mjs";

test("output growth starts from the tokens really used, not the smaller request", () => {
  const empty = { content: "", tool_calls: [] };
  // The router lifted a 4096 request to 32000 for Claude: 4x 4096 would ask for less than it got.
  assert.equal(outputGrowth({ finishReason: "length", message: empty, cap: 4096, used: 32000, target: "anthropic/claude-opus-5-5" }), 65536);
  // A gateway is held to 16K, the most an unknown model is safe to be asked for.
  assert.equal(growthCeiling("omniroute/some-model"), 16384);
  assert.equal(outputGrowth({ finishReason: "length", message: empty, cap: 4096, target: "omniroute/x" }), 16384);
  // Already at the ceiling: no growth, so the run does not loop on the same request.
  assert.equal(outputGrowth({ finishReason: "length", message: empty, cap: 16384, target: "omniroute/x" }), null);
  // Local models are never grown (their window is the limit), and a finished reply is not either.
  assert.equal(outputGrowth({ finishReason: "length", message: empty, cap: 4096, target: "local/qwen" }), null);
  assert.equal(outputGrowth({ finishReason: "stop", message: empty, cap: 4096, target: "anthropic/x" }), null);
  // A tool call cut off mid-arguments grows; a whole one with text does not.
  const cut = { content: "", tool_calls: [{ function: { name: "write_file", arguments: '{"path":"a","content":"half' } }] };
  assert.equal(outputGrowth({ finishReason: "length", message: cut, cap: 4096, target: "openai/gpt" }), 16384);
  const whole = { content: "done", tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a"}' } }] };
  assert.equal(outputGrowth({ finishReason: "length", message: whole, cap: 4096, target: "openai/gpt" }), null);
});

test("goal runs get the long-horizon step budget", () => {
  assert.equal(GOAL_RUN.steps, 800);
});

test("a put-off about commits is read as a put-off, and never as a yes", () => {
  for (const said of ["skip for now just use the mcp like i asked", "not now", "ok skip", "later", "don't commit", "stop asking about commits", "leave them", "nah"]) {
    assert.equal(isDeferral(said), true, said);
    assert.equal(isAffirmative(said), false, said);
  }
  // A "later" that is about something else does not stop the commit question.
  assert.equal(isDeferral("fix the tests later, first the button"), false);
  for (const said of ["yes", "commit them", "go ahead", "ok", "lgtm"]) assert.equal(isAffirmative(said), true, said);
  assert.equal(isAffirmative("ok but wait"), false);
});

test("a put-off covers only the commits held back when it was said", () => {
  const parked = [{ id: "a" }, { id: "b" }];
  const state = { parked, deferred: parkedSignature(parked) };
  assert.equal(deferredNow(state), true);
  // A new commit held back since: worth one question again.
  assert.equal(deferredNow({ ...state, parked: [...parked, { id: "c" }] }), false);
  assert.equal(deferredNow({ parked: [], deferred: "" }), false);
});
