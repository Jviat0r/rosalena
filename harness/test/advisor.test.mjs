/**
 * advisor (plugins/rosa-advisor): a reviewer model checks each step as it happens.
 *
 *   - off by default; "changes" reviews steps that changed something, "every" any tool step
 *   - the reviewer sees the request, the step's words, and each call with its result
 *   - a flagged problem reaches the model before its next call; "ok" says nothing
 *   - a reviewer that fails says nothing
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "advisor-home-"));
process.env.ROSALENA_HOME = HOME;
const { parseAdvice, readMode, stepDigest, wantsReview } = await import("../plugins/rosa-advisor/plugin.mjs");
const { runAgent } = await import("../src/agent.mjs");
const { loadPlugins } = await import("../src/plugins.mjs");

test("which steps are reviewed in each mode", () => {
  assert.equal(wantsReview("off", ["write_file"]), false);
  assert.equal(wantsReview("changes", ["read_file", "search"]), false);
  assert.equal(wantsReview("changes", ["read_file", "edit_file"]), true);
  assert.equal(wantsReview("changes", ["run_command"]), true);
  assert.equal(wantsReview("every", ["read_file"]), true);
  assert.equal(wantsReview("every", []), false);
});

test("the advice is read from JSON; unreadable is null", () => {
  assert.deepEqual(parseAdvice('{"ok": true}'), { ok: true, issue: "", fix: "" });
  assert.deepEqual(parseAdvice('```json\n{"ok": false, "issue": "the test was deleted", "fix": "restore it"}\n```'), { ok: false, issue: "the test was deleted", fix: "restore it" });
  assert.equal(parseAdvice("looks fine to me"), null);
});

test("the digest is the request, the step's words, and each call with its result", () => {
  const messages = [
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "Editing the parser.", tool_calls: [{ id: "a", function: { name: "edit_file", arguments: '{"path":"p.js"}' } }] },
    { role: "tool", tool_call_id: "a", content: "edited p.js" },
  ];
  const d = stepDigest({ task: "fix the bug", messages });
  assert.match(d, /THE USER'S REQUEST:\nfix the bug/);
  assert.match(d, /Editing the parser\./);
  assert.match(d, /edit_file\(\{"path":"p.js"\}\)\n  result: edited p.js/);
});

test("through the real loop: a flagged step reaches the model; off is silent", async () => {
  const root = mkdtempSync(join(tmpdir(), "advisor-ws-"));
  writeFileSync(join(root, "a.txt"), "a\n");
  const host = await loadPlugins({ root, config: { plugins: { "rosa-process-tracker": { enabled: false } } } });
  const hooks = host.hooks.filter((h) => h.plugin === "rosa-advisor");
  assert.ok(hooks.length, "advisor is bundled");
  assert.equal(readMode(), "off", "off by default");

  const run = async () => {
    const agent = [
      { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "w", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "" }) } }] }, finish_reason: "tool_calls" }], usage: {} },
      { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: {} },
    ];
    let n = 0;
    const bodies = [];
    let reviews = 0;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      if (/You review one step/.test(String(body.messages[0]?.content))) {
        reviews += 1;
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"ok": false, "issue": "a.txt was emptied, which the request did not ask for", "fix": "restore its content"}' } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      bodies.push(body);
      return new Response(JSON.stringify(agent[Math.min(n++, 1)]), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
    };
    await runAgent({ root, task: "tidy a.txt", fetchImpl, stream: false, runs: false, memory: false, snapshots: false, extraHooks: hooks, onEvent: () => {} });
    return { reviews, bodies };
  };

  const quiet = await run();
  assert.equal(quiet.reviews, 0);

  const cmd = host.commands.get("rosa-advisor:mode");
  assert.match(await cmd(["changes"]), /advisor mode: changes/);
  const loud = await run();
  assert.equal(loud.reviews, 1);
  const last = loud.bodies.at(-1).messages.map((m) => String(m.content)).join("\n");
  assert.match(last, /\[advisor\] A reviewer looked at your last step and sees a problem: a\.txt was emptied/);
});
