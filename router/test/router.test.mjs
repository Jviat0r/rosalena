/**
 * Unit and integration tests. No network, no keys, no cost: every upstream is a
 * stubbed fetch, so the failure paths that matter (429, auth, budget, exhaustion)
 * are deterministic rather than something we wait to happen in production.
 *
 *   node --test test/
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Ledger, KeyPool, ProviderBreaker, computeCostUsd, monthKey, maskKey } from "../src/limits.mjs";
import { authToken, validateConfig } from "../src/config.mjs";
import {
  anthropicStreamToOpenAI,
  buildUpstreamRequest,
  classifyFailure,
  normalizeResponse,
  parseTarget,
  toAnthropicMessages,
} from "../src/providers.mjs";
import { classifyRequest, NO_TOOLS_NOTE, resolveChain, route } from "../src/router.mjs";
import { createRouterServer } from "../src/server.mjs";
import { createLogger } from "../src/log.mjs";

const TMP = mkdtempSync(join(tmpdir(), "router-test-"));
const silence = { log() {}, recent: () => [], file: () => null };
const servers = [];
after(() => {
  for (const s of servers) s.close();
});

function ok(text = "hello") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function status(code, body = "nope", headers = {}) {
  return new Response(JSON.stringify({ error: body }), {
    status: code,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Records every upstream call and answers by URL match. */
function mockFetch(table) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [needle, respond] of table) {
      if (String(url).includes(needle)) return respond(String(url), init, calls.length);
    }
    return status(500, "no stub matched");
  };
  fn.calls = calls;
  fn.count = (needle) => calls.filter((c) => c.url.includes(needle)).length;
  return fn;
}

function testConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    logDir: TMP,
    stateFile: join(TMP, `ledger-${Math.random().toString(36).slice(2)}.json`),
    requestTimeoutMs: 5_000,
    defaultClass: "fast",
    budgets: { monthlyUsd: {} },
    providers: {
      local: { kind: "openai", baseUrl: "http://stub.local/v1", apiKeyEnv: null, prices: { in: 0, out: 0 } },
      cloud: { kind: "openai", baseUrl: "http://stub.cloud/v1", apiKeyEnv: "CLOUD_KEY", prices: { in: 1, out: 2 } },
      anthropic: { kind: "anthropic", baseUrl: "http://stub.anthropic/v1", apiKeyEnv: "ANTHROPIC_KEY", prices: { in: 3, out: 15 } },
    },
    classes: {
      code: { chain: ["local/qwen3.8-27b", "cloud/big-model"] },
      fast: { chain: ["local/qwen3.8-27b"] },
      judge: { chain: ["anthropic/claude-sonnet-4-5"] },
    },
    ...overrides,
  };
}

const DEFAULT_ENV = { CLOUD_KEY: "k1", ANTHROPIC_KEY: "sk-ant" };

function ctxFor(config, fetchImpl, env = DEFAULT_ENV) {
  return {
    config,
    ledger: new Ledger(config.stateFile),
    keyPool: new KeyPool(env, config.providers),
    logger: silence,
    fetchImpl,
  };
}

// ---------------------------------------------------------------- addressing

