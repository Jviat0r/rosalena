/**
 * Claude Code as an engine behind Rosalena's window (design: docs/research/claude-engine-2026-11.md).
 *
 * A chat whose model is `claude-code/<alias>` is not run by Rosalena's own loop. It starts
 * the person's own installed Claude Code - the unmodified binary the Claude desktop app
 * ships - headless, once per message:
 *
 *   claude -p <task> --output-format stream-json --verbose --include-partial-messages
 *          --permission-mode <from Rosalena's Access> [--resume <session>] [--model <alias>]
 *          [--mcp-config <SolBrowser, lent>] [--append-system-prompt <role>] [--add-dir <attachments>]
 *
 * and turns its stream into the events Rosalena's window already draws (run, delta,
 * assistant, tool, notice, run_end), in Rosalena's own run store, so history, follow-ups,
 * the queue, branching and usage tracking work the same. Claude Code keeps its own loop,
 * model, compaction and sign-in.
 *
 * Rosalena never asks for, reads or stores a Claude login: whatever Claude Code is signed
 * in with (claude.ai or the person's API key) is what answers. Anthropic does not allow a
 * third-party app to offer "Sign in with Claude" or route other people's subscriptions,
 * which is why the only thing this module does with auth is ask `claude auth status`
 * whether it is signed in at all.
 */

import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cancelRequested, openRun } from "./runs.mjs";
import { createUsageTally } from "./usage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENGINE_PREFIX = "claude-code/";
export const isClaudeCodeModel = (model) => String(model ?? "").startsWith(ENGINE_PREFIX);

/** The picker's rows. `default` passes no --model: Claude Code's own default answers. */
export const CLAUDE_CODE_MODELS = Object.freeze([
  { alias: "default", label: "Claude Code (its default model)", contextMax: 1_048_576 },
  { alias: "opus", label: "Claude Code - Opus", contextMax: 1_048_576 },
  { alias: "sonnet", label: "Claude Code - Sonnet", contextMax: 1_048_576 },
  { alias: "haiku", label: "Claude Code - Haiku", contextMax: 200_000 },
]);

/** The levels `claude --effort` takes, and the one Claude Code uses when none is passed. */
export const CLAUDE_CODE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const CLAUDE_CODE_DEFAULT_EFFORT = "medium";
/** Past this window, an alias with a native 1M variant is asked for it (`opus[1m]`). */
export const CLAUDE_CODE_STANDARD_WINDOW = 200_000;

/** The --model value for an alias at a context window: the [1m] variant past 200K. */
export function claudeModelArg(alias, contextWindow = 0) {
  const name = String(alias ?? "");
  const long = Number(contextWindow) > CLAUDE_CODE_STANDARD_WINDOW;
  if (!long) return name && name !== "default" ? name : "";
  if (name === "opus" || name === "sonnet") return `${name}[1m]`;
  if (name === "" || name === "default") return "opus[1m]";
  return name; // haiku has no 1M variant: its own window answers
}

export function menuRows() {
  return CLAUDE_CODE_MODELS.map((m) => ({
    id: `${ENGINE_PREFIX}${m.alias}`,
    label: m.label,
    provider: "claude-code",
    model: m.alias,
    source: "claude-code",
    kind: "chat",
    chat: true,
    efforts: [...CLAUDE_CODE_EFFORTS],
    defaultEffort: CLAUDE_CODE_DEFAULT_EFFORT,
    contextMax: m.contextMax,
    note: "Your own Claude Code, with the sign-in it already has. Rosalena is the window; Claude Code runs the work.",
  }));
}

/**
 * Where the Windows desktop app keeps Claude Code since late 2026:
 * %LOCALAPPDATA%\Claude-Data\claude_<package id>\claude-code\<version>\<hash>\claude.exe.
 * Every `claude*` folder under Claude-Data is tried, so a new package id is still found.
 */
