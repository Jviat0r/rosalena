/**
 * OmniRoute as Rosalena's own background process (src/omniroute-manager.mjs).
 *
 * A fake OmniRoute with the real one's shape - a launcher (bin/omniroute.mjs) that starts a
 * server (dist/server-ws.mjs) which answers /v1/models - so these run real processes:
 *
 *   - start runs it hidden: on Windows neither process has a window
 *   - a crash is restarted; Stop stops the whole tree; the log is kept and readable
 *   - one running outside Rosalena is reported, not touched, until "run it inside"
 *   - one Rosalena started and left behind (keep-running on, app gone) is taken back
 *   - the pieces: the install folder from a command line, the switches
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createOmniRouteManager, rootFromCommandLine } from "../src/omniroute-manager.mjs";

const windows = process.platform === "win32";

function fakeOmniRoute() {
  const root = mkdtempSync(join(tmpdir(), "fake-omniroute-"));
  mkdirSync(join(root, "node_modules", "omniroute", "bin"), { recursive: true });
  mkdirSync(join(root, "node_modules", "omniroute", "dist"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "omniroute", "bin", "omniroute.mjs"),
    `import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const server = fileURLToPath(new URL("../dist/server-ws.mjs", import.meta.url));
console.log("launcher up", process.argv.slice(2).join(" "));
const child = spawn(process.execPath, [server], { stdio: "inherit", windowsHide: true });
child.on("exit", (code) => process.exit(code ?? 1));
`,
  );
  writeFileSync(
    join(root, "node_modules", "omniroute", "dist", "server-ws.mjs"),
    `import { createServer } from "node:http";
createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"data":[]}'); })
  .listen(Number(process.env.PORT), process.env.HOSTNAME, () => console.log("fake omniroute listening on " + process.env.PORT));
`,
  );
  return root;
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const answers = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

/** Every process under `pid` (inclusive) and whether any has a window. Windows only. */
function treeWindows(pid) {
  const script =
    `$all = Get-CimInstance Win32_Process; $ids = @(${pid}); $i = 0; ` +
    "while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] -and $_.Name -eq 'node.exe' } | ForEach-Object { [int]$_.ProcessId }); $i++ }; " +
    "$ids | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { [string]$p.Id + ':' + [string]($p.MainWindowHandle -ne 0) } }";
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ pid: Number(line.split(":")[0]), window: line.split(":")[1] === "True" }));
}

async function manager(extra = {}) {
  const root = extra.root ?? fakeOmniRoute();
  const port = extra.port ?? (await freePort());
  const home = extra.home ?? mkdtempSync(join(tmpdir(), "omni-home-"));
  const m = createOmniRouteManager({ home, defaultRoot: root, port, nodeBin: process.execPath, backoffMs: [300], ...extra.options });
  after(() => m.stop());
  return { m, root, port, home };
}

test("the install folder is read from a launcher or a server command line", () => {
  assert.equal(rootFromCommandLine(`"C:\\Program Files\\nodejs\\node.exe" "D:\\Tools\\omniroute\\node_modules\\omniroute\\bin\\omniroute.mjs"`), "D:\\Tools\\omniroute");
  assert.equal(rootFromCommandLine(`node.exe --max-old-space-size=4096 D:\\Tools\\omniroute\\node_modules\\omniroute\\dist\\server-ws.mjs`), "D:\\Tools\\omniroute");
  // The real server's line: a quoted node.exe first, then an unquoted path.
  assert.equal(
    rootFromCommandLine(`"C:\\Program Files\\nodejs\\node.exe" --dns-result-order=ipv4first --max-old-space-size=4096 D:\\Tools\\omniroute\\node_modules\\omniroute\\dist\\server-ws.mjs`),
    "D:\\Tools\\omniroute",
  );
  assert.equal(rootFromCommandLine(`node "C:\\My Tools\\omni route\\node_modules\\omniroute\\bin\\omniroute.mjs"`), "C:\\My Tools\\omni route");
  assert.equal(rootFromCommandLine("node something-else.mjs"), null);
});

