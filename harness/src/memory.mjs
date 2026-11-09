/**
 * Memory: a rolling summary for the run in front of you, and a store of what
 * outlives it.
 *
 * MASTER-PLAN 5.2 asks for two things that are easy to conflate:
 *
 *   session memory   rolling summary + last-N verbatim      -> compactMessages()
 *   global memory    facts, decisions, constraints, project
 *                    state - "the self-updating layer"      -> remember()/recall()
 *
 * Both live here, but only the first is automatic. The loop knows when a
 * conversation has grown too long; it does not know what a decision is. So the
 * store is written by the model through the `remember` tool and by the user
 * through the CLI, and read back into the system prompt of every later run.
 *
 * Three rules this module keeps:
 *
 *  1. Compaction never orphans a tool result. A `tool` message belongs to the
 *     assistant message that requested it: a request that keeps one without the
 *     other is malformed and a provider will reject it. The cut therefore lands on
 *     a `user` boundary, or nothing happens at all.
 *  2. Compaction never loses the run. If the summarizer is unreachable, empty or
 *     returns nonsense, a mechanical digest of the dropped span is used instead and
 *     the event says which one it was. Losing context is bad; losing the run is worse.
 *  3. The store is append-only JSONL. It is readable, diffable and survives being
 *     killed mid-write; a line that does not parse is skipped and counted rather
 *     than thrown, because one bad byte must never cost the whole memory.
 *
 * The transport is deliberately absent: `compactMessages` takes a `summarize`
 * callback, so agent.mjs stays the only place that talks to the router.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { contentText } from "./images.mjs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { estimateTokens, weightFor } from "./context.mjs";

// The estimator now lives in context.mjs, next to the rest of the token accounting.
// Re-exported so every existing import of `estimateTokens` / `estimateMessageTokens`
// / `toolNamesById` from this module keeps naming the same function.
export { estimateMessageTokens, estimateTokens, toolNamesById } from "./context.mjs";

export const KINDS = ["fact", "decision", "constraint", "project"];

/**
 * The suite's data directory. `ROSALENA_HOME` wins over `~/.rosalena` so the
 * launcher can keep the suite's own state inside the product folder - which is
 * also the only place a Low-integrity (sandboxed) process may write.
 */
export function rosalenaHome() {
  return process.env.ROSALENA_HOME || join(homedir(), ".rosalena");
}

/** The global store, unless the caller points somewhere else. */
export const DEFAULT_MEMORY_FILE = join(rosalenaHome(), "memory.jsonl");

const MAX_TEXT = 2000;

/**
 * Which slice to summarize, and which to keep verbatim.
 *
 * Index 0 is the system prompt and is never dropped, and the last `keepLast`
 * messages are kept verbatim. The only adjustment is that the cut may not split an
 * assistant call from its results: a retained `tool` message whose assistant parent
 * was summarized is a malformed request, and providers reject the whole call rather
 * than the offending message.
 *
 * Requiring a `user` boundary instead looks safer but is worse: a single long turn
 * - one task and thirty tool calls - has no user boundary after index 1, so the
 * plan came back null and the run that most needs compaction could never have it.
 * A tail starting at an `assistant` message is valid because the summary precedes
 * it as a `user` message.
 */
export function planCompaction(messages, { keepLast = 8 } = {}) {
  if (!Array.isArray(messages) || messages.length <= keepLast + 1) return null;
  let cut = messages.length - Math.max(1, keepLast);
  if (cut < 2) return null;
  while (cut > 2 && messages[cut]?.role === "tool") cut -= 1;
  if (messages[cut]?.role === "tool") return null;
  return { cut, dropped: cut - 1, kept: messages.length - cut };
}

const oneLine = (text, max) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Marker set by compactMessages, so a summary can be recognized later. */
export const SUMMARY_MARK = "[summary of ";
export const isSummaryMessage = (m) => m?.role === "user" && contentText(m.content).startsWith(SUMMARY_MARK);

