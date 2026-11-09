# Rosalena Harness — the desktop app

A real window instead of a browser tab. It is a shell, not a port: the window loads the
*same* page, from the *same* server, out of the *same* engine the browser version uses.

```
desktop\main.mjs  ──imports──▶  harness\src\ui.mjs        (createUiServer, unchanged)
                  ──loads────▶  http://127.0.0.1:<port>/   (harness\ui\index.html + app.js
                                                            + format.mjs + styles.css)
                  ──preload──▶  desktop\preload.mjs        (window controls only)
```

Nothing inside `harness\src\` was modified or forked for this. If Electron disappeared
tomorrow, `node src\cli.mjs --ui 8090` would still be the whole product.

## Install and run

```powershell
cd "D:\AppDev\Rosalena Harness\desktop"
npm install     # once: Electron and its runtime
```

Then either **double-click `D:\AppDev\Rosalena Harness\bin\Rosalena-Harness.exe`** or the
`Rosalena Harness (dev source)` shortcut at the product root (the launcher opens this window
when it is installed; the same file runs
a CLI task when you pass arguments, and `--desktop` forces the window), or run
`npm start` here, which is what the launcher does for you (`electron .`).

- Node.js 20+ and Windows. Measured here: Node 24.18.0, Electron 44.9.1,
  `node_modules\electron\dist` = 368 MB in 73 files.
- No build step, no bundler, no transpile.
- **The window starts the router when nothing else is running.** `desktop\router-supervisor.mjs`
  probes `http://127.0.0.1:8077/v1` first: if a router is already answering there (the way
  the checkout has always been used) it is reused and nothing is started. If not, the
  supervisor starts `<resources>\router\src\index.mjs` — from the packaged app's
  `resources\`, or from `..\router` in this source tree — as a child of the app with
  `ELECTRON_RUN_AS_NODE=1`, an explicit `--config`, and a port the OS picks (never 8077,
  which is only assumed to be free). The window waits for `GET /v1/models` to answer before
  it loads the page; if the router cannot start within `ROSALENA_ROUTER_READY_MS`
  (default 20 s) the window still opens and shows a dialog naming the reason, the URL and
  the log directory, instead of a page whose every message fails. See *Where things live*
  for the state directory and `desktop\build.md` for the packaged layout.
- If no window appears, some automation shells export `ELECTRON_RUN_AS_NODE=1`, which
  makes `electron.exe` behave like plain `node`. Clear it first:
  `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`.

## The launcher's console and log

`Rosalena-Harness.exe` is compiled as a **GUI-subsystem** binary (`/target:winexe`), so
Windows allocates no console for it: a double-click opens the window and nothing else —
no black window behind the app, nothing that flashes and vanishes. That is measured, not
assumed: `packaging\build-exe.ps1` reads the PE subsystem field back out of the built file
and fails the build unless it is `2` (GUI).

A binary with no console still has to be able to report things, so output goes three places:

| How it was started | Where the output goes |
|---|---|
| from a terminal (`Rosalena-Harness.exe --check`) | the launcher **attaches to that terminal** and mirrors everything it logs and everything the child prints — same window, same scrollback |
| from Explorer (a double-click) | nothing to attach to, so everything goes to **`<data>\logs\launcher.log`** |
| a script with redirected stdio | the caller's stdout/stderr, plus the log file |

The log is `<product>\data\logs\launcher.log` (`ROSALENA_HOME` moves `<data>`). Each run
appends a header — the exe path, the arguments, whether a console was attached, the log
path — then the child's stdout and stderr, then its exit code. It is bounded rather than
growing forever: at 2 MB it is moved to `launcher.log.1` (previous one deleted), so the
pair never exceeds ~4 MB (the one case where rotation is skipped is in Known limitations).
If the log cannot be opened the run continues unlogged: a
read-only folder must not stop the app.

Two flags exist for the case where there is no terminal to read:

| Flag | Effect |
|---|---|
| `--console` | allocate a console if none is attached (a double-click with this flag opens a console window), mirror logs and child output into it, and wait for Enter before closing it |
| `--log` | print the log file's path, its size and its last 40 lines — to an attached terminal, to the caller's stdio when a script redirected it, and as a dialog box when there is neither |

Launcher-only flags (`--console`, `--log`, `--no-dialog`) are stripped before the rest of
the command line is forwarded, so the harness never sees them.

**Failures are dialogs, not silence.** A missing Node, a missing engine, a Node that is too
old or an Electron that is not installed each produce a `MessageBox` when there is no
console (and a logged line plus a terminal message when there is one). `--no-dialog` — or
`ROSALENA_LAUNCHER_NO_DIALOG=1` — suppresses the box for unattended callers. A console the
launcher **allocated** (`--console`) waits for Enter before it closes, on every path and not
just failures, because a window that dies with the process cannot be read; a terminal it
merely attached to is never paused, because it is the user's. `--log` deliberately does
**not** allocate one: with no terminal it shows its report in a dialog instead of a console
that would vanish before the first line was read.

Terminal output is **line-based**: the child's stdio is a pipe, not a TTY, so an interactive
prompt or ANSI colour is not identical to running `node src\cli.mjs` directly. One Ctrl+C is
forwarded to the child and the launcher then reports the child's real exit code.

Rebuild after changing the launcher or the icon:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\AppDev\Rosalena Harness\packaging\build-exe.ps1"
```

