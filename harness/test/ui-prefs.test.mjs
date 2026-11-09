/**
 * Saved window preferences: the context window and the sidebar's folds.
 *
 *   - the server default is 64K, and an explicit server option still sets the default
 *   - PUT /api/prefs needs the token, validates the window, and saves to ui-prefs.json
 *   - a chat started after a change is measured against the chosen window
 *   - folds merge key by key, and `false` removes a key
 *   - the page carries the controls and no longer has a Graph tab
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";
import { UI_DEFAULT_CONTEXT_WINDOW, cleanContextWindow, readPrefs, updatePrefs } from "../src/ui-prefs.mjs";

const TOKEN = "prefs-token-0123456789abcdef";

const router = createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* drain */
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 2 } }));
});
await new Promise((done) => router.listen(0, "127.0.0.1", done));
after(() => new Promise((done) => router.close(done)));
const ROUTER = `http://127.0.0.1:${router.address().port}/v1`;

async function start(options = {}) {
  const ws = mkdtempSync(join(tmpdir(), "harness-prefs-"));
  const home = join(ws, "home");
  const ui = createUiServer({ port: 0, home, workspace: ws, routerUrl: ROUTER, token: TOKEN, ...options });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  const send = (method, path, body, token = TOKEN) =>
    fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { "x-rosalena-token": token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { home, get: (path) => fetch(base + path), send };
}

test("the window helpers accept a sane range and nothing else", () => {
  assert.equal(UI_DEFAULT_CONTEXT_WINDOW, 65_536);
  assert.equal(cleanContextWindow(65536), 65536);
  assert.equal(cleanContextWindow("131072"), 131072);
  assert.equal(cleanContextWindow(100), null);
  assert.equal(cleanContextWindow("lots"), null);
  assert.throws(() => updatePrefs({ contextWindow: null, collapsed: {} }, { contextWindow: 10 }), /between/);
  const folded = updatePrefs({ contextWindow: null, collapsed: { a: true } }, { collapsed: { b: true, a: false } });
  assert.deepEqual(folded.collapsed, { b: true });
});

test("the default is 64K, saved changes need the token, and the file survives a reread", async () => {
  const { home, get, send } = await start();
  const first = await (await get("/api/prefs")).json();
  assert.equal(first.contextWindow, 65_536);
  assert.equal(first.contextWindowSaved, false);
  assert.ok(first.contextWindowChoices.includes(65_536));

  assert.equal((await send("PUT", "/api/prefs", { contextWindow: 16_384 }, "")).status, 403);
  assert.equal((await send("PUT", "/api/prefs", { contextWindow: 12 })).status, 400);

  const saved = await (await send("PUT", "/api/prefs", { contextWindow: 16_384, collapsed: { "folder:abc": true } })).json();
  assert.equal(saved.contextWindow, 16_384);
  assert.equal(saved.contextWindowSaved, true);
  assert.deepEqual(saved.collapsed, { "folder:abc": true });

  const file = join(home, "ui-prefs.json");
  assert.ok(existsSync(file));
  const reread = readPrefs(file);
  assert.equal(reread.contextWindow, 16_384);
  assert.equal(reread.maxSteps, null);
  assert.deepEqual(reread.collapsed, { "folder:abc": true });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).contextWindow, 16_384);

  // Clearing goes back to the server default.
  const cleared = await (await send("PUT", "/api/prefs", { contextWindow: null })).json();
  assert.equal(cleared.contextWindow, 65_536);
  assert.equal(cleared.contextWindowSaved, false);
});

