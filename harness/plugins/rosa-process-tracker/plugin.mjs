// process-tracker - the harness can start work that outlives the call that
// started it, and then has no way to see it.
//
// A tool call runs in a shell the harness waits for, so anything that shell
// spawns and waits for is gone before the call returns. What leaks is work
// deliberately detached from it: `Start-Process`, `start`, or a server launched
// to outlive the run. Windows does not reparent those to anything the harness
// owns, so nothing in the harness can see or stop them, and they pile up.
//
// This plugin finds them, records them in a ledger, and tells the model to stop
// what it left behind. It never kills anything itself - the ledger entry and the
// note are advice, and stopping a process stays the model's (or the user's) call.
//
// Everything that decides anything is a pure function, so the judgement is
// testable without spawning a single process.

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Process names that mean "a person, a terminal, or the OS started this" - never
 * something the harness detached. If a candidate's living ancestor is one of
 * these, it belongs to the user and is not ours to report.
 */
export const BLESSED = [
  "explorer.exe",
  "services.exe",
  "wininit.exe",
  "winlogon.exe",
  "svchost.exe",
  "lsass.exe",
  "csrss.exe",
  "smss.exe",
  "sihost.exe",
  "taskhostw.exe",
  "RuntimeBroker.exe",
  "cmd.exe",
  "powershell.exe",
  "pwsh.exe",
  "conhost.exe",
  "OpenConsole.exe",
  "WindowsTerminal.exe",
  "bash.exe",
  "wsl.exe",
  "Code.exe",
  "Code - Insiders.exe",
  "brave.exe",
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "DeepSeek Harness.exe",
];

/**
 * Desktop apps that are never a harness leftover, even when a run opened one (a
 * link opened in the browser, say): telling the model to Stop-Process these
 * closes the user's music or chat. Written 2026-10-21 after a
 * DeepSeek Harness ledger had filled with 1,589 browser renderers plus
 * Spotify, Zoom, OneDrive, Outline and Acrobat's tray.
 */
export const USER_APPS = [
  "brave.exe", "chrome.exe", "msedge.exe", "msedgewebview2.exe", "firefox.exe", "opera.exe", "vivaldi.exe", "arc.exe",
  "spotify.exe", "zoom.exe", "discord.exe", "slack.exe", "teams.exe", "ms-teams.exe", "telegram.exe", "whatsapp.exe",
  "onedrive.exe", "onedrive.sync.service.exe", "dropbox.exe", "googledrivefs.exe",
  "acrotray.exe", "acrobat.exe", "acrord32.exe", "vctip.exe", "outline.exe", "obs64.exe", "obs-browser-page.exe",
  "lghub.exe", "lghub_agent.exe", "steam.exe", "steamwebhelper.exe", "searchapp.exe", "shellexperiencehost.exe",
  "rosalena-harness.exe", "contentfarm-desktop.exe", "deepseek harness.exe",
  "claude.exe", "opencode.exe", "adobecollabsync.exe",
  // Windows pseudo-processes: no parent by design, never anyone's leftover
  "system", "secure system", "registry", "memory compression", "system idle process",
];

/**
 * ContentFarm's processes and the GPU services it runs are never a harness
 * leftover: in DSH a session's agent stopped ComfyUI mid-render, twice, because
 * ComfyUI's launcher exits at once and leaves it looking orphaned. Matched on the
 * process's own command line. Extra patterns: config `excludeCommandPatterns`.
 */
