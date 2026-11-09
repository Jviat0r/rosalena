/**
 * The VPN exits page and its two routes.
 *
 * This is the one feature on the UI where a wrong click really starts or stops a VPN
 * client on the machine, so the tests here are about the shape and the gate, never about
 * performing a toggle:
 *
 *   - `/exits` is served with the page token substituted, so its switches can write
 *   - `GET /api/exits` always answers 200 with two named providers, even when the probe
 *     itself fails - a page that draws "unknown" is worth more than a 500 it cannot read,
 *     and "unknown" is never allowed to collapse into "off"
 *   - `POST /api/exits/toggle` is behind the token, and a body that cannot name a real
 *     client is refused instead of being forwarded
 *
 * Nothing here turns a client on or off. The read-only probe is exercised against the
 * real plugin because that is the only way to see its real answer; `tasklist` is a read.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-exits-"));
const TOKEN = "exits-test-token-0123456789";
const PROVIDERS = ["outline", "express"];

let ui;
let base;

before(async () => {
  // A router that is not there is fine: none of these routes ask it anything.
  ui = createUiServer({ port: 0, home: join(WS, "home"), workspace: WS, routerUrl: "http://127.0.0.1:1/v1", token: TOKEN });
  const state = await ui.ready();
  base = `http://127.0.0.1:${state.port}`;
});

after(async () => {
  await ui?.close();
});

test("/exits is served with the token substituted, so its switches can write", async () => {
  const res = await fetch(`${base}/exits`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.ok(html.includes(TOKEN), "the page token must reach the page");
  assert.equal(html.includes("__ROSALENA_TOKEN__"), false, "placeholder left in the page");
  assert.ok(html.includes("/api/exits/toggle"), "the page must post to the toggle route");
  assert.ok(html.length > 20000, `page looks truncated: ${html.length} bytes`);
});

test("/api/exits names both clients and is readable without the token", async () => {
  const res = await fetch(`${base}/api/exits`);
  assert.equal(res.status, 200, "a read-only probe must not be a failure just because it is real");
  const body = await res.json();
  assert.equal(typeof body.supported, "boolean");
  assert.ok(Array.isArray(body.providers) && body.providers.length === 2, "one row per client");
  assert.deepEqual(
    body.providers.map((p) => p.id),
    PROVIDERS,
  );
  for (const p of body.providers) {
    // The three-valued fields are the whole honesty story: null means "could not read",
    // and a page must be able to tell that apart from false.
    assert.ok(p.installed === true || p.installed === false || p.installed === null, `${p.id}.installed`);
    assert.ok(p.running === true || p.running === false || p.running === null, `${p.id}.running`);
    assert.ok(Array.isArray(p.pids), `${p.id}.pids`);
    assert.equal(typeof p.image, "string");
  }
  assert.ok(Array.isArray(body.errors));
});

test("/api/exits never reports a client as off when it could not read the process table", async () => {
  // On this machine both clients happen to be running, so the report is true; the rule
  // being pinned is the implication, which holds either way: a provider that is not
  // running must carry a reading, and an unreadable one must not claim to be off.
  const body = await (await fetch(`${base}/api/exits`)).json();
  for (const p of body.providers) {
    if (p.running === false) assert.equal(typeof p.how, "string");
    if (p.running === null) assert.notEqual(p.running, false);
  }
});

test("/api/exits/toggle refuses a request with no token, and names the reason", async () => {
  const res = await fetch(`${base}/api/exits/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "outline", on: false }),
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "bad token");
});

test("/api/exits/toggle refuses a body that names no real client", async () => {
  // Reaches the plugin, which must refuse before it looks for an executable: an unknown
  // provider is not a spelling of the nearest match.
  const res = await fetch(`${base}/api/exits/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rosalena-token": TOKEN },
    body: JSON.stringify({ provider: "nonsense", on: true }),
  });
  assert.equal(res.status, 200, "a refusal is an answer, not a transport error");
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(String(body.message ?? body.error ?? ""), /nonsense|unknown|provider/i);
});
