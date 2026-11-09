// Shared helpers for the service-worker modules. No chrome.* listeners here.

export const VERSION = chrome.runtime.getManifest().version;
export const PROTOCOL = 3; // 3: pairing handshake on /ext (D-031)
export const DEFAULT_PORT = 8765;
export const DEBUGGER_PROTOCOL = "1.3";

/** Content-script files, in manifest order. Lazy injection uses the same list (P-006). */
export const CS_FILES = chrome.runtime.getManifest().content_scripts?.[0]?.js || [];

export class ExtError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const errMsg = (e) => String(e?.message || e);

/**
 * Every chrome API that can hang goes through this (D-021). The underlying call
 * keeps running after a timeout; we only stop waiting for it.
 */
export function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new ExtError("TIMEOUT", `${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** Map chrome's tab/target errors to our codes; returns null when it is not one of them. */
export function tabErrorCode(m) {
  if (/no tab with (given )?id|no target with given id|tab .*not found/i.test(m)) return "TAB_GONE";
  return null;
}

const BLOCKED = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|view-source|chrome-search):/i;
const STORE = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

/** Can the debugger and content scripts drive this URL? */
export function isAttachable(url) {
  if (!url) return false;
  if (BLOCKED.test(url) || STORE.test(url)) return false;
  return /^(https?|file|about|data|blob):/i.test(url);
}

// ------------------------------------------------------------- change bus
// Modules call changed() when connection or attach state moves; ui.js listens
// and repaints the badge. A bus instead of an import keeps the graph acyclic.

const changeListeners = new Set();
export const onChanged = (fn) => changeListeners.add(fn);
export function changed() {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch (e) {
      console.warn("[solbrowser] change listener failed:", e);
    }
  }
}

/** Debounce for storage.session writes. */
export function debounce(fn, ms) {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}
