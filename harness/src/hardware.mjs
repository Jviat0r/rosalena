/**
 * What this machine is, and what it can hold.
 *
 * Two jobs, deliberately in one module because they share one unit system:
 *
 *   1. `probeHardware({ modelsDir })` - the machine: CPU, RAM, GPU, the free space
 *      on the drive that holds the models. Every field this cannot measure is
 *      `null` and is listed in `unknown`, never `0` and never a guess. A `0` is a
 *      reading ("nothing is free"); an absent tool is not a reading.
 *   2. `fitScore` / `estimateModelNeeds` - the arithmetic that answers "does this
 *      model fit". Catalog and CLI both call these, so the table and the UI cannot
 *      disagree about what "fits" means.
 *
 * No dependencies. Windows tools are spawned with an argument array (never a
 * joined command line, so nothing is quoted by us and nothing is interpolated by
 * a shell), `windowsHide: true`, and a 4-second cap. A tool that is missing,
 * slow, or prints nonsense is reported as unknown; none of these functions throw
 * for an environment reason.
 *
 * Units: bytes everywhere. `GIB` is 1024^3 and is what the CLI prints, because
 * VRAM is reported in MiB by nvidia-smi. Hugging Face file sizes are DECIMAL
 * gigabytes; `GB_DECIMAL` marks those, and the catalog's `file` field uses them.
 */

