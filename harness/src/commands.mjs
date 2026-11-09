/**
 * Slash commands: prompt templates typed as "/name arguments" in the composer.
 *
 * Built in: the common ones from Claude Code, OpenCode and DSH. Added: every
 * `<name>.md` in the command folders below, in the same format those tools use - an
 * optional front matter (`description:`, `agent: plan`, `mode: goal`) and a body where
 * $ARGUMENTS is everything after the name and $1..$9 are its words. A command found in
 * an earlier folder wins over a later one with the same name, and over a built-in.
 *
 *   <workspace>/.rosalena/commands   <workspace>/.claude/commands   <workspace>/.opencode/command(s)
 *   ~/.rosalena/commands             ~/.claude/commands             ~/.config/opencode/command(s)
 *   ~/.dsh/commands
 *
 * `action` commands (clear, undo, help, ...) are done by the page, not sent to a model.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const BUILTIN_COMMANDS = Object.freeze([
  {
    name: "plan",
    description: "Plan first: investigate read-only, propose a plan, and change nothing until you approve it",
    plan: true,
    template: "$ARGUMENTS",
    needsArgs: true,
  },
  {
    name: "goal",
    description: "Work on a goal across many rounds until it is done, keeping progress in .goal-state.md",
    goal: true,
    template:
      "Goal: $ARGUMENTS\n\nWork on this goal until it is done. Keep the state in .goal-state.md: what is done, what is next, and what blocks you. Plan, do one part, verify it, record it, then continue with the next part. Only say the goal is done when you have verified it.",
    needsArgs: true,
  },
  {
    name: "init",
    description: "Write an AGENTS.md for this project: how to build, test and run it, and its conventions",
    template:
      "Look through this project (its README, package files, scripts, folder layout and code style) and write an AGENTS.md at the workspace root for AI assistants that will work here. Include: what the project is, how to install, build, test and run it (the exact commands), the folder layout, code conventions you can see, and anything risky (deploy steps, secrets, generated files). Keep it short and factual. If an AGENTS.md already exists, improve it instead of replacing what is still true. $ARGUMENTS",
  },
  {
    name: "review",
    description: "Review the uncommitted changes for bugs, risks and missing tests",
    template:
      "Review the current uncommitted changes (run git status and git diff). For each real problem give the file and line, what goes wrong, and the fix. Focus on bugs, broken edge cases, security issues and missing tests; skip style nitpicks. Do not change any files. $ARGUMENTS",
  },
  {
    name: "security-review",
    description: "Check the uncommitted changes for security problems",
    template:
      "Do a security review of the current uncommitted changes (git diff): injection, path traversal, secrets in code or logs, unsafe deserialization, missing auth or validation, risky dependencies. For each finding give the file and line, the attack, and the fix. Do not change any files. $ARGUMENTS",
  },
  {
    name: "test",
    description: "Run the project's tests and fix what fails",
    template:
      "Find how this project runs its tests (package.json scripts, README, AGENTS.md), run them, and fix the failures. Fix the cause, not the test, unless the test is wrong - and say which. Re-run until they pass, then report what you changed. $ARGUMENTS",
  },
  {
    name: "fix",
    description: "Find the cause of a bug or error and fix it",
    template: "Find the root cause of this problem and fix it, then show that it is fixed (run the thing that failed): $ARGUMENTS",
    needsArgs: true,
  },
  {
    name: "explain",
    description: "Explain how some code or part of the project works",
    template: "Explain how this works, in plain words, with the files and functions involved. Do not change anything: $ARGUMENTS",
    needsArgs: true,
  },
  {
    name: "commit",
    description: "Commit the work: stage only this task's files and write a clear message",
    template:
      "Commit the current work. Run git status first. Stage only the files that belong to this task, by name (never git add -A, git add . or git commit -a). Write a short, specific commit message. List any other changed files you left unstaged. Do not push. $ARGUMENTS",
  },
  {
    name: "todo",
    description: "Break a task into a checklist first, then work through it",
    template: "Before doing anything, write a todo list for this task with todo_write, then work through it item by item, keeping the list current: $ARGUMENTS",
    needsArgs: true,
  },
  { name: "skills", description: "List the skills this install has", template: "List the skills available here (call the skill tool with no name) and say in one line what each is for." },
  { name: "clear", description: "Start a new chat", action: "clear" },
  { name: "undo", description: "Undo the file changes from the last message", action: "undo" },
  { name: "help", description: "List the slash commands", action: "help" },
]);

export function commandDirs(root, home = homedir()) {
  return [
    join(root, ".rosalena", "commands"),
    join(root, ".claude", "commands"),
    join(root, ".opencode", "command"),
    join(root, ".opencode", "commands"),
    join(home, ".rosalena", "commands"),
    join(home, ".claude", "commands"),
    join(home, ".config", "opencode", "command"),
    join(home, ".config", "opencode", "commands"),
    join(home, ".dsh", "commands"),
  ];
}

/** Front matter (simple `key: value` lines) and body of a command file. */
export function parseCommandFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = {};
  let body = text;
  if (match) {
    body = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: body.trim() };
}

/** Every command for this workspace: user files first, then the built-ins. */
export function loadCommands(root, { home = homedir() } = {}) {
  const found = new Map();
  for (const dir of commandDirs(root, home)) {
    if (!existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md"));
    } catch {
      continue;
    }
    for (const fileName of names) {
      const name = basename(fileName, ".md").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (found.has(name)) continue;
      try {
        const { meta, body } = parseCommandFile(readFileSync(join(dir, fileName), "utf8"));
        if (!body) continue;
        found.set(name, {
          name,
          description: meta.description || body.split(/\r?\n/)[0].slice(0, 120),
          template: body,
          plan: /plan/i.test(meta.agent ?? meta.mode ?? ""),
          goal: /goal/i.test(meta.mode ?? ""),
          source: join(dir, fileName),
        });
      } catch {
        /* unreadable command file: skipped */
      }
    }
  }
  for (const command of BUILTIN_COMMANDS) if (!found.has(command.name)) found.set(command.name, { ...command, source: "built-in" });
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "$ARGUMENTS" and "$1".."$9" filled in; arguments appended when the template has no slot. */
export function expandCommand(template, args) {
  const text = String(args ?? "").trim();
  const words = text ? text.split(/\s+/) : [];
  const hasSlot = /\$ARGUMENTS|\$[1-9]/.test(template);
  let out = String(template)
    .replace(/\$ARGUMENTS/g, text)
    .replace(/\$([1-9])/g, (_m, n) => words[Number(n) - 1] ?? "");
  if (!hasSlot && text) out = `${out}\n\n${text}`;
  return out.trim();
}
