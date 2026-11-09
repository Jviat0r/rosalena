/**
 * rosa-opencode-handler - OpenCode Zen's free tier, made visible from Rosalena.
 *
 * A client of the free tier has one job a harness can do for it: put the OpenCode client fingerprint and a `ses_`
 * session id on the wire, because the gateway answers
 *
 *   403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
 *
 * to anything that does not look like the official client - even with a valid key
 * and a real model id. In Rosalena that job lives in the router instead
 * (`router/src/providers.mjs`: requiresStream, clientHeaders, ensureTools), because
 * the router is the only process that reaches the wire. What is left for a plugin
 * is the part a router cannot say: whether the tier is usable RIGHT NOW, which
 * models are free, what the last failure actually meant, and how to pin one of
 * those models.
 *
 * Three gates, all measured on 2026-10-20 against
 * https://opencode.ai/zen/v1/chat/completions and all checked in the router:
 *
 *   1. the request MUST stream (`stream: true`);
 *   2. it MUST carry the client fingerprint and a valid `ses_` session id;
 *   3. it MUST contain a tool named exactly `read` (`read_file` is a 403).
 *
 * This plugin never spends money: the probe asks for 16 tokens on a zero-priced
 * model and no paid model id is ever named. It is also never run on startup and
 * never run without a key, so loading the harness cannot make a network call.
 *
 * Commands (the harness dispatches `<plugin-id>:<command>`, so these are
 * `/opencode-free status`, `/opencode-free models`, ...):
 *
 *   status   probe the gateway and report: usable / exhausted / refused / key /
 *            error, the three gates, the free models, and the last failure with a
 *            reset estimate
 *   models   list the free models, their limits, and the router classes that name
 *            them (alias: who)
 *   use      make one free model first in a router class. Prints the exact change
 *            and writes nothing unless `--write` is given; a write is atomic, is
 *            validated before it replaces anything, and leaves a `.bak-` copy
 *   key      every key source, masked
 *   gates    the three gates as a checklist, read from the router config
 *   clear    forget this plugin's own observation record
 *
 * Hook: `llm/stream` records the last free-tier call and the last free-tier
 * failure from real runs, so `status` has evidence even when it is not probing.
 *
 * Tool: `free_model_status` (the status command for an agent).
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const PROVIDER = "opencode-free";
export const BASE_URL = "https://opencode.ai/zen/v1";
export const USER_AGENT = "opencode/latest/2.0.29/cli";
/** The id shape the gateway validates: `ses_` + 12 lowercase hex + 14 base62. */
export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SES_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * What the free tier serves, as DSH's own free route declares it
 * (`cordis.patch.yml`: contextWindow 200000, maxTokens 65536, text+image).
 *
 * These are the fallback. When the router config carries `providers[].models`,
 * that file wins; a plugin that disagrees with the router would be reporting a
 * menu nobody routes to.
 */
export const FREE_MODELS = [
  {
    id: "deepseek-v4.1-flash-free",
    label: "DeepSeek V4.1 Flash Free",
    contextWindow: 200000,
    maxTokens: 65536,
    input: ["text", "image"],
    note: "reasoning model: DSH's free route asks for reasoning_effort high and requires reasoning content on assistant turns",
  },
  {
    id: "glm-5.3-flash-free",
    label: "GLM-5.3 Flash Free",
    contextWindow: 200000,
    maxTokens: 65536,
    input: ["text", "image"],
    note: "same free window as the DeepSeek id",
  },
];

export const DEFAULTS = {
  baseUrl: BASE_URL,
  /** The id the probe names. A free model only - a probe must never cost money. */
  probeModel: "deepseek-v4.1-flash-free",
  timeoutMs: 20000,
  userAgent: USER_AGENT,
  /** The class `use` edits when the caller does not name one. */
  defaultClass: "fast",
  /** A stable conversation id; hashed into the `ses_` form the gateway accepts. */
  sessionId: "rosalena-opencode-free",
  /** Empty means `<root>/.opencode-handler.json`, beside the other plugin records. */
  stateFile: "",
  /** Empty means `router/router.config.json` (or its sibling), discovered. */
  routerFile: "",
  /** Read DSH's free-tier record when it exists, so a 429 seen by DSH is not invisible here. */
  includeDsh: false,
  /** Empty means `~/.dsh/rate-limits.json`. */
  dshRateLimitsFile: "",
  keyEnv: "OPENCODE_API_KEY",
};

/** A tool whose function name is exactly `read` is the third gate. */
const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file and return its contents.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path to read" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

/** The probe's whole body. Small, free, streamed, and carrying the `read` tool. */
export function probeRequest(model = DEFAULTS.probeModel) {
  return {
    model,
    stream: true,
    max_tokens: 16,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    tools: [READ_TOOL],
    tool_choice: "auto",
  };
}

/** Derive a valid session token from any string, the way the router does. */
export function sessionToken(raw = DEFAULTS.sessionId) {
  const digest = createHash("sha256").update(String(raw ?? "")).digest();
  const hex = digest.subarray(0, 6).toString("hex");
  const suffix = Array.from(digest.subarray(6, 20), (b) => SES_CHARS[b % 62]).join("");
  return `ses_${hex}${suffix}`;
}

/** Accept a caller's id only when it already has the wire shape; hash it otherwise. */
export function normalizeSessionId(raw) {
  const text = String(raw ?? "").trim();
  if (SESSION_RE.test(text)) return text;
  return sessionToken(text || DEFAULTS.sessionId);
}

/**
 * The headers the OpenCode client sends, byte for byte the set the router builds
 * (`router/src/providers.mjs` openCodeHeaders). Four names carry one session id.
 */
export function freeTierHeaders(sessionId = DEFAULTS.sessionId, { userAgent, key } = {}) {
  const token = normalizeSessionId(sessionId);
  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-opencode-session": token,
    "x-session-affinity": token,
    "x-opencode-session-id": token,
    "x-session-id": token,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "user-agent": userAgent || USER_AGENT,
  };
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

const reason = (err) => String(err?.message ?? err ?? "unknown error");
const str = (value) => (typeof value === "string" ? value.trim() : "");
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function absolute(p, root) {
  return isAbsolute(p) ? p : resolve(root, p);
}

