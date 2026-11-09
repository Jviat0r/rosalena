// ComfyUI - the local renderer half of the suite.
//
// Rosalena is one harness over local and public models. The local TEXT half is
// llama.cpp on :8080, reached through the router's "local" provider. The local
// MEDIA half is ComfyUI on :8188, and this plugin is that half: health, the
// installed checkpoints, and generation from an API-format workflow.
//
// Why a workflow template and not a built-in graph: a ComfyUI graph names model
// files that exist on THIS machine ("qwen-image-2.1.safetensors",
// "ltx-2.3.safetensors"). A graph shipped inside the harness would be wrong on
// every machine but one, and wrong in the quietest possible way - it would fail
// validation on a filename. So the graphs live in config, as presets, exactly
// like ContentFarm does it: export the graph from ComfyUI with "Save (API
// format)", save the JSON, and point a preset at it with {{prompt}} and friends
// where the text goes.
//
// The exception is the models downloaded on the Models page: those carry a built-in
// graph (data/comfy-workflows) filled with their own file names, so `model:
// "sdxl-base-1.0"` works on any PC that downloaded it. For those, and only when
// nothing is answering on the port, ComfyUI is started through src/comfy-runner.mjs:
// hidden, as the app's child, stopped again when idle, and given room on the card
// first (our own idle chat model is unloaded; anyone else's never is).
//
// What this plugin deliberately does NOT do:
//   - stop, restart or free a ComfyUI it did not start. ContentFarm's renderer on the
//     same port is used as it is.
//   - interrupt a running queue. Someone else's render may be in it.
//   - guess model names. /object_info says what is really installed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { GIB } from "../../src/hardware.mjs";
import { comfyRunner, runnableModels } from "../../src/comfy-runner.mjs";

const reason = (err) => (err instanceof Error ? err.message : String(err));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gb = (bytes) => (Number(bytes) / 1024 ** 3).toFixed(1);

/** The configured server, without a trailing slash. Config only: never a URL a model chose. */
export function baseUrlOf(config = {}) {
  return String(config.baseUrl ?? "http://127.0.0.1:8188").trim().replace(/\/+$/, "");
}

/** Build a URL against the configured server. `query` values are stringified and encoded. */
export function urlFor(config, path, query) {
  const url = new URL(`${baseUrlOf(config)}/${String(path).replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function getJson(url, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${new URL(url).pathname}${text ? `: ${text.slice(0, 300)}` : ""}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).pathname} did not return JSON: ${text.slice(0, 120)}`);
  }
}

/**
 * Substitute `{{name}}` in an API-format workflow.
 *
 * Keys are never substituted - node ids and class names are the graph's
 * structure - and a string that is EXACTLY one placeholder keeps the value's
 * JSON type, so `"{{steps}}"` with 20 stays a number. That matters because
 * ComfyUI validates types per input: the string "20" is not the number 20.
 */
export function fillTemplate(node, vars = {}) {
  if (typeof node === "string") {
    const whole = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(node);
    if (whole && Object.hasOwn(vars, whole[1])) return vars[whole[1]];
    return node.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => (Object.hasOwn(vars, key) ? String(vars[key]) : match));
  }
  if (Array.isArray(node)) return node.map((v) => fillTemplate(v, vars));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = fillTemplate(v, vars);
    return out;
  }
  return node;
}

/** Placeholders left unfilled, so a missing param is reported rather than sent as "{{negative}}". */
export function leftoverPlaceholders(node, found = []) {
  if (typeof node === "string") {
    for (const m of node.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.push(m[1]);
  } else if (Array.isArray(node)) {
    for (const v of node) leftoverPlaceholders(v, found);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) leftoverPlaceholders(v, found);
  }
  return [...new Set(found)];
}

/**
 * Resolve a named preset to a parsed graph. Throws with an instruction, because
 * "no presets configured" is the expected first state on a fresh machine.
 */
