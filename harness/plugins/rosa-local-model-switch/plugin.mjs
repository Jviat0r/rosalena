// local-model-switch - the local GGUF shelf, the resident model, and the exact
// llama-server command that would switch it.
//
// WHY THIS PLUGIN DOES NOT SWITCH ANYTHING
//
// This machine has one RTX 3090. It serves either the writer (llama.cpp on :8080)
// or the renderer (ComfyUI on :8188), never both, and the model that is resident
// right now may be in the middle of answering somebody. Stopping it to make room
// would throw that answer away, and starting a second server would not fit. So
// "switch" here is not an action, it is a PLAN: the exact `llama-server`
// invocation, the GiB it needs resident, and a verdict this plugin can defend.
// The person who owns the GPU runs it. Every request this plugin makes is a GET;
// it never spawns, stops or kills a process (the tests assert the GET-only rule).
//
// Where each number comes from, and the honesty rules that go with it:
//
//   probeHardware()   the card and its free VRAM (nvidia-smi), RAM, and the free
//                     space on the drive that holds the models. A field it cannot
//                     measure is null, and a plan refuses rather than guesses.
//   scanLocalModels() the .gguf files actually on disk, with the quant and the
//                     parameter count guessed from the file name. Never a second
//                     scan of the same folders in this plugin: two scanners would
//                     eventually disagree.
//   loadCatalog()     data/model-catalog.json: quants, file sizes, serveContext,
//                     layers, kvDim. THE ARCHITECTURE. A file that the catalog
//                     does not know has no layer count and no KV width, so its KV
//                     cache can only be a rule of thumb - and a file whose name
//                     carries no parameter count cannot be estimated at all. That
//                     is reported as "unknown", with the reason, never as a fit.
//   GET /props        which model the live server reports (model_alias), its
//   GET /v1/models    weights path (model_path), the quantisation (model_ftype) and
//                     the per-slot context (default_generation_settings.n_ctx).
//   GET /slots        is a slot processing (is_processing), which task, how many
//                     tokens decoded and how many remain. This is what "busy" means
//                     here: a request that is being written right now.
//
// Two numbers this plugin is careful not to blur:
//
//   - the live server's context (131072 tokens on this box today) and the
//     catalog's `serveContext` (16384 for the same model) are different numbers
//     for different jobs. The plan's `-c` and its GiB use serveContext, because
//     that is the context the KV arithmetic was computed for. The resident
//     server is reported with its own real n_ctx and the two are never blended.
//   - "fits now" is measured against free VRAM (the question that stops a second
//     model being loaded onto a busy card) and "fits when idle" against the
//     card's whole VRAM (the question "is this the model worth running at all").
//     With the writer resident at 23.4 of 24 GiB, almost nothing fits now, and
//     saying only that would say no to everything.
//
// What it will not do, on purpose:
//
//   - it will not plan a switch to a model that does not fit the card, even with
//     partial offload. A `-ngl` below the layer count is a way of suggesting a
//     model that does not fit, which is exactly what was forbidden.
//   - it will not name a model it could not match. An unknown name gets the
//     closest candidates and nothing else.
//   - it will not pretend to know VRAM. No nvidia-smi answer, no plan.

import { probeHardware, estimateModelNeeds, GIB } from "../../src/hardware.mjs";
import { loadCatalog, scanLocalModels } from "../../src/catalog.mjs";
import { detectModelDirs, detectServerBinary } from "../../src/local-paths.mjs";

const DEFAULT_BASE = "http://127.0.0.1:8080";
const DEFAULT_PLAN_CONTEXT = 16384;

// The same 1500ms the monitor uses: a loopback server answers in milliseconds, so
// a second and a half means "wedged", not "slow".
const DEFAULT_TIMEOUT_MS = 1500;

// Longest list of installed files a `list` prints. The catalog scan can see a
// whole drive; a switch planner needs the shelf, not an inventory.
const MAX_ROWS = 40;

// Candidate names offered for a name that matched nothing, or matched twice.
const MAX_CANDIDATES = 5;

const reason = (err) => (err instanceof Error ? err.message : String(err));