## The window is frameless on Windows, native on macOS

On Windows the native caption bar is gone and the title strip is part of the page. On macOS
the frame is real and the traffic lights are the OS's own (`windowChromeOptions()` in
`main.mjs` picks between the two; the platform is read once, at start-up).

| Option in `createWindow()` | Windows | macOS | Why |
|---|---|---|---|
| `frame` | `false` | `true` | Windows: no caption bar. macOS: a frameless window has no traffic lights and no native drag region, so the frame stays |
| `titleBarStyle` | `"hidden"` | `"hiddenInset"` | Windows: keeps the window-manager behaviour of a hidden title bar. macOS: hidden title bar **with** inset traffic lights, which is the "big content, still a real window" look |
| `titleBarOverlay` | `false` | not passed | no Electron-drawn min/max/close on top of the page |
| `thickFrame` | `true` | not passed | `frame: false` otherwise loses the resize border, the Windows 11 rounded corners and the drop shadow; it is a Windows-only flag |
| `roundedCorners` | `true`, **Windows 11 only** | not passed | rounded corners are the OS's; on Windows 10 the option has no effect, so it is only passed on build ≥ 22000 — a no-op flag is not sent |
| `icon` | `packaging\assets\rosalena.ico` | **not passed** | Windows takes the taskbar icon from the window in development. On macOS the Dock/Finder icon comes from the bundle's `.icns`, and passing a 256 px `.ico` would be wrong (see *The icon*) |
| `backgroundColor` | `#070c13` | `#070c13` | the exact `--bg` of `styles.css`, so the first paint is not a white flash |
| `minWidth` / `minHeight` | `720` / `480` | `720` / `480` | below that the composer and the header cannot lay out; size and position are remembered, and a remembered height under 480 is raised to it |
| size / position | `1280×860`, then remembered | `1280×860`, then remembered | `restoreBounds()` keeps the last geometry, and drops a position that no longer lands on a display |
| `show` | `false` | `false` | revealed on `ready-to-show`, never a blank frame |
| `autoHideMenuBar` | `true` | `false` | Windows: the menu is still there, **Alt** shows it. macOS: a menu bar cannot be hidden, and the app menu is the only place Quit lives |

**The in-page buttons are hidden on macOS.** The page's `header.chrome` strip carries
minimise/maximise/close buttons (`html.is-desktop` only), and on a Mac those would sit in
the middle of the traffic lights. The two rules are permanent rules in
`harness/ui/styles.css` — the shell injects nothing, so they also survive a reload:

```css
html[data-platform="darwin"] .win-controls { display: none; }
html[data-platform="darwin"] .chrome { padding-left: 88px; }
```

`app.js` already sets `document.documentElement.dataset.platform = desktop.platform`, so no
renderer code was needed for the match; the strip stays draggable and the traffic lights get
their room. Windows renders exactly what it rendered before — no rule matches without the
`darwin` attribute.

