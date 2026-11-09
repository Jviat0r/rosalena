// MCP manager — the client half of the harness's MCP story.
//
// `rosa-mcp-server` publishes THIS harness's tools to any MCP client; this plugin is
// the mirror image: it keeps a registry of MCP servers and lets the harness
// call theirs. A host-specific MCP manager (DeepSeek Harness has its own, separately) manages its host's MCP rows —
// toggle a row, start the backing process, health-check it, keep its log. The
// host-specific parts (DSH's pluginManager, cordis.patch.yml, a Settings page)
// have no meaning here, so what ports is the behaviour: a registry, on/off,
// a reachability check, tool discovery, and a per-server log.
//
// Two deliberate differences from the original, both to fit a headless loop:
//
//   - NO long-lived child processes. The original starts a server's process and
//     keeps it alive behind a toggle; a harness that does that leaks a process
//     per server for as long as it runs (which the bundled process-tracker would
//     then correctly flag). Every operation here is spawn -> handshake -> work
//     -> exit, so a crashed server cannot outlive the call that started it.
//   - the registry is HUMAN-writable only. `mcp_call` can run a registered
//     server, but no tool can ADD one: otherwise a model could register a
//     command and then run it, which is a shell by two hops. Adding is a
//     /mcp-manager command, i.e. a keystroke.
//
// Wire format is newline-delimited JSON-RPC 2.0 over stdio, the same framing
// `rosa-mcp-server` uses, so the harness can be tested against itself.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "rosalena-harness", version: "0.1.0" };
const reason = (err) => (err instanceof Error ? err.message : String(err));

/** `ROSALENA_HOME` relocates the suite's data directory (see HARNESS.md). */
export const rosalenaHome = () => process.env.ROSALENA_HOME || join(homedir(), ".rosalena");

export const registryPath = (ctx) => ctx?.config?.registryFile || join(rosalenaHome(), "mcp-servers.json");
export const statePath = (ctx) => ctx?.config?.stateFile || join(rosalenaHome(), "mcp-state.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A registry entry, normalised. Never throws away an entry it cannot read: an
 * unreadable row is kept with `invalid` set so /mcp-manager list can say what
 * is wrong with it instead of quietly dropping someone's server.
 */
export function normalizeServer(name, spec = {}) {
  const id = String(name ?? "").trim();
  if (!id) throw new Error("a server needs a name");
  const transport = String(spec.transport ?? (spec.url ? "http" : "stdio"));
  const entry = {
    transport,
    command: spec.command == null ? null : String(spec.command),
    args: Array.isArray(spec.args) ? spec.args.map(String) : [],
    env: spec.env && typeof spec.env === "object" && !Array.isArray(spec.env) ? { ...spec.env } : {},
    cwd: spec.cwd ? String(spec.cwd) : null,
    url: spec.url ? String(spec.url) : null,
    enabled: spec.enabled !== false,
    // Keep one process running between calls instead of spawn -> call -> kill. Off by
    // default; servers that hold state in-process (a browser page, a debugger session)
    // need it, and agent-browser-style servers whose own daemon holds the state do not.
    keepAlive: spec.keepAlive === true,
    invalid: null,
  };
  if (transport === "stdio" && !entry.command) entry.invalid = "stdio needs a command";
  if (transport !== "stdio" && !entry.url) entry.invalid = `${transport} needs a url`;
  return entry;
}

export function loadRegistry(file) {
  const parsed = readJson(file, null);
  const servers = {};
  for (const [name, spec] of Object.entries(parsed?.servers ?? {})) {
    try {
      servers[name] = normalizeServer(name, spec ?? {});
    } catch (err) {
      servers[name] = { transport: "stdio", command: null, args: [], env: {}, cwd: null, url: null, enabled: false, invalid: reason(err) };
    }
  }
  return { version: 1, servers };
}

export function saveRegistry(file, registry) {
  writeJson(file, { version: 1, servers: registry.servers });
  return registry;
}

export function loadState(file) {
  const parsed = readJson(file, null);
  return { version: 1, checkedAt: parsed?.checkedAt ?? null, servers: parsed?.servers ?? {} };
}

export function recordProbe(file, name, patch) {
  const state = loadState(file);
  state.checkedAt = new Date().toISOString();
  const prior = state.servers[name] ?? {};
  state.servers[name] = { ...prior, ...patch, checkedAt: state.checkedAt };
  writeJson(file, state);
  return state.servers[name];
}

/** Pull the human-readable text out of an MCP `tools/call` result. */
export function formatToolResult(result) {
  if (!result || typeof result !== "object") return "(no result)";
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p) => (p?.type === "text" ? p.text : p?.type ? `[${p.type} content]` : ""))
    .filter((s) => typeof s === "string" && s.length)
    .join("\n");
  const body = text || JSON.stringify(result);
  return result.isError ? `error: ${body}` : body;
}

