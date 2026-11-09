/**
 * The site's fit arithmetic against the app's own answers.
 *
 * The byte values below were produced by running the desktop app's code, not by
 * running the port, so these tests fail if either side changes the formula. That
 * is the point: the page's advice and the app's advice have to be the same
 * advice, and a silent drift here would show up as a visitor told their card
 * holds a model it does not.
 *
 * Ground truth was taken with:
 *   cd 'D:\AppDev\Rosalena Harness\harness'
 *   node -e "import('./src/hardware.mjs').then(m=>console.log(JSON.stringify(m.estimateModelNeeds({...}))))"
 *
 * Run: cd 'D:\AppDev\Rosalena Harness\site' && node --test test\fit.test.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GB_DECIMAL,
  GIB,
  KV_BYTES_PER_ELEMENT,
  KV_FALLBACK_BYTES_PER_TOKEN_PER_BILLION,
  QUANT_BITS_PER_WEIGHT,
  RUNTIME_OVERHEAD_BYTES,
  VRAM_SOURCES,
  bitsPerWeightFor,
  estimateModelNeeds,
  fitScore,
  hardwareReading,
  llamaCommand,
  reasonFor,
  recommend,
} from "../public/check/fit.js";
import { GPU_TABLE, inferVramGb, lookupGpu, manualOptions, parseGpuName } from "../public/check/gpus.js";
import { projectCatalog } from "../tools/export-catalog.mjs";

const SITE_CATALOG = new URL("../public/check/catalog.json", import.meta.url);
const APP_CATALOG = new URL("../../harness/data/model-catalog.json", import.meta.url);

const siteCatalog = JSON.parse(readFileSync(SITE_CATALOG, "utf8"));

/** The six numbers the app returns, in the order the port returns them. */
function needsOf(spec) {
  const needs = estimateModelNeeds(spec);
  return {
    weights: needs.weightsBytes,
    kv: needs.kvCacheBytes,
    extra: needs.extraBytes,
    overhead: needs.overheadBytes,
    total: needs.totalBytes,
    bits: needs.bitsPerWeight,
  };
}

// ---------------------------------------------------------------------------
// 1. Constants: same units, same overhead, same KV fallback as the app
// ---------------------------------------------------------------------------

test("the unit and overhead constants are the app's", () => {
  assert.equal(GIB, 1073741824);
  assert.equal(GB_DECIMAL, 1e9);
  assert.equal(RUNTIME_OVERHEAD_BYTES, 536870912);
  assert.equal(KV_BYTES_PER_ELEMENT, 2);
  assert.equal(KV_FALLBACK_BYTES_PER_TOKEN_PER_BILLION, 8192);
  assert.equal(QUANT_BITS_PER_WEIGHT.Q4_K_M, 4.8);
  assert.equal(QUANT_BITS_PER_WEIGHT.Q8_0, 8.5);
});

// ---------------------------------------------------------------------------
// 2-8. Golden byte values from the real implementation
// ---------------------------------------------------------------------------

test("golden: Qwen3.8-27B UD-Q4_K_M at 16384 tokens (the GGUF on this machine)", () => {
  // harness/src/hardware.mjs, same arguments.
  assert.deepEqual(
    needsOf({ fileGb: 16.46, params: 27.78, quant: "UD-Q4_K_M", context: 16384, layers: 64, kvDim: 1024 }),
    {
      weights: 16460000000,
      kv: 4294967296,
      extra: 0,
      overhead: 536870912,
      total: 21291838208,
      bits: 4.8,
    },
  );
});

test("golden: Qwen3-32B Q4_K_M at 8192 tokens", () => {
  assert.deepEqual(needsOf({ fileGb: 19.76, params: 32.76, quant: "Q4_K_M", context: 8192, layers: 64, kvDim: 1024 }), {
    weights: 19760000000,
    kv: 2147483648,
    extra: 0,
    overhead: 536870912,
    total: 22444354560,
    bits: 4.8,
  });
});

test("golden: Qwen3-14B Q8_0 at 32768 tokens", () => {
  assert.deepEqual(needsOf({ fileGb: 15.7, params: 14.77, quant: "Q8_0", context: 32768, layers: 40, kvDim: 1024 }), {
    weights: 15700000000,
    kv: 5368709120,
    extra: 0,
    overhead: 536870912,
    total: 21605580032,
    bits: 8.5,
  });
});

test("golden: Qwen3-VL-8B Q8_0 plus its 0.75 GB projector", () => {
  assert.deepEqual(
    needsOf({ fileGb: 8.71, params: 8.77, quant: "Q8_0", context: 32768, layers: 36, kvDim: 1024, extraGb: 0.75 }),
    {
      weights: 8710000000,
      kv: 4831838208,
      extra: 750000000,
      overhead: 536870912,
      total: 14828709120,
      bits: 8.5,
    },
  );
});

