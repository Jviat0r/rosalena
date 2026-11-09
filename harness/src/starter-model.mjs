/**
 * The starter model: one free local model, picked for this PC and installed on request.
 *
 * A fresh install has cloud models only, and a person who has never set up llama.cpp
 * will not go and find a GGUF. So the app measures the machine, names ONE model it will
 * run well (catalog entries carrying `starter`), says why, and on a yes downloads the
 * llama.cpp runner (only when this PC has no llama-server of its own) and the model,
 * checks both against a pinned sha256, and puts them where the local shelf already looks:
 *
 *   ~/.rosalena/llama.cpp/   llama-server and its libraries   (src/local-paths.mjs scans it)
 *   ~/.rosalena/models/      the GGUF                          (likewise)
 *
 * From there the existing machinery takes over: the GGUF shows up in the picker as
 * local/<alias>, and choosing it starts llama-server through local-model-host. Nothing
 * here starts a model.
 *
 * Downloads resume: a `.part` file is hashed as far as it goes and the rest is asked for
 * with a Range request, because a 5 GB file on a home connection is often interrupted.
 * A file whose size or sha256 is wrong is deleted, never installed.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GIB } from "./hardware.mjs";
import { detectServerBinary, resetLocalPathCache } from "./local-paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_PATH = resolve(HERE, "..", "data", "llama-runtime.json");

/** Where the starter installs. Fixed under the user's home, not ROSALENA_HOME, so the shelf finds it from every surface. */
export const starterHome = () => join(homedir(), ".rosalena");

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const gib = (bytes) => Math.round(bytes / GIB);

export function loadRuntime(path = RUNTIME_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Which llama.cpp build fits this machine. Vulkan for a discrete NVIDIA/AMD card or an
 * Intel Arc (one build for every vendor, and it still runs on the CPU when no device
 * answers); the plain CPU build otherwise, because an integrated GPU is rarely faster.
 */
export function runtimeKey({ platform = process.platform, arch = process.arch, gpu = null } = {}) {
  const usable = gpu && (gpu.vendor === "nvidia" || gpu.vendor === "amd" || /\barc\b/i.test(gpu.name ?? ""));
  if (platform === "win32" && arch === "x64") return usable ? "win32-x64-vulkan" : "win32-x64-cpu";
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "linux" && arch === "x64") return usable ? "linux-x64-vulkan" : "linux-x64-cpu";
  return null;
}

/** "Llama-3.1-8B-Instruct" -> "Llama 3.1 8B": the name a person reads, not the file's. */
export const displayName = (name) => String(name ?? "").replace(/-Instruct$/i, "").replace(/-/g, " ");

/** The catalog's starter entries, best first. */
export function starterEntries(catalog) {
  const models = Array.isArray(catalog) ? catalog : catalog?.models ?? [];
  return models.filter((entry) => entry?.starter && entry.quants?.[0]?.url).sort((a, b) => a.starter.rank - b.starter.rank);
}

/** The file a starter installs: its first quant, with the name the URL ends in. */
export function starterFile(entry) {
  const quant = entry.quants[0];
  return { ...quant, fileName: decodeURIComponent(basename(new URL(quant.url).pathname)) };
}

/**
 * The one model to offer, and the sentence that says why - or `entry: null` with the reason
 * nothing is offered. Judged on TOTAL memory, not free: this is "what this PC can run", asked
 * once, not "what fits right now next to whatever else is open".
 */
export function pickStarter({ hardware, catalog }) {
  const starters = starterEntries(catalog);
  const gpu = hardware?.gpu ?? {};
  const vram = gpu.vramTotalBytes ?? null;
  const ram = hardware?.ram?.windowsTotalBytes ?? hardware?.ram?.totalBytes ?? null;
  const appleSilicon = hardware?.platform === "darwin" && hardware?.arch === "arm64";
  for (const entry of starters) {
    const { minVramGiB = Infinity, minRamGiB = Infinity } = entry.starter;
    const onGpu = vram !== null && vram >= minVramGiB * GIB;
    const onRam = ram !== null && ram >= minRamGiB * GIB;
    if (!onGpu && !onRam) continue;
    const file = starterFile(entry);
    const name = displayName(entry.name);
    let reason;
    if (onGpu) reason = `Your ${gpu.name ?? "graphics card"} has ${gib(vram)} GB of video memory, so ${name} runs fully on the card and answers quickly.`;
    else if (appleSilicon) reason = `This Mac has ${gib(ram)} GB of unified memory, so ${name} runs on its GPU comfortably.`;
    else if (entry.starter.rank === 1) reason = `You have ${gib(ram)} GB of RAM, so ${name} runs on the processor. Expect a few words a second; it is still good for basic coding and math.`;
    else reason = `With ${gib(ram)} GB of RAM, ${name} is the model this PC runs comfortably, and it is still fine for short coding and math questions.`;
    return { entry, file, reason };
  }
  const have = ram ? `${gib(ram)} GB of RAM` : "an amount of memory that could not be measured";
  return { entry: null, file: null, reason: `This PC has ${have}, which is less than the smallest local model needs. The cloud models still work.` };
}

