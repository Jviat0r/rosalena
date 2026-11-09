/**
 * Claude Code as an engine (claude-engine.mjs), against a fake `claude` that streams the
 * real message shapes (test/fixtures/fake-claude.mjs). The real CLI is never called here.
 *
 *   - Rosalena's Access -> Claude Code's permission mode; the task stays right after -p
 *   - the stream becomes Rosalena's events: run, delta, assistant, tool, notice, run_end
 *   - the record keeps the engine, Claude Code's session, the answer and the usage
 *   - the next message resumes that session; Stop ends the process
 *   - a missing sign-in is said plainly; the parent session's env is not passed on
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeArgs, claudeEnv, findClaudeCode, isClaudeCodeModel, menuRows, permissionModeFor, runClaudeCode } from "../src/claude-engine.mjs";

test("the desktop app's Claude Code is found in its Claude-Data folder (version, then hash)", () => {
  // The layout the Windows desktop app uses since late 2026, on a fake file system.
  const L = "C:\\Users\\me\\AppData\\Local";
  const root = join(L, "Claude-Data", "claude_pzs8sxrjxfjjc", "claude-code");
  const files = new Set([
    join(L, "Claude-Data"),
    root,
    join(root, "2.1.300", "aaa", "claude.exe"),
    join(root, "2.1.317", "a33aa5518497", "claude.exe"),
  ]);
  const dirs = {
    [join(L, "Claude-Data")]: ["claude_pzs8sxrjxfjjc", "logs"],
    [root]: ["2.1.300", "2.1.317", "tmp"],
    [join(root, "2.1.300")]: ["aaa"],
    [join(root, "2.1.317")]: ["a33aa5518497"],
  };
  const found = findClaudeCode({
    env: { LOCALAPPDATA: L, APPDATA: "", PATH: "" },
    platform: "win32",
    exists: (p) => files.has(p),
    list: (p) => {
      if (!dirs[p]) throw new Error(`no dir ${p}`);
      return dirs[p];
    },
  });
  assert.equal(found, join(root, "2.1.317", "a33aa5518497", "claude.exe"), "the newest version wins");
  // Nothing installed anywhere: null, not a guess.
  assert.equal(findClaudeCode({ env: { LOCALAPPDATA: L, PATH: "" }, platform: "win32", exists: () => false, list: () => [] }), null);
});
import { requestCancel } from "../src/runs.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const fakeSpawn = (env = {}) => (_exe, argv, opts) => spawn(process.execPath, [FAKE, ...argv], { ...opts, env: { ...opts.env, ...env } });

test("Access maps to Claude Code's permission modes, and the task stays right after -p", () => {
  assert.equal(permissionModeFor({ accessMode: "workspace" }), "acceptEdits");
  assert.equal(permissionModeFor({ accessMode: "auto" }), "auto");
  assert.equal(permissionModeFor({ accessMode: "full" }), "bypassPermissions");
  assert.equal(permissionModeFor({ accessMode: "read" }), "plan");
  assert.equal(permissionModeFor({ accessMode: "full", planMode: true }), "plan");
  const argv = claudeArgs({ task: "fix it", model: "claude-code/sonnet", session: "s1", permissionMode: "auto", mcp: { mcpServers: {} }, addDirs: ["C:/att"] });
  assert.deepEqual(argv.slice(0, 2), ["-p", "fix it"]);
  assert.ok(argv.includes("--resume") && argv[argv.indexOf("--resume") + 1] === "s1");
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  assert.ok(!claudeArgs({ task: "x", model: "claude-code/default", permissionMode: "plan" }).includes("--model"), "default lets Claude Code choose");
  assert.ok(isClaudeCodeModel("claude-code/opus") && !isClaudeCodeModel("local/qwen"));
  assert.deepEqual(menuRows().map((r) => r.id), ["claude-code/default", "claude-code/opus", "claude-code/sonnet", "claude-code/haiku"]);
});

test("a parent Claude Code session's variables are not passed on; a person's own API key is", () => {
  const env = claudeEnv({ PATH: "p", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_BASE_URL: "http://x", ANTHROPIC_API_KEY: "mine", ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "PATH"]);
});

test("the stream becomes Rosalena's events and record, and the next message resumes the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-engine-"));
  const events = [];
  const first = await runClaudeCode({ task: "say hi", model: "claude-code/default", root: dir, runsDir: join(dir, "runs"), onEvent: (e) => events.push(e), exe: "claude", spawnImpl: fakeSpawn(), lendSolBrowser: false });
  assert.equal(first.error, null, first.error);
  assert.match(first.answer, /^done: say hi \[mode acceptEdits\]$/);
  assert.equal(first.session, "sess-new-1");
  assert.equal(first.steps, 2);
  const types = events.map((e) => e.type);
  for (const t of ["run", "notice", "delta", "assistant", "tool", "run_end"]) assert.ok(types.includes(t), `${t} in ${types.join(",")}`);
  const tool = events.find((e) => e.type === "tool");
  assert.equal(tool.name, "Bash");
  assert.equal(tool.ok, true);
  assert.equal(tool.preview, "v24.18.0");
  assert.match(events.find((e) => e.type === "notice" && /not allowed/.test(e.text)).text, /Bash\(npm test\)/);
  assert.deepEqual(first.usage.total, { calls: 1, prompt: 2150, completion: 40, cached: 2000, unmeasured: 0, usd: 0.0123, priced: 1 });

  const record = JSON.parse(readFileSync(first.runFile, "utf8"));
  assert.equal(record.engine, "claude-code");
  assert.equal(record.session, "sess-new-1");
  assert.equal(record.usage.total.usd, 0.0123);

  const second = await runClaudeCode({ task: "and again", model: "claude-code/opus", root: dir, runsDir: join(dir, "runs"), session: first.session, accessMode: "full", exe: "claude", spawnImpl: fakeSpawn(), lendSolBrowser: false });
  assert.match(second.answer, /\(resumed sess-new-1\) \[mode bypassPermissions, model opus\]/);
});

test("Stop ends the Claude Code process, and a missing sign-in is said plainly", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-engine-stop-"));
  const runsDir = join(dir, "runs");
  const pending = runClaudeCode({ task: "long", runId: "r-20261104-100000-stop", root: dir, runsDir, exe: "claude", spawnImpl: fakeSpawn({ FAKE_CLAUDE_SLEEP_MS: "20000" }), lendSolBrowser: false });
  await new Promise((done) => setTimeout(done, 800));
  requestCancel({ dir: runsDir, id: "r-20261104-100000-stop" });
  const stopped = await pending;
  assert.equal(stopped.stopped, "cancelled");
  assert.ok(stopped.ms < 15_000, `stopped in ${stopped.ms} ms`);

  const unsigned = await runClaudeCode({ task: "hi", root: dir, runsDir, exe: "claude", spawnImpl: fakeSpawn({ FAKE_CLAUDE_FAIL: "1" }), lendSolBrowser: false });
  assert.match(unsigned.error, /not signed in/);

  const missing = await runClaudeCode({ task: "hi", root: dir, runsDir, exe: null, lendSolBrowser: false });
  assert.match(missing.error, /not installed/);
});
