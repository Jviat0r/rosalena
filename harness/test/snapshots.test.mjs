/**
 * Undo that covers shell edits (src/snapshots.mjs + undo.mjs):
 *
 *   - a snapshot pair records exactly what changed between before and after (A/M/D), and
 *     restoring puts the old bytes back and removes what was created
 *   - .env files, node_modules and files over 10 MiB are never snapshotted
 *   - the project's own git repository is untouched: same status, same refs, no stash
 *   - through the real loop: a step whose command changes files is snapshotted, and undo
 *     from step 1 brings back the original even when a file tool changed the same file later
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "snap-home-"));
process.env.ROSALENA_HOME = HOME;
const { createSnapshots, restoreBefore, shadowDir, sweepShadows } = await import("../src/snapshots.mjs");
const { listChanges, undoFrom } = await import("../src/undo.mjs");
const { runAgent } = await import("../src/agent.mjs");

const ws = () => mkdtempSync(join(tmpdir(), "snap-ws-"));

test("a snapshot pair records what changed, and restoring undoes it", () => {
  const root = ws();
  writeFileSync(join(root, "keep.txt"), "original\n");
  writeFileSync(join(root, "doomed.txt"), "doomed\n");
  const dir = join(HOME, "undo-a");
  const snaps = createSnapshots({ root, runId: "run-a", dir });
  const before = snaps.before(1);
  assert.ok(before.commit, JSON.stringify(before));
  writeFileSync(join(root, "keep.txt"), "changed by a command\n");
  writeFileSync(join(root, "new.txt"), "created\n");
  execFileSync(process.execPath, ["-e", "require('fs').unlinkSync('doomed.txt')"], { cwd: root });
  const after = snaps.after(1, before);
  const byPath = Object.fromEntries(after.files.map((f) => [f.path, f.status]));
  assert.deepEqual(byPath, { "doomed.txt": "D", "keep.txt": "M", "new.txt": "A" });

  const out = restoreBefore({ gitDir: snaps.gitDir, root, before: before.commit, files: after.files });
  assert.equal(readFileSync(join(root, "keep.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(root, "doomed.txt"), "utf8"), "doomed\n");
  assert.equal(existsSync(join(root, "new.txt")), false);
  assert.equal(out.failed.length, 0);
});

test("bytes come back exactly: CRLF and binary survive a restore", () => {
  const root = ws();
  const crlf = "a\r\nb\r\n";
  const bin = Buffer.from([0, 1, 2, 255, 13, 10]);
  writeFileSync(join(root, "win.txt"), crlf);
  writeFileSync(join(root, "blob.bin"), bin);
  const snaps = createSnapshots({ root, runId: "run-bytes" });
  const before = snaps.before(1);
  writeFileSync(join(root, "win.txt"), "changed");
  writeFileSync(join(root, "blob.bin"), "x");
  const after = snaps.after(1, before);
  restoreBefore({ gitDir: snaps.gitDir, root, before: before.commit, files: after.files });
  assert.equal(readFileSync(join(root, "win.txt"), "utf8"), crlf);
  assert.deepEqual(readFileSync(join(root, "blob.bin")), bin);
});

test(".env, node_modules and huge files are never snapshotted", () => {
  const root = ws();
  mkdirSync(join(root, "node_modules", "x"), { recursive: true });
  const snaps = createSnapshots({ root, runId: "run-skip" });
  const before = snaps.before(1);
  writeFileSync(join(root, ".env"), "TOKEN=secret\n");
  writeFileSync(join(root, ".env.example"), "TOKEN=\n");
  writeFileSync(join(root, "node_modules", "x", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, "big.dat"), Buffer.alloc(11 * 1024 * 1024));
  writeFileSync(join(root, "ok.txt"), "ok\n");
  const after = snaps.after(1, before);
  assert.deepEqual(after.files.map((f) => f.path).sort(), [".env.example", "ok.txt"]);
});

test("the project's own git repository is not touched", () => {
  const root = ws();
  const g = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  writeFileSync(join(root, "a.txt"), "a\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "init");
  writeFileSync(join(root, "a.txt"), "a changed\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  const status = g("status", "--porcelain");
  const refs = g("for-each-ref");
  const snaps = createSnapshots({ root, runId: "run-git" });
  const before = snaps.before(1);
  writeFileSync(join(root, "c.txt"), "c\n");
  snaps.after(1, before);
  assert.equal(g("status", "--porcelain"), `${status}?? c.txt\n`);
  assert.equal(g("for-each-ref"), refs);
  assert.equal(g("stash", "list"), "");
  assert.notEqual(snaps.gitDir, join(root, ".git"));
  assert.ok(snaps.gitDir.startsWith(HOME));
});

test("a shadow repository whose workspace is gone is swept", () => {
  const root = ws();
  const snaps = createSnapshots({ root, runId: "run-sweep" });
  snaps.before(1);
  const gone = join(HOME, "snapshots", "0000000000000000.git");
  mkdirSync(join(gone, "index-runs"), { recursive: true });
  writeFileSync(join(gone, "workspace"), join(tmpdir(), "definitely-not-here-xyz"));
  const removed = sweepShadows(join(HOME, "snapshots"));
  assert.ok(removed.includes(gone));
  assert.ok(existsSync(shadowDir(root, join(HOME, "snapshots"))), "a live one is kept");
});

const useTool = (name, args, id) => ({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: {} });
const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });

test("through the real loop: undo restores what a command changed, even after a later file-tool edit", async () => {
  const root = ws();
  writeFileSync(join(root, "app.txt"), "v1\n");
  const script = [
    useTool("run_command", { command: "node -e \"require('fs').writeFileSync('app.txt','v2 from a command\\n');require('fs').writeFileSync('made.txt','new\\n')\"" }, "a"),
    useTool("write_file", { path: "app.txt", content: "v3 from write_file\n" }, "b"),
    say("done"),
  ];
  let n = 0;
  const fetchImpl = async () => new Response(JSON.stringify(script[Math.min(n++, 2)]), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  const events = [];
  const result = await runAgent({ root, task: "change things", fetchImpl, stream: false, memory: false, onEvent: (e) => events.push(e) });
  assert.equal(readFileSync(join(root, "app.txt"), "utf8"), "v3 from write_file\n");
  assert.ok(events.some((e) => e.type === "snapshot" && e.count === 2), JSON.stringify(events.filter((e) => e.type.startsWith("snapshot"))));

  const listed = listChanges(result.run);
  assert.deepEqual(listed.steps.map((s) => s.step), [1, 2]);
  assert.ok(listed.steps[0].files.some((f) => f.endsWith("made.txt")));

  const out = undoFrom(result.run, 1);
  assert.equal(readFileSync(join(root, "app.txt"), "utf8"), "v1\n", "back to before the command, not to before write_file");
  assert.equal(existsSync(join(root, "made.txt")), false);
  assert.match(out.note, /restored from snapshots/);
});
