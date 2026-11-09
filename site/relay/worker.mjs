/**
 * Rosalena phone-access relay: one stable hostname per install, in front of a quick tunnel.
 *
 *   https://<id>.rosalena.dev/...  ->  https://<current>.trycloudflare.com/...
 *
 * A Cloudflare quick tunnel gets a new random hostname every time cloudflared starts, so a
 * phone's bookmark (and the device cookie that lives on that hostname) would die with
 * every restart of the app. The app registers its current tunnel URL here under a
 * per-install id, and this Worker forwards that id's hostname to it.
 *
 * The rules that keep it from being anything more than that:
 *
 * - It forwards only to a registered target, and a target can only be the origin of a
 *   Cloudflare quick tunnel (`https://<label>.trycloudflare.com/`, nothing after the
 *   slash). The path and query of the incoming request are appended; the host never comes
 *   from the request. It cannot be pointed at an arbitrary site, so it is not an open proxy.
 * - Ids are 24 base32 characters (120 bits, minted by the app). The first registration
 *   claims an id with a secret (256 bits); only the SHA-256 of the secret is stored, and
 *   every later registration must present the same secret. Rows are never deleted, only
 *   emptied (unregister clears the target), so a released id cannot be claimed by someone
 *   else and pointed at their tunnel while a phone still has it bookmarked.
 * - Cookies: only the app's own device cookie is passed on to the tunnel (every relayed
 *   app is a sibling subdomain of rosalena.dev, so a browser may hold others), and a
 *   Set-Cookie coming back loses any Domain= attribute, so one app can never set a cookie
 *   for its siblings or for rosalena.dev itself.
 * - Responses stream: the body is passed through as a stream (the app's runs arrive over
 *   Server-Sent Events) and WebSocket upgrades are handed straight to the tunnel.
 * - When the tunnel is gone (the app is closed, the PC asleep), a page says so and retries
 *   on its own every 10 s. The phone does not need to pair again.
 * - Registration is rate limited per client address, and so is claiming new ids.
 *
 * Bindings (wrangler.toml): DB (D1, schema in schema.sql), RELAY_SUFFIX (".rosalena.dev"),
 * API_HOST ("relay.rosalena.dev"). See README.md for the deploy steps.
 */

export const ID_RE = /^[a-z2-7]{24}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
export const TARGET_RE = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com\/?$/;

