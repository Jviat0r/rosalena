/**
 * After a file tool writes a file: format it with the project's own formatter (only when
 * the project has one installed), then a quick syntax check. Ported from OpenCode's
 * format-on-edit and LSP diagnostics, kept deliberately cheap:
 *
 *   .js .mjs .cjs   node --check                 (~50 ms)
 *   .json           JSON.parse in-process        (comments allowed in tsconfig/jsconfig/.vscode)
 *   .py             python -m py_compile         (only when python is on PATH)
 *   formatter       prettier or biome from the project's node_modules/.bin, nothing else -
 *                   a project with no formatter is never restyled
 *
 * Every step has a short timeout and none of them can fail the edit: the result line
 * tells the model what was found, and an error is phrased as something to fix now.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

const TIMEOUT_MS = 8000;
let pythonFound = null;

function hasPython() {
  if (pythonFound !== null) return pythonFound;
  const probe = spawnSync(process.platform === "win32" ? "python" : "python3", ["--version"], { timeout: 3000, windowsHide: true, encoding: "utf8" });
  pythonFound = probe.status === 0 && /Python 3/.test(`${probe.stdout}${probe.stderr}`);
  return pythonFound;
}

/** The project's own formatter binary, if it has one installed: prettier, then biome. */
function findFormatter(root, file) {
  const ext = extname(file).toLowerCase();
  if (![".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json", ".css", ".scss", ".html", ".md", ".vue", ".svelte"].includes(ext)) return null;
  const bin = join(root, "node_modules", ".bin");
  const suffix = process.platform === "win32" ? ".cmd" : "";
  for (const [name, args] of [
    ["prettier", ["--write", file]],
    ["biome", ["format", "--write", file]],
  ]) {
    const path = join(bin, `${name}${suffix}`);
    if (existsSync(path)) return { name, path, args };
  }
  return null;
}

function firstLines(text, n = 6) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(0, n)
    .join("\n");
}

/** Format (if the project has a formatter) and syntax-check `abs`. Returns one or two lines. */
export function afterEdit(abs, root) {
  const notes = [];
  const formatter = findFormatter(root, abs);
  if (formatter) {
    const run = spawnSync(formatter.path, formatter.args, { cwd: root, timeout: TIMEOUT_MS, windowsHide: true, encoding: "utf8", shell: process.platform === "win32" });
    notes.push(run.status === 0 ? `formatted with ${formatter.name}` : `${formatter.name} could not format it (left as written)`);
  }

  const ext = extname(abs).toLowerCase();
  const name = basename(abs).toLowerCase();
  const rel = relative(root, abs) || abs;
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    // process.execPath is node, or Electron in the desktop app - which runs as node with this.
    const run = spawnSync(process.execPath, ["--check", abs], { timeout: TIMEOUT_MS, windowsHide: true, encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    if (run.status === 0) notes.push("syntax ok (node --check)");
    else if (run.error) notes.push(`syntax check skipped: ${run.error.message}`);
    else notes.push(`SYNTAX ERROR - fix this before anything else:\n${firstLines(run.stderr)}`);
  } else if (ext === ".json") {
    const lenient = /^(tsconfig|jsconfig)[^/\\]*\.json$/.test(name) || basename(dirname(abs)) === ".vscode";
    if (!lenient) {
      try {
        JSON.parse(readFileSync(abs, "utf8"));
        notes.push("valid JSON");
      } catch (err) {
        notes.push(`INVALID JSON in ${rel} - fix this before anything else: ${err.message}`);
      }
    }
  } else if (ext === ".py" && hasPython()) {
    const run = spawnSync("python", ["-m", "py_compile", abs], { timeout: TIMEOUT_MS, windowsHide: true, encoding: "utf8" });
    notes.push(run.status === 0 ? "syntax ok (py_compile)" : `SYNTAX ERROR - fix this before anything else:\n${firstLines(run.stderr)}`);
  }
  return notes.length ? `\n${notes.join("\n")}` : "";
}
