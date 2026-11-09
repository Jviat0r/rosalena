// Frame registry + content-script calls (D-002, P-006).
//
// The registry is fed by webNavigation.onCommitted and by each content
// script's {cs:"hello"} (frameId and documentId from the sender). A frame is
// "responding" when its CURRENT document said hello, so ext.frames needs no
// pings. A frame that never said hello (tab predates the extension, or the
// worker missed it) gets content/*.js injected on first use, with
// injectImmediately and a 1 s timeout.

import { isAttached } from "./cdp.js";
import { sendEvent } from "./transport.js";
import { CS_FILES, ExtError, debounce, errMsg, tabErrorCode, withTimeout } from "./util.js";

const INJECT_TIMEOUT_MS = 1000;
const GET_FRAMES_TIMEOUT_MS = 2000;
const PING_TIMEOUT_MS = 500;
const DEFAULT_CALL_TIMEOUT_MS = 5000;
const STORE_KEY = "frames"; // { [tabId]: { [frameId]: entry } }

/** tabId -> Map<frameId, {frameId, parentFrameId, url, documentId, helloDoc}> */
const registry = new Map();
/** `${tabId}:${frameId}:${documentId}` -> in-flight injection */
const injecting = new Map();

const persist = debounce(() => {
  const obj = {};
  for (const [tabId, frames] of registry) obj[tabId] = Object.fromEntries(frames);
  chrome.storage.session.set({ [STORE_KEY]: obj }).catch(() => {});
}, 250);

function tabFrames(tabId) {
  let m = registry.get(tabId);
  if (!m) registry.set(tabId, (m = new Map()));
  return m;
}

function upsert(tabId, frameId, patch) {
  const frames = tabFrames(tabId);
  const cur = frames.get(frameId) || { frameId, parentFrameId: null, url: null, documentId: null, helloDoc: null };
  Object.assign(cur, patch);
  frames.set(frameId, cur);
  persist();
  return cur;
}

const responding = (e) => !!e && e.helloDoc != null && e.helloDoc === e.documentId;

// ------------------------------------------------------- listener bodies

/** runtime.onMessage {cs:"hello"} from a content script. */
export function onHello(sender) {
  const tabId = sender.tab?.id;
  if (tabId == null || sender.frameId == null) return;
  const doc = sender.documentId ?? `hello-${Date.now()}`;
  const patch = { documentId: doc, helloDoc: doc };
  if (sender.url) patch.url = sender.url;
  if (sender.frameId === 0) patch.parentFrameId = -1;
  upsert(tabId, sender.frameId, patch);
}

function skipLifecycle(d) {
  return d.documentLifecycle === "prerender" || (d.frameType && d.frameType === "fenced_frame");
}

/** webNavigation.onCommitted: a new document in a frame. */
export function onCommitted(d) {
  if (skipLifecycle(d)) return;
  const cur = registry.get(d.tabId)?.get(d.frameId);
  // A hello can beat the commit event; keep it only if it is for THIS document.
  const helloDoc = cur && d.documentId && cur.helloDoc === d.documentId ? cur.helloDoc : null;
  upsert(d.tabId, d.frameId, {
    parentFrameId: d.parentFrameId ?? cur?.parentFrameId ?? null,
    url: d.url,
    documentId: d.documentId ?? `commit-${Date.now()}`,
    helloDoc,
  });
  if (isAttached(d.tabId)) sendEvent("frameNavigated", { tabId: d.tabId, frameId: d.frameId, parentFrameId: d.parentFrameId, url: d.url });
}

/** webNavigation.onHistoryStateUpdated / onReferenceFragmentUpdated: same document, new URL. */
export function onSameDocument(d) {
  if (skipLifecycle(d)) return;
  const cur = registry.get(d.tabId)?.get(d.frameId);
  if (cur) {
    cur.url = d.url;
    persist();
  }
  if (isAttached(d.tabId)) sendEvent("frameNavigated", { tabId: d.tabId, frameId: d.frameId, url: d.url, sameDocument: true });
}

