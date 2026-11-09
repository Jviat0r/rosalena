#!/usr/bin/env node
/**
 * Headless CLI - the "operates like Cursor / DeepSeek CLI" surface.
 *
 *   node src/cli.mjs --check                       verify the router and workspace
 *   node src/cli.mjs "add a --json flag to foo"    one-shot task
 *   node src/cli.mjs                               interactive session
 *   node src/cli.mjs --voice                       interactive, speaking instead of typing
 *
 * Events stream to stderr and the final answer goes to stdout, so
 * `node src/cli.mjs "..." > out.txt` captures only the answer.
 *
 * Model replies arrive as a stream by default: prose is written to stderr as it
 * is generated, so a slow local model looks alive instead of hung, and tool calls
 * are reassembled from their fragments. --no-stream asks for one buffered reply
 * per step instead. See src/stream.mjs for why the fragments need care.
 *
 * Voice input is off unless asked for. `--voice` makes every prompt start by
 * listening, and `/voice` does the same on demand inside a session. Whatever is
 * heard lands in the prompt line to be corrected before it is sent - see
 * src/voice.mjs for why it is never submitted on the user's behalf.
 *
 * --judge checks the answer and, if it is rejected, hands the reasons back for a
 * bounded fix round (--fixes, default 1) before reporting the rejection and
 * exiting 2. --no-shell drops run_command: the file tools are rooted at the
 * workspace, but a shell is not confined by giving it a working directory, so a
 * task that must not touch anything outside it needs the tool gone, not policed.
 *
 * Memory is on by default. The store (~/.rosalena/memory.jsonl, or --memory-file)
 * is read into the system prompt, `remember` writes to it, and a history past
 * --compact-at of the window (0.55, not the usual 0.8) is replaced by a rolling
 * summary with --keep-last messages left verbatim. --no-memory turns all of that
 * off. The summary runs on --summary-class; when that fails the dropped messages
 * are summarized mechanically instead, so compaction never loses a run.
 *
 * --goal makes the run one round of a goal that outlives it: the objective (the
 * head of the goal file) and the latest state (its tail) are read into the system
 * prompt, the model gets `goal_state` and `goal_update`, and if it never records
 * the round the harness records it instead - an errored or stalled run is exactly
 * the run whose state the next session needs. The file is APPEND-ONLY and shared,
 * so nothing here ever rewrites it; --goal-file names it (which implies --goal),
 * and /goal shows it. The next round is read back out of the file, not counted by
 * this process.
 *
 * The watchdog is what keeps a long run from hanging: --step-timeout and
 * --tool-timeout (seconds; 0 turns one off) abort a model call and answer a hung
 * tool, because an unanswered tool call is a malformed history. --repeat-limit N
 * is an OPT-IN backstop that stops a run repeating the same call with the same
 * result N times; it is off by default because loop policy belongs to the bundled
 * finish-loop-guard plugin, which nudges the model before it stops the run.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The app's version (desktop/package.json is what a release bumps), for --json and --version.
const HARNESS_VERSION = (() => {
  for (const rel of ["../../desktop/package.json", "../package.json"]) {
    try {
      return JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")).version;
    } catch {
      /* try the next */
    }
  }
  return "unknown";
})();

import { DEFAULT_ROUTER, baseOf, runAgent, routerAuthHeaders } from "./agent.mjs";
import { appendGoalEntry, formatGoalEntry, goalFile, nextRound, readGoalState } from "./goal.mjs";
import { DEFAULT_MEMORY_FILE, KINDS, forget, loadMemory, memoryFile, recall, remember, rosalenaHome } from "./memory.mjs";
import { currentPluginId, loadPlugins, readHarnessConfig, runPluginCommand } from "./plugins.mjs";
import { describeMessageLog } from "./message-log.mjs";
import { listRuns, readRun, requestCancel, runStatus, runsDir } from "./runs.mjs";
import { formatUsage } from "./usage.mjs";
import { listExternalSessions, readExternalSession, sessionCounts } from "./sessions.mjs";
import { runStore } from "./store.mjs";
import { BACKEND_ORDER, describeBackends, detectBackends, listen, listMics, pickBackend } from "./voice.mjs";
import { deadlines } from "./watchdog.mjs";
import { CALIBRATION, DEFAULT_PROFILE, TOOL_PROFILES } from "./context.mjs";
import { GIB, probeHardware } from "./hardware.mjs";
import { loadCatalog, recommend, scanLocalModels } from "./catalog.mjs";

// Flags that never take a value. Without this list a boolean flag at the end of a
// command line takes the task as its value: `--no-shell "do the thing"` left no
// positional argument at all and dropped silently into an interactive session.
const BOOLEAN_FLAGS = new Set(["check", "help", "voice", "voice-status", "quiet", "plugins", "judge", "no-shell", "no-stream", "no-memory", "no-runs", "goal", "context", "hardware", "json", "acp", "sandbox", "version"]);

