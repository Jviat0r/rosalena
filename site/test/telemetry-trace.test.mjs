// Run traces (2026-11-09): the app sends a per-step trace with cloud runs at "full". The
// endpoint keeps it in `data` for cloud runs only, the same rule as the words, and caps it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_TRACE, eventRow } from "../functions/api/_lib/telemetry.mjs";

const meta = { install: "3b241101-e2bb-4255-8caf-4136c566a962", version: "0.1.15", now: Date.now() };
const step = (i) => ({ t: "tool", step: i, name: "read_file", ok: true, args: "{\"path\":\"a.js\"}", preview: "x".repeat(150) });

test("a cloud run keeps its trace; a run that is not cloud loses it", () => {
  const cloud = eventRow({ kind: "run", at: new Date().toISOString(), cloud: true, trace: [step(1), step(2)] }, meta);
  assert.equal(JSON.parse(cloud.data).trace.length, 2);
  const local = eventRow({ kind: "run", at: new Date().toISOString(), cloud: false, trace: [step(1)] }, meta);
  assert.equal(local.data === null || !("trace" in JSON.parse(local.data)), true);
});

test("a huge trace is cut, not refused", () => {
  const row = eventRow({ kind: "run", at: new Date().toISOString(), cloud: true, trace: Array.from({ length: 200 }, (_, i) => step(i)) }, meta);
  const data = JSON.parse(row.data);
  assert.equal(data.trace.cut, true);
  assert.ok(data.trace.json.length <= MAX_TRACE);
});
