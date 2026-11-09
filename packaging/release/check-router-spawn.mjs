#!/usr/bin/env node
/**
 * Proves the router that ships inside the app actually starts and answers.
 *
 *   node packaging/release/check-router-spawn.mjs [--app <dir>] [--keep]
 *
 * This is the check that stands in for "did the built app work". It runs on any of the
 * three platforms - Windows, macOS, Linux - because it drives the same module the window
 * drives (desktop/router-supervisor.mjs) against the STAGED app directory that
 * electron-builder packages, with the same arguments the window passes:
 *
 *   <app>/router/src/index.mjs --config <app>/router/router.config.json --port <free>
 *   ELECTRON_RUN_AS_NODE=1, ROSALENA_ROUTER_STATE_DIR=<dir>, ROUTER_QUIET=1
 *
 * What each check is for:
 *
 *   1. the payload has a router to start at all        (stage.mjs FILES/TREES)
 *   2. GET /v1/models answers                          (the router runs)
 *   3. the identity prompt was shipped                 (router/src/persona.mjs exits 2
 *                                                       without data/prompts/rosalena.md;
 *                                                       a start after that is proof enough
 *                                                       that no exit-2 happened)
 *   4. every writable file lands in the state dir      (the macOS .app is read-only; a
 *                                                       router writing beside its config
 *                                                       works on this machine and fails
 *                                                       for a user)
 *   5. an address in ROUTER_URL is never second-guessed (no surprise second router)
 *   6. stopping it releases the port                   (quit does not leak the process)
 *
 * Exit 0 means every applicable check passed. Nothing here needs a provider key: the
 * router serves its model list with no upstream.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_ROUTER_URL,
  ensureRouter,
  findFreePort,
  normalizeRouterUrl,
  probeRouter,
  resolveRouterPaths,
  stopRouter,
} from "../../desktop/router-supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const argv = process.argv.slice(2);
const appAt = argv.indexOf("--app");
const APP = appAt >= 0 && argv[appAt + 1] ? resolve(argv[appAt + 1]) : resolve(REPO, "build", "release", "app");
const STATE = resolve(REPO, "build", "release", "router-state-check");
const KEEP = argv.includes("--keep");

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Start the staged router directly, capture its startup banner, stop it.
 *
 * Same binary and arguments the supervisor uses, minus the ignored stdio: the banner is
 * the only place a running router states which files it will write.
 *
 * @returns {Promise<{ text: string, error: string | null }>}
 */