**The material is a finish, not a layout feature.** `windowAppearance()` requests
`backgroundMaterial: "mica"` on Windows build ≥ 22621 and `"acrylic"` on ≥ 22000, and
nothing older. **Measured on this machine: Windows 10.0.19045**, so the function returns
`{}` and the window paints the solid palette colour — the mica and acrylic branches are
reviewed and syntax-checked, not exercised here. The page paints an opaque palette in
every state, so a material would only show at the window edge and through the rounded
corners; no rule in `styles.css` depends on it.

The strip itself is `header.chrome` in `index.html`, marked `-webkit-app-region: drag`
with `no-drag` on its buttons; `app.js` adds `html.is-desktop` only when
`window.rosalenaDesktop` exists, so a browser tab shows the in-page header and no strip.

## The menu

`desktop\menu.mjs` builds the template; `main.mjs` installs it with
`Menu.setApplicationMenu`. It is a function of the platform, not a chain of `if`s in the
window code, so the template can be (and is) checked with plain `node`.

| Menu | Windows | macOS |
|---|---|---|
| *application* | — | `Rosalena Harness`: About, Services, Hide / Hide Others / Show All, **Quit Rosalena Harness (Cmd+Q)** |
| File | Open folder… (`Ctrl+O`), Open in browser, Exit (`Ctrl+Q`) | Open folder… (`Cmd+O`), Open in browser, Close Window (`Cmd+W`) — the app stays alive with no window |
| Edit | undo, redo, cut, copy, paste, select-all | the same plus `pasteAndMatchStyle` and `delete`, which are the macOS spellings |
| View | reload, force reload, devtools, zoom in/out/reset, fullscreen | identical |
| Window | — | minimise (`Cmd+M`), zoom, bring all to front |
| Help | Rosalena on disk, About | Rosalena on disk |

The clipboard roles are the point: without an Edit menu, `Cmd+C`/`Cmd+V` work only because
Chromium handles them itself, and the menu bar shows no standard items — on macOS that reads
as a broken app. Windows keeps the same menu it had (auto-hidden; **Alt** reveals it).

## The icon

The window carries the same mark as the `.exe`: a navy tile (`#070c13`, transparent
corners) holding a geometric capital **R** — cyan stem and bowl, platinum leg, all three
colours lifted from the page's own palette. At 16 and 24 px the leg is drawn cyan as well
and the glyph is nudged 7% larger, because at that size a two-tone leg costs a pixel of gap
and reads as two marks.

- **Source of truth:** `packaging\tools\make-icon.mjs`. No dependencies — the rasteriser,
  the PNG writer (`node:zlib`), the ICO container and the ICNS container are all in that one
  file — and it emits 16, 24, 32, 48, 64, 128 and 256 px for Windows, plus 16, 32, 64, 128,
  256, 512 and 1024 px for the macOS `.icns`. Up to 64 px the `.ico` entries are 32-bit BMP
  (what every shell path and icon loader understands); 128 and 256 are PNG, which is what
  Windows 10 wants for large icons and keeps the file at ~38 KB instead of ~350 KB. Both
  files are build artifacts: regenerate them, never hand-edit them.
- **macOS:** `packaging\assets\rosalena.icns`, 28 392 bytes, an `icns` container holding
  PNG entries `icp4` 16, `ic11` 32, `ic12` 64, `ic07` 128, `ic08` 256, `ic09` 512 and
  `ic10` 1024 — the retina variants (32/64) included, because a Mac without them scales a
  non-retina entry. Apple requires 512 and 1024, which is why the rasteriser gained those
  sizes; nothing in the file records a timestamp, so two runs produce identical bytes.
  `stage.mjs` copies it to `<app>/build/icon.icns` and `electron-builder.mac.yml` names that
  path, which is what `directories.buildResources: build` resolves against.
- **Used twice:** embedded in `Rosalena-Harness.exe` with `/win32icon` (see
  `desktop\build.md`), and handed to this window by `icon:` in `createWindow()`. On macOS
  the bundle's `.icns` is the Dock and Finder icon, so `windowIcon()` returns `null` there
  instead of offering a 256 px `.ico`.
