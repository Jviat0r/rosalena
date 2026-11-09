/**
 * The public trial endpoint, as one library.
 *
 * Why a library and not two handlers: a Pages Function is hard to test without a
 * Cloudflare runtime, so every decision that can be wrong - validating a request,
 * reserving a quota slot, framing an SSE event, talking to a provider - lives here
 * where `node --test` can call it with a fake env. The handlers are adapters.
 *
 * Standing rules for this file, because the endpoint is public and anonymous:
 *
 *   - No prompt and no completion is ever stored. The D1 rows are counters only:
 *     (day, scope, used, stamp). Nothing else is written, anywhere.
 *   - The API key never reaches the browser. It is put in an upstream header and
 *     appears in no response body and no log line; log lines run through redact().
 *   - A visitor may send their own provider key in the x-trial-user-key header. It is
 *     the same rule one step harder: one upstream header, no store, no log, no echo.
 *     It is never compared with anything - the provider that issued it is the judge.
 *   - The trial can never touch a file or run anything. Its one tool is a web search
 *     (search.mjs), run here on the model's text request, once per message; results
 *     only, no page is fetched. Any other tool call is cut from the stream, never run.
 */

import { callIsComplete, resultsForModel, searchQueryFrom, sourcesBlock, wantsSearch, webSearch } from "./search.mjs";

// The site's own origins, the first being the one pages name in messages. rosalena.dev
// since 2026-11-09; rosalena.pages.dev stays (installed apps and old links use it).
export const SITE_ORIGIN_DEFAULT = "https://rosalena.dev,https://www.rosalena.dev,https://rosalena.pages.dev";

