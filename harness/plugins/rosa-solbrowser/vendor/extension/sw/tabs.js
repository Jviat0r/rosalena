// ext.tabs / ext.windows and tab lifecycle events (D-022).

import { attached, isAttached } from "./cdp.js";
import { sendEvent } from "./transport.js";
import { ExtError, errMsg, isAttachable, tabErrorCode, withTimeout } from "./util.js";

const TABS_TIMEOUT_MS = 5000;

const t = (p, label) =>
  withTimeout(p, TABS_TIMEOUT_MS, label).catch((e) => {
    if (e?.code) throw e;
    const m = errMsg(e);
    throw new ExtError(tabErrorCode(m) || "EXTENSION_ERROR", m);
  });

async function lastFocusedWindowId() {
  try {
    const w = await withTimeout(chrome.windows.getLastFocused({ windowTypes: ["normal"] }), TABS_TIMEOUT_MS, "windows.getLastFocused");
    return w?.id ?? null;
  } catch {
    return null;
  }
}

export function tabInfo(tab, focusedWindowId) {
  const url = tab.url || tab.pendingUrl || "";
  const info = {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    url,
    active: !!tab.active,
    attached: attached.has(tab.id),
    attachable: isAttachable(url),
    status: tab.status,
  };
  if (focusedWindowId != null) info.focused = !!tab.active && tab.windowId === focusedWindowId;
  if (tab.openerTabId != null) info.openerTabId = tab.openerTabId;
  if (tab.groupId != null && tab.groupId !== -1) info.groupId = tab.groupId;
  return info;
}

/** Active tab of the last focused normal window (popup Connect, server auto-attach). */
export async function activeTab() {
  const winId = await lastFocusedWindowId();
  let tabs = [];
  if (winId != null) tabs = await t(chrome.tabs.query({ active: true, windowId: winId }), "tabs.query");
  if (!tabs.length) tabs = await t(chrome.tabs.query({ active: true, lastFocusedWindow: true }), "tabs.query");
  if (!tabs.length) tabs = await t(chrome.tabs.query({ active: true }), "tabs.query");
  return tabs[0] || null;
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) throw new ExtError("BAD_ARGS", "tabId (integer) is required");
  return t(chrome.tabs.get(tabId), "tabs.get");
}

async function applyGroup(tabId, group) {
  if (group == null || group === false) return;
  if (!chrome.tabs.group) return;
  const opts = { tabIds: [tabId] };
  if (Number.isInteger(group)) opts.groupId = group;
  await t(chrome.tabs.group(opts), "tabs.group").catch(() => {}); // grouping is cosmetic
}

/** ext.tabs {action: list|create|close|activate|get|update, tabId?, url?, active?, group?} */
export async function tabs({ action = "list", tabId, url, active, group }) {
  switch (action) {
    case "list": {
      const [all, focusedId] = await Promise.all([t(chrome.tabs.query({}), "tabs.query"), lastFocusedWindowId()]);
      return all.map((tab) => tabInfo(tab, focusedId));
    }
    case "get": {
      // zoom: Chrome page zoom (Ctrl +/-). Screenshot clips are in zoomed DIPs (P-048).
      const [tab, focusedId, zoom] = await Promise.all([
        getTab(tabId),
        lastFocusedWindowId(),
        chrome.tabs.getZoom ? withTimeout(chrome.tabs.getZoom(tabId), TABS_TIMEOUT_MS, "tabs.getZoom").catch(() => null) : null,
      ]);
      const info = tabInfo(tab, focusedId);
      if (Number.isFinite(zoom)) info.zoom = zoom;
      return info;
    }
    case "create": {
      const opts = { url: url || "about:blank", active: active ?? true };
      const winId = await lastFocusedWindowId();
      let tab;
      if (winId != null) {
        tab = await t(chrome.tabs.create({ ...opts, windowId: winId }), "tabs.create");
      } else {
        const w = await t(chrome.windows.create({ url: opts.url, focused: opts.active, type: "normal" }), "windows.create");
        tab = w.tabs?.[0];
        if (!tab) throw new ExtError("EXTENSION_ERROR", "window created without a tab");
      }
      await applyGroup(tab.id, group);
      return tabInfo(tab, winId);
    }
    case "close": {
      await getTab(tabId);
      await t(chrome.tabs.remove(tabId), "tabs.remove");
      return { tabId, closed: true };
    }
    case "activate": {
      const tab = await getTab(tabId);
      const updated = await t(chrome.tabs.update(tabId, { active: true }), "tabs.update");
      await t(chrome.windows.update(tab.windowId, { focused: true }), "windows.update").catch(() => {});
      return tabInfo(updated, tab.windowId);
    }
    case "update": {
      await getTab(tabId);
      const props = {};
      if (url != null) props.url = url;
      if (active != null) props.active = !!active;
      const updated = await t(chrome.tabs.update(tabId, props), "tabs.update");
      await applyGroup(tabId, group);
      return tabInfo(updated, await lastFocusedWindowId());
    }
    default:
      throw new ExtError("BAD_ARGS", `unknown tabs action "${action}"`);
  }
}

const windowInfo = (w) => ({ windowId: w.id, width: w.width, height: w.height, left: w.left, top: w.top, state: w.state, focused: w.focused });

/** ext.windows {action: resize|get, tabId, width?, height?} */
export async function windows({ action = "get", tabId, width, height }) {
  const tab = await getTab(tabId);
  if (action === "get") return windowInfo(await t(chrome.windows.get(tab.windowId), "windows.get"));
  if (action === "resize") {
    const props = { state: "normal" };
    if (Number.isFinite(width)) props.width = Math.round(width);
    if (Number.isFinite(height)) props.height = Math.round(height);
    return windowInfo(await t(chrome.windows.update(tab.windowId, props), "windows.update"));
  }
  throw new ExtError("BAD_ARGS", `unknown windows action "${action}"`);
}

// ------------------------------------------------------- listener bodies

/** webNavigation.onCreatedNavigationTarget: popups / target=_blank opened by an attached tab. */
export function onCreatedNavigationTarget(d) {
  if (!isAttached(d.sourceTabId)) return;
  sendEvent("tabCreated", { tabId: d.tabId, openerTabId: d.sourceTabId, openerFrameId: d.sourceFrameId, url: d.url });
}
