# Release packaging

Everything in this folder answers one question: **what must be on a user's machine for
`Rosalena Harness` to start, and how does a build put exactly that there — no more, no
less?**

There are two packaging paths:

| Path | What it produces | Status |
|---|---|---|
| **electron-builder** (`electron-builder.win.yml`, `electron-builder.mac.yml`) | Windows: NSIS installer + portable `.exe`. macOS: `.dmg` + `.zip` for arm64 and x64. | Written, never run end to end. The macOS path **cannot** be built on Windows — no `.dmg` exists today and none can exist until a macOS runner produces one. |
| **Legacy launcher** (`..\build-exe.ps1`, unchanged, still a separate agent's file) | `Rosalena-Harness.exe`, a 60 KB C# shim that finds a Node install and starts the app or the CLI. | Works today on this machine. Superseded by the installer for end users, because it needs Node.js and an `npm install`ed `desktop\node_modules`. |

The site page (`site\public\download\`) reads a generated manifest, never a hardcoded
link. Nothing on that page claims a file exists until a build has produced it.

---

## 1. The runtime resource map

Measured by reading the code, not by guessing. Every row names the code that resolves
the path, because that is what decides where the file has to sit in a packaged app.

### 1.1 What the app loads at start-up

| # | Resource | Resolved by | Resolution expression | Ships as | In repo |
|---|---|---|---|---|---|
| 1 | `desktop/main.mjs` | Electron | `main` field of the app `package.json` | app payload | yes, 566 lines |
| 2 | `desktop/preload.mjs` | `main.mjs` | `fileURLToPath(new URL("./preload.mjs", import.meta.url))` | app payload, next to `main.mjs` | yes |
| 3 | `harness/src/*.mjs` (21 modules) | `main.mjs` | `await import("../harness/src/ui.mjs")` resolved from `desktop/main.mjs` | app payload at `harness/src/` | yes |
| 4 | `harness/ui/**` (16 files: `index.html`, `app.js`, `format.mjs`, `model-catalog.mjs`, `styles.css`, `panels.css`, `panels.js`, `monitor.html`, `network.html`, `exits.html`, `usage.html`, `models.html`, `_panels-preview.html`, …) | `harness/src/ui.mjs` | `const UI_DIR = resolve(HERE, "..", "ui")` where `HERE = dirname(fileURLToPath(import.meta.url))` | app payload | yes |
| 5 | `harness/data/model-catalog.json` | `harness/src/catalog.mjs` | `CATALOG_PATH = resolve(HERE, "..", "data", "model-catalog.json")` | app payload | yes |
| 6 | `harness/harness.config.json` | `harness/src/plugins.mjs` | `readHarnessConfig()` → `new URL("../harness.config.json", import.meta.url)` | app payload, **rewritten at staging time** (see 1.3) | yes |
| 7 | `harness/plugins/**` (18 plugin folders, 44 files: `plugin.json` + `plugin.mjs`) | `harness/src/plugins.mjs` | `fileURLToPath(new URL("../plugins", import.meta.url))` | app payload | yes |
| 8 | `harness/store/index.json` + `harness/store/modules/**` (6 files) | `harness/src/store.mjs` | `storeIndexPath() = new URL("../store/index.json", import.meta.url)` | app payload | yes |
| 9 | `harness/src/voice/**` (`transcribe.py`, `win-speech.ps1`, `setup.ps1`, `selftest.ps1`, `README.md`) | `harness/src/voice.mjs` | `VOICE_DIR = join(HERE, "voice")` | app payload, **`.venv` excluded** | yes |

### 1.2 What runs beside the app

| # | Resource | Resolved by | Resolution expression | Ships as | In repo |
|---|---|---|---|---|---|
| 10 | `router/` — `src/*.mjs` (9 modules), `router.config.json`, `package.json`, `README.md` | `desktop/router-supervisor.mjs`, started by `desktop/main.mjs` | packaged: `join(process.resourcesPath, "router")`; checkout: `resolve(<desktop>, "..", "router")`. An already-running router on `ROUTER_URL` wins and nothing is started | **`extraResources`** → `<resources>/router` | yes |
| 11 | `data/prompts/rosalena.md` (6 504 B) | `router/src/persona.mjs` | `systemPromptFile` in `router.config.json` (`../data/prompts/rosalena.md`), resolved **relative to the config file**; the router exits with code 2 if it is missing or empty | **`extraResources`** → `<resources>/data/prompts/rosalena.md`, beside `<resources>/router` | yes |
| 12 | Router state: ledger, usage log, request logs, provider keys | `router/src/config.mjs` | `ROSALENA_ROUTER_STATE_DIR`, set by `desktop/router-supervisor.mjs` to `<userData>/router` | created at runtime, never shipped | n/a |
| 13 | Data home (`memory.jsonl`, `runs/`, folders, attachments) | `harness/src/memory.mjs`, `runs.mjs`, `store.mjs` | `process.env.ROSALENA_HOME` else `~/.rosalena`; `desktop/main.mjs` sets `ROSALENA_HOME` to `<userData>/data` before importing the engine | created at runtime, never shipped | n/a |
| 14 | Workspace folder | `desktop/main.mjs` | `<userData>/workspace` | created at runtime | n/a |
| 15 | Node runtime | Electron itself | `process.execPath` is the Electron binary; `process.versions.node` is the Node version inside it | **the app payload already contains it** — no second runtime for the main process | n/a |

### 1.3 Never ship (and why)

| Not shipped | Why |
|---|---|
| `desktop/node_modules/` (399 MB) | Only `electron` lives there; the packaged app *is* Electron. `files` is an allowlist, so a stray `node_modules` can never be swept in. |
| `harness/src/voice/.venv/` (254 MB, 2 655 files) | A local Python virtualenv. Voice is an optional extra with its own setup script; shipping one machine's venv would be wrong on every other machine. |
| `harness/test/`, `harness/probe-*.mjs`, `harness/check-ui-wiring.mjs`, `harness/.scratch/`, `harness/store/build-index.mjs`, `desktop/probe-*.cjs` | Development and measurement tools. Not reachable from the app. |
| `router/test/`, `router/scripts/`, `router/data/keys.json`, `router/logs/`, `router/state/` | Tests, a load-test script, **API keys**, request logs (they contain prompts) and a mutable usage ledger. A release must not carry any of them. |
| `harness/plugins/store.lock.json` | Per-machine plugin install state. |
| `site/`, `docs/`, `packaging/launcher/`, `Rosalena-Harness.exe`, `bin/` | The site is deployed separately; the C# launcher is Windows-only and superseded. |
| The repo's `harness/harness.config.json` | It contains this machine's absolute paths (`D:\Models`, `D:\llama.cpp`, `D:\AppDev\Ai Ecosystem\ContentFarm\workflows\*.json`). Staging writes a neutral config instead: plugins keep their own `plugin.json` defaults and the user points the local-model/ComfyUI plugins at their own folders. Shipping the dev file would hand every user a config pointing at folders that do not exist. |

### 1.4 Transport split: app payload vs `extraResources`

The split is not a style choice, it is forced by the code:

* Rows 1–9 all resolve their neighbours **relative to `import.meta.url`**. A packaged app
  keeps those relative positions only if those trees are part of the application
  payload (`files`), laid out exactly as in the repo: `<app>/desktop/main.mjs` and
  `<app>/harness/...` are siblings.
* `extraResources` land in `Contents/Resources/` (macOS) or `resources/` (Windows),
  which is **not** one level above `desktop/`. Putting `harness/` there today would break
  every one of rows 3–9 at once.
* Row 10 (`router/`) is the exception: nothing imports it by path. `desktop/main.mjs` starts
  it as a child process, so it can and does travel as `extraResources` — but it is started
  with the app's *own* Electron binary and a path that the app computes, not with a bare
  `node` from `PATH`:
  ```js
  spawn(process.execPath, [join(resourcesPath, "router", "src", "index.mjs"), "--config",
        join(resourcesPath, "router", "router.config.json"), "--port", String(port)],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", windowsHide: true })
  ```
  `ELECTRON_RUN_AS_NODE=1` makes the packaged binary behave as plain Node, so a user needs
  no Node install (row 15 stays one runtime, not two). Because the child is started with an
  explicit `--config`, `router/src/config.mjs` would resolve `logDir`/`stateFile` **relative
  to the config file** — i.e. inside `Contents/Resources`, which is read-only in a
  quarantined/translocated `.app`. That is why row 12 exists: the supervisor also sets
  `ROSALENA_ROUTER_STATE_DIR` and the config loader moves every *writable* path under it,
  leaving the read paths (the config itself, `systemPromptFile`) where they are.
  `packaging/release/check-router-spawn.mjs` proves both halves against the staged payload.

Rows 4–9 still resolve their neighbours relative to `import.meta.url`, and still travel in
the app payload (row 2 of §5.2). That is a maintainability question, not a packaging one:
the payload layout mirrors the repo, so those paths are correct inside the bundle.

Making rows 3–9 travel as `extraResources` too would need a code change that is **out of
scope here** (`harness/ui/` belongs to another agent). The change is described in §5.2.

---

## 2. Building

Both configs are driven by the scripts here. They stage a clean app directory first, so
the build input is auditable and does not depend on what happens to be lying around in
the repo.

```bash
# from the repo root; needs network once, for electron + electron-builder only
cd packaging/release
npm install                 # installs electron + electron-builder (devDependencies)
node stage.mjs --check      # verify every resource path exists; writes nothing
node stage.mjs              # assemble build/release/app
node check-router-spawn.mjs # start the router from that payload; prove it answers and writes to the state dir
node build.mjs win          # Windows: NSIS installer + portable exe
node build.mjs mac          # macOS: dmg + zip for arm64 and x64 (needs macOS)
node build.mjs linux        # Linux: AppImage + .deb for x64 (needs Linux)
node check-config.mjs       # structural check of the two YAML configs
```

* `stage.mjs` — assembles `build/release/app` from the resource map, writes the release
  `package.json` (`main: "desktop/main.mjs"`, version from `RELEASE_VERSION` or
  `desktop/package.json`), writes the neutral `harness/harness.config.json`, copies the
  Windows icon and the macOS entitlements into `<app>/build/`, and prints every copied
  path with its size. `--check` prints the same table without writing. `--print-version`
  prints the version the build would use.
* `build.mjs` — runs electron-builder with the app directory as its project directory,
  one platform per invocation, `--publish never`. Prints the artifact list with size and
  SHA-256 when it finishes.
* `manifest.mjs` — turns a directory of **real** artifacts into
  `site/public/download/releases.json` and `SHA256SUMS.txt`. An entry is
  `available: true` only when the file it names exists in that directory; size and hash
  come from that file. This is what keeps the download page honest.
* `check-config.mjs` — a structural check of the two YAML files (indentation, duplicate
  keys, required keys, every `from:`/`icon:` source path present, the mac icon is a real
  ICNS container, both configs carry the same `extraResources`, no `node_modules` in
  `files`). Not a general YAML parser; see §6 for how the files were validated.
* `check-router-spawn.mjs` — starts the staged payload's router the way the window does
  (`ELECTRON_RUN_AS_NODE=1`, explicit `--config` and `--port`, `ROSALENA_ROUTER_STATE_DIR`
  in a scratch directory), asserts `GET /v1/models` answers, asserts the running router's
  startup banner puts ledger/usage/logs under that directory while still reading the
  identity prompt from the payload, then stops it and asserts the port is free. Runs on all
  three platforms and needs no provider key, which is why CI runs it in the gate.

Output: `build/release/app/dist/`. Artifact names are `${version}`-stamped and
`${arch}`-stamped because both configs build more than one architecture.

### Targets

| Config | Targets | Architecture |
|---|---|---|
| `electron-builder.win.yml` | `nsis` installer (per-user, choice of directory, desktop + start-menu shortcut) and `portable` (single exe, no install) | x64 |
| `electron-builder.mac.yml` | `dmg` (drag to Applications) and `zip` | arm64 and x64, two separate artifacts |
| `electron-builder.linux.yml` | `AppImage` (`Rosalena-Harness-<v>-x86_64.AppImage`, updates itself in place) and `deb` (`Rosalena-Harness-<v>-amd64.deb`, installs to `/opt/Rosalena Harness`, updated by installing the next .deb) | x64 |

The macOS config is `hardenedRuntime: true` with `identity: null`. That is deliberate and
honest: an unsigned, unnotarized build is what this repo can produce without an Apple
Developer account, and it is what the config says. `hardenedRuntime` is inert while the
app is unsigned, but it means adding a Developer ID later does not change the config.
`identity: null` **disables signing even when a certificate is present**, so the release
workflow overrides it (`-c.mac.identity=<name>`) only in the branch that has the Apple
secrets.

---

## 3. GitHub Actions

`.github/workflows/release.yml`:

* **Triggers:** push of a tag matching `v*`; manual `workflow_dispatch` with an optional
  `version` input. A manual run builds and uploads workflow artifacts but never creates
  a GitHub Release — publishing stays a deliberate act, a tag.
* **`gate`** (ubuntu-latest): `cd harness && node --import ./test/isolate.mjs --test`,
  `cd site && node --test test/*.test.mjs`, `node packaging/release/stage.mjs --check`,
  `node packaging/release/stage.mjs` + `node packaging/release/check-router-spawn.mjs`
  (the staged payload's router must really start and answer), and
  `node packaging/release/check-config.mjs`. Nothing is built unless every test, every
  resource path and the staged router are green.
* **`windows`** (windows-latest, needs `gate`): installs the two dev tools, stages,
  builds NSIS + portable, also builds the legacy C# launcher (not published), uploads
  `dist/*.exe` as the `windows` artifact.
* **`macos`** (macos-14, arm64 host, needs `gate`): stages, then builds **both**
  architectures from one job — `dmg` + `zip` for arm64 and x64. One mac job instead of
  `macos-14` + `macos-13` because this app has **zero native modules** (everything that
  ships is plain `.mjs`/`.json`), which is the only thing host architecture would affect;
  electron-builder downloads the x64 Electron build for the x64 artifacts either way.
  Two jobs would double the test gate and the runner minutes for identical output.
  Uploads as the `macos` artifact.
* **Notarization step:** guarded by `if: env.APPLE_ID != ''`, so it is skipped on every
  run until the Apple secrets exist. Details in `NOTARIZATION.md`.
* **`release`** (ubuntu-latest, needs both, tag pushes only, runs when Windows
  succeeded): downloads both artifact sets, runs `manifest.mjs` against the real files
  (which is where `sha256` and `size` come from), writes `SHA256SUMS.txt`, and attaches
  everything with `softprops/action-gh-release`. If the macOS job failed, the release
  still publishes the Windows files and the generated manifest marks every macOS entry
  `available: false` — the page then says "not built yet" instead of linking to nothing.

### Secrets

| Secret | Used for | Needed for |
|---|---|---|
| `APPLE_ID` | Apple account e-mail for `notarytool` | macOS notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID | macOS notarization |
| `APPLE_TEAM_ID` | Apple Developer team id | macOS notarization |
| `MAC_CERT_P12` | base64 of the exported **Developer ID Application** `.p12`; mapped to `CSC_LINK` | macOS signing |
| `MAC_CERT_PASSWORD` | password of that `.p12`; mapped to `CSC_KEY_PASSWORD` | macOS signing |
| `MAC_SIGN_IDENTITY` | optional; the leaf name to sign with, e.g. `Developer ID Application: Your Name (TEAMID)`. Defaults to `Developer ID Application` | macOS signing |
| `WIN_CERT_PFX` | base64 of the code-signing `.pfx`; mapped to `CSC_LINK` | Windows signing |
| `WIN_CERT_PASSWORD` | password of that `.pfx`; mapped to `CSC_KEY_PASSWORD` | Windows signing |

Without the Apple secrets the macOS job still builds and uploads both architectures —
unsigned and unnotarized. Without the Windows secrets the installer is unsigned and
SmartScreen shows "Unknown publisher".

Create them with:

```bash
base64 -i developer-id.p12 | pbcopy     # macOS certificate
base64 -w0 codesign.pfx                 # Windows certificate
```

---

## 4. The unsigned path (what a user actually gets today)

macOS, unsigned build, no Apple account:

1. Download the `.dmg` for your architecture, open it, drag **Rosalena Harness** to
   **Applications**.
2. macOS quarantines the download and Gatekeeper refuses the unsigned app. Clear the
   quarantine bit once:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Rosalena Harness.app"
   ```
3. Open it. That is the whole "unsigned but working" path; the page states it plainly
   instead of pretending the app is signed.

Windows, unsigned installer: SmartScreen shows "Windows protected your PC" →
**More info** → **Run anyway**. The portable `.exe` behaves the same way.

### 4.1 Where the files are published

**`Jviat0r/rosalena-harness-downloads`** (public, binaries only), one release per version,
assets named exactly as `manifest.mjs` expects. That is the only place a visitor's browser
is sent.

| Why not somewhere else | |
|---|---|
| Cloudflare Pages | 25 MiB per file; the installer is ~107 MB. Pages serves the site and `releases.json`, nothing else. |
| A release on this repository | Private. Release assets on a private repo need a GitHub login to download. |
| Actions artifacts | Shared 500 MB account allowance for ~700 MB of installers, and they expire. A build that runs out of quota is not a build that failed, so the upload step is `continue-on-error` and the release upload is the real delivery. |

The two build jobs upload straight to the release when a run asks for it:

```bash
gh workflow run release.yml -f version=0.1.0 -f downloads=true
```

`DOWNLOADS_TOKEN` (a repo secret with write access to the downloads repo) is what makes
that step work; without it the step fails loudly rather than silently skipping. The tag is
created by whichever job gets there first, and every upload uses `--clobber`, so re-running
a version replaces the files in place instead of failing on a name collision.

The site manifest is then generated from the files that actually landed, so a size or a
checksum in `releases.json` is always read off a real file:

```bash
gh release download v0.1.0 --repo Jviat0r/rosalena-harness-downloads --dir dist
node packaging/release/manifest.mjs --dir dist --version 0.1.0 \
  --base-url https://github.com/Jviat0r/rosalena-harness-downloads/releases/download/v0.1.0 \
  --out site/public/download/releases.json
```

---

## 5. Blockers

### 5.1 Fixed in this tree (verified on Windows and Linux; **not** on a Mac)

Each of these was a real defect in the list this section used to hold. They are fixed in
the code and, where the fix is testable without a Mac, verified by a command that is part
of the pipeline.

| Was | Now | Verified by |
|---|---|---|
| `desktop/main.mjs` never started the router; every message failed until someone ran `node router/src/index.mjs` by hand | `desktop/router-supervisor.mjs` starts `<resources>/router/src/index.mjs` with `ELECTRON_RUN_AS_NODE=1`, an explicit config, and a port the OS picks; it waits for `GET /v1/models` (bounded), and reuses a router already listening on `ROUTER_URL` instead of starting a second one | `check-router-spawn.mjs`: spawned from the staged payload, 12 models answered, status `spawned` |
| router `logDir`/`stateFile`/`usageFile`/`keyFile` resolved inside the (read-only) bundle | `ROSALENA_ROUTER_STATE_DIR` (set by the supervisor to `<userData>/router`) moves all four; read paths stay put | the same script reads the router's own startup banner and checks every path |
| a transport/readiness failure left a blank window | the window loads only after the router answers, or after a bounded wait that produces a visible dialog naming the reason, the URL and the log directory | code path in `main.mjs` (`announceRouterProblem`); not exercised on a Mac |
| `frame:false` + `titleBarStyle:"hidden"` + `titleBarOverlay:false` → a Mac window with no traffic lights, no drag region | darwin gets `titleBarStyle:"hiddenInset"` with `frame:true` (traffic lights, native drag, native zoom); Windows keeps the frameless look byte-for-byte | Windows regression: `main.mjs` unchanged on win32; **macOS unverified** |
| no macOS menu roles: no About/Quit/Hide, no Cmd+C/V/Z | `desktop/menu.mjs` builds a real mac menu (app menu with About/Services/Hide/Quit, Edit with the clipboard roles, View, Window) and keeps the Windows menu as it was | menu template run through 15 structural assertions (`node`, both platforms) |
| `window-all-closed` → `app.quit()` on macOS too | quits on Windows only; `activate` re-creates or focuses the window on macOS | code path; **macOS unverified** |
| no `.icns`, so the Mac build carried Electron's default icon | `packaging/tools/make-icon.mjs` also writes `packaging/assets/rosalena.icns` (16→1024 px, byte-reproducible); the mac config points at it as `build/icon.icns` | `node packaging/tools/make-icon.mjs --check` parses both containers; `check-config.mjs` asserts the mac icon is a real ICNS |
| voice input was advertised as available on macOS and then failed when the microphone opened | every backend reports unavailable off Windows, with the reason; the window has no microphone control at all (voice is CLI-only), so nothing in the UI is left dangling | new harness test: on `darwin`/`linux` all backends are unavailable and `pickBackend` refuses |
| double-clicking the app a second time started a second window/router | `app.requestSingleInstanceLock()` (already present) plus a `second-instance` handler that focuses the existing window | verified present and unchanged |

Two consequences worth stating plainly:

* The macOS window now starts its own router, from inside the bundle, with the user's own
  writable directory for state. If a router is already running on `127.0.0.1:8077` the app
  uses it and starts nothing — that is deliberate, because a user who runs one by hand has
  probably pointed it at their own keys.
* The in-app window buttons (`header.chrome`) are hidden on macOS by
  `html[data-platform="darwin"] .win-controls { display: none; }`, and the chrome gets
  `padding-left: 88px` for the traffic lights. Both rules are injected by `main.mjs` with
  `webContents.insertCSS`, so no renderer file had to change. The page already publishes
  `data-platform` on `<html>`; there is no second source of truth.

### 5.2 Still standing

These are real, measured, and **not** fixed here. Items 1 and 2 are engineering debt that
does not affect a macOS user who installs the app; 3–7 are facts about an unsigned build.

1. **Rows 4–9 paths are hardcoded relative to `import.meta.url`.** The harness tree has to
   live inside the app payload, which it does, so the packaged app works; but moving those
   trees to `extraResources` (e.g. to patch the UI without rebuilding) would need
   `main.mjs` to compute `HARNESS_ROOT = app.isPackaged ? join(process.resourcesPath,
   "harness") : join(__dirname, "..", "harness")` and `ui.mjs`, `plugins.mjs`,
   `catalog.mjs`, `store.mjs`, `voice.mjs` to accept it. Not done: `harness/` is another
   agent's tree and the current layout is correct.
2. **`run_command` and plugin tools need system binaries.** Anything the agent shells out
   to (`node`, `python`, `ffmpeg`) must exist on the user's `PATH`; Electron's bundled Node
   is **not** on `PATH`. The router no longer needs Node (see §5.1), but a bare `node`
   command typed into the app still does. A general fix would put a `node` shim on the
   child `PATH` or bundle a Node runtime (~50 MB per architecture) as `extraResources`.
3. **Signing.** No Developer ID today: `identity: null`, no notarization. A Mac user must
   clear the quarantine bit once (§4). This is the honest state, not a bug, and the
   download page says so.
4. **Voice is Windows-only.** `harness/src/voice/` is a Windows capture path
   (`win-speech.ps1`) plus a Python transcriber that needs a venv the user builds. On macOS
   the feature now reports itself absent instead of failing; adding capture for macOS
   (`ffmpeg -f avfoundation`) would be a real feature, not a packaging fix.
5. **Reproducible, not bit-reproducible.** Tool versions are pinned by range
   (`packaging/release/package.json`) and the payload is an explicit allowlist, so two runs
   package the same *set* of files with the same layout. The executables are not
   byte-identical: electron-builder stamps timestamps and downloads Electron binaries per
   architecture. Saying otherwise would be a lie. (`rosalena.ico` and `rosalena.icns` *are*
   byte-reproducible, because they are generated from a PNG by this repo.)
6. **Private configuration.** A fresh install has no provider keys and no local model paths,
   so out of the box it can only use the keyless free tier.
7. **Notarization needs Apple secrets** (§3) and a macOS runner that has actually run. Until
   then every download entry stays `available: false`.

---

## 6. Verification performed for this folder

* `node stage.mjs --check` — every source path in §1 exists in the repo today (listed in
  the report; none missing).
* `node stage.mjs` then `node check-router-spawn.mjs` — the staged payload's router starts
  as the window starts it, answers `GET /v1/models` (12 models), writes nothing beside its
  config, reports every writable path inside the state directory and the identity prompt
  inside the payload, and dies when stopped. Exit 0, 17 checks.
* `node check-config.mjs` — structure of both YAML files, required keys, path existence,
  the mac icon is a parseable ICNS, both platforms ship the same `extraResources`.
  Exit 0, 94 checks.
* `node packaging/tools/make-icon.mjs --check` — parses `rosalena.ico` and
  `rosalena.icns` (7 PNG entries, 28 392 bytes) and confirms the pixels; regenerating gives
  a byte-identical `.icns`.
* `cd harness && node --import ./test/isolate.mjs --test` — 808 tests, 0 failures.
* `cd site && node --test test/*.test.mjs` — 117 tests, 0 failures (includes
  `download.test.mjs`, which parses the manifest, enforces "no link unless the file exists"
  and checks the page for external assets).
* The two configs were **not** executed: no `electron-builder` run happened on this machine
  (no install, no network), and the macOS one cannot be executed on Windows at all. What is
  verified here is structure, inputs and a real router start on the packaging output; what
  is *not* verified is an installer that installs, a window with traffic lights, or a menu
  bar on a Mac.
