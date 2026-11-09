/**
 * The OS sandbox for shell commands.
 *
 * tools.mjs runs `run_command` with the harness user's own rights; the workspace is the
 * working directory, not a boundary. This module runs a command so the operating system
 * itself refuses writes outside the folders it was given. It confines *writes*, not reads:
 * the point is that a model's command cannot change or delete things outside the
 * workspace, not that it cannot look at them.
 *
 * One backend per platform, each detected rather than assumed (sandboxSupport):
 *
 *   windows-low-integrity  The command runs in a Low-integrity process (Mandatory
 *                          Integrity Control). Windows refuses writes from Low to anything
 *                          labeled higher, and unlabeled files count as Medium, so only
 *                          folders labeled Low (prepareWritable) and a per-run temp folder
 *                          can be written. Network is NOT blocked. See sandbox/lowrun.cs.
 *   bwrap                  Linux bubblewrap: the whole filesystem read-only, writable
 *                          folders bound read-write, a private /tmp, optional no network.
 *   seatbelt               macOS sandbox-exec with a generated profile: writes denied
 *                          except the writable folders and the run's temp folder, optional
 *                          no network.
 *
 * runSandboxed returns the same { code, out, err } as tools.mjs runCommand (plus
 * `sandboxed` and `backend`), so it drops in. It never falls back to an unsandboxed run:
 * if the sandbox cannot start, the result says why with code -1.
 *
 * What prepareWritable changes on disk (Windows only), and how to undo it:
 *   It adds one ACE to the folder's SACL: the mandatory label "Low, no write up,
 *   inherited by files and folders" (SDDL S:(ML;OICI;NW;;;LW)), the same thing
 *   `icacls <dir> /setintegritylevel (OI)(CI)Low` does. Windows copies it, as an
 *   inherited label, onto everything already inside, and new files inherit it. DACLs
 *   (who may access the files) are not touched, and Medium programs - the user, the
 *   editor, the harness - are not affected at all. The folder is recorded in
 *   <ROSALENA_HOME>/sandbox/labeled.json.
 *   releaseWritable(dir) removes the label again (and the inherited copies below it), and
 *   drops it from that list; releaseAllWritable() does every recorded folder. By hand:
 *   `icacls <dir>` shows "Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)" while it is
 *   labeled; `icacls <dir> /setintegritylevel (OI)(CI)Medium` is an equivalent manual undo
 *   (an explicit Medium label behaves exactly like no label).
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER_SOURCE = join(HERE, "sandbox", "lowrun.cs");
/** lowrun's exit code for "the sandbox itself could not start", with a marker on stderr. */
const SETUP_FAILED = 125;
const SETUP_MARKER = "[rosalena-sandbox]";

/** Where the compiled helper and the list of labeled folders live. */
export const sandboxHome = () => join(process.env.ROSALENA_HOME || join(homedir(), ".rosalena"), "sandbox");

// ---------------------------------------------------------------------------------------
// Detection

/** The first `name` found in a PATH-style list, or null. `exists` is injectable for tests. */
export function findOnPath(name, pathList = process.env.PATH || "", exists = existsSync, platform = process.platform) {
  const P = platform === "win32" ? win32 : posix;
  for (const dir of String(pathList).split(P.delimiter)) {
    if (!dir) continue;
    const full = P.join(dir, name);
    if (exists(full)) return full;
  }
  return null;
}

/** The .NET Framework C# compiler that ships with every Windows 10/11, if present. */
export function findCsc({ systemRoot = process.env.SystemRoot || "C:\\Windows", exists = existsSync } = {}) {
  for (const fw of ["Framework64", "Framework"]) {
    const csc = win32.join(systemRoot, "Microsoft.NET", fw, "v4.0.30319", "csc.exe");
    if (exists(csc)) return csc;
  }
  return null;
}

let bwrapProbe = null;
/**
 * bwrap on PATH is not enough: user namespaces may be switched off (some distros, many
 * containers, Ubuntu's AppArmor restriction), and then every run would fail. So it is
 * tried once, with the same flags a real run uses.
 */
