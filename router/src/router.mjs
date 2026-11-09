/**
 * The routing decision itself.
 *
 * A class is a job, not a model. The caller says "code" and the router walks a
 * preference-ordered chain, skipping targets that are over budget, out of keys,
 * or unhealthy, and stopping at the first one that answers. Every skip and every
 * attempt is logged, because "the logs show the fallback path" is the acceptance
 * criterion for T0.1 and a log of successes alone cannot satisfy it.
 */

import { completionToSse, emulateToolsBody, parseEmulatedToolCalls } from "./emulated-tools.mjs";
import { computeCostUsd, maskKey } from "./limits.mjs";
import { personaFor, withNoTools, withSystemPersona } from "./persona.mjs";
import {
  aggregateStreamToCompletion,
  buildUpstreamRequest,
  classifyFailure,
  normalizeResponse,
  parseTarget,
  pricesFor,
  remapToolCalls,
  toOpenAICompletion,
} from "./providers.mjs";
import { tokenFields } from "./usage.mjs";

export class RouterError extends Error {
  constructor(status, message, meta = {}) {
    super(message);
    this.name = "RouterError";
    this.status = status;
    this.meta = meta;
  }
}

/** The preference-ordered targets for a class, or null when the class is unknown. */
export function resolveChain(config, cls) {
  const entry = config?.classes?.[cls];
  if (!entry) return null;
  return (entry.chain ?? []).map((t) => {
    const parsed = parseTarget(t);
    return { ...parsed, name: t };
  });
}

/**
 * Work out what the inbound `model` field is asking for.
 *
 * Three shapes, checked in this order so a pinned OpenRouter id is never mistaken
 * for a class name:
 *   1. a class name            "code"
 *   2. a pinned provider/model "openrouter/anthropic/claude-sonnet-4.5"
 *   3. omitted                 falls back to the default class
 */
