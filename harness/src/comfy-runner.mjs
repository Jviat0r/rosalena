/**
 * ComfyUI as Rosalena's own image and video runner: started when a picture or a clip is
 * asked for, given room on the graphics card first, and stopped when it sits idle.
 *
 *   find      a ComfyUI install on this PC (main.py plus its Python), or the plugin's `root`
 *   start     hidden, as this app's child (it ends with the app), on the configured port,
 *             pointed at ~/.rosalena/models/{image,video} with --extra-model-paths-config
 *   room      before a job: free the card of our own idle chat model (one card, one big
 *             model), then refuse a model that would not fit even with ComfyUI's RAM spill
 *   idle      after the same idle time as chat models (Models page), a ComfyUI we started
 *             is stopped, which gives back every byte; one started by anyone else (like
 *             ContentFarm's) is never freed, stopped or restarted
 *
 * The downloaded models it can run are the media catalog entries with a `workflow`: the
 * graph in data/comfy-workflows/<workflow>.json, filled from the entry's `defaults` and
 * the file names of the model and its companions.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GIB, gpuMemory } from "./hardware.mjs";
import { readLocalPrefs, reserveBytesFor } from "./local-fit.mjs";
import { downloadTarget, findDownloaded, loadMediaCatalog } from "./model-downloads.mjs";
import { killTree, tailFile } from "./omniroute-manager.mjs";
import { starterHome } from "./starter-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_DIR = resolve(HERE, "..", "data", "comfy-workflows");
const DEFAULT_BASE = "http://127.0.0.1:8188";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gi = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

// ---------------------------------------------------------------------------
// Finding ComfyUI
// ---------------------------------------------------------------------------

/** Where ComfyUI is usually unpacked or cloned. The plugin's `root` wins over all of them. */
export function comfyCandidates(home = homedir()) {
  return [
    process.env.COMFYUI_ROOT,
    join(home, "ComfyUI"),
    join(home, "Documents", "ComfyUI"),
    join(home, "ComfyUI_windows_portable", "ComfyUI"),
    join(home, "Desktop", "ComfyUI_windows_portable", "ComfyUI"),
    "C:/ComfyUI",
    "C:/ComfyUI/ComfyUI",
    "C:/ComfyUI_windows_portable/ComfyUI",
    "D:/ComfyUI",
    "D:/ComfyUI/ComfyUI",
    "D:/ComfyUI_windows_portable/ComfyUI",
  ].filter(Boolean);
}

/** The Python a ComfyUI folder runs with: its venv, or the portable build's embedded one. */
export function pythonFor(root, { exists = existsSync } = {}) {
  const win = process.platform === "win32";
  const candidates = win
    ? [join(root, ".venv", "Scripts", "python.exe"), join(root, "venv", "Scripts", "python.exe"), join(root, "..", "python_embeded", "python.exe"), join(root, "..", ".venv", "Scripts", "python.exe")]
    : [join(root, ".venv", "bin", "python"), join(root, "venv", "bin", "python"), join(root, "..", ".venv", "bin", "python")];
  return candidates.find((p) => exists(p)) ?? null;
}

/** `{ root, python }` for the first ComfyUI that has both, or null. */
export function findComfyInstall({ root = null, home = homedir(), exists = existsSync } = {}) {
  for (const dir of root ? [root] : comfyCandidates(home)) {
    if (!exists(join(dir, "main.py"))) continue;
    const python = pythonFor(dir, { exists });
    if (python) return { root: resolve(dir), python };
  }
  return null;
}