/** A starter GGUF that is already in one of the model folders, or null. */
export function findInstalledStarter({ catalog, dirs }) {
  for (const entry of starterEntries(catalog)) {
    for (const quant of entry.quants) {
      const name = decodeURIComponent(basename(new URL(quant.url).pathname)).toLowerCase();
      for (const dir of dirs) {
        let files = [];
        try {
          files = readdirSync(dir);
        } catch {
          continue;
        }
        const hit = files.find((file) => file.toLowerCase() === name);
        if (hit) return { id: entry.id, name: entry.name, path: join(dir, hit) };
      }
    }
  }
  return null;
}

/** Free bytes on the drive that will hold `path` (or its nearest existing parent), or null. */
export function freeBytesAt(path) {
  let dir = resolve(path);
  for (let i = 0; i < 40 && !existsSync(dir); i += 1) dir = dirname(dir);
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.code = "cancelled";
  }
}

/**
 * Fetch `url` into `dest`, resuming a `.part`, and refuse anything whose size or sha256 is
 * not the pinned one. `onProgress(received, total)` is called as bytes arrive.
 */
export async function downloadVerified({ url, dest, bytes, sha256, fetchImpl = fetch, signal, onProgress = () => {} }) {
  const part = `${dest}.part`;
  mkdirSync(dirname(dest), { recursive: true });
  const hash = createHash("sha256");
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > bytes) {
    rmSync(part, { force: true });
    have = 0;
  }
  if (have > 0) {
    for await (const chunk of createReadStream(part)) hash.update(chunk);
  }
  onProgress(have, bytes);

  let received = have;
  if (have < bytes) {
    const res = await fetchImpl(url, { headers: have ? { range: `bytes=${have}-` } : {}, redirect: "follow", signal });
    if (!res.ok) throw new Error(`${basename(dest)}: the download answered HTTP ${res.status}`);
    if (have && res.status !== 206) {
      // The server ignored the Range and is sending the whole file: start over from zero.
      await res.body?.cancel?.();
      rmSync(part, { force: true });
      return downloadVerified({ url, dest, bytes, sha256, fetchImpl, signal, onProgress });
    }
    const out = createWriteStream(part, { flags: have ? "a" : "w" });
    try {
      const reader = res.body.getReader();
      for (;;) {
        if (signal?.aborted) throw new Cancelled();
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.byteLength;
        if (!out.write(value)) await new Promise((ok) => out.once("drain", ok));
        onProgress(received, bytes);
      }
    } finally {
      await new Promise((ok) => out.end(ok));
    }
  }

  if (received !== bytes) {
    throw new Error(`${basename(dest)}: got ${received} bytes, expected ${bytes}; run the setup again to resume`);
  }
  const digest = hash.digest("hex");
  if (digest !== sha256) {
    rmSync(part, { force: true });
    throw new Error(`${basename(dest)}: the checksum did not match, so the file was deleted (got ${digest.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…)`);
  }
  renameSync(part, dest);
  return dest;
}

/** Unpack a .zip or .tar.gz with the system tar (bsdtar on Windows reads zip). */
export function extractArchive(archive, destDir) {
  mkdirSync(destDir, { recursive: true });
  const windows = process.platform === "win32";
  // System32's bsdtar, not whatever `tar` is first on PATH: Git's GNU tar cannot read a zip.
  const tar = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const args = archive.endsWith(".zip") ? ["-xf", archive, "-C", destDir] : ["-xzf", archive, "-C", destDir];
  return new Promise((ok, fail) => {
    const child = spawn(tar, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`unpacking ${basename(archive)} failed (tar exit ${code}): ${err.trim().slice(0, 200)}`))));
  });
}