/** No model, no network: what was said, clipped, in order. */
export function mechanicalSummary(span, { perMessage = 200 } = {}) {
  const names = new Map();
  for (const m of span ?? []) {
    for (const call of m.tool_calls ?? []) names.set(call.id, call.function?.name ?? "?");
  }
  const lines = [];
  for (const m of span ?? []) {
    const text = oneLine(contentText(m.content), perMessage);
    if (m.role === "user") lines.push(`- user: ${text || "(empty)"}`);
    else if (m.role === "assistant") {
      const called = (m.tool_calls ?? []).map((c) => names.get(c.id) ?? c.function?.name ?? "?").join(", ");
      lines.push(`- assistant: ${text || "(no text)"}${called ? ` [called ${called}]` : ""}`);
    } else if (m.role === "tool") {
      lines.push(`- ${names.get(m.tool_call_id) ?? "tool"} result: ${text || "(empty)"}`);
    } else if (text) lines.push(`- ${m.role}: ${text}`);
  }
  return lines.length ? lines.join("\n") : "(nothing to summarize)";
}

export const SUMMARY_SYSTEM =
  "You compress the earlier part of a conversation so another agent can continue it without the original messages. " +
  "Keep what changes future decisions: the goal and the user's original request, decisions already made and why, " +
  "file paths and identifiers, environment facts, constraints the user stated, the exact commands that were run and " +
  "what they printed, and what was tried and failed so it is not tried again. " +
  "End with an `Open questions:` line listing anything still unresolved, or `Open questions: none`. " +
  "Drop pleasantries and repetition. Write plain prose or short bullets, in English. Output only the summary.";

/**
 * The text handed to the summarizer. The first message is always kept - it is the
 * original task, which is the one thing a summary must not lose - and the rest is
 * taken newest-first, because the recent turns are what the tail continues from.
 */
export function summaryRequest(span, { perMessage = 600, maxChars = 12_000 } = {}) {
  const lines = (span ?? []).map((m) => {
    const called = (m.tool_calls ?? []).map((c) => c.function?.name ?? "?").join(", ");
    const body = oneLine(contentText(m.content), perMessage);
    return `${m.role}${called ? ` (called ${called})` : ""}: ${body || "(empty)"}`;
  });
  if (!lines.length) return "(nothing to summarize)";
  const first = lines[0];
  const rest = lines.slice(1);
  let budget = maxChars - first.length;
  const kept = [];
  for (let i = rest.length - 1; i >= 0 && budget > 0; i -= 1) {
    if (rest[i].length > budget && kept.length) break;
    kept.unshift(rest[i].slice(0, Math.max(0, budget)));
    budget -= rest[i].length;
  }
  const omitted = rest.length - kept.length;
  return [first, omitted > 0 ? `(${omitted} message(s) omitted)` : null, ...kept].filter(Boolean).join("\n");
}

/**
 * Replace the droppable span with one summary message.
 *
 * Returns the SAME array object it was given when there was nothing to do, so a
 * caller can compare identity instead of guessing.
 */
