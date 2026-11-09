// Style Lab: repaint the whole Rosalena app from a grid of skins, or build your own.
//
// Everything the buttons do goes through the functions below (applySkin, resetLook,
// saveEditorSkin, exportSkin, importFromText, deleteCustom), and the self-tests at the
// bottom drive those same functions and the same buttons.

import { SKINS, DEFAULT_DARK, DEFAULT_LIGHT, SANS_STACKS, MONO_STACKS } from "./skins.js";
import * as L from "./lib.js";

const $ = (sel, root = document) => root.querySelector(sel);

// ------------------------------------------------------------------- helpers

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v; // only static markup written in this file
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const svg = (body, size = 14) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  check: svg('<path d="M5 12.5l4.2 4.2L19 7"/>', 12),
  pass: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16 9.6"/>', 15),
  fail: svg('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>', 15),
  remix: svg('<path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20z"/><path d="M13.5 7.5l3 3"/>', 13),
  export: svg('<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>', 13),
  trash: svg('<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 12h8l1-12"/>', 13),
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6"/><path d="M6.5 11.5L12 6l5.5 5.5"/></svg>',
};

const MOCK_HTML = `
  <span class="m-side">
    <span class="m-brand"><span class="m-dot"></span>Rosalena</span>
    <span class="m-item on">Login bug</span>
    <span class="m-item">Router</span>
    <span class="m-item">Notes</span>
    <span class="m-item m-extra">Plugin ideas</span>
  </span>
  <span class="m-main">
    <span class="m-top"><span>Login bug</span><span class="m-live"></span></span>
    <span class="m-chat">
      <span class="m-bubble m-user">Why does login fail?</span>
      <span class="m-bubble m-bot">Token expired. Run <span class="m-code">npm test</span></span>
      <span class="m-bubble m-bot m-extra">Patched <span class="m-code">auth.ts</span>: tokens now refresh 60 s before they expire.</span>
      <span class="m-status"><i class="ok"></i><i class="warn"></i><i class="bad"></i><span class="lbl">3 checks</span></span>
    </span>
    <span class="m-composer"><span>Ask Rosalena...</span><span class="m-send">${ICON.send}</span></span>
  </span>`;

function mock(tokens, large = false) {
  const node = h("span", { class: large ? "mock mock-lg" : "mock", "aria-hidden": "true", html: MOCK_HTML });
  paintMock(node, tokens);
  return node;
}

function paintMock(node, tokens) {
  for (const t of L.ALL_TOKENS) if (tokens[t]) node.style.setProperty(`--m-${t}`, tokens[t]);
}

const sameTokens = (a, b) => L.ALL_TOKENS.every((t) => a?.[t] === b?.[t]);
const fmt = (ratio) => (ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1));

// --------------------------------------------------------------------- state

const state = {
  active: null, // the skin id Style Lab last applied (or "draft"), null on the default look
  activeName: null,
  custom: [], // [{ id, name, tokens, custom: true }]
  mode: "dark",
  pluginTheme: null,
  editor: { id: null, name: "My skin", tokens: { ...SKINS[1].tokens }, base: SKINS[1].id },
};

let lastAction = Promise.resolve();
/** Run a button's work: errors become a sentence in the status line, never a dead button. */
function run(work) {
  lastAction = (async () => {
    try {
      return await work();
    } catch (err) {
      setStatus(String(err?.message || err), "err");
      return { error: String(err?.message || err) };
    }
  })();
  return lastAction;
}

const defaultSkin = () => ({
  id: "default",
  name: "Default look",
  tagline: state.mode === "light" ? "Rosalena's own ivory and teal. Turns skins off." : "Rosalena's own petrol teal. Turns skins off.",
  tokens: state.mode === "light" ? DEFAULT_LIGHT : DEFAULT_DARK,
  isDefault: true,
});
const findSkin = (id) => (id === "default" ? defaultSkin() : [...SKINS, ...state.custom].find((s) => s.id === id) || null);

function setStatus(text, kind = "ok") {
  const box = $("#status");
  box.textContent = text;
  box.className = `status ${kind}`;
  void box.offsetWidth;
  box.classList.add("flash");
}

// ----------------------------------------------------------- applying skins

async function applyTokens(tokens, name, id) {
  const checked = L.checkTokens(tokens, { requireAll: true });
  if (!checked.ok) throw new Error(`${name} can't be applied: ${checked.errors[0]}.`);
  const report = L.contrastReport(checked.tokens);
  if (report.textMin < 3) {
    throw new Error(`${name} was not applied: its text contrast is ${report.textMin.toFixed(1)}:1, which would make the app hard to read. Raise it to at least 3:1 (4.5:1 is the goal).`);
  }
  const result = await Rosalena.theme.set(checked.tokens);
  state.active = id;
  state.activeName = name;
  await Rosalena.storage.set("active", { id, name });
  renderActive();
  setStatus(`${name} is on. It stays after a restart; Default look turns it off.`, "ok");
  await refreshThemeInfo();
  return result;
}

