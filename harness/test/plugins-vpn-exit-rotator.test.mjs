// The vpn-exit-rotator plugin, tested without a VPN.
//
// Nothing here starts, stops or lists a real process: `run` is injected and every
// case is driven from a stub process table, and `stat` is injected so "installed"
// and "not installed" are both reachable on one machine. That is the whole point
// of the two seams - a test suite for a plugin that must never be pointed at a
// live VPN client has to be able to say "Outline is running with five pids" and
// "taskkill was denied" without either being true.
//
// The tasklist rows in TASKLIST_REAL are this machine's output, pasted as printed
// (quoted fields, thousands separators and all), including a prefix collision -
// `ExpressVPNNotificationService.exe` - which is exactly the row a substring match
// would wrongly call ExpressVPN. Everything else is shaped after what tasklist,
// taskkill and a spawn print for those states, and each test says which is which.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import plugin, {
  defaultStat,
  emptyExitsState,
  formatBytes,
  formatDoctor,
  formatExitReport,
  locateProvider,
  parseStartResult,
  parseStopResult,
  parseTaskList,
  permissionOf,
  planFor,
  probeExits,
  providerOf,
  providerTable,
  resolveProviders,
  rotateExits,
  rowsFor,
  toggleExit,
} from "../plugins/rosa-vpn-exit-rotator/plugin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "plugins", "rosa-vpn-exit-rotator");

// The two executables as this machine reports them, and the alternates the plugin
// also looks in. The test env makes the candidate list exact, so a path assertion
// is about the plugin and not about where this checkout happens to run.
const OUTLINE_EXE = "C:\\Program Files (x86)\\Outline\\Outline.exe";
const OUTLINE_ALT = "C:\\Program Files\\Outline\\Outline.exe";
const OUTLINE_LOCAL = "C:\\Users\\someone\\AppData\\Local\\Programs\\Outline\\Outline.exe";
const EXPRESS_EXE = "C:\\Program Files (x86)\\ExpressVPN\\expressvpn-ui\\ExpressVPN.exe";
const EXPRESS_ALT = "C:\\Program Files\\ExpressVPN\\expressvpn-ui\\ExpressVPN.exe";

const TEST_ENV = {
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
};

// Captured from this machine with `tasklist /FO CSV /NH`: real quoting, real
// thousands separators, real "Services" vs "Console" sessions, and one image whose
// name starts with another's.
const TASKLIST_REAL = `"System Idle Process","0","Services","0","8 K"
"Secure System","64","Services","0","72,728 K"
"OutlineService.exe","4804","Services","0","18,480 K"
"ExpressVPN.SystemService.exe","4968","Services","0","40,248 K"
"ExpressVPN.VpnService.exe","4976","Services","0","47,288 K"
"Outline.exe","11276","Console","1","65,988 K"
"Outline.exe","30836","Console","1","21,968 K"
"ExpressVPN.exe","11732","Console","1","137,392 K"
"ExpressVPNNotificationService.exe","27532","Console","1","72,808 K"
`;

// What a filtered call prints when nothing matches: a sentence with exit code 0,
// which is an authoritative "not running" and not an error.
const TASKLIST_NO_MATCH = `INFO: No tasks are running which match the specified criteria.
`;

const csvRow = (image, pid, mem = "1,024 K") => `"${image}","${pid}","Console","1","${mem}"`;

const providerIdOfImage = (image) => {
  const key = String(image ?? "").toLowerCase();
  if (key === "outline.exe") return "outline";
  if (key === "expressvpn.exe") return "express";
  return null;
};

const providerIdOfPath = (path) => {
  const key = String(path ?? "").toLowerCase();
  if (key === OUTLINE_EXE.toLowerCase() || key === OUTLINE_ALT.toLowerCase() || key === OUTLINE_LOCAL.toLowerCase()) return "outline";
  if (key === EXPRESS_EXE.toLowerCase() || key === EXPRESS_ALT.toLowerCase()) return "express";
  return null;
};

/** A `stat` that answers from a set of paths, and records what was looked at. */
function fakeStat(existing = [OUTLINE_EXE, EXPRESS_EXE]) {
  const set = new Set(existing.map((path) => path.toLowerCase()));
  const looked = [];
  const stat = (path) => {
    looked.push(String(path));
    const hit = set.has(String(path).toLowerCase());
    return { exists: hit, size: hit ? 130_537_616 : null, mtime: hit ? "2026-07-20T15:04:56.000Z" : null };
  };
  stat.looked = looked;
  return stat;
}

/**
 * A machine in a variable: two images, a process table, and a tasklist/taskkill
 * that answer from it.
 *
 * `tasklistThrows` / `tasklistFailure` take "outline", "express" or "all" so the
 * "one provider unknown, the other readable" case is expressible. `taskkillResult`
 * and `startResult` come back verbatim, which is how "Access is denied" is tested.
 */
