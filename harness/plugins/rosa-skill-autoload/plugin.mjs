// skill-autoload - put the right skill in front of the model without waiting for it to ask.
//
// The failure it exists for: the `skill` tool lists skills by name only, and small models
// almost never call it on their own. A local coder asked for "a landing page" writes the
// same centered-hero-plus-three-cards page every time, with the taste skill one tool call
// away and unread. The quality a harness ships with by default is the quality most people
// get, because most people never type /skills.
//
// So the harness loads a skill itself when the work clearly calls for it:
//   - by the request: the task text matches the skill's `task` pattern (checked at step 1)
//   - by the work: the model writes or edits a file matching the skill's `files` pattern
//     (checked after each step; the skill arrives before the next model call)
//
// Each skill is injected at most once per run, the body only (no frontmatter), capped at
// `maxChars`. A person's own copy of a skill (~/.rosalena/skills, ~/.claude/skills, ...)
// wins over the bundled one, the same order the `skill` tool uses.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_RULES = Object.freeze({
  "frontend-taste": {
    task: "\\b(ui|ux|landing|homepage|home page|website|web ?site|web ?page|page|dashboard|component|layout|redesign|(ui|ux|visual|web|app) design|look(s)? (better|nicer|modern)|styl(e|ing)|css|tailwind|frontend|front-end|hero|navbar|modal|form|onboarding|portfolio|pricing)\\b",
    files: "\\.(css|scss|sass|less|html?|jsx|tsx|vue|svelte|astro)$",
  },
  "ui-check": {
    files: "\\.(css|scss|html?|jsx|tsx|vue|svelte|astro)$",
    afterChanges: 3,
  },
  "commit-cadence": {
    // At step 1 for a change request, because the skill's main job is the plan's order
    // (small pieces first, big ones last), and the plan is written before any file is.
    task: "\\b(add|build|implement|fix|refactor|change|update|create|make|write|rewrite|migrate|upgrade|rename|remove|delete|port|convert|redesign|clean ?up|set ?up|integrate|wire|finish|improve|optimi[sz]e|replace|move|extract|split|support)\\b",
    // A question is not a change request, even when it says "build" ("why does the build
    // fail?"), and neither is prose: "write a haiku" is no work to commit (it pulled this
    // skill in on 2026-11-04, and the model was handed the skill instead of the request).
    notTask: "^\\s*(why|what|how|where|when|who|which|explain|describe|summari[sz]e|show me|tell me|is|are|does|do)\\b|\\b(haiku|poem|limerick|sonnet|story|essay|joke|song|lyrics|tweet|caption|email|letter|toast)\\b",
    files: ".",
    requiresTool: "checkpoint",
    // Commits need a repository: outside one the skill is only instructions to ignore.
    requiresGit: true,
  },
  // The browser plugin's guide: cheapest route first, page text is data, no passwords.
  "web-access": {
    task: "\\b(browse|browser|open (the |this |a )?(url|link|site|page)|click|fill (in|out)|scrape|localhost|dev server|in the browser|check (the|my) (site|page|app)|console errors?|screenshot)\\b|https?:\\/\\/",
    requiresTool: "browser_open",
  },
});

/** The paths a step's write_file / edit_file calls touched, from the loop's call keys. */
export function pathsFromCallKeys(keys) {
  const out = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    const m = /^(write_file|edit_file|apply_patch|edit_hashed)\((.*)\)$/s.exec(String(key));
    if (!m) continue;
    const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[2]);
    if (path) out.push(path[1].replace(/\\\\/g, "\\"));
  }
  return out;
}

/** The SKILL.md body without its frontmatter. */
export function skillBody(text) {
  const s = String(text ?? "");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s);
  return (m ? s.slice(m[0].length) : s).trim();
}

