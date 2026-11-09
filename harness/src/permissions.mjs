/**
 * What a run may do without asking: the access mode, the approval rules, and the plan
 * mode gate. Ported from OpenCode's permission model (allow / ask / deny per tool and per
 * command pattern) and DSH's plan mode.
 *
 * Access modes (the composer's menu):
 *   full       everything is allowed, except what a rule says to ask about or deny
 *   workspace  files inside the workspace can be changed; a shell command that names a
 *              path outside it, and plugin actions that act on the machine (VPN, Wi-Fi,
 *              loading models, MCP calls), ask first
 *   read       nothing may change: writes, edits and any command that is not plainly a
 *              read are refused, with the reason, so the model can still investigate
 *
 * Read only (and plan mode) refuses a change before any rule is looked at; otherwise rules
 * are checked before the mode, first match wins. A rule is
 *   { tool: "run_command" | "read_file" | ... | "*", pattern: "*SendKeys*", action: "ask" }
 * and the pattern is matched (case-insensitive, `*` = anything) against the call's
 * subject: the command for run_command, the path for file tools, the URL for web tools,
 * the arguments as JSON for anything else.
 *
 * "Always allow" from the approval card is remembered for the rest of that chat only.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Commands that only look: listing, printing, searching, version control reads, and the
 * pure filters a read is piped through (sort, wc, Select-Object...). Not awk, sed or
 * ForEach-Object: each can run or write things. `where` is anchored so Where-Object (a
 * script block) is not mistaken for where.exe.
 */
const READ_ONLY_COMMAND = /^\s*(?:(?:dir|type|more|findstr|echo|ls|cat|head|tail|grep|rg|find|tree|sort|uniq|wc|cut|git\s+(?:status|log|diff|show|branch|remote)|node\s+--version|npm\s+(?:ls|view)|Get-ChildItem|Get-Content|Select-String|Select-Object|Sort-Object|Measure-Object|Group-Object|Format-Table|Format-List|Out-String)\b|where(?:\.exe)?(?=\s|$))/i;

/**
 * A read command used in a way that writes or runs something: find -delete/-exec,
 * branch or remote changes, --output files, rg --pre (runs a program per file), tree -o.
 */
function readCommandWrites(part) {
  const p = part.trim();
  if (/^find\b/i.test(p)) return /\s-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/i.test(p);
  if (/^git\s+(?:diff|log|show)\b/i.test(p)) return /\s--output\b/i.test(p);
  if (/^rg\b/i.test(p)) return /\s--pre\b/i.test(p);
  if (/^tree\b/i.test(p)) return /\s-o\b/.test(p);
  if (/^git\s+remote\b/i.test(p)) return !/^git\s+remote(?:\s+(?:-v|--verbose|show\b.*|get-url\b.*))?\s*$/i.test(p);
  if (/^git\s+branch\b/i.test(p)) {
    const args = p.replace(/^git\s+branch\b/i, "").trim().split(/\s+/).filter(Boolean);
    if (args.some((a) => /^(?:-[dDmMcCfu]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track)\b)/.test(a))) return true;
    const listing = args.some((a) => /^(?:-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)\b/.test(a));
    return !listing && args.some((a) => !a.startsWith("-")); // `git branch name` creates one
  }
  return false;
}

/**
 * The command with quoted text blanked out, so `grep -E "a|b"` is one command and
 * `echo "x > y"` is not a redirect. Unbalanced quotes leave the rest as it is.
 */
function unquoted(command) {
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (m) => m[0] + m[0]);
}
const LOOK_ONLY_TOOLS = new Set([
  "read_file", "list_dir", "search", "glob", "recall", "todo_write", "todo_read", "leftover_processes",
  "web_fetch", "web_search", "job_output", "job_list", "session_search", "skill", "read_image",
  // Creator mode's readers: a draft file, and the list of plugins and drafts.
  "creator_read", "creator_status",
  // code-intel's readers: hashed lines, structural search, the language server's answers.
  "read_hashed", "ast_search", "lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics", "lsp_symbols",
  // The browser plugin's looking tools. Opening a page fetches it, the same as web_fetch;
  // the screenshot lands in the workspace's own .rosalena folder. Clicking, filling and
  // uploading are actions and are not here.
  "browser_open", "browser_snapshot", "browser_read", "browser_console", "browser_screenshot", "browser_scroll", "browser_close",
  // Desktop control's looking tools. Moving the pointer, clicking, dragging, scrolling and
  // typing are actions (a hover can open a menu), so they are not here.
  "desktop_screenshot", "desktop_zoom", "desktop_windows", "desktop_wait",
]);
// Tools that only preview unless asked to apply: a dry run is a read.
const PREVIEW_UNLESS_APPLY = new Set(["ast_rewrite", "lsp_rename"]);

