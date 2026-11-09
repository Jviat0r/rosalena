/**
 * Token usage: how many tokens each model actually generated, per provider and per
 * model, over a window that survives a restart.
 *
 * This is a SEPARATE store from the monthly USD ledger in limits.mjs, and the split
 * is deliberate. The ledger answers "may I spend more this month", so it keeps one
 * number per provider per month and rewrites itself on every call; it must stay
 * tiny and it resets. Usage answers "what did I actually run", so it needs a 30-day
 * window, per-model detail and one line of evidence per call. Squeezing the second
 * into the first would either make the budget file grow without bound or throw the
 * detail away - and the detail is the whole product.
 *
 * The file is append-only JSONL: one line per completed call, so a crash loses at
 * most the request in flight. There is no read-modify-write on the request path.
 *
 * Bounding, because "append-only" alone is not a design: the file is compacted
 * (rewritten atomically) when it passes a byte cap, dropping lines older than the
 * retention window first and then, if that was not enough, the oldest lines until
 * the rest fits. Retention alone cannot bound a hot loop - 500 requests/minute for
 * a month is hundreds of megabytes - so the byte cap is the hard bound and the
 * window is the useful one.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Keep a month of detail: the UI asks for "Today" and "Last 30 days". */
export const USAGE_RETENTION_DAYS = 30;

/**
 * Hard size cap (32 MiB, ~180k calls at ~180 bytes). Well above a month of desktop
 * use and small enough that a runaway loop cannot fill a disk. Compaction trims to
 * 75% of it, so it runs once per ~8 MiB written rather than on every append.
 */
export const USAGE_MAX_BYTES = 32 * 1024 * 1024;

/** Never rewrite 30 days of detail down to nothing: this many bytes always stay. */
const COMPACT_TARGET_RATIO = 0.75;

const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 365;

/** A finite number, or null when the provider did not say. Never "" and never NaN. */
export function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOr(value, fallback = 0) {
  const n = numOrNull(value);
  return n === null ? fallback : Math.round(n);
}

/**
 * Map one provider usage object onto the four numbers the UI shows.
 *
 * The traps this exists for:
 *
 *  - Anthropic reports `input_tokens` EXCLUDING cache reads/writes
 *    (`cache_read_input_tokens`, `cache_creation_input_tokens`), while OpenAI's
 *    `prompt_tokens` already INCLUDES cached tokens (as
 *    `prompt_tokens_details.cached_tokens`). `tokensIn` is the total prompt the
 *    model processed in both cases, so the UI can say "total = input + output"
 *    once instead of per provider, and `cacheRead` stays a subset for OpenAI.
 *  - A provider that reports no cache field gets `null`, not `0`. A fabricated
 *    zero is indistinguishable from a measured zero, and the difference is the
 *    whole reason these columns exist.
 */
export function tokenFields(usage, kind = "openai") {
  if (!usage || typeof usage !== "object") {
    return { tokensIn: 0, tokensOut: 0, cacheRead: null, cacheWrite: null };
  }
  if (kind === "anthropic") {
    const input = numOrNull(usage.input_tokens ?? usage.prompt_tokens) ?? 0;
    const cacheRead = numOrNull(usage.cache_read_input_tokens);
    const cacheWrite = numOrNull(usage.cache_creation_input_tokens);
    return {
      tokensIn: input + (cacheRead ?? 0) + (cacheWrite ?? 0),
      tokensOut: numOrNull(usage.output_tokens ?? usage.completion_tokens) ?? 0,
      cacheRead,
      cacheWrite,
    };
  }
  const details = usage.prompt_tokens_details;
  return {
    tokensIn: numOrNull(usage.prompt_tokens ?? usage.input_tokens) ?? 0,
    tokensOut: numOrNull(usage.completion_tokens ?? usage.output_tokens) ?? 0,
    cacheRead: numOrNull(details?.cached_tokens) ?? numOrNull(usage.cache_read_input_tokens),
    cacheWrite: numOrNull(usage.cache_creation_input_tokens),
  };
}

/**
 * The window the UI asks for, in UTC.
 *
 * `days: 1` is "today" and starts at 00:00:00 UTC, not 24 hours ago, so a refresh
 * at 4am does not show yesterday's evening; `days: 30` is 30 calendar days
 * including today. UTC on purpose: the process, the log files and the ledger month
 * boundary are all UTC, and a local-time window would move under a DST change.
 */
export function windowFor(days = 1, now = new Date()) {
  const n = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(Number(days) || 1)));
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { days: n, from: new Date(midnight - (n - 1) * DAY_MS), to: now };
}

/**
 * One line of the file, parsed and sanity-checked.
 *
 * A crash can leave a half-written line, and a half-written line must cost exactly
 * one call of history - not the whole store. Everything unparseable is skipped.
 */
export function parseUsageLine(line) {
  const s = String(line ?? "").trim();
  if (!s || s[0] !== "{") return null;
  let rec;
  try {
    rec = JSON.parse(s);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object") return null;
  if (typeof rec.provider !== "string" || typeof rec.model !== "string") return null;
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at)) return null;
  return rec;
}

