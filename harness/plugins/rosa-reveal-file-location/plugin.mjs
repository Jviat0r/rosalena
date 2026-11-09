// Reveal a file's location â€” Rosalena's own, headless.
//
// The DSH original is a client-only sidebar plugin: right-click a file tab and
// get "Open file location in Explorer" / "Copy file path". There is no sidebar
// in a headless harness, so the two things it actually did are what port over:
//
//   1. answer "where does this file really live" â€” the absolute path, which in
//      a CLI *is* the "copy path" half (a string handed to the caller). We
//      deliberately do not touch the user's real clipboard for this.
//   2. hand that path to the OS file manager, selecting the file.
//
// The launch is gated twice over, because it is desktop automation:
//   - `allowLaunch` defaults to FALSE, so the agent-facing tool only *reports*
//     the path and the exact command it would run. Nothing opens.
//   - the `/reveal` command launches, because a command only ever runs when the
//     human typed it â€” that keystroke is the grant.
//
// Reveal commands are fixed strings chosen per platform; the path is passed as
// one argv element to spawn() with no shell, so a path can never be read as a
// flag or a second command. See revealCommand() below.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/** `~`, `~/x` and relative paths resolved against the harness root. */
export function expandPath(input, root = process.cwd()) {
  let p = String(input ?? "").trim();
  if (!p) throw new Error("no path given");
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(root, p);
}

/** True when `target` is `root` itself or something inside it. */
export function within(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The OS command that reveals `target`. Pure and platform-injectable, which is
 * what makes the one part of this plugin that touches the desktop testable.
 *
 * Windows: `explorer.exe /select,<file>` selects it in a new window; a folder
 * has no parent window to select it in, so the folder itself is opened.
 */
export function revealCommand(target, { platform = process.platform, isDirectory = false } = {}) {
  if (platform === "win32") {
    return { file: "explorer.exe", args: [isDirectory ? target : `/select,${target}`] };
  }
  if (platform === "darwin") {
    return isDirectory ? { file: "open", args: [target] } : { file: "open", args: ["-R", target] };
  }
  return { file: "xdg-open", args: [isDirectory ? target : dirname(target)] };
}

const quote = (a) => (/[\s"]/.test(a) ? `"${a}"` : a);
const reason = (err) => (err instanceof Error ? err.message : String(err));
export function describeReveal(target, options) {
  const { file, args } = revealCommand(target, options);
  return [file, ...args].map(quote).join(" ");
}

/**
 * The platform a report is written for. On an install this is the machine the harness is
 * running on; `config.platform` is the same seam revealCommand already exposes, so a test
 * (or a support report) can ask "what would this say on Windows" without being on Windows.
 */
function configPlatform(ctx) {
  return ctx?.config?.platform ?? process.platform;
}

/**
 * Resolve, then describe. Throws with a message the caller can show the model,
 * because "that path does not exist" is the single most useful answer here.
 */
export function planReveal(input, { root, platform = process.platform, withinRoot = true } = {}) {
  const target = expandPath(input, root);
  if (withinRoot && root && !within(root, target)) {
    throw new Error(`${target} is outside the workspace (${root}); set plugins.reveal-file-location.config.withinRoot=false to allow it`);
  }
  if (!existsSync(target)) throw new Error(`no such file or directory: ${target}`);
  const isDirectory = statSync(target).isDirectory();
  return { target, isDirectory, command: describeReveal(target, { platform, isDirectory }) };
}

function launch(target, { platform = process.platform, isDirectory = false } = {}) {
  const { file, args } = revealCommand(target, { platform, isDirectory });
  // detached + unref: the file manager is the user's window, not our child, so
  // it must outlive the harness and must not hold the event loop open.
  const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return child.pid;
}

export default {
  id: "rosa-reveal-file-location",
  description: "Resolve a file's real path, and select it in the OS file manager when allowed.",
  tools(ctx) {
    return [
      {
        name: "reveal_file",
        description:
          "Resolve a file or folder to its absolute path and show the command that would select it in the OS file manager. " +
          "Does not open anything unless this plugin is configured with allowLaunch: true.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File or folder path; relative paths resolve against the workspace root." } },
          required: ["path"],
        },
        run: async ({ path }) => {
          const { target, isDirectory, command } = planReveal(path, { root: ctx.root, withinRoot: ctx.config?.withinRoot !== false, platform: configPlatform(ctx) });
          const kind = isDirectory ? "folder" : "file";
          if (ctx.config?.allowLaunch !== true) {
            return `${kind}: ${target}\ncommand that would open it: ${command}\n(launch is disabled; set plugins.reveal-file-location.config.allowLaunch=true in harness.config.json, or run /reveal-file-location reveal ${target})`;
          }
          launch(target, { isDirectory, platform: configPlatform(ctx) });
          return `${kind}: ${target}\nopened with: ${command}`;
        },
      },
    ];
  },
  commands(ctx) {
    const help = [
      "/reveal-file-location reveal <path>   open the OS file manager with the path selected",
      "/reveal-file-location path <path>     print the resolved absolute path only",
      "  launch from a command is allowed because a command only runs when you type it;",
      `  the agent-facing reveal_file tool stays report-only until allowLaunch=true${ctx.config?.allowLaunch === true ? " (currently true)" : ""}.`,
    ].join("\n");
    return {
      reveal: (argv) => {
        const arg = argv.join(" ").trim();
        if (!arg) return help;
        try {
          const { target, isDirectory, command } = planReveal(arg, { root: ctx.root, withinRoot: ctx.config?.withinRoot !== false, platform: configPlatform(ctx) });
          const pid = launch(target, { isDirectory, platform: configPlatform(ctx) });
          return `opened ${target} (${command}) as pid ${pid}`;
        } catch (err) {
          return reason(err);
        }
      },
      path: (argv) => {
        const arg = argv.join(" ").trim();
        if (!arg) return help;
        try {
          return planReveal(arg, { root: ctx.root, withinRoot: ctx.config?.withinRoot !== false, platform: configPlatform(ctx) }).target;
        } catch (err) {
          return reason(err);
        }
      },
    };
  },
  status: (ctx) =>
    ctx.config?.allowLaunch === true
      ? `launches the file manager on request${ctx.config?.withinRoot === false ? ", any path" : ", workspace paths only"}`
      : "report-only (allowLaunch=false)",
};