/**
 * Did this tool call (possibly) change something? File writes and edits do, a delegated
 * task may, and a shell command does unless it is plainly a read. Plugin tools are given
 * the benefit of the doubt: an unknown tool counts as action.
 */
export function changesSomething(call) {
  const name = call?.function?.name ?? call?.name ?? "";
  if (LOOK_ONLY_TOOLS.has(name)) return false;
  if (PREVIEW_UNLESS_APPLY.has(name)) {
    try {
      return JSON.parse(call?.function?.arguments ?? "{}")?.apply === true;
    } catch {
      return true;
    }
  }
  if (name === "run_command") {
    let command = "";
    try {
      command = String(JSON.parse(call?.function?.arguments ?? "{}")?.command ?? "");
    } catch {
      command = String(call?.function?.arguments ?? "");
    }
    // Substitutions run a command wherever they appear, quoted or not ($(...), `...`,
    // <(...)), and so does a line break.
    if (/\$\(|`|<\(|[\r\n]/.test(command)) return true;
    const bare = unquoted(command);
    // A script block outside quotes (Where-Object { Remove-Item ... }) can do anything.
    if (/\{/.test(bare)) return true;
    // Output sent to a file is a write, whatever printed it; sending it to nul is not.
    const redirects = bare.replace(/\d?>\s*&\d|\d?>\s*nul\b|\d?>\s*\/dev\/null/gi, "");
    if (/>/.test(redirects)) return true;
    // Every part of a chained or piped read has to be a read: "dir && del x" and
    // "cat list | xargs rm" change something; "git log | wc -l" does not.
    const parts = redirects.split(/&&|\|\||;|&|\|/).map((part) => part.trim()).filter(Boolean);
    return !parts.length || !parts.every((part) => (READ_ONLY_COMMAND.test(part) && !readCommandWrites(part)) || /^cd\s/i.test(part));
  }
  return true;
}

export const ACCESS_MODES = Object.freeze(["full", "workspace", "auto", "read"]);
export const DEFAULT_ACCESS_MODE = "workspace";

/** The rules every install starts with. They only ever ask; nothing is denied by default. */
export const DEFAULT_RULES = Object.freeze([
  // Driving other apps' windows: keys, clicks and focus.
  ...["*SendKeys*", "*SendInput*", "*keybd_event*", "*mouse_event*", "*SetCursorPos*", "*SetForegroundWindow*", "*PostMessage*"].map((pattern) => ({
    tool: "run_command",
    pattern,
    action: "ask",
    why: "it controls other apps' keyboard, mouse or windows",
  })),
  // Installing whatever is newest today.
  { tool: "run_command", pattern: "*@latest*", action: "ask", why: "it installs or runs the newest version of a package, unpinned" },
  // Destroying things.
  { tool: "run_command", pattern: "*rm -rf*", action: "ask", why: "it deletes a folder tree" },
  { tool: "run_command", pattern: "*Remove-Item*-Recurse*", action: "ask", why: "it deletes a folder tree" },
  { tool: "run_command", pattern: "*rmdir /s*", action: "ask", why: "it deletes a folder tree" },
  { tool: "run_command", pattern: "*del /s*", action: "ask", why: "it deletes files in every subfolder" },
  { tool: "run_command", pattern: "*git push*--force*", action: "ask", why: "it rewrites the remote's history" },
  // Any push publishes: on a repo whose host deploys on push it is a deploy. It is never a
  // local change, so Workspace write would otherwise let it through without asking.
  { tool: "run_command", pattern: "*git push*", action: "ask", why: "it publishes commits to the remote (and may deploy)" },
  { tool: "run_command", pattern: "*git -C * push*", action: "ask", why: "it publishes commits to the remote (and may deploy)" },
  { tool: "run_command", pattern: "*git reset --hard*", action: "ask", why: "it throws away uncommitted work" },
  { tool: "run_command", pattern: "*git clean -*f*", action: "ask", why: "it deletes untracked files" },
  { tool: "run_command", pattern: "*format *:*", action: "ask", why: "it formats a drive" },
  // Secrets.
  { tool: "read_file", pattern: "*.env", action: "ask", why: "it reads a secrets file" },
  { tool: "read_file", pattern: "*.env.*", action: "ask", why: "it reads a secrets file" },
  { tool: "read_file", pattern: "*.pem", action: "ask", why: "it reads a private key" },
  { tool: "read_file", pattern: "*id_rsa*", action: "ask", why: "it reads a private key" },
  // Moving or deleting a secrets file (a rename would otherwise dodge the read rules above).
  ...["*.env", "*.env.*", "*.pem", "*id_rsa*"].flatMap((pattern) => [
    { tool: "move_file", pattern, action: "ask", why: "it moves or renames a secrets file" },
    { tool: "delete_file", pattern, action: "ask", why: "it deletes a secrets file" },
  ]),
]);

/** Tools that never change anything, whatever their name suggests to the classifier. */
const NEVER_A_CHANGE = new Set(["ask_user", "present", "exit_plan_mode", "todo_write", "todo_read", "remember", "goal_update", "goal_state"]);
/**
 * Built-in tools whose effects stay in the workspace (or are the run's own business).
 * Creator mode's draft tools are here too: they can only touch <home>/creator/drafts and
 * its reports (creator.mjs refuses any other path), so in Workspace write they work like
 * writing a project file. creator_publish and creator_rollback are not: they change what
 * is installed in the sidebar, so they ask, even though both are verified and reversible.
 */
const WORKSPACE_TOOLS = new Set(["write_file", "edit_file", "move_file", "delete_file", "run_command", "job_kill", "delegate", "creator_new", "creator_write", "creator_files", "creator_verify"]);

/**
 * A plugin tool whose effects stay inside the workspace (commit-cadence's `checkpoint`
 * only runs git in the workspace repo) registers here from its setup(), so Workspace
 * write treats it like edit_file instead of asking as if it acted on the machine. Read
 * only and plan mode still refuse it.
 */
export function registerWorkspaceTool(name) {
  if (typeof name === "string" && name.trim()) WORKSPACE_TOOLS.add(name.trim());
}

const parseArgs = (call) => {
  const raw = call?.function?.arguments ?? call?.arguments;
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
};

/** What a rule's pattern is matched against, for one call. */
export function subjectOf(name, args) {
  if (name === "run_command") return String(args?.command ?? "");
  if (name === "move_file") return `${args?.from ?? "?"} -> ${args?.to ?? "?"}`;
  if (typeof args?.path === "string") return args.path;
  if (typeof args?.url === "string") return args.url;
  if (typeof args?.query === "string") return args.query;
  return JSON.stringify(args ?? {});
}

/** A `*` wildcard pattern as a case-insensitive matcher over the whole subject. */
export function wildcard(pattern) {
  const body = String(pattern).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}$`, "is");
}

/** Absolute paths (and ../ escapes) a command names that resolve outside `root`. */
export function outsidePaths(command, root, platform = process.platform) {
  const base = resolve(root);
  const found = [];
  const text = String(command);
  const candidates = [
    ...text.matchAll(/(?:^|[\s"'=(])([A-Za-z]:[\\/][^\s"'|&;<>]*)/g),
    ...text.matchAll(/(?:^|[\s"'=(])(\\\\[^\s"'|&;<>]+)/g),
    ...text.matchAll(/(?:^|[\s"'=(])((?:\.\.[\\/])+[^\s"'|&;<>]*)/g),
    ...text.matchAll(/(?:^|[\s"'=(])(~[\\/][^\s"'|&;<>]*)/g),
    // A POSIX absolute path. Not on Windows, where "/b" is a switch (dir /b), not a path.
    ...(platform === "win32" ? [] : [...text.matchAll(/(?:^|[\s"'=(])(\/[^\s"'|&;<>]+)/g)]),
  ].map((m) => m[1]);
  for (const raw of candidates) {
    const cleaned = raw.replace(/[),]+$/, "");
    const abs = cleaned.startsWith("~") ? join(homedir(), cleaned.slice(2)) : resolve(base, cleaned);
    const rel = relative(base, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) found.push(cleaned);
  }
  return [...new Set(found)];
}

/** The person's own rules, from ~/.rosalena/permissions.json: { "rules": [...] }. */
export function userRules(file = join(process.env.ROSALENA_HOME || join(homedir(), ".rosalena"), "permissions.json")) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return (Array.isArray(parsed?.rules) ? parsed.rules : []).filter((r) => r && typeof r.pattern === "string" && ["allow", "ask", "deny"].includes(r.action));
  } catch {
    return [];
  }
}

/**
 * The verdict for one call.
 * @returns {{ action: "allow" | "ask" | "deny", reason: string, subject: string }}
 */
export function decide({ call, mode = DEFAULT_ACCESS_MODE, root, rules = DEFAULT_RULES, allowed = new Set(), planning = false }) {
  const name = call?.function?.name ?? call?.name ?? "";
  const args = parseArgs(call);
  const subject = subjectOf(name, args);
  const effective = planning ? "read" : mode;

  // Read only and plan mode come before the rules: a rule may ask or deny a read, but no
  // rule (an "always allow", a user's allow-all, a built-in ask) can let a change through.
  if (effective === "read" && !NEVER_A_CHANGE.has(name) && changesSomething(call)) {
    return {
      action: "deny",
      reason: planning
        ? "plan mode is read-only until the user approves a plan: investigate, then call exit_plan_mode with the plan"
        : "the chat is in Read only mode, so nothing may be changed. Investigate and report instead",
      subject,
    };
  }

  // move_file names two paths: a rule about either one applies (a rule on ".env" must not
  // be dodged by renaming the file first).
  const subjects = name === "move_file" ? [args?.from, args?.to].filter((s) => typeof s === "string") : [subject];
  for (const rule of rules) {
    const toolMatches = !rule.tool || rule.tool === "*" || rule.tool === name;
    const pattern = wildcard(rule.pattern);
    if (!toolMatches || !subjects.some((s) => pattern.test(s))) continue;
    if (rule.action === "ask" && allowed.has(`${name}\u0000${rule.pattern}`)) break;
    if (rule.action === "allow") return { action: "allow", reason: "an approval rule allows it", subject };
    return { action: rule.action, reason: rule.why || `an approval rule says to ${rule.action} for ${rule.pattern}`, subject, rule };
  }

  if (NEVER_A_CHANGE.has(name)) return { action: "allow", reason: "", subject };
  if (effective === "full") return { action: "allow", reason: "", subject };

  const changes = changesSomething(call);
  if (effective === "read") return { action: "allow", reason: "", subject }; // a change was refused above

  // workspace
  if (!changes) return { action: "allow", reason: "", subject };
  if (name === "run_command") {
    const outside = outsidePaths(subject, root);
    if (outside.length && !allowed.has(`${name}\u0000outside`)) {
      return { action: "ask", reason: `it names a path outside the workspace (${outside.slice(0, 3).join(", ")})`, subject, scope: "outside" };
    }
    return { action: "allow", reason: "", subject };
  }
  if (WORKSPACE_TOOLS.has(name)) return { action: "allow", reason: "", subject };
  if (allowed.has(`${name}\u0000*`)) return { action: "allow", reason: "", subject };
  return { action: "ask", reason: `${name} acts on this computer outside the workspace`, subject, scope: "tool" };
}

/** The key "Always allow" stores, so the same kind of call is not asked about again. */
export function allowKey(name, verdict) {
  if (verdict.rule) return `${name}\u0000${verdict.rule.pattern}`;
  if (verdict.scope === "outside") return `${name}\u0000outside`;
  return `${name}\u0000*`;
}
