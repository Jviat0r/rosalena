// code-intel - code intelligence for small models: hash-anchored edits, structural
// search/rewrite (ast-grep), language-server lookups (definition, references, hover,
// diagnostics, symbols, rename) and a one-shot Node.js debugger.
//
// Why these four: a small local model edits by copying text it read a while ago, and
// "almost the same" text is where edits go wrong. Each tool here replaces a guess with
// something checked:
//
//   read_hashed / edit_hashed   lines are named by number + content hash; a stale anchor
//                               is refused with fresh lines instead of editing the wrong spot
//   ast_search / ast_rewrite    patterns over the syntax tree, not regexes over text
//   lsp_*                       the compiler's answer to "where is this defined / used",
//                               and the real errors after an edit
//   debug_node                  the actual values at a line, instead of print-debugging
//
// Every path is confined to the workspace (lib/confine.mjs: by name and by real path).
// Rewrites and renames are dry runs unless `apply` is true.

import { readFileSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { confine, rel, isInside } from "./lib/confine.mjs";
import { applyHashedEdit, parseFile, renderLines } from "./lib/hashline.mjs";
import { ensureAstGrep, ensureTsServer, findAstGrep, hasTsServer, nodeRuntime, resolveCommand, toolsHome } from "./lib/install.mjs";
import { formatMatches, planRewrite, renderPlans, runAstGrep, writePlans } from "./lib/astgrep.mjs";
import { serverFamily, serverFor, shutdownAll, runningServers, uriToPath } from "./lib/lsp.mjs";
import { debugNode, parseBreakpoint } from "./lib/debug.mjs";

export { shutdownAll };

/** What a system prompt or skill can tell a small model, so it reaches for the safe edit. */
export const HINT =
  "To change part of a file: call read_hashed to see its lines as `LINE:HASH|text`, then edit_hashed with start (and end) copied from those lines. " +
  "If the file changed, edit_hashed refuses and shows the fresh lines; use those. Use write_file only for new files. " +
  "To find where something is defined or used, use lsp_definition / lsp_references with the symbol name; after editing TypeScript or JavaScript, run lsp_diagnostics on the file.";

const READ_BUDGET = 7600; // read_hashed has read_file's 8000-char budget (context.mjs TOOL_PROFILES)
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let activeRoot = null;
let registerTool = null;
const registered = new Set();
function allowInWorkspace(names) {
  for (const n of names) {
    if (registered.has(n)) continue;
    try {
      registerTool?.(n);
      registered.add(n);
    } catch {
      /* older engine */
    }
  }
}

const AST_TOOLS = ["ast_search", "ast_rewrite"];
const LSP_TOOLS = ["lsp_definition", "lsp_references", "lsp_hover", "lsp_diagnostics", "lsp_symbols", "lsp_rename"];

// --------------------------------------------------------------------------- helpers

function readText(abs) {
  const st = statSync(abs);
  if (st.isDirectory()) throw new Error(`${abs} is a folder, not a file`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`the file is ${(st.size / 1024 / 1024).toFixed(1)} MB; hashed reads stop at 5 MB`);
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new Error("this looks like a binary file, not text");
  return buf.toString("utf8");
}

/** Hashed lines from `from`, as many as fit the budget, with a pointer to the rest. */
function hashedView(name, lines, from, limit) {
  const total = lines.length;
  if (!total) return `${name}: empty file (0 lines). Insert with edit_hashed after "0".`;
  const start = Math.min(Math.max(1, from), total);
  const want = Math.min(total, limit ? start + limit - 1 : total);
  const out = [];
  let used = 0;
  let end = start - 1;
  for (let n = start; n <= want; n += 1) {
    const row = renderLines(lines, n, n);
    if (used + row.length + 1 > READ_BUDGET && out.length) break;
    out.push(row);
    used += row.length + 1;
    end = n;
  }
  const more = end < total ? `\n[more: lines ${end + 1}-${total} not shown; call read_hashed with offset ${end + 1}]` : "";
  return `${name}: lines ${start}-${end} of ${total}\n${out.join("\n")}${more}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function wordIndex(lineText, symbol) {
  const parts = String(symbol).split(".").filter(Boolean);
  const needle = parts.join(".");
  const re = new RegExp(`(?<![\\w$])${escapeRe(needle)}(?![\\w$])`);
  const m = re.exec(lineText);
  if (!m) return -1;
  return m.index + needle.length - parts[parts.length - 1].length; // the last segment
}

const flattenSymbols = (list, depth = 0, out = []) => {
  for (const s of list ?? []) {
    out.push({ ...s, depth });
    if (s.children) flattenSymbols(s.children, depth + 1, out);
  }
  return out;
};

/** LSP position from {line, column|character, symbol}: line 1-based, column 1-based. */
async function locate(client, uri, text, args) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const sym = typeof args.symbol === "string" && args.symbol.trim() ? args.symbol.trim() : null;
  const col = args.column !== undefined && args.column !== null ? Number(args.column) - 1 : args.character !== undefined && args.character !== null ? Number(args.character) : null;
  if (args.line !== undefined && args.line !== null && args.line !== "") {
    const line = Number(String(args.line).split(":")[0]) - 1; // "12:a3f" from read_hashed works too
    if (!(line >= 0 && line < lines.length)) throw new Error(`line ${line + 1} is outside the file (it has ${lines.length} lines)`);
    if (col !== null && !sym) return { line, character: Math.max(0, Math.min(col, lines[line].length)) };
    if (sym) {
      const at = wordIndex(lines[line], sym);
      if (at >= 0) return { line, character: at };
      for (const d of [1, -1, 2, -2]) {
        const l = line + d;
        if (l >= 0 && l < lines.length && wordIndex(lines[l], sym) >= 0) return { line: l, character: wordIndex(lines[l], sym) };
      }
      throw new Error(`"${sym}" is not on line ${line + 1}, which is: ${lines[line].trim().slice(0, 160)}`);
    }
    const first = lines[line].search(/[A-Za-z_$]/);
    return { line, character: Math.max(0, first) };
  }
  if (!sym) throw new Error("give symbol (a name in the file), or line with column");
  // By name: the file's own symbol list first, so "add" finds the function, not a comment.
  try {
    const symbols = flattenSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri } }));
    const last = sym.split(".").pop();
    const hit = symbols.find((s) => s.name === sym) ?? symbols.find((s) => s.name === last) ?? symbols.find((s) => s.name.toLowerCase() === last.toLowerCase());
    if (hit) {
      const r = hit.selectionRange ?? hit.location?.range ?? hit.range;
      if (hit.selectionRange) return r.start;
      const at = wordIndex(lines[r.start.line] ?? "", last);
      return { line: r.start.line, character: at >= 0 ? at : r.start.character };
    }
  } catch {
    /* no documentSymbol support: fall back to the text */
  }
  for (let l = 0; l < lines.length; l += 1) {
    const at = wordIndex(lines[l], sym);
    if (at >= 0) return { line: l, character: at };
  }
  throw new Error(`"${sym}" does not appear in this file`);
}

const SYMBOL_KINDS = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event", "operator", "type parameter"];
const SEVERITY = ["", "error", "warning", "info", "hint"];

function normalizeLocations(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list
    .map((l) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l))
    .filter((l) => l?.uri && l.range);
}

function hoverText(result) {
  const c = result?.contents;
  if (!c) return "";
  const one = (x) => (typeof x === "string" ? x : x?.value ? (x.language ? `\`\`\`${x.language}\n${x.value}\n\`\`\`` : x.value) : "");
  return (Array.isArray(c) ? c.map(one) : [one(c)]).filter(Boolean).join("\n\n");
}

