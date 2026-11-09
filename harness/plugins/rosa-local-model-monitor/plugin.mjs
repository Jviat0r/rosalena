// Local model monitor - a live, read-only view of the local llama.cpp server.
//
// The suite's text half is llama.cpp on :8080, reached through the router's
// "local" provider. One RTX 3090 holds one big model at a time, so "what is the
// server doing right now?" is a question worth asking cheaply and often: is it
// up, which model, how much context, is a slot busy and with what, is anything
// waiting, and how did the last few requests end. That is exactly what this
// plugin answers, and nothing else.
//
// READ-ONLY, and that is the point rather than an implementation detail: this
// plugin never starts, stops, restarts or interrupts llama-server. With one card
// and one big model, bringing the writer up (or unloading it for the renderer)
// is a machine-wide decision that belongs to whatever owns the GPU - ContentFarm's
// gpu-switch.ps1 does - not to a tool a model can call mid-run. Every request
// here is a GET; a broken probe becomes a reported problem, never an action.
//
// Where each number comes from, and the honesty rules that go with it:
//
//   GET /health    is the process up. 200 {"status":"ok"}, or 503 while it loads
//                  the model. A build with no /health at all is not "down", so
//                  that case is named instead of guessed.
//   GET /props     model id (model_alias, falling back to the weights file name),
//                  the per-slot context size (default_generation_settings.n_ctx)
//                  and total_slots.
//   GET /slots     per slot: is_processing, id_task, n_prompt_tokens,
//                  n_prompt_tokens_processed, n_prompt_tokens_cache, and
//                  next_token[0].n_decoded / n_remain. The endpoint is a build
//                  option (--slots / --no-slots, enabled by default in current
//                  builds), so "unavailable" is a reported state and never an
//                  empty number.
//   GET /metrics   the ONLY place a waiting request is counted
//                  (llamacpp:requests_deferred). /slots lists slots and /props
//                  lists settings; neither has a queue. Metrics is off unless the
//                  server was started with --metrics, so the queue is normally
//                  "not reported" rather than a zero dressed up as a measurement.
//
// What llama.cpp does NOT report, and this plugin therefore does not invent:
//   - when a task started. Durations are measured from the first /slots sample
//     that saw the task busy, and every report says so.
//   - why a task ended. A task busy in one sample and gone from the slot in the
//     next ended; "completed", "eos", "token limit" and "client went away" are
//     not distinguishable from outside, so the report says the slot went idle
//     and nothing more.
//   - a request that started and finished between two probes, if something other
//     than this harness sent it. The harness's OWN model calls are exact: the loop
//     reports every one through the `llm/stream` hook, with a real start, a real
//     end and the provider's own usage, so those are recorded without sampling.
//     A request from any other client is still visible only while a sample catches
//     it busy - the plugin can only claim what it actually saw.
//
// Prompt-processing progress (0.1.1, 2026-10-21) comes from llama-server's LOG, not an
// endpoint: on current builds /slots reports n_prompt_tokens_processed equal to the
// whole prompt from the first sample, so it cannot say how far the prompt read is.
// The server logs, every 2048-token batch:
//   slot print_timing: id 0 | task 3 | prompt processing, n_tokens = 14336,
//   progress = 0.45, t = 11.90 s / 1204.29 tokens per second
// matched to a slot by slot id + task id. llama.cpp's own `progress` counts the
// reused cache as already done (a mostly cached prompt starts near 0.9), so the %
// shown is over the NEW tokens: the reused amount is solved from the lines
// themselves (reused ~ progress * prompt - n_tokens, averaged). A prompt shorter
// than one batch finishes before any line exists, and then no % is claimed.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { detectServerRoots } from "../../src/local-paths.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:8080";

// Bytes read from the end of the server log while a slot is reading its prompt.
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * Where llama-server writes its log, newest file wins: local-model-host's own log
 * (`<ROSALENA_HOME>/local-server.log`), the suite's older launcher log, and the
 * logs folder of the llama.cpp found on this PC (server-err.log, qwen.log).
 * Config `logFiles` replaces the list.
 */
export function logFilesOf(config = {}) {
  if (Array.isArray(config.logFiles) && config.logFiles.length) return config.logFiles.map(String);
  const home = process.env.ROSALENA_HOME || join(homedir(), ".rosalena");
  return [
    join(home, "local-server.log"),
    join(home, "llama-8080.log"),
    // The logs folder of whichever llama.cpp is installed on this PC.
    ...detectServerRoots().flatMap((dir) => [join(dir, "logs", "server-err.log"), join(dir, "logs", "qwen.log")]),
  ];
}

/**
 * Latest prompt-processing line per "slot:task", with every line's (n, progress)
 * kept as samples. ANSI colours are stripped.
 */
export function parsePromptProgress(text) {
  const out = new Map();
  const clean = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const re = /id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*prompt processing, n_tokens\s*=\s*(\d+),\s*progress\s*=\s*([\d.]+),\s*t\s*=\s*([\d.]+)\s*s\s*\/\s*([\d.]+)\s*tokens per second/g;
  let m;
  while ((m = re.exec(clean))) {
    const line = { slot: +m[1], task: +m[2], nTokens: +m[3], progress: +m[4], seconds: +m[5], tps: +m[6] };
    const key = `${line.slot}:${line.task}`;
    const samples = out.get(key)?.samples ?? [];
    samples.push({ n: line.nTokens, p: line.progress });
    out.set(key, { ...line, samples });
  }
  return out;
}

