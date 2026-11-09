// The early-build report: installs, who is active, what they spend, what breaks.
//
//   node site/scripts/telemetry-report.mjs            the last 7 days
//   node site/scripts/telemetry-report.mjs 30         the last 30 days
//   node site/scripts/telemetry-report.mjs 7 --words  also print tasks and answers of reported runs
//   node site/scripts/telemetry-report.mjs 7 --local  the local `wrangler pages dev` database
//
// Read-only: every statement is a SELECT against the live rosalena-trial database,
// through the same `wrangler d1 execute --remote` the operator already uses. Needs a
// logged-in wrangler (`npx wrangler login`).

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const days = Math.max(1, Math.min(365, Number(process.argv[2]) || 7));
const words = process.argv.includes("--words");
// --local reads the `wrangler pages dev` database instead, for testing this script.
const where = process.argv.includes("--local") ? "--local" : "--remote";
const since = Date.now() - days * 86_400_000;
const today = Date.now() - 86_400_000;

/**
 * Wrangler's own entry script, run with this node and no shell in between. Going through
 * `npx` on Windows means npx.cmd, which re-splits a quoted SQL argument on its spaces.
 */
function wranglerScript() {
  const candidates = [join(SITE, "node_modules", "wrangler", "bin", "wrangler.js")];
  try {
    candidates.push(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "wrangler", "bin", "wrangler.js"));
  } catch {
    /* no global npm root: only the local install can work */
  }
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new Error("wrangler is not installed: run `npm install -g wrangler` (or install it in site/)");
  return found;
}
const WRANGLER = wranglerScript();

