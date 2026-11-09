// local-model-host - the action half of the local model shelf.
//
// `rosa-local-model-switch` answers "which GGUF files are on this PC, what would I run,
// and does it fit?". It answers it with knowledge and refuses to act, because a
// plan is safe to ask for and a kill is not. This plugin is the other half: it is
// the only code in the harness that starts or stops a process on purpose, and it
// follows four rules this machine actually enforces.
//
//   1. One card, one big model. A switch is unload-then-load, never both at once,
//      and the load is only planned after the unload reported success.
//   2. A model that is generating is never killed. `busy` comes from /slots. When
//      the server cannot report its slots the answer is "unknown", and unknown is
//      refused, not assumed idle. `force` exists for a hung server and nothing
//      implies it, including a switch.
//   3. The pid to signal is the pid the operating system names as the listener on
//      the configured port. The state file is used for one thing only: to say
//      whether this harness is the one that loaded the model. A pid from an old
//      state file is a hint and a recycled pid is somebody else's process.
//   4. Nothing is hard-coded: spawn, kill, fetch, netstat and sleep are injectable,
//      so the whole lifecycle is exercised by the test suite on a machine with no
//      GPU and no model.
//
// Why the knowledge is borrowed rather than repeated: the launch command, the
// model matching and the fit arithmetic all live in `rosa-local-model-switch`. Two
// builders of that argv would eventually disagree about `--alias` or `-c`, and the
// disagreement would look like "the model I selected is not the model that
// answered". This plugin imports that one and adds the process to it.

import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { freemem, homedir } from "node:os";

import { scanLocalModels } from "../../src/catalog.mjs";
import { ggufShape } from "../../src/gguf.mjs";
import { gpuMemory } from "../../src/hardware.mjs";
import { autoContextCap, launchFlags, planLoad, readLocalPrefs } from "../../src/local-fit.mjs";
import { commandFor, configOf, pickModel, probeServer } from "../rosa-local-model-switch/plugin.mjs";

const DEFAULT_START_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 700;
const DEFAULT_STOP_TIMEOUT_MS = 20_000;
const DEFAULT_CONTENTFARM_URL = "http://127.0.0.1:8787/system/hardware";
const SPLIT_PART = /-(\d{5})-of-(\d{5})\.gguf$/i;

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const reason = (err) => text(err?.message) ?? String(err);

/** A refusal carries a code so a caller can branch, and a sentence a person can act on. */
const refusal = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
const success = (code, extra = {}) => ({ ok: true, code, ...extra });

// ---------------------------------------------------------------------------
// Config, state, and the small OS calls
// ---------------------------------------------------------------------------

/**
 * The planner's config plus the three things only a process owner needs: where the
 * state file and the log live, and how long to wait for a model to come up.
 *
 * A test passes `home` (or `stateFile`) in the plugin config and never touches the
 * real one; the UI and the CLI pass their own home so every surface shares a single
 * answer to "which model did this harness load?".
 */
export function hostConfigOf(raw = {}) {
  const base = configOf(raw);
  const home =
    (typeof raw.home === "string" && raw.home.trim()) ||
    text(process.env.ROSALENA_HOME) ||
    join(homedir(), ".rosalena");
  const startTimeout = Number(raw.startTimeoutMs);
  const poll = Number(raw.pollMs);
  return {
    ...base,
    home,
    stateFile:
      (typeof raw.stateFile === "string" && raw.stateFile.trim()) || join(home, "local-server.json"),
    logFile: raw.logFile === null ? null : (typeof raw.logFile === "string" && raw.logFile.trim()) || join(home, "local-server.log"),
    startTimeoutMs: Number.isFinite(startTimeout) && startTimeout > 0 ? Math.round(startTimeout) : DEFAULT_START_TIMEOUT_MS,
    pollMs: Number.isFinite(poll) && poll >= 50 ? Math.round(poll) : DEFAULT_POLL_MS,
    // null turns the ContentFarm check off (no ContentFarm on the machine).
    contentFarmUrl: raw.contentFarmUrl === null ? null : text(raw.contentFarmUrl) ?? DEFAULT_CONTENTFARM_URL,
  };
}

/**
 * Why ContentFarm needs the GPU left alone right now, or null.
 *
 * ContentFarm shares the one 3090 and switches it itself (it unloads Qwen on purpose to
 * render on ComfyUI or speak with Drama 3). Its `/system/hardware` reports the owner
 * (llm | render | voice | free), a switch in progress and the run it is on. Any of
 * those means hands off: loading or swapping a model now would starve or replace its
 * work. Written 2026-10-24, including the fix that
 * mattered there: the API wraps its reply as `{ ok, data }`, and reading the fields
 * off the wrapper found nothing, so the hold never fired. An unreachable API means
 * ContentFarm is not running, and there is nothing to protect.
 */
export async function contentFarmHold({ url = DEFAULT_CONTENTFARM_URL, fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  if (!url) return null;
  let body;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res?.ok) return null;
    body = await res.json();
  } catch {
    return null;
  }
  const s = body && typeof body.data === "object" && body.data ? body.data : body;
  if (!s || typeof s !== "object") return null;
  const run = s.activity ? `${s.activity.kind ?? "a"} run ${String(s.activity.runId ?? "").slice(0, 8)}` : "";
  if (s.switching) return `ContentFarm is switching the GPU right now${run ? ` (${run})` : ""}`;
  if (s.owner === "render") return `ContentFarm is rendering on the GPU (ComfyUI)${run ? `: ${run}` : ""}`;
  if (s.owner === "voice") return `ContentFarm is using the GPU for voice (Drama 3)${run ? `: ${run}` : ""}`;
  if (run) return `ContentFarm has a ${run} going and will switch the GPU when it needs to`;
  return null;
}