test("golden: Llama-3.3-70B Q4_K_M at 8192 tokens", () => {
  assert.deepEqual(needsOf({ fileGb: 42.52, params: 70.55, quant: "Q4_K_M", context: 8192, layers: 80, kvDim: 1024 }), {
    weights: 42520000000,
    kv: 2684354560,
    extra: 0,
    overhead: 536870912,
    total: 45741225472,
    bits: 4.8,
  });
});

test("golden: weights from params when no file size is given", () => {
  const needs = estimateModelNeeds({ params: 8.19, quant: "Q4_K_M", context: 8192, layers: 36, kvDim: 1024 });
  assert.equal(needs.weightsBytes, 4914000000);
  assert.equal(needs.totalBytes, 6658830464);
  assert.equal(needs.basis.weights, "params");
  assert.equal(needs.basis.kv, "architecture");
});

test("golden: KV cache from the rule of thumb when layers are missing", () => {
  const needs = estimateModelNeeds({ fileGb: 18.56, params: 30.53, quant: "Q4_K_M", context: 16384 });
  assert.equal(needs.kvCacheBytes, 4097667236);
  assert.equal(needs.totalBytes, 23194538148);
  assert.equal(needs.basis.kv, "rule of thumb (8 KiB per billion params per token)");
});

// ---------------------------------------------------------------------------
// 9. Quant labels, including the publisher ones, and the refusal
// ---------------------------------------------------------------------------

test("quant labels resolve to the app's bits per weight and never guess", () => {
  assert.equal(bitsPerWeightFor("UD-Q4_K_M"), 4.8);
  assert.equal(bitsPerWeightFor("i1-Q5_K_S"), 5.5);
  assert.equal(bitsPerWeightFor("Q4_K_P"), 4.8);
  assert.equal(bitsPerWeightFor("q8_0"), 8.5);
  assert.equal(bitsPerWeightFor("F16"), 16);
  assert.equal(bitsPerWeightFor("Q9_Z"), null);
  assert.equal(bitsPerWeightFor(""), null);
  assert.equal(bitsPerWeightFor(null), null);

  // An unknown label is an error even when the file size is known, because the
  // app refuses it too and a page that quietly invented 4.8 would disagree.
  assert.throws(() => estimateModelNeeds({ fileGb: 5, quant: "Q9_Z", context: 8192 }), /unknown quant/);
  assert.throws(() => estimateModelNeeds({ fileGb: 5 }), /needs a context size/);
  assert.throws(() => estimateModelNeeds({ context: 8192 }), /needs fileGb/);
});

// ---------------------------------------------------------------------------
// 10-11. fitScore boundaries
// ---------------------------------------------------------------------------

const NEED = 22444354560; // the Qwen3-32B Q4_K_M golden, so the numbers are real
const CARD_24 = 24 * GIB;

test("fitScore: exactly at the limit is a fit, one byte either side is not", () => {
  const exact = fitScore({ needBytes: NEED, gpuFreeBytes: NEED, ramFreeBytes: CARD_24 });
  assert.equal(exact.verdict, "fits");
  assert.equal(exact.device, "gpu");
  assert.equal(exact.headroomBytes, 0);

  const under = fitScore({ needBytes: NEED, gpuFreeBytes: NEED + 1, ramFreeBytes: CARD_24 });
  assert.equal(under.verdict, "fits");
  assert.equal(under.headroomBytes, 1);

  const over = fitScore({ needBytes: NEED + 1, gpuFreeBytes: NEED, ramFreeBytes: CARD_24 });
  assert.equal(over.verdict, "tight");
  assert.equal(over.device, "ram");
  assert.equal(over.gpuHeadroomBytes, -1);
  assert.equal(over.headroomBytes, CARD_24 - (NEED + 1));

  // One byte past both limits is the honest "no".
  const past = fitScore({ needBytes: NEED + 1, gpuFreeBytes: NEED, ramFreeBytes: NEED });
  assert.equal(past.verdict, "tooBig");
  assert.equal(past.device, null);
  assert.equal(past.headroomBytes, null);
});

test("fitScore: RAM only, nothing measured, and a zero reading", () => {
  const ramOnly = fitScore({ needBytes: NEED, gpuFreeBytes: null, ramFreeBytes: CARD_24 });
  assert.equal(ramOnly.verdict, "tight");
  assert.equal(ramOnly.device, "ram");
  assert.equal(ramOnly.gpuHeadroomBytes, null);

  const nothing = fitScore({ needBytes: NEED });
  assert.equal(nothing.verdict, "unknown");
  assert.equal(nothing.device, null);
  assert.equal(nothing.headroomBytes, null);

  // 0 is a reading ("nothing is free"), not "unknown": the verdict must be no.
  const full = fitScore({ needBytes: NEED, gpuFreeBytes: 0, ramFreeBytes: 0 });
  assert.equal(full.verdict, "tooBig");

  assert.throws(() => fitScore({ needBytes: 0 }), /positive needBytes/);
  assert.throws(() => fitScore({ needBytes: Number.NaN, gpuFreeBytes: CARD_24 }), /positive needBytes/);
});

