/**
 * What this machine can actually run.
 *
 * `/api/recommend` is the only route that shells out during a page load - nvidia-smi and a
 * CIM query, one to two seconds - so the behaviour worth pinning is not just the shape of
 * the JSON: it is that the probe is cached, that a `?fresh=1` really re-measures, and that
 * every catalog entry lands in exactly one bucket. A model that appeared twice, or that
 * appeared in none, would make the page's "6 of these 10 models" sentence a lie.
 *
 * The arithmetic itself belongs to `recommend()` and is tested with the catalog; this file
 * tests the projection and the caching around it.
 *
 *   node --import ./test/isolate.mjs --test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";
import { loadCatalog } from "../src/catalog.mjs";

const HOME = mkdtempSync(join(tmpdir(), "harness-recommend-home-"));
const ROOT = mkdtempSync(join(tmpdir(), "harness-recommend-ws-"));
const TOKEN = "recommend-test-token-0123456789";

let ui;
let base;

before(async () => {
  ui = createUiServer({ port: 0, home: HOME, workspace: ROOT, routerUrl: "http://127.0.0.1:1/v1", token: TOKEN });
  const state = await ui.ready();
  base = `http://127.0.0.1:${state.port}`;
});

after(async () => {
  await ui?.close();
});

const catalogSize = () => loadCatalog().models.length;

test("/api/recommend answers with this machine's numbers and every catalog model", async () => {
  const res = await fetch(`${base}/api/recommend?fresh=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.hardware, "a 200 has to carry hardware");
  assert.ok(body.hardware.cpu, "the CPU is always readable through os.cpus()");
  assert.ok(body.hardware.ram, "total memory is always readable");
  assert.equal(typeof body.tookMs, "number");
  assert.equal(body.catalog.models, catalogSize());

  const rows = Object.values(body.rows).flat();
  assert.equal(rows.length, catalogSize(), "one row per catalog entry, no duplicates");
  const ids = new Set(rows.map((row) => row.id));
  assert.equal(ids.size, catalogSize(), "every id appears exactly once");
});

test("each row carries the sentence and the numbers a page needs to draw it", async () => {
  const body = await (await fetch(`${base}/api/recommend`)).json();
  for (const row of Object.values(body.rows).flat()) {
    assert.equal(typeof row.name, "string");
    assert.ok(row.name.length > 0, `${row.id} has a name`);
    assert.equal(typeof row.needBytes, "number");
    assert.ok(row.needBytes > 0, `${row.id} needs a positive number of bytes`);
    assert.equal(typeof row.reason, "string");
    assert.ok(row.reason.length > 20, `${row.id} explains its verdict: ${row.reason}`);
    assert.ok(Array.isArray(row.quants) && row.quants.length > 0, `${row.id} lists its quants`);
    assert.ok(["fits", "tight", "tooBig", "unknown"].includes(row.verdict), `${row.id}: ${row.verdict}`);
    // The hostname is dropped on purpose: this payload may end up in a shared screenshot.
    assert.equal(Object.hasOwn(body.hardware, "hostname"), false);
  }
});

test("a bucket and a verdict never contradict each other", async () => {
  const body = await (await fetch(`${base}/api/recommend`)).json();
  const expected = { fits: "fits", tight: "tight", tooBig: "tooBig", unknown: "unknown" };
  for (const [bucket, verdict] of Object.entries(expected)) {
    for (const row of body.rows[bucket]) {
      assert.equal(row.verdict, verdict, `${row.id} is in ${bucket} but says ${row.verdict}`);
    }
  }
  assert.deepEqual(
    body.counts,
    {
      fits: body.rows.fits.length,
      tight: body.rows.tight.length,
      tooBig: body.rows.tooBig.length,
      unknown: body.rows.unknown.length,
    },
    "the counts are the buckets, counted",
  );
});

test("the probe is cached, and ?fresh=1 is the way out of the cache", async () => {
  await fetch(`${base}/api/recommend?fresh=1`);
  const first = await (await fetch(`${base}/api/recommend`)).json();
  assert.equal(first.cached, true, "a second read within the TTL reuses the probe");
  assert.ok(first.tookMs < 200, `a cached answer is fast, took ${first.tookMs} ms`);
  const second = await (await fetch(`${base}/api/recommend?fresh=1`)).json();
  assert.equal(second.cached, false, "?fresh=1 must re-measure");
});

test("the models page is served, token substituted, and named for the question it answers", async () => {
  const res = await fetch(`${base}/models`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.match(html, /<h1>Models for this PC<\/h1>/);
  // Chat, image, video and voice, each downloadable after a question.
  assert.match(html, /key: "image"/);
  assert.match(html, /\/api\/models\/download/);
  assert.match(html, /<dialog id="confirm"/);
  assert.equal(html.includes("__ROSALENA_TOKEN__"), false, "the placeholder is always replaced");
  assert.ok(html.includes(TOKEN), "the page carries the token it needs for its own writes");
  assert.match(html, /\/api\/recommend/);
});

test("reading the recommendation needs no token: measuring is not a write", async () => {
  const res = await fetch(`${base}/api/recommend`);
  assert.equal(res.status, 200);
});