/** TRIAL_ORIGIN as a list: one origin or several, comma-separated, without trailing slashes. */
export function allowedOrigins(env = {}) {
  return String(env?.TRIAL_ORIGIN || SITE_ORIGIN_DEFAULT)
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * The system prompt, in its three states. Exported because TRIAL.md quotes it, and a
 * second copy would drift: the model must know it is a demo, not an agent.
 *
 *   off   no tools at all (TRIAL_SEARCH=off)
 *   on    one web search per message, asked for in text so every provider can use it
 *   done  the search ran and its results are the last message
 */
const PROMPT_HEAD = [
  "You are the demo assistant on the public trial page of Rosalena Harness, a desktop app that runs local and free-cloud models behind one router.",
  "This is a demo: you cannot read files, run commands, open links or remember anything across page reloads, and you have no access to the visitor's computer.",
  "When a visitor asks for real work - editing a file, running something, remembering a previous visit - say plainly that this page can only talk, and that the desktop app is where that work happens.",
];
const PROMPT_SEARCH = {
  off: "You cannot search the web. Never write a tool call, a function call or any tool-call markup. When a question needs a search, answer from what you already know, say it may be out of date, and mention that the desktop app can search the web.",
  // A plain marker, not a tool-call format: measured through OmniRoute, the <tool_call>
  // form made GLM claim it had no search at all, while this one makes it announce the
  // search (wantsSearch in search.mjs catches that when the marker itself never arrives).
  on: "You have one tool: a web search, once per message. When a question needs current or specific facts you are not sure of (a company, a product, a price, news, anything recent), reply with only this one line and nothing else: [[search: your search terms]] The results come back to you and you answer from them. Otherwise answer directly. Never write any other tool call.",
  done: "You already searched the web for this message, and the results are in the last message. Answer from them and cite the ones you use by number, like [1]. Never write a tool call.",
};
const PROMPT_TAIL = "Answer in under about 200 words, skip preamble and restating the question, and never invent a result you could not have seen. If you do not know, say so.";

export function systemPrompt(search = "off") {
  return [...PROMPT_HEAD, PROMPT_SEARCH[search] ?? PROMPT_SEARCH.off, PROMPT_TAIL].join("\n\n");
}

/** The prompt without search, kept for anything that quotes the plain demo. */
export const SYSTEM_PROMPT = systemPrompt("off");

/** Web search is on unless TRIAL_SEARCH=off. */
export function searchEnabled(env = {}) {
  return String(env.TRIAL_SEARCH ?? "").trim().toLowerCase() !== "off";
}

export const MODEL_LABEL_DEFAULT = "Llama 3.1 8B";
export const MODEL_NOTE_DEFAULT = "a small model, running on Cloudflare, for the demo only";
// The plain "@cf/meta/llama-3.1-8b-instruct" id was retired on 2026-05-30 (error 5028); fp8 is the same model.
export const WORKERS_AI_MODEL_DEFAULT = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** The provider this endpoint is allowed to spend on when nothing says otherwise. */
export const DEFAULT_PROVIDER = "workers-ai";

/**
 * Providers this endpoint knows how to spend on. The first one in the chain answers;
 * a provider that says "my window is spent" hands the message to the next, which is
 * the same thing the desktop router does when a free model is busy.
 */
export const KNOWN_PROVIDERS = Object.freeze(["workers-ai", "opencode-free", "omniroute", "stub"]);

/**
 * The chain, in order. `TRIAL_PROVIDER` accepts one name or a comma-separated list,
 * so "opencode-free,workers-ai" means *try the free tier first, and if its shared
 * window is spent, a small model on Cloudflare answers instead of refusing*. That
 * ordering is the whole reason the chain exists: the free tier is better, and the
 * open window is the one thing it cannot promise.
 *
 * Unknown names are dropped; an empty result fails closed at call time rather than
 * quietly spending on a default nobody chose.
 */
export function providerChain(env = {}) {
  const unset = env.TRIAL_PROVIDER === undefined || env.TRIAL_PROVIDER === null;
  // Unset means "use the default". Set-but-empty is the opposite: an operator turned the
  // hosted path off on purpose, and a var that says nothing must not quietly re-enable
  // a provider that spends someone's quota. Absence is a default; emptiness is a decision.
  if (unset) return [DEFAULT_PROVIDER];
  const raw = String(env.TRIAL_PROVIDER).trim();
  if (!raw) return [];
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .filter((name) => KNOWN_PROVIDERS.includes(name));
  return [...new Set(names)];
}



/** Every refusal kind the page knows how to render. */
export const ERROR_KINDS = Object.freeze(["quota", "capacity", "turnstile", "bad_request", "provider"]);

/**
 * Why capacity is 503 and not 429: 429 says "you are sending too fast, slow down
 * and retry", and every client obeys that by retrying in seconds. A full global
 * day, a neighbour's message still in flight, or a missing binding will not clear
 * in seconds, so 503 (service unavailable, back off) tells the truth. The page
 * switches on `kind`, and the status is for the network.
 */
export const STATUS_BY_KIND = Object.freeze({
  quota: 429,
  capacity: 503,
  turnstile: 403,
  bad_request: 400,
  provider: 502,
});

/** Every limit, in one place. The env overrides are read by limitsFromEnv(). */
export const DEFAULT_LIMITS = Object.freeze({
  // Messages per UTC day. The session cap is the one a visitor feels, the address cap is
  // what they cannot escape by clearing a cookie, and the world cap is the brake. The
  // address budget is three sessions' worth on purpose: a household, an office or a phone
  // network shares one address, and one tight cap there would punish a family for existing.
  sessionPerDay: 5,
  ipPerDay: 15,
  globalPerDay: 1000,
  // Tokens per UTC day. Messages are metered before the model is asked and tokens after
  // it answers, because only the provider knows what the answer cost. A long prompt with a
  // long reply therefore spends more of the day than "hello" does, which is the point: a
  // message cap alone prices a paragraph the same as a word.
  sessionTokensPerDay: 40000,
  ipTokensPerDay: 120000,
  globalTokensPerDay: 1000000,
  maxMessageChars: 1200,
  maxHistoryTurns: 12,
  maxHistoryTurnChars: 4000,
  maxPromptChars: 12000,
  // Reasoning before speaking means the visible answer is shorter than this cap: measured
  // at 55 of 80 tokens spent thinking. 700 leaves room for a real answer instead of a
  // truncated one that reaches the visitor as an empty bubble.
  maxOutputTokens: 700,
  temperature: 0.7,
  timeoutMs: 30000,
  inflightMs: 2000,
  requestsPerMinute: 20,
});

/** OpenCode's wire grammar for a session id: `ses_` + 12 hex + 14 base62. */
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_MODEL = "deepseek-v4.1-flash-free";

export const SSE_DONE = "data: [DONE]\n\n";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MISSING_SALT = "rosalena-trial-no-salt-configured";
const QUOTA_SCOPE_GLOBAL = "global";

const UPSERT_SQL = `INSERT INTO trial_usage (day, scope, used, stamp) VALUES (?, ?, 1, ?)
ON CONFLICT(day, scope) DO UPDATE SET used = used + 1, stamp = excluded.stamp
RETURNING used, stamp`;

// used > 0 guards the refund against a double refund racing in from a retried
// request: a counter can never go negative, so a wrong refund shows up as a stuck
// counter rather than as free messages nobody counted.
const REFUND_SQL = `UPDATE trial_usage SET used = used - 1 WHERE day = ? AND scope = ? AND used > 0`;

const SELECT_SQL = `SELECT used FROM trial_usage WHERE day = ? AND scope = ?`;

/**
 * Token counters are a separate table from message counters because they move at a
 * different time: messages are reserved before the model is asked, tokens are added
 * after it answers. Keeping them in one row would mean a row that is half true for the
 * length of a request.
 */
const TOKEN_UPSERT_SQL = `INSERT INTO trial_tokens (day, scope, tokens_in, tokens_out, requests, stamp)
VALUES (?, ?, ?, ?, 1, ?)
ON CONFLICT(day, scope) DO UPDATE SET
  tokens_in = tokens_in + excluded.tokens_in,
  tokens_out = tokens_out + excluded.tokens_out,
  requests = requests + 1,
  stamp = excluded.stamp`;

const TOKEN_SELECT_SQL = `SELECT tokens_in, tokens_out, requests FROM trial_tokens WHERE day = ? AND scope = ?`;

/**
 * The abuse log. One row per attempt, and the two text columns are the only place a
 * visitor's words could ever land. They are bound to NULL unless the deployment asks for
 * TRIAL_LOG_MESSAGES=full, because the public pages say this window keeps nothing and a
 * silent change to that sentence is the kind of thing that cannot be taken back.
 *
 * Counting and logging are separate tools on purpose: the counters refuse a message, the
 * log explains why it was refused. A log write that fails must never fail the answer.
 */
const LOG_INSERT_SQL = `INSERT INTO trial_log
  (id, day, stamp, sid, ip, provider, model, status, kind, ms, chars_in, chars_out, tokens_in, tokens_out, prompt, answer, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Every mode the log understands. 'meta' is the shipping default: no words, ever. */
export const LOG_MODES = Object.freeze(["off", "meta", "full"]);

/**
 * The session cookie. Named without the product so it survives a rename, signed so a
 * visitor cannot mint somebody else's id, and HttpOnly because no script on the page has
 * any business reading it.
 */
export const SESSION_COOKIE = "rosalena_sid";
export const SESSION_TTL_SECONDS = 180 * 24 * 60 * 60;

const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  // Every one of these answers is per-IP and per-minute; a cache anywhere would
  // hand one visitor another visitor's quota.
  "cache-control": "no-store",
});

/**
 * A refusal the page can render. `kind` is the taxonomy, `status` the HTTP code,
 * and `message` a complete sentence a visitor can act on.
 */
export class TrialError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "TrialError";
    this.kind = ERROR_KINDS.includes(kind) ? kind : "provider";
    this.status = STATUS_BY_KIND[this.kind];
  }
}

const defaultWarn = (line) => console.warn(line);

/** Strip secrets out of any string that might be logged. Short values are ignored. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    const value = String(secret ?? "");
    if (value.length >= 6) out = out.split(value).join("[redacted]");
  }
  return out;
}

function parseLimit(raw, fallback, min, max) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Limits from env, clamped so a typo cannot turn a guard off. An env var that is
 * not a number is ignored rather than treated as zero, because a zero limit would
 * read as "0 messages per day" and look like an outage.
 */
export function limitsFromEnv(env = {}) {
  const d = DEFAULT_LIMITS;
  return {
    sessionPerDay: parseLimit(env.TRIAL_SESSION_DAILY_LIMIT, d.sessionPerDay, 1, 1000),
    ipPerDay: parseLimit(env.TRIAL_IP_DAILY_LIMIT, d.ipPerDay, 1, 1000),
    globalPerDay: parseLimit(env.TRIAL_GLOBAL_DAILY_LIMIT, d.globalPerDay, 1, 1000000),
    sessionTokensPerDay: parseLimit(env.TRIAL_SESSION_DAILY_TOKENS, d.sessionTokensPerDay, 1000, 10000000),
    ipTokensPerDay: parseLimit(env.TRIAL_IP_DAILY_TOKENS, d.ipTokensPerDay, 1000, 10000000),
    globalTokensPerDay: parseLimit(env.TRIAL_GLOBAL_DAILY_TOKENS, d.globalTokensPerDay, 1000, 100000000),
    maxMessageChars: parseLimit(env.TRIAL_MAX_MESSAGE_CHARS, d.maxMessageChars, 1, 20000),
    maxHistoryTurns: parseLimit(env.TRIAL_HISTORY_TURNS, d.maxHistoryTurns, 0, 100),
    maxHistoryTurnChars: parseLimit(env.TRIAL_HISTORY_TURN_CHARS, d.maxHistoryTurnChars, 1, 100000),
    maxPromptChars: parseLimit(env.TRIAL_PROMPT_CHARS, d.maxPromptChars, 1, 200000),
    maxOutputTokens: parseLimit(env.TRIAL_MAX_TOKENS, d.maxOutputTokens, 1, 4096),
    temperature: parseLimit(env.TRIAL_TEMPERATURE, d.temperature, 0, 2),
    timeoutMs: parseLimit(env.TRIAL_TIMEOUT_MS, d.timeoutMs, 50, 120000),
    inflightMs: parseLimit(env.TRIAL_INFLIGHT_MS, d.inflightMs, 100, 60000),
    requestsPerMinute: d.requestsPerMinute,
  };
}

/** The UTC day key: 'YYYY-MM-DD'. One day, one scope, one row. */
export function utcDay(clock = () => Date.now()) {
  return new Date(clock()).toISOString().slice(0, 10);
}

/** The next UTC midnight as an ISO string - one instant for every visitor. */
export function resetAt(clock = () => Date.now()) {
  const now = new Date(clock());
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

function secondsUntil(iso, nowMs) {
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return 60;
  return Math.max(1, Math.ceil((target - nowMs) / 1000));
}

/** The visitor's IP as Cloudflare passes it, with a local-dev fallback. */
export function requestIp(request) {
  const headers = request?.headers;
  const cf = headers?.get?.("cf-connecting-ip");
  if (cf && String(cf).trim()) return String(cf).trim();
  // Only reachable off-platform. Trusting it in production would let anyone pick
  // their own quota key, but Cloudflare always sets cf-connecting-ip before the
  // function runs, so the fallback is dead code on the real deployment.
  const forwarded = headers?.get?.("x-forwarded-for");
  if (forwarded) {
    const first = String(forwarded).split(",")[0].trim();
    if (first) return first;
  }
  return "unknown";
}

async function sha256Bytes(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 'ip:' + the first 16 hex chars of SHA-256(salt + ip). The raw IP is never stored,
 * never logged and never sent anywhere; this hash is the only form it takes.
 *
 * Without a salt the hash is a lookup table for the whole IPv4 space, so a missing
 * secret is warned about loudly - but the demo still runs, because a trial that
 * cannot count is worse than one with weak pseudonyms, and the warning is the fix.
 */
export async function ipFingerprint(ip, { salt, warn = defaultWarn } = {}) {
  const address = String(ip ?? "").trim() || "unknown";
  const pepper = String(salt ?? "").trim();
  if (!pepper) {
    warn(
      "trial: TRIAL_SALT is not set, so IP keys use a constant salt and are reversible for the IPv4 space. Set it with `npx wrangler pages secret put TRIAL_SALT`.",
    );
  }
  const digest = await sha256Bytes(`${pepper || MISSING_SALT}${address}`);
  return `ip:${toHex(digest.subarray(0, 8))}`;
}

/* ------------------------------------------------------------------ the session */

/**
 * The visitor's session cookie, and why it exists.
 *
 * The address alone was the allowance key, which made the allowance cheap to reset: a
 * phone hopping between towers, or anyone with a VPN, arrives as a new address and gets a
 * fresh five messages. A signed cookie is the part the visitor carries with them, so the
 * allowance follows the browser instead of the wire. The address stays as a second key
 * for the opposite move - clearing cookies - and the tighter of the two is what stops a
 * message. Neither is an identity: both are salted hashes, and no account is involved.
 *
 * The cookie holds a random id and an HMAC over that id. Without the HMAC anyone could
 * write `rosalena_sid=<any 16 hex>` and rotate ids freely, which is the attack this is
 * for. The HMAC key is derived from TRIAL_SALT, so a salt rotation invalidates every
 * outstanding cookie at once - the right blast radius for a leaked secret.
 */
export function parseCookieHeader(header) {
  const jar = new Map();
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name) jar.set(name, value);
  }
  return jar;
}

/** A fresh 16 hex character session id. Not a secret, just unguessable. */
export function newSessionId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

async function sessionMac(id, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`rosalena-sid:${String(salt ?? "").trim() || MISSING_SALT}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(id)));
  return toHex(new Uint8Array(mac));
}

export async function signSession(id, { salt } = {}) {
  return `${id}.${(await sessionMac(id, salt)).slice(0, 32)}`;
}

/**
 * Verify by recomputing. The comparison runs over the whole string rather than stopping
 * at the first difference, so the time it takes says nothing about how much of a forged
 * signature was right.
 */
export async function verifySession(value, { salt } = {}) {
  const raw = String(value ?? "").trim();
  const at = raw.lastIndexOf(".");
  if (at < 1) return null;
  const id = raw.slice(0, at);
  const mac = raw.slice(at + 1).toLowerCase();
  if (!/^[0-9a-f]{16}$/i.test(id) || !/^[0-9a-f]{32}$/.test(mac)) return null;
  const expected = (await sessionMac(id, salt)).slice(0, 32);
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0 ? id : null;
}

/** The storage key for a session: a salted hash, so the raw id is never written down. */
export async function sessionScope(id, { salt } = {}) {
  const digest = await sha256Bytes(`${String(salt ?? "").trim() || MISSING_SALT}sid:${String(id)}`);
  return `sid:${toHex(digest.subarray(0, 8))}`;
}

export async function sessionFromRequest(request, { salt } = {}) {
  const jar = parseCookieHeader(request?.headers?.get?.("cookie"));
  const id = await verifySession(jar.get(SESSION_COOKIE), { salt });
  return id ? { id, scope: await sessionScope(id, { salt }) } : null;
}