/** Offsets for LSP positions (UTF-16, which is what JS strings index). */
function applyTextEdits(text, edits) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  const offset = ({ line, character }) => {
    if (line >= starts.length) return text.length;
    const lineStart = starts[line];
    const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    const bare = text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    return Math.min(lineStart + character, bare);
  };
  const sorted = edits.map((e) => ({ s: offset(e.range.start), e: offset(e.range.end), t: e.newText })).sort((a, b) => b.s - a.s || b.e - a.e);
  let out = text;
  for (const x of sorted) out = out.slice(0, x.s) + x.t + out.slice(x.e);
  return out;
}

// --------------------------------------------------------------------------- the plugin

const plugin = {
  id: "rosa-code-intel",
  description: "Hash-anchored edits, ast-grep search/rewrite, language-server lookups and a Node debugger",

  async setup(ctx) {
    try {
      const permissions = await import(new URL("../../src/permissions.mjs", import.meta.url).href);
      if (typeof permissions.registerWorkspaceTool === "function") registerTool = permissions.registerWorkspaceTool;
    } catch {
      /* older engine: every call asks in Workspace write until "Always allow" */
    }
    try {
      const check = await import(new URL("../../src/edit-check.mjs", import.meta.url).href);
      ctx.afterEdit = typeof check.afterEdit === "function" ? check.afterEdit : null;
    } catch {
      ctx.afterEdit = null;
    }
    ctx.home = toolsHome(ctx.config);
    // These only ever touch files inside the workspace (and run a workspace script, which
    // run_command may do too), so Workspace write treats them like edit_file.
    allowInWorkspace(["read_hashed", "edit_hashed", "debug_node"]);
    // The ast-grep and LSP tools install a tool into the harness home on first use. Until
    // that has happened once, Workspace write asks before the call that would install it.
    if (findAstGrep(ctx.home)) allowInWorkspace(AST_TOOLS);
    if (hasTsServer(ctx.home)) allowInWorkspace(LSP_TOOLS);
  },

  tools(ctx) {
    const root = () => activeRoot ?? ctx.harness?.workspace ?? ctx.root;
    const home = ctx.home ?? toolsHome(ctx.config);
    const log = (m) => ctx.log?.(m);

    // ---------------------------------------------------------------- LSP plumbing
    const specFor = (family) => async () => {
      if (family === "typescript") {
        const ts = await ensureTsServer({ home, log });
        allowInWorkspace(LSP_TOOLS);
        return {
          name: "typescript-language-server",
          command: ts.command,
          args: ts.args,
          env: ts.env,
          installed: ts.installed,
          initializationOptions: ts.tsLib ? { tsserver: { fallbackPath: ts.tsLib } } : {},
        };
      }
      const candidates = {
        python: [["pyright-langserver", ["--stdio"]], ["basedpyright-langserver", ["--stdio"]], ["pylsp", []]],
        go: [["gopls", []]],
        rust: [["rust-analyzer", []]],
        clangd: [["clangd", []]],
      }[family] ?? [];
      for (const [name, extra] of candidates) {
        const cmd = resolveCommand(name);
        if (cmd) return { name, command: cmd.command, args: [...cmd.args, ...extra], env: cmd.env, initializationOptions: {} };
      }
      const names = candidates.map(([n]) => n).join(" or ");
      throw new Error(`no ${family} language server is installed (looked for ${names} on PATH). Install one, or use search / ast_search instead`);
    };

    async function open(path) {
      const r = root();
      const abs = confine(r, path);
      const family = serverFamily(abs);
      if (!family) throw new Error(`no language server for ${extname(abs) || "this file type"} files. Supported: .ts .tsx .js .jsx .mjs .cjs (built in), .py (pyright), .go (gopls), .rs (rust-analyzer), .c/.cpp (clangd)`);
      const { client, info } = await serverFor(r, family, specFor(family));
      const since = Date.now();
      const resynced = client.resyncOpen();
      const text = readText(abs);
      const s = client.sync(abs, text);
      // A just-opened file: the server is still loading its project, and an answer now can
      // be partial (tsserver resolves `add` to the import line, not the function). Its first
      // diagnostics push means the project is loaded, so wait for that, briefly, once.
      if (s.opened) await client.diagnosticsFor(abs, { changed: true, timeoutMs: 8000, quietMs: 150, since });
      const note = info?.installed?.length ? `[first use: installed ${info.installed.join(", ")} into ${home}]\n` : "";
      if (info) info.installed = []; // say it once
      return { r, abs, client, uri: s.uri, text, changed: s.changed || resynced > 0, since, note };
    }

    const where = (r, uri, range, cache) => {
      const abs = uriToPath(uri);
      let lineText = "";
      try {
        if (!cache.has(abs)) cache.set(abs, readFileSync(abs, "utf8").split("\n"));
        lineText = (cache.get(abs)[range.start.line] ?? "").replace(/\r$/, "").trim().slice(0, 160);
      } catch {
        /* unreadable */
      }
      const name = isInside(r, abs) ? rel(r, abs) : abs.replace(/\\/g, "/");
      return `${name}:${range.start.line + 1}:${range.start.character + 1}  ${lineText}`;
    };

    const positionProps = {
      path: { type: "string", description: "File, relative to the workspace" },
      symbol: { type: "string", description: "Name to look up, e.g. \"addUser\" (easiest)" },
      line: { type: "integer", description: "1-based line (from read_hashed)" },
      column: { type: "integer", description: "1-based column; optional if symbol is given" },
    };

    const lspPositional = (method, render) => async (args) => {
      const { r, client, uri, text, note } = await open(args.path);
      const position = await locate(client, uri, text, args);
      const params = { textDocument: { uri }, position };
      if (method === "textDocument/references") params.context = { includeDeclaration: true };
      const result = await client.request(method, params, 30_000);
      return note + render(r, result, position);
    };

    // ---------------------------------------------------------------- tools
    return [
      {
        name: "read_hashed",
        description: "Read a file as numbered lines with a hash: `12:a3f|text`. Use the LINE:HASH anchors with edit_hashed.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File, relative to the workspace" },
            offset: { type: "integer", description: "First line to show (1-based). Default 1" },
            limit: { type: "integer", description: "How many lines. Default: as many as fit" },
          },
          required: ["path"],
        },
        async run(args) {
          const r = root();
          const abs = confine(r, args.path);
          const { lines } = parseFile(readText(abs));
          return hashedView(rel(r, abs), lines, Number(args.offset) || 1, Number(args.limit) || 0);
        },
      },
      {
        name: "edit_hashed",
        description:
          "Replace lines start..end (anchors like \"12:a3f\" from read_hashed) with new_text, or insert new_text after a line (after: \"12:a3f\", or \"0\" for the top). Empty new_text deletes. Refused if the anchors no longer match.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File, relative to the workspace" },
            start: { type: "string", description: "First line to replace, e.g. \"12:a3f\"" },
            end: { type: "string", description: "Last line to replace (default: same as start)" },
            after: { type: "string", description: "Insert after this line instead of replacing" },
            new_text: { type: "string", description: "The new lines, without LINE:HASH| prefixes" },
          },
          required: ["path", "new_text"],
        },
        async run(args) {
          const r = root();
          const abs = confine(r, args.path);
          const name = rel(r, abs);
          if (!existsSync(abs)) throw new Error(`${name} does not exist. Create new files with write_file`);
          const before = readText(abs);
          const res = applyHashedEdit(before, args);
          if (!res.ok) {
            if (!res.stale) throw new Error(res.reason);
            const { lines } = parseFile(before);
            const at = Math.min(Math.max(1, res.around), Math.max(1, lines.length));
            throw new Error(`REFUSED, nothing was changed: ${res.reason}\nThe file is different from what you read. Fresh lines around ${at}:\n${renderLines(lines, at - 6, at + 6)}\nUse these anchors.`);
          }
          writeFileSync(abs, res.text, "utf8");
          let check = "";
          if (ctx.afterEdit) {
            try {
              check = ctx.afterEdit(abs, r) ?? "";
            } catch {
              check = "";
            }
          }
          const { lines } = parseFile(readText(abs)); // after a formatter, if the project has one
          const what = res.removed === 0 ? `inserted ${res.added} line(s) at ${res.from}` : res.added === 0 ? `deleted ${res.removed} line(s) at ${res.from}` : `replaced ${res.removed} line(s) with ${res.added} at ${res.from}`;
          const strip = res.stripped ? " (the LINE:HASH| prefixes you pasted were removed)" : "";
          const showTo = res.added ? res.to : res.from;
          return `edited ${name}: ${what}${strip}${check}\nLines now (use these anchors for the next edit):\n${renderLines(lines, res.from - 2, showTo + 2) || "(file is empty)"}`;
        },
      },
      {
        name: "ast_search",
        description: "Find code by syntax pattern (ast-grep). $A = any one node, $$$A = any nodes. Example: pattern \"console.log($$$A)\", lang \"ts\".",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Code pattern with $METAVARS" },
            lang: { type: "string", description: "ts, tsx, js, py, go, rust, java, c, cpp, ..." },
            path: { type: "string", description: "File or folder to search (default: whole workspace)" },
          },
          required: ["pattern", "lang"],
        },
        async run(args) {
          const r = root();
          const target = args.path ? rel(r, confine(r, args.path)) : ".";
          const sg = await ensureAstGrep({ home, log });
          allowInWorkspace(AST_TOOLS);
          const matches = await runAstGrep(sg.bin, { root: r, pattern: args.pattern, lang: args.lang, target });
          const note = sg.installed?.length ? `[first use: installed ${sg.installed.join(", ")} into ${home}]\n` : "";
          return note + (formatMatches(r, matches) ?? `no matches for ${args.pattern} (${args.lang}) in ${target}`);
        },
      },
      {
        name: "ast_rewrite",
        description: "Rewrite code by syntax pattern (ast-grep). Dry run by default: returns the diff. Set apply: true to write it. $VARS in rewrite reuse what the pattern matched.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Code pattern with $METAVARS, e.g. \"console.log($$$A)\"" },
            rewrite: { type: "string", description: "Replacement, e.g. \"logger.info($$$A)\"" },
            lang: { type: "string", description: "ts, tsx, js, py, go, rust, ..." },
            path: { type: "string", description: "File or folder (default: whole workspace)" },
            apply: { type: "boolean", description: "true writes the files. Default false (preview)" },
          },
          required: ["pattern", "rewrite", "lang"],
        },
        async run(args) {
          const r = root();
          const target = args.path ? rel(r, confine(r, args.path)) : ".";
          const sg = await ensureAstGrep({ home, log });
          allowInWorkspace(AST_TOOLS);
          const matches = await runAstGrep(sg.bin, { root: r, pattern: args.pattern, rewrite: String(args.rewrite ?? ""), lang: args.lang, target });
          const plans = planRewrite(r, matches);
          const note = sg.installed?.length ? `[first use: installed ${sg.installed.join(", ")} into ${home}]\n` : "";
          if (!plans.length) return `${note}nothing to rewrite: ${matches.length ? "every match already reads that way" : `no matches for ${args.pattern}`}`;
          const total = plans.reduce((n, p) => n + p.count, 0);
          if (args.apply !== true) {
            return `${note}PREVIEW (nothing written): ${total} replacement(s) in ${plans.length} file(s). Call again with apply: true to write.\n${renderPlans(plans)}`;
          }
          const written = writePlans(r, plans);
          return `${note}rewrote ${total} match(es):\n${written.join("\n")}`;
        },
      },
      {
        name: "lsp_definition",
        description: "Where a symbol is defined (language server). Give path and symbol, or path, line and column.",
        parameters: { type: "object", properties: positionProps, required: ["path"] },
        run: lspPositional("textDocument/definition", (r, result) => {
          const locs = normalizeLocations(result);
          if (!locs.length) return "no definition found at that position";
          const cache = new Map();
          return `definition${locs.length > 1 ? `s (${locs.length})` : ""}:\n${locs.slice(0, 20).map((l) => where(r, l.uri, l.range, cache)).join("\n")}`;
        }),
      },
      {
        name: "lsp_references",
        description: "Every place a symbol is used, across the project (language server). Give path and symbol, or path, line and column.",
        parameters: { type: "object", properties: positionProps, required: ["path"] },
        run: lspPositional("textDocument/references", (r, result) => {
          const locs = normalizeLocations(result);
          if (!locs.length) return "no references found";
          const cache = new Map();
          const shown = locs.slice(0, 80).map((l) => where(r, l.uri, l.range, cache));
          return `${locs.length} reference${locs.length === 1 ? "" : "s"}${locs.length > 80 ? " (first 80)" : ""}:\n${shown.join("\n")}`;
        }),
      },
      {
        name: "lsp_hover",
        description: "The type and docs of a symbol (language server). Give path and symbol, or path, line and column.",
        parameters: { type: "object", properties: positionProps, required: ["path"] },
        run: lspPositional("textDocument/hover", (r, result) => hoverText(result).trim().slice(0, 3000) || "no information at that position"),
      },
      {
        name: "lsp_diagnostics",
        description: "Compiler errors and warnings for a file (language server). Run after editing.",
        parameters: { type: "object", properties: { path: positionProps.path }, required: ["path"] },
        async run(args) {
          const { r, abs, client, changed, since, note } = await open(args.path);
          const list = await client.diagnosticsFor(abs, { changed, since });
          const name = rel(r, abs);
          if (!list.length) return `${note}no problems found in ${name}`;
          const rows = list
            .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line)
            .slice(0, 50)
            .map((d) => `${name}:${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1] ?? "error"}${d.code !== undefined ? ` ${d.source === "typescript" ? "TS" : ""}${d.code}` : ""}: ${String(d.message).split("\n").join(" ").slice(0, 300)}`);
          const errors = list.filter((d) => (d.severity ?? 1) === 1).length;
          return `${note}${errors} error(s), ${list.length - errors} other in ${name}:\n${rows.join("\n")}`;
        },
      },
      {
        name: "lsp_symbols",
        description: "List the symbols in a file (path), or search symbols across the project by name (query).",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File to outline" },
            query: { type: "string", description: "Name to search the whole project for" },
          },
        },
        async run(args) {
          const r = root();
          if (args.path && !args.query) {
            const { client, uri, note } = await open(args.path);
            const result = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
            const flat = flattenSymbols(result);
            if (!flat.length) return `${note}no symbols in ${args.path}`;
            const rows = flat.slice(0, 150).map((s) => {
              const range = s.selectionRange ?? s.location?.range ?? s.range;
              return `${"  ".repeat(s.depth)}${range.start.line + 1}  ${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.name}${s.containerName && !s.children ? `  (in ${s.containerName})` : ""}`;
            });
            return `${note}${rows.join("\n")}${flat.length > 150 ? `\n… ${flat.length - 150} more` : ""}`;
          }
          if (!args.query) throw new Error("give path (to outline a file) or query (to search the project)");
          // workspace/symbol needs a running server with the project loaded: open a file.
          let anchor = args.path;
          if (!anchor) {
            const stack = [resolve(r)];
            let seen = 0;
            while (stack.length && !anchor && seen < 3000) {
              const dir = stack.shift();
              let entries = [];
              try {
                entries = readdirSync(dir, { withFileTypes: true });
              } catch {
                continue;
              }
              for (const e of entries) {
                seen += 1;
                if (e.isDirectory()) {
                  if (!["node_modules", ".git", "dist", "build", ".venv"].includes(e.name)) stack.push(join(dir, e.name));
                } else if (serverFamily(e.name) === "typescript" && !e.name.endsWith(".d.ts")) {
                  anchor = join(dir, e.name);
                  break;
                }
              }
            }
          }
          if (!anchor) throw new Error("no source file found to start a language server from; pass path (any file of the project) with the query");
          const { client, note } = await open(anchor);
          const result = await client.request("workspace/symbol", { query: String(args.query) }, 30_000);
          const list = (result ?? []).filter((s) => s.location?.uri);
          if (!list.length) return `${note}no symbols match "${args.query}"`;
          const cache = new Map();
          return `${note}${list.length} symbol(s):\n${list
            .slice(0, 60)
            .map((s) => `${SYMBOL_KINDS[s.kind] ?? "symbol"} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ""}  ${where(r, s.location.uri, s.location.range ?? { start: { line: 0, character: 0 } }, cache)}`)
            .join("\n")}`;
        },
      },
      {
        name: "lsp_rename",
        description: "Rename a symbol everywhere it is used (language server). Dry run by default: returns the diff. Set apply: true to write.",
        parameters: {
          type: "object",
          properties: {
            ...positionProps,
            new_name: { type: "string", description: "The new name" },
            apply: { type: "boolean", description: "true writes the files. Default false (preview)" },
          },
          required: ["path", "new_name"],
        },
        async run(args) {
          const newName = String(args.new_name ?? "").trim();
          if (!newName) throw new Error("new_name is empty");
          const { r, client, uri, text, note } = await open(args.path);
          const position = await locate(client, uri, text, args);
          if (client.capabilities?.renameProvider?.prepareProvider) {
            const ok = await client.request("textDocument/prepareRename", { textDocument: { uri }, position }).catch(() => undefined);
            if (ok === null) throw new Error("the language server says the thing at that position cannot be renamed. Point at the name itself (symbol)");
          }
          const edit = await client.request("textDocument/rename", { textDocument: { uri }, position, newName }, 30_000);
          const byFile = new Map();
          for (const [u, edits] of Object.entries(edit?.changes ?? {})) byFile.set(u, [...(byFile.get(u) ?? []), ...edits]);
          for (const dc of edit?.documentChanges ?? []) {
            if (dc.kind) throw new Error(`this rename would also ${dc.kind} a file (${dc.uri ?? dc.oldUri}); do that part by hand`);
            byFile.set(dc.textDocument.uri, [...(byFile.get(dc.textDocument.uri) ?? []), ...dc.edits]);
          }
          if (!byFile.size) return `${note}nothing to rename (the server returned no edits)`;
          const plans = [];
          for (const [u, edits] of byFile) {
            const abs = uriToPath(u);
            if (!isInside(r, abs)) throw new Error(`refused: the rename would change ${abs}, which is outside the workspace. Nothing was written`);
            const before = readFileSync(abs, "utf8");
            const after = applyTextEdits(before, edits);
            if (after !== before) plans.push({ file: rel(r, abs), abs, before, after, count: edits.length, mtimeMs: statSync(abs).mtimeMs });
          }
          const total = plans.reduce((n, p) => n + p.count, 0);
          if (args.apply !== true) {
            return `${note}PREVIEW (nothing written): ${total} change(s) in ${plans.length} file(s). Call again with apply: true to write.\n${renderPlans(plans)}`;
          }
          const written = writePlans(r, plans);
          for (const p of plans) {
            try {
              client.sync(p.abs, p.after);
            } catch {
              /* the server will read it from disk */
            }
          }
          return `${note}renamed to ${newName}:\n${written.join("\n")}`;
        },
      },
      {
        name: "debug_node",
        description:
          "Run a Node.js script with breakpoints and report, at each hit, the call stack, local variables and the values of expressions. Breakpoints: [\"src/app.js:12\"].",
        parameters: {
          type: "object",
          properties: {
            script: { type: "string", description: "Script to run, relative to the workspace" },
            args: { type: "array", items: { type: "string" }, description: "Arguments for the script" },
            breakpoints: { type: "array", items: { type: "string" }, description: "file:line, e.g. \"src/app.js:12\"" },
            expressions: { type: "array", items: { type: "string" }, description: "Evaluated at each hit, e.g. \"user.id\"" },
            maxHits: { type: "integer", description: "Stop after this many hits. Default 3" },
            timeoutMs: { type: "integer", description: "Default 20000" },
          },
          required: ["script", "breakpoints"],
        },
        async run(args) {
          const r = root();
          const script = confine(r, args.script);
          if (!existsSync(script)) throw new Error(`${args.script} does not exist`);
          const bps = (Array.isArray(args.breakpoints) ? args.breakpoints : [args.breakpoints]).filter(Boolean).map((spec) => {
            const { file, line } = parseBreakpoint(spec);
            const abs = confine(r, file);
            if (!existsSync(abs)) throw new Error(`breakpoint file ${file} does not exist`);
            return { abs, line, label: `${rel(r, abs)}:${line}` };
          });
          if (!bps.length) throw new Error('give at least one breakpoint, e.g. ["src/app.js:12"]');
          const node = nodeRuntime();
          const res = await debugNode({
            node: node.command,
            nodeEnv: node.env,
            script,
            args: Array.isArray(args.args) ? args.args : [],
            cwd: r,
            breakpoints: bps,
            expressions: Array.isArray(args.expressions) ? args.expressions : [],
            maxHits: Math.min(20, Math.max(1, Number(args.maxHits) || 3)),
            timeoutMs: Math.min(120_000, Math.max(1000, Number(args.timeoutMs) || 20_000)),
            isProjectFile: (f) => isInside(r, f) && !/[\\/]node_modules[\\/]/.test(f),
          });
          const show = (f) => (isInside(r, f) ? rel(r, f) : f.replace(/\\/g, "/"));
          const out = [];
          res.hits.forEach((h, i) => {
            out.push(`HIT ${i + 1}: ${h.reason}`);
            out.push("  stack:");
            for (const f of h.stack.filter((s) => s.project || h.stack.indexOf(s) === 0).slice(0, 8)) out.push(`    ${f.fn} (${show(f.file)}:${f.line})`);
            if (h.locals.length) {
              out.push("  locals:");
              for (const l of h.locals) out.push(`    ${l.name} = ${l.value}${l.scope === "local" || l.scope === "block" ? "" : `  [${l.scope}]`}`);
            }
            if (h.expressions.length) {
              out.push("  expressions:");
              for (const e of h.expressions) out.push(`    ${e.expression} = ${e.value}`);
            }
          });
          if (!res.hits.length) out.push(res.timedOut ? `no breakpoint was hit within ${Math.round((Number(args.timeoutMs) || 20_000) / 1000)} s` : "the script finished without hitting a breakpoint");
          if (res.unbound.length) out.push(`never loaded (wrong path, or that code never ran): ${res.unbound.join(", ")}`);
          out.push(`process: ${res.timedOut ? "timed out, killed" : res.hits.length ? "stopped after the hits above, killed" : `exit ${res.exitCode ?? "killed"}`}`);
          if (res.output) out.push(`output:\n${res.output.slice(-1500)}`);
          return out.join("\n");
        },
      },
    ];
  },

  commands(ctx) {
    const home = () => ctx.home ?? toolsHome(ctx.config);
    return {
      install: async () => {
        const sg = await ensureAstGrep({ home: home() });
        allowInWorkspace(AST_TOOLS);
        const ts = await ensureTsServer({ home: home() });
        allowInWorkspace(LSP_TOOLS);
        return `ast-grep: ${sg.bin}\ntypescript-language-server: ${ts.source}${[...(sg.installed ?? []), ...(ts.installed ?? [])].length ? `\ninstalled now: ${[...sg.installed, ...ts.installed].join(", ")}` : ""}`;
      },
      stop: async () => {
        const n = runningServers().length;
        await shutdownAll();
        return `stopped ${n} language server(s)`;
      },
    };
  },

  hooks() {
    return {
      async onRunStart({ root, depth }) {
        if (depth > 0) return;
        if (root) activeRoot = resolve(root);
      },
    };
  },

  status(ctx) {
    const home = ctx.home ?? toolsHome(ctx.config);
    const sg = findAstGrep(home);
    const servers = runningServers().length;
    return `ast-grep ${sg ? "ready" : "installs on first use"}, TypeScript server ${hasTsServer(home) ? "ready" : "installs on first use"}, ${servers} language server(s) running`;
  },
};

export default plugin;
