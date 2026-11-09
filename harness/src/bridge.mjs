/**
 * The local bridge: the one way a web page can borrow the desktop app's connection.
 *
 * Why this exists at all. The trial page on rosalena.pages.dev must not spend anyone's
 * quota from a shared address, so it answers from the visitor's own machine. Running a
 * model in the tab covers the GPU. For the *free API models* the page cannot call
 * opencode.ai directly - that gateway sends no `Access-Control-Allow-Origin`, and a
 * preflight is a 404, so a browser can never read the answer (measured, see
 * data\probe-cors.mjs). The desktop app can, because it is Node.
 *
 * So the page talks to the app on loopback instead, and the app makes the request. The
 * exit node is the visitor's own connection, using the visitor's own keyless window -
 * exactly what the desktop app already does for itself.
 *
 * Three things make that safe to leave running:
 *
 *   1. An origin allowlist. Only the site's origins get CORS headers at all; a random
 *      page gets no `Access-Control-Allow-Origin` and cannot read a byte, including
 *      the error. The allowlist is checked against `Origin`, not `Referer`, because
 *      `Origin` is the one a browser will not let script forge.
 *   2. A pairing token. Loopback is otherwise open to every page in every tab, so the
 *      app holds a secret and the page must present it in `x-rosalena-pair`. The token
 *      rides in the *fragment* of the pairing URL (`#pair=...`), which is never sent to
 *      a server, never in a Referer, and not readable by another origin.
 *   3. A per-token budget. A copied token, or a bug in a page, cannot turn into a
 *      thousand requests: past the budget the bridge says 429 and spends nothing.
 *
 * Chrome sends a Private Network Access preflight when a public page reaches loopback,
 * so the preflight answer carries `Access-Control-Allow-Private-Network: true`. Without
 * it the request is blocked before it leaves the browser and looks like a dead app.
 */

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Fixed so a page knows where to look without being told a port. */
export const BRIDGE_PORT = 8765;

/**
 * The only origins that may read the bridge. The deployed site plus the local site dev
 * server; anything else is a stranger. Kept as an exact list - no wildcards, no
 * "ends with pages.dev", because a preview deployment of a stranger's repo would match.
 */
export const DEFAULT_ORIGINS = Object.freeze([
  // rosalena.dev is the site's address since 2026-11-09; rosalena.pages.dev still serves it.
  "https://rosalena.dev",
  "https://www.rosalena.dev",
  "https://rosalena.pages.dev",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
]);

/** Requests per token per window. One visitor typing quickly never reaches this. */
const BUDGET = { limit: 20, windowMs: 60_000 };
const MAX_BODY = 32 * 1024;
const MAX_TOKENS_OUT = 600;
const UPSTREAM_TIMEOUT = 60_000;

export class BridgeError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = "BridgeError";
    this.kind = kind;
    this.status = status;
  }
}

/** A token the app keeps and shows once, and the page remembers in sessionStorage. */
export function bridgeToken(home) {
  const file = join(home, "bridge-token.txt");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    // A truncated or hand-edited file is not a token: mint a new one rather than
    // accepting a weak secret that someone might have typed.
    if (/^[A-Za-z0-9_-]{24,}$/.test(existing)) return existing;
  }
  const fresh = randomBytes(24).toString("base64url");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${fresh}\n`, { encoding: "utf8", mode: 0o600 });
  return fresh;
}

/** The URL that pairs a browser with this app. The secret lives after the `#`. */
export function pairingUrl(token, site = "https://rosalena.pages.dev") {
  return `${site}/try/#pair=${token}`;
}

