/**
 * Streaming transport tests.
 *
 * A streamed completion is not "a JSON reply, but slower": tool calls arrive as
 * FRAGMENTS that only parse once joined, and two calls can interleave. These tests
 * are written so that the naive implementation fails - if the accumulator ever
 * treats `delta.tool_calls[0]` as "the first call", the interleaved test below
 * produces two broken tool calls and fails loudly.
 *
 * The wire is faked with `Response` objects built from real SSE text, so the code
 * under test reads actual frames rather than a stubbed object.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import { StreamError, createAccumulator, framesFromText, iterateSse, readStreamedCompletion } from "../src/stream.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-stream-"));
writeFileSync(join(WS, "hello.txt"), "line one\nline two\nline three\n", "utf8");

const enc = new TextEncoder();

const frame = (payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
const chunk = (deltaBody, finishReason = null) => frame({ choices: [{ index: 0, delta: deltaBody, finish_reason: finishReason }] });

/** Frames of a plain prose answer. */
const sayFrames = (text) => [
  chunk({ role: "assistant", content: text.slice(0, 4) }),
  chunk({ content: text.slice(4) }),
  chunk({}, "stop"),
  frame("[DONE]"),
];

/** Frames of one tool call whose arguments arrive in pieces, as providers send them. */
const toolFrames = (name, args, id = "call_1") => {
  const json = JSON.stringify(args);
  return [
    chunk({ role: "assistant", content: "" }),
    chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: json.slice(0, 3) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(3, 9) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: json.slice(9) } }] }),
    chunk({}, "tool_calls"),
    frame("[DONE]"),
  ];
};

/**
 * An SSE response. `breakAfter` errors the body before that frame is written, which
 * is how a mid-stream provider death actually looks to the reader.
 */
function sseResponse(chunks, { headers = {}, breakAfter = null, close = true } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < chunks.length; i += 1) {
        if (breakAfter === i) {
          controller.error(new Error("socket closed"));
          return;
        }
        controller.enqueue(enc.encode(chunks[i]));
      }
      if (close) controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-router-target": "local/qwen-test", ...headers },
  });
}

/** Replies in order, repeating the last entry when the script runs out. */
function scriptedStream(replies) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const entry = replies[Math.min(calls.length - 1, replies.length - 1)];
    return typeof entry === "function" ? entry(body, calls) : entry;
  };
  fn.calls = calls;
  return fn;
}

/** Advice for a step, in the shape a plugin returns. */
const retrier = (advice) => ({ plugin: "retrier", name: "beforeStep", fn: () => advice });

const readAll = async (res, options) => {
  const seen = [];
  const out = await readStreamedCompletion(res, { onDelta: (d) => seen.push(d), ...options });
  return { out, seen };
};

test("SSE framing survives CRLF, keep-alives, comments, event lines and a missing final terminator", async () => {
  const text =
    ": keep-alive\r\n\r\n" +
    'data: {"a":1}\r\n\r\n' +
    "event: ping\n\n" +
    'data:{"b":2}\n\n' +
    'data: {"x":\ndata: 3}\n\n' +
    "data: [DONE]\n\n" +
    'data: {"c":4}';

  const got = [];
  for await (const payload of iterateSse(new Response(text).body)) got.push(payload);

  assert.deepEqual(got[0], { a: 1 });
  assert.deepEqual(got[1], { b: 2 });
  assert.deepEqual(got[2], { x: 3 }, "a multi-line data frame joins with a newline");
  assert.equal(typeof got[3], "symbol", "[DONE] is a sentinel, not JSON");
  assert.deepEqual(got[4], { c: 4 }, "a last frame with no blank line still counts");
  assert.equal(got.length, 5);
});

test("a frame of garbage is counted, not fatal", async () => {
  const acc = createAccumulator();
  const payloads = framesFromText(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: {not json\n\n", "data: [DONE]\n\n"].join(""));
  for (const p of payloads) acc.absorb(p);
  const out = acc.result();
  assert.equal(out.message.content, "hi");
  assert.equal(out.badFrames, 1);
  assert.equal(out.complete, true);
});

test("tool-call fragments interleaved across two calls each reassemble into valid JSON", async () => {
  // The trap: frame 3 carries call 1 first and call 0 second, so "take index 0 of
  // each frame" mixes the two calls together.
  const first = JSON.stringify({ path: "hello.txt" });
  const second = JSON.stringify({ task: "look at the file" });
  const frames = [
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: first.slice(0, 4) } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "delegate", arguments: second.slice(0, 5) } }] }),
    chunk({
      tool_calls: [
        { index: 1, function: { arguments: second.slice(5, 11) } },
        { index: 0, function: { arguments: first.slice(4) } },
      ],
    }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: second.slice(11) } }] }),
    chunk({}, "tool_calls"),
    frame("[DONE]"),
  ];

  const { out } = await readAll(sseResponse(frames));
  const calls = out.message.tool_calls;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, "call_a");
  assert.equal(calls[0].function.name, "read_file");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: "hello.txt" });
  assert.equal(calls[1].id, "call_b");
  assert.equal(calls[1].function.name, "delegate");
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { task: "look at the file" });
});

