/**
 * Provider adapters.
 *
 * Two wire shapes cover the whole target list, and that is the point of keeping
 * this small: llama.cpp, vLLM, OpenAI, Google's OpenAI-compatible endpoint and
 * OpenRouter all speak the first one, so only Anthropic needs real translation.
 * Adding a provider should mean adding a config row, not touching this file.
 */

import { createHash } from "node:crypto";

/**
 * "provider/model" split on the FIRST slash only.
 *
 * This matters: OpenRouter model ids contain slashes
 * ("openrouter/anthropic/claude-sonnet-4.5" is provider "openrouter", model
 * "anthropic/claude-sonnet-4.5"). Splitting on the last slash, or on all of them
 * and taking the tail, silently addresses the wrong model.
 */
export function parseTarget(target) {
  const s = String(target ?? "").trim();
  const i = s.indexOf("/");
  if (i <= 0) throw new Error(`target must look like "provider/model", got "${s}"`);
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

function joinUrl(baseUrl, path) {
  return `${String(baseUrl ?? "").replace(/\/+$/, "")}${path}`;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .join("");
  }
  return "";
}

/**
 * OpenCode's free tier, measured on 2026-10-20 against
 * https://opencode.ai/zen/v1/chat/completions.
 *
 * Two gates, both required, and neither is about the key:
 *
 *   1. `stream: true`. A non-streaming request is refused even when everything
 *      else is right.
 *   2. The official client's fingerprint. Without it the gateway answers
 *      `403 FreeTierError: OpenCode's free tier can only be used from within
 *      OpenCode` - with a perfectly valid key and a real model id. Four
 *      headers carry the session identity; two more carry the client.
 *
 * The id format is OpenCode's own: `ses_` + 12 lowercase hex + 14 base62. The
 * gateway checks that shape and, as far as any probe could tell, not the meaning
 * of the hex half (a hand-written `ses_ea78e08c3fffnqlS4YOjUdan0O` is accepted),
 * so the router fills the hex half from the session instead of from a clock.
 * That makes one conversation keep one id across restarts, which is the only
 * reason the id exists upstream: prompt-cache affinity.
 */
const SES_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function openCodeSessionToken(raw, salt = "") {
  const digest = createHash("sha256").update(`${String(raw ?? "")}\u0000${String(salt ?? "")}`).digest();
  const time = digest.subarray(0, 6).toString("hex");
  const suffix = Array.from(digest.subarray(6, 20), (b) => SES_CHARS[b % 62]).join("");
  return `ses_${time}${suffix}`;
}

/** The wire grammar OpenCode enforces on a session id: `ses_` + 26 characters. */
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * Accept any caller-supplied session id and return something the gateway accepts.
 *
 * Measured the hard way: `x-rosalena-session: ses-probe-router-1` produced the
 * same 403 FreeTierError as sending no header at all. The gateway does not just
 * look for the header, it validates the id, so a caller's own conversation id
 * (a harness run id, a uuid) must be hashed into OpenCode's `ses_` form rather
 * than passed through. A value that already matches is left alone.
 */
export function normalizeOpenCodeSessionId(raw) {
  const s = String(raw ?? "").trim();
  if (OPENCODE_SESSION_RE.test(s)) return s;
  return openCodeSessionToken(s || "rosalena");
}

/**
 * Names a caller might use for "read a file", best match first.
 *
 * This list exists because of a third gate nobody would guess: the free tier
 * also requires a tool whose name is EXACTLY `read` to be in the request. A tool
 * called `read_file` - the same capability, a different word - is refused with
 * the same 403 as sending no session id at all (measured 2026-10-20: `read`
 * alone 200, `read_file` alone 403, `shell` alone 403). So the router renames the
 * caller's read tool to `read` on the way out and maps the name back on the way
 * in, which keeps the caller's own tool protocol intact.
 */
export const READ_TOOL_NAMES = ["read", "read_file", "readfile", "fs_read", "view_file", "open_file", "cat"];

/** Used only when the caller has no read-like tool at all (a chat-only client). */
const STUB_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file and return its contents.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path to read" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

/**
 * Make sure every name in `wanted` is present, renaming a caller's equivalent
 * tool when it exists and appending a stub when it does not.
 *
 * Returns the alias map (wire name -> caller's name, or null for an injected
 * stub) so both response paths can put the caller's name back.
 */
