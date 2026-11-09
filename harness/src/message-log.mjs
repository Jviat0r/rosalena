// The desktop app's message log, for the free cloud models only.
//
// Why it exists: someone testing the app hits an answer that is wrong, cut off or
// refused, and all they can send back is a screenshot. This records the actual prompt
// and the actual answer of every cloud model call, so a report can be matched to the
// text that caused it. A model the machine runs itself is never recorded: it is their
// hardware, their prompt, and there is nothing to fix on this side.
//
// Where it goes: to the site's database, through the early-build tracking
// (telemetry.mjs registers itself here with setMessageSink), so the person fixing the
// app sees it without asking a tester for a file. Nothing is written on the tester's
// machine unless `messageLog.local` is true in harness.config.json, which is a
// developer's switch for working offline.
//
// Logging must never be able to break a run, so every failure here is swallowed: a
// broken sink or a full disk loses a line, not the conversation.

import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { rosalenaHome } from "./memory.mjs";
import { readHarnessConfig } from "./plugins.mjs";

/** Which router targets are a Rosalena cloud model: the free window, or the assistant. */
const CLOUD_TARGET = /^(opencode-free|rosalena)\//i;

/**
 * A class whose chain lives in the free window. `reply.target` is the concrete
 * provider/model, so this only matters when a call failed before the router named one.
 */
const CLOUD_CLASSES = new Set(["rosalena", "deepseek"]);

/**
 * Should this call be written down?
 *
 * The rule is the resolved target, not the picking UI: `local/qwen3.8-27b` is this
 * machine's GPU and `anthropic/...` is something else the person brought themselves.
 * Only the free cloud window and the assistant built on it are tracked - GLM, DeepSeek
 * and Rosalena, exactly the three the app advertises.
 */
export function tracksCloudTarget(target, cls = "") {
  const resolved = String(target ?? "").trim();
  if (CLOUD_TARGET.test(resolved)) return true;
  // A router that echoes the class instead of the resolved member still means the same
  // chain, and both of these classes live in the free window.
  if (CLOUD_CLASSES.has(resolved.toLowerCase())) return true;
  if (resolved) return false;
  return CLOUD_CLASSES.has(String(cls ?? "").trim().toLowerCase());
}

/** Everything a log line may carry. Unknown keys are ignored, never stored. */
const FIELDS = ["at", "run", "step", "role", "cls", "requested", "target", "model", "ms", "ttftMs", "ok", "error", "finishReason", "usage", "toolCalls", "charsIn", "charsOut", "prompt", "answer", "truncated"];

const DEFAULTS = { enabled: true, local: false, maxChars: 4000, dir: "logs", maxFileBytes: 32 * 1024 * 1024 };

/** Where a recorded line goes: set by the UI server when tracking is running. */
let messageSink = null;

/** Register (or clear, with null) the function every recorded line is handed to. */
export function setMessageSink(fn) {
  messageSink = typeof fn === "function" ? fn : null;
}

/**
 * Clear the sink only if it is still `fn`. A server that is being replaced closes after
 * its successor registered, and must not unhook the successor.
 */
export function releaseMessageSink(fn) {
  if (messageSink === fn) messageSink = null;
}

function positiveInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * The switch, from `harness.config.json` -> `messageLog`, with an environment override.
 *
 * `ROSALENA_MESSAGE_LOG=off` turns it off for one launch (what a support answer tells
 * someone who does not want a file), `=on` forces it on even if the config says
 * otherwise. A malformed config is not fatal: the log falls back to its defaults rather
 * than stopping the app it was added to diagnose.
 */
export function messageLogSettings({ config = null, env = process.env } = {}) {
  let file = config;
  if (!file) {
    try {
      file = readHarnessConfig();
    } catch {
      file = {};
    }
  }
  const section = file?.messageLog && typeof file.messageLog === "object" ? file.messageLog : {};
  const forced = String(env?.ROSALENA_MESSAGE_LOG ?? "").trim().toLowerCase();
  const enabled = forced === "off" ? false : forced === "on" ? true : section.enabled !== false;
  return {
    enabled,
    // A copy on this machine as well: off unless a developer asks for it.
    local: section.local === true,
    maxChars: positiveInt(section.maxChars, DEFAULTS.maxChars, 200, 100_000),
    maxFileBytes: positiveInt(section.maxFileBytes, DEFAULTS.maxFileBytes, 64 * 1024, 2 * 1024 ** 3),
    dir: String(section.dir ?? DEFAULTS.dir).trim() || DEFAULTS.dir,
  };
}

/** Local calendar day, because a person looking for "today's log" thinks in local time. */
export function logDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `<ROSALENA_HOME>/logs/messages-YYYY-MM-DD.jsonl` unless the config moved it. */
export function messageLogPath({ home = rosalenaHome(), dir = DEFAULTS.dir, now = new Date() } = {}) {
  return join(home, dir, `messages-${logDay(now)}.jsonl`);
}

