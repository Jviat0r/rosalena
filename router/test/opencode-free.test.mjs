/**
 * The OpenCode free tier, tested against a stub that reproduces its gates.
 *
 * Every rule here was measured against the real gateway on 2026-10-20, and each
 * one fails with the SAME message ("FreeTierError: OpenCode's free tier can only
 * be used from within OpenCode"), which is why they are pinned individually: a
 * regression in any one of them is invisible except as a 403, and a 403 is
 * indistinguishable from a bad key by the time it reaches the caller.
 *
 *   stream:true required  |  ses_ session headers required  |  tool named
 *   exactly `read` required
 *
 * No network: the upstream is a local stub that enforces the gates the way the
 * real one does, so the test fails loudly if the router stops satisfying them.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { KeyPool, Ledger, readKeyFile } from "../src/limits.mjs";
import {
  OPENCODE_SESSION_RE,
  buildUpstreamRequest,
  ensureToolNames,
  normalizeOpenCodeSessionId,
  openCodeHeaders,
  openCodeSessionToken,
  rewriteSseToolNames,
} from "../src/providers.mjs";
import { route } from "../src/router.mjs";

const TMP = mkdtempSync(join(tmpdir(), "router-free-"));
const silence = { log() {}, recent: () => [], file: () => null };
const servers = [];
after(() => {
  for (const s of servers) s.close();
});

/** The gateway's reply when any gate is unsatisfied, verbatim. */
const FREE_TIER_403 = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "OpenCode's free tier can only be used from within OpenCode.",
  },
});

/**
 * A stub that behaves like the real free tier: it 403s unless the request
 * streams, carries a well-formed ses_ session header, and includes a tool named
 * `read`. When the gates are satisfied it streams a reply.
 */
async function freeTierStub({ reply = "hello from the free tier", toolCall = null, refuse = false } = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const session = String(req.headers["x-opencode-session"] ?? "");
    const tools = (body.tools ?? []).map((t) => t?.function?.name);
    seen.push({ headers: req.headers, body });

    const gated =
      refuse ||
      body.stream !== true ||
      !OPENCODE_SESSION_RE.test(session) ||
      !tools.includes("read") ||
      String(req.headers["x-opencode-client"] ?? "") !== "cli";
    if (gated) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(FREE_TIER_403);
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    const id = "chatcmpl-stub";
    const created = Math.floor(Date.now() / 1000);
    const frame = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (toolCall) {
      res.write(frame({ role: "assistant", content: "", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolCall, arguments: "" } }] }));
      res.write(frame({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }));
      res.write(frame({}, "tool_calls"));
    } else {
      res.write(frame({ role: "assistant", content: "" }));
      for (const word of reply.split(" ")) res.write(frame({ content: `${word} ` }));
      res.write(frame({}, "stop"));
    }
    res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 21, completion_tokens: 7 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  return { base, seen };
}

function freeConfig(base) {
  return {
    host: "127.0.0.1",
    port: 0,
    logDir: TMP,
    stateFile: join(TMP, `ledger-${Math.random().toString(36).slice(2)}.json`),
    requestTimeoutMs: 5_000,
    defaultClass: "fast",
    budgets: { monthlyUsd: { "opencode-free": 0 } },
    providers: {
      "opencode-free": {
        kind: "openai",
        baseUrl: base,
        apiKeyEnv: "OPENCODE_API_KEY",
        prices: { in: 0, out: 0 },
        requiresStream: true,
        clientHeaders: "opencode",
        ensureTools: ["read"],
      },
    },
    classes: { fast: { chain: ["opencode-free/deepseek-v4.1-flash-free"] } },
  };
}

function ctxFor(config) {
  return {
    config,
    ledger: new Ledger(config.stateFile),
    keyPool: new KeyPool({ OPENCODE_API_KEY: "oc_sk_test" }, config.providers),
    logger: silence,
  };
}

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

// ------------------------------------------------------------------- the gates

test("a buffered caller is answered even though the provider only streams", async () => {
  const { base, seen } = await freeTierStub({ reply: "the answer is 42" });
  const config = freeConfig(base);
  const out = await route({
    ...ctxFor(config),
    cls: "fast",
    body: { messages: [{ role: "user", content: "hi" }], tools: [READ_FILE_TOOL] },
    sessionId: "run-abc",
  });
  assert.equal(out.stream, false, "the caller asked for one answer, so it gets one");
  assert.equal(out.completion.choices[0].message.content.trim(), "the answer is 42");
  assert.equal(out.completion.usage.prompt_tokens, 21);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.stream, true, "upstream was asked to stream, because it refuses otherwise");
});