// ---------------------------------------------------------------------------
// 12-13. The ANGLE parser
// ---------------------------------------------------------------------------

test("the parser reads the three ANGLE strings browsers actually produce", () => {
  const nvidia = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Direct3D11 vs_5_0 ps_5_0, D3D11)";
  assert.equal(parseGpuName(nvidia), "NVIDIA GeForce RTX 3090");
  assert.equal(lookupGpu(nvidia)?.id, "rtx-3090");
  assert.equal(lookupGpu(nvidia)?.vramGb, 24);

  const amd = "ANGLE (AMD, AMD Radeon RX 6800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)";
  assert.equal(parseGpuName(amd), "AMD Radeon RX 6800 XT");
  assert.equal(lookupGpu(amd)?.id, "rx-6800-xt");
  assert.equal(lookupGpu(amd)?.vramGb, 16);

  const intel = "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)";
  assert.equal(parseGpuName(intel), "Intel UHD Graphics 630");
  assert.equal(lookupGpu(intel)?.id, "intel-igpu");
  assert.equal(lookupGpu(intel)?.vramGb, 0);
});

test("the parser handles a bare name and a laptop part, and returns null instead of throwing", () => {
  assert.equal(lookupGpu("GeForce RTX 3070")?.id, "rtx-3070");
  assert.equal(lookupGpu("NVIDIA GeForce RTX 3070")?.id, "rtx-3070");
  assert.equal(parseGpuName("NVIDIA GeForce RTX 4060 Laptop GPU"), "NVIDIA GeForce RTX 4060 Laptop GPU");
  assert.equal(lookupGpu("NVIDIA GeForce RTX 4060 Laptop GPU")?.id, "rtx-4060-laptop");
  assert.equal(lookupGpu("NVIDIA GeForce RTX 4060 Laptop GPU")?.vramGb, 8);

  // Nothing usable: every one of these must be null, not a throw and not a guess.
  assert.equal(parseGpuName(null), null);
  assert.equal(parseGpuName("   "), null);
  assert.equal(parseGpuName("Microsoft Basic Render Driver"), null);
  assert.equal(parseGpuName("llvmpipe (LLVM 15.0.7, 256 bits)"), null);
  assert.equal(lookupGpu(""), null);
  assert.equal(lookupGpu("Some Unknown Card 9000"), null);
  assert.equal(lookupGpu("ANGLE (NVIDIA, , D3D11)"), null);
  assert.equal(lookupGpu(undefined), null);

  // Inference is the tier-2 fallback and must be a number or null, never a throw.
  assert.equal(inferVramGb({ vendor: "nvidia", maxBufferSize: 2 * GIB }), 8);
  assert.equal(inferVramGb({ vendor: "amd", maxBufferSize: 4 * GIB }), 16);
  assert.equal(inferVramGb({ vendor: "intel", maxBufferSize: 512 * 1024 * 1024 }), 0);
  assert.equal(inferVramGb({ vendor: "nvidia", maxBufferSize: null }), null);
  assert.equal(inferVramGb({}), null);
});

// ---------------------------------------------------------------------------
// 14. The exported catalog against the app's
// ---------------------------------------------------------------------------

test("public/check/catalog.json is the app catalog, projected", (t) => {
  if (!existsSync(APP_CATALOG)) {
    t.skip(`no app catalog at ${APP_CATALOG.pathname}; nothing to compare, so the site tests on its own copy`);
    return;
  }
  const projected = projectCatalog(JSON.parse(readFileSync(APP_CATALOG, "utf8")));
  assert.deepEqual(
    siteCatalog,
    projected,
    "catalog.json has drifted from harness/data/model-catalog.json - run: node tools/export-catalog.mjs",
  );

  // The page needs these to render at all; a projection that dropped one would
  // otherwise only show up as a blank row in the browser.
  for (const model of siteCatalog.models) {
    assert.ok(model.id && model.name && model.params > 0, `${model.id}: missing identity`);
    assert.ok(Array.isArray(model.quants) && model.quants.length > 0, `${model.id}: no quants`);
    for (const quant of model.quants) {
      assert.ok(quant.quant && quant.file > 0, `${model.id}: a quant without a size`);
    }
  }
});

// ---------------------------------------------------------------------------
// 15. Manual picks are labelled manual, and nothing else
// ---------------------------------------------------------------------------

