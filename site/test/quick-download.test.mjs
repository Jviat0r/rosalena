// The two hero buttons: which file each one gets, and that the HTML never hardcodes one.
//
// Run with:  cd site && node --test test/quick-download.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { detectOs, macArchFromRenderer, quickPick } from '../public/download/download.js';

const manifest = JSON.parse(readFileSync(new URL('../public/download/releases.json', import.meta.url), 'utf8'));
const pageHtml = readFileSync(new URL('../public/download/index.html', import.meta.url), 'utf8');

test('Windows gets the Setup installer, not the portable exe', () => {
  const pick = quickPick(manifest.artifacts);
  assert.equal(pick.windows.kind, 'installer');
  assert.match(pick.windows.fileName, /^Rosalena-Harness-Setup-.*-x64\.exe$/);
});

test('Mac gets the disk image for the detected Mac, with the other one offered', () => {
  const silicon = quickPick(manifest.artifacts, { macArch: 'arm64' });
  assert.equal(silicon.mac.fileName, 'Rosalena-Harness-0.1.13-arm64.dmg');
  assert.equal(silicon.macOther.fileName, 'Rosalena-Harness-0.1.13-x64.dmg');

  const intel = quickPick(manifest.artifacts, { macArch: 'x64' });
  assert.equal(intel.mac.fileName, 'Rosalena-Harness-0.1.13-x64.dmg');
  assert.equal(intel.macOther.fileName, 'Rosalena-Harness-0.1.13-arm64.dmg');

  // Unknown Mac: Apple silicon.
  assert.equal(quickPick(manifest.artifacts).mac.arch, 'arm64');
});

test('an unavailable file never becomes a button', () => {
  const none = manifest.artifacts.map((entry) => ({ ...entry, available: false, url: '' }));
  const pick = quickPick(none);
  assert.equal(pick.windows, null);
  assert.equal(pick.mac, null);
  assert.equal(pick.macOther, null);
  assert.equal(pick.linux, null);
  assert.equal(pick.linuxOther, null);
});

// A release with the Linux job's two files, shaped like packaging/release/manifest.mjs writes them.
const linuxEntry = (kind, fileName) => ({
  id: `linux-x64-${kind}`,
  platform: 'linux',
  arch: 'x64',
  kind,
  fileName,
  version: '0.1.14',
  available: true,
  url: `https://github.com/Jviat0r/rosalena-harness-downloads/releases/download/v0.1.14/${fileName}`,
  size: 120000000,
  sha256: 'a'.repeat(64),
});

test('Linux gets the AppImage, with the .deb offered under it', () => {
  const withLinux = [
    ...manifest.artifacts,
    linuxEntry('appimage', 'Rosalena-Harness-0.1.14-x86_64.AppImage'),
    linuxEntry('deb', 'Rosalena-Harness-0.1.14-amd64.deb'),
  ];
  const pick = quickPick(withLinux);
  assert.equal(pick.linux.kind, 'appimage');
  assert.equal(pick.linuxOther.kind, 'deb');
  // Only a .deb: it becomes the button, with nothing under it.
  const debOnly = quickPick([...manifest.artifacts, linuxEntry('deb', 'Rosalena-Harness-0.1.14-amd64.deb')]);
  assert.equal(debOnly.linux.kind, 'deb');
  assert.equal(debOnly.linuxOther, null);
});

test('the hero buttons start at #downloads, so the HTML links no file', () => {
  assert.match(pageHtml, /id="quick-windows" href="#downloads"/);
  assert.match(pageHtml, /id="quick-mac" href="#downloads"/);
  // Linux starts as a "not built yet" box and is only turned into a download by download.js.
  assert.match(pageHtml, /id="quick-linux" href="#downloads" data-pending>Linux: not built yet</);
  // The buttons sit before the long sections, so they are near the top of the page.
  assert.ok(pageHtml.indexOf('id="quick-windows"') < pageHtml.indexOf('id="updates"'));
  assert.ok(pageHtml.indexOf('id="updates"') < pageHtml.indexOf('id="downloads"'), 'the full list sits at the bottom');
});

test('the visitor OS and Mac GPU are read conservatively', () => {
  assert.equal(detectOs({ userAgentData: { platform: 'Windows' }, userAgent: '' }), 'windows');
  assert.equal(detectOs({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), 'macos');
  assert.equal(detectOs({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)' }), 'other');
  assert.equal(detectOs({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'linux');
  assert.equal(detectOs({ userAgentData: { platform: 'Linux' }, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'linux');
  // Android and Chromebooks also say Linux; neither can run these builds.
  assert.equal(detectOs({ platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' }), 'other');
  assert.equal(detectOs({ userAgentData: { platform: 'Android' }, userAgent: 'Mozilla/5.0 (Linux; Android 15)' }), 'other');
  assert.equal(detectOs({ userAgentData: { platform: 'Chrome OS' }, userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0)' }), 'other');
  assert.equal(macArchFromRenderer('Apple M3 Pro'), 'arm64');
  assert.equal(macArchFromRenderer('Intel(R) Iris(TM) Plus Graphics'), 'x64');
  assert.equal(macArchFromRenderer('Apple GPU'), null);
});
