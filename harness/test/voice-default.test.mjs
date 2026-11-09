/**
 * Voice typing as a default feature (voice-runner.mjs, data/media-models.json, the mic):
 *
 *   - quantized English models (ggml-base.en-q5_1.bin) are English-only, so whisper.cpp is
 *     told "-l en" instead of guessing the language (which costs accuracy)
 *   - the catalog names exactly one dictation default, small, with a pinned size and sha256
 *   - with no model on the PC the status says how to set it up, not "go to the Models page"
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { voiceStatus, whisperArgs, whisperModels, whisperModelsDir } from "../src/voice-runner.mjs";
import { loadMediaCatalog } from "../src/model-downloads.mjs";

test("quantized .en models are English-only, multilingual ones are not", () => {
  const home = mkdtempSync(join(tmpdir(), "voice-def-"));
  mkdirSync(whisperModelsDir(home), { recursive: true });
  for (const name of ["ggml-base.en-q5_1.bin", "ggml-small.en.bin", "ggml-large-v3-turbo-q5_0.bin"]) writeFileSync(join(whisperModelsDir(home), name), "x");
  const byName = Object.fromEntries(whisperModels(home).map((m) => [m.name, m]));
  assert.equal(byName["ggml-base.en-q5_1.bin"].english, true);
  assert.equal(byName["ggml-small.en.bin"].english, true);
  assert.equal(byName["ggml-large-v3-turbo-q5_0.bin"].english, false);
  assert.deepEqual(whisperArgs({ model: byName["ggml-base.en-q5_1.bin"], wavPath: "a.wav", threads: 2 }).slice(4, 8), ["-t", "2", "-l", "en"]);
});

test("the catalog has one dictation default: small, pinned and checked", () => {
  const defaults = loadMediaCatalog().models.filter((m) => m.dictationDefault);
  assert.equal(defaults.length, 1);
  const [d] = defaults;
  assert.equal(d.kind, "voice");
  assert.equal(d.folder, "whisper");
  assert.equal(d.id, "whisper-small.en-q5_1", "the measured pick (2026-11-03 comparison)");
  assert.ok(d.file.bytes < 200 * 1024 * 1024, "small enough to fetch on the first click");
  assert.match(d.file.sha256, /^[0-9a-f]{64}$/);
  assert.match(d.file.url, /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\//);
});

test("with no model, the status says the mic sets it up", () => {
  const empty = mkdtempSync(join(tmpdir(), "voice-none-"));
  const s = voiceStatus(empty);
  assert.equal(s.code, "no-model");
  assert.match(s.why, /click the mic/);
});
