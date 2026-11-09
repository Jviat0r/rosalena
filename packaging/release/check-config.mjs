#!/usr/bin/env node
/**
 * Structural check for the three electron-builder configs (Windows, macOS, Linux).
 *
 * There is no YAML library in this repo (zero dependencies is a rule, not an accident),
 * and a broken YAML file fails ten minutes into a runner instead of at the keyboard. So
 * this file contains a small parser for the subset of YAML the configs actually use -
 * block maps, block sequences, quoted and plain scalars, inline `[a, b]` lists - and
 * then asserts the things that matter about the result.
 *
 * It is a check for these files, not a general YAML parser. Anything it cannot parse is
 * reported as an error rather than guessed at, so it fails loudly instead of quietly
 * accepting a typo.
 *
 *   node check-config.mjs
 *
 * Exit code 0 means every check passed. 1 means at least one failed and is listed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const CONFIGS = {
  win: join(HERE, "electron-builder.win.yml"),
  mac: join(HERE, "electron-builder.mac.yml"),
  linux: join(HERE, "electron-builder.linux.yml"),
};

// ---------------------------------------------------------------------------- parser

/**
 * @param {string} text
 * @returns {{ root: any, errors: string[] }}
 */
function parseYaml(text) {
  const errors = [];
  const lines = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    if (!raw.trim()) return;
    if (/^\s*#/.test(raw)) return;
    if (raw.includes("\t")) {
      errors.push(`line ${lineNumber}: tab character in indentation`);
      return;
    }
    if (/\s+$/.test(raw)) {
      errors.push(`line ${lineNumber}: trailing whitespace`);
      return;
    }
    const indent = raw.length - raw.trimStart().length;
    if (indent % 2 !== 0) {
      errors.push(`line ${lineNumber}: indent ${indent} is not a multiple of 2`);
      return;
    }
    lines.push({ lineNumber, indent, content: raw.trim() });
  });

  let i = 0;

  const scalar = (token, lineNumber) => {
    const value = token.trim();
    if (value === "") return null;
    if (value === "null" || value === "~") return null;
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?\d+$/.test(value)) return Number(value);
    if (/^"(.*)"$/.test(value)) return value.slice(1, -1);
    if (/^'(.*)'$/.test(value)) return value.slice(1, -1);
    if (/^\[(.*)\]$/.test(value)) {
      const inner = value.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(",").map((part) => scalar(part, lineNumber));
    }
    if (/^[|>]/.test(value)) {
      errors.push(`line ${lineNumber}: block scalars are not supported by this checker`);
      return null;
    }
    return value;
  };

  const KEY = /^([A-Za-z_$][\w$-]*):(?:\s+(.*))?$/;

  function parseBlock(start, indent, depth) {
    if (depth > 12) {
      errors.push(`line ${lines[start]?.lineNumber ?? "?"}: nesting deeper than 12 levels`);
      return [null, lines.length];
    }
    const first = lines[start];
    if (!first) return [null, start];
    if (first.indent !== indent) {
      errors.push(`line ${first.lineNumber}: expected indent ${indent}, found ${first.indent}`);
      return [null, start + 1];
    }
    return first.content.startsWith("- ") ? parseSeq(start, indent, depth) : parseMap(start, indent, depth);
  }

  function parseSeq(start, indent, depth) {
    const out = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        errors.push(`line ${line.lineNumber}: unexpected indent ${line.indent} inside a list at ${indent}`);
        i += 1;
        continue;
      }
      if (!line.content.startsWith("- ")) break;
      const rest = line.content.slice(2).trim();
      i += 1;
      if (!rest) {
        const [child, next] = parseBlock(i, indent + 2, depth + 1);
        out.push(child);
        i = next;
        continue;
      }
      const keyed = KEY.exec(rest);
      if (keyed) {
        const item = {};
        const key = keyed[1];
        if (keyed[2] === undefined || keyed[2] === "") {
          const [child, next] = parseBlock(i, indent + 2, depth + 1);
          item[key] = child;
          i = next;
        } else {
          item[key] = scalar(keyed[2], line.lineNumber);
        }
        // More keys of the same map item, indented two past the dash.
        while (i < lines.length && lines[i].indent === indent + 2 && KEY.test(lines[i].content)) {
          const sub = KEY.exec(lines[i].content);
          i += 1;
          if (sub[2] === undefined || sub[2] === "") {
            const [child, next] = parseBlock(i, indent + 4, depth + 1);
            item[sub[1]] = child;
            i = next;
          } else {
            item[sub[1]] = scalar(sub[2], lines[i - 1].lineNumber);
          }
        }
        out.push(item);
        continue;
      }
      out.push(scalar(rest, line.lineNumber));
    }
    return [out, i];
  }

  function parseMap(start, indent, depth) {
    const out = {};
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line.indent < indent) break;
      if (line.indent > indent) {
        errors.push(`line ${line.lineNumber}: unexpected indent ${line.indent} inside a map at ${indent}`);
        i += 1;
        continue;
      }
      if (line.content.startsWith("- ")) break;
      const match = KEY.exec(line.content);
      if (!match) {
        errors.push(`line ${line.lineNumber}: not a "key: value" line: ${line.content}`);
        i += 1;
        continue;
      }
      const key = match[1];
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        errors.push(`line ${line.lineNumber}: duplicate key "${key}"`);
      }
      i += 1;
      if (match[2] === undefined || match[2] === "") {
        if (i < lines.length && lines[i].indent > indent) {
          const [child, next] = parseBlock(i, lines[i].indent, depth + 1);
          out[key] = child;
          i = next;
        } else {
          out[key] = null;
        }
      } else {
        out[key] = scalar(match[2], line.lineNumber);
      }
    }
    return [out, i];
  }

  const [root] = parseBlock(0, 0, 0);
  return { root, errors };
}

