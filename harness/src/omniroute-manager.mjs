/**
 * OmniRoute as Rosalena's own background process: no window, managed from Settings.
 *
 * OmniRoute used to be started three ways, and two of them gave it a console window of its
 * own in the taskbar: the Startup-folder .cmd (`start /min`) and omniroute-site.ps1
 * (`-WindowStyle Minimized`). Rosalena's own start was `detached`, so it was not Rosalena's
 * either: nothing showed whether it was up, why it stopped, or what it printed.
 *
 * Here it is a child process of the app:
 *
 *   - started hidden (`windowsHide`), its output written to <home>/logs/omniroute.log,
 *     whose tail the Settings page shows;
 *   - on Windows a child that is not detached sits in the job object libuv gives the app's
 *     children, so it ends when Rosalena ends, even when Rosalena crashes; "keep it running
 *     after Rosalena closes" starts it detached instead, still without a window;
 *   - restarted after a crash (2 s, 5 s, 15 s, 30 s), and left alone after five crashes in
 *     two minutes, with the reason in the status;
 *   - one already running outside Rosalena is reported, not touched, until the person asks
 *     for it to be run inside Rosalena; one Rosalena itself started and lost track of (the
 *     app crashed while "keep running" was on) is recognised by its saved pid and taken back.
 *
 * It finds an install in the folder saved here, in ROSALENA_OMNIROUTE_HOME, or in
 * ~/.rosalena/omniroute (where Settings installs it), and learns the folder of one that is
 * already running when it is taken over.
 */

import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OMNIROUTE_ARGS, OMNIROUTE_PORT, omnirouteEnv, omnirouteHome } from "./cloud-setup.mjs";
import { nodeTools, systemNodeVersion } from "./node-runtime.mjs";

export const omnirouteBinIn = (root) => join(root, "node_modules", "omniroute", "bin", "omniroute.mjs");
export const RESTART_BACKOFF_MS = Object.freeze([2_000, 5_000, 15_000, 30_000]);
const CRASH_WINDOW_MS = 120_000;
const MAX_CRASHES = 5;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

/** The install folder in an OmniRoute command line (launcher or server), or null. */
export function rootFromCommandLine(cmd) {
  const tail = String.raw`[\\/]node_modules[\\/]omniroute[\\/](?:bin[\\/]omniroute\.mjs|dist[\\/]server)`;
  const text = String(cmd ?? "");
  // A quoted path may hold spaces; an unquoted one ends at the space before it.
  const m = new RegExp(`(?:^|\\s)"([^"]*?)${tail}[^"]*"`, "i").exec(text) ?? new RegExp(`(?:^|\\s)([^\\s"]+?)${tail}`, "i").exec(text);
  return m ? m[1] : null;
}

/**
 * Who listens on `port`: `{ pid, cmd, parentPid, parentCmd }`, or null. Windows only; on
 * other systems an outside OmniRoute is reported as running but cannot be taken over.
 */
