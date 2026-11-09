import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog } from "../src/catalog.mjs";
import { GIB } from "../src/hardware.mjs";
import {
  createStarterInstaller,
  downloadVerified,
  findInstalledStarter,
  loadRuntime,
  pickStarter,
  runtimeKey,
  starterEntries,
} from "../src/starter-model.mjs";

const catalog = loadCatalog();
const machine = ({ vram = null, ram = 16, name = null, vendor = null, platform = "win32", arch = "x64" } = {}) => ({
  platform,
  arch,
  gpu: { name, vendor, vramTotalBytes: vram === null ? null : vram * GIB },
  ram: { totalBytes: ram * GIB, windowsTotalBytes: null },
});
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const body = (buf, status = 200) => new Response(buf, { status });

test("the starters are Llama 3.1 8B then Llama 3.2 3B, each pinned by size and sha256", () => {
  const starters = starterEntries(catalog);
  assert.deepEqual(starters.map((e) => e.id), ["llama-3.1-8b", "llama-3.2-3b"]);
  for (const entry of starters) {
    const q = entry.quants[0];
    assert.equal(q.quant, "Q4_K_M");
    assert.match(q.sha256, /^[0-9a-f]{64}$/);
    assert.ok(q.bytes > 1e9);
    assert.match(q.url, /^https:\/\/huggingface\.co\/bartowski\/.+\/resolve\/main\/.+\.gguf$/);
  }
});

test("a real GPU or 16 GB of RAM gets the 8B; 8 GB of RAM gets the 3B; 4 GB gets nothing", () => {
  const gpu = pickStarter({ hardware: machine({ vram: 24, ram: 32, name: "NVIDIA GeForce RTX 3090", vendor: "nvidia" }), catalog });
  assert.equal(gpu.entry.id, "llama-3.1-8b");
  assert.match(gpu.reason, /RTX 3090 has 24 GB of video memory/);

  const cpu16 = pickStarter({ hardware: machine({ ram: 15.8 }), catalog });
  assert.equal(cpu16.entry.id, "llama-3.1-8b");
  assert.match(cpu16.reason, /runs on the processor/);

  const small = pickStarter({ hardware: machine({ ram: 7.8 }), catalog });
  assert.equal(small.entry.id, "llama-3.2-3b");
  assert.equal(small.file.fileName, "Llama-3.2-3B-Instruct-Q4_K_M.gguf");

  const tiny = pickStarter({ hardware: machine({ ram: 4 }), catalog });
  assert.equal(tiny.entry, null);
  assert.match(tiny.reason, /cloud models still work/);
});

test("the runner is Vulkan for a discrete card, CPU otherwise, Metal on a Mac", () => {
  assert.equal(runtimeKey({ platform: "win32", arch: "x64", gpu: { vendor: "nvidia", name: "RTX 3060" } }), "win32-x64-vulkan");
  assert.equal(runtimeKey({ platform: "win32", arch: "x64", gpu: { vendor: "intel", name: "Intel UHD 620" } }), "win32-x64-cpu");
  assert.equal(runtimeKey({ platform: "win32", arch: "x64", gpu: { vendor: "intel", name: "Intel Arc A770" } }), "win32-x64-vulkan");
  assert.equal(runtimeKey({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(runtimeKey({ platform: "win32", arch: "arm64" }), null);
  const runtime = loadRuntime();
  for (const key of ["win32-x64-cpu", "win32-x64-vulkan", "darwin-arm64", "darwin-x64", "linux-x64-cpu", "linux-x64-vulkan"]) {
    assert.match(runtime.assets[key].sha256, /^[0-9a-f]{64}$/, key);
    assert.match(runtime.assets[key].url, new RegExp(`/releases/download/${runtime.tag}/`), key);
  }
});

test("a download with the wrong checksum is deleted, never installed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starter-"));
  const data = Buffer.from("not the model you are looking for");
  const dest = join(dir, "m.gguf");
  await assert.rejects(
    downloadVerified({ url: "https://x/m.gguf", dest, bytes: data.length, sha256: "0".repeat(64), fetchImpl: async () => body(data) }),
    /checksum did not match/,
  );
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(`${dest}.part`), false);
});

