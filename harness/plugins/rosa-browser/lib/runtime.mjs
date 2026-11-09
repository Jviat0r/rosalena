// Getting a browser: find playwright-core (install it on first use), find a Chromium
// already on the PC (Chrome, Edge, Brave; Edge ships with every Windows 10/11), and
// start it with the agent's own profile. Nothing is downloaded but playwright-core
// itself (~10 MB of JavaScript): it drives the browser that is already installed.
//
// The browser lookup follows skills/ui-check/scripts/ui-audit.mjs and
// skills/aeo-ready/scripts/browser.mjs, with Chrome first.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Pinned: an unpinned install would run whatever was published today. */
export const PLAYWRIGHT_VERSION = "1.64.1";

export function rosalenaHome() {
  return process.env.ROSALENA_HOME || join(homedir(), ".rosalena");
}

export function defaultProfileDir() {
  return join(rosalenaHome(), "browser-profile");
}

export function defaultLibDir() {
  return join(rosalenaHome(), "browser-lib");
}

const HARNESS = fileURLToPath(new URL("../../../", import.meta.url));

/** Where playwright-core may already be: our lib folder, ui-check's scripts, the harness, the cwd. */
function lookupDirs(libDir) {
  return [libDir, join(HARNESS, "skills", "ui-check", "scripts"), HARNESS, process.cwd()];
}

export function findPlaywright(libDir = defaultLibDir()) {
  for (const dir of lookupDirs(libDir)) {
    const req = createRequire(join(dir, "noop.js"));
    for (const name of ["playwright-core", "playwright"]) {
      try {
        const path = req.resolve(name);
        return { pw: req(name), path };
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** npm install playwright-core into `libDir`, without blocking the event loop. */
export function installPlaywright(libDir = defaultLibDir(), { timeoutMs = 240_000 } = {}) {
  mkdirSync(libDir, { recursive: true });
  const manifest = join(libDir, "package.json");
  if (!existsSync(manifest)) {
    writeFileSync(manifest, `${JSON.stringify({ name: "rosalena-browser-lib", private: true, description: "playwright-core for Rosalena's browser plugin. Installed on first use; safe to delete." }, null, 2)}\n`);
  }
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    // One fixed command line (no user input in it). npm is a .cmd shim on Windows, which
    // Node only starts through a shell; a single string avoids the DEP0190 warning.
    const command = `npm install playwright-core@${PLAYWRIGHT_VERSION} --save-exact --no-audit --no-fund --loglevel=error`;
    const child = spawn(command, {
      cwd: libDir,
      shell: true,
      windowsHide: true,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    });
    let err = "";
    child.stderr?.on("data", (d) => {
      err = (err + d).slice(-2000);
    });
    child.stdout?.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`npm install playwright-core took longer than ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run npm (${e.message}). Install Node.js with npm, or run: npm install playwright-core@${PLAYWRIGHT_VERSION} --prefix "${libDir}"`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`npm install playwright-core failed (exit ${code}): ${err.trim().split("\n").slice(-3).join(" ")}`));
      resolvePromise({ ms: Date.now() - started });
    });
  });
}

let installing = null;

/** playwright-core, installing it once per process if it is missing and that is allowed. */
export async function ensurePlaywright({ libDir = defaultLibDir(), autoInstall = true } = {}) {
  const found = findPlaywright(libDir);
  if (found) return { ...found, note: "" };
  if (!autoInstall) {
    throw new Error(`playwright-core is not installed. Run: npm install playwright-core@${PLAYWRIGHT_VERSION} --prefix "${libDir}" (or set the browser plugin's autoInstall to true)`);
  }
  if (!installing) installing = installPlaywright(libDir).finally(() => (installing = null));
  const { ms } = await installing;
  const again = findPlaywright(libDir);
  if (!again) throw new Error(`playwright-core was installed into ${libDir} but could not be loaded`);
  return { ...again, note: `first use: installed playwright-core ${PLAYWRIGHT_VERSION} into ${libDir} (${Math.round(ms / 1000)} s)` };
}

export function systemBrowsers() {
  const os = platform();
  if (os === "win32") {
    const bases = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const at = (...parts) => bases.map((b) => join(b, ...parts));
    return [
      ...at("Google", "Chrome", "Application", "chrome.exe"),
      ...at("Microsoft", "Edge", "Application", "msedge.exe"),
      ...at("BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ];
  }
  if (os === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium"];
}

/** Executables to try, in order: config, CHROME_PATH, the PC's browsers, Playwright's own. */
export function browserCandidates(configured = "") {
  const list = [];
  if (configured) list.push(configured);
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  for (const exe of systemBrowsers()) if (existsSync(exe) && !list.includes(exe)) list.push(exe);
  list.push(""); // Playwright's own Chromium, if one was ever installed with `npx playwright install`
  return list;
}

const PROFILE_BUSY = /ProcessSingleton|SingletonLock|profile (directory )?is (already )?in use|user data directory is already in use|Failed to create .*Singleton|existing browser session/i;

/**
 * A persistent context on the agent's own profile. When another Rosalena process holds
 * that profile (the CLI and the window at once), use a per-process copy instead of failing.
 */
export async function launchContext(pw, { profileDir, headless = true, executablePath = "", viewport, log = () => {} }) {
  const notes = [];
  let lastError;
  const attempt = async (exe, dir) =>
    pw.chromium.launchPersistentContext(dir, {
      headless,
      ...(exe ? { executablePath: exe } : {}),
      acceptDownloads: false,
      viewport: viewport ?? { width: 1280, height: 800 },
      // The host owns Ctrl+C (it cancels a run); Playwright still kills the browser on exit.
      handleSIGINT: false,
      args: ["--no-first-run", "--no-default-browser-check", "--disable-features=Translate,MediaRouter,OptimizationHints", "--disable-search-engine-choice-screen"],
    });
  for (const exe of browserCandidates(executablePath)) {
    for (const dir of [profileDir, `${profileDir}-${process.pid}`]) {
      try {
        mkdirSync(dir, { recursive: true });
        const context = await attempt(exe, dir);
        if (dir !== profileDir) notes.push(`the profile ${profileDir} is in use by another Rosalena process, so this one uses ${dir}`);
        return { context, executable: exe || "Playwright's Chromium", profile: dir, notes };
      } catch (err) {
        lastError = err;
        log(`launch with ${exe || "playwright chromium"} at ${dir} failed: ${String(err?.message ?? err).split("\n")[0]}`);
        if (!PROFILE_BUSY.test(String(err?.message ?? ""))) break; // a broken exe: try the next one, not another profile
      }
    }
  }
  throw new Error(`no Chromium-based browser could start (${String(lastError?.message ?? lastError ?? "none found").split("\n")[0]}). Install Chrome or Edge, or set CHROME_PATH`);
}
