import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
const H = homedir();

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(join(H, ".local", "share", "opencode", "opencode.db"), { readOnly: true });

const s = db.prepare("select id, title, directory, time_created, time_updated from session order by time_updated desc limit 3").all();
console.log("=== opencode sessions");
for (const r of s) console.log(" ", r.id, "|", String(r.title).slice(0, 60), "|", r.directory, "|", r.time_updated);

const sid = s[0]?.id;
const msgs = db.prepare("select id, data from message where session_id = ? order by time_created limit 3").all(sid);
console.log("=== opencode messages (session", sid + ")");
for (const m of msgs) console.log("  MSG:", String(m.data).slice(0, 260));

const mid = msgs[0]?.id;
const parts = db.prepare("select id, data from part where message_id = ? limit 4").all(mid);
console.log("=== opencode parts");
for (const p of parts) console.log("  PART:", String(p.data).slice(0, 260));

const v2 = db.prepare("select id, session_id, type, seq, data from session_message order by time_created desc limit 4").all();
console.log("=== opencode session_message (v2)");
for (const r of v2) console.log("  ", r.type, "|", String(r.data).slice(0, 200));
db.close();

console.log("=== dsh v4 rows");
const p = join(H, ".dsh", "sessions", "--C-Users-Jades-Documents-deepseek-harness-default-workspace--",
  "session-8757aa7b-b1d9-4b39-922d-ab8154083c75", "session.v4.jsonl.zstd");
const raw = zstdDecompressSync(readFileSync(p)).toString("utf8");
const rows = raw.split("\n").filter(Boolean);
console.log("rows:", rows.length);
for (const r of rows.slice(0, 6)) console.log("  ROW:", r.slice(0, 280));