// The router is a sibling of this package inside the product folder, but it reads
// `router.config.json` from its own working directory - so the only hint worth
// printing is one that carries the `cd`, and one that survives the folder being
// moved or renamed. It is derived, never typed: a hard-coded path here went stale
// the moment the suite moved into "Rosalena Harness".
const ROUTER_START_HINT = (() => {
  try {
    const routerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "router");
    return existsSync(join(routerDir, "src", "index.mjs"))
      ? `cd "${routerDir}"; node src/index.mjs`
      : "from the router's own directory: node src/index.mjs";
  } catch {
    return "from the router's own directory: node src/index.mjs";
  }
})();

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !BOOLEAN_FLAGS.has(name)) {
        flags[name] = next;
        i += 1;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const routerUrl = flags.router ?? DEFAULT_ROUTER;
const root = resolve(flags.root ?? process.cwd());
const quiet = Boolean(flags.quiet);
const voiceSeconds = Math.max(3, Number(flags["voice-seconds"] ?? 15));

// Seconds on the command line, milliseconds in the watchdog API. A flag given
// with no value arrives as `true` from the generic parser, and a timeout of
// "true" is not a timeout, so a value that is not a number is ignored rather than
// silently becoming one second.
function seconds(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : undefined;
}
function count(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : undefined;
}

const stepTimeoutMs = seconds(flags["step-timeout"]);
const toolTimeoutMs = seconds(flags["tool-timeout"]);
const repeatLimit = count(flags["repeat-limit"]);
// Naming a goal file is asking for goal mode, and `--goal-file` with nothing
// after it arrives as `true`: stringifying that would send the goal to a file
// literally named "true".
const goalFileFlag = typeof flags["goal-file"] === "string" && flags["goal-file"].trim() ? flags["goal-file"].trim() : null;
const goal = Boolean(flags.goal) || Boolean(goalFileFlag) || Number(flags.rounds) > 1;
const goalPath = goal ? goalFile(goalFileFlag, root) : null;
// What this run would actually enforce, defaults included - so --check reports the
// clocks the agent will use rather than the flags that were typed.
const watch = deadlines({ stepTimeoutMs, toolTimeoutMs, repeatLimit });

function line(text) {
  if (!quiet) process.stderr.write(`${text}\n`);
}

// The run commands all read one directory, and they must agree with the store the
// agent writes to: --runs-dir wins, then ROSALENA_RUNS, then <ROSALENA_HOME>/runs.
function runsDirFlag() {
  return runsDir(typeof flags["runs-dir"] === "string" && flags["runs-dir"].trim() ? flags["runs-dir"].trim() : null);
}

// Table cells are padded AND truncated to the same width, so a long task cannot
// push the columns out of line.
function cell(value, width) {
  const text = String(value ?? "-");
  return text.length > width ? `${text.slice(0, width - 1)}…`.padEnd(width) : text.padEnd(width);
}

function shortTask(text, n = 48) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

// Shared by --run / --run-events / --run-record: one id shape, the same two failures
// (no such run, ambiguous prefix) reported the same way, and the RESOLVED id handed
// back so a prefix typed by a human works everywhere.
function resolveRunArg(flagName) {
  const raw = flags[flagName];
  if (raw === true || !String(raw ?? "").trim()) {
    process.stderr.write(`--${flagName} needs a run id (see --runs)\n`);
    process.exitCode = 1;
    return null;
  }
  const id = String(raw).trim();
  try {
    const st = runStatus({ dir: runsDirFlag(), id });
    if (!st) {
      process.stderr.write(`no run matching "${id}" in ${runsDirFlag()}\n`);
      process.exitCode = 1;
      return null;
    }
    return st;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return null;
  }
}

/**
 * Where the suite keeps memory, the process ledger, the MCP registry and the
 * proxy pool - and whether this process may actually write there.
 *
 * Worth a line of its own in --check: a sandboxed (Low integrity) run can read
 * %USERPROFILE%\.rosalena but every write to it fails with EPERM, which looks
 * like a broken agent rather than a permissions fact. The launcher therefore
 * points ROSALENA_HOME inside the product folder.
 */
function dataDirReport() {
  const dir = rosalenaHome();
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      return `${dir} (cannot create: ${err.code ?? err.message})`;
    }
  }
  // A real create/delete, not accessSync: access() consults the discretionary
  // ACL and is blind to the mandatory integrity label, so a Low-integrity run
  // happily reports %USERPROFILE%\.rosalena as writable and then fails EPERM.
  const probe = join(dir, `.write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "ok", "utf8");
    rmSync(probe, { force: true });
  } catch (err) {
    return `${dir} (NOT WRITABLE: ${err.code ?? err.message} - set ROSALENA_HOME to a folder this user owns)`;
  }
  return dir;
}

// Streamed prose is written as it arrives, so a slow local model looks alive
// instead of hung. The block has to be closed before the next event line, or the
// event lands in the middle of a sentence.
let streamOpen = false;
function endStreamBlock() {
  if (!streamOpen) return;
  streamOpen = false;
  process.stderr.write("\n");
}

// Plugins load once, before anything can use the agent, so whatever they
// contribute joins the same registry the model sees - in one-shot and
// interactive mode alike. A plugin that fails is reported and skipped here.
let harnessConfig = {};
try {
  harnessConfig = readHarnessConfig();
} catch (err) {
  line(`  config    ${err.message} - using defaults`);
}

const pluginHost = await loadPlugins({
  root,
  config: harnessConfig,
  log: (m) => line(`  [plugin] ${m}`),
  harness: { routerUrl, workspace: root },
});

for (const failure of pluginHost.errors) {
  line(`  plugin    ${failure.id} FAILED: ${failure.reason}`);
}

/**
 * The context table, as a surface rather than a paragraph in a doc.
 *
 * Every number here is either a measured sample or derived from one, so the honest
 * question ("where did 3.6 come from?") is answerable by reading the command output.
 */
function describeContext(asJson) {
  const calibrations = new Map(CALIBRATION.samples.map((s) => [s.shape, s]));
  const shapeOf = {
    read_file: "source code",
    write_file: "prose",
    edit_file: "prose",
    delegate: "prose",
    list_dir: "directory listing",
    run_command: "command output",
    search: "search hits",
  };
  const rows = Object.entries(TOOL_PROFILES).map(([name, p]) => ({
    name,
    budget: p.budget,
    clip: p.clip,
    charsPerToken: p.charsPerToken,
    cache: p.cache,
    measured: calibrations.get(shapeOf[name])?.charsPerToken ?? null,
  }));
  if (asJson) {
    return JSON.stringify({ profiles: rows, default: DEFAULT_PROFILE, calibration: CALIBRATION, cache: "read_file only" }, null, 2);
  }
  const pad = (s, n) => String(s).padEnd(n);
  const out = ["per-tool context (a budget for one result, and the weight used to price it)", ""];
  out.push(`  ${pad("tool", 14)}${pad("budget", 8)}${pad("clip", 7)}${pad("chars/token", 13)}measured`);
  for (const r of rows) {
    out.push(`  ${pad(r.name, 14)}${pad(r.budget, 8)}${pad(r.clip, 7)}${pad(r.charsPerToken, 13)}${r.measured ?? "(none - weighted pessimistically)"}`);
  }
  out.push(
    `  ${pad("(default)", 14)}${pad(DEFAULT_PROFILE.budget, 8)}${pad(DEFAULT_PROFILE.clip, 7)}${pad(DEFAULT_PROFILE.charsPerToken, 13)}plugin tools and unknown names`,
  );
  out.push("", `weights measured ${CALIBRATION.at} on ${CALIBRATION.tokenizer}, on real output from this harness:`);
  for (const s of CALIBRATION.samples) out.push(`  ${pad(s.shape, 20)}${pad(s.charsPerToken, 8)} chars/token  (${s.chars} chars -> ${s.tokens} tokens, ${s.what})`);
  out.push(
    "",
    `  the flat guess everything else uses: ${CALIBRATION.folklore} chars/token - it under-counts every row above,`,
    "  which is the direction that kills a run: the estimate says there is room when the window is gone.",
    "",
    "cache: read_file only, keyed on the file's size+mtime+inode. A second identical read in the same",
    "       run gets a stub instead of the bytes. Invalidated by any write, by a compaction, and by any",
    "       change to the file. Nothing else is cached - no exact validity check, no cache.",
  );
  return out.join("\n");
}

// The folder the local-llm plugin serves, asked of the config rather than typed:
// it is also the drive whose free space decides whether a download is possible.
function localModelDirs() {
  const configured = harnessConfig?.plugins?.["rosa-local-llm"]?.config?.modelDirs;
  return Array.isArray(configured) ? configured.filter((d) => typeof d === "string" && d.trim()) : [];
}

/** Bytes as GiB with one decimal, or `?` when the probe could not measure it. */
function gibText(bytes) {
  return typeof bytes === "number" && Number.isFinite(bytes) ? `${(bytes / GIB).toFixed(1)} GiB` : "?";
}

/**
 * The machine, and what it can hold, as one surface.
 *
 * The probe answers "what is here" and the catalog answers "what is worth
 * downloading"; `recommend` is the only place the two meet, so this function
 * formats a verdict rather than computing one. Two verdicts per row on purpose:
 * `now` is measured against free memory (the question that stops a second model
 * being loaded onto a busy card) and `idle` against the card's whole VRAM (the
 * question "is this worth downloading at all"). When a box is mid-run they
 * disagree, and printing only the first would say no to everything.
 */
function describeHardware(asJson) {
  const dirs = localModelDirs();
  const modelsDir = dirs[0] ?? null;
  const hardware = probeHardware({ modelsDir });
  const catalog = loadCatalog();
  const report = recommend({ hardware, catalog });
  const onDisk = scanLocalModels(dirs);

  if (asJson) {
    return JSON.stringify(
      { hardware, catalog: { version: catalog.version, updated: catalog.updated, entries: catalog.models.length }, report, onDisk },
      null,
      2,
    );
  }

  const { gpu, cpu, ram, disk } = hardware;
  const out = ["harness hardware"];
  const cores =
    cpu.physicalCores === null
      ? `${cpu.logicalCores ?? "?"} logical cores (physical count unknown)`
      : `${cpu.physicalCores} physical / ${cpu.logicalCores ?? "?"} logical cores`;
  out.push(`  cpu       ${cpu.model ?? "unknown"} - ${cores}`);
  out.push(
    `  ram       ${gibText(ram.totalBytes)} total, ${gibText(ram.freeBytes)} free` +
      `${ram.windowsTotalBytes !== null && ram.totalBytes !== null && Math.abs(ram.windowsTotalBytes - ram.totalBytes) > GIB / 100 ? ` (Windows reports ${gibText(ram.windowsTotalBytes)} of physical memory)` : ""}`,
  );
  out.push(
    `  gpu       ${
      gpu.name === null
        ? "unknown - no nvidia-smi answer and no display adapter name"
        : `${gpu.name} - ${gibText(gpu.vramTotalBytes)} VRAM, ${gibText(gpu.vramFreeBytes)} free` +
          `${gpu.driverVersion ? `, driver ${gpu.driverVersion}` : ", driver unknown"}${gpu.source ? ` (${gpu.source})` : ""}`
    }`,
  );
  if (gpu.otherAdapters.length) {
    out.push(`  also      ${gpu.otherAdapters.join(", ")} - not targeted, and no VRAM is reported for that adapter`);
  }
  out.push(
    disk.modelsDir === null
      ? "  disk      no models directory configured - free space unknown"
      : `  disk      ${disk.modelsDir} - ${gibText(disk.freeBytes)} free of ${gibText(disk.totalBytes)}${disk.drive ? ` on ${disk.drive}` : ""}`,
  );
  const onDiskBytes = onDisk.reduce((sum, file) => sum + file.bytes, 0);
  out.push(
    dirs.length === 0
      ? '  models    no models folder configured (plugins["rosa-local-llm"].config.modelDirs)'
      : `  models    ${onDisk.length} GGUF file${onDisk.length === 1 ? "" : "s"}, ${gibText(onDiskBytes)}, in ${dirs.length} folder${dirs.length === 1 ? "" : "s"}`,
  );

  out.push(
    "",
    `catalog - ${catalog.models.length} entries. "now" is against memory free today, "idle" against the card's whole ${gibText(gpu.vramTotalBytes)}:`,
    "",
  );
  out.push(
    `  ${"now".padEnd(9)}${"idle".padEnd(9)}${"model".padEnd(31)}${"quant".padEnd(13)}${"need".padStart(10)}  ${"vram now".padStart(10)}  ${"vram idle".padStart(10)}`,
  );
  const rows = [...report.fits, ...report.tight, ...report.tooBig, ...report.unknown];
  for (const row of rows) {
    const name = row.entry.name.length > 30 ? `${row.entry.name.slice(0, 29)}…` : row.entry.name;
    out.push(
      `  ${row.verdict.padEnd(9)}${row.idleVerdict.padEnd(9)}${name.padEnd(31)}${row.quant.padEnd(13)}` +
        `${gibText(row.needBytes).padStart(10)}  ${gibText(row.gpuHeadroomBytes).padStart(10)}  ${gibText(row.idleGpuHeadroomBytes).padStart(10)}`,
    );
  }
  out.push(
    "",
    `  ${report.fits.length} fit the card now, ${report.tight.length} would run on the CPU, ${report.tooBig.length} fit neither` +
      `${report.unknown.length ? `, ${report.unknown.length} could not be judged (no memory figures)` : ""}.`,
    "  a negative vram figure is the shortfall in GiB; a row whose need exceeds the whole card is shown, not hidden.",
  );
  if (gpu.vramTotalBytes !== null && gpu.vramFreeBytes !== null && (gpu.vramTotalBytes - gpu.vramFreeBytes) / gpu.vramTotalBytes > 0.5) {
    const used = gpu.vramTotalBytes - gpu.vramFreeBytes;
    out.push(
      "",
      `  note      ${gibText(used)} of the card is already in use (${Math.round((used / gpu.vramTotalBytes) * 100)}%), so "now" says no to almost`,
      '            everything. Nothing here loads until the resident model stops - the "idle" column is the',
      "            one that decides what is worth downloading.",
    );
  }
  if (hardware.unknown.length) {
    out.push("", `  unknown   ${hardware.unknown.join(", ")} - null on purpose, because 0 would be a reading`);
  }

  const base = disk.modelsDir ?? (dirs[0] ? resolve(dirs[0]) : null);
  if (onDisk.length) {
    out.push("", `on disk - ${base}, largest first`);
    for (const file of onDisk.slice(0, 30)) {
      const what = file.projector ? "mmproj" : file.mtp ? "mtp" : file.params === null ? "-" : `${file.params}B`;
      out.push(`  ${gibText(file.bytes).padStart(10)}  ${(file.quant ?? "?").padEnd(11)} ${what.padEnd(7)} ${relative(base, file.path) || file.file}`);
    }
    if (onDisk.length > 30) out.push(`  ... and ${onDisk.length - 30} more`);
  } else if (dirs.length) {
    out.push("", `on disk - nothing under ${dirs.join(", ")}; the catalog above is what is worth downloading`);
  }
  return out.join("\n");
}

