// Tests for the update feed and the block the download page shows about it.
//
// The rule being protected is the same one test/download.test.mjs protects for the
// download list, one step earlier in the chain: the page and the app may describe what
// has been published, and they may not claim a release that does not exist. Today the
// committed updates.json names version 0.1.14, carries the date the files were published,
// the release page on the public downloads repository, the release notes, and the size and
// SHA-256 of every file - because that release does exist. The same file, stated the other
// way, is releases.json, and the two are cross-checked here so they cannot drift apart.
//
// The manifest is validated with the harness module the app itself uses
// (harness/src/update.mjs), so a manifest this test accepts is one the app accepts. If
// the two ever disagree, the app would report "the check could not be completed" for a
// file the site thinks is fine - which is exactly the bug this import prevents.
//
// Run with:  cd site && node --test test/updates.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  compareVersions,
  decideUpdate,
  parseVersion,
  readVersionFromPackage,
  shouldCheck,
  validateUpdateManifest,
} from '../../harness/src/update.mjs';

import { isSafeUrl, loadUpdates, renderUpdatesNotice } from '../public/download/download.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const PUBLIC = resolve(HERE, '..', 'public');

const pageHtml = readFileSync(resolve(PUBLIC, 'download', 'index.html'), 'utf8');
const pageJs = readFileSync(resolve(PUBLIC, 'download', 'download.js'), 'utf8');
const updatesText = readFileSync(resolve(PUBLIC, 'download', 'updates.json'), 'utf8');
const updates = JSON.parse(updatesText);
const releases = JSON.parse(readFileSync(resolve(PUBLIC, 'download', 'releases.json'), 'utf8'));
const appVersion = readVersionFromPackage(readFileSync(resolve(REPO, 'desktop', 'package.json'), 'utf8'));

// The feed now carries a real release date, and the validator refuses a manifest dated in
// the future, so "now" for these tests is fixed one minute after the feed's own date: the
// comparison being tested is the version decision, not the wall clock.
const NOW = Date.parse(updates.releasedAt ?? '2026-10-20T12:00:00.000Z') + 60 * 1000;

/** The one place the published release lives, named once so a move is a single edit. */
const DOWNLOADS = 'https://github.com/Jviat0r/rosalena-harness-downloads';
const RELEASE_PAGE = `${DOWNLOADS}/releases/tag/v${updates.version}`;

// ------------------------------------------------------------------------ the file

test('updates.json parses as JSON', () => {
  assert.equal(typeof updates, 'object');
  assert.ok(updates !== null);
  assert.doesNotThrow(() => JSON.parse(updatesText));
});

test('the committed feed passes the validator the app itself runs', () => {
  const checked = validateUpdateManifest(updates, { now: NOW });
  assert.equal(checked.ok, true, checked.ok ? '' : checked.reason);
  // Cleaning must not have dropped the fields the app reads.
  assert.equal(checked.manifest.schema, 1);
  assert.equal(checked.manifest.channel, 'stable');
  assert.equal(checked.manifest.version, '0.1.14');
  assert.equal(Number.isFinite(Date.parse(checked.manifest.releasedAt)), true, 'the release has a date');
  assert.equal(checked.manifest.url, RELEASE_PAGE, 'the app is given the release page');
  assert.ok(checked.manifest.notes.trim().length > 200, 'the feed quotes the release notes');
  // Eight since 0.1.14: Windows 2, macOS 4, Linux 2 (AppImage and .deb).
  assert.equal(Object.keys(checked.manifest.artifacts).length, 8, 'all eight files are described');
});

test('the feed names exactly the version the app is', () => {
  // A feed pointing at a version this build is not is how "you are up to date" turns
  // into "you are behind" on the very first launch.
  assert.equal(appVersion, '0.1.14');
  assert.equal(updates.version, appVersion);
  assert.equal(parseVersion(updates.version).prerelease.length, 0, 'stable channel means no prerelease');
});

