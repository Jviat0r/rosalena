/**
 * The visual UI's server surface.
 *
 * The page itself is checked in a browser; what belongs in a test is the contract the
 * page depends on and the guard that keeps the endpoint private:
 *
 *   - the token reaches the page and a POST without it is refused
 *   - a request from another origin is refused even when the token is right
 *   - the sidebar's two lists come from one call, and a broken source is a note
 *   - an unknown run or session is a 404, not a crash
 *
 * Everything is pointed at a temp ROSALENA_HOME and temp session roots, so the test
 * never reads (or writes) the real machine's stores.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createUiServer, transcriptFromEvents } from "../src/ui.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-ui-"));
const HOME = join(WS, "home");
const RUNS = join(HOME, "runs");
const CLAUDE = join(WS, "claude");

// ---------------------------------------------------------------- fixtures

const write = (path, text) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

mkdirSync(RUNS, { recursive: true });
const RUN_ID = "r-20261019-120000-abcd";
write(
  join(RUNS, "index.jsonl"),
  JSON.stringify({ id: RUN_ID, status: "ok", task: "Reply with exactly: pong", startedAt: "2026-10-19T16:00:00.000Z", steps: 1, ms: 1234 }) + "\n",
);
write(join(RUNS, `${RUN_ID}.jsonl`), JSON.stringify({ type: "run", id: RUN_ID }) + "\n" + JSON.stringify({ type: "run_end", ok: true }) + "\n");
write(
  join(RUNS, `${RUN_ID}.json`),
  JSON.stringify({ id: RUN_ID, status: "ok", ok: true, task: "Reply with exactly: pong", answer: "pong", steps: 1, ms: 1234 }),
);

write(
  join(CLAUDE, "proj", "s-1.jsonl"),
  JSON.stringify({ type: "custom-title", customTitle: "Tessaly build" }) + "\n" + JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix the domain" }] } }) + "\n",
);

process.env.ROSALENA_CLAUDE_DIR = CLAUDE;
process.env.ROSALENA_CODEX_DIR = join(WS, "no-codex");
process.env.ROSALENA_OPENCODE_DB = join(WS, "no-opencode.db");
process.env.ROSALENA_DSH_DIR = join(WS, "no-dsh");

const TOKEN = "test-token-0123456789abcdef";
const ui = createUiServer({
  port: 0, // a test must not collide with the real UI on 8090
  home: HOME,
  workspace: WS,
  routerUrl: "http://127.0.0.1:1/v1", // nothing listens: the health check must degrade
  token: TOKEN,
});
const state = await ui.ready();
const BASE = `http://127.0.0.1:${state.port}`;
const get = (path, headers = {}) => fetch(BASE + path, { headers });
const post = (path, body, headers = {}) => fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

after(() => ui.close());

// ---------------------------------------------------------------- page

test("the page is served with the token substituted into it", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes(TOKEN), "token missing from the page");
  assert.ok(!html.includes("__ROSALENA_TOKEN__"), "placeholder left in the page");
  assert.ok(html.includes("/app.js"));
  // The client is an ES module because it imports the renderer the tests cover.
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test("the three static assets are served with no-store so a reload picks up edits", async () => {
  for (const [path, type] of [
    ["/app.js", /javascript/],
    ["/format.mjs", /javascript/],
    ["/styles.css", /text\/css/],
  ]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), type);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.ok((await res.text()).length > 500, path);
  }
});

test("an unknown path is a 404 that names the route", async () => {
  const res = await get("/nope");
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /no route for GET \/nope/);
});

// ---------------------------------------------------------------- health

test("health degrades to router up=false instead of failing the page", async () => {
  const res = await get("/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.router.up, false);
  assert.deepEqual(body.router.models, []);
  assert.equal(body.home, HOME);
  assert.equal(body.runsDir, RUNS);
  assert.deepEqual(Object.keys(body.sessionCounts).sort(), ["claude", "codex", "dsh", "opencode"]);
  assert.equal(body.sessionCounts.claude, 1);
});

// ---------------------------------------------------------------- sidebar

test("one call fills both sidebar lists, and each empty source becomes a note", async () => {
  const body = await (await get("/api/sessions")).json();
  assert.equal(body.chats.length, 1);
  assert.equal(body.chats[0].id, RUN_ID);
  assert.equal(body.chats[0].status, "ok");
  assert.equal(body.chats[0].title, "Reply with exactly: pong");

  const claude = body.external.find((s) => s.source === "claude");
  assert.equal(claude.title, "Tessaly build");
  assert.equal(claude.kind, "external");
  // codex, opencode and dsh have no store here, so they are notes rather than rows
  assert.deepEqual(body.notes.map((n) => n.source).sort(), ["codex", "dsh", "opencode"]);
});

test("limit is clamped, so a caller cannot ask for the whole history", async () => {
  const body = await (await get("/api/sessions?limit=99999")).json();
  assert.ok(body.chats.length <= 200);
});

test("an external session opens by source and id, and an unknown one is a 404", async () => {
  const ok = await get("/api/session?source=claude&id=s-1");
  assert.equal(ok.status, 200);
  const one = await ok.json();
  assert.equal(one.meta.title, "Tessaly build");
  assert.deepEqual(one.messages.map((m) => m.text), ["fix the domain"]);

  const missing = await get("/api/session?source=claude&id=nope");
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /no claude session "nope"/);
});

// ---------------------------------------------------------------- guard

test("a POST without the token is refused", async () => {
  const res = await post("/api/chat", { task: "hello" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "bad token");
});

test("a POST with the wrong token is refused", async () => {
  const res = await post("/api/chat", { task: "hello" }, { "x-rosalena-token": "nope" });
  assert.equal(res.status, 403);
});

test("a request from another origin is refused even with the right token", async () => {
  const res = await post("/api/chat", { task: "hello" }, { "x-rosalena-token": TOKEN, origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /cross-origin/);

  const site = await post("/api/chat", { task: "hello" }, { "x-rosalena-token": TOKEN, "sec-fetch-site": "cross-site" });
  assert.equal(site.status, 403);
});

test("loopback origins are accepted", async () => {
  const res = await post("/api/chat", {}, { "x-rosalena-token": TOKEN, origin: `http://127.0.0.1:${state.port}` });
  // The origin is fine; the empty task is what gets refused here.
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "task is required");
});

test("opening the page from a link still works, because a navigation is not an API call", async () => {
  // A person clicking a bookmark or a link arrives with `sec-fetch-site: cross-site`;
  // refusing that would make the UI unreachable except by typing the URL.
  const site = await fetch(`http://127.0.0.1:${state.port}/`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(site.status, 200);
  assert.match(site.headers.get("content-type"), /text\/html/);
  const asset = await fetch(`http://127.0.0.1:${state.port}/format.mjs`, {
    headers: { "sec-fetch-site": "cross-site", origin: "https://elsewhere.example" },
  });
  assert.equal(asset.status, 200);
  // The API next to it stays closed to that same caller.
  const health = await fetch(`http://127.0.0.1:${state.port}/api/health`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(health.status, 403);
});

test("a POST with the token and no task is a 400, not a run", async () => {
  const res = await post("/api/chat", { task: "   " }, { "x-rosalena-token": TOKEN });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------- chat

test("a chat started through the API records its outcome in the run store", async () => {
  // A dead port makes the agent RETRY with backoff, which is correct but not
  // deterministic to wait on. A 400 is a non-retryable answer, so this fails once,
  // immediately, and the test is about the record rather than about retry timing.
  const stub = createServer((req, res) => {
    res.writeHead(req.method === "GET" ? 200 : 400, { "content-type": "application/json" });
    res.end(req.method === "GET" ? JSON.stringify({ data: [] }) : JSON.stringify({ error: { message: "stub refuses" } }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;

  const local = createUiServer({ port: 0, home: HOME, workspace: WS, routerUrl: stubUrl, token: TOKEN });
  const { port } = await local.ready();
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rosalena-token": TOKEN },
      body: JSON.stringify({ task: "say pong", model: "fast" }),
    });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    assert.match(id, /^r-\d{8}-\d{6}-[0-9a-f]{4}$/);

    // The id is known before the run ends - that is the whole reason the caller
    // (here, the browser) can subscribe to the stream straight away.
    const listed = await (await fetch(`${base}/api/sessions`)).json();
    assert.ok(listed.chats.some((c) => c.id === id), "a live run must be visible in the list");

    let chat = null;
    for (let i = 0; i < 200; i += 1) {
      chat = await (await fetch(`${base}/api/chat?id=${id}`)).json();
      if (chat.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.notEqual(chat.status, "running", "the run never settled");
    assert.ok(chat.events.length > 0, "no events were recorded");
    assert.equal(chat.historic, false);
  } finally {
    await local.close();
    await new Promise((r) => stub.close(r));
  }
});

test("a historic chat replays its stored events and then ends the stream", async () => {
  const res = await get(`/api/stream?id=${RUN_ID}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text(); // ends because the run is not live
  const lines = text.split("\n").filter((l) => l.startsWith("data: "));
  assert.ok(lines.length >= 2, "expected the replayed events plus a terminal frame");
  const last = JSON.parse(lines.at(-1).slice(6));
  assert.equal(last.type, "ui/end");
  assert.equal(last.status, "ok");
  assert.equal(last.answer, "pong");
});

test("an unknown chat is a 404 for both the JSON and the stream", async () => {
  assert.equal((await get("/api/chat?id=r-nope")).status, 404);
  assert.equal((await get("/api/stream?id=r-nope")).status, 404);
  assert.equal((await get("/api/chat")).status, 400);
});

/**
 * The Stop button is a request, not a kill, and the page is told the reason either way -
 * clicking Stop on a chat that has already finished must read as an answer, not a crash.
 */
