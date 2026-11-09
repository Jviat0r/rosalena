/**
 * The catalog is data, so most of these tests are about what the data is
 * allowed to say: every entry has the fields `recommend` reads, ids are unique,
 * the five jobs that are worth running locally are covered, and a resolve URL
 * points at the file it is attached to.
 *
 * `recommend` is then checked twice. On a synthetic profile the answers are
 * hand-computed, so a change to the formula has to be a deliberate one. On the
 * real catalog with the real probe the assertion is structural - three buckets,
 * every entry in exactly one - because the measured numbers on a busy machine
 * are allowed to move, and a test that pins them would fail for having a model
 * loaded rather than for being wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GIB, probeHardware } from "../src/hardware.mjs";
import { guessParams, guessQuant, loadCatalog, recommend, scanLocalModels } from "../src/catalog.mjs";

const USES = ["code", "chat", "reasoning", "vision", "embedding"];
const MODEL_KEYS = ["name", "family", "params", "context", "serveContext", "layers", "kvDim", "license", "use", "notes"];

/** A probe result with only the fields `recommend` reads. */
const probe = (gpuFreeBytes, ramFreeBytes, gpuTotalBytes = 24 * GIB) => ({
  gpu: { vramFreeBytes: gpuFreeBytes, vramTotalBytes: gpuTotalBytes },
  ram: { freeBytes: ramFreeBytes },
});

const entry = (over) => ({
  id: "tiny",
  name: "Tiny",
  family: "Tiny",
  params: 10,
  context: 8192,
  serveContext: 8192,
  layers: 32,
  kvDim: 1024,
  license: "MIT",
  use: "chat",
  notes: "a synthetic entry, used only by the tests",
  quants: [{ quant: "Q4_K_M", file: 6, url: null }],
  ...over,
});

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

test("every entry carries the fields the table reads, and its urls point at its files", () => {
  const { models } = loadCatalog();
  assert.ok(models.length >= 8, `the catalog has ${models.length} entries`);
  const ids = new Set();
  for (const model of models) {
    assert.match(model.id, /^[a-z0-9.-]+$/, `${model.id} is a slug`);
    assert.ok(!ids.has(model.id), `${model.id} appears twice`);
    ids.add(model.id);
    for (const key of MODEL_KEYS) assert.ok(model[key], `${model.id} is missing ${key}`);
    assert.ok(Number.isFinite(model.params) && model.params > 0, `${model.id} params`);
    assert.ok(Number.isInteger(model.context) && model.context > 0, `${model.id} context`);
    // serveContext is what a 24 GB card is asked to allocate; it must be the same
    // or smaller than the trained context, never larger.
    assert.ok(Number.isInteger(model.serveContext) && model.serveContext > 0 && model.serveContext <= model.context, `${model.id} serveContext`);
    assert.ok(Number.isInteger(model.layers) && model.layers > 0, `${model.id} layers`);
    assert.ok(Number.isInteger(model.kvDim) && model.kvDim > 0, `${model.id} kvDim`);
    assert.ok(USES.includes(model.use), `${model.id} use is ${model.use}`);
    assert.ok(typeof model.notes === "string" && model.notes.length > 30, `${model.id} notes`);
    assert.ok(model.quants.length > 0, `${model.id} has no quants`);
    for (const quant of model.quants) {
      assert.ok(Number.isFinite(quant.file) && quant.file > 0, `${model.id} ${quant.quant} file`);
      assert.equal(typeof quant.quant, "string");
      if (quant.url === null) continue;
      // Resolve URLs are what a downloader needs; a page URL would 200 with HTML.
      assert.match(quant.url, /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/main\/.+\.gguf$/, `${model.id} ${quant.quant} url`);
      // A copy-paste that attaches the wrong file to a row is a silent 20 GB
      // mistake, so the quant in the URL has to be the quant in the row.
      assert.ok(quant.url.toLowerCase().includes(quant.quant.toLowerCase()), `${model.id} ${quant.quant} url names another quant`);
    }
  }
});

test("the catalog covers each job worth running locally, and includes entries that honestly do not fit", () => {
  const { models } = loadCatalog();
  const uses = new Set(models.map((model) => model.use));
  for (const use of USES) assert.ok(uses.has(use), `no ${use} model in the catalog`);
  // "Too big" is a real category for one 3090, not an omission: an entry whose
  // Q8 is 34 GB tells a reader where the ceiling is.
  const overTheCard = models.filter((model) => model.quants.some((quant) => quant.file > 24));
  assert.ok(overTheCard.length >= 2, `only ${overTheCard.length} entries are bigger than the card`);
});

