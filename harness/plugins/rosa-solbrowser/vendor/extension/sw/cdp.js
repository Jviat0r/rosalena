// chrome.debugger: many tabs at once (D-022), CDP relay, pipelined batches,
// event subscriptions. Attach state lives in chrome.storage.session so a
// restarted worker resumes (D-007, P-017: an extension RELOAD still wipes it).

import { sendEvent } from "./transport.js";
import { DEBUGGER_PROTOCOL, ExtError, changed, debounce, errMsg, tabErrorCode, withTimeout } from "./util.js";

const ATTACH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;
const CDP_TIMEOUT_MS = 30_000;
const STORE_KEY = "attached"; // { [tabId]: {attachedAt, methods:[...]} }

/** tabId -> {attachedAt} */
export const attached = new Map();
/** tabId -> Set of CDP event names forwarded as cdpEvent */
const subscriptions = new Map();
/** tabId -> in-flight attach promise (dedupes concurrent attaches) */
const attaching = new Map();

export const attachedTabIds = () => [...attached.keys()];
export const isAttached = (tabId) => attached.has(tabId);

const persist = debounce(() => {
  const obj = {};
  for (const [tabId, info] of attached) {
    obj[tabId] = { attachedAt: info.attachedAt, methods: [...(subscriptions.get(tabId) || [])] };
  }
  chrome.storage.session.set({ [STORE_KEY]: obj }).catch((e) => console.warn("[solbrowser] persist failed:", e));
}, 50);

function forget(tabId) {
  const had = attached.delete(tabId);
  subscriptions.delete(tabId);
  if (had) {
    persist();
    changed();
  }
  return had;
}

/** Is the debugger session on this tab OURS? Only we can send commands on it (P-022). */
async function ownsDebugger(tabId) {
  try {
    await withTimeout(chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree"), PROBE_TIMEOUT_MS, "debugger probe");
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach, tolerating a session that is already ours (worker restarted
 * mid-session). Ownership is decided by behaviour, never by the error string:
 * "Another debugger is already attached" is what Chrome says when WE hold it,
 * "Cannot attach to this target." is a foreign owner such as DevTools (P-022).
 */
async function ensureDebugger(tabId) {
  // A6: DeveloperToolsAvailability=2 removes or disables chrome.debugger entirely.
  if (!chrome.debugger?.attach) throw new ExtError("DEBUGGER_BLOCKED_BY_POLICY", "chrome.debugger is unavailable (blocked by browser policy).");
  if (await ownsDebugger(tabId)) return;
  try {
    await withTimeout(chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL), ATTACH_TIMEOUT_MS, "debugger.attach");
    return;
  } catch (e) {
    const m = errMsg(e);
    if (await ownsDebugger(tabId)) return;
    if (e?.code === "TIMEOUT") throw e;
    if (tabErrorCode(m)) throw new ExtError("TAB_GONE", m);
    if (/policy|DeveloperToolsAvailability|devtools.*disabled/i.test(m)) throw new ExtError("DEBUGGER_BLOCKED_BY_POLICY", m);
    if (/another debugger|already attached|cannot attach to this target|restricted/i.test(m)) {
      throw new ExtError("DEBUGGER_CONFLICT", m); // P-007
    }
    if (/cannot access|chrome:\/\/|chrome-extension:\/\//i.test(m)) {
      throw new ExtError("BAD_ARGS", `${m} — chrome:// pages, the Web Store and other extensions cannot be driven.`);
    }
    throw new ExtError("EXTENSION_ERROR", m);
  }
}

async function tabSummary(tabId) {
  const t = await withTimeout(chrome.tabs.get(tabId), 2000, "tabs.get").catch(() => null);
  return { tabId, title: t?.title ?? null, url: t?.url || t?.pendingUrl || null };
}

export async function attach(tabId) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "attach needs an integer tabId");
  let p = attaching.get(tabId);
  if (!p) {
    p = (async () => {
      const already = attached.has(tabId);
      await ensureDebugger(tabId);
      if (!already) {
        attached.set(tabId, { attachedAt: Date.now() });
        persist();
        changed();
      }
      return { ...(await tabSummary(tabId)), alreadyAttached: already };
    })().finally(() => attaching.delete(tabId));
    attaching.set(tabId, p);
  }
  return p;
}

