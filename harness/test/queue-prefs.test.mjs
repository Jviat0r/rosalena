/**
 * The message queue's setting (ui-prefs.mjs queueMode): "one" (each queued message is its
 * own turn, the default) or "together" (one turn when the run ends). Unset reads as null so
 * the server answers with the default; anything else is refused.
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUEUE_CHOICES, UI_DEFAULT_QUEUE, readPrefs, updatePrefs, writePrefs } from "../src/ui-prefs.mjs";

test("queueMode: one by default, together on request, nothing else", () => {
  assert.deepEqual([...QUEUE_CHOICES], ["one", "together"]);
  assert.equal(UI_DEFAULT_QUEUE, "one");
  const file = join(mkdtempSync(join(tmpdir(), "queue-prefs-")), "ui-prefs.json");
  assert.equal(readPrefs(file).queueMode, null);
  const next = updatePrefs(readPrefs(file), { queueMode: "together" });
  writePrefs(file, next);
  assert.equal(readPrefs(file).queueMode, "together");
  assert.throws(() => updatePrefs(next, { queueMode: "all-at-once" }), /queueMode must be one of one, together/);
  assert.equal(updatePrefs(next, { queueMode: null }).queueMode, null);
});