// ---------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------

test("a 24 GB card with free RAM fits the 30B class and rejects the 70B", () => {
  const catalog = loadCatalog();
  const report = recommend({ hardware: probe(24 * GIB, 32 * GIB), catalog });
  const ids = (list) => list.map((row) => row.entry.id);
  assert.ok(report.fits.length > 0);
  for (const id of ["qwen3-30b-a3b", "qwen3-coder-30b-a3b", "qwen3.8-27b", "qwen3-32b"]) {
    assert.ok(ids(report.fits).includes(id), `${id} should fit 24 GB at its serveContext`);
  }
  assert.ok(ids(report.tooBig).includes("llama-3.3-70b"));
  // Every entry lands in exactly one bucket: a row that vanishes is a row the UI
  // cannot show and a user cannot ask about.
  const all = [...report.fits, ...report.tight, ...report.tooBig, ...report.unknown];
  assert.equal(all.length, catalog.models.length);
  assert.equal(new Set(all.map((row) => row.entry.id)).size, catalog.models.length);
});

test("a 4 GB card runs the big models on the CPU and still rejects the 70B", () => {
  const report = recommend({ hardware: probe(4 * GIB, 32 * GIB), catalog: loadCatalog() });
  assert.ok(report.tight.map((row) => row.entry.id).includes("qwen3-14b"));
  assert.ok(report.tooBig.map((row) => row.entry.id).includes("llama-3.3-70b"));
  for (const row of report.tight) {
    assert.equal(row.verdict, "tight");
    assert.equal(row.device, "ram");
    assert.ok(row.needBytes <= 32 * GIB);
  }
});

test("a row's numbers are the formula's numbers, and its reason says them", () => {
  const hardware = probe(10 * GIB, 16 * GIB);
  const [row] = recommend({ hardware, catalog: { models: [entry()] } }).fits;
  // 6 GB of weights + 2 * 32 * 8192 * 1024 * 2 of KV (= 1 GiB) + 0.5 GiB overhead
  assert.equal(row.needBytes, 6_000_000_000 + GIB + Math.round(0.5 * GIB));
  assert.equal(row.headroomBytes, 10 * GIB - row.needBytes);
  assert.equal(row.quant, "Q4_K_M");
  assert.equal(row.reason, "fits in 7.1 GiB of 10.0 GiB free VRAM at Q4_K_M, 2.9 GiB spare");
});

test("the chosen quant is the largest that fits, not the smallest", () => {
  const quants = [
    { quant: "Q4_K_M", file: 5, url: null },
    { quant: "Q8_0", file: 9, url: null },
    { quant: "F16", file: 17, url: null },
  ];
  const [row] = recommend({ hardware: probe(12 * GIB, 16 * GIB), catalog: { models: [entry({ quants })] } }).fits;
  // Q8_0 is 9 GB + 1 GiB KV + 0.5 GiB = 9.9 GiB, which fits 12; F16 is 17.3 and does not.
  assert.equal(row.quant, "Q8_0");
  assert.equal(row.needBytes, Math.round(9e9 + GIB + 0.5 * GIB));
  // The other quants are still reported, so a UI can show what the choice cost.
  assert.equal(row.quants.length, 3);
  assert.deepEqual(row.quants.map((q) => q.verdict), ["fits", "fits", "tooBig"]);
});

test("nothing fits: the reason quotes the smallest quant and the shortfall", () => {
  const [row] = recommend({ hardware: probe(4 * GIB, 4 * GIB), catalog: { models: [entry()] } }).tooBig;
  assert.equal(row.quant, "Q4_K_M");
  assert.match(row.reason, /^does not fit: even Q4_K_M needs 7\.1 GiB, 3\.1 GiB more than the 4\.0 GiB free VRAM, /);
  assert.match(row.reason, /more than the 4\.0 GiB free RAM$/);
  assert.equal(row.gpuHeadroomBytes, 4 * GIB - row.needBytes);
});

test("hardware with no measurable memory says unknown instead of inventing a verdict", () => {
  const hardware = { gpu: { vramFreeBytes: null, vramTotalBytes: null }, ram: { freeBytes: null } };
  const report = recommend({ hardware, catalog: loadCatalog() });
  assert.equal(report.fits.length, 0);
  assert.equal(report.tight.length, 0);
  assert.equal(report.tooBig.length, 0);
  assert.equal(report.unknown.length, loadCatalog().models.length);
  for (const row of report.unknown) assert.match(row.reason, /^cannot say/);
});