test("an id and a name are kept from the first fragment that carried them", async () => {
  const frames = [
    chunk({ tool_calls: [{ index: 0, id: "call_x", function: { name: "list", arguments: "{}" } }] }),
    // A provider that repeats the id on every frame must not accumulate it.
    chunk({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { arguments: "" } }] }),
    chunk({}, "tool_calls"),
    frame("[DONE]"),
  ];
  const { out } = await readAll(sseResponse(frames));
  assert.equal(out.message.tool_calls.length, 1);
  assert.equal(out.message.tool_calls[0].id, "call_x");
  assert.equal(out.message.tool_calls[0].function.name, "list");
  assert.equal(out.message.tool_calls[0].function.arguments, "{}");
});

test("a fragment without an index continues the previous call", async () => {
  const frames = [
    chunk({ tool_calls: [{ index: 0, id: "c", function: { name: "read_file", arguments: '{"path":' } }] }),
    chunk({ tool_calls: [{ function: { arguments: '"hello.txt"}' } }] }),
    chunk({}, "tool_calls"),
    frame("[DONE]"),
  ];
  const { out } = await readAll(sseResponse(frames));
  assert.deepEqual(JSON.parse(out.message.tool_calls[0].function.arguments), { path: "hello.txt" });
});

test("reasoning_content is captured but never becomes the answer", async () => {
  const frames = [
    chunk({ role: "assistant", reasoning_content: "let me think " }),
    chunk({ reasoning_content: "about it" }),
    chunk({ content: "42" }),
    chunk({}, "stop"),
    frame("[DONE]"),
  ];
  const { out } = await readAll(sseResponse(frames));
  assert.equal(out.message.content, "42");
  assert.equal(out.reasoning, "let me think about it");
  assert.equal(out.message.reasoning_content, "let me think about it");
  // Rides on the message as its own field because a thinking-mode provider refuses a
  // follow-up turn that does not hand the previous turn's reasoning back (DeepSeek,
  // measured 2026-10-20). The point of the test stands: it is never the answer.
});

test("prose reaches onDelta in the order it arrived", async () => {
  const { seen } = await readAll(sseResponse(sayFrames("streamed answer")));
  assert.equal(seen.map((d) => d.text).join(""), "streamed answer");
  assert.deepEqual(seen.map((d) => d.chars), [4, 15]);
});

test("a provider that ignores stream:true is read as a normal reply, not an error", async () => {
  const res = new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content: "buffered anyway" }, finish_reason: "stop" }], usage: { total_tokens: 7 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  const { out } = await readAll(res);
  assert.equal(out.streamed, false);
  assert.equal(out.message.content, "buffered anyway");
  assert.deepEqual(out.usage, { total_tokens: 7 });
});

test("SSE text with no event-stream header is still parsed instead of thrown away", async () => {
  const res = new Response(sayFrames("sniffed").join(""), { status: 200, headers: { "content-type": "application/json" } });
  const { out } = await readAll(res);
  assert.equal(out.streamed, true);
  assert.equal(out.sniffed, true);
  assert.equal(out.message.content, "sniffed");
});

test("a stream that ends without finish_reason or [DONE] is a truncation error carrying what arrived", async () => {
  const res = sseResponse([chunk({ role: "assistant", content: "half an ans" })]);
  await assert.rejects(readStreamedCompletion(res), (err) => {
    assert.ok(err instanceof StreamError);
    assert.equal(err.code, "stream_truncated");
    assert.match(err.message, /without finishing/);
    assert.equal(err.partial.message.content, "half an ans", "the partial text is kept for the log");
    return true;
  });
});

test("a body that dies mid-read becomes a truncation error, not a crash", async () => {
  const res = sseResponse(sayFrames("never finished"), { breakAfter: 1 });
  await assert.rejects(readStreamedCompletion(res), (err) => {
    assert.equal(err.code, "stream_truncated");
    assert.match(err.message, /broke mid-read/);
    return true;
  });
});

test("an error frame in the middle of a stream is reported as such", async () => {
  const res = sseResponse([chunk({ content: "starting" }), frame({ error: { message: "upstream model crashed" } })]);
  await assert.rejects(readStreamedCompletion(res), (err) => {
    assert.equal(err.code, "stream_error_frame");
    assert.match(err.message, /upstream model crashed/);
    return true;
  });
});

