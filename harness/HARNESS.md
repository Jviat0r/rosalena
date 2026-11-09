# The Harness (v0) â€” setup and status

The agent runtime that sits on top of the model router. This is the piece from
`MASTER-PLAN.md` Â§5.2 â€” orchestrator, workers, judge â€” reduced to the smallest
version that actually runs and can be verified.

```
Rosalena Harness/harness/
  src/cli.mjs       headless CLI: --check, one-shot, interactive, plugin commands, --voice
  src/agent.mjs     the loop: roles, tool calls, judge, budgets, hooks, timeouts
  src/tools.mjs     read_file write_file list_dir search run_command delegate
  src/stream.mjs    SSE reading and tool-call fragment reassembly
  src/memory.mjs    compaction (rolling summary) + the project-aware JSONL store
  src/context.mjs   per-tool budgets, measured token weights, the run's tool cache,
                    the one token estimator, and the context meter's arithmetic
  src/watchdog.mjs  step/tool deadlines, abort plumbing, the stall detector
  src/goal.mjs      .goal-state.md: read, format, and the single append path
  src/store.mjs     module store: index, install/update/verify, sha256 + ed25519
  src/plugins.mjs   the plugin host: discovery, validation, failure isolation, hooks
  plugins/          nine bundled modules + whatever the store installs
  store/            the catalogue (index.json) and the modules it publishes
  harness.config.json    the override layer for plugin enable/config
  test/             agent, guards, memory, plugins, ported, store, stream,
                    judge-fix, voice, watchdog, goal, context, context-compaction,
                    ui-context â€” 444 tests, scripted router
```

## What it does

You give it a task. It runs a tool loop against a **task class** (never a model
name), calls tools, feeds the results back, and stops when the model answers.

```
node src/cli.mjs --check
node src/cli.mjs "add a --json flag to ContentFarm/scripts/cf.ts"
node src/cli.mjs                       # interactive; history persists across turns
node src/cli.mjs --root D:\some\project --steps 20 --judge "fix the failing test"
node src/cli.mjs --ui 8090             # the same runs, in a browser
```

`--check` verifies the whole setup: router reachable, classes present, which
providers have keys, budgets. Run it first whenever something looks wrong.

Flags: `--root` (workspace, default cwd) Â· `--class` (orchestrator class) Â·
`--worker` Â· `--judgeClass` Â· `--steps` Â· `--max-usd` Â· `--judge` (verify the
answer) Â· `--fixes N` (fix rounds after a rejection, 0â€“3, default 1) Â·
**`--no-shell`** (drop `run_command` entirely â€” the only real confinement, see
Safety rules below) Â· `--no-stream` (one buffered reply per step instead of SSE) Â·
**`--no-memory`** (no store, no `remember`/`recall`, no compaction) Â·
`--memory-file` (default `~/.rosalena/memory.jsonl`) Â· `--context-window` Â·
`--compact-at` (default 0.55) Â· `--keep-last` (default 8) Â· `--summary-class`
(default `fast`) Â· `--router` Â· `--quiet` Â· **`--ui [port]`** (serve the browser
window; default 8090) Â· `--plugins` (list them) Â·
`--plugin <id>:<cmd>` (run one headlessly) Â· **`--context`** (the per-tool budgets
and the measured token weights; `--context --json` for the machine-readable form). Goal and watchdog: `--goal` Â·
`--goal-file <path>` (naming one implies `--goal`; default `.goal-state.md`) Â·
`--step-timeout <s>` (default 300) Â· `--tool-timeout <s>` (default 300, raised to at
most 600 for a tool that needs it) Â·
`--repeat-limit N` (the opt-in stall backstop; default 0 = off, because the bundled
`rosa-finish-loop-guard` plugin owns repeat policy). `--hardware` prints this machine and
which catalog models it can hold (`--hardware --json` for machines) - see "What this
machine can run" below. `--help` prints this list.
Speech: `--voice`, `--stt`, `--mic`,
`--model`, `--voice-seconds`, `--voice-status` â€” see `src/voice/README.md`.

Events go to **stderr**, the answer goes to **stdout**, so
`node src/cli.mjs "..." > answer.txt` captures only the answer.

## Plugins

Everything past the core loop is a module. A plugin is a folder under `plugins/`
with a `plugin.json` manifest and an ESM entry exporting a definition object
(a bare `.mjs` file with no manifest works too):

```js
export default {
  id: "example",
  description: "one line, shown by /plugins",
  tools:    (ctx) => [{ name, description, parameters, run }],   // joins the model's tools
  commands: (ctx) => ({ greet: async (argv) => "hi" }),          // /example greet
  hooks:    (ctx) => ({ beforeStep: (info) => ({ note: "â€¦" }) }),  // advise the loop, never act on it
  status:   (ctx) => "ready",                                    // shown by /plugins
  setup:    async (ctx) => {},                                   // optional, runs once at load
};
```

A plugin is third-party code, so the host enforces the rules rather than trusting
the module:

- a plugin that throws while loading is **reported and skipped**; it cannot take the
  harness down with it
- a tool whose name would shadow a built-in (`read_file`, `run_command`, â€¦) or
  another plugin's tool is **dropped, with the reason recorded** â€” silently
  replacing `read_file` would be a security bug, not a feature
- if `setup()`/`tools()`/`commands()` throws, the plugin registers **nothing**; half
  a module is worse than one that failed cleanly
- importing a plugin never performs work; it acts only when called

`harness.config.json` is the override layer: a plugin's own manifest holds its
defaults, entries there win, and `enabled: false` switches a module off without
deleting it.

Nineteen ship with the harness, and `bundled: true` in a manifest is what marks them
first-party (`/plugins` prints `bundled` or `installed`). The sidebar pages are listed
separately, under "Sidebar plugins and Creator mode" below:

| Plugin | Gives |
|---|---|
| `rosa-creator-mode` | the `creator_*` tools Creator mode builds sidebar plugins with: drafts, the verifier, a publish that only installs verified files, rollback |
| `rosa-mcp-server` | the harness tools over **MCP on stdio** - `node src/cli.mjs --plugin rosa-mcp-server:serve` |
| `rosa-mcp-manager` | the other direction: a registry of MCP servers, plus `/mcp-manager add \| probe \| tools \| call` to health-check them and call their tools |
| `rosa-local-llm` | `/local-llm models \| scan \| status` plus a `local_model_status` tool: which GGUF files exist and what the live server's slot layout is |
| `rosa-local-model-monitor` | a read-only live view of the llama.cpp server (health, model, context, slots, queue) plus the harness's own model calls, recorded through the `llm/stream` hook and served at `/monitor` |
| `rosa-local-model-switch` | which GGUF models are installed, which one is being served, which the card can hold, and the exact `llama-server` command to switch - without starting or stopping anything |
| `rosa-local-model-host` | the action half of `rosa-local-model-switch`: start, stop or swap the local server when a run is pointed at `local/<model>` |
| `comfyui` | the local **renderer** half: `comfy_status` (up?, version, VRAM, queue, installed checkpoints) and `comfy_generate` (fill a configured workflow preset, queue it, wait, save the produced files into the workspace) |
| `rosa-opencode-handler` | OpenCode's free models inside the harness: `/opencode-free status \| models \| use`, the three wire gates, and the free window's last failure and reset estimate |
| `rosa-subagent-model-switch` | the role presets in `data/roles.json`: which model a worker of each role starts on, with its title, prompt addendum, judge flag and optional effort level, validated against the router on every write |
| `rosa-process-tracker` | finds work a run left running outside the harness, ledgers it, and tells the model to stop it |
| `rosa-finish-loop-guard` | warns once, then ends the run, when a model loops on its final steps |
| `rosa-todo-guard` | adds `todo_write`/`todo_read` and nudges when the list goes stale with work still open |
| `rosa-model-pin` | pins a run to one router target and retries that target instead of drifting to another model |
| `rosa-rate-limit-failover` | remembers which provider route ran out of budget or fell over, reports the record, and keeps the next call off it - the router fails over per call, this is the memory it lacks |
| `rosa-reveal-file-location` | resolves a path and selects it in the OS file manager - a `reveal_file` tool that **reports** and a `/reveal-file-location reveal` you type to actually open it |
| `rosa-wifi-switcher` | the Wi-Fi networks this machine can see, and connecting to one: a saved profile, or a new network whose password is typed on the page |
| `rosa-vpn-exit-rotator` | the two VPN clients on this machine, **one at a time**: which one is installed and running (from `tasklist`, with pids), turning one on so it ends the other first, and stopping only that exact image - plus `/exits` |

These are Rosalena's own plugins, named `rosa-*` since 2026-11-08 (an old name in a saved
setting still works: `src/plugin-names.mjs`). Several began as ports of DeepSeek Harness
plugins Jayden wrote or installed; those now live in their own project
(`D:\AppDev\dsh-plugins`) and the two are not kept in step. Where a behaviour did not
survive the move to a headless host, that is stated rather than faked:

- **The DSH proxy pool (`exit-rotator`) is not ported.** It was, until 2026-11-03, and
  was removed: rotating proxies to get around providers' per-IP rate limits risks
  provider bans and terms-of-service trouble, which is the wrong trade for an app built
  on free cloud tiers. `rosa-rate-limit-failover` moves a run to another route instead.
- **`rosa-mcp-manager` keeps no long-lived server processes.** Every operation is
  spawn â†’ handshake â†’ exit, so a probe cannot leave an orphan for
  `rosa-process-tracker` to report. Its registry is **human-writable only**: no tool can
  add a server, because "register a command, then call it" is a shell by two hops.
- **`rosa-reveal-file-location` launches nothing unless asked.** The tool reports the
  path and the command; opening a window on the desktop is the human's call, made by
  typing `/reveal-file-location reveal <path>` or setting `allowLaunch: true`. It
  also never touches the system clipboard.
- **`rosa-rate-limit-failover` cannot re-run the step it lost.** The DSH original hooks the
  request-error waterfall and calls the session controller's `selectModel`, so a turn
  survives a 429 and carries on. A Rosalena plugin has no such seam: `llm/stream` only
  observes and `beforeStep` can only re-target the *next* call, so the run ends there.
  What survives the move is the memory - the record is on disk, the estimated window
  is labelled as an estimate, and the next run starts off the route that is out of
  budget.
- **Two originals' bugs are fixed here, not preserved.** The original health-check
  defaulted to `api.ipify.org?format=json` while its parser accepted only a bare
  IPv4, so *every* check failed and the pool stayed empty forever; and its round
  robin turned `indexOf()`'s âˆ’1 into 0 before adding 1, skipping the first proxy on
  every rotation. Both are regression-tested in `test/ported.test.mjs`.

### `rosa-vpn-exit-rotator`: two VPN clients, one at a time

Outline and ExpressVPN are both installed here, and turning one on while the other is
up leaves two clients fighting over the default route - a broken network, not a
faster one. So the plugin is the exclusivity rule plus honest reporting, and nothing
else:

```
status | outline on|off | express on|off | rotate | doctor
vpn_exit_status   {}                  read-only
vpn_exit_toggle   {provider, on}      changes the machine
/exits                               the page: ui/exits.html, GET /api/exits,
                                     POST /api/exits/toggle (token-gated)
```

**A client is not a tunnel.** `on` starts the executable detached (`detached: true`,
`stdio: "ignore"`, then `unref()`), so the harness is not its parent and closing the
harness does not close the VPN. `off` ends every process whose image name is exactly
`Outline.exe` or `ExpressVPN.exe`, one `taskkill /PID` each - never `/IM`, never a
wildcard, never `/T` - because Outline is an Electron app and its five pids share
that one image name. The vendors' own services (`OutlineService.exe`,
`ExpressVPN.VpnService.exe`) hold the tunnel separately, need elevation, and are
listed by `doctor` and never touched; `off` says that in as many words instead of
implying the tunnel went down.

**Nothing is claimed that the process table does not say.** Running is a `tasklist`
row, with its pids; not running is tasklist's `INFO: No tasks...` line; anything
unreadable is `unknown`, and unknown is never drawn as off. A start counts only once
the image is sampled back out of `tasklist` (4 x 700 ms), a stop only once it is gone
(3 x 300 ms). A refusal - not installed, taskkill denied, state unreadable, or a
request that would leave no exit up - is a sentence with `ok: false`, not an
exception, and a start that fails after the other client was stopped says plainly
that no exit is up rather than quietly restarting the old one.

**Two seams make it testable without a VPN.** One injected
`run(command, args, options)` is the only thing that lists, starts or stops a
process; one injected `stat(path)` is the only thing that reads the filesystem. Both
have real defaults, and `test/plugins-vpn-exit-rotator.test.mjs` drives all 50 cases
from a stub process table - five pids, a missing install, a throwing runner, "Access
is denied", a client that exits at once - touching no real process and needing
neither client installed. `GET /api/exits` costs two filtered `tasklist` calls
(~190 ms, against ~370 ms for one full list) and starts nothing, which is what makes
it safe on every sidebar render.

Despite the name, this plugin rotates nothing on its own: it turns two desktop VPN
clients on and off when the person asks. (The DSH proxy-pool plugin, `exit-rotator`,
is not part of Rosalena.)

### `comfyui`: the local renderer, driven by workflow presets

The suite's text half is llama.cpp on `:8080` through the router; the media half is
ComfyUI on `:8188`, and this plugin is it. The API is small and stable:

```
GET  /system_stats                          version, devices, VRAM
GET  /queue                                 running / pending
GET  /object_info/CheckpointLoaderSimple    the checkpoint filenames that exist here
POST /prompt            {prompt: <graph>}  -> {prompt_id}
GET  /history/<prompt_id>                   -> outputs: images/gifs/audio + metadata
GET  /view?filename=&subfolder=&type=       the bytes
```

**Nothing starts, stops or interrupts ComfyUI here.** One RTX 3090 holds one big
model, so whether the writer is unloaded for a render is a machine-wide decision that
belongs to whatever owns the GPU (ContentFarm's `gpu-switch.ps1`); a tool a model can
call mid-run is the wrong place for it. `comfy_generate` only queues work to a server
that is already up, and `comfy_status` says plainly when nothing is listening.

**The graph is config, not code.** An API-format graph names model files that exist on
one machine; shipping one inside the harness would fail validation on a flyspec of a
filename difference. So a preset is `{ workflow: "<path to JSON>", label?, kind?, params? }`
under `plugins.comfyui.config.presets`, and generation fills placeholders in it:

```
{{prompt}} {{negative}}        from the tool call
{{width}} {{steps}} {{seed}}   from params (preset defaults, overridable per call)
```

An exact placeholder keeps the value's JSON type - `"{{steps}}"` becomes `20`, not
`"20"` - because ComfyUI validates input types per node. Keys are never substituted:
node ids and `class_type` are the graph's structure. A placeholder left unfilled is
reported by name *before* anything is queued, rather than sent as the literal string.

The five presets that ship configured point at this machine's ContentFarm graphs
(`ContentFarm\workflows\image-qwen.json`, `video-ltx.json`, `music-minimax.json`)
because those name the weights that are actually installed. Move or copy any JSON
elsewhere and change `workflow`; the resolved path is in every error message. Files
land in `<workspace>\comfyui\<prompt-id>-<name>` and the tool returns their paths -
media is binary, so the model gets a path to use, not an inlined blob.

```
/comfyui status     up? queue? which checkpoints?
/comfyui presets    what is configured and where each workflow lives
```

### `rosa-local-model-switch`: the command, not the switch

One RTX 3090 serves either the writer on `:8080` or the renderer on `:8188`, never
both, so "switch the local model" is a decision with a machine-wide cost. This plugin
answers the question and stops there: it **never starts, stops or kills a server**, and
every request it makes to llama.cpp is a `GET`.

```
/local-model-switch list             what is installed, what the server is serving, what the card can hold
/local-model-switch now              the resident model, its own context, its busy slots, its fit verdict
/local-model-switch plan <model> [ctx]   the exact llama-server command, the GiB it needs, and the verdict
```

Two refusals make it safe to leave attached to a model:

- **Busy means busy.** `/slots` saying a slot is processing is a `REFUSED` line printed
  *before* the command, so the command is never pasted while a request is generating.
  `/slots` is a build option, so when it is missing the answer is "unknown", not "idle".
- **A model that will not fit gets no command at all.** Full offload only: the `-ngl` is
  the model's layer count (or llama.cpp's own `99`), never a partial offload that would
  run at a few tokens a second. A model that is in the catalog but not on disk gets the
  quant to download and its URL, and "no command yet".

