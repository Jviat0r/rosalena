/**
 * Tool calls on a text-only target (`"tools": "emulated"`, OmniRoute's keyless auto) and the
 * shared free quota (`"sharedQuota": true`, OpenCode's free DeepSeek and GLM).
 *
 * No network: every upstream is an injected fetch.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { completionToSse, emulateToolsBody, parseEmulatedToolCalls, toolContract } from "../src/emulated-tools.mjs";
import { KeyPool, Ledger } from "../src/limits.mjs";
import { route } from "../src/router.mjs";

const TMP = mkdtempSync(join(tmpdir(), "router-emulated-"));
const TOOLS = [
  { type: "function", function: { name: "write_file", description: "Write a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
  { type: "function", function: { name: "read_file", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];
const silence = { log() {} };

const reply = (text) =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 9 } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function fetchTable(table) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    for (const [needle, respond] of table) if (String(url).includes(needle)) return respond();
    return new Response("{}", { status: 500 });
  };
  fn.calls = calls;
  return fn;
}

function config() {
  return {
    logDir: TMP,
    stateFile: join(TMP, `ledger-${Math.random().toString(36).slice(2)}.json`),
    budgets: { monthlyUsd: {} },
    providers: {
      free: { kind: "openai", baseUrl: "http://stub.free/v1", apiKeyEnv: null, sharedQuota: true, prices: { in: 0, out: 0 } },
      omniroute: { kind: "openai", baseUrl: "http://stub.omni/v1", apiKeyEnv: null, prices: { in: 0, out: 0 }, models: [{ id: "auto", tools: "emulated" }] },
    },
    classes: { rosalena: { chain: ["free/deepseek", "free/glm", "omniroute/auto"] }, omni: { chain: ["omniroute/auto"] } },
  };
}

const ctx = (cfg, fetchImpl) => ({ config: cfg, ledger: new Ledger(cfg.stateFile), keyPool: new KeyPool({}, cfg.providers), logger: silence, fetchImpl });

test("the request becomes plain turns: system and tool contract on top, history as text", () => {
  const body = emulateToolsBody({
    model: "x",
    tools: TOOLS,
    tool_choice: "auto",
    messages: [
      { role: "system", content: "You are Rosalena." },
      { role: "user", content: "make hello.txt" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"hello.txt","content":"hi"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "wrote 2 bytes" },
    ],
  });
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.deepEqual(body.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.match(body.messages[0].content, /^You are Rosalena\./);
  assert.match(body.messages[0].content, /- write_file: Write a file\./);
  assert.match(body.messages[0].content, /make hello\.txt$/);
  assert.equal(body.messages[1].content, '<tool>{"name":"write_file","arguments":{"path":"hello.txt","content":"hi"}}</tool>');
  assert.equal(body.messages[2].content, "Result of write_file:\nwrote 2 bytes");
});

test("a plain chat keeps its persona: the system message is folded in, with no tool contract", () => {
  const body = emulateToolsBody({ messages: [{ role: "system", content: "You are Rosalena." }, { role: "user", content: "who are you?" }] });
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, "You are Rosalena.\n\n---\n\nwho are you?");
  assert.doesNotMatch(toolContract([]), /write_file/);
});

test("replies are parsed back into tool calls, in the contract's form and in the shape the playground fell back to", () => {
  const names = ["write_file", "read_file"];
  const tagged = parseEmulatedToolCalls('Sure.\n<tool>{"name": "write_file", "arguments": {"path": "a.txt", "content": "x"}}</tool>', names);
  assert.equal(tagged.text, "Sure.");
  assert.equal(tagged.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(tagged.toolCalls[0].function.arguments), { path: "a.txt", content: "x" });

  // Measured 2026-11-06 from OmniRoute auto (GLM 5.2 on the Cloudflare playground).
  const bare = parseEmulatedToolCalls('I\'ll create the file hello.txt with the content "hi" for you.\n\nmcp_write_file\n{"path": "hello.txt", "content": "hi"}', names);
  assert.equal(bare.toolCalls.length, 1);
  assert.equal(bare.toolCalls[0].function.name, "write_file");
  assert.equal(bare.text, 'I\'ll create the file hello.txt with the content "hi" for you.');

  const two = parseEmulatedToolCalls('<tool>{"name":"read_file","arguments":{"path":"a"}}</tool>\n<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>', names);
  assert.deepEqual(two.toolCalls.map((c) => JSON.parse(c.function.arguments).path), ["a", "b"]);

  const unknown = parseEmulatedToolCalls('<tool>{"name": "delete_everything", "arguments": {}}</tool>', names);
  assert.equal(unknown.toolCalls.length, 0, "a name the request never offered stays text");
});

test("route: an emulated target answers a tool request with real tool calls, buffered or streamed", async () => {
  const cfg = config();
  const f = fetchTable([["stub.omni", () => reply('<tool>{"name": "write_file", "arguments": {"path": "hello.txt", "content": "hi"}}</tool>')]]);
  const out = await route({ ...ctx(cfg, f), cls: "omni", body: { messages: [{ role: "user", content: "go" }], tools: TOOLS } });
  assert.equal(out.stream, false);
  const message = out.completion.choices[0].message;
  assert.equal(out.completion.choices[0].finish_reason, "tool_calls");
  assert.equal(message.tool_calls[0].function.name, "write_file");
  assert.equal(f.calls[0].body.tools, undefined, "the upstream never sees a tools array");
  assert.match(f.calls[0].body.messages[0].content, /<tool>/);

  const s = fetchTable([["stub.omni", () => reply('<tool>{"name": "read_file", "arguments": {"path": "a"}}</tool>')]]);
  const streamed = await route({ ...ctx(cfg, s), cls: "omni", body: { stream: true, messages: [{ role: "user", content: "go" }], tools: TOOLS } });
  assert.equal(streamed.stream, true);
  assert.notEqual(s.calls[0].body.stream, true, "fetched whole, so the call can be parsed");
  const sse = await streamed.response.text();
  assert.match(sse, /"tool_calls":\[\{"index":0,"id":"call_emu_/);
  assert.match(sse, /"finish_reason":"tool_calls"/);
  assert.match(sse, /data: \[DONE\]/);
});

test("route: one 429 from a shared-quota provider skips its other models and goes to the next provider", async () => {
  const cfg = config();
  const f = fetchTable([
    ["stub.free", () => new Response(JSON.stringify({ error: { type: "FreeUsageLimitError" } }), { status: 429, headers: { "content-type": "application/json" } })],
    ["stub.omni", () => reply("Rosalena here.")],
  ]);
  const out = await route({ ...ctx(cfg, f), cls: "rosalena", body: { messages: [{ role: "user", content: "hi" }] } });
  assert.equal(out.target, "omniroute/auto");
  assert.deepEqual(out.attempts.map((a) => [a.target, a.reason ?? "ok"]), [
    ["free/deepseek", "rate_limit"],
    ["free/glm", "shared_quota"],
    ["omniroute/auto", "ok"],
  ]);
  assert.equal(f.calls.filter((c) => c.url.includes("stub.free")).length, 1, "GLM was never asked");
});

test("a capped target gets the fitted form: core tools, a short identity, the task and the newest turns", () => {
  const persona = "P".repeat(6504); // the real rosalena.md is 6504 characters
  const many = [...TOOLS, ...Array.from({ length: 80 }, (_, i) => ({ type: "function", function: { name: `extra_${i}`, description: "x".repeat(400), parameters: { type: "object" } } }))];
  const history = [];
  for (let i = 0; i < 12; i += 1) {
    history.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"f${i}"}` } }] });
    history.push({ role: "tool", tool_call_id: `c${i}`, content: `${i}:`.padEnd(3000, "z") });
  }
  const body = emulateToolsBody(
    { tools: many, messages: [{ role: "system", content: persona }, { role: "user", content: "fix the bug" }, ...history] },
    { maxChars: 5800, keepTools: ["read_file", "write_file"], shortSystem: "You are Rosalena." },
  );
  const total = body.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= 5800, `fits the cap (${total})`);
  const head = body.messages[0].content;
  assert.match(head, /^You are Rosalena\./, "the short identity, not the 6504-character persona");
  assert.match(head, /- read_file\(path\?: string\)/);
  assert.doesNotMatch(head, /extra_0/, "only the core tools are offered");
  assert.match(head, /fix the bug$/, "the task stays");
  assert.match(body.messages.at(-1).content, /^Result of read_file:\n11:/, "the newest result stays");
  assert.ok(body.messages.some((m) => /earlier steps were left out/.test(m.content)), "dropping old turns is said");
});

test("route: when the free quota is spent and OmniRoute is down, the 503 says so", async () => {
  const cfg = config();
  const f = async (url) => {
    if (String(url).includes("stub.free")) return new Response("{}", { status: 429 });
    throw new TypeError("fetch failed: ECONNREFUSED");
  };
  await assert.rejects(route({ ...ctx(cfg, f), cls: "rosalena", body: { messages: [{ role: "user", content: "hi" }] } }), (err) => {
    assert.equal(err.status, 503);
    assert.match(err.meta.hint, /free tier's daily limit is used up/);
    assert.match(err.meta.hint, /OmniRoute, the free fallback, is not running/);
    return true;
  });
});

test("completionToSse carries content, every tool call and the usage", async () => {
  const sse = await completionToSse({
    id: "x",
    created: 1,
    model: "m",
    choices: [{ message: { role: "assistant", content: "ok", tool_calls: [{ id: "a", type: "function", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }).text();
  assert.match(sse, /"content":"ok"/);
  assert.match(sse, /"usage":\{"prompt_tokens":3/);
});
