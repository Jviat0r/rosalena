// The ports from Jayden's own DSH plugin set: reveal-file-location and
// mcp-manager. (exit-rotator was removed from Rosalena on 2026-11-03.)
//
// The MCP test drives the harness's own MCP server as a child process, so the
// framing is exercised for real rather than asserted about.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import mcpPlugin, {
  createStdioClient,
  formatServers,
  formatToolResult,
  loadRegistry,
  normalizeServer,
  saveRegistry,
  withStdioServer,
} from "../plugins/rosa-mcp-manager/plugin.mjs";
import revealPlugin, { expandPath, planReveal, revealCommand, within } from "../plugins/rosa-reveal-file-location/plugin.mjs";

const HARNESS = fileURLToPath(new URL("..", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "harness-ported-"));

// ---------------------------------------------------------------- reveal

test("reveal-file-location: resolves paths and refuses anything outside the workspace", () => {
  assert.equal(expandPath("a/b.txt", HARNESS), join(HARNESS, "a", "b.txt"));
  assert.equal(expandPath("~", HARNESS), homedir());
  assert.equal(expandPath("~/x", HARNESS), join(homedir(), "x"));
  assert.throws(() => expandPath("  ", HARNESS), /no path given/);

  assert.equal(within(HARNESS, join(HARNESS, "plugins")), true);
  assert.equal(within(HARNESS, HARNESS), true);
  assert.equal(within(HARNESS, join(HARNESS, "..", "router")), false);

  assert.throws(() => planReveal("no-such-file-xyz", { root: HARNESS }), /no such file/);
  // a real file that resolves outside the root is still refused
  assert.throws(() => planReveal("../package.json", { root: join(HARNESS, "test") }), /outside the workspace/);
  assert.equal(planReveal(join(HARNESS, "package.json"), { root: HARNESS, withinRoot: false }).isDirectory, false);
});

test("reveal-file-location: one fixed command per platform, path passed as an argument", () => {
  const file = "C:\\dir\\my file.txt";
  assert.deepEqual(revealCommand(file, { platform: "win32" }), { file: "explorer.exe", args: [`/select,${file}`] });
  assert.deepEqual(revealCommand("C:\\dir", { platform: "win32", isDirectory: true }), { file: "explorer.exe", args: ["C:\\dir"] });
  assert.deepEqual(revealCommand("/tmp/a.txt", { platform: "darwin" }), { file: "open", args: ["-R", "/tmp/a.txt"] });
  assert.deepEqual(revealCommand("/tmp/dir", { platform: "darwin", isDirectory: true }), { file: "open", args: ["/tmp/dir"] });
  assert.deepEqual(revealCommand("/tmp/a.txt", { platform: "linux" }), { file: "xdg-open", args: ["/tmp"] });
});

test("reveal-file-location: the agent tool reports the path and launches nothing", async () => {
  const [tool] = revealPlugin.tools({ root: HARNESS, config: { platform: "win32" } });
  assert.equal(tool.name, "reveal_file");
  const out = await tool.run({ path: "package.json" });
  assert.match(out, /^file: /);
  assert.match(out, /explorer\.exe/);
  assert.match(out, /launch is disabled/);
  // a refusal is thrown, which the harness turns into a readable tool error for
  // the model rather than a crash - same as the built-in tools do
  await assert.rejects(() => tool.run({ path: "nope.txt" }), /no such file/);
  await assert.rejects(() => tool.run({ path: "../../../../Windows/win.ini" }), /outside the workspace/);

  // and the human command is the one that opens it
  assert.match(revealPlugin.commands({ root: HARNESS, config: {} }).path(["package.json"]), /package\.json$/);
  assert.match(revealPlugin.commands({ root: HARNESS, config: {} }).reveal(["nope.txt"]), /no such file/);
  assert.equal(revealPlugin.status({ config: {} }), "report-only (allowLaunch=false)");
});

// ------------------------------------------------------------ mcp-manager

test("mcp-manager: registry entries normalise, persist and survive a bad row", () => {
  const entry = normalizeServer("self", { command: "node", args: ["a.mjs"], env: { X: "1" } });
  assert.equal(entry.transport, "stdio");
  assert.equal(entry.invalid, null);
  assert.deepEqual(entry.args, ["a.mjs"]);
  assert.equal(normalizeServer("bad", {}).invalid, "stdio needs a command");
  assert.equal(normalizeServer("web", { url: "http://x/mcp" }).transport, "http");
  assert.equal(normalizeServer("web", { url: "http://x/mcp" }).invalid, null);

  const file = join(TMP, "servers.json");
  saveRegistry(file, { servers: { self: entry } });
  assert.deepEqual(loadRegistry(file).servers.self.args, ["a.mjs"]);
  // a missing file is an empty registry, not a crash
  assert.deepEqual(Object.keys(loadRegistry(join(TMP, "missing.json")).servers), []);
  // a row that can no longer be read is kept, so list can say what is wrong
  writeFileSync(file, JSON.stringify({ version: 1, servers: { broken: { transport: "stdio" } } }), "utf8");
  assert.match(loadRegistry(file).servers.broken.invalid, /needs a command/);
});