The numbers come from `src/hardware.mjs` and `src/catalog.mjs`, not from a second copy:
`probeHardware()` for the card, `scanLocalModels()` for the shelf (one scan, not two),
`estimateModelNeeds()` for weights + KV + runtime. Verdicts are `fits now - N GiB spare`,
`fits when idle`, `will not fit`, or `unknown (reason)`. Real output on this machine,
with a 27B resident and a slot generating:

```
  card    NVIDIA GeForce RTX 3090 - 0.9 GiB free of 24.0 GiB, 32.0 GiB RAM free
  fits    fits when idle - 19.9 GiB does not fit the 0.9 GiB that are free, but it fits
          the card's whole 24.0 GiB - it needs whatever holds the card now to stop
```

### `rosa-subagent-model-switch`: the role presets, validated

A worker's model is decided by `data/roles.json`, and a typo there fails at request
time - inside a run, looking like a network problem. So this plugin proves a target
before it writes one:

```
/subagent-model-switch show              the file, the presets, the addenda, what cannot be used
/subagent-model-switch set <role> <target>   point that role's workers at a class or a curated provider/model
/subagent-model-switch reset <role>      restore the shipped preset
```

A legal target is a router **class** (`orchestrate`, `code`, `fast`, `judge` - a failover
chain) or a curated `provider/model` from `router/router.config.json` `models[]`. Writes
are a temp file then a rename, keys the plugin does not own are preserved, and a file
that does not parse is reported and never overwritten.

