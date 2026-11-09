// The sidebar's Browser tabs (+ > Web > Browser): the parts with no DOM in them, so the
// test suite imports this file directly (test/web-tab.test.mjs) and app.js imports the
// very same functions. What a typed address becomes, which addresses a tab may open, and
// what a saved tab list from an older build turns into all live here.
//
// The page itself is shown by the desktop shell (a <webview> in its own session, see
// desktop/browser-tab.mjs). These rules run in the page first, so a bad address is
// refused with a sentence before it reaches the shell, and the shell checks again.

import { t } from "./i18n.mjs";

/** Words typed into the address box go here. DuckDuckGo: no account, no tracking. */
export const SEARCH_URL = "https://duckduckgo.com/?q=";
/** What a new tab opens on. */
export const HOME_URL = "https://duckduckgo.com/";
/** The saved state of every Browser tab (last address and title), by tab id. */
export const WEB_TABS_KEY = "rosalena-web-tabs";
/** The longest title kept for a tab label and for "Send page to chat". */
const TITLE_MAX = 160;
/** The most selected text "Send page to chat" puts in the composer. */
export const SELECTION_MAX = 4000;

const WEB_ID = /^web:[a-z0-9]{1,24}$/;

/** A Browser tab's id: "web:" and a short random name. */
export const isWebTabId = (id) => typeof id === "string" && WEB_ID.test(id);

/** A fresh id that no open tab has. `random` is injectable for the tests. */
export function newWebTabId(taken = [], random = Math.random) {
  const used = new Set(taken);
  for (let i = 0; i < 50; i++) {
    const id = `web:${Math.floor(random() * 36 ** 6).toString(36).padStart(6, "0")}`;
    if (!used.has(id)) return id;
  }
  return `web:${Date.now().toString(36)}`;
}

/** Loopback and private-network hosts: typed bare, they are opened over plain http. */
function isLocalHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(h);
  return Boolean(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

/** "example.com", "example.com/path", "localhost:5173", "10.0.0.2", "[::1]:8080". */
function looksLikeHost(text) {
  if (/\s/.test(text)) return false;
  const host = text.split(/[/?#]/)[0].replace(/:\d{1,5}$/, "");
  if (!host) return false;
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return true;
  if (/^localhost$/i.test(host)) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // A name with a dot and a top-level part of letters: "rosalena.dev", "my-site.co.uk".
  return /^([a-z0-9-]+\.)+[a-z][a-z0-9-]{1,62}$/i.test(host) && !host.startsWith("-");
}

/**
 * What the address box makes of what was typed:
 *   { url, kind: "url" }     an address to open
 *   { url, kind: "search" }  words, sent to the search engine
 *   { error }                something a tab will not open (file:, javascript:, ...)
 *   null                     nothing typed
 */
export function parseAddress(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  if (/^about:blank$/i.test(text)) return { url: "about:blank", kind: "url" };
  // "localhost:5173/x" and "example.com:8080" look like a scheme ("localhost:") but are hosts.
  const hostPort = /^[a-z0-9.-]+:\d{1,5}(?:[/?#]|$)/i.test(text);
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(text)) {
    if (!/^https?:/i.test(text)) return { error: t("A Browser tab opens web pages only (http and https), not {scheme}: addresses.", { scheme: text.split(":")[0].toLowerCase() }) };
    try {
      return { url: new URL(text).href, kind: "url" };
    } catch {
      return { error: t("That address is not a valid web address.") };
    }
  }
  if (!hostPort && !looksLikeHost(text)) return { url: SEARCH_URL + encodeURIComponent(text), kind: "search" };
  const host = text.split(/[/?#]/)[0].replace(/:\d{1,5}$/, "");
  try {
    return { url: new URL(`${isLocalHost(host) ? "http" : "https"}://${text}`).href, kind: "url" };
  } catch {
    return { url: SEARCH_URL + encodeURIComponent(text), kind: "search" };
  }
}

/** The same origin, treating localhost and 127.0.0.1 as one host (the app answers on both). */
export function sameAppOrigin(url, appOrigin) {
  if (!appOrigin) return false;
  try {
    const a = new URL(url);
    const b = new URL(appOrigin);
    const loop = (h) => (h === "localhost" || h === "[::1]" || /^127\./.test(h) ? "loopback" : h);
    return a.protocol === b.protocol && a.port === b.port && loop(a.hostname) === loop(b.hostname);
  } catch {
    return false;
  }
}

/**
 * May a Browser tab show this address? Only web pages: http, https and about:blank. Never
 * a local file, never script or data URLs, never the app's own server (its pages carry
 * the controls of the app), and never an address with a password in it.
 * Returns { ok: true } or { ok: false, reason }.
 */
export function checkWebUrl(url, { appOrigin = "" } = {}) {
  const text = String(url ?? "");
  if (text === "about:blank") return { ok: true };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: t("not a web address") };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: t("{scheme} addresses are not opened in a Browser tab", { scheme: parsed.protocol }) };
  if (parsed.username || parsed.password) return { ok: false, reason: t("addresses with a user name or password in them are not opened") };
  if (sameAppOrigin(text, appOrigin)) return { ok: false, reason: t("the app's own pages are not opened in a Browser tab") };
  return { ok: true };
}

/** What the lock in the address bar says: "secure", "insecure", "local" or "blank". */
export function securityOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === "https:") return "secure";
    if (parsed.protocol === "http:") return isLocalHost(parsed.hostname) ? "local" : "insecure";
    return "blank";
  } catch {
    return "blank";
  }
}

/** A tab's label: its page title, else the site's name, else "Browser". */
export function webTabLabel(entry) {
  const title = String(entry?.title ?? "").trim();
  if (title) return title.length > 28 ? `${title.slice(0, 27)}…` : title;
  try {
    const host = new URL(String(entry?.url ?? "")).hostname.replace(/^www\./, "");
    if (host) return host;
  } catch {
    /* no address yet */
  }
  return t("Browser");
}

/**
 * The saved Browser tabs, cleaned: one entry per open tab id, each with a web address it
 * may open (a stale or unsafe one is reset to the home page) and a clipped title. Accepts
 * the current shape `{ v: 1, tabs: { id: { url, title } } }`, an older bare map, or junk.
 */
export function sanitizeWebState(raw, openIds = [], { appOrigin = "" } = {}) {
  let body = raw;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "null");
    } catch {
      body = null;
    }
  }
  const map = body && typeof body === "object" ? (body.v === 1 && body.tabs && typeof body.tabs === "object" ? body.tabs : body) : {};
  const out = {};
  for (const id of openIds) {
    if (!isWebTabId(id)) continue;
    const entry = map[id] && typeof map[id] === "object" ? map[id] : {};
    const url = typeof entry.url === "string" && checkWebUrl(entry.url, { appOrigin }).ok ? entry.url : HOME_URL;
    const title = typeof entry.title === "string" ? entry.title.slice(0, TITLE_MAX) : "";
    out[id] = { url, title };
  }
  return out;
}

