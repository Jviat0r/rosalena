// rosa-rate-limit-failover - Rosalena's rate-limit record and failover notes.
//
// What this can and cannot do, said first because the difference is the honest
// part of a port:
//
//   * DSH's version hooks the agent's request-error waterfall, calls the session
//     controller's `selectModel` and re-runs the failed step, so a turn survives a
//     429. A Rosalena plugin has neither seam: `llm/stream` is an observer whose
//     return value is ignored, and `beforeStep` can only re-target the call that
//     comes NEXT - never the one that just died. A step that fails here ends its
//     run, and no plugin can rewind that.
//   * It also does not need to fail over inside a single call: the router on port
//     8077 already walks each task class's chain and falls back on its own, which
//     is why a cloud 429 sometimes looks like a slow answer and nothing more.
//
// What the router cannot do is remember. Its state is per-request: it does not know
// that a provider's shared budget is gone for a day, so every new run walks into
// the same wall and spends its retry budget there first. That memory is this
// plugin - one record per provider route, on disk, shared by every run in every
// process, plus an opinion about where the next call should go.
//
// Everything reported is read from that record or measured by the loop. The one
// number that is a guess - the reset time - is labelled "estimate" wherever it
// appears, because no gateway in this stack sends a reset time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The wording gateways use when an account is out of budget. Matched
// case-insensitively against the error the loop reports, which is all a plugin
// ever gets to see: no provider status code reaches it.
export const DEFAULT_PATTERNS = [
  "FreeUsageLimitError",
  "GoUsageLimitError",
  "Rate limit exceeded",
  "usage limit",
  "Insufficient account funds",
  "insufficient_quota",
  "quota exceeded",
  "out of budget",
];

// 500-class outages are a different animal: they self-heal in seconds, they are
// not a budget problem, and giving them a 24-hour window would strand a route for
// a day over one bad minute. They get their own short window. The bare numbers are
// matched with boundaries so a token count like "1500" cannot look like a 500.
const SERVER_PATTERNS = [/(^|[^0-9])(500|502|503|504)([^0-9]|$)/, "server_error", "endpoint is unavailable", "TIMEOUT", "TRANSPORT", "NETWORK"];

const HOUR = 3_600_000;
const MINUTE = 60_000;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** First pattern that matches, or null. RegExp entries are tested as they are. */
function firstMatch(list, text) {
  const raw = String(text ?? "");
  if (!raw) return null;
  const lower = raw.toLowerCase();
  for (const pattern of list) {
    if (pattern instanceof RegExp) {
      if (pattern.test(raw)) return String(pattern);
    } else if (lower.includes(String(pattern).toLowerCase())) {
      return String(pattern);
    }
  }
  return null;
}

/**
 * Is this failure a budget cap, a server-class outage, or something else?
 *
 * Usage patterns are tested first on purpose: a quota error can arrive inside a
 * 429 body that also mentions a server error, and the budget is the one that will
 * not clear in ten minutes.
 */
export function classifyFailure(text, patterns = DEFAULT_PATTERNS) {
  const usage = firstMatch(patterns, text);
  if (usage) return { kind: "usage", matched: usage };
  const server = firstMatch(SERVER_PATTERNS, text);
  if (server) return { kind: "server", matched: server };
  return null;
}

/** "local/qwen3.8-27b" -> "local". A class-routed call has no target, so: null. */
export function routeOf(target) {
  const text = str(target);
  const cut = text.indexOf("/");
  return cut > 0 ? text.slice(0, cut) : null;
}

/**
 * Recover a "provider/model" from an error message, because a failed call usually
 * has no target (the router picked it) and the provider is the only thing worth
 * attributing a hit to. Best effort by design: no match means the hit is recorded
 * under "(unknown)" rather than quietly dropped.
 */