/** A UTC stamp a person can read and a filename can hold. */
export function formatTime(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return "-";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "now";
  const mins = Math.round(n / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/**
 * A timestamp from a record, whichever way it was written.
 *
 * This plugin writes epoch milliseconds, DSH writes ISO strings, and a person may
 * have edited either. Turning both into one number here is what makes a 429 DSH
 * saw visible in a status line this plugin prints.
 */
export function toTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Enough of a key to recognise it, never enough to use it. */
export function maskKey(key) {
  const text = String(key ?? "").trim();
  if (!text) return "";
  if (text.length <= 10) return "***";
  return `${text.slice(0, 5)}...${text.slice(-4)}`;
}

/**
 * Every place a key can come from, in the order they are tried.
 *
 * `router/data/keys.json` is the router's own store ({"providers": {"opencode-free":
 * ["oc_sk_..."]}}); `~/.dsh/.credentials.yaml` belongs to DeepSeek Harness, a separate app; it is read
 * only when `includeDsh: true` is set, for someone who keeps the key there.
 */
export function keySources(ctx = {}) {
  const root = str(ctx.root) || process.cwd();
  const cfg = { ...DEFAULTS, ...(isPlainObject(ctx.config) ? ctx.config : {}) };
  const sources = [];
  const configured = str(cfg.apiKey);
  if (configured) sources.push({ name: "plugin.json config apiKey", kind: "config", value: configured });
  const envName = str(cfg.keyEnv) || DEFAULTS.keyEnv;
  const envValue = str(process.env[envName]);
  if (envValue) sources.push({ name: `${envName} (environment)`, kind: "env", value: envValue });
  for (const file of [join(root, "router", "data", "keys.json"), join(root, "..", "router", "data", "keys.json")]) {
    const keys = readKeysFrom(file, PROVIDER);
    for (const value of keys) sources.push({ name: `${file} (${PROVIDER})`, kind: "router", path: file, value });
  }
  if (cfg.includeDsh === true) {
    const file = str(cfg.dshCredentialsFile)
      ? absolute(cfg.dshCredentialsFile, root)
      : join(homedir(), ".dsh", ".credentials.yaml");
    const value = readYamlCredential(file, envName);
    if (value) sources.push({ name: `${file} (${envName})`, kind: "dsh", path: file, value });
  }
  return sources;
}

/** Read one provider's keys out of the router's key store. A broken store is empty. */
export function readKeysFrom(file, provider = PROVIDER) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const raw = parsed?.providers?.[provider];
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return values.map((value) => String(value ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** A `KEY: value` line out of DSH's credentials file, quotes and comments handled. */
export function readYamlCredential(file, name) {
  try {
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/);
      if (!match || match[1] !== name) continue;
      const value = match[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim();
      if (value) return value;
    }
  } catch {
    /* no file, no key: the caller reports which sources were tried */
  }
  return "";
}

/** The first key that exists, plus every source so `key` can show all of them. */
export function findKey(ctx = {}) {
  const sources = keySources(ctx);
  const picked = sources[0] ?? null;
  return { key: picked ? picked.value : "", source: picked ? picked.name : "", sources };
}

/**
 * Where the router config is. Same discovery the other model-aware plugin uses:
 * an explicit `routerFile` wins, then the two places a run can be launched from.
 */
export function resolveRouterFile({ root = process.cwd(), config = {}, exists = existsSync } = {}) {
  const configured = str(config.routerFile);
  if (configured) {
    const file = absolute(configured, root);
    return { file, exists: exists(file) };
  }
  const candidates = [
    join(root, "router", "router.config.json"),
    join(root, "..", "router", "router.config.json"),
  ];
  for (const file of candidates) {
    if (exists(file)) return { file, exists: true };
  }
  return { file: candidates[0], exists: false };
}

/** Read and parse the router config. A missing or broken file is a fact, not a throw. */
export function readRouter({ root = process.cwd(), config = {}, exists = existsSync, readFile = readFileSync } = {}) {
  const found = resolveRouterFile({ root, config, exists });
  if (!found.exists) {
    return {
      file: found.file,
      ok: false,
      config: null,
      problem: `there is no router config at ${found.file}`,
      hint: "start the router from the repo root, or set routerFile in harness.config.json",
    };
  }
  try {
    const parsed = JSON.parse(readFile(found.file, "utf8"));
    if (!isPlainObject(parsed)) throw new Error("the file is not a JSON object");
    return { file: found.file, ok: true, config: parsed, problem: null, hint: null };
  } catch (err) {
    return {
      file: found.file,
      ok: false,
      config: null,
      problem: `router config at ${found.file} is not valid JSON: ${reason(err)}`,
      hint: "fix the JSON before routing anything at it; this plugin will not touch it",
    };
  }
}

/**
 * The three gates, as facts read off the config, each with the fix when broken.
 *
 * The values are compared exactly because the router compares them exactly: a
 * truthy `"yes"` is not `true`, and a tool list without `read` is a 403.
 */
export function routerGates(config) {
  const provider = isPlainObject(config?.providers?.[PROVIDER]) ? config.providers[PROVIDER] : null;
  const gatesOf = (p) => [
    {
      id: "stream",
      label: "streams every request",
      ok: p?.requiresStream === true,
      detail: p?.requiresStream === true ? "requiresStream: true" : `requiresStream is ${JSON.stringify(p?.requiresStream ?? null)}`,
      fix: "set providers.opencode-free.requiresStream: true",
    },
    {
      id: "fingerprint",
      label: "sends the OpenCode client fingerprint and a ses_ session id",
      ok: p?.clientHeaders === "opencode",
      detail: p?.clientHeaders === "opencode" ? "clientHeaders: \"opencode\"" : `clientHeaders is ${JSON.stringify(p?.clientHeaders ?? null)}`,
      fix: "set providers.opencode-free.clientHeaders: \"opencode\"",
    },
    {
      id: "read-tool",
      label: "contains a tool named exactly read",
      ok: Array.isArray(p?.ensureTools) && p.ensureTools.some((name) => String(name).toLowerCase() === "read"),
      detail: Array.isArray(p?.ensureTools) && p.ensureTools.some((name) => String(name).toLowerCase() === "read")
        ? `ensureTools: ${JSON.stringify(p.ensureTools)}`
        : `ensureTools is ${JSON.stringify(p?.ensureTools ?? null)}`,
      fix: "set providers.opencode-free.ensureTools: [\"read\"]",
    },
  ];
  if (!provider) {
    return {
      provider: null,
      ok: false,
      gates: gatesOf(null),
      problem: `the router config has no providers.${PROVIDER}`,
      hint: "add the opencode-free provider block (see router/router.config.json)",
    };
  }
  const gates = gatesOf(provider);
  const bad = gates.filter((gate) => !gate.ok);
  const base = str(provider.baseUrl);
  const baseOk = base.replace(/\/+$/, "") === BASE_URL;
  if (!baseOk) {
    gates.push({
      id: "baseUrl",
      label: "points at OpenCode Zen",
      ok: false,
      detail: `baseUrl is ${JSON.stringify(base || null)}`,
      fix: `set providers.opencode-free.baseUrl: "${BASE_URL}"`,
    });
  }
  return {
    provider,
    ok: bad.length === 0 && baseOk,
    gates,
    problem: bad.length || !baseOk ? "the router would not open the free tier as configured" : null,
    hint: bad.length || !baseOk ? "fix the broken gate(s) above; the router re-reads its config on restart" : null,
  };
}

function declaredModels(provider) {
  const raw = Array.isArray(provider?.models) ? provider.models : [];
  return raw
    .map((entry) => (typeof entry === "string" ? { id: entry } : isPlainObject(entry) ? entry : null))
    .filter((entry) => str(entry?.id))
    .map((entry) => ({
      id: str(entry.id),
      label: str(entry.label) || str(entry.id),
      contextWindow: Number(entry.contextWindow) || null,
      maxTokens: Number(entry.maxTokens) || null,
      input: Array.isArray(entry.input) ? entry.input.map(String) : null,
      note: str(entry.note) || str(entry.$note) || "",
      source: "router",
    }));
}

/**
 * The free models this plugin reports.
 *
 * The router's `providers[].models` is documentation (nothing in the router reads
 * it), so it is authoritative for what the operator wrote and the built-in list is
 * the fallback when the file is old. Merging by id keeps one row per model even
 * when both exist, and the curated `models[]` labels are used when the provider
 * entry has no label of its own.
 */
export function freeModels(config) {
  const provider = isPlainObject(config?.providers?.[PROVIDER]) ? config.providers[PROVIDER] : null;
  const curated = new Map(
    (Array.isArray(config?.models) ? config.models : [])
      .map((entry) => [str(entry?.target), entry])
      .filter(([target]) => target.startsWith(`${PROVIDER}/`)),
  );
  const rows = new Map();
  for (const model of FREE_MODELS) rows.set(model.id, { ...model, source: "builtin" });
  for (const model of declaredModels(provider)) {
    const curatedEntry = curated.get(`${PROVIDER}/${model.id}`);
    rows.set(model.id, {
      ...(rows.get(model.id) ?? {}),
      ...model,
      label: model.label || str(curatedEntry?.label) || model.id,
      note: model.note || str(curatedEntry?.note) || "",
    });
  }
  // A curated target with no provider/models row still deserves a line: a person
  // can pin it, so "it is free" is something the plugin should say.
  for (const [target, entry] of curated) {
    const id = target.slice(PROVIDER.length + 1);
    if (rows.has(id)) continue;
    rows.set(id, {
      id,
      label: str(entry?.label) || id,
      contextWindow: null,
      maxTokens: null,
      input: null,
      note: str(entry?.note) || "",
      source: "curated",
    });
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Which router classes name a target, in chain order. */
export function chainsFor(config, target) {
  const out = [];
  for (const [id, spec] of Object.entries(isPlainObject(config?.classes) ? config.classes : {})) {
    const chain = Array.isArray(spec?.chain) ? spec.chain.map(String) : [];
    if (chain.includes(target)) out.push({ id, index: chain.indexOf(target) + 1, size: chain.length });
  }
  return out;
}

/**
 * Parse a reset time out of a 429 response.
 *
 * The free window is 24 hours from its first hit (that is the shape DSH recorded),
 * but when the gateway states a time or a delay, the gateway is right and the
 * 24-hour guess is not. `resetSource` says which one was used, so a person can
 * tell a fact from an estimate.
 */
export function parseReset({ headers = {}, bodyText = "", now = Date.now(), firstFailureAt = null } = {}) {
  const lower = {};
  for (const [name, value] of Object.entries(headers ?? {})) lower[String(name).toLowerCase()] = value;
  const asTime = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      const parsed = Date.parse(String(value));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (n <= 0) return null;
    // Seconds since the epoch, seconds from now, or milliseconds since the epoch.
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return now + n * 1000;
  };
  const retryAfter = lower["retry-after"];
  if (retryAfter !== undefined) {
    const at = asTime(retryAfter);
    if (at) return { at, source: "Retry-After" };
  }
  for (const name of ["x-ratelimit-reset", "x-rate-limit-reset", "x-ratelimit-reset-requests"]) {
    if (lower[name] === undefined) continue;
    const at = asTime(lower[name]);
    if (at) return { at, source: name };
  }
  if (str(bodyText)) {
    let body = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      /* an error body is not always JSON; the text scan below still helps */
    }
    const pick = (value, isMs) => {
      if (value === undefined || value === null || value === "") return null;
      if (!isMs) return asTime(value);
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? now + n : null;
    };
    const candidates = [
      pick(body?.error?.resets_at, false),
      pick(body?.error?.reset_at, false),
      pick(body?.error?.retry_after, false),
      pick(body?.error?.retry_after_ms, true),
      pick(body?.resets_at, false),
      pick(body?.reset_at, false),
      pick(body?.retry_after, false),
      pick(body?.retry_after_ms, true),
    ];
    for (const at of candidates) {
      if (at) return { at, source: "response body" };
    }
  }
  if (Number.isFinite(Number(firstFailureAt)) && Number(firstFailureAt) > 0) {
    return { at: Number(firstFailureAt) + 24 * 60 * 60 * 1000, source: "estimate (24h window from the first hit)" };
  }
  return { at: null, source: null };
}

const EXHAUSTED_RE = /FreeUsageLimitError|Rate limit exceeded|usage limit|too many requests|\b429\b/i;
const REFUSED_RE = /FreeTierError|free tier can only be used|can only be used from within OpenCode/i;
const KEY_RE = /\b401\b|invalid (?:api )?key|unauthorized|authentication/i;

/** What a failure text means, in the same vocabulary as a probe verdict. */
export function classifyFailure(text) {
  const body = String(text ?? "");
  if (EXHAUSTED_RE.test(body)) return { verdict: "exhausted", status: 429, detail: "the free window is spent (429 FreeUsageLimitError)" };
  if (REFUSED_RE.test(body)) return { verdict: "refused", status: 403, detail: "a gate is unsatisfied, not the key (403 FreeTierError)" };
  if (KEY_RE.test(body)) return { verdict: "key", status: 401, detail: "the gateway rejected the credential (401)" };
  return { verdict: "error", status: 0, detail: "the call failed for a reason that is not the free tier" };
}

function bodySnippet(bodyText, limit = 240) {
  return String(bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * Turn an HTTP answer into one verdict, never merged.
 *
 * `usable` is only claimed for a 200 whose body looks like an OpenAI stream or
 * completion; a 200 with an HTML error page is `error`, because claiming usable
 * there would send someone to route work at a broken endpoint.
 */
export function classifyProbe({ status = 0, headers = {}, bodyText = "", now = Date.now(), firstFailureAt = null } = {}) {
  const snippet = bodySnippet(bodyText);
  if (status === 200) {
    const looksRight = /"choices"|^data:\s*\{/m.test(String(bodyText ?? ""));
    if (looksRight) return { verdict: "usable", status, detail: "the gateway streamed a reply with all three gates satisfied" };
    return { verdict: "error", status, detail: `HTTP 200 but the body is not an OpenAI completion or stream: ${snippet || "(empty)"}` };
  }
  if (status === 429 || EXHAUSTED_RE.test(snippet)) {
    const reset = parseReset({ headers, bodyText, now, firstFailureAt });
    return {
      verdict: "exhausted",
      status: status || 429,
      detail: "the free window is spent (429 FreeUsageLimitError); every request from this IP shares it",
      resetAt: reset.at,
      resetSource: reset.source,
    };
  }
  if (status === 403 || REFUSED_RE.test(snippet)) {
    return {
      verdict: "refused",
      status: status || 403,
      detail: "a gate is unsatisfied, not the key (403 FreeTierError); re-adding the key will not help",
      resetAt: null,
      resetSource: null,
    };
  }
  if (status === 401) {
    return { verdict: "key", status, detail: "the gateway rejected the credential (401); the key is missing, revoked or for another provider" };
  }
  return { verdict: "error", status, detail: `unexpected answer (HTTP ${status || "none"}): ${snippet || "(empty body)"}` };
}

/**
 * One real request against the gateway, with all three gates.
 *
 * The body is read to completion: a 16-token stream is small, and a status line
 * that only knows the HTTP code cannot tell a stream from a JSON error. Nothing
 * is retried - a probe is a measurement, and measuring twice spends the window.
 */
export async function probe({ baseUrl = BASE_URL, model = DEFAULTS.probeModel, key = "", sessionId = DEFAULTS.sessionId, userAgent = USER_AGENT, timeoutMs = DEFAULTS.timeoutMs, fetchImpl = fetch, now = Date.now(), firstFailureAt = null } = {}) {
  if (!key) return { verdict: "nokey", status: 0, detail: "no OpenCode key found, so nothing was sent", ms: 0, resetAt: null, resetSource: null };
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULTS.timeoutMs));
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: freeTierHeaders(sessionId, { userAgent, key }),
      body: JSON.stringify(probeRequest(model)),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    const headers = res.headers && typeof res.headers.entries === "function" ? Object.fromEntries(res.headers.entries()) : (res.headers ?? {});
    const verdict = classifyProbe({ status: Number(res.status) || 0, headers, bodyText, now, firstFailureAt });
    return { ...verdict, ms: Date.now() - started, body: bodySnippet(bodyText), model };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      verdict: "error",
      status: 0,
      detail: aborted ? `the probe timed out after ${timeoutMs}ms` : `the probe could not reach ${url}: ${reason(err)}`,
      ms: Date.now() - started,
      resetAt: null,
      resetSource: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Where this plugin keeps what it observed. */
export function statePathOf(ctx = {}) {
  const root = str(ctx.root) || process.cwd();
  const cfg = { ...DEFAULTS, ...(isPlainObject(ctx.config) ? ctx.config : {}) };
  return str(cfg.stateFile) ? absolute(cfg.stateFile, root) : join(root, ".opencode-handler.json");
}

/** A record that cannot be read is empty, with the reason kept for the status line. */
export function loadState(path) {
  try {
    if (!existsSync(path)) return { state: {}, problem: null };
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return { state: {}, problem: `${path} is not a JSON object` };
    return { state: parsed, problem: null };
  } catch (err) {
    return { state: {}, problem: `${path} could not be read: ${reason(err)}` };
  }
}

/** Atomic state write: a temp file in the same directory, then a rename. */
export function saveState(path, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the rename error is the one worth reporting */
    }
    throw err;
  }
  return { path, bytes: Buffer.byteLength(text) };
}

/**
 * Record a failure observed by this plugin.
 *
 * `firstFailureAt` is only set once: the 24-hour estimate is measured from the
 * window's first hit, not from the most recent 429, so overwriting it would move
 * the reset later on every retry - the opposite of useful.
 */
export function recordFailure(path, { verdict, status, detail, at = Date.now(), model = null, resetAt = null, resetSource = null } = {}) {
  const { state } = loadState(path);
  const next = {
    ...state,
    version: 1,
    firstFailureAt: toTime(state.firstFailureAt) ?? at,
    lastFailure: { verdict, status, detail, at, model, resetAt, resetSource },
    observations: (Number(state.observations) || 0) + 1,
    updatedAt: at,
  };
  saveState(path, next);
  return next;
}

/** Record a free-tier call that worked. A failure record is kept: it is evidence. */
export function recordSuccess(path, { at = Date.now(), model = null, ms = null } = {}) {
  const { state } = loadState(path);
  const next = {
    ...state,
    version: 1,
    lastSuccess: { at, model, ms },
    observations: (Number(state.observations) || 0) + 1,
    updatedAt: at,
  };
  saveState(path, next);
  return next;
}

/** DSH's own free-tier record, when it exists. Read-only; this plugin never writes it. */
export function loadDshRecord({ includeDsh = true, file = "", root = process.cwd() } = {}) {
  if (includeDsh === false) return { record: null, file: null };
  const path = file ? absolute(file, root) : join(homedir(), ".dsh", "rate-limits.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const limits = isPlainObject(parsed?.limits) ? parsed.limits : {};
    const entry =
      limits[PROVIDER] ??
      Object.values(limits).find((candidate) => str(candidate?.provider) === PROVIDER) ??
      null;
    if (!entry) return { record: null, file: path };
    return {
      record: {
        source: path,
        lastHitAt: toTime(entry.lastHitAt),
        firstHitAt: toTime(entry.firstHitAt),
        resetEstimateAt: toTime(entry.resetEstimateAt),
        hits: Number(entry.hits) || 0,
        reason: str(entry.reason),
      },
      file: path,
    };
  } catch {
    return { record: null, file: path };
  }
}

/** The newest failure any source knows about, with where it came from. */
export function lastFailure({ state = {}, dsh = null, now = Date.now() } = {}) {
  const own = isPlainObject(state?.lastFailure) ? state.lastFailure : null;
  const candidates = [];
  if (own && toTime(own.at) > 0) {
    candidates.push({
      at: toTime(own.at),
      verdict: str(own.verdict) || "error",
      status: Number(own.status) || 0,
      detail: str(own.detail),
      model: str(own.model) || null,
      resetAt: toTime(own.resetAt),
      resetSource: str(own.resetSource) || null,
      source: "this plugin",
      hits: null,
    });
  }
  if (dsh && toTime(dsh.lastHitAt) > 0) {
    candidates.push({
      at: toTime(dsh.lastHitAt),
      verdict: classifyFailure(dsh.reason).verdict,
      status: classifyFailure(dsh.reason).status,
      detail: dsh.reason || "free-tier failure",
      model: null,
      resetAt: toTime(dsh.resetEstimateAt),
      resetSource: "DSH estimate",
      source: dsh.source,
      hits: dsh.hits,
    });
  }
  candidates.sort((a, b) => b.at - a.at);
  const winner = candidates[0] ?? null;
  if (winner && !winner.resetAt && toTime(state?.firstFailureAt) > 0) {
    winner.resetAt = toTime(state.firstFailureAt) + 24 * 60 * 60 * 1000;
    winner.resetSource = "estimate (24h window from the first hit)";
  }
  return winner;
}

function resetText(failure, now) {
  if (!failure?.resetAt) return "no reset time known; probe to find out";
  const when = formatTime(failure.resetAt);
  const source = failure.resetSource ? `, ${failure.resetSource}` : "";
  if (failure.resetAt <= now) return `${when} (${formatDuration(now - failure.resetAt)} ago${source}) - the window should have reset, but only a probe knows`;
  return `${when} (in ${formatDuration(failure.resetAt - now)}${source})`;
}

function gateLines(gates) {
  return gates.map((gate) => `    ${gate.ok ? "ok  " : "FAIL"}  ${gate.label} [${gate.detail}]${gate.ok ? "" : ` -> ${gate.fix}`}`);
}

function modelsLine(models) {
  return models.map((model) => {
    const limits = model.contextWindow || model.maxTokens ? ` [${model.contextWindow ?? "?"} ctx / ${model.maxTokens ?? "?"} out]` : "";
    return `    ${model.id}  ${model.label}${limits}`;
  });
}

function keyLine(found) {
  if (!found.key) return "  key: none found - checked the environment and router/data/keys.json";
  return `  key: ${maskKey(found.key)} from ${found.source}`;
}

/** The full report. Everything it says is read from a file or measured by the probe. */
export async function statusReport(ctx = {}, { fetchImpl = fetch, now = Date.now() } = {}) {
  // `ctx.fetchImpl` is the test-only injection the other network-touching plugins
  // use; the loader never sets it, so production always drains to global fetch.
  const doFetch = typeof ctx.fetchImpl === "function" ? ctx.fetchImpl : fetchImpl;
  const root = str(ctx.root) || process.cwd();
  const cfg = { ...DEFAULTS, ...(isPlainObject(ctx.config) ? ctx.config : {}) };
  const router = readRouter({ root, config: cfg });
  const config = router.config;
  const provider = isPlainObject(config?.providers?.[PROVIDER]) ? config.providers[PROVIDER] : null;
  const gates = router.ok ? routerGates(config) : { ok: false, gates: routerGates(null).gates, problem: router.problem, hint: router.hint };
  const models = freeModels(config);
  const found = findKey(ctx);
  const statePath = statePathOf(ctx);
  const loadedState = loadState(statePath);
  let state = loadedState.state;
  const stateProblem = loadedState.problem;
  const dsh = loadDshRecord({ includeDsh: cfg.includeDsh === true, file: cfg.dshRateLimitsFile, root });
  let failure = lastFailure({ state, dsh: dsh.record, now });

  const lines = [`opencode-handler: ${PROVIDER} at ${str(cfg.baseUrl) || BASE_URL}`];
  if (router.ok) {
    lines.push(`  router: ${router.file}`);
    if (gates.problem) {
      lines.push(`  gates: BROKEN - ${gates.problem}`);
      lines.push(...gateLines(gates.gates));
      if (gates.hint) lines.push(`    fix: ${gates.hint}`);
    } else {
      lines.push(`  gates: all three satisfied (stream, client fingerprint + ses_ id, read tool)`);
      lines.push(...gateLines(gates.gates));
    }
  } else {
    lines.push(`  router: UNKNOWN - ${router.problem}`);
    if (router.hint) lines.push(`    fix: ${router.hint}`);
    lines.push("  gates: cannot be checked without a router config; the three gates are unchanged:");
    for (const gate of routerGates(null).gates) lines.push(`    - ${gate.label}${gate.fix ? ` (${gate.fix})` : ""}`);
  }
  lines.push(`  free models here (${models.length}):`);
  lines.push(...modelsLine(models));
  lines.push(keyLine(found));
  // With no router config there are no gates to check, but the gateway can still
  // answer: a probe against the default URL is more useful than "unknown". With a
  // config whose gates are broken, the 403 is already explained above and a probe
  // would only spend a request to print it again.
  const canProbe = Boolean(found.key) && (router.ok ? gates.ok : true);
  if (!found.key) {
    lines.push("  probe: skipped - the free tier needs a credential even though it costs nothing");
  } else if (!canProbe) {
    lines.push("  probe: skipped - a broken gate would only produce a 403, which is already visible above");
  } else {
    if (!router.ok) lines.push("  probe: no router config, so this uses the default endpoint and gate settings");
    const firstFailureAt = toTime(state?.firstFailureAt);
    const result = await probe({
      baseUrl: str(provider?.baseUrl) || str(cfg.baseUrl) || BASE_URL,
      model: str(provider?.probeModel) || str(cfg.probeModel) || DEFAULTS.probeModel,
      key: found.key,
      sessionId: cfg.sessionId,
      userAgent: str(provider?.userAgent) || cfg.userAgent,
      timeoutMs: cfg.timeoutMs,
      fetchImpl: doFetch,
      now,
      firstFailureAt,
    });
    lines.push(`  probe: ${result.verdict.toUpperCase()} (HTTP ${result.status || "none"}, ${result.ms}ms) - ${result.detail}`);
    if (result.resetAt) lines.push(`  reset: ${resetText({ resetAt: result.resetAt, resetSource: result.resetSource }, now)}`);
    if (result.verdict === "usable") {
      try {
        recordSuccess(statePath, { at: now, model: result.model ?? null, ms: result.ms ?? null });
      } catch (err) {
        lines.push(`  record: could not write ${statePath}: ${reason(err)}`);
      }
    } else if (result.verdict === "exhausted" || result.verdict === "refused" || result.verdict === "key") {
      try {
        recordFailure(statePath, {
          verdict: result.verdict,
          status: result.status,
          detail: result.detail,
          at: now,
          model: result.model ?? null,
          resetAt: result.resetAt ?? null,
          resetSource: result.resetSource ?? null,
        });
      } catch (err) {
        lines.push(`  record: could not write ${statePath}: ${reason(err)}`);
      }
    }
    // The lines below describe the record as it stands AFTER this probe, so a 429
    // just measured appears here and a successful call shows its timestamp.
    state = loadState(statePath).state;
    failure = lastFailure({ state, dsh: dsh.record, now });
  }
  if (failure) {
    const hits = failure.hits ? `, ${failure.hits} hit(s)` : "";
    lines.push(`  last observed failure: ${failure.status || "?"} ${failure.verdict} at ${formatTime(failure.at)} (${failure.source}${hits}) - ${failure.detail}`);
    lines.push(`    reset: ${resetText(failure, now)}`);
  } else {
    lines.push("  last observed failure: none recorded by this plugin or DSH");
  }
  if (Number(state?.lastSuccess?.at) > 0) {
    const model = state.lastSuccess.model ? ` (${state.lastSuccess.model})` : "";
    lines.push(`  last good free call: ${formatTime(state.lastSuccess.at)}${model}`);
  }
  lines.push(`  record: ${statePath}${stateProblem ? ` - ${stateProblem}` : ` (${Number(state?.observations) || 0} observation(s))`}`);
  if (dsh.record) lines.push(`  also read: ${dsh.file} (DSH's free-tier record, read-only)`);
  return lines.join("\n");
}

/** `models` / `who`: what is free and what points at it. No network. */
export function modelsReport(ctx = {}) {
  const root = str(ctx.root) || process.cwd();
  const cfg = { ...DEFAULTS, ...(isPlainObject(ctx.config) ? ctx.config : {}) };
  const router = readRouter({ root, config: cfg });
  const config = router.config;
  const models = freeModels(config);
  const lines = [];
  if (router.ok) lines.push(`free models on ${PROVIDER} (${router.file}):`);
  else lines.push(`free models on ${PROVIDER} (built-in list; ${router.problem}):`);
  if (!models.length) {
    lines.push("  none known - add providers.opencode-free.models to the router config");
    return lines.join("\n");
  }
  const width = Math.max(...models.map((model) => model.id.length));
  for (const model of models) {
    const limits = model.contextWindow || model.maxTokens ? `${model.contextWindow ?? "?"} ctx / ${model.maxTokens ?? "?"} out` : "limits not declared";
    const chains = router.ok ? chainsFor(config, `${PROVIDER}/${model.id}`) : [];
    const where = !router.ok
      ? "class positions unknown (no router config)"
      : chains.length
        ? chains.map((chain) => `${chain.id} (#${chain.index}/${chain.size})`).join(", ")
        : "not in any class chain (pin it directly, or add it with `use`)";
    lines.push(`  ${model.id.padEnd(width)}  ${model.label}`);
    lines.push(`  ${"".padEnd(width)}  ${limits}; ${where}`);
    if (model.note) lines.push(`  ${"".padEnd(width)}  ${model.note}`);
  }
  lines.push(`pick one: /opencode-free use <id> [--class ${str(cfg.defaultClass) || DEFAULTS.defaultClass}] [--write]`);
  return lines.join("\n");
}

/**
 * Work out what `use` would do, without touching the disk.
 *
 * Accepts the full target, the bare id, the provider's own id, or a unique
 * prefix (`deepseek`), because all four are what a person types. Whatever is
 * accepted becomes the first target in one class chain; nothing is removed, so
 * the fallback that used to be first is still second.
 */
export function planUse({ config, model, classId = DEFAULTS.defaultClass, provider = PROVIDER } = {}) {
  const raw = str(model);
  if (!raw) return { ok: false, why: "no model given", hint: "try: /opencode-free use deepseek-v4.1-flash-free" };
  const classes = isPlainObject(config?.classes) ? config.classes : {};
  const ids = freeModels(config).map((entry) => entry.id);
  let wanted = raw;
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const namedProvider = raw.slice(0, slash);
    if (namedProvider !== provider) {
      return { ok: false, why: `"${raw}" is a ${namedProvider} target, not an ${provider} one`, hint: `this plugin only pins free models: ${ids.join(", ")}` };
    }
    wanted = raw.slice(slash + 1).trim();
  }
  if (!wanted) return { ok: false, why: "the target ends at the provider, with no model", hint: `try one of: ${ids.join(", ")}` };
  const exact = ids.find((id) => id.toLowerCase() === wanted.toLowerCase());
  const matches = exact ? [exact] : ids.filter((id) => id.toLowerCase().startsWith(wanted.toLowerCase()));
  if (!matches.length) {
    return {
      ok: false,
      why: `"${wanted}" is not a free model the router serves`,
      hint: `free models: ${ids.join(", ")}`,
      models: ids,
    };
  }
  if (matches.length > 1) return { ok: false, why: `"${wanted}" matches more than one free model`, hint: matches.join(", "), models: matches };
  const id = matches[0];
  const target = `${provider}/${id}`;
  const cls = str(classId) || DEFAULTS.defaultClass;
  if (!isPlainObject(classes[cls])) {
    const available = Object.keys(classes);
    return {
      ok: false,
      why: `the router has no class "${cls}"`,
      hint: available.length ? `classes: ${available.join(", ")}` : "add a class to router/router.config.json first",
      classes: available,
    };
  }
  const before = Array.isArray(classes[cls].chain) ? classes[cls].chain.map(String) : [];
  const after = [target, ...before.filter((entry) => entry !== target)];
  return {
    ok: true,
    provider,
    model: id,
    target,
    classId: cls,
    before,
    after,
    changed: before.join("\u0000") !== after.join("\u0000"),
    why: null,
  };
}

/** What `use` prints when it is not writing. The plan is the change, spelled out. */
export function formatUse(plan, { file = "", write = false, now = Date.now(), backup = "" } = {}) {
  if (!plan.ok) {
    return [`refused: ${plan.why}`, plan.hint ? `  ${plan.hint}` : ""].filter(Boolean).join("\n");
  }
  const lines = [`use ${plan.target} -> first in class "${plan.classId}"`];
  lines.push(`  before: ${plan.before.join(", ") || "(empty chain)"}`);
  lines.push(`  after:  ${plan.after.join(", ")}`);
  if (!plan.changed) {
    lines.push("  no change: that model is already first in the chain");
  }
  if (file) lines.push(`  config: ${file}`);
  if (write) {
    if (plan.changed) {
      lines.push(`  written: ${file} (validated JSON, backup ${backup || "(none)"})`);
      lines.push(`  note: restart the router to load the new chain; in-flight requests keep the chain they started with`);
    } else {
      lines.push("  nothing written: the plan is a no-op");
    }
  } else {
    lines.push("  not written: re-run with --write to apply it");
  }
  lines.push(`  now: ${formatTime(now)}`);
  return lines.join("\n");
}

function withoutChain(config, classId) {
  const copy = JSON.parse(JSON.stringify(config));
  if (copy?.classes?.[classId]) copy.classes[classId].chain = null;
  return copy;
}

/**
 * Apply a plan to the router config: backup, validate, replace atomically.
 *
 * The rule the write follows is "change one chain, and prove nothing else
 * changed". Every other key and value is compared byte for byte after the edit;
 * if the comparison fails, nothing is written. The backup is made before the
 * replacement, so there is always a file to go back to. Formatting is normalised
 * to 2-space JSON, which is what the file already uses.
 */
export function applyUse({ file, plan, now = Date.now() } = {}) {
  const originalText = readFileSync(file, "utf8");
  let current;
  try {
    current = JSON.parse(originalText);
  } catch (err) {
    throw new Error(`refusing to write: ${file} is not valid JSON (${reason(err)})`);
  }
  const checker = planUse({ config: current, model: plan?.model, classId: plan?.classId });
  if (!checker.ok) throw new Error(`refusing to write: ${checker.why}`);
  if (checker.before.join("\u0000") !== (plan.before ?? []).join("\u0000")) {
    throw new Error("refusing to write: the chain changed on disk since the plan was made; re-run use");
  }
  if (!checker.changed) return { file, backup: "", changed: false, bytes: Buffer.byteLength(originalText) };
  const next = JSON.parse(originalText);
  next.classes[checker.classId].chain = checker.after;
  const same = JSON.stringify(withoutChain(current, checker.classId)) === JSON.stringify(withoutChain(next, checker.classId));
  if (!same) throw new Error("refusing to write: the edit would change more than one chain");
  const text = `${JSON.stringify(next, null, 2)}${originalText.endsWith("\n") ? "\n" : ""}`;
  try {
    const parsed = JSON.parse(text);
    if (JSON.stringify(parsed.classes[checker.classId].chain) !== JSON.stringify(checker.after)) throw new Error("the new chain does not round-trip");
  } catch (err) {
    throw new Error(`refusing to write: the result would not be valid JSON (${reason(err)})`);
  }
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  let backup = `${file}.bak-${stamp}`;
  for (let n = 1; existsSync(backup); n += 1) backup = `${file}.bak-${stamp}-${n}`;
  copyFileSync(file, backup);
  const tmp = `${file}.tmp-${process.pid}-${stamp}`;
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      copyFileSync(tmp, file);
      unlinkSync(tmp);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* report the original rename failure */
      }
      throw new Error(`could not replace ${file}: ${reason(err)} (the backup is ${backup})`);
    }
  }
  return { file, backup, changed: true, bytes: Buffer.byteLength(text), chain: checker.after };
}

