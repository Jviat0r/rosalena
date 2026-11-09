/**
 * Per-tool context sizing, and the tool-output cache.
 *
 * Two things every tool loop gets wrong, both of which only show up as a run that
 * dies with "context size exceeded" or one that compacts uselessly early:
 *
 *  1. ONE BUDGET FOR EVERY TOOL. A directory listing and a source file are not the
 *     same kind of output, and a build log is not either. Each tool gets a budget
 *     that matches what it emits, and a clip direction that keeps the part worth
 *     keeping: the head of a file, the tail of a log.
 *
 *  2. A GUESSED TOKEN COUNT. `chars / 4` is the folklore number, and it is wrong in
 *     the dangerous direction: it UNDER-counts, so compaction fires later than the
 *     threshold says and the run hits the real wall instead. The weights below are
 *     not guessed - they were measured against the tokenizer that actually reads
 *     this context (llama.cpp `POST /tokenize`, the local qwen3.8-27b) on real
 *     output from this harness. Every weight is the measured value FLOORED to one
 *     decimal, so the estimate can only err toward "more tokens", never fewer.
 *     `test/context.test.mjs` asserts that rule against the table, so a weight
 *     cannot be hand-tuned upward without a new measurement.
 *
 * The cache exists for one case: a model that reads the same file twice in a run.
 * The second read is byte-identical, the first copy is already in the conversation,
 * and re-sending it is pure waste. It covers `read_file` alone, because that is the
 * only tool here with a cheap AND sound validity token - the file's own identity.
 * A cache is only as good as its staleness check, so anything without an exact one
 * (a search over a tree, a shell command, a subagent) is simply not cached.
 */

import { statSync } from "node:fs";
import { contentText, countImages, IMAGE_TOKENS } from "./images.mjs";
import { resolve } from "node:path";

/**
 * The calibration, kept as data so the tests can hold the weights to it.
 * Measured 2026-10-19 on this box: `POST http://127.0.0.1:8080/tokenize` with the
 * same text each tool would emit, reading the real token count back.
 */
export const CALIBRATION = {
  at: "2026-10-19",
  tokenizer: "qwen3.8-27b (llama.cpp /tokenize)",
  samples: [
    { shape: "source code", what: "src/tools.mjs head", chars: 8000, tokens: 2212, charsPerToken: 3.617 },
    { shape: "prose", what: "HARNESS.md slice", chars: 8000, tokens: 2115, charsPerToken: 3.783 },
    { shape: "directory listing", what: "one level of src/", chars: 110, tokens: 43, charsPerToken: 2.558 },
    { shape: "command output", what: "router JSONL log tail", chars: 4000, tokens: 1962, charsPerToken: 2.039 },
    { shape: "search hits", what: "60 path:line hits", chars: 4897, tokens: 1605, charsPerToken: 3.051 },
  ],
  /** The number every previous version of this used, for the comparison. */
  folklore: 4,
};

/**
 * Per-tool profiles.
 *
 * `budget` is the character budget for ONE result. `clip` says which end survives.
 * `charsPerToken` is the measured weight (floored). `cache` names the validity
 * check, or null for "never cached".
 */
export const TOOL_PROFILES = {
  // The file's content is the thing the model asked for, so this gets the largest
  // budget; source measured at 3.6 chars/token.
  read_file: { budget: 8000, clip: "head", charsPerToken: 3.6, cache: "file" },
  // The same content with a short anchor per line (code-intel); it pages itself.
  read_hashed: { budget: 8000, clip: "head", charsPerToken: 3.4, cache: null },
  // Navigation, not content. Measured the densest of the file-ish outputs (2.5).
  list_dir: { budget: 2500, clip: "head", charsPerToken: 2.5, cache: null },
  // 60 capped hits of `path:line: text`, measured 3.0.
  search: { budget: 5000, clip: "head", charsPerToken: 3.0, cache: null },
  // The error is at the end, and log output is the densest thing here at 2.0
  // chars/token - under the old flat guess a 6000-char log was priced at 1500
  // tokens when it was really ~3000.
  run_command: { budget: 4000, clip: "tail", charsPerToken: 2.0, cache: null },
  write_file: { budget: 600, clip: "head", charsPerToken: 3.6, cache: null },
  edit_file: { budget: 600, clip: "head", charsPerToken: 3.6, cache: null },
  // A worker's summary is prose, measured 3.8.
  delegate: { budget: 4000, clip: "head", charsPerToken: 3.7, cache: null },
};

/**
 * Anything not listed: a plugin tool, or one added later. The weight sits between
 * the measured extremes and below the folklore 4, which is the whole point - an
 * unknown tool should be priced pessimistically, not optimistically.
 */
export const DEFAULT_PROFILE = { budget: 6000, clip: "head", charsPerToken: 3.2, cache: null };

