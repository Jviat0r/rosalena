#!/usr/bin/env node
/**
 * Same model, same tasks, different harness: a number for "Rosalena finishes more".
 *
 *   node bench/run.mjs --harness rosalena,opencode --model <gguf alias> [--tasks a,b] [--minutes 8] [--out bench/results]
 *
 * Every harness talks to the SAME llama-server (http://127.0.0.1:8080, the model Rosalena's
 * local-model-host loaded), with no other model involved: Rosalena through its router as
 * `local/<model>`, OpenCode through an openai-compatible provider pointed at the server.
 * Each task starts from a fresh copy of its fixture in a temp folder (a git repo with one
 * commit), the harness runs once with a time limit, and then the task's hidden tests are
 * copied in and run. Pass = those tests pass. Nothing is retried and nothing is cherry-picked:
 * every run of every task is in the results file.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TASKS } from "./tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.mjs");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith("--") ? [...pairs, [a.slice(2), all[i + 1]?.startsWith("--") ? true : all[i + 1] ?? true]] : pairs), []),
);
const harnesses = String(args.harness ?? "rosalena").split(",");
const model = String(args.model ?? "");
const minutes = Number(args.minutes ?? 8);
const only = args.tasks ? new Set(String(args.tasks).split(",")) : null;
const outDir = String(args.out ?? join(HERE, "results"));
const llama = String(args.llama ?? "http://127.0.0.1:8080/v1");
// Claude Code is the one harness here that does not use the local model: it runs on the
// person's own Claude login, so it is a "what you would actually use" comparison, not a
// same-model one. Only the local harnesses need --model and a running llama-server.
const localHarnesses = harnesses.filter((h) => h !== "claude");
if (localHarnesses.length && !model) throw new Error("--model <the GGUF alias local-model-host loaded> is required");

/** The newest Claude Code the desktop app installed (its MSIX folder, then the plain one), or --claude-exe. */
function claudeExe() {
  if (args["claude-exe"]) return String(args["claude-exe"]);
  const roots = [
    join(process.env.LOCALAPPDATA ?? "", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude-code"),
    join(process.env.APPDATA ?? "", "Claude", "claude-code"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const v of versions.reverse()) {
      for (const hash of readdirSync(join(root, v))) {
        const exe = join(root, v, hash, process.platform === "win32" ? "claude.exe" : "claude");
        if (existsSync(exe)) return exe;
      }
    }
  }
  return "claude";
}

function run(command, argv, { cwd, timeoutMs, shell = false, env = {}, replaceEnv = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    // stdin closed: `opencode run` reads a piped stdin as part of the message and, given an
    // open pipe that never ends, waits forever without sending a request (seen 2026-11-04).
    const child = spawn(command, argv, { cwd, shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: replaceEnv ? env : { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      err += `\n[bench: killed after ${timeoutMs} ms]`;
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - started, timedOut: err.includes("[bench: killed") });
    });
  });
}

function fixture(task) {
  const dir = mkdtempSync(join(tmpdir(), `bench-${task.id}-`));
  for (const [rel, text] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const g = (...a) => spawnSync("git", a, { cwd: dir, windowsHide: true });
  g("init", "-q");
  g("-c", "user.email=b@e.ch", "-c", "user.name=bench", "add", "-A");
  g("-c", "user.email=b@e.ch", "-c", "user.name=bench", "commit", "-q", "-m", "fixture");
  return dir;
}

const HARNESS = {
  async rosalena(task, dir) {
    const r = await run(process.execPath, [CLI, "--json", "--quiet", "--root", dir, "--class", `local/${model}`, "--steps", "40", "--access", "full", "--max-minutes", String(minutes), task.prompt], { cwd: dir, timeoutMs: (minutes + 1) * 60_000 });
    let result = null;
    try {
      result = JSON.parse(r.out.trim().split("\n").at(-1));
    } catch {
      /* no JSON line: it crashed */
    }
    return { ms: r.ms, timedOut: r.timedOut, steps: result?.steps ?? null, stopped: result?.stopped ?? null, error: result?.error ?? (result ? null : r.err.slice(-300)) };
  },
  // Claude Code headless, on the person's own claude.ai login (ANTHROPIC_* is stripped so a
  // session variable cannot reroute it), edits accepted, only node/npm allowed as commands,
  // and none of the person's MCP servers (an empty, strict MCP config). Their CLAUDE.md and
  // hooks still load: that is Claude Code as they use it.
  async claude(task, dir) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ANTHROPIC_")));
    // The prompt right after -p: --allowedTools and --mcp-config take several values each,
    // and a prompt after them is read as one more (it became an MCP config file name).
    const argv = ["-p", task.prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--allowedTools", "Bash(node:*)", "Bash(npm:*)"];
    if (args["claude-model"]) argv.push("--model", String(args["claude-model"]));
    const r = await run(claudeExe(), argv, { cwd: dir, timeoutMs: minutes * 60_000, env, replaceEnv: true });
    let result = null;
    try {
      result = JSON.parse(r.out.trim().split("\n").at(-1));
    } catch {
      /* no JSON: it crashed or was killed */
    }
    if (!result && /not logged in|please run .*login|invalid api key/i.test(r.out + r.err)) return { void: `Claude Code is not signed in: ${(r.out + r.err).trim().slice(-200)}` };
    return {
      ms: r.ms,
      timedOut: r.timedOut,
      steps: result?.num_turns ?? null,
      stopped: r.timedOut ? "time" : result?.subtype && result.subtype !== "success" ? result.subtype : null,
      error: result?.is_error ? String(result.result ?? "").slice(0, 300) : result ? null : (r.out + r.err).slice(-300),
      models: result?.modelUsage ? Object.keys(result.modelUsage) : null,
      costUsd: result?.total_cost_usd ?? null,
      apiMs: result?.duration_api_ms ?? null,
    };
  },
  async opencode(task, dir) {
    writeFileSync(
      join(dir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        provider: { bench: { npm: "@ai-sdk/openai-compatible", name: "bench llama", options: { baseURL: llama }, models: { [model]: { name: model } } } },
        model: `bench/${model}`,
        permission: { edit: "allow", bash: "allow", webfetch: "allow" },
      }, null, 2),
    );
    // OpenCode 2 takes its project folder from $PWD, not the process cwd, so a spawned run
    // inherits the parent's PWD and never sees the task's opencode.json ("Model unavailable").
    // --standalone keeps it off a background service started in some other folder.
    const r = await run("opencode", ["run", "--standalone", "--model", `bench/${model}`, JSON.stringify(task.prompt)], { cwd: dir, timeoutMs: minutes * 60_000, shell: true, env: { PWD: dir } });
    // OpenCode never reached the model: a setup error, not a failed attempt.
    if (/Model unavailable|ProviderModelNotFound/i.test(r.out + r.err)) return { void: `opencode could not use bench/${model}: ${(r.out + r.err).trim().slice(-200)}` };
    return { ms: r.ms, timedOut: r.timedOut, steps: null, stopped: r.timedOut ? "time" : null, error: r.code === 0 ? null : r.err.slice(-300) };
  },
};

