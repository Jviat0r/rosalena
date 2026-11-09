// Popup ops (ui.*), badge, and the offscreen waker document (D-015, D-021).

import { attach, attachedTabIds, detach } from "./cdp.js";
import { activeTab, tabInfo } from "./tabs.js";
import { connectNow, forgetPairing, getAuthError, getPort, getSlotTaken, isOpen, isPaused, sendEvent, setPaused } from "./transport.js";
import { PROTOCOL, VERSION, errMsg, isAttachable, withTimeout } from "./util.js";

// ---------------------------------------------------------------------- badge
// "OFF" switched off by the user, "!" no server, "…" connected with no tab,
// "ON" one tab, N for several.

export function setBadge() {
  const n = attachedTabIds().length;
  let text = "!";
  let color = "#c0392b";
  if (isPaused()) {
    text = "OFF";
    color = "#5f6368";
  } else if (isOpen()) {
    text = n === 0 ? "…" : n === 1 ? "ON" : String(n);
    color = n === 0 ? "#5f6368" : "#1e8e3e";
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
}

// ------------------------------------------------------------------ popup ops

async function summaries(ids) {
  const out = await Promise.all(
    ids.map((id) =>
      withTimeout(chrome.tabs.get(id), 2000, "tabs.get")
        .then((tab) => tabInfo(tab))
        .catch(() => ({ tabId: id, title: "", url: "", attached: true }))
    )
  );
  return out;
}

export async function handleUi(msg) {
  switch (msg.op) {
    case "ui.getState": {
      connectNow(); // opening the popup heals the connection (D-015)
      const [tabs, active] = await Promise.all([summaries(attachedTabIds()), activeTab().catch(() => null)]);
      return {
        serverConnected: isOpen(),
        authError: getAuthError(),
        // REL-6: another profile holds the server's extension slot; the popup
        // then offers "Use SolBrowser in this profile" (transport.takeover).
        slotTaken: getSlotTaken(),
        paused: isPaused(),
        port: getPort(),
        version: VERSION,
        protocol: PROTOCOL,
        attachedTabs: tabs,
        activeTab: active
          ? {
              tabId: active.id,
              title: active.title,
              url: active.url || active.pendingUrl,
              attachable: isAttachable(active.url || active.pendingUrl),
              attached: attachedTabIds().includes(active.id),
            }
          : null,
      };
    }
    case "ui.forgetPairing":
      await forgetPairing();
      return { ok: true };
    case "ui.pause": {
      // Release every tab first (that also ends the debugging bar), telling the
      // server while the socket is still up, then switch off.
      const ids = attachedTabIds();
      const failed = [];
      for (const tabId of ids) {
        try {
          await detach(tabId);
          sendEvent("userDetached", { tabId });
        } catch (e) {
          failed.push(`${tabId}: ${errMsg(e)}`);
        }
      }
      await setPaused(true);
      return failed.length ? { error: `Switched off, but could not release tab ${failed.join("; ")}` } : { ok: true, released: ids.length };
    }
    case "ui.resume":
      await setPaused(false);
      return { ok: true };
    case "ui.connect": {
      const tabId = Number.isInteger(msg.tabId) ? msg.tabId : (await activeTab())?.id;
      if (tabId == null) return { error: "No active tab to attach to." };
      const res = await attach(tabId);
      sendEvent("userAttached", { tabId: res.tabId, title: res.title, url: res.url });
      return { ok: true, tab: res };
    }
    case "ui.disconnect": {
      const tabId = Number.isInteger(msg.tabId) ? msg.tabId : (await activeTab())?.id;
      if (tabId == null) return { error: "No tab to detach." };
      const res = await detach(tabId);
      sendEvent("userDetached", { tabId });
      return { ok: true, tab: res };
    }
    default:
      return { error: `unknown ui op ${msg.op}` };
  }
}

// ---------------------------------------------------------- offscreen waker
// The offscreen page probes the hub's /health every second and sends
// {op:"wake"} when the hub says the extension is not connected. The message
// wakes a terminated worker, which then connects. Socket and CDP stay here.

let creating = null;

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return ctx.length > 0;
  }
  return (await chrome.offscreen.hasDocument?.()) ?? false;
}

export async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  if (creating) return creating;
  creating = (async () => {
    try {
      if (await hasOffscreen()) return true;
      await chrome.offscreen.createDocument({
        url: `offscreen.html?port=${getPort()}`,
        reasons: [chrome.offscreen.Reason?.WORKERS ?? "WORKERS"],
        justification: "Probes the local SolBrowser MCP server and wakes the service worker so it reconnects.",
      });
      return true;
    } catch (e) {
      // Raced another creator: that is success.
      if (/single offscreen|already exists/i.test(errMsg(e))) return true;
      console.warn("[solbrowser] offscreen document failed:", e);
      return false;
    } finally {
      creating = null;
    }
  })();
  return creating;
}

/** Tell the offscreen page the current port (after a port change or worker start). */
export function pushOffscreenConfig() {
  chrome.runtime.sendMessage({ target: "offscreen", op: "config", port: getPort() }).catch(() => {});
}
