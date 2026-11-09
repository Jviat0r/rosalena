/**
 * Model downloads from the Models page: any catalog model, on request, verified.
 *
 * The starter setup (starter-model.mjs) installs ONE model whose size and sha256 are
 * pinned in the catalog. The Models page offers every chat GGUF in model-catalog.json
 * and the image, video and voice models in media-models.json, and most of those carry
 * no pinned hash. Hugging Face states both for every LFS file, in the headers of the
 * resolve URL (`x-linked-size`, `x-linked-etag`), so a download asks first, then fetches
 * with the same resumable, size-and-sha256-checked `downloadVerified` the starter uses.
 * A file that does not match is deleted, never kept.
 *
 *   chat    ~/.rosalena/models/<file>.gguf             (the local shelf lists it)
 *   image   ~/.rosalena/models/image/<folder>/<file>   (ComfyUI's subfolder names)
 *   video   ~/.rosalena/models/video/<folder>/<file>
 *   voice   ~/.rosalena/models/voice/<folder>/<file>
 *
 * A chat model also needs llama-server; when this PC has none, the same verified
 * llama.cpp build the starter installs comes first.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GIB } from "./hardware.mjs";
import { resetLocalPathCache } from "./local-paths.mjs";
import { downloadVerified, freeBytesAt, hasServerBinary, installLlamaRuntime, starterHome } from "./starter-model.mjs";
import { installWhisperRuntime, whisperBinary, whisperRuntimeKey } from "./voice-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEDIA_PATH = resolve(HERE, "..", "data", "media-models.json");
export const MODEL_KINDS = Object.freeze(["chat", "image", "video", "voice"]);
export const MEDIA_KINDS = Object.freeze(["image", "video", "voice"]);

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const gi = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

/** A catalog file split into parts cannot be downloaded as one file. */
export const isSplitFile = (url) => /-\d{5}-of-\d{5}\.gguf$/i.test(String(url ?? ""));

export function loadMediaCatalog(path = MEDIA_PATH) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const models = Array.isArray(doc?.models) ? doc.models : [];
  for (const entry of models) {
    if (!entry?.id || !MEDIA_KINDS.includes(entry.kind)) throw new Error(`${path}: ${entry?.id ?? "an entry"} needs an id and a kind (${MEDIA_KINDS.join(", ")})`);
    if (!entry.file?.url || !(entry.needGiB > 0)) throw new Error(`${path}: ${entry.id} needs file.url and needGiB`);
  }
  return doc;
}

/**
 * Where a model goes and what it is called there. `quant` picks a chat model's file;
 * media models have exactly one. Returns null for an id the catalogs do not know.
 */
export function downloadTarget({ kind, id, quant, chatCatalog, mediaCatalog, home = starterHome() }) {
  if (kind === "chat") {
    const entry = (chatCatalog?.models ?? []).find((m) => m.id === id);
    const spec = entry?.quants?.find((q) => q.quant === quant) ?? (quant ? null : entry?.quants?.[0]);
    if (!entry || !spec?.url) return null;
    const fileName = decodeURIComponent(basename(new URL(spec.url).pathname));
    return {
      kind,
      id,
      quant: spec.quant,
      name: entry.name,
      url: spec.url,
      fileName,
      dest: join(home, "models", fileName),
      bytes: spec.bytes ?? null,
      sha256: spec.sha256 ?? null,
      approxBytes: spec.file ? Math.round(spec.file * 1e9) : null,
      split: isSplitFile(spec.url),
    };
  }
  if (MEDIA_KINDS.includes(kind)) {
    const entry = (mediaCatalog?.models ?? []).find((m) => m.id === id && m.kind === kind);
    if (!entry) return null;
    const fileName = entry.file.saveAs ?? entry.file.name ?? decodeURIComponent(basename(new URL(entry.file.url).pathname));
    // The text encoder and VAE a split ComfyUI model needs: separate files, the same checks.
    const companions = (entry.companions ?? []).map((c) => ({
      role: c.role ?? null,
      fileName: c.name,
      url: c.url,
      bytes: c.bytes ?? null,
      sha256: c.sha256 ?? null,
      dest: join(home, "models", kind, c.folder ?? "", c.name),
    }));
    return {
      kind,
      id,
      quant: null,
      name: entry.name,
      url: entry.file.url,
      fileName,
      dest: join(home, "models", kind, entry.folder ?? "", fileName),
      bytes: entry.file.bytes ?? null,
      sha256: entry.file.sha256 ?? null,
      approxBytes: (entry.file.bytes ?? 0) + companions.reduce((n, c) => n + (c.bytes ?? 0), 0) || null,
      split: false,
      companions,
      // What runs it inside Rosalena, when something does: a Whisper file needs whisper.cpp.
      engine: kind === "voice" ? (entry.folder === "whisper" ? "whisper" : null) : "comfyui",
    };
  }
  return null;
}

/**
 * Size and sha256 of a Hugging Face file, from the resolve URL's own headers. Follows
 * Hugging Face's repo-rename redirects (307 to a relative path) but stops at the 302 to
 * the storage CDN, which is where the `x-linked-*` headers are.
 */