function query(text) {
  const sql = text.replace(/\s+/g, " ").trim();
  const out = execFileSync(process.execPath, [WRANGLER, "d1", "execute", "rosalena-trial", where, "--json", "--command", sql], { cwd: SITE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  if (!parsed?.[0]?.success) throw new Error(`query failed: ${sql.slice(0, 80)}`);
  return parsed[0].results;
}

const when = (ms) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "-");
const num = (n) => (Number(n) || 0).toLocaleString("en-US");
const clip = (text, max) => {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
function table(rows, columns) {
  if (!rows.length) return "  (none)\n";
  const widths = columns.map(([title, get]) => Math.max(title.length, ...rows.map((r) => String(get(r)).length)));
  const line = (cells) => `  ${cells.map((c, i) => String(c).padEnd(widths[i])).join("  ")}`;
  return `${[line(columns.map(([t]) => t)), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(columns.map(([, get]) => get(r))))].join("\n")}\n`;
}

const [totals] = query(`SELECT COUNT(*) AS installs,
  SUM(CASE WHEN last_seen >= ${today} THEN 1 ELSE 0 END) AS active_1d,
  SUM(CASE WHEN last_seen >= ${since} THEN 1 ELSE 0 END) AS active_window,
  SUM(runs) AS runs, SUM(failed_runs) AS failed, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(reports) AS reports
  FROM tel_install`);
console.log(`Rosalena early-build report, last ${days} day(s), ${new Date().toISOString().slice(0, 16)} UTC\n`);
console.log(`Installs ever: ${num(totals.installs)}   active in 24h: ${num(totals.active_1d)}   active in ${days}d: ${num(totals.active_window)}`);
console.log(`All-time runs: ${num(totals.runs)} (${num(totals.failed)} failed)   tokens in/out: ${num(totals.tin)} / ${num(totals.tout)}   bad-answer reports: ${num(totals.reports)}\n`);

console.log("Installs (most recent first)");
const installs = query(`SELECT id, version, platform, arch, first_seen, last_seen, sessions, runs, failed_runs, tokens_in, tokens_out, reports FROM tel_install ORDER BY last_seen DESC LIMIT 50`);
console.log(
  table(installs, [
    ["install", (r) => r.id.slice(0, 8)],
    ["version", (r) => r.version ?? "-"],
    ["os", (r) => `${r.platform ?? "?"}/${r.arch ?? "?"}`],
    ["first seen", (r) => when(r.first_seen)],
    ["last seen", (r) => when(r.last_seen)],
    ["opens", (r) => num(r.sessions)],
    ["runs", (r) => num(r.runs)],
    ["failed", (r) => num(r.failed_runs)],
    ["tokens in", (r) => num(r.tokens_in)],
    ["tokens out", (r) => num(r.tokens_out)],
    ["reports", (r) => num(r.reports)],
  ]),
);

console.log("Active installs per day");
const daily = query(`SELECT day, COUNT(DISTINCT install) AS installs, SUM(CASE WHEN kind = 'run' THEN 1 ELSE 0 END) AS runs, SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens FROM tel_event WHERE stamp >= ${since} GROUP BY day ORDER BY day DESC`);
console.log(table(daily, [["day", (r) => r.day], ["active installs", (r) => num(r.installs)], ["runs", (r) => num(r.runs)], ["tokens", (r) => num(r.tokens)]]));

console.log("Runs by model");
const models = query(`SELECT COALESCE(model, '-') AS model, COUNT(*) AS runs, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) AS stopped, ROUND(AVG(steps), 1) AS steps, ROUND(AVG(ms) / 1000.0, 1) AS secs, SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout FROM tel_event WHERE kind = 'run' AND stamp >= ${since} GROUP BY model ORDER BY runs DESC`);
console.log(
  table(models, [
    ["model", (r) => r.model],
    ["runs", (r) => num(r.runs)],
    ["failed", (r) => num(r.failed)],
    ["stopped", (r) => num(r.stopped)],
    ["avg steps", (r) => r.steps ?? "-"],
    ["avg secs", (r) => r.secs ?? "-"],
    ["tokens in", (r) => num(r.tin)],
    ["tokens out", (r) => num(r.tout)],
  ]),
);

console.log("Cloud model calls (the message log)");
const calls = query(`SELECT COALESCE(json_extract(targets, '$[0]'), model, '-') AS target, COUNT(*) AS calls, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'ok' AND COALESCE(answer, '') = '' AND COALESCE(tool_calls, 0) = 0 THEN 1 ELSE 0 END) AS empty, ROUND(AVG(ms) / 1000.0, 1) AS secs, ROUND(AVG(ttft_ms) / 1000.0, 1) AS ttft, SUM(COALESCE(tokens_in, 0)) AS tin, SUM(COALESCE(tokens_out, 0)) AS tout FROM tel_event WHERE kind = 'call' AND stamp >= ${since} GROUP BY target ORDER BY calls DESC`);
console.log(
  table(calls, [
    ["target", (r) => r.target],
    ["calls", (r) => num(r.calls)],
    ["failed", (r) => num(r.failed)],
    ["empty answers", (r) => num(r.empty)],
    ["avg secs", (r) => r.secs ?? "-"],
    ["first token", (r) => (r.ttft === null ? "-" : `${r.ttft}s`)],
    ["tokens in", (r) => num(r.tin)],
    ["tokens out", (r) => num(r.tout)],
  ]),
);
const failedCalls = query(`SELECT stamp, install, run, json_extract(targets, '$[0]') AS target, error FROM tel_event WHERE kind = 'call' AND status = 'failed' AND stamp >= ${since} ORDER BY stamp DESC LIMIT 10`);
if (failedCalls.length) {
  console.log("Recent failed calls");
  console.log(table(failedCalls, [["when", (r) => when(r.stamp)], ["install", (r) => r.install.slice(0, 8)], ["run", (r) => r.run ?? "-"], ["target", (r) => r.target ?? "-"], ["error", (r) => clip(r.error, 90)]]));
}

console.log("Model errors, every failed attempt (local models included, no words)");
const errors = query(`SELECT COALESCE(json_extract(e.targets, '$[0]'), e.model, '-') AS target, e.cloud AS cloud, COUNT(*) AS n, SUM(CASE WHEN EXISTS (SELECT 1 FROM tel_event r WHERE r.kind = 'run' AND r.install = e.install AND r.run = e.run AND r.status = 'ok') THEN 1 ELSE 0 END) AS recovered, MAX(e.error) AS sample FROM tel_event e WHERE e.kind = 'model_error' AND e.stamp >= ${since} GROUP BY target, cloud ORDER BY n DESC LIMIT 20`);
console.log(table(errors, [["target", (r) => r.target], ["where", (r) => (r.cloud ? "cloud" : "local/other")], ["errors", (r) => num(r.n)], ["run still finished", (r) => num(r.recovered)], ["example", (r) => clip(r.sample, 80)]]));

console.log("Why runs stopped");
const stops = query(`SELECT COALESCE(stopped, status) AS reason, COUNT(*) AS n FROM tel_event WHERE kind = 'run' AND status <> 'ok' AND stamp >= ${since} GROUP BY reason ORDER BY n DESC`);
console.log(table(stops, [["reason", (r) => r.reason ?? "-"], ["runs", (r) => num(r.n)]]));

console.log("Recent failures");
const failures = query(`SELECT id, install, stamp, model, stopped, error FROM tel_event WHERE kind = 'run' AND status = 'failed' AND stamp >= ${since} ORDER BY stamp DESC LIMIT 15`);
console.log(table(failures, [["when", (r) => when(r.stamp)], ["install", (r) => r.install.slice(0, 8)], ["model", (r) => r.model ?? "-"], ["error", (r) => clip(r.error, 90)], ["row", (r) => r.id.slice(0, 8)]]));

console.log("Answer reports from testers");
const reports = query(`SELECT id, install, stamp, model, status, note, prompt, answer FROM tel_event WHERE kind = 'feedback' AND stamp >= ${since} ORDER BY stamp DESC LIMIT 25`);
console.log(table(reports, [["when", (r) => when(r.stamp)], ["install", (r) => r.install.slice(0, 8)], ["rating", (r) => r.status], ["model", (r) => r.model ?? "-"], ["note", (r) => clip(r.note || "-", 70)], ["row", (r) => r.id.slice(0, 8)]]));
if (words) {
  for (const r of reports.filter((x) => x.status === "bad")) {
    console.log(`--- ${r.id.slice(0, 8)} (${when(r.stamp)}, ${r.model ?? "-"})`);
    console.log(`task:   ${r.prompt ? clip(r.prompt, 600) : "(not shared: local model or sharing below full)"}`);
    console.log(`answer: ${r.answer ? clip(r.answer, 1200) : "(not shared)"}\n`);
  }
}
console.log("Every call of one run, prompt and answer included:");
console.log(`  wrangler d1 execute rosalena-trial --remote --command "SELECT stamp, status, json_extract(data, '$.step') AS step, prompt, answer, error FROM tel_event WHERE kind = 'call' AND run = '<run id>' ORDER BY stamp"`);
