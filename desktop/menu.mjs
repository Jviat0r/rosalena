// Rosalena Harness - the application menu, as data.
//
// A plain function returning an Electron menu template, with no `electron` import, for
// two reasons: the template can be verified by plain `node` (it is the kind of thing that
// otherwise only fails on the one platform nobody here can start), and every role the app
// relies on is visible in one place instead of being mixed into the window code.
//
// Why a menu at all on a window that draws its own chrome:
//
//   * macOS does not deliver Cmd+C / Cmd+V / Cmd+A to a text field unless a menu item
//     with the matching ROLE exists. Without an Edit menu the composer cannot copy or
//     paste on a Mac at all - it is not a nicety, it is broken input.
//   * macOS quits with Cmd+Q and offers Hide / Services / About only through the
//     application menu, which is owned by the app, not by the window.
//   * Reload, DevTools, zoom and fullscreen have to be reachable when there is no
//     browser toolbar around the page.
//
// Roles used here and nowhere else in the app: services, hide, hideOthers, unhide, quit,
// close, undo, redo, cut, copy, paste, pasteAndMatchStyle, delete, selectAll, reload,
// forceReload, toggleDevTools, resetZoom, zoomIn, zoomOut, togglefullscreen, minimize,
// zoom, front. Electron supplies the labels, accelerators and platform behaviour for
// each; only the app menu entries are labelled by hand, because they carry the product
// name.
//
// On Windows the menu is hidden by default (`autoHideMenuBar` in main.mjs) and appears on
// Alt, exactly as before - but the Edit roles are there, and they cost nothing.
//
// Languages: `t` is the shell's translator (harness/ui/i18n.mjs `translator`, chosen by
// main.mjs from the window's language setting). Electron labels role items in the OS
// language, not the app's, so in any language but English each role item gets its label
// from `roleLabels`; in English the role items stay bare and Electron labels them as before.

/** `t` when none is given: the English key with its {placeholders} filled in. */
const plainText = (key, vars) => (vars ? String(key).replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole)) : key);

/** The label of every role the shell uses (this menu and main.mjs's right-click menus), in `t`'s language. */
export function roleLabels(t = plainText) {
  return {
    services: t("Services"),
    hideOthers: t("Hide Others"),
    unhide: t("Show All"),
    undo: t("Undo"),
    redo: t("Redo"),
    cut: t("Cut"),
    copy: t("Copy"),
    paste: t("Paste"),
    pasteAndMatchStyle: t("Paste and Match Style"),
    delete: t("Delete"),
    selectAll: t("Select All"),
    reload: t("Reload"),
    forceReload: t("Force Reload"),
    toggleDevTools: t("Toggle Developer Tools"),
    resetZoom: t("Actual Size"),
    zoomIn: t("Zoom In"),
    zoomOut: t("Zoom Out"),
    togglefullscreen: t("Toggle Full Screen"),
    minimize: t("Minimize"),
    zoom: t("Zoom"),
    front: t("Bring All to Front"),
  };
}

/**
 * A role item: bare in English (Electron's own label), labelled in any other language.
 * `extra` keeps its own label when it has one.
 */
export function roleItemFor(language = "en", t = plainText) {
  const labels = language === "en" ? null : roleLabels(t);
  return (role, extra = {}) => (labels && !("label" in extra) ? { role, label: labels[role], ...extra } : { role, ...extra });
}

/**
 * @param {{
 *   platform?: string,
 *   appName: string,
 *   actions: { about(): void, checkForUpdates(): void, pickWorkspace(): void, openInBrowser(): void, openDataFolder(): void },
 *   t?: (key: string, vars?: Record<string, unknown>) => string,
 *   language?: string,
 * }} options
 * @returns {Array<Record<string, unknown>>} an Electron menu template
 */
export function buildMenuTemplate({ platform = process.platform, appName = "Rosalena Harness", actions = {}, t = plainText, language = "en" }) {
  const isMac = platform === "darwin";
  const click = (name) => () => {
    const action = actions?.[name];
    if (typeof action === "function") action();
  };
  const item = roleItemFor(language, t);
  const template = [];

  // The application menu exists on macOS only: on Windows a menu called "Rosalena
  // Harness" between File and Help would be a second Help menu.
  if (isMac) {
    template.push({
      label: appName,
      submenu: [
        // Our own dialog rather than role "about": the useful facts are the router
        // address and the data folder, which Electron's default panel does not know.
        { label: t("About {appName}", { appName }), click: click("about") },
        { label: t("Check for Updates…"), click: click("checkForUpdates") },
        { type: "separator" },
        item("services"),
        { type: "separator" },
        item("hide", { label: t("Hide {appName}", { appName }) }),
        item("hideOthers"),
        item("unhide"),
        { type: "separator" },
        item("quit", { label: t("Quit {appName}", { appName }) }),
      ],
    });
  }

  template.push({
    label: t("File"),
    submenu: [
      { label: t("Open folder…"), accelerator: "CmdOrCtrl+O", click: click("pickWorkspace") },
      { label: t("Open in browser"), accelerator: "CmdOrCtrl+Shift+O", click: click("openInBrowser") },
      { type: "separator" },
      // macOS closes the window and stays running; Windows and Linux quit with it.
      isMac ? item("close", { label: t("Close Window") }) : item("quit", { label: t("Quit"), accelerator: "CmdOrCtrl+Q" }),
    ],
  });

  template.push({
    label: t("Edit"),
    submenu: [
      item("undo"),
      item("redo"),
      { type: "separator" },
      item("cut"),
      item("copy"),
      item("paste"),
      // The two that only macOS offers in its own menus; harmless elsewhere but not
      // invented there, because Windows has no equivalent command.
      ...(isMac ? [item("pasteAndMatchStyle"), item("delete")] : []),
      item("selectAll"),
    ],
  });

  template.push({
    label: t("View"),
    submenu: [
      item("reload"),
      item("forceReload"),
      item("toggleDevTools"),
      { type: "separator" },
      item("resetZoom"),
      item("zoomIn"),
      item("zoomOut"),
      { type: "separator" },
      item("togglefullscreen"),
    ],
  });

  if (isMac) {
    template.push({
      label: t("Window"),
      submenu: [item("minimize"), item("zoom"), { type: "separator" }, item("front")],
    });
  }

  template.push({
    label: t("Help"),
    submenu: [
      { label: t("Rosalena on disk"), click: click("openDataFolder") },
      ...(isMac
        ? []
        : [
            { type: "separator" },
            { label: t("Check for updates…"), click: click("checkForUpdates") },
            { label: t("About {appName}", { appName }), click: click("about") },
          ]),
    ],
  });

  return template;
}