function fakeMachine({
  procs = { outline: [], express: [] },
  tasklistThrows = null,
  tasklistFailure = null,
  taskkillResult = null,
  startResult = null,
  startThrows = false,
  companions = [],
} = {}) {
  const live = { outline: [...procs.outline], express: [...procs.express] };
  const calls = [];
  let nextPid = 40_000;

  const run = async (command, args = [], options = {}) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    const line = [command, ...argv].join(" ");
    calls.push({ command: String(command), args: argv, options: options ?? {}, line });
    const detached = options?.detached === true;

    if (command === "tasklist") {
      const fi = argv.indexOf("/FI");
      const filter = fi >= 0 ? String(argv[fi + 1] ?? "") : "";
      const one = /^IMAGENAME eq\s+(.+)$/i.exec(filter);
      const wanted = one ? [one[1].trim()] : ["Outline.exe", "ExpressVPN.exe"];
      const key = one ? providerIdOfImage(wanted[0]) : "all";
      if (tasklistThrows === "all" || (key !== "all" && tasklistThrows === key)) throw new Error("tasklist is not available (stub)");
      if (tasklistFailure === "all" || (key !== "all" && tasklistFailure === key)) {
        return { code: 1, stdout: "", stderr: "ERROR: The RPC server is unavailable. (stub)" };
      }
      const rows = [];
      for (const image of wanted) {
        const id = providerIdOfImage(image);
        if (!id) continue;
        for (const pid of live[id]) rows.push(csvRow(image, pid));
      }
      if (!one) for (const entry of companions) rows.push(csvRow(entry.image, entry.pid));
      return {
        code: 0,
        stdout: rows.length ? `${rows.join("\r\n")}\r\n` : TASKLIST_NO_MATCH,
        stderr: "",
      };
    }

    if (command === "taskkill") {
      const at = argv.indexOf("/PID");
      const pid = Number(argv[at + 1]);
      const custom = taskkillResult ? await taskkillResult(pid) : null;
      if (custom) return custom;
      let hit = false;
      for (const id of Object.keys(live)) {
        const index = live[id].indexOf(pid);
        if (index >= 0) {
          live[id].splice(index, 1);
          hit = true;
        }
      }
      return hit
        ? { code: 0, stdout: `SUCCESS: The process with PID ${pid} has been terminated.\r\n`, stderr: "" }
        : { code: 128, stdout: `ERROR: The process "${pid}" not found.\r\n`, stderr: "" };
    }

    if (detached) {
      if (startThrows) throw new Error("spawn EACCES (stub)");
      const custom = startResult ? await startResult(command) : null;
      if (custom) return custom;
      const id = providerIdOfPath(command);
      if (!id) return { code: 1, pid: null, stdout: "", stderr: `unexpected executable: ${command}` };
      nextPid += 1;
      live[id].push(nextPid);
      return { code: 0, pid: nextPid, stdout: "", stderr: "" };
    }

    return { code: 1, stdout: "", stderr: `unexpected command: ${command}` };
  };

  return {
    run,
    calls,
    live,
    lines: () => calls.map((entry) => entry.line),
    tasklists: () => calls.filter((entry) => entry.command === "tasklist").map((entry) => entry.line),
    kills: () => calls.filter((entry) => entry.command === "taskkill").map((entry) => entry.line),
    starts: () => calls.filter((entry) => entry.options?.detached === true),
    indexOfFirstStart: () => calls.findIndex((entry) => entry.options?.detached === true),
    indexOfLastKill: () => calls.reduce((last, entry, index) => (entry.command === "taskkill" ? index : last), -1),
  };
}

// Tests never wait: a zero interval makes the verification loops run once each.
const FAST = { startAttempts: 2, startIntervalMs: 0, stopAttempts: 2, stopIntervalMs: 0 };

const probeOptions = (machine, stat, config = {}) => ({
  run: machine.run,
  stat,
  platform: "win32",
  env: TEST_ENV,
  config,
});

const toggleOptions = (machine, stat, config = {}) => ({
  ...probeOptions(machine, stat, config),
  ...FAST,
});

/** A run token with the shape the host hands a hook: a per-run Map window. */
function runToken() {
  const map = new Map();
  return {
    id: "run-1",
    state: {
      has: (key) => map.has(key),
      get: (key) => map.get(key),
      set: (key, value) => map.set(key, value),
      delete: (key) => map.delete(key),
    },
  };
}

/**
 * What a run sees from the report: the probe starts at run start without holding the run,
 * and its note arrives with the first step after it has answered. Waits for the probe the
 * way the engine's next step would come along, then asks that step for the note.
 */
async function reportFor(hooks, args) {
  const inline = await hooks.onRunStart(args);
  if (inline !== undefined) return inline;
  const slot = args.run?.state?.get?.("vpnNote");
  for (let i = 0; slot && !slot.done && i < 200; i += 1) await new Promise((done) => setTimeout(done, 10));
  return hooks.beforeStep(args);
}

// ------------------------------------------------------------------- manifest

test("the manifest is a real plugin manifest, and its entry exists", () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8"));
  assert.equal(manifest.id, "rosa-vpn-exit-rotator");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.bundled, true);
  assert.equal(manifest.enabled, true);
  assert.equal(manifest.entry, "plugin.mjs");
  assert.ok(existsSync(join(PLUGIN_DIR, manifest.entry)));
  assert.ok(manifest.description.length > 40);
  assert.equal(typeof manifest.config, "object");
  assert.equal(manifest.config.rotateDefault, "outline");
  assert.equal(manifest.config.allowToggle, true);
  // The manifest and the module must agree on the id, or `/plugins` and
  // `/vpn-exit-rotator:status` would name the same thing differently.
  assert.equal(plugin.id, manifest.id);
});

test("the plugin files are ASCII, and the doc explains what it will not do", () => {
  for (const name of ["plugin.json", "plugin.mjs", "README.md"]) {
    const text = readFileSync(join(PLUGIN_DIR, name), "utf8");
    assert.match(text, /^[\x09\x0a\x0d\x20-\x7e]*$/, `${name} must be ASCII`);
  }
  const readme = readFileSync(join(PLUGIN_DIR, "README.md"), "utf8");
  // The three sentences a future reader most needs are regression-tested here.
  assert.match(readme, /not a tunnel/i);
  assert.match(readme, /detached/i);
  assert.match(readme, /tasklist/i);
});

// ------------------------------------------------------- tasklist and friends

