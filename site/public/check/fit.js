/**
 * The arithmetic that decides "does this model fit", ported from the desktop
 * app so this page and the app cannot disagree about what "fits" means.
 *
 * The three functions below are copies of `harness/src/hardware.mjs`
 * (`estimateModelNeeds`, `fitScore`, `bitsPerWeightFor`) and its constants, and
 * the quant choice copies `recommend()` in `harness/src/catalog.mjs`. Names and
 * verdict strings are the app's own: "fits", "tight", "tooBig", "unknown".
 * `site/test/fit.test.mjs` pins the byte results to values produced by the app's
 * own code, so a formula change on either side fails the build instead of
 * quietly making the site's advice optimistic.
 *
 * Browser-safe on purpose: no `fs`, no `process`, no `node:` imports, so the
 * page can import this file and a Node test can import the same file.
 *
 * One difference from the app sits in the caller, not in the formula: the app
 * compares against FREE VRAM (what is left right now, so a second model does not
 * fit beside the first), while a browser can only ever learn the card's total.
 * `recommend()` below therefore passes totals in. The page answers "could this
 * machine run it at all"; the app answers "will it fit right now". The app's
 * answer is the stricter one.
 */

// ---------------------------------------------------------------------------
// Units. Bytes everywhere: GIB is 1024^3 (what nvidia-smi reports in MiB and
// what the CLI prints), GB_DECIMAL is Hugging Face's file size (1e9 bytes).
// ---------------------------------------------------------------------------

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
export const GB_DECIMAL = 1e9;

/** f16 is llama.cpp's default KV type. */
export const KV_BYTES_PER_ELEMENT = 2;

/** Runtime overhead that is neither weights nor KV cache: 0.5 GiB, rounded up. */
export const RUNTIME_OVERHEAD_BYTES = Math.round(0.5 * GIB);

/** KV cache when a model has no layers/kvDim: 8 KiB per billion params per token. */
export const KV_FALLBACK_BYTES_PER_TOKEN_PER_BILLION = 8192;

/**
 * Effective bits per weight, measured off real GGUF files rather than assumed
 * from the block name (k-quants carry scales and minimums on top of the weights).
 * Same table as the app; see `harness/src/hardware.mjs` for the cross-checks
 * against the Qwen3-32B files.
 */
export const QUANT_BITS_PER_WEIGHT = Object.freeze({
  Q2_K: 3.35,
  Q3_K_S: 3.7,
  Q3_K_M: 3.9,
  IQ4_XS: 4.25,
  Q4_0: 4.55,
  Q4_K_S: 4.6,
  Q4_K_M: 4.8,
  Q5_0: 5.55,
  Q5_K_S: 5.5,
  Q5_K_M: 5.6,
  Q6_K: 6.6,
  Q8_0: 8.5,
  F16: 16,
  BF16: 16,
});

// ---------------------------------------------------------------------------
// Small normalisers: absent is null, never 0 ("nobody measured this" and "there
// is none free" are different answers, and only one of them is a reading).
// ---------------------------------------------------------------------------

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positiveInt(value) {
  const n = positive(value);
  return n === null ? null : Math.round(n);
}

