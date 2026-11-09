// The Terminal tab's routes: token-gated, a real shell, output streamed back, killed on close.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";

const HOME = mkdtempSync(join(tmpdir(), "ros-term-home-"));
const ROOT = mkdtempSync(join(tmpdir(), "ros-term-ws-"));
const TOKEN = "term-test-token";
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

const call = (method, path, body, token = TOKEN) =>
  fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-rosalena-token": token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test("terminal routes refuse a request without the page token", async () => {
  assert.equal((await call("POST", "/api/terminal/open", {}, "")).status, 403);
  assert.equal((await call("GET", "/api/terminal", undefined, "wrong")).status, 403);
  const stream = await fetch(`${base}/api/terminal/stream?id=x&token=wrong`);
  assert.equal(stream.status, 403);
  await stream.body?.cancel();
});

test("a terminal runs a command in the workspace and streams the output", async () => {
  const opened = await (await call("POST", "/api/terminal/open", {})).json();
  assert.ok(opened.id, "open returns an id");
  assert.equal(opened.cwd, ROOT, "it starts in the workspace");

  const res = await fetch(`${base}/api/terminal/stream?id=${opened.id}&token=${TOKEN}`);
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const marker = `term-ok-${Date.now()}`;
  const input = await call("POST", "/api/terminal/input", { id: opened.id, data: `echo ${marker}\r\n` });
  assert.equal(input.status, 200);

  let seen = "";
  const deadline = Date.now() + 15000;
  while (!seen.includes(marker) || seen.split(marker).length < 3) {
    if (Date.now() > deadline) break;
    const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: null }), 1000))]);
    if (done) break;
    if (value) seen += decoder.decode(value);
    // cmd echoes the command and prints the result: once is enough on other shells.
    if (process.platform !== "win32" && seen.includes(marker)) break;
  }
  await reader.cancel();
  assert.ok(seen.includes(marker), `the echo came back: ${seen.slice(-200)}`);

  const listed = await (await call("GET", "/api/terminal")).json();
  assert.ok(listed.terminals.some((t) => t.id === opened.id));

  assert.equal((await call("POST", "/api/terminal/close", { id: opened.id })).status, 200);
  const after = await (await call("GET", "/api/terminal")).json();
  assert.ok(!after.terminals.some((t) => t.id === opened.id), "closed terminals are gone");
  assert.equal((await call("POST", "/api/terminal/input", { id: opened.id, data: "x\r\n" })).status, 400);
});