/**
 * The session for this request, minting one when there is none. `fresh` is what the
 * handlers use to decide whether to send a cookie back: an existing valid cookie is
 * refreshed too, because a demo someone returns to monthly should not forget them.
 */
export async function ensureSession(request, { salt, mint = newSessionId } = {}) {
  const existing = await sessionFromRequest(request, { salt });
  if (existing) return { ...existing, fresh: false };
  const id = mint();
  return { id, scope: await sessionScope(id, { salt }), fresh: true };
}

/**
 * The Set-Cookie value. HttpOnly so no script can read it, SameSite=Lax so another site
 * cannot spend a visitor's allowance by posting here, Secure so it never travels in the
 * clear. No Domain attribute: the demo's cookie has no business on any other host.
 */
export async function sessionSetCookie(id, { salt } = {}) {
  return [
    `${SESSION_COOKIE}=${await signSession(id, { salt })}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/* ------------------------------------------------------------------ tokens */

/**
 * What a day has cost so far, per scope. Tokens are tallied after the answer, so this is
 * read before the next request is allowed to spend: a visitor who spent their budget has
 * to be refused on the way in, not told afterwards.
 */
export async function readTokenUsage(db, day, scopes = []) {
  const out = [];
  for (const scope of scopes) {
    let row = null;
    try {
      row = await db.prepare(TOKEN_SELECT_SQL).bind(day, scope).first();
    } catch {
      // A counter that cannot be read must not take the page down. The message counter
      // still holds, and this reads as zero, which is the lenient direction on purpose:
      // a broken read should not invent a refusal.
      row = null;
    }
    const input = Math.max(0, Number(row?.tokens_in ?? 0) || 0);
    const output = Math.max(0, Number(row?.tokens_out ?? 0) || 0);
    out.push({ scope, input, output, requests: Number(row?.requests ?? 0) || 0, total: input + output });
  }
  return out;
}

/**
 * Add an answer's tokens to every scope that pays for it. Never throws: the answer has
 * already reached the visitor by the time this runs, and a bookkeeping failure must not
 * turn a delivered message into an error.
 */
export async function tallyTokens(db, { day, tokens, scopes = [], stamp, warn = defaultWarn }) {
  const input = Math.max(0, Math.round(Number(tokens?.input ?? 0) || 0));
  const output = Math.max(0, Math.round(Number(tokens?.output ?? 0) || 0));
  if (!db?.prepare || !scopes.length || (!input && !output)) return 0;
  try {
    const statement = db.prepare(TOKEN_UPSERT_SQL);
    await db.batch(scopes.map((scope) => statement.bind(day, scope, input, output, stamp)));
  } catch (err) {
    warn(`trial: token tally failed: ${redact(err?.message ?? err)}`);
    return 0;
  }
  return input + output;
}

/* ------------------------------------------------------------------ the log */

/**
 * How much of an attempt to keep. The default is metadata: which provider answered, how
 * long it took, what it cost, whether it was refused. That is everything needed to see
 * abuse patterns without holding anyone's words.
 *
 * `full` exists for one job: reading a report that something abusive came through. It is
 * opt-in by env var, it is not the default, and TRIAL.md tells the operator to turn it
 * back off when the review is done. The public pages promise this window keeps nothing;
 * while this is set to `full` that promise is false, so it must not be the shipped state.
 */
export function logMode(env = {}) {
  const raw = String(env.TRIAL_LOG_MESSAGES ?? "meta").trim().toLowerCase();
  return LOG_MODES.includes(raw) ? raw : "meta";
}

export function logId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

const LOG_TEXT_MAX = 4000;

/**
 * One row per attempt. `status` is one of ok / refused / failed, and a refused row is the
 * most useful one: it is the record of somebody hitting a wall, which is what "verify
 * against abusive messages" means in practice.
 */
export async function writeTrialLog(db, entry = {}, { mode = "meta", stamp, warn = defaultWarn } = {}) {
  if (mode === "off" || !db?.prepare) return false;
  const words = mode === "full";
  const hours = (value) => (value === undefined || value === null ? null : Math.max(0, Math.round(Number(value) || 0)));
  try {
    await db
      .prepare(LOG_INSERT_SQL)
      .bind(
        entry.id ?? logId(),
        entry.day,
        stamp ?? entry.stamp ?? Date.now(),
        entry.sid ?? null,
        entry.ip ?? null,
        entry.provider ?? null,
        entry.model ?? null,
        entry.status ?? "ok",
        entry.kind ?? null,
        hours(entry.ms),
        hours(entry.charsIn),
        hours(entry.charsOut),
        hours(entry.tokensIn),
        hours(entry.tokensOut),
        words ? String(entry.prompt ?? "").slice(0, LOG_TEXT_MAX) : null,
        words ? String(entry.answer ?? "").slice(0, LOG_TEXT_MAX) : null,
        // The provider's own words, so a failure can be read without asking the visitor
        // to reproduce it. Same gate as prompt/answer: it can quote the request back.
        words ? String(entry.error ?? "").slice(0, LOG_TEXT_MAX) || null : null,
      )
      .run();
    return true;
  } catch (err) {
    warn(`trial: log write failed: ${redact(err?.message ?? err)}`);
    return false;
  }
}

/**
 * Only the site's own page may call this. A missing Origin is a server-side client
 * (curl, a health check) and is allowed only in stub mode, where nothing is spent.
 */
export function checkOrigin(origin, env = {}, provider = DEFAULT_PROVIDER) {
  const origins = allowedOrigins(env);
  const allowed = origins[0];
  const value = typeof origin === "string" ? origin.trim().replace(/\/+$/, "") : "";
  if (!value) {
    if (provider === "stub") return;
    throw new TrialError(
      "bad_request",
      `This endpoint answers only the trial page at ${allowed}; a request with no Origin header is refused.`,
    );
  }
  if (!origins.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    throw new TrialError(
      "bad_request",
      `Origin ${value} is not allowed; the trial answers only the page at ${allowed}.`,
    );
  }
}

function requireString(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Validate the whole body before a single slot is spent, and name the cap that was
 * crossed so the page can say something better than "invalid request".
 */
export function validateTrialInput(input, limits = DEFAULT_LIMITS) {
  const body = input && typeof input === "object" ? input : {};
  const message = requireString(body.message).trim();
  if (!message) {
    throw new TrialError("bad_request", "Type a message first: the trial needs something to answer.");
  }
  if (message.length > limits.maxMessageChars) {
    throw new TrialError(
      "bad_request",
      `Your message is ${message.length} characters; the trial allows ${limits.maxMessageChars} characters per message.`,
    );
  }

  const rawHistory = body.history === undefined || body.history === null ? [] : body.history;
  if (!Array.isArray(rawHistory)) {
    throw new TrialError("bad_request", "history must be an array of {role, content} turns.");
  }
  if (rawHistory.length > limits.maxHistoryTurns) {
    throw new TrialError(
      "bad_request",
      `The conversation history has ${rawHistory.length} turns; the trial sends at most ${limits.maxHistoryTurns} turns.`,
    );
  }

  const history = [];
  let total = message.length;
  for (let index = 0; index < rawHistory.length; index += 1) {
    const turn = rawHistory[index];
    if (!turn || typeof turn !== "object") {
      throw new TrialError("bad_request", `History turn ${index + 1} is not a {role, content} object.`);
    }
    const role = requireString(turn.role);
    // A visitor must not be able to inject a system message: the only system
    // prompt in the request is the one this file wrote.
    if (role !== "user" && role !== "assistant") {
      throw new TrialError(
        "bad_request",
        `History turn ${index + 1} has role "${role || "(empty)"}"; only user and assistant are allowed, because the trial never accepts a system message from a visitor.`,
      );
    }
    const content = requireString(turn.content);
    if (content.length > limits.maxHistoryTurnChars) {
      throw new TrialError(
        "bad_request",
        `History turn ${index + 1} is ${content.length} characters; the trial allows ${limits.maxHistoryTurnChars} characters per turn.`,
      );
    }
    total += content.length;
    if (content) history.push({ role, content });
  }

  if (total > limits.maxPromptChars) {
    throw new TrialError(
      "bad_request",
      `The whole prompt is ${total} characters; the trial allows ${limits.maxPromptChars} characters in total.`,
    );
  }

  return { message, history, turnstileToken: requireString(body.turnstileToken) };
}

/** System prompt first, then the visitor's turns, then the new message. */
export function buildMessages({ message, history = [], search = "off" }) {
  return [{ role: "system", content: systemPrompt(search) }, ...history, { role: "user", content: message }];
}

/** The second round of a searched message: same turns, the "done" prompt, then the results. */
export function searchedMessages(messages, query, found) {
  return [
    { role: "system", content: systemPrompt("done") },
    ...messages.slice(1),
    { role: "assistant", content: `(searched the web for "${query}")` },
    { role: "user", content: resultsForModel(query, found) },
  ];
}

/**
 * Approximate token counts, because none of the streaming providers reports usage
 * on every chunk. Four characters per token is the usual English rough cut; the
 * page prints the number as an estimate, never as a bill.
 */
export function estimateUsage(messages = [], output = "") {
  const inputChars = messages.reduce((sum, m) => sum + requireString(m?.content).length, 0);
  return { input: Math.ceil(inputChars / 4), output: Math.ceil(String(output ?? "").length / 4) };
}

/** One SSE frame. JSON.stringify escapes quotes and newlines, so the frame is one line. */
export function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    // Cloudflare buffers by default when it thinks a response is compressible;
    // an SSE stream must not be held back until the last byte.
    "x-accel-buffering": "no",
  };
}

export function jsonHeaders() {
  return { ...JSON_HEADERS };
}

/** A plain descriptor for a Response. Handlers turn it into one; tests read it. */
export function failureResult(err) {
  const known = err instanceof TrialError;
  const kind = known ? err.kind : "provider";
  const message = known ? err.message : "The demo had an internal failure. Try again in a moment.";
  const headers = jsonHeaders();
  if (Number.isFinite(err?.retryAfter)) headers["retry-after"] = String(err.retryAfter);
  return { status: STATUS_BY_KIND[kind] ?? STATUS_BY_KIND.provider, headers, json: { error: message, kind } };
}

/**
 * One message in flight per IP.
 *
 * This is a Map in the isolate, not a Durable Object: it is best effort by design.
 * A Worker isolates per region, so two requests from the same IP can land in two
 * isolates and both run. What this buys is the real case it was built for - a
 * page that double-submits, or a script firing ten requests at once into the same
 * isolate - and it costs nothing. The D1 counter is the guard that must be exact.
 */
export function createInflightGuard({ ttlMs = DEFAULT_LIMITS.inflightMs, clock = () => Date.now() } = {}) {
  const until = new Map();
  const sweep = (now) => {
    if (until.size < 512) return;
    for (const [key, expiry] of until) if (expiry <= now) until.delete(key);
  };
  return {
    tryAcquire(key) {
      const now = clock();
      sweep(now);
      const expiry = until.get(key);
      if (expiry && expiry > now) return false;
      until.set(key, now + ttlMs);
      return true;
    },
    release(key) {
      until.delete(key);
    },
    size() {
      return until.size;
    },
  };
}

/** The guard production uses. Tests build their own so they never share state. */
export const sharedInflight = createInflightGuard();

/** Today's count for one scope. A missing row is zero, not an error. */
export async function readUsed(db, day, scope) {
  const row = await db.prepare(SELECT_SQL).bind(day, scope).first();
  const used = Number(row?.used ?? 0);
  return Number.isFinite(used) && used > 0 ? used : 0;
}

function usedFromResult(result) {
  const row = result?.results?.[0] ?? (Array.isArray(result) ? result[0] : result);
  const used = Number(row?.used ?? NaN);
  if (!Number.isFinite(used)) {
    throw new TrialError("provider", "The trial counter did not return a count, so the demo cannot answer.");
  }
  return used;
}

/**
 * Reserve one slot for the IP and one for the world, atomically, then give both
 * back if the request is refused.
 *
 * Why a batch: D1 runs a batch as one transaction, so the two counters move
 * together or not at all - an IP counter that incremented while the global one
 * failed would be a free message the breaker never sees.
 *
 * Why reserve-then-refund: the global breaker is the only thing between a front
 * page and a bill, so the increment must be the first thing that happens, before
 * the provider is even addressed. A refusal then decrements the rows this call
 * took. The stamp is left alone by the refund on purpose: it records the last
 * attempt, and `used` is the only number the quota reads.
 */
export async function reserveUsage(db, { day, scopes = [], stamp, resetIso }) {
  const statement = db.prepare(UPSERT_SQL);
  const results = await db.batch(scopes.map((entry) => statement.bind(day, entry.scope, stamp)));
  const used = scopes.map((entry, index) => usedFromResult(results?.[index]));

  const refund = async () => {
    await db.batch(scopes.map((entry) => db.prepare(REFUND_SQL).bind(day, entry.scope)));
  };

  // Tightest first, because the sentence the visitor reads names the wall they hit. The
  // session is the wall a person can see, the address is the one they cannot clear a
  // cookie to escape, and the world cap is the last resort on a front page with a bill.
  for (let index = 0; index < scopes.length; index += 1) {
    const entry = scopes[index];
    if (used[index] > entry.limit) {
      await refund();
      const err = new TrialError(
        entry.kind ?? "quota",
        entry.message(entry.limit, resetIso),
      );
      err.retryAfter = secondsUntil(resetIso, stamp);
      throw err;
    }
  }

  return scopes.map((entry, index) => ({ scope: entry.scope, used: used[index] }));
}

/** GET /api/quota: what the page shows before the first message. Never reserves. */
export async function handleQuota({ request, env = {}, clock = () => Date.now(), warn = defaultWarn } = {}) {
  const limits = limitsFromEnv(env);
  const day = utcDay(clock);
  const ipScope = await ipFingerprint(requestIp(request), { salt: env.TRIAL_SALT, warn });
  // The cookie is issued (or refreshed) here rather than on the POST, so the allowance on
  // the page belongs to the browser the visitor is using before they type anything.
  const session = await ensureSession(request, { salt: env.TRIAL_SALT });

  const db = env.TRIAL_DB;
  let sessionUsed = 0;
  let ipUsed = 0;
  let tokens = { session: 0, address: 0, global: 0 };

  if (db?.prepare) {
    try {
      sessionUsed = await readUsed(db, day, session.scope);
      ipUsed = await readUsed(db, day, ipScope);
    } catch (err) {
      // A read-only count must not take the page down: the visitor sees "0 of 5"
      // and the POST still enforces the truth.
      warn(`trial: quota read failed: ${redact(err?.message ?? err)}`);
    }
    const spent = await readTokenUsage(db, day, [session.scope, ipScope, QUOTA_SCOPE_GLOBAL]);
    tokens = { session: spent[0].total, address: spent[1].total, global: spent[2].total };
  } else {
    warn("trial: TRIAL_DB is not bound, so GET /api/quota reports 0 used and POST /api/trial will refuse.");
  }

  return {
    status: 200,
    headers: { ...jsonHeaders(), "set-cookie": await sessionSetCookie(session.id, { salt: env.TRIAL_SALT }) },
    json: {
      ok: true,
      // `anonymous` is what the page shows: this browser's own allowance. The address and
      // the day's token spend are here too, because there are three walls and a page that
      // reports only the nearest one is telling the visitor half the truth.
      anonymous: { used: sessionUsed, limit: limits.sessionPerDay, resetAt: resetAt(clock) },
      address: { used: ipUsed, limit: limits.ipPerDay },
      tokens: {
        used: tokens.session,
        limit: limits.sessionTokensPerDay,
        address: { used: tokens.address, limit: limits.ipTokensPerDay },
        global: { used: tokens.global, limit: limits.globalTokensPerDay },
        resetAt: resetAt(clock),
      },
      account: null,
      // Advertised only when a sign-in route actually exists. Accounts are not built yet,
      // so this is empty and the page hides its Sign in link: a link to a route that was
      // never written is a 404 dressed up as a feature.
      signInUrl: String(env.TRIAL_SIGNIN_URL || "").trim() || null,
      turnstileRequired: Boolean(env.TRIAL_TURNSTILE_SECRET),
      model: modelInfo(env),
    },
  };
}

/** The label the page prints. It must match what is actually answering. */
export function modelInfo(env = {}) {
  const chain = providerChain(env);
  const primary = chain[0] ?? DEFAULT_PROVIDER;
  const fallback = chain[1] ?? null;
  // A var set to the empty string counts as unset: the label has to follow the
  // provider that is actually configured, or the page names the wrong model.
  const label = String(env.TRIAL_MODEL_LABEL ?? "").trim();
  const note = String(env.TRIAL_MODEL_NOTE ?? "").trim();
  // No chain at all is not a missing setting, it is a decision: the hosted path is off
  // and the answer comes from the visitor's own machine. The page has to be able to
  // tell the difference, so it says so instead of naming a model that will never run.
  if (!chain.length) {
    return {
      provider: null,
      fallback: null,
      hosted: false,
      label: label || "your own machine",
      note: note || "the demo runs where you are: your graphics card, or your own copy of the app",
    };
  }
  return {
    provider: primary,
    fallback,
    hosted: true,
    label: label || defaultLabel(primary),
    note: note || defaultNote(primary, fallback),
  };
}

/** The label of a provider in the chain, for the one that actually answered. */
export function providerLabel(provider) {
  return defaultLabel(provider);
}

function defaultLabel(provider) {
  if (provider === "opencode-free") return "DeepSeek V4.1 Flash (free)";
  if (provider === "omniroute") return "OmniRoute (free models)";
  if (provider === "stub") return "Stub model";
  return MODEL_LABEL_DEFAULT;
}

function defaultNote(provider, fallback) {
  if (provider === "opencode-free") {
    const base = "a free model, borrowed from a shared public window";
    return fallback
      ? `${base}; when that window is spent, ${defaultLabel(fallback)} answers instead`
      : base;
  }
  if (provider === "stub") return "no model at all: three fixed sentences, for local development";
  return MODEL_NOTE_DEFAULT;
}

/**
 * Cloudflare Turnstile, off unless a secret is configured. A missing token is a
 * refusal without a network call, so a bot never even costs a D1 row.
 */
export async function verifyTurnstile({ token, secret, ip, fetchImpl = fetch, warn = defaultWarn }) {
  if (!secret) return;
  if (!token) {
    throw new TrialError("turnstile", "The demo needs the human check before it can answer. Reload the page and try again.");
  }
  const form = new URLSearchParams({ secret: String(secret), response: String(token) });
  if (ip && ip !== "unknown") form.set("remoteip", ip);
  let data = null;
  try {
    const response = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    data = await response.json();
  } catch (err) {
    warn(`trial: turnstile verify failed: ${redact(err?.message ?? err)}`);
  }
  if (!data?.success) {
    throw new TrialError("turnstile", "The human check did not pass. Reload the page and try again.");
  }
}

/**
 * The OpenCode session id: `ses_` + 12 lowercase hex + 14 base62 characters.
 *
 * This is a gate, not an identity. The gateway validates the shape and nothing
 * else, which is why the id can be derived from a constant seed - every visitor
 * gets the same one, and prompt-cache affinity (the only reason the field exists
 * upstream) is irrelevant for a five-message demo.
 */
export async function openCodeSessionToken(seed = "rosalena-public-trial") {
  const digest = await sha256Bytes(String(seed ?? "rosalena-public-trial"));
  const hex = toHex(digest.subarray(0, 6));
  const suffix = Array.from(digest.subarray(6, 20), (byte) => BASE62[byte % 62]).join("");
  const token = `ses_${hex}${suffix}`;
  if (!OPENCODE_SESSION_RE.test(token)) {
    throw new TrialError("provider", "The trial could not build the session id the free provider requires.");
  }
  return token;
}

/** The headers the free gateway requires. Four of them carry the same token. */
export function openCodeHeaders(token, key) {
  return {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-opencode-session": token,
    "x-session-affinity": token,
    "x-opencode-session-id": token,
    "x-session-id": token,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "user-agent": "opencode/latest/2.0.29/cli",
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
}

/**
 * The one tool the gateway insists on, and nothing else.
 *
 * It is a wire requirement, not a capability: the trial never offers a tool it can
 * run, this stub has no implementation behind it, and the streaming path reads only
 * `delta.content`, so a tool call would be dropped rather than executed. Measured: a
 * body without `tools` is refused 403 "the free tier can only be used from within
 * OpenCode", so the field has to stay even though nothing can call it.
 */
export const READ_TOOL = Object.freeze({
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
});

export function openCodeBody({ messages, maxTokens, temperature }) {
  return {
    model: OPENCODE_MODEL,
    stream: true,
    max_tokens: maxTokens,
    temperature,
    messages,
    // Kept because the gateway refuses a body without it, but pinned to "none":
    // tool_choice "auto" was measured spending the whole answer budget on a tool call
    // that this page could not run, and the visitor saw an empty bubble.
    tools: [READ_TOOL],
    tool_choice: "none",
  };
}

/**
 * The bring-your-own-key header. The page keeps the visitor's own OpenCode key in
 * sessionStorage and sends it here, never in a URL, so it is not in a history entry,
 * a Referer header or a proxy log.
 *
 * A key is a credential, so it is validated only as narrowly as the transport needs:
 * printable ASCII, no whitespace, bounded length. It is never compared with anything
 * and never checked locally - the only judge of a key is the provider that issued it.
 */
export const USER_KEY_HEADER = "x-trial-user-key";
const MAX_USER_KEY_CHARS = 400;
// Eight, not one: redact() ignores values shorter than six characters so it cannot
// scrub every "a" out of a log line, and a key must never be shorter than what that
// scrubber can catch - otherwise the one thing that must not be logged could slip past
// it. No real provider key is eight characters, so this rejects nothing that works.
const MIN_USER_KEY_CHARS = 8;

export function userKeyFromRequest(request) {
  const raw = request?.headers?.get?.(USER_KEY_HEADER);
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!key) return "";
  const usable =
    key.length >= MIN_USER_KEY_CHARS && key.length <= MAX_USER_KEY_CHARS && /^[\x21-\x7e]+$/.test(key);
  if (!usable) {
    throw new TrialError(
      "bad_request",
      `The ${USER_KEY_HEADER} header does not look like a key this demo can forward: a key is at least ${MIN_USER_KEY_CHARS} printable characters with no spaces. Paste it again, or leave the field empty to use the demo's shared window.`,
    );
  }
  return key;
}

