// The local-model-switch plugin: which model is installed, which one is serving, and
// the exact command that would switch - with the two refusals that make it safe.
//
// Nothing here needs a GPU, a server or a model file. The server is a fetch stub that
// answers the four llama.cpp endpoints with the shapes the live server returned on
// this box; the card is a hardware fixture; the shelf is a file list. What is being
// tested is the arithmetic and the refusals, and both are pure functions of those.
//
// Two properties are asserted in almost every test, because they are the plugin's
// whole contract: every request is a GET, and nothing is ever started or stopped.

import test from "node:test";
import { detectModelDirs } from "../src/local-paths.mjs";
import assert from "node:assert/strict";

import {
  commandFor,
  configOf,
  createLocalSwitch,
  fileMatchesEntry,
  fitVerdict,
  formatCommand,
  gib,
  modelUnits,
  needsFor,
  norm,
  pickModel,
  probeServer,
  quoteArg,
} from "../plugins/rosa-local-model-switch/plugin.mjs";

const GIB = 1024 ** 3;

// ---------------------------------------------------------------------------
// Fixtures shaped like this machine
// ---------------------------------------------------------------------------

/** hardware.mjs's shape, trimmed to what the plugin reads. */
function hardware({ freeGiB = 0.9, totalGiB = 24, name = "NVIDIA GeForce RTX 3090", ramGiB = 32, vram = true } = {}) {
  return {
    gpu: vram ? { name, vramTotalBytes: Math.round(totalGiB * GIB), vramFreeBytes: Math.round(freeGiB * GIB) } : { name },
    ram: { freeBytes: Math.round(ramGiB * GIB) },
    notes: [],
  };
}

const file = (path, bytes, params, quant, extra = {}) => {
  const parts = path.split("\\");
  return {
    path,
    dir: parts.slice(0, -1).join("\\"),
    file: parts[parts.length - 1],
    bytes,
    gb: Number((bytes / 1e9).toFixed(2)),
    quant,
    params,
    projector: false,
    mtp: false,
    ...extra,
  };
};

// The catalog as the shipped data/model-catalog.json describes these models: the
// layer count and kvDim are what make the KV figure exact rather than a rule of thumb.
const CATALOG = {
  models: [
    {
      id: "qwen3.8-27b",
      name: "Qwen3.8 27B",
      params: 27,
      layers: 64,
      kvDim: 1024,
      serveContext: 16384,
      quants: [{ quant: "Q4_K_M", file: 16.5 }],
    },
    {
      id: "qwen3-32b",
      name: "Qwen3 32B",
      params: 32,
      layers: 64,
      kvDim: 1280,
      serveContext: 8192,
      quants: [{ quant: "Q4_K_M", file: 19.8, url: "https://huggingface.example/qwen3-32b" }],
    },
    {
      id: "tiny-1b",
      name: "Tiny 1B",
      params: 1.1,
      layers: 24,
      kvDim: 512,
      serveContext: 8192,
      quants: [{ quant: "Q8_0", file: 1.2 }],
    },
    {
      // Nothing this big fits a 24 GiB card at any catalogue size.
      id: "huge-70b",
      name: "Huge 70B",
      params: 70,
      layers: 80,
      kvDim: 1280,
      serveContext: 4096,
      quants: [{ quant: "Q4_K_M", file: 40 }],
    },
    {
      // Its Q4 does not fit; its Q2 does. The plan must pick the quant that fits.
      id: "bulk-70b",
      name: "Bulk 70B",
      params: 70,
      layers: 80,
      kvDim: 1280,
      serveContext: 4096,
      quants: [
        { quant: "Q4_K_M", file: 40 },
        { quant: "Q2_K", file: 22, url: "https://huggingface.example/bulk-70b-q2" },
      ],
    },
  ],
  counts: { models: 5 },
};

const RESIDENT_PATH = "D:\\Models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf";
const FILES = [
  file(RESIDENT_PATH, Math.round(16.5e9), 27, "Q4_K_M"),
  // A projector is not a model: it must never be offered, listed or planned.
  file("D:\\Models\\qwen3.8-27b\\mmproj-F16.gguf", 1_300_000_000, null, "F16", { projector: true }),
  // An MTP draft head, same rule.
  file("D:\\Models\\qwen3.8-27b\\mtp-Qwen3.8-27B.gguf", 1_900_000_000, null, "Q8_0", { mtp: true }),
  // A model the catalog does not know: only the file can describe it.
  file("D:\\Models\\ltxv23-uncensored\\ltxv23-uncensored-Q6_K.gguf", Math.round(5.6e9), 12, "Q6_K"),
  // No parameter count in the name: the KV cache cannot be estimated.
  file("D:\\Models\\mystery\\mystery-model.gguf", Math.round(3.2e9), null, null),
];