export async function resolveRemote(url, { fetchImpl = fetch, signal } = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetchImpl(current, { method: "HEAD", redirect: "manual", signal });
    const size = Number(res.headers.get("x-linked-size"));
    const etag = String(res.headers.get("x-linked-etag") ?? "").replace(/"/g, "").trim();
    if (size > 0 && /^[0-9a-f]{64}$/i.test(etag)) return { url: current, bytes: size, sha256: etag.toLowerCase() };
    if ([301, 307, 308].includes(res.status) && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), current).href;
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("Hugging Face wants a signed-in account with access to this model (it is gated); download it from the model page instead");
    if (res.status === 404) throw new Error("Hugging Face no longer has this file (404); the catalog entry is out of date");
    throw new Error(`Hugging Face did not state this file's size and checksum (HTTP ${res.status}), so it cannot be checked after download`);
  }
  throw new Error("too many redirects from Hugging Face");
}

/** Is this file already where the page would put it (or in another model folder)? */
export function findDownloaded(target, extraDirs = []) {
  if (!target) return null;
  // A model whose text encoder or VAE is still missing is not downloaded yet: Download
  // fetches only what is missing.
  if ((target.companions ?? []).some((c) => !existsSync(c.dest))) return null;
  if (existsSync(target.dest)) return target.dest;
  const want = target.fileName.toLowerCase();
  for (const dir of extraDirs) {
    try {
      const hit = readdirSync(dir).find((name) => name.toLowerCase() === want);
      if (hit) return join(dir, hit);
    } catch {
      /* a folder that is not there holds nothing */
    }
  }
  return null;
}

/**
 * Score the media catalog against this machine, in the Models page's bucket shape.
 * Like the chat rows, the verdict follows FREE video memory and `idleVerdict` the card's
 * total, so a card that is busy right now does not hide what it can run when idle.
 */
export function scoreMedia({ hardware, catalog, isDownloaded = () => null }) {
  const gpuFree = hardware?.gpu?.vramFreeBytes ?? null;
  const gpuTotal = hardware?.gpu?.vramTotalBytes ?? null;
  const ramFree = hardware?.ram?.freeBytes ?? null;
  const out = {};
  for (const kind of MEDIA_KINDS) out[kind] = { fits: [], tight: [], tooBig: [], unknown: [] };
  for (const entry of catalog?.models ?? []) {
    const need = entry.needGiB * GIB;
    const now = mediaVerdict(entry, need, gpuFree, ramFree);
    const idle = mediaVerdict(entry, need, gpuTotal, ramFree);
    const path = isDownloaded(entry);
    out[entry.kind][now.verdict].push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      task: entry.task ?? null,
      params: entry.params ?? null,
      license: entry.license ?? null,
      runner: entry.runner ?? null,
      url: entry.url ?? null,
      notes: entry.notes ?? null,
      fileName: entry.file.saveAs ?? entry.file.name,
      downloadUrl: entry.file.url,
      // The whole download: the model plus its text encoder and VAE, when it has them.
      bytes: (entry.file.bytes ?? 0) + (entry.companions ?? []).reduce((n, c) => n + (c.bytes ?? 0), 0) || null,
      files: 1 + (entry.companions?.length ?? 0),
      // Rosalena can run it itself: ComfyUI with a built-in workflow, or whisper.cpp.
      runsHere: Boolean(entry.workflow) || entry.folder === "whisper",
      needBytes: need,
      verdict: now.verdict,
      device: now.device,
      idleVerdict: idle.verdict,
      reason: mediaReason(entry, need, now, gpuFree, ramFree),
      downloaded: Boolean(path),
      path: path ?? null,
    });
  }
  for (const kind of MEDIA_KINDS) {
    const b = out[kind];
    b.fits.sort((a, c) => c.needBytes - a.needBytes);
    b.tight.sort((a, c) => a.needBytes - c.needBytes);
    b.tooBig.sort((a, c) => a.needBytes - c.needBytes);
  }
  return out;
}

function mediaVerdict(entry, need, gpu, ramFree) {
  if (gpu !== null && need <= gpu) return { verdict: "fits", device: "gpu" };
  if (entry.cpuOk && ramFree !== null && need <= ramFree) return { verdict: "fits", device: "cpu" };
  // ComfyUI's low-VRAM mode keeps part of the model in RAM: it works, slower.
  if (gpu !== null && gpu > 0 && need <= gpu * 1.5 && (ramFree === null || need - gpu <= ramFree)) return { verdict: "tight", device: "offload" };
  if (gpu === null && ramFree === null) return { verdict: "unknown", device: null };
  return { verdict: "tooBig", device: null };
}

