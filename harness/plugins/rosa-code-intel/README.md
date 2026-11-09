# rosa-code-intel

Code intelligence for small and local models. Each tool swaps a guess the model would
otherwise make for something the harness checks.

| Tool | What it does |
|---|---|
| `read_hashed {path, offset?, limit?}` | Lines as `12:a3f\|text`: line number, 3 hex chars of the line's sha1, the text. Pages itself to fit the 6000-char plugin output budget. |
| `edit_hashed {path, start, end?, new_text}` / `{path, after, new_text}` | Replace lines `start..end`, or insert after a line (`"0"` = top). Refused, with the fresh lines, if an anchor's hash no longer matches. Keeps CRLF/LF per line, the trailing newline (or its absence) and a BOM. Strips `12:a3f\|` prefixes if the model pastes them into `new_text`. Runs the same format/syntax check as `edit_file` (`src/edit-check.mjs`). |
| `ast_search {pattern, lang, path?}` | ast-grep structural search (`console.log($$$A)`). Never matches inside strings or comments. |
| `ast_rewrite {pattern, rewrite, lang, path?, apply?}` | Dry run by default (unified diff). `apply: true` writes. The plugin applies ast-grep's JSON replacements itself, so each file is confined to the workspace first. |
| `lsp_definition`, `lsp_references`, `lsp_hover` `{path, symbol? , line?, column?}` | `symbol` alone is enough (looked up through the file's symbols, then its text); `line` + `symbol` picks the occurrence on that line. Lines and columns are 1-based. |
| `lsp_diagnostics {path}` | The server's errors and warnings, after syncing the file from disk. |
| `lsp_symbols {path}` / `{query}` | A file's outline, or a project-wide symbol search. |
| `lsp_rename {path, symbol/line/column, new_name, apply?}` | The WorkspaceEdit as a diff; `apply: true` writes. Refused whole if any edit lands outside the workspace or needs a file create/rename. |
| `debug_node {script, args?, breakpoints, expressions?, maxHits?, timeoutMs?}` | Runs `node --inspect-brk`, talks CDP over the inspector WebSocket, and at each hit returns the stack, locals and expression values. Pauses on uncaught exceptions too. Kills the process tree at the end. |

Commands: `/plugin rosa-code-intel:install` (fetch ast-grep and the TS server now), `/plugin rosa-code-intel:stop` (stop language servers).

## Language servers

- TypeScript / JavaScript: `typescript-language-server` on PATH, else installed on first use with `typescript@5.9.3` (TypeScript 7 is the Go port and has no tsserver.js; a workspace's own TS 5.x is still preferred by the server, ours is the fallback).
- Python: `pyright-langserver`, `basedpyright-langserver` or `pylsp` if on PATH. Go: `gopls`. Rust: `rust-analyzer`. C/C++: `clangd`. Never installed by the plugin.
- One server per (workspace root, language), kept alive across calls, stopped after 10 min idle and killed (with its children) on process exit.

## First-use installs

Into `<ROSALENA_HOME or ~/.rosalena>/code-intel` (override: plugin config `toolsDir`, or `ROSALENA_CODE_INTEL_DIR`), not into the app folder: the installed app can be read-only and is replaced on update, and releases never ship node_modules. Versions are pinned in `lib/install.mjs`.

- `@ast-grep/cli@0.51.1`: ~105 MB on Windows (the platform package carries both `ast-grep.exe` and an identical `sg.exe`), ~15 s.
- `typescript-language-server@6.0.3` + `typescript@5.9.3`: ~26 MB, ~20 s.

No `.cmd` shim is ever spawned: ast-grep runs as the real `.exe`, JS servers run as `node <entry>`, npm runs as `node npm-cli.js`, and a `.cmd` found on PATH is unwrapped to the script it calls.

## Permissions

`read_hashed`, `edit_hashed` and `debug_node` register with `registerWorkspaceTool`, so Workspace write treats them like `edit_file` / `run_command`; Read only and plan mode refuse them. The ast-grep and LSP tools register the same way once their tool is installed (or found on PATH); before that, the first call asks, because it downloads into the harness home.

## Small-model hint

`plugin.mjs` exports `HINT`, a three-sentence instruction for a system prompt or skill:
read with `read_hashed`, edit with `edit_hashed`, use the LSP tools by symbol name and run `lsp_diagnostics` after editing TS/JS.
