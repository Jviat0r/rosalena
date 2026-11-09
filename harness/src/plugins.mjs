// The plugin host — Rosalena's extension seam.
//
// Everything past the core loop is a plugin, so a module can be added, updated
// or removed without touching the agent. A plugin is a directory under
// `plugins/` with a `plugin.json` manifest and an ESM entry point exporting a
// definition object (a bare `.mjs` file with no manifest also works):
//
//   export default {
//     id: "example",
//     description: "one line, shown by /plugins",
//     tools:    (ctx) => [{ name, description, parameters, run }],  // optional
//     commands: (ctx) => ({ greet: async (argv) => "hi" }),         // optional
//     status:   (ctx) => "ready",                                   // optional
//     hooks:    (ctx) => ({ ... }),                                 // optional, see below
//     setup:    async (ctx) => {},                                  // optional
//   }
//
// A manifest may set "bundled": true to mark a module that ships with the
// harness rather than one a user installed; /plugins shows the difference.
//
// A plugin is third-party code, so the host enforces these rules:
//   - a plugin that throws while loading is reported and skipped; it can never
//     take the harness down with it
//   - a tool that is malformed, or whose name would shadow a built-in tool or
//     another plugin's tool, is dropped and the reason is recorded
//   - if setup(), tools() or commands() throws, the plugin registers NOTHING —
//     a half-registered module is worse than one that failed cleanly
//   - importing a plugin never performs work; it acts only when called
//
// `ctx` handed to a plugin: { root, config, harness, builtinTools, createTools, log }
//
// Hooks are how a plugin observes the agent loop without owning it. The loop
// calls the four hooks and stays in control of every decision:
//
//   onRunStart(info)             a run is starting; the return value is ignored
//   beforeStep(info) -> advice   before each model call
//   afterStep(info)  -> advice   after each step's tool results are in
//   beforeFinish(info) -> advice the model gave a final answer (no tool call). A note
//                                sends it back for one more round instead of ending;
//                                a run gets at most one such round, for all plugins
//   onRunEnd(info)               the run is over; the return value is ignored
//
// And the finer-grained ones (2026-11-03), so a plugin can act at the moment
// something happens instead of reconstructing it from the step summary:
//
//   beforeTool(info) -> advice   one tool call is about to run (after the permission
//                                gate allowed it): { step, tool, args }. `deny` refuses
//                                it with a reason the model reads. Fails closed: a
//                                beforeTool that throws or times out (2 s) is a deny.
//   afterTool(info)  -> advice   one tool call finished: { step, tool, args, ok, exit,
//                                ms, text }. Notes are read after the step's results.
//   beforeCompact(info)          the history is about to be summarized: { step, tokens }
//   afterCompact(info) -> advice it was: { step, summary, dropped, kept }. A note is
//                                how rules and goals get back in front of the model.
//   onPermission(info)           the gate decided something other than a silent allow:
//                                { step, tool, subject, reason, decision }
//   onSubagentStart(info)        a delegated worker starts: { task, depth }
//   onSubagentEnd(info)          ...and ends: { task, answer, error, stopped }
//   onError(info)                the run failed for good: { step, message }
//
// Every hook call has a time limit (10 s, 2 s for beforeTool): a hook that hangs is
// disabled for the run, the same as one that throws.
//
// `advice` is an object (a bare string is read as { note }); every field is
// optional and the loop validates it before acting on it:
//
//   note   string  appended to the conversation as a user message, so the model
//                  reads it before its next call. Advisory; blocks nothing.
//   stop   string  end the run now, with this reason, and report it as
//                  `guard:<plugin>`. The loop stops; the plugin never does.
//   model  string  send this exact router target - "provider/model" - instead of
//                  the step's task class. The router builds a one-target chain
//                  for a target, so a pinned step cannot fall back.
//   retry  object  { maxAttempts, initialDelayMs, maxDelayMs, jitterRatio }:
//                  retry THIS step's failed model call on the same target
//                  instead of letting the run die on it.
//   deny   string  beforeTool only: refuse this one call, with this reason.
//
// Every hook also gets `run`: { id, started, depth, state } - a fresh token per
// run. `run.state` is a per-plugin window onto one Map for the whole run, so a
// plugin keeps per-run state in it (get/set/has/delete) without colliding with
// another plugin that picked the same key. A hook that throws is reported once
// and disabled for the rest of that run: a broken guard must never break the
// loop it guards. An unrecognised hook name, or a hook that is not a function,
// is refused at load and reported.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentPluginId, renamePluginKeys } from "./plugin-names.mjs";
import { createTools } from "./tools.mjs";

