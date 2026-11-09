// UI styles: a whole setup of the window, switched in one click.
//
// A style is everything that decides how the window feels, in one object:
//
//   layout      the docks and panels (app.js's layout: widths, what is open or a rail)
//   appearance  text size and density (and, for a saved setup, theme and accent too)
//   show        which strips are on (status bar, message details, context meter, ...)
//   look        a visual treatment styles.css cannot express with the switches above:
//               "default", "minimal" (one calm column, soft surfaces, floating composer)
//               or "compact" (tight rows, a loaded sidebar)
//
// Three ship: Default, which is a snapshot of the person's own setup (taken the first time
// this loads, and replaced by "Save current as Default"), Minimal and Compact. Any setup can
// also be saved as a named style of its own. Switching is the View menu, the command
// palette, a click on the status bar's style label, or Ctrl+Alt+1..9.
//
// app.js owns the layout and the account; this module only asks it for a snapshot and
// hands one back, so a style can never hold a field the page does not know how to apply.

import { t } from "./i18n.mjs";

const KEY = "rosalena-ui-styles-v1";
const LOOKS = ["default", "classic", "minimal", "compact"];

const panel = (overrides = {}) => ({ dock: "left", order: 0, size: 0, closed: false, collapsed: false, ...overrides });

export const BUILT_IN = Object.freeze({
  minimal: {
    name: t("Minimal"),
    hint: t("one calm column, nothing extra"),
    look: "minimal",
    layout: {
      preset: "custom",
      docks: { left: { size: 252 }, right: { size: 300 }, bottom: { size: 30 } },
      panels: { sessions: panel(), inspector: panel({ dock: "right", collapsed: true }) },
    },
    appearance: { textSize: "normal", density: "comfortable" },
    show: { statusbar: false, messageMeta: false, contextMeter: true, otherHarnesses: false, inspector: true },
  },
  // The original bordered look, on whatever layout and settings are on screen: it only
  // turns refine.css off, so it is the way back to how the app looked before.
  classic: {
    name: t("Classic"),
    hint: t("the original bordered look"),
    look: "classic",
  },
  compact: {
    name: t("Compact"),
    hint: t("loaded sidebar, tight rows, everything on"),
    look: "compact",
    layout: {
      preset: "custom",
      docks: { left: { size: 360 }, right: { size: 300 }, bottom: { size: 30 } },
      panels: { sessions: panel(), inspector: panel({ dock: "right" }) },
    },
    appearance: { textSize: "small", density: "compact" },
    show: { statusbar: true, messageMeta: true, contextMeter: true, otherHarnesses: true, inspector: true },
  },
});

let hooks = { snapshot: () => null, apply: () => {}, toast: () => {}, repaint: () => {} };
let state = { v: 1, active: "default", applied: null, default: null, custom: [] };

const clone = (value) => JSON.parse(JSON.stringify(value));

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && saved.v === 1) {
      return {
        v: 1,
        active: typeof saved.active === "string" ? saved.active : "default",
        applied: typeof saved.applied === "string" ? saved.applied : null,
        default: saved.default && typeof saved.default === "object" ? saved.default : null,
        custom: Array.isArray(saved.custom) ? saved.custom.filter((s) => s && typeof s.id === "string" && typeof s.name === "string") : [],
      };
    }
  } catch {
    /* unreadable: start over from the current setup */
  }
  return { v: 1, active: "default", applied: null, default: null, custom: [] };
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode: styles last this page */
  }
}

/** Only the parts of a snapshot that decide what is on screen, for "is this still the style?". */
function signature(snap) {
  if (!snap) return "";
  const { layout = {}, appearance = {}, show = {} } = snap;
  return JSON.stringify({ docks: layout.docks, panels: layout.panels, textSize: appearance.textSize, density: appearance.density, show });
}

function lookOf(id) {
  if (id === "default") return state.default?.look ?? "default";
  if (BUILT_IN[id]) return BUILT_IN[id].look;
  return state.custom.find((s) => s.id === id)?.look ?? "default";
}

function paintLook() {
  const look = lookOf(state.active);
  document.documentElement.dataset.uiStyle = LOOKS.includes(look) ? look : "default";
}

/** Every style in menu order: Default, the built-ins, then the person's own. */
export function listStyles() {
  return [
    { id: "default", name: t("Default"), hint: t("your own setup") },
    ...["minimal", "compact", "classic"].map((id) => ({ id, name: BUILT_IN[id].name, hint: BUILT_IN[id].hint })),
    ...state.custom.map((s) => ({ id: s.id, name: s.name, hint: t("saved"), custom: true })),
  ];
}

function styleById(id) {
  if (id === "default") return state.default;
  if (BUILT_IN[id]) return BUILT_IN[id];
  return state.custom.find((s) => s.id === id) ?? null;
}

export function applyStyle(id, { quiet = false } = {}) {
  const style = styleById(id);
  if (!style) return false;
  state.active = id;
  paintLook();
  hooks.apply(clone(style));
  // What the page looks like once the style is on, so a later drag or switch reads as
  // "edited" rather than as the style itself.
  state.applied = signature(hooks.snapshot());
  write();
  hooks.repaint();
  if (!quiet) hooks.toast(t("{name} style", { name: listStyles().find((s) => s.id === id)?.name ?? id }), "ok");
  return true;
}

