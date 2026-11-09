// vpn-exit-rotator - Outline and ExpressVPN, on or off, at most one at a time.
//
// The problem this solves: a machine with two VPN clients installed. Turning one on
// while the other is up leaves two clients fighting over the default route, which
// is a broken network rather than a feature. So the rule here is exclusivity:
// turning one on turns the other off first, and every action is verified against
// the process table instead of being assumed from an exit code.
//
// What this plugin actually touches, in full:
//
//   tasklist /FI "IMAGENAME eq <image>" /FO CSV /NH   is it running, and which pids
//   tasklist /FO CSV /NH                              doctor only: one full list
//   <exe path>            (detached spawn)            the client, started by path
//   taskkill /PID <pid> /F                            one process, named by pid
//
// and nothing else. No service is started, stopped or queried; no registry key is
// read or written; no credential, access key, server address or profile is touched.
// Outline is a client for a server the person configured themselves, and this
// plugin does not configure it, sign in to it, or pick a location for either vendor.
//
// The five decisions worth keeping:
//
// 1. **Detached, not a child.** `on` spawns the executable with `detached: true`
//    and `stdio: "ignore"` and unrefs it, so the harness is not its parent and
//    closing the harness does not close the VPN. The claim is verified by the pid
//    tasklist reports afterwards, never by the spawn call returning.
// 2. **The exact image, by pid.** `off` names each process by pid from a fresh
//    tasklist read: no `/IM`, no wildcard, no tree walk. Outline is an Electron
//    app, so `Outline.exe` is routinely five processes; they all carry that exact
//    image name, and stopping one pid alone would leave a half-dead app. A
//    different image that merely begins with the same letters
//    (`ExpressVPNNotificationService.exe`) is never matched.
// 3. **A client is not a tunnel.** Outline keeps `OutlineService.exe` running and
//    ExpressVPN keeps its own services; stopping those needs elevation and is a
//    machine-wide change nobody asked this plugin for. So `off` closes the client
//    and says so, and never claims the tunnel went down.
// 4. **"Exited 0" is not a state.** After a start the image is polled in tasklist
//    (4 tries, 700 ms apart) and `ok: true` only once the process is actually
//    there. A client that dies on a missing dependency looks like success to the
//    launcher and is reported here as not running.
// 5. **One seam.** `run(command, args, options)` is the only thing that starts,
//    stops or lists a process; `stat(path)` is the only thing that touches the
//    filesystem. Both are injected (and both have a default), so the tests drive
//    every case - installed, missing, running, stopped, refusing, throwing -
//    without executing anything on the machine that runs them.
//
// What this cannot do, stated here rather than discovered later:
//   - it is Windows only (tasklist, taskkill, and a detached Windows spawn);
//   - it does not sign in or choose a server, so `on` gets a client window, not a
//     connected tunnel;
//   - it cannot know before acting whether the harness may stop a process owned by
//     another account; taskkill's "Access is denied" is reported when it happens
//     and is never dressed up as a stop;
//   - if a start fails after the other exit was stopped, no exit is active and the
//     plugin says exactly that - it does not silently restart the previous one;
//   - every installed/running fact comes from a file check or from tasklist. When a
//     check cannot be made the answer is "unknown", never "off".

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// A tasklist read is tens of milliseconds; a client start is the slow part and is
// polled separately. Eight seconds is "wedged", not "slow".
const DEFAULT_TIMEOUT_MS = 8_000;

// After a detached spawn: a WPF/Electron client takes a second or two to appear in
// the process table. 4 samples 700 ms apart is ~2.8 s worst case - long enough for
// the window to exist, short enough that a person is not left staring at a button.
const START_ATTEMPTS = 4;
const START_INTERVAL_MS = 700;

// taskkill /F is immediate; three samples 300 ms apart only catch a table that
// updates late.
const STOP_ATTEMPTS = 3;
const STOP_INTERVAL_MS = 300;

const DEFAULT_ROTATE = "outline";

const reason = (err) => (err instanceof Error ? err.message : String(err));

/** Length of a directory or file name, for a sentence a person reads. */
export function formatBytes(size) {
  const value = Number(size);
  if (size === null || size === undefined || !Number.isFinite(value)) return "size not reported";
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

/** tasklist writes some failures to stdout and some to stderr; take whichever spoke. */
function textOf(result) {
  const out = typeof result?.stdout === "string" ? result.stdout : "";
  if (out.trim()) return out;
  return typeof result?.stderr === "string" ? result.stderr : "";
}

/** The one line worth putting in a message, because a stack trace belongs in a log. */
function firstLine(text) {
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[=\-]{4,}$/.test(line)) continue;
    return line.length > 220 ? `${line.slice(0, 220)}...` : line;
  }
  return "";
}

/** Windows paths are built by hand, so they read the same on any host a test runs on. */
const winPath = (...parts) => parts.join("\\");

// "1 process" / "5 processes": the plural is written here rather than derived from
// the singular, because "process" + "s" is not a word.
const countText = (n, word, plural = null) => {
  if (n === 1) return `1 ${word}`;
  const many = plural ?? (/s$/i.test(word) ? `${word}es` : `${word}s`);
  return `${n} ${many}`;
};
const pidsText = (pids) => (pids.length === 1 ? `pid ${pids[0]}` : `pids ${pids.join(", ")}`);

/** Case-insensitive exact comparison, because Windows image names are case-insensitive. */
const sameImage = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