`data/roles.json` is **meant to be edited by hand** - `show` prints each role's addendum
so the text is visible without opening the file, and `reset` puts a role back. Keys:
`title` (what the picker shows; `label`/`name` are read as aliases), `addendum` (the
paragraph added to that role's prompt), `subagent` (the target its workers start on),
`judge` (`true` runs the review pass), and optionally `effort` (`"low"`, `"medium"` or
`"high"`; absent means no opinion, which is why the shipped presets carry none). An
`effort` value outside those three is reported by `show` and refused on write, but it
does not make the file unreadable - the harness reader ignores the key, and only the
preference is wrong.

### `rosa-opencode-handler`: the free tier, proven before it is trusted

OpenCode Zen's free models answer only when the request looks like OpenCode's own:
it must stream, it must carry the OpenCode client headers and a `ses_`-shaped session
id, and its tool list must contain a tool named exactly `read`. Miss one and the
gateway answers `403 FreeTierError: OpenCode's free tier can only be used from within
OpenCode`, which reads like a broken key and is not. The router owns those three
gates (`requiresStream`, `clientHeaders`, `ensureTools`/`userAgent` on the
`opencode-free` provider, applied in `router/src/providers.mjs`), because the router
is what reaches the wire. This plugin is the part a router cannot be: a status
surface, a switch, and a ledger of what actually came back.

The free ids are `deepseek-v4.1-flash-free` and `glm-5.3-flash-free`, 200000 context
and 65536 output each, listed in the provider's `models[]` and the curated menu. The
shipped chains put DeepSeek in `orchestrate`/`code` and GLM in `fast`/`judge`.

```
/opencode-free status   probe the gateway; print one verdict, the three gates, the free
                        models, the last observed failure and a reset estimate
/opencode-free models   what is free, its limits, and which class chains name it (alias `who`)
/opencode-free use <id> [--class fast] [--write]
                        make one free model first in a class; without --write it prints the
                        exact before/after chain and writes nothing
/opencode-free key      every credential source, masked
/opencode-free gates    the three gates as a checklist read from the router config
/opencode-free clear    forget this plugin's own observation record
```

Verdicts are kept apart on purpose: `USABLE` (the gateway streamed a reply with the
gates), `EXHAUSTED` (429 `FreeUsageLimitError`, print the reset), `REFUSED` (403
`FreeTierError` - a gate, not the key), `KEY` (401), and `ERROR` for everything else,
including a 200 whose body is not a completion. A 429 that carries `Retry-After`,
`x-ratelimit-reset` or a reset in the body is printed with where the time came from;
without one, the 24-hour window from the first observed hit is used and labelled an
estimate. DSH's `~/.dsh/rate-limits.json` is read as a second source, so a window
spent before the port is visible on the first run.

The `llm/stream` hook records two facts from real runs and decides nothing: the last
good free call, and the last failure whose error text names the free tier. The
`free_model_status` tool gives an agent the same report. Writes are opt-in twice -
`use` plans unless given `--write`, and a write keeps a `.bak-` copy, validates the
JSON, and refuses if any key outside the edited chain changed or the file moved on
disk. A router restart is needed to load the new chain.

**Honest limits:** the three gates were measured on this gateway, and a probe is a
real network call (16 tokens, zero-priced model, never a paid one) that spends a 429
when the window is already out. No live probe was made after the port because the
window was spent; the first `/opencode-free status` with the real key is the first
live check. `use` edits a class chain, not the curated menu.

## Sidebar plugins and Creator mode

A plugin can also be a **page** in the sidebar: a tool, a viewer, a game, a theme. It is
the same folder and the same `plugin.json`, with a `ui` block (and no `plugin.mjs` needed):

```json
{ "id": "rosa-poster-studio", "version": "1.0.0", "description": "...",
  "ui": { "title": "Poster Studio", "icon": "icon.svg", "page": "app/index.html",
          "permissions": ["storage", "files.save"], "libs": [] } }
```

Seven ship with the app (`bundled: true`): Poster Studio, Fuyu (a voxel island sandbox),
Transformer 3D Lab, World Architecture 3D, Style Lab, Video Editor and Paper Reader.
**Creator mode** (the Creator button in the composer, or ＋ Create in the sidebar) has the
agent build new ones; they install into `<ROSALENA_HOME>\plugins`.

A plugin page is code someone else (or a model) wrote, running next to the person's
chats, so the platform enforces what it may do instead of trusting it:

| Lock | What it does | Where |
|---|---|---|
| Sandbox | the page runs in an iframe with `sandbox="allow-scripts allow-downloads allow-pointer-lock"`, no `allow-same-origin`: an opaque origin, so it cannot touch the app's DOM, storage or cookies, and the API's same-origin check refuses it | `ui/plugin-host.js` |
| CSP | every plugin file is served with a policy that allows its own folder, `/plugin-lib/` and the SDK, nothing else: no `/api`, no other plugin, no network | `src/ui-plugins.mjs` |
| Bridge | the page's only way out is `postMessage` through the SDK; the app answers only from that frame, only known methods, only the permissions `plugin.json` declared (`storage`, `files.save`, `chat.compose`, `theme`) | `ui/plugin-sdk.js`, `ui/plugin-host.js` |
| Navigation | the desktop shell cancels any frame navigation that is not a plugin page from this server | `desktop/main.mjs` |
| Verify | static rules, then the page in a hidden Chromium window with the same sandbox and bridge: it must call `Rosalena.ready()`, pass its own `Rosalena.test()`s, report no errors or blocked requests, and not be blank; a screenshot is kept | `src/plugin-verify.mjs` |
| Publish gate | a draft installs only if its fingerprint (hash of every file) is the one that passed; edit a byte and publish refuses | `src/creator.mjs` |
| Rollback | every publish keeps the version it replaced; rollback restores one and keeps the current, remove moves to history, nothing is deleted; every action is a line in `creator\ledger.jsonl` | `src/creator.mjs` |
| Off switch | a plugin can be switched off without uninstalling; it is then not served | `src/creator.mjs`, `/api/plugins/ui/action` |

The agent's side is the `rosa-creator-mode` plugin: `creator_new`, `creator_write`,
`creator_read`, `creator_files`, `creator_verify`, `creator_publish`, `creator_rollback`,
`creator_status`, all scoped to `<ROSALENA_HOME>\creator\drafts\<id>`. The workflow and the
rules a plugin must follow are the `plugin-builder` skill (`skills\plugin-builder\SKILL.md`),
which Creator mode tells the model to load first. In the window, each plugin page has
Reload, Verify, Versions (roll back to any kept version, or remove) and Switch off, and a
page that reports an error while someone uses it shows a banner with Roll back.

```powershell
node src/plugin-verify.mjs plugins/rosa-poster-studio          # verify one folder (needs desktop/node_modules/electron)
node src/cli.mjs --plugin rosa-creator-mode:list                # installed plugins, kept versions, drafts
node src/cli.mjs --plugin rosa-creator-mode:rollback counter    # put the previous version back
```

Shared libraries live in `plugin-libs\` (three.js 0.187 with OrbitControls, pdf.js 4.10),
pinned and vendored with their licenses, because a plugin page has no network to fetch
them. `test\creator.test.mjs` covers the whole path, including a page that tries `/api`,
the internet, the parent window and browser storage and is caught on every one.

The SDK also runs one check of its own before a plugin's self-tests: every visible button,
field and link must be what a click at its centre lands on, and an element marked `hidden`
must really be hidden. Transformer 3D shipped with `.gl-fallback { display: grid }`, which
beat the `hidden` attribute and laid an invisible box over the whole 3D view, so none of its
buttons worked; the check names that box, and every bundled plugin passes it.

### The Plugins page (`/plugins`)

One page for both kinds of plugin, reached from the sidebar's "Manage plugins" row and the
More menu:

- **Sidebar pages**: switch any on or off (Creator's switches), remove the ones you added
  (their versions are kept, so the sidebar can put them back).
- **Agent tools** (`plugin.mjs` plugins: tools, hooks, commands): switch any on or off. The
  switches are saved in `<ROSALENA_HOME>\plugin-switches.json`, never in
  `harness.config.json`, win over it, and apply from the next message.
- **Add your own** from a folder holding a `plugin.json`. A sidebar page is copied into a
  Creator draft, verified in the sandbox and installed only on a pass (a failure stays a
  draft to fix). A tool plugin is code that runs with the app's own access, so the page asks
  you to confirm you trust it; it is copied into `<ROSALENA_HOME>\tool-plugins\<id>`, loaded
  beside the shipped ones (an id that is already taken is refused), and taken back out if it
  fails to load. Removing one moves its folder to `tool-plugins-removed\`, not the bin.
- **Create with Creator mode** opens a new chat with Creator mode on.

`test\plugin-manager.test.mjs` covers the switches, the trust step, a tool that fails to
load, removal, and a page import through the real verifier.

## The store: installing modules

The loader can already read `plugins/`; what it could not say is **where a
directory came from, whether it arrived intact, or how to move it to a newer
version**. That is the store, and it is the part of "plugin based like DeepSeek"
that was still missing â€” until now a module arrived by someone unzipping it.

```powershell
node src/cli.mjs --store                      # the catalogue and what is installed
node src/cli.mjs --store "info clock"         # one module, every version, its files
node src/cli.mjs --store "install clock@1.0.0"   # pin an exact version
node src/cli.mjs --store "install scratchpad"
node src/cli.mjs --store "update"             # everything to the index's latest
node src/cli.mjs --store "verify"             # is what is on disk what was installed?
node src/cli.mjs --store "remove clock"       # bundled plugins need --force
```

An index is one JSON document â€” modules, each with its versions, each version with
a shape, a source directory and a **sha256 per file**:

```json
{ "version": 1, "name": "rosalena-store",
  "modules": { "clock": { "latest": "1.1.0", "versions": {
    "1.1.0": { "shape": "folder", "source": "modules/clock/1.1.0",
               "files": { "plugin.json": "<sha256>", "plugin.mjs": "<sha256>" } } } } } }
```

`node store/build-index.mjs` **generates** that file from the module trees on disk,
so the hashes cannot drift from the files (and `--check` fails if they have).
Adding a directory is how you publish a version.

Two guarantees, and it matters which is which:

| | Proves | Cannot prove |
|---|---|---|
| `files` sha256 | integrity â€” the bytes you got are the bytes the index described | that the index is honest; whoever edits it edits the hashes |
| `signature` (ed25519) | authorship â€” this index was signed by a key in `store.trustedKeys` | nothing, if you never compare the key out of band |

So a **local** index (a file you put there) may be unsigned, and a **remote** index
must be signed by a key you listed or it is refused â€” `store.trustedKeys` in
`harness.config.json` is the trust anchor. A signature that does not verify is
refused either way, because an edited index is exactly what signing is for.

Refusals are enforced, not documented: an id or path that could escape the plugins
directory; a file whose hash disagrees with the index (staged, verified, *then*
moved, so a failure leaves nothing and no lock entry); overwriting or removing a
`bundled: true` plugin without `--force`; removing a plugin the store did not
install without `--force`; installing a folder module with no `plugin.json`.
Installing never imports the module â€” nothing from the store runs at install time.
`plugins/store.lock.json` records version, source and hash per file, and `verify`
compares it against the disk, so a hand edit (**changed**) and a file nobody
installed (**untracked**) are both visible. Lock keys are relative to `plugins/`,
which is why `verify` catches a stray `plugin/extra.mjs`.

Two modules ship in the index, and both earn their place: **`clock`** (1.0.0 local
zone, 1.1.0 adds a `zone` argument and `/clock zones`) because a model has no
clock, and **`scratchpad`** as a *single `.mjs` with no manifest*, so the store's
other shape is exercised too. `clock`'s two versions are how the update path is
tested on something real: the tool surface genuinely changes.

One property worth knowing: **an update takes effect on the next run.** Node caches
a module by URL, so a process that already imported `plugins/clock/plugin.mjs`
keeps the old copy. That is the safe behaviour â€” hot-swapping a plugin mid-session
would invalidate every per-session state and hook registration â€” and the CLI says
so instead of implying otherwise. `test/store.test.mjs` proves the point by asking
a **fresh process** what it loads.

## Hooks: how a plugin advises the loop

A plugin can also **advise** the loop. It never acts on it: the loop owns every
decision, and the hooks are six named points where a module may speak. Five of
them advise; the sixth only observes.

| Hook | Fires | Gets |
|---|---|---|
| `onRunStart` | once, before the first step | `task, cls, root, depth, tools, run, messages` |
| `beforeStep` | before each model call | + `step, maxSteps, target, lastAssistant` |
| `afterStep` | after that step's tool results are in | + `target, content, toolCalls, toolNames, toolCallKeys, toolResultsOk` |
| `beforeFinish` | when the model gives a final answer (no tool call), after the judge | + `step, answer, target`. A note sends the run back for another round: **`finishRounds` per run (default 5)**, shared by all plugins, so no plugin can keep a run alive but a real "eight items are still open" is honoured more than once |
| `onRunEnd` | once, on every way out | + the result: `answer, steps, stopped, error` |
| `llm/stream` | twice per model call: `phase: "start"` before the request leaves, `phase: "end"` when it settles | + `step, attempt, cls, target, routerUrl, stream, maxTokens`; on the end also `ok, ms, ttftMs, usage, finishReason`, or `error` and `reason` (`step_timeout`, `stream_truncated`, `call_failed`) |

What a hook may return (a bare string is read as `{ note }`); every field is
optional and the loop validates it before acting:

| Field | Effect |
|---|---|
| `note` | appended to the conversation as one user message, so the model reads it before its next call. Blocks nothing. |
| `stop` | end the run now, with this reason, reported as `stopped: "guard:<plugin>"`. |
| `model` | send this exact router target (`provider/model`) instead of the step's class. The router builds a **one-target chain** for a target, so a pinned step cannot fall back to another model. |
| `retry` | retry *this step's* failed call on the same target: `{ maxAttempts, initialDelayMs, maxDelayMs, jitterRatio }`, clamped by the loop. |

The rules that make this safe to expose:

- **`afterStep` fires after the tool results are appended**, so the history a guard
  sees always has every `tool_call` answered. A stop can therefore never leave the
  conversation in a state the next call would reject.
- **The loop validates, not the plugin.** `retry` is clamped (1â€“50 attempts) and a
  `model` that is not a string is ignored, so a broken guard cannot turn itself
  into an unbounded loop.
- **A hook that throws is disabled for the rest of that run**, and reported once. A
  guard that breaks must not break the loop it guards.
- **`run.state` is per-plugin**, over one Map per run, so two plugins can both use
  the key `pin` or `base` without reading each other's values.
- **`llm/stream` is an observer, not an adviser.** Its return value is ignored, so
  it cannot stop, retry or re-target a call; it exists so something outside the
  loop can report what the harness actually sent and how long it took. It is
  awaited inside the step loop, so it must not do I/O: the shipped
  `rosa-local-model-monitor` records one row and returns.
- An unrecognised hook name, or a hook that is not a function, is refused at load
  and pushed into the same `errors` list as a failed plugin.

The behavioural plugins are advisory first and forceful only as a last resort:
`rosa-process-tracker` never kills anything (it ledgers and asks), `rosa-todo-guard` never
blocks a step, `rosa-finish-loop-guard` warns once before it ends a run, and
`rosa-rate-limit-failover` moves a run off a provider route that ran out of budget
instead of stopping it.

### Commits, taste and skills that load themselves

Added 2026-11-03 from the harness research in `docs/research/harness-research-2026-11.md`
(another session built them against the 0.1.6 engine; they were reviewed and tested here).

- **`rosa-commit-cadence`** (plugin + skill). The model calls `checkpoint` when a piece is done;
  the harness reads the real diff and sorts it: **small** is committed, **large** (over 300
  lines or 12 files, a deleted file, lockfile, migration, CI or deploy config, auth code, a
  dependency bump, a binary, the person's own uncommitted edits) is held back, **blocked** (a
  secrets file, a key in an added line, a file over 5 MB) is never committed. Modes per
  workspace (`/plugin rosa-commit-cadence:mode off|ask|loose|autonomous`, `ask` by default, which
  holds everything): the person is asked once, at the end, and their reply is read by the
  harness at the start of the next run, so the model cannot approve for them. It never
  pushes, amends, rebases, resets or skips hooks, and commits with `git commit --only` so
  whatever the person staged stays staged. It uses two engine points: `beforeFinish` (a
  round to review held changes before stopping) and `registerWorkspaceTool` in
  `src/permissions.mjs` (so `checkpoint` runs without asking in Workspace write; Read only
  and plan mode still refuse it).
  - **The Commits menu** in the composer, next to Access, sets the mode for the open folder
    (`/api/commit-mode`): "Ask once at the end", "Small: commit · Big: ask" (loose, the
    set-it-and-leave-it setting), "Commit everything", "Don't commit". Disabled outside a git
    repo; a dot on its label means work is held back.
  - **The harness drives it, not the model's memory.** A live run on local Qwen3-Coder 30B
    ignored the skill, did the dependency first and never checkpointed. Now a passing check
    command (`npm test`, `tsc`, `pytest`...) with uncheckpointed work prompts a checkpoint in
    the next step; in loose mode a checkpoint mixing a risky file with ordinary ones answers
    with the two `files` lists to commit separately (a file importing a newly added package
    stays with the manifest); and a run that ends with work never checkpointed is sent back
    once. Re-run live on the same model and task: the typo fix and farewell were committed,
    the left-pad dependency and `pad.js` held, one question at the end, and "Commit them" in
    the next message committed them. `afterStep` now receives `toolResults` (name, ok, exit
    code per call) for this.
- **`rosa-skill-autoload`** (plugin). The `skill` tool shows names only and small models rarely
  call it. This loads `frontend-taste` when the request is UI work or a UI file is edited,
  `ui-check` after three UI files change, and `rosa-commit-cadence` at step 1 for a change request
  (a rule's `notTask` keeps questions like "why does the build fail?" out) or once a file is
  written, when `checkpoint` exists: once per run each, body only, capped at 6000 characters.
  A person's own copy of a skill wins.

- **`frontend-taste`** (skill). About 60 lines of MUST/NEVER design rules for small models:
  plan tokens first, no generic AI look, an accessibility floor. Original text; sources and
  licenses in `skills/frontend-taste/SOURCES.md`.
- **`ui-check`** (skill). `scripts/ui-audit.mjs` renders a page at 390/768/1440 px with the
  Chrome or Edge already on the PC (playwright-core, installed on first use) and prints
  PASS/WARN/FAIL lines a text-only model can act on. Checked here: a deliberately bad page
  gave 9 FAIL and 12 WARN, a clean one 0 and 0.

`aeo-ready`'s scripts used a browser path that only existed on one machine (and put its
username in the build); they now share `scripts/browser.mjs`, the same lookup ui-check uses.

The MCP surface is **allow-listed and read-only by default** (`read_file`,
`list_dir`, `search`). `write_file` and `run_command` are opt-in through config,
because an MCP client that can call `run_command` gets a shell on this machine.
Tool results still pass through the same workspace-root check, so an MCP client
cannot read outside the root either â€” verified in `test/plugins.test.mjs`.

To let DSH drive the harness, add it in Settings > MCP servers (the
`dsh-mcp-manager` plugin) with command `node`, args
`["D:\\AppDev\\Rosalena Harness\\harness\\src\\cli.mjs", "--plugin", "rosa-mcp-server:serve"]`,
then turn it on there. The harness is not added to that file on your behalf.

### Closing the gaps with the S and A tier (2026-11-03)

From the feature comparison in `docs/research/harness-research-2026-11.md`. Each one is
tested (the file is named), and the window controls were checked in a real Electron window.

| Gap | What Rosalena does now | Where |
|---|---|---|
| OS sandbox for commands | Settings > Sandbox commands, `--sandbox`: commands run as a Low-integrity process on Windows (bwrap on Linux, sandbox-exec on macOS) and can write only in the workspace and a per-run temp folder; a write elsewhere is refused by the OS. Reads and network are not confined; background jobs are off while it is on. | `src/sandbox.mjs` (+ `src/sandbox/lowrun.cs`), `test/sandbox*.test.mjs` |
| Auto approval | Access > Auto, `--access auto`: Workspace write, but what would ask the person goes to a reviewer model (class `fast`); 3 refusals in a row or 20 in a run and it asks the person again; an unreachable reviewer means asking. | `src/auto-approve.mjs`, `test/auto-approve.test.mjs` |
| Undo for shell edits | A step that runs a changing command is snapshotted before and after in a shadow git repo under `<ROSALENA_HOME>/snapshots` (never the project's own .git); undo restores each file to its state before the earliest change, journal or snapshot. `.env*`, ignored folders and files over 10 MiB are never snapshotted. | `src/snapshots.mjs`, `src/undo.mjs`, `test/snapshots.test.mjs` |
| Branch a chat | Hover any of your messages > Branch: edit it and send; a new conversation continues from the turn before, the original is untouched (`branches.json`). | `ui/app.js`, `src/ui.mjs`, `test/branch.test.mjs` |
| A real browser | Bundled `browser` plugin: one persistent Chrome/Edge with its own profile, `browser_open/snapshot/click/fill/select/press/scroll/read/screenshot/console/upload/close`, refs per element, diffs after each action, page text fenced as data, no password or card typing. Plus `web-access` skill, `web_fetch` that asks for markdown and reads the main content, `mcp_tools` with argument signatures, and `keepAlive` MCP servers. | `plugins/rosa-browser/`, `skills/web-access/`, `src/tools-extra.mjs`, `plugins/rosa-mcp-manager/` |
| Editors (ACP) | `node src/cli.mjs --acp`: Agent Client Protocol v1 over stdio for Zed, JetBrains and others; sessions continue, approvals become permission requests, modes include auto and plan. | `src/acp.mjs`, `test/acp.test.mjs` |
| Long goals | A goal-mode answer that leaves the goal open is sent back (3 times by default) unless it says it is blocked; after a compaction the goal and its latest state are put back; a goal chat in the window, or `--rounds N --hours H`, runs round after round with a fresh context until the goal is done, blocked, failing or out of budget. | `src/goal-runner.mjs`, `test/goal-runner.test.mjs` |
| Subagents at scale | `delegate {tasks: [...]}` runs up to 8 at once (4 at a time), each in its own git worktree that starts from the work in progress; changes are applied back, and a change that no longer applies is kept on its branch. | `src/worktrees.mjs`, `test/worktrees.test.mjs` |
| More hooks | 14 now: beforeTool (can refuse a call; fails closed), afterTool, beforeCompact, afterCompact, onPermission, onSubagentStart/End, onError, plus the six before. Every hook call has a time limit. | `src/plugins.mjs`, `test/hooks-extended.test.mjs` |
| Code intelligence | Bundled `rosa-code-intel` plugin: hash-anchored `read_hashed`/`edit_hashed` (a stale edit is refused), `ast_search`/`ast_rewrite` (ast-grep), LSP definition/references/hover/diagnostics/symbols/rename, and `debug_node` breakpoints. ast-grep and the TypeScript server install on first use into `<ROSALENA_HOME>/code-intel`. | `plugins/rosa-code-intel/`, `test/code-intel.test.mjs` |
| A reviewer every step | Settings > Reviewer on every step (`advisor` plugin, off by default): a second model checks each step that changed something and speaks only about concrete problems. | `plugins/rosa-advisor/`, `test/advisor.test.mjs` |
| Other tools' instruction files | GEMINI.md, AGENTS.override.md, .cursorrules, .windsurfrules, .clinerules, .rules, copilot-instructions, Cursor `alwaysApply` rules; a subfolder's own AGENTS.md loads when a file there is first touched. The budget is spent innermost first; outside @imports are refused; HTML comments are dropped. | `src/instructions.mjs`, `plugins/rosa-nested-instructions/`, `test/instructions.test.mjs` |
| A benchmark number | `bench/run.mjs`: 8 tasks graded by hidden tests copied in after the run, same model for every harness (Rosalena and OpenCode through the same llama-server). `--json` gives one result line and an exit code per outcome; `--version`. First result (2026-11-04, Qwen3-Coder 30B-A3B Q4_K_S on one llama-server, one run per task): Rosalena 8/8, median 67 s; OpenCode 2.0.32 6/8, median 101 s, two runs hit the 6 min limit. Details and voided runs: `bench/results/summary-2026-11-04.md`. | `bench/`, `src/cli.mjs` |

The full list of what the November reports recommend, with what is done, is in
`docs/research/BACKLOG-from-reports-2026-11.md`.

### Asking what a run did (`list_runs`, `run_status`, `read_run`)

The MCP surface is not only files. Every run is recorded under
`<ROSALENA_HOME>\runs` (see `runs.mjs`), and three **read-only, always-on** tools read
that store, so a client can ask "what did the harness actually do?" without a shell:

| Tool | Arguments | Returns |
|---|---|---|
| `list_runs` | `limit?`, `status?` | one line per run: id, status, steps, time, task |
| `run_status` | `id` (prefix ok) | JSON: status, running/stale, steps, tools, answer, error |
| `read_run` | `id`, `limit?` | JSON: the final record plus the run's own event log |
| `cancel_run` | `id` (prefix ok) | `{ok, reason}` â€” the run stops at its next step |

Cancellation is a shared file in the store (`<runId>.cancel`), not a signal, so it works
for a run started by another process; `node src\cli.mjs --cancel <id>` does the same thing
from a shell. A cancelled run closes as `status:"stopped", stopped:"cancelled"` â€” see
`docs\INTEROP.md` Â§2.5.

Starting work is separate and **opt-in**, because it spends tokens and GPU time â€” set
`{"plugins":{"rosa-mcp-server":{"config":{"allowTasks":true}}}}` to expose `run_task` and
`spawn_subagent`. `run_task` returns a run id immediately rather than blocking; poll it
with `run_status`. A configured `tools` list narrows the *file* tools only and never
removes run inspection (`allowRuns: false` does that deliberately).

### Asking what the suite is made of (`list_plugins`)

The other read-only always-on tool is the module inventory, and it is the first thing a
client needs before it can use anything else:

```
10 module(s) in D:\AppDev\Rosalena Harness\harness\plugins
  comfyui            v0.1.0   bundled   2 tools comfy_status, comfy_generate  rosa-comfyui:status, rosa-comfyui:presets
                     Local renderer: health, queue, installed checkpoints, and generation from API-format workflow presets.
  ...
```

Each row gives the module's id, version, origin (`bundled` for first-party, `installed`
for the store), and what it adds â€” tool names, commands in the `--plugin` spec form, hook
counts â€” plus a one-line description. `json: true` returns the same structure to parse,
including `disabled` (switched off by config) and `errors` (anything that failed to load,
which a client otherwise has no way to see). It reports the install's real override layer,
so a module you switched off is listed as disabled rather than silently absent.

It loads the plugins instead of reading manifests alone, because "which tools does this
module add" is the useful half of the answer and loading is how the harness finds out;
importing a plugin is contractually free of side effects, and ESM caches the modules after
the first call.

## The role split

| Role | Class | Does |
|---|---|---|
| Orchestrator | `orchestrate` | runs the tool loop, plans, decides, delegates |
| Worker | `code` / `fast` | runs a bounded sub-task via the `delegate` tool |
| Judge | `judge` | checks the final answer against the task (opt-in) |

`judge` is cloud-first in the router config on purpose: a judge sharing the
author's blind spots is worse than no judge.

Each role is also a **preset** in `data/roles.json` beside the harness root: its
`title`, the `addendum` paragraph added to that role's prompt, the target its delegated
workers start on, whether it judges, and optionally an `effort` level. That file is
yours to edit; `/subagent-model-switch show` prints it with every target checked against
the router, and `set`/`reset` write it atomically.

## Streaming: the same answer, sooner

Every step is a stream by default (`--no-stream` asks for one buffered reply per
step). Prose is written to stderr as it arrives, so a slow local model looks alive
instead of hung: measured against the live router and the local 27B, the first token
of a warm step arrived in **191 ms** while the step took ~2 s, and a cold step put
the first token at **1.9 s** instead of showing nothing until it finished.

This needed its own module (`src/stream.mjs`) rather than a flag because of tool
calls. An OpenAI-compatible stream does not send a tool call, it sends **fragments**
of one, and `delta.tool_calls[0]` means "the first fragment in this frame", not "the
first call". From the real local model, one `read_file` call arrived as six pieces:

```
{"      "path":"      hello      .txt      "      }
```

Assembled by `index`, those fragments are valid JSON and the tool runs; assembled by
array position they are not. Only fragments of the same call are appended, `id` and
`name` are taken from the first fragment that carries them, and a provider that omits
`index` continues the previous call. Two calls interleaving in one stream is a test,
not a hypothetical.

Three properties the transport keeps:

- **A buffered reply is not an error.** If anything in the chain ignores
  `stream: true` â€” or labels SSE as JSON, or JSON as SSE â€” the reply is read the way
  it actually arrived and the step succeeds. Streaming is a transport preference, not
  a contract to enforce on a provider.
- **A truncated stream is a failure, not a short answer.** It carries what arrived
  (`err.partial`) for the log, and the loop spends **one spare attempt** on it. That
  is the one failure the loop may retry on its own authority, because tool calls only
  run after a step's stream is complete, so a truncated step has had no side effects.
  The router cannot do it for us: it may already have forwarded bytes.
- **A model that thinks out loud is visible.** `reasoning_content` is accumulated and
  reported as `reasoningChars` on the step event, but never becomes the answer â€” which
  is how a reasoning model that spends its whole budget on hidden thinking stops
  looking like a silent provider.

## The window: the harness in a browser

`node src/cli.mjs --ui 8090` serves a real page at `http://127.0.0.1:8090/`. The
terminal stays the tool you script; this is the one you look at. Nothing to build and
nothing to install: `src/ui.mjs` is a `node:http` server, and the client is
`ui/index.html` plus three files it loads (`app.js`, `format.mjs`, `styles.css`) as ES
modules. There is no bundler step, so editing a file and reloading the page is the whole
loop.

Every message is its own run, and a follow-up names the run it continues. Which runs make
one conversation is kept in `<ROSALENA_HOME>\threads.json` (each follow-up points at the
conversation's first run), so the sidebar lists a conversation once, under its first
message, with "N messages", and `GET /api/chat?id=<any turn>&thread=1` returns every turn
oldest first. Before this, each follow-up showed up as a separate chat; follow-ups sent
before the change were never linked, so they stay separate rows. The Recent section folds
like the others, and the fold is saved.

`src/ui.mjs` also builds the plugin host the CLI builds (`loadPlugins`, lazily, on
the first chat), so a run started in the browser gets the same plugin tools and
hooks a run started in a terminal does. That is what makes
`http://127.0.0.1:8090/monitor` possible: a second page, served from
`ui/monitor.html`, that shows the local llama.cpp server and the harness's own
model calls, polls one route every two seconds, and writes nothing at all.

What the page gives you that a console cannot:

- **A transcript, not a log.** Prose is rendered as markdown (headings, lists, quotes,
  inline code, fenced blocks with a Copy button) while it streams, with a blinking
  caret on the bubble that is still arriving. Every step ends with a meta line: the
  model that answered, frames, time to first token, total, and how many tool calls it
  made - so a slow local step and a slow provider step look different.
- **Tool calls as cards**, collapsed: `read_file HARNESS.md · 7ms · ✓`, opening to the
  arguments and the real result. A run that only called tools keeps a meta line and no
  empty panel.
- **A sidebar of two histories**: your Rosalena chats (status, steps, duration) and the
  sessions this machine already holds from Claude, Codex, opencode and DSH, readable in
  the same window. Search filters both; `Ctrl/Cmd+K` starts a new chat, `/` jumps to the
  filter, `Esc` stops the run on screen.
- **A model picker that is honest**: the four task classes (the router decides the model)
  plus any concrete target the router advertises. Wildcards like `local/*` are routing
  families, not selectable models, so they are not offered.
- **Attachments and a Stop that works mid-step**: files are posted as base64, saved
  under `<home>\attachments\<run>\`, and named in the task so the model opens them with
  `read_file`. A live stats strip shows steps, tool calls, elapsed time and tokens when a
  provider reports them.
- **A context gauge in the header**: the ring, the percentage and the three rows
  (system prompt, tool definitions, messages) of the request the next step would send,
  filled from `ui/context` as the run goes and from the run's record after a reload. A
  compacted turn appears in the transcript as its own collapsed marker, not as a message
  - see "The context meter" below.

The API behind it is small enough to read:

| route | what it does |
| --- | --- |
| `GET /` | the page, with the session's token substituted |
| `GET /monitor` | the local model page (`ui/monitor.html`): read-only, and token-free because it only reads |
| `GET /usage` | tokens and cost (`ui/usage.html`): the 1/30-day ledger with a per-provider/model table and an estimated list price |
| `GET /network` | Wi-Fi (`ui/network.html`): the saved profiles, the visible networks, and the one form that can join one |
| `GET /exits` | VPN exits (`ui/exits.html`): Outline and ExpressVPN, one at a time, each with a switch |
| `GET /api/usage?days=1\|30` | the router's ledger relayed through this server, plus the prices from its config, so the page never holds the router's token |
| `GET /api/wifi` | the interface, saved profiles and visible networks; read-only and outside the token check |
| `POST /api/wifi/connect` | join a saved or new network: `{ssid, password?}`; token-gated |
| `GET /api/exits` | both VPN clients: installed, running, their pids; two filtered `tasklist` calls, read-only and outside the token check |
| `POST /api/exits/toggle` | `{provider: "outline"\|"express", on}` or `{rotate: true}`; token-gated, and it stops the other client first |
| `GET /api/local-model` | one probe of the local llama.cpp server, plus this process's recent model calls |
| `GET /api/health` | router up? which models? workspace, run counts |
| `GET /api/graph?limit=` | the run store as a graph: `nodes`, `edges`, `roots`, `orphans`, `counts` - an orphan is a child whose parent is outside the window, and it is never given a fake parent |
| `GET /api/files?path=` | one directory of the workspace, directories first: read-only, 403 outside the workspace, 404 with a sentence for a path that is gone |
| `GET /models` | what this PC can run (`ui/models.html`): the measured GPU, RAM, CPU and disk, then every catalog model in `runs now` / `runs, but tight` / `does not fit` / `no figure yet`, with the quant that fits |
| `GET /api/recommend?fresh=1` | `probeHardware()` + `recommend()` projected for that page - cached for 30 s, `?fresh=1` re-measures; read-only and outside the token check, `hostname` dropped so a screenshot shares no machine name |
| `GET /api/sessions?limit=` | both sidebar lists in one call, plus a note per empty source |
| `GET /api/chat?id=` | one chat: status, answer, stored events |
| `GET /api/context?id=` | how full the window is: `{window, used, percent, parts}` for a live or stored chat |
| `GET /api/stream?id=` | those events as SSE (`data: <json>`, ending with `ui/end`) |
| `POST /api/chat` | start a run: `{task, model, effort?, parentId?, attachments?}` |
| `POST /api/cancel` | ask a live run to stop; a finished run answers 409 with the reason |

Four rules that keep it private and still usable:

1. **Loopback only**, on a port you choose.
2. **Every mutating route needs the token** the page was served with, so a stray page
   from another origin that guesses the port cannot start runs.
3. **`/api` is same-origin; the page is not.** A cross-site document must not read or
   write this API, but a person who opens the URL from a link or a bookmark arrives with
   `sec-fetch-site: cross-site`, and refusing that made the UI reachable only by typing
   the address. The page and its assets carry nothing a cross-site document can read
   (same-origin policy blocks reading a navigation's body); the API keeps the guard.
4. **Assets are `no-store` and served from a fixed list**, so a reload always picks up an
   edit, and no path is turned into a file read.

**Continuing a chat is a real continuation.** Sending again posts the open chat's id as
`parentId`; the server seeds the new run with the earlier turns - from memory while the
chat is live, and from its stored event log after a restart - and appends the new
question **last**. Two bugs that cost a session, both now tests: a run seeded with a
transcript that ended on the assistant's own answer made the local model simply carry
that sentence on (`a seeded run ends its transcript with the new task`), and a seed
rebuilt from disk had no system turn, so a continuation did not know its root or its
tools (`a seed rebuilt from a stored log gets this run's system turn`). The child never
appends to the parent's array, so a follow-up cannot edit history that is already on
screen.

### OmniRoute inside the app

OmniRoute (the optional free-tier gateway on 127.0.0.1:20128) runs as the desktop app's own
child process, from `src/omniroute-manager.mjs`, not as a separate window in the taskbar:

- started hidden when the app opens (if it is installed and "Start OmniRoute with
  Rosalena" is on), with its output in `<ROSALENA_HOME>\logs\omniroute.log`;
- on Windows a child that is not detached is in the job object libuv gives the app's
  children, so it ends with the app even when the app is killed (tested);
- restarted after a crash (2, 5, 15, 30 s), given up on after five crashes in two minutes;
- Settings > Cloud models shows whether it runs inside Rosalena or outside, with Start,
  Stop, Restart, the log, "Keep it running after Rosalena closes" (for the website's tunnel;
  started detached then, still without a window) and "Run it inside Rosalena", which stops
  a copy running in its own window and starts it here;
- it finds an install in the folder it remembers, `ROSALENA_OMNIROUTE_HOME`, or
  `~\.rosalena\omniroute`, and learns the folder of a copy it sees running (such as
  `D:\Tools\omniroute`). A copy Rosalena started and left behind is recognised by its saved
  pid and taken back without asking.

The window used to come from the two outside launchers, `site\tools\omniroute-startup.cmd`
(`start /min`) and `omniroute-site.ps1` (`-WindowStyle Minimized`); both now start it
hidden. `test\omniroute-manager.test.mjs` runs a fake OmniRoute with the real one's shape
(launcher plus server) to check no process has a window, crash restart, Stop ending the
whole tree, a copy outside being left alone until moved, and the end-with-the-app promise.

### Free API keys for students (Settings > Cloud models)

"Get a free API key" lists programs from `data/student-programs.json`, one card each: the
four UMD DIT pointed students to on 2026-11-03 (Claude Builder Club, OpenAI's Student
Collective and Campus Network, GitHub Copilot Student, Kiro for Students) and two open to
anyone (the Gemini API free tier, OpenRouter's free models). A program whose key fits one of
the router's key slots shows "Works in Rosalena" and a paste field that saves through the
same `save-key` action as the key list; Copilot and Kiro give credits for their own tools,
so their cards say "Not usable in Rosalena" and offer no field. Amounts are only stated
where the program publishes them, and the cards show the date they were checked.

### The look survives a relaunch

The desktop app serves the page on a new port every launch, and a new port is a new origin
with an empty localStorage, so the theme, UI style, layout, tab order, a plugin's theme
(Style Lab's `theme.set`) and sidebar plugins' saved data used to reset on every reopen.
`src/ui-state.mjs` keeps every `rosalena-` / `rosalena.` key in `<home>\ui-state.json`
(8 MB cap): the server writes the saved copy into index.html, and `ui/persist.js`, a classic
script in `<head>`, puts it back into localStorage before any module reads it and sends each
later change to `/api/ui-state` (token, batched, flushed when the window closes). Verified
with two launches on two ports over one home: light theme, the Compact style and a plugin's
accent all came back.

## Updates

An installed app can say whether a newer build has been published. `src/update.mjs` reads
one static file, `site/public/download/updates.json`, and answers with exactly one of
three states:

| state | when | what the person is told |
|---|---|---|
| `current` | the feed's version is equal to or older than the running one | "you are up to date at 0.1.0" |
| `available` | strictly newer **and** the feed carries a release page | the version, its date, its notes, one link to that page |
| `unknown` | anything else, including a newer version with no page | "the check could not be completed", plus the reason |

That middle rule is the whole design: an update the app cannot point at is not an update,
so it reports `unknown` instead of a notice nobody can act on. Nothing is downloaded,
staged, installed or restarted - the link opens a release **page** in a browser and the
person installs. `url` must be `https` on `rosalena.pages.dev` or `github.com`; anything
else (`javascript:`, `data:`, other hosts) is refused before it can be rendered as a link.

**Today the answer is `current` at 0.1.0**, because no release has ever been published:
the committed feed names `0.1.0`, the version the app already is, with `releasedAt: null`,
`url: ""` and no artifact. `available` is covered by tests and has never happened.

The request is one `GET` with one header, `Accept: application/json` - no account, no
install id, no platform, no version, no query string, so the site cannot tell who asked.
Checks run at most every six hours (`shouldCheck`, `CHECK_INTERVAL_MS`) or on demand, time
out after five seconds (an `AbortController` *and* a race, so a fetch that ignores its
signal cannot hang), and a body over 256 KiB is refused rather than parsed.

Status: the module and the download page's block are done and tested (`test/update.test.mjs`,
33 tests; `site/test/updates.test.mjs`, 19). The release job writes the feed with
`node packaging/release/manifest.mjs --updates`, which refuses to write a feed naming a
release page with no measured file behind it, and runs the app's own validator before
writing. A window route (`GET /api/update`) and a "Check for updates" button are **not
wired yet** - `docs/updates.md` carries the two snippets exactly as they belong.

## Two setup requirements

1. **The router must be running** (it is the only model access path):
   ```powershell
   cd "D:\AppDev\Rosalena Harness\router"; node src/index.mjs
   ```
2. **Cloud keys in the environment** for fallback. Without them `--check` says
   `hasKey=false` and those targets are skipped, so everything lands on the local
   model. That works, but it is slow (measured below).

## What this machine can run

`node src/cli.mjs --hardware` measures the box and answers the only question worth
asking before a 20 GB download: does it fit. `--hardware --json` is the same probe
plus the full per-quant table, and `--check` now prints one line of it.

```
harness hardware
  cpu       Intel(R) Core(TM) i5-8600K CPU @ 3.60GHz - 6 physical / 6 logical cores
  ram       31.9 GiB total, 6.8 GiB free
  gpu       NVIDIA GeForce RTX 3090 - 24.0 GiB VRAM, 0.8 GiB free, driver 617.42 (nvidia-smi)
  also      Intel(R) UHD Graphics 630 - not targeted, and no VRAM is reported for that adapter
  disk      D:\Models - 247.9 GiB free of 1863.0 GiB on D:\
  models    20 GGUF files, 173.6 GiB, in 1 folder

catalog - 10 entries. "now" is against memory free today, "idle" against the card's whole 24.0 GiB:

  now      idle     model                          quant              need    vram now   vram idle
  tooBig   fits     Qwen3.8-27B                    UD-Q4_K_M      19.8 GiB   -19.0 GiB     4.2 GiB
  tooBig   fits     Qwen3-32B                      Q4_K_M         20.9 GiB   -20.1 GiB     3.1 GiB
  tooBig   tooBig   Llama-3.3-70B-Instruct         Q4_K_M         42.6 GiB   -41.8 GiB   -18.6 GiB
```

(three of the ten rows; a real run prints all of them)

The window's Models page (`/models`, also "Download models…" at the bottom of the model
picker) shows the same verdicts in four tabs: Chat (`data\model-catalog.json`), Image,
Video and Voice (`data\media-models.json`: ComfyUI checkpoints and diffusion models,
Whisper and text-to-speech files). Every tab always shows Runs now, Runs but tight, and Does
not fit, and each catalog keeps a couple of models a 24 GB card cannot hold (Llama 3.3 70B
and Qwen2.5 72B; HiDream and Qwen-Image at full precision; Wan 2.2 A14B and LTX-2 19B), so
there is always a reference for where the limit is. Download asks first (file, size, folder,
what runs it, a warning on tight or too-big rows), then `src\model-downloads.mjs` reads the
file's size and sha256 from Hugging Face's own headers, downloads with resume, and keeps
the file only if both match. Chat GGUFs land in `~\.rosalena\models` (the local shelf lists
them; llama.cpp is installed first if this PC has none), media files in
`~\.rosalena\models\<kind>\<ComfyUI folder>`. Split GGUFs are not offered as one download.

Where each number comes from, and what is printed when it cannot be read:

| measured | from | if it cannot be read |
| --- | --- | --- |
| CPU | `os.cpus()`, plus `Win32_Processor` for the physical core count | `null`, and listed in `unknown` |
| RAM | `os.totalmem()`, `os.freemem()`, plus `Win32_ComputerSystem` | `null` |
| GPU | `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version` | no NVIDIA driver: the name comes from `Win32_VideoController`, VRAM stays `null` - `AdapterRAM` saturates at 4 GB, so it is never used |
| disk | `statfs` on the drive that holds the models folder | `null` |
| models | `.gguf` files under the local-llm plugin's `modelDirs`, three folders deep | an empty list |

Tools are spawned with an argument array and no shell, `windowsHide`, and a 4 s cap,
so a missing or hung `nvidia-smi` is "unknown" rather than a throw or a hang. The
probe costs about 1.5 s on this machine - one PowerShell CIM query - which is what
`--check` pays for that line.

The fit arithmetic lives in `src/hardware.mjs` (`estimateModelNeeds`, `fitScore`) so
the CLI and the UI cannot disagree about what "fits" means:

```
weights  = the GGUF file size, or params x bits/weight when the size is not known
           bits/weight: Q4_K_M 4.8, Q5_K_M 5.6, Q6_K 6.6, Q8_0 8.5, F16 16
           (measured off real files: Qwen3-32B Q4_K_M is 19.76 GB over 32.76B = 4.82)
kv cache = 2 x layers x context x kvDim x 2 bytes    (f16 K and V, llama.cpp's default)
overhead = 0.5 GiB                                   (rule of thumb, not measured per model)
need     = weights + kv cache + overhead
```

`context` is the catalog's `serveContext`, not the length the model was trained for.
A 262144-token model at 262144 would want hundreds of gigabytes of KV cache, and
quoting that as the requirement would make every entry look impossible; the trained
length is kept in `context` for the reader. `layers` and `kvDim` come from each
model's `config.json`, and the KV cache is the reason a 16.5 GB file needs 19.8 GiB.

The verdict, and the rules that keep it honest:

- **fits** - `need <= free VRAM`. The boundary counts: equal is a fit with zero spare,
  one byte more is not.
- **tight** - does not fit VRAM but fits free RAM: CPU or partial offload, a few tokens
  per second. The row says so instead of calling it a fit.
- **tooBig** - fits neither, and the row prints the shortfall in GiB rather than the
  word "insufficient".
- **unknown** - neither memory figure could be measured. Said, not guessed.
- Two columns, **now** (free memory) and **idle** (the card's whole VRAM), because a
  busy card would otherwise answer "no" to everything. On this machine 23.2 GiB of the
  24 GB is in use while a model is resident; that is a fact to print, not to round away.
- **A size that does not fit is shown as not fitting.** Qwen3-32B Q8_0 is 34.8 GB and
  Llama-3.3-70B Q8_0 is 75 GB over two files: both stay in the table with the numbers
  that make them impossible. Nothing is dropped for being inconvenient, and nothing is
  called a fit because the machine is big.
- Every field that cannot be read is `null` **and** listed in `unknown`, built by
  walking the probe's own output, so a field cannot be null and unlisted at once.
  Nothing is filled with 0: a card with 0 bytes free is a reading, a missing driver is
  not a reading.

The catalog is data: `data/model-catalog.json`, ten entries covering the jobs worth
running locally (reasoning, code, chat, vision, embedding), each with a `serveContext`,
one honest sentence of notes, and Hugging Face **resolve** URLs - 40 of them checked,
all HTTP 302 with the exact size the row claims. Adding a model is an edit to that
JSON, not to code.

The same command answers "what is already here": the `on disk` list is every `.gguf`
under the models folder, largest first, with its size and a quant guessed from the
file name. The guess is a guess and is left `null` when the name does not say; a name
is not a measurement. Projectors and speculative-decoding heads sit in the same
folders, so they are labelled `mmproj` / `mtp` instead of being handed a parameter
count their size contradicts.

### Local models that load themselves, fit the card, and let go

Pick a downloaded model, send a prompt: it loads, fitted to this PC, and unloads when
nobody uses it. Nothing has to be typed into a config.

**The fit (`src/local-fit.mjs`, `src/gguf.mjs`).** Before llama.cpp starts, the model's
own GGUF header is read for its layer count, trained context and KV size per token
(a hybrid stack like the 27B Qwen keeps a cache on every 4th layer only, and is counted
that way). Then:

```
budget  = free VRAM + what the swap frees (our own previous model) - reserve
reserve = 6% of the card, at least 1 GiB (Models page: "Keep this much graphics memory free")
need    = weights + KV (per token x context x cache type) + mmproj + 256 MiB + 2 KiB/token
```

Auto tries the biggest context first (32k, or the install's `planContext` when bigger;
the Models page can set a cap), each with the install's cache type and then q8_0, halving
down to 4k. If even 4k does not fit whole, part of the model runs from RAM (`-ngl` = the
layers that fit, said to be slower), unless "When a model is too big" is set to "Don't
load it". A model that fits neither the card nor the RAM is refused with the numbers.
Manual settings per model (context, layers on the GPU, KV cache) go through the same check:
a hand-picked value that would overfill the card is refused, never loaded. A switch is
planned **before** the old model is stopped, so a refused switch leaves it working; after
the stop, the card is read again and the load uses the real figure. Measured on the 3090
(2026-11-03): Llama 3.1 8B at 32k planned 9.3 GiB with the first overhead estimate and used
8.6; after calibrating, the 27B Qwen at 131,072 tokens (q8_0) planned 21.2 and used 21.0,
leaving 2.2 GiB free.

**Unloading.** The UI server watches the model it loaded every 30 s
(`createIdleWatch`): after the idle time (Models page, default 10 minutes, or Never) with
no slot generating, no slot counter moving (another program on the same port) and no
Rosalena run on a local model still going, it is stopped. A model another program loaded
is never touched. "Unload when Rosalena closes" (on by default) stops our model when the
desktop app quits; llama-server runs detached, so nothing else would.

**Image and video (`src/comfy-runner.mjs`).** Catalog entries with a `workflow` run with
the graph in `data/comfy-workflows/` filled from their `defaults` and file names; their
text encoder and VAE (`companions`) download with them. `comfy_generate` with
`model: "<id>"` finds ComfyUI (main.py plus its venv or portable Python), starts it hidden
as the app's child with `--extra-model-paths-config` pointing at `~\.rosalena\models`,
unloads our own idle chat model if the card needs the room, refuses a model that would not
fit even with ComfyUI's RAM spill (1.5x), and stops that ComfyUI after the same idle time.
A ComfyUI someone else started (ContentFarm's) is used as it is, never freed or stopped.
All four graphs were checked against a real ComfyUI's `/object_info` (nodes, inputs and the
fixed choices); no render was run. That ComfyUI took 3 min 20 s to start, so the wait is 5.

**Voice (`src/voice-runner.mjs`).** The first Whisper download brings whisper.cpp (pinned
in `data/whisper-runtime.json`, sha256-checked). The microphone beside Send records 16 kHz
PCM in the page, the server runs one `whisper-cli` per dictation (loaded, used, gone), and
the words land in the prompt to read before sending. The button stays hidden until a
Whisper model is downloaded. Not run end to end yet: the downloaded runner was not
executed on this PC. Text-to-speech entries are download-only.

## Safety rules baked in

- **The file tools are rooted at the workspace.** `read_file("../../Windows/...")` and
  `write_file("../escaped.txt")` come back as refused tool results; the model is told,
  and the loop continues.
- **`run_command` is not sandboxed, and the harness now says so.** It is a real shell
  holding the harness user's own permissions; the workspace is only its working
  directory. This was found by *running* the harness, not by reading it: asked to write
  a file one level above the workspace, the local model was refused by `write_file` and
  then did it with a `Set-Content` through `run_command`. It was right to â€” the shell
  has no boundary to violate. The tool description and the system prompt now state the
  boundary explicitly, and `--no-shell` removes `run_command` from the tool list
  entirely. That flag is the only confinement that is real: a path check on a command
  string would be theatre, since `cmd /c`, a called script or an encoded payload all
  walk around it.
- **The judge is not a safety reviewer.** It decides whether the task was done, not
  whether doing it was wise â€” in the run above it passed the answer, correctly, because
  the file really had been created.
- **Tool output is clipped per tool, against a measured budget** â€” 8 KB head for
  `read_file`, 4 KB tail for `run_command` (the error is at the end), 2.5 KB for a
  listing, 5 KB for search hits. One flat 6 KB budget was wrong in both directions:
  too small for a file the model needs to see, too generous for a directory listing.
  `--max-output-chars N` still flattens every budget when you want the old behaviour.
  A range read (`offset`/`limit`) is clipped too â€” it used to be the one way to walk
  straight past every limit.
- **Token estimates use a weight measured on the real tokenizer, per tool.** The flat
  `chars/4` that every harness uses is wrong on every shape this one produces (a log
  tail is 2.0 chars/token, source code 3.6, prose 3.8 â€” see `--context`). Under-counting
  is the dangerous direction: the estimate says there is room, compaction never fires,
  and the run dies on the real window. Each weight is its measured value floored, and a
  test fails if anyone raises a weight above the sample it came from.
- **`read_file` results are cached for the run.** The only tool with a cheap AND sound
  validity check is the one keyed on a single file's identity (size + mtime + inode), so
  it is the only one cached. A second identical read gets a stub instead of the bytes
  (a live run: 8053 bytes not re-sent), and the cache is invalidated by any write, by
  any change to the file, and by a compaction â€” the last because compaction is exactly
  what could drop the earlier copy the stub points at. A shell command, a search over a
  tree, a directory listing: never cached, because "same args" does not mean "same
  answer" and a cached lie is worse than a re-sent byte.
- **Untrusted content is labelled as such.** The system prompt states that file
  contents, command output and web pages are data, never instructions â€” the
  injection rule from Â§5.2.
- **Delegation is capped at two levels.** The worker gets the same tools minus
  `delegate`, so the agent tree cannot recurse.
- **Budgets:** `--steps`, a 10-minute wall clock, and `--max-usd` (read from the
  router's ledger, so it counts what was actually spent).

## The judge â†’ fix loop

`--judge` used to produce a verdict that nothing acted on. Now a rejection goes back to
the model with its reasons, and the run says honestly whether it ended accepted:

1. the answer is judged against the task **and the evidence** â€” the tool calls the run
   made and what came back, bounded to the last 12 entries and 2.4 KB. Without that
   block "be strict" is unenforceable: prose can claim anything, and the judge had only
   prose. A judge that reads `read_file({"path":"x"}) -> line one` can fail "I read x"
   when no such call exists. A run that called no tools is told so in as many words.
2. a rejection the model can act on is pushed back as one user message carrying the
   reasons and the judge's suggested fix. **One fix round by default** (`--fixes N`,
   clamped 0â€“3); each fix round grants its own step budget (`fixSteps`, 4) so fixing
   does not have to fit inside what is left of the original one.
3. a judge that is *unreachable* is not actionable, so it never spends a fix round, and
   a verdict that is not JSON is not a pass.
4. when the fix rounds run out, the run ends with `verdict.pass: false`; the CLI prints
   `judge rejected after N fix round(s)` and **exits 2**. Exit 0 means answered and
   accepted, 1 means the run errored, 2 means the judge rejected it.

One deviation from Â§5.2, stated rather than hidden: the plan says the orchestrator
*spawns a fix subagent* with the failure evidence. Here the orchestrator fixes it itself,
because it already holds the history that produced the answer plus the tools to change
the work â€” a fresh worker would have to rebuild both from the evidence alone. The worker
path is still available and the orchestrator can choose it: `delegate` is in its tool
list and the judge's reasons are in its context.

## Memory: the rolling summary and the store that outlives it

Â§5.2 asks for two different things and they are two different mechanisms in
`src/memory.mjs`. Both are **core**, not plugins: the loop owns context, and the
loop owns when history is rewritten, the same way it owns streaming and the fix loop.
A plugin can layer search or embeddings on the store later.

**Session memory â€” a rolling summary plus the last N messages verbatim.** At the top
of every step, before anything is sent, the history is estimated and, past
`--compact-at` of the window (0.55 by default, deliberately not the usual 0.8 â€” 5.2
says "not 80%", and the slack absorbs an estimate that is wrong), the oldest span is
replaced by one summary message:

- the estimate counts `content` **and** tool-call names and arguments, because a
  history of tool calls is mostly arguments;
- the summary replaces the span **in place** in the same array, so hooks, the judge,
  the reporter and the run's own result all see the compacted history rather than a
  copy of it;
- the cut keeps the last `--keep-last` messages verbatim and may back up only far
  enough to avoid splitting an assistant call from its results. A retained `tool`
  message whose call was summarized is a malformed request, and providers reject the
  whole request, not the message. **Requiring a `user` boundary instead looked safer
  and was worse**: a single long turn â€” one task, thirty tool calls â€” has no user
  boundary after the first message, so compaction returned "nothing to do" in exactly
  the run that needed it. A tail starting at an `assistant` message is valid because
  the summary that precedes it is a `user` message. That bug was found by a live run,
  not by a test;
- the summary is written by `--summary-class`, and **falls back to a mechanical
  digest** when that call fails or returns nothing. Compaction is what keeps a run
  alive, so it must not depend on a second model being up: the fallback names each
  turn, the tools it called and what came back, clipped. The event carries
  `how: "model" | "mechanical"` and the note explaining why;
- if a compaction succeeds and the history is **still** over the threshold, the
  retained tail is the problem and no summary can fix it. The loop says so once
  (`compaction cannot get under the N-token threshold: the last K message(s) alone
  are ~M tokens (lower --keep-last or raise --context-window)`) and stops trying,
  instead of spending a summary call per step rewriting the same summary.
- **a server that refuses a prompt ends the argument, not the turn.** The meter can
  only be as right as the window it was told about, and a llama-server started by
  another launcher can have a smaller `-c` than this run assumed (measured
  2026-11-06: 32,768 on :8080 while the run believed 131,072, so nothing ever crossed
  the threshold and a 36,630-token request came back as
  `exceeds the available context size (32768 tokens)`). That refusal names the real
  window, so the loop takes it: `contextWindowTokens` and the threshold move to the
  server's number, the droppable history is summarised to fit (mechanical digest if
  the summary request is the next thing that does not fit), the step is asked again,
  and a `notice` says what happened and how to get the long history back. At most two
  such rewinds per run, then the error with its explanation -
  `reportedContextWindow()` in `src/context.mjs`, the branch at the end of the step
  loop in `src/agent.mjs`, `test/context-overflow-recovery.test.mjs`.

`--no-memory` removes the store, both tools and compaction. The reporter prints
`â‡£ compacted 3447â†’3435 tokens (dropped 1, kept 3, model summary)` and, when it gives
up, the reason â€” both on stderr with the other events.

**The data directory â€” one place for everything the suite remembers.** `ROSALENA_HOME`
(else `~/.rosalena`) holds `memory.jsonl`, `process-ledger.json`, `mcp-servers.json`,
`mcp-state.json` and `proxy-pool.json`. Every module resolves it the same way and each
plugin still accepts an explicit path in its config, which wins. The launcher
(`bin\Rosalena-Harness.exe`, or its root shortcut) sets `ROSALENA_HOME` to
`<product>\data` unless you set it
yourself, so the product folder is self-contained and movable â€” and writable even when
the `.exe` runs at Low integrity, which is what Windows does to an executable inside a
low-labeled workspace. `--check` prints the directory and proves it writable with a real
create/delete, because `access()` consults the ACL and cannot see the integrity label.

**Global memory â€” the self-updating layer.** A JSONL store at
`~/.rosalena/memory.jsonl` (`--memory-file`, or `ROSALENA_HOME`) holding records of
`kind` `fact | decision | constraint | project` plus `text`, `project`, `at`, `id`:

- the newest records for the current workspace come first in the system prompt,
  under "What you already know from earlier sessions (N older not shown)", bounded by
  `memoryPromptChars` (1200) and `memoryLimit` (8). The model gets a note that a
  `remember` note must be self-contained, because the next session reads it without
  this conversation;
- the model writes through two ordinary tools, so the write is visible in the tool log
  and the judge sees the evidence: `remember({kind, text})` and `recall({query, kind,
  limit})`. Appends are one JSON object per line (grep-able, and a corrupt line costs
  one record rather than the store: unparseable lines are skipped and counted);
- the same note twice is refused (`already known`, matched on kind plus whitespace-
  and case-folded text), text is capped at 2000 characters, an unknown kind becomes a
  `fact`, and empty text is refused;
- the store does not grow on its own: nothing is written unless the model calls
  `remember` or you use `/remember`. Every test that asserts a write passes its own
  temp `--memory-file`;
- the CLI exposes it directly: `/memory [query|kind]` lists, `/remember
  [fact|decision|constraint|project] <text>` writes, `/forget <id>` deletes, and
  `--check` reports the record count and the file path.

## The context meter, and compaction you can see

Two things the UI could not say before: **how full the window is right now**, and **that
a conversation was summarised to stay inside it**. Both are now first-class, and both
read the same arithmetic (`measureContext` in `src/context.mjs`), so the gauge and the
compaction rule can never disagree about what "full" means.

**The gauge.** A small ring in the chat header, with the same three rows as the
reference: `48%`, `~96K / 200K`, `System prompt ~2.1K`, `Tool definitions ~14.4K`,
`Messages ~79K`. Clicking it opens a panel with the window, the threshold it will
compact at, and whether the number came from the provider or from our own estimate. It
ticks up while the answer is being written and settles on the final numbers when the
turn ends; a reloaded chat asks the server for what the run recorded.

- **The window is configuration, because nothing else knows it.** Measured, not
  assumed: the router's own state (`/state` on :8077) exposes models, classes and
  health, and **no per-model context length**; `harness.config.json` does not carry one
  either. So the harness owns it: `--context-window`, `ROSALENA_CONTEXT_WINDOW`, or the
  `DEFAULT_CONTEXT_WINDOW` of **32768**, which is what `runAgent`, the CLI and the UI
  server all resolve to today.
- **One estimator, in one place.** It lived in `src/memory.mjs`; it now lives in
  `src/context.mjs`, next to the measured weights, and memory imports it back, so the
  compaction check and the meter are literally the same function. The weights are the
  measured ones (`CALIBRATION`, 2026-10-19, llama.cpp `/tokenize` on qwen3.8-27b) applied
  per message, with tool-call names and arguments priced â€” the same promise the
  compaction estimate already made.
- **A real number beats an estimate, when the provider gives one.** If a step's reply
  carries `usage.prompt_tokens`, the messages row is that count plus an estimate of
  whatever has been appended since that request went out â€” never a re-estimate of a
  payload the provider already counted. `used = system + tools + messages` holds in both
  modes, `percent = round(used / window * 100)`, and the payload says which mode it used
  (`source: "provider" | "estimate"`) so the panel can be honest about it. Right after a
  compaction the reading goes back to `estimate`, because the last provider count
  described a history that no longer exists.
- **`GET /api/context?id=<run>`** answers `{window, used, percent, parts: {system,
  tools, messages}}` plus `source` and `threshold`. 400 without an id, 404 for an
  unknown chat, and `measured: false` with zeros and `window: null` for a run nothing
  measured â€” a chat that shows `0%` because it has no reading is lying about a full
  window.
- **`ui/context` on the stream**, emitted at the start of a turn, at every step
  boundary, after every compaction, and once more as `phase: "final"` before `ui/end`.
  A page that opens mid-turn therefore gets the current reading replayed before it
  follows live. Sub-agent readings arrive tagged `sub: true` and the meter ignores them:
  the gauge is the parent's window, not a worker's.
- The figures are formatted by one helper (`ui/format.mjs`): `~0`, `~450`, `~2.1K`,
  `~96K`, `~1.2M` â€” the tilde is part of the number, because it is an estimate or one
  step's reported prompt, not a measurement of the future.

**Compaction, revised to be visible and to never lose the request.** The mechanism is
the one described under "Memory" above; three things changed.

- **The threshold is 0.55 of the window**, not 0.5 (`COMPACT_AT` in `src/context.mjs`,
  used by the loop, the CLI and the tests). At the default window that is
  `round(32768 * 0.55)` = **18022 tokens**, floored at 2000 so a small window cannot ask
  compaction to win back less than the summary itself costs. The 0.5 was a guess; the
  slack above the 55% line is what pays for an estimate that is wrong on the low side,
  which is the only side that hurts.
- **The user's original request is kept verbatim inside the checkpoint.** The checkpoint
  is still one `user` message, and its head is now `Original request (kept verbatim): …`
  (the first real user turn of the dropped span, clipped to 1200 characters) followed by
  the summary body. A summary that loses *what was asked for* is worse than the overflow
  it prevented; this is the one thing that survives any summariser, including the
  mechanical fallback. The old test that asserted "the dropped text must be gone" now
  asserts that the dropped **bulk** is gone and the request is present â€” the two
  requirements were in direct conflict, and this is the line drawn.
- **The event is `compaction`, not `compact`, and the browser draws it as a fold.** A new
  event type (old logs still render, mapped from `before`/`after`) carrying `step,
  dropped, kept, how, note, tokensBefore, tokensAfter, chars, originalRequest, summary,
  threshold, window`. The transcript shows a dashed, collapsed row â€” `â–¸ context
  compacted Â· 14 earlier message(s) replaced by a summary` with `~18.1K â†’ ~4.3K` â€” and
  expanding it shows the original request, the summary, and the note saying whether a
  model or the mechanical digest wrote it. It is not a fake user or assistant bubble,
  because it is not something either party said.
- The run record carries the last reading as `contextMeter`, next to the existing
  `context`, so a chat reloaded tomorrow shows the numbers it showed when it finished.

What is **not** verified here: the gauge as a picture. Its geometry was taken from the
reference's own markup (a 14×14 `viewBox`, `r=5.5`, stroke 2, so the arc is
`2Ï€r â‰ˆ 34.56` and the dash offset is that times the fraction) and the page's markup,
row labels and formatter are tested, but nothing here compares a screenshot: the arc
colour at 55%, the panel's placement and the row alignment were not measured against the
reference as pixels. Summariser *quality* at the default 32K window is likewise not
tested — the tests judge structure and preservation, not whether a particular 27B writes
a good summary. The "the router advertises no window" claim was checked against this
machine's router, not against every router build.

## Verified

- `node --test` - **693 tests, 693 passing, 0 failing** (`--import ./test/isolate.mjs`,
  18 bundled plugins, ~20 s). Scripted router, no network, no cost. The only sockets the
  suite opens are loopback ones it started itself. The bundled-module list and the
  `N module(s)` count are derived from what is in `plugins/` rather than pinned, so a
  module landing there no longer turns the suite red.
- **The two local-model plugins are tested against the failures that would make them
  dangerous, not against their happy path.** `test/plugins-local-model-switch.test.mjs`
  (38 tests) drives a stub llama.cpp and asserts in almost every test that every request
  is a `GET` with no body on the four documented endpoints, that a busy slot produces a
  `REFUSED` line *before* the command, that a model which will not fit gets no command at
  all, and that `status()` performs no I/O (its probe, scan and catalog all throw).
  `test/plugins-subagent-model-switch.test.mjs` (37 tests) drives a temporary root and
  proves a write lands there and not in the real `data/roles.json`, that a corrupt file is
  left byte-identical with no `.tmp` behind, and that an unreadable `effort` level is
  reported without making the presets unreadable. Two of those 37 cross the module
  boundary on purpose: they read the shipped `data/roles.json` through `src/models.mjs`
  itself, and assert that neither a legal nor an illegal `effort` value changes anything
  that reader returns - the presets cannot be broken by a preference.
- **`rosa-opencode-handler` is tested against the answers the gateway gives, never against
  the gateway.** `test/plugins-opencode-handler.test.mjs` (25 tests) stubs every
  fetch, uses a temp root, and asserts the request itself (path, `stream: true`, the
  seven fingerprint headers, the `read` tool) rather than only the parsing. It covers
  all five verdicts, a 429 reset from `Retry-After`, from the body and from the 24-hour
  estimate, status with a healthy, missing and malformed router, the model list with and
  without a router, `use` accepted and refused (other provider, unknown id, ambiguous
  prefix, missing class), a `--write` that keeps a byte-identical `.bak-`, changes one
  chain and refuses a stale plan or an invalid file, the `llm/stream` hook recording both
  a free failure and a free success while ignoring unrelated errors, and a no-key run
  that fails if the network is touched at all.
- **The context work is tested against the failures it was written for, not against its
  own happy path.** `test/context.test.mjs` (24 tests) pins the cache to the ways it
  could lie: a changed file is re-read (size+mtime, including a same-size rewrite whose
  mtime was moved by hand); a write anywhere invalidates every cached read; a
  compaction invalidates everything, because the dropped span is exactly what a stub
  points at; a failed read is never remembered as the file's content; a shell command
  with side effects runs twice, because "same args" is not "same answer"; the workspace
  root still refuses an escape with the cache in play. The weights are pinned to the
  measurements that produced them (a weight above its sample fails the suite), and the
  estimator is asserted to price a log-heavy history *above* the flat `chars/4`.
  Measured, not assumed: the round found that a range read walked past every clip, and
  that plugin-contributed tools were never clipped at all â€” both now tested.
- **Memory is tested as the two mechanisms it is, then through the loop.**
  `test/memory.test.mjs` (26 tests) holds the failures that would make memory worse
  than nothing: the cut never leaves a `tool` result whose call was summarized â€” across
  a parallel tool block, a turn boundary and a single long turn with no boundary at
  all; a single-turn history still compacts; a summarizer that throws, returns nothing,
  or is out of budget falls back to the mechanical digest with the reason recorded and
  the run still answers; the dropped span really is handed to the summarizer (the
  prompt is read, not assumed) and the original task is always in it; the summary is a
  `user` message, `tokensAfter < tokensBefore`, and the dropped **span** is gone from
  what the model is sent while the original request inside it is kept verbatim; a
  corrupt store line is skipped and counted without losing the
  rest; the same note twice is refused and a different kind is not; `recall` filters by
  text, kind, project and limit, newest first. Two integration tests run real
  `runAgent` runs: a fact written by run 1 arrives in run 2's system prompt, and a
  forced compaction (tiny `--context-window`) sends the summary and not the dropped
  span, with the run still answering. `memory: false` offers neither tool and never
  compacts.
- **Memory ran live against the local model, which is where two of its bugs were
  found.** A run told to remember a constraint did exactly that â€” `step 1 â†’ 1 tool
  call(s)`, `âœ“ remember 2ms remembered as constraint (mvffa8ax-79a910)` â€” and the
  store line carries `kind`, `project` and `at`. A **fresh process** with no tools then
  answered from that record in one step, which is the whole point of a store that
  outlives a session. A live `recall` missed honestly (`no memories match "harness
  window" (1 stored)`), the model changed its query, and the answer quoted the record.
  A compaction was forced for real with `--context-window 3000 --keep-last 3` and
  printed `â‡£ compacted 3447â†’3435 tokens (dropped 1, kept 3, model summary)` followed by
  the give-up line naming the retained tail as the problem â€” the run then wandered to
  `max_steps`, which is the honest outcome of handing a 27B a 3000-token window and not
  a claim about compaction. Driving the CLI's piped stdin exercised the interactive
  paths (`/memory`, `/memory <query>`, `/remember`, `/forget`) and `--check`'s record
  count.
- **Compaction is tested through a real router, and the checkpoint is checked in the
  log.** `test/context-compaction.test.mjs` (7 tests) drives `runAgent` against a real
  `node:http` router and then asserts on what the loop was actually sent: under the
  threshold no `compaction` fires and the reading sequence is `start → step → final`
  with `used` equal to the sum of the three rows; over it, the step request still starts
  with the seed's system prompt **byte for byte**, the checkpoint is the second message,
  the newest turn and the task are at the end, `FILLER 5` (dropped bulk) is absent from
  the whole payload, and `Original request (kept verbatim): FILLER 1 …` is in it; a
  `{"type":"compaction"}` line with the same `summary`, `tokensBefore` and
  `originalRequest` is in `<id>.jsonl`; a router returning 503 for the summary call
  still compacts, with `how: "mechanical"` and `summarizer failed: router returned 503`
  in the note, and the run still answers; a provider that reports no `usage` leaves
  `source: "estimate"` rather than a number pretending to be measured. The threshold
  arithmetic is pinned too — `contextThreshold(32768) === 18022`, the 2000 floor, the
  0.1–0.9 clamp, and an explicit `0` read as "not given" rather than "never compact".
- **The meter's server contract is tested, not just its markup.**
  `test/ui-context.test.mjs` (6 tests) runs a real `createUiServer` with a real slow
  router: `/api/context` is 400 without an id and 404 for an unknown one, a run with a
  stored `contextMeter` answers exactly `{window, used, percent, parts}` with the rows
  adding up to `used` and `percent` equal to `round(used/window*100)`, a run without one
  answers `measured: false` / `window: null` instead of a fake `0%`, a chat **still
  running** answers with the configured 32768 window and a non-zero projection, the
  stream carries `ui/context` readings with `start` first and `final` last (each with a
  threshold), a plain answer step invents no `compaction`, and the page really serves
  `#context-meter`, `#ctx-percent`, `#ctx-used` and the three row ids in the documented
  order, with `contextTokens` producing `~96K` / `~200K` / `~2.1K` / `~1.5M` / `~0`.
- **The judge â†’ fix loop is driven through the loop.** `test/judge-fix.test.mjs` (15
  tests) runs real `runAgent` runs against a scripted judge: a rejection comes back with
  its reasons and the corrected answer is accepted; the fix prompt is read out of the
  history the model was actually sent (the task is untouched, the rejected answer stays
  visible); a fix round buys steps past the original `maxSteps`; `maxFixes: 0` leaves the
  judge inert; two fix rounds then a rejection is reported as a rejection rather than
  looping; an unreachable judge spends no fix round; a fix round can call tools; the
  worker never judges itself; a run that fails at the model call never reaches the
  judge. The evidence digest is tested as a digest â€” 20 calls produce
  `8 earlier call(s) omitted`, the newest call survives the 2.4 KB cap and the oldest is
  what goes, a call with no result says `no result recorded`, and a run with no tool
  calls says so instead of showing an empty block. The step-budget test was checked
  against a mutation (the `ceiling += fixRoom` line commented out) and fails there.
- **The shell boundary is tested as a boundary, because live testing proved it was one.**
  Four tests hold the correction in place: `run_command`'s description states it is not a
  boundary, the file tools still refuse `../escaped.txt`, `shell: false` keeps
  `run_command` out of both `byName` and the schemas the model sees and a model asking
  for it is told it is unknown, and the system prompt states which tools are confined.
- **The stream is tested at the byte level, then through the loop.**
  `test/stream.test.mjs` feeds real SSE text rather than stubbed objects: CRLF
  endings, a keep-alive comment, an `event:` line, a multi-line `data` frame, a frame
  cut in half across two chunks, a last frame with no blank line, one unparseable
  frame (counted, not fatal), two tool calls interleaved in one stream with their
  arguments split mid-JSON, an `id` repeated on every fragment, a fragment with no
  `index`, a body that dies mid-read, an error frame, a JSON reply to a
  `stream: true` request, SSE labelled as JSON, and HTML that is neither. Through
  `runAgent`: a streamed `read_file` executes and its result is fed back, deltas
  arrive in order, a truncated step is retried once and recovers, a 503 gets no
  spare attempt, and `stream: false` sends no `stream` field at all. The
  interleaving test was then run against a deliberately broken accumulator (every
  fragment forced to index 0) and fails there, so it is not a test that passes by
  accident.
- **The store is tested through the host, not around it.** `test/store.test.mjs`
  installs `clock@1.0.0` into a throwaway plugins directory, then has the **real
  loader** find it and report one command; updates it, then asks a **fresh process**
  what it loads and gets `clock 1.1.0, 2 commands` (`/clock zones` is new in 1.1.0);
  removes it and gets an empty host back. The refusals are tested as refusals: a
  tampered payload file (index says one hash, disk has another) installs nothing and
  writes no lock, a path with `..` is refused before staging, a `bundled: true`
  plugin survives both install and remove without `--force`, an index that is not
  JSON is reported as an index problem rather than crashing, an http index is
  fetched and installed over a real loopback server â€” and refused outright when it
  is unsigned or signed by a key that is not in `store.trustedKeys`. Signatures are
  verified with a real ed25519 keypair generated in the test, including the classic
  attack: keep the signature, change a hash.
- **The plugin host is tested against itself.** The suite builds throwaway plugin
  directories and proves the failure paths, not just the happy one: a plugin that
  throws on import, one that throws in `setup()`, one that tries to shadow
  `read_file`, one with a malformed tool, one disabled by config, one with a
  corrupt manifest â€” each is reported, and the healthy plugin beside it still loads.
- **The loop hooks are tested through the loop, not around it.** A scripted router
  drives real runs in which a hook stops the run (the step it refused never reached
  the model, and every `tool_call` in the final history still has its answer), a
  hook's note arrives as one user message one step later, retry advice turns two 503s
  into a recovered answer on the *same* target, and `onRunEnd` fires exactly once on
  the answered, `max_steps` and `router_error` paths alike.
- **The four bundled guards ran against the live local model** (`--steps 4`): one
  step, 2.2 s, correct answer, no note and no stop â€” the defaults do not misfire on a
  normal run. The tracker snapshotted the real process table on that run (`326
  processes visible, 326 distinct by pid+start time`) and recorded no leftovers,
  which is the truth of it: that run detached nothing, and processes started by an
  *earlier* session are not this run's to report. `/process-tracker leftovers` and
  the `leftover_processes` tool are how those get surfaced.
- **MCP works over real stdio**, not just in-process: five JSON-RPC lines piped
  into `node src/cli.mjs --plugin rosa-mcp-server:serve` came back as four responses
  (the notification correctly produced none), `tools/call` read a real file, a
  refused `run_command` came back as `isError: true` rather than a crash, and
  stdout carried nothing but JSON.
- **Live local-model report** (`--plugin rosa-local-llm:status`): reachable at
  `:8080`, model `qwen3.8-27b`, **1 slot** â€” which matches the `--parallel 1`
  launcher, and is the fact that decides whether a second session can run at all.
- **A plugin tool reaches the model.** Given only *"call the local_model_status
  tool, then tell me the model name and how many slots"*, a real run through the
  router against the local Qwen did `step 1 â†’ 1 tool call(s)` â†’ `âœ“
  local_model_status 7ms` â†’ `step 2 â†’ answer`, and the answer repeated the tool's
  data (`qwen3.8-27b`, 1 slot). The model picked a tool the core does not contain,
  and answered from what it returned.
- **Live end-to-end** (`harness â†’ router â†’ local Qwen â†’ tool â†’ answer`):
  ```
  $ node src/cli.mjs --root .scratch --steps 4 "Use the read_file tool to read
      numbers.txt, then reply with only the numeric sum."
    Â· step 1 â†’ 1 tool call(s) via local/qwen3.8-27b
    âœ“ read_file 1ms  7
    Â· step 2 â†’ answer
    steps=2  68307ms
  21
  ```
  `numbers.txt` held 7, 5, 9. The answer is correct, and the tool call was real.
- **The tool cache, taken live.** Same path, a 16 KB probe file, one instruction:
  *"use read_file on CACHE-PROBE.txt, then use it a SECOND time with exactly the same
  arguments, then reply with only the first line"*.
  ```
    Â· step 1 â†’ 1 tool call(s) via local/qwen3.8-27b (streamed, first token 7797ms)
    âœ“ read_file 6ms  CACHE-PROBE-MARKER-7731
    Â· step 2 â†’ 1 tool call(s) via local/qwen3.8-27b (streamed, first token 3172ms)
    â†º read_file CACHE-PROBE.txt unchanged - 8053 bytes already in this conversation, not re-sent
    âœ“ read_file 0ms  [unchanged] read_file CACHE-PROBE.txt: same size and mtime ...
    Â· step 3 â†’ answer via local/qwen3.8-27b (streamed, first token 373ms)
    steps=3  12880ms
    context: 1 re-read(s) answered from the cache, 8053 bytes not re-sent
  CACHE-PROBE-MARKER-7731
  ```
  Two things this proves that unit tests cannot: the model really does re-ask for a file
  it has already read, and the stub is enough for it to answer correctly anyway â€” 8 KB
  of context saved, 0 ms of I/O, and the right first line. The run also cost 12.9 s
  instead of the ~68 s of the two-step run above, because step 2 spent its budget on
  generating a tool call rather than on re-sending bytes.

**Cost of that run:** 68 s for two steps (~34 s per call) on the local 27B. That is
the honest price of the free path, and it matters for how you use this: keep the
orchestrator on a cloud class for interactive work and let the local model take the
bulk/worker traffic, or accept a minute per step. Real parallelism needs a second
GPU (Â§5.2) â€” one 3090 time-slices.

- **The three ports are tested against live machinery, not mocks.**
  `test/ported.test.mjs` starts a real forward proxy and a real origin on loopback and
  drives `proxiedFetch` through them (asserting the proxy saw an **absolute URI**, and
  that credentials arrive as `Proxy-Authorization`), then opens a real `CONNECT` tunnel
  and speaks HTTP through it, then runs a health check that returns the exit IP the
  proxy actually saw. `rosa-mcp-manager`'s half spawns **the harness's own MCP server as a
  child process** (`--plugin rosa-mcp-server:serve`), completes a handshake, lists its tools
  and reads a real file back through the protocol â€” including a stub server that prints
  a banner before its JSON, one that never answers (timeout), and one that exits
  immediately. The one gap is the TLS half of the https path: there is no local TLS
  fixture on this box (no openssl, no stdlib X.509 builder), so the tunnel mechanics
  are proven end-to-end while the `tls.connect` handshake over that tunnel is proven by
  construction. Written down rather than claimed.
- **Writing those tests found three real bugs** â€” which is the point of writing them:
  the proxy round robin turned `indexOf()`'s âˆ’1 into 0 *before* adding 1, so it skipped
  the first proxy on every rotation; `per-request` picked a random proxy instead of
  walking the list (the original walked it); and `run.id` was a bare millisecond
  timestamp (`${started.toString(36)}-${depth}`), so two runs starting in the same
  millisecond were handed the **same id** â€” which every hook keys its per-run state on,
  and which `rosa-process-tracker` ledgers by. Run ids now carry a per-process counter.
- **Goal mode and the watchdog were taken live, and the live run is what found the
  router bug.** `--check` printed the file it would write and the round it would write
  (`goal not started yet, this run would write round 1, â€¦\GOAL.md`) plus the deadlines;
  a real run then wrote round 1 of a fresh goal file (`â—‡ goal round 1 of â€¦ (the file does
  not exist yet - this run starts it)` â†’ `âœ“ goal round 1 recorded in â€¦GOAL.md by the
  harness (671 bytes)`), and the file on disk holds the header, the round heading,
  `**Evidence:** read_file({"path":"hello.txt"}) -> line one line two`, `**Next:**` and
  `**Goal status:** still active`. Forcing a real timeout
  (`--step-timeout 2` against a 300-line answer) produced the whole intended sequence:
  `! watchdog: step 1 was aborted after 2000ms (provider target orchestrate)` â†’
  `! retry 1/1 in 1000ms (step_timeout) the stream broke mid-read: This operation was
  aborted` â†’ a second watchdog event â†’ `stopped=router_error`, exit 1. The retry message
  proves the abort landed **mid-stream**, which is the case that was fatal:
- **That abort killed the router, and the fix is in the router.** The first live timeout
  run took the router process down with `ERR_HTTP_HEADERS_SENT` â€” the relay had already
  sent the streamed 200, the abort made it throw, and the error handler tried to
  `writeHead` a JSON error on top of it. Two further defects were behind that: the
  last-resort `catch` in `createRouterServer` never saw the rejection because
  `return handleChat(...)` was missing its `await`, and `sendJson` had no guard at all.
  All three are fixed (`stream_failed` is the new event for a failure after a body
  started; `res`'s `error` is now listened for; every handler is awaited), the router
  README documents the rule, and the same live command that killed it now logs
  `stream_failed` twice and still answers `/health` 200 while the harness exits 1 as it
  should. The new regression test aborts a client **mid-stream** (the older disconnect
  test only aborted before the first byte, which never reached the bug) and asserts the
  router is still serving, that no rejection escaped the handler, and that the failure
  was logged as a stream failure â€” the last assertion is what fails against the old code.
  Router suite: 42/42.
- **The window was driven in a real browser, not asserted in the abstract.** A fresh tab
  at 1440Ã—900 against the live server: the welcome screen rendered with its three
  starters; the sidebar filled from one `/api/sessions` call (5 Rosalena chats and **180
  external sessions** found on this machine, each with its source and age); a prompt
  typed into the composer ran end to end through the router into the local 27B and came
  back as **2 steps, 1 tool card (`read_file HARNESS.md Â· 7 ms Â· âœ“`), 7.1 s**, with the
  answer rendered as bolded bullets, the step meta lines naming the model, 10 and 125
  frames, 3.2 s and 1.8 s to first token, and the URL settling on `?chat=<id>`. Reopening
  that URL rebuilt the transcript from the run store, and a **follow-up in the same chat
  answered the new question in 3.3 s** â€” it was a chat whose transcript had to be
  rebuilt from disk, because the server had been restarted in between. No console or page
  errors in any of those sessions (`test/ui.test.mjs` 20, `test/ui-format.test.mjs` 13,
  suite 330).
- **Driving it found two defects the tests had not.** The stats strip is `display:none`
  until a run starts, and a grid with an explicit `auto auto minmax(0,1fr) auto` template
  reassigns those rows to the *remaining* children: the transcript fell into the second
  `auto` row (336 px) while the composer took the `1fr` row and grew to 502 px, leaving
  half the window empty. Placement is now explicit per child. The second: a step that
  streamed nothing and only called a tool left an empty panel in the transcript; it now
  keeps its meta line and no body (`msg.bare`).
- **The seed path was wrong in a way only a live run shows.** A second message in the
  same chat produced an answer that was word-for-word the previous one, in 3 frames: the
  seeded transcript ended on the assistant's own reply and the new task was never
  appended, so the model carried the sentence on. Fixed at the loop (task last, seed
  copied, system turn prepended when the seed has none) and at the server (a chat that
  is only on disk is rebuilt from its event log), with three tests and a stubbed-router
  test that asserts the exact message order the model receives.

## The bridge: how the website's page borrows this machine

`src/bridge.mjs` is a second listener, on `127.0.0.1:8765`, started by `serveUi` unless it is
told not to (`serveUi({ bridge: false })`). It exists so `https://rosalena.pages.dev/try/` can
answer from the visitor's own computer instead of from a Worker: the app runs the request from
the visitor's own connection, so the free-model window it spends belongs to the visitor.

Why a socket and not just a fetch from the page: a browser cannot read a free-tier answer
directly. Measured against `https://opencode.ai/zen/v1/chat/completions`, the preflight
`OPTIONS` returns **404** with no `access-control-allow-origin`, and a `POST` with
`Origin: https://rosalena.pages.dev` returns **403**, also without CORS headers. Only code
outside the page - this process - can make that request and hand the result back.

What it refuses, and why each rule exists:

- **Any origin but three.** `https://rosalena.pages.dev`, `http://localhost:8788`,
  `http://127.0.0.1:8788`. A stranger's page gets no `access-control-allow-origin`, so its
  `fetch` cannot read the reply even if it fires one (and a paired POST from it is a 403).
- **Any request without the pairing token.** 32 characters of base64url in
  `<home>\bridge-token.txt` (mode 0600, minted once, regenerated if the file is short or
  unreadable), compared in constant time. The token reaches the page in a URL **fragment**
  (`https://rosalena.pages.dev/try/#pair=...`), which no server receives and which the page
  strips from the address bar the moment it has read it.
- **More than 20 requests a minute per token.** 429 with `kind: "budget"`, counted before the
  router is touched. The site's own D1 counters are not involved at all on this path.
- **A body that is not a conversation.** `bridgeRequestBody` keeps the last 16 user and
  assistant turns, slices each to 4,000 characters, drops system and tool roles, requires the
  conversation to end on a user turn, defaults `model` to `fast` and caps `max_tokens` at 600.
  A page is a page: it does not get to choose a model or a budget.
- **Chrome's Private Network Access preflight.** `access-control-allow-private-network: true`
  is what lets a public page open a socket to loopback at all.

Two response formats, one endpoint. By default the router's bytes pass through verbatim, so the
bridge is a transport and nothing else. With `?format=trial` the frames are translated into the
shape the demo page already parses - `{"delta":"..."}`, `{"done":true,"usage":{"output":N}}`,
`{"error":"...","kind":"..."}`, then `[DONE]` - so that page did not have to learn OpenAI's
chunk schema to be moved onto the local path. A mid-stream failure emits an error frame in
either format instead of a truncated answer that looks complete.

`x-rosalena-answer: local-app` goes on every streamed reply, and `/health` (token-free, so a
page can probe it) returns `{ok:true, app:"rosalena-harness", bridge:1, tokenRequired:true,
answer:"local-app"}`. That header and that field are how the page knows to say "your own
machine" rather than guess.

Measured, not assumed: `test/bridge.test.mjs` (11 tests) covers preflight, the stranger origin,
the token, the budget, dead-router 503, the body rules and the `?format=trial` frames; and the
real page was driven in Chromium against this listener - a paired tab streamed a real answer
("I am Qwen, a large language model developed by Alibaba Group's Tongyi Lab.", 19 tokens out)
with a clean console and the token gone from the address bar, while an unpaired tab rendered
the refusal instead of an empty answer.

## Remote access: the app on a phone, through a quick tunnel

`/remote` is a page you open on a phone to drive this app from the sofa. It is not a second
UI: it is the same server, published through a Cloudflare **quick tunnel** - no account, no
DNS record, a hostname Cloudflare mints per start - and gated by a pairing token that only
exists while the tunnel does.

The reason it is a separate page rather than the desktop window squeezed onto a phone is the
same reason the bridge is a separate listener: the desktop UI assumes a pointer, a keyboard,
and a machine that is not on a train. The phone page answers one question - "can I reach it
right now?" - and offers one action that matters, which is to stop sharing this machine.

`src/remote.mjs` owns the whole lifecycle; `src/ui.mjs` only routes to it.

| Route                       | Method | Who may call it                                        |
| --------------------------- | ------ | ------------------------------------------------------ |
| `/remote`, `/remote.html`   | GET    | anyone, but the page carries the write token only on loopback |
| `/remote.js`, `/remote.css` | GET    | anyone (static, no secrets)                            |
| `/api/remote/status`        | GET    | loopback with the write token, or a paired phone       |
| `/api/remote/enable`        | POST   | loopback + write token                                 |
| `/api/remote/disable`       | POST   | loopback + write token                                 |
| `/api/remote/revoke`        | POST   | loopback + write token                                 |
| `/api/remote/check`         | POST   | loopback + write token                                 |
| `/api/remote/unpair`        | POST   | a paired phone, so it can forget itself                |

**The states are five, not two.** `idle`, `starting`, `live`, `stopping`, `failed`, each with a
sentence in `reason` a person can act on. `enable()` returns the moment `spawn` returns, so a
button click is not a 5-second freeze, and it is idempotent: a second click during `starting`
or `live` returns the current status instead of starting a second connector. `disable()` awaits
the kill and always resolves to `idle`, because its caller is a button.

**The binary comes from the machine, and says so when it does not.** `locateCloudflared` looks
for `cloudflared.exe`, `cloudflared.cmd`, `cloudflared.bat` and `cloudflared` in each `PATH`
entry in that order (Windows will not run a `.cmd`/`.bat` through `spawn` without a shell, so
naming them matters), and `ROSALENA_CLOUDFLARED` overrides it with a full path. When neither
finds a file the state is `failed` with the path it tried, the variable's name, and
`https://github.com/cloudflare/cloudflared/releases/latest` as text in the page. Nothing
pretends a tunnel is live; there is no "probably worked".

**Flags, and the one that is not optional:**

```
cloudflared tunnel --url http://127.0.0.1:<uiPort> --no-autoupdate --protocol http2
```

`--no-autoupdate` because a self-updating binary under a managed lifecycle is a bug waiting for
a release. `--protocol http2` because the default (`auto`) prefers QUIC over UDP 7844: behind a
TUN-style VPN or a QUIC-hostile firewall the connector keeps the hostname it was given while
reporting zero ready edge connections, and the auto fallback does not fire on a half-open
handshake - so the URL exists and nothing can reach it. HTTP/2 rides the TCP path the control
connection already uses. (The reference plugin, `@linxin666/dsh-remote-web-ui`
`lib/types/tunnel.js`, found this the expensive way: two fresh registrations stuck at ready 0
until the flag was added.)

**A live process is not a live tunnel.** That same failure - edge registration gone, process
still alive - made the reference plugin report `running` forever while every phone got
Cloudflare 1033, so this one watches its own public URL: one probe a minute, no token in it
(a 401 from our own gate is the proof the request arrived), and two misses in a row end the
state at `failed` after killing the process. One probe is spared because a single bad minute
should not tear down a working tunnel.

What it deliberately does **not** do, unlike the reference: restart. `failed` is terminal until
a person clicks again. A quick tunnel mints a new hostname on every start, so an automatic
restart loop would churn through URLs and QR codes that nobody is looking at, and would keep
publishing this machine after the person who wanted to stop looked away. The reference restarts
because it also supports named tunnels with a fixed hostname, where a restart is invisible to
the phone; this feature has no named mode.

### The token, honestly

Minted by `randomBytes(32).toString("base64url")` - 256 bits, 43 characters - when
`enable()` runs, before the URL is known, so `live` never exists without a credential.
Compared with `timingSafeEqual`. It lives in memory only: no file, no log, no argv.

- In the **link** (`?t=...`) and, after the first page load, in an `HttpOnly; SameSite=Lax`
  cookie that replaces it in the address bar. `Secure` is added when the request arrived
  over HTTPS (verified through `x-forwarded-proto` or Cloudflare's own headers) - not
  unconditionally, because a plain-HTTP request that is sent a `Secure` cookie silently
  drops it.
- Required on **every** request through the tunnel, page and API alike, including
  `/api/remote/status`; a non-API request with the token in the query is answered with a 302
  to the same URL without it and the cookie set, so the token leaves the address bar and
  stops travelling in `Referer` headers.
- **Revoke** mints a new one without touching the tunnel: links shared before now get 403.
- It dies on every path out of `live` - `disable`, a child exit, a start timeout, a startup
  error, a watchdog failure. A failed tunnel that still honoured its old links would be a door
  with a "closed" sign on it.
- After a restart the tunnel is a **different hostname** with a **different token**, so an old
  bookmark is dead twice over. This is the honest cost of a quick tunnel: the phone must scan a
  new code each time. A named tunnel would keep the address; it also needs a Cloudflare account,
  which is the thing this feature exists to avoid.

What a leaked link exposes: this app, at whatever it can do, to whoever holds it - the whole
API, every session, every file the app can read, for as long as the tunnel is up. There is no
per-device identity behind the token, so "who used the link" is not answerable, and a phone
that keeps the cookie keeps access until the tunnel stops or the token is revoked. The
`canControl` split keeps the *write* token on loopback, so a paired phone can watch the state
and unpair itself but cannot enable, disable, revoke or start a probe - a leaked link cannot
become a port that stays open.

And the thing worth saying out loud: **while the tunnel is live, this machine is on the public
internet, and Cloudflare is inside the trust boundary.** A quick tunnel terminates TLS at
Cloudflare's edge, so the edge can read the token - in the query string on the first request and
in the cookie on every one after it - along with every request and response that passes
through. That is the price of needing no account: the tunnel is private from other users of the
internet, not from Cloudflare. The token is also one barrier, not a security model: 256 bits of
randomness with no rate limit of its own (Cloudflare throttles, not this app), no per-device
identity behind it, and no second factor. Anyone holding the link is inside the gate, not
merely at it. It is not a VPN, it does not isolate the app from the machine, and it does not
stop the app's own tools from doing real things. Turn it off when you are done; that sentence
is on the page for a reason.

### The QR code

`src/qr.mjs` is a from-scratch ISO/IEC 18004 encoder: byte mode, versions 1-10, all four
error-correction levels, Reed-Solomon over GF(256), the eight mask patterns with the standard
penalty rules. `qrDataUri(link)` returns an SVG data URI built in this process, so the pairing
token never reaches an image service, a CDN, or a third-party QR API, and the page has no
network dependency to render it. One dependency here would have been a dependency that sees
the credential.

It is verified structurally rather than by a scanner - there is no independent QR decoder on
this machine - so the tests read the matrix back into codewords and check the round trip,
zero Reed-Solomon syndromes, the format information against the standard's constants
(`formatBits("M", 0)` is `0b101010000010010`), the finder patterns, the timing rows and the
dark module. That is the part a screenshot cannot prove: it would catch a wrong payload, not
an unreadable symbol.

### Verified, and how

- `test/remote.test.mjs` (45 tests) drives the whole lifecycle with a fake spawn and a fake
  fetch: no network, no binary. It covers idempotent starts, the missing-binary sentence, the
  start timeout, an unexpected exit, `stop` killing the tree (`taskkill /pid N /T /F` on
  Windows), the token on query/header/cookie, the 302 that strips it, revoke, the watchdog,
  and the routes end to end through a real socket - including that `/remote` served to a
  tunnel-looking Host carries **no** write token.
- One real tunnel was started and stopped on this machine (`cloudflared` 2025.x from
  `C:\Program Files (x86)\cloudflared`), and this is what the outside saw: hostname printed
  4.0 s after `enable()`; `GET <url>/api/remote/status?t=<token>` → **200** with
  `view: "remote"`, `canControl: false` in 421 ms; no token → **401**; a wrong token → **403**;
  `GET <url>/?t=<token>` → **302** with the cookie set; `GET <url>/` with no cookie → **401**
  HTML; the in-app "Test the link" probe → `ok` in 98 ms; `disable()` → `taskkill … exited 0`,
  state `idle`; and a request to the same URL two seconds later → **502** from Cloudflare,
  which is the edge saying the origin is gone. No `cloudflared` process was left behind.

One thing found rather than assumed: the first attempt reported the link as unreachable
because the probe ran ~100 ms after the hostname appeared, and Cloudflare had not routed it
yet. `check()` now retries a network failure up to three times and never retries an HTTP
refusal, because a 401 does not become a 200 by waiting.

## Not built yet (in the order I would do them)

1. ~~**Streaming.**~~ Done: `stream: true` by default, `tool_calls` fragments
   accumulated by `index`, prose on stderr as it arrives, a buffered reply tolerated,
   and one spare attempt for a truncated stream (see the streaming section above).
2. ~~**The failure loop.**~~ Done: a judge rejection returns with its reasons and the
   evidence, gets a bounded fix round, and a rejection that survives is reported and
   exits 2 (see the judge â†’ fix section above).
3. ~~**Memory.**~~ Done: a rolling summary over the oldest span (`--compact-at` 0.55 of
   the window, the request kept verbatim, mechanical fallback) plus a project-aware JSONL
   store the model writes with `remember`/`recall`, and a live context meter in the UI
   (see the memory and context-meter sections above). Â§5.2's other two halves are
   items 5 below.
4. ~~**Durable goal mode + watchdog.**~~ Done. `.goal-state.md` is now read at the start
   of a run (`--goal`, or any `--goal-file`), the round the run would write is printed
   before it starts, and the harness **appends** exactly one entry when the run finishes
   (`goal round 1 recorded in â€¦GOAL.md by the harness (671 bytes)`), marking it done when
   the model asked for `goal_update`. `goal.mjs` owns the format and the single append
   path; `readGoalState`/`formatGoalEntry`/`appendGoalEntry` are unit-tested against a
   temp file, never the repo's real `.goal-state.md`, and the interactive `/goal` command
   prints the file, byte count, round count, last heading and next round (or appends a
   hand-written note with `/goal <text>`).

   The watchdog is the half that had to be got right, because a hang had no recovery at
   all before it. `watchdog.mjs` provides a per-step deadline (default 300 s), a
   per-tool-call deadline (120 s) and a stall detector, all wired into the loop:

   - **A hung step is aborted and retried once.** A step that dies in transport cannot
     have run a tool (tools execute only after a step completes), so one spare attempt is
     safe; the retry lives in the harness because the router cannot retry a stream it has
     already started forwarding.
   - **A timed-out tool call is answered with an error**, always: an unanswered
     `tool_call_id` is a malformed history and the next request 400s.
   - **The tool deadline is per call, not one number for the run** (`escalatedToolTimeout`):
     300 s by default, 450 s for tools whose honest work is minutes (`run_command`,
     `delegate`), 600 s for a tool that already used most of its deadline in this run or
     was killed at it, and whatever a call asked for (`run_command`'s own `timeoutMs`, up
     to ten minutes) plus 30 s of grace, so the child's kill message reaches the model
     instead of losing a race with the watchdog. Measured 2026-11-06: a whole-project
     `findstr` was killed at 120 s while still working, and the run ended without the
     search it needed.
   - **Ownership is split on purpose.** Timeouts are the core watchdog's exclusive job â€”
     no plugin hook can cancel a call that is already in flight. Loop and repeat *policy*
     belongs to the bundled `rosa-finish-loop-guard` plugin (three signals, nudge-then-stop),
     which is loaded unconditionally; the core stall detector is therefore an **opt-in
     backstop, default off** (`--repeat-limit N`), so the two cannot both claim the same
     decision.
   - **Everything is reported as an event**: `step_timeout`, `tool_timeout`, `repeat`,
     plus `goal`/`goal_written`/`goal_error`/`goal_done_requested`, and `--check` prints
     the live settings (`watchdog step 300s, tool 300s, repeat limit 0`).
   - **One real bug came out of this path and only this path.** `abortAfter(ms, cb)` was
     called with a bare callback while the function destructured `{ onFire }`, so the
     step-timeout event was *silently* never emitted: the run timed out after 1690 ms of
     retries and reported nothing. Both call sites were fixed and `abortAfter` now accepts
     a bare function, with a regression test that fails if the callback is ignored again.
5. **Per-tool context sizing, and the tool-output cache.** ~~Clipping is global, not per
   tool~~ â€” **done**: `src/context.mjs` holds a profile per tool (budget, which end to
   keep, and a token weight measured on the real tokenizer), `--context` prints the
   table, and `read_file` is cached for the run on the file's own identity. What is
   left is the *other* cheaper win: a budget is still a flat character count, so a file
   whose first 8 KB is a license header spends the whole budget on nothing. A
   structure-aware read (skip to the first symbol, elide long string runs, keep the
   lines that match the task) would buy more than any further cache. The measured
   weights also want re-measuring whenever the local model changes â€” the calibration
   block in `context.mjs` names its own date and model for exactly that reason, and
   the test that pins each weight to its sample is what makes a re-measure safe.
6. **Auth on the router** before any of this leaves `127.0.0.1` â€” which now covers
   the MCP surface too.
7. **A *remote* store, with a real trust story.** The store exists: an index, version
   pinning, install/update/verify, sha256 integrity, ed25519 signatures with
   `store.trustedKeys`, and a lock that makes drift visible. An http index is already
   fetched and a remote index is already refused unless it is signed by a listed key.
   What is missing is the thing that makes it a *store* rather than a good installer:
   somewhere to publish to. Today the index is a file in this repo and the two modules
   beside it are the catalogue â€” a third party has no way to ship one, and there is no
   store UI to browse, install from or update through (the chat window is not one; the
   store is still a command). That is a distribution problem, not a mechanism problem,
   and it should wait for a second machine that wants a module the first one wrote.

## Why it is shaped this way

It would be easy to make this bigger: a plugin system, a config file per project, a
web UI. That was deferred until the loop was correct â€” the loop is 200 lines, it has
17 tests, and it was verified against a real model before any of the rest was
written. The plugin system came afterwards, on the user's direction, and the
ordering paid off: the core loop is untouched by it, because a plugin adds tools to
a registry rather than changing the loop. The browser window came last and changed
nothing in the loop at all: it is one more caller of `runAgent` and one more reader of
the run store, which is why the two defects it exposed were in the page's grid and in
the seed path â€” not in the agent.