test("a chat started after a change is measured against the chosen window", async () => {
  const { get, send } = await start({ contextWindow: 32_768 });
  assert.equal((await (await get("/api/prefs")).json()).contextWindow, 32_768, "an explicit server option is the default");
  await send("PUT", "/api/prefs", { contextWindow: 131_072 });
  const started = await (await send("POST", "/api/chat", { task: "ping" })).json();
  assert.ok(started.id, JSON.stringify(started));
  let meter = null;
  for (let i = 0; i < 100 && !meter?.window; i += 1) {
    await new Promise((done) => setTimeout(done, 50));
    meter = await (await get(`/api/context?id=${encodeURIComponent(started.id)}`)).json();
  }
  assert.equal(meter.window, 131_072);
});

test("steps per message default to 200, are validated, and reach the run", async () => {
  const { get, send } = await start();
  const first = await (await get("/api/prefs")).json();
  assert.equal(first.maxSteps, 200);
  assert.equal(first.maxStepsSaved, false);
  assert.equal((await send("PUT", "/api/prefs", { maxSteps: 0 })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { maxSteps: 5000 })).status, 400);
  const saved = await (await send("PUT", "/api/prefs", { maxSteps: 250 })).json();
  assert.equal(saved.maxSteps, 250);
  assert.equal(saved.maxStepsSaved, true);
});

test("a run started from the window gets the saved step limit", async () => {
  // A router that always asks for one more tool call, so only the step limit can end it.
  const looper = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    const message = { role: "assistant", content: "", tool_calls: [{ id: `c${Date.now()}${Math.random()}`, type: "function", function: { name: "list_dir", arguments: "{\"path\":\".\"}" } }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }));
  });
  await new Promise((done) => looper.listen(0, "127.0.0.1", done));
  after(() => new Promise((done) => looper.close(done)));
  const { get, send } = await start({ routerUrl: `http://127.0.0.1:${looper.address().port}/v1` });
  await send("PUT", "/api/prefs", { maxSteps: 3 });
  const started = await (await send("POST", "/api/chat", { task: "loop" })).json();
  let chat = null;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((done) => setTimeout(done, 50));
    chat = await (await get(`/api/chat?id=${encodeURIComponent(started.id)}`)).json();
    if (chat.status && chat.status !== "running") break;
  }
  const stop = (chat.events ?? []).find((e) => e.type === "stopped" && e.reason === "max_steps");
  assert.ok(stop, `expected a max_steps stop, got status ${chat.status}`);
  assert.equal(stop.maxSteps, 3);
});

test("the profile, appearance and window switches save, and nonsense is refused", async () => {
  const { home, get, send } = await start();
  const first = await (await get("/api/prefs")).json();
  assert.deepEqual(first.profile, { name: "", color: "cyan" });
  assert.equal(first.appearance.theme, "auto");
  assert.equal(first.show.statusbar, true);
  assert.ok(first.choices.accents.includes("violet"));

  const saved = await (
    await send("PUT", "/api/prefs", { profile: { name: "  Jayden  ", color: "rose" }, appearance: { theme: "light", accent: "green" }, show: { statusbar: false } })
  ).json();
  assert.deepEqual(saved.profile, { name: "Jayden", color: "rose" });
  assert.equal(saved.appearance.theme, "light");
  assert.equal(saved.appearance.accent, "green");
  assert.equal(saved.appearance.textSize, "normal", "untouched fields keep their value");
  assert.equal(saved.show.statusbar, false);
  assert.equal(saved.show.inspector, true);
  assert.equal(readPrefs(join(home, "ui-prefs.json")).profile.name, "Jayden");

  assert.equal((await send("PUT", "/api/prefs", { show: { everything: false } })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { appearance: { accent: "plaid" } })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { profile: { name: "x".repeat(41) } })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { profile: { name: "Someone" } }, "")).status, 403);
});

test("the palette defaults to petrol, saves a known one, and refuses an unknown one", async () => {
  const { get, send } = await start();
  const first = await (await get("/api/prefs")).json();
  assert.equal(first.appearance.palette, "petrol");
  assert.ok(first.choices.palettes.includes("midnight"));
  assert.equal((await send("PUT", "/api/prefs", { appearance: { palette: "midnight" } })).status, 200);
  assert.equal((await (await get("/api/prefs")).json()).appearance.palette, "midnight");
  assert.equal((await send("PUT", "/api/prefs", { appearance: { palette: "neon-chaos" } })).status, 400);
});