function claudeDataRoots(env, exists, list) {
  const base = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Claude-Data") : "";
  if (!base || !exists(base)) return [];
  let names = [];
  try {
    names = list(base).filter((name) => /^claude/i.test(name));
  } catch {
    return [];
  }
  // The known package first, then any other.
  names.sort((a, b) => (a === "claude_pzs8sxrjxfjjc" ? -1 : b === "claude_pzs8sxrjxfjjc" ? 1 : a.localeCompare(b)));
  return names.map((name) => join(base, name, "claude-code"));
}

/**
 * The newest Claude Code on this machine: the desktop app's copy (its Claude-Data folder,
 * then the older MSIX and plain folders), then `claude` on PATH. Null when there is none.
 */
export function findClaudeCode({ env = process.env, platform = process.platform, exists = existsSync, list = readdirSync } = {}) {
  if (env.ROSALENA_CLAUDE_EXE) return exists(env.ROSALENA_CLAUDE_EXE) ? env.ROSALENA_CLAUDE_EXE : null;
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const roots = [
    ...claudeDataRoots(env, exists, list),
    join(env.LOCALAPPDATA ?? "", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude-code"),
    join(env.APPDATA ?? "", "Claude", "claude-code"),
    join(env.HOME ?? homedir(), "Library", "Application Support", "Claude", "claude-code"),
  ];
  for (const root of roots) {
    if (!root || !exists(root)) continue;
    let versions = [];
    try {
      versions = list(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      let inner = [];
      try {
        inner = list(join(root, v));
      } catch {
        continue;
      }
      for (const name of inner) {
        const candidate = join(root, v, name, exe);
        if (exists(candidate)) return candidate;
      }
      if (exists(join(root, v, exe))) return join(root, v, exe);
    }
  }
  for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The environment Claude Code gets: this process's, minus what a parent Claude Code session
 * sets (CLAUDECODE, CLAUDE_CODE_*) and a session's ANTHROPIC_BASE_URL, so it answers with
 * its own sign-in rather than another session's plumbing. A person's own ANTHROPIC_API_KEY
 * is theirs and stays.
 */
export function claudeEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_.*|ANTHROPIC_BASE_URL|ELECTRON_RUN_AS_NODE)$/i.test(k)));
}

let statusCache = { at: 0, exe: null, value: null };

const runText = (exe, args) =>
  new Promise((resolve) => {
    execFile(exe, args, { encoding: "utf8", windowsHide: true, timeout: 20_000, env: claudeEnv() }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? "") }));
  });

/**
 * Is Claude Code here and signed in? {found, exe, version, loggedIn, authMethod}. Cached
 * 5 min, and asynchronous: two Claude Code starts take a second or two, which the window's
 * server must not stand still for.
 */
export async function claudeCodeStatus({ fresh = false, run = runText, exe = findClaudeCode() } = {}) {
  if (!fresh && statusCache.value && statusCache.exe === exe && Date.now() - statusCache.at < 5 * 60_000) return statusCache.value;
  let value = { found: false, exe: null, version: null, loggedIn: false, authMethod: null };
  if (exe) {
    const [version, auth] = await Promise.all([run(exe, ["--version"]), run(exe, ["auth", "status"])]);
    let parsed = null;
    try {
      parsed = JSON.parse(String(auth.stdout ?? "").trim());
    } catch {
      /* an older build without JSON: treat as unknown */
    }
    // The account's email is in that answer too; it is not kept or passed on.
    value = {
      found: true,
      exe,
      version: String(version.stdout ?? "").trim().split(/\s/)[0] || null,
      loggedIn: parsed?.loggedIn === true,
      authMethod: parsed?.authMethod ?? null,
    };
  }
  statusCache = { at: Date.now(), exe, value };
  return value;
}

