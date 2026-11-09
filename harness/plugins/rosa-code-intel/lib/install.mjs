// Finding the external tools code-intel drives, and installing the npm ones on first use.
//
// Order for every tool: the person's own install on PATH first (their version, their
// config), then a copy this plugin installed earlier, then - for the npm ones only - an
// `npm install` into the plugin's tool folder. That folder is in the harness home
// (<ROSALENA_HOME or ~/.rosalena>/code-intel), not inside the app: the installed app's
// files can be read-only and are replaced on every update, and node_modules never ships
// in a release (packaging/release/stage.mjs skips it).
//
// Windows: an npm package's .bin entry is a .cmd shim, and spawn() without a shell cannot
// run a .cmd. So nothing here runs a shim: ast-grep is the real ast-grep.exe from the
// platform package, the language servers are their JS entry run with node, and a .cmd
// found on PATH is unwrapped to the script it calls.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

/** Pinned so a first-use install is the version these tools were tested with. */
export const PACKAGES = Object.freeze({
  "@ast-grep/cli": "0.51.1",
  "typescript-language-server": "6.0.3",
  // tsserver (5.x). TypeScript 7 is the Go port and has no tsserver.js for the server above.
  typescript: "5.9.3",
});

export function toolsHome(config = {}) {
  if (config.toolsDir) return resolve(String(config.toolsDir));
  if (process.env.ROSALENA_CODE_INTEL_DIR) return resolve(process.env.ROSALENA_CODE_INTEL_DIR);
  return join(process.env.ROSALENA_HOME || join(homedir(), ".rosalena"), "code-intel");
}

const IS_WIN = process.platform === "win32";

/** Full path of a command on PATH (with PATHEXT on Windows), or null. */
export function which(name, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts = IS_WIN ? ["", ...String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (IS_WIN && ext === "") continue; // a bare name on Windows is not runnable
      const full = join(dir.replace(/^"|"$/g, ""), name + ext);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * A node to run JS tools with: `node` on PATH, else this process (which is Electron in the
 * desktop app, and runs as node with ELECTRON_RUN_AS_NODE).
 */
export function nodeRuntime() {
  const onPath = which("node");
  if (onPath) return { command: onPath, env: {} };
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
}

/**
 * How to spawn `name` found on PATH, without a shell: an .exe directly, an npm .cmd shim
 * as `node <the script it wraps>`. Returns { command, args, env } or null.
 */
export function resolveCommand(name) {
  const found = which(name);
  if (!found) return null;
  if (!IS_WIN || /\.(exe|com)$/i.test(found)) return { command: found, args: [], env: {} };
  if (/\.(cmd|bat)$/i.test(found)) {
    try {
      const text = readFileSync(found, "utf8");
      // npm's shim: "%_prog%"  "%dp0%\node_modules\pkg\bin\x.js" %*
      const m = /"%dp0%\\([^"]+?\.(?:c|m)?js)"/i.exec(text);
      if (m) {
        const script = join(dirname(found), m[1]);
        if (existsSync(script)) {
          const node = nodeRuntime();
          return { command: node.command, args: [script], env: node.env };
        }
      }
    } catch {
      /* unreadable shim: fall through */
    }
    // Not an npm shim: run it through cmd.exe explicitly (still no shell: true).
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", found], env: {} };
  }
  return null;
}

