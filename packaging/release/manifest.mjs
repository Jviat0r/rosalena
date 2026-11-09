#!/usr/bin/env node
/**
 * Turn a directory of real artifacts into the download manifest the site reads.
 *
 * The rule this script exists to enforce: a manifest entry is `available: true` only
 * when the file it names is *in front of it*, and `size`/`sha256` are measured from that
 * file rather than typed by a human. Everything else is `available: false` with
 * `url: ""`, which is what makes the page say "not built yet" instead of rendering a
 * link to a 404.
 *
 *   node manifest.mjs --dir build/release/app/dist --version 0.1.0 \
 *     --base-url https://github.com/OWNER/REPO/releases/download/v0.1.0 \
 *     --out site/public/download/releases.json \
 *     --sums build/release/app/dist/SHA256SUMS.txt
 *
 * With no `--dir` (or an empty one) every entry comes back unavailable - that is how the
 * committed manifest in site/public/download/ was produced before any build had run.
 *
 * `--updates` writes the other file the site serves: the feed the installed app checks
 * (site/public/download/updates.json). It carries one version, one release *page* and the
 * SHA-256 of every file measured in `--dir`. It refuses to write a feed that names a
 * release page with no measured file behind it, and it refuses to write one the app's own
 * validator (harness/src/update.mjs) would reject - so the pipeline cannot publish a feed
 * the app would call "the check could not be completed".
 *
 *   node manifest.mjs --updates --dir build/release/app/dist --version 0.2.0 \
 *     --release-url https://github.com/OWNER/REPO/releases/tag/v0.2.0 \
 *     --notes build/release/NOTES.md \
 *     --out site/public/download/updates.json
 *
 * Usage:
 *   --dir <dir>        where the built artifacts are (optional; omit for "none built")
 *   --version <v>      product version stamped into every file name (required)
 *   --base-url <url>   release asset directory; entry url = <base-url>/<file name>
 *   --out <file>       write the manifest here (default: stdout)
 *   --sums <file>      also write a SHA256SUMS.txt for the files that exist
 *   --date <YYYY-MM-DD> override the "updated" date (default: today, UTC)
 *
 * Updates mode only:
 *   --updates          write updates.json instead of releases.json
 *   --release-url <u>  the GitHub release page (required in this mode, unless --base-url
 *                      is a .../releases/download/<tag> URL, which implies the page)
 *   --notes <file>     release notes to quote (optional; empty notes are honest)
 *   --channel <name>   "stable" (default), or "prerelease" when --version is one
 *   --released-at <t>  override the release time (default: now, UTC)
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseVersion, validateUpdateManifest } from "../../harness/src/update.mjs";

const args = process.argv.slice(2);
const valueOf = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const VERSION = valueOf("--version");
const BASE_URL = valueOf("--base-url");
const OUT = valueOf("--out");
const SUMS = valueOf("--sums");
const DATE = valueOf("--date") ?? new Date().toISOString().slice(0, 10);
const DIR = valueOf("--dir");
// Which platforms shipped without a signing certificate. An explicit flag rather than a
// guess: the page tells a visitor what to expect on first launch, and that has to be a fact
// about this build, not an assumption about every build.
const UNSIGNED = (valueOf("--unsigned") ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const UPDATES = flag("--updates");
const RELEASE_URL = valueOf("--release-url");
const NOTES = valueOf("--notes");
const CHANNEL = valueOf("--channel");
const RELEASED_AT = valueOf("--released-at");

if (!VERSION) {
  console.error("usage: node manifest.mjs --version <v> [--dir <artifacts>] [--base-url <url>] [--out <file>] [--sums <file>]");
  console.error("       node manifest.mjs --updates --version <v> --release-url <url> [--dir <artifacts>] [--notes <file>] [--out <file>]");
  console.error("       --unsigned windows,macos,linux   name the platforms this build could not sign");
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) {
  console.error(`--version "${VERSION}" is not a semver version`);
  process.exit(2);
}

// ------------------------------------------------------------------ what a build ships

/**
 * One slot per downloadable file. `expected` is the name electron-builder produces from
 * the artifactName patterns in the two YAML configs; `match` decides whether a file in
 * the artifact directory *is* that slot. Both are needed: `expected` documents the
 * contract, `match` keeps this script working if a name gains a prefix.
 */