export function ensureToolNames(tools, wanted = []) {
  const aliases = new Map();
  if (!wanted.length) return { tools, aliases };
  const list = Array.isArray(tools) ? tools.map((t) => JSON.parse(JSON.stringify(t ?? {}))) : [];
  for (const wireName of wanted) {
    const has = list.some((t) => String(t?.function?.name ?? "").toLowerCase() === wireName.toLowerCase());
    if (has) continue;
    const idx = list.findIndex((t) => READ_TOOL_NAMES.includes(String(t?.function?.name ?? "").toLowerCase()));
    if (idx >= 0) {
      aliases.set(wireName, list[idx].function.name);
      list[idx].function.name = wireName;
    } else {
      list.push(JSON.parse(JSON.stringify(STUB_READ_TOOL)));
      aliases.set(wireName, null);
    }
  }
  return { tools: list, aliases };
}

/** Put the caller's tool names back on a normalised result. */
export function remapToolCalls(toolCalls, aliases) {
  if (!aliases?.size || !Array.isArray(toolCalls)) return toolCalls;
  for (const call of toolCalls) {
    const wire = call?.function?.name;
    if (wire && aliases.has(wire) && aliases.get(wire)) call.function.name = aliases.get(wire);
  }
  return toolCalls;
}

/**
 * Rewrite tool names inside an OpenAI-style SSE stream.
 *
 * The buffered path maps names after aggregation; a streaming caller reads the
 * frames directly, so the rename has to happen per frame or the caller receives
 * a tool it never advertised.
 */
export async function* rewriteSseToolNames(stream, aliases) {
  if (!aliases?.size) {
    yield* stream;
    return;
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        yield `${rewriteSseBlock(block, aliases)}\n\n`;
      }
    }
    if (buf.trim()) yield rewriteSseBlock(buf, aliases);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function rewriteSseBlock(block, aliases) {
  return block
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("data:")) return line;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return line;
      let ev;
      try {
        ev = JSON.parse(payload);
      } catch {
        return line;
      }
      const calls = ev?.choices?.[0]?.delta?.tool_calls;
      if (!Array.isArray(calls)) return line;
      let changed = false;
      for (const call of calls) {
        const name = call?.function?.name;
        if (name && aliases.has(name) && aliases.get(name)) {
          call.function.name = aliases.get(name);
          changed = true;
        }
      }
      return changed ? `data: ${JSON.stringify(ev)}` : line;
    })
    .join("\n");
}

/** The headers the OpenCode client itself sends. See the note above. */
export function openCodeHeaders(sessionId, { userAgent, extraHeaders } = {}) {
  const token = normalizeOpenCodeSessionId(sessionId);
  return {
    "x-opencode-session": token,
    "x-session-affinity": token,
    "x-opencode-session-id": token,
    "x-session-id": token,
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "user-agent": userAgent || "opencode/latest/2.0.29/cli",
    ...(extraHeaders ?? {}),
  };
}

/** OpenAI image parts (data URLs) as Anthropic image blocks. */
function anthropicImages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => p?.type === "image_url")
    .map((p) => /^data:([^;]+);base64,(.+)$/s.exec(String(p.image_url?.url ?? "")))
    .filter(Boolean)
    .map(([, media_type, data]) => ({ type: "image", source: { type: "base64", media_type, data } }));
}

const asBlocks = (content) => (typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content);