const contentFarmRefusal = (hold, model) =>
  refusal(
    "contentfarm-busy",
    `${hold}, so ${model ?? "the model"} was not loaded and nothing on the GPU was stopped - use a cloud model for now, or retry when ContentFarm is done (http://127.0.0.1:8787/system/hardware)`,
  );

const samePath = (a, b) => resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();

export function readState({ file, readFile = readFileSync } = {}) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeState({ file, state, writeFile = writeFileSync } = {}) {
  if (!file) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFile(file, `${JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function clearState({ file, unlink = unlinkSync } = {}) {
  if (!file) return false;
  try {
    unlink(file);
    return true;
  } catch {
    return false;
  }
}

/** The last lines of the server's own log: the only useful thing after a failed start. */
export function tailLog(file, lines = 8, { readFile = readFileSync } = {}) {
  if (!file) return [];
  try {
    return String(readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}

function defaultRunText(command, args) {
  return new Promise((resolveRun) => {
    execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolveRun({ ok: !err, stdout: String(stdout ?? ""), error: err ? reason(err) : null });
    });
  });
}

const defaultSleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * The pid listening on a port, according to the operating system.
 *
 * This is the only pid worth signalling. If the OS will not name a listener then
 * there is nothing to stop, and saying so is better than killing the process that
 * recycled the pid in the state file.
 */
export async function listenerPid(port, { runText = defaultRunText, platform = process.platform } = {}) {
  const wanted = String(port);
  if (platform === "win32") {
    const out = await runText("netstat", ["-ano", "-p", "TCP"]);
    if (!out.ok) return null;
    for (const line of out.stdout.split(/\r?\n/)) {
      //   TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    12345
      const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (match && match[1] === wanted) return Number(match[2]);
    }
    return null;
  }
  const out = await runText("lsof", ["-nP", `-iTCP:${wanted}`, "-sTCP:LISTEN", "-t"]);
  if (!out.ok) return null;
  const first = out.stdout.split(/\s+/).find((part) => /^\d+$/.test(part));
  return first ? Number(first) : null;
}

// ---------------------------------------------------------------------------
// The shelf: which models can be loaded, under which name
// ---------------------------------------------------------------------------

/** A router- and llama.cpp-safe name: letters, digits, dot, dash, underscore, plus. */
export function cleanAlias(name) {
  const cleaned = String(name ?? "")
    .replace(/[^\w.+@-]+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  return cleaned || "local-model";
}

/**
 * The name a model gets on the wire: the folder it sits in, because that is how
 * these downloads land and it is the name the router already uses for the resident
 * model (`local/qwen3.8-27b`). A file loose in the models root has no folder to
 * borrow, so its own name minus the split suffix is the best available.
 *
 * Both separators are read here rather than through node:path. The tests feed
 * Windows-shaped paths ("D:\Models\qwen3.8-27b") and the code also runs on macOS and
 * Linux, where path.basename sees no separator in that string and returns the whole
 * thing - the model was named "D-Models-qwen3.8-27b" on the Linux test runner while
 * the same test passed on Windows. Splitting on [\\/] is the same answer everywhere.
 */
function folderOf(dir) {
  const parts = String(dir ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/** One spelling for a directory, so the same root compares equal on any platform. */
function dirKey(dir) {
  return resolve(String(dir ?? "")).replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function aliasForFile(file, dirs = []) {
  const folder = folderOf(file?.dir);
  const loose = dirs.some((dir) => dirKey(dir) === dirKey(file?.dir));
  const base = loose || !folder ? String(file?.file ?? "").replace(SPLIT_PART, "").replace(/\.gguf$/i, "") : folder;
  return cleanAlias(base);
}

// Words that name a renderer, a voice or an embedding model rather than something
// llama.cpp can chat with. They are marked and sorted last, never hidden: the shelf
// is an inventory of what exists, and "it is on this PC but it is not a chat model"
// is a real answer. A load attempt on one of them fails with the server's own log,
// which is more honest than a guess about which files are useless.
const NOT_CHAT = /(^|[^a-z])(ltx|ltxv|image|video|music|audio|dit|vae|clip|t5|text[-_]?encoder|embed|whisper|kokoro|drama|rerank)([^a-z]|$)/i;

/** "chat" for a language model, "other" for the weights of a renderer or a voice. */
export function kindOf(name) {
  return NOT_CHAT.test(String(name ?? "")) ? "other" : "chat";
}

/**
 * Every GGUF that can be loaded, as one row per model.
 *
 * A projector is not a model and an MTP head is not a model: they are optional
 * files that belong to one. A split quant is one model in N files, and llama.cpp
 * is pointed at part 1 with the whole size reported. Two folders that sanitise to
 * the same name get a suffix rather than a silent collision: loading "the other
 * qwen" would be the worst kind of successful switch.
 */
export function listLoadable(config, { scan = scanLocalModels } = {}) {
  let entries = [];
  try {
    entries = scan(config.dirs, { maxDepth: 3 }) ?? [];
  } catch {
    entries = [];
  }
  const weights = entries.filter((entry) => entry && !entry.projector && !entry.mtp);
  const groups = new Map();
  for (const entry of weights) {
    const key = `${resolve(String(entry.dir))}::${String(entry.file).replace(SPLIT_PART, "")}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { path: entry.path, file: entry.file, dir: entry.dir, bytes: entry.bytes, parts: 1, quant: entry.quant ?? null, params: entry.params ?? null });
      continue;
    }
    existing.bytes += entry.bytes;
    existing.parts += 1;
    if (SPLIT_PART.test(String(entry.file)) && String(entry.file).match(SPLIT_PART)[1] === "00001") {
      existing.path = entry.path;
      existing.file = entry.file;
    }
  }

  const projectorIn = (dir) =>
    entries.find((entry) => entry?.projector && resolve(String(entry.dir)).toLowerCase() === resolve(String(dir)).toLowerCase())?.path ?? null;

  const models = [];
  const taken = new Map();
  for (const group of [...groups.values()].sort((a, b) => b.bytes - a.bytes)) {
    const base = aliasForFile(group, config.dirs);
    const count = (taken.get(base.toLowerCase()) ?? 0) + 1;
    taken.set(base.toLowerCase(), count);
    const alias = count === 1 ? base : `${base}-${count}`;
    models.push({
      alias,
      target: `local/${alias}`,
      path: group.path,
      file: group.file,
      dir: group.dir,
      bytes: group.bytes,
      gb: Number((group.bytes / 1e9).toFixed(2)),
      quant: group.quant,
      params: group.params,
      parts: group.parts,
      projector: projectorIn(group.dir),
      kind: kindOf(`${alias} ${group.file}`),
    });
  }
  // Chat models first: a picker whose third entry is a video decoder teaches people
  // to ignore the list. Size breaks the tie, so the big model stays at the top.
  return models.sort((a, b) => (a.kind === b.kind ? b.bytes - a.bytes : a.kind === "chat" ? -1 : 1));
}

