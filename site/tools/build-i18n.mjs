#!/usr/bin/env node
/**
 * Builds the Spanish site (/es/...) from the English pages and site/i18n/es.json.
 *
 *   node tools/build-i18n.mjs            build and write public/es/ and public/sitemap.xml
 *   node tools/build-i18n.mjs --check    exit 1 if what is on disk is not what a build writes
 *   node tools/build-i18n.mjs --missing  print the English strings es.json has no entry for,
 *                                        as JSON ready to paste into es.json and translate
 *
 * Why a build and not two hand-kept copies: Pages serves public/ as-is (the deploy is
 * `wrangler pages deploy public`, no build step), and AI crawlers do not run JavaScript, so
 * the Spanish words have to be in static HTML. Two hand-kept copies drift; this way the
 * English page is the only source of layout, links and scripts, and es.json holds only words.
 *
 * How a page is translated. The English HTML is parsed into a light tree and cut into
 * "units": a run of text plus inline tags (a, strong, em, code, span, small, ...) between
 * block boundaries, for example the inside of a <p>, an <li>, a <td>, a <button>. Each unit
 * that has words in it is looked up in es.json by its English HTML (whitespace collapsed to
 * one space). Inline tags stay inside the unit, so a translation can move a link inside its
 * sentence, but it must keep exactly the same tags (checked). Attributes people read (title,
 * alt, aria-label, placeholder, data-prompt, the description and og: meta) are looked up by
 * their plain text. Version numbers like 0.1.13 are written {v1}, {v2} in es.json keys and
 * values and filled back in from the English page, so a release bump needs no translation
 * change, only a rebuild. An entry whose Spanish equals its English (a product name, a model
 * size table) is how a string is marked "the same in Spanish".
 *
 * Links: every same-site link to one of the PAGES below becomes its /es/ twin; every other
 * same-site URL (styles, scripts, JSON, downloads) is made absolute so it still resolves from
 * /es/...; other sites are left alone. Text that JavaScript writes is translated in the scripts
 * themselves (they read <html lang>), not here.
 *
 * The English pages carry the hreflang block and the EN/ES switch by hand; this tool checks
 * they are exactly what it expects and says what to paste when they are not.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SITE = resolve(HERE, "..");
export const PUBLIC = join(SITE, "public");
export const ORIGIN = "https://rosalena.dev";

/** Every English page that gets a Spanish twin, in sitemap order of importance. */
export const PAGES = [
  { file: "index.html", route: "/" },
  { file: "download/index.html", route: "/download/" },
  { file: "download/solbrowser/index.html", route: "/download/solbrowser/" },
  { file: "try/index.html", route: "/try/" },
  { file: "harness/index.html", route: "/harness/" },
  { file: "check/index.html", route: "/check/" },
  { file: "preview/index.html", route: "/preview/" },
  // Served by Pages for any missing path under its folder, so /es/404.html answers /es/....
  { file: "404.html", route: "/404.html", noindex: true },
];

export const LANGS = {
  es: { dir: "es", dict: join(SITE, "i18n", "es.json") },
};

const ROUTES = new Set(PAGES.filter((page) => !page.noindex).map((page) => page.route));

// ------------------------------------------------------------------ the chrome both languages share

/** The three hreflang links every indexable page carries, identical in both languages. */
export function alternates(route) {
  return [
    `<link rel="alternate" hreflang="en" href="${ORIGIN}${route}">`,
    `<link rel="alternate" hreflang="es" href="${ORIGIN}/es${route}">`,
    `<link rel="alternate" hreflang="x-default" href="${ORIGIN}${route}">`,
  ].join("\n");
}

/**
 * The language switch for a page in `current`, linking to the same page in the other
 * language. A plain link, so it works with JavaScript off; /lang.js only remembers the click.
 */
export function langSwitch(current, route) {
  if (current === "en") {
    return `<a class="lang-switch" href="/es${route}" hreflang="es" lang="es" data-lang-switch="es" aria-label="Español: ver esta página en español" title="Ver esta página en español"><span class="lang-on">EN</span><span class="lang-sep" aria-hidden="true">/</span><span>ES</span></a>`;
  }
  return `<a class="lang-switch" href="${route}" hreflang="en" lang="en" data-lang-switch="en" aria-label="English: view this page in English" title="View this page in English"><span>EN</span><span class="lang-sep" aria-hidden="true">/</span><span class="lang-on">ES</span></a>`;
}

