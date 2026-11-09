/**
 * Two things are checked here that a plausible-looking table cannot show:
 *
 *   1. the fit arithmetic is the arithmetic claimed - weights, KV cache and
 *      overhead are added by hand and compared to the function's answer, and the
 *      boundary case (need === free) is a fit with zero spare, not a miss;
 *   2. an unmeasurable field is `null` and appears in `unknown`, never `0` -
 *      "nothing is free" and "nobody asked the driver" are different answers and
 *      the difference is what stops a table from inventing a fit.
 *
 * Nothing here needs a GPU: the tool runner is injectable, so a machine with no
 * nvidia-smi is a function returning `{ ok: false }`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GIB,
  MIB,
  bitsPerWeightFor,
  estimateModelNeeds,
  fitScore,
  parseNvidiaSmi,
  probeHardware,
} from "../src/hardware.mjs";

const get = (object, path) => path.split(".").reduce((value, key) => (value === null || value === undefined ? null : value[key]), object);

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test("a 10B model at Q4_K_M with a known architecture adds up by hand", () => {
  const need = estimateModelNeeds({ params: 10, quant: "Q4_K_M", context: 4096, layers: 32, kvDim: 1024 });
  // 10e9 weights * 4.8 bits / 8 = 6e9 bytes
  assert.equal(need.weightsBytes, 6_000_000_000);
  // 2 (K and V) * 32 layers * 4096 tokens * 1024 kvDim * 2 bytes = 2^29
  assert.equal(need.kvCacheBytes, 536_870_912);
  // the documented 0.5 GiB overhead is also 2^29 here, so the non-weight part is
  // exactly 1 GiB - which is why the total below is a round number plus 2^30.
  assert.equal(need.overheadBytes, 536_870_912);
  assert.equal(need.totalBytes, 6_000_000_000 + 1_073_741_824);
  assert.equal(need.bitsPerWeight, 4.8);
  assert.deepEqual(need.basis, { weights: "params", kv: "architecture" });
});

test("a measured file size wins over params x bits, because the file is the fact", () => {
  const need = estimateModelNeeds({ fileGb: 19.76, params: 32.76, quant: "Q4_K_M", context: 8192, layers: 64, kvDim: 1024 });
  assert.equal(need.weightsBytes, 19_760_000_000);
  assert.equal(need.basis.weights, "file");
  // 2 * 64 * 8192 * 1024 * 2 = 2 GiB of KV at 8k on a 64-layer model with a 1024-wide cache
  assert.equal(need.kvCacheBytes, 2 * GIB);
});

test("without layers and kvDim the KV cache falls back to a rule of thumb and says so", () => {
  const need = estimateModelNeeds({ params: 10, quant: "Q8_0", context: 8192 });
  assert.equal(need.basis.kv, "rule of thumb (8 KiB per billion params per token)");
  assert.equal(need.kvCacheBytes, 10 * 8192 * 8192);
  assert.equal(need.basis.weights, "params");
});

test("a vision projector is counted, because it is resident too", () => {
  const without = estimateModelNeeds({ fileGb: 5.03, quant: "Q4_K_M", context: 32768, layers: 36, kvDim: 1024 });
  const withProjector = estimateModelNeeds({ fileGb: 5.03, quant: "Q4_K_M", context: 32768, layers: 36, kvDim: 1024, extraGb: 0.75 });
  assert.equal(withProjector.extraBytes, 750_000_000);
  assert.equal(withProjector.totalBytes - without.totalBytes, 750_000_000);
});

test("publisher quant labels resolve to their base width instead of being refused", () => {
  assert.equal(bitsPerWeightFor("UD-Q4_K_M"), 4.8);
  assert.equal(bitsPerWeightFor("i1-Q4_K_S"), 4.6);
  assert.equal(bitsPerWeightFor("Q4_K_P"), 4.8);
  assert.equal(bitsPerWeightFor("q8_0"), 8.5);
  assert.equal(bitsPerWeightFor("Q9_Z"), null);
});

test("an unrecognised quant with no explicit bits is refused, not guessed", () => {
  assert.throws(() => estimateModelNeeds({ params: 7, quant: "Q9_Z", context: 4096 }), TypeError);
  // but an explicit bit width is always allowed
  assert.equal(estimateModelNeeds({ params: 7, bitsPerWeight: 4, context: 4096 }).weightsBytes, 3_500_000_000);
});

test("a context size is required: the KV cache cannot be defaulted", () => {
  assert.throws(() => estimateModelNeeds({ fileGb: 5, quant: "Q4_K_M" }), TypeError);
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test("need equal to free VRAM is a fit with zero spare, one byte more is not", () => {
  const exact = fitScore({ needBytes: 21 * GIB, gpuFreeBytes: 21 * GIB, ramFreeBytes: 0 });
  assert.equal(exact.verdict, "fits");
  assert.equal(exact.headroomBytes, 0);
  // One byte over the line falls back to RAM, which is what the machine would do.
  const over = fitScore({ needBytes: 21 * GIB + 1, gpuFreeBytes: 21 * GIB, ramFreeBytes: 64 * GIB });
  assert.equal(over.verdict, "tight");
  assert.equal(over.device, "ram");
});

test("something that fits neither card nor RAM is too big, with the shortfall reported", () => {
  const score = fitScore({ needBytes: 42 * GIB, gpuFreeBytes: 24 * GIB, ramFreeBytes: 32 * GIB });
  assert.equal(score.verdict, "tooBig");
  assert.equal(score.device, null);
  assert.equal(score.gpuHeadroomBytes, -18 * GIB);
  assert.equal(score.ramHeadroomBytes, -10 * GIB);
  // No device means no single headroom figure: null, not a negative.
  assert.equal(score.headroomBytes, null);
});

test("a card with 0 bytes free is a reading, not an unknown", () => {
  const score = fitScore({ needBytes: 5 * GIB, gpuFreeBytes: 0, ramFreeBytes: null });
  assert.equal(score.verdict, "tooBig");
  assert.equal(score.gpuHeadroomBytes, -5 * GIB);
});

test("no measurable memory is 'unknown', not 'too big'", () => {
  const score = fitScore({ needBytes: GIB, gpuFreeBytes: null, ramFreeBytes: null });
  assert.equal(score.verdict, "unknown");
  assert.equal(score.device, null);
  assert.equal(score.headroomBytes, null);
});

test("fitScore refuses a need it cannot use", () => {
  assert.throws(() => fitScore({ needBytes: 0 }), TypeError);
  assert.throws(() => fitScore({ needBytes: Number.NaN }), TypeError);
});

// ---------------------------------------------------------------------------
// nvidia-smi
// ---------------------------------------------------------------------------

test("nvidia-smi rows become bytes, MiB by MiB", () => {
  const rows = parseNvidiaSmi("NVIDIA GeForce RTX 3090, 24576, 23472, 617.42\n");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "NVIDIA GeForce RTX 3090");
  assert.equal(rows[0].vramTotalBytes, 24576 * MIB);
  assert.equal(rows[0].vramFreeBytes, 23472 * MIB);
  assert.equal(rows[0].driverVersion, "617.42");
});

test("a driver that prints [N/A] for free VRAM leaves that field unknown", () => {
  const [row] = parseNvidiaSmi("NVIDIA GeForce RTX 3090, 24576, [N/A], 617.42");
  assert.equal(row.vramTotalBytes, 24576 * MIB);
  assert.equal(row.vramFreeBytes, null);
});

test("output that is not a card row produces no card", () => {
  assert.deepEqual(parseNvidiaSmi(""), []);
  assert.deepEqual(parseNvidiaSmi("[N/A]\n"), []);
});

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

const noTools = () => ({ ok: false, error: "ENOENT" });

test("a machine with no tools reports null and lists every field it could not measure", () => {
  const hardware = probeHardware({ modelsDir: null, runner: noTools });
  for (const path of ["gpu.name", "gpu.vendor", "gpu.vramTotalBytes", "gpu.vramFreeBytes", "gpu.driverVersion", "cpu.physicalCores"]) {
    assert.equal(get(hardware, path), null, `${path} must be null, not 0`);
  }
  for (const path of ["gpu.name", "gpu.vramTotalBytes", "gpu.vramFreeBytes", "cpu.physicalCores", "disk.freeBytes"]) {
    assert.ok(hardware.unknown.includes(path), `${path} must be listed as unknown`);
  }
  // The reasons are in the notes, where a person will read them.
  assert.ok(hardware.notes.length > 0);
  assert.ok(hardware.notes.some((note) => /nvidia-smi did not answer/.test(note)));
});

test("the unknown list is exactly the null leaves", () => {
  const hardware = probeHardware({ modelsDir: null, runner: noTools });
  for (const path of hardware.unknown) assert.equal(get(hardware, path), null, `${path} is listed but is not null`);
  assert.equal(hardware.unknown.length, new Set(hardware.unknown).size);
});

test("a card that answers is read from nvidia-smi, laptop or not", () => {
  const laptopOnly = (exe) =>
    String(exe).toLowerCase().includes("powershell")
      ? { ok: false, error: "skipped for the test" }
      : { ok: true, stdout: "NVIDIA GeForce RTX 4090 Laptop GPU, 16376, 15500, 566.36\n" };
  const hardware = probeHardware({ modelsDir: null, runner: laptopOnly });
  assert.equal(hardware.gpu.name, "NVIDIA GeForce RTX 4090 Laptop GPU");
  assert.equal(hardware.gpu.vendor, "nvidia");
  assert.equal(hardware.gpu.vramTotalBytes, 16376 * MIB);
  assert.equal(hardware.gpu.vramFreeBytes, 15500 * MIB);
  assert.equal(hardware.gpu.laptop, true);
  assert.ok(hardware.notes.some((note) => /laptop dGPU/.test(note)));
  // Detection is not a guess about the machine: the flag exists so the table can
  // say "the driver's figure, Windows may reserve part of it" out loud.
  assert.equal(hardware.unknown.includes("gpu.vramTotalBytes"), false);
});

test("a desktop card is not flagged as a laptop", () => {
  const desktop = (exe) =>
    String(exe).toLowerCase().includes("powershell") ? { ok: false, error: "skipped" } : { ok: true, stdout: "NVIDIA GeForce RTX 3090, 24576, 855, 617.42\n" };
  assert.equal(probeHardware({ modelsDir: null, runner: desktop }).gpu.laptop, false);
});

test("with no nvidia-smi the card is named from Win32 and its VRAM stays unknown", { skip: process.platform !== "win32" }, () => {
  const cimOnly = (exe) => {
    if (!String(exe).toLowerCase().includes("powershell")) return { ok: false, error: "ENOENT" };
    return {
      ok: true,
      stdout: JSON.stringify({
        cpuName: "AMD Ryzen 9 7950X 16-Core Processor",
        cpuCores: 16,
        cpuLogical: 32,
        ramTotalBytes: 68719476736,
        // PowerShell 5.1 sends a one-element array as a bare object; the probe
        // has to normalise it or the adapter is invisible.
        adapters: { name: "AMD Radeon RX 7900 XTX", driver: "31.0.24027.1012" },
      }),
    };
  };
  const hardware = probeHardware({ modelsDir: null, runner: cimOnly });
  assert.equal(hardware.gpu.name, "AMD Radeon RX 7900 XTX");
  assert.equal(hardware.gpu.vendor, "amd");
  assert.equal(hardware.gpu.vramTotalBytes, null);
  assert.ok(hardware.unknown.includes("gpu.vramTotalBytes"));
  // AdapterRAM is a saturated uint32, so a 24 GB card would read as 4 GB. The
  // probe refuses that number instead of passing it on.
  assert.equal(hardware.gpu.vramFreeBytes, null);
  assert.equal(hardware.cpu.physicalCores, 16);
  assert.equal(hardware.ram.windowsTotalBytes, 68719476736);
});

test("a Windows machine that answers everything has no unknowns", { skip: process.platform !== "win32" }, () => {
  const cim = (exe) => {
    if (!String(exe).toLowerCase().includes("powershell")) return { ok: true, stdout: "NVIDIA GeForce RTX 3090, 24576, 20000, 617.42\n" };
    return {
      ok: true,
      stdout:
        "\uFEFF" +
        JSON.stringify({
          cpuName: "Intel(R) Core(TM) i5-8600K CPU @ 3.60GHz",
          cpuCores: 6,
          cpuLogical: 6,
          ramTotalBytes: 34207887360,
          adapters: [
            { name: "NVIDIA GeForce RTX 3090", driver: "32.0.16.1742" },
            { name: "Intel(R) UHD Graphics 630", driver: "31.0.101.2141" },
          ],
        }),
    };
  };
  const hardware = probeHardware({ modelsDir: tmpdir(), runner: cim });
  assert.deepEqual(hardware.unknown, []);
  assert.equal(hardware.cpu.physicalCores, 6);
  // The iGPU is reported, not silently folded into the dGPU's VRAM.
  assert.deepEqual(hardware.gpu.otherAdapters, ["Intel(R) UHD Graphics 630"]);
  assert.ok(hardware.disk.freeBytes > 0);
});