export function presetFor(config, root, name) {
  const presets = config?.presets && typeof config.presets === "object" ? config.presets : {};
  const key = String(name ?? "").trim();
  const names = Object.keys(presets);
  // No presets at all is the normal first state, and the answer is the same
  // whether or not the caller guessed a name: here is how to make one.
  if (!names.length) {
    throw new Error(
      "no ComfyUI presets are configured. Export the workflow from ComfyUI with Save (API format), save it as JSON, " +
        "then add it to harness.config.json under plugins.comfyui.config.presets.<name> as { workflow: \"path/to.json\", " +
        "params: { prompt: \"{{prompt}}\" } } - put {{prompt}} where the text belongs in the graph. " +
        "comfy_status lists the checkpoints that are actually installed.",
    );
  }
  if (!key) {
    throw new Error(`no preset given - configured: ${names.join(", ")}`);
  }
  const spec = presets[key];
  if (!spec || typeof spec !== "object") {
    throw new Error(`unknown preset "${key}" - configured: ${Object.keys(presets).join(", ") || "none"}`);
  }
  const workflow = String(spec.workflow ?? "").trim();
  if (!workflow) throw new Error(`preset "${key}" has no workflow path`);
  const path = isAbsolute(workflow) ? workflow : resolve(root, workflow);
  let graph;
  try {
    graph = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the workflow for preset "${key}" at ${path}: ${reason(err)}`);
  }
  if (!graph || typeof graph !== "object" || Array.isArray(graph) || Object.keys(graph).length === 0) {
    throw new Error(`${path} is not an API-format graph (expected a JSON object of node id -> node)`);
  }
  return { name: key, label: spec.label ?? key, kind: spec.kind ?? "image", path, graph, params: spec.params ?? {} };
}

/** Every saved file named in one /history/<id> entry. */
export function collectOutputFiles(entry = {}) {
  const out = [];
  for (const [node, output] of Object.entries(entry?.outputs ?? {})) {
    if (!output || typeof output !== "object") continue;
    for (const [channel, value] of Object.entries(output)) {
      if (!Array.isArray(value)) continue; // "text" is a string; only file lists matter
      for (const item of value) {
        if (!item || typeof item.filename !== "string") continue;
        out.push({ node, channel, filename: item.filename, subfolder: item.subfolder ?? "", type: item.type ?? "output" });
      }
    }
  }
  return out;
}

/** Did the graph fail validation? /prompt answers 400 with node_errors in that case. */
export function formatNodeErrors(payload) {
  const errors = payload?.node_errors ?? {};
  const lines = [];
  for (const [node, info] of Object.entries(errors)) {
    const listed = Array.isArray(info?.errors) ? info.errors : [];
    for (const e of listed) {
      const detail = e?.details ? ` (${e.details})` : "";
      lines.push(`node ${node}${info?.class_type ? ` ${info.class_type}` : ""}: ${e?.message ?? "error"}${detail}`);
    }
  }
  const top = payload?.error?.message ?? payload?.error;
  if (!lines.length && top) lines.push(String(top));
  return lines;
}

/** One-line "what is this server" summary from /system_stats. */
export function describeStats(stats = {}) {
  const sys = stats.system ?? {};
  const device = Array.isArray(stats.devices) ? stats.devices[0] : undefined;
  const parts = [];
  if (sys.comfyui_version) parts.push(`comfyui ${sys.comfyui_version}`);
  if (sys.python_version) parts.push(`python ${String(sys.python_version).split(" ")[0]}`);
  if (device?.name) {
    const vram = device.vram_total ? `, ${gb(device.vram_total)} GB total / ${gb(device.vram_free)} GB free` : "";
    parts.push(`${device.name}${vram}`);
  }
  return parts.join(" - ");
}

/** Checkpoint filenames from one node's object_info. */
export function checkpointsFrom(objectInfo) {
  const required = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name;
  const list = Array.isArray(required) ? required[0] : undefined;
  return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
}

async function checkpointsOf(config) {
  try {
    return checkpointsFrom(await getJson(urlFor(config, "/object_info/CheckpointLoaderSimple")));
  } catch {
    return []; // older servers, or a node that is not installed; not worth failing status over
  }
}

/** Reachability, queue and installed models. Shared by the tool and the /comfyui status command. */
export async function statusReport(config) {
  const base = baseUrlOf(config);
  // The Models page's downloads that run with a built-in graph, whether or not ComfyUI is up.
  const downloaded = runnableModels();
  const ready = downloaded.length
    ? `downloaded models (pass as model): ${downloaded.map((m) => `${m.id} (${m.kind}, ~${m.needGiB} GiB)`).join(", ")}`
    : "downloaded models: none yet (the Models page, Image and Video tabs)";
  try {
    const [stats, queue] = await Promise.all([getJson(urlFor(config, "/system_stats")), getJson(urlFor(config, "/queue"))]);
    const running = Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0;
    const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;
    const checkpoints = await checkpointsOf(config);
    return [
      `comfyui at ${base} is up${describeStats(stats) ? ` - ${describeStats(stats)}` : ""}${runnerFor(config).ours() ? " (started by Rosalena)" : ""}`,
      `queue ${running} running, ${pending} pending`,
      checkpoints.length ? `checkpoints ${checkpoints.length}: ${checkpoints.slice(0, 8).join(", ")}${checkpoints.length > 8 ? ", ..." : ""}` : "checkpoints none reported",
      ready,
    ].join("\n");
  } catch (err) {
    return [
      `comfyui at ${base} is not answering (${reason(err)}).`,
      downloaded.length
        ? "comfy_generate with one of the downloaded models starts it (hidden, stopped again when idle)."
        : "Start it first, or download an image model on the Models page: Rosalena then starts ComfyUI itself when a picture is asked for.",
      ready,
    ].join("\n");
  }
}

/** The shared runner for this plugin's ComfyUI address and install folder. */
const runnerFor = (config) => comfyRunner({ baseUrl: baseUrlOf(config), root: typeof config?.root === "string" && config.root.trim() ? config.root.trim() : null });

/**
 * A downloaded model by id, or - when no presets are configured - the first downloaded
 * one of the asked kind ("image" / "video"), as a preset the generate path can run.
 */
export function downloadedPreset(config, name, models = runnableModels()) {
  const key = String(name ?? "").trim();
  const configured = config?.presets && typeof config.presets === "object" && Object.keys(config.presets).length > 0;
  const hit =
    models.find((m) => m.id === key) ??
    (!configured || !key ? models.find((m) => m.kind === (key === "video" ? "video" : key === "image" || !key ? "image" : null)) : null);
  if (!hit) return null;
  return { name: hit.id, label: hit.name, kind: hit.kind, graph: hit.graph, params: hit.params, needBytes: hit.needGiB * GIB };
}

/** POST a graph and wait for its history entry. Returns the entry. */
async function queueAndWait(config, graph, { timeoutMs, pollMs }) {
  const res = await fetch(urlFor(config, "/prompt"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`/prompt answered ${res.status} with non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const lines = formatNodeErrors(payload);
    throw new Error(`ComfyUI rejected the graph (${res.status})${lines.length ? `:\n  ${lines.join("\n  ")}` : `: ${text.slice(0, 300)}`}`);
  }
  const promptId = payload?.prompt_id;
  if (!promptId) throw new Error(`/prompt did not return a prompt_id: ${text.slice(0, 200)}`);

  const deadline = Date.now() + timeoutMs;
  let entry;
  while (Date.now() < deadline) {
    const history = await getJson(urlFor(config, `/history/${encodeURIComponent(promptId)}`), { timeoutMs: 30_000 });
    entry = history?.[promptId];
    if (entry && (entry.status?.status_str === "error" || entry.status?.completed === true || collectOutputFiles(entry).length)) break;
    await sleep(pollMs);
  }
  if (!entry) throw new Error(`prompt ${promptId} did not finish within ${Math.round(timeoutMs / 1000)}s (it may still be in the queue)`);
  if (entry.status?.status_str === "error") {
    const messages = (entry.status?.messages ?? []).flat().filter((m) => typeof m === "string");
    throw new Error(`prompt ${promptId} failed: ${messages.slice(-3).join("; ") || "no detail reported"}`);
  }
  return { promptId, entry };
}

