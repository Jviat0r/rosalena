/**
 * OpenAI's Codex CLI as an engine behind Rosalena's window, the same way Claude Code is
 * (claude-engine.mjs; design: docs/research/claude-engine-2026-11.md).
 *
 * A chat whose model is `codex/<model>` is not run by Rosalena's own loop. It starts the
 * person's own installed Codex CLI headless, once per message, the way OpenAI's own
 * TypeScript SDK drives it (sdk/typescript/src/exec.ts in openai/codex):
 *
 *   codex exec --json --skip-git-repo-check --cd <workspace> <Access: --sandbox ... | --approve-for-me>
 *        [-m <model>] [-c model_reasoning_effort="<level>"] [-c developer_instructions="<role>"]
 *        [--add-dir <attachments>] [resume <thread id>] [--image <picture> ...]
 *
 * with the task written to its stdin (no prompt argument: `codex exec` then reads the
 * prompt from stdin, so a long or quoted task never meets a command line). Its JSONL
 * stream (thread.started, turn.*, item.*, error) becomes the events Rosalena's window
 * already draws (run, delta, assistant, tool, notice, run_end), in Rosalena's own run
 * store, so history, follow-ups, the queue and usage tracking work the same. The thread id
 * from `thread.started` is kept, and the chat's next message resumes it.
 *
 * Rosalena never asks for, reads or stores a ChatGPT login or key: whatever Codex is signed
 * in with (`codex login`: the ChatGPT plan, or an API key) is what answers. The only thing
 * this module does with auth is ask `codex login status` whether it is signed in at all.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";

import { cancelRequested, openRun } from "./runs.mjs";
import { createUsageTally } from "./usage.mjs";

export const ENGINE_PREFIX = "codex/";
export const ENGINE_ID = "codex";
export const isCodexModel = (model) => String(model ?? "").startsWith(ENGINE_PREFIX);

/**
 * The picker's rows: Codex's own default plus the models OpenAI lists for Codex with a
 * ChatGPT sign-in (learn.chatgpt.com/docs/models, read 2026-11-09; the bundled catalog
 * codex-rs/models-manager/models.json at release rust-v0.167.0 gives the same ids, their
 * reasoning levels and default levels). `default` passes no -m: Codex's recommended model
 * for the person's plan answers. contextMax is the window Codex runs the model with by
 * default (the docs' 500K for GPT-6.1 Sol, the catalog's context_window for the others).
 * `levels` is every value Codex takes for model_reasoning_effort on that model; the
 * picker offers the ones it has words for (low..max), and Ultracode asks for `ultra`.
 */