/** `gates`: the checklist alone, with no probe and no network. */
export function gatesReport(ctx = {}) {
  const root = str(ctx.root) || process.cwd();
  const cfg = { ...DEFAULTS, ...(isPlainObject(ctx.config) ? ctx.config : {}) };
  const router = readRouter({ root, config: cfg });
  const report = router.ok ? routerGates(router.config) : routerGates(null);
  const lines = [`the three gates the free tier enforces (measured 2026-10-20 against ${BASE_URL})`];
  lines.push(...gateLines(report.gates));
  if (!router.ok) lines.push(`  router: ${router.problem}`);
  else lines.push(`  router: ${router.file} - ${report.ok ? "all satisfied" : (report.problem ?? "check the FAIL lines")}`);
  if (report.hint) lines.push(`  fix: ${report.hint}`);
  lines.push("  why: without all three the gateway answers 403 FreeTierError even with a valid key; a spent window answers 429 FreeUsageLimitError instead.");
  return lines.join("\n");
}

/** `key`: every source and a masked value from each. */
export function keyReport(ctx = {}) {
  const found = findKey(ctx);
  const lines = ["key sources, tried in this order:"];
  if (!found.sources.length) {
    lines.push("  none - set OPENCODE_API_KEY, or add the key to router/data/keys.json");
    lines.push("  router/data/keys.json: {\"providers\": {\"opencode-free\": [\"oc_sk_...\"]}}");
    return lines.join("\n");
  }
  for (const source of found.sources) lines.push(`  ${maskKey(source.value)}  ${source.name}`);
  lines.push(`  in use: ${maskKey(found.key)} from ${found.source}`);
  return lines.join("\n");
}