test("parseTaskList reads a real tasklist transcript, quotes, commas and all", () => {
  const rows = parseTaskList(TASKLIST_REAL);
  assert.equal(rows.length, 9);
  const first = rows[0];
  assert.equal(first.image, "System Idle Process");
  assert.equal(first.pid, 0);
  assert.equal(first.session, "Services");
  assert.equal(first.sessionNumber, 0);
  assert.equal(first.memKb, 8);
  const outline = rows.find((row) => row.pid === 11276);
  assert.equal(outline.image, "Outline.exe");
  assert.equal(outline.session, "Console");
  assert.equal(outline.sessionNumber, 1);
  assert.equal(outline.memKb, 65_988);
  const secure = rows.find((row) => row.pid === 64);
  assert.equal(secure.memKb, 72_728);
});

test("parseTaskList treats the filtered no-match sentence as no rows, not as a row", () => {
  assert.deepEqual(parseTaskList(TASKLIST_NO_MATCH), []);
  assert.deepEqual(parseTaskList(""), []);
  assert.deepEqual(parseTaskList(null), []);
  assert.deepEqual(parseTaskList("INFO: No tasks are running.\r\n"), []);
});

test("parseTaskList skips a header row and unquoted noise", () => {
  const withHeader = `"Image Name","PID","Session Name","Session#","Mem Usage"\r\n${csvRow("Outline.exe", 42)}\r\nnot a csv line\r\n`;
  const rows = parseTaskList(withHeader);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].image, "Outline.exe");
  assert.equal(rows[0].pid, 42);
});

test("parseTaskList handles an image name with an embedded quoted comma", () => {
  const rows = parseTaskList(`"Weird, ""Name"".exe","77","Console","1","1 K"\r\n`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].image, 'Weird, "Name".exe');
  assert.equal(rows[0].pid, 77);
});

test("rowsFor matches the exact image only, never a prefix", () => {
  const rows = parseTaskList(TASKLIST_REAL);
  assert.deepEqual(rowsFor(rows, "Outline.exe").map((row) => row.pid), [11276, 30836]);
  assert.deepEqual(rowsFor(rows, "ExpressVPN.exe").map((row) => row.pid), [11732]);
  // The notification service is a different program; a prefix match would kill it.
  assert.equal(rowsFor(rows, "ExpressVPN.exe").some((row) => row.image === "ExpressVPNNotificationService.exe"), false);
  assert.deepEqual(rowsFor(rows, "outline.exe").map((row) => row.pid), [11276, 30836], "Windows image names are case-insensitive");
  assert.deepEqual(rowsFor(rows, "ExpressVPNNotificationService.exe").map((row) => row.pid), [27532]);
});

test("parseStartResult needs a pid, not just exit code 0", () => {
  const ok = parseStartResult({ code: 0, pid: 4242, stdout: "", stderr: "" });
  assert.equal(ok.ok, true);
  assert.equal(ok.pid, 4242);
  assert.equal(ok.permission, false);
  assert.match(ok.message, /4242/);

  const noPid = parseStartResult({ code: 0, pid: null, stdout: "", stderr: "" });
  assert.equal(noPid.ok, false, "a spawn that returned no pid did not start anything");

  const refused = parseStartResult({ code: -1, pid: null, stderr: "spawn EACCES" });
  assert.equal(refused.ok, false);
  assert.equal(refused.permission, true);
});

test("parseStopResult tells success, already-gone and access-denied apart", () => {
  const ok = parseStopResult({ code: 0, stdout: "SUCCESS: The process with PID 42 has been terminated.\r\n", stderr: "" });
  assert.equal(ok.ok, true);
  assert.equal(ok.permission, false);
  assert.match(ok.message, /has been terminated/);

  const notFound = parseStopResult({ code: 128, stdout: 'ERROR: The process "42" not found.\r\n', stderr: "" });
  assert.equal(notFound.ok, false);
  assert.equal(notFound.notFound, true);
  assert.equal(notFound.permission, false);

  const denied = parseStopResult({
    code: 5,
    stdout: "ERROR: The process with PID 42 could not be terminated.\r\nReason: Access is denied.\r\n",
    stderr: "",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.permission, true);
  assert.equal(permissionOf("ERROR: Access is denied."), true);
  assert.equal(permissionOf("SUCCESS: done"), false);
});

test("formatBytes and the provider table are stable", () => {
  assert.equal(formatBytes(130_537_616), "124.5 MB");
  assert.equal(formatBytes(855_400), "835.4 KB");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(null), "size not reported");
  const table = providerTable({ env: TEST_ENV });
  assert.deepEqual(table.map((entry) => entry.id), ["outline", "express"]);
  assert.deepEqual(table.map((entry) => entry.image), ["Outline.exe", "ExpressVPN.exe"]);
  assert.equal(table[0].installs[0], OUTLINE_EXE);
  assert.equal(table[1].installs[0], EXPRESS_EXE);
});

test("providerOf accepts the names a person or a model would type", () => {
  assert.equal(providerOf("outline").id, "outline");
  assert.equal(providerOf("Outline").id, "outline");
  assert.equal(providerOf("OUTLINE.EXE").id, "outline");
  assert.equal(providerOf("express").id, "express");
  assert.equal(providerOf("ExpressVPN").id, "express");
  assert.equal(providerOf("nordvpn"), null);
  assert.equal(providerOf(""), null);
  assert.equal(providerOf(null), null);
});

test("resolveProviders puts a configured install path first and keeps the defaults", () => {
  const providers = resolveProviders({ env: TEST_ENV, config: { installs: { outline: "D:\\Elsewhere\\Outline.exe" } } });
  assert.equal(providers[0].installs[0], "D:\\Elsewhere\\Outline.exe");
  assert.ok(providers[0].installs.includes(OUTLINE_EXE));
  assert.equal(new Set(providers[0].installs.map((path) => path.toLowerCase())).size, providers[0].installs.length);
});

