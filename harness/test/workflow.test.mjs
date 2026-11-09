/**
 * Access modes and approvals, plan mode, undo per step, the after-edit check, and slash
 * commands.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import { decide, outsidePaths } from "../src/permissions.mjs";
import { listChanges, undoFrom } from "../src/undo.mjs";
import { afterEdit } from "../src/edit-check.mjs";
import { expandCommand, loadCommands, parseCommandFile } from "../src/commands.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-workflow-"));
writeFileSync(join(WS, "a.txt"), "original\n");

const call = (name, args, id = `c-${Math.random()}`) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolReply = (...calls) => ({ choices: [{ message: { role: "assistant", content: "", tool_calls: calls } }], usage: {} });
const say = (content) => ({ choices: [{ message: { role: "assistant", content } }], usage: {} });
function scripted(replies) {
  let n = 0;
  return async () => new Response(JSON.stringify(replies[Math.min(n++, replies.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
}

test("access modes: workspace asks outside, read refuses changes, full allows, rules ask first", () => {
  const ws = (c) => decide({ call: c, mode: "workspace", root: WS });
  assert.equal(ws(call("write_file", { path: "x.txt" })).action, "allow");
  assert.equal(ws(call("run_command", { command: "npm test" })).action, "allow");
  const outside = process.platform === "win32" ? "C:\\Windows\\x" : "/etc/x";
  assert.equal(ws(call("run_command", { command: `cp a.txt ${outside}` })).action, "ask");
  assert.equal(ws(call("wifi_connect", { ssid: "x" })).action, "ask");
  assert.equal(decide({ call: call("edit_file", { path: "a" }), mode: "read", root: WS }).action, "deny");
  assert.equal(decide({ call: call("run_command", { command: "dir /b" }), mode: "read", root: WS }).action, "allow");
  assert.equal(decide({ call: call("run_command", { command: "echo x > y.txt" }), mode: "read", root: WS }).action, "deny");
  assert.equal(decide({ call: call("wifi_connect", {}), mode: "full", root: WS }).action, "allow");
  assert.equal(decide({ call: call("run_command", { command: "npx thing@latest" }), mode: "full", root: WS }).action, "ask");
  assert.equal(decide({ call: call("read_file", { path: "config/.env" }), mode: "full", root: WS }).action, "ask");
  assert.deepEqual(outsidePaths("type ..\\up.txt && dir sub\\x", WS, "win32"), ["..\\up.txt"]);
  assert.deepEqual(outsidePaths("dir /b /s", WS, "win32"), [], "a Windows switch is not a path");
  if (process.platform !== "win32") assert.deepEqual(outsidePaths("cp a /etc/hosts", WS), ["/etc/hosts"]);
});

test("an ask waits for the approver; deny and always are honoured", async () => {
  const asked = [];
  const answers = ["deny", "always"];
  const approve = async (request) => {
    asked.push(request);
    return { decision: answers.shift() ?? "allow" };
  };
  const fetchImpl = scripted([
    toolReply(call("run_command", { command: "echo one > ..\\outside1.txt" })),
    toolReply(call("run_command", { command: "echo two > ..\\outside2.txt" })),
    toolReply(call("run_command", { command: "echo three > ..\\outside3.txt" })),
    say("done"),
  ]);
  const result = await runAgent({ root: WS, task: "write outside", fetchImpl, memory: false, accessMode: "workspace", approve });
  assert.equal(result.answer, "done");
  assert.equal(asked.length, 2, "the third call was covered by 'always'");
  const tools = result.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(tools[0], /the user declined/);
});

test("plan mode: writes are refused until the plan is approved, then they work", async () => {
  const approve = async (request) => (request.kind === "plan" ? { decision: "allow" } : { decision: "deny" });
  const events = [];
  const fetchImpl = scripted([
    toolReply(call("write_file", { path: "planned.txt", content: "too early" })),
    toolReply(call("exit_plan_mode", { plan: "1. write planned.txt" })),
    toolReply(call("write_file", { path: "planned.txt", content: "after approval" })),
    say("done"),
  ]);
  const result = await runAgent({ root: WS, task: "make a file", fetchImpl, memory: false, planMode: true, approve, onEvent: (e) => events.push(e) });
  assert.equal(result.answer, "done");
  const tools = result.messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.match(tools[0], /plan mode is read-only/);
  assert.match(tools[1], /approved the plan/);
  assert.equal(readFileSync(join(WS, "planned.txt"), "utf8"), "after approval");
  assert.ok(events.some((e) => e.type === "plan_approved"));
});

test("undo per step puts files back and removes the ones the run created", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-undo-"));
  writeFileSync(join(root, "keep.txt"), "v1\n");
  const fetchImpl = scripted([
    toolReply(call("edit_file", { path: "keep.txt", old_text: "v1", new_text: "v2" })),
    toolReply(call("write_file", { path: "new.txt", content: "fresh" }), call("edit_file", { path: "keep.txt", old_text: "v2", new_text: "v3" })),
    say("done"),
  ]);
  const result = await runAgent({ root, task: "edit", fetchImpl, memory: false });
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "v3\n");
  const changes = listChanges(result.run);
  assert.deepEqual(changes.steps.map((s) => s.step), [1, 2]);
  const second = undoFrom(result.run, 2);
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "v2\n", "undo from step 2 keeps step 1");
  assert.ok(!existsSync(join(root, "new.txt")), "the file step 2 created is gone");
  assert.equal(second.removed.length, 1);
  undoFrom(result.run, 1);
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "v1\n");
});

test("the after-edit check catches a syntax error and broken JSON quickly", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-check-"));
  writeFileSync(join(dir, "bad.mjs"), "export const x = ;\n");
  writeFileSync(join(dir, "good.mjs"), "export const x = 1;\n");
  writeFileSync(join(dir, "bad.json"), "{ \"a\": }");
  const started = Date.now();
  assert.match(afterEdit(join(dir, "bad.mjs"), dir), /SYNTAX ERROR/);
  assert.match(afterEdit(join(dir, "good.mjs"), dir), /syntax ok/);
  assert.match(afterEdit(join(dir, "bad.json"), dir), /INVALID JSON/);
  assert.ok(Date.now() - started < 5000, "the checks are quick");
});

test("slash commands: built-ins, files from the command folders, and $ARGUMENTS", () => {
  const root = mkdtempSync(join(tmpdir(), "harness-cmd-"));
  mkdirSync(join(root, ".rosalena", "commands"), { recursive: true });
  writeFileSync(join(root, ".rosalena", "commands", "deploy.md"), "---\ndescription: Ship it\nagent: plan\n---\nDeploy $1 to $2. Notes: $ARGUMENTS\n");
  const commands = loadCommands(root, { home: join(root, "nohome") });
  const names = commands.map((c) => c.name);
  for (const builtIn of ["plan", "goal", "init", "review", "test", "commit", "undo", "clear", "help"]) assert.ok(names.includes(builtIn), builtIn);
  const deploy = commands.find((c) => c.name === "deploy");
  assert.equal(deploy.description, "Ship it");
  assert.equal(deploy.plan, true);
  assert.equal(expandCommand(deploy.template, "site prod"), "Deploy site to prod. Notes: site prod");
  assert.equal(expandCommand("Explain the code.", "src/a.mjs"), "Explain the code.\n\nsrc/a.mjs");
  assert.deepEqual(parseCommandFile("no front matter").meta, {});
});
