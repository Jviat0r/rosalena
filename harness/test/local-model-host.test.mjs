// The lifecycle, without a GPU: every process call is injected, so these tests
// assert the rules that make the plugin safe rather than the machine it runs on.
//
// The four rules under test:
//   1. a generating model is never killed
//   2. "cannot tell whether it is generating" is not "idle"
//   3. the pid to signal is the one the OS names as the listener
//   4. a switch is unload-then-load, and a failed unload leaves the model working

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aliasForFile,
  cleanAlias,
  clearState,
  contentFarmHold,
  ensureLocalModel,
  formatShelf,
  hostConfigOf,
  kindOf,
  listLoadable,
  matchModel,
  readState,
  serverStatus,
  startModel,
  stopServer,
  switchModel,
  writeState,
} from "../plugins/rosa-local-model-host/plugin.mjs";

const BASE = "http://127.0.0.1:8080";
const WEIGHTS = "D:\\Models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "rosalena-host-"));
}

function config(overrides = {}) {
  const home = tempDir();
  return hostConfigOf({
    home,
    stateFile: join(home, "local-server.json"),
    logFile: null,
    baseUrl: BASE,
    serverBinary: "D:\\llama.cpp\\llama-server.exe",
    modelDirs: ["D:\\Models"],
    planContext: 16384,
    startTimeoutMs: 1400,
    pollMs: 700,
    extraFlags: ["-fa", "on", "--parallel", "1", "--jinja"],
    ...overrides,
  });
}

const SHELF = [
  { path: "D:\\Models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf", dir: "D:\\Models\\qwen3.8-27b", file: "Qwen3.8-27B-UD-Q4_K_M.gguf", bytes: 16_460_000_000, quant: "Q4_K_M", params: 27 },
  { path: "D:\\Models\\coder\\coder-Q4_K_S.gguf", dir: "D:\\Models\\coder", file: "coder-Q4_K_S.gguf", bytes: 17_460_000_000, quant: "Q4_K_S", params: 30 },
  { path: "D:\\Models\\coder\\mmproj-coder.gguf", dir: "D:\\Models\\coder", file: "mmproj-coder.gguf", bytes: 900_000_000, quant: null, params: null, projector: true },
  { path: "D:\\Models\\coder\\mtp-coder.gguf", dir: "D:\\Models\\coder", file: "mtp-coder.gguf", bytes: 400_000_000, quant: null, params: null, mtp: true },
  { path: "D:\\Models\\video\\ltxv-uncensored-Q6_K.gguf", dir: "D:\\Models\\video", file: "ltxv-uncensored-Q6_K.gguf", bytes: 17_760_000_000, quant: "Q6_K", params: null },
];

/** A tiny llama.cpp: health, props, /v1/models and /slots, driven by mutable state. */
function server(state) {
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === null ? "" : JSON.stringify(body)) });
  return async (url) => {
    const path = new URL(url).pathname;
    if (path === "/health") {
      if (!state.reachable) throw new Error("connect ECONNREFUSED");
      return state.loading ? json(503, { status: "loading model" }) : json(200, { status: "ok" });
    }
    if (!state.reachable) throw new Error("connect ECONNREFUSED");
    if (path === "/props") {
      return state.loading
        ? json(503, null)
        : json(200, { model_alias: state.alias, model_path: state.path, total_slots: 1, default_generation_settings: { n_ctx: state.ctx } });
    }
    if (path === "/v1/models") return state.loading ? json(503, null) : json(200, { data: [{ id: state.alias }] });
    if (path === "/slots") {
      if (state.slots === null) return json(404, { error: "slots disabled" });
      return json(200, state.slots);
    }
    return json(404, null);
  };
}

const idleServer = (overrides = {}) => ({
  reachable: true,
  loading: false,
  alias: "qwen3.8-27b",
  path: WEIGHTS,
  ctx: 16384,
  slots: [{ id: 0, is_processing: false }],
  ...overrides,
});

/** The fake spawn invokes onStart, so a test decides when the server comes up. */
function spawner(record) {
  let started = 0;
  return (command, args, options) => {
    started += 1;
    record.push({ command, args, options, seq: started });
    return { pid: 4321 + started, once() {}, unref() {}, kill() {} };
  };
}

