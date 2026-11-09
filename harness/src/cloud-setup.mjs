/**
 * Cloud models the person brings: their own provider keys, and OmniRoute as an optional
 * download.
 *
 * Keys go into the router's key file - the one the running router reports in
 * /admin/status, because a checkout and an installed app keep it in different places -
 * and the router re-reads that file when it changes (router/src/limits.mjs), so a key
 * saved here works on the next message. Nothing here ever hands a key back to the page:
 * only the router's masked form ("…abcd").
 *
 * OmniRoute (github.com/diegosouzapw/OmniRoute, MIT) is a separate gateway that spreads
 * requests over many providers' free tiers. It is about 2 GB installed, so it is never
 * bundled: on request it is installed with the PC's own npm into ~/.rosalena/omniroute and
 * started with the PC's own Node on 127.0.0.1:20128, the address router.config.json points
 * the `omniroute` provider at. Its native modules are built for that Node, which is why it
 * cannot run on Electron's.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installNodeRuntime, nodeAsset, nodeHome, nodeTools } from "./node-runtime.mjs";

/** Free and student key programs for the page's cards (data/student-programs.json). */
export const PROGRAMS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data", "student-programs.json");

/**
 * The programs, each marked with whether its key can go straight into the router: a
 * provider the router has a key slot for. A missing or broken file is no cards, not an error.
 */
export function studentPrograms({ path = PROGRAMS_PATH, keyProviders = KEY_PROVIDERS.map((p) => p.id) } = {}) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const programs = (Array.isArray(doc.programs) ? doc.programs : []).map((p) => ({ ...p, provider: keyProviders.includes(p.provider) ? p.provider : null }));
    return { checked: doc.checked ?? null, programs };
  } catch {
    return { checked: null, programs: [] };
  }
}

/** The providers a person can give a key for, in the order the page lists them. */
export const KEY_PROVIDERS = Object.freeze([
  { id: "openrouter", label: "OpenRouter", hint: "One key for hundreds of models. openrouter.ai/keys" },
  { id: "anthropic", label: "Anthropic (Claude)", hint: "console.anthropic.com" },
  { id: "openai", label: "OpenAI", hint: "platform.openai.com/api-keys" },
  { id: "google", label: "Google Gemini", hint: "aistudio.google.com/apikey" },
  { id: "deepseek", label: "DeepSeek", hint: "platform.deepseek.com/api_keys" },
  { id: "zai", label: "Z.AI (GLM)", hint: "z.ai: a pay-as-you-go API key, not a GLM Coding Plan key" },
  { id: "kimi", label: "Kimi (Moonshot)", hint: "platform.kimi.ai/console/api-keys (top up at least $1 first)" },
  { id: "omniroute", label: "OmniRoute", hint: "Only needed if you turned on API keys in OmniRoute's dashboard." },
]);

export const OMNIROUTE_VERSION = "3.8.52";
export const OMNIROUTE_PORT = 20128;
/**
 * Arguments for every OmniRoute start. Its `serve` (the default command) opens the dashboard
 * in the default browser once it is up, which put a login page in front of the person every
 * time Rosalena started it; the dashboard has its own tab inside Rosalena instead.
 */
export const OMNIROUTE_ARGS = Object.freeze(["--no-open"]);

