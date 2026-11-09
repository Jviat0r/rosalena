// Sidebar plugins and Creator mode, in the window.
//
// app.js owns chats; this module owns the other thing the sidebar can open: a plugin's
// page. It lists the plugins (GET /api/plugins/ui), opens one in the main area through
// plugin-host.js (the sandboxed frame and the bridge), and gives each one the controls a
// plugin system needs to be safe to use day to day:
//
//   Versions   put back a version Creator mode kept (POST /api/plugins/ui/action rollback)
//   Verify     run the same verifier that gated the install, on what is installed now
//   Switch off the plugin stays installed but is not listed as runnable or served
//   a banner   when the page reports an error while someone is using it, with Roll back
//              and Switch off right there
//
// Creator mode itself is a toggle in the composer: when it is on, the next messages are
// sent with `creator: true`, and the server tells the agent to build through the
// creator_* tools. isCreatorOn() is what app.js reads when it sends.

import { clearPluginTheme, mountPlugin, restorePluginTheme } from "./plugin-host.js";
import { t } from "./i18n.mjs";

const TOKEN = document.querySelector('meta[name="rosalena-token"]')?.content ?? "";
const el = (id) => document.getElementById(id);

let hooks = { toast: () => {}, composeIntoChat: () => {}, newChat: () => {}, onCreatorChange: () => {} };
let plugins = [];
let removed = [];
let current = null;
let handle = null;
let creatorOn = false;

export function isCreatorOn() {
  return creatorOn;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { headers: { "x-rosalena-token": TOKEN } }
    : { method: "POST", headers: { "content-type": "application/json", "x-rosalena-token": TOKEN }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function iconFor(plugin) {
  const span = document.createElement("span");
  span.className = "plugin-icon";
  span.setAttribute("aria-hidden", "true");
  if (plugin.icon) {
    span.classList.add("has-mask");
    span.style.setProperty("--plugin-icon", `url("${plugin.icon}")`);
  } else {
    span.textContent = (plugin.title || plugin.id).slice(0, 1).toUpperCase();
  }
  return span;
}

function paintList() {
  const list = el("apps-list");
  if (!list) return;
  list.replaceChildren();
  list.append(omniRow());
  const visible = plugins.filter((p) => p.ok);
  if (!visible.length) {
    const p = document.createElement("p");
    p.className = "empty side-empty";
    p.textContent = t("No plugins yet. Press Create to make one.");
    list.append(p);
  }
  for (const plugin of visible) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-item plugin-item";
    row.dataset.pluginId = plugin.id;
    row.title = plugin.description || plugin.title;
    if (current?.id === plugin.id) row.classList.add("active");
    if (!plugin.enabled) row.classList.add("is-off");
    const label = document.createElement("span");
    label.className = "plugin-label";
    label.textContent = plugin.title;
    row.append(iconFor(plugin), label);
    if (!plugin.enabled) {
      const off = document.createElement("span");
      off.className = "plugin-badge";
      off.textContent = t("off");
      row.append(off);
    } else if (plugin.source === "user") {
      const mine = document.createElement("span");
      mine.className = "plugin-badge mine";
      mine.textContent = t("yours");
      row.append(mine);
    }
    row.addEventListener("click", () => openPlugin(plugin.id));
    list.append(row);
  }
  for (const gone of removed) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "chat-item plugin-item is-off";
    row.title = t("Removed. Click to put the last version back.");
    const label = document.createElement("span");
    label.className = "plugin-label";
    label.textContent = t("{id} (removed)", { id: gone.id });
    row.append(iconFor({ id: gone.id, title: gone.id }), label);
    row.addEventListener("click", () => void act(gone.id, "rollback", {}, t("Put {id} back", { id: gone.id })));
    list.append(row);
  }
  // The way to every plugin, not just the pages: switches, removal, adding your own.
  const manage = document.createElement("a");
  manage.className = "chat-item plugin-item plugin-manage";
  manage.href = "/plugins";
  manage.title = t("Switch plugins on or off, remove them, or add your own");
  const label = document.createElement("span");
  label.className = "plugin-label";
  label.textContent = t("Manage plugins");
  const gear = document.createElement("span");
  gear.className = "plugin-icon";
  gear.setAttribute("aria-hidden", "true");
  gear.textContent = "⚙";
  manage.append(gear, label);
  list.append(manage);
  const count = el("apps-count");
  if (count) count.textContent = visible.length ? String(visible.length) : "";
}