// ---------------------------------------------------------------------------
// Names and the shelf
// ---------------------------------------------------------------------------

test("a model is named after its folder, because that is the name the router uses", () => {
  assert.equal(aliasForFile({ dir: "D:\\Models\\qwen3.8-27b", file: "Qwen3.8-27B-UD-Q4_K_M.gguf" }, ["D:\\Models"]), "qwen3.8-27b");
  assert.equal(cleanAlias("Qwen3.8 27B (uncensored)"), "Qwen3.8-27B-uncensored");
  assert.equal(cleanAlias("   "), "local-model");
});

// The rename above is what broke on the Linux test runner: node:path.basename reads the
// separator of the host, so a Windows fixture path had no basename there and the model
// came out as "D-Models-qwen3.8-27b". The same folder must name the same model whichever
// separator the fixture uses, on every host.
test("the same folder names the same model, whatever separator the path uses", () => {
  const windows = aliasForFile({ dir: "D:\\Models\\qwen3.8-27b", file: "a.gguf" }, ["D:\\Models"]);
  const posix = aliasForFile({ dir: "/models/qwen3.8-27b", file: "a.gguf" }, ["/models"]);
  assert.equal(windows, "qwen3.8-27b");
  assert.equal(posix, "qwen3.8-27b");
  assert.equal(aliasForFile({ dir: "D:\\Models\\qwen3.8-27b\\", file: "a.gguf" }, ["D:\\Models"]), "qwen3.8-27b");
});

test("a file loose in the models root borrows its own name minus the split suffix", () => {
  assert.equal(aliasForFile({ dir: "D:\\Models", file: "big-00001-of-00002.gguf" }, ["D:\\Models"]), "big");
});

test("the shelf is one row per model: projectors and MTP heads are not models", () => {
  const models = listLoadable(config(), { scan: () => SHELF });
  assert.deepEqual(models.map((model) => model.alias).sort(), ["coder", "qwen3.8-27b", "video"]);
  assert.equal(models.find((model) => model.alias === "coder").projector, "D:\\Models\\coder\\mmproj-coder.gguf");
});

test("the shelf puts chat models first and marks a renderer instead of hiding it", () => {
  const models = listLoadable(config(), { scan: () => SHELF });
  assert.deepEqual(models.map((model) => model.kind), ["chat", "chat", "other"]);
  assert.equal(kindOf("qwen-image-edit"), "other");
  assert.equal(kindOf("minimax-music3-GGUF"), "other");
  assert.equal(kindOf("Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF"), "chat");
  const shelf = formatShelf({ models, loaded: "qwen3.8-27b" });
  assert.match(shelf, /\* .*qwen3\.8-27b/);
  assert.match(shelf, /~ .*video/);
});

test("a split quant is one model in N files, pointed at part 1", () => {
  const scan = () => [
    { path: "D:\\Models\\big\\big-00001-of-00002.gguf", dir: "D:\\Models\\big", file: "big-00001-of-00002.gguf", bytes: 5_000_000_000, quant: "Q4_K_M", params: 70 },
    { path: "D:\\Models\\big\\big-00002-of-00002.gguf", dir: "D:\\Models\\big", file: "big-00002-of-00002.gguf", bytes: 5_000_000_000, quant: "Q4_K_M", params: 70 },
  ];
  const [model] = listLoadable(config(), { scan });
  assert.equal(model.parts, 2);
  assert.equal(model.bytes, 10_000_000_000);
  assert.match(model.path, /00001-of-00002/);
});

test("two folders that sanitise to the same name do not collide silently", () => {
  const scan = () => [
    { path: "D:\\Models\\qwen-3\\a.gguf", dir: "D:\\Models\\qwen-3", file: "a.gguf", bytes: 2e9, quant: "Q4_K_M", params: 7 },
    { path: "D:\\Models\\qwen 3\\b.gguf", dir: "D:\\Models\\qwen 3", file: "b.gguf", bytes: 3e9, quant: "Q4_K_M", params: 7 },
  ];
  const aliases = listLoadable(config(), { scan }).map((model) => model.alias);
  assert.deepEqual(aliases, ["qwen-3", "qwen-3-2"]);
});