/**
 * One MCP server process, spoken to over stdio.
 *
 * The client owns id correlation, a per-request timeout and the child's life.
 * stdout is the protocol, so a line that is not JSON is logged and skipped
 * rather than fatal — a server that prints a banner must not break the call,
 * but it must not be silently mistaken for a reply either.
 */
export function createStdioClient({ command, args = [], env = {}, cwd = null, timeoutMs = 20000, log = () => {} }) {
  const child = spawn(command, args, {
    cwd: cwd ?? undefined,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 1;
  let stderr = "";
  let closed = false;

  const failAll = (err) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };
  const tail = (s) => (s.length > 300 ? `…${s.slice(-300)}` : s);

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log(`ignored a non-JSON line on stdout: ${text.slice(0, 120)}`);
      return;
    }
    if (message.id == null || !pending.has(message.id)) return; // response to nothing we asked
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const code = message.error.code != null ? ` (code ${message.error.code})` : "";
      entry.reject(new Error(`${message.error.message ?? "protocol error"}${code}`));
    } else {
      entry.resolve(message.result);
    }
  });
  child.stderr.on("data", (d) => {
    stderr = (stderr + String(d)).slice(-4000);
  });
  child.stdin.on("error", () => {}); // a dead child's stdin is not a crash
  child.on("error", (err) => {
    closed = true;
    failAll(err);
  });
  child.on("exit", (code) => {
    closed = true;
    failAll(new Error(`server exited${code == null ? "" : ` with code ${code}`}${stderr ? `: ${tail(stderr)}` : ""}`));
  });

  const send = (message) => {
    if (closed) throw new Error("server is closed");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("server is closed"));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });

  return {
    request,
    async initialize() {
      const result = await request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return result;
    },
    async listTools() {
      // Every page: a server with many tools pages its list, and the first page alone
      // would leave the model guessing at tools it was never shown.
      const tools = [];
      let cursor;
      for (let page = 0; page < 20; page += 1) {
        const result = await request("tools/list", cursor ? { cursor } : {});
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    callTool: (name, toolArgs) => request("tools/call", { name, arguments: toolArgs ?? {} }),
    stderrTail: () => stderr.trim(),
    isClosed: () => closed,
    close() {
      closed = true;
      failAll(new Error("client closed"));
      try {
        child.stdin.end();
      } catch {
        // already gone
      }
      try {
        child.kill();
      } catch {
        // already gone
      }
      lines.close();
    },
  };
}

// keepAlive servers: name -> { key, client, timer }. One process per server, reused while
// its command, args, env and cwd are unchanged; closed after an error, after `idleMs` of
// no calls, and when this process exits.
const live = new Map();
const IDLE_MS = 10 * 60 * 1000;
export function closeLiveServers() {
  for (const slot of live.values()) {
    clearTimeout(slot.timer);
    slot.client.close();
  }
  live.clear();
}
process.once("exit", closeLiveServers);
export const liveServerNames = () => [...live.keys()];

/**
 * spawn -> initialize -> fn -> stop: the way this plugin talks to a server. A server
 * registered with keepAlive keeps its one process between calls instead.
 */
export async function withStdioServer(entry, fn, options = {}) {
  if (entry.invalid) throw new Error(`server "${entry.name ?? ""}" is not usable: ${entry.invalid}`);
  if (entry.transport !== "stdio") {
    throw new Error(`transport "${entry.transport}" is not implemented yet; only stdio servers can be called`);
  }
  if (entry.keepAlive) {
    const name = entry.name ?? entry.command;
    const key = JSON.stringify([entry.command, entry.args, entry.env, entry.cwd]);
    let slot = live.get(name);
    if (!slot || slot.key !== key || slot.client.isClosed()) {
      if (slot) slot.client.close();
      const client = createStdioClient({ command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd, ...options });
      try {
        await client.initialize();
      } catch (err) {
        client.close();
        live.delete(name);
        throw err;
      }
      slot = { key, client, timer: null };
      live.set(name, slot);
    }
    clearTimeout(slot.timer);
    try {
      return await fn(slot.client);
    } catch (err) {
      slot.client.close();
      live.delete(name);
      throw err;
    } finally {
      if (live.get(name) === slot) {
        slot.timer = setTimeout(() => {
          slot.client.close();
          if (live.get(name) === slot) live.delete(name);
        }, options.idleMs ?? IDLE_MS);
        slot.timer.unref?.();
      }
    }
  }
  const client = createStdioClient({ command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd, ...options });
  try {
    await client.initialize();
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * One tool as a call signature a small model can copy: `fill(selector*: string, text*: string)`
 * - starred arguments are required - followed by its description.
 */
export function toolSignature(tool) {
  const schema = tool?.inputSchema ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const typeOf = (p) => {
    if (!p || typeof p !== "object") return "any";
    if (Array.isArray(p.enum)) return p.enum.slice(0, 6).map((v) => JSON.stringify(v)).join("|");
    if (p.type === "array") return `${typeOf(p.items)}[]`;
    return Array.isArray(p.type) ? p.type.join("|") : p.type ?? "any";
  };
  const args = Object.entries(schema.properties ?? {}).map(([name, p]) => `${name}${required.has(name) ? "*" : ""}: ${typeOf(p)}`);
  const description = String(tool?.description ?? "").replace(/\s+/g, " ").trim();
  return `${tool?.name}(${args.join(", ")})${description ? `  ${description.length > 200 ? `${description.slice(0, 200)}…` : description}` : ""}`;
}

/** `list` rendering: registry + last probe, with no process started. */
export function formatServers(registry, state) {
  const names = Object.keys(registry.servers).sort();
  if (!names.length) return `no MCP servers registered (${registry.path ?? "~/.rosalena/mcp-servers.json"} is empty). Add one with: /mcp-manager add <name> <command> [args...]`;
  const lines = [];
  for (const name of names) {
    const s = registry.servers[name];
    const probe = state.servers?.[name];
    const bits = [s.enabled ? "on" : "off"];
    bits.push(s.invalid ? `INVALID: ${s.invalid}` : `${s.transport}${s.command ? `: ${[s.command, ...s.args].join(" ")}` : s.url ? `: ${s.url}` : ""}`);
    if (probe?.ok === true) bits.push(`${probe.toolCount ?? 0} tool(s)`);
    else if (probe?.ok === false) bits.push(`unreachable: ${probe.lastError ?? "unknown"}`);
    else bits.push("not checked");
    lines.push(`  ${name.padEnd(16)} ${bits.join("  ")}`);
  }
  return lines.join("\n");
}

function pick(registry, name) {
  const entry = registry.servers[name];
  if (!entry) throw new Error(`no server named "${name}"; known: ${Object.keys(registry.servers).join(", ") || "(none)"}`);
  return { ...entry, name };
}

export default {
  id: "rosa-mcp-manager",
  description: "Registry + client for MCP servers: list, add, probe, and call their tools.",
  tools(ctx) {
    const reg = () => {
      const registry = loadRegistry(registryPath(ctx));
      registry.path = registryPath(ctx);
      return registry;
    };
    const call = async (name, tool, args) => {
      const entry = pick(reg(), name);
      if (!entry.enabled) throw new Error(`server "${name}" is off; /mcp-manager enable ${name}`);
      return withStdioServer(entry, (client) => client.callTool(tool, args), { timeoutMs: ctx.config?.timeoutMs, log: ctx.log });
    };
    return [
      {
        name: "mcp_servers",
        description: "List the MCP servers registered with this harness, with the last probe result. Starts nothing.",
        parameters: { type: "object", properties: {} },
        run: async () => formatServers(reg(), loadState(statePath(ctx))),
      },
      {
        name: "mcp_tools",
        description: "List the tools one registered MCP server exposes. Starts the server for a single handshake, then stops it.",
        parameters: { type: "object", properties: { server: { type: "string" } }, required: ["server"] },
        run: async ({ server }) => {
          const entry = pick(reg(), String(server));
          if (!entry.enabled) return `server "${server}" is off; /mcp-manager enable ${server}`;
          const tools = await withStdioServer(entry, (client) => client.listTools(), { timeoutMs: ctx.config?.timeoutMs, log: ctx.log });
          recordProbe(statePath(ctx), entry.name, { ok: true, toolCount: tools.length, lastError: null });
          return tools.length
            ? `${tools.map((t) => `  ${toolSignature(t)}`).join("\n")}\n(* = required. Call one with mcp_call {server, tool, arguments: {...}})`
            : `${server} exposes no tools`;
        },
      },
      {
        name: "mcp_call",
        description: "Call one tool on a registered MCP server (mcp_tools shows each tool's arguments). A server registered with keep-alive keeps its state between calls; others start fresh each call. The server must already be in the registry.",
        parameters: {
          type: "object",
          properties: {
            server: { type: "string" },
            tool: { type: "string" },
            arguments: { type: "object", description: "Arguments for the remote tool, as a JSON object." },
          },
          required: ["server", "tool"],
        },
        run: async ({ server, tool, arguments: args }) => {
          if (ctx.config?.allowCall === false) return "mcp_call is disabled by plugins.mcp-manager.config.allowCall=false";
          let parsed = args ?? {};
          if (typeof parsed === "string") {
            try {
              parsed = JSON.parse(parsed);
            } catch (err) {
              return `arguments must be a JSON object: ${reason(err)}`;
            }
          }
          try {
            const result = await call(String(server), String(tool), parsed);
            recordProbe(statePath(ctx), String(server), { ok: true, lastError: null });
            return formatToolResult(result);
          } catch (err) {
            recordProbe(statePath(ctx), String(server), { ok: false, lastError: reason(err) });
            return `mcp_call failed: ${reason(err)}`;
          }
        },
      },
    ];
  },
  commands(ctx) {
    const file = registryPath(ctx);
    const state = statePath(ctx);
    const load = () => loadRegistry(file);
    const setEnabled = (name, enabled) => {
      if (!name) return help;
      const registry = load();
      if (!registry.servers[name]) return `no server named "${name}"`;
      registry.servers[name] = { ...registry.servers[name], enabled };
      saveRegistry(file, registry);
      return `${name} is now ${enabled ? "on" : "off"}`;
    };
    const help = [
      "/mcp-manager list                     registered servers + last probe",
      "/mcp-manager add <name> <cmd> [args]  register a stdio server (flags: --cwd=<dir> --disabled --keep-alive)",
      "  --keep-alive keeps one process between calls, for servers that hold a page or session in memory",
      "/mcp-manager remove|enable|disable <name>",
      "/mcp-manager tools <name>             handshake once and list its tools",
      "/mcp-manager call <name> <tool> [json]",
      `  registry: ${file}`,
    ].join("\n");
    return {
      list: () => {
        const registry = load();
        registry.path = file;
        return formatServers(registry, loadState(state));
      },
      add: (argv) => {
        const flags = {};
        const rest = [];
        for (const arg of argv) {
          const m = /^--(cwd|env|disabled|keep-alive)(?:=(.*))?$/.exec(arg);
          if (m) flags[m[1]] = m[2] ?? true;
          else rest.push(arg);
        }
        const [name, command, ...args] = rest;
        if (!name || !command) return help;
        const registry = load();
        const env = {};
        for (const pair of String(flags.env ?? "").split(",").filter(Boolean)) {
          const [k, ...v] = pair.split("=");
          env[k] = v.join("=");
        }
        registry.servers[name] = normalizeServer(name, {
          command,
          args,
          env,
          cwd: typeof flags.cwd === "string" ? flags.cwd : null,
          enabled: flags.disabled !== true,
          keepAlive: flags["keep-alive"] === true,
        });
        saveRegistry(file, registry);
        return `registered ${name}: ${[command, ...args].join(" ")}\n  registry: ${file}`;
      },
      remove: (argv) => {
        const name = argv[0];
        if (!name) return help;
        const registry = load();
        if (!registry.servers[name]) return `no server named "${name}"`;
        delete registry.servers[name];
        saveRegistry(file, registry);
        return `removed ${name}`;
      },
      enable: (argv) => setEnabled(argv[0], true),
      disable: (argv) => setEnabled(argv[0], false),
      probe: async (argv) => {
        const name = argv[0];
        const registry = load();
        const names = name ? [name] : Object.keys(registry.servers);
        if (!names.length) return "no servers registered";
        const out = [];
        for (const n of names) {
          const entry = pick(registry, n);
          if (!entry.enabled) {
            out.push(`  ${n}  off`);
            continue;
          }
          try {
            const tools = await withStdioServer(entry, (client) => client.listTools(), { timeoutMs: ctx.config?.timeoutMs, log: ctx.log });
            recordProbe(state, n, { ok: true, toolCount: tools.length, lastError: null });
            out.push(`  ${n}  ok, ${tools.length} tool(s)`);
          } catch (err) {
            recordProbe(state, n, { ok: false, lastError: reason(err) });
            out.push(`  ${n}  unreachable: ${reason(err)}`);
          }
        }
        return out.join("\n");
      },
      tools: async (argv) => {
        const name = argv[0];
        if (!name) return help;
        const entry = pick(load(), name);
        const tools = await withStdioServer(entry, (client) => client.listTools(), { timeoutMs: ctx.config?.timeoutMs, log: ctx.log });
        recordProbe(state, name, { ok: true, toolCount: tools.length, lastError: null });
        return tools.map((t) => `  ${t.name}  ${t.description ?? ""}`.trimEnd()).join("\n") || `${name} exposes no tools`;
      },
      call: async (argv) => {
        const [name, tool, json] = argv;
        if (!name || !tool) return help;
        let args = {};
        if (json) {
          try {
            args = JSON.parse(json);
          } catch (err) {
            return `the arguments must be a JSON object: ${reason(err)}`;
          }
        }
        const entry = pick(load(), name);
        try {
          const result = await withStdioServer(entry, (client) => client.callTool(tool, args), { timeoutMs: ctx.config?.timeoutMs, log: ctx.log });
          recordProbe(state, name, { ok: true, lastError: null });
          return formatToolResult(result);
        } catch (err) {
          recordProbe(state, name, { ok: false, lastError: reason(err) });
          return `call failed: ${reason(err)}`;
        }
      },
    };
  },
  status: (ctx) => {
    const registry = loadRegistry(registryPath(ctx));
    const names = Object.keys(registry.servers);
    const on = names.filter((n) => registry.servers[n].enabled).length;
    const broken = names.filter((n) => registry.servers[n].invalid).length;
    return `${names.length} server(s), ${on} on${broken ? `, ${broken} invalid` : ""}${ctx.config?.allowCall === false ? ", calling disabled" : ""}`;
  },
};