export { RENAMED_PLUGINS, currentPluginId, renamePluginKeys } from "./plugin-names.mjs";

export function pluginRoot() {
  return fileURLToPath(new URL("../plugins", import.meta.url));
}

/**
 * The harness's own config file, next to package.json. Missing file means
 * defaults; a malformed file throws so the caller can say so out loud rather
 * than silently ignoring a config someone meant to take effect.
 */
export function readHarnessConfig(path = fileURLToPath(new URL("../harness.config.json", import.meta.url))) {
  if (!existsSync(path)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`harness.config.json is not valid JSON: ${reason(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("harness.config.json must be a JSON object");
  }
  // A config written before the rosa- names keeps working.
  if (parsed.plugins) parsed.plugins = renamePluginKeys(parsed.plugins);
  return parsed;
}

const DEFAULT_PARAMETERS = { type: "object", properties: {} };
const reason = (err) => (err instanceof Error ? err.message : String(err));

/** Candidate plugin names: folders carrying a manifest, plus bare .mjs files. */
function candidates(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() && existsSync(join(dir, e.name, "plugin.json"))) || e.name.endsWith(".mjs"))
    .map((e) => e.name)
    .sort();
}

function readManifest(dir, name) {
  if (name.endsWith(".mjs")) {
    const id = name.replace(/\.mjs$/, "");
    return { id, version: "0.0.0", description: "", entry: name, folder: dir, enabled: true, config: {} };
  }
  const folder = join(dir, name);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(folder, "plugin.json"), "utf8"));
  } catch (err) {
    throw new Error(`plugin.json could not be read: ${reason(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("plugin.json must be a JSON object");
  }
  const id = String(parsed.id ?? name).trim();
  if (!id) throw new Error("plugin.json needs an id");
  return {
    id,
    version: String(parsed.version ?? "0.0.0"),
    description: String(parsed.description ?? ""),
    entry: String(parsed.entry ?? "plugin.mjs"),
    folder,
    enabled: parsed.enabled !== false,
    bundled: parsed.bundled === true,
    // A core plugin is a feature of the app that happens to be written as a plugin: it ships
    // with every build, cannot be switched off from the Plugins page, and a failure to load
    // it is shown to the person instead of being skipped quietly (see CORE_PLUGINS).
    core: parsed.bundled === true && parsed.core === true,
    config: parsed.config && typeof parsed.config === "object" && !Array.isArray(parsed.config) ? parsed.config : {},
    // A page in the sidebar (ui-plugins.mjs). A plugin may be only that, with no module.
    ui: Boolean(parsed.ui && typeof parsed.ui === "object"),
  };
}

/**
 * Every plugin manifest in these folders, loaded or not, for a page that lists them all
 * (a switched-off plugin is never imported, so loadPlugins alone cannot describe it).
 * Returns `{ id, version, description, folder, entry, bundled, ui, hasCode, source }`
 * rows, plus `{ id, error }` for a manifest that cannot be read.
 */
export function listPluginManifests(dirs) {
  const out = [];
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of candidates(dir)) {
      try {
        const m = readManifest(dir, name);
        out.push({ ...m, source, hasCode: existsSync(join(m.folder, m.entry)) });
      } catch (err) {
        out.push({ id: name, source, error: reason(err) });
      }
    }
  }
  return out;
}

/**
 * Discover, load and validate every plugin.
 *
 * Never throws for a bad plugin: everything that went wrong comes back in
 * `errors`, so a broken module degrades the harness instead of breaking it.
 */
