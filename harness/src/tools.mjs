/**
 * The harness tool set.
 *
 * Two rules shape all of this:
 *
 *  1. Everything is rooted at the workspace. Every path is resolved and checked to
 *     still be inside the root before it is touched, so a model that emits
 *     "../../Windows/System32/..." gets a refused tool result, not a filesystem write.
 *  2. Tool output is clipped at the boundary. A 4 MB file read or a chatty build log
 *     would otherwise eat the whole context window in one step, and the model needs
 *     the context more than it needs the log.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { budgetFor, clipForTool, profileFor } from "./context.mjs";
import { portedTools, startJob } from "./tools-extra.mjs";
import { desktopTools } from "./desktop.mjs";
import { runSandboxed } from "./sandbox.mjs";
import { afterEdit } from "./edit-check.mjs";

/** Keep the tail: right for command output, where the error is at the end. */
/**
 * Where output too long to show in full is kept, so nothing is lost when a result is cut:
 * the model is told the path and may read it (the folder is a read-only root of every run).
 * Files older than a week are removed the first time tools are built in a process.
 */
export const toolOutputDir = () => join(process.env.ROSALENA_HOME || join(homedir(), ".rosalena"), "tool-output");
let spillSwept = false;
function sweepSpills(dir) {
  if (spillSwept) return;
  spillSwept = true;
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    }
  } catch {
    /* no folder yet, or a file in use: nothing to sweep */
  }
}

function clipTail(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `… [truncated ${s.length - max} of ${s.length} chars]\n${s.slice(-max)}`;
}

/**
 * @param {object} opts
 * @param {number} [opts.maxOutputChars] Explicit global budget. Omitted means each
 *   tool uses its own measured profile (see context.mjs); given, it flattens them.
 * @param {object} [opts.cache] A tool-output cache; only tools whose profile declares
 *   a validity check use it.
 * @param {(info: object) => void} [opts.onCacheHit] Called when bytes are NOT re-sent.
 * @param {string[]} [opts.extraReadRoots] Directories outside the workspace that the
 *   **reading** tools may open: a run's own attachments. Writes and the shell are
 *   unaffected, so this widens what a run can see, never where it can write.
 */
export function createTools({
  root,
  maxOutputChars = null,
  // Five minutes, not two: a whole-tree search or a test suite on this machine routinely
  // needs more than 120s, and being killed mid-run taught the model to split work into
  // smaller commands and lose what it had found (measured 2026-11-06). The agent passes the
  // run's own watchdog deadline here, so the child is killed first and its message reaches
  // the model; this default is what a caller without one gets.
  commandTimeoutMs = 300_000,
  delegate = null,
  extraTools = [],
  allowShell = true,
  cache = null,
  onCacheHit = null,
  extraReadRoots = [],
  // Where the ported tools send what a page should draw (a question, a presented file).
  onEvent = null,
  // The run store, for session_search.
  runsDir = null,
  // Undo per step: told about a file before a file tool changes it (undo.mjs).
  journal = null,
  // Format and syntax-check a file after a file tool writes it (edit-check.mjs).
  checkEdits = true,
  // read_image hands the loaded picture here; the loop shows it to the model next.
  onImage = null,
  // OS sandbox for run_command (sandbox.mjs): false, true, or { writable: [...], network }.
  // When on, a command can write only inside the workspace (and its own temp folder),
  // and a sandbox that cannot start refuses the command rather than running it bare.
  sandbox = false,
  // Native desktop control (desktop.mjs): screen, mouse and keyboard.
  desktop = false,
}) {
  const ROOT = resolve(root);
  const SPILL_DIR = toolOutputDir();
  sweepSpills(SPILL_DIR);
  const READ_ONLY_ROOTS = [...extraReadRoots, SPILL_DIR].filter(Boolean).map((r) => resolve(r));

  /** Keep the full text of a cut result, and say where it is. Never throws. */
  function spill(name, full) {
    try {
      mkdirSync(SPILL_DIR, { recursive: true });
      const file = join(SPILL_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.txt`);
      writeFileSync(file, full, "utf8");
      return `\n[the full output (${full.length} chars) is saved at ${file} - read parts of it with read_file offset/limit, or search it with search path]`;
    } catch {
      return "";
    }
  }
  const clipKeep = (name, text) => {
    const full = String(text ?? "");
    const clipped = clipForTool(name, full, maxOutputChars);
    return clipped === full ? clipped : `${clipped}${spill(name, full)}`;
  };

  /**
   * Serve from the cache when this exact call already ran against an unchanged
   * file, otherwise run it and record the result. Only reached for tools whose
   * profile names a validity check - everything else is returned untouched, so a
   * shell command or a subagent is never answered from a stale entry.
   */
  function withCache(name, run) {
    if (!cache || !profileFor(name, maxOutputChars).cache) return run;
    return async (args) => {
      const hit = cache.get(name, args);
      if (hit) {
        onCacheHit?.({ tool: name, path: args?.path, bytes: hit.bytes });
        return cache.stub(hit, args);
      }
      const text = await run(args);
      // Recorded only after a successful read, so a refused path is not cached
      // and a later legitimate read of it is not answered from a stub.
      cache.put(name, args, text);
      return text;
    };
  }

  function inside(p, { write = false } = {}) {
    const abs = resolve(ROOT, String(p ?? "."));
    if (!write) {
      // A run's attachments live in the harness home, not the workspace, so the
      // reading tools are allowed to open that one directory. Without this the model
      // is handed a path it cannot read and reaches for the shell instead - measured:
      // read_file refused the attached file and the next step ran
      // `powershell -Command Get-Content` on it, which is the opposite of confined.
      for (const extra of READ_ONLY_ROOTS) {
        const rel = relative(extra, abs);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return abs;
      }
    }
    const rel = relative(ROOT, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`refused: "${p}" resolves outside the workspace root (${ROOT})`);
    }
    // A write follows links: a junction or symlink inside the workspace that points out of
    // it must not let write/edit/move/delete reach the other side. The nearest part of the
    // path that exists is resolved for real and must still be inside the real root.
    if (write) {
      let probe = abs;
      while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
      try {
        const realRoot = realpathSync.native(ROOT);
        const realProbe = realpathSync.native(probe);
        const realRel = relative(realRoot, realProbe);
        if (realRel.startsWith("..") || isAbsolute(realRel)) {
          throw new Error(`refused: "${p}" goes through a link that points outside the workspace root (${ROOT})`);
        }
      } catch (err) {
        if (String(err?.message ?? "").startsWith("refused:")) throw err;
        // a path that cannot be resolved here is judged by its name, as before
      }
    }
    return abs;
  }

  function listDir(p) {
    const abs = inside(p);
    return readdirSync(abs, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name}${statSync(join(abs, e.name)).size > 1024 * 1024 ? " (large)" : ""}`))
      .join("\n");
  }

  function readFileRange(p, offset, limit) {
    const abs = inside(p);
    const text = readFileSync(abs, "utf8");
    if (offset === undefined && limit === undefined) return clipForTool("read_file", text, maxOutputChars);
    const lines = text.split(/\r?\n/);
    const from = Math.max(0, (Number(offset) || 1) - 1);
    const to = limit ? from + Number(limit) : lines.length;
    // The range path used to be unbounded: `limit: 500000` walked straight past
    // every budget in this file. Same budget as a full read, same clip.
    return clipForTool("read_file", lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join("\n"), maxOutputChars);
  }

  function writeFile(p, content) {
    const abs = inside(p, { write: true });
    journal?.record(abs);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, String(content ?? ""), "utf8");
    // A write can change any file in the workspace, and it definitely changed this
    // one, so every cached read is now suspect. Cheaper to re-send than to be wrong.
    cache?.invalidateAll();
    return `wrote ${Buffer.byteLength(String(content ?? ""))} bytes to ${relative(ROOT, abs)}${checkEdits ? afterEdit(abs, ROOT) : ""}`;
  }

  /**
   * Replace one exact piece of a file. This is the tool that makes small changes cheap:
   * without it a one-line fix meant rewriting the whole file through write_file, which
   * small models avoid - they keep reading instead of changing anything.
   *
   * The match must be exact and, unless replace_all is set, unique; a miss or an
   * ambiguous match is refused with the reason, so the model re-reads instead of guessing.
   * A file with Windows line endings is matched either way and keeps its endings.
   */
  function editFile(p, oldText, newText, replaceAll = false) {
    const abs = inside(p, { write: true });
    const before = readFileSync(abs, "utf8");
    let find = String(oldText ?? "");
    let replacement = String(newText ?? "");
    if (!find) throw new Error("old_text is empty: give the exact text to replace (read_file shows it)");
    if (find === replacement) throw new Error("old_text and new_text are the same, so there is nothing to change");
    if (!before.includes(find) && before.includes("\r\n") && !find.includes("\r\n")) {
      find = find.replace(/\n/g, "\r\n");
      replacement = replacement.replace(/\r?\n/g, "\r\n");
    }
    const count = before.split(find).length - 1;
    if (count === 0) {
      throw new Error(`old_text was not found in ${relative(ROOT, abs)}. Read the file again and copy the exact text, including spaces and indentation.`);
    }
    if (count > 1 && !replaceAll) {
      throw new Error(`old_text appears ${count} times in ${relative(ROOT, abs)}. Include more surrounding lines so it is unique, or set replace_all to change every one.`);
    }
    const after = replaceAll ? before.split(find).join(replacement) : before.replace(find, () => replacement);
    journal?.record(abs);
    writeFileSync(abs, after, "utf8");
    cache?.invalidateAll();
    return `edited ${relative(ROOT, abs)}: replaced ${replaceAll ? count : 1} occurrence${(replaceAll ? count : 1) === 1 ? "" : "s"} (${Buffer.byteLength(before)} -> ${Buffer.byteLength(after)} bytes)${checkEdits ? afterEdit(abs, ROOT) : ""}`;
  }

  /**
   * Several replacements in one file, in one call (Claude Code's MultiEdit): applied in
   * order to the text in memory and written once, so either all of them land or none do.
   */
  function editFileMany(p, edits) {
    const abs = inside(p, { write: true });
    const before = readFileSync(abs, "utf8");
    const crlf = before.includes("\r\n");
    let text = before;
    let replaced = 0;
    edits.forEach((edit, index) => {
      let find = String(edit?.old_text ?? "");
      let replacement = String(edit?.new_text ?? "");
      const where = `edit ${index + 1} of ${edits.length}`;
      if (!find) throw new Error(`${where}: old_text is empty. Nothing was changed.`);
      if (find === replacement) throw new Error(`${where}: old_text and new_text are the same. Nothing was changed.`);
      if (!text.includes(find) && crlf && !find.includes("\r\n")) {
        find = find.replace(/\n/g, "\r\n");
        replacement = replacement.replace(/\r?\n/g, "\r\n");
      }
      const count = text.split(find).length - 1;
      if (count === 0) throw new Error(`${where}: old_text was not found (after the edits before it). Nothing was changed; read the file again and copy the exact text.`);
      if (count > 1 && edit?.replace_all !== true) throw new Error(`${where}: old_text appears ${count} times. Add surrounding lines or set replace_all. Nothing was changed.`);
      text = edit?.replace_all === true ? text.split(find).join(replacement) : text.replace(find, () => replacement);
      replaced += edit?.replace_all === true ? count : 1;
    });
    journal?.record(abs);
    writeFileSync(abs, text, "utf8");
    cache?.invalidateAll();
    return `edited ${relative(ROOT, abs)}: ${edits.length} edit${edits.length === 1 ? "" : "s"}, ${replaced} replacement${replaced === 1 ? "" : "s"} (${Buffer.byteLength(before)} -> ${Buffer.byteLength(text)} bytes)${checkEdits ? afterEdit(abs, ROOT) : ""}`;
  }

  /** Move or rename one file inside the workspace. Undo puts it back. */
  function moveFile(from, to, overwrite = false) {
    const src = inside(from, { write: true });
    const dest = inside(to, { write: true });
    if (!existsSync(src)) throw new Error(`${relative(ROOT, src)} does not exist`);
    if (statSync(src).isDirectory()) throw new Error(`${relative(ROOT, src)} is a folder: move_file moves one file (use run_command for a folder)`);
    // On Windows "Foo.txt" -> "foo.txt" is the same file renamed, not an overwrite.
    const caseOnly = src !== dest && src.toLowerCase() === dest.toLowerCase();
    if (existsSync(dest) && !overwrite && !caseOnly) throw new Error(`${relative(ROOT, dest)} already exists; set overwrite to replace it`);
    journal?.record(src);
    journal?.record(dest);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(src, dest);
    cache?.invalidateAll();
    return `moved ${relative(ROOT, src)} -> ${relative(ROOT, dest)} (undo puts it back)`;
  }

  /** Delete one file inside the workspace. Its bytes are kept in the run's journal, so undo restores it. */
  function deleteFile(p) {
    const abs = inside(p, { write: true });
    if (!existsSync(abs)) throw new Error(`${relative(ROOT, abs)} does not exist`);
    if (statSync(abs).isDirectory()) throw new Error(`${relative(ROOT, abs)} is a folder: delete_file deletes one file (use run_command for a folder)`);
    journal?.record(abs);
    rmSync(abs);
    cache?.invalidateAll();
    return `deleted ${relative(ROOT, abs)} (undo restores it)`;
  }

  /** A bounded in-process grep: no dependency on rg being installed. */
  function search(pattern, include, path) {
    let re;
    try {
      re = new RegExp(String(pattern), "i");
    } catch (err) {
      return { text: `invalid regex: ${err.message}`, hits: 0 };
    }
    const suffix = include ? String(include).replace(/^\*/, "") : null;
    const hits = [];
    const stack = [path ? inside(path) : ROOT];
    let scanned = 0;
    while (stack.length && hits.length < 60 && scanned < 4000) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (suffix && !entry.name.endsWith(suffix)) continue;
        scanned += 1;
        let text;
        try {
          if (statSync(full).size > 2 * 1024 * 1024) continue;
          text = readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < 60; i += 1) {
          if (re.test(lines[i])) hits.push(`${relative(ROOT, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
    return {
      text: hits.length ? hits.join("\n") : `no matches for /${pattern}/i (scanned ${scanned} files)`,
      hits: hits.length,
    };
  }

  function runCommand(command, askedMs, { cwd = ROOT, powershell = false } = {}) {
    // What the model asked for, held to 1 s .. 10 min; anything else (0, a string, nothing)
    // is the run's default. 0 used to kill the command at once, and a huge value outlived
    // the watchdog (bug hunt 2026-11-08).
    const asked = Number(askedMs);
    const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(600_000, Math.max(1000, asked)) : commandTimeoutMs;
    if (sandbox) {
      return runSandboxed({
        command: String(command),
        cwd,
        writable: [ROOT, ...(sandbox.writable ?? [])],
        network: sandbox.network ?? true,
        timeoutMs,
        shell: powershell ? "powershell" : "cmd",
      });
    }
    return new Promise((resolvePromise) => {
      const child = powershell
        ? spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", String(command)], { cwd, windowsHide: true })
        : spawn(String(command), { cwd, shell: true, windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        err += `\n[harness: killed after ${timeoutMs}ms]`;
        child.kill();
      }, timeoutMs);
      child.stdout?.on("data", (d) => {
        out += d;
      });
      child.stderr?.on("data", (d) => {
        err += d;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({ code, out, err });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolvePromise({ code: -1, out, err: `${err}\n${e.message}` });
      });
    });
  }

  const byName = {
    read_file: {
      description: "Read a UTF-8 text file inside the workspace. Optionally a line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root." },
          offset: { type: "integer", description: "1-based first line." },
          limit: { type: "integer", description: "Number of lines." },
        },
        required: ["path"],
      },
      run: withCache("read_file", ({ path, offset, limit }) => readFileRange(path, offset, limit)),
    },
    write_file: {
      description: "Write a UTF-8 text file inside the workspace, creating parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Full file contents. Replaces the file." },
        },
        required: ["path", "content"],
      },
      async run({ path, content }) {
        return writeFile(path, content);
      },
    },
    edit_file: {
      description:
        "Change part of an existing file by replacing an exact piece of text. Use this for any change to an existing file - it is much cheaper than rewriting the file with write_file. old_text must match the file exactly (copy it from read_file, without the line-number prefixes) and be unique unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root." },
          old_text: { type: "string", description: "The exact text to replace, with enough surrounding lines to be unique." },
          new_text: { type: "string", description: "What to put in its place." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one." },
          edits: {
            type: "array",
            description: "Several changes to this one file in one call, applied in order; all land or none do. Use instead of old_text/new_text.",
            items: {
              type: "object",
              properties: { old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } },
              required: ["old_text", "new_text"],
            },
          },
        },
        required: ["path"],
      },
      async run({ path, old_text: oldText, new_text: newText, replace_all: replaceAll, edits }) {
        if (Array.isArray(edits) && edits.length) return editFileMany(path, edits);
        return editFile(path, oldText, newText, replaceAll === true);
      },
    },
    move_file: {
      description: "Move or rename one file inside the workspace (creates the target folder). Undo puts it back.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "The file now, relative to the workspace root." },
          to: { type: "string", description: "Where it goes, relative to the workspace root." },
          overwrite: { type: "boolean", description: "Replace a file already at `to`." },
        },
        required: ["from", "to"],
      },
      async run({ from, to, overwrite }) {
        return moveFile(from, to, overwrite === true);
      },
    },
    delete_file: {
      description: "Delete one file inside the workspace. Its contents are kept, so undo restores it. For a folder use run_command.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Path relative to the workspace root." } }, required: ["path"] },
      async run({ path }) {
        return deleteFile(path);
      },
    },
    list_dir: {
      description: "List a directory inside the workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async run({ path }) {
        return clipForTool("list_dir", listDir(path), maxOutputChars);
      },
    },
    search: {
      description: "Case-insensitive regex search across workspace files. Skips node_modules, .git and dist.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          include: { type: "string", description: "Optional file suffix filter, e.g. '.mjs' or '*.ts'." },
          path: { type: "string", description: "Optional folder to search in, relative to the workspace root." },
        },
        required: ["pattern"],
      },
      async run({ pattern, include, path }) {
        return clipKeep("search", search(pattern, include, path).text);
      },
    },
    run_command: {
      // The description tells the model the truth: this is a real shell, and the
      // workspace is only its working directory. Measured 2026-10-19 - a model asked to
      // write outside the workspace, refused by write_file, then did it through this
      // tool, correctly. A description implying confinement would only make the next
      // model's mental model wrong about what it can actually do.
      description:
        sandbox
          ? "Run a shell command in the workspace root and return its exit code, stdout and stderr. Commands are SANDBOXED: they can read anything but can only write inside the workspace (and a temp folder), cannot write the registry or app settings, and background jobs are off. Some Unix-style tools from Git Bash cannot start in the sandbox; use cmd, PowerShell, node, git or python instead."
          : "Run a shell command in the workspace root and return its exit code, stdout and stderr. The shell runs with the harness user's own permissions: the workspace is its working directory, not a boundary. Use the file tools for reading and writing files; reach outside the workspace only when the task explicitly requires it, and say so when you do.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: {
            type: "integer",
            description:
              "How long to let it run, in milliseconds. Defaults to 300000 (5 minutes), and may be raised to 600000 (10 minutes) when the work genuinely takes that long - a full build, a whole test suite, a repository-wide search. Say why in your message when you raise it.",
          },
          workdir: { type: "string", description: "Folder to run in, relative to the workspace root. Defaults to the root." },
          shell: { type: "string", enum: ["default", "powershell"], description: "\"powershell\" runs the command in Windows PowerShell instead of cmd.exe." },
          background: { type: "boolean", description: "Start it and return at once with a job id (for servers, watchers, long builds). Read it with job_output, stop it with job_kill." },
        },
        required: ["command"],
      },
      async run({ command, timeoutMs, workdir, shell, background }) {
        const cwd = workdir ? inside(workdir) : ROOT;
        const powershell = shell === "powershell";
        if (background) {
          // Background jobs live past the command, which the sandbox's job object does not
          // allow; refuse rather than run one unconfined.
          if (sandbox) return "refused: background jobs are not available while commands are sandboxed. Run it in the foreground with a timeoutMs, or ask the user to turn the sandbox off.";
          const job = startJob({ command, cwd, powershell });
          return `started ${job.id} (pid ${job.pid}) in the background. Read its output with job_output {"job_id":"${job.id}"}; stop it with job_kill.`;
        }
        const { code, out, err } = await runCommand(command, timeoutMs, { cwd, powershell });
        // Per stream, not per result: stdout and stderr each get the budget, because
        // half a log helps nobody. The tail is kept - the error is at the end.
        const budget = budgetFor("run_command", maxOutputChars);
        const parts = [`exit ${code}`];
        if (out.trim()) parts.push(`stdout:\n${clipTail(out, budget)}`);
        if (err.trim()) parts.push(`stderr:\n${clipTail(err, budget)}`);
        if (out.length > budget || err.length > budget) parts.push(spill("run_command", `$ ${command}\nexit ${code}\n\nstdout:\n${out}\n\nstderr:\n${err}`).trim());
        return parts.join("\n");
      },
    },
  };

  // The only real confinement available for a shell is not having one. A path check
  // on a command string would be theatre: `Set-Content ..\x`, `cmd /c`, a base64
  // payload or a called script all defeat a regex. So the choice is explicit - keep
  // the shell, or drop it and accept that the file tools are confined and nothing else
  // is. Deleting it here means the model cannot even see it in the tool list.
  Object.assign(
    byName,
    portedTools({
      root: ROOT,
      inside,
      clip: clipKeep,
      emit: (event) => onEvent?.(event),
      runsDir,
      onImage,
    }),
  );

  if (desktop) Object.assign(byName, desktopTools({ root: ROOT, onImage, emit: (event) => onEvent?.(event) }));

  if (!allowShell) {
    delete byName.run_command;
    // Background jobs are shell commands too.
    delete byName.job_output;
    delete byName.job_list;
    delete byName.job_kill;
  }

  // Subagent delegation exists at depth 0 only. Without that cap, a model that
  // likes delegating can recurse until something runs out of memory.
  if (delegate) {
    byName.delegate = {
      description:
        "Hand bounded, self-contained sub-tasks to worker subagents that have the same tools and return short summaries. One task: `task`. Several independent ones at once: `tasks` (up to 8; in a git repo each worker gets its own worktree, and its changes are applied back when it finishes). Use it for independent research or bulk work; do not use it for the next step you could just take.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "A complete, self-contained instruction." },
          tasks: { type: "array", items: { type: "string" }, description: "Several independent instructions, run in parallel." },
          isolation: { type: "string", enum: ["worktree", "shared"], description: "worktree (default for several tasks): each worker edits its own copy. shared: they work in the workspace itself, one after another." },
        },
      },
      async run({ task, tasks, isolation }) {
        const list = Array.isArray(tasks) && tasks.length ? tasks : [task];
        if (!list.some((t) => String(t ?? "").trim())) throw new Error("give `task` or `tasks`");
        return clipForTool("delegate", await delegate(list.map(String), { isolation }), maxOutputChars);
      },
    };
  }

  // Plugin-contributed tools. The plugin host has already validated them and
  // rejected name collisions; this only refuses to shadow a built-in, because a
  // plugin silently replacing `read_file` would be a security bug.
  for (const tool of extraTools) {
    const name = String(tool?.name ?? "").trim();
    if (!name || byName[name] || typeof tool.run !== "function") continue;
    const run = tool.run;
    byName[name] = {
      description: String(tool.description ?? ""),
      parameters: tool.parameters ?? { type: "object", properties: {} },
      // Plugin tools used to hand their output to the model unclipped, so one MCP
      // tool returning a whole document could blow the window in a single step.
      // They get the default profile: an unknown tool is priced pessimistically.
      run: withCache(name, async (args) => clipForTool(name, await run(args), maxOutputChars)),
    };
  }

  return { root: ROOT, byName, schemas: Object.entries(byName).map(([name, t]) => ({ type: "function", function: { name, description: t.description, parameters: t.parameters } })) };
}

/** Run one tool call, converting any throw into a tool result the model can read. */
export async function runToolCall(call, tools) {
  const name = call?.function?.name;
  const started = Date.now();
  let args = {};
  const raw = call?.function?.arguments;
  try {
    args = typeof raw === "string" ? (raw.trim() ? JSON.parse(raw) : {}) : (raw ?? {});
  } catch (err) {
    // The usual cause is not bad JSON but a reply cut off by the output limit mid-call (the
    // arguments stop after the path). Saying so lets the model do the right thing, not guess.
    return {
      name,
      args: raw,
      ok: false,
      ms: Date.now() - started,
      text: `error: arguments were not valid JSON (${err.message}). Send a single JSON object. If the call was long (a whole file), your reply was probably cut off by the output limit: write the file in parts (write_file with the first part, then add the rest with edit_file).`,
    };
  }
  const tool = tools.byName[name];
  if (!tool) {
    return { name, args, ok: false, ms: Date.now() - started, text: `error: unknown tool "${name}". Available: ${Object.keys(tools.byName).join(", ")}` };
  }
  try {
    const text = await tool.run(args);
    return { name, args, ok: true, ms: Date.now() - started, text: String(text ?? "") };
  } catch (err) {
    return { name, args, ok: false, ms: Date.now() - started, text: `error: ${err?.message ?? err}` };
  }
}