test('the committed feed describes a release that exists, with nothing invented', () => {
  assert.equal(typeof updates.releasedAt, 'string', 'a published release has a date');
  assert.match(updates.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  assert.equal(updates.url, RELEASE_PAGE, 'the feed links the release page, never a file');
  assert.ok(updates.notes.includes('Rosalena Harness 0.1.14'), 'the notes it quotes are this release');
  // Every url the feed mentions has to be the downloads repository, and a page rather than
  // a file: the app renders this with a single link and must not become a second downloader.
  for (const match of updatesText.matchAll(/https?:\/\/[^"\s\\]+/g)) {
    const url = match[0];
    assert.ok(url.startsWith(`${DOWNLOADS}/`), `feed url is outside the downloads repository: ${url}`);
    assert.ok(!/\.(exe|dmg|zip|msi)$/i.test(url), `feed carries a direct file url: ${url}`);
  }
});

test('the download manifest agrees with the feed, file by file', () => {
  // The two files describe the same fact from two directions, and each one is read by a
  // different audience: releases.json by the page, updates.json by the installed app. If
  // they ever disagreed, the app would offer a version whose files were not what the page
  // said they were.
  assert.equal(releases.version, updates.version);
  const available = releases.artifacts.filter((entry) => entry.available === true);
  assert.equal(available.length, 8, 'eight files were measured and published');
  assert.equal(Object.keys(updates.artifacts).length, available.length);
  for (const entry of available) {
    // updates.json maps file name to SHA-256 (that is all the app needs to tell a user
    // what it downloaded); releases.json carries the size and the url with it.
    const fed = updates.artifacts[entry.fileName];
    assert.equal(fed, entry.sha256, `${entry.fileName}: same SHA-256 in both files`);
    assert.match(fed, /^[0-9a-f]{64}$/);
    assert.ok(entry.url.startsWith(`${DOWNLOADS}/releases/download/v${updates.version}/`), `${entry.fileName}: url is the published asset`);
    assert.ok(entry.url.endsWith(`/${entry.fileName}`), `${entry.fileName}: url names its own file`);
  }
  // A checksum that appears twice is a copy-paste, not a measurement.
  assert.equal(new Set(available.map((entry) => entry.sha256)).size, available.length);
});

// ---------------------------------------------------------------------- the decision

test('an installed 0.1.14 is told it is up to date, not offered an update', () => {
  const verdict = decideUpdate({ current: appVersion, manifest: updates, now: NOW });
  assert.equal(verdict.state, 'current');
  assert.equal(verdict.current, '0.1.14');
  assert.equal(verdict.latest, '0.1.14');
  assert.equal(verdict.reason, 'you are up to date at 0.1.14');
  // The release page travels with the verdict, but a current install is not offered it as
  // an update: the state, not the presence of a url, is what the window acts on.
  assert.equal(verdict.url, RELEASE_PAGE);
});

test('the three states are the only answers, and the committed feed reaches two of them', () => {
  const older = decideUpdate({ current: '0.1.0', manifest: updates, now: NOW });
  assert.equal(older.state, 'available');
  assert.equal(older.url, RELEASE_PAGE, 'an older install is given the release page');
  assert.match(older.reason, /0\.1\.14 is available/);

  const same = decideUpdate({ current: '0.1.14', manifest: updates, now: NOW });
  assert.equal(same.state, 'current');

  const nothing = decideUpdate({ current: '0.1.0', manifest: null, now: NOW });
  assert.equal(nothing.state, 'unknown');

  const states = new Set([older.state, same.state, nothing.state]);
  assert.deepEqual([...states].sort(), ['available', 'current', 'unknown']);
});

test('a newer version without a release page is unknown, never "available"', () => {
  const verdict = decideUpdate({
    current: '0.1.0',
    manifest: { ...updates, version: '0.2.0', releasedAt: '2026-10-01T00:00:00.000Z', url: '' },
    now: NOW,
  });
  assert.equal(verdict.state, 'unknown');
  assert.match(verdict.reason, /no release page/);
  assert.equal(verdict.url, '');
});

test('an installed version newer than the feed is still "current"', () => {
  const verdict = decideUpdate({ current: '0.1.15', manifest: updates, now: NOW });
  assert.equal(verdict.state, 'current');
  assert.match(verdict.reason, /newer than the published 0\.1\.14/);
  assert.equal(compareVersions('0.1.15', updates.version), 1);
});

test('the feed is checked at most every six hours, and on demand', () => {
  assert.equal(shouldCheck({ lastCheckedAt: NOW - 60 * 60 * 1000, now: NOW }), false);
  assert.equal(shouldCheck({ lastCheckedAt: NOW - 6 * 60 * 60 * 1000, now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: null, now: NOW }), true);
});

// ------------------------------------------------------------------------ the page

test('the page explains the interval, the identifiers and the no-install rule', () => {
  assert.match(pageHtml, /id="updates"/);
  assert.match(pageHtml, /How the installed app checks for updates/);
  // How often.
  assert.match(pageHtml, /Every 6 hours at most/);
  assert.match(pageHtml, /Check for updates/);
  // No identifiers on the wire.
  assert.match(pageHtml, /carries no identifiers/);
  assert.match(pageHtml, /no query string/);
  assert.match(pageHtml, /Accept: application\/json/);
  // It asks before installing, and it verifies what it installs.
  assert.match(pageHtml, /It asks first\./);
  assert.match(pageHtml, /Update and restart/);
  assert.match(pageHtml, /Nothing is downloaded or installed until you choose Update and restart/);
  assert.match(pageHtml, /refuses it unless its SHA-256 matches/);
  assert.match(pageHtml, /release page/);
  // The three answers, spelled out.
  assert.match(pageHtml, /you are up to date/);
  assert.match(pageHtml, /a newer version exists/);
  assert.match(pageHtml, /the check could not be completed/);
});

test('the page names the feed and reads it from a same-origin module', () => {
  assert.match(pageHtml, /\/download\/updates\.json/);
  assert.match(pageJs, /new URL\("updates\.json", import\.meta\.url\)/);
  assert.match(pageHtml, /<div class="updates-notice" id="updates-status"/);
});

test('the page still offers no download link of its own', () => {
  // The update block must not become a second way to link a file.
  for (const match of pageHtml.matchAll(/href="([^"]*)"/g)) {
    assert.ok(!/\.(exe|dmg|zip|msi)(\?|#|$)/i.test(match[1]), `hardcoded artifact link: ${match[1]}`);
  }
  // An update is offered, never installed silently: no page text may claim otherwise.
  assert.ok(!/(silent|automatic)(ally)? (update|install)/i.test(pageHtml), 'no page text may promise an install without asking');
});

// ------------------------------------------------------------------- the notice render

test('the notice for the committed feed announces it, with one link to the release page', () => {
  const html = renderUpdatesNotice(updates);
  assert.match(html, /data-updates-state="available"/);
  assert.match(html, /0\.1\.14/);
  assert.equal((html.match(/<a\b/g) ?? []).length, 1, 'exactly one link, so the block is not a second download list');
  assert.match(html, new RegExp(`href="${RELEASE_PAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /installs it only after you say yes and its SHA-256 matches/);
});

test('a feed with no release page and no date says nothing is published yet, and links nothing', () => {
  const html = renderUpdatesNotice({ version: '0.1.0', channel: 'stable' });
  assert.match(html, /data-updates-state="none"/);
  assert.match(html, /you are up to date at 0\.1\.0/);
  assert.ok(!/<a\b/i.test(html), `the notice must not link while nothing is published:\n${html}`);
  assert.ok(!/href=/i.test(html));
});

test('the notice for a published feed links the release page and says it asks before installing', () => {
  const published = {
    ...updates,
    version: '0.2.0',
    releasedAt: '2026-10-01T00:00:00.000Z',
    notes: 'Faster cold starts.',
    url: 'https://github.com/rosalena/harness/releases/tag/v0.2.0',
  };
  const html = renderUpdatesNotice(published);
  assert.match(html, /data-updates-state="available"/);
  assert.match(html, /0\.2\.0/);
  assert.match(html, /href="https:\/\/github\.com\/rosalena\/harness\/releases\/tag\/v0\.2\.0"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /installs it only after you say yes and its SHA-256 matches/);
});

test('a hostile url is never rendered as a link, whatever the feed says', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'http://example.test/x', 'file:///C:/x']) {
    assert.equal(isSafeUrl(url), false);
    const html = renderUpdatesNotice({ ...updates, version: '0.2.0', url });
    assert.ok(!/<a\b/i.test(html), `rendered a link for ${JSON.stringify(url)}`);
    assert.ok(!html.includes('example.test'), 'a refused url must not appear in the text either');
  }
});

test('a feed with a date but no page says the check could not be completed', () => {
  const html = renderUpdatesNotice({ ...updates, url: '' });
  assert.match(html, /data-updates-state="unknown"/);
  assert.match(html, /no release page/);
  assert.ok(!/<a\b/i.test(html));
});

test('a feed with no version is reported as unreadable, not as an update', () => {
  for (const value of [null, {}, { version: '   ' }]) {
    const html = renderUpdatesNotice(value);
    assert.match(html, /data-updates-state="unreadable"/);
    assert.ok(!/<a\b/i.test(html));
  }
});

// --------------------------------------------------------------------- the feed loader

test('loadUpdates fetches the file next to the module and refuses a bad response', async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => updates };
  };
  const loaded = await loadUpdates(fakeFetch, 'https://example.test/download/updates.json');
  assert.equal(loaded.version, updates.version);
  assert.deepEqual(seen, ['https://example.test/download/updates.json']);

  const failing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => loadUpdates(failing, 'https://example.test/download/updates.json'), /HTTP 404/);

  const wrongSchema = async () => ({ ok: true, status: 200, json: async () => ({ schema: 2, version: '0.1.0' }) });
  await assert.rejects(() => loadUpdates(wrongSchema, 'https://example.test/download/updates.json'), /schema is 2/);

  const broken = async () => ({ ok: true, status: 200, json: async () => [] });
  await assert.rejects(() => loadUpdates(broken, 'https://example.test/download/updates.json'), /not an object/);
});