export const CODEX_MODELS = Object.freeze([
  { alias: "default", label: "Codex (its default model)", contextMax: 272_000, levels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: null },
  { alias: "gpt-6.1-sol", label: "Codex - GPT-6.1-Sol", contextMax: 500_000, levels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
  { alias: "gpt-6-astra", label: "Codex - GPT-6-Astra", contextMax: 272_000, levels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
  { alias: "gpt-6.1-terra", label: "Codex - GPT-6.1 Terra", contextMax: 500_000, levels: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
  { alias: "gpt-6-luna", label: "Codex - GPT-6-Luna", contextMax: 272_000, levels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
]);

/** The levels Rosalena's effort picker has words for, in its order. */
const PICKER_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Every value `model_reasoning_effort` takes (codex-rs/protocol/src/openai_models.rs). */
export const CODEX_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

const rowFor = (model) => {
  const alias = String(model ?? "").startsWith(ENGINE_PREFIX) ? String(model).slice(ENGINE_PREFIX.length) : String(model ?? "");
  return CODEX_MODELS.find((m) => m.alias === alias) ?? null;
};

export function menuRows() {
  return CODEX_MODELS.map((m) => ({
    id: `${ENGINE_PREFIX}${m.alias}`,
    label: m.label,
    provider: ENGINE_ID,
    model: m.alias,
    source: ENGINE_ID,
    kind: "chat",
    chat: true,
    efforts: m.levels.filter((level) => PICKER_EFFORTS.includes(level)),
    ...(m.defaultEffort ? { defaultEffort: m.defaultEffort } : {}),
    contextMax: m.contextMax,
    note: "Your own Codex CLI, with the sign-in it already has. Rosalena is the window; Codex runs the work.",
  }));
}

/** The Rust target triple OpenAI's npm package keeps its native binary under. */
function targetTriple(platform, arch) {
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  return arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl";
}

const NPM_PLATFORM_PACKAGE = {
  "x86_64-pc-windows-msvc": "codex-win32-x64",
  "aarch64-pc-windows-msvc": "codex-win32-arm64",
  "x86_64-apple-darwin": "codex-darwin-x64",
  "aarch64-apple-darwin": "codex-darwin-arm64",
  "x86_64-unknown-linux-musl": "codex-linux-x64",
  "aarch64-unknown-linux-musl": "codex-linux-arm64",
};

/**
 * The native codex binary inside an npm global folder (the one holding codex.cmd), where
 * `npm install -g @openai/codex` puts it: the launcher (codex-cli/bin/codex.js) runs
 * <platform package>/vendor/<triple>/bin/codex(.exe); the SDK also knows the older
 * vendor/<triple>/codex/ layout. Spawning it directly avoids codex.cmd, which Node can
 * only start through cmd.exe.
 */
function nativeFromNpm(npmDir, { platform, arch, exists }) {
  const triple = targetTriple(platform, arch);
  const exe = platform === "win32" ? "codex.exe" : "codex";
  const pkg = join(npmDir, "node_modules", "@openai", "codex");
  const platformPkg = NPM_PLATFORM_PACKAGE[triple];
  const vendors = [
    join(pkg, "node_modules", "@openai", platformPkg, "vendor"),
    join(npmDir, "node_modules", "@openai", platformPkg, "vendor"),
    join(pkg, "vendor"),
  ];
  for (const vendor of vendors) {
    for (const candidate of [join(vendor, triple, "bin", exe), join(vendor, triple, "codex", exe)]) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Codex on this machine, or null. In order: ROSALENA_CODEX_EXE; `codex` on PATH (a
 * codex.cmd from npm is swapped for the native binary it launches); the npm global folder
 * (%APPDATA%\npm); the folders OpenAI's own installers use (scripts/install/install.ps1:
 * %LOCALAPPDATA%\Programs\OpenAI\Codex\bin and $CODEX_HOME\packages\standalone\current;
 * install.sh: $CODEX_INSTALL_DIR or ~/.local/bin). The ChatGPT and Codex desktop apps are
 * not searched: OpenAI does not document where (or whether) they keep a codex binary
 * another program may start.
 */
export function findCodex({ env = process.env, platform = process.platform, arch = process.arch, exists = existsSync } = {}) {
  if (env.ROSALENA_CODEX_EXE) return exists(env.ROSALENA_CODEX_EXE) ? env.ROSALENA_CODEX_EXE : null;
  const win = platform === "win32";
  const home = env.USERPROFILE || env.HOME || homedir();
  const codexHome = env.CODEX_HOME || join(home, ".codex");

  for (const dir of String(env.PATH ?? env.Path ?? "").split(win ? ";" : delimiter)) {
    if (!dir) continue;
    if (win) {
      if (exists(join(dir, "codex.exe"))) return join(dir, "codex.exe");
      if (exists(join(dir, "codex.cmd"))) return nativeFromNpm(dir, { platform, arch, exists }) ?? join(dir, "codex.cmd");
    } else if (exists(join(dir, "codex"))) return join(dir, "codex");
  }

  const npmGlobal = win && env.APPDATA ? join(env.APPDATA, "npm") : "";
  if (npmGlobal) {
    const native = nativeFromNpm(npmGlobal, { platform, arch, exists });
    if (native) return native;
  }

  const exe = win ? "codex.exe" : "codex";
  const known = win
    ? [
        env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", exe) : "",
        join(codexHome, "packages", "standalone", "current", "bin", exe),
        join(codexHome, "packages", "standalone", "current", exe),
      ]
    : [join(env.CODEX_INSTALL_DIR || join(home, ".local", "bin"), exe), join(codexHome, "packages", "standalone", "current", "bin", exe)];
  for (const candidate of known) if (candidate && exists(candidate)) return candidate;
  if (npmGlobal && exists(join(npmGlobal, "codex.cmd"))) return join(npmGlobal, "codex.cmd");
  return null;
}

/**
 * How to start a found path: a native binary directly; a .js launcher through Node; a
 * .cmd/.bat (only when no native binary was found next to it) through cmd.exe with every
 * argument quoted. A native binary from the npm package gets the two variables its own
 * launcher sets, so Codex's update notices name npm.
 */
export function launchFor(exe, { platform = process.platform } = {}) {
  const path = String(exe ?? "");
  if (/\.m?js$/i.test(path)) {
    return { command: process.execPath, prefix: [path], shell: false, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} };
  }
  if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) return { command: path, prefix: [], shell: true, env: {} };
  const marker = `${sep}node_modules${sep}@openai${sep}codex`;
  const at = path.indexOf(marker);
  const env = at >= 0 ? { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: path.slice(0, at + marker.length) } : {};
  return { command: path, prefix: [], shell: false, env };
}

/** cmd.exe quoting for the .cmd fallback: Rosalena's own flags, paths and ids, never the task. */
const cmdQuote = (arg) => `"${String(arg).replace(/"/g, '""')}"`;

/**
 * The environment Codex gets: this process's, minus what would point it somewhere else.
 * OPENAI_BASE_URL is the router's address when Rosalena runs its OpenAI-shaped routes;
 * CODEX_SANDBOX*, CODEX_THREAD_ID are set by a parent Codex session (Rosalena started from
 * inside one) and would make this Codex think it is already sandboxed or in that thread;
 * ROSALENA_ROUTER_TOKEN is Rosalena's own secret, which Codex's shell has no use for. A
 * person's own OPENAI_API_KEY / CODEX_API_KEY / CODEX_HOME are theirs and stay.
 */
export function codexEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(OPENAI_BASE_URL|OPENAI_API_BASE|CODEX_SANDBOX|CODEX_SANDBOX_NETWORK_DISABLED|CODEX_THREAD_ID|CODEX_INTERNAL_ORIGINATOR_OVERRIDE|ELECTRON_RUN_AS_NODE|ROSALENA_ROUTER_TOKEN)$/i.test(k)),
  );
}

