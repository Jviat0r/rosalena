#!/usr/bin/env node
/**
 * Assemble the app payload for electron-builder.
 *
 * The repo is not the app. The repo is a working tree with probes, tests, a 254 MB
 * Python virtualenv and a 399 MB `desktop\node_modules`; the app is a small, exact set
 * of files laid out so that every path the engine resolves at runtime still resolves
 * inside the app. This script is that set, written down once, in one place.
 *
 * Layout it produces (build/release/app):
 *
 *   package.json                 generated, `main: "desktop/main.mjs"`
 *   desktop/main.mjs             Electron entry (imports ../harness/src/ui.mjs)
 *   desktop/preload.mjs
 *   harness/src/**               the engine
 *   harness/src/voice/**         capture scripts, WITHOUT the virtualenv
 *   harness/ui/**                the page and its assets
 *   harness/data/model-catalog.json
 *   harness/data/llama-runtime.json
 *   harness/data/media-models.json
 *   harness/data/whisper-runtime.json
 *   harness/data/node-runtime.json
 *   harness/data/comfy-workflows/*.json
 *   harness/harness.config.json  neutral, no machine paths
 *   harness/plugins/**           plugin.json + plugin.mjs, no install lock
 *   harness/store/**             module registry
 *   router/**                    extraResources source (separate process)
 *   build/icon.ico               Windows icon
 *   build/icon.icns              macOS icon
 *   build/icons/<N>x<N>.png      Linux icon set
 *   build/entitlements.mac.plist macOS hardened-runtime entitlements
 *
 * Why the layout is flat rather than everything under resources/: `desktop/main.mjs`
 * does `await import("../harness/src/ui.mjs")`, and `ui.mjs`, `plugins.mjs`,
 * `catalog.mjs`, `store.mjs` and `voice.mjs` each resolve their siblings from
 * `import.meta.url`. Any other layout breaks the app at start-up. See README section 1.4.
 *
 * Usage:
 *   node stage.mjs                 assemble the app directory
 *   node stage.mjs --check         verify every source path exists, write nothing
 *   node stage.mjs --print-version print the version the build would use
 *   node stage.mjs --out <dir>     assemble somewhere else
 *
 * Version: RELEASE_VERSION, then INPUT_VERSION, then desktop/package.json.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const DEFAULT_OUT = resolve(REPO, "build", "release", "app");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const CHECK_ONLY = flag("--check");
const PRINT_VERSION = flag("--print-version");
const OUT = valueOf("--out") ? resolve(valueOf("--out")) : DEFAULT_OUT;

// ---------------------------------------------------------------- what ships, and how

const SKIP_ALWAYS = new Set(["node_modules", "__pycache__", ".DS_Store", "Thumbs.db", ".git"]);

/** Copy a whole tree, minus the things that must never ship. */
const TREES = [
  {
    id: "harness/src",
    from: "harness/src",
    to: "harness/src",
    required: true,
    // Engine modules only, plus the voice capture scripts. voice/.venv is a local
    // 254 MB virtualenv: excluded by SKIP_ALWAYS via the directory rule below.
    file: (rel) =>
      rel.endsWith(".mjs") ||
      /^voice\/(README\.md|transcribe\.py|setup\.ps1|selftest\.ps1|win-speech\.ps1)$/.test(rel),
    skipDir: new Set(["voice/.venv", "voice/__pycache__", "test", ".scratch"]),
    why: "the engine; main.mjs imports ui.mjs from here",
  },
  {
    id: "harness/ui",
    from: "harness/ui",
    to: "harness/ui",
    required: true,
    file: () => true,
    why: "the page the window loads (UI_DIR = <harness>/ui)",
  },
  {
    id: "harness/plugins",
    from: "harness/plugins",
    to: "harness/plugins",
    required: true,
    // store.lock.json is this machine's install state, not part of the product.
    file: (rel) => rel !== "store.lock.json",
    why: "plugin.json + plugin.mjs for every plugin (<harness>/plugins)",
  },
  {
    id: "harness/plugin-libs",
    from: "harness/plugin-libs",
    to: "harness/plugin-libs",
    required: true,
    file: () => true,
    why: "three.js and pdf.js for sidebar plugins, served at /plugin-lib (ui-plugins.mjs: PLUGIN_LIBS_DIR)",
  },
  {
    id: "harness/store/modules",
    from: "harness/store/modules",
    to: "harness/store/modules",
    required: true,
    file: () => true,
    why: "modules the plugin store index points at",
  },
  {
    id: "harness/skills",
    from: "harness/skills",
    to: "harness/skills",
    required: true,
    // A skill's scripts install their own packages on first use; none are shipped.
    file: (rel) => !rel.split(/[\\/]/).includes("node_modules"),
    why: "the skills that ship with the app (the skill tool reads <harness>/skills)",
  },
  {
    id: "router",
    from: "router",
    to: "router",
    required: true,
    // The router ships as extraResources: code, config and its own package.json only.
    // data/ (API keys), logs/ (request logs hold prompts), state/ (usage ledger),
    // test/ and scripts/ never leave this machine.
    file: (rel) => /^src\/[^/]+\.mjs$/.test(rel) || ["package.json", "router.config.json", "README.md"].includes(rel),
    skipDir: new Set(["test", "logs", "state", "data", "scripts", "node_modules"]),
    why: "the model router: started by main.mjs as a child of the app (extraResources)",
  },
];

