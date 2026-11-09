/**
 * The Plugins page (/plugins and /api/plugins/manage).
 *
 *   - it lists both kinds: sidebar pages and agent tool plugins
 *   - a tool switch is saved in the app's home, never in harness.config.json, and changes
 *     what the agent loads
 *   - a tool plugin someone adds needs `trust`, loads from <home>/tool-plugins, can be
 *     removed (moved aside), and one that fails to load is taken back out
 *   - a sidebar page someone adds goes through the real verifier and is installed on a pass
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { templateFiles } from "../src/creator.mjs";
import { findElectron } from "../src/plugin-verify.mjs";
import { createUiServer } from "../src/ui.mjs";

const TOKEN = "manager-token-0123456789abcdef";
const needsElectron = findElectron() ? {} : { skip: "no Electron in desktop/node_modules" };
const CONFIG = new URL("../harness.config.json", import.meta.url);

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));
function folderOf(files) {
  const dir = temp("rosalena-addme-");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

async function start() {
  const ws = temp("harness-manager-");
  const home = join(ws, "home");
  const ui = createUiServer({ port: 0, home, workspace: ws, token: TOKEN });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  const list = async () => (await fetch(`${base}/api/plugins/manage`)).json();
  const post = async (body, token = TOKEN) => {
    const res = await fetch(`${base}/api/plugins/manage`, { method: "POST", headers: { "content-type": "application/json", "x-rosalena-token": token }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { home, base, list, post };
}

test("the page and both lists are served, and changes need the token", async () => {
  const { base, list, post } = await start();
  const html = await (await fetch(`${base}/plugins`)).text();
  assert.match(html, /<h1>Plugins<\/h1>/);
  assert.doesNotMatch(html, /__ROSALENA_TOKEN__/);
  const data = await list();
  assert.ok(data.pages.some((p) => p.id === "rosa-transformer-3d" && p.source === "bundled"));
  assert.ok(data.tools.some((t) => t.id === "rosa-comfyui" && t.source === "bundled"));
  assert.equal((await post({ action: "tool-off", id: "rosa-comfyui" }, "nope")).status, 403);
});

test("a tool switch is saved in the app's home and changes what loads", async () => {
  const configBefore = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : null;
  const { home, list, post } = await start();
  assert.equal((await post({ action: "tool-off", id: "rosa-comfyui" })).body.ok, true);
  let comfy = (await list()).tools.find((t) => t.id === "rosa-comfyui");
  assert.equal(comfy.enabled, false);
  assert.equal(comfy.loaded, false);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "plugin-switches.json"), "utf8")).tools, { "rosa-comfyui": false });
  assert.equal(existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : null, configBefore, "harness.config.json is never written");
  await post({ action: "tool-on", id: "rosa-comfyui" });
  comfy = (await list()).tools.find((t) => t.id === "rosa-comfyui");
  assert.equal(comfy.enabled, true);
  assert.ok(comfy.tools.length > 0, "switched back on, its tools load again");
  assert.equal((await post({ action: "tool-off", id: "no-such-plugin" })).status, 404);

  // Pages switch through Creator's switches.
  assert.equal((await post({ action: "page-off", id: "rosa-fuyu" })).body.ok, true);
  assert.equal((await list()).pages.find((p) => p.id === "rosa-fuyu").enabled, false);
  await post({ action: "page-on", id: "rosa-fuyu" });
  assert.equal((await list()).pages.find((p) => p.id === "rosa-fuyu").enabled, true);
});

test("a tool plugin someone adds needs trust, loads, and can be removed", async () => {
  const { home, list, post } = await start();
  const folder = folderOf({
    "plugin.json": JSON.stringify({ id: "hello-tool", version: "1.0.0", description: "says hello" }),
    "plugin.mjs": `export default { tools: [{ name: "say_hello", description: "hi", run: async () => "hello" }] };`,
  });
  const asked = await post({ action: "import", folder });
  assert.equal(asked.body.ok, false);
  assert.equal(asked.body.needsTrust, true);
  assert.equal(existsSync(join(home, "tool-plugins", "hello-tool")), false, "nothing is copied before the person says yes");

  const added = await post({ action: "import", folder, trust: true });
  assert.equal(added.body.ok, true, added.body.error);
  assert.deepEqual(added.body.tools, ["say_hello"]);
  const row = (await list()).tools.find((t) => t.id === "hello-tool");
  assert.equal(row.source, "user");
  assert.deepEqual(row.tools, ["say_hello"]);

  const removed = await post({ action: "tool-remove", id: "hello-tool" });
  assert.equal(removed.body.ok, true);
  assert.equal((await list()).tools.some((t) => t.id === "hello-tool"), false);
  assert.ok(existsSync(join(removed.body.keptIn, "plugin.json")), "removal moves the folder aside, it does not delete it");
  assert.equal((await post({ action: "tool-remove", id: "rosa-comfyui" })).status, 404, "a plugin that ships with the app cannot be removed");
});

test("a tool plugin that fails to load is taken back out, and shipped ids are refused", async () => {
  const { home, post } = await start();
  const broken = folderOf({
    "plugin.json": JSON.stringify({ id: "broken-tool" }),
    "plugin.mjs": `throw new Error("boom on import");`,
  });
  const out = await post({ action: "import", folder: broken, trust: true });
  assert.equal(out.body.ok, false);
  assert.match(out.body.error, /boom on import/);
  assert.equal(existsSync(join(home, "tool-plugins", "broken-tool")), false);

  const clash = folderOf({ "plugin.json": JSON.stringify({ id: "rosa-comfyui" }), "plugin.mjs": "export default {};" });
  assert.match((await post({ action: "import", folder: clash, trust: true })).body.error, /ships with the app/);
  assert.match((await post({ action: "import", folder: temp("rosalena-empty-") })).body.error, /no plugin\.json/);
});

test("a sidebar page someone adds is verified and then installed", needsElectron, async () => {
  const { home, list, post } = await start();
  const folder = folderOf(templateFiles({ id: "my-notes", title: "My Notes", description: "added from a folder" }));
  const out = await post({ action: "import", folder });
  assert.equal(out.body.ok, true, `${out.body.error}\n${out.body.report}`);
  assert.equal(out.body.kind, "page");
  assert.match(out.body.report, /PASS/);
  const page = (await list()).pages.find((p) => p.id === "my-notes");
  assert.equal(page.source, "user");
  assert.equal(page.enabled, true);

  // A page that fails the verifier stays a draft and is not installed.
  const bad = folderOf({
    ...templateFiles({ id: "bad-page", title: "Bad Page" }),
    "app/app.js": `Rosalena.test("fails", () => { throw new Error("nope"); }); Rosalena.ready();`,
  });
  const refused = await post({ action: "import", folder: bad });
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.error, /did not pass verification/);
  assert.equal((await list()).pages.some((p) => p.id === "bad-page"), false);
  assert.ok(readdirSync(join(home, "creator", "drafts")).includes("bad-page"), "the failed import is kept as a draft to fix");
});