// ------------------------------------------------------------------ a small HTML parser

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "title", "textarea"]);
/** Inline tags that stay inside a unit, so a sentence is translated whole. */
const PHRASING = new Set(["a", "abbr", "b", "br", "cite", "code", "em", "i", "img", "kbd", "mark", "q", "s", "small", "span", "strong", "sub", "sup", "time", "u", "wbr"]);
/** Never looked inside for words. */
const OPAQUE = new Set(["script", "style", "svg", "textarea"]);
/** Attributes a person reads. */
const TEXT_ATTRS = new Set(["title", "alt", "aria-label", "placeholder", "data-prompt"]);
const TEXT_META = new Set(["description", "og:title", "og:description", "twitter:title", "twitter:description"]);

function lineOf(src, at) {
  return src.slice(0, at).split("\n").length;
}

function readStartTag(src, at) {
  const head = /^<([A-Za-z][\w:-]*)/.exec(src.slice(at, at + 64));
  if (!head) return null;
  const name = head[1].toLowerCase();
  let i = at + head[0].length;
  const attrs = [];
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === ">") return { name, attrs, end: i + 1, selfClosing: false };
    if (src.startsWith("/>", i)) return { name, attrs, end: i + 2, selfClosing: true };
    const nameMatch = /^[^\s"'>\/=]+/.exec(src.slice(i, i + 128));
    if (!nameMatch) throw new Error(`bad attribute in <${name}> at line ${lineOf(src, i)}`);
    const attr = { name: nameMatch[0].toLowerCase(), start: i, value: null, valueStart: -1, valueEnd: -1 };
    i += nameMatch[0].length;
    const eq = /^\s*=\s*/.exec(src.slice(i, i + 32));
    if (eq) {
      i += eq[0].length;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1);
        if (close === -1) throw new Error(`unclosed attribute ${attr.name} at line ${lineOf(src, i)}`);
        attr.valueStart = i + 1;
        attr.valueEnd = close;
        i = close + 1;
      } else {
        const bare = /^[^\s>]+/.exec(src.slice(i, i + 512));
        attr.valueStart = i;
        attr.valueEnd = i + (bare ? bare[0].length : 0);
        i = attr.valueEnd;
      }
      attr.value = src.slice(attr.valueStart, attr.valueEnd);
    }
    attr.end = i;
    attrs.push(attr);
  }
}

/** Parse well-formed HTML into a tree of {type, name, attrs, start, openEnd, closeStart, end}. */
export function parse(src) {
  const root = { type: "root", name: "#root", attrs: [], children: [], start: 0, end: src.length };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const text = (start, end) => {
    if (end > start) top().children.push({ type: "text", start, end, parent: top() });
  };
  const lower = src.toLowerCase();
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      text(i, src.length);
      break;
    }
    text(i, lt);
    if (src.startsWith("<!--", lt)) {
      const close = src.indexOf("-->", lt + 4);
      if (close === -1) throw new Error(`unclosed comment at line ${lineOf(src, lt)}`);
      top().children.push({ type: "comment", start: lt, end: close + 3, parent: top() });
      i = close + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const gt = src.indexOf(">", lt);
      top().children.push({ type: "decl", start: lt, end: gt + 1, parent: top() });
      i = gt + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const close = /^<\/([A-Za-z][\w:-]*)\s*>/.exec(src.slice(lt, lt + 80));
      if (!close) throw new Error(`bad end tag at line ${lineOf(src, lt)}`);
      const name = close[1].toLowerCase();
      const open = top();
      if (open.name !== name) {
        throw new Error(`</${name}> at line ${lineOf(src, lt)} closes <${open.name}> (line ${lineOf(src, open.start)})`);
      }
      open.closeStart = lt;
      open.end = lt + close[0].length;
      stack.pop();
      i = open.end;
      continue;
    }
    const tag = readStartTag(src, lt);
    if (!tag) {
      text(lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const el = { type: "el", name: tag.name, attrs: tag.attrs, start: lt, openEnd: tag.end, children: [], parent: top() };
    top().children.push(el);
    if (VOID.has(tag.name) || tag.selfClosing) {
      el.closeStart = el.end = tag.end;
      i = tag.end;
      continue;
    }
    if (RAW.has(tag.name)) {
      const close = lower.indexOf(`</${tag.name}`, tag.end);
      if (close === -1) throw new Error(`unclosed <${tag.name}> at line ${lineOf(src, lt)}`);
      el.children.push({ type: "text", start: tag.end, end: close, raw: true, parent: el });
      el.closeStart = close;
      el.end = src.indexOf(">", close) + 1;
      i = el.end;
      continue;
    }
    stack.push(el);
    i = tag.end;
  }
  if (stack.length !== 1) throw new Error(`<${top().name}> at line ${lineOf(src, top().start)} is never closed`);
  return root;
}

