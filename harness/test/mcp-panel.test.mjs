/**
 * The composer's MCP button (mcp-panel.mjs): list, switch, add, remove, check, and import
 * from Claude Code. Every file is in a temp folder; no server process is started.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { addMcpServer, claudeCodeServers, importClaudeCodeServers, listMcpServers, mcpFiles, probeMcpServer, removeMcpServer, setMcpEnabled } from "../src/mcp-panel.mjs";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-panel-"));
  const files = mcpFiles({ registryFile: join(dir, "mcp-servers.json"), stateFile: join(dir, "mcp-state.json") });
  return { dir, files };
}

test("servers are listed with their switch, and a switch is written to the plugin's registry", () => {
  const { files } = setup();
  assert.deepEqual(listMcpServers(files), []);
  addMcpServer(files, { name: "fl-studio", command: "fl-studio-mcp.exe" });
  addMcpServer(files, { name: "github", command: "npx", args: ["-y", "server-github"], enabled: false });
  let rows = listMcpServers(files);
  assert.deepEqual(rows.map((r) => [r.name, r.enabled, r.command]), [
    ["fl-studio", true, "fl-studio-mcp.exe"],
    ["github", false, "npx -y server-github"],
  ]);
  setMcpEnabled(files, "fl-studio", false);
  setMcpEnabled(files, "github", true);
  const saved = JSON.parse(readFileSync(files.registry, "utf8")).servers;
  assert.equal(saved["fl-studio"].enabled, false);
  assert.equal(saved.github.enabled, true);
  assert.throws(() => setMcpEnabled(files, "nope", true), /no MCP server named "nope"/);
  assert.throws(() => addMcpServer(files, { name: "github", command: "x" }), /already a server/);
  assert.throws(() => addMcpServer(files, { name: "bad name!", command: "x" }), /letters, numbers/);
  removeMcpServer(files, "github");
  rows = listMcpServers(files);
  assert.deepEqual(rows.map((r) => r.name), ["fl-studio"]);
});

test("Check starts the server once, counts its tools, and remembers a failure too", async () => {
  const { files } = setup();
  addMcpServer(files, { name: "ok", command: "a" });
  addMcpServer(files, { name: "broken", command: "b" });
  const fake = async (entry, fn) => {
    if (entry.name === "broken") throw new Error("spawn b ENOENT");
    return fn({ listTools: async () => [{ name: "one" }, { name: "two" }] });
  };
  assert.deepEqual(await probeMcpServer(files, "ok", { withServer: fake }), { ok: true, tools: 2, names: ["one", "two"] });
  assert.deepEqual(await probeMcpServer(files, "broken", { withServer: fake }), { ok: false, error: "spawn b ENOENT" });
  const rows = Object.fromEntries(listMcpServers(files).map((r) => [r.name, r.probe]));
  assert.equal(rows.ok.tools, 2);
  assert.equal(rows.broken.ok, false);
  assert.match(rows.broken.error, /ENOENT/);
});

test("Claude Code's servers can be brought in, switched off; remote ones are listed but not importable", () => {
  const { dir, files } = setup();
  const home = join(dir, "home");
  const workspace = join(dir, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: { solbrowser: { type: "stdio", command: "node", args: ["cli.js"] }, remote: { type: "http", url: "https://x" } },
      projects: { [workspace.replace(/\\/g, "/")]: { mcpServers: { apollo: { command: "node", args: ["apollo.js"], env: { KEY: "k" } } } } },
    }),
  );
  writeFileSync(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { contentfarm: { command: "node", args: ["cf.js"] } } }));
  const found = claudeCodeServers({ workspace, home });
  assert.deepEqual(found.map((s) => [s.name, s.importable]).sort(), [["apollo", true], ["contentfarm", true], ["remote", false], ["solbrowser", true]]);
  const result = importClaudeCodeServers(files, ["solbrowser", "remote", "apollo"], { workspace, home });
  assert.deepEqual(result.added.sort(), ["apollo", "solbrowser"]);
  assert.deepEqual(result.skipped.map((s) => s.name), ["remote"]);
  const rows = listMcpServers(files);
  assert.ok(rows.every((r) => r.enabled === false), "imported servers start off");
  assert.equal(JSON.parse(readFileSync(files.registry, "utf8")).servers.apollo.env.KEY, "k", "its settings come with it");
  assert.deepEqual(importClaudeCodeServers(files, ["solbrowser"], { workspace, home }).skipped, [{ name: "solbrowser", reason: "already added" }]);
});