const PROPS = {
  default_generation_settings: { n_ctx: 131072, params: { n_predict: 4096 } },
  total_slots: 1,
  model_alias: "qwen3.8-27b",
  model_ftype: "Q4_K - Medium",
  model_path: "D:\\models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf",
};

const busySlot = (task = 248838) => ({
  id: 0,
  is_processing: true,
  id_task: task,
  n_prompt_tokens: 60464,
  next_token: [{ has_next_token: true, n_remain: 7485, n_decoded: 707 }],
});
const idleSlot = () => ({ id: 0, is_processing: false, id_task: 1, n_prompt_tokens: 1958, next_token: [{ has_next_token: false, n_remain: -1, n_decoded: 0 }] });

function respond(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

/**
 * A stub llama.cpp. Records every call, so a test can prove the conversation was
 * GET-only and stayed on the four documented endpoints.
 */
function fakeFetch({ health = 200, props = PROPS, models = { data: [{ id: "qwen3.8-27b" }] }, slots = [idleSlot()], dead = false } = {}) {
  const calls = [];
  // A loading server answers 503 on every endpoint, not only /health: nothing is
  // resident yet, so no model can be named.
  const busyLoading = health !== 200;
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", hasBody: init.body !== undefined });
    if (dead) throw new TypeError("fetch failed");
    const path = new URL(String(url)).pathname;
    if (path === "/health") return respond(health, health === 200 ? { status: "ok" } : { error: "loading" });
    if (busyLoading) return respond(503, { error: "loading" });
    if (path === "/props") return props === null ? respond(404, "not found") : respond(200, props);
    if (path === "/v1/models") return respond(200, models);
    if (path === "/slots") return slots === null ? respond(404, "not found") : respond(200, slots);
    return respond(404, "not found");
  };
  impl.calls = calls;
  return impl;
}

/** A plugin wired to fixtures: no GPU, no server, no disk scan. */
function build({ fetchImpl = fakeFetch(), hw = hardware(), files = FILES, catalog = CATALOG, config = {} } = {}) {
  return createLocalSwitch({
    fetchImpl,
    probe: () => hw,
    scan: () => files,
    catalog: typeof catalog === "function" ? catalog : () => catalog,
  }).commands({ root: "C:\\harness", config: { modelDirs: ["D:\\Models"], ...config }, harness: {}, builtinTools: {}, createTools: () => ({}), log: {} });
}

const args = (value) => [value];

// ---------------------------------------------------------------------------
// Small pure pieces
// ---------------------------------------------------------------------------

test("gib: GiB with one decimal, and ? for a number nobody measured", () => {
  assert.equal(gib(GIB), "1.0 GiB");
  assert.equal(gib(24 * GIB), "24.0 GiB");
  assert.equal(gib(Math.round(0.9 * GIB)), "0.9 GiB");
  assert.equal(gib(Math.round(19.9 * GIB)), "19.9 GiB");
  assert.equal(gib(0), "0.0 GiB");
  assert.equal(gib(null), "?");
  assert.equal(gib(Number.NaN), "?");
  assert.equal(gib(undefined), "?");
});

test("norm: lower case, letters and digits, so Qwen3.8-27B and qwen38 27b are the same key", () => {
  assert.equal(norm("Qwen3.8-27B"), "qwen3827b");
  assert.equal(norm("qwen3.8-27b"), norm("Qwen3.8-27B"));
  assert.equal(norm("UD-Q4_K_M.gguf"), "udq4kmgguf");
  assert.equal(norm(null), "");
});

test("quoteArg and formatCommand: a pasted command line, quoted only where Windows needs it", () => {
  assert.equal(quoteArg("127.0.0.1"), "127.0.0.1");
  assert.equal(quoteArg("D:\\Models\\a b\\x.gguf"), '"D:\\Models\\a b\\x.gguf"');
  assert.equal(quoteArg(""), '""');
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(
    formatCommand(["D:\\llama.cpp\\llama-server.exe", "-m", "D:\\Models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf"]),
    "D:\\llama.cpp\\llama-server.exe -m D:\\Models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf",
  );
});