- **Why the window needs its own copy:** in development the executable is `electron.exe`,
  and Windows takes the taskbar icon from the executable unless the window supplies one.
  `app.setAppUserModelId("Rosalena.Harness")` keeps the window grouped under its own
  identity rather than under Electron's.

| Regenerate | Verify | Preview |
|---|---|---|
| `node packaging\tools\make-icon.mjs` (writes both `.ico` and `.icns`) | `node packaging\tools\make-icon.mjs --check` (parses both back) | `node packaging\tools\make-icon.mjs --preview icon.png` |

`--check` parses the files back: the ICO directory, each entry's reported size, the PNG chunk
CRCs, the BMP pixels, and that the tile, stem and leg colours are where the geometry says
they should be. It exits non-zero on the first mismatch.

The window resolves its copy in this order: `..\packaging\assets\rosalena.ico` (this
source tree), `desktop\assets\rosalena.ico`, then `..\assets\rosalena.ico`. A missing file
is one line on stderr and Electron's own icon, not a crash.

## The bridge: eight names, nothing else

`preload.mjs` exposes exactly one object over `contextBridge`:

```js
window.rosalenaDesktop = {
  platform,        // "win32" — used for data-platform, not a security boundary
  minimise, maximise, close,
  isMaximised,     // → boolean
  getResizable, setResizable,   // → boolean
  onMaximised,     // (cb) => unsubscribe
}
```

That is the whole surface between the renderer and the shell: no `require`, no
`process`, no filesystem, no channel that takes a path. Every one of those calls is a
`ipcMain.handle` that resolves for the *calling* window only
(`BrowserWindow.fromWebContents(event.sender)`), so a second window could not be driven
by the first. `maximise` refuses while the window is not resizable, and `setResizable`
un-maximises first so a locked window can never be stuck at full size.

`contextIsolation: true`, `nodeIntegration: false` and `sandbox: true` are all kept: the
preload is deliberately CommonJS because a sandboxed preload runs as CommonJS, and an ESM
preload would mean turning the sandbox off for three window buttons.

**In a browser there is no preload**, `window.rosalenaDesktop` is `undefined`, the strip
is not rendered and every call site no-ops — so the same four files load in a tab with no
errors.

## Settings: the numbers are real

`#settings` opens one popover with two controls, both of which do something measurable.

- **Render rate — 60 / 30 / 15 updates per second.** Streaming deltas are buffered and
  painted at most once per frame budget (`1000 / rate - 0.5` ms) through
  `requestAnimationFrame`; the choice is stored in `localStorage`. Beside it sits a
  counter of **updates applied vs deltas received**, so the setting can be judged instead
  of trusted. Measured with 5,000 synthetic deltas: **60/s → 1,646 paints (181.8
  deltas/s), 15/s → 391 paints (191.9 deltas/s), 76.2 % fewer DOM writes**. In a live
  stream: **57 paints for 57 deltas over 18.34 s** at 60/s, **55 paints for 40 deltas
  over 12.21 s** at 15/s.
- **Resizable window.** Calls the real `setResizable` through the bridge and reports
  `getResizable()` back. In a browser the row renders `Desktop app only` and the switch is
  inert.

## The layout is the user's

Five panels — `nav`, `sessions`, `document`, `inspector`, `jobs` — in three docks (left,
right, bottom). Everything about their arrangement is one versioned key,
`rosalena-layout-v1`:

```json
{ "v": 1, "preset": "cockpit", "tab": "graph",
  "docks":  { "left": {"size":292}, "right": {"size":322}, "bottom": {"size":58} },
  "panels": { "nav": {"dock":"left","order":0,"size":288,"closed":false,"collapsed":false}, … } }
```

- **Move** by dragging the panel's grip (⠿ in its head): a drop line shows where it will
  land, and it lands in any dock at that position. Panels never overlap and never leave
  the window — the ghost is clamped inside the viewport.