test("a name matches the alias, the file name, the path, or one unique part of it", () => {
  const models = listLoadable(config(), { scan: () => SHELF });
  assert.equal(matchModel(models, "coder")?.alias, "coder");
  assert.equal(matchModel(models, "coder-Q4_K_S.gguf")?.alias, "coder");
  assert.equal(matchModel(models, "D:\\Models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf")?.alias, "qwen3.8-27b");
  assert.equal(matchModel(models, "nope"), null);
  const twins = listLoadable(config(), {
    scan: () => [
      { path: "D:\\Models\\qwen-a\\a.gguf", dir: "D:\\Models\\qwen-a", file: "a.gguf", bytes: 1e9, quant: "Q4_K_M", params: 7 },
      { path: "D:\\Models\\qwen-b\\b.gguf", dir: "D:\\Models\\qwen-b", file: "b.gguf", bytes: 2e9, quant: "Q4_K_M", params: 7 },
    ],
  });
  assert.equal(matchModel(twins, "qwen"), null, "ambiguous, so it refuses rather than guessing");
});

// ---------------------------------------------------------------------------
// What is on the port
// ---------------------------------------------------------------------------

test("a down server lists the shelf and claims no pid", async () => {
  const state = { reachable: false };
  const status = await serverStatus(config(), { fetchImpl: server(state), scan: () => SHELF, runText: async () => ({ ok: false, stdout: "" }) });
  assert.equal(status.up, false);
  assert.equal(status.pid, null);
  assert.equal(status.models.length, 3);
});

test("a busy server names the loaded model, its pid, and whether this harness started it", async () => {
  const cfg = config();
  writeState({ file: cfg.stateFile, state: { pid: 24748, model: "qwen3.8-27b", path: WEIGHTS } });
  const runText = async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" });
  const status = await serverStatus(cfg, {
    fetchImpl: server(idleServer({ slots: [{ id: 0, is_processing: true, id_task: 7, next_token: [{ n_decoded: 12, n_remain: 0 }] }] })),
    scan: () => SHELF,
    runText,
  });
  assert.equal(status.up, true);
  assert.equal(status.pid, 24748);
  assert.equal(status.busy, true);
  assert.equal(status.loaded, "qwen3.8-27b");
  assert.equal(status.ours, true);
});

test("a server that cannot report its slots leaves busy unknown, not false", async () => {
  const status = await serverStatus(config(), { fetchImpl: server(idleServer({ slots: null })), scan: () => SHELF, runText: async () => ({ ok: false, stdout: "" }) });
  assert.equal(status.busy, null);
});

test("a server that is still loading is not down", async () => {
  const status = await serverStatus(config(), { fetchImpl: server({ reachable: true, loading: true }), scan: () => SHELF, runText: async () => ({ ok: false, stdout: "" }) });
  assert.equal(status.loading, true);
  assert.equal(status.up, false);
});

// ---------------------------------------------------------------------------
// Unload
// ---------------------------------------------------------------------------

test("an idle server is stopped at the pid the OS names, and the state file is cleared", async () => {
  const cfg = config();
  writeState({ file: cfg.stateFile, state: { pid: 999, model: "qwen3.8-27b" } });
  const state = idleServer();
  const killed = [];
  const deps = {
    fetchImpl: server(state),
    scan: () => SHELF,
    runText: async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" }),
    killImpl: (pid) => {
      killed.push(pid);
      state.reachable = false;
    },
    sleep: async () => {},
  };
  const stopped = await stopServer({ config: cfg, deps });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.code, "stopped");
  assert.deepEqual(killed, [24748], "the listener pid, not the stale pid in the state file");
  assert.equal(readState({ file: cfg.stateFile }), null);
});

test("a generating model is never killed, and a refused unload changes nothing", async () => {
  const cfg = config();
  const state = idleServer({ slots: [{ id: 0, is_processing: true }] });
  const killed = [];
  const deps = { fetchImpl: server(state), scan: () => SHELF, runText: async () => ({ ok: false, stdout: "" }), killImpl: (pid) => killed.push(pid), sleep: async () => {} };
  const stopped = await stopServer({ config: cfg, deps });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.code, "busy");
  assert.deepEqual(killed, []);
  assert.equal(state.reachable, true);
});

