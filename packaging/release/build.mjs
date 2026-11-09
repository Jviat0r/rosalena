#!/usr/bin/env node
/**
 * Build one platform, from the staged app directory.
 *
 *   node build.mjs win
 *   node build.mjs mac
 *   node build.mjs mac --sign "Developer ID Application: Name (TEAMID)"
 *   node build.mjs linux          (Linux host only: AppImage + .deb, x64)
 *
 * The staged directory created by stage.mjs is the electron-builder *project
 * directory*, so `files` and `extraResources` in both YAML configs are relative to the
 * app layout, not to this folder. electron-builder is invoked from there with the config
 * file passed by absolute path.
 *
 * `--publish never` is always passed: electron-builder must never decide on its own to
 * push a release. Publishing is the workflow's job, or yours, deliberately.
 *
 * Signing:
 *   Windows - driven by the CSC_LINK / CSC_KEY_PASSWORD environment variables, which the
 *             workflow fills from WIN_CERT_PFX / WIN_CERT_PASSWORD. Nothing to do here.
 *   macOS   - the config says `identity: null` (the honest unsigned default). `--sign`
 *             overrides it and turns on electron-builder's notarization, which reads
 *             APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const APP = resolve(REPO, "build", "release", "app");
const DIST = resolve(APP, "dist");

const args = process.argv.slice(2);
const platform = args.find((a) => a === "win" || a === "mac" || a === "linux");
const signIndex = args.indexOf("--sign");
const signIdentity = signIndex >= 0 ? args[signIndex + 1] : null;

if (!platform) {
  console.error("usage: node build.mjs <win|mac|linux> [--sign \"<identity>\"]");
  process.exit(2);
}

const CONFIG = {
  win: "electron-builder.win.yml",
  mac: "electron-builder.mac.yml",
  linux: "electron-builder.linux.yml",
};

const LABEL = { win: "Windows", mac: "macOS", linux: "Linux" };

// The .deb is assembled by fpm and the AppImage by mksquashfs: Linux tools, so a Linux host
// (the `linux` job in release.yml, ubuntu-latest) is the only place these files come from.
if (platform === "linux" && process.platform !== "linux") {
  console.error(
    [
      "refusing to build Linux on " + process.platform,
      "  an AppImage and a .deb can only be produced on a Linux host. Use the `linux` job in",
      "  .github/workflows/release.yml (ubuntu-latest) or a Linux machine.",
      "  Nothing was built.",
    ].join("\n"),
  );
  process.exit(1);
}

if (platform === "mac" && process.platform !== "darwin") {
  console.error(
    [
      "refusing to build macOS on " + process.platform,
      "  a .dmg can only be produced by a macOS host. Use the `macos` job in",
      "  .github/workflows/release.yml (macos-14) or a real Mac.",
      "  Nothing was built. No macOS artifact exists on this machine.",
    ].join("\n"),
  );
  process.exit(1);
}

if (!existsSync(APP)) {
  console.error(`no staged app at ${APP}\n  run: node stage.mjs`);
  process.exit(1);
}

const configPath = join(HERE, CONFIG[platform]);

// electron-builder arguments. The arch flags are explicit even though both YAML configs
// also list them, because an explicit flag is what a reader of a build log checks.
const ebArgs = [
  "--config",
  configPath,
  `--${platform}`,
  "--publish",
  "never",
];

if (platform === "win" || platform === "linux") {
  ebArgs.push("--x64");
} else {
  ebArgs.push("--arm64", "--x64");
  if (signIdentity) {
    ebArgs.push(`-c.mac.identity=${signIdentity}`, "-c.mac.notarize=true");
  } else {
    ebArgs.push("-c.mac.identity=null", "-c.mac.notarize=false");
  }
}

const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: signIdentity ? "true" : "false" };

if (platform === "win" && !process.env.CSC_LINK) {
  console.log("note: CSC_LINK is not set - the Windows installer will be unsigned and");
  console.log("      SmartScreen will show \"Unknown publisher\". See README section 3.\n");
}
if (platform === "mac" && !signIdentity) {
  console.log("note: building unsigned (identity: null). The app works once the quarantine");
  console.log("      bit is removed: xattr -dr com.apple.quarantine \"/Applications/Rosalena Harness.app\"\n");
}

// A locally installed electron-builder first; npx --no-install as a fallback. --no-install
// is deliberate: this script must never start a package download of its own.
//
// The local copy is run as `node cli.js`, not through node_modules/.bin. On Windows that
// entry is a .cmd batch file, so it can only be started with a shell, and cmd.exe re-splits
// a project path containing a space - "D:\AppDev\Rosalena Harness" became "D:\AppDev\Remote
// ..." and the build died with "'D:\AppDev\Rosalena' is not recognized". Running the
// JavaScript entry point needs no shell and no shim, and the path reaches Node intact.
const cli = join(HERE, "node_modules", "electron-builder", "cli.js");
const useLocal = existsSync(cli);
const command = useLocal ? process.execPath : "npx";
const commandArgs = useLocal ? [cli, ...ebArgs] : ["--no-install", "electron-builder", ...ebArgs];
const needsShell = !useLocal && process.platform === "win32";

console.log(`Rosalena Harness - ${LABEL[platform]} build`);
console.log(`  project ${APP}`);
console.log(`  config  ${configPath}`);
console.log(`  command ${command} ${commandArgs.join(" ")}`);
console.log("");

const child = spawnSync(command, commandArgs, {
  cwd: APP,
  stdio: "inherit",
  env,
  shell: needsShell,
});

if (child.error) {
  console.error(`could not start electron-builder: ${child.error.message}`);
  console.error("  install the build tooling once:  cd packaging/release && npm install");
  process.exit(1);
}
if (child.status !== 0) {
  console.error(`electron-builder exited ${child.status}`);
  process.exit(child.status ?? 1);
}

// Report what was actually produced, with sizes and hashes measured here - the same
// numbers manifest.mjs will put in the download manifest.
const produced = [];
async function walk(dir) {
  if (!existsSync(dir)) return;
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (dirent.name.endsWith(".app")) {
        produced.push({ path: abs, dir: true });
        continue;
      }
      await walk(abs);
      continue;
    }
    if (/\.(exe|dmg|zip|msi|AppImage|deb)$/i.test(dirent.name)) produced.push({ path: abs, dir: false });
  }
}
await walk(DIST);

if (produced.length === 0) {
  console.error("electron-builder reported success but no artifact was found in dist/");
  process.exit(1);
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

console.log("");
console.log("artifacts");
for (const item of produced) {
  if (item.dir) {
    console.log(`  ${item.path}  (app bundle)`);
    continue;
  }
  const info = await stat(item.path);
  console.log(`  ${item.path}`);
  console.log(`    ${info.size} bytes  sha256 ${await sha256(item.path)}`);
}
console.log("");
console.log("next: node manifest.mjs --dir build/release/app/dist --version <v> --base-url <release url>");