export async function refreshPlugins() {
  try {
    const data = await api("/api/plugins/ui");
    plugins = data.plugins ?? [];
    removed = data.removed ?? [];
    if (current && !current.builtin) current = plugins.find((p) => p.id === current.id) ?? null;
    paintList();
    if (current) paintHeader();
  } catch (err) {
    const list = el("apps-list");
    if (list) list.textContent = t("Plugins could not be listed: {error}", { error: err.message });
  }
}

function setOpen(open) {
  document.documentElement.toggleAttribute("data-plugin-open", open);
  const view = el("plugin-view");
  if (view) view.hidden = !open;
}

/** The plugin-only controls: shown for a plugin page, hidden for a built-in one. */
function showPluginControls(show) {
  for (const id of ["plugin-verify", "plugin-versions-wrap", "plugin-toggle", "plugin-theme-reset"]) {
    const node = el(id);
    if (node) node.hidden = !show;
  }
  const open = el("plugin-open-external");
  if (open) open.hidden = show;
}

function paintHeader() {
  if (!current) return;
  if (current.builtin) {
    showPluginControls(false);
    el("plugin-title").textContent = current.title;
    el("plugin-meta").textContent = current.meta;
    return;
  }
  showPluginControls(true);
  el("plugin-title").textContent = current.title;
  el("plugin-meta").textContent = [
    `v${current.version}`,
    current.source === "user" ? t("made in Creator mode") : t("ships with Rosalena"),
    current.permissions.length ? t("can {permissions}", { permissions: current.permissionText.join("; ") }) : t("no permissions"),
  ].join(" · ");
  const toggle = el("plugin-toggle");
  toggle.textContent = current.enabled ? t("Switch off") : t("Switch on");
  const versions = el("plugin-versions");
  versions.hidden = !current.history?.length;
  const menu = el("plugin-versions-menu");
  menu.replaceChildren();
  for (const h of current.history ?? []) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "plugin-menu-item";
    item.textContent = t("v{version}  ·  kept {when}", { version: h.version, when: h.keptAt ? new Date(h.keptAt).toLocaleString() : h.stamp });
    item.addEventListener("click", () => {
      menu.hidden = true;
      void act(current.id, "rollback", { to: h.stamp }, t("Roll back to v{version}", { version: h.version }));
    });
    menu.append(item);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "plugin-menu-item danger";
  remove.textContent = t("Remove (kept, can be put back)");
  remove.hidden = current.source !== "user";
  remove.addEventListener("click", () => {
    menu.hidden = true;
    void act(current.id, "remove", {}, t("Remove"));
  });
  menu.append(remove);
  if (current.source === "user") versions.hidden = false;
}

function showBanner(text, { rollback = false } = {}) {
  const banner = el("plugin-banner");
  if (!banner) return;
  el("plugin-banner-text").textContent = text;
  el("plugin-banner-rollback").hidden = !rollback;
  banner.hidden = false;
}

function hideBanner() {
  const banner = el("plugin-banner");
  if (banner) banner.hidden = true;
}

// ------------------------------------------------------------ OmniRoute, built in

/**
 * OmniRoute's dashboard as a page of this window, beside the plugins. It is OmniRoute's own
 * web app, not a plugin: it is framed directly (no sandbox: it needs its own login cookie and
 * scripts), and the desktop app lets exactly this origin be framed, because OmniRoute sends
 * X-Frame-Options: DENY (desktop/main.mjs). In a plain browser that header still wins, so the
 * page says so and offers the browser tab instead. Not running or not installed: the page
 * offers Start or Install, the same actions as Settings > Cloud models.
 */
const OMNI_ID = "builtin:omniroute";
const OMNI_ORIGIN = "http://127.0.0.1:20128";
const OMNI_URL = `${OMNI_ORIGIN}/dashboard`;
const OMNI_PAGE = Object.freeze({
  id: OMNI_ID,
  builtin: true,
  title: "OmniRoute",
  meta: t("Free model gateway on this PC · providers, keys and logs"),
});

function omniRow() {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "chat-item plugin-item";
  row.dataset.pluginId = OMNI_ID;
  row.title = t("OmniRoute's dashboard: connect free providers, see what it routed, read its logs");
  if (current?.id === OMNI_ID) row.classList.add("active");
  const label = document.createElement("span");
  label.className = "plugin-label";
  label.textContent = OMNI_PAGE.title;
  const icon = document.createElement("span");
  icon.className = "plugin-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⇄";
  const badge = document.createElement("span");
  badge.className = "plugin-badge";
  badge.textContent = t("built in");
  row.append(icon, label, badge);
  row.addEventListener("click", () => openOmniRoute());
  return row;
}

