const base = "http://127.0.0.1:8077";
for (const p of ["/v1/models", "/health", "/classes"]) {
  try {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
    const t = await r.text();
    console.log(p, r.status, t.slice(0, 600));
  } catch (e) { console.log(p, "ERR", e.message); }
}
