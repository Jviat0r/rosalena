/**
 * code-intel (plugins/rosa-code-intel): hash-anchored edits, ast-grep, language-server lookups
 * and the Node debugger, each run for real against temp projects.
 *
 *   node --import ./test/isolate.mjs --test test/code-intel.test.mjs
 *
 * The ast-grep and LSP tests install their tools on first use (npm, into the plugin's tool
 * folder in the harness home) exactly as a run would. Offline with nothing installed they
 * skip, saying why.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, { HINT, shutdownAll } from "../plugins/rosa-code-intel/plugin.mjs";
import { applyHashedEdit, lineHash, parseFile, renderLines } from "../plugins/rosa-code-intel/lib/hashline.mjs";
import { unifiedDiff } from "../plugins/rosa-code-intel/lib/diff.mjs";
import { findAstGrep, hasTsServer, toolsHome } from "../plugins/rosa-code-intel/lib/install.mjs";
import { fileUrlRegex } from "../plugins/rosa-code-intel/lib/debug.mjs";
import { decide } from "../src/permissions.mjs";
import { loadPlugins } from "../src/plugins.mjs";

const temps = [];
function tempDir(prefix = "code-intel-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(async () => {
  await shutdownAll();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** The plugin's tools, bound to `root`, the way the loader builds them. */
async function toolsFor(root) {
  const ctx = { root, harness: {}, config: {}, log: () => {} };
  await plugin.setup(ctx);
  const tools = Object.fromEntries((await plugin.tools(ctx)).map((t) => [t.name, t]));
  await plugin.hooks(ctx).onRunStart({ root, depth: 0 });
  return tools;
}

const anchorOf = (view, lineNo) => {
  const row = view.split("\n").find((l) => l.startsWith(`${lineNo}:`));
  assert.ok(row, `line ${lineNo} in:\n${view}`);
  return row.split("|")[0];
};

// --------------------------------------------------------------------------- hashline (pure)

test("hashline: hashes ignore CRLF vs LF and anchors render as LINE:HASH|text", () => {
  assert.equal(lineHash("const x = 1;"), lineHash("const x = 1;\r"));
  assert.match(lineHash("a"), /^[0-9a-f]{3}$/);
  const { lines } = parseFile("one\r\ntwo\r\n");
  assert.equal(renderLines(lines, 1, 2), `1:${lineHash("one")}|one\n2:${lineHash("two")}|two`);
});

test("hashline: replace, insert, delete keep line endings, trailing newline and BOM", () => {
  const crlf = "a\r\nb\r\nc\r\n";
  const h = (t) => lineHash(t);
  let r = applyHashedEdit(crlf, { start: `2:${h("b")}`, new_text: "B1\nB2" });
  assert.ok(r.ok, r.reason);
  assert.equal(r.text, "a\r\nB1\r\nB2\r\nc\r\n");

  r = applyHashedEdit("a\nb", { after: `2:${h("b")}`, new_text: "c" });
  assert.equal(r.text, "a\nb\nc", "no trailing newline stays that way");

  r = applyHashedEdit("a\nb\n", { start: `2:${h("b")}`, new_text: "" });
  assert.equal(r.text, "a\n");

  r = applyHashedEdit("\uFEFFx\ny\n", { after: "0", new_text: "top" });
  assert.equal(r.text, "\uFEFFtop\nx\ny\n");

  r = applyHashedEdit("", { after: "0", new_text: "first\n" });
  assert.equal(r.text, "first\n");

  r = applyHashedEdit("a\nb\nc\n", { start: `1:${h("a")}`, end: `3:${h("c")}`, new_text: `1:${h("a")}|A\n2:${h("b")}|B` });
  assert.ok(r.stripped, "pasted read_hashed prefixes are stripped");
  assert.equal(r.text, "A\nB\n");

  r = applyHashedEdit("mixed\r\nlf\nlast", { start: `2:${h("lf")}`, new_text: "LF" });
  assert.equal(r.text, "mixed\r\nLF\nlast", "each line keeps its own ending");
});