async function grade(task, dir) {
  mkdirSync(join(dir, ".bench"), { recursive: true });
  writeFileSync(join(dir, ".bench", "verify.test.mjs"), task.hidden);
  const r = await run(process.execPath, ["--test", join(".bench", "verify.test.mjs")], { cwd: dir, timeoutMs: 60_000 });
  return { pass: r.code === 0, detail: r.code === 0 ? "" : (r.out + r.err).split("\n").filter((l) => /not ok|Error|expected|actual/i.test(l)).slice(0, 4).join(" | ") };
}

/** Is the model server up and answering the expected model? A run without it measures nothing. */
async function modelUp() {
  try {
    const res = await fetch(llama.replace(/\/v1\/?$/, "/health"), { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

const rows = [];
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
outer: for (const harness of harnesses) {
  for (const task of TASKS.filter((t) => !only || only.has(t.id))) {
    const local = harness !== "claude";
    if (local && !(await modelUp())) {
      process.stderr.write(`the model server at ${llama} is down: stopping (the GPU was probably taken for something else); nothing more is recorded\n`);
      break outer;
    }
    const dir = fixture(task);
    process.stderr.write(`${harness} ${task.id} ... `);
    const ran = await HARNESS[harness](task, dir);
    if (ran.void) {
      process.stderr.write(`void: ${ran.void}; stopping\n`);
      break outer;
    }
    // The model went away mid-run (another program took the GPU): the run is void, not a fail.
    if (local && !(await modelUp())) {
      process.stderr.write(`void: the model server went down during the run; stopping\n`);
      break outer;
    }
    const graded = await grade(task, dir);
    const row = { harness, task: task.id, pass: graded.pass, ms: ran.ms, steps: ran.steps, stopped: ran.stopped, timedOut: ran.timedOut, error: ran.error, why: graded.detail, dir, ...(ran.models ? { models: ran.models, costUsd: ran.costUsd, apiMs: ran.apiMs } : {}) };
    rows.push(row);
    process.stderr.write(`${graded.pass ? "PASS" : "fail"} (${Math.round(ran.ms / 1000)}s)\n`);
    writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify({ model, minutes, rows }, null, 2));
  }
}

const lines = [`# Bench ${stamp}`, "", `Model: ${model} on llama.cpp (one RTX 3090), ${minutes} min per task, every run counted.`, "", "| Harness | Passed | Median time |", "|---|---|---|"];
for (const harness of harnesses) {
  const mine = rows.filter((r) => r.harness === harness);
  const times = mine.map((r) => r.ms).sort((a, b) => a - b);
  lines.push(`| ${harness} | ${mine.filter((r) => r.pass).length} / ${mine.length} | ${Math.round((times[Math.floor(times.length / 2)] ?? 0) / 1000)} s |`);
}
lines.push("", "| Task | " + harnesses.join(" | ") + " |", "|---|" + harnesses.map(() => "---").join("|") + "|");
for (const task of [...new Set(rows.map((r) => r.task))]) {
  lines.push(`| ${task} | ${harnesses.map((h) => { const r = rows.find((x) => x.harness === h && x.task === task); return r ? `${r.pass ? "pass" : "fail"} ${Math.round(r.ms / 1000)}s` : "-"; }).join(" | ")} |`);
}
writeFileSync(join(outDir, `run-${stamp}.md`), `${lines.join("\n")}\n`);
process.stdout.write(`${lines.join("\n")}\n`);
