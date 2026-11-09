/**
 * POST /api/telemetry: the desktop app's early-build tracking (harness/src/telemetry.mjs).
 *
 * Body: { v: 1, install: { id, version, platform, arch, os }, events: [ { kind, at, ... } ] }
 *
 * The app is a public download, so there is no secret it could carry that a stranger
 * could not read out of it. The defences are therefore about shape and size, not about
 * who is asking: a strict install id, at most MAX_EVENTS events and MAX_BODY bytes per
 * request, every text clipped, a daily cap per install, and no browser origin other
 * than the site's own. Nothing about the caller's network is stored.
 *
 * `TELEMETRY` (a Pages var) turns the endpoint off with "off"; it answers 204 then, so
 * an app in the field keeps working and simply stops being counted.
 */

import { allowedOrigins } from "./trial.mjs";

export const MAX_EVENTS = 50;
export const MAX_BODY = 256 * 1024;
export const MAX_TEXT = 4000;
/**
 * Events one install may send in one UTC day before the rest are refused. Every cloud
 * model call is an event (the message log), so a long day of agent work is a few
 * thousand; this stops a runaway loop, not a busy tester.
 */
export const DAILY_EVENT_CAP = 10000;
/** A run trace: at most this many steps and this many characters of JSON. */
export const MAX_TRACE_STEPS = 200;
export const MAX_TRACE = 16000;

