/**
 * The session rail's server half (the page half is ui/session-rail.mjs).
 *
 * The rail shows, per chat, what Claude Code's desktop panel shows: the folder and git
 * branch it runs in, and how many lines the chat added and removed. Nothing here is a
 * second record of what a run did. The line counts come from the same two journals undo
 * already keeps (undo.mjs): the copy taken before a file tool changed a file, and the
 * shadow-repository snapshot taken before a shell command did (snapshots.mjs). For every
 * file the chat touched, the state before the chat first touched it is compared with the
 * file on disk now, so an undo, or a later edit that put a line back, shows up as it is.
 *
 *   GET /api/session-rail?id=<chat>&workspace=<folder>   (src/ui.mjs)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readSnapshotLog } from "./snapshots.mjs";
import { readJournal, undoRoot } from "./undo.mjs";

/** Files bigger than this are listed as changed but not counted line by line. */
export const RAIL_MAX_BYTES = 2 * 1024 * 1024;
/** A diff with more edits than this falls back to counting lines in and out. */
const MAX_EDITS = 4000;

/** Lines of a text, without the empty piece a final newline leaves. CRLF and LF read the same. */
export function splitLines(text) {
  const s = String(text ?? "");
  if (!s) return [];
  const lines = s.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Shortest edit script length between two line lists, inserts and deletes only (Myers).
 * Returns -1 when it needs more than `maxD` edits.
 */
function editDistance(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxD);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  for (let d = 0; d <= limit; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return -1;
}

/**
 * How many lines `after` adds to `before` and how many it removes, the way `git diff
 * --numstat` counts them (a changed line is one removed and one added).
 */
export function lineDelta(before, after) {
  const a = Array.isArray(before) ? before : splitLines(before);
  const b = Array.isArray(after) ? after : splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (!midA.length || !midB.length) return { added: midB.length, removed: midA.length };
  const d = editDistance(midA, midB, MAX_EDITS);
  if (d >= 0) {
    const common = (midA.length + midB.length - d) / 2;
    return { added: midB.length - common, removed: midA.length - common };
  }
  // Too different to diff cheaply: count each line in and out as a multiset.
  const counts = new Map();
  for (const line of midA) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of midB) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
      common += 1;
    }
  }
  return { added: midB.length - common, removed: midA.length - common };
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

function readNow(abs) {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return { exists: false };
    if (st.size > RAIL_MAX_BYTES) return { exists: true, large: true };
    return { exists: true, buf: readFileSync(abs) };
  } catch {
    return { exists: false };
  }
}

function snapshotBlob(gitDir, root, commit, path) {
  const res = spawnSync("git", ["-c", "core.quotepath=false", "cat-file", "blob", `${commit}:${path}`], {
    cwd: root,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_OPTIONAL_LOCKS: "0" },
    windowsHide: true,
    maxBuffer: RAIL_MAX_BYTES * 2,
    timeout: 20_000,
  });
  return res.status === 0 && Buffer.isBuffer(res.stdout) ? res.stdout : null;
}

const earlier = (a, b) => a.turn - b.turn || a.step - b.step || a.at - b.at;

/**
 * The lines a chat added and removed, across every run in it (its turns and their
 * subagents, oldest first), from the undo journals.
 *
 * @returns {{ added: number, removed: number, files: Array<{ path: string, status: "A"|"M"|"D", added: number|null, removed: number|null, binary?: true, large?: true, at: number }> }}
 */
export function chatChanges({ runIds = [], root = undoRoot(), maxBytes = RAIL_MAX_BYTES } = {}) {
  const firsts = new Map(); // lower-case path -> the earliest record of its state before the chat
  const lastAt = new Map();
  const note = (candidate) => {
    const key = candidate.path.toLowerCase();
    const seen = firsts.get(key);
    if (!seen || earlier(candidate, seen) < 0) firsts.set(key, candidate);
    lastAt.set(key, Math.max(lastAt.get(key) ?? 0, candidate.realAt));
  };
  [...new Set(runIds.map(String).filter(Boolean))].forEach((runId, turn) => {
    const dir = join(root, runId);
    if (!existsSync(dir)) return;
    for (const entry of readJournal(dir)) {
      if (!entry?.path) continue;
      const at = Number(entry.at) || 0;
      note({ turn, step: Number(entry.step) || 0, at, realAt: at, path: entry.path, existed: Boolean(entry.existed), backup: entry.backup ? join(dir, entry.backup) : null });
    }
    for (const pair of readSnapshotLog(dir)) {
      for (const f of pair.files ?? []) {
        if (!f?.path) continue;
        const at = Number(pair.at) || 0;
        // A pair is taken before any call of its step, so on the same step it is the earlier state.
        note({ turn, step: Number(pair.step) || 0, at: at - 1e12, realAt: at, path: join(pair.root, f.path), existed: f.status !== "A", snapshot: { gitDir: pair.gitDir, root: pair.root, commit: pair.before, path: f.path } });
      }
    }
  });

  const files = [];
  let added = 0;
  let removed = 0;
  for (const [key, first] of firsts) {
    let before = null;
    let beforeLarge = false;
    if (first.existed) {
      if (first.snapshot) before = snapshotBlob(first.snapshot.gitDir, first.snapshot.root, first.snapshot.commit, first.snapshot.path);
      else if (first.backup) {
        try {
          if (statSync(first.backup).size > maxBytes) beforeLarge = true;
          else before = readFileSync(first.backup);
        } catch {
          before = null;
        }
      }
    }
    const now = readNow(first.path);
    if (!first.existed && !now.exists) continue; // made and removed again: nothing left
    const status = !first.existed ? "A" : !now.exists ? "D" : "M";
    const row = { path: first.path, status, added: null, removed: null, at: lastAt.get(key) ?? first.realAt };
    if (now.large || beforeLarge || (first.existed && before == null)) {
      // Counted as changed, not counted in lines: the old copy is too big or no longer kept.
      if (now.large || beforeLarge) row.large = true;
      files.push(row);
      continue;
    }
    const beforeBuf = first.existed ? before : Buffer.alloc(0);
    const nowBuf = now.exists ? now.buf : Buffer.alloc(0);
    if (beforeBuf.equals(nowBuf)) continue; // put back as it was (an undo, or an edit reverted)
    if (isBinary(beforeBuf) || isBinary(nowBuf)) {
      row.binary = true;
      files.push(row);
      continue;
    }
    const delta = lineDelta(beforeBuf.toString("utf8"), nowBuf.toString("utf8"));
    row.added = delta.added;
    row.removed = delta.removed;
    added += delta.added;
    removed += delta.removed;
    files.push(row);
  }
  files.sort((a, b) => b.at - a.at);
  return { added, removed, files };
}

/** The git branch a folder is on: { branch } or { detached: sha }, or null outside a repository. */
export function gitBranch(dir) {
  if (!dir) return null;
  const git = (args) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  const named = git(["symbolic-ref", "--short", "-q", "HEAD"]);
  if (named.status === 0 && named.stdout.trim()) return { branch: named.stdout.trim() };
  const sha = git(["rev-parse", "--short", "HEAD"]);
  if (sha.status === 0 && sha.stdout.trim()) return { detached: sha.stdout.trim() };
  return null;
}
