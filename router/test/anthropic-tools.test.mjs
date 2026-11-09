/**
 * The Anthropic adapter carries an agent: tools, tool calls and tool results in Anthropic's
 * shape, the current models' request rules, and per-model prices.
 *
 * No network: requests are built and inspected, and streams are fed from strings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { computeCostUsd } from "../src/limits.mjs";
import { anthropicStreamToOpenAI, buildUpstreamRequest, pricesFor, toAnthropicMessages } from "../src/providers.mjs";

const spec = {
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  prices: { in: 3, out: 15 },
  maxTokensDefault: 8192,
  models: [
    { id: "claude-opus-5-5", prices: { in: 4, out: 20 }, sampling: false, efforts: ["low", "medium", "high", "xhigh", "max"], fallbacks: true, maxTokensDefault: 32000 },
    { id: "claude-haiku-5-5", prices: { in: 0.1, out: 0.5 }, sampling: false, efforts: ["low", "medium", "high"] },
    { id: "claude-sonnet-4-5", prices: { in: 3, out: 15 } },
  ],
};
const TOOLS = [{ type: "function", function: { name: "write_file", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } }];

const build = (model, body) => {
  const { url, init } = buildUpstreamRequest({ spec, model, body, key: "sk-test" });
  return { url, headers: init.headers, payload: JSON.parse(init.body) };
};

test("an agent turn travels in Anthropic's shape: tools, tool_use and tool_result blocks", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "rules" },
    { role: "user", content: "make a.txt and b.txt" },
    {
      role: "assistant",
      content: "On it.",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "write_file", arguments: '{"path":"a.txt"}' } },
        { id: "t2", type: "function", function: { name: "write_file", arguments: '{"path":"b.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "t1", content: "wrote a.txt" },
    { role: "tool", tool_call_id: "t2", content: "wrote b.txt" },
  ]);
  assert.equal(system, "rules");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(messages[1].content, [
    { type: "text", text: "On it." },
    { type: "tool_use", id: "t1", name: "write_file", input: { path: "a.txt" } },
    { type: "tool_use", id: "t2", name: "write_file", input: { path: "b.txt" } },
  ]);
  assert.deepEqual(messages[2].content, [
    { type: "tool_result", tool_use_id: "t1", content: "wrote a.txt" },
    { type: "tool_result", tool_use_id: "t2", content: "wrote b.txt" },
  ], "both results share one user turn");
});

test("Opus 5.5: tools converted, forced choice made auto, no sampling, effort in output_config, refusal fallback on", () => {
  const { url, headers, payload } = build("claude-opus-5-5", {
    messages: [{ role: "user", content: "go" }],
    tools: TOOLS,
    tool_choice: "required",
    temperature: 0.2,
    top_p: 0.9,
    reasoning_effort: "high",
  });
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.deepEqual(payload.tools, [{ name: "write_file", description: "Write a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
  assert.deepEqual(payload.tool_choice, { type: "auto" }, "a forced choice is a 400 on the 5.x models");
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.top_p, undefined);
  assert.deepEqual(payload.output_config, { effort: "high" });
  assert.equal(payload.fallbacks, "default");
  assert.equal(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(payload.max_tokens, 32000);
  assert.equal(payload.thinking, undefined, "thinking is left out: adaptive is the default and the only mode");
});

test("Haiku 5.5 gets no fallback (the API has none for it); Sonnet 4.5 keeps its sampling settings", () => {
  const haiku = build("claude-haiku-5-5", { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" });
  assert.equal(haiku.payload.fallbacks, undefined);
  assert.equal(haiku.headers["anthropic-beta"], undefined);
  assert.equal(haiku.payload.output_config, undefined, "an effort the model does not list is dropped");
  const old = build("claude-sonnet-4-5", { messages: [{ role: "user", content: "hi" }], temperature: 0 });
  assert.equal(old.payload.temperature, 0);
  assert.equal(old.payload.max_tokens, 8192);
});

// Measured 2026-11-06: the harness asks every step for 4096 and Opus 5.5 came back empty
// three times (thinking plus a file write used it all). The model's default is a floor.
test("an agent step's 4096 is lifted to the model's default; a deliberately small cap is kept", () => {
  const step = build("claude-opus-5-5", { messages: [{ role: "user", content: "write it" }], max_tokens: 4096 });
  assert.equal(step.payload.max_tokens, 32000);
  const grown = build("claude-opus-5-5", { messages: [{ role: "user", content: "write it" }], max_tokens: 65536 });
  assert.equal(grown.payload.max_tokens, 65536, "a bigger ask (the harness growing a cut-off reply) is kept");
  const summary = build("claude-opus-5-5", { messages: [{ role: "user", content: "summarise" }], max_tokens: 600 });
  assert.equal(summary.payload.max_tokens, 600, "a summary's small cap is a choice, not a default");
});

test("a streamed tool call comes out as OpenAI tool_calls deltas", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 12 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "write_file", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
  ];
  const body = new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")).body;
  let out = "";
  for await (const frame of anthropicStreamToOpenAI(body, { model: "claude-opus-5-5" })) out += frame;
  const deltas = out.split("\n\n").filter((f) => f.startsWith("data: {")).map((f) => JSON.parse(f.slice(6)).choices[0]);
  const calls = deltas.flatMap((d) => d.delta.tool_calls ?? []);
  assert.equal(calls[0].id, "toolu_1");
  assert.equal(calls[0].function.name, "write_file");
  assert.equal(calls.map((c) => c.function.arguments).join(""), '{"path":"a.txt"}');
  assert.equal(deltas.at(-1).finish_reason, "tool_calls");
});

test("prompt caching is asked for where the provider turns it on, and cached tokens are priced", () => {
  const cached = buildUpstreamRequest({ spec: { ...spec, promptCache: true }, model: "claude-opus-5-5", body: { messages: [{ role: "user", content: "hi" }] }, key: "k" });
  assert.deepEqual(JSON.parse(cached.init.body).cache_control, { type: "ephemeral" });
  assert.equal(build("claude-opus-5-5", { messages: [{ role: "user", content: "hi" }] }).payload.cache_control, undefined);
  // Measured run 2026-11-06 on Sonnet 5.5: 8 fresh, 42.9k cached, 258 out.
  assert.equal(computeCostUsd({ in: 2, out: 10 }, { prompt_tokens: 8, completion_tokens: 258, cache_read_input_tokens: 42900 }), 0.011176);
  assert.equal(computeCostUsd({ in: 2, out: 10 }, { prompt_tokens: 0, completion_tokens: 0, cache_creation_input_tokens: 1e6 }), 2.5);
});

test("each Claude model is priced by its own row", () => {
  assert.deepEqual(pricesFor(spec, "claude-opus-5-5"), { in: 4, out: 20 });
  assert.deepEqual(pricesFor(spec, "claude-haiku-5-5"), { in: 0.1, out: 0.5 });
  assert.deepEqual(pricesFor(spec, "claude-unknown"), { in: 3, out: 15 }, "an unlisted model falls back to the provider's prices");
});