function nonNegative(value) {
  // Number(null) is 0 and Number("") is 0, which would turn "nobody measured
  // this" into "the card is full".
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------------------------------------------------------------------
// The fit arithmetic (ported unchanged)
// ---------------------------------------------------------------------------

/**
 * Bits per weight for a quant label, including the labels publishers invent.
 * "UD-Q4_K_M" (Unsloth dynamic), "i1-Q4_K_S" (imatrix) and "Q4_K_P" are all
 * 4-bit k-quants, so the label is read down to its base shape: exact match, then
 * strip the publisher prefix, then a trailing size letter, then the leading Qn.
 * Null for a label with no bit width at all - never a guessed "Q4".
 */
export function bitsPerWeightFor(quant) {
  const label = String(quant ?? "")
    .toUpperCase()
    .trim()
    .replace(/^(UD|I1)-/, "");
  if (!label) return null;
  if (QUANT_BITS_PER_WEIGHT[label] !== undefined) return QUANT_BITS_PER_WEIGHT[label];
  const trimmed = label.replace(/_(XL|L|P)$/, "");
  if (QUANT_BITS_PER_WEIGHT[trimmed] !== undefined) return QUANT_BITS_PER_WEIGHT[trimmed];
  const base = trimmed.match(/^I?Q(\d+)/);
  const byWidth = { 2: 3.35, 3: 3.9, 4: 4.8, 5: 5.6, 6: 6.6, 8: 8.5 };
  return base ? (byWidth[Number(base[1])] ?? null) : null;
}

/**
 * Bytes a model needs resident: weights + KV cache + anything it must load
 * alongside (a vision projector) + runtime overhead.
 *
 *   weights = fileGb * 1e9              when the file size is known (catalog)
 *           = params * 1e9 * bits / 8   otherwise
 *   kv      = 2 * layers * context * kvDim * 2   (K and V, f16)
 *   extra   = extraGb * 1e9             (mmproj projector, if any)
 *   need    = weights + kv + extra + overhead
 *
 * Throws only for a spec that cannot be computed (no context, an unknown quant
 * label with no explicit bits), exactly as the app does.
 */
export function estimateModelNeeds(spec = {}) {
  const context = positiveInt(spec.context);
  if (context === null) throw new TypeError("estimateModelNeeds needs a context size in tokens");

  let bitsPerWeight = null;
  if (spec.bitsPerWeight !== undefined && spec.bitsPerWeight !== null) bitsPerWeight = positive(spec.bitsPerWeight);
  else if (spec.quant) {
    bitsPerWeight = bitsPerWeightFor(spec.quant);
    if (bitsPerWeight === null) {
      throw new TypeError(`unknown quant "${spec.quant}" - pass bitsPerWeight or one of: ${Object.keys(QUANT_BITS_PER_WEIGHT).join(", ")}`);
    }
  }

  const fileGb = positive(spec.fileGb);
  const params = positive(spec.params);
  let weightsBytes = null;
  let weightsFrom = null;
  if (fileGb !== null) {
    weightsBytes = Math.round(fileGb * GB_DECIMAL);
    weightsFrom = "file";
  } else if (params !== null && bitsPerWeight !== null) {
    weightsBytes = Math.round((params * GB_DECIMAL * bitsPerWeight) / 8);
    weightsFrom = "params";
  } else {
    throw new TypeError("estimateModelNeeds needs fileGb, or params with a quant (or bitsPerWeight)");
  }

  const layers = positiveInt(spec.layers);
  const kvDim = positiveInt(spec.kvDim);
  let kvCacheBytes = null;
  let kvFrom = null;
  if (layers !== null && kvDim !== null) {
    const bytesPerElement = positive(spec.kvBytesPerElement) ?? KV_BYTES_PER_ELEMENT;
    kvCacheBytes = Math.round(2 * layers * context * kvDim * bytesPerElement);
    kvFrom = "architecture";
  } else if (params !== null) {
    kvCacheBytes = Math.round(params * KV_FALLBACK_BYTES_PER_TOKEN_PER_BILLION * context);
    kvFrom = "rule of thumb (8 KiB per billion params per token)";
  } else {
    kvCacheBytes = null;
    kvFrom = null;
  }

  const extraGb = positive(spec.extraGb);
  const extraBytes = extraGb === null ? 0 : Math.round(extraGb * GB_DECIMAL);
  const overheadBytes = spec.overheadBytes === undefined ? RUNTIME_OVERHEAD_BYTES : nonNegative(spec.overheadBytes) ?? RUNTIME_OVERHEAD_BYTES;
  const totalBytes = weightsBytes + (kvCacheBytes ?? 0) + extraBytes + overheadBytes;

  return {
    weightsBytes,
    kvCacheBytes,
    extraBytes,
    overheadBytes,
    totalBytes,
    bitsPerWeight,
    context,
    basis: { weights: weightsFrom, kv: kvFrom },
  };
}

/**
 * The verdict, as three words the page can group by:
 *
 *   fits    - needBytes <= VRAM: it loads fully on the card. Boundary counts:
 *             need === total is a fit with zero spare, not a miss.
 *   tight   - does not fit VRAM, but fits RAM: it runs with CPU/partial offload.
 *   tooBig  - fits neither.
 *   unknown - neither figure could be had; saying "fits" here would be a guess.
 */
export function fitScore({ needBytes, gpuFreeBytes = null, ramFreeBytes = null } = {}) {
  const need = Number(needBytes);
  if (!Number.isFinite(need) || need <= 0) throw new TypeError("fitScore needs a positive needBytes");

  const gpuFree = nonNegative(gpuFreeBytes);
  const ramFree = nonNegative(ramFreeBytes);
  const gpuHeadroomBytes = gpuFree === null ? null : gpuFree - need;
  const ramHeadroomBytes = ramFree === null ? null : ramFree - need;

  let verdict;
  let device = null;
  if (gpuFree !== null && need <= gpuFree) {
    verdict = "fits";
    device = "gpu";
  } else if (ramFree !== null && need <= ramFree) {
    verdict = "tight";
    device = "ram";
  } else if (gpuFree === null && ramFree === null) {
    verdict = "unknown";
  } else {
    verdict = "tooBig";
  }

  return {
    verdict,
    device,
    needBytes: need,
    gpuHeadroomBytes,
    ramHeadroomBytes,
    headroomBytes: device === "gpu" ? gpuHeadroomBytes : device === "ram" ? ramHeadroomBytes : null,
  };
}

// ---------------------------------------------------------------------------
// A browser reading, in the shape the arithmetic above expects
// ---------------------------------------------------------------------------

/**
 * How the VRAM figure was obtained. This is the whole honesty contract of the
 * page, so it is a closed set and every reading must name one:
 *   detected - the browser named the card and its specification VRAM is known
 *   inferred - the card was not recognised; the figure is a guess from limits
 *   manual   - the visitor picked the card or typed the number
 */
export const VRAM_SOURCES = Object.freeze(["detected", "inferred", "manual"]);

/**
 * Turn a page reading into the `{ gpu, ram }` shape `fitScore` and `recommend`
 * read. `vramSource` is required: a reading with no provenance would have to
 * default to "detected", which is the one thing this page must never fake.
 */
export function hardwareReading({
  name = null,
  vendor = null,
  vramGb = null,
  vramSource,
  ramGb = null,
  ramSource = null,
  webgpu = null,
  notes = [],
} = {}) {
  if (!VRAM_SOURCES.includes(vramSource)) {
    throw new TypeError(`hardwareReading needs a vramSource of ${VRAM_SOURCES.join(", ")}`);
  }
  // 0 is a real figure here: integrated graphics own no VRAM and borrow RAM.
  const vramBytes = nonNegative(vramGb) === null ? null : Math.round(nonNegative(vramGb) * GIB);
  const ramBytes = positive(ramGb) === null ? null : Math.round(positive(ramGb) * GIB);
  return {
    vramSource,
    gpu: { name, vendor, vramTotalBytes: vramBytes, source: vramSource },
    ram: { totalBytes: ramBytes, source: ramSource },
    webgpu,
    notes,
  };
}

/** GiB, one decimal place, the unit the app prints. */
export function formatGib(bytes) {
  return `${(Number(bytes) / GIB).toFixed(1)} GiB`;
}

/**
 * The one sentence a row carries. Same shape of sentence as the app's
 * `reasonFor`, but worded for totals ("your card has") because that is what the
 * page was able to read.
 */
export function reasonFor(row, hardware) {
  const vram = hardware?.gpu?.vramTotalBytes;
  const ram = hardware?.ram?.totalBytes;
  const card = vram === null || vram === undefined ? null : `${Math.round(vram / GIB)} GB`;
  if (row.verdict === "fits") {
    return `Fits your ${card} card with ${formatGib(row.gpuHeadroomBytes)} to spare.`;
  }
  if (row.verdict === "tight") {
    const ramText = ram === null || ram === undefined ? "the RAM your browser reported" : formatGib(ram);
    return `Needs ${formatGib(row.needBytes)}, more than your ${card} of VRAM, but inside ${ramText} of RAM, so it runs with CPU offload.`;
  }
  if (row.verdict === "tooBig") {
    const over = row.gpuHeadroomBytes === null ? "" : ` - ${formatGib(-row.gpuHeadroomBytes)} more than your card`;
    const ramNote =
      ram === null || ram === undefined
        ? ", and the browser did not report enough RAM to hold it either"
        : ` and more than the ${formatGib(ram)} of RAM this browser would confirm`;
    return `Needs ${formatGib(row.needBytes)}${over}${ramNote}.`;
  }
  return `Needs ${formatGib(row.needBytes)}, but no VRAM figure came back, so there is nothing to compare it with.`;
}

// ---------------------------------------------------------------------------
// Which quant to recommend, and how the models group
// ---------------------------------------------------------------------------

/**
 * Fit every catalog entry against a reading.
 *
 * The quant choice is the app's: the largest quant that fits, then the largest
 * that fits RAM, then the smallest so a "does not fit" row quotes a floor rather
 * than a quant nobody asked for. Rows come back in the app's three groups plus
 * `unknown`, and each row keeps every quant it was measured at so the page can
 * show the full ladder under "More".
 *
 * @param {{ hardware: object, catalog: object|object[] }} input
 * @returns {{ fits: object[], tight: object[], tooBig: object[], unknown: object[], rows: object[] }}
 */
export function recommend({ hardware, catalog } = {}) {
  if (!hardware?.gpu && !hardware?.ram) throw new TypeError("recommend needs a hardware reading");
  const models = Array.isArray(catalog) ? catalog : catalog?.models;
  if (!Array.isArray(models)) throw new TypeError("recommend needs a catalog ({ models: [...] })");

  const vramBytes = hardware.gpu?.vramTotalBytes ?? null;
  const ramBytes = hardware.ram?.totalBytes ?? null;
  const vramSource = hardware.vramSource ?? hardware.gpu?.source ?? null;

  const rows = models.map((entry) => {
    if (!Array.isArray(entry?.quants) || entry.quants.length === 0) throw new Error(`${entry?.id ?? "an entry"}: no quants`);
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
      const fit = fitScore({ needBytes: needs.totalBytes, gpuFreeBytes: vramBytes, ramFreeBytes: ramBytes });
      return {
        quant: quant.quant,
        file: quant.file,
        url: quant.url ?? null,
        needBytes: needs.totalBytes,
        weightsBytes: needs.weightsBytes,
        kvCacheBytes: needs.kvCacheBytes,
        context: needs.context,
        verdict: fit.verdict,
        device: fit.device,
        headroomBytes: fit.headroomBytes,
        gpuHeadroomBytes: fit.gpuHeadroomBytes,
        ramHeadroomBytes: fit.ramHeadroomBytes,
      };
    });

    const bySize = [...quants].sort((a, b) => a.needBytes - b.needBytes);
    const chosen =
      quants.filter((q) => q.verdict === "fits").sort((a, b) => b.needBytes - a.needBytes)[0] ??
      quants.filter((q) => q.verdict === "tight").sort((a, b) => b.needBytes - a.needBytes)[0] ??
      bySize[0];

    const fit = fitScore({ needBytes: chosen.needBytes, gpuFreeBytes: vramBytes, ramFreeBytes: ramBytes });
    const row = {
      entry,
      quant: chosen.quant,
      quantSpec: { quant: chosen.quant, file: chosen.file, url: chosen.url },
      needBytes: chosen.needBytes,
      weightsBytes: chosen.weightsBytes,
      kvCacheBytes: chosen.kvCacheBytes,
      context: chosen.context,
      verdict: fit.verdict,
      device: fit.device,
      headroomBytes: fit.headroomBytes,
      gpuHeadroomBytes: fit.gpuHeadroomBytes,
      ramHeadroomBytes: fit.ramHeadroomBytes,
      smallest: chosen.needBytes === bySize[0].needBytes,
      // Stamped on every row so no screen can show a verdict without saying
      // where its VRAM figure came from.
      vramSource,
      quants,
    };
    row.reason = reasonFor(row, hardware);
    return row;
  });

  return {
    fits: rows.filter((r) => r.verdict === "fits").sort((a, b) => b.needBytes - a.needBytes),
    tight: rows.filter((r) => r.verdict === "tight").sort((a, b) => a.needBytes - b.needBytes),
    tooBig: rows.filter((r) => r.verdict === "tooBig").sort((a, b) => a.needBytes - b.needBytes),
    unknown: rows.filter((r) => r.verdict === "unknown").sort((a, b) => a.needBytes - b.needBytes),
    rows,
  };
}

