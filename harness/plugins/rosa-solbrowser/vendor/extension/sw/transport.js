// WebSocket transport to the hub server (D-020/D-021).
//
// Wire format (unchanged from v1, protocol 2):
//   server -> ext  {id, method, params}
//   ext -> server  {id, ok:true, result} | {id, ok:false, error:{code, message}}
//   ext -> server  {event, params}            (no id)
// Requests are handled concurrently; nothing here serializes them.
//
// Pairing (D-031, SEC-1/SEC-2): before anything else both sides prove they
// hold the same secret, so a process that merely grabbed the port cannot drive
// the browser and a socket that merely claims to be the extension cannot
// replace us at the hub:
//   ext -> hub  {auth:"hello", nonce:Ne, paired, instance, takeover}
//   hub -> ext  {auth:"challenge", nonce:Nh, proof:HMAC(key,"hub:"+Ne)}
//             | {auth:"pair", key, nonce:Nh, proof}   (only while the hub's pairing is open)
//             | {auth:"refused", reason, code?}
//   ext -> hub  {auth:"proof", proof:HMAC(key,"ext:"+Nh)}
//   hub -> ext  {auth:"ok"}        then the usual hello event and methods.
//             | {auth:"refused", code:"SLOT_TAKEN", reason}   (REL-6, below)
// The key lives in chrome.storage.local.pairKey. A hub that fails its proof is
// dropped and reported in the popup; the key is only ever replaced by the user
// (popup "Forget pairing"), never because a server asks.
//
// One slot, several profiles (REL-6, P-015): `instance` is a random id per
// install (chrome.storage.local.instanceId, so one per Chrome profile). The hub
// lets the same instance replace its own live socket (reload: seamless) but
// refuses another instance while the live one answers, with SLOT_TAKEN. We then
// show the reason in the popup and retry only every SLOT_RETRY_MS (the
// offscreen waker still wakes us as soon as the hub reports the slot free),
// instead of both profiles redialling every 250 ms and swapping the slot. The
// user moves SolBrowser to this profile with takeover() ({op:"transport.takeover"}).

import { DEFAULT_PORT, ExtError, changed, errMsg } from "./util.js";

const BACKOFF_MIN_MS = 250;
const BACKOFF_MAX_MS = 2000;
const CONNECT_TIMEOUT_MS = 5000;
// The server pings every 20 s. Silence well past that means a half-open socket
// (sleep/wake, frozen hub): drop it so the reconnect path takes over.
const SILENCE_MS = 45_000;
// Another profile holds the slot (REL-6): probe rarely; the waker wakes us when it frees.
const SLOT_RETRY_MS = 5000;

let ws = null;
let reconnectTimer = null;
let backoffStep = 0;
let port = DEFAULT_PORT;
let lastInboundAt = 0;
let methods = new Map();
let ready = Promise.resolve();
let helloParams = () => ({});
let authed = false;
let authError = null;
let authFailedAt = 0; // last pairing failure: retry slowly, like SLOT_TAKEN (P-073)
let slotTaken = false;
let takeoverRequested = false;
// Popup "Disconnect SolBrowser": no socket and no reconnects until the user
// connects again. Stored, so it survives worker and browser restarts.
let paused = false;
let instanceId = null;

/** Open AND authenticated: nothing is sent or run before the pairing proof. */
export const isOpen = () => !!ws && ws.readyState === WebSocket.OPEN && authed;
export const getPort = () => port;
export const getAuthError = () => authError;
/** True while another browser profile holds the hub's extension slot (REL-6). */
export const getSlotTaken = () => slotTaken;
/** True while the user has switched SolBrowser off from the popup. */
export const isPaused = () => paused;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function hmacHex(keyHex, text) {
  const raw = new Uint8Array(keyHex.match(/../g).map((h) => parseInt(h, 16)));
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)));
}

async function storedKey() {
  try {
    const { pairKey } = await chrome.storage.local.get("pairKey");
    return typeof pairKey === "string" && /^[0-9a-f]{64}$/.test(pairKey) ? pairKey : null;
  } catch {
    return null;
  }
}