// ---------------------------------------------------------------------------- checks

const failures = [];
const passed = [];

const check = (label, condition, detail = "") => {
  if (condition) passed.push(label);
  else failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
};

const load = async (path) => {
  const text = await readFile(path, "utf8");
  const { root, errors } = parseYaml(text);
  return { root, errors, text };
};

const win = await load(CONFIGS.win);
const mac = await load(CONFIGS.mac);
const linux = await load(CONFIGS.linux);

for (const [name, parsed] of Object.entries({ win, mac, linux })) {
  for (const error of parsed.errors) failures.push(`${name}.yml parse: ${error}`);
  check(`${name}.yml parses as a block map`, parsed.root && typeof parsed.root === "object" && !Array.isArray(parsed.root));
}

const hasGlob = (entry) => /[*?[]/.test(entry);
const positives = (files) => (Array.isArray(files) ? files : []).filter((f) => typeof f === "string" && !f.startsWith("!"));
const negatives = (files) => (Array.isArray(files) ? files : []).filter((f) => typeof f === "string" && f.startsWith("!"));

for (const [name, parsed] of Object.entries({ win, mac, linux })) {
  const root = parsed.root ?? {};
  for (const key of ["appId", "productName", "directories", "files", "extraResources", "asar", "publish"]) {
    check(`${name}.yml has ${key}`, Object.prototype.hasOwnProperty.call(root, key));
  }
  check(`${name}.yml sets asar: false (the app layout must match the repo layout)`, root.asar === false, String(root.asar));
  check(`${name}.yml directories.output is dist`, root.directories?.output === "dist", String(root.directories?.output));
  check(`${name}.yml directories.buildResources is build`, root.directories?.buildResources === "build");

  const files = root.files;
  check(`${name}.yml files is a non-empty list`, Array.isArray(files) && files.length > 0);
  check(`${name}.yml excludes node_modules explicitly`, negatives(files).includes("!**/node_modules/**"));
  check(`${name}.yml never allows the whole tree`, !positives(files).some((f) => f === "**" || f === "**/*"));
  check(
    `${name}.yml never allows node_modules`,
    !positives(files).some((f) => f.includes("node_modules")),
  );
  const literalFiles = positives(files).filter((f) => !hasGlob(f));
  for (const literal of literalFiles) {
    // Literal entries are either repo paths ("desktop/main.mjs") or generated at staging
    // time ("package.json"); only the repo ones can be checked here.
    if (literal === "package.json") continue;
    check(`${name}.yml payload path exists: ${literal}`, existsSync(join(REPO, literal)));
  }

  const extras = Array.isArray(root.extraResources) ? root.extraResources : [];
  check(`${name}.yml extraResources is a non-empty list`, extras.length > 0);
  for (const extra of extras) {
    check(`${name}.yml extraResources entry has from`, Boolean(extra?.from));
    if (extra?.from) check(`${name}.yml extraResources source exists: ${extra.from}`, existsSync(join(REPO, extra.from)));
    const filter = Array.isArray(extra?.filter) ? extra.filter : [];
    // Only a filter that can match a whole directory needs to say "not node_modules". An
    // allow-list of one file (`- "rosalena.md"`) cannot copy a dependency tree, so
    // demanding the negative glob there would be a rule about punctuation, not about what
    // ships.
    const broad = filter.some((glob) => glob === "**/*" || glob === "**" || glob.endsWith("/**"));
    if (broad) {
      check(`${name}.yml extraResources ${extra?.from ?? "?"} filters out node_modules`, filter.includes("!**/node_modules/**"));
    }
  }

  check(`${name}.yml artifactName is version- and arch-stamped`,
    typeof root.artifactName === "string" && root.artifactName.includes("${version}") && root.artifactName.includes("${arch}"),
    String(root.artifactName));
}

// Windows specifics
const winRoot = win.root ?? {};
check("win.yml appId matches mac.yml", winRoot.appId === mac.root?.appId, `${winRoot.appId} vs ${mac.root?.appId}`);
const winTargets = Array.isArray(winRoot.win?.target) ? winRoot.win.target : [];
check("win.yml builds nsis", winTargets.some((t) => t?.target === "nsis"));
check("win.yml builds portable", winTargets.some((t) => t?.target === "portable"));
check("win.yml builds x64", winTargets.some((t) => Array.isArray(t?.arch) && t.arch.includes("x64")));
check("win.yml nsis is not one-click (a real installer)", winRoot.nsis?.oneClick === false);
check("win.yml nsis installs per user", winRoot.nsis?.perMachine === false);
check("win.yml nsis artifactName is version- and arch-stamped",
  typeof winRoot.nsis?.artifactName === "string" && winRoot.nsis.artifactName.includes("${version}") && winRoot.nsis.artifactName.includes("${arch}"));
check("win.yml portable artifactName is version-stamped",
  typeof winRoot.portable?.artifactName === "string" && winRoot.portable.artifactName.includes("${version}"));
check("win.yml icon is the staged build/icon.ico", winRoot.win?.icon === "build/icon.ico", String(winRoot.win?.icon));
check("win.yml icon source exists", existsSync(join(REPO, "packaging/assets/rosalena.ico")));

// macOS specifics
const macRoot = mac.root ?? {};
check("mac.yml category is developer-tools", macRoot.mac?.category === "public.app-category.developer-tools", String(macRoot.mac?.category));
check("mac.yml hardenedRuntime is true", macRoot.mac?.hardenedRuntime === true);
check("mac.yml identity is null (the honest unsigned path)", macRoot.mac?.identity === null, String(macRoot.mac?.identity));
check("mac.yml notarization is off by default", macRoot.mac?.notarize === false, String(macRoot.mac?.notarize));
check("mac.yml points at the entitlements file", macRoot.mac?.entitlements === "build/entitlements.mac.plist", String(macRoot.mac?.entitlements));
check("mac.yml points entitlementsInherit at the same file", macRoot.mac?.entitlementsInherit === "build/entitlements.mac.plist");
check("mac.yml entitlements source exists", existsSync(join(REPO, "packaging/release/entitlements.mac.plist")));
// The macOS icon: the same mark the Windows build uses, in the container macOS reads.
// Both checks matter - the path has to be the staged one (build/icon.icns, where
// stage.mjs puts packaging/assets/rosalena.icns and where directories.buildResources
// points), and the source has to exist or electron-builder fails the build.
check("mac.yml icon is the staged build/icon.icns", macRoot.mac?.icon === "build/icon.icns", String(macRoot.mac?.icon));
check("mac.yml icon source exists", existsSync(join(REPO, "packaging/assets/rosalena.icns")));
const icnsBytes = existsSync(join(REPO, "packaging/assets/rosalena.icns"))
  ? statSync(join(REPO, "packaging/assets/rosalena.icns")).size
  : 0;
// A 7-entry ICNS of this mark is ~28 KB; anything under 4 KB is a header with no images,
// which electron-builder would happily package as a blank icon.
check("mac.yml icon file is a real ICNS container with image data", icnsBytes > 4096, `${icnsBytes} bytes`);
const macTargets = Array.isArray(macRoot.mac?.target) ? macRoot.mac.target : [];
const macArch = new Set(macTargets.flatMap((t) => (Array.isArray(t?.arch) ? t.arch : [])));
check("mac.yml builds a dmg", macTargets.some((t) => t?.target === "dmg"));
check("mac.yml builds a zip", macTargets.some((t) => t?.target === "zip"));
check("mac.yml builds arm64 and x64", macArch.has("arm64") && macArch.has("x64"), [...macArch].join(","));
check("mac.yml dmg has an Applications drop target",
  JSON.stringify(macRoot.dmg ?? {}).includes("Applications"));

// Linux specifics. The file names matter twice over: harness/src/update.mjs
// (updateFileName) downloads exactly Rosalena-Harness-<v>-x86_64.AppImage, and
// manifest.mjs lists exactly these two files. electron-builder spells x64 as x86_64 for an
// AppImage and amd64 for a .deb, so ${arch} produces both names from one pattern.
const linuxRoot = linux.root ?? {};
check("linux.yml appId matches win.yml", linuxRoot.appId === winRoot.appId, `${linuxRoot.appId} vs ${winRoot.appId}`);
check("linux.yml productName is Rosalena Harness", linuxRoot.productName === "Rosalena Harness", String(linuxRoot.productName));
const linuxTargets = Array.isArray(linuxRoot.linux?.target) ? linuxRoot.linux.target : [];
check("linux.yml builds an AppImage", linuxTargets.some((t) => t?.target === "AppImage"));
check("linux.yml builds a deb", linuxTargets.some((t) => t?.target === "deb"));
check(
  "linux.yml builds x64 only (the updater and the manifest know no other Linux arch)",
  linuxTargets.length > 0 && linuxTargets.every((t) => Array.isArray(t?.arch) && t.arch.length === 1 && t.arch[0] === "x64"),
);
check("linux.yml category is Development", linuxRoot.linux?.category === "Development", String(linuxRoot.linux?.category));
check("linux.yml executableName is rosalena-harness", linuxRoot.linux?.executableName === "rosalena-harness", String(linuxRoot.linux?.executableName));
check(
  "linux.yml has a maintainer with an email (fpm refuses a .deb without one)",
  /<[^@\s>]+@[^@\s>]+>/.test(String(linuxRoot.linux?.maintainer ?? "")),
  String(linuxRoot.linux?.maintainer),
);
check(
  "linux.yml extraMetadata.homepage is set (fpm refuses a .deb without a homepage)",
  /^https:\/\//.test(String(linuxRoot.extraMetadata?.homepage ?? "")),
  String(linuxRoot.extraMetadata?.homepage),
);
check(
  "linux.yml extraMetadata.desktopName names the launcher entry",
  linuxRoot.extraMetadata?.desktopName === `${linuxRoot.linux?.executableName}.desktop`,
  String(linuxRoot.extraMetadata?.desktopName),
);
check("linux.yml icon is the staged build/icons folder", linuxRoot.linux?.icon === "build/icons", String(linuxRoot.linux?.icon));
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  check(`linux.yml icon source exists: packaging/assets/icon/rosalena-${size}.png`, existsSync(join(REPO, `packaging/assets/icon/rosalena-${size}.png`)));
}
check(
  "linux.yml AppImage artifactName is Rosalena-Harness-${version}-${arch}.${ext}",
  linuxRoot.appImage?.artifactName === "Rosalena-Harness-${version}-${arch}.${ext}",
  String(linuxRoot.appImage?.artifactName),
);
check(
  "linux.yml deb artifactName is Rosalena-Harness-${version}-${arch}.${ext}",
  linuxRoot.deb?.artifactName === "Rosalena-Harness-${version}-${arch}.${ext}",
  String(linuxRoot.deb?.artifactName),
);

