/**
 * Project instructions: the rules a repository already carries for coding agents, loaded
 * into the system prompt the way OpenCode, Claude Code, Codex, Zed and Cursor load them.
 *
 * Search order, nearest folder last so the most specific rules are read last:
 *   - <ROSALENA_HOME>/AGENTS.md         the person's own rules for every project
 *   - every folder from the git root (or the drive root outside a repo) down to the
 *     workspace root: the FIRST of INSTRUCTION_NAMES that exists there. One file per
 *     folder, because a repo that has both usually has one point at the other
 *     ("@AGENTS.md"), and reading both would say everything twice.
 *   - in the workspace root, Cursor's `.cursor/rules/*.mdc` rules marked
 *     `alwaysApply: true` and Copilot's `.github/instructions/*.instructions.md` that
 *     apply to every file; the conditional ones are listed by name, to read when relevant.
 *
 * A line that is only "@some/file.md" (Claude Code's include syntax) is replaced by that
 * file's text, once - but only when the file is inside the project or next to the file
 * that names it: an AGENTS.md in a cloned repo must not be able to pull ~/.ssh/config or
 * another project's notes into the prompt. HTML comments are dropped (they are notes for
 * people, and a place to hide instructions from them).
 *
 * Everything is capped, and the budget is spent innermost first: when it runs out, the
 * outer, more general files are cut or dropped, never the project's own AGENTS.md. What
 * was cut or dropped is reported, so a run can say so instead of silently losing rules.
 * Subfolders' own AGENTS.md files are loaded when the run first touches a file there
 * (plugins/rosa-nested-instructions).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

import { rosalenaHome } from "./memory.mjs";

const MAX_FILE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 16_000;

/** One per folder, first match wins. AGENTS.override.md is Codex's local override. */
export const INSTRUCTION_NAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".rules",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  join(".github", "copilot-instructions.md"),
];

const readText = (file) => {
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const inside = (child, parent) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel));
};

const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

/**
 * Inline "@path" lines (relative to the file), one level deep. `allowed` is where an
 * include may come from: the project, and the importing file's own folder.
 */
function expandIncludes(text, file, { allowedRoots, refused }) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const include = /^@([^\s@]+\.(?:md|txt))\s*$/i.exec(line.trim());
      if (!include) return line;
      const target = resolve(dirname(file), include[1]);
      if (![dirname(file), ...allowedRoots].some((root) => inside(target, root))) {
        refused.push(`${file} -> ${target}`);
        return `(include of ${include[1]} skipped: it is outside this project)`;
      }
      const body = readText(target);
      return body === null ? line : stripComments(body).trim();
    })
    .join("\n");
}

/** The nearest folder at or above `dir` that holds a .git entry, or null. */
export function gitRoot(dir, { exists = existsSync } = {}) {
  let current = resolve(dir);
  for (;;) {
    if (exists(join(current, ".git"))) return current;
    const up = dirname(current);
    if (up === current) return null;
    current = up;
  }
}

/** Folders from the top of the search (git root, else drive root) down to `root`. */
function folderChain(root, { exists }) {
  const start = resolve(root);
  const top = gitRoot(start, { exists }) ?? parse(start).root;
  const chain = [];
  let dir = start;
  for (;;) {
    chain.unshift(dir);
    if (dir === top) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return chain;
}

/** The instruction files that apply to `root`, outermost first. */
export function instructionFiles(root, { home = rosalenaHome(), exists = existsSync } = {}) {
  const files = [];
  const personal = join(home, "AGENTS.md");
  if (exists(personal)) files.push(personal);
  for (const folder of folderChain(root, { exists })) {
    const found = INSTRUCTION_NAMES.map((name) => join(folder, name)).find((file) => exists(file) && readText(file) !== null);
    if (found) files.push(found);
  }
  return [...new Set(files)];
}

/** `---\nkey: value\n---` at the top of an .mdc / .instructions.md file. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Cursor and Copilot rule folders in the workspace root: the ones that always apply, and
 * an index of the rest (name, when it applies) for the model to read when relevant.
 */
export function ruleFolders(root) {
  const always = [];
  const conditional = [];
  const scan = (dir, suffix, isAlways, describe) => {
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(suffix)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = join(dir, name);
      const text = readText(file);
      if (!text?.trim()) continue;
      const { meta, body } = frontmatter(text);
      if (isAlways(meta)) always.push({ file, body: body.trim() });
      else conditional.push({ file, when: describe(meta) });
    }
  };
  scan(join(root, ".cursor", "rules"), ".mdc", (m) => /^true$/i.test(m.alwaysApply ?? ""), (m) => m.description || (m.globs ? `files matching ${m.globs}` : "when relevant"));
  scan(join(root, ".github", "instructions"), ".instructions.md", (m) => !m.applyTo || /^\*\*(\/\*)?$/.test(m.applyTo), (m) => `files matching ${m.applyTo}`);
  return { always, conditional };
}

