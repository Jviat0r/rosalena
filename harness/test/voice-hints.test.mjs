/**
 * Dictation hints (src/voice-hints.mjs): the project's own words go to whisper as a prompt.
 *
 *   - declared names come first, code-shaped words next, file names last
 *   - everyday words, keywords, ALL_CAPS constants and local variables are left out
 *   - recently changed files count double
 *   - the prompt is capped and ends with what is already typed
 *   - whisper.cpp gets it as --prompt
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dictationPrompt, projectVocabulary, vocabulary } from "../src/voice-hints.mjs";
import { whisperArgs } from "../src/voice-runner.mjs";

test("declared names first; everyday words, keywords, constants and locals left out", () => {
  const terms = vocabulary([
    { path: "src/utils.js", text: "export function slugify(text) {\n  const out = text.trim();\n  return out;\n}\nconst MAX_LEN = 80;\nexport class RateLimiter {}\nfunction render() {}\n" },
    { path: "src/authMiddleware.ts", text: "export const authMiddleware = () => tokenStore.check();\n" },
  ]);
  assert.deepEqual(terms.slice(0, 3).sort(), ["RateLimiter", "authMiddleware", "slugify"]);
  assert.ok(terms.includes("tokenStore"), "a code-shaped word that is used, not declared");
  for (const left of ["out", "text", "render", "MAX_LEN", "function", "const", "utils"]) assert.ok(!terms.includes(left), left);
});

test("recently changed files count double", () => {
  const files = [
    { path: "new.js", text: "export function fetchInvoice() {}" },
    { path: "old.js", text: "export function legacyThing() {}" },
  ];
  assert.equal(vocabulary(files, { recent: 1 })[0], "fetchInvoice");
});

test("the prompt is the project's words then what is already typed, capped", () => {
  const root = mkdtempSync(join(tmpdir(), "hints-"));
  writeFileSync(join(root, "a.js"), "export function slugify() {}\n");
  const old = join(root, "b.js");
  writeFileSync(old, "export function parseDuration() {}\n");
  utimesSync(old, new Date(2000, 0, 1), new Date(2000, 0, 1));
  assert.deepEqual(projectVocabulary(root).slice(0, 2).sort(), ["parseDuration", "slugify"]);
  const p = dictationPrompt({ root, context: "Please fix the" });
  assert.match(p, /^Words in this project: (slugify, parseDuration|parseDuration, slugify)\. Please fix the$/);
  assert.ok(dictationPrompt({ root, context: "x".repeat(5000) }).length <= 700);
  assert.equal(dictationPrompt({}), "");
});

test("whisper.cpp gets the prompt as --prompt, and nothing when there is none", () => {
  const model = { path: "m.bin", english: true };
  assert.deepEqual(whisperArgs({ model, wavPath: "a.wav", threads: 2, prompt: "Words: slugify." }).slice(-2), ["--prompt", "Words: slugify."]);
  assert.ok(!whisperArgs({ model, wavPath: "a.wav", threads: 2 }).includes("--prompt"));
});