/** Which loadable model a name refers to: alias, file name, path, or one unique part of it. */
export function matchModel(models, name) {
  const wanted = text(name);
  if (!wanted) return null;
  const needle = wanted.toLowerCase();
  return (
    models.find((model) => model.alias.toLowerCase() === needle) ??
    models.find((model) => String(model.file).toLowerCase() === needle) ??
    models.find((model) => samePath(model.path, wanted)) ??
    unique(models.filter((model) => model.alias.toLowerCase().includes(needle) || String(model.file).toLowerCase().includes(needle)))
  );
}

function unique(list) {
  return list.length === 1 ? list[0] : null;
}

/** A catalog id that does not match a folder name still names a model on disk. */
function fromCatalogName(config, models, name) {
  let pick = null;
  try {
    pick = pickModel(name, { catalog: null, files: scanLocalModels(config.dirs) });
  } catch {
    return null;
  }
  const path = pick?.file?.path ?? pick?.unit?.files?.[0]?.path;
  if (!path) return null;
  return models.find((model) => samePath(model.path, path)) ?? null;
}

// ---------------------------------------------------------------------------
// The live server
// ---------------------------------------------------------------------------

/**
 * What is on the port, who put it there, and which shelf row it is.
 *
 * `busy` keeps three values from the planner (true / false / null) because an
 * unload guard that reads "cannot tell" as "idle" is how a generating model gets
 * killed. `ours` says whether the state file names the same pid that is listening.
 */
export async function serverStatus(config, { fetchImpl = fetch, runText, platform, scan } = {}) {
  const probe = await probeServer({ baseUrl: config.baseUrl, fetchImpl, timeoutMs: config.timeoutMs });
  const models = listLoadable(config, scan ? { scan } : {});
  const state = readState({ file: config.stateFile });
  const listening = probe.up || probe.loading;
  const pid = listening ? await listenerPid(config.port, { ...(runText ? { runText } : {}), ...(platform ? { platform } : {}) }) : null;
  const byPath = probe.modelPath ? models.find((model) => samePath(model.path, probe.modelPath)) ?? null : null;
  const byAlias = !byPath && probe.model ? models.find((model) => model.alias.toLowerCase() === String(probe.model).toLowerCase()) ?? null : null;
  const loadedModel = byPath ?? byAlias ?? null;

  return {
    ...probe,
    baseUrl: config.baseUrl,
    pid,
    state,
    ours: Boolean(state?.pid && pid && Number(state.pid) === Number(pid)),
    loaded: loadedModel?.alias ?? probe.model ?? null,
    loadedModel,
    models,
  };
}

const loadedMatches = (status, model) =>
  Boolean(
    status.up &&
      model &&
      ((status.modelPath && samePath(status.modelPath, model.path)) ||
        (status.model && String(status.model).toLowerCase() === model.alias.toLowerCase()) ||
        (status.loadedModel && status.loadedModel.path && samePath(status.loadedModel.path, model.path))),
  );

// ---------------------------------------------------------------------------
// Fitting a model to this PC (src/local-fit.mjs does the arithmetic)
// ---------------------------------------------------------------------------

/** The settings that shape a load, as one string: a change means the loaded copy is stale. */
const settingsKey = (settings) => JSON.stringify(settings ?? null);

/**
 * How this model would load right now: context, layers on the card, KV cache type.
 *
 * `reclaimBytes` is VRAM the swap is about to free (our own previous model). The card is
 * read with nvidia-smi unless `deps.gpuMemory` is given; a test that fakes the process
 * (`deps.spawnImpl`) and says nothing about the card gets "no card reported", which loads
 * the way the install always did, so the lifecycle tests do not depend on this PC's GPU.
 */
