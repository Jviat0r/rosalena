/**
 * skill-autoload (plugins/rosa-skill-autoload): the right skill reaches a small model without it
 * having to call the `skill` tool - by the request at step 1, or by the files it edits - once
 * per run, and only for skills that ship with the app.
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { DEFAULT_RULES, due, pathsFromCallKeys, skillBody } from "../plugins/rosa-skill-autoload/plugin.mjs";
import { runAgent } from "../src/agent.mjs";
import { loadPlugins } from "../src/plugins.mjs";

const rules = DEFAULT_RULES;

test("UI requests load the taste skill at step 1, other requests do not", () => {
  for (const task of ["Build a landing page for my bakery", "make the dashboard look better", "Add a pricing section", "redesign the settings page", "style the navbar with tailwind"]) {
    assert.ok(due({ rules, task, step: 1 }).includes("frontend-taste"), task);
  }
  for (const task of ["fix the paging bug in the API", "design a database schema for orders", "bump the node version", "why does the build fail"]) {
    assert.ok(!due({ rules, task, step: 1 }).includes("frontend-taste"), task);
  }
  assert.deepEqual(due({ rules, task: "build a landing page", step: 2 }), []);
});

test("editing UI files loads the taste skill; ui-check waits for a few changed files", () => {
  assert.deepEqual(due({ rules, step: 0, paths: ["src/App.tsx"], changes: 1 }), ["frontend-taste"]);
  assert.ok(due({ rules, step: 0, paths: ["src/App.tsx"], changes: 3 }).includes("ui-check"));
  assert.deepEqual(due({ rules, step: 0, paths: ["server/db.ts"], changes: 1 }), []);
});

test("commit-cadence needs the checkpoint tool, and nothing loads twice", () => {
  assert.ok(!due({ rules, step: 0, paths: ["a.ts"], changes: 1 }).includes("commit-cadence"));
  assert.ok(due({ rules, step: 0, paths: ["a.ts"], changes: 1, tools: ["checkpoint"] }).includes("commit-cadence"));
  assert.deepEqual(due({ rules, task: "build a landing page", step: 1, seen: new Set(["frontend-taste", "commit-cadence"]), tools: ["checkpoint"] }), []);
});

test("a change request loads commit-cadence at step 1, before the plan is written; a question does not", () => {
  const tools = ["checkpoint"];
  for (const task of ["Fix the paging bug, add tests, and migrate auth to the new session library", "refactor the settings module", "Update the README and bump the version"]) {
    assert.ok(due({ rules, task, step: 1, tools }).includes("commit-cadence"), task);
  }
  for (const task of ["why does the build fail?", "what does decide() return in plan mode", "explain this repo"]) {
    assert.ok(!due({ rules, task, step: 1, tools }).includes("commit-cadence"), task);
  }
  assert.ok(!due({ rules, task: "refactor the settings module", step: 1 }).includes("commit-cadence"), "not without the checkpoint tool");
});

test("paths come out of the loop's call keys", () => {
  assert.deepEqual(
    pathsFromCallKeys(['write_file({"path":"src/App.tsx","content":"x"})', 'read_file({"path":"a.ts"})', 'edit_file({"path":"C:\\\\web\\\\site.css","old":"a"})']),
    ["src/App.tsx", "C:\\web\\site.css"],
  );
});

test("frontmatter is stripped", () => {
  assert.equal(skillBody("---\nname: x\ndescription: y\n---\n\n# Body\ntext"), "# Body\ntext");
  assert.equal(skillBody("# no frontmatter"), "# no frontmatter");
});

test("every skill it can load ships with the app", () => {
  for (const name of Object.keys(DEFAULT_RULES)) {
    assert.ok(existsSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url)), `skills/${name}/SKILL.md`);
  }
});

test("through the real loop: a UI request gets the taste skill before the first model call", async () => {
  const host = await loadPlugins({ config: { plugins: { "rosa-process-tracker": { enabled: false } } } });
  assert.ok(host.plugins.some((p) => p.id === "rosa-skill-autoload"), "skill-autoload is bundled and enabled");
  const hooks = host.hooks.filter((h) => h.plugin === "rosa-skill-autoload");
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} }), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/test-model" },
    });
  };
  await runAgent({ root: process.cwd(), onEvent: () => {}, task: "Build a landing page for my bakery", fetchImpl, extraHooks: hooks });
  const sent = bodies[0].messages.map((m) => String(m.content ?? "")).join("\n");
  assert.match(sent, /Skill "frontend-taste" applies to this work/);
  assert.match(sent, /NEVER purple, indigo or violet gradients/);
});
