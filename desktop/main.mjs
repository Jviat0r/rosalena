// Rosalena Harness - the desktop app. This is the default way to run the harness;
// the browser version (`node src\cli.mjs --ui 8090`) stays as the alternative.
//
// This file is a window and a supervisor, never a second implementation. The page,
// the HTTP API, the run store, the token check and the static assets all come from
// `harness/src/ui.mjs`, imported unchanged from the folder next door, and the
// renderer is the same `harness/ui/*` the browser version serves. Nothing in the
// engine is forked, patched or re-implemented here - if the page can do something
// over its own HTTP API, the shell does not do it another way.
//
// What the shell owns, because a browser tab cannot:
//   - a real window with a real menu instead of a tab with a hamburger menu
//   - a port the OS picks (port 0) and a token minted per launch, so the app and a
//     CLI `--ui` session can never fight over 8090, and nothing is hard-coded
//   - the data folder and the workspace folder, remembered between launches
//   - the router: reused if one is already listening, started as a child of this
//     process if not, and stopped again on quit (see router-supervisor.mjs)
//   - "Open folder..." - the one action with no HTTP route (see pickWorkspace)
//   - a clean shutdown that actually releases both ports (see before-quit)
//
// Launch: `npm start` from this folder. Read desktop\README.md first if it does not
// come up: an inherited ELECTRON_RUN_AS_NODE=1 in the environment makes Electron run
// as plain Node and the window never appears.

import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, screen, session, shell } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMenuTemplate, roleItemFor } from "./menu.mjs";
import { showNotice } from "./notify.mjs";
// The window's language (Settings > Language) for the shell's menus and dialogs: the same
// tables the page uses, and the page's saved setting from <home>/ui-state.json.
import { languagePref, resolveLanguage, translator } from "../harness/ui/i18n.mjs";
import { readUiState } from "../harness/src/ui-state.mjs";
import { DEFAULT_READY_MS, DEFAULT_ROUTER_URL, ensureRouter, resolveRouterPaths, stopRouter } from "./router-supervisor.mjs";
import { createUpdater } from "./updater.mjs";
// The sidebar's Browser tabs: the rules are plain functions in the page's own folder (the
// packaged app ships harness/ui whole), so the page and this shell enforce the same ones.
import { BROWSER_PARTITION, checkWebUrl, cleanUserAgent, hardenWebview, permissionDecision, sameAppOrigin } from "../harness/ui/web-tab.mjs";

const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 860;
const MIN_WIDTH = 720;
// The floor the page still draws a usable transcript at: the sidebar and the composer
// both survive 720x480, and a smaller window would be a scrollbar with a title strip.
const MIN_HEIGHT = 480;
// styles.css declares `--bg: #070c13` for the dark theme and paints `body` with it.
// Using that exact value is what makes the first paint invisible: the window looks
// like the page instead of flashing white before app.js renders. It is also the solid
// fallback for a window whose translucency is unavailable (see windowAppearance).
const PAGE_BG = "#070c13";
const APP_ID = "Rosalena.Harness";
// The name the menus and the About panel print. Spelled once: on macOS the first menu is
// labelled with it, and the bundle's CFBundleName comes from productName in package.json.
const APP_NAME = "Rosalena Harness";

// `let`, not a static import: the engine is imported in bootstrap(), *after* the data
// folder is decided, because the harness modules (memory, the process ledger, the MCP
// registry, the proxy pool) each resolve ROSALENA_HOME themselves. A window whose run
// store and whose memory file disagree about where "the data folder" is would look
// like data loss later. Importing the same file the CLI imports is the point; only
// the moment of the import is chosen here.
let createUiServer = null;

// The window's proof that it is the window (ui.mjs `pageKey`). Held only in this process
// and sent only on the window's own page loads, never printed or written anywhere, so a
// command the agent runs cannot fetch a page and read the API token out of it.
const PAGE_KEY = randomBytes(24).toString("hex");
// The app's own pages the page overlay shows in a frame (harness/ui/app.js PAGE_TITLES).
const OVERLAY_PAGES = new Set(["/usage", "/monitor", "/models", "/plugins", "/network", "/exits", "/remote"]);

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** The live `createUiServer()` handle: { server, ready, state, close }. */
let ui = null;
let uiUrl = null;
let uiOrigin = null;
let homeDir = null;
/** OmniRoute as a child of this app, shared by every UI server this launch starts. */
let omniManager = null;
let workspaceDir = null;
let bounds = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
let quitting = false;
/** The language the shell's menus and dialogs are drawn in ("en" | "es"); see applyLanguage. */
let language = "en";
/** The shell's translator for `language` (harness/ui/i18n.mjs): t("Open folder…"). */
let t = translator("en");
/** Checks the published feed, asks, then downloads, verifies, installs and reopens. */
const updater = createUpdater({ getWindow: () => mainWindow, getT: () => t });
/**
 * The router this launch is using: `{ url, source, spawned, child, models, error }`.
 * See router-supervisor.mjs. `null` means startup has not decided yet.
 * @type {null | { url: string, source: string, spawned: boolean, child: import("node:child_process").ChildProcess | null, error: string | null }}
 */
let router = null;
/** True on macOS, where the window keeps native traffic lights and the app menu lives. */
const IS_MAC = process.platform === "darwin";
/** Where the app's own writable router state lives: <userData>/router. */
const routerStateDir = () => join(app.getPath("userData"), "router");
/** How long a started router gets before the window says so instead of waiting forever. */
const ROUTER_READY_MS = (() => {
  const fromEnv = Number((process.env.ROSALENA_ROUTER_READY_MS ?? "").trim());
  return Number.isFinite(fromEnv) && fromEnv >= 2000 ? fromEnv : DEFAULT_READY_MS;
})();

// --------------------------------------------------------------- small utilities

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((done) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
    }),
  ]);

function debounce(fn, ms) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
}

const isDirectory = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

