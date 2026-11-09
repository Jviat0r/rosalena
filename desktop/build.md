# Building a distributable Rosalena Harness desktop app (Windows `.exe`, macOS `.dmg`)

Written after actually assembling and running a build on Windows (details and measured
numbers below). The honest summary first: **there is a working portable Windows build
recipe that I ran, and there is a full installer pipeline in `packaging\release\` — NSIS +
portable for Windows, `.dmg` + `.zip` for macOS, arm64 and x64 — that has never run, because
it needs `electron-builder` installed and, for macOS, a Mac.** Nothing in this file is a
report of a macOS build.

Two artifacts exist in this product, and they are not alternatives:

| Artifact | What it is | Needs Node installed? | Can show the window? |
|---|---|---|---|
| `bin\Rosalena-Harness.exe` (the root has shortcuts since 2026-11-04) | a ~61 KB .NET Framework **launcher**, compiled by `packaging\build-exe.ps1` as a GUI-subsystem binary with the product's icon embedded | only in its CLI mode | **yes** — a double-click starts the Electron runtime it discovers in `desktop\` |
| the Electron build described here | Electron's runtime + this app's payload (368 MB folder) | no | yes |

A Node **SEA** binary (single-executable application) is the *planned* replacement for
the first row, not for the second — see the last section.

## What a build has to contain (measured, not estimated)

The window imports `../harness/src/ui.mjs` and that server reads `../harness/ui/*`, so
the payload is:

```
<app root>\
  desktop\main.mjs
  desktop\preload.mjs
  desktop\menu.mjs                the application menu, per platform
  desktop\router-supervisor.mjs   starts the router, waits for it, stops it on quit
  desktop\assets\rosalena.ico     the window's icon (the .exe carries its own copy)
  harness\src\*.mjs            16 files, the engine (ui.mjs, agent.mjs, tools.mjs, ...)
  harness\ui\*                  4 files, the page (index.html, app.js, format.mjs, styles.css)
  package.json                  { "main": "desktop/main.mjs" }
```

**Measured: 23 files, 0.38 MB of app payload**, on a 368 MB Electron runtime. The icon in
that listing was added after that count was taken: with it the payload is 24 files and
0.42 MB (38,765 more bytes), and without it the window silently falls back to Electron's
icon. `menu.mjs` and `router-supervisor.mjs` are two more small files on top of that; the
authoritative list, with sizes, is whatever `node packaging\release\stage.mjs --check`
prints (117 files, 1,861,072 bytes for the full payload including the trees below).

Not needed by the **window** path, proven rather than assumed — the payload below ran with
none of them present:

- `harness\plugins`, `harness\store`, `harness\harness.config.json` — the UI path never
  loads the plugin host (only `cli.mjs` calls `loadPlugins`), so the window starts and
  serves the page without them;
- `harness\src\voice\.venv` — 242.7 MB of the 243 MB `harness\src` folder is the Python
  whisper environment. It is only reachable through `--voice` on the CLI, and the page
  never touches it;
- `data\`, `docs\`, the probes, the test suite.

**What a *product* build needs that the bare payload does not:**

| Tree | Why | Where it goes |
|---|---|---|
| `router\` (9 `.mjs`, `router.config.json`, `package.json`) | `desktop\router-supervisor.mjs` starts `<resources>\router\src\index.mjs` unless a router is already running | `extraResources` → `<resources>\router` |
| `data\prompts\rosalena.md` | `router.config.json` names `../data/prompts/rosalena.md`; `router\src\persona.mjs` exits 2 if it is missing | `extraResources` → `<resources>\data\prompts\rosalena.md` |
| `build\icon.icns` (macOS) | the Dock/Finder icon; a Mac build ignores the `.ico` | `<app>\build\icon.icns`, named by `mac.icon` in the electron-builder config |

`packaging\release\stage.mjs` assembles exactly that, and
`node packaging\release\check-router-spawn.mjs` proves the router starts out of the
assembled folder. A hand-made Path A copy needs the two `extraResources` trees added by hand
to `resources\router` and `resources\data\prompts`; without them the window still opens and
says — in a dialog, not a blank page — that the router is missing and where the log lives.

### The one layout rule that breaks a naive build

`desktop\main.mjs` imports `../harness/src/ui.mjs`. In a packaged app the main file
lives in `resources\app\`, so the archive must reproduce the sibling layout:

```
resources\app\desktop\main.mjs      ✔  ../harness/src/ui.mjs -> resources\app\harness\src\ui.mjs
resources\app\harness\src\ui.mjs
```

Putting `main.mjs` at the app root instead (`resources\app\main.mjs`) sends
`../harness` to `resources\harness`, outside the archive, and the app dies at startup
with `ERR_MODULE_NOT_FOUND`. That is why the packaged `package.json` says
`"main": "desktop/main.mjs"` rather than `"main": "main.mjs"`, which is what the
development `desktop\package.json` uses.

## Path A — portable folder build, no extra tool (this is the one I ran)

Electron's own `dist` folder is a complete, relocatable runtime; naming its executable
differently and dropping an app into `resources\app` is exactly what the packagers
themselves do. From a clean `desktop\`:

```powershell
$product = "D:\AppDev\Rosalena Harness"
$out     = "$product\desktop\dist\win-unpacked"

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory $out | Out-Null
Copy-Item "$product\desktop\node_modules\electron\dist\*" $out -Recurse -Force
Rename-Item "$out\electron.exe" "Rosalena Harness.exe"

$app = "$out\resources\app"
New-Item -ItemType Directory "$app\desktop","$app\desktop\assets","$app\harness\src","$app\harness\ui" -Force | Out-Null
Copy-Item "$product\desktop\main.mjs","$product\desktop\preload.mjs" "$app\desktop" -Force
Copy-Item "$product\packaging\assets\rosalena.ico" "$app\desktop\assets" -Force
Copy-Item "$product\harness\src\*.mjs" "$app\harness\src" -Force
Copy-Item "$product\harness\ui\*"      "$app\harness\ui"  -Force

@'
{
  "name": "rosalena-desktop",
  "productName": "Rosalena Harness",
  "version": "0.1.0",
  "main": "desktop/main.mjs"
}
'@ | Set-Content "$app\package.json" -Encoding UTF8

& "$out\Rosalena Harness.exe"
```

The `desktop\assets\rosalena.ico` copy is the one line a naive build gets wrong. The
window resolves its icon at run time, and its first candidate is
`..\packaging\assets\rosalena.ico` — which exists in the source tree but **not** inside
`resources\app`, where only `desktop\` and `harness\` were copied. Without the copy the
window falls back to Electron's own icon and prints one line to the log; with it, the
taskbar, Alt+Tab and the window's system menu carry the product's mark. The `.exe`'s own
icon is separate and already embedded (see the launcher section below).

**What I observed when I ran this** (Windows 11, Electron 44.9.1):

- output: **368 MB**, of which the app payload is 0.38 MB / 23 files (**0.42 MB / 24 files**
  with the window's icon copied in);
- `Rosalena Harness.exe` started and a window titled `Rosalena Harness` appeared;
- its stdout printed `[rosalena] window http://127.0.0.1:61251/?t=…`;
- `GET /` from another process returned **200** with the token substituted, and
  `/api/health` returned `ok=true`, the expected workspace, and `router up`;
- closing the window exited the process and left no stray `Rosalena Harness` process.

Properties of this output: it is a **folder**, not an installer; the app is plain files
in `resources\app` (no `app.asar`), so anyone can read or edit it — convenient for
development, not for shipping; the folder must be distributed whole (the `.exe` needs
its sibling DLLs, `locales\`, `resources\`); and it is **unsigned** (below).

I deleted the `dist\` folder after verifying it, to keep `desktop\` light. The recipe
above rebuilds it in well under a minute and needs no network.

## Path B — electron-builder, when a real installer is wanted

Not run here, and deliberately not added to `package.json`: the requirement for this
deliverable is "Electron as the only dependency", and `electron-builder` is a second
one (plus its own download). The steps are exact:

```powershell
cd "D:\AppDev\Rosalena Harness\desktop"
npm install --save-dev electron-builder
npx electron-builder --win --dir      # -> dist\win-unpacked\Rosalena Harness.exe
npx electron-builder --win nsis       # -> dist\Rosalena Harness Setup <version>.exe
```

with `desktop\electron-builder.yml`:

```yaml
appId: com.rosalena.harness
productName: Rosalena Harness
directories:
  output: dist
files:
  - from: .
    to: desktop
    filter:
      - main.mjs
      - preload.mjs
      - package.json
  - from: ../harness/src
    to: harness/src
    filter:
      - "*.mjs"
  - from: ../harness/ui
    to: harness/ui
    filter:
      - "*"
  - from: ../packaging/assets
    to: desktop/assets
    filter:
      - rosalena.ico
extraMetadata:
  main: desktop/main.mjs
asar: true
win:
  icon: build/icon.ico
  target:
    - target: nsis
      arch: [x64]
```

with the icon copied once before building, because `electron-builder` only takes the
`.exe`'s icon from a file inside the project folder:

```powershell
New-Item -ItemType Directory "D:\AppDev\Rosalena Harness\desktop\build" -Force | Out-Null
Copy-Item "D:\AppDev\Rosalena Harness\packaging\assets\rosalena.ico" "D:\AppDev\Rosalena Harness\desktop\build\icon.ico" -Force
```

Why each unusual line is there:

- `from: ../harness/src` / `../harness/ui` — the engine is outside the `desktop\`
  project folder, so it has to be pulled in explicitly. `filter: "*.mjs"` is what keeps
  the 242.7 MB voice venv out of the archive.
- `from: ../packaging/assets` → `desktop/assets` — same reason for the window's icon: it
  is outside the project folder, and `main.mjs` looks for it beside itself.
- `win.icon: build/icon.ico` — the `.exe`'s own icon. `electron-builder` reads only from
  inside the project folder, which is why the file is copied to `desktop\build\` first;
  without it there is a warning and the runtime ships with Electron's atom.
- `to: desktop` + `extraMetadata.main: desktop/main.mjs` — the layout rule above. The
  development `package.json` keeps `main: "main.mjs"` for `npm start`; the packaged one
  is rewritten by `extraMetadata` so the same file works in both places.
- `asar: true` is safe for this app: everything under `harness\ui` is *read* by
  `ui.mjs` with `fs.readFile`, which Electron's asar layer serves transparently, and
  nothing is spawned from the archive. No `asarUnpack` is required.
- `from: .` with a filter is used instead of a bare file list so the mapping survives
  electron-builder's path normalisation; a bare list would pack `main.mjs` at the app
  root and hit the `ERR_MODULE_NOT_FOUND` above.

One thing to expect the first time: `electron-builder` will warn that `package.json` has
no `author` (add one, or accept the warning). With the two icon lines above there is no
missing-icon warning; without them the app ships with Electron's default icon.

If the Electron version is later bumped, `electron-builder` needs a matching version
(it downloads its own Electron copy for the build, so `--dir` needs network the first
time even though `node_modules\electron\dist` is already on disk).

## What runs beside the window in a packaged build

`packaging\release\` is now the real answer to Path B: two electron-builder configs sharing
one staged payload, plus the verification scripts. What matters for anyone building by hand
is that the window is no longer alone in its process tree.

**Start-up order** (`desktop\main.mjs` → `desktop\router-supervisor.mjs`):

1. Resolve the router: packaged `join(process.resourcesPath, "router")`, otherwise
   `resolve(desktop, "..", "router")`. It counts as present only when both
   `src\index.mjs` and `router.config.json` are there.
2. Probe `ROUTER_URL` (or `ROSALENA_ROUTER_URL`), default `http://127.0.0.1:8077/v1`. If it
   answers, **reuse it and start nothing** — that is the case where a developer has one
   going by hand against their own keys.
3. Otherwise start a child on a port the OS chooses (`findFreePort()`, listen on 0 then
   close — never assume 8077 is free):
   ```
   process.execPath <resources>\router\src\index.mjs --config <resources>\router\router.config.json --port <free>
   env: { ...process.env, ELECTRON_RUN_AS_NODE: "1",
          ROSALENA_ROUTER_STATE_DIR: <userData>\router, ROUTER_QUIET: "1" }
   cwd: <resources>\router, stdio: "ignore", windowsHide: true
   ```
   `process.execPath` is the packaged Electron binary, so a user needs no Node;
   `ELECTRON_RUN_AS_NODE=1` is what makes it behave as plain Node.
4. Poll `GET /v1/models` every 200 ms up to `ROSALENA_ROUTER_READY_MS` (default 20 s). On
   success the URL is handed to the engine (`ROUTER_URL` and `ROSALENA_ROUTER_URL` are set
   before `harness/src/ui.mjs` is imported) and to the page.
5. If it never answers, or the entry point is missing, or the process exits, the window
   still opens — and shows a dialog with the reason, the URL and the log directory, rather
   than a page whose every message fails. The window does not depend on the router to render.
6. `before-quit` stops a router **this app started** (SIGTERM, then SIGKILL after 2 s) and
   leaves alone one it merely found.

**Where the router writes.** `router.config.json` is explicit (`--config` is passed), and
`router\src\config.mjs` resolves `logDir`/`stateFile`/`usageFile`/`keyFile` relative to the
config file — which would be inside `Contents\Resources`, read-only in a quarantined `.app`.
`ROSALENA_ROUTER_STATE_DIR` moves all four under `<userData>\router\`
(`%APPDATA%\Rosalena Harness\router\` / `~/Library/Application Support/Rosalena Harness/router/`).
Read paths — the config itself and `systemPromptFile` — stay where they were installed.
That override is the only router change this needed; it is documented in `router\README.md`.

**macOS specifics in the build** (`windowChromeOptions()` and `menu.mjs`):

| | |
|---|---|
| Window | `frame: true` + `titleBarStyle: "hiddenInset"` — traffic lights, native drag and zoom. `thickFrame`/`titleBarOverlay`/`roundedCorners` are Windows-only and are not passed |
| Page chrome | `html[data-platform="darwin"] .win-controls { display: none; }` and `.chrome { padding-left: 88px; }`, injected with `insertCSS` on every `dom-ready`; no renderer file changed |
| Menu | app menu (About, Services, Hide, Quit `Cmd+Q`), File (`Cmd+O`, Close Window `Cmd+W`), Edit (clipboard roles, so `Cmd+C`/`Cmd+V` have menu items), View, Window (`Cmd+M`, zoom, front), Help |
| Lifecycle | `window-all-closed` does **not** quit on darwin; `activate` restores or re-creates the window. Windows behaviour is unchanged (`window-all-closed` quits) |
| Icon | bundle `.icns` from `packaging\assets\rosalena.icns` (16→1024 px, 28,392 bytes); `windowIcon()` returns `null` on darwin so a 256 px `.ico` is never offered to a Mac window |
| Second launch | `requestSingleInstanceLock()` + `second-instance` → the existing window is focused, so a double-click cannot start a second router |
| Voice | absent, not broken: `harness\src\voice.mjs` reports every backend unavailable off Windows with the reason, and the page has no microphone control |

Every one of those macOS rows is unverified at run time: see `packaging\release\README.md`
§5.1 and `desktop\README.md`'s "Not verified here".

## What is NOT done

- **No code signing.** The `.exe` is unsigned, so Windows SmartScreen will warn on
  first run and a certificate is required to stop that. Nothing here has a signing
  step, and `signtool` has not been wired into anything.
- **No auto-update.** `electron-updater` is not installed, there is no update feed, no
  release server and no version check. Updating means replacing the folder (Path A) or
  running a new installer (Path B).
- **No installer, no shortcuts, no uninstall entry.** Path A is a folder; Path B's
  NSIS target is configured but unbuilt.
- **No installer artwork beyond the icons that exist.** The product mark is a real `.ico`
  used by the launcher and the window (see below); there is no NSIS header bitmap, no
  banner and no per-machine vs per-user choice.
- **No ARM64 or 32-bit build.** x64 only, as configured above.
- **No crash reporting, telemetry or analytics** — none was added, and Electron's
  built-in crash reporter is not enabled. The app makes no network request except to
  `127.0.0.1` (the window's own server) and to the router it is configured with.
- **Not tested from a machine without Node.js.** The packaged app does not need Node
  (Electron carries its own, and the router now runs on it too), but that has not been
  proven on a clean box — and on macOS it is the single riskiest assumption, since a
  signed, quarantined `.app` may refuse to spawn its own executable by path.
- **No asar test.** Every run here used plain files; the `asar: true` claim above rests
  on how Electron resolves `fs.readFile` inside an archive, not on a run. The release
  configs use `asar: false` for the opposite reason: the router is started as a file by
  path, and a path inside an archive is not a file.
- **No macOS build has been produced or opened.** The config, the icon, the window options
  and the menu are written and the pieces are checked on Windows; traffic lights, the menu
  bar, Dock behaviour, Gatekeeper and Finder's acceptance of the `.icns` have not been seen.

## What the current `Rosalena-Harness.exe` is for

It is **a launcher, not a SEA binary**, and since the window exists it has two jobs:

- ~61 KB of C# compiled with the in-box .NET Framework compiler
  (`packaging\launcher\RosalenaHarness.cs`), built to `bin\Rosalena-Harness.exe`; the
  product root holds shortcuts to it and to the installed release
  (`packaging\make-shortcuts.ps1`). It is compiled **`/target:winexe`**, i.e. as a
  GUI-subsystem binary: Windows allocates **no console** for it, so a double-click shows
  the window and no black console window ever appears or flashes. Rebuild with:

  ```powershell
  powershell -ExecutionPolicy Bypass -File "D:\AppDev\Rosalena Harness\packaging\build-exe.ps1"
  ```

  The script verifies its own output rather than trusting the flags: it reads the PE
  subsystem field back (fails unless it is `2`, Windows GUI) and searches the built bytes
  for the 256 px icon image out of `packaging\assets\rosalena.ico` (fails if
  `/win32icon` did not embed it).
- **no arguments (a double-click): start the window.** It looks for an Electron runtime —
  `ROSALENA_ELECTRON`, then a packaged `desktop\dist\win-unpacked\Rosalena Harness.exe`,
  then Electron's `path.txt`, then `desktop\node_modules\electron\dist\electron.exe` — and
  runs it with `desktop\` as the app and `ROSALENA_HOME` set to `<product>\data` unless you
  set it. Closing the window exits the launcher with code `0`. If Electron is not
  installed it says so in a dialog (or on the terminal) and falls back to the terminal
  client **only when a terminal is attached**; `--desktop` asks for the window explicitly
  and exits `5` instead of falling back. This mode needs **no Node.js**.

  One environment variable is dropped for the window child: `ELECTRON_RUN_AS_NODE`. With
  it set, `electron.exe` runs as plain `node`, the `electron` module imports as an empty
  object and the process dies before a window exists. VS Code's integrated terminal is
  one of the shells that exports it, so a launch from there would otherwise fail with
  nothing on screen. `desktop\README.md` documents the same variable for `npm start`.
- **arguments: run the CLI**, exactly as before. Resolves the product root from its own
  location (a `harness` folder beside itself, `ROSALENA_HARNESS` overrides), finds
  `node.exe`, and forwards the child's exit code. Exit codes `2` (bad install), `3` (no
  Node), `4` (Node too old), `5` (window asked for, no usable Electron), plus the child's
  own;
- it still contains no browser engine and no Node, which is why it starts the window
  instead of being one.

### Where its output goes, and why there is no console window

A GUI-subsystem binary has no stdio, so the launcher writes three ways:

| Started | Output |
|---|---|
| from a terminal | it calls `AttachConsole(ATTACH_PARENT_PROCESS)`, rebinds `Console.Out`/`Error` to the terminal's handles and **mirrors every log line and every child line** into that window |
| from Explorer | nothing to attach to; everything goes to `<data>\logs\launcher.log` (`data\logs\` beside the product unless `ROSALENA_HOME` says otherwise) |
| with redirected stdio | the caller's handles are valid, so it mirrors into them as well as the log |

The log is append-only, bounded at ~4 MB: at 2 MB it is moved to `launcher.log.1` (the
previous one is deleted) on the next start. A read-only folder leaves the run unlogged
instead of failing it. Three launcher-only flags exist, and none of them reach the
harness:

| Flag | Effect |
|---|---|
| `--console` | allocate a console if none is attached, then mirror into it — and wait for Enter before closing it, on every path, because an allocated console dies with the process |
| `--log` | print the log's path, size and last 40 lines: to the attached terminal, to the caller's stdio, or as a dialog when there is neither (it never allocates a console, which would vanish before the first line was read) |
| `--no-dialog` | never show a MessageBox (`ROSALENA_LAUNCHER_NO_DIALOG=1` does the same) |

Failures (missing Node, missing engine, Node too old, no Electron) are a `MessageBox` when
there is no console to print to, and one logged block plus terminal lines when there is.
An allocated console waits for Enter; a terminal the launcher merely attached to is never
paused.

**Measured here, and this is why the numbers are trustworthy:** the built exe's PE
subsystem is `2`; the 256 px icon image is at byte 56848 of the exe; a launch from a
console-less parent process produced **exactly one** new visible window (class
`Chrome_WidgetWin_1`, title `Rosalena Harness`), **zero** `ConsoleWindowClass` windows
anywhere on the desktop, a launcher process with `MainWindowHandle = 0`, and a process
tree of launcher → `electron.exe` (→ its usual three helpers); `taskkill` (a plain
`WM_CLOSE`, no `/F`) closed the window, the launcher then logged `exit 0` and exited;
`Rosalena-Harness.exe --launcher-info` run from a terminal wrote its report into that
terminal's screen buffer (read back row by row); a log file grown to 2,249,476 bytes was
rotated to `launcher.log.1` on the next start, leaving a 859-byte `launcher.log`; a
console-less launch with no engine produced one `#32770` dialog titled
`Rosalena Harness`, exit code `2`, and a log block identical to the dialog's text; the same
launch with `--no-dialog` exited on its own with no window; `--log` with no console showed
its report in a `#32770` dialog titled `Rosalena Harness launcher log`; and
`--console --launcher-info` from a console-less parent created exactly one
`ConsoleWindowClass` window and stayed alive waiting for Enter.

## The icon

One mark, one generator, three consumers (the `.exe`, the window, the macOS bundle).

| | |
|---|---|
| Source | `packaging\tools\make-icon.mjs` — no dependencies: its own supersampled rasteriser, `node:zlib` for the PNG entries, the ICO and ICNS containers written by hand |
| Output (Windows) | `packaging\assets\rosalena.ico` (38,765 bytes; 16, 24, 32, 48, 64 BMP + 128, 256 PNG) |
| Output (macOS) | `packaging\assets\rosalena.icns` (28,392 bytes; PNG entries `icp4` 16, `ic11` 32, `ic12` 64, `ic07` 128, `ic08` 256, `ic09` 512, `ic10` 1024) |
| Design | navy `#070c13` rounded tile, geometric capital **R**: cyan `#5fe3f0` stem and bowl, platinum `#e9f1f9` leg. At ≤24 px the leg is cyan too and the glyph is 7% larger, because two tones at 16 px read as two marks |
| In the `.exe` | `/win32icon` in `packaging\build-exe.ps1`, verified by searching the built bytes for the 256 px image |
| In the window | `icon:` in `desktop\main.mjs`, resolved at run time from `..\packaging\assets\`, `desktop\assets\` or `..\assets\` — **not passed on macOS**, where the bundle's `.icns` is the icon |
| In the `.app` | `mac.icon: build/icon.icns` in `packaging\release\electron-builder.mac.yml`; `stage.mjs` copies the `.icns` to `<app>\build\icon.icns` |

Regenerate, check, preview:

```powershell
node packaging\tools\make-icon.mjs            # rewrites BOTH rosalena.ico and rosalena.icns
node packaging\tools\make-icon.mjs --check    # parses both back, exit non-zero on any mismatch
node packaging\tools\make-icon.mjs --preview icon.png
powershell -ExecutionPolicy Bypass -File packaging\build-exe.ps1   # embed the .ico in the .exe
```

`--check` is not a smoke test: it validates the ICO directory, every entry's declared size,
the PNG chunk CRCs, the BMP payloads, the alpha cut of the tile corners and that the tile,
stem and leg colours land where the geometry says they should — and, for the ICNS, the
container header, each chunk's type and length, every PNG's signature/CRC/IHDR size and the
inflated pixels. Both files are build artifacts and are committed so the C# build never
needs Node.

Neither container stores a timestamp, so regenerating an unchanged icon gives identical
bytes; the `.icns` was checked that way (same SHA-256 after two runs).

The **SEA** plan in `README.md` ("What the next stage needs") is the route to a
Node-free *CLI* `.exe`: bundle the ESM sources with esbuild, build a Node single
executable with `--experimental-sea-config` + `postject`, add a virtual file system for
plugins/`HARNESS.md`/the store/voice, and decide how the router travels. None of those
tools are installed yet. Even finished, a SEA binary would still have no Chromium, so it
would never replace the Electron window — it would remove the Node install from the
*CLI* side.

In short: **window → the Electron app in `desktop\` (double-click already works). CLI
without Node → SEA (future).** The launcher is the one file that reaches both.

## Build checklist

1. `cd desktop; npm install` — done, 381 MB `node_modules`.
2. Rebuild the launcher (needs no network and no Node):
   `powershell -ExecutionPolicy Bypass -File packaging\build-exe.ps1` — the script fails the
   build unless the exe is Windows-GUI subsystem `2` and carries the icon.
3. Pick a path:
   * **The release pipeline** (`packaging\release\`): `node stage.mjs`, then
     `node check-router-spawn.mjs` (the router must start out of the payload), then
     `node build.mjs win` or `node build.mjs mac`. This is the only path that bundles the
     router, the identity prompt and the `.icns`, and the only one that produces an
     installer.
   * **Path A by hand** (below): add `packaging\assets\rosalena.ico` to
     `resources\app\desktop\assets\`, copy `router\` to `resources\router` and
     `data\prompts\` to `resources\data\prompts`, or accept that the window will open with
     a dialog saying the router is missing.
4. Launch the produced `.exe` and check, in order: the window appears with the page and
   **no console window appears at all**; the taskbar icon is the navy tile, not Electron's
   atom; the sidebar lists this machine's other sessions; the footer says `router ok`
   **without anyone having started a router** (the app started one — shut your own down
   first to test that, and check `%APPDATA%\Rosalena Harness\router\logs` gained a file);
   send one prompt and see the transcript stream; `File → Open
   folder…` switches the root (see `README.md` — it restarts the server); `File → Open
   in browser` opens the same session in the browser; closing the window leaves no
   process and no listening port (including the router child);
   `%APPDATA%\Rosalena Harness\data\runs` gained the run.
5. On a Mac, before anything else: build the `.dmg` in the `macos` job, install it, clear
   quarantine, and confirm in this order — the window has traffic lights and can be dragged
   by its title strip; the menu bar shows *Rosalena Harness* with About/Quit; `Cmd+Q` quits
   and does not leave the router running; closing the window leaves the app in the Dock and
   clicking it reopens the window; the Dock icon is the navy tile; and
   `~/Library/Application Support/Rosalena Harness/router/logs` gained a file, which is what
   proves the child process could spawn at all.
6. Sign it, then (only if it is really wanted) wire an updater against a signed feed.
