/**
 * Which card the browser is probably describing, and how much VRAM it has.
 *
 * A browser cannot read VRAM. WebGPU will tell you a vendor string, a device
 * string and two allocation limits; that is all. So this file does the only
 * honest thing available: it recognises a card model name in the strings and
 * looks up the VRAM that the vendor says that model has.
 *
 * The numbers below are VENDOR SPECIFICATIONS, not measurements: NVIDIA / AMD /
 * Intel product pages and Apple's published unified-memory configurations for
 * each chip tier. They are the shipped VRAM of the common variant of that model.
 * Where a card is sold with more than one memory size the entry keeps the
 * smaller size (so a fit answer errs toward "does not fit"), lists the other in
 * `variants`, and the page says so next to the figure.
 *
 * This module is browser-safe and Node-safe: it is imported by the page and by
 * `site/test/fit.test.mjs`, and nothing here touches a DOM or a node builtin.
 */

const GIB_PER_BYTE = 1024 ** 3;

/**
 * One row per card. `match` is tried against the upper-cased card name, so every
 * pattern is written in upper case; rows are ordered most specific first, so
 * "RTX 4060 Ti" cannot be read as "RTX 4060".
 *
 * `variants` lists the other memory sizes that model ships with. `integrated`
 * means the part has no VRAM of its own and borrows system RAM, which is
 * reported as 0 because 0 is the truth for a VRAM comparison.
 */