export const CONTENTFARM_PATTERNS = [
  /\\ContentFarm\\/i,
  /serve-api\.ts|gpu-switch\.ps1|start-all\.ps1/i,
  /\\ComfyUI\\ComfyUI\\[^"]*python[^"]*"?\s+main\.py/i,
  /\\media-tts\\server\.py/i,
  /audio\.cpp[^"]*server|drama3\.ps1/i,
  // Git Bash utilities belong to Claude Code / a terminal, not the harness (run_command uses cmd)
  /\\Git\\(usr\\)?bin\\|git-bash/i,
];

/**
 * The suite's data directory. `ROSALENA_HOME` wins over `~/.rosalena` so the
 * launcher can keep everything inside the product folder (see HARNESS.md), which
 * is also the only place a Low-integrity process is allowed to write.
 */
export function rosalenaHome() {
  return process.env.ROSALENA_HOME || join(homedir(), ".rosalena");
}

export function ledgerPath() {
  return join(rosalenaHome(), "process-ledger.json");
}

/**
 * One PowerShell pass over the process table. `$PID` is excluded because the
 * snapshot's own shell would otherwise be a brand-new child of the harness and
 * report itself as a leftover.
 */
const PS_SNAPSHOT = [
  "Get-CimInstance Win32_Process",
  "| Where-Object { $_.ProcessId -ne $PID }",
  "| ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name;",
  "start=$(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }); cmd=$_.CommandLine } }",
  "| ConvertTo-Json -Compress -Depth 3",
].join(" ");

function run(command, args) {
  const res = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (res.error) throw new Error(`${command}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${command} exited ${res.status}: ${String(res.stderr ?? "").trim().slice(0, 200)}`);
  return String(res.stdout ?? "");
}

/**
 * A snapshot is an array of { pid, ppid, name, start, cmd }. `start` is the
 * process creation time where the platform gives one: it is what makes a
 * recycled PID impossible to mistake for the process we recorded.
 */
export function snapshot() {
  if (process.platform === "win32") {
    return parseSnapshot(run("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_SNAPSHOT]));
  }
  // Best effort elsewhere: `ps` gives no creation time, so attribution is by
  // pid alone and a recycled pid could be misread. Documented, not hidden.
  return parsePs(run("ps", ["-eo", "pid=,ppid=,comm=,args="]));
}

function runAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${command}: ${String(stderr ?? "").trim().slice(0, 200) || err.message}`));
      resolve(String(stdout ?? ""));
    });
  });
}

/**
 * The same snapshot without blocking. The PowerShell pass takes ~5 s on Windows, and the
 * hooks used to take it with spawnSync: every run waited that long before its first model
 * call, and the window's own server froze for the length of it (measured 2026-11-04).
 */
export async function snapshotAsync() {
  if (process.platform === "win32") return parseSnapshot(await runAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_SNAPSHOT]));
  return parsePs(await runAsync("ps", ["-eo", "pid=,ppid=,comm=,args="]));
}

/**
 * A baseline taken in the background may finish after the run has started something, so
 * a process created after the run began is dropped from it: otherwise the run's own
 * leftover would count as "already running" and never be reported. Without a creation
 * time (ps) it is kept, as before.
 */
export function baselineBefore(processes, startedAt) {
  return processes.filter((p) => {
    const t = Date.parse(p.start ?? "");
    return !Number.isFinite(t) || t < startedAt;
  });
}

export function parseSnapshot(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  const raw = JSON.parse(trimmed);
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows
    .map((r) => ({
      pid: Number(r?.pid),
      ppid: Number(r?.ppid ?? 0),
      name: String(r?.name ?? ""),
      start: String(r?.start ?? ""),
      cmd: String(r?.cmd ?? ""),
    }))
    .filter((p) => Number.isInteger(p.pid) && p.pid > 0);
}

export function parsePs(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], start: "", cmd: m[4] };
    })
    .filter(Boolean);
}

/**
 * The living parent of `p` in a snapshot, or null when the parent is gone. A
 * parent that started AFTER the child holds a recycled pid, so it doesn't count.
 */
export function livingParent(p, byPid) {
  const parent = byPid.get(p.ppid);
  if (!parent || parent.pid === p.pid) return null;
  const ps = Date.parse(parent.start);
  const cs = Date.parse(p.start);
  if (Number.isFinite(ps) && Number.isFinite(cs) && ps > cs) return null;
  return parent;
}

/** True for a desktop app, a ContentFarm process, or a name/pattern the config excludes. */
export function neverOurs(p, { ignoreSet = new Set(), excludePatterns = [] } = {}) {
  const name = String(p.name ?? "").toLowerCase();
  if (ignoreSet.has(name) || USER_APPS.includes(name)) return true;
  return [...CONTENTFARM_PATTERNS, ...excludePatterns].some((re) => re.test(String(p.cmd ?? "")));
}

/**
 * Processes that appeared during the window and are still running, and that
 * nothing living owns.
 *
 * Only an ORPHAN can be a leftover: a process whose parent is gone. That is what
 * a `Start-Process` / `start` child looks like once the run_command shell exits,
 * and what a server becomes when a timed-out command's shell is killed (the
 * kill reaches the shell, not its children). A process whose parent is alive
 * belongs to that parent's owner:
 *  - a browser renderer belongs to the browser, a helper to its app;
 *  - a live child of the harness itself belongs to the harness: between steps
 *    the only live children are what plugins manage (llama-server from
 *    local-model-host, MCP servers), never something the run forgot.
 * Desktop apps and ContentFarm's processes never count, orphaned or not.
 * (2026-10-21: before this, anything new whose ancestry didn't reach a blessed
 * process was reported, including live harness children and app helpers.)
 */
export function findLeftovers(before, after, { selfPid = process.pid, ignore = [], blessed = BLESSED, excludePatterns = [] } = {}) {
  const ignoreSet = new Set([...ignore, ...blessed].map((n) => String(n).toLowerCase()));
  const seen = new Set(before.map((p) => p.pid));
  const byPid = new Map(after.map((p) => [p.pid, p]));
  const out = [];

  for (const p of after) {
    if (seen.has(p.pid) || p.pid === selfPid) continue;
    if (neverOurs(p, { ignoreSet, excludePatterns })) continue;
    if (p.ppid === selfPid) continue; // a live child of the harness: plugin-managed, the harness owns it
    if (livingParent(p, byPid)) continue; // owned by its living parent
    out.push(p);
  }
  return out;
}

const keyOf = (p) => `${p.pid}:${p.start}`;

/**
 * Fold a discovery round into the ledger: refresh what is still running, mark
 * what has exited, and drop the long-ended so the file cannot grow forever.
 */
export function mergeLedger(ledger, { discovered = [], live = new Set(), runId = null, now = new Date().toISOString(), keepDays = 1, maxEntries = 200, snapshot = null, excludePatterns = [] } = {}) {
  let entries = Array.isArray(ledger?.entries) ? ledger.entries.map((e) => ({ ...e })) : [];
  // Entries recorded under older rules: drop desktop apps and ContentFarm outright,
  // and, given a snapshot, any still-running entry whose process now has a living
  // parent (it isn't an orphan, so it isn't a leftover). Entries marked keep stay.
  const byPidNow = snapshot ? new Map(snapshot.map((p) => [p.pid, p])) : null;
  entries = entries.filter((e) => {
    if (e.keep) return true;
    if (neverOurs(e, { excludePatterns })) return false;
    if (!byPidNow || e.ended) return true;
    const p = byPidNow.get(e.pid);
    return !(p && keyOf(p) === keyOf(e) && livingParent(p, byPidNow));
  });
  const byKey = new Map(entries.map((e) => [keyOf(e), e]));

  // `live` is authoritative in both directions: a process that is in the table
  // is running, whatever we concluded about it before. A pid we stopped watching
  // and then saw again is running again.
  for (const e of entries) {
    const alive = live.has(keyOf(e));
    if (!alive && !e.ended) {
      e.ended = true;
      e.endedAt = now;
    } else if (alive && e.ended) {
      e.ended = false;
      e.endedAt = null;
      e.lastSeen = now;
    }
  }
  for (const d of discovered) {
    const k = keyOf(d);
    const prior = byKey.get(k);
    if (prior) {
      prior.lastSeen = now;
      prior.ended = false;
      prior.endedAt = null;
      if (!prior.runId) prior.runId = runId;
      continue;
    }
    const entry = {
      pid: d.pid,
      name: d.name,
      start: d.start,
      cmd: String(d.cmd ?? "").slice(0, 240),
      runId,
      firstSeen: now,
      lastSeen: now,
      keep: false,
      ended: !live.has(k),
      endedAt: null,
    };
    entries.push(entry);
    byKey.set(k, entry);
  }

  const cutoff = Date.parse(now) - keepDays * 86_400_000;
  const kept = entries.filter((e) => !(e.ended && e.endedAt && Date.parse(e.endedAt) < cutoff));
  kept.sort((a, b) => (a.ended === b.ended ? b.pid - a.pid : a.ended ? 1 : -1));
  return { version: 1, entries: kept.slice(0, maxEntries) };
}

export function describeLeftovers(list) {
  return list.map((p) => `  ${String(p.pid).padEnd(7)} ${p.name}  ${String(p.cmd ?? "").slice(0, 110)}`).join("\n");
}

function readLedger(file) {
  if (!existsSync(file)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeLedger(file, ledger) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export default {
  id: "rosa-process-tracker",
  description: "Finds work a run left running outside the harness, ledgers it, and tells the model to stop it",

  tools(ctx) {
    return [
      {
        name: "leftover_processes",
        description:
          "List processes an earlier harness run left running outside the harness's own control (detached servers, " +
          "watchers, Start-Process children), with the PID to stop. Read-only: it reports, it never stops anything.",
        parameters: { type: "object", properties: {} },
        run: async () => {
          const file = ctx.config.ledgerFile ?? ledgerPath();
          const ledger = readLedger(file);
          const running = ledger.entries.filter((e) => !e.ended && !e.keep);
          if (!running.length) return "no leftover processes are recorded as running";
          return `leftover processes still recorded as running (${running.length}):\n${describeLeftovers(running)}\nstop the ones this task no longer needs with Stop-Process -Id <PID>.`;
        },
      },
    ];
  },

  commands(ctx) {
    const file = () => ctx.config.ledgerFile ?? ledgerPath();
    return {
      leftovers: async () => {
        const ledger = readLedger(file());
        if (!ledger.entries.length) return "the ledger is empty";
        const lines = ledger.entries.map(
          (e) => `  ${String(e.pid).padEnd(7)} ${e.ended ? "ended " : "RUNNING"} ${e.name}  ${String(e.cmd ?? "").slice(0, 90)}`,
        );
        return `${file()}\n${lines.join("\n")}`;
      },
      scan: async () => {
        const now = snapshot();
        const live = new Set(now.map(keyOf));
        const suspects = now.filter((p) => p.ppid === process.pid);
        return [
          `${now.length} processes visible, ${live.size} of them distinct by pid+start time`,
          suspects.length ? `direct children of the harness right now:\n${describeLeftovers(suspects)}` : "no direct children of the harness",
        ].join("\n");
      },
      keep: async (argv) => {
        const pid = Number(argv?.[0]);
        if (!Number.isInteger(pid)) return "usage: /process-tracker keep <pid>";
        const ledger = readLedger(file());
        const entry = ledger.entries.find((e) => e.pid === pid);
        if (!entry) return `pid ${pid} is not in the ledger - nothing to keep`;
        entry.keep = true;
        writeLedger(file(), ledger);
        return `pid ${pid} (${entry.name}) is now marked as running on purpose; it will not be reported again`;
      },
    };
  },

  hooks(ctx) {
    const file = ctx.config.ledgerFile ?? ledgerPath();
    const sweepEveryMs = Number(ctx.config.sweepEveryMs) || 60_000;
    const ignore = Array.isArray(ctx.config.ignore) ? ctx.config.ignore : [];
    const excludePatterns = (Array.isArray(ctx.config.excludeCommandPatterns) ? ctx.config.excludeCommandPatterns : [])
      .map((s) => {
        try { return new RegExp(s, "i"); } catch { return null; }
      })
      .filter(Boolean);
    let broken = false;

    const sweep = async (run, base) => {
      const after = await snapshotAsync();
      const found = findLeftovers(base, after, { selfPid: process.pid, ignore, excludePatterns });
      const live = new Set(after.map(keyOf));
      const ledger = mergeLedger(readLedger(file), {
        discovered: found,
        live,
        runId: run.id,
        keepDays: Number(ctx.config.keepDays) || 1,
        maxEntries: Number(ctx.config.maxEntries) || 200,
        snapshot: after,
        excludePatterns,
      });
      writeLedger(file, ledger);
      return found;
    };

    return {
      // Only the outermost run takes snapshots. A subagent's leftovers happen
      // inside the parent's window, so the parent's sweep credits them to the
      // parent - which is also who has to answer for them.
      // The baseline is taken in the background: the run starts at once instead of waiting
      // ~5 s for PowerShell, and `base` holds the promise until the first sweep needs it.
      async onRunStart({ run, depth }) {
        if (depth !== 0 || broken) return;
        const startedAt = Date.now();
        const base = snapshotAsync().then(
          (all) => baselineBefore(all, startedAt),
          (err) => {
            broken = true;
            ctx.log(`cannot read the process table, so this plugin is off for this session: ${err?.message ?? err}`);
            return null;
          },
        );
        run.state.set("base", base);
        run.state.set("sweptAt", startedAt);
        run.state.set("reported", new Set());
      },

      async beforeStep({ run, depth, step }) {
        if (depth !== 0 || broken || step < 2) return;
        if (Date.now() - (run.state.get("sweptAt") ?? 0) < sweepEveryMs) return;
        const base = await run.state.get("base");
        if (!base) return;
        run.state.set("sweptAt", Date.now());

        let found;
        try {
          found = await sweep(run, base);
        } catch (err) {
          broken = true;
          ctx.log(`sweep failed, plugin off for this session: ${err?.message ?? err}`);
          return;
        }
        const reported = run.state.get("reported");
        const fresh = found.filter((p) => !reported.has(keyOf(p)));
        if (!fresh.length) return;
        for (const p of fresh) reported.add(keyOf(p));
        ctx.log(`left running: ${fresh.length} process(es) this run detached\n${describeLeftovers(fresh)}`);
        return {
          note:
            `This run has started ${fresh.length} process(es) that are still running outside the harness and that the ` +
            `harness cannot stop for you:\n${describeLeftovers(fresh)}\n` +
            "If the task no longer needs them, stop them now with run_command: Stop-Process -Id <PID>. " +
            "If they are meant to keep running, say so in your final answer and why.",
        };
      },

      // The final sweep only writes the ledger and the log - nothing goes back to the model -
      // so it runs after the run has ended instead of holding the end (and the next queued
      // message) for another ~5 s PowerShell pass.
      async onRunEnd({ run, depth, stopped }) {
        if (depth !== 0 || broken) return;
        const pending = run.state.get("base");
        if (!pending) return;
        void (async () => {
          const base = await pending;
          if (!base) return;
          const found = await sweep(run, base);
          const still = found.filter((p) => !p.keep);
          if (still.length) {
            ctx.log(
              `this run left ${still.length} process(es) running outside the harness (${stopped ?? "finished"}); ` +
                `ledger: ${file}\n${describeLeftovers(still)}`,
            );
          }
        })().catch((err) => ctx.log(`final sweep failed: ${err?.message ?? err}`));
      },
    };
  },

  status(ctx) {
    const file = ctx.config.ledgerFile ?? ledgerPath();
    const ledger = readLedger(file);
    const running = ledger.entries.filter((e) => !e.ended).length;
    return running ? `${running} leftover(s) recorded as running` : "no leftovers recorded";
  },
};