/** The first file called `name` under `dir`, a few levels deep, or null. */
export function findFile(dir, name, depth = 4) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const hit = entries.find((e) => e.isFile() && e.name.toLowerCase() === name.toLowerCase());
  if (hit) return join(dir, hit.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findFile(join(dir, e.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

/** True when a llama-server that really exists is what the shelf would start. */
export function hasServerBinary(detect = detectServerBinary) {
  const binary = detect();
  try {
    return statSync(binary).isFile();
  } catch {
    return false;
  }
}

/**
 * Download, check and unpack the llama.cpp runner into `<home>/llama.cpp`. Shared by the
 * starter setup and the Models page's downloads, so both install the same verified build.
 */
export async function installLlamaRuntime({ home, key, runtime = null, fetchImpl = fetch, extract = extractArchive, signal, onProgress = () => {}, log = () => {} }) {
  const spec = (runtime ?? loadRuntime()).assets?.[key];
  if (!spec) throw new Error(`there is no llama.cpp build for this platform (${key ?? `${process.platform}-${process.arch}`})`);
  const archive = join(home, "downloads", spec.name);
  await downloadVerified({ url: spec.url, dest: archive, bytes: spec.bytes, sha256: spec.sha256, fetchImpl, signal, onProgress });
  const staging = join(home, "llama.cpp.new");
  rmSync(staging, { recursive: true, force: true });
  await extract(archive, staging);
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const binary = findFile(staging, exe);
  if (!binary) throw new Error(`${spec.name} did not contain ${exe}`);
  const target = join(home, "llama.cpp");
  rmSync(target, { recursive: true, force: true });
  renameSync(dirname(binary), target);
  rmSync(staging, { recursive: true, force: true });
  rmSync(archive, { force: true });
  if (process.platform !== "win32") {
    for (const name of readdirSync(target)) if (name.startsWith("llama-")) chmodSync(join(target, name), 0o755);
  }
  resetLocalPathCache();
  log(`llama.cpp ${key} installed in ${target}`);
  return { target, bytes: spec.bytes };
}

/**
 * The installer: status, start, cancel, dismiss. One job at a time, held in memory; the
 * only thing written outside the two install folders is `starter-model.json` (dismissed /
 * installed), so "Not now" is remembered across restarts.
 */
export function createStarterInstaller({
  home = starterHome(),
  runtime = null,
  fetchImpl = fetch,
  extract = extractArchive,
  hasServer = hasServerBinary,
  log = () => {},
} = {}) {
  const stateFile = join(home, "starter-model.json");
  let job = null;
  let controller = null;

  const readSaved = () => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) ?? {};
    } catch {
      return {};
    }
  };
  const save = (patch) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({ ...readSaved(), ...patch }, null, 2));
  };

  async function installRuntime(key) {
    const spec = (runtime ?? loadRuntime()).assets?.[key];
    job.phase = "runtime";
    job.label = spec ? `llama.cpp runner (${gb(spec.bytes)})` : "llama.cpp runner";
    await installLlamaRuntime({
      home,
      key,
      runtime,
      fetchImpl,
      extract,
      signal: controller.signal,
      onProgress: (received, total) => Object.assign(job, { received, total }),
      log: (line) => log(`starter: ${line}`),
    });
  }

  async function run({ entry, file, runtimeKeyName }) {
    try {
      if (!hasServer()) await installRuntime(runtimeKeyName);
      else job.runtime = "already on this PC";
      if (controller.signal.aborted) throw new Cancelled();
      job.phase = "model";
      job.label = `${entry.name} (${gb(file.bytes)})`;
      const dest = join(home, "models", file.fileName);
      await downloadVerified({
        url: file.url,
        dest,
        bytes: file.bytes,
        sha256: file.sha256,
        fetchImpl,
        signal: controller.signal,
        onProgress: (received, total) => Object.assign(job, { received, total }),
      });
      resetLocalPathCache();
      save({ installed: { id: entry.id, file: dest, at: new Date().toISOString() } });
      Object.assign(job, { phase: "done", path: dest, finishedAt: Date.now() });
      log(`starter: ${entry.id} installed at ${dest}`);
    } catch (err) {
      const cancelled = err?.code === "cancelled" || controller.signal.aborted;
      Object.assign(job, { phase: cancelled ? "cancelled" : "failed", error: cancelled ? null : String(err?.message ?? err), finishedAt: Date.now() });
      log(`starter: ${cancelled ? "cancelled" : `failed: ${err?.message ?? err}`}`);
    }
  }

  return {
    saved: readSaved,
    job: () => (job ? { ...job } : null),
    dismiss() {
      save({ dismissedAt: new Date().toISOString() });
    },
    cancel() {
      if (job && (job.phase === "runtime" || job.phase === "model")) controller.abort();
    },
    /** Start installing `pick` (a pickStarter result). Refuses a second job and a full disk. */
    start({ pick, runtimeKeyName }) {
      if (job && (job.phase === "runtime" || job.phase === "model")) return { ok: false, code: "busy", error: "the setup is already running" };
      if (!pick?.entry) return { ok: false, code: "no-starter", error: pick?.reason ?? "no starter model fits this PC" };
      const need = pick.file.bytes + (hasServer() ? 0 : 64e6) + 1e9;
      const free = freeBytesAt(home);
      if (free !== null && free < need) {
        return { ok: false, code: "disk", error: `the download needs about ${gb(need)} free on ${home}, and only ${gb(free)} is free` };
      }
      controller = new AbortController();
      job = { id: pick.entry.id, name: pick.entry.name, phase: "starting", received: 0, total: pick.file.bytes, error: null, startedAt: Date.now() };
      void run({ entry: pick.entry, file: pick.file, runtimeKeyName });
      return { ok: true };
    },
  };
}
