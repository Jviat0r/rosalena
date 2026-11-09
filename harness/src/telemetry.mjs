// Early-build tracking: how many installs exist, which ones are active, what each one
// spends in tokens, and which answers failed or were reported as bad, sent to the site so
// the person building Rosalena can see it without asking a tester for a log file.
//
// Since the public launch (2026-11-09) sharing is ON by default at "full", and turning it
// off is one click: the welcome screen asks once, and Account > Sharing and Settings >
// Advanced keep the switch. The levels:
//
//   full   usage numbers, errors, the model used, plus the task, the answer and a trace of
//          each run on a cloud model (any provider that is not this PC: Rosalena's free
//          models and the person's own keys), the exact prompt and answer of each call on
//          Rosalena's free cloud models, and any answer the person reports. The default.
//   usage  numbers only: runs, steps, tokens, timings, models, errors (no task or answer).
//   off    only the abuse guard: per chat, the token count on Rosalena's free cloud models
//          (the shared free window) with the random install id. No words, no model, nothing
//          about the person's own keys or local models, not even the app-opened ping.
//
// A local model's words are never sent at any level: what runs on the person's own GPU
// stays there (numbers and the first line of an error only). Secrets are scrubbed from
// everything that is sent (redactSecrets in message-log.mjs).
//
// ROSALENA_TELEMETRY=usage|off picks one for a launch (tests, offline work). The rule for
// words is the message log's (message-log.mjs): the person's own GPU is their business,
// the free cloud window is ours to fix.
//
// Sending must never be able to break or slow the app. Events wait in memory and in a
// small outbox file, go out in one batch at most every few seconds, and a failed send
// keeps them for the next try until the outbox cap, after which the oldest are dropped.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { errorFirstLine, redactSecrets, tracksCloudTarget } from "./message-log.mjs";

export const TELEMETRY_ENDPOINT = "https://rosalena.pages.dev/api/telemetry";
export const SHARING_LEVELS = Object.freeze(["full", "usage", "off"]);
export const DEFAULT_SHARING = "full";

/** One stored task or answer, at most this long (the site cuts at the same length). */
export const MAX_TEXT = 4000;
/** Events kept while the site cannot be reached. */
const MAX_OUTBOX = 500;
/** Events per request; the site refuses a bigger batch. */
export const MAX_BATCH = 50;

const clip = (value, max = MAX_TEXT) => {
  const text = redactSecrets(String(value ?? ""));
  return text.length <= max ? text : `${text.slice(0, max)}\n[cut ${text.length - max} chars]`;
};

/**
 * Is the person's own choice honoured? True since the public launch: the welcome question
 * and the switches in Account and Settings > Advanced are shown, so turning sharing off is
 * one click. (0.1.5 to 0.1.14 forced "full" with the switch hidden, for early access.)
 */
export const SHARING_IS_OPTIONAL = true;

/** What is sent before the person has chosen: the full default (they can turn it off). */
export const UNCHOSEN_SHARING = "full";

/** A run's target is cloud unless it is this PC's own model server. */
export function isCloudTarget(target) {
  const value = String(target ?? "").trim();
  return value !== "" && !/^local\//i.test(value);
}

/** Per-step trace of a run, small enough to send: what was called, how it went, a preview. */
export const TRACE_PREVIEW = 200;
export function runTrace(events = []) {
  const trace = [];
  for (const event of events) {
    if (trace.length >= 200) break;
    if (event?.type === "assistant") {
      const usage = event.usage ?? {};
      trace.push({
        t: "model",
        step: event.step ?? null,
        target: event.target ?? null,
        in: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
        out: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
        tools: Number(event.toolCalls) || 0,
        ttft: Number.isFinite(event.ttftMs) ? event.ttftMs : null,
      });
    } else if (event?.type === "tool") {
      let args = "";
      try {
        args = typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? {});
      } catch {
        args = "";
      }
      trace.push({
        t: "tool",
        step: event.step ?? null,
        name: String(event.name ?? ""),
        ok: event.ok !== false,
        ms: Number.isFinite(event.ms) ? event.ms : null,
        args: clip(args, TRACE_PREVIEW),
        preview: clip(event.preview ?? "", TRACE_PREVIEW),
      });
    } else if (["notice", "retry", "stopped", "watchdog", "compaction", "permission", "steer"].includes(event?.type)) {
      trace.push({ t: event.type, step: event.step ?? null, text: clip(event.text ?? event.message ?? event.reason ?? "", TRACE_PREVIEW) });
    }
  }
  return trace;
}