/** Rosalena's Access choice -> Claude Code's permission mode. */
export function permissionModeFor({ accessMode = "workspace", planMode = false } = {}) {
  if (planMode || accessMode === "read") return "plan";
  if (accessMode === "full") return "bypassPermissions";
  if (accessMode === "auto") return "auto";
  return "acceptEdits";
}

/** SolBrowser, lent to Claude Code as an MCP server, unless the person already has one by that name. */
export function solBrowserMcp({ home = homedir(), exists = existsSync, read = readFileSync } = {}) {
  const bundle = join(HERE, "..", "plugins", "rosa-solbrowser", "vendor", "bundle", "server.mjs");
  if (!exists(bundle)) return null;
  try {
    const config = JSON.parse(read(join(home, ".claude.json"), "utf8"));
    if (config?.mcpServers?.solbrowser) return null;
  } catch {
    /* no Claude config, or unreadable: lend it */
  }
  return { mcpServers: { solbrowser: { command: process.execPath, args: [bundle], env: { ELECTRON_RUN_AS_NODE: "1", SOLBROWSER_ALLOW_EVAL: "0" } } } };
}

export function claudeArgs({ task, model, session = null, permissionMode, mcp = null, appendSystemPrompt = "", addDirs = [], effort = "", contextWindow = 0 }) {
  const alias = String(model ?? "").slice(ENGINE_PREFIX.length);
  // The task right after -p: --mcp-config and --add-dir take several values each, and a
  // task placed after them is read as one more of those (bench/run.mjs learned this).
  const argv = ["-p", task, "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", permissionMode];
  if (session) argv.push("--resume", session);
  const modelArg = claudeModelArg(alias, contextWindow);
  if (modelArg) argv.push("--model", modelArg);
  if (CLAUDE_CODE_EFFORTS.includes(String(effort))) argv.push("--effort", String(effort));
  if (appendSystemPrompt) argv.push("--append-system-prompt", appendSystemPrompt);
  if (mcp) argv.push("--mcp-config", JSON.stringify(mcp));
  for (const dir of addDirs) argv.push("--add-dir", dir);
  return argv;
}

const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (p?.type === "text" ? p.text : p?.type ? `[${p.type}]` : "")).join("\n") : "";

/**
 * Turn Claude Code's stream-json lines into Rosalena events. Stateful: one per run.
 * Returns { feed(line) -> events[], result() }.
 */
