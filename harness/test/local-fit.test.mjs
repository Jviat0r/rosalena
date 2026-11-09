/**
 * How a local GGUF is fitted to the PC (src/local-fit.mjs): the biggest context that fits
 * the card whole, the q8_0 cache before a smaller context, part on the card and the rest
 * in RAM when nothing fits, and the refusals - a model too big for the card and the RAM,
 * hand-picked settings that would overfill the card, and "never offload".
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cleanPrefs, contextLadder, DEFAULT_PREFS, launchFlags, planLoad, readLocalPrefs, reserveBytesFor, writeLocalPrefs } from "../src/local-fit.mjs";

const GIB = 1024 ** 3;
// Llama 3.1 8B Q4_K_M: 4.92 GB of weights, 32 layers, 128 KiB of f16 KV per token.
const LLAMA = { model: { bytes: 4.92e9 }, shape: { layers: 32, trainContext: 131072, kvBytesPerToken: 131072 } };
const card = (freeGiB, totalGiB = 24) => ({ freeBytes: freeGiB * GIB, totalBytes: totalGiB * GIB });

test("the whole model on the card at the biggest context that fits, with the reserve kept", () => {
  const plan = planLoad({ ...LLAMA, gpu: card(23), ramFreeBytes: 32 * GIB });
  assert.equal(plan.ok, true);
  assert.equal(plan.verdict, "gpu");
  assert.equal(plan.gpuLayers, "all");
  assert.equal(plan.context, 32768, "auto stops at maxContext (32k by default)");
  assert.ok(plan.needGpuBytes <= plan.budgetBytes);
  assert.equal(plan.reserveBytes, reserveBytesFor(24 * GIB, DEFAULT_PREFS));
  assert.ok(plan.reserveBytes >= GIB);
});

test("a bigger config planContext raises the auto cap, and the trained context still limits it", () => {
  const plan = planLoad({ ...LLAMA, gpu: card(23.4), preferredContext: 262144 });
  assert.ok(plan.context <= 131072, "never past what the model was trained for");
  assert.equal(plan.context, 131072);
  // A cap the person picked on the Models page wins over the install's planContext.
  const capped = planLoad({ ...LLAMA, gpu: card(23.4), preferredContext: 262144, prefs: cleanPrefs({ maxContext: 16384 }) });
  assert.equal(capped.context, 16384);
});

test("a smaller card gets a smaller context, and q8_0 is tried before halving it", () => {
  const small = planLoad({ ...LLAMA, gpu: card(7.2, 8) });
  assert.equal(small.verdict, "gpu");
  assert.ok(small.context < 32768 && small.context >= 4096);
  // 8 GiB usable: 32k with an f16 cache needs 8.9 GiB, with q8_0 7.0 GiB - so 32k at q8_0, not 16k at f16.
  const tryQ8 = planLoad({ ...LLAMA, gpu: card(9, 10) });
  assert.equal(tryQ8.context, 32768);
  assert.equal(tryQ8.kvCache, "q8_0");
});

test("too big for the card: part of it from RAM, with the layers that fit", () => {
  const plan = planLoad({ model: { bytes: 16.5e9 }, shape: { layers: 64, trainContext: 262144, kvBytesPerToken: 69632 }, gpu: card(7.2, 8), ramFreeBytes: 32 * GIB });
  assert.equal(plan.verdict, "offload");
  assert.ok(plan.gpuLayers > 0 && plan.gpuLayers < 64);
  assert.ok(plan.needGpuBytes <= plan.budgetBytes);
  assert.match(plan.warnings.join(" "), /slower/);
});

test("too big for the card and the RAM together: refused, nothing to load", () => {
  const plan = planLoad({ model: { bytes: 40e9 }, shape: { layers: 80, kvBytesPerToken: 327680 }, gpu: card(7.2, 8), ramFreeBytes: 8 * GIB });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "too-big");
  assert.match(plan.why, /smaller model/);
});

test("'never offload' refuses a model that does not fit the card whole", () => {
  const prefs = cleanPrefs({ offload: "never" });
  const plan = planLoad({ model: { bytes: 16.5e9 }, shape: { layers: 64, kvBytesPerToken: 69632 }, gpu: card(7.2, 8), ramFreeBytes: 32 * GIB, prefs });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "too-big-for-gpu");
});

test("manual settings are honoured when they fit and refused with numbers when they do not", () => {
  const fits = planLoad({ ...LLAMA, gpu: card(23), settings: { mode: "manual", context: 8192, gpuLayers: "all", kvCache: "q8_0" } });
  assert.equal(fits.ok, true);
  assert.equal(fits.context, 8192);
  assert.equal(fits.kvCache, "q8_0");

  const over = planLoad({ ...LLAMA, gpu: card(7, 8), settings: { mode: "manual", context: 131072, gpuLayers: "all" } });
  assert.equal(over.ok, false);
  assert.equal(over.code, "over-vram");
  assert.match(over.why, /GiB/);

  const layers = planLoad({ ...LLAMA, gpu: card(3, 8), ramFreeBytes: 32 * GIB, settings: { mode: "manual", gpuLayers: 32, context: 8192 } });
  assert.equal(layers.ok, false, "32 layers by hand on a 3 GiB card is refused");
  assert.ok(layers.suggestion.gpuLayers < 32);

  const partial = planLoad({ ...LLAMA, gpu: card(3, 8), ramFreeBytes: 32 * GIB, settings: { mode: "manual", gpuLayers: 6, context: 8192 } });
  assert.equal(partial.ok, true);
  assert.equal(partial.gpuLayers, 6);
});

test("VRAM our own model frees on a swap counts toward the budget", () => {
  const without = planLoad({ ...LLAMA, gpu: card(2, 24) });
  const swap = planLoad({ ...LLAMA, gpu: card(2, 24), reclaimBytes: 18 * GIB });
  assert.notEqual(without.verdict, "gpu");
  assert.equal(swap.verdict, "gpu");
});

test("no card reading: load the way the install always has, and say no check was possible", () => {
  const plan = planLoad({ ...LLAMA, gpu: null, preferredContext: 16384 });
  assert.equal(plan.ok, true);
  assert.equal(plan.verdict, "unknown");
  assert.equal(plan.context, 16384);
  assert.equal(plan.gpuLayers, "all");
});

test("launch flags: the plan's cache type replaces the install's, and a quantised cache gets flash attention", () => {
  const flags = launchFlags({ kvCache: "q8_0" }, ["--jinja", "--cache-type-k", "f16", "-c", "4096", "--parallel", "1"]);
  assert.deepEqual(flags, ["--jinja", "--parallel", "1", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "-fa", "on"]);
  assert.deepEqual(launchFlags({ kvCache: "f16" }, ["-fa", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0"]), ["-fa", "on"]);
});

test("the context ladder runs from the cap down to 4k", () => {
  assert.deepEqual(contextLadder(32768), [32768, 16384, 8192, 4096]);
  assert.deepEqual(contextLadder(40000), [40000, 32768, 16384, 8192, 4096]);
});

test("settings are saved per person, and a model set back to auto is dropped", () => {
  const home = mkdtempSync(join(tmpdir(), "local-prefs-"));
  assert.deepEqual(readLocalPrefs(home), cleanPrefs({}));
  writeLocalPrefs(home, { idleUnloadMinutes: 30, models: { llama: { mode: "manual", context: 8192 } } });
  const saved = readLocalPrefs(home);
  assert.equal(saved.idleUnloadMinutes, 30);
  assert.equal(saved.models.llama.context, 8192);
  assert.equal(saved.models.llama.gpuLayers, "auto");
  writeLocalPrefs(home, { models: { llama: null } });
  assert.deepEqual(readLocalPrefs(home).models, {});
  assert.equal(cleanPrefs({ idleUnloadMinutes: -5, offload: "sometimes", reserveGiB: "x" }).idleUnloadMinutes, DEFAULT_PREFS.idleUnloadMinutes);
});