/**
 * Human names for providers, from the config the UI already edits.
 *
 * A provider's own `label` wins; otherwise the first `models` entry for that
 * provider supplies one, so an existing config needs no new fields; otherwise the
 * provider id is the honest fallback.
 */
export function providerLabels(config) {
  const out = {};
  for (const [name, spec] of Object.entries(config?.providers ?? {})) {
    if (spec?.label) out[name] = String(spec.label);
  }
  for (const entry of config?.models ?? []) {
    const target = String(entry?.target ?? "");
    const slash = target.indexOf("/");
    if (slash <= 0) continue;
    const provider = target.slice(0, slash);
    if (!out[provider] && entry?.label) out[provider] = String(entry.label);
  }
  return out;
}

function bucket() {
  return { tokens: 0, calls: 0, input: 0, output: 0, cacheRead: null, cacheWrite: null };
}

/** Sum a nullable counter: null stays null until some call actually reports a number. */
function addNullable(acc, value) {
  const n = numOrNull(value);
  if (n === null) return acc;
  return (acc ?? 0) + n;
}

function addRecord(target, rec) {
  const input = numOrNull(rec.tokensIn) ?? 0;
  const output = numOrNull(rec.tokensOut) ?? 0;
  target.input += input;
  target.output += output;
  target.tokens += input + output;
  target.calls += rec.calls === undefined ? 1 : intOr(rec.calls, 1);
  target.cacheRead = addNullable(target.cacheRead, rec.cacheRead);
  target.cacheWrite = addNullable(target.cacheWrite, rec.cacheWrite);
}

/**
 * One pass over the window, no external storage.
 *
 * Kept separate from the file so it can be fed text directly (and so the 100k-line
 * measurement measures the rollup, not the disk). Only successful calls count: a
 * failed attempt consumed no meaningful tokens and the attempt log already covers
 * failure.
 */
export function rollupText(text, { days = 1, now = new Date(), labels = {} } = {}) {
  const win = windowFor(days, now);
  const from = win.from.getTime();
  const to = win.to.getTime();

  const providers = new Map();
  let latest = null;
  let latestAt = -Infinity;

  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    const rec = parseUsageLine(line);
    if (!rec) continue;
    if (rec.ok === false) continue;
    const at = Date.parse(rec.at);
    if (at < from || at > to) continue;

    let p = providers.get(rec.provider);
    if (!p) {
      p = { ...bucket(), models: new Map() };
      providers.set(rec.provider, p);
    }
    addRecord(p, rec);

    let m = p.models.get(rec.model);
    if (!m) {
      m = bucket();
      p.models.set(rec.model, m);
    }
    addRecord(m, rec);

    // "Current" is derived, never invented: the provider/model of the most recent
    // recorded call in the window. If nothing ran, it is null.
    if (at > latestAt) {
      latestAt = at;
      latest = { provider: rec.provider, model: rec.model };
    }
  }

  const totals = bucket();
  const providerRows = [];
  for (const [provider, p] of providers) {
    for (const key of ["tokens", "calls", "input", "output"]) totals[key] += p[key];
    totals.cacheRead = addNullable(totals.cacheRead, p.cacheRead);
    totals.cacheWrite = addNullable(totals.cacheWrite, p.cacheWrite);
    providerRows.push({
      provider,
      label: labels?.[provider] ?? provider,
      tokens: p.tokens,
      calls: p.calls,
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead,
      cacheWrite: p.cacheWrite,
      models: [...p.models.entries()]
        .map(([model, m]) => ({
          model,
          tokens: m.tokens,
          calls: m.calls,
          input: m.input,
          output: m.output,
          cacheRead: m.cacheRead,
          cacheWrite: m.cacheWrite,
        }))
        .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.model.localeCompare(b.model)),
    });
  }
  providerRows.sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.provider.localeCompare(b.provider));

  return {
    window: { days: win.days, from: win.from.toISOString(), to: win.to.toISOString() },
    updatedAt: new Date(now).toISOString(),
    totals: {
      tokens: totals.tokens,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      calls: totals.calls,
    },
    providers: providerRows,
    current: latest,
  };
}

/**
 * The append-only store. Every method swallows its own I/O errors: recording usage
 * must never be the reason a user's answer fails.
 */
export class UsageStore {
  #file;
  #retentionDays;
  #maxBytes;
  #now;
  #bytes = null;
  #compactAt;
  #compactions = 0;

  constructor(file, { retentionDays = USAGE_RETENTION_DAYS, maxBytes = USAGE_MAX_BYTES, now = () => new Date() } = {}) {
    this.#file = file ?? null;
    this.#retentionDays = Math.max(1, Math.floor(Number(retentionDays) || USAGE_RETENTION_DAYS));
    this.#maxBytes = Math.max(4096, Math.floor(Number(maxBytes) || USAGE_MAX_BYTES));
    this.#now = typeof now === "function" ? now : () => new Date(now);
    this.#compactAt = this.#maxBytes;
  }

