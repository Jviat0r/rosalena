/**
 * The model menu: one list a person can pick from.
 *
 * The harness has three sources of models and they must not look like three
 * sources:
 *
 *   - the ROUTER (`router.config.json` -> `models`), which is the curated list a
 *     person should see first, with a human label and a note about cost;
 *   - the router's CLASSES (orchestrate/code/fast/judge), which are not models at
 *     all but failover chains - they are reported separately and never offered
 *     as a model choice;
 *   - the LOCAL llama.cpp server (`/v1/models`), which is the truth about what is
 *     loaded right now and can disagree with any config file.
 *
 * Everything is best-effort. A stopped router or an idle llama.cpp must produce a
 * menu that still works (with "auto"), not an error: the composer's model picker
 * is not a status page and must never block typing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MENU_TIMEOUT_MS = 1500;
export const MENU_TTL_MS = 10_000;

/** "opencode-free/deepseek-v4.1-flash-free" -> provider + model, split at the first slash. */
export function splitTarget(target) {
  const text = String(target ?? "").trim();
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return null;
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

/**
 * A cost label a person can act on.
 *
 * The router's prices are per million tokens in USD; a model with both prices at
 * zero is free, and calling that "free" is more useful than "0.00".
 */
export function costLabel(prices) {
  const inUsd = Number(prices?.in);
  const outUsd = Number(prices?.out);
  if (!Number.isFinite(inUsd) || !Number.isFinite(outUsd)) return null;
  if (inUsd === 0 && outUsd === 0) return "free";
  return `$${inUsd}/$${outUsd} per Mtok`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Turn the router's curated list into menu entries.
 *
 * A model the router does not know is dropped rather than shown disabled: a
 * picker whose items fail on click is worse than a shorter list.
 */
export function fromRouter(routerConfig, roles = {}) {
  const providers = routerConfig?.providers ?? {};
  const out = [];
  const declared = new Set();
  // A class that carries its own system prompt is a MODEL, not just a failover chain: it
  // answers differently from the target underneath it, so hiding it in the roles list would
  // make "Rosalena" the one thing in this app nobody can select. These rows come first
  // because they are the product's own models, and the class id is the wire id - the router
  // resolves it to the chain and injects the prompt server-side.
  for (const [id, spec] of Object.entries(routerConfig?.classes ?? {})) {
    // Live status reports `custom: true` (a boolean, never the path); the config file on disk
    // reports `systemPromptFile`. Either spelling means the same thing: this class speaks.
    if (!spec?.custom && !spec?.systemPromptFile) continue;
    const preset = roles?.[id] ?? {};
    // The product's own model is spelled Rosalena, capital R, in every surface. A preset
    // with no title (a hand-trimmed roles.json) must not fall back to the wire id and put
    // a lower-case "rosalena" in the picker.
    const fallback = String(id).toLowerCase() === "rosalena" ? "Rosalena" : id;
    const title = String(preset.title ?? preset.label ?? preset.name ?? "").trim() || fallback;
    declared.add(id);
    out.push({
      id,
      label: title,
      provider: id,
      model: id,
      source: "router",
      kind: "chat",
      chat: true,
      tags: ["custom", "free"],
      note: `custom model - ${title}'s own system prompt, applied by the router and never shown`,
      cost: "free",
      efforts: [],
      available: true,
    });
  }
  for (const entry of asArray(routerConfig?.models)) {
    const target = String(entry?.target ?? "").trim();
    const split = splitTarget(target);
    if (!split) continue;
    declared.add(target);
    // A model's own row (Claude models differ 40x in price) wins over the provider's.
    const spec = providers[split.provider];
    const row = modelRow(spec, split.model);
    out.push({
      id: target,
      label: String(entry?.label ?? "").trim() || split.model,
      provider: split.provider,
      model: split.model,
      source: "router",
      tags: asArray(entry?.tags).map(String),
      note: entry?.note ? String(entry.note) : null,
      cost: costLabel(row?.prices ?? spec?.prices),
      efforts: effortsOf(row?.efforts ? row : spec),
      defaultEffort: defaultEffortOf(row, spec),
      available: true,
    });
  }
  // A provider can be trusted to answer for its own models even when the curated
  // list forgot one; surfacing it costs nothing and avoids a "where is my model"
  // hunt. `modelsExtra` is the router's own escape hatch, not a second source.
  for (const [provider, spec] of Object.entries(providers)) {
    // A provider's models are plain ids or `{id, label}` objects (opencode-free, omniroute).
    for (const raw of asArray(spec?.models)) {
      const id = typeof raw === "string" ? raw : String(raw?.id ?? "").trim();
      if (!id) continue;
      const target = `${provider}/${id}`;
      if (declared.has(target)) continue;
      declared.add(target);
      out.push({
        id: target,
        label: String((typeof raw === "object" && raw?.label) || id),
        provider,
        model: String(id),
        source: "router",
        tags: [],
        note: null,
        cost: costLabel((typeof raw === "object" && raw?.prices) || spec?.prices),
        efforts: effortsOf(typeof raw === "object" && raw?.efforts ? raw : spec),
        defaultEffort: defaultEffortOf(modelRow(spec, String(id)) ?? (typeof raw === "object" ? raw : null), spec),
        available: true,
      });
    }
  }
  return out;
}

/**
 * The reasoning efforts a provider declares, or an empty list.
 *
 * This is the provider's word, not a guess: the router drops `reasoning_effort` for a
 * provider that does not declare the vocabulary, so a picker offering effort where this
 * list is empty would be offering a switch that does nothing.
 */
/** A provider's own row for one model (`{id, prices, efforts...}`), when it has one. */
function modelRow(spec, id) {
  // The live router reports these as `modelInfo` (its /admin/status); a config read from
  // disk has them on the provider's `models` rows.
  const live = spec?.modelInfo?.[id];
  if (live && typeof live === "object") return live;
  return asArray(spec?.models).find((raw) => raw && typeof raw === "object" && raw.id === id) ?? null;
}

/**
 * What "Default" means for a model when no effort is sent: a level ("medium" on Claude
 * Opus 5.5, "high" on Sonnet 5.5), "off" where no effort means no thinking (the local
 * model), or null when the provider does not say. The model's own row wins.
 */
export function defaultEffortOf(row, spec) {
  const KNOWN = ["low", "medium", "high", "xhigh", "max", "off"];
  // A model that says `defaultEffort: null` takes no effort at all (Z.AI's free GLM-4.7
  // Flash beside GLM-5.3): its provider's default must not show up as its own.
  if (row && typeof row === "object" && row.defaultEffort === null) return null;
  for (const value of [row?.defaultEffort, spec?.defaultEffort]) {
    if (KNOWN.includes(String(value ?? ""))) return String(value);
  }
  return null;
}

export function effortsOf(spec) {
  const KNOWN = ["low", "medium", "high", "xhigh", "max"];
  return asArray(spec?.efforts)
    .map((value) => String(value))
    .filter((value) => KNOWN.includes(value));
}

/** Classes are failover chains, not models. They get their own field on purpose. */
export function rolesFromRouter(routerConfig, roles = {}) {
  const classes = routerConfig?.classes ?? {};
  return Object.entries(classes).map(([id, spec]) => {
    const preset = roles?.[id] ?? {};
    return {
      id,
      chain: asArray(spec?.chain).map(String),
      // A role's meaning lives in the harness (roles.json), not in the router. The
      // first three spellings are accepted because the file is hand-edited and a
      // person who writes "label" should not get a blank dropdown.
      title: String(preset.title ?? preset.label ?? preset.name ?? "").trim() || id,
      addendum: String(preset.addendum ?? ""),
      subagent: String(preset.subagent ?? "").trim() || null,
      judge: preset.judge === true,
      // A role's opinion about how hard to think, when it has one. Read as "no opinion"
      // for anything outside the vocabulary, because this file is hand-edited and a typo
      // must not take the composer down - the router would drop the field anyway, but a
      // wrong value reaching a request is still a wrong request.
      effort: ["low", "medium", "high", "xhigh", "max"].includes(String(preset.effort ?? "").trim())
        ? String(preset.effort).trim()
        : null,
    };
  });
}

/**
 * What a model can actually do.
 *
 * A llama.cpp host can advertise everything it holds, and a machine that renders video
 * also holds video models - which cannot answer a chat. Offering them in a chat picker
 * is a footgun: the dropdown looks complete and the request fails. So a kind is derived
 * from the name, and only `chat` entries reach the picker.
 */
const KINDS = [
  { kind: "video", re: /(^|[-_/])(ltxv|ltx-?v\d|wan\d|hunyuanvideo|cogvideo|svd|animatediff|mochi|movie)/i },
  { kind: "image", re: /(image|flux|sdxl|sd3|stable-diffusion|kolors|playground|diffusion)/i },
  { kind: "audio", re: /(music|audio|whisper|tts|voice|ace-step|vocoder|rvc)/i },
];

/** "ltxv23-uncensored" -> "video", "qwen3.8-27b" -> "chat". */
export function modelKind(name) {
  const text = String(name ?? "");
  return KINDS.find((entry) => entry.re.test(text))?.kind ?? "chat";
}

/**
 * Drop a `-2`-style duplicate when the same model is also advertised without the suffix.
 *
 * The suffix is an artefact of how a host de-duplicates its own directory listing, not a
 * second model, and two identical dropdown rows is the kind of detail that makes a
 * picker feel untrustworthy.
 */
export function dedupeLocal(models) {
  const names = asArray(models)
    .map((m) => (typeof m === "string" ? m : String(m?.id ?? "")))
    .filter(Boolean);
  const have = new Set(names);
  return names.filter((name) => {
    const match = /^(.*)-(\d+)$/.exec(name);
    return !(match && have.has(match[1]));
  });
}

/** llama.cpp reports ids that may already carry a prefix; the target needs exactly one slash. */
export function fromLocalModels(models, { provider = "local", spec = null } = {}) {
  return dedupeLocal(models).map((raw) => {
    const name = raw.startsWith(`${provider}/`) ? raw.slice(provider.length + 1) : raw;
    if (!name) return null;
    const kind = modelKind(name);
    return {
      id: `${provider}/${name}`,
      label: name,
      provider,
      model: name,
      source: "local",
      kind,
      // Only a chat model may be pinned to a chat. The rest are still listed (they are
      // real, they are on the machine) but the picker leaves them out.
      chat: kind === "chat",
      tags: ["local", "free"],
      note: kind === "chat" ? "served by llama.cpp on this machine" : `${kind} model - not a chat model`,
      cost: "free",
      // The local provider's own effort words (low/medium/high, and "off" for Default:
      // no effort means no thinking there), so the picker offers only what it takes.
      ...(spec ? { efforts: effortsOf(spec), defaultEffort: defaultEffortOf(null, spec) } : {}),
      available: true,
    };
  }).filter(Boolean);
}

/** Every entry, router list first, one entry per target id, local ones merged in. */
export function mergeMenu({ routerModels = [], localModels = [] } = {}) {
  const seen = new Set();
  const out = [];
  for (const entry of [...routerModels, ...localModels]) {
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  // Chat models first, so the top of a long dropdown is the part that can answer.
  return out.sort((a, b) => Number(b.chat !== false) - Number(a.chat !== false));
}

async function fetchJson(url, { headers = {}, timeoutMs = MENU_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return { ok: false, status: 0, error: aborted ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Read `models` and `classes` off disk. A missing config is not an error worth throwing. */
export function readRouterConfig(root) {
  const candidates = [join(root, "router", "router.config.json"), join(root, "..", "router", "router.config.json")];
  for (const file of candidates) {
    try {
      return { config: JSON.parse(readFileSync(file, "utf8")), file };
    } catch {
      /* try the next */
    }
  }
  return { config: null, file: null };
}

/**
 * True for a base URL that points at this machine. A provider like that serves exactly what
 * is running here right now, so what the config says about it is a claim, not a fact.
 */
export function isLoopbackBase(baseUrl) {
  try {
    const host = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "0.0.0.0" || host === "::1";
  } catch {
    return false;
  }
}

/** Same scheme, host and port; false when either side does not parse. */
export function sameOrigin(a, b) {
  try {
    return new URL(String(a)).origin === new URL(String(b)).origin;
  } catch {
    return false;
  }
}

/**
 * Build the menu from the router (live, then disk) plus the local server.
 *
 * `errors` is deliberately verbose and returned to the client: when a model is
 * missing, "the router answered 503" is the whole answer to the user's question.
 */
export async function loadModelMenu({
  routerBase = process.env.ROSALENA_ROUTER_URL ?? "http://127.0.0.1:8077",
  localBase = process.env.ROSALENA_LOCAL_URL ?? "http://127.0.0.1:8080",
  routerToken = process.env.ROSALENA_ROUTER_TOKEN ?? "",
  root = process.cwd(),
  roles = null,
  timeoutMs = MENU_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const errors = [];
  const headers = routerToken ? { "x-rosalena-token": routerToken } : {};
  let routerConfig = null;

  // The harness talks to the router at `<base>/v1/chat/completions`, so the configured
  // base usually already ends in `/v1`. Admin routes hang off the root, and appending
  // `/admin/status` to a `/v1` base is a 404 - which looks exactly like a dead router.
  // Stripping one trailing `/v1` is the difference between reading the live config and
  // silently falling back to the file.
  const adminBase = String(routerBase).replace(/\/+$/, "").replace(/\/v1$/i, "");
  const live = await fetchJson(`${adminBase}/admin/status`, { headers, timeoutMs, fetchImpl });
  if (live.ok) {
    routerConfig = { providers: live.json?.providers ?? {}, classes: live.json?.classes ?? {}, models: live.json?.models ?? [] };
  } else {
    errors.push(`router ${routerBase}: ${live.error}`);
    const disk = readRouterConfig(root);
    if (disk.config) {
      routerConfig = disk.config;
      errors.push(`using ${disk.file} instead`);
    }
  }

  // Read once: both the menu labels (a custom class row is titled by its role) and the
  // roles list need the same hand-edited file.
  const roleMap = roles ?? readRoles(root);
  const local = await fetchJson(`${String(localBase).replace(/\/+$/, "")}/v1/models`, { timeoutMs, fetchImpl });
  const localModels = local.ok
    ? fromLocalModels(local.json?.data ?? local.json?.models ?? local.json, { spec: routerConfig?.providers?.local ?? null })
    : [];
  if (!local.ok) errors.push(`local ${localBase}: ${local.error}`);

  // A curated local target is a claim about the machine, and the machine gets to answer.
  // The config file ships with the developer's own model - label, note and all - so without
  // this filter a build handed to someone else offers a "local" model that was never
  // installed on their PC, and every request to it fails over to a cloud target. The probe
  // above is the only authority on what this PC holds, so a local target it did not report
  // is dropped and named in `errors` instead of being offered.
  //
  // Only the llama.cpp provider is judged by its model list. Another loopback provider is a
  // gateway (OmniRoute on :20128) whose model names are its own routing presets, so llama.cpp
  // never serves them; for a gateway the question is only whether it is running, and any HTTP
  // answer - a 401 for a missing key included - says it is.
  const loopback = Object.entries(routerConfig?.providers ?? {}).filter(([, spec]) => isLoopbackBase(spec?.baseUrl));
  const llamaProviders = new Set(
    loopback.filter(([id, spec]) => id === "local" || sameOrigin(spec?.baseUrl, localBase)).map(([id]) => id),
  );
  const gatewaysDown = new Set();
  for (const [id, spec] of loopback) {
    if (llamaProviders.has(id)) continue;
    const probe = await fetchJson(`${String(spec.baseUrl).replace(/\/+$/, "")}/models`, { timeoutMs, fetchImpl });
    if (probe.status === 0) {
      gatewaysDown.add(id);
      errors.push(`${id} is not running on this PC (${spec.baseUrl}): ${probe.error} - start it to use its models`);
    }
  }
  const served = new Set(localModels.map((entry) => entry.model));
  const notInstalled = [];
  const routerModels = (routerConfig ? fromRouter(routerConfig, roleMap) : []).filter((entry) => {
    if (gatewaysDown.has(entry.provider)) return false;
    if (!llamaProviders.has(entry.provider) || served.has(entry.model)) return true;
    notInstalled.push(entry.id);
    return false;
  });
  if (notInstalled.length) {
    errors.push(`not installed on this PC: ${notInstalled.join(", ")} - put the model where the local server can find it, or pick a cloud model`);
  }

  // Saying this out loud is the difference between "my model is missing" and "that
  // model is a video model": the host advertises what it holds, not what can chat.
  const hidden = localModels.filter((entry) => entry.chat === false).length;
  if (hidden) errors.push(`${hidden} local model(s) are image/video/audio renderers and are not offered for chat`);

  return {
    models: mergeMenu({ routerModels, localModels }),
    roles: routerConfig ? rolesFromRouter(routerConfig, roleMap) : [],
    errors,
    fetchedAt: new Date().toISOString(),
  };
}

/** `data/roles.json` if present; the addenda are user-editable on purpose. */
export function readRoles(root) {
  for (const file of [join(root, "data", "roles.json"), join(root, "..", "data", "roles.json")]) {
    try {
      return JSON.parse(readFileSync(file, "utf8"))?.roles ?? {};
    } catch {
      /* try the next */
    }
  }
  return {};
}

/**
 * A tiny cache so a composer keystroke does not query two servers.
 *
 * Only successes are cached for the full TTL; a failure is retried after one
 * second, because a menu that stays empty for ten seconds after the router comes
 * up looks broken.
 */
export function createMenuCache({ ttlMs = MENU_TTL_MS, failedTtlMs = 1000, now = Date.now } = {}) {
  let entry = null;
  return {
    async get(loader) {
      const at = now();
      if (entry && at - entry.at < (entry.value.errors?.length ? failedTtlMs : ttlMs)) return entry.value;
      const value = await loader();
      entry = { at, value };
      return value;
    },
    clear() {
      entry = null;
    },
  };
}
