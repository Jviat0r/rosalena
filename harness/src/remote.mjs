/**
 * Phone access: the app on a phone (or another PC), through a Cloudflare tunnel.
 *
 * WHAT THIS DOES
 *
 * Quick mode (the default, no account): `cloudflared tunnel --url http://127.0.0.1:<uiPort>
 * --no-autoupdate --protocol http2` opens an outbound connection to Cloudflare and gets a
 * public hostname like `https://selective-tony-locking-hull.trycloudflare.com`. That name
 * changes every time cloudflared starts, so the stable-hostname relay (relay-client.mjs,
 * site/relay/) is told the new name each time, and the phone keeps one address:
 * `https://<id>.rosalena.dev`. If the relay cannot be reached, the page falls back to the
 * raw tunnel link and says so.
 *
 * Named mode (bring your own Cloudflare tunnel): `cloudflared tunnel run` with the tunnel's
 * token in TUNNEL_TOKEN (never on the command line, where any process can read it), and the
 * person's own hostname. The tunnel's public hostname is set in Cloudflare's dashboard to a
 * fixed local port (`namedPort`, default 47390); the app's own port changes every launch,
 * so a small loopback TCP forwarder listens on the fixed port and passes bytes to the
 * current one.
 *
 * cloudflared is found in this order: ROSALENA_CLOUDFLARED, PATH, the copy in
 * `<home>/remote/bin`, and otherwise it is downloaded (cloudflared-install.mjs: the
 * official release, size and SHA-256 checked).
 *
 * THE STATUS MODEL
 *
 *   idle --enable()--> starting --URL--> live --disable()--> stopping --> idle
 *                         |                |
 *                         +----failure-----+--> failed --(backoff, while wanted)--> starting
 *
 * `enable()` is non-blocking and idempotent. "Wanted" is what the switch says: while it is
 * on, a cloudflared that exits, or a tunnel whose public URL stops answering, is started
 * again after 2 s, 4 s, 8 s ... capped at 60 s. `disable()` is the only thing that turns
 * the wish off; on Windows it runs `taskkill /pid <pid> /T /F`, because cloudflared runs
 * helper processes and a bare `child.kill()` leaves the tunnel open at the edge.
 *
 * PAIRING (remote-store.mjs holds the state on disk)
 *
 * 1. The QR code carries `<public url>/?t=<pairing token>`. The token is 256 bits from the
 *    CSPRNG, persistent (the same QR works after a restart), compared in constant time,
 *    and replaced by "New QR code".
 * 2. A page GET with the right token pairs that browser: a new device row is written (the
 *    SHA-256 of a fresh 256-bit session secret, a name from the User-Agent), the browser
 *    gets `__Host-rosalena_device=<id>.<secret>` (HttpOnly, Secure, SameSite=Lax, Max-Age
 *    = the "stay paired" setting), and a 302 to the same URL without `?t=`, so the token
 *    leaves the address bar and the edge's request log after one request.
 * 3. Every later request carries only the device cookie. A device unused for longer than
 *    the setting is dropped by the server, not just by the cookie's expiry. Unpairing one
 *    device deletes its row and closes its open streams; "Unpair all" deletes every row,
 *    replaces the pairing token and the relay identity, so every old link and bookmark dies.
 * 4. Anything else that arrives through the tunnel gets the blocking page (no app, no data,
 *    a box to paste a pairing code) or a JSON 401. Wrong tokens are rate-limited: 10 per
 *    client and 60 in total per 10 minutes, then 429.
 *
 * SECURITY REVIEW - read this before turning it on.
 *
 * - Binding. Nothing new listens on the network. The UI server stays on 127.0.0.1 and
 *   cloudflared dials out; the named-mode forwarder listens on 127.0.0.1 only. While the
 *   tunnel is live this machine's app *is* reachable from the internet, and the only thing
 *   between a stranger and an agent that can read files and run commands is the pairing.
 * - Cloudflare is inside the trust boundary: the tunnel terminates TLS at its edge, and so
 *   does the relay Worker. Private from the internet, not from Cloudflare.
 * - A paired device is an operator. The served page carries the app's write token, so a
 *   phone can start runs and answer approvals like the window can. It cannot open the
 *   terminal, and it cannot start, stop, re-key or reconfigure phone access: those answer
 *   only a caller on this machine (Host is loopback and no Cloudflare headers).
 * - Secrets never go to the log: not the pairing token, not a device secret, not the
 *   relay secret, not the named-tunnel token.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { posix, win32 } from "node:path";

import { qrDataUri } from "./qr.mjs";
import { createRemoteStore } from "./remote-store.mjs";

/** Every state this module can be in, in lifecycle order. */
export const STATES = Object.freeze(["idle", "starting", "live", "stopping", "failed"]);

/** Where a person can get cloudflared by hand (the app downloads it when it can). */
export const DOWNLOAD = Object.freeze({
  releases: "https://github.com/cloudflare/cloudflared/releases/latest",
  docs: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
});

/** Env var that overrides the PATH lookup with an explicit binary path. */
export const BIN_ENV = "ROSALENA_CLOUDFLARED";

/** The paired-device cookie. `__Host-` means: only this exact host may set or read it. */
export const COOKIE = "__Host-rosalena_device";
/** The same cookie without the prefix, for a plain-http request (never the real tunnel). */
export const COOKIE_PLAIN = "rosalena_device";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const CHECK_TIMEOUT_MS = 15_000;
const HEALTH_CHECK_MS = 60_000;
const HEALTH_FAILURES = 2;
const OUTPUT_TAIL = 16 * 1024;
const DAY_MS = 86_400_000;
/** A tunnel that stayed live this long has earned a fresh backoff count. */
const STABLE_MS = 60_000;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI, "");
}