async function applySkin(id) {
  const skin = findSkin(id);
  if (!skin) throw new Error(`There is no skin called "${id}".`);
  if (skin.isDefault) return resetLook();
  return applyTokens(skin.tokens, skin.name, skin.id);
}

async function resetLook() {
  await Rosalena.theme.reset();
  const was = state.activeName;
  state.active = null;
  state.activeName = null;
  await Rosalena.storage.remove("active");
  renderActive();
  setStatus(was ? `${was} is off. Rosalena is back to its default look.` : "Rosalena is on its default look.", "ok");
  await refreshThemeInfo();
  return true;
}

/** A card click: the skin that is on (or the Default look card) resets, any other applies. */
function onSkinClick(id) {
  return run(() => (id === "default" || id === state.active ? resetLook() : applySkin(id)));
}

async function refreshThemeInfo() {
  let info = null;
  try {
    info = await Rosalena.theme.get();
  } catch (err) {
    $("#theme-pill-text").textContent = "Theme status unavailable";
    return null;
  }
  state.pluginTheme = info?.pluginTheme ?? null;
  if ((info?.mode === "light" || info?.mode === "dark") && info.mode !== state.mode) {
    state.mode = info.mode;
    renderBuiltinGrid();
  }
  renderPill();
  return info;
}

let themeInfoTimer = 0;
const scheduleThemeInfo = () => {
  clearTimeout(themeInfoTimer);
  themeInfoTimer = setTimeout(() => refreshThemeInfo(), 150);
};

function renderPill() {
  const pill = $("#theme-pill");
  const text = $("#theme-pill-text");
  const me = Rosalena.host?.id || "rosa-style-lab";
  pill.classList.remove("is-on", "is-other");
  text.textContent = "";
  if (state.pluginTheme === me || (state.pluginTheme == null && state.active && Rosalena.host?.verifying)) {
    pill.classList.add("is-on");
    text.append("Plugin theme: ", h("strong", { text: "Style Lab" }), ` · ${state.activeName || "a skin"}`, Rosalena.host?.verifying && state.pluginTheme == null ? " (test run)" : "");
  } else if (state.pluginTheme) {
    pill.classList.add("is-other");
    text.append("Plugin theme: ", h("strong", { text: state.pluginTheme }), " (another plugin)");
  } else {
    text.append("Plugin theme: ", h("strong", { text: "none" }), " · default look");
  }
}

// --------------------------------------------------------------- the cards

function skinCard(skin) {
  const report = L.contrastReport(skin.tokens);
  const g = L.grade(report.textMin);
  const detail = report.pairs.map((p) => `${p.label}: ${p.ratio.toFixed(2)}:1 (needs ${p.min}:1)`).join("\n");
  const card = h("article", { class: "card", dataset: { id: skin.id } });
  const main = h(
    "button",
    {
      class: "card-main",
      type: "button",
      "aria-pressed": "false",
      title: skin.isDefault ? "Turn skins off" : `Apply ${skin.name} (click again to turn it off)`,
      onclick: () => onSkinClick(skin.id),
    },
    mock(skin.tokens),
    h(
      "span",
      { class: "card-meta" },
      h("span", { class: "card-name", text: skin.name }),
      h("span", { class: `badge badge-${g.toLowerCase()}`, title: detail, "aria-label": `Text contrast ${fmt(report.textMin)} to 1, ${g}`, text: `${g} ${fmt(report.textMin)}:1` }),
    ),
    h("span", { class: "card-tag", text: skin.tagline || (skin.custom ? "Your skin." : "") }),
  );
  const chip = h("span", { class: "active-chip", html: `${ICON.check}On` });
  const actions = h(
    "div",
    { class: "card-actions" },
    h("button", { class: "mini", type: "button", title: `Open ${skin.name} in the editor`, html: `${ICON.remix}${skin.custom ? "Edit" : "Remix"}`, onclick: () => remix(skin.id) }),
    h("button", { class: "mini", type: "button", title: `Save ${skin.name} as a JSON file`, html: `${ICON.export}Export`, onclick: () => run(() => exportSkin(skin)) }),
    skin.custom ? deleteButton(skin) : null,
  );
  card.append(main, chip, actions);
  return card;
}

function deleteButton(skin) {
  let timer = 0;
  const btn = h("button", { class: "mini del", type: "button", title: `Delete ${skin.name}`, html: `${ICON.trash}Delete` });
  const disarm = () => {
    btn.dataset.armed = "0";
    btn.innerHTML = `${ICON.trash}Delete`;
  };
  btn.addEventListener("click", () => {
    if (btn.dataset.armed === "1") {
      clearTimeout(timer);
      run(() => deleteCustom(skin.id));
      return;
    }
    btn.dataset.armed = "1";
    btn.innerHTML = `${ICON.trash}Sure?`;
    timer = setTimeout(disarm, 3500);
  });
  btn.addEventListener("blur", () => setTimeout(() => btn.isConnected && btn.dataset.armed === "1" && disarm(), 200));
  return btn;
}