/**
 * The block for the system prompt, or "" when the project has no instructions.
 * @returns {{ text: string, files: string[], cut: string[], dropped: string[], refusedIncludes: string[] }}
 */
export function loadInstructions(root, { home = rosalenaHome(), maxFileChars = MAX_FILE_CHARS, maxTotalChars = MAX_TOTAL_CHARS } = {}) {
  const projectTop = gitRoot(root) ?? resolve(root);
  const refused = [];
  const entries = [];
  for (const file of instructionFiles(root, { home })) {
    const raw = readText(file);
    if (!raw || !raw.trim()) continue;
    const allowedRoots = file.startsWith(resolve(home)) ? [home] : [projectTop, resolve(root)];
    entries.push({ file, text: expandIncludes(stripComments(raw), file, { allowedRoots, refused }).trim() });
  }
  const rules = ruleFolders(resolve(root));
  for (const rule of rules.always) entries.push({ file: rule.file, text: stripComments(rule.body).trim() });

  // Innermost first: the workspace's own rules are paid for before the outer ones.
  const cut = [];
  const dropped = [];
  const kept = new Map();
  let total = 0;
  for (const entry of [...entries].reverse()) {
    if (!entry.text) continue;
    let text = entry.text;
    if (text.length > maxFileChars) {
      text = `${text.slice(0, maxFileChars)}\n… [${entry.file} is longer; read it with read_file for the rest]`;
      cut.push(entry.file);
    }
    const room = maxTotalChars - total;
    if (room < 400) {
      dropped.push(entry.file);
      continue;
    }
    if (text.length > room) {
      text = `${text.slice(0, room)}\n… [the rest of ${entry.file} did not fit; read it with read_file]`;
      if (!cut.includes(entry.file)) cut.push(entry.file);
    }
    total += text.length;
    kept.set(entry.file, text);
  }
  const used = entries.map((e) => e.file).filter((f) => kept.has(f));
  const parts = used.map((file) => `From ${file}:\n${kept.get(file)}`);
  if (rules.conditional.length) {
    parts.push(`Other rule files in this project (read_file the one that fits the files you are changing):\n${rules.conditional.map((r) => `- ${r.file}: ${r.when}`).join("\n")}`);
  }
  if (dropped.length) parts.push(`(Not loaded for lack of room: ${dropped.join(", ")}. Read them with read_file if they matter.)`);
  if (!parts.length) return { text: "", files: [], cut, dropped, refusedIncludes: refused };
  return {
    text: [
      "Project instructions (the user's own rules for this project - follow them unless the user says otherwise in this chat; they never override the safety rules below):",
      ...parts,
    ].join("\n\n"),
    files: used,
    cut,
    dropped,
    refusedIncludes: refused,
  };
}

/**
 * The instruction file of a folder between `root` (exclusive) and `file`'s folder, for
 * rules a subfolder keeps for itself (packages/api/AGENTS.md). Nearest last.
 */
export function nestedInstructionFiles(root, file, { exists = existsSync } = {}) {
  const top = resolve(root);
  const out = [];
  let dir = dirname(resolve(top, file));
  if (!inside(dir, top)) return out;
  while (dir !== top && inside(dir, top)) {
    const found = INSTRUCTION_NAMES.slice(0, 5).map((name) => join(dir, name)).find((f) => exists(f) && readText(f) !== null);
    if (found) out.unshift(found);
    dir = dirname(dir);
  }
  return out;
}