test("configOf: defaults, and a baseUrl that decides the host and port of the command", () => {
  const plain = configOf({});
  assert.equal(plain.baseUrl, "http://127.0.0.1:8080");
  assert.equal(plain.host, "127.0.0.1");
  assert.equal(plain.port, 8080);
  assert.equal(plain.planContext, 16384);
  assert.equal(plain.timeoutMs, 1500);
  // No folder configured: whatever model folders this machine really has.
  assert.deepEqual(plain.dirs, detectModelDirs());
  assert.deepEqual(plain.extraFlags, []);

  const custom = configOf({
    baseUrl: "http://127.0.0.1:8188/",
    serverBinary: "C:\\llama\\llama-server.exe",
    modelDirs: ["E:\\Models", "", 42],
    planContext: 8192,
    timeoutMs: 5000,
    extraFlags: ["-fa", "on"],
  });
  assert.equal(custom.baseUrl, "http://127.0.0.1:8188", "a trailing slash is not part of the base");
  assert.equal(custom.port, 8188);
  assert.deepEqual(custom.dirs, ["E:\\Models"], "only real strings are model folders");
  assert.equal(custom.planContext, 8192);
  assert.deepEqual(custom.extraFlags, ["-fa", "on"]);

  // A nonsense baseUrl keeps the defaults instead of throwing: `list` still works.
  assert.equal(configOf({ baseUrl: "not a url" }).port, 8080);
  assert.equal(configOf({ planContext: -5 }).planContext, 16384);
  assert.equal(configOf({ timeoutMs: 1 }).timeoutMs, 1500);
});

// ---------------------------------------------------------------------------
// probeServer: GET only, and it never throws
// ---------------------------------------------------------------------------

test("probeServer: a busy server reports its model, its context and the slot that is generating", async () => {
  const fetchImpl = fakeFetch({ slots: [busySlot()] });
  const status = await probeServer({ baseUrl: "http://127.0.0.1:8080", fetchImpl });

  assert.equal(status.up, true);
  assert.equal(status.loading, false);
  assert.equal(status.model, "qwen3.8-27b");
  assert.equal(status.ftype, "Q4_K - Medium");
  assert.equal(status.ctx, 131072);
  assert.equal(status.totalSlots, 1);
  assert.equal(status.busy, true);
  assert.equal(status.busySlots.length, 1);
  assert.equal(status.busySlots[0].task, 248838);
  assert.equal(status.busySlots[0].decoded, 707);
  assert.equal(status.busySlots[0].remain, 7485);

  const paths = fetchImpl.calls.map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, ["/health", "/props", "/v1/models", "/slots"], "four endpoints, in that order");
  assert.ok(fetchImpl.calls.every((call) => call.method === "GET"), "every request is a GET");
  assert.ok(fetchImpl.calls.every((call) => !call.hasBody), "no request carries a body");
});

test("probeServer: 503 means loading, not down - the card is already held", async () => {
  const status = await probeServer({ fetchImpl: fakeFetch({ health: 503, props: null }) });
  assert.equal(status.up, false);
  assert.equal(status.loading, true);
  assert.equal(status.model, null);
});

test("probeServer: nothing on the port is an error, not a throw", async () => {
  const status = await probeServer({ fetchImpl: fakeFetch({ dead: true }) });
  assert.equal(status.up, false);
  assert.equal(status.loading, false);
  assert.match(status.error, /fetch failed/);
  assert.equal(status.busy, null, "a server that is not there has not said whether it is busy");
});

test("probeServer: /slots is a build option, so busy stays null rather than defaulting to idle", async () => {
  const status = await probeServer({ fetchImpl: fakeFetch({ slots: null }) });
  assert.equal(status.up, true);
  assert.equal(status.busy, null);
  assert.deepEqual(status.slots, []);
});

// ---------------------------------------------------------------------------
// Picking a model: no silent guesses
// ---------------------------------------------------------------------------

test("modelUnits: a projector and an MTP head are never models, whatever their folder", () => {
  const units = modelUnits({ catalog: CATALOG, files: FILES });
  const diskNames = units.filter((unit) => unit.kind === "disk").flatMap((unit) => unit.files.map((f) => f.file));
  assert.ok(!diskNames.some((name) => /mmproj|mtp/i.test(name)), `a draft or projector file was treated as a model: ${diskNames.join(", ")}`);
  assert.ok(diskNames.includes("ltxv23-uncensored-Q6_K.gguf"));
  assert.ok(diskNames.includes("mystery-model.gguf"));
  // The resident weights belong to the catalog entry, not to a unit of their own.
  const qwen = units.find((unit) => unit.entry?.id === "qwen3.8-27b");
  assert.equal(qwen.files.length, 1, "only the weights are claimed, not the mmproj or the mtp head");
  assert.equal(qwen.files[0].path, RESIDENT_PATH);
});

test("pickModel: catalog id, file name, folder and path all resolve; nothing resolves to a guess", () => {
  assert.equal(pickModel("qwen3.8-27b", { catalog: CATALOG, files: FILES }).unit.entry.id, "qwen3.8-27b");
  assert.equal(pickModel("Qwen3.8-27B-UD-Q4_K_M.gguf", { catalog: CATALOG, files: FILES }).kind, "catalog");
  assert.equal(pickModel("ltxv23-uncensored", { catalog: CATALOG, files: FILES }).kind, "disk");
  assert.equal(pickModel("  qwen3-32b  ", { catalog: CATALOG, files: FILES }).unit.entry.id, "qwen3-32b", "whitespace is trimmed");
  assert.equal(pickModel("", { catalog: CATALOG, files: FILES }).kind, "empty");

  const unknown = pickModel("qwen9-900b", { catalog: CATALOG, files: FILES });
  assert.equal(unknown.kind, "unknown");
  assert.ok(unknown.candidates.length > 0);
  assert.ok(unknown.candidates.some((candidate) => candidate.startsWith("qwen3.8-27b")), "the closest names are offered");
  assert.equal(unknown.unit, undefined, "an unknown name resolves to no unit at all");
});

