/**
 * The Linux release: manifest.mjs lists the AppImage and the .deb next to the Windows and
 * macOS files, measures them like the others, and the packaging config check covers
 * electron-builder.linux.yml.
 *
 * Both scripts run as child processes, exactly as the release workflow runs them, against
 * a temp folder of stand-in files: the manifest only measures bytes, so a one-line file is
 * as good as a 120 MB AppImage for what is checked here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pickUpdateAsset } from "../src/update.mjs";

const RELEASE = fileURLToPath(new URL("../../packaging/release/", import.meta.url));
const MANIFEST = join(RELEASE, "manifest.mjs");
const CHECK_CONFIG = join(RELEASE, "check-config.mjs");
const VERSION = "0.2.0";
const BASE = `https://github.com/Jviat0r/rosalena-harness-downloads/releases/download/v${VERSION}`;
const PAGE = `https://github.com/Jviat0r/rosalena-harness-downloads/releases/tag/v${VERSION}`;

const ALL_FILES = [
  `Rosalena-Harness-Setup-${VERSION}-x64.exe`,
  `Rosalena-Harness-${VERSION}-x64-portable.exe`,
  `Rosalena-Harness-${VERSION}-arm64.dmg`,
  `Rosalena-Harness-${VERSION}-arm64.zip`,
  `Rosalena-Harness-${VERSION}-x64.dmg`,
  `Rosalena-Harness-${VERSION}-x64.zip`,
  `Rosalena-Harness-${VERSION}-x86_64.AppImage`,
  `Rosalena-Harness-${VERSION}-amd64.deb`,
];

function node(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  return result;
}

function artifactsDir(names) {
  const dir = mkdtempSync(join(tmpdir(), "rosalena-release-linux-"));
  for (const name of names) writeFileSync(join(dir, name), `stand-in for ${name}\n`);
  return dir;
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

test("releases.json lists the AppImage and the .deb, measured like every other file", () => {
  const dir = artifactsDir(ALL_FILES);
  try {
    const out = join(dir, "out", "releases.json");
    const sums = join(dir, "out", "SHA256SUMS.txt");
    const run = node(MANIFEST, ["--dir", dir, "--version", VERSION, "--base-url", BASE, "--unsigned", "windows,macos,linux", "--out", out, "--sums", sums]);
    assert.equal(run.status, 0, run.stderr);

    const manifest = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(manifest.artifacts.length, 8);
    assert.ok(manifest.artifacts.every((a) => a.available), "all eight are available");

    const image = manifest.artifacts.find((a) => a.id === "linux-x64-appimage");
    const deb = manifest.artifacts.find((a) => a.id === "linux-x64-deb");
    assert.deepEqual(
      { platform: image.platform, arch: image.arch, kind: image.kind, fileName: image.fileName, url: image.url },
      { platform: "linux", arch: "x64", kind: "appimage", fileName: `Rosalena-Harness-${VERSION}-x86_64.AppImage`, url: `${BASE}/Rosalena-Harness-${VERSION}-x86_64.AppImage` },
    );
    assert.equal(image.sha256, sha(`stand-in for ${image.fileName}\n`));
    assert.deepEqual(
      { platform: deb.platform, kind: deb.kind, fileName: deb.fileName },
      { platform: "linux", kind: "deb", fileName: `Rosalena-Harness-${VERSION}-amd64.deb` },
    );

    const linux = manifest.platforms.find((p) => p.id === "linux");
    assert.equal(linux.label, "Linux");
    assert.equal(linux.status, "available");
    assert.equal(linux.availableCount, 2);
    assert.match(linux.note, /chmod \+x Rosalena-Harness-0\.2\.0-x86_64\.AppImage/);
    assert.match(linux.note, /sudo apt install \.\/Rosalena-Harness-0\.2\.0-amd64\.deb/);
    // The Windows and macOS cards are what they were.
    assert.deepEqual(manifest.platforms.map((p) => p.id), ["windows", "macos", "linux"]);
    assert.equal(manifest.platforms.find((p) => p.id === "macos").availableCount, 4);

    const sumLines = readFileSync(sums, "utf8").trim().split("\n");
    assert.equal(sumLines.length, 8);
    assert.ok(sumLines.some((line) => line.endsWith(`  Rosalena-Harness-${VERSION}-x86_64.AppImage`)));
    assert.ok(sumLines.some((line) => line.endsWith(`  Rosalena-Harness-${VERSION}-amd64.deb`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release whose Linux job failed says so instead of linking to nothing", () => {
  const dir = artifactsDir(ALL_FILES.filter((name) => !/\.(AppImage|deb)$/.test(name)));
  try {
    const out = join(dir, "releases.json");
    const run = node(MANIFEST, ["--dir", dir, "--version", VERSION, "--base-url", BASE, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    const manifest = JSON.parse(readFileSync(out, "utf8"));
    for (const id of ["linux-x64-appimage", "linux-x64-deb"]) {
      const entry = manifest.artifacts.find((a) => a.id === id);
      assert.equal(entry.available, false, id);
      assert.equal(entry.url, "", id);
      assert.equal(entry.sha256, "", id);
    }
    const linux = manifest.platforms.find((p) => p.id === "linux");
    assert.equal(linux.status, "not-built-yet");
    assert.match(linux.note, /Not built yet/);
    assert.equal(manifest.platforms.find((p) => p.id === "windows").status, "available");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates.json carries the AppImage checksum the Linux updater asks for", () => {
  const dir = artifactsDir(ALL_FILES);
  try {
    const out = join(dir, "updates.json");
    const run = node(MANIFEST, ["--updates", "--dir", dir, "--version", VERSION, "--release-url", PAGE, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    const feed = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(Object.keys(feed.artifacts).length, 8);
    const pick = pickUpdateAsset({ manifest: feed, platform: "linux", arch: "x64", appImage: true });
    assert.equal(pick.ok, true, pick.reason);
    assert.equal(pick.sha256, sha(`stand-in for Rosalena-Harness-${VERSION}-x86_64.AppImage\n`));
    assert.equal(pick.url, `${BASE}/Rosalena-Harness-${VERSION}-x86_64.AppImage`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates.json can be written from Linux files alone", () => {
  const dir = artifactsDir([`Rosalena-Harness-${VERSION}-x86_64.AppImage`]);
  try {
    const out = join(dir, "updates.json");
    const run = node(MANIFEST, ["--updates", "--dir", dir, "--version", VERSION, "--release-url", PAGE, "--out", out]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(out, "utf8")).artifacts), [`Rosalena-Harness-${VERSION}-x86_64.AppImage`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-config.mjs passes and covers electron-builder.linux.yml", () => {
  const run = node(CHECK_CONFIG, []);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  for (const label of [
    "linux.yml parses as a block map",
    "linux.yml builds an AppImage",
    "linux.yml builds a deb",
    "linux.yml has a maintainer with an email",
    "linux.yml extraMetadata.homepage is set",
    "win.yml and linux.yml ship an identical app payload list",
    "linux.yml ships every module in desktop/",
    "linux.yml ships every harness/data file stage.mjs stages",
    "linux.yml ships the router identity prompt (data/prompts)",
  ]) {
    assert.ok(run.stdout.includes(`ok    ${label}`), `missing check: ${label}`);
  }
  assert.doesNotMatch(run.stdout, /FAIL/);
});
