// Window preferences that have to survive a restart: the context window chats are measured
// against, how many steps one message may take, and which sidebar folders are folded.
//
// They live in a file under the data folder, not in the page's localStorage, because the
// desktop app serves the page on a port the OS picks per launch - a new origin every time,
// so anything the page stored itself would be gone on the next start.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What a chat is measured against when nobody has chosen: 64K suits most models in use. */
export const UI_DEFAULT_CONTEXT_WINDOW = 65_536;

/** The picker's choices. A value outside these is still accepted if it is in range. */
export const CONTEXT_WINDOW_CHOICES = Object.freeze([16_384, 32_768, 65_536, 131_072, 200_000, 262_144, 524_288, 1_048_576]);
export const CONTEXT_WINDOW_MIN = 4_096;
export const CONTEXT_WINDOW_MAX = 2_000_000;

/** Steps (model calls) one message may take before the run stops with "max_steps". */
export const UI_DEFAULT_MAX_STEPS = 200;
export const MAX_STEPS_CHOICES = Object.freeze([25, 50, 100, 200, 500]);
export const MAX_STEPS_MIN = 1;
export const MAX_STEPS_MAX = 1000;

/** Minutes one message may run before it stops with "wall_clock". 0 means no time limit. */
export const UI_DEFAULT_MAX_MINUTES = 60;
export const MAX_MINUTES_CHOICES = Object.freeze([15, 30, 60, 120, 0]);
export const MAX_MINUTES_MAX = 1440;

/** What a chat may do without asking (permissions.mjs). */
export const ACCESS_CHOICES = Object.freeze(["full", "workspace", "auto", "read"]);
export const UI_DEFAULT_ACCESS = "workspace";

/**
 * How tool definitions reach the model (tool-loading.mjs): "on-demand" sends one small
 * load_tools tool and adds the rest when a chat asks for them; "all" sends every tool with
 * every request, as the harness always did.
 */
export const TOOL_LOADING_CHOICES = Object.freeze(["on-demand", "all"]);
export const UI_DEFAULT_TOOL_LOADING = "on-demand";

/**
 * Messages typed while a run is going wait in a queue. "one": each is its own turn, sent
 * when the previous one finishes, so two long prompts are not merged into one turn where
 * the model drops half of it, and a /compact can sit between them. "together": everything
 * queued goes as one message when the run ends (Claude Code's behaviour).
 */
export const QUEUE_CHOICES = Object.freeze(["one", "together"]);
export const UI_DEFAULT_QUEUE = "one";

/**
 * The first-run "Set up Rosalena" window: `done` (it ran), `later` (closed with Not now).
 * Unset means it has not been shown yet, so it opens on the next start; Settings opens it
 * again either way.
 */
export const SETUP_CHOICES = Object.freeze(["done", "later"]);

/** A time limit in minutes (0 = none), or null. */
export function cleanMaxMinutes(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > MAX_MINUTES_MAX) return null;
  return number;
}

/** A step limit the harness can use, or null. */
export function cleanMaxSteps(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  if (number < MAX_STEPS_MIN || number > MAX_STEPS_MAX) return null;
  return number;
}

/**
 * Who is using this window and how it looks. Everything here is personal to the machine the
 * app runs on: nothing is sent anywhere, and a fresh install starts from these defaults.
 */
export const ACCENTS = Object.freeze(["cyan", "violet", "rose", "green", "amber"]);
export const TEXT_SIZES = Object.freeze(["small", "normal", "large"]);
export const DENSITIES = Object.freeze(["comfortable", "compact"]);
export const THEMES = Object.freeze(["auto", "dark", "light"]);
/** The colour family under the theme: each has a dark and a light set (ui/themes.css). */
export const PALETTES = Object.freeze(["petrol", "midnight", "graphite", "nord", "dusk", "forest", "mocha"]);
export const DEFAULT_PROFILE = Object.freeze({ name: "", color: "cyan" });
export const DEFAULT_APPEARANCE = Object.freeze({ theme: "auto", palette: "petrol", accent: "cyan", textSize: "normal", density: "comfortable" });
/** Parts of the window a person can hide. All shown by default. */
export const PANEL_SWITCHES = Object.freeze({
  statusbar: true, // the strip along the very bottom (graph, tokens, exits, layout preset)
  messageMeta: true, // the small model/timing line under each answer
  contextMeter: true, // the context gauge next to the composer
  otherHarnesses: true, // the "Other harnesses" section of the chats rail
  inspector: true, // the Files panel on the right
});
const MAX_NAME = 40;

function cleanProfile(value) {
  const out = { ...DEFAULT_PROFILE };
  if (!value || typeof value !== "object") return out;
  if (typeof value.name === "string") out.name = value.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME);
  if (ACCENTS.includes(value.color)) out.color = value.color;
  return out;
}