function sameToken(given, expected) {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function corsHeaders(origin, origins) {
  if (!origins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-rosalena-pair",
    "access-control-max-age": "600",
    // Chrome's Private Network Access: a public page reaching 127.0.0.1 asks first,
    // and a preflight without this header is treated as a refusal.
    "access-control-allow-private-network": "true",
    vary: "origin",
  };
}

/**
 * The router's chat endpoint, from whatever shape the caller was given. The desktop app
 * passes `http://127.0.0.1:8077/v1` (the OpenAI-style base), and a base is not an
 * endpoint: appending blindly produced `/v1/v1/chat/completions`, which the router
 * answered with a 404. Accept both shapes rather than making every caller remember.
 */
export function chatEndpoint(routerUrl) {
  const base = String(routerUrl ?? "").replace(/\/+$/, "");
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BridgeError("bad_request", `the request body exceeds ${limit} bytes`, 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The body the router receives. The visitor's page may argue about the text; it may not
 * reach for tools, files, a system role or a bigger answer than the demo promises, and
 * it always streams, because the page renders token by token.
 */
export function bridgeRequestBody(payload = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const kept = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-16)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  if (kept.length === 0 || kept[kept.length - 1].role !== "user") {
    throw new BridgeError("bad_request", "the conversation must end with a user message", 400);
  }
  const asked = Number(payload.max_tokens);
  const maxTokens = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_TOKENS_OUT) : MAX_TOKENS_OUT;
  // The class the router is asked for is the operator's, never the page's: the page sends
  // no model, and a body that names one is ignored rather than obeyed, so the header can
  // keep naming one model. Defaults to the pinned free class, which is the same model the
  // hosted path names; ROSALENA_BRIDGE_MODEL picks a different class for one app.
  const asked2 = String(process.env.ROSALENA_BRIDGE_MODEL || "").trim();
  const model = asked2 || "deepseek";
  return { model, messages: kept, max_tokens: maxTokens, stream: true };
}

/**
 * Start the bridge. Returns something testable: the token, the URL, a ready promise and
 * a close function. `fetchImpl` is injectable so a test can watch exactly what the app
 * sends upstream without a router or a network.
 */
export function createBridge({
  home,
  port = BRIDGE_PORT,
  host = "127.0.0.1",
  routerUrl = "http://127.0.0.1:8077",
  routerHeaders = {},
  origins = DEFAULT_ORIGINS,
  token = null,
  fetchImpl = (url, init) => fetch(url, init),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!home) throw new Error("createBridge needs a home directory for its token");
  const secret = token ?? bridgeToken(home);
  const allowedOrigins = [...origins];
  const spends = new Map(); // token -> [timestamps]

  function spend(used) {
    const at = now();
    const recent = (spends.get(used) ?? []).filter((t) => at - t < BUDGET.windowMs);
    if (recent.length >= BUDGET.limit) {
      const waitMs = BUDGET.windowMs - (at - recent[0]);
      throw new BridgeError("budget", `this bridge allows ${BUDGET.limit} requests a minute; try again in ${Math.ceil(waitMs / 1000)} s`, 429);
    }
    recent.push(at);
    spends.set(used, recent);
  }

  async function proxy(req, res, cors, format) {
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      throw new BridgeError("bad_request", "the request body is not JSON", 400);
    }
    const upstreamBody = bridgeRequestBody(payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT);
    let upstream;
    try {
      upstream = await fetchImpl(chatEndpoint(routerUrl), {
        method: "POST",
        headers: { "content-type": "application/json", ...routerHeaders },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new BridgeError(
        "router_down",
        `the desktop app's router is not answering (${err?.message ?? err}); start it with: node src/index.mjs from the router folder`,
        503,
      );
    }

    if (!upstream.ok) {
      clearTimeout(timer);
      const text = await upstream.text().catch(() => "");
      log(`bridge: router answered ${upstream.status}: ${text.slice(0, 200)}`);
      throw new BridgeError("router_error", text.slice(0, 400) || `the router answered ${upstream.status}`, upstream.status >= 500 ? 502 : upstream.status);
    }

    res.writeHead(200, {
      ...cors,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-rosalena-answer": "local-app",
    });
    const trial = format === "trial";
    let outTokens = 0;
    let held = "";
    // The site's page parses one frame shape: {delta}, {done, usage}, {error}. The router
    // speaks OpenAI's. Translating here keeps that knowledge in one place instead of
    // teaching the page a second protocol, and `?format=trial` is opt-in, so a caller that
    // wants the router's frames verbatim still gets them.
    const emitTrial = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return; // a frame split across chunks is not a frame yet
      }
      if (parsed?.error) {
        const said = typeof parsed.error === "string" ? parsed.error : parsed.error.message;
        res.write(`data: ${JSON.stringify({ error: String(said ?? "the model refused"), kind: "provider" })}\n\n`);
        return;
      }
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        res.write(`data: ${JSON.stringify({ delta })}\n\n`);
      }
      const completion = parsed?.usage?.completion_tokens;
      if (Number.isFinite(completion)) outTokens = completion;
    };

    try {
      if (!upstream.body) {
        res.end();
        return;
      }
      if (!trial) {
        for await (const chunk of upstream.body) res.write(chunk);
      } else {
        for await (const chunk of upstream.body) {
          held += new TextDecoder().decode(chunk, { stream: true });
          let cut = held.search(/\r?\n/);
          while (cut >= 0) {
            const line = held.slice(0, cut);
            held = held.slice(cut + (held[cut] === "\r" ? 2 : 1));
            emitTrial(line);
            cut = held.search(/\r?\n/);
          }
        }
        if (held.trim()) emitTrial(held);
        res.write(`data: ${JSON.stringify({ done: true, usage: { output: outTokens } })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
    } catch (err) {
      // The status line is long gone, so the only honest thing left is an error frame the
      // page can render rather than a truncated answer that looks complete.
      const message = String(err?.message ?? err);
      const frame = trial
        ? `data: ${JSON.stringify({ error: message, kind: "upstream" })}\n\n`
        : `data: ${JSON.stringify({ error: { message, kind: "upstream" } })}\n\n`;
      res.write(frame);
    } finally {
      clearTimeout(timer);
      res.end();
    }
  }

  const server = createServer((req, res) => {
    const origin = String(req.headers.origin ?? "");
    const cors = corsHeaders(origin, allowedOrigins);
    const path = (req.url ?? "").split("?")[0];
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
      res.end(JSON.stringify(body));
      return undefined;
    };
    const fail = (err) => {
      const known = err instanceof BridgeError;
      const status = known ? err.status : 500;
      if (!known) log(`bridge: ${err?.stack ?? err}`);
      send(status, { error: { message: String(err?.message ?? err), kind: known ? err.kind : "internal" } });
    };

    if (req.method === "OPTIONS") {
      // A stranger still gets no CORS headers, but the wake-up call is cheap: answer
      // 204 and let the browser do the refusing, which it does when the header is absent.
      res.writeHead(204, { ...cors, "access-control-max-age": "600" });
      res.end();
      return;
    }

    if (path === "/health" && req.method === "GET") {
      send(200, { ok: true, app: "rosalena-harness", bridge: 1, tokenRequired: true, answer: "local-app" });
      return;
    }

    if (path !== "/v1/chat" || req.method !== "POST") {
      send(404, { error: { message: "no such route on the bridge", kind: "not_found" } });
      return;
    }

    if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
      send(403, { error: { message: `the bridge does not answer the origin ${JSON.stringify(origin)}`, kind: "forbidden" } });
      return;
    }

    if (!sameToken(req.headers["x-rosalena-pair"], secret)) {
      send(401, {
        error: {
          message: "this page is not paired with the app: open the pairing link the app printed",
          kind: "unpaired",
        },
      });
      return;
    }

    try {
      spend(secret);
    } catch (err) {
      fail(err);
      return;
    }

    log(`bridge: ${origin || "(no origin)"} -> ${routerUrl} (${req.headers["content-length"] ?? "?"} bytes)`);
    const format = new URL(`http://127.0.0.1${req.url ?? "/"}`).searchParams.get("format");
    proxy(req, res, cors, format === "trial" ? "trial" : "openai").catch(fail);
  });

  let address = null;

  return {
    token: secret,
    get address() {
      return address;
    },
    /** The URL a page should call. `port` is only meaningful once ready() resolves. */
    get url() {
      return `http://${host}:${address?.port ?? port}/`;
    },
    ready() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          address = server.address();
          log(`bridge: listening on http://${host}:${address.port}/ (pairing token in data\\bridge-token.txt)`);
          resolve({ port: address.port, url: `http://${host}:${address.port}/` });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