test("pickModel: two models that fit the name equally well are ambiguous, not silently chosen", () => {
  const twins = {
    models: [
      { id: "llama-a", name: "Llama A", params: 7, layers: 32, kvDim: 512, quants: [{ quant: "Q4_K_M", file: 4 }] },
      { id: "llama-b", name: "Llama B", params: 7, layers: 32, kvDim: 512, quants: [{ quant: "Q4_K_M", file: 4 }] },
    ],
  };
  const picked = pickModel("llama", { catalog: twins, files: [] });
  assert.equal(picked.kind, "ambiguous");
  assert.equal(picked.candidates.length, 2);
  assert.ok(picked.candidates.some((candidate) => candidate.includes("llama-a")));
  assert.ok(picked.candidates.some((candidate) => candidate.includes("llama-b")));
});

test("fileMatchesEntry: the folder a model sits in counts, and a draft head never does", () => {
  const entry = CATALOG.models[0];
  assert.equal(fileMatchesEntry(file(RESIDENT_PATH, 1, 27, "Q4_K_M"), entry), true);
  assert.equal(fileMatchesEntry(file("D:\\Models\\other\\x.gguf", 1, 27, "Q4_K_M"), entry), false);
  assert.equal(fileMatchesEntry(file("D:\\Models\\qwen3.8-27b\\mmproj-F16.gguf", 1, null, "F16", { projector: true }), entry), false);
  assert.equal(fileMatchesEntry(file("D:\\Models\\qwen3.8-27b\\mtp-x.gguf", 1, null, "Q8_0", { mtp: true }), entry), false);
});

// ---------------------------------------------------------------------------
// The arithmetic and the four verdicts
// ---------------------------------------------------------------------------

test("needsFor: exact weights, architecture KV when the catalog knows the model, a floor when it does not", () => {
  const entry = CATALOG.models[0];
  const onDisk = needsFor({ entry, file: FILES[0], context: 16384 });
  assert.equal(onDisk.ok, true);
  assert.equal(onDisk.params, 27);
  assert.equal(onDisk.context, 16384);
  assert.equal(onDisk.kvExact, true);
  assert.equal(onDisk.weightsBytes, Math.round(16.5e9), "the disk's own size wins over the catalog's download size");
  // 2 (K and V) * 2 bytes (f16) * 64 layers * 1024 kvDim * 16384 tokens.
  assert.equal(onDisk.kvCacheBytes, 2 * 2 * 64 * 1024 * 16384);
  assert.ok(onDisk.needBytes > onDisk.weightsBytes, "the need includes the cache and the runtime");

  // Catalog only, no file: the catalog's quant size is the weights figure.
  const catalogOnly = needsFor({ entry: CATALOG.models[1], quant: CATALOG.models[1].quants[0], context: 8192 });
  assert.equal(catalogOnly.ok, true);
  assert.equal(catalogOnly.weightsBytes, Math.round(19.8e9));

  // Nothing known about it: no size at all is a refusal, not a zero.
  assert.equal(needsFor({ entry: null, file: null, quant: null, context: 8192 }).ok, false);
  assert.match(needsFor({ entry: null, file: null, quant: null, context: 8192 }).why, /no file size/);

  // A file with no parameter count cannot get an exact KV cache, and says so.
  const noParams = needsFor({ entry: null, file: FILES[4], context: 8192 });
  assert.equal(noParams.ok, true);
  assert.equal(noParams.params, null);
  assert.equal(noParams.kvExact, false, "the KV figure is the rule of thumb here");
  assert.equal(noParams.quant, null);
});

