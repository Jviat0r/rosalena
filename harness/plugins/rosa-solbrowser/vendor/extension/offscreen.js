// Offscreen waker (D-021). Lives as long as the browser; the WebSocket and all
// CDP work stay in the service worker. Every second: probe the hub's /health
// (500 ms timeout). If a SolBrowser hub answers and says the extension is not
// connected, send {op:"wake"} — the message itself restarts a terminated
// worker, which then connects. Offscreen pages only get chrome.runtime, so the
// port arrives via the URL, {target:"offscreen", op:"config"} pushes, and one
// {op:"offscreenConfig"} request once our listener is up: a push sent while the
// document was still loading is lost, and a port changed during creation would
// otherwise leave us probing the wrong port forever.

const PROBE_MS = 1000;
const PROBE_TIMEOUT_MS = 500;

let port = Number(new URLSearchParams(location.search).get("port")) || 8765;
let inFlight = false;
let pushes = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return false;
  if (msg.op === "config" && Number.isInteger(msg.port)) {
    port = msg.port;
    pushes++;
  }
  return false;
});

// Ask once, now that the listener exists. A push that lands while the request is
// in flight is newer than the reply, so it wins.
const seenBefore = pushes;
chrome.runtime
  .sendMessage({ op: "offscreenConfig" })
  .then((reply) => {
    if (pushes === seenBefore && Number.isInteger(reply?.port)) port = reply.port;
  })
  .catch(() => {});

async function probe() {
  if (inFlight) return;
  inFlight = true;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal, cache: "no-store" });
    if (!res.ok) return;
    const h = await res.json();
    if (h?.app !== "solbrowser" || h.extensionConnected !== false) return;
    const reply = await chrome.runtime.sendMessage({ op: "wake" });
    if (Number.isInteger(reply?.port)) port = reply.port;
  } catch {
    // No hub on the port (or the worker is mid-restart): try again next tick.
  } finally {
    clearTimeout(timer);
    inFlight = false;
  }
}

setInterval(probe, PROBE_MS);
probe();