const runText = (exe, args) =>
  new Promise((resolve) => {
    const launch = launchFor(exe);
    const argv = [...launch.prefix, ...args];
    execFile(
      launch.command,
      launch.shell ? argv.map(cmdQuote) : argv,
      { encoding: "utf8", windowsHide: true, timeout: 20_000, env: { ...codexEnv(), ...launch.env }, shell: launch.shell },
      (err, stdout, stderr) => resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }),
    );
  });

/**
 * What `codex login status` printed (codex-rs/cli/src/login.rs: it writes to stderr and
 * exits 0 when signed in, 1 when not): {loggedIn, authMethod}. authMethod is "chatgpt"
 * (the ChatGPT plan), "api-key", or another sign-in Codex names. The masked key it prints
 * for an API-key login is never kept.
 */
export function parseLoginStatus({ code = 1, stdout = "", stderr = "" } = {}, env = {}) {
  const text = `${stdout}\n${stderr}`;
  let authMethod = null;
  if (/Logged in using ChatGPT/i.test(text)) authMethod = "chatgpt";
  else if (/API key configured/i.test(text)) authMethod = "api-key";
  else if (/Logged in using personal access token/i.test(text)) authMethod = "personal-access-token";
  else if (/Logged in using access token/i.test(text)) authMethod = "access-token";
  else if (/Logged in using workload identity/i.test(text)) authMethod = "workload-identity";
  else if (/Logged in using Amazon Bedrock/i.test(text)) authMethod = "bedrock";
  let loggedIn = code === 0 && authMethod !== null;
  // `codex exec` also answers with a key in CODEX_API_KEY, which `login status` does not
  // look at (it loads stored auth only).
  if (!loggedIn && String(env.CODEX_API_KEY ?? "").trim()) {
    loggedIn = true;
    authMethod = "api-key (CODEX_API_KEY)";
  }
  return { loggedIn, authMethod: loggedIn ? authMethod : null };
}