function attrOf(el, name) {
  return el.attrs?.find((attr) => attr.name === name) ?? null;
}

function* elements(node) {
  for (const child of node.children ?? []) {
    if (child.type !== "el") continue;
    yield child;
    yield* elements(child);
  }
}

// ------------------------------------------------------------------ text helpers

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—",
  ndash: "–", middot: "·", times: "×", rarr: "→", larr: "←", rsquo: "’",
  lsquo: "‘", ldquo: "“", rdquo: "”", bull: "•", copy: "©", trade: "™",
};

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

export function escapeAttr(text) {
  return String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const collapse = (text) => String(text).replace(/\s+/g, " ").trim();

/** The words of a unit: tags dropped, entities decoded, whitespace collapsed. */
export function plainText(html) {
  return collapse(decodeEntities(String(html).replace(/<[^>]*>/g, " ")));
}

/**
 * Whether a string has anything to translate. Strings with no letters, and single tokens
 * that read as identifiers (x64, 0.1.13, Q4_K_M, SHA-256, a file name), are left alone.
 */
export function needsTranslation(plain) {
  if (!/[A-Za-z]/.test(plain)) return false;
  if (!/\s/.test(plain) && /[\d._\/\\:-]/.test(plain)) return false;
  return true;
}

// Three dot-separated numbers that are not part of a longer run (127.0.0.1 is not a version),
// with a sentence's full stop allowed right after ("version 0.1.13.").
const VERSION = /(?<!\d|\d\.)\d+\.\d+\.\d+(?!\d|\.\d)/g;

/** "Version 0.1.13 of 0.1.13" -> { key: "Version {v1} of {v2}", versions: ["0.1.13", "0.1.13"] } */
export function versionKey(text) {
  const versions = [];
  const key = String(text).replace(VERSION, (match) => {
    versions.push(match);
    return `{v${versions.length}}`;
  });
  return { key, versions };
}

function fillVersions(text, versions) {
  return String(text).replace(/\{v(\d+)\}/g, (whole, n) => versions[Number(n) - 1] ?? whole);
}

const tagsOf = (html) => (String(html).match(/<[^>]+>/g) ?? []).map(collapse).sort();

// ------------------------------------------------------------------ links

/**
 * An English page's URL as the Spanish page should write it. Pages become /es/ pages; every
 * other same-site URL becomes an absolute path (so ./try.css still resolves from /es/try/);
 * other sites, #fragments and data: are left as they are.
 */
export function rewriteUrl(value, route) {
  const raw = String(value ?? "");
  if (raw === "" || raw.startsWith("#") || /^(mailto|tel|javascript|data|blob):/i.test(raw)) return raw;
  let url;
  try {
    url = new URL(decodeEntities(raw), ORIGIN + route);
  } catch {
    return raw;
  }
  if (url.origin !== ORIGIN) return raw;
  let path = url.pathname.replace(/\/index\.html$/, "/");
  if (ROUTES.has(path)) path = path === "/" ? "/es/" : `/es${path}`;
  const absolute = /^https?:\/\//i.test(raw);
  return escapeAttr(`${absolute ? ORIGIN : ""}${path}${url.search}${url.hash}`);
}

// ------------------------------------------------------------------ one page

/**
 * Translate one English page.
 * @returns {{ html: string, missing: string[], mismatched: string[], used: Set<string> }}
 */
export function translatePage(src, { file, route, lang = "es", dict }) {
  const strings = dict.strings ?? {};
  const missing = [];
  const mismatched = [];
  const used = new Set();
  const noindex = PAGES.find((page) => page.file === file)?.noindex ?? false;

  /** Look a string up; `kind` is "html" for a unit and "text" for an attribute or JSON-LD. */
  const lookup = (english, kind) => {
    const { key, versions } = versionKey(collapse(english));
    if (!Object.prototype.hasOwnProperty.call(strings, key)) {
      missing.push(key);
      return null;
    }
    used.add(key);
    const value = strings[key];
    if (typeof value !== "string" || value.trim() === "") {
      missing.push(key);
      return null;
    }
    if (kind === "html" && tagsOf(key).join("\n") !== tagsOf(value).join("\n")) {
      mismatched.push(key);
      return null;
    }
    if ((key.match(/\{v\d+\}/g) ?? []).sort().join() !== (value.match(/\{v\d+\}/g) ?? []).sort().join()) {
      mismatched.push(key);
      return null;
    }
    return fillVersions(value, versions);
  };

  // ---- pass 1: words, comments, the switch, JSON-LD, <html lang>
  const tree = parse(src);
  const edits = [];
  const edit = (start, end, text) => edits.push({ start, end, text });

  if (!noindex) {
    const want = alternates(route);
    if (!src.includes(want)) throw new Error(`${file}: the <head> needs these lines, exactly:\n${want}`);
    const sw = langSwitch("en", route);
    if (!src.includes(sw)) throw new Error(`${file}: the header needs this language switch, exactly:\n${sw}`);
  }

  const addUnit = (run) => {
    const first = run[0];
    const last = run[run.length - 1];
    let start = first.start;
    let end = last.end;
    if (first.type === "text") start += src.slice(first.start, first.end).length - src.slice(first.start, first.end).trimStart().length;
    if (last.type === "text") end -= src.slice(last.start, last.end).length - src.slice(last.start, last.end).trimEnd().length;
    const html = src.slice(start, end);
    if (!needsTranslation(plainText(html))) return;
    const spanish = lookup(html, "html");
    // "The same in Spanish" keeps the English formatting (line breaks) instead of collapsing it.
    if (spanish !== null && spanish !== collapse(html)) edit(start, end, spanish);
  };

  const isBlank = (node) => node.type === "text" && src.slice(node.start, node.end).trim() === "";

  const walk = (el) => {
    if (el.type === "el" && (OPAQUE.has(el.name) || attrOf(el, "data-lang-switch"))) return;
    if (el.type === "el" && el.name === "title") {
      const node = el.children[0];
      if (node) addUnit([node]);
      return;
    }
    let run = [];
    const flush = () => {
      while (run.length && isBlank(run[0])) run.shift();
      while (run.length && isBlank(run[run.length - 1])) run.pop();
      if (run.length) {
        const words = run.some((node) => node.type === "text" && /[A-Za-z]/.test(decodeEntities(src.slice(node.start, node.end))));
        if (words) addUnit(run);
        else for (const node of run) if (node.type === "el") walk(node);
      }
      run = [];
    };
    for (const child of el.children) {
      if (child.type === "text" || (child.type === "el" && PHRASING.has(child.name) && !attrOf(child, "data-lang-switch"))) {
        run.push(child);
      } else {
        flush();
        if (child.type === "el") walk(child);
      }
    }
    flush();
  };
  walk(tree);

  for (const el of elements(tree)) {
    if (el.name === "html") {
      const attr = attrOf(el, "lang");
      if (!attr) throw new Error(`${file}: <html> has no lang`);
      edit(attr.valueStart, attr.valueEnd, lang);
    }
    if (attrOf(el, "data-lang-switch")) edit(el.start, el.end, langSwitch(lang, route));
    if (el.name === "script" && attrOf(el, "type")?.value === "application/ld+json") {
      const body = el.children[0];
      const data = JSON.parse(src.slice(body.start, body.end));
      const tx = (node, top) => {
        if (Array.isArray(node)) return node.map((item) => tx(item, top));
        if (!node || typeof node !== "object") return node;
        const out = {};
        for (const [key, value] of Object.entries(node)) {
          if (key === "@graph") out[key] = tx(value, true);
          else if (typeof value === "string" && ["name", "description", "operatingSystem"].includes(key) && needsTranslation(value)) {
            out[key] = lookup(value, "text") ?? value;
          } else if (typeof value === "string" && ["url", "downloadUrl"].includes(key)) {
            out[key] = decodeEntities(rewriteUrl(value, route));
          } else if (value && typeof value === "object") out[key] = tx(value, false);
          else out[key] = value;
        }
        if (top && out["@type"]) out.inLanguage = lang;
        return out;
      };
      edit(body.start, body.end, `\n${JSON.stringify(tx(data, !data["@graph"]), null, 2)}\n`);
    }
  }

  // Comments are the English page's notes to its maintainer. They go, with their lines.
  const comments = [];
  const collect = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === "comment") comments.push(child);
      else collect(child);
    }
  };
  collect(tree);
  for (const comment of comments) {
    const lineStart = src.lastIndexOf("\n", comment.start - 1) + 1;
    const lineEnd = src.indexOf("\n", comment.end);
    const before = src.slice(lineStart, comment.start);
    const after = src.slice(comment.end, lineEnd === -1 ? src.length : lineEnd);
    if (before.trim() === "" && after.trim() === "") edit(lineStart, lineEnd === -1 ? src.length : lineEnd + 1, "");
    else edit(comment.start, comment.end, "");
  }

  const doctype = tree.children.find((node) => node.type === "decl");
  edit(
    doctype ? doctype.end : 0,
    doctype ? doctype.end : 0,
    `\n<!-- Generated by site/tools/build-i18n.mjs from public/${file} and site/i18n/${lang}.json. Do not edit: change those and run \`node tools/build-i18n.mjs\` in site/. -->`,
  );

  const pass1 = applyEdits(src, edits, file);

  // ---- pass 2: links and the attributes people read, on the translated text
  const tree2 = parse(pass1);
  const edits2 = [];
  for (const el of elements(tree2)) {
    if (attrOf(el, "data-lang-switch")) continue;
    if (el.name === "link" && attrOf(el, "hreflang")) continue;
    const metaName = el.name === "meta" ? (attrOf(el, "name")?.value ?? attrOf(el, "property")?.value ?? "") : "";
    for (const attr of el.attrs) {
      if (attr.value === null) continue;
      let next = null;
      if (attr.name === "href" || attr.name === "src" || attr.name === "action" || (attr.name === "content" && metaName === "og:url")) {
        next = rewriteUrl(attr.value, route);
      } else if (TEXT_ATTRS.has(attr.name) || (attr.name === "content" && TEXT_META.has(metaName))) {
        const plain = collapse(decodeEntities(attr.value));
        if (needsTranslation(plain)) {
          const spanish = lookup(plain, "text");
          if (spanish !== null) next = escapeAttr(spanish);
        }
      }
      if (next !== null && next !== attr.value) edits2.push({ start: attr.valueStart, end: attr.valueEnd, text: next });
    }
  }
  return { html: applyEdits(pass1, edits2, file), missing, mismatched, used };
}

