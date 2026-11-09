/**
 * Conversations: which runs are turns of the same chat.
 *
 * Every message sent in the window is its own run (its own log, status and stop flag),
 * and a follow-up names the run it continues. That link used to live only in the page's
 * memory, so the sidebar listed each turn as a separate chat. This file keeps it:
 * `threads.json` maps a follow-up's run id to the first run of its conversation (the
 * root), which is the id the sidebar, the folders and the URL use for the whole chat.
 *
 *   { "v": 1, "runs": { "r-...-b2": "r-...-a1", "r-...-c3": "r-...-a1" } }
 *
 * A root is never a key, so a run that is missing from the map is its own conversation.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const threadsFile = (home) => join(home, "threads.json");

/**
 * Branches: a conversation started from a point inside another one (Branch on a message).
 * Kept apart from threads.json on purpose - a branch is its own conversation, not a turn
 * of the old one - and used for its title ("branch of ...").
 *
 *   { "v": 1, "branches": { "<new run id>": { "from": "<thread>", "at": "<run id>", "parent": "<run id>" | null } } }
 */
export const branchesFile = (home) => join(home, "branches.json");

export function readBranches(file) {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed.branches === "object" && parsed.branches ? parsed.branches : {};
  } catch {
    return {};
  }
}

export function recordBranch(file, runId, { from, at = null, parent = null }) {
  const branches = readBranches(file);
  branches[runId] = { from, at, parent, when: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, branches }, null, 2));
  renameSync(tmp, file);
  return branches[runId];
}

/** The run -> root map. A missing or unreadable file is no links, never an error. */
export function readThreads(file) {
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const runs = parsed && typeof parsed.runs === "object" && parsed.runs ? parsed.runs : {};
    const clean = {};
    for (const [id, root] of Object.entries(runs)) if (typeof root === "string" && root && root !== id) clean[id] = root;
    return clean;
  } catch {
    return {};
  }
}

/** The first run of the conversation `id` belongs to (itself when it is a first run). */
export const rootOf = (map, id) => map[id] ?? id;

/**
 * Record that `runId` continues `parentId`, and return the conversation's root. The
 * parent may itself be a follow-up: the link always points at the root, so a chat of
 * fifty turns is one lookup, not a chain of fifty.
 */
export function linkRun(file, runId, parentId) {
  const map = readThreads(file);
  const root = rootOf(map, parentId);
  if (root === runId) return root;
  map[runId] = root;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, runs: map }, null, 2)}\n`);
  renameSync(tmp, file);
  return root;
}

/**
 * Every run of a conversation, oldest first. Run ids start with their start time, to the
 * second (r-YYYYMMDD-HHMMSS-xxxx): sort on that part only, and let two turns in the same
 * second keep the order linkRun recorded them in (a stable sort over insertion order),
 * not the order of their random suffixes.
 */
export function threadMembers(map, root) {
  const ids = [];
  for (const [id, r] of Object.entries(map)) if (r === root) ids.push(id);
  const stamp = (id) => String(id).slice(0, 17);
  return [root, ...ids.sort((a, b) => stamp(a).localeCompare(stamp(b)))];
}

/**
 * Fold a newest-first run list into one row per conversation. The row keeps the root's
 * id and title (what the person first asked), and takes its time and status from the
 * newest turn, so a chat continued today sorts as today and shows "running" while its
 * latest turn runs. `titleOf(root)` names a root that fell outside the list.
 */
export function collapseThreads(rows, map, { titleOf = () => null } = {}) {
  const out = [];
  const byRoot = new Map();
  for (const row of rows) {
    const root = rootOf(map, row.id);
    const seen = byRoot.get(root);
    if (seen) {
      if (row.id === root) seen.title = row.title;
      continue;
    }
    const turns = threadMembers(map, root).length;
    const merged = { ...row, id: root, latest: row.id, turns };
    if (row.id !== root) merged.title = titleOf(root) ?? row.title;
    // A subagent of a follow-up hangs under the conversation, not under a turn nobody lists.
    if (row.parent) merged.parent = rootOf(map, row.parent);
    byRoot.set(root, merged);
    out.push(merged);
  }
  return out;
}