test("POST /api/cancel asks a live run to stop and explains any refusal", async () => {
  // No token: refused, like every other POST that changes something.
  assert.equal((await post("/api/cancel", { id: "r-anything" })).status, 403);
  assert.equal((await post("/api/cancel", {}, { "x-rosalena-token": TOKEN })).status, 400);

  const dir = join(HOME, "runs");
  assert.ok(existsSync(dir), "the server's run store is where the test expects it");

  // A live-looking run: a log, no record, written just now.
  const live = "r-20261019-191500-live";
  writeFileSync(join(dir, `${live}.jsonl`), `${JSON.stringify({ type: "run", id: live })}\n`);
  const asked = await post("/api/cancel", { id: live }, { "x-rosalena-token": TOKEN });
  assert.equal(asked.status, 200);
  assert.equal((await asked.json()).ok, true);
  assert.ok(existsSync(join(dir, `${live}.cancel`)), "the flag is what the run reads");

  // A finished run: 409 with the reason in `error`, which is what the page displays.
  const finished = "r-20261019-191501-done";
  writeFileSync(join(dir, `${finished}.jsonl`), `${JSON.stringify({ type: "run", id: finished })}\n`);
  writeFileSync(join(dir, `${finished}.json`), JSON.stringify({ id: finished, status: "ok", ok: true }));
  const refused = await post("/api/cancel", { id: finished }, { "x-rosalena-token": TOKEN });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /already finished/);
});