export function onTabRemoved(tabId) {
  if (registry.delete(tabId)) persist();
}

export async function restore() {
  try {
    const saved = (await chrome.storage.session.get(STORE_KEY))[STORE_KEY] || {};
    for (const [tabKey, frames] of Object.entries(saved)) {
      const tabId = Number(tabKey);
      const live = tabFrames(tabId);
      for (const [fKey, entry] of Object.entries(frames || {})) {
        const frameId = Number(fKey);
        // Hellos that arrived while we were restoring are newer: keep them.
        if (!live.has(frameId)) live.set(frameId, entry);
      }
    }
  } catch (e) {
    console.warn("[solbrowser] frame-registry restore failed:", e);
  }
}

// ---------------------------------------------------------------- frames

/**
 * Authoritative frame list: webNavigation.getAllFrames (one browser-side call,
 * no pings) merged with hello state. Prunes frames that no longer exist.
 */
async function liveFrames(tabId) {
  let nav;
  try {
    nav = await withTimeout(chrome.webNavigation.getAllFrames({ tabId }), GET_FRAMES_TIMEOUT_MS, "webNavigation.getAllFrames");
  } catch (e) {
    if (tabErrorCode(errMsg(e))) throw new ExtError("TAB_GONE", errMsg(e));
    nav = null; // timeout: fall back to the registry
  }
  const frames = tabFrames(tabId);
  if (!nav) return [...frames.values()];

  const seen = new Set();
  const out = [];
  for (const f of nav) {
    if (f.documentLifecycle && f.documentLifecycle !== "active") continue;
    seen.add(f.frameId);
    const cur = frames.get(f.frameId);
    const docId = f.documentId ?? cur?.documentId ?? null;
    const entry = upsert(tabId, f.frameId, {
      parentFrameId: f.parentFrameId,
      url: f.url,
      documentId: docId,
      helloDoc: cur?.helloDoc ?? null,
    });
    out.push(entry);
  }
  for (const id of [...frames.keys()]) if (!seen.has(id)) frames.delete(id);
  persist();
  return out;
}

async function pingFrame(tabId, frameId) {
  try {
    const res = await withTimeout(chrome.tabs.sendMessage(tabId, { op: "ping", args: {} }, { frameId }), PING_TIMEOUT_MS, "cs.ping");
    return !!res?.result?.pong;
  } catch {
    return false;
  }
}

/** Inject content/*.js into one frame (idempotent on the page side, P-006). Deduped per document. */
function inject(tabId, frameId) {
  const doc = registry.get(tabId)?.get(frameId)?.documentId ?? "?";
  const key = `${tabId}:${frameId}:${doc}`;
  let p = injecting.get(key);
  if (p) return p;
  p = withTimeout(
    chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: CS_FILES, injectImmediately: true }),
    INJECT_TIMEOUT_MS,
    `inject frame ${frameId}`
  )
    .then((results) => {
      const r = results?.[0];
      upsert(tabId, frameId, { documentId: r?.documentId ?? doc, helloDoc: r?.documentId ?? doc });
      return true;
    })
    .catch((e) => {
      const m = errMsg(e);
      if (tabErrorCode(m)) throw new ExtError("TAB_GONE", m);
      throw new ExtError("FRAME_NOT_RESPONDING", `frame ${frameId}: content script could not be injected: ${m}`);
    })
    .finally(() => injecting.delete(key));
  injecting.set(key, p);
  return p;
}

async function ensureFrame(tabId, frameId) {
  if (responding(registry.get(tabId)?.get(frameId))) return;
  await inject(tabId, frameId);
}

/** ext.frames {tabId, probe?} -> [{frameId, parentFrameId, url, responding}] */
export async function frames({ tabId, probe = false }) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "tabId (integer) is required");
  const list = await liveFrames(tabId);
  if (probe) {
    await Promise.all(
      list.map(async (f) => {
        if (await pingFrame(tabId, f.frameId)) {
          f.helloDoc = f.documentId;
          return;
        }
        try {
          await inject(tabId, f.frameId);
        } catch {
          f.helloDoc = null;
        }
      })
    );
  }
  return list.map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url, responding: responding(f) }));
}