/** Accept a ReadableStream or any async iterable of bytes. */
function byteChunks(body) {
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) yield value;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            /* the stream is already gone */
          }
        }
      },
    };
  }
  return body;
}

/** Parse an OpenAI-shaped SSE body into events. */
async function* sseEvents(body) {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of byteChunks(body)) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // A provider keepalive or a partial block; the next chunk completes it.
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/**
 * Workers AI: the shipping provider. `env.AI.run` with `stream: true` returns an
 * async iterable of `{response}` chunks, each one a piece of the same answer.
 */
export async function* runWorkersAI({ env = {}, messages, maxTokens }) {
  if (!env?.AI || typeof env.AI.run !== "function") {
    throw new TrialError("provider", "Workers AI is not bound on this deployment, so the demo cannot answer.");
  }
  const model = String(env.TRIAL_MODEL || WORKERS_AI_MODEL_DEFAULT);
  const stream = await env.AI.run(model, { messages, stream: true, max_tokens: maxTokens });
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new TrialError("provider", "Workers AI did not return a stream, so the demo cannot answer.");
  }
  // The real binding returns a ReadableStream of SSE bytes (`data: {"response": ...}`), not
  // objects: iterating it as objects read every chunk as empty, and the live fallback
  // answered with nothing. Newer models put the text in `choices[0].delta.content`.
  const events = typeof stream.getReader === "function" ? sseEvents(stream) : stream;
  for await (const chunk of events) {
    const piece = typeof chunk === "string" ? chunk : (chunk?.response ?? chunk?.choices?.[0]?.delta?.content);
    if (typeof piece === "string" && piece) yield { delta: piece };
  }
}

