# Rosalena Harness changelog

Newest first. "Local build" means built and installed on Jayden's PC only (not released,
not committed yet). Released versions are on https://rosalena.pages.dev/download/.

## 0.1.14 (2026-11-09): Spanish, Codex and Claude Code sign-ins, phone access, browser tab, session rail, Linux
### Session rail

- **A per-chat panel** beside the chat (Docked, 300 px) or sliding over it (Overlay; Esc or a
  click outside closes it): Environment (folder, path, git branch, Access, Commits), Context
  (% of the window with the compaction mark), Connectors (this folder's MCP servers, with the
  ones needing attention counted), Outputs (files the chat wrote, newest first, open in the file
  viewer), Changes (+added / -removed for the whole chat, from the undo journals and shell
  snapshots, `GET /api/session-rail`) and Background tasks (subagents, background shells, goal
  rounds, with live elapsed time).
- Toggle in the chat header, Ctrl+. to show or hide, Ctrl+Shift+. to switch mode, a row in
  Settings > Appearance and two palette entries. Too narrow to dock: it overlays without
  changing the saved choice.
- Claude Code chats now report context readings too, so the composer gauge works for them.

### the app in Spanish (Settings > Appearance > Language)

- **Language setting**: English (the default), Español, or "Match my system" (`navigator.language`
  in the window, `app.getLocale()` in the shell). Saved with the window's look (`rosalena-language`
  in ui-state.json); changing it saves to the server first, then reloads the window and reopens
  Settings on the same page. Runs keep going. `<html lang>` follows it. Search finds the row as
  "Language" and "Idioma" in either language.
- **`harness/ui/i18n.mjs`**: `t(key, vars)` with `{name}` variables and `{ one, other }` plurals
  (Intl.PluralRules); the key is the English text, so English output is byte-identical to before.
  Tables in `harness/ui/locales/en.mjs` and `es.mjs` (~1,880 keys; glossary at the top of es.mjs).
  index.html is translated by attribute (`data-i18n`, `data-i18n-html`, `data-i18n-<attr>`) at load,
  before app.js reads the markup.
- **Translated**: index.html (window, composer, sidebar, rail, inspector, phone panel, setup
  dialog, every Settings page), app.js (menus, model picker, effort and access menus, toasts,
  dialogs, empty states, first-run setup, share/telemetry card, command palette, "+" menu, tabs,
  settings pages), format.mjs (model picker headings, status chips, relative times), phone.js,
  session-rail.mjs, web-tab.mjs, panels.js, plugins-ui.js, ui-styles.js, and the desktop shell
  (native menus with Spanish role labels, dialogs, update prompts, notifications;
  `rosalenaDesktop.setLanguage` rebuilds the menu live).
- **Left in English**: model output and everything sent to models, server-generated text (errors,
  provider rows, prices like "per Mtok", slash-command descriptions), plugin-provided text, the
  standalone pages the overlay shows (/usage, /models, /plugins, /network, /exits, /monitor,
  /remote), router-supervisor diagnostics, product/model/provider names, commands and shortcuts.