test("time per message defaults to 60 minutes, allows no limit, and refuses nonsense", async () => {
  const { get, send } = await start();
  const first = await (await get("/api/prefs")).json();
  assert.equal(first.maxMinutes, 60);
  assert.ok(first.maxMinutesChoices.includes(0));
  const none = await (await send("PUT", "/api/prefs", { maxMinutes: 0 })).json();
  assert.equal(none.maxMinutes, 0);
  assert.equal(none.maxMinutesSaved, true);
  assert.equal((await send("PUT", "/api/prefs", { maxMinutes: -5 })).status, 400);
  assert.equal((await send("PUT", "/api/prefs", { maxMinutes: 99999 })).status, 400);
});

test("the page has the window controls and no Graph tab", () => {
  const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(html, /id="ctxwin-input"/, "the exact context size sits with the gauge");
  assert.match(html, /id="ctx-window-slider"/);
  assert.match(html, /id="steps-seg"/);
  assert.match(html, /id="account-panel"/);
  assert.match(html, /id="sb-hide"/);
  assert.doesNotMatch(html, /data-grip="sessions"/, "the chats panel has no drag handle");
  assert.doesNotMatch(html, /data-exit="outline"|data-exit="express"/, "VPN rows come from what is installed, not from markup");
  assert.doesNotMatch(html, /data-insp="graph"/);
  assert.match(js, /const INSPECTOR_TABS = \["files"\];/);
  // Folder and fold changes are mutations, so they carry the token.
  assert.match(js, /mutate\(method, `\/api\/folders\$\{query\}`, payload\)/);
  assert.match(js, /mutate\("POST", "\/api\/folders\/move"/);
});

// 2026-11-08: "make the context slider actually update the session immediately".
test("a window change shows on an idle chat's gauge at once", async () => {
  const { get, send } = await start({ contextWindow: 32_768 });
  const started = await (await send("POST", "/api/chat", { task: "ping" })).json();
  for (let i = 0; i < 100; i += 1) {
    const chat = await (await get(`/api/chat?id=${encodeURIComponent(started.id)}`)).json();
    if (chat.status !== "running") break;
    await new Promise((done) => setTimeout(done, 50));
  }
  const meter = await (await get(`/api/context?id=${encodeURIComponent(started.id)}`)).json();
  assert.equal(meter.window, 32_768);
  await send("PUT", "/api/prefs", { contextWindow: 131_072 });
  const changed = await (await get(`/api/context?id=${encodeURIComponent(started.id)}`)).json();
  assert.equal(changed.window, 131_072, "no message had to be sent first");
  assert.equal(changed.used, meter.used);
  assert.equal((await send("POST", "/api/steer", { id: started.id, text: "late" })).status, 409, "a finished chat cannot be steered");
});

test("\"Goal mode. ...\" starts a goal chat, and its follow-up stays one", async () => {
  const { send } = await start();
  const first = await (await send("POST", "/api/chat", { task: "Goal mode. Task: tidy the readme" })).json();
  assert.equal(first.goal, true);
  const followUp = await (await send("POST", "/api/chat", { task: "continue", parentId: first.id })).json();
  assert.equal(followUp.goal, true, "a follow-up to an open goal carries it on");
  const off = await (await send("POST", "/api/chat", { task: "just a question", parentId: followUp.id, goal: false })).json();
  assert.equal(off.goal, false, "switched off by hand wins");
  const plain = await (await send("POST", "/api/chat", { task: "hello" })).json();
  assert.equal(plain.goal, false);
  for (const id of [first.id, followUp.id, off.id, plain.id]) await send("POST", "/api/cancel", { id });
});
