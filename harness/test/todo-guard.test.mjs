/**
 * todo-guard, second half: the list decides what "finished" means.
 *
 * Measured 2026-11-06: a nine-item plan, the model answered after item 2, and the run
 * ended "done" with eight items open. The model is not the only thing that can be wrong
 * about that - the harness accepted an answer while the plan it had approved was
 * unfinished. These tests pin the plugin's answer to that: hold the run open, say which
 * items are left, and stay completely quiet when the list is finished or empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../plugins/rosa-todo-guard/plugin.mjs";

const write = async (todos) => {
  const tool = plugin.tools().find((t) => t.name === "todo_write");
  return tool.run({ todos });
};
const read = async () => plugin.tools().find((t) => t.name === "todo_read").run({});
const hooks = () => plugin.hooks({ config: {}, log: () => {} });

test("an answer with items still open is sent back with the list", async () => {
  await write([
    { content: "Sequences tab", status: "completed" },
    { content: "Tailoring: SDR template", status: "in_progress" },
    { content: "Workspaces: per-user data dirs", status: "pending" },
  ]);
  const run = { state: new Map() };
  const advice = await hooks().beforeFinish({ run });

  assert.ok(advice, "a note, not silence");
  assert.match(advice.note, /2 unfinished item\(s\) out of 3/);
  assert.match(advice.note, /Tailoring: SDR template/);
  assert.match(advice.note, /Workspaces: per-user data dirs/);
  assert.match(advice.note, /call todo_write marking every item completed/);
  assert.equal(run.state.get("finishNudges"), 1, "counted, so the engine's bound has something to count");
});

test("a finished list, or no list at all, ends the run exactly as before", async () => {
  await write([
    { content: "Sequences tab", status: "completed" },
    { content: "Tailoring", status: "completed" },
  ]);
  assert.equal(await hooks().beforeFinish({ run: { state: new Map() } }), undefined);

  await write([]);
  assert.equal(await hooks().beforeFinish({ run: { state: new Map() } }), undefined);
});

test("the list survives a nudge and is read back as the model left it", async () => {
  await write([{ content: "one", status: "in_progress" }]);
  await hooks().beforeFinish({ run: { state: new Map() } });
  assert.match(await read(), /\[~\] one/);
});