/** The PNG sizes in packaging/assets/icon that become the Linux hicolor icon set. */
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

/** Single files, dest relative to the app root. */
const FILES = [
  { id: "desktop/main.mjs", from: "desktop/main.mjs", to: "desktop/main.mjs", required: true, why: "Electron entry" },
  { id: "desktop/preload.mjs", from: "desktop/preload.mjs", to: "desktop/preload.mjs", required: true, why: "window bridge" },
  // Imported by main.mjs at the top of the file: leaving either one out is a packaged app
  // that dies before its window exists ("Cannot find module").
  { id: "desktop/menu.mjs", from: "desktop/menu.mjs", to: "desktop/menu.mjs", required: true, why: "application menu template" },
  { id: "desktop/notify.mjs", from: "desktop/notify.mjs", to: "desktop/notify.mjs", required: true, why: "system notifications (Settings > Notifications)" },
  { id: "desktop/router-supervisor.mjs", from: "desktop/router-supervisor.mjs", to: "desktop/router-supervisor.mjs", required: true, why: "starts and stops the router" },
  { id: "desktop/updater.mjs", from: "desktop/updater.mjs", to: "desktop/updater.mjs", required: true, why: "checks, downloads, verifies and installs updates" },
  { id: "harness/data", from: "harness/data/model-catalog.json", to: "harness/data/model-catalog.json", required: true, why: "model catalog" },
  { id: "harness/data/llama-runtime.json", from: "harness/data/llama-runtime.json", to: "harness/data/llama-runtime.json", required: true, why: "pinned llama.cpp builds the starter-model setup downloads" },
  { id: "harness/data/media-models.json", from: "harness/data/media-models.json", to: "harness/data/media-models.json", required: true, why: "image, video and voice models the Models page downloads" },
  { id: "harness/data/whisper-runtime.json", from: "harness/data/whisper-runtime.json", to: "harness/data/whisper-runtime.json", required: true, why: "pinned whisper.cpp builds for dictation with downloaded Whisper models" },
  { id: "harness/data/student-programs.json", from: "harness/data/student-programs.json", to: "harness/data/student-programs.json", required: true, why: "the free and student API-key programs in Settings > Cloud models" },
  { id: "harness/data/node-runtime.json", from: "harness/data/node-runtime.json", to: "harness/data/node-runtime.json", required: true, why: "pinned Node.js builds the OmniRoute install fetches on a PC without Node" },
  ...["checkpoint-image", "qwen-image", "wan22-ti2v", "wan21-t2v"].map((name) => ({
    id: `harness/data/comfy-workflows/${name}.json`,
    from: `harness/data/comfy-workflows/${name}.json`,
    to: `harness/data/comfy-workflows/${name}.json`,
    required: true,
    why: "built-in ComfyUI graph for a downloaded image or video model",
  })),
  { id: "harness/store/index.json", from: "harness/store/index.json", to: "harness/store/index.json", required: true, why: "plugin store index" },
  { id: "build/icon.ico", from: "packaging/assets/rosalena.ico", to: "build/icon.ico", required: true, why: "Windows icon (electron-builder buildResources)" },
  { id: "build/icon.icns", from: "packaging/assets/rosalena.icns", to: "build/icon.icns", required: true, why: "macOS icon (electron-builder buildResources)" },
  // Linux: electron-builder reads an icon *folder* of <N>x<N>.png files (linux.icon:
  // build/icons in electron-builder.linux.yml); the .deb installs them as the hicolor set
  // and the AppImage carries them inside.
  ...LINUX_ICON_SIZES.map((size) => ({
    id: `build/icons/${size}x${size}.png`,
    from: `packaging/assets/icon/rosalena-${size}.png`,
    to: `build/icons/${size}x${size}.png`,
    required: true,
    why: "Linux icon set (electron-builder linux.icon)",
  })),
  // The router's identity prompt. router.config.json reads it as
  // `../data/prompts/rosalena.md`, and router/src/persona.mjs exits 2 when it is missing,
  // so a build without it is a build whose router cannot start at all. It lands beside the
  // router's extraResources root (<resources>/data/prompts/rosalena.md), which is exactly
  // where `../data/prompts` points from <resources>/router/router.config.json.
  { id: "data/prompts", from: "data/prompts/rosalena.md", to: "data/prompts/rosalena.md", required: true, why: "router persona prompt (systemPromptFile)" },
  { id: "build/entitlements.mac.plist", from: "packaging/release/entitlements.mac.plist", to: "build/entitlements.mac.plist", required: true, why: "hardened-runtime entitlements" },
];