export function targetFromText(text) {
  // The model half stops at punctuation on purpose: an error line reads
  // "opencode-free/glm-5.3-flash-free: FreeUsageLimitError", and the colon belongs
  // to the sentence, not to the model name.
  const match = /([a-z][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)(?![a-z0-9._-])/i.exec(String(text ?? ""));
  return match ? `${match[1]}/${match[2]}` : null;
}

export function emptyRecord() {
  return { version: 1, routes: {} };
}

const deadlineOf = (entry) => num(entry?.windowEndsAt, 0);

/**
 * Fold one hit into the record. Pure: it returns a new record and never writes.
 *
 * The window rules are the whole point of the exercise:
 *   - the first hit of a window freezes `firstHitAt`, so the estimate does not
 *     slide forward with every retry and a reader can plan around it;
 *   - an expired window starts over on the next hit;
 *   - a usage cap arriving on a route that was only cooling from a server error
 *     replaces that short window with the long one instead of inheriting its start.
 */
export function recordHit(record, { at, route, model, kind, resetHours = 24, cooldownMinutes = 10, reason = "" } = {}) {
  const base = record && typeof record === "object" && record.routes && typeof record.routes === "object" ? record : emptyRecord();
  const key = str(route);
  if (!key) return base;
  const now = num(at, Date.now());
  const prev = base.routes[key] && typeof base.routes[key] === "object" ? base.routes[key] : null;
  const windowMs = kind === "server" ? Math.max(1, cooldownMinutes) * MINUTE : Math.max(1, resetHours) * HOUR;
  const upgrade = kind === "usage" && prev?.kind === "server";
  const fresh = !prev || now >= deadlineOf(prev) || upgrade;
  const models = [...new Set([...(prev?.models ?? []), ...(str(model) ? [str(model)] : [])])];
  const entry = fresh
    ? { kind, firstHitAt: now, windowEndsAt: now + windowMs, hits: 1, lastHitAt: now, models, reason }
    : {
        ...prev,
        hits: num(prev.hits, 0) + 1,
        lastHitAt: now,
        // A longer window is never shortened by a shorter kind arriving mid-window.
        kind: prev.kind === "usage" ? "usage" : kind,
        models,
        reason: str(reason) || str(prev.reason),
      };
  return { ...base, routes: { ...base.routes, [key]: entry } };
}

/** The entries whose window is still open, newest first hit first. */
export function activeLimits(record, now = Date.now()) {
  const routes = record?.routes ?? {};
  return Object.entries(routes)
    .map(([route, entry]) => ({
      route,
      kind: entry?.kind === "server" ? "server" : "usage",
      firstHitAt: num(entry?.firstHitAt, 0),
      windowEndsAt: deadlineOf(entry),
      hits: num(entry?.hits, 0),
      models: Array.isArray(entry?.models) ? entry.models : [],
      reason: str(entry?.reason),
    }))
    .filter((entry) => entry.windowEndsAt > now)
    .sort((a, b) => b.windowEndsAt - a.windowEndsAt);
}

/** ISO to the minute in UTC: one shape, so two reports of the same record match. */
function utc(ms) {
  const d = new Date(num(ms, 0));
  return `${d.toISOString().slice(0, 16)}Z`;
}

/** "23h 12m", "4m" - a duration a person can compare against a clock. */
export function formatLeft(ms) {
  const total = Math.max(0, Math.round(num(ms, 0) / MINUTE));
  const hours = Math.floor(total / 60);
  return hours > 0 ? `${hours}h ${total % 60}m` : `${total}m`;
}

/**
 * The record as text. `now` and `stateFile` are parameters rather than reads so the
 * same record always prints the same thing, and a test can pin the clock.
 */
export function formatStatus(record, now = Date.now(), { stateFile = "", fallback = "" } = {}) {
  const routes = Object.entries(record?.routes ?? {});
  const active = activeLimits(record, now);
  const lines = [];
  lines.push(
    active.length
      ? `${active.length} provider route${active.length === 1 ? "" : "s"} limited right now${fallback ? ` - new calls are kept off ${active.map((e) => e.route).join(", ")} and sent to ${fallback}` : ""}`
      : "no provider route is limited right now",
  );
  if (stateFile) lines.push(`  record: ${stateFile} (${routes.length} route${routes.length === 1 ? "" : "s"} seen)`);
  for (const entry of active) {
    const window = entry.kind === "server" ? "server-class cooldown" : "usage limit";
    lines.push(`  ${entry.route.padEnd(16)} ${window}  ${entry.hits} hit${entry.hits === 1 ? "" : "s"}${entry.models.length ? `, models ${entry.models.join(", ")}` : ""}`);
    const first = entry.kind === "server" ? "first at" : "first hit";
    const until = entry.kind === "server" ? "window ends" : "estimated reset";
    lines.push(`  ${"".padEnd(16)} ${first} ${utc(entry.firstHitAt)}, ${until} ${utc(entry.windowEndsAt)} (${formatLeft(entry.windowEndsAt - now)} left)`);
  }
  for (const [route, entry] of routes) {
    if (deadlineOf(entry) > now) continue;
    lines.push(`  ${route.padEnd(16)} expired at ${utc(deadlineOf(entry))}${entry.kind === "server" ? " (server class)" : " (usage limit)"}`);
  }
  if (!routes.length) lines.push("  nothing recorded yet: an entry is written the first time a call fails on a route");
  return lines.join("\n");
}

/** A missing or unreadable record is an empty record - never a thrown error. */
export function readState(path) {
  try {
    if (!path || !existsSync(path)) return emptyRecord();
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyRecord();
    if (!parsed.routes || typeof parsed.routes !== "object" || Array.isArray(parsed.routes)) return emptyRecord();
    return { version: 1, routes: parsed.routes };
  } catch {
    return emptyRecord();
  }
}

/** Best effort: a record that cannot be saved must not break the run that hit it. */
export function writeState(path, record) {
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

const patternsOf = (config) => (Array.isArray(config?.patterns) && config.patterns.length ? config.patterns.map(String) : DEFAULT_PATTERNS);

export function statePathOf(ctx) {
  return str(ctx?.config?.stateFile) || join(str(ctx?.root) || process.cwd(), ".rate-limits.json");
}

// One record per state file, shared by every hook of this plugin in this process.
// Reading the file per call would be honest but wasteful; the file is the shared
// copy across processes, this Map is the shared copy inside one.
const cache = new Map();
function loadState(ctx) {
  const path = statePathOf(ctx);
  if (!cache.has(path)) cache.set(path, readState(path));
  return cache.get(path);
}
function storeState(ctx, record) {
  const path = statePathOf(ctx);
  cache.set(path, record);
  writeState(path, record);
  return record;
}

export default {
  id: "rosa-rate-limit-failover",
  description:
    "Keeps a persistent, per-route record of provider usage-limit and 500-class failures, reports it, and keeps the next call off a route that is still out of budget",

  // The record is read at load so status() can answer immediately. Nothing is
  // written here: loading a plugin must never create a file.
  setup(ctx) {
    loadState(ctx);
  },

  status(ctx) {
    const config = ctx?.config ?? {};
    const record = loadState(ctx);
    const active = activeLimits(record, Date.now());
    const where = statePathOf(ctx);
    const tail = str(config.fallback) ? `, fallback ${config.fallback}` : ", record only";
    if (!active.length) return `no route limited, record ${where}${tail}`;
    return `${active.map((e) => e.route).join(", ")} limited${tail}`;
  },

  tools(ctx) {
    return [
      {
        name: "rate_limit_status",
        description:
          "Report the global provider rate-limit record: which routes are out of budget or cooling down, the first hit of the window, the estimated reset (a guess - no gateway sends one), hit counts and the models seen failing. Read-only.",
        parameters: { type: "object", properties: {} },
        run() {
          return formatStatus(loadState(ctx), Date.now(), { stateFile: statePathOf(ctx), fallback: str(ctx?.config?.fallback) });
        },
      },
    ];
  },

  commands(ctx) {
    return {
      status: async () => formatStatus(loadState(ctx), Date.now(), { stateFile: statePathOf(ctx), fallback: str(ctx?.config?.fallback) }),
      clear: async () => {
        storeState(ctx, emptyRecord());
        return `record cleared: ${statePathOf(ctx)}`;
      },
    };
  },

  hooks(ctx) {
    const config = ctx?.config ?? {};
    const patterns = patternsOf(config);
    const resetHours = num(config.resetHours, 24);
    const cooldownMinutes = num(config.cooldownMinutes, 10);

    return {
      // The only place a hit can be seen. Observer semantics: this returns nothing,
      // so the call it describes is never changed by it - that is the price of a
      // plugin that cannot intercept, and the loop's own error is still the one the
      // run reports.
      "llm/stream": (info) => {
        if (info?.phase !== "end" || info?.ok) return undefined;
        const failure = classifyFailure(`${str(info?.error)} ${str(info?.reason)}`, patterns);
        if (!failure) return undefined;
        const target = str(info?.target) || targetFromText(info?.error) || "";
        const route = routeOf(target) || "(unknown)";
        const record = recordHit(loadState(ctx), {
          at: Date.now(),
          route,
          model: target.slice(target.indexOf("/") + 1),
          kind: failure.kind,
          resetHours,
          cooldownMinutes,
          reason: str(info?.error).slice(0, 200) || failure.matched,
        });
        storeState(ctx, record);
        // Remember it for this run too, so the next step knows before the router
        // does. A usage cap never clears faster than the step loop, so this is not
        // a guess that ages badly.
        const entry = record.routes?.[route];
        if (info?.run?.state && entry) info.run.state.set("lost", { route, until: deadlineOf(entry), kind: failure.kind });
        return undefined;
      },

      // The advice half. Two ways to use it, because there are two honest ones:
      // this run lost a call to a limit (targeted, cheap), or a route is limited
      // and the reader asked for every run to stay off it (blunt, opt-in).
      beforeStep(info) {
        const fallback = str(config.fallback);
        if (!fallback) return undefined;
        const state = info?.run?.state;
        const lost = state && typeof state.get === "function" ? state.get("lost") : null;
        if (lost) {
          state.delete("lost");
          // Absolute times only: a note that counts down would change every step and
          // invalidate the provider's prompt cache for no gain.
          return {
            model: fallback,
            note: `Routing: ${lost.route} is out of ${lost.kind === "server" ? "a server-class outage (estimated to end)" : "budget (estimated reset)"} at ${utc(lost.until)}. This step runs on ${fallback} instead; the run keeps going.`,
          };
        }
        if (config.pinWhenLimited === true) {
          const active = activeLimits(loadState(ctx), Date.now());
          if (active.length && !active.some((entry) => routeOf(fallback) === entry.route)) {
            return { model: fallback };
          }
        }
        return undefined;
      },
    };
  },
};