/**
 * Ref numbers continue across a frame's documents (P-051): every op carries
 * the highest ref this frame has handed out (refBase) and every answer says
 * the current one (maxRef), so a new document starts numbering above it.
 */
async function sendOnce(tabId, frameId, op, args, timeoutMs) {
  const refBase = registry.get(tabId)?.get(frameId)?.refMax || 0;
  const res = await withTimeout(chrome.tabs.sendMessage(tabId, { op, args: args || {}, refBase }, { frameId }), timeoutMs, `cs.${op}`);
  if (Number.isInteger(res?.maxRef) && res.maxRef > refBase) upsert(tabId, frameId, { refMax: res.maxRef });
  return res;
}

/** ext.frameCall {tabId, frameId, op, args, timeoutMs?} -> op result */
export async function frameCall({ tabId, frameId = 0, op, args, timeoutMs }) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "tabId (integer) is required");
  if (typeof op !== "string" || !op) throw new ExtError("BAD_ARGS", "op is required");
  const budget = timeoutMs || DEFAULT_CALL_TIMEOUT_MS;

  await ensureFrame(tabId, frameId);
  let res;
  try {
    res = await sendOnce(tabId, frameId, op, args, budget);
  } catch (e) {
    const m = errMsg(e);
    if (e?.code === "TIMEOUT") throw new ExtError("TIMEOUT", `frame ${frameId} did not answer op ${op} in ${budget}ms`);
    if (tabErrorCode(m)) throw new ExtError("TAB_GONE", m);
    if (/receiving end does not exist|could not establish connection/i.test(m)) {
      // Registry was stale (navigation the worker slept through): inject, retry once.
      const e2 = registry.get(tabId)?.get(frameId);
      if (e2) e2.helloDoc = null;
      await inject(tabId, frameId);
      try {
        res = await sendOnce(tabId, frameId, op, args, budget);
      } catch (e3) {
        if (e3?.code === "TIMEOUT") throw new ExtError("TIMEOUT", `frame ${frameId} did not answer op ${op} in ${budget}ms`);
        throw new ExtError("FRAME_NOT_RESPONDING", `frame ${frameId}: ${errMsg(e3)}`);
      }
    } else {
      // e.g. "message port closed": the frame navigated away mid-call.
      throw new ExtError("FRAME_NOT_RESPONDING", `frame ${frameId}: ${m}`);
    }
  }
  if (!res) throw new ExtError("FRAME_NOT_RESPONDING", `frame ${frameId} returned nothing for op ${op}`);
  if (res.ok === false) throw new ExtError(res.error?.code || "EXTENSION_ERROR", res.error?.message || `op ${op} failed`);
  return res.result ?? {};
}

/**
 * ext.frameCallAll {tabId, op, args, timeoutMs?, mode: all|first, frameIds?}
 * all   -> [{frameId, ok, result|error}] for every frame
 * first -> [{frameId, ok:true, result}] as soon as one result has found:true;
 *          if none does, every entry (so errors stay visible)
 */
export async function frameCallAll({ tabId, op, args, timeoutMs, mode = "all", frameIds }) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "tabId (integer) is required");
  let list = await liveFrames(tabId);
  if (Array.isArray(frameIds)) list = list.filter((f) => frameIds.includes(f.frameId));

  const calls = list.map((f) =>
    frameCall({ tabId, frameId: f.frameId, op, args, timeoutMs }).then(
      (result) => ({ frameId: f.frameId, ok: true, result }),
      (e) => ({ frameId: f.frameId, ok: false, error: { code: e?.code || "EXTENSION_ERROR", message: errMsg(e) } })
    )
  );
  if (mode !== "first") return Promise.all(calls);

  return new Promise((resolve) => {
    let done = false;
    for (const c of calls) {
      c.then((r) => {
        if (!done && r.ok && r.result?.found === true) {
          done = true;
          resolve([r]);
        }
      });
    }
    Promise.all(calls).then((all) => {
      if (!done) resolve(all);
    });
  });
}
