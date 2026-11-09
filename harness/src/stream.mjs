/**
 * SSE reading, and the assembly of a streamed completion back into one message.
 *
 * The router already relays `stream: true` upstream traffic as OpenAI frames
 * (src/server.mjs `relayStream`, translating Anthropic's event stream on the way
 * through). This module is the other half: it turns those frames into the same
 * `{choices:[{message}]}` shape a buffered call returns, so the agent loop can
 * stream without knowing anything about framing.
 *
 * The part that is easy to get wrong is tool calls. An OpenAI-compatible stream
 * does not send a tool call, it sends FRAGMENTS of one: `index` says which call a
 * fragment belongs to, `id` and `function.name` normally arrive once at the start,
 * and `function.arguments` arrives as a series of string pieces that only parse as
 * JSON once all of them are joined. Two calls can interleave in the same stream,
 * so `delta.tool_calls[0]` does NOT mean "the first call" - it means "the first
 * fragment in this frame". Everything here keys on `index` for that reason.
 *
 * Truncation is a FAILURE here, not a short answer. Tool calls are only executed
 * once a step's stream is complete, so a stream that dies mid-flight has caused no
 * side effects and can honestly be retried. That is the opposite of the router's
 * situation - it may already have forwarded bytes to us, so it can only surface a
 * truncated stream - which is why the retry belongs to the loop, not the router.
 */

const FRAME_BREAK = /\r?\n\r?\n/;
const DONE = Symbol("sse-done");
const BAD = Symbol("sse-bad-frame");

export class StreamError extends Error {
  constructor(message, { code = "stream_error", partial = null } = {}) {
    super(message);
    this.name = "StreamError";
    this.code = code;
    // What did arrive, when we have it: a truncated step should be debuggable
    // without re-running it.
    this.partial = partial;
  }
}

/**
 * One SSE frame -> a payload, `DONE`, `BAD`, or undefined for nothing usable.
 *
 * Frames are `field: value` lines; only `data` carries content we use. A line
 * starting with ":" is a keep-alive comment, which servers send precisely so a
 * long silence does not look like a dead connection. Multiple `data` lines in one
 * frame join with newlines (the spec's rule for multi-line JSON).
 */
function parseFrame(raw) {
  const parts = [];
  for (const line of String(raw).split(/\r?\n/)) {
    // The one comment that means something: the router's price for this call, sent
    // after the last data frame (router/src/server.mjs relayStream).
    if (line.startsWith(": x-router-cost ")) {
      try {
        return { routerCost: JSON.parse(line.slice(": x-router-cost ".length)) };
      } catch {
        continue;
      }
    }
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== "data") continue; // event:/id:/retry: carry nothing we use
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    parts.push(value);
  }
  if (!parts.length) return undefined;
  const text = parts.join("\n");
  if (text === "[DONE]") return DONE;
  try {
    return JSON.parse(text);
  } catch {
    // One unparseable frame must not kill the stream: the router takes the same
    // position on upstream noise. It is counted instead, so a stream that was
    // nothing but garbage cannot masquerade as a valid empty answer.
    return BAD;
  }
}

/** Split already-buffered text into frames. Used by the non-SSE sniff path. */
export function framesFromText(text) {
  const payloads = [];
  let rest = String(text ?? "");
  for (;;) {
    const brk = FRAME_BREAK.exec(rest);
    if (!brk) break;
    const payload = parseFrame(rest.slice(0, brk.index));
    if (payload !== undefined) payloads.push(payload);
    rest = rest.slice(brk.index + brk[0].length);
  }
  // Whatever is left is a final frame that never got its blank-line terminator:
  // servers that close immediately after the last `data:` line still send a
  // complete frame.
  const tail = parseFrame(rest);
  if (tail !== undefined) payloads.push(tail);
  return payloads;
}

