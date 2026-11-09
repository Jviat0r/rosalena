// Verifying a UI plugin before it is allowed in the app.
//
// Creator mode lets a model write a plugin, and a plugin system that installs whatever was
// written is a faster way to break things. So nothing is installed on the model's word:
// a plugin is installed only after this module has passed it, the report names exactly
// which files it passed (a fingerprint), and an install of files that changed since the
// pass is refused (creator.mjs).
//
// Two halves:
//
//   static   rules read from the files: the manifest, file types and sizes, the SDK and
//            Rosalena.ready() present, at least one Rosalena.test(), no remote URLs, no
//            eval / new Function / cookie / top-window access, every permission the code
//            uses declared in plugin.json, every /plugin-lib library declared too
//   runtime  the page loaded in a real Chromium (Electron, the same engine as the app)
//            through the same plugin-host.js the app uses, sandbox and CSP included:
//            it must call Rosalena.ready(), its own tests must all pass, and nothing may
//            be reported while it loads or tests (uncaught errors, console.error, a
//            request the CSP blocked). A screenshot is taken and a blank page fails.
//
// `verifyPlugin(folder)` runs both and returns one report. The runtime half needs
// Electron: inside the desktop app it opens a hidden window in-process; from Node (CLI,
// tests) it starts the checkout's Electron (desktop/node_modules/electron) or
// ROSALENA_ELECTRON. With neither it reports `skipped`, and a skipped runtime check is not
// a pass.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLUGIN_MIME, knownLibs, pluginFiles, publicView, readUiManifest, servePluginRequest } from "./ui-plugins.mjs";

const HOST_FILE = fileURLToPath(new URL("../ui/plugin-host.js", import.meta.url));
const RUNNER_FILE = fileURLToPath(new URL("./plugin-verify-runner.mjs", import.meta.url));

export const LIMITS = Object.freeze({ fileBytes: 15 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, files: 300 });

const TEXT_EXT = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".md", ".txt"]);
const CODE_EXT = new Set([".html", ".js", ".mjs", ".css"]);
const ALLOWED_URL_HOSTS = new Set(["www.w3.org"]);

/** Hash of every file's path and bytes: the identity of exactly what was verified. */
export function fingerprint(folder) {
  const hash = createHash("sha256");
  for (const rel of pluginFiles(folder)) {
    hash.update(rel);
    hash.update("\0");
    hash.update(createHash("sha256").update(readFileSync(join(folder, rel))).digest("hex"));
    hash.update("\n");
  }
  return hash.digest("hex");
}

