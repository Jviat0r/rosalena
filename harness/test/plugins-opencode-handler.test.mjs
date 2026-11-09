/**
 * Tests for the opencode-handler plugin.
 *
 * Nothing here touches the network, a real key, or a file outside a temp
 * directory: every fetch is a stub, every key is fake, and every router config is
 * written under `mkdtempSync`. That matters more than usual for this plugin - its
 * whole job is to make a network call and to explain what came back - so the only
 * way to test the honest answers is to control the wire.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlugins } from "../src/plugins.mjs";
import plugin, {
  BASE_URL,
  FREE_MODELS,
  PROVIDER,
  SESSION_RE,
  applyUse,
  chainsFor,
  classifyFailure,
  classifyProbe,
  findKey,
  formatUse,
  freeModels,
  freeTierHeaders,
  keyReport,
  keySources,
  lastFailure,
  loadDshRecord,
  loadState,
  maskKey,
  modelsReport,
  normalizeSessionId,
  planUse,
  probe,
  probeRequest,
  readKeysFrom,
  readRouter,
  readYamlCredential,
  recordFailure,
  recordSuccess,
  resolveRouterFile,
  routerGates,
  sessionToken,
  statusReport,
} from "../plugins/rosa-opencode-handler/plugin.mjs";

const PLUGIN_DIR = fileURLToPath(new URL("../plugins/rosa-opencode-handler", import.meta.url));
const roots = [];

// The plugin prefers the environment over every file, and a machine that happens to
// export the real key must not turn a unit test into a live probe.
const SAVED_KEY = process.env.OPENCODE_API_KEY;
delete process.env.OPENCODE_API_KEY;

/** A temp root, cleaned up when the file finishes. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "rosalena-ofa-"));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  if (SAVED_KEY === undefined) delete process.env.OPENCODE_API_KEY;
  else process.env.OPENCODE_API_KEY = SAVED_KEY;
});

/** A healthy router config with the same numbers the real one carries. */
function routerConfig() {
  return {
    providers: {
      [PROVIDER]: {
        kind: "openai",
        label: "OpenCode Zen Free",
        baseUrl: BASE_URL,
        apiKeyEnv: "OPENCODE_API_KEY",
        prices: { in: 0, out: 0 },
        requiresStream: true,
        clientHeaders: "opencode",
        ensureTools: ["read"],
        userAgent: "opencode/latest/2.0.29/cli",
        models: [
          { id: "deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free", contextWindow: 200000, maxTokens: 65536 },
          { id: "glm-5.3-flash-free", label: "GLM-5.3 Flash Free", contextWindow: 200000, maxTokens: 65536 },
        ],
        $note: "keep me",
      },
    },
    models: [
      { target: "local/qwen3.8-27b", label: "Qwen3.8 27B (this PC)" },
      { target: `${PROVIDER}/deepseek-v4.1-flash-free`, label: "DeepSeek V4.1 Flash Free" },
      { target: `${PROVIDER}/glm-5.3-flash-free`, label: "GLM-5.3 Flash Free" },
    ],
    classes: {
      fast: { chain: ["local/qwen3.8-27b", `${PROVIDER}/glm-5.3-flash-free`] },
      code: { chain: [`${PROVIDER}/deepseek-v4.1-flash-free`, "local/qwen3.8-27b"] },
    },
    $classes: "keep me too",
  };
}