test("a manual VRAM figure produces a verdict and stays labelled manual", () => {
  const manual = hardwareReading({ name: "GeForce RTX 3090", vendor: "nvidia", vramGb: 24, vramSource: "manual", ramGb: 32 });
  assert.equal(manual.vramSource, "manual");
  assert.equal(manual.gpu.source, "manual");
  assert.notEqual(manual.vramSource, "detected");
  assert.equal(manual.gpu.vramTotalBytes, 24 * GIB);

  const result = recommend({ hardware: manual, catalog: siteCatalog });
  assert.ok(result.fits.length > 0, "a 24 GB card must hold something from this catalog");
  for (const row of [...result.fits, ...result.tight, ...result.tooBig, ...result.unknown]) {
    assert.equal(row.vramSource, "manual", `${row.entry.id}: a verdict must carry where its VRAM figure came from`);
  }

  // The same catalog at 8 GB must move models out of the comfortable group, which
  // is what proves the verdict follows the reading rather than the catalog.
  const small = hardwareReading({ name: "GeForce RTX 4060", vramGb: 8, vramSource: "manual", ramGb: 16 });
  const smallResult = recommend({ hardware: small, catalog: siteCatalog });
  assert.ok(smallResult.fits.length < result.fits.length);
  assert.ok(smallResult.tooBig.length > 0);

  // No provenance is an error: a reading without a source would have to be
  // presented as "detected", which is the one thing the page must not fake.
  assert.throws(() => hardwareReading({ vramGb: 24 }), /vramSource/);
  assert.throws(() => hardwareReading({ vramGb: 24, vramSource: "measured" }), /vramSource/);
  assert.deepEqual(VRAM_SOURCES, ["detected", "inferred", "manual"]);

  // The picker is the manual path's only input, so it must never ship empty.
  const groups = manualOptions();
  assert.ok(groups.length >= 3);
  assert.ok(groups.find((group) => group.label === "NVIDIA").options.some((option) => option.id === "rtx-3090"));
  assert.equal(
    groups.reduce((sum, group) => sum + group.options.length, 0),
    GPU_TABLE.filter((gpu) => gpu.vramGb > 0).length,
  );
});

// ---------------------------------------------------------------------------
// 16. The quant choice, which is the app's recommend()
// ---------------------------------------------------------------------------

test("the recommended quant is the largest that fits, and the smallest when none does", () => {
  const reading = hardwareReading({ name: "GeForce RTX 3090", vramGb: 24, vramSource: "detected", ramGb: 32 });
  const result = recommend({ hardware: reading, catalog: siteCatalog });
  const byId = new Map(result.rows.map((row) => [row.entry.id, row]));

  // 24 GiB holds Qwen3-8B at Q8_0 and not at Q6_K (Q8_0 is the top of its ladder).
  assert.equal(byId.get("qwen3-8b").quant, "Q8_0");
  assert.equal(byId.get("qwen3-8b").verdict, "fits");
  // A 4B model has no trouble, so it keeps its best quant.
  assert.equal(byId.get("qwen3-4b").quant, "Q8_0");
  // 32B on a 24 GiB card: Q5_K_M needs 23.21 GB of weights + 2 GiB of KV + 0.5 GiB
  // of overhead = 25.9 GB, just over the card, so it is a RAM-offload ("tight")
  // row and Q4_K_M is the honest fully-on-card pick.
  assert.equal(byId.get("qwen3-32b").quant, "Q4_K_M");
  assert.equal(byId.get("qwen3-32b").verdict, "fits");
  assert.equal(byId.get("qwen3-32b").quants.find((quant) => quant.quant === "Q5_K_M").verdict, "tight");
  // Nothing on the 70B ladder fits, so the row quotes its floor, not its best.
  const llama = byId.get("llama-3.3-70b");
  assert.equal(llama.quant, "Q4_K_M");
  assert.equal(llama.verdict, "tooBig");
  assert.equal(llama.smallest, true);

  // Every row carries a full ladder and a sentence, and the groups partition the
  // catalog so no model can vanish from the page.
  assert.equal(result.rows.length, siteCatalog.models.length);
  assert.equal(
    result.fits.length + result.tight.length + result.tooBig.length + result.unknown.length,
    result.rows.length,
  );
  for (const row of result.rows) {
    assert.equal(row.quants.length, row.entry.quants.length);
    assert.equal(typeof row.reason, "string");
    assert.ok(row.reason.length > 10);
  }

  // The reason names the figure it compared against.
  assert.match(reasonFor(result.fits[0], reading), /Fits your 24 GB card/);

  // The copy command uses -ngl (not -ngg) and the serve context the row used.
  const command = llamaCommand(byId.get("qwen3-32b"));
  assert.match(command, /^llama-server -m models\\Qwen3-32B-Q4_K_M\.gguf -c 8192 -ngl 99$/);
});

// ---------------------------------------------------------------------------
// The picker's data, so the manual fallback cannot ship empty
// ---------------------------------------------------------------------------
