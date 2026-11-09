/**
 * Which file the self-updater downloads, and the address it downloads it from.
 *
 * The updater installs whatever pickUpdateAsset names, so the two things that matter are
 * that it names the right file for each kind of install, and that it never names a file
 * the feed carries no SHA-256 for. The checksum is the only thing standing between the
 * download and the install.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DOWNLOAD_PAGE_URL,
  appImageSwapScript,
  manualUpdateReason,
  pickUpdateAsset,
  releaseDownloadUrl,
  selfInstallable,
  updateFileName,
} from "../src/update.mjs";

const HASH = "a".repeat(64);
const feed = (artifacts, overrides = {}) => ({
  schema: 1,
  channel: "stable",
  version: "0.2.0",
  releasedAt: "2026-10-01T00:00:00.000Z",
  notes: "",
  url: "https://github.com/Jviat0r/rosalena-harness-downloads/releases/tag/v0.2.0",
  artifacts,
  ...overrides,
});

test("release page -> file address, github.com release pages only", () => {
  assert.equal(
    releaseDownloadUrl("https://github.com/o/r/releases/tag/v0.2.0", "Rosalena-Harness-Setup-0.2.0-x64.exe"),
    "https://github.com/o/r/releases/download/v0.2.0/Rosalena-Harness-Setup-0.2.0-x64.exe",
  );
  assert.equal(releaseDownloadUrl("https://rosalena.pages.dev/download/", "x.exe"), null);
  assert.equal(releaseDownloadUrl("http://github.com/o/r/releases/tag/v1", "x.exe"), null);
  assert.equal(releaseDownloadUrl("https://github.com/o/r/releases/tag/v1?x=1", "x.exe"), null);
  assert.equal(releaseDownloadUrl("https://github.com/o/r/releases/tag/v1", "../x.exe"), null);
  assert.equal(releaseDownloadUrl("https://github.com/o/r/releases/tag/v1", ""), null);
});

test("each kind of install gets its own file name, matching the builder configs", () => {
  assert.deepEqual(updateFileName({ version: "0.2.0", platform: "win32", arch: "x64" }), { fileName: "Rosalena-Harness-Setup-0.2.0-x64.exe", kind: "nsis" });
  assert.deepEqual(updateFileName({ version: "0.2.0", platform: "win32", arch: "x64", portable: true }), { fileName: "Rosalena-Harness-0.2.0-x64-portable.exe", kind: "portable" });
  assert.deepEqual(updateFileName({ version: "0.2.0", platform: "darwin", arch: "arm64" }), { fileName: "Rosalena-Harness-0.2.0-arm64.zip", kind: "mac-zip" });
  assert.deepEqual(updateFileName({ version: "0.2.0", platform: "darwin", arch: "x64" }), { fileName: "Rosalena-Harness-0.2.0-x64.zip", kind: "mac-zip" });
  assert.deepEqual(updateFileName({ version: "0.2.0", platform: "linux", arch: "x64", appImage: true }), { fileName: "Rosalena-Harness-0.2.0-x86_64.AppImage", kind: "appimage" });
  assert.deepEqual(updateFileName({ version: "0.2.0", platform: "linux", arch: "x64" }), { fileName: "Rosalena-Harness-0.2.0-amd64.deb", kind: "deb" });
  assert.equal(updateFileName({ version: "0.2.0", platform: "linux", arch: "arm64", appImage: true }), null);
  assert.equal(updateFileName({ version: "0.2.0", platform: "freebsd", arch: "x64" }), null);
  assert.equal(updateFileName({ version: "0.2.0", platform: "win32", arch: "arm64" }), null);

  // The names above are the artifactName patterns the release builds use.
  const win = readFileSync(new URL("../../packaging/release/electron-builder.win.yml", import.meta.url), "utf8");
  const mac = readFileSync(new URL("../../packaging/release/electron-builder.mac.yml", import.meta.url), "utf8");
  const linux = readFileSync(new URL("../../packaging/release/electron-builder.linux.yml", import.meta.url), "utf8");
  assert.match(win, /artifactName: Rosalena-Harness-Setup-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
  assert.match(win, /artifactName: Rosalena-Harness-\$\{version\}-\$\{arch\}-portable\.\$\{ext\}/);
  assert.match(mac, /artifactName: Rosalena-Harness-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
  // electron-builder turns ${arch} into x86_64 for an AppImage and amd64 for a .deb.
  assert.match(linux, /appImage:\r?\n  artifactName: Rosalena-Harness-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
  assert.match(linux, /deb:\r?\n  artifactName: Rosalena-Harness-\$\{version\}-\$\{arch\}\.\$\{ext\}/);
});

test("an AppImage updates itself; a .deb is sent to the download page", () => {
  const both = feed({ "Rosalena-Harness-0.2.0-x86_64.AppImage": HASH, "Rosalena-Harness-0.2.0-amd64.deb": "b".repeat(64) });
  const image = pickUpdateAsset({ manifest: both, platform: "linux", arch: "x64", appImage: true });
  assert.equal(image.ok, true, image.reason);
  assert.equal(image.kind, "appimage");
  assert.equal(image.sha256, HASH);
  assert.equal(image.url, "https://github.com/Jviat0r/rosalena-harness-downloads/releases/download/v0.2.0/Rosalena-Harness-0.2.0-x86_64.AppImage");
  assert.equal(selfInstallable(image.kind), true);
  assert.equal(manualUpdateReason(image.kind), "");

  const deb = pickUpdateAsset({ manifest: both, platform: "linux", arch: "x64" });
  assert.equal(deb.ok, true, deb.reason);
  assert.equal(deb.kind, "deb");
  assert.equal(selfInstallable(deb.kind), false);
  assert.match(manualUpdateReason(deb.kind, deb.fileName), /sudo apt install \.\/Rosalena-Harness-0\.2\.0-amd64\.deb/);
  assert.match(manualUpdateReason("deb"), /download page/);
  assert.equal(DOWNLOAD_PAGE_URL, "https://rosalena.pages.dev/download/");

  // Every kind the Windows and macOS updaters already install stays self-installable.
  for (const kind of ["nsis", "portable", "mac-zip"]) assert.equal(selfInstallable(kind), true, kind);
  assert.equal(selfInstallable("anything-else"), false);

  // A feed from before Linux builds existed has no AppImage checksum: no install, a reason.
  const old = pickUpdateAsset({ manifest: feed({ "Rosalena-Harness-Setup-0.2.0-x64.exe": HASH }), platform: "linux", arch: "x64", appImage: true });
  assert.equal(old.ok, false);
  assert.match(old.reason, /no checksum for Rosalena-Harness-0\.2\.0-x86_64\.AppImage/);
});

test("the AppImage swap script waits, replaces atomically, keeps the old copy on failure, relaunches", () => {
  const script = appImageSwapScript();
  const lines = script.split("\n");
  assert.equal(lines[0], "#!/bin/sh");
  // Waits for this process: the single-instance lock would turn the new copy away otherwise.
  assert.ok(lines.indexOf('while kill -0 "$RU_PID" 2>/dev/null; do sleep 0.5; done') === 1, "waits first");
  // Copies beside the target, makes it executable, then renames over it.
  assert.match(script, /cp -f "\$RU_SOURCE" "\$RU_TARGET\.new" && chmod 755 "\$RU_TARGET\.new" && mv -f "\$RU_TARGET\.new" "\$RU_TARGET"/);
  // A failed copy removes the half-written file and leaves the old AppImage alone.
  assert.match(script, /else\n  rm -f "\$RU_TARGET\.new"\nfi/);
  assert.match(script, /unset APPIMAGE APPDIR ARGV0 OWD/);
  assert.ok(script.trimEnd().endsWith('nohup "$RU_TARGET" >/dev/null 2>&1 &'), "relaunches last");
  // Paths only ever arrive through the environment, never pasted into the text.
  assert.doesNotMatch(script, /\/home\/|\/tmp\/|\.AppImage/);
  assert.doesNotMatch(script, /\r/, "LF only: /bin/sh reads a CR as part of the command");
});

test("pickUpdateAsset returns the file, its address and its checksum", () => {
  const pick = pickUpdateAsset({
    manifest: feed({ "Rosalena-Harness-Setup-0.2.0-x64.exe": HASH }),
    platform: "win32",
    arch: "x64",
  });
  assert.equal(pick.ok, true);
  assert.equal(pick.kind, "nsis");
  assert.equal(pick.sha256, HASH);
  assert.equal(pick.url, "https://github.com/Jviat0r/rosalena-harness-downloads/releases/download/v0.2.0/Rosalena-Harness-Setup-0.2.0-x64.exe");
});

test("no checksum for this platform's file means no update to install", () => {
  const onlyMac = feed({ "Rosalena-Harness-0.2.0-arm64.zip": HASH });
  const pick = pickUpdateAsset({ manifest: onlyMac, platform: "win32", arch: "x64" });
  assert.equal(pick.ok, false);
  assert.match(pick.reason, /no checksum/);

  const badHash = feed({ "Rosalena-Harness-Setup-0.2.0-x64.exe": "not-a-hash" });
  assert.equal(pickUpdateAsset({ manifest: badHash, platform: "win32", arch: "x64" }).ok, false);
});

test("a release page that is not on GitHub gives no file address", () => {
  const pick = pickUpdateAsset({
    manifest: feed({ "Rosalena-Harness-Setup-0.2.0-x64.exe": HASH }, { url: "https://rosalena.pages.dev/download/" }),
    platform: "win32",
    arch: "x64",
  });
  assert.equal(pick.ok, false);
  assert.match(pick.reason, /not a GitHub release/);
});

test("the committed 0.1.0 feed names a verifiable file for every supported install", () => {
  const committed = JSON.parse(readFileSync(new URL("../../site/public/download/updates.json", import.meta.url), "utf8"));
  for (const target of [
    { platform: "win32", arch: "x64" },
    { platform: "win32", arch: "x64", portable: true },
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
  ]) {
    const pick = pickUpdateAsset({ manifest: committed, ...target });
    assert.equal(pick.ok, true, `${JSON.stringify(target)}: ${pick.reason}`);
    assert.match(pick.sha256, /^[0-9a-f]{64}$/);
  }
});
