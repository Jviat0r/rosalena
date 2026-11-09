/**
 * The two things that stop a router from being a toy: it must not spend money it
 * was told not to spend, and it must not die because the first key is rate-limited.
 *
 * Both live here, and both are deliberately the only stateful parts of the system.
 * Everything else in the router is a pure decision made from this state plus config.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Budgets are monthly and read in UTC, so two machines agree on the boundary. */
export function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Cost of one call in USD. Accepts either OpenAI's usage field names or
 * Anthropic's (input_tokens/output_tokens), because normalising usage is exactly
 * the kind of small mismatch that otherwise shows up as a silently-zero bill.
 */
export function computeCostUsd(prices, usage) {
  if (!prices || !usage) return 0;
  const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const rateIn = prices.in ?? 0;
  const rateOut = prices.out ?? 0;
  // Anthropic reports prompt-cache traffic OUTSIDE input_tokens: reads are billed at a
  // tenth of the input price and 5-minute cache writes at 1.25x, unless the row says
  // otherwise. Left out, a cached agent run looked about four times cheaper than it was.
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const usd =
    (inTok / 1e6) * rateIn +
    (outTok / 1e6) * rateOut +
    (cacheRead / 1e6) * (prices.cacheRead ?? rateIn * 0.1) +
    (cacheWrite / 1e6) * (prices.cacheWrite ?? rateIn * 1.25);
  // Six decimals: a single cheap call can legitimately cost $0.000004, and
  // rounding it to 0 in the ledger would make the budget cap useless.
  return Math.round(usd * 1e6) / 1e6;
}

/** A monthly spend ledger per provider, persisted so a restart cannot reset a cap. */
export class Ledger {
  #file;
  #data;

  constructor(file) {
    this.#file = file;
    this.#data = { months: {} };
    this.load();
  }