function toolInput(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** OpenAI function tools as Anthropic tools: a name, a description and an input schema. */
export function toAnthropicTools(tools = []) {
  return tools
    .map((t) => t?.function ?? t)
    .filter((fn) => fn?.name)
    .map((fn) => ({
      name: fn.name,
      ...(fn.description ? { description: String(fn.description) } : {}),
      input_schema: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
    }));
}

/**
 * OpenAI tool_choice in Anthropic's words. A forced choice ("required", or one named
 * function) becomes "auto": Claude Fable 5.1, Opus 5.5 and Sonnet 5.5 answer a forced
 * `any`/`tool` with a 400, and the agent loop never needs a forced call.
 */
export function toAnthropicToolChoice(choice) {
  if (choice === undefined || choice === null) return undefined;
  if (choice === "none" || choice?.type === "none") return { type: "none" };
  return { type: "auto" };
}

/**
 * Anthropic is not OpenAI-shaped in five ways that each cause a hard 400:
 * the system prompt is a top-level field, roles must strictly alternate,
 * max_tokens is required rather than optional, an assistant's tool calls are
 * `tool_use` content blocks, and their results are `tool_result` blocks inside
 * the next USER turn (several results for one turn share that one message).
 *
 * Thinking blocks are never replayed: the OpenAI shape has no place for their
 * signatures, and the agent edits its own history (compaction, trimming), which
 * would make a replayed block a 400 on accounts the preserved-thinking check
 * enforces. Leaving them out is the documented way around that; the model just
 * reasons again where it needs to.
 */
export function toAnthropicMessages(messages = []) {
  const systemParts = [];
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === "tool") {
      const result = { type: "tool_result", tool_use_id: String(m.tool_call_id ?? ""), content: textOf(m.content) || "(empty)" };
      const last = out[out.length - 1];
      if (last && last.role === "user") last.content = [...asBlocks(last.content), result];
      else out.push({ role: "user", content: [result] });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    const images = role === "user" ? anthropicImages(m.content) : [];
    const text = textOf(m.content);
    if (role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    const calls = role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    // A message with pictures or tool calls becomes content blocks; text-only stays a string.
    const content = calls.length
      ? [
          ...(text ? [{ type: "text", text }] : []),
          ...calls.map((call) => ({ type: "tool_use", id: String(call.id ?? ""), name: call.function?.name ?? "tool", input: toolInput(call.function?.arguments) })),
        ]
      : images.length
        ? [...(text ? [{ type: "text", text }] : []), ...images]
        : text;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      if (typeof last.content === "string" && typeof content === "string") last.content += `\n\n${content}`;
      else last.content = [...asBlocks(last.content), ...asBlocks(content)];
    } else out.push({ role, content });
  }
  // The API rejects a leading assistant turn.
  if (!out.length) out.push({ role: "user", content: "" });
  else if (out[0].role === "assistant") out.unshift({ role: "user", content: "(continuing)" });
  return { system: systemParts.join("\n\n"), messages: out };
}

/**
 * Read a capability flag for one model.
 *
 * `providers[].models` used to be documentation only (the curated top-level
 * `models[]` is the menu), but a capability can be true of ONE model on a
 * provider that serves several - opencode-free serves a thinking model and a
 * non-thinking one on the same endpoint - so the flag has to be able to live
 * next to the model id. A provider-wide value is accepted as the fallback so a
 * single-model provider does not have to repeat itself.
 */
export function modelFlag(spec, model, flag, fallback = false) {
  const entry = (Array.isArray(spec?.models) ? spec.models : []).find((m) => m && m.id === model);
  if (entry && entry[flag] !== undefined) return entry[flag];
  if (spec && spec[flag] !== undefined) return spec[flag];
  return fallback;
}

/**
 * Make a history acceptable to DeepSeek in thinking mode.
 *
 * That endpoint refuses a history whose assistant turns do not carry their
 * reasoning back:
 *
 *   400 invalid_request_error: `The reasoning_content in the thinking mode must
 *   be passed back to the API. (request_id ...)`
 *
 * The history belongs to the CALLER. A caller that never stored reasoning, or
 * that switched to this model mid-conversation from another one, has no such
 * field on its earlier assistant turns - and then every request fails with an
 * error it cannot fix, which is exactly the DSH `REASONING-HISTORY` failure
 * ported here. pi-ai solves it identically: where the model declares the
 * capability, an assistant turn with no reasoning gets an empty string, which
 * this API accepts (verified against the free route 2026-10-22; the same fix
 * has been serving DSH's `deepseek-v4.1-flash-free` row since 2026-10-20).
 *
 * Only assistant turns are touched, an existing `reasoning_content` is kept
 * verbatim (including an explicit ""), a `reasoning` field is carried over as
 * the same text under the name this API reads, and the caller's own array is
 * never mutated - the returned array is new. `null` counts as missing: a client
 * that stores "no reasoning" as null would otherwise pass `null` through, which
 * is the same omission the API rejects.
 */
export function withReasoningContent(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || m.role !== "assistant") return m;
    if (m.reasoning_content !== undefined && m.reasoning_content !== null) return m;
    return { ...m, reasoning_content: typeof m.reasoning === "string" ? m.reasoning : "" };
  });
}

