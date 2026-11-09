// Probe the local model server and router. Prints one JSON line each.
const targets = [
  ["llama-props", "http://127.0.0.1:8080/props"],
  ["llama-models", "http://127.0.0.1:8080/v1/models"],
  ["router-health", "http://127.0.0.1:8077/health"],
];
for (const [name, url] of targets) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = body.slice(0, 200); }
    const slim = name === "llama-props"
      ? { total_slots: parsed.total_slots, n_ctx: parsed.n_ctx, models: parsed.models?.map((m) => m.name), spec: parsed.speculative }
      : name === "llama-models"
        ? { data: (parsed.data ?? []).map((m) => m.id) }
        : parsed;
    console.log(JSON.stringify({ name, status: res.status, ok: res.ok, slim }));
  } catch (err) {
    console.log(JSON.stringify({ name, status: 0, ok: false, error: String(err?.message ?? err) }));
  }
}