/** Download every produced file into <workspace>/<outputDir>. */
async function saveOutputs(config, root, promptId, files) {
  const dir = resolve(root, String(config?.outputDir ?? "comfyui"));
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const file of files) {
    const url = urlFor(config, "/view", { filename: file.filename, subfolder: file.subfolder, type: file.type });
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`could not download ${file.filename}: ${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    // ComfyUI names are already tame; basename + a whitelist stops "..\\x" or a drive letter anyway.
    const safe = basename(file.filename).replace(/[^A-Za-z0-9._-]/g, "_");
    const target = resolve(dir, `${String(promptId).slice(0, 8)}-${safe}`);
    writeFileSync(target, bytes);
    written.push({ path: target, bytes: bytes.length, channel: file.channel });
  }
  return written;
}

export default {
  id: "rosa-comfyui",
  description: "Local renderer: health, queue, installed checkpoints, and generation from API-format workflow presets.",
  tools(ctx) {
    const config = () => ctx.config ?? {};
    return [
      {
        name: "comfy_status",
        description:
          "Check the local ComfyUI renderer: whether it is up, its version and GPU memory, how many jobs are queued, and which checkpoint files are installed. " +
          "Use it before generating, and to learn the real model filenames.",
        parameters: { type: "object", properties: {} },
        run: async () => statusReport(config()),
      },
      {
        name: "comfy_generate",
        description:
          "Generate an image or a video on this PC with ComfyUI: either a model downloaded on the Models page (pass its id as model, e.g. sdxl-base-1.0) or a configured " +
          "workflow preset. Fills the graph's {{prompt}} (and any extra params), queues it, waits for it, and saves the produced files into the workspace. Returns the file paths. " +
          "ComfyUI is started if it is not running, and Rosalena's own idle chat model is unloaded first when the card needs the room. comfy_status lists what is available.",
        parameters: {
          type: "object",
          properties: {
            model: { type: "string", description: "A downloaded model's id from comfy_status (e.g. sdxl-base-1.0, wan2.2-ti2v-5b), or \"image\" / \"video\" for the first downloaded one." },
            preset: { type: "string", description: "Preset name from the harness config (plugins.comfyui.config.presets). Used when model is not given." },
            prompt: { type: "string", description: "The positive prompt / description to render." },
            negative: { type: "string", description: "Optional negative prompt, if the graph has a {{negative}} slot." },
            params: { type: "object", description: "Optional extra values for any other {{placeholder}} in the graph, e.g. {steps: 20, width: 768}." },
            timeoutMs: { type: "number", description: "How long to wait for the render before giving up (default: the configured timeout)." },
          },
          required: ["prompt"],
        },
        run: async ({ model, preset, prompt, negative, params, timeoutMs }) => {
          if (config().allowGenerate !== true) {
            return "generation is disabled - set plugins.comfyui.config.allowGenerate=true in harness.config.json (it spends GPU minutes, so it is off until you say so)";
          }
          const text = String(prompt ?? "").trim();
          if (!text) throw new Error("no prompt given");
          // A downloaded model (by id, or the first of a kind) before a configured preset.
          const chosen = downloadedPreset(config(), model ?? preset) ?? presetFor(config(), ctx.root, preset ?? model);
          const vars = { ...chosen.params, ...(params ?? {}), prompt: text, ...(negative ? { negative: String(negative) } : {}) };
          const graph = fillTemplate(chosen.graph, vars);
          const leftover = leftoverPlaceholders(graph);
          if (leftover.length) {
            throw new Error(`the workflow still has unfilled placeholders: ${leftover.join(", ")} - pass them in params or add defaults to the preset`);
          }
          // Up, started if need be (only a downloaded model's run may start it), with room made.
          const runner = runnerFor(config());
          if (chosen.needBytes) {
            const up = await runner.ensure();
            if (!up.ok) throw new Error(up.error);
            const room = await runner.makeRoom(chosen.needBytes);
            if (!room.ok) throw new Error(`${chosen.label} was not started: ${room.error}`);
          }
          const started = Date.now();
          runner.touch();
          const { promptId, entry } = await queueAndWait(config(), graph, {
            timeoutMs: Number(timeoutMs ?? config().timeoutMs ?? 600_000),
            pollMs: Math.max(200, Number(config().pollMs ?? 1000)),
          }).finally(() => runner.touch());
          const files = collectOutputFiles(entry);
          if (!files.length) return `prompt ${promptId} finished (${Math.round((Date.now() - started) / 1000)}s) but produced no files`;
          const written = await saveOutputs(config(), ctx.root, promptId, files);
          return [
            `${chosen.label} done in ${Math.round((Date.now() - started) / 1000)}s - prompt ${promptId}`,
            ...written.map((w) => `  ${w.path} (${(w.bytes / 1024).toFixed(0)} KB)`),
          ].join("\n");
        },
      },
    ];
  },
  commands(ctx) {
    const config = () => ctx.config ?? {};
    return {
      status: async () => statusReport(config()),
      presets: async () => {
        const presets = config().presets && typeof config().presets === "object" ? config().presets : {};
        const names = Object.keys(presets);
        if (!names.length) return "no presets configured - see /comfyui status and the note in plugins/rosa-comfyui/plugin.mjs";
        return names
          .map((name) => {
            const p = presets[name] ?? {};
            return `${name.padEnd(20)} ${String(p.kind ?? "image").padEnd(6)} ${p.label ?? ""}  ${p.workflow ?? ""}`;
          })
          .join("\n");
      },
    };
  },
  status: (ctx) => {
    const base = baseUrlOf(ctx.config);
    return ctx.config?.allowGenerate === true ? `generates on ${base}` : `report-only on ${base} (allowGenerate=false)`;
  },
};