/**
 * Prompt-read progress for one busy slot that has not decoded a token yet, or null.
 * { progress 0..1, newTokens, reused, tps, etaSec, done (new tokens read so far) }
 */
export function promptProgressFor(slot, lines) {
  if (!slot?.busy || slot.decoded || slot.task === null || slot.task === undefined) return null;
  const line = lines.get(`${slot.slot ?? slot.id}:${slot.task}`);
  if (!line) return null;
  // /slots can't size the prompt here: while it is being read, n_prompt_tokens is only
  // the part handed to the model so far (measured live: 2048, 4096, ... of 19,707).
  // The log can: progress = (reused + n_tokens) / total, so a line fitted through
  // this task's (n, progress) samples gives total (slope) and reused (intercept).
  const fit = fitPromptSize(line.samples);
  const newTokens = fit ? Math.max(line.nTokens, fit.total - fit.reused) : null;
  const progress = newTokens ? Math.min(1, line.nTokens / newTokens) : Math.min(1, Math.max(0, line.progress));
  return {
    progress,
    // false: llama.cpp's own number, which counts reused cache as already read
    overNewTokens: Boolean(newTokens),
    newTokens,
    reused: fit ? fit.reused : null,
    done: line.nTokens,
    tps: Math.round(line.tps),
    etaSec: newTokens && line.tps > 0 ? Math.max(0, Math.round((newTokens - line.nTokens) / line.tps)) : null,
  };
}

/**
 * Least-squares fit of n = total * progress - reused over a task's log samples.
 * Needs at least two samples spread over 5 points of progress: llama.cpp prints
 * progress to two decimals, so a mostly cached prompt (0.98 -> 1.00) can't be sized
 * and returns null rather than a guess.
 */
export function fitPromptSize(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const ps = samples.map((s) => s.p);
  if (Math.max(...ps) - Math.min(...ps) < 0.05) return null;
  const k = samples.length;
  const mp = ps.reduce((a, b) => a + b, 0) / k;
  const mn = samples.reduce((a, s) => a + s.n, 0) / k;
  let cov = 0;
  let varp = 0;
  for (const s of samples) {
    cov += (s.p - mp) * (s.n - mn);
    varp += (s.p - mp) ** 2;
  }
  if (varp <= 0) return null;
  const total = cov / varp;
  if (!(total > 0)) return null;
  // Two-decimal progress leaves a few hundred tokens of noise in the intercept:
  // below 2% of the prompt (or 512 tokens) that is "nothing reused", not a reading.
  let reused = Math.max(0, Math.round(total * mp - mn));
  if (reused < Math.max(512, total * 0.02)) reused = 0;
  return { total: Math.round(total), reused };
}

/** The last LOG_TAIL_BYTES of the newest existing file in `files`, or null. */
export function readNewestLogTail(files, { tailBytes = LOG_TAIL_BYTES } = {}) {
  let newest = null;
  for (const file of files ?? []) {
    try {
      const st = statSync(file);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      // missing file: skip
    }
  }
  if (!newest) return null;
  let fd = null;
  try {
    fd = openSync(newest.file, "r");
    const len = Math.min(tailBytes, newest.size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, newest.size - len);
    return { file: newest.file, text: buf.toString("utf8") };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// 1500ms is the right order for a loopback server: a busy /slots answers in a
// few milliseconds, so a second and a half means "wedged", not "slow". The UI
// polls this while a run is going; a longer timeout would turn a dead server
// into a frozen panel.
const DEFAULT_TIMEOUT_MS = 1500;

// Finished observations kept per server, and the hard ceiling on rows a caller
// can ask for: this is a monitor, not a log.
const DEFAULT_RECENT = 12;
const MAX_ROWS = 25;

// "the last few finished requests" in one monitor call.
const REPORTED_ENDS = 5;

// Model calls the loop reports through the `llm/stream` hook. Bounded like the
// slot ledger: this is a window onto recent traffic, not a log file.
const HARNESS_LIMIT = 40;

const reason = (err) => (err instanceof Error ? err.message : String(err));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The configured server, without a trailing slash. Config only: never a URL a model chose. */
export function baseUrlOf(config = {}) {
  return String(config.baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
}

/** The configured probe timeout, floored at 50ms - below that a healthy busy server fails. */
export function timeoutOf(config = {}) {
  return clampTimeout(config.timeoutMs);
}

function clampTimeout(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 50 ? Math.round(ms) : DEFAULT_TIMEOUT_MS;
}

function clampLimit(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_ROWS, Math.round(n));
}

function baseName(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

/** A duration as a person reads it: 850ms, 12.4s, 2m 05s. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/**
 * Turn a fetch rejection into the phrase that tells them apart.
 *
 * "connection refused" and "timed out after 1500ms" lead to opposite decisions
 * (start the server vs. leave a busy one alone), so flattening both into "fetch
 * failed" would make the tool useless at the moment it matters.
 */
function errorText(err, timeoutMs) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `timed out after ${timeoutMs}ms`;
  const code = err?.cause?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ECONNRESET") return "connection reset";
  if (code === "EHOSTUNREACH") return "host unreachable";
  if (code === "EACCES") return "connection not permitted";
  return reason(err);
}

/**
 * One GET, never a throw. A monitor that dies because the thing it monitors is
 * down is worse than no monitor, so every failure becomes a value here and the
 * caller decides what it means.
 */
async function getText(url, timeoutMs) {
  const controller = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { signal: controller });
    // The body is read under the same signal on purpose: a server that sends
    // headers and then stalls is the same outage as one that never answers.
    const text = await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, text, error: null };
  } catch (err) {
    return { ok: false, status: 0, statusText: "", text: "", error: errorText(err, timeoutMs) };
  }
}

