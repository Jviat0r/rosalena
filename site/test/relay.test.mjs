/**
 * The phone-access relay Worker (site/relay/worker.mjs), run in Node: an in-memory twin of
 * its D1 store and a stub "tunnel" in place of fetch. What matters is what it refuses:
 * an unregistered or foreign target, a registration without the id's secret, cookies that
 * are not the app's, a Set-Cookie aimed at the whole domain - and that a streamed answer
 * reaches the phone chunk by chunk.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanTarget, handle, hostOnlyCookie } from "../relay/worker.mjs";

const ID = "abcdefghijklmnopqrstuvwx";
const SECRET = "S".repeat(43);
const OTHER = "T".repeat(43);
const TARGET = "https://selective-tony-locking-hull.trycloudflare.com/";
const ENV = { RELAY_SUFFIX: ".rosalena.dev", API_HOST: "relay.rosalena.dev" };

function memoryStore() {
  const rows = new Map();
  const limits = new Map();
  return {
    rows,
    async get(id) {
      return rows.get(id) ?? null;
    },
    async insert({ id, secretHash, target, at }) {
      rows.set(id, { id, secret_hash: secretHash, target, updated_at: at });
    },
    async setTarget(id, target, at) {
      rows.set(id, { ...rows.get(id), target, updated_at: at });
    },
    async bump(key, window) {
      const cur = limits.get(key);
      const next = cur && cur.window === window ? { window, count: cur.count + 1 } : { window, count: 1 };
      limits.set(key, next);
      return next.count;
    },
  };
}

function api(path, body, ip = "203.0.113.5") {
  return new Request(`https://relay.rosalena.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });
}

async function registered(fetchImpl) {
  const store = memoryStore();
  const deps = { store, fetchImpl, now: () => 1_800_000_000_000 };
  const res = await handle(api("/api/register", { id: ID, secret: SECRET, target: TARGET }), ENV, deps);
  assert.equal(res.status, 200);
  return { store, deps };
}

test("relay: the first registration claims an id; only its secret can move it", async () => {
  const store = memoryStore();
  const deps = { store, fetchImpl: async () => new Response("x"), now: () => 1_800_000_000_000 };
  const first = await handle(api("/api/register", { id: ID, secret: SECRET, target: TARGET }), ENV, deps);
  assert.deepEqual(await first.json(), { ok: true, url: `https://${ID}.rosalena.dev/` });
  assert.equal(store.rows.get(ID).target, TARGET.slice(0, -1));
  assert.notEqual(store.rows.get(ID).secret_hash, SECRET, "only a hash is stored");

  const stolen = await handle(api("/api/register", { id: ID, secret: OTHER, target: "https://evil-thing.trycloudflare.com/" }), ENV, deps);
  assert.equal(stolen.status, 403);
  assert.equal(store.rows.get(ID).target, TARGET.slice(0, -1));

  const moved = await handle(api("/api/register", { id: ID, secret: SECRET, target: "https://next-one-here.trycloudflare.com" }), ENV, deps);
  assert.equal(moved.status, 200);
  assert.equal(store.rows.get(ID).target, "https://next-one-here.trycloudflare.com");

  // Unregister empties the row but keeps the claim: nobody else can take the id over.
  assert.equal((await handle(api("/api/unregister", { id: ID, secret: SECRET }), ENV, deps)).status, 200);
  assert.equal(store.rows.get(ID).target, null);
  assert.equal((await handle(api("/api/register", { id: ID, secret: OTHER, target: TARGET }), ENV, deps)).status, 403);
});

test("relay: only a quick-tunnel origin can be a target, so it is never an open proxy", async () => {
  for (const bad of [
    "https://example.com/",
    "http://x.trycloudflare.com/",
    "https://x.trycloudflare.com/path",
    "https://x.trycloudflare.com.evil.com/",
    "https://api.trycloudflare.com/",
    "https://a.b.trycloudflare.com/",
    "https://user@x.trycloudflare.com/",
  ]) {
    assert.equal(cleanTarget(bad), null, bad);
  }
  assert.equal(cleanTarget("https://Fine-Name.trycloudflare.com/"), "https://fine-name.trycloudflare.com");
  const deps = { store: memoryStore(), fetchImpl: async () => new Response(""), now: () => 0 };
  assert.equal((await handle(api("/api/register", { id: ID, secret: SECRET, target: "https://example.com/" }), ENV, deps)).status, 400);
  assert.equal((await handle(api("/api/register", { id: "short", secret: SECRET, target: TARGET }), ENV, deps)).status, 400);
  assert.equal((await handle(api("/api/register", { id: ID, secret: "weak", target: TARGET }), ENV, deps)).status, 400);
});

test("relay: claiming new ids is rate limited per address", async () => {
  const deps = { store: memoryStore(), fetchImpl: async () => new Response(""), now: () => 1_800_000_000_000 };
  const ids = Array.from({ length: 11 }, (_, i) => `${"a".repeat(22)}${"bcdefghijklm"[i]}b`);
  const codes = [];
  for (const id of ids) codes.push((await handle(api("/api/register", { id, secret: SECRET, target: TARGET }), ENV, deps)).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
  assert.equal(codes[10], 429);
});

test("relay: a phone request goes to the registered tunnel only, with its path, and nothing else", async () => {
  const seen = [];
  const { deps } = await registered(async (url, init) => {
    seen.push({ url, init });
    return new Response("hello", { status: 200, headers: { "content-type": "text/plain", "x-rosalena-app": "1" } });
  });
  const res = await handle(
    new Request(`https://${ID}.rosalena.dev/api/sessions?x=1`, {
      headers: {
        cookie: "__Host-rosalena_device=abc.def; _ga=tracker; trial=xyz",
        "cf-connecting-ip": "198.51.100.4",
        "x-forwarded-host": "spoofed.example",
        "x-rosalena-client-ip": "1.1.1.1",
      },
    }),
    ENV,
    deps,
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hello");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://selective-tony-locking-hull.trycloudflare.com/api/sessions?x=1");
  const h = seen[0].init.headers;
  assert.equal(h.get("cookie"), "__Host-rosalena_device=abc.def", "only the app's own cookie is passed on");
  assert.equal(h.get("x-forwarded-host"), `${ID}.rosalena.dev`, "the client cannot choose these");
  assert.equal(h.get("x-rosalena-client-ip"), "198.51.100.4");
  assert.equal(seen[0].init.redirect, "manual");

  // An absolute URL in the path cannot change the destination host.
  await handle(new Request(`https://${ID}.rosalena.dev//evil.example.com/x`), ENV, deps);
  assert.equal(new URL(seen[1].url).host, "selective-tony-locking-hull.trycloudflare.com");
});

test("relay: Set-Cookie loses any Domain=, and a redirect to the tunnel host becomes relative", async () => {
  assert.equal(hostOnlyCookie("a=1; Path=/; Domain=rosalena.dev; HttpOnly"), "a=1; Path=/; HttpOnly");
  const { deps } = await registered(async () => {
    const headers = new Headers({ location: "https://selective-tony-locking-hull.trycloudflare.com/next?q=1" });
    headers.append("set-cookie", "__Host-rosalena_device=v; Path=/; Secure; HttpOnly");
    headers.append("set-cookie", "evil=1; Domain=.rosalena.dev; Path=/");
    return new Response(null, { status: 302, headers });
  });
  const res = await handle(new Request(`https://${ID}.rosalena.dev/`), ENV, deps);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/next?q=1");
  const cookies = res.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.equal(cookies.some((c) => /domain=/i.test(c)), false);
});

test("relay: a dead tunnel, an empty row or an unknown id is the offline page, not an error", async () => {
  const { deps, store } = await registered(async () => new Response("<html>1033</html>", { status: 530 }));
  const page = await handle(new Request(`https://${ID}.rosalena.dev/`, { headers: { accept: "text/html" } }), ENV, deps);
  assert.equal(page.status, 503);
  assert.match(await page.text(), /The computer is not answering/);
  const apiCall = await handle(new Request(`https://${ID}.rosalena.dev/api/sessions`), ENV, deps);
  assert.equal((await apiCall.json()).error, "offline");

  deps.fetchImpl = async () => {
    throw new Error("connection refused");
  };
  assert.equal((await handle(new Request(`https://${ID}.rosalena.dev/`), ENV, deps)).status, 503);
  await store.setTarget(ID, null, 0);
  assert.equal((await handle(new Request(`https://${ID}.rosalena.dev/`), ENV, deps)).status, 503);
  assert.equal((await handle(new Request(`https://${"z".repeat(24)}.rosalena.dev/`), ENV, deps)).status, 503);

  // The app's own 502 (a model route failing) is passed through, not hidden as "offline".
  deps.fetchImpl = async () => new Response('{"error":"router down"}', { status: 502, headers: { "x-rosalena-app": "1" } });
  await store.setTarget(ID, "https://selective-tony-locking-hull.trycloudflare.com", 0);
  assert.equal((await handle(new Request(`https://${ID}.rosalena.dev/api/models`), ENV, deps)).status, 502);
});

test("relay: a streamed answer (SSE) reaches the phone before the stream ends", async () => {
  let push;
  const body = new ReadableStream({
    start(controller) {
      push = controller;
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
    },
  });
  const { deps } = await registered(async () => new Response(body, { headers: { "content-type": "text/event-stream", "x-rosalena-app": "1" } }));
  const res = await handle(new Request(`https://${ID}.rosalena.dev/api/stream?id=1`), ENV, deps);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "data: first\n\n", "the first frame arrives while the stream is still open");
  push.enqueue(new TextEncoder().encode("data: second\n\n"));
  push.close();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), "data: second\n\n");
});

test("relay: a WebSocket upgrade is handed to the tunnel as-is; other hosts are left alone", async () => {
  const seen = [];
  const { deps } = await registered(async (url, init) => {
    seen.push({ url, init });
    return new Response("switched");
  });
  await handle(new Request(`https://${ID}.rosalena.dev/ws`, { headers: { upgrade: "websocket" } }), ENV, deps);
  assert.equal(seen[0].init.headers.get("upgrade"), "websocket");

  const passed = [];
  const res = await handle(new Request("https://www.rosalena.dev/"), ENV, { ...deps, fetchImpl: async (req) => (passed.push(req.url), new Response("site")) });
  assert.equal(await res.text(), "site");
  assert.deepEqual(passed, ["https://www.rosalena.dev/"]);
  assert.equal((await handle(new Request("https://relay.rosalena.dev/api/health"), ENV, deps)).status, 200);
});