/**
 * OpenCode Zen's free tier. This is here for deliberate demos, not for public
 * traffic; TRIAL.md says why in full. The wire shape is copied exactly, because
 * the gateway checks it: a buffered request, a missing client fingerprint, a
 * session id of the wrong shape, or a request with no tool named `read` are all
 * answered with 403 rather than with a model.
 */
export async function* runOpenCode({
  env = {},
  messages,
  limits,
  signal,
  fetchImpl = fetch,
  userKey = "",
  warn = defaultWarn,
}) {
  // The visitor's own key wins when there is one: it spends their window instead of
  // the shared one, which is the only version of this provider that can face the
  // public. Without it the Worker's egress address is the credential, and that is a
  // demo-only mode - TRIAL.md says so in the same words.
  const own = String(userKey ?? "").trim();
  const key = own || (env.OPENCODE_API_KEY ? String(env.OPENCODE_API_KEY) : "");
  const token = await openCodeSessionToken(env.TRIAL_SESSION_SEED || "rosalena-public-trial");
  const response = await fetchImpl(OPENCODE_ENDPOINT, {
    method: "POST",
    headers: openCodeHeaders(token, key),
    body: JSON.stringify(
      openCodeBody({ messages, maxTokens: limits.maxOutputTokens, temperature: limits.temperature }),
    ),
    signal,
  });

  if (response.status === 429) {
    throw new TrialError(
      "quota",
      own
        ? "The free window on the key you pasted is spent for now. It refills on the provider's own schedule, so try again later, or clear the key to fall back to the demo's shared window."
        : "The shared free window this demo borrows is spent for now. It refills on the provider's own schedule, so try the demo again later.",
    );
  }
  if (!response.ok) {
    // Read the body only to log it redacted; the visitor gets a fixed sentence so
    // no upstream text (and no key the gateway may echo) can reach the browser.
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    // When the key is the visitor's, the upstream body is not logged at all: an error
    // body is the most likely place a provider echoes a credential back, and the
    // status is all an operator needs to see.
    const logged = own ? "" : redact(detail, [key]).slice(0, 400);
    warn(`trial: opencode answered ${response.status}${logged ? `: ${logged}` : ""}`);
    const refusedKey = own !== "" && (response.status === 401 || response.status === 403);
    throw new TrialError(
      "provider",
      refusedKey
        ? "The free provider refused the key you pasted, so the demo could not answer. Check the key, or clear it to use the demo's shared window."
        : "The free provider refused the request, so the demo could not answer. Try again in a moment.",
    );
  }

  // This model reasons before it speaks: `completion_tokens_details.reasoning_tokens`
  // was measured at 55 of an 80-token budget, with finish_reason "length" and an empty
  // answer. Tracking the visible text lets the page say why a bubble is empty instead
  // of showing one.
  let spoken = "";
  for await (const event of sseEvents(response.body)) {
    const delta = event?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      spoken += delta;
      yield { delta };
    }
    if (event?.usage) {
      yield {
        usage: {
          input: Number(event.usage.prompt_tokens ?? 0),
          output: Number(event.usage.completion_tokens ?? 0),
        },
      };
    }
  }
  if (!spoken.trim()) {
    throw new TrialError(
      "provider",
      "The free model spent its whole reply budget thinking and never got to an answer. Try a shorter question, or ask again.",
    );
  }
}

/**
 * OmniRoute: an OpenAI-compatible gateway (github.com/diegosouzapw/OmniRoute) that spreads
 * requests over many providers' free tiers. It runs on the owner's machine, so the Worker
 * reaches it through a public https address (OMNIROUTE_URL, e.g. a Cloudflare Tunnel) and
 * must send a key (OMNIROUTE_API_KEY): an open gateway on the internet spends the owner's
 * provider accounts for anyone who finds it. Without both it refuses and the chain moves on.
 */