export async function planFor({ config, model, reclaimBytes = 0, deps = {} } = {}) {
  const prefs = deps.prefs ?? readLocalPrefs(config.home);
  const settings = prefs.models?.[model.alias] ?? null;
  const readGpu = deps.gpuMemory ?? (deps.spawnImpl ? () => null : () => gpuMemory());
  const gpu = await readGpu();
  const shape = deps.shape ? deps.shape(model) : ggufShape(model.path);
  let projectorBytes = 0;
  try {
    projectorBytes = model.projector ? statSync(model.projector).size : 0;
  } catch {
    projectorBytes = 0;
  }
  const plan = planLoad({
    model: { bytes: model.bytes, projectorBytes, alias: model.alias },
    shape,
    gpu,
    ramFreeBytes: deps.ramFreeBytes ?? freemem(),
    reclaimBytes,
    prefs,
    settings,
    preferredContext: config.planContext,
    extraFlags: config.extraFlags,
  });
  return { ...plan, model: model.alias, settings, settingsKey: settingsKey(settings) };
}

/** VRAM the loaded model frees when it stops: what we planned for it, else its weights (a floor). */
function reclaimOf(status) {
  if (!(status.up || status.loading)) return 0;
  const planned = Number(status.ours ? status.state?.plan?.needGpuBytes : NaN);
  if (Number.isFinite(planned) && planned > 0) return planned;
  return Number(status.loadedModel?.bytes) || 0;
}

/**
 * Start llama.cpp on one model and wait for it to answer.
 *
 * The wait is counted in attempts, not wall-clock time, so a test drives it with an
 * injected sleep and a scripted fetch. A server that dies during startup is
 * reported with the tail of its own log, because "it did not come up" alone leaves
 * whoever has to fix it with nothing.
 *
 * Without a `plan` one is made here against the card as it is now; a plan that says
 * the model does not fit is refused before anything starts.
 */
export async function startModel({ config, model, plan = null, deps = {} } = {}) {
  const {
    spawnImpl = spawn,
    fetchImpl = fetch,
    sleep = defaultSleep,
    openLog = openSync,
    closeLog = closeSync,
    readFile = readFileSync,
    writeStateImpl = writeState,
    exists = existsSync,
  } = deps;

  if (!model?.path) return refusal("no-model", "there is no GGUF file to load");
  if (!exists(config.binary)) {
    return refusal("no-binary", `llama-server is not at ${config.binary} - set plugins[\"local-model-host\"].config.serverBinary`);
  }

  const fit = plan ?? (await planFor({ config, model, deps }));
  if (!fit.ok) return refusal(fit.code ?? "does-not-fit", `${model.alias} was not loaded: ${fit.why}`, { plan: fit });

  // The planner owns the argv: -m, -c and -ngl from the fit, --alias, --host/--port from
  // this baseUrl, then the configured extra flags with the fit's cache types in them.
  // "all" layers is llama.cpp's 99 idiom, or the real count + 1 for a model deeper than that.
  const argv = commandFor({
    config: { ...config, extraFlags: launchFlags(fit, config.extraFlags) },
    weightsPath: model.path,
    context: fit.context,
    layers: fit.gpuLayers === "all" ? Math.max(99, (fit.layers ?? 0) + 1) : fit.gpuLayers,
    alias: model.alias,
  });
  if (model.projector) argv.push("--mmproj", model.projector);
  if (config.logFile) argv.push("--log-file", config.logFile);

  let stdio = "ignore";
  let fd = null;
  if (config.logFile) {
    try {
      mkdirSync(dirname(config.logFile), { recursive: true });
      fd = openLog(config.logFile, "a");
      stdio = fd;
    } catch {
      fd = null;
      stdio = "ignore";
    }
  }

  let child;
  try {
    child = spawnImpl(argv[0], argv.slice(1), { detached: true, windowsHide: true, stdio: ["ignore", stdio, stdio] });
  } catch (err) {
    if (fd !== null) {
      try {
        closeLog(fd);
      } catch {
        /* already closed */
      }
    }
    return refusal("spawn-failed", `could not start ${argv[0]}: ${reason(err)}`);
  }
  if (typeof child?.unref === "function") child.unref();

  let failure = null;
  child?.once?.("error", (err) => {
    failure = reason(err);
  });
  child?.once?.("exit", (code) => {
    failure ??= `the server exited during startup (code ${code ?? "?"})`;
  });

  const attempts = Math.max(1, Math.ceil(config.startTimeoutMs / Math.max(50, config.pollMs)));
  let probe = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (failure) break;
    probe = await probeServer({ baseUrl: config.baseUrl, fetchImpl, timeoutMs: config.timeoutMs });
    if (probe.up) {
      const state = {
        pid: child?.pid ?? null,
        model: model.alias,
        path: model.path,
        baseUrl: config.baseUrl,
        port: config.port,
        context: fit.context,
        binary: config.binary,
        logFile: config.logFile,
        argv,
        plan: { verdict: fit.verdict, context: fit.context, gpuLayers: fit.gpuLayers, kvCache: fit.kvCache, needGpuBytes: fit.needGpuBytes ?? null, why: fit.why },
        settingsKey: fit.settingsKey ?? null,
      };
      writeStateImpl({ file: config.stateFile, state });
      return success("loaded", { model: model.alias, path: model.path, pid: child?.pid ?? null, probe, state, plan: fit });
    }
    await sleep(config.pollMs);
  }

  const tail = tailLog(config.logFile, 8, { readFile });
  return refusal(
    failure ? "start-failed" : "start-timeout",
    failure ?? `the server did not answer ${config.baseUrl} within ${Math.round(config.startTimeoutMs / 1000)}s`,
    { pid: child?.pid ?? null, probe, tail },
  );
}

/**
 * Stop the server, but only an idle one.
 *
 * The pid comes from the operating system, never from the state file. Unloading a
 * server this harness did not start is allowed - freeing the card is the point - as
 * long as it is idle; a busy one is refused no matter who started it.
 */
