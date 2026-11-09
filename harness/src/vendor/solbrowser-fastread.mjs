// Vendored from SolBrowser server/fastread.js at 29d3641 by packaging/tools/sync-solbrowser.mjs.
// Do not edit here: change SolBrowser and sync.
// Fast read lane (D-037): read a url WITHOUT driving the user's browser.
//
// Info gathering does not need a browser most of the time. The benchmark
// (bench/results/summary.md) put a Chromium read at ~1.3-1.5 GB RSS and
// ~600-1500 ms cold, against Lightpanda's 29-67 MB and ~40-55 ms. A plain HTTP
// fetch plus HTML-to-text needs no engine at all. So read_url climbs a ladder,
// cheapest rung first, and only escalates when the page proves it needs more:
//
//   http        Node fetch + the converter below. No JS. Server-rendered pages:
//               articles, docs, wikis, search results, most of the web.
//   lightpanda  Optional. A headless engine that runs JS without rendering.
//               For client-rendered pages (SPAs) when it is installed.
//               No native Windows build (its README: "Install it inside WSL"),
//               so on Windows it is opt-in: SOLBROWSER_LIGHTPANDA=wsl.
//   browser     The user's real Chrome through the extension, in a background
//               tab that is closed afterwards. The only rung with the user's
//               logins, and the one that always works. tools/fastread.js owns it.
//
// This file is pure (no ctx, no MCP) so the selftest can drive it directly.

import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";

export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SolBrowser-read/0.2";

// ------------------------------------------------------------------- http

/**
 * GET a url. -> {status, url (final, after redirects), contentType, body (string)}
 * Only http(s). Redirects are followed manually so the final url is known
 * (a redirect to a login page is how a session wall shows up).
 */