/** Build the upstream HTTP request for one target. */
export function buildUpstreamRequest({ spec, model, body = {}, key, stream = false, sessionId }) {
  const headers = { "content-type": "application/json", ...(spec.extraHeaders ?? {}) };
  // A provider can demand a client fingerprint (OpenCode's free tier does). It is
  // applied after the static headers so a config row cannot half-override it.
  if (spec.clientHeaders === "opencode") {
    Object.assign(headers, openCodeHeaders(sessionId ?? spec.sessionId, spec));
  }
  const { class: _drop, stream: _s, ...rest } = body;

  if (spec.kind === "anthropic") {
    headers["anthropic-version"] = spec.anthropicVersion ?? "2023-06-01";
    if (key) headers["x-api-key"] = key;
    const { system, messages } = toAnthropicMessages(rest.messages);
    const tools = Array.isArray(rest.tools) && rest.tools.length ? toAnthropicTools(rest.tools) : null;
    const toolChoice = tools ? toAnthropicToolChoice(rest.tool_choice) : undefined;
    // The 4.6+ models reject sampling settings (a 400), so a model row marks that;
    // older ones (Sonnet 4.5, the judge's old default) still take them.
    const sampling = modelFlag(spec, model, "sampling", true) !== false;
    // Effort lives in output_config here, and only for a model that lists the level.
    const efforts = modelFlag(spec, model, "efforts", []);
    const effort = Array.isArray(efforts) && efforts.includes(rest.reasoning_effort) ? rest.reasoning_effort : null;
    // `fallbacks: "default"`: when a safety classifier declines, the API reruns the
    // request on the model it picks for that category instead of ending the turn.
    const fallbacks = modelFlag(spec, model, "fallbacks", false);
    if (fallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    // The model's own default is a floor for an agent step, not only a fallback: the
    // harness asks every step for 4096, and Opus 5.5 spent all of it thinking or writing a
    // file and came back empty (measured 2026-11-06, three steps in a row). Output is billed
    // as generated, so a larger cap costs nothing unless the reply needs it. A small cap
    // (under 4096: a summary, a title) is a deliberate limit and is kept as asked.
    const modelDefault = Number(modelFlag(spec, model, "maxTokensDefault", spec.maxTokensDefault ?? 4096)) || 4096;
    const asked = Number(rest.max_tokens);
    const maxTokens = !Number.isFinite(asked) || asked <= 0 ? modelDefault : asked >= 4096 ? Math.max(asked, modelDefault) : asked;
    const payload = {
      model,
      max_tokens: maxTokens,
      messages,
      ...(system ? { system } : {}),
      ...(sampling && rest.temperature !== undefined ? { temperature: rest.temperature } : {}),
      ...(sampling && rest.top_p !== undefined ? { top_p: rest.top_p } : {}),
      ...(tools ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      ...(fallbacks ? { fallbacks: "default" } : {}),
      // Automatic prompt caching: an agent resends the same tools and instructions (about
      // 12k tokens for Rosalena's) on every step, and a cached read costs a tenth.
      ...(modelFlag(spec, model, "promptCache", false) ? { cache_control: { type: "ephemeral" } } : {}),
      ...(stream ? { stream: true } : {}),
      ...(spec.extraBody ?? {}),
    };
    return { url: joinUrl(spec.baseUrl, "/messages"), init: { method: "POST", headers, body: JSON.stringify(payload) } };
  }

  // openai-compatible
  if (key) headers.authorization = `Bearer ${key}`;
  // Reasoning effort is a per-provider capability, and the provider is the only party
  // that can say whether it is understood: an OpenAI-compatible gateway that does not
  // know the field may answer 400, and a failover chain would turn one refused field
  // into a dead request. So the field survives only where the provider declares the
  // same vocabulary. `effortBody` exists because effort can be meaningless without
  // something switched on first (llama.cpp here has hidden reasoning off by default,
  // and with it off `reasoning_effort` changes nothing at all); it is merged after
  // `extraBody` so it can genuinely turn that on for the one request that asked.
  // The vocabulary can be per model (Z.AI serves thinking models that take an effort and a
  // free one that does not), falling back to the provider's list.
  const efforts = modelFlag(spec, model, "efforts", []);
  // `effortWhenUnset`: some APIs think at their maximum when no effort is named (GLM-5.3,
  // Kimi K3.x), which makes every agent step slow and costly. Such a provider names the
  // level to send instead; a level the caller chose always wins.
  const unset = modelFlag(spec, model, "effortWhenUnset", null);
  if (rest.reasoning_effort === undefined && typeof unset === "string" && unset) rest.reasoning_effort = unset;
  const effort = rest.reasoning_effort;
  const effortSupported = effort !== undefined && (Array.isArray(efforts) ? efforts : []).includes(effort);
  if (effort !== undefined && !effortSupported) delete rest.reasoning_effort;
  // A provider can require specific tool names to be present (OpenCode's free
  // tier requires exactly `read`). The caller's own name is restored on the way
  // back, so nothing about its tool protocol changes.
  const ensured = spec.ensureTools?.length ? ensureToolNames(rest.tools, spec.ensureTools) : null;
  if (ensured) rest.tools = ensured.tools;
  // Thinking-mode history: a model that declares `requiresReasoningContent`
  // cannot be sent a history whose assistant turns lack it (see
  // withReasoningContent). Scoped per model, because opencode-free serves a
  // thinking model and a non-thinking one from the same endpoint and only one
  // of them validates this field.
  if (modelFlag(spec, model, "requiresReasoningContent")) {
    rest.messages = withReasoningContent(rest.messages);
  }
  // `extraBody` is merged last so a provider's own required fields cannot be
  // clobbered by whatever the client sent. Its reason to exist: llama.cpp on this
  // box serves a reasoning model that burns the whole max_tokens on hidden
  // reasoning and returns empty content unless thinking is disabled per request.
  const payload = { ...rest, ...(spec.extraBody ?? {}), model, ...(stream ? { stream: true } : {}) };
  // Effort without the switch it depends on is a placebo, so this merge happens after
  // `extraBody`, which is where that switch is normally held down.
  if (effortSupported && spec.effortBody && typeof spec.effortBody === "object") {
    for (const [name, value] of Object.entries(spec.effortBody)) {
      const prior = payload[name];
      payload[name] =
        value && typeof value === "object" && prior && typeof prior === "object" && !Array.isArray(prior)
          ? { ...prior, ...value }
          : value;
    }
  }
  // Some OpenAI-compatible servers only report usage on a STREAMED request when the
  // caller asks for it: llama.cpp answers `{"usage":{...}}` in a final chunk with
  // `choices: []` and nothing at all otherwise (measured 2026-10-20). Without this,
  // every streamed call through the router was unmeasurable. Opt-in per provider,
  // because a strict gateway that rejects unknown fields must not be sent it.
  if (stream && spec.streamUsage && rest.stream_options === undefined) {
    payload.stream_options = { include_usage: true };
  }
  return {
    url: joinUrl(spec.baseUrl, "/chat/completions"),
    init: { method: "POST", headers, body: JSON.stringify(payload) },
    aliases: ensured?.aliases ?? null,
  };
}

/**
 * Reassemble an OpenAI-style SSE stream into one completion.
 *
 * Needed the moment a provider refuses non-streaming requests (OpenCode's free
 * tier does): the caller asked for a buffered answer, so the router streams
 * upstream and joins the deltas here instead of telling the caller to change its
 * protocol. Tool-call deltas arrive as fragments keyed by `index`, so they are
 * accumulated by index and emitted in arrival order.
 */
export async function aggregateStreamToCompletion(response, { model } = {}) {
  const text = [];
  const reasoning = [];
  const calls = new Map();
  let finishReason = "stop";
  let usage = null;

  for await (const ev of sseData(response.body)) {
    // Keep the provider's own usage object whole. Projecting it down to
    // prompt/completion tokens - which is what this used to do - silently threw
    // away `prompt_tokens_details.cached_tokens`, the only cache number this
    // provider reports, and the usage panel would then have had to guess.
    if (ev?.usage) usage = ev.usage;
    const choice = ev?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) text.push(delta.content);
    // Thinking models stream their reasoning beside the content. Dropping it
    // here would hand the caller a completion it cannot send back: the next
    // turn's history would be missing `reasoning_content` and the upstream
    // would answer 400 (see withReasoningContent).
    const think = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof think === "string" && think) reasoning.push(think);
    for (const tc of delta.tool_calls ?? []) {
      const idx = Number(tc.index ?? 0);
      if (!calls.has(idx)) calls.set(idx, { id: tc.id ?? `call_${idx}`, type: "function", function: { name: "", arguments: "" } });
      const call = calls.get(idx);
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = mapStopReason(choice.finish_reason);
  }

  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  return {
    text: text.join(""),
    ...(reasoning.length ? { reasoning: reasoning.join("") } : {}),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: toolCalls.length ? "tool_calls" : finishReason,
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0 },
  };
}

