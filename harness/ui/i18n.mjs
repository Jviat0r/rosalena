// The window's languages: English (the default) and Spanish.
//
// One function does the work: `t(key, vars)`. A key is the English text itself, written
// once where it is used ("New chat", "{n} files"); locales/en.mjs holds every key with its
// English text (and its plural forms), locales/es.mjs holds the Spanish. So with English on,
// what a person reads is byte-for-byte what the page printed before this file existed, and
// a key missing from a table still shows its English rather than a code.
//
//   t("New chat")                          -> "Nuevo chat"
//   t("Could not read {name}.", { name })  -> variables are {name}, replaced as text
//   t("{n} files", { n: 3 })               -> a plural: the entry is { one, other }, picked
//                                             by Intl.PluralRules for the language, on `n`
//
// The static markup in index.html is translated by attribute, the key in the attribute:
//
//   <span data-i18n="Appearance">Appearance</span>               text (icons kept)
//   <p data-i18n-html="Docked sits beside the chat…">…<b>…</p>  inner HTML (the table entry
//                                                                is markup with the same tags)
//   <input data-i18n-placeholder="Search settings" …>          any attribute: data-i18n-<attr>
//   <section data-i18n-data-title="Models" data-title="Models"> works for data-* too
//
// What is never translated: model output, the prompts and tool descriptions sent to a model,
// file names, commands, code, shortcuts, product, model and provider names, and anything a
// log, telemetry or a test reads. Those strings simply do not go through t().
//
// The language is the `rosalena-language` UI pref ("en", "es" or "system"; saved with the
// window's look by persist.js), read once when this module loads. Changing it reloads the
// page (app.js), so every string is drawn once in one language; the desktop shell reads the
// same pref for its menus and dialogs (desktop/main.mjs).
//
// Adding a string: wrap it in t("…") (or add data-i18n="…" in index.html), add the key to
// locales/en.mjs and its Spanish to locales/es.mjs. harness/test/i18n.test.mjs fails until
// both tables have it with the same {placeholders}. Adding a language: a locales/<code>.mjs
// with every key, an entry in LANGUAGES and TABLES below, and the file on ui.mjs's list.

import en from "./locales/en.mjs";
import es from "./locales/es.mjs";

/** The choices Settings offers, by code, each in its own language. */
export const LANGUAGES = { en: "English", es: "Español" };
export const LANGUAGE_KEY = "rosalena-language";
export const DEFAULT_LANGUAGE = "en";
const TABLES = { en, es };

/** "en" | "es" from a saved pref and the system language (navigator.language / app.getLocale()). */
export function resolveLanguage(pref, systemLanguage = "") {
  const want = String(pref ?? "").trim().toLowerCase();
  if (want in TABLES) return want;
  if (want === "system") {
    const sys = String(systemLanguage ?? "").trim().toLowerCase().split(/[-_]/)[0];
    return sys in TABLES ? sys : DEFAULT_LANGUAGE;
  }
  return DEFAULT_LANGUAGE;
}

/** What the setting holds: "en", "es" or "system" (anything else reads as the default). */
export function languagePref(saved) {
  const value = String(saved ?? "").trim().toLowerCase();
  return value === "system" || value in TABLES ? value : DEFAULT_LANGUAGE;
}

const plurals = new Map();
function pluralCategory(lang, n) {
  if (!plurals.has(lang)) {
    try {
      plurals.set(lang, new Intl.PluralRules(lang));
    } catch {
      plurals.set(lang, { select: (x) => (x === 1 ? "one" : "other") });
    }
  }
  return plurals.get(lang).select(n);
}