test("it starts hidden, comes back after a crash, logs, and Stop ends the whole tree", async () => {
  const { m, port } = await manager();
  assert.equal((await m.status()).managed, false);
  const out = await m.start({ waitMs: 20000 });
  assert.equal(out.ok, true, out.error);
  const status = await m.status();
  assert.equal(status.managed, true);
  assert.equal(status.running, true);
  assert.ok(status.pid);
  if (windows) {
    const tree = treeWindows(status.pid);
    assert.ok(tree.length >= 2, `launcher and server both run: ${JSON.stringify(tree)}`);
    assert.deepEqual(tree.filter((p) => p.window), [], "no process of OmniRoute's has a window");
  }
  assert.ok(await until(() => m.tail().some((l) => /listening/.test(l))), "its output goes to the log Settings reads");
  assert.ok(m.tail().some((l) => /launcher up .*--no-open/.test(l)), "started with --no-open: no dashboard pops up in the browser");

  // A crash (the tree killed from outside) is restarted.
  if (windows) execFileSync("taskkill", ["/PID", String(status.pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-status.pid, "SIGKILL");
  // 30 s, not the default 15: under the full suite's load the restart plus the port probe
  // took longer than 15 s once, while alone it takes about 3.
  assert.ok(await until(async () => (await m.status()).restarts === 1 && (await answers(port)), 30000), "restarted after the crash");
  assert.notEqual((await m.status()).pid, status.pid);

  await m.stop();
  assert.equal(await answers(port), false, "Stop ends the server too, not only the launcher");
  assert.equal((await m.status()).managed, false);
});

test("one running outside is left alone until it is moved inside", { skip: windows ? false : "taking over needs Windows' port lookup" }, async () => {
  const { m, root, port } = await manager();
  const outsider = spawn(process.execPath, [join(root, "node_modules", "omniroute", "bin", "omniroute.mjs")], {
    env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: "ignore",
    windowsHide: true,
  });
  after(() => {
    try {
      execFileSync("taskkill", ["/PID", String(outsider.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* already gone */
    }
  });
  assert.ok(await until(() => answers(port)));
  const refused = await m.start();
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "external");
  assert.equal(refused.external.isOmniRoute, true);
  assert.equal(refused.external.ours, false);
  assert.equal(refused.external.launcherPid, outsider.pid);
  assert.equal(await answers(port), true, "a start does not touch an outside copy");

  const moved = await m.adopt({ waitMs: 20000 });
  assert.equal(moved.ok, true, moved.error);
  const status = await m.status();
  assert.equal(status.managed, true);
  assert.notEqual(status.pid, outsider.pid);
  assert.ok(await until(() => outsider.exitCode !== null), "the outside copy was stopped");
});

test("a copy Rosalena left running is recognised and taken back", { skip: windows ? false : "needs Windows' port lookup" }, async () => {
  const first = await manager();
  first.m.setPrefs({ keepAfterQuit: true });
  assert.equal((await first.m.start({ waitMs: 20000 })).ok, true);
  const leftPid = (await first.m.status()).pid;
  await first.m.shutdown(); // the app closed with "keep running" on
  assert.equal(await answers(first.port), true, "it keeps running after the app closes");

  // The next launch: a new manager over the same home and port.
  const next = createOmniRouteManager({ home: first.home, defaultRoot: first.root, port: first.port, nodeBin: process.execPath });
  after(() => next.stop());
  const seen = await next.status();
  assert.equal(seen.managed, false);
  assert.equal(seen.external.ours, true);
  const back = await next.start({ waitMs: 20000 });
  assert.equal(back.ok, true, back.error);
  const now = await next.status();
  assert.equal(now.managed, true);
  assert.notEqual(now.pid, leftPid);
});

test("it ends with the app, even when the app is killed rather than closed", { skip: windows ? false : "the job-object guarantee is Windows'" }, async () => {
  const root = fakeOmniRoute();
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  const script = join(home, "app.mjs");
  writeFileSync(
    script,
    `import { createOmniRouteManager } from ${JSON.stringify(new URL("../src/omniroute-manager.mjs", import.meta.url).href)};
const m = createOmniRouteManager({ home: ${JSON.stringify(home)}, defaultRoot: ${JSON.stringify(root)}, port: ${port}, nodeBin: process.execPath });
const out = await m.start({ waitMs: 20000 });
console.log(JSON.stringify(out));
setInterval(() => {}, 1000);
`,
  );
  const app = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  let printed = "";
  app.stdout.on("data", (d) => (printed += d));
  assert.ok(await until(() => printed.includes('"ok":true'), 25000), `the stand-in app started OmniRoute: ${printed}`);
  assert.equal(await answers(port), true);
  app.kill(); // TerminateProcess: no shutdown code runs
  assert.ok(await until(async () => !(await answers(port)), 10000), "OmniRoute went away with the app");
});

test("the switches are saved, and nothing starts without an install", async () => {
  const home = mkdtempSync(join(tmpdir(), "omni-home-"));
  const m = createOmniRouteManager({ home, defaultRoot: join(home, "nowhere"), port: await freePort(), nodeBin: process.execPath });
  assert.deepEqual(m.prefs(), { autostart: true, keepAfterQuit: false });
  assert.deepEqual(m.setPrefs({ autostart: false }), { autostart: false, keepAfterQuit: false });
  assert.deepEqual(createOmniRouteManager({ home }).prefs(), { autostart: false, keepAfterQuit: false }, "saved in the home");
  assert.equal(m.installed(), false);
  const out = await m.start();
  assert.equal(out.code, "not-installed");
});
