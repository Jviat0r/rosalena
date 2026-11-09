/**
 * The file tools added 2026-11-08 to match Claude Code's set: several edits in one
 * edit_file call (all or nothing), move_file and delete_file. Both of the last two go
 * through the undo journal, so "undo from this step" puts the files back.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createTools } from "../src/tools.mjs";
import { createJournal, undoFrom } from "../src/undo.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "file-ops-"));
  const undo = mkdtempSync(join(tmpdir(), "file-ops-undo-"));
  const journal = createJournal({ dir: join(undo, "r-test") });
  journal.step = 1;
  const tools = createTools({ root, journal });
  return { root, undo, journal, run: (name, args) => tools.byName[name].run(args) };
}

test("edit_file with edits applies them in order, and a bad one changes nothing", async () => {
  const { root, run } = setup();
  writeFileSync(join(root, "a.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  const out = await run("edit_file", { path: "a.js", edits: [{ old_text: "a = 1", new_text: "a = 10" }, { old_text: "c = 3", new_text: "c = 30" }] });
  assert.match(out, /2 edits, 2 replacements/);
  assert.equal(readFileSync(join(root, "a.js"), "utf8"), "const a = 10;\nconst b = 2;\nconst c = 30;\n");
  await assert.rejects(() => run("edit_file", { path: "a.js", edits: [{ old_text: "b = 2", new_text: "b = 20" }, { old_text: "missing", new_text: "x" }] }), /edit 2 of 2.*Nothing was changed/s);
  assert.equal(readFileSync(join(root, "a.js"), "utf8"), "const a = 10;\nconst b = 2;\nconst c = 30;\n", "the first edit did not land on its own");
});

test("move_file and delete_file are undone by the journal", async () => {
  const { root, undo, run } = setup();
  writeFileSync(join(root, "keep.txt"), "keep me\n");
  writeFileSync(join(root, "old.txt"), "move me\n");
  assert.match(await run("move_file", { from: "old.txt", to: "sub/new.txt" }), /moved old\.txt -> sub[\\/]new\.txt/);
  assert.ok(!existsSync(join(root, "old.txt")));
  assert.equal(readFileSync(join(root, "sub", "new.txt"), "utf8"), "move me\n");
  await assert.rejects(() => run("move_file", { from: "keep.txt", to: "sub/new.txt" }), /already exists/);
  assert.match(await run("delete_file", { path: "keep.txt" }), /deleted keep\.txt/);
  assert.ok(!existsSync(join(root, "keep.txt")));
  await assert.rejects(() => run("delete_file", { path: "sub" }), /is a folder/);
  await assert.rejects(() => run("delete_file", { path: "../outside.txt" }), /outside|workspace/i);

  const outcome = undoFrom("r-test", 1, undo);
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "keep me\n", "the deleted file is back");
  assert.equal(readFileSync(join(root, "old.txt"), "utf8"), "move me\n", "the moved file is back where it was");
  assert.ok(!existsSync(join(root, "sub", "new.txt")), "and the copy it became is gone");
  assert.ok(outcome.restored.length >= 2);
});