/** The profile for a tool, with an explicit global override applied if given. */
export function profileFor(name, overrideChars) {
  const profile = TOOL_PROFILES[name] ?? DEFAULT_PROFILE;
  if (!Number.isFinite(overrideChars) || overrideChars <= 0) return profile;
  // An explicit --max-output-chars flattens every budget on purpose: it is the
  // user saying "I know better than the table". The weight is not touched.
  return { ...profile, budget: Math.floor(overrideChars) };
}

export function budgetFor(name, overrideChars) {
  return profileFor(name, overrideChars).budget;
}

export function weightFor(name) {
  return (TOOL_PROFILES[name] ?? DEFAULT_PROFILE).charsPerToken;
}

/** Clip a tool's output to its own budget, keeping the end that tool's output wants. */
export function clipForTool(name, text, overrideChars) {
  const { budget, clip } = profileFor(name, overrideChars);
  const s = String(text ?? "");
  if (s.length <= budget) return s;
  const dropped = s.length - budget;
  return clip === "tail"
    ? `… [truncated ${dropped} of ${s.length} chars; showing the end]\n${s.slice(-budget)}`
    : `${s.slice(0, budget)}\n… [truncated ${dropped} of ${s.length} chars; showing the start]`;
}

// ---------------------------------------------------------------------------
// The token estimate
//
// This lived in memory.mjs until the context meter needed the same numbers: the
// summariser's threshold and the gauge in the page must not be two different
// estimates of one conversation. There is one estimator, it is here, and memory.mjs
// re-exports it so every existing import still names the same function.
// ---------------------------------------------------------------------------

/**
 * Rough on purpose: its only job is to fire a threshold with room to spare.
 *
 * `weightFor` prices a message by the tool that produced it. A flat chars/4 was
 * measured to under-count every tool in this harness (a command log is really ~2
 * chars/token, not 4), and under-counting is the dangerous direction: the estimate
 * says "room left" when the real window is already gone. Without a weight the old
 * behaviour is kept exactly.
 */
export function estimateMessageTokens(m, { weightFor = null, toolName = null, charsPerToken = 4 } = {}) {
  if (!m) return 0;
  // Array content (text + images) is counted as its text, plus a fixed cost per image:
  // String() of an array would count "[object Object]" and miss the picture entirely.
  let chars = contentText(m.content).length;
  const images = countImages(m.content);
  for (const call of m.tool_calls ?? []) {
    chars += String(call.function?.name ?? "").length + String(call.function?.arguments ?? "").length;
  }
  const weight = (toolName && weightFor ? weightFor(toolName) : null) ?? charsPerToken;
  return Math.ceil(chars / weight) + images * IMAGE_TOKENS + 4;
}

/**
 * A `tool` result carries no tool name on the wire (only `tool_call_id`), so the
 * name is recovered from the assistant call that asked for it. Without this the
 * per-tool weights could never apply to the messages that need them most.
 */
export function toolNamesById(messages) {
  const byId = new Map();
  for (const m of messages ?? []) {
    for (const call of m?.tool_calls ?? []) {
      if (call?.id) byId.set(call.id, call.function?.name ?? null);
    }
  }
  return byId;
}

export function estimateTokens(messages, { weightFor = null, charsPerToken = 4 } = {}) {
  const byId = weightFor ? toolNamesById(messages) : null;
  return (messages ?? []).reduce(
    (n, m) => n + estimateMessageTokens(m, { weightFor, toolName: byId?.get(m?.tool_call_id) ?? null, charsPerToken }),
    0,
  );
}

// ---------------------------------------------------------------------------
// What the prompt costs: the meter, and the compaction threshold
// ---------------------------------------------------------------------------

/**
 * The window a run falls back to when nobody names one.
 *
 * The router does NOT advertise a per-model context window (`/v1/models` answers
 * classes and provider wildcards only, and `router.config.json` carries no window
 * field), so this is a config value, not a discovered one: the CLI's
 * `--context-window`, `ROSALENA_CONTEXT_WINDOW`, or `runAgent({ contextWindow })`.
 * 32768 is the local qwen3.8-27b's served length on this box.
 */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

/**
 * The fraction of the window at which a run compacts. 0.55, not the usual 0.8:
 * the slack absorbs the estimate being wrong, and the summary request itself has
 * to fit in what is left.
 */
export const COMPACT_AT = 0.55;

/**
 * The tool-schema part of the prompt, priced from the JSON the model is actually
 * sent. There is no per-message tool name to apply a measured weight to, so this
 * uses the table's own pessimistic default (3.2 chars/token) rather than a new
 * number invented for schemas.
 */
export function estimateToolsTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  let text;
  try {
    text = JSON.stringify(tools);
  } catch {
    return 0;
  }
  return Math.ceil(text.length / DEFAULT_PROFILE.charsPerToken) + 4;
}