async function check() {
  process.stdout.write(`harness check\n  router    ${routerUrl}\n  workspace ${root}\n`);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    process.stdout.write(`  workspace MISSING\n`);
    process.exitCode = 1;
    return;
  }
  const pluginTools = pluginHost.tools.length;
  const pluginHooks = pluginHost.hooks.length;
  process.stdout.write(
    `  plugins   ${pluginHost.plugins.length} loaded, ${pluginTools} tool${pluginTools === 1 ? "" : "s"}, ${pluginHooks} hook${pluginHooks === 1 ? "" : "s"}` +
      `${pluginHost.errors.length ? `, ${pluginHost.errors.length} FAILED` : ""}\n`,
  );
  const mem = loadMemory({ file: memPath });
  process.stdout.write(`  data      ${dataDirReport()}\n`);
  // Where a tester's cloud-model text lands, said in --check because that is the line a
  // bug report asks about.
  const msgLog = describeMessageLog({ config: readHarnessConfig() });
  process.stdout.write(`  messages  ${msgLog.enabled ? `sent to ${msgLog.where}` : "off (messageLog.enabled in harness.config.json)"}\n`);
  process.stdout.write(
    `  memory    ${mem.exists ? `${mem.records.length} record${mem.records.length === 1 ? "" : "s"}` : "empty"}, ${memoryFile(memPath)}` +
      `${mem.skipped ? ` (${mem.skipped} unreadable line(s) skipped)` : ""}\n`,
  );
  if (goal) {
    const gs = readGoalState({ file: goalPath });
    process.stdout.write(
      `  goal      ${gs.exists ? `${gs.bytes} bytes, last round ${gs.lastRound || "unnumbered"}, this run would write round ${gs.lastRound + 1}` : "not started yet, this run would write round 1"}, ${goalPath}\n`,
    );
  } else {
    process.stdout.write(`  goal      off (--goal makes each run a round of ${goalFile(null, root)})\n`);
  }
  process.stdout.write(
    `  watchdog  step ${watch.stepTimeoutMs ? `${watch.stepTimeoutMs / 1000}s` : "off"}, tool ${watch.toolTimeoutMs ? `${watch.toolTimeoutMs / 1000}s` : "off"}, ` +
      `repeat limit ${watch.repeatLimit || "off (finish-loop-guard owns loops; --repeat-limit N to opt in)"}\n`,
  );
  const cachedTools = Object.entries(TOOL_PROFILES).filter(([, p]) => p.cache).map(([n]) => n);
  process.stdout.write(
    `  context   per-tool budgets (read_file ${TOOL_PROFILES.read_file.budget}, run_command ${TOOL_PROFILES.run_command.budget}, ... ), ` +
      `${cachedTools.length} cached tool (${cachedTools.join(", ")}), weights measured ${CALIBRATION.at} - --context for the table\n`,
  );
  const hw = probeHardware({ modelsDir: localModelDirs()[0] ?? null });
  process.stdout.write(
    `  hardware  ${hw.gpu.name ?? "unknown GPU"}` +
      `${
        hw.gpu.vramTotalBytes === null
          ? " (VRAM unknown)"
          : ` (${(hw.gpu.vramTotalBytes / GIB).toFixed(2)} GiB VRAM, ${hw.gpu.vramFreeBytes === null ? "free unknown" : `${(hw.gpu.vramFreeBytes / GIB).toFixed(2)} GiB free`})`
      }, ${hw.cpu.physicalCores ?? hw.cpu.logicalCores ?? "?"} cores, ${gibText(hw.ram.totalBytes)} RAM - --hardware for the catalog\n`,
  );
  try {
    const health = await (await fetch(`${baseOf(routerUrl)}/health`)).json();
    const statusRes = await fetch(`${baseOf(routerUrl)}/admin/status`, { headers: routerAuthHeaders() });
    process.stdout.write(`  router    ok - classes: ${(health.classes ?? []).join(", ")}\n`);
    // A 401 here is not "the router is down": it is up and refusing to show the
    // ledger. Saying which one it is keeps an enabled token from looking like a
    // broken install - the else branch used to be a silently empty provider list.
    if (!statusRes.ok) {
      const what =
        statusRes.status === 401
          ? "401 - the router has a token; export ROSALENA_ROUTER_TOKEN (router.config.json auth.tokenEnv)"
          : `HTTP ${statusRes.status}`;
      process.stdout.write(`  spend     unavailable (${what})\n`);
    } else {
      const status = await statusRes.json();
      for (const [name, p] of Object.entries(status.providers ?? {})) {
        process.stdout.write(
          `  provider  ${name.padEnd(11)} hasKey=${String(p.hasKey).padEnd(5)} budget=${p.capUsd || "uncapped"} spent=$${p.spentUsd}\n`,
        );
      }
      const keyless = Object.entries(status.providers ?? {}).filter(([, p]) => !p.hasKey).map(([n]) => n);
      if (keyless.length) process.stdout.write(`  note      no key loaded for: ${keyless.join(", ")} (those targets are skipped)\n`);
    }
    const { backends: voiceBackends } = detectBackends({});
    const voiceReady = Object.entries(voiceBackends).filter(([, b]) => b.available).map(([n]) => n);
    process.stdout.write(`  voice     ${voiceReady.length ? voiceReady.join(", ") : "none available"}\n`);
    process.stdout.write("  status    ready\n");
  } catch (err) {
    process.stdout.write(`  router    UNREACHABLE (${err?.message ?? err})\n  start it: ${ROUTER_START_HINT}\n`);
    process.exitCode = 1;
  }
}

