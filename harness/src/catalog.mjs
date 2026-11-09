/**
 * The model catalog, and what fits.
 *
 * Two read-only surfaces:
 *
 *   - `recommend({ hardware, catalog })` pairs every catalog entry with a
 *     hardware probe and sorts it into `fits` / `tight` / `tooBig`, each row
 *     carrying the arithmetic and one sentence a person can check.
 *   - `scanLocalModels(dir)` lists the `*.gguf` files already on disk, with a
 *     quant and a parameter count guessed from the file name, so "already
 *     downloaded" can be shown apart from "available in the catalog".
 *
 * The catalog is data (`data/model-catalog.json`). Nothing in this module
 * knows a model's name: adding one is an edit to the JSON.
 *
 * Units: the catalog stores Hugging Face's decimal gigabytes; comparisons and
 * display happen in bytes / GiB via `./hardware.mjs`. A row's reason is in GiB
 * because VRAM is reported in MiB and a unit that changes mid-sentence is a lie
 * with extra steps.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GB_DECIMAL, GIB, estimateModelNeeds, fitScore } from "./hardware.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = resolve(HERE, "..", "data", "model-catalog.json");

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Read the catalog and refuse one that cannot be fitted: a row without `id`,
 * `params` or `quants` would fail later, deep inside the table, with a message
 * that points at the wrong place.
 */
