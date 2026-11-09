// nested-instructions - the rules a subfolder keeps for itself, read when they apply.
//
// The system prompt carries the instruction files from the git root down to the
// workspace (src/instructions.mjs). A monorepo also keeps rules lower down -
// packages/api/AGENTS.md, web/CLAUDE.md - that only matter for files in that folder.
// Loading all of them up front would spend the budget on folders the run never
// touches, so this loads one the first time a file tool reaches a file under it, the
// way Codex and Claude Code do. Once per file per run; a compaction forgets them, so
// they come back on the next touch.

import { readFileSync } from "node:fs";

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "apply_patch", "read_hashed", "edit_hashed"]);

/** Which files does this call touch? Most file tools take `path`; apply_patch names them in the patch. */
export function touchedPaths(tool, args = {}) {
  if (!FILE_TOOLS.has(tool)) return [];
  if (typeof args.path === "string" && args.path) return [args.path];
  if (typeof args.patch === "string") return [...args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  return [];
}

export default {
  id: "rosa-nested-instructions",
  description: "Loads a subfolder's own AGENTS.md / CLAUDE.md the first time the run touches a file there",

  async setup(ctx) {
    ctx.nested = (await import(new URL("../../src/instructions.mjs", import.meta.url).href)).nestedInstructionFiles;
  },

  hooks(ctx) {
    const maxChars = Math.max(500, Number(ctx.config.maxChars) || 4000);
    return {
      async afterTool({ run, root, tool, args, ok }) {
        if (!ok || typeof ctx.nested !== "function") return;
        const seen = run.state.get("seen") ?? new Set();
        const fresh = [];
        for (const path of touchedPaths(tool, args)) {
          for (const file of ctx.nested(root ?? ctx.root, path)) {
            if (seen.has(file)) continue;
            seen.add(file);
            fresh.push(file);
          }
        }
        run.state.set("seen", seen);
        if (!fresh.length) return;
        const parts = [];
        for (const file of fresh) {
          let text = "";
          try {
            text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
          } catch {
            continue;
          }
          if (!text) continue;
          if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… [read_file ${file} for the rest]`;
          parts.push(`Rules for this folder, from ${file} (follow them for files under it):\n${text}`);
        }
        return parts.length ? parts.join("\n\n") : undefined;
      },
      async afterCompact({ run }) {
        run.state.set("seen", new Set());
      },
    };
  },

  status() {
    return "loads subfolder rules on first touch";
  },
};