function mediaReason(entry, need, now, gpuFree, ramFree) {
  if (now.verdict === "fits" && now.device === "gpu") return `needs about ${gi(need)} of video memory and ${gi(gpuFree)} is free, ${gi(gpuFree - need)} spare`;
  if (now.verdict === "fits") return `runs on the processor: about ${gi(need)} of RAM, and ${gi(ramFree)} is free${gpuFree !== null ? " (a free graphics card makes it faster)" : ""}`;
  if (now.verdict === "tight") return `needs about ${gi(need)} and ${gi(gpuFree)} of video memory is free: ComfyUI keeps the rest in RAM, which works but runs slower`;
  if (now.verdict === "unknown") return "cannot say: neither free video memory nor RAM could be measured";
  if (gpuFree === null) return `needs a graphics card with about ${gi(need)} of video memory, and none was measured on this PC`;
  return `needs about ${gi(need)} of video memory, ${gi(need - gpuFree)} more than the ${gi(gpuFree)} free`;
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.code = "cancelled";
  }
}

/**
 * One download at a time, held in memory: `start`, `cancel`, `job`. Nothing is written
 * outside the model folders; a cancelled download keeps its `.part` and resumes.
 */
export function createModelDownloader({
  home = starterHome(),
  fetchImpl = fetch,
  hasServer = hasServerBinary,
  runtimeKeyName = null,
  runtime = null,
  hasWhisper = () => Boolean(whisperBinary(home)),
  installWhisper = installWhisperRuntime,
  log = () => {},
} = {}) {
  let job = null;
  let controller = null;
  const busy = () => job && ["starting", "resolving", "runtime", "model"].includes(job.phase);

  async function run(target) {
    try {
      // A Whisper model is useless without whisper.cpp, so the runner comes first, the
      // same way a chat model brings llama.cpp. A platform with no build gets the model only.
      if (target.engine === "whisper" && !hasWhisper() && whisperRuntimeKey()) {
        Object.assign(job, { phase: "runtime", runtime: "whisper.cpp", received: 0, total: 0 });
        await installWhisper({
          home,
          fetchImpl,
          signal: controller.signal,
          onProgress: (received, total) => Object.assign(job, { received, total }),
          log: (line) => log(`models: ${line}`),
        });
      }
      if (target.kind === "chat" && !hasServer()) {
        Object.assign(job, { phase: "runtime", runtime: "llama.cpp" });
        await installLlamaRuntime({
          home,
          key: runtimeKeyName,
          runtime,
          fetchImpl,
          signal: controller.signal,
          onProgress: (received, total) => Object.assign(job, { received, total }),
          log: (line) => log(`models: ${line}`),
        });
      }
      // The model, then its companions (text encoder, VAE); a file already in place - a
      // shared encoder another model brought, or a retry after one file failed - is kept.
      const files = [{ fileName: target.fileName, url: target.url, dest: target.dest, bytes: target.bytes, sha256: target.sha256 }, ...(target.companions ?? [])];
      for (const [index, file] of files.entries()) {
        if (controller.signal.aborted) throw new Cancelled();
        if (existsSync(file.dest)) continue;
        job.phase = "resolving";
        const remote = file.bytes && file.sha256 ? file : await resolveRemote(file.url, { fetchImpl, signal: controller.signal });
        const free = freeBytesAt(dirname(file.dest));
        if (free !== null && free < remote.bytes + 1e9) {
          throw new Error(`${file.fileName} is ${gb(remote.bytes)} and only ${gb(free)} is free on that drive`);
        }
        Object.assign(job, { phase: "model", received: 0, total: remote.bytes, file: file.fileName, part: files.length > 1 ? `${index + 1} of ${files.length}` : null });
        await downloadVerified({
          url: remote.url ?? file.url,
          dest: file.dest,
          bytes: remote.bytes,
          sha256: remote.sha256,
          fetchImpl,
          signal: controller.signal,
          onProgress: (received, total) => Object.assign(job, { received, total }),
        });
      }
      if (target.kind === "chat") resetLocalPathCache();
      Object.assign(job, { phase: "done", path: target.dest, finishedAt: Date.now() });
      log(`models: ${target.kind}/${target.id} downloaded to ${target.dest}`);
    } catch (err) {
      const cancelled = err?.code === "cancelled" || controller.signal.aborted;
      Object.assign(job, { phase: cancelled ? "cancelled" : "failed", error: cancelled ? null : String(err?.message ?? err), finishedAt: Date.now() });
      log(`models: ${target.kind}/${target.id} ${cancelled ? "cancelled" : `failed: ${err?.message ?? err}`}`);
    }
  }

  return {
    job: () => (job ? { ...job } : null),
    cancel() {
      if (busy()) controller.abort();
      return { ok: true };
    },
    /** Start downloading a `downloadTarget()` result. Refuses a second job and a split file. */
    start(target) {
      if (!target) return { ok: false, code: "unknown", error: "the catalog has no such model" };
      if (busy()) return { ok: false, code: "busy", error: `${job.name} is still downloading; cancel it or wait` };
      if (target.split) return { ok: false, code: "split", error: "this quant is split into several files; download it from the Hugging Face page instead" };
      controller = new AbortController();
      job = {
        key: `${target.kind}:${target.id}:${target.quant ?? ""}`,
        kind: target.kind,
        id: target.id,
        quant: target.quant,
        name: target.name,
        fileName: target.fileName,
        dest: target.dest,
        phase: "starting",
        received: 0,
        total: target.approxBytes ?? 0,
        error: null,
        startedAt: Date.now(),
      };
      void run(target);
      return { ok: true, job: { ...job } };
    },
  };
}
