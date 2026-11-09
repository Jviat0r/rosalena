/**
 * The two read-only routes the new inspector panels stand on.
 *
 * `/api/graph` is a projection of the run store: a parent link that is already in the index
 * must become an edge, and a parent that has scrolled out of the window must NOT become an
 * invented node - the child is reported as a root and marked an orphan, because a graph
 * that draws a fake parent is worse than one that shows a gap.
 *
 * `/api/files` is a directory listing of the workspace and nothing else. The test that
 * matters most is the one that tries to leave: `..`, an absolute path, and a sibling
 * directory whose name shares a prefix with the workspace (the case a naive
 * `startsWith` check lets through).
 *
 * Both are exercised against a temp ROSALENA_HOME and a temp workspace, so nothing here
 * reads or writes the real machine's stores.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-panels-"));
const HOME = join(WS, "home");
const RUNS = join(HOME, "runs");
const ROOT = join(WS, "workspace");
const TOKEN = "panels-test-token-0123456789";

// A workspace that looks like a project, plus a sibling that shares its prefix - the shape
// that catches a prefix-based escape check.
mkdirSync(RUNS, { recursive: true });
mkdirSync(join(ROOT, "src", "deep"), { recursive: true });
mkdirSync(join(ROOT, "docs"), { recursive: true });
mkdirSync(join(WS, "workspace-secret"), { recursive: true });
writeFileSync(join(ROOT, "README.md"), "# workspace\n");
writeFileSync(join(ROOT, "src", "main.mjs"), "export const x = 1;\n");
writeFileSync(join(ROOT, "src", "deep", "inner.mjs"), "export const y = 2;\n");
writeFileSync(join(WS, "workspace-secret", "nope.txt"), "must not be listed\n");

// One root, one child, and one child whose parent is not in the index at all.
const PARENT = "r-20261020-100000-parent";
const CHILD = "r-20261020-100100-child";
const ORPHAN = "r-20261020-100200-orphan";
const GHOST = "r-20261020-090000-gone";
writeFileSync(
  join(RUNS, "index.jsonl"),
  [
    { id: PARENT, status: "ok", task: "Plan the work", startedAt: "2026-10-20T14:00:00.000Z", steps: 5, ms: 12_000, depth: 0, parent: null, cls: "orchestrate" },
    { id: CHILD, status: "running", task: "Do the work", startedAt: "2026-10-20T14:01:00.000Z", steps: 2, ms: 3_000, depth: 1, parent: PARENT, cls: "code" },
    { id: ORPHAN, status: "failed", task: "A child of a run that scrolled away", startedAt: "2026-10-20T14:02:00.000Z", steps: 1, ms: 900, depth: 1, parent: GHOST, cls: "code" },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n",
);

let ui;
let base;

before(async () => {
  ui = createUiServer({ port: 0, home: HOME, workspace: ROOT, routerUrl: "http://127.0.0.1:1/v1", token: TOKEN });
  const state = await ui.ready();
  base = `http://127.0.0.1:${state.port}`;
});

after(async () => {
  await ui?.close();
});

// ---------------------------------------------------------------- the graph

test("/api/graph turns a stored parent link into an edge, and nothing else", async () => {
  const body = await (await fetch(`${base}/api/graph`)).json();
  assert.equal(body.nodes.length, 3);
  assert.deepEqual(body.edges, [{ from: PARENT, to: CHILD }], "the one real link is the one edge");
  const child = body.nodes.find((n) => n.id === CHILD);
  assert.equal(child.status, "running");
  assert.equal(child.depth, 1);
  assert.equal(child.cls, "code");
  assert.equal(child.steps, 2);
  assert.match(child.label, /Do the work/);
});

test("/api/graph reports a child whose parent is out of the window as an orphan root", async () => {
  const body = await (await fetch(`${base}/api/graph`)).json();
  assert.deepEqual(body.orphans, [ORPHAN]);
  assert.ok(body.roots.includes(ORPHAN), "an orphan still has to be drawn somewhere");
  assert.ok(body.roots.includes(PARENT));
  assert.equal(body.edges.some((e) => e.to === ORPHAN), false, "no invented parent");
  assert.equal(body.edges.some((e) => e.from === GHOST), false, "no invented node");
});

test("/api/graph counts what it is showing", async () => {
  const body = await (await fetch(`${base}/api/graph`)).json();
  assert.deepEqual(body.counts, { total: 3, running: 1, failed: 1, deepest: 1 });
  assert.equal(body.truncated, false);
  assert.equal(typeof body.at, "number");
});

test("/api/graph honours the limit and says when it truncated", async () => {
  const body = await (await fetch(`${base}/api/graph?limit=1`)).json();
  assert.equal(body.nodes.length, 1);
  assert.equal(body.truncated, true, "a capped window has to admit it was capped");
});

// ---------------------------------------------------------------- the files

test("/api/files lists the workspace root with directories before files", async () => {
  const body = await (await fetch(`${base}/api/files`)).json();
  assert.equal(body.path, "");
  assert.equal(body.parent, null);
  assert.equal(body.root, ROOT);
  assert.deepEqual(
    body.dirs.map((d) => d.name),
    ["docs", "src"],
  );
  assert.deepEqual(
    body.files.map((f) => f.name),
    ["README.md"],
  );
  assert.equal(body.files[0].size, 12);
  assert.equal(typeof body.files[0].at, "string");
});

test("/api/files lists a subdirectory and knows how to get back", async () => {
  const body = await (await fetch(`${base}/api/files?path=src`)).json();
  assert.equal(body.path, join("src"));
  assert.equal(body.parent, "");
  assert.deepEqual(
    body.dirs.map((d) => d.name),
    ["deep"],
  );
  assert.deepEqual(
    body.files.map((f) => f.name),
    ["main.mjs"],
  );
});

test("/api/files refuses to leave the workspace, including a prefixed sibling", async () => {
  // `workspace-secret` starts with the workspace's own name: a prefix check would pass it.
  for (const attempt of ["..", "../..", join("..", "workspace-secret"), join(ROOT, "..", "workspace-secret")]) {
    const res = await fetch(`${base}/api/files?path=${encodeURIComponent(attempt)}`);
    assert.equal(res.status, 403, `must refuse: ${attempt}`);
    const body = await res.json();
    assert.equal(body.error, "outside the workspace");
    assert.deepEqual(body.files, [], "a refusal carries no listing");
  }
});

test("/api/files answers a missing path with a sentence, not an empty folder", async () => {
  const res = await fetch(`${base}/api/files?path=nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /cannot list nope/);
  assert.deepEqual(body.dirs, []);
});

test("/api/files says when the path is a file rather than a folder", async () => {
  const res = await fetch(`${base}/api/files?path=README.md`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "not a directory");
});

test("/api/files is readable without the token, like the other read-only probes", async () => {
  const res = await fetch(`${base}/api/files?path=docs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, join("docs"));
  assert.deepEqual(body.files, [], "an empty folder is still a successful listing");
  assert.equal(body.truncated, false);
});