  load() {
    try {
      if (this.#file && existsSync(this.#file)) {
        const parsed = JSON.parse(readFileSync(this.#file, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.months) this.#data = parsed;
      }
    } catch {
      // A corrupt ledger must not take the router down. Start clean and keep serving.
      this.#data = { months: {} };
    }
  }

  #bucket(month = monthKey()) {
    this.#data.months[month] ??= { providers: {} };
    this.#data.months[month].providers ??= {};
    return this.#data.months[month].providers;
  }

  spent(provider, month = monthKey()) {
    return this.#bucket(month)[provider]?.usd ?? 0;
  }

  record(provider, usd, info = {}) {
    const b = this.#bucket();
    b[provider] ??= { usd: 0, calls: 0, tokensIn: 0, tokensOut: 0 };
    const row = b[provider];
    row.usd = Math.round((row.usd + usd) * 1e6) / 1e6;
    row.calls += 1;
    row.tokensIn += info.tokensIn ?? 0;
    row.tokensOut += info.tokensOut ?? 0;
    row.lastModel = info.model ?? row.lastModel;
    row.lastAt = new Date().toISOString();
    this.save();
  }

  /**
   * Is this provider still inside its cap? An absent, zero or negative cap means
   * uncapped, which is what `local` wants: it is free and must never be skipped
   * for budget reasons.
   */
  within(provider, capUsd, month = monthKey()) {
    if (capUsd === null || capUsd === undefined || capUsd <= 0) return true;
    return this.spent(provider, month) < capUsd;
  }

  remaining(provider, capUsd, month = monthKey()) {
    if (capUsd === null || capUsd === undefined || capUsd <= 0) return null;
    return Math.max(0, Math.round((capUsd - this.spent(provider, month)) * 1e6) / 1e6);
  }

  snapshot(month = monthKey()) {
    return { month, providers: this.#bucket(month) };
  }

  save() {
    if (!this.#file) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
      // Rename, not write-in-place: a crash mid-write must not corrupt the ledger.
      renameSync(tmp, this.#file);
    } catch {
      // Losing a ledger write is survivable; failing a live request is not.
    }
  }
}

function splitKeys(value) {
  return String(value)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read provider keys from a JSON file.
 *
 * Shape, deliberately flat and forgiving so a hand-edited file works:
 *
 *   { "providers": { "opencode-free": ["oc_sk_..."] }, "anthropic": "sk-ant-..." }
 *
 * Both a bare `{ provider: keyOrList }` map and the wrapped `providers` form are
 * accepted, a string is one key, and anything malformed is skipped rather than
 * thrown: a typo in a secrets file must not stop the router from booting.
 * A missing file is not an error - most installs use environment variables.
 */
export function readKeyFile(file) {
  const out = {};
  if (!file) return out;
  let raw;
  try {
    if (!existsSync(file)) return out;
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return out;
  }
  const table = raw && typeof raw === "object" && raw.providers && typeof raw.providers === "object" ? raw.providers : raw;
  for (const [provider, value] of Object.entries(table ?? {})) {
    if (provider === "providers" || provider.startsWith("$") || provider.startsWith("_")) continue;
    const list = Array.isArray(value) ? value : [value];
    const keys = list.filter((v) => typeof v === "string").flatMap((v) => splitKeys(v));
    if (keys.length) out[provider] = keys;
  }
  return out;
}

/** Never log a whole key. Enough to tell two keys apart, not enough to use one. */
export function maskKey(key) {
  if (!key) return "(none)";
  const s = String(key);
  return s.length <= 8 ? "****" : `…${s.slice(-4)}`;
}

/**
 * A pool of keys per provider, with cooldowns.
 *
 * The failure this exists for: one key hits a rate limit and the whole class goes
 * dark even though three other keys on the same provider are idle. A cooled key
 * is skipped until its deadline; if every key is cooling, the provider is
 * unusable and the chain moves on, which is the correct behaviour rather than a
 * tight retry loop against a wall.
 */
export class KeyPool {
  #keys = new Map();
  #cooldown = new Map();
  #envKeys = new Map();
  #providers = [];
  #file = null;
  #fileStamp = null;
  #checkedAt = 0;

  constructor(env = process.env, providerSpecs = {}, { keyFile = null } = {}) {
    this.#file = keyFile;
    this.#providers = Object.keys(providerSpecs);
    for (const [provider, spec] of Object.entries(providerSpecs)) {
      const list = [];
      const base = spec?.apiKeyEnv;
      if (base) {
        if (env[base]) list.push(...splitKeys(env[base]));
        if (env[`${base}S`]) list.push(...splitKeys(env[`${base}S`]));
        for (let i = 2; i <= 9; i += 1) {
          const v = env[`${base}_${i}`];
          if (v) list.push(...splitKeys(v));
        }
      }
      if (list.length) this.#envKeys.set(provider, list);
    }
    this.#fileStamp = this.#stamp();
    this.#load();
  }

  #stamp() {
    if (!this.#file) return "none";
    try {
      const info = statSync(this.#file);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return "missing";
    }
  }

  /**
   * Env keys plus the key file. The file is the second source, not a replacement: an env
   * var is how an operator overrides a key in a hurry, and a desktop user who never opens
   * a terminal needs the file. Duplicates collapse, so having both is harmless.
   */
  #load() {
    const fromFile = readKeyFile(this.#file);
    this.#keys.clear();
    for (const provider of this.#providers) {
      const list = [...(this.#envKeys.get(provider) ?? []), ...(fromFile[provider] ?? [])];
      if (list.length) this.#keys.set(provider, [...new Set(list)]);
    }
  }

  /**
   * Re-read the key file when it changed, at most once a second. The app's Settings page
   * writes it, and a key typed there has to work on the next message, not after a restart.
   */
  #refresh() {
    if (!this.#file || Date.now() - this.#checkedAt < 1000) return;
    this.#checkedAt = Date.now();
    // A deleted file is a state too: its keys are gone.
    const stamp = this.#stamp();
    if (stamp !== this.#fileStamp) {
      this.#fileStamp = stamp;
      this.#load();
    }
  }

  /**
   * True when the provider is usable with the keys on hand.
   *
   * Three cases, and the middle one is the fix for a shipped build that failed on a fresh
   * machine: a provider with no key at all (local) is always usable; a provider whose key is
   * `apiKeyOptional` is usable whether or not a key is stored, because the free tier answers
   * 200 to a request that carries no credential (OpenCode's does, measured 2026-10-20 with
   * data/probe-key-class.mjs), so an absent key must never be the reason an app that promises
   * free cloud models has nowhere to send a request; and a provider that requires a key still
   * needs one, so its targets stay skipped rather than failing upstream with a 401.
   */
  usable(provider, spec) {
    if (!spec?.apiKeyEnv || spec?.apiKeyOptional) return true;
    return this.all(provider).length > 0;
  }

  all(provider) {
    this.#refresh();
    return this.#keys.get(provider) ?? [];
  }

  coolingFor(key) {
    const until = this.#cooldown.get(key) ?? 0;
    const left = until - Date.now();
    return left > 0 ? left : 0;
  }

  available(provider) {
    return this.all(provider).filter((k) => this.coolingFor(k) === 0);
  }

  cooldown(key, ms) {
    if (!key) return;
    const ms2 = Math.max(1000, Number(ms) || 0);
    // Never shorten an existing cooldown: a 30s Retry-After on top of a 5m ban
    // must not pull the key back early.
    const until = Date.now() + ms2;
    if (until > (this.#cooldown.get(key) ?? 0)) this.#cooldown.set(key, until);
  }

  /**
   * Pick a key: the given one if still usable, otherwise the next available.
   * Returns null when every key is cooling, which is the signal to fail over.
   */
  rotate(provider, fromKey) {
    const av = this.available(provider);
    if (!av.length) return null; // every key cooling: provider unusable, fail over
    if (!fromKey) return av[0];
    const i = av.indexOf(fromKey);
    return i === -1 ? av[0] : av[(i + 1) % av.length];
  }

  stats() {
    this.#refresh();
    const out = {};
    for (const [provider, keys] of this.#keys) {
      out[provider] = keys.map((k) => ({
        key: maskKey(k),
        coolingMs: this.coolingFor(k),
      }));
    }
    return out;
  }
}

export const POOL_KEY_ENV_HELP = [
  "Keys are read from the environment per provider:",
  "  ANTHROPIC_API_KEY            one key",
  "  ANTHROPIC_API_KEYS           comma- or space-separated list",
  "  ANTHROPIC_API_KEY_2 …  _9    additional keys",
  "The same three shapes work for OPENAI_, GOOGLE_ and OPENROUTER_.",
].join("\n");

/**
 * A PROVIDER-level circuit breaker, which is the other half of the key pool.
 *
 * The gap it closes was measured, not imagined. In the T0.1 acceptance run the
 * rate-limited provider still took **all 500 calls**: a key cooldown protects the
 * KEY, and nothing protected the PROVIDER, so every request in the run paid a
 * doomed round trip before failing over. The pool stops one key from being
 * hammered; this stops one dead provider from costing every single caller.
 *
 * It counts only failures the router could not escape by trying another key,
 * because that is the honest definition of "this provider is down" as seen by the
 * caller. A rate limit that a second key absorbs is not a provider failure and
 * never trips it.
 *
 * Recovery is half-open: when the cooldown elapses exactly one call is let
 * through as a probe. Success closes the breaker; failure re-opens it for longer.
 * That asymmetry is the point - a provider that is genuinely down should be
 * retried less often each time, not the same amount forever.
 */
export class ProviderBreaker {
  #enabled;
  #threshold;
  #baseMs;
  #maxMs;
  #now;
  #state = new Map();

  constructor(options = {}, { now = Date.now } = {}) {
    this.#enabled = options.enabled !== false;
    this.#threshold = Math.max(1, Number(options.threshold ?? 3));
    this.#baseMs = Math.max(0, Number(options.defaultCooldownMs ?? 30_000));
    this.#maxMs = Math.max(this.#baseMs, Number(options.maxCooldownMs ?? 900_000));
    this.#now = now;
  }

  #row(provider) {
    let row = this.#state.get(provider);
    if (!row) {
      row = { fails: 0, openUntil: 0, cooldownMs: this.#baseMs, probing: false, trips: 0, lastReason: null };
      this.#state.set(provider, row);
    }
    return row;
  }

  /**
   * May this provider be called right now?
   *   { open: true }            skip it; `retryInMs` is how long is left
   *   { open: false, probe: true } the single test call after a cooldown
   *   { open: false }           normal, healthy path
   */
  check(provider) {
    if (!this.#enabled) return { open: false, probe: false };
    const row = this.#row(provider);
    const left = row.openUntil - this.#now();
    if (left > 0) return { open: true, retryInMs: left };
    if (row.fails >= this.#threshold) {
      // Half-open. Exactly one caller gets the probe; the rest keep skipping, so a
      // burst of 25 concurrent requests cannot all become the probe at once.
      if (row.probing) return { open: true, retryInMs: 0, probeInFlight: true };
      row.probing = true;
      return { open: false, probe: true };
    }
    return { open: false, probe: false };
  }

  /** Record the outcome of a call that was actually attempted. */
  record(provider, outcome = {}) {
    if (!this.#enabled) return null;
    const row = this.#row(provider);
    const wasProbing = row.probing;
    row.probing = false;

    if (outcome.ok) {
      const wasOpen = row.fails >= this.#threshold;
      row.fails = 0;
      row.openUntil = 0;
      row.cooldownMs = this.#baseMs;
      row.lastReason = null;
      return wasOpen ? { closed: true } : { fails: 0 };
    }

    row.fails += 1;
    row.lastReason = outcome.reason ?? "unknown";

    // A failure observed while the breaker is ALREADY open is the same single
    // outage seen by another concurrent request, not a new one, and it must not
    // escalate anything. Measured the hard way: without this, the 25 requests
    // already in flight during the acceptance run each re-tripped the breaker and
    // doubled the backoff, turning a first trip of 30s into the 15-minute cap.
    const now = this.#now();
    if (row.openUntil > now && !wasProbing) {
      return { alreadyOpen: true, ms: row.openUntil - now };
    }

    if (row.fails < this.#threshold && !wasProbing) return { fails: row.fails };

    // Trip. The failure's own cooldown is honoured first, because a 402 deserves
    // fifteen minutes where a timeout deserves five seconds. Escalation is per
    // EPISODE - only a failed probe doubles it - and is bounded.
    const hint = Math.max(this.#baseMs, Number(outcome.cooldownMs) || 0);
    const from = wasProbing ? row.cooldownMs : this.#baseMs;
    const ms = Math.min(this.#maxMs, Math.max(hint, from));
    row.cooldownMs = Math.min(this.#maxMs, ms * 2);
    row.openUntil = now + ms;
    row.trips += 1;
    return { opened: true, ms, reason: row.lastReason, fails: row.fails, wasProbing };
  }

  /** Force a provider back to healthy (used by tests and by /admin/reset). */
  reset(provider) {
    if (provider) this.#state.delete(provider);
    else this.#state.clear();
  }

  stats(providers = []) {
    const names = new Set([...providers, ...this.#state.keys()]);
    const out = { enabled: this.#enabled, threshold: this.#threshold, providers: {} };
    for (const name of names) {
      const row = this.#state.get(name);
      if (!row) {
        out.providers[name] = { state: "closed", fails: 0, trips: 0 };
        continue;
      }
      const left = row.openUntil - this.#now();
      out.providers[name] = {
        state: left > 0 ? "open" : row.probing ? "half-open" : row.fails >= this.#threshold ? "half-open" : "closed",
        fails: row.fails,
        trips: row.trips,
        lastReason: row.lastReason,
        openForMs: left > 0 ? left : 0,
        nextCooldownMs: row.cooldownMs,
      };
    }
    return out;
  }
}