test("unknown busy refuses too: it cannot tell, so it does not act", async () => {
  const state = idleServer({ slots: null });
  const killed = [];
  const deps = { fetchImpl: server(state), scan: () => SHELF, runText: async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" }), killImpl: (pid) => killed.push(pid), sleep: async () => {} };
  const refused = await stopServer({ config: config(), deps });
  assert.equal(refused.code, "busy-unknown");
  assert.deepEqual(killed, []);

  const forced = await stopServer({ config: config(), force: true, deps: { ...deps, killImpl: (pid) => { killed.push(pid); state.reachable = false; } } });
  assert.equal(forced.ok, true);
  assert.deepEqual(killed, [24748]);
});

test("with no listener in the OS table there is nothing safe to stop", async () => {
  const killed = [];
  const deps = { fetchImpl: server(idleServer()), scan: () => SHELF, runText: async () => ({ ok: true, stdout: "" }), killImpl: (pid) => killed.push(pid), sleep: async () => {} };
  const stopped = await stopServer({ config: config(), deps });
  assert.equal(stopped.code, "no-pid");
  assert.deepEqual(killed, []);
});

test("unloading a server that is not up is a no-op, not an error", async () => {
  const stopped = await stopServer({ config: config(), deps: { fetchImpl: server({ reachable: false }), scan: () => SHELF, sleep: async () => {} } });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.code, "idle");
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

test("a load refuses before spawning when llama-server is not where the config says", async () => {
  const spawned = [];
  const started = await startModel({
    config: config(),
    model: { alias: "qwen3.8-27b", path: WEIGHTS },
    deps: { spawnImpl: spawner(spawned), exists: () => false, fetchImpl: server({ reachable: false }) },
  });
  assert.equal(started.code, "no-binary");
  assert.equal(spawned.length, 0);
});

test("a load spawns the planner's argv with the alias, the context and the projector", async () => {
  const cfg = config();
  const state = { reachable: false };
  const spawned = [];
  const started = await startModel({
    config: cfg,
    model: { alias: "qwen3.8-27b", path: WEIGHTS, projector: "D:\\Models\\qwen3.8-27b\\mmproj.gguf" },
    deps: {
      spawnImpl: spawner(spawned),
      exists: () => true,
      fetchImpl: server(state),
      sleep: async () => {
        state.reachable = true;
      },
    },
  });
  assert.equal(started.ok, true);
  assert.equal(started.pid, 4322);
  const [call] = spawned;
  assert.equal(call.command, "D:\\llama.cpp\\llama-server.exe");
  assert.deepEqual(call.args.slice(0, 6), ["-m", WEIGHTS, "-c", "16384", "-ngl", "99"]);
  assert.deepEqual(call.args.slice(6, 8), ["--alias", "qwen3.8-27b"]);
  assert.deepEqual(call.args.slice(8, 12), ["--host", "127.0.0.1", "--port", "8080"]);
  assert.ok(call.args.includes("--mmproj"));
  assert.ok(call.args.includes("--jinja"));
  assert.ok(call.args.every((arg) => typeof arg === "string"));
  assert.equal(call.options.detached, true);

  const state2 = readState({ file: cfg.stateFile });
  assert.equal(state2.model, "qwen3.8-27b");
  assert.equal(state2.pid, 4322);
  assert.equal(state2.path, WEIGHTS);
});

test("a spawn that throws is reported, not swallowed", async () => {
  const started = await startModel({
    config: config(),
    model: { alias: "qwen3.8-27b", path: WEIGHTS },
    deps: {
      spawnImpl: () => {
        throw new Error("EACCES");
      },
      exists: () => true,
      fetchImpl: server({ reachable: false }),
    },
  });
  assert.equal(started.code, "spawn-failed");
  assert.match(started.error, /EACCES/);
});

test("a server that never answers fails with the tail of its own log", async () => {
  const home = tempDir();
  const logFile = join(home, "server.log");
  writeFileSync(logFile, "main: loading model\nmain: error loading model: unknown architecture\nexiting due to signal\n");
  const started = await startModel({
    config: config({ logFile }),
    model: { alias: "qwen3.8-27b", path: WEIGHTS },
    deps: { spawnImpl: spawner([]), exists: () => true, fetchImpl: server({ reachable: false }), sleep: async () => {} },
  });
  assert.equal(started.code, "start-timeout");
  assert.equal(started.tail.length, 3);
  assert.match(started.tail.join("\n"), /unknown architecture/);
});

// ---------------------------------------------------------------------------
// Switch and the run-first ensure
// ---------------------------------------------------------------------------

test("a switch unloads first and only then loads, so the card never holds two models", async () => {
  const cfg = config();
  const state = idleServer({ alias: "coder", path: "D:\\Models\\coder\\coder-Q4_K_S.gguf" });
  const order = [];
  const spawned = [];
  const started = await switchModel({
    config: cfg,
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" }),
      killImpl: (pid) => {
        order.push(`kill ${pid}`);
        state.reachable = false;
        state.alias = null;
      },
      sleep: async () => {},
      spawnImpl: (command, args) => {
        order.push("spawn");
        spawned.push(args);
        state.reachable = true;
        state.alias = "qwen3.8-27b";
        state.path = WEIGHTS;
        return { pid: 5001, once() {}, unref() {} };
      },
      exists: () => true,
    },
  });
  assert.equal(started.ok, true);
  assert.equal(started.swapped, true);
  assert.equal(started.previous, "coder");
  assert.deepEqual(order, ["kill 24748", "spawn"]);
  assert.equal(spawned.length, 1);
});

test("a switch to the model that is already loaded touches nothing", async () => {
  const killed = [];
  const spawned = [];
  const switched = await switchModel({
    config: config(),
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: server(idleServer()),
      scan: () => SHELF,
      runText: async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" }),
      killImpl: (pid) => killed.push(pid),
      spawnImpl: spawner(spawned),
    },
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.swapped, false);
  assert.equal(switched.code, "already-loaded");
  assert.deepEqual(killed, []);
  assert.deepEqual(spawned, []);
});

// The window the person chose in Settings reaches a load only through config.planContext,
// so a change to it never shows up in the settings key: the copy this harness loaded is
// stale when a plan made now fits a bigger context than the one it launched with, and the
// switch reloads it (2026-11-07, "it is stuck at 32k even when I change it in the UI").

/** The state file this harness wrote when it loaded the model at `ctx`. */
const oursState = (cfg, ctx) =>
  writeState({
    file: cfg.stateFile,
    state: { pid: 24748, model: "qwen3.8-27b", path: WEIGHTS, baseUrl: BASE, port: 8080, context: ctx, settingsKey: "null", plan: { context: ctx } },
  });

const listener24748 = async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" });

test("a load this harness made at a smaller window is reloaded when the setting now aims bigger", async () => {
  const cfg = config({ planContext: 131072 });
  const state = idleServer({ ctx: 32768 });
  oursState(cfg, 32768);
  const order = [];
  const spawned = [];
  const switched = await switchModel({
    config: cfg,
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: listener24748,
      killImpl: (pid) => {
        order.push(`kill ${pid}`);
        state.reachable = false;
      },
      sleep: async () => {},
      spawnImpl: (command, args) => {
        order.push("spawn");
        spawned.push(args);
        state.reachable = true;
        state.ctx = 131072; // the server comes back up at the bigger -c
        return { pid: 5001, once() {}, unref() {} };
      },
      exists: () => true,
      shape: () => ({ trainContext: 262144 }), // a no-GPU plan: min(planContext, trainContext)
    },
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.swapped, true, "the already-loaded model is swapped for a bigger window");
  assert.deepEqual(order, ["kill 24748", "spawn"], "unload-then-load, nothing else");
  assert.match(spawned[0].join(" "), /-c 131072/, "the reload is planned at the setting, not the plugin default");
  assert.equal(readState({ file: cfg.stateFile }).context, 131072, "the state says the new window, so the next chat is not stale");
});

test("a busy server is not reloaded just for a bigger planned window; the caller defers it", async () => {
  const cfg = config({ planContext: 131072 });
  const state = idleServer({ ctx: 32768, slots: [{ id: 0, is_processing: true }] });
  oursState(cfg, 32768);
  const killed = [];
  const switched = await switchModel({
    config: cfg,
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: listener24748,
      killImpl: (pid) => killed.push(pid),
      spawnImpl: spawner([]),
      shape: () => ({ trainContext: 262144 }),
    },
  });
  assert.equal(switched.ok, true, "the chat runs at the window the server holds");
  assert.equal(switched.code, "already-loaded");
  assert.equal(switched.swapped, false);
  assert.equal(switched.contextStale, true, "so the caller can say the reload waits for the next message");
  assert.equal(switched.plannedContext, 131072);
  assert.deepEqual(killed, [], "a generating model is never killed");
  assert.equal(state.reachable, true, "the working model keeps working");
});

