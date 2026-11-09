/**
 * The OpenAI-compatible HTTP surface.
 *
 * Anything that can talk to OpenAI can talk to this, which is the entire reason
 * the router is shaped this way: Cursor, Continue, an SDK, a shell script and the
 * harness all already know this protocol, so none of them need a bespoke client.
 * The only extension is that `model` may name a task class instead of a model.
 */

import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import { classifyRequest, route, RouterError } from "./router.mjs";
import { computeCostUsd, monthKey } from "./limits.mjs";
import { anthropicStreamToOpenAI, pricesFor, rewriteSseToolNames } from "./providers.mjs";
import { authToken, validateConfig } from "./config.mjs";
import { setBudget } from "./budgets.mjs";
import { personaFor } from "./persona.mjs";
import { providerLabels, rollupText, tokenFields } from "./usage.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Constant-time compare, and a length check first so it cannot leak by length. */
function tokenMatches(given, wanted) {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(wanted, "utf8");
  if (!b.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `Authorization: Bearer <t>`, or for clients that dislike that header,
 * `x-router-token`. `x-rosalena-token` is accepted too: that is the name the
 * harness UI already sends (to the harness, and to the router's model menu), so a
 * panel that reuses its own client keeps working against this gate.
 */
function presentedToken(req) {
  const header = String(req.headers["authorization"] ?? "");
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1].trim();
  return String(req.headers["x-router-token"] ?? req.headers["x-rosalena-token"] ?? "").trim();
}

function sendJson(res, status, obj) {
  // Headers can only be written once. By the time a streamed response fails the
  // status line and frames are already on the wire, so trying to writeHead here
  // threw ERR_HTTP_HEADERS_SENT *inside the error path* and took the whole router
  // process down (measured 2026-10-19: the harness's step watchdog aborted a call,
  // the relay failed, and the router exited 1). Ending the response is all that is
  // left to do once a body has started.
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** OpenAI-shaped error, so an existing client's error handling keeps working. */
function sendError(res, status, message, extra) {
  sendJson(res, status, {
    error: {
      message,
      type: status === 400 ? "invalid_request_error" : "router_error",
      code: status,
      ...(extra ? { router: extra } : {}),
    },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
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
 * Watch the frames a streamed reply carries for the provider's own `usage`.
 *
 * A streamed call's token count does not exist until the last chunk, and for
 * OpenAI-compatible providers it is only sent at all when the request asked for it
 * (`stream_options.include_usage`, which a provider opts into with `streamUsage` in
 * the config). Without this, the busiest path in the system - everything the harness
 * runs streams by default - would record call counts with no tokens behind them.
 *
 * The frame is parsed rather than pattern-matched because a half frame split across
 * two chunks must not be counted, and `[DONE]` is not JSON.
 */
function createUsageTap() {
  const decoder = new TextDecoder();
  let buf = "";
  let usage = null;
  return {
    feed(chunk) {
      if (!chunk) return;
      buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:") || !line.includes('"usage"')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          if (ev?.usage) usage = ev.usage;
        } catch {
          // A frame that is not whole yet: the rest arrives on the next chunk.
        }
      }
      // A stream that never sends a newline must not grow this buffer forever.
      if (buf.length > 1_000_000) buf = "";
    },
    usage: () => usage,
  };
}

/**
 * One usage line for a completed stream. Called after `res.end()`, so a stream the
 * client walked away from mid-flight records nothing - a truncated stream is a
 * failed call, and the attempt log already carries the reason.
 */
function recordStreamUsage(ctx, out, spec, usage, ms) {
  try {
    const measured = Boolean(usage) && typeof usage === "object";
    ctx.usage?.record({
      at: new Date().toISOString(),
      provider: out.provider,
      model: out.model,
      target: out.target,
      ...tokenFields(measured ? usage : null, spec?.kind ?? "openai"),
      calls: 1,
      usd: measured ? computeCostUsd(pricesFor(spec, out.model), usage) : 0,
      ok: true,
      ms,
      stream: true,
      // The provider reported no usage at all: the call is counted, its tokens are
      // not invented.
      ...(measured ? {} : { measured: false }),
    });
  } catch {
    // A usage write must never be the reason a response fails.
  }
}

/** Relay an upstream stream, translating it to OpenAI frames when it is not already. */
async function relayStream(res, out, ctx) {
  const spec = ctx.config.providers[out.provider];
  const started = Date.now();
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-router-target": out.target,
  });

  const body = out.response.body;
  if (!body) {
    res.end("data: [DONE]\n\n");
    recordStreamUsage(ctx, out, spec, null, Date.now() - started);
    return;
  }

  const tap = createUsageTap();
  let streamed = null;

  if (spec.kind === "anthropic") {
    const onUsage = (usage) => {
      streamed = usage;
      const usd = computeCostUsd(pricesFor(spec, out.model), usage);
      ctx.ledger?.record(out.provider, usd, {
        model: out.model,
        tokensIn: usage.prompt_tokens,
        tokensOut: usage.completion_tokens,
      });
      ctx.logger?.log("stream_usage", { requestId: ctx.requestId, target: out.target, usd });
    };
    for await (const frame of anthropicStreamToOpenAI(body, { model: out.model, onUsage })) {
      tap.feed(frame);
      if (!res.write(frame)) await once(res, "drain");
    }
  } else if (out.aliases?.size) {
    // A provider that required a renamed tool (OpenCode's free tier wants exactly
    // `read`) must not hand the caller a tool it never advertised, so the frames
    // are parsed and rewritten here instead of being copied byte for byte.
    for await (const frame of rewriteSseToolNames(body, out.aliases)) {
      tap.feed(frame);
      if (!res.write(frame)) await once(res, "drain");
    }
  } else {
    const reader = body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      tap.feed(value);
      if (!res.write(Buffer.from(value))) await once(res, "drain");
    }
  }

  // Anthropic reports usage out of band (its frames are translated on the way
  // through); everything else is read out of the frames themselves.
  const finalUsage = streamed ?? tap.usage();
  // This call's price, as an SSE comment: clients that only read `data:` frames (the
  // spec says comments are ignored) see nothing, and Rosalena adds it to the run's spend.
  // A header cannot carry it - they were sent before the first token.
  const measured = Boolean(finalUsage) && typeof finalUsage === "object";
  res.write(`: x-router-cost ${JSON.stringify({ usd: measured ? computeCostUsd(pricesFor(spec, out.model), finalUsage) : 0, measured, target: out.target })}\n\n`);
  res.end();
  recordStreamUsage(ctx, out, spec, finalUsage, Date.now() - started);
  ctx.logger?.log("stream_end", { requestId: ctx.requestId, target: out.target });
}

async function handleChat(req, res, ctx) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  let body;
  try {
    const text = await readBody(req);
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    return sendError(res, 400, `invalid request body: ${err.message}`);
  }

  const decided = classifyRequest({
    model: body.model,
    headerClass: req.headers["x-router-class"],
    config: ctx.config,
  });
  if (decided.error) {
    return sendError(res, 400, `${decided.error}. Classes: ${(decided.classes ?? []).join(", ")}.`);
  }

  // See the note at createRouterServer: a class that declares a system prompt and has
  // none loaded refuses the request. Failing here rather than silently answering is the
  // whole point - the caller asked for Rosalena and would otherwise get an unnamed model.
  if (ctx.config?.classes?.[decided.cls]?.systemPromptFile && !personaFor(ctx.personas, decided.cls)) {
    return sendError(
      res,
      500,
      `class "${decided.cls}" declares a system prompt but none is loaded, so the router will not answer under that name`,
    );
  }

  const controller = new AbortController();
  // A time-to-first-byte guard, not a whole-request ceiling: a long stream is
  // legitimate, a provider that never answers is not.
  const timer = setTimeout(() => controller.abort(new Error("router timeout")), ctx.config.requestTimeoutMs);
  // Listen on `res`, not `req`: since Node 16 `req`'s "close" fires as soon as the
  // request BODY has been consumed, which would abort every upstream call the
  // instant we finished reading the body. `res`'s "close" with an unfinished
  // response is the actual client-disconnected signal.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort(new Error("client disconnected"));
  });

  let out = null;
  let streaming = false;
  try {
    out = await route({
      config: ctx.config,
      ledger: ctx.ledger,
      keyPool: ctx.keyPool,
      breaker: ctx.breaker,
      logger: ctx.logger,
      // The usage store rides along so route() can write the one line per
      // completed call; the streamed path gets it through relayStream below.
      usage: ctx.usage,
      cls: decided.cls,
      pinned: decided.pinned,
      body,
      // Class-owned system prompts (src/persona.mjs), loaded once at startup. Passed
      // through so route() can prepend one; nothing on the HTTP surface below ever
      // reports their text.
      personas: ctx.personas ?? null,
      fetchImpl: ctx.fetchImpl,
      signal: controller.signal,
      requestId,
      // Session affinity for providers that gate on a client session id
      // (OpenCode's free tier). The caller's conversation id wins; without one the
      // router still mints a per-request id, because a missing id is a hard 403.
      sessionId: String(req.headers["x-rosalena-session"] ?? "").trim() || `router-${requestId}`,
    });
    clearTimeout(timer);

    if (out.stream) {
      streaming = true;
      await relayStream(res, out, { ...ctx, requestId });
      return;
    }
    res.setHeader("x-router-target", out.target);
    // The price of this one call (the streamed path sends it as a closing comment).
    res.setHeader("x-router-cost-usd", String(Number(out.usd) || 0));
    return sendJson(res, 200, out.completion);
  } catch (err) {
    clearTimeout(timer);
    // Once streaming has started there is no HTTP error left to send: the 200 and
    // its headers are already on the wire, and the usual cause is the client itself
    // going away (the harness aborts a step that overran its timeout). Report it as
    // a stream failure and close the connection - do not try to answer with JSON.
    if (streaming || res.headersSent) {
      ctx.logger?.log("stream_failed", {
        requestId,
        cls: decided.cls,
        target: out?.target,
        message: String(err?.message ?? err).slice(0, 200),
      });
      if (!res.writableEnded) res.end();
      return;
    }
    if (err?.name === "AbortError") return sendError(res, 504, "router timed out waiting for an upstream provider");
    const status = err instanceof RouterError ? err.status : 500;
    ctx.logger?.log("request_failed", { requestId, cls: decided.cls, status, message: err.message });
    return sendError(res, status, err.message, err.meta);
  }
}