export const GPU_TABLE = Object.freeze([
  // --- NVIDIA GeForce RTX 40 series (Ada) -----------------------------------
  { id: "rtx-4090", name: "GeForce RTX 4090", vendor: "nvidia", vramGb: 24, match: /RTX\s*4090/ },
  { id: "rtx-4080", name: "GeForce RTX 4080", vendor: "nvidia", vramGb: 16, match: /RTX\s*4080/ },
  { id: "rtx-4070-ti", name: "GeForce RTX 4070 Ti", vendor: "nvidia", vramGb: 12, variants: [16], match: /RTX\s*4070\s*TI/ },
  { id: "rtx-4070", name: "GeForce RTX 4070", vendor: "nvidia", vramGb: 12, match: /RTX\s*4070(?!\s*TI)/ },
  { id: "rtx-4060-ti-8", name: "GeForce RTX 4060 Ti", vendor: "nvidia", vramGb: 8, variants: [16], match: /RTX\s*4060\s*TI/ },
  // Laptop parts share the desktop name; the laptop 4060 is 8 GB like the desktop one.
  { id: "rtx-4060-laptop", name: "GeForce RTX 4060 Laptop GPU", vendor: "nvidia", vramGb: 8, laptop: true, match: /RTX\s*4060\s*LAPTOP/ },
  { id: "rtx-4060", name: "GeForce RTX 4060", vendor: "nvidia", vramGb: 8, match: /RTX\s*4060(?!\s*TI)/ },
  // --- NVIDIA GeForce RTX 30 series (Ampere) -------------------------------
  { id: "rtx-3090", name: "GeForce RTX 3090", vendor: "nvidia", vramGb: 24, match: /RTX\s*3090/ },
  { id: "rtx-3080-10", name: "GeForce RTX 3080", vendor: "nvidia", vramGb: 10, variants: [12], match: /RTX\s*3080/ },
  { id: "rtx-3070", name: "GeForce RTX 3070", vendor: "nvidia", vramGb: 8, match: /RTX\s*3070/ },
  { id: "rtx-3060", name: "GeForce RTX 3060", vendor: "nvidia", vramGb: 12, match: /RTX\s*3060/ },
  // --- NVIDIA GeForce RTX 20 series and GTX 10 series ----------------------
  { id: "rtx-2080-ti", name: "GeForce RTX 2080 Ti", vendor: "nvidia", vramGb: 11, match: /RTX\s*2080\s*TI/ },
  { id: "gtx-1080-ti", name: "GeForce GTX 1080 Ti", vendor: "nvidia", vramGb: 11, match: /GTX\s*1080\s*TI/ },

  // --- AMD Radeon RX 7000 / 6000 -------------------------------------------
  { id: "rx-7900-xtx", name: "Radeon RX 7900 XTX", vendor: "amd", vramGb: 24, match: /RX\s*7900\s*XTX/ },
  { id: "rx-7900-xt", name: "Radeon RX 7900 XT", vendor: "amd", vramGb: 20, match: /RX\s*7900\s*XT(?!X)/ },
  { id: "rx-7800-xt", name: "Radeon RX 7800 XT", vendor: "amd", vramGb: 16, match: /RX\s*7800\s*XT/ },
  { id: "rx-6800-xt", name: "Radeon RX 6800 XT", vendor: "amd", vramGb: 16, match: /RX\s*6800\s*XT/ },
  { id: "rx-6700-xt", name: "Radeon RX 6700 XT", vendor: "amd", vramGb: 12, match: /RX\s*6700\s*XT/ },
  { id: "rx-6600", name: "Radeon RX 6600", vendor: "amd", vramGb: 8, match: /RX\s*6600(?!\s*XT)/ },

  // --- Intel Arc, and the integrated parts people actually have ------------
  { id: "arc-a770", name: "Intel Arc A770", vendor: "intel", vramGb: 16, match: /ARC\s*A770/ },
  { id: "arc-a750", name: "Intel Arc A750", vendor: "intel", vramGb: 8, match: /ARC\s*A750/ },
  {
    id: "intel-igpu",
    name: "Intel UHD Graphics",
    vendor: "intel",
    vramGb: 0,
    integrated: true,
    match: /UHD\s*GRAPHICS|IRIS|HD\s*GRAPHICS/,
  },

  // --- Apple silicon: unified memory, so the GPU shares the system RAM -----
  // Base chips ship 8-16 GB, Pro 16-24, Max 32-36, Ultra 64-128. The entry uses
  // the smallest common configuration for the tier: a Mac with more memory gets
  // an answer that is too cautious, never too optimistic.
  { id: "m4-max", name: "Apple M4 Max", vendor: "apple", vramGb: 36, unified: true, match: /M4\s*MAX/ },
  { id: "m4-pro", name: "Apple M4 Pro", vendor: "apple", vramGb: 24, unified: true, match: /M4\s*PRO/ },
  { id: "m4", name: "Apple M4", vendor: "apple", vramGb: 16, unified: true, match: /M4(?![A-Z0-9])/ },
  { id: "m3-max", name: "Apple M3 Max", vendor: "apple", vramGb: 36, unified: true, match: /M3\s*MAX/ },
  { id: "m3-pro", name: "Apple M3 Pro", vendor: "apple", vramGb: 18, unified: true, match: /M3\s*PRO/ },
  { id: "m3", name: "Apple M3", vendor: "apple", vramGb: 8, unified: true, match: /M3(?![A-Z0-9])/ },
  { id: "m2-ultra", name: "Apple M2 Ultra", vendor: "apple", vramGb: 64, unified: true, match: /M2\s*ULTRA/ },
  { id: "m2-max", name: "Apple M2 Max", vendor: "apple", vramGb: 32, unified: true, match: /M2\s*MAX/ },
  { id: "m2-pro", name: "Apple M2 Pro", vendor: "apple", vramGb: 16, unified: true, match: /M2\s*PRO/ },
  { id: "m2", name: "Apple M2", vendor: "apple", vramGb: 8, unified: true, match: /M2(?![A-Z0-9])/ },
  { id: "m1-ultra", name: "Apple M1 Ultra", vendor: "apple", vramGb: 64, unified: true, match: /M1\s*ULTRA/ },
  { id: "m1-max", name: "Apple M1 Max", vendor: "apple", vramGb: 32, unified: true, match: /M1\s*MAX/ },
  { id: "m1-pro", name: "Apple M1 Pro", vendor: "apple", vramGb: 16, unified: true, match: /M1\s*PRO/ },
  { id: "m1", name: "Apple M1", vendor: "apple", vramGb: 8, unified: true, match: /M1(?![A-Z0-9])/ },
]);

/**
 * The name of the card as a person would say it, from whatever the browser puts
 * in `adapter.info.description` / `.device`.
 *
 * Chromium describes the adapter through ANGLE, which wraps the D3D name:
 *   ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Direct3D11 vs_5_0 ps_5_0, D3D11)
 * Firefox and Safari report a plain name or nothing at all. The function strips
 * the wrapper, the driver's API tail and the trademark marks, and returns the
 * model string; it returns null rather than a half-parsed string, and never
 * throws, because a name it cannot read is a normal outcome on those browsers.
 */