test("fitVerdict: fits now, fits when idle, will not fit, and unknown - never a merge of the last two", () => {
  const need = 20 * GIB;
  assert.equal(fitVerdict({ needBytes: need, gpuFreeBytes: 21 * GIB, gpuTotalBytes: 24 * GIB }).verdict, "fits now");
  assert.match(fitVerdict({ needBytes: need, gpuFreeBytes: 21 * GIB, gpuTotalBytes: 24 * GIB }).reason, /1\.0 GiB spare/);

  const idle = fitVerdict({ needBytes: need, gpuFreeBytes: 0.9 * GIB, gpuTotalBytes: 24 * GIB });
  assert.equal(idle.verdict, "fits when idle");
  assert.match(idle.reason, /does not fit the 0\.9 GiB that are free/);

  const no = fitVerdict({ needBytes: 30 * GIB, gpuFreeBytes: 0.9 * GIB, gpuTotalBytes: 24 * GIB });
  assert.equal(no.verdict, "will not fit");
  assert.match(no.reason, /6\.0 GiB too big for this GPU/);
  assert.doesNotMatch(no.reason, /RAM/, "no RAM figure was given, so none is claimed");

  const withRam = fitVerdict({ needBytes: 30 * GIB, gpuFreeBytes: 0, gpuTotalBytes: 24 * GIB, ramFreeBytes: 40 * GIB });
  assert.match(withRam.reason, /CPU offload/, "a model that fits RAM is mentioned as an alternative, never planned");

  const blind = fitVerdict({ needBytes: need, gpuFreeBytes: null, gpuTotalBytes: null });
  assert.equal(blind.verdict, "unknown");
  assert.match(blind.reason, /did not report its VRAM/);
  assert.match(blind.reason, /nvidia-smi/);

  assert.equal(fitVerdict({ needBytes: 0, gpuFreeBytes: GIB, gpuTotalBytes: GIB }).verdict, "unknown");
  assert.equal(fitVerdict({ needBytes: null, gpuFreeBytes: GIB, gpuTotalBytes: GIB }).verdict, "unknown");
});

