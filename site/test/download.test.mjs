// Tests for the download page and the release manifest it reads.
//
// Two things are being protected here:
//
// 1. The manifest may not claim a file that does not exist. An `available: true` entry
//    must carry a non-empty https url, a measured size and a SHA-256 (or an explicitly
//    empty checksum, which the page renders as "checksum pending"). An unavailable entry
//    must carry no url at all - that is what lets the page say "not built yet" instead of
//    linking to a 404.
//
// 2. The page may not invent a download. The HTML contains no link to any .exe/.dmg/.zip,
//    every such link is produced at runtime from the manifest through isDownloadable(),
//    and the page loads no script, font or stylesheet from another origin.
//
// The rendering assertions run against pure string builders exported by
// public/download/download.js, so they need no browser and no DOM.
//
// Run with:  cd site && node --test test/download.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  archLabel,
  checksumText,
  escapeHtml,
  formatBytes,
  isDownloadable,
  isSafeUrl,
  kindLabel,
  loadManifest,
  platformsFor,
  renderArtifact,
  renderPlatform,
  renderRows,
  validateManifest,
} from '../public/download/download.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(HERE, '..', 'public');

const pageHtml = readFileSync(resolve(PUBLIC, 'download', 'index.html'), 'utf8');
const pageJs = readFileSync(resolve(PUBLIC, 'download', 'download.js'), 'utf8');
const manifestText = readFileSync(resolve(PUBLIC, 'download', 'releases.json'), 'utf8');
const manifest = JSON.parse(manifestText);

const HEX64 = /^[0-9a-f]{64}$/;
// Kept out of the file: a checksum in the page HTML would be a second copy of a fact that
// releases.json owns, and the copy is the thing that goes stale. The manifest itself is
// where a hash is allowed to appear.

const availableEntry = {
  id: 'windows-x64-installer',
  platform: 'windows',
  arch: 'x64',
  kind: 'installer',
  fileName: 'Rosalena-Harness-Setup-0.1.0-x64.exe',
  version: '0.1.0',
  available: true,
  url: 'https://example.test/releases/download/v0.1.0/Rosalena-Harness-Setup-0.1.0-x64.exe',
  sha256: 'a'.repeat(64),
  size: 1048576,
  note: '',
};

const unavailableEntry = {
  id: 'macos-arm64-dmg',
  platform: 'macos',
  arch: 'arm64',
  kind: 'dmg',
  fileName: 'Rosalena-Harness-0.1.0-arm64.dmg',
  version: '0.1.0',
  available: false,
  url: '',
  sha256: '',
  size: 0,
  note: 'Not built yet: a macOS file can only come from a macOS runner.',
};

// ----------------------------------------------------------------- the manifest file

test('releases.json parses as JSON', () => {
  assert.equal(typeof manifest, 'object');
  assert.ok(manifest !== null);
  assert.doesNotThrow(() => JSON.parse(manifestText));
});

test('manifest declares the schema the page and the tests expect', () => {
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.product, 'Rosalena Harness');
  assert.match(manifest.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.match(manifest.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Array.isArray(manifest.platforms) && manifest.platforms.length >= 2);
  assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length >= 2);
});

test('manifest covers Windows and macOS, and only platforms the page knows (Linux from its first build)', () => {
  const ids = manifest.platforms.map((platform) => platform.id);
  assert.ok(ids.includes('windows') && ids.includes('macos'), ids.join(','));
  for (const id of ids) assert.ok(['windows', 'macos', 'linux'].includes(id), `unknown platform ${id}`);
  for (const platform of manifest.platforms) {
    assert.equal(typeof platform.label, 'string');
    assert.ok(platform.label.length > 0);
    assert.ok(['available', 'partial', 'not-built-yet'].includes(platform.status));
  }
});

test('every artifact carries the documented fields', () => {
  for (const entry of manifest.artifacts) {
    assert.equal(typeof entry.id, 'string', 'id');
    assert.ok(['windows', 'macos', 'linux'].includes(entry.platform), `platform of ${entry.id}`);
    assert.ok(['x64', 'arm64', 'universal'].includes(entry.arch), `arch of ${entry.id}`);
    assert.ok(['installer', 'portable', 'dmg', 'zip', 'appimage', 'deb'].includes(entry.kind), `kind of ${entry.id}`);
    assert.equal(typeof entry.fileName, 'string', `fileName of ${entry.id}`);
    assert.equal(typeof entry.version, 'string', `version of ${entry.id}`);
    assert.equal(typeof entry.available, 'boolean', `available of ${entry.id}`);
    assert.equal(typeof entry.url, 'string', `url of ${entry.id}`);
    assert.equal(typeof entry.sha256, 'string', `sha256 of ${entry.id}`);
    assert.equal(typeof entry.size, 'number', `size of ${entry.id}`);
  }
});