let statusCache = { at: 0, exe: null, value: null };

/**
 * Is Codex here and signed in? {found, exe, version, loggedIn, authMethod}. Cached 5 min,
 * and asynchronous, like claudeCodeStatus.
 */
export async function codexStatus({ fresh = false, run = runText, exe = findCodex(), env = process.env } = {}) {
  if (!fresh && statusCache.value && statusCache.exe === exe && Date.now() - statusCache.at < 5 * 60_000) return statusCache.value;
  let value = { found: false, exe: null, version: null, loggedIn: false, authMethod: null };
  if (exe) {
    const [version, auth] = await Promise.all([run(exe, ["--version"]), run(exe, ["login", "status"])]);
    // `codex --version` prints "codex-cli 0.167.0".
    const v = /\d+\.\d+\.\d+[\w.+-]*/.exec(`${version.stdout ?? ""} ${version.stderr ?? ""}`);
    value = { found: true, exe, version: v ? v[0] : null, ...parseLoginStatus(auth, env) };
  }
  statusCache = { at: Date.now(), exe, value };
  return value;
}

/**
 * Rosalena's Access -> Codex's sandbox and approval settings. `codex exec` never asks for
 * approval by default (approval_policy "never": a refused command's failure goes back to
 * the model), so Access picks the sandbox:
 *   read (or plan mode) -> read-only sandbox
 *   workspace           -> workspace-write (edits and commands inside the workspace)
 *   auto                -> --approve-for-me: workspace-write, and anything past it goes to
 *                          Codex's automatic reviewer (approval_policy on-request)
 *   full                -> danger-full-access (no sandbox, never asks)
 */
export function accessFor({ accessMode = "workspace", planMode = false } = {}) {
  if (planMode || accessMode === "read") return { sandbox: "read-only", approval: "never", args: ["--sandbox", "read-only"] };
  if (accessMode === "full") return { sandbox: "danger-full-access", approval: "never", args: ["--sandbox", "danger-full-access"] };
  if (accessMode === "auto") return { sandbox: "workspace-write", approval: "on-request (auto review)", args: ["--approve-for-me"] };
  return { sandbox: "workspace-write", approval: "never", args: ["--sandbox", "workspace-write"] };
}

/** The level sent to Codex: the picked one if this model takes it; Ultracode asks for `ultra`. */
export function effortFor(model, effort = "", { ultracode = false } = {}) {
  const row = rowFor(model);
  const levels = row?.levels ?? [];
  if (ultracode && row && row.alias !== "default" && levels.includes("ultra")) return "ultra";
  const level = String(effort ?? "");
  return levels.includes(level) ? level : "";
}

const tomlString = (text) => JSON.stringify(String(text));

export function codexArgs({ model, session = null, access, root, effort = "", developerInstructions = "", addDirs = [], images = [] }) {
  const alias = String(model ?? "").slice(ENGINE_PREFIX.length);
  // Every option before `resume`: it is a subcommand, and the SDK puts it last too.
  const argv = ["exec", "--json", "--skip-git-repo-check"];
  if (root) argv.push("--cd", root);
  argv.push(...(access?.args ?? accessFor().args));
  if (alias && alias !== "default") argv.push("-m", alias);
  if (effort) argv.push("-c", `model_reasoning_effort=${tomlString(effort)}`);
  if (developerInstructions) argv.push("-c", `developer_instructions=${tomlString(developerInstructions)}`);
  for (const dir of addDirs) argv.push("--add-dir", dir);
  if (session) argv.push("resume", session);
  // Last: the top-level --image takes several values and would swallow what followed it.
  for (const image of images) argv.push("--image", image);
  return argv;
}

