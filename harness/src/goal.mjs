/**
 * Durable goal mode: the run stops being the unit of work.
 *
 * A long task does not fit in one run, one context window, or one process. The
 * convention this repo already uses for that is `.goal-state.md`: an append-only
 * file that says what the goal is and what the last rounds did, so a fresh session
 * with no memory of the previous one can pick the work up.
 *
 * What this module adds is that the harness now reads and writes it:
 *
 *   - on start, the objective (the head of the file) and the latest state (the
 *     tail) go into the system prompt, so a new run knows what "continue" means;
 *   - the model gets `goal_state` and `goal_update` as ordinary tools, so its own
 *     account of a round is the record rather than a sentence that scrolls away;
 *   - and if the model never updates the file, the run's end is recorded anyway.
 *     Durability cannot depend on the model remembering: an errored or stalled run
 *     is exactly the run whose state a fresh session needs most.
 *
 * Two rules this file will not bend on. **Append-only**: it is shared with other
 * lanes, so nothing here ever truncates, reorders or rewrites a byte that is
 * already on disk - the write is a single `appendFileSync`. **Numbered by the
 * file, not by the run**: the next round is read back out of the file, so rounds
 * stay consecutive across processes and the other lanes' entries are left alone.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_GOAL_FILE = ".goal-state.md";

/** The file the harness writes when nothing else is configured. */
export function goalFile(file, root = process.cwd()) {
  return resolve(root, file || DEFAULT_GOAL_FILE);
}

const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
};

/**
 * Read the state file. A missing file is not an error - the first round of a goal
 * has no history - and a file another lane is mid-write on is handled by reading
 * it, not by locking: this file is append-only, so the worst case is that the tail
 * is one entry stale.
 */