/** The useful half of a llama.cpp error body: { error: { message } }. */
function detailOf(body) {
  const message = body?.error?.message ?? (typeof body?.error === "string" ? body.error : null);
  return message ? ` - ${String(message).slice(0, 160)}` : "";
}

/**
 * One GET as JSON, with the endpoint named in the failure.
 *
 * The path is in the message because a monitor's whole job is to say which
 * endpoint did not answer - a bare "HTTP 501" leaves the reader guessing whether
 * the server is broken or the build simply has no /slots.
 */
async function getJson(base, path, timeoutMs) {
  const res = await getText(`${base}${path}`, timeoutMs);
  if (res.error) return { ok: false, status: 0, body: null, error: `GET ${path} failed: ${res.error}` };
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    return { ok: false, status: res.status, body: null, error: `GET ${path} returned non-JSON (HTTP ${res.status}): ${res.text.slice(0, 120)}` };
  }
  if (!res.ok) return { ok: false, status: res.status, body, error: `GET ${path} answered HTTP ${res.status}${detailOf(body)}` };
  return { ok: true, status: res.status, body, error: null };
}

/**
 * The queue length, if the build publishes one.
 *
 * Prometheus text is the only queue signal llama.cpp has, and the gauge is named
 * llamacpp:requests_deferred there. The parse accepts the queued/waiting
 * spellings too because the endpoint is off by default on this box and cannot be
 * checked against a live --metrics server here; when no such gauge is present the
 * answer is null, never a guess.
 */
export function deferredFromMetrics(text) {
  if (typeof text !== "string") return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_:][\w:]*)(?:\{[^}]*\})?\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(line);
    if (!match) continue;
    if (!/(?:^|:)(requests_deferred|requests_queued|requests_waiting)$/.test(match[1])) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * One slot row out of /slots, flattened to the numbers this plugin reports.
 *
 * `n_prompt_tokens_processed` and `n_prompt_tokens_cache` are newer fields: on an
 * older build they are absent and stay null, which the report shows as unknown
 * instead of an invented zero.
 */
function normalizeSlot(raw) {
  const next = Array.isArray(raw?.next_token) ? raw.next_token[0] : raw?.next_token;
  return {
    slot: num(raw?.id),
    task: num(raw?.id_task),
    busy: Boolean(raw?.is_processing),
    nCtx: num(raw?.n_ctx),
    promptTokens: num(raw?.n_prompt_tokens),
    promptProcessed: num(raw?.n_prompt_tokens_processed),
    promptCached: num(raw?.n_prompt_tokens_cache),
    decoded: num(next?.n_decoded),
    // -1 in next_token means "no limit" / "not started", not "minus one left".
    remain: num(next?.n_remain) !== null && num(next?.n_remain) >= 0 ? num(next?.n_remain) : null,
    hasNextToken: typeof next?.has_next_token === "boolean" ? next.has_next_token : null,
    maxTokens: num(raw?.params?.n_predict),
  };
}

/**
 * Per-server observation state.
 *
 * Module-level by design: the ledger is what this plugin has SEEN, so it has to
 * outlive one tool call - that is the whole point of local_model_requests. Keyed
 * by base URL so a second server never inherits the first one's history.
 */
const servers = new Map();

function serverState(base) {
  let state = servers.get(base);
  if (!state) {
    servers.set(base, (state = { tasks: new Map(), recent: [], recentLimit: DEFAULT_RECENT }));
  }
  return state;
}

function taskKey(row) {
  return `${row.slot}:${row.task ?? "?"}`;
}

function endRecord(task, at, how) {
  return {
    task: task.task,
    slot: task.slot,
    state: "ended",
    how,
    startedAt: task.startedAt,
    endedAt: at,
    elapsedMs: at - task.startedAt,
    samples: task.samples,
    promptTokens: task.promptTokens,
    promptProcessed: task.promptProcessed,
    promptCached: task.promptCached,
    decoded: task.decoded,
    remain: task.remain,
    unseenProbes: task.misses,
  };
}