/** Walk an SSE body, yielding one parsed payload per frame. */
export async function* iterateSse(body) {
  if (!body?.getReader) throw new StreamError("the streamed response has no readable body", { code: "stream_no_body" });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const brk = FRAME_BREAK.exec(buf);
        if (!brk) break;
        const payload = parseFrame(buf.slice(0, brk.index));
        buf = buf.slice(brk.index + brk[0].length);
        if (payload !== undefined) yield payload;
      }
    }
    buf += decoder.decode();
    const tail = parseFrame(buf);
    if (tail !== undefined) yield tail;
  } catch (err) {
    if (err instanceof StreamError) throw err;
    throw new StreamError(`the stream broke mid-read: ${err?.message ?? err}`, { code: "stream_truncated" });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or cancelled: nothing to do, and nothing to report.
    }
  }
}

/**
 * Fold frames into one assistant message.
 *
 * `onDelta` sees prose as it arrives (that is what makes a slow local model look
 * alive) and each batch of tool-call fragments (so a CLI can show which tool the
 * model is starting to call). It never sees a frame's raw JSON.
 */
export function createAccumulator({ onDelta } = {}) {
  const state = {
    content: "",
    reasoning: "",
    role: null,
    finishReason: null,
    usage: null,
    costUsd: null,
    calls: new Map(),
    order: [],
    frames: 0,
    badFrames: 0,
    deltas: 0,
    done: false,
  };

  const absorb = (payload) => {
    if (payload === DONE) {
      state.done = true;
      return;
    }
    if (payload === BAD) {
      state.badFrames += 1;
      return;
    }
    if (payload?.routerCost) {
      state.costUsd = Number(payload.routerCost.usd) || 0;
      return;
    }
    state.frames += 1;
    if (payload?.error) {
      const detail = payload.error?.message ?? JSON.stringify(payload.error);
      throw new StreamError(`the provider reported an error mid-stream: ${String(detail).slice(0, 200)}`, {
        code: "stream_error_frame",
        partial: state.content,
      });
    }
    if (payload?.usage) state.usage = payload.usage;
    const choice = payload?.choices?.[0];
    if (!choice) return;

    const delta = choice.delta ?? {};
    if (delta.role) state.role = delta.role;

    let text = "";
    if (typeof delta.content === "string" && delta.content) {
      text = delta.content;
      state.content += text;
    }
    // A reasoning model streams its thinking here. Keep it: it is the difference
    // between "the model is quiet" and "the model is spending the whole budget on
    // hidden reasoning", which is a failure mode this box has hit before.
    if (typeof delta.reasoning_content === "string") state.reasoning += delta.reasoning_content;

    const fragments = [];
    if (Array.isArray(delta.tool_calls)) {
      for (const frag of delta.tool_calls) {
        // Providers that omit `index` send one call's fragments in order, so the
        // previous slot is the right continuation.
        const index = Number.isInteger(frag?.index) ? frag.index : (state.order.length ? state.order[state.order.length - 1] : 0);
        let slot = state.calls.get(index);
        if (!slot) {
          slot = { index, id: "", type: "function", name: "", args: "" };
          state.calls.set(index, slot);
          state.order.push(index);
        }
        if (frag?.id) slot.id ||= frag.id;
        if (frag?.type) slot.type = frag.type;
        const fn = frag?.function ?? {};
        // Name and arguments both append: either can be split across frames, and a
        // provider that repeats a complete name is not something we have to trust.
        if (fn.name) slot.name += fn.name;
        if (typeof fn.arguments === "string" && fn.arguments) slot.args += fn.arguments;
        fragments.push({ index, name: fn.name ?? "", args: fn.arguments ?? "" });
      }
    }

    if (choice.finish_reason) state.finishReason = choice.finish_reason;
    if (text || fragments.length) {
      state.deltas += 1;
      if (onDelta) onDelta({ text, fragments, chars: state.content.length, reasoningChars: state.reasoning.length });
    }
  };

  const result = () => {
    const toolCalls = state.order.map((index) => {
      const slot = state.calls.get(index);
      return {
        id: slot.id || `call_${index}`,
        type: slot.type || "function",
        // An empty arguments string is left empty: the tool layer already reads
        // that as "no arguments", and inventing "{}" would hide a provider that
        // sent nothing at all.
        function: { name: slot.name, arguments: slot.args },
      };
    });
    return {
      message: {
        role: "assistant",
        content: state.content,
        // The thinking text is part of the message, not a side note: DeepSeek's thinking
        // mode refuses a follow-up turn that does not hand the previous turn's reasoning
        // back (measured 2026-10-20: HTTP 400 "The `reasoning_content` in the thinking
        // mode must be passed back to the API"). Carried here so the caller can keep it,
        // and omitted entirely when the provider sent none.
        ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      reasoning: state.reasoning,
      finishReason: state.finishReason,
      usage: state.usage,
      costUsd: state.costUsd,
      frames: state.frames,
      badFrames: state.badFrames,
      deltas: state.deltas,
      // Either terminator counts as finished: they disagree on which one is
      // mandatory, and a stream that sent finish_reason still has an answer.
      complete: state.done || Boolean(state.finishReason),
    };
  };

  return { absorb, result };
}

/** The router's price for a buffered call (`x-router-cost-usd`), or null from anything else. */
export function costHeader(res) {
  const raw = res?.headers?.get?.("x-router-cost-usd");
  if (raw === null || raw === undefined || raw === "") return null;
  const usd = Number(raw);
  return Number.isFinite(usd) ? usd : null;
}

/** A finished accumulator view in the shape a caller gets back. */
function shape(out, { streamed, sniffed = false }) {
  if (!out.complete) {
    throw new StreamError(
      `the stream ended without finishing (${out.deltas} delta frame(s), ${out.message.content.length} char(s) arrived)`,
      { code: "stream_truncated", partial: out },
    );
  }
  return {
    message: out.message,
    reasoning: out.reasoning,
    finishReason: out.finishReason,
    usage: out.usage,
    costUsd: out.costUsd ?? null,
    frames: out.frames,
    badFrames: out.badFrames,
    streamed,
    sniffed,
  };
}

/**
 * Read a router reply that was asked to stream.
 *
 * Returns `{message, reasoning, finishReason, usage, frames, badFrames, streamed}`,
 * where `streamed: false` means the reply arrived as ordinary JSON because
 * something in the chain ignored `stream: true`. That case is not an error: the
 * caller asked for a lower-latency transport, not for a different answer, and
 * failing a step over it would punish the user for a provider's quirk.
 */
export async function readStreamedCompletion(res, { onDelta } = {}) {
  const contentType = String(res?.headers?.get?.("content-type") ?? "");
  if (contentType.includes("text/event-stream")) {
    // Absorb as the frames arrive, not after: a stream that breaks half way
    // through keeps whatever it did deliver, so the failure can be reported with
    // how far it got.
    const acc = createAccumulator({ onDelta });
    try {
      for await (const payload of iterateSse(res.body)) acc.absorb(payload);
    } catch (err) {
      if (err instanceof StreamError && !err.partial) err.partial = acc.result();
      throw err;
    }
    return shape(acc.result(), { streamed: true });
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (json === null) {
    // Labelled as JSON but not JSON, yet it may still be SSE from something that
    // does not set the header. Parse the frames we already have rather than
    // throwing away a perfectly good answer.
    const acc = createAccumulator({ onDelta });
    const payloads = framesFromText(text);
    for (const payload of payloads) acc.absorb(payload);
    if (!payloads.length) {
      throw new StreamError(`the response was neither JSON nor SSE: ${text.slice(0, 120)}`, { code: "stream_unreadable" });
    }
    return shape(acc.result(), { streamed: true, sniffed: true });
  }
  const choice = json?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    message,
    reasoning: message.reasoning_content ?? "",
    finishReason: choice.finish_reason ?? null,
    usage: json?.usage ?? null,
    costUsd: costHeader(res),
    frames: 0,
    badFrames: 0,
    streamed: false,
  };
}