export async function* runOmniRoute({ env = {}, messages, limits, signal, fetchImpl = fetch, warn = defaultWarn }) {
  const base = String(env.OMNIROUTE_URL ?? "").trim().replace(/\/+$/, "");
  const key = String(env.OMNIROUTE_API_KEY ?? "").trim();
  if (!base || !key) {
    throw new TrialError("provider", "The free gateway is not set up on this deployment, so it could not answer.");
  }
  // The gateway lives on a PC that may be asleep, offline or slow, so it gets its own
  // first-token deadline, well inside the request's: the chain can only fall through
  // before the first delta, and a gateway that eats the whole budget leaves the next
  // provider no time. A dead tunnel (DNS gone, connection refused) also has to become a
  // TrialError here, or the chain treats it as fatal instead of moving on.
  // 20 s: auto/fast's GLM was measured at 7-17 s to its first token (heartbeats before).
  const firstByteMs = parseLimit(env.OMNIROUTE_FIRST_BYTE_MS, 20000, 50, 60000);
  const local = new AbortController();
  const onOuterAbort = () => local.abort();
  signal?.addEventListener?.("abort", onOuterAbort);
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    local.abort();
  }, firstByteMs);
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onOuterAbort);
  };
  const tooSlow = () =>
    new TrialError("provider", "The free gateway took too long to start answering, so the demo moved on.");
  let response;
  try {
    response = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: String(env.OMNIROUTE_MODEL || "auto"),
        stream: true,
        max_tokens: limits.maxOutputTokens,
        temperature: limits.temperature,
        messages: systemIntoFirstUser(messages),
      }),
      signal: local.signal,
    });
  } catch (err) {
    cleanup();
    if (late) throw tooSlow();
    if (signal?.aborted) throw err;
    warn(`trial: omniroute unreachable: ${redact(String(err?.message ?? err), [key]).slice(0, 200)}`);
    throw new TrialError("provider", "The free gateway is offline right now, so the demo moved on.");
  }
  if (!response.ok) cleanup();
  if (response.status === 429) {
    throw new TrialError("quota", "Every free model behind the gateway is busy for now, so try the demo again later.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    warn(`trial: omniroute answered ${response.status}: ${redact(detail, [key]).slice(0, 400)}`);
    throw new TrialError("provider", "The free gateway refused the request, so the demo could not answer. Try again in a moment.");
  }
  let spoken = "";
  let model = "";
  try {
    for await (const event of sseEvents(response.body)) {
      // auto/fast picks a different model per request; the log says which one spoke.
      // The gateway's heartbeats while a model thinks carry model "keepalive".
      if (typeof event?.model === "string" && event.model && event.model !== "keepalive") model = event.model;
      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        if (!spoken && model) yield { model };
        if (!spoken) clearTimeout(timer);
        spoken += delta;
        yield { delta };
      }
      if (event?.usage) {
        yield { usage: { input: Number(event.usage.prompt_tokens ?? 0), output: Number(event.usage.completion_tokens ?? 0) } };
      }
    }
  } catch (err) {
    if (late && !spoken) throw tooSlow();
    throw err;
  } finally {
    cleanup();
  }
  if (!spoken.trim()) throw new TrialError("provider", "The free gateway sent an empty answer. Ask again.");
}

/**
 * The system prompt at the top of the first user message. OmniRoute's auto routes land on
 * its keyless Cloudflare playground bridge, which drops every system message (measured
 * 2026-10-29: the search instruction never reached GLM, which then only announced a
 * search). The demo's prompt is short enough for the bridge's 6000-character cap.
 */
export function systemIntoFirstUser(messages = []) {
  const system = messages.filter((m) => m?.role === "system").map((m) => String(m.content ?? "").trim()).filter(Boolean);
  const rest = messages.filter((m) => m?.role !== "system");
  const first = rest.findIndex((m) => m?.role === "user");
  if (!system.length || first === -1) return messages;
  const head = `Instructions for this conversation:\n\n${system.join("\n\n")}\n\n---\n\n`;
  return rest.map((m, i) => (i === first ? { ...m, content: head + String(m.content ?? "") } : m));
}

/** Three fixed deltas, no network: the provider the tests and local dev use. */
export async function* runStub() {
  yield { delta: "Hello" };
  yield { delta: " from the trial" };
  yield { delta: " stub provider. No network, no model, deterministic on purpose." };
}

/** Pick the provider by env. Unknown names fail closed. */
export function streamAnswer({ provider, env, messages, limits, signal, fetchImpl, userKey = "", warn }) {
  switch (provider) {
    case "workers-ai":
      return runWorkersAI({ env, messages, maxTokens: limits.maxOutputTokens });
    case "opencode-free":
      return runOpenCode({ env, messages, limits, signal, fetchImpl, userKey, warn });
    case "omniroute":
      return runOmniRoute({ env, messages, limits, signal, fetchImpl, warn });
    case "stub":
      return runStub();
    default:
      throw new TrialError(
        "provider",
        `This deployment is set to provider "${provider}", which the trial does not serve.`,
      );
  }
}

/** Failures worth trying the next provider for. A bad request or a bot check is not. */
const RETRYABLE_KINDS = new Set(["quota", "provider"]);

/**
 * Walk the chain until one provider actually produces a first token.
 *
 * The first yield is a marker the browser never sees: it names the provider that is
 * about to speak, so the `done` frame can say *which* model answered. That matters on
 * this page more than it looks: "the free window was busy, so a small model on
 * Cloudflare answered instead" is a sentence a visitor can trust, and a silent
 * substitution is the kind of thing that erodes trust in every other number the app
 * shows.
 *
 * Fallback only happens *before* the first delta. Once text has been streamed, a late
 * failure is reported as an error frame instead: switching providers mid-sentence
 * would splice two models' answers together and read as corruption.
 */
export async function* chainAnswer({ chain, env, messages, limits, signal, fetchImpl, userKey = "", warn = defaultWarn }) {
  const names = chain?.length ? chain : [DEFAULT_PROVIDER];
  let lastError = null;
  let degraded = false;

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    let iterator;
    let first;
    try {
      iterator = streamAnswer({ provider: name, env, messages, limits, signal, fetchImpl, userKey, warn });
      // Pull before committing: a 429 or a dead binding has to arrive here, where the
      // next provider can still be tried, not as a 200 that dies on its second byte.
      first = await iterator.next();
    } catch (err) {
      const retryable = err instanceof TrialError && RETRYABLE_KINDS.has(err.kind);
      if (retryable && index < names.length - 1) {
        warn(`trial: ${name} could not answer (${err.kind}), trying ${names[index + 1]}`);
        lastError = err;
        degraded = true;
        continue;
      }
      throw err;
    }

    yield { provider: name, degraded, fellBackFrom: degraded ? names[index - 1] : null };
    let emitted = false;
    let finished = false;
    try {
      if (!first.done) {
        const event = first.value;
        if (event?.delta) emitted = true;
        if (event?.delta || event?.usage || event?.model) yield event;
      }
      for (;;) {
        const step = await iterator.next();
        if (step.done) {
          finished = true;
          return;
        }
        if (step.value?.delta) emitted = true;
        yield step.value;
      }
    } catch (err) {
      finished = true;
      const retryable = err instanceof TrialError && RETRYABLE_KINDS.has(err.kind);
      if (retryable && !emitted && index < names.length - 1) {
        warn(`trial: ${name} stopped before its first token (${err.kind}), trying ${names[index + 1]}`);
        lastError = err;
        degraded = true;
        continue;
      }
      throw err;
    } finally {
      // Closed early (a tool call was cut, the visitor left): stop reading this provider.
      if (!finished) await iterator.return?.();
    }
  }

  throw lastError ?? new TrialError("provider", "No model the demo can use is answering right now. Try again in a moment.");
}

/** Any provider failure becomes one shape, and its text is ours, not upstream's. */
export function providerFailure(err, { secrets = [], warn = defaultWarn } = {}) {
  if (err instanceof TrialError) return err;
  warn(`trial: provider failed: ${redact(err?.message ?? String(err), secrets)}`);
  return new TrialError("provider", "The demo model did not answer. Try again in a moment.");
}

async function readJsonBody(request) {
  if (!request || typeof request.text !== "function") throw new Error("no body reader");
  const text = await request.text();
  if (!text || !text.trim()) throw new Error("empty body");
  return JSON.parse(text);
}

/**
 * The ways a model writes a tool call into its text: Hermes/Qwen/GLM, DeepSeek's two
 * spellings, Llama 3.1's built-in tools, Mistral, and the function-call forms. The trial
 * offers no tool, so a model that tries one anyway (measured: OmniRoute's auto/fast
 * answering "is this company any good" with `<tool_call>search_web{...}`) would otherwise
 * show the visitor raw markup.
 */
export const TOOL_CALL_MARKERS = Object.freeze([
  "[[search", "<tool_call", "<|tool_call", "<｜tool", "<tool▁call", "<|python_tag|>", "[TOOL_CALLS]", "<function=", "<function_call",
]);
const LONGEST_MARKER = Math.max(...TOOL_CALL_MARKERS.map((m) => m.length));

/** What the visitor reads where the tool call would have been. */
export const TOOL_CALL_NOTE =
  "\n\n(The model tried to search or use a tool here. This page can only talk; web search and tools run in the desktop app.)";

const fenceCount = (text) => text.split("```").length - 1;

/**
 * Cuts an answer at the first tool-call marker and puts `note` there (none when the caller
 * decides what follows, as the search does). Everything from the marker on is kept in
 * `call`, for searchQueryFrom. Streamed text arrives in pieces, so a tail that could still
 * become a marker ("<tool") is held back until the next piece decides it. Inside a code
 * block a marker is content (a visitor asking what a tool call looks like), so it passes.
 */