test("mcp-manager: tool results become text the model can read", () => {
  assert.equal(formatToolResult({ content: [{ type: "text", text: "hi" }] }), "hi");
  assert.equal(formatToolResult({ content: [{ type: "text", text: "boom" }], isError: true }), "error: boom");
  assert.match(formatToolResult({ content: [{ type: "image" }] }), /image content/);
  assert.equal(formatToolResult(null), "(no result)");
  const text = formatServers({ servers: { self: normalizeServer("self", { command: "node" }) }, path: "x.json" }, { servers: { self: { ok: true, toolCount: 3 } } });
  assert.match(text, /self\s+on/);
  assert.match(text, /3 tool/);
  assert.match(formatServers({ servers: {} }, {}), /no MCP servers registered/);
});

test("mcp-manager: a full handshake with the harness's own MCP server", async (t) => {
  t.diagnostic("spawning `node src/cli.mjs --plugin rosa-mcp-server:serve`");
  const entry = normalizeServer("self", {
    command: process.execPath,
    args: [join(HARNESS, "src", "cli.mjs"), "--plugin", "rosa-mcp-server:serve", "--root", HARNESS],
    cwd: HARNESS,
  });
  const { tools, text } = await withStdioServer(
    entry,
    async (client) => ({
      tools: await client.listTools(),
      text: formatToolResult(await client.callTool("read_file", { path: "package.json" })),
    }),
    { timeoutMs: 30000 },
  );
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes("read_file"), `expected read_file in ${names.join(", ")}`);
  assert.ok(names.includes("list_dir"));
  assert.match(text, /name/); // package.json's own content came back through the protocol
});

test("mcp-manager: a banner on stdout does not break framing, and a mute server times out", async (t) => {
  const stub = join(TMP, "stub-server.mjs");
  writeFileSync(
    stub,
    [
      'process.stdout.write("banner: this is not json\\n");',
      'let buf = "";',
      'process.stdin.on("data", (d) => {',
      '  buf += d.toString();',
      '  let i;',
      '  while ((i = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, i).trim();",
      "    buf = buf.slice(i + 1);",
      "    if (!line) continue;",
      "    const msg = JSON.parse(line);",
      '    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
      '    if (msg.method === "initialize") reply({ protocolVersion: "2024-11-05", serverInfo: { name: "stub" } });',
      '    else if (msg.method === "tools/list") reply({ tools: [{ name: "ping", description: "stub tool" }] });',
      '    else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "pong:" + (msg.params.arguments?.x ?? "") }] });',
      "  }",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const client = createStdioClient({ command: process.execPath, args: [stub], timeoutMs: 10000, log: () => {} });
  t.after(() => client.close());
  await client.initialize();
  assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["ping"]);
  assert.equal(formatToolResult(await client.callTool("ping", { x: "7" })), "pong:7");
  client.close();

  const mute = join(TMP, "mute-server.mjs");
  writeFileSync(mute, "setInterval(() => {}, 1000);\n", "utf8");
  const stuck = createStdioClient({ command: process.execPath, args: [mute], timeoutMs: 400, log: () => {} });
  t.after(() => stuck.close());
  await assert.rejects(() => stuck.initialize(), /timed out after 400ms/);
  stuck.close();

  const dead = createStdioClient({ command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 5000, log: () => {} });
  t.after(() => dead.close());
  await assert.rejects(() => dead.initialize(), /exited/);
});

test("mcp-manager: an http entry is refused with a reason instead of a stack trace", async () => {
  const entry = normalizeServer("web", { url: "http://127.0.0.1:9/mcp" });
  await assert.rejects(() => withStdioServer(entry, () => {}), /not implemented yet/);
});

test("mcp-manager: registering is a command, and the tools can only call what is registered", async () => {
  const file = join(TMP, "registry.json");
  const ctx = { root: HARNESS, config: { registryFile: file, stateFile: join(TMP, "mcp-state.json") }, log: () => {} };
  const cmds = mcpPlugin.commands(ctx);
  assert.match(cmds.add([]), /\/mcp-manager list/);
  assert.match(cmds.add(["self", "node", "a.mjs", `--cwd=${HARNESS}`]), /registered self/);
  assert.equal(loadRegistry(file).servers.self.cwd, HARNESS);
  assert.match(cmds.disable(["self"]), /now off/);
  assert.equal(loadRegistry(file).servers.self.enabled, false);
  assert.match(cmds.enable(["self"]), /now on/);
  assert.match(cmds.remove(["self"]), /removed/);
  assert.equal(Object.keys(loadRegistry(file).servers).length, 0);
  assert.match(cmds.remove(["ghost"]), /no server named/);

  const tools = mcpPlugin.tools(ctx);
  assert.deepEqual(tools.map((tool) => tool.name), ["mcp_servers", "mcp_tools", "mcp_call"]);
  // no tool can register a server: that surface is the command only
  assert.ok(!tools.some((tool) => JSON.stringify(tool.parameters).includes("command")));
  assert.match(await tools[0].run({}), /no MCP servers registered/);
  assert.match(await tools[0].run({}), /\/mcp-manager add/);
  assert.match(await tools[2].run({ server: "ghost", tool: "x" }), /failed: no server named/);
});