/** Bytes as GiB with one decimal. GiB because nvidia-smi reports MiB. */
export function gib(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "?";
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/** The comparison key for names: lower case, letters and digits only. */
export function norm(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function baseName(path) {
  const parts = String(path ?? "").split(/[\\/]/);
  return parts[parts.length - 1] || String(path ?? "");
}

function dirName(path) {
  const parts = String(path ?? "").split(/[\\/]/);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

/**
 * One argument, quoted the way Windows needs it on a command line a person pastes
 * into PowerShell or cmd. Only quotes when it has to: a plan reads better without
 * a forest of quotes around `127.0.0.1`.
 */
export function quoteArg(value) {
  const text = String(value);
  if (text === "") return '""';
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/** An argv as the line to paste. The plan prints exactly this. */
export function formatCommand(argv) {
  return argv.map(quoteArg).join(" ");
}

/**
 * The configured server, normalised. Config only: this plugin never takes a URL
 * or a binary path from a model.
 */
export function configOf(config = {}) {
  const base = String(config.baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, "");
  let host = "127.0.0.1";
  let port = 8080;
  try {
    const url = new URL(base);
    host = url.hostname || host;
    port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  } catch {
    /* a nonsense baseUrl keeps the defaults above: it is reported, not thrown */
  }
  const context = Number(config.planContext);
  const timeout = Number(config.timeoutMs);
  const dirs = Array.isArray(config.modelDirs) ? config.modelDirs.filter((d) => typeof d === "string" && d.trim()) : detectModelDirs();
  return {
    baseUrl: base,
    host,
    port,
    // Configured, else the llama-server found on this PC (see src/local-paths.mjs).
    binary: String(config.serverBinary ?? "").trim() || detectServerBinary(),
    dirs,
    planContext: Number.isFinite(context) && context > 0 ? Math.round(context) : DEFAULT_PLAN_CONTEXT,
    timeoutMs: Number.isFinite(timeout) && timeout >= 50 ? Math.round(timeout) : DEFAULT_TIMEOUT_MS,
    extraFlags: Array.isArray(config.extraFlags) ? config.extraFlags.map(String) : [],
  };
}

// ---------------------------------------------------------------------------
// The live server: GETs only, and never a throw
// ---------------------------------------------------------------------------

async function getJson(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, text };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : reason(err) };
  } finally {
    clearTimeout(timer);
  }
}

function slotRow(slot) {
  const next = Array.isArray(slot?.next_token) ? slot.next_token[0] : null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    id: num(slot?.id),
    processing: slot?.is_processing === true,
    task: num(slot?.id_task),
    prompt: num(slot?.n_prompt_tokens),
    decoded: num(next?.n_decoded),
    remain: num(next?.n_remain),
  };
}

/**
 * What is on the port right now.
 *
 * Every field is null when the server did not say it: a server that is up but
 * still loading a model answers 503 with no /props, and "loading" is a state worth
 * naming rather than reporting as "down".
 */