  get file() {
    return this.#file;
  }

  /** Bytes on disk, or null when there is no file yet / it cannot be read. */
  size() {
    if (this.#bytes !== null) return this.#bytes;
    if (!this.#file) return null;
    try {
      this.#bytes = existsSync(this.#file) ? statSync(this.#file).size : 0;
    } catch {
      this.#bytes = null;
    }
    return this.#bytes;
  }

  /** For the boot line and for tests; not part of the HTTP contract. */
  info() {
    return {
      file: this.#file,
      bytes: this.size(),
      retentionDays: this.#retentionDays,
      maxBytes: this.#maxBytes,
      compactions: this.#compactions,
    };
  }

  /**
   * Append one completed call.
   *
   * Returns the written record, or null when it could not be written - the caller
   * is a live request and must not care. One `appendFileSync` per call: a single
   * small O_APPEND write, so a crash lands between lines and never inside one
   * (and even if it did, `parseUsageLine` drops the fragment).
   */
  record(entry = {}) {
    if (!this.#file) return null;
    try {
      const at = entry.at instanceof Date ? entry.at.toISOString() : entry.at;
      const rec = {
        at: at ? String(at) : this.#now().toISOString(),
        provider: String(entry.provider ?? "unknown"),
        model: String(entry.model ?? "unknown"),
        target: String(entry.target ?? `${entry.provider ?? "unknown"}/${entry.model ?? "unknown"}`),
        tokensIn: intOr(entry.tokensIn),
        tokensOut: intOr(entry.tokensOut),
        cacheRead: numOrNull(entry.cacheRead),
        cacheWrite: numOrNull(entry.cacheWrite),
        calls: entry.calls === undefined ? 1 : intOr(entry.calls, 1),
        usd: Number.isFinite(Number(entry.usd)) ? Math.round(Number(entry.usd) * 1e6) / 1e6 : 0,
        ok: entry.ok !== false,
        ms: intOr(entry.ms),
        ...(entry.stream ? { stream: true } : {}),
        // `measured: false` means the provider reported no usage for this call (an
        // un-instrumented stream). The call happened and is counted; its tokens are
        // not invented.
        ...(entry.measured === false ? { measured: false } : {}),
      };
      const line = `${JSON.stringify(rec)}\n`;
      const bytes = Buffer.byteLength(line);
      // Size BEFORE the append: `size()` stats the file, and statting after the
      // write would count this line twice.
      const before = this.size() ?? 0;
      mkdirSync(dirname(this.#file), { recursive: true });
      appendFileSync(this.#file, line);
      this.#bytes = before + bytes;
      if (this.#bytes > this.#compactAt) this.compact();
      return rec;
    } catch {
      return null;
    }
  }

  /**
   * Rewrite the file without the lines that no longer earn their bytes: drop what
   * is outside the retention window, drop corrupt fragments, and - when a hot
   * window still exceeds the cap - keep the newest call bytes that fit.
   *
   * tmp + rename, like the ledger: a crash mid-compaction must leave the old file
   * readable rather than a truncated one.
   */
  compact() {
    if (!this.#file) return { kept: 0, dropped: 0, bytes: 0, failed: true };
    try {
      const cutoff = new Date(this.#now()).getTime() - this.#retentionDays * DAY_MS;
      const text = existsSync(this.#file) ? readFileSync(this.#file, "utf8") : "";
      const kept = [];
      let bytes = 0;
      let dropped = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const rec = parseUsageLine(line);
        if (!rec || Date.parse(rec.at) < cutoff) {
          dropped += 1;
          continue;
        }
        kept.push(line);
        bytes += Buffer.byteLength(line) + 1;
      }
      const target = Math.floor(this.#maxBytes * COMPACT_TARGET_RATIO);
      let start = 0;
      while (bytes > target && start < kept.length) {
        bytes -= Buffer.byteLength(kept[start]) + 1;
        start += 1;
      }
      const body = start ? kept.slice(start).map((l) => `${l}\n`).join("") : kept.map((l) => `${l}\n`).join("");
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.#file);
      this.#bytes = Buffer.byteLength(body);
      this.#compactions += 1;
      this.#compactAt = this.#maxBytes;
      return { kept: kept.length - start, dropped: dropped + start, bytes: this.#bytes, failed: false };
    } catch {
      // Leave the file alone and wait for another whole cap of writes before
      // trying again, so a read-only directory cannot turn every append into a
      // full-file rewrite attempt.
      this.#compactAt = (this.size() ?? 0) + this.#maxBytes;
      return { kept: 0, dropped: 0, bytes: this.#bytes, failed: true };
    }
  }

  /** The report the panel renders: one pass over the file. */
  rollup({ days = 1, now = this.#now(), labels = {} } = {}) {
    let text = "";
    try {
      if (this.#file && existsSync(this.#file)) text = readFileSync(this.#file, "utf8");
    } catch {
      text = "";
    }
    return rollupText(text, { days, now, labels });
  }
}