export async function stopServer({ config, status = null, force = false, deps = {} } = {}) {
  const {
    killImpl = (pid) => process.kill(pid, "SIGTERM"),
    fetchImpl = fetch,
    sleep = defaultSleep,
    runText,
    platform,
    clearStateImpl = clearState,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  } = deps;

  const before = status ?? (await serverStatus(config, deps));
  if (!before.up && !before.loading) {
    clearStateImpl({ file: config.stateFile });
    return success("idle", { message: `nothing is listening on ${config.baseUrl}`, probe: before });
  }

  if (before.busy === true && !force) {
    return refusal("busy", `${before.loaded ?? "the model"} is generating right now - wait for it to finish, or force the stop if the server is hung`, { probe: before });
  }
  if (before.busy === null && !force) {
    return refusal("busy-unknown", `${config.baseUrl} did not report its slots, so it may be generating - force the stop if you know it is idle`, { probe: before });
  }

  const pid = before.pid ?? (await listenerPid(config.port, { ...(runText ? { runText } : {}), ...(platform ? { platform } : {}) }));
  if (!pid) {
    return refusal("no-pid", `the operating system names no listener on port ${config.port}, so there is nothing safe to stop`, { probe: before });
  }

  try {
    killImpl(pid);
  } catch (err) {
    return refusal("kill-failed", `could not stop pid ${pid}: ${reason(err)}`, { pid, probe: before });
  }

  const attempts = Math.max(1, Math.ceil(stopTimeoutMs / Math.max(50, config.pollMs)));
  let probe = before;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(config.pollMs);
    probe = await probeServer({ baseUrl: config.baseUrl, fetchImpl, timeoutMs: config.timeoutMs });
    if (!probe.up && !probe.loading) {
      clearStateImpl({ file: config.stateFile });
      return success("stopped", {
        pid,
        model: before.loaded,
        path: before.modelPath,
        ours: Number(before.state?.pid) === Number(pid),
        probe,
      });
    }
  }

  return refusal("still-up", `pid ${pid} is still answering ${config.baseUrl} - it may be ignoring the stop, so stop it by hand`, { pid, probe });
}

/**
 * Point the server at one model, swapping only when it is not already that model.
 *
 * The order is the whole safety property: a swap of a busy server is refused before
 * anything is killed, so a failed switch leaves the working model working.
 */
export async function switchModel({ config, target, force = false, deps = {} } = {}) {
  const status = await serverStatus(config, deps);
  const model = matchModel(status.models, target) ?? fromCatalogName(config, status.models, target);
  if (!model) {
    const names = status.models.map((entry) => entry.alias).slice(0, 10).join(", ");
    return refusal(
      "not-installed",
      `no GGUF file matches "${target}"${names ? ` - loadable models: ${names}` : " and no model folder was scanned"}`,
      { available: status.models.map((entry) => entry.alias) },
    );
  }

  // The same model loaded by us with different settings (the person changed its context
  // or layers on the Models page) is reloaded; anyone else's copy is taken as it is.
  const prefs = deps.prefs ?? readLocalPrefs(config.home);
  const settingsStale = status.ours && status.state?.settingsKey !== undefined && status.state.settingsKey !== settingsKey(prefs.models?.[model.alias] ?? null);
  // The window the person chose in Settings reaches a load only through config.planContext,
  // so a change to it never shows up in the settings key: the copy this harness loaded is
  // stale when a plan made now (the card as it is) fits a bigger context than the one the
  // server was launched with. The server's -c is fixed at launch, so the bigger window
  // only exists after a reload - doing the reload here is the "do it" half of
  // "it is stuck at 32k even when I change it in the UI" (2026-11-07). A plan the card
  // fit-reduces back to what is loaded is not stale, or every chat would try to reload a
  // server that already holds the biggest window that fits.
  const loadedCtx = Number(status.state?.context ?? status.state?.plan?.context);
  let planned = null;
  let contextStale = false;
  if (loadedMatches(status, model) && status.ours && Number.isFinite(loadedCtx) && loadedCtx > 0) {
    planned = await planFor({ config, model, deps: { ...deps, prefs } });
    contextStale = Boolean(planned?.ok && planned.context > loadedCtx);
  }
  if (loadedMatches(status, model) && !settingsStale && !contextStale) {
    return success("already-loaded", { model: model.alias, path: model.path, probe: status, swapped: false });
  }

  // Everything below stops or starts a model: never while ContentFarm holds the card.
  const hold = await contentFarmHold({ url: config.contentFarmUrl, fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: config.timeoutMs });
  if (hold) return { ...contentFarmRefusal(hold, model.alias), model: model.alias, action: "switch", stage: "contentfarm" };

  // Plan before anything is stopped: a model that will not fit even once the current one
  // is gone is refused while the current one is still working.
  const sleep = deps.sleep ?? defaultSleep;
  const reclaim = reclaimOf(status);
  const before = await planFor({ config, model, reclaimBytes: reclaim, deps: { ...deps, prefs } });
  if (!before.ok) {
    return { ...refusal(before.code ?? "does-not-fit", `${model.alias} was not loaded and nothing was stopped: ${before.why}`, { plan: before }), model: model.alias, action: "switch", stage: "plan" };
  }

  let stopped = null;
  let plan = before;
  if (status.up || status.loading) {
    stopped = await stopServer({ config, status, force, deps: { ...deps, ...(deps.stopTimeoutMs ? { stopTimeoutMs: deps.stopTimeoutMs } : {}) } });
    if (!stopped.ok) {
      // The only reason to touch a loaded, working model was the bigger planned window,
      // and it is generating right now: a generating model is never killed. This call
      // runs at the window the server holds and says so; the next call finds the server
      // idle and does the reload.
      if ((stopped.code === "busy" || stopped.code === "busy-unknown") && !force && !settingsStale && contextStale && loadedMatches(status, model)) {
        return success("already-loaded", { model: model.alias, path: model.path, probe: status, swapped: false, contextStale: true, plannedContext: planned?.context ?? null });
      }
      return { ...stopped, model: model.alias, action: "switch", stage: "unload" };
    }
    // The estimate is replaced by the card's own figure once the old model is gone. The
    // driver can take a moment to hand the memory back, so it is read a few times; the
    // load uses the last reading, which is never more than the card actually has.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      plan = await planFor({ config, model, deps: { ...deps, prefs } });
      if (plan.ok && plan.context >= before.context && plan.gpuLayers === before.gpuLayers) break;
      await sleep(500);
    }
    if (!plan.ok) {
      return { ...refusal(plan.code ?? "does-not-fit", `${status.loaded ?? "the old model"} was unloaded, but the card did not free enough for ${model.alias}: ${plan.why}`, { plan }), model: model.alias, action: "switch", stage: "plan", previous: status.loaded ?? null };
    }
  }

  const started = await startModel({ config, model, plan, deps });
  return {
    ...started,
    action: "switch",
    swapped: true,
    model: model.alias,
    previous: status.up || status.loading ? status.loaded ?? null : null,
  };
}