export async function httpGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  let current = normalizeHttpUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => ac.abort(signal.reason);
  signal?.addEventListener?.("abort", onAbort, { once: true });
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = normalizeHttpUrl(new URL(res.headers.get("location"), current).href);
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const contentType = res.headers.get("content-type") || "";
      const bytes = await readCapped(res, MAX_BYTES);
      return { status: res.status, url: current, contentType, body: decode(bytes, contentType) };
    }
    throw new Error(`more than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

export function normalizeHttpUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s) throw new Error("url is required");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`only http(s) urls can be read this way (got ${u.protocol})`);
  return u.href;
}

async function readCapped(res, max) {
  if (!res.body) return new Uint8Array(0);
  const chunks = [];
  let n = 0;
  for await (const chunk of res.body) {
    n += chunk.length;
    if (n > max) {
      chunks.push(chunk.subarray(0, chunk.length - (n - max)));
      break;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Bytes -> string, honouring the header charset, else a <meta charset> sniff, else utf-8. */
function decode(bytes, contentType) {
  let charset = /charset=([^;\s]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ------------------------------------------------------- html -> text

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·",
  bull: "•", laquo: "«", raquo: "»", times: "×", deg: "°", euro: "€", pound: "£", cent: "¢", sect: "§",
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** [start, end) of the element whose open tag starts at `start`, tracking same-name nesting. */
function elementEnd(html, start, name) {
  TAG_RE.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    if (m[2].toLowerCase() !== name) continue;
    const selfClosing = m[3].trimEnd().endsWith("/");
    if (!m[1]) {
      if (!selfClosing) depth++;
      else if (depth === 0) return TAG_RE.lastIndex;
    } else if (--depth === 0) return TAG_RE.lastIndex;
  }
  return html.length; // unclosed: runs to the end, as browsers treat it
}

/** Remove whole elements by tag name (with nesting), e.g. nav/footer in main-content mode. */
function removeElements(html, names) {
  const want = new Set(names);
  let out = "";
  let i = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html))) {
    const name = m[2].toLowerCase();
    if (m[1] || !want.has(name)) continue;
    const start = m.index;
    const end = elementEnd(html, start, name);
    out += html.slice(i, start);
    i = end;
    TAG_RE.lastIndex = end;
  }
  return out + html.slice(i);
}

/** The biggest element matching an opening-tag pattern, as an html slice. */
function biggest(html, openRe) {
  let best = null;
  for (const m of html.matchAll(openRe)) {
    const name = m[1].toLowerCase();
    const end = elementEnd(html, m.index, name);
    if (!best || end - m.index > best.length) best = html.slice(m.index, end);
  }
  return best;
}

const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "ul", "ol", "dl", "table", "thead",
  "tbody", "tfoot", "blockquote", "figure", "figcaption", "form", "fieldset", "details", "summary", "address", "dt", "dd",
]);

/**
 * HTML -> readable text with light markdown (headings, list items, rules).
 * -> {title, text, links?, bodyChars}
 * mainContent: keep the article/main region and drop nav, header, footer,
 * aside and forms, the same intent as extract_text {mainContent}.
 */
export function htmlToText(html, { mainContent = true, baseUrl, links = false } = {}) {
  let src = String(html ?? "");
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(src)?.[1] || "").replace(/\s+/g, " ").trim());

  // Raw-text and invisible elements first: their content can contain "<".
  src = src
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|math|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/i, " ");
  const body = /<body\b[^>]*>([\s\S]*)/i.exec(src)?.[1] ?? src;
  const bodyChars = render(body, {}).text.length;

  let region = body;
  if (mainContent) {
    const article = biggest(body, /<(article)\b[^>]*>/gi);
    const main = biggest(body, /<(main)\b[^>]*>/gi) || biggest(body, /<(\w+)\b[^>]*\brole\s*=\s*["']?main\b[^>]*>/gi);
    const pick = [article, main].find((r) => r && render(r, {}).text.length >= Math.min(500, bodyChars * 0.25));
    // Inside an <article>/<main> the <header> usually holds the headline, so it
    // stays; around a whole <body> it is site chrome.
    const chrome = ["nav", "aside", "form", "button", "select", "footer", ...(pick ? [] : ["header"])];
    region = removeElements(pick || body, chrome);
    // A page that is mostly chrome around very little text: keep everything.
    if (render(region, {}).text.length < Math.min(200, bodyChars * 0.2)) region = body;
  }
  const out = render(region, { baseUrl, links });
  return { title, text: out.text, ...(links ? { links: out.links } : {}), bodyChars };
}

function render(html, { baseUrl, links: wantLinks }) {
  let out = "";
  let pre = 0;
  const links = [];
  const seen = new Set();
  let i = 0;
  TAG_RE.lastIndex = 0;
  let m;
  const text = (s) => {
    let t = decodeEntities(s);
    if (!pre) t = t.replace(/\s+/g, " ");
    out += t;
  };
  while ((m = TAG_RE.exec(html))) {
    text(html.slice(i, m.index));
    i = TAG_RE.lastIndex;
    const close = !!m[1];
    const name = m[2].toLowerCase();
    if (/^h[1-6]$/.test(name)) out += close ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `;
    else if (name === "li") out += close ? "" : "\n- ";
    else if (name === "br") out += "\n";
    else if (name === "hr") out += "\n\n---\n\n";
    else if (name === "tr") out += close ? "" : "\n";
    else if (name === "td" || name === "th") out += close ? "" : " | ";
    else if (name === "pre") {
      pre = Math.max(0, pre + (close ? -1 : 1));
      out += "\n\n";
    } else if (name === "img" && !close) {
      const alt = attr(m[3], "alt");
      if (alt && alt.length > 2) out += ` [image: ${decodeEntities(alt).replace(/\s+/g, " ").trim()}] `;
    } else if (name === "a" && !close && wantLinks) {
      const href = attr(m[3], "href");
      if (href && !/^(javascript:|mailto:|#)/i.test(href)) {
        try {
          const abs = new URL(decodeEntities(href), baseUrl).href;
          if (!seen.has(abs) && links.length < 200) {
            seen.add(abs);
            links.push(abs);
          }
        } catch {}
      }
    } else if (BLOCK.has(name)) out += "\n\n";
  }
  text(html.slice(i));
  const clean = out
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => !/^(-|#+)$/.test(l)) // list markers / heading hashes left with no text
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: clean, links };
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs || "");
  return m ? m[1] ?? m[2] ?? m[3] : null;
}

// ------------------------------------------------------------ verdicts

const LOGIN_PATH = /\/(login|log-in|signin|sign-in|sign_in|auth|sso|oauth2?|session\/new|account\/login|accounts\/login|identifier)\b/i;