export function loadCatalog(path = CATALOG_PATH) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const models = doc?.models;
  if (!Array.isArray(models) || models.length === 0) throw new Error(`${path}: no "models" array`);
  for (const entry of models) {
    if (!entry?.id) throw new Error(`${path}: an entry has no id`);
    if (!Array.isArray(entry.quants) || entry.quants.length === 0) throw new Error(`${path}: ${entry.id} has no quants`);
    if (!(Number(entry.params) > 0)) throw new Error(`${path}: ${entry.id} has no params`);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

const gi = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * The one sentence a row carries. It names the quant it is about, the free
 * figure it was measured against, and - when the answer is no - the gap in
 * GiB rather than the word "insufficient".
 */
function reasonFor({ verdict, device, label, needBytes, gpuFreeBytes, ramFreeBytes, gpuHeadroomBytes, ramHeadroomBytes, smallest }) {
  if (verdict === "fits") {
    return `fits in ${gi(needBytes)} of ${gi(gpuFreeBytes)} free VRAM at ${label}, ${gi(gpuHeadroomBytes)} spare`;
  }
  if (verdict === "tight" && device === "ram") {
    return (
      `does not fit ${gi(needBytes)} in ${gi(gpuFreeBytes)} of free VRAM; at ${label} it fits the ` +
      `${gi(ramFreeBytes)} of free RAM - CPU/partial offload, expect a few tokens per second`
    );
  }
  if (verdict === "tight") {
    return `no free-VRAM figure; ${gi(needBytes)} at ${label} fits the ${gi(ramFreeBytes)} of free RAM - CPU only`;
  }
  if (verdict === "tooBig") {
    const parts = [`${smallest ? "even " : ""}${label} needs ${gi(needBytes)}`];
    if (gpuHeadroomBytes !== null) parts.push(`${gi(-gpuHeadroomBytes)} more than the ${gi(gpuFreeBytes)} free VRAM`);
    if (ramHeadroomBytes !== null) parts.push(`${gi(-ramHeadroomBytes)} more than the ${gi(ramFreeBytes)} free RAM`);
    return `does not fit: ${parts.join(", ")}`;
  }
  return "cannot say: neither free VRAM nor free RAM could be measured";
}

/**
 * Fit every catalog entry against this machine.
 *
 * The verdict follows free memory, not total memory: "fits" means it fits
 * *now*, which is the question that keeps a second model from being loaded onto
 * a card that already holds one. Rows also carry an `idleVerdict` measured
 * against the card's total VRAM, because a busy card is a temporary fact and a
 * table that only says "no" would be useless five minutes later.
 *
 * The chosen quant is the largest one that fits (best quality that loads); if
 * none fits, the largest that runs with CPU offload; if nothing runs, the
 * smallest one, so the "does not fit" reason quotes a floor rather than a
 * quant nobody asked for.
 *
 * @param {{ hardware: object, catalog: object }} input
 * @returns {{ fits: object[], tight: object[], tooBig: object[], unknown: object[] }}
 */
export function recommend({ hardware, catalog } = {}) {
  if (!hardware?.gpu && !hardware?.ram) throw new TypeError("recommend needs a probeHardware() result");
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  if (!Array.isArray(models)) throw new TypeError("recommend needs a catalog ({ models: [...] })");

  const gpuFree = hardware.gpu?.vramFreeBytes ?? null;
  const gpuTotal = hardware.gpu?.vramTotalBytes ?? null;
  const ramFree = hardware.ram?.freeBytes ?? null;

  const rows = models.map((entry) => {
    const context = Number(entry.serveContext ?? entry.context);
    if (!(context > 0)) throw new Error(`${entry.id}: no usable context (serveContext or context)`);

    const quants = entry.quants.map((quant) => {
      const needs = estimateModelNeeds({
        fileGb: quant.file,
        params: entry.params,
        quant: quant.quant,
        context,
        layers: entry.layers,
        kvDim: entry.kvDim,
        extraGb: entry.extraGb,
      });
      const now = fitScore({ needBytes: needs.totalBytes, gpuFreeBytes: gpuFree, ramFreeBytes: ramFree });
      const idle = fitScore({ needBytes: needs.totalBytes, gpuFreeBytes: gpuTotal, ramFreeBytes: ramFree });
      return {
        quant: quant.quant,
        file: quant.file,
        url: quant.url ?? null,
        needBytes: needs.totalBytes,
        weightsBytes: needs.weightsBytes,
        kvCacheBytes: needs.kvCacheBytes,
        context: needs.context,
        verdict: now.verdict,
        headroomBytes: now.headroomBytes,
        idleVerdict: idle.verdict,
        idleHeadroomBytes: idle.headroomBytes,
      };
    });

    const bySize = [...quants].sort((a, b) => a.needBytes - b.needBytes);
    const chosen =
      [...quants].filter((q) => q.verdict === "fits").sort((a, b) => b.needBytes - a.needBytes)[0] ??
      [...quants].filter((q) => q.verdict === "tight").sort((a, b) => b.needBytes - a.needBytes)[0] ??
      bySize[0];

    const now = fitScore({ needBytes: chosen.needBytes, gpuFreeBytes: gpuFree, ramFreeBytes: ramFree });
    const idle = fitScore({ needBytes: chosen.needBytes, gpuFreeBytes: gpuTotal, ramFreeBytes: ramFree });
    const smallest = bySize.length === 0 || chosen.needBytes === bySize[0].needBytes;

    return {
      entry,
      quant: chosen.quant,
      quantSpec: { quant: chosen.quant, file: chosen.file, url: chosen.url },
      needBytes: chosen.needBytes,
      weightsBytes: chosen.weightsBytes,
      kvCacheBytes: chosen.kvCacheBytes,
      context: chosen.context,
      verdict: now.verdict,
      device: now.device,
      headroomBytes: now.headroomBytes,
      gpuHeadroomBytes: now.gpuHeadroomBytes,
      ramHeadroomBytes: now.ramHeadroomBytes,
      idleVerdict: idle.verdict,
      // Against the card's whole VRAM, so a row that cannot fit even an empty
      // card shows a real negative number instead of "unknown".
      idleGpuHeadroomBytes: idle.gpuHeadroomBytes,
      reason: reasonFor({
        verdict: now.verdict,
        device: now.device,
        label: chosen.quant,
        needBytes: chosen.needBytes,
        gpuFreeBytes: gpuFree,
        ramFreeBytes: ramFree,
        gpuHeadroomBytes: now.gpuHeadroomBytes,
        ramHeadroomBytes: now.ramHeadroomBytes,
        smallest,
      }),
      quants,
    };
  });

  return {
    fits: rows.filter((r) => r.verdict === "fits").sort((a, b) => b.needBytes - a.needBytes),
    tight: rows.filter((r) => r.verdict === "tight").sort((a, b) => a.needBytes - b.needBytes),
    tooBig: rows.filter((r) => r.verdict === "tooBig").sort((a, b) => a.needBytes - b.needBytes),
    // Only non-empty when the probe could measure neither VRAM nor RAM. Kept
    // apart from `tooBig` because "does not fit" and "nobody looked" are
    // different answers, and a row must never disappear from the table.
    unknown: rows.filter((r) => r.verdict === "unknown").sort((a, b) => a.needBytes - b.needBytes),
  };
}

// ---------------------------------------------------------------------------
// What is already on disk
// ---------------------------------------------------------------------------

// A quant label sits between separators: "-", "_", "." or the start of the name.
// A `\b` is not enough here, because "_" is a word character, so "v1.4_Q6_K"
// would have no boundary before the Q and the label would be missed. Order
// matters too: the k-quant shapes must be tried before the bare `Q4_0` one, or
// "Q4_K_M" would be read as the nonexistent quant "Q4_K".
const QUANT_PATTERNS = [
  /(?:^|[^A-Z0-9])(IQ\d_[A-Z0-9]+)(?![A-Z0-9])/i,
  /(?:^|[^A-Z0-9])(Q\d_K_[A-Z]+)(?![A-Z0-9])/i,
  /(?:^|[^A-Z0-9])(Q\d_K)(?![A-Z0-9])/i,
  /(?:^|[^A-Z0-9])(Q\d_\d)(?![A-Z0-9])/i,
  /(?:^|[^A-Z0-9])(BF16|F16|FP16)(?![A-Z0-9])/i,
];

/**
 * The quant a file name claims, upper-cased, or null. A guess about a string,
 * which is all a file name is: `probeHardware` never reads it, and nothing in
 * `recommend` depends on it.
 */
export function guessQuant(filename) {
  const name = String(filename ?? "");
  for (const pattern of QUANT_PATTERNS) {
    const match = name.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

// "8bit" must not read as 8B, and neither must "v1.4": a B has to be a whole
// token, surrounded by something that is not a letter or digit.
const PARAM_PATTERN = /(?:^|[^0-9A-Za-z.])(\d+(?:\.\d+)?)B(?![0-9A-Za-z])/i;

/** The parameter count a file name claims, in billions, or null. */
export function guessParams(filename) {
  const match = String(filename ?? "").match(PARAM_PATTERN);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Every `.gguf` under `dir`, at most `maxDepth` folders down, largest first.
 *
 * Models land either loose in the models folder or one folder per model (which
 * is how a Hugging Face download arranges them), so the walk is bounded rather
 * than shallow: one level would miss a split model's parts, and unbounded would
 * walk a drive. A folder that cannot be read is skipped, not thrown - a
 * permission problem on one subfolder must not hide the other twenty files.
 *
 * @param {string|string[]} dir one models folder, or several
 * @param {{ maxDepth?: number }} [options]
 */
export function scanLocalModels(dir, options = {}) {
  const { maxDepth = 3 } = options;
  const roots = (Array.isArray(dir) ? dir : [dir]).filter((d) => typeof d === "string" && d.trim());
  const found = [];

  const walk = (folder, depth) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !entry.name.startsWith(".")) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) continue;
      let bytes;
      try {
        bytes = statSync(full).size;
      } catch {
        continue; // a file that vanished mid-scan is not worth reporting
      }
      // A projector and a speculative-decoding head are files next to a model,
      // not models: "27B" from the name would be a false parameter count for a
      // 1.3 GB drafter, so the number is dropped rather than shown next to a
      // size that contradicts it. "mtp" anywhere in the name covers mtp-,
      // -MTP- and FastMTP, all of which are draft heads.
      const projector = /mmproj|projector/i.test(entry.name);
      const mtp = !projector && /mtp/i.test(entry.name);
      found.push({
        path: full,
        dir: folder,
        file: entry.name,
        bytes,
        gb: Number((bytes / GB_DECIMAL).toFixed(2)),
        quant: guessQuant(entry.name),
        params: projector || mtp ? null : guessParams(entry.name),
        projector,
        mtp,
      });
    }
  };

  for (const root of roots) {
    const folder = resolve(root);
    if (existsSync(folder)) walk(folder, 0);
  }
  return found.sort((a, b) => b.bytes - a.bytes);
}
