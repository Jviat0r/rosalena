/** The `rosalena` class: the assistant persona, on the free tier, with a server-owned prompt.
 *
 * What is being asserted here is a contract in three parts, and each part can fail
 * silently in production if it is only described in a comment:
 *
 *   1. every target in the class is the keyless free tier, DeepSeek first, so the
 *      identity never depends on a paid key and never leaves the free window;
 *   2. the prompt is read once at startup, and a missing or empty file STOPS the
 *      router instead of letting the class speak without its identity;
 *   3. the prompt reaches the UPSTREAM request and reaches nothing else - not the
 *      response body, not /v1/models, not /admin/status, not a log file.
 *
 * No network: every upstream is an injected fetch, and the one process started here
 * exits before it would open a port.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig, validateConfig } from "../src/config.mjs";
import { KeyPool, Ledger } from "../src/limits.mjs";
import { createLogger } from "../src/log.mjs";
import {
  PersonaError,
  loadClassPersonas,
  personaFor,
  resolvePersonaFile,
  withSystemPersona,
} from "../src/persona.mjs";
import { createRouterServer } from "../src/server.mjs";
import { route } from "../src/router.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROUTER_DIR = resolve(HERE, "..");
const CONFIG_FILE = join(ROUTER_DIR, "router.config.json");
const PROMPT_FILE = resolve(ROUTER_DIR, "..", "data", "prompts", "rosalena.md");

const TMP = mkdtempSync(join(tmpdir(), "router-rosalena-"));
const servers = [];
after(() => {
  for (const s of servers) s.close();
});

/** The real config, loaded the way the entrypoint loads it. */
const realConfig = () => loadConfig(CONFIG_FILE);

/** A minimal config whose one class carries a prompt, for the mechanics. */
function personaConfig({ file = join(TMP, "persona.md"), extraClasses = {} } = {}) {
  return {
    providers: { local: { kind: "openai", baseUrl: "http://stub.local/v1", apiKeyEnv: null, prices: { in: 0, out: 0 } } },
    classes: {
      rosalena: { chain: ["local/any-model"], systemPromptFile: file },
      plain: { chain: ["local/any-model"] },
      ...extraClasses,
    },
  };
}

function sse(text = "Rosalena here.") {
  const frames = [
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4 } },
  ];
  const body = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonCompletion(text = "Rosalena here.") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Records the upstream call, so the OUTGOING body can be inspected. */