function reporter() {
  return (event) => {
    const prefix = event.sub ? "    " : "  ";
    // Prose arrives token by token; write it and keep going. Tool-call fragments
    // are not prose, so they are reported on the step line instead of printed.
    if (event.type === "delta") {
      if (!quiet && event.text) {
        // A worker's prose is marked once per block so it is not mistaken for the
        // orchestrator's own answer.
        if (!streamOpen && event.sub) process.stderr.write("    │ ");
        process.stderr.write(event.text);
        streamOpen = true;
      }
      return;
    }
    endStreamBlock();
    // The store's first event: the id and where this run sits in the tree. Printed
    // before anything else so a watcher knows what to poll.
    if (event.type === "run") {
      line(`${prefix}run ${event.id}${event.parent ? ` (child of ${event.parent})` : ""}`);
      return;
    }
    if (event.type === "assistant") {
      const how = event.streamed
        ? `streamed${event.ttftMs === null ? "" : `, first token ${event.ttftMs}ms`}${event.reasoningChars ? `, ${event.reasoningChars} chars of reasoning` : ""}`
        : "buffered";
      if (event.toolCalls) line(`${prefix}· step ${event.step} → ${event.toolCalls} tool call(s) via ${event.target ?? "?"} (${how})`);
      else line(`${prefix}· step ${event.step} → answer via ${event.target ?? "?"} (${how})`);
    } else if (event.type === "tool") {
      const first = String(event.preview ?? "").split("\n")[0].slice(0, 110);
      line(`${prefix}${event.ok ? "✓" : "✗"} ${event.name} ${event.ms}ms  ${first}`);
    } else if (event.type === "judge") {
      line(`${prefix}judge pass=${event.pass} ${String(event.reasons ?? "").slice(0, 120)}`);
    } else if (event.type === "fix") {
      line(`${prefix}! fix ${event.attempt}/${event.of} — the judge rejected the answer: ${String(event.reasons ?? "").slice(0, 120)}`);
    } else if (event.type === "compact") {
      line(`${prefix}⇣ compacted ${event.tokensBefore}→${event.tokensAfter} tokens (dropped ${event.dropped}, kept ${event.kept}, ${event.how} summary${event.note ? `; ${event.note}` : ""})`);
    } else if (event.type === "compact_skipped") {
      line(`${prefix}⇣ no compaction: ${event.reason}`);
    } else if (event.type === "stopped") {
      line(`${prefix}! stopped: ${event.reason}`);
    } else if (event.type === "retry") {
      line(`${prefix}! retry ${event.attempt}/${event.of} in ${event.waitMs}ms (${event.reason ?? "call_failed"}) ${String(event.message ?? "").slice(0, 120)}`);
    } else if (event.type === "watchdog") {
      if (event.kind === "step_timeout") line(`${prefix}! watchdog: ${event.what === "summary" ? "the summary call" : `step ${event.step}`} was aborted after ${event.ms}ms (provider target ${event.model ?? "?"})`);
      else if (event.kind === "tool_timeout") line(`${prefix}! watchdog: tool ${event.name} did not finish within ${event.ms}ms - answering the call so the next request stays well-formed`);
      else if (event.kind === "repeat") line(`${prefix}! watchdog: the same call with the same result ${event.count} times in a row (${String(event.key ?? "").slice(0, 90)})`);
      else line(`${prefix}! watchdog: ${event.kind}`);
    } else if (event.type === "context_cache") {
      line(`${prefix}↺ ${event.tool} ${event.path} unchanged - ${event.bytes} bytes already in this conversation, not re-sent`);
    } else if (event.type === "goal") {
      line(
        `${prefix}◇ goal round ${event.round} of ${event.file}` +
          (event.exists ? ` (${event.bytes} bytes recorded, last round ${event.lastRound || "unnumbered"})` : " (the file does not exist yet - this run starts it)"),
      );
    } else if (event.type === "goal_done_requested") {
      line(`${prefix}◇ the model recorded the goal as done (round ${event.round}) - the judge still gets its say before the run finishes`);
    } else if (event.type === "goal_written") {
      line(`${prefix}✓ goal round ${event.round} recorded in ${event.file} by the ${event.by} (${event.bytes} bytes)`);
    } else if (event.type === "goal_error") {
      line(`${prefix}! goal round NOT recorded in ${event.file}: ${event.message}`);
    } else if (event.type === "error") {
      line(`${prefix}! ${event.message}`);
    }
  };
}