/** A random id per install, i.e. per Chrome profile (REL-6). */
async function getInstanceId() {
  if (instanceId) return instanceId;
  try {
    const { instanceId: stored } = await chrome.storage.local.get("instanceId");
    if (typeof stored === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return (instanceId = stored);
    instanceId = randomHex(16);
    await chrome.storage.local.set({ instanceId });
  } catch {
    instanceId ||= randomHex(16); // still unique for this worker's life
  }
  return instanceId;
}

/**
 * The user chose this profile (popup Connect while another profile holds the
 * slot): reconnect asking the hub to hand the slot over. The other profile is
 * then refused in turn and shows why, so nothing flaps.
 */
export async function takeover() {
  takeoverRequested = true;
  slotTaken = false;
  authError = null;
  await reconnect();
  return { port };
}

/** Popup "Forget pairing": the next hub with pairing open hands out its key. */
export async function forgetPairing() {
  await chrome.storage.local.remove("pairKey");
  authError = null;
  await reconnect();
}

/** sw.js wires the method table, the init barrier and the hello payload. */
export function configure({ methods: table, ready: readyPromise, hello }) {
  methods = new Map(Object.entries(table));
  ready = readyPromise;
  helloParams = hello;
}

/** Port comes from chrome.storage.local.port (tests only); production never sets it. */
export async function loadPort() {
  try {
    const { port: p } = await chrome.storage.local.get("port");
    const n = Number(p);
    port = Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
  } catch {
    port = DEFAULT_PORT;
  }
  return port;
}

/** Read the stored off switch (worker start, before the first connect). */
export async function loadPaused() {
  try {
    paused = (await chrome.storage.local.get("paused")).paused === true;
  } catch {
    paused = false;
  }
  return paused;
}

/**
 * Popup "Disconnect SolBrowser" / "Connect SolBrowser". Off: tell the hub first
 * (so agents get "switched off" at once instead of waiting for us), then drop
 * the socket and stop every reconnect path. On: reconnect now.
 */
export async function setPaused(on) {
  if (!on) {
    paused = false;
    await chrome.storage.local.remove("paused");
    return reconnect();
  }
  await chrome.storage.local.set({ paused: true });
  sendEvent("userPaused", {});
  paused = true;
  dropSocket();
  authError = null;
  slotTaken = false;
  changed();
  return { port };
}

/** Close the current socket without its handlers firing (no reconnect). */
function dropSocket() {
  const old = ws;
  ws = null;
  authed = false;
  if (old) {
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try {
      old.close();
    } catch {}
  }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

export function connect() {
  // Every reconnect path (backoff, wake, alarm, tick, popup) ends here.
  if (paused) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  let sock;
  try {
    // IPv4 literal, matched to the server's bind (P-012). /ext is the v2 route.
    sock = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  } catch (e) {
    console.warn("[solbrowser] websocket construction failed:", e);
    scheduleReconnect();
    return;
  }
  ws = sock;

  // P-071: a socket stuck in CONNECTING (never opening, never erroring) used to
  // block every later connect(), connectNow() and offscreen wake for good,
  // because they all return early while one is CONNECTING. Seen in a real Brave
  // profile: /health probes every second, zero /ext upgrades reaching the hub.
  // A handshake to a loopback server takes milliseconds; give up after 5 s.
  const connectTimer = setTimeout(() => {
    if (ws !== sock || sock.readyState !== WebSocket.CONNECTING) return;
    console.warn(`[solbrowser] connecting to ws://127.0.0.1:${port}/ext hung for ${CONNECT_TIMEOUT_MS} ms; retrying`);
    authError = `Connecting to the SolBrowser server hung (ws://127.0.0.1:${port}). If this keeps happening, the browser may be blocking local connections for extensions.`;
    changed();
    ws = null;
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try {
      sock.close();
    } catch {}
    scheduleReconnect();
  }, CONNECT_TIMEOUT_MS);

  // Every handler checks it is still the current socket: a stale handler must
  // never null out a live replacement (v1 lesson, see P-015).
  authed = false;
  const auth = { nonce: randomHex(16), key: null, stage: "hello" };
  // Messages are handled strictly in order: the auth steps are async (storage, HMAC).
  let queue = Promise.resolve();
  const fail = (why) => {
    authError = why;
    authFailedAt = Date.now();
    slotTaken = false;
    console.warn("[solbrowser]", why);
    try {
      sock.close();
    } catch {}
    changed();
  };
  sock.onopen = async () => {
    clearTimeout(connectTimer);
    if (ws !== sock) return;
    lastInboundAt = Date.now();
    const [key, instance] = await Promise.all([storedKey(), getInstanceId()]);
    auth.key = key;
    if (ws !== sock) return;
    try {
      sock.send(JSON.stringify({ auth: "hello", nonce: auth.nonce, paired: !!auth.key, instance, takeover: takeoverRequested }));
    } catch {}
  };
  sock.onmessage = (ev) => {
    if (ws !== sock) return;
    lastInboundAt = Date.now();
    if (authed) return handleMessage(ev.data);
    queue = queue.then(() => handleAuth(sock, auth, ev.data, fail)).catch((e) => fail(`pairing failed: ${errMsg(e)}`));
  };
  sock.onclose = () => {
    clearTimeout(connectTimer);
    if (ws !== sock) return;
    ws = null;
    authed = false;
    changed();
    scheduleReconnect();
  };
  sock.onerror = () => {}; // onclose always follows
}

async function handleAuth(sock, auth, raw, fail) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return fail("the server sent a non-JSON message before pairing");
  }
  if (msg?.auth === "refused") {
    if (msg.code === "SLOT_TAKEN") {
      // REL-6: not an error of ours; wait our turn quietly (no console warning every 5 s).
      slotTaken = true;
      authError = `Not connected: ${msg.reason || "another browser profile is using SolBrowser"}`;
      try {
        sock.close();
      } catch {}
      changed();
      return;
    }
    return fail(`the server refused this extension: ${msg.reason || "no reason given"}`);
  }
  if (auth.stage === "hello" && (msg?.auth === "challenge" || msg?.auth === "pair")) {
    let key = auth.key;
    if (msg.auth === "pair") {
      // Only an unpaired extension takes a key; a paired one never swaps it on a server's word.
      if (key) return fail("the server tried to re-pair an already paired extension");
      if (!/^[0-9a-f]{64}$/.test(msg.key || "")) return fail("the server sent a malformed pairing key");
      key = msg.key;
    }
    if (!key) return fail("the server did not offer pairing");
    if ((await hmacHex(key, `hub:${auth.nonce}`)) !== msg.proof) {
      // P-073: a paired extension meets a server with another key. If that server
      // is waiting to pair, the usual cause is that this extension paired with an
      // earlier or test server; the user re-pairs with one click, never us.
      if (msg.auth === "challenge" && msg.pairingOpen === true) {
        return fail(`this extension is paired with a different SolBrowser server than the one on port ${port}, which is waiting to pair (usually an earlier or test server paired it). If you started SolBrowser yourself, press "Forget pairing" to pair with it.`);
      }
      return fail("the server on this port could not prove the pairing key: it is not your SolBrowser server (or it was paired with another browser). Use \"Forget pairing\" in the popup only if you reinstalled SolBrowser or reset its ~/.solbrowser folder.");
    }
    if (msg.auth === "pair") {
      await chrome.storage.local.set({ pairKey: key });
      auth.key = key;
    }
    auth.stage = "proof";
    sock.send(JSON.stringify({ auth: "proof", proof: await hmacHex(key, `ext:${msg.nonce}`) }));
    return;
  }
  if (auth.stage === "proof" && msg?.auth === "ok") {
    if (ws !== sock) return;
    authed = true;
    authError = null;
    authFailedAt = 0;
    slotTaken = false;
    takeoverRequested = false;
    backoffStep = 0;
    sendEvent("hello", helloParams());
    changed();
    return;
  }
  fail(`unexpected pairing message: ${String(msg?.auth || msg?.event || msg?.method || "?").slice(0, 40)}`);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = slotTaken || authFailedAt ? SLOT_RETRY_MS : Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** backoffStep++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** Connect now, skipping any pending backoff (popup open, offscreen wake, alarm). */
export function connectNow() {
  if (isOpen() || ws?.readyState === WebSocket.CONNECTING) return;
  // A pairing failure will not fix itself: the offscreen wake (every second) must
  // not turn it into a reconnect storm. Forget pairing goes through reconnect().
  if (authFailedAt && Date.now() - authFailedAt < SLOT_RETRY_MS) return;
  backoffStep = 0;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connect();
}

/** Drop the current socket and reconnect, re-reading the port ({op:"reconnect"}). */
export async function reconnect() {
  dropSocket();
  backoffStep = 0;
  authFailedAt = 0;
  await loadPort();
  changed();
  connect();
  return { port };
}

/** Called from the 20 s keepalive tick. */
export function checkLiveness() {
  if (isOpen() && Date.now() - lastInboundAt > SILENCE_MS) {
    console.warn("[solbrowser] no message from the server for", SILENCE_MS, "ms; reconnecting");
    reconnect();
    return;
  }
  if (!isOpen()) connect();
}

function send(obj) {
  if (!isOpen()) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn("[solbrowser] send failed:", e);
    return false;
  }
}

export const sendEvent = (event, params = {}) => send({ event, params });

// The popup asks for a takeover with {op:"transport.takeover"}. Registered at
// module evaluation, i.e. synchronously during worker start-up, as MV3 requires.
// sw.js's own listener ignores ops it does not know (returns false).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.op !== "transport.takeover") return false;
  takeover().then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ error: errMsg(e) })
  );
  return true;
});

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg == null || msg.id == null) return;
  try {
    await ready;
    const fn = methods.get(msg.method);
    if (!fn) throw new ExtError("BAD_ARGS", `Unknown method ${msg.method}`);
    const result = await fn(msg.params || {});
    send({ id: msg.id, ok: true, result: result ?? {} });
  } catch (e) {
    send({ id: msg.id, ok: false, error: { code: e?.code || "EXTENSION_ERROR", message: errMsg(e) } });
  }
}
