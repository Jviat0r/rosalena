/**
 * Words from the project, so dictation spells them the way the code does.
 *
 * A speech model has never heard `slugify` or `getDisplayName`: it writes "sludgeify" and
 * "get display name". whisper.cpp takes a prompt - text it treats as what came just before
 * - and spells words from it the same way, which is the documented way to teach it a
 * vocabulary. This collects that vocabulary from the workspace:
 *
 *   - names the code declares (function, class, const/let/var, def, fn, func, type,
 *     interface, enum, struct), first, because those are what people say out loud
 *   - other code-shaped words (camelCase, snake_case, words with digits) by how often
 *     they appear
 *   - file names without extensions
 *
 * Bounded on purpose: at most MAX_FILES source files of at most MAX_BYTES each, read once
 * per workspace every two minutes, and at most MAX_TERMS words (whisper only reads about
 * 220 tokens of prompt). Folders people never dictate about are skipped.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const MAX_FILES = 400;
const MAX_BYTES = 200 * 1024;
const MAX_TERMS = 80;
const MAX_CHARS = 700;
const CACHE_MS = 2 * 60 * 1000;
const SOURCE = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|cs|rb|php|swift|vue|svelte|astro|c|cc|cpp|h|hpp|scala|dart|lua|sh|ps1)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", "target", "vendor", ".venv", "venv", "__pycache__", ".cache", ".turbo", ".rosalena"]);
// Functions, classes and types wherever they are; variables only at the top level or
// exported - `const out = ...` inside a function is not a name anyone dictates.
const DECLARATION = /(?:\b(?:function\*?|class|def|fn|func|interface|enum|struct|trait)\s+|^(?:export\s+)?(?:const|let|var|type)\s+|\bexport\s+(?:default\s+)?(?:const|let|var|type)\s+)([A-Za-z_$][\w$]{2,40})/gm;
const WORD = /\b[A-Za-z_][A-Za-z0-9_]{3,40}\b/g;
// Ordinary English is what the model already knows; only code-shaped words need teaching.
const CODE_SHAPED = (w) => /[a-z][A-Z]|_|\d/.test(w) || /^[A-Z][a-z]+[A-Z]/.test(w);
const KEYWORDS = new Set("function class const let var return import export default from async await true false null undefined this self static public private protected interface extends implements typeof instanceof require module exports string number boolean object void".split(" "));

/** Source files to read: git's list when it is a repo (honours .gitignore), else a bounded walk. */
function sourceFiles(root) {
  const git = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  if (git.status === 0 && git.stdout) {
    return git.stdout.split("\0").filter((f) => f && !f.split("/").some((part) => SKIP_DIRS.has(part)));
  }
  const out = [];
  const walk = (dir, rel, depth) => {
    if (out.length > 4000 || depth > 8) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      } else if (e.isFile()) out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk(root, "", 0);
  return out;
}

// Everyday words a speech model already spells right: teaching them only spends the budget.
const COMMON = new Set(
  ("about after again also args base before begin being body build cache call camera check child clear click close code config count create data date default delete done each empty entry error event false file files filter find first form format found from full handle header height here home host index init input item items json just keep key label last left line lines list load main make message mode model name names next node note number open option order output page parse part path plugin point print read reason record render reply request reset result return right root route rows save scale second select send server service setup show size sleep slug sort source split start state status step store style table task test text that then this tick time title today token total type update user value view wait width wire with word work write")
    .split(" "),
);
const ALL_CAPS = /^[A-Z0-9_]+$/;

/** Worth teaching: code-shaped, or a plain name long and unusual enough to be misheard. */
const teachable = (w) => !ALL_CAPS.test(w) && !KEYWORDS.has(w) && (CODE_SHAPED(w) || (w.length >= 6 && !COMMON.has(w.toLowerCase())));

/**
 * The project's vocabulary, most useful first. Pure over the given file texts; `files` is
 * ordered most recently changed first, and the first RECENT of them count double - the
 * code being worked on is what gets dictated.
 */
export function vocabulary(files, { recent = 20 } = {}) {
  const declared = new Map();
  const shaped = new Map();
  const names = new Set();
  for (const [i, { path, text }] of files.entries()) {
    const weight = i < recent ? 2 : 1;
    const stem = basename(path, extname(path));
    if (stem.length >= 3 && !stem.startsWith(".")) names.add(stem);
    if (!text) continue;
    for (const m of text.matchAll(DECLARATION)) {
      const w = m[1];
      if (teachable(w)) declared.set(w, (declared.get(w) ?? 0) + weight);
    }
    for (const w of text.match(WORD) ?? []) {
      if (CODE_SHAPED(w) && teachable(w)) shaped.set(w, (shaped.get(w) ?? 0) + weight);
    }
  }
  const byCount = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
  const terms = [];
  const seen = new Set();
  for (const w of [...byCount(declared), ...byCount(shaped), ...[...names].filter(teachable).sort()]) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(w);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

const cache = new Map(); // root -> { at, terms }

/** The vocabulary of the workspace at `root`, cached for two minutes. Never throws. */
export function projectVocabulary(root) {
  const key = resolve(root);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.terms;
  let terms = [];
  try {
    // Most recently changed first, so the files being worked on are read and weighted first.
    const listed = sourceFiles(key)
      .map((rel) => {
        try {
          const st = statSync(join(key, rel));
          return { rel, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    const files = [];
    for (const { rel, size } of listed) {
      if (files.length >= MAX_FILES) break;
      if (!SOURCE.test(rel)) {
        files.push({ path: rel, text: "" });
        continue;
      }
      if (size > MAX_BYTES) continue;
      try {
        files.push({ path: rel, text: readFileSync(join(key, rel), "utf8") });
      } catch {
        /* vanished or unreadable */
      }
    }
    terms = vocabulary(files);
  } catch {
    terms = [];
  }
  cache.set(key, { at: Date.now(), terms });
  return terms;
}

/**
 * The prompt whisper.cpp gets: the project's words, then the end of what is already in the
 * message box (so a sentence continues in the same style). Capped to what whisper reads.
 */
export function dictationPrompt({ root = null, context = "" } = {}) {
  const terms = root ? projectVocabulary(root) : [];
  const parts = [];
  if (terms.length) parts.push(`Words in this project: ${terms.join(", ")}.`);
  const tail = String(context ?? "").replace(/\s+/g, " ").trim().slice(-200);
  if (tail) parts.push(tail);
  const text = parts.join(" ");
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
}