/**
 * Fold one /slots sample into the ledger.
 *
 * A llama.cpp slot carries an `id_task` plus `is_processing`, so a task can be
 * followed across samples: busy under the same id is the same task, gone from the
 * slot means it ended, and a different id on the same slot means another task
 * took it before a probe saw it idle. Those three are exactly what the records
 * claim - no stop reason, because the endpoint reports none.
 *
 * When /slots could not be read at all, nothing is finalized: whether the task is
 * still running is unknown, so it is marked unconfirmed instead of finished.
 */
function reconcile(state, rows, at, { slotsAvailable }) {
  if (!slotsAvailable) {
    for (const task of state.tasks.values()) task.misses += 1;
    return;
  }

  const bySlot = new Map(rows.map((row) => [row.slot, row]));
  const live = new Map();
  for (const row of rows) {
    if (!row.busy) continue;
    live.set(taskKey(row), row);
  }

  for (const [key, task] of [...state.tasks]) {
    if (live.has(key)) continue;
    state.tasks.delete(key);
    const slot = bySlot.get(task.slot);
    const how = !slot ? "slot-disappeared" : slot.task !== task.task ? "replaced" : "idle";
    state.recent.unshift(endRecord(task, at, how));
  }
  if (state.recent.length > state.recentLimit) state.recent.length = state.recentLimit;

  for (const [key, row] of live) {
    const seen = state.tasks.get(key);
    if (!seen) {
      state.tasks.set(key, {
        slot: row.slot,
        task: row.task,
        startedAt: at,
        lastSeenAt: at,
        samples: 1,
        misses: 0,
        promptTokens: row.promptTokens,
        promptProcessed: row.promptProcessed,
        promptCached: row.promptCached,
        decoded: row.decoded,
        remain: row.remain,
      });
      continue;
    }
    // The last sample is the one worth keeping: a slot that has gone idle resets
    // next_token.n_decoded to 0, so these numbers are read only while busy.
    seen.lastSeenAt = at;
    seen.samples += 1;
    seen.misses = 0;
    if (row.promptTokens !== null) seen.promptTokens = row.promptTokens;
    if (row.promptProcessed !== null) seen.promptProcessed = row.promptProcessed;
    if (row.promptCached !== null) seen.promptCached = row.promptCached;
    if (row.decoded !== null) seen.decoded = row.decoded;
    if (row.remain !== null) seen.remain = row.remain;
  }
}

function queueReport(metrics, queued) {
  if (queued !== null) return { queued, source: "GET /metrics llamacpp:requests_deferred", note: null };
  const why = metrics.ok
    ? "the metrics endpoint answered but publishes no deferred-request gauge"
    : metrics.status
      ? `GET /metrics answered HTTP ${metrics.status} (metrics is off unless llama-server runs with --metrics)`
      : `GET /metrics failed: ${metrics.error}`;
  return { queued: null, source: null, note: `not reported - /slots and /props expose no queue length, and ${why}` };
}

/**
 * The harness's own model calls, from the `llm/stream` hook.
 *
 * A /slots sample cannot see a request that started and finished between two
 * probes, and it has no start time even for the ones it does see. The loop knows
 * both, so it reports every call it makes - twice, once when the request leaves
 * and once when it settles. Those rows are exact, and they are kept apart from
 * the sampled slot rows instead of being merged into one number that would be
 * right for neither.
 *
 * One honest limit: the hook fires for every router target, so a call sent to a
 * cloud provider lands here too. `target` says which, and the output never claims
 * these rows reached the local server - only that the harness made them.
 */
const harnessCalls = [];
const pendingCalls = new Map();
let harnessSeq = 0;

/** Forget everything observed so far. Tests need a clean process; no run calls this. */
export function resetHarnessCalls() {
  harnessCalls.length = 0;
  pendingCalls.clear();
  harnessSeq = 0;
}

/** A start and its end are the same call when run, step and attempt match. */
const callKey = (info) => `${info?.run?.id ?? "?"}:${info?.step ?? "?"}:${info?.attempt ?? "?"}`;

/**
 * Record one `llm/stream` phase.
 *
 * Runs inside the loop's own call path, so it does one Map write and returns:
 * no network, no timers, nothing that could delay or fail a model call. It also
 * takes whatever it is handed: `null` and a bare number are not worth a thrown
 * error inside somebody else's run, so anything that is not an object is read as
 * an empty report and recorded as a call with unknown fields.
 */
