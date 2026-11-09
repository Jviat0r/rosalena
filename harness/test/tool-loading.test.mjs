/**
 * Tools on demand: the first request carries only load_tools, a load adds real schemas
 * from the next step on, and a tool called without loading still runs.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import { estimateToolsTokens } from "../src/context.mjs";
import { createToolLoader, summaryOf } from "../src/tool-loading.mjs";
import { createTools } from "../src/tools.mjs";
import { readPrefs, updatePrefs } from "../src/ui-prefs.mjs";

const WS = mkdtempSync(join(tmpdir(), "tool-loading-"));
writeFileSync(join(WS, "hello.txt"), "line one\n", "utf8");

const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });
const useTool = (name, args, id = "call_1") => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
  usage: {},
});
function scripted(script) {
  const calls = [];
  const fn = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const entry = script[Math.min(calls.length - 1, script.length - 1)];
    return new Response(JSON.stringify(entry), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  fn.calls = calls;
  return fn;
}
const names = (body) => (body.tools ?? []).map((t) => t.function.name);

test("a one-line summary is the first sentence, cut short", () => {
  assert.equal(summaryOf("Read a file. Returns numbered lines."), "Read a file.");
  assert.ok(summaryOf("x".repeat(200)).length <= 90);
});

test("on demand, a quick question is sent with load_tools alone and answered in one step", async () => {
  const f = scripted([say("125")]);
  const result = await runAgent({ root: WS, onEvent: () => {}, runs: false, memory: false, task: "what is 5*25", toolLoading: "on-demand", fetchImpl: f });
  assert.equal(result.answer, "125");
  assert.deepEqual(names(f.calls[0]), ["load_tools"]);
  const loader = f.calls[0].tools[0].function.description;
  assert.match(loader, /read_file: /, "the catalog names what can be loaded");
  assert.match(f.calls[0].messages[0].content, /TOOLS LOAD ON DEMAND/);
});

test("load_tools adds the asked-for schemas from the next request on, and they stay", async () => {
  const events = [];
  const f = scripted([useTool("load_tools", { names: ["read_file", "nope"] }), useTool("read_file", { path: "hello.txt" }, "call_2"), say("done")]);
  const result = await runAgent({ root: WS, onEvent: (e) => events.push(e), runs: false, memory: false, task: "read hello.txt", toolLoading: "on-demand", fetchImpl: f });
  assert.equal(result.answer, "done");
  assert.deepEqual(names(f.calls[0]), ["load_tools"]);
  assert.ok(names(f.calls[1]).includes("read_file"), "loaded on step 2");
  assert.ok(names(f.calls[2]).includes("read_file"), "still loaded on step 3");
  assert.ok(!names(f.calls[1]).includes("write_file"), "only what was asked for");
  const loadResult = f.calls[1].messages.find((m) => m.role === "tool");
  assert.match(loadResult.content, /Loaded: read_file/);
  assert.match(loadResult.content, /Not a tool here: nope/);
  assert.ok(events.some((e) => e.type === "tools_loaded" && e.names.includes("read_file")));
  const read = f.calls[2].messages.filter((m) => m.role === "tool").at(-1);
  assert.match(read.content, /line one/, "the loaded tool really ran");
});

test("a tool called without loading it first is loaded and run, not refused", async () => {
  const f = scripted([useTool("read_file", { path: "hello.txt" }), say("ok")]);
  await runAgent({ root: WS, onEvent: () => {}, runs: false, memory: false, task: "read", toolLoading: "on-demand", fetchImpl: f });
  const result = f.calls[1].messages.find((m) => m.role === "tool");
  assert.match(result.content, /line one/);
  assert.ok(names(f.calls[1]).includes("read_file"));
});

test("all mode is unchanged: every schema, no load_tools", async () => {
  const f = scripted([say("hi")]);
  await runAgent({ root: WS, onEvent: () => {}, runs: false, memory: false, task: "hi", toolLoading: "all", fetchImpl: f });
  assert.ok(!names(f.calls[0]).includes("load_tools"));
  assert.ok(names(f.calls[0]).length > 5);
});

test("on demand costs far fewer tool tokens than sending everything", () => {
  const tools = createTools({ root: WS });
  const all = estimateToolsTokens(createToolLoader({ byName: tools.byName, mode: "all" }).schemas());
  const lazy = estimateToolsTokens(createToolLoader({ byName: tools.byName, mode: "on-demand" }).schemas());
  assert.ok(lazy < all / 2, `on-demand ${lazy} vs all ${all}`);
});

test("load_tools all loads everything, then drops itself from the request", () => {
  const tools = createTools({ root: WS });
  const loader = createToolLoader({ byName: tools.byName, mode: "on-demand" });
  loader.load({ names: ["all"] });
  const sent = loader.schemas().map((s) => s.function.name);
  assert.ok(!sent.includes("load_tools"));
  assert.equal(sent.length, Object.keys(tools.byName).length);
});

test("the setting is saved, read back and refused when unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "prefs-"));
  const current = readPrefs(join(dir, "none.json"));
  assert.equal(current.toolLoading, null);
  assert.equal(updatePrefs(current, { toolLoading: "all" }).toolLoading, "all");
  assert.throws(() => updatePrefs(current, { toolLoading: "sometimes" }), /toolLoading must be one of/);
});
