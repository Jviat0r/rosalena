/**
 * The API token stays with the window (ui.mjs `pageKey`, desktop/main.mjs PAGE_KEY):
 *
 *   - with a page key, a plain local request (what a command the agent runs would send)
 *     gets every page with an empty token, and the write routes refuse it
 *   - the window's own load (the `x-rosalena-page` header) gets the token
 *   - "Open in browser": a one-time code works once, within a minute, and leaves an
 *     HttpOnly cookie that later pages accept
 *   - without a page key (`rosalena --ui` in a browser) pages carry the token as before
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUiServer } from "../src/ui.mjs";

const TOKEN = "t".repeat(32);
const KEY = "k".repeat(48);
const PAGES = ["/", "/models", "/plugins", "/usage", "/network", "/exits", "/remote"];
const tokenIn = (html) => /name="rosalena-token" content="([^"]*)"/.exec(html)?.[1] ?? null;

async function server(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "page-key-"));
  const ui = createUiServer({ port: 0, home, workspace: home, token: TOKEN, ...options });
  const { port } = await ui.ready();
  return { ui, base: `http://127.0.0.1:${port}` };
}

test("with a page key, a plain request gets no token and cannot write", async () => {
  const { ui, base } = await server({ pageKey: KEY });
  try {
    for (const page of PAGES) {
      const html = await (await fetch(base + page)).text();
      assert.ok(!html.includes(TOKEN), `${page} must not carry the token`);
    }
    // What a stolen token would have been used for: the access mode and approval cards.
    const put = await fetch(`${base}/api/prefs`, { method: "PUT", headers: { "content-type": "application/json", "x-rosalena-token": "" }, body: '{"accessMode":"full"}' });
    assert.equal(put.status, 403);
    const own = await (await fetch(`${base}/`, { headers: { "x-rosalena-page": KEY } })).text();
    assert.equal(tokenIn(own), TOKEN, "the window's own load carries it");
    const wrong = await (await fetch(`${base}/`, { headers: { "x-rosalena-page": "k".repeat(47) + "x" } })).text();
    assert.equal(tokenIn(wrong), "");
  } finally {
    await ui.close();
  }
});

test("a browser code works once and leaves a cookie later pages accept", async () => {
  const { ui, base } = await server({ pageKey: KEY });
  try {
    const code = ui.issuePageCode();
    const first = await fetch(`${base}/?code=${code}`);
    assert.equal(tokenIn(await first.text()), TOKEN);
    const cookie = first.headers.get("set-cookie");
    assert.match(cookie, /^rosalena_page=k+; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.equal(tokenIn(await (await fetch(`${base}/?code=${code}`)).text()), "", "a code is spent by its first use");
    assert.equal(tokenIn(await (await fetch(`${base}/?code=made-up`)).text()), "");
    const models = await (await fetch(`${base}/models`, { headers: { cookie: cookie.split(";")[0] } })).text();
    assert.ok(models.includes(TOKEN), "the cookie carries the browser to the other pages");
  } finally {
    await ui.close();
  }
});

test("without a page key the pages carry the token as before", async () => {
  const { ui, base } = await server();
  try {
    assert.equal(tokenIn(await (await fetch(`${base}/`)).text()), TOKEN);
    assert.equal(ui.issuePageCode(), null);
  } finally {
    await ui.close();
  }
});