function writeRouter(root, config = routerConfig()) {
  const file = join(root, "router", "router.config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}

function ctxFor(root, extra = {}) {
  const { fetchImpl, ...config } = extra;
  const ctx = { root, config: { stateFile: join(root, "state.json"), includeDsh: false, ...config } };
  if (fetchImpl) ctx.fetchImpl = fetchImpl;
  return ctx;
}

/** A stub fetch answer with a Headers-shaped object. */
function answer(status, body, headers = {}) {
  return {
    status,
    headers: { entries: () => Object.entries(headers) },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

function noNetwork() {
  throw new Error("network must not be called");
}

/** Every stub records what it was asked, so the request itself can be asserted. */
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return reply;
  };
  return { calls, fetchImpl };
}

test("the shipped folder has a complete manifest and loads with no errors", async () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8"));
  assert.equal(manifest.id, "rosa-opencode-handler");
  assert.equal(manifest.entry, "plugin.mjs");
  assert.equal(manifest.enabled, true);
  assert.equal(manifest.bundled, true);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.config.probeModel, "deepseek-v4.1-flash-free");
  assert.equal(manifest.config.defaultClass, "fast");
  assert.equal(manifest.config.includeDsh, false, "Rosalena does not read DeepSeek Harness files unless asked");
  assert.ok(readFileSync(join(PLUGIN_DIR, "README.md"), "utf8").length > 1000);

  const root = scratch();
  const plugins = join(root, "plugins");
  mkdirSync(join(plugins, "rosa-opencode-handler"), { recursive: true });
  writeFileSync(join(plugins, "rosa-opencode-handler", "plugin.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(
    join(plugins, "rosa-opencode-handler", "plugin.mjs"),
    readFileSync(join(PLUGIN_DIR, "plugin.mjs"), "utf8"),
    "utf8",
  );
  const host = await loadPlugins({ dir: plugins, root });
  assert.deepEqual(host.errors, []);
  const loaded = host.plugins.find((entry) => entry.id === "rosa-opencode-handler");
  assert.ok(loaded, "the plugin loaded");
  assert.deepEqual(loaded.tools, ["free_model_status"]);
  assert.deepEqual(loaded.commands.sort(), ["clear", "gates", "key", "models", "status", "use", "who"]);
  assert.deepEqual(loaded.hooks, ["llm/stream"]);
  assert.match(loaded.status, /free model\(s\)/);
  assert.equal(host.tools.filter((tool) => tool.name === "free_model_status").length, 1);
  assert.ok(host.commands.has("rosa-opencode-handler:status"));
  assert.ok(host.commands.has("rosa-opencode-handler:use"));
  assert.ok(host.hooks.some((hook) => hook.plugin === "rosa-opencode-handler" && hook.name === "llm/stream"));
});

test("session ids: derived tokens have the wire shape, valid ids pass through", () => {
  const token = sessionToken("conversation-42");
  assert.match(token, SESSION_RE);
  assert.equal(token.length, 30);
  assert.equal(normalizeSessionId(token), token);
  const hashed = normalizeSessionId("ses-probe-router-1");
  assert.match(hashed, SESSION_RE);
  assert.notEqual(hashed, "ses-probe-router-1");
  assert.equal(normalizeSessionId(""), sessionToken("rosalena-opencode-free"));
  assert.equal(sessionToken("a"), sessionToken("a"), "deterministic");
  assert.notEqual(sessionToken("a"), sessionToken("b"));
});

test("the probe carries the fingerprint headers, the key, stream and the read tool", async () => {
  const headers = freeTierHeaders("conversation-1", { key: "oc_sk_test", userAgent: "ua-test" });
  const token = headers["x-opencode-session"];
  assert.match(token, SESSION_RE);
  assert.equal(headers["x-session-affinity"], token);
  assert.equal(headers["x-opencode-session-id"], token);
  assert.equal(headers["x-session-id"], token);
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-project"], "global");
  assert.equal(headers["user-agent"], "ua-test");
  assert.equal(headers.authorization, "Bearer oc_sk_test");

  const body = probeRequest("glm-5.3-flash-free");
  assert.equal(body.model, "glm-5.3-flash-free");
  assert.equal(body.stream, true);
  assert.ok(body.max_tokens <= 16);
  assert.equal(body.tools[0].function.name, "read");

  const { calls, fetchImpl } = recorder(answer(200, SSE_OK));
  const result = await probe({ key: "oc_sk_test", model: "glm-5.3-flash-free", fetchImpl });
  assert.equal(result.verdict, "usable");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/chat/completions`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-opencode-client"], "cli");
  assert.equal(calls[0].init.headers.authorization, "Bearer oc_sk_test");
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.tools[0].function.name, "read");
});

test("classifyProbe returns six distinct verdicts and never merges them", () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  assert.equal(classifyProbe({ status: 200, bodyText: SSE_OK }).verdict, "usable");
  assert.equal(classifyProbe({ status: 200, bodyText: '{"choices":[]}' }).verdict, "usable");
  const html = classifyProbe({ status: 200, bodyText: "<html>oops</html>" });
  assert.equal(html.verdict, "error");
  assert.match(html.detail, /not an OpenAI completion/);

  const exhausted = classifyProbe({
    status: 429,
    headers: { "retry-after": "3600" },
    bodyText: JSON.stringify({ error: { code: "FreeUsageLimitError", message: "Rate limit exceeded. Please try again later." } }),
    now,
  });
  assert.equal(exhausted.verdict, "exhausted");
  assert.equal(exhausted.resetAt, now + 3600 * 1000);
  assert.equal(exhausted.resetSource, "Retry-After");

  const bodyReset = classifyProbe({
    status: 429,
    bodyText: JSON.stringify({ error: { resets_at: "2026-10-21T09:00:00.000Z" } }),
    now,
  });
  assert.equal(bodyReset.resetSource, "response body");
  assert.equal(bodyReset.resetAt, Date.parse("2026-10-21T09:00:00.000Z"));

  const estimate = classifyProbe({
    status: 429,
    bodyText: "FreeUsageLimitError: Rate limit exceeded.",
    now,
    firstFailureAt: now - 60 * 60 * 1000,
  });
  assert.equal(estimate.resetAt, now + 23 * 60 * 60 * 1000);
  assert.match(estimate.resetSource, /estimate/);

  const refused = classifyProbe({
    status: 403,
    bodyText: "FreeTierError: OpenCode's free tier can only be used from within OpenCode",
  });
  assert.equal(refused.verdict, "refused");
  assert.match(refused.detail, /gate is unsatisfied/);

  assert.equal(classifyProbe({ status: 401, bodyText: "unauthorized" }).verdict, "key");
  assert.equal(classifyProbe({ status: 500, bodyText: "boom" }).verdict, "error");
  assert.equal(classifyFailure("429 FreeUsageLimitError").verdict, "exhausted");
  assert.equal(classifyFailure("FreeTierError").verdict, "refused");
  assert.equal(classifyFailure("ECONNREFUSED").verdict, "error");
});

test("status with a healthy router probes, lists both models, and records the success", async () => {
  const root = scratch();
  writeRouter(root);
  const { calls, fetchImpl } = recorder(answer(200, SSE_OK));
  const out = await statusReport(ctxFor(root, { apiKey: "oc_sk_test_1234567890", fetchImpl }));
  assert.match(out, /probe: USABLE/);
  assert.match(out, /gates: all three satisfied/);
  assert.match(out, /ok {2,}streams every request/);
  assert.match(out, /free models here \(2\)/);
  assert.match(out, /deepseek-v4\.1-flash-free/);
  assert.match(out, /glm-5\.3-flash-free/);
  assert.match(out, /last observed failure: none recorded/);
  assert.match(out, /key: oc_sk\.\.\.7890/);
  assert.equal(calls.length, 1);
  const { state } = loadState(join(root, "state.json"));
  assert.equal(state.lastSuccess.model, "deepseek-v4.1-flash-free");
  assert.equal(state.observations, 1);
});

test("status with no router config lists the built-in models and probes the default endpoint", async () => {
  const root = scratch();
  const { calls, fetchImpl } = recorder(answer(200, SSE_OK));
  const out = await statusReport(ctxFor(root, { apiKey: "oc_sk_test", fetchImpl }));
  assert.match(out, /there is no router config at/);
  assert.match(out, /probe: no router config, so this uses the default endpoint/);
  assert.match(out, /deepseek-v4\.1-flash-free/);
  assert.match(out, /glm-5\.3-flash-free/);
  assert.match(out, /probe: USABLE/);
  assert.equal(calls[0].url, `${BASE_URL}/chat/completions`);
});

test("status with a malformed router config says so and still probes", async () => {
  const root = scratch();
  const file = join(root, "router", "router.config.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{ not json", "utf8");
  const { calls, fetchImpl } = recorder(answer(200, SSE_OK));
  const out = await statusReport(ctxFor(root, { apiKey: "oc_sk_test", fetchImpl }));
  assert.match(out, /router: UNKNOWN - router config at .* is not valid JSON/);
  assert.match(out, /gates: cannot be checked without a router config/);
  assert.match(out, /probe: USABLE/);
  assert.equal(calls.length, 1);
});

test("a broken gate is named with its fix, and the probe is skipped", async () => {
  const root = scratch();
  const config = routerConfig();
  config.providers[PROVIDER].requiresStream = false;
  delete config.providers[PROVIDER].clientHeaders;
  config.providers[PROVIDER].ensureTools = ["read_file"];
  writeRouter(root, config);
  const out = await statusReport(ctxFor(root, { apiKey: "oc_sk_test", fetchImpl: noNetwork }));
  assert.match(out, /gates: BROKEN/);
  assert.match(out, /FAIL {2}streams every request/);
  assert.match(out, /requiresStream is false/);
  assert.match(out, /FAIL {2}sends the OpenCode client fingerprint/);
  assert.match(out, /FAIL {2}contains a tool named exactly read/);
  assert.match(out, /-> set providers\.opencode-free\.requiresStream: true/);
  assert.match(out, /probe: skipped - a broken gate/);
});

test("a router without the provider is reported, and the gates say what to add", async () => {
  const root = scratch();
  writeRouter(root, { providers: {}, classes: {} });
  const out = await statusReport(ctxFor(root, { includeDsh: false }));
  assert.match(out, /gates: BROKEN/);
  assert.match(out, /no providers\.opencode-free/);
  assert.match(out, /set providers\.opencode-free\.requiresStream: true/);
});

test("no key means no probe, and nothing on the network is called", async () => {
  const root = scratch();
  writeRouter(root);
  const out = await statusReport(ctxFor(root, {}), { fetchImpl: noNetwork });
  assert.match(out, /probe: skipped - the free tier needs a credential/);
  assert.match(out, /key: none found/);
});

test("models lists limits, class positions, and falls back to the built-in list", async () => {
  const root = scratch();
  writeRouter(root);
  const out = modelsReport(ctxFor(root));
  assert.match(out, /free models on opencode-free/);
  assert.match(out, /deepseek-v4\.1-flash-free/);
  assert.match(out, /200000 ctx \/ 65536 out/);
  assert.match(out, /fast \(#2\/2\)/);
  assert.match(out, /code \(#1\/2\)/);
  assert.match(out, /pick one: \/opencode-free use <id>/);

  const empty = scratch();
  const fallback = modelsReport(ctxFor(empty));
  assert.match(fallback, /built-in list/);
  for (const model of FREE_MODELS) assert.ok(fallback.includes(model.id));
  assert.match(fallback, /class positions unknown \(no router config\)/);
});

test("chainsFor is about classes, not about the curated menu", () => {
  const config = routerConfig();
  const chains = chainsFor(config, `${PROVIDER}/glm-5.3-flash-free`);
  assert.deepEqual(chains, [{ id: "fast", index: 2, size: 2 }]);
  assert.deepEqual(chainsFor(config, "local/qwen3.8-27b").map((entry) => entry.id), ["fast", "code"]);
  assert.deepEqual(chainsFor(config, "nothing/here"), []);
});

test("use is accepted, prints the exact change, and writes nothing by default", async () => {
  const root = scratch();
  const file = writeRouter(root);
  const before = readFileSync(file, "utf8");
  const commands = plugin.commands(ctxFor(root));
  const out = await commands.use(["glm-5.3-flash-free"]);
  assert.match(out, /use opencode-free\/glm-5\.3-flash-free -> first in class "fast"/);
  assert.match(out, /before: local\/qwen3\.8-27b, opencode-free\/glm-5\.3-flash-free/);
  assert.match(out, /after: {2}opencode-free\/glm-5\.3-flash-free, local\/qwen3\.8-27b/);
  assert.match(out, /not written: re-run with --write/);
  assert.equal(readFileSync(file, "utf8"), before, "no write without --write");

  const prefixed = await commands.use(["opencode-free/deepseek-v4.1-flash-free", "--class", "code"]);
  assert.match(prefixed, /use opencode-free\/deepseek-v4\.1-flash-free -> first in class "code"/);
  assert.match(prefixed, /no change: that model is already first/);

  const prefix = await commands.use(["deepseek"]);
  assert.match(prefix, /first in class "fast"/, "a unique prefix resolves, class defaults to fast");
});

test("use is refused for another provider, an unknown model, an ambiguous prefix and a missing class", () => {
  const config = routerConfig();
  const other = planUse({ config, model: "local/qwen3.8-27b" });
  assert.equal(other.ok, false);
  assert.match(other.why, /not an opencode-free one/);
  assert.match(other.hint, /deepseek-v4\.1-flash-free/);

  const unknown = planUse({ config, model: "gpt-5.1" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.why, /not a free model/);

  const noClass = planUse({ config, model: "glm-5.3-flash-free", classId: "nope" });
  assert.equal(noClass.ok, false);
  assert.match(noClass.why, /no class "nope"/);
  assert.match(noClass.hint, /fast, code/);

  const empty = planUse({ config, model: "" });
  assert.equal(empty.ok, false);
  assert.match(empty.why, /no model given/);

  const two = JSON.parse(JSON.stringify(config));
  two.providers[PROVIDER].models.push({ id: "glm-5.3-flash-free-old", label: "Old" });
  const ambiguous = planUse({ config: two, model: "glm" });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.why, /matches more than one/);
  assert.match(ambiguous.hint, /glm-5\.3-flash-free, glm-5\.3-flash-free-old/);

  assert.match(formatUse(unknown), /^refused: /);
  assert.match(formatUse(unknown), /free models:/);
});

test("no router config means use refuses instead of inventing one", async () => {
  const root = scratch();
  const out = await plugin.commands(ctxFor(root)).use(["glm-5.3-flash-free"]);
  assert.match(out, /^refused: there is no router config at/);
});

test("use --write applies one chain atomically, keeps a backup, and leaves every other key alone", async () => {
  const root = scratch();
  const file = writeRouter(root);
  const before = JSON.parse(readFileSync(file, "utf8"));
  const beforeText = readFileSync(file, "utf8");
  const out = await plugin.commands(ctxFor(root)).use(["glm-5.3-flash-free", "--write"]);
  assert.match(out, /written: .*router\.config\.json \(validated JSON, backup .*\.bak-/);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after.classes.fast.chain, [`${PROVIDER}/glm-5.3-flash-free`, "local/qwen3.8-27b"]);
  assert.deepEqual(after.classes.code, before.classes.code, "the other chain is untouched");
  assert.equal(after.providers[PROVIDER].$note, "keep me");
  assert.deepEqual(after.providers[PROVIDER].models, before.providers[PROVIDER].models);
  assert.deepEqual(after.models, before.models);
  assert.equal(after.$classes, "keep me too");

  const backup = out.match(/backup (.*)\)/)[1];
  assert.ok(existsSync(backup));
  assert.equal(readFileSync(backup, "utf8"), beforeText, "the backup is the pre-edit file");

  const again = await plugin.commands(ctxFor(root)).use(["glm-5.3-flash-free", "--write"]);
  assert.match(again, /no change: that model is already first/);
  assert.match(again, /nothing written: the plan is a no-op/);
});

test("applyUse refuses a stale plan, an invalid file, and a plan that would touch more than one chain", () => {
  const root = scratch();
  const file = writeRouter(root);
  const config = JSON.parse(readFileSync(file, "utf8"));
  const plan = planUse({ config, model: "glm-5.3-flash-free" });

  // The file moved on after the plan was made.
  const changed = JSON.parse(readFileSync(file, "utf8"));
  changed.classes.fast.chain = ["local/qwen3.8-27b"];
  writeFileSync(file, JSON.stringify(changed, null, 2), "utf8");
  assert.throws(() => applyUse({ file, plan }), /chain changed on disk/);

  // A file that is not JSON is never replaced.
  writeFileSync(file, "{ not json", "utf8");
  assert.throws(() => applyUse({ file, plan }), /not valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});

test("a 429 is reported with a reset estimate, and DSH's real record is merged", () => {
  const root = scratch();
  writeRouter(root);
  const dshFile = join(root, "rate-limits.json");
  writeFileSync(
    dshFile,
    JSON.stringify({
      limits: {
        "opencode-free": {
          provider: "opencode-free",
          models: ["deepseek-v4.1-flash-free", "glm-5.3-flash-free"],
          firstHitAt: "2026-10-19T15:49:42.464Z",
          lastHitAt: "2026-10-20T09:09:15.385Z",
          resetEstimateAt: "2026-10-20T15:49:42.464Z",
          hits: 94,
          reason: "FreeUsageLimitError: Rate limit exceeded. Please try again later.",
        },
      },
    }),
    "utf8",
  );
  const loaded = loadDshRecord({ includeDsh: true, file: dshFile });
  assert.equal(loaded.record.hits, 94);
  assert.equal(loaded.record.lastHitAt, Date.parse("2026-10-20T09:09:15.385Z"));
  const failure = lastFailure({ state: {}, dsh: loaded.record });
  assert.equal(failure.verdict, "exhausted");
  assert.equal(failure.status, 429);
  assert.equal(failure.source, dshFile);
  assert.match(failure.detail, /FreeUsageLimitError/);
  assert.equal(failure.resetAt, Date.parse("2026-10-20T15:49:42.464Z"));

  const missing = loadDshRecord({ includeDsh: true, file: join(root, "nope.json") });
  assert.equal(missing.record, null);
  assert.equal(loadDshRecord({ includeDsh: false, file: dshFile }).record, null);
});

test("status prints the last failure with its source and reset, without a probe", async () => {
  const root = scratch();
  writeRouter(root);
  const dshFile = join(root, "rate-limits.json");
  writeFileSync(
    dshFile,
    JSON.stringify({
      limits: {
        "opencode-free": {
          lastHitAt: "2026-10-19T15:49:42.464Z",
          firstHitAt: "2026-10-19T15:49:42.464Z",
          resetEstimateAt: "2026-10-20T15:49:42.464Z",
          hits: 7,
          reason: "FreeUsageLimitError: Rate limit exceeded. Please try again later.",
        },
      },
    }),
    "utf8",
  );
  const out = await statusReport(ctxFor(root, { includeDsh: true, dshRateLimitsFile: dshFile }), { fetchImpl: noNetwork });
  assert.match(out, /last observed failure: 429 exhausted at 2026-10-19 15:49 UTC/);
  assert.match(out, /\(.*rate-limits\.json, 7 hit\(s\)\)/);
  assert.match(out, /reset: 2026-10-20 15:49 UTC/);
  assert.match(out, /also read: .*rate-limits\.json/);
});

test("the llm/stream hook records a free failure and a free success, and ignores everything else", async () => {
  const root = scratch();
  writeRouter(root);
  const ctx = ctxFor(root);
  const hooks = plugin.hooks(ctx);
  const fire = (info) => hooks["llm/stream"](info);
  const stateFile = join(root, "state.json");

  await fire({ phase: "start", ok: true, target: `${PROVIDER}/glm-5.3-flash-free` });
  assert.equal(existsSync(stateFile), false, "a start event records nothing");

  await fire({ phase: "end", ok: false, target: null, error: "ECONNREFUSED 127.0.0.1:8077" });
  assert.equal(existsSync(stateFile), false, "an unrelated failure is not a free-tier failure");

  await fire({ phase: "end", ok: false, target: null, error: "429 FreeUsageLimitError: Rate limit exceeded" });
  let state = loadState(stateFile).state;
  assert.equal(state.lastFailure.verdict, "exhausted");
  assert.equal(state.lastFailure.status, 429);
  assert.equal(state.observations, 1);
  const firstFailureAt = state.firstFailureAt;
  assert.ok(Number.isFinite(firstFailureAt));

  await fire({ phase: "end", ok: true, target: `${PROVIDER}/glm-5.3-flash-free`, ms: 123 });
  state = loadState(stateFile).state;
  assert.equal(state.lastSuccess.model, "glm-5.3-flash-free");
  assert.equal(state.observations, 2);
  assert.equal(state.firstFailureAt, firstFailureAt, "the window start does not move");

  await fire({ phase: "end", ok: false, target: null, error: "boom" });
  assert.equal(loadState(stateFile).state.observations, 2, "unrelated failures are not counted");

  // A second free failure moves lastFailure but keeps the window start.
  await fire({ phase: "end", ok: false, target: null, error: "FreeTierError: can only be used from within OpenCode" });
  state = loadState(stateFile).state;
  assert.equal(state.lastFailure.verdict, "refused");
  assert.equal(state.firstFailureAt, firstFailureAt);

  const out = await statusReport(ctx, { fetchImpl: noNetwork });
  assert.match(out, /last observed failure: 403 refused/);
  assert.match(out, /last good free call: .*glm-5\.3-flash-free\)/);
  assert.match(out, /\(3 observation\(s\)\)/);
});

test("recordFailure keeps the first hit, recordSuccess keeps the failure, and clear removes both", async () => {
  const root = scratch();
  const file = join(root, "state.json");
  const first = Date.UTC(2026, 9, 19, 15, 0, 0);
  recordFailure(file, { verdict: "exhausted", status: 429, detail: "one", at: first, resetAt: first + 86400000, resetSource: "Retry-After" });
  recordFailure(file, { verdict: "exhausted", status: 429, detail: "two", at: first + 3600000 });
  let state = loadState(file).state;
  assert.equal(state.firstFailureAt, first);
  assert.equal(state.lastFailure.detail, "two");
  assert.equal(state.lastFailure.resetAt, null);
  recordSuccess(file, { at: first + 7200000, model: "glm-5.3-flash-free" });
  state = loadState(file).state;
  assert.equal(state.lastFailure.detail, "two", "a success does not erase the failure record");
  assert.equal(state.lastSuccess.model, "glm-5.3-flash-free");
  assert.equal(state.observations, 3);

  const out = await plugin.commands(ctxFor(root)).clear([]);
  assert.match(out, /record cleared:/);
  assert.equal(existsSync(file), false);
  assert.match(await plugin.commands(ctxFor(root)).clear([]), /record cleared:/, "clearing twice is not an error");
});

test("key sources are tried in order and every one is masked", () => {
  const root = scratch();
  const keysFile = join(root, "router", "data", "keys.json");
  mkdirSync(dirname(keysFile), { recursive: true });
  writeFileSync(keysFile, JSON.stringify({ providers: { "opencode-free": ["oc_sk_router_abcdef"] } }), "utf8");
  const yamlFile = join(root, "credentials.yaml");
  writeFileSync(yamlFile, 'OPENCODE_API_KEY: "oc_sk_yaml_xyz"\nOTHER: nope\n', "utf8");
  process.env.OPENCODE_API_KEY = "oc_sk_env_123456";
  try {
    const ctx = ctxFor(root, { includeDsh: true, dshCredentialsFile: yamlFile });
    const sources = keySources(ctx);
    const names = sources.map((source) => source.name);
    assert.match(names[0], /OPENCODE_API_KEY \(environment\)/);
    assert.ok(names.some((name) => /router.*keys\.json/.test(name)));
    assert.ok(names.some((name) => /credentials\.yaml/.test(name)));
    const found = findKey(ctx);
    assert.equal(found.key, "oc_sk_env_123456");
    assert.equal(findKey({ root, config: { stateFile: "", includeDsh: false, apiKey: "oc_sk_config_9999" } }).source, "plugin.json config apiKey");

    const report = keyReport(ctx);
    assert.match(report, /oc_sk\.\.\.3456/);
    assert.doesNotMatch(report, /oc_sk_env_123456/);
    assert.doesNotMatch(report, /oc_sk_router_abcdef/);
    assert.match(report, /in use: oc_sk\.\.\.3456 from OPENCODE_API_KEY \(environment\)/);
  } finally {
    delete process.env.OPENCODE_API_KEY;
  }
  assert.equal(maskKey("short"), "***");
  assert.equal(maskKey(""), "");
});

test("readKeysFrom and readYamlCredential treat a broken source as empty, not as a crash", () => {
  const root = scratch();
  const broken = join(root, "keys.json");
  writeFileSync(broken, "{ nope", "utf8");
  assert.deepEqual(readKeysFrom(broken), []);
  assert.deepEqual(readKeysFrom(join(root, "missing.json")), []);
  const good = join(root, "good.json");
  writeFileSync(good, JSON.stringify({ providers: { "opencode-free": "single-key" } }), "utf8");
  assert.deepEqual(readKeysFrom(good), ["single-key"]);
  const yaml = join(root, "creds.yaml");
  writeFileSync(yaml, "# comment\nOPENCODE_API_KEY: 'quoted-key' # trailing\n", "utf8");
  assert.equal(readYamlCredential(yaml, "OPENCODE_API_KEY"), "quoted-key");
  assert.equal(readYamlCredential(yaml, "OTHER"), "");
});

test("gates and router discovery agree with the file on disk", () => {
  const root = scratch();
  assert.equal(resolveRouterFile({ root }).exists, false);
  const file = writeRouter(root);
  assert.equal(resolveRouterFile({ root }).file, file);
  assert.equal(resolveRouterFile({ root: join(root, "harness"), config: { routerFile: file } }).file, file);

  const router = readRouter({ root });
  assert.equal(router.ok, true);
  assert.equal(router.file, file);
  assert.equal(routerGates(router.config).ok, true);
  assert.equal(routerGates(router.config).gates.length, 3);

  const broken = JSON.parse(readFileSync(file, "utf8"));
  broken.providers[PROVIDER].baseUrl = "https://example.test/v1";
  writeRouter(root, broken);
  const gates = routerGates(broken);
  assert.equal(gates.ok, false);
  assert.match(gates.problem, /would not open the free tier/);
  assert.ok(gates.gates.some((gate) => gate.id === "baseUrl" && /opencode\.ai\/zen\/v1/.test(gate.fix)));

  const noProvider = routerGates({ providers: {} });
  assert.equal(noProvider.ok, false);
  assert.equal(noProvider.provider, null);
});

test("freeModels prefers the router's declaration and keeps curated extras", () => {
  const config = routerConfig();
  config.providers[PROVIDER].models = [
    { id: "deepseek-v4.1-flash-free", label: "Router label", contextWindow: 12345, maxTokens: 678 },
  ];
  config.models.push({ target: `${PROVIDER}/muse-spark-free`, label: "Muse Spark Free" });
  const rows = freeModels(config);
  const deepseek = rows.find((row) => row.id === "deepseek-v4.1-flash-free");
  assert.equal(deepseek.label, "Router label");
  assert.equal(deepseek.contextWindow, 12345);
  assert.equal(deepseek.source, "router");
  const glm = rows.find((row) => row.id === "glm-5.3-flash-free");
  assert.equal(glm.source, "builtin", "a model the router omits still gets its built-in row");
  const muse = rows.find((row) => row.id === "muse-spark-free");
  assert.equal(muse.source, "curated");
  assert.ok(rows.every((row) => row.id !== "local/qwen3.8-27b"));
  assert.equal(freeModels(null).length, FREE_MODELS.length);
});
