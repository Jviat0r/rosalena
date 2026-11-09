/**
 * Session folders: user-created groups in the sidebar.
 *
 * Two facts shaped this module.
 *
 * 1. A folder is a VIEW, not a container. The run store on disk is the truth
 *    about a session (`<id>.json`), and a folder assignment is one line in a
 *    separate small file. Deleting a folder therefore can never delete a
 *    session; it drops the assignments and the sessions reappear under
 *    "Ungrouped". Anything else would make an organising feature a data-loss
 *    feature.
 * 2. The sidebar lists sessions from OTHER harnesses too (a dsh session has no
 *    file here), so an assignment is keyed by run id string and is simply
 *    ignored when the run is not present. No foreign key, nothing to repair.
 *
 * The file is written atomically (temp + rename) because two UI tabs are allowed
 * to be open, and a half-written JSON file would silently lose every folder.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MAX_FOLDER_NAME = 40;
export const MAX_FOLDERS = 200;

/** The id used by the API for "no folder". Never stored in the file. */
export const UNGROUPED = "ungrouped";

export class FolderError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = "FolderError";
    this.status = status;
  }
}

export function foldersFile(home) {
  return join(home, "folders.json");
}

const EMPTY = () => ({ folders: [], assignments: {} });

/**
 * Read the store, repairing rather than throwing.
 *
 * A corrupt file is not worth a crash: the worst outcome is that organising is
 * lost, and it must never be that the chat list stops loading. `repaired` says
 * whether what was read had to be discarded, so the UI can say so instead of
 * pretending.
 */
export function readFolders(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ...EMPTY(), repaired: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY(), repaired: true };
  }
  const folders = [];
  const seen = new Set();
  for (const f of Array.isArray(parsed?.folders) ? parsed.folders : []) {
    const id = String(f?.id ?? "").trim();
    const name = String(f?.name ?? "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    folders.push({ id, name, createdAt: String(f?.createdAt ?? "") || new Date(0).toISOString() });
  }
  const known = new Set(folders.map((f) => f.id));
  const assignments = {};
  for (const [runId, folderId] of Object.entries(parsed?.assignments ?? {})) {
    // An assignment to a folder that no longer exists is dropped here, so no
    // reader has to defend against it later.
    if (typeof runId === "string" && known.has(String(folderId))) assignments[runId] = String(folderId);
  }
  const repaired = folders.length !== (Array.isArray(parsed?.folders) ? parsed.folders.length : 0);
  return { folders, assignments, repaired };
}

export function writeFolders(file, state) {
  const folders = (state.folders ?? []).map((f) => ({ id: f.id, name: f.name, createdAt: f.createdAt }));
  const known = new Set(folders.map((f) => f.id));
  const assignments = {};
  for (const [runId, folderId] of Object.entries(state.assignments ?? {})) {
    if (known.has(folderId)) assignments[runId] = folderId;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ folders, assignments }, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return { folders, assignments };
}

/** A short id that sorts by creation and cannot collide with a run id. */
export function newFolderId(now = Date.now(), rand = Math.random) {
  const stamp = new Date(now).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const tail = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `f-${stamp}-${tail}`;
}

function cleanName(name) {
  const value = String(name ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!value) throw new FolderError("a folder needs a name");
  if (value.length > MAX_FOLDER_NAME) throw new FolderError(`a folder name is at most ${MAX_FOLDER_NAME} characters`);
  return value;
}

/**
 * Create a folder.
 *
 * Names are compared case-insensitively because two folders called "Work" and
 * "work" are a mistake the user cannot see in the sidebar; refusing is kinder
 * than creating the duplicate.
 */
export function createFolder(state, name, { now = Date.now(), rand = Math.random } = {}) {
  const clean = cleanName(name);
  if (state.folders.length >= MAX_FOLDERS) throw new FolderError(`no more than ${MAX_FOLDERS} folders`);
  if (state.folders.some((f) => f.name.toLowerCase() === clean.toLowerCase())) {
    throw new FolderError(`a folder called "${clean}" already exists`);
  }
  const folder = { id: newFolderId(now, rand), name: clean, createdAt: new Date(now).toISOString() };
  return { folder, state: { folders: [...state.folders, folder], assignments: { ...state.assignments } } };
}

export function renameFolder(state, id, name) {
  const clean = cleanName(name);
  const target = state.folders.find((f) => f.id === id);
  if (!target) throw new FolderError("no such folder", { status: 404 });
  if (state.folders.some((f) => f.id !== id && f.name.toLowerCase() === clean.toLowerCase())) {
    throw new FolderError(`a folder called "${clean}" already exists`);
  }
  return {
    folder: { ...target, name: clean },
    state: { folders: state.folders.map((f) => (f.id === id ? { ...f, name: clean } : f)), assignments: { ...state.assignments } },
  };
}

/** Delete a folder. Sessions inside it are NOT deleted; they become ungrouped. */
export function deleteFolder(state, id) {
  if (!state.folders.some((f) => f.id === id)) throw new FolderError("no such folder", { status: 404 });
  const assignments = { ...state.assignments };
  for (const [runId, folderId] of Object.entries(assignments)) if (folderId === id) delete assignments[runId];
  return { state: { folders: state.folders.filter((f) => f.id !== id), assignments } };
}

/**
 * Move a session into a folder, or out of every folder with `null`/`ungrouped`.
 *
 * Moving into a folder that does not exist is an error rather than a silent
 * no-op: the user dragged something and must be told it did not land.
 */
export function moveRun(state, runId, folderId) {
  const run = String(runId ?? "").trim();
  if (!run) throw new FolderError("a session id is required");
  const assignments = { ...state.assignments };
  const wanted = folderId === null || folderId === undefined || folderId === "" ? UNGROUPED : String(folderId);
  if (wanted === UNGROUPED) {
    delete assignments[run];
  } else {
    if (!state.folders.some((f) => f.id === wanted)) throw new FolderError("no such folder", { status: 404 });
    assignments[run] = wanted;
  }
  return { state: { folders: state.folders, assignments } };
}

/**
 * The sidebar shape: real folders in creation order, then Ungrouped, with every
 * session that is not in a folder under Ungrouped. Sessions whose folder was
 * deleted earlier in the same request are already ungrouped by `readFolders`.
 */
export function groupSessions(state, sessions, { ungroupedId = UNGROUPED, ungroupedName = "Ungrouped" } = {}) {
  const byId = new Map(state.folders.map((f) => [f.id, { id: f.id, name: f.name, sessions: [] }]));
  const ungrouped = { id: ungroupedId, name: ungroupedName, sessions: [] };
  for (const session of sessions ?? []) {
    const folderId = state.assignments[session.id];
    const bucket = folderId && byId.has(folderId) ? byId.get(folderId) : ungrouped;
    bucket.sessions.push(session);
  }
  return [...state.folders.map((f) => byId.get(f.id)), ungrouped];
}