/**
 * The GGUF file name for a quant, taken from the download URL, because the
 * catalog stores the size in `file` and the name only in the link. Falls back to
 * the model and quant when a URL is missing, which keeps the copy button honest
 * about not knowing the exact name.
 */
export function fileNameFor(entry, quant) {
  const url = quant?.url ?? null;
  if (url) {
    const tail = String(url).split("/").filter(Boolean).pop() ?? "";
    const name = decodeURIComponent(tail.split("?")[0]);
    if (name.toLowerCase().endsWith(".gguf")) return name;
  }
  return `${String(entry?.name ?? entry?.id ?? "model").replace(/\s+/g, "-")}-${quant?.quant ?? "quant"}.gguf`;
}

/**
 * The command that serves this model, for the visitor to run after the app
 * installs llama.cpp. `-ngl 99` offloads every layer the runtime can; `-c` is the
 * catalog's serve context, the same one the KV arithmetic above used, so the
 * command and the number on the row describe the same configuration.
 *
 * Takes a row from `recommend()` (which carries `entry`, `quantSpec` and
 * `context`) so the button cannot copy a command for a different quant than the
 * one the row was fitted at.
 */
export function llamaCommand(row = {}) {
  const entry = row.entry ?? null;
  const quant = row.quantSpec ?? { quant: row.quant, url: row.url ?? null };
  const file = fileNameFor(entry, quant);
  const ctx = Number(row.context ?? entry?.serveContext ?? entry?.context);
  return `llama-server -m models\\${file} -c ${ctx} -ngl 99`;
}