function summarize(result) {
  // A streamed answer may still be mid-line on stderr; the result goes to stdout,
  // so the terminal needs the line closed first.
  endStreamBlock();
  const bits = [`steps=${result.steps}`, `${result.ms}ms`];
  if (result.fixes) bits.push(`fixes=${result.fixes}`);
  if (result.stopped) bits.push(`stopped=${result.stopped}`);
  if (result.error) bits.push("ERROR");
  line(`  ${bits.join("  ")}`);
  // The run id is the handle another process needs: it can poll this run while it
  // was going, and read it back afterwards. Printed with the path so it is usable
  // without knowing where the store lives.
  if (result.run) line(`  run ${result.run}${result.runFile ? ` → ${result.runFile}` : ""}`);
  if (result.usage?.total?.calls) line(`  usage: ${formatUsage(result.usage)}`);
  // The goal line is deliberately separate from the run bits: whether the round
  // got recorded is about the NEXT session, not about how this one went.
  if (result.goal) {
    line(
      `  goal round ${result.goal.round} ${result.goal.wrote ? "recorded" : "NOT recorded"}${result.goal.done ? ", marked done" : ""} → ${result.goal.file}`,
    );
  }
  if (result.verdict?.pass === false) line(`  judge rejected after ${result.fixes ?? 0} fix round(s): ${result.verdict.reasons ?? ""}`);
  // Only when it did something: a "0 bytes saved" line on every run is noise, and
  // noise is how a real signal gets ignored.
  if (result.context?.hits) {
    line(`  context: ${result.context.hits} re-read(s) answered from the cache, ${result.context.stubbedBytes} bytes not re-sent`);
  }
  // The result contract for scripts and benchmarks: one JSON line on stdout, and an exit
  // code that says how it ended (0 answered, 1 failed, 2 rejected by the judge, 3 stopped
  // early - steps, time, cost, a guard - and 130 cancelled).
  if (flags.json) {
    const exit = result.error ? 1 : result.stopped === "cancelled" ? 130 : result.stopped ? 3 : result.verdict?.pass === false ? 2 : 0;
    process.stdout.write(
      `${JSON.stringify({
        ok: exit === 0,
        exit,
        answer: result.answer ?? "",
        error: result.error ?? null,
        stopped: result.stopped ?? null,
        steps: result.steps ?? 0,
        ms: result.ms ?? null,
        target: result.target ?? null,
        verdict: result.verdict ?? null,
        fixes: result.fixes ?? 0,
        run: result.run ?? null,
        runFile: result.runFile ?? null,
        context: result.contextMeter ? { used: result.contextMeter.used, window: result.contextMeter.window } : null,
        // Tokens and dollars of this run (workers included); `spentUsd` is null when no call was priced.
        usage: result.usage?.total ?? null,
        spentUsd: result.usage?.total?.priced ? result.usage.total.usd : null,
        version: HARNESS_VERSION,
      })}\n`,
    );
    process.exitCode = exit;
    return;
  }
  if (result.error) {
    process.stdout.write(`${result.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${result.answer}\n`);
  if (result.verdict?.pass === false) process.exitCode = 2;
}

const agentOptions = {
  routerUrl,
  root,
  cls: flags.class ?? "orchestrate",
  workerClass: flags.worker ?? "code",
  judgeClass: flags.judgeClass ?? "judge",
  maxSteps: Number(flags.steps ?? 12),
  maxUsd: flags["max-usd"] ? Number(flags["max-usd"]) : null,
  useJudge: Boolean(flags.judge),
  maxFixes: flags.fixes === undefined ? 1 : Number(flags.fixes),
  // --no-shell drops run_command, the only way to actually confine a run: a path
  // check on a shell command is theatre, and a called script defeats it.
  shell: !flags["no-shell"],
  // Streaming is the default; --no-stream asks for one buffered reply per step,
  // which is worth having when a provider streams badly or a log needs whole steps.
  stream: !flags["no-stream"],
  // Memory is on by default: the store is read into the system prompt and written
  // through the `remember` tool, and a growing history is compacted at
  // `--compact-at` of the window (0.55, not the usual 0.8).
  memory: !flags["no-memory"],
  // `--memory-file` with nothing after it arrives as `true` from the generic parser;
  // stringifying that would send the store to a file literally named "true".
  memoryFile: typeof flags["memory-file"] === "string" && flags["memory-file"].trim() ? flags["memory-file"].trim() : null,
  summaryClass: flags["summary-class"] ?? "fast",
  // Durable goal mode: this run is one round of a goal that outlives it, and the
  // round is recorded in an append-only file the next session reads back. Naming a
  // goal file implies the mode - there is no other reason to pass one.
  goal,
  goalFile: goalFileFlag,
  ...(flags["goal-tail"] ? { goalTailChars: Number(flags["goal-tail"]) } : {}),
  // The watchdog. Only spread when the flag was actually given with a number, so
  // that an absent flag keeps the library default instead of becoming `undefined`.
  ...(stepTimeoutMs !== undefined ? { stepTimeoutMs } : {}),
  ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
  ...(repeatLimit !== undefined ? { repeatLimit } : {}),
  ...(flags["context-window"] ? { contextWindow: Number(flags["context-window"]) } : {}),
  ...(flags["compact-at"] ? { compactAt: Number(flags["compact-at"]) } : {}),
  ...(flags["keep-last"] ? { keepLast: Number(flags["keep-last"]) } : {}),
  // Every run is recorded under <ROSALENA_HOME>/runs so it can be inspected by
  // another process while it is still going - that is the interop contract. A
  // spawner that must poll the run before it ends picks the id with --run-id, and
  // --parent-run-id puts the child in the parent's tree.
  runs: !flags["no-runs"],
  runId: typeof flags["run-id"] === "string" && flags["run-id"].trim() ? flags["run-id"].trim() : null,
  runsDir: typeof flags["runs-dir"] === "string" && flags["runs-dir"].trim() ? flags["runs-dir"].trim() : null,
  parentRunId: typeof flags["parent-run-id"] === "string" && flags["parent-run-id"].trim() ? flags["parent-run-id"].trim() : null,
  extraTools: pluginHost.tools,
  extraHooks: pluginHost.hooks,
  onEvent: reporter(),
  // --access full|workspace|auto|read (the engine's default stays full). --sandbox runs
  // commands inside the OS sandbox where the platform has one.
  ...(typeof flags.access === "string" && ["full", "workspace", "auto", "read"].includes(flags.access) ? { accessMode: flags.access } : {}),
  ...(flags.sandbox ? { sandbox: true } : {}),
  ...(flags["max-minutes"] !== undefined ? { maxWallMs: Number(flags["max-minutes"]) * 60_000 } : {}),
};

// The one path every memory surface in this CLI agrees on: --memory-file wins,
// otherwise the default store next to ROSALENA_HOME.
const memPath = memoryFile(typeof flags["memory-file"] === "string" ? flags["memory-file"] : null);

/**
 * Make the local server hold the model this run was pinned to, before the run starts.
 *
 * `--class local/qwen3.8-27b` is a pinned local model (the router turns an exact target
 * into a one-target chain), so it is also an instruction about the card: the model has to
 * be resident before the first token, and one card cannot hold two big models, so a
 * different resident model is unloaded first. A class like `orchestrate` is left alone -
 * its chain prefers the local model and falls back to a cloud one, and loading a 17 GB
 * model because somebody asked for a class would be a surprise rather than a service.
 *
 * Returns false only when the model was asked for and could not be made ready: a run
 * pinned to a local model must not quietly answer from somewhere else.
 */
async function prepareLocalModel(cls) {
  const target = String(cls ?? "");
  if (!target.toLowerCase().startsWith("local/")) return true;
  const config = pluginHost.plugins.find((entry) => entry.id === "rosa-local-model-host")?.config;
  if (!config) {
    process.stderr.write(`  ${target} needs the local-model-host plugin, which is not loaded\n`);
    return false;
  }
  try {
    const mod = await import("../plugins/rosa-local-model-host/plugin.mjs");
    const ready = await mod.ensureLocalModel({ config: mod.hostConfigOf({ ...config, home: rosalenaHome() }), target });
    if (!ready.ok) {
      process.stderr.write(`  ${target} is not ready: ${ready.error}\n`);
      return false;
    }
    if (ready.swapped) process.stderr.write(`  local model ${ready.previous ?? "nothing"} -> ${ready.model} (pid ${ready.pid})\n`);
    return true;
  } catch (err) {
    process.stderr.write(`  ${target}: the local model host failed: ${err?.message ?? err}\n`);
    return false;
  }
}

const HELP = `
commands
  /voice             speak your prompt; it appears in the prompt line to edit before sending
  /voice status      which speech backends are ready, and which microphones exist
  /voice mics        list the microphones Windows can see
  /voice backend X   use one backend for this session (${BACKEND_ORDER.join(", ")})
  /voice on | off    listen automatically at every prompt (voice-first mode)
  /goal [text]       show the goal state file (and what round a run would write);
                     with text, append a round entry to it by hand - append-only
  /plugins           list loaded plugins, and any that failed to load
  /plugin id:cmd     run a plugin command (e.g. /plugin local-llm status)
  /local-llm status  shorthand for the same thing
  /memory [query]    list what the harness remembers (optionally filtered by text or kind)
  /remember <text>   write a fact; /remember decision|constraint|project <text> for the others
  /forget <id>       delete one memory by its id
  /help              this list
  /quit              exit
`;

// --help is in BOOLEAN_FLAGS, so it has to actually print something: a documented
// flag with no handler drops the user into an interactive session instead, which
// on piped input exits immediately and looks like the harness ignored them.
const USAGE = `
Rosalena harness - one agent loop over the router's classes, with tools, plugins,
memory and (optionally) a durable goal. Docs: HARNESS.md in this package (the
"Rosalena Harness" product folder holds this package and the router beside it).

  node src/cli.mjs --check                    verify the router, workspace, memory, goal, watchdog, hardware
  node src/cli.mjs "add a --json flag to foo" one-shot task (the answer goes to stdout)
  node src/cli.mjs                            interactive session
  node src/cli.mjs --voice                    interactive, speaking instead of typing

run
  --root <dir>            workspace the file tools are rooted at (default: cwd)
  --router <url>          router base URL (default: ${DEFAULT_ROUTER})
  --class <name>          class for the orchestrator (default: orchestrate)
  --worker <name>         class for delegated sub-agents (default: code)
  --judge --judge-class   check the answer, and hand a rejection back for a fix round
  --fixes <n>             fix rounds after a rejection (default: 1)
  --steps <n>             step budget (default: 12)
  --max-usd <n>           stop when the router reports this much spend
  --no-shell              drop run_command - the only real confinement this has
  --no-stream             one buffered reply per step instead of a live stream
  --no-memory             no memory store, no compaction
  --memory-file <path>    memory store (default: ${DEFAULT_MEMORY_FILE})
  --compact-at <0-1>      compact past this much of the window (default: 0.55)
  --keep-last <n>         messages kept verbatim through a compaction (default: 8)
  --context-window <n>    the model's window in tokens (default: 32768)

local models (one card, one model: a pinned local model is loaded before the run starts)
  --class local/<model>   run on that GGUF - the idle server is unloaded, then this one loads
  --plugin rosa-local-model-host:list              what is installed, and what is loaded now
  --plugin rosa-local-model-host:load <model>      start the server on it (refuses if another is up)
  --plugin rosa-local-model-host:unload [--force]  stop it, but only when it is idle
  --plugin rosa-local-model-host:switch <model>    unload whatever is loaded, then load this
  --summary-class <cls>   the class that writes the checkpoint (default: fast)

goal (--goal makes the run one round of a goal that outlives it)
  --goal                  read the goal file into the prompt and record this round
  --goal-file <path>      the file (implies --goal; default: .goal-state.md in --root)
  --goal-tail <chars>     how much of the file's tail the prompt gets (default: 3000)
  --rounds <n>            a mission: run round after round (fresh context each) until the
                          goal is done, blocked, or out of rounds (implies --goal)
  --hours <h>             stop starting new rounds after this long (default with --rounds: 8)

watchdog (seconds; 0 turns one off)
  --step-timeout <s>      abort a model call that hangs (default: 300)
  --tool-timeout <s>      answer a tool that hangs (default: 300; a tool that used most
                          of its deadline, or one that asks for more, gets up to 600)
  --repeat-limit <n>      opt-in backstop: stop after n identical calls with identical
                          results (default: 0/off - finish-loop-guard owns loop policy)

runs (every run is recorded under <ROSALENA_HOME>/runs; ROSALENA_RUNS or --runs-dir moves it)
  --runs [n]              the last n runs (default 20): status, steps, time, task
  --run <id>              one run's status, progress, last tool/event and answer (prefix ok)
  --run-events <id>       its event log, one JSON object per line
  --run-record <id>       its final record (the embedded events are omitted)
  --cancel <id>           ask a running run to stop at its next step (any process may)
  --run-id <id>           use this id for the run being started (a spawner picks it)
  --parent-run-id <id>    record this run as a child of another one
  --runs-dir <path>       where the runs live (default: <ROSALENA_HOME>/runs)
  --no-runs               do not record this run at all
  --json                  with --runs or --run: machine-readable output

other
  --ui [port]             the visual UI on http://127.0.0.1:<port> (default 8090)
  --ui-host <addr>        bind address for --ui (default 127.0.0.1)
  --plugins               list plugins; --plugin id:cmd runs one command headless
  --store [list|install|remove|...]   the module store
  --context               the per-tool budgets and the measured token weights (--context --json)
  --hardware              this machine, and which catalog models it can hold (--hardware --json)
  --voice-status          which speech backends are ready
  --ext-sessions          sessions found on this machine in other harnesses
  --ext-session <src:id>  one of them, as text (claude, codex, opencode, dsh)
  --quiet                 suppress streaming prose and per-step lines
  --help                  this text
`;

async function session() {
  await check();

  let backend = flags.stt ?? null;
  let auto = Boolean(flags.voice);
  if (auto) {
    try {
      backend = pickBackend(backend);
    } catch (err) {
      line(`  voice-first mode is off: ${err.message}`);
      auto = false;
    }
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr, prompt: "harness> " });
  line("\nInteractive session. Ctrl+C to exit, /help lists commands. The orchestrator keeps its history across turns.\n");

  // A hand-rolled line queue rather than `for await`, because voice-first mode
  // has to listen *before* each prompt, not after the line arrives.
  const queue = [];
  let waiter = null;
  let closed = false;
  let stopRecording = null;
  rl.on("line", (text) => {
    // Enter while the microphone is open means "I have finished speaking".
    if (stopRecording) {
      const stop = stopRecording;
      stopRecording = null;
      stop();
      return;
    }
    if (waiter) {
      const resume = waiter;
      waiter = null;
      resume(text);
    } else queue.push(text);
  });
  rl.on("close", () => {
    closed = true;
    if (waiter) {
      const resume = waiter;
      waiter = null;
      resume(null);
    }
  });
  const nextLine = () =>
    queue.length ? Promise.resolve(queue.shift()) : new Promise((resume) => { waiter = resume; });

  const speak = async () => {
    const stopped = new Promise((resolve) => { stopRecording = resolve; });
    try {
      const heard = await listen({
        backend,
        model: flags.model ?? "base.en",
        device: flags.mic ?? null,
        seconds: voiceSeconds,
        stopSignal: stopped,
        onStatus: (status) => line(`  ${status}`),
      });
      if (!heard.text) {
        line("  heard nothing");
        return "";
      }
      line(`  heard (${heard.backend}, ${heard.ms}ms): ${heard.text}`);
      return heard.text;
    } catch (err) {
      line(`  voice failed: ${err.message}`);
      return "";
    } finally {
      stopRecording = null;
    }
  };

  let seed = null;
  while (true) {
    // Voice-first: fill the prompt line from speech, still editable, never sent
    // on the user's behalf.
    if (auto) {
      const heard = await speak();
      if (heard) rl.write(heard);
    }

    // Recording can outlast the input stream: readline is already closed by the
    // time the loop returns (piped input ran out, Ctrl+D, terminal closed) and
    // prompting on a closed interface throws ERR_USE_AFTER_CLOSE.
    if (closed) break;

    rl.prompt();
    const raw = await nextLine();
    if (raw === null || closed) break;
    const input = raw.trim();
    if (!input) continue;

    if (input === "/quit" || input === "/exit") break;
    if (input === "/help" || input === "/?") {
      line(HELP);
      continue;
    }

    if (input === "/voice" || input.startsWith("/voice ")) {
      const arg = input.slice("/voice".length).trim();
      if (arg === "status") { line(describeBackends()); continue; }
      if (arg === "mics") {
        const mics = listMics();
        line(mics.length ? `  ${mics.join("\n  ")}` : "  no microphone detected");
        continue;
      }
      if (arg === "on") {
        try { backend = pickBackend(backend); auto = true; line("  voice-first mode on"); } catch (err) { line(`  ${err.message}`); }
        continue;
      }
      if (arg === "off") { auto = false; line("  voice-first mode off"); continue; }
      if (arg.startsWith("backend")) {
        const want = arg.slice("backend".length).trim();
        try { backend = pickBackend(want || null); line(`  backend: ${backend}`); } catch (err) { line(`  ${err.message}`); }
        continue;
      }
      if (arg) { line(`  unknown /voice option "${arg}" - try /help`); continue; }

      const heard = await speak();
      if (heard) rl.write(heard);
      continue;
    }

    if (input === "/goal" || input.startsWith("/goal ")) {
      const text = input.slice("/goal".length).trim();
      // The truth is on disk, never cached in this process: the file is shared and
      // other lanes append to it, so a cached round number would silently be wrong.
      const file = goalPath ?? goalFile(null, root);
      const state = readGoalState({ file, tailChars: text ? 0 : 1600 });
      if (text) {
        // The same single-write append path the harness and the model use, so a
        // hand-written entry cannot clobber the file's history.
        const round = nextRound(state);
        try {
          const written = appendGoalEntry(formatGoalEntry({ round, summary: text, by: "harness" }), { file });
          line(`  appended round ${round} to ${file} (${written.bytes} bytes)`);
        } catch (err) {
          line(`  not written: ${err?.message ?? err}`);
        }
        continue;
      }
      if (!state.exists) {
        line(`  no goal state at ${file} - --goal makes each run a round, /goal <text> writes the first one`);
        continue;
      }
      line(
        `  ${file}  ${state.bytes} bytes, ${state.rounds} round reference${state.rounds === 1 ? "" : "s"}, ` +
          `last round ${state.lastRound || "unnumbered"} - a --goal run would write round ${nextRound(state)}`,
      );
      if (state.lastHeading) line(`  last entry: ${state.lastHeading}`);
      for (const l of state.tail.trimEnd().split("\n")) line(`  ${l}`);
      continue;
    }

    if (input === "/plugins") {
      line(pluginHost.describe());
      continue;
    }

    if (input === "/memory" || input.startsWith("/memory ")) {
      const arg = input.slice("/memory".length).trim();
      // `/memory decision` filters by kind; anything else is a text search.
      const kind = KINDS.includes(arg) ? arg : null;
      const found = recall({ kind, query: kind ? null : arg || null }, { file: memPath });
      line(`  ${memoryFile(memPath)}`);
      line(
        found.total
          ? `  ${found.matched} of ${found.total} remembered${found.skipped ? ` (${found.skipped} unreadable line(s) skipped)` : ""}${arg ? ` matching "${arg}"` : ""}`
          : "  nothing remembered yet - /remember <text> writes the first one",
      );
      for (const r of found.records) line(`  ${r.id}  [${r.kind}]  ${String(r.text).replace(/\s+/g, " ").slice(0, 160)}`);
      continue;
    }

    if (input === "/remember" || input.startsWith("/remember ")) {
      const arg = input.slice("/remember".length).trim();
      const [maybeKind, ...words] = arg.split(/\s+/);
      const kind = KINDS.includes(maybeKind) ? maybeKind : "fact";
      const text = (KINDS.includes(maybeKind) ? words.join(" ") : arg).trim();
      const wrote = remember({ kind, text, project: resolve(root) }, { file: memPath });
      if (wrote.added) line(`  remembered as ${wrote.record.kind} (${wrote.record.id})`);
      else line(`  not written (${wrote.reason}): ${wrote.record?.id ?? "-"}`);
      continue;
    }

    if (input.startsWith("/forget ")) {
      const id = input.slice("/forget ".length).trim();
      const gone = forget(id, { file: memPath });
      line(gone.removed ? `  forgot ${id}` : `  no memory with id "${id}" - /memory lists them`);
      continue;
    }

    if (input.startsWith("/plugin ")) {
      const [spec, ...rest] = input.slice("/plugin ".length).trim().split(/\s+/);
      try {
        const out = await runPluginCommand(pluginHost, spec, rest);
        if (out === null) line(`  no such plugin command "${spec}" - /plugins lists them`);
        else if (out !== undefined) line(String(out));
      } catch (err) {
        line(`  ${spec} failed: ${err?.message ?? err}`);
      }
      continue;
    }

    // /<plugin-id> <command> [args] is a shorthand for the same dispatch. The short name
    // works too: /mcp-manager tools reaches rosa-mcp-manager.
    const short = input.match(/^\/([\w.-]+)\s+([\w.-]+)(?:\s+(.*))?$/);
    if (short && pluginHost.commands.has(`${currentPluginId(short[1])}:${short[2]}`)) {
      try {
        const args = short[3] ? short[3].trim().split(/\s+/) : [];
        const out = await runPluginCommand(pluginHost, `${short[1]}:${short[2]}`, args);
        if (out !== undefined) line(String(out));
      } catch (err) {
        line(`  ${short[1]}:${short[2]} failed: ${err?.message ?? err}`);
      }
      continue;
    }

    if (input.startsWith("/")) {
      line(`  unknown command ${input} - try /help`);
      continue;
    }

    if (!(await prepareLocalModel(agentOptions.cls))) {
      line(`  nothing ran: ${agentOptions.cls} is not ready - --plugin rosa-local-model-host:list shows the shelf`);
      continue;
    }
    const result = await runAgent({ ...agentOptions, task: input, messages: seed });
    summarize(result);
    seed = result.messages;
  }
  rl.close();
}