function cleanAppearance(value) {
  const out = { ...DEFAULT_APPEARANCE };
  if (!value || typeof value !== "object") return out;
  if (ACCENTS.includes(value.accent)) out.accent = value.accent;
  if (TEXT_SIZES.includes(value.textSize)) out.textSize = value.textSize;
  if (DENSITIES.includes(value.density)) out.density = value.density;
  if (THEMES.includes(value.theme)) out.theme = value.theme;
  if (PALETTES.includes(value.palette)) out.palette = value.palette;
  return out;
}

function cleanSwitches(value) {
  const out = { ...PANEL_SWITCHES };
  if (!value || typeof value !== "object") return out;
  for (const key of Object.keys(PANEL_SWITCHES)) if (typeof value[key] === "boolean") out[key] = value[key];
  return out;
}

/**
 * Settings > Notifications: which system notifications the page shows while the window is
 * not focused. `done` a run finished, `failed` a run failed, `approval` a run is waiting
 * for an answer on an approval card. All on by default; the page only fires them when the
 * window is in the background, so a person watching the chat never sees one.
 */
export const NOTIFY_EVENTS = Object.freeze({ done: true, failed: true, approval: true });

function cleanNotify(value) {
  const out = { ...NOTIFY_EVENTS };
  if (!value || typeof value !== "object") return out;
  for (const key of Object.keys(NOTIFY_EVENTS)) if (typeof value[key] === "boolean") out[key] = value[key];
  return out;
}

/**
 * Settings > Generation: what a new message asks the model for. Null means "the run's own
 * default" (4096 output tokens, which the loop raises by itself when a reply is cut off in
 * a tool call; the model's own temperature). The router drops a temperature for a model
 * that refuses sampling settings, so a value here never turns into a 400.
 */
export const MAX_TOKENS_MIN = 256;
export const MAX_TOKENS_MAX = 131_072;
export const MAX_TOKENS_CHOICES = Object.freeze([8192, 16_384, 32_768, 65_536]);
export const TEMPERATURE_MAX = 2;
export const DEFAULT_GENERATION = Object.freeze({ maxTokens: null, temperature: null });

/** An output cap the router can use, or null. */
export function cleanMaxTokens(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < MAX_TOKENS_MIN || number > MAX_TOKENS_MAX) return null;
  return number;
}

/** A temperature from 0 to 2, kept to two decimals, or null. */
export function cleanTemperature(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > TEMPERATURE_MAX) return null;
  return Math.round(number * 100) / 100;
}

function cleanGeneration(value) {
  const out = { ...DEFAULT_GENERATION };
  if (!value || typeof value !== "object") return out;
  out.maxTokens = cleanMaxTokens(value.maxTokens);
  out.temperature = cleanTemperature(value.temperature);
  return out;
}

/**
 * What this install shares with the site (telemetry.mjs): "full", "usage" or "off".
 * Null means "never chosen", which telemetry.mjs reads as its default.
 */
export const SHARING_CHOICES = Object.freeze(["full", "usage", "off"]);

/** At most this many folded-state entries are kept, so the file cannot grow without bound. */
const MAX_COLLAPSED = 500;

export const prefsFile = (home) => join(home, "ui-prefs.json");

/** A context window the harness can use, or null. */
export function cleanContextWindow(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  if (number < CONTEXT_WINDOW_MIN || number > CONTEXT_WINDOW_MAX) return null;
  return number;
}

function cleanCollapsed(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, folded] of Object.entries(value).slice(0, MAX_COLLAPSED)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 200) continue;
    if (folded === true) out[key] = true;
  }
  return out;
}

/** Pinned chats: run ids, newest pin first, at most 100. Anything else is dropped. */
export const MAX_PINNED = 100;
export function cleanPinned(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const id of value) {
    if (typeof id === "string" && /^r-[\w-]{1,80}$/.test(id) && !out.includes(id)) out.push(id);
    if (out.length >= MAX_PINNED) break;
  }
  return out;
}