test("the session id is minted in opencode's grammar and is stable per conversation", async () => {
  const { base, seen } = await freeTierStub();
  const config = freeConfig(base);
  for (const session of ["run-abc", "run-abc", "run-xyz"]) {
    await route({ ...ctxFor(config), cls: "fast", body: { messages: [{ role: "user", content: "hi" }], tools: [READ_FILE_TOOL] }, sessionId: session });
  }
  const ids = seen.map((s) => s.headers["x-opencode-session"]);
  assert.equal(ids.length, 3);
  for (const id of ids) assert.match(id, OPENCODE_SESSION_RE, `"${id}" is not a ses_ token`);
  assert.equal(ids[0], ids[1], "the same conversation keeps one id, which is what prompt-cache affinity needs");
  assert.notEqual(ids[0], ids[2], "two conversations never share an id");
  for (const header of ["x-session-affinity", "x-opencode-session-id", "x-session-id"]) {
    assert.equal(seen[0].headers[header], ids[0], `${header} carries the same token`);
  }
  assert.equal(seen[0].headers["x-opencode-project"], "global");
});

test("a caller's read tool is sent as `read`, and the name comes back as the caller's", async () => {
  const { base, seen } = await freeTierStub({ toolCall: "read" });
  const config = freeConfig(base);
  const out = await route({
    ...ctxFor(config),
    cls: "fast",
    body: { messages: [{ role: "user", content: "read a.txt" }], tools: [READ_FILE_TOOL] },
    sessionId: "run-tools",
  });
  assert.deepEqual(seen[0].body.tools.map((t) => t.function.name), ["read"], "the wire name must be exactly read");
  assert.deepEqual(seen[0].body.tools[0].function.parameters, READ_FILE_TOOL.function.parameters, "the schema is the caller's, untouched");
  const call = out.completion.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "read_file", "the caller must never receive a tool it did not advertise");
  assert.equal(call.function.arguments, '{"path":"a.txt"}');
  assert.equal(out.completion.choices[0].finish_reason, "tool_calls");
});

test("a streaming caller's tool name is rewritten inside the frames", async () => {
  const { base } = await freeTierStub({ toolCall: "read" });
  const config = freeConfig(base);
  const out = await route({
    ...ctxFor(config),
    cls: "fast",
    body: { messages: [{ role: "user", content: "read a.txt" }], tools: [READ_FILE_TOOL], stream: true },
    sessionId: "run-stream",
  });
  assert.equal(out.stream, true);
  const frames = [];
  for await (const frame of rewriteSseToolNames(out.response.body, out.aliases)) frames.push(frame);
  const text = frames.join("");
  assert.match(text, /"name":"read_file"/, "the rename must be undone in the stream, not only in a buffered reply");
  assert.doesNotMatch(text, /"name":"read"/);
  assert.match(text, /data: \[DONE\]/);
});

test("a caller with no read tool gets a stub, and the stub is the documented one", () => {
  const { tools, aliases } = ensureToolNames([{ type: "function", function: { name: "search", parameters: {} } }], ["read"]);
  assert.deepEqual(tools.map((t) => t.function.name), ["search", "read"]);
  assert.equal(aliases.get("read"), null, "no caller equivalent exists, so there is nothing to map back to");
  assert.match(tools[1].function.description, /Read a file/);
});

test("an existing `read` tool is not touched or duplicated", () => {
  const tool = { type: "function", function: { name: "read", parameters: { type: "object" } } };
  const { tools, aliases } = ensureToolNames([tool], ["read"]);
  assert.equal(tools.length, 1);
  assert.equal(aliases.size, 0);
});

test("no session id at all still produces a well-formed one", () => {
  const { "x-opencode-session": token } = openCodeHeaders(undefined);
  assert.match(token, OPENCODE_SESSION_RE);
  assert.match(openCodeSessionToken("abc", "salt"), OPENCODE_SESSION_RE);
  assert.notEqual(openCodeSessionToken("abc", "salt"), openCodeSessionToken("abc"), "a salt changes the id");
  assert.equal(normalizeOpenCodeSessionId("ses_ea794a168fffCu7YCrBohCvaXn"), "ses_ea794a168fffCu7YCrBohCvaXn", "a valid token passes through");
});