test("locateProvider reports every path it looked in, and never guesses", () => {
  const stat = fakeStat([]);
  const located = locateProvider(providerTable({ env: TEST_ENV })[0], stat);
  assert.equal(located.installed, false);
  assert.deepEqual(located.searched, [OUTLINE_EXE, OUTLINE_ALT, OUTLINE_LOCAL]);
  assert.deepEqual(stat.looked, [OUTLINE_EXE, OUTLINE_ALT, OUTLINE_LOCAL]);
  assert.equal(located.size, null);
});

test("locateProvider stops at the first path that exists and reports its size", () => {
  const stat = fakeStat([OUTLINE_ALT]);
  const located = locateProvider(providerTable({ env: TEST_ENV })[0], stat);
  assert.equal(located.installed, true);
  assert.equal(located.path, OUTLINE_ALT);
  assert.deepEqual(located.searched, [OUTLINE_EXE, OUTLINE_ALT], "paths after the hit are not claimed");
  assert.equal(located.size, 130_537_616);
});

test("defaultStat is a real check and answers false rather than throwing", () => {
  assert.equal(defaultStat(join(PLUGIN_DIR, "plugin.mjs")).exists, true);
  assert.equal(defaultStat(join(PLUGIN_DIR, "no-such-file.exe")).exists, false);
  assert.equal(defaultStat("").exists, false);
});

// --------------------------------------------------------------------- status

test("status: installed and running, with the pids tasklist reported", async () => {
  const machine = fakeMachine({ procs: { outline: [11276, 30836], express: [] } });
  const stat = fakeStat();
  const state = await probeExits(probeOptions(machine, stat));

  assert.equal(state.supported, true);
  assert.equal(state.unknown, false);
  assert.equal(state.conflict, false);
  assert.equal(state.active, "outline");
  assert.equal(state.activeCount, 1);

  const outline = state.providers.find((entry) => entry.id === "outline");
  assert.equal(outline.installed, true);
  assert.equal(outline.path, OUTLINE_EXE);
  assert.equal(outline.size, 130_537_616);
  assert.equal(outline.running, true);
  assert.deepEqual(outline.pids, [11276, 30836]);
  assert.equal(outline.how, "tasklist");

  const express = state.providers.find((entry) => entry.id === "express");
  assert.equal(express.installed, true);
  assert.equal(express.running, false);
  assert.deepEqual(express.pids, []);

  const report = formatExitReport(state);
  assert.match(report, /active\s+Outline/);
  assert.match(report, /running - 2 processes \(pids 11276, 30836\)/);
  assert.match(report, /installed at C:\\Program Files \(x86\)\\Outline\\Outline\.exe \(124\.5 MB\)/);
  assert.match(report, /not running - tasklist lists no ExpressVPN\.exe/);
  assert.match(report, /how known\s+tasklist/);
});

test("status: installed and stopped is 'not running', not a guess either way", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [] } });
  const state = await probeExits(probeOptions(machine, fakeStat()));
  assert.equal(state.active, null);
  assert.equal(state.activeCount, 0);
  assert.equal(state.providers.every((entry) => entry.running === false), true);
  const report = formatExitReport(state);
  assert.match(report, /active\s+none - neither client is running/);
  assert.match(report, /not running - tasklist lists no Outline\.exe/);
  assert.match(report, /No exit is running/);
});

test("status: a missing install says 'not installed, looked in' with every path", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [] } });
  const stat = fakeStat([EXPRESS_EXE]);
  const state = await probeExits(probeOptions(machine, stat));
  const outline = state.providers.find((entry) => entry.id === "outline");
  assert.equal(outline.installed, false);
  assert.equal(outline.path, OUTLINE_EXE);
  assert.deepEqual(outline.searched, [OUTLINE_EXE, OUTLINE_ALT, OUTLINE_LOCAL]);

  const report = formatExitReport(state);
  assert.match(report, /not installed, looked in C:\\Program Files \(x86\)\\Outline\\Outline\.exe, C:\\Program Files\\Outline\\Outline\.exe/);
  assert.match(report, /Programs\\Outline\\Outline\.exe/);
});

test("status: a runner that throws is 'unknown', never 'off'", async () => {
  const machine = fakeMachine({ tasklistThrows: "all" });
  const state = await probeExits(probeOptions(machine, fakeStat()));
  assert.equal(state.unknown, true);
  assert.equal(state.active, null);
  for (const entry of state.providers) {
    assert.equal(entry.running, null, "unknown is null: there is no boolean for 'not known'");
    assert.equal(entry.how, "unknown - tasklist failed");
    assert.match(entry.error, /tasklist is not available/);
  }
  const report = formatExitReport(state);
  assert.match(report, /active\s+unknown/);
  assert.match(report, /unknown - tasklist could not answer, so this is not off/);
  assert.doesNotMatch(report, /not running/);
  assert.doesNotMatch(report, /active\s+none/);
});

test("status: a tasklist that exits non-zero is unknown too, with its message", async () => {
  const machine = fakeMachine({ tasklistFailure: "express" });
  const state = await probeExits(probeOptions(machine, fakeStat()));
  const express = state.providers.find((entry) => entry.id === "express");
  const outline = state.providers.find((entry) => entry.id === "outline");
  assert.equal(outline.running, false, "the readable provider still answers");
  assert.equal(express.running, null);
  assert.equal(state.unknown, true);
  assert.match(express.error, /RPC server is unavailable/);
  assert.match(state.note, /unknown - not off/);
});