test("a follow-up to a chat that is only on disk still carries its transcript", async () => {
  // The bug this covers: the UI sends parentId for the open chat, and a chat that was
  // not started in this process has no in-memory messages. The run then began with the
  // bare question, and the page - which still showed the earlier turns - read as if the
  // model had forgotten them.
  const parent = "r-20261019-115959-eeff";
  writeFileSync(
    join(HOME, "runs", `${parent}.jsonl`),
    [
      { type: "run", id: parent, task: "what is the first heading?" },
      // A tool call and a notice are part of the log but must not be replayed as history.
      { type: "tool", step: 1, name: "read_file", ok: true },
      { type: "assistant", step: 1, content: "The Harness (v0)" },
      { type: "run_end", ok: true },
    ]
      .map((event) => `${JSON.stringify(event)}\n`)
      .join(""),
  );
  writeFileSync(join(HOME, "runs", `${parent}.json`), JSON.stringify({ id: parent, status: "ok", ok: true, task: "what is the first heading?", answer: "The Harness (v0)" }));

  const seen = [];
  const stub = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.push(JSON.parse(raw).messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "it routes" }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
          "data: [DONE]\n\n",
      );
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const local = createUiServer({ port: 0, home: HOME, workspace: WS, routerUrl: `http://127.0.0.1:${stub.address().port}`, token: TOKEN });
  const { port } = await local.ready();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rosalena-token": TOKEN },
      body: JSON.stringify({ task: "and the router?", model: "fast", parentId: parent }),
    });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    for (let i = 0; i < 100 && !seen.length; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.ok(seen.length, "the harness never called the router");

    const sent = seen[0];
    assert.equal(sent[0].role, "system", "a rebuilt transcript still gets this run's rules");
    assert.deepEqual(
      sent.slice(1).map((m) => [m.role, m.content]),
      [
        ["user", "what is the first heading?"],
        ["assistant", "The Harness (v0)"],
        ["user", "and the router?"],
      ],
      "the earlier turn comes first and the new question comes last",
    );
    assert.ok(!sent.some((m) => m.role === "tool"), "tool machinery is not replayed as history");

    let chat = null;
    for (let i = 0; i < 100; i += 1) {
      chat = await (await fetch(`http://127.0.0.1:${port}/api/chat?id=${id}`)).json();
      if (chat.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(chat.answer, "it routes");
  } finally {
    await local.close();
    await new Promise((r) => stub.close(r));
  }
});

