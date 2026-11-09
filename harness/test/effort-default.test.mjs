// What "Default" effort means on each model (2026-11-08): the picker shows it as a hint,
// "Default (medium)". The values are the API's own defaults when no effort is sent.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultEffortOf, fromLocalModels, fromRouter } from "../src/models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "..", "..", "router", "router.config.json"), "utf8"));

test("each Claude model carries the default the API uses when no effort is sent", () => {
  const rows = fromRouter(config);
  const of = (id) => rows.find((row) => row.id === `anthropic/${id}`)?.defaultEffort;
  assert.equal(of("claude-opus-5-5"), "medium");
  assert.equal(of("claude-haiku-5-5"), "medium");
  assert.equal(of("claude-sonnet-5-5"), "high");
  assert.equal(of("claude-fable-5-1"), "high");
});

test("on the local model, Default means thinking off, and it offers only its own levels", () => {
  const [row] = fromLocalModels(["qwen3.8-27b"], { spec: config.providers.local });
  assert.equal(row.defaultEffort, "off");
  assert.deepEqual(row.efforts, ["low", "medium", "high"]);
  // Without the provider's settings the row is as before: no claim either way.
  const [bare] = fromLocalModels(["qwen3.8-27b"]);
  assert.equal(bare.defaultEffort, undefined);
});

test("an unknown default word is ignored, and the model's own row wins over its provider", () => {
  assert.equal(defaultEffortOf({ defaultEffort: "turbo" }, null), null);
  assert.equal(defaultEffortOf({ defaultEffort: "high" }, { defaultEffort: "low" }), "high");
  assert.equal(defaultEffortOf(null, { defaultEffort: "low" }), "low");
  assert.equal(defaultEffortOf(null, null), null);
  // An explicit null on the model (Z.AI's free GLM-4.7 Flash) is "takes no effort", so its
  // provider's "high" does not show as its default.
  assert.equal(defaultEffortOf({ defaultEffort: null }, { defaultEffort: "high" }), null);
  assert.equal(defaultEffortOf({}, { defaultEffort: "high" }), "high");
});