test("the token is a pure function of the id, so a restart does not change it", () => {
  const a = normalizeOpenCodeSessionId("run-abc");
  const b = normalizeOpenCodeSessionId("run-abc");
  assert.equal(a, b);
  // Different conversations must differ even within the same millisecond.
  assert.notEqual(normalizeOpenCodeSessionId("run-abc"), normalizeOpenCodeSessionId("run-abd"));
});

// ------------------------------------------------------- failing over honestly

test("a 403 from the gated provider falls through to the next target", async () => {
  const { base } = await freeTierStub({ refuse: true });
  const config = freeConfig(base);
  // A second provider in the same chain, answering normally.
  config.providers.plain = { kind: "openai", baseUrl: "http://plain.invalid/v1", apiKeyEnv: null, prices: { in: 0, out: 0 } };
  config.classes.fast.chain = ["opencode-free/deepseek-v4.1-flash-free", "plain/backup"];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("plain.invalid")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: "backup answer" }, finish_reason: "stop" }], usage: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(url, init);
  };
  const out = await route({ ...ctxFor(config), cls: "fast", body: { messages: [{ role: "user", content: "hi" }] }, fetchImpl, sessionId: "run-fail" });
  assert.equal(out.target, "plain/backup");
  assert.equal(out.completion.choices[0].message.content, "backup answer");
  assert.equal(out.attempts[0].target, "opencode-free/deepseek-v4.1-flash-free");
  assert.equal(out.attempts[0].ok, false);
  assert.equal(out.attempts[0].reason, "auth", "a 403 is classified as an auth failure, not a bad request");
});

test("the router does not send `read` when the provider does not ask for it", () => {
  const { init } = buildUpstreamRequest({
    spec: { kind: "openai", baseUrl: "http://stub/v1" },
    model: "m",
    body: { messages: [], tools: [READ_FILE_TOOL] },
  });
  const sent = JSON.parse(init.body);
  assert.deepEqual(sent.tools.map((t) => t.function.name), ["read_file"]);
});

test("a required tool name is applied even when the caller sent no tools at all", () => {
  const { init } = buildUpstreamRequest({
    spec: { kind: "openai", baseUrl: "http://stub/v1", ensureTools: ["read"] },
    model: "m",
    body: { messages: [] },
  });
  const sent = JSON.parse(init.body);
  assert.deepEqual(sent.tools.map((t) => t.function.name), ["read"]);
});

// ------------------------------------------------------------------ key file

test("a keys file is read, and an env var still wins by being tried first", () => {
  const file = join(TMP, "keys.json");
  writeFileSync(file, JSON.stringify({ providers: { "opencode-free": ["oc_sk_file"], anthropic: "sk-ant-file" } }));
  const keys = readKeyFile(file);
  assert.deepEqual(keys["opencode-free"], ["oc_sk_file"]);
  assert.deepEqual(keys.anthropic, ["sk-ant-file"]);

  const config = freeConfig("http://unused/v1");
  const pool = new KeyPool({ OPENCODE_API_KEY: "oc_sk_env" }, config.providers, { keyFile: file });
  assert.deepEqual(pool.all("opencode-free"), ["oc_sk_env", "oc_sk_file"]);
});