/**
 * The one call a run makes before its first token.
 *
 * A target that is not local (`anthropic/...`, `orchestrate`) is not this plugin's
 * business and is returned untouched, so the same call can sit unconditionally in
 * front of every chat. A local target either already is the resident model - and
 * then nothing at all is touched - or is swapped in, which unloads whatever was
 * there because one card cannot hold two big models.
 */
export async function ensureLocalModel({ config, target, force = false, deps = {} } = {}) {
  const wanted = text(target);
  if (!wanted) return success("no-target", { skipped: true });
  const slash = wanted.indexOf("/");
  const provider = slash > 0 ? wanted.slice(0, slash) : null;
  if (provider && provider !== "local") return success("not-local", { skipped: true, provider });
  const alias = slash > 0 ? wanted.slice(slash + 1) : wanted;
  return switchModel({ config, target: alias, force, deps });
}

/**
 * What a load of `target` would do right now, without doing it: the Models page shows
 * this beside each installed model so "Auto" is never a mystery.
 */
export async function planPreview({ config, target, deps = {} } = {}) {
  const status = await serverStatus(config, deps);
  const model = matchModel(status.models, target) ?? fromCatalogName(config, status.models, target);
  if (!model) return refusal("not-installed", `no GGUF file matches "${target}"`);
  const loaded = loadedMatches(status, model);
  const plan = await planFor({ config, model, reclaimBytes: reclaimOf(status), deps });
  return success("preview", {
    model: model.alias,
    loaded,
    // The copy on the card now, when it is this model: its real context and, if we
    // loaded it, the plan it was loaded with.
    current: loaded ? { context: status.ctx ?? null, ours: status.ours, plan: status.ours ? status.state?.plan ?? null : null } : null,
    plan,
  });
}

/**
 * Every installed chat model with how it would load now, its saved settings and, for the
 * one on the card, how it is loaded: the Models page's "On this PC" list in one call. The
 * card is read once for the whole list.
 */
export async function planAll({ config, deps = {} } = {}) {
  const status = await serverStatus(config, deps);
  const readGpu = deps.gpuMemory ?? (deps.spawnImpl ? () => null : () => gpuMemory());
  const gpu = await readGpu();
  const prefs = deps.prefs ?? readLocalPrefs(config.home);
  const shared = { ...deps, prefs, gpuMemory: () => gpu };
  const reclaim = reclaimOf(status);
  const models = [];
  for (const model of status.models.filter((entry) => entry.kind === "chat")) {
    const loaded = loadedMatches(status, model);
    const plan = await planFor({ config, model, reclaimBytes: reclaim, deps: shared });
    models.push({
      alias: model.alias,
      target: model.target,
      gb: model.gb,
      quant: model.quant,
      params: model.params,
      projector: Boolean(model.projector),
      loaded,
      current: loaded ? { context: status.ctx ?? null, ours: status.ours, busy: status.busy, plan: status.ours ? status.state?.plan ?? null : null } : null,
      settings: prefs.models?.[model.alias] ?? null,
      plan,
    });
  }
  return {
    ok: true,
    gpu,
    prefs,
    // What "Auto" means for the context cap on this install, for the page's dropdown.
    autoContext: autoContextCap(config.planContext),
    server: { up: status.up, loading: status.loading, loaded: status.loaded, ours: status.ours, busy: status.busy, context: status.ctx ?? null },
    models,
  };
}

// ---------------------------------------------------------------------------
// Unloading what nobody is using
// ---------------------------------------------------------------------------

/**
 * Watches the model this harness loaded and unloads it after `idleMs` with no work.
 *
 * Work is any of: a slot generating, the slots' task counters moving since the last
 * look (another program on the same port, like DSH, used it between two ticks), or
 * `inUse()` saying a Rosalena run on a local model is still going (a run that is busy
 * with a long tool call is not generating, and unloading under it would make its next
 * turn wait for a reload). A model someone else loaded is never touched, and a busy or
 * cannot-tell server is never stopped: stopServer refuses both.
 *
 * `tick()` is the whole thing; the caller runs it on a timer. `idleMs()` is read every
 * tick so the Settings switch takes effect without a restart.
 */
