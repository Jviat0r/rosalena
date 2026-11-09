/**
 * mcp-manager for stateful servers (plugins/rosa-mcp-manager):
 *
 *   - keepAlive reuses one process, so a server's in-memory state (a browser page, a
 *     counter) survives between calls; without it every call starts fresh
 *   - mcp_tools follows nextCursor and shows each tool as a call signature
 *   - a changed registration starts a fresh process; closeLiveServers stops them all
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { closeLiveServers, liveServerNames, normalizeServer, toolSignature, withStdioServer } from "../plugins/rosa-mcp-manager/plugin.mjs";

const dir = mkdtempSync(join(tmpdir(), "mcp-keep-"));
const SERVER = join(dir, "counter.mjs");
writeFileSync(
  SERVER,
  [
    "import { createInterface } from 'node:readline';",
    "let count = 0;",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "const tool = (name, props, required) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object', properties: props, required } });",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const m = JSON.parse(line);",
    "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'counter', version: '1' } } });",
    "  else if (m.method === 'tools/list') {",
    "    if (!m.params?.cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: [tool('count', {}, [])], nextCursor: 'p2' } });",
    "    else send({ jsonrpc: '2.0', id: m.id, result: { tools: [tool('fill', { selector: { type: 'string' }, text: { type: 'string' }, mode: { enum: ['a', 'b'] }, tags: { type: 'array', items: { type: 'string' } } }, ['selector', 'text'])] } });",
    "  } else if (m.method === 'tools/call') { count += 1; send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `count ${count} pid ${process.pid}` }] } }); }",
    "});",
  ].join("\n"),
);

const entry = (extra = {}) => ({ ...normalizeServer("counter", { command: process.execPath, args: [SERVER], ...extra }), name: "counter" });
const callCount = (e) => withStdioServer(e, (c) => c.callTool("count", {})).then((r) => r.content[0].text);

test("without keepAlive every call starts fresh; with it the state survives", async () => {
  assert.match(await callCount(entry()), /^count 1 /);
  assert.match(await callCount(entry()), /^count 1 /);
  const kept = entry({ keepAlive: true });
  const first = await callCount(kept);
  const second = await callCount(kept);
  assert.match(first, /^count 1 /);
  assert.match(second, /^count 2 /);
  assert.equal(first.split("pid ")[1], second.split("pid ")[1], "the same process");
  assert.deepEqual(liveServerNames(), ["counter"]);
  // A changed registration is a new process.
  const changed = { ...kept, env: { X: "1" } };
  assert.match(await callCount(changed), /^count 1 /);
  closeLiveServers();
  assert.deepEqual(liveServerNames(), []);
});

test("mcp_tools reads every page and shows call signatures", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-keep-home-"));
  const registryFile = join(home, "mcp-servers.json");
  writeFileSync(registryFile, JSON.stringify({ version: 1, servers: { counter: { command: process.execPath, args: [SERVER] } } }));
  const tools = plugin.tools({ config: { registryFile, stateFile: join(home, "state.json") }, log: () => {} });
  const out = await tools.find((t) => t.name === "mcp_tools").run({ server: "counter" });
  assert.match(out, /count\(\)  the count tool/);
  assert.match(out, /fill\(selector\*: string, text\*: string, mode: "a"\|"b", tags: string\[\]\)/);
});

test("signatures for small models", () => {
  assert.equal(toolSignature({ name: "x", inputSchema: { properties: { a: { type: ["string", "null"] } }, required: ["a"] } }), "x(a*: string|null)");
  assert.equal(toolSignature({ name: "y" }), "y()");
});