// session: the app opened. run: a chat ended. call: one cloud model call (the message
// log). model_error: one failed model attempt, any model, local included, no words.
// feedback: Good / Report a problem under an answer. quota: the abuse guard an install sends
// even with sharing off: one chat's token count on Rosalena's free cloud models, nothing else.
const KINDS = new Set(["session", "run", "call", "model_error", "feedback", "quota"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const headers = () => ({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
const reply = (status, json) => ({ status, headers: headers(), json });

const short = (value, max = 64) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text ? text.slice(0, max) : null;
};
const longText = (value, max = MAX_TEXT) => {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text ? text.slice(0, max) : null;
};
const int = (value) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
};

export function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** One event as a row, or null when it is not one this endpoint keeps. */
export function eventRow(event, { install, version, now }) {
  if (!event || typeof event !== "object" || !KINDS.has(event.kind)) return null;
  const at = Date.parse(event.at);
  // An app clock that is off by days still counts; a stamp from the far future does not.
  const stamp = Number.isFinite(at) && at < now + 86_400_000 ? at : now;
  const cloud = event.cloud === true;
  const targets = Array.isArray(event.targets) ? event.targets.slice(0, 8).map((t) => short(t, 120)).filter(Boolean) : [];
  const status = event.kind === "feedback" ? (event.rating === "good" ? "good" : "bad") : short(event.status, 16);
  const extra = {};
  for (const key of ["role", "accessMode", "planMode", "images", "notices", "step", "attempt", "reason", "finishReason"]) {
    if (event[key] !== undefined && event[key] !== null) extra[key] = typeof event[key] === "string" ? short(event[key], 32) : event[key];
  }
  if (Array.isArray(event.toolNames) && event.toolNames.length) extra.toolNames = event.toolNames.slice(0, 20).map((name) => short(name, 64));
  // A run's trace (each step: model, tokens, tool, ok, a short preview), cloud runs only,
  // the same rule as the words. Kept as sent, capped at MAX_TRACE characters of JSON.
  if (cloud && Array.isArray(event.trace) && event.trace.length) {
    const json = JSON.stringify(event.trace.slice(0, MAX_TRACE_STEPS));
    extra.trace = json.length <= MAX_TRACE ? event.trace.slice(0, MAX_TRACE_STEPS) : { cut: true, json: json.slice(0, MAX_TRACE) };
  }
  return {
    id: crypto.randomUUID(),
    install,
    day: utcDay(now),
    stamp,
    kind: event.kind,
    version,
    run: short(event.run, 64),
    model: short(event.model, 120),
    targets: targets.length ? JSON.stringify(targets) : null,
    cloud: cloud ? 1 : 0,
    status,
    stopped: short(event.stopped, 32),
    steps: int(event.steps),
    calls: int(event.calls),
    tool_calls: int(event.toolCalls),
    ms: int(event.ms),
    ttft_ms: int(event.firstTokenMs),
    tokens_in: int(event.tokensIn),
    tokens_out: int(event.tokensOut),
    error: longText(event.error, 1000),
    note: longText(event.note, 1000),
    // The app only sends words for a cloud model at "full"; a row that claims otherwise
    // keeps its numbers and loses the words.
    prompt: cloud ? longText(event.prompt) : null,
    answer: cloud ? longText(event.answer) : null,
    data: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

const EVENT_COLUMNS = ["id", "install", "day", "stamp", "kind", "version", "run", "model", "targets", "cloud", "status", "stopped", "steps", "calls", "tool_calls", "ms", "ttft_ms", "tokens_in", "tokens_out", "error", "note", "prompt", "answer", "data"];
const INSERT_EVENT = `INSERT INTO tel_event (${EVENT_COLUMNS.join(", ")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(", ")})`;

const UPSERT_INSTALL = `INSERT INTO tel_install (id, first_seen, last_seen, version, platform, arch, os, sessions, runs, failed_runs, tokens_in, tokens_out, reports)
VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
ON CONFLICT(id) DO UPDATE SET
  last_seen = MAX(last_seen, excluded.last_seen),
  version = COALESCE(excluded.version, version),
  platform = COALESCE(excluded.platform, platform),
  arch = COALESCE(excluded.arch, arch),
  os = COALESCE(excluded.os, os),
  sessions = sessions + excluded.sessions,
  runs = runs + excluded.runs,
  failed_runs = failed_runs + excluded.failed_runs,
  tokens_in = tokens_in + excluded.tokens_in,
  tokens_out = tokens_out + excluded.tokens_out,
  reports = reports + excluded.reports`;

/**
 * @param {{ request: Request, env: Record<string, any>, now?: number }} context
 * @returns {Promise<{ status: number, headers: Record<string, string>, json?: object }>}
 */
export async function handleTelemetry({ request, env, now = Date.now() }) {
  if (String(env?.TELEMETRY ?? "").trim().toLowerCase() === "off") return { status: 204, headers: headers() };
  if (request.method !== "POST") return reply(405, { error: "POST only" });

  // The app sends no Origin. A browser always does, and only the site itself may.
  const origin = request.headers.get("origin");
  // The site's own origins (rosalena.dev, its www, and the old rosalena.pages.dev).
  if (origin && !allowedOrigins(env).some((entry) => entry.toLowerCase() === origin.trim().replace(/\/+$/, "").toLowerCase())) {
    return reply(403, { error: "origin not allowed" });
  }

  const db = env?.TRIAL_DB;
  if (!db) return reply(503, { error: "no database bound" });

  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY) return reply(413, { error: `body over ${MAX_BODY} bytes` });
  let raw;
  try {
    raw = await request.text();
  } catch {
    return reply(400, { error: "unreadable body" });
  }
  if (raw.length > MAX_BODY) return reply(413, { error: `body over ${MAX_BODY} bytes` });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: "body is not JSON" });
  }

  const install = String(body?.install?.id ?? "").toLowerCase();
  if (!UUID.test(install)) return reply(400, { error: "install.id must be a UUID" });
  if (!Array.isArray(body?.events) || body.events.length === 0) return reply(400, { error: "events must be a non-empty array" });
  if (body.events.length > MAX_EVENTS) return reply(413, { error: `at most ${MAX_EVENTS} events per request` });

  const version = short(body.install.version, 32);
  const rows = body.events.map((event) => eventRow(event, { install, version, now })).filter(Boolean);
  if (!rows.length) return reply(400, { error: "no event of a known kind (session, run, call, model_error, feedback)" });

  // A per-install daily cap: a broken loop in one app, or someone replaying ids, cannot
  // fill the database. Refused with 429 so the app keeps the events and tries tomorrow.
  const today = utcDay(now);
  const counted = await db.prepare("SELECT COUNT(*) AS n FROM tel_event WHERE install = ?1 AND day = ?2").bind(install, today).first();
  if ((Number(counted?.n) || 0) + rows.length > DAILY_EVENT_CAP) {
    return { status: 429, headers: { ...headers(), "retry-after": "3600" }, json: { error: "daily event cap reached for this install" } };
  }

  const runs = rows.filter((r) => r.kind === "run");
  const totals = {
    sessions: rows.filter((r) => r.kind === "session").length,
    runs: runs.length,
    failed: runs.filter((r) => r.status === "failed").length,
    tokensIn: runs.reduce((sum, r) => sum + (r.tokens_in ?? 0), 0),
    tokensOut: runs.reduce((sum, r) => sum + (r.tokens_out ?? 0), 0),
    reports: rows.filter((r) => r.kind === "feedback" && r.status === "bad").length,
  };
  const lastSeen = Math.max(...rows.map((r) => Math.min(r.stamp, now)));

  const statements = [
    db
      .prepare(UPSERT_INSTALL)
      .bind(
        install,
        lastSeen,
        version,
        short(body.install.platform, 16),
        short(body.install.arch, 16),
        short(body.install.os, 64),
        totals.sessions,
        totals.runs,
        totals.failed,
        totals.tokensIn,
        totals.tokensOut,
        totals.reports,
      ),
    ...rows.map((row) => db.prepare(INSERT_EVENT).bind(...EVENT_COLUMNS.map((c) => row[c] ?? null))),
  ];
  await db.batch(statements);
  return reply(200, { ok: true, stored: rows.length });
}