function setting(config, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(config?.[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

// ------------------------------------------------------------------- providers
//
// Two clients, each with the exact executable name and the directories worth
// looking in. The first two candidates are the documented install locations; the
// per-user one is there because Outline's installer also offers a per-user install.
// If none exists the report says "not installed, looked in <every path>" - the list
// is printed rather than a guess being made.

export function providerTable({ env = process.env } = {}) {
  const pf86 = String(env["ProgramFiles(x86)"] || winPath("C:", "Program Files (x86)"));
  const pf = String(env.ProgramFiles || winPath("C:", "Program Files"));
  const local = String(env.LOCALAPPDATA || "");
  return [
    {
      id: "outline",
      label: "Outline",
      image: "Outline.exe",
      installs: [
        winPath(pf86, "Outline", "Outline.exe"),
        winPath(pf, "Outline", "Outline.exe"),
        ...(local ? [winPath(local, "Programs", "Outline", "Outline.exe")] : []),
      ],
      // Reported, never stopped. These keep working when the client window closes.
      companionImages: ["OutlineService.exe", "smartdnsblock.exe"],
      clientNote:
        "Outline keeps OutlineService.exe running separately; this plugin starts and stops the client window, and does not touch that service.",
    },
    {
      id: "express",
      label: "ExpressVPN",
      image: "ExpressVPN.exe",
      installs: [
        winPath(pf86, "ExpressVPN", "expressvpn-ui", "ExpressVPN.exe"),
        winPath(pf, "ExpressVPN", "expressvpn-ui", "ExpressVPN.exe"),
      ],
      companionImages: [
        "ExpressVPN.VpnService.exe",
        "ExpressVPN.SystemService.exe",
        "ExpressVPN.AppService.exe",
        "ExpressVPNNotificationService.exe",
      ],
      clientNote:
        "ExpressVPN.exe is the client window; ExpressVPN.VpnService.exe holds the tunnel. This plugin starts and stops the window, and does not touch the service.",
    },
  ];
}

/** The built-in table, for a caller that just wants the two ids. */
export const PROVIDERS = providerTable();

/**
 * The provider table with any configured install paths in front of the defaults.
 *
 * `config.installs` is `{ outline: "D:\somewhere\Outline.exe", express: [...] }`;
 * a configured path is tried first and is always reported in `searched`, so a
 * person who moved the install sees exactly what was looked at.
 */
export function resolveProviders({ env = process.env, config = {} } = {}) {
  const extra = config?.installs && typeof config.installs === "object" && !Array.isArray(config.installs) ? config.installs : {};
  return providerTable({ env }).map((provider) => {
    const configured = extra[provider.id];
    const list = Array.isArray(configured)
      ? configured
      : typeof configured === "string" && configured.trim()
        ? [configured.trim()]
        : [];
    const seen = new Set();
    const installs = [...list, ...provider.installs]
      .map((path) => String(path ?? "").trim())
      .filter((path) => {
        if (!path) return false;
        const key = path.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return { ...provider, installs };
  });
}

/** "outline", "Outline", "OUTLINE.EXE", "expressvpn" -> a provider, or null. */
export function providerOf(value, providers = PROVIDERS) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (!key) return null;
  return (
    providers.find(
      (provider) =>
        provider.id === key ||
        provider.label.toLowerCase() === key ||
        provider.image.toLowerCase().replace(/\.exe$/, "") === key,
    ) ?? null
  );
}

/**
 * Where one provider's client lives, as data.
 *
 * `installed` is a real file check per candidate, and `searched` is every path that
 * was checked, in order - which is the whole of "not installed, looked in ...".
 */
export function locateProvider(provider, stat = defaultStat) {
  const searched = [];
  for (const candidate of provider.installs ?? []) {
    const path = String(candidate);
    searched.push(path);
    let info;
    try {
      info = stat(path) ?? { exists: false };
    } catch {
      info = { exists: false };
    }
    if (info.exists === true) {
      return {
        installed: true,
        path,
        searched,
        size: Number.isFinite(Number(info.size)) ? Number(info.size) : null,
        mtime: info.mtime ?? null,
      };
    }
  }
  return {
    installed: false,
    // The path a reader should picture from the "not installed" sentence.
    path: provider.installs?.[0] ?? "",
    searched,
    size: null,
    mtime: null,
  };
}

// --------------------------------------------------------------------- parsing

/** `"Outline.exe","11276","Console","1","65,988 K"` -> 65988. */
function parseMemKb(text) {
  const match = /([\d.,\s]+)\s*K\b/i.exec(String(text ?? ""));
  if (!match) return null;
  const digits = match[1].replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * tasklist `/FO CSV /NH`, as rows.
 *
 * Three kinds of line in that output are not a process: the
 * `INFO: No tasks are running which match the specified criteria.` sentence a
 * filter prints when nothing matches (an authoritative "not running", not an
 * error), the header row when `/NH` was left off, and the blank tail. Only a
 * quoted CSV row with a numeric pid is a process.
 *
 * The CSV reader is written out rather than split on commas because `Image Name`
 * and `Mem Usage` are quoted and `Mem Usage` contains a thousands separator.
 */
export function parseTaskList(text) {
  const rows = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^INFO:/i.test(line)) continue;
    if (/^"Image Name"/i.test(line) || /^Image Name/i.test(line)) continue;
    if (!line.startsWith('"')) continue;

    const fields = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }
      if (ch === "," && !quoted) {
        fields.push(field);
        field = "";
        continue;
      }
      field += ch;
    }
    fields.push(field);

    if (fields.length < 2) continue;
    const pid = Number.parseInt(fields[1], 10);
    if (!Number.isInteger(pid) || pid < 0) continue;
    rows.push({
      image: String(fields[0] ?? "").trim(),
      pid,
      session: String(fields[2] ?? "").trim(),
      sessionNumber: Number.parseInt(fields[3] ?? "", 10) || 0,
      memKb: parseMemKb(fields[4]),
    });
  }
  return rows;
}

/** Every row whose image name is exactly this one, never a prefix. */
export function rowsFor(rows, image) {
  return (Array.isArray(rows) ? rows : []).filter((row) => sameImage(row?.image, image));
}

/**
 * A spawn result as a claim: did a process start, and which pid.
 *
 * `code === 0` alone is not enough - a pid has to exist - because a detached spawn
 * that failed still resolves in some wrappers.
 */
export function parseStartResult(result) {
  const code = Number(result?.code ?? -1);
  const rawPid = Number(result?.pid);
  const pid = Number.isInteger(rawPid) && rawPid > 0 ? rawPid : null;
  const text = `${textOf(result)}\n${String(result?.stderr ?? "")}`.trim();
  const ok = code === 0 && pid !== null;
  return {
    ok,
    code,
    pid,
    permission: permissionOf(text),
    message: ok ? `spawned pid ${pid}` : firstLine(text) || `the spawn failed (code ${code})`,
  };
}

/**
 * taskkill's answer, as data.
 *
 * `notFound` is not a failure of ours: a pid that vanished between the tasklist
 * read and the kill is a process that is already gone, and the verification step
 * decides the outcome. `permission` is the one failure a person has to act on.
 */
export function parseStopResult(result) {
  const code = Number(result?.code ?? -1);
  const text = textOf(result);
  const notFound = /not found|no running instance|not be found|could not find/i.test(text);
  return {
    ok: code === 0,
    code,
    notFound,
    permission: code === 5 || permissionOf(text),
    message: firstLine(text) || (code === 0 ? "taskkill reported success" : `taskkill failed (exit ${code})`),
  };
}

/** The words Windows uses when the answer is "not as this account". */
export function permissionOf(text) {
  return /access is denied|access denied|not permitted|eacces|eperm|elevation|requires elevation/i.test(String(text ?? ""));
}

// ---------------------------------------------------------------------- runner

/**
 * The real runner.
 *
 * `shell: false` throughout, so an install path can never be reinterpreted as a
 * command. Two modes, chosen by the caller:
 *
 *   - a command that exits (tasklist, taskkill): resolves on "close" with the exit
 *     code and the text, and a timeout becomes a reported failure;
 *   - `{ detached: true }` (the client itself): resolves on "spawn" with the pid,
 *     stdio ignored, unref'd - the caller is not this client's parent.
 *
 * It resolves and never rejects: a missing executable, a refused spawn and a
 * timeout are all a `{ code, ... }` the caller can report.
 */
export function defaultRun(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS, detached = false } = {}) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  if (detached) return spawnDetached(String(command), argv, timeoutMs);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(String(command), argv, { shell: false, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, pid: null, stdout: "", stderr: `${command} could not be started: ${reason(err)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({
        code: -2,
        pid: null,
        stdout,
        stderr: stderr || `${command} did not answer within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => finish({ code: -1, pid: null, stdout, stderr: String(err?.message ?? err) }));
    child.on("close", (code) => finish({ code: Number.isInteger(code) ? code : -1, pid: null, stdout, stderr }));
  });
}

