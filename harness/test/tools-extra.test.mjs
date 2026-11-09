/**
 * The tools ported from DeepSeek Harness: glob, scoped search, web_fetch / web_search
 * parsing, background jobs, ask_user, present, skill and session_search.
 *
 * Nothing here touches the network: the web tools are given a stub fetch.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import { createTools } from "../src/tools.mjs";
import { globFiles, globToRegExp, htmlToText, listSkills, parseDuckDuckGo } from "../src/tools-extra.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-ported-"));
mkdirSync(join(WS, "src", "deep"), { recursive: true });
mkdirSync(join(WS, "node_modules", "x"), { recursive: true });
writeFileSync(join(WS, "src", "a.mjs"), "export const a = 'needle';\n");
writeFileSync(join(WS, "src", "deep", "b.mjs"), "export const b = 'needle';\n");
writeFileSync(join(WS, "readme.md"), "# hi\n");
writeFileSync(join(WS, "node_modules", "x", "c.mjs"), "needle\n");

const tools = (extra = {}) => createTools({ root: WS, ...extra }).byName;

test("glob patterns: ** crosses folders, * does not, {a,b} alternates", () => {
  assert.ok(globToRegExp("src/**/*.mjs").test("src/deep/b.mjs"));
  assert.ok(globToRegExp("src/**/*.mjs").test("src/a.mjs"));
  assert.ok(!globToRegExp("src/*.mjs").test("src/deep/b.mjs"));
  assert.ok(globToRegExp("*.{md,txt}").test("readme.md"));
});

test("glob finds files, skips node_modules, and a bare pattern matches at any depth", async () => {
  const out = await tools().glob.run({ pattern: "*.mjs" });
  assert.match(out, /src\/a\.mjs/);
  assert.match(out, /src\/deep\/b\.mjs/);
  assert.doesNotMatch(out, /node_modules/);
  assert.equal(globFiles(WS, "src/*.mjs").files.length, 1);
  await assert.rejects(tools().glob.run({ pattern: "*", path: "../" }), /outside the workspace/);
});

test("search can be scoped to a folder", async () => {
  const all = await tools().search.run({ pattern: "needle" });
  const deep = await tools().search.run({ pattern: "needle", path: "src/deep" });
  assert.match(all, /a\.mjs/);
  assert.doesNotMatch(deep, /a\.mjs/);
  assert.match(deep, /b\.mjs/);
});

test("web_fetch turns HTML into readable text and refuses non-http URLs", async () => {
  const page = "<html><head><title>Docs</title><style>x{}</style></head><body><h1>Install</h1><p>Run <b>npm i</b> &amp; go.</p><script>evil()</script></body></html>";
  assert.match(htmlToText(page), /# Docs/);
  assert.match(htmlToText(page), /# Install/);
  assert.match(htmlToText(page), /Run npm i & go\./);
  assert.doesNotMatch(htmlToText(page), /evil|x\{\}/);
  const fetchImpl = async () => new Response(page, { status: 200, headers: { "content-type": "text/html" } });
  const byName = createTools({ root: WS }).byName;
  await assert.rejects(byName.web_fetch.run({ url: "file:///C:/secret" }), /only http and https/);
});

test("DuckDuckGo results are parsed into title, real URL and snippet", () => {
  const html = `
    <div class="result results_links web-result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=1">Example <b>Docs</b></a></h2>
    <a class="result__snippet" href="#">How to <b>use</b> it.</a></div>
    <div class="result"><a class="result__a" href="https://other.test/page">Other</a><div class="result__snippet">Second one</div></div>`;
  const hits = parseDuckDuckGo(html);
  assert.deepEqual(hits[0], { title: "Example Docs", url: "https://example.com/docs", snippet: "How to use it." });
  assert.equal(hits[1].url, "https://other.test/page");
});

test("a background job starts, is read, and can be stopped", async () => {
  const byName = tools();
  const started = await byName.run_command.run({ command: "node -e \"console.log('hello'); setTimeout(() => {}, 30000)\"", background: true });
  const id = /started (job-\d+)/.exec(started)?.[1];
  assert.ok(id, started);
  const first = await byName.job_output.run({ job_id: id, wait_ms: 1500 });
  assert.match(first, /running/);
  assert.match(first, /hello/);
  assert.match(await byName.job_list.run({}), new RegExp(`${id}.*running`));
  assert.match(await byName.job_kill.run({ job_id: id }), /stopped/);
  const after = await byName.job_output.run({ job_id: id, wait_ms: 3000 });
  assert.match(after, /exited/);
});

test("run_command runs in a subfolder and in PowerShell when asked", async () => {
  const byName = tools();
  const here = await byName.run_command.run({ command: process.platform === "win32" ? "cd" : "pwd", workdir: "src" });
  assert.match(here, /src/);
  if (process.platform === "win32") {
    assert.match(await byName.run_command.run({ command: "Write-Output (2+3)", shell: "powershell" }), /5/);
  }
  await assert.rejects(byName.run_command.run({ command: "dir", workdir: "../.." }), /outside the workspace/);
});

test("ask_user ends the run with the question, and present announces the file", async () => {
  const events = [];
  const replies = [
    { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "p1", type: "function", function: { name: "present", arguments: JSON.stringify({ path: "readme.md", note: "the readme" }) } }] } }], usage: {} },
    { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "q1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question: "Blue or green?", options: ["Blue", "Green"] }) } }] } }], usage: {} },
  ];
  let call = 0;
  const fetchImpl = async () => new Response(JSON.stringify(replies[Math.min(call++, replies.length - 1)]), { status: 200, headers: { "content-type": "application/json" } });
  const result = await runAgent({ root: WS, task: "pick a colour", fetchImpl, onEvent: (e) => events.push(e), memory: false });
  assert.equal(result.answer, "Blue or green?\nOptions: Blue | Green");
  assert.equal(result.awaitingUser, true);
  assert.deepEqual(events.find((e) => e.type === "ask_user"), { type: "ask_user", question: "Blue or green?", options: ["Blue", "Green"], ...(events.find((e) => e.type === "ask_user").at ? { at: events.find((e) => e.type === "ask_user").at } : {}) });
  const shown = events.find((e) => e.type === "present");
  assert.equal(shown.path, "readme.md");
  assert.equal(shown.note, "the readme");
});