test("a key saved to the file later is picked up without a restart, and a removed one goes", async () => {
  // The app's Settings page writes this file while the router runs; a key typed there has
  // to work on the next message.
  const file = join(TMP, "live-keys.json");
  writeFileSync(file, JSON.stringify({ providers: {} }));
  const config = freeConfig("http://unused/v1");
  config.providers.anthropic = { kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" };
  const pool = new KeyPool({}, config.providers, { keyFile: file });
  assert.deepEqual(pool.all("anthropic"), []);
  await new Promise((r) => setTimeout(r, 1100));
  writeFileSync(file, JSON.stringify({ providers: { anthropic: ["sk-ant-new-key"] } }));
  assert.deepEqual(pool.all("anthropic"), ["sk-ant-new-key"]);
  await new Promise((r) => setTimeout(r, 1100));
  writeFileSync(file, JSON.stringify({ providers: {} }));
  assert.deepEqual(pool.all("anthropic"), []);
});

test("a malformed or missing keys file is not fatal", () => {
  const bad = join(TMP, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.deepEqual(readKeyFile(bad), {});
  assert.deepEqual(readKeyFile(join(TMP, "nope.json")), {});
  assert.deepEqual(readKeyFile(null), {});
});

// ------------------------------------------------- a machine with no key at all

/**
 * The bug this pins, found by running the 0.1.0 macOS build on a Mac: nothing in that
 * install had a key, so the free route was skipped as `no_key`, and because the class has
 * exactly one target every request ended as a 503 "every target in the chain failed".
 *
 * The gateway does not need the key: measured 2026-10-20 (data/probe-key-class.mjs), a request
 * with no authorization header answers 200, a well-formed FAKE key answers 401 Invalid
 * credential, and a real key answers 200. So the key is optional on this provider, and an
 * absent one must not cost the app its only route.
 */
function keylessCtx(config) {
  return { ...ctxFor(config), keyPool: new KeyPool({}, config.providers) };
}

test("with no key stored anywhere, the free route is still tried and carries no credential", async () => {
  const { base, seen } = await freeTierStub({ reply: "answer without a key" });
  const config = freeConfig(base);
  config.providers["opencode-free"].apiKeyOptional = true;
  const out = await route({ ...keylessCtx(config), cls: "fast", body: { messages: [{ role: "user", content: "hi" }], tools: [READ_FILE_TOOL] }, sessionId: "run-keyless" });
  assert.equal(seen.length, 1, "the request reached the provider instead of being skipped");
  assert.equal(out.completion.choices[0].message.content.trim(), "answer without a key");
  assert.equal(out.attempts[0].reason, undefined, "no skip was recorded");
  assert.equal(seen[0].headers.authorization, undefined, "no credential is invented, because a fake one is a 401");
  assert.equal(seen[0].headers["x-opencode-session"] !== undefined, true, "the headers that DO open the door are still sent");
});

test("the shipped config makes the free route key-optional, and the optional key is still used when present", async () => {
  const shipped = JSON.parse(readFileSync(new URL("../router.config.json", import.meta.url), "utf8"));
  const spec = shipped.providers["opencode-free"];
  assert.equal(spec.apiKeyOptional, true, "a fresh install has no key, so this route cannot require one");

  const { base, seen } = await freeTierStub({ reply: "answer with a key" });
  const config = freeConfig(base);
  Object.assign(config.providers["opencode-free"], {
    apiKeyOptional: spec.apiKeyOptional,
    apiKeyEnv: spec.apiKeyEnv,
  });
  await route({ ...ctxFor(config), cls: "fast", body: { messages: [{ role: "user", content: "hi" }], tools: [READ_FILE_TOOL] }, sessionId: "run-keyed" });
  assert.equal(seen[0].headers.authorization, "Bearer oc_sk_test", "a configured key is sent, because an account with one is what the header is for");
});

test("a key that is required is still required", async () => {
  const { base, seen } = await freeTierStub();
  const config = freeConfig(base);
  delete config.providers["opencode-free"].apiKeyOptional;
  await assert.rejects(
    () => route({ ...keylessCtx(config), cls: "fast", body: { messages: [{ role: "user", content: "hi" }] }, sessionId: "run-required" }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.meta.hint, /OPENCODE_API_KEY is not set/);
      assert.match(err.meta.hint, /keys\.json/, "the hint names the file that fixes it");
      return true;
    },
  );
  assert.equal(seen.length, 0, "a provider that needs a key is not called without one");
});

test("a chain that fails for mixed reasons gets no summary, just the attempts", async () => {
  const { base } = await freeTierStub({ refuse: true });
  const config = freeConfig(base);
  delete config.providers["opencode-free"].apiKeyOptional;
  config.providers.plain = { kind: "openai", baseUrl: "http://plain.invalid/v1", prices: { in: 0, out: 0 } };
  config.classes.fast.chain = ["opencode-free/deepseek-v4.1-flash-free", "plain/backup"];
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "nope" } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    () => route({ ...keylessCtx(config), cls: "fast", body: { messages: [{ role: "user", content: "hi" }] }, fetchImpl, sessionId: "run-mixed" }),
    (err) => {
      assert.equal(err.status, 503);
      assert.match(err.meta.hint, /^1 of 2 targets were skipped for a missing key/);
      assert.equal(err.meta.attempts.length, 2);
      return true;
    },
  );
});



