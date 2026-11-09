// ast-grep: structural search and rewrite. The pattern is code with $VARS for "any node"
// ($A one node, $$$A any number), so `console.log($$$ARGS)` finds every call however it is
// spaced or wrapped, and never matches inside a string or a comment - the two things a
// regex search-and-replace gets wrong.
//
// Rewrites never use ast-grep's own --update-all: the matches come back as JSON with their
// replacement and byte offsets, this module applies them itself, so every file it writes is
// checked to be inside the workspace first and the dry run shows the exact diff.

import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { confine, rel } from "./confine.mjs";
import { unifiedDiff, diffStat } from "./diff.mjs";

const MAX_STDOUT = 64 * 1024 * 1024;

/** Run ast-grep and parse its JSON output. Rejects with its stderr on a bad pattern. */
export function runAstGrep(bin, { root, pattern, rewrite, lang, target = ".", timeoutMs = 60_000 }) {
  const args = ["run", "--pattern", String(pattern), "--json=compact", "--color=never"];
  if (lang) args.push("--lang", String(lang));
  if (rewrite !== undefined && rewrite !== null) args.push("--rewrite", String(rewrite));
  args.push(target);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (d) => {
      size += d.length;
      if (size <= MAX_STDOUT) chunks.push(d);
    });
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString("utf8").trim();
      if (size > MAX_STDOUT) return reject(new Error("too many matches to read; narrow the pattern or the path"));
      let matches = [];
      try {
        matches = out ? JSON.parse(out) : [];
      } catch {
        return reject(new Error(`ast-grep failed (exit ${code}): ${(err || out).trim().slice(0, 800)}`));
      }
      if (!Array.isArray(matches)) matches = [];
      if (code !== 0 && !matches.length && err.trim()) return reject(new Error(`ast-grep: ${err.trim().slice(0, 800)}`));
      resolvePromise(matches);
    });
  });
}

const firstLine = (s) => String(s ?? "").split(/\r?\n/)[0];

/** Search: `path:line:col  matched line`, at most `max` matches, grouped by file. */
export function formatMatches(root, matches, max = 60) {
  if (!matches.length) return null;
  const files = new Set(matches.map((m) => m.file));
  const lines = [`${matches.length} match${matches.length === 1 ? "" : "es"} in ${files.size} file${files.size === 1 ? "" : "s"}${matches.length > max ? ` (first ${max} shown)` : ""}:`];
  for (const m of matches.slice(0, max)) {
    const where = `${String(m.file).replace(/\\/g, "/")}:${m.range.start.line + 1}:${m.range.start.column + 1}`;
    const text = firstLine(m.lines ?? m.text).trim().slice(0, 200);
    const extra = String(m.text ?? "").includes("\n") ? ` [+${String(m.text).split("\n").length - 1} lines]` : "";
    lines.push(`${where}  ${text}${extra}`);
  }
  return lines.join("\n");
}

/**
 * Apply each file's replacements (byte offsets, back to front) and return
 * [{ file, abs, before, after, count }]. Files outside the workspace are refused.
 */
export function planRewrite(root, matches) {
  const byFile = new Map();
  for (const m of matches) {
    if (typeof m.replacement !== "string") continue;
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }
  const plans = [];
  for (const [file, list] of byFile) {
    const abs = confine(root, file);
    const buf = readFileSync(abs);
    const sorted = list
      .map((m) => ({ start: (m.replacementOffsets ?? m.range.byteOffset).start, end: (m.replacementOffsets ?? m.range.byteOffset).end, text: m.replacement }))
      .sort((a, b) => b.start - a.start);
    // Overlapping matches (a match inside a match): keep the outer one.
    const kept = [];
    let floor = Infinity;
    for (const r of sorted) {
      if (r.end <= floor) {
        kept.push(r);
        floor = r.start;
      }
    }
    let out = buf;
    for (const r of kept) out = Buffer.concat([out.subarray(0, r.start), Buffer.from(r.text, "utf8"), out.subarray(r.end)]);
    const before = buf.toString("utf8");
    const after = out.toString("utf8");
    if (before !== after) plans.push({ file: rel(root, abs), abs, before, after, out, count: kept.length, mtimeMs: statSync(abs).mtimeMs });
  }
  return plans;
}

/** The dry-run diff text for a set of planned file changes. */
export function renderPlans(plans, { maxChars = 5000 } = {}) {
  const parts = [];
  let used = 0;
  let hidden = 0;
  for (const p of plans) {
    const d = unifiedDiff(p.before, p.after, p.file);
    if (used + d.length > maxChars && parts.length) {
      hidden += 1;
      continue;
    }
    parts.push(d.length > maxChars ? `${d.slice(0, maxChars)}\n… [diff cut]` : d);
    used += d.length;
  }
  if (hidden) parts.push(`… and ${hidden} more file(s) not shown`);
  return parts.join("\n");
}

/** Write planned changes. Refuses a file that changed since it was planned. */
export function writePlans(root, plans) {
  const written = [];
  for (const p of plans) {
    const abs = confine(root, p.abs);
    if (statSync(abs).mtimeMs !== p.mtimeMs && readFileSync(abs, "utf8") !== p.before) {
      throw new Error(`${p.file} changed while the rewrite was being prepared; nothing more was written. Run it again`);
    }
    writeFileSync(abs, p.out ?? p.after);
    const { added, removed } = diffStat(unifiedDiff(p.before, p.after, p.file));
    written.push(`${p.file}: ${p.count} replacement${p.count === 1 ? "" : "s"} (+${added} -${removed})`);
  }
  return written;
}