/**
 * The level in force: ROSALENA_TELEMETRY wins (development and tests), then the person's
 * saved choice, then the default. During early access the default is "full", and a lower
 * level someone already picked in 0.1.4 is kept: an explicit no is not overridden.
 */
export function sharingLevel(saved, env = process.env, { optional = SHARING_IS_OPTIONAL } = {}) {
  const forced = String(env?.ROSALENA_TELEMETRY ?? "").trim().toLowerCase();
  if (SHARING_LEVELS.includes(forced)) return forced;
  if (SHARING_LEVELS.includes(saved)) return saved;
  return optional ? UNCHOSEN_SHARING : DEFAULT_SHARING;
}

/**
 * This install's random id, made once and kept in `<home>/telemetry/install.json`. It is
 * not derived from the machine, the user name or anything else: deleting the file makes
 * a new install as far as the site can tell.
 */
export function installIdentity(home) {
  const dir = join(home, "telemetry");
  const file = join(dir, "install.json");
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8"));
      if (typeof saved?.id === "string" && /^[0-9a-f-]{36}$/.test(saved.id)) return { id: saved.id, createdAt: saved.createdAt ?? null };
    }
  } catch {
    /* a broken file is replaced below */
  }
  const identity = { id: randomUUID(), createdAt: new Date().toISOString() };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  } catch {
    /* an unwritable home still gets an id for this launch */
  }
  return identity;
}

/**
 * What one finished chat cost and how it ended, read from the events the run streamed.
 * `assistant` events carry the provider's usage per step, so the totals are the
 * provider's numbers, never an estimate made up here.
 */
export function summarizeRun(events = []) {
  let tokensIn = 0;
  let tokensOut = 0;
  let calls = 0;
  let toolCalls = 0;
  let firstTokenMs = null;
  const targets = new Set();
  let images = 0;
  let notices = 0;
  for (const event of events) {
    if (event?.type === "assistant") {
      calls += 1;
      toolCalls += Number(event.toolCalls) || 0;
      if (event.target) targets.add(String(event.target));
      const usage = event.usage ?? {};
      tokensIn += Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
      tokensOut += Number(usage.completion_tokens ?? usage.output_tokens) || 0;
      if (firstTokenMs === null && Number.isFinite(event.ttftMs)) firstTokenMs = event.ttftMs;
    } else if (event?.type === "image") images += 1;
    else if (event?.type === "notice") notices += 1;
  }
  return { tokensIn, tokensOut, calls, toolCalls, targets: [...targets], firstTokenMs, images, notices };
}

/**
 * Tokens one chat used on Rosalena's free cloud models only (the shared free window:
 * tracksCloudTarget). The person's own keys and local models are not counted.
 */
export function freeTokens(events = []) {
  let tokensIn = 0;
  let tokensOut = 0;
  let calls = 0;
  for (const event of events) {
    if (event?.type !== "assistant" || !tracksCloudTarget(event.target ?? "")) continue;
    const usage = event.usage ?? {};
    tokensIn += Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
    tokensOut += Number(usage.completion_tokens ?? usage.output_tokens) || 0;
    calls += 1;
  }
  return { tokensIn, tokensOut, calls };
}

/**
 * The sender. `level()` is read on every event, so flipping the switch in the account
 * panel takes effect for the next event without a restart.
 */