function renderBuiltinGrid() {
  const grid = $("#skin-grid");
  grid.replaceChildren(skinCard(defaultSkin()), ...SKINS.map(skinCard));
  $("#skin-count").textContent = `${SKINS.length} built in · click one to apply it`;
  renderActive();
}

function renderCustomGrid() {
  const grid = $("#custom-grid");
  grid.replaceChildren(...state.custom.map(skinCard));
  $("#custom-empty").hidden = state.custom.length > 0;
  $("#custom-count").textContent = state.custom.length ? `${state.custom.length} saved` : "";
  renderBaseOptions();
  renderActive();
}

function renderActive() {
  for (const card of document.querySelectorAll(".card")) {
    const on = card.dataset.id === (state.active ?? "default");
    card.classList.toggle("is-active", on);
    card.querySelector(".card-main")?.setAttribute("aria-pressed", String(on));
  }
  renderPill();
}

// ---------------------------------------------------------- custom skins

async function loadCustom() {
  const raw = await Rosalena.storage.get("custom");
  const list = Array.isArray(raw) ? raw : [];
  state.custom = list
    .filter((s) => s && typeof s.id === "string" && L.checkTokens(s.tokens, { requireAll: true }).ok)
    .map((s) => ({ id: s.id, name: L.cleanName(s.name), tokens: L.checkTokens(s.tokens).tokens, custom: true }));
  return state.custom;
}

const saveCustomList = () => Rosalena.storage.set("custom", state.custom.map(({ id, name, tokens }) => ({ id, name, tokens })));
const newId = (name) => `custom-${L.slug(name)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

async function saveEditorSkin() {
  const ed = state.editor;
  const checked = L.checkTokens(ed.tokens, { requireAll: true });
  if (!checked.ok) throw new Error(`This skin can't be saved yet: ${checked.errors[0]}.`);
  const name = L.cleanName(ed.name, "My skin");
  let skin = ed.id ? state.custom.find((s) => s.id === ed.id) : null;
  if (skin) {
    skin.name = name;
    skin.tokens = { ...checked.tokens };
  } else {
    skin = { id: newId(name), name, tokens: { ...checked.tokens }, custom: true };
    state.custom.push(skin);
    ed.id = skin.id;
  }
  ed.name = name;
  await saveCustomList();
  renderCustomGrid();
  updateEditorHeader();
  scheduleDraft();
  if (state.active === skin.id) await applyTokens(skin.tokens, skin.name, skin.id);
  setStatus(`Saved "${name}" under Your skins. Click its card to apply it.`, "ok");
  return skin;
}

async function deleteCustom(id) {
  const skin = state.custom.find((s) => s.id === id);
  if (!skin) return false;
  state.custom = state.custom.filter((s) => s.id !== id);
  await saveCustomList();
  if (state.editor.id === id) {
    state.editor.id = null;
    updateEditorHeader();
    scheduleDraft();
  }
  const wasOn = state.active === id;
  if (wasOn) await resetLook();
  renderCustomGrid();
  setStatus(wasOn ? `Deleted "${skin.name}". It was on, so Rosalena is back to its default look.` : `Deleted "${skin.name}".`, "ok");
  return true;
}

// ------------------------------------------------------- export and import

async function exportSkin(skin) {
  const text = L.skinToJson(skin);
  const fileName = `${L.slug(skin.name)}.rosalena-skin.json`;
  const result = await Rosalena.files.save(fileName, text, "application/json");
  setStatus(result?.verifying ? `Exported "${skin.name}" as ${fileName} (test run, nothing downloaded).` : `Exported "${skin.name}" as ${fileName}.`, "ok");
  return { text, fileName, result };
}

function showImportError(message) {
  const box = $("#import-error");
  box.textContent = message;
  box.hidden = false;
}
const clearImportError = () => {
  $("#import-error").hidden = true;
  $("#import-error").textContent = "";
};