/** Is `dir` inside a git work tree? A `.git` (folder or worktree file) in it or a parent; no git process. */
export function insideGit(dir) {
  if (!dir) return true; // unknown: keep the old behaviour rather than drop a rule
  let current = String(dir);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * Which skills should be injected now? Pure.
 * `seen`: skills already injected this run. `changes`: how many files the run has written.
 * `inGit`: whether the workspace is a git work tree (rules with `requiresGit` need one).
 */
export function due({ rules, task = "", step = 1, paths = [], changes = 0, tools = [], seen = new Set(), inGit = true }) {
  const out = [];
  for (const [name, rule] of Object.entries(rules ?? {})) {
    if (seen.has(name) || rule?.enabled === false) continue;
    if (rule.requiresTool && !tools.includes(rule.requiresTool)) continue;
    if (rule.requiresGit && !inGit) continue;
    const byTask = step === 1 && rule.task && new RegExp(rule.task, "i").test(task) && !(rule.notTask && new RegExp(rule.notTask, "i").test(task));
    const byFile = rule.files && paths.some((p) => new RegExp(rule.files, "i").test(p)) && changes >= (Number(rule.afterChanges) || 1);
    if (byTask || byFile) out.push(name);
  }
  return out;
}

async function skillFinder() {
  try {
    const mod = await import(new URL("../../src/tools-extra.mjs", import.meta.url).href);
    if (typeof mod.listSkills === "function") return () => mod.listSkills();
  } catch {
    /* an engine without listSkills: fall back to the bundled folder */
  }
  const bundled = fileURLToPath(new URL("../../skills/", import.meta.url));
  return () =>
    Object.keys(DEFAULT_RULES)
      .map((name) => ({ name, file: join(bundled, name, "SKILL.md") }))
      .filter((s) => existsSync(s.file));
}

export default {
  id: "rosa-skill-autoload",
  description: "Loads a skill by itself when the request or the files being edited call for it",

  async setup(ctx) {
    ctx.findSkills = await skillFinder();
  },

  hooks(ctx) {
    const rules = { ...DEFAULT_RULES, ...(ctx.config.rules ?? {}) };
    const maxChars = Math.max(500, Number(ctx.config.maxChars) || 6000);

    const inject = (names, run) => {
      const all = ctx.findSkills();
      const seen = run.state.get("seen") ?? new Set();
      const parts = [];
      for (const name of names) {
        const found = all.find((s) => s.name === name);
        if (!found) continue;
        let body;
        try {
          body = skillBody(readFileSync(found.file, "utf8"));
        } catch {
          continue;
        }
        if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n\n(cut here - call the skill tool with name "${name}" for the rest)`;
        seen.add(name);
        parts.push(`Skill "${name}" applies to this work. Follow it:\n\n${body}`);
      }
      run.state.set("seen", seen);
      if (!parts.length) return undefined;
      ctx.log(`loaded ${names.join(", ")}`);
      return { note: parts.join("\n\n---\n\n") };
    };

    return {
      async beforeStep({ run, step, task, tools, depth, root }) {
        if (depth > 0 && ctx.config.workers === false) return;
        const pending = run.state.get("pending") ?? [];
        const names = [
          ...pending,
          ...due({ rules, task, step, tools: tools ?? [], seen: run.state.get("seen") ?? new Set(), inGit: insideGit(root) }),
        ];
        run.state.set("pending", []);
        return names.length ? inject([...new Set(names)], run) : undefined;
      },

      async afterStep({ run, toolCallKeys, tools, root }) {
        const paths = pathsFromCallKeys(toolCallKeys);
        if (!paths.length) return;
        const written = run.state.get("written") ?? new Set();
        for (const p of paths) written.add(p);
        run.state.set("written", written);
        const names = due({ rules, step: 0, paths, changes: written.size, tools: tools ?? [], seen: run.state.get("seen") ?? new Set(), inGit: insideGit(root) });
        if (names.length) run.state.set("pending", [...new Set([...(run.state.get("pending") ?? []), ...names])]);
      },
    };
  },

  status(ctx) {
    const rules = { ...DEFAULT_RULES, ...(ctx.config.rules ?? {}) };
    return `watching for ${Object.keys(rules).join(", ")}`;
  },
};