/**
 * One detached start: the whole point of "closing the harness does not close the
 * VPN".
 *
 * `detached: true` gives the client its own process group, `stdio: "ignore"` means
 * no pipe survives in the harness, and `unref()` means node will not wait for it.
 * `windowsHide: false` because both clients draw a window and hiding it would make
 * "started" mean "started invisibly", which is worse than not starting it.
 */
function spawnDetached(command, argv, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, { detached: true, stdio: "ignore", shell: false, windowsHide: false });
    } catch (err) {
      resolve({ code: -1, pid: null, stdout: "", stderr: `${command} could not be started: ${reason(err)}` });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // The spawn itself is immediate; a client never exits, so waiting for "close"
    // here would hang forever. A start that has not spawned in a few seconds is a
    // failure, not a slow start.
    const timer = setTimeout(() => {
      finish({ code: -2, pid: child?.pid ?? null, stdout: "", stderr: `${command} did not spawn within ${timeoutMs}ms` });
    }, Math.max(1000, Math.min(timeoutMs, 15_000)));
    timer.unref?.();

    child.once("spawn", () => {
      try {
        child.unref();
      } catch {
        /* not fatal: the process is already its own group */
      }
      finish({ code: 0, pid: child.pid ?? null, stdout: "", stderr: "" });
    });
    child.once("error", (err) => finish({ code: -1, pid: null, stdout: "", stderr: String(err?.message ?? err) }));
  });
}

/** The real filesystem check: existence, size and mtime, and never a throw. */
export function defaultStat(path) {
  try {
    const info = statSync(String(path));
    return {
      exists: true,
      size: info.size,
      mtime: info.mtime instanceof Date ? info.mtime.toISOString() : null,
      directory: info.isDirectory(),
    };
  } catch {
    return { exists: false, size: null, mtime: null, directory: false };
  }
}

/** One tasklist call as data: the exit code, the text, and a one-line problem. */
async function tasklist(run, args, timeoutMs) {
  const label = `tasklist ${args.join(" ")}`;
  try {
    const result = await run("tasklist", args, { timeoutMs });
    const text = textOf(result);
    const code = Number(result?.code ?? -1);
    return {
      code,
      text,
      error: code === 0 ? null : `${label} failed (exit ${code})${firstLine(text) ? `: ${firstLine(text)}` : ""}`,
    };
  } catch (err) {
    // An injected runner that throws is still just a failed command, never a crash
    // in whatever asked.
    return { code: -1, text: "", error: `${label} failed: ${reason(err)}` };
  }
}

/**
 * Read the process table for both images.
 *
 * `filtered` is the cheap path the UI uses: two `tasklist` calls, one per exact
 * image name, in parallel (~190 ms on this machine against ~370 ms for the full
 * list of ~475 processes).
 *
 * `full` is one unfiltered list, used by `doctor` because it also wants the
 * companion service images - and doing that with filters would be six calls.
 */
async function readProcesses({ run, providers, mode, timeoutMs }) {
  const byProvider = new Map();
  if (mode === "full") {
    const one = await tasklist(run, ["/FO", "CSV", "/NH"], timeoutMs);
    const rows = one.code === 0 ? parseTaskList(one.text) : [];
    for (const provider of providers) {
      byProvider.set(
        provider.id,
        one.code === 0 ? { rows: rowsFor(rows, provider.image), error: null } : { rows: [], error: one.error },
      );
    }
    return { byProvider, all: one.code === 0 ? rows : null, error: one.code === 0 ? null : one.error };
  }

  await Promise.all(
    providers.map(async (provider) => {
      const out = await tasklist(run, ["/FI", `IMAGENAME eq ${provider.image}`, "/FO", "CSV", "/NH"], timeoutMs);
      byProvider.set(provider.id, out.code === 0 ? { rows: parseTaskList(out.text), error: null } : { rows: [], error: out.error });
    }),
  );
  return { byProvider, all: null, error: null };
}

/** The empty state, for a caller rendering a page when the plugin cannot run at all. */
export function emptyExitsState(note, { platform = process.platform } = {}) {
  return {
    at: Date.now(),
    platform,
    supported: platform === "win32",
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      label: provider.label,
      image: provider.image,
      installed: null,
      path: provider.installs[0] ?? "",
      searched: [...provider.installs],
      size: null,
      mtime: null,
      running: null,
      pids: [],
      how: "not checked",
      error: null,
    })),
    active: null,
    activeCount: 0,
    conflict: false,
    unknown: true,
    note: String(note ?? ""),
    errors: note ? [String(note)] : [],
    companions: [],
  };
}

// ------------------------------------------------------------------- the probe

/**
 * One read-only look at both exits, as data.
 *
 * This is what `/api/exits` answers and what both tools report, so it returns a
 * structure and never throws: a missing install, a refused tasklist and a
 * non-Windows machine are states to draw honestly, not failures. It starts and
 * stops nothing - the only calls it makes are file checks and process listings.
 */
