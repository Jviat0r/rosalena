/**
 * "Show in File Explorer" - the one place this app asks the operating system to open a
 * window on the user's desktop.
 *
 * Three rules, because a path from a transcript is not a trusted instruction:
 *
 *   1. The path must already exist. A reveal on a file that was never written is a lie
 *      the file manager would hide by opening the nearest folder that does exist.
 *   2. The path must resolve inside the harness workspace. A tool argument or a run
 *      record can name anything on the disk; opening an arbitrary UNC path or a folder
 *      full of credentials because a model printed it is not a feature.
 *   3. The command is spawned with an argument array. No string is ever handed to a
 *      shell, so a path containing quotes, `&` or `%PATH%` is a path, not a command.
 *
 * The function never throws: every refusal is `{ ok: false, error }`, because the caller
 * is an HTTP route that has to answer something a person can read.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const message = (err) => String(err?.message ?? err ?? "unknown error");

/**
 * Is `target` the workspace itself, or below it?
 *
 * `relative()` is used rather than a string prefix so `C:\ws-other` is not mistaken for
 * a child of `C:\ws`; on win32 that comparison is case-insensitive, which is what the
 * file system does too.
 */
function inside(target, workspace) {
  const rel = relative(workspace, target);
  if (!rel) return true; // the workspace itself
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return true;
}

/**
 * Everything that can be decided without touching the process table: is there a path,
 * does it exist, and is it allowed? Exported so a test (or a future route) can answer
 * "would this be refused" without opening a window.
 */
export function checkRevealPath({ path, workspace, platform = process.platform } = {}) {
  const raw = String(path ?? "").trim();
  if (!raw) return { ok: false, error: "no path was given" };

  const root = String(workspace ?? "").trim();
  if (!root) return { ok: false, error: "the server has no workspace to compare the path against" };

  // A relative path is resolved against the workspace, which is also what the file
  // tools do: "src/app.js" in a transcript means the workspace's own file. An absolute
  // path wins over the base on every platform, so the check below is the whole test.
  const ws = resolve(root);
  const target = resolve(ws, raw);

  if (!inside(target, ws)) {
    return { ok: false, error: `"${target}" is outside the workspace (${ws})` };
  }
  if (!existsSync(target)) {
    return { ok: false, error: `"${target}" does not exist` };
  }
  let stat;
  try {
    stat = statSync(target);
  } catch (err) {
    return { ok: false, error: `"${target}" cannot be read: ${message(err)}` };
  }
  return { ok: true, path: target, workspace: ws, isDir: stat.isDirectory() };
}

/**
 * The command each platform wants, as data. `explorer.exe /select,<path>` is the only
 * form Windows supports for "open the folder and select this"; Explorer's own exit code
 * is meaningless (it returns 1 even when the window opens), which is why the launcher
 * watches for `spawn` and `error` rather than for an exit status.
 */
export function revealCommand({ path, isDir = false, open = false, platform = process.platform } = {}) {
  // `open`: show a folder's own contents (a sidebar folder tab's "Open"), not the folder
  // selected inside its parent. Files are always revealed, never opened.
  if (open && isDir) {
    if (platform === "win32") return { command: "explorer.exe", args: [path] };
    if (platform === "darwin") return { command: "open", args: [path] };
    return { command: "xdg-open", args: [path] };
  }
  if (platform === "win32") return { command: "explorer.exe", args: [`/select,${path}`] };
  if (platform === "darwin") return { command: "open", args: ["-R", path] };
  // No mainstream Linux file manager has a portable "select this file": opening the
  // containing folder is the honest equivalent.
  return { command: "xdg-open", args: [isDir ? path : dirname(path)] };
}

/** Start it detached and report whether the process was created. Never rejects. */
function launch(command, args, spawnImpl) {
  return new Promise((done) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      done(result);
    };
    let child;
    try {
      child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch (err) {
      finish({ ok: false, command, args, error: `${command} could not be started: ${message(err)}` });
      return;
    }
    if (!child || typeof child.once !== "function") {
      // A stub with no events still means "the call was made".
      finish({ ok: true, command, args });
      return;
    }
    child.once("error", (err) => {
      finish({ ok: false, command, args, error: `${command} could not be started: ${message(err)}` });
    });
    child.once("spawn", () => {
      try {
        child.unref?.();
      } catch {
        /* an unrefused child is still a started window */
      }
      finish({ ok: true, command, args });
    });
  });
}

/**
 * Open the OS file manager on `path`, selecting it where the platform can.
 *
 * `spawnImpl` and `platform` exist for the tests: no test may open a window, and the
 * darwin and linux argument shapes have to be checkable on Windows.
 */
export async function revealInFileManager({ path, workspace, open = false, platform = process.platform, spawnImpl = nodeSpawn } = {}) {
  const check = checkRevealPath({ path, workspace, platform });
  if (!check.ok) return check;
  const { command, args } = revealCommand({ path: check.path, isDir: check.isDir, open: open === true, platform });
  const launched = await launch(command, args, spawnImpl);
  if (!launched.ok) return launched;
  return { ok: true, path: check.path, isDir: check.isDir, command, args };
}

export default { checkRevealPath, revealCommand, revealInFileManager };