/** One line for `--plugins` / the plugin list: no probe, no network. */
export function quickStatus(ctx = {}) {
  const root = str(ctx.root) || process.cwd();
  const cfg = { ...DEFAULTS, ...(isPlainObject(ctx.config) ? ctx.config : {}) };
  const router = readRouter({ root, config: cfg });
  const models = freeModels(router.config).length;
  const gates = router.ok ? routerGates(router.config) : null;
  const statePath = statePathOf(ctx);
  const { state } = loadState(statePath);
  const dsh = loadDshRecord({ includeDsh: cfg.includeDsh === true, file: cfg.dshRateLimitsFile, root });
  const failure = lastFailure({ state, dsh: dsh.record });
  const gateText = !router.ok ? "router unknown" : gates?.ok ? "gates ok" : "gates BROKEN";
  const failureText = failure ? `last ${failure.status || "?"} ${failure.verdict} ${formatTime(failure.at)}` : "no failure observed";
  return `${models} free model(s), ${gateText}, ${failureText}; /opencode-free status to probe`;
}

/**
 * The `llm/stream` observer.
 *
 * It records two things and decides nothing: a successful call whose resolved
 * target is an opencode-free model (a real "it works" timestamp), and a failed
 * call whose error text is a free-tier error (a real failure timestamp). A failed
 * class call has `target: null` because the router never said where it landed, so
 * the error text is the only evidence - and it is checked. Everything is wrapped:
 * a plugin that cannot write its record must not break the run it observed.
 */