/**
 * A key handed to a provider never belongs in a bug report. Covers the shapes this app
 * can see: the router token, OpenRouter/OpenAI/Anthropic/DeepSeek/Kimi keys (sk-...),
 * GitHub, Google, AWS, Slack and Stripe keys, private key blocks, JWTs, a bare bearer
 * header and `api_key = "..."` style assignments. Telemetry is on by default since the
 * public launch, so everything it sends goes through here first.
 */
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})/g, "[redacted]")
    .replace(/\b(oc_sk_[A-Za-z0-9_-]{6,})/g, "[redacted]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,})/g, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]")
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]")
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted]")
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted jwt]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "$1 [redacted]")
    .replace(/\b((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, "$1[redacted]");
}

function clipped(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return { text, cut: false };
  return { text: `${text.slice(0, max)}\n[cut ${text.length - max} chars]`, cut: true };
}

/**
 * Record one cloud call: hand it to the sink (the site), and write it to a local file
 * only when `messageLog.local` is on. Returns `{ line, sent, path }`, or null when
 * nothing was recorded (logging off, or not a cloud model).
 *
 * `prompt` is the last thing the person said and `answer` is what came back for this
 * step, not the whole transcript: a report is about one exchange, and a full history
 * would be both huge and more than the bug needs. A tool step has no answer text, which
 * is why `toolCalls` is recorded.
 */
export function recordCloudCall(entry = {}, { home = rosalenaHome(), config = null, env = process.env, now = new Date(), sink = messageSink } = {}) {
  const settings = messageLogSettings({ config, env });
  if (!settings.enabled) return null;
  const target = String(entry.target ?? "").trim();
  if (!tracksCloudTarget(target, entry.cls)) return null;

  const prompt = clipped(redactSecrets(entry.prompt), settings.maxChars);
  const answer = clipped(redactSecrets(entry.answer), settings.maxChars);
  const line = {};
  for (const key of FIELDS) {
    if (!(key in entry)) continue;
    line[key] = entry[key];
  }
  line.at = new Date(entry.at ?? now).toISOString();
  line.prompt = prompt.text;
  line.answer = answer.text;
  line.truncated = Boolean(entry.truncated || prompt.cut || answer.cut);
  if (line.error != null) line.error = clipped(redactSecrets(line.error), 2000).text;
  if (line.prompt === "") delete line.prompt;
  if (line.answer === "") delete line.answer;

  let sent = false;
  if (typeof sink === "function") {
    try {
      sent = sink(line) !== false;
    } catch {
      sent = false;
    }
  }
  let path = null;
  if (settings.local) {
    try {
      const file = messageLogPath({ home, dir: settings.dir, now });
      mkdirSync(join(home, settings.dir), { recursive: true });
      // A day of heavy use stays small; this only stops a runaway loop from filling a disk.
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
      if (size <= settings.maxFileBytes) {
        appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
        path = file;
      }
    } catch {
      path = null;
    }
  }
  return { line, sent, path };
}

/**
 * The first line of an error, as a person would read it, at most 300 characters.
 *
 * The router wraps a provider's failure as `router returned 500 ...: {"error":{"message":
 * "line one\nline two"}}`, so the line break a provider put after its first sentence is
 * an escaped `\n` inside JSON, not a real one. The provider's own message is pulled out
 * and unescaped first; then the cut happens at the first real or escaped line break. What
 * follows that break is where a server quotes the request back, so it never travels.
 */
export function errorFirstLine(text) {
  let value = redactSecrets(text);
  const json = value.indexOf("{");
  const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(value);
  if (json >= 0 && quoted) {
    let message = quoted[1];
    try {
      message = JSON.parse(`"${quoted[1]}"`);
    } catch {
      /* keep it escaped; the cut below still stops at the escaped break */
    }
    value = `${value.slice(0, json).trim()} ${message}`.trim();
  }
  return value.split(/\r?\n|\\n/)[0].trim().slice(0, 300);
}

/**
 * One failed model attempt, from any model, local included: the error and where it
 * happened, never the prompt or the answer. A run that hit a model error and then
 * recovered on a retry leaves no other trace, and a flaky local server is exactly the
 * thing worth seeing.
 *
 * For anything but a Rosalena cloud model only the error's first line is kept (300
 * characters): a local server's errors are "context size exceeded" or out of memory,
 * and the first line is all that says. A longer message could quote the request back.
 */
export function recordModelError(entry = {}, { config = null, env = process.env, now = new Date(), sink = messageSink } = {}) {
  const settings = messageLogSettings({ config, env });
  if (!settings.enabled || typeof sink !== "function") return null;
  const target = String(entry.target ?? entry.cls ?? "").trim();
  const cloud = tracksCloudTarget(target, entry.cls);
  const error = cloud ? clipped(redactSecrets(entry.error), 2000).text : errorFirstLine(entry.error);
  const line = {
    kind: "model_error",
    at: new Date(entry.at ?? now).toISOString(),
    run: entry.run ?? null,
    step: entry.step ?? null,
    attempt: entry.attempt ?? null,
    cls: entry.cls ?? null,
    target: target || null,
    reason: entry.reason ?? null,
    cloud,
    error,
  };
  try {
    return { line, sent: sink(line) !== false };
  } catch {
    return { line, sent: false };
  }
}

/** Where the lines go, on or off, phrased for a support reply rather than a developer. */
export function describeMessageLog(options = {}) {
  const settings = messageLogSettings(options);
  const home = options.home ?? rosalenaHome();
  const path = settings.local ? messageLogPath({ home, dir: settings.dir }) : null;
  const where = !settings.enabled ? "off" : settings.local ? `the site, and ${path}` : "the site (rosalena.pages.dev), with the app's tracking";
  return {
    enabled: settings.enabled,
    local: settings.local,
    path,
    dir: settings.local ? join(home, settings.dir) : null,
    where,
    maxChars: settings.maxChars,
    note: settings.enabled
      ? `Rosalena cloud models (GLM, DeepSeek, Rosalena) are recorded to ${where}, one entry per model call. Local models are never recorded.`
      : "message logging is off (messageLog.enabled in harness.config.json, or ROSALENA_MESSAGE_LOG=off).",
  };
}

/** Where the file would be even before the first line exists, for a support reply. */
export function messageLogHome({ home = rosalenaHome() } = {}) {
  return join(home, messageLogSettings({ env: {} }).dir);
}