export function classifyRequest({ model, headerClass, config }) {
  const classes = Object.keys(config?.classes ?? {});
  if (headerClass && classes.includes(headerClass)) return { cls: headerClass, pinned: null };
  const m = String(model ?? "").trim();
  if (!m) {
    const fallback = config.defaultClass && classes.includes(config.defaultClass) ? config.defaultClass : classes[0];
    return { cls: fallback, pinned: null, defaulted: true };
  }
  if (classes.includes(m)) return { cls: m, pinned: null };
  if (m.includes("/")) {
    const { provider } = parseTarget(m);
    if (config?.providers?.[provider]) return { cls: null, pinned: parseTarget(m), exact: m };
  }
  return { cls: null, pinned: null, error: `unknown class or target "${m}"`, classes };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Route one request.
 *
 * Streaming note, and it is a real limitation rather than an oversight: fallback
 * is only possible BEFORE the first byte reaches the caller. Once chunks are
 * flowing, a mid-stream failure cannot be retried without sending the reply twice,
 * so a stream that dies mid-flight is surfaced as a truncated stream. Buffered
 * requests always get the full fallback guarantee.
 */
export async function route({
  config,
  ledger,
  keyPool,
  logger,
  breaker = null,
  usage = null,
  cls,
  pinned = null,
  body = {},
  personas = null,
  fetchImpl = fetch,
  signal,
  requestId = "-",
  sessionId = null,
}) {
  const chain = pinned ? [{ ...pinned, name: `${pinned.provider}/${pinned.model}` }] : resolveChain(config, cls);
  if (!chain || !chain.length) {
    throw new RouterError(400, `unknown class "${cls}"`, { classes: Object.keys(config?.classes ?? {}) });
  }

  // The class's own system prompt, prepended HERE rather than in the provider adapter:
  // this is the only place that knows which CLASS the request belongs to, and the
  // persona belongs to the class, not to the wire format. It is applied to the request
  // body once, so every attempt in the chain (and the caller's own streaming or buffered
  // preference) carries the same identity. `personas` is loaded at startup by
  // src/persona.mjs and never contains prompt text in any log or response.
  const persona = personaFor(personas, cls);
  const outboundBody = persona ? withNoTools(withSystemPersona(body, persona)) : body;

  const wantStream = Boolean(body.stream);
  const attempts = [];
  const quotaSpent = new Set();
  // What the local server on this machine is serving, asked once and only when a local
  // request has already failed: the answer is what makes "server error (503)" readable.
  let loadedModel = null;

  const wantsTools = Array.isArray(outboundBody?.tools) && outboundBody.tools.length > 0;

  for (const [index, target] of chain.entries()) {
    const spec = config?.providers?.[target.provider];

    const skip = (reason, extra = {}) => {
      attempts.push({ target: target.name, ok: false, reason, skipped: true, ...extra });
      logger?.log("attempt", { requestId, cls, target: target.name, ok: false, reason, skipped: true, ...extra });
    };

    if (!spec) {
      skip("unknown_provider");
      continue;
    }
    const cap = config?.budgets?.monthlyUsd?.[target.provider];
    if (ledger && !ledger.within(target.provider, cap)) {
      skip("over_budget", { capUsd: cap, spentUsd: ledger.spent(target.provider) });
      continue;
    }
    if (spec.apiKeyEnv && keyPool && !keyPool.usable(target.provider, spec)) {
      skip("no_key", { apiKeyEnv: spec.apiKeyEnv });
      continue;
    }
    // A provider whose models share one quota (`"sharedQuota": true`: OpenCode's free
    // DeepSeek and GLM draw on one window per IP) is done for this request once any of its
    // models answered 429; asking the next model would only spend a round trip on the same
    // refusal before the chain reaches a target that can answer.
    if (quotaSpent.has(target.provider)) {
      skip("shared_quota");
      continue;
    }
    // A provider that has been failing outright is skipped without a round trip.
    // This is the fix for the T0.1 gap: without it a dead provider took all 500
    // calls of the acceptance run and every caller paid its latency first.
    const gate = breaker?.check(target.provider);
    if (gate?.open) {
      skip("circuit_open", { retryInMs: gate.retryInMs ?? null, probeInFlight: gate.probeInFlight || undefined });
      continue;
    }

    // A provider that answers in text but never returns a tool call (`"tools": false`,
    // measured on OmniRoute: GLM, Kimi, Qwen, Llama 3.3 and DeepSeek routes all wrote
    // "I'll use write_file ..." with no tool_calls) would turn an agent step into a
    // narration of work that never happens. With a later target to try, it is skipped.
    // As the last one left (a pinned pick, or the end of the chain) it answers as chat:
    // no tools, and a system note that says so, because without the note the agent's
    // own prompt still describes the tools and the model wrote a fake call as text.
    // Per model first, then the provider: OmniRoute's auto routes can land on a
    // text-only bridge, while a model pinned to one of its real API providers can call tools.
    //
    // `"tools": "emulated"` is the third answer: the target drops tools and system messages
    // but its model writes calls as text when told how (src/emulated-tools.mjs), so the
    // request is rewritten as plain turns and the reply parsed back into tool_calls.
    const modelEntry = Array.isArray(spec.models) ? spec.models.find((m) => m?.id === target.model) : null;
    const toolMode = modelEntry?.tools ?? spec.tools;
    const canCallTools = toolMode !== false;
    const emulate = wantsTools && toolMode === "emulated";
    let targetBody = outboundBody;
    // A plain chat on such a target is rewritten too: its system messages (the Rosalena
    // persona) would otherwise be dropped on the way, and the answer would not be hers.
    // A target with a prompt cap (`maxPromptChars`) gets the fitted form: its core tools
    // (`emulatedTools`) on one line each, `shortSystem` in place of a persona too long to
    // fit, and the oldest turns dropped. Too long even then: skipped, not sent to fail.
    if (toolMode === "emulated") {
      targetBody = emulateToolsBody(outboundBody, {
        maxChars: Number(modelEntry?.maxPromptChars ?? spec.maxPromptChars) || 0,
        keepTools: spec.emulatedTools ?? null,
        shortSystem: spec.shortSystem ?? "",
      });
      if (!targetBody) {
        skip("too_long");
        continue;
      }
    } else if (wantsTools && !canCallTools) {
      if (index < chain.length - 1) {
        skip("no_tools");
        continue;
      }
      targetBody = withoutTools(outboundBody);
    }

    let key = spec.apiKeyEnv && keyPool ? keyPool.rotate(target.provider) : null;
    const maxKeyTries = Math.max(1, keyPool ? keyPool.all(target.provider).length : 1);
    let keyTries = 0;
    // `requiresStream` is a provider gate, not a caller preference: OpenCode's
    // free tier refuses a buffered request outright (403), so the router streams
    // upstream and joins the result itself when the caller wanted one answer.
    // An emulated-tools reply must be read whole before its calls can be parsed, so it is
    // fetched buffered and handed to a streaming caller as a stream afterwards.
    const upstreamStream = (wantStream && !emulate) || Boolean(spec.requiresStream);

    for (;;) {
      keyTries += 1;
      const started = Date.now();
      let res = null;
      let failure = null;
      let aliases = null;

      try {
        const built = buildUpstreamRequest({
          spec,
          model: target.model,
          body: targetBody,
          key,
          stream: upstreamStream,
          sessionId,
        });
        aliases = built.aliases ?? null;
        res = await fetchImpl(built.url, { ...built.init, signal });
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        failure = classifyFailure({ status: 0, text: String(err?.message ?? err) });
      }

      if (res && !res.ok) {
        failure = classifyFailure({ status: res.status, headers: res.headers, text: await safeText(res) });
      }

      const ms = Date.now() - started;

      if (failure) {
        // A local server that answers 5xx in milliseconds is almost always the wrong
        // model: the one requested is not the one it has in VRAM. Ask it what it is
        // actually serving, once per request, so the 503 can say so (localModelHint).
        if (res && Number(res.status) >= 500 && isLoopback(spec)) {
          loadedModel = loadedModel ?? (await probeLoadedModel(spec, fetchImpl, signal));
        }
        // Only the local attempt carries what the local server has loaded: on a cloud failure
        // later in the chain the hint read "the local server has qwen loaded, not claude".
        const localNote = loadedModel && isLoopback(spec) ? { loadedModel } : {};
        attempts.push({ target: target.name, ok: false, reason: failure.reason, status: res?.status, ms, key: maskKey(key), ...localNote });
        logger?.log("attempt", {
          requestId,
          cls,
          target: target.name,
          ok: false,
          reason: failure.reason,
          status: res?.status,
          ms,
          key: maskKey(key),
          detail: failure.detail,
        });

        // A malformed request fails identically everywhere; stop and tell the caller.
        if (!failure.retryable) {
          throw new RouterError(res?.status ?? 400, `upstream rejected the request: ${failure.detail || failure.reason}`, {
            attempts,
            target: target.name,
          });
        }

        // Same provider, different key, before giving up on the provider.
        if (failure.keySuspect && key) {
          keyPool.cooldown(key, failure.cooldownMs);
          const next = keyPool.rotate(target.provider);
          if (next && next !== key && keyTries < maxKeyTries) {
            logger?.log("key_rotate", { requestId, cls, target: target.name, from: maskKey(key), to: maskKey(next) });
            key = next;
            continue;
          }
        }
        // The provider is out of options for THIS request: either the failure is
        // provider-suspect (5xx / timeout / network / 402), or it is a key failure
        // with no other key left to try. That is what a provider breaker counts.
        // A rate limit a second key absorbed returned above and never reaches here.
        breaker?.record(target.provider, failure);
        if (failure.reason === "rate_limit" && spec.sharedQuota) quotaSpent.add(target.provider);
        break; // next target in the chain
      }

      // --- success ---
      if (attempts.length > 0) {
        logger?.log("fallback", {
          requestId,
          cls,
          from: attempts[0].target,
          to: target.name,
          reason: attempts[0].reason,
          skipped: attempts.length,
        });
      }

      if (wantStream && !emulate) {
        attempts.push({ target: target.name, ok: true, ms, stream: true });
        logger?.log("attempt", { requestId, cls, target: target.name, ok: true, ms, stream: true });
        // Headers arrived, so the provider is alive as far as the breaker cares. A
        // stream that dies mid-flight is a different problem and is documented as
        // not-fallbackable: retrying it would send the reply twice.
        breaker?.record(target.provider, { ok: true });
        // The response body has not been read yet, so its tokens are not known
        // here. The caller (server.mjs `relayStream`) records the usage line when
        // the stream ends, because that is the earliest moment the number exists.
        return {
          stream: true,
          response: res,
          aliases,
          provider: target.provider,
          model: target.model,
          target: target.name,
          attempts,
        };
      }

      // A provider that only answers a streaming request (OpenCode's free tier)
      // is joined back into one completion here, so the caller keeps its buffered
      // protocol and the provider keeps its gate satisfied.
      let norm;
      if (upstreamStream) {
        try {
          norm = await aggregateStreamToCompletion(res, { model: target.model });
        } catch (err) {
          attempts.push({ target: target.name, ok: false, reason: "bad_stream", ms });
          logger?.log("attempt", { requestId, cls, target: target.name, ok: false, reason: "bad_stream", ms, detail: String(err?.message ?? err) });
          breaker?.record(target.provider, { reason: "bad_stream" });
          continue;
        }
      } else {
        let json;
        try {
          json = await res.json();
        } catch (err) {
          attempts.push({ target: target.name, ok: false, reason: "bad_json", ms });
          logger?.log("attempt", { requestId, cls, target: target.name, ok: false, reason: "bad_json", ms });
          breaker?.record(target.provider, { reason: "bad_json" });
          continue;
        }
        norm = normalizeResponse(spec.kind, json);
      }
      remapToolCalls(norm.toolCalls, aliases);

      if (emulate) {
        const names = outboundBody.tools.map((tool) => tool?.function?.name ?? tool?.name).filter(Boolean);
        const parsed = parseEmulatedToolCalls(norm.text, names);
        if (parsed.toolCalls.length) norm = { ...norm, text: parsed.text, toolCalls: parsed.toolCalls, finishReason: "tool_calls" };
        if (wantStream) {
          // The server relays this like any stream and records its usage from the last
          // frame, so nothing is recorded here (it would be counted twice).
          attempts.push({ target: target.name, ok: true, ms, stream: true, emulatedTools: parsed.toolCalls.length });
          logger?.log("attempt", { requestId, cls, target: target.name, ok: true, ms, stream: true, emulatedTools: parsed.toolCalls.length });
          breaker?.record(target.provider, { ok: true });
          return {
            stream: true,
            response: completionToSse(toOpenAICompletion({ model: target.model, ...norm })),
            aliases: null,
            provider: target.provider,
            model: target.model,
            target: target.name,
            attempts,
          };
        }
      }

      const usd = computeCostUsd(pricesFor(spec, target.model), norm.usage);
      ledger?.record(target.provider, usd, {
        model: target.model,
        tokensIn: norm.usage?.prompt_tokens,
        tokensOut: norm.usage?.completion_tokens,
      });

      // The ONE place a completed call is known, so the one place its tokens are
      // recorded. One line per successful call: a failed attempt consumed no
      // meaningful tokens (the attempts list already carries the failure), and a
      // usage write must never be able to fail a user's answer - hence the guard.
      // Streamed calls are recorded by the server, which owns the relay and is
      // the only place their usage becomes known.
      try {
        usage?.record({
          at: new Date().toISOString(),
          provider: target.provider,
          model: target.model,
          target: target.name,
          ...tokenFields(norm.usage, spec.kind),
          calls: 1,
          usd,
          ok: true,
          ms,
        });
      } catch {
        // Dropping one usage line is survivable; failing the response is not.
      }

      attempts.push({ target: target.name, ok: true, ms, usd });
      logger?.log("attempt", { requestId, cls, target: target.name, ok: true, ms, usd });
      breaker?.record(target.provider, { ok: true });

      return {
        stream: false,
        completion: toOpenAICompletion({ model: target.model, ...norm }),
        provider: target.provider,
        model: target.model,
        target: target.name,
        usd,
        usage: norm.usage,
        attempts,
      };
    }
  }

  logger?.log("chain_exhausted", { requestId, cls, attempts: attempts.map((a) => `${a.target}:${a.reason}`) });
  const hint = localModelHint(attempts) || chainHint(attempts, config);
  throw new RouterError(503, "every target in the chain failed", { attempts, ...(hint ? { hint } : {}) });
}

/**
 * Is this provider served from this machine? The llama-server family speaks /props, and
 * a loopback baseUrl is the only reliable way to tell "the GPU down the hall" from
 * "somebody's API".
 */
function isLoopback(spec) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(String(spec?.baseUrl ?? ""));
}

