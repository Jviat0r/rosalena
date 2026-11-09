/**
 * What the browser is allowed to tell us about this machine, and nothing more.
 *
 * Three sources, in order of trust:
 *   1. WebGPU's adapter: the vendor's device string, the two buffer limits, and
 *      which shader features exist. This is the only part that describes the GPU.
 *   2. `navigator.deviceMemory` and `navigator.hardwareConcurrency`: RAM (capped
 *      by the spec at 8 GiB, which is said out loud rather than shown as 8) and
 *      logical cores.
 *   3. `navigator.storage.estimate()` and `userAgentData`: disk quota and the
 *      CPU architecture, where the browser offers them.
 *
 * A browser cannot read VRAM, so the VRAM figure is resolved by name against
 * `gpus.js` and carries the tier it came from: `detected` (name recognised,
 * vendor spec looked up), `inferred` (guess from the adapter's limits) or, when
 * there is no WebGPU at all, `manual` (the visitor picked it).
 *
 * Two things this module deliberately never does: it never calls
 * `getContext("webgpu")` on a canvas (that would create a device and hold GPU
 * memory the visitor did not ask for), and it never requests a `GPUDevice`. It
 * reads the adapter, releases it, and stops.
 */

import { inferVramGb, lookupGpu, parseGpuName } from "./gpus.js";
// The notes this module writes are in i18n.js, in English and Spanish (<html lang> picks).
import { note } from "./i18n.js";

/** A slow `requestAdapter` must not turn the page into a spinner. */
export const ADAPTER_TIMEOUT_MS = 3000;

const TIMED_OUT = Symbol("timed-out");

/**
 * Resolve with `fallback` if `promise` has not settled in `ms`, so one hung
 * browser call cannot stall the page. The underlying call is left to finish on
 * its own; its adapter, if it ever arrives, is released by the caller's handler.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Let the adapter go. `GPUAdapter.destroy()` exists in current Chromium; older
 * builds do not have it, and an adapter that was only read is collected anyway,
 * so a missing method is not an error worth showing anyone.
 */
export function releaseAdapter(adapter) {
  try {
    adapter?.destroy?.();
  } catch {
    // Releasing is best effort: a throw here would only hide the reading.
  }
}

function safeArray(value) {
  try {
    return Array.from(value ?? []);
  } catch {
    return [];
  }
}

/** Read `adapter.info` without assuming it exists (older Chromium hides it). */
function readAdapterInfo(adapter) {
  let info = null;
  try {
    info = adapter?.info ?? null;
  } catch {
    info = null;
  }
  const field = (key) => {
    const value = info?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : "";
  };
  return {
    vendor: field("vendor"),
    architecture: field("architecture"),
    device: field("device"),
    description: field("description"),
  };
}

/**
 * The VRAM figure and where it came from.
 *
 * The name is tried first: `description` carries the ANGLE/D3D string on
 * Chromium for Windows, `device` carries it on some other builds. If the name is
 * recognised the number is the vendor's specification (`detected`). If not, the
 * card is still discrete and its buffer limit says which class of card it is, so
 * a guess is offered (`inferred`) with the reason attached. Nothing is returned
 * when neither works, and the page then asks the visitor.
 */
function resolveVram({ info, vendor, limits }) {
  const candidates = [info.description, info.device, info.architecture].filter(Boolean);
  let parsed = null;
  let match = null;
  for (const candidate of candidates) {
    const name = parseGpuName(candidate);
    if (!name) continue;
    parsed = parsed ?? name;
    const found = lookupGpu(name);
    if (found) {
      match = found;
      break;
    }
  }

  if (match) {
    return {
      gb: match.vramGb,
      source: "detected",
      gpuId: match.id,
      name: match.name,
      detail:
        match.integrated
          ? "integrated graphics: it has no VRAM of its own and borrows system RAM"
          : match.unified
            ? "unified memory: the GPU and the CPU share one pool, so part of it is already in use"
            : match.variants
              ? `this model also ships with ${match.variants.join(" or ")} GB; ${match.vramGb} GB is used here to stay cautious`
              : "",
    };
  }

  const guess = inferVramGb({ vendor: vendor || info.vendor, maxBufferSize: limits.maxBufferSize });
  if (guess === null) {
    return { gb: null, source: null, gpuId: null, name: parsed, detail: "" };
  }
  return {
    gb: guess,
    source: "inferred",
    gpuId: null,
    name: parsed,
    detail: `card not recognised, so ${guess} GB is guessed from the adapter's ${Math.round(limits.maxBufferSize / (1024 ** 3))} GiB buffer limit`,
  };
}

/**
 * Everything the page is allowed to know. Never throws: a browser that blocks a
 * call, or a reading that fails, comes back as a null field with the reason in
 * `notes`, because "unknown" is a legitimate answer and an exception here would
 * cost the visitor the whole page.
 *
 * @param {{ timeoutMs?: number }} [options]
 */