export function createToolCallScrubber({ note = TOOL_CALL_NOTE } = {}) {
  let pending = "";
  let fences = 0;
  let cut = false;
  let call = "";
  const pass = (text) => {
    fences += fenceCount(text);
    return text;
  };
  const firstMarker = (text) => {
    let best = -1;
    for (const marker of TOOL_CALL_MARKERS) {
      const at = text.indexOf(marker);
      if (at !== -1 && (best === -1 || at < best)) best = at;
    }
    return best;
  };
  const heldFrom = (text) => {
    for (let i = Math.max(0, text.length - LONGEST_MARKER + 1); i < text.length; i += 1) {
      const tail = text.slice(i);
      if (TOOL_CALL_MARKERS.some((marker) => marker.startsWith(tail))) return i;
    }
    return text.length;
  };
  return {
    get cut() {
      return cut;
    },
    get call() {
      return call;
    },
    /** The part of `text` that can be shown now. */
    push(text) {
      if (cut) {
        if (call.length < 2000) call += text;
        return "";
      }
      const buf = pending + text;
      pending = "";
      const at = firstMarker(buf);
      if (at !== -1 && (fences + fenceCount(buf.slice(0, at))) % 2 === 0) {
        cut = true;
        call = buf.slice(at);
        return pass(buf.slice(0, at).trimEnd()) + (note ?? "");
      }
      if (at !== -1) return pass(buf);
      const hold = heldFrom(buf);
      pending = buf.slice(hold);
      return pass(buf.slice(0, hold));
    },
    /** Whatever was held back, once the answer is over. */
    end() {
      const rest = cut ? "" : pending;
      pending = "";
      return rest;
    },
  };
}

/** Every round's tokens, from the provider when it said, estimated when it did not. */
function totalUsage(rounds) {
  return rounds.reduce(
    (sum, r) => {
      const u = r.usage ?? estimateUsage(r.messages, r.output);
      return { input: sum.input + Number(u.input ?? 0), output: sum.output + Number(u.output ?? 0) };
    },
    { input: 0, output: 0 },
  );
}

/**
 * The answer's time limit. It starts with the request and starts over when a model
 * speaks its first token, and again when a searched answer begins, so a slow fallback
 * or a search never leaves the model that answers a few seconds to finish in.
 */
function createDeadline(ms, controller) {
  let expire = () => {};
  const promise = new Promise((_, reject) => {
    expire = reject;
  });
  // Mark it handled now: when the request fails before the first chunk is pulled,
  // nothing ever races this promise and a bare rejection would surface as an
  // unhandled rejection in the Workers log (and in the test runner).
  promise.catch(() => {});
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    // Ref'd on purpose: this timer is the ONLY thing that can settle `promise`; where
    // nothing else holds the event loop (a unit test driving handleTrial directly) node
    // drops an unref'd timer and the request that should be cut off hangs instead.
    timer = setTimeout(() => {
      controller.abort();
      expire(new TrialError("provider", "The demo model took too long to answer, so the answer was cut off. Try a shorter question."));
    }, ms);
  };
  arm();
  return { promise, restart: arm, clear: () => clearTimeout(timer) };
}

/**
 * Frames the answer, holds the in-flight slot until the last byte, reports the quota
 * the visitor has left once the model is done, and then settles the books: the answer's
 * tokens go onto every budget it was spent against, and one log row records the attempt.
 *
 * The slot is released in `finally`, so an aborted stream frees it too; the 2 s TTL
 * is only there for a request that dies without ever closing its stream. Both the tally
 * and the log swallow their own errors: the bytes are already with the visitor, and
 * bookkeeping must never be able to unsend an answer.
 */
async function* emitAnswer({ first, iterator, deadline, controller, guard, ipScope, quota, messages, secrets, warn, report, search = null }) {
  // `output` keeps what the model wrote, for the log; the visitor gets the scrubbed text.
  let output = "";
  let failed = false;
  // The provider's own words for a late failure, redacted at the point of capture. Kept
  // for the row written after the stream closes: without it a failed answer is
  // indistinguishable from a model that returned nothing on purpose.
  let failure = null;
  // Who is speaking, filled by the chain's marker event. When the first provider said
  // its window was spent, `degraded` is true and the page says so next to the answer.
  let answeredBy = null;
  let answeredModel = null;
  let degraded = false;
  let fellBackFrom = null;
  // One round per model call: the answer, or the search request and then the answer.
  const rounds = [{ messages, output: "", usage: null }];
  let round = rounds[0];
  let it = iterator;
  let scrub = createToolCallScrubber({ note: search ? null : TOOL_CALL_NOTE });
  let spoke = false;
  let sources = "";
  try {
    let step = first;
    for (;;) {
      const event = step.done ? null : step.value;
      if (event?.provider) {
        answeredBy = event.provider;
        answeredModel = null;
        degraded = Boolean(event.degraded);
        fellBackFrom = event.fellBackFrom ?? null;
        step = await Promise.race([it.next(), deadline.promise]);
        continue;
      }
      if (event?.model) answeredModel = String(event.model).slice(0, 80);
      if (event?.delta) {
        // The time limit is for one model's answer, counted from its first token: the
        // providers that failed before it, and the search, do not eat into it.
        if (!spoke) deadline.restart();
        spoke = true;
        output += event.delta;
        round.output += event.delta;
        const shown = scrub.push(event.delta);
        if (shown) {
          round.shown = true;
          yield sseFrame({ delta: shown });
        }
      }
      if (event?.usage) round.usage = event.usage;

      const searching = search && rounds.length === 1 && scrub.cut;
      const announced = search && rounds.length === 1 && step.done && !scrub.cut && wantsSearch(round.output);
      if ((searching && (step.done || callIsComplete(scrub.call))) || announced) {
        const query = searchQueryFrom(announced ? "" : scrub.call, report?.prompt ?? "");
        if (!query) {
          // A tool the trial does not have: say so where it would have run.
          yield sseFrame({ delta: TOOL_CALL_NOTE });
          break;
        }
        const before = scrub.end();
        if (before) yield sseFrame({ delta: before });
        // What the model said before it searched stays; the searched answer starts below it.
        if (round.shown || before) yield sseFrame({ delta: "\n\n" });
        await it.return?.();
        yield sseFrame({ tool: { name: "search_web", query, status: "running" } });
        let found;
        try {
          found = await search.run(query, controller.signal);
        } catch (err) {
          warn(`trial: search failed: ${String(err?.message ?? err).slice(0, 200)}`);
          found = { engine: null, hits: [], error: true };
        }
        yield sseFrame({
          tool: {
            name: "search_web",
            query,
            status: found.hits.length ? "done" : "failed",
            engine: found.engine,
            results: found.hits.map(({ title, url }) => ({ title, url })),
          },
        });
        sources = sourcesBlock(found);
        output += `\n\n[searched: ${query}${found.hits.length ? `, ${found.hits.length} results` : ", nothing found"}]\n\n`;
        const next = searchedMessages(messages, query, found);
        round = { messages: next, output: "", usage: null };
        rounds.push(round);
        scrub = createToolCallScrubber();
        spoke = false;
        deadline.restart();
        it = search.again(next, answeredBy);
        step = await Promise.race([it.next(), deadline.promise]);
        continue;
      }
      if (step.done) break;
      // Nothing after a tool call is meant for the visitor; stop paying for it.
      if (scrub.cut && !searching) break;
      step = await Promise.race([it.next(), deadline.promise]);
    }
    const tail = scrub.end();
    if (tail) yield sseFrame({ delta: tail });
    if (sources) yield sseFrame({ delta: sources });
    yield sseFrame({
      done: true,
      usage: totalUsage(rounds),
      quota,
      ...(answeredBy ? { provider: answeredBy, degraded, fellBackFrom } : {}),
    });
  } catch (err) {
    // The status line already said 200, so a late failure has to travel as an
    // event. The page renders it as an error bubble and the quota slot stays spent,
    // for the same reason as below: the model was already asked.
    failed = true;
    const raw = redact(err?.message ?? String(err), secrets);
    failure = raw ? `${err?.code ? `${err.code}: ` : ""}${raw}` : "the stream failed with no message";
    warn(`trial: stream failed: ${raw}`);
    const message = err instanceof TrialError ? err.message : "The demo model stopped partway through. Send the message again.";
    const tail = scrub.end();
    if (tail) yield sseFrame({ delta: tail });
    yield sseFrame({ error: message, kind: "provider" });
  } finally {
    deadline.clear();
    controller.abort();
    try {
      await it.return?.();
    } catch {
      /* the iterator is already finished */
    }
    guard.release(ipScope);
  }
  if (report?.db) {
    const finalUsage = totalUsage(rounds);
    const label = answeredBy && answeredBy !== report.provider ? providerLabel(answeredBy) : report.model;
    await tallyTokens(report.db, {
      day: report.day,
      tokens: finalUsage,
      scopes: report.tokenScopes ?? [],
      stamp: Date.now(),
      warn,
    });
    await writeTrialLog(report.db, {
      day: report.day,
      sid: report.sessionScope,
      ip: ipScope,
      provider: answeredBy ?? report.provider,
      model: answeredModel ? `${label}: ${answeredModel}` : label,
      status: failed ? "failed" : "ok",
      ms: Date.now() - (report.stamp ?? Date.now()),
      charsIn: report.charsIn,
      charsOut: output.length,
      tokensIn: finalUsage.input,
      tokensOut: finalUsage.output,
      prompt: report.prompt,
      answer: output,
      error: failure,
    }, { mode: report.mode, stamp: Date.now(), warn });
  }
  yield SSE_DONE;
}