function recorder(respond = () => jsonCompletion()) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init?.body ?? "{}")) });
    return respond(calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** A slice of the prompt distinctive enough that finding it anywhere is a leak. */
const sentinel = (text) => text.slice(0, 140);

// --------------------------------------------------------------- the class row

test("the shipped rosalena class answers from the free tier, DeepSeek first, with a prompt file", () => {
  const config = realConfig();
  const entry = config.classes?.rosalena;
  assert.ok(entry, "router.config.json must define the rosalena class");
  assert.deepEqual(entry.chain, ["opencode-free/deepseek-v4.1-flash-free", "opencode-free/glm-5.3-flash-free", "omniroute/auto"]);
  // The class was ONE pinned target until 2026-10-20, when the macOS build proved that a single
  // target with no local member means a single skip ends every chat. A fallback is allowed now,
  // but only inside the free tier: a paid provider here would make Rosalena's voice depend on a
  // bill being paid, and the class would stop being the thing a keyless install can talk to.
  // OmniRoute (2026-10-27) is free too, and it is the only target outside OpenCode's shared
  // 429 window, which takes both OpenCode ids out at once.
  assert.ok(entry.chain.length >= 2, "one target is one skip away from a dead request");
  for (const target of entry.chain) {
    assert.match(target, /^(opencode-free|omniroute)\//, `every rosalena target is a free tier, not ${target}`);
  }
  assert.equal(typeof entry.systemPromptFile, "string");
  assert.ok(entry.systemPromptFile.trim().length > 0);
  // It has to be a note a reader can act on, not just a flag, and it has to say what the
  // fallback does and does not cover.
  assert.ok(String(entry.note ?? "").length > 120, "the chain is explained where it is configured");
  assert.match(entry.note, /429/, "the note says the shared free window is taken out by a rate limit, not the fallback");
  // The class ships beside its siblings and must not add a validation warning.
  assert.ok(Object.keys(config.classes).includes("deepseek"), "the older demonstration class is unchanged");
  const warnings = validateConfig(config, {});
  assert.deepEqual(warnings.filter((w) => w.includes("rosalena")), [], "the rosalena class validates cleanly");
});

test("the persona prompt is prepended for whichever target in the class answers", async () => {
  // The old pin guaranteed the identity by having only one model. The identity is the
  // prepended first system message, so what needs proving now is that it survives a failover.
  const config = realConfig();
  const personas = loadClassPersonas(config);
  // The free provider requires streaming (`requiresStream`), so the reply arrives as SSE
  // frames and the router reassembles them; a plain JSON body would parse to empty text.
  const streaming = recorder((call) =>
    call === 1
      ? new Response(JSON.stringify({ error: { message: "model unavailable" } }), { status: 503, headers: { "content-type": "application/json" } })
      : sse("second target answering"),
  );
  const out = await route({
    config,
    personas,
    ledger: new Ledger(join(TMP, "ledger-failover.json")),
    keyPool: new KeyPool({}, config.providers),
    cls: "rosalena",
    body: { messages: [{ role: "user", content: "hi" }] },
    fetchImpl: streaming,
    sessionId: "run-persona-failover",
  });
  assert.equal(out.attempts[0].target, "opencode-free/deepseek-v4.1-flash-free");
  assert.equal(out.attempts[0].ok, false);
  assert.equal(out.target, "opencode-free/glm-5.3-flash-free", "the second target answered");
  assert.equal(out.completion.choices[0].message.content, "second target answering");
  assert.equal(streaming.calls.length, 2);
  const sent = streaming.calls[1].body;
  assert.equal(sent.model, "glm-5.3-flash-free", "the second request names the second model");
  assert.equal(sent.messages[0].role, "system", "the identity is still the first message after a failover");
  assert.ok(String(sent.messages[0].content).includes(sentinel(personas.get("rosalena").text)), "and it is the same prompt file");
});

// ------------------------------------------------------------- loading, once

test("the prompt is read once, resolved against the config file, and used verbatim", () => {
  const file = join(TMP, "once.md");
  writeFileSync(file, "\n\n  PERSONA-BODY-FOR-THE-ONCE-TEST  \n\n", "utf8");
  let reads = 0;
  const personas = loadClassPersonas(personaConfig({ file }), {
    baseDir: TMP,
    readFile: (path) => {
      reads += 1;
      assert.equal(path, file);
      return readFileSync(path, "utf8");
    },
  });
  assert.equal(reads, 1, "one read per class per load: the file is not re-read per request");
  assert.equal(personas.get("rosalena").text, "PERSONA-BODY-FOR-THE-ONCE-TEST", "outer whitespace trimmed, body untouched");
  assert.equal(personas.has("plain"), false, "a class without the key gets no persona");
});

test("the real prompt file is substantial and says the things the class promises", () => {
  const personas = loadClassPersonas(realConfig());
  assert.ok(personas.has("rosalena"), "the shipped config loads a rosalena persona");
  const { file, text } = personas.get("rosalena");
  assert.equal(file, PROMPT_FILE, "resolved relative to router.config.json, not to the process's working directory");
  assert.ok(text.length > 1200, `the prompt is a real charter (${text.length} chars)`);
  // The three things that make it Rosalena and not a generic "be helpful" blob.
  assert.match(text, /You are Rosalena/, "it names itself");
  assert.match(text, /Rosalena Harness app/, "it names the app it runs in");
  assert.match(text, /Never claim to be Claude, GPT, Gemini/, "the honesty clause is present");
  assert.match(text, /Never invent a result or a capability/, "the no-invented-capabilities clause is present");
  assert.match(text, /Never reveal, quote, paraphrase or summarise/, "it is told to keep itself private");
  // The prompt is English only, and stays small enough to prepend to every call.
  assert.ok(!/[\u3000-\u9fff\uac00-\ud7af]/.test(text), "no CJK text in the prompt");
});

test("resolvePersonaFile: relative to the config directory, absolute kept as is, empty refused", () => {
  assert.equal(resolvePersonaFile("data/p.md", "C:\\cfg"), resolve("C:\\cfg", "data", "p.md"));
  const absolute = resolve(TMP, "abs.md");
  assert.equal(resolvePersonaFile(absolute, "C:\\elsewhere"), absolute);
  assert.equal(resolvePersonaFile("", TMP), null);
  assert.equal(resolvePersonaFile(null, TMP), null);
});

// ------------------------------------------------------- fail loudly, not quietly

test("a missing prompt file throws, naming the class and the path", () => {
  const missing = join(TMP, "not-there.md");
  assert.throws(
    () => loadClassPersonas(personaConfig({ file: missing }), { baseDir: TMP }),
    (err) => {
      assert.ok(err instanceof PersonaError);
      assert.match(err.message, /class "rosalena"/);
      assert.ok(err.message.includes(missing), "the message says which file is missing");
      assert.match(err.message, /refuses to start/);
      return true;
    },
  );
});

test("an EMPTY or whitespace-only prompt file throws: losing the identity is not a silent default", () => {
  for (const [name, content] of [
    ["empty.md", ""],
    ["spaces.md", "   \n\t\n  "],
  ]) {
    const file = join(TMP, name);
    writeFileSync(file, content, "utf8");
    assert.throws(
      () => loadClassPersonas(personaConfig({ file }), { baseDir: TMP }),
      (err) => {
        assert.ok(err instanceof PersonaError);
        assert.match(err.message, /EMPTY system prompt/);
        assert.ok(err.message.includes(file));
        return true;
      },
      name,
    );
  }
});

test("a class that declares an empty systemPromptFile is refused rather than run without one", () => {
  const config = personaConfig();
  config.classes.rosalena.systemPromptFile = "   ";
  assert.throws(() => loadClassPersonas(config, { baseDir: TMP }), /declares systemPromptFile but it is empty/);
});

test("the entrypoint exits 2 and says why when the prompt file is gone", () => {
  // A copy of the real config with only the prompt path broken: everything else is
  // valid, so an exit here can only be the persona check - and it happens before the
  // port is bound, which is what makes it a startup failure rather than a 500 later.
  const config = realConfig();
  config.classes.rosalena.systemPromptFile = "definitely-not-here.md";
  const dir = mkdtempSync(join(TMP, "boot-"));
  const file = join(dir, "router.config.json");
  writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  const run = spawnSync(process.execPath, [join(ROUTER_DIR, "src", "index.mjs"), "--config", file], {
    encoding: "utf8",
    timeout: 20_000,
    cwd: ROUTER_DIR,
  });
  assert.equal(run.status, 2, `expected a refused start, got status ${run.status} (${run.stderr || run.stdout})`);
  assert.match(run.stderr, /cannot read its system prompt/);
  assert.match(run.stderr, /refuses to start/);
  assert.doesNotMatch(run.stdout, /listening on/, "it must not have opened a port");
});

test("a server that was never given the prompt refuses the class instead of answering as it", async () => {
  const config = realConfig();
  const fetchImpl = recorder(() => sse("should never be asked"));
  const server = createRouterServer({
    config,
    ledger: new Ledger(join(TMP, "ledger-refuse.json")),
    keyPool: new KeyPool({ OPENCODE_API_KEY: "k" }, config.providers, { keyFile: null }),
    logger: { log() {}, recent: () => [], file: () => null },
    usage: null,
    // The embedder mistake this gate exists for: a real config, prompt never loaded.
    personas: undefined,
    fetchImpl,
    env: {},
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "rosalena", messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await res.text();
  assert.equal(res.status, 500, "a refusal, not a silent answer");
  assert.match(text, /declares a system prompt but none is loaded/);
  assert.match(text, /rosalena/, "the refusal names the class a person asked for");
  assert.equal(fetchImpl.calls.length, 0, "nothing was sent upstream");
  assert.doesNotMatch(text, /Rosalena Harness app/, "the refusal does not quote the prompt");

  // Another class on the same server still answers: one broken identity must not take the
  // whole router down.
  const other = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(other.status, 200);
  assert.equal((await other.json()).choices[0].message.content, "should never be asked");
});

// -------------------------------------------------------------- the injection

test("the persona is prepended, and the client's own system message stays SECOND", async () => {
  const file = join(TMP, "inject.md");
  writeFileSync(file, "PERSONA-ALPHA\nsecond line\n", "utf8");
  const personas = loadClassPersonas(personaConfig({ file }), { baseDir: TMP });
  const fetchImpl = recorder();

  const clientBody = {
    model: "rosalena",
    messages: [
      { role: "system", content: "CLIENT-RULE: answer in one sentence." },
      { role: "user", content: "Who are you?" },
    ],
  };
  await routeFor({ config: personaConfig({ file }), personas, fetchImpl, cls: "rosalena", body: clientBody });

  const sent = fetchImpl.calls[0].body;
  assert.equal(sent.messages.length, 3, "nothing the client sent is dropped");
  assert.deepEqual(sent.messages[0], { role: "system", content: "PERSONA-ALPHA\nsecond line" });
  assert.deepEqual(sent.messages[1], { role: "system", content: "CLIENT-RULE: answer in one sentence." });
  assert.deepEqual(sent.messages[2], { role: "user", content: "Who are you?" });
  // The caller's object is not mutated: the same body is reused on a retry attempt.
  assert.equal(clientBody.messages.length, 2);
});

test("a client with no system message still gets exactly one, first", async () => {
  const file = join(TMP, "nosystem.md");
  writeFileSync(file, "PERSONA-BETA", "utf8");
  const config = personaConfig({ file });
  const personas = loadClassPersonas(config, { baseDir: TMP });
  const fetchImpl = recorder();
  await routeFor({ config, personas, fetchImpl, cls: "rosalena", body: { model: "rosalena", messages: [{ role: "user", content: "hi" }] } });
  assert.deepEqual(fetchImpl.calls[0].body.messages, [
    { role: "system", content: "PERSONA-BETA" },
    { role: "user", content: "hi" },
  ]);
});

test("the persona is per class: another class, and a pinned target, are left alone", async () => {
  const file = join(TMP, "perclass.md");
  writeFileSync(file, "PERSONA-GAMMA", "utf8");
  const config = personaConfig({ file });
  const personas = loadClassPersonas(config, { baseDir: TMP });
  const fetchImpl = recorder();
  const body = { model: "plain", messages: [{ role: "user", content: "hi" }] };

  await routeFor({ config, personas, fetchImpl, cls: "plain", body });
  await routeFor({ config, personas, fetchImpl, cls: null, pinned: { provider: "local", model: "any-model" }, body });

  assert.equal(fetchImpl.calls.length, 2);
  for (const call of fetchImpl.calls) {
    assert.equal(call.body.messages[0].role, "user", "no persona where the class did not declare one");
    assert.deepEqual(call.body.messages, [{ role: "user", content: "hi" }]);
  }
});

test("personaFor and withSystemPersona behave for Map, plain object and nothing", () => {
  assert.equal(personaFor(new Map([["a", { text: "T" }]]), "a"), "T");
  assert.equal(personaFor({ a: { text: "T" } }, "a"), "T");
  assert.equal(personaFor({ a: "T" }, "a"), "T", "a bare string is a prompt too");
  assert.equal(personaFor(new Map([["a", { text: "  " }]]), "a"), null, "blank is no persona");
  assert.equal(personaFor(null, "a"), null);
  assert.equal(personaFor(new Map(), null), null);

  const body = { messages: [{ role: "user", content: "u" }] };
  assert.equal(withSystemPersona(body, null), body, "no persona means the same object back");
  const withPersona = withSystemPersona(body, "P");
  assert.deepEqual(withPersona.messages, [{ role: "system", content: "P" }, { role: "user", content: "u" }]);
  assert.notEqual(withPersona, body);
  assert.equal(body.messages.length, 1, "the input object is untouched");
  // A body with no messages array at all is still a legal request.
  assert.deepEqual(withSystemPersona({}, "P").messages, [{ role: "system", content: "P" }]);
});

// ----------------------------------------------- upstream yes, everywhere else no

test("END TO END: upstream carries the prompt; the API response, the models list, the status and the log do not", async () => {
  const config = realConfig();
  const personas = loadClassPersonas(config);
  const prompt = personas.get("rosalena").text;
  const marker = sentinel(prompt);
  const fetchImpl = recorder(() => sse("Rosalena here."));
  const logDir = mkdtempSync(join(TMP, "logs-"));
  const logger = createLogger({ logDir, echo: false });
  const server = createRouterServer({
    config,
    ledger: new Ledger(join(TMP, "ledger.json")),
    keyPool: new KeyPool({ OPENCODE_API_KEY: "test-key" }, config.providers, { keyFile: null }),
    logger,
    usage: null,
    personas,
    fetchImpl,
    env: {}, // no router token: the HTTP surface is open for the test
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;

  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "rosalena", messages: [{ role: "user", content: "Who are you?" }] }),
  });
  const answerText = await chat.text();
  assert.equal(chat.status, 200, answerText);

  // 1) The request that LEFT the router is the one that carries the identity.
  assert.equal(fetchImpl.calls.length, 1, "one upstream attempt");
  const upstream = fetchImpl.calls[0].body;
  assert.equal(upstream.model, "deepseek-v4.1-flash-free", "the class resolves to the pinned free model");
  assert.equal(upstream.messages[0].role, "system");
  assert.equal(upstream.messages[0].content, prompt, "the WHOLE prompt, byte for byte");
  assert.deepEqual(upstream.messages.at(-1), { role: "user", content: "Who are you?" });
  assert.ok(!JSON.stringify(fetchImpl.calls[0].init.headers).includes(marker), "the prompt is in the body, not smeared into headers");

  // 2) The response body is the answer and nothing else.
  const answer = JSON.parse(answerText);
  assert.equal(answer.choices[0].message.content, "Rosalena here.");
  assert.ok(!answerText.includes(marker), "the prompt is not echoed in the completion");
  assert.ok(!answerText.includes("rosalena.md"), "not even the file path");
  assert.doesNotMatch(answerText, /systemPromptFile|system prompt/);

  // 3) The two discovery endpoints describe the class without quoting it.
  const modelsText = await (await fetch(`${base}/v1/models`)).text();
  const models = JSON.parse(modelsText);
  const row = models.data.find((m) => m.id === "rosalena");
  assert.ok(row, "the class is listed, so a picker can offer it");
  assert.deepEqual(row.chain, ["opencode-free/deepseek-v4.1-flash-free", "opencode-free/glm-5.3-flash-free", "omniroute/auto"]);
  assert.ok(!modelsText.includes(marker), "/v1/models must not quote the prompt");
  assert.ok(!modelsText.includes("rosalena.md"), "/v1/models must not even name the prompt file");

  const statusText = await (await fetch(`${base}/admin/status`)).text();
  const status = JSON.parse(statusText);
  // Each class is reported as { chain, custom } - a boolean flag, never the prompt path or text.
  assert.deepEqual(status.classes.rosalena.chain, ["opencode-free/deepseek-v4.1-flash-free", "opencode-free/glm-5.3-flash-free", "omniroute/auto"]);
  assert.equal(status.classes.rosalena.custom, true, "flagged custom so a model picker can list it");
  assert.ok(!statusText.includes(marker), "/admin/status must not quote the prompt");
  assert.ok(!statusText.includes("rosalena.md"), "/admin/status must not even name the prompt file");
  assert.ok(!JSON.stringify(status.warnings).includes("rosalena"), "no warning points at the class");

  // 4) Nothing on disk from the default logging carries it either.
  const files = readdirSync(logDir);
  assert.ok(files.length > 0, "the run wrote a log file, so the absence below is meaningful");
  const onDisk = files
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("\n");
  assert.ok(onDisk.length > 0, "the log file has content");
  assert.ok(!onDisk.includes(marker), "the prompt is not in any log line");
  assert.ok(!onDisk.includes("Rosalena Harness app"), "not even the distinctive phrase from it");
  assert.ok(!onDisk.includes("rosalena.md"), "the log names classes and targets, not prompt files");
});

test("a streamed caller also gets the persona upstream, and only the answer downstream", async () => {
  const config = realConfig();
  const personas = loadClassPersonas(config);
  const prompt = personas.get("rosalena").text;
  const marker = sentinel(prompt);
  const fetchImpl = recorder(() => sse("streamed answer"));
  const server = createRouterServer({
    config,
    ledger: new Ledger(join(TMP, "ledger-stream.json")),
    keyPool: new KeyPool({ OPENCODE_API_KEY: "test-key" }, config.providers, { keyFile: null }),
    logger: { log() {}, recent: () => [], file: () => null },
    usage: null,
    personas,
    fetchImpl,
    env: {},
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "rosalena", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const frames = await res.text();
  assert.equal(res.status, 200);
  assert.ok(frames.includes("streamed answer"), "the caller gets the streamed text");
  assert.ok(!frames.includes(marker), "no prompt text in the streamed frames");
  // OpenCode's free tier forces `stream: true` upstream; the persona still rides along.
  assert.equal(fetchImpl.calls[0].body.messages[0].content, prompt);
  assert.equal(fetchImpl.calls[0].body.stream, true);
});

// ------------------------------------------------------------------- helpers

/** route() with a fresh ledger and no breaker: only the body plumbing matters here. */
async function routeFor({ config, personas, fetchImpl, cls, pinned = null, body }) {
  const { route } = await import("../src/router.mjs");
  return route({
    config,
    ledger: new Ledger(join(TMP, `ledger-${Math.random().toString(36).slice(2)}.json`)),
    keyPool: new KeyPool({}, config.providers, { keyFile: null }),
    logger: { log() {}, recent: () => [], file: () => null },
    cls,
    pinned,
    body,
    personas,
    fetchImpl,
  });
}