/**
 * The repo's harness.config.json carries this machine's absolute paths
 * (`D:\Models`, `D:\llama.cpp`, ContentFarm workflow files). Shipping it would point
 * every user at folders that do not exist, so the release gets a neutral default and
 * each plugin falls back to its own plugin.json.
 */
const NEUTRAL_CONFIG = {
  $comment:
    "Release default written by packaging/release/stage.mjs: no machine-specific paths. Each plugin falls back to its own plugin.json defaults. Point local-llm and comfyui at your own folders, or replace this file with your own config.",
  plugins: {},
};

// --------------------------------------------------------------------- small helpers

const toPosix = (p) => p.split(sep).join("/");

async function walk(absDir, relDir, entry, out) {
  const names = await readdir(absDir, { withFileTypes: true });
  for (const dirent of names) {
    const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
    const abs = join(absDir, dirent.name);
    if (SKIP_ALWAYS.has(dirent.name)) continue;
    if (dirent.isDirectory()) {
      if (entry.skipDir?.has(rel)) continue;
      await walk(abs, rel, entry, out);
      continue;
    }
    if (!dirent.isFile()) continue;
    if (entry.file && !entry.file(rel)) continue;
    out.push({ rel, abs });
  }
}

async function version() {
  const forced = (process.env.RELEASE_VERSION || process.env.INPUT_VERSION || "").trim().replace(/^v/, "");
  if (forced) {
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(forced)) {
      throw new Error(`version "${forced}" is not a semver version (from RELEASE_VERSION/INPUT_VERSION)`);
    }
    return forced;
  }
  const pkg = JSON.parse(await readFile(join(REPO, "desktop", "package.json"), "utf8"));
  if (!pkg.version) throw new Error("desktop/package.json has no version");
  return pkg.version;
}

async function electronRange() {
  try {
    const pkg = JSON.parse(await readFile(join(REPO, "desktop", "package.json"), "utf8"));
    return pkg.devDependencies?.electron ?? null;
  } catch {
    return null;
  }
}

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// ------------------------------------------------------------------------- the checks

async function verify() {
  const missing = [];
  const found = [];
  for (const entry of [...TREES, ...FILES]) {
    const abs = resolve(REPO, entry.from);
    if (existsSync(abs)) found.push(entry);
    else missing.push(`  MISSING  ${entry.from}  (${entry.why})`);
  }
  for (const entry of [...TREES, ...FILES]) {
    if (!entry.required) continue;
    if (!existsSync(resolve(REPO, entry.from))) missing.push(`  REQUIRED ${entry.from}`);
  }
  return { found, missing: [...new Set(missing)] };
}

// ------------------------------------------------------------------------ the staging

