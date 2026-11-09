// MCP server surface (stdio) — the "every module = MCP server + headless CLI"
// rule from MASTER-PLAN §5.1.
//
// This exposes the harness's own tool registry to any MCP client (DSH included)
// as `tools/list` / `tools/call`, so an agent in another app can read and search
// a workspace through the same sandbox rules this harness enforces.
//
// The tool list is ALLOW-LISTED and defaults to the read-only trio. `write_file`
// and `run_command` are deliberately opt-in through plugin config, because an MCP
// client that can call `run_command` gets a shell on this machine.
//
// stdout is reserved for the protocol; every diagnostic goes to stderr.

import { createInterface } from "node:readline";

import { runAgent } from "../../src/agent.mjs";
import { loadPlugins, readHarnessConfig } from "../../src/plugins.mjs";
import { listRuns, newRunId, readRun, requestCancel, runStatus } from "../../src/runs.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "rosalena-harness";
const SERVER_VERSION = "0.1.0";
const DEFAULT_ALLOW = ["read_file", "list_dir", "search"];
// Run *inspection* is free and read-only, so it belongs in the default surface: it is
// how a client answers "what did the harness actually do?". Starting runs is not free
// (tokens and GPU time), so those two are opt-in through `allowTasks`.
const DEFAULT_RUN_TOOLS = ["list_runs", "run_status", "read_run", "cancel_run"];
// What the suite is made of is also free to ask, and it is the question a client needs
// answered before it can use anything else: which modules exist and what they add.
const PLUGIN_TOOLS = ["list_plugins"];
const TASK_TOOLS = ["run_task", "spawn_subagent"];

const reason = (err) => (err instanceof Error ? err.message : String(err));
const reply = (id, result) => ({ jsonrpc: "2.0", id, result });

/**
 * The run-store tools. Each returns text, because that is what an MCP `tools/call`
 * carries: JSON for the ones a client will parse, one line per run for the one a human
 * will read in a log.
 */
export function createRunTools({ root, allowTasks = false, log = () => {} } = {}) {
  const json = (value) => JSON.stringify(value, null, 2);
  const tools = {
    list_runs: {
      description: "List the harness's recent runs, newest first (id, status, steps, task).",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "how many runs, default 20, max 200" },
          status: { type: "string", description: "only runs with this status (ok, failed, stopped, running, stale)" },
        },
        additionalProperties: false,
      },
      run: async ({ limit, status } = {}) => {
        const rows = listRuns({ limit: Math.min(Math.max(Number(limit) || 20, 1), 200), status: status ?? null });
        if (!rows.length) return "no runs recorded";
        return [
          "id                     status   steps  time       task",
          ...rows.map(
            (r) =>
              `${String(r.id).padEnd(22)} ${String(r.status).padEnd(8)} ${String(r.steps ?? 0).padEnd(6)} ` +
              `${String(r.ms == null ? "-" : `${r.ms}ms`).padEnd(10)} ${String(r.task ?? "").slice(0, 60)}`,
          ),
        ].join("\n");
      },
    },
    run_status: {
      description: "One run's status in one call: done or running, how far it got, its answer or error.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "run id; a unique prefix is enough" } },
        required: ["id"],
        additionalProperties: false,
      },
      run: async ({ id } = {}) => {
        const status = runStatus({ id });
        if (!status) return `no such run: ${id}`;
        return json(status);
      },
    },
    read_run: {
      description: "A run's final record plus its event log (the same events the console shows).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "run id; a unique prefix is enough" },
          limit: { type: "integer", description: "how many of the most recent events, default 200" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      run: async ({ id, limit } = {}) => {
        const found = readRun({ id, maxEvents: Math.min(Math.max(Number(limit) || 200, 1), 2000) });
        if (!found) return `no such run: ${id}`;
        return json(found);
      },
    },
    cancel_run: {
      description: "Ask a running run to stop at its next step. Records it as stopped: cancelled.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "run id; a unique prefix is enough" } },
        required: ["id"],
        additionalProperties: false,
      },
      run: async ({ id } = {}) => {
        const out = requestCancel({ id });
        return json(out);
      },
    },
  };

  if (!allowTasks) return tools;

  /**
   * Starting work returns an id immediately, never the run's outcome: an agent host that
   * blocks for minutes on a tool call loses its own turn. `wait: true` is available for
   * a caller that wants to block anyway, and it is what `spawn_subagent` uses.
   */
  const start = ({ task, model, parentRunId, depth = 0 }) => {
    if (!task || !String(task).trim()) throw new Error("a task is required");
    const runId = newRunId();
    const promise = runAgent({
      task: String(task),
      root,
      ...(model ? { cls: model } : {}),
      runId,
      depth,
      ...(parentRunId ? { parentRunId } : {}),
      onEvent: () => {},
    });
    promise.catch((err) => log(`run ${runId} failed: ${reason(err)}`));
    return { runId, promise };
  };

  tools.run_task = {
    description: "Start a task in this harness. Returns its run id immediately; poll it with run_status.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "what the agent should do" },
        model: { type: "string", description: "router class or provider/model, default the router's default" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    run: async ({ task, model } = {}) => {
      const { runId } = start({ task, model });
      return json({ runId, status: "running", poll: `run_status with id "${runId}"` });
    },
  };

  tools.spawn_subagent = {
    description: "Delegate a self-contained task to a subagent run, optionally waiting for its answer.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "the delegated task" },
        model: { type: "string", description: "router class or provider/model for the subagent" },
        parentRunId: { type: "string", description: "record the subagent under this run" },
        wait: { type: "boolean", description: "block until it finishes and return its status" },
      },
      required: ["task"],
      additionalProperties: false,
    },
    run: async ({ task, model, parentRunId, wait } = {}) => {
      const { runId, promise } = start({ task, model, parentRunId, depth: 1 });
      if (!wait) return json({ runId, status: "running" });
      await promise.catch(() => {});
      return json({ runId, ...runStatus({ id: runId }) });
    },
  };

  return tools;
}

