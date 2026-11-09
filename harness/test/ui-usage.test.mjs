/**
 * The tokens & cost page, and the relay it reads.
 *
 * The page is served by the UI server but the numbers live in the router's ledger, which
 * sits behind the router's own token. So the contract worth testing is the seam:
 *
 *   - `/usage` is served with the page token substituted, like `/network`
 *   - `/api/usage` relays the window and adds the provider prices the cost column needs
 *   - a router that answers badly or not at all is a 502 that names the reason, never a
 *     zero that would read as "you spent nothing"
 *
 * Every upstream here is a stub on port 0: no real router, no real spend, no network.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-usage-"));
const TOKEN = "usage-test-token-0123456789";

/** A router that answers the two admin routes and remembers what it was asked. */
function stubRouter({ usageStatus = 200, statusUp = true } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push({ path: url.pathname, query: url.search, auth: req.headers.authorization ?? null });
    if (url.pathname === "/admin/usage") {
      if (usageStatus !== 200) {
        res.writeHead(usageStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "ledger unavailable" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          window: { days: Number(url.searchParams.get("days") ?? 1), from: "2026-10-20T00:00:00.000Z", to: "2026-10-20T06:00:00.000Z" },
          updatedAt: "2026-10-20T06:00:00.000Z",
          totals: { tokens: 900, input: 700, output: 200, cacheRead: null, cacheWrite: null, calls: 3 },
          providers: [
            {
              provider: "local",
              label: "Local (this PC)",
              tokens: 900,
              calls: 3,
              input: 700,
              output: 200,
              cacheRead: null,
              cacheWrite: null,
              models: [{ model: "qwen3.8-27b", tokens: 900, calls: 3, input: 700, output: 200, cacheRead: null, cacheWrite: null }],
            },
          ],
          current: { provider: "local", model: "qwen3.8-27b" },
        }),
      );
    }
    if (url.pathname === "/admin/status" && statusUp) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          status: "ok",
          providers: {
            local: { kind: "openai", prices: { in: 0, out: 0 } },
            openai: { kind: "openai", prices: { in: 2.5, out: 10 } },
          },
        }),
      );
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no route" }));
  });
  return { server, seen };
}

let ui;
let base;
let stub;
let stubStatus;

before(async () => {
  stub = stubRouter();
  await new Promise((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const stubPort = stub.server.address().port;

  // The relay strips a `/v1` suffix from the base, so give it exactly the shape the real
  // config uses: a router URL with a version segment on the end.
  ui = createUiServer({
    port: 0,
    home: join(WS, "home"),
    workspace: WS,
    routerUrl: `http://127.0.0.1:${stubPort}/v1`,
    token: TOKEN,
  });
  const state = await ui.ready();
  base = `http://127.0.0.1:${state.port}`;
});

after(async () => {
  await ui?.close();
  await new Promise((resolve) => stub?.server.close(resolve));
});

test("/usage is served with the token substituted, like /network", async () => {
  const res = await fetch(`${base}/usage`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.ok(html.includes(TOKEN), "the account token must reach the page");
  assert.equal(html.includes("__ROSALENA_TOKEN__"), false, "placeholder left in the page");
  assert.ok(html.includes("/api/usage"), "the page must read the relay, not the router");
  assert.ok(html.length > 8000, `page looks truncated: ${html.length} bytes`);
});

test("/api/usage relays the ledger and adds the prices the cost column needs", async () => {
  const res = await fetch(`${base}/api/usage?days=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.totals.tokens, 900);
  assert.equal(body.providers[0].models[0].model, "qwen3.8-27b");
  assert.equal(body.current.model, "qwen3.8-27b");
  // Prices come from the router's own config, so the page never hardcodes what a token
  // costs. A provider with no price is null, not zero.
  assert.deepEqual(body.prices.local, { in: 0, out: 0 });
  assert.deepEqual(body.prices.openai, { in: 2.5, out: 10 });
});

test("/api/usage passes the window through and nothing else", async () => {
  stub.seen.length = 0;
  const res = await fetch(`${base}/api/usage?days=30`);
  assert.equal(res.status, 200);
  const usage = stub.seen.find((s) => s.path === "/admin/usage");
  assert.equal(usage.query, "?days=30", "the window must reach the router");
  assert.equal((await res.json()).window.days, 30);
});

test("/api/usage clamps an unknown window to one day rather than forwarding it", async () => {
  stub.seen.length = 0;
  await fetch(`${base}/api/usage?days=3650`);
  const usage = stub.seen.find((s) => s.path === "/admin/usage");
  assert.equal(usage.query, "?days=1");
});

test("/api/usage is a 502 that names the router's status when the ledger is refused", async () => {
  const bad = stubRouter({ usageStatus: 403 });
  await new Promise((resolve) => bad.server.listen(0, "127.0.0.1", resolve));
  const port = bad.server.address().port;
  const ui2 = createUiServer({ port: 0, home: join(WS, "h2"), workspace: WS, routerUrl: `http://127.0.0.1:${port}/v1`, token: TOKEN });
  const state = await ui2.ready();
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/usage`);
    assert.equal(res.status, 502, "a refused ledger is the relay's failure, not an empty window");
    const body = await res.json();
    assert.match(body.error, /HTTP 403/);
  } finally {
    await ui2.close();
    await new Promise((resolve) => bad.server.close(resolve));
  }
});

test("/api/usage is a 502 when the router is not listening at all", async () => {
  // Port 1 is refused on this machine the same way a stopped router is.
  ui?.close();
  const ui3 = createUiServer({ port: 0, home: join(WS, "h3"), workspace: WS, routerUrl: "http://127.0.0.1:1/v1", token: TOKEN });
  const state = await ui3.ready();
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/api/usage`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /unreachable/);
  } finally {
    await ui3.close();
  }
});