export async function loadPlugins({
  dir = pluginRoot(),
  // Folders of plugins the person added themselves (the Plugins page puts them in
  // <home>/tool-plugins). Loaded after the shipped ones; an id already taken is refused.
  extraDirs = [],
  root = process.cwd(),
  config = {},
  log = () => {},
  harness = {},
  toolsFactory = createTools,
} = {}) {
  const plugins = [];
  const tools = [];
  const commands = new Map();
  const hookList = [];
  const errors = [];
  const disabled = [];

  const sources = [{ dir, source: "bundled" }, ...extraDirs.map((d) => ({ dir: d, source: "user" }))].filter((s) => existsSync(s.dir));
  if (!sources.length) {
    return { dir, plugins, tools, commands, errors, disabled, describe: () => `no plugin directory at ${dir}` };
  }

  // Names already spoken for: a plugin may not silently replace a built-in.
  const taken = new Set(Object.keys(toolsFactory({ root }).byName));
  const seenIds = new Set();

  for (const { dir: from, name, source } of sources.flatMap((s) => candidates(s.dir).map((name) => ({ ...s, name })))) {
    let manifest;
    try {
      manifest = readManifest(from, name);
    } catch (err) {
      errors.push({ id: name, reason: reason(err) });
      continue;
    }
    if (seenIds.has(manifest.id)) {
      errors.push({ id: manifest.id, reason: `another plugin already uses the id "${manifest.id}"; rename this one's id in its plugin.json` });
      continue;
    }
    seenIds.add(manifest.id);
    manifest.source = source;

    const override = renamePluginKeys(config?.plugins ?? {})?.[manifest.id] ?? {};
    if ((override.enabled ?? manifest.enabled) === false) {
      disabled.push(manifest.id);
      continue;
    }

    const ctx = {
      root,
      harness,
      config: { ...manifest.config, ...(override.config ?? {}) },
      builtinTools: [...taken],
      createTools: toolsFactory,
      log: (m) => log(`[${manifest.id}] ${m}`),
    };

    // A page-only plugin (a "ui" block and no module) has nothing for the agent to load:
    // it is listed, so /plugins shows it, and ui-plugins.mjs serves its page.
    if (manifest.ui && !existsSync(join(manifest.folder, manifest.entry))) {
      plugins.push({
        id: manifest.id,
        version: manifest.version,
        description: manifest.description,
        folder: manifest.folder,
        status: "a page in the sidebar",
        bundled: manifest.bundled,
        source: manifest.source,
        tools: [],
        commands: [],
        hooks: [],
        config: { ...manifest.config, ...(override.config ?? {}) },
        definition: {},
      });
      continue;
    }

    let definition;
    try {
      const mod = await import(pathToFileURL(join(manifest.folder, manifest.entry)).href);
      // `"default" in mod` rather than `mod.default ?? mod`: an explicit
      // `export default null` is a broken plugin, not a cue to treat the module
      // namespace object as the definition.
      definition = "default" in mod ? mod.default : mod;
      if (!definition || typeof definition !== "object") {
        throw new Error("the entry point has no default export object");
      }
      if (typeof definition.setup === "function") await definition.setup(ctx);
    } catch (err) {
      errors.push({ id: manifest.id, reason: reason(err) });
      continue;
    }

    // Collect into pending lists first: nothing is committed unless the whole
    // plugin loads, so a failure cannot leave half a module registered.
    const pendingTools = [];
    const pendingCommands = {};
    const pendingHooks = {};
    try {
      const contributed = typeof definition.tools === "function" ? await definition.tools(ctx) : (definition.tools ?? []);
      for (const tool of Array.isArray(contributed) ? contributed : []) {
        const toolName = String(tool?.name ?? "").trim();
        if (!toolName || typeof tool.run !== "function") {
          errors.push({ id: manifest.id, reason: "ignored a tool without both a name and a run() function" });
          continue;
        }
        if (taken.has(toolName)) {
          errors.push({ id: manifest.id, reason: `ignored tool "${toolName}": that name is already taken` });
          continue;
        }
        taken.add(toolName);
        pendingTools.push({
          name: toolName,
          description: String(tool.description ?? ""),
          parameters: tool.parameters ?? DEFAULT_PARAMETERS,
          run: tool.run,
          plugin: manifest.id,
        });
      }

      const contributedCommands = typeof definition.commands === "function" ? await definition.commands(ctx) : (definition.commands ?? {});
      for (const [key, fn] of Object.entries(contributedCommands ?? {})) {
        if (typeof fn !== "function") {
          errors.push({ id: manifest.id, reason: `ignored command "${key}": not a function` });
          continue;
        }
        pendingCommands[key] = fn;
      }

      const contributedHooks = typeof definition.hooks === "function" ? await definition.hooks(ctx) : (definition.hooks ?? {});
      for (const [hookName, fn] of Object.entries(contributedHooks ?? {})) {
        if (!HOOK_SET.has(hookName)) {
          errors.push({ id: manifest.id, reason: `ignored hook "${hookName}": the harness does not call that hook` });
          continue;
        }
        if (typeof fn !== "function") {
          errors.push({ id: manifest.id, reason: `ignored hook "${hookName}": not a function` });
          continue;
        }
        pendingHooks[hookName] = fn;
      }
    } catch (err) {
      errors.push({ id: manifest.id, reason: reason(err) });
      continue;
    }

    let status = "ok";
    if (typeof definition.status === "function") {
      try {
        status = String(await definition.status(ctx));
      } catch (err) {
        status = `status() failed: ${reason(err)}`;
      }
    }

    const record = {
      id: manifest.id,
      version: manifest.version,
      description: String(definition.description ?? manifest.description ?? ""),
      folder: manifest.folder,
      status,
      bundled: manifest.bundled,
      source: manifest.source,
      tools: pendingTools.map((t) => t.name),
      commands: Object.keys(pendingCommands),
      hooks: Object.keys(pendingHooks),
      // The effective config (manifest defaults with harness.config.json on top), so a
      // caller that needs to reach a plugin's own module - the UI's monitor route does -
      // can use the same settings the plugin itself was loaded with instead of
      // re-deriving them and quietly disagreeing.
      config: ctx.config,
      definition,
    };
    for (const tool of pendingTools) tools.push(tool);
    for (const [key, fn] of Object.entries(pendingCommands)) commands.set(`${manifest.id}:${key}`, fn);
    for (const [name, fn] of Object.entries(pendingHooks)) hookList.push({ plugin: manifest.id, name, fn });
    plugins.push(record);
  }

  const describe = () => {
    const lines = [];
    for (const p of plugins) {
      const cmds = p.commands.length ? `  /${p.id} ${p.commands.join("|")}` : "";
      const toolCount = `${p.tools.length} tool${p.tools.length === 1 ? "" : "s"}`;
      const hooks = p.hooks.length ? `, ${p.hooks.length} hook${p.hooks.length === 1 ? "" : "s"}` : "";
      lines.push(`  ${p.id.padEnd(12)} v${p.version}  ${toolCount}${hooks}${cmds}  ${p.status}${p.bundled ? "  bundled" : "  installed"}`);
      if (p.description) lines.push(`               ${p.description}`);
    }
    for (const id of disabled) lines.push(`  ${id.padEnd(12)} disabled in harness.config.json`);
    for (const e of errors) lines.push(`  ${String(e.id).padEnd(12)} FAILED: ${e.reason}`);
    return lines.length ? lines.join("\n") : "no plugins installed";
  };

  return { dir, plugins, tools, commands, hooks: hookList, errors, disabled, describe };
}

