#!/usr/bin/env node
// Rebuilds store/index.json from the module trees on disk.
//
// The index carries a sha256 for every file it offers. Hand-maintaining those
// would be a lie waiting to happen: edit a module, forget the hash, and every
// install of it fails with a mismatch that looks like corruption. So the index
// is generated. Layout it reads:
//
//   store/modules/<id>/module.json                 optional: { description }
//   store/modules/<id>/<version>/plugin.json       a folder module
//   store/modules/<id>/<version>/plugin.mjs
//   store/modules/<id>/<version>/<id>.mjs          a single-file module
//
// `latest` is the highest version present, so adding a directory is all it
// takes to publish a version.
//
//   node store/build-index.mjs            regenerate and write
//   node store/build-index.mjs --check    exit 1 if index.json is out of date

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashFile, listTree } from "../src/store.mjs";

export const INDEX_PATH = fileURLToPath(new URL("./index.json", import.meta.url));
export const MODULES_DIR = fileURLToPath(new URL("./modules/", import.meta.url));

const cmpVersion = (a, b) => {
  const pa = String(a).split(".").map((n) => Number(n) || 0);
  const pb = String(b).split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta) return delta;
  }
  return 0;
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function buildIndex({ modulesDir = MODULES_DIR, name = "rosalena-store" } = {}) {
  const modules = {};
  const versions = {};
  if (!existsSync(modulesDir)) return { version: 1, name, modules };

  for (const id of readdirSync(modulesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const root = join(modulesDir, id);
    const versionDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(cmpVersion);
    if (!versionDirs.length) continue;

    const moduleMeta = readJson(join(root, "module.json")) ?? {};
    const entries = {};
    for (const version of versionDirs) {
      const dir = join(root, version);
      const files = listTree(dir);
      if (!files.length) throw new Error(`${id} ${version} is empty`);
      const manifest = files.includes("plugin.json") ? readJson(join(dir, "plugin.json")) : null;
      const shape = manifest ? "folder" : files.length === 1 && files[0] === `${id}.mjs` ? "file" : null;
      if (!shape) {
        throw new Error(
          `${id} ${version} is neither a folder module (plugin.json present) nor a single-file module (${id}.mjs only) - found: ${files.join(", ")}`,
        );
      }
      if (manifest && manifest.id !== id) throw new Error(`${id} ${version}/plugin.json declares id "${manifest.id}"`);
      if (manifest && manifest.version && String(manifest.version) !== version) {
        throw new Error(`${id} ${version}/plugin.json declares version "${manifest.version}"`);
      }
      entries[version] = {
        shape,
        source: `modules/${id}/${version}`,
        description: manifest?.description ?? moduleMeta.description ?? "",
        files: Object.fromEntries(files.map((rel) => [rel, hashFile(join(dir, rel))])),
      };
    }
    const latest = versionDirs[versionDirs.length - 1];
    modules[id] = { description: moduleMeta.description ?? entries[latest].description ?? "", latest, versions: entries };
    versions[id] = versionDirs;
  }
  return { version: 1, name, modules };
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direct) {
  const check = process.argv.includes("--check");
  const index = buildIndex({});
  const text = `${JSON.stringify(index, null, 2)}\n`;
  const ids = Object.keys(index.modules);
  const summary = ids.map((id) => `${id} ${index.modules[id].latest} (${Object.keys(index.modules[id].versions).length} version(s))`).join(", ");
  if (check) {
    const current = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, "utf8") : "";
    if (current !== text) {
      process.stderr.write(`store/index.json is out of date - run: node store/build-index.mjs\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`store/index.json is current: ${summary}\n`);
    }
  } else {
    writeFileSync(INDEX_PATH, text);
    process.stdout.write(`wrote ${INDEX_PATH}\n  ${ids.length} module(s): ${summary}\n`);
  }
}
