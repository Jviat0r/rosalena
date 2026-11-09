/**
 * The context meter's server surface and its page.
 *
 * The gauge itself is checked in a browser; what belongs in a test is the contract the
 * gauge depends on:
 *
 *   - `GET /api/context?id=` answers `{window, used, percent, parts:{system,tools,messages}}`
 *   - a live chat has a number while it is still running, not only when it finishes
 *   - a finished chat is answered from the record the run wrote
 *   - a chat with no reading says so instead of inventing one
 *   - a `ui/context` event reaches the stream, and a `compaction` event arrives as its
 *     own kind so the page can draw a fold in the transcript instead of a message
 *   - the page actually carries the meter's markup and the formatter behind it
 *
 * A real `node:http` router answers the chat, and the UI server is pointed at a temp
 * ROSALENA_HOME, so nothing here touches the real machine's stores.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createUiServer } from "../src/ui.mjs";
import { contextTokens } from "../ui/format.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-uictx-"));
const HOME = join(WS, "home");
const RUNS = join(HOME, "runs");
mkdirSync(RUNS, { recursive: true });

const write = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

// ---------------------------------------------------------------- fixtures
//
// Two runs from an earlier process, i.e. the state a reloaded page meets: one written
// by this build (its record carries the meter) and one written before it existed.

const METERED = "r-20261019-120000-meter";
const OLD = "r-20261019-120000-older";
const storedMeter = {
  window: 200_000,
  used: 96_000,
  percent: 48,
  parts: { system: 2_100, tools: 14_400, messages: 79_500 },
  source: "provider",
  threshold: 110_000,
};

write(
  join(RUNS, "index.jsonl"),
  [
    { id: METERED, status: "ok", task: "Summarise the fixture", startedAt: "2026-10-19T16:00:00.000Z", steps: 2, ms: 4321 },
    { id: OLD, status: "ok", task: "An older run", startedAt: "2026-10-19T15:00:00.000Z", steps: 1, ms: 1111 },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n",
);
write(join(RUNS, `${METERED}.jsonl`), JSON.stringify({ type: "run", id: METERED, task: "Summarise the fixture" }) + "\n");
write(join(RUNS, `${METERED}.json`), JSON.stringify({ id: METERED, status: "ok", ok: true, task: "Summarise the fixture", answer: "done", steps: 2, contextMeter: storedMeter }));
write(join(RUNS, `${OLD}.jsonl`), JSON.stringify({ type: "run", id: OLD, task: "An older run" }) + "\n");
write(join(RUNS, `${OLD}.json`), JSON.stringify({ id: OLD, status: "ok", ok: true, task: "An older run", answer: "done", steps: 1, context: null }));

// ---------------------------------------------------------------- the router

const routers = [];
after(() => Promise.all(routers.map((router) => router.close())));

const reply = (content, usage = { prompt_tokens: 4_200, completion_tokens: 8 }) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage,
});

/**
 * A real router that answers after `delayMs`, so the test can look at a chat while it
 * is still running instead of racing a reply that is already over.
 */
async function startRouter({ delayMs = 0 } = {}) {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain the body: the loop sent one and a half-closed socket is a flaky test */
    }
    if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply("pong")));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const router = { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((done) => server.close(done)) };
  routers.push(router);
  return router;
}

const router = await startRouter({ delayMs: 400 });

const TOKEN = "test-token-0123456789abcdef";
const WINDOW = 32_768;
const ui = createUiServer({
  port: 0,
  home: HOME,
  workspace: WS,
  routerUrl: router.url,
  contextWindow: WINDOW,
  token: TOKEN,
});
const state = await ui.ready();
const BASE = `http://127.0.0.1:${state.port}`;
const get = (path) => fetch(BASE + path);
const post = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", "x-rosalena-token": TOKEN }, body: JSON.stringify(body) });

after(() => ui.close());

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Every `data:` frame of a chat's stream, up to and including `ui/end`. */
async function readStream(id) {
  const res = await get(`/api/stream?id=${encodeURIComponent(id)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes('"type":"ui/end"')) break;
  }
  await reader.cancel().catch(() => {});
  return text
    .split("\n\n")
    .map((frame) => frame.replace(/^data: /, "").trim())
    .filter((frame) => frame.startsWith("{"))
    .map((frame) => JSON.parse(frame));
}

// ---------------------------------------------------------------- the endpoint

test("/api/context needs an id, and an unknown id is a 404 rather than zeros", async () => {
  const missing = await get("/api/context");
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /id is required/);

  const unknown = await get("/api/context?id=r-does-not-exist");
  assert.equal(unknown.status, 404);
  assert.match((await unknown.json()).error, /no chat "r-does-not-exist"/);
});

test("a finished chat is answered from its record, in the exact shape the gauge reads", async () => {
  const res = await get(`/api/context?id=${METERED}`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.deepEqual(body.parts, { system: 2_100, tools: 14_400, messages: 79_500 });
  assert.deepEqual(body.parts, storedMeter.parts);
  assert.equal(body.window, storedMeter.window);
  assert.equal(body.used, storedMeter.used);
  assert.equal(body.percent, storedMeter.percent);
  // The three rows are the whole: a gauge whose rows do not add up to its headline
  // teaches the reader to distrust both.
  assert.equal(body.used, body.parts.system + body.parts.tools + body.parts.messages);
  assert.equal(body.percent, Math.round((body.used / body.window) * 100));
  assert.equal(body.source, "provider");
  assert.equal(body.measured, true);
});

test("a run with no stored reading says it has none instead of showing 0%", async () => {
  const res = await get(`/api/context?id=${OLD}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.measured, false);
  assert.equal(body.used, 0);
  assert.equal(body.window, null, "no window is claimed for a chat nothing measured");
  assert.deepEqual(body.parts, { system: 0, tools: 0, messages: 0 });
});