function handleModels(res, ctx) {
  const data = [];
  for (const [cls, entry] of Object.entries(ctx.config.classes ?? {})) {
    data.push({ id: cls, object: "model", owned_by: "router:class", chain: entry.chain });
  }
  for (const [provider, spec] of Object.entries(ctx.config.providers ?? {})) {
    data.push({ id: `${provider}/*`, object: "model", owned_by: `provider:${provider}`, baseUrl: spec.baseUrl });
  }
  sendJson(res, 200, { object: "list", data });
}

function handleStatus(res, ctx) {
  const month = monthKey();
  const budgets = ctx.config.budgets?.monthlyUsd ?? {};
  const spend = ctx.ledger?.snapshot(month)?.providers ?? {};
  const circuit = ctx.breaker?.stats(Object.keys(ctx.config.providers ?? {})) ?? { enabled: false, providers: {} };
  const providers = {};
  for (const [name, spec] of Object.entries(ctx.config.providers ?? {})) {
    const cap = budgets[name] ?? null;
    providers[name] = {
      kind: spec.kind,
      baseUrl: spec.baseUrl,
      // Advertised so a picker can offer effort only where the provider declares the
      // vocabulary. effortBody is deliberately not exposed: it is how the provider is
      // asked to make effort mean something, not a choice for the caller.
      efforts: Array.isArray(spec.efforts) ? spec.efforts : null,
      // What "Default" means when no effort is sent (a level, or "off"), for the picker.
      defaultEffort: spec.defaultEffort ?? null,
      prices: spec.prices ?? null,
      // Per-model prices and efforts where a provider's models differ (Claude Haiku 5.5 is
      // 40x cheaper than Opus 5.5), so the picker labels each row with its own price. Kept
      // apart from `models` on purpose: it describes rows, it never adds one to the menu.
      modelInfo: Object.fromEntries(
        (Array.isArray(spec.models) ? spec.models : [])
          .filter((m) => m && typeof m === "object" && m.id && (m.prices || m.efforts || m.defaultEffort))
          .map((m) => [
            m.id,
            {
              ...(m.prices ? { prices: m.prices } : {}),
              ...(m.efforts ? { efforts: m.efforts } : {}),
              // null is kept: it means "this model takes no effort", not "not said".
              ...(m.defaultEffort !== undefined ? { defaultEffort: m.defaultEffort } : {}),
            },
          ]),
      ),
      // An optional key is not a missing one: this field answers "can this provider serve a
      // request as configured", and for a route that works without a credential the answer
      // does not change when the key is absent. Reporting false here would make the health
      // page accuse a working route of being broken.
      hasKey: spec.apiKeyEnv && !spec.apiKeyOptional ? Boolean(ctx.keyPool?.all(name).length) : true,
      apiKeyEnv: spec.apiKeyEnv,
      apiKeyOptional: Boolean(spec.apiKeyOptional),
      spentUsd: spend[name]?.usd ?? 0,
      calls: spend[name]?.calls ?? 0,
      capUsd: cap,
      remainingUsd: ctx.ledger?.remaining(name, cap) ?? null,
      withinBudget: ctx.ledger ? ctx.ledger.within(name, cap) : true,
      keys: ctx.keyPool?.stats()?.[name] ?? [],
      circuit: circuit.providers?.[name] ?? { state: "closed", fails: 0, trips: 0 },
    };
  }
  sendJson(res, 200, {
    status: "ok",
    month,
    breaker: { enabled: circuit.enabled, threshold: circuit.threshold },
    classes: Object.fromEntries(
      Object.entries(ctx.config.classes ?? {}).map(([cls, e]) => [
        cls,
        // `custom` is a BOOLEAN, never the path or the text: the harness needs to know
        // that this class answers under its own identity (so it can list it as a model),
        // and nothing here may let a caller read, count or guess the prompt.
        { chain: e.chain, custom: Boolean(e.systemPromptFile) },
      ]),
    ),
    models: ctx.config.models ?? [],
    providers,
    // Where this router reads provider keys from, so the app's Settings page writes the file
    // this process actually watches (it differs between a checkout and an installed app).
    keyFile: ctx.config.keyFile ?? null,
    warnings: ctx.warnings,
    recent: ctx.logger?.recent(40) ?? [],
  });
}

