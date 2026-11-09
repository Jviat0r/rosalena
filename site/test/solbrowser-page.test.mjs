// /download/solbrowser/: the SolBrowser extension zip the page offers is the file it names.
//
//   - the SHA-256 and size on the page are the zip's own
//   - the zip holds one solbrowser-extension/ folder with a manifest, and its paths use "/"
//     (a zip written with "\" unpacks into odd file names on macOS and Linux)
//   - the download page sends people here instead of linking a file itself
//
//   node --test test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = join(HERE, '..', 'public', 'download', 'solbrowser');
const page = readFileSync(join(PAGE_DIR, 'index.html'), 'utf8');
const downloadPage = readFileSync(join(HERE, '..', 'public', 'download', 'index.html'), 'utf8');

const zipName = /href="\/download\/solbrowser\/(solbrowser-extension-[\d.]+\.zip)"/.exec(page)?.[1];

test('the page names a zip that exists, with its real SHA-256 and size', () => {
  assert.ok(zipName, 'the page links the extension zip');
  const bytes = readFileSync(join(PAGE_DIR, zipName));
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.ok(page.includes(sha), `the page must show the zip's SHA-256 ${sha}`);
  const kb = Math.round(statSync(join(PAGE_DIR, zipName)).size / 1024);
  assert.ok(page.includes(`${kb} KB`), `the page must show ${kb} KB`);
});

test('the zip is one solbrowser-extension folder with a manifest, and "/" paths', () => {
  const bytes = readFileSync(join(PAGE_DIR, zipName));
  // Central directory entries: signature PK\x01\x02, name length at +28, name at +46.
  const names = [];
  for (let i = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); i >= 0; i = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i + 4)) {
    const len = bytes.readUInt16LE(i + 28);
    names.push(bytes.subarray(i + 46, i + 46 + len).toString('utf8'));
  }
  assert.ok(names.length > 5, 'the zip has entries');
  assert.ok(names.includes('solbrowser-extension/manifest.json'));
  for (const name of names) {
    assert.ok(name.startsWith('solbrowser-extension/'), name);
    assert.ok(!name.includes('\\'), `backslash in ${name}`);
  }
});

test('the download page sends people to the extension page, not to a file', () => {
  assert.match(downloadPage, /href="\/download\/solbrowser\/"/);
  assert.doesNotMatch(downloadPage, /solbrowser-extension-[\d.]+\.zip/);
});
