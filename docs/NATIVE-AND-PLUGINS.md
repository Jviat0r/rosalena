# What is native, what is a plugin, and why updates won't break it

*Written 2026-11-08 after a pass over `harness/src` and `harness/plugins`.*

## The three kinds of code

**Native** means it lives in `harness/src` and `harness/ui`, and the app can't run without it:
- the agent loop and its built-in tools: read, write, edit, search, run_command, todo_write;
- the router client and the router itself (`router/`);
- runs, chats, threads and branching;
- approvals and access modes, sandbox, desktop control;
- context and compaction, goal mode and missions;
- the terminal, voice typing;
- the Claude Code engine, the OmniRoute manager;
- the MCP panel, Spend limits, Settings, the whole window.

**Core plugins** are 21 bundled plugins marked `"core": true` in their `plugin.json`. They are app
features that happen to use the plugin interface. They ship in every build and can't be removed.

They can be switched off, so a plugin you build to replace one doesn't collide with it. The
Plugins page asks first and says what turns off. A core plugin that should be on and fails to
load is shown at start.

| Plugin | What it does | What depends on it |
|---|---|---|
| commit-cadence | commits finished pieces, holds big ones for one question | Commits menu |
| todo-guard | the task list, keeps a run going while items are open | Progress strip, Tasks tab, goal mode |
| mcp-manager | MCP client and registry (mcp_servers / mcp_tools / mcp_call) | MCP button |
| process-tracker | finds programs a run left running | Running work > Background jobs |
| finish-loop-guard | stops a run that loops on its last steps | |
| rate-limit-failover | remembers which route ran out and steps around it | fallback lists |
| model-pin | keeps a run on one model when you picked one | per-chat model |
| skill-autoload | loads a skill when the work calls for it | |
| nested-instructions | reads a subfolder's AGENTS.md / CLAUDE.md | |
| local-llm, local-model-host, local-model-switch, local-model-monitor | the local llama.cpp server: find, load, swap, watch | local models, Local models tab, Monitor |
| solbrowser | your own browser for the agent | Settings > Your browser |
| browser | the agent's own Chrome for checking its work | |
| code-intel | hash-anchored edits, ast-grep, language servers | |
| creator-mode | builds sidebar plugins with verification and rollback | Creator button |
| advisor | the reviewer on every step | Settings > Agent |
| subagent-model-switch | role targets in data/roles.json | Model fallback > Advanced |
| reveal-file-location | Show in File Explorer | |
| style-lab (sidebar page) | the app's look: theme, palette, skins, what the window shows | your name > Style Lab |

**Optional plugins** keep their switch and can be turned off with nothing else breaking:
- tool plugins: comfyui, mcp-server, opencode-handler, vpn-exit-rotator, wifi-switcher;
- sidebar pages: Fuyu, Paper Reader, Poster Studio, Transformer 3D Lab, Video Editor, World
  Architecture 3D.

The Network menu says "unavailable" when the VPN or Wi-Fi plugin is off.

## "Plugins break when the harness updates": does that apply here?

That complaint is about plugins built **separately** from the app that hosts them: VS Code
extensions, Claude Code or OpenCode plugins from other authors. The host changes its API in an
update and plugins written against the old API stop working.

That isn't the situation for Rosalena's bundled plugins:
- **They ship in the same build as the app.** A user can't end up with a new app and an old
  bundled plugin.
- **The same test suite covers them** (1,200+ tests), and a release is gated on it.
- **A hook name the engine doesn't call is reported as an error** at load (`plugins.mjs`); it
  isn't silently ignored.

What could still go wrong, and what now guards it:

| Risk | Guard |
|---|---|
| A core plugin throws on load after a change, and its feature quietly disappears | `test/core-plugins.test.mjs` loads every core plugin with the shipped config and fails the build. At runtime the app shows "A built-in feature did not load" |
| A person switches off something the app relies on (Commits, MCP, Style Lab) without meaning to | Switching a core plugin off asks first and names what goes with it. It can always be switched back on, because the server refuses to remove one |
| A plugin you build collides with a built-in one (same job, same tool names) | Switch the built-in one off. Tool names already taken are refused at load, so a clash is reported, not silent |
| The engine's hook contract changes (a renamed hook, a different argument) | Hooks are named in `HOOK_NAMES` (`plugins.mjs`); an unknown hook is an error at load and fails the core test |

## Plugins people add themselves

User plugins (Creator mode, or "Add your own") are where the usual risk lives. They are written
against the current API and are not part of the test suite.

Today a sidebar page is re-verified in the sandbox when installed, and can be rolled back. A
tool plugin is asked to be trusted.

**Not done yet, worth doing before opening plugins up:** an `api` version in `plugin.json`
(e.g. `"api": 1`), checked at load. A plugin written for an older API would then get a clear
"needs an update" message instead of failing in a confusing way.

## If you want fewer moving parts later

The most central core plugins could move into `harness/src` as ordinary modules: todo-guard,
commit-cadence, the mcp-manager client and process-tracker. Then they wouldn't use the plugin
interface at all.

There's no pressure to do this now: the core marking, the refusal to switch them off and the
load test give the same safety. It's mainly a tidiness call.