test("hashline: a stale or wrong anchor is refused, with a hint where the line went", () => {
  const text = "x\nalpha\nbeta\n";
  const stale = applyHashedEdit(text, { start: `1:${lineHash("alpha")}`, new_text: "z" });
  assert.equal(stale.ok, false);
  assert.ok(stale.stale);
  assert.match(stale.reason, /does not match.*may now be line 2/);
  assert.equal(applyHashedEdit(text, { start: "9:abc", new_text: "z" }).ok, false);
  assert.match(applyHashedEdit(text, { start: "2", new_text: "z" }).reason, /LINE:HASH/);
  assert.match(applyHashedEdit(text, { start: `3:${lineHash("beta")}`, end: `2:${lineHash("alpha")}`, new_text: "z" }).reason, /before start/);
});

test("unified diff shows only the changed hunks", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 5", "LINE 5").replace("line 25", "LINE 25");
  const d = unifiedDiff(before, after, "f.txt");
  assert.match(d, /^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ -3,5 \+3,5 @@/);
  assert.equal((d.match(/^@@/gm) ?? []).length, 2);
  assert.match(d, /^-line 5$/m);
  assert.match(d, /^\+LINE 25$/m);
});

// --------------------------------------------------------------------------- hashline tools

test("read_hashed / edit_hashed round trip on a CRLF file, refusing a stale anchor", async () => {
  const root = tempDir();
  const file = join(root, "src", "a.ts");
  mkdirSync(join(root, "src"));
  writeFileSync(file, "export const a = 1;\r\nexport const b = 2;\r\nexport const c = 3;\r\n");
  const t = await toolsFor(root);

  const view = await t.read_hashed.run({ path: "src/a.ts" });
  assert.match(view, /^src\/a\.ts: lines 1-3 of 3\n1:[0-9a-f]{3}\|export const a = 1;/);
  const b = anchorOf(view, 2);

  const out = await t.edit_hashed.run({ path: "src/a.ts", start: b, new_text: "export const b = 20;\nexport const bb = 21;" });
  assert.match(out, /replaced 1 line\(s\) with 2 at 2/);
  assert.match(out, /Lines now/);
  assert.equal(readFileSync(file, "utf8"), "export const a = 1;\r\nexport const b = 20;\r\nexport const bb = 21;\r\nexport const c = 3;\r\n");

  // The same anchor again: line 2 is now different, so nothing may change.
  const snapshot = readFileSync(file, "utf8");
  await assert.rejects(() => t.edit_hashed.run({ path: "src/a.ts", start: b, new_text: "oops" }), /REFUSED, nothing was changed[\s\S]*Fresh lines around 2[\s\S]*2:[0-9a-f]{3}\|export const b = 20;/);
  assert.equal(readFileSync(file, "utf8"), snapshot);

  // Insert after line 4 (the old line 3), then at the top.
  const v2 = await t.read_hashed.run({ path: "src/a.ts" });
  await t.edit_hashed.run({ path: "src/a.ts", after: anchorOf(v2, 4), new_text: "export const d = 4;" });
  await t.edit_hashed.run({ path: "src/a.ts", after: "0", new_text: "// header" });
  assert.equal(readFileSync(file, "utf8"), "// header\r\nexport const a = 1;\r\nexport const b = 20;\r\nexport const bb = 21;\r\nexport const c = 3;\r\nexport const d = 4;\r\n");

  // Paging: offset/limit.
  assert.match(await t.read_hashed.run({ path: "src/a.ts", offset: 5, limit: 1 }), /lines 5-5 of 6\n5:[0-9a-f]{3}\|export const c = 3;\n\[more: lines 6-6/);
});

test("hashed tools refuse paths outside the workspace, by name and through a junction", async () => {
  const root = tempDir();
  const outside = tempDir("code-intel-outside-");
  writeFileSync(join(outside, "secret.txt"), "do not touch\n");
  const t = await toolsFor(root);
  await assert.rejects(() => t.read_hashed.run({ path: "../" + outside.split(/[\\/]/).pop() + "/secret.txt" }), /outside the workspace/);
  await assert.rejects(() => t.read_hashed.run({ path: join(outside, "secret.txt") }), /outside the workspace/);
  await assert.rejects(() => t.edit_hashed.run({ path: join(outside, "secret.txt"), after: "0", new_text: "x" }), /outside the workspace/);
  symlinkSync(outside, join(root, "link"), "junction");
  await assert.rejects(() => t.read_hashed.run({ path: "link/secret.txt" }), /link that points outside/);
  await assert.rejects(() => t.edit_hashed.run({ path: "link/secret.txt", after: "0", new_text: "x" }), /link that points outside/);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "do not touch\n");
});