/**
 * `GET /admin/usage?days=1|30` - the token usage report the panel renders.
 *
 * Same gate as /admin/status: it reveals the provider layout and how much has been
 * run, which is the same class of information as spend. The shape is contractual
 * (see README); `cacheRead`/`cacheWrite` are null, not 0, when no provider in the
 * window reported them, so the panel can print "0" only for a measured zero.
 */
function handleUsage(res, url, ctx) {
  const raw = url.searchParams.get("days");
  const days = raw === null || raw === "" ? 1 : Number(raw);
  if (!Number.isFinite(days) || days < 1) {
    return sendError(res, 400, "days must be a positive number: 1 is today, 30 is the last 30 days");
  }
  const labels = providerLabels(ctx.config);
  // Without a store (an older embedder, a test context) the answer is an honest
  // empty window rather than a 500.
  const report = ctx.usage ? ctx.usage.rollup({ days, labels }) : rollupText("", { days, labels });
  return sendJson(res, 200, report);
}

export function createRouterServer(ctx) {
  const config = ctx.config;
  const warnings = ctx.warnings ?? validateConfig(config, ctx.env ?? process.env);
  const token = authToken(config, ctx.env ?? process.env);

  // A class that declares a system prompt must arrive WITH it. index.mjs loads the
  // prompts once at startup and exits if one is missing, so this is the second gate, for
  // an embedder (a load script, an in-process test) that builds a server by hand: the
  // class REFUSES per request instead of answering under its name with a different
  // assistant's rules, which is the one failure no downstream log could detect. Names are
  // reported; prompt text never is.

  const full = { ...ctx, config, warnings };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // A client that disconnects mid-stream can make a write fail with EPIPE, and an
    // 'error' event on the response with no listener is an uncaught exception - the
    // same process-killing class as the writeHead-after-headers bug. The disconnect
    // is already handled through res' "close" and the abort it triggers.
    res.on("error", () => {});

    try {
      // /health stays open: it carries no spend, no keys and no models, and it is
      // what a probe uses to decide whether the router is up at all. Everything
      // that can spend money or reveal the provider layout is behind the token.
      if (token && (path.startsWith("/v1/") || path.startsWith("/admin/"))) {
        if (!tokenMatches(presentedToken(req), token)) {
          res.setHeader("www-authenticate", 'Bearer realm="rosalena-router"');
          return sendError(res, 401, "missing or wrong router token - send Authorization: Bearer <token>");
        }
      }
      if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
        return sendJson(res, 200, {
          status: "ok",
          service: "rosalena-router",
          classes: Object.keys(config.classes ?? {}),
          providers: Object.keys(config.providers ?? {}),
          warnings,
        });
      }
      if (req.method === "GET" && path === "/admin/status") return handleStatus(res, full);
      if (req.method === "GET" && path === "/admin/usage") return handleUsage(res, url, full);
      // Settings > Spend limits: one provider's monthly cap, applied to the next request.
      if (req.method === "PUT" && path === "/admin/budgets") {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return sendError(res, 400, "the body must be JSON: {provider, monthlyUsd}");
        }
        try {
          const capUsd = setBudget(config, body.provider, body.monthlyUsd);
          full.logger?.log("budget", { provider: body.provider, capUsd });
          return sendJson(res, 200, { ok: true, provider: body.provider, capUsd, spentUsd: full.ledger?.spent(body.provider) ?? 0 });
        } catch (err) {
          return sendError(res, err?.status ?? 500, String(err?.message ?? err));
        }
      }
      if (req.method === "GET" && path === "/v1/models") return handleModels(res, full);
      // `await` matters: without it a rejection inside handleChat never reaches this
      // catch, it becomes an unhandled rejection, and the guard below - whose whole
      // job is to keep a throwing handler from taking the process down - is bypassed.
      if (req.method === "POST" && path === "/v1/chat/completions") return await handleChat(req, res, full);

      return sendError(res, 404, `no route for ${req.method} ${path}`);
    } catch (err) {
      // Last-resort guard: a throwing handler must not take the process down.
      if (!res.headersSent) sendError(res, 500, `router internal error: ${err?.message ?? err}`);
      else res.end();
    }
  });
}