const clip = (text, n) => {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const mcpText = (result) =>
  Array.isArray(result?.content) ? result.content.map((p) => (p?.type === "text" ? p.text : p?.type ? `[${p.type}]` : "")).join("\n") : "";

/**
 * Turn Codex's `exec --json` lines into Rosalena events. Stateful: one per run.
 * Returns { feed(line) -> events[], result() }.
 */
export function createTranslator({ model, describe = "" }) {
  let step = 0;
  let toolSinceMessage = false;
  let session = null;
  let usage = null;
  let failed = null;
  let lastError = null;
  let lastText = "";
  let tools = 0;
  const started = new Map(); // item id -> Date.now()
  const declined = [];
  const target = model;

  const toolStep = () => {
    if (step === 0) step = 1;
    toolSinceMessage = true;
    tools += 1;
    return step;
  };

  const toolEvent = (item) => {
    const at = started.get(item.id) ?? Date.now();
    started.delete(item.id);
    const ms = Date.now() - at;
    switch (item.type) {
      case "command_execution": {
        if (item.status === "declined") declined.push(item.command);
        const ok = item.status === "completed" && (item.exit_code === 0 || item.exit_code == null);
        return { type: "tool", step: toolStep(), name: "shell", args: { command: item.command }, ok, ms, preview: clip(item.aggregated_output ?? (item.status === "declined" ? "declined" : ""), 300) };
      }
      case "file_change": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return { type: "tool", step: toolStep(), name: "apply_patch", args: { changes }, ok: item.status === "completed", ms, preview: clip(changes.map((c) => `${c.kind} ${c.path}`).join("\n"), 300) };
      }
      case "mcp_tool_call":
        return {
          type: "tool",
          step: toolStep(),
          name: `${item.server}.${item.tool}`,
          args: item.arguments ?? {},
          ok: item.status === "completed" && !item.error,
          ms,
          preview: clip(item.error?.message ?? mcpText(item.result), 300),
        };
      case "web_search":
        return { type: "tool", step: toolStep(), name: "web_search", args: { query: item.query }, ok: true, ms, preview: clip(Array.isArray(item.results) ? `${item.results.length} result(s)` : "", 300) };
      case "collab_tool_call":
        return { type: "tool", step: toolStep(), name: `collab.${item.tool}`, args: { prompt: item.prompt ?? null, receivers: item.receiver_thread_ids ?? [] }, ok: item.status === "completed", ms, preview: "" };
      default:
        return null;
    }
  };

  const feed = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    const out = [];
    switch (msg.type) {
      case "thread.started":
        session = msg.thread_id ?? session;
        out.push({ type: "notice", from: [ENGINE_ID], text: `Codex on ${describe || "its default model"}` });
        break;
      case "turn.started":
        break;
      case "turn.completed":
        usage = msg.usage ?? usage ?? {};
        break;
      case "turn.failed":
        failed = String(msg.error?.message ?? "turn failed");
        break;
      case "error":
        lastError = String(msg.message ?? "Codex reported an error");
        break;
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = msg.item ?? {};
        if (msg.type === "item.started" && item.id) started.set(item.id, Date.now());
        if (item.type === "todo_list" && msg.type !== "item.updated") {
          const items = Array.isArray(item.items) ? item.items : [];
          if (items.length) out.push({ type: "notice", from: [ENGINE_ID], text: `Plan: ${items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("  ")}` });
          break;
        }
        if (msg.type !== "item.completed") break;
        if (item.type === "agent_message") {
          const text = String(item.text ?? "");
          if (!text.trim()) break;
          if (step === 0 || toolSinceMessage) step += 1;
          toolSinceMessage = false;
          lastText = text;
          // Codex's JSON stream sends a message whole, not in pieces: one delta, then the message.
          out.push({ type: "delta", step, text });
          out.push({ type: "assistant", step, content: text, target, toolCalls: 0 });
        } else if (item.type === "reasoning") {
          if (String(item.text ?? "").trim()) out.push({ type: "notice", from: [ENGINE_ID], text: `Thinking: ${clip(item.text, 300)}` });
        } else if (item.type === "error") {
          out.push({ type: "notice", from: [ENGINE_ID], text: clip(item.message, 500) });
        } else {
          const event = toolEvent(item);
          if (event) out.push(event);
        }
        break;
      }
      default:
        break;
    }
    return out;
  };

  const result = () => ({ session, usage, failed, lastError, lastText, steps: step, tools, declined });
  return { feed, result };
}