export function createIdleWatch({ config, idleMs, inUse = () => false, now = Date.now, deps = {}, log = () => {} } = {}) {
  let lastActive = null;
  let lastSig = null;
  let lastPid = null;
  return {
    touch() {
      lastActive = now();
    },
    async tick() {
      const limit = Number(idleMs());
      if (!Number.isFinite(limit) || limit <= 0) return { action: "off" };
      const status = await serverStatus(config, deps);
      if (!(status.up || status.loading)) {
        lastActive = null;
        lastPid = null;
        return { action: "none", why: "nothing loaded" };
      }
      if (!status.ours) return { action: "none", why: "loaded by another program" };
      // A different process than last time (a reload) starts its own idle clock.
      if (status.pid !== lastPid) {
        lastPid = status.pid;
        lastActive = now();
        lastSig = null;
      }
      const sig = JSON.stringify((status.slots ?? []).map((slot) => [slot.task, slot.prompt, slot.decoded]));
      if (status.loading || status.busy !== false || inUse() || (lastSig !== null && sig !== lastSig)) lastActive = now();
      lastSig = sig;
      lastActive ??= now();
      const idleFor = now() - lastActive;
      if (idleFor < limit) return { action: "none", why: "in use or not idle long enough", idleFor };
      const stopped = await stopServer({ config, status, deps });
      if (stopped.ok) {
        log(`local: unloaded ${status.loaded ?? "the model"} after ${Math.round(idleFor / 60000)} min idle`);
        lastActive = null;
        lastPid = null;
        return { action: "unloaded", model: status.loaded ?? null, idleFor };
      }
      return { action: "kept", why: stopped.error, idleFor };
    },
  };
}

/**
 * The app is closing: stop the model this harness loaded, if the person left "Unload
 * when Rosalena closes" on. Forced, because the runs that could be using it are closing
 * with the app; still only ever our own server.
 */
