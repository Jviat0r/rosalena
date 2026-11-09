/**
 * The free-key cards in Settings > Cloud models (data/student-programs.json, served by
 * cloud-setup.mjs studentPrograms()):
 *
 *   - every card has what a person needs to act: a name, what you get, how, an https link
 *   - a card only offers a paste field (provider set) for a provider the router has a key
 *     slot for; one whose credits work elsewhere (Copilot, Kiro) has none
 *   - the four programs UMD DIT named are all there, and a broken file is no cards, not a crash
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KEY_PROVIDERS, studentPrograms } from "../src/cloud-setup.mjs";

test("every program card can be acted on, and links are https", () => {
  const { checked, programs } = studentPrograms();
  assert.match(checked, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(programs.length >= 6);
  const ids = new Set();
  for (const p of programs) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    for (const field of ["name", "by", "what", "how", "url"]) assert.ok(String(p[field] ?? "").trim().length > 2, `${p.id} has no ${field}`);
    assert.match(p.url, /^https:\/\//, `${p.id} links over https`);
    assert.ok(["student", "anyone"].includes(p.group), `${p.id} group`);
  }
});

test("a paste field only for keys the router can take; Copilot and Kiro say they don't fit", () => {
  const { programs } = studentPrograms();
  const slots = new Set(KEY_PROVIDERS.map((p) => p.id));
  for (const p of programs) if (p.provider) assert.ok(slots.has(p.provider), `${p.id} saves to ${p.provider}, which the router has no slot for`);
  const by = Object.fromEntries(programs.map((p) => [p.id, p]));
  assert.equal(by["claude-builder-club"].provider, "anthropic");
  assert.equal(by["openai-student"].provider, "openai");
  assert.equal(by["github-copilot-student"].provider, null);
  assert.equal(by["kiro-students"].provider, null);
  assert.match(by["kiro-students"].how, /not through an API key/);
});

test("an unknown provider is shown without a paste field, and a broken file is no cards", () => {
  const dir = mkdtempSync(join(tmpdir(), "programs-"));
  const file = join(dir, "p.json");
  writeFileSync(file, JSON.stringify({ checked: "2026-11-03", programs: [{ id: "x", provider: "made-up" }] }));
  assert.equal(studentPrograms({ path: file }).programs[0].provider, null);
  writeFileSync(file, "{ not json");
  assert.deepEqual(studentPrograms({ path: file }), { checked: null, programs: [] });
});
