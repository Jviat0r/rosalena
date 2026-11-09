// Rosalena's own plugins are named rosa-* since 2026-11-08. What was saved under an old
// name - harness.config.json blocks, Plugins-page switches, Creator switches, a
// `/plugin local-model-host:list` - must still reach the plugin.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { RENAMED_PLUGINS, currentPluginId, loadPlugins, readHarnessConfig, renamePluginKeys, runPluginCommand } from "../src/plugins.mjs";
import { listUiPlugins } from "../src/ui-plugins.mjs";

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");

test("every bundled plugin is a rosa- plugin, and the map covers each one's old name", () => {
  const folders = readdirSync(PLUGINS, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(PLUGINS, d.name, "plugin.json")));
  assert.ok(folders.length >= 30);
  for (const folder of folders) {
    const id = JSON.parse(readFileSync(join(PLUGINS, folder.name, "plugin.json"), "utf8")).id;
    assert.equal(id, folder.name, `${folder.name}: the folder and its id agree`);
    assert.match(id, /^rosa-/, `${id} carries the rosa- name`);
    assert.equal(currentPluginId(id.slice(5)), id, `${id.slice(5)} (its old name) maps to ${id}`);
  }
  for (const to of Object.values(RENAMED_PLUGINS)) assert.ok(existsSync(join(PLUGINS, to, "plugin.json")), `${to} exists`);
});

test("old names map to new ones; a new name's own entry wins over an old one", () => {
  assert.equal(currentPluginId("local-model-host"), "rosa-local-model-host");
  assert.equal(currentPluginId("opencode-freeaccess"), "rosa-opencode-handler");
  assert.equal(currentPluginId("rosa-model-pin"), "rosa-model-pin");
  assert.equal(currentPluginId("someone-elses-plugin"), "someone-elses-plugin");
  assert.deepEqual(renamePluginKeys({ comfyui: false, "rosa-comfyui": true, mine: false }), { "rosa-comfyui": true, mine: false });
  assert.deepEqual(renamePluginKeys({ "todo-guard": { enabled: false } }), { "rosa-todo-guard": { enabled: false } });
});

test("a harness.config.json written with old names still configures the plugins", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "rosa-config-")), "harness.config.json");
  writeFileSync(file, JSON.stringify({ plugins: { "process-tracker": { enabled: false }, "local-llm": { config: { modelDirs: ["X:/models"] } } } }));
  const config = readHarnessConfig(file);
  assert.deepEqual(Object.keys(config.plugins).sort(), ["rosa-local-llm", "rosa-process-tracker"]);
  const host = await loadPlugins({ config });
  assert.ok(host.disabled.includes("rosa-process-tracker"), "switched off under its old name, still off");
  assert.deepEqual(host.plugins.find((p) => p.id === "rosa-local-llm")?.config?.modelDirs, ["X:/models"]);
  // A config object handed straight to loadPlugins (not through the file) too.
  const direct = await loadPlugins({ config: { plugins: { "todo-guard": { enabled: false } } } });
  assert.ok(direct.disabled.includes("rosa-todo-guard"));
});

test("a plugin command under its old name still runs", async () => {
  const ran = [];
  const host = { commands: new Map([["rosa-local-model-host:list", (argv) => ran.push(argv)]]) };
  await runPluginCommand(host, "local-model-host:list", ["a"]);
  await runPluginCommand(host, "rosa-local-model-host:list", ["b"]);
  assert.deepEqual(ran, [["a"], ["b"]]);
  assert.equal(await runPluginCommand(host, "nope:list", []), null);
});

test("a sidebar page switched off under its old name stays off", () => {
  const pages = listUiPlugins({ state: { "poster-studio": { enabled: false } } });
  assert.equal(pages.find((p) => p.id === "rosa-poster-studio")?.enabled, false);
  assert.equal(pages.find((p) => p.id === "rosa-style-lab")?.enabled, true);
});