test("permissions: edit_hashed works like edit_file in Workspace write; Read only and plan mode refuse it", async () => {
  const root = tempDir();
  await toolsFor(root); // setup() registers the workspace tools
  const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
  const edit = call("edit_hashed", { path: "a.ts", start: "1:abc", new_text: "x" });
  assert.equal(decide({ call: edit, mode: "workspace", root }).action, "allow");
  assert.equal(decide({ call: edit, mode: "read", root }).action, "deny");
  assert.equal(decide({ call: edit, mode: "workspace", root, planning: true }).action, "deny");
  assert.equal(decide({ call: call("debug_node", { script: "a.js", breakpoints: ["a.js:1"] }), mode: "workspace", root }).action, "allow");
  // The readers are reads (permissions.mjs LOOK_ONLY_TOOLS), so Read only and plan mode
  // allow them; a rewrite or rename is a read while it only previews.
  for (const reader of ["read_hashed", "ast_search", "lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics", "lsp_symbols"]) {
    assert.equal(decide({ call: call(reader, { path: "a.ts" }), mode: "read", root }).action, "allow", reader);
  }
  assert.equal(decide({ call: call("ast_rewrite", { pattern: "a", rewrite: "b", lang: "ts" }), mode: "read", root }).action, "allow");
  assert.equal(decide({ call: call("ast_rewrite", { pattern: "a", rewrite: "b", lang: "ts", apply: true }), mode: "read", root }).action, "deny");
  assert.equal(decide({ call: call("lsp_rename", { path: "a.ts", line: 1, character: 1, new_name: "b", apply: true }), mode: "workspace", root, planning: true }).action, "deny");
});

// --------------------------------------------------------------------------- ast-grep

async function readyOrSkip(t, kind) {
  try {
    return await kind();
  } catch (err) {
    if (/timed out|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network|offline/i.test(String(err?.message))) {
      t.skip(`could not install on first use (offline?): ${err.message}`);
      return null;
    }
    throw err;
  }
}