export function createTranslator({ model, contextWindow = 0 }) {
  let step = 0;
  let messageId = null;
  let session = null;
  let final = null;
  let lastText = "";
  let meter = null;
  const pending = new Map(); // tool_use_id -> { name, args, at, sub }
  const denials = [];
  const target = model;
  // The window Claude Code runs this chat in: the [1m] variant when one was asked for
  // (claudeModelArg), otherwise the alias's own window capped at the standard 200K.
  const alias = String(model ?? "").slice(ENGINE_PREFIX.length) || "default";
  const row = CLAUDE_CODE_MODELS.find((m) => m.alias === alias);
  const window = /\[1m\]$/.test(claudeModelArg(alias, contextWindow)) ? (row?.contextMax ?? 1_048_576) : Math.min(row?.contextMax ?? CLAUDE_CODE_STANDARD_WINDOW, CLAUDE_CODE_STANDARD_WINDOW);
  // One reading per model call, from the usage Claude Code reports at its start: the
  // whole prompt it sent (fresh + cache read + cache written). Same event the loop emits,
  // so the composer gauge and the session rail read Claude Code chats too.
  const reading = (usage) => {
    const used = (Number(usage?.input_tokens) || 0) + (Number(usage?.cache_read_input_tokens) || 0) + (Number(usage?.cache_creation_input_tokens) || 0);
    if (!used || !window) return null;
    meter = { window, used, percent: Math.round((used / window) * 1000) / 10, parts: { system: 0, tools: 0, messages: used }, source: "provider" };
    return { type: "ui/context", phase: "step", step: Math.max(step, 1), ...meter };
  };

  const feed = (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    const out = [];
    const sub = Boolean(msg.parent_tool_use_id);
    if (msg.session_id) session = msg.session_id;
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") out.push({ type: "notice", from: ["claude-code"], text: `Claude Code ${msg.claude_code_version ?? ""} on ${msg.model ?? "its default model"} (${msg.permissionMode ?? "default"} permissions)`.replace(/\s+/g, " ") });
        else if (msg.subtype === "compact_boundary") out.push({ type: "notice", from: ["claude-code"], text: "Claude Code compacted the conversation" });
        break;
      case "stream_event": {
        if (sub) break;
        const ev = msg.event ?? {};
        if (ev.type === "message_start") {
          const id = ev.message?.id ?? null;
          if (id !== messageId) {
            messageId = id;
            step += 1;
          }
          const ctx = reading(ev.message?.usage);
          if (ctx) out.push(ctx);
        } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          out.push({ type: "delta", step: Math.max(step, 1), text: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        const m = msg.message ?? {};
        if (!sub && m.id && m.id !== messageId) {
          messageId = m.id;
          step += 1;
        }
        const blocks = Array.isArray(m.content) ? m.content : [];
        const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");
        for (const b of blocks) {
          if (b?.type === "tool_use") pending.set(b.id, { name: b.name, args: b.input ?? {}, at: Date.now(), sub, step: Math.max(step, 1) });
        }
        if (!sub && text.trim()) {
          lastText = text;
          out.push({ type: "assistant", step: Math.max(step, 1), content: text, target, toolCalls: blocks.filter((b) => b?.type === "tool_use").length || 0 });
        }
        break;
      }
      case "user": {
        const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
        for (const b of blocks) {
          if (b?.type !== "tool_result") continue;
          const call = pending.get(b.tool_use_id) ?? { name: "tool", args: {}, at: Date.now(), sub, step: Math.max(step, 1) };
          pending.delete(b.tool_use_id);
          out.push({ type: "tool", step: call.step, name: call.name, args: call.args, ok: b.is_error !== true, ms: Date.now() - call.at, preview: textOf(b.content).slice(0, 300), ...(call.sub ? { sub: true } : {}) });
        }
        break;
      }
      case "result":
        final = msg;
        for (const d of Array.isArray(msg.permission_denials) ? msg.permission_denials : []) denials.push(d);
        break;
      default:
        break;
    }
    return out;
  };

  const result = () => ({ final, session, steps: step, lastText, denials, meter });
  return { feed, result };
}

/** The usage tally (usage.mjs shape) from Claude Code's result message. */
export function usageFrom(final, model) {
  const tally = createUsageTally();
  if (!final) return tally.snapshot();
  const u = final.usage ?? {};
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheMade = Number(u.cache_creation_input_tokens) || 0;
  tally.add(
    { prompt_tokens: (Number(u.input_tokens) || 0) + cacheRead + cacheMade, completion_tokens: Number(u.output_tokens) || 0, prompt_tokens_details: { cached_tokens: cacheRead } },
    { kind: "claude-code", target: Object.keys(final.modelUsage ?? {})[0] ? `claude-code/${Object.keys(final.modelUsage)[0]}` : model, usd: Number.isFinite(final.total_cost_usd) ? final.total_cost_usd : null },
  );
  return tally.snapshot();
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

/**
 * One message, answered by Claude Code. Resolves with the shape runAgent's result has
 * (answer, error, stopped, steps, ms, run, runFile, usage) plus `engine` and `session`
 * (Claude Code's session id, which the next message resumes).
 */
export function runClaudeCode({
  task,
  model = `${ENGINE_PREFIX}default`,
  root = process.cwd(),
  runId,
  runsDir,
  onEvent = () => {},
  accessMode = "workspace",
  planMode = false,
  session = null,
  appendSystemPrompt = "",
  addDirs = [],
  effort = "",
  contextWindow = 0,
  maxWallMs = Infinity,
  exe = findClaudeCode(),
  spawnImpl = spawn,
  lendSolBrowser = true,
}) {
  const started = Date.now();
  const store = openRun({ dir: runsDir, id: runId, meta: { task, root, cls: model, depth: 0 } });
  const id = store.id ?? runId;
  const emit = (event) => {
    const e = { ...event };
    store.event(e);
    onEvent(e);
  };
  emit({ type: "run", id, depth: 0, cls: model, parent: null, root, task, engine: "claude-code" });

  const finish = (fields) => {
    const result = { answer: "", steps: 0, ms: Date.now() - started, target: model, engine: "claude-code", ...fields };
    emit({ type: "run_end", run: id, stopped: result.stopped ?? (result.error ? "error" : null), steps: result.steps });
    const record = store.finish(result);
    return { ...result, run: id, runFile: store.recordFile ?? null, record };
  };

  if (!exe) {
    const error = "Claude Code is not installed on this PC. Install the Claude desktop app (it ships Claude Code), sign in to it, then pick Claude Code again.";
    emit({ type: "error", message: error });
    return Promise.resolve(finish({ error }));
  }

  const permissionMode = permissionModeFor({ accessMode, planMode });
  const mcp = lendSolBrowser ? solBrowserMcp() : null;
  const argv = claudeArgs({ task, model, session, permissionMode, mcp, appendSystemPrompt, addDirs, effort, contextWindow });
  const translator = createTranslator({ model, contextWindow });

  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawnImpl(exe, argv, { cwd: root, env: claudeEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const error = `Claude Code did not start: ${err?.message ?? err}`;
      emit({ type: "error", message: error });
      resolveRun(finish({ error }));
      return;
    }
    let buf = "";
    let stderr = "";
    let stopped = null;
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
    // Stop is a flag in the run store (POST /api/cancel), the same one Rosalena's loop
    // checks; here it ends the Claude Code process.
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
      const error = `Claude Code did not start: ${err?.message ?? err}`;
      emit({ type: "error", message: error });
      resolveRun(finish({ error }));
    });
    child.on("close", (code) => {
      clearInterval(watch);
      if (buf.trim()) onLine(buf);
      const { final, session: newSession, steps, lastText, denials, meter } = translator.result();
      if (denials.length) {
        const names = [...new Set(denials.map((d) => `${d.tool_name}${d.tool_input?.command ? `(${String(d.tool_input.command).slice(0, 60)})` : ""}`))].slice(0, 6);
        emit({ type: "notice", from: ["claude-code"], text: `Claude Code was not allowed to run: ${names.join(", ")}. With Access on Workspace it may edit files but not run commands without asking; set Access to Auto or Full to let it.` });
      }
      const usage = usageFrom(final, model);
      const answer = String(final?.result ?? lastText ?? "");
      let error = null;
      if (stopped) error = null;
      else if (!final) {
        const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop() ?? `exit ${code}`;
        error = /not logged in|please run .*login|\/login/i.test(stderr)
          ? "Claude Code is not signed in. Open the Claude desktop app and sign in (or run `claude auth login` in a terminal), then send this again."
          : `Claude Code ended without an answer: ${last}`;
      } else if (final.is_error) error = String(final.result ?? final.subtype ?? "Claude Code reported an error");
      if (error) emit({ type: "error", message: error });
      resolveRun(
        finish({
          answer: error ? "" : answer,
          error,
          stopped: stopped ?? (final?.subtype && final.subtype !== "success" ? final.subtype : null),
          steps: final?.num_turns ?? steps,
          usage,
          // The last reading, so /api/context answers for this chat after a restart too.
          contextMeter: meter,
          session: newSession,
          claude: final ? { durationApiMs: final.duration_api_ms ?? null, costUsd: final.total_cost_usd ?? null, denials: denials.length } : null,
        }),
      );
    });
  });
}