test("a window the card does not fit is not reloaded for, so chats do not loop on it", async () => {
  const cfg = config({ planContext: 262144 });
  const state = idleServer({ ctx: 131072 });
  oursState(cfg, 131072);
  const killed = [];
  const switched = await switchModel({
    config: cfg,
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: listener24748,
      killImpl: (pid) => killed.push(pid),
      spawnImpl: spawner([]),
      shape: () => ({ trainContext: 131072 }), // the model was trained for 131k: 262k is never planned
    },
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.code, "already-loaded");
  assert.equal(switched.swapped, false);
  assert.equal(switched.contextStale, undefined);
  assert.deepEqual(killed, []);
});

test("a settings change is still a hard refusal while busy: deferral is only for the window", async () => {
  const cfg = config({ planContext: 131072 });
  const state = idleServer({ ctx: 32768, slots: [{ id: 0, is_processing: true }] });
  writeState({
    file: cfg.stateFile,
    state: { pid: 24748, model: "qwen3.8-27b", path: WEIGHTS, context: 32768, settingsKey: '{"mode":"manual","context":131072,"gpuLayers":"auto","kvCache":"auto"}', plan: { context: 32768 } },
  });
  const killed = [];
  const switched = await switchModel({
    config: cfg,
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: listener24748,
      killImpl: (pid) => killed.push(pid),
      spawnImpl: spawner([]),
      shape: () => ({ trainContext: 262144 }),
    },
  });
  assert.equal(switched.ok, false);
  assert.equal(switched.code, "busy");
  assert.equal(switched.stage, "unload");
  assert.deepEqual(killed, []);
});