/** The saved preferences, cleaned. A missing or broken file reads as "nothing saved". */
export function readPrefs(file) {
  const empty = () => ({
    contextWindow: null,
    maxSteps: null,
    maxMinutes: null,
    accessMode: null,
    toolLoading: null,
    queueMode: null,
    setup: null,
    sandbox: null,
    desktop: null,
    sharing: null,
    collapsed: {},
    pinned: [],
    profile: cleanProfile(null),
    appearance: cleanAppearance(null),
    show: cleanSwitches(null),
    notify: cleanNotify(null),
    generation: cleanGeneration(null),
  });
  if (!existsSync(file)) return empty();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      contextWindow: cleanContextWindow(raw?.contextWindow),
      maxSteps: cleanMaxSteps(raw?.maxSteps),
      maxMinutes: cleanMaxMinutes(raw?.maxMinutes),
      accessMode: ACCESS_CHOICES.includes(raw?.accessMode) ? raw.accessMode : null,
      toolLoading: TOOL_LOADING_CHOICES.includes(raw?.toolLoading) ? raw.toolLoading : null,
      queueMode: QUEUE_CHOICES.includes(raw?.queueMode) ? raw.queueMode : null,
      setup: SETUP_CHOICES.includes(raw?.setup) ? raw.setup : null,
      sandbox: typeof raw?.sandbox === "boolean" ? raw.sandbox : null,
      desktop: typeof raw?.desktop === "boolean" ? raw.desktop : null,
      sharing: SHARING_CHOICES.includes(raw?.sharing) ? raw.sharing : null,
      collapsed: cleanCollapsed(raw?.collapsed),
      pinned: cleanPinned(raw?.pinned),
      profile: cleanProfile(raw?.profile),
      appearance: cleanAppearance(raw?.appearance),
      show: cleanSwitches(raw?.show),
      notify: cleanNotify(raw?.notify),
      generation: cleanGeneration(raw?.generation),
    };
  } catch {
    return empty();
  }
}

/**
 * Apply one change from the page and return the new preferences, or throw with a status.
 * `contextWindow: null` clears the choice; `collapsed` is merged key by key, and `false`
 * removes a key (unfolded is the default, so it is not stored).
 */