// ---------------------------------------------------------------- a live chat

test("a running chat reports a number before it finishes, and it is the configured window", async () => {
  const started = await post("/api/chat", { task: "Reply with exactly: pong", model: "orchestrate" });
  assert.equal(started.status, 200);
  const { id } = await started.json();

  // Still running: the router takes 400ms and this is asked 80ms in.
  await sleep(80);
  const running = await (await get(`/api/chat?id=${encodeURIComponent(id)}`)).json();
  assert.equal(running.status, "running", "the chat must still be in flight for this test to mean anything");

  const live = await (await get(`/api/context?id=${encodeURIComponent(id)}`)).json();
  assert.equal(live.measured, true);
  assert.equal(live.window, WINDOW, "the window is the server's, because the router advertises none");
  assert.ok(live.used > 0, "an in-flight chat has a projected cost");
  assert.equal(live.used, live.parts.system + live.parts.tools + live.parts.messages);
  assert.equal(live.percent, Math.round((live.used / live.window) * 100));
  assert.ok(["estimate", "provider"].includes(live.source));

  // Then it finishes, and the finished number is the record's, not a leftover.
  const frames = await readStream(id);
  const end = frames.find((frame) => frame.type === "ui/end");
  assert.ok(end, "the stream ends with ui/end");
  assert.equal(end.status, "ok");
  assert.equal(end.answer, "pong");

  const done = await (await get(`/api/context?id=${encodeURIComponent(id)}`)).json();
  assert.equal(done.measured, true);
  assert.equal(done.window, WINDOW);
  assert.ok(done.used >= 0);
  assert.equal(done.used, done.parts.system + done.parts.tools + done.parts.messages);
});

test("the stream carries the meter's readings, as their own event type", async () => {
  const started = await post("/api/chat", { task: "Say pong again", model: "orchestrate" });
  const { id } = await started.json();
  const frames = await readStream(id);

  const readings = frames.filter((frame) => frame.type === "ui/context");
  assert.ok(readings.length >= 2, `expected the start and the end of a turn, got ${readings.length}`);
  // The first reading is before anything was sent, the last one after the answer: a
  // page that opens the chat mid-turn still knows where it stands.
  assert.equal(readings[0].phase, "start");
  assert.equal(readings.at(-1).phase, "final");
  for (const reading of readings) {
    assert.equal(typeof reading.used, "number");
    assert.equal(typeof reading.window, "number");
    assert.equal(typeof reading.parts.system, "number");
    assert.equal(typeof reading.parts.tools, "number");
    assert.equal(typeof reading.parts.messages, "number");
    assert.equal(reading.used, reading.parts.system + reading.parts.tools + reading.parts.messages);
    // The threshold travels with the reading, so the page can colour the gauge without
    // knowing the rule.
    assert.ok(reading.threshold > 0);
  }
  // A plain answer step must not invent a compaction.
  assert.equal(frames.some((frame) => frame.type === "compaction"), false);
});

test("the page carries the gauge, its three rows, and the formatter behind the figures", async () => {
  const html = await (await get("/")).text();
  assert.match(html, /id="context-meter"/);
  assert.match(html, /id="ctx-percent"/);
  assert.match(html, /id="ctx-used"/);
  assert.match(html, /id="ctx-system"/);
  assert.match(html, /id="ctx-tools"/);
  assert.match(html, /id="ctx-messages"/);
  // The three labels are the contract with the screenshot-shaped brief: same words,
  // same order.
  assert.match(html, /System prompt/);
  assert.match(html, /Tool definitions/);
  assert.match(html, /Messages/);
  assert.ok(html.indexOf("System prompt") < html.indexOf("Tool definitions"), "rows are in the documented order");
  assert.ok(html.indexOf("Tool definitions") < html.indexOf("Messages"));

  // `~96K / 200K` is what the gauge shows, and the tilde is part of it.
  assert.equal(contextTokens(96_000), "~96K");
  assert.equal(contextTokens(200_000), "~200K");
  assert.equal(contextTokens(2_100), "~2.1K");
  assert.equal(contextTokens(14_400), "~14.4K");
  assert.equal(contextTokens(1_500_000), "~1.5M");
  assert.equal(contextTokens(0), "~0");
  assert.equal(contextTokens(-5), "~0");
});