function probeBwrap(bwrap) {
  if (bwrapProbe && bwrapProbe.bwrap === bwrap) return bwrapProbe.result;
  const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--die-with-parent", "true"], { timeout: 5000, stdio: ["ignore", "ignore", "pipe"] });
  const result = r.status === 0 ? { ok: true } : { ok: false, why: String(r.stderr || r.error?.message || `exit ${r.status}`).trim() };
  bwrapProbe = { bwrap, result };
  return result;
}

/**
 * Whether commands can be sandboxed here, with which backend, and in plain words what it
 * does and does not protect. Everything it looks at is injectable so the decision is
 * testable on any OS.
 */
export function sandboxSupport({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  osRelease = release(),
  probe = probeBwrap,
} = {}) {
  if (platform === "win32") {
    const major = Number(String(osRelease).split(".")[0]);
    if (!(major >= 6)) return { available: false, backend: null, why: "Windows older than Vista has no integrity levels." };
    const cached = exists(helperPath());
    if (!cached && !findCsc({ systemRoot: env.SystemRoot, exists })) {
      return { available: false, backend: null, why: "The sandbox helper is not built and the .NET Framework compiler (csc.exe) was not found to build it." };
    }
    return {
      available: true,
      backend: "windows-low-integrity",
      why: "Commands run as a Low-integrity process: they can write only in the workspace folders labeled for it and a per-run temp folder. Reads are not restricted (beyond a few profile folders Windows itself hides from Low), and network access is NOT blocked on Windows.",
    };
  }
  if (platform === "linux") {
    const bwrap = findOnPath("bwrap", env.PATH, exists, platform);
    if (!bwrap) return { available: false, backend: null, why: "bubblewrap (bwrap) is not installed; install it (e.g. apt install bubblewrap) to sandbox commands." };
    const p = probe(bwrap);
    if (!p.ok) return { available: false, backend: null, why: `bwrap is installed but cannot create a sandbox here (user namespaces disabled?): ${p.why}` };
    return { available: true, backend: "bwrap", why: "Commands run in bubblewrap: the filesystem is read-only except the writable folders and a private /tmp; network can be cut." };
  }
  if (platform === "darwin") {
    if (!exists("/usr/bin/sandbox-exec")) return { available: false, backend: null, why: "/usr/bin/sandbox-exec was not found." };
    return { available: true, backend: "seatbelt", why: "Commands run under sandbox-exec: writes are denied except the writable folders and the run's temp folder; network can be cut." };
  }
  return { available: false, backend: null, why: `No sandbox backend for platform "${platform}".` };
}

// ---------------------------------------------------------------------------------------
// Pure builders

/**
 * One argument quoted the way the Microsoft C runtime (and so PowerShell, node, most
 * programs) splits a command line - the same rules libuv uses when node spawns a process.
 */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s === "") return '""';
  if (!/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === "\\") {
      slashes += 1;
      continue;
    }
    // Backslashes only escape when a quote follows them; then each one doubles.
    if (ch === '"') out += "\\".repeat(slashes * 2 + 1) + '"';
    else out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/**
 * The full command line the Low process is started with. cmd is invoked exactly as node's
 * `shell: true` does it (/d: no AutoRun, /s: keep the inner quotes), PowerShell as
 * tools.mjs does it. Both by absolute path, so a cmd.exe planted in the workspace is not
 * picked up by the search order.
 */
export function windowsCommandLine(command, { shell = "cmd", systemRoot = process.env.SystemRoot || "C:\\Windows" } = {}) {
  if (shell === "powershell") {
    const ps = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return [ps, "-NoProfile", "-NonInteractive", "-Command", String(command)].map(quoteWindowsArg).join(" ");
  }
  return `${quoteWindowsArg(win32.join(systemRoot, "System32", "cmd.exe"))} /d /s /c "${command}"`;
}