/**
 * This run's own share of the thread's usage. `turn.completed` carries the thread's
 * running total (codex-rs/exec: usage_from_last_total), so after a resume the previous
 * run's total is taken off; a total smaller than the previous one is this run's alone.
 */
export function runUsage(total, previous = null) {
  const n = (v) => Number(v) || 0;
  const t = { input: n(total?.input_tokens), cached: n(total?.cached_input_tokens), output: n(total?.output_tokens), reasoning: n(total?.reasoning_output_tokens) };
  const p = previous ? { input: n(previous.input_tokens), cached: n(previous.cached_input_tokens), output: n(previous.output_tokens), reasoning: n(previous.reasoning_output_tokens) } : null;
  if (!p || t.input < p.input || t.output < p.output) return t;
  return { input: t.input - p.input, cached: Math.max(0, t.cached - p.cached), output: t.output - p.output, reasoning: Math.max(0, t.reasoning - p.reasoning) };
}

/** The usage tally (usage.mjs shape). A ChatGPT plan has no per-call price: usd is null. */
export function usageFrom(own, model) {
  const tally = createUsageTally();
  if (!own) return tally.snapshot();
  // OpenAI's input count already includes the cached part; reasoning is part of output.
  tally.add({ prompt_tokens: own.input, completion_tokens: own.output, prompt_tokens_details: { cached_tokens: own.cached } }, { kind: ENGINE_ID, target: model, usd: null });
  return tally.snapshot();
}

/**
 * The context meter for a Codex chat (the shape context.mjs measures). Codex's JSON stream
 * gives the turn's input tokens summed over its model calls, not the last call's, so the
 * prompt is estimated as their average (one call per tool round, plus the answer).
 */