const sameOrigin = (url, origin) => {
  try {
    return Boolean(origin) && new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
};

// OmniRoute's local dashboard, the one outside site this window may frame. Both spellings
// of loopback, because its own redirects and links sometimes say localhost.
const OMNIROUTE_ORIGINS = new Set(["http://127.0.0.1:20128", "http://localhost:20128"]);
const isOmniRoute = (url) => {
  try {
    return OMNIROUTE_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
};

// A link in a rendered answer may be anything at all. Only http(s) leaves this
// process: file:, javascript: and custom schemes are dropped rather than handed to
// the OS, which is the whole point of routing links through one function.
function openExternal(url) {
  const target = String(url ?? "");
  if (!/^https?:\/\//i.test(target)) {
    console.warn(`[rosalena] refused to open a non-http(s) link: ${target}`);
    return;
  }
  shell.openExternal(target).catch((err) => console.error(`[rosalena] could not open ${target}: ${err.message}`));
}

// ------------------------------------------------------------------------ language
//
// The page keeps Settings > Language in localStorage ("rosalena-language": "en", "es" or
// "system"), and persist.js mirrors it into <home>/ui-state.json. The shell reads it from
// there once at startup and is told of a change over rosalena:set-language; "system"
// follows the OS language (app.getLocale()). Only text a person reads changes: log lines
// stay English.

function applyLanguage(saved) {
  language = resolveLanguage(languagePref(saved), app.getLocale());
  t = translator(language);
  return language;
}

// ------------------------------------------------------------------ remembered state
//
// One small file under the app's userData folder: the workspace you picked last and
// the window size/position. Nothing else is stored here - the token is per launch and
// never written, and the chats live in the harness's own run store.

const statePath = () => join(app.getPath("userData"), "desktop-state.json");

async function readState() {
  try {
    const body = JSON.parse(await readFile(statePath(), "utf8"));
    return body && typeof body === "object" ? body : {};
  } catch (err) {
    if (err?.code !== "ENOENT") console.warn(`[rosalena] ignoring unreadable ${statePath()}: ${err.message}`);
    return {};
  }
}

function currentBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return bounds;
  // getNormalBounds() reports the size the window returns to when un-maximized, which
  // is what should be restored next time.
  const normal = mainWindow.getNormalBounds();
  return { width: normal.width, height: normal.height, x: normal.x, y: normal.y };
}

async function writeState() {
  const body = { workspace: workspaceDir, window: currentBounds() };
  try {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(statePath(), `${JSON.stringify(body, null, 2)}\n`, "utf8");
  } catch (err) {
    // Losing the remembered size is not worth failing a session over.
    console.error(`[rosalena] could not save ${statePath()}: ${err.message}`);
  }
}

function restoreBounds(saved) {
  const out = { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  if (Number.isFinite(saved?.width) && saved.width >= MIN_WIDTH) out.width = Math.round(saved.width);
  if (Number.isFinite(saved?.height) && saved.height >= MIN_HEIGHT) out.height = Math.round(saved.height);
  // A position saved on a monitor that is no longer attached would put the window
  // off-screen, so it is only restored when it still lands on a display.
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
    const visible = screen.getAllDisplays().some(({ workArea: area }) => {
      const overlapX = Math.min(saved.x + out.width, area.x + area.width) - Math.max(saved.x, area.x);
      const overlapY = Math.min(saved.y + out.height, area.y + area.height) - Math.max(saved.y, area.y);
      return overlapX >= 120 && overlapY >= 60;
    });
    if (visible) {
      out.x = Math.round(saved.x);
      out.y = Math.round(saved.y);
    }
  }
  return out;
}

// -------------------------------------------------------------- the UI server
//
// The same `createUiServer({...})` the CLI's `--ui` path calls, with two differences
// that belong to a desktop app: port 0 (the OS picks a free port, so the app never
// collides with 8090) and a token minted here (a browser session mints its own).
//
// index.html carries a `<meta name="rosalena-token" content="__ROSALENA_TOKEN__">` tag,
// and ui.mjs fills it in only for a page load that proves it is this window (PAGE_KEY,
// added by createWindow) or a browser this app opened (a one-time code, openInBrowser).
// The token is not on the URL: the URL is printed and shown in About.

// The router address is passed EXPLICITLY (`routerUrl`), not left to the module's
// import-time `DEFAULT_ROUTER`: the supervisor may have started a router on a port the
// OS chose, and every route that asks the engine for a model list has to agree with the
// address the page's footer prints. `process.env.ROUTER_URL` is set too, before the
// import, so the constant and the argument can never disagree.
async function startUi(workspace, routerUrl = router?.url ?? DEFAULT_ROUTER_URL) {
  const instance = createUiServer({
    port: 0,
    host: "127.0.0.1",
    token: randomBytes(16).toString("hex"),
    home: homeDir,
    workspace,
    routerUrl,
    // Early-build tracking (harness/src/telemetry.mjs); the account panel's Sharing switch.
    telemetry: true,
    // OmniRoute inside the app, no window of its own (harness/src/omniroute-manager.mjs).
    manageOmniRoute: true,
    ...(omniManager ? { omniManager } : {}),
    // A local model it loaded is unloaded when idle, and on quit (before-quit below).
    manageLocalModels: true,
    pageKey: PAGE_KEY,
    // Phone access comes back at launch when "Keep phone access on" is set (remote.mjs).
    autoRemote: true,
  });
  const state = await instance.ready(); // resolves once the socket is listening
  const origin = `http://127.0.0.1:${state.port}`;
  return { instance, origin, url: `${origin}/` };
}

async function stopUi(target) {
  if (!target) return;
  // `close()` waits for every connection to end, and an open /api/stream response
  // counts as one - a page left on screen would otherwise hang the quit. Dropping the
  // sockets first is what makes shutdown terminate instead of waiting forever.
  try {
    target.server.closeAllConnections?.();
  } catch (err) {
    console.warn(`[rosalena] could not drop open connections: ${err.message}`);
  }
  try {
    await withTimeout(target.close(), 3000);
  } catch (err) {
    console.error(`[rosalena] the UI server did not close cleanly: ${err.message}`);
  }
}

// Changing the workspace cannot be an HTTP call: `createUiServer` captures
// `workspace` when it is constructed and ui.mjs has no route that changes it. The
// route table is exactly /, /app.js, /format.mjs, /styles.css, /api/health,
// /api/sessions, /api/session, /api/chat (GET and POST), /api/cancel and /api/stream -
// not one of them takes a root, and editing the engine was out of scope. So the shell
// stops the old server and starts a new one with the new root, which is honest about
// what a workspace is (a property of the process, not a setting on a request):
//
//   - the new server gets a fresh port and a fresh token, and the window is pointed at
//     it; nothing is reused, so no stale state can leak between roots
//   - a run that was already going is *not* killed: it belongs to the harness's chat
//     map, which outlives a server instance, so it finishes on the old root and shows
//     up in the sidebar afterwards. The page itself reloads with an empty transcript.
async function switchWorkspace(folder) {
  // Same router, new UI server: the router is a property of the app, not of a workspace.
  const next = await startUi(folder, router?.url ?? DEFAULT_ROUTER_URL);
  const previous = ui;
  ui = next.instance;
  uiUrl = next.url;
  uiOrigin = next.origin;
  workspaceDir = folder;
  await mainWindow.loadURL(next.url);
  void stopUi(previous); // the old page's sockets close as it navigates away
  await writeState();
}

// ------------------------------------------------------- window chrome (per platform)
//
// Windows: the window has no native frame. `frame: false` plus `titleBarStyle: "hidden"`
// and `titleBarOverlay: false` removes the Windows caption bar and the overlay controls
// Electron would otherwise draw on top of the page; `thickFrame: true` keeps the resize
// border, the Windows 11 rounded corners and the drop shadow that a frameless window
// otherwise loses. The title strip is drawn by the page (`.chrome` in index.html,
// `-webkit-app-region` in styles.css) and its three buttons call this process through the
// bridge preload.mjs installs.
//
// macOS was the broken case. `frame: false` on a Mac removes the traffic lights
// altogether - there is nothing to drag, close, minimise or zoom except the page's own
// three buttons, which are Windows-shaped and sit on the right. So on darwin the window
// keeps a real frame with `titleBarStyle: "hiddenInset"`: the title bar is hidden, the
// traffic lights remain, inset from the top-left corner, and the page draws the strip
// underneath them. `titleBarOverlay` and `thickFrame` are Windows-only options and are
// not passed at all there (a no-op flag is not sent - same rule as the material below).
//
// The page's in-app button cluster has to disappear on a Mac, or the window would show
// six window controls. That is a permanent stylesheet rule now, not something this shell
// injects: harness/ui/styles.css carries
//   html[data-platform="darwin"] .win-controls { display: none; }
//   html[data-platform="darwin"] .chrome { padding-left: 88px; }
// keyed off `html[data-platform]`, which app.js sets from `window.rosalenaDesktop.platform`.
// Keeping it in the stylesheet means it also survives a reload without an insertCSS dance.

/** The window options that differ by platform. */
function windowChromeOptions() {
  if (IS_MAC) {
    return {
      // A real frame, hidden title bar: traffic lights stay, nothing else is drawn.
      frame: true,
      titleBarStyle: "hiddenInset",
    };
  }
  return {
    // Frameless: the page draws the title strip, the shell draws nothing.
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    thickFrame: true, // resize edges + rounded corners survive `frame: false`
  };
}

/** The Windows 11 build number, or 0 when this is not Windows 11. */
function windowsBuild() {
  if (process.platform !== "win32") return 0;
  const match = /^10\.0\.(\d+)/.exec(String(process.getSystemVersion?.() ?? ""));
  return match ? Number(match[1]) : 0;
}

// Mica and acrylic are a Windows 11 finish. Anything older - including a Windows whose
// version this process cannot read - gets no material at all, so the window keeps the
// solid palette colour from `backgroundColor`. A translucent window with no material
// behind it reads as a broken app, which is worse than a flat one.
//
// The page paints an opaque palette, so the material only shows at the window edge and
// through the rounded corners; it is a finish, not a source of contrast. Nothing in
// styles.css relies on it being present.
function windowAppearance() {
  const build = windowsBuild();
  if (build >= 22621) return { backgroundMaterial: "mica" };
  if (build >= 22000) return { backgroundMaterial: "acrylic" };
  return {};
}

// ------------------------------------------------------------------ the window icon
//
// The same mark the launcher carries (packaging\assets\rosalena.ico), generated by
// packaging\tools\make-icon.mjs and embedded in the .exe by /win32icon. Electron takes a
// path to a real .ico and picks the sizes it needs out of it, so the file is resolved at
// run time instead of being copied around by a build step. Three layouts are tried: the
// source tree (packaging\ beside desktop\), and the two places a packaged payload can
// put it.
//
// Windows shows the *executable's* icon on the taskbar unless the window sets one, and in
// development the executable is electron.exe - so without this the app would be a dark
// window with Electron's atom in the taskbar.
const ICON_CANDIDATES = [
  new URL("../packaging/assets/rosalena.ico", import.meta.url), // <product>\packaging\assets
  new URL("./assets/rosalena.ico", import.meta.url), // desktop\assets (packaged copy)
  new URL("../assets/rosalena.ico", import.meta.url), // <product>\assets
];
// Linux reads PNG, not .ico. A packaged Linux build gets its launcher and dock icon from the
// hicolor set the .deb installs (or the AppImage carries), matched to the window through
// desktopName; this PNG is for a checkout run, where nothing else names an icon.
const LINUX_ICON_CANDIDATES = [new URL("../packaging/assets/icon/rosalena-256.png", import.meta.url)];

function windowIcon() {
  // macOS takes the icon from the bundle (electron-builder packs
  // packaging\assets\rosalena.icns as Contents\Resources\icon.icns and Info.plist points
  // at it); BrowserWindow has no per-window icon there, and the Dock shows the bundle's.
  // Returning null is the correct answer, not a missing file.
  if (IS_MAC) return null;
  if (process.platform === "linux") {
    for (const candidate of LINUX_ICON_CANDIDATES) {
      const path = fileURLToPath(candidate);
      if (existsSync(path)) return path;
    }
    return null;
  }
  for (const candidate of ICON_CANDIDATES) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  // Not fatal - Windows falls back to Electron's icon - but it is worth a line, because
  // the usual cause is a build that forgot to copy the file.
  console.error(
    "[rosalena] no icon found (looked for packaging\\assets\\rosalena.ico); the window will use Electron's own icon",
  );
  return null;
}

// ---------------------------------------------------------------- window bridge
//
// Six channels, all narrow: this is a window, not a host API. Each one resolves for
// the calling window only, so a future second window could not be driven by the first.

function windowFor(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() ? win : null;
}

function announceMaximised(win) {
  if (win && !win.isDestroyed()) win.webContents.send("rosalena:maximised", win.isMaximized());
}

function registerWindowBridge() {
  ipcMain.handle("rosalena:minimise", (event) => {
    windowFor(event)?.minimize();
    return true;
  });

  ipcMain.handle("rosalena:maximise", (event) => {
    const win = windowFor(event);
    if (!win) return false;
    // A resize-locked window has no business being maximised: the page disables the
    // button in that state, and this is the authority behind it.
    if (!win.isResizable() && !win.isMaximized()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  ipcMain.handle("rosalena:close", (event) => {
    windowFor(event)?.close();
    return true;
  });

  // The page's "Check for updates" row. The answer and any "Update and restart" question
  // are native dialogs owned by updater.mjs; the page only gets the verdict back.
  ipcMain.handle("rosalena:check-updates", async () => {
    const verdict = await updater.check({ interactive: true });
    return { state: verdict.state, current: verdict.current, latest: verdict.latest, reason: verdict.reason };
  });

  // The page's folder button. pickWorkspace shows the picker and switches the server.
  ipcMain.handle("rosalena:pick-workspace", async () => {
    await pickWorkspace();
    return workspaceDir;
  });

  // The page's per-chat folder button: only the picker. The page gives the folder to the
  // chat on screen; the server keeps running where it was started.
  // The sidebar's Folder… tabs use the same picker with their own words, opening at the
  // folder the tab shows now (only when that is a folder that exists).
  ipcMain.handle("rosalena:pick-folder", async (event, asked) => {
    const parent = windowFor(event) ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
    const sidebar = asked?.purpose === "sidebar";
    let start = workspaceDir;
    if (sidebar && typeof asked.start === "string" && asked.start) {
      try {
        if ((await stat(asked.start)).isDirectory()) start = asked.start;
      } catch {
        /* a folder that is gone opens the picker at the app's folder */
      }
    }
    const options = sidebar
      ? { title: t("Show a folder in the sidebar"), defaultPath: start, buttonLabel: t("Show this folder"), properties: ["openDirectory"] }
      : { title: t("Choose this chat's folder"), defaultPath: workspaceDir, buttonLabel: t("Use this folder"), properties: ["openDirectory", "createDirectory"] };
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths?.[0] ?? null;
  });

  // Settings > Notifications: a run finished, failed or waits for an approval while the
  // window is in the background (notify.mjs: text only, a click brings this window back).
  ipcMain.handle("rosalena:notify", (event, asked) => showNotice(Notification, asked, { win: windowFor(event), icon: windowIcon(), t }));

  // Settings > Language (i18n.mjs chooseLanguage): the page has saved the choice and reloads
  // itself; the shell switches its translator and redraws the application menu. Anything but
  // "en", "es" or "system" reads as English. Answers the language now in use.
  ipcMain.handle("rosalena:set-language", (_event, code) => {
    applyLanguage(languagePref(code));
    buildMenu();
    return language;
  });

  ipcMain.handle("rosalena:is-maximised", (event) => Boolean(windowFor(event)?.isMaximized()));

  ipcMain.handle("rosalena:get-resizable", (event) => Boolean(windowFor(event)?.isResizable()));

  ipcMain.handle("rosalena:set-resizable", (event, value) => {
    const win = windowFor(event);
    if (!win) return false;
    const want = Boolean(value);
    // Un-maximise first: a maximised window that stops being resizable would be stuck
    // at full size with no restore control.
    if (!want && win.isMaximized()) win.unmaximize();
    win.setResizable(want);
    announceMaximised(win);
    return win.isResizable();
  });
}

// ------------------------------------------------------------------ Browser tabs
//
// The sidebar's "+ > Web > Browser" tab shows real web pages. An iframe cannot (most sites
// refuse to be framed, and this window only lets frames load the app's own pages), so the
// page uses a <webview>: a separate, sandboxed renderer drawn inside the page, which means
// menus, Settings and dialogs draw over it like over anything else and it follows the
// sidebar's size by plain CSS. What makes it safe is decided here, not in the page:
//   - will-attach-webview forces the settings (no preload, no Node, contextIsolation,
//     sandbox, webSecurity) and the one partition below, and refuses any other src
//   - that partition is its own persisted session: logins survive restarts, and nothing in
//     it is shared with the app's window (the page key header is the window session's)
//   - file: is not served in it, and requests to the app's own server are cancelled
//   - camera, microphone, location, notifications and clipboard reads are asked of the
//     person (once per site, for this launch); everything else is refused
//   - a page asking for a new window gets it in the same tab
//   - every navigation and redirect is checked against the same rules (web-tab.mjs)

/** `${origin} ${permission}` -> the person's answer this launch, or the pending question. */
const sitePermissions = new Map();

const originOf = (url) => {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "";
  }
};

// web-tab.mjs words each asked permission in English ("use your camera or microphone"); the
// question shows it in the window's language. A phrase not listed here is shown as it is.
function permissionWhat(what) {
  const words = {
    "use your camera or microphone": t("use your camera or microphone"),
    "know your location": t("know your location"),
    "show notifications": t("show notifications"),
    "read your clipboard": t("read your clipboard"),
  };
  return Object.prototype.hasOwnProperty.call(words, what) ? words[what] : what;
}

function askSitePermission(origin, permission, what) {
  const key = `${origin} ${permission}`;
  if (sitePermissions.has(key)) return Promise.resolve(sitePermissions.get(key));
  let host = origin;
  try {
    host = new URL(origin).host || origin;
  } catch {
    /* an opaque origin is shown as it is */
  }
  const options = {
    type: "question",
    title: t("A site is asking"),
    message: t("{host} wants to {what}.", { host, what: permissionWhat(what) }),
    detail: t("Asked by a page in a Browser tab. Your answer lasts until Rosalena closes."),
    buttons: [t("Block"), t("Allow")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const asked = (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    .then(({ response }) => response === 1)
    .catch(() => false)
    .then((allowed) => {
      sitePermissions.set(key, allowed);
      return allowed;
    });
  // Two requests at once (camera and microphone) get one question.
  sitePermissions.set(key, asked);
  return asked;
}

function setUpBrowserSession() {
  const ses = session.fromPartition(BROWSER_PARTITION);
  // Sign-in pages that refuse "Electron" see an ordinary Chrome.
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent(), [app.getName(), APP_NAME, "rosalena-desktop"]));
  try {
    ses.protocol.handle("file", () => new Response(t("Local files are not opened in a Browser tab."), { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } }));
  } catch (err) {
    // Navigation checks below still refuse file: addresses; this is the second lock.
    console.warn(`[rosalena] could not close file: in the browser session: ${err.message}`);
  }
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (uiOrigin && sameAppOrigin(details.url, uiOrigin)) {
      console.warn(`[rosalena] a Browser tab asked for the app's own server (${details.url.slice(0, 120)}); refused`);
      return callback({ cancel: true });
    }
    callback({});
  });
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const { decision, what } = permissionDecision(permission);
    if (decision === "allow") return callback(true);
    if (decision === "deny") return callback(false);
    const origin = originOf(details?.requestingUrl || contents?.getURL?.());
    if (!origin || origin === "null") return callback(false);
    void askSitePermission(origin, permission, what).then((allowed) => callback(Boolean(allowed)));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const { decision } = permissionDecision(permission);
    if (decision === "allow") return true;
    if (decision === "deny") return false;
    return sitePermissions.get(`${originOf(requestingOrigin)} ${permission}`) === true;
  });
}