test("transcriptFromEvents keeps what was asked and answered, and nothing else", () => {
  assert.deepEqual(
    transcriptFromEvents([
      { type: "run", task: "fix the domain" },
      { type: "tool", name: "run_command", ok: true },
      { type: "assistant", content: "done", toolCalls: 1 },
      { type: "assistant", content: "   " },
      { type: "notice", message: "compact skipped" },
      { type: "run_end", ok: true },
    ]),
    [
      { role: "user", content: "fix the domain" },
      { role: "assistant", content: "done" },
    ],
  );
  assert.deepEqual(transcriptFromEvents(null), []);
});

test("a second server gets its own port and token", async () => {
  const other = createUiServer({ port: 0, home: HOME, workspace: WS, routerUrl: "http://127.0.0.1:1/v1" });
  const otherState = await other.ready();
  try {
    assert.notEqual(otherState.port, state.port);
    assert.equal(otherState.token.length, 32);
    assert.notEqual(otherState.token, TOKEN);
  } finally {
    await other.close();
  }
});

// ---------------------------------------------------------------- local context window

test("the window chosen in Settings is the window the local model is planned at", async () => {
  // The packaged build ships a neutral harness.config.json, so the plugin's own
  // planContext (16384, a 32768 aim) used to win over the person's choice: they set
  // 131,072, the host started qwen at 32,768, and the chat was capped there with no
  // explanation (measured 2026-11-07). The host config must carry the choice.
  write(join(HOME, "ui-prefs.json"), JSON.stringify({ contextWindow: 131072 }));
  const body = await (await get("/api/health")).json();
  assert.equal(body.local?.enabled, true, "the bundled local-model-host plugin should be loaded");
  assert.equal(body.local.planContext, 131072, "a load should aim at the window in Settings");

  // Changing it changes the plan, without a restart.
  write(join(HOME, "ui-prefs.json"), JSON.stringify({ contextWindow: 65536 }));
  const again = await (await get("/api/health")).json();
  assert.equal(again.local.planContext, 65536);

  // And the page is told when the loaded server is smaller than the setting, so it can
  // offer "Reload" instead of silently capping the chat.
  assert.ok("context" in again.local, "the served window is reported alongside the plan");
});
