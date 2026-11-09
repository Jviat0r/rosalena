/**
 * Core plugins (2026-11-08): bundled plugins marked "core" in plugin.json are features of the
 * app that happen to be written as plugins (commit cadence, the task list guard, MCP, the
 * local model host, SolBrowser, Style Lab, ...). They must load on every build, with the
 * shipped config, and the app must refuse to switch them off.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { listPluginManifests, loadPlugins, pluginRoot, readHarnessConfig } from "../src/plugins.mjs";
import { createUiServer } from "../src/ui.mjs";

const core = listPluginManifests([{ dir: pluginRoot(), source: "bundled" }]).filter((m) => m.core);

test("the core list is what the app depends on", () => {
  const ids = core.map((m) => m.id);
  for (const id of ["rosa-commit-cadence", "rosa-todo-guard", "rosa-mcp-manager", "rosa-process-tracker", "rosa-local-model-host", "rosa-solbrowser", "rosa-style-lab"]) {
    assert.ok(ids.includes(id), `${id} should be core`);
  }
  assert.ok(core.every((m) => m.bundled), "only a bundled plugin can be core");
});

test("every core plugin with code loads with the shipped config, with no errors", async () => {
  const host = await loadPlugins({ root: mkdtempSync(join(tmpdir(), "core-plugins-")), config: readHarnessConfig(), log: () => {} });
  for (const m of core.filter((entry) => entry.hasCode)) {
    const loaded = host.plugins.find((p) => p.id === m.id);
    const errors = host.errors.filter((e) => e.id === m.id).map((e) => e.reason);
    assert.ok(loaded, `${m.id} did not load: ${errors.join("; ") || (host.disabled.includes(m.id) ? "disabled" : "unknown")}`);
    assert.deepEqual(errors, [], `${m.id} loaded with problems`);
  }
});

// A plugin someone makes may replace a built-in one, so built-ins can be switched off (the
// Plugins page asks first) but never removed, and one that is off is not reported missing.
test("a core plugin can be switched off and back on, never removed, and off is not a problem", async () => {
  const TOKEN = "core-token-0123456789abcdef";
  const ws = mkdtempSync(join(tmpdir(), "core-ui-"));
  const ui = createUiServer({ port: 0, home: join(ws, "home"), workspace: ws, token: TOKEN });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  const post = (body) => fetch(`${base}/api/plugins/manage`, { method: "POST", headers: { "content-type": "application/json", "x-rosalena-token": TOKEN }, body: JSON.stringify(body) });
  const before = await (await fetch(`${base}/api/plugins/core`)).json();
  assert.deepEqual(before.problems, [], `core plugins missing: ${JSON.stringify(before.problems)}`);
  assert.equal((await post({ action: "tool-off", id: "rosa-todo-guard" })).status, 200);
  let manage = await (await fetch(`${base}/api/plugins/manage`)).json();
  const guard = manage.tools.find((t) => t.id === "rosa-todo-guard");
  assert.equal(guard?.core, true);
  assert.equal(guard?.enabled, false, "switched off");
  const afterOff = await (await fetch(`${base}/api/plugins/core`)).json();
  assert.deepEqual(afterOff.problems, [], "a built-in someone switched off is their choice, not a load failure");
  const remove = await post({ action: "tool-remove", id: "rosa-todo-guard" });
  assert.equal(remove.status, 409);
  assert.match((await remove.json()).error, /switched off but not removed/);
  assert.equal((await post({ action: "tool-on", id: "rosa-todo-guard" })).status, 200);
  manage = await (await fetch(`${base}/api/plugins/manage`)).json();
  assert.equal(manage.tools.find((t) => t.id === "rosa-todo-guard")?.enabled, true);
});