test("parseTarget splits on the first slash so nested OpenRouter ids survive", () => {
  assert.deepEqual(parseTarget("local/qwen3.8-27b"), { provider: "local", model: "qwen3.8-27b" });
  assert.deepEqual(parseTarget("openrouter/anthropic/claude-sonnet-4.5"), {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.throws(() => parseTarget("noprovider"));
});

test("classifyRequest accepts a class, a pinned target, or nothing", () => {
  const config = testConfig();
  assert.equal(classifyRequest({ model: "code", config }).cls, "code");
  assert.equal(classifyRequest({ model: "", config }).cls, "fast");
  assert.equal(classifyRequest({ model: undefined, config }).defaulted, true);

  const pinned = classifyRequest({ model: "cloud/big-model", config });
  assert.equal(pinned.cls, null);
  assert.deepEqual(pinned.pinned, { provider: "cloud", model: "big-model" });

  const bad = classifyRequest({ model: "gpt-imaginary", config });
  assert.match(bad.error, /unknown class/);
  assert.deepEqual(bad.classes, ["code", "fast", "judge"]);
});

test("a pinned target is not mistaken for a class, and vice versa", () => {
  const config = testConfig();
  // "code" has no slash, so it can only be a class; a provider-prefixed id can
  // only be a target. This is what stops a class named like a model.
  assert.equal(classifyRequest({ model: "code", config }).pinned, null);
  assert.equal(classifyRequest({ model: "anthropic/claude-sonnet-4-5", config }).cls, null);
});

test("resolveChain keeps preference order", () => {
  assert.deepEqual(
    resolveChain(testConfig(), "code").map((t) => t.name),
    ["local/qwen3.8-27b", "cloud/big-model"],
  );
  assert.equal(resolveChain(testConfig(), "nope"), null);
});

// -------------------------------------------------------------- money & keys

test("computeCostUsd prices both usage dialects", () => {
  assert.equal(computeCostUsd({ in: 1, out: 2 }, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 3);
  assert.equal(computeCostUsd({ in: 3, out: 15 }, { input_tokens: 1_000_000, output_tokens: 0 }), 3);
  assert.equal(computeCostUsd({ in: 0, out: 0 }, { prompt_tokens: 5e6 }), 0);
  // Sub-cent calls must not round to zero or the cap never fills.
  assert.equal(computeCostUsd({ in: 1, out: 0 }, { prompt_tokens: 1000 }), 0.001);
});

test("ledger accumulates, persists across reload, and enforces the monthly cap", () => {
  const file = join(TMP, "ledger-cap.json");
  const led = new Ledger(file);
  assert.equal(led.within("cloud", 1), true);
  led.record("cloud", 0.6, { model: "big-model", tokensIn: 10, tokensOut: 5 });
  assert.equal(led.within("cloud", 1), true);
  led.record("cloud", 0.5, { model: "big-model" });
  assert.equal(led.within("cloud", 1), false, "cap reached");
  assert.equal(led.remaining("cloud", 1), 0);

  const reopened = new Ledger(file);
  assert.equal(reopened.spent("cloud"), 1.1, "spend survives a restart");
  assert.equal(reopened.snapshot().providers.cloud.calls, 2);
  // A zero cap means uncapped: local is free and must never be skipped.
  assert.equal(led.within("local", 0), true);
  assert.equal(led.within("local", undefined), true);
});

test("monthKey is a UTC month string", () => {
  assert.equal(monthKey(new Date("2026-10-19T01:03:00Z")), "2026-10");
});

test("key pool reads one key, a list, and numbered keys", () => {
  const specs = { cloud: { apiKeyEnv: "CLOUD_KEY" } };
  assert.deepEqual(new KeyPool({ CLOUD_KEY: "a" }, specs).all("cloud"), ["a"]);
  assert.deepEqual(new KeyPool({ CLOUD_KEY: "a,b c" }, specs).all("cloud"), ["a", "b", "c"]);
  assert.deepEqual(new KeyPool({ CLOUD_KEYS: "a,b" }, specs).all("cloud"), ["a", "b"]);
  assert.deepEqual(new KeyPool({ CLOUD_KEY: "a", CLOUD_KEY_2: "b", CLOUD_KEY_3: "c" }, specs).all("cloud"), ["a", "b", "c"]);
  // Duplicates collapse: the same key twice is not a second chance.
  assert.deepEqual(new KeyPool({ CLOUD_KEY: "a", CLOUD_KEY_2: "a" }, specs).all("cloud"), ["a"]);
});

test("key pool rotates past a cooling key and reports when none are left", () => {
  const pool = new KeyPool({ CLOUD_KEY: "k1", CLOUD_KEY_2: "k2" }, { cloud: { apiKeyEnv: "CLOUD_KEY" } });
  const first = pool.rotate("cloud");
  assert.equal(first, "k1");
  assert.equal(pool.rotate("cloud", "k1"), "k2");
  pool.cooldown("k1", 60_000);
  assert.equal(pool.rotate("cloud", "k2"), "k2", "wraps to the only live key");
  pool.cooldown("k2", 60_000);
  assert.equal(pool.rotate("cloud"), null, "all cooling = provider unusable, fail over");
  assert.equal(pool.available("cloud").length, 0);
  // A cooldown never shortens.
  pool.cooldown("k1", 1);
  assert.ok(pool.coolingFor("k1") > 1000);
});

test("a provider needing no key is usable without one", () => {
  const pool = new KeyPool({}, { local: { apiKeyEnv: null } });
  assert.equal(pool.usable("local", { apiKeyEnv: null }), true);
  assert.equal(pool.usable("cloud", { apiKeyEnv: "CLOUD_KEY" }), false);
});

test("maskKey never exposes a whole key", () => {
  assert.equal(maskKey("sk-abcdefghijklmnop"), "…mnop");
  assert.equal(maskKey("short"), "****");
  assert.equal(maskKey(null), "(none)");
});

// ------------------------------------------------------------ failure reading

test("classifyFailure separates key faults, provider faults and bad requests", () => {
  const rl = classifyFailure({ status: 429, headers: new Headers({ "retry-after": "7" }) });
  assert.equal(rl.reason, "rate_limit");
  assert.equal(rl.keySuspect, true);
  assert.equal(rl.cooldownMs, 7000, "honours Retry-After rather than guessing");

  assert.equal(classifyFailure({ status: 401 }).keySuspect, true, "another key may work");
  assert.equal(classifyFailure({ status: 500 }).providerSuspect, true);
  assert.equal(classifyFailure({ status: 503 }).reason, "upstream_503");

  const bad = classifyFailure({ status: 400, text: "unknown field 'foo'" });
  assert.equal(bad.retryable, false, "a malformed request fails everywhere");
  assert.equal(bad.reason, "bad_request");

  assert.equal(classifyFailure({ status: 404, text: "model not found" }).reason, "model_not_found");
  assert.equal(classifyFailure({ status: 0, text: "ECONNREFUSED" }).reason, "network");
  assert.equal(classifyFailure({ status: 402 }).providerSuspect, true);
});

// ------------------------------------------------------------ wire translation

test("Anthropic messages pull the system prompt out and merge consecutive roles", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "be terse" },
    { role: "user", content: "one" },
    { role: "user", content: "two" },
    { role: "assistant", content: "three" },
  ]);
  assert.equal(system, "be terse");
  assert.deepEqual(messages, [
    { role: "user", content: "one\n\ntwo" },
    { role: "assistant", content: "three" },
  ]);
});

