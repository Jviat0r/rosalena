/**
 * The sandbox through the real loop (tools.mjs run_command with `sandbox: true`):
 *
 *   - a command writing inside the workspace works
 *   - a command writing outside it is refused by the operating system, not by a rule
 *   - background jobs are refused while sandboxed
 *   - the tool description tells the model it is sandboxed
 *
 * Windows only (the backend this machine has); elsewhere it is skipped with the reason.
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAgent } from "../src/agent.mjs";
import { createTools } from "../src/tools.mjs";
import { releaseWritable, sandboxSupport } from "../src/sandbox.mjs";

const support = sandboxSupport();
const skip = process.platform !== "win32" || !support.available ? `no sandbox here: ${support.why}` : false;

const call = (name, args, id) => ({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: {} });
const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });

test("sandboxed commands write inside the workspace and nowhere else", { skip }, async () => {
  const top = mkdtempSync(join(tmpdir(), "sbrun-"));
  const ws = join(top, "ws");
  mkdirSync(ws);
  try {
    const script = [
      call("run_command", { command: "echo inside> inside.txt" }, "a"),
      call("run_command", { command: "echo outside> ..\\outside.txt" }, "b"),
      call("run_command", { command: "node -e 1", background: true }, "c"),
      say("done"),
    ];
    let n = 0;
    const bodies = [];
    const fetchImpl = async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify(script[Math.min(n++, 3)]), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
    };
    await runAgent({ root: ws, task: "write files", sandbox: true, fetchImpl, stream: false, runs: false, memory: false, snapshots: false, onEvent: () => {} });
    assert.equal(readFileSync(join(ws, "inside.txt"), "utf8").trim(), "inside");
    assert.equal(existsSync(join(top, "outside.txt")), false, "the write outside was refused");
    const results = bodies.at(-1).messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    assert.match(results[1], /denied/i);
    assert.match(results[2], /background jobs are not available while commands are sandboxed/);
    const runCommand = bodies[0].tools.find((t) => t.function.name === "run_command");
    assert.match(runCommand.function.description, /SANDBOXED/);
  } finally {
    releaseWritable(ws);
  }
});

test("without the sandbox the description says the shell is not a boundary", () => {
  const tools = createTools({ root: tmpdir() });
  assert.match(tools.byName.run_command.description, /not a boundary/);
});