export async function detach(tabId) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "detach needs an integer tabId");
  const info = await tabSummary(tabId);
  const was = forget(tabId);
  try {
    await withTimeout(chrome.debugger.detach({ tabId }), ATTACH_TIMEOUT_MS, "debugger.detach");
  } catch {
    // Not attached, or the tab is gone: either way it is detached now.
  }
  return { ...info, wasAttached: was };
}

function requireAttached(tabId) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "tabId (integer) is required");
  if (!attached.has(tabId)) throw new ExtError("NO_TAB_ATTACHED", `tab ${tabId} is not attached`);
}

/**
 * Does the debugger session on this tab survive? A probe can hit the same
 * renderer swap that failed the command, so the session is dead only if it
 * fails three probes over ~0.6 s (P-039, P-049). A dead one is forgotten and
 * reported once.
 */
async function sessionSurvives(tabId) {
  for (let i = 0; i < 3; i++) {
    if (await ownsDebugger(tabId)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (forget(tabId)) sendEvent("debuggerDetached", { tabId, reason: "lost" });
  return false;
}

function mapCdpError(tabId, method, e) {
  if (e?.code === "TIMEOUT") return e;
  const m = errMsg(e);
  // "Detached while handling command." is ALSO what a command in flight gets
  // when a navigation swaps the page's renderer, while the tab's debugger
  // session survives. Forgetting the tab on it dropped live tabs after link
  // clicks; probe ownership first (P-022 style) and forget only a dead session.
  if (/detached while handling/i.test(m)) {
    sessionSurvives(tabId);
    return new ExtError("CDP_ERROR", `${method}: ${m} (the page swapped documents mid-command; retry)`);
  }
  if (tabErrorCode(m)) return new ExtError("TAB_GONE", m);
  return new ExtError("CDP_ERROR", `${method}: ${m}`);
}

function sendOnce(tabId, method, params, sessionId, timeoutMs) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  return withTimeout(chrome.debugger.sendCommand(target, method, params || {}), timeoutMs || CDP_TIMEOUT_MS, `CDP ${method}`).then((r) => r ?? {});
}

async function send(tabId, method, params, sessionId, timeoutMs) {
  try {
    return await sendOnce(tabId, method, params, sessionId, timeoutMs);
  } catch (e) {
    // "Not attached to an active page" is what a command gets while the tab
    // swaps documents (a failed navigation committing its chrome-error page,
    // ~50 ms) even though our session lives on (P-049). Chrome refused it
    // before dispatch, so it never ran: if the session survives, send it once
    // more; only a session that fails the probes is DEBUGGER_DETACHED.
    const notAttached = (x) => x?.code !== "TIMEOUT" && /not attached/i.test(errMsg(x));
    if (!notAttached(e)) throw mapCdpError(tabId, method, e);
    const between = new ExtError("CDP_ERROR", `${method}: ${errMsg(e)} (the page is between documents; retry)`);
    if (sessionId) {
      // A child (OOPIF) session that ended: check the tab's own in the background.
      sessionSurvives(tabId);
      throw between;
    }
    if (!(await sessionSurvives(tabId))) throw new ExtError("DEBUGGER_DETACHED", errMsg(e));
    // Pipelined input (a click's three events) must not be re-sent out of order.
    if (method.startsWith("Input.")) throw between;
    try {
      return await sendOnce(tabId, method, params, sessionId, timeoutMs);
    } catch (e2) {
      throw notAttached(e2) ? between : mapCdpError(tabId, method, e2);
    }
  }
}

/** ext.cdp {tabId, method, params, sessionId?, timeoutMs?} */
export async function cdp({ tabId, method, params, sessionId, timeoutMs }) {
  requireAttached(tabId);
  if (typeof method !== "string" || !method) throw new ExtError("BAD_ARGS", "method is required");
  return send(tabId, method, params, sessionId, timeoutMs);
}

/**
 * ext.cdpBatch {tabId, commands:[{method,params,sessionId?}], timeoutMs?, pipeline?:true}
 * -> [{ok:true,result} | {ok:false,error:{code,message}}]
 * Pipelined: every command is sent before any is awaited. chrome.debugger keeps
 * per-session order, so a click's mouseMoved/Pressed/Released stay in order.
 */
export async function cdpBatch({ tabId, commands, timeoutMs, pipeline = true }) {
  requireAttached(tabId);
  if (!Array.isArray(commands)) throw new ExtError("BAD_ARGS", "commands must be an array");
  const wrap = (p) =>
    p.then(
      (result) => ({ ok: true, result }),
      (e) => ({ ok: false, error: { code: e?.code || "CDP_ERROR", message: errMsg(e) } })
    );
  if (pipeline) {
    return Promise.all(commands.map((c) => wrap(send(tabId, c.method, c.params, c.sessionId, timeoutMs))));
  }
  const out = [];
  for (const c of commands) out.push(await wrap(send(tabId, c.method, c.params, c.sessionId, timeoutMs)));
  return out;
}

/** ext.subscribe {tabId, methods:[...], replace?} -> {tabId, methods} (additive unless replace) */
export async function subscribe({ tabId, methods, replace = false }) {
  requireAttached(tabId);
  if (!Array.isArray(methods)) throw new ExtError("BAD_ARGS", "methods must be an array of CDP event names");
  let set = subscriptions.get(tabId);
  if (!set || replace) subscriptions.set(tabId, (set = new Set()));
  for (const m of methods) if (typeof m === "string" && m) set.add(m);
  persist();
  return { tabId, methods: [...set] };
}

// ------------------------------------------------------- listener bodies
// sw.js registers the listeners at top level and calls these.

/**
 * A7: trim what no server tool reads before it crosses the WebSocket, so busy
 * tabs cannot flood it (Playwriter #96: 43 MB of logs). Headers, post bodies,
 * TLS details and initiator stacks are dropped; url, method, status, mimeType,
 * sizes, type, timing, errorText and every id stay. Console args keep their
 * value/description/preview (buffers.js formats them); objectIds are useless
 * to the server and are dropped.
 */
const HEAVY_REQUEST = ["headers", "postData", "postDataEntries", "trustTokenParams"];
const HEAVY_RESPONSE = ["headers", "headersText", "requestHeaders", "requestHeadersText", "securityDetails"];
function trimEvent(method, params) {
  if (!params || typeof params !== "object") return params;
  if (method.startsWith("Network.")) {
    const p = { ...params };
    delete p.initiator;
    delete p.headers; // responseReceivedExtraInfo / requestWillBeSentExtraInfo
    delete p.associatedCookies;
    if (p.request) {
      p.request = { ...p.request };
      for (const k of HEAVY_REQUEST) delete p.request[k];
    }
    for (const key of ["response", "redirectResponse"]) {
      if (!p[key]) continue;
      p[key] = { ...p[key] };
      for (const k of HEAVY_RESPONSE) delete p[key][k];
    }
    return p;
  }
  if (method === "Runtime.consoleAPICalled" && Array.isArray(params.args)) {
    return { ...params, args: params.args.slice(0, 20).map(({ objectId, ...a }) => a) };
  }
  return params;
}

export function onDebuggerEvent(source, method, params) {
  const set = subscriptions.get(source.tabId);
  if (!set || !(set.has(method) || set.has("*"))) return;
  const ev = { tabId: source.tabId, method, params: trimEvent(method, params) };
  if (source.sessionId) ev.sessionId = source.sessionId;
  sendEvent("cdpEvent", ev);
}

/** Tabs whose debugger went away with reason target_closed: tabs.onRemoved may come next. */
const closedTargets = new Set();

export function onDebuggerDetach(source, reason) {
  if (!forget(source.tabId)) return;
  if (reason === "target_closed") {
    closedTargets.add(source.tabId);
    setTimeout(() => closedTargets.delete(source.tabId), 5000);
  }
  sendEvent("debuggerDetached", { tabId: source.tabId, reason });
}

/** @returns true when the tab was ours, so the caller reports tabGone. */
export function onTabRemoved(tabId) {
  attaching.delete(tabId);
  // onDetach(target_closed) and tabs.onRemoved arrive in either order.
  const viaDetach = closedTargets.delete(tabId);
  return forget(tabId) || viaDetach;
}

/** Restore attach state after a worker restart. Tabs that cannot be re-attached are dropped. */
export async function restore() {
  let saved = {};
  try {
    saved = (await chrome.storage.session.get(STORE_KEY))[STORE_KEY] || {};
  } catch (e) {
    console.warn("[solbrowser] attach-state restore failed:", e);
  }
  await Promise.all(
    Object.entries(saved).map(async ([key, info]) => {
      const tabId = Number(key);
      try {
        await ensureDebugger(tabId);
        attached.set(tabId, { attachedAt: info?.attachedAt || Date.now() });
        if (info?.methods?.length) subscriptions.set(tabId, new Set(info.methods));
      } catch {
        // Tab gone or taken over while we were down; the server learns from hello.
      }
    })
  );
  persist();
  changed();
}