function applyEdits(src, edits, file) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let at = 0;
  for (const change of sorted) {
    if (change.start < at) throw new Error(`${file}: overlapping edits at line ${lineOf(src, change.start)}`);
    out += src.slice(at, change.start) + change.text;
    at = change.end;
  }
  return out + src.slice(at);
}

// ------------------------------------------------------------------ the sitemap

/** The sitemap: every English URL with its lastmod, its Spanish twin, and the hreflang links. */
export function buildSitemap(current) {
  const lastmod = new Map();
  const order = [];
  for (const match of String(current).matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
    const path = match[1].replace(ORIGIN, "");
    if (path.startsWith("/es/")) continue;
    if (!lastmod.has(path)) order.push(path);
    lastmod.set(path, match[2]);
  }
  for (const page of PAGES) {
    if (!page.noindex && !lastmod.has(page.route)) throw new Error(`sitemap.xml has no <url> for ${page.route}: add it with a <lastmod>`);
  }
  const block = (loc, route, date) =>
    [
      "  <url>",
      `    <loc>${loc}</loc><lastmod>${date}</lastmod>`,
      `    <xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}${route}"/>`,
      `    <xhtml:link rel="alternate" hreflang="es" href="${ORIGIN}/es${route}"/>`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}${route}"/>`,
      "  </url>",
    ].join("\n");
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'];
  for (const path of order) {
    if (ROUTES.has(path)) lines.push(block(`${ORIGIN}${path}`, path, lastmod.get(path)));
    else lines.push(`  <url><loc>${ORIGIN}${path}</loc><lastmod>${lastmod.get(path)}</lastmod></url>`);
  }
  for (const path of order) if (ROUTES.has(path)) lines.push(block(`${ORIGIN}/es${path}`, path, lastmod.get(path)));
  lines.push("</urlset>", "");
  return lines.join("\n");
}