test('artifact ids are unique', () => {
  const ids = manifest.artifacts.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every available artifact has a url, a size and a 64-hex sha256', () => {
  for (const entry of manifest.artifacts.filter((item) => item.available)) {
    assert.ok(entry.url.length > 0, `${entry.id} needs a url`);
    assert.match(entry.url, /^https:\/\//, `${entry.id} url must be https`);
    assert.ok(HEX64.test(entry.sha256), `${entry.id} needs a 64-hex sha256, got "${entry.sha256}"`);
    assert.ok(entry.size > 0, `${entry.id} needs a measured size`);
  }
});

test('an empty checksum is allowed only while the page can say why it is empty', () => {
  // Every entry either carries a real 64-hex hash or explains its empty one: "checksum
  // pending" for a file that exists but has not been hashed, "not built yet" for a file
  // that does not exist. A blank cell is never acceptable.
  for (const entry of manifest.artifacts) {
    assert.ok(
      entry.sha256 === '' || HEX64.test(entry.sha256),
      `${entry.id} sha256 is neither empty nor 64-hex: "${entry.sha256}"`,
    );
    if (entry.sha256 === '') {
      const expected = entry.available === true ? 'checksum pending' : 'not built yet';
      assert.equal(checksumText(entry), expected);
    } else {
      assert.equal(checksumText(entry), entry.sha256);
    }
  }
});

test('an unavailable artifact never carries a url or a checksum', () => {
  for (const entry of manifest.artifacts.filter((item) => item.available !== true)) {
    assert.equal(entry.url, '', `${entry.id} must not carry a url while unavailable`);
    assert.equal(entry.sha256, '', `${entry.id} must not carry a checksum while unavailable`);
    assert.equal(entry.size, 0, `${entry.id} must not carry a size while unavailable`);
  }
});

test('no entry is half-published: available and url always agree', () => {
  for (const entry of manifest.artifacts) {
    assert.equal(entry.available, entry.url !== '', `${entry.id}: available and url disagree`);
  }
});

test('file names are version-stamped and end in a real artifact extension', () => {
  for (const entry of manifest.artifacts) {
    assert.ok(
      ['.exe', '.dmg', '.zip', '.AppImage', '.deb'].some((extension) => entry.fileName.endsWith(extension)),
      entry.fileName,
    );
    assert.ok(entry.fileName.includes(manifest.version), `${entry.fileName} is not stamped with ${manifest.version}`);
    assert.ok(!entry.fileName.includes(' '), `${entry.fileName} should not contain spaces`);
  }
});

test('a platform is marked available only when one of its files is', () => {
  for (const platform of manifest.platforms) {
    const own = manifest.artifacts.filter((entry) => entry.platform === platform.id);
    const available = own.filter((entry) => entry.available).length;
    if (platform.status === 'available') assert.equal(available, own.length);
    if (platform.status === 'not-built-yet') assert.equal(available, 0);
    if (platform.status === 'partial') assert.ok(available > 0 && available < own.length);
  }
});

test('the committed manifest claims a file only with evidence behind it', () => {
  // This was the honest state of the repository while nothing was built: zero available
  // entries. v0.1.13 is published now, so the test flips to the rule that replaced it - an
  // available entry has to look like a file someone measured, and the downloads have to
  // live on the public binaries repo, because a Pages site cannot serve a 107 MB installer.
  const published = manifest.artifacts.filter((entry) => entry.available);
  assert.ok(published.length > 0, 'v0.1.13 is published, so something must be available');
  for (const entry of published) {
    assert.ok(entry.size > 1024 * 1024, `${entry.id} size is not a plausible installer: ${entry.size}`);
    assert.match(entry.url, /^https:\/\/github\.com\/Jviat0r\/rosalena-harness-downloads\/releases\/download\//);
    assert.ok(entry.url.endsWith(`/${entry.fileName}`), `${entry.id} url does not end in its own file name`);
  }
  assert.equal(manifest.version, '0.1.13');
});

test('every checksum in the committed manifest is a real sha256, and there is one per file', () => {
  for (const entry of manifest.artifacts) {
    if (!entry.available) continue;
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.id} has no usable sha256`);
  }
  // And none of them may be a placeholder repeated across rows.
  const hashes = manifest.artifacts.filter((entry) => entry.available).map((entry) => entry.sha256);
  assert.equal(new Set(hashes).size, hashes.length, 'two files cannot share one checksum');
});

// ------------------------------------------------------------- the page (static HTML)

test('the page loads the manifest at runtime from a same-origin module', () => {
  assert.match(pageHtml, /<script type="module" src="\/download\/download\.js"><\/script>/);
  assert.match(pageJs, /new URL\("releases\.json", import\.meta\.url\)/);
  assert.match(pageJs, /fetch/);
});

test('the page names every file and links none of them itself', () => {
  // The names may appear in the HTML: reading "Rosalena-Harness-Setup-0.1.0-x64.exe" with
  // "in releases.json" beside it is what a crawler or a reader without JavaScript gets, and
  // it is what makes the page useful before download.js runs. What may not appear is a link
  // to a file, or a claim about a size or a checksum that only releases.json can make.
  const hrefs = [...pageHtml.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  for (const href of hrefs) {
    assert.ok(!/\.(exe|dmg|zip|msi)(\?|#|$)/i.test(href), `hardcoded artifact link in the HTML: ${href}`);
  }
  for (const entry of manifest.artifacts) {
    assert.ok(pageHtml.includes(entry.fileName), `the static page never names ${entry.fileName}`);
  }
  const tbody = /id="artifact-rows">([\s\S]*?)<\/tbody>/.exec(pageHtml)?.[1] ?? '';
  const rows = tbody.split('</tr>').filter((row) => row.includes('<tr'));
  assert.equal(rows.length, manifest.artifacts.length, 'one static row per planned file');
  for (const row of rows) {
    assert.match(row, /data-available="false"/, 'a static row may not claim a file exists');
    assert.ok(!/<a\b/i.test(row), 'a static row may not link a file');
    assert.ok(!/Not built yet|Available/.test(row), 'a static row may not answer a question only releases.json can answer');
    assert.match(row, /in releases\.json/, 'the size and checksum cells must say where the real values are');
  }
});

test('the page references no external script, stylesheet or font', () => {
  for (const match of pageHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    assert.ok(!/^(https?:)?\/\//i.test(match[1]), `external script: ${match[1]}`);
  }
  // <link rel="canonical"> and rel="alternate" are metadata, not loads. Everything that
  // makes the browser fetch bytes from another origin is what this test forbids.
  const LOADING_RELS = ['stylesheet', 'preconnect', 'dns-prefetch', 'preload', 'modulepreload', 'manifest', 'icon', 'font'];
  for (const match of pageHtml.matchAll(/<link\b[^>]*>/g)) {
    const tag = match[0];
    const rel = (/\brel="([^"]*)"/.exec(tag)?.[1] ?? '').toLowerCase();
    const href = /\bhref="([^"]*)"/.exec(tag)?.[1] ?? '';
    if (!LOADING_RELS.some((loading) => rel.split(/\s+/).includes(loading))) continue;
    assert.ok(!/^(https?:)?\/\//i.test(href), `external ${rel} from ${href}`);
  }
  assert.ok(!/@import\s/i.test(pageHtml), 'no CSS @import');
  for (const host of ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'google-analytics']) {
    assert.ok(!pageHtml.includes(host), `page must not reference ${host}`);
    assert.ok(!pageJs.includes(host), `download.js must not reference ${host}`);
  }
  assert.ok(!/<link[^>]+stylesheet[^>]+crossorigin/i.test(pageHtml), 'no cross-origin stylesheet');
});

test('the page degrades honestly without JavaScript', () => {
  assert.match(pageHtml, /<noscript>/);
  assert.match(pageHtml, /cannot read <code>releases\.json<\/code>/);
  // The static rows name the files and point at the one place that can answer the size and
  // checksum question, so with scripting off the page still answers instead of spinning.
  assert.match(pageHtml, /id="artifact-rows"[\s\S]*in releases\.json/);
  // And the reader is not left with nothing to click: the release page is a page, not a file.
  const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(pageHtml)?.[1] ?? '';
  assert.match(noscript, /releases\/tag\/v0\.1\.13/);
  assert.ok(!/\.(exe|dmg|zip)["']/.test(noscript), 'the no-JavaScript path must not link a file');
});

test('the page still contains one anchor target for each platform card', () => {
  assert.match(pageHtml, /id="platforms"/);
  assert.match(pageHtml, /id="artifact-rows"/);
  assert.match(pageHtml, /id="manifest-stamp"/);
  assert.match(pageHtml, /id="manifest-error"/);
});

// ------------------------------------------------------------------ the page rendering

test('an unavailable artifact renders as text, with no anchor at all', () => {
  const html = renderArtifact(unavailableEntry);
  assert.match(html, /Not built yet/);
  assert.ok(!/<a\b/i.test(html), `unavailable artifact must not contain a link:\n${html}`);
  assert.ok(!/href=/i.test(html), 'unavailable artifact must not contain an href');
  assert.equal(isDownloadable(unavailableEntry), false);
});

test('an available artifact renders a link, its size, its version and its checksum', () => {
  const html = renderArtifact(availableEntry);
  assert.match(html, new RegExp(`href="${availableEntry.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(html, /Download 1 MB/);
  assert.match(html, /1,048,576 bytes/);
  assert.match(html, /0\.1\.0/);
  assert.ok(html.includes(availableEntry.sha256));
  assert.match(html, /data-available="true"/);
});

test('an available artifact with an empty checksum says "checksum pending"', () => {
  const html = renderArtifact({ ...availableEntry, sha256: '' });
  assert.match(html, /checksum pending/);
  assert.ok(!html.includes('data-available="false"'));
  assert.match(html, /href=/, 'the link is still offered when only the checksum is missing');
});

test('a script URL is not a download, whatever the manifest says', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://example.test/file.exe',
    'https://example.test/file.exe" onclick="alert(1)',
    '',
  ]) {
    const entry = { ...availableEntry, url };
    assert.equal(isSafeUrl(url), false, `accepted ${JSON.stringify(url)}`);
    assert.equal(isDownloadable(entry), false);
    const html = renderArtifact(entry);
    assert.ok(!/<a\b/i.test(html), `rendered a link for ${JSON.stringify(url)}`);
  }
});