/**
 * POST /api/trial: validate, reserve, stream. Returns `{status, headers, stream}`;
 * throws TrialError for every refusal, which the handler renders.
 *
 * Order matters and is deliberate:
 *   1. Origin, because a cross-site request should not even cost a hash.
 *   2. Caps, because a refused request must never consume a slot.
 *   3. Turnstile, because a bot should not consume one either.
 *   4. One reservation, which is the only thing standing between a front page and
 *      a bill, and is therefore the last gate before the provider is addressed.
 *
 * The visitor's own key, when one is sent, is read here and nowhere else: it is a
 * credential from the request, so it lives in one local variable and one upstream
 * header, and it is in the redaction list from the moment it exists.
 */
export async function handleTrial({
  request,
  env = {},
  clock = () => Date.now(),
  limits,
  fetchImpl,
  inflight,
  warn = defaultWarn,
} = {}) {
  const limit = limits ?? limitsFromEnv(env);
  const chain = providerChain(env);
  const provider = chain[0] ?? "";

  checkOrigin(request?.headers?.get?.("origin"), env, provider);

  // Nothing hosted answers on purpose. Refuse before the counter or any provider is
  // touched: an empty chain means the demo lives on the visitor's own machine, and a
  // refusal that costs nobody a message is the only one that fits that promise.
  if (!chain.length) {
    throw new TrialError(
      "provider",
      "This page does not answer from a server any more. It runs on your own machine: open the desktop app and try again, or use the in-browser model if your graphics card can hold it.",
    );
  }

  // A visitor's own key exists only for the provider that has accounts. It arrives in
  // a request header, so it is read once, forwarded once, and added to the redaction
  // list immediately: no path below may echo it, store it or log it, and this list is
  // what providerFailure() and emitAnswer() scrub their text with.
  const userKey = chain.includes("opencode-free") ? userKeyFromRequest(request) : "";
  const secrets = [env.OPENCODE_API_KEY, userKey];

  let raw;
  try {
    raw = await readJsonBody(request);
  } catch {
    throw new TrialError("bad_request", "The request body must be JSON: {message, history, turnstileToken}.");
  }
  const { message, history, turnstileToken } = validateTrialInput(raw, limit);

  const ip = requestIp(request);
  const ipScope = await ipFingerprint(ip, { salt: env.TRIAL_SALT, warn });
  // The session cookie is minted (or verified) before any gate, so every refusal that
  // follows can carry the browser's identity: a log row for a refused attempt that does
  // not say which browser it came from is a row nobody can act on.
  const session = await ensureSession(request, { salt: env.TRIAL_SALT });
  const setCookie = await sessionSetCookie(session.id, { salt: env.TRIAL_SALT });
  const day = utcDay(clock);
  const stamp = clock();
  const resetIso = resetAt(clock);
  const mode = logMode(env);
  const guard = inflight ?? sharedInflight;

  if (!guard.tryAcquire(ipScope)) {
    throw new TrialError(
      "capacity",
      "Another trial message from your connection is still running. The demo answers one message at a time, so give it a few seconds and send again.",
    );
  }

  let handedOff = false;
  try {
    await verifyTurnstile({ token: turnstileToken, secret: env.TRIAL_TURNSTILE_SECRET, ip, fetchImpl, warn });

    const db = env.TRIAL_DB;
    if (!db || typeof db.prepare !== "function") {
      throw new TrialError("provider", "This deployment has no trial database bound, so the demo cannot count messages.");
    }

    // The token wall is read, not reserved: only the provider knows what an answer
    // costs, so the day's spend is checked here and written down after the answer
    // lands. Refusals here cost nothing, and they are logged, because a visitor
    // pushing on the token budget is exactly the pattern the log exists to catch.
    const tokenWall = [
      { scope: session.scope, limit: limit.sessionTokensPerDay, kind: "quota",
        message: `This browser has used all ${limit.sessionTokensPerDay.toLocaleString("en-US")} trial tokens for today. The counter resets at ${resetIso} (UTC).` },
      { scope: ipScope, limit: limit.ipTokensPerDay, kind: "quota",
        message: `This connection has used all ${limit.ipTokensPerDay.toLocaleString("en-US")} trial tokens for today. The counter resets at ${resetIso} (UTC).` },
      { scope: QUOTA_SCOPE_GLOBAL, limit: limit.globalTokensPerDay, kind: "capacity",
        message: `The demo has spent its daily token budget for today. The counter resets at ${resetIso} (UTC).` },
    ];
    const spent = await readTokenUsage(db, day, tokenWall.map((entry) => entry.scope));
    for (let i = 0; i < tokenWall.length; i += 1) {
      if (spent[i].total >= tokenWall[i].limit) {
        const err = new TrialError(tokenWall[i].kind, tokenWall[i].message);
        err.retryAfter = secondsUntil(resetIso, stamp);
        await writeTrialLog(db, {
          day, sid: session.scope, ip: ipScope, provider, model: modelInfo(env).label,
          status: "refused", kind: "quota", ms: 0, charsIn: message.length,
        }, { mode, stamp, warn });
        throw err;
      }
    }

    const reserved = await reserveUsage(db, {
      day,
      stamp,
      resetIso,
      scopes: [
        { scope: session.scope, limit: limit.sessionPerDay, kind: "quota",
          message: (n, iso) => `You have used all ${n} trial messages for today in this browser. The counter resets at ${iso} (UTC).` },
        { scope: ipScope, limit: limit.ipPerDay, kind: "quota",
          message: (n, iso) => `This connection has used all ${n} trial messages for today. The counter resets at ${iso} (UTC).` },
        { scope: QUOTA_SCOPE_GLOBAL, limit: limit.globalPerDay, kind: "capacity",
          message: (n, iso) => `The demo is full for today: all ${n} messages are used up. The counter resets at ${iso} (UTC).` },
      ],
    }).catch(async (err) => {
      // A message refusal is the most common refusal and the one abuse review looks
      // for first: somebody spinning the demo until the counter refuses them.
      await writeTrialLog(db, {
        day, sid: session.scope, ip: ipScope, provider, model: modelInfo(env).label,
        status: "refused", kind: err.kind, ms: 0, charsIn: message.length,
      }, { mode, stamp, warn });
      throw err;
    });

    const canSearch = searchEnabled(env);
    const messages = buildMessages({ message, history, search: canSearch ? "on" : "off" });
    const controller = new AbortController();
    // The catch below and emitAnswer both clear it, so it cannot outlive the answer.
    const deadline = createDeadline(limit.timeoutMs, controller);
    const search = canSearch
      ? {
          run: (query, signal) => webSearch(query, { env, fetchImpl: fetchImpl ?? fetch, signal }),
          // The searched answer goes to the model that asked first, then down the chain.
          again: (next, preferred) =>
            chainAnswer({
              chain: preferred ? [preferred, ...chain.filter((name) => name !== preferred)] : chain,
              env, messages: next, limits: limit, signal: controller.signal, fetchImpl, userKey, warn,
            }),
        }
      : null;

    let iterator;
    try {
      iterator = chainAnswer({ chain, env, messages, limits: limit, signal: controller.signal, fetchImpl, userKey, warn });
      // Pull the first event before committing to 200: a bad key, a 429 or a dead
      // upstream must arrive as a real non-200 JSON refusal, not as a 200 that dies
      // on its second byte.
      const first = await Promise.race([iterator.next(), deadline.promise]);
      handedOff = true;
      return {
        status: 200,
        headers: { ...sseHeaders(), "set-cookie": setCookie },
        stream: emitAnswer({
          first,
          iterator,
          deadline,
          controller,
          search,
          guard,
          ipScope,
          quota: {
            used: reserved.find((row) => row.scope === session.scope)?.used ?? 0,
            limit: limit.sessionPerDay,
            resetAt: resetIso,
            address: {
              used: reserved.find((row) => row.scope === ipScope)?.used ?? 0,
              limit: limit.ipPerDay,
            },
            tokens: {
              used: spent[0].total,
              limit: limit.sessionTokensPerDay,
              global: { used: spent[2].total, limit: limit.globalTokensPerDay },
            },
          },
          messages,
          secrets,
          warn,
          report: {
            db,
            day,
            stamp,
            sessionScope: session.scope,
            mode,
            provider,
            model: modelInfo(env).label,
            charsIn: message.length,
            prompt: message,
            tokenScopes: tokenWall.map((entry) => entry.scope),
          },
        }),
      };
    } catch (err) {
      deadline.clear();
      controller.abort();
      // No refund here, and that is the rule for every failure after the
      // reservation: the slot was spent when the request went upstream. Refunding a
      // failed generation would let a visitor walk past the daily cap by sending
      // prompts the model rejects; keeping it costs one slot out of five and is the
      // only behaviour that cannot be farmed.
      await writeTrialLog(db, {
        day, sid: session.scope, ip: ipScope, provider, model: modelInfo(env).label,
        status: "failed", kind: "provider", ms: Date.now() - stamp, charsIn: message.length,
        // No answer exists: the first pull failed. Keeping the prompt next to the error
        // is what makes a report ("it said the model didn't answer") checkable later.
        prompt: message, answer: "",
        error: redact(err?.message ?? String(err), secrets),
      }, { mode, stamp: Date.now(), warn });
      throw providerFailure(err, { secrets, warn });
    }
  } finally {
    if (!handedOff) guard.release(ipScope);
  }
}

/** Turn a descriptor from this module into a real Response. */
export function toResponse(result) {
  if (result?.stream) {
    return new Response(streamBody(result.stream), { status: result.status, headers: result.headers });
  }
  return new Response(JSON.stringify(result?.json ?? {}), { status: result?.status ?? 500, headers: result?.headers });
}

function streamBody(iterable) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterable.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      try {
        await iterable.return?.();
      } catch {
        /* already finished */
      }
    },
  });
}