/**
 * The loop hooks this harness calls. Anything else is refused and reported.
 *
 * `llm/stream` is the odd one out: it is an observer, not an adviser. It fires
 * twice per model call (phase "start", then "end"), the return value is ignored,
 * and its job is to make a call visible to something outside the loop - a
 * monitor, a ledger, a dashboard - while the call is happening. Every other hook
 * here can change what the loop does; this one cannot, on purpose.
 */
export const HOOK_NAMES = [
  "onRunStart",
  "beforeStep",
  "afterStep",
  "beforeFinish",
  "onRunEnd",
  "llm/stream",
  "beforeTool",
  "afterTool",
  "beforeCompact",
  "afterCompact",
  "onPermission",
  "onSubagentStart",
  "onSubagentEnd",
  "onError",
];
const HOOK_SET = new Set(HOOK_NAMES);

/** How long one hook call may take before it counts as hung (ms). */
export const HOOK_TIMEOUT_MS = 10_000;
export const BEFORE_TOOL_TIMEOUT_MS = 2_000;
// A veto hook that crashes or hangs must not wave the call through.
const FAIL_CLOSED = new Set(["beforeTool"]);

/**
 * A per-plugin window onto a run's state Map. Every plugin shares the run token,
 * so a flat Map would let two of them pick the same obvious key - "pin", "base",
 * "steps" - and silently read each other's values. The prefix is invisible: a
 * plugin sees a plain get/set/has/delete map, and `size`/`keys` are left off
 * because they would report the whole run's map, not its own keys.
 */