test("status: one client running is the active exit; both is a conflict that is named", async () => {
  const machine = fakeMachine({ procs: { outline: [1], express: [2] } });
  const state = await probeExits(probeOptions(machine, fakeStat()));
  assert.equal(state.conflict, true);
  assert.equal(state.active, null);
  assert.equal(state.activeCount, 2);
  const report = formatExitReport(state);
  assert.match(report, /active\s+both \(Outline and ExpressVPN\)/);
  assert.match(report, /broken network, not a feature/);
});

test("status: doctor reports the companion services it will not stop", async () => {
  const machine = fakeMachine({
    procs: { outline: [11276], express: [11732] },
    companions: [
      { image: "OutlineService.exe", pid: 4804 },
      { image: "ExpressVPN.VpnService.exe", pid: 4976 },
      { image: "ExpressVPNNotificationService.exe", pid: 27532 },
    ],
  });
  const state = await probeExits({ ...probeOptions(machine, fakeStat()), mode: "full" });
  assert.equal(state.how, "tasklist, one full list");
  // Only the companions that are actually in the process table, in the table's own
  // order, and the client images are not listed among them.
  assert.deepEqual(
    state.companions.map((entry) => entry.image),
    ["OutlineService.exe", "ExpressVPN.VpnService.exe", "ExpressVPNNotificationService.exe"],
  );
  assert.equal(state.companions.some((entry) => entry.image === "ExpressVPN.exe"), false);
  assert.equal(machine.tasklists().length, 1, "doctor reads the table once, not once per image");

  const doctor = formatDoctor(state, { config: { rotateDefault: "express" } });
  assert.match(doctor, /exit rotator doctor/);
  assert.match(doctor, /OutlineService\.exe \(pid 4804\)/);
  assert.match(doctor, /ExpressVPN\.VpnService\.exe \(pid 4976\)/);
  assert.match(doctor, /reported, never stopped/);
  assert.match(doctor, /rotateDefault express/);
  assert.match(doctor, /permission\s+not testable without acting/);
});

test("a non-Windows machine is unsupported, and nothing is checked", async () => {
  const machine = fakeMachine();
  const state = await probeExits({ ...probeOptions(machine, fakeStat()), platform: "linux" });
  assert.equal(state.supported, false);
  assert.equal(state.providers.every((entry) => entry.running === null), true);
  assert.match(state.note, /Windows only/);
  assert.deepEqual(machine.calls, [], "an unsupported platform runs no command at all");
  const report = formatExitReport(state);
  assert.match(report, /Windows only/);
  assert.match(report, /Nothing was checked/);
});

// --------------------------------------------------------------------- toggle

test("toggle on when stopped starts the exact executable, detached", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [] } });
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()) });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, "start");
  assert.equal(outcome.verified, true);
  assert.equal(outcome.started.path, OUTLINE_EXE);

  const starts = machine.starts();
  assert.equal(starts.length, 1, "exactly one start");
  assert.equal(starts[0].command, OUTLINE_EXE, "the executable's own path, not a shell and not a name");
  assert.deepEqual(starts[0].args, []);
  assert.equal(starts[0].options.detached, true, "detached is what makes the harness not its parent");
  assert.deepEqual(machine.kills(), [], "nothing had to be stopped first");
  assert.match(outcome.message, /started detached/);
  assert.match(outcome.message, /closing the harness does not close it/);
  assert.match(outcome.message, /was not running, so nothing had to be stopped first/);
  assert.deepEqual(outcome.plan, [`start ${OUTLINE_EXE} detached`]);
});

test("toggle on when already running sends no second start", async () => {
  const machine = fakeMachine({ procs: { outline: [11276, 30836], express: [] } });
  const before = machine.calls.length;
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()) });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, "none");
  assert.equal(outcome.verified, true);
  assert.equal(machine.starts().length, 0, "an already-running client is never started twice");
  assert.deepEqual(machine.kills(), []);
  assert.equal(machine.calls.length - before, 2, "one probe, and nothing else");
  assert.match(outcome.message, /already on/);
  assert.match(outcome.message, /Nothing was started/);
});

test("toggle off stops the exact image's pids and nothing else", async () => {
  const machine = fakeMachine({ procs: { outline: [11276, 30836], express: [11732] } });
  const outcome = await toggleExit({ provider: "outline", on: false, ...toggleOptions(machine, fakeStat()) });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, "stop");
  assert.equal(outcome.verified, true);
  assert.deepEqual(machine.kills(), ["taskkill /PID 11276 /F", "taskkill /PID 30836 /F"]);
  assert.equal(machine.kills().some((line) => line.includes("11732")), false, "the other client's pid is never touched");
  assert.equal(machine.starts().length, 0);
  assert.deepEqual(machine.live.express, [11732], "the other client is still running");
  assert.match(outcome.message, /tasklist now reports no Outline\.exe/);
  assert.match(outcome.message, /OutlineService\.exe/, "the client is not the service, and the message says so");
  // No /IM, no wildcard, no tree: every stop names one pid.
  for (const line of machine.kills()) assert.match(line, /^taskkill \/PID \d+ \/F$/);
});

test("toggle off when already off is idempotent", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [11732] } });
  const outcome = await toggleExit({ provider: "outline", on: false, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, "none");
  assert.equal(machine.starts().length, 0);
  assert.deepEqual(machine.kills(), []);
  assert.match(outcome.message, /already off/);
  assert.match(outcome.message, /tasklist reports no Outline\.exe/);
});