test("Anthropic messages never start with an assistant turn", () => {
  const { messages } = toAnthropicMessages([{ role: "assistant", content: "hi" }]);
  assert.equal(messages[0].role, "user");
  assert.equal(toAnthropicMessages([]).messages.length, 1);
});

test("buildUpstreamRequest sends the right auth and shape per kind", () => {
  const openai = buildUpstreamRequest({
    spec: { kind: "openai", baseUrl: "http://x/v1" },
    model: "m",
    body: { messages: [], class: "code" },
    key: "sk-1",
  });
  assert.equal(openai.url, "http://x/v1/chat/completions");
  assert.equal(openai.init.headers.authorization, "Bearer sk-1");
  assert.equal(JSON.parse(openai.init.body).class, undefined, "router-only field is stripped");

  const anth = buildUpstreamRequest({
    spec: { kind: "anthropic", baseUrl: "http://y/v1", maxTokensDefault: 1234 },
    model: "claude",
    body: { messages: [{ role: "user", content: "hi" }] },
    key: "sk-ant",
  });
  assert.equal(anth.url, "http://y/v1/messages");
  assert.equal(anth.init.headers["x-api-key"], "sk-ant");
  assert.equal(anth.init.headers["anthropic-version"], "2023-06-01");
  const payload = JSON.parse(anth.init.body);
  assert.equal(payload.max_tokens, 1234, "max_tokens is required by the API");
});

test("extraBody lets a provider carry its own required body fields", () => {
  const req = buildUpstreamRequest({
    spec: { kind: "openai", baseUrl: "http://x/v1", extraBody: { chat_template_kwargs: { enable_thinking: false } } },
    model: "m",
    body: { messages: [] },
  });
  assert.deepEqual(JSON.parse(req.init.body).chat_template_kwargs, { enable_thinking: false });

  const anth = buildUpstreamRequest({
    spec: { kind: "anthropic", baseUrl: "http://y/v1", extraBody: { metadata: { user_id: "u1" } } },
    model: "claude",
    body: { messages: [] },
  });
  assert.deepEqual(JSON.parse(anth.init.body).metadata, { user_id: "u1" });
});