// ------------------------------------------------------------------ the whole site

export function loadDict(lang = "es") {
  return JSON.parse(readFileSync(LANGS[lang].dict, "utf8"));
}

/**
 * Build every Spanish page and the sitemap in memory.
 * @returns {{ files: Map<string, string>, missing: string[], mismatched: string[], unused: string[] }}
 */
export function buildAll({ publicDir = PUBLIC, lang = "es", dict = loadDict(lang) } = {}) {
  const files = new Map();
  const missing = [];
  const mismatched = [];
  const used = new Set();
  for (const page of PAGES) {
    const src = readFileSync(join(publicDir, page.file), "utf8");
    const result = translatePage(src, { ...page, lang, dict });
    files.set(`${LANGS[lang].dir}/${page.file}`, result.html);
    for (const key of result.missing) if (!missing.includes(key)) missing.push(key);
    for (const key of result.mismatched) if (!mismatched.includes(key)) mismatched.push(key);
    for (const key of result.used) used.add(key);
  }
  files.set("sitemap.xml", buildSitemap(readFileSync(join(publicDir, "sitemap.xml"), "utf8")));
  const unused = Object.keys(dict.strings ?? {}).filter((key) => !used.has(key));
  return { files, missing, mismatched, unused };
}

/** Files on disk that differ from a fresh build (stale or absent). */
export function staleFiles(built, publicDir = PUBLIC) {
  const stale = [];
  for (const [rel, content] of built.files) {
    const path = join(publicDir, rel);
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) stale.push(rel);
  }
  return stale;
}