/** One entry of `table` for `key` with `vars` filled in. Exported for the shell and tests. */
export function translate(lang, key, vars) {
  let entry = TABLES[lang]?.[key];
  if (entry === undefined) entry = en[key];
  if (entry === undefined) entry = key;
  if (entry && typeof entry === "object") {
    const n = Number(vars?.n ?? vars?.count ?? 0);
    entry = entry[pluralCategory(lang, n)] ?? entry.other ?? entry.one ?? key;
  }
  if (!vars) return entry;
  return String(entry).replace(/\{(\w+)\}/g, (whole, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
}

/** A `t` bound to one language: the desktop shell uses this, the page uses `t`. */
export function translator(lang) {
  const code = lang in TABLES ? lang : DEFAULT_LANGUAGE;
  return (key, vars) => translate(code, key, vars);
}

let current = DEFAULT_LANGUAGE;
let pref = DEFAULT_LANGUAGE;

/** The language the page is drawn in ("en" or "es"). */
export const language = () => current;
/** What the setting says ("en", "es" or "system"). */
export const savedLanguage = () => pref;

export function t(key, vars) {
  return translate(current, key, vars);
}

/** The table entry as markup (data-i18n-html). Not for text from anywhere else. */
function entryHtml(key) {
  return t(key);
}

// Keys a translated page asked for and no table had: for checking a page by hand
// (window.rosalenaI18n.missing in the console). Never shown to the person.
const missing = new Set();

function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(TABLES[current] ?? {}, key);
}

/**
 * Put the language's text into every marked element under `root`. Text keeps an element's
 * icons: an element with child elements gets only its one text run replaced.
 */
export function translatePage(root = globalThis.document) {
  if (!root?.querySelectorAll || current === DEFAULT_LANGUAGE) return;
  const nodes = root.querySelectorAll("*");
  for (const node of nodes) {
    if (!node.attributes?.length) continue;
    for (const attr of [...node.attributes]) {
      if (!attr.name.startsWith("data-i18n")) continue;
      const key = attr.value;
      if (!key) continue;
      if (!hasKey(key)) missing.add(key);
      if (attr.name === "data-i18n") setText(node, t(key));
      else if (attr.name === "data-i18n-html") node.innerHTML = entryHtml(key);
      else node.setAttribute(attr.name.slice("data-i18n-".length), t(key));
    }
  }
}

function setText(node, text) {
  if (!node.children.length) {
    node.textContent = text;
    return;
  }
  const runs = [...node.childNodes].filter((child) => child.nodeType === 3 && child.data.trim());
  if (runs.length !== 1) return; // ambiguous markup: leave it in English rather than break it
  const run = runs[0];
  const lead = run.data.match(/^\s*/)[0];
  const tail = run.data.match(/\s*$/)[0];
  run.data = `${lead}${text}${tail}`;
}

/**
 * Save the setting and redraw the window in it (a reload: every string is drawn once). The
 * save reaches the server before the reload: the reloaded page takes the server's saved
 * look over its own storage (persist.js), so a save still in flight would be undone.
 */
export async function chooseLanguage(value, { reload = true } = {}) {
  const next = languagePref(value);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_KEY, next);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  try {
    globalThis.rosalenaDesktop?.setLanguage?.(next);
  } catch {
    /* an older shell without the call keeps its menus in English */
  }
  pref = next;
  if (reload && resolveLanguage(next, globalThis.navigator?.language) !== current) {
    try {
      await Promise.race([globalThis.rosalenaPersist?.flush?.(), new Promise((resolve) => setTimeout(resolve, 3000))]);
    } catch {
      /* not saved on the server: this page still switches */
    }
    globalThis.location?.reload();
  }
  return next;
}

// In the page: read the setting once, mark <html lang>, translate the static markup. Module
// scripts run after the document is parsed, and app.js imports this first, so the markup is
// in the language before any of app.js reads or copies it (the welcome screen, page titles).
if (typeof window !== "undefined" && typeof document !== "undefined") {
  let saved = null;
  try {
    saved = window.localStorage.getItem(LANGUAGE_KEY);
  } catch {
    saved = null;
  }
  pref = languagePref(saved);
  current = resolveLanguage(pref, window.navigator?.language);
  document.documentElement.lang = current;
  translatePage(document);
  window.rosalenaI18n = { t, language, savedLanguage, missing, translatePage };
}