async function importFromText(text, fileName = "") {
  const parsed = L.parseSkinFile(text, { fileName });
  if (!parsed.ok) {
    showImportError(parsed.error);
    setStatus(`${fileName ? `"${fileName}"` : "That skin file"} was not imported.`, "err");
    return parsed;
  }
  clearImportError();
  let name = parsed.skin.name;
  if (SKINS.some((s) => s.name.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === "default look") name = L.cleanName(`${name} (imported)`);
  let skin = state.custom.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (skin) skin.tokens = { ...parsed.skin.tokens };
  else {
    skin = { id: newId(name), name, tokens: { ...parsed.skin.tokens }, custom: true };
    state.custom.push(skin);
  }
  await saveCustomList();
  renderCustomGrid();
  loadIntoEditor(skin);
  const notes = [];
  if (parsed.filled.length) notes.push(`filled ${parsed.filled.length} missing token${parsed.filled.length === 1 ? "" : "s"} from the default look`);
  if (parsed.warnings.length) notes.push(`heads up: ${parsed.warnings[0]}`);
  setStatus(`Imported "${name}" into Your skins${notes.length ? ` (${notes.join("; ")})` : ""}.`, parsed.warnings.length ? "warn" : "ok");
  return { ok: true, skin, filled: parsed.filled, warnings: parsed.warnings };
}

async function importFile(file) {
  if (!file) return null;
  if (file.size > L.FILE_LIMIT) {
    const error = `"${file.name}" is ${Math.round(file.size / 1024)} KB; a skin file is a few hundred bytes (the limit is 64 KB).`;
    showImportError(error);
    setStatus(`"${file.name}" was not imported.`, "err");
    return { ok: false, error };
  }
  return importFromText(await file.text(), file.name);
}

// --------------------------------------------------------------- the editor

const editorUi = { swatches: {}, texts: {}, previewMock: null };

function buildEditor() {
  const colors = $("#ed-colors");
  for (const t of L.COLOR_TOKENS) {
    const swatchId = `ed-c-${t}`;
    const swatch = h("input", { type: "color", id: swatchId, title: `Pick ${L.TOKEN_LABELS[t].toLowerCase()}` });
    const text = h("input", { type: "text", spellcheck: "false", autocomplete: "off", "aria-label": `${L.TOKEN_LABELS[t]} value`, dataset: { token: t } });
    swatch.addEventListener("input", () => setEditorToken(t, swatch.value));
    text.addEventListener("input", () => {
      const value = text.value.trim();
      const c = L.checkTokens({ [t]: value });
      text.setAttribute("aria-invalid", String(!c.ok));
      text.title = c.ok ? "" : c.errors[0];
      if (c.ok) setEditorToken(t, value, { fromText: true });
    });
    text.addEventListener("change", () => {
      if (text.getAttribute("aria-invalid") === "true") {
        text.value = state.editor.tokens[t];
        text.setAttribute("aria-invalid", "false");
        text.title = "";
      }
    });
    editorUi.swatches[t] = swatch;
    editorUi.texts[t] = text;
    colors.append(h("div", { class: "color-row" }, swatch, h("label", { for: swatchId }, L.TOKEN_LABELS[t], h("small", { text: `--${t}` })), text));
  }

  $("#ed-name").addEventListener("input", (e) => {
    state.editor.name = e.target.value;
    updateEditorHeader();
    scheduleDraft();
  });
  $("#ed-base").addEventListener("change", (e) => {
    const skin = findSkin(e.target.value);
    if (skin) loadIntoEditor(skin, { remix: !skin.custom });
  });
  $("#ed-radius").addEventListener("input", (e) => {
    const r = Number(e.target.value);
    state.editor.tokens.radius = `${r}px`;
    state.editor.tokens["radius-sm"] = `${Math.round(r * 0.7)}px`;
    state.editor.tokens["radius-xs"] = `${Math.round(r * 0.42)}px`;
    $("#ed-radius-out").textContent = `${r}px`;
    editorChanged();
  });
  $("#ed-sans").addEventListener("change", (e) => setEditorToken("sans", e.target.value));
  $("#ed-mono").addEventListener("change", (e) => setEditorToken("mono", e.target.value));

  editorUi.previewMock = mock(state.editor.tokens, true);
  $("#ed-mock-slot").append(editorUi.previewMock);

  $("#ed-try").addEventListener("click", () => run(() => applyTokens(state.editor.tokens, L.cleanName(state.editor.name, "My skin"), state.editor.id || "draft")));
  $("#ed-save").addEventListener("click", () => run(saveEditorSkin));
  $("#ed-export").addEventListener("click", () => run(() => exportSkin({ name: L.cleanName(state.editor.name, "My skin"), tokens: state.editor.tokens })));
  $("#ed-import-btn").addEventListener("click", () => $("#ed-import").click());
  $("#ed-import").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    run(async () => {
      try {
        return await importFile(file);
      } finally {
        e.target.value = "";
      }
    });
  });

  const drop = $("#ed-drop");
  drop.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    drop.classList.add("drop");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("drop"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drop");
    const file = e.dataTransfer?.files?.[0];
    if (file) run(() => importFile(file));
  });
}

function fillFontSelect(select, stacks, current) {
  const options = stacks.map((s) => h("option", { value: s.value, text: s.label }));
  if (!stacks.some((s) => s.value === current)) options.unshift(h("option", { value: current, text: "This skin's own font" }));
  select.replaceChildren(...options);
  select.value = current;
  for (const o of select.options) o.style.fontFamily = o.value;
}