test("rotation stops the other exit first, then starts this one", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [11732] } });
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()) });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.action, "start");
  assert.equal(outcome.verified, true);
  assert.deepEqual(machine.kills(), ["taskkill /PID 11732 /F"]);
  assert.equal(machine.starts().length, 1);
  assert.ok(machine.indexOfLastKill() < machine.indexOfFirstStart(), "the stop is issued before the start, in that order");
  assert.deepEqual(machine.live, { outline: [40_001], express: [] }, "one exit is up, and it is the one asked for");
  assert.match(outcome.message, /ExpressVPN was stopped first/);
  assert.match(outcome.message, /only one exit is up/);
  assert.deepEqual(outcome.plan, [`stop ExpressVPN (1 process, pid 11732)`, `start ${OUTLINE_EXE} detached`]);
});

test("rotate picks the other client, and says what it is about to do", async () => {
  const machine = fakeMachine({ procs: { outline: [11276], express: [] } });
  const outcome = await rotateExits({ ...toggleOptions(machine, fakeStat()) });

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.rotate, { from: "outline", to: "express" });
  assert.equal(machine.starts()[0].command, EXPRESS_EXE);
  assert.match(outcome.message, /^Rotating from Outline to ExpressVPN/);
  assert.match(outcome.message, /stopped first, then ExpressVPN is started/);
  assert.deepEqual(machine.kills(), ["taskkill /PID 11276 /F"]);
});

test("rotate with nothing running starts the configured default and says so", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [] } });
  const outcome = await rotateExits({ ...toggleOptions(machine, fakeStat(), { rotateDefault: "express" }) });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.rotate, { from: null, to: "express" });
  assert.match(outcome.message, /No exit is running, so rotating starts ExpressVPN \(config\.rotateDefault\)/);
  assert.equal(machine.starts()[0].command, EXPRESS_EXE);
});

test("rotate refuses to guess when both clients are running", async () => {
  const machine = fakeMachine({ procs: { outline: [1], express: [2] } });
  const outcome = await rotateExits({ ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "conflict");
  assert.deepEqual(machine.kills(), []);
  assert.equal(machine.starts().length, 0);
  assert.match(outcome.message, /Both Outline and ExpressVPN are running/);
  assert.match(outcome.message, /say "outline on" or "express on"/);
});

test("turn on refuses when the executable is missing, and leaves the other exit alone", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [11732] } });
  const stat = fakeStat([EXPRESS_EXE]);
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, stat) });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "not-installed");
  assert.equal(outcome.action, "refused");
  assert.match(outcome.message, /Outline is not installed, looked in C:\\Program Files \(x86\)\\Outline\\Outline\.exe/);
  assert.match(outcome.message, /was left as it was/);
  assert.deepEqual(machine.kills(), [], "the guard runs before any stop: no exit was ended for nothing");
  assert.equal(machine.starts().length, 0);
  assert.deepEqual(machine.live.express, [11732]);
});

test("rotate refuses when the other client is missing, so no exit is left down", async () => {
  const machine = fakeMachine({ procs: { outline: [11276], express: [] } });
  const outcome = await rotateExits({ ...toggleOptions(machine, fakeStat([OUTLINE_EXE])) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "not-installed");
  assert.deepEqual(machine.kills(), []);
  assert.deepEqual(machine.live.outline, [11276], "Outline is still running: the zero-exit guard refused first");
  assert.match(outcome.message, /ExpressVPN is not installed/);
});

test("turn on refuses when the state of a client is unknown", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [11732] }, tasklistThrows: "express" });
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "unknown");
  assert.deepEqual(machine.kills(), []);
  assert.equal(machine.starts().length, 0);
  assert.match(outcome.message, /could not be read for ExpressVPN/);
});

test("turn off is allowed even while the other client's state is unknown", async () => {
  const machine = fakeMachine({ procs: { outline: [11276], express: [] }, tasklistThrows: "express" });
  const outcome = await toggleExit({ provider: "outline", on: false, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, true, "off is the direction that cannot strand a person");
  assert.deepEqual(machine.kills(), ["taskkill /PID 11276 /F"]);
});

test("a denied taskkill is a permission refusal, never a stop", async () => {
  const machine = fakeMachine({
    procs: { outline: [11276], express: [] },
    taskkillResult: (pid) => ({
      code: 5,
      stdout: `ERROR: The process with PID ${pid} could not be terminated.\r\nReason: Access is denied.\r\n`,
      stderr: "",
    }),
  });
  const outcome = await toggleExit({ provider: "outline", on: false, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "permission");
  assert.equal(outcome.permission, true);
  assert.equal(outcome.verified, false);
  assert.match(outcome.message, /does not have permission to stop that process/);
  assert.deepEqual(machine.live.outline, [11276], "nothing was claimed as stopped");
});

test("when the other client cannot be stopped, this one is not started", async () => {
  const machine = fakeMachine({
    procs: { outline: [], express: [11732] },
    taskkillResult: () => ({ code: 5, stdout: "", stderr: "ERROR: Access is denied.\r\n" }),
  });
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.action, "stop-failed");
  assert.equal(machine.starts().length, 0, "two clients fighting over the default route is the state this avoids");
  assert.match(outcome.message, /nothing was started/);
});

test("a start refused by the OS is a permission refusal with the spawn error", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [] }, startThrows: true });
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "permission");
  assert.equal(outcome.permission, true);
  assert.match(outcome.message, /spawn EACCES/);
});

test("a start that exits at once is reported as not running, not as on", async () => {
  const machine = fakeMachine({
    procs: { outline: [], express: [] },
    // The launcher returns a pid, and the process is gone before the first check.
    startResult: () => ({ code: 0, pid: 51_000, stdout: "", stderr: "" }),
  });
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "not-verified");
  assert.equal(outcome.verified, false);
  assert.match(outcome.message, /still reports no Outline/);
  assert.match(outcome.message, /Nothing is claimed beyond what the process table shows/);
});