if (flags.acp) {
  // An editor (Zed, JetBrains, ...) drives the harness over stdio (acp.mjs). From here
  // stdout is the protocol channel; everything else this CLI prints goes to stderr.
  const { serveAcp } = await import("./acp.mjs");
  await serveAcp({ defaults: agentOptions, sessionsDir: join(rosalenaHome(), "acp-sessions") });
} else if (flags.version) {
  process.stdout.write(`${HARNESS_VERSION}\n`);
} else if (flags.plugins) {
  process.stdout.write(`${pluginHost.describe()}\n`);
} else if (flags.plugin) {
  // Headless surface for plugin commands: `--plugin rosa-mcp-server:serve` is how an
  // MCP client launches this harness as a server.
  // Arguments may come quoted with it or as the words after it, the form --help shows:
  // `--plugin rosa-local-model-host:load <model>`.
  const [spec, ...rest] = [...String(flags.plugin).trim().split(/\s+/), ...positional];
  const out = await runPluginCommand(pluginHost, spec, rest);
  if (out === null) {
    process.stderr.write(`no such plugin command "${spec}" - try --plugins\n`);
    process.exitCode = 1;
  } else if (out !== undefined) {
    process.stdout.write(`${out}\n`);
  }
} else if (flags.store !== undefined) {
  // The store changes what the next run loads, so it is its own surface and not
  // a plugin command: a plugin that installs plugins would be a way to escalate
  // through the very seam it is supposed to extend.
  const [sub, ...rest] = String(flags.store === true ? "list" : flags.store).trim().split(/\s+/).filter(Boolean);
  try {
    const out = await runStore(sub, rest, { config: harnessConfig.store ?? {} });
    if (out) process.stdout.write(`${out}\n`);
  } catch (err) {
    process.stderr.write(`store: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} else if (flags.runs !== undefined) {
  // The listing is the interop entry point: what a client asks before it decides to
  // start something, and what a human asks when a run seemed to do nothing.
  const limit = count(flags.runs) ?? 20;
  let rows = [];
  try {
    rows = listRuns({ dir: runsDirFlag(), limit });
  } catch (err) {
    process.stderr.write(`runs: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } else if (!rows.length) {
    process.stdout.write(`  no runs recorded yet in ${runsDirFlag()}\n`);
  } else {
    process.stdout.write(`  ${cell("run", 24)}${cell("status", 9)}${cell("steps", 7)}${cell("ms", 9)}${cell("tools", 7)}${cell("tokens", 9)}${cell("cost", 10)}task\n`);
    for (const r of rows) {
      const cost = r.usd === null || r.usd === undefined ? "" : r.usd === 0 ? "$0" : `$${r.usd < 0.01 ? r.usd.toFixed(4) : r.usd.toFixed(2)}`;
      process.stdout.write(
        `  ${cell(r.id, 24)}${cell(r.status, 9)}${cell(r.steps, 7)}${cell(r.ms, 9)}${cell(r.tools, 7)}${cell(r.tokens ?? "", 9)}${cell(cost, 10)}${shortTask(r.task)}\n`,
      );
    }
  }
} else if (flags.cancel !== undefined) {
  // Cancellation is a shared file, not a signal, so this works for a run started by
  // another process (the UI, a parent harness) — and it deliberately does not kill
  // anything: the run stops itself at its next step and records `stopped: cancelled`.
  const st = resolveRunArg("cancel");
  if (st) {
    const out = requestCancel({ dir: runsDirFlag(), id: st.id });
    process.stdout.write(`  ${out.ok ? "cancel requested" : "not cancelled"}  ${out.reason}\n`);
    if (!out.ok) process.exitCode = 1;
  }
} else if (flags.run !== undefined) {
  const st = resolveRunArg("run");
  if (st && flags.json) {
    process.stdout.write(`${JSON.stringify(st, null, 2)}\n`);
  } else if (st) {
    process.stdout.write(`  run        ${st.id}\n`);
    process.stdout.write(`  status     ${st.status}${st.running ? " (still going)" : st.ok ? " (ok)" : " (not ok)"}\n`);
    if (st.task) process.stdout.write(`  task       ${shortTask(st.task, 100)}\n`);
    process.stdout.write(
      `  progress   ${st.steps} step(s), ${st.tools} tool call(s), ${st.events} event(s)${st.ms === null ? "" : `, ${st.ms}ms`}\n`,
    );
    if (st.usage?.total?.calls) process.stdout.write(`  usage      ${formatUsage(st.usage)}\n`);
    if (st.lastTool) process.stdout.write(`  last tool  ${st.lastTool}\n`);
    if (st.lastEvent) process.stdout.write(`  last event ${st.lastEvent}\n`);
    if (st.error) process.stdout.write(`  error      ${st.error}\n`);
    if (!st.running) process.stdout.write(`  answer     ${shortTask(st.answer, 200) || "(none)"}\n`);
  }
} else if (flags["run-events"] !== undefined) {
  const st = resolveRunArg("run-events");
  if (st) {
    const found = readRun({ dir: runsDirFlag(), id: st.id, maxEvents: 100000 });
    const events = found ? found.events : [];
    for (const e of events) process.stdout.write(`${JSON.stringify(e)}\n`);
    if (found?.truncated) process.stderr.write(`note: showing the last ${events.length} events; the log is longer\n`);
  }
} else if (flags["run-record"] !== undefined) {
  const st = resolveRunArg("run-record");
  if (st) {
    const found = readRun({ dir: runsDirFlag(), id: st.id, maxEvents: 100000 });
    const record = found ? { ...found.record } : null;
    if (record && Array.isArray(record.events)) {
      const omitted = record.events.length;
      delete record.events;
      if (omitted) process.stderr.write(`note: ${omitted} embedded event(s) omitted - use --run-events for the log\n`);
    }
    if (record?.status === "running") process.stderr.write("note: this run is still going; the record is the live view\n");
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  }
} else if (flags.ui !== undefined) {
  // The visual surface: one browser tab over the same run store and the same
  // events the CLI prints, so a chat is one thing seen three ways (CLI, store,
  // UI) rather than three implementations.
  const raw = flags.ui === true ? "" : String(flags.ui).trim();
  if (raw && !/^\d+$/.test(raw)) {
    process.stderr.write(`--ui takes an optional port number, not "${raw}"\n`);
    process.exitCode = 2;
  } else {
    const { serveUi } = await import("./ui.mjs");
    await serveUi({
      port: raw ? Number(raw) : 8090,
      host: typeof flags["ui-host"] === "string" && flags["ui-host"].trim() ? flags["ui-host"].trim() : "127.0.0.1",
      routerUrl,
      workspace: root,
      // The UI reads the same store this CLI would write: --runs-dir moves both.
      home: dirname(runsDirFlag()),
    });
  }
} else if (flags["ext-sessions"]) {
  // Sessions the other harnesses already wrote on this machine. Read-only, and
  // it says so: nothing here writes into another tool's store.
  const listed = await listExternalSessions({ max: typeof flags.limit === "string" ? Number(flags.limit) : 40 });
  const counts = await sessionCounts({ max: 2000 });
  const short = (text, n) => (String(text ?? "").length > n ? `${String(text).slice(0, n - 1)}…` : String(text ?? ""));
  const lines = [];
  for (const source of Object.keys(listed.roots)) {
    lines.push(`${source.padEnd(9)} ${String(counts[source] ?? 0).padStart(5)}  ${listed.roots[source]}`);
  }
  lines.push("");
  for (const session of listed.sessions) {
    const when = session.at ? String(session.at).slice(0, 16).replace("T", " ") : "                ";
    lines.push(`${session.source.padEnd(9)} ${when}  ${short(session.title || session.id, 60)}  [${session.id}]`);
  }
  for (const note of listed.notes ?? []) lines.push(`note: ${note.source}: ${note.note}`);
  lines.push("", "read one with: --ext-session claude:<id>");
  process.stdout.write(`${lines.join("\n")}\n`);
} else if (flags["ext-session"] !== undefined) {
  const wanted = String(flags["ext-session"] === true ? "" : flags["ext-session"]).trim();
  const cut = wanted.indexOf(":");
  if (cut < 1) {
    process.stderr.write('--ext-session needs <source>:<id>, e.g. --ext-session claude:abc123 (sources: --ext-sessions)\n');
    process.exitCode = 2;
  } else {
    const source = wanted.slice(0, cut);
    const id = wanted.slice(cut + 1);
    const session = await readExternalSession({ source, id, max: Number(flags.steps ?? 200) });
    const lines = [`${source} ${session.meta.id}`, session.meta.title ? `title: ${session.meta.title}` : null, session.meta.path ? `file:  ${session.meta.path}` : null, ""];
    for (const message of session.messages) {
      const who = message.role === "user" ? "you" : message.role === "assistant" ? "agent" : message.role;
      lines.push(`${who}: ${message.text}`, "");
    }
    if (session.truncated) lines.push(`(truncated at ${session.messages.length} messages)`);
    process.stdout.write(`${lines.filter((line) => line !== null).join("\n")}\n`);
  }
} else if (flags.help) {
  process.stdout.write(`${USAGE}\n`);
} else if (flags.context) {
  process.stdout.write(`${describeContext(Boolean(flags.json))}\n`);
} else if (flags.hardware) {
  process.stdout.write(`${describeHardware(Boolean(flags.json))}\n`);
} else if (flags.check) {
  await check();
} else if (flags["voice-status"]) {
  process.stdout.write(`voice backends\n${describeBackends()}\n`);
} else if (positional.length) {
  if (await prepareLocalModel(agentOptions.cls)) {
    const rounds = Number(flags.rounds);
    if (Number.isFinite(rounds) && rounds > 1) {
      // A mission: rounds until the goal is done (goal-runner.mjs).
      const { runGoal } = await import("./goal-runner.mjs");
      const mission = await runGoal({
        ...agentOptions,
        task: positional.join(" "),
        maxRounds: rounds,
        maxHours: Number(flags.hours) > 0 ? Number(flags.hours) : 8,
        maxUsd: agentOptions.maxUsd ?? null,
        onRound: (r) => line(`◇ round ${r.round}: ${r.done ? "goal done" : r.error ? `failed (${String(r.error).slice(0, 120)})` : r.stopped ? `stopped (${r.stopped})` : `${r.steps} step(s)`}`),
      });
      if (mission.last) summarize(mission.last);
      line(`mission ${mission.done ? "done" : `stopped: ${mission.stopped}`} after ${mission.rounds.length} round(s), ${Math.round(mission.ms / 1000)}s`);
      if (!mission.done) process.exitCode = 2;
    } else {
      summarize(await runAgent({ ...agentOptions, task: positional.join(" ") }));
    }
  } else {
    process.exitCode = 1;
  }
} else {
  await session();
}
