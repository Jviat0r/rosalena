/**
 * Local models that load themselves and let go when idle (plugins/rosa-local-model-host):
 *
 *   - a load is fitted to the card: the plan's context and cache type are what llama.cpp
 *     is started with
 *   - a switch to a model that will not fit is refused before the working model is stopped
 *   - changed settings reload a model we loaded; anyone else's copy is left alone
 *   - the idle watch unloads our model after the idle time, and never one that is in use,
 *     generating, or loaded by another program
 *   - "unload when Rosalena closes" stops only our own server, and only when it is on
 *
 * Every process call is injected, as in local-model-host.test.mjs, so nothing here needs a
 * GPU or a model.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cleanPrefs } from "../src/local-fit.mjs";
import { createIdleWatch, hostConfigOf, switchModel, unloadOnQuit, writeState } from "../plugins/rosa-local-model-host/plugin.mjs";

const GIB = 1024 ** 3;
const BASE = "http://127.0.0.1:8080";
const QWEN = "D:\\Models\\qwen3.8-27b\\Qwen3.8-27B-UD-Q4_K_M.gguf";
const CODER = "D:\\Models\\coder\\coder-Q4_K_S.gguf";
const SHELF = [
  { path: QWEN, dir: "D:\\Models\\qwen3.8-27b", file: "Qwen3.8-27B-UD-Q4_K_M.gguf", bytes: 16_460_000_000, quant: "Q4_K_M", params: 27 },
  { path: CODER, dir: "D:\\Models\\coder", file: "coder-Q4_K_S.gguf", bytes: 17_460_000_000, quant: "Q4_K_S", params: 30 },
];
const SHAPE = { layers: 64, trainContext: 262144, kvBytesPerToken: 69632 };
const NETSTAT = async () => ({ ok: true, stdout: "  TCP    127.0.0.1:8080    0.0.0.0:0    LISTENING    24748\n" });

function config() {
  const home = mkdtempSync(join(tmpdir(), "rosalena-autoload-"));
  return hostConfigOf({
    home,
    logFile: null,
    baseUrl: BASE,
    serverBinary: "D:\\llama.cpp\\llama-server.exe",
    modelDirs: ["D:\\Models"],
    planContext: 16384,
    startTimeoutMs: 1400,
    pollMs: 700,
    contentFarmUrl: null,
    extraFlags: ["-fa", "on", "--jinja"],
  });
}

/** A tiny llama.cpp driven by mutable state (the same shape as the host test's). */
function server(state) {
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === null ? "" : JSON.stringify(body)) });
  return async (url) => {
    const path = new URL(url).pathname;
    if (!state.reachable) throw new Error("connect ECONNREFUSED");
    if (path === "/health") return json(200, { status: "ok" });
    if (path === "/props") return json(200, { model_alias: state.alias, model_path: state.path, total_slots: 1, default_generation_settings: { n_ctx: 16384 } });
    if (path === "/v1/models") return json(200, { data: [{ id: state.alias }] });
    if (path === "/slots") return json(200, state.slots);
    return json(404, null);
  };
}
const loaded = (overrides = {}) => ({ reachable: true, alias: "coder", path: CODER, slots: [{ id: 0, is_processing: false, id_task: 7 }], ...overrides });

/** The deps every test shares: a scripted server, the shelf, netstat naming pid 24748. */
function deps(state, extra = {}) {
  const killed = [];
  const spawned = [];
  return {
    killed,
    spawned,
    deps: {
      fetchImpl: server(state),
      scan: () => SHELF,
      runText: NETSTAT,
      shape: () => SHAPE,
      ramFreeBytes: 32 * GIB,
      killImpl: (pid) => {
        killed.push(pid);
        state.reachable = false;
      },
      spawnImpl: (command, args) => {
        spawned.push(args);
        Object.assign(state, { reachable: true, alias: "qwen3.8-27b", path: QWEN });
        return { pid: 5001, once() {}, unref() {} };
      },
      exists: () => true,
      sleep: async () => {},
      ...extra,
    },
  };
}

test("a load is fitted to the card: llama.cpp gets the plan's context, not a fixed number", async () => {
  const cfg = config();
  const state = { reachable: false, slots: [] };
  const t = deps(state, { gpuMemory: () => ({ freeBytes: 23 * GIB, totalBytes: 24 * GIB }) });
  const out = await switchModel({ config: cfg, target: "qwen3.8-27b", deps: t.deps });
  assert.equal(out.ok, true, out.error);
  const args = t.spawned[0];
  assert.equal(args[args.indexOf("-c") + 1], "32768", "auto picks 32k (the default cap) on an empty 24 GB card");
  assert.equal(args[args.indexOf("-ngl") + 1], "99");
  assert.equal(out.plan.verdict, "gpu");
});