function renderBaseOptions() {
  const select = $("#ed-base");
  const groups = [
    h("optgroup", { label: "Built in" }, h("option", { value: "default", text: "Default look" }), ...SKINS.map((s) => h("option", { value: s.id, text: s.name }))),
  ];
  if (state.custom.length) groups.push(h("optgroup", { label: "Your skins" }, ...state.custom.map((s) => h("option", { value: s.id, text: s.name }))));
  select.replaceChildren(...groups);
  const want = state.editor.id || state.editor.base;
  select.value = findSkin(want) ? want : "";
}

/** Put a skin into the editor. A built-in skin becomes a new, unsaved remix. */
function loadIntoEditor(skin, { remix = !skin.custom } = {}) {
  state.editor = {
    id: skin.custom && !remix ? skin.id : null,
    name: remix ? L.cleanName(skin.isDefault ? "My skin" : `${skin.name} remix`) : skin.name,
    tokens: { ...skin.tokens },
    base: skin.id,
  };
  syncEditorControls();
  scheduleDraft();
}

function remix(id) {
  const skin = findSkin(id);
  if (!skin) return;
  loadIntoEditor(skin, { remix: !skin.custom });
  $("#editor-section").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#ed-name").focus({ preventScroll: true });
  setStatus(skin.custom ? `Editing "${skin.name}". Save skin keeps your changes.` : `Remixing ${skin.name}. Change anything, then Save skin.`, "ok");
}

function syncEditorControls() {
  const ed = state.editor;
  $("#ed-name").value = ed.name;
  for (const t of L.COLOR_TOKENS) {
    editorUi.swatches[t].value = L.hexOf(ed.tokens[t]);
    editorUi.texts[t].value = ed.tokens[t];
    editorUi.texts[t].setAttribute("aria-invalid", "false");
  }
  const r = Math.min(32, Math.round(parseFloat(ed.tokens.radius) || 0));
  $("#ed-radius").value = String(r);
  $("#ed-radius-out").textContent = ed.tokens.radius;
  fillFontSelect($("#ed-sans"), SANS_STACKS, ed.tokens.sans);
  fillFontSelect($("#ed-mono"), MONO_STACKS, ed.tokens.mono);
  renderBaseOptions();
  editorChanged({ save: false });
}

function setEditorToken(token, value, { fromText = false } = {}) {
  state.editor.tokens[token] = value;
  if (L.COLOR_TOKENS.includes(token)) {
    editorUi.swatches[token].value = L.hexOf(value);
    if (!fromText) {
      editorUi.texts[token].value = value;
      editorUi.texts[token].setAttribute("aria-invalid", "false");
    }
  }
  editorChanged();
}

function editorChanged({ save = true } = {}) {
  const tokens = state.editor.tokens;
  paintMock(editorUi.previewMock, tokens);
  const report = L.contrastReport(tokens);
  const g = L.grade(report.textMin);
  const badge = $("#ed-badge");
  badge.className = `badge badge-${g.toLowerCase()}`;
  badge.textContent = `${g} ${fmt(report.textMin)}:1`;
  $("#ed-contrast").replaceChildren(
    ...report.pairs.map((p) =>
      h(
        "li",
        { class: p.pass ? "pass" : "fail", title: `${p.label}: ${p.ratio.toFixed(2)}:1, needs ${p.min}:1` },
        h("span", { html: p.pass ? ICON.pass : ICON.fail }),
        h("span", { class: "lbl", text: p.label }),
        h("span", { class: "ratio", text: `${p.ratio.toFixed(1)}:1` }),
      ),
    ),
  );
  updateEditorHeader();
  if (save) scheduleDraft();
}

function updateEditorHeader() {
  const ed = state.editor;
  const saved = ed.id ? state.custom.find((s) => s.id === ed.id) : null;
  $("#ed-state").textContent = saved ? (sameTokens(saved.tokens, ed.tokens) && saved.name === L.cleanName(ed.name) ? `editing "${saved.name}" · saved` : `editing "${saved.name}" · unsaved changes`) : "new skin · not saved yet";
}

let draftTimer = 0;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    Rosalena.storage.set("draft", { id: state.editor.id, name: state.editor.name, tokens: state.editor.tokens, base: state.editor.base }).catch(() => {});
  }, 400);
}

// ------------------------------------------------------------ host theme

