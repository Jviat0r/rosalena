/**
 * Worktrees for delegated workers: several subagents at once, none in another's way.
 *
 * Claude Code runs up to 20 subagents, Grok Build 32, and Oh My Pi isolates each one in
 * its own git worktree. Rosalena's workers shared the one workspace and ran one at a
 * time, so two of them editing the same files would overwrite each other. With
 * `isolation: "worktree"` each worker gets its own checkout:
 *
 *   - it starts from the workspace AS IT IS NOW, uncommitted edits included: `git stash
 *     create` makes a commit of the working tree without touching the stash, the index or
 *     any branch, and the untracked files are copied over. Starting from HEAD would hand
 *     the worker a project missing the work in progress.
 *   - when it finishes, its changes are committed inside the worktree (on a branch of its
 *     own, rosalena/worker-<id>) and applied back to the workspace with `git apply`. A
 *     patch that no longer applies cleanly - another worker got there first - is not
 *     forced: the branch is kept and the answer says how to look at it.
 *   - the worktree folder is removed afterwards; the branch only stays when it was not
 *     applied.
 *
 * Nothing here commits to, checks out or resets the person's own branch.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";

// Installed dependencies are ignored, so a fresh worktree has none and the worker could
// not run the project's tests. They are linked in (a junction on Windows, no admin
// needed), read through, and unlinked before the worktree is removed - removing a tree
// must never follow a link into the real node_modules.
const SHARED_DIRS = ["node_modules", ".venv", "venv"];
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Rosalena worker",
  GIT_AUTHOR_EMAIL: "worker@rosalena.local",
  GIT_COMMITTER_NAME: "Rosalena worker",
  GIT_COMMITTER_EMAIL: "worker@rosalena.local",
};

function git(cwd, args, { input, encoding = "utf8" } = {}) {
  const res = spawnSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding, input, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 120_000, env: { ...process.env, ...IDENTITY } });
  return { ok: res.status === 0, out: res.stdout ?? "", err: String(res.stderr ?? "").trim() || (res.error ? String(res.error.message) : "") };
}

/** The top of the git repository `root` is in, or null. */
export function repoTop(root) {
  const res = git(root, ["rev-parse", "--show-toplevel"]);
  return res.ok ? res.out.trim() : null;
}

/**
 * A worktree for one worker. Returns { path, base, branch, finish() } or { error }.
 * `finish()` commits the worker's changes, applies them to the workspace and cleans up:
 *   { applied: boolean, files: string[], branch: string|null, note: string }
 */
export function createWorkerTree(root, id) {
  const top = repoTop(root);
  if (!top) return { error: "the workspace is not a git repository, so workers cannot get their own worktrees" };
  if (!git(top, ["rev-parse", "--verify", "-q", "HEAD"]).ok) return { error: "the repository has no commits yet" };
  // The working tree as a commit, without touching the stash, index or branches. Empty
  // output means nothing tracked is modified: HEAD is the starting point.
  const stash = git(top, ["stash", "create", "rosalena worker base"]);
  const start = stash.ok && stash.out.trim() ? stash.out.trim() : git(top, ["rev-parse", "HEAD"]).out.trim();
  const safeId = String(id).replace(/[^\w.-]/g, "_");
  const branch = `rosalena/worker-${safeId}`;
  const path = join(mkdtempSync(join(tmpdir(), "rosalena-wt-")), "tree");
  const add = git(top, ["worktree", "add", "-q", "-b", branch, path, start]);
  if (!add.ok) return { error: `git worktree add failed: ${add.err}` };
  // Untracked (not ignored) files are part of the work in progress too.
  const untracked = git(top, ["ls-files", "-z", "--others", "--exclude-standard"]).out.split("\0").filter(Boolean);
  for (const rel of untracked) {
    try {
      const from = join(top, rel);
      if (!statSync(from).isFile()) continue;
      mkdirSync(dirname(join(path, rel)), { recursive: true });
      copyFileSync(from, join(path, rel));
    } catch {
      /* vanished or unreadable: the worker goes without it */
    }
  }
  // The worker's starting point: the copied files included, so the patch back is only
  // what the worker itself did.
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "--allow-empty", "--no-verify", "-m", "rosalena worker: starting point"]);
  const base = git(path, ["rev-parse", "HEAD"]).out.trim();
  // The worker runs in the same subfolder of the repository the workspace is.
  const rel = git(root, ["rev-parse", "--show-prefix"]).out.trim();
  const workRoot = rel ? join(path, rel) : path;

  const links = [];
  for (const dir of new Set([top, root])) {
    for (const name of SHARED_DIRS) {
      const real = join(dir, name);
      const relDir = dir === top ? "" : rel;
      const link = join(path, relDir, name);
      if (!existsSync(real) || existsSync(link)) continue;
      try {
        symlinkSync(real, link, "junction");
        links.push(link);
      } catch {
        /* the worker installs its own if it needs them */
      }
    }
  }

  const unlinkShared = () => {
    for (const link of links) {
      try {
        if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
      } catch {
        /* already gone */
      }
    }
  };
  const cleanup = (keepBranch) => {
    unlinkShared();
    // A link that would not go away means the tree is not removed at all: deleting it
    // could follow the link into the real folder.
    if (links.some((link) => existsSync(link))) return;
    git(top, ["worktree", "remove", "--force", path]);
    try {
      rmSync(dirname(path), { recursive: true, force: true });
    } catch {
      /* a file still open on Windows: the temp folder is swept by the OS */
    }
    git(top, ["worktree", "prune"]);
    if (!keepBranch) git(top, ["branch", "-D", branch]);
  };

  return {
    path: workRoot,
    base,
    branch,
    finish() {
      // The links are not the worker's work, and must never be committed as files.
      unlinkShared();
      git(path, ["add", "-A"]);
      git(path, ["commit", "-q", "--no-verify", "-m", `rosalena worker ${safeId}`]);
      const head = git(path, ["rev-parse", "HEAD"]).out.trim();
      const files = git(path, ["diff", "--name-only", "-z", base, head]).out.split("\0").filter(Boolean);
      if (!files.length) {
        cleanup(false);
        return { applied: true, files: [], branch: null, note: "the worker changed no files" };
      }
      const patch = git(path, ["diff", "--binary", base, head]).out;
      const check = git(top, ["apply", "--check", "--whitespace=nowarn", "-"], { input: patch });
      if (!check.ok) {
        cleanup(true);
        return {
          applied: false,
          files,
          branch,
          note: `its changes no longer apply cleanly to the workspace (${check.err.split("\n")[0]}); they are kept on branch ${branch} - compare with \`git diff HEAD ${branch}\``,
        };
      }
      const apply = git(top, ["apply", "--whitespace=nowarn", "-"], { input: patch });
      cleanup(!apply.ok);
      return apply.ok
        ? { applied: true, files, branch: null, note: `applied ${files.length} changed file(s) to the workspace` }
        : { applied: false, files, branch, note: `applying failed (${apply.err.split("\n")[0]}); the changes are kept on branch ${branch}` };
    },
  };
}

/** Run async jobs with at most `limit` at once, keeping their order in the results. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}