export async function probeExits({
  run = defaultRun,
  stat = defaultStat,
  platform = process.platform,
  env = process.env,
  config = {},
  timeoutMs = setting(config, "timeoutMs", DEFAULT_TIMEOUT_MS, { min: 500, max: 120_000 }),
  mode = "filtered",
} = {}) {
  const at = Date.now();
  const providers = resolveProviders({ env, config }).map((provider) => ({
    id: provider.id,
    label: provider.label,
    image: provider.image,
    installs: provider.installs,
    companionImages: provider.companionImages ?? [],
    clientNote: provider.clientNote ?? "",
    ...locateProvider(provider, stat),
  }));

  const state = {
    at,
    platform,
    supported: platform === "win32",
    providers: [],
    active: null,
    activeCount: 0,
    conflict: false,
    unknown: false,
    note: "",
    errors: [],
    companions: [],
    how: "",
  };

  if (!state.supported) {
    state.providers = providers.map((provider) => ({
      ...provider,
      running: null,
      pids: [],
      how: "not checked",
      error: null,
    }));
    state.unknown = true;
    state.how = "nothing checked";
    state.note = `VPN exits are Windows only: this plugin lists and stops processes with tasklist and taskkill, which do not exist on ${platform}. Nothing was checked and nothing can be started from here.`;
    return state;
  }

  const read = await readProcesses({ run, providers, mode, timeoutMs });
  state.how = mode === "full" ? "tasklist, one full list" : `tasklist, ${countText(providers.length, "filtered call")}`;

  state.providers = providers.map((provider) => {
    const call = read.byProvider.get(provider.id) ?? { rows: [], error: "tasklist was not called for this provider" };
    const rows = Array.isArray(call.rows) ? call.rows : [];
    const entry = {
      ...provider,
      running: call.error ? null : rows.length > 0,
      pids: call.error ? [] : rows.map((row) => row.pid),
      how: call.error ? "unknown - tasklist failed" : "tasklist",
      error: call.error ?? null,
    };
    if (entry.running === null) state.unknown = true;
    return entry;
  });

  if (mode === "full" && Array.isArray(read.all)) {
    const companions = [];
    for (const provider of providers) {
      for (const image of provider.companionImages ?? []) {
        const rows = rowsFor(read.all, image);
        if (rows.length) companions.push({ provider: provider.id, image, pids: rows.map((row) => row.pid) });
      }
    }
    state.companions = companions;
  }

  const running = state.providers.filter((provider) => provider.running === true);
  state.activeCount = running.length;
  state.conflict = running.length > 1;
  state.active = running.length === 1 ? running[0].id : null;

  for (const provider of state.providers) {
    if (provider.error) state.errors.push(`${provider.label}: ${provider.error}`);
  }

  if (state.unknown) {
    const names = state.providers.filter((provider) => provider.running === null).map((provider) => provider.label);
    state.note = `The process list could not be read for ${names.join(" and ")}, so that state is unknown - not off. Nothing was started or stopped.`;
  } else if (state.conflict) {
    state.note = `Both ${running.map((provider) => provider.label).join(" and ")} are running. Two VPN clients share the default route, which is a broken network: turn one on to end the other first (rotate does it in that order).`;
  } else if (running.length === 1) {
    state.note = `${running[0].label} is the active exit.`;
  } else {
    state.note = "No exit is running: tasklist lists neither client. This says nothing about whether a tunnel is up - the vendors' services can outlive their clients.";
  }

  return state;
}

// ----------------------------------------------------------------- the decision

/**
 * What turning one provider on or off would do, decided purely from a probe.
 *
 * Pure on purpose: the page shows the plan before it posts, the tests pin the
 * order, and the executor in `toggleExit` only carries steps out - it never
 * decides what the steps should be. Each step is `{ kind: "stop" | "start" }`, and
 * a stop always sorts before a start, because starting the second client while the
 * first is up is the broken state this plugin exists to avoid.
 */
export function planFor(state, { provider, on } = {}) {
  const providers = Array.isArray(state?.providers) ? state.providers : [];
  const target = providers.find((entry) => entry.id === provider) ?? null;
  if (!target) {
    return {
      ok: false,
      reason: "unknown-provider",
      target: null,
      other: null,
      steps: [],
      summary: `there is no "${String(provider ?? "")}" exit here: the two providers are outline and express`,
      message: `There is no "${String(provider ?? "")}" exit here. The two providers are outline and express; nothing was done.`,
    };
  }
  const other = providers.find((entry) => entry.id !== provider) ?? null;
  const wanted = on === true;

  if (wanted) {
    // The zero-exit guard: do not stop the exit that is up for the sake of one
    // that cannot be started. This refusal happens before any stop is issued.
    if (target.installed !== true) {
      return {
        ok: false,
        reason: "not-installed",
        target,
        other,
        steps: [],
        summary: `${target.label} is not installed`,
        message: `${target.label} is not installed, looked in ${target.searched.join(", ")}. Nothing was started, and ${other?.label ?? "the other client"} was left as it was.`,
      };
    }
    if (target.running === null || other?.running === null) {
      return {
        ok: false,
        reason: "unknown",
        target,
        other,
        steps: [],
        summary: `the current state of ${(target.running === null ? target : other).label} is unknown`,
        message: `The process list could not be read for ${(target.running === null ? target : other).label}, so whether only one exit would be left up cannot be checked. Nothing was started or stopped.`,
      };
    }
    const steps = [];
    if (other?.running === true) {
      steps.push({
        kind: "stop",
        provider: other.id,
        label: other.label,
        pids: [...other.pids],
        text: `stop ${other.label} (${countText(other.pids.length, "process")}, ${pidsText(other.pids)})`,
      });
    }
    if (target.running !== true) {
      steps.push({
        kind: "start",
        provider: target.id,
        label: target.label,
        command: target.path,
        text: `start ${target.path} detached`,
      });
    }
    const noop = steps.length === 0;
    return {
      ok: true,
      reason: null,
      target,
      other,
      steps,
      noop,
      summary: noop
        ? `${target.label} is already on and ${other?.label ?? "the other client"} is off`
        : steps.map((step) => step.text).join(", then "),
      message: "",
    };
  }

  // `off` is always allowed: it is the direction that cannot leave a person
  // stranded behind a tunnel they asked to close.
  if (target.running === null) {
    return {
      ok: false,
      reason: "unknown",
      target,
      other,
      steps: [],
      summary: `${target.label}'s state is unknown`,
      message: `The process list could not be read for ${target.label}, so nothing was stopped. Its state is unknown, not off.`,
    };
  }
  const pids = target.running ? [...target.pids] : [];
  return {
    ok: true,
    reason: null,
    target,
    other,
    noop: pids.length === 0,
    steps: pids.length
      ? [
          {
            kind: "stop",
            provider: target.id,
            label: target.label,
            pids,
            text: `stop ${target.label} (${countText(pids.length, "process")}, ${pidsText(pids)})`,
          },
        ]
      : [],
    summary: pids.length ? `stop ${target.label} (${countText(pids.length, "process")}, ${pidsText(pids)})` : `${target.label} is already off`,
    message: "",
  };
}

// ------------------------------------------------------------------ the action

/** Poll tasklist until the image is present (`want: true`) or gone (`want: false`). */
async function waitForImage({ run, provider, want, attempts, intervalMs, timeoutMs }) {
  const limit = Math.max(1, Math.min(10, Number(attempts) || 1));
  const gap = Math.max(0, Number(intervalMs) || 0);
  let tries = 0;
  let rows = [];
  for (let i = 0; i < limit; i += 1) {
    if (i > 0 && gap) await sleep(gap);
    tries += 1;
    const out = await tasklist(run, ["/FI", `IMAGENAME eq ${provider.image}`, "/FO", "CSV", "/NH"], timeoutMs);
    if (out.code !== 0) return { known: false, rows: [], tries, error: out.error };
    rows = parseTaskList(out.text);
    if (want === rows.length > 0) return { known: true, rows, tries, error: null };
  }
  return { known: true, rows, tries, error: null };
}

/**
 * Turn one client on or off, and prove the end state.
 *
 * The shape is fixed on purpose: a refusal is a `{ ok: false }` with a sentence,
 * exactly like a success, because "the plugin declined and here is why" is an
 * answer and not a transport error.
 *
 * Mutual exclusion is enforced by order: stop the other client, then start this
 * one. Nothing is stopped until the target is known to be installed, and nothing
 * is started if the other client could not be stopped - two clients fighting over
 * the default route is worse than a refusal.
 */
