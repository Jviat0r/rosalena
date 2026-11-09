// Rosalena Harness - the router supervisor.
//
// One job: make sure something answers GET /v1/models, and hand back the base URL the
// window should talk to. Deliberately a plain Node module with no Electron import, so
// the spawn path can be exercised by `node` on this machine (see
// packaging/release/README.md, "router spawn proof") instead of only on a desktop.
//
// The rules, in order:
//
//   1. An EXPLICIT address wins and is never second-guessed. `ROUTER_URL` (the variable
//      harness/src/agent.mjs already reads) or `ROSALENA_ROUTER_URL` (the one
//      harness/src/models.mjs reads) means "the router is here". If it answers, use it.
//      If it does not answer, report that; starting a second router on a port nobody
//      asked for would hide the misconfiguration behind a working-looking window.
//   2. Otherwise an ALREADY RUNNING router is preferred. The default 127.0.0.1:8077 is
//      probed first, because that is the port the repository's own router.config.json
//      declares and the one a developer starts by hand while working on the app. Nothing
//      is spawned when it answers - two routers would mean two ledgers and two log files.
//   3. Only when nothing answers is a router started, on a port the OS confirms is free
//      (never an assumed 8077), as a child of THIS process, using Electron's own binary
//      as the Node runtime: there is no `node` on a user's PATH.
//
// What the child gets, and why:
//
//   executable          process.execPath  - in a packaged app that is the .app binary or
//                                            the .exe; ELECTRON_RUN_AS_NODE=1 makes it a
//                                            plain Node runtime with no window and no dock
//   args                <router>/src/index.mjs --config <router>/router.config.json
//                       --port <free port>
//   ELECTRON_RUN_AS_NODE 1
//   ROSALENA_ROUTER_STATE_DIR  <userData>/router  - every writable path (logs, ledger,
//                                usage, pasted keys); see router/src/config.mjs. Without
//                                it the router would write inside the install directory,
//                                which is read-only inside a macOS .app bundle.
//   ROUTER_QUIET        1 - stdout is ignored anyway; the router's own log file is the
//                          thing to read when it misbehaves
//   stdio               "ignore" - a GUI app has no console, and a piped child that fills
//                          its pipe would block
//   cwd                 the router folder, so a relative path in a config still means
//                          something predictable
//
// The wait is bounded: every 200 ms the supervisor asks /v1/models, and the last error,
// the child's early exit code, or the timeout is returned as a real error string that the
// window can show. Nothing here throws for an unreachable router - a desktop app with no
// router still opens its window and says so.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

/** The address the repository's own router.config.json declares. */
export const DEFAULT_ROUTER_URL = "http://127.0.0.1:8077/v1";

/** How long a started router may take before the app reports it as failed. */
export const DEFAULT_READY_MS = 20_000;

const PROBE_TIMEOUT_MS = 1500;
const POLL_MS = 200;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const reason = (err) => String(err?.message ?? err);

/**
 * Where the router lives.
 *
 * Packaged:  <resources>/router/**   (electron-builder `extraResources: router`)
 * Checkout:  <product>/router/**     (this file is <product>/desktop/router-supervisor.mjs)
 *
 * `isPackaged`, `resourcesPath` and `mainDir` are arguments rather than reads of the
 * `electron` module so the resolution can be proved from a staged copy with plain node.
 *
 * @returns {{ root: string, entry: string, config: string, packaged: boolean, present: boolean }}
 */
export function resolveRouterPaths({ isPackaged = false, resourcesPath = "", mainDir = "" } = {}) {
  const root = isPackaged ? join(resourcesPath, "router") : resolve(mainDir, "..", "router");
  const entry = join(root, "src", "index.mjs");
  const config = join(root, "router.config.json");
  return { root, entry, config, packaged: Boolean(isPackaged), present: existsSync(entry) && existsSync(config) };
}

/**
 * The base URL a router address should be handed out as.
 *
 * The harness treats it as an OpenAI client base (`.../chat/completions` is appended), so
 * it has to end in `/v1`. A caller who wrote `http://127.0.0.1:8077` gets the `/v1`
 * appended; one who already wrote it is left alone.
 */
export function normalizeRouterUrl(url) {
  const text = String(url ?? "").trim().replace(/\/+$/, "");
  if (!text) return DEFAULT_ROUTER_URL;
  return /\/v1$/i.test(text) ? text : `${text}/v1`;
}

/**
 * Ask a router whether it is up, by its own model list.
 *
 * A 401 is not "up": an address that rejects us is not a router this window can use, and
 * reporting it as healthy would move the failure to the first prompt.
 */
export async function probeRouter(url, { token = "", timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const base = normalizeRouterUrl(url).replace(/\/v1$/i, "");
  const headers = String(token ?? "").trim() ? { authorization: `Bearer ${String(token).trim()}` } : {};
  try {
    const res = await fetchImpl(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { up: false, error: `HTTP ${res.status} from ${base}/v1/models` };
    const body = await res.json();
    const models = Array.isArray(body?.data) ? body.data : [];
    return { up: true, models, error: null };
  } catch (err) {
    const message = reason(err);
    return { up: false, error: message.includes("timeout") || message.includes("abort") ? `no answer within ${timeoutMs} ms` : message };
  }
}

/**
 * A port the OS says is free, on loopback.
 *
 * Asking the OS (port 0) and closing the listener is the only way to learn a free port
 * without assuming one: 8077 may be taken by a stale router, another copy of the app, or
 * something else entirely. The window between close and the child's bind is real but
 * microseconds wide; `ensureRouter` retries once on an early exit.
 */
export function findFreePort({ host = "127.0.0.1" } = {}) {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.once("error", fail);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? done(port) : fail(new Error("the OS returned no port"))));
    });
  });
}