// The three configs must ship the same app payload, or the Windows, macOS and Linux builds
// are different products and only one of them has been reasoned about.
const winPayload = positives(winRoot.files).join("\n");
const macPayload = positives(macRoot.files).join("\n");
const linuxPayload = positives(linuxRoot.files).join("\n");
check("win.yml and mac.yml ship an identical app payload list", winPayload === macPayload);
check("win.yml and linux.yml ship an identical app payload list", winPayload === linuxPayload);

// Every harness/data file stage.mjs stages has to survive the `files` filter as well: a
// file staged and then filtered out is a file the installed app does not have. This is how
// node-runtime.json went missing from every build up to 0.1.14 (staged, never listed), so
// OmniRoute's "install Node for me" path had no pinned build to fetch on a PC without Node.
const stagedData = [...readFileSync(join(HERE, "stage.mjs"), "utf8").matchAll(/from: "(harness\/data\/[^"*]+\.json)"/g)].map((m) => m[1]);
check("stage.mjs stages harness/data files (the list below is not empty)", stagedData.length > 0, `${stagedData.length} files`);
for (const [name, root] of Object.entries({ win: winRoot, mac: macRoot, linux: linuxRoot })) {
  const listed = new Set(positives(root.files));
  const dropped = stagedData.filter((file) => !listed.has(file));
  check(
    `${name}.yml ships every harness/data file stage.mjs stages`,
    dropped.length === 0,
    dropped.length ? `filtered out: ${dropped.join(", ")}` : `${stagedData.length} files`,
  );
}