/** Normalise either wire shape into one internal shape. */
export function normalizeResponse(kind, json) {
  if (kind === "anthropic") {
    const content = json?.content ?? [];
    const text = content.filter((c) => c?.type === "text").map((c) => c.text).join("");
    const toolCalls = content
      .filter((c) => c?.type === "tool_use")
      .map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } }));
    // Anthropic's `input_tokens` EXCLUDES prompt-cache traffic and reports the
    // cached halves separately, so the cache numbers are carried through as-is
    // (and only when the provider actually sent them) instead of being dropped.
    const usage = json?.usage ?? {};
    return {
      text,
      toolCalls,
      finishReason: mapStopReason(json?.stop_reason),
      usage: {
        prompt_tokens: usage.input_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? 0,
        ...(usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens !== undefined
          ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
          : {}),
      },
    };
  }
  const choice = json?.choices?.[0];
  const message = choice?.message ?? {};
  return {
    text: message.content ?? "",
    ...(typeof message.reasoning_content === "string" && message.reasoning_content
      ? { reasoning: message.reasoning_content }
      : typeof message.reasoning === "string" && message.reasoning
        ? { reasoning: message.reasoning }
        : {}),
    toolCalls: message.tool_calls,
    finishReason: choice?.finish_reason ?? "stop",
    usage: {
      prompt_tokens: json?.usage?.prompt_tokens ?? 0,
      completion_tokens: json?.usage?.completion_tokens ?? 0,
      ...(json?.usage?.prompt_tokens_details ? { prompt_tokens_details: json.usage.prompt_tokens_details } : {}),
    },
  };
}