/**
 * What the local server says it is actually serving (`/props` → `model_alias`), or null.
 *
 * Cheap and bounded on purpose: this only runs after a local request has already failed,
 * and a probe that hangs must not turn one failure into two. 1 s, then give up and let
 * the caller describe the failure without it.
 */
async function probeLoadedModel(spec, fetchImpl, signal) {
  const base = String(spec?.baseUrl ?? "").replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
  if (!base) return null;
  const timeout = AbortSignal.timeout?.(1000) ?? null;
  const merged = timeout && signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : (timeout ?? signal);
  try {
    const res = await fetchImpl(`${base}/props`, { headers: { accept: "application/json" }, ...(merged ? { signal: merged } : {}) });
    if (!res.ok) return null;
    const body = await res.json();
    const alias = typeof body?.model_alias === "string" && body.model_alias.trim() ? body.model_alias.trim() : null;
    const path = typeof body?.model_path === "string" ? body.model_path.trim() : "";
    const fromPath = path ? path.split(/[\\/]/).pop().replace(/\.gguf$/i, "") : "";
    return alias || fromPath || null;
  } catch {
    return null;
  }
}

/** Same model name, allowing for the path-derived alias llama.cpp reports. */
function sameModel(a, b) {
  const norm = (v) => String(v ?? "").toLowerCase().replace(/\.gguf$/, "").replace(/[^a-z0-9]+/g, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * A local server that failed while serving a DIFFERENT model. The person pinned
 * `local/<other>` (often from a client that remembers a model the server no longer has),
 * llama.cpp refused in 89 ms, and the reply said only "server error (503)".
 */
function localModelHint(attempts) {
  for (const a of attempts) {
    if (!a?.loadedModel) continue;
    const asked = String(a.target ?? "").split("/").slice(1).join("/") || String(a.target ?? "");
    if (sameModel(asked, a.loadedModel)) continue;
    return `The local model server has "${a.loadedModel}" loaded, not "${asked}". Pick ${a.loadedModel} in the model picker, or start ${asked} before using it.`;
  }
  return "";
}

/**
 * The provider is over its monthly spend cap. The router skips it before sending, so the
 * caller sees "every target in the chain failed" for a request that was never made, and
 * "retry later" is exactly wrong. The numbers come from the attempt the router recorded.
 */
function budgetHint(attempts) {
  const over = attempts.filter((a) => a.reason === "over_budget");
  if (!over.length) return "";
  const [first] = over;
  const provider = String(first.target ?? "").split("/")[0];
  const cap = Number(first.capUsd);
  const spent = Number(first.spentUsd);
  const money = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "its cap");
  const note = over.length > 1 ? ` ${over.length} providers are over their cap.` : "";
  return `The monthly spend cap for ${provider} is used up (${money(spent)} spent, cap ${money(cap)}), so the request was never sent.${note} Raise it in Settings > Spend limits (it applies at once), or use a free or local model. Retrying will not help until the limit is raised.`;
}

/**
 * One sentence a person can act on, for the case where the chain has no answer.
 *
 * The failure this was written for: a fresh install with no key stored anywhere sent the only
 * target in the class down the `no_key` path, and the caller was told "every target in the
 * chain failed" - true, and useless, because nothing had even been tried and the fix was one
 * environment variable away. A missing key is a configuration answer, not an upstream one, so
 * it gets named, together with the file that fixes it.
 *
 * Empty string when the attempts do not share a single cause: the caller is better served by
 * the per-attempt reasons than by a summary that flattens them.
 */
/**
 * The free window is used up and nothing behind it answered. Said as what it is, because a
 * bare 503 read as "the server broke, retry", and retrying a spent daily quota never helps.
 */
function quotaHint(attempts, config) {
  const spent = attempts.some((a) => {
    const provider = String(a.target ?? "").split("/")[0];
    return config?.providers?.[provider]?.sharedQuota && (a.reason === "rate_limit" || a.reason === "shared_quota");
  });
  if (!spent) return "";
  const omni = attempts.find((a) => String(a.target ?? "").startsWith("omniroute/"));
  const fallback = !omni
    ? ""
    : omni.reason === "network"
      ? " OmniRoute, the free fallback, is not running on this PC: open the OmniRoute tab in Rosalena to install or start it."
      : ` OmniRoute, the free fallback, could not answer either (${omni.reason}).`;
  return `The free tier's daily limit is used up. It is shared by everything on your internet connection and comes back about a day after it started refusing.${fallback} A local model or your own API key works meanwhile.`;
}

/** What a model that cannot run tools is told when it is asked anyway. */
export const NO_TOOLS_NOTE =
  "Tools are not available on this model: you cannot read or write files, run commands or search. Do not write tool calls or describe using a tool. Answer the question directly from what you know. If the task needs a file changed or a command run, show the code or the command for the user to run, and say that a local model in Rosalena can do it for them.";

/**
 * The request as chat: no tools, and the note at the top of the latest user message. Not
 * a system message: OmniRoute's keyless playground bridge drops every system message (and
 * caps the prompt at 6000 characters, so the agent's own prompt cannot travel either);
 * the latest user turn is the one place the note is sure to arrive.
 */
export function withoutTools(body) {
  const { tools: _tools, tool_choice: _choice, ...rest } = body ?? {};
  const messages = Array.isArray(rest.messages) ? rest.messages : [];
  const last = messages.findLastIndex((m) => m?.role === "user");
  if (last === -1) return { ...rest, messages: [{ role: "user", content: NO_TOOLS_NOTE }, ...messages] };
  const user = messages[last];
  const content = typeof user.content === "string"
    ? `${NO_TOOLS_NOTE}\n\n---\n\n${user.content}`
    : [{ type: "text", text: `${NO_TOOLS_NOTE}\n\n---\n\n` }, ...(Array.isArray(user.content) ? user.content : [])];
  return { ...rest, messages: messages.map((m, i) => (i === last ? { ...user, content } : m)) };
}

export function chainHint(attempts = [], config = {}) {
  const quota = quotaHint(attempts, config);
  if (quota) return quota;
  const budget = budgetHint(attempts);
  if (budget) return budget;
  const skipped = attempts.filter((a) => a.skipped);
  const noTools = skipped.filter((a) => a.reason === "no_tools").map((a) => a.target);
  const toolsNote = noTools.length
    ? `${noTools.join(", ")} cannot run tools, so ${noTools.length > 1 ? "they were" : "it was"} skipped for this agent step. Pick a model that can (a local model, or a cloud model with a key), or try again when the free window refills.`
    : "";
  const noKey = skipped.filter((a) => a.reason === "no_key");
  if (!noKey.length) return toolsNote;
  const envs = [...new Set(noKey.map((a) => a.apiKeyEnv).filter(Boolean))];
  const targets = [...new Set(noKey.map((a) => a.target))];
  const file = config?.keyFile ?? "router/data/keys.json";
  if (noKey.length === attempts.length) {
    const which = envs.length ? `${envs.join(" and ")} ${envs.length > 1 ? "are" : "is"} not set` : "no key is configured";
    return `Nothing was tried: ${which}, and ${targets.join(", ")} cannot answer without a key. Set the variable, or paste a key into ${file}.`;
  }
  return `${noKey.length} of ${attempts.length} targets were skipped for a missing key (${envs.join(", ") || "unknown variable"}); the others failed upstream.`;
}