test("a failed unload leaves the working model working", async () => {
  const state = idleServer({ alias: "coder", path: "D:\\Models\\coder\\coder-Q4_K_S.gguf", slots: [{ id: 0, is_processing: true }] });
  const spawned = [];
  const switched = await switchModel({
    config: config(),
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: async () => ({ ok: false, stdout: "" }),
      killImpl: () => {},
      spawnImpl: spawner(spawned),
      sleep: async () => {},
    },
  });
  assert.equal(switched.ok, false);
  assert.equal(switched.stage, "unload");
  assert.deepEqual(spawned, [], "nothing was started over the model that is still generating");
  assert.equal(state.reachable, true);
});

test("a model that is not on disk is refused with the names that are", async () => {
  const switched = await switchModel({
    config: config(),
    target: "llama-3.3-70b",
    deps: { fetchImpl: server({ reachable: false }), scan: () => SHELF, sleep: async () => {} },
  });
  assert.equal(switched.code, "not-installed");
  assert.deepEqual(switched.available, ["coder", "qwen3.8-27b", "video"]);
});

test("the run-first ensure ignores a cloud target entirely", async () => {
  let touched = false;
  const result = await ensureLocalModel({
    config: config(),
    target: "anthropic/claude-sonnet-4",
    deps: {
      fetchImpl: async () => {
        touched = true;
        throw new Error("should not be called");
      },
      spawnImpl: () => {
        touched = true;
      },
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.code, "not-local");
  assert.equal(touched, false);
});

test("the run-first ensure loads the selected local model and reports the swap", async () => {
  const state = idleServer({ alias: "coder", path: "D:\\Models\\coder\\coder-Q4_K_S.gguf" });
  const result = await ensureLocalModel({
    config: config(),
    target: "local/qwen3.8-27b",
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" }),
      killImpl: () => {
        state.reachable = false;
      },
      spawnImpl: () => {
        state.reachable = true;
        state.alias = "qwen3.8-27b";
        state.path = WEIGHTS;
        return { pid: 5002, once() {}, unref() {} };
      },
      sleep: async () => {},
      exists: () => true,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, "loaded");
  assert.equal(result.model, "qwen3.8-27b");
  assert.equal(result.previous, "coder");
});

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test("the state file is a hint about ownership, and a broken one is not fatal", () => {
  const cfg = config();
  assert.equal(readState({ file: cfg.stateFile }), null, "missing file reads as no state");
  writeFileSync(cfg.stateFile, "{not json");
  assert.equal(readState({ file: cfg.stateFile }), null);
  writeState({ file: cfg.stateFile, state: { pid: 1, model: "x" } });
  const parsed = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
  assert.equal(parsed.pid, 1);
  assert.match(parsed.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(clearState({ file: cfg.stateFile }), true);
  assert.equal(existsSync(cfg.stateFile), false);
  assert.equal(clearState({ file: cfg.stateFile }), false, "clearing twice is not an error");
});

// ---------------------------------------------------------------------------
// ContentFarm owns the card first (ported from DSH, 2026-10-24)
// ---------------------------------------------------------------------------

/** The llama.cpp fake plus ContentFarm's /system/hardware, answering `hardware` (or 404 when null). */
function withContentFarm(state, hardware) {
  const llama = server(state);
  return async (url, init) => {
    if (String(url).includes(":8787/system/hardware")) {
      if (hardware === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => hardware };
    }
    return llama(url, init);
  };
}

test("contentFarmHold reads the wrapped { ok, data } reply - the field DSH's guard missed", async () => {
  const at = (hardware) => contentFarmHold({ fetchImpl: withContentFarm(idleServer(), hardware) });
  assert.match(await at({ ok: true, data: { owner: "render", switching: null, activity: null } }), /rendering on the GPU/);
  assert.match(await at({ ok: true, data: { owner: "voice" } }), /voice/);
  assert.match(await at({ ok: true, data: { owner: "llm", activity: { kind: "writer", runId: "6d4134b7abc" } } }), /writer run 6d4134b7/);
  assert.match(await at({ owner: "render" }), /rendering/, "an unwrapped reply still works");
  assert.equal(await at({ ok: true, data: { owner: "free", switching: null, activity: null } }), null);
  assert.equal(await at(null), null, "no ContentFarm API = nothing to protect");
  assert.equal(await contentFarmHold({ url: null }), null, "contentFarmUrl: null turns the check off");
});

test("a switch is refused while ContentFarm renders, before anything is stopped or started", async () => {
  const state = idleServer({ alias: "coder", path: "D:\\Models\\coder\\coder-Q4_K_S.gguf" });
  const killed = [];
  const spawned = [];
  const switched = await switchModel({
    config: config(),
    target: "qwen3.8-27b",
    deps: {
      fetchImpl: withContentFarm(state, { ok: true, data: { owner: "render", switching: null, activity: null } }),
      scan: () => SHELF,
      runText: async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" }),
      killImpl: (pid) => killed.push(pid),
      spawnImpl: spawner(spawned),
      sleep: async () => {},
    },
  });
  assert.equal(switched.ok, false);
  assert.equal(switched.code, "contentfarm-busy");
  assert.match(switched.error, /ContentFarm is rendering .* nothing on the GPU was stopped/);
  assert.deepEqual(killed, [], "the loaded model was not stopped");
  assert.deepEqual(spawned, [], "no model was started");
});

test("an already-loaded target needs no GPU change, so ContentFarm being busy doesn't block it", async () => {
  const switched = await switchModel({
    config: config(),
    target: "qwen3.8-27b",
    deps: { fetchImpl: withContentFarm(idleServer(), { ok: true, data: { owner: "render" } }), scan: () => SHELF },
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.code, "already-loaded");
});