export async function toggleExit({
  provider,
  on,
  run = defaultRun,
  stat = defaultStat,
  platform = process.platform,
  env = process.env,
  config = {},
  timeoutMs = setting(config, "timeoutMs", DEFAULT_TIMEOUT_MS, { min: 500, max: 120_000 }),
  startAttempts = setting(config, "startAttempts", START_ATTEMPTS, { min: 1, max: 10 }),
  startIntervalMs = setting(config, "startIntervalMs", START_INTERVAL_MS, { min: 0, max: 30_000 }),
  stopAttempts = setting(config, "stopAttempts", STOP_ATTEMPTS, { min: 1, max: 10 }),
  stopIntervalMs = setting(config, "stopIntervalMs", STOP_INTERVAL_MS, { min: 0, max: 30_000 }),
} = {}) {
  const at = Date.now();
  const providers = resolveProviders({ env, config });
  const target = providerOf(provider, providers);
  const want = on === true;
  const onWord = want ? "on" : "off";

  const result = (fields) => ({
    at,
    ok: Boolean(fields.ok),
    provider: target?.id ?? null,
    label: target?.label ?? String(provider ?? ""),
    image: target?.image ?? null,
    on: want,
    action: fields.action ?? "refused",
    refused: fields.refused ?? null,
    message: String(fields.message ?? ""),
    summary: String(fields.summary ?? ""),
    plan: fields.plan ?? [],
    steps: fields.steps ?? [],
    stopped: fields.stopped ?? [],
    started: fields.started ?? null,
    verified: Boolean(fields.verified),
    permission: Boolean(fields.permission),
    before: fields.before ?? null,
    after: fields.after ?? null,
  });

  if (!target) {
    return result({
      ok: false,
      refused: "unknown-provider",
      message: `There is no "${String(provider ?? "")}" exit here. The two providers are outline and express; nothing was done.`,
    });
  }

  if (typeof on !== "boolean") {
    return result({
      ok: false,
      refused: "bad-request",
      message: `"${String(on)}" is not on or off. Say on: true or on: false; nothing was done.`,
    });
  }

  // Order matters, and it is deliberate. A request that names no real provider, or no real
  // on/off word, is wrong on every machine, so it is answered as a bad request first. Only
  // then does the platform get a veto: "Windows only" must not stand in for the caller's own
  // mistake, and must never be the sentence someone gets back after asking for a provider
  // that does not exist here.
  if (platform !== "win32") {
    return result({
      ok: false,
      refused: "platform",
      message: `VPN exits are Windows only: tasklist, taskkill and a detached Windows spawn do not exist on ${platform}. Nothing was started or stopped.`,
    });
  }

  const before = await probeExits({ run, stat, platform, env, config, timeoutMs });
  const plan = planFor(before, { provider: target.id, on: want });
  const beforeState = {
    active: before.active,
    running: before.providers.map((entry) => ({ id: entry.id, running: entry.running, pids: [...entry.pids] })),
  };

  if (!plan.ok) {
    return result({
      ok: false,
      refused: plan.reason,
      action: "refused",
      summary: plan.summary,
      message: plan.message,
      plan: [],
      before: beforeState,
    });
  }

  if (plan.noop) {
    // `target` is the provider definition (paths and labels); the pids live on the
    // probe's own entry for it, which is what the plan carries.
    const current = plan.target;
    const already = want
      ? `${target.label} is already on: tasklist reports ${countText(current?.pids?.length ?? 0, "process")} (${pidsText(current?.pids ?? [])}) and ${plan.other?.label ?? "the other client"} is not running. Nothing was started, so nothing changed.`
      : `${target.label} is already off: tasklist reports no ${target.image}. Nothing was stopped.`;
    return result({
      ok: true,
      action: "none",
      verified: true,
      summary: plan.summary,
      message: already,
      plan: [plan.summary],
      before: beforeState,
      after: before,
    });
  }

  const steps = [];
  const stopped = [];
  let started = null;
  let permission = false;

  for (const step of plan.steps) {
    if (step.kind === "stop") {
      const killed = [];
      for (const pid of step.pids) {
        const command = `taskkill /PID ${pid} /F`;
        let outcome;
        try {
          outcome = parseStopResult(await run("taskkill", ["/PID", String(pid), "/F"], { timeoutMs }));
        } catch (err) {
          outcome = { ok: false, code: -1, notFound: false, permission: false, message: reason(err) };
        }
        steps.push({ command, code: outcome.code, ok: outcome.ok || outcome.notFound, detail: outcome.message, pid });
        if (outcome.permission) permission = true;
        if (outcome.ok || outcome.notFound) killed.push(pid);
      }

      const waited = await waitForImage({
        run,
        provider: { image: before.providers.find((entry) => entry.id === step.provider)?.image ?? "" },
        want: false,
        attempts: stopAttempts,
        intervalMs: stopIntervalMs,
        timeoutMs,
      });
      const left = waited.rows.map((row) => row.pid);
      if (left.length) {
        return result({
          ok: false,
          refused: permission ? "permission" : "stop-failed",
          action: "stop-failed",
          permission,
          plan: plan.steps.map((entry) => entry.text),
          steps,
          stopped,
          before: beforeState,
          message: permission
            ? `taskkill was refused when ending ${step.label} (pid ${left.join(", ")}). The harness does not have permission to stop that process - it may belong to another account or need elevation. ${step.label} is still running and nothing was started.`
            : `${step.label} could not be stopped: tasklist still reports ${pidsText(left)} after ${countText(waited.tries, "check")}. Nothing was started, so the two clients are not both being asked to run.`,
        });
      }
      stopped.push(...killed);
      steps.push({ command: `tasklist (verify ${step.label} gone)`, ok: true, detail: `no ${step.label} image after ${countText(waited.tries, "check")}`, pid: null });
    }

    if (step.kind === "start") {
      let spawnResult;
      try {
        spawnResult = await run(step.command, [], { detached: true, timeoutMs });
      } catch (err) {
        spawnResult = { code: -1, pid: null, stdout: "", stderr: reason(err) };
      }
      const launch = parseStartResult(spawnResult);
      steps.push({ command: `${step.command} (detached)`, code: launch.code, ok: launch.ok, detail: launch.message, pid: launch.pid });
      if (!launch.ok) {
        if (launch.permission) permission = true;
        return result({
          ok: false,
          refused: launch.permission ? "permission" : "start-failed",
          action: "start-failed",
          permission: launch.permission,
          plan: plan.steps.map((entry) => entry.text),
          steps,
          stopped,
          before: beforeState,
          message: `${step.label} could not be started: ${launch.message}.${permission ? " The harness does not have permission to start that executable, so nothing is running." : ""}`,
        });
      }
      started = { pid: launch.pid, path: step.command };

      const waited = await waitForImage({
        run,
        provider: { image: before.providers.find((entry) => entry.id === step.provider)?.image ?? "" },
        want: true,
        attempts: startAttempts,
        intervalMs: startIntervalMs,
        timeoutMs,
      });
      const pids = waited.rows.map((row) => row.pid);
      steps.push({
        command: `tasklist (verify ${step.label} running)`,
        ok: pids.length > 0,
        detail: pids.length ? `${countText(pids.length, "process")} (${pidsText(pids)})` : `no ${step.label} image after ${countText(waited.tries, "check")}`,
        pid: null,
      });
      if (!pids.length) {
        return result({
          ok: false,
          refused: waited.known ? "not-verified" : "unknown",
          action: "start-unverified",
          plan: plan.steps.map((entry) => entry.text),
          steps,
          started,
          stopped,
          before: beforeState,
          message: waited.known
            ? `${step.label} was launched (pid ${launch.pid}), but after ${countText(waited.tries, "check")} tasklist still reports no ${step.label}. It may have exited at once (a missing dependency, a licence dialog) or still be starting. Nothing is claimed beyond what the process table shows.`
            : `${step.label} was launched (pid ${launch.pid}), but the process table could not be read afterwards, so whether it is running is unknown. Nothing is claimed either way.`,
        });
      }
      started.pids = pids;
    }
  }

  const after = await probeExits({ run, stat, platform, env, config, timeoutMs });
  const afterEntry = after.providers.find((entry) => entry.id === target.id) ?? null;
  const verified = want ? afterEntry?.running === true : afterEntry?.running === false;
  const caveat =
    !want && config?.serviceCaveat !== false && target.clientNote ? ` ${target.clientNote}` : "";

  let message;
  if (want) {
    const otherLabel = plan.other?.label ?? "the other client";
    const stoppedPart = stopped.length
      ? ` ${otherLabel} was stopped first (${countText(stopped.length, "process")}, ${pidsText(stopped)}), so only one exit is up.`
      : ` ${otherLabel} was not running, so nothing had to be stopped first.`;
    message = verified
      ? `${target.label} is ${onWord}: it was started detached (pid ${started?.pid ?? "?"}; tasklist now reports ${countText(afterEntry.pids.length, "process")}, ${pidsText(afterEntry.pids)}), so the harness is not its parent and closing the harness does not close it.${stoppedPart}`
      : `${target.label} was started detached (pid ${started?.pid ?? "?"}), but tasklist does not report it as running now.${stoppedPart} The process table is the only thing this plugin believes, so this is not reported as on.`;
  } else {
    // The pids to report are the ones taskkill was issued for, even when one of
    // them had already vanished ("not found"): "was issued for" is what happened,
    // and the verification line is what proves the end state.
    const issued = stopped.length ? stopped : plan.steps.filter((entry) => entry.kind === "stop").flatMap((entry) => entry.pids);
    message = verified
      ? `Stopped ${target.label}: tasklist now reports no ${target.image}, after taskkill was issued for ${countText(issued.length, "process")} (${pidsText(issued)}).${caveat}`
      : `taskkill was issued for ${countText(issued.length, "process")} of ${target.label} (${pidsText(issued)}), but tasklist still reports ${pidsText(afterEntry?.pids ?? [])}. Not reported as off.`;
  }

  return result({
    ok: verified,
    action: want ? "start" : "stop",
    refused: verified ? null : "not-verified",
    permission,
    plan: plan.steps.map((entry) => entry.text),
    summary: plan.summary,
    message,
    steps,
    stopped,
    started,
    verified,
    before: beforeState,
    after,
  });
}

