/**
 * Where local models and llama.cpp live on THIS machine, found by looking.
 *
 * The plugins used to default to one developer's folders (D:\Models, D:\llama.cpp), so a
 * fresh install on any other PC pointed at paths that did not exist. These functions look
 * in the places local-model tools actually install to and return what is really there.
 * An explicit config value (plugin config or harness.config.json) still wins: this is
 * only the default.
 *
 * Order matters: the first model folder is where "what this PC can do" measures free
 * disk space, and the first llama-server found is the one a switch starts.
 *
 * Overrides without editing config: ROSALENA_MODEL_DIRS (separated by ";" on Windows,
 * ":" elsewhere) and ROSALENA_LLAMA_SERVER (a path to llama-server).
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_MS = 60_000;
let cache = null;

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Drive roots that exist, C: first, on Windows; [] elsewhere. */
export function driveRoots({ platform = process.platform, exists = existsSync } = {}) {
  if (platform !== "win32") return [];
  const out = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    if (exists(root)) out.push(root);
  }
  return out;
}

/** Every place a model folder is commonly kept, most specific first. Not filtered. */
export function modelDirCandidates({ env = process.env, platform = process.platform, home = homedir(), drives = driveRoots({ platform }) } = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const fromEnv = String(env.ROSALENA_MODEL_DIRS ?? "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
  const inHome = [
    join(home, ".lmstudio", "models"), // LM Studio 0.3+
    join(home, ".cache", "lm-studio", "models"), // LM Studio before 0.3
    join(home, "models"),
    join(home, "Models"),
    join(home, ".rosalena", "models"),
  ];
  const onDrives = drives.flatMap((root) => [join(root, "Models"), join(root, "models"), join(root, "AI", "Models"), join(root, "LLM", "models")]);
  return [...fromEnv, ...inHome, ...onDrives];
}

const serverName = (platform) => (platform === "win32" ? "llama-server.exe" : "llama-server");

/** Folders llama.cpp is commonly unpacked into, plus every folder on PATH. Not filtered. */
export function serverDirCandidates({ env = process.env, platform = process.platform, home = homedir(), drives = driveRoots({ platform }) } = {}) {
  const local = env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "llama.cpp"), join(env.LOCALAPPDATA, "Programs", "llama.cpp")] : [];
  // ~/.rosalena/llama.cpp is where the starter-model setup unpacks its runner.
  const inHome = [join(home, "llama.cpp"), join(home, "llama.cpp", "build", "bin"), join(home, ".rosalena", "llama.cpp")];
  const onDrives = drives.flatMap((root) => [join(root, "llama.cpp"), join(root, "Tools", "llama.cpp"), join(root, "AI", "llama.cpp")]);
  // The PATH of the platform being asked about, not of the machine running this.
  const onPath = String(env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((s) => s.trim())
    .filter(Boolean);
  const unix = platform === "win32" ? [] : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
  return [...local, ...inHome, ...onDrives, ...unix, ...onPath];
}

function uniqueExisting(paths, test) {
  const seen = new Set();
  const out = [];
  for (const path of paths) {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (test(path)) out.push(path);
  }
  return out;
}

function detect() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const platform = process.platform;
  const drives = driveRoots({ platform });
  const modelDirs = uniqueExisting(modelDirCandidates({ platform, drives }), isDir);
  const name = serverName(platform);
  const explicit = String(process.env.ROSALENA_LLAMA_SERVER ?? "").trim();
  const binaries = uniqueExisting(
    [...(explicit ? [explicit] : []), ...serverDirCandidates({ platform, drives }).map((dir) => join(dir, name))],
    isFile,
  );
  cache = { at: Date.now(), modelDirs, binaries };
  return cache;
}

/** Model folders that exist on this machine, best first. May be empty. */
export function detectModelDirs() {
  return [...detect().modelDirs];
}

/** Folders that hold a llama-server on this machine. May be empty. */
export function detectServerRoots() {
  return detect().binaries.map((file) => file.slice(0, file.length - serverName(process.platform).length - 1));
}

/**
 * The llama-server to start: the first one found, or the bare name so a server that is
 * only on PATH (or not installed) produces an honest "not found" when used.
 */
export function detectServerBinary() {
  return detect().binaries[0] ?? serverName(process.platform);
}

/** Drop the cache, for tests and for a "measure again" button. */
export function resetLocalPathCache() {
  cache = null;
}