/** Cookies the app sets; nothing else a browser holds for *.rosalena.dev is passed on. */
const APP_COOKIES = new Set(["__Host-rosalena_device", "rosalena_device"]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Headers the client may not choose: the relay sets them, the edge sets the cf- ones. */
const DROP_REQUEST = /^(cf-|x-forwarded-|x-real-ip$|x-rosalena-client-ip$|x-rosalena-relay$|forwarded$|cdn-loop$)/i;

const LIMITS = { registerPerHour: 120, claimsPerHour: 10 };
const CACHE_MS = 5_000;

function jsonResponse(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameHex(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** The origin of a quick tunnel, normalised, or null. */
export function cleanTarget(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const match = TARGET_RE.exec(text);
  if (!match || match[1] === "api") return null;
  return `https://${match[1]}.trycloudflare.com`;
}

/** D1 behind the four questions this Worker asks. Tests hand in a Map-backed twin. */
export function createD1Store(db) {
  return {
    async get(id) {
      return (await db.prepare("SELECT id, secret_hash, target, updated_at FROM relays WHERE id = ?1").bind(id).first()) ?? null;
    },
    async insert({ id, secretHash, target, at }) {
      await db
        .prepare("INSERT INTO relays (id, secret_hash, target, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
        .bind(id, secretHash, target, at)
        .run();
    },
    async setTarget(id, target, at) {
      await db.prepare("UPDATE relays SET target = ?2, updated_at = ?3 WHERE id = ?1").bind(id, target, at).run();
    },
    /** Count one hit for `key` in the current window; resolves the count including it. */
    async bump(key, window) {
      const row = await db
        .prepare(
          "INSERT INTO relay_limits (key, window, count) VALUES (?1, ?2, 1) " +
            "ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window = ?2 THEN count + 1 ELSE 1 END, window = ?2 " +
            "RETURNING count",
        )
        .bind(key, window)
        .first();
      return Number(row?.count ?? 1);
    },
  };
}

/** The page a phone sees while the computer is not answering. No script; it refreshes itself. */
export function offlinePage() {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10">` +
    `<meta name="robots" content="noindex"><title>Rosalena is offline</title>` +
    `<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070c13;color:#e9f1f9;` +
    `font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px}` +
    `main{max-width:26rem;border:1px solid #2b3b4b;border-radius:16px;background:#0d1621;padding:24px}` +
    `.mark{font-weight:700;color:#9fb3c8;font-size:13px;margin:0 0 14px}h1{font-size:19px;margin:0 0 8px;color:#ffcf6e}p{margin:0 0 10px;color:#c4d4e4}` +
    `</style></head><body><main><p class="mark">Rosalena · Phone access</p><h1>The computer is not answering</h1>` +
    `<p>Rosalena is closed, the computer is asleep, or phone access was turned off.</p>` +
    `<p>This page tries again every 10 seconds. When the app is back you will not need to pair again.</p>` +
    `</main></body></html>`
  );
}

function offline(request) {
  const accept = request.headers.get("accept") ?? "";
  const headers = { "cache-control": "no-store", "retry-after": "10", "x-robots-tag": "noindex" };
  if (request.method === "GET" && accept.includes("text/html")) {
    return new Response(offlinePage(), {
      status: 503,
      headers: {
        ...headers,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      },
    });
  }
  return jsonResponse(503, { error: "offline", detail: "the computer running Rosalena is not answering" }, headers);
}

function filterCookies(header) {
  const kept = [];
  for (const part of String(header ?? "").split(";")) {
    const name = part.split("=")[0]?.trim();
    if (APP_COOKIES.has(name)) kept.push(part.trim());
  }
  return kept.join("; ");
}

/** Drop Domain= so a cookie can only ever land on this one hostname. */
export function hostOnlyCookie(setCookie) {
  return String(setCookie)
    .split(";")
    .filter((attr) => !/^\s*domain\s*=/i.test(attr))
    .join(";");
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

async function api(request, url, deps) {
  const { store, now } = deps;
  if (url.pathname === "/api/health" && request.method === "GET") return jsonResponse(200, { ok: true });
  if (request.method !== "POST" || !["/api/register", "/api/unregister"].includes(url.pathname)) {
    return jsonResponse(404, { error: "not-found" });
  }
  let body = null;
  try {
    const text = await request.text();
    if (text.length > 2048) return jsonResponse(413, { error: "too-large" });
    body = JSON.parse(text);
  } catch {
    return jsonResponse(400, { error: "invalid-json" });
  }
  const id = String(body?.id ?? "");
  const secret = String(body?.secret ?? "");
  if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return jsonResponse(400, { error: "invalid-params" });

  const at = now();
  const hour = Math.floor(at / 3_600_000);
  const ip = clientIp(request);
  if ((await store.bump(`reg:${ip}`, hour)) > LIMITS.registerPerHour) {
    return jsonResponse(429, { error: "rate-limited" }, { "retry-after": "600" });
  }

  const hash = await sha256Hex(secret);
  const row = await store.get(id);

  if (url.pathname === "/api/unregister") {
    if (!row) return jsonResponse(200, { ok: true });
    if (!sameHex(hash, row.secret_hash)) return jsonResponse(403, { error: "auth-failed" });
    await store.setTarget(id, null, at);
    deps.cache?.delete(id);
    return jsonResponse(200, { ok: true });
  }

  const target = cleanTarget(body?.target);
  if (!target) return jsonResponse(400, { error: "invalid-target", detail: "the target must be https://<name>.trycloudflare.com/" });

  if (!row) {
    if ((await store.bump(`claim:${ip}`, hour)) > LIMITS.claimsPerHour) {
      return jsonResponse(429, { error: "rate-limited" }, { "retry-after": "3600" });
    }
    await store.insert({ id, secretHash: hash, target, at });
  } else {
    if (!sameHex(hash, row.secret_hash)) return jsonResponse(403, { error: "auth-failed" });
    await store.setTarget(id, target, at);
  }
  deps.cache?.delete(id);
  return jsonResponse(200, { ok: true, url: `https://${id}${deps.suffix}/` });
}

async function lookup(id, deps) {
  const hit = deps.cache?.get(id);
  if (hit && deps.now() - hit.at < CACHE_MS) return hit.target;
  const row = await deps.store.get(id);
  const target = row?.target ?? null;
  deps.cache?.set(id, { target, at: deps.now() });
  if (deps.cache && deps.cache.size > 1000) deps.cache.clear();
  return target;
}

async function forward(request, url, id, deps) {
  const target = await lookup(id, deps);
  if (!target) return offline(request);

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || DROP_REQUEST.test(lower) || lower === "cookie") continue;
    headers.set(name, value);
  }
  const cookies = filterCookies(request.headers.get("cookie"));
  if (cookies) headers.set("cookie", cookies);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-rosalena-relay", "1");
  headers.set("x-rosalena-client-ip", clientIp(request));

  const destination = `${target}${url.pathname}${url.search}`;
  const isUpgrade = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
  if (isUpgrade) {
    headers.set("upgrade", "websocket");
    headers.set("connection", "Upgrade");
    try {
      // Returned as-is: the Workers runtime hands the client's socket to the tunnel's.
      return await deps.fetchImpl(destination, { method: "GET", headers });
    } catch {
      return offline(request);
    }
  }

  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }
  let res;
  try {
    res = await deps.fetchImpl(destination, init);
  } catch {
    return offline(request);
  }
  // 530 is Cloudflare's "the tunnel has no connector" (error 1033); 502 is cloudflared
  // saying the app behind it is gone. Either way the computer is not answering.
  if (res.status === 530 || (res.status === 502 && !res.headers.get("x-rosalena-app"))) {
    try {
      await res.body?.cancel();
    } catch {
      /* nothing to drain */
    }
    return offline(request);
  }

  const out = new Headers();
  for (const [name, value] of res.headers) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || HOP_BY_HOP.has(lower)) continue;
    out.append(name, value);
  }
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const cookie of setCookies) out.append("set-cookie", hostOnlyCookie(cookie));
  const location = res.headers.get("location");
  if (location) {
    try {
      const resolved = new URL(location, destination);
      if (`${resolved.protocol}//${resolved.host}` === target) out.set("location", `${resolved.pathname}${resolved.search}${resolved.hash}`);
    } catch {
      /* leave it */
    }
  }
  out.set("x-robots-tag", "noindex, nofollow");
  // The body is a stream and stays one: SSE frames reach the phone as they are written.
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

/** The whole Worker, with its world injectable (tests run it in Node with a stub tunnel). */
export async function handle(request, env = {}, deps = {}) {
  const suffix = String(env.RELAY_SUFFIX || ".rosalena.dev").toLowerCase();
  const apiHost = String(env.API_HOST || `relay${suffix}`).toLowerCase();
  const full = {
    suffix,
    store: deps.store ?? createD1Store(env.DB),
    fetchImpl: deps.fetchImpl ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? (() => Date.now()),
    cache: deps.cache ?? null,
  };
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (host === apiHost) return api(request, url, full);
  if (host.endsWith(suffix)) {
    const id = host.slice(0, -suffix.length);
    if (ID_RE.test(id)) return forward(request, url, id, full);
  }
  // Not a phone link (the site, www, anything else on the zone): leave it to its origin.
  // The deploy steps exclude those hostnames from the route, so this is only a fallback.
  if (deps.passThrough === false) return jsonResponse(404, { error: "not-found" });
  return (deps.fetchImpl ?? fetch)(request);
}

// One cache per isolate: a phone loads ~20 files per page, and they need not be 20 lookups.
const isolateCache = new Map();

export default {
  fetch(request, env) {
    return handle(request, env, { cache: isolateCache });
  },
};