/**
 * Rotate: keep one exit up, and make it the other one.
 *
 * "The other one" needs a starting point. One client running decides it; nothing
 * running falls back to `config.rotateDefault` and says so; both running is the
 * broken state and the plugin refuses to guess which one the person wanted, so it
 * names the two commands that would decide it.
 */
export async function rotateExits({
  run = defaultRun,
  stat = defaultStat,
  platform = process.platform,
  env = process.env,
  config = {},
  timeoutMs = setting(config, "timeoutMs", DEFAULT_TIMEOUT_MS, { min: 500, max: 120_000 }),
  ...rest
} = {}) {
  const before = await probeExits({ run, stat, platform, env, config, timeoutMs });
  const providers = resolveProviders({ env, config });
  const fallback = providerOf(config?.rotateDefault, providers)?.id ?? DEFAULT_ROTATE;

  if (!before.supported) {
    return {
      ok: false,
      action: "refused",
      refused: "platform",
      provider: null,
      label: "",
      rotate: { from: null, to: null },
      plan: [],
      message: before.note,
      before,
      after: before,
      verified: false,
      steps: [],
      stopped: [],
      started: null,
    };
  }

  if (before.unknown) {
    return {
      ok: false,
      action: "refused",
      refused: "unknown",
      provider: null,
      label: "",
      rotate: { from: null, to: null },
      plan: [],
      message: `${before.note} Rotating needs to know which exit is up, so nothing was changed.`,
      before,
      after: before,
      verified: false,
      steps: [],
      stopped: [],
      started: null,
    };
  }

  const running = before.providers.filter((entry) => entry.running === true);
  if (running.length > 1) {
    const names = running.map((entry) => entry.label).join(" and ");
    return {
      ok: false,
      action: "refused",
      refused: "conflict",
      provider: null,
      label: "",
      rotate: { from: null, to: null },
      plan: [],
      message: `Both ${names} are running, which is the broken state this plugin exists to avoid. Rotating would have to guess which one you meant to keep, so nothing was changed: say "outline on" or "express on" and that choice ends the other client first.`,
      before,
      after: before,
      verified: false,
      steps: [],
      stopped: [],
      started: null,
    };
  }

  const current = running[0] ?? null;
  const to = current ? (current.id === "outline" ? "express" : "outline") : fallback;
  const outcome = await toggleExit({ provider: to, on: true, run, stat, platform, env, config, timeoutMs, ...rest });
  const target = providers.find((entry) => entry.id === to) ?? null;
  const lead = current
    ? `Rotating from ${current.label} to ${target?.label ?? to}: ${current.label} is stopped first, then ${target?.label ?? to} is started.`
    : `No exit is running, so rotating starts ${target?.label ?? to} (config.rotateDefault).`;

  return {
    ...outcome,
    rotate: { from: current?.id ?? null, to },
    plan: outcome.plan ?? [],
    message: `${lead} ${outcome.message}`,
  };
}

// -------------------------------------------------------------------- reports

// Wide enough for the longest label ("not the tunnel"), so a label never runs into
// its own value.
const FIELD = 15;
const row = (label, text) => `  ${String(label).padEnd(FIELD)}${text}`;