/**
 * Start a router and wait for it, or say why it is not there.
 *
 * Returns `{ url, source, spawned, child, models, error, port }`; `error` is a message
 * meant for a human, and is set on every failure path.
 */
export async function ensureRouter({
  paths,
  stateDir,
  requestedUrl = "",
  preferredUrl = DEFAULT_ROUTER_URL,
  token = "",
  waitMs = DEFAULT_READY_MS,
  env = process.env,
  execPath = process.execPath,
  log = () => {},
  fetchImpl = fetch,
} = {}) {
  const explicit = String(requestedUrl ?? "").trim();

  // 1. An address the user configured is authoritative.
  if (explicit) {
    const url = normalizeRouterUrl(explicit);
    const probe = await probeRouter(url, { token, fetchImpl });
    if (probe.up) {
      log(`[rosalena] router     ${url} (already running, from ROUTER_URL)`);
      return { url, source: "already-running", spawned: false, child: null, port: null, models: probe.models, error: null };
    }
    const error =
      `The router you configured (${url}) is not answering: ${probe.error}. ` +
      `Nothing was started, because ROUTER_URL names the router on purpose - unset it to let the app start one.`;
    log(`[rosalena] router     ${error}`);
    return { url, source: "unreachable", spawned: false, child: null, port: null, models: [], error };
  }

  // 2. The default port, which is where a router started by hand lives. `preferredUrl`
  // exists so a verification script can prove the spawn branch on a machine that already
  // has a router on 8077; the app never passes it.
  const preferred = normalizeRouterUrl(preferredUrl);
  const probe = await probeRouter(preferred, { token, fetchImpl });
  if (probe.up) {
    log(`[rosalena] router     ${preferred} (already running, reused)`);
    return {
      url: preferred,
      source: "already-running",
      spawned: false,
      child: null,
      port: Number(new URL(preferred).port) || null,
      models: probe.models,
      error: null,
    };
  }

  // 3. Nothing answered: start one.
  if (!paths?.present) {
    const error =
      `No router is running, and this build has no router to start (looked for ${paths?.entry ?? "(unknown)"}). ` +
      `A packaged build ships it at <resources>/router - if that folder is missing, the build is incomplete.`;
    log(`[rosalena] router     ${error}`);
    return { url: DEFAULT_ROUTER_URL, source: "missing", spawned: false, child: null, port: null, models: [], error };
  }
  if (!String(stateDir ?? "").trim()) {
    // Refusing rather than guessing: without this the router writes beside its config,
    // which is read-only in an installed app and would fail in a way that looks random.
    const error = "No writable state directory was given for the router (stateDir); not starting it next to a read-only config.";
    log(`[rosalena] router     ${error}`);
    return { url: DEFAULT_ROUTER_URL, source: "missing", spawned: false, child: null, port: null, models: [], error };
  }

  const port = await findFreePort();
  const url = normalizeRouterUrl(`http://127.0.0.1:${port}`);
  const child = spawn(execPath, [paths.entry, "--config", paths.config, "--port", String(port)], {
    cwd: paths.root,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
      ROSALENA_ROUTER_STATE_DIR: resolve(stateDir),
      ROUTER_QUIET: "1",
    },
    stdio: "ignore",
    windowsHide: true,
  });

  let exited = null;
  let spawnError = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.on("error", (err) => {
    spawnError = reason(err);
  });

  const budget = Math.max(1000, Number(waitMs) || DEFAULT_READY_MS);
  const deadline = Date.now() + budget;
  let last = { error: "nothing answered yet" };
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (spawnError) break;
    if (exited) break;
    last = await probeRouter(url, { token, fetchImpl });
    if (last.up) {
      log(`[rosalena] router     ${url} (started, pid ${child.pid ?? "?"})`);
      return { url, source: "spawned", spawned: true, child, port, models: last.models, error: null };
    }
  }

  const logDir = join(resolve(String(stateDir)), "logs");
  const why = spawnError
    ? `it could not be started: ${spawnError}`
    : exited
      ? `it exited immediately (code ${exited.code ?? "-1"}${exited.signal ? `, ${exited.signal}` : ""})`
      : `it did not answer /v1/models within ${budget} ms (last try: ${last.error})`;
  const error =
    `The router did not come up: ${why}. ` +
    `Started: ${execPath} ${paths.entry} --config ${paths.config} --port ${port}. ` +
    `Its own log is ${logDir}; a started router writes there, not to a console.`;

  // A child that is still alive after the deadline is not going to be usable; leaving it
  // behind would hold the port and skew the next launch's "is one already running?" probe.
  if (!exited && !spawnError) await stopRouter({ child }, { graceMs: 1000 });
  log(`[rosalena] router     ${error}`);
  return { url, source: "failed", spawned: true, child: null, port, models: [], error };
}

/** Stop a router this process started. A reused router belongs to somebody else. */
export async function stopRouter(target, { graceMs = 2000 } = {}) {
  const child = target?.child;
  if (!child || child.exitCode !== null || child.signalCode) return false;
  await new Promise((done) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      done();
    }
  });
  return true;
}