export async function probeServer({ baseUrl = DEFAULT_BASE, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const at = Date.now();
  const health = await getJson(`${base}/health`, fetchImpl, timeoutMs);
  const status = { baseUrl: base, at, up: false, loading: false, isLlama: false, model: null, modelPath: null, ftype: null, ctx: null, totalSlots: null, slots: [], busy: null, busySlots: [], error: null };

  if (health.status === 0) {
    status.error = health.error ?? "no answer";
    return status;
  }
  if (health.status === 200) status.up = true;
  else if (health.status === 503) {
    // 503 is the loading state of a llama.cpp that is already holding the card.
    status.loading = true;
    status.up = false;
  }

  const props = await getJson(`${base}/props`, fetchImpl, timeoutMs);
  if (props.status === 0 && !status.loading) {
    status.error = props.error ?? "no answer";
    return status;
  }
  if (props.ok && props.body && typeof props.body === "object") {
    const body = props.body;
    status.isLlama = Boolean(body.default_generation_settings) || typeof body.total_slots === "number";
    status.model = typeof body.model_alias === "string" && body.model_alias.trim() ? body.model_alias.trim() : null;
    status.modelPath = typeof body.model_path === "string" && body.model_path.trim() ? body.model_path.trim() : null;
    status.ftype = typeof body.model_ftype === "string" && body.model_ftype.trim() ? body.model_ftype.trim() : null;
    const nCtx = Number(body.default_generation_settings?.n_ctx);
    status.ctx = Number.isFinite(nCtx) && nCtx > 0 ? nCtx : null;
    const slots = Number(body.total_slots);
    status.totalSlots = Number.isFinite(slots) && slots > 0 ? slots : null;
    if (!status.model && status.modelPath) status.model = baseName(status.modelPath).replace(/\.gguf$/i, "");
  }

  const models = await getJson(`${base}/v1/models`, fetchImpl, timeoutMs);
  if (models.ok && Array.isArray(models.body?.data) && models.body.data.length) {
    status.up = true;
    status.isLlama = status.isLlama || !status.model;
    const first = String(models.body.data[0]?.id ?? "").trim();
    if (!status.model && first) status.model = first;
  } else if (health.status === 200 && !status.model) {
    // A server answering /health but not /v1/models is something else on the port.
    status.up = status.isLlama;
  }

  const slots = await getJson(`${base}/slots`, fetchImpl, timeoutMs);
  if (slots.ok && Array.isArray(slots.body)) {
    status.slots = slots.body.map(slotRow);
    const busy = status.slots.filter((s) => s.processing);
    status.busy = busy.length > 0;
    status.busySlots = busy;
  }
  // /slots is a build option, so "busy" stays null when it is unavailable: a
  // server that cannot say whether it is generating is not the same as an idle one.
  return status;
}

// ---------------------------------------------------------------------------
// Matching a name against the catalog and the files on disk
// ---------------------------------------------------------------------------

/** Does this file belong to that catalog entry? Weights only: a projector is not the model. */
export function fileMatchesEntry(file, entry) {
  if (!file || !entry) return false;
  if (file.projector || file.mtp) return false;
  const needles = [entry.id, entry.name].filter(Boolean).map(norm).filter(Boolean);
  const hay = `${norm(baseName(file.path))}|${norm(dirName(file.path))}`;
  return needles.some((needle) => hay.includes(needle));
}

function scoreExact(query, candidate) {
  const q = norm(query);
  const c = norm(candidate);
  if (!q || !c) return 0;
  if (q === c) return 6;
  if (c.startsWith(q) || q.startsWith(c)) return 4;
  if (c.includes(q) || q.includes(c)) return 2;
  return 0;
}

/**
 * One model plus the files that belong to it.
 *
 * A "unit" is the thing a plan can be about: a catalog entry with whatever of its
 * quants are on disk, or a GGUF that the catalog does not know at all. Building
 * them here is what keeps the two sources from being searched twice, with two
 * chances to disagree.
 */
export function modelUnits({ catalog = null, files = [] } = {}) {
  const entries = Array.isArray(catalog?.models) ? catalog.models : [];
  const claimed = new Set();
  const units = [];
  for (const entry of entries) {
    const own = files.filter((f) => fileMatchesEntry(f, entry));
    for (const file of own) claimed.add(file.path);
    units.push({ entry, files: own, kind: "catalog" });
  }
  for (const file of files) {
    if (claimed.has(file.path)) continue;
    if (file.projector || file.mtp) continue;
    units.push({ entry: null, files: [file], kind: "disk" });
  }
  return units;
}

function scoreUnit(unit, query) {
  let best = 0;
  let bestFile = null;
  let bestFileScore = 0;
  if (unit.entry) {
    best = Math.max(best, scoreExact(query, unit.entry.id), scoreExact(query, unit.entry.name));
  }
  for (const file of unit.files) {
    // The folder a model sits in is the strongest signal there is: the standard
    // weights live in `qwen3.8-27b\` and the three experimental forks of the same
    // architecture live in their own folders.
    const folder = scoreExact(query, dirName(file.path));
    const name = scoreExact(query, baseName(file.path));
    const score = Math.max(name, folder ? Math.min(folder, 5) : 0);
    if (score > bestFileScore) {
      bestFileScore = score;
      bestFile = file;
    }
  }
  if (bestFileScore > best) best = bestFileScore;
  return { score: best, file: bestFile };
}

function describeUnit(unit, base) {
  const where = (file) => {
    const folder = dirName(file.path);
    return folder ? `${folder}\\${baseName(file.path)}` : baseName(file.path);
  };
  if (unit.entry && unit.files.length > 1) return `${unit.entry.id} (installed: ${unit.files.length} file(s))`;
  if (unit.entry && unit.files.length) return `${unit.entry.id} (${where(unit.files[0])})`;
  if (unit.entry) {
    const file = (unit.entry.quants ?? [])[0];
    return `${unit.entry.id} (in the catalog, not on disk${file ? ` - e.g. ${file.quant}` : ""})`;
  }
  const file = unit.files[0];
  return `${baseName(file.path)}${base ? ` under ${base}` : dirName(file.path) ? ` (in ${dirName(file.path)})` : ""}`;
}

/** Ranked near-misses for a name that matched nothing: never a silent guess. */
function candidatesFor(units, query, base) {
  const q = norm(query);
  const ranked = units
    .map((unit) => {
      const names = [unit.entry?.id, unit.entry?.name, ...unit.files.map((f) => f.file)].filter(Boolean).map(norm);
      let shared = 0;
      for (const name of names) {
        let i = 0;
        while (i < q.length && i < name.length && q[i] === name[i]) i += 1;
        shared = Math.max(shared, i);
      }
      return { unit, shared };
    })
    .filter((row) => row.shared >= 3)
    .sort((a, b) => b.shared - a.shared);
  const rows = (ranked.length ? ranked.map((r) => r.unit) : units).slice(0, MAX_CANDIDATES);
  return rows.map((unit) => describeUnit(unit, base));
}

/**
 * Resolve a name to one unit.
 *
 * Exact beats prefix beats substring, and a tie is reported as ambiguous: naming
 * two different models is not a decision this plugin gets to make for the person
 * who typed a half-remembered name.
 */
export function pickModel(name, { catalog = null, files = [] } = {}) {
  const query = String(name ?? "").trim();
  const units = modelUnits({ catalog, files });
  if (!query) return { kind: "empty", units, candidates: [] };
  const scored = units.map((unit) => ({ unit, ...scoreUnit(unit, query) })).filter((row) => row.score > 0);
  if (!scored.length) return { kind: "unknown", units, candidates: candidatesFor(units, query, null) };
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0].score;
  const winners = scored.filter((row) => row.score === top);
  if (winners.length > 1) {
    return {
      kind: "ambiguous",
      units,
      candidates: winners.slice(0, MAX_CANDIDATES).map((row) => describeUnit(row.unit, null)),
    };
  }
  const chosen = winners[0];
  return { kind: chosen.unit.kind, unit: chosen.unit, file: chosen.file, score: top, units, candidates: [] };
}

// ---------------------------------------------------------------------------
// What a model needs, and whether the card can hold it
// ---------------------------------------------------------------------------

