// Probes the UI server end to end: the page, the API, the token guard, and one
// real chat through /api/chat + /api/stream. Run from the harness package.
const BASE = process.argv[2] ?? "http://127.0.0.1:8090";
const withChat = process.argv.includes("--chat");

const line = (label, value) => console.log(`${label.padEnd(18)} ${value}`);

const page = await fetch(`${BASE}/`);
const html = await page.text();
line("GET /", `${page.status} ${html.length} bytes`);
const token = html.match(/name="rosalena-token" content="([^"]+)"/)?.[1] ?? "";
line("token in page", token ? `${token.slice(0, 8)}… (${token.length} chars)` : "MISSING");
line("placeholder gone", html.includes("__ROSALENA_TOKEN__") ? "NO - still present" : "yes");
line("has app.js", html.includes("/app.js") ? "yes" : "NO");

for (const asset of ["/app.js", "/styles.css"]) {
  const res = await fetch(`${BASE}${asset}`);
  line(`GET ${asset}`, `${res.status} ${res.headers.get("content-type")} ${(await res.text()).length} bytes`);
}

const health = await (await fetch(`${BASE}/api/health`)).json();
line("GET /api/health", `router up=${health.router.up} models=${(health.router.models ?? []).map((m) => m.id).join(",")}`);
line("session counts", JSON.stringify(health.sessionCounts));
line("workspace", health.workspace);

const sessions = await (await fetch(`${BASE}/api/sessions`)).json();
line("GET /api/sessions", `chats=${sessions.chats.length} external=${sessions.external.length} notes=${(sessions.notes ?? []).length}`);
const bySource = {};
for (const s of sessions.external) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
line("external by source", JSON.stringify(bySource));
if (sessions.chats[0]) line("newest chat", `${sessions.chats[0].id} [${sessions.chats[0].status}] ${String(sessions.chats[0].title).slice(0, 50)}`);
if (sessions.external[0]) line("newest external", `${sessions.external[0].source} ${String(sessions.external[0].title).slice(0, 50)}`);

// The guard: no token, then a hostile origin.
const noToken = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ task: "should be refused" }),
});
line("POST no token", `${noToken.status} ${JSON.stringify(await noToken.json())}`);

const crossOrigin = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "http://evil.example", "x-rosalena-token": token },
  body: JSON.stringify({ task: "should be refused" }),
});
line("POST evil origin", `${crossOrigin.status} ${JSON.stringify(await crossOrigin.json())}`);

// An external session read, straight through the API.
if (sessions.external[0]) {
  const one = sessions.external[0];
  const res = await fetch(`${BASE}/api/session?source=${one.source}&id=${encodeURIComponent(one.id)}`);
  const body = await res.json();
  line("GET /api/session", `${res.status} ${body.messages?.length ?? 0} message(s), title "${String(body.meta?.title ?? "").slice(0, 40)}"`);
}

// A finished run replayed from the store.
const finished = sessions.chats.find((c) => c.status !== "running");
if (finished) {
  const res = await fetch(`${BASE}/api/chat?id=${finished.id}`);
  const body = await res.json();
  line("GET /api/chat", `${res.status} status=${body.status} events=${body.events?.length ?? "(none)"}`);
}

if (withChat) {
  console.log("\n--- one real chat ---");
  const started = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rosalena-token": token },
    body: JSON.stringify({ task: "Reply with exactly: harness online", model: "fast" }),
  });
  const created = await started.json();
  line("POST /api/chat", `${started.status} id=${created.id}`);
  if (!created.id) process.exit(1);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240000);
  const stream = await fetch(`${BASE}/api/stream?id=${created.id}`, { signal: controller.signal });
  line("GET /api/stream", `${stream.status} ${stream.headers.get("content-type")}`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let events = 0;
  let answer = "";
  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      const event = JSON.parse(data);
      events += 1;
      if (["delta", "assistant", "tool", "error", "stopped"].includes(event.type)) {
        console.log(`  ${event.type} ${event.type === "delta" ? JSON.stringify(String(event.text).slice(0, 60)) : JSON.stringify(event).slice(0, 160)}`);
      }
      if (event.type === "delta") answer += event.text ?? "";
      if (event.type === "assistant" && event.content) answer = event.content;
      if (event.type === "ui/end") {
        line("ui/end", `${event.status}${event.error ? ` error=${event.error}` : ""}`);
        break outer;
      }
    }
  }
  clearTimeout(timer);
  line("events", String(events));
  line("answer", JSON.stringify(answer.slice(0, 200)));
}
