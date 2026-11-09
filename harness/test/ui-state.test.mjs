/**
 * The window's look survives a relaunch (src/ui-state.mjs, ui/persist.js):
 *
 *   - only the app's own keys (`rosalena-…`, `rosalena.…`) are kept, as text, under a cap
 *   - a batch sets and removes keys; a bad key refuses the whole batch
 *   - the saved copy rides inside index.html, escaped so no value can end the script
 *   - through the real server: a change saved from one launch is in the page the next
 *     launch serves, on a different port, and a write needs the token
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUiServer } from "../src/ui.mjs";
import { injectUiState, readUiState, writeUiState } from "../src/ui-state.mjs";

const home = () => mkdtempSync(join(tmpdir(), "ui-state-"));

test("only the window's own keys are kept, and a batch sets and removes", () => {
  const dir = home();
  assert.deepEqual(readUiState(dir), { items: {}, at: null });
  writeUiState(dir, { set: { "rosalena-ui-styles-v1": '{"v":1,"active":"minimal"}', "rosalena.pluginTheme": '{"by":"rosa-style-lab"}', "rosalena-theme": "dark" } });
  writeUiState(dir, { remove: ["rosalena-theme"], set: { "rosalena-layout-v1": "{}" } });
  assert.deepEqual(Object.keys(readUiState(dir).items).sort(), ["rosalena-layout-v1", "rosalena-ui-styles-v1", "rosalena.pluginTheme"]);
  assert.throws(() => writeUiState(dir, { set: { "someone-else": "x" } }), /not a key the window saves/);
  assert.throws(() => writeUiState(dir, { set: { "rosalena-theme": 5 } }), /must be text/);
  assert.throws(() => writeUiState(dir, { set: { "rosalena-big": "x".repeat(9 * 1024 * 1024) } }), /over 8 MB/);
  assert.equal(readUiState(dir).items["rosalena-theme"], undefined, "a refused batch changed nothing");
});

test("the saved copy goes into the page, and no value can close the script", () => {
  const dir = home();
  writeUiState(dir, { set: { "rosalena-theme": "</script><script>alert(1)</script>" } });
  const html = injectUiState("<head><!--ROSALENA_UI_STATE--></head>", dir);
  assert.match(html, /<script id="rosalena-ui-state" type="application\/json">/);
  assert.doesNotMatch(html.replace('<script id="rosalena-ui-state" type="application/json">', "").replace(/<\/script><\/head>$/, ""), /<\/?script/i);
  const json = /type="application\/json">(.*)<\/script>/.exec(html)[1];
  assert.equal(JSON.parse(json).items["rosalena-theme"], "</script><script>alert(1)</script>");
});

test("a change saved in one launch is in the page the next launch serves, on a new port", async () => {
  const dir = home();
  const first = createUiServer({ port: 0, home: dir, workspace: dir, token: "t1" });
  const { port: p1 } = await first.ready();
  const refused = await fetch(`http://127.0.0.1:${p1}/api/ui-state`, { method: "POST", body: JSON.stringify({ set: { "rosalena-theme": "light" } }), headers: { "content-type": "application/json" } });
  assert.equal(refused.status, 403, "a write needs the token");
  const saved = await fetch(`http://127.0.0.1:${p1}/api/ui-state`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rosalena-token": "t1" },
    body: JSON.stringify({ set: { "rosalena-ui-styles-v1": '{"v":1,"active":"compact"}', "rosalena.pluginTheme": '{"by":"rosa-style-lab","tokens":{"accent":"#ff8800"}}' } }),
  });
  assert.equal(saved.status, 200);
  await first.close();

  const second = createUiServer({ port: 0, home: dir, workspace: dir, token: "t2" });
  const { port: p2 } = await second.ready();
  assert.notEqual(p2, p1);
  const html = await (await fetch(`http://127.0.0.1:${p2}/`)).text();
  const json = JSON.parse(/<script id="rosalena-ui-state" type="application\/json">(.*?)<\/script>/.exec(html)[1]);
  assert.equal(json.items["rosalena-ui-styles-v1"], '{"v":1,"active":"compact"}');
  assert.match(json.items["rosalena.pluginTheme"], /style-lab/);
  assert.ok(html.indexOf('id="rosalena-ui-state"') < html.indexOf('src="/persist.js"'), "the data comes before the script that applies it");
  assert.ok(html.indexOf('src="/persist.js"') < html.indexOf('src="/app.js"'), "and both before the app reads storage");
  assert.equal((await fetch(`http://127.0.0.1:${p2}/persist.js`)).status, 200);
  await second.close();
});