test('manifest values are escaped before they reach the page', () => {
  const hostile = {
    ...availableEntry,
    fileName: 'Rosalena-Harness-Setup-<img src=x onerror=alert(1)>.exe',
    note: '"><script>alert(1)</script>',
  };
  const html = renderArtifact(hostile);
  assert.ok(!html.includes('<img'), 'filename was not escaped');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'note was not escaped');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
});

test('a platform card shows every artifact of that platform once', () => {
  const html = renderPlatform(
    { id: 'windows', label: 'Windows', requirement: 'Windows 10 or 11, 64-bit', status: 'available' },
    [availableEntry, unavailableEntry],
  );
  assert.match(html, /data-platform="windows"/);
  assert.equal(html.match(/class="artifact"/g).length, 1);
  assert.match(html, /Rosalena-Harness-Setup-0\.1\.0-x64\.exe/);
  assert.ok(!html.includes('Rosalena-Harness-0.1.0-arm64.dmg'), 'other platforms do not leak into this card');
  assert.match(html, /data-status="available"/);
});

test('a card with no artifacts says so instead of showing an empty box', () => {
  const html = renderPlatform({ id: 'macos', label: 'macOS', requirement: '', status: 'not-built-yet' }, [availableEntry]);
  assert.match(html, /No file listed for this platform/);
});