test("a response that is neither JSON nor SSE fails loudly", async () => {
  const res = new Response("<html>hello</html>", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(readStreamedCompletion(res), (err) => {
    assert.equal(err.code, "stream_unreadable");
    return true;
  });
});

test("the loop streams by default and still executes the reassembled tool call", async () => {
  const events = [];
  const f = scriptedStream([sseResponse(toolFrames("read_file", { path: "hello.txt" })), sseResponse(sayFrames("read it"))]);
  const result = await runAgent({ root: WS, task: "read hello.txt", fetchImpl: f, onEvent: (e) => events.push(e) });

  assert.equal(result.answer, "read it");
  assert.equal(result.steps, 2);
  assert.equal(f.calls[0].body.stream, true, "the loop asks for a stream");
  assert.equal(f.calls[0].body.model, "orchestrate");
  const tool = events.find((e) => e.type === "tool");
  assert.equal(tool.name, "read_file");
  assert.equal(tool.ok, true, "the split arguments parsed into the real tool call");
  assert.match(tool.preview, /line one/);
  const back = f.calls[1].body.messages.find((m) => m.role === "tool");
  assert.equal(back.tool_call_id, "call_1");
  assert.match(back.content, /line three/);
});

test("the loop reports deltas, the first-token time and the transport it used", async () => {
  const events = [];
  const f = scriptedStream([sseResponse(sayFrames("all done here"))]);
  const result = await runAgent({ root: WS, task: "say hi", fetchImpl: f, onEvent: (e) => events.push(e) });

  assert.equal(result.answer, "all done here");
  const deltas = events.filter((e) => e.type === "delta");
  assert.equal(deltas.map((d) => d.text).join(""), "all done here");
  const assistant = events.find((e) => e.type === "assistant");
  assert.equal(assistant.streamed, true);
  assert.equal(typeof assistant.ttftMs, "number");
  assert.equal(assistant.target, "local/qwen-test");
});

test("a truncated step spends one spare attempt and the next stream completes the run", async () => {
  const events = [];
  const f = scriptedStream([
    // Dies after a partial answer: no finish_reason, no [DONE].
    sseResponse([chunk({ role: "assistant", content: "I was saying" })]),
    sseResponse(sayFrames("recovered")),
  ]);
  const result = await runAgent({
    root: WS,
    task: "x",
    fetchImpl: f,
    extraHooks: [retrier({ retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })],
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.answer, "recovered", "the run did not fail on the truncated stream");
  assert.equal(f.calls.length, 2);
  assert.ok(events.some((e) => e.type === "retry" && e.reason === "stream_truncated"), "the retry says why");
  assert.ok(events.some((e) => e.type === "retry_ok" && e.attempt === 2));
});

test("a non-stream failure does not get the streaming spare attempt", async () => {
  let n = 0;
  const f = async () => {
    n += 1;
    return new Response("no target answered", { status: 503 });
  };
  const result = await runAgent({
    root: WS,
    task: "x",
    fetchImpl: f,
    extraHooks: [retrier({ retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 } })],
  });
  assert.equal(n, 1, "the spare belongs to truncated streams only");
  assert.equal(result.stopped, "router_error");
});

test("stream:false takes the buffered path and asks the router for no stream", async () => {
  const events = [];
  const bodies = [];
  const f = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "buffered" }, finish_reason: "stop" }] }), {
      status: 200,
      headers: { "content-type": "application/json", "x-router-target": "local/qwen-test" },
    });
  };
  const result = await runAgent({ root: WS, task: "x", fetchImpl: f, stream: false, onEvent: (e) => events.push(e) });
  assert.equal(result.answer, "buffered");
  assert.equal(bodies[0].stream, undefined, "the buffered path does not ask for a stream");
  assert.equal(events.some((e) => e.type === "delta"), false);
  assert.equal(events.find((e) => e.type === "assistant").streamed, false);
});

test("a tool call with empty arguments runs as a no-argument call", async () => {
  const events = [];
  const ping = { name: "ping", description: "Answer pong. Takes no arguments.", parameters: { type: "object", properties: {} }, async run() { return "pong"; } };
  const emptyArgs = [
    chunk({ tool_calls: [{ index: 0, id: "call_z", type: "function", function: { name: "ping", arguments: "" } }] }),
    chunk({}, "tool_calls"),
    frame("[DONE]"),
  ];
  const f = scriptedStream([sseResponse(emptyArgs), sseResponse(sayFrames("ponged"))]);
  const result = await runAgent({ root: WS, task: "ping", fetchImpl: f, extraTools: [ping], onEvent: (e) => events.push(e) });

  assert.equal(result.answer, "ponged");
  const tool = events.find((e) => e.type === "tool");
  assert.equal(tool.name, "ping");
  assert.equal(tool.ok, true, "an empty arguments string must not be a parse error");
  assert.equal(tool.preview, "pong");
});

test("curl-style chunk boundaries do not matter: split frames reassemble", async () => {
  // The same answer, cut at every awkward place: inside a frame, inside JSON, and
  // between the two newlines that end it.
  const text = sayFrames("boundaries").join("");
  const cuts = [7, 19, 40, 41, 55];
  const parts = [];
  let at = 0;
  for (const cut of cuts) {
    parts.push(text.slice(at, cut));
    at = cut;
  }
  parts.push(text.slice(at));

  const body = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(enc.encode(part));
      controller.close();
    },
  });
  const out = await readStreamedCompletion(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(out.message.content, "boundaries");
});
