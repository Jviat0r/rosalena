/**
 * Session folders. Every test uses a real temp directory: the point of the module
 * is what survives a restart, and an in-memory double would prove nothing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FolderError,
  MAX_FOLDER_NAME,
  MAX_FOLDERS,
  UNGROUPED,
  createFolder,
  deleteFolder,
  foldersFile,
  groupSessions,
  moveRun,
  newFolderId,
  readFolders,
  renameFolder,
  writeFolders,
} from "../src/folders.mjs";

const TMP = mkdtempSync(join(tmpdir(), "folders-test-"));
const file = foldersFile(TMP);
const empty = () => ({ folders: [], assignments: {} });

test("a missing file is an empty store, not an error", () => {
  const state = readFolders(join(TMP, "nothing-here.json"));
  assert.deepEqual(state.folders, []);
  assert.deepEqual(state.assignments, {});
  assert.equal(state.repaired, false);
});

test("creating a folder survives a restart, and the write is atomic", () => {
  const { folder, state } = createFolder(empty(), "  Client work  ");
  assert.equal(folder.name, "Client work", "surrounding space is not part of the name");
  assert.match(folder.id, /^f-\d{14}-[0-9a-z]{4}$/);
  writeFolders(file, state);

  const again = readFolders(file);
  assert.deepEqual(again.folders.map((f) => f.name), ["Client work"]);
  assert.equal(again.repaired, false);
  // No .tmp file left behind: a crash mid-write must not leave litter that looks
  // like data.
  assert.deepEqual(readdirSync(TMP).filter((n) => n.endsWith(".tmp")), []);
});

test("two folders with the same name are refused, case-insensitively", () => {
  const first = createFolder(empty(), "Work");
  const state = first.state;
  assert.throws(() => createFolder(state, "work"), FolderError);
  assert.throws(() => createFolder(state, "WORK"), FolderError);
});

test("a name that is only whitespace or control characters is refused", () => {
  assert.throws(() => createFolder(empty(), "   "), FolderError);
  assert.throws(() => createFolder(empty(), "\u0000\u0007"), FolderError);
  assert.throws(() => createFolder(empty(), "x".repeat(MAX_FOLDER_NAME + 1)), FolderError);
  assert.equal(createFolder(empty(), "x".repeat(MAX_FOLDER_NAME)).folder.name.length, MAX_FOLDER_NAME);
});

test("the folder count is capped, so a runaway client cannot fill the disk", () => {
  const folders = Array.from({ length: MAX_FOLDERS }, (_, i) => ({ id: `f-${i}`, name: `n${i}`, createdAt: "" }));
  assert.throws(() => createFolder({ folders, assignments: {} }, "one more"), FolderError);
});

test("moving a session in and out is persisted, and out is the default", () => {
  const { folder, state } = createFolder(empty(), "Work");
  const moved = moveRun(state, "r-20261020-000000-0001", folder.id);
  assert.equal(moved.state.assignments["r-20261020-000000-0001"], folder.id);
  writeFolders(file, moved.state);
  assert.equal(readFolders(file).assignments["r-20261020-000000-0001"], folder.id);

  const out = moveRun(readFolders(file), "r-20261020-000000-0001", null);
  assert.deepEqual(out.state.assignments, {}, "ungrouped means no record at all, not a record saying undgrouped");
  writeFolders(file, out.state);
  assert.deepEqual(readFolders(file).assignments, {});
});

test("moving into a folder that does not exist fails loudly", () => {
  const { state } = createFolder(empty(), "Work");
  assert.throws(() => moveRun(state, "run-1", "f-nope"), FolderError);
  // And the store is untouched by the attempt.
  assert.deepEqual(state.assignments, {});
});

test("moving with no session id is refused rather than guessed", () => {
  const { folder, state } = createFolder(empty(), "Work");
  assert.throws(() => moveRun(state, "", folder.id), FolderError);
  assert.throws(() => moveRun(state, "   ", folder.id), FolderError);
});

test("deleting a folder does NOT delete its sessions, it ungroups them", () => {
  const { folder, state } = createFolder(empty(), "Work");
  const moved = moveRun(state, "run-1", folder.id);
  const after = deleteFolder(moved.state, folder.id);
  assert.deepEqual(after.state.folders, []);
  assert.deepEqual(after.state.assignments, {});

  const grouped = groupSessions(after.state, [{ id: "run-1" }, { id: "run-2" }]);
  assert.equal(grouped.at(-1).id, UNGROUPED);
  assert.deepEqual(grouped.at(-1).sessions.map((s) => s.id), ["run-1", "run-2"]);
});

test("deleting a folder that is not there is a 404, not a silent success", () => {
  try {
    deleteFolder(empty(), "f-nope");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.status, 404);
  }
});

test("renaming keeps the id and refuses a duplicate name", () => {
  const a = createFolder(empty(), "Work");
  const b = createFolder(a.state, "Home");
  const renamed = renameFolder(b.state, a.folder.id, "Client");
  assert.equal(renamed.folder.id, a.folder.id);
  assert.deepEqual(renamed.state.folders.map((f) => f.name), ["Client", "Home"]);
  assert.throws(() => renameFolder(renamed.state, a.folder.id, "home"), FolderError);
  assert.throws(() => renameFolder(renamed.state, "f-nope", "x"), FolderError);
});

test("a corrupt file is repaired to empty and says so, instead of crashing the chat list", () => {
  const bad = join(TMP, "corrupt.json");
  writeFileSync(bad, "{ this is not json");
  const state = readFolders(bad);
  assert.deepEqual(state.folders, []);
  assert.equal(state.repaired, true);
});

test("assignments to folders that do not exist are dropped on read", () => {
  const stale = join(TMP, "stale.json");
  writeFileSync(
    stale,
    JSON.stringify({
      folders: [{ id: "f-1", name: "Real", createdAt: "2026-10-20T00:00:00.000Z" }, { id: "", name: "bad" }],
      assignments: { "run-1": "f-1", "run-2": "f-gone", "run-3": "" },
    }),
  );
  const state = readFolders(stale);
  assert.deepEqual(state.folders.map((f) => f.id), ["f-1"]);
  assert.deepEqual(state.assignments, { "run-1": "f-1" });
});

test("groupSessions puts every session somewhere, exactly once", () => {
  const { folder, state } = createFolder(empty(), "Work");
  const moved = moveRun(state, "run-1", folder.id);
  const sessions = [{ id: "run-1" }, { id: "run-2" }, { id: "run-3" }];
  const groups = groupSessions(moved.state, sessions);
  assert.deepEqual(groups.map((g) => g.name), ["Work", "Ungrouped"]);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ["run-1"]);
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ["run-2", "run-3"]);
  const flat = groups.flatMap((g) => g.sessions.map((s) => s.id));
  assert.deepEqual([...flat].sort(), ["run-1", "run-2", "run-3"], "no session is shown twice or lost");
});

test("an empty folder is still shown, because it is the drop target", () => {
  const { state } = createFolder(empty(), "Empty");
  const groups = groupSessions(state, []);
  assert.deepEqual(groups.map((g) => g.name), ["Empty", "Ungrouped"]);
  assert.deepEqual(groups[0].sessions, []);
});

test("the file on disk is the shape the reader expects", () => {
  const { folder, state } = createFolder(empty(), "Work");
  writeFolders(file, moveRun(state, "run-1", folder.id).state);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["assignments", "folders"]);
  assert.deepEqual(Object.keys(raw.folders[0]).sort(), ["createdAt", "id", "name"]);
});

test("folder ids sort by creation and collide only on an identical clock", () => {
  const a = newFolderId(1_700_000_000_000, () => 0.1);
  const b = newFolderId(1_700_000_000_001, () => 0.2);
  assert.ok(a < b, `${a} should sort before ${b}`);
  assert.notEqual(a, newFolderId(1_700_000_000_000, () => 0.2));
  assert.match(a, /^f-20231114\d{6}-[0-9a-z]{4}$/);
});
