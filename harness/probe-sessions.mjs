import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const H = homedir();
const walk = (d, filter, out = []) => {
  let ents = [];
  try { ents = readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(e.name)) out.push(p);
  }
  return out;
};

// claude
const claude = join(H, ".claude", "projects");
const cj = walk(claude, (n) => n.endsWith(".jsonl")).sort();
console.log("claude jsonl:", cj.length);
if (cj.length) {
  const p = cj[cj.length - 1];
  console.log("  newest:", p, statSync(p).size);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  console.log("  lines:", lines.length);
  for (const l of lines.slice(0, 4)) console.log("  L:", l.slice(0, 300));
}

// codex
console.log("~/.codex exists:", existsSync(join(H, ".codex")));
if (existsSync(join(H, ".codex"))) console.log("  entries:", readdirSync(join(H, ".codex")).join(" | "));

// opencode storage
const st = join(H, ".local", "share", "opencode", "storage");
if (existsSync(st)) {
  console.log("opencode storage:", readdirSync(st).join(" | "));
  const sess = join(st, "session");
  if (existsSync(sess)) {
    const proj = readdirSync(sess)[0];
    console.log("  session projects:", readdirSync(sess).length, "first:", proj);
    if (proj) {
      const files = readdirSync(join(sess, proj));
      console.log("  files:", files.slice(0, 3).join(" | "), "count:", files.length);
      if (files[0]) console.log("  sample:", readFileSync(join(sess, proj, files[0]), "utf8").slice(0, 500));
    }
  }
}

// opencode db tables
try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(H, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
  const tables = db.prepare("select name from sqlite_master where type='table'").all();
  console.log("opencode.db tables:", tables.map((t) => t.name).join(" | "));
  for (const t of tables.map((x) => x.name).filter((n) => /session|message|part/i.test(n))) {
    const cols = db.prepare(`pragma table_info(${t})`).all().map((c) => c.name);
    const n = db.prepare(`select count(*) c from ${t}`).get();
    console.log(`  ${t}: rows=${n.c} cols=${cols.join(",")}`);
  }
  db.close();
} catch (e) { console.log("sqlite ERR:", e.message); }

// dsh
const dsh = join(H, ".dsh", "sessions");
const dirs = readdirSync(dsh, { withFileTypes: true }).filter((e) => e.isDirectory());
console.log("dsh project dirs:", dirs.length);
for (const d of dirs.slice(0, 3)) {
  const inner = readdirSync(join(dsh, d.name)).slice(0, 5);
  console.log(" ", d.name, "->", inner.join(" | "));
}
const dfiles = walk(dsh, (n) => /session.*\.(jsonl|zstd)$/.test(n));
console.log("dsh session files:", dfiles.length);
if (dfiles.length) {
  const p = dfiles[0];
  console.log("  sample:", p, statSync(p).size);
  console.log("  head:", readFileSync(p).subarray(0, 100).toString("latin1").replace(/[^\x20-\x7e]/g, "."));
}