test("ast_search and ast_rewrite on a temp TS file (dry run diff, then apply)", { timeout: 360_000 }, async (t) => {
  const root = tempDir();
  writeFileSync(join(root, "app.ts"), 'const a = 1;\nconsole.log("start", a);\nconst s = "console.log(not code)";\nconsole.log(\n  a + 1,\n);\n');
  const tools = await toolsFor(root);
  const wasInstalled = Boolean(findAstGrep(toolsHome()));
  const found = await readyOrSkip(t, () => tools.ast_search.run({ pattern: "console.log($$$A)", lang: "ts" }));
  if (found === null) return;
  t.diagnostic(`ast-grep ${wasInstalled ? "was already available" : "installed on first use"}: ${findAstGrep(toolsHome())?.bin}`);
  assert.match(found, /2 matches in 1 file/);
  assert.match(found, /app\.ts:2:1 {2}console\.log\("start", a\);/);
  assert.match(found, /app\.ts:4:1 .*\[\+2 lines\]/);
  assert.doesNotMatch(found, /:3:/, "never matches inside a string");

  const preview = await tools.ast_rewrite.run({ pattern: "console.log($$$A)", rewrite: "logger.info($$$A)", lang: "ts" });
  assert.match(preview, /PREVIEW \(nothing written\): 2 replacement\(s\) in 1 file/);
  assert.match(preview, /^-console\.log\("start", a\);$/m);
  assert.match(preview, /^\+logger\.info\("start", a\);$/m);
  assert.match(readFileSync(join(root, "app.ts"), "utf8"), /console\.log\("start"/, "dry run writes nothing");

  const applied = await tools.ast_rewrite.run({ pattern: "console.log($$$A)", rewrite: "logger.info($$$A)", lang: "ts", apply: true });
  assert.match(applied, /rewrote 2 match\(es\)/);
  const after = readFileSync(join(root, "app.ts"), "utf8");
  assert.match(after, /logger\.info\("start", a\);/);
  assert.match(after, /"console\.log\(not code\)"/, "the string is untouched");
  assert.doesNotMatch(after, /^console\.log/m);
  await assert.rejects(() => tools.ast_search.run({ pattern: "x", lang: "ts", path: "../" }), /outside the workspace/);
});

// --------------------------------------------------------------------------- LSP

test("LSP on a two-file TS project: definition, references, diagnostics, rename", { timeout: 420_000 }, async (t) => {
  const root = tempDir();
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "nodenext", noEmit: true }, include: ["*.ts"] }));
  writeFileSync(join(root, "math.ts"), "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
  writeFileSync(join(root, "main.ts"), 'import { add } from "./math.js";\n\nconst total: number = add(1, 2);\nconst bad: string = add(3, 4);\nconsole.log(total, bad);\n');
  const tools = await toolsFor(root);
  const wasInstalled = hasTsServer(toolsHome());

  const def = await readyOrSkip(t, () => tools.lsp_definition.run({ path: "main.ts", line: 3, symbol: "add" }));
  if (def === null) return;
  t.diagnostic(`typescript-language-server ${wasInstalled ? "was already available" : "installed on first use"}`);
  assert.match(def, /math\.ts:1:17 {2}export function add/);

  // By name alone (no line): found through the file's symbols / text.
  assert.match(await tools.lsp_definition.run({ path: "math.ts", symbol: "add" }), /math\.ts:1:17/);

  const refs = await tools.lsp_references.run({ path: "math.ts", symbol: "add" });
  assert.match(refs, /^4 references:/);
  assert.match(refs, /math\.ts:1:17/);
  assert.match(refs, /main\.ts:1:10/);
  assert.match(refs, /main\.ts:3:23/);
  assert.match(refs, /main\.ts:4:21/);

  const hover = await tools.lsp_hover.run({ path: "main.ts", line: 3, symbol: "add" });
  assert.match(hover, /add\(a: number, b: number\): number/);

  const diags = await tools.lsp_diagnostics.run({ path: "main.ts" });
  assert.match(diags, /1 error\(s\)/);
  assert.match(diags, /main\.ts:4:7 error TS2322: Type 'number' is not assignable to type 'string'/);

  const outline = await tools.lsp_symbols.run({ path: "math.ts" });
  assert.match(outline, /1 {2}function add/);
  assert.match(await tools.lsp_symbols.run({ query: "add" }), /function add.*math\.ts:1:/);

  // Fix the error with a hashed edit; the diagnostics follow the file on disk.
  const view = await tools.read_hashed.run({ path: "main.ts" });
  await tools.edit_hashed.run({ path: "main.ts", start: anchorOf(view, 4), new_text: "const bad: string = String(add(3, 4));" });
  assert.match(await tools.lsp_diagnostics.run({ path: "main.ts" }), /no problems found in main\.ts/);

  const preview = await tools.lsp_rename.run({ path: "math.ts", symbol: "add", new_name: "sum" });
  assert.match(preview, /PREVIEW \(nothing written\): 4 change\(s\) in 2 file\(s\)/);
  assert.match(preview, /^\+export function sum\(a: number, b: number\): number \{$/m);
  assert.match(preview, /^\+import \{ sum \} from "\.\/math\.js";$/m);
  assert.match(readFileSync(join(root, "math.ts"), "utf8"), /function add/, "dry run writes nothing");

  const applied = await tools.lsp_rename.run({ path: "math.ts", symbol: "add", new_name: "sum", apply: true });
  assert.match(applied, /renamed to sum/);
  assert.match(readFileSync(join(root, "math.ts"), "utf8"), /export function sum\(/);
  assert.equal(readFileSync(join(root, "main.ts"), "utf8"), 'import { sum } from "./math.js";\n\nconst total: number = sum(1, 2);\nconst bad: string = String(sum(3, 4));\nconsole.log(total, bad);\n');
  assert.match(await tools.lsp_diagnostics.run({ path: "main.ts" }), /no problems found/);

  await assert.rejects(() => tools.lsp_definition.run({ path: "../x.ts", symbol: "a" }), /outside the workspace/);
});

// --------------------------------------------------------------------------- debugger

test("debug_node stops at a breakpoint and reads locals and expressions", { timeout: 60_000 }, async () => {
  const root = tempDir("code intel dbg ");
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "lib", "price.js"), "export function total(items, rate) {\n  const subtotal = items.reduce((s, i) => s + i.price, 0);\n  const tax = subtotal * rate;\n  return subtotal + tax;\n}\n");
  writeFileSync(join(root, "main.mjs"), 'import { total } from "./lib/price.js";\nconst cart = [{ name: "pen", price: 2 }, { name: "book", price: 10 }];\nconsole.log("total", total(cart, 0.5));\n');
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const tools = await toolsFor(root);
  const out = await tools.debug_node.run({ script: "main.mjs", breakpoints: ["lib/price.js:4"], expressions: ["subtotal + tax", "items.length", "nope.x"] });
  assert.match(out, /HIT 1: lib\/price\.js:4/);
  assert.match(out, /total \(lib\/price\.js:4\)/);
  assert.match(out, /main\.mjs:3/);
  assert.match(out, /subtotal = 12/);
  assert.match(out, /tax = 6/);
  assert.match(out, /rate = 0\.5/);
  assert.match(out, /items = Array\(2\)/);
  assert.match(out, /subtotal \+ tax = 18/);
  assert.match(out, /items\.length = 2/);
  assert.match(out, /nope\.x = threw: ReferenceError/);
  await assert.rejects(() => tools.debug_node.run({ script: "../x.js", breakpoints: ["x.js:1"] }), /outside the workspace/);
});