export function recordHarnessCall(raw) {
  const info = raw && typeof raw === "object" ? raw : {};
  const at = Date.now();
  const key = callKey(info);
  const fields = {
    source: "harness",
    step: num(info.step),
    attempt: num(info.attempt),
    cls: info.cls ?? null,
    target: info.target ?? null,
    // `streamed` when the transport says so, `stream` when the call was made on the
    // streaming path: the start phase only knows the latter.
    streamed: Boolean(info.streamed ?? info.stream),
    runId: info.run?.id ?? null,
  };

  if (info.phase !== "end") {
    const call = {
      id: ++harnessSeq,
      ...fields,
      state: "running",
      startedAt: at,
      endedAt: null,
      ms: null,
      ttftMs: null,
      usage: null,
      ok: null,
      error: null,
      how: null,
    };
    harnessCalls.unshift(call);
    if (harnessCalls.length > HARNESS_LIMIT) harnessCalls.length = HARNESS_LIMIT;
    pendingCalls.set(key, call);
    return call;
  }

  // An end with no start still gets a row: a monitor that silently drops what it
  // half-saw is worse than one that reports a call with no measured start.
  const known = pendingCalls.get(key);
  const call = known ?? { id: ++harnessSeq, ...fields, startedAt: at };
  pendingCalls.delete(key);
  const usage = info.usage && typeof info.usage === "object" ? info.usage : null;
  call.state = "ended";
  call.endedAt = at;
  call.target = info.target ?? call.target ?? null;
  call.ms = num(info.ms) ?? (known ? at - call.startedAt : null);
  call.ttftMs = num(info.ttftMs);
  call.usage = usage
    ? { prompt: num(usage.prompt_tokens), completion: num(usage.completion_tokens), total: num(usage.total_tokens) }
    : null;
  call.ok = info.ok === true;
  call.how = call.ok ? "ok" : String(info.reason ?? "call_failed");
  call.error = call.ok ? null : String(info.error ?? "").slice(0, 200) || null;
  if (!known) {
    harnessCalls.unshift(call);
    if (harnessCalls.length > HARNESS_LIMIT) harnessCalls.length = HARNESS_LIMIT;
  }
  return call;
}

/** The newest `limit` calls, copied so a caller cannot edit the ledger through the view. */
function harnessView(limit = DEFAULT_RECENT) {
  return harnessCalls.slice(0, clampLimit(limit, DEFAULT_RECENT)).map((call) => ({ ...call }));
}

function emptyProbe(base, at) {
  return {
    baseUrl: base,
    at,
    up: false,
    loading: false,
    model: null,
    modelPath: null,
    modelFtype: null,
    ctx: null,
    totalSlots: null,
    slots: [],
    busy: null,
    queued: null,
    queuedSource: null,
    queuedNote: null,
    lastEnded: [],
    requests: [],
    harnessCalls: [],
    error: null,
    slotsAvailable: false,
    slotsError: null,
    propsError: null,
    healthStatus: 0,
  };
}

/**
 * One read-only look at the local server, as data.
 *
 * This is the entry point the browser window and the tests call, so it returns a
 * structure rather than prose and never throws: every endpoint it asks is
 * optional in some llama.cpp build, and one missing answer is a field that says
 * so, not a failed call. `up` is "the server answered"; `error` is the first hole
 * in the picture, which can be set while `up` is true (a build without /slots).
 */