function applyChrome(theme) {
  if (!theme || typeof theme !== "object") return;
  const root = document.documentElement;
  const colors = theme.colors || {};
  for (const [name, value] of Object.entries(colors)) {
    const v = String(value || "").trim();
    if (v && L.COLOR.test(v) && L.parseColor(v)) root.style.setProperty(`--${name}`, v);
  }
  if (colors.accent && L.parseColor(colors.accent)) root.style.setProperty("--btn-ink", L.inkFor(colors.accent));
  if (theme.sans && L.FONT.test(theme.sans)) root.style.setProperty("--sans", theme.sans);
  if (theme.mono && L.FONT.test(theme.mono)) root.style.setProperty("--mono", theme.mono);
  const light = colors.bg && L.parseColor(colors.bg) ? L.isLight({ bg: colors.bg }) : theme.mode === "light";
  root.dataset.mode = light ? "light" : "dark";
  if ((theme.mode === "light" || theme.mode === "dark") && theme.mode !== state.mode) {
    state.mode = theme.mode;
    if ($("#skin-grid").childElementCount) renderBuiltinGrid();
  }
  scheduleThemeInfo();
}

Rosalena.on("theme", applyChrome);

// ------------------------------------------------------------------ start

function firstRender() {
  buildEditor();
  renderBuiltinGrid();
  renderCustomGrid();
  syncEditorControls();
  $("#default-look").addEventListener("click", () => run(resetLook));
  setStatus("Pick a skin to repaint Rosalena.", "info");
}

async function load() {
  const [custom, saved, draft] = await Promise.all([loadCustom(), Rosalena.storage.get("active"), Rosalena.storage.get("draft")]);
  void custom;
  const info = await refreshThemeInfo();
  const me = Rosalena.host?.id || "rosa-style-lab";
  if (saved && typeof saved.id === "string" && (info?.pluginTheme === me || Rosalena.host?.verifying)) {
    state.active = saved.id;
    state.activeName = typeof saved.name === "string" ? saved.name : findSkin(saved.id)?.name ?? null;
  } else if (saved) {
    await Rosalena.storage.remove("active");
  }
  if (draft && typeof draft === "object" && L.checkTokens(draft.tokens, { requireAll: true }).ok) {
    state.editor = {
      id: draft.id && state.custom.some((s) => s.id === draft.id) ? draft.id : null,
      name: L.cleanName(draft.name, "My skin"),
      tokens: L.checkTokens(draft.tokens).tokens,
      base: typeof draft.base === "string" ? draft.base : null,
    };
  }
  renderCustomGrid();
  syncEditorControls();
  renderActive();
  if (state.active && state.activeName) setStatus(`${state.activeName} is on. Click it again, or Default look, to turn it off.`, "ok");
}

firstRender();
Rosalena.ready();
const booted = load().catch((err) => setStatus(`Could not load your saved skins: ${err?.message || err}`, "err"));

// -------------------------------------------------------------- self-tests

const card = (id) => document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);

Rosalena.test("every built-in skin follows the app's token rules", async () => {
  await booted;
  Rosalena.assert(SKINS.length >= 8, `expected at least 8 skins, found ${SKINS.length}`);
  Rosalena.assert(new Set(SKINS.map((s) => s.id)).size === SKINS.length, "skin ids must be unique");
  for (const skin of [...SKINS, { id: "default-dark", tokens: DEFAULT_DARK }, { id: "default-light", tokens: DEFAULT_LIGHT }]) {
    Rosalena.assert(Object.keys(skin.tokens).length === L.ALL_TOKENS.length, `${skin.id} sets ${Object.keys(skin.tokens).length} tokens, not all ${L.ALL_TOKENS.length}`);
    for (const [name, value] of Object.entries(skin.tokens)) {
      const rule = L.THEME_TOKENS[name];
      Rosalena.assert(rule, `${skin.id}: "${name}" is not an app token`);
      Rosalena.assert(rule.test(value.trim()), `${skin.id}: ${name} = "${value}" fails the app's pattern`);
    }
    const c = L.checkTokens(skin.tokens, { requireAll: true });
    Rosalena.assert(c.ok, `${skin.id}: ${c.errors.join("; ")}`);
  }
  for (const s of [...SANS_STACKS, ...MONO_STACKS]) Rosalena.assert(L.FONT.test(s.value), `font stack "${s.label}" fails the font rule`);
});

Rosalena.test("every built-in skin has WCAG contrast of 4.5:1 or more and shows its badge", async () => {
  await booted;
  for (const skin of SKINS) {
    const report = L.contrastReport(skin.tokens);
    for (const p of report.pairs) Rosalena.assert(p.pass, `${skin.name}: ${p.label} is ${p.ratio.toFixed(2)}:1, needs ${p.min}:1`);
    Rosalena.assert(report.textMin >= 4.5, `${skin.name}: text contrast ${report.textMin.toFixed(2)}:1`);
    const badge = card(skin.id)?.querySelector(".badge");
    Rosalena.assert(badge, `${skin.name} has no card or contrast badge`);
    Rosalena.assert(/^AA{1,2} \d+(\.\d)?:1$/.test(badge.textContent), `${skin.name} badge reads "${badge.textContent}"`);
  }
  // The maths itself, against known WCAG values.
  Rosalena.assert(Math.abs(L.contrast("#000000", "#ffffff") - 21) < 0.01, "black on white should be 21:1");
  Rosalena.assert(Math.abs(L.contrast("#777777", "#ffffff") - 4.48) < 0.02, "#777 on white should be about 4.48:1");
});