test("a switch to a model that will not fit is refused before the working model is stopped", async () => {
  const state = loaded();
  // The coder's 16.3 GiB of weights come back on the swap, less the 1 GiB reserve: 15.3 GiB,
  // just short of the 27B's weights, and 1 GiB of RAM cannot take the rest.
  const t = deps(state, { gpuMemory: () => ({ freeBytes: 0, totalBytes: 4 * GIB }), ramFreeBytes: 1 * GIB });
  const out = await switchModel({ config: config(), target: "qwen3.8-27b", deps: t.deps });
  assert.equal(out.ok, false);
  assert.equal(out.stage, "plan");
  assert.match(out.error, /nothing was stopped/);
  assert.deepEqual(t.killed, [], "the coder model is still loaded and working");
  assert.deepEqual(t.spawned, []);
});

test("changed settings reload a model Rosalena loaded", async () => {
  const cfg = config();
  const state = loaded({ alias: "qwen3.8-27b", path: QWEN });
  writeState({ file: cfg.stateFile, state: { pid: 24748, model: "qwen3.8-27b", settingsKey: "null", plan: { needGpuBytes: 18 * GIB } } });
  const prefs = cleanPrefs({ models: { "qwen3.8-27b": { mode: "manual", context: 8192 } } });
  const t = deps(state, { prefs, gpuMemory: () => ({ freeBytes: 5 * GIB, totalBytes: 24 * GIB }) });
  const out = await switchModel({ config: cfg, target: "qwen3.8-27b", deps: t.deps });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.swapped, true);
  assert.deepEqual(t.killed, [24748]);
  assert.equal(t.spawned[0][t.spawned[0].indexOf("-c") + 1], "8192");
});

test("the idle watch unloads our model after the idle time, and not a minute before", async () => {
  const cfg = config();
  writeState({ file: cfg.stateFile, state: { pid: 24748, model: "coder" } });
  const state = loaded();
  const t = deps(state);
  let clock = 0;
  const watch = createIdleWatch({ config: cfg, idleMs: () => 10 * 60_000, now: () => clock, deps: t.deps });
  assert.equal((await watch.tick()).action, "none");
  clock = 9 * 60_000;
  assert.equal((await watch.tick()).action, "none");
  clock = 11 * 60_000;
  const out = await watch.tick();
  assert.equal(out.action, "unloaded");
  assert.deepEqual(t.killed, [24748]);
});

test("the idle watch keeps a model that is in use, generating, or someone else's", async () => {
  const cfg = config();
  writeState({ file: cfg.stateFile, state: { pid: 24748, model: "coder" } });
  let clock = 0;
  let running = true;
  const state = loaded();
  const t = deps(state);
  const watch = createIdleWatch({ config: cfg, idleMs: () => 60_000, inUse: () => running, now: () => clock, deps: t.deps });
  await watch.tick();
  clock = 5 * 60_000;
  assert.equal((await watch.tick()).action, "none", "a Rosalena run on it is still going");
  running = false;
  // Another program used the same server between two looks: its slot counters moved.
  state.slots = [{ id: 0, is_processing: false, id_task: 8 }];
  clock = 6 * 60_000;
  assert.equal((await watch.tick()).action, "none");
  state.slots = [{ id: 0, is_processing: true, id_task: 9 }];
  clock = 20 * 60_000;
  assert.equal((await watch.tick()).action, "none", "generating right now");
  assert.deepEqual(t.killed, []);

  // A model this harness did not load is never unloaded, however long it sits.
  const foreign = config();
  const other = deps(loaded());
  let later = 0;
  const watchOther = createIdleWatch({ config: foreign, idleMs: () => 1, now: () => later, deps: other.deps });
  await watchOther.tick();
  later = 60 * 60_000;
  assert.match((await watchOther.tick()).why, /another program/);
  assert.deepEqual(other.killed, []);
});

test("unload on quit stops only our own server, and only when the switch is on", async () => {
  const cfg = config();
  writeState({ file: cfg.stateFile, state: { pid: 24748, model: "coder" } });
  const off = deps(loaded(), { prefs: cleanPrefs({ unloadOnQuit: false }) });
  assert.equal((await unloadOnQuit({ config: cfg, deps: off.deps })).code, "kept");
  assert.deepEqual(off.killed, []);

  const on = deps(loaded({ slots: [{ id: 0, is_processing: true }] }), { prefs: cleanPrefs({}) });
  const stopped = await unloadOnQuit({ config: cfg, deps: on.deps });
  assert.equal(stopped.ok, true);
  assert.deepEqual(on.killed, [24748], "forced: the runs using it are closing with the app");

  const foreign = deps(loaded(), { prefs: cleanPrefs({}) });
  assert.equal((await unloadOnQuit({ config: config(), deps: foreign.deps })).code, "not-ours");
  assert.deepEqual(foreign.killed, []);
});