export function openOmniRoute() {
  current = OMNI_PAGE;
  setOpen(true);
  paintHeader();
  mountCurrent();
  paintList();
}

function omniNote(stage, text, actions = []) {
  const box = document.createElement("div");
  box.className = "plugin-off omni-note";
  const p = document.createElement("p");
  p.textContent = text;
  box.append(p);
  for (const { label, action, busy } of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini-btn";
    button.textContent = label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = busy;
      try {
        await api("/api/cloud", { action });
      } catch (err) {
        hooks.toast(err.message, "bad");
      }
      if (current?.id === OMNI_ID) mountCurrent();
    });
    box.append(button);
  }
  stage.append(box);
}

async function mountOmniRoute(stage) {
  let omni = null;
  try {
    omni = (await api("/api/cloud")).omniroute ?? null;
  } catch (err) {
    omniNote(stage, t("Could not ask whether OmniRoute is running: {error}", { error: err.message }));
    return;
  }
  if (current?.id !== OMNI_ID) return;
  if (omni?.job?.phase === "installing") {
    omniNote(stage, t("Installing OmniRoute… {line}", { line: omni.job.line ?? "" }).trim());
    setTimeout(() => current?.id === OMNI_ID && mountCurrent(), 3000);
    return;
  }
  if (!omni?.running) {
    if (omni?.installed) {
      omniNote(stage, t("OmniRoute is installed but not running."), [{ label: t("Start OmniRoute"), action: "omniroute-start", busy: t("Starting…") }]);
    } else if (omni?.node) {
      const nodeToo = omni.node === "download" ? ` ${t("Rosalena also fetches its own copy of Node.js for it (about 40 MB), so there is nothing else to install.")}` : "";
      omniNote(stage, t("OmniRoute isn't installed. It is a free gateway that keeps Rosalena answering when the free tier's daily limit runs out. It downloads about 2 GB.{extra}", { extra: nodeToo }), [
        { label: t("Install OmniRoute"), action: "omniroute-install", busy: t("Installing…") },
      ]);
    } else {
      omniNote(stage, t("OmniRoute isn't installed, and it needs Node.js, which Rosalena cannot fetch for this kind of PC. Get the LTS version from nodejs.org, then reopen this page."));
      const link = document.createElement("a");
      link.className = "mini-btn";
      link.href = "https://nodejs.org/en/download";
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = t("Get Node.js ↗");
      stage.lastElementChild?.append(link);
    }
    return;
  }
  if (!window.rosalenaDesktop) {
    omniNote(stage, t("OmniRoute's dashboard can only be shown inside the Rosalena app. In a browser, open it in its own tab with the button above."));
    return;
  }
  const frame = document.createElement("iframe");
  frame.className = "omni-frame";
  frame.title = t("OmniRoute dashboard");
  frame.src = OMNI_URL;
  stage.append(frame);
}

function mountCurrent() {
  handle?.destroy();
  handle = null;
  hideBanner();
  const stage = el("plugin-stage");
  stage.replaceChildren();
  if (current.builtin) {
    void mountOmniRoute(stage);
    return;
  }
  if (!current.enabled) {
    const p = document.createElement("div");
    p.className = "plugin-off";
    p.textContent = t("{name} is switched off. Switch it on to use it.", { name: current.title });
    stage.append(p);
    return;
  }
  let errors = 0;
  handle = mountPlugin({
    container: stage,
    plugin: current,
    onReport: (entry) => {
      errors += 1;
      const first = entry.message.split("\n")[0];
      const said = errors === 1
        ? t("{name} hit a problem: {error}", { name: current.title, error: first })
        : t("{name} hit {n} problems: {error}", { name: current.title, n: errors, error: first });
      showBanner(said, { rollback: Boolean(current.history?.length) });
    },
    compose: (text) => {
      closePlugin();
      hooks.composeIntoChat(text);
    },
    onThemeChange: () => hooks.toast(t("The app's look was changed by a plugin. Style Lab's Default look puts it back."), "ok"),
  });
}

export function openPlugin(id) {
  const plugin = plugins.find((p) => p.id === id);
  if (!plugin) return;
  current = plugin;
  setOpen(true);
  paintHeader();
  mountCurrent();
  paintList();
}

export function closePlugin() {
  handle?.destroy();
  handle = null;
  current = null;
  setOpen(false);
  paintList();
}