/**
 * The projected prompt size at which compaction fires, in tokens.
 *
 * Clamped rather than trusted: at 0 nothing would ever compact, and at 1 the
 * summary request itself would have to fit in a window that is already full. The
 * 2000-token floor keeps a tiny test window from compacting on the system prompt
 * alone, where there is nothing droppable to win back.
 */
export function contextThreshold(window, fraction = COMPACT_AT) {
  const win = Math.max(2000, Number(window) || DEFAULT_CONTEXT_WINDOW);
  const f = Math.min(0.9, Math.max(0.1, Number(fraction) || COMPACT_AT));
  return Math.max(2000, Math.round(win * f));
}

/**
 * The window a llama.cpp server actually has, read from its own refusal.
 *
 * llama.cpp answers a prompt it cannot hold with
 * `request (36630 tokens) exceeds the available context size (32768 tokens), try
 * increasing it` in an `exceed_context_size_error` body. That message is the only
 * place the real `-c` value ever reaches Rosalena: `/props` is not consulted on this
 * path, and the configured window is what the process was launched with, which is a
 * different fact when another app's launcher started the server (2026-11-06: DSH had
 * 131072 in its profile, the server on :8080 had 32768, and the run died instead of
 * compacting). null when the message is not that refusal.
 *
 * @returns {{ promptTokens: number|null, window: number|null, asked: number|null }|null}
 */
export function reportedContextWindow(failure) {
  const text = String(failure?.message ?? failure ?? "");
  if (!/exceed_context_size_error|exceeds the available context size|context[_ ]length[_ ]exceeded|maximum context length/i.test(text)) return null;
  const what = text.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/);
  if (!what) return { promptTokens: null, window: null, asked: null };
  const promptTokens = Number(what[1]) || null;
  const window = Number(what[2]) || null;
  // How much has to go, in tokens, for the retry to fit. Negative is impossible, so a
  // server that reports a prompt smaller than its window yields 0.
  const asked = promptTokens && window ? Math.max(0, promptTokens - window) : null;
  return { promptTokens, window, asked };
}

/** Is this failure the "prompt does not fit the context window" class? */
export function isContextOverflow(failure) {
  return reportedContextWindow(failure) !== null;
}

/**
 * The window a run should use: what the person asked for, but never more than the server
 * actually has.
 *
 * The two numbers really do disagree (measured 2026-11-06: the preference said 65,536, the
 * llama-server on :8080 was started at `-c 32768`, and a 32,811-token request was refused
 * 43 tokens past the real ceiling). Asking the server first turns that into one fewer
 * failed call; a smaller preference is still the person's choice and is left alone, and a
 * server that did not answer (down, or still loading) leaves the preference untouched -
 * the refusal path in `agent.mjs` covers that case.
 */
export function runContextWindow(preferred, served) {
  const want = Math.max(2000, Number(preferred) || DEFAULT_CONTEXT_WINDOW);
  const have = Number(served);
  if (!Number.isFinite(have) || have < 2000) return want;
  return Math.min(want, Math.floor(have));
}

/**
 * What the next request would cost, split the way the meter shows it.
 *
 * Three facts, three sources, and no placeholder anywhere:
 *
 *   system   the system message priced by the estimator above (it is never dropped,
 *            so its price is stable for the whole run)
 *   tools    the JSON of the exact schema array the loop passes to the router
 *   messages everything else, and this is the row that gets better: once a step has
 *            completed, the provider's own `usage.prompt_tokens` covers it, so the
 *            measured number wins and only what was appended since is estimated.
 *
 * `sent` is how many messages the measured request carried. Getting it wrong is the
 * one way this can lie, so the agent sets it immediately before each call and clears
 * it after a compaction (the history the provider counted no longer exists).
 */