// Every .mjs next to the Electron entry is imported by it, directly or through another
// module, so a payload list that forgets one builds an installer that dies on first
// launch with ERR_MODULE_NOT_FOUND - a failure only running the built app can show, never
// "the installer built". The first real build of this repo shipped exactly that: menu.mjs
// and router-supervisor.mjs were staged and then filtered out by both configs, and the
// installed app opened an "App threw an error during load" dialog with no window behind it.
const desktopModules = readdirSync(join(REPO, "desktop"))
  .filter((name) => name.endsWith(".mjs"))
  .sort();
for (const [name, root] of Object.entries({ win: winRoot, mac: macRoot, linux: linuxRoot })) {
  const listed = new Set(positives(root.files).filter((entry) => entry.startsWith("desktop/")));
  const missing = desktopModules.filter((file) => !listed.has(`desktop/${file}`));
  check(
    `${name}.yml ships every module in desktop/`,
    missing.length === 0,
    missing.length ? `missing ${missing.join(", ")}` : `${desktopModules.length} modules`,
  );
}

// The same rule for extraResources: the router and its identity prompt are part of the
// product, and a build that ships the router without data/prompts/rosalena.md ships a
// router that exits 2 on startup (router/src/persona.mjs) - it opens a window, then no
// model can answer.
const extraKey = (root) =>
  (Array.isArray(root.extraResources) ? root.extraResources : [])
    .map((entry) => `${entry?.from ?? "?"}->${entry?.to ?? "?"}`)
    .join("\n");