- persist.js exposes `rosalenaPersist.flush()` (the language change waits for it: the reloaded
  page takes the server's saved state over its own storage). New test `harness/test/i18n.test.mjs`
  (same keys and placeholders in both tables, every `t()`/`data-i18n` key exists and is used,
  no leftover English, English output unchanged).

### Codex as an engine (your ChatGPT plan)

- **OpenAI's Codex CLI answers inside Rosalena**, the way Claude Code already does
  (`harness/src/codex-engine.mjs`). When Codex is installed and `codex login status` says it is
  signed in, the model picker gets "Codex · your ChatGPT plan": its default model, GPT-6.1-Sol,
  GPT-6-Astra, GPT-6.1 Terra and GPT-6-Luna, each with the effort levels Codex takes for it
  (Ultracode asks for Codex's own `ultra`). Rosalena never signs anyone in: the person runs
  `npm install -g @openai/codex` and `codex login` once, and Settings > Providers > Subscriptions
  shows Codex's status with that how-to.
- Each message runs `codex exec --json` with the task on stdin; the stream becomes Rosalena's
  events (messages, shell/patch/MCP/web-search tool rows, plan and thinking notes), and the next
  message resumes the same Codex thread (`codex exec resume <id>`), after a restart too. Access maps
  to Codex's sandbox: Read/Plan read-only, Workspace workspace-write, Auto `--approve-for-me`,
  Full danger-full-access. Stop ends the process tree; a missing sign-in says "run `codex login`".
- Usage counts this run's share of the thread's tokens; the context gauge is an estimate (Codex's
  stream gives the turn's summed input, not the last call's). The router's `OPENAI_BASE_URL`, a
  parent Codex session's `CODEX_SANDBOX*`/`CODEX_THREAD_ID` and Rosalena's router token are not
  passed to Codex; the person's own `OPENAI_API_KEY`/`CODEX_API_KEY` are.
- Settings' "Check again" now asks Claude Code and Codex afresh instead of the 5-minute answer.
  Not run against a real Codex yet (it isn't installed on the dev PC): tested with a fake CLI that
  streams the real JSONL shapes.

### in-app browser tab, Claude Code found again, site light theme and Linux box

- **Browser tab in the sidebar** ("+" > Web > Browser): a real browser in the window (Electron
  `<webview>` on its own saved session `persist:rosalena-browser`, no Node, sandboxed, no access
  to the app's own server or `file:`), with back/forward/reload, an address box that also
  searches (DuckDuckGo), "To chat" (title, URL and selected text into the message box) and
  "Open in your browser". Tabs come back after a restart. "+" > Web > "Get SolBrowser…" sets
  up the bundled extension or opens its download page. Rules in `harness/ui/web-tab.mjs`.
- **Claude Code shows up in the model picker again.** The Windows desktop app moved Claude Code
  to `%LOCALAPPDATA%\Claude-Data\claude_<package>\claude-code\<version>\<hash>\claude.exe`;
  `findClaudeCode` now looks there first, so "Claude Code · your Claude plan" is listed again
  when it's installed and signed in.
- **Site light theme**: a soft grey-teal light mode on every page (home, download, SolBrowser,
  try, harness, check), one switch in each header, one saved choice for the whole site
  (`/theme.js`, key `rosalena-theme`; `?theme=light|dark` picks one for a visit). Dark stays
  the default.
- **Download page Linux box**: "Linux: not built yet" until `releases.json` lists a Linux file,
  then "Download for Linux" (the AppImage, with the .deb under it). Linux visitors are
  detected (Android and Chromebooks aren't); a Linux card shows even when a manifest leaves
  Linux out.

### Phone access

- **A phone button in the sidebar footer** opens the Phone access panel: an on/off switch, the
  state (starting / live / stable link / problem with the reason), a large QR code, the link with
  Copy, New QR code, Test the link, the paired devices with Unpair, and Unpair all. Opened on a
  paired phone it only offers "Unpair this device".
- **Settings > Phone access** (Basics): keep it on at startup, the stable link (relay) on/off,
  how long an unused device stays paired (1 day to 1 year, 90 days by default), your own named
  Cloudflare tunnel (hostname, token, local port), Show QR code, and Unpair all. Search finds it.
- **Pairing survives restarts.** `<ROSALENA_HOME>/remote/state.json` (0600, atomic writes) holds
  the pairing code, the relay id + secret, the paired devices (hashed session secrets only) and
  the settings. Each scan makes its own device session in an HttpOnly `__Host-` cookie; one
  device can be unpaired (its open streams close too); Unpair all replaces the code and the link.
- **The QR's code rides in the URL fragment** (`#pair=`), which no server sees: not Cloudflare's
  edge, not the relay, not cloudflared. The blocking page posts it to `/api/remote/pair`. Wrong
  codes are rate limited (10 per client, 60 in total per 10 minutes).
- **Nothing to install:** cloudflared is downloaded on first use from Cloudflare's GitHub release
  into `<ROSALENA_HOME>/remote/bin`, size and SHA-256 checked (the API's digest, or pinned
  2026.10.7 checksums when the API is unreachable). `ROSALENA_CLOUDFLARED` and PATH still win.
- **Fixed: a quick tunnel answered 404 to everything** on any PC with `~/.cloudflared/config.yml`
  (any named tunnel, e.g. apply.tessalydesign.com): its ingress overrode `--url`. Rosalena now
  passes its own empty `--config`.
- **Stable link:** `site/relay/` is a new Worker (`rosalena-relay`, D1) that forwards
  `https://<id>.rosalena.dev` to the install's current quick tunnel. Not deployed yet: deploy
  steps in `site/relay/README.md`. Until then the panel shows the raw tunnel link and says so.
- **Keeps itself up:** with the switch on, a cloudflared that exits or stops answering is started
  again after 2 s, 4 s ... 60 s, and re-registers with the relay. The tunnel now also stops when
  its UI server closes (it used to outlive a workspace switch).
- **Phone layout:** at phone width the panel is a bottom sheet, the page leaves room for the
  inspector rail, the status bar is dropped, inputs are 16 px and touch targets 44 px.
- Tests: harness `phone-access.test.mjs` (20, incl. a QR read back from the rendered SVG),
  `remote.test.mjs` updated (45), site `relay.test.mjs` (8).

### telemetry on by default, with an off switch

- **Sharing is on by default and one click turns it off** (`SHARING_IS_OPTIONAL = true`,
  `UNCHOSEN_SHARING = "full"`). The first-run card says exactly what is sent and offers Keep sharing
  / Numbers only / Turn it off; the switch stays in Account and Settings > Advanced. "Off" sends
  nothing at all.
- **"Full" now covers every cloud model**, the person's own keys included (it used to be only
  Rosalena's free models): the task, the answer, the model, tokens, errors and a per-step trace
  (`runTrace`: model calls, tool calls with short args and previews, notices). Local models still
  never send words.
- **Secret scrubbing** covers more shapes before anything is sent: Anthropic/OpenAI/DeepSeek-style
  `sk-` keys, GitHub, Google, AWS, Slack and Stripe keys, private key blocks, JWTs, bearer headers
  and `api_key = "..."` assignments.
- The site keeps a cloud run's trace in `data` (capped at 16,000 characters); local runs lose it.
  The download page now says what is collected and how to turn it off, instead of "no telemetry".
- Tests: harness telemetry 24/24 (4 new), site 187/187 (2 new).

### public MIT repo

- `node packaging/tools/export-public.mjs <folder> [--commit "msg"]` writes the open source copy:
  the tracked files minus this machine's runs, probes, ledgers, the dev exe, internal research
  notes and the release workflow, plus the MIT LICENSE and the public README
  (`packaging/public/README.md`). SolBrowser's bundle and extension are included (it ships with
  Rosalena); the bundler's temp-folder comments are rewritten. It stops if a secret-shaped string
  appears outside a test, and stages files by name in a fresh repo with its own history.

### site on rosalena.dev

- **rosalena.dev is the site's address.** Bought by Jayden; `rosalena.dev` and `www.rosalena.dev`
  are custom domains on the `rosalena` Pages project (live with HTTPS). `rosalena.pages.dev` keeps
  serving the same site, because installed apps get updates and pair the /try/ page through it.
- The site's canonical links, sharing tags, structured data, sitemap and robots.txt name
  rosalena.dev. The trial and telemetry (`TRIAL_ORIGIN`) now take a list and accept rosalena.dev,
  www.rosalena.dev and rosalena.pages.dev (`site/test/origins.test.mjs`).
- The desktop app's local bridge trusts rosalena.dev and www.rosalena.dev too (ships with the next
  release; until then the /try/ page pairs through rosalena.pages.dev as before).
- Site tests 185/185. Not deployed yet: until it is, the trial on rosalena.dev answers 400.
- AEO audit (local copy): the only real FAIL is old: /check/ shows crawlers 44% of its words,
  because its model list is drawn after the browser reads the graphics card.

### DeepSeek, Z.AI and Kimi as direct providers

Not committed yet. Tests: router 158/158 (6 new in `test/direct-providers.test.mjs`), harness
1247/1247.

- **Three new providers, each on its own API with your own key** (Settings > API keys), next to
  the free shared window that already served DeepSeek and GLM:
  - **DeepSeek** (`api.deepseek.com`): DeepSeek V4.1 Flash ($0.30 / $1.20 per million at peak,
    half off-peak) and DeepSeek V4 Pro ($1.32 / $3.96).
  - **Z.AI** (`api.z.ai/api/paas/v4`): GLM-5.3 ($1.40 / $4.40), GLM-5.3 Flash ($0.15 / $0.50) and
    GLM-4.7 Flash (free, still needs a key). A GLM Coding Plan key uses a different endpoint and
    is not supported here yet.
  - **Kimi (Moonshot)** (`api.moonshot.ai/v1`): Kimi K3.1 Pro ($2 / $10), K3.1 Pro Highspeed
    ($4 / $20) and K3 ($3 / $15). The account needs a $1 top-up first; the K2 models are left
    out because Kimi retires them in December. Kimi's prices came from price trackers (its own
    table only renders in a browser).
- Each has effort levels low / high / max, defaulting to high. GLM-5.3 and Kimi K3.x think at
  max when no effort is sent, so the router now sends `high` unless you pick a level
  (`effortWhenUnset`). Effort levels can be set per model on OpenAI-style providers, so the free
  GLM-4.7 Flash gets no effort field and shows no default.
- All three get thinking passed back in the history (DeepSeek rejects a tool turn without it),
  a $10 monthly spend cap, menu headings ("DeepSeek · your API key" and so on) and spend-page
  names.
- Checked live: each endpoint answered a fake key with 401 (right address and format), the
  router sent each model to its provider with its key, and a key saved through the app was
  used on the next request.

### New icon, folder-tab bug hunt

Tests: harness 1247/1247, plus `test/folder-tabs.test.mjs` (8 new).

- **New icon: a crowned rose.** An open pink rose with a teal crown sitting in its petals, on
  the same dark tile with the teal edge. It replaces the geometric R on the app, the taskbar,
  the installers (Windows and Mac), the dev launcher and the website (favicon and the logo in
  the header). The source is `packaging/assets/icon/rosalena-icon.svg`;
  `python packaging/tools/render-icon.py` draws it to PNG at every size, and
  `node packaging/tools/make-icon.mjs` packs those into `rosalena.ico` / `rosalena.icns`
  (`--check` reads both back and checks each size shows the rose).

- **Big folders are really capped.** The server said "capped at 2000" but sent every entry, so a
  folder like `C:\Windows\System32` drew thousands of rows. It now sends folders first, then
  files, up to 2000, and stats only those (System32: 2000 rows in about 0.5 s).
- **Listing no longer blocks the server.** `/api/files` reads with async fs (`src/list-folder.mjs`),
  so a folder tab on a network share that went offline can't freeze the whole app.
- **Linked folders open.** A junction or symlink to a folder listed as a file that couldn't be
  read; it now lists as a folder (marked "link").
- **A folder named `..cache` (any name starting with `..`)** was refused as "outside the
  workspace", in the Files tab and the file viewer. `..` now counts only as a whole path part.
- **Folder… checks the path first.** A mistyped or missing path used to add a broken tab; now
  it says "there is no folder there" and adds nothing. A path typed differently from an open
  tab (`d:/appdev/x/` vs `D:\AppDev\x`) switches to that tab instead of opening a duplicate.
- **Closing a folder tab while it loaded** left a blank tab when it was opened again, and could
  mount two copies of the panel. Fixed.
- **Two folders with the same name** ("src" and "src") now read "src (Rosalena Harness)" and
  "src (Tessaly)".
- **Up stops at a network share's top** (`\\server\share`) instead of going to `\\server`,
  which isn't a folder.
- **Open shows the folder itself** in File Explorer, not the folder selected inside its parent.
- **The picker** says "Show a folder in the sidebar" and opens at the tab's current folder
  (Change…), not "Choose this chat's folder" at the app's folder.
- The Files panel's footer said "capped at 2000" twice; a folder tab's panel says "folder"
  instead of "workspace" in its loading and Retry text; a stale page token and a missing
  folder each get a plain sentence.

## 0.1.13 (2026-11-08): folder tabs

- **Folder tabs in the sidebar.** The + menu has **Folder…**: a Files tab on any folder on this
  PC, not only the chat's workspace. Open as many as you like.
  - Each tab has **↑ Up**, which goes to the parent folder (all the way to the drive), plus
    **Change…** and **Open** (in File Explorer).
  - Clicking a file opens it in a viewer tab.
  - The tabs stay open across restarts, and the + menu lists the open ones.
  - Reading outside the workspace still needs the window's own token, so a page or a tool
    can't do it.
- Fixed: full screen on a sidebar folded to its rail showed an empty rail. It now opens the
  sidebar first.
- Before the plugin list loads, a sidebar plugin tab reads "Style Lab", not "rosa-style-lab".

## 0.1.12 (2026-11-08): plugins named rosa-, DeepSeek Harness split out

- **Every built-in plugin is now `rosa-<name>`.** For example `model-pin` → `rosa-model-pin`,
  `style-lab` → `rosa-style-lab`, `opencode-handler` → `rosa-opencode-handler`. That's 32 plugins:
  folders, ids, and every place the app refers to them.
- **Nothing saved is lost.** Old names keep working through one map (`harness/src/plugin-names.mjs`):
  - Plugins-page and Creator switches, and `harness.config.json` blocks under an old name;
  - commands like `/plugin local-model-host:list` and the `/mcp-manager tools` shorthand;
  - sidebar tabs, and a sidebar plugin's saved data (moved to its new name the first time it
    opens);
  - the Style Lab theme.
- **Kept as they were:** skill names (`commit-cadence` the skill), plugins' own data folders
  (`~/.rosalena/code-intel`), tool names, and the `[advisor]` tags the model reads.
- **The DeepSeek Harness plugins left this repo.** `dsh-plugins/` is now its own project at
  `D:\AppDev\dsh-plugins` with its own git history. DSH's profile points there and keeps working
  under the `dsh-` names.
  - Rosalena no longer checks DSH's profile or plugin in its tests.
  - Docs and plugin notes no longer tell anyone to keep the two in step.
- **The composer's shield chip just says the access level** ("Full access"). The MCP count moved
  into its menu, on the MCP servers row.
- **Two small changes that come with the split:**
  - Failed turns now say `[Rosalena error KEY]`, not `[DSH error KEY]`.
  - `rosa-opencode-handler` reads DeepSeek Harness's credentials and rate-limit files only when
    `includeDsh: true` is set (it used to by default).

## 0.1.11 (2026-11-08)

### Agent and models
- **Goal mode keeps going.** A message that starts with "Goal mode." or "Goal:" is now a goal, and
  so is "continue" on a goal chat. Before, only `/goal` was. A **Goal** button sits next to Plan.
  Goals are long-horizon tasks: each round gets 800 steps, or your "Steps per message" setting
  if that is higher. Goal runs also get up to 50 "carry on" rounds that name the open task-list
  items, and 25 fresh-context rounds instead of 10.
- **More steps per message by default:** 200, up from 100.
- **Claude replies are no longer capped at 4,096 tokens.** The router lifts an agent step to the
  model's own default (32,000 for Claude 5.x). A reply that comes back empty because it hit the
  limit is asked again with 4x the room.
- **Steer.** A queued message has a **Steer** button. The running chat takes it in at its next step
  instead of after it finishes.
- **The context window applies right away.** Changing it reaches a running chat at its next step,
  and a finished chat's gauge updates without sending a message. The exact-size box moved from
  Settings to the gauge next to the composer.
- **Each chat keeps its own model and effort,** including Ultracode. A chat from before this
  reopens on the model it actually ran on.
- **Fixed: Stop didn't work over ACP.** A cancelled request made the run wait two minutes for
  the router. Only real network failures wait now.

### Tools
- **`edit_file` takes an `edits` list:** several changes to one file in one call, all or nothing
  (like Claude Code's MultiEdit).
- **New `move_file` and `delete_file`:** one file at a time, inside the workspace, both undoable
  from the chat (the file's contents are kept in the run's undo journal).
- **Desktop control gets `desktop_move` (hover), `desktop_zoom` and `desktop_wait`.**
  `desktop_zoom` takes a full-resolution look at part of the last screenshot, for small text and
  plugin knobs. Zoom and wait only look, so they never ask; move asks like a click.

### Commits
- "Skip", "not now", "don't commit" and similar are remembered. The same held-back commits are
  not asked about again until something new is held back. Before, every message got the
  commit question again instead of an answer.
- **Fixed: the Commits menu changed the wrong folder.** It wrote the app's default folder; it now
  changes the folder the chat works in.

### MCP and plugins
- **MCP button** next to the composer, also in More > MCP servers and on the Plugins page. Each
  server has an on/off switch, a Check (starts it once and counts its tools), Add and Remove.
  It can also import the servers Claude Code already has; they arrive switched off.
- **Core plugins.** 21 bundled plugins that are really app features are marked `core`: commits,
  the task list, MCP, the local model host, SolBrowser, Style Lab and others. They show as
  "built in".
  - They can still be switched off, so a plugin you build to replace one doesn't collide with
    it. The Plugins page asks first and says what turns off.
  - They can't be removed.
  - If one that should be on fails to load, the app says so at start instead of the feature
    quietly vanishing.
  - A test loads every core plugin with the shipped config.
- **`opencode-freeaccess` is now `opencode-handler`.** Its commands are `/opencode-handler ...`
  and its state file is `.opencode-handler.json`. The separate DSH plugin keeps its own name.

### Spending
- **Settings > Spend limits** shows each paid provider's spend this month and its monthly limit,
  and lets you change the limit. The change applies to the next message, with no restart, and
  survives updates (`router/state/budgets.json`). The shipped Anthropic limit is $80.

### Window and navigation
- **Fixed: "+ Folder" and Rename did nothing.** The desktop app ignores `window.prompt()`, so they
  now use an in-app text box. The answer-feedback note had the same bug.
- **Fixed: "More settings…" did nothing.** It opened Settings and the same click closed it again.
- **Recent can be grouped** by your folders, by the workspace each chat works in (with a + to start
  a chat there), or not at all.
- **The right sidebar has a + button.** It adds tabs: Tasks, Local models (live), Context
  (fill and every compaction), Chat models (each chat's model and effort), Terminal, and any
  sidebar plugin (Style Lab, Paper Reader, ...).
- **The More menu is regrouped.** "Usage & monitor" opens with Tokens and Monitor tabs, and
  "Network" folds out Wi-Fi networks, VPN exits and the VPN switches.
- **Pages open over the chat.** Tokens, Monitor, Models, Plugins, Wi-Fi and VPN no longer reload the
  whole app. Their own "Back to chats" link or Esc closes them, and the window's title strip
  stays usable above them.
- **Clicking a file in the Files tab opens it in a viewer tab:**
  - text and code with line numbers, and Markdown rendered;
  - pictures, PDF, video and audio;
  - HTML pages, sandboxed so they can't reach the app;
  - PowerPoint, Word and Excel files as their slides, pages and sheets, with the pictures inside.
    This is read by a small built-in zip reader, so Office isn't needed.

  The newest 8 files stay open as tabs. Files are served only from inside the workspace, through
  a one-file ticket.
- **The sidebar has a full-screen button (⛶).** Esc returns.
- **A chat that ends early says why** in a card with Continue and Raise-the-limit buttons. That
  covers the step limit, time limit, spend limit, a run repeating itself, empty replies, and a
  goal that used all its rounds.
- **The last chat you viewed is remembered,** across pages and restarts.
- **Queued messages stay with the chat they were typed in.** If you move to another chat, they
  are delivered to their own chat when its run finishes.
- **Appearance moved into Style Lab.** Theme, palette, accent, text size, density and what the
  window shows are now there, with a live preview. Plugins get an `appearance` permission.
- **Settings is wider and has five pages:** General, Agent, API keys, Model fallback and Spend limits.
  - **API keys** starts with your keys. A strip shows which providers have a key saved, and each
    key row says "✓ Saved" or "No key".
  - **Model fallback** (was "Orchestration") lists, for each kind of work, which models are tried
    in order. Each step says whether it can answer now (on this PC, no key, limit reached), and
    has a fix button.
- **Right-click > Copy** works on selected text, and text boxes get Cut/Paste/Select all. Selected
  text is clearly highlighted in every theme.
- **Esc leaves full screen** (a video, a file viewer, a plugin) and goes back to the chat from a
  plugin page. One press closes whatever is on top, never two things.
- **Running work** says what each background job is, which chat started it, which model drove
  that chat, and how long it has run. Click a job to open its chat.
- **Fixed: the router reconnect waited out a Stop.** See "Stop over ACP" above; the reconnect
  itself (wait up to 2 minutes for a dropped router, then carry on) is unchanged.

### Composer, tidied (2026-11-08)
- The prompt sits on its own line in one card, with a single row of tools under it:
  **Attach · Model · Mode · Access · Mic · Send**. Before, nine controls shared the prompt's row
  and Send wrapped onto a line by itself.
- **Effort** sits right after the model as a small ⚡ chip: Default, the levels this model takes,
  and Ultracode. It's the same per-chat setting as the model menu's Effort row, it lights up
  when a level is chosen, and it hides when the model offers no levels.
  - "Default" says what it comes to on the model you picked, in dim text: **(medium)** on Claude
    Opus 5.5 and Haiku 5.5, **(high)** on Sonnet 5.5 and Fable 5.1 (the API's own defaults when
    no effort is sent), and **(thinking off)** on the models on this PC.
  - These come from a new `defaultEffort` field in `router.config.json`, per model or per
    provider.
  - Fixed: the models on this PC were offered Extra, Max and Ultracode, which they can't take.
    They now list only Low, Medium and High.
- **Mode** holds Plan, Goal and Creator, each with one line saying what it does. The chip names
  whatever is on ("Plan + Goal") and lights up, so you can see the state without opening it.
- **The shield chip** holds Access, Commits and MCP servers. It shows the access level and how
  many MCP servers are on ("Full access · MCP 2/3"), and a dot when commits are waiting for you.
  Its MCP row opens the same MCP panel as before.
- In a narrow panel the row stays on one line: the chips shorten their text instead of
  wrapping. The menus stay inside the window, and Esc or a click elsewhere closes them.
- Fixed: the prompt could open 220px tall. It was sized before it had a width.

### Bug hunt (whole app, 2026-11-08)
Three passes over the engine, the server, the router, the plugins and the window found 35
problems. All are fixed in this build except where noted.

- **Security**
  - The file viewer no longer puts the page's token in a link. A sandboxed HTML file could read
    its own address. Each file now gets a ticket that opens that one file for 30 minutes.
  - A path outside the workspace answers "outside" whether or not it exists, so nothing can
    probe the rest of the disk.
  - Writes follow links before checking the workspace. A link inside the workspace that points
    outside can no longer be written through.
  - An Office file that unpacks to gigabytes (a zip bomb) is refused.
  - Pictures are the only thing served from inside an Office file.
  - Moving or deleting `.env`, `.pem` and `id_rsa` files always asks first.
- **Crashes**
  - A file that was locked or deleted while it was being shown took the whole app down. It now
    shows an error.
  - Claude Code chats could leave an unhandled error.
- **Spend limits**
  - A malformed limit (empty, null, not a number) used to become 0. 0 means no limit, so the
    cap was wiped. Now it's refused, and so is anything under 1¢.
- **Agent**
  - Empty replies spread across a long run added up and ended it. The count now resets after any
    real reply.
  - A reply that hit the length limit grows from what it really used (Claude already gets
    32,000).
  - Growth stops at 64K for Claude, GPT and Gemini, and at 16K for gateways and free routes,
    whose models refuse anything above their own cap.
  - Stop works during the router's reconnect wait.
  - A goal's state is put back after the emergency compactions too, not only the regular one.
  - "thanks" after stopping a goal no longer starts another goal round.
  - Steer refuses Claude Code chats (it could never reach them) instead of dropping the message.
  - `run_command` timeouts are held between 1 s and 10 min.
  - Renaming a file to a different case (`readme.md` to `README.md`) works on Windows.
- **Desktop control**
  - With no window picked, screenshots cover every monitor.
  - Coordinates are read the same way on PCs that write decimals with a comma.
- **Commits**
  - "fix the tests later" no longer counts as "skip the commits".
  - "ok skip" is a skip, not a yes.
  - Saying "commit" outright clears an earlier skip.
- **Window**
  - Esc that closes a menu or dialog no longer also stops the running chat.
  - On an overlay page, Esc first closes the page's own dialog, or leaves a field you're typing
    in.
  - The sidebar's + menu closes with Esc. It also lists a plugin you just switched on, and a
    failed read is tried again instead of showing no plugins until restart.
  - Queued messages:
    - files attached to one chat's message no longer go to another chat;
    - a queued message runs on its own chat's effort;
    - a message queued in a brand-new chat stays with it once the chat gets its id.
  - Switching chats can't paint the previous chat's context gauge onto the new one.
  - Reopening an overlay page you navigated within is recognised as the page already showing.

### Build
- Local builds now run `stage.mjs` first. One build on 11-08 had packaged the previous night's
  staging. `packaging/release/install-local.mjs` installs a local build into
  `%LOCALAPPDATA%\Programs\Rosalena-Harness`, waiting for running chats to go quiet first.

## 0.1.10 (2026-11-06)
OmniRoute built in, Claude on your API key with prompt caching, first-run setup, model list
headings that say free / your API key / your Claude plan. See the release notes on the site.