/** The status command's answer: one screen, and an honest empty state per provider. */
export function formatExitReport(state) {
  const lines = ["vpn exits on this machine - Outline and ExpressVPN, at most one at a time (Windows)"];
  if (!state?.supported) {
    lines.push(`  ${state?.note ?? "This platform is not supported."}`);
    lines.push("            Nothing was checked, and nothing can be started from here.");
    return lines.join("\n");
  }

  const providers = Array.isArray(state.providers) ? state.providers : [];
  const running = providers.filter((provider) => provider.running === true);

  if (state.unknown) {
    lines.push(row("active", "unknown - the process list could not be read, and unknown is not off"));
  } else if (state.conflict) {
    lines.push(row("active", `both (${running.map((provider) => provider.label).join(" and ")}) - a broken network, not a feature`));
  } else if (running.length === 1) {
    lines.push(row("active", running[0].label));
  } else {
    lines.push(row("active", "none - neither client is running"));
  }

  for (const provider of providers) {
    const state_ =
      provider.running === true
        ? `running - ${countText(provider.pids.length, "process")} (${pidsText(provider.pids)})`
        : provider.running === false
          ? `not running - tasklist lists no ${provider.image}`
          : "unknown - tasklist could not answer, so this is not off";
    lines.push(row(provider.label.toLowerCase(), state_));
    lines.push(
      row(
        "",
        provider.installed === true
          ? `installed at ${provider.path}${provider.size !== null ? ` (${formatBytes(provider.size)})` : ""}`
          : provider.installed === false
            ? `not installed, looked in ${provider.searched.join(", ")}`
            : `install not checked - looked in ${(provider.searched ?? []).join(", ") || "no path"}`,
      ),
    );
    if (provider.error) lines.push(row("", provider.error));
  }

  lines.push(row("how known", state.how || "tasklist (file check + process list), not a guess"));
  lines.push(row("not the tunnel", "a client is not a tunnel: the vendors' services keep a VPN alive after the window closes, and this plugin never touches a service"));
  lines.push(row("not touched", "no credentials, no access key, no server choice, no profile - Outline is a client for a server you configured"));
  if (state.note) lines.push(row("note", state.note));
  for (const error of state.errors ?? []) lines.push(row("error", error));
  return lines.join("\n");
}

/** The doctor command's answer: what was checked, what was found, what cannot be checked. */
export function formatDoctor(state, { config = {} } = {}) {
  const lines = ["exit rotator doctor - Windows only, no credentials, clients only"];
  if (!state?.supported) {
    lines.push(`  ${state?.note ?? "This platform is not supported."}`);
    return lines.join("\n");
  }

  lines.push(row("platform", state.platform));
  lines.push(row("how known", `${state.how || "tasklist"} - a running/stopped answer is only ever what the process table says`));
  for (const provider of state.providers ?? []) {
    lines.push(
      row(
        provider.id,
        provider.installed === true
          ? `${provider.path} (${formatBytes(provider.size)}${provider.mtime ? `, ${provider.mtime.slice(0, 10)}` : ""})`
          : `NOT INSTALLED - looked in ${provider.searched.join(", ")}`,
      ),
    );
    lines.push(
      row(
        "",
        provider.running === true
          ? `running now - ${countText(provider.pids.length, "process")} (${pidsText(provider.pids)})`
          : provider.running === false
            ? `not running now - no ${provider.image} in tasklist`
            : "state unknown - tasklist failed",
      ),
    );
  }

  const companions = Array.isArray(state.companions) ? state.companions : [];
  lines.push(
    row(
      "services",
      companions.length
        ? companions.map((entry) => `${entry.image} (${pidsText(entry.pids)})`).join("; ")
        : "none of the known companion images are running",
    ),
  );
  lines.push(row("", "reported, never stopped: they need elevation and are a machine-wide change"));
  lines.push(row("permission", "not testable without acting: a stop reports taskkill's \"Access is denied\", a start reports the spawn error"));
  lines.push(row("config", `rotateDefault ${String(config.rotateDefault ?? DEFAULT_ROTATE)}, allowToggle ${config.allowToggle === false ? "false (tools read-only)" : "true"}`));
  lines.push(row("verify", `start ${setting(config, "startAttempts", START_ATTEMPTS)} x ${setting(config, "startIntervalMs", START_INTERVAL_MS)}ms, stop ${setting(config, "stopAttempts", STOP_ATTEMPTS)} x ${setting(config, "stopIntervalMs", STOP_INTERVAL_MS)}ms`));
  lines.push(row("commands", "status | outline on|off | express on|off | rotate | doctor"));
  lines.push(row("tools", "vpn_exit_status | vpn_exit_toggle {provider, on}"));
  for (const error of state.errors ?? []) lines.push(row("error", error));
  return lines.join("\n");
}

// --------------------------------------------------------------------- module

/**
 * The plugin object.
 *
 * The tools are not read-only here, which is the deliberate difference from
 * `rosa-wifi-switcher`: the request was a switch an agent can throw, and turning a VPN
 * client on or off is reversible, local and verifiable. `config.allowToggle:
 * false` makes the pair read-only for a deployment that wants the status only.
 */