/**
 * The quick-tunnel URL out of cloudflared's output (boxed banner, older unboxed line, or
 * `--logformat json`). Only `*.trycloudflare.com`, and never `api.trycloudflare.com`.
 * Returns the URL with a trailing slash, or null.
 */
export function parseTunnelUrl(text) {
  const clean = stripAnsi(text);
  if (!clean) return null;
  const match = clean.match(/(?<![a-z0-9.-])https:\/\/([a-z0-9][a-z0-9-]*\.trycloudflare\.com)(?![a-z0-9.-])/i);
  if (!match) return null;
  const host = match[1].toLowerCase();
  if (host === "api.trycloudflare.com") return null;
  return `https://${host}/`;
}

/** A named tunnel prints this once its first edge connection is up. */
export function namedTunnelReady(text) {
  return /Registered tunnel connection/i.test(stripAnsi(text));
}

export function tunnelHost(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return null;
  }
}

function defaultIsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Find cloudflared: `ROSALENA_CLOUDFLARED`, then PATH. (The copy the app downloads is the
 * third place, checked by the controller.) Nothing is executed to probe a version.
 */
export function locateCloudflared({ env = process.env, platform = process.platform, isFile = defaultIsFile } = {}) {
  const paths = platform === "win32" ? win32 : posix;
  const override = String(env[BIN_ENV] ?? "").trim();
  if (override) {
    const path = paths.resolve(override);
    if (!isFile(path)) {
      return {
        ok: false,
        reason:
          `${BIN_ENV} is set to ${path}, and there is no file there. ` +
          `Point it at the cloudflared executable, or unset it to use PATH. Download: ${DOWNLOAD.releases}`,
        download: DOWNLOAD,
        override: true,
      };
    }
    return { ok: true, path, source: BIN_ENV, download: DOWNLOAD };
  }

  const names =
    platform === "win32" ? ["cloudflared.exe", "cloudflared.cmd", "cloudflared.bat", "cloudflared"] : ["cloudflared"];
  const raw = env.PATH ?? env.Path ?? "";
  const dirs = String(raw)
    .split(paths.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = paths.join(dir, name);
      if (isFile(candidate)) return { ok: true, path: candidate, source: "PATH", download: DOWNLOAD };
    }
  }

  return {
    ok: false,
    reason:
      `cloudflared was not found on PATH (${dirs.length} ${dirs.length === 1 ? "directory" : "directories"} checked) ` +
      `and ${BIN_ENV} is not set. Install cloudflared from ${DOWNLOAD.releases} ` +
      `(documentation: ${DOWNLOAD.docs}), then turn phone access on again. Nothing is running: ` +
      `without the binary there is no tunnel, and this app will not pretend there is one.`,
    download: DOWNLOAD,
  };
}

/** Constant-time comparison that never throws on a length mismatch. */
export function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 256 bits from the CSPRNG, base64url. */
export function mintToken() {
  return randomBytes(32).toString("base64url");
}

