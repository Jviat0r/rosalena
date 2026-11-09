/**
 * Branching a chat from any of your messages (ui.mjs POST /api/chat with `branch`):
 *
 *   - a branch continues from the chosen turn: its first request carries that turn's
 *     history and the new text, and nothing that came after the branch point
 *   - it is its own conversation: not linked into the old thread, which is unchanged
 *   - it remembers where it came from (branches.json), and the chat says so
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUiServer } from "../src/ui.mjs";
import { readThreads, threadsFile } from "../src/threads.mjs";

const TOKEN = "b".repeat(32);

test("a branch starts from the chosen turn, as a new conversation", async () => {
  const home = mkdtempSync(join(tmpdir(), "branch-home-"));
  const ws = mkdtempSync(join(tmpdir(), "branch-ws-"));
  const seen = [];
  let answer = 0;
  const stub = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(JSON.parse(raw).messages);
      answer += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `answer ${answer}` }, finish_reason: "stop" }], usage: {} }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const ui = createUiServer({ port: 0, home, workspace: ws, routerUrl: `http://127.0.0.1:${stub.address().port}`, token: TOKEN });
  const { port } = await ui.ready();
  const base = `http://127.0.0.1:${port}`;
  const send = async (body) => (await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-rosalena-token": TOKEN }, body: JSON.stringify({ model: "fast", ...body }) })).json();
  const settle = async (id) => {
    for (let i = 0; i < 200; i += 1) {
      const chat = await (await fetch(`${base}/api/chat?id=${id}`)).json();
      if (chat.status && chat.status !== "running") return chat;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`chat ${id} never finished`);
  };
  try {
    const first = await send({ task: "turn one" });
    await settle(first.id);
    const second = await send({ task: "turn two", parentId: first.id });
    await settle(second.id);
    assert.equal(second.thread, first.id, "a follow-up joins the thread");

    // Branch from "turn two": continue from turn one with different text.
    const before = seen.length;
    const branch = await send({ task: "turn two, done differently", parentId: first.id, branch: { from: first.id, at: second.id } });
    await settle(branch.id);
    assert.equal(branch.thread, branch.id, "a branch is its own conversation");
    assert.deepEqual(branch.branchOf, { from: first.id, at: second.id });

    const sent = seen[before].filter((m) => m.role === "user").map((m) => m.content);
    assert.deepEqual(sent, ["turn one", "turn two, done differently"], "turn one's history, the new text, and not turn two");

    const threads = readThreads(threadsFile(home));
    assert.equal(threads[second.id], first.id);
    assert.equal(threads[branch.id], undefined, "the branch is not linked into the old thread");

    const original = await (await fetch(`${base}/api/chat?id=${first.id}&thread=1`)).json();
    assert.deepEqual(original.turns, [first.id, second.id], "the original chat is unchanged");
    const shown = await (await fetch(`${base}/api/chat?id=${branch.id}&thread=1`)).json();
    assert.equal(shown.branchOf.from, first.id);
  } finally {
    await ui.close();
    stub.close();
  }
});