- **Resize** by dragging the splitters (between docks and between panels). They are real
  `role="separator"` elements: arrow keys resize by 16 px, `Home` or `Enter` restores the
  dock's preset size.
- **Collapse** with the ▭ button: the panel keeps a 30 px strip and its title, so a closed
  rail still says which panel it is. **Close** with ×; the View menu (`#view`, or the
  palette) lists every panel and brings it back.
- **Presets.** `Cockpit` (places above the chat list, wide inspector, recent-runs strip)
  and `Studio` (no rail, no runs strip, a wide file inspector). Any manual change marks
  the state `Custom`; the status strip says which one is in force.
- **Persistence is forgiving.** A missing or corrupt value falls back per field, not per
  key: an out-of-range or non-numeric size becomes the preset default via
  `pickSize()`/`sanitiseLayout()`, and the sanitised object is written back. Measured by
  writing garbage into the key (`"size":"wide"`, `"dock":"mars"`, `"closed":"no"`,
  `inspector: null`): the page came up in Cockpit, 0 px of overflow, and the key was
  re-stored in a valid shape.
- **A narrower document is normal.** Both docks open leaves the centre panel ~664 px at
  1280. Nothing is allowed to overflow: at 1280 / 1024 / 1000×620 the document measured
  664 / 408 / 384 px with 0 px of page overflow, the transcript keeps its own height
  (tool cards 32 px, never squashed) and scrolls, and below 560 px the header drops its
  model select (the composer keeps one) and the composer puts the prompt on its own line
  so it is never squeezed to 26 px.
- **The status strip reports only what it fetched**: `router up · N models`,
  `graph N running · N total · N failed`, `N tok today · N calls`, `paints · Hz`, `exits
  Outline + ExpressVPN`, `RTX 3090 · 7.6 of 24 GiB free`, all from `/api/health`,
  `/api/graph`, `/api/usage?days=1`, `/api/exits`, `/api/recommend` and two `/api/usage`
  samples for `tok/s`, labelled as an average.

`panels.js` in `harness\ui\` is optional: the inspector imports it, and if the module is
absent the panel says so in one sentence and **every other part of the page keeps
working**. The contract is `panels.graph.mount(el, api)` / `panels.files.mount(el, api)`
with `api = { fetchJson(path), openSession(id), toast(text, kind) }`, returning
`{ refresh(), destroy() }`, plus `panels.*.label`.

## Where things live

| | Path |
|---|---|
| Data folder (`home`): runs, attachments, `memory.jsonl`, the process ledger, the MCP registry, the proxy pool | `%APPDATA%\Rosalena Harness\data` with `npm start`; `<product>\data`, i.e. `D:\AppDev\Rosalena Harness\data`, when the launcher starts the window (`ROSALENA_HOME` wins if you set it) |
| Remembered workspace + window geometry | `%APPDATA%\Rosalena Harness\desktop-state.json` |
| Default workspace, if you never picked one | `%APPDATA%\Rosalena Harness\workspace` (created on first run) |
| The app's log | `npm start`: the terminal you ran it in, and failures appear in a dialog. Launched from `Rosalena-Harness.exe`: `<data>\logs\launcher.log` (rotated to `launcher.log.1` at 2 MB) — the launcher and the window both write there |
| The engine's source | `..\harness\` — read-only from here: nothing in this folder writes to it |
| The router, when this window started it | its ledger, token-usage log, request logs and key file live under `<userData>\router\` — `%APPDATA%\Rosalena Harness\router\{state,logs,data}` on Windows, `~/Library/Application Support/Rosalena Harness/router/` on macOS. The supervisor passes that root as `ROSALENA_ROUTER_STATE_DIR`; the router itself still *reads* its config and the identity prompt from wherever it was installed, which is read-only |
| The router, when it was already running | untouched: the window uses `ROUTER_URL` (default `http://127.0.0.1:8077/v1`) and starts nothing, so the running router keeps writing wherever it was started |

`Help → Rosalena on disk` opens the data folder. The workspace the agent will actually
work in is shown in the page's own composer footer, bottom right.

## The folder picker, and the one route that does not exist

