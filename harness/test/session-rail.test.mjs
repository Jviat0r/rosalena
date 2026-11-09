/**
 * The session rail (ui/session-rail.mjs + src/session-rail.mjs):
 *
 *   - the pure parts the page draws from: the saved placement, the context reading, the
 *     outputs list folded from run events, the changes totals, background tasks and the
 *     MCP summary
 *   - the server half: line counts from the undo journals (file tools and shell snapshots),
 *     measured against each file as it was before the chat first touched it
 *   - Claude Code chats get a context reading too
 *   - the route and the two static files the page loads
 *
 *   node --test
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "rail-home-"));
process.env.ROSALENA_HOME = HOME;

const rail = await import("../ui/session-rail.mjs");
const { chatChanges, gitBranch, lineDelta, splitLines } = await import("../src/session-rail.mjs");
const { createJournal, undoRoot } = await import("../src/undo.mjs");
const { createSnapshots } = await import("../src/snapshots.mjs");
const { createTranslator } = await import("../src/claude-engine.mjs");

const ws = () => mkdtempSync(join(tmpdir(), "rail-ws-"));
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// ------------------------------------------------------------------ placement

test("rail prefs: docked and shown by default, anything unreadable falls back", () => {
  assert.deepEqual(rail.readRailPrefs(""), { mode: "docked", shown: true, folded: {} });
  assert.deepEqual(rail.readRailPrefs("{not json"), { mode: "docked", shown: true, folded: {} });
  assert.deepEqual(rail.readRailPrefs(JSON.stringify({ mode: "overlay", shown: false, folded: { tasks: true, "bad key!": true, env: "yes" } })), {
    mode: "overlay",
    shown: false,
    folded: { tasks: true },
  });
  assert.equal(rail.readRailPrefs({ mode: "sideways" }).mode, "docked");
});

// ------------------------------------------------------------------ context

test("context %: the meter's own percent, else used over window, clamped for the bar", () => {
  const r = rail.contextReading({ used: 32_000, window: 128_000, percent: 25.4, parts: {} });
  assert.equal(r.percent, 25);
  assert.equal(r.measured, true);
  assert.equal(r.fraction, 0.25);
  assert.equal(r.tone, "");
  assert.equal(rail.contextReading({ used: 50, window: 200 }).percent, 25);
  // Over the window (a request that overflowed): the bar stops at full, the number does not lie.
  const over = rail.contextReading({ used: 300, window: 200 });
  assert.equal(over.fraction, 1);
  assert.equal(over.percent, 150);
  assert.equal(over.tone, "bad");
});

test("context %: the threshold colours it like the composer gauge", () => {
  assert.equal(rail.contextReading({ used: 90, window: 200, threshold: 100 }).tone, "warn");
  assert.equal(rail.contextReading({ used: 101, window: 200, threshold: 100 }).tone, "bad");
  assert.equal(rail.contextReading({ used: 50, window: 200, threshold: 100 }).tone, "");
  assert.equal(rail.contextReading({ used: 160, window: 200 }).tone, "warn");
});

test("context %: no reading shows the next window unmeasured, and no window is null", () => {
  assert.deepEqual(rail.contextReading(null, 64_000), { measured: false, used: 0, window: 64_000, percent: 0, fraction: 0, tone: "", threshold: null });
  assert.equal(rail.contextReading({ window: null, used: 0 }, 0), null);
  assert.equal(rail.contextReading(null), null);
});

test("idle window: Claude Code rows use their contextMax, capped at 200K unless a bigger window is set", () => {
  const opus = { id: "claude-code/opus", source: "claude-code", contextMax: 1_048_576 };
  assert.equal(rail.idleWindow({ row: opus, menuWindow: 64_000 }), 200_000);
  assert.equal(rail.idleWindow({ row: opus, menuWindow: 1_000_000 }), 1_048_576);
  assert.equal(rail.idleWindow({ row: { id: "claude-code/haiku", source: "claude-code", contextMax: 200_000 }, menuWindow: 1_000_000 }), 200_000);
  assert.equal(rail.idleWindow({ row: { id: "local/qwen", contextMax: 32_768 }, menuWindow: 65_536 }), 32_768);
  assert.equal(rail.idleWindow({ row: null, menuWindow: 65_536 }), 65_536);
  assert.equal(rail.idleWindow({}), 0);
});

// ------------------------------------------------------------------ changes totals

test("changes totals: lines summed, files without a count listed apart", () => {
  const t = rail.changesTotals({
    files: [
      { path: "a", added: 10, removed: 2, status: "M" },
      { path: "b", added: 3, removed: 0, status: "A" },
      { path: "c", added: null, removed: null, binary: true, status: "M" },
    ],
  });
  assert.deepEqual(t, { added: 13, removed: 2, files: 3, uncounted: 1 });
  assert.deepEqual(rail.changesTotals(null), { added: 0, removed: 0, files: 0, uncounted: 0 });
});

test("line delta: counts the way git diff --numstat does", () => {
  assert.deepEqual(lineDelta("", "a\nb\n"), { added: 2, removed: 0 });
  assert.deepEqual(lineDelta("a\nb\n", ""), { added: 0, removed: 2 });
  assert.deepEqual(lineDelta("a\nb\nc\n", "a\nB\nc\n"), { added: 1, removed: 1 });
  assert.deepEqual(lineDelta("a\nb\nc\nd\n", "a\nc\nd\ne\n"), { added: 1, removed: 1 });
  assert.deepEqual(lineDelta("same\r\nlines\r\n", "same\nlines\n"), { added: 0, removed: 0 });
  assert.deepEqual(splitLines("x\n"), ["x"]);
  // A big rewrite still answers (and the result is consistent).
  const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const after = Array.from({ length: 3000 }, (_, i) => `other ${i}`).join("\n");
  assert.deepEqual(lineDelta(before, after), { added: 3000, removed: 3000 });
});

test("chat changes: every run's journal, against each file before the chat first touched it", () => {
  const root = ws();
  const edited = join(root, "edited.txt");
  const made = join(root, "made.txt");
  const reverted = join(root, "reverted.txt");
  const doomed = join(root, "doomed.txt");
  writeFileSync(edited, "one\ntwo\nthree\n");
  writeFileSync(reverted, "keep me\n");
  writeFileSync(doomed, "a\nb\n");

  // Turn 1: edits one file, creates another, changes one it later puts back.
  const j1 = createJournal({ dir: join(undoRoot(), "turn-1") });
  j1.step = 1;
  j1.record(edited);
  writeFileSync(edited, "one\nTWO\nthree\nfour\n");
  j1.record(made);
  writeFileSync(made, "new\nfile\n");
  j1.record(reverted);
  writeFileSync(reverted, "changed\n");
  // Turn 2: a later edit of the same file, a revert, a delete.
  const j2 = createJournal({ dir: join(undoRoot(), "turn-2") });
  j2.step = 1;
  j2.record(edited);
  writeFileSync(edited, "one\nTWO\nthree\nfour\nfive\n");
  j2.record(reverted);
  writeFileSync(reverted, "keep me\n");
  j2.record(doomed);
  unlinkSync(doomed);

  const out = chatChanges({ runIds: ["turn-1", "turn-2", "never-ran"] });
  const by = Object.fromEntries(out.files.map((f) => [f.path, f]));
  // Measured from turn 1's copy, not turn 2's: two lines in, one changed.
  assert.equal(by[edited].added, 3);
  assert.equal(by[edited].removed, 1);
  assert.equal(by[edited].status, "M");
  assert.deepEqual([by[made].status, by[made].added, by[made].removed], ["A", 2, 0]);
  assert.deepEqual([by[doomed].status, by[doomed].added, by[doomed].removed], ["D", 0, 2]);
  assert.equal(by[reverted], undefined, "a file put back as it was is not a change");
  assert.equal(out.added, 5);
  assert.equal(out.removed, 3);
  assert.deepEqual(rail.changesTotals(out), { added: 5, removed: 3, files: 3, uncounted: 0 });
});

test("chat changes: what a shell command changed counts too (snapshot pairs)", { skip: !hasGit && "git is not installed" }, () => {
  const root = ws();
  writeFileSync(join(root, "app.js"), "let a = 1;\nlet b = 2;\n");
  const dir = join(undoRoot(), "shell-run");
  const snaps = createSnapshots({ root, runId: "shell-run", dir });
  const before = snaps.before(1);
  assert.ok(before.commit, JSON.stringify(before));
  writeFileSync(join(root, "app.js"), "let a = 1;\nlet b = 3;\nlet c = 4;\n");
  writeFileSync(join(root, "built.txt"), "out\n");
  snaps.after(1, before);
  const out = chatChanges({ runIds: ["shell-run"] });
  const by = Object.fromEntries(out.files.map((f) => [f.path, f]));
  assert.deepEqual([by[join(root, "app.js")].added, by[join(root, "app.js")].removed], [2, 1]);
  assert.equal(by[join(root, "built.txt")].status, "A");
  assert.equal(out.added, 3);
});

test("git branch: the branch name, or null outside a repository", { skip: !hasGit && "git is not installed" }, () => {
  const repo = ws();
  execFileSync("git", ["init", "-q", "-b", "rail-test", repo]);
  assert.deepEqual(gitBranch(repo), { branch: "rail-test" });
  const plain = mkdtempSync(join(tmpdir(), "rail-plain-"));
  // A temp folder is outside any repository unless the temp dir itself is in one.
  const answer = gitBranch(plain);
  assert.ok(answer === null || typeof answer.branch === "string" || typeof answer.detached === "string");
  assert.equal(gitBranch(""), null);
});

// ------------------------------------------------------------------ outputs

test("paths: a tool's relative path resolves against the run's folder, either slash", () => {
  assert.equal(rail.resolvePath("D:\\proj", "src/a.js"), "D:\\proj\\src\\a.js");
  assert.equal(rail.resolvePath("D:\\proj\\", "./src\\..\\b.js"), "D:\\proj\\b.js");
  assert.equal(rail.resolvePath("/home/me/proj", "src/a.js"), "/home/me/proj/src/a.js");
  assert.equal(rail.resolvePath("D:\\proj", "C:/other/x.txt"), "C:\\other\\x.txt");
  assert.equal(rail.resolvePath("", "a.txt"), "a.txt");
});

test("outputs list: newest first, moves and deletes followed, a replay changes nothing", () => {
  const events = [
    { type: "run", id: "r1", root: "D:\\proj", task: "build it" },
    { type: "tool", name: "write_file", ok: true, args: { path: "notes.md", content: "x" } },
    { type: "tool", name: "write_file", ok: true, args: { path: "src/app.js", content: "y" } },
    { type: "tool", name: "edit_file", ok: false, args: { path: "src/broken.js" } },
    { type: "tool", name: "read_file", ok: true, args: { path: "README.md" } },
    { type: "tool", name: "write_file", ok: true, args: { path: "tmp.txt", content: "z" } },
    { type: "tool", name: "delete_file", ok: true, args: { path: "tmp.txt" } },
    { type: "tool", name: "move_file", ok: true, args: { from: "notes.md", to: "docs/notes.md" } },
    { type: "run", id: "s1", sub: true, root: "D:\\proj-worker", task: "a worker" },
    { type: "tool", name: "write_file", ok: true, sub: true, args: { path: "w.txt", content: "" } },
    { type: "present", path: "src/app.js", note: "the app" },
  ];
  const model = rail.emptyRailModel();
  for (const e of events) rail.foldEvent(model, e);
  const changes = { files: [{ path: "D:\\proj\\src\\app.js", status: "A", added: 1, removed: 0 }] };
  const list = rail.outputsList(model, changes);
  assert.deepEqual(
    list.map((o) => [o.abs, o.dir, o.op, o.created]),
    [
      ["D:\\proj\\src\\app.js", "src", "present", true],
      ["D:\\proj-worker\\w.txt", "D:\\proj-worker", "write", false],
      ["D:\\proj\\docs\\notes.md", "docs", "move", false],
    ],
  );
  assert.equal(list[0].name, "app.js");
  // The stream replays what the page already drew (a rejoin): same list.
  for (const e of events) rail.foldEvent(model, e);
  assert.deepEqual(rail.outputsList(model, changes).map((o) => o.abs), list.map((o) => o.abs));
  assert.deepEqual(model.runIds, ["r1"]);
});

test("changesFiles: only events after which the files on disk may differ", () => {
  assert.equal(rail.changesFiles({ type: "tool", name: "edit_file", ok: true }), true);
  assert.equal(rail.changesFiles({ type: "tool", name: "run_command", ok: true }), true);
  assert.equal(rail.changesFiles({ type: "tool", name: "read_file", ok: true }), false);
  assert.equal(rail.changesFiles({ type: "tool", name: "write_file", ok: false }), false);
  assert.equal(rail.changesFiles({ type: "ui/end" }), true);
  assert.equal(rail.changesFiles({ type: "run_end", sub: true }), false);
  assert.equal(rail.changesFiles({ type: "delta" }), false);
});

// ------------------------------------------------------------------ background tasks

test("background tasks: this chat's subagents and shells from /api/activity, plus N finished", () => {
  const model = rail.emptyRailModel();
  const t0 = Date.parse("2026-11-09T10:00:00Z");
  for (const e of [
    { type: "run", id: "r1", root: "D:\\p" },
    { type: "run", id: "s-done", sub: true, task: "read the docs", parent: "r1" },
    { type: "run_end", run: "s-done", sub: true },
    { type: "run", id: "s-live", sub: true, task: "write tests", parent: "r1" },
    { type: "tool", name: "run_command", ok: true, args: { command: "npm run dev", background: true }, preview: "started job-1 (pid 4242) in the background." },
    { type: "tool", name: "run_command", ok: true, args: { command: "npm run watch", background: true }, preview: "started job-2 (pid 4343) in the background." },
  ])
    rail.foldEvent(model, e, t0);
  const activity = {
    runs: [{ id: "r1", startedAt: "2026-11-09T09:59:00Z" }],
    subagents: [
      { id: "s-live", parent: "r1", task: "write tests", startedAt: "2026-11-09T10:00:05Z" },
      { id: "s-nested", parent: "s-live", task: "nested", startedAt: "2026-11-09T10:00:07Z" },
      { id: "other", parent: "someone-else", task: "not ours" },
    ],
    processes: [
      { pid: 4242, runId: "r1", name: "node", firstSeen: "2026-11-09T10:00:10Z" },
      { pid: 9999, runId: "unrelated" },
    ],
  };
  const out = rail.backgroundTasks(model, activity, { thread: "r1", busy: true, now: t0 + 60_000, activityAt: t0 + 30_000 });
  assert.deepEqual(
    out.running.map((t) => [t.kind, t.id, t.title]),
    [
      ["subagent", "s-live", "write tests"],
      ["subagent", "s-nested", "nested"],
      ["shell", "pid-4242", "npm run dev"],
    ],
  );
  // s-done ended; job-2 is gone from the ledger read after it started.
  assert.equal(out.finished, 2);
});

test("background tasks: goal rounds, and the stream's word when there is no activity answer", () => {
  const model = rail.emptyRailModel();
  for (const e of [
    { type: "run", id: "g1", root: "/p" },
    { type: "mission_round", round: 1, of: 5 },
    { type: "mission_round", round: 2, of: 5 },
    { type: "run", id: "s1", sub: true, task: "helper", parent: "g1" },
  ])
    rail.foldEvent(model, e, 1000);
  const going = rail.backgroundTasks(model, null, { thread: "g1", busy: true, now: 5000 });
  assert.deepEqual(going.running.map((t) => t.title).sort(), ["Goal · round 2 of 5", "helper"]);
  assert.equal(going.finished, 1);
  rail.foldEvent(model, { type: "ui/end", status: "ok" });
  const done = rail.backgroundTasks(model, { subagents: [], processes: [], runs: [] }, { thread: "g1", busy: false, activityAt: 9000 });
  assert.equal(done.running.length, 0);
  assert.equal(done.finished, 3); // the helper and both rounds
  assert.equal(rail.elapsedText(65_000), "1m 05s");
  assert.equal(rail.elapsedText(3_725_000), "1h 02m");
  assert.equal(rail.elapsedText(4_000), "4s");
});

// ------------------------------------------------------------------ connectors

test("connectors: on count and the ones that need attention", () => {
  const sum = rail.mcpSummary({
    servers: [
      { name: "github", enabled: true, probe: { ok: true, tools: 12 } },
      { name: "slack", enabled: true, probe: { ok: false, error: "spawn ENOENT" } },
      { name: "old", enabled: false, invalid: "no command" },
      { name: "off", enabled: false, probe: { ok: false, error: "x" } },
    ],
  });
  assert.equal(sum.on, 2);
  assert.equal(sum.attention, 2);
  assert.deepEqual(sum.servers.map((s) => [s.name, Boolean(s.attention), s.tools]), [["github", false, 12], ["slack", true, null], ["old", true, null], ["off", false, null]]);
  assert.equal(rail.mcpSummary({ available: false, servers: [{ name: "a", enabled: true }] }).attention, 1);
  assert.deepEqual(rail.mcpSummary(null).servers, []);
});

// ------------------------------------------------------------------ Claude Code chats

test("Claude Code chats: each model call's usage becomes a ui/context reading", () => {
  const t = createTranslator({ model: "claude-code/opus", contextWindow: 64_000 });
  const line = (o) => JSON.stringify(o);
  const out = t.feed(line({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 1200, cache_read_input_tokens: 38_000, cache_creation_input_tokens: 800 } } } }));
  const ctx = out.find((e) => e.type === "ui/context");
  assert.deepEqual([ctx.used, ctx.window, ctx.percent, ctx.source], [40_000, 200_000, 20, "provider"]);
  assert.equal(t.result().meter.used, 40_000);
  // A subagent's call is a different conversation: no reading from it.
  assert.equal(t.feed(line({ type: "stream_event", parent_tool_use_id: "x", event: { type: "message_start", message: { id: "m9", usage: { input_tokens: 5 } } } })).length, 0);
  const big = createTranslator({ model: "claude-code/sonnet", contextWindow: 1_000_000 });
  assert.equal(big.feed(line({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10 } } } }))[0].window, 1_048_576);
  // No usage, no reading (and the existing fixture shape keeps working).
  assert.equal(createTranslator({ model: "claude-code/default" }).feed(line({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } })).length, 0);
  assert.equal(rail.contextReading(ctx).percent, 20);
});

// ------------------------------------------------------------------ the route

test("server: the rail's module and stylesheet are served, and its route needs the token", async () => {
  const { createUiServer } = await import("../src/ui.mjs");
  const root = ws();
  const home = join(HOME, "ui-home");
  mkdirSync(join(home, "runs"), { recursive: true });
  const TOKEN = "rail-token-0123456789abcdef";
  const ui = createUiServer({ port: 0, home, workspace: root, routerUrl: "http://127.0.0.1:1/v1", token: TOKEN });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  for (const [asset, type] of [["/session-rail.mjs", /javascript/], ["/session-rail.css", /text\/css/]]) {
    const res = await fetch(base + asset);
    assert.equal(res.status, 200, `${asset} must be on the static whitelist`);
    assert.match(res.headers.get("content-type"), type);
  }
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /id="session-rail"/);
  assert.match(page, /id="rail-toggle"/);
  assert.match(page, /href="\/session-rail\.css"/);
  assert.equal((await fetch(`${base}/api/session-rail`)).status, 403);
  const res = await fetch(`${base}/api/session-rail?workspace=${encodeURIComponent(root)}`, { headers: { "x-rosalena-token": TOKEN } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.thread, null);
  assert.equal(body.workspace, root);
  assert.deepEqual(body.changes, { added: 0, removed: 0, files: [] });
  rmSync(root, { recursive: true, force: true });
});
