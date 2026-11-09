/**
 * The MCP button in the composer: which MCP servers this install knows, which are on, and
 * a switch for each (2026-11-08). The registry itself belongs to the bundled mcp-manager
 * plugin (plugins/rosa-mcp-manager), so this module reads and writes the same file the
 * plugin's mcp_servers / mcp_tools / mcp_call tools read: a switch takes effect for the
 * very next call a model makes, running chats included, with nothing to restart.
 *
 * It can also bring in the servers Claude Code already has (~/.claude.json and the
 * workspace's .mcp.json), so a person does not retype them. Imported servers arrive OFF:
 * turning one on is the person's decision, the same rule as the plugin's (no tool can add
 * a server, because "register a command, then run it" would be a shell by two hops).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  loadState,
  normalizeServer,
  recordProbe,
  registryPath,
  saveRegistry,
  statePath,
  withStdioServer,
} from "../plugins/rosa-mcp-manager/plugin.mjs";

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The files the panel works on, resolved the way the plugin resolves them. */
export function mcpFiles(pluginConfig = {}) {
  const ctx = { config: pluginConfig ?? {} };
  return { registry: registryPath(ctx), state: statePath(ctx) };
}

/** One row per registered server, with its last check. Starts nothing. */
export function listMcpServers(files) {
  const registry = loadRegistry(files.registry);
  const state = loadState(files.state);
  return Object.keys(registry.servers)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const s = registry.servers[name];
      const probe = state.servers?.[name] ?? null;
      return {
        name,
        enabled: s.enabled === true && !s.invalid,
        transport: s.transport,
        command: s.command ? [s.command, ...(s.args ?? [])].join(" ") : null,
        url: s.url ?? null,
        keepAlive: s.keepAlive === true,
        invalid: s.invalid ?? null,
        probe: probe ? { ok: probe.ok ?? null, tools: probe.toolCount ?? null, error: probe.lastError ?? null, at: probe.checkedAt ?? null } : null,
      };
    });
}

export function setMcpEnabled(files, name, enabled) {
  const registry = loadRegistry(files.registry);
  const entry = registry.servers[name];
  if (!entry) throw Object.assign(new Error(`no MCP server named "${name}"`), { status: 404 });
  if (enabled && entry.invalid) throw Object.assign(new Error(`${name} cannot be turned on: ${entry.invalid}`), { status: 400 });
  registry.servers[name] = { ...entry, enabled: Boolean(enabled) };
  saveRegistry(files.registry, registry);
  return registry.servers[name];
}

export function addMcpServer(files, { name, command, args = [], cwd = null, env = {}, enabled = true }) {
  const id = String(name ?? "").trim();
  if (!NAME.test(id)) throw Object.assign(new Error("a server name is letters, numbers, dot, dash or underscore (up to 64)"), { status: 400 });
  if (!String(command ?? "").trim()) throw Object.assign(new Error("a command is required"), { status: 400 });
  const registry = loadRegistry(files.registry);
  if (registry.servers[id]) throw Object.assign(new Error(`there is already a server named "${id}"`), { status: 409 });
  registry.servers[id] = normalizeServer(id, { command: String(command).trim(), args: Array.isArray(args) ? args.map(String) : [], cwd, env, enabled });
  saveRegistry(files.registry, registry);
  return registry.servers[id];
}

export function removeMcpServer(files, name) {
  const registry = loadRegistry(files.registry);
  if (!registry.servers[name]) throw Object.assign(new Error(`no MCP server named "${name}"`), { status: 404 });
  delete registry.servers[name];
  saveRegistry(files.registry, registry);
}

/** Handshake once and count the tools; the result is remembered for the list. */
export async function probeMcpServer(files, name, { timeoutMs = 20000, log = () => {}, withServer = withStdioServer } = {}) {
  const registry = loadRegistry(files.registry);
  const entry = registry.servers[name];
  if (!entry) throw Object.assign(new Error(`no MCP server named "${name}"`), { status: 404 });
  try {
    const tools = await withServer({ ...entry, name }, (client) => client.listTools(), { timeoutMs, log });
    recordProbe(files.state, name, { ok: true, toolCount: tools.length, lastError: null });
    return { ok: true, tools: tools.length, names: tools.map((t) => t.name) };
  } catch (err) {
    const error = String(err?.message ?? err);
    recordProbe(files.state, name, { ok: false, lastError: error });
    return { ok: false, error };
  }
}

const sameFolder = (a, b) => String(a ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === String(b ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * The MCP servers Claude Code is set up with: user scope (~/.claude.json), the workspace's
 * project entry there, and the workspace's .mcp.json. Only stdio servers can be imported
 * (the mcp-manager client speaks stdio); the others are listed with the reason.
 */
export function claudeCodeServers({ workspace = null, home = homedir() } = {}) {
  const found = new Map();
  const take = (servers, source) => {
    for (const [name, spec] of Object.entries(servers ?? {})) {
      if (!spec || typeof spec !== "object" || found.has(name)) continue;
      const stdio = typeof spec.command === "string" && spec.command.trim() !== "";
      found.set(name, {
        name,
        source,
        importable: stdio && NAME.test(name),
        reason: stdio ? (NAME.test(name) ? null : "name has characters Rosalena does not allow") : `${spec.type ?? "remote"} servers are not supported yet (stdio only)`,
        spec: stdio ? { command: spec.command, args: Array.isArray(spec.args) ? spec.args.map(String) : [], env: spec.env && typeof spec.env === "object" ? spec.env : {}, cwd: spec.cwd ?? null } : null,
      });
    }
  };
  const config = readJson(join(home, ".claude.json"));
  if (workspace) {
    const project = Object.entries(config?.projects ?? {}).find(([path]) => sameFolder(path, workspace))?.[1];
    take(project?.mcpServers, "Claude Code (this project)");
    const dotMcp = join(workspace, ".mcp.json");
    if (existsSync(dotMcp)) take(readJson(dotMcp)?.mcpServers, ".mcp.json in this folder");
  }
  take(config?.mcpServers, "Claude Code (all projects)");
  return [...found.values()];
}

/** Import the named Claude Code servers, OFF. Names already registered are skipped. */
export function importClaudeCodeServers(files, names, options = {}) {
  const wanted = new Set((names ?? []).map(String));
  const registry = loadRegistry(files.registry);
  const added = [];
  const skipped = [];
  for (const server of claudeCodeServers(options)) {
    if (!wanted.has(server.name)) continue;
    if (!server.importable) skipped.push({ name: server.name, reason: server.reason });
    else if (registry.servers[server.name]) skipped.push({ name: server.name, reason: "already added" });
    else {
      registry.servers[server.name] = normalizeServer(server.name, { ...server.spec, enabled: false });
      added.push(server.name);
    }
  }
  if (added.length) saveRegistry(files.registry, registry);
  return { added, skipped };
}
