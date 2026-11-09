// Path confinement for code-intel: the same rule as src/tools.mjs `inside()` (resolve the
// path against the workspace root and refuse anything that lands outside it), plus one
// more check tools.mjs does not make: the real path. A junction or symlink inside the
// workspace that points at C:\Windows resolves "inside" by name and outside in fact, so
// the nearest existing ancestor is realpath'd and must still be under the real root.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const within = (base, abs) => {
  const rel = relative(base, abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/** The real path of `abs`, or of its nearest existing ancestor joined with the rest. */
function realOf(abs) {
  let probe = abs;
  const tail = [];
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) break;
    tail.unshift(relative(up, probe));
    probe = up;
  }
  return resolve(real(probe), ...tail);
}

/**
 * Resolve `p` against `root` and return the absolute path, or throw a refusal the model
 * can read. Never returns a path outside the workspace, by name or through a link.
 */
export function confine(root, p) {
  if (!root) throw new Error("refused: no workspace is open, so there is nowhere to read or write");
  const ROOT = resolve(root);
  const raw = String(p ?? "").trim();
  if (!raw) throw new Error("refused: path is empty. Give a file path relative to the workspace");
  const abs = resolve(ROOT, raw);
  if (!within(ROOT, abs)) throw new Error(`refused: "${raw}" resolves outside the workspace root (${ROOT})`);
  if (!within(real(ROOT), realOf(abs))) {
    throw new Error(`refused: "${raw}" goes through a link that points outside the workspace root (${ROOT})`);
  }
  return abs;
}

/** The workspace-relative form of an absolute path, with forward slashes, for output. */
export function rel(root, abs) {
  const r = relative(resolve(root), abs).replace(/\\/g, "/");
  return r || ".";
}

/** Is `abs` inside the workspace (by name and by real path)? Never throws. */
export function isInside(root, abs) {
  try {
    confine(root, abs);
    return true;
  } catch {
    return false;
  }
}