async function stage() {
  const v = await version();
  const el = await electronRange();

  const outIsSafe =
    OUT !== REPO &&
    toPosix(OUT).includes("/build/release/") &&
    !toPosix(OUT).endsWith("/build/release/");
  if (!outIsSafe) {
    fail([`refusing to stage into ${OUT}`, "  the output must be a directory below <repo>/build/release/"]);
  }

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  const rows = [];
  for (const entry of TREES) {
    const srcRoot = resolve(REPO, entry.from);
    const files = [];
    await walk(srcRoot, "", entry, files);
    if (files.length === 0) {
      fail([`  EMPTY    ${entry.from} produced no files (${entry.why})`, "  refusing to build an app with a missing tree"]);
    }
    for (const file of files) {
      const dest = join(OUT, entry.to, file.rel);
      await mkdir(dirname(dest), { recursive: true });
      const body = await readFile(file.abs);
      await writeFile(dest, body);
      rows.push({ kind: "tree", id: entry.id, path: `${entry.to}/${file.rel}`, bytes: body.length });
    }
  }

  for (const entry of FILES) {
    const src = resolve(REPO, entry.from);
    const body = await readFile(src);
    const dest = join(OUT, entry.to);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, body);
    rows.push({ kind: "file", id: entry.id, path: entry.to, bytes: body.length });
  }

  // The app manifest electron-builder reads. desktop/package.json is never modified.
  const appPkg = {
    name: "rosalena-harness",
    productName: "Rosalena Harness",
    version: v,
    private: true,
    description: "The Rosalena Harness desktop app: an Electron window around the local agent runtime and model router.",
    license: "UNLICENSED",
    main: "desktop/main.mjs",
  };
  if (el) appPkg.devDependencies = { electron: el };
  await writeFile(join(OUT, "package.json"), `${JSON.stringify(appPkg, null, 2)}\n`);
  rows.push({ kind: "generated", id: "package.json", path: "package.json", bytes: 0 });

  await mkdir(join(OUT, "harness"), { recursive: true });
  await writeFile(join(OUT, "harness", "harness.config.json"), `${JSON.stringify(NEUTRAL_CONFIG, null, 2)}\n`);
  rows.push({ kind: "generated", id: "harness.config.json", path: "harness/harness.config.json", bytes: 0 });

  return { v, rows };
}

function report(rows, v) {
  const trees = new Map();
  for (const row of rows) {
    const agg = trees.get(row.id) ?? { files: 0, bytes: 0 };
    agg.files += 1;
    agg.bytes += row.bytes;
    trees.set(row.id, agg);
  }
  console.log(`Rosalena Harness ${v} - app payload`);
  console.log(`  output  ${OUT}`);
  console.log("");
  console.log(`  ${"resource".padEnd(30)}${"files".padStart(6)}${"bytes".padStart(12)}`);
  for (const [id, agg] of trees) {
    console.log(`  ${id.padEnd(30)}${String(agg.files).padStart(6)}${String(agg.bytes).padStart(12)}`);
  }
  const files = rows.length;
  const bytes = rows.reduce((n, r) => n + r.bytes, 0);
  console.log(`  ${"TOTAL".padEnd(30)}${String(files).padStart(6)}${String(bytes).padStart(12)}`);
  console.log("");
}

// ------------------------------------------------------------------------------ main

const { missing } = await verify();
if (missing.length) fail(["resource map check failed:", ...missing, ""]);

if (PRINT_VERSION) {
  console.log(await version());
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log(`resource map: every source path exists (${TREES.length} trees, ${FILES.length} files)`);
  for (const entry of [...TREES, ...FILES]) {
    const abs = resolve(REPO, entry.from);
    const s = await stat(abs);
    const size = s.isDirectory() ? "" : `${s.size} bytes`;
    console.log(`  ok  ${entry.from.padEnd(40)}${size}`);
  }
  console.log(`version: ${await version()}`);
  console.log("wrote nothing (--check)");
  process.exit(0);
}

const { v, rows } = await stage();
report(rows, v);
const excluded = [
  "desktop/node_modules",
  "harness/src/voice/.venv",
  "harness/test",
  "harness/.scratch",
  "harness/plugins/store.lock.json",
  "router/data",
  "router/logs",
  "router/state",
  "site",
  "docs",
];
console.log(`never shipped: ${excluded.join(", ")}`);
console.log("");
console.log(`next: node build.mjs win   (or: node build.mjs mac, node build.mjs linux)`);
