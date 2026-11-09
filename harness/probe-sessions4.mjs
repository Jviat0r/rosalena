import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
const H = homedir();

const walk = (d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === "session.v4.jsonl.zstd") out.push(p);
  }
  return out;
};
const files = walk(join(H, ".dsh", "sessions")).map((p) => [p, statSync(p).size]).sort((a, b) => b[1] - a[1]);
const [file, size] = files[0];
console.log("file:", file.split("sessions")[1], size, "bytes; total logs:", files.length);

const buf = readFileSync(file);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offsets = [];
for (let i = 0; (i = buf.indexOf(magic, i)) !== -1; i += 4) offsets.push(i);
console.log("frames found:", offsets.length);
const rows = [];
let bad = 0;
for (const off of offsets) {
  try {
    const text = zstdDecompressSync(buf.subarray(off)).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { bad += 1; }
    }
  } catch { bad += 1; }
}
console.log("rows:", rows.length, "unparsable:", bad);
const types = {};
for (const r of rows) types[r.type || "(none)"] = (types[r.type || "(none)"] || 0) + 1;
console.log("types:", JSON.stringify(types, null, 0));
const seen = new Set();
for (const r of rows) {
  const t = r.type || "?";
  if (seen.has(t) || seen.size >= 10) continue;
  seen.add(t);
  console.log("\nSAMPLE " + t + ":", JSON.stringify(r).slice(0, 600));
}