test("skills are read from SKILL.md folders, and session_search finds past chats", async () => {
  const skills = join(WS, "skills-home");
  mkdirSync(join(skills, "deploy"), { recursive: true });
  writeFileSync(join(skills, "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship the site\n---\nSteps here.\n");
  assert.deepEqual(listSkills([skills]).map((s) => [s.name, s.description]), [["deploy", "Ship the site"]]);

  const runs = join(WS, "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, "r-1.json"), JSON.stringify({ id: "r-1", status: "ok", task: "fix the download page", answer: "moved the buttons up" }));
  writeFileSync(join(runs, "r-2.json"), JSON.stringify({ id: "r-2", status: "ok", task: "other thing", answer: "nothing" }));
  const found = await createTools({ root: WS, runsDir: runs }).byName.session_search.run({ query: "download buttons" });
  assert.match(found, /r-1/);
  assert.doesNotMatch(found, /r-2/);
});

test("the skills that ship with the app load, and carry nothing personal", async () => {
  const { BUNDLED_SKILLS } = await import("../src/tools-extra.mjs");
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const bundled = listSkills([BUNDLED_SKILLS]);
  const names = bundled.map((s) => s.name).sort();
  assert.deepEqual(names, ["aeo-ready", "anti-stuck", "commit-cadence", "desktop-control", "frontend-taste", "plugin-builder", "ship", "ui-check", "vite-restart", "web-access"]);
  for (const skill of bundled) assert.ok(skill.description.length > 20, `${skill.name} has no description`);
  const walk = (dir) => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
  for (const file of walk(BUNDLED_SKILLS)) {
    assert.doesNotMatch(file, /node_modules/, "no installed packages are bundled");
    const text = readFileSync(file, "utf8");
    // Either slash: aeo-ready once shipped "C:/Users/Jades/..." past a backslash-only check.
    assert.doesNotMatch(text, /jayden|tessaly|guardmydata|jviat0r|[\\/]Users[\\/]Jades|D:[\\/]AppDev/i, `${file} names a person or a private path`);
  }
});

test("project instructions: AGENTS.md from the workspace up, CLAUDE.md as a fallback, @includes inlined", async () => {
  const { instructionFiles, loadInstructions } = await import("../src/instructions.mjs");
  const project = join(WS, "proj", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(WS, "proj", "CLAUDE.md"), "@RULES.md\n");
  writeFileSync(join(WS, "proj", "RULES.md"), "Never deploy without asking.\n");
  writeFileSync(join(project, "AGENTS.md"), "Run npm test before you finish.\n");
  const files = instructionFiles(project, { home: join(WS, "no-home") });
  assert.deepEqual(files.slice(-2), [join(WS, "proj", "CLAUDE.md"), join(project, "AGENTS.md")], "outer first, nearest last");
  const { text } = loadInstructions(project);
  assert.match(text, /Never deploy without asking/, "the @include was inlined");
  assert.match(text, /Run npm test before you finish/);
  assert.ok(text.indexOf("Never deploy") < text.indexOf("Run npm test"));
});

test("a run puts the project rules in its system prompt", async () => {
  const project = join(WS, "ruled");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "Always answer in haiku.\n");
  let system = "";
  const fetchImpl = async (_url, init) => {
    system = JSON.parse(init.body).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const events = [];
  await runAgent({ root: project, task: "hi", fetchImpl, memory: false, onEvent: (e) => events.push(e) });
  assert.match(system, /Always answer in haiku/);
  assert.ok(events.some((e) => e.type === "instructions"));
});

test("output too long to show is saved to a file the run can read", async () => {
  const byName = tools();
  const out = await byName.run_command.run({ command: "node -e \"for (let i = 0; i < 4000; i++) console.log('line ' + i)\"" });
  const saved = /saved at (.+?\.txt)/.exec(out)?.[1];
  assert.ok(saved, out.slice(-300));
  const head = await byName.read_file.run({ path: saved, offset: 1, limit: 5 });
  assert.match(head, /line 0/, "the start that was cut from the result is in the file");
});