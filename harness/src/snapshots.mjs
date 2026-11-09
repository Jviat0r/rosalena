/**
 * Snapshots that cover what shell commands change, so undo is not limited to the file tools.
 *
 * The file journal (undo.mjs) copies a file before write_file/edit_file change it. A shell
 * command - `npm init`, a codemod, `rm -rf dist`, a formatter run by hand - changes files
 * the harness never sees, and Claude Code's `/rewind` documents the same gap. Codex closes
 * it with "ghost commits"; this does the same, in a SHADOW repository:
 *
 *   - its own git dir under <ROSALENA_HOME>/snapshots/<hash of the workspace path>.git, with
 *     the workspace as its work tree. The project's own .git, index, branches and stash are
 *     never touched, and a folder that is not a git repo is covered too.
 *   - a per-run index, so each snapshot only re-hashes what changed since the last one.
 *   - a snapshot is a tree plus a commit under refs/rosalena/<run id>; nothing is checked out.
 *   - left out: what the workspace's .gitignore leaves out, the usual heavy folders
 *     (node_modules, virtualenvs, build caches), `.env*` files, and files over 10 MiB.
 *     More than MAX_FILES candidate files and the snapshot is skipped, with the reason.
 *   - line endings and filters are off (`* -text` in info/attributes, autocrlf false), so a
 *     restore writes back exactly the bytes that were there.
 *
 * The loop takes one before and one after each step that runs a changing command, which
 * records exactly which files that step's commands changed; undo.mjs restores them.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { rosalenaHome } from "./memory.mjs";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 20_000;
const EXCLUDES = [
  ".git/",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".cache/",
  ".parcel-cache/",
  ".gradle/",
  "target/debug/",
  "target/release/",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
];

export const snapshotsRoot = () => join(rosalenaHome(), "snapshots");

/** The shadow git dir for one workspace (stable across runs and restarts). */
export function shadowDir(root, home = snapshotsRoot()) {
  const key = createHash("sha1").update(resolve(root).toLowerCase()).digest("hex").slice(0, 16);
  return join(home, `${key}.git`);
}

function gitIn({ gitDir, root, index }, args, { input, encoding = "utf8" } = {}) {
  const res = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.quotepath=false", ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: root,
      ...(index ? { GIT_INDEX_FILE: index } : {}),
      GIT_OPTIONAL_LOCKS: "0",
      // Snapshot commits need an author, and must not depend on the person's git config.
      GIT_AUTHOR_NAME: "Rosalena snapshots",
      GIT_AUTHOR_EMAIL: "snapshots@rosalena.local",
      GIT_COMMITTER_NAME: "Rosalena snapshots",
      GIT_COMMITTER_EMAIL: "snapshots@rosalena.local",
    },
    encoding,
    input,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  return { ok: res.status === 0, out: res.stdout ?? (encoding ? "" : Buffer.alloc(0)), err: String(res.stderr ?? "").trim() || (res.error ? String(res.error.message) : "") };
}

/** Create the shadow repository the first time a workspace is snapshotted. */
function ensureShadow(gitDir, root) {
  if (existsSync(join(gitDir, "HEAD"))) return { ok: true };
  mkdirSync(gitDir, { recursive: true });
  const init = spawnSync("git", ["init", "--bare", "-q", gitDir], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) return { ok: false, err: String(init.stderr ?? init.error?.message ?? "git init failed").trim() };
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "exclude"), `${EXCLUDES.join("\n")}\n`);
  // Highest-precedence attributes: no eol conversion or filters, whatever the project says.
  writeFileSync(join(gitDir, "info", "attributes"), "* -text -filter -diff\n");
  writeFileSync(join(gitDir, "workspace"), `${resolve(root)}\n`);
  return { ok: true };
}

/**
 * Shadow repositories are disposable: one whose workspace is gone, or that nothing has
 * used for 14 days (the undo journals' lifetime), is removed. Once per process.
 */
let swept = false;
export function sweepShadows(home = snapshotsRoot(), { now = Date.now(), maxAgeMs = 14 * 24 * 3600 * 1000 } = {}) {
  const removed = [];
  let names = [];
  try {
    names = readdirSync(home).filter((n) => n.endsWith(".git"));
  } catch {
    return removed;
  }
  for (const name of names) {
    const gitDir = join(home, name);
    try {
      const workspace = readFileSync(join(gitDir, "workspace"), "utf8").trim();
      const used = statSync(join(gitDir, "index-runs")).mtimeMs;
      if (!existsSync(workspace) || now - used > maxAgeMs) {
        rmSync(gitDir, { recursive: true, force: true });
        removed.push(gitDir);
      }
    } catch {
      /* half-made or in use: leave it */
    }
  }
  return removed;
}

/**
 * One run's snapshotter. `take(label)` returns { commit, files } or { skipped: reason }.
 * Never throws: a snapshot that cannot be taken must not stop the step.
 */