check("win.yml and mac.yml ship the same extraResources", extraKey(winRoot) === extraKey(macRoot), extraKey(winRoot));
check("win.yml and linux.yml ship the same extraResources", extraKey(winRoot) === extraKey(linuxRoot), extraKey(linuxRoot));
for (const [name, root] of Object.entries({ win: winRoot, mac: macRoot, linux: linuxRoot })) {
  check(`${name}.yml ships the router identity prompt (data/prompts)`, extraKey(root).includes("data/prompts->data/prompts"));
  check(`${name}.yml ships the router as an extra resource`, extraKey(root).includes("router->router"));
}

// The staged app carries no node_modules, so electron-builder cannot ask an installed
// electron what version to package and falls back to the declared one. A range there
// stops every build dead with "Electron version \"^44.5.1\" is a range, not a fixed
// version" - which is exactly what the first real build of this repo hit, on Windows and
// on the macOS runner alike. Both configs may also pin electronVersion themselves; then
// the package.json range no longer matters.
const desktopPackage = JSON.parse(readFileSync(join(REPO, "desktop/package.json"), "utf8"));
const declaredElectron = desktopPackage.devDependencies?.electron ?? desktopPackage.dependencies?.electron ?? "";
const pinnedIn = ["win", "mac", "linux"].filter((name) => /electronVersion/.test(readFileSync(join(HERE, `electron-builder.${name}.yml`), "utf8")));
check(
  "electron is pinned to one exact version (electron-builder cannot resolve a range)",
  pinnedIn.length > 0 || /^\d+\.\d+\.\d+$/.test(declaredElectron),
  `desktop/package.json electron=${declaredElectron || "(none)"}${
    pinnedIn.length > 0 ? `, pinned in ${pinnedIn.join(" + ")}.yml` : ""
  }`,
);

// ----------------------------------------------------------------------------- report

for (const label of passed) console.log(`  ok    ${label}`);
for (const failure of failures) console.log(`  FAIL  ${failure}`);
console.log("");
console.log(`check-config: ${passed.length} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
