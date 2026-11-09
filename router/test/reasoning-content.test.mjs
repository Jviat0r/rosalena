/**
 * Thinking-mode history: the `reasoning_content` round trip.
 *
 * DeepSeek in thinking mode refuses a history whose assistant turns do not
 * carry their reasoning back:
 *
 *   400 invalid_request_error: The `reasoning_content` in the thinking mode
 *   must be passed back to the API.
 *
 * Which is what a caller sees after switching onto this model mid-conversation
 * (DSH calls it REASONING-HISTORY). The history belongs to the caller, so the
 * fix has to live on the router: fill an empty value where a turn has none,
 * keep the model's own reasoning on the way out, and leave every other model
 * untouched (glm-5.3-flash-free is served from the same endpoint and does not
 * validate the field).
 *
 * No network: the streaming case is fed a synthetic SSE body.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateStreamToCompletion,
  buildUpstreamRequest,
  modelFlag,
  normalizeResponse,
  toOpenAICompletion,
  withReasoningContent,
} from "../src/providers.mjs";

const FREE = {
  kind: "openai",
  baseUrl: "https://opencode.ai/zen/v1",
  requiresStream: true,
  clientHeaders: "opencode",
  ensureTools: ["read"],
  models: [
    { id: "deepseek-v4.1-flash-free", requiresReasoningContent: true },
    { id: "glm-5.3-flash-free" },
  ],
};

const history = () => [
  { role: "system", content: "be brief" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
  { role: "user", content: "again" },
];

test("capability is read per model, with a provider-wide fallback", () => {
  assert.equal(modelFlag(FREE, "deepseek-v4.1-flash-free", "requiresReasoningContent"), true);
  assert.equal(modelFlag(FREE, "glm-5.3-flash-free", "requiresReasoningContent"), false);
  assert.equal(modelFlag(FREE, "a-model-not-listed", "requiresReasoningContent"), false);
  assert.equal(modelFlag({ ...FREE, requiresReasoningContent: true }, "unknown", "requiresReasoningContent"), true);
  assert.equal(modelFlag(FREE, "deepseek-v4.1-flash-free", "requiresReasoningContent", true), true);
});

test("withReasoningContent backfills assistant turns only", () => {
  const out = withReasoningContent(history());
  assert.deepEqual(out[0], { role: "system", content: "be brief" }, "system untouched");
  assert.deepEqual(out[1], { role: "user", content: "hi" }, "user untouched");
  assert.deepEqual(out[2], { role: "assistant", content: "hello", reasoning_content: "" }, "assistant backfilled");
  assert.deepEqual(out[3], { role: "user", content: "again" }, "later user untouched");
});

test("withReasoningContent keeps an existing value verbatim", () => {
  const out = withReasoningContent([
    { role: "assistant", content: "a", reasoning_content: "because" },
    { role: "assistant", content: "b", reasoning_content: "" },
  ]);
  assert.equal(out[0].reasoning_content, "because");
  assert.equal(out[1].reasoning_content, "", "an explicit empty string is not replaced");
});

test("withReasoningContent carries a `reasoning` field under the name the API reads", () => {
  const out = withReasoningContent([{ role: "assistant", content: "a", reasoning: "carried" }]);
  assert.equal(out[0].reasoning_content, "carried");
  assert.equal(out[0].reasoning, "carried", "the original field is left alone");
});

test("withReasoningContent treats null as missing", () => {
  const out = withReasoningContent([
    { role: "assistant", content: "a", reasoning_content: null },
    { role: "assistant", content: "b", reasoning_content: null, reasoning: "from the other field" },
  ]);
  assert.equal(out[0].reasoning_content, "", "null is the same omission the API rejects");
  assert.equal(out[1].reasoning_content, "from the other field");
});

test("withReasoningContent does not mutate the caller's messages", () => {
  const messages = history();
  const before = JSON.stringify(messages);
  const out = withReasoningContent(messages);
  assert.notEqual(out, messages, "returns a new array");
  assert.equal(JSON.stringify(messages), before, "caller's array untouched");
  assert.equal(messages[2].reasoning_content, undefined);
});

test("the request backfills for the thinking model and leaves glm alone", () => {
  const deepseek = buildUpstreamRequest({ spec: FREE, model: "deepseek-v4.1-flash-free", body: { messages: history() }, stream: true });
  const sent = JSON.parse(deepseek.init.body);
  assert.equal(sent.messages[2].reasoning_content, "", "assistant turn carries the field");

  const glm = buildUpstreamRequest({ spec: FREE, model: "glm-5.3-flash-free", body: { messages: history() }, stream: true });
  const glmSent = JSON.parse(glm.init.body);
  assert.equal("reasoning_content" in glmSent.messages[2], false, "non-thinking model gets no new field");
});

test("a history that already has reasoning is sent unchanged", () => {
  const body = { messages: [{ role: "assistant", content: "a", reasoning_content: "because" }] };
  const built = buildUpstreamRequest({ spec: FREE, model: "deepseek-v4.1-flash-free", body, stream: true });
  assert.equal(JSON.parse(built.init.body).messages[0].reasoning_content, "because");
});

const sse = (events) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

test("a streamed answer keeps its reasoning for the caller", async () => {
  const norm = await aggregateStreamToCompletion(
    sse([
      { choices: [{ delta: { role: "assistant", reasoning_content: "think " } }] },
      { choices: [{ delta: { reasoning_content: "harder" } }] },
      { choices: [{ delta: { content: "answer" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ]),
  );
  assert.equal(norm.text, "answer");
  assert.equal(norm.reasoning, "think harder");
  const completion = toOpenAICompletion({ model: "deepseek-v4.1-flash-free", ...norm });
  assert.equal(completion.choices[0].message.reasoning_content, "think harder");
});

test("a stream with no reasoning adds no field", async () => {
  const norm = await aggregateStreamToCompletion(
    sse([{ choices: [{ delta: { content: "plain" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]),
  );
  assert.equal(norm.reasoning, undefined);
  const completion = toOpenAICompletion({ model: "glm-5.3-flash-free", ...norm });
  assert.equal("reasoning_content" in completion.choices[0].message, false);
});

test("a buffered upstream response keeps its reasoning", () => {
  const norm = normalizeResponse("openai", {
    choices: [{ message: { role: "assistant", content: "a", reasoning_content: "thought" }, finish_reason: "stop" }],
  });
  assert.equal(norm.reasoning, "thought");
  assert.equal(toOpenAICompletion({ model: "m", ...norm }).choices[0].message.reasoning_content, "thought");
});

test("round trip: a completion fed back into history needs no backfill", async () => {
  const norm = await aggregateStreamToCompletion(
    sse([
      { choices: [{ delta: { reasoning_content: "r" } }] },
      { choices: [{ delta: { content: "c" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
  );
  const reply = toOpenAICompletion({ model: "deepseek-v4.1-flash-free", ...norm }).choices[0].message;
  const built = buildUpstreamRequest({
    spec: FREE,
    model: "deepseek-v4.1-flash-free",
    body: { messages: [{ role: "user", content: "q" }, reply, { role: "user", content: "follow up" }] },
    stream: true,
  });
  assert.equal(JSON.parse(built.init.body).messages[1].reasoning_content, "r");
});

test("router.config.json declares the capability on the model that needs it", async () => {
  const { readFileSync } = await import("node:fs");
  const config = JSON.parse(readFileSync(new URL("../router.config.json", import.meta.url), "utf8"));
  const free = config.providers["opencode-free"];
  const deepseek = free.models.find((m) => m.id === "deepseek-v4.1-flash-free");
  const glm = free.models.find((m) => m.id === "glm-5.3-flash-free");
  assert.equal(deepseek?.requiresReasoningContent, true);
  assert.equal(glm?.requiresReasoningContent, undefined, "per model, not per provider");
});