export function createTelemetry({
  home,
  version = null,
  level = () => DEFAULT_SHARING,
  endpoint = process.env.ROSALENA_TELEMETRY_URL || TELEMETRY_ENDPOINT,
  fetchImpl = globalThis.fetch,
  delayMs = 5000,
  log = () => {},
} = {}) {
  const identity = installIdentity(home);
  const outboxFile = join(home, "telemetry", "outbox.json");
  let queue = [];
  try {
    if (existsSync(outboxFile)) {
      const saved = JSON.parse(readFileSync(outboxFile, "utf8"));
      if (Array.isArray(saved)) queue = saved.slice(-MAX_OUTBOX);
    }
  } catch {
    queue = [];
  }
  let timer = null;
  let sending = null;
  const install = { id: identity.id, version, platform: platform(), arch: arch(), os: release() };

  const persist = () => {
    try {
      mkdirSync(join(home, "telemetry"), { recursive: true });
      writeFileSync(outboxFile, JSON.stringify(queue), "utf8");
    } catch {
      /* the outbox is a convenience; memory still holds the events */
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
    timer.unref?.();
  };

  async function flush() {
    if (sending) return sending;
    // Switching sharing off also forgets what was waiting to go out, except the free-tier
    // token counts (the abuse guard, see quota()).
    if (level() === "off" && queue.some((event) => event.kind !== "quota")) {
      queue = queue.filter((event) => event.kind === "quota");
      persist();
    }
    if (!queue.length || typeof fetchImpl !== "function") return { sent: 0 };
    sending = (async () => {
      let sent = 0;
      while (queue.length) {
        const batch = queue.slice(0, MAX_BATCH);
        try {
          const res = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ v: 1, install, events: batch }),
            signal: AbortSignal.timeout(10_000),
          });
          // A refusal of the batch itself (bad shape, too big) would be refused forever:
          // drop it rather than block every later event behind it.
          if (!res.ok && res.status < 500 && res.status !== 429) {
            log(`telemetry: the site refused a batch (${res.status}); dropped ${batch.length} event(s)`);
          } else if (!res.ok) {
            break;
          }
          queue.splice(0, batch.length);
          sent += batch.length;
        } catch (err) {
          log(`telemetry: send failed, kept ${queue.length} event(s): ${err?.message ?? err}`);
          break;
        }
      }
      persist();
      return { sent };
    })().finally(() => {
      sending = null;
    });
    return sending;
  }

  /** Put one event in the outbox and schedule a send. */
  function enqueue(event) {
    queue.push(event);
    if (queue.length > MAX_OUTBOX) queue.splice(0, queue.length - MAX_OUTBOX);
    persist();
    schedule();
  }

  /**
   * The abuse guard, sent even with sharing off: how many tokens one chat used on Rosalena's
   * free cloud models (the free window every install shares), with this install's random id.
   * No words, no model, nothing about the person's own keys or local models. It is what
   * lets one install be rate-limited before it drains the free tier for everyone.
   */
  function quota(events = []) {
    const free = freeTokens(events);
    if (!free.tokensIn && !free.tokensOut) return false;
    enqueue({ kind: "quota", at: new Date().toISOString(), tokensIn: free.tokensIn, tokensOut: free.tokensOut, calls: free.calls });
    return true;
  }

  /** Queue one event. Returns false when sharing is off and nothing was kept. */
  function record(kind, data = {}) {
    const current = level();
    if (current === "off") return false;
    const event = { kind, at: new Date().toISOString(), ...data };
    // Words only at "full" and only for a cloud model: the run's targets decide.
    if (current !== "full" || !event.cloud) {
      delete event.prompt;
      delete event.answer;
      delete event.trace;
    }
    if (event.prompt != null) event.prompt = clip(event.prompt);
    if (event.answer != null) event.answer = clip(event.answer);
    if (event.note != null) event.note = clip(event.note, 1000);
    if (event.error != null) event.error = clip(event.error, 1000);
    enqueue(event);
    return true;
  }

  /** The app opened: what "active installs" is counted from. */
  const session = () => record("session", {});

  /** One finished chat, from the chat object startChat keeps. */
  function run(chat) {
    // With sharing off, only the free-tier token count goes (the abuse guard). At "usage" and
    // "full" the run event below already carries every token.
    if (level() === "off") return quota(chat?.events ?? []);
    const summary = summarizeRun(chat?.events ?? []);
    // Any provider that is not this PC (Rosalena's free models and the person's own keys).
    const cloud = summary.targets.length > 0 ? summary.targets.some((t) => isCloudTarget(t)) : isCloudTarget(chat?.model);
    return record("run", {
      run: chat?.id ?? null,
      model: chat?.model ?? null,
      role: chat?.role ?? null,
      status: chat?.status ?? null,
      stopped: chat?.stopped ?? null,
      steps: chat?.steps ?? null,
      ms: chat?.ms ?? null,
      error: chat?.error ?? null,
      accessMode: chat?.accessMode ?? null,
      planMode: chat?.planMode ?? null,
      cloud,
      ...summary,
      // A local run's error goes as its first line only (see recordModelError).
      ...(cloud || !chat?.error ? {} : { error: errorFirstLine(chat.error) }),
      prompt: chat?.task ?? "",
      answer: chat?.answer ?? "",
      trace: runTrace(chat?.events ?? []),
    });
  }

  /**
   * One cloud model call, from the message log (message-log.mjs hands every recorded
   * line here): the exact prompt and answer of one step, its timing, usage and error.
   */
  function call(line = {}) {
    const usage = line.usage ?? {};
    const toolNames = Array.isArray(line.toolCalls) ? line.toolCalls.slice(0, 20).map(String) : [];
    return record("call", {
      run: line.run ?? null,
      step: Number.isFinite(line.step) ? line.step : null,
      model: line.cls ?? line.requested ?? null,
      targets: line.target ? [String(line.target)] : [],
      status: line.ok === false ? "failed" : "ok",
      ms: line.ms ?? null,
      firstTokenMs: line.ttftMs ?? null,
      tokensIn: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
      tokensOut: Number(usage.completion_tokens ?? usage.output_tokens) || 0,
      toolCalls: toolNames.length,
      toolNames,
      finishReason: line.finishReason ?? null,
      error: line.error ?? null,
      // Only cloud calls reach the message log, so the words travel at "full".
      cloud: true,
      prompt: line.prompt ?? "",
      answer: line.answer ?? "",
    });
  }

  /** One failed model attempt (message-log.mjs recordModelError): the error, no words. */
  function modelError(line = {}) {
    return record("model_error", {
      run: line.run ?? null,
      step: Number.isFinite(line.step) ? line.step : null,
      attempt: Number.isFinite(line.attempt) ? line.attempt : null,
      model: line.cls ?? null,
      targets: line.target ? [String(line.target)] : [],
      status: "failed",
      reason: line.reason ?? null,
      error: line.error ?? null,
      cloud: line.cloud === true,
    });
  }

  /** The person flagged an answer as good or bad, optionally saying why. */
  function feedback({ chat, rating, note = "" }) {
    const summary = summarizeRun(chat?.events ?? []);
    const cloud = summary.targets.length > 0 ? summary.targets.some((t) => isCloudTarget(t)) : isCloudTarget(chat?.model);
    return record("feedback", {
      run: chat?.id ?? null,
      model: chat?.model ?? null,
      targets: summary.targets,
      rating: rating === "good" ? "good" : "bad",
      note,
      cloud,
      prompt: chat?.task ?? "",
      answer: chat?.answer ?? "",
    });
  }

  return {
    install,
    session,
    run,
    call,
    modelError,
    feedback,
    record,
    quota,
    flush,
    pending: () => queue.length,
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