test('the flat table keeps unavailable rows link-free', () => {
  const html = renderRows([availableEntry, unavailableEntry]);
  const rows = html.split('</tr>').filter((row) => row.includes('<tr'));
  assert.equal(rows.length, 2);
  const unavailableRow = rows.find((row) => row.includes('Rosalena-Harness-0.1.0-arm64.dmg')) ?? '';
  assert.ok(unavailableRow.length > 0, 'the unavailable artifact must appear in the table');
  assert.ok(!/<a\b/i.test(unavailableRow), 'unavailable row must not link');
  assert.match(unavailableRow, /Not built yet/);
  assert.match(unavailableRow, /not built yet/, 'a file that does not exist says so, not "checksum pending"');
  const availableRow = rows.find((row) => row.includes('Rosalena-Harness-Setup-0.1.0-x64.exe')) ?? '';
  assert.match(availableRow, /<a href=/);
  assert.ok(availableRow.includes(availableEntry.sha256));
});

test('the real manifest renders a link for every file it says is available', () => {
  const html = renderRows(manifest.artifacts);
  const available = manifest.artifacts.filter((entry) => entry.available);
  assert.equal(html.match(/<a href=/g)?.length, available.length, 'one link per available file, no more');
  for (const entry of available) {
    assert.ok(html.includes(entry.sha256), `${entry.id}: the row must carry the published checksum`);
    assert.ok(html.includes(entry.url.replace(/&/g, '&amp;')), `${entry.id}: the row must link the published url`);
  }
  const cards = manifest.platforms
    .map((platform) => renderPlatform(platform, manifest.artifacts))
    .join('\n');
  assert.equal(cards.match(/data-available="true"/g)?.length, available.length);
  assert.equal(cards.match(/data-available="false"/g)?.length ?? 0, 0, 'nothing is missing from 0.1.0');
  // The platform note is where the signing caveat belongs, once per card, not once per row.
  assert.equal(cards.match(/class="note platform-note"/g)?.length, manifest.platforms.length);
  assert.match(cards, /Unsigned and not notarized/);
});