export function readGoalState({ file, tailChars = 3000, headChars = 900 } = {}) {
  let text = "";
  let exists = false;
  try {
    text = readFileSync(file, "utf8");
    exists = true;
  } catch {
    text = "";
  }
  // Rounds are numbered anywhere in the file: the convention here is
  // `**Round-26 update (…)**`, but `Round 26` is accepted too.
  const rounds = [...text.matchAll(/\bRound[-\s](\d+)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
  const lastRound = rounds.length ? Math.max(...rounds) : 0;
  const headings = [...text.matchAll(/^\*\*(.+?)\*\*\s*$/gm)].map((m) => m[1]);
  const tail = text.length > tailChars ? `…(earlier state omitted)\n${text.slice(-tailChars)}` : text;
  return {
    exists,
    file,
    bytes: exists ? statSync(file).size : 0,
    lastRound,
    rounds: rounds.length,
    headings,
    lastHeading: headings.length ? headings[headings.length - 1] : null,
    head: clip(text, headChars),
    tail,
  };
}

/** The round number this run should write. */
export function nextRound(state) {
  return (Number(state?.lastRound) || 0) + 1;
}

/**
 * The goal block for the system prompt: what the goal is (the head of the file),
 * where it got to (the tail), and the two rules the model cannot infer - record
 * before answering, and never rewrite the file.
 */
export function goalPrompt(state, { maxChars = 2200, file = null } = {}) {
  if (!state) return "";
  const path = file ?? state.file;
  const lines = [
    "## Durable goal (this run is one round of it)",
    `Goal state file: ${path}`,
  ];
  if (!state.exists) {
    lines.push(
      "The file does not exist yet, so this run starts the goal: state the objective plainly when you record it.",
    );
  } else {
    lines.push(`Recorded so far: ${state.bytes} bytes, last round ${state.lastRound || "(unnumbered)"}.`);
  }
  lines.push(
    "",
    "Rules for a goal that outlives one run:",
    "- The goal is not finished because you say so: finish it, then record what proves it.",
    "- Before your final answer, call `goal_update` with what you changed, the evidence, and what is next. If you cannot reach a conclusion, record where you stopped instead - a stalled round that is written down is worth more than a fluent summary.",
    "- Set `done: true` only when the goal itself is achieved and the evidence is in the file.",
    "- The file is APPEND-ONLY and shared with other lanes. Never rewrite, reorder or delete it; `goal_update` appends, and `goal_state` reads.",
    "",
  );
  if (state.exists) {
    lines.push("Objective (the head of the file):", clip(state.head, Math.floor(maxChars / 3)), "", "Latest recorded state:", clip(state.tail, Math.floor((maxChars * 2) / 3)));
  }
  return lines.join("\n").slice(0, maxChars + 600);
}

/**
 * One round entry, in the shape the file already uses. `summary` is required
 * because an entry that says a round happened without saying what it did is worse
 * than no entry: it makes the next session re-derive the state.
 */
export function formatGoalEntry({
  round,
  at = new Date().toISOString(),
  summary,
  headline = null,
  evidence = null,
  next = null,
  done = false,
  files = null,
  by = "model",
} = {}) {
  const body = String(summary ?? "").trim();
  if (!body) throw new Error("goal entry needs a summary");
  const title = headline ?? clip(body.split(/\n/)[0], 120);
  const out = [`**Round-${round} update (${at}): ${title}**`, "", body];
  if (files?.length) out.push("", `Files: ${files.map((f) => `\`${f}\``).join(", ")}`);
  if (evidence) out.push("", `**Evidence:** ${String(evidence).trim()}`);
  out.push("", `**Next:** ${next ? String(next).trim() : done ? "(goal complete)" : "(none recorded)"}`);
  out.push("", `**Goal status:** ${done ? "**done**" : "still active."}${by === "harness" ? " _(recorded by the harness)_" : ""}`);
  return out.join("\n");
}

/**
 * Append one entry. The only write path in this module, and deliberately a single
 * append: the file is shared, so a rewrite would be a data-loss bug, not a style
 * choice. Returns the new size so a caller can report it.
 */
export function appendGoalEntry(entry, { file } = {}) {
  const text = String(entry ?? "").trim();
  if (!text) throw new Error("refusing to append an empty goal entry");
  let sep = "\n";
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    // A file we create says who created it, so the next reader is not guessing.
    const header = "# Goal state\n\n_Append-only. Newest entries at the bottom; the harness and the model both append._\n";
    appendFileSync(file, header, "utf8");
    sep = "\n";
  } else {
    const existing = readFileSync(file, "utf8");
    sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  }
  appendFileSync(file, `${sep}${text}\n`, "utf8");
  return { written: true, file, bytes: statSync(file).size };
}

/**
 * The two tools. `ctx` is the loop's per-run record: the tools write the entry
 * themselves (so the model's own words are the record) and set the flags the loop
 * reads - `wrote` stops the harness adding a second entry for the same round, and
 * `done` is the only way a goal is declared complete.
 */
export function goalTools(ctx) {
  const file = ctx.file;
  return [
    {
      name: "goal_state",
      description:
        "Read the durable goal state file (the objective and the latest rounds). Use it after a context compaction, or before deciding what to do next in a long goal.",
      parameters: {
        type: "object",
        properties: { tailChars: { type: "integer", description: "How much of the end of the file to return. Defaults to 3000." } },
      },
      async run({ tailChars } = {}) {
        const state = readGoalState({ file, tailChars: Number.isFinite(Number(tailChars)) ? Math.max(200, Number(tailChars)) : 3000 });
        if (!state.exists) return `no goal state file yet at ${file} - this run would create it`;
        return [`goal state: ${file} (${state.bytes} bytes, last round ${state.lastRound || "unnumbered"})`, "", state.tail].join("\n");
      },
    },
    {
      name: "goal_update",
      description:
        "Append ONE round entry to the durable goal state file: what you changed, the evidence, and what is next. Call this before your final answer in a long goal. The file is append-only - this never rewrites it. Set done: true only when the goal is achieved and the evidence is recorded.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What this round did, in a few sentences. Required." },
          evidence: { type: "string", description: "The commands/tests and their real output that prove it." },
          next: { type: "string", description: "What the next round should do." },
          done: { type: "boolean", description: "True only if the goal is complete." },
          files: { type: "array", items: { type: "string" }, description: "Files touched this round." },
        },
        required: ["summary"],
      },
      async run({ summary, evidence, next, done, files } = {}) {
        const text = String(summary ?? "").trim();
        if (!text) return "not written: `summary` is required";
        const round = ctx.round();
        const entry = formatGoalEntry({
          round,
          summary: text,
          evidence: evidence ?? null,
          next: next ?? null,
          done: done === true,
          files: Array.isArray(files) && files.length ? files.map(String) : null,
          by: "model",
        });
        const written = appendGoalEntry(entry, { file });
        ctx.wrote = true;
        if (done === true) ctx.done = true;
        if (next) ctx.next = String(next);
        return `appended round ${round} to ${file} (${written.bytes} bytes)${done === true ? "; goal marked done" : ""}`;
      },
    },
  ];
}