export function observe(ctx, info) {
  if (!info || info.phase !== "end") return null;
  const target = str(info.target);
  const error = String(info.error ?? "");
  const freeTarget = target.startsWith(`${PROVIDER}/`);
  try {
    if (info.ok === false) {
      if (!freeTarget && !EXHAUSTED_RE.test(error) && !REFUSED_RE.test(error)) return null;
      const verdict = classifyFailure(error);
      const at = Date.now();
      const statePath = statePathOf(ctx);
      const { state } = loadState(statePath);
      const firstFailureAt = toTime(state?.firstFailureAt) ?? at;
      const reset = verdict.verdict === "exhausted" ? { at: firstFailureAt + 24 * 60 * 60 * 1000, source: "estimate (24h window from the first hit)" } : { at: null, source: null };
      recordFailure(statePath, {
        verdict: verdict.verdict,
        status: verdict.status,
        detail: verdict.detail,
        at,
        model: freeTarget ? target.slice(PROVIDER.length + 1) : null,
        resetAt: reset.at,
        resetSource: reset.source,
      });
      return { recorded: "failure", verdict: verdict.verdict };
    }
    if (!freeTarget) return null;
    recordSuccess(statePathOf(ctx), { at: Date.now(), model: target.slice(PROVIDER.length + 1), ms: Number(info.ms) || null });
    return { recorded: "success" };
  } catch (err) {
    try {
      ctx?.log?.(`opencode-handler: could not record an observation: ${reason(err)}`);
    } catch {
      /* logging is optional */
    }
    return null;
  }
}

