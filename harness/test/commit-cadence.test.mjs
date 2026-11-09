/**
 * commit-cadence (plugins/rosa-commit-cadence) and the two engine hooks it uses:
 *
 *   - the harness, not the model, sizes a change: small / large / blocked from the real diff
 *   - each mode maps a tier to commit / park / stop, and only a clear yes approves
 *   - end to end through the real plugin loader against temporary git repos: loose mode
 *     commits small pieces, parks a migration, leaves the person's own edits alone, and
 *     commits the parked work only after the person's own "Commit them"
 *   - beforeFinish: a plugin can send a final answer back for one more round, once per run
 *   - registerWorkspaceTool: checkpoint runs without asking in Workspace write, never in
 *     Read only or plan mode
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin, { CHECK_COMMAND, addedDependencies, classify, decideAction, isAffirmative, parseNumstat, parsePorcelain, splitRisky } from "../plugins/rosa-commit-cadence/plugin.mjs";
import { runAgent } from "../src/agent.mjs";
import { decide, registerWorkspaceTool } from "../src/permissions.mjs";
import { HOOK_NAMES, createHookRunner, loadPlugins } from "../src/plugins.mjs";

const file = (path, extra = {}) => ({ path, status: "M", added: 5, deleted: 2, binary: false, bytes: 400, mixed: false, diff: "+a\n-b", ...extra });

// --------------------------------------------------------------------------- classify

test("a few small edits are small", () => {
  const v = classify([file("src/nav.tsx"), file("src/nav.css")]);
  assert.equal(v.tier, "small");
  assert.equal(v.lines, 14);
});

test("too many lines or files is large", () => {
  assert.equal(classify([file("a.ts", { added: 250, deleted: 60 })]).tier, "large");
  assert.equal(classify(Array.from({ length: 13 }, (_, i) => file(`f${i}.ts`))).tier, "large");
  assert.equal(classify([file("a.ts", { added: 250, deleted: 60 })], { maxLines: 1000 }).tier, "small");
});

test("deleting a file that existed before the run is large, with the shipped config too", () => {
  const v = classify([file("a.ts", { status: "D" })]);
  assert.equal(v.tier, "large");
  assert.match(v.reasons.join(), /deletes 1 file/);
  const shipped = JSON.parse(readFileSync(new URL("../plugins/rosa-commit-cadence/plugin.json", import.meta.url), "utf8")).config;
  assert.equal(classify([file("a.ts", { status: "D" })], shipped).tier, "large");
});

test("small commits that add up past the per-run budget are large", () => {
  assert.equal(classify([file("a.ts")], { runLinesSoFar: 995 }).tier, "large");
  assert.equal(classify([file("a.ts")], { runFilesSoFar: 30 }).tier, "large");
  assert.equal(classify([file("a.ts")], { runLinesSoFar: 500 }).tier, "small");
});

test("hooks, agent config, symlinks and new executables are large", () => {
  for (const path of [".husky/pre-commit", ".pre-commit-config.yaml", ".mcp.json", ".gitmodules", ".devcontainer/devcontainer.json"]) {
    assert.equal(classify([file(path)]).tier, "large", path);
  }
  assert.equal(classify([file("bin/run", { executable: true })]).tier, "large");
  assert.equal(classify([file("link", { symlink: true })]).tier, "large");
  assert.equal(classify([file(".envrc")]).tier, "blocked");
});

test("lockfiles, migrations, CI and deploy config are large even when tiny", () => {
  for (const path of ["package-lock.json", "db/migrations/0003_add_users.sql", ".github/workflows/ci.yml", "wrangler.toml", "src/auth/session.ts", "Dockerfile"]) {
    assert.equal(classify([file(path, { added: 1, deleted: 0 })]).tier, "large", path);
  }
});

test("package.json: a script line is small, a dependency is large", () => {
  assert.equal(classify([file("package.json", { diff: '+    "dev": "vite --port 5174",' })]).tier, "small");
  const v = classify([file("package.json", { diff: '+    "zod": "^3.23.8",' })]);
  assert.equal(v.tier, "large");
  assert.match(v.reasons.join(), /dependency/);
});

test("secrets block the commit in every mode", () => {
  assert.equal(classify([file(".env", { status: "?" })]).tier, "blocked");
  assert.equal(classify([file("deploy/server.pem", { status: "A" })]).tier, "blocked");
  assert.equal(classify([file("src/config.ts", { diff: '+const key = "AKIAABCDEFGHIJKLMNOP";' })]).tier, "blocked");
  assert.equal(classify([file("src/x.ts", { diff: "+-----BEGIN OPENSSH PRIVATE KEY-----" })]).tier, "blocked");
  // A template and a removed line are not secrets being added.
  assert.equal(classify([file(".env.example", { status: "A" })]).tier, "small");
  assert.equal(classify([file("src/config.ts", { diff: '-const key = "AKIAABCDEFGHIJKLMNOP";' })]).tier, "small");
  assert.equal(decideAction("autonomous", "blocked"), "stop");
});

test("a file the person was already editing is never committed without them", () => {
  const v = classify([file("src/app.ts", { mixed: true })]);
  assert.equal(v.tier, "large");
  assert.match(v.reasons.join(), /your own uncommitted edits/);
});

test("images are fine, other binaries and huge files are not", () => {
  assert.equal(classify([file("public/hero.webp", { binary: true, status: "A" })]).tier, "small");
  assert.equal(classify([file("tools/helper.exe", { binary: true, status: "A" })]).tier, "large");
  assert.equal(classify([file("data/dump.json", { bytes: 9 * 1024 * 1024, status: "A" })]).tier, "blocked");
});

// --------------------------------------------------------------------------- modes and wording

test("each mode maps tiers to the right action", () => {
  assert.deepEqual(["small", "large", "blocked"].map((t) => decideAction("off", t)), ["skip", "skip", "skip"]);
  assert.deepEqual(["small", "large", "blocked"].map((t) => decideAction("ask", t)), ["park", "park", "stop"]);
  assert.deepEqual(["small", "large", "blocked"].map((t) => decideAction("loose", t)), ["commit", "park", "stop"]);
  assert.deepEqual(["small", "large", "blocked"].map((t) => decideAction("autonomous", t)), ["commit", "commit", "stop"]);
});

test("only a clear yes approves", () => {
  for (const yes of ["yes", "Yes please", "Commit them", "ok", "go ahead", "lgtm", "sure, do it"]) assert.equal(isAffirmative(yes), true, yes);
  for (const no of ["Not now", "no", "wait, let me look", "don't commit the migration", "yes but not the migration", "", "what changed?"]) {
    assert.equal(isAffirmative(no), false, no);
  }
});

test("porcelain -z and numstat -z parse", () => {
  const entries = parsePorcelain(" M src/a.ts\0?? new file.txt\0D  old.ts\0A  added.ts\0");
  assert.deepEqual(entries, [
    { path: "src/a.ts", status: "M" },
    { path: "new file.txt", status: "?" },
    { path: "old.ts", status: "D" },
    { path: "added.ts", status: "A" },
  ]);
  const stats = parseNumstat("3\t1\tsrc/a.ts\0-\t-\timg.png\0");
  assert.deepEqual(stats.get("src/a.ts"), { added: 3, deleted: 1, binary: false });
  assert.equal(stats.get("img.png").binary, true);
});

// --------------------------------------------------------------------------- splitting a mixed checkpoint

const depManifest = file("package.json", { diff: '+  "dependencies": {\n+    "left-pad": "1.3.0"\n+  },' });
const usesDep = file("pad.js", { status: "?", diff: "+import pad from 'left-pad';\n+export const padId = (n) => pad(n, 6, '0');" });
const typo = file("greet.js", { diff: "-  return `Helo`;\n+  return `Hello`;" });

test("a manifest's added dependencies are read from its diff; the package's own version is not one", () => {
  assert.deepEqual(addedDependencies([depManifest, typo]), ["left-pad"]);
  assert.deepEqual(addedDependencies([file("package.json", { diff: '-  "version": "1.0.0",\n+  "version": "1.0.1",' })]), []);
  assert.deepEqual(addedDependencies([file("requirements.txt", { diff: "+requests==2.32.3\n+# a comment" })]), ["requests"]);
});

test("a mixed checkpoint splits: the dependency and the file that uses it go together, the typo fix does not", () => {
  const split = splitRisky([depManifest, usesDep, typo]);
  assert.deepEqual(split.risky, ["package.json", "pad.js"]);
  assert.deepEqual(split.rest, ["greet.js"]);
  assert.ok(split.reasons.some((r) => /pad\.js uses left-pad/.test(r)), split.reasons.join("; "));
  // Size is not a per-file risk: two big but ordinary files do not split.
  assert.deepEqual(splitRisky([file("a.ts", { added: 400 }), file("b.ts")]).risky, []);
  assert.deepEqual(splitRisky([file("migrations/001.sql"), typo]).risky, ["migrations/001.sql"]);
});

test("check commands are recognised; other commands are not", () => {
  for (const c of ["npm test", "npm run build", "pnpm lint", "npx tsc --noEmit", "pytest -q", "cargo test", "go test ./...", "node --test"]) assert.ok(CHECK_COMMAND.test(c), c);
  for (const c of ["ls", "git status", "npm install", "cat greet.js"]) assert.ok(!CHECK_COMMAND.test(c), c);
});

// --------------------------------------------------------------------------- end to end, real loader, real git

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "cadence-"));
  const g = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Test");
  g("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "README.md"), "# test\n");
  g("add", "README.md");
  g("commit", "-q", "-m", "init");
  return { dir, g, log: () => g("log", "--format=%s", "-n", "20").trim().split("\n") };
}

async function host(dir, mode) {
  const home = mkdtempSync(join(tmpdir(), "cadence-home-"));
  process.env.ROSALENA_HOME = home;
  writeFileSync(join(home, "commit-cadence.json"), JSON.stringify({ default: mode }));
  const pluginsDir = mkdtempSync(join(tmpdir(), "cadence-plugins-"));
  cpSync(fileURLToPath(new URL("../plugins/rosa-commit-cadence/", import.meta.url)), join(pluginsDir, "rosa-commit-cadence"), { recursive: true });
  const loaded = await loadPlugins({ dir: pluginsDir, root: dir });
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.tools.find((t) => t.name === "checkpoint");
  const hooks = createHookRunner(loaded.hooks ?? []);
  const start = (messages = []) => hooks.fire("onRunStart", { root: dir, depth: 0, run: { id: "r", started: Date.now(), depth: 0, state: new Map() }, messages });
  return { tool, start, commands: loaded.commands, hooks };
}

test("loose mode: small piece commits, big piece parks, the person's edits are left alone, their yes commits the rest", async () => {
  const { dir, g, log } = repo();
  writeFileSync(join(dir, "README.md"), "# test\n\nmy notes\n"); // the person's own uncommitted work
  const { tool, start } = await host(dir, "loose");
  await start();

  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "nav.ts"), "export const open = false;\n");
  assert.match(await tool.run({ message: "feat(nav): add menu state" }), /^committed [0-9a-f]+/);

  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations", "001_users.sql"), "create table users(id int);\n");
  assert.match(await tool.run({ message: "feat(db): users table" }), /HELD BACK/);

  writeFileSync(join(dir, "src", "footer.ts"), "export const year = 2026;\n");
  assert.match(await tool.run({ message: "feat(footer): add year" }), /^committed/);
  assert.deepEqual(log(), ["feat(footer): add year", "feat(nav): add menu state", "init"]);
  const status = g("status", "--porcelain");
  assert.match(status, /README\.md/);
  assert.match(status, /migrations\//);

  assert.match(await tool.run({ action: "review" }), /ask_user ONCE/);
  assert.match(await tool.run({ action: "approve" }), /not approved/, "the model cannot approve for the person");
  await start([{ role: "user", content: "Commit them" }]);
  assert.match(await tool.run({ action: "approve" }), /committed:\n[0-9a-f]+ "feat\(db\): users table"/);
  assert.equal(log()[0], "feat(db): users table");
  assert.match(g("status", "--porcelain"), /README\.md/, "still the person's, never committed");
  assert.match(g("log", "-1", "--format=%B"), /Rosalena-Checkpoint: auto/);
  rmSync(dir, { recursive: true, force: true });
});

test("loose mode, one checkpoint for everything: asked to split, the small part commits and the dependency waits", async () => {
  const { dir, g, log } = repo();
  writeFileSync(join(dir, "package.json"), '{\n  "name": "x",\n  "type": "module"\n}\n');
  writeFileSync(join(dir, "greet.js"), "export const greet = (n) => `Helo, ${n}!`;\n");
  g("add", "package.json", "greet.js");
  g("commit", "-q", "-m", "app");
  const { tool, start } = await host(dir, "loose");
  await start();

  // What the local model did on 2026-11-03: the big item first, everything in one go.
  writeFileSync(join(dir, "package.json"), '{\n  "name": "x",\n  "type": "module",\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n');
  writeFileSync(join(dir, "pad.js"), "import pad from 'left-pad';\nexport const padId = (n) => pad(n, 6, '0');\n");
  writeFileSync(join(dir, "greet.js"), "export const greet = (n) => `Hello, ${n}!`;\n");

  assert.match(await tool.run({ action: "review" }), /3 file\(s\) changed in this run are not checkpointed yet/, "review does not wave loose work through");
  const asked = await tool.run({ message: "feat: padId, greet fix" });
  assert.match(asked, /NOT COMMITTED YET/);
  assert.match(asked, /"files": \["greet\.js"\]/);
  assert.match(asked, /"files": \["package\.json","pad\.js"\]/);
  assert.deepEqual(log(), ["app", "init"], "nothing committed while it asks");

  assert.match(await tool.run({ files: ["greet.js"], message: "fix(greet): Helo -> Hello" }), /^committed/);
  assert.match(await tool.run({ files: ["package.json", "pad.js"], message: "feat: padId with left-pad" }), /HELD BACK/);
  assert.deepEqual(log(), ["fix(greet): Helo -> Hello", "app", "init"]);
  assert.match(await tool.run({ action: "review" }), /feat: padId with left-pad[\s\S]*ask_user ONCE/);
  rmSync(dir, { recursive: true, force: true });
});

test("a model that ignores the split request gets the old behaviour: the whole set waits", async () => {
  const { dir, log } = repo();
  const { tool, start } = await host(dir, "loose");
  await start();
  writeFileSync(join(dir, "package.json"), '{\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n');
  writeFileSync(join(dir, "notes.md"), "notes\n");
  assert.match(await tool.run({ message: "everything" }), /NOT COMMITTED YET/);
  assert.match(await tool.run({ message: "everything" }), /HELD BACK/);
  assert.deepEqual(log(), ["init"]);
});

test("a 'not now' answer commits nothing; the person's /plugin approve does", async () => {
  const { dir, log } = repo();
  const { tool, start, commands } = await host(dir, "ask");
  await start();
  writeFileSync(join(dir, "a.ts"), "export {};\n");
  assert.match(await tool.run({ message: "feat: a" }), /HELD BACK/);
  await tool.run({ action: "review" });
  await start([{ role: "user", content: "Not now" }]);
  assert.match(await tool.run({ action: "approve" }), /not approved/);
  assert.deepEqual(log(), ["init"]);
  // Typing the command is the approval: no model in between.
  const out = await commands.get("rosa-commit-cadence:approve")([]);
  assert.match(out, /committed:/);
  assert.deepEqual(log(), ["feat: a", "init"]);
});

// Measured 2026-11-08: after "skip for now just use the mcp like i asked", every later run
// asked about the same held-back commits again instead of doing the request.
test("'skip for now' is remembered: the same held-back set is not asked about again, a new one is", async () => {
  const { dir } = repo();
  const { tool, start, hooks } = await host(dir, "ask");
  await start();
  writeFileSync(join(dir, "a.ts"), "export {};\n");
  assert.match(await tool.run({ message: "feat: a" }), /HELD BACK/);
  // Not an answer to the question: a message that puts the commits off in passing.
  await start([{ role: "user", content: "skip for now just use the mcp like i asked" }]);
  assert.match(await tool.run({ action: "review" }), /already said not now/);
  const run = { id: "r2", started: Date.now(), depth: 0, state: new Map() };
  const first = await hooks.fire("beforeStep", { run, root: dir, step: 1, depth: 0 });
  assert.match(JSON.stringify(first), /said not now/);
  // Something new is held back: that is worth one question again.
  writeFileSync(join(dir, "b.ts"), "export {};\n");
  assert.match(await tool.run({ message: "feat: b" }), /HELD BACK/);
  assert.match(await tool.run({ action: "review" }), /ask_user ONCE/);
  rmSync(dir, { recursive: true, force: true });
});

test("isDeferral reads a put-off, not a yes", async () => {
  const { isDeferral } = await import("../plugins/rosa-commit-cadence/plugin.mjs");
  for (const text of ["skip for now", "not now", "don't commit yet", "stop asking about commits", "later"]) assert.equal(isDeferral(text), true, text);
  for (const text of ["use the mcp to load the plugins", "commit them", "yes"]) assert.equal(isDeferral(text), false, text);
});

test("a secret stops the commit even in autonomous mode", async () => {
  const { dir, log } = repo();
  const { tool, start } = await host(dir, "autonomous");
  await start();
  writeFileSync(join(dir, ".env"), "TOKEN=abc\n");
  assert.match(await tool.run({ message: "chore: env" }), /NOT COMMITTED/);
  assert.deepEqual(log(), ["init"]);
});

test("off mode never commits", async () => {
  const { dir, log } = repo();
  const { tool, start } = await host(dir, "off");
  await start();
  writeFileSync(join(dir, "a.ts"), "export {};\n");
  assert.match(await tool.run({ message: "feat: a" }), /turned off/);
  assert.deepEqual(log(), ["init"]);
});

test("the plugin's default export has the shape the host expects", () => {
  assert.equal(plugin.id, "rosa-commit-cadence");
  assert.equal(typeof plugin.tools, "function");
  assert.equal(typeof plugin.hooks, "function");
  assert.equal(typeof plugin.commands, "function");
});

// --------------------------------------------------------------------------- the engine hooks it uses

const WS = mkdtempSync(join(tmpdir(), "cadence-loop-"));
const say = (content) => ({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} });
function scripted(script) {
  const bodies = [];
  const fn = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const payload = script[Math.min(bodies.length - 1, script.length - 1)];
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", "x-router-target": "local/test-model" } });
  };
  fn.bodies = bodies;
  return fn;
}

test("beforeFinish is a hook the engine calls", () => {
  assert.ok(HOOK_NAMES.includes("beforeFinish"));
});

test("beforeFinish sends a final answer back, bounded by finishRounds rather than once", async () => {
  const always = { plugin: "holder", name: "beforeFinish", fn: () => "Before you finish: review the held changes." };
  const f = scripted([say("All done.")]);
  const result = await runAgent({ root: WS, onEvent: () => {}, task: "x", fetchImpl: f, extraHooks: [always] });
  // A hook that always asks is bounded, but the bound has to leave room for a real "there
  // are eight items left" to be honoured more than once (five rounds, measured 2026-11-06).
  assert.equal(f.bodies.length, 6, "the answer plus five held-open rounds");
  assert.equal(result.answer, "All done.");
  assert.ok(f.bodies[1].messages.some((m) => m.role === "user" && String(m.content).includes("[holder] Before you finish")));

  // And a caller can turn it back down to the old behaviour.
  const once = scripted([say("All done."), say("Reviewed."), say("never reached")]);
  await runAgent({ root: WS, onEvent: () => {}, task: "x", fetchImpl: once, extraHooks: [always], finishRounds: 1 });
  assert.equal(once.bodies.length, 2, "one extra model call when finishRounds is 1");
});

test("through the real loop: passing tests prompt a checkpoint, and a run that never made one is sent back before it ends", async () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "package.json"), '{\n  "name": "x",\n  "scripts": { "test": "node -e 0" }\n}\n');
  g("add", "package.json");
  g("commit", "-q", "-m", "app");
  const home = mkdtempSync(join(tmpdir(), "cadence-home-"));
  process.env.ROSALENA_HOME = home;
  writeFileSync(join(home, "commit-cadence.json"), JSON.stringify({ default: "loose" }));
  // The bundled copy, in place: a copy elsewhere cannot find the engine's beforeFinish hook.
  const all = await loadPlugins({ root: dir, config: { plugins: { "rosa-process-tracker": { enabled: false } } } });
  const loaded = { hooks: all.hooks.filter((h) => h.plugin === "rosa-commit-cadence"), tools: all.tools.filter((t) => t.name === "checkpoint") };

  const call = (name, args) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: {} });
  const f = scripted([
    call("write_file", { path: "greet.js", content: "export const greet = (n) => `Hello, ${n}!`;\n" }),
    call("run_command", { command: "npm test" }),
    say("All done."),
    say("Checkpointed nothing, but done."),
  ]);
  await runAgent({ root: dir, onEvent: () => {}, task: "fix the greeting", fetchImpl: f, extraHooks: loaded.hooks, extraTools: loaded.tools });
  const userText = (body) => body.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
  assert.match(userText(f.bodies[2]), /Checks just passed, and 1 file\(s\) changed since the last checkpoint: greet\.js/);
  assert.match(userText(f.bodies[3]), /Before you finish: 1 file\(s\) changed in this run are not checkpointed: greet\.js/);
  assert.equal(f.bodies.length, 4);
  rmSync(dir, { recursive: true, force: true });
});

test("a beforeFinish that says nothing leaves the run exactly as before", async () => {
  const quiet = { plugin: "quiet", name: "beforeFinish", fn: () => undefined };
  const f = scripted([say("All done.")]);
  const result = await runAgent({ root: WS, onEvent: () => {}, task: "x", fetchImpl: f, extraHooks: [quiet] });
  assert.equal(f.bodies.length, 1);
  assert.equal(result.answer, "All done.");
});

test("a registered workspace tool runs without asking in Workspace write, and never in Read only or plan mode", () => {
  const call = { function: { name: "checkpoint", arguments: JSON.stringify({ message: "feat: x" }) } };
  const other = { function: { name: "wifi_switch", arguments: "{}" } };
  assert.equal(decide({ call: other, mode: "workspace", root: WS }).action, "ask", "an unregistered plugin tool still asks");
  registerWorkspaceTool("checkpoint");
  assert.equal(decide({ call, mode: "workspace", root: WS }).action, "allow");
  assert.notEqual(decide({ call, mode: "read", root: WS }).action, "allow");
  assert.notEqual(decide({ call, mode: "workspace", root: WS, planning: true }).action, "allow");
  assert.equal(decide({ call: other, mode: "workspace", root: WS }).action, "ask");
});
