/**
 * Delegated workers at scale (src/worktrees.mjs, the delegate tool in agent.mjs):
 *
 *   - a worker's worktree starts from the workspace as it is now: uncommitted edits and
 *     untracked files included, installed dependencies linked in
 *   - its changes are applied back when it finishes; the worktree and branch are removed,
 *     and the real node_modules survives the cleanup
 *   - a change that no longer applies is kept on its branch, not forced
 *   - the person's own branch, index and stash are untouched
 *   - through the real loop: several tasks run at once, each in its own worktree, and both
 *     results land in the workspace
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkerTree, mapLimit } from "../src/worktrees.mjs";
import { runAgent } from "../src/agent.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "wt-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("config", "core.autocrlf", "false");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "app.js"), "export const a = 1;\n");
  g("add", ".gitignore", "app.js");
  g("commit", "-q", "-m", "init");
  return { dir, g };
}

test("a worker starts from the work in progress, and its changes come back", () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2; // uncommitted\n");
  writeFileSync(join(dir, "notes.md"), "untracked notes\n");
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 'dep';\n");
  const headBefore = g("rev-parse", "HEAD");
  const tree = createWorkerTree(dir, "t1");
  assert.equal(tree.error, undefined, tree.error);
  assert.equal(readFileSync(join(tree.path, "app.js"), "utf8"), "export const a = 2; // uncommitted\n");
  assert.equal(readFileSync(join(tree.path, "notes.md"), "utf8"), "untracked notes\n");
  assert.equal(readFileSync(join(tree.path, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 'dep';\n", "dependencies are linked in");

  writeFileSync(join(tree.path, "app.js"), "export const a = 3;\n");
  writeFileSync(join(tree.path, "new.js"), "export const n = 1;\n");
  const out = tree.finish();
  assert.equal(out.applied, true, out.note);
  assert.deepEqual(out.files.sort(), ["app.js", "new.js"]);
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "export const a = 3;\n");
  assert.equal(readFileSync(join(dir, "new.js"), "utf8"), "export const n = 1;\n");
  assert.equal(readFileSync(join(dir, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 'dep';\n", "the real node_modules survived the cleanup");
  assert.equal(existsSync(tree.path), false, "the worktree is gone");
  assert.equal(g("branch", "--list", "rosalena/*"), "", "the branch is gone");
  assert.equal(g("rev-parse", "HEAD"), headBefore, "the person's branch did not move");
  assert.equal(g("stash", "list"), "", "the stash was not touched");
  assert.equal(g("worktree", "list").trim().split("\n").length, 1);
});

test("a change that no longer applies is kept on its branch", () => {
  const { dir, g } = repo();
  const one = createWorkerTree(dir, "c1");
  const two = createWorkerTree(dir, "c2");
  writeFileSync(join(one.path, "app.js"), "export const a = 'one';\n");
  writeFileSync(join(two.path, "app.js"), "export const a = 'two';\n");
  assert.equal(one.finish().applied, true);
  const second = two.finish();
  assert.equal(second.applied, false);
  assert.equal(second.branch, "rosalena/worker-c2");
  assert.match(second.note, /kept on branch rosalena\/worker-c2/);
  assert.equal(readFileSync(join(dir, "app.js"), "utf8"), "export const a = 'one';\n", "the workspace keeps the first");
  assert.match(g("branch", "--list", "rosalena/*"), /rosalena\/worker-c2/);
});

test("outside a git repository there are no worktrees, and it says why", () => {
  const plain = mkdtempSync(join(tmpdir(), "wt-plain-"));
  assert.match(createWorkerTree(plain, "x").error, /not a git repository/);
});

test("mapLimit runs at most N at once and keeps the order", async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, ms));
    live -= 1;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
});

const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });
const call = (name, args, id) => ({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: {} });

test("through the real loop: two tasks run at once in their own worktrees and both land", async () => {
  const { dir } = repo();
  const started = [];
  let concurrent = 0;
  let peak = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const firstUser = String(body.messages.find((m) => m.role === "user")?.content ?? "");
    const hasResult = body.messages.some((m) => m.role === "tool");
    let payload;
    if (firstUser === "parent") {
      payload = hasResult ? say("both done") : call("delegate", { tasks: ["make a.txt", "make b.txt"] }, "d");
    } else {
      const name = firstUser.endsWith("a.txt") ? "a.txt" : "b.txt";
      if (!hasResult) {
        started.push(name);
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 150));
        concurrent -= 1;
        payload = call("write_file", { path: name, content: `${name}\n` }, `w-${name}`);
      } else payload = say(`wrote ${name}`);
    }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  const events = [];
  const result = await runAgent({ root: dir, task: "parent", fetchImpl, stream: false, runs: false, memory: false, snapshots: false, onEvent: (e) => events.push(e) });
  assert.equal(result.answer, "both done");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a.txt\n");
  assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "b.txt\n");
  assert.equal(peak, 2, "the two workers ran at the same time");
  assert.equal(events.filter((e) => e.type === "worker_merged" && e.applied).length, 2);
  const toolResult = result.messages.find((m) => m.role === "tool" && String(m.content).includes("worker 1:"));
  assert.match(String(toolResult?.content), /worker 2: wrote b\.txt/);
});