test("debug_node reports an uncaught exception with its locals", { timeout: 60_000 }, async () => {
  const root = tempDir();
  writeFileSync(join(root, "boom.js"), "function parse(s) {\n  const n = Number(s);\n  if (Number.isNaN(n)) throw new Error('bad number: ' + s);\n  return n;\n}\nparse('12');\nparse('x1');\n");
  const tools = await toolsFor(root);
  const out = await tools.debug_node.run({ script: "boom.js", breakpoints: ["boom.js:99"] });
  assert.match(out, /uncaught exception: .*bad number: x1/);
  assert.match(out, /s = "x1"/);
});

test("breakpoint URL regex matches encoded and raw file URLs, either case on Windows", () => {
  const abs = process.platform === "win32" ? "C:\\a b\\x.js" : "/a b/x.js";
  const re = new RegExp(fileUrlRegex(abs));
  assert.ok(re.test(process.platform === "win32" ? "file:///C:/a%20b/x.js" : "file:///a%20b/x.js"));
  assert.ok(re.test(process.platform === "win32" ? "file:///c:/a b/x.js" : "file:///a b/x.js"));
  assert.ok(!re.test(process.platform === "win32" ? "file:///C:/a%20b/y.js" : "file:///a%20b/y.js"));
});

// --------------------------------------------------------------------------- the real loader

test("loads clean through the real plugin loader and registers its tools", async () => {
  const host = await loadPlugins({ config: { plugins: { "rosa-process-tracker": { enabled: false } } } });
  assert.ok(host.plugins.some((p) => p.id === "rosa-code-intel"), "code-intel is bundled and enabled");
  assert.deepEqual(host.errors.filter((e) => e.id === "rosa-code-intel"), []);
  const mine = host.tools.filter((tool) => tool.plugin === "rosa-code-intel").map((tool) => tool.name).sort();
  assert.deepEqual(mine, ["ast_rewrite", "ast_search", "debug_node", "edit_hashed", "lsp_definition", "lsp_diagnostics", "lsp_hover", "lsp_references", "lsp_rename", "lsp_symbols", "read_hashed"]);
  const schemaChars = JSON.stringify(host.tools.filter((tool) => tool.plugin === "rosa-code-intel").map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))).length;
  assert.ok(schemaChars < 9000, `tool schemas stay small (${schemaChars} chars)`);
  assert.ok(HINT.includes("edit_hashed"));
  assert.ok(existsSync(join(host.plugins.find((p) => p.id === "rosa-code-intel").folder, "README.md")));
});