/** The saved form of the Browser tabs' state (empty string = nothing to keep). */
export function serializeWebState(state) {
  const tabs = {};
  for (const [id, entry] of Object.entries(state ?? {})) {
    if (!isWebTabId(id) || !entry?.url) continue;
    tabs[id] = { url: String(entry.url), title: String(entry.title ?? "").slice(0, TITLE_MAX) };
  }
  return Object.keys(tabs).length ? JSON.stringify({ v: 1, tabs }) : "";
}

// ------------------------------------------------------------ the shell's side
//
// desktop/main.mjs imports these too (the packaged app ships harness/ui whole, so this
// file needs no packaging entry of its own). They decide what a <webview> may be and do;
// main.mjs only wires them to Electron's events.

/**
 * The Browser tabs' own session: cookies and logins survive restarts ("persist:"), and
 * none of it is shared with the app's window, so a site never sees the app's storage
 * and the app's page key is never added to a site's requests.
 */
export const BROWSER_PARTITION = "persist:rosalena-browser";

/**
 * `will-attach-webview`: may this <webview> attach, and with what settings? The settings
 * are forced whatever the page asked for: no preload, no Node, context isolation and the
 * sandbox on, and only the Browser tabs' partition. Mutates `webPreferences`, returns
 * { ok, reason }.
 */
export function hardenWebview(webPreferences, params = {}, { appOrigin = "" } = {}) {
  if (params.partition !== BROWSER_PARTITION) return { ok: false, reason: `a webview must use the ${BROWSER_PARTITION} partition` };
  const src = String(params.src ?? "");
  if (src && !checkWebUrl(src, { appOrigin }).ok) return { ok: false, reason: checkWebUrl(src, { appOrigin }).reason };
  for (const key of ["preload", "preloadURL"]) delete webPreferences[key];
  delete params.preload;
  delete webPreferences.enableBlinkFeatures;
  Object.assign(webPreferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    partition: BROWSER_PARTITION,
  });
  return { ok: true };
}

// Asked of the person (once per site and kind, for this launch). Everything not listed
// here or in ALLOWED is refused without asking.
const ASKED = new Map([
  ["media", "use your camera or microphone"],
  ["geolocation", "know your location"],
  ["notifications", "show notifications"],
  ["clipboard-read", "read your clipboard"],
]);
// Harmless and expected by ordinary pages: a video going full screen, a Copy button.
const ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write"]);

/** What a Browser tab's permission request gets: "allow", "ask" (with a sentence) or "deny". */
export function permissionDecision(permission) {
  if (ALLOWED.has(permission)) return { decision: "allow" };
  if (ASKED.has(permission)) return { decision: "ask", what: ASKED.get(permission) };
  return { decision: "deny" };
}

/**
 * The browser session's user agent without "Electron/44.9.1" and the app's own token:
 * several sign-in pages refuse a browser that says it is Electron.
 */
export function cleanUserAgent(agent, names = []) {
  let out = String(agent ?? "");
  // Chromium writes a product name without its spaces ("RosalenaHarness/0.1.13").
  const spellings = ["Electron", ...names.flatMap((name) => (name ? [String(name), String(name).replace(/\s+/g, "")] : []))];
  for (const name of new Set(spellings)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\s${escaped}/\\S+`, "gi"), "");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * "Send page to chat": the page's title and address, and the selected text if any,
 * as composer text the person can still edit before sending.
 */
export function pageToChatText({ url = "", title = "", selection = "" } = {}) {
  const name = String(title).trim().slice(0, TITLE_MAX) || String(url);
  const lines = [`Page: ${name}`, `URL: ${url}`];
  let picked = String(selection ?? "").replace(/\r\n/g, "\n").trim();
  if (picked) {
    if (picked.length > SELECTION_MAX) picked = `${picked.slice(0, SELECTION_MAX)}…`;
    lines.push("", "Selected text:", ...picked.split("\n").map((line) => `> ${line}`));
  }
  return lines.join("\n");
}
