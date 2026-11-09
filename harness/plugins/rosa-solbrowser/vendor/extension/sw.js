// SolBrowser Bridge — MV3 module service worker (protocol 2).
//
// A thin relay on purpose (D-006): generic methods only; tracks add
// content-script ops and server tools, never SW methods. This file holds the
// method table, every chrome.* listener (registered synchronously at top level,
// as MV3 requires) and bootstrap. Logic lives in sw/*.js.
//
// Liveness (D-007, D-021): the server's 20 s ext.ping, a 20 s in-worker tick,
// a 0.5 min alarm, reconnect backoff 250 ms -> 2 s, and the offscreen waker
// that probes /health and wakes a terminated worker.

import * as cdp from "./sw/cdp.js";
import * as frames from "./sw/frames.js";
import { mainWorld } from "./sw/mainworld.js";
import * as tabs from "./sw/tabs.js";
import * as transport from "./sw/transport.js";
import * as ui from "./sw/ui.js";
import { PROTOCOL, VERSION, changed, errMsg, onChanged } from "./sw/util.js";

const ALARM = "solbrowser-keepalive";

let resolveReady;
const ready = new Promise((r) => (resolveReady = r));

const helloParams = () => ({
  version: VERSION,
  protocol: PROTOCOL,
  extensionId: chrome.runtime.id,
  attachedTabs: cdp.attachedTabIds(),
});

transport.configure({
  ready,
  hello: helloParams,
  methods: {
    "ext.ping": async () => ({ pong: true, version: VERSION, protocol: PROTOCOL, attachedTabs: cdp.attachedTabIds() }),
    "ext.tabs": tabs.tabs,
    "ext.windows": tabs.windows,
    "ext.attach": async ({ tabId }) => cdp.attach(Number.isInteger(tabId) ? tabId : (await tabs.activeTab())?.id),
    "ext.detach": ({ tabId }) => cdp.detach(tabId),
    "ext.cdp": cdp.cdp,
    "ext.cdpBatch": cdp.cdpBatch,
    "ext.subscribe": cdp.subscribe,
    "ext.frames": frames.frames,
    "ext.frameCall": frames.frameCall,
    "ext.frameCallAll": frames.frameCallAll,
    "ext.mainWorld": mainWorld,
  },
});

onChanged(ui.setBadge);

// ------------------------------------------------------- listeners (top level)

chrome.runtime.onInstalled.addListener(() => transport.connectNow());
chrome.runtime.onStartup.addListener(() => transport.connectNow());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || msg.target === "offscreen") return false;

  // Content script loaded in a frame: feeds the frame registry. No reply.
  if (msg.cs === "hello") {
    frames.onHello(sender);
    return false;
  }

  if (msg.op === "wake") {
    // From the offscreen waker. Receiving it already woke us; connect now.
    ready.then(() => {
      transport.connectNow();
      sendResponse({ connected: transport.isOpen(), port: transport.getPort() });
    });
    return true;
  }

  if (msg.op === "offscreenConfig") {
    // The waker asks for the port once its listener is up (pushes before that are lost).
    ready.then(() => sendResponse({ port: transport.getPort() }));
    return true;
  }

  if (msg.op === "reconnect") {
    ready
      .then(() => transport.reconnect())
      .then((r) => {
        ui.pushOffscreenConfig();
        sendResponse({ ok: true, ...r });
      })
      .catch((e) => sendResponse({ error: errMsg(e) }));
    return true;
  }

  if (typeof msg.op === "string" && msg.op.startsWith("ui.")) {
    ready
      .then(() => ui.handleUi(msg))
      .then(sendResponse)
      .catch((e) => sendResponse({ error: errMsg(e) }));
    return true;
  }
  return false;
});

chrome.debugger.onEvent.addListener((source, method, params) => cdp.onDebuggerEvent(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => {
  console.warn("[solbrowser] debugger detached:", source.tabId, reason);
  cdp.onDebuggerDetach(source, reason);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  frames.onTabRemoved(tabId);
  if (cdp.onTabRemoved(tabId)) transport.sendEvent("tabGone", { tabId });
});

chrome.webNavigation.onCommitted.addListener((d) => frames.onCommitted(d));
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => frames.onSameDocument(d));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => frames.onSameDocument(d));
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => tabs.onCreatedNavigationTarget(d));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  transport.connectNow(); // the slow path: skip backoff
  ui.ensureOffscreen();
});

// Tests set chrome.storage.local.port; reconnect to the new port immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !("port" in changes)) return;
  ready.then(() => transport.reconnect()).then(() => ui.pushOffscreenConfig());
});

// In-worker tick: an extension API call resets the idle timer (D-007), and a
// silent half-open socket is dropped.
setInterval(() => {
  chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  transport.checkLiveness();
}, 20_000);

// Debug/test hook for launchers driving the worker via Playwright's sw.evaluate.
globalThis.solbrowser = {
  reconnect: () => transport.reconnect(),
  state: () => ({
    connected: transport.isOpen(),
    port: transport.getPort(),
    authError: transport.getAuthError(),
    paused: transport.isPaused(),
    version: VERSION,
    protocol: PROTOCOL,
    attachedTabs: cdp.attachedTabIds(),
  }),
};

// ------------------------------------------------------------------ bootstrap

async function init() {
  try {
    // Only create if missing: create() on an existing alarm restarts its
    // schedule, pushing the backstop out on every wake.
    if (!(await chrome.alarms.get(ALARM))) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  } catch (e) {
    console.warn("[solbrowser] alarm setup failed:", e);
  }
  await Promise.all([transport.loadPort(), transport.loadPaused()]);
  await Promise.all([cdp.restore(), frames.restore()]);
}

init()
  .catch((e) => console.warn("[solbrowser] init failed:", e))
  .finally(() => {
    resolveReady();
    changed();
    transport.connect();
    ui.ensureOffscreen().then(() => ui.pushOffscreenConfig());
  });