test("recommend refuses input it cannot work with", () => {
  assert.throws(() => recommend({ catalog: loadCatalog() }), TypeError);
  assert.throws(() => recommend({ hardware: probe(GIB, GIB) }), TypeError);
  assert.throws(() => recommend({ hardware: probe(GIB, GIB), catalog: { models: [entry({ context: 0, serveContext: 0 })] } }), /context/);
});

// ---------------------------------------------------------------------------
// The real machine, structurally
// ---------------------------------------------------------------------------

test("the real probe and the real catalog agree on a shape", () => {
  const hardware = probeHardware({ modelsDir: null });
  const catalog = loadCatalog();
  const report = recommend({ hardware, catalog });
  const all = [...report.fits, ...report.tight, ...report.tooBig, ...report.unknown];
  assert.equal(all.length, catalog.models.length);
  for (const row of all) {
    assert.ok(row.entry.id);
    // Weights alone are not the need: the KV cache and the runtime overhead are
    // what turn a 16 GB file into a 19.8 GiB requirement.
    assert.ok(row.needBytes > row.weightsBytes, `${row.entry.id}: need must include KV and overhead`);
    assert.ok(["fits", "tight", "tooBig", "unknown"].includes(row.verdict));
    assert.ok(row.reason.length > 24, `${row.entry.id}: a row without a reason is a number without a claim`);
    assert.equal(row.context, row.entry.serveContext);
  }
});

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------

test("scanning a models folder finds GGUFs, guesses what the name says, and ignores the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "rosalena-models-"));
  try {
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "Qwen3-8B-Q4_K_M.gguf"), "x".repeat(1024));
    writeFileSync(join(dir, "mmproj-F16.gguf"), "x".repeat(64));
    writeFileSync(join(dir, "mtp-Draft-7B-Q4_0.gguf"), "x".repeat(2048));
    writeFileSync(join(dir, "nested", "Model-7B-q8_0.gguf"), "x".repeat(4096));
    writeFileSync(join(dir, "notes.txt"), "not a model");
    writeFileSync(join(dir, "nested", "config.json"), "{}");

    const files = scanLocalModels(dir);
    assert.deepEqual(files.map((file) => file.file), ["Model-7B-q8_0.gguf", "mtp-Draft-7B-Q4_0.gguf", "Qwen3-8B-Q4_K_M.gguf", "mmproj-F16.gguf"]);
    assert.equal(files[0].bytes, 4096);
    assert.equal(files[0].dir, join(dir, "nested"));
    assert.equal(files[0].quant, "Q8_0"); // a lowercase q8_0 is still Q8_0
    assert.equal(files[0].params, 7);
    assert.equal(files[1].mtp, true);
    // A 2 GB drafter whose name says 7B: the parameter count is dropped rather
    // than printed next to a size that contradicts it.
    assert.equal(files[1].params, null);
    assert.equal(files[2].quant, "Q4_K_M");
    assert.equal(files[2].mtp, false);
    assert.equal(files[3].projector, true);
    // A projector is not a model either: it is flagged rather than guessed away.
    assert.equal(files[3].params, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a folder that does not exist scans to an empty list, not a throw", () => {
  assert.deepEqual(scanLocalModels(join(tmpdir(), `rosalena-missing-${process.pid}`)), []);
  assert.deepEqual(scanLocalModels(null), []);
  assert.deepEqual(scanLocalModels([]), []);
});

test("quant guessing survives the labels publishers actually use", () => {
  const cases = {
    "Qwen3-8B-Q4_K_M.gguf": "Q4_K_M",
    "Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated.i1-Q4_K_S.gguf": "Q4_K_S",
    "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf": "Q4_K_P",
    "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf": "IQ4_XS",
    "ltxv23_uncensored_v1.4_Q6_K.gguf": "Q6_K",
    "minimax_music3_dit_Q8_0.gguf": "Q8_0",
    "Qwen2.5-VL-7B-Instruct-q4_0.gguf": "Q4_0",
    "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf": "BF16",
    "mystery.gguf": null,
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(guessQuant(name), want, name);
});

test("parameter guessing reads 8B as parameters and 8bit as a bit width", () => {
  const cases = {
    "Qwen3-8B-Q4_K_M.gguf": 8,
    "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf": 27,
    "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf": 30,
    "gemma-3-12b-it-Q4_K_M.gguf": 12,
    "drama-3-backbone-8bit-experts-Q3_K_S.gguf": null, // 8bit is a bit width, not 8B
    "ltxv23_uncensored_v1.4_Q6_K.gguf": null,
    "mystery.gguf": null,
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(guessParams(name), want, name);
});
