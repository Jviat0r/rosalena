/**
 * OpenAI's Codex CLI as an engine (codex-engine.mjs), against a fake `codex` that streams
 * the real `codex exec --json` shapes (test/fixtures/fake-codex.mjs). The real CLI is
 * never called here.
 *
 *   - Codex is found: the override, PATH, npm's native binary behind codex.cmd, OpenAI's
 *     installer folders; nothing is guessed when none is there
 *   - `codex login status` is read for signed-in and how (ChatGPT plan or API key)
 *   - Rosalena's Access -> Codex's sandbox / approval flags; options stay before `resume`
 *   - the stream becomes Rosalena's events: run, notice, delta, assistant, tool, run_end,
 *     plus the context meter; the record keeps the engine, the thread and the usage
 *   - the next message resumes that thread, and its usage is this run's share only
 *   - Stop ends the process; a missing sign-in is said plainly; parent-session env is
 *     not passed on, a person's own OPENAI_API_KEY is
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  accessFor,
  codexArgs,
  codexEnv,
  codexStatus,
  effortFor,
  findCodex,
  isCodexModel,
  launchFor,
  menuRows,
  parseLoginStatus,
  runCodex,
  runUsage,
} from "../src/codex-engine.mjs";
import { requestCancel } from "../src/runs.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));
const fakeSpawn = (env = {}) => (_command, argv, opts) => spawn(process.execPath, [FAKE, ...argv], { ...opts, shell: false, env: { ...opts.env, ...env } });

test("Codex is found: the override, PATH, the native binary behind npm's codex.cmd, OpenAI's installer folder", () => {
  const files = new Set(["C:\\tools\\fake-codex.mjs"]);
  const exists = (p) => files.has(p);
  assert.equal(findCodex({ env: { ROSALENA_CODEX_EXE: "C:\\tools\\fake-codex.mjs", PATH: "" }, platform: "win32", exists }), "C:\\tools\\fake-codex.mjs");
  assert.equal(findCodex({ env: { ROSALENA_CODEX_EXE: "C:\\nope.exe", PATH: "" }, platform: "win32", exists }), null, "a wrong override is not silently replaced");

  // npm global: %APPDATA%\npm\codex.cmd launches the platform package's native binary.
  const npm = "C:\\Users\\me\\AppData\\Roaming\\npm";
  // Windows paths whatever the host is (the release gate runs this on Linux).
  const native = win32.join(npm, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  const npmFiles = new Set([win32.join(npm, "codex.cmd"), native]);
  const viaPath = findCodex({ env: { PATH: `C:\\Windows;${npm}`, APPDATA: "" }, platform: "win32", arch: "x64", exists: (p) => npmFiles.has(p) });
  assert.equal(viaPath, native, "codex.cmd on PATH is swapped for the binary it starts");
  const viaAppData = findCodex({ env: { PATH: "", APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, platform: "win32", arch: "x64", exists: (p) => npmFiles.has(p) });
  assert.equal(viaAppData, native, "the npm global folder is looked in even when it is not on PATH");
  const cmdOnly = findCodex({ env: { PATH: npm, APPDATA: "" }, platform: "win32", arch: "x64", exists: (p) => p === win32.join(npm, "codex.cmd") });
  assert.equal(cmdOnly, win32.join(npm, "codex.cmd"),"a codex.cmd without its binary is the last resort, not nothing");

  // OpenAI's standalone installer (install.ps1) puts it under %LOCALAPPDATA%\Programs\OpenAI\Codex\bin.
  const L = "C:\\Users\\me\\AppData\\Local";
  const standalone = win32.join(L, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  assert.equal(findCodex({ env: { PATH: "", LOCALAPPDATA: L, USERPROFILE: "C:\\Users\\me" }, platform: "win32", exists: (p) => p === standalone }), standalone);
  // ~/.local/bin on Linux and macOS (install.sh).
  assert.equal(findCodex({ env: { PATH: "", HOME: "/home/me" }, platform: "linux", exists: (p) => p === posix.join("/home/me", ".local", "bin", "codex") }), posix.join("/home/me", ".local", "bin", "codex"));
  // Nothing installed anywhere: null, not a guess.
  assert.equal(findCodex({ env: { PATH: "C:\\Windows", APPDATA: "C:\\x", LOCALAPPDATA: L, USERPROFILE: "C:\\Users\\me" }, platform: "win32", exists: () => false }), null);

  assert.equal(launchFor("C:\\a\\fake-codex.mjs").command, process.execPath, "a .js launcher runs through Node");
  assert.equal(launchFor(join(npm, "codex.cmd"), { platform: "win32" }).shell, true);
  assert.equal(launchFor(native, { platform: "win32" }).env.CODEX_MANAGED_BY_NPM, "1", "npm's binary gets the variable its own launcher sets");
});

test("`codex login status` is read: ChatGPT plan, API key, not signed in", async () => {
  assert.deepEqual(parseLoginStatus({ code: 0, stderr: "Logged in using ChatGPT\n" }), { loggedIn: true, authMethod: "chatgpt" });
  assert.deepEqual(parseLoginStatus({ code: 0, stderr: "API key configured - sk-proj-***ABCDE\nAuthentication is checked when you send a request.\n" }), { loggedIn: true, authMethod: "api-key" });
  assert.deepEqual(parseLoginStatus({ code: 1, stderr: "Not logged in\n" }), { loggedIn: false, authMethod: null });
  assert.deepEqual(parseLoginStatus({ code: 1, stderr: "Not logged in\n" }, { CODEX_API_KEY: "sk-x" }), { loggedIn: true, authMethod: "api-key (CODEX_API_KEY)" }, "codex exec also answers with CODEX_API_KEY");

  const viaFake = (env) => (_exe, args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [FAKE, ...args], { env: { ...process.env, ...env } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
    });
  const signed = await codexStatus({ fresh: true, exe: "codex", run: viaFake({}), env: {} });
  assert.deepEqual(signed, { found: true, exe: "codex", version: "0.167.0", loggedIn: true, authMethod: "chatgpt" });
  const unsigned = await codexStatus({ fresh: true, exe: "codex", run: viaFake({ FAKE_CODEX_UNSIGNED: "1" }), env: {} });
  assert.equal(unsigned.loggedIn, false);
  assert.equal(JSON.stringify(await codexStatus({ fresh: true, exe: "codex", run: viaFake({ FAKE_CODEX_APIKEY: "1" }), env: {} })).includes("ABCDE"), false, "the masked key is not kept");
  assert.deepEqual(await codexStatus({ fresh: true, exe: null }), { found: false, exe: null, version: null, loggedIn: false, authMethod: null });
});

test("Access maps to Codex's sandbox and approvals; options stay before `resume`, pictures last", () => {
  assert.deepEqual(accessFor({ accessMode: "read" }).args, ["--sandbox", "read-only"]);
  assert.deepEqual(accessFor({ accessMode: "full", planMode: true }).args, ["--sandbox", "read-only"], "plan mode never writes");
  assert.deepEqual(accessFor({ accessMode: "workspace" }).args, ["--sandbox", "workspace-write"]);
  assert.deepEqual(accessFor({ accessMode: "auto" }).args, ["--approve-for-me"]);
  assert.deepEqual(accessFor({ accessMode: "full" }).args, ["--sandbox", "danger-full-access"]);

  const argv = codexArgs({ model: "codex/gpt-6.1-sol", session: "t1", access: accessFor({ accessMode: "auto" }), root: "C:/w", effort: "high", developerInstructions: 'Be "brief"', addDirs: ["C:/att"], images: ["C:/att/a.png"] });
  assert.deepEqual(argv.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  assert.equal(argv[argv.indexOf("--cd") + 1], "C:/w");
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.ok(argv.includes('model_reasoning_effort="high"'));
  assert.ok(argv.includes('developer_instructions="Be \\"brief\\""'), "a TOML string, quoted");
  assert.deepEqual(argv.slice(-4), ["resume", "t1", "--image", "C:/att/a.png"]);
  assert.ok(argv.indexOf("--add-dir") < argv.indexOf("resume"));
  const plain = codexArgs({ model: "codex/default", access: accessFor({}) });
  assert.ok(!plain.includes("-m") && !plain.includes("resume") && !plain.includes("-c"), "default lets Codex choose its model and level");

  assert.equal(effortFor("codex/gpt-6-luna", "max"), "max");
  assert.equal(effortFor("codex/gpt-6-luna", "xhigh", { ultracode: true }), "xhigh", "Luna has no ultra");
  assert.equal(effortFor("codex/gpt-6.1-sol", "xhigh", { ultracode: true }), "ultra", "Ultracode is Codex's own ultra");
  assert.equal(effortFor("codex/gpt-6-astra", "bogus"), "");

  assert.ok(isCodexModel("codex/gpt-6-astra") && !isCodexModel("claude-code/opus") && !isCodexModel("openai/gpt-6"));
  const rows = menuRows();
  assert.deepEqual(rows.map((r) => r.id), ["codex/default", "codex/gpt-6.1-sol", "codex/gpt-6-astra", "codex/gpt-6.1-terra", "codex/gpt-6-luna"]);
  assert.ok(rows.every((r) => r.provider === "codex" && r.chat && r.contextMax > 0 && r.efforts.length));
  assert.deepEqual(rows.find((r) => r.id === "codex/gpt-6-luna").efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("parent-session variables are not passed on; a person's own key and CODEX_HOME are", () => {
  const env = codexEnv({ PATH: "p", OPENAI_BASE_URL: "http://127.0.0.1:8787/v1", CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1", CODEX_THREAD_ID: "x", ROSALENA_ROUTER_TOKEN: "t", ELECTRON_RUN_AS_NODE: "1", OPENAI_API_KEY: "mine", CODEX_API_KEY: "mine2", CODEX_HOME: "D:/c" });
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_API_KEY", "CODEX_HOME", "OPENAI_API_KEY", "PATH"]);
});

test("the stream becomes Rosalena's events and record, and the next message resumes the thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-engine-"));
  const events = [];
  const saved = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY, sbx: process.env.CODEX_SANDBOX };
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.OPENAI_API_KEY = "sk-mine";
  process.env.CODEX_SANDBOX = "seatbelt";
  let first;
  try {
    first = await runCodex({ task: "say hi", model: "codex/default", root: dir, runsDir: join(dir, "runs"), onEvent: (e) => events.push(e), exe: "codex", spawnImpl: fakeSpawn() });
  } finally {
    for (const [k, v] of [["OPENAI_BASE_URL", saved.base], ["OPENAI_API_KEY", saved.key], ["CODEX_SANDBOX", saved.sbx]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.equal(first.error, null, first.error);
  assert.match(first.answer, /^done: say hi \[sandbox workspace-write, cd set, env base=none key=yes sandboxvar=none\]$/, "the task went over stdin; the router's URL and a parent's sandbox flag did not");
  assert.equal(first.session, "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.equal(first.steps, 2);
  const types = events.map((e) => e.type);
  for (const t of ["run", "notice", "delta", "assistant", "tool", "ui/context", "run_end"]) assert.ok(types.includes(t), `${t} in ${types.join(",")}`);
  const tools = events.filter((e) => e.type === "tool");
  assert.deepEqual(tools.map((t) => t.name), ["shell", "apply_patch", "solbrowser.read_url", "web_search"]);
  assert.equal(tools[0].ok, true);
  assert.equal(tools[0].preview, "v24.18.0\n");
  assert.deepEqual(tools[0].args, { command: "node --version" });
  assert.equal(tools[2].preview, "Example Domain");
  assert.ok(tools.every((t) => t.step === 1));
  assert.deepEqual(events.filter((e) => e.type === "assistant").map((e) => e.step), [1, 2]);
  const notices = events.filter((e) => e.type === "notice").map((e) => e.text);
  assert.ok(notices.some((t) => /^Codex on its default model \(workspace-write sandbox/.test(t)), notices.join(" | "));
  assert.ok(notices.some((t) => /^Thinking: /.test(t)));
  assert.ok(notices.some((t) => /^Plan: \[x\] Check node {2}\[ \] Answer$/.test(t)));
  assert.ok(notices.some((t) => /model rerouted/.test(t)), "a non-fatal error item is shown");
  assert.deepEqual(first.usage.total, { calls: 1, prompt: 9000, completion: 300, cached: 6000, unmeasured: 0, usd: 0, priced: 0 });
  assert.equal(first.contextMeter.window, 272_000);
  assert.equal(first.contextMeter.used, 1800, "9000 input over 5 calls (4 tool rounds + the answer)");

  const record = JSON.parse(readFileSync(first.runFile, "utf8"));
  assert.equal(record.engine, "codex");
  assert.equal(record.session, first.session);
  assert.equal(record.engineTotals.input_tokens, 9000);
  assert.equal(record.usage.total.prompt, 9000);
  assert.equal(record.contextMeter.used, 1800);

  const later = [];
  const second = await runCodex({
    task: "and again",
    onEvent: (e) => later.push(e),
    model: "codex/gpt-6.1-sol",
    root: dir,
    runsDir: join(dir, "runs"),
    session: first.session,
    previousTotals: record.engineTotals,
    accessMode: "auto",
    effort: "high",
    appendSystemPrompt: "Answer as a reviewer.",
    exe: "codex",
    spawnImpl: fakeSpawn(),
  });
  assert.match(second.answer, /\(resumed 0199a213-81c0-7800-8aa1-bbab2a035a53\) \[sandbox auto-review, model gpt-6\.1-sol, effort high, role Answer as a reviewer\./);
  assert.equal(second.usage.total.prompt, 9000, "the resumed thread's total minus the earlier run's");
  assert.equal(second.contextMeter.window, 500_000);
  assert.ok(later.some((e) => e.type === "notice" && /not allowed to run: rm -rf build/.test(e.text)), "a declined command is said");
});

test("Stop ends the Codex process, and a missing sign-in is said plainly", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-engine-stop-"));
  const runsDir = join(dir, "runs");
  const pending = runCodex({ task: "long", runId: "r-20261109-100000-cxstop", root: dir, runsDir, exe: "codex", spawnImpl: fakeSpawn({ FAKE_CODEX_SLEEP_MS: "20000" }) });
  await new Promise((done) => setTimeout(done, 800));
  requestCancel({ dir: runsDir, id: "r-20261109-100000-cxstop" });
  const stopped = await pending;
  assert.equal(stopped.stopped, "cancelled");
  assert.equal(stopped.error, null);
  assert.ok(stopped.ms < 15_000, `stopped in ${stopped.ms} ms`);

  const beforeTurn = await runCodex({ task: "hi", root: dir, runsDir, exe: "codex", spawnImpl: fakeSpawn({ FAKE_CODEX_FAIL: "stderr" }) });
  assert.equal(beforeTurn.error, "Codex isn't signed in: run `codex login` in a terminal (it opens a ChatGPT sign-in), then send this again.");
  const expired = await runCodex({ task: "hi", root: dir, runsDir, exe: "codex", spawnImpl: fakeSpawn({ FAKE_CODEX_FAIL: "turn" }) });
  assert.match(expired.error, /^Codex isn't signed in: run `codex login`/);

  const missing = await runCodex({ task: "hi", root: dir, runsDir, exe: null });
  assert.match(missing.error, /not installed.*npm install -g @openai\/codex/);
});

test("this run's usage: the thread total, minus the earlier run's when it was resumed", () => {
  assert.deepEqual(runUsage({ input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 }), { input: 10, cached: 4, output: 2, reasoning: 1 });
  assert.deepEqual(runUsage({ input_tokens: 30, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 }, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 }), { input: 20, cached: 6, output: 3, reasoning: 1 });
  assert.deepEqual(runUsage({ input_tokens: 8, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2, reasoning_output_tokens: 1 }), { input: 8, cached: 0, output: 1, reasoning: 0 }, "a total that restarted is this run's own");
});