export async function compactMessages({ messages, summarize = null, keepLast = 8, perMessage = 600 } = {}) {
  const plan = planCompaction(messages, { keepLast });
  if (!plan) return { compacted: false, messages, reason: "nothing safely droppable" };

  const dropped = messages.slice(1, plan.cut);
  // The one case where summarizing cannot help: everything droppable is already a
  // summary, so the retained tail alone is over the threshold. Without this guard
  // the loop would spend a model call per step rewriting the same summary.
  if (plan.cut === 2 && dropped.length === 1 && isSummaryMessage(dropped[0])) {
    return { compacted: false, messages, reason: "the retained tail alone is over the threshold" };
  }

  const before = estimateTokens(messages, { weightFor });
  let summary = "";
  let how = "mechanical";
  let note = null;

  if (summarize) {
    try {
      const text = String((await summarize(summaryRequest(dropped, { perMessage }))) ?? "").trim();
      if (text) {
        summary = text;
        how = "model";
      } else {
        note = "summarizer returned nothing";
      }
    } catch (err) {
      note = `summarizer failed: ${String(err?.message ?? err).slice(0, 160)}`;
    }
  }
  if (!summary) summary = mechanicalSummary(dropped);

  // The original request is the one thing a summary must never be allowed to lose,
  // and a model summary is a judgement call: it can decide the task text was
  // restated in the `user:` lines and drop it. So the first user message of the
  // dropped span is carried VERBATIM, clipped only when it is too long to be worth
  // the room. The summariser is shown it as well (summaryRequest puts it first);
  // this is the copy that does not depend on the summariser doing its job.
  const firstUser = dropped.find((m) => m.role === "user" && contentText(m.content).trim());
  const originalRequest = firstUser ? oneLine(contentText(firstUser.content), 1200) : "";

  // A user message, not a system one: every provider accepts a user message
  // anywhere, while a second system message mid-list is rejected or dropped
  // depending on who is translating (Anthropic keeps `system` as a top-level field).
  const head = `${SUMMARY_MARK}${dropped.length} earlier message(s) in this session${how === "mechanical" ? ", written mechanically from them" : ""}${
    note ? `; ${note}` : ""
  }]\n${originalRequest ? `Original request (kept verbatim): ${originalRequest}\n\n` : ""}${summary}`;

  const next = [messages[0], { role: "user", content: head }, ...messages.slice(plan.cut)];
  return {
    compacted: true,
    messages: next,
    dropped: dropped.length,
    kept: plan.kept,
    summary,
    originalRequest,
    how,
    note,
    tokensBefore: before,
    tokensAfter: estimateTokens(next, { weightFor }),
  };
}

// ---------------------------------------------------------------------------
// The global store
// ---------------------------------------------------------------------------

export function memoryFile(file) {
  return file ?? DEFAULT_MEMORY_FILE;
}

/**
 * Read the store. A line that does not parse is counted, not thrown: a truncated
 * append (a kill mid-write) must not cost every memory before it.
 */
export function loadMemory({ file } = {}) {
  const path = memoryFile(file);
  if (!existsSync(path)) return { file: path, records: [], skipped: 0, exists: false };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { file: path, records: [], skipped: 0, exists: true, error: String(err?.message ?? err) };
  }
  const records = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.text === "string" && parsed.text.trim()) records.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { file: path, records, skipped, exists: true };
}

const normalize = (text) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Append one record. Duplicates are refused rather than written twice - the model
 * re-learning the same fact every session is the normal case, not an error.
 */