export async function detectHardware(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : ADAPTER_TIMEOUT_MS;
  const reading = {
    at: new Date().toISOString(),
    webgpu: { available: false, error: null, timedOut: false, wgslLanguageFeatures: [] },
    adapter: null,
    vram: { gb: null, source: null, gpuId: null, name: null, detail: "" },
    ram: { gb: null, clamped: false, source: null },
    cpu: { logicalCores: null },
    ua: { architecture: null, bitness: null, platformVersion: null },
    storage: { quotaBytes: null, usageBytes: null },
    notes: [],
  };

  const nav = typeof navigator === "undefined" ? null : navigator;
  if (!nav) {
    reading.notes.push(note().noNavigator);
    return reading;
  }

  // --- CPU, from the two always-available fields ---------------------------
  const cores = Number(nav.hardwareConcurrency);
  reading.cpu.logicalCores = Number.isFinite(cores) && cores > 0 ? Math.round(cores) : null;

  // --- RAM: deviceMemory is rounded, and the spec caps it at 8 GiB, so the value
  // is a floor either way: 8 means "at least 8", never "exactly 8".
  const deviceMemory = Number(nav.deviceMemory);
  if (Number.isFinite(deviceMemory) && deviceMemory > 0) {
    reading.ram.gb = deviceMemory;
    reading.ram.clamped = deviceMemory === 8;
    reading.ram.source = "navigator.deviceMemory";
    reading.notes.push(
      deviceMemory === 8
        ? note().ramCapped
        : note().ramRounded,
    );
  } else {
    reading.notes.push(note().ramUnknown);
  }

  // --- Storage quota: how much room a 20 GB download would have ------------
  try {
    const estimate = await withTimeout(nav.storage?.estimate?.() ?? null, timeoutMs);
    if (estimate && estimate !== TIMED_OUT) {
      reading.storage.quotaBytes = Number.isFinite(estimate.quota) ? estimate.quota : null;
      reading.storage.usageBytes = Number.isFinite(estimate.usage) ? estimate.usage : null;
    } else if (estimate === TIMED_OUT) {
      reading.notes.push(note().storageSilent);
    }
  } catch {
    reading.notes.push(note().storageRefused);
  }

  // --- High-entropy UA hints: CPU architecture, where Chromium offers them --
  try {
    const uaData = nav.userAgentData;
    if (uaData && typeof uaData.getHighEntropyValues === "function") {
      const values = await withTimeout(
        uaData.getHighEntropyValues(["architecture", "bitness", "platformVersion"]),
        timeoutMs,
      );
      if (values !== TIMED_OUT && values) {
        reading.ua.architecture = values.architecture || null;
        reading.ua.bitness = values.bitness || null;
        reading.ua.platformVersion = values.platformVersion || null;
      }
    } else {
      reading.notes.push(note().noHints);
    }
  } catch {
    reading.notes.push(note().hintsRefused);
  }

  // --- The GPU -------------------------------------------------------------
  const gpu = nav.gpu ?? null;
  if (!gpu || typeof gpu.requestAdapter !== "function") {
    reading.webgpu.error = note().noGpuError;
    reading.notes.push(note().noGpu);
    return reading;
  }
  reading.webgpu.available = true;
  reading.webgpu.wgslLanguageFeatures = safeArray(gpu.wgslLanguageFeatures);

  let adapter = null;
  try {
    const pending = gpu.requestAdapter({ powerPreference: "high-performance" });
    const result = await withTimeout(pending, timeoutMs);
    if (result === TIMED_OUT) {
      // Release an adapter that arrives after the page gave up waiting, so a slow
      // driver does not leave the GPU allocated for the rest of the session.
      pending.then((late) => releaseAdapter(late), () => {});
      reading.webgpu.timedOut = true;
      reading.webgpu.error = note().gpuTimeoutError(timeoutMs);
      reading.notes.push(note().gpuTimeout(timeoutMs / 1000));
      return reading;
    }
    adapter = result;
  } catch (err) {
    reading.webgpu.error = String(err?.message ?? err);
    reading.notes.push(note().adapterFailed(reading.webgpu.error));
    return reading;
  }

  if (!adapter) {
    reading.webgpu.error = note().nullAdapterError;
    reading.notes.push(note().nullAdapter);
    return reading;
  }

  try {
    const info = readAdapterInfo(adapter);
    const limits = {
      maxBufferSize: Number(adapter.limits?.maxBufferSize) || null,
      maxStorageBufferBindingSize: Number(adapter.limits?.maxStorageBufferBindingSize) || null,
    };
    const features = safeArray(adapter.features);
    reading.adapter = {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
      name: parseGpuName(info.description) || parseGpuName(info.device) || null,
      limits,
      features,
      // What actually makes a card usable for local inference through WebGPU:
      // f16 arithmetic, and subgroup ops for the faster matmul paths.
      shaderF16: features.includes("shader-f16"),
      subgroups: features.some((feature) => /^subgroups/.test(feature)),
      isFallback: Boolean(adapter.isFallbackAdapter),
    };

    reading.vram = resolveVram({ info, vendor: info.vendor, limits });

    if (reading.vram.gb === 0) {
      reading.notes.push(note().integrated);
    } else if (reading.vram.source === "inferred") {
      reading.notes.push(note().inferred);
    } else if (reading.vram.source === null) {
      reading.notes.push(note().unknown);
    }
  } finally {
    releaseAdapter(adapter);
  }

  return reading;
}
