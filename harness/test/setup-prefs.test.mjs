/**
 * The first-run setup window's setting (ui-prefs.mjs setup): unset until it has been shown,
 * so it opens on the first start; "later" (Not now) or "done" (it ran) keep it closed on
 * the next start. Settings opens it again either way. Anything else is refused.
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_PINNED, SETUP_CHOICES, readPrefs, updatePrefs, writePrefs } from "../src/ui-prefs.mjs";

test("pinned chats: run ids, newest first, no repeats, nothing else, and they survive other changes", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pin-prefs-")), "ui-prefs.json");
  assert.deepEqual(readPrefs(file).pinned, []);
  writePrefs(file, updatePrefs(readPrefs(file), { pinned: ["r-20261106-054114-dade", "r-20261106-054114-dade", "../../etc", 7, "r-20261102-072520-e1b3"] }));
  assert.deepEqual(readPrefs(file).pinned, ["r-20261106-054114-dade", "r-20261102-072520-e1b3"]);
  writePrefs(file, updatePrefs(readPrefs(file), { queueMode: "together" }));
  assert.deepEqual(readPrefs(file).pinned, ["r-20261106-054114-dade", "r-20261102-072520-e1b3"]);
  assert.throws(() => updatePrefs(readPrefs(file), { pinned: "r-1" }), /pinned must be a list/);
  const many = Array.from({ length: MAX_PINNED + 5 }, (_, i) => `r-x-${i}`);
  assert.equal(updatePrefs(readPrefs(file), { pinned: many }).pinned.length, MAX_PINNED);
});

test("setup: unset on a fresh install, then later or done, nothing else", () => {
  const file = join(mkdtempSync(join(tmpdir(), "setup-prefs-")), "ui-prefs.json");
  assert.deepEqual([...SETUP_CHOICES], ["done", "later"]);
  assert.equal(readPrefs(file).setup, null, "a fresh install has not seen it, so it opens");
  writePrefs(file, updatePrefs(readPrefs(file), { setup: "later" }));
  assert.equal(readPrefs(file).setup, "later");
  writePrefs(file, updatePrefs(readPrefs(file), { setup: "done" }));
  assert.equal(readPrefs(file).setup, "done");
  assert.throws(() => updatePrefs(readPrefs(file), { setup: "maybe" }), /setup must be one of/);
  // Another setting changing does not forget it.
  writePrefs(file, updatePrefs(readPrefs(file), { queueMode: "together" }));
  assert.equal(readPrefs(file).setup, "done");
});