export default {
  id: "rosa-vpn-exit-rotator",
  description:
    "Two VPN clients, one at a time: turns the Outline or ExpressVPN client on or off, starts it detached so the harness is not its parent, and stops only that exact image.",

  commands(ctx) {
    const config = () => ctx?.config ?? {};
    // One platform seam for the whole plugin: ctx.config.platform is what a test (or a
    // support report) uses to ask "what would this do on Windows" without being on Windows,
    // and on an install it is unset, so process.platform is the truth.
    const platform = () => config().platform ?? process.platform;
    const seam = () => ({ run: ctx?.run ?? defaultRun, stat: ctx?.stat ?? defaultStat, platform: platform(), config: config(), env: ctx?.env ?? process.env });
    const probe = () => probeExits({ ...seam(), mode: "filtered" });
    const timeouts = () => ({
      timeoutMs: setting(config(), "timeoutMs", DEFAULT_TIMEOUT_MS, { min: 500, max: 120_000 }),
      startAttempts: setting(config(), "startAttempts", START_ATTEMPTS, { min: 1, max: 10 }),
      startIntervalMs: setting(config(), "startIntervalMs", START_INTERVAL_MS, { min: 0, max: 30_000 }),
      stopAttempts: setting(config(), "stopAttempts", STOP_ATTEMPTS, { min: 1, max: 10 }),
      stopIntervalMs: setting(config(), "stopIntervalMs", STOP_INTERVAL_MS, { min: 0, max: 30_000 }),
    });

    const toggle = async (provider, argv = []) => {
      const word = String(argv[0] ?? "").trim().toLowerCase();
      if (word !== "on" && word !== "off") {
        return `usage: ${provider} on|off - turns the ${provider === "outline" ? "Outline" : "ExpressVPN"} client on or off. \`rotate\` switches to the other exit, and \`status\` reports both.`;
      }
      const outcome = await toggleExit({ provider, on: word === "on", ...seam(), ...timeouts() });
      const lines = [`plan: ${outcome.plan.length ? outcome.plan.join(", then ") : "nothing to do"}`, outcome.message];
      for (const step of outcome.steps) {
        lines.push(`  ${step.ok ? "ok  " : "FAIL"} ${step.command}${step.detail ? ` - ${step.detail}` : ""}`);
      }
      const state = outcome.after ?? (await probe());
      lines.push("", formatExitReport(state));
      return lines.join("\n");
    };

    return {
      status: async () => formatExitReport(await probe()),
      outline: async (argv = []) => toggle("outline", argv),
      express: async (argv = []) => toggle("express", argv),
      rotate: async () => {
        const outcome = await rotateExits({ ...seam(), ...timeouts() });
        const lines = [`plan: ${outcome.plan.length ? outcome.plan.join(", then ") : "nothing to do"}`, outcome.message];
        for (const step of outcome.steps ?? []) {
          lines.push(`  ${step.ok ? "ok  " : "FAIL"} ${step.command}${step.detail ? ` - ${step.detail}` : ""}`);
        }
        const state = outcome.after ?? (await probe());
        lines.push("", formatExitReport(state));
        return lines.join("\n");
      },
      doctor: async () => {
        const state = await probeExits({ ...seam(), mode: "full" });
        return formatDoctor(state, { config: config() });
      },
    };
  },

  tools(ctx) {
    const config = () => ctx?.config ?? {};
    // One platform seam for the whole plugin: ctx.config.platform is what a test (or a
    // support report) uses to ask "what would this do on Windows" without being on Windows,
    // and on an install it is unset, so process.platform is the truth.
    const platform = () => config().platform ?? process.platform;
    const seam = () => ({ run: ctx?.run ?? defaultRun, stat: ctx?.stat ?? defaultStat, platform: platform(), config: config(), env: ctx?.env ?? process.env });
    const probe = () => probeExits({ ...seam(), mode: "filtered" });

    return [
      {
        name: "vpn_exit_status",
        description:
          "Which VPN exits this machine has and which one is up: for Outline and ExpressVPN, whether the client is installed (with the exact path searched), whether its process is running (from tasklist, with pids), and which of the two is the active exit. Read-only: it starts and stops nothing, and reports 'unknown' rather than 'off' when the process list cannot be read.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async run() {
          try {
            return formatExitReport(await probe());
          } catch (err) {
            return `vpn_exit_status could not read the exits: ${reason(err)}`;
          }
        },
      },
      {
        name: "vpn_exit_toggle",
        description:
          "Turn one VPN client on or off: provider is outline or express, on is true or false. The two clients are mutually exclusive - turning one on stops the other first - because two VPN clients fighting over the default route is a broken network. A start is detached, so the harness is not its parent; a stop names the exact image's pids, never a wildcard. Refuses when the client is not installed, when taskkill is denied, or when the request would leave no exit up. Always reports what actually happened, checked against tasklist.",
        parameters: {
          type: "object",
          properties: {
            provider: { type: "string", enum: ["outline", "express"], description: "Which client to change." },
            on: { type: "boolean", description: "true to start it, false to stop it." },
          },
          required: ["provider", "on"],
          additionalProperties: false,
        },
        async run(args = {}) {
          if (config().allowToggle === false) {
            return "vpn_exit_toggle is switched off in this install (plugins.vpn-exit-rotator.config.allowToggle: false), so the exits are read-only here. vpn_exit_status still answers.";
          }
          try {
            const outcome = await toggleExit({
              provider: args?.provider,
              on: args?.on,
              ...seam(),
              timeoutMs: setting(config(), "timeoutMs", DEFAULT_TIMEOUT_MS, { min: 500, max: 120_000 }),
              startAttempts: setting(config(), "startAttempts", START_ATTEMPTS, { min: 1, max: 10 }),
              startIntervalMs: setting(config(), "startIntervalMs", START_INTERVAL_MS, { min: 0, max: 30_000 }),
              stopAttempts: setting(config(), "stopAttempts", STOP_ATTEMPTS, { min: 1, max: 10 }),
              stopIntervalMs: setting(config(), "stopIntervalMs", STOP_INTERVAL_MS, { min: 0, max: 30_000 }),
            });
            const state = outcome.after ?? (await probe());
            return `${outcome.message}\n\n${formatExitReport(state)}`;
          } catch (err) {
            return `vpn_exit_toggle failed before it could change anything: ${reason(err)}`;
          }
        },
      },
    ];
  },

  /**
   * One note at the start of a run, and only when an exit is actually up: what the
   * machine's traffic leaves through changes what a model should expect (a
   * geo-restricted site, a provider that refuses this IP). It never acts, never
   * stops anything, and says nothing when no client is running - a note about
   * nothing would just be noise in every prompt.
   */
  hooks(ctx) {
    const config = () => ctx?.config ?? {};
    const stated = new Set();
    const reportNow = async ({ depth = 0, run: runToken = null } = {}) => {
        if (config().reportAtRunStart === false) return;
        if (depth !== 0) return;
        try {
          const state = await probeExits({
            run: ctx?.run ?? defaultRun,
            stat: ctx?.stat ?? defaultStat,
            platform: config().platform ?? process.platform,
            config: config(),
            env: ctx?.env ?? process.env,
            mode: "filtered",
          });
          if (!state.supported) return;
          const running = state.providers.filter((provider) => provider.running === true);
          if (!running.length) return;
          // Once per run: a run with twenty steps must not repeat the same sentence
          // twenty times.
          if (runToken?.state) {
            if (runToken.state.has("reported")) return;
            runToken.state.set("reported", true);
          } else if (stated.has(state.at)) {
            return;
          } else {
            stated.add(state.at);
          }
          const where = running
            .map((provider) => `${provider.label} (tasklist: ${countText(provider.pids.length, "process")}, ${pidsText(provider.pids)})`)
            .join(" and ");
          const conflict = state.conflict
            ? " Both clients are running at once, which is two VPN clients fighting over the default route."
            : "";
          return {
            note: `network exit: ${where} is running on this machine right now, so traffic may leave through it.${conflict} Reported from tasklist by the vpn-exit-rotator plugin; nothing was started or stopped.`,
          };
        } catch {
          // A hook that cannot read the process table says nothing at all: a run
          // must never fail because a status note could not be produced.
          return;
        }
    };
    return {
      // The probe (tasklist, ~3.4 s measured 2026-11-04) runs in the background: the run's
      // first model call no longer waits for a status note. The note joins at the first
      // step after the probe has answered. A caller with no run state still gets it inline.
      async onRunStart(args = {}) {
        const state = args.run?.state;
        if (!state || typeof state.set !== "function") return reportNow(args);
        const slot = { done: false, note: null, delivered: false };
        state.set("vpnNote", slot);
        reportNow(args)
          .then((out) => {
            slot.note = out ?? null;
          })
          .catch(() => {})
          .finally(() => {
            slot.done = true;
          });
      },
      async beforeStep({ run } = {}) {
        const slot = run?.state?.get?.("vpnNote");
        if (!slot || !slot.done || slot.delivered || !slot.note) return;
        slot.delivered = true;
        return slot.note;
      },
    };
  },

  /** Static on purpose: loading the harness must not depend on either client existing. */
  status: (ctx) => {
    const platform = ctx?.config?.platform ?? process.platform;
    if (platform !== "win32") return `vpn exits: Windows only (this is ${platform}); nothing is probed at load`;
    return "vpn exits: Outline and ExpressVPN, one at a time - /vpn-exit-rotator status, or the /exits page";
  },
};