/** Chrome or Edge already on this PC, in the order tried; null when there is neither. */
export function systemChrome({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const candidates =
    platform === "win32"
      ? [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
          .filter(Boolean)
          .flatMap((base) => [join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe")])
      : platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  return candidates.find((path) => exists(path)) ?? null;
}

/**
 * The environment every OmniRoute start gets. Loopback only: without PORT and HOSTNAME it
 * listens on 0.0.0.0:3000, the whole network. And a browser: its keyless route (the
 * Cloudflare AI Playground) drives a hidden Chromium page, and `npm install omniroute`
 * brings Playwright but not the browser, so on a PC that never ran Playwright that route
 * failed with "Playwright is not available". The PC's own Chrome or Edge does the job, so
 * it is named here unless the person set CLOUDFLARE_PLAYGROUND_CHROME_PATH themselves.
 */
export function omnirouteEnv(env = process.env, { chrome = systemChrome() } = {}) {
  return {
    ...env,
    PORT: String(OMNIROUTE_PORT),
    HOSTNAME: "127.0.0.1",
    ...(chrome && !env.CLOUDFLARE_PLAYGROUND_CHROME_PATH ? { CLOUDFLARE_PLAYGROUND_CHROME_PATH: chrome } : {}),
  };
}
export const omnirouteHome = () => join(homedir(), ".rosalena", "omniroute");
const omnirouteBin = (home) => join(home, "node_modules", "omniroute", "bin", "omniroute.mjs");

// ---------------------------------------------------------------------------- keys

/** What the router says about each key-taking provider: is a key set, and its masked tail. */
export function keyRows(status) {
  const providers = status?.providers ?? {};
  return KEY_PROVIDERS.filter((p) => providers[p.id]).map((p) => {
    const keys = Array.isArray(providers[p.id].keys) ? providers[p.id].keys : [];
    return { ...p, set: keys.length > 0, masked: keys.map((k) => k.key).filter(Boolean) };
  });
}

/** A key the router could send: one token, no spaces, a sane length. */
export function cleanKey(value) {
  const key = String(value ?? "").trim();
  if (key.length < 8 || key.length > 400 || /\s/.test(key)) return null;
  return key;
}

/**
 * Put `key` in the key file for `provider`, or take the provider out when `key` is null.
 * Other providers' keys, and any hand-written `$comment`, are kept as they were.
 */
export function saveProviderKey({ keyFile, provider, key }) {
  if (!keyFile) throw new Error("the router did not say where its key file is (is it running?)");
  if (!KEY_PROVIDERS.some((p) => p.id === provider)) throw new Error(`no key setting for "${provider}"`);
  let doc = {};
  try {
    if (existsSync(keyFile)) doc = JSON.parse(readFileSync(keyFile, "utf8")) ?? {};
  } catch {
    throw new Error(`${keyFile} is not valid JSON; fix or delete it first`);
  }
  if (!doc.providers || typeof doc.providers !== "object") {
    // A flat file ({ provider: key }) is moved under `providers`, the shape the router prefers.
    const flat = Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("$") && !k.startsWith("_")));
    const kept = Object.fromEntries(Object.entries(doc).filter(([k]) => k.startsWith("$") || k.startsWith("_")));
    doc = { ...kept, providers: flat };
  }
  if (key === null) delete doc.providers[provider];
  else doc.providers[provider] = [key];
  mkdirSync(dirname(keyFile), { recursive: true });
  const tmp = `${keyFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tmp, keyFile);
}

// ----------------------------------------------------------------------- OmniRoute

/** True when anything answers on OmniRoute's port; a 401 for a missing key still means it runs. */
export async function omnirouteRunning({ fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  try {
    await fetchImpl(`http://127.0.0.1:${OMNIROUTE_PORT}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** The PC's own npm version, or null when there is none (OmniRoute then needs Node first). */
export function npmVersion(run = spawnSync) {
  const result = run("npm", ["-v"], { encoding: "utf8", windowsHide: true, timeout: 15000, shell: process.platform === "win32" });
  const version = String(result?.stdout ?? "").trim();
  return result?.status === 0 && /^\d+\.\d+/.test(version) ? version : null;
}

/**
 * Install, start and report OmniRoute. One install at a time, held in memory; the install
 * itself is npm's, so a finished one survives a restart and is found again on disk.
 */
export function createOmniRoute({
  home = omnirouteHome(),
  fetchImpl = fetch,
  spawnImpl = spawn,
  npm = npmVersion,
  log = () => {},
  chrome = () => systemChrome(),
  nodeDir = nodeHome(),
  fetchNode = (onProgress) => installNodeRuntime({ root: dirname(nodeDir), fetchImpl, onProgress }),
  canFetchNode = () => Boolean(nodeAsset()),
} = {}) {
  let job = null;

  const installed = () => existsSync(omnirouteBin(home));
  const tools = () => nodeTools({ npm, dir: nodeDir });

  async function status() {
    const running = await omnirouteRunning({ fetchImpl });
    const node = running || installed() ? null : tools();
    return {
      running,
      installed: installed(),
      home,
      version: OMNIROUTE_VERSION,
      // Which Node an install would use: the PC's, Rosalena's own, or one it can fetch
      // first ("download"). null: none, and no download for this machine either.
      node: running || installed() ? null : node ? node.source : canFetchNode() ? "download" : null,
      npm: running || installed() ? null : npm(),
      dashboard: `http://127.0.0.1:${OMNIROUTE_PORT}/dashboard`,
      job: job ? { ...job } : null,
    };
  }

  function install() {
    if (job?.phase === "installing") return { ok: false, code: "busy", error: "OmniRoute is already being installed" };
    if (installed()) return { ok: true, already: true };
    if (!tools() && !canFetchNode()) {
      return { ok: false, code: "no-node", error: "OmniRoute needs Node.js, and Rosalena has no download for this kind of PC. Install the LTS version from nodejs.org, then try again." };
    }
    job = { phase: "installing", startedAt: Date.now(), line: "starting", error: null };
    void (async () => {
      // No Node on this PC: Rosalena's own copy first (about 38 MB on Windows), checked
      // against nodejs.org's sha256, so "Install OmniRoute" is one click on any PC.
      if (!tools()) {
        try {
          job.line = "downloading Node.js for Rosalena";
          await fetchNode((received, total) => {
            if (total) job.line = `downloading Node.js for Rosalena: ${Math.round((received / total) * 100)}%`;
          });
        } catch (err) {
          Object.assign(job, { phase: "failed", error: `Node.js could not be downloaded: ${err?.message ?? err}`, finishedAt: Date.now() });
          return;
        }
      }
      runNpmInstall(tools());
    })();
    return { ok: true };
  }

  function runNpmInstall(node) {
    if (!node) {
      Object.assign(job, { phase: "failed", error: "Node.js is still missing after the download", finishedAt: Date.now() });
      return;
    }
    const spawnTool = (tool, args) => {
      const [file, argv, opts] = node.command(tool, args);
      return spawnImpl(file, argv, { cwd: home, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: node.env(), ...opts });
    };
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "package.json"),
      `${JSON.stringify(
        {
          name: "rosalena-omniroute",
          private: true,
          description: "OmniRoute, installed by Rosalena on request. Delete this folder to remove it.",
          // npm 11 asks before running install scripts; these are the ones OmniRoute needs.
          allowScripts: { omniroute: true, "better-sqlite3": true, sharp: true, esbuild: true },
          dependencies: { omniroute: OMNIROUTE_VERSION },
        },
        null,
        2,
      )}\n`,
    );
    job.line = "starting npm";
    const child = spawnTool("npm", ["install", "--no-fund", "--no-audit"]);
    const take = (chunk) => {
      const last = String(chunk).trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (last) job.line = last.slice(0, 200);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => Object.assign(job, { phase: "failed", error: String(err?.message ?? err), finishedAt: Date.now() }));
    const finish = (ok, error = null) => {
      Object.assign(job, { phase: ok ? "installed" : "failed", error, finishedAt: Date.now() });
      log(`cloud: OmniRoute install ${ok ? "finished" : `failed (${error})`}`);
    };
    child.on("exit", (code) => {
      if (job.phase !== "installing") return;
      if (!(code === 0 && installed())) return finish(false, `npm install exited ${code}: ${job.line}`);
      // The keyless route needs a Chromium. With Chrome or Edge on the PC, that one is used
      // (omnirouteEnv); without, Playwright's own Chromium is fetched now (~150 MB), so the
      // first message after the install does not fail on a missing browser.
      if (chrome()) return finish(true);
      job.line = "downloading the browser OmniRoute's free route uses";
      const browser = spawnTool("npx", ["playwright", "install", "chromium"]);
      browser.stdout?.on("data", take);
      browser.stderr?.on("data", take);
      browser.on("error", () => finish(true));
      browser.on("exit", (browserCode) => {
        if (browserCode !== 0) job.warning = "OmniRoute is installed, but its browser did not download, so its free route may not answer. Installing Chrome fixes it.";
        finish(true);
      });
    });
  }

  /**
   * Start it with the PC's Node on loopback only, detached so it outlives this window, and
   * wait until it answers. Started without PORT and HOSTNAME it listens on 0.0.0.0:3000,
   * which is the whole network, so both are always set.
   */
  async function start({ waitMs = 60_000 } = {}) {
    if (await omnirouteRunning({ fetchImpl })) return { ok: true, already: true };
    if (!installed()) return { ok: false, code: "not-installed", error: "OmniRoute is not installed yet" };
    const out = openSync(join(home, "omniroute.log"), "a");
    const node = tools();
    const child = spawnImpl(node?.node ?? "node", [omnirouteBin(home), ...OMNIROUTE_ARGS], {
      cwd: home,
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", out, out],
      env: omnirouteEnv(node ? node.env() : process.env, { chrome: chrome() }),
    });
    child.on?.("error", (err) => log(`cloud: OmniRoute did not start: ${err?.message ?? err}`));
    child.unref?.();
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await omnirouteRunning({ fetchImpl })) {
        log(`cloud: OmniRoute started (pid ${child.pid ?? "?"})`);
        return { ok: true, pid: child.pid ?? null };
      }
    }
    return { ok: false, code: "no-answer", error: `OmniRoute did not answer within ${Math.round(waitMs / 1000)} s; see ${join(home, "omniroute.log")}` };
  }

  return { status, install, start, installed, job: () => (job ? { ...job } : null) };
}
