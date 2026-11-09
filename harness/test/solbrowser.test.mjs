/**
 * SolBrowser inside Rosalena (plugins/rosa-solbrowser, src/vendor/solbrowser-fastread.mjs):
 *
 *   - the vendored copy is one bundled server file plus the extension, pinned to a commit
 *   - the plugin offers a curated, prefixed tool set from the captured schemas; evaluate is
 *     never offered; reading tools run in workspace mode, acting ones ask
 *   - Set up copies the extension to a stable folder under ROSALENA_HOME
 *   - a real call goes through the bundled server (throwaway port and state dir, never
 *     8765 / ~/.solbrowser) and, with no extension paired, says how to set it up
 *   - web_fetch flags a sign-in wall and a client-rendered shell instead of passing them off
 *     as the page
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { ACT, LOOK, NOT_CONNECTED, SERVER, VENDOR, call, close, extensionHome, prepareExtension, source } from "../plugins/rosa-solbrowser/plugin.mjs";
import { decide } from "../src/permissions.mjs";
import { createTools } from "../src/tools.mjs";

test("the vendored SolBrowser is one bundled server, its extension and a pinned commit", () => {
  assert.ok(existsSync(SERVER), "bundle/server.mjs");
  assert.ok(existsSync(join(VENDOR, "extension", "manifest.json")));
  assert.ok(!existsSync(join(VENDOR, "node_modules")), "no node_modules: dependencies are inlined");
  const src = source();
  assert.match(src.commit, /^[0-9a-f]{40}$/);
  assert.equal(src.repo, "Jviat0r/SolBrowserMCP");
});

test("a curated, prefixed tool set; evaluate is never offered; reads run, actions ask", async () => {
  await plugin.setup({ config: {} });
  const tools = plugin.tools({ config: {} });
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, [...LOOK, ...ACT].map((n) => `sol_${n}`));
  assert.ok(!names.some((n) => /evaluate/.test(n)));
  for (const t of tools) assert.equal(typeof t.parameters, "object");
  assert.match(tools.find((t) => t.name === "sol_read_url").description, /YOUR OWN browser/);
  assert.equal(decide({ call: { name: "sol_read_url", arguments: JSON.stringify({ url: "https://x.test" }) }, mode: "workspace", root: tmpdir() }).action, "allow");
  assert.equal(decide({ call: { name: "sol_click", arguments: JSON.stringify({ ref: "e1" }) }, mode: "workspace", root: tmpdir() }).action, "ask");
});

test("Set up copies the extension to a stable folder and gives the steps", () => {
  const home = mkdtempSync(join(tmpdir(), "sb-home-"));
  const out = prepareExtension({ home });
  assert.equal(out.folder, extensionHome(home));
  assert.ok(existsSync(join(out.folder, "manifest.json")));
  assert.equal(JSON.parse(readFileSync(join(out.folder, "manifest.json"), "utf8")).manifest_version, 3);
  assert.match(out.steps.join(" "), /Load unpacked/);
});

test("a real call goes through the bundled server and explains a missing extension", { timeout: 60_000 }, async () => {
  await plugin.setup({ config: { port: 18791, stateDir: mkdtempSync(join(tmpdir(), "sb-state-")), launchBrowser: false } });
  plugin.tools({ config: { port: 18791, stateDir: mkdtempSync(join(tmpdir(), "sb-state-")), launchBrowser: false } });
  try {
    const status = await call("status", {});
    assert.match(status, /extension|connected/i);
    const snap = await call("snapshot", {});
    assert.match(snap, /Settings > Your browser > Set up/);
    // First, so it is inside the 300-character preview the window reads to offer Set up.
    assert.ok(snap.startsWith(NOT_CONNECTED), snap.slice(0, 120));
  } finally {
    close();
  }
});

test("web_fetch flags a sign-in wall and a client-rendered shell", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/private") {
      res.writeHead(302, { location: "/login?next=/private" });
      res.end();
      return;
    }
    if (req.url.startsWith("/login")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><body><form><input type="email"><input type="password"><button>Sign in</button></form></body></html>');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<html><head><title>App</title><script src="/a.js"></script></head><body><div id="root"></div></body></html>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tools = createTools({ root: tmpdir() });
    const wall = await tools.byName.web_fetch.run({ url: `${base}/private` });
    assert.match(wall, /not the whole page: redirected to a sign-in page/);
    assert.match(wall, /sol_read_url/);
    const shell = await tools.byName.web_fetch.run({ url: `${base}/app` });
    assert.match(shell, /needs a browser that runs JavaScript/);
  } finally {
    server.close();
  }
});