`File → Open folder…` opens the native directory chooser and changes the root the agent
works in. It cannot be a `POST`: `createUiServer()` takes `workspace` as a construction
option and has no route that changes it, so the shell **restarts the server in-process**
with the new root (`switchWorkspace()`): a second server on a new random port with a new
token, the window pointed at it, then the old one closed (`closeAllConnections()` first —
an open `/api/stream` response would otherwise hold `close()` forever).

Two consequences, stated rather than hidden: **the page reloads**, so the transcript on
screen clears (past chats are in the sidebar — they live in the run store); and **a run
that was already going is not killed** — it finishes on the old root and appears in the
sidebar when it settles.

## The browser version is unchanged

```powershell
cd "D:\AppDev\Rosalena Harness\harness"
$env:ROSALENA_HOME = "D:\AppDev\Rosalena Harness\data"
node src\cli.mjs --ui 8090      # http://127.0.0.1:8090/
```

Same `createUiServer()`, same four files, same token rule. `File → Open in browser` hands
the app's own URL to your default browser, so one session can be viewed in both at once.

## Verification that was actually performed

Run on this machine, not inferred:

- `node --check main.mjs` and `node --check preload.mjs` — both exit 0.
- The page was driven in a real browser engine at 1280×860, 1024×720, 1000×620 and
  900×620: 0 px of page overflow at every size, 0 console exceptions, and the layout
  measurements quoted above (`664 / 408 / 384 px` document widths, tool cards 32 px).
- Splitter drag: left dock 292 → 340 wanted (339 drawn, the dock draws inside 1 px
  borders), `preset: "custom"`, `stored: 340`, and after a reload `{wanted: 340, drawn:
  339}` — the *wanted* size is what persists, never the fitted one.
- Drag-and-drop of a panel: the inspector from the right dock into the left dock between
  two others previewed one drop line in the left dock, and landed at order 1 with the
  other two renumbered.
- Corrupt `rosalena-layout-v1` → Cockpit, 0 px overflow, key re-stored in valid shape.
- Close/reopen through the menu: `data-close="inspector"` → `{closed: true, hidden: true}`;
  the View menu row `Show the inspector panel` → `{closed: false, visible, 321×777}`.
- Folders: `POST /api/folders` 200, two `POST /api/folders/move` 200, `DELETE` 200, and
  the store returned to one `Ungrouped` group afterwards.
- The window itself was opened with Electron 44.9.1 in an earlier run of this build: a
  real frameless window titled `Rosalena Harness` rendered the page (`docs\ui\
  window-frameless.png` is that window), `getResizable()` reported `false` after the
  switch was locked and `maximise` refused in that state, and closing it the way a user
  does released the port and left no Electron process behind.
- The bridge surface was read off `preload.mjs` and the eight `ipcMain.handle` registrations
  in `main.mjs`: they match name for name and there is no ninth.
- **The launcher, measured, not assumed.** `packaging\build-exe.ps1` rebuilt it (60,928
  bytes) and then read the artifact back: PE subsystem field = `2` (Windows GUI), and the
  256 px icon image found inside the exe at byte 56848. `[System.Drawing.Icon]
  ::ExtractAssociatedIcon()` on the exe returned a 32×32 icon whose pixels count 826 navy,
  94 cyan and 19 platinum — the mark's own palette, not a generic placeholder.
- **No console window, measured from a console-less parent** (a GUI-subsystem helper that
  strips its own stdio, so a black window would have nowhere to hide): one launch produced
  exactly one new visible window (`Chrome_WidgetWin_1`, `Rosalena Harness`), **zero**
  `ConsoleWindowClass` windows on the whole desktop, zero `conhost.exe` children of the
  launcher, a launcher with `MainWindowHandle = 0` (it owns no window of its own), and the
  tree `launcher → electron.exe`; the log said `console  none (GUI subsystem: no console
  window exists, nothing to flash)` and the window logged `[rosalena] icon …\rosalena.ico`.
  A plain `taskkill` (a `WM_CLOSE`, no `/F`) closed the window, after which the launcher
  logged `exit 0` and both processes were gone.
