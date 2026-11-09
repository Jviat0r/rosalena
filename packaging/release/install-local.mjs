/**
 * Put the Windows build just made by `node build.mjs win` into this PC's installed copy
 * too, so a local build lands in both places: build/release/app/dist (the installer) and
 * %LOCALAPPDATA%\Programs\Rosalena-Harness (the app the Start menu and the root shortcut
 * open). Nothing is published.
 *
 *   node install-local.mjs            wait for running tasks to finish, then install
 *   node install-local.mjs --now      install without waiting (a running task is cut off)
 *
 * Steps: wait until no run in the installed app's store has written anything for a
 * minute; close Rosalena the normal way (a hard stop only if it ignores that for 20 s);
 * run the installer silently over the existing copy (`--updated /S` keeps the folder,
 * shortcuts, chats, keys and settings); start the updated app again.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(HERE, "..", "..", "build", "release", "app", "dist");
const INSTALLED = join(process.env.LOCALAPPDATA ?? "", "Programs", "Rosalena-Harness", "Rosalena-Harness.exe");
const RUNS = join(process.env.APPDATA ?? "", "Rosalena Harness", "data", "runs");
const QUIET_MS = 60_000;
const now = process.argv.includes("--now");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") throw new Error("install-local.mjs installs the Windows build; on a Mac open the .dmg");
const setup = readdirSync(DIST)
  .filter((name) => /^Rosalena-Harness-Setup-.*\.exe$/.test(name))
  .map((name) => join(DIST, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!setup) throw new Error(`no installer in ${DIST}: run "node build.mjs win" first`);
console.log(`installer  ${setup}`);
console.log(`installs   ${INSTALLED}`);

/** The newest write to any run log, in ms ago (Infinity when there are none). */
function quietFor() {
  if (!existsSync(RUNS)) return Infinity;
  let newest = 0;
  for (const name of readdirSync(RUNS)) if (name.endsWith(".jsonl") && name !== "index.jsonl") newest = Math.max(newest, statSync(join(RUNS, name)).mtimeMs);
  return newest ? Date.now() - newest : Infinity;
}

const running = () => {
  const out = spawnSync("tasklist", ["/FI", "IMAGENAME eq Rosalena-Harness.exe", "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
  return /Rosalena-Harness\.exe/i.test(out);
};

if (running() && !now) {
  while (quietFor() < QUIET_MS) {
    console.log(`a task is still running (last write ${Math.round(quietFor() / 1000)} s ago); waiting for a quiet minute…`);
    await sleep(15_000);
  }
}

if (running()) {
  console.log("closing Rosalena…");
  spawnSync("taskkill", ["/IM", "Rosalena-Harness.exe"], { windowsHide: true });
  for (let i = 0; i < 20 && running(); i += 1) await sleep(1000);
  if (running()) {
    console.log("it did not close by itself; stopping it");
    spawnSync("taskkill", ["/IM", "Rosalena-Harness.exe", "/F", "/T"], { windowsHide: true });
    await sleep(2000);
  }
}

console.log("installing…");
execFileSync(setup, ["--updated", "/S"], { stdio: "inherit", windowsHide: true });
if (!existsSync(INSTALLED)) throw new Error(`the installer finished but ${INSTALLED} is missing`);
console.log("starting the updated app");
spawn(INSTALLED, [], { detached: true, stdio: "ignore" }).unref();
console.log("done");