function hostOf(req) {
  return String(req?.headers?.host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHost(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
}

/** Cloudflare's edge always adds these; their presence means the request came from outside. */
function fromCloudflare(req) {
  return Boolean(req?.headers?.["cf-ray"] || req?.headers?.["cf-connecting-ip"]);
}

function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function cookieHeader(value, { secure, maxAgeS }) {
  const name = secure ? COOKIE : COOKIE_PLAIN;
  const bits = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

function clearedCookieHeaders() {
  return [`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`, `${COOKIE_PLAIN}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
}

/**
 * The URL the phone opens. The pairing code rides in the fragment (`#pair=`), which a
 * browser never sends to any server: not to Cloudflare's edge, not to the relay, not to
 * cloudflared's log. The blocking page's script reads it and posts it to
 * /api/remote/pair. (`?t=` in the query is still accepted, for links made by hand.)
 */
export function pairingLink(publicUrl, token) {
  if (!publicUrl || !token) return null;
  const base = String(publicUrl).replace(/\/*$/, "/");
  return `${base}#pair=${encodeURIComponent(token)}`;
}

/** A pasted pairing code may be the bare token or the whole link; take the token either way. */
export function tokenFromInput(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const inLink = /[?&#](?:t|token|pair)=([A-Za-z0-9_%-]+)/.exec(text);
  if (inLink) {
    try {
      return decodeURIComponent(inLink[1]);
    } catch {
      return inLink[1];
    }
  }
  return text;
}

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** The refusal pages' headers: one nonce'd script, a form that can only post here. */
function pageHeaders(nonce) {
  return {
    "content-security-policy":
      `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ""}form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-robots-tag": "noindex, nofollow",
  };
}

/**
 * What an unpaired browser sees: no app, no data, one way in. The form posts the code to
 * /api/remote/pair and works with no script; the one script (allowed by nonce) only moves a
 * `#pair=` code from the QR link into the form and submits it, so scanning pairs at once.
 */
export function blockingPage({ title, detail, tone = "info", form = true, nonce = null } = {}) {
  const colour = tone === "bad" ? "#ff8a8a" : "#5fe3f0";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)} - Rosalena</title>` +
    `<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070c13;color:#e9f1f9;` +
    `font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px}` +
    `main{width:100%;max-width:26rem;border:1px solid #2b3b4b;border-radius:16px;background:#0d1621;padding:24px}` +
    `.mark{font-weight:700;letter-spacing:.02em;color:#9fb3c8;font-size:13px;margin:0 0 14px}` +
    `h1{font-size:19px;margin:0 0 8px;color:${colour}}p{margin:0 0 14px;color:#c4d4e4}` +
    `ol{margin:0 0 16px;padding-left:20px;color:#c4d4e4}li{margin:4px 0}` +
    `label{display:block;font-size:13px;color:#9fb3c8;margin:0 0 6px}` +
    `input{width:100%;min-height:46px;border-radius:10px;border:1px solid #2b3b4b;background:#070c13;color:#e9f1f9;padding:10px 12px;font:16px ui-monospace,Consolas,monospace}` +
    `button{margin-top:10px;width:100%;min-height:46px;border:0;border-radius:10px;background:#5fe3f0;color:#04161c;font-weight:700;font-size:16px}` +
    `</style></head><body><main><p class="mark">Rosalena · Phone access</p>` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>` +
    (form
      ? `<ol><li>On the computer running Rosalena, click the phone button at the bottom of the sidebar.</li>` +
        `<li>Scan the QR code with this device's camera, or copy the link and open it here.</li></ol>` +
        `<form method="post" action="/api/remote/pair" autocomplete="off"><label for="code">Or paste the pairing link or code</label>` +
        `<input id="code" name="code" type="text" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" required>` +
        `<button type="submit">Pair this device</button></form>` +
        (nonce
          ? `<script nonce="${nonce}">(function(){var m=/[#&]pair=([A-Za-z0-9_%-]+)/.exec(location.hash);if(!m)return;` +
            `history.replaceState(null,"",location.pathname+location.search);var f=document.forms[0];` +
            `f.elements.code.value=decodeURIComponent(m[1]);f.submit();})();</script>`
          : "")
      : "") +
    `</main></body></html>`
  );
}

/** Wrong-token counters: per client and in total, over a sliding window. */
function createLimiter({ perKey = 10, global = 60, windowMs = 10 * 60_000, now }) {
  const hits = new Map();
  let all = [];
  const prune = (list, at) => list.filter((t) => at - t < windowMs);
  return {
    blocked(key) {
      const at = now();
      all = prune(all, at);
      const mine = prune(hits.get(key) ?? [], at);
      if (mine.length) hits.set(key, mine);
      else hits.delete(key);
      if (mine.length >= perKey) return Math.ceil((windowMs - (at - mine[0])) / 1000);
      if (all.length >= global) return Math.ceil((windowMs - (at - all[0])) / 1000);
      return 0;
    },
    fail(key) {
      const at = now();
      all.push(at);
      hits.set(key, [...prune(hits.get(key) ?? [], at), at]);
      if (hits.size > 5000) hits.clear(); // never let a flood of addresses grow this without bound
    },
  };
}

/**
 * Who is asking, for the rate limit only (never for a decision about access). Cloudflare
 * sets cf-connecting-ip; the relay adds x-rosalena-client-ip with the phone's address,
 * because through the relay cf-connecting-ip is the Worker's.
 */
function clientKey(req) {
  const edge = String(req?.headers?.["cf-connecting-ip"] ?? "").trim();
  const relayed = String(req?.headers?.["x-rosalena-client-ip"] ?? "").trim().slice(0, 64);
  const socket = req?.socket?.remoteAddress ?? "";
  return `${edge || socket}|${relayed}`;
}

/**
 * The controller. One per UI server. Everything that touches the outside world is
 * injectable so the tests can drive the whole lifecycle with no network and no binary.
 */
export function createRemoteAccess({
  port = 8090,
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  isFile = defaultIsFile,
  fetchImpl = (url, init) => fetch(url, init),
  now = () => Date.now(),
  log = () => {},
  store = createRemoteStore({ now }),
  relay = null,
  install = null,
  locateInstalled = () => null,
  // An empty cloudflared config of Rosalena's own, passed as --config. Without it
  // cloudflared reads ~/.cloudflared/config.yml, and a person who runs any named tunnel
  // has one whose ingress (ending in http_status:404) overrides --url: the quick tunnel
  // comes up, registers, and answers 404 to everything. Measured on this PC, 2026-11-09.
  configFile = null,
  netImpl = { createServer: createNetServer, connect: netConnect },
  startTimeoutMs = START_TIMEOUT_MS,
  stopTimeoutMs = STOP_TIMEOUT_MS,
  checkTimeoutMs = CHECK_TIMEOUT_MS,
  healthCheckMs = HEALTH_CHECK_MS,
  healthFailures = HEALTH_FAILURES,
  restartBaseMs = 2_000,
  restartMaxMs = 60_000,
  pairLimit = {},
} = {}) {
  const uiPort = typeof port === "function" ? port : () => port;
  const limiter = createLimiter({ ...pairLimit, now });

  const state = {
    state: "idle",
    reason: "phone access is off",
    since: now(),
    url: null,
    host: null,
    mode: "quick",
    binary: null,
    binarySource: null,
    pid: null,
    startedAt: null,
    liveAt: null,
    lastFailure: null,
    install: null,
  };
  /** What the switch says. Only enable() sets it and only disable() clears it. */
  let wanted = false;
  let child = null;
  let childExited = false;
  let stopping = false;
  let startTimer = null;
  let settleWaiters = [];
  let healthTimer = null;
  let healthMisses = 0;
  let restartTimer = null;
  let restartAttempt = 0;
  let restartAt = null;
  /** Bumped by every start and stop, so a slow download or proxy start cannot act late. */
  let generation = 0;
  let proxy = null;
  /** Open responses per paired device, so unpairing one also ends its live streams. */
  const openByDevice = new Map();

  const settings = () => store.settings();
  const maxIdleMs = () => settings().cookieDays * DAY_MS;

  function flushSettled() {
    if (state.state === "starting" || state.state === "stopping") return;
    const waiters = settleWaiters;
    settleWaiters = [];
    const snapshot = status();
    for (const resolve of waiters) resolve(snapshot);
  }

  function transition(next, reason) {
    if (!STATES.includes(next)) throw new RangeError(`unknown remote-access state ${next}`);
    state.state = next;
    state.reason = String(reason);
    state.since = now();
    log(`remote: ${next} - ${state.reason}`);
    flushSettled();
  }

  function clearRestart() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    restartAt = null;
  }

  /** Into `failed`. While the switch is on, the next attempt is scheduled with backoff. */
  function fail(reason) {
    state.lastFailure = { at: now(), reason: String(reason) };
    if (state.liveAt && now() - state.liveAt > STABLE_MS) restartAttempt = 0;
    state.url = null;
    state.host = null;
    state.pid = null;
    state.liveAt = null;
    stopHealth();
    relay?.stop({ keepUrl: true });
    void stopProxy();
    let text = String(reason);
    if (wanted && restartBaseMs > 0) {
      const delay = Math.min(restartBaseMs * 2 ** restartAttempt, restartMaxMs);
      restartAttempt += 1;
      restartAt = now() + delay;
      text += ` Trying again in ${Math.max(1, Math.round(delay / 1000))} s.`;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        restartAt = null;
        if (wanted && state.state === "failed") start();
      }, delay);
      restartTimer.unref?.();
    }
    transition("failed", text);
  }

  function publicUrl() {
    if (state.state !== "live" || !state.url) return null;
    if (state.mode === "quick" && settings().relay && relay) {
      const r = relay.status();
      if (r.state === "linked" && r.url) return r.url;
    }
    return state.url;
  }

  function relayView() {
    const s = settings();
    if (state.mode === "named") return { enabled: false, state: "named", url: null, error: null, note: "a named tunnel has its own fixed hostname" };
    if (!s.relay) return { enabled: false, state: "off", url: null, error: null };
    if (!relay) return { enabled: true, state: "unavailable", url: null, error: "this build has no relay client" };
    const r = relay.status();
    return { enabled: true, state: r.state, url: r.url ?? store.relayUrl(), error: r.error, nextTryAt: r.nextTryAt, base: r.base };
  }

  /** The status a caller may see. Secrets only come out when asked for. */
  function status({ revealSecret = false } = {}) {
    const pub = publicUrl();
    const out = {
      state: state.state,
      reason: state.reason,
      since: state.since,
      now: now(),
      wanted,
      mode: state.mode,
      url: state.url,
      publicUrl: pub,
      host: state.host,
      binary: state.binary,
      binarySource: state.binarySource,
      install: state.install,
      pid: state.pid,
      startedAt: state.startedAt,
      liveAt: state.liveAt,
      restartAt,
      hasToken: true,
      lastFailure: state.lastFailure,
      relay: relayView(),
      download: DOWNLOAD,
      cookie: COOKIE,
    };
    if (revealSecret) {
      const token = store.pairingToken();
      out.link = pub ? pairingLink(pub, token) : null;
      // The QR is an SVG data URI built here, offline, by src/qr.mjs. No image service sees the token.
      out.qr = out.link ? qrDataUri(out.link, { ecl: "M", scale: 8, margin: 4 }) : null;
      out.devices = store.devices();
      out.settings = store.publicSettings();
      out.pairingMintedAt = store.pairingMintedAt();
    }
    return out;
  }

  // ------------------------------------------------------------------ the child

  function onLive(url) {
    if (state.state !== "starting") return;
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    state.url = url;
    state.host = tunnelHost(url);
    state.liveAt = now();
    transition("live", state.mode === "named" ? `the named tunnel is connected; ${url} reaches this app` : `cloudflared published ${url}`);
    scheduleHealth();
    announceRelay();
  }

  function announceRelay() {
    if (!relay || state.mode !== "quick" || state.state !== "live" || !settings().relay) return;
    const { id, secret } = store.relayIdentity();
    void relay.announce({ id, secret, target: state.url }).then((url) => {
      if (url) store.setRelayUrl(url);
    });
  }

  function rememberOutput(chunk, sink) {
    sink.text = (sink.text + String(chunk)).slice(-OUTPUT_TAIL);
    if (state.mode === "named") {
      if (namedTunnelReady(sink.text)) onLive(`https://${settings().namedHost}/`);
      return;
    }
    const url = parseTunnelUrl(sink.text);
    if (url) onLive(url);
  }

  function clearHealthTimer() {
    if (healthTimer) {
      clearTimeout(healthTimer);
      healthTimer = null;
    }
  }

  function stopHealth() {
    clearHealthTimer();
    healthMisses = 0;
  }

  function scheduleHealth() {
    clearHealthTimer();
    if (healthCheckMs <= 0 || healthFailures <= 0) return;
    healthTimer = setTimeout(() => {
      healthTimer = null;
      void healthTick();
    }, healthCheckMs);
    healthTimer.unref?.();
  }

  /**
   * Probe the tunnel URL without credentials. Below 500 is alive (a 401 is this app's own
   * gate answering, which proves the path works). Two misses in a row and the tunnel is
   * torn down and - while the switch is on - started again.
   */
  async function healthTick() {
    if (state.state !== "live" || !state.url) return null;
    const url = `${state.url.replace(/\/+$/, "")}/api/remote/status`;
    let alive = false;
    try {
      const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(checkTimeoutMs) });
      await res.text?.().catch?.(() => "");
      alive = res.status < 500;
    } catch {
      alive = false;
    }
    if (state.state !== "live") return null;
    if (alive) {
      healthMisses = 0;
    } else {
      healthMisses += 1;
      if (healthMisses >= healthFailures) {
        const why =
          `the tunnel stopped answering on its public URL (${healthMisses} probes in a row went nowhere). ` +
          `cloudflared can keep running after it loses its edge connection, so it was stopped.`;
        const dying = child;
        child = null;
        state.pid = null;
        stopping = false;
        fail(why);
        if (dying) void killTree(dying).catch(() => {});
        return false;
      }
    }
    scheduleHealth();
    return state.state === "live";
  }

  function watch(c) {
    const sink = { text: "" };
    c.stdout?.on?.("data", (chunk) => rememberOutput(chunk, sink));
    c.stderr?.on?.("data", (chunk) => rememberOutput(chunk, sink));

    c.once?.("error", (err) => {
      if (stopping || c !== child) return;
      fail(`cloudflared could not be started: ${err?.message ?? err}.`);
    });

    c.once?.("exit", (code, signal) => {
      if (c === child) childExited = true;
      if (stopping || c !== child) return;
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = null;
      }
      const how = signal ? `signal ${signal}` : `code ${code}`;
      // The tail of the output, minus anything that could be a secret (a token never
      // reaches cloudflared's output, but its own log lines are not ours to repeat whole).
      const tail = (sink.text || "").trim().split(/\r?\n/).slice(-3).join(" | ").replace(/[A-Za-z0-9_-]{40,}/g, "...").slice(0, 400);
      child = null;
      if (state.state === "live") fail(`cloudflared exited (${how}) while the tunnel was live${tail ? `: ${tail}` : ""}.`);
      else if (state.state === "starting") fail(`cloudflared exited (${how}) before the tunnel was up${tail ? `: ${tail}` : ""}.`);
    });
  }

  function exitCode(c, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), ms);
      c.once?.("close", (code) => {
        clearTimeout(timer);
        finish(code ?? 0);
      });
      c.once?.("error", () => {
        clearTimeout(timer);
        finish(null);
      });
    });
  }

  /** Kill the whole tree: `taskkill /T /F` on Windows, the process group elsewhere. */
  async function killTree(c) {
    const pid = c?.pid;
    if (!pid) {
      try {
        c?.kill?.();
      } catch {
        /* nothing to kill */
      }
      return { how: "no pid; nothing to kill" };
    }
    if (platform === "win32") {
      let code = null;
      try {
        code = await exitCode(spawnImpl("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }), stopTimeoutMs);
      } catch (err) {
        log(`remote: taskkill failed to start: ${err?.message ?? err}`);
      }
      try {
        c.kill?.();
      } catch {
        /* already gone */
      }
      return { how: `taskkill /pid ${pid} /T /F ${code === null ? "did not report back" : `exited ${code}`}` };
    }
    try {
      process.kill(-pid, "SIGTERM");
      return { how: `SIGTERM to process group ${pid}` };
    } catch {
      try {
        c.kill?.("SIGTERM");
        return { how: `SIGTERM to pid ${pid}` };
      } catch (err) {
        return { how: `could not signal pid ${pid} (${err?.message ?? err})` };
      }
    }
  }

  // ------------------------------------------------------- named-mode forwarder

  /** 127.0.0.1:<namedPort> -> 127.0.0.1:<uiPort>, bytes only. */
  function startProxy(listenPort) {
    return new Promise((resolve, reject) => {
      const server = netImpl.createServer((socket) => {
        const upstream = netImpl.connect(uiPort(), "127.0.0.1");
        const drop = () => {
          socket.destroy();
          upstream.destroy();
        };
        socket.on("error", drop);
        upstream.on("error", drop);
        socket.pipe(upstream).pipe(socket);
      });
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", reject);
        server.on("error", (err) => log(`remote: forwarder error: ${err?.message ?? err}`));
        resolve(server);
      });
    });
  }

  async function stopProxy() {
    const p = proxy;
    proxy = null;
    if (!p) return;
    await new Promise((resolve) => p.close(() => resolve()));
  }

  // ------------------------------------------------------------------- start

  function spawnTunnel(found, mode, mine) {
    if (mine !== generation || state.state !== "starting") return;
    state.binary = found.path;
    state.binarySource = found.source;
    const s = settings();
    const target = Number(uiPort());
    let configArgs = [];
    if (configFile) {
      try {
        if (!existsSync(configFile)) {
          mkdirSync(dirname(configFile), { recursive: true });
          writeFileSync(configFile, "# Rosalena phone access: empty on purpose, so ~/.cloudflared/config.yml is not read.\n");
        }
        configArgs = ["--config", configFile];
      } catch (err) {
        log(`remote: could not write ${configFile} (${err?.message ?? err}); ~/.cloudflared/config.yml may override the tunnel`);
      }
    }
    const args =
      mode === "named"
        ? ["tunnel", ...configArgs, "--no-autoupdate", "--protocol", "http2", "run"]
        : // `--protocol http2`: cloudflared's default prefers QUIC over UDP 7844, and on a
          // network that eats UDP the connector keeps its hostname while carrying nothing
          // (Cloudflare answers 1033). HTTP/2 rides the same TCP path as the control link.
          ["tunnel", ...configArgs, "--url", `http://127.0.0.1:${target}`, "--no-autoupdate", "--protocol", "http2"];
    // The named-tunnel token goes in the environment, never in argv: any process on the
    // machine can read another's command line.
    const childEnv = mode === "named" ? { ...env, TUNNEL_TOKEN: s.namedToken } : env;
    try {
      child = spawnImpl(found.path, args, {
        detached: platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err) {
      child = null;
      fail(`cloudflared could not be started: ${err?.message ?? err}.`);
      return;
    }
    state.pid = child.pid ?? null;
    stopping = false;
    childExited = false;
    watch(child);
    state.reason =
      mode === "named"
        ? `starting the named tunnel for ${s.namedHost} (${found.source})`
        : `starting ${found.path} (${found.source}); waiting for a trycloudflare URL`;

    startTimer = setTimeout(() => {
      startTimer = null;
      if (state.state !== "starting") return;
      const dying = child;
      child = null;
      state.pid = null;
      fail(
        `cloudflared ran for ${Math.round(startTimeoutMs / 1000)} s without the tunnel coming up. ` +
          `It may be blocked from reaching Cloudflare's edge${mode === "named" ? ", or the tunnel token is wrong" : ""}.`,
      );
      if (dying) killTree(dying).catch(() => {});
    }, startTimeoutMs);
  }

  function start() {
    if (state.state === "starting" || state.state === "live" || state.state === "stopping") return status({ revealSecret: true });
    clearRestart();
    const mine = ++generation;

    const target = Number(uiPort());
    if (!Number.isInteger(target) || target <= 0) {
      fail("the UI server has not published a port yet, so there is nothing for the tunnel to point at.");
      return status({ revealSecret: true });
    }

    const s = settings();
    state.mode = s.namedToken && s.namedHost ? "named" : "quick";
    state.lastFailure = null;
    state.url = null;
    state.host = null;
    state.liveAt = null;
    state.startedAt = now();
    state.install = null;

    let found = locateCloudflared({ env, platform, isFile });
    if (!found.ok && !found.override) {
      const mineCopy = locateInstalled();
      if (mineCopy?.path) found = { ok: true, path: mineCopy.path, source: "downloaded by Rosalena" };
    }

    const go = (bin) => {
      if (state.mode !== "named") return spawnTunnel(bin, "quick", mine);
      startProxy(s.namedPort).then(
        (server) => {
          if (mine !== generation || state.state !== "starting") {
            server.close();
            return;
          }
          proxy = server;
          spawnTunnel(bin, "named", mine);
        },
        (err) => {
          if (mine !== generation) return;
          fail(
            err?.code === "EADDRINUSE"
              ? `port ${s.namedPort} is already in use on this PC; pick another local port in Settings > Phone access and point the tunnel at it.`
              : `the local forwarder on port ${s.namedPort} could not start: ${err?.message ?? err}.`,
          );
        },
      );
    };

    if (found.ok) {
      transition("starting", `starting cloudflared (${found.source})`);
      go(found);
      return status({ revealSecret: true });
    }

    if (!install || found.override) {
      state.binary = null;
      fail(found.reason);
      return status({ revealSecret: true });
    }

    // First use: fetch the official binary, then carry on. The page shows the progress.
    state.install = { state: "downloading", received: 0, total: null };
    transition("starting", "downloading cloudflared from Cloudflare's GitHub releases (first use only)");
    Promise.resolve()
      .then(() => install({ onProgress: (p) => { if (state.install) Object.assign(state.install, p); } }))
      .then(
        (out) => {
          if (mine !== generation || state.state !== "starting") return;
          if (!out?.ok) {
            state.install = { state: "failed", reason: out?.reason ?? "unknown" };
            fail(`${out?.reason ?? "cloudflared could not be downloaded"}. You can also install it yourself: ${DOWNLOAD.releases}`);
            return;
          }
          state.install = { state: "done", version: out.version ?? null };
          go({ ok: true, path: out.path, source: "downloaded by Rosalena" });
        },
        (err) => {
          if (mine !== generation) return;
          fail(`cloudflared could not be downloaded: ${err?.message ?? err}`);
        },
      );
    return status({ revealSecret: true });
  }

  // ------------------------------------------------------------------- controls

  /** Turn the switch on. Returns at once (state `starting`); the URL arrives later. */
  function enable() {
    wanted = true;
    return start();
  }

  /** Stop the tunnel and the process tree. Leaves the tunnel switch where it is when `keepWanted`. */
  async function stopTunnel({ keepWanted = false, why = null } = {}) {
    if (!keepWanted) wanted = false;
    clearRestart();
    generation += 1;
    if (state.state === "idle") return status();
    if (state.state === "stopping") return settledFor();
    stopHealth();
    relay?.stop({ keepUrl: true });

    if (state.state === "failed") {
      const last = state.lastFailure?.reason ?? null;
      state.url = null;
      state.host = null;
      state.pid = null;
      await stopProxy();
      transition("idle", why ?? (last ? `phone access is off; the last attempt failed: ${last}` : "phone access is off"));
      return status();
    }

    const wasLive = state.state === "live";
    transition("stopping", wasLive ? `stopping the tunnel to ${state.url}` : "stopping cloudflared before it finished starting");
    stopping = true;
    if (startTimer) {
      clearTimeout(startTimer);
      startTimer = null;
    }
    const current = child;
    let how = "there was no child process to stop";
    if (current) {
      const killed = await killTree(current);
      how = killed.how;
      if (!childExited) await exitCode(current, stopTimeoutMs);
    }
    await stopProxy();
    child = null;
    state.pid = null;
    state.url = null;
    state.host = null;
    state.liveAt = null;
    state.install = null;
    stopping = false;
    transition("idle", why ?? `phone access is off (${how})`);
    return status();
  }

  /** The switch, off. The relay is told to show its offline page instead of a dead tunnel. */
  async function disable() {
    const out = await stopTunnel();
    if (relay && settings().relay) void relay.unregister(store.relayIdentity());
    return out;
  }

  /** The server is closing (quit, or a workspace switch): stop, but remember the switch. */
  async function shutdown() {
    const keep = wanted;
    const out = await stopTunnel({ keepWanted: true, why: "the app closed this server" });
    wanted = keep;
    return out;
  }

  /** Start at launch if "Keep phone access on" is set. */
  function autoStart() {
    if (!settings().keepOn) return null;
    log("remote: Keep phone access on is set; starting the tunnel");
    return enable();
  }

  /** New QR code: the old link stops pairing new devices; paired devices stay paired. */
  function revoke() {
    store.rotatePairing();
    log("remote: new pairing code; links shared before now no longer pair a device");
    return { ok: true, ...status({ revealSecret: true }) };
  }

  function closeStreams(id) {
    for (const res of openByDevice.get(id) ?? []) {
      try {
        res.destroy?.();
      } catch {
        /* already closed */
      }
    }
    openByDevice.delete(id);
  }

  function removeDevice(id) {
    const ok = store.removeDevice(String(id ?? ""));
    if (ok) {
      closeStreams(id);
      log("remote: a paired device was unpaired");
    }
    return { ok, ...status({ revealSecret: true }) };
  }

  /** Unpair all: every device, the pairing code and the stable hostname are replaced. */
  async function unpairAll() {
    const count = store.removeAllDevices();
    for (const id of [...openByDevice.keys()]) closeStreams(id);
    store.rotatePairing();
    const old = store.rotateRelay();
    if (relay) {
      void relay.unregister(old);
      relay.stop({ keepUrl: false });
      announceRelay();
    }
    log(`remote: unpaired all (${count} device${count === 1 ? "" : "s"}); new pairing code and new phone link`);
    return { ok: true, removed: count, ...status({ revealSecret: true }) };
  }

  /** Change settings; a running tunnel picks up what affects it. */
  async function updateSettings(patch) {
    const before = settings();
    store.updateSettings(patch);
    const after = settings();
    const namedChanged =
      before.namedToken !== after.namedToken || before.namedHost !== after.namedHost || before.namedPort !== after.namedPort;
    if (namedChanged && wanted && state.state !== "idle") {
      await stopTunnel({ keepWanted: true, why: "restarting with the new tunnel settings" });
      start();
    } else if (before.relay !== after.relay && relay && state.mode === "quick") {
      if (!after.relay) {
        relay.stop({ keepUrl: true });
        void relay.unregister(store.relayIdentity());
      } else {
        announceRelay();
      }
    }
    return status({ revealSecret: true });
  }

  /** Whether a request came in from this machine and may control phone access. */
  function isLocal(req) {
    return isLoopbackHost(hostOf(req)) && !fromCloudflare(req);
  }

  function statusFor(req) {
    const local = isLocal(req);
    if (!local) {
      // A paired device sees that it is paired, and nothing about the others.
      return {
        state: state.state,
        view: "remote",
        canControl: false,
        canReveal: false,
        publicUrl: publicUrl(),
        device: req?.rosalenaDevice ?? null,
        hasToken: true,
      };
    }
    const out = status({ revealSecret: true });
    out.view = "local";
    out.canControl = true;
    out.canReveal = true;
    out.liveForMs = state.liveAt ? now() - state.liveAt : null;
    out.clock = now();
    return out;
  }

  /**
   * Whether this request arrived through the tunnel: the tunnel's Host, Cloudflare's edge
   * headers, or - while the tunnel is up - any Host that is not loopback.
   */
  function tunnelRequest(req) {
    if (fromCloudflare(req)) return true;
    if (!(state.state === "live" || state.state === "starting" || state.state === "stopping" || (state.state === "failed" && wanted))) return false;
    const host = hostOf(req);
    if (state.host && host === state.host) return true;
    return !isLoopbackHost(host);
  }

  function isSecure(req) {
    return String(req?.headers?.["x-forwarded-proto"] ?? "").toLowerCase() === "https" || fromCloudflare(req);
  }

  function track(deviceId, res) {
    if (!res || typeof res.once !== "function") return;
    let set = openByDevice.get(deviceId);
    if (!set) openByDevice.set(deviceId, (set = new Set()));
    set.add(res);
    res.once("close", () => {
      set.delete(res);
      if (!set.size) openByDevice.delete(deviceId);
    });
  }

  function refusal(statusCode, title, detail, { tone = "info", form = true, headers = {} } = {}) {
    const nonce = form ? randomBytes(16).toString("base64") : null;
    return { status: statusCode, error: detail, html: blockingPage({ title, detail, tone, form, nonce }), headers: { ...pageHeaders(nonce), ...headers } };
  }

  /** Check a presented code against the rate limit and the pairing token. Null means it is good. */
  function refuseCode(req, presented) {
    const key = clientKey(req);
    const wait = limiter.blocked(key);
    if (wait) {
      const minutes = Math.max(1, Math.ceil(wait / 60));
      return refusal(429, "Too many tries", `Too many wrong pairing codes from here. Wait about ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`, {
        tone: "bad",
        form: false,
        headers: { "retry-after": String(wait) },
      });
    }
    if (!sameToken(presented, store.pairingToken())) {
      limiter.fail(key);
      return refusal(
        403,
        "That pairing link has expired",
        "The code was replaced (New QR code or Unpair all), or it was mistyped. Scan the QR code the app shows now.",
        { tone: "bad" },
      );
    }
    return null;
  }

  /** A good code from a browser: a device row, its cookie, and where to go next. */
  function pairDevice(req, device, cookieValue, location) {
    const secure = isSecure(req);
    const maxAgeS = settings().cookieDays * 86_400;
    const headers = { "cache-control": "no-store", location, "referrer-policy": "no-referrer" };
    if (!device) {
      const added = store.addDevice({ userAgent: req?.headers?.["user-agent"] });
      headers["set-cookie"] = cookieHeader(added.cookie, { secure, maxAgeS });
      log(`remote: paired a new device (${added.device.name})`);
    } else if (cookieValue) {
      headers["set-cookie"] = cookieHeader(cookieValue, { secure, maxAgeS });
    }
    return headers;
  }

  /**
   * POST /api/remote/pair, from the blocking page's form (`code=`, urlencoded) or a script
   * (JSON `{ code }`). Resolves what to send: a 303 to the app with the device cookie, or
   * the blocking page again with the reason.
   */
  function pair(req, code) {
    if (!tunnelRequest(req)) return { status: 400, error: "pairing is for devices that open the phone link; this machine needs none" };
    const presented = tokenFromInput(code);
    if (!presented) return refusal(400, "Pair this device first", "Paste the pairing link or code from the app, then try again.");
    const refused = refuseCode(req, presented);
    if (refused) return refused;
    const cookieValue = readCookie(req?.headers?.cookie, COOKIE) ?? readCookie(req?.headers?.cookie, COOKIE_PLAIN);
    const device = cookieValue ? store.verifyDevice(cookieValue, { maxIdleMs: maxIdleMs() }) : null;
    return { status: 303, location: "/", headers: pairDevice(req, device, cookieValue, "/") };
  }

  /**
   * The gate. Returns null when the request may proceed, otherwise what to send.
   * Loopback requests are never gated. Order: a presented pairing code (query, header,
   * bearer) is checked first, then the device cookie.
   */
  function gate(req, res) {
    if (!tunnelRequest(req)) return null;

    const url = new URL(String(req?.url ?? "/"), "http://placeholder");
    const secure = isSecure(req);
    // The pairing form's own route answers with its own checks (pair() below).
    if (url.pathname === "/api/remote/pair" && req?.method === "POST") return null;
    const isPage = req?.method === "GET" && !url.pathname.startsWith("/api/");

    const fromQuery = url.searchParams.get("t") ?? url.searchParams.get("token");
    const fromHeader = req?.headers?.["x-rosalena-pair"] ?? req?.headers?.["x-rosalena-remote"];
    const authorization = String(req?.headers?.authorization ?? "");
    let presented = null;
    let source = null;
    if (fromQuery) {
      presented = tokenFromInput(fromQuery);
      source = "query";
    } else if (fromHeader) {
      presented = String(fromHeader);
      source = "header";
    } else if (/^bearer\s+/i.test(authorization)) {
      presented = authorization.replace(/^bearer\s+/i, "").trim();
      source = "header";
    }

    const cookieValue = readCookie(req?.headers?.cookie, COOKIE) ?? readCookie(req?.headers?.cookie, COOKIE_PLAIN);
    let device = cookieValue ? store.verifyDevice(cookieValue, { maxIdleMs: maxIdleMs() }) : null;

    if (presented) {
      const refused = refuseCode(req, presented);
      if (refused) return refused;
      if (source === "query" && isPage) {
        const remaining = new URLSearchParams(url.searchParams);
        remaining.delete("t");
        remaining.delete("token");
        const query = remaining.toString();
        const location = `${url.pathname}${query ? `?${query}` : ""}`;
        return { status: 302, location, headers: pairDevice(req, device, device ? null : cookieValue, location) };
      }
      // A script or a probe with the code in a header: allowed for this one request.
      if (req) req.rosalenaDevice = device;
      return null;
    }

    if (device) {
      if (req) req.rosalenaDevice = device;
      track(device.id, res);
      // Sliding expiry: every page load re-sets the cookie's Max-Age.
      if (isPage && res && typeof res.setHeader === "function" && cookieValue) {
        res.setHeader("set-cookie", cookieHeader(cookieValue, { secure, maxAgeS: settings().cookieDays * 86_400 }));
      }
      return null;
    }

    const stale = Boolean(cookieValue);
    return refusal(
      401,
      stale ? "This device was unpaired" : "Pair this device first",
      stale
        ? "It was unpaired on the computer running Rosalena, or it was not used for too long. Pair it again to keep going."
        : "This is a private Rosalena app. Nothing here is shown until this device is paired with it.",
      { headers: stale ? { "set-cookie": clearedCookieHeaders() } : {} },
    );
  }

  /** Forget this device, from the device itself. */
  function unpair(req, res) {
    const device = req?.rosalenaDevice ?? null;
    if (device?.id) store.removeDevice(device.id);
    if (res && typeof res.setHeader === "function") res.setHeader("set-cookie", clearedCookieHeaders());
    if (device?.id) log("remote: a device unpaired itself");
    return { ok: true };
  }

  function settledFor() {
    if (state.state !== "starting" && state.state !== "stopping") return Promise.resolve(status());
    return new Promise((resolve) => settleWaiters.push(resolve));
  }

  /**
   * Ask the public URL (the relay's, when it is linked) for the app's own status, with the
   * pairing code in a header (not the URL, which the edge logs). Network failures are
   * retried a few times: a fresh quick tunnel takes a couple of seconds to route.
   */
  async function check({ attempts = 3, gapMs = 1500 } = {}) {
    const pub = publicUrl();
    if (state.state !== "live" || !pub) return { ok: false, error: "phone access is not live, so there is nothing outside to check" };
    const target = `${pub.replace(/\/+$/, "")}/api/remote/status`;
    const startedAt = now();
    let last = null;
    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
      try {
        const res = await fetchImpl(target, {
          method: "GET",
          redirect: "manual",
          headers: { accept: "application/json", "x-rosalena-pair": store.pairingToken() },
          signal: AbortSignal.timeout(checkTimeoutMs),
        });
        const text = await res.text().catch(() => "");
        const ms = now() - startedAt;
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (res.status === 200 && parsed?.remote?.state === "live") {
          return { ok: true, status: res.status, ms, attempt, url: pub, note: `${pub} answered this app through Cloudflare` };
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false, status: res.status, ms, attempt, url: pub, error: "the link is reachable but refused the pairing code; it was replaced in another window" };
        }
        return { ok: false, status: res.status, ms, attempt, url: pub, error: `the public URL answered HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
      } catch (err) {
        last = { err, ms: now() - startedAt, attempt };
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
    }
    return {
      ok: false,
      ms: last?.ms ?? now() - startedAt,
      attempt: last?.attempt ?? 0,
      url: pub,
      error:
        `the public URL did not answer after ${last?.attempt ?? 0} attempts (${last?.err?.message ?? "unknown failure"}). ` +
        `Cloudflare takes a few seconds to route a fresh tunnel; if this repeats, the tunnel's edge connection is down`,
    };
  }

  return {
    COOKIE,
    port: uiPort,
    store,
    status,
    statusFor,
    enable,
    disable,
    shutdown,
    autoStart,
    revoke,
    removeDevice,
    unpairAll,
    updateSettings,
    unpair,
    pair,
    settled: settledFor,
    gate,
    tunnelRequest,
    isLocal,
    check,
    healthTick,
    get wanted() {
      return wanted;
    },
    get token() {
      return store.pairingToken();
    },
  };
}
