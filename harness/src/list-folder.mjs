/**
 * One folder's listing for the Files panel (the workspace's Files tab and the sidebar's
 * folder tabs, which can point anywhere on the PC).
 *
 * Asynchronous on purpose: a folder tab can sit on a network share that has gone offline,
 * and a synchronous stat there stalls the whole server for the length of the SMB timeout.
 *
 * Capped for real: a folder like C:\Windows\System32 has thousands of entries, and the
 * panel draws one row each. Folders come first, then files, by name; past the cap the
 * answer says `truncated` and only the first `cap` entries are sent (and only those are
 * stat'ed).
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const LIST_CAP = 2000;

/**
 * Is `target` the root itself or below it? ".." counts only as a whole path segment, so a
 * folder named "..cache" inside the root is still inside.
 */
export function insideRoot(root, target) {
  const rel = relative(root, target);
  if (!rel) return true;
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** The folder `value` names, made absolute, or null when it is not a folder that exists. */
export async function existingFolder(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const full = resolve(text);
  try {
    return (await stat(full)).isDirectory() ? full : null;
  } catch {
    return null;
  }
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** Run `work` over `items`, at most `limit` at a time (thousands of stats at once can hit EMFILE). */
async function eachLimited(items, limit, work) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      await work(items[at], at);
    }
  });
  await Promise.all(lanes);
}

/**
 * List `requested` (relative to `root`). Answers `{ status, body }` with the body the
 * /api/files route has always sent: root, path, parent, dirs, files, truncated.
 */
export async function listFolder(root, requested = "", { cap = LIST_CAP } = {}) {
  const target = resolve(root, String(requested ?? ""));
  const rel = relative(root, target);
  if (!insideRoot(root, target)) {
    return { status: 403, body: { error: "outside the workspace", root, path: null, dirs: [], files: [] } };
  }
  let entries;
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return { status: 400, body: { error: "not a directory", root, path: rel, dirs: [], files: [] } };
    entries = await readdir(target, { withFileTypes: true });
  } catch (err) {
    return { status: 404, body: { error: `cannot list ${rel || "."}: ${err?.code ?? err?.message ?? err}`, root, path: rel, dirs: [], files: [] } };
  }

  // A link (a Windows junction such as a folder shortcut made with mklink /J, or a
  // symlink) is sorted by what it points at, so a linked folder opens like a folder
  // instead of showing up as a file that cannot be read.
  const rows = entries.map((entry) => ({ entry, name: entry.name, link: entry.isSymbolicLink(), dir: entry.isDirectory(), size: null, at: null }));
  await eachLimited(
    rows.filter((row) => row.link),
    32,
    async (row) => {
      try {
        row.dir = (await stat(join(target, row.name))).isDirectory();
      } catch {
        /* a broken link stays a file row with its name */
      }
    },
  );
  const dirs = rows.filter((row) => row.dir).sort(byName);
  const files = rows.filter((row) => !row.dir).sort(byName);
  const truncated = dirs.length + files.length > cap;
  const keptDirs = dirs.slice(0, cap);
  const keptFiles = files.slice(0, Math.max(0, cap - keptDirs.length));

  await eachLimited([...keptDirs, ...keptFiles], 64, async (row) => {
    try {
      const info = await stat(join(target, row.name));
      row.at = info.mtimeMs ? new Date(info.mtimeMs).toISOString() : null;
      row.size = info.isDirectory() ? null : info.size;
    } catch {
      // A file that vanished or is locked is still worth showing as a name.
    }
  });

  return {
    status: 200,
    body: {
      root,
      path: rel,
      parent: rel === "" ? null : dirname(rel) === "." ? "" : dirname(rel),
      dirs: keptDirs.map(({ name, link, at }) => ({ name, link, at })),
      files: keptFiles.map(({ name, size, at, link }) => ({ name, size, at, link })),
      truncated,
    },
  };
}