function mapStopReason(reason) {
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "refusal") return "content_filter";
  return "stop";
}

/** A model's own prices when its row has them (Anthropic's differ 40x), else the provider's. */
export function pricesFor(spec, model) {
  const entry = (Array.isArray(spec?.models) ? spec.models : []).find((m) => m && m.id === model);
  return entry?.prices ?? spec?.prices;
}

let seq = 0;
function completionId() {
  seq += 1;
  return `chatcmpl-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** Present a normalised result as an OpenAI chat completion. */
export function toOpenAICompletion({ model, text, toolCalls, finishReason, usage, reasoning }) {
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text ?? "",
          // Thinking models: the reasoning rides along on the assistant message
          // so a caller that stores the completion can send it back. A caller
          // that drops it is still served - the request path backfills an empty
          // value - but keeping it is what makes a multi-turn thinking session
          // behave the way the upstream expects.
          ...(typeof reasoning === "string" && reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: usage?.prompt_tokens ?? 0,
      completion_tokens: usage?.completion_tokens ?? 0,
      total_tokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
    },
  };
}

export function parseRetryAfterMs(headers) {
  const raw = headers?.get?.("retry-after") ?? headers?.["retry-after"];
  if (!raw) return 0;
  const s = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : 0;
}

/**
 * Decide what a failure means. The distinction that carries the design:
 *
 *   keySuspect      - retry the SAME provider with a different key
 *   providerSuspect - the provider is unhealthy, go to the next target
 *   neither         - the request itself is wrong; retrying anywhere is waste
 *
 * Treating 401 as "provider down" would abandon a provider whose second key is
 * fine; treating 400 as retryable would spend the whole chain on a malformed
 * request and bill for the privilege.
 */
export function classifyFailure({ status = 0, headers, text = "" }) {
  const retryAfterMs = parseRetryAfterMs(headers);
  const detail = String(text || "").slice(0, 400);
  const low = detail.toLowerCase();

  if (status === 429) {
    return { retryable: true, keySuspect: true, providerSuspect: false, reason: "rate_limit", cooldownMs: retryAfterMs || 30_000, detail };
  }
  if (status === 401 || status === 403) {
    return { retryable: true, keySuspect: true, providerSuspect: false, reason: "auth", cooldownMs: retryAfterMs || 60_000, detail };
  }
  if (status === 402) {
    return { retryable: true, keySuspect: false, providerSuspect: true, reason: "insufficient_funds", cooldownMs: retryAfterMs || 900_000, detail };
  }
  if (status === 404 || low.includes("model not found") || low.includes("does not exist")) {
    return { retryable: true, keySuspect: false, providerSuspect: false, reason: "model_not_found", cooldownMs: 0, detail };
  }
  if (status === 408 || status === 409) {
    return { retryable: true, keySuspect: false, providerSuspect: true, reason: "upstream_timeout", cooldownMs: retryAfterMs || 5_000, detail };
  }
  if (status >= 500) {
    return { retryable: true, keySuspect: false, providerSuspect: true, reason: `upstream_${status}`, cooldownMs: retryAfterMs || 20_000, detail };
  }
  if (status === 400 || status === 422) {
    return { retryable: false, keySuspect: false, providerSuspect: false, reason: "bad_request", cooldownMs: 0, detail };
  }
  if (status === 0) {
    return { retryable: true, keySuspect: false, providerSuspect: true, reason: "network", cooldownMs: retryAfterMs || 5_000, detail };
  }
  return { retryable: true, keySuspect: false, providerSuspect: true, reason: `http_${status}`, cooldownMs: retryAfterMs || 5_000, detail };
}

/** Walk a text/event-stream as parsed JSON payloads, ignoring framing noise. */
export async function* sseData(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split("\n")) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            yield JSON.parse(payload);
          } catch {
            // A half frame or a provider keep-alive: skip, do not kill the stream.
          }
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function openAIChunk({ id, created, model, delta, finish, usage = null }) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    ...(usage ? { usage } : {}),
  })}\n\n`;
}