- **The CLI path, measured the same way**: launcher → `node.exe … harness\src\cli.mjs --ui
  8124`, `GET http://127.0.0.1:8124/` returned `200` with 32,663 bytes, and again **zero**
  new visible windows.
- **A terminal still works**: `Rosalena-Harness.exe --launcher-info` typed in a terminal
  attached to it and its report was read back out of the console's screen buffer (rows 1–17,
  including `console  attached to the terminal this was started from`); `--log` printed the
  log's path, size and last 40 lines and exited without pausing; `--console --launcher-info`
  launched from a console-less parent created exactly one `ConsoleWindowClass` window, one
  `conhost.exe` child, and was still alive a second later waiting for Enter; `--log` from the
  same console-less parent produced one `#32770` dialog titled `Rosalena Harness launcher log`
  and logged `console  none (GUI subsystem: no console window exists, nothing to flash)`.
- **The log rotates**: grown to 2,249,476 bytes by hand, the next launch moved it to
  `launcher.log.1` and left an 859-byte `launcher.log`.
- **The failure dialog appeared** for a broken install launched with no console: one
  `#32770` window titled `Rosalena Harness`, exit code `2`, and the logged block matched the
  dialog's text. With `--no-dialog` the same launch exited on its own and produced no
  window at all.
- `cd harness; node --import ./test/isolate.mjs --test` — **808 tests, 808 pass, 0 fail**
  (the harness suite has grown since the 693 this task was briefed with; the last 45 came
  with the update/reveal work and the voice-platform test added alongside this document).
- **The packaged router actually starts.** `node packaging\release\check-router-spawn.mjs`
  staged the payload, called the same `ensureRouter()` `main.mjs` calls — with
  `isPackaged: true` and `resourcesPath` pointing at `build\release\app` — and got
  `source: "spawned"`, a port the OS chose (`:60562`), `GET /v1/models` answering with 12
  models, `stopRouter()` leaving the port dead afterwards. With a router already on 8077 it
  returned `source: "already-running"` and started nothing. The router's own startup banner
  (captured from a second, directly-spawned instance) showed `ledger`/`usage`/`logs` under
  the scratch state directory and the identity prompt under
  `build\release\app\data\prompts\rosalena.md`. 17 checks, 0 failures.
- **The menu template is valid for both platforms**: 15 assertions over the real template
  (app menu and its roles on darwin, Edit clipboard roles, View roles, Window roles, no
  duplicated About, File/quit on win32, no macOS-only role on win32, every item a valid
  Electron item with a known role) — and then, because a valid-looking template is not a
  menu, Electron 44.9.1 itself built it: `Menu.buildFromTemplate()` on the darwin template
  produced **6 menus [Rosalena Harness | File | Edit | View | Window | Help] with 24 roles**,
  and on the win32 template **4 menus [File | Edit | View | Help] with 14 roles**, both
  accepted by `Menu.setApplicationMenu()`. That was run with no window, from a script whose
  only job was the menu.
- **One Electron/ESM trap was hit and is worth knowing**: an `.mjs` main entry cannot
  `await app.whenReady()` at module scope — Electron fires `ready` only after the entry
  module finishes evaluating, so the first version of that smoke script deadlocked for 25 s
  and exited on its own guard. `main.mjs` has no top-level await (checked, `^await` matches
  nothing), which is exactly why it starts; anything added to it must keep it that way.
- **Both icon containers parse**: `node packaging\tools\make-icon.mjs --check` reads back
  the `.ico` (unchanged, 38 765 bytes) and the new `.icns` (28 392 bytes, seven PNG entries
  16→1024 px), and regenerating the `.icns` produces identical bytes.
- `node --check` on every file touched here: `main.mjs`, `menu.mjs`,
  `router-supervisor.mjs`, `router\src\config.mjs`.

Not verified here:

- The **mica and acrylic** branches: this machine reports Windows 10.0.19045, so
  `windowAppearance()` returns `{}` and only the solid-colour path runs. The same build
  gates `roundedCorners` on build ≥ 22000, so on this machine the window is a plain square
  frame — the Windows 11 corner rounding is passed through, never faked.