Rosalena.test("theme.get reports which plugin theme is active", async () => {
  await booted;
  const info = await refreshThemeInfo();
  Rosalena.assert(info && (info.mode === "dark" || info.mode === "light"), `theme.get returned ${JSON.stringify(info)}`);
  Rosalena.assert("pluginTheme" in info, "theme.get has no pluginTheme field");
  Rosalena.assert(/Plugin theme:/.test($("#theme-pill").textContent), "the theme pill is empty");
});

Rosalena.test("a custom skin saves to storage and loads back the same", async () => {
  await booted;
  loadIntoEditor(findSkin("ember"));
  const name = $("#ed-name");
  name.value = "Test Coals";
  name.dispatchEvent(new Event("input"));
  const bgText = editorUi.texts.bg;
  bgText.value = "rgb(30, 20, 18)";
  bgText.dispatchEvent(new Event("input"));
  editorUi.swatches.accent.value = "#ffa060";
  editorUi.swatches.accent.dispatchEvent(new Event("input"));
  $("#ed-radius").value = "5";
  $("#ed-radius").dispatchEvent(new Event("input"));
  $("#ed-sans").value = SANS_STACKS[5].value;
  $("#ed-sans").dispatchEvent(new Event("change"));
  $("#ed-save").click();
  const saved = await lastAction;
  Rosalena.assert(saved && !saved.error && saved.id, `Save skin failed: ${JSON.stringify(saved)}`);
  Rosalena.assert(saved.tokens.bg === "rgb(30, 20, 18)" && saved.tokens.accent === "#ffa060" && saved.tokens.radius === "5px" && saved.tokens.sans === SANS_STACKS[5].value, "the saved skin lost an edit");

  const stored = await Rosalena.storage.get("custom");
  Rosalena.assert(Array.isArray(stored) && stored.some((s) => s.id === saved.id), "the skin is not in storage");
  const expected = { ...saved.tokens };
  state.custom = [];
  await loadCustom();
  renderCustomGrid();
  const back = state.custom.find((s) => s.id === saved.id);
  Rosalena.assert(back && back.name === "Test Coals" && sameTokens(back.tokens, expected), "the skin did not load back identically");
  Rosalena.assert(card(saved.id), "the loaded skin has no card");

  const del = card(saved.id).querySelector(".mini.del");
  del.click();
  Rosalena.assert(del.dataset.armed === "1", "the first Delete click should ask to confirm");
  del.click();
  await lastAction;
  Rosalena.assert(!card(saved.id), "the deleted skin still has a card");
  const after = await Rosalena.storage.get("custom");
  Rosalena.assert(!after.some((s) => s.id === saved.id), "the deleted skin is still in storage");
});

Rosalena.test("a malformed skin file is rejected with a readable message", async () => {
  await booted;
  const before = state.custom.length;
  const cases = [
    ["broken.json", "{ this is not json", /not valid JSON/],
    ["list.json", "[1, 2, 3]", /JSON object/],
    ["named-colour.json", JSON.stringify({ tokens: { bg: "red", panel: "#111111", text: "#ffffff", accent: "#00ffff" } }), /"bg" must be a colour/],
    ["css-injection.json", JSON.stringify({ tokens: { bg: "#000000; background: url(x)", panel: "#111111", text: "#ffffff", accent: "#00ffff" } }), /"bg" must be a colour/],
    ["unknown.json", JSON.stringify({ tokens: { bg: "#000000", panel: "#111111", text: "#ffffff", accent: "#00ffff", shadow: "#000000" } }), /"shadow" is not a token/],
    ["radius.json", JSON.stringify({ tokens: { bg: "#000000", panel: "#111111", text: "#ffffff", accent: "#00ffff", radius: "200px" } }), /"radius" must be a length/],
    ["partial.json", JSON.stringify({ tokens: { bg: "#000000", panel: "#111111" } }), /missing text, accent/],
  ];
  for (const [fileName, text, pattern] of cases) {
    const result = await importFromText(text, fileName);
    Rosalena.assert(result.ok === false, `${fileName} was accepted`);
    Rosalena.assert(pattern.test(result.error), `${fileName}: unexpected message "${result.error}"`);
    const box = $("#import-error");
    Rosalena.assert(!box.hidden && box.textContent === result.error, `${fileName}: the error is not shown on the page`);
  }
  // The real file input path too.
  const dt = new DataTransfer();
  dt.items.add(new File(["{\"tokens\": "], "cut-off.json", { type: "application/json" }));
  const input = $("#ed-import");
  input.files = dt.files;
  input.dispatchEvent(new Event("change"));
  const viaInput = await lastAction;
  Rosalena.assert(viaInput && viaInput.ok === false && /not valid JSON/.test(viaInput.error), `the file input accepted a cut-off file: ${JSON.stringify(viaInput)}`);
  Rosalena.assert(state.custom.length === before, "a rejected file still added a skin");
  clearImportError();
});