const SLOTS = [
  {
    id: "windows-x64-installer",
    platform: "windows",
    arch: "x64",
    kind: "installer",
    expected: `Rosalena-Harness-Setup-${VERSION}-x64.exe`,
    match: (name) => /setup/i.test(name) && name.endsWith(".exe"),
  },
  {
    id: "windows-x64-portable",
    platform: "windows",
    arch: "x64",
    kind: "portable",
    expected: `Rosalena-Harness-${VERSION}-x64-portable.exe`,
    match: (name) => /portable/i.test(name) && name.endsWith(".exe"),
  },
  {
    id: "macos-arm64-dmg",
    platform: "macos",
    arch: "arm64",
    kind: "dmg",
    expected: `Rosalena-Harness-${VERSION}-arm64.dmg`,
    match: (name) => name.endsWith("-arm64.dmg"),
  },
  {
    id: "macos-arm64-zip",
    platform: "macos",
    arch: "arm64",
    kind: "zip",
    expected: `Rosalena-Harness-${VERSION}-arm64.zip`,
    match: (name) => name.endsWith("-arm64.zip"),
  },
  {
    id: "macos-x64-dmg",
    platform: "macos",
    arch: "x64",
    kind: "dmg",
    expected: `Rosalena-Harness-${VERSION}-x64.dmg`,
    match: (name) => name.endsWith("-x64.dmg"),
  },
  {
    id: "macos-x64-zip",
    platform: "macos",
    arch: "x64",
    kind: "zip",
    expected: `Rosalena-Harness-${VERSION}-x64.zip`,
    match: (name) => name.endsWith("-x64.zip"),
  },
  // Linux x64. electron-builder spells x64 as x86_64 for an AppImage and amd64 for a .deb
  // (electron-builder.linux.yml); the AppImage is also the file the in-app updater swaps in
  // (harness/src/update.mjs updateFileName).
  {
    id: "linux-x64-appimage",
    platform: "linux",
    arch: "x64",
    kind: "appimage",
    expected: `Rosalena-Harness-${VERSION}-x86_64.AppImage`,
    match: (name) => name.endsWith(".AppImage"),
  },
  {
    id: "linux-x64-deb",
    platform: "linux",
    arch: "x64",
    kind: "deb",
    expected: `Rosalena-Harness-${VERSION}-amd64.deb`,
    match: (name) => name.endsWith(".deb"),
  },
];

const PLATFORMS = [
  {
    id: "windows",
    label: "Windows",
    requirement: "Windows 10 or 11, 64-bit",
    missingNote:
      "Not built yet: no build has produced this file. The Windows installer comes out of the release pipeline, not off a desktop.",
    unsignedNote:
      "Unsigned: no code-signing certificate was available when this was built, so Windows SmartScreen shows \"Windows protected your PC\". Choose More info, then Run anyway.",
  },
  {
    id: "macos",
    label: "macOS",
    requirement: "macOS 11 or newer, Apple silicon or Intel",
    missingNote:
      "Not built yet: a macOS file can only come from a Mac, and no Mac has built one. No .dmg and no .zip for macOS exists today.",
    unsignedNote:
      "Unsigned and not notarized: no Apple Developer certificate was available when this was built, so macOS quarantines the download. Right-click the app, choose Open, then Open again, or run xattr -dr com.apple.quarantine \"/Applications/Rosalena Harness.app\" once.",
  },
  {
    id: "linux",
    label: "Linux",
    requirement: "64-bit Linux (x86_64): the AppImage runs on most distributions, the .deb installs on Debian and Ubuntu",
    missingNote:
      "Not built yet: no build has produced this file. The Linux AppImage and .deb come out of the release pipeline's Linux job.",
    unsignedNote:
      `Not signed. AppImage: run chmod +x Rosalena-Harness-${VERSION}-x86_64.AppImage, then open it (Ubuntu 22.04 and newer need FUSE 2: sudo apt install libfuse2t64 on 24.04, libfuse2 on 22.04); it updates itself from inside the app. .deb: sudo apt install ./Rosalena-Harness-${VERSION}-amd64.deb; a .deb install updates by installing the next .deb from this page.`,
  },
];

// ----------------------------------------------------------------------------- helpers

const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

async function readArtifacts(dir) {
  const files = new Map();
  if (!dir) return files;
  if (!existsSync(dir)) {
    console.error(`--dir ${dir} does not exist`);
    process.exit(2);
  }
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    if (!dirent.isFile()) continue;
    if (!/\.(exe|dmg|zip|AppImage|deb)$/i.test(dirent.name)) continue;
    const abs = resolve(dir, dirent.name);
    files.set(dirent.name, { abs, size: (await stat(abs)).size, sha256: await sha256(abs) });
  }
  return files;
}