export async function probeLocalModel({ baseUrl = DEFAULT_BASE, timeoutMs = DEFAULT_TIMEOUT_MS, recentLimit = DEFAULT_RECENT, logFiles = logFilesOf() } = {}) {
  const base = String(baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  const timeout = clampTimeout(timeoutMs);
  try {
    // All four at once: asking one endpoint at a time would turn a dead server
    // into four timeouts in series, and the panel would take 6s to say "down".
    const [health, props, slots, metrics] = await Promise.all([
      getJson(base, "/health", timeout),
      getJson(base, "/props", timeout),
      getJson(base, "/slots", timeout),
      getText(`${base}/metrics`, timeout),
    ]);
    const at = Date.now();

    const healthOk = health.ok && String(health.body?.status ?? "ok").toLowerCase() === "ok";
    const healthMissing = health.status === 404;
    // A build with no /health is not a build that is down: /props answering is
    // proof enough that the process is alive, and refusing to report it would be
    // wrong in the most confusing possible direction.
    const up = healthOk || (healthMissing && props.ok);
    const loading = !healthOk && health.status === 503;

    const propsBody = props.body;
    const model =
      typeof propsBody?.model_alias === "string" && propsBody.model_alias.trim()
        ? propsBody.model_alias.trim()
        : typeof propsBody?.model_path === "string" && propsBody.model_path.trim()
          ? baseName(propsBody.model_path.trim())
          : null;
    const ctx = num(propsBody?.default_generation_settings?.n_ctx) ?? num(propsBody?.n_ctx);
    const totalSlots = num(propsBody?.total_slots);

    const slotsAvailable = slots.ok && Array.isArray(slots.body);
    const slotsError = slotsAvailable ? null : slots.error ?? "GET /slots returned no slot array";
    const rows = slotsAvailable ? slots.body.map(normalizeSlot) : [];

    const state = serverState(base);
    state.recentLimit = clampLimit(recentLimit, DEFAULT_RECENT);
    reconcile(state, rows, at, { slotsAvailable });

    // The log is read only while some slot is still reading its prompt.
    const reading = rows.some((r) => r.busy && !r.decoded);
    const tail = reading ? readNewestLogTail(logFiles) : null;
    const lines = tail ? parsePromptProgress(tail.text) : new Map();

    const slotViews = rows.map((row) => {
      const task = row.busy ? state.tasks.get(taskKey(row)) : null;
      const pp = promptProgressFor(row, lines);
      return {
        promptProgress: pp,
        promptProgressSource: pp ? baseName(tail.file) : null,
        id: row.slot,
        busy: row.busy,
        task: row.task,
        nCtx: row.nCtx ?? ctx,
        promptTokens: row.promptTokens,
        promptProcessed: row.promptProcessed,
        promptCached: row.promptCached,
        decoded: row.decoded,
        remain: row.remain,
        maxTokens: row.maxTokens,
        hasNextToken: row.hasNextToken,
        samples: task ? task.samples : null,
        busyForMs: task ? at - task.startedAt : null,
      };
    });

    const queue = queueReport(metrics, deferredFromMetrics(metrics.ok ? metrics.text : null));

    // The first hole in the picture. /metrics is deliberately excluded: it is
    // optional in llama.cpp and its absence is reported where the queue lives.
    const problems = [
      healthOk || healthMissing ? null : health.error,
      props.ok ? null : props.error,
      slotsAvailable ? null : slotsError,
    ].filter(Boolean);

    const requests = [];
    for (const task of state.tasks.values()) {
      requests.push({
        task: task.task,
        slot: task.slot,
        state: task.misses > 0 ? "unknown" : "running",
        startedAt: task.startedAt,
        endedAt: null,
        elapsedMs: at - task.startedAt,
        samples: task.samples,
        promptTokens: task.promptTokens,
        promptProcessed: task.promptProcessed,
        promptCached: task.promptCached,
        decoded: task.decoded,
        remain: task.remain,
        how: null,
        unseenProbes: task.misses,
      });
    }
    requests.push(...state.recent.map((ended) => ({ ...ended })));
    requests.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

    return {
      baseUrl: base,
      at,
      up,
      loading,
      model,
      modelPath: typeof propsBody?.model_path === "string" ? propsBody.model_path : null,
      modelFtype: typeof propsBody?.model_ftype === "string" ? propsBody.model_ftype : null,
      ctx,
      totalSlots: totalSlots ?? (slotsAvailable ? slotViews.length || null : null),
      slots: slotViews,
      busy: slotsAvailable ? slotViews.filter((slot) => slot.busy).length : null,
      queued: queue.queued,
      queuedSource: queue.source,
      queuedNote: queue.note,
      lastEnded: state.recent.slice(0, REPORTED_ENDS).map((ended) => ({ ...ended })),
      requests,
      // Not tied to this server: these are calls the harness made, whichever
      // router target served them. `target` on each row says which.
      harnessCalls: harnessView(recentLimit),
      error: problems[0] ?? null,
      slotsAvailable,
      slotsError,
      propsError: props.ok ? null : props.error,
      healthStatus: health.status,
    };
  } catch (err) {
    // Last line of defence: a monitor that throws fails the run it was meant to
    // inform, which is the one thing it must never do.
    return { ...emptyProbe(base, Date.now()), error: `the probe failed: ${reason(err)}`, queuedNote: "not reported - the probe failed before it could ask" };
  }
}

const FIELD = 10;
const row = (label, text) => `  ${String(label).padEnd(FIELD)}${text}`;

/** "prompt 1958 tokens (0 processed, 0 cached), 37 decoded, 4059 left" - only real fields. */
function tokenLine(item) {
  const head = [`prompt ${item.promptTokens ?? "?"} tokens`];
  if (item.promptProcessed !== null || item.promptCached !== null) {
    head[0] += ` (${item.promptProcessed ?? "?"} processed, ${item.promptCached ?? "?"} cached)`;
  }
  const parts = [head[0], `${item.decoded ?? "?"} decoded`];
  if (item.remain !== null && item.remain !== undefined) parts.push(`${item.remain} left`);
  return parts.join(", ");
}

function phaseLine(slot) {
  const pp = slot.promptProgress;
  if (pp) {
    const pct = `${Math.round(pp.progress * 100)}%`;
    const of = pp.newTokens
      ? ` (${pp.done} of ${pp.newTokens} new tokens${pp.reused ? `, ${pp.reused} reused from cache` : ""})`
      : ` (llama.cpp's own figure, counting reused cache as read; ${pp.done} new tokens so far)`;
    const eta = pp.etaSec !== null ? `, about ${formatDuration(pp.etaSec * 1000)} left` : "";
    return `reading the prompt: ${pct}${of}, ${pp.tps} tok/s${eta} - from llama-server's log${slot.promptProgressSource ? ` (${slot.promptProgressSource})` : ""}`;
  }
  if (slot.busy && !slot.decoded) {
    return "reading the prompt (no progress line yet: llama-server logs one per 2048-token batch, so short prompts show none)";
  }
  if (slot.promptTokens !== null && slot.promptProcessed !== null && slot.promptProcessed < slot.promptTokens) {
    return `reading the prompt: ${slot.promptProcessed} of ${slot.promptTokens} tokens processed`;
  }
  if (typeof slot.decoded === "number" && slot.decoded > 0) return `writing: ${slot.decoded} token(s) decoded so far`;
  return "no token decoded yet";
}

function endText(record) {
  const how =
    record.how === "replaced"
      ? "another task took the slot before a probe saw it idle"
      : record.how === "slot-disappeared"
        ? "the slot was gone from the next /slots sample"
        : "the slot went idle";
  const gaps =
    record.unseenProbes > 0
      ? ` (${record.unseenProbes} probe${record.unseenProbes === 1 ? "" : "s"} could not read /slots while it ran)`
      : "";
  return `${how}; llama.cpp reports no stop reason${gaps}`;
}

/** The monitor tool's answer: one screen of real numbers, or a plain statement of what is missing. */
export function formatReport(probe) {
  const lines = [];
  const where = `local llama.cpp at ${probe.baseUrl}`;

  if (!probe.up) {
    lines.push(`${where} is ${probe.loading ? "up but still loading its model" : "not answering"}${probe.error ? ` (${probe.error})` : ""}.`);
    if (probe.model || probe.ctx !== null) {
      lines.push(row("model", `${probe.model ?? "not reported"}${probe.ctx === null ? "" : `, ${probe.ctx} tokens of context per slot`} (from /props, which did answer)`));
    }
    lines.push("  Read-only: this plugin never starts, stops or restarts the server. One RTX 3090 holds one big model,");
    lines.push("  so the server is brought up - and unloaded - by whatever owns the GPU, not by a tool call. Ask again when it is ready.");
    return lines.join("\n");
  }

  const slotCount = probe.totalSlots ?? probe.slots.length;
  lines.push(where);
  lines.push(row("status", `up - ${probe.model ?? "model not reported"}${probe.modelFtype ? ` (${probe.modelFtype})` : ""}`));
  if (probe.modelPath) lines.push(row("weights", probe.modelPath));
  lines.push(row("context", `${probe.ctx === null ? "not reported" : `${probe.ctx} tokens per slot`}, ${slotCount} slot${slotCount === 1 ? "" : "s"}`));

  if (!probe.slotsAvailable) {
    lines.push(row("slots", `unavailable - ${probe.slotsError ?? "no slot data"}`));
    lines.push("            Busy slots, per-slot token counts and durations are not reported for this build:");
    lines.push("            it does not expose /slots, and a made-up number would be worse than no number.");
  } else {
    lines.push(row("slots", `${probe.busy} of ${slotCount} slot${slotCount === 1 ? "" : "s"} busy`));
    const busySlots = probe.slots.filter((slot) => slot.busy);
    if (!busySlots.length) lines.push("            no slot is processing a request");
    for (const slot of busySlots) {
      const span =
        (slot.samples ?? 1) <= 1
          ? "busy for the first sample that saw it"
          : `busy ${formatDuration(slot.busyForMs ?? 0)} over ${slot.samples} samples`;
      lines.push(`            slot ${slot.id}${slot.task === null ? "" : ` - task ${slot.task}`} - ${span}`);
      lines.push(`            ${tokenLine(slot)}`);
      lines.push(`            ${phaseLine(slot)}`);
    }
    if (busySlots.length) lines.push("            durations run from the first /slots sample that saw the task; llama.cpp reports no start time");
  }

  lines.push(row("queued", probe.queued === null ? (probe.queuedNote ?? "not reported") : `${probe.queued}${probe.queuedSource ? ` (${probe.queuedSource})` : ""}`));

  const ended = probe.lastEnded ?? [];
  if (!probe.slotsAvailable) {
    lines.push(row("ended", "unknown - without /slots there is nothing to observe a request ending against"));
  } else if (!ended.length) {
    lines.push(row("ended", "none observed yet - a task is visible only while a /slots sample catches it busy"));
  } else {
    lines.push(row("ended", `${ended.length} recently finished, newest first:`));
    for (const record of ended) {
      lines.push(`            task ${record.task ?? "?"} on slot ${record.slot ?? "?"} - ${record.samples} sample(s) spanning ${formatDuration(record.elapsedMs)}, ended ${formatDuration(probe.at - record.endedAt)} ago`);
      lines.push(`            last saw ${tokenLine(record)}; ${endText(record)}`);
    }
  }

  // Exact rows, from the loop itself. Nothing here is sampled, so the durations
  // and the usage are what the harness actually measured - and a call sent to a
  // cloud target is listed just as plainly, because this is every call the
  // harness made, not only the ones this server answered.
  const calls = probe.harnessCalls ?? [];
  if (calls.length) {
    lines.push(row("harness", `${calls.length} model call(s) reported by the loop, newest first:`));
    for (const call of calls.slice(0, 3)) {
      const usage =
        call.usage && (call.usage.prompt !== null || call.usage.completion !== null)
          ? `, ${call.usage.prompt ?? "?"} in / ${call.usage.completion ?? "?"} out`
          : "";
      const outcome = call.state === "running" ? "running" : call.ok ? "ok" : call.how;
      lines.push(`            ${formatDuration(call.ms ?? probe.at - call.startedAt)} ${outcome} - ${call.target ?? call.cls ?? "target not reported"}${usage}`);
    }
    lines.push("            exact: the loop reported each start and end, unlike the slot samples above");
  }
  return lines.join("\n");
}

/** The requests tool's answer: the bounded ledger, newest first, with state and how each ended. */
export function formatRequests(probe, limit) {
  // Two sources, labelled rather than blended: `harness` rows are exact (the loop
  // measured them), `slot` rows are sampled (a task a /slots sample caught busy).
  // The same request can show up as both, and saying so beats hiding one of them.
  const all = [...(probe.harnessCalls ?? []), ...(probe.requests ?? [])];
  all.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const rows = all.slice(0, clampLimit(limit, 10));
  const lines = [`local model requests at ${probe.baseUrl} - newest first`];
  if (!probe.up) lines.push(`  the server is not answering${probe.error ? ` (${probe.error})` : ""}; everything below is from earlier observations`);
  if (!probe.slotsAvailable) lines.push(`  /slots is unavailable${probe.slotsError ? ` (${probe.slotsError})` : ""}; only what an earlier probe saw can be listed`);
  if (!rows.length) {
    lines.push("  no requests observed yet. This plugin sees a task only while a /slots sample catches it busy, so a");
    lines.push("  request that started and finished between two calls never appears here at all - unless the harness");
    lines.push("  made it, in which case the loop reports it exactly as soon as a run reaches its next model call.");
    return lines.join("\n");
  }
  for (const item of rows) {
    if (item.source === "harness") {
      const usage = item.usage ? `${item.usage.prompt ?? "?"} in / ${item.usage.completion ?? "?"} out` : "no usage reported";
      const detail =
        item.state === "running"
          ? "still in flight; the loop has not reported its end yet"
          : `${item.ok ? "finished" : `ended: ${item.how}${item.error ? ` - ${item.error}` : ""}`}; ${usage}`;
      lines.push(`  ${String(item.state).padEnd(8)} harness  ${item.target ?? item.cls ?? "?"}  ${formatDuration(item.ms ?? probe.at - item.startedAt)}`);
      lines.push(`           ${detail}`);
      continue;
    }
    const detail =
      item.state === "ended"
        ? `${endText(item)}; last saw ${tokenLine(item)}`
        : item.state === "unknown"
          ? `${item.unseenProbes} probe(s) could not read /slots, so it may be over; last saw ${tokenLine(item)}`
          : tokenLine(item);
    lines.push(`  ${String(item.state).padEnd(8)} slot ${item.slot ?? "?"}  task ${item.task ?? "?"}  ${formatDuration(item.elapsedMs)}${item.samples > 1 ? ` over ${item.samples} samples` : ""}`);
    lines.push(`           ${detail}`);
  }
  return lines.join("\n");
}

export default {
  id: "rosa-local-model-monitor",
  description: "Read-only live view of the local llama.cpp server: health, model and context size, busy slots, the queue, and recently finished requests.",
  tools(ctx) {
    const config = () => ctx.config ?? {};
    const probe = () =>
      probeLocalModel({
        baseUrl: baseUrlOf(config()),
        timeoutMs: timeoutOf(config()),
        recentLimit: config().recentLimit,
        logFiles: logFilesOf(config()),
      });
    return [
      {
        name: "local_model_monitor",
        description:
          "One read-only look at the local llama.cpp server: is it up, which model, its context size, how many slots, which slots are busy and for how long, prompt/output tokens per busy slot, how many requests are queued (only when the build exposes metrics), and how the last few finished requests ended. Use it before heavy work and to tell a slow model from a dead one. It never starts, stops or interrupts the server.",
        parameters: { type: "object", properties: {} },
        async run() {
          try {
            return formatReport(await probe());
          } catch (err) {
            return `local_model_monitor failed for ${baseUrlOf(config())}: ${reason(err)}`;
          }
        },
      },
      {
        name: "local_model_requests",
        description:
          "The bounded list of local model requests this plugin has observed, newest first, with elapsed time and state (running, unknown or ended) plus how each ended. Read-only: a request that started and finished between two probes is not visible here.",
        parameters: {
          type: "object",
          properties: { limit: { type: "number", description: "How many rows to return (default 10, maximum 25)." } },
        },
        async run(args) {
          try {
            return formatRequests(await probe(), args?.limit);
          } catch (err) {
            return `local_model_requests failed for ${baseUrlOf(config())}: ${reason(err)}`;
          }
        },
      },
    ];
  },
  hooks() {
    // Observation only. The loop reports each model call before the request
    // leaves and again when it settles, which is the difference between "a task
    // a sample caught" and "a request the harness actually made". This returns
    // nothing on purpose: it can never advise, stop or retry a call.
    return {
      "llm/stream": (info) => {
        recordHarnessCall(info);
      },
    };
  },
  commands(ctx) {
    const config = () => ctx.config ?? {};
    return {
      // The same report `/plugin rosa-local-model-monitor:status` can print by hand,
      // for when the window is closed or the model should not be asked at all.
      status: async () =>
        formatReport(
          await probeLocalModel({
            baseUrl: baseUrlOf(config()),
            timeoutMs: timeoutOf(config()),
            recentLimit: config().recentLimit,
            logFiles: logFilesOf(config()),
          }),
        ),
    };
  },
  // Shown by /plugins and by --check's plugin list. Static on purpose: a status
  // hook that touched the network would make loading the harness depend on the
  // model server being awake.
  status: (ctx) => `read-only monitor of ${baseUrlOf(ctx.config)} (probe timeout ${timeoutOf(ctx.config)}ms)`,
};