export function createSnapshots({ root, runId, home = snapshotsRoot(), dir = null }) {
  if (!swept) {
    swept = true;
    try {
      sweepShadows(home);
    } catch {
      /* best effort */
    }
  }
  const top = resolve(root);
  const gitDir = shadowDir(top, home);
  const index = join(gitDir, "index-runs", `${String(runId).replace(/[^\w.-]/g, "_")}`);
  const ref = `refs/rosalena/${String(runId).replace(/[^\w.-]/g, "_")}`;
  const g = (args, opts) => gitIn({ gitDir, root: top, index }, args, opts);
  let parent = null;
  let disabled = null;

  const take = (label) => {
    if (disabled) return { skipped: disabled };
    try {
      const made = ensureShadow(gitDir, top);
      if (!made.ok) return { skipped: (disabled = `no shadow repository: ${made.err}`) };
      mkdirSync(dirname(index), { recursive: true });
      // Candidates: tracked files that changed or vanished, plus untracked ones not excluded.
      const listed = g(["ls-files", "-z", "--cached", "--others", "--deleted", "--modified", "--exclude-standard"]);
      if (!listed.ok) return { skipped: `git ls-files failed: ${listed.err}` };
      const names = [...new Set(listed.out.split("\0").filter(Boolean))];
      if (names.length > MAX_FILES) return { skipped: (disabled = `the workspace has more than ${MAX_FILES} files to track; snapshots are off for this run`) };
      const keep = [];
      const gone = [];
      for (const name of names) {
        try {
          const st = lstatSync(join(top, name));
          if (st.isFile() && st.size <= MAX_FILE_BYTES) keep.push(name);
          else if (!st.isFile() && !st.isSymbolicLink()) gone.push(name);
        } catch {
          gone.push(name);
        }
      }
      if (gone.length) g(["rm", "-q", "--cached", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: gone.join("\0") });
      if (keep.length) {
        const add = g(["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: keep.join("\0") });
        if (!add.ok) return { skipped: `git add failed: ${add.err.slice(0, 300)}` };
      }
      const tree = g(["write-tree"]);
      if (!tree.ok) return { skipped: `git write-tree failed: ${tree.err}` };
      const commit = g(["commit-tree", tree.out.trim(), ...(parent ? ["-p", parent] : []), "-m", String(label)], {
        input: undefined,
      });
      if (!commit.ok) return { skipped: `git commit-tree failed: ${commit.err}` };
      const sha = commit.out.trim();
      g(["update-ref", ref, sha]);
      const files = parent ? changedBetween(gitDir, top, parent, sha) : [];
      parent = sha;
      return { commit: sha, files };
    } catch (err) {
      return { skipped: String(err?.message ?? err) };
    }
  };

  return {
    gitDir,
    ref,
    take,
    /** Snapshot around one step: call `before`, run the step, call `after`. Records the pair. */
    before(step) {
      const shot = take(`before step ${step}`);
      return shot;
    },
    after(step, before) {
      const shot = take(`after step ${step}`);
      if (dir && before?.commit && shot.commit) {
        try {
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, "snapshots.jsonl"), `${JSON.stringify({ step, gitDir, root: top, before: before.commit, after: shot.commit, files: shot.files, at: Date.now() })}\n`);
        } catch {
          /* undo will have less to offer; the step itself is unaffected */
        }
      }
      return shot;
    },
  };
}

/** Paths that differ between two snapshots: [{ status: "A"|"M"|"D", path }]. */
export function changedBetween(gitDir, root, a, b) {
  const res = gitIn({ gitDir, root }, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", a, b]);
  if (!res.ok) return [];
  const parts = res.out.split("\0").filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
  return out;
}

/**
 * Put the files a snapshot pair changed back to how they were BEFORE it. A file the step
 * created is removed; a file it changed or deleted gets its old bytes back. Only the
 * paths the pair recorded are touched.
 */
export function restoreBefore({ gitDir, root, before, files }) {
  const restored = [];
  const removed = [];
  const failed = [];
  for (const { status, path } of files ?? []) {
    const abs = join(root, path);
    try {
      if (status === "A") {
        if (existsSync(abs)) {
          rmSync(abs, { force: true });
          removed.push(abs);
        }
        continue;
      }
      const blob = gitIn({ gitDir, root }, ["cat-file", "blob", `${before}:${path}`], { encoding: null });
      if (!blob.ok) throw new Error(blob.err || "not in the snapshot");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, blob.out);
      restored.push(abs);
    } catch (err) {
      failed.push(`${abs}: ${err.message}`);
    }
  }
  return { restored, removed, failed };
}

/** The snapshot pairs a run recorded, oldest first. */
export function readSnapshotLog(dir) {
  const file = join(dir, "snapshots.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