test("a client that needs a second sample before it appears is still verified", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [] } });
  // A client that takes a moment to appear in the process table: the first tasklist
  // after the spawn is answered as if the table had not caught up yet.
  let spawned = false;
  let blind = 0;
  const run = async (command, args, options) => {
    if (options?.detached === true) spawned = true;
    if (spawned && command === "tasklist" && machine.live.outline.length > 0 && blind === 0) {
      blind += 1;
      machine.calls.push({ command, args: [...(args ?? [])], options: options ?? {}, line: [command, ...(args ?? [])].join(" ") });
      return { code: 0, stdout: TASKLIST_NO_MATCH, stderr: "" };
    }
    return machine.run(command, args, options);
  };

  const outcome = await toggleExit({
    provider: "outline",
    on: true,
    ...toggleOptions({ ...machine, run }, fakeStat()),
    startAttempts: 3,
  });
  assert.equal(blind, 1, "the blind sample really happened");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verified, true);
  assert.match(outcome.message, /Outline is on/);
});

test("an unknown provider and a non-boolean 'on' are refused without touching anything", async () => {
  const machine = fakeMachine();
  const bad = await toggleExit({ provider: "nordvpn", on: true, ...toggleOptions(machine, fakeStat()) });
  assert.equal(bad.ok, false);
  assert.equal(bad.refused, "unknown-provider");
  assert.match(bad.message, /The two providers are outline and express/);

  const notBoolean = await toggleExit({ provider: "outline", on: "yes", ...toggleOptions(machine, fakeStat()) });
  assert.equal(notBoolean.ok, false);
  assert.equal(notBoolean.refused, "bad-request");
  assert.deepEqual(machine.calls, [], "a malformed request runs nothing");
});

test("toggle on a non-Windows platform refuses with the reason", async () => {
  const machine = fakeMachine();
  const outcome = await toggleExit({ provider: "outline", on: true, ...toggleOptions(machine, fakeStat()), platform: "darwin" });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.refused, "platform");
  assert.match(outcome.message, /Windows only/);
  assert.deepEqual(machine.calls, []);
});

// ------------------------------------------------------------------- the plan

test("planFor builds a stop-then-start plan without running anything", () => {
  const state = {
    providers: [
      {
        id: "outline",
        label: "Outline",
        image: "Outline.exe",
        installed: true,
        running: false,
        pids: [],
        path: OUTLINE_EXE,
        searched: [OUTLINE_EXE],
      },
      {
        id: "express",
        label: "ExpressVPN",
        image: "ExpressVPN.exe",
        installed: true,
        running: true,
        pids: [11732],
        path: EXPRESS_EXE,
        searched: [EXPRESS_EXE],
      },
    ],
  };
  const plan = planFor(state, { provider: "outline", on: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.noop, false);
  assert.deepEqual(plan.steps.map((step) => step.kind), ["stop", "start"]);
  assert.equal(plan.steps[1].command, OUTLINE_EXE);
  assert.match(plan.summary, /^stop ExpressVPN \(1 process, pid 11732\), then start /);

  const off = planFor(state, { provider: "outline", on: false });
  assert.equal(off.noop, true, "nothing is running to stop");
  assert.deepEqual(off.steps, []);

  const missing = planFor({ ...state, providers: [state.providers[0], { ...state.providers[1], installed: false }] }, { provider: "express", on: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "not-installed");
});

test("emptyExitsState is renderable and honest about not having checked", () => {
  const state = emptyExitsState("the plugin could not be imported");
  assert.equal(state.unknown, true);
  assert.equal(state.providers.length, 2);
  for (const entry of state.providers) {
    assert.equal(entry.installed, null);
    assert.equal(entry.running, null);
    assert.equal(entry.how, "not checked");
  }
  assert.match(state.note, /could not be imported/);
});

// ---------------------------------------------------------------- the plugin

// Pinned rather than inherited: the plugin decides "Windows only" from ctx.config.platform
// (plugin.mjs), so these keep exercising the Windows half on the Linux runner that gates
// the release instead of skipping there - a skipped test would hide a real regression.
const WINDOWS = "win32";
test("the default export lists its commands and tools, and its status is static", async () => {
  const machine = fakeMachine({ procs: { outline: [11276], express: [] } });
  const ctx = { config: { platform: WINDOWS }, run: machine.run, stat: fakeStat(), env: TEST_ENV };

  const commands = plugin.commands(ctx);
  assert.deepEqual(Object.keys(commands).sort(), ["doctor", "express", "outline", "rotate", "status"]);

  const report = await commands.status();
  assert.match(report, /vpn exits on this machine/);
  assert.match(report, /Outline/);

  const one = await commands.outline(["off"]);
  assert.match(one, /^plan: /);
  assert.match(one, /tasklist now reports no Outline\.exe/);
  assert.match(one, /vpn exits on this machine/);

  const usage = await commands.express(["maybe"]);
  assert.match(usage, /usage: express on\|off/);

  const rotated = await commands.rotate();
  assert.match(rotated, /^plan: /);
  // Outline was just turned off, so there is nothing to rotate away from and the
  // configured default is stated out loud rather than assumed silently.
  assert.match(rotated, /No exit is running, so rotating starts Outline \(config\.rotateDefault\)/);

  const doctor = await commands.doctor();
  assert.match(doctor, /exit rotator doctor/);

  const tools = plugin.tools(ctx);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["vpn_exit_status", "vpn_exit_toggle"]);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object");
    assert.equal(typeof tool.run, "function");
  }

  assert.equal(typeof plugin.status(ctx), "string");
  assert.match(plugin.status(ctx), /Outline and ExpressVPN/);
  assert.match(plugin.status({ config: { platform: "linux" } }), /Windows only/);
  assert.equal(typeof plugin.description, "string");
  assert.equal(plugin.id, "rosa-vpn-exit-rotator");
});