Rosalena.test("an exported skin re-imports to identical tokens", async () => {
  await booted;
  const sources = [findSkin("neon-grid"), findSkin("paper-press"), { name: "Odd Formats", tokens: { ...DEFAULT_DARK, bg: "rgb(12, 24, 36)", panel: "hsl(210, 40%, 17%)", line: "#3a5" } }];
  for (const skin of sources) {
    const out = await exportSkin(skin);
    Rosalena.assert(out.result && (out.result.verifying === true || out.result.saved), `files.save returned ${JSON.stringify(out.result)}`);
    Rosalena.assert(out.fileName.endsWith(".rosalena-skin.json"), `odd file name ${out.fileName}`);
    const data = JSON.parse(out.text);
    Rosalena.assert(Object.keys(data.tokens).length === L.ALL_TOKENS.length, "the export does not carry every token");
    const back = await importFromText(out.text, out.fileName);
    Rosalena.assert(back.ok, `re-import failed: ${back.error}`);
    Rosalena.assert(sameTokens(back.skin.tokens, skin.tokens), `${skin.name} changed on the way through JSON`);
    Rosalena.assert(back.filled.length === 0, `${skin.name}: re-import had to fill ${back.filled.join(", ")}`);
    await deleteCustom(back.skin.id);
  }
});

Rosalena.test("the editor refuses to apply an unreadable skin", async () => {
  await booted;
  loadIntoEditor(findSkin("ocean-deep"));
  setEditorToken("text", state.editor.tokens.bg);
  Rosalena.assert($("#ed-contrast .fail"), "the contrast list shows no failure for text the same colour as the background");
  Rosalena.assert($("#ed-badge").textContent.startsWith("Low"), `badge reads "${$("#ed-badge").textContent}"`);
  $("#ed-try").click();
  const result = await lastAction;
  Rosalena.assert(result && result.error && /hard to read/.test(result.error), `an unreadable skin was applied: ${JSON.stringify(result)}`);
  Rosalena.assert(state.active !== "draft", "the unreadable draft became active");
  loadIntoEditor(findSkin("neon-grid"), { remix: true });
  state.editor.name = "My skin";
  syncEditorControls();
});

Rosalena.test("clicking the active skin again, or Default look, resets the theme", async () => {
  await booted;
  await onSkinClick("sakura");
  Rosalena.assert(state.active === "sakura", "Sakura did not become active");
  const again = await onSkinClick("sakura");
  Rosalena.assert(again === true, `clicking the active skin did not reset: ${JSON.stringify(again)}`);
  Rosalena.assert(state.active === null && (await Rosalena.storage.get("active")) === null, "the active skin was not cleared");
  Rosalena.assert(card("default").classList.contains("is-active"), "the Default look card is not highlighted after a reset");

  await onSkinClick("pixel-8bit");
  Rosalena.assert(state.active === "pixel-8bit", "8-Bit Pixel did not become active");
  $("#default-look").click();
  const viaButton = await lastAction;
  Rosalena.assert(viaButton === true, `Default look did not reset: ${JSON.stringify(viaButton)}`);
  Rosalena.assert(state.active === null && !card("pixel-8bit").classList.contains("is-active"), "8-Bit Pixel is still marked active");
});

Rosalena.test("clicking a skin applies it through theme.set and remembers it", async () => {
  await booted;
  card("neon-grid").querySelector(".card-main").click();
  const result = await lastAction;
  Rosalena.assert(result && !result.error, `theme.set was refused: ${JSON.stringify(result)}`);
  Rosalena.assert(result.verifying === true || !Rosalena.host.verifying, "in a verify run theme.set should answer { verifying: true }");
  Rosalena.assert(Array.isArray(result.applied) && L.ALL_TOKENS.every((t) => result.applied.includes(t)), `not every token was applied: ${JSON.stringify(result.applied)}`);
  Rosalena.assert(state.active === "neon-grid", "Neon Grid is not the active skin");
  const c = card("neon-grid");
  Rosalena.assert(c.classList.contains("is-active") && c.querySelector(".card-main").getAttribute("aria-pressed") === "true", "the Neon Grid card is not highlighted");
  Rosalena.assert(!card("default").classList.contains("is-active"), "Default look is still highlighted");
  const saved = await Rosalena.storage.get("active");
  Rosalena.assert(saved && saved.id === "neon-grid", `storage remembers ${JSON.stringify(saved)}`);
  Rosalena.assert(/Neon Grid is on/.test($("#status").textContent), `status reads "${$("#status").textContent}"`);
});