test("normalizeResponse unifies both shapes", () => {
  const o = normalizeResponse("openai", {
    choices: [{ message: { content: "hi", tool_calls: [{ id: "t" }] }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  assert.equal(o.text, "hi");
  assert.equal(o.usage.prompt_tokens, 1);

  const a = normalizeResponse("anthropic", {
    content: [
      { type: "text", text: "he" },
      { type: "text", text: "llo" },
      { type: "tool_use", id: "tu1", name: "read", input: { p: 1 } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  assert.equal(a.text, "hello");
  assert.equal(a.finishReason, "tool_calls");
  assert.equal(a.toolCalls[0].function.name, "read");
  assert.equal(a.usage.prompt_tokens, 3);
});

test("anthropicStreamToOpenAI emits OpenAI chunks and a terminator", async () => {
  const enc = new TextEncoder();
  const upstream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n'));
      c.enqueue(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n'));
      c.enqueue(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n'));
      c.enqueue(enc.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });

  let usage = null;
  const frames = [];
  for await (const f of anthropicStreamToOpenAI(upstream, { model: "claude", onUsage: (u) => { usage = u; } })) {
    frames.push(f);
  }
  const text = frames.filter((f) => f.startsWith("data: {")).map((f) => JSON.parse(f.slice(6)).choices[0].delta.content).join("");
  assert.equal(text, "Hello");
  assert.equal(frames.at(-1), "data: [DONE]\n\n");
  assert.deepEqual(usage, { prompt_tokens: 9, completion_tokens: 2 });
});

// ------------------------------------------------------------------- routing

test("route serves from the first healthy target", async () => {
  const config = testConfig();
  const f = mockFetch([["stub.local", () => ok("local answer")]]);
  const out = await route({ ...ctxFor(config, f), cls: "code", body: { messages: [] } });
  assert.equal(out.stream, false);
  assert.equal(out.target, "local/qwen3.8-27b");
  assert.equal(out.completion.choices[0].message.content, "local answer");
  assert.equal(out.completion.object, "chat.completion");
  assert.equal(out.attempts.length, 1);
  assert.equal(f.calls.length, 1);
});

test("the no-tools rule is per model: a gateway's auto route is skipped, its real-provider model is not", async () => {
  const tools = [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }];
  const config = testConfig({
    providers: {
      ...testConfig().providers,
      gateway: {
        kind: "openai", baseUrl: "http://stub.gateway/v1", apiKeyEnv: null, prices: { in: 0, out: 0 },
        models: [{ id: "auto", tools: false }, { id: "gemini/gemini-2.5-flash" }],
      },
    },
    classes: { code: { chain: ["gateway/auto", "gateway/gemini/gemini-2.5-flash", "cloud/big-model"] } },
  });
  const f = mockFetch([["stub.gateway", () => ok("called write_file")], ["stub.cloud", () => ok("cloud")]]);
  const out = await route({ ...ctxFor(config, f), cls: "code", body: { messages: [], tools } });
  assert.equal(out.target, "gateway/gemini/gemini-2.5-flash");
  assert.equal(out.attempts[0].reason, "no_tools");
  assert.equal(JSON.parse(f.calls[0].init.body).tools.length, 1, "the real provider gets the tools");
});

test("a provider that never returns tool calls is skipped for a tool request, and answers as chat when it is the last", async () => {
  const tools = [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }];
  const config = testConfig({
    providers: {
      ...testConfig().providers,
      gateway: { kind: "openai", baseUrl: "http://stub.gateway/v1", apiKeyEnv: null, tools: false, prices: { in: 0, out: 0 } },
    },
    classes: {
      code: { chain: ["gateway/auto", "cloud/big-model"] },
      chat: { chain: ["gateway/auto"] },
    },
  });

  // With tools and a later target: the gateway is never called.
  const f = mockFetch([["stub.gateway", () => ok("I'll use write_file now.")], ["stub.cloud", () => ok("done")]]);
  const out = await route({ ...ctxFor(config, f), cls: "code", body: { messages: [], tools } });
  assert.equal(out.target, "cloud/big-model");
  assert.deepEqual(out.attempts[0], { target: "gateway/auto", ok: false, reason: "no_tools", skipped: true });
  assert.equal(f.count("stub.gateway"), 0);

  // Without tools it is a normal first choice.
  const plain = mockFetch([["stub.gateway", () => ok("hi")]]);
  assert.equal((await route({ ...ctxFor(config, plain), cls: "code", body: { messages: [] } })).target, "gateway/auto");

  // As the only target it answers as chat: no tools, and the note at the top of the latest
  // user turn (OmniRoute's playground bridge drops system messages).
  const last = mockFetch([["stub.gateway", () => ok("a chat answer")]]);
  const only = await route({
    ...ctxFor(config, last),
    cls: "chat",
    body: {
      messages: [{ role: "system", content: "You are an agent with tools." }, { role: "user", content: "hi" }, { role: "assistant", content: "hey" }, { role: "user", content: "make hello.py" }],
      tools,
      tool_choice: "auto",
    },
  });
  assert.equal(only.completion.choices[0].message.content, "a chat answer");
  const sent = JSON.parse(last.calls[0].init.body);
  assert.equal(sent.tools, undefined);
  assert.equal(sent.tool_choice, undefined);
  assert.deepEqual(sent.messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(sent.messages[1].content, "hi");
  assert.equal(sent.messages[3].content, `${NO_TOOLS_NOTE}\n\n---\n\nmake hello.py`);
});

test("route falls over to the next target when the first is rate limited", async () => {
  const config = testConfig();
  const f = mockFetch([
    ["stub.local", () => status(429, "slow down", { "retry-after": "1" })],
    ["stub.cloud", () => ok("cloud answer")],
  ]);
  const out = await route({ ...ctxFor(config, f), cls: "code", body: { messages: [] } });
  assert.equal(out.target, "cloud/big-model");
  assert.equal(out.attempts[0].reason, "rate_limit");
  assert.equal(out.attempts[0].ok, false);
  assert.equal(out.attempts.length, 2);
  assert.ok(out.usd > 0, "cloud spend is recorded");
});

test("route records the fallback path in the log", async () => {
  const config = testConfig();
  const f = mockFetch([
    ["stub.local", () => status(500, "boom")],
    ["stub.cloud", () => ok()],
  ]);
  const events = [];
  const logger = { log: (event, fields) => events.push({ event, ...fields }), recent: () => [] };
  await route({ ...ctxFor(config, f), logger, cls: "code", body: { messages: [] }, requestId: "req1" });
  const fallback = events.find((e) => e.event === "fallback");
  assert.ok(fallback, "a fallback event is emitted");
  assert.equal(fallback.from, "local/qwen3.8-27b");
  assert.equal(fallback.to, "cloud/big-model");
  assert.equal(fallback.reason, "upstream_500");
  assert.ok(events.some((e) => e.event === "attempt" && e.ok === false && e.reason === "upstream_500"));
});

test("route retries the same provider with a second key before failing over", async () => {
  const config = testConfig();
  let seen = 0;
  const f = mockFetch([
    [
      "stub.cloud",
      (_u, init) => {
        seen += 1;
        return init.headers.authorization === "Bearer k2" ? ok("second key") : status(401, "bad key");
      },
    ],
  ]);
  const ctx = ctxFor(config, f, { CLOUD_KEY: "k1", CLOUD_KEY_2: "k2" });
  // Pin straight to cloud so the first key is the one that fails.
  const out = await route({ ...ctx, cls: null, pinned: { provider: "cloud", model: "big-model" }, body: { messages: [] } });
  assert.equal(out.completion.choices[0].message.content, "second key");
  assert.equal(seen, 2);
  assert.equal(ctx.keyPool.coolingFor("k1") > 0, true, "the bad key is benched");
});

test("route skips a target that is over budget", async () => {
  const config = testConfig({ budgets: { monthlyUsd: { cloud: 0.5 } } });
  const f = mockFetch([
    ["stub.local", () => status(429, "slow down")],
    ["stub.cloud", () => ok()],
  ]);
  const ctx = ctxFor(config, f);
  ctx.ledger.record("cloud", 0.6);
  await assert.rejects(
    () => route({ ...ctx, cls: "code", body: { messages: [] } }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.meta.attempts[1].reason, "over_budget");
      return true;
    },
  );
  assert.equal(f.count("stub.cloud"), 0, "an over-budget provider is never called");
});

test("route skips a target with no key loaded", async () => {
  const config = testConfig();
  const f = mockFetch([["stub.local", () => ok()]]);
  const ctx = ctxFor(config, f, {}); // no CLOUD_KEY
  const out = await route({ ...ctx, cls: "code", body: { messages: [] } });
  assert.equal(out.target, "local/qwen3.8-27b");
  const ctx2 = ctxFor(testConfig({ classes: { code: { chain: ["cloud/big-model"] } } }), f, {});
  await assert.rejects(
    () => route({ ...ctx2, cls: "code", body: { messages: [] } }),
    (err) => {
      assert.equal(err.meta.attempts[0].reason, "no_key");
      return true;
    },
  );
});

test("route surfaces a bad request instead of burning the chain on it", async () => {
  const config = testConfig();
  const f = mockFetch([["stub.local", () => status(400, "unknown parameter 'n'")]]);
  await assert.rejects(
    () => route({ ...ctxFor(config, f), cls: "code", body: { messages: [] } }),
    (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /upstream rejected/);
      return true;
    },
  );
  assert.equal(f.count("stub.cloud"), 0, "no money spent on a request that cannot succeed");
});

test("route reports 503 with every attempted reason when the chain is exhausted", async () => {
  const config = testConfig();
  const f = mockFetch([
    ["stub.local", () => status(503, "down")],
    ["stub.cloud", () => status(500, "also down")],
  ]);
  await assert.rejects(
    () => route({ ...ctxFor(config, f), cls: "code", body: { messages: [] } }),
    (err) => {
      assert.equal(err.status, 503);
      assert.deepEqual(err.meta.attempts.map((a) => a.reason), ["upstream_503", "upstream_500"]);
      return true;
    },
  );
});

test("route ladders through an anthropic target and prices its usage", async () => {
  const config = testConfig({ classes: { judge: { chain: ["anthropic/claude-sonnet-4-5"] } } });
  const f = mockFetch([
    [
      "stub.anthropic",
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "verdict" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1_000_000, output_tokens: 0 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
  ]);
  const ctx = ctxFor(config, f, { ANTHROPIC_KEY: "sk-ant" });
  const out = await route({ ...ctx, cls: "judge", body: { messages: [{ role: "user", content: "judge this" }] } });
  assert.equal(out.completion.choices[0].message.content, "verdict");
  assert.equal(out.usd, 3, "$3/Mtok in, 1M tokens");
  assert.equal(ctx.ledger.spent("anthropic"), 3);
});

// -------------------------------------------------------------------- server

async function startServer(ctx) {
  const server = createRouterServer(ctx);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("server answers health, models and an OpenAI-shaped completion", async () => {
  const config = testConfig();
  const f = mockFetch([["stub.local", () => ok("served")]]);
  const base = await startServer(ctxFor(config, f));

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, "ok");
  assert.deepEqual(health.classes.sort(), ["code", "fast", "judge"]);

  const models = await (await fetch(`${base}/v1/models`)).json();
  assert.ok(models.data.some((m) => m.id === "code" && m.owned_by === "router:class"));
  assert.ok(models.data.some((m) => m.id === "local/*"));

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "code", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-router-target"), "local/qwen3.8-27b");
  const body = await res.json();
  assert.equal(body.choices[0].message.content, "served");
  assert.ok(body.usage.total_tokens >= 0);
});

test("server rejects an unknown class with a usable message", async () => {
  const base = await startServer(ctxFor(testConfig(), mockFetch([["stub.local", () => ok()]])));
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "gpt-imaginary", messages: [] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /unknown class/);
  assert.match(body.error.message, /code/);
});

test("server reports the fallback that happened on /admin/status", async () => {
  const config = testConfig({ logDir: join(TMP, "status-logs") });
  const f = mockFetch([
    ["stub.local", () => status(429, "slow down")],
    ["stub.cloud", () => ok()],
  ]);
  const ctx = ctxFor(config, f, { CLOUD_KEY: "k1" });
  ctx.logger = createLogger({ logDir: config.logDir, echo: false });
  const base = await startServer(ctx);

  await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "code", messages: [] }) });
  // Named `report`, not `status`: a local called `status` shadows the response
  // helper above and throws "Cannot access 'status' before initialization" inside
  // the stub closure.
  const report = await (await fetch(`${base}/admin/status`)).json();
  assert.equal(report.status, "ok");
  assert.ok(report.recent.some((e) => e.event === "fallback"));
  assert.ok(
    report.recent.some((e) => e.event === "attempt" && e.reason === "rate_limit"),
    `expected a rate_limit attempt; recent = ${JSON.stringify(report.recent, null, 2)}`,
  );
  assert.equal(report.providers.cloud.spentUsd > 0, true);
  assert.equal(report.providers.local.withinBudget, true);
});

test("server prices each call: a header on a buffered reply, a closing comment on a stream", async () => {
  const f = mockFetch([
    ["stub.local", () => status(429, "slow down")],
    ["stub.cloud", () => ok()],
  ]);
  const base = await startServer(ctxFor(testConfig(), f, { CLOUD_KEY: "k1" }));
  const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "code", messages: [] }) });
  assert.equal(res.status, 200);
  assert.ok(Number(res.headers.get("x-router-cost-usd")) > 0, "the cloud fallback is priced");

  const enc = new TextEncoder();
  const sf = mockFetch([
    [
      "stub.local",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}],"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\n'));
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ],
  ]);
  const sbase = await startServer(ctxFor(testConfig({ classes: { code: { chain: ["local/qwen3.8-27b"] } } }), sf));
  const text = await (await fetch(`${sbase}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "code", stream: true, messages: [] }) })).text();
  const comment = text.split("\n").find((l) => l.startsWith(": x-router-cost "));
  assert.ok(comment, `no cost comment in: ${text}`);
  const cost = JSON.parse(comment.slice(": x-router-cost ".length));
  assert.equal(cost.measured, true);
  assert.equal(cost.target, "local/qwen3.8-27b");
  assert.equal(typeof cost.usd, "number");
});

test("server relays a stream and marks the target it used", async () => {
  const config = testConfig({ classes: { code: { chain: ["local/qwen3.8-27b"] } } });
  const enc = new TextEncoder();
  const f = mockFetch([
    [
      "stub.local",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ],
  ]);
  const base = await startServer(ctxFor(config, f));
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "code", stream: true, messages: [] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /event-stream/);
  const text = await res.text();
  assert.match(text, /"content":"a"/);
  assert.match(text, /data: \[DONE\]/);
});

test("server survives a request from a caller that disconnects", async () => {
  // The point is only that the router does not wedge or crash; a disconnected
  // client must not leave an upstream fetch running forever.
  const config = testConfig();
  const f = mockFetch([["stub.local", () => ok()]]);
  const base = await startServer(ctxFor(config, f));
  const ctrl = new AbortController();
  const p = fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "code", messages: [] }),
    signal: ctrl.signal,
  }).catch(() => null);
  ctrl.abort();
  await p;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, "ok", "router is still serving");
});

test("server survives a client that disconnects MID-stream", async () => {
  // The test above aborts before a single byte is sent, which is the easy case: the
  // error path can still write a status line. Once a streamed 200 has started,
  // writeHead is illegal - and doing it anyway threw *inside the error handler*, so
  // the rejection escaped the request handler and exited the whole router process
  // (measured 2026-10-19: the harness's step watchdog aborted a slow call, the relay
  // failed, and the router died with ERR_HTTP_HEADERS_SENT). A client walking away
  // mid-stream must close that one response and nothing else.
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on("unhandledRejection", onRejection);
  try {
    const enc = new TextEncoder();
    // An upstream that answers with a live SSE stream and then stays open, tied to
    // the router's own signal the way undici ties a real fetch: aborting makes the
    // next read reject instead of hanging forever.
    const f = mockFetch([
      [
        "stub.local",
        (url, init) => {
          let ctrl = null;
          const stream = new ReadableStream({
            start(c) {
              ctrl = c;
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
              init.signal?.addEventListener(
                "abort",
                () => {
                  try {
                    c.error(init.signal.reason ?? new Error("aborted"));
                  } catch {
                    /* already closed */
                  }
                },
                { once: true },
              );
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        },
      ],
    ]);
    const config = testConfig({ classes: { code: { chain: ["local/qwen3.8-27b"] } } });
    // A capturing logger, not the usual `silence`: the assertion below has to prove
    // this test actually reached the mid-stream error path. A test that passes
    // without exercising the branch it was written for proves nothing.
    const logs = [];
    const base = await startServer({
      config,
      ledger: new Ledger(config.stateFile),
      keyPool: new KeyPool(DEFAULT_ENV, config.providers),
      logger: { log: (event, data) => logs.push({ event, ...data }), recent: () => [], file: () => null },
      fetchImpl: f,
    });

    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "code", stream: true, messages: [] }),
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const first = await reader.read(); // the 200 and one frame are on the wire now
    assert.match(new TextDecoder().decode(first.value), /"content":"a"/);

    ctrl.abort(); // the client walks away mid-stream
    await new Promise((r) => setTimeout(r, 100)); // let the server notice the close

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.status, "ok", "the router is still serving after a mid-stream disconnect");
    assert.deepEqual(
      rejections.map((e) => String(e?.message ?? e)),
      [],
      "no rejection escaped the request handler",
    );
    assert.ok(
      logs.some((l) => l.event === "stream_failed"),
      `the mid-stream failure was reported as a stream failure, not answered with JSON (logs: ${JSON.stringify(logs.map((l) => l.event))})`,
    );
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

// ---------------------------------------------------------- circuit breaker

test("ProviderBreaker opens only after the threshold and reports the wait", () => {
  let now = 1_000_000;
  const b = new ProviderBreaker({ threshold: 3, defaultCooldownMs: 30_000, maxCooldownMs: 900_000 }, { now: () => now });
  assert.deepEqual(b.check("cloud"), { open: false, probe: false });

  b.record("cloud", { reason: "upstream_500", cooldownMs: 20_000 });
  b.record("cloud", { reason: "upstream_500", cooldownMs: 20_000 });
  assert.equal(b.check("cloud").open, false, "two failures are not yet a provider outage");

  b.record("cloud", { reason: "upstream_500", cooldownMs: 20_000 });
  const gate = b.check("cloud");
  assert.equal(gate.open, true);
  assert.equal(gate.retryInMs, 30_000, "the provider's own cooldown hint is used, floored at the base");
});

test("a success at any point resets the breaker and its counter", () => {
  const b = new ProviderBreaker({ threshold: 3 });
  b.record("cloud", { reason: "upstream_500" });
  b.record("cloud", { reason: "upstream_500" });
  b.record("cloud", { ok: true });
  b.record("cloud", { reason: "upstream_500" });
  b.record("cloud", { reason: "upstream_500" });
  assert.equal(b.check("cloud").open, false, "the two failures after the success are a fresh count");
});

test("recovery is half-open: one probe, and a failed probe re-opens for longer", () => {
  let now = 5_000_000;
  const b = new ProviderBreaker({ threshold: 2, defaultCooldownMs: 10_000, maxCooldownMs: 80_000 }, { now: () => now });
  b.record("cloud", { reason: "network" });
  b.record("cloud", { reason: "network" });
  assert.equal(b.check("cloud").open, true);

  now += 10_001; // the cooldown elapsed
  assert.deepEqual(b.check("cloud"), { open: false, probe: true }, "the first caller gets the probe");
  const second = b.check("cloud");
  assert.equal(second.open, true, "everyone else keeps skipping while the probe is out");
  assert.equal(second.probeInFlight, true);

  // The probe fails: back off for longer than the first time, not the same amount.
  const reopen = b.record("cloud", { reason: "network" });
  assert.equal(reopen.opened, true);
  assert.equal(reopen.ms, 20_000, "the cooldown doubles on a repeated trip");

  now += 20_001;
  assert.equal(b.check("cloud").probe, true);
  b.record("cloud", { ok: true }); // this time the probe succeeds
  assert.equal(b.check("cloud").open, false);
  assert.equal(b.stats().providers.cloud.state, "closed");
  assert.equal(b.stats().providers.cloud.fails, 0);
});

test("a burst of concurrent failures is ONE trip, not one per failure", () => {
  let now = 7_000_000;
  const b = new ProviderBreaker({ threshold: 3, defaultCooldownMs: 30_000, maxCooldownMs: 900_000 }, { now: () => now });
  for (let i = 0; i < 25; i += 1) b.record("cloud", { reason: "rate_limit", cooldownMs: 1_000 });
  const gate = b.check("cloud");
  assert.equal(gate.open, true);
  assert.equal(gate.retryInMs, 30_000, "25 simultaneous failures must not escalate the first trip");
  assert.equal(b.stats().providers.cloud.trips, 1);
  assert.equal(b.stats().providers.cloud.nextCooldownMs, 60_000, "the NEXT episode is the one that doubles");
});

test("the cooldown is bounded, however many times a provider keeps failing", () => {
  let now = 9_000_000;
  const b = new ProviderBreaker({ threshold: 1, defaultCooldownMs: 1_000, maxCooldownMs: 5_000 }, { now: () => now });
  for (let i = 0; i < 12; i += 1) {
    b.record("cloud", { reason: "network" }); // trips, then fails each probe in turn
    const gate = b.check("cloud");
    assert.equal(gate.open, true);
    now += gate.retryInMs + 1; // wait the cooldown out
    assert.equal(b.check("cloud").probe, true, "the call after the cooldown is the probe");
  }
  assert.equal(b.stats().providers.cloud.nextCooldownMs, 5_000, "the doubling is capped at maxCooldownMs");
});

test("breaker: false is never consulted and never opens", () => {
  const b = new ProviderBreaker({ enabled: false, threshold: 1 });
  b.record("cloud", { reason: "network" });
  assert.equal(b.check("cloud").open, false);
});

test("the breaker stops a dead provider being called on every request", async () => {
  const config = testConfig();
  const f = mockFetch([
    ["stub.local", () => status(500, "boom")],
    ["stub.cloud", () => ok("cloud answer")],
  ]);
  const breaker = new ProviderBreaker({ threshold: 3, defaultCooldownMs: 30_000 });
  const ctx = { ...ctxFor(config, f), breaker };

  const seen = [];
  for (let i = 0; i < 10; i += 1) {
    const out = await route({ ...ctx, cls: "code", body: { messages: [] } });
    assert.equal(out.target, "cloud/big-model", "the call still succeeds");
    seen.push(out.attempts[0].reason);
  }

  // The whole point: 10 requests no longer mean 10 doomed round trips.
  assert.equal(f.count("stub.local"), 3, "the dead provider is tried until the trip, then skipped");
  assert.equal(f.count("stub.cloud"), 10);
  assert.deepEqual(seen, ["upstream_500", "upstream_500", "upstream_500", "circuit_open", "circuit_open", "circuit_open", "circuit_open", "circuit_open", "circuit_open", "circuit_open"]);
});

test("the breaker does NOT trip when another key absorbs the rate limit", async () => {
  // This is the distinction the breaker lives or dies on: a rate limit is a KEY
  // problem until the provider runs out of keys, and only then a PROVIDER problem.
  const config = testConfig();
  let n = 0;
  const f = mockFetch([
    ["stub.cloud", () => (n++ === 0 ? status(429, "slow down", { "retry-after": "1" }) : ok("cloud answer"))],
  ]);
  const breaker = new ProviderBreaker({ threshold: 2 });
  const ctx = { ...ctxFor(config, f, { CLOUD_KEY: "k1", CLOUD_KEY_2: "k2" }), breaker };

  for (let i = 0; i < 3; i += 1) {
    const out = await route({ ...ctx, cls: "code", pinned: { provider: "cloud", model: "big-model" }, body: { messages: [] } });
    assert.equal(out.target, "cloud/big-model");
  }
  assert.equal(f.count("stub.cloud"), 4, "the first request used both keys, the rest one");
  assert.equal(breaker.stats().providers.cloud.state, "closed", "an absorbed rate limit is not a provider outage");
});

test("/admin/status reports the circuit state per provider", async () => {
  const config = testConfig();
  const f = mockFetch([
    ["stub.local", () => status(500, "boom")],
    ["stub.cloud", () => ok()],
  ]);
  const breaker = new ProviderBreaker({ threshold: 1, defaultCooldownMs: 30_000 });
  const base = await startServer({ ...ctxFor(config, f), breaker });
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "code", messages: [] }),
  });
  const s = await (await fetch(`${base}/admin/status`)).json();
  assert.equal(s.breaker.enabled, true);
  assert.equal(s.breaker.threshold, 1);
  assert.equal(s.providers.local.circuit.state, "open");
  assert.equal(s.providers.local.circuit.trips, 1);
  assert.equal(s.providers.cloud.circuit.state, "closed");
  assert.ok(s.providers.local.circuit.openForMs > 0);
});

// --------------------------------------------------------------- the token gate

test("with no token configured the router stays open, and says so at boot", () => {
  const config = testConfig();
  assert.equal(authToken(config, {}), "");
  const warnings = validateConfig(config, {});
  assert.ok(
    warnings.some((w) => /unauthenticated|no auth token configured/.test(w)),
    "an open router must announce itself rather than look protected",
  );
});

test("a configured token is read from the named env var, and inline wins", () => {
  const config = testConfig({ auth: { tokenEnv: "ROUTER_TOKEN" } });
  assert.equal(authToken(config, { ROUTER_TOKEN: "  s3cret-token-value  " }), "s3cret-token-value");
  assert.equal(authToken(config, {}), "", "an unset variable is not a token");
  assert.equal(authToken(testConfig({ auth: { token: "inline-token", tokenEnv: "X" } }), { X: "env-token" }), "inline-token");

  const unset = validateConfig(config, {});
  assert.ok(unset.some((w) => /"ROUTER_TOKEN" is not set/.test(w)));
  const short = validateConfig(testConfig({ auth: { token: "short" } }), {});
  assert.ok(short.some((w) => /characters - use at least 16/.test(w)));
});

test("a token-protected router refuses /v1/* and /admin/status without it, and serves with it", async () => {
  const config = testConfig({ auth: { tokenEnv: "ROUTER_TOKEN" } });
  const f = mockFetch([["stub.local", () => ok("authorised")]]);
  // The env is passed through the ctx: the server must read the secret from there,
  // not from the process environment the test runner happens to have.
  const base = await startServer({ ...ctxFor(config, f), env: { ROUTER_TOKEN: "correct-horse-battery" } });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200, "/health stays open: a probe must be able to ask if the router is up");

  const anonymous = await fetch(`${base}/v1/models`);
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /Bearer/);
  assert.match((await anonymous.json()).error.message, /router token/);

  const wrong = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer correct-horse-batteryX" },
    body: JSON.stringify({ model: "code", messages: [] }),
  });
  assert.equal(wrong.status, 401, "a token that is one byte wrong is wrong");

  assert.equal((await fetch(`${base}/admin/status`)).status, 401, "the ledger is behind the gate too");

  const good = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer correct-horse-battery" },
    body: JSON.stringify({ model: "code", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(good.status, 200);
  assert.equal((await good.json()).choices[0].message.content, "authorised");

  const viaHeader = await fetch(`${base}/v1/models`, { headers: { "x-router-token": "correct-horse-battery" } });
  assert.equal(viaHeader.status, 200, "a client that will not send Authorization can send x-router-token");
});

// ---------------------------------------------------------------- why the chain had no answer

test("a spent monthly cap is named, because retrying it never helps", async () => {
  const config = testConfig({ budgets: { monthlyUsd: { cloud: 40 } } });
  const f = mockFetch([["stub.local", () => status(500, "down")]]);
  const ctx = ctxFor(config, f);
  ctx.ledger.record("cloud", 40.15);
  await assert.rejects(
    () => route({ ...ctx, cls: "code", body: { messages: [] } }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.meta.hint, /monthly spend cap for cloud is used up/);
      assert.match(err.meta.hint, /\$40\.15 spent, cap \$40\.00/);
      assert.equal(f.count("stub.cloud"), 0, "nothing was sent to an over-budget provider");
      return true;
    },
  );
});

test("a local 5xx names the model the server actually has loaded", async () => {
  const bare = testConfig();
  const config = testConfig({
    providers: {
      ...bare.providers,
      local: { ...bare.providers.local, baseUrl: "http://127.0.0.1:9/v1" },
    },
    classes: { fast: { chain: ["local/nemotron-3-nano-omni"] } },
  });
  const f = mockFetch([
    ["/props", () => new Response(JSON.stringify({ model_alias: "qwen3.8-27b" }), { status: 200, headers: { "content-type": "application/json" } })],
    ["127.0.0.1:9", () => status(500, "failed to load model")],
  ]);
  await assert.rejects(
    () => route({ ...ctxFor(config, f), cls: "fast", body: { messages: [] } }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.meta.hint, /has "qwen3\.8-27b" loaded, not "nemotron-3-nano-omni"/);
      assert.equal(err.meta.attempts[0].loadedModel, "qwen3.8-27b");
      // One probe, not one per retry: the error path stays cheap.
      assert.equal(f.count("/props"), 1);
      return true;
    },
  );
});