async function readStartupBanner({ paths: where, stateDir, timeoutMs = 20_000 }) {
  const port = await findFreePort();
  const child = spawn(process.execPath, [where.entry, "--config", where.config, "--port", String(port)], {
    cwd: where.root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ROSALENA_ROUTER_STATE_DIR: stateDir, ROUTER_QUIET: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let text = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    text += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/rosalena-router listening/.test(text)) break;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await sleep(200);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  return { text: text.trim(), error: stderr.trim() || (child.exitCode ? `exited ${child.exitCode}` : null) };
}

console.log("router spawn check");
console.log(`  app    ${APP}`);
console.log(`  state  ${STATE}`);
console.log("");

if (!existsSync(APP)) {
  console.error(`no staged app at ${APP}\n  run: node packaging/release/stage.mjs`);
  process.exit(1);
}

// 1. The payload.
const paths = resolveRouterPaths({ isPackaged: true, resourcesPath: APP, mainDir: join(REPO, "desktop") });
check("the staged payload has a router (src/index.mjs + router.config.json)", paths.present, paths.root);
check("the staged payload ships the identity prompt", existsSync(join(APP, "data", "prompts", "rosalena.md")));
check("the staged payload ships the macOS icon", existsSync(join(APP, "build", "icon.icns")));

if (!paths.present) {
  console.error("\nthe payload is incomplete; nothing else can be checked");
  process.exit(1);
}

await rm(STATE, { recursive: true, force: true });

// 5a. An explicit address that is down must not spawn anything: a user who points the app
// at a router is telling it where the router is, and a silent second one on another port
// would answer requests with a different ledger.
const deadPort = await findFreePort();
const explicit = await ensureRouter({
  paths,
  stateDir: STATE,
  requestedUrl: `http://127.0.0.1:${deadPort}/v1`,
  waitMs: 3000,
});
check(
  "an explicit ROUTER_URL that is down is reported, not worked around",
  explicit.source === "unreachable" && explicit.spawned === false && Boolean(explicit.error),
  explicit.source,
);

// 5b. If something is already listening on the default port, the app reuses it and starts
// nothing. Prove that side, then prove the spawn side on a preferred address that is known
// to be free - the same code path, with the one input that a developer machine with a
// router already running cannot otherwise give it. The app itself always passes the
// default (8077); `preferredUrl` exists for this check.
const existing = await probeRouter(DEFAULT_ROUTER_URL);
let preferred = DEFAULT_ROUTER_URL;
if (existing.up) {
  const reused = await ensureRouter({ paths, stateDir: STATE, waitMs: 3000 });
  check("a router already on 8077 is reused, not duplicated", reused.source === "already-running" && !reused.spawned, reused.url);
  preferred = normalizeRouterUrl(`http://127.0.0.1:${await findFreePort()}`);
  console.log(`  note    ${DEFAULT_ROUTER_URL} is in use, so the spawn branch is proved on ${preferred}`);
}

const started = await ensureRouter({ paths, stateDir: STATE, preferredUrl: preferred, waitMs: 25_000 });
check("the app starts the router from the staged payload", started.source === "spawned" && started.spawned === true, started.url ?? "-");
check(
  "the started router is on a port the OS chose, not 8077",
  /127\.0\.0\.1:\d+\/v1$/.test(started.url ?? "") && !started.url.includes(":8077/"),
  started.url ?? "-",
);
check("GET /v1/models answers", started.models.length > 0, `${started.models.length} models`);

if (started.error) console.log(`        ${started.error}`);

// 4. The paths the RUNNING process resolves. The router prints its ledger, usage and log
// locations in its startup banner (router/src/index.mjs), so a direct start with the
// supervisor's exact environment proves what the supervisor's ignored-stdio child cannot
// show: that every writable path is inside the state dir and every READ path still points
// inside the shipped app.
//
// The banner is read from a second, short-lived process on its own port. Nothing is
// written by either start: the router creates logs/ and state/ on its first logged
// request or first recorded spend, not at boot - so asserting files here would only ever
// assert that no request had been made yet.
const banner = await readStartupBanner({ paths, stateDir: STATE });
const bannerLine = (label) => (banner.text.match(new RegExp(`^\\s+${label}\\s+(.+)$`, "m")) ?? [])[1]?.trim() ?? "";
check("the router starts with the state dir as its ledger", bannerLine("ledger").startsWith(STATE), bannerLine("ledger") || banner.text.slice(0, 120));
check("the router starts with the state dir as its usage file", bannerLine("usage").startsWith(STATE), bannerLine("usage"));
check("the router starts with the state dir as its log dir", bannerLine("logs").startsWith(STATE), bannerLine("logs"));
check(
  "the identity prompt is still read from the shipped app, not the state dir",
  bannerLine("personas").includes(join(APP, "data", "prompts", "rosalena.md")),
  bannerLine("personas"),
);
check("nothing was written next to the router's config", !existsSync(join(paths.root, "logs")));

// 5c. Same address again: reused, and no second child.
const again = await ensureRouter({ paths, stateDir: STATE, requestedUrl: started.url, waitMs: 3000 });
check("asking for the address it just started reuses it", again.source === "already-running" && !again.spawned, again.source);

// 6. Stopping releases the port.
const stopped = await stopRouter(started);
check("stopping the router actually stops it", stopped === true);
await sleep(300);
const after = await probeRouter(started.url, { timeoutMs: 800 });
check("the port stops answering after the stop", after.up === false);

if (banner.text) {
  console.log("\n  router banner:");
  for (const line of banner.text.split("\n").slice(0, 10)) console.log(`    ${line}`);
}

// The URL the window will print and hand to the page.
check("the handed-out URL keeps the /v1 suffix the client expects", normalizeRouterUrl("http://127.0.0.1:9") === "http://127.0.0.1:9/v1");

if (!KEEP) await rm(STATE, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log("");
console.log(`router spawn check: ${results.filter((r) => !r.ok && !r.skipped).length} failed, ${results.filter((r) => r.ok).length} passed`);
process.exit(failed === 0 ? 0 : 1);
