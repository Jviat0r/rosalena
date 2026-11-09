/**
 * How a local GGUF is loaded: the context, the layers on the card and the KV cache
 * type, chosen to fit this PC with room to spare, or set by hand and checked.
 *
 * The rule a person sees: pick a model, send a prompt, and it loads at the biggest
 * context that fits entirely on the graphics card while leaving a reserve free. If
 * even the smallest context does not fit, part of the model runs from system RAM
 * (slower, and said so). If it does not fit the card and the RAM together, nothing
 * is started. Manual settings go through the same check: a hand-picked context or
 * layer count that would overfill the card is refused with the numbers, never
 * loaded and left to crash the PC.
 *
 * The arithmetic, all in bytes:
 *   weights   the file's size on disk (exact)
 *   kv        kvBytesPerToken (from the GGUF header) x context x the cache type's size
 *   overhead  256 MiB + 2 KiB per token of context (llama.cpp's compute buffers grow with it)
 *   projector the mmproj file, when the model has one (it goes on the card too)
 *   budget    free VRAM + whatever the unload of our own previous model frees - reserve
 *
 * Settings live in <home>/local-models.json, beside the other per-person files, never
 * in harness.config.json (which belongs to the install).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { GIB, MIB } from "./hardware.mjs";

/** Bytes per element of each llama.cpp KV cache type (q8_0 and q4_0 are 32-value blocks). */
export const KV_TYPES = Object.freeze({ f16: 2, q8_0: 34 / 32, q4_0: 18 / 32 });
export const MIN_CONTEXT = 4096;
export const OFFLOAD_CONTEXT = 8192;
const RAM_RESERVE = 2 * GIB;
const MAX_CONTEXT_LIMIT = 1 << 20;

export const DEFAULT_PREFS = Object.freeze({
  // Minutes with nothing generating before a model Rosalena loaded is unloaded. 0 = never.
  idleUnloadMinutes: 10,
  // Stop a model Rosalena loaded when the app closes.
  unloadOnQuit: true,
  // VRAM kept free on top of the model. null = automatic: 6% of the card, at least 1 GiB.
  reserveGiB: null,
  // The largest context "auto" aims for. null = automatic: 32k, or the install's planContext
  // when that is bigger (this PC's config asks for 128k). A number set here is the cap.
  maxContext: null,
  // "auto": run part of a too-big model from RAM; "never": refuse it instead.
  offload: "auto",
  models: {},
});