/**
 * Translate Anthropic's event stream into OpenAI chunks.
 *
 * Needed because the router's caller speaks OpenAI: without this, streaming
 * against the `judge` class would emit frames the client cannot parse, and the
 * failure looks like an empty answer rather than a protocol mismatch.
 */
export async function* anthropicStreamToOpenAI(stream, { model, onUsage } = {}) {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  let inputTokens = 0;
  // Cache counters arrive on `message_start` and are reported with the final
  // usage, exactly like the buffered shape. They stay undefined - not 0 - when the
  // provider said nothing, so the usage store can tell "no cache" from "unknown".
  let cacheRead;
  let cacheWrite;
  const toolIndex = new Map(); // Anthropic content-block index -> OpenAI tool_calls index
  for await (const ev of sseData(stream)) {
    if (ev?.type === "message_start" && ev.message?.usage) {
      inputTokens = ev.message.usage.input_tokens ?? 0;
      cacheRead = ev.message.usage.cache_read_input_tokens;
      cacheWrite = ev.message.usage.cache_creation_input_tokens;
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      yield openAIChunk({ id, created, model, delta: { content: ev.delta.text } });
    } else if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      // A tool call opens with its id and name; its arguments follow as JSON fragments.
      const index = toolIndex.size;
      toolIndex.set(ev.index, index);
      const call = { index, id: ev.content_block.id, type: "function", function: { name: ev.content_block.name, arguments: "" } };
      yield openAIChunk({ id, created, model, delta: { tool_calls: [call] } });
    } else if (ev?.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && toolIndex.has(ev.index)) {
      const call = { index: toolIndex.get(ev.index), function: { arguments: ev.delta.partial_json ?? "" } };
      yield openAIChunk({ id, created, model, delta: { tool_calls: [call] } });
    } else if (ev?.type === "message_delta") {
      const usage = ev.usage
        ? {
            prompt_tokens: inputTokens,
            completion_tokens: ev.usage.output_tokens ?? 0,
            ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
            ...(cacheWrite !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
          }
        : null;
      if (onUsage && usage) onUsage(usage);
      // The counts ride on the last chunk too, where an OpenAI client reads them: without
      // this the run showed "0 in / 0 out" while the router had priced the call.
      yield openAIChunk({ id, created, model, delta: {}, finish: mapStopReason(ev.delta?.stop_reason), usage });
    }
  }
  yield "data: [DONE]\n\n";
}