function entryParams(entry) {
  const value = Number(entry?.params);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function contextFor(entry, requested, fallback) {
  const asked = Number(requested);
  if (Number.isFinite(asked) && asked > 0) return Math.round(asked);
  const served = Number(entry?.serveContext ?? entry?.context);
  if (Number.isFinite(served) && served > 0) return Math.round(served);
  return fallback;
}

/**
 * Weights + KV + runtime for one quant of one model.
 *
 * The file size is the disk's own figure when the weights are installed (exact,
 * and it wins over the catalog's download size) and the catalog's file size when
 * they are not (Hugging Face's blob size, decimal GB). Layers and kvDim come from
 * the catalog: a file whose architecture is not in the catalog can only get the
 * conservative rule of thumb, and `basis.kv` says which one was used.
 */
export function needsFor({ entry = null, file = null, quant = null, context }) {
  const fileGb = file ? file.bytes / 1e9 : null;
  const chosenQuant = quant ?? (entry?.quants ?? []).find((q) => norm(q.quant) === norm(file?.quant)) ?? null;
  const params = file?.params ?? entryParams(entry);
  const quantLabel = file?.quant ?? chosenQuant?.quant ?? null;
  const spec = {
    fileGb: fileGb ?? chosenQuant?.file ?? null,
    params,
    context,
    layers: entry?.layers ?? null,
    kvDim: entry?.kvDim ?? null,
    extraGb: entry?.extraGb ?? null,
  };
  // A quant label is only needed when the file size is unknown; when neither the
  // file nor a catalog quant is available there is no weight figure at all.
  if (spec.fileGb === null && quantLabel) spec.quant = quantLabel;
  if (spec.fileGb === null) return { ok: false, why: "no file size: the weights are neither on disk nor in the catalog" };
  try {
    const needs = estimateModelNeeds(spec);
    return {
      ok: true,
      needBytes: needs.totalBytes,
      weightsBytes: needs.weightsBytes,
      kvCacheBytes: needs.kvCacheBytes,
      overheadBytes: needs.overheadBytes,
      context: needs.context,
      basis: needs.basis,
      params,
      quant: quantLabel,
      // A KV figure from the rule of thumb is an estimate, not this model's
      // architecture, and the plan says so rather than presenting it as exact.
      kvExact: needs.basis.kv === "architecture",
    };
  } catch (err) {
    return { ok: false, why: reason(err) };
  }
}

/**
 * The four-word verdict this plugin is allowed to give.
 *
 * `unknown` is only for a machine that could not report VRAM: "does not fit" and
 * "nobody measured" are different answers and a plan must not merge them.
 */
export function fitVerdict({ needBytes, gpuFreeBytes = null, gpuTotalBytes = null, ramFreeBytes = null }) {
  const need = Number(needBytes);
  if (!Number.isFinite(need) || need <= 0) return { verdict: "unknown", reason: "no size to compare with the card" };
  if (!Number.isFinite(gpuTotalBytes) || !Number.isFinite(gpuFreeBytes)) {
    return {
      verdict: "unknown",
      reason: "the card did not report its VRAM, so a fit verdict would be a guess (nvidia-smi drives this number)",
    };
  }
  if (need <= gpuFreeBytes) {
    return {
      verdict: "fits now",
      reason: `${gib(need)} of ${gib(gpuFreeBytes)} free VRAM, ${gib(gpuFreeBytes - need)} spare`,
    };
  }
  if (need <= gpuTotalBytes) {
    return {
      verdict: "fits when idle",
      reason: `${gib(need)} does not fit the ${gib(gpuFreeBytes)} that are free, but it fits the card's whole ${gib(gpuTotalBytes)} - it needs whatever holds the card now to stop`,
    };
  }
  const cpu =
    Number.isFinite(ramFreeBytes) && need <= ramFreeBytes
      ? `; it would fit the ${gib(ramFreeBytes)} of free RAM with CPU offload at a few tokens per second, which is not a switch this plugin plans`
      : "";
  return {
    verdict: "will not fit",
    reason: `${gib(need)} against the card's whole ${gib(gpuTotalBytes)}: ${gib(need - gpuTotalBytes)} too big for this GPU${cpu}`,
  };
}

/**
 * The exact invocation.
 *
 * `-ngl` is the layer count from the catalog when it is known (all of them: a plan
 * for less than the whole model is a plan for a model that does not fit), and 99
 * otherwise, which is llama.cpp's own "all layers" idiom. Nothing else is guessed:
 * `--host` and `--port` come from the configured baseUrl, so a plan always
 * describes the server the harness actually talks to.
 */
export function commandFor({ config, weightsPath, context, layers = null, alias = null }) {
  const argv = [config.binary, "-m", weightsPath, "-c", String(context), "-ngl", String(layers ?? 99)];
  if (alias) argv.push("--alias", alias);
  argv.push("--host", config.host, "--port", String(config.port));
  argv.push(...config.extraFlags);
  return argv;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function relPath(path, dirs) {
  for (const dir of dirs) {
    const prefix = String(dir).replace(/[\\/]+$/, "");
    if (String(path).toLowerCase().startsWith(prefix.toLowerCase())) {
      return String(path).slice(prefix.length).replace(/^[\\/]/, "");
    }
  }
  return baseName(path);
}

function busyLine(server) {
  const rows = server.busySlots ?? [];
  if (!rows.length) return "no slot is processing a request";
  return rows
    .map((slot) => {
      const bits = [];
      if (slot.task !== null) bits.push(`task ${slot.task}`);
      if (slot.decoded !== null) bits.push(`${slot.decoded} tokens decoded`);
      if (slot.remain !== null && slot.remain >= 0) bits.push(`${slot.remain} to go`);
      if (slot.prompt !== null) bits.push(`${slot.prompt} prompt tokens`);
      return `slot ${slot.id ?? "?"} is processing${bits.length ? ` - ${bits.join(", ")}` : ""}`;
    })
    .join("; ");
}

function serverLine(server) {
  if (server.up) {
    const model = server.model ?? "a model that did not name itself";
    return `up at ${server.baseUrl} - serving ${model}`;
  }
  if (server.loading) return `loading a model at ${server.baseUrl} (HTTP 503 - the card is already held, it is not answering yet)`;
  return `not answering at ${server.baseUrl} (${server.error ?? "no answer"})`;
}

// ---------------------------------------------------------------------------
// The three commands
// ---------------------------------------------------------------------------

function listLines({ config, hardware, server, catalog, files, catalogError }) {
  const out = [];
  const gpu = hardware?.gpu ?? {};
  out.push(
    hardware
      ? `local models - ${gpu.name ?? "GPU unknown"}, ${gib(gpu.vramTotalBytes)} VRAM, ${gib(gpu.vramFreeBytes)} free`
      : "local models - hardware not probed",
  );
  out.push(`  server  ${serverLine(server)}`);
  if (server.up && server.ctx !== null) {
    out.push(`  context ${server.ctx} tokens per slot, ${server.totalSlots ?? "?"} slot - the live server's own figure`);
  }
  if (server.up && server.ftype) out.push(`  quant   ${server.ftype} (reported by the server)`);
  if (server.up) {
    out.push(`  busy    ${busyLine(server)}`);
    if (server.modelPath) out.push(`  weights ${server.modelPath}`);
  }

  const weighable = files.filter((f) => !f.projector && !f.mtp);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  if (!files.length) {
    out.push("", `installed: no .gguf files under ${config.dirs.join(", ")}`);
  } else {
    out.push("", `installed - ${config.dirs.join(", ")}, ${weighable.length} model file(s) of ${files.length} .gguf, ${gib(totalBytes)} on disk`);
    out.push(`  ${"now".padEnd(6)}${"idle".padEnd(6)}${"need".padStart(9)}  ${"size".padStart(9)}  ${"quant".padEnd(12)}${"params".padEnd(9)}file`);
    const rows = weighable.slice(0, MAX_ROWS);
    for (const file of rows) {
      const entry = (catalog?.models ?? []).find((candidate) => fileMatchesEntry(file, candidate)) ?? null;
      const needs = needsFor({ entry, file, context: contextFor(entry, null, config.planContext) });
      const fits = (limit) => (Number.isFinite(limit) && needs.ok ? (needs.needBytes <= limit ? "yes" : "no") : "?");
      const params = file.params === null ? "-" : `${file.params}B`;
      const resident = server.up && server.modelPath && String(server.modelPath).toLowerCase() === String(file.path).toLowerCase() ? "  <- resident" : "";
      out.push(
        `  ${fits(gpu.vramFreeBytes).padEnd(6)}${fits(gpu.vramTotalBytes).padEnd(6)}${(needs.ok ? gib(needs.needBytes) : "unknown").padStart(9)}  ${gib(file.bytes).padStart(9)}  ` +
          `${(file.quant ?? "?").padEnd(12)}${params.padEnd(9)}${relPath(file.path, config.dirs)}${resident}`,
      );
    }
    if (weighable.length > MAX_ROWS) out.push(`  ... and ${weighable.length - MAX_ROWS} more`);
    const noParams = weighable.filter((f) => f.params === null);
    if (noParams.length) {
      out.push(
        `  ${noParams.length} file(s) name no parameter count (${noParams
          .slice(0, 2)
          .map((f) => baseName(f.path))
          .join(", ")}${noParams.length > 2 ? ", ..." : ""}): their KV cache cannot be estimated, so their need is the`,
        "  file size plus runtime - a floor, not a fit. `plan <name>` says exactly that instead of rounding up.",
        "  'now' answers 'does it fit the VRAM that is free this second'; 'idle' answers 'does it fit the card at all'.",
      );
    } else {
      out.push("  'now' answers 'does it fit the VRAM that is free this second'; 'idle' answers 'does it fit the card at all'.");
    }
  }

  const installedIds = new Set();
  for (const entry of catalog?.models ?? []) {
    if (files.some((file) => fileMatchesEntry(file, entry))) installedIds.add(entry.id);
  }
  const notInstalled = (catalog?.models ?? []).filter((entry) => !installedIds.has(entry.id));
  if (catalogError) out.push("", `catalog: not loaded (${catalogError}) - only what is on disk can be described`);
  else if (notInstalled.length) {
    const head = notInstalled.slice(0, 6).map((entry) => entry.id);
    out.push(
      "",
      `catalog: ${catalog.models.length} entries, ${notInstalled.length} not installed (${head.join(", ")}${notInstalled.length > head.length ? ", ..." : ""})`,
      "  `plan <name>` works for those too: it names the quant worth downloading and refuses if the card cannot hold it.",
    );
  }
  out.push("", "nothing here starts, stops or kills a server. `plan <name>` prints the command to run yourself.");
  return out;
}

function nowLines({ config, hardware, server, catalog, files }) {
  const gpu = hardware?.gpu ?? {};
  const out = [`local model server - now`, `  server  ${serverLine(server)}`];
  if (server.up) {
    if (server.model) out.push(`  model   ${server.model}${server.ftype ? ` (${server.ftype})` : ""}`);
    if (server.modelPath) out.push(`  weights ${server.modelPath}`);
    if (server.ctx !== null) out.push(`  context ${server.ctx} tokens per slot, ${server.totalSlots ?? "?"} slot (the server's own report)`);
    out.push(`  busy    ${server.busy === null ? "unknown - /slots did not answer, so nothing here can say whether it is generating" : busyLine(server)}`);
  }
  out.push(
    `  card    ${gpu.name ?? "GPU unknown"} - ${gib(gpu.vramFreeBytes)} free of ${gib(gpu.vramTotalBytes)}` +
      `${hardware?.ram?.freeBytes !== undefined ? `, ${gib(hardware.ram.freeBytes)} RAM free` : ""}`,
  );

  if (server.up && server.model) {
    const picked = pickModel(server.model, { catalog, files });
    if (picked.kind === "catalog" || picked.kind === "disk") {
      const unit = picked.unit;
      const file = picked.file ?? unit.files[0] ?? null;
      const needs = needsFor({ entry: unit.entry, file, context: contextFor(unit.entry, null, config.planContext) });
      const verdict = needs.ok
        ? fitVerdict({ needBytes: needs.needBytes, gpuFreeBytes: gpu.vramFreeBytes ?? null, gpuTotalBytes: gpu.vramTotalBytes ?? null, ramFreeBytes: hardware?.ram?.freeBytes ?? null })
        : null;
      if (verdict) {
        out.push(`  fits    ${verdict.verdict} - ${verdict.reason}`);
        if (server.ctx !== null && needs.context !== server.ctx) {
          out.push(
            `          the ${gib(needs.needBytes)} figure is for ${needs.context} tokens (the catalog's serveContext); the server runs ${server.ctx},`,
            "          whose KV cache is larger and is not included in that number",
          );
        }
      }
    } else {
      out.push(`  fits    not judged: "${server.model}" matched no catalog entry and no file on disk`);
    }
  } else if (server.loading) {
    out.push("  note    a model is loading; its name is not available until /props answers");
  } else {
    out.push("  note    nothing is resident. `list` shows what is installed and what the card can hold; `plan <name>` prints the command.");
  }
  out.push("", "read-only: this plugin never starts, stops or restarts the server.");
  return out;
}

function planLines({ config, hardware, server, pick, context, catalog, catalogError }) {
  const gpu = hardware?.gpu ?? {};
  const unit = pick.unit;
  const entry = unit.entry;
  const diskFile = pick.file ?? unit.files[0] ?? null;
  const name = entry?.id ?? baseName(diskFile?.path ?? "?").replace(/\.gguf$/i, "");
  const out = [`local model switch plan - ${name}`];

  // 1. Which quant, and where it is.
  let quant = diskFile?.quant ?? null;
  let chosen = { file: diskFile, quant: null };
  if (entry && !diskFile) {
    const options = (entry.quants ?? []).map((q) => {
      const needs = needsFor({ entry, file: null, quant: q, context });
      return { ...q, needs };
    });
    const usable = options.filter((o) => o.needs.ok);
    const fitsNow = usable.filter((o) => o.needs.needBytes <= (gpu.vramFreeBytes ?? -1)).sort((a, b) => b.needs.needBytes - a.needs.needBytes)[0];
    const fitsIdle = usable.filter((o) => o.needs.needBytes <= (gpu.vramTotalBytes ?? -1)).sort((a, b) => b.needs.needBytes - a.needs.needBytes)[0];
    const smallest = [...usable].sort((a, b) => a.needs.needBytes - b.needs.needBytes)[0];
    const pickQuant = fitsNow ?? fitsIdle ?? smallest ?? options[0];
    chosen = { file: null, quant: pickQuant };
    quant = pickQuant?.quant ?? null;
  }
  const needs = needsFor({ entry, file: chosen.file, quant: chosen.quant, context });
  const weightsPath = chosen.file?.path ?? null;

  if (chosen.file) {
    out.push(`  file     ${chosen.file.path}, ${gib(chosen.file.bytes)} on disk`);
  } else if (chosen.quant) {
    out.push(`  file     ${chosen.quant.quant} is in the catalog but not on disk (${gib(Math.round((chosen.quant.file ?? 0) * 1e9))} download)`);
    if (chosen.quant.url) out.push(`  url      ${chosen.quant.url}`);
  }
  if (!needs.ok) {
    out.push("", `  unknown  ${needs.why}`, "");
    out.push("  A plan needs a weights figure. Add the model to data/model-catalog.json (params, layers,");
    out.push("  kvDim, quants) and the arithmetic becomes exact; until then this plugin will not guess.");
    return out;
  }

  // The KV figure comes from the catalog's architecture, from the rule of thumb, or
  // from nowhere at all. Each is a different claim, so each gets its own sentence: a
  // model with no parameter count has no KV cache in its number, which makes the
  // number a floor rather than a fit.
  const arch = entry
    ? `${entry.layers ?? "?"} layers, kvDim ${entry.kvDim ?? "?"} from the catalog`
    : "no catalog entry, so the KV cache is the 8 KiB-per-billion-params rule of thumb";
  const terms = [`${gib(needs.weightsBytes)} weights`];
  if (needs.kvCacheBytes !== null) terms.push(`${gib(needs.kvCacheBytes)} KV (${arch})`);
  terms.push(`${gib(needs.overheadBytes)} runtime`);
  out.push(`  needs    ${gib(needs.needBytes)} resident at ${needs.context} tokens - ${terms.join(" + ")}`);
  if (needs.kvCacheBytes === null) {
    out.push(
      "  floor    no KV cache is in that figure: the file names no parameter count and the catalog does not know",
      "           the model, so the need is the weights plus the runtime - a lower bound, not a fit.",
    );
  }
  if (needs.params === null) out.push("  params   unknown: the file name carries no parameter count");

  // 2. The card.
  if (!Number.isFinite(gpu.vramTotalBytes) || !Number.isFinite(gpu.vramFreeBytes)) {
    out.push("", "  REFUSED - this machine did not report its VRAM.", `  ${hardware?.gpu?.name ? `The adapter is named "${hardware.gpu.name}", but no VRAM figure came with it.` : "No GPU was visible at all."}`);
    out.push(
      "  Without a VRAM number a fit verdict is a guess, and guessing is how a 27B model gets",
      "  launched onto a card that is already holding one. Install or repair the NVIDIA driver so",
      "  `nvidia-smi` answers, then ask again. `list` still works: it reports only what was measured.",
    );
    if (hardware?.notes?.length) out.push("", ...hardware.notes.map((note) => `  note     ${note}`));
    return out;
  }
  out.push(`  card     ${gpu.name ?? "GPU"} - ${gib(gpu.vramFreeBytes)} free of ${gib(gpu.vramTotalBytes)}`);
  const verdict = fitVerdict({ needBytes: needs.needBytes, gpuFreeBytes: gpu.vramFreeBytes, gpuTotalBytes: gpu.vramTotalBytes, ramFreeBytes: hardware?.ram?.freeBytes ?? null });
  out.push(`  verdict  ${verdict.verdict} - ${verdict.reason}`);

  // 3. The server, and the one thing that stops a switch: a request being written.
  out.push(`  server   ${serverLine(server)}`);
  const residentName = server.model ?? null;
  const sameModel = Boolean(residentName) && norm(residentName) === norm(name);
  if (server.busy) out.push(`  busy     ${busyLine(server)}`);
  else if (server.busy === null && server.up) {
    out.push("  busy     unknown - /slots did not answer, so whether a request is in flight cannot be seen from here");
  }

  if (sameModel) {
    out.push(
      "",
      server.busy
        ? `  no switch needed: ${name} is the resident model and it is answering right now.`
        : `  no switch needed: ${name} is already the resident model.`,
      "  Stopping and restarting it to switch to itself would only throw the loaded weights away.",
    );
    return out;
  }

  // 4. A model that does not fit gets no command at all.
  if (verdict.verdict === "will not fit") {
    out.push(
      "",
      "  REFUSED - no command is printed for a model that does not fit the card.",
      "  A partial-offload `-ngl` would make it run at a few tokens per second; that is a different",
      "  decision and it is not the one that was asked for.",
    );
    const smallest = (entry?.quants ?? [])
      .map((q) => ({ q, needs: needsFor({ entry, file: null, quant: q, context }) }))
      .filter((row) => row.needs.ok)
      .sort((a, b) => a.needs.needBytes - b.needs.needBytes)[0];
    if (smallest) {
      out.push(`  the smallest quant in the catalog is ${smallest.q.quant} at ${gib(smallest.needs.needBytes)} - also bigger than this card`);
    }
    return out;
  }

  if (!weightsPath) {
    out.push(
      "",
      "  no command yet: the weights for this plan are not on disk, so there is no -m path to print.",
      "  Download the file the catalog names, put it under one of the model folders, and run the plan again.",
    );
    return out;
  }

  const alias = entry?.id ?? baseName(weightsPath).replace(/\.gguf$/i, "");
  const command = commandFor({ config, weightsPath, context: needs.context, layers: entry?.layers ?? null, alias });
  const switches = server.up;

  // The refusal comes before the command, because the order matters: the command
  // is not to be pasted while a slot is generating.
  if (server.busy) {
    out.push(
      "",
      "  REFUSED - the server is busy processing a request.",
      "  A switch means stopping the resident model mid-answer and losing it, which this plugin will not",
      "  do and nobody should: wait for the slot to go idle, then run the command below.",
    );
  }
  out.push("", "  command  (copy this; the plugin does not run it)", `  ${formatCommand(command)}`);
  if (config.extraFlags.length) {
    out.push(
      "           the flags after --port are plugins.local-model-switch.config.extraFlags, copied from the",
      "           launcher that works on this machine; a model-specific flag (--spec-type draft-mtp) is not added",
    );
  }
  if (needs.kvCacheBytes === null) {
    out.push("           no KV cache is in that figure at all: the need is a floor, not a fit");
  } else if (!needs.kvExact) {
    out.push("           the KV figure is the rule of thumb, not this file's architecture - expect it to be off by a GiB or so");
  }
  out.push(
    "",
    switches
      ? "  nothing was started, stopped or killed. One card, one resident model: whatever holds the GPU now has"
      : "  nothing was started, stopped or killed. The port is free, so this command can be run as-is:",
  );
  if (switches) out.push("  to finish and be stopped by whoever owns it before this command can take effect.");
  if (catalogError) out.push(`  note     the catalog did not load (${catalogError}), so only disk files were matchable`);
  return out;
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * Build the definition. Everything the outside world touches is injectable, so the
 * tests can drive a busy server, a card with no VRAM and a temp folder of GGUFs
 * without a GPU, a network or a real model.
 */
export function createLocalSwitch(deps = {}) {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const probe = deps.probe ?? ((options) => probeHardware(options));
  const scan = deps.scan ?? ((dirs) => scanLocalModels(dirs));
  const readCatalog = deps.catalog ?? (() => loadCatalog());

  const catalogOf = () => {
    try {
      return { catalog: readCatalog(), error: null };
    } catch (err) {
      return { catalog: null, error: reason(err) };
    }
  };

  const hardwareOf = (config) => {
    try {
      return { hardware: probe({ modelsDir: config.dirs[0] ?? null }), error: null };
    } catch (err) {
      return { hardware: null, error: reason(err) };
    }
  };

  const scanOf = (config) => {
    try {
      return { files: scan(config.dirs), error: null };
    } catch (err) {
      return { files: [], error: reason(err) };
    }
  };

  return {
    id: "rosa-local-model-switch",
    description:
      "Which local GGUF models are installed, which one llama.cpp is serving, which the card can hold, and the exact llama-server command to switch - read-only",

    commands(ctx) {
      const config = configOf(ctx.config ?? {});
      const state = async () => {
        const { catalog, error: catalogError } = catalogOf();
        const { hardware } = hardwareOf(config);
        const { files } = scanOf(config);
        const server = await probeServer({ baseUrl: config.baseUrl, fetchImpl, timeoutMs: config.timeoutMs });
        return { config, catalog, catalogError, hardware, files, server };
      };

      return {
        // What is installed, what is resident, and what the card can hold.
        list: async () => {
          const view = await state();
          return listLines(view).join("\n");
        },

        // What llama.cpp is serving right now, with its own context and busy state.
        now: async () => {
          const view = await state();
          return nowLines(view).join("\n");
        },

        // The exact command, the GiB it needs, and a verdict - or a refusal with
        // the reason. `plan <name> [context]`.
        plan: async (argv) => {
          const name = Array.isArray(argv) ? argv[0] : argv;
          const contextArg = Array.isArray(argv) ? argv[1] : undefined;
          const view = await state();
          if (!String(name ?? "").trim()) {
            return [
              "usage: rosa-local-model-switch:plan <model> [context]",
              "",
              "  model    a catalog id (qwen3.8-27b), a file name (Qwen3.8-27B-UD-Q4_K_M.gguf) or a path under",
              `           ${view.config.dirs.join(", ")}`,
              "  context  tokens to plan for; defaults to the catalog's serveContext, else plugins.local-model-switch.config.planContext",
              "",
              view.files.length ? `installed: ${view.files.filter((f) => !f.projector && !f.mtp).length} model file(s)` : "no models installed",
            ].join("\n");
          }
          const pick = pickModel(name, { catalog: view.catalog, files: view.files });
          if (pick.kind === "unknown") {
            return [
              `local model switch plan - no model matches "${name}"`,
              "",
              pick.candidates.length ? "  closest names:" : "  no catalog entry and no .gguf under the configured folders shares even a prefix with it",
              ...pick.candidates.map((candidate) => `    ${candidate}`),
              "",
              "  nothing was guessed: a plan for the wrong model is worse than no plan.",
            ].join("\n");
          }
          if (pick.kind === "ambiguous") {
            return [
              `local model switch plan - "${name}" matches more than one model`,
              "",
              "  candidates:",
              ...pick.candidates.map((candidate) => `    ${candidate}`),
              "",
              "  type more of the name (the folder or the file) so the choice is unambiguous.",
            ].join("\n");
          }
          const context = contextFor(pick.unit?.entry ?? null, contextArg, view.config.planContext);
          return planLines({ ...view, pick, context }).join("\n");
        },
      };
    },

    tools(ctx) {
      const config = configOf(ctx.config ?? {});
      return [
        {
          name: "local_model_switch_plan",
          description:
            "Plan a local llama.cpp model switch without performing one: the exact llama-server command, the GiB it needs resident, and a verdict (fits now / fits when idle / will not fit / unknown). Refuses while the server is generating and for a model that does not fit the card. It never starts, stops or kills anything.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "A catalog id (qwen3.8-27b), a GGUF file name, or a path under the models folder." },
              context: { type: "number", description: "Optional context in tokens to plan for; defaults to the catalog's serveContext." },
            },
            required: ["model"],
          },
          async run(args) {
            const { catalog, error: catalogError } = catalogOf();
            const { hardware } = hardwareOf(config);
            const { files } = scanOf(config);
            const server = await probeServer({ baseUrl: config.baseUrl, fetchImpl, timeoutMs: config.timeoutMs });
            const view = { config, catalog, catalogError, hardware, files, server };
            const pick = pickModel(args?.model, { catalog, files });
            if (pick.kind === "empty") {
              return 'no model was named. Pass a catalog id (qwen3.8-27b), a GGUF file name or a path under the models folder. Nothing was guessed and nothing was started.';
            }
            if (pick.kind === "unknown") {
              return `no local model matches "${args?.model}". Closest: ${pick.candidates.join("; ") || "nothing on disk or in the catalog"}. Nothing was guessed and nothing was started.`;
            }
            if (pick.kind === "ambiguous") {
              return `"${args?.model}" matches more than one model: ${pick.candidates.join("; ")}. Type more of the name. Nothing was started.`;
            }
            const context = contextFor(pick.unit?.entry ?? null, args?.context, config.planContext);
            return planLines({ ...view, pick, context }).join("\n");
          },
        },
      ];
    },

    // Static on purpose: a status hook that probed the GPU or the server would make
    // loading the harness depend on the card being idle.
    status(ctx) {
      const config = configOf(ctx.config ?? {});
      return `plans a llama-server switch on ${config.host}:${config.port} from ${config.dirs.join(", ")} - never starts or stops one`;
    },
  };
}

export default createLocalSwitch();