// --------------------------------------------------------------------- manifest checks

test('validateManifest accepts the real manifest', () => {
  assert.deepEqual(validateManifest(manifest), []);
});

test('validateManifest rejects a manifest that claims a file without a url', () => {
  const broken = {
    ...manifest,
    artifacts: [{ ...unavailableEntry, available: true }],
  };
  const problems = validateManifest(broken);
  assert.ok(problems.length > 0);
  assert.match(problems.join(' '), /available but has no safe https url/);
});

test('validateManifest rejects a url on an unavailable entry and a malformed hash', () => {
  const problems = validateManifest({
    ...manifest,
    artifacts: [
      { ...unavailableEntry, url: 'https://example.test/x.dmg' },
      { ...availableEntry, sha256: 'not-a-hash' },
    ],
  });
  assert.match(problems.join(' '), /not available but carries a url/);
  assert.match(problems.join(' '), /malformed sha256/);
});

test('loadManifest fetches the file next to the module and refuses a bad response', async () => {
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => manifest };
  };
  const loaded = await loadManifest(fakeFetch, 'https://example.test/download/releases.json');
  assert.equal(loaded.version, manifest.version);
  assert.deepEqual(seen, ['https://example.test/download/releases.json']);

  const failing = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(() => loadManifest(failing, 'https://example.test/download/releases.json'), /HTTP 404/);

  const broken = async () => ({ ok: true, status: 200, json: async () => ({ artifacts: 'nope' }) });
  await assert.rejects(() => loadManifest(broken, 'https://example.test/download/releases.json'), /no artifacts array/);
});

// --------------------------------------------------------------------------- formatting

test('formatBytes uses binary units and never renders a negative size', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1 MB');
  assert.equal(formatBytes(104857600), '100 MB');
  assert.equal(formatBytes(399225667), '380.7 MB');
});

test('arch and kind labels are written for people, not for the manifest', () => {
  assert.equal(archLabel('macos', 'arm64'), 'Apple silicon (arm64)');
  assert.equal(archLabel('macos', 'x64'), 'Intel (x64)');
  assert.equal(archLabel('windows', 'x64'), 'x64');
  assert.equal(kindLabel('installer'), 'Installer (.exe)');
  assert.equal(kindLabel('portable'), 'Portable app (.exe)');
  assert.equal(kindLabel('dmg'), 'Disk image (.dmg)');
  assert.equal(kindLabel('zip'), 'Zip archive (.zip)');
  assert.equal(kindLabel('appimage'), 'AppImage (.AppImage)');
  assert.equal(kindLabel('deb'), 'Debian package (.deb)');
});

test('a platform the manifest leaves out still gets a "Not built yet" card, with no link', () => {
  const cards = platformsFor({ platforms: [{ id: 'windows', status: 'available' }, { id: 'macos', status: 'available' }], artifacts: [] });
  assert.deepEqual(cards.map((card) => card.id), ['windows', 'macos', 'linux']);
  const linux = cards.find((card) => card.id === 'linux');
  assert.equal(linux.status, 'not-built-yet');
  const html = renderPlatform(linux, []);
  assert.match(html, /Linux <span class="badge" data-status="not-built-yet">Not built yet<\/span>/);
  assert.match(html, /release pipeline&#39;s Linux job/);
  assert.ok(!/<a\b/i.test(html), 'a missing platform must not link anything');
  // Once a release lists Linux, the manifest's own card is used and nothing is added twice.
  const listed = platformsFor({ platforms: [{ id: 'windows' }, { id: 'macos' }, { id: 'linux', status: 'available' }] });
  assert.equal(listed.filter((card) => card.id === 'linux').length, 1);
  assert.equal(listed.find((card) => card.id === 'linux').status, 'available');
});