export async function unloadOnQuit({ config, deps = {}, log = () => {} } = {}) {
  const prefs = deps.prefs ?? readLocalPrefs(config.home);
  if (!prefs.unloadOnQuit) return { ok: true, code: "kept", why: "Unload when Rosalena closes is off" };
  const status = await serverStatus(config, deps);
  if (!(status.up || status.loading)) return { ok: true, code: "idle" };
  if (!status.ours) return { ok: true, code: "not-ours", why: "loaded by another program, left running" };
  const stopped = await stopServer({ config, status, force: true, deps });
  log(stopped.ok ? `local: unloaded ${status.loaded ?? "the model"} on quit` : `local: could not unload on quit: ${stopped.error}`);
  return stopped;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatShelf(status) {
  if (!status?.models?.length) return "  no GGUF files found - check modelDirs in the plugin config";
  const width = Math.max(...status.models.map((model) => model.alias.length), 4);
  return status.models
    .map((model) => {
      const loaded = status.loaded === model.alias ? "*" : model.kind === "other" ? "~" : " ";
      const quant = (model.quant ?? "?").padEnd(8);
      const params = model.params ? `${model.params}B`.padStart(6) : "     ?";
      return `${loaded} ${model.gb.toFixed(1).padStart(6)} GB  ${quant} ${params}  ${model.alias.padEnd(width)}`;
    })
    .join("\n");
}

export function formatServer(status) {
  if (!status) return "local server: no answer";
  const out = [];
  if (!status.up && !status.loading) {
    out.push(`server   down - nothing listening on ${status.baseUrl}`);
  } else if (status.loading) {
    out.push(`server   loading on ${status.baseUrl}`);
  } else {
    const busy =
      status.busy === true ? `busy (${status.busySlots.length} generating)` : status.busy === false ? "idle" : "busy state unknown";
    out.push(`server   up on ${status.baseUrl} - ${busy}`);
    out.push(`loaded   ${status.loaded ?? "an unlisted model"}${status.ctx ? ` at ${status.ctx} context` : ""}`);
    if (status.pid) out.push(`pid      ${status.pid}${status.ours ? " (started by this harness)" : " (started outside the harness)"}`);
  }
  out.push(`installed ${status.models.length} model(s)`);
  out.push(formatShelf(status));
  if (status.models.some((model) => model.kind === "other")) {
    out.push("  * = loaded now, ~ = on disk but not a chat model (a renderer or voice file)");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * Build the definition. `deps` is what the tests replace: a scripted fetch, a fake
 * spawn that reports a pid, a kill that records instead of signalling, a netstat
 * that names a listener, and a sleep that returns at once.
 */
export function createHost(deps = {}) {
  const withConfig = (raw) => hostConfigOf(raw ?? {});
  const statusOf = (config) => serverStatus(config, deps);

  return {
    id: "rosa-local-model-host",
    description:
      "Start, stop and switch the local llama.cpp server: load a GGUF model, unload the idle one, or swap when a run is pointed at local/<model> - never kills a model that is generating",

    commands(ctx) {
      const config = withConfig(ctx.config ?? {});
      return {
        // `list` is the shelf on its own: what can be loaded, and what is loaded now. The
        // legend travels with it, because `~` on a row is meaningless without it.
        list: async () => {
          const status = await statusOf(config);
          const legend = status.models.some((model) => model.kind === "other")
            ? "  * = loaded now, ~ = on disk but not a chat model (a renderer or voice file)"
            : null;
          return [formatShelf(status), legend].filter(Boolean).join("\n");
        },
        status: async () => formatServer(await statusOf(config)),
        // `load <name>` starts the server on one model, and only when it is down.
        load: async (argv) => {
          const name = Array.isArray(argv) ? argv[0] : argv;
          if (!text(name)) return "usage: rosa-local-model-host:load <model>  (see rosa-local-model-host:list)";
          const status = await statusOf(config);
          const model = matchModel(status.models, name) ?? fromCatalogName(config, status.models, name);
          if (!model) return `no GGUF file matches "${name}" - loadable: ${status.models.map((entry) => entry.alias).join(", ") || "none"}`;
          if (loadedMatches(status, model)) return `${model.alias} is already loaded`;
          if (status.up || status.loading) return `${status.loaded ?? "another model"} is loaded - use rosa-local-model-host:switch ${model.alias}, which unloads it first`;
          const hold = await contentFarmHold({ url: config.contentFarmUrl, fetchImpl: deps.fetchImpl ?? fetch, timeoutMs: config.timeoutMs });
          if (hold) return `could not load ${model.alias}: ${contentFarmRefusal(hold, model.alias).error}`;
          const started = await startModel({ config, model, deps });
          return started.ok ? `loaded ${model.alias} (pid ${started.pid})` : `could not load ${model.alias}: ${started.error}`;
        },
        // `unload [--force]` stops the server, and only when it is idle.
        unload: async (argv) => {
          const force = (Array.isArray(argv) ? argv : [argv]).some((arg) => String(arg ?? "").toLowerCase() === "--force");
          const stopped = await stopServer({ config, force, deps });
          return stopped.ok
            ? stopped.code === "idle"
              ? stopped.message
              : `stopped ${stopped.model ?? "the server"} (pid ${stopped.pid})`
            : `not stopped: ${stopped.error}`;
        },
        // `switch <name>` is an unload and a load, in that order.
        switch: async (argv) => {
          const name = Array.isArray(argv) ? argv[0] : argv;
          if (!text(name)) return "usage: rosa-local-model-host:switch <model>  (see rosa-local-model-host:list)";
          const swapped = await switchModel({ config, target: name, deps });
          if (!swapped.ok) return `could not switch: ${swapped.error}`;
          if (!swapped.swapped) return `${swapped.model} is already loaded`;
          return `switched ${swapped.previous ?? "nothing"} -> ${swapped.model} (pid ${swapped.pid})`;
        },
      };
    },

    tools(ctx) {
      const config = withConfig(ctx.config ?? {});
      return [
        {
          name: "local_server_status",
          description:
            "Say whether the local llama.cpp server is up, which installed model it is serving, whether it is generating, and who started it. Read-only.",
          parameters: { type: "object", properties: {} },
          async run() {
            return formatServer(await statusOf(config));
          },
        },
        {
          name: "local_model_load",
          description:
            "Start llama.cpp with one of the GGUF models installed on this PC. Refuses when a different model is already loaded (use local_model_switch) and never starts a second server.",
          parameters: {
            type: "object",
            properties: { model: { type: "string", description: "Model alias as listed by the shelf, a GGUF file name, or a path under the models folder." } },
            required: ["model"],
          },
          async run(args) {
            const status = await statusOf(config);
            const model = matchModel(status.models, args?.model) ?? fromCatalogName(config, status.models, args?.model);
            if (!model) return `no GGUF file matches "${args?.model}". Loadable: ${status.models.map((entry) => entry.alias).join(", ") || "none on this PC"}. Nothing was started.`;
            if (loadedMatches(status, model)) return `${model.alias} is already loaded and answering ${config.baseUrl}. Nothing was started.`;
            if (status.up || status.loading) {
              return `${status.loaded ?? "another model"} is loaded on ${config.baseUrl}. Nothing was started: use local_model_switch ${model.alias} to unload it first.`;
            }
            const started = await startModel({ config, model, deps });
            if (!started.ok) {
              const tail = started.tail?.length ? `\nlast log lines:\n  ${started.tail.join("\n  ")}` : "";
              return `could not load ${model.alias}: ${started.error}${tail}`;
            }
            return `loaded ${model.alias} (pid ${started.pid}) on ${config.baseUrl}: ${started.plan?.why ?? `${config.planContext} context`}`;
          },
        },
        {
          name: "local_model_unload",
          description:
            "Stop the local llama.cpp server so the card is free for something else. Refuses while it is generating unless force is true, which is only for a hung server.",
          parameters: {
            type: "object",
            properties: { force: { type: "boolean", description: "Stop even if the server is generating or cannot report its slots. Only for a hung server." } },
          },
          async run(args) {
            const stopped = await stopServer({ config, force: args?.force === true, deps });
            if (stopped.ok) return stopped.code === "idle" ? `${stopped.message}. Nothing was stopped.` : `stopped ${stopped.model ?? "the server"} (pid ${stopped.pid})`;
            return `not stopped: ${stopped.error}`;
          },
        },
        {
          name: "local_model_switch",
          description:
            "Load a different installed GGUF model, unloading the current one first, but only when it is idle. This is what a run does when a local model is selected.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Model alias as listed by the shelf, a GGUF file name, or a path under the models folder." },
              force: { type: "boolean", description: "Unload even if the server is generating. Only for a hung server." },
            },
            required: ["model"],
          },
          async run(args) {
            const swapped = await switchModel({ config, target: args?.model, force: args?.force === true, deps });
            if (!swapped.ok) return `could not switch: ${swapped.error}`;
            if (!swapped.swapped) return `${swapped.model} is already loaded. Nothing was changed.`;
            return `switched ${swapped.previous ?? "nothing"} -> ${swapped.model} (pid ${swapped.pid})`;
          },
        },
      ];
    },

    // Static on purpose: a status hook that probed the server would make loading the
    // harness depend on the card being idle.
    status(ctx) {
      const config = withConfig(ctx.config ?? {});
      return `starts and stops llama-server on ${config.host}:${config.port} from ${config.dirs.join(", ")}, state in ${config.stateFile}`;
    },
  };
}

export default createHost();