/** The current setup becomes Default (and the active style). */
export function saveAsDefault() {
  const snap = hooks.snapshot();
  if (!snap) return;
  state.default = { ...snap, look: lookOf(state.active) };
  state.active = "default";
  state.applied = signature(snap);
  write();
  paintLook();
  hooks.repaint();
  hooks.toast(t("This setup is now your Default style."), "ok");
}

/** The current setup becomes a new named style. */
export function saveAsNew() {
  const snap = hooks.snapshot();
  if (!snap) return;
  let n = state.custom.length + 1;
  while (state.custom.some((s) => s.name === `My style ${n}`)) n += 1;
  const style = { id: `custom-${Date.now().toString(36)}`, name: `My style ${n}`, ...snap, look: lookOf(state.active) };
  state.custom.push(style);
  state.active = style.id;
  state.applied = signature(snap);
  write();
  hooks.repaint();
  hooks.toast(t("Saved as \"{name}\". Rename or delete it from the View menu.", { name: style.name }), "ok");
}

export function renameStyle(id, name) {
  const style = state.custom.find((s) => s.id === id);
  const clean = String(name ?? "").trim().slice(0, 32);
  if (!style || !clean) return;
  style.name = clean;
  write();
  hooks.repaint();
}

export function deleteStyle(id) {
  const index = state.custom.findIndex((s) => s.id === id);
  if (index < 0) return;
  const [gone] = state.custom.splice(index, 1);
  if (state.active === id) state.active = "default";
  write();
  paintLook();
  hooks.repaint();
  hooks.toast(t("Deleted \"{name}\".", { name: gone.name }), "ok");
}

/** "Minimal style", or "Minimal · edited" once the person has changed something since. */
export function styleLabel() {
  const name = listStyles().find((s) => s.id === state.active)?.name ?? t("Default");
  const now = signature(hooks.snapshot());
  return state.applied && now && now !== state.applied ? t("{name} · edited", { name }) : t("{name} style", { name });
}

/** The "Styles" block at the top of the View menu. */
export function styleMenuSection(menu, close) {
  const h = document.createElement("h3");
  h.textContent = t("Styles");
  menu.append(h);
  listStyles().forEach((style, index) => {
    const row = document.createElement("div");
    row.className = "view-item ui-style-row";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "view-item ui-style-pick";
    pick.innerHTML = `<span class="tick">${state.active === style.id ? "✓" : ""}</span><span class="ui-style-name"></span><span class="hint"></span>`;
    pick.querySelector(".ui-style-name").textContent = style.name;
    pick.querySelector(".hint").textContent = index < 9 ? `${style.hint} · Ctrl+Alt+${index + 1}` : style.hint;
    pick.addEventListener("click", () => {
      applyStyle(style.id);
      close();
    });
    row.append(pick);
    if (style.custom) {
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "mini-btn ui-style-act";
      rename.textContent = t("Rename");
      rename.addEventListener("click", (event) => {
        event.stopPropagation();
        const input = document.createElement("input");
        input.className = "ui-style-rename";
        input.value = style.name;
        input.maxLength = 32;
        pick.querySelector(".ui-style-name").replaceWith(input);
        input.focus();
        input.select();
        const done = () => {
          renameStyle(style.id, input.value);
          close();
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") done();
          if (e.key === "Escape") close();
        });
        input.addEventListener("blur", done);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "mini-btn ui-style-act";
      del.textContent = t("Delete");
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteStyle(style.id);
        close();
      });
      row.append(rename, del);
    }
    menu.append(row);
  });
  for (const [label, run, hint] of [
    [t("Save current as Default"), saveAsDefault, t("replaces Default")],
    [t("Save current as a new style"), saveAsNew, t("keeps it in this list")],
  ]) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "view-item";
    item.innerHTML = `<span class="tick">＋</span><span></span><span class="hint"></span>`;
    item.children[1].textContent = label;
    item.children[2].textContent = hint;
    item.addEventListener("click", () => {
      run();
      close();
    });
    menu.append(item);
  }
  menu.append(document.createElement("hr"));
}

/** Command palette entries. */
export function styleCommands() {
  return [
    ...listStyles().map((style) => ({ title: t("Style: {name}", { name: style.name }), hint: style.hint, run: () => applyStyle(style.id) })),
    { title: t("Style: save current as Default"), run: saveAsDefault },
    { title: t("Style: save current as a new style"), run: saveAsNew },
  ];
}

/**
 * Start up. The first time this ever runs, the person's current setup is saved as Default,
 * so nothing they arranged is lost by trying Minimal or Compact.
 */
export function initUiStyles(options) {
  hooks = { ...hooks, ...options };
  state = read();
  if (!state.default) {
    const snap = hooks.snapshot();
    if (snap) state.default = { ...snap, look: "default" };
    state.active = "default";
    state.applied = signature(snap);
    write();
  }
  if (!styleById(state.active)) state.active = "default";
  paintLook();
  document.addEventListener("keydown", (event) => {
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
    const n = Number(event.key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const style = listStyles()[n - 1];
    if (!style) return;
    event.preventDefault();
    applyStyle(style.id);
  });
  hooks.repaint();
}
