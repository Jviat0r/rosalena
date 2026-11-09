/**
 * The composer's Commits menu (ui.mjs /api/commit-mode): it reads and writes the same
 * per-workspace mode as `/plugin rosa-commit-cadence:mode`, so the checkpoint tool obeys it.
 *
 *   - GET reports the mode, whether the workspace is a git repo, and what is held back
 *   - PUT needs the token, refuses an unknown mode, and the plugin's readMode sees the change
 *   - outside a git repo the menu is still listed but marked git:false (shown disabled)
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "t".repeat(32);
const home = mkdtempSync(join(tmpdir(), "commit-mode-home-"));
process.env.ROSALENA_HOME = home; // the modes file lives here, not in the real ~/.rosalena

const { createUiServer } = await import("../src/ui.mjs");
const { readMode } = await import("../plugins/rosa-commit-cadence/plugin.mjs");

async function server(workspace) {
  const ui = createUiServer({ port: 0, home, workspace, token: TOKEN });
  const { port } = await ui.ready();
  return { ui, base: `http://127.0.0.1:${port}` };
}
const put = (base, body, token = TOKEN) =>
  fetch(`${base}/api/commit-mode`, { method: "PUT", headers: { "content-type": "application/json", "x-rosalena-token": token }, body: JSON.stringify(body) });

test("the Commits menu reads and writes the workspace's commit mode", async () => {
  const repo = mkdtempSync(join(tmpdir(), "commit-mode-repo-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
  const { ui, base } = await server(repo);
  try {
    const first = await (await fetch(`${base}/api/commit-mode`)).json();
    assert.deepEqual(first, { available: true, folder: repo, mode: "ask", git: true, held: 0 });

    assert.equal((await put(base, { mode: "loose" }, "wrong")).status, 403);
    assert.equal((await put(base, { mode: "yolo" })).status, 400);
    assert.equal(readMode(repo), "ask", "a refused PUT changes nothing");

    const res = await put(base, { mode: "loose" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, "loose");
    assert.equal(readMode(repo), "loose", "the checkpoint tool reads the same setting");
    assert.equal((await (await fetch(`${base}/api/commit-mode`)).json()).mode, "loose");

    // The page sends the chat's own folder: that folder changes, the app's default does not.
    const other = mkdtempSync(join(tmpdir(), "commit-mode-other-"));
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: other }).status, 0);
    const chat = await fetch(`${base}/api/commit-mode?workspace=${encodeURIComponent(other)}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-rosalena-token": TOKEN },
      body: JSON.stringify({ mode: "off" }),
    });
    assert.equal((await chat.json()).folder, other);
    assert.equal(readMode(other), "off");
    assert.equal(readMode(repo), "loose", "the default folder is untouched");
  } finally {
    await ui.close();
  }
});

test("outside a git repo the menu says so", async () => {
  const plain = mkdtempSync(join(tmpdir(), "commit-mode-plain-"));
  const { ui, base } = await server(plain);
  try {
    const info = await (await fetch(`${base}/api/commit-mode`)).json();
    assert.equal(info.available, true);
    assert.equal(info.git, false);
  } finally {
    await ui.close();
  }
});
