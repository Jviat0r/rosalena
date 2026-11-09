// Rosalena Harness - the preload bridge.
//
// The window is frameless (see main.mjs), so the window buttons in the page's title
// strip need something to talk to. This file is that something, and the whole of it:
// it exposes exactly the fourteen names the page uses, over `contextBridge`, and nothing
// else. No Node API, no filesystem, no shell, no channel that takes a path - a page
// that only knows these names can minimise, maximise, close, ask about the window,
// lock its size, ask the shell to check for updates, ask it to pick a folder, show a
// notification, or tell it the window's language. That is the entire surface
// between the renderer and the shell.
//
// Deliberately CommonJS (`require`, not `import`): a sandboxed preload runs as
// CommonJS inside Chromium's sandbox, which is the `sandbox: true` main.mjs keeps.
// An ESM preload would require turning that sandbox off, which is not a trade this
// app makes for three window buttons.
//
// In a browser there is no preload and `window.rosalenaDesktop` is simply undefined;
// app.js checks for it and hides the window controls, so the same page runs in a tab
// with its in-page header and no errors.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rosalenaDesktop", {
  // The page uses this only for a `data-platform` attribute; it is not a security
  // boundary, just a fact the CSS may want.
  platform: process.platform,
  // This shell can show the sidebar's Browser tabs (a locked-down <webview>, main.mjs).
  // A plain browser has no such thing and the tab says so instead.
  canBrowse: true,

  minimise: () => ipcRenderer.invoke("rosalena:minimise"),
  maximise: () => ipcRenderer.invoke("rosalena:maximise"),
  close: () => ipcRenderer.invoke("rosalena:close"),
  isMaximised: () => ipcRenderer.invoke("rosalena:is-maximised"),
  getResizable: () => ipcRenderer.invoke("rosalena:get-resizable"),
  setResizable: (value) => ipcRenderer.invoke("rosalena:set-resizable", Boolean(value)),

  // "Check for updates": the shell checks, asks with a native dialog, and on a yes
  // downloads, verifies, installs and reopens. Takes no arguments, so the page cannot
  // choose what gets installed; the feed and its SHA-256 decide that.
  checkForUpdates: () => ipcRenderer.invoke("rosalena:check-updates"),

  // "Choose a folder": the shell shows the OS folder picker and, on a choice, restarts the
  // page's server in that folder. No path goes from the page to the shell.
  pickWorkspace: () => ipcRenderer.invoke("rosalena:pick-workspace"),
  // A folder for the chat on screen: the picker only, nothing restarts.
  // `purpose: "sidebar"` is the + menu's Folder… (its own title, opening at `start`).
  pickFolder: (options) => ipcRenderer.invoke("rosalena:pick-folder", options && typeof options === "object" ? { purpose: String(options.purpose ?? ""), start: String(options.start ?? "") } : {}),

  // A system notification (Settings > Notifications): two strings, clipped by the shell.
  notify: (options) => ipcRenderer.invoke("rosalena:notify", options && typeof options === "object" ? { title: String(options.title ?? ""), body: String(options.body ?? "") } : {}),

  // Settings > Language (harness/ui/i18n.mjs chooseLanguage): "en", "es" or "system". The
  // shell redraws its menus and dialogs in it; the page reloads itself.
  setLanguage: (code) => ipcRenderer.invoke("rosalena:set-language", String(code ?? "")),

  // `onMaximised` returns its own unsubscribe: a reload would otherwise leave a
  // listener holding a document that no longer exists.
  onMaximised: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(Boolean(value));
    ipcRenderer.on("rosalena:maximised", listener);
    return () => ipcRenderer.removeListener("rosalena:maximised", listener);
  },
});