// ------------------------------------------------------------------------ updates mode

/**
 * ".../releases/download/<tag>" -> ".../releases/tag/<tag>", the page a person can read.
 * A release *page* is what the app opens; a download URL is never put in its link.
 * @returns {string | null}
 */
function releasePageFrom(baseUrl) {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    const match = /^(.*)\/releases\/download\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) return null;
    url.pathname = `${match[1]}/releases/tag/${match[2]}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Write the feed the installed app checks.
 *
 * Two refusals, and they are the point of the mode:
 *
 *   - no measured file in --dir: an updates manifest that names a release page while
 *     nothing was measured would be the pipeline claiming a release it cannot show. Exit 2.
 *   - no release page: an "update available" the app cannot point at is, by the app's own
 *     rule, not an update. Exit 2.
 *
 * Everything else is measured here: releasedAt is this run's clock, artifacts are the
 * SHA-256 of each file that was actually in the directory, and the finished object is run
 * through the harness validator the app uses before a byte is written.
 */
async function writeUpdatesManifest() {
  const releaseUrl = (RELEASE_URL ?? releasePageFrom(BASE_URL) ?? "").trim();
  if (!releaseUrl) {
    console.error("--updates needs --release-url <release page>, or a --base-url that ends in /releases/download/<tag>");
    process.exit(2);
  }

  const measured = [...(await readArtifacts(DIR)).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (measured.length === 0) {
    console.error(
      "--updates refused: --dir contained no .exe/.dmg/.zip/.AppImage/.deb artifact, so there is no measured file to point at. " +
        "An updates manifest is only written for a release that produced files.",
    );
    process.exit(2);
  }

  let notes = "";
  if (NOTES) {
    if (!existsSync(resolve(NOTES))) {
      console.error(`--notes ${NOTES} does not exist`);
      process.exit(2);
    }
    notes = (await readFile(resolve(NOTES), "utf8")).trim();
  }

  const parsed = parseVersion(VERSION);
  const channel = (CHANNEL ?? (parsed && parsed.prerelease.length > 0 ? "prerelease" : "stable")).trim();
  const releasedAt = RELEASED_AT ?? new Date().toISOString();

  const artifacts = {};
  for (const [name, file] of measured) {
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
      console.error(`refusing: ${name} has no 64-hex sha256, so its measurement is not a measurement`);
      process.exit(1);
    }
    artifacts[name] = file.sha256;
  }

  const updates = {
    schema: 1,
    product: "Rosalena Harness",
    channel,
    version: VERSION,
    releasedAt,
    notes,
    url: releaseUrl,
    artifacts,
    updated: DATE,
    generatedBy: "packaging/release/manifest.mjs --updates",
    summary:
      "The newest published version, as the installed app reads it. url is the release page, never a direct file: the app opens it and the person installs. artifacts lists the SHA-256 of every file this run measured.",
  };

  const checked = validateUpdateManifest(updates);
  if (!checked.ok) {
    console.error(`refusing to write an updates manifest the app would reject: ${checked.reason}`);
    process.exit(1);
  }

  // The checked fields win (notes truncated, url trimmed): the written file is the one the
  // validator approved. The documentation keys stay, and the app ignores them.
  const written = { ...updates, version: checked.manifest.version, notes: checked.manifest.notes, url: checked.manifest.url };
  if (written.notes.length < notes.length) {
    console.log(`notes truncated to ${checked.manifest.notes.length} characters, the limit the app enforces`);
  }

  const text = `${JSON.stringify(written, null, 2)}\n`;
  if (OUT) {
    await mkdir(dirname(resolve(OUT)), { recursive: true });
    await writeFile(resolve(OUT), text);
    console.log(`wrote ${OUT}`);
  } else {
    process.stdout.write(text);
  }

  console.log("");
  console.log(`updates feed: ${checked.manifest.version} on ${checked.manifest.channel}, released ${checked.manifest.releasedAt}`);
  console.log(`release page: ${checked.manifest.url}`);
  console.log(`measured: ${measured.length} file(s), ${measured.reduce((total, [, file]) => total + file.size, 0)} bytes`);
  for (const [name] of measured) console.log(`  ${artifacts[name].slice(0, 12)}...  ${name}`);
  if (notes.length === 0) console.log("notes: empty (pass --notes <file> to quote the release notes)");
  if (OUT && OUT.replace(/\\/g, "/").endsWith("site/public/download/updates.json")) {
    console.log("");
    console.log("this file only becomes the feed an installed app reads once it is committed and deployed");
  }
}

if (UPDATES) {
  await writeUpdatesManifest();
  process.exit(0);
}

// ------------------------------------------------------------------------------- build

const found = await readArtifacts(DIR);
const used = new Set();
const artifacts = [];

for (const slot of SLOTS) {
  const name = [...found.keys()].find((candidate) => slot.match(candidate) && !used.has(candidate));
  if (name) {
    used.add(name);
    const file = found.get(name);
    // The URL only exists if it can be built from a real base URL.
    const url = BASE_URL ? `${BASE_URL.replace(/\/+$/, "")}/${encodeURIComponent(name)}` : "";
    artifacts.push({
      id: slot.id,
      platform: slot.platform,
      arch: slot.arch,
      kind: slot.kind,
      fileName: name,
      version: VERSION,
      available: Boolean(url),
      url,
      sha256: file.sha256,
      size: file.size,
      // The signing caveat is a property of the platform card, not of a file: the same
      // sentence four times under four macOS rows is noise, so it lives on `platforms`.
      note: url ? "" : "The file was built but no --base-url was given, so no download URL is published yet.",
    });
    continue;
  }
  const platform = PLATFORMS.find((p) => p.id === slot.platform);
  artifacts.push({
    id: slot.id,
    platform: slot.platform,
    arch: slot.arch,
    kind: slot.kind,
    fileName: slot.expected,
    version: VERSION,
    available: false,
    url: "",
    sha256: "",
    size: 0,
    note: platform.missingNote,
  });
}

const ignored = [...found.keys()].filter((name) => !used.has(name));

const platforms = PLATFORMS.map((platform) => {
  const own = artifacts.filter((a) => a.platform === platform.id);
  const available = own.filter((a) => a.available).length;
  return {
    id: platform.id,
    label: platform.label,
    requirement: platform.requirement,
    status: available === 0 ? "not-built-yet" : available === own.length ? "available" : "partial",
    availableCount: available,
    artifactCount: own.length,
    note: available === 0 ? platform.missingNote : UNSIGNED.includes(platform.id) ? platform.unsignedNote : "",
  };
});

const manifest = {
  schema: 1,
  product: "Rosalena Harness",
  version: VERSION,
  updated: DATE,
  generatedBy: "packaging/release/manifest.mjs",
  summary:
    "One entry per downloadable file. available:true means the release workflow produced exactly this file and measured its size and SHA-256; available:false means no such file exists yet, and the download page shows no link for it.",
  platforms,
  artifacts,
};

// Self-check: the manifest must not be able to lie.
for (const entry of artifacts) {
  const hex = /^[0-9a-f]{64}$/.test(entry.sha256);
  if (entry.available) {
    if (!entry.url) throw new Error(`${entry.id}: available without a url`);
    if (!hex) throw new Error(`${entry.id}: available without a 64-hex sha256`);
    if (!(entry.size > 0)) throw new Error(`${entry.id}: available without a size`);
  } else {
    if (entry.url) throw new Error(`${entry.id}: unavailable but carries a url`);
    if (entry.sha256) throw new Error(`${entry.id}: unavailable but carries a sha256`);
  }
}

const text = `${JSON.stringify(manifest, null, 2)}\n`;

if (OUT) {
  await mkdir(dirname(resolve(OUT)), { recursive: true });
  await writeFile(resolve(OUT), text);
  console.log(`wrote ${OUT}`);
} else {
  process.stdout.write(text);
}

if (SUMS) {
  const lines = artifacts
    .filter((a) => a.available)
    .map((a) => `${a.sha256}  ${a.fileName}`);
  if (lines.length === 0) lines.push("# no artifacts were available; nothing to checksum");
  await mkdir(dirname(resolve(SUMS)), { recursive: true });
  await writeFile(resolve(SUMS), `${lines.join("\n")}\n`);
  console.log(`wrote ${SUMS}`);
}

const summary = artifacts.map((a) => `  ${a.available ? "yes" : "no "}  ${a.id.padEnd(24)}${a.fileName}`).join("\n");
console.log("");
console.log(`version ${VERSION}, ${artifacts.filter((a) => a.available).length}/${artifacts.length} artifacts available`);
console.log(summary);
if (ignored.length) console.log(`ignored (not a download artifact): ${ignored.join(", ")}`);