async function act(id, action, extra = {}, label = action) {
  try {
    const out = await api("/api/plugins/ui/action", { id, action, ...extra });
    if (action === "verify") {
      hooks.toast(out.ok ? t("{id} passed verification.", { id }) : t("{id} failed verification. Details are in the banner.", { id }), out.ok ? "ok" : "bad");
      if (!out.ok) showBanner(out.text.split("\n").filter((l) => l.includes("FAIL")).slice(0, 3).join(" · ") || t("failed (verification)"), { rollback: Boolean(current?.history?.length) });
      return;
    }
    hooks.toast(t("{action}: done.", { action: label }), "ok");
    await refreshPlugins();
    if (action === "remove") closePlugin();
    else if (current?.id === id) {
      paintHeader();
      mountCurrent();
    } else if (action === "rollback") openPlugin(id);
  } catch (err) {
    hooks.toast(t("{action} failed: {error}", { action: label, error: err.message }), "bad");
  }
}

function paintCreator() {
  const button = el("creator-toggle");
  if (button) button.setAttribute("aria-pressed", String(creatorOn));
  document.documentElement.toggleAttribute("data-creator", creatorOn);
  hooks.onCreatorChange(creatorOn);
}

export function setCreator(on) {
  creatorOn = Boolean(on);
  paintCreator();
}

export function initPlugins(options = {}) {
  hooks = { ...hooks, ...options };
  restorePluginTheme();
  el("creator-toggle")?.addEventListener("click", () => setCreator(!creatorOn));
  el("apps-create")?.addEventListener("click", () => {
    closePlugin();
    hooks.newChat();
    setCreator(true);
    hooks.composeIntoChat("");
  });
  // The Plugins page's "Create with Creator mode" lands here as /?creator=1.
  const url = new URL(location.href);
  if (url.searchParams.get("creator") === "1") {
    url.searchParams.delete("creator");
    history.replaceState(null, "", url);
    setTimeout(() => el("apps-create")?.click(), 0);
  }
  el("plugin-back")?.addEventListener("click", () => closePlugin());
  // Escape goes back to the chat from a plugin page, the same as Back, unless something is
  // open on top of it (a menu, a dialog) or an element is full screen: those close first.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !current || document.fullscreenElement) return;
    const onTop = ["settings-panel", "mcp-panel", "ctx-panel", "account-panel", "page-overlay", "more-drawer", "plugin-versions-menu"].some((id) => {
      const node = document.getElementById(id);
      return node && !node.hidden;
    });
    if (onTop || document.querySelector(".ask-back, .side-menu")) return;
    closePlugin();
    // Capture phase: decided before a menu's own Escape handler closes it, so one press
    // closes the menu OR the page, never both.
  }, true);
  el("plugin-reload")?.addEventListener("click", () => current && mountCurrent());
  el("plugin-open-external")?.addEventListener("click", () => window.open(OMNI_URL, "_blank", "noopener"));
  el("plugin-verify")?.addEventListener("click", () => current && void act(current.id, "verify", {}, t("Verify")));
  el("plugin-toggle")?.addEventListener("click", () => current && void act(current.id, current.enabled ? "disable" : "enable", {}, current.enabled ? t("Switch off") : t("Switch on")));
  el("plugin-versions")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = el("plugin-versions-menu");
    menu.hidden = !menu.hidden;
  });
  document.addEventListener("click", (event) => {
    const menu = el("plugin-versions-menu");
    if (menu && !menu.hidden && !event.target.closest("#plugin-versions-wrap")) menu.hidden = true;
  });
  el("plugin-banner-dismiss")?.addEventListener("click", hideBanner);
  el("plugin-banner-rollback")?.addEventListener("click", () => current && void act(current.id, "rollback", {}, t("Roll back")));
  el("plugin-banner-off")?.addEventListener("click", () => current && void act(current.id, "disable", {}, t("Switch off")));
  el("plugin-theme-reset")?.addEventListener("click", () => {
    clearPluginTheme();
    handle?.sendTheme();
    hooks.toast(t("Back to Rosalena's own look."), "ok");
  });
  // The app's light/dark switch changes the colours a plugin was told about.
  new MutationObserver(() => handle?.sendTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
  window.addEventListener("focus", () => void refreshPlugins());
  setInterval(() => {
    if (document.visibilityState === "visible") void refreshPlugins();
  }, 20_000);
  paintCreator();
  void refreshPlugins();
}