/**
 * The module inventory: the one question a client asks before it can use anything
 * else. It loads the plugins rather than reading manifests alone, because "which
 * tools does this module add" is the useful half of the answer and loading is how
 * the harness itself finds out. Importing a plugin never performs work — that is
 * part of the plugin contract — and ESM caches the modules after the first call,
 * so repeated listing is a directory read.
 */
export function createInspectTools({ root, config = {}, log = () => {} } = {}) {
  return {
    list_plugins: {
      description:
        "List the harness's plugin modules: id, version, whether each is first-party (bundled) or installed from the store, the tools, commands and hooks it adds, " +
        "whether it is disabled, and anything that failed to load. Pass json:true for the raw structure.",
      parameters: {
        type: "object",
        properties: { json: { type: "boolean", description: "return JSON instead of one line per module" } },
        additionalProperties: false,
      },
      run: async ({ json } = {}) => {
        const host = await loadPlugins({ root, config, log });
        const modules = host.plugins.map((p) => ({
          id: p.id,
          version: p.version,
          origin: p.bundled ? "bundled" : "installed",
          tools: p.tools ?? [],
          commands: (p.commands ?? []).map((c) => `${p.id}:${c}`),
          hooks: p.hooks ?? [],
          status: p.status ?? "",
          description: p.description ?? "",
        }));
        if (json === true) return JSON.stringify({ dir: host.dir, count: modules.length, modules, disabled: host.disabled, errors: host.errors }, null, 2);
        if (!modules.length) return `no plugins found in ${host.dir}`;
        const lines = [`${modules.length} module(s) in ${host.dir}`];
        for (const m of modules) {
          const adds = [
            m.tools.length ? `${m.tools.length} tool${m.tools.length === 1 ? "" : "s"} ${m.tools.join(", ")}` : null,
            // The spec form, because that is what `--plugin` and this server take.
            m.commands.length ? m.commands.join(", ") : null,
            m.hooks.length ? `${m.hooks.length} hook${m.hooks.length === 1 ? "" : "s"}` : null,
          ].filter(Boolean);
          lines.push(`  ${m.id.padEnd(18)} v${String(m.version).padEnd(7)} ${m.origin.padEnd(9)} ${adds.join("  ") || "nothing"}`);
          if (m.description) lines.push(`  ${"".padEnd(18)} ${m.description.slice(0, 120)}`);
        }
        if (host.disabled.length) lines.push(`disabled by config: ${host.disabled.join(", ")}`);
        if (host.errors.length) lines.push(`failed to load: ${host.errors.map((e) => `${e.id} (${e.reason})`).join("; ")}`);
        return lines.join("\n");
      },
    },
  };
}