export function measureContext({
  messages = [],
  tools = [],
  window = DEFAULT_CONTEXT_WINDOW,
  usage = null,
  sent = 0,
  compactAt = COMPACT_AT,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const hasSystem = list[0]?.role === "system";
  const system = hasSystem ? estimateTokens(list.slice(0, 1), { weightFor }) : 0;
  const toolsTokens = estimateToolsTokens(tools);
  let messagesTokens = estimateTokens(hasSystem ? list.slice(1) : list, { weightFor });

  let source = "estimate";
  const reported = Number(usage?.prompt_tokens);
  const sentCount = Math.min(Math.max(0, Number(sent) || 0), list.length);
  if (Number.isFinite(reported) && reported > 0 && sentCount > 0) {
    // The provider counted the system prompt and the schemas too. Take its total,
    // subtract our price for the two fixed parts, and add what has been appended
    // since the call it counted - that is the only part nobody has measured yet.
    const appended = estimateTokens(list.slice(sentCount), { weightFor });
    messagesTokens = Math.max(0, reported + appended - system - toolsTokens);
    source = "provider";
  }

  const parts = { system, tools: toolsTokens, messages: messagesTokens };
  const used = parts.system + parts.tools + parts.messages;
  const max = Math.max(2000, Number(window) || DEFAULT_CONTEXT_WINDOW);
  return {
    window: max,
    used,
    percent: Math.round((used / max) * 100),
    parts,
    // Where the messages row came from. "provider" means the number is the model
    // server's own count; "estimate" means this is a projection of an unsent request.
    source,
    threshold: contextThreshold(max, compactAt),
  };
}

// ---------------------------------------------------------------------------
// The tool-output cache
// ---------------------------------------------------------------------------

/** Stable across key order, so the same call is the same key however the model wrote it. */
function stableKey(args) {
  if (!args || typeof args !== "object") return String(args ?? "");
  return Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join("&");
}

/**
 * The validity token for a file: everything about its identity that a rewrite
 * changes. Size and mtime alone are already sub-millisecond on NTFS; the inode is
 * there so a delete-and-recreate that happens to preserve both is still a miss.
 */
function fileToken(abs) {
  const s = statSync(abs);
  return `${s.size}:${Math.round(s.mtimeMs)}:${s.ino ?? 0}`;
}

/**
 * @param {object} opts
 * @param {string} opts.root      workspace root, for resolving `path` args
 * @param {number} opts.limit     max entries kept (oldest dropped first)
 */
export function createToolCache({ root, limit = 64 } = {}) {
  const ROOT = resolve(root ?? ".");
  /** key -> { text, token, generation, bytes } */
  const entries = new Map();
  const counters = { hits: 0, misses: 0, stubbedBytes: 0, invalidations: 1, stale: 0 };
  let generation = 1;

  function keyFor(name, args) {
    return `${name}::${stableKey(args)}`;
  }

  /**
   * Look up a previous result. Returns null - "send the bytes again" - unless the
   * entry is from THIS generation and the file's identity is unchanged.
   */
  function get(name, args) {
    const profile = TOOL_PROFILES[name] ?? DEFAULT_PROFILE;
    if (profile.cache !== "file") return null;
    const entry = entries.get(keyFor(name, args));
    if (!entry) {
      counters.misses += 1;
      return null;
    }
    // A compaction may have dropped the earlier copy out of the history, so an
    // entry recorded before it can no longer be pointed at. This is the one way
    // the cache could tell a lie, and it is why generations exist.
    if (entry.generation !== generation) {
      entries.delete(keyFor(name, args));
      counters.misses += 1;
      counters.stale += 1;
      return null;
    }
    let token;
    try {
      token = fileToken(resolve(ROOT, String(args?.path ?? ".")));
    } catch {
      entries.delete(keyFor(name, args));
      counters.misses += 1;
      counters.stale += 1;
      return null;
    }
    if (token !== entry.token) {
      entries.delete(keyFor(name, args));
      counters.misses += 1;
      counters.stale += 1;
      return null;
    }
    counters.hits += 1;
    counters.stubbedBytes += entry.bytes;
    return entry;
  }

  function put(name, args, text) {
    const profile = TOOL_PROFILES[name] ?? DEFAULT_PROFILE;
    if (profile.cache !== "file") return;
    let token;
    try {
      token = fileToken(resolve(ROOT, String(args?.path ?? ".")));
    } catch {
      return;
    }
    if (entries.size >= limit) entries.delete(entries.keys().next().value);
    entries.set(keyFor(name, args), { text: String(text ?? ""), token, generation, bytes: String(text ?? "").length });
  }

  /**
   * Everything is stale. Called after a write (which can change any file) and after
   * a compaction (which can drop the copy the stub would point at).
   */
  function invalidateAll() {
    entries.clear();
    generation += 1;
    counters.invalidations += 1;
  }

  /**
   * The text this call WOULD be answered with, without touching the counters or
   * deciding anything. Used by the stall detector, which has to compare what the
   * model learned rather than which bytes the context layer chose to send: a
   * cached re-read carries exactly the information of the read it stubbed, so it
   * must count as the same result - otherwise saving room would hide a loop.
   */
  function peek(name, args) {
    const profile = TOOL_PROFILES[name] ?? DEFAULT_PROFILE;
    if (profile.cache !== "file") return null;
    return entries.get(keyFor(name, args)) ?? null;
  }

  /** What the model sees instead of bytes it already has. */
  function stub(entry, args) {
    return (
      `[unchanged] read_file ${String(args?.path ?? "?")}: same size and mtime as when this run read it ` +
      `(${entry.bytes} bytes), and the identical content is already in this conversation above. ` +
      `Not re-sent to save context. Read a line range (offset/limit) if you need a different view.`
    );
  }

  return { get, peek, put, stub, invalidateAll, stats: () => ({ ...counters, entries: entries.size, generation }) };
}