function main(argv) {
  const built = buildAll();
  if (argv.includes("--missing")) {
    process.stdout.write(`${JSON.stringify(Object.fromEntries(built.missing.map((key) => [key, ""])), null, 2)}\n`);
    return built.missing.length ? 1 : 0;
  }
  const problems = [];
  if (built.missing.length) problems.push(`${built.missing.length} string(s) have no Spanish in i18n/es.json (run with --missing to list them):\n  ${built.missing.slice(0, 20).join("\n  ")}`);
  if (built.mismatched.length) problems.push(`${built.mismatched.length} translation(s) do not keep the English tags or {v} version slots exactly:\n  ${built.mismatched.join("\n  ")}`);
  if (built.unused.length) problems.push(`${built.unused.length} entr(y/ies) in i18n/es.json match no English text any more (the English changed or the entry is stale):\n  ${built.unused.join("\n  ")}`);
  if (argv.includes("--check")) {
    const stale = staleFiles(built);
    if (stale.length) problems.push(`stale, rebuild with \`node tools/build-i18n.mjs\`: ${stale.join(", ")}`);
    if (problems.length) {
      console.error(problems.join("\n\n"));
      return 1;
    }
    console.log(`Spanish build is current: ${built.files.size} files.`);
    return 0;
  }
  if (built.missing.length || built.mismatched.length) {
    console.error(`${problems.join("\n\n")}\n\nNothing was written.`);
    return 1;
  }
  for (const [rel, content] of built.files) {
    const path = join(PUBLIC, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  if (built.unused.length) console.warn(problems.join("\n\n"));
  console.log(`Wrote ${built.files.size} files: ${[...built.files.keys()].join(", ")}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