/** The rules for a page inside a Browser tab, set the moment its webview attaches. */
function wireBrowserGuest(contents, win) {
  const allowed = (url) => checkWebUrl(url, { appOrigin: uiOrigin }).ok;
  // target=_blank links and window.open: the same tab, never a new window.
  contents.setWindowOpenHandler(({ url }) => {
    if (url && url !== "about:blank" && allowed(url)) contents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  const guard = (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    console.warn(`[rosalena] a Browser tab tried to open ${String(url).slice(0, 160)}; refused`);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);

  // Right-click inside the page: the usual few, plus "open in your browser".
  contents.on("context-menu", (_event, params) => {
    const flags = params.editFlags ?? {};
    const items = [];
    // Role items: Electron's own label in English, the window's language otherwise (menu.mjs).
    const item = roleItemFor(language, t);
    if (params.linkURL && allowed(params.linkURL)) {
      items.push(
        { label: t("Open link here"), click: () => contents.loadURL(params.linkURL).catch(() => {}) },
        { label: t("Open link in your browser"), click: () => openExternal(params.linkURL) },
        { label: t("Copy link"), click: () => clipboard.writeText(String(params.linkURL)) },
        { type: "separator" },
      );
    }
    if (params.isEditable) {
      items.push(item("cut", { enabled: flags.canCut }), item("copy", { enabled: flags.canCopy }), item("paste", { enabled: flags.canPaste }), item("selectAll"), { type: "separator" });
    } else if (String(params.selectionText ?? "").trim()) {
      items.push({ role: "copy", label: t("Copy") }, { type: "separator" });
    }
    const history = contents.navigationHistory;
    items.push(
      { label: t("Back"), enabled: Boolean(history?.canGoBack()), click: () => history?.goBack() },
      { label: t("Forward"), enabled: Boolean(history?.canGoForward()), click: () => history?.goForward() },
      { label: t("Reload"), click: () => contents.reload() },
    );
    if (!win.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Esc leaves a video that went full screen inside the tab (Electron does not by itself).
  let full = false;
  contents.on("enter-html-full-screen", () => {
    full = true;
  });
  contents.on("leave-html-full-screen", () => {
    full = false;
  });
  contents.on("before-input-event", (event, input) => {
    if (!full || input.type !== "keyDown" || input.key !== "Escape") return;
    event.preventDefault();
    contents.executeJavaScript("document.fullscreenElement && document.exitFullscreen()", true).catch(() => {});
  });
}

// ------------------------------------------------------------------- the window

function createWindow() {
  const build = windowsBuild();
  const icon = windowIcon();
  // One line, so a build that forgot the icon is visible in the log rather than a
  // silent Electron icon in the taskbar.
  if (icon) console.log(`[rosalena] icon ${icon}`);
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    // The window's own icon (taskbar, Alt+Tab, the title strip's system menu). Without it
    // a development run shows whichever electron.exe was started. Absent on macOS.
    ...(icon ? { icon } : {}),
    // Frameless on Windows; hiddenInset (native traffic lights) on macOS.
    ...windowChromeOptions(),
    // Windows 11 rounds a window's corners itself; on Windows 10 the option does nothing
    // at all, so it is only passed where it can have an effect. Same rule as the material
    // above: a flag that is a no-op on this OS is not sent, rather than sent and ignored.
    ...(build >= 22000 ? { roundedCorners: true } : {}),
    backgroundColor: PAGE_BG,
    ...windowAppearance(),
    autoHideMenuBar: true, // the menu is still there - Alt shows it, as on any Windows app
    show: false, // reveal on ready-to-show: no white flash before the page paints
    title: "Rosalena Harness",
    webPreferences: {
      // The page is still the same page the browser version serves and it still needs
      // nothing from Node: it talks to its own HTTP server. The preload adds the window
      // controls and nothing else - no `require`, no `process`, no filesystem - while
      // context isolation and Chromium's sandbox stay on.
      preload: fileURLToPath(new URL("./preload.mjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium's built-in PDF viewer, for PDFs opened in the sidebar's file viewer.
      plugins: true,
      // The sidebar's Browser tabs. Every <webview> is checked and locked down by
      // will-attach-webview below (see "Browser tabs" above); one that does not pass is
      // never attached.
      webviewTag: true,
    },
  });

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const verdict = hardenWebview(webPreferences, params, { appOrigin: uiOrigin });
    if (verdict.ok) return;
    event.preventDefault();
    console.error(`[rosalena] a webview was refused: ${verdict.reason}`);
  });
  win.webContents.on("did-attach-webview", (_event, contents) => wireBrowserGuest(contents, win));

  // The window's page loads carry PAGE_KEY, so ui.mjs puts the token in them. Only
  // top-level loads of this app's own origin: a plugin frame or a fetch never gets it.
  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (details.resourceType === "mainFrame" && details.webContentsId === win.webContents.id && sameOrigin(details.url, uiOrigin)) {
      headers["x-rosalena-page"] = PAGE_KEY;
    }
    // The page overlay (Tokens, Monitor, Models, Plugins, Wi-Fi, VPN exits) loads those pages
    // in a frame, and without the key they got an empty token, so every switch and button on
    // them failed (bug hunt 2026-11-08). Only that frame (named by app.js, a direct child of
    // the window's page) and only those page paths.
    if (
      details.resourceType === "subFrame" &&
      details.webContentsId === win.webContents.id &&
      sameOrigin(details.url, uiOrigin) &&
      OVERLAY_PAGES.has(new URL(details.url).pathname.replace(/\/+$/, "")) &&
      details.frame?.name === "rosalena-page" &&
      details.frame?.parent?.routingId === win.webContents.mainFrame.routingId
    ) {
      headers["x-rosalena-page"] = PAGE_KEY;
    }
    callback({ requestHeaders: headers });
  });

  // OmniRoute's dashboard has a tab in this window (harness/ui/plugins-ui.js), but it sends
  // X-Frame-Options: DENY and `frame-ancestors 'none'`, so it refuses to be framed anywhere.
  // For responses from OmniRoute's own loopback origin only, those two rules are replaced by
  // "this app may frame it"; every other site keeps its headers untouched.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (!isOmniRoute(details.url)) return callback({});
    const headers = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      const lower = name.toLowerCase();
      if (lower === "x-frame-options") continue;
      if (lower === "content-security-policy") {
        const ancestors = `frame-ancestors 'self' ${uiOrigin}`;
        headers[name] = [].concat(value).map((policy) => policy.replace(/frame-ancestors[^;]*/i, ancestors));
        continue;
      }
      headers[name] = value;
    }
    callback({ responseHeaders: headers });
  });

  win.on("ready-to-show", () => win.show());
  // Reveal even if the page never paints: a window that stays hidden because
  // ready-to-show never fires is indistinguishable from "the app did not start".
  const reveal = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 4000);
  reveal.unref?.();
  win.on("closed", () => clearTimeout(reveal));

  // The title strip has to know when the caption glyph should become "restore".
  win.on("maximize", () => announceMaximised(win));
  win.on("unmaximize", () => announceMaximised(win));

  // A renderer asking for a child window gets none; an http(s) link is handed to the
  // user's real browser instead. Nothing in the page opens windows, so this is the
  // guard that makes that stay true.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });

  // Same rule for a top-level navigation: a link that would replace the app with a
  // web page opens externally, and the app stays on its own origin. Our own loadURL
  // calls do not emit this event.
  win.webContents.on("will-navigate", (event, url) => {
    if (sameOrigin(url, uiOrigin)) return;
    event.preventDefault();
    openExternal(url);
  });

  // A sidebar plugin runs in a sandboxed frame (harness/ui/plugin-host.js). The sandbox
  // keeps it out of this page, but a frame may still navigate itself, so a plugin could
  // swap its own page for a website inside the window. A frame may only ever show a
  // plugin page from this server; anything else is cancelled, not opened elsewhere.
  win.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    const target = String(details.url ?? "");
    if (target === "about:blank" || target.startsWith("about:srcdoc")) return;
    if (sameOrigin(target, uiOrigin) && new URL(target).pathname.startsWith("/plugin-app/")) return;
    // The page overlay (Tokens, Monitor, Models, Plugins, Wi-Fi, VPN exits) shows the app's
    // own pages in a frame named "rosalena-page" (app.js openPage). Only that frame, and
    // only this server's pages; "/" is its back link, which app.js turns into a close.
    // A frame can rename itself, so the name alone is not enough: it must also be a direct
    // child of the window's page, and go only to those pages.
    const topChild = details.frame?.parent?.routingId === win.webContents.mainFrame.routingId;
    const pathOf = (u) => {
      try {
        return new URL(u).pathname.replace(/\/+$/, "") || "/";
      } catch {
        return "";
      }
    };
    if (topChild && details.frame?.name === "rosalena-page" && sameOrigin(target, uiOrigin) && (OVERLAY_PAGES.has(pathOf(target)) || pathOf(target) === "/")) return;
    // The sidebar's file viewer: a PDF or an HTML file from the workspace, through /api/file
    // only (the server serves HTML sandboxed, with no origin).
    if (topChild && details.frame?.name === "rosalena-file" && sameOrigin(target, uiOrigin) && pathOf(target) === "/api/file") return;
    // Chromium's built-in PDF viewer, which a PDF in the file viewer opens inside its frame.
    if (target.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")) return;
    // The OmniRoute tab: its dashboard moves between its own pages (login, home, logs).
    if (isOmniRoute(target)) return;
    details.preventDefault();
    console.error(`[rosalena] a plugin frame tried to navigate to ${target.slice(0, 200)}; refused`);
  });

  // Right-click: Electron shows no menu by default, so selected text in a chat could not be
  // copied that way. Copy for a selection, Cut/Paste/Select all in a text box. A place that
  // draws its own menu (a chat row's Pin menu) prevents the event and never gets here.
  win.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags ?? {};
    const items = [];
    // Role items: Electron's own label in English, the window's language otherwise (menu.mjs).
    const item = roleItemFor(language, t);
    if (params.isEditable) {
      items.push(
        item("undo", { enabled: flags.canUndo }),
        item("redo", { enabled: flags.canRedo }),
        { type: "separator" },
        item("cut", { enabled: flags.canCut }),
        item("copy", { enabled: flags.canCopy }),
        item("paste", { enabled: flags.canPaste }),
        { type: "separator" },
        item("selectAll", { enabled: flags.canSelectAll }),
      );
    } else if (String(params.selectionText ?? "").trim()) {
      items.push({ role: "copy", label: t("Copy") }, { type: "separator" }, { role: "selectAll", label: t("Select all") });
    } else if (params.linkURL) {
      items.push({ label: t("Copy link"), click: () => clipboard.writeText(String(params.linkURL)) });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Escape leaves a video, a file viewer or a plugin that went full screen. Chrome does this
  // for a page by itself; Electron does not, so a full-screen element trapped the window.
  // The key is taken here so the page's own Escape handlers (close a menu, close a page)
  // do not also fire on the same press.
  let htmlFullScreen = false;
  win.on("enter-html-full-screen", () => {
    htmlFullScreen = true;
  });
  win.on("leave-html-full-screen", () => {
    htmlFullScreen = false;
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape" || !htmlFullScreen) return;
    event.preventDefault();
    win.webContents.executeJavaScript("document.fullscreenElement ? document.exitFullscreen().then(() => true) : false", true).catch(() => {});
    // If the page could not leave by itself, the window still does.
    setTimeout(() => {
      if (!win.isDestroyed() && htmlFullScreen && win.isFullScreen()) win.setFullScreen(false);
    }, 300);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[rosalena] the page process ended (${details.reason}); reload from View > Reload`);
  });

  const saveBounds = debounce(() => {
    bounds = currentBounds();
    void writeState();
  }, 400);
  win.on("resize", saveBounds);
  win.on("move", saveBounds);
  win.on("closed", () => {
    mainWindow = null;
  });

  return win;
}

// --------------------------------------------------------------------- actions

async function pickWorkspace() {
  const options = {
    title: t("Open a workspace folder"),
    defaultPath: workspaceDir,
    buttonLabel: t("Use this folder"),
    properties: ["openDirectory", "createDirectory"],
  };
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths?.length) return;
  const folder = result.filePaths[0];
  if (folder === workspaceDir) return;
  try {
    await switchWorkspace(folder);
    console.log(`[rosalena] workspace is now ${workspaceDir}`);
  } catch (err) {
    console.error(`[rosalena] could not switch workspace: ${err?.stack ?? err}`);
    dialog.showErrorBox(t("Could not open that folder"), String(err?.message ?? err));
  }
}

async function openInBrowser() {
  if (!uiUrl) return;
  // A one-time code: the browser's first load spends it for a cookie, so the page there can
  // act too. A code is good for one load within a minute; the plain URL would be read-only.
  const code = ui?.issuePageCode?.();
  try {
    await shell.openExternal(code ? `${uiOrigin}/?code=${code}` : uiUrl);
  } catch (err) {
    console.error(`[rosalena] could not open the browser: ${err.message}`);
  }
}

async function openDataFolder() {
  const problem = await shell.openPath(homeDir);
  if (problem) dialog.showErrorBox(t("Could not open the data folder"), `${homeDir}\n\n${problem}`);
}

/**
 * "label      value" lines for the About and router boxes: each label padded to one column
 * (at least 11 wide, so the English lines are exactly the ones these boxes always printed).
 */
function labelledLines(rows) {
  const width = Math.max(11, ...rows.map(([label]) => label.length + 1));
  return rows.map(([label, value]) => `${label.padEnd(width)}${value}`);
}

async function showAbout() {
  // `router` is what this launch actually decided, not a guess from the environment:
  // "already running" and "started on 127.0.0.1:51xxx" are different answers to the same
  // question, and a user reporting a problem needs the one that is true here.
  const routerLine = router
    ? `${router.url} (${router.source === "spawned" ? t("started by this app") : router.source === "already-running" ? t("already running, reused") : t("not answering: {error}", { error: router.error })})`
    : DEFAULT_ROUTER_URL;
  const detail = [
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    "",
    ...labelledLines([
      [t("window"), uiUrl ?? t("(not running)")],
      [t("data"), homeDir],
      [t("workspace"), workspaceDir],
      [t("router"), routerLine],
      [t("router log"), join(routerStateDir(), "logs")],
    ]),
  ].join("\n");
  const options = { type: "info", title: t("About {appName}", { appName: APP_NAME }), message: `${APP_NAME} ${app.getVersion()}`, detail, buttons: [t("OK")] };
  if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, options);
  else await dialog.showMessageBox(options);
}

function buildMenu() {
  // The template itself lives in menu.mjs: a plain function, so what a Mac gets (app menu,
  // Edit roles for Cmd+C/V, Window menu) can be checked by `node` on a machine that is not
  // a Mac. See desktop/README.md.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        appName: APP_NAME,
        t,
        language,
        actions: {
          about: () => void showAbout(),
          checkForUpdates: () => void updater.check({ interactive: true }),
          pickWorkspace: () => void pickWorkspace(),
          openInBrowser: () => void openInBrowser(),
          openDataFolder: () => void openDataFolder(),
        },
      }),
    ),
  );
}

// ---------------------------------------------------------------------- startup

function resolveHome() {
  const fromEnv = (process.env.ROSALENA_HOME ?? "").trim();
  return fromEnv || join(app.getPath("userData"), "data");
}

async function resolveWorkspace(saved) {
  if (typeof saved === "string" && saved.trim() && (await isDirectory(saved))) return saved;
  const fallback = join(app.getPath("userData"), "workspace");
  if (typeof saved === "string" && saved.trim()) {
    // Said out loud rather than silently: a workspace that vanished (an unplugged
    // drive, a renamed folder) would otherwise look like the agent refusing to work.
    console.warn(`[rosalena] the last workspace (${saved}) is not available; using ${fallback}`);
  }
  await mkdir(fallback, { recursive: true });
  return fallback;
}

async function bootstrap() {
  // The taskbar grouping id is a Windows idea; elsewhere the call has nothing to do.
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);
  // Before any window exists: a preload calls these the moment the page starts.
  registerWindowBridge();
  // The Browser tabs' session (its own cookies, permissions and rules), before a tab can open.
  setUpBrowserSession();

  const saved = await readState();
  homeDir = resolveHome();
  if (!(process.env.ROSALENA_HOME ?? "").trim()) process.env.ROSALENA_HOME = homeDir;
  await mkdir(join(homeDir, "runs"), { recursive: true });
  // The window's language, before any menu or dialog is drawn (the page saved it here).
  applyLanguage(readUiState(homeDir).items["rosalena-language"]);
  console.log(`[rosalena] language  ${language}`);

  // The router comes first, and it comes before the engine is imported: the engine reads
  // its router address at module scope, so the address has to be settled before that
  // import happens, not after. See router-supervisor.mjs for the reuse/spawn rules.
  const paths = resolveRouterPaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? "",
    mainDir: fileURLToPath(new URL(".", import.meta.url)),
  });
  console.log(`[rosalena] router     ${paths.present ? paths.entry : "(no router in this build)"}`);
  // A copy started by the updater's script (it sets RU_TARGET) inherited the environment
  // of the copy it replaced, and up to 0.1.10 that included the ROUTER_URL the old copy set
  // for its OWN router, which died with it. Read as the person's explicit choice, it left
  // the updated app with no router and "no model can reply yet". After an update, an
  // address is only kept when it was the person's own setting, never the old copy's.
  if (process.env.RU_TARGET) {
    if (process.env.ROSALENA_ROUTER_SELF || !process.env.ROSALENA_ROUTER_USER) {
      delete process.env.ROUTER_URL;
      delete process.env.ROSALENA_ROUTER_URL;
    }
    for (const name of ["RU_TARGET", "RU_SETUP", "RU_ARGS", "RU_SOURCE", "RU_PID", "ROSALENA_ROUTER_SELF"]) delete process.env[name];
  }
  // Whether an address came from the person (their environment) or not, remembered before
  // this copy writes its own router's address into the same variables below.
  if ((process.env.ROUTER_URL ?? process.env.ROSALENA_ROUTER_URL ?? "").trim()) process.env.ROSALENA_ROUTER_USER = "1";
  router = await ensureRouter({
    paths,
    stateDir: routerStateDir(),
    requestedUrl: (process.env.ROUTER_URL ?? process.env.ROSALENA_ROUTER_URL ?? "").trim(),
    token: process.env.ROSALENA_ROUTER_TOKEN ?? "",
    waitMs: ROUTER_READY_MS,
    log: (line) => console.log(line),
  });
  // Both spellings, on purpose: agent.mjs reads ROUTER_URL, models.mjs reads
  // ROSALENA_ROUTER_URL, and the UI server is told explicitly as well
  // (startUi's `routerUrl`), so the page, the model picker and chat all agree.
  process.env.ROUTER_URL = router.url;
  process.env.ROSALENA_ROUTER_URL = router.url;
  // Marks those two as this copy's own, so the updater does not hand them to the next copy.
  if (!process.env.ROSALENA_ROUTER_USER) process.env.ROSALENA_ROUTER_SELF = "1";

  ({ createUiServer } = await import("../harness/src/ui.mjs"));
  // OmniRoute runs as this app's own windowless child, one manager for the whole launch so a
  // workspace switch (a new UI server) does not restart it. Stopped in before-quit.
  const { createOmniRouteManager } = await import("../harness/src/omniroute-manager.mjs");
  omniManager = createOmniRouteManager({ home: homeDir, log: (line) => console.log(`[rosalena] ${line}`) });

  workspaceDir = await resolveWorkspace(saved.workspace);
  bounds = restoreBounds(saved.window);

  const started = await startUi(workspaceDir, router.url);
  ui = started.instance;
  uiUrl = started.url;
  uiOrigin = started.origin;

  buildMenu();
  mainWindow = createWindow();
  await mainWindow.loadURL(uiUrl);

  console.log(`[rosalena] window    ${uiUrl}`);
  console.log(`[rosalena] workspace ${workspaceDir}`);
  console.log(`[rosalena] data      ${homeDir}`);
  await writeState();

  // The window is up and the page is showing its own router state; this explains it.
  if (router.error) void announceRouterProblem();

  // Background update checks: the first one ~15 s from now, then every six hours.
  void updater.start();
}

/**
 * Tell the user what a missing router means, without pretending the app is broken.
 *
 * The window is already open and usable - settings, sessions and the transcript all come
 * from the UI server - so this is a warning with a way out, not an error box that closes
 * the app. Every path a reader might need is printed: the reason, where the router keeps
 * its log, and the two ways to get one (let the app start it next time, or start it by
 * hand on the address it expects).
 */
async function announceRouterProblem() {
  const logDir = join(routerStateDir(), "logs");
  const detail = [
    router?.error ?? t("no reason was recorded"),
    "",
    ...labelledLines([
      [t("router"), router?.url ?? DEFAULT_ROUTER_URL],
      [t("log"), logDir],
      [t("build"), app.isPackaged ? t("packaged") : t("from a checkout")],
    ]),
    "",
    router?.source === "unreachable"
      ? t("ROUTER_URL is set, so the app did not start a router of its own. Unset it to let the app start one.")
      : t("Start one by hand from the repository root:  {command}", { command: "node router/src/index.mjs" }),
    t("The window stays open: your sessions and transcripts do not need the router."),
  ].join("\n");
  const options = {
    type: "warning",
    title: t("The router is not answering"),
    message: t("Rosalena Harness is open, but no model can reply yet."),
    detail,
    buttons: [t("Continue")],
    defaultId: 0,
  };
  try {
    if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, options);
    else await dialog.showMessageBox(options);
  } catch (err) {
    console.error(`[rosalena] could not show the router warning: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------- app lifecycle

// One copy at a time: a second instance would open a second port and a second window
// onto the same run store, and two windows writing the same chats is a bug.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error(`[rosalena] startup failed: ${err?.stack ?? err}`);
    dialog.showErrorBox(t("Rosalena Harness could not start"), String(err?.stack ?? err));
    app.exit(1);
  });

  // Windows and Linux: closing the last window ends the app, which is what a user who
  // clicked the X expects, and it is what stops a started router with it.
  //
  // macOS: an app with no windows is still running. The Dock icon stays, the app menu
  // still works, and clicking the Dock icon reopens the window through `activate` below.
  // Quitting stays on Cmd+Q (the app menu's Quit role) - a window close that also quit
  // the app would make the red traffic light behave unlike every other Mac app.
  app.on("window-all-closed", () => {
    if (!IS_MAC) app.quit();
  });

  // macOS only, in practice: clicked Dock icon, or "reopen" from Finder, with no window
  // left. The UI server and the router are still running from the first launch, so this
  // re-creates the window onto the same URL rather than rebuilding anything.
  app.on("activate", (_event, hasVisibleWindows) => {
    if (hasVisibleWindows) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return;
    }
    if (!uiUrl) return; // still starting up, or startup failed and already reported
    mainWindow = createWindow();
    void mainWindow.loadURL(uiUrl).catch((err) => {
      console.error(`[rosalena] could not reopen the window: ${err?.message ?? err}`);
    });
  });

  // The port has to be released before the process dies, so quit is deferred by one
  // turn: close the server and the router, save the window state, then quit for real. The
  // second `before-quit` sees `quitting` and lets the exit through.
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    updater.stop();
    void (async () => {
      await writeState();
      // A local model Rosalena loaded stops with the app (unless "Unload when Rosalena
      // closes" is off on the Models page); llama-server runs detached, so nothing else would.
      try {
        await withTimeout(ui?.shutdownLocal?.() ?? Promise.resolve(), 25_000);
      } catch (err) {
        console.warn(`[rosalena] the local model did not unload: ${err?.message ?? err}`);
      }
      await stopUi(ui);
      ui = null;
      // OmniRoute is this app's child: it stops with the app, unless the person turned on
      // "Keep it running after Rosalena closes" in Settings > Cloud models.
      try {
        await withTimeout(omniManager?.shutdown() ?? Promise.resolve(), 12_000);
      } catch (err) {
        console.warn(`[rosalena] OmniRoute did not stop cleanly: ${err?.message ?? err}`);
      }
      // Only a router this process started is stopped. A router that was already running
      // belongs to whoever started it, and killing it would take down their terminal.
      if (router?.spawned) await stopRouter(router);
      router = null;
    })().finally(() => app.quit());
  });
}