import os from "node:os";
import { existsSync, statfsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const GIB = 1024 ** 3;
export const MIB = 1024 ** 2;
/** Hugging Face, llama.cpp and `ls -la` all print decimal GB: 1e9 bytes. */
export const GB_DECIMAL = 1e9;

/** No Windows tool may hold the probe longer than this. */
export const TOOL_TIMEOUT_MS = 4000;

// ---------------------------------------------------------------------------
// Running a tool without a shell
// ---------------------------------------------------------------------------

/**
 * One spawned process, argv only. Returns a result object and never throws.
 *
 * `spawnSync` is used rather than `spawn` because the probe is a synchronous
 * question with a hard deadline: a timeout kills the child and comes back as
 * `ETIMEDOUT`, which is exactly "unknown".
 */
export function runTool(exe, args, timeoutMs = TOOL_TIMEOUT_MS) {
  try {
    const result = spawnSync(exe, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 4 * MIB,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    if (result.error) return { ok: false, error: result.error.code ?? result.error.message };
    if (result.status !== 0) {
      return { ok: false, error: `exit ${result.status}`, stderr: String(result.stderr ?? "").trim().slice(0, 200) };
    }
    return { ok: true, stdout: String(result.stdout ?? "") };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** JSON from a Windows tool: tolerate a BOM and a trailing newline. */
function parseJsonLoose(text) {
  const trimmed = String(text ?? "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CPU, RAM and display adapters: one CIM query
// ---------------------------------------------------------------------------

// One PowerShell invocation for everything WMI/CIM has to say, because each
// spawn costs ~1.5 s on this box and three queries would make `--check` feel
// broken. `Get-CimInstance` replaces `wmic`, which Windows 11 no longer ships.
// The script is a single argv element: JavaScript never builds a command line,
// so a quote or a space in a GPU name cannot become syntax.
const CIM_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "$cpu=Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1",
  "$cs=Get-CimInstance -ClassName Win32_ComputerSystem",
  "$vc=@(Get-CimInstance -ClassName Win32_VideoController)",
  "[pscustomobject]@{cpuName=[string]$cpu.Name;cpuCores=[int]$cpu.NumberOfCores;" +
    "cpuLogical=[int]$cpu.NumberOfLogicalProcessors;ramTotalBytes=[long]$cs.TotalPhysicalMemory;" +
    "adapters=@($vc | ForEach-Object { [pscustomobject]@{name=[string]$_.Name;driver=[string]$_.DriverVersion} })}" +
    " | ConvertTo-Json -Compress -Depth 4",
].join("; ");

function queryWindowsSystem(runner) {
  const result = runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", CIM_SCRIPT], TOOL_TIMEOUT_MS);
  if (!result.ok) return { ok: false, error: result.error ?? "no output" };
  const json = parseJsonLoose(result.stdout);
  if (!json) return { ok: false, error: "unreadable JSON" };
  // PowerShell 5.1 collapses a one-element array, so normalise before use.
  const adapters = [].concat(json.adapters ?? []).map((a) => ({
    name: text(a?.name),
    driver: text(a?.driver),
  }));
  return {
    ok: true,
    cpuName: text(json.cpuName),
    cpuCores: positiveInt(json.cpuCores),
    cpuLogical: positiveInt(json.cpuLogical),
    ramTotalBytes: positive(json.ramTotalBytes),
    adapters: adapters.filter((a) => a.name),
  };
}

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

const NV_ARGS = ["--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader,nounits"];

/** MiB as printed by nvidia-smi, or null when the column says `[N/A]`. */
function mibToBytes(value) {
  const n = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * MIB);
}

/**
 * One row per GPU. nvidia-smi prints `name, memory.total, memory.free, driver`
 * with no header and no units; a machine with a dGPU and an iGPU still prints
 * only the NVIDIA cards, so a row is a card that can actually run CUDA.
 */
export function parseNvidiaSmi(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, total, free, driver] = line.split(",").map((part) => part.trim());
      const bytes = mibToBytes(total);
      return {
        name: text(name),
        vramTotalBytes: bytes,
        vramFreeBytes: free === undefined ? null : mibToBytes(free),
        driverVersion: text(driver),
      };
    })
    .filter((row) => row.name)
    .sort((a, b) => (b.vramTotalBytes ?? 0) - (a.vramTotalBytes ?? 0));
}

function queryNvidiaSmi(runner) {
  const candidates = ["nvidia-smi"];
  if (process.env.ProgramFiles) candidates.push(resolve(process.env.ProgramFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"));
  if (process.env.SystemRoot) candidates.push(resolve(process.env.SystemRoot, "System32", "nvidia-smi.exe"));
  let lastError = null;
  for (const exe of candidates) {
    const result = runner(exe, NV_ARGS, TOOL_TIMEOUT_MS);
    if (!result.ok) {
      lastError = result.error ?? "failed";
      continue;
    }
    const rows = parseNvidiaSmi(result.stdout);
    if (rows.length) return { rows, error: null };
    lastError = "no GPU row";
  }
  return { rows: [], error: lastError };
}

/**
 * Just the card's memory, now: what a model load checks right before it starts. The
 * full probe also asks Windows for the CPU and RAM through CIM, which takes a second;
 * a load only needs nvidia-smi and the free RAM. Null when no NVIDIA card answers.
 */
export function gpuMemory({ runner = runTool } = {}) {
  const smi = queryNvidiaSmi(runner);
  const card = smi.rows[0];
  if (!card || card.vramTotalBytes === null || card.vramFreeBytes === null) return null;
  return { name: card.name, totalBytes: card.vramTotalBytes, freeBytes: card.vramFreeBytes, cards: smi.rows.length };
}

function vendorOf(name) {
  if (!name) return null;
  if (/nvidia|geforce|quadro|tesla|rtx/i.test(name)) return "nvidia";
  if (/amd|radeon|firepro/i.test(name)) return "amd";
  if (/intel|arc|iris|uhd/i.test(name)) return "intel";
  return null;
}

// ---------------------------------------------------------------------------
// Small normalisers: absent is null, never 0
// ---------------------------------------------------------------------------

function text(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s && s !== "[N/A]" && s !== "N/A" ? s : null;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function positiveInt(value) {
  const n = positive(value);
  return n === null ? null : Math.round(n);
}

/** Free space legitimately reads 0; a total never does. Absent is null. */
function nonNegative(value) {
  // Number(null) is 0 and Number("") is 0, which would turn "nobody measured
  // this" into "the card is full" - the exact lie this module exists to avoid.
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function nearestExistingDir(target) {
  let dir = resolve(target);
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * Everything this machine will say about itself, in one stable shape.
 *
 * @param {{ modelsDir?: string|null, runner?: Function }} [options]
 *   `modelsDir` is the folder the models live in (the drive whose free space
 *   matters). `runner` is injectable so the unknown-field rule can be tested
 *   without unplugging a GPU.
 */
export function probeHardware(options = {}) {
  const { modelsDir = null, runner = runTool } = options;
  const platform = process.platform;
  const onWindows = platform === "win32";
  const notes = [];

  // --- CPU: os.cpus() is the model and the logical count, always -----------
  const cpus = os.cpus() ?? [];
  const cpu = {
    model: text(cpus[0]?.model),
    physicalCores: null,
    logicalCores: cpus.length > 0 ? cpus.length : null,
    source: "os.cpus()",
  };

  // --- RAM: os.totalmem/os.freemem, plus Windows' own total ----------------
  const ram = {
    totalBytes: positive(os.totalmem()),
    freeBytes: nonNegative(os.freemem()),
    windowsTotalBytes: null,
    source: "os.totalmem() / os.freemem()",
  };

  // --- GPU: nvidia-smi first; CIM only when it has nothing to say ----------
  const gpu = {
    name: null,
    vendor: null,
    vramTotalBytes: null,
    vramFreeBytes: null,
    driverVersion: null,
    source: null,
    adapterCount: null,
    laptop: false,
    otherAdapters: [],
  };

  let adapters = [];
  if (onWindows) {
    const sys = queryWindowsSystem(runner);
    if (sys.ok) {
      cpu.physicalCores = sys.cpuCores;
      cpu.source = `os.cpus() + Win32_Processor (${sys.cpuCores ?? "?"} physical cores)`;
      ram.windowsTotalBytes = sys.ramTotalBytes;
      if (ram.windowsTotalBytes !== null && ram.totalBytes !== null && Math.abs(ram.windowsTotalBytes - ram.totalBytes) > GIB / 100) {
        notes.push(
          `os.totalmem() says ${(ram.totalBytes / GIB).toFixed(2)} GiB and Win32_ComputerSystem says ` +
            `${(ram.windowsTotalBytes / GIB).toFixed(2)} GiB; the Windows figure is the physical total, os.totalmem() is what the OS makes available`,
        );
      }
      adapters = sys.adapters;
    } else {
      notes.push(`Win32 query failed (${sys.error}) - physical cores, the Windows RAM total and any non-NVIDIA GPU name are unknown`);
    }
  } else {
    notes.push("physical core count is only read on Windows (node:os does not expose it) - unknown here");
  }

  const smi = queryNvidiaSmi(runner);
  if (smi.rows.length) {
    const [card] = smi.rows;
    gpu.name = card.name;
    gpu.vendor = vendorOf(card.name);
    gpu.vramTotalBytes = card.vramTotalBytes;
    gpu.vramFreeBytes = card.vramFreeBytes;
    gpu.driverVersion = card.driverVersion;
    gpu.source = smi.rows.length === 1 ? "nvidia-smi" : `nvidia-smi, ${smi.rows.length} GPUs reported`;
    gpu.adapterCount = smi.rows.length;
    // A laptop dGPU is a real card with a real VRAM total; what differs is that
    // Windows may drive the panel from the iGPU and reserve VRAM for the desktop.
    // The driver's free figure is still the best number available, so it is used
    // as-is and said out loud rather than adjusted by a guess.
    gpu.laptop = /laptop|mobile|max-q/i.test(card.name);
    if (gpu.laptop) notes.push("laptop dGPU: free VRAM is the driver's figure; Windows can reserve part of it for the desktop");
  } else if (onWindows && adapters.length) {
    // No NVIDIA driver answered. Win32_VideoController knows the name; it does
    // NOT know the VRAM: AdapterRAM is a uint32 and saturates at 4 GiB on every
    // card bigger than that, so reporting it would be a wrong number, not a
    // rough one. Name only, VRAM unknown.
    const first = adapters.find((a) => vendorOf(a.name) !== "intel") ?? adapters[0];
    gpu.name = first.name;
    gpu.vendor = vendorOf(first.name);
    gpu.driverVersion = first.driver;
    gpu.source = "Win32_VideoController (name and driver only; no VRAM)";
    gpu.adapterCount = adapters.length;
    notes.push(`nvidia-smi did not answer (${smi.error ?? "not found"}) - the GPU name is from Win32_VideoController and VRAM is unknown`);
  } else if (onWindows) {
    notes.push(`nvidia-smi did not answer (${smi.error ?? "not found"}) and Win32_VideoController named no adapter - GPU is unknown`);
  } else {
    notes.push(`nvidia-smi did not answer (${smi.error ?? "not found"}) - GPU is unknown on this platform`);
  }

  if (onWindows && adapters.length) {
    const chosen = (gpu.name ?? "").toLowerCase();
    gpu.otherAdapters = adapters.map((a) => a.name).filter((name) => name.toLowerCase() !== chosen);
  }

  // --- Disk: the drive that holds the models, not "the system drive" ------
  const disk = { modelsDir: modelsDir ? resolve(modelsDir) : null, drive: null, freeBytes: null, totalBytes: null };
  if (disk.modelsDir) {
    const base = nearestExistingDir(disk.modelsDir);
    if (!base) {
      notes.push(`models directory ${disk.modelsDir} does not exist and neither does any parent - disk free space is unknown`);
    } else {
      try {
        const stats = statfsSync(base);
        disk.freeBytes = nonNegative(stats.bavail * stats.bsize);
        disk.totalBytes = positive(stats.blocks * stats.bsize);
        disk.drive = parse(base).root || null;
      } catch (err) {
        notes.push(`statfs on ${base} failed (${err?.code ?? err?.message ?? err}) - disk free space is unknown`);
      }
    }
  }

  const hardware = {
    at: new Date().toISOString(),
    platform,
    arch: process.arch,
    hostname: os.hostname() ?? null,
    cpu,
    ram,
    gpu,
    disk,
    notes,
    unknown: [],
  };
  hardware.unknown = collectUnknown(hardware);
  return hardware;
}

/**
 * Every leaf that is still null, as a dotted path. Built from the object rather
 * than tracked by hand, so "the field is null" and "the field is listed as
 * unknown" cannot drift apart: the invariant `unknown` <=> `null` is structural.
 */
function collectUnknown(hardware) {
  const leaves = [
    ["cpu.model", hardware.cpu.model],
    ["cpu.physicalCores", hardware.cpu.physicalCores],
    ["cpu.logicalCores", hardware.cpu.logicalCores],
    ["ram.totalBytes", hardware.ram.totalBytes],
    ["ram.freeBytes", hardware.ram.freeBytes],
    ["ram.windowsTotalBytes", hardware.ram.windowsTotalBytes],
    ["gpu.name", hardware.gpu.name],
    ["gpu.vendor", hardware.gpu.vendor],
    ["gpu.vramTotalBytes", hardware.gpu.vramTotalBytes],
    ["gpu.vramFreeBytes", hardware.gpu.vramFreeBytes],
    ["gpu.driverVersion", hardware.gpu.driverVersion],
    ["disk.freeBytes", hardware.disk.freeBytes],
    ["disk.totalBytes", hardware.disk.totalBytes],
  ];
  return leaves.filter(([, value]) => value === null).map(([path]) => path);
}

// ---------------------------------------------------------------------------
// The fit arithmetic
// ---------------------------------------------------------------------------

/**
 * Effective bits per weight, measured off real GGUF files rather than assumed
 * from the block name (k-quants carry scales and minimums on top of the weights).
 *
 * Cross-checked against the files this catalog points at:
 *   Qwen3-32B  32.76B  Q4_K_M 19.76 GB -> 4.82 bits/weight   (table 4.8)
 *   Qwen3-32B  32.76B  Q5_K_M 23.21 GB -> 5.67               (table 5.6)
 *   Qwen3-32B  32.76B  Q6_K   26.88 GB -> 6.56               (table 6.6)
 *   Qwen3-32B  32.76B  Q8_0   34.82 GB -> 8.50               (table 8.5)
 * Q5 is the one row that is fractionally optimistic; it is kept at the documented
 * 5.6 because the catalog carries measured file sizes and this table is the
 * fallback for a file whose size is not known.
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

/**
 * Bits per weight for a quant label, including the labels publishers invent.
 *
 * "UD-Q4_K_M" (Unsloth dynamic), "i1-Q4_K_S" (imatrix) and "Q4_K_P" are all
 * 4-bit k-quants whose exact size is in the file, and when the catalog gives a
 * file size the bits only decide the KV-independent fallback. So the label is
 * read down to its base shape rather than refused: exact match, then strip the
 * publisher prefix, then strip a trailing size letter, then the leading `Qn`.
 * Returns null for a label with no bit width at all, and never guesses "Q4" for
 * something that says nothing.
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
 * Runtime overhead that is not weights and not KV cache.
 *
 * RULE OF THUMB, not measured per model here: llama.cpp's CUDA backend reports
 * roughly 0.15-0.3 GiB for context init and 0.2-0.4 GiB for the compute buffer
 * at its default batch on a 27-32B model, so 0.5 GiB is the floor, rounded up.
 * It errs toward "does not fit", which is the safe direction.
 */
export const RUNTIME_OVERHEAD_BYTES = Math.round(0.5 * GIB);

/**
 * KV cache when the catalog does not say how wide the cache is.
 *
 * RULE OF THUMB: 8 KiB per billion parameters per token. The GQA models in
 * `data/model-catalog.json` actually span 3.3 KiB/B (Qwen3-30B-A3B: 48 layers x
 * 512) to 16 KiB/B (Qwen3-8B: 36 layers x 1024), so 8 KiB is mid-range and
 * deliberately conservative for the small dense models. Every catalog entry has
 * real `layers` and `kvDim`, so this only applies to a caller that does not.
 */
export const KV_FALLBACK_BYTES_PER_TOKEN_PER_BILLION = 8192;

/** f16 is llama.cpp's default KV type; `--cache-type-k q8_0` halves it, which this does not model. */
export const KV_BYTES_PER_ELEMENT = 2;

/**
 * Bytes a model needs resident: weights + KV cache + anything it must load
 * alongside (a vision projector) + runtime overhead.
 *
 *   weights = fileGb * 1e9                 when the file size is known (catalog)
 *           = params * 1e9 * bits / 8      otherwise
 *   kv      = 2 * layers * context * kvDim * 2      (K and V, f16)
 *   extra   = extraGb * 1e9                (mmproj projector, if any)
 *   need    = weights + kv + extra + overhead
 *
 * Throws only for a spec that cannot be computed (no context, an unknown quant
 * label with no explicit bits). An environment that cannot be measured is not
 * in this function's scope - that is `probeHardware`'s `null`.
 *
 * @param {{ fileGb?: number|null, params?: number|null, quant?: string|null,
 *   bitsPerWeight?: number|null, context: number, layers?: number|null,
 *   kvDim?: number|null, kvBytesPerElement?: number, extraGb?: number|null,
 *   overheadBytes?: number }} spec
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
 * The verdict, as three words a table can print:
 *
 *   fits    - needBytes <= free VRAM: it loads fully on the card. Boundary
 *             counts: need === free is a fit with zero spare, not a miss.
 *   tight   - does not fit VRAM, but fits free RAM: it runs with CPU/partial
 *             offload at a few tokens a second.
 *   tooBig  - fits neither.
 *   unknown - neither free figure could be measured; saying "fits" here would
 *             be a guess.
 *
 * @param {{ needBytes: number, gpuFreeBytes?: number|null, ramFreeBytes?: number|null }} input
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