/** Is `pkg` installed in the tool folder at the pinned version? */
export function installedVersion(home, pkg) {
  try {
    return JSON.parse(readFileSync(join(home, "node_modules", ...pkg.split("/"), "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** npm's own CLI script beside the node that will run it, so no npm.cmd is involved. */
function npmCli() {
  const node = nodeRuntime();
  const candidates = [
    join(dirname(node.command), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(node.command), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const cli = candidates.find((c) => existsSync(c));
  return cli ? { ...node, cli } : null;
}

let queue = Promise.resolve();

/**
 * Install the packages (name -> version) into the tool folder unless they are there
 * already. Installs run one at a time per process. Resolves to { installed: [...], ms },
 * or throws with npm's own error text.
 */
export function ensurePackages(pkgs, { home = toolsHome(), log = () => {}, timeoutMs = 5 * 60_000 } = {}) {
  const job = queue.then(async () => {
    const missing = Object.entries(pkgs).filter(([name, version]) => installedVersion(home, name) !== version);
    if (!missing.length) return { installed: [], ms: 0 };
    const npm = npmCli();
    if (!npm) throw new Error("npm was not found next to node, so the tool cannot be installed. Install Node.js (it includes npm), or put the tool on PATH");
    mkdirSync(home, { recursive: true });
    const manifest = join(home, "package.json");
    if (!existsSync(manifest)) {
      writeFileSync(manifest, `${JSON.stringify({ name: "rosalena-code-intel-tools", private: true, description: "Tools the code-intel plugin installed on first use. Safe to delete; they are reinstalled when needed." }, null, 2)}\n`);
    }
    const specs = missing.map(([name, version]) => `${name}@${version}`);
    log(`installing ${specs.join(", ")} into ${home}`);
    const started = Date.now();
    await new Promise((resolvePromise, reject) => {
      const child = spawn(npm.command, [npm.cli, "install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", ...specs], {
        cwd: home,
        env: { ...process.env, ...npm.env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`npm install timed out after ${Math.round(timeoutMs / 1000)} s (offline?)`));
      }, timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else reject(new Error(`npm install ${specs.join(" ")} failed (exit ${code}): ${out.trim().split("\n").slice(-6).join(" | ")}`));
      });
    });
    return { installed: specs, ms: Date.now() - started };
  });
  queue = job.catch(() => {});
  return job;
}

// --------------------------------------------------------------------------- ast-grep

/** The platform package that carries the real ast-grep binary. */
export function astGrepPlatformPackage(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return `@ast-grep/cli-win32-${arch}-msvc`;
  if (platform === "darwin") return `@ast-grep/cli-darwin-${arch}`;
  return `@ast-grep/cli-linux-${arch}-gnu`;
}

function installedAstGrep(home) {
  const exe = IS_WIN ? "ast-grep.exe" : "ast-grep";
  const bin = join(home, "node_modules", ...astGrepPlatformPackage().split("/"), exe);
  return existsSync(bin) ? bin : null;
}

/** ast-grep without installing: PATH (ast-grep, then sg if it is ast-grep), then the tool folder. */
export function findAstGrep(home = toolsHome()) {
  const exeOnly = (name) => {
    const r = resolveCommand(name);
    return r && r.args.length === 0 ? r.command : null; // only a real binary; a wrapper script may be anything
  };
  const onPath = exeOnly("ast-grep");
  if (onPath) return { bin: onPath, source: "PATH" };
  const local = installedAstGrep(home);
  if (local) return { bin: local, source: home };
  // `sg` on Linux is often shadow-utils' setgroups; only trust it when it is ast-grep.
  const sg = exeOnly("sg");
  if (sg && /[\\/]@ast-grep[\\/]|ast-grep/i.test(sg)) return { bin: sg, source: "PATH" };
  return null;
}

export async function ensureAstGrep({ home = toolsHome(), log } = {}) {
  const found = findAstGrep(home);
  if (found) return { ...found, installed: [] };
  const res = await ensurePackages({ "@ast-grep/cli": PACKAGES["@ast-grep/cli"] }, { home, log });
  const bin = installedAstGrep(home);
  if (!bin) throw new Error(`@ast-grep/cli installed, but ${astGrepPlatformPackage()} (the binary) did not: this platform may not be supported`);
  return { bin, source: home, installed: res.installed, ms: res.ms };
}

// --------------------------------------------------------------------------- TypeScript server

function installedTsServer(home) {
  const cli = join(home, "node_modules", "typescript-language-server", "lib", "cli.mjs");
  const tsLib = join(home, "node_modules", "typescript", "lib");
  return existsSync(cli) && existsSync(join(tsLib, "tsserver.js")) ? { cli, tsLib } : null;
}

/** The TypeScript/JavaScript language server, installing it on first use. */
export async function ensureTsServer({ home = toolsHome(), log } = {}) {
  const onPath = resolveCommand("typescript-language-server");
  const local = installedTsServer(home);
  if (onPath && !local) {
    // Their own install. tsserver comes from the workspace's typescript, or theirs.
    return { command: onPath.command, args: [...onPath.args, "--stdio"], env: onPath.env, tsLib: null, source: "PATH", installed: [] };
  }
  let installed = [];
  let ms = 0;
  if (!local) {
    const res = await ensurePackages(
      { "typescript-language-server": PACKAGES["typescript-language-server"], typescript: PACKAGES.typescript },
      { home, log },
    );
    installed = res.installed;
    ms = res.ms;
  }
  const ready = installedTsServer(home);
  if (!ready) throw new Error("typescript-language-server did not install correctly");
  const node = nodeRuntime();
  return { command: node.command, args: [ready.cli, "--stdio"], env: node.env, tsLib: ready.tsLib, source: home, installed, ms };
}

/** Is the TypeScript server available without installing anything? */
export function hasTsServer(home = toolsHome()) {
  return Boolean(installedTsServer(home) || which("typescript-language-server"));
}