/**
 * A transport-free MCP server: `handle(message) -> response | null`.
 * Keeping it pure is what makes the protocol testable without a process.
 *
 * `allow` is the list of *file* tools a client may call (it widens or narrows that
 * family, as documented). Run inspection is added on top regardless, because it is
 * read-only and costs nothing — and because a client that can start work but cannot see
 * what happened is worse than one that cannot start work. `allowRuns: false` removes it
 * for a caller that wants the file surface only.
 */
export function createMcpServer({ createTools, root, allow, allowTasks = false, allowRuns = true, config = {}, log = () => {} }) {
  const tools = createTools({ root });
  const runTools = createRunTools({ root, allowTasks, log });
  const inspectTools = createInspectTools({ root, config, log });
  const all = { ...tools.byName, ...runTools, ...inspectTools };
  const fileTools = Array.isArray(allow) && allow.length ? allow : DEFAULT_ALLOW;
  const wanted = [
    ...fileTools,
    ...(allowRuns ? DEFAULT_RUN_TOOLS : []),
    ...(allowRuns ? PLUGIN_TOOLS : []),
    ...(allowTasks && allowRuns ? TASK_TOOLS : []),
  ];
  const names = wanted.filter((n) => Boolean(all[n]));
  const refused = wanted.filter((n) => !all[n]);
  if (refused.length) log(`ignoring unknown tool name(s) in config: ${refused.join(", ")}`);

  return {
    names,
    list() {
      return names.map((n) => ({
        name: n,
        description: all[n].description,
        inputSchema: all[n].parameters,
      }));
    },
    async call(name, args) {
      if (!names.includes(name)) throw new Error(`tool "${name}" is not exposed by this server`);
      return all[name].run(args ?? {});
    },
    async handle(message) {
      const id = message?.id ?? null;
      const method = message?.method;
      if (typeof method !== "string") {
        return { jsonrpc: "2.0", id, error: { code: -32600, message: "not a JSON-RPC request" } };
      }
      if (method.startsWith("notifications/")) return null;
      try {
        switch (method) {
          case "initialize":
            return reply(id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            });
          case "ping":
            return reply(id, {});
          case "tools/list":
            return reply(id, { tools: this.list() });
          case "tools/call": {
            const text = await this.call(message.params?.name, message.params?.arguments);
            return reply(id, { content: [{ type: "text", text: String(text) }] });
          }
          default:
            return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } };
        }
      } catch (err) {
        // A tool failure is a RESULT, not a protocol error: the client has to be
        // able to show its model what went wrong and carry on.
        return reply(id, { content: [{ type: "text", text: `error: ${reason(err)}` }], isError: true });
      }
    },
  };
}

async function serve(ctx) {
  const server = createMcpServer({
    createTools: ctx.createTools,
    root: ctx.root,
    allow: ctx.config?.tools,
    allowTasks: ctx.config?.allowTasks === true,
    // The real override layer, so list_plugins reports the modules this install has
    // switched off or reconfigured rather than the defaults on disk.
    config: readHarnessConfig(),
    log: ctx.log,
  });
  ctx.log(`serving ${server.names.length} tool(s) over stdio from ${ctx.root}: ${server.names.join(", ")}`);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue; // a malformed line is not worth killing the session over
    }
    const response = await server.handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    if (message?.method === "shutdown") break;
  }
}

export default {
  id: "rosa-mcp-server",
  description: "Serve the harness tools over MCP on stdio, so an MCP client can drive a workspace.",
  commands: (ctx) => ({
    serve: () => serve(ctx),
    tools: () =>
      createMcpServer({
        createTools: ctx.createTools,
        root: ctx.root,
        allow: ctx.config?.tools,
        allowTasks: ctx.config?.allowTasks === true,
        config: readHarnessConfig(),
      })
        .list()
        .map((t) => `  ${t.name}  ${t.description}`)
        .join("\n"),
  }),
  status: (ctx) =>
    `${(ctx.config?.tools ?? [...DEFAULT_ALLOW, ...DEFAULT_RUN_TOOLS, ...PLUGIN_TOOLS]).join(", ")} exposed` +
    (ctx.config?.allowTasks === true ? ` + ${TASK_TOOLS.join(", ")}` : " (task tools off: set allowTasks)"),
};