export function findListener(port, { platform = process.platform } = {}) {
  if (platform !== "win32") return Promise.resolve(null);
  const script =
    `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    "if (-not $c) { exit 0 }; " +
    '$p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess); ' +
    '$q = if ($p) { Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) } else { $null }; ' +
    "[pscustomobject]@{ pid = [int]$c.OwningProcess; cmd = $p.CommandLine; parentPid = $(if ($p) { [int]$p.ParentProcessId } else { 0 }); parentCmd = $(if ($q) { $q.CommandLine } else { '' }) } | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      if (err || !String(stdout).trim()) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/** End a process and everything it started. */
export function killTree(pid, { platform = process.platform } = {}) {
  if (!pid) return Promise.resolve(false);
  if (platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, (err) => resolve(!err));
    });
  }
  // The group first (a detached child leads its own), else the one process. SIGTERM gives it
  // a chance to close cleanly; whatever is still alive after 3 s gets SIGKILL, so "stopped"
  // means stopped here too, as taskkill /F does on Windows (caught on the Linux release gate:
  // the server kept answering after a lone SIGTERM).
  let target = -pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    target = pid;
    try {
      process.kill(target, "SIGTERM");
    } catch {
      return Promise.resolve(false);
    }
  }
  const alive = () => {
    try {
      process.kill(target, 0);
      return true;
    } catch {
      return false;
    }
  };
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!alive()) return resolve(true);
      if (Date.now() - started >= 3000) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          /* gone between the check and the kill */
        }
        return resolve(true);
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** The last `lines` lines of a file, read from its end. */
export function tailFile(path, lines = 120, maxBytes = 64 * 1024) {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    // eslint-disable-next-line no-control-regex
    const text = buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
    return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines);
  } catch {
    return [];
  }
}

export function createOmniRouteManager({
  home,
  defaultRoot = omnirouteHome(),
  port = OMNIROUTE_PORT,
  // The PC's node, or Rosalena's own (node-runtime.mjs) on a PC that has none. Asked when
  // OmniRoute starts, not here: the install that fetches it can finish after this exists.
  nodeBin = null,
  spawnImpl = spawn,
  findListenerImpl = findListener,
  killTreeImpl = killTree,
  fetchImpl = fetch,
  platform = process.platform,
  backoffMs = RESTART_BACKOFF_MS,
  log = () => {},
} = {}) {
  const stateFile = join(home, "omniroute.json");
  const logFile = join(home, "logs", "omniroute.log");
  let child = null;
  let startedAt = null;
  let wanted = false;
  let restartTimer = null;
  let crashes = [];
  let lastExit = null;
  let gaveUp = null;
  let starting = null;

  const read = () => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) ?? {};
    } catch {
      return {};
    }
  };
  const save = (patch) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify({ ...read(), ...patch }, null, 2)}\n`);
  };
  const prefs = () => {
    const s = read();
    return { autostart: s.autostart !== false, keepAfterQuit: s.keepAfterQuit === true };
  };

  const roots = () => [read().root, process.env.ROSALENA_OMNIROUTE_HOME, defaultRoot].filter((r) => typeof r === "string" && r.trim());
  const root = () => roots().find((r) => existsSync(omnirouteBinIn(r))) ?? null;
  const alive = () => Boolean(child && child.exitCode === null && child.signalCode === null);

  async function answering(timeoutMs = 1500) {
    try {
      await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
      return true;
    } catch {
      return false;
    }
  }

  /** The OmniRoute on the port that is not this manager's child, or null. */
  let outsideCache = { at: 0, value: null };
  async function outside({ fresh = false } = {}) {
    if (!fresh && Date.now() - outsideCache.at < 8_000) return outsideCache.value;
    outsideCache = { at: Date.now(), value: await lookOutside() };
    return outsideCache.value;
  }
  async function lookOutside() {
    const hit = await findListenerImpl(port, { platform });
    if (!hit) return null;
    const launcher = /omniroute[\\/]bin[\\/]omniroute\.mjs/i.test(hit.parentCmd ?? "") ? hit.parentPid : null;
    const savedPid = read().pid ?? null;
    const seenRoot = rootFromCommandLine(hit.cmd) ?? rootFromCommandLine(hit.parentCmd);
    // An install found running (D:\Tools\omniroute, say) is remembered, so Rosalena can start
    // that same copy itself from now on, not only the one Settings installs.
    if (seenRoot && !root() && existsSync(omnirouteBinIn(seenRoot))) save({ root: seenRoot });
    return {
      pid: hit.pid,
      launcherPid: launcher,
      root: seenRoot,
      isOmniRoute: /omniroute/i.test(`${hit.cmd} ${hit.parentCmd}`),
      // Started by Rosalena, then left behind (it crashed, or "keep running" was on).
      ours: Boolean(savedPid) && (savedPid === hit.pid || savedPid === launcher),
    };
  }

  const waitFor = async (want, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if ((await answering()) === want) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };

  function spawnChild(dir) {
    mkdirSync(join(home, "logs"), { recursive: true });
    try {
      if (existsSync(logFile) && statSync(logFile).size > LOG_ROTATE_BYTES) renameSync(logFile, `${logFile}.1`);
    } catch {
      /* a log that cannot rotate is appended to */
    }
    const keep = prefs().keepAfterQuit;
    const out = openSync(logFile, "a");
    const node = nodeBin ? null : nodeTools({ npm: systemNodeVersion });
    const proc = spawnImpl(nodeBin ?? node?.node ?? "node", [omnirouteBinIn(dir), ...OMNIROUTE_ARGS], {
      cwd: dir,
      windowsHide: true,
      // Not detached: on Windows the child then ends with Rosalena. Detached only when the
      // person asked for it to outlive the app (still no window: windowsHide, no console).
      detached: keep || platform !== "win32",
      stdio: ["ignore", out, out],
      // omnirouteEnv names the PC's Chrome or Edge for OmniRoute's keyless route; the port
      // is this manager's own (a test runs it on a free one).
      env: { ...omnirouteEnv(node ? node.env() : process.env), PORT: String(port) },
    });
    closeSync(out);
    if (keep) proc.unref?.();
    child = proc;
    startedAt = Date.now();
    save({ pid: proc.pid ?? null, root: dir });
    proc.on?.("error", (err) => log(`omniroute: could not start: ${err?.message ?? err}`));
    proc.on?.("exit", (code, signal) => {
      if (child === proc) child = null;
      lastExit = { code, signal: signal ?? null, at: Date.now() };
      if (!wanted) return;
      crashes = [...crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS), Date.now()];
      if (crashes.length >= MAX_CRASHES) {
        wanted = false;
        gaveUp = { at: Date.now(), reason: `it stopped ${crashes.length} times in two minutes (last exit code ${code}); see the log` };
        log(`omniroute: gave up restarting: ${gaveUp.reason}`);
        return;
      }
      const delay = backoffMs[Math.min(crashes.length - 1, backoffMs.length - 1)];
      log(`omniroute: exited (code ${code}); restarting in ${delay / 1000} s`);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (wanted && !alive()) spawnChild(dir);
      }, delay);
    });
    log(`omniroute: started inside Rosalena (pid ${proc.pid ?? "?"}) from ${dir}`);
    return proc;
  }

  async function startNow({ waitMs = 60_000 } = {}) {
    if (alive()) return { ok: true, already: true, pid: child.pid };
    if (await answering()) {
      const ext = await outside({ fresh: true });
      if (!ext?.ours) return { ok: false, code: "external", error: "OmniRoute is already running outside Rosalena", external: ext };
      await killTreeImpl(ext.launcherPid ?? ext.pid, { platform });
      await waitFor(false, 15_000);
    }
    const dir = root();
    if (!dir) return { ok: false, code: "not-installed", error: "OmniRoute is not installed (Settings > API keys can install it)" };
    wanted = true;
    gaveUp = null;
    crashes = [];
    spawnChild(dir);
    if (await waitFor(true, waitMs)) return { ok: true, pid: child?.pid ?? null };
    return { ok: false, code: "no-answer", error: `OmniRoute did not answer within ${Math.round(waitMs / 1000)} s; see the log`, log: tailFile(logFile, 20) };
  }

  const api = {
    logFile,
    root,
    installed: () => Boolean(root()),
    prefs,
    setPrefs({ autostart, keepAfterQuit } = {}) {
      const patch = {};
      if (typeof autostart === "boolean") patch.autostart = autostart;
      if (typeof keepAfterQuit === "boolean") patch.keepAfterQuit = keepAfterQuit;
      save(patch);
      return prefs();
    },
    /** One start at a time: a second call while starting waits for the first. */
    start(options) {
      starting ??= startNow(options).finally(() => (starting = null));
      return starting;
    },
    async stop() {
      wanted = false;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      const proc = child;
      if (!proc) return { ok: true, already: true };
      await killTreeImpl(proc.pid, { platform });
      await waitFor(false, 10_000);
      save({ pid: null });
      log("omniroute: stopped");
      return { ok: true };
    },
    async restart(options) {
      await api.stop();
      return api.start(options);
    },
    /** Stop the OmniRoute running outside Rosalena and run it here instead. */
    async adopt(options) {
      if (alive()) return { ok: true, already: true };
      const ext = (await answering()) ? await outside({ fresh: true }) : null;
      if (ext) {
        if (!ext.isOmniRoute) return { ok: false, code: "not-omniroute", error: `something else (pid ${ext.pid}) is using port ${port}` };
        if (ext.root && existsSync(omnirouteBinIn(ext.root))) save({ root: ext.root });
        await killTreeImpl(ext.launcherPid ?? ext.pid, { platform });
        if (!(await waitFor(false, 15_000))) return { ok: false, code: "still-running", error: "the outside OmniRoute did not stop" };
        log(`omniroute: took over the copy that was running outside Rosalena (pid ${ext.launcherPid ?? ext.pid})`);
      }
      return api.start(options);
    },
    /** When the app closes: stop it, unless the person asked for it to keep running. */
    async shutdown() {
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      if (!child) return;
      if (prefs().keepAfterQuit) {
        wanted = false;
        child.unref?.();
        child = null;
        return;
      }
      await api.stop();
    },
    async status() {
      const running = await answering();
      const managed = alive();
      // Looked at first: a running copy can teach where OmniRoute is installed.
      const external = running && !managed ? await outside() : null;
      return {
        running,
        managed,
        installed: Boolean(root()),
        root: root(),
        pid: managed ? child.pid : null,
        startedAt: managed ? startedAt : null,
        restarts: crashes.length,
        lastExit,
        gaveUp,
        external,
        ...prefs(),
        logFile,
      };
    },
    tail: (lines = 120) => tailFile(logFile, lines),
  };
  return api;
}