/**
 * Does this http result need a higher rung? -> null (good) or {need, reason}
 *   need "session": login wall / forbidden / bot challenge: only the user's browser has the cookies.
 *   need "js":      a client-rendered shell: needs an engine that runs JS.
 */
export function verdict({ status, requestedUrl, finalUrl, html, text, contentType }) {
  const lower = String(html || "").slice(0, 200_000).toLowerCase();
  if (status === 401 || status === 407) return { need: "session", reason: `HTTP ${status} (needs a login)` };
  if (status === 403 || status === 429 || status === 503) {
    if (/cf-chl|challenge-platform|just a moment|captcha|are you a robot|access denied|attention required/.test(lower))
      return { need: "session", reason: `HTTP ${status}: bot challenge` };
    if (status === 403) return { need: "session", reason: "HTTP 403 (forbidden without a session)" };
  }
  if (status >= 400) return { need: "error", reason: `HTTP ${status}` };

  try {
    const from = new URL(requestedUrl);
    const to = new URL(finalUrl);
    if (LOGIN_PATH.test(to.pathname) && !LOGIN_PATH.test(from.pathname)) return { need: "session", reason: `redirected to a sign-in page (${to.host}${to.pathname})` };
    if (to.host !== from.host && /^(login|accounts?|auth|sso|signin|id)\./i.test(to.host)) return { need: "session", reason: `redirected to ${to.host}` };
  } catch {}

  if (!/html|xml/i.test(contentType || "html")) return null;
  const t = String(text || "");
  const scripts = (lower.match(/<script\b/g) || []).length;
  if (/you need to enable javascript|please enable javascript|requires javascript|javascript is (disabled|required)|turn on javascript/.test(lower) && t.length < 1500)
    return { need: "js", reason: "the page asks for JavaScript" };
  if (t.length < 200 && scripts > 0) return { need: "js", reason: `only ${t.length} chars of text without JavaScript (client-rendered)` };
  if (t.length < 600 && /<div[^>]+id=["'](root|app|__next|__nuxt|svelte|main-app)["'][^>]*>\s*<\/div>/.test(lower))
    return { need: "js", reason: "an empty app root (client-rendered)" };
  if (/type=["']password["']/.test(lower) && t.length < 1500 && !LOGIN_PATH.test(String(requestedUrl)))
    return { need: "session", reason: "a sign-in form instead of content" };
  return null;
}

// ----------------------------------------------------------- lightpanda

/**
 * How to run Lightpanda, or null. SOLBROWSER_LIGHTPANDA:
 *   unset   auto: `lightpanda` on PATH (Linux / macOS only)
 *   "wsl"   run it inside WSL (Windows: its only supported route)
 *   a path  that binary
 *   0/off   never
 */
export function lightpandaCommand(env = process.env, platform = process.platform) {
  const v = String(env.SOLBROWSER_LIGHTPANDA ?? "").trim();
  if (/^(0|false|no|off)$/i.test(v)) return null;
  if (/^wsl$/i.test(v)) return { cmd: "wsl.exe", pre: ["-e", "lightpanda"] };
  if (v) return existsSync(v) ? { cmd: v, pre: [] } : null;
  if (platform === "win32") return null; // no native build; opt in with =wsl
  for (const dir of String(env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, "lightpanda"))) return { cmd: join(dir, "lightpanda"), pre: [] };
  }
  return null;
}

/** `lightpanda fetch --dump markdown <url>` -> markdown text. Throws on failure. */
export function lightpandaFetch(url, { timeoutMs = DEFAULT_TIMEOUT_MS, command = lightpandaCommand() } = {}) {
  if (!command) return Promise.reject(new Error("Lightpanda is not available"));
  return new Promise((resolve, reject) => {
    const child = spawn(command.cmd, [...command.pre, "fetch", "--dump", "markdown", normalizeHttpUrl(url)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Lightpanda timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > MAX_BYTES) child.kill();
    });
    child.stderr.on("data", (d) => (errText += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim()) resolve(out.slice(0, MAX_BYTES));
      else reject(new Error(`Lightpanda exited ${code}: ${errText.trim().slice(0, 300)}`));
    });
  });
}

// --------------------------------------------------------------- cache

// Paging a long page with offset should not refetch it. Small and short-lived:
// this is for "read the next chunk", not a crawl cache.
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 16;
const cache = new Map();

export function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

export function cachePut(key, value) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