function stateView(state, plugin) {
  const key = (k) => `${plugin}\u0000${String(k)}`;
  return {
    get: (k) => state.get(key(k)),
    set: (k, v) => state.set(key(k), v),
    has: (k) => state.has(key(k)),
    delete: (k) => state.delete(key(k)),
  };
}

/**
 * Run the hooks a run registered, in registration order, with every failure
 * contained: a hook that throws is disabled for the rest of that run rather
 * than taking down the loop it guards.
 *
 * The runner decides nothing. It returns what the plugins advised and leaves it
 * to the caller to validate and apply.
 */
export function createHookRunner(hooks = [], { log = () => {}, timeoutMs = HOOK_TIMEOUT_MS, beforeToolTimeoutMs = BEFORE_TOOL_TIMEOUT_MS } = {}) {
  const disabled = new Set();
  return {
    /** Which hook names are actually registered - so a caller can report them. */
    names: [...new Set(hooks.map((h) => h.name))].sort(),
    async fire(name, info) {
      const notes = [];
      let stop = null;
      let model;
      let retry;
      let deny = null;
      const limit = name === "beforeTool" ? beforeToolTimeoutMs : timeoutMs;
      for (const entry of hooks) {
        if (entry.name !== name || disabled.has(entry.plugin)) continue;
        const own = info?.run?.state ? { ...info, run: { ...info.run, state: stateView(info.run.state, entry.plugin) } } : info;
        let out;
        let timer = null;
        let hung = false;
        try {
          out = await Promise.race([
            Promise.resolve().then(() => entry.fn(own)),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                hung = true;
                reject(new Error(`no answer within ${limit} ms`));
              }, limit);
              // Not unref'd: a hook that hangs on a promise holding no handle would leave
              // nothing keeping the process up, and a CLI run would exit mid-step instead of
              // cutting the hook off. The finally below clears it the moment the hook answers.
            }),
          ]);
        } catch (err) {
          disabled.add(entry.plugin);
          log(`${entry.plugin}: ${name}() ${hung ? "hung" : "threw"} and is disabled for this run: ${reason(err)}`);
          if (FAIL_CLOSED.has(name) && !deny) deny = { plugin: entry.plugin, reason: `its check failed (${reason(err)})` };
          continue;
        } finally {
          clearTimeout(timer);
        }
        if (out == null) continue;
        const advice = typeof out === "string" ? { note: out } : out;
        if (typeof advice !== "object" || Array.isArray(advice)) {
          log(`${entry.plugin}: ${name}() returned ${typeof out}, expected an object or a string - ignored`);
          continue;
        }
        const note = typeof advice.note === "string" ? advice.note.trim() : "";
        if (note) notes.push({ plugin: entry.plugin, note });
        const stopReason = typeof advice.stop === "string" ? advice.stop.trim() : "";
        if (stopReason && !stop) stop = { plugin: entry.plugin, reason: stopReason };
        if (model === undefined && typeof advice.model === "string" && advice.model.trim()) {
          model = advice.model.trim();
        }
        if (!retry && advice.retry && typeof advice.retry === "object" && !Array.isArray(advice.retry)) {
          retry = advice.retry;
        }
        const denyReason = typeof advice.deny === "string" ? advice.deny.trim() : "";
        if (denyReason && !deny) deny = { plugin: entry.plugin, reason: denyReason };
      }
      return { notes, stop, model, retry, deny };
    },
  };
}

/**
 * Run `/plugin <id>:<command> [args...]` or a bare `<id>:<command>`.
 * Returns null when the command does not exist, so the caller can say so.
 */
export async function runPluginCommand(host, spec, argv = []) {
  const [named, command] = String(spec ?? "").split(":");
  if (!named || !command) return null;
  // An old name (local-model-host:list, from before the rosa- names) still runs.
  const id = currentPluginId(named);
  const fn = host.commands.get(`${id}:${command}`);
  if (!fn) return null;
  return fn(argv);
}
