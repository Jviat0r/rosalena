import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createZstdDecompress } from "node:zlib";
import { readdirSync, statSync } from "node:fs";
const H = homedir();

const buf = readFileSync(join(H, ".dsh", "sessions", "--C-Users-Jades-Documents-deepseek-harness-default-workspace--",
  "session-8757aa7b-b1d9-4b39-922d-ab8154083c75", "session.v4.jsonl.zstd"));
const out = await new Promise((res, rej) => {
  const chunks = [];
  const z = createZstdDecompress();
  z.on("data", (c) => chunks.push(c));
  z.on("end", () => res(Buffer.concat(chunks)));
  z.on("error", rej);
  z.end(buf);
});
const text = out.toString("utf8");
const rows = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log("rows after stream decode:", rows.length);
const types = {};
for (const r of rows) types[r.type] = (types[r.type] || 0) + 1;
console.log("types:", JSON.stringify(types));
for (const r of rows) if (r.type !== "session") { console.log("SAMPLE:", JSON.stringify(r).slice(0, 500)); break; }

// find the biggest session file for a better sample
const walk = (d, out2 = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out2);
    else if (e.name.endsWith(".zstd")) out2.push(p);
  }
  return out2;
};
const files = walk(join(H, ".dsh", "sessions")).map((p) => [p, statSync(p).size]).sort((a, b) => b[1] - a[1]);
console.log("biggest:", files[0][0], files[0][1]);
const big = readFileSync(files[0][0]);
const out2 = await new Promise((res, rej) => {
  const chunks = []; const z = createZstdDecompress();
  z.on("data", (c) => chunks.push(c)); z.on("end", () => res(Buffer.concat(chunks))); z.on("error", rej);
  z.end(big);
});
const rows2 = out2.toString("utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log("big file rows:", rows2.length);
const t2 = {}; for (const r of rows2) t2[r.type] = (t2[r.type] || 0) + 1;
console.log("types:", JSON.stringify(t2));
const seen = new Set();
for (const r of rows2) {
  if (seen.has(r.type) || seen.size > 8) continue;
  seen.add(r.type);
  console.log("SAMPLE", r.type, ":", JSON.stringify(r).slice(0, 420));
}
