/**
 * Undo per step: before a file tool changes a file, the file's current bytes are copied
 * into the run's journal (<home>/undo/<run id>/). "Undo from step N" puts every file
 * the run changed at step N or later back the way it was before step N, and deletes
 * the files those steps created.
 *
 * What it covers: write_file, edit_file and the formatter that runs after them, and -
 * through snapshots.mjs - whatever a shell command changed: a step that runs a changing
 * command is snapshotted before and after in a shadow repository, which records exactly
 * the files that step changed. Undo restores each file to its state before the earliest
 * change being undone, whichever of the two recorded it.
 *
 * Journals older than 14 days are removed the first time one is opened in a process.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { readSnapshotLog, restoreBefore } from "./snapshots.mjs";

export const undoRoot = () => join(process.env.ROSALENA_HOME || join(homedir(), ".rosalena"), "undo");

let swept = false;
function sweep(root) {
  if (swept) return;
  swept = true;
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  try {
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* nothing to sweep yet */
  }
}

/**
 * One run's journal. `step` is set by the loop; `dir` once the run has an id.
 * `record(abs)` must be called BEFORE the file is changed.
 */
export function createJournal({ dir = null } = {}) {
  const seen = new Set();
  let count = 0;
  const journal = {
    dir,
    step: 0,
    record(abs) {
      if (!journal.dir) return;
      const key = `${journal.step}\u0000${abs.toLowerCase()}`;
      if (seen.has(key)) return; // the state BEFORE this step is what matters, once
      seen.add(key);
      try {
        mkdirSync(journal.dir, { recursive: true });
        sweep(dirname(journal.dir));
        const existed = existsSync(abs);
        let backup = null;
        if (existed) {
          count += 1;
          backup = `${journal.step}-${count}.bak`;
          copyFileSync(abs, join(journal.dir, backup));
        }
        appendFileSync(join(journal.dir, "journal.jsonl"), `${JSON.stringify({ step: journal.step, path: abs, existed, backup, at: Date.now() })}\n`);
      } catch {
        // A journal that cannot be written must not stop the edit; undo will say it has nothing.
      }
    },
  };
  return journal;
}

function readEntries(dir) {
  const file = join(dir, "journal.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** A run journal's entries, oldest first: the session rail counts lines from them (session-rail.mjs). */
export const readJournal = readEntries;

/** The steps of a run that changed files, for the page: [{ step, files: [...] }]. */
export function listChanges(runId, root = undoRoot()) {
  const dir = join(root, String(runId));
  const undone = existsSync(join(dir, "undone.json")) ? JSON.parse(readFileSync(join(dir, "undone.json"), "utf8")) : { from: null };
  const bySteps = new Map();
  for (const entry of readEntries(dir)) {
    if (!bySteps.has(entry.step)) bySteps.set(entry.step, new Set());
    bySteps.get(entry.step).add(entry.path);
  }
  // What shell commands changed, from the snapshot pairs (snapshots.mjs).
  for (const pair of readSnapshotLog(dir)) {
    if (!bySteps.has(pair.step)) bySteps.set(pair.step, new Set());
    for (const f of pair.files ?? []) bySteps.get(pair.step).add(join(pair.root, f.path));
  }
  return {
    undoneFrom: undone.from,
    steps: [...bySteps.entries()].sort((a, b) => a[0] - b[0]).map(([step, files]) => ({ step, files: [...files] })),
  };
}

/**
 * Put files back as they were before `fromStep`. Returns what was restored and removed.
 * Safe to repeat: undoing from an earlier step later still restores the right bytes,
 * because every backup is the state before its own step.
 */
export function undoFrom(runId, fromStep, root = undoRoot()) {
  const dir = join(root, String(runId));
  const entries = readEntries(dir).filter((e) => e.step >= Number(fromStep));
  // Snapshot pairs: one change per file a step's shell commands touched. A pair is taken
  // before any of its step's calls, so on the same step it is the earlier state.
  const pairs = readSnapshotLog(dir).filter((p) => p.step >= Number(fromStep));
  for (const pair of pairs) {
    for (const f of pair.files ?? []) {
      entries.push({ step: pair.step, at: (pair.at ?? 0) - 1e12, path: join(pair.root, f.path), snapshot: { gitDir: pair.gitDir, root: pair.root, before: pair.before, file: f } });
    }
  }
  if (!entries.length) return { restored: [], removed: [], note: "nothing to undo: nothing changed from that step on" };
  // The earliest change per file decides what it goes back to: its state before that change.
  const firstByPath = new Map();
  for (const entry of entries.sort((a, b) => a.step - b.step || a.at - b.at)) {
    const key = entry.path.toLowerCase();
    if (!firstByPath.has(key)) firstByPath.set(key, entry);
  }
  const restored = [];
  const removed = [];
  const failed = [];
  for (const entry of firstByPath.values()) {
    if (entry.snapshot) {
      const out = restoreBefore({ gitDir: entry.snapshot.gitDir, root: entry.snapshot.root, before: entry.snapshot.before, files: [entry.snapshot.file] });
      restored.push(...out.restored);
      removed.push(...out.removed);
      failed.push(...out.failed);
      continue;
    }
    try {
      if (entry.existed && entry.backup) {
        mkdirSync(dirname(entry.path), { recursive: true });
        copyFileSync(join(dir, entry.backup), entry.path);
        restored.push(entry.path);
      } else if (existsSync(entry.path)) {
        rmSync(entry.path, { force: true });
        removed.push(entry.path);
      }
    } catch (err) {
      failed.push(`${entry.path}: ${err.message}`);
    }
  }
  writeFileSync(join(dir, "undone.json"), JSON.stringify({ from: Number(fromStep), at: Date.now() }));
  return {
    restored,
    removed,
    failed,
    note: pairs.length
      ? "Shell command changes were restored from snapshots too (files over 10 MiB, .env files and ignored folders are never snapshotted)."
      : "No shell command changed files in these steps, or snapshots were off; file tool changes were restored from the journal.",
  };
}
