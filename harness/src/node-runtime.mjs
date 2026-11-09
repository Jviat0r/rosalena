/**
 * Node.js for the things Rosalena installs that run on Node (OmniRoute), on a PC without it.
 *
 * Electron carries Node, but not one OmniRoute can live on: its native modules
 * (better-sqlite3, sharp) are built for a plain Node's ABI, and Electron ships no npm. So
 * when the PC has no Node, the official build pinned in data/node-runtime.json is
 * downloaded (about 34-58 MB), checked against nodejs.org's sha256 and unpacked into
 * ~/.rosalena/node, the same way the llama.cpp runner is (starter-model.mjs). It is
 * Rosalena's own: nothing goes on the system PATH and no admin rights are needed. A PC
 * that already has Node keeps using its own.
 *
 *   ~/.rosalena/node/node.exe + node_modules/npm/        (Windows zip layout)
 *   ~/.rosalena/node/bin/node + lib/node_modules/npm/    (macOS and Linux)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { downloadVerified, extractArchive, findFile, starterHome } from "./starter-model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const NODE_RUNTIME_PATH = resolve(HERE, "..", "data", "node-runtime.json");

export function loadNodeRuntime(path = NODE_RUNTIME_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** `win32-x64`, `darwin-arm64`...: the asset key for this machine. */
export const nodeRuntimeKey = ({ platform = process.platform, arch = process.arch } = {}) => `${platform}-${arch}`;

/** The pinned download for this machine, or null when there is none for it. */
export function nodeAsset({ runtime = null, key = nodeRuntimeKey() } = {}) {
  try {
    return (runtime ?? loadNodeRuntime()).assets?.[key] ?? null;
  } catch {
    return null;
  }
}

export const nodeHome = (root = starterHome()) => join(root, "node");

/** Rosalena's own Node, when it is installed: the node binary and npm's and npx's scripts. */
export function privateNode({ dir = nodeHome(), platform = process.platform, exists = existsSync } = {}) {
  const windows = platform === "win32";
  const node = windows ? join(dir, "node.exe") : join(dir, "bin", "node");
  const npmRoot = windows ? join(dir, "node_modules", "npm") : join(dir, "lib", "node_modules", "npm");
  const npmCli = join(npmRoot, "bin", "npm-cli.js");
  const npxCli = join(npmRoot, "bin", "npx-cli.js");
  if (!exists(node) || !exists(npmCli)) return null;
  return { node, npmCli, npxCli, binDir: dirname(node) };
}

/** `node -v` from the PATH, or null. */
export function systemNodeVersion(run = spawnSync) {
  const result = run("node", ["-v"], { encoding: "utf8", windowsHide: true, timeout: 15000, shell: process.platform === "win32" });
  const version = String(result?.stdout ?? "").trim();
  return result?.status === 0 && /^v\d+\./.test(version) ? version : null;
}

/**
 * How to run node, npm and npx here: the PC's own (`source: "system"`), Rosalena's
 * (`"rosalena"`), or null when neither exists yet. `command(tool, args)` gives the
 * [file, args, options] to spawn: the system's through the shell on Windows (npm is a
 * .cmd there), Rosalena's straight through its node.exe, which needs no shell and so no
 * quoting of a user folder with a space in it.
 */
export function nodeTools({ npm, dir = nodeHome(), platform = process.platform } = {}) {
  if (npm?.()) {
    const shell = platform === "win32";
    return {
      source: "system",
      node: "node",
      command: (tool, args) => [tool, args, { shell }],
      env: (env = process.env) => env,
    };
  }
  const own = privateNode({ dir, platform });
  if (!own) return null;
  const sep = platform === "win32" ? ";" : ":";
  const pathKey = platform === "win32" ? "Path" : "PATH";
  return {
    source: "rosalena",
    node: own.node,
    command: (tool, args) => (tool === "node" ? [own.node, args, { shell: false }] : [own.node, [tool === "npx" ? own.npxCli : own.npmCli, ...args], { shell: false }]),
    // Install scripts call `node` by name, so Rosalena's comes first on the PATH they see.
    env: (env = process.env) => {
      const current = env.PATH ?? env.Path ?? "";
      const { PATH: _p, Path: _P, ...rest } = env;
      return { ...rest, [pathKey]: `${own.binDir}${sep}${current}` };
    },
  };
}

/** Download, check and unpack the pinned Node into `<root>/node`. */
export async function installNodeRuntime({ root = starterHome(), runtime = null, key = nodeRuntimeKey(), fetchImpl = fetch, extract = extractArchive, onProgress = () => {}, signal } = {}) {
  const asset = nodeAsset({ runtime, key });
  if (!asset) throw new Error(`there is no Node.js download for this machine (${key})`);
  const archive = join(root, "downloads", asset.name);
  await downloadVerified({ url: asset.url, dest: archive, bytes: asset.bytes, sha256: asset.sha256, fetchImpl, signal, onProgress });
  const staging = join(root, "node.new");
  rmSync(staging, { recursive: true, force: true });
  await extract(archive, staging);
  const exe = key.startsWith("win32") ? "node.exe" : "node";
  const binary = findFile(staging, exe, 3);
  if (!binary) throw new Error(`${asset.name} did not contain ${exe}`);
  // The archive holds one folder (node-v24.22.1-win-x64/); that folder becomes ~/.rosalena/node.
  const folder = key.startsWith("win32") ? dirname(binary) : dirname(dirname(binary));
  const target = join(root, "node");
  rmSync(target, { recursive: true, force: true });
  renameSync(folder, target);
  rmSync(staging, { recursive: true, force: true });
  rmSync(archive, { force: true });
  return { target, version: (runtime ?? loadNodeRuntime()).version };
}
