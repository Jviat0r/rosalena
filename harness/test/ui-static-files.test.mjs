/**
 * Every file the window loads from its own server is on the server's list of UI files.
 *
 * harness/src/ui.mjs serves harness/ui files from an explicit list, so a new stylesheet,
 * script or icon that the page references but the list leaves out is a silent 404 (the rose
 * icon was, until 2026-11-09). This reads the references out of index.html and app.js and
 * checks each one against that list; links to app pages (/usage, /models, ...) are skipped
 * because they are routes, not files.
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const server = read("../src/ui.mjs");
const page = read("../ui/index.html");
const app = read("../ui/app.js");

const FILE = /\.(m?js|css|svg|png|ico|woff2?)$/i;

test("every UI file the page and app.js load is served by ui.mjs", () => {
  const refs = new Set();
  for (const m of page.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) if (FILE.test(m[1])) refs.add(m[1]);
  for (const m of app.matchAll(/(?:from |import\()"\.(\/[a-z0-9-]+\.m?js)"/gi)) refs.add(m[1]);
  assert.ok(refs.size >= 10, `expected to find the page's files, found ${[...refs].join(", ")}`);
  for (const ref of refs) {
    assert.ok(existsSync(fileURLToPath(new URL(`../ui${ref}`, import.meta.url))), `${ref} is referenced but not in harness/ui`);
    assert.ok(server.includes(`path === "${ref}"`), `${ref} is loaded by the window but ui.mjs does not serve it (add it to the UI file list)`);
  }
});