test("an interrupted download resumes with a Range request and still verifies the whole file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starter-"));
  const data = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
  const dest = join(dir, "m.gguf");
  writeFileSync(`${dest}.part`, data.subarray(0, 10));
  let range = null;
  const fetchImpl = async (_url, init) => {
    range = init.headers.range;
    return body(data.subarray(10), 206);
  };
  const seen = [];
  await downloadVerified({ url: "https://x/m.gguf", dest, bytes: data.length, sha256: sha(data), fetchImpl, onProgress: (r) => seen.push(r) });
  assert.equal(range, "bytes=10-");
  assert.deepEqual(readFileSync(dest), data);
  assert.equal(seen.at(-1), data.length);
});

test("the installer fetches the runner only when the PC has none, then the model, and remembers it", async () => {
  const home = mkdtempSync(join(tmpdir(), "starter-home-"));
  const model = Buffer.from("gguf-bytes");
  const zip = Buffer.from("zip-bytes");
  const runtime = { tag: "t", assets: { "win32-x64-cpu": { name: "llama.zip", url: "https://gh/llama.zip", bytes: zip.length, sha256: sha(zip) } } };
  const pick = {
    entry: { id: "llama-3.2-3b", name: "Llama-3.2-3B-Instruct" },
    file: { url: "https://hf/Llama-3.2-3B-Instruct-Q4_K_M.gguf", bytes: model.length, sha256: sha(model), fileName: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" },
  };
  const urls = [];
  const fetchImpl = async (url) => (urls.push(url), body(url.endsWith(".zip") ? zip : model));
  // A fake unpack that lays out what the real zip holds: the server one folder down.
  const extract = async (_archive, dest) => {
    mkdirSync(join(dest, "bin"), { recursive: true });
    writeFileSync(join(dest, "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server"), "exe");
  };
  const installer = createStarterInstaller({ home, runtime, fetchImpl, extract, hasServer: () => false });
  assert.equal(installer.start({ pick, runtimeKeyName: "win32-x64-cpu" }).ok, true);
  assert.equal(installer.start({ pick, runtimeKeyName: "win32-x64-cpu" }).code, "busy", "one job at a time");
  for (let i = 0; i < 100 && !["done", "failed"].includes(installer.job().phase); i++) await new Promise((r) => setTimeout(r, 10));
  const job = installer.job();
  assert.equal(job.phase, "done", job.error ?? "");
  assert.deepEqual(urls, ["https://gh/llama.zip", pick.file.url]);
  assert.ok(existsSync(join(home, "llama.cpp", process.platform === "win32" ? "llama-server.exe" : "llama-server")));
  assert.deepEqual(readFileSync(join(home, "models", pick.file.fileName)), model);
  assert.equal(installer.saved().installed.id, "llama-3.2-3b");
  assert.equal(existsSync(join(home, "downloads", "llama.zip")), false, "the archive is cleaned up");

  // And the shelf can find it by name.
  const found = findInstalledStarter({ catalog, dirs: [join(home, "models")] });
  assert.equal(found.id, "llama-3.2-3b");
});

test("with llama.cpp already on the PC only the model is downloaded; Not now is remembered", async () => {
  const home = mkdtempSync(join(tmpdir(), "starter-home-"));
  const model = Buffer.from("gguf");
  const pick = { entry: { id: "x", name: "X" }, file: { url: "https://hf/x.gguf", bytes: model.length, sha256: sha(model), fileName: "x.gguf" } };
  const urls = [];
  const installer = createStarterInstaller({ home, runtime: { assets: {} }, fetchImpl: async (u) => (urls.push(u), body(model)), hasServer: () => true });
  installer.start({ pick, runtimeKeyName: "win32-x64-cpu" });
  for (let i = 0; i < 100 && installer.job().phase !== "done"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(installer.job().phase, "done");
  assert.deepEqual(urls, ["https://hf/x.gguf"]);
  installer.dismiss();
  assert.ok(createStarterInstaller({ home }).saved().dismissedAt);
});
