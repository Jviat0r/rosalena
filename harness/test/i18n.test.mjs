/**
 * The window's languages (ui/i18n.mjs, ui/locales/en.mjs and es.mjs).
 *
 *   - both tables hold the same keys, the same shapes and the same {placeholders} (and the same
 *     tags, for the markup entries index.html uses)
 *   - every t("…") in the window's code and every data-i18n* key in index.html is in the
 *     English table, and every English key is used somewhere
 *   - the Spanish is Spanish: a sample of everyday labels, and no multi-word entry left equal
 *     to its English unless it is on the short list of names
 *   - t() with English on prints the English exactly; plurals, variables and the setting resolve
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import en from "../ui/locales/en.mjs";
import es from "../ui/locales/es.mjs";
import { LANGUAGES, languagePref, resolveLanguage, t, translate, translator } from "../ui/i18n.mjs";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Every file whose text the window or the desktop shell shows.
const CODE = [
  "../ui/app.js",
  "../ui/format.mjs",
  "../ui/phone.js",
  "../ui/session-rail.mjs",
  "../ui/web-tab.mjs",
  "../ui/panels.js",
  "../ui/plugins-ui.js",
  "../ui/ui-styles.js",
  "../ui/index.html",
  "../../desktop/main.mjs",
  "../../desktop/menu.mjs",
  "../../desktop/notify.mjs",
  "../../desktop/updater.mjs",
];

const KEY_CALL = /(?<![\w.$])t\(\s*"((?:[^"\\]|\\.)*)"/g;
const ATTR = /\sdata-i18n(?:-[a-z-]+)?="([^"]*)"/g;
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function usedKeys() {
  const used = new Map();
  for (const rel of CODE) {
    const text = read(rel);
    for (const m of text.matchAll(KEY_CALL)) if (!used.has(JSON.parse(`"${m[1]}"`))) used.set(JSON.parse(`"${m[1]}"`), rel);
    if (rel.endsWith(".html")) for (const m of text.matchAll(ATTR)) if (m[1] && !used.has(decode(m[1]))) used.set(decode(m[1]), rel);
  }
  return used;
}

const forms = (v) => (typeof v === "string" ? [v] : Object.values(v));
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const tags = (s) => [...s.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()).sort().join(",");

test("English and Spanish hold the same keys, shapes, placeholders and tags", () => {
  const enKeys = Object.keys(en);
  const esKeys = new Set(Object.keys(es));
  assert.ok(enKeys.length > 1000, `the tables look empty (${enKeys.length} keys)`);
  const onlyEn = enKeys.filter((k) => !esKeys.has(k));
  const onlyEs = [...esKeys].filter((k) => !(k in en));
  assert.deepEqual(onlyEn, [], "in en.mjs but not es.mjs");
  assert.deepEqual(onlyEs, [], "in es.mjs but not en.mjs");
  for (const key of enKeys) {
    const a = en[key];
    const b = es[key];
    assert.equal(typeof a, typeof b, `${key}: one table has a plural, the other a string`);
    if (typeof a === "object") {
      for (const v of [a, b]) assert.ok(typeof v.one === "string" && typeof v.other === "string", `${key}: a plural needs one and other`);
    } else {
      assert.equal(typeof a, "string", `${key}: an entry is text or { one, other }`);
    }
    const want = vars(forms(a).at(-1));
    for (const f of [...forms(a), ...forms(b)]) assert.equal(vars(f), want, `${key}: {placeholders} differ in ${JSON.stringify(f)}`);
    if (forms(a).some((f) => /<[a-z]/i.test(f))) for (const f of forms(b)) assert.equal(tags(f), tags(forms(a)[0]), `${key}: the markup's tags differ`);
  }
});

test("every key the window uses is in the English table, and every English key is used", () => {
  const used = usedKeys();
  assert.ok(used.size > 1000, `found only ${used.size} keys: is the pattern still right?`);
  const missing = [...used].filter(([key]) => !(key in en)).map(([key, file]) => `${file}: ${JSON.stringify(key)}`);
  assert.deepEqual(missing, [], "t() / data-i18n keys missing from locales/en.mjs");
  const unused = Object.keys(en).filter((key) => !used.has(key));
  assert.deepEqual(unused, [], "keys in locales/en.mjs that nothing uses");
});

test("t() keys are plain double-quoted strings, so this test can see them", () => {
  for (const rel of CODE.filter((r) => !r.endsWith(".html"))) {
    const text = read(rel);
    const dynamic = [...text.matchAll(/(?<![\w.$])t\(\s*(?!["\s)])/g)].map((m) => text.slice(m.index, m.index + 40));
    assert.deepEqual(dynamic, [], `${rel}: t() with a key that is not a string literal`);
  }
});

test("the Spanish table is Spanish", () => {
  const sample = {
    "New chat": "Nuevo chat",
    Send: "Enviar",
    Stop: "Detener",
    Settings: "Configuración",
    Language: "Idioma",
    Appearance: null,
    Cancel: null,
    Copy: null,
    Remove: null,
    "Open folder…": null,
    "Full access": null,
    "Read only": null,
    Notifications: null,
    Permissions: null,
    Providers: null,
    "Phone access": null,
    "Search settings": null,
    Close: null,
    "Match my system": null,
  };
  for (const [key, expected] of Object.entries(sample)) {
    assert.ok(key in es, `sample key ${JSON.stringify(key)} is in es.mjs`);
    if (expected) assert.equal(es[key], expected);
    assert.notEqual(es[key], en[key], `${JSON.stringify(key)} is still English in es.mjs`);
  }
  // Same text in both is allowed only for names and for words Spanish uses as they are.
  const SAME_OK = /^(Rosalena|SolBrowser|OmniRoute|Claude|Codex|Style Lab|Ultracode|MCP|GitHub|Cloudflare|Plugins?|Skills?|Tokens?|Chats?|Router|Prompt|Monitor|Shell|Extra|Auto|Plan|Commits?|Zoom|Local|Git|Hz|OK)\b/;
  const leftover = Object.keys(en).filter((key) => {
    const a = forms(en[key]).join(" ");
    const b = forms(es[key]).join(" ");
    return a === b && (a.match(/[A-Za-z]{3,}/g) ?? []).length >= 3 && !SAME_OK.test(a);
  });
  assert.deepEqual(leftover, [], "multi-word entries whose Spanish is the English");
});

test("t() with English on prints the English exactly; plurals and variables fill in", () => {
  assert.equal(t("New chat"), "New chat");
  assert.equal(translate("en", "{n} files", { n: 1 }), "1 file");
  assert.equal(translate("en", "{n} files", { n: 0 }), "0 files");
  assert.equal(translate("en", "{n} files", { n: 2 }), "2 files");
  assert.equal(translate("es", "{n} files", { n: 1 }), "1 archivo");
  assert.equal(translate("es", "{n} files", { n: 5 }), "5 archivos");
  assert.equal(translate("es", "New chat"), "Nuevo chat");
  assert.equal(translate("es", "a key nobody wrote, {x}", { x: 7 }), "a key nobody wrote, 7", "a missing key shows its English");
  assert.equal(translate("en", "{name} and {name}", { name: "a" }), "a and a");
  assert.equal(translate("en", "keep {other}", {}), "keep {other}", "an unknown placeholder stays as written");
  const es_ = translator("es");
  assert.equal(es_("Language"), "Idioma");
  assert.equal(translator("xx")("Language"), "Language", "an unknown language is English");
  // Every English entry printed through t() is the entry itself (byte-identical English).
  for (const [key, value] of Object.entries(en)) if (typeof value === "string" && !/\{\w+\}/.test(value)) assert.equal(translate("en", key), value);
});

test("the Language setting: English by default, Spanish, or the system's language", () => {
  assert.deepEqual(Object.keys(LANGUAGES), ["en", "es"]);
  assert.equal(resolveLanguage(null, "es-MX"), "en", "nothing saved is English, whatever the system says");
  assert.equal(resolveLanguage("es", "en-US"), "es");
  assert.equal(resolveLanguage("en", "es-ES"), "en");
  assert.equal(resolveLanguage("system", "es-419"), "es");
  assert.equal(resolveLanguage("system", "es_AR"), "es");
  assert.equal(resolveLanguage("system", "fr-FR"), "en", "a system language with no table is English");
  assert.equal(resolveLanguage("klingon", "es"), "en");
  assert.equal(languagePref("SYSTEM"), "system");
  assert.equal(languagePref("de"), "en");
});

test("the server serves the module and both tables; index.html has the setting", () => {
  const server = read("../src/ui.mjs");
  for (const path of ["/i18n.mjs", "/locales/en.mjs", "/locales/es.mjs"]) assert.ok(server.includes(`path === "${path}"`), `ui.mjs serves ${path}`);
  const page = read("../ui/index.html");
  assert.match(page, /<select[^>]*id="language-select"/);
  for (const value of ["en", "es", "system"]) assert.match(page, new RegExp(`<option value="${value}"`));
  assert.match(page, /data-i18n="Language"/);
  assert.equal(en["Language (alternate name)"], "Idioma", "the row names the setting in the other language too, for search");
  assert.equal(es["Language (alternate name)"], "Language");
});