export function remember(entry = {}, { file } = {}) {
  const path = memoryFile(file);
  const text = String(entry.text ?? "").trim();
  if (!text) return { added: false, reason: "empty text" };
  const kind = KINDS.includes(entry.kind) ? entry.kind : "fact";
  const capped = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;

  const existing = loadMemory({ file: path });
  const same = existing.records.find((r) => (r.kind ?? "fact") === kind && normalize(r.text) === normalize(capped));
  if (same) return { added: false, reason: "already known", record: same };

  const record = {
    id: `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    at: new Date().toISOString(),
    kind,
    text: capped,
    ...(entry.project ? { project: String(entry.project) } : {}),
    ...(entry.source ? { source: String(entry.source) } : {}),
    ...(entry.tags?.length ? { tags: entry.tags.map(String) } : {}),
    ...(capped.length !== text.length ? { truncated: true } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return { added: true, record };
}

/** Remove one record by id; returns how many lines went. */
export function forget(id, { file } = {}) {
  const path = memoryFile(file);
  const { records } = loadMemory({ file: path });
  const kept = records.filter((r) => r.id !== id);
  const removed = records.length - kept.length;
  if (removed) writeFileSync(path, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""), "utf8");
  return { removed };
}

/** Newest first. `query` is a case-insensitive substring over text and tags. */
export function recall({ query = null, kind = null, project = null, limit = 10 } = {}, { file } = {}) {
  const { records, skipped, file: path } = loadMemory({ file });
  const needle = query ? normalize(query) : null;
  const hits = records
    .filter((r) => (kind ? (r.kind ?? "fact") === kind : true))
    .filter((r) => (project ? r.project === project : true))
    .filter((r) => (needle ? normalize(`${r.text} ${(r.tags ?? []).join(" ")}`).includes(needle) : true))
    .reverse();
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  return { file: path, skipped, total: records.length, matched: hits.length, records: hits.slice(0, n) };
}

/** One line per record, for a tool result or a CLI listing. */
export function formatRecords(records) {
  if (!records?.length) return "(nothing)";
  return records.map((r) => `${r.id} · ${r.kind ?? "fact"}${r.project ? ` · ${r.project}` : ""} · ${new Date(r.at).toISOString().slice(0, 10)}\n  ${oneLine(r.text, 400)}`).join("\n");
}

/**
 * The block that goes into the system prompt: what this project learned, and what
 * every project learned, newest first, inside a character budget.
 */
export function memoryPrompt(records, { project = null, maxChars = 1200, perEntry = 240, limit = 0 } = {}) {
  const all = (records ?? []).filter((r) => r?.text);
  if (!all.length) return "";
  // A fact learned in this workspace beats a newer one learned elsewhere: it is
  // the one that was learned about the code in front of you.
  const here = project ? all.filter((r) => r.project === project) : [];
  const elsewhere = all.filter((r) => !here.includes(r));
  const ordered = [...here.reverse(), ...elsewhere.reverse()];
  const cap = Number(limit) > 0 ? Number(limit) : ordered.length;
  const lines = [];
  let used = 0;
  for (const r of ordered) {
    if (lines.length >= cap) break;
    const line = `- [${r.kind ?? "fact"}] ${oneLine(r.text, perEntry)}`;
    if (used + line.length > maxChars && lines.length) break;
    lines.push(line);
    used += line.length + 1;
  }
  const rest = ordered.length - lines.length;
  const head = `What you already know from earlier sessions${rest > 0 ? ` (${rest} older not shown)` : ""}:`;
  return [head, ...lines].join("\n");
}

/** The two tools that make the store self-updating instead of read-only. */
export function memoryTools({ file, project = null } = {}) {
  return [
    {
      name: "remember",
      description:
        "Write one durable note to the harness's memory store, which every later session in every workspace reads. Use it for a choice that forecloses another option and the reason for it, a constraint the user stated, an environment fact you had to discover (a port, a path, a version, a login flow), or the reason an approach failed. Do not use it for anything already in the conversation, for a restatement of the task, or for trivia you can re-read from a file.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: KINDS, description: "fact, decision, constraint or project." },
          text: { type: "string", description: "One self-contained sentence or two. Name paths and identifiers explicitly." },
        },
        required: ["text"],
      },
      async run({ kind, text }) {
        const r = remember({ kind, text, project, source: "model" }, { file });
        if (!r.added) return `not written (${r.reason}): ${r.record?.id ?? ""}`.trim();
        return `remembered as ${r.record.kind} (${r.record.id})${r.record.truncated ? ", truncated" : ""}`;
      },
    },
    {
      name: "recall",
      description:
        "Search the harness's memory store for facts, decisions and constraints recorded in earlier sessions, optionally filtered by kind or substring. Use it before asking the user something they may already have answered, and before re-deriving something that was decided before.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive substring. Omit for the most recent notes." },
          kind: { type: "string", enum: KINDS },
          limit: { type: "integer", description: "Defaults to 10." },
        },
      },
      async run({ query, kind, limit }) {
        const r = recall({ query, kind, limit }, { file });
        if (!r.records.length) return `no memories match${query ? ` "${query}"` : ""} (${r.total} stored)`;
        return `${r.matched} of ${r.total} stored:\n${formatRecords(r.records)}`;
      },
    },
  ];
}