export function updatePrefs(current, patch) {
  const next = {
    contextWindow: current.contextWindow ?? null,
    maxSteps: current.maxSteps ?? null,
    maxMinutes: current.maxMinutes ?? null,
    accessMode: current.accessMode ?? null,
    toolLoading: current.toolLoading ?? null,
    queueMode: current.queueMode ?? null,
    setup: current.setup ?? null,
    sandbox: current.sandbox ?? null,
    desktop: current.desktop ?? null,
    sharing: current.sharing ?? null,
    collapsed: { ...(current.collapsed ?? {}) },
    pinned: cleanPinned(current.pinned),
    profile: cleanProfile(current.profile),
    appearance: cleanAppearance(current.appearance),
    show: cleanSwitches(current.show),
    notify: cleanNotify(current.notify),
    generation: cleanGeneration(current.generation),
  };
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw Object.assign(new Error("preferences must be a JSON object"), { status: 400 });
  }
  if ("contextWindow" in patch) {
    if (patch.contextWindow === null) next.contextWindow = null;
    else {
      const window = cleanContextWindow(patch.contextWindow);
      if (window === null) {
        throw Object.assign(
          new Error(`contextWindow must be a number of tokens between ${CONTEXT_WINDOW_MIN} and ${CONTEXT_WINDOW_MAX}`),
          { status: 400 },
        );
      }
      next.contextWindow = window;
    }
  }
  if ("maxSteps" in patch) {
    if (patch.maxSteps === null) next.maxSteps = null;
    else {
      const steps = cleanMaxSteps(patch.maxSteps);
      if (steps === null) {
        throw Object.assign(new Error(`maxSteps must be a whole number between ${MAX_STEPS_MIN} and ${MAX_STEPS_MAX}`), { status: 400 });
      }
      next.maxSteps = steps;
    }
  }
  if ("accessMode" in patch) {
    if (patch.accessMode !== null && !ACCESS_CHOICES.includes(patch.accessMode)) {
      throw Object.assign(new Error(`accessMode must be one of ${ACCESS_CHOICES.join(", ")}`), { status: 400 });
    }
    next.accessMode = patch.accessMode;
  }
  if ("toolLoading" in patch) {
    if (patch.toolLoading !== null && !TOOL_LOADING_CHOICES.includes(patch.toolLoading)) {
      throw Object.assign(new Error(`toolLoading must be one of ${TOOL_LOADING_CHOICES.join(", ")}`), { status: 400 });
    }
    next.toolLoading = patch.toolLoading;
  }
  if ("queueMode" in patch) {
    if (patch.queueMode !== null && !QUEUE_CHOICES.includes(patch.queueMode)) {
      throw Object.assign(new Error(`queueMode must be one of ${QUEUE_CHOICES.join(", ")}`), { status: 400 });
    }
    next.queueMode = patch.queueMode;
  }
  if ("setup" in patch) {
    if (patch.setup !== null && !SETUP_CHOICES.includes(patch.setup)) {
      throw Object.assign(new Error(`setup must be one of ${SETUP_CHOICES.join(", ")}`), { status: 400 });
    }
    next.setup = patch.setup;
  }
  if ("sandbox" in patch) {
    if (patch.sandbox !== null && typeof patch.sandbox !== "boolean") {
      throw Object.assign(new Error("sandbox must be true, false or null"), { status: 400 });
    }
    next.sandbox = patch.sandbox;
  }
  if ("desktop" in patch) {
    if (patch.desktop !== null && typeof patch.desktop !== "boolean") {
      throw Object.assign(new Error("desktop must be true, false or null"), { status: 400 });
    }
    next.desktop = patch.desktop;
  }
  if ("sharing" in patch) {
    if (patch.sharing !== null && !SHARING_CHOICES.includes(patch.sharing)) {
      throw Object.assign(new Error(`sharing must be one of ${SHARING_CHOICES.join(", ")}`), { status: 400 });
    }
    next.sharing = patch.sharing;
  }
  if ("maxMinutes" in patch) {
    if (patch.maxMinutes === null) next.maxMinutes = null;
    else {
      const minutes = cleanMaxMinutes(patch.maxMinutes);
      if (minutes === null) {
        throw Object.assign(new Error(`maxMinutes must be a whole number of minutes from 0 (no limit) to ${MAX_MINUTES_MAX}`), { status: 400 });
      }
      next.maxMinutes = minutes;
    }
  }
  if ("collapsed" in patch) {
    if (!patch.collapsed || typeof patch.collapsed !== "object" || Array.isArray(patch.collapsed)) {
      throw Object.assign(new Error("collapsed must be an object of id: true/false"), { status: 400 });
    }
    for (const [key, folded] of Object.entries(patch.collapsed)) {
      if (typeof key !== "string" || key.length === 0 || key.length > 200) continue;
      if (folded === true) next.collapsed[key] = true;
      else delete next.collapsed[key];
    }
    next.collapsed = cleanCollapsed(next.collapsed);
  }
  if ("pinned" in patch) {
    if (!Array.isArray(patch.pinned)) throw Object.assign(new Error("pinned must be a list of chat ids"), { status: 400 });
    next.pinned = cleanPinned(patch.pinned);
  }
  // Profile, appearance and switches merge field by field; an unknown value is refused, not
  // silently dropped, so the page finds out its control and the server disagree.
  const merge = (key, clean, check) => {
    if (!(key in patch)) return;
    const value = patch[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error(`${key} must be an object`), { status: 400 });
    }
    const problem = check(value);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    next[key] = clean({ ...next[key], ...value });
  };
  merge("profile", cleanProfile, (v) =>
    "name" in v && typeof v.name !== "string"
      ? "profile.name must be text"
      : "name" in v && v.name.trim().length > MAX_NAME
        ? `profile.name can be at most ${MAX_NAME} characters`
        : "color" in v && !ACCENTS.includes(v.color)
          ? `profile.color must be one of ${ACCENTS.join(", ")}`
          : null,
  );
  merge("appearance", cleanAppearance, (v) =>
    "accent" in v && !ACCENTS.includes(v.accent)
      ? `appearance.accent must be one of ${ACCENTS.join(", ")}`
      : "textSize" in v && !TEXT_SIZES.includes(v.textSize)
        ? `appearance.textSize must be one of ${TEXT_SIZES.join(", ")}`
        : "density" in v && !DENSITIES.includes(v.density)
          ? `appearance.density must be one of ${DENSITIES.join(", ")}`
          : "theme" in v && !THEMES.includes(v.theme)
            ? `appearance.theme must be one of ${THEMES.join(", ")}`
            : "palette" in v && !PALETTES.includes(v.palette)
              ? `appearance.palette must be one of ${PALETTES.join(", ")}`
              : null,
  );
  merge("show", cleanSwitches, (v) => {
    for (const [key, on] of Object.entries(v)) {
      if (!(key in PANEL_SWITCHES)) return `show.${key} is not a part of the window that can be hidden`;
      if (typeof on !== "boolean") return `show.${key} must be true or false`;
    }
    return null;
  });
  merge("notify", cleanNotify, (v) => {
    for (const [key, on] of Object.entries(v)) {
      if (!(key in NOTIFY_EVENTS)) return `notify.${key} is not a notification Rosalena sends (${Object.keys(NOTIFY_EVENTS).join(", ")})`;
      if (typeof on !== "boolean") return `notify.${key} must be true or false`;
    }
    return null;
  });
  merge("generation", cleanGeneration, (v) => {
    for (const key of Object.keys(v)) if (!(key in DEFAULT_GENERATION)) return `generation.${key} is not a generation setting (maxTokens, temperature)`;
    if ("maxTokens" in v && v.maxTokens !== null && cleanMaxTokens(v.maxTokens) === null) {
      return `generation.maxTokens must be a whole number from ${MAX_TOKENS_MIN} to ${MAX_TOKENS_MAX}, or null for the default`;
    }
    if ("temperature" in v && v.temperature !== null && cleanTemperature(v.temperature) === null) {
      return `generation.temperature must be a number from 0 to ${TEMPERATURE_MAX}, or null for the model's own`;
    }
    return null;
  });
  return next;
}

export function writePrefs(file, prefs) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
}
