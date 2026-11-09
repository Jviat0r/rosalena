/**
 * Conversations: a follow-up is a new run, but the sidebar shows the chat once.
 *
 *   - linkRun points every follow-up at the conversation's first run
 *   - collapseThreads folds a newest-first list into one row per conversation
 *   - over HTTP: a message and its follow-up are one row in /api/sessions and in the
 *     folders, and ?thread=1 returns both turns, oldest first
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";
import { collapseThreads, linkRun, readThreads, rootOf, threadMembers, threadsFile } from "../src/threads.mjs";

const TOKEN = "threads-token-0123456789abcdef";

test("follow-ups link to the first run, however long the chain", () => {
  const file = threadsFile(mkdtempSync(join(tmpdir(), "harness-threads-")));
  assert.deepEqual(readThreads(file), {}, "no file is no links");
  assert.equal(linkRun(file, "r-2", "r-1"), "r-1");
  assert.equal(linkRun(file, "r-3", "r-2"), "r-1", "a follow-up of a follow-up joins the same conversation");
  const map = readThreads(file);
  assert.equal(rootOf(map, "r-3"), "r-1");
  assert.equal(rootOf(map, "r-9"), "r-9", "an unknown run is its own conversation");
  assert.deepEqual(threadMembers(map, "r-1"), ["r-1", "r-2", "r-3"]);
});

test("a newest-first list folds into one row per conversation", () => {
  const map = { "r-2": "r-1", "r-3": "r-1" };
  const rows = [
    { id: "r-sub", title: "worker", at: "t5", status: "ok", parent: "r-3" },
    { id: "r-3", title: "and make it blue", at: "t4", status: "running" },
    { id: "r-x", title: "unrelated", at: "t3", status: "ok" },
    { id: "r-2", title: "now add a button", at: "t2", status: "ok" },
    { id: "r-1", title: "make me a timer", at: "t1", status: "ok" },
  ];
  const out = collapseThreads(rows, map, { titleOf: () => "should not be needed" });
  assert.deepEqual(
    out.map((r) => r.id),
    ["r-sub", "r-1", "r-x"],
  );
  const chat = out.find((r) => r.id === "r-1");
  assert.equal(chat.title, "make me a timer", "the row is named after the first message");
  assert.equal(chat.status, "running", "and shows the newest turn's status");
  assert.equal(chat.at, "t4");
  assert.equal(chat.latest, "r-3");
  assert.equal(chat.turns, 3);
  assert.equal(out[0].parent, "r-1", "a follow-up's subagent hangs under the conversation");

  // The first run fell outside the list: its title comes from titleOf.
  const cut = collapseThreads(rows.slice(1, 2), map, { titleOf: (id) => (id === "r-1" ? "make me a timer" : null) });
  assert.equal(cut[0].id, "r-1");
  assert.equal(cut[0].title, "make me a timer");
});

// A router that answers every request with one short reply.
const router = createServer(async (req, res) => {
  for await (const _chunk of req) {
    /* drain */
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 2 } }));
});
await new Promise((done) => router.listen(0, "127.0.0.1", done));
after(() => new Promise((done) => router.close(done)));

test("a message and its follow-up are one chat in the sidebar", async () => {
  const ws = mkdtempSync(join(tmpdir(), "harness-threads-ui-"));
  const ui = createUiServer({ port: 0, home: join(ws, "home"), workspace: ws, routerUrl: `http://127.0.0.1:${router.address().port}/v1`, token: TOKEN });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  const post = async (body) =>
    (await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-rosalena-token": TOKEN }, body: JSON.stringify(body) })).json();
  const settle = async (id) => {
    for (let i = 0; i < 200; i += 1) {
      const chat = await (await fetch(`${base}/api/chat?id=${id}`)).json();
      if (chat.status && chat.status !== "running") return chat;
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error(`run ${id} never finished`);
  };

  const first = await post({ task: "make me a pomodoro timer" });
  assert.equal(first.thread, first.id, "a first message starts its own conversation");
  await settle(first.id);
  const second = await post({ task: "now add a pause button", parentId: first.id });
  assert.notEqual(second.id, first.id, "the follow-up is its own run");
  assert.equal(second.thread, first.id, "in the first message's conversation");
  await settle(second.id);
  const third = await post({ task: "and a reset", parentId: second.id });
  assert.equal(third.thread, first.id);
  await settle(third.id);

  const sessions = await (await fetch(`${base}/api/sessions?limit=60`)).json();
  const rows = sessions.chats.filter((c) => c.id === first.id || c.id === second.id || c.id === third.id);
  assert.equal(rows.length, 1, `expected one row, got ${JSON.stringify(rows.map((r) => r.id))}`);
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].title, "make me a pomodoro timer");
  assert.equal(rows[0].turns, 3);
  assert.equal(rows[0].latest, third.id);

  const folders = await (await fetch(`${base}/api/folders`)).json();
  const listed = folders.groups.flatMap((g) => g.sessions.map((s) => s.id));
  assert.deepEqual(listed, [first.id], "the folder view lists the conversation once");

  // Opening the chat by any of its runs shows every turn, oldest first.
  const thread = await (await fetch(`${base}/api/chat?id=${second.id}&thread=1`)).json();
  assert.equal(thread.thread, first.id);
  assert.equal(thread.id, third.id, "the newest turn is the one a follow-up continues");
  assert.deepEqual(thread.turns, [first.id, second.id, third.id]);
  const asked = thread.events.filter((e) => e.type === "run" && !e.sub).map((e) => e.task);
  assert.equal(asked.length, 3);
  assert.match(asked[0], /pomodoro/);
  assert.match(asked[1], /pause/);
  assert.match(asked[2], /reset/);

  // A stale parent id still runs, as a chat of its own.
  const stale = await post({ task: "hello", parentId: "r-does-not-exist" });
  assert.equal(stale.thread, stale.id);
  await settle(stale.id);
});