/** The static half. Returns { ok, checks: [{ name, ok, detail }], warnings: [] }. */
export function staticCheck(folder, { libs = knownLibs() } = {}) {
  const checks = [];
  const warnings = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

  const { manifest, problems } = readUiManifest(folder, { libs });
  check("manifest", manifest && problems.length === 0, manifest ? problems.join("; ") : problems.join("; ") || "plugin.json has no \"ui\" block, so it is not a UI plugin");
  if (!manifest) return { ok: false, checks, warnings, manifest: null };

  const files = pluginFiles(folder);
  let total = 0;
  const badType = [];
  const tooBig = [];
  for (const rel of files) {
    const size = statSync(join(folder, rel)).size;
    total += size;
    const ext = extname(rel).toLowerCase();
    if (!PLUGIN_MIME[ext] && rel !== "plugin.json" && rel !== "plugin.mjs") badType.push(rel);
    if (size > LIMITS.fileBytes) tooBig.push(`${rel} (${(size / 1048576).toFixed(1)} MB)`);
  }
  check("file types", badType.length === 0, badType.length ? `not allowed in a plugin: ${badType.join(", ")}` : `${files.length} files`);
  check(
    "size",
    tooBig.length === 0 && total <= LIMITS.totalBytes && files.length <= LIMITS.files,
    tooBig.length
      ? `over ${LIMITS.fileBytes / 1048576} MB: ${tooBig.join(", ")}`
      : total > LIMITS.totalBytes
        ? `${(total / 1048576).toFixed(1)} MB in all, the limit is ${LIMITS.totalBytes / 1048576} MB`
        : files.length > LIMITS.files
          ? `${files.length} files, the limit is ${LIMITS.files}`
          : `${(total / 1024).toFixed(0)} KB`,
  );

  const texts = files
    .filter((rel) => TEXT_EXT.has(extname(rel).toLowerCase()) && rel !== "plugin.json")
    .map((rel) => ({ rel, ext: extname(rel).toLowerCase(), body: readFileSync(join(folder, rel), "utf8") }));
  const code = texts.filter((t) => CODE_EXT.has(t.ext));
  const allCode = code.map((t) => t.body).join("\n");

  // The sidebar shows the icon as an image (a CSS mask), and an SVG without its namespace
  // renders inline but not as an image: it would silently show nothing.
  const icon = manifest.icon ? texts.find((t) => t.rel === manifest.icon) : null;
  if (icon) {
    const named = /<svg\b[^>]*\bxmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(icon.body);
    check("icon renders", named, named ? "" : `${manifest.icon} needs xmlns="http://www.w3.org/2000/svg" on its <svg>, or the sidebar cannot show it`);
  }

  const page = texts.find((t) => t.rel === manifest.page);
  const hasSdk = Boolean(page) && /<script[^>]+src=["']\/plugin-sdk\.js["']/.test(page.body);
  check("loads the SDK", hasSdk, hasSdk ? "" : 'the page needs <script src="/plugin-sdk.js"></script> before its own scripts');
  const hasReady = /Rosalena\.ready\s*\(/.test(allCode);
  check("signals ready", hasReady, hasReady ? "" : "call Rosalena.ready() once the page has drawn; the verifier waits for it");
  const testCount = (allCode.match(/Rosalena\.test\s*\(/g) ?? []).length;
  check("has self-tests", testCount > 0, testCount ? `${testCount} Rosalena.test() call${testCount === 1 ? "" : "s"}` : "register at least one Rosalena.test(name, fn) that exercises the plugin");

  const remote = [];
  for (const t of texts) {
    // An absolute http(s) URL anywhere, or a protocol-relative one as an attribute or
    // url() value ("//cdn.example.com/x.js").
    const found = [
      ...[...t.body.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})[^\s"'`)<>]*/gi)].map((m) => ({ text: m[0], host: m[1] })),
      ...[...t.body.matchAll(/["'(]\/\/([a-z0-9.-]+\.[a-z]{2,})[^\s"'`)<>]*/gi)].map((m) => ({ text: m[0].slice(1), host: m[1] })),
    ];
    for (const m of found) {
      const host = m.host.toLowerCase();
      if (ALLOWED_URL_HOSTS.has(host)) continue;
      if (CODE_EXT.has(t.ext)) remote.push(`${t.rel}: ${m.text.slice(0, 80)}`);
      else warnings.push(`${t.rel} mentions ${m.text.slice(0, 80)} (fine as text; a plugin page cannot load it)`);
    }
  }
  check("no remote URLs", remote.length === 0, remote.length ? `a plugin page has no network, so vendor these or remove them: ${remote.slice(0, 6).join("; ")}` : "");

  const banned = [
    [/\beval\s*\(/, "eval()"],
    [/\bnew\s+Function\s*\(/, "new Function()"],
    [/document\.cookie/, "document.cookie"],
    [/\bwindow\.top\b|\btop\.location\b|\bparent\.location\b|\bwindow\.opener\b/, "reaching the app's window (use the SDK)"],
    [/\bimportScripts\s*\(/, "importScripts()"],
  ];
  const hits = [];
  for (const t of code) {
    for (const [pattern, label] of banned) if (pattern.test(t.body)) hits.push(`${t.rel}: ${label}`);
  }
  check("no unsafe code", hits.length === 0, hits.join("; "));
  for (const t of code) {
    if (/\b(localStorage|sessionStorage|indexedDB)\b/.test(t.body)) warnings.push(`${t.rel} uses browser storage, which throws in a sandboxed plugin page; use Rosalena.storage`);
    if (/\b(XMLHttpRequest|WebSocket|EventSource)\b/.test(t.body)) warnings.push(`${t.rel} mentions XMLHttpRequest/WebSocket/EventSource; a plugin page has no network`);
  }

  const uses = {
    storage: /Rosalena\.storage\b/,
    "files.save": /Rosalena\.files\.save\b/,
    "chat.compose": /Rosalena\.chat\.compose\b/,
    theme: /Rosalena\.theme\.(set|reset|get)\b/,
  };
  const undeclared = [];
  for (const [perm, pattern] of Object.entries(uses)) {
    const used = pattern.test(allCode);
    if (used && !manifest.permissions.includes(perm)) undeclared.push(perm);
    if (!used && manifest.permissions.includes(perm)) warnings.push(`plugin.json asks for "${perm}" but the code never uses it; ask for less`);
  }
  check("permissions declared", undeclared.length === 0, undeclared.length ? `the code uses ${undeclared.join(", ")} but plugin.json does not ask for it` : manifest.permissions.join(", ") || "none needed");

  const libUse = [...new Set([...allCode.matchAll(/\/plugin-lib\/([a-z0-9-]+)\//g)].map((m) => m[1]))];
  const libMissing = libUse.filter((name) => !manifest.libs.includes(name));
  check("libraries declared", libMissing.length === 0, libMissing.length ? `the code loads ${libMissing.join(", ")} from /plugin-lib but plugin.json "ui.libs" does not list it` : libUse.join(", ") || "none");

  return { ok: checks.every((c) => c.ok), checks, warnings, manifest };
}

// ---------------------------------------------------------------- runtime half

const VERIFY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>verify</title>
<style>html,body{margin:0;height:100%;background:#0b1d26}#stage{position:fixed;inset:0}#stage iframe{width:100%;height:100%;border:0;display:block}</style>
</head><body><div id="stage"></div>
<script type="module">
import { mountPlugin } from "/plugin-host.js";
const started = performance.now();
const plugin = await (await fetch("/__verify/plugin")).json();
const readyWithin = Number(new URLSearchParams(location.search).get("ready") || 20000);
const pageErrors = [];
window.addEventListener("error", (e) => pageErrors.push(String(e.message)));
let readyAt = null;
// A stand-in for the app's look settings, so a plugin with the "appearance" permission is
// tested on the path it takes in the real window (it is read only: verifying never sets).
const appearance = {
  get: () => ({
    appearance: { theme: "auto", palette: "petrol", accent: "cyan", textSize: "normal", density: "comfortable" },
    show: { statusbar: true, messageMeta: true },
    choices: { themes: ["auto", "dark", "light"], palettes: ["petrol", "midnight"], accents: ["cyan", "violet"], textSizes: ["small", "normal", "large"], densities: ["comfortable", "compact"] },
    labels: { show: { statusbar: { title: "Status bar", help: "The strip along the bottom." }, messageMeta: { title: "Model line", help: "Which model answered." } }, accents: { cyan: "Cyan", violet: "Violet" }, palettes: { petrol: { base: "#0b1d26", raised: "#204550" }, midnight: { base: "#0d0e10", raised: "#222328" } } },
  }),
  set: () => ({ verifying: true }),
};
const handle = mountPlugin({
  container: document.getElementById("stage"),
  plugin,
  verifying: true,
  appearance,
  onReady: () => { readyAt = Math.round(performance.now() - started); },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = performance.now() + readyWithin;
while (readyAt === null && performance.now() < deadline) await wait(100);
let tests = [];
let testError = null;
if (readyAt !== null) {
  await wait(800);
  try { tests = await handle.runTests(90000); } catch (err) { testError = String(err.message || err); }
  await wait(600);
}
window.__verifyResult = { readyAt, tests, testError, reports: handle.reports, calls: handle.calls, pageErrors, ms: Math.round(performance.now() - started) };
</script></body></html>`;

/** Serve one plugin folder the way the app would, plus the verify host page. */
async function startVerifyServer(folder, manifest) {
  const record = { ...manifest, source: "verify", ok: true, enabled: true, problems: [] };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/__verify.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(VERIFY_PAGE);
      }
      if (path === "/__verify/plugin") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify(publicView(record)));
      }
      if (path === "/plugin-host.js") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        return res.end(await readFile(HOST_FILE));
      }
      if (await servePluginRequest(req, res, path, { plugins: [record] })) return;
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err?.message ?? err));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/__verify.html` };
}

/** The Electron binary this checkout can use, or null. */
export function findElectron(env = process.env) {
  const fromEnv = String(env.ROSALENA_ELECTRON ?? "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const dist = fileURLToPath(new URL("../../desktop/node_modules/electron/dist/", import.meta.url));
  for (const name of ["electron.exe", "electron", "Electron.app/Contents/MacOS/Electron"]) {
    const full = join(dist, name);
    if (existsSync(full)) return full;
  }
  return null;
}

const inElectronMain = () => Boolean(process.versions.electron) && process.type === "browser";

async function captureHere(url, options) {
  const electron = await import("electron");
  const { captureVerify } = await import("./plugin-verify-electron.mjs");
  return captureVerify(electron.default ?? electron, { url, ...options });
}

function captureSpawned(binary, url, { timeoutMs, readyMs, screenshot }) {
  return new Promise((resolve) => {
    const env = { ...process.env, ROSALENA_VERIFY_ARGS: JSON.stringify({ url, timeoutMs, readyMs, screenshot }) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(binary, [RUNNER_FILE], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => child.kill(), timeoutMs + 20_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith("ROSALENA_VERIFY "));
      if (!line) return resolve({ error: `the verify window exited (${code}) without a result: ${(err || out).trim().slice(-600)}` });
      try {
        resolve(JSON.parse(line.slice("ROSALENA_VERIFY ".length)));
      } catch (e) {
        resolve({ error: `the verify window's result was not JSON: ${e.message}` });
      }
    });
  });
}

/** The runtime half. Returns { ok, skipped?, ready, tests, reports, screenshot, blank, ms, error? }. */
export async function runtimeCheck(folder, { manifest = readUiManifest(folder).manifest, timeoutMs = 120_000, readyMs = 20_000, screenshot = null, electron = findElectron() } = {}) {
  if (!manifest) return { ok: false, error: "not a UI plugin" };
  if (!inElectronMain() && !electron) {
    return { ok: false, skipped: true, error: "no Electron to run the page in (set ROSALENA_ELECTRON, or install desktop/node_modules)" };
  }
  const { server, url } = await startVerifyServer(folder, manifest);
  try {
    const raw = inElectronMain()
      ? await captureHere(url, { timeoutMs, readyMs, screenshot })
      : await captureSpawned(electron, url, { timeoutMs, readyMs, screenshot });
    if (raw.error) return { ok: false, error: raw.error };
    const r = raw.result ?? {};
    const tests = Array.isArray(r.tests) ? r.tests : [];
    const reports = Array.isArray(r.reports) ? r.reports : [];
    const ready = r.readyAt != null;
    const problems = [];
    if (!ready) problems.push(`the page never called Rosalena.ready() within ${readyMs / 1000} s`);
    if (r.testError) problems.push(r.testError);
    if (ready && !tests.length && !r.testError) problems.push("no self-tests ran (register them with Rosalena.test before the page loads)");
    const failed = tests.filter((t) => !t.ok);
    if (failed.length) problems.push(`${failed.length} of ${tests.length} self-tests failed: ${failed.map((t) => `${t.name}: ${t.error}`).join("; ")}`);
    if (reports.length) problems.push(`${reports.length} problem${reports.length === 1 ? "" : "s"} reported by the page: ${reports.slice(0, 5).map((x) => `[${x.level}] ${x.message.split("\n")[0]}`).join("; ")}`);
    if (Array.isArray(r.pageErrors) && r.pageErrors.length) problems.push(`the verify page itself failed: ${r.pageErrors.join("; ")}`);
    if (raw.blank) problems.push("the screenshot is blank: the page drew nothing visible");
    return {
      ok: problems.length === 0,
      ready,
      readyMs: r.readyAt ?? null,
      tests,
      reports,
      calls: r.calls ?? [],
      screenshot: raw.screenshot ?? null,
      blank: raw.blank ?? null,
      ms: r.ms ?? null,
      problems,
    };
  } finally {
    server.close();
  }
}

/**
 * Verify a plugin folder. `runtime: false` runs only the static half and the report says
 * so (ok is false: a plugin that was never run has not been verified). `reportDir` keeps
 * the report and the screenshot.
 */
export async function verifyPlugin(folder, { runtime = true, reportDir = null, timeoutMs, electron } = {}) {
  const started = Date.now();
  const print = fingerprint(folder);
  const stat = staticCheck(folder);
  const id = stat.manifest?.id ?? null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let screenshot = null;
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    screenshot = join(reportDir, `${id ?? "plugin"}-${stamp}.png`);
  }
  let run;
  if (!stat.ok) run = { ok: false, skipped: true, error: "not run: the static checks failed" };
  else if (!runtime) run = { ok: false, skipped: true, error: "not run (static checks only)" };
  else run = await runtimeCheck(folder, { manifest: stat.manifest, screenshot, ...(timeoutMs ? { timeoutMs } : {}), ...(electron !== undefined ? { electron } : {}) });

  const report = {
    id,
    version: stat.manifest?.version ?? null,
    ok: stat.ok && run.ok === true,
    fingerprint: print,
    at: new Date().toISOString(),
    ms: Date.now() - started,
    static: { ok: stat.ok, checks: stat.checks, warnings: stat.warnings },
    runtime: run,
  };
  if (reportDir) writeFileSync(join(reportDir, `${id ?? "plugin"}-${stamp}.json`), JSON.stringify(report, null, 2));
  return report;
}

/** One report as plain text, for the CLI, the tools and the chat. */
export function describeReport(report) {
  const lines = [`${report.ok ? "PASS" : "FAIL"}  ${report.id ?? "?"} v${report.version ?? "?"}  (${report.ms} ms, fingerprint ${String(report.fingerprint).slice(0, 12)})`];
  for (const c of report.static.checks) lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  for (const w of report.static.warnings) lines.push(`  warn ${w}`);
  const r = report.runtime;
  if (r.skipped) lines.push(`  ${r.ok ? "ok  " : "FAIL"} runtime: ${r.error}`);
  else if (r.error) lines.push(`  FAIL runtime: ${r.error}`);
  else {
    lines.push(`  ${r.ready ? "ok  " : "FAIL"} ready${r.readyMs != null ? ` after ${r.readyMs} ms` : ""}`);
    for (const t of r.tests) lines.push(`  ${t.ok ? "ok  " : "FAIL"} test: ${t.name} (${t.ms} ms)${t.ok ? "" : ` - ${t.error}`}`);
    for (const x of r.reports) lines.push(`  FAIL page reported [${x.level}] ${x.message.split("\n")[0]}`);
    if (r.blank) lines.push("  FAIL the screenshot is blank");
    if (r.screenshot) lines.push(`  screenshot ${r.screenshot}`);
  }
  return lines.join("\n");
}

// `node src/plugin-verify.mjs <folder> [--static]`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const folder = process.argv[2];
  if (!folder) {
    console.error("usage: node src/plugin-verify.mjs <plugin folder> [--static] [--report-dir <dir>]");
    process.exit(2);
  }
  const dirAt = process.argv.indexOf("--report-dir");
  const report = await verifyPlugin(folder, { runtime: !process.argv.includes("--static"), reportDir: dirAt > 0 ? process.argv[dirAt + 1] : null });
  console.log(describeReport(report));
  process.exit(report.ok ? 0 : 1);
}