const int = (v, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

/** One model's settings, cleaned: anything unreadable falls back to auto. */
export function cleanModelSettings(raw = {}) {
  const s = raw && typeof raw === "object" ? raw : {};
  const layers = s.gpuLayers === "all" ? "all" : int(s.gpuLayers, 0, 1000);
  return {
    mode: s.mode === "manual" ? "manual" : "auto",
    context: int(s.context, 512, MAX_CONTEXT_LIMIT),
    gpuLayers: layers ?? "auto",
    kvCache: Object.hasOwn(KV_TYPES, s.kvCache) ? s.kvCache : "auto",
  };
}

export const prefsFile = (home) => join(home, "local-models.json");

export function cleanPrefs(raw = {}) {
  const p = raw && typeof raw === "object" ? raw : {};
  const idle = Number(p.idleUnloadMinutes);
  const reserve = Number(p.reserveGiB);
  const models = {};
  for (const [alias, value] of Object.entries(p.models && typeof p.models === "object" ? p.models : {})) {
    const clean = cleanModelSettings(value);
    // An all-auto entry says nothing, so it is not kept.
    if (clean.mode === "manual") models[alias] = clean;
  }
  return {
    idleUnloadMinutes: Number.isFinite(idle) && idle >= 0 && idle <= 24 * 60 ? Math.round(idle) : DEFAULT_PREFS.idleUnloadMinutes,
    unloadOnQuit: p.unloadOnQuit === undefined ? DEFAULT_PREFS.unloadOnQuit : p.unloadOnQuit === true,
    reserveGiB: p.reserveGiB === null || p.reserveGiB === undefined || p.reserveGiB === "" ? null : Number.isFinite(reserve) && reserve >= 0 && reserve <= 64 ? reserve : null,
    maxContext: int(p.maxContext, MIN_CONTEXT, MAX_CONTEXT_LIMIT),
    offload: p.offload === "never" ? "never" : "auto",
    models,
  };
}

export function readLocalPrefs(home) {
  try {
    return cleanPrefs(JSON.parse(readFileSync(prefsFile(home), "utf8")));
  } catch {
    return cleanPrefs({});
  }
}

/** Merge a change in and save it. `models: { alias: null }` puts that model back on auto. */
export function writeLocalPrefs(home, patch = {}) {
  const now = readLocalPrefs(home);
  const models = { ...now.models };
  for (const [alias, value] of Object.entries(patch.models ?? {})) {
    if (value === null) delete models[alias];
    else models[alias] = { ...(models[alias] ?? {}), ...value };
  }
  const next = cleanPrefs({ ...now, ...patch, models });
  const file = prefsFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return next;
}

/** The VRAM kept free on top of a model. */
export function reserveBytesFor(totalBytes, prefs = DEFAULT_PREFS) {
  if (prefs.reserveGiB !== null && prefs.reserveGiB !== undefined) return Math.round(prefs.reserveGiB * GIB);
  return Math.max(GIB, Math.round((Number(totalBytes) || 0) * 0.06));
}

// Measured on a 3090 with flash attention (2026-11-03): Llama 3.1 8B at 32k used 8.6 GiB
// against 8.6 of weights + cache, the 27B Qwen at 64k used 18.4 against 18.3 - llama.cpp's
// own buffers are a few hundred MiB at most. This keeps a margin over that, and the
// reserve sits on top of it.
export const overheadFor = (context) => 256 * MIB + context * 2 * 1024;

/** The KV cache type the install's own flags ask for (`--cache-type-k q8_0`), if any. */
export function configuredKv(extraFlags = []) {
  const flags = extraFlags.map(String);
  const at = flags.findIndex((f) => f === "--cache-type-k" || f === "-ctk");
  const value = at >= 0 ? flags[at + 1] : null;
  return Object.hasOwn(KV_TYPES, value) ? value : null;
}

const pow2Below = (n) => 2 ** Math.floor(Math.log2(n));

/** The context "auto" aims for when the person has not set one: 32k, or the install's bigger planContext. */
export const autoContextCap = (preferredContext = 0) => Math.max(32768, Number(preferredContext) || 0);

/** Contexts to try, biggest first: the cap itself, then powers of two down to MIN_CONTEXT. */
export function contextLadder(cap) {
  const top = Math.max(512, Math.round(cap));
  const out = [top];
  for (let c = pow2Below(top); c >= MIN_CONTEXT; c /= 2) if (c < top) out.push(c);
  return [...new Set(out)];
}

const gibText = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;
const tokens = (n) => n.toLocaleString("en-US");

/**
 * The plan for one load.
 *
 * @param {object} input
 * @param {{bytes:number, projectorBytes?:number, alias?:string}} input.model
 * @param {{layers?:number, trainContext?:number, kvBytesPerToken?:number}|null} input.shape  from ggufShape
 * @param {{freeBytes:number, totalBytes:number, name?:string}|null} input.gpu  from gpuMemory
 * @param {number|null} input.ramFreeBytes
 * @param {number} [input.reclaimBytes]  VRAM our own loaded model frees when it is swapped out
 * @param {object} [input.prefs]  cleanPrefs output
 * @param {object} [input.settings]  cleanModelSettings output for this model
 * @param {number} [input.preferredContext]  the install's planContext
 * @param {string[]} [input.extraFlags]
 */
export function planLoad({ model, shape = null, gpu = null, ramFreeBytes = null, reclaimBytes = 0, prefs = DEFAULT_PREFS, settings = null, preferredContext = 16384, extraFlags = [] } = {}) {
  const s = cleanModelSettings(settings ?? {});
  const manual = s.mode === "manual";
  const weights = Math.max(0, Number(model?.bytes) || 0);
  const projector = Math.max(0, Number(model?.projectorBytes) || 0);
  const layers = shape?.layers ?? null;
  const trainCtx = shape?.trainContext ?? null;
  // A file whose header did not say gets a per-token KV size scaled from its weights
  // (Llama 3.1 8B: 4.9 GB of weights, 128 KiB per token), and the plan says it guessed.
  const kvExact = Boolean(shape?.kvBytesPerToken);
  const kvPerTokenF16 = shape?.kvBytesPerToken ?? Math.round(weights * 3e-5);
  const cap = Math.min(trainCtx ?? MAX_CONTEXT_LIMIT, prefs.maxContext ?? autoContextCap(preferredContext));
  const fromConfig = configuredKv(extraFlags);
  const kvChoices = manual && s.kvCache !== "auto" ? [s.kvCache] : [...new Set([fromConfig ?? "f16", "q8_0"])];
  const contexts = manual && s.context ? [Math.min(s.context, trainCtx ?? s.context)] : contextLadder(cap);
  const kvBytes = (context, kv) => Math.round((kvPerTokenF16 / 2) * KV_TYPES[kv] * context);
  const fullNeed = (context, kv) => weights + projector + kvBytes(context, kv) + overheadFor(context);
  const base = { mode: s.mode, layers, trainContext: trainCtx, kvExact, weightsBytes: weights, warnings: kvExact ? [] : ["the file's header did not give its KV size, so the cache size is an estimate"] };
  const refuse = (code, why, extra = {}) => ({ ok: false, code, why, ...base, ...extra });

  // No NVIDIA card answered: there is no number to fit against. Load the way the
  // install always has (its planContext, every layer offered) and say so - llama.cpp
  // reports a failed allocation itself, and a CPU-only PC still works.
  if (!gpu) {
    const context = contexts[0] && manual && s.context ? contexts[0] : Math.min(preferredContext ?? 16384, trainCtx ?? Infinity);
    const kvCache = kvChoices[0];
    const gpuLayers = manual && typeof s.gpuLayers === "number" ? s.gpuLayers : "all";
    // No RAM check either: the layers may well go to a card (AMD, Intel, Apple) that
    // simply has no nvidia-smi, and free RAM says nothing about that.
    return { ok: true, verdict: "unknown", context, kvCache, gpuLayers, ...base, why: "the graphics card did not report its memory (no nvidia-smi), so llama.cpp places the layers itself", warnings: [...base.warnings, "no VRAM check was possible on this PC"] };
  }

  const reserve = reserveBytesFor(gpu.totalBytes, prefs);
  const budget = gpu.freeBytes + Math.max(0, reclaimBytes) - reserve;
  const room = { freeBytes: gpu.freeBytes, totalBytes: gpu.totalBytes, reclaimBytes: Math.max(0, reclaimBytes), reserveBytes: reserve, budgetBytes: budget };
  const ramBudget = Number.isFinite(Number(ramFreeBytes)) ? Number(ramFreeBytes) - RAM_RESERVE : null;
  const where = `${gibText(Math.max(0, budget))} usable (${gibText(gpu.freeBytes)} free${reclaimBytes > 0 ? ` + ${gibText(reclaimBytes)} from the model being swapped out` : ""}, ${gibText(reserve)} kept in reserve)`;

  // 1. The whole model on the card, at the biggest context that fits.
  const wantAll = s.gpuLayers === "auto" || s.gpuLayers === "all" || (layers !== null && s.gpuLayers >= layers);
  if (wantAll) {
    for (const context of contexts) {
      for (const kv of kvChoices) {
        const need = fullNeed(context, kv);
        if (need <= budget) {
          return {
            ok: true,
            verdict: "gpu",
            context,
            kvCache: kv,
            gpuLayers: "all",
            needGpuBytes: need,
            needRamBytes: 0,
            ...room,
            ...base,
            why: `all ${layers ?? ""} layers on the card at ${tokens(context)} tokens (${kv} cache): ${gibText(need)} of ${where}`.replace("all  layers", "every layer"),
          };
        }
      }
    }
    if (manual && s.gpuLayers === "all") {
      const context = contexts[contexts.length - 1];
      return refuse("over-vram", `every layer at ${tokens(context)} tokens needs ${gibText(fullNeed(context, kvChoices[kvChoices.length - 1]))}, more than the ${where} - lower the context or the GPU layers, or set them back to Auto`, room);
    }
    if (prefs.offload === "never") {
      const context = contexts[contexts.length - 1];
      return refuse("too-big-for-gpu", `${gibText(fullNeed(context, kvChoices[kvChoices.length - 1]))} at ${tokens(context)} tokens is more than the ${where}, and running part of it from RAM is switched off`, room);
    }
  }

  // 2. Part on the card, the rest from RAM. Needs the layer count to split by.
  if (!layers) return refuse("no-layers", `it does not fit the card whole (${where}) and the file did not say how many layers it has, so it cannot be split safely`, room);
  const context = manual && s.context ? contexts[0] : Math.min(cap, OFFLOAD_CONTEXT);
  const kv = kvChoices[kvChoices.length - 1];
  const perLayer = weights / (layers + 1); // + 1: the embeddings and output head
  const kvPerLayer = kvBytes(context, kv) / layers;
  const fixed = projector + overheadFor(context) + perLayer;
  const fit = Math.max(0, Math.min(layers, Math.floor((budget - fixed) / (perLayer + kvPerLayer))));
  const n = manual && typeof s.gpuLayers === "number" ? Math.min(s.gpuLayers, layers) : fit;
  const gpuNeed = n > 0 ? fixed + n * (perLayer + kvPerLayer) : overheadFor(context);
  const ramNeed = (layers - n) * (perLayer + kvPerLayer) + perLayer + GIB;
  if (gpuNeed > budget) {
    return refuse("over-vram", `${n} layers on the card at ${tokens(context)} tokens needs ${gibText(gpuNeed)}, more than the ${where} - at most ${fit} layers fit`, { ...room, suggestion: { gpuLayers: fit, context } });
  }
  if (ramBudget !== null && ramNeed > ramBudget) {
    return refuse(
      "too-big",
      `it needs ${gibText(gpuNeed + ramNeed)} in all and this PC has ${gibText(Math.max(0, budget))} of usable VRAM and ${gibText(Math.max(0, ramBudget))} of free RAM - pick a smaller model or quant`,
      room,
    );
  }
  return {
    ok: true,
    verdict: n === 0 ? "cpu" : "offload",
    context,
    kvCache: kv,
    gpuLayers: n,
    needGpuBytes: gpuNeed,
    needRamBytes: ramNeed,
    ...room,
    ...base,
    why: `${n} of ${layers} layers on the card, the rest from RAM, at ${tokens(context)} tokens: ${gibText(gpuNeed)} of ${where} plus ${gibText(ramNeed)} of RAM`,
    warnings: [...base.warnings, n === 0 ? "runs on the processor only: expect a few tokens per second" : "part of the model runs from RAM, so it answers slower than a model that fits the card"],
  };
}

/**
 * The llama-server flags for a plan, merged into the install's own extra flags: the
 * plan's -c, -ngl and cache types replace any the flags set, and a quantised V cache
 * gets flash attention, which llama.cpp requires for it.
 */
export function launchFlags(plan, extraFlags = []) {
  const drop = new Set(["-c", "--ctx-size", "-ngl", "--n-gpu-layers", "--gpu-layers", "-ctk", "--cache-type-k", "-ctv", "--cache-type-v"]);
  const kept = [];
  const flags = extraFlags.map(String);
  for (let i = 0; i < flags.length; i += 1) {
    if (drop.has(flags[i])) {
      i += 1; // and its value
      continue;
    }
    kept.push(flags[i]);
  }
  if (plan.kvCache && plan.kvCache !== "f16") {
    kept.push("--cache-type-k", plan.kvCache, "--cache-type-v", plan.kvCache);
    if (!kept.includes("-fa") && !kept.includes("--flash-attn")) kept.push("-fa", "on");
  }
  return kept;
}

/** One line a person reads: where the model goes and why. */
export function describePlan(plan) {
  if (!plan) return "";
  if (!plan.ok) return plan.why;
  return [plan.why, ...(plan.warnings ?? [])].join(". ");
}