export function contextFrom(own, { model, tools = 0 } = {}) {
  if (!own) return null;
  const window = rowFor(model)?.contextMax ?? CODEX_MODELS[0].contextMax;
  const used = Math.min(window, Math.round(own.input / Math.max(1, tools + 1)));
  return { window, used, percent: Math.round((used / window) * 100), parts: { system: 0, tools: 0, messages: used }, source: "estimate", threshold: null };
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

const NOT_SIGNED_IN = "Codex isn't signed in: run `codex login` in a terminal (it opens a ChatGPT sign-in), then send this again.";
const looksUnsigned = (text) => /not logged in|codex login|unauthori[sz]ed|\b401\b|authenticat|sign in again|no auth|refresh token/i.test(String(text ?? ""));

/**
 * One message, answered by Codex. Resolves with runClaudeCode's shape (answer, error,
 * stopped, steps, ms, run, runFile, usage, engine, session) plus `contextMeter` and
 * `engineTotals` (the thread's running usage total, which the next run subtracts).
 */
export function runCodex({
  task,
  model = `${ENGINE_PREFIX}default`,
  root = process.cwd(),
  runId,
  runsDir,
  onEvent = () => {},
  accessMode = "workspace",
  planMode = false,
  session = null,
  previousTotals = null,
  appendSystemPrompt = "",
  addDirs = [],
  images = [],
  effort = "",
  ultracode = false,
  maxWallMs = Infinity,
  exe = findCodex(),
  spawnImpl = spawn,
}) {
  const started = Date.now();
  const store = openRun({ dir: runsDir, id: runId, meta: { task, root, cls: model, depth: 0 } });
  const id = store.id ?? runId;
  const emit = (event) => {
    const e = { ...event };
    store.event(e);
    onEvent(e);
  };
  emit({ type: "run", id, depth: 0, cls: model, parent: null, root, task, engine: ENGINE_ID });

  const finish = (fields) => {
    const result = { answer: "", steps: 0, ms: Date.now() - started, target: model, engine: ENGINE_ID, ...fields };
    emit({ type: "run_end", run: id, stopped: result.stopped ?? (result.error ? "error" : null), steps: result.steps });
    const record = store.finish(result);
    return { ...result, run: id, runFile: store.recordFile ?? null, record };
  };

  if (!exe) {
    const error = "Codex is not installed on this PC. Install it with `npm install -g @openai/codex`, run `codex login` once, then pick Codex again.";
    emit({ type: "error", message: error });
    return Promise.resolve(finish({ error }));
  }

  const access = accessFor({ accessMode, planMode });
  const level = effortFor(model, effort, { ultracode });
  const argv = codexArgs({ model, session, access, root, effort: level, developerInstructions: appendSystemPrompt, addDirs, images });
  const row = rowFor(model);
  const describe = `${row && row.alias !== "default" ? row.alias : "its default model"}${level ? `, ${level} effort` : ""} (${access.sandbox} sandbox, approvals ${access.approval})`;
  const translator = createTranslator({ model, describe });
  // Plan mode has no switch in `codex exec`: the read-only sandbox keeps it from changing
  // anything, and the task says what is wanted back.
  const prompt = planMode ? `Plan mode: investigate only and change nothing. Answer with a step-by-step plan for this task.\n\n${task}` : String(task ?? "");

  return new Promise((resolveRun) => {
    let child;
    const launch = launchFor(exe);
    const fullArgs = [...launch.prefix, ...argv];
    try {
      child = spawnImpl(launch.command, launch.shell ? fullArgs.map(cmdQuote) : fullArgs, {
        cwd: root,
        env: { ...codexEnv(), ...launch.env },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        shell: launch.shell,
      });
    } catch (err) {
      const error = `Codex did not start: ${err?.message ?? err}`;
      emit({ type: "error", message: error });
      resolveRun(finish({ error }));
      return;
    }
    let buf = "";
    let stderr = "";
    let stopped = null;
    let settled = false;
    const onLine = (line) => {
      if (!line.trim()) return;
      for (const event of translator.feed(line)) emit(event);
    };
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.stdin?.on("error", () => {
      /* Codex ended before reading its prompt: the close handler says why */
    });
    child.stdin?.end(prompt);
    // Stop is the run store's cancel flag (POST /api/cancel), as for Claude Code.
    const watch = setInterval(() => {
      if (runsDir && cancelRequested({ dir: runsDir, id })) {
        stopped = "cancelled";
        killTree(child);
      } else if (Date.now() - started > maxWallMs) {
        stopped = "time";
        killTree(child);
      }
    }, 500);
    child.on("error", (err) => {
      clearInterval(watch);
      if (settled) return;
      settled = true;
      const error = `Codex did not start: ${err?.message ?? err}`;
      emit({ type: "error", message: error });
      resolveRun(finish({ error }));
    });
    child.on("close", (code) => {
      clearInterval(watch);
      if (settled) return;
      settled = true;
      if (buf.trim()) onLine(buf);
      const r = translator.result();
      if (r.declined.length) {
        const names = [...new Set(r.declined.map((c) => clip(c, 60)))].slice(0, 6);
        emit({ type: "notice", from: [ENGINE_ID], text: `Codex was not allowed to run: ${names.join(", ")}. Set Access to Full to let it run commands outside the workspace sandbox.` });
      }
      const own = r.usage ? runUsage(r.usage, previousTotals) : null;
      const usage = usageFrom(own, model);
      const contextMeter = contextFrom(own, { model, tools: r.tools });
      if (contextMeter) emit({ type: "ui/context", phase: "final", ...contextMeter });
      let error = null;
      if (stopped) error = null;
      else if (r.failed || !r.usage) {
        const said = [r.failed, r.lastError, stderr].filter(Boolean).join("\n");
        const last = r.failed ?? r.lastError ?? stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit ${code}`;
        error = looksUnsigned(said) ? NOT_SIGNED_IN : `Codex ended without an answer: ${clip(last, 500)}`;
      }
      if (error) emit({ type: "error", message: error });
      resolveRun(
        finish({
          answer: error ? "" : r.lastText,
          error,
          stopped,
          steps: r.steps,
          usage,
          contextMeter,
          session: r.session ?? session,
          engineTotals: r.usage ?? null,
        }),
      );
    });
  });
}