export default {
  id: "rosa-opencode-handler",
  description:
    "OpenCode Zen's free tier: probe it, list its free models, explain a 403/429, and pin one in a router class.",

  commands: (ctx) => {
    const withIo = (run) => async (argv = []) => run(Array.isArray(argv) ? argv.map(String) : [], ctx);
    return {
      status: withIo((argv, own) => statusReport(own)),
      models: withIo((argv, own) => modelsReport(own)),
      who: withIo((argv, own) => modelsReport(own)),
      gates: withIo((argv, own) => gatesReport(own)),
      key: withIo((argv, own) => keyReport(own)),
      use: withIo(async (argv, own) => {
        let write = false;
        let classId = "";
        const words = [];
        for (let i = 0; i < argv.length; i += 1) {
          const word = argv[i];
          if (word === "--write") write = true;
          else if (word === "--class") {
            classId = argv[i + 1] ?? "";
            i += 1;
          } else if (word.startsWith("--class=")) classId = word.slice("--class=".length);
          else words.push(word);
        }
        const model = words[0] ?? "";
        if (words.length > 1) classId = classId || words[1];
        const root = str(own.root) || process.cwd();
        const cfg = { ...DEFAULTS, ...(isPlainObject(own.config) ? own.config : {}) };
        const router = readRouter({ root, config: cfg });
        if (!router.ok) {
          return formatUse({ ok: false, why: router.problem, hint: router.hint }, { file: router.file });
        }
        const plan = planUse({ config: router.config, model, classId: classId || cfg.defaultClass });
        if (!plan.ok || !write) return formatUse(plan, { file: router.file, write: false });
        const result = applyUse({ file: router.file, plan });
        return formatUse(plan, { file: router.file, write: true, backup: result.backup, now: Date.now() });
      }),
      clear: withIo((argv, own) => {
        const path = statePathOf(own);
        try {
          if (existsSync(path)) unlinkSync(path);
          return `record cleared: ${path}`;
        } catch (err) {
          return `could not clear ${path}: ${reason(err)}`;
        }
      }),
    };
  },

  tools: (ctx) => [
    {
      name: "free_model_status",
      description:
        "Report whether OpenCode's free tier is usable right now: the probe verdict (usable/exhausted/refused/key/error), the three gates the gateway checks, the free models, the last observed failure and its reset estimate. Use before routing work at a free model.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      run: async () => statusReport(ctx),
    },
  ],

  hooks: (ctx) => ({
    "llm/stream": async (info) => {
      observe(ctx, info);
    },
  }),

  status: (ctx) => quickStatus(ctx),
};