export function parseGpuName(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).replace(/\u0000/g, " ").trim();
  if (!s) return null;

  // Unwrap "ANGLE (vendor, device, api)" - the device is the second field.
  const angle = s.match(/^\s*ANGLE\s*\((.*)\)\s*$/i);
  if (angle) {
    const parts = angle[1].split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) s = parts[1];
    else if (parts.length === 1) s = parts[0];
  }

  // Drop the PCI ids and the API and shader-model tail ANGLE appends.
  s = s
    .replace(/\s*\(0x[0-9a-f]+\)/gi, "")
    .replace(/\s*\((?:0x[0-9a-f]+|D3D\d+|Vulkan|OpenGL|Metal)[^)]*\)\s*$/i, "")
    .replace(/\s*(Direct3D\d+|D3D\d+|OpenGL|Vulkan|Metal|GLES|OpenGL ES)[\s\S]*$/i, "")
    .replace(/\s*vs_\d+_\d+[\s\S]*$/i, "")
    .replace(/\s*ps_\d+_\d+[\s\S]*$/i, "")
    .replace(/\((?:R|TM|C)\)/gi, "")
    .replace(/[®™]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // A software rasteriser is not a graphics card; treating it as one would put a
  // real card's model row behind "llvmpipe".
  if (!s || /^(unknown|default|generic|software)|llvmpipe|swiftshader|microsoft basic render/i.test(s)) return null;
  return s;
}

/**
 * The table row a card name belongs to, or null. Case-insensitive and tolerant
 * of the vendor prefix ("NVIDIA GeForce RTX 3090" and "GeForce RTX 3090" both
 * land on the same row). A laptop part that is not its own row still matches the
 * desktop row, which is the best available answer and is flagged by `laptop`.
 */
export function lookupGpu(text) {
  const name = parseGpuName(text);
  if (!name) return null;
  const upper = name.toUpperCase();
  for (const gpu of GPU_TABLE) {
    if (gpu.match.test(upper)) return gpu;
  }
  return null;
}

/**
 * A VRAM guess for a card the table does not know (tier 2, labelled `inferred`).
 *
 * What WebGPU gives us is the largest single buffer the adapter will hand out.
 * That is a floor on memory, not a reading of it: Chromium reports 2 GiB on most
 * discrete cards and 4 GiB on some, so the limit only says which class of card
 * this is. The mapping below turns that class into the typical VRAM of that class
 * and is a rule of thumb, which is exactly why the page prints "inferred" next to
 * it and offers the picker. Intel parts with a small limit are integrated and own
 * no VRAM at all.
 */
export function inferVramGb({ vendor = null, maxBufferSize = null } = {}) {
  const limit = Number(maxBufferSize);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const gibLimit = limit / GIB_PER_BYTE;

  const v = String(vendor ?? "").toLowerCase();
  if (/intel/.test(v) && gibLimit <= 1) return 0; // integrated: shares system RAM
  if (/apple/.test(v)) return 16; // unified memory; the base tier is the cautious guess

  if (gibLimit >= 8) return 24;
  if (gibLimit >= 4) return 16;
  if (gibLimit >= 2) return 8;
  if (gibLimit >= 1) return 4;
  return null;
}

/**
 * The manual picker's options: every card with a discrete VRAM figure, grouped by
 * vendor so a visitor can find theirs. Integrated graphics are left out because
 * they have nothing to pick between; the number input covers them.
 */
export function manualOptions() {
  const vendors = [
    ["nvidia", "NVIDIA"],
    ["amd", "AMD"],
    ["intel", "Intel"],
    ["apple", "Apple"],
  ];
  return vendors
    .map(([vendor, label]) => ({
      label,
      options: GPU_TABLE.filter((gpu) => gpu.vendor === vendor && gpu.vramGb > 0).map((gpu) => ({
        id: gpu.id,
        label: `${gpu.name} (${gpu.vramGb} GB)`,
        vramGb: gpu.vramGb,
        name: gpu.name,
      })),
    }))
    .filter((group) => group.options.length > 0);
}

/** One table row by id, for a picker choice coming back through the DOM. */
export function gpuById(id) {
  return GPU_TABLE.find((gpu) => gpu.id === id) ?? null;
}