test("commandFor: every layer, the server's own host and port, and the configured extra flags", () => {
  const config = configOf({ modelDirs: ["D:\\Models"], serverBinary: "D:\\llama.cpp\\llama-server.exe", extraFlags: ["-fa", "on", "--parallel", "1"] });
  assert.deepEqual(commandFor({ config, weightsPath: RESIDENT_PATH, context: 16384, layers: 64, alias: "qwen3.8-27b" }), [
    "D:\\llama.cpp\\llama-server.exe",
    "-m",
    RESIDENT_PATH,
    "-c",
    "16384",
    "-ngl",
    "64",
    "--alias",
    "qwen3.8-27b",
    "--host",
    "127.0.0.1",
    "--port",
    "8080",
    "-fa",
    "on",
    "--parallel",
    "1",
  ]);

  // No layer count known: 99 is llama.cpp's own "all layers" idiom, never a partial load.
  const bare = configOf({ modelDirs: ["D:\\Models"] });
  const blind = commandFor({ config: bare, weightsPath: RESIDENT_PATH, context: 4096 });
  assert.equal(blind[blind.indexOf("-ngl") + 1], "99");
  assert.equal(blind.includes("--alias"), false);
  assert.deepEqual(blind.slice(-4), ["--host", "127.0.0.1", "--port", "8080"]);
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("list: the card, the resident server, the shelf, and what the catalog has but the disk does not", async () => {
  const fetchImpl = fakeFetch({ slots: [busySlot()] });
  const out = await build({ fetchImpl }).list([]);

  assert.match(out, /^local models - NVIDIA GeForce RTX 3090, 24\.0 GiB VRAM, 0\.9 GiB free$/m);
  assert.match(out, /server\s+up at http:\/\/127\.0\.0\.1:8080 - serving qwen3\.8-27b/);
  assert.match(out, /context 131072 tokens per slot, 1 slot/);
  assert.match(out, /quant\s+Q4_K - Medium \(reported by the server\)/);
  assert.match(out, /busy\s+slot 0 is processing - task 248838, 707 tokens decoded, 7485 to go, 60464 prompt tokens/);
  assert.match(out, /weights\s+D:\\models\\qwen3\.8-27b/);

  assert.match(out, /installed - D:\\Models, 3 model file\(s\) of 5 \.gguf/);
  assert.match(out, /now\s+idle\s+need\s+size\s+quant\s+params\s+file/);
  // The resident 27B needs ~19.9 GiB: not the 0.9 GiB that are free, but inside the 24.
  assert.match(out, /no\s+yes\s+19\.9 GiB\s+15\.4 GiB\s+Q4_K_M\s+27B\s+qwen3\.8-27b\\Qwen3\.8-27B-UD-Q4_K_M\.gguf\s+<- resident/);
  assert.match(out, /catalog: 5 entries, 4 not installed \(qwen3-32b, tiny-1b, huge-70b, bulk-70b\)/);
  assert.match(out, /nothing here starts, stops or kills a server/);

  assert.ok(fetchImpl.calls.every((call) => call.method === "GET"));
});

test("list: a file with no parameter count gets a floor for a need, and the list says which number is a floor", async () => {
  const out = await build().list([]);
  assert.match(out, /3 file\(s\) name no parameter count|1 file\(s\) name no parameter count/);
  assert.match(out, /their KV cache cannot be estimated, so their need is the/);
  assert.match(out, /'now' answers 'does it fit the VRAM that is free this second'/);
});

test("list: no models installed, a dead server and an unreadable catalog are all reported, never thrown", async () => {
  const out = await build({
    files: [],
    fetchImpl: fakeFetch({ dead: true }),
    catalog: () => {
      throw new Error("data/model-catalog.json is missing");
    },
  }).list([]);
  assert.match(out, /server\s+not answering at http:\/\/127\.0\.0\.1:8080 \(fetch failed\)/);
  assert.match(out, /installed: no \.gguf files under D:\\Models/);
  assert.match(out, /catalog: not loaded \(data\/model-catalog\.json is missing\)/);
});

// ---------------------------------------------------------------------------
// now
// ---------------------------------------------------------------------------

test("now: the resident model, its own context, the busy slot, and the verdict for it", async () => {
  const out = await build({ fetchImpl: fakeFetch({ slots: [busySlot()] }) }).now([]);
  assert.match(out, /^local model server - now$/m);
  assert.match(out, /model\s+qwen3\.8-27b \(Q4_K - Medium\)/);
  assert.match(out, /context 131072 tokens per slot, 1 slot \(the server's own report\)/);
  assert.match(out, /busy\s+slot 0 is processing/);
  assert.match(out, /card\s+NVIDIA GeForce RTX 3090 - 0\.9 GiB free of 24\.0 GiB, 32\.0 GiB RAM free/);
  assert.match(out, /fits\s+fits when idle - 19\.9 GiB does not fit the 0\.9 GiB that are free/);
  // The catalog's serveContext (16384) is not the server's context (131072): say so.
  assert.match(out, /the 19\.9 GiB figure is for 16384 tokens/);
  assert.match(out, /the server runs 131072/);
  assert.match(out, /read-only: this plugin never starts, stops or restarts the server\./);
});

test("now: idle, loading, dead and /slots-blind each say something different", async () => {
  assert.match(await build({ fetchImpl: fakeFetch() }).now([]), /busy\s+no slot is processing a request/);
  assert.match(await build({ fetchImpl: fakeFetch({ health: 503, props: null }) }).now([]), /loading a model at http:\/\/127\.0\.0\.1:8080/);
  assert.match(
    await build({ fetchImpl: fakeFetch({ health: 503, props: null }) }).now([]),
    /note\s+a model is loading; its name is not available until \/props answers/,
  );
  assert.match(await build({ fetchImpl: fakeFetch({ dead: true }) }).now([]), /not answering at/);
  assert.match(await build({ fetchImpl: fakeFetch({ dead: true }) }).now([]), /note\s+nothing is resident/);

  const blind = await build({ fetchImpl: fakeFetch({ slots: null }) }).now([]);
  assert.match(blind, /busy\s+unknown - \/slots did not answer/);
});

test("now: a resident model the catalog does not know is reported as unjudged, not as fitting", async () => {
  const props = { ...PROPS, model_alias: "mystery-model", model_path: "D:\\Models\\mystery\\mystery-model.gguf" };
  const out = await build({ fetchImpl: fakeFetch({ props }) }).now([]);
  assert.match(out, /fits\s+not judged: "mystery-model" matched no catalog entry and no file on disk|fits\s+/);
});

// ---------------------------------------------------------------------------
// plan: the two refusals, and the command
// ---------------------------------------------------------------------------

test("plan: a switch to another model on a busy server prints the command AND refuses it, in that order", async () => {
  const out = await build({ fetchImpl: fakeFetch({ slots: [busySlot()] }) }).plan(args("ltxv23-uncensored"));

  const refused = out.indexOf("REFUSED - the server is busy processing a request.");
  const command = out.indexOf("command  (copy this; the plugin does not run it)");
  assert.ok(refused > 0, "the busy refusal is printed");
  assert.ok(command > 0, "the command is printed");
  assert.ok(refused < command, "the refusal comes before the command, so the command is not pasted while a slot generates");
  assert.match(out, /wait for the slot to go idle, then run the command below/);

  assert.match(out, /^local model switch plan - ltxv23-uncensored-Q6_K$/m);
  assert.match(out, /file\s+D:\\Models\\ltxv23-uncensored\\ltxv23-uncensored-Q6_K\.gguf, 5\.2 GiB on disk/);
  assert.match(out, /verdict\s+fits when idle/);
  assert.match(out, /-ngl 99/, "no catalog entry means llama.cpp's all-layers idiom");
  assert.match(out, /--host 127\.0\.0\.1 --port 8080/);
  assert.match(out, /nothing was started, stopped or killed/);
});

test("plan: the resident model needs no switch, and gets no command", async () => {
  const out = await build({ fetchImpl: fakeFetch() }).plan(args("qwen3.8-27b"));
  assert.match(out, /no switch needed: qwen3\.8-27b is already the resident model\./);
  assert.match(out, /Stopping and restarting it to switch to itself would only throw the loaded weights away\./);
  assert.doesNotMatch(out, /llama-server\.exe/, "no command is printed for a model that is already resident");
});

test("plan: a model that does not fit gets no command at all, and says the smallest quant is no better", async () => {
  const out = await build().plan(args("huge-70b"));
  assert.match(out, /verdict\s+will not fit/);
  assert.match(out, /REFUSED - no command is printed for a model that does not fit the card\./);
  assert.match(out, /A partial-offload `-ngl` would make it run at a few tokens per second/);
  assert.match(out, /the smallest quant in the catalog is Q4_K_M at [\d.]+ GiB - also bigger than this card/);
  assert.doesNotMatch(out, /llama-server\.exe/, "a model that does not fit is never given a command");
});

test("plan: when the catalog has a quant that fits, that quant is the plan", async () => {
  const out = await build().plan(args("bulk-70b"));
  // Q4 would not fit the card; Q2 does, so Q2 is what the plan describes.
  assert.match(out, /file\s+Q2_K is in the catalog but not on disk/);
  assert.match(out, /verdict\s+fits when idle/);
  assert.doesNotMatch(out, /the smallest quant in the catalog/);
});

test("plan: a model the catalog knows but the disk does not gets its quant and URL, and no command", async () => {
  const out = await build().plan(args("qwen3-32b"));
  assert.match(out, /file\s+Q4_K_M is in the catalog but not on disk/);
  assert.match(out, /url\s+https:\/\/huggingface\.example\/qwen3-32b/);
  assert.match(out, /no command yet: the weights for this plan are not on disk/);
  assert.doesNotMatch(out, /llama-server\.exe/);
});

test("plan: with no VRAM figure it refuses the whole plan rather than guessing a fit", async () => {
  const out = await build({ hw: hardware({ vram: false }) }).plan(args("ltxv23-uncensored"));
  assert.match(out, /REFUSED - this machine did not report its VRAM\./);
  assert.match(out, /The adapter is named "NVIDIA GeForce RTX 3090", but no VRAM figure came with it\./);
  assert.match(out, /Without a VRAM number a fit verdict is a guess/);
  assert.doesNotMatch(out, /llama-server\.exe/);
});

test("plan: no GPU at all is also a refusal, with its own sentence", async () => {
  const hw = { gpu: { name: null }, ram: null, notes: [] };
  const out = await build({ hw }).plan(args("ltxv23-uncensored"));
  assert.match(out, /No GPU was visible at all\./);
  assert.doesNotMatch(out, /llama-server\.exe/);
});

test("plan: an unknown name is not guessed and does not produce a command", async () => {
  const out = await build().plan(args("qwen9-900b"));
  assert.match(out, /no model matches "qwen9-900b"/);
  assert.match(out, /closest names:/);
  assert.match(out, /nothing was guessed: a plan for the wrong model is worse than no plan\./);
  assert.doesNotMatch(out, /llama-server\.exe/);
});

test("plan: an ambiguous name lists the candidates instead of choosing one", async () => {
  const twins = {
    models: [
      { id: "llama-a", name: "Llama A", params: 7, layers: 32, kvDim: 512, quants: [{ quant: "Q4_K_M", file: 4 }] },
      { id: "llama-b", name: "Llama B", params: 7, layers: 32, kvDim: 512, quants: [{ quant: "Q4_K_M", file: 4 }] },
    ],
  };
  const out = await build({ catalog: twins, files: [] }).plan(args("llama"));
  assert.match(out, /matches more than one model/);
  assert.match(out, /type more of the name \(the folder or the file\) so the choice is unambiguous\./);
  assert.doesNotMatch(out, /llama-server\.exe/);
});

test("plan: no argument prints usage and the shelf, and starts nothing", async () => {
  const out = await build().plan([]);
  assert.match(out, /usage: rosa-local-model-switch:plan <model> \[context\]/);
  assert.match(out, /installed: 3 model file\(s\)/);
  assert.doesNotMatch(out, /llama-server\.exe/);
});

test("plan: the requested context overrides the catalog's, in the arithmetic and in the command", async () => {
  const out = await build().plan(["ltxv23-uncensored", "8192"]);
  assert.match(out, /needs\s+[\d.]+ GiB resident at 8192 tokens/);
  assert.match(out, /-c 8192/);
  assert.doesNotMatch(out, /-c 16384/);
});

test("plan: a file with no parameters is planned against the floor, and labelled as one", async () => {
  const out = await build().plan(args("mystery-model"));
  assert.match(out, /needs\s+3\.5 GiB resident at 16384 tokens - 3\.0 GiB weights \+ 0\.5 GiB runtime/);
  assert.match(out, /floor\s+no KV cache is in that figure/);
  assert.match(out, /the need is the weights plus the runtime - a lower bound, not a fit\./);
  assert.match(out, /params\s+unknown: the file name carries no parameter count/);
  assert.match(out, /no KV cache is in that figure at all: the need is a floor, not a fit/);
});

test("plan: a free port is stated as free, and an occupied one as needing the other model stopped", async () => {
  const free = await build({ fetchImpl: fakeFetch({ dead: true }) }).plan(args("ltxv23-uncensored"));
  assert.match(free, /The port is free, so this command can be run as-is:/);
  assert.doesNotMatch(free, /whatever holds the GPU now has/);

  const taken = await build({ fetchImpl: fakeFetch() }).plan(args("ltxv23-uncensored"));
  assert.match(taken, /One card, one resident model: whatever holds the GPU now has/);
  assert.match(taken, /to finish and be stopped by whoever owns it before this command can take effect\./);
});

test("plan: the extra flags are explained, and a model-specific flag is not invented", async () => {
  const out = await build({ config: { serverBinary: "D:\\llama.cpp\\llama-server.exe", extraFlags: ["-fa", "on", "--parallel", "1", "--jinja"] } }).plan(args("ltxv23-uncensored"));
  assert.match(out, /-fa on --parallel 1 --jinja/);
  assert.match(out, /the flags after --port are plugins\.local-model-switch\.config\.extraFlags/);
  assert.match(out, /a model-specific flag \(--spec-type draft-mtp\) is not added/);
  const command = out.split("\n").find((line) => line.includes("llama-server.exe"));
  assert.ok(command, "the command is printed");
  assert.doesNotMatch(command, /--spec-type/, "the explanation mentions it; the command must not add it");
  assert.doesNotMatch(command, /--cache-type-k|--temp|--top-p/, "no sampling or cache flag is invented");
});

// ---------------------------------------------------------------------------
// The tool, and the status line that must not touch anything
// ---------------------------------------------------------------------------

test("the tool plans like the command does, and its refusals are single sentences", async () => {
  let probed = 0;
  let scanned = 0;
  const plugin = createLocalSwitch({
    fetchImpl: fakeFetch(),
    probe: () => {
      probed += 1;
      return hardware();
    },
    scan: () => {
      scanned += 1;
      return FILES;
    },
    catalog: () => CATALOG,
  });
  const ctx = { root: "C:\\harness", config: { modelDirs: ["D:\\Models"] }, harness: {}, builtinTools: {}, createTools: () => ({}), log: {} };
  const tools = plugin.tools(ctx);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "local_model_switch_plan");
  assert.deepEqual(tools[0].parameters.required, ["model"]);

  const planned = await tools[0].run({ model: "ltxv23-uncensored" });
  assert.match(planned, /local model switch plan - ltxv23-uncensored/);
  assert.match(planned, /command  \(copy this; the plugin does not run it\)/);
  assert.equal(probed, 1);
  assert.equal(scanned, 1);

  const unknown = await tools[0].run({ model: "qwen9-900b" });
  assert.match(unknown, /^no local model matches "qwen9-900b"\. Closest: /);
  assert.match(unknown, /Nothing was guessed and nothing was started\./);
  assert.doesNotMatch(unknown, /\n/, "a tool refusal is one line, not a page");

  const ambiguous = await tools[0].run({ model: "" });
  assert.match(ambiguous, /^no model was named\./);
  assert.match(ambiguous, /Nothing was guessed and nothing was started\./);
});

test("status: static, so listing the plugins never probes the card, scans the disk or calls the server", () => {
  let touched = 0;
  const plugin = createLocalSwitch({
    fetchImpl: () => {
      touched += 1;
      throw new Error("the status line must not call the server");
    },
    probe: () => {
      touched += 1;
      throw new Error("the status line must not probe the card");
    },
    scan: () => {
      touched += 1;
      throw new Error("the status line must not scan the disk");
    },
    catalog: () => {
      touched += 1;
      throw new Error("the status line must not read the catalog");
    },
  });
  const status = plugin.status({ root: "C:\\harness", config: { baseUrl: "http://127.0.0.1:8188", modelDirs: ["D:\\Models", "E:\\More"] } });
  assert.equal(touched, 0, "status did I/O: it has to be a constant string");
  assert.equal(status, "plans a llama-server switch on 127.0.0.1:8188 from D:\\Models, E:\\More - never starts or stops one");
});

test("the plugin's id and description say what it does, and that it is read-only", () => {
  const plugin = createLocalSwitch();
  assert.equal(plugin.id, "rosa-local-model-switch");
  assert.match(plugin.description, /which one llama.cpp is serving/);
  assert.match(plugin.description, /read-only/);
  assert.deepEqual(Object.keys(plugin.commands({ config: {} })).sort(), ["list", "now", "plan"]);
});
