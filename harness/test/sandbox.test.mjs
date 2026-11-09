/**
 * The OS sandbox, checked two ways:
 *
 *   1. Live, on Windows: real commands run in a real Low-integrity process against real
 *      folders, and the test looks at the disk afterwards. A write that "fails" is only
 *      counted as failed when the file is also absent - an exit code alone could lie.
 *      Everything it touches is inside one temp folder (labels included), and the labels
 *      it adds are removed again at the end.
 *   2. Pure, everywhere: the bwrap argv, the seatbelt profile, the Windows command line,
 *      quoting, environment, label refusals and backend detection (with the filesystem
 *      injected), since the Linux and macOS backends cannot run on this machine.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The helper cache and the labeled-folder ledger go to a throwaway home, not ~/.rosalena.
const BASE = mkdtempSync(join(tmpdir(), "rosalena-sbx-test-"));
process.env.ROSALENA_HOME = join(BASE, "home");

const {
  bwrapArgs,
  findOnPath,
  isInside,
  isLowForTree,
  labeledDirs,
  labelRefusal,
  prepareWritable,
  quoteWindowsArg,
  readLabel,
  releaseAllWritable,
  releaseWritable,
  runSandboxed,
  sandboxEnv,
  sandboxSupport,
  seatbeltArgs,
  seatbeltProfile,
  windowsCommandLine,
} = await import("../src/sandbox.mjs");

const onWindows = process.platform === "win32";
const liveSkip = onWindows ? false : "live sandbox tests need Windows (the bwrap and seatbelt backends are covered by the pure tests below)";

test.after(async () => {
  if (onWindows) await releaseAllWritable().catch(() => {});
  rmSync(BASE, { recursive: true, force: true, maxRetries: 3 });
});

// ---------------------------------------------------------------------------------------
// Live (Windows)

const WRITABLE = join(BASE, "writable");
const LOCKED = join(BASE, "locked");
const STATE = join(BASE, "state");
mkdirSync(WRITABLE, { recursive: true });
mkdirSync(LOCKED, { recursive: true });
writeFileSync(join(WRITABLE, "existing.txt"), "before\n");
writeFileSync(join(LOCKED, "secret.txt"), "readable-secret\n");

const run = (command, extra = {}) => runSandboxed({ command, cwd: WRITABLE, writable: [WRITABLE], stateRoot: STATE, timeoutMs: 30000, ...extra });

test("live: sandboxSupport reports the Windows backend", { skip: liveSkip }, () => {
  const s = sandboxSupport();
  assert.equal(s.available, true, s.why);
  assert.equal(s.backend, "windows-low-integrity");
  assert.match(s.why, /network access is NOT blocked/);
});

test("live: prepareWritable labels the folder Low and records it", { skip: liveSkip }, async () => {
  const r = await prepareWritable(WRITABLE);
  assert.equal(r.changed, true);
  assert.ok(isLowForTree(await readLabel(WRITABLE)), "folder is labeled Low for its whole tree");
  assert.ok(labeledDirs().some((e) => e.dir.toLowerCase() === WRITABLE.toLowerCase()), "recorded in the ledger");
  assert.equal((await prepareWritable(WRITABLE)).changed, false, "second call is a no-op");
  assert.equal(await readLabel(LOCKED), "", "the other folder was not touched");
});

test("live: the command really runs at Low integrity", { skip: liveSkip }, async () => {
  // By full path: a Git for Windows PATH puts MSYS's whoami first, and MSYS programs
  // cannot start at Low integrity at all (see the caveats in sandbox.mjs).
  const r = await run('"%SystemRoot%\\System32\\whoami.exe" /groups');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.sandboxed, true);
  assert.equal(r.backend, "windows-low-integrity");
  assert.match(r.out, /S-1-16-4096/, "Low mandatory level SID in the token");
  assert.doesNotMatch(r.out, /S-1-16-8192/, "no Medium level");
});

test("live: a write inside the writable folder succeeds", { skip: liveSkip }, async () => {
  const r = await run("echo hello> inside.txt && echo more>> existing.txt");
  assert.equal(r.code, 0, r.err);
  assert.equal(readFileSync(join(WRITABLE, "inside.txt"), "utf8").trim(), "hello");
  assert.match(readFileSync(join(WRITABLE, "existing.txt"), "utf8"), /before\s+more/, "a file that existed before labeling is writable too");
});

test("live: a write to a folder that was not made writable is denied", { skip: liveSkip }, async () => {
  const target = join(LOCKED, "escape.txt");
  const r = await run(`echo nope> "${target}"`);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Access is denied/i);
  assert.equal(existsSync(target), false, "the file was not created");

  const del = await run(`del /q "${join(LOCKED, "secret.txt")}"`);
  assert.equal(existsSync(join(LOCKED, "secret.txt")), true, `delete outside was refused (${del.err.trim()})`);

  const ps = await run(`Set-Content -Path '${target}' -Value x`, { shell: "powershell" });
  assert.notEqual(ps.code, 0);
  assert.equal(existsSync(target), false, "PowerShell cannot write there either");
});

test("live: a file outside the writable folder can still be read", { skip: liveSkip }, async () => {
  const r = await run(`type "${join(LOCKED, "secret.txt")}"`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /readable-secret/);
});

test("live: stdout, stderr and the exit code come back", { skip: liveSkip }, async () => {
  const r = await run("echo to-out& echo to-err 1>&2& exit 3");
  assert.equal(r.code, 3);
  assert.match(r.out, /to-out/);
  assert.match(r.err, /to-err/);
  assert.equal(r.networkBlocked, false, "Windows says plainly that network is not blocked");

  const ps = await run("Write-Output ps-ok; exit 4", { shell: "powershell" });
  assert.equal(ps.code, 4, ps.err);
  assert.match(ps.out, /ps-ok/);
});

test("live: TEMP points at a per-run folder the command can write, removed afterwards", { skip: liveSkip }, async () => {
  const r = await run('echo t> "%TEMP%\\t.txt" && echo %TEMP%');
  assert.equal(r.code, 0, r.err);
  const runTmp = r.out.trim();
  assert.ok(isInside(STATE, runTmp), `${runTmp} is under the state root`);
  assert.equal(existsSync(runTmp), false, "the run's temp folder is cleaned up");
});

test("live: a timeout kills the command and everything it started", { skip: liveSkip }, async () => {
  const marker = `rosalena-sbx-marker-${process.pid}-${Date.now()}`;
  const started = Date.now();
  // cmd -> node: the node process is a grandchild, so this checks the job object, not
  // just the direct child.
  const r = await run(`node -e "setTimeout(() => {}, 60000)" ${marker}`, { timeoutMs: 1500 });
  const took = Date.now() - started;
  assert.ok(took < 15000, `returned after ${took}ms`);
  assert.match(r.err, /killed after 1500ms/);
  await new Promise((done) => setTimeout(done, 750));
  const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -eq 'node.exe' }).Count`], { encoding: "utf8" });
  assert.equal(ps.stdout.trim(), "0", "no sandboxed node process survived");
});

test("live: labeling refuses dangerous folders before touching anything", { skip: liveSkip }, async () => {
  await assert.rejects(prepareWritable(process.env.USERPROFILE), /contains/);
  await assert.rejects(prepareWritable("C:\\"), /root/);
  await assert.rejects(prepareWritable(join(process.env.SystemRoot || "C:\\Windows", "Temp")), /system folder/);
});

test("live: prepare:false refuses an unlabeled folder instead of labeling it", { skip: liveSkip }, async () => {
  const r = await runSandboxed({ command: "echo x> y.txt", cwd: LOCKED, writable: [LOCKED], stateRoot: STATE, prepare: false });
  assert.equal(r.code, -1);
  assert.equal(r.sandboxed, false);
  assert.match(r.err, /not prepared/);
  assert.equal(existsSync(join(LOCKED, "y.txt")), false);
  assert.equal(await readLabel(LOCKED), "");
});

test("live: releaseWritable undoes the label, on the folder and the files inside", { skip: liveSkip }, async () => {
  await releaseWritable(WRITABLE);
  assert.equal(isLowForTree(await readLabel(WRITABLE)), false);
  assert.doesNotMatch(await readLabel(join(WRITABLE, "inside.txt")), /LW/, "a file the sandbox created lost its inherited label");
  assert.equal(labeledDirs().some((e) => e.dir.toLowerCase() === WRITABLE.toLowerCase()), false);
  const r = await runSandboxed({ command: "echo again> again.txt", cwd: WRITABLE, writable: [WRITABLE], stateRoot: STATE, prepare: false });
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(join(WRITABLE, "again.txt")), false, "after release the folder is closed to the sandbox");
});

// ---------------------------------------------------------------------------------------
// Pure

test("quoteWindowsArg follows the C runtime rules", () => {
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg("a b"), '"a b"');
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArg("C:\\no-space\\"), "C:\\no-space\\", "backslashes alone are literal");
  assert.equal(quoteWindowsArg("C:\\my dir\\"), '"C:\\my dir\\\\"', "trailing backslashes double before the closing quote");
  assert.equal(quoteWindowsArg('a\\"b c'), '"a\\\\\\"b c"');
});

test("windowsCommandLine runs cmd like node's shell:true and PowerShell like tools.mjs", () => {
  assert.equal(windowsCommandLine("dir & exit 3", { systemRoot: "C:\\Windows" }), 'C:\\Windows\\System32\\cmd.exe /d /s /c "dir & exit 3"');
  assert.equal(
    windowsCommandLine('Write-Output "x"', { shell: "powershell", systemRoot: "C:\\Windows" }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -Command "Write-Output \\"x\\""',
  );
  assert.match(windowsCommandLine("x", { systemRoot: "C:\\Program Stuff" }), /^"C:\\Program Stuff\\System32\\cmd\.exe" /, "a path with a space is quoted");
});

test("sandboxEnv points temp at the run folder and keeps what the caller set", () => {
  const w = sandboxEnv({ base: { PATH: "p", NODE_OPTIONS: "--max-old-space-size=4096" }, extra: { npm_config_cache: "mine" }, platform: "win32", runTmp: "R", cacheDir: "C:\\c" });
  assert.equal(w.TEMP, "R");
  assert.equal(w.TMP, "R");
  assert.equal(w.PATH, "p");
  assert.equal(w.NODE_OPTIONS, "--max-old-space-size=4096 --preserve-symlinks --preserve-symlinks-main");
  assert.equal(w.npm_config_cache, "mine", "caller's cache wins");
  assert.equal(w.PIP_CACHE_DIR, "C:\\c\\pip");
  assert.equal(w.ROSALENA_SANDBOX, "1");
  const again = sandboxEnv({ base: { NODE_OPTIONS: "--preserve-symlinks" }, platform: "win32", runTmp: "R" });
  assert.equal(again.NODE_OPTIONS, "--preserve-symlinks", "not added twice");
  const p = sandboxEnv({ base: {}, platform: "linux", runTmp: "/tmp" });
  assert.equal(p.TMPDIR, "/tmp");
  assert.equal(p.TEMP, undefined);
});

test("bwrapArgs: read-only root, private /tmp, writable binds after it, optional no network", () => {
  const a = bwrapArgs({ command: "make test", cwd: "/work/app", writable: ["/work/app", "/tmp/out", "/work/app"], network: true });
  assert.deepEqual(a.slice(0, 9), ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"]);
  const binds = a.map((x, i) => (x === "--bind" ? a.slice(i, i + 3) : null)).filter(Boolean);
  assert.deepEqual(binds, [["--bind", "/work/app", "/work/app"], ["--bind", "/tmp/out", "/tmp/out"]], "each writable folder once");
  assert.ok(a.indexOf("--bind") > a.indexOf("--tmpfs"), "binds come after the tmpfs so a writable /tmp path survives");
  for (const flag of ["--die-with-parent", "--unshare-pid", "--new-session"]) assert.ok(a.includes(flag), flag);
  assert.equal(a.includes("--unshare-net"), false);
  assert.deepEqual(a.slice(-6), ["--chdir", "/work/app", "--", "/bin/sh", "-c", "make test"]);
  assert.ok(bwrapArgs({ command: "x", cwd: "/w", network: false }).includes("--unshare-net"));
  assert.deepEqual(bwrapArgs({ command: "x", cwd: "/w" }).filter((x, i, all) => all[i - 1] === "--bind"), ["/w"], "writable defaults to the cwd");
});

test("seatbeltProfile denies writes except the writable folders and temp, network optional", () => {
  const p = seatbeltProfile({ writable: ["/Users/j/app", '/Users/j/we"ird'], tmpDir: "/private/var/folders/x/T/run", network: true });
  assert.match(p, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)\n\(allow file-write\*\n/);
  assert.match(p, /\(subpath "\/Users\/j\/app"\)/);
  assert.match(p, /\(subpath "\/Users\/j\/we\\"ird"\)/, "quotes escaped");
  assert.match(p, /\(subpath "\/private\/var\/folders\/x\/T\/run"\)/);
  assert.match(p, /\(literal "\/dev\/null"\)/);
  assert.doesNotMatch(p, /network/);
  assert.match(seatbeltProfile({ writable: ["/a"], network: false }), /\(deny network\*\)\n$/);
  const args = seatbeltArgs({ command: "ls", writable: ["/a"], tmpDir: "/t", network: false });
  assert.equal(args[0], "-p");
  assert.deepEqual(args.slice(2), ["/bin/sh", "-c", "ls"]);
});

test("sandboxSupport detects instead of assuming", () => {
  const none = () => false;
  const only = (...paths) => (p) => paths.includes(p);
  assert.deepEqual(
    sandboxSupport({ platform: "linux", env: { PATH: "/usr/bin" }, exists: none }).available,
    false,
  );
  const linuxOk = sandboxSupport({ platform: "linux", env: { PATH: "/bin:/usr/bin" }, exists: only("/usr/bin/bwrap"), probe: () => ({ ok: true }) });
  assert.equal(linuxOk.backend, "bwrap");
  const noUserNs = sandboxSupport({ platform: "linux", env: { PATH: "/usr/bin" }, exists: only("/usr/bin/bwrap"), probe: () => ({ ok: false, why: "setting up uid map: Permission denied" }) });
  assert.equal(noUserNs.available, false);
  assert.match(noUserNs.why, /uid map/);
  assert.equal(sandboxSupport({ platform: "darwin", exists: only("/usr/bin/sandbox-exec") }).backend, "seatbelt");
  assert.equal(sandboxSupport({ platform: "darwin", exists: none }).available, false);
  const winNoCompiler = sandboxSupport({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: none, osRelease: "10.0.19045" });
  assert.equal(winNoCompiler.available, false);
  assert.match(winNoCompiler.why, /csc\.exe/);
  const winOk = sandboxSupport({ platform: "win32", env: { SystemRoot: "C:\\Windows" }, exists: only("C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"), osRelease: "10.0.19045" });
  assert.equal(winOk.backend, "windows-low-integrity");
  assert.deepEqual(sandboxSupport({ platform: "freebsd" }), { available: false, backend: null, why: 'No sandbox backend for platform "freebsd".' });
});

test("findOnPath returns the first hit", () => {
  const sep = process.platform === "win32" ? ";" : ":";
  const hit = findOnPath("bwrap", ["/a", "/b", "/c"].join(sep), (p) => p.replace(/\\/g, "/") === "/b/bwrap" || p.replace(/\\/g, "/") === "/c/bwrap");
  assert.equal(hit.replace(/\\/g, "/"), "/b/bwrap");
  assert.equal(findOnPath("bwrap", "", () => true), null);
});

test("labelRefusal blocks roots, the home folder, AppData tops and system folders", () => {
  const opts = { home: "C:\\Users\\j", systemRoot: "C:\\Windows", programDirs: ["C:\\Program Files", "C:\\ProgramData"], platform: "win32" };
  assert.match(labelRefusal("C:\\", opts), /root/);
  assert.match(labelRefusal("D:\\", opts), /root/);
  assert.match(labelRefusal("C:\\Users", opts), /contains/);
  assert.match(labelRefusal("C:\\Users\\J", opts), /contains/, "case-insensitive");
  assert.match(labelRefusal("C:\\Users\\j\\AppData", opts), /contains/);
  assert.match(labelRefusal("C:\\Users\\j\\AppData\\Roaming", opts), /contains/);
  assert.match(labelRefusal("C:\\Windows\\Temp", opts), /system folder/);
  assert.match(labelRefusal("C:\\Program Files\\nodejs", opts), /system folder/);
  assert.match(labelRefusal("relative\\dir", opts), /absolute/);
  assert.equal(labelRefusal("D:\\AppDev\\project", opts), null);
  assert.equal(labelRefusal("C:\\Users\\j\\code\\app", opts), null);
  assert.equal(labelRefusal("C:\\Users\\j\\AppData\\Local\\Temp\\run-1", opts), null, "inside AppData\\Local is fine");
});

test("isLowForTree reads the SDDL label", () => {
  assert.equal(isLowForTree("S:(ML;OICI;NW;;;LW)"), true);
  assert.equal(isLowForTree("S:AI(ML;OICIID;NW;;;LW)"), true, "inherited from a Low parent counts");
  assert.equal(isLowForTree("S:AI(ML;ID;NW;;;LW)"), false, "a file-only label does not cover a tree");
  assert.equal(isLowForTree("S:(ML;OICI;NW;;;ME)"), false);
  assert.equal(isLowForTree(""), false);
  assert.equal(isLowForTree("S:AINO_ACCESS_CONTROL"), false);
});

test("isInside", () => {
  assert.equal(isInside("C:\\a", "C:\\A\\b", "win32"), true);
  assert.equal(isInside("C:\\a", "C:\\ab", "win32"), false);
  assert.equal(isInside("/a", "/a", "linux"), true);
  assert.equal(isInside("/a", "/b/a", "linux"), false);
});