- The **missing-Node dialog**: this machine has `node.exe` in `PATH`, so the launcher always
  finds it. The dialog machinery itself was exercised through the broken-install path
  (above), which is the same `Fail()` code; the specific "no Node" wording is reviewed, not
  seen.
- The **native Open folder…** dialog was never clicked (driving a native dialog needs
  desktop automation this run did not have); the restart path is reviewed and
  syntax-checked, not click-tested.
- The **Resizable** switch was verified through the API (`getResizable()` false, maximise
  refused), not by dragging a window edge.
- **Everything macOS.** No Mac ran this code. Unverified: `titleBarStyle: "hiddenInset"`
  actually placing the traffic lights inside the page's chrome, the `88 px` inset being the
  right number at every window size, the app menu and `Cmd+Q`/`Cmd+W`/`Cmd+M` behaving,
  Edit-menu paste into the composer, `activate` reopening the window, the Dock name and icon
  from the bundle, and — the one with real risk — whether a `spawn(process.execPath)` child
  is allowed to run inside a signed, quarantined, possibly translocated `.app`. That last one
  is the first thing to check when a macOS runner finally builds this.
- **The router-failure dialog** (`announceRouterProblem`) was never shown: the router starts
  correctly on this machine, so the timeout path is reviewed and syntax-checked only. What
  *is* verified is the supervisor's own failure return (`unreachable` for a dead explicit
  address, with an error naming the log directory).
- **Voice on macOS.** The absence is enforced in code and tested
  (`detectBackends({ platform: "darwin" })` reports every backend unavailable, `pickBackend`
  refuses), but no microphone was ever opened on a Mac — nothing there can open one.

## Known limitations

- **The single-instance lock lives in the window, not in the launcher.** `main.mjs` takes
  `app.requestSingleInstanceLock()`; a second launch finds the running window and focuses it,
  which also means a second double-click cannot start a second router. The launcher wrapper
  is a separate process that spawns this one: it has no lock of its own, so a second
  launcher starts, spawns Electron, and sees Electron exit immediately (exit 0) because the
  lock was refused. No duplicate window, one wasted process for a moment.
- **A force-killed launcher leaves its child running.** Measured: `taskkill /F` on the
  launcher's PID terminated only the launcher; `node.exe` kept serving until it was killed
  by PID. A normal window close is fine (the child exits, then the launcher), and Ctrl+C in a
  terminal is handled, but `TerminateProcess` cannot be intercepted by anything.
- **The CLI child still owns a (hidden) console.** `CREATE_NO_WINDOW` gives `node.exe` a
  hidden `conhost.exe`, not none at all: `tasklist` shows one, it has zero visible windows,
  and a `.cmd` shim the harness spawns could in principle still create its own window. Setting
  `windowsHide: true` on those future spawns is the belt to this braces.
- **Log rotation is skipped when another instance holds the file.** Rotation renames
  `launcher.log` at start, and a second instance's open handle makes the rename fail; the
  failure is swallowed and the log grows past 2 MB until the next start with no other
  writer. One launcher at a time (the previous point) makes this theoretical.
- **`panels.js` is not in this tree.** The inspector imports it, so it currently shows
  its one-sentence fallback (`Failed to fetch dynamically imported module:
  http://127.0.0.1:<port>/panels.js`) and the two inspector tabs are empty. Everything
  else works; the panel is written and guarded, not invented.
- **The document panel is the centre panel and does not dock.** It can be closed and
  brought back from the View menu, but a layout with no document would have nowhere to
  type, so it is not offered as a draggable panel.
- **`nav` has no in-head collapse button** — the View menu and the palette close it. The
  other four panels have one.
- **The sidebar footer is pinned**, because the VPN switches must stay reachable: in
  Cockpit at 1280×860 the chat list gets 186 px (about two rows plus a folder head) and
  scrolls; in Studio (836 px tall) it gets 534 px. Resizing the dock or using Studio
  gives it more room.
- **The material is not visible** on this machine (see above), and even on Windows 11 the
  page paints opaque palette colours, so mica/acrylic would only appear at the window
  edge.