test("the status tool reports unknown rather than throwing when the runner fails", async () => {
  const broken = {
    config: { platform: WINDOWS },
    run: async () => {
      throw new Error("the process table is gone");
    },
    stat: fakeStat(),
    env: TEST_ENV,
  };
  const [status, toggle] = plugin.tools(broken);
  const text = await status.run();
  assert.match(text, /unknown/);
  assert.doesNotMatch(text, /not running/);
  const attempted = await toggle.run({ provider: "outline", on: false });
  assert.match(attempted, /not off|unknown|could not be read/);
});

test("the toggle tool changes the state, and refuses everything it should", async () => {
  const machine = fakeMachine({ procs: { outline: [], express: [11732] } });
  const ctx = { config: { platform: WINDOWS }, run: machine.run, stat: fakeStat(), env: TEST_ENV };
  const toggle = plugin.tools(ctx).find((tool) => tool.name === "vpn_exit_toggle");

  const started = await toggle.run({ provider: "outline", on: true });
  assert.match(started, /Outline is on/);
  assert.match(started, /vpn exits on this machine/);
  assert.deepEqual(machine.kills(), ["taskkill /PID 11732 /F"]);
  assert.equal(machine.starts().length, 1);

  const readOnly = plugin.tools({ ...ctx, config: { platform: WINDOWS, allowToggle: false } }).find((tool) => tool.name === "vpn_exit_toggle");
  const refusal = await readOnly.run({ provider: "outline", on: false });
  assert.match(refusal, /switched off in this install/);
});

test("the run-start hook reports the active exit once per run, and is silent when none is up", async () => {
  const machine = fakeMachine({ procs: { outline: [11276, 30836], express: [] } });
  const ctx = { config: { platform: WINDOWS }, run: machine.run, stat: fakeStat(), env: TEST_ENV };
  const hooks = plugin.hooks(ctx);
  const token = runToken();

  const note = await reportFor(hooks, { depth: 0, run: token });
  assert.equal(typeof note?.note, "string");
  assert.match(note.note, /network exit: Outline \(tasklist: 2 processes, pids 11276, 30836\)/);
  assert.match(note.note, /nothing was started or stopped/);

  // A second step in the same run must not repeat it.
  assert.equal(await reportFor(hooks, { depth: 0, run: token }), undefined);

  // A delegated worker does not get its own copy.
  assert.equal(await reportFor(hooks, { depth: 1, run: runToken() }), undefined);

  const quiet = plugin.hooks({ config: { platform: WINDOWS }, run: fakeMachine({ procs: { outline: [], express: [] } }).run, stat: fakeStat(), env: TEST_ENV });
  assert.equal(await reportFor(quiet, { depth: 0, run: runToken() }), undefined, "no exit up is the normal case: no note");

  const offByConfig = plugin.hooks({ ...ctx, config: { platform: WINDOWS, reportAtRunStart: false } });
  assert.equal(await reportFor(offByConfig, { depth: 0, run: runToken() }), undefined);

  const broken = plugin.hooks({
    config: { platform: WINDOWS },
    run: async () => {
      throw new Error("no process table");
    },
    stat: fakeStat(),
    env: TEST_ENV,
  });
  assert.equal(await reportFor(broken, { depth: 0, run: runToken() }), undefined, "a broken probe is silence, never a failed run");
});

test("the hook names a conflict instead of hiding it", async () => {
  const machine = fakeMachine({ procs: { outline: [1], express: [2] } });
  const hooks = plugin.hooks({ config: { platform: WINDOWS }, run: machine.run, stat: fakeStat(), env: TEST_ENV });
  const note = await reportFor(hooks, { depth: 0, run: runToken() });
  assert.match(note.note, /Both clients are running at once/);
});

// ------------------------------------------------------------- the seams used

test("every OS call goes through the injected runner, and nothing else is executed", async () => {
  const machine = fakeMachine({ procs: { outline: [11276], express: [] } });
  const outcome = await toggleExit({ provider: "outline", on: false, ...toggleOptions(machine, fakeStat()) });
  assert.equal(outcome.ok, true);
  const commands = new Set(machine.calls.map((entry) => entry.command));
  for (const command of commands) {
    assert.ok(
      command === "tasklist" || command === "taskkill" || command === OUTLINE_EXE || command === EXPRESS_EXE,
      `unexpected executable: ${command}`,
    );
  }
  // Every tasklist call names the exact image in a filter, or is the one full list.
  for (const line of machine.tasklists()) {
    assert.match(line, /^(tasklist \/FI IMAGENAME eq (Outline|ExpressVPN)\.exe \/FO CSV \/NH|tasklist \/FO CSV \/NH)$/);
  }
  // No /IM, no /T, no wildcard, no shell anywhere: a stop always names one pid.
  for (const call of machine.calls) {
    assert.equal(call.options?.shell, undefined);
    assert.equal(call.options?.detached === true, call.command === OUTLINE_EXE || call.command === EXPRESS_EXE);
    for (const arg of call.args) {
      assert.doesNotMatch(arg, /\/IM\b/i, "/IM would hit every process with that name, including another user's");
      assert.doesNotMatch(arg, /\/T\b/i, "/T would walk into child processes");
      assert.doesNotMatch(arg, /[*?]/, "no wildcard is ever passed");
    }
    if (call.command === "taskkill") {
      assert.deepEqual(call.args, ["/PID", String(Number(call.args[1])), "/F"]);
    }
  }
});