/**
 * The environment a sandboxed command gets. Temp goes to the run's own folder, since a Low
 * process cannot write the user's normal %TEMP%. Node is told not to resolve real paths:
 * a Low process may not even stat %USERPROFILE%\AppData\Local or \Roaming themselves
 * (their contents are readable), and node's realpath walks every parent, so any script
 * installed there - npm itself, when it was upgraded with `npm i -g npm` - fails with
 * EPERM without this. Package caches go to a shared Low folder so `npm install` works.
 */
export function sandboxEnv({ base = process.env, extra = {}, platform = process.platform, runTmp, cacheDir } = {}) {
  const env = { ...base, ...extra };
  if (platform === "win32") {
    env.TEMP = runTmp;
    env.TMP = runTmp;
    if (!/--preserve-symlinks\b/.test(env.NODE_OPTIONS || "")) {
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--preserve-symlinks --preserve-symlinks-main`;
    }
    if (cacheDir) {
      env.npm_config_cache ??= win32.join(cacheDir, "npm");
      env.PIP_CACHE_DIR ??= win32.join(cacheDir, "pip");
    }
  } else {
    env.TMPDIR = runTmp;
  }
  env.ROSALENA_SANDBOX = "1";
  return env;
}

/**
 * bubblewrap arguments. Order matters: the whole filesystem goes in read-only first, then
 * a fresh /tmp, then the writable folders are bound read-write on top (a writable folder
 * under /tmp still works, because bwrap resolves bind sources outside the sandbox).
 * --new-session stops a command from typing into the harness's terminal (TIOCSTI);
 * --die-with-parent and --unshare-pid make killing bwrap kill everything inside.
 */
export function bwrapArgs({ command, cwd, writable = [cwd], network = true }) {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const dir of unique(writable)) args.push("--bind", dir, dir);
  args.push("--unshare-pid", "--new-session", "--die-with-parent");
  if (!network) args.push("--unshare-net");
  args.push("--chdir", cwd, "--", "/bin/sh", "-c", String(command));
  return args;
}

/** A string literal for a seatbelt (SBPL) profile. */
function sbplString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The macOS seatbelt profile: everything allowed, then every write denied, then writes
 * re-allowed under the writable folders, the run's temp folder and the few device files
 * shells write to. Paths must already be real paths (/private/var, not /var): seatbelt
 * matches the resolved path.
 */
export function seatbeltProfile({ writable = [], tmpDir, network = true }) {
  const allowed = unique([...writable, ...(tmpDir ? [tmpDir] : [])]).map((d) => `  (subpath ${sbplString(d)})`);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...allowed,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
  ];
  if (!network) lines.push("(deny network*)");
  return `${lines.join("\n")}\n`;
}

/** The argv for sandbox-exec. */
export function seatbeltArgs({ command, writable, tmpDir, network = true }) {
  return ["-p", seatbeltProfile({ writable, tmpDir, network }), "/bin/sh", "-c", String(command)];
}

function unique(list) {
  return [...new Set(list.filter(Boolean).map(String))];
}

/** True when `child` is `parent` or inside it (case-insensitive on Windows). */
export function isInside(parent, child, platform = process.platform) {
  const P = platform === "win32" ? win32 : posix;
  const norm = (p) => (platform === "win32" ? P.resolve(p).toLowerCase() : P.resolve(p));
  const rel = P.relative(norm(parent), norm(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !P.isAbsolute(rel));
}

/**
 * Why a folder must never be labeled writable, or null when it may be. Labeling is
 * inherited by everything inside, so labeling a drive, the home folder or a system folder
 * would open most of the machine to every Low process. Folders *inside* the home folder
 * (a project, a temp folder) are fine; AppData's own top folders are not, since everything
 * the user's programs keep is under them.
 */
export function labelRefusal(dir, {
  home = homedir(),
  systemRoot = process.env.SystemRoot || "C:\\Windows",
  programDirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData, process.env.ProgramW6432],
  platform = "win32",
} = {}) {
  const P = platform === "win32" ? win32 : posix;
  if (!dir || !P.isAbsolute(dir)) return "not an absolute path";
  const full = P.resolve(dir);
  if (P.resolve(full, "..") === full) return "a drive or filesystem root";
  const keep = [home, P.join(home, "AppData", "Local"), P.join(home, "AppData", "Roaming"), P.join(home, "AppData", "LocalLow"), P.join(home, ".ssh")];
  const kept = keep.find((p) => isInside(full, p, platform));
  if (kept) return `contains ${kept}`;
  for (const sys of [systemRoot, ...programDirs].filter(Boolean)) {
    if (isInside(full, sys, platform) || isInside(sys, full, platform)) return `a system folder (${sys})`;
  }
  return null;
}

/** Whether an SDDL label string (from lowrun get-label) makes the folder and its contents Low. */
export function isLowForTree(sddl) {
  const ace = /\(ML;([A-Z]*);[A-Z]*;;;LW\)/.exec(String(sddl || ""));
  return !!ace && ace[1].includes("OI") && ace[1].includes("CI");
}

// ---------------------------------------------------------------------------------------
// Windows: the helper

/** The cached helper's path; its name carries a hash of the source, so an edit rebuilds it. */
export function helperPath() {
  let hash = "missing";
  try {
    hash = createHash("sha256").update(readFileSync(HELPER_SOURCE)).digest("hex").slice(0, 12);
  } catch {
    /* source missing: the path just won't exist */
  }
  return join(sandboxHome(), `lowrun-${hash}.exe`);
}

let building = null;
/**
 * Compiles sandbox/lowrun.cs once (about a second) and reuses it. Built into a temp name
 * and renamed, so two runs starting together never execute a half-written exe.
 */
export function ensureHelper() {
  const exe = helperPath();
  if (existsSync(exe)) return Promise.resolve(exe);
  if (building) return building;
  building = (async () => {
    const csc = findCsc();
    if (!csc) throw new Error("csc.exe (.NET Framework 4) not found; cannot build the sandbox helper");
    mkdirSync(dirname(exe), { recursive: true });
    const tmp = `${exe}.${process.pid}.${randomBytes(3).toString("hex")}.tmp.exe`;
    const r = await execFile(csc, ["/nologo", "/optimize+", "/target:exe", `/out:${tmp}`, HELPER_SOURCE]);
    if (r.code !== 0 || !existsSync(tmp)) throw new Error(`building the sandbox helper failed:\n${r.out}${r.err}`);
    try {
      renameSync(tmp, exe);
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!existsSync(exe)) throw e; // someone else won the race: theirs is identical
    }
    return exe;
  })().finally(() => {
    building = null;
  });
  return building;
}

function execFile(file, args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => done({ code: -1, out, err: `${err}${e.message}` }));
    child.on("close", (code) => done({ code, out, err }));
  });
}

const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");

async function helperCall(verb, path) {
  const exe = await ensureHelper();
  const r = await execFile(exe, [verb, b64(path)]);
  if (r.code !== 0) throw new Error(r.err.trim() || `lowrun ${verb} exited ${r.code}`);
  return r.out.trim();
}

// ---------------------------------------------------------------------------------------
// Windows: labeling folders writable

/** Folders (lower-cased) already confirmed Low in this process. */
const confirmedLow = new Set();

const ledgerFile = () => join(sandboxHome(), "labeled.json");

/** The folders this harness has labeled Low and not released yet. */
export function labeledDirs() {
  try {
    const list = JSON.parse(readFileSync(ledgerFile(), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveLedger(list) {
  mkdirSync(sandboxHome(), { recursive: true });
  writeFileSync(ledgerFile(), `${JSON.stringify(list, null, 2)}\n`);
}

/** The folder's current integrity label as SDDL ("" when it has none). */
export function readLabel(dir) {
  return helperCall("get-label", resolve(dir));
}

/**
 * Lets sandboxed commands write in `dir` (Windows). Idempotent: a folder that is already
 * Low for its whole tree is left alone. The first labeling of a big tree takes a while
 * (Windows rewrites each file's label: about 0.4 ms per file measured, so a 100k-file
 * node_modules is ~40 s). A folder confirmed once is remembered for the life of the
 * process, so later runs skip the check (if the label is removed behind our back, writes
 * there simply fail - the safe direction).
 * @returns {Promise<{ dir: string, changed: boolean }>}
 */
export async function prepareWritable(dir, { refusal = labelRefusal } = {}) {
  if (process.platform !== "win32") return { dir, changed: false };
  const full = resolve(dir);
  const why = refusal(full);
  if (why) throw new Error(`refusing to make ${full} sandbox-writable: ${why}`);
  const key = full.toLowerCase();
  if (confirmedLow.has(key)) return { dir: full, changed: false };
  if (!existsSync(full)) mkdirSync(full, { recursive: true });
  if (isLowForTree(await readLabel(full))) {
    confirmedLow.add(key);
    return { dir: full, changed: false };
  }
  await helperCall("set-low", full);
  confirmedLow.add(key);
  const list = labeledDirs().filter((e) => resolve(e.dir).toLowerCase() !== full.toLowerCase());
  list.push({ dir: full, at: new Date().toISOString() });
  saveLedger(list);
  return { dir: full, changed: true };
}

/**
 * Undoes prepareWritable: removes the folder's explicit label, and Windows removes the
 * inherited copies from everything inside it (including files sandboxed commands created
 * there). The folder is back to the default, which behaves as Medium.
 */
export async function releaseWritable(dir) {
  if (process.platform !== "win32") return { dir, changed: false };
  const full = resolve(dir);
  confirmedLow.delete(full.toLowerCase());
  if (existsSync(full)) await helperCall("clear-label", full);
  saveLedger(labeledDirs().filter((e) => resolve(e.dir).toLowerCase() !== full.toLowerCase()));
  return { dir: full, changed: true };
}

/** releaseWritable for every folder in the ledger; returns what was released. */
export async function releaseAllWritable() {
  const done = [];
  for (const { dir } of labeledDirs()) {
    await releaseWritable(dir);
    done.push(dir);
  }
  return done;
}

/**
 * Where per-run temp folders and the shared package cache live on Windows. LocalLow is
 * the folder Windows itself labels Low for exactly this purpose, so nothing has to be
 * relabeled for it.
 */
export const defaultWindowsStateRoot = () => join(process.env.USERPROFILE || homedir(), "AppData", "LocalLow", "Rosalena", "sandbox");

// ---------------------------------------------------------------------------------------
// Running

function failed(err, backend = null) {
  return { code: -1, out: "", err, sandboxed: false, backend };
}

/**
 * Runs `command` in the OS sandbox.
 * @param {object} o
 * @param {string} o.command     The shell command (cmd on Windows, /bin/sh elsewhere).
 * @param {string} o.cwd         Folder it runs in.
 * @param {string[]} [o.writable] Folders it may write in. Defaults to the cwd alone.
 * @param {boolean} [o.network]  false cuts network on Linux/macOS; ignored on Windows
 *                               (the result's networkBlocked says which happened).
 * @param {number} [o.timeoutMs] Kills the command and everything it started.
 * @param {object} [o.env]       Extra environment variables, on top of process.env.
 * @param {"cmd"|"powershell"} [o.shell] Windows only: which shell parses the command.
 * @param {boolean} [o.prepare]  Windows: label the writable folders if needed (default
 *                               true); false refuses to run if one is not labeled yet.
 * @param {string} [o.stateRoot] Windows: where run temp folders and the package cache go.
 * @returns {Promise<{code:number|null,out:string,err:string,sandboxed:boolean,backend:string|null,networkBlocked?:boolean}>}
 */
export async function runSandboxed({
  command,
  cwd,
  writable,
  network = true,
  timeoutMs = 120000,
  env = {},
  shell = "cmd",
  prepare = true,
  stateRoot,
} = {}) {
  const support = sandboxSupport();
  if (!support.available) return failed(`[harness: sandbox unavailable, command not run] ${support.why}`);
  const dirs = unique(writable ?? [cwd]).map((d) => resolve(d));
  try {
    if (support.backend === "windows-low-integrity") return await runWindows({ command, cwd: resolve(cwd), dirs, timeoutMs, env, shell, prepare, stateRoot });
    return await runPosix({ backend: support.backend, command, cwd: resolve(cwd), dirs, network, timeoutMs, env });
  } catch (e) {
    return failed(`[harness: sandbox failed to start, command not run] ${e.message}`, support.backend);
  }
}

/**
 * Spawns the sandbox wrapper and collects output like runCommand does. On timeout the
 * wrapper is killed; each backend makes that take the whole process tree with it (a job
 * object on Windows, --die-with-parent / a process group elsewhere).
 */
function collect(file, args, { cwd, env, timeoutMs, detached = false }) {
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, detached, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      err += `\n[harness: killed after ${timeoutMs}ms]`;
      try {
        if (detached && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill();
      } catch {
        child.kill();
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out, err });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: -1, out, err: `${err}\n${e.message}` });
    });
  });
}

async function runWindows({ command, cwd, dirs, timeoutMs, env, shell, prepare, stateRoot }) {
  const exe = await ensureHelper();
  // The helper runs at Medium; a Low command able to overwrite it would escape on the next run.
  const exposed = dirs.find((d) => isInside(d, exe));
  if (exposed) throw new Error(`the sandbox helper ${exe} is inside the writable folder ${exposed}`);
  for (const dir of dirs) {
    if (prepare) await prepareWritable(dir);
    else if (!isLowForTree(await readLabel(dir))) throw new Error(`${dir} is not prepared as sandbox-writable (call prepareWritable first)`);
  }
  const root = stateRoot ? resolve(stateRoot) : defaultWindowsStateRoot();
  mkdirSync(join(root, "runs"), { recursive: true });
  if (stateRoot) await prepareWritable(root); // the default (LocalLow) is Low already
  const runTmp = join(root, "runs", `run-${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(runTmp);
  try {
    const r = await collect(exe, ["run", b64(cwd), b64(windowsCommandLine(command, { shell }))], {
      cwd,
      env: sandboxEnv({ extra: env, platform: "win32", runTmp, cacheDir: join(root, "cache") }),
      timeoutMs,
    });
    if (r.code === SETUP_FAILED && r.err.trimStart().startsWith(SETUP_MARKER)) {
      return { code: -1, out: r.out, err: `[harness: sandbox failed to start, command not run] ${r.err.trim()}`, sandboxed: false, backend: "windows-low-integrity" };
    }
    return { ...r, sandboxed: true, backend: "windows-low-integrity", networkBlocked: false };
  } finally {
    rmSync(runTmp, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function runPosix({ backend, command, cwd, dirs, network, timeoutMs, env }) {
  // Real paths: bwrap needs existing sources and seatbelt matches resolved paths.
  const real = dirs.filter((d) => existsSync(d)).map((d) => realpathSync(d));
  const tmpBase = realpathSync(process.env.TMPDIR || "/tmp");
  const runTmp = join(tmpBase, `rosalena-sbx-${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(runTmp, { recursive: true });
  try {
    const isBwrap = backend === "bwrap";
    const file = isBwrap ? findOnPath("bwrap") : "/usr/bin/sandbox-exec";
    const args = isBwrap
      ? bwrapArgs({ command, cwd: realpathSync(cwd), writable: real, network })
      : seatbeltArgs({ command, writable: real, tmpDir: runTmp, network });
    const r = await collect(file, args, {
      cwd,
      env: sandboxEnv({ extra: env, platform: process.platform, runTmp: isBwrap ? "/tmp" : runTmp }),
      timeoutMs,
      detached: true,
    });
    return { ...r, sandboxed: true, backend, networkBlocked: !network };
  } finally {
    rmSync(runTmp, { recursive: true, force: true });
  }
}
