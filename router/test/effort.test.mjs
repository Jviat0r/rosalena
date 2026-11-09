
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildUpstreamRequest } from "../src/providers.mjs";

/**
 * Reasoning effort is a per-provider capability, and these are the three promises that
 * make it safe to offer in a picker at all: it survives only where the provider declares
 * it, it is deleted (not merely ignored) everywhere else so a failover cannot turn a
 * preference into a 400, and a provider that needs a switch flipped to make effort mean
 * anything gets that switch even though `extraBody` says otherwise.
 */
test("reasoning_effort: kept only where the provider declares it", () => {
  const spec = { kind: "openai", baseUrl: "https://example.test/v1", efforts: ["low", "medium", "high"] };
  const { init } = buildUpstreamRequest({
    spec,
    model: "m",
    body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
  });
  assert.equal(JSON.parse(init.body).reasoning_effort, "high");
});

test("reasoning_effort: deleted for a provider that does not declare the vocabulary", () => {
  const spec = { kind: "openai", baseUrl: "https://example.test/v1" };
  const { init } = buildUpstreamRequest({
    spec,
    model: "m",
    body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
  });
  assert.equal("reasoning_effort" in JSON.parse(init.body), false, "a provider that never agreed to it must not receive it");
});

test("reasoning_effort: deleted (not passed through) when the value is outside the declared set", () => {
  const spec = { kind: "openai", baseUrl: "https://example.test/v1", efforts: ["low", "medium"] };
  const { init } = buildUpstreamRequest({
    spec,
    model: "m",
    body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
  });
  assert.equal("reasoning_effort" in JSON.parse(init.body), false, "high is not in low|medium, so it is not sent");
});

test("effortBody: merged after extraBody, so effort can flip the switch it depends on", () => {
  // Measured locally: the served template gates its reasoning block behind a flag that
  // `extraBody` holds at false, so effort without this merge is accepted and ignored.
  const spec = {
    kind: "openai",
    baseUrl: "https://example.test/v1",
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
    efforts: ["low", "medium", "high"],
    effortBody: { chat_template_kwargs: { enable_thinking: true } },
  };
  const asked = buildUpstreamRequest({
    spec,
    model: "m",
    body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" },
  });
  assert.deepEqual(JSON.parse(asked.init.body).chat_template_kwargs, { enable_thinking: true });

  const unasked = buildUpstreamRequest({
    spec,
    model: "m",
    body: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.deepEqual(
    JSON.parse(unasked.init.body).chat_template_kwargs,
    { enable_thinking: false },
    "a request that asked for no effort keeps the provider's own default",
  );
});