/** The extra_model_paths entry that lets ComfyUI see the Models page's downloads. */
export function extraPathsYaml(modelsHome) {
  const base = String(modelsHome).replace(/\\/g, "/");
  const both = (folder) => `|\n      image/${folder}\n      video/${folder}`;
  return [
    "# Written by Rosalena: the image and video models downloaded on its Models page.",
    "rosalena:",
    `    base_path: ${base}`,
    `    checkpoints: ${both("checkpoints")}`,
    `    diffusion_models: ${both("diffusion_models")}`,
    `    unet: ${both("diffusion_models")}`,
    `    text_encoders: ${both("text_encoders")}`,
    `    clip: ${both("text_encoders")}`,
    `    vae: ${both("vae")}`,
    `    loras: ${both("loras")}`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The downloaded models it can run
// ---------------------------------------------------------------------------

/**
 * Every downloaded image or video model that has a built-in workflow, with the graph and
 * the values to fill it: `{ id, kind, name, needGiB, graph, params }`.
 */
export function runnableModels({ home = starterHome(), catalog = null, readFile = readFileSync } = {}) {
  let doc = catalog;
  try {
    doc ??= loadMediaCatalog();
  } catch {
    return [];
  }
  const out = [];
  for (const entry of doc.models ?? []) {
    if (!entry.workflow || !["image", "video"].includes(entry.kind)) continue;
    const target = downloadTarget({ kind: entry.kind, id: entry.id, mediaCatalog: doc, home });
    if (!findDownloaded(target)) continue;
    let graph;
    try {
      graph = JSON.parse(readFile(join(WORKFLOW_DIR, `${entry.workflow}.json`), "utf8"));
    } catch {
      continue;
    }
    const files = Object.fromEntries((target.companions ?? []).map((c) => [c.role, c.fileName]));
    out.push({
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      needGiB: entry.needGiB,
      workflow: entry.workflow,
      graph,
      params: { seed: 42, prefix: `rosalena-${entry.id}`, negative: "", ...(entry.defaults ?? {}), model: target.fileName, ...files },
    });
  }
  // Smallest first inside a kind: the default is the one that runs on the most cards.
  return out.sort((a, b) => (a.kind === b.kind ? a.needGiB - b.needGiB : a.kind === "image" ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Our own idle chat model, unloaded so a render has the card. Replaced by the UI server. */
async function defaultLocalRelease(home) {
  const mod = await import("../plugins/rosa-local-model-host/plugin.mjs");
  const config = mod.hostConfigOf({ home });
  const status = await mod.serverStatus(config);
  if (!(status.up || status.loading)) return { ok: true, code: "idle" };
  if (!status.ours) return { ok: false, code: "not-ours", holder: status.loaded ?? "a model" };
  return mod.stopServer({ config, status });
}

let localReleaseHook = null;
/** The UI server hands in its own release (it knows the configured llama.cpp port). */
export function setLocalRelease(fn) {
  localReleaseHook = fn;
}

export function createComfyRunner({
  baseUrl = DEFAULT_BASE,
  home = starterHome(),
  root = null,
  fetchImpl = fetch,
  spawnImpl = spawn,
  killTreeImpl = killTree,
  gpuImpl = () => gpuMemory(),
  findInstall = () => findComfyInstall({ root }),
  holdImpl = null,
  now = Date.now,
  log = () => {},
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const port = Number(new URL(base).port) || 8188;
  const logFile = join(home, "logs", "comfyui.log");
  let child = null;
  let lastActive = now();
  let starting = null;

  const ours = () => Boolean(child && child.exitCode === null && !child.killed);
  const get = async (path, timeoutMs = 2500) => {
    try {
      const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const up = async () => Boolean(await get("/system_stats"));
  const queued = async () => {
    const q = await get("/queue");
    if (!q) return null;
    return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
  };

  async function start(waitMs) {
    const install = findInstall();
    if (!install) {
      return {
        ok: false,
        code: "no-comfyui",
        error: `ComfyUI is not running on ${base} and no ComfyUI install was found on this PC. Install ComfyUI (github.com/comfyanonymous/ComfyUI, or the portable build) and Rosalena starts it when you ask for an image, or set plugins.comfyui.config.root to its folder.`,
      };
    }
    // ContentFarm (or anything that reports through it) owns the card right now.
    const hold = holdImpl ? await holdImpl() : null;
    if (hold) return { ok: false, code: "contentfarm-busy", error: `${hold}, so ComfyUI was not started` };
    const yaml = join(home, "comfyui-extra-paths.yaml");
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(yaml, extraPathsYaml(join(home, "models")));
    const fd = openSync(logFile, "a");
    try {
      child = spawnImpl(install.python, ["main.py", "--listen", "127.0.0.1", "--port", String(port), "--disable-auto-launch", "--extra-model-paths-config", yaml], {
        cwd: install.root,
        windowsHide: true,
        // Not detached: on Windows the child is in this app's job object and ends with it.
        detached: false,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
    } finally {
      closeSync(fd);
    }
    let failed = null;
    child.once?.("error", (err) => (failed = err?.message ?? String(err)));
    child.once?.("exit", (code) => (failed ??= `ComfyUI exited while starting (code ${code ?? "?"})`));
    log(`comfy: starting ComfyUI from ${install.root} on ${base} (pid ${child.pid})`);
    const end = now() + waitMs;
    while (now() < end) {
      if (failed) break;
      if (await up()) {
        lastActive = now();
        return { ok: true, code: "started", pid: child.pid };
      }
      await sleep(1000);
    }
    const tail = tailFile(logFile, 6);
    await stop();
    return { ok: false, code: "start-failed", error: `${failed ?? `ComfyUI did not answer ${base} within ${Math.round(waitMs / 1000)} s`}${tail.length ? ` - last log lines: ${tail.join(" | ")}` : ""}` };
  }

  async function stop() {
    const pid = child?.pid;
    if (!pid) return { ok: true, code: "idle" };
    await killTreeImpl(pid);
    child = null;
    log(`comfy: stopped ComfyUI (pid ${pid})`);
    return { ok: true, code: "stopped", pid };
  }

  return {
    baseUrl: base,
    logFile,
    ours,
    touch() {
      lastActive = now();
    },
    /**
     * Up and answering, started here if it has to be. Five minutes: a ComfyUI with many
     * custom nodes took 3 min 20 s to answer on this PC (2026-11-03), most of it importing them.
     */
    async ensure({ waitMs = 300_000 } = {}) {
      if (await up()) {
        lastActive = now();
        return { ok: true, code: ours() ? "ours" : "external" };
      }
      starting ??= start(waitMs).finally(() => (starting = null));
      return starting;
    },
    /**
     * Make room for a model that wants `needBytes` of video memory. Our own models go first:
     * whatever this ComfyUI still holds from the last job, then our idle chat model.
     */
    async makeRoom(needBytes) {
      if (ours() && (await queued()) === 0) {
        await fetchImpl(`${base}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => null);
      }
      let gpu = await gpuImpl();
      if (!gpu || !needBytes) return { ok: true, code: "no-reading" };
      const reserve = reserveBytesFor(gpu.totalBytes, readLocalPrefs(home));
      const usable = () => gpu.freeBytes - reserve;
      if (needBytes <= usable()) return { ok: true, code: "fits" };
      const released = await (localReleaseHook ?? (() => defaultLocalRelease(home)))();
      if (released?.code === "stopped") {
        log(`comfy: unloaded the chat model ${released.model ?? ""} to make room`);
        for (let i = 0; i < 6; i += 1) {
          await sleep(500);
          gpu = (await gpuImpl()) ?? gpu;
          if (needBytes <= usable()) break;
        }
      }
      if (needBytes <= usable()) return { ok: true, code: "fits", released: released?.model ?? null };
      // ComfyUI keeps part of a model in RAM when the card is short: slower, but it works,
      // up to the same 1.5x the Models page calls "tight".
      if (needBytes <= usable() * 1.5) return { ok: true, code: "tight", note: `about ${gi(needBytes)} against ${gi(Math.max(0, usable()))} usable: part of it runs from RAM` };
      const holder =
        released?.code === "not-ours"
          ? ` ${released.holder} is loaded on the card by another program and Rosalena did not unload it.`
          : released?.code === "in-use"
            ? ` ${released.holder} is loaded for a chat that is still running; pick a cloud model for that chat, or ask again when it is done.`
            : "";
      return { ok: false, code: "over-vram", error: `this model wants about ${gi(needBytes)} of video memory and only ${gi(Math.max(0, usable()))} is usable (${gi(gpu.freeBytes)} free, ${gi(reserve)} kept in reserve).${holder}` };
    },
    /** Free a ComfyUI we started of its models when nothing is queued (before a chat model loads). */
    async releaseIfIdle() {
      if (!ours() || (await queued()) !== 0) return { ok: true, code: "kept" };
      await fetchImpl(`${base}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => null);
      return { ok: true, code: "freed" };
    },
    /** The idle rule: a ComfyUI we started stops after `idleMs` with an empty queue. */
    async tick(idleMs) {
      if (!ours()) return { action: "none" };
      const q = await queued();
      if (q === null || q > 0) {
        lastActive = now();
        return { action: "none", why: q ? "rendering" : "not answering" };
      }
      if (!(idleMs > 0) || now() - lastActive < idleMs) return { action: "none" };
      await stop();
      return { action: "stopped" };
    },
    stop,
    async status() {
      const answering = await up();
      return { up: answering, ours: ours(), pid: ours() ? child.pid : null, install: findInstall(), baseUrl: base, logFile };
    },
  };
}

const runners = new Map();
/** One runner per ComfyUI address for the whole process: the plugin and the UI share it. */
export function comfyRunner({ baseUrl = DEFAULT_BASE, home = starterHome(), root = null, log } = {}) {
  const key = `${String(baseUrl).replace(/\/+$/, "")}|${root ?? ""}`;
  if (!runners.has(key)) {
    runners.set(
      key,
      createComfyRunner({
        baseUrl,
        home,
        root,
        log,
        holdImpl: async () => {
          const mod = await import("../plugins/rosa-local-model-host/plugin.mjs");
          return mod.contentFarmHold({});
        },
      }),
    );
  }
  return runners.get(key);
}

/** Every runner this process created: the UI's idle tick and quit walk these. */
export const allComfyRunners = () => [...runners.values()];
