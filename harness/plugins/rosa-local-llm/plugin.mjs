// Local-LLM setup help: answer "what is on this box and is it running?" in one
// command, without starting or stopping anything.
//
// Read-only on purpose. Starting a model server is a lifecycle decision (one
// 3090 serves either the writer or the renderer, never both), so this plugin
// reports and never spawns; the launcher scripts stay the single source of truth.

import { existsSync, readdirSync, statSync } from "node:fs";
import { detectModelDirs, detectServerRoots } from "../../src/local-paths.mjs";
import { join } from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:8080";
const GB = 1024 ** 3;

const humanSize = (bytes) => `${(bytes / GB).toFixed(2)} GB`;

async function fetchJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function findModels(dirs) {
  const found = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      found.push({ dir, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const full = join(dir, entry.name);
      // Models sit either loose in the folder or one level down in a per-model
      // folder, which is how the Hugging Face downloads land here.
      const candidates = entry.isDirectory()
        ? readdirSync(full, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".gguf")).map((e) => join(full, e.name))
        : entry.name.endsWith(".gguf") ? [full] : [];
      for (const file of candidates) {
        try {
          found.push({ path: file, bytes: statSync(file).size });
        } catch {
          /* a file that vanished mid-scan is not worth reporting */
        }
      }
    }
  }
  return found.sort((a, b) => b.bytes - a.bytes);
}

function findBinaries(roots) {
  const hits = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of ["llama-server.exe", "start-qwen.ps1", "llama-cli.exe"]) {
      const direct = join(root, name);
      if (existsSync(direct)) hits.push(direct);
    }
    const bin = join(root, "bin");
    if (existsSync(bin)) {
      const exe = join(bin, "llama-server.exe");
      if (existsSync(exe)) hits.push(exe);
    }
  }
  return hits;
}

async function serverStatus(base) {
  const props = await fetchJson(`${base}/props`);
  if (!props.ok) return `unreachable at ${base} (${props.error})`;
  const models = await fetchJson(`${base}/v1/models`);
  const slots = props.body?.total_slots ?? "?";
  const ctx = props.body?.default_generation_settings?.n_ctx ?? props.body?.n_ctx ?? "?";
  const alias = models.ok ? (models.body?.data ?? []).map((m) => m.id).join(", ") || "none reported" : "unavailable";
  const busy = props.body?.slots?.filter?.((s) => s.is_processing)?.length;
  return [
    `reachable at ${base}`,
    `  model(s)  ${alias}`,
    `  slots     ${slots}${busy === undefined ? "" : ` (${busy} processing)`}`,
    `  ctx       ${ctx} tokens${slots === 1 ? " per slot (one session at a time)" : ` split across ${slots} slots`}`,
  ].join("\n");
}

export default {
  id: "rosa-local-llm",
  description: "Report the local llama.cpp binary, downloaded GGUF models and live server slots.",
  commands: (ctx) => ({
    models: async () => {
      const dirs = ctx.config?.modelDirs ?? detectModelDirs();
      const models = findModels(dirs);
      if (!models.length) return `no .gguf files under ${dirs.join(", ")}`;
      return models.map((m) => `  ${humanSize(m.bytes).padStart(9)}  ${m.path}`).join("\n");
    },
    scan: async () => {
      const binaries = findBinaries(ctx.config?.serverRoots ?? detectServerRoots());
      const models = findModels(ctx.config?.modelDirs ?? detectModelDirs());
      const lines = ["binaries:"];
      lines.push(...(binaries.length ? binaries.map((b) => `  ${b}`) : ["  none found"]));
      lines.push(`models: ${models.length} GGUF file(s), ${humanSize(models.reduce((sum, m) => sum + m.bytes, 0))} total`);
      return lines.join("\n");
    },
    status: async () => serverStatus(ctx.config?.baseUrl ?? DEFAULT_BASE),
  }),
  tools: (ctx) => [
    {
      name: "local_model_status",
      description: "Report which local model server is reachable and its slot/context layout before starting heavy work.",
      parameters: { type: "object", properties: {} },
      async run() {
        return serverStatus(ctx.config?.baseUrl ?? DEFAULT_BASE);
      },
    },
  ],
  status: (ctx) => `server ${ctx.config?.baseUrl ?? DEFAULT_BASE}, models in ${(ctx.config?.modelDirs ?? detectModelDirs()).join(", ") || "(none found on this PC)"}`,
};
