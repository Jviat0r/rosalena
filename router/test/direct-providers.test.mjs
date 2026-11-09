// DeepSeek, Z.AI and Kimi as direct providers (2026-11-09): their own APIs with the
// person's own key, next to the free shared window that already served DeepSeek and GLM.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { loadConfig } from "../src/config.mjs";
import { buildUpstreamRequest, pricesFor } from "../src/providers.mjs";

const CONFIG = fileURLToPath(new URL("../router.config.json", import.meta.url));
const config = loadConfig(CONFIG, { env: {} });
const send = (provider, model, body) => {
  const { url, init } = buildUpstreamRequest({ spec: config.providers[provider], model, body: { messages: [{ role: "user", content: "hi" }], ...body }, key: "test-key" });
  return { url, headers: init.headers, payload: JSON.parse(init.body) };
};

test("each provider calls its own OpenAI-format endpoint with the person's key", () => {
  assert.equal(send("deepseek", "deepseek-flash").url, "https://api.deepseek.com/chat/completions");
  assert.equal(send("zai", "glm-5.3").url, "https://api.z.ai/api/paas/v4/chat/completions");
  assert.equal(send("kimi", "kimi-k3.1-pro").url, "https://api.moonshot.ai/v1/chat/completions");
  for (const [provider, env] of [["deepseek", "DEEPSEEK_API_KEY"], ["zai", "ZAI_API_KEY"], ["kimi", "MOONSHOT_API_KEY"]]) {
    assert.equal(config.providers[provider].apiKeyEnv, env);
    assert.equal(send(provider, "x").headers.authorization, "Bearer test-key");
  }
});

test("GLM-5.3 and Kimi K3.x think at high, not their max default, when no effort is named", () => {
  assert.equal(send("zai", "glm-5.3").payload.reasoning_effort, "high");
  assert.equal(send("kimi", "kimi-k3.1-pro").payload.reasoning_effort, "high");
  // A level the person picked wins.
  assert.equal(send("zai", "glm-5.3", { reasoning_effort: "max" }).payload.reasoning_effort, "max");
  assert.equal(send("kimi", "kimi-k3", { reasoning_effort: "low" }).payload.reasoning_effort, "low");
  // DeepSeek's own default is already high, so nothing is added for it.
  assert.equal("reasoning_effort" in send("deepseek", "deepseek-flash").payload, false);
  assert.equal(send("deepseek", "deepseek-v4-pro", { reasoning_effort: "max" }).payload.reasoning_effort, "max");
  // A level the API does not know is dropped, never forwarded into a 400.
  assert.equal("reasoning_effort" in send("zai", "glm-5.3", { reasoning_effort: "medium" }).payload, false);
});

test("the free GLM-4.7 Flash gets no effort field at all (it does not take one)", () => {
  assert.equal("reasoning_effort" in send("zai", "glm-4.7-flash").payload, false);
  assert.equal("reasoning_effort" in send("zai", "glm-4.7-flash", { reasoning_effort: "high" }).payload, false);
});

test("thinking models get their reasoning passed back in the history", () => {
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  for (const [provider, model] of [["deepseek", "deepseek-flash"], ["zai", "glm-5.3"], ["kimi", "kimi-k3.1-pro"]]) {
    const { payload } = send(provider, model, { messages: history });
    assert.equal(payload.messages[1].reasoning_content, "", `${provider}: an assistant turn with no stored reasoning sends ""`);
  }
});

test("per-model prices: the cheap and expensive rows are billed apart", () => {
  assert.deepEqual(pricesFor(config.providers.deepseek, "deepseek-v4-pro"), { in: 1.32, out: 3.96 });
  assert.deepEqual(pricesFor(config.providers.zai, "glm-4.7-flash"), { in: 0, out: 0 });
  assert.deepEqual(pricesFor(config.providers.kimi, "kimi-k3.1-pro-highspeed"), { in: 4, out: 20 });
  for (const provider of ["deepseek", "zai", "kimi"]) assert.equal(config.budgets.monthlyUsd[provider], 10);
});

test("every new menu row names a provider and model the router knows", () => {
  const rows = config.models.filter((row) => /^(deepseek|zai|kimi)\//.test(row.target));
  assert.equal(rows.length, 8);
  for (const row of rows) {
    const [provider, model] = [row.target.slice(0, row.target.indexOf("/")), row.target.slice(row.target.indexOf("/") + 1)];
    assert.ok(config.providers[provider].models.some((m) => m.id === model), row.target);
  }
});
