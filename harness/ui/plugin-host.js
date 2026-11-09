// The app's side of the plugin bridge (the page's side is plugin-sdk.js).
//
// One module mounts a plugin page, and both the app and the verifier use it, so what the
// verifier tests is exactly what runs in the window:
//
//   const handle = mountPlugin({ container, plugin, onReport, onReady, compose, saveFile });
//   await handle.runTests();     // the plugin's own Rosalena.test() list
//   handle.destroy();
//
// The frame is sandboxed without allow-same-origin, so the page cannot touch this
// document; the only thing it can do is post messages, and every message is checked here:
// it must come from that frame, name a method this bridge knows, and the plugin's manifest
// must have declared the permission the method needs. Anything else is refused with a
// reason the plugin can read.

export const SANDBOX = "allow-scripts allow-downloads allow-pointer-lock";

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/-]+\))$/i;
const LENGTH = /^\d{1,2}(\.\d+)?px$/;
const FONT = /^[\w\s"',.-]{1,200}$/;

/** Every app setting a plugin may change, and what a valid value looks like. */
export const THEME_TOKENS = Object.freeze({
  bg: COLOR,
  panel: COLOR,
  line: COLOR,
  "line-soft": COLOR,
  text: COLOR,
  dim: COLOR,
  accent: COLOR,
  "accent-soft": COLOR,
  ok: COLOR,
  warn: COLOR,
  bad: COLOR,
  live: COLOR,
  "btn-ink": COLOR,
  radius: LENGTH,
  "radius-sm": LENGTH,
  "radius-xs": LENGTH,
  sans: FONT,
  mono: FONT,
});

const METHODS = {
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.remove": "storage",
  "storage.keys": "storage",
  "files.save": "files.save",
  "chat.compose": "chat.compose",
  "theme.set": "theme",
  "theme.reset": "theme",
  "theme.get": "theme",
  "appearance.get": "appearance",
  "appearance.set": "appearance",
};

const STORAGE_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 200 * 1024 * 1024;
const THEME_KEY = "rosalena.pluginTheme";

const safeStorage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    window.localStorage.setItem(key, value);
  },
  remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nothing saved, nothing to remove */
    }
  },
};

/** Check a theme from a plugin. Returns { tokens } or throws with the first bad entry. */
export function checkTheme(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("theme.set needs an object of tokens");
  const tokens = {};
  for (const [name, value] of Object.entries(input)) {
    const rule = THEME_TOKENS[name];
    if (!rule) throw new Error(`"${name}" is not a theme token (allowed: ${Object.keys(THEME_TOKENS).join(", ")})`);
    const text = String(value).trim();
    if (!rule.test(text)) throw new Error(`"${text}" is not a valid value for ${name}`);
    tokens[name] = text;
  }
  return tokens;
}

/**
 * The app's in-between shades, worked out from the tokens a plugin may set. A plugin only
 * gets the main palette; without these the app's second-level surfaces (raised panels,
 * secondary text, the powder and blonde chips) would keep the default teal under every
 * skin. They follow the palette through var(), so a later theme.set moves them too.
 */
const DERIVED = Object.freeze({
  "bg-2": "color-mix(in srgb, var(--bg) 82%, var(--panel))",
  "panel-2": "color-mix(in srgb, var(--panel) 94%, var(--text))",
  "panel-3": "color-mix(in srgb, var(--panel) 88%, var(--text))",
  "text-2": "color-mix(in srgb, var(--text) 80%, var(--dim))",
  "dim-2": "color-mix(in srgb, var(--dim) 80%, var(--bg))",
  "accent-2": "color-mix(in srgb, var(--accent) 80%, var(--text))",
  powder: "var(--accent)",
  "powder-soft": "var(--accent-soft)",
  blonde: "var(--warn)",
  "blonde-soft": "color-mix(in srgb, var(--warn) 16%, var(--panel))",
});

export function applyTheme(tokens, root = document.documentElement) {
  for (const name of [...Object.keys(THEME_TOKENS), ...Object.keys(DERIVED)]) root.style.removeProperty(`--${name}`);
  const entries = Object.entries(tokens ?? {});
  for (const [name, value] of entries) root.style.setProperty(`--${name}`, value);
  if (entries.length) for (const [name, value] of Object.entries(DERIVED)) root.style.setProperty(`--${name}`, value);
}

// The app's own sidebar plugins took rosa- names on 2026-11-08. A theme saved by one of them
// under its old name ("style-lab") still belongs to it, so Style Lab keeps showing its skin.
const RENAMED_THEME_OWNERS = new Set(["style-lab", "fuyu", "paper-reader", "poster-studio", "transformer-3d", "video-editor", "world-architecture-3d"]);
const themeOwner = (by) => (typeof by === "string" && RENAMED_THEME_OWNERS.has(by) ? `rosa-${by}` : by ?? null);

/** Put back a theme a plugin set in an earlier session. Called once when the app loads. */
export function restorePluginTheme() {
  try {
    const saved = JSON.parse(safeStorage.get(THEME_KEY) ?? "null");
    if (saved?.tokens) applyTheme(checkTheme(saved.tokens));
    // Written back under the new name once, so every later read agrees.
    if (saved && themeOwner(saved.by) !== saved.by) safeStorage.set(THEME_KEY, JSON.stringify({ ...saved, by: themeOwner(saved.by) }));
    return saved;
  } catch {
    safeStorage.remove(THEME_KEY);
    return null;
  }
}

export function clearPluginTheme() {
  applyTheme({});
  safeStorage.remove(THEME_KEY);
}

/** The app's current colours, so a plugin can match them. */
export function hostTheme(root = document.documentElement) {
  const css = getComputedStyle(root);
  const read = (name) => css.getPropertyValue(`--${name}`).trim();
  const colors = {};
  for (const name of ["bg", "panel", "line", "text", "dim", "accent", "accent-soft", "ok", "warn", "bad"]) colors[name] = read(name);
  const explicit = root.dataset.theme;
  const mode =
    explicit === "light" || explicit === "dark"
      ? explicit
      : window.matchMedia?.("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  let saved = null;
  try {
    saved = JSON.parse(safeStorage.get(THEME_KEY) ?? "null");
  } catch {
    saved = null;
  }
  return { mode, colors, sans: read("sans"), mono: read("mono"), pluginTheme: themeOwner(saved?.by) };
}

/**
 * Mount one plugin page into `container`.
 *
 * `plugin` is the server's public view ({ id, url, permissions, title }). `verifying`
 * keeps storage in memory and turns files and the chat box into records, so a verify run
 * never writes into the person's real data.
 */
export function mountPlugin({
  container,
  plugin,
  verifying = false,
  onReport = () => {},
  onReady = () => {},
  onCall = () => {},
  compose = () => {},
  saveFile = null,
  onThemeChange = () => {},
  appearance = null,
}) {
  const frame = document.createElement("iframe");
  frame.className = "plugin-frame";
  frame.title = plugin.title ?? plugin.id;
  frame.setAttribute("sandbox", SANDBOX);
  frame.setAttribute("allow", "fullscreen; clipboard-write");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.src = plugin.url;

  const permissions = new Set(plugin.permissions ?? []);
  const storageKey = `rosalena.plugin.${plugin.id}`;
  // The app's own plugins took rosa- names on 2026-11-08 (style-lab -> rosa-style-lab): what
  // one saved under its old name moves to the new one, once, so nothing a person made is lost.
  // Only for plugins that ship with the app, so a plugin someone builds called "rosa-x" never
  // picks up another plugin's data.
  if (!verifying && plugin.source === "bundled" && String(plugin.id).startsWith("rosa-")) {
    try {
      const legacyKey = `rosalena.plugin.${String(plugin.id).slice(5)}`;
      const old = safeStorage.get(legacyKey);
      if (old != null && safeStorage.get(storageKey) == null) safeStorage.set(storageKey, old);
      if (old != null) safeStorage.remove(legacyKey);
    } catch {
      /* storage blocked: the plugin starts empty, as it would anyway */
    }
  }
  const memory = new Map();
  let ready = false;
  let testWaiter = null;
  const reports = [];
  const calls = [];

  const readStore = () => {
    if (verifying) return Object.fromEntries(memory);
    try {
      return JSON.parse(safeStorage.get(storageKey) ?? "{}") ?? {};
    } catch {
      return {};
    }
  };
  const writeStore = (data) => {
    const text = JSON.stringify(data);
    if (text.length > STORAGE_LIMIT) throw new Error(`storage is limited to ${STORAGE_LIMIT / 1024 / 1024} MB per plugin`);
    if (verifying) {
      memory.clear();
      for (const [k, v] of Object.entries(data)) memory.set(k, v);
      return;
    }
    safeStorage.set(storageKey, text);
  };

  const send = (message) => {
    // The frame's origin is opaque, so "*" is the only target that reaches it; what is
    // sent is only ever the answer to that frame's own request.
    frame.contentWindow?.postMessage({ rosalena: 1, ...message }, "*");
  };

  const handlers = {
    "storage.get": ([key]) => readStore()[key] ?? null,
    "storage.set": ([key, value]) => {
      const data = readStore();
      data[key] = value;
      writeStore(data);
      return true;
    },
    "storage.remove": ([key]) => {
      const data = readStore();
      delete data[key];
      writeStore(data);
      return true;
    },
    "storage.keys": () => Object.keys(readStore()),
    "files.save": ([name, dataBase64, type]) => {
      const clean = String(name ?? "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 120) || "file";
      const size = Math.floor((String(dataBase64 ?? "").length * 3) / 4);
      if (size > FILE_LIMIT) throw new Error("files.save is limited to 200 MB");
      if (verifying) return { saved: clean, bytes: size, verifying: true };
      if (saveFile) return saveFile(clean, dataBase64, type);
      const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: String(type || "application/octet-stream") }));
      const a = document.createElement("a");
      a.href = url;
      a.download = clean;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return { saved: clean, bytes: size };
    },
    "chat.compose": ([value]) => {
      const text = String(value ?? "").slice(0, 20_000);
      if (!verifying) compose(text);
      return true;
    },
    "theme.set": ([input]) => {
      const tokens = checkTheme(input);
      if (verifying) return { applied: Object.keys(tokens), verifying: true };
      applyTheme(tokens);
      safeStorage.set(THEME_KEY, JSON.stringify({ by: plugin.id, tokens }));
      onThemeChange();
      return { applied: Object.keys(tokens) };
    },
    "theme.reset": () => {
      if (!verifying) {
        clearPluginTheme();
        onThemeChange();
      }
      return true;
    },
    "theme.get": () => hostTheme(),
    // The app's own look settings (app.js puts the bridge on window.rosalenaAppearance).
    // A verify run reads them but never changes the person's window.
    "appearance.get": () => {
      const bridge = appearance ?? globalThis.rosalenaAppearance;
      if (!bridge) throw new Error("this window has no appearance settings");
      return bridge.get();
    },
    "appearance.set": async ([patch]) => {
      const bridge = appearance ?? globalThis.rosalenaAppearance;
      if (!bridge) throw new Error("this window has no appearance settings");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("appearance.set needs an object like { appearance: { theme: \"dark\" } }");
      if (verifying) return { verifying: true };
      return bridge.set(patch);
    },
  };

  const onMessage = async (event) => {
    if (event.source !== frame.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.rosalena !== 1) return;
    if (msg.kind === "ready") {
      ready = true;
      onReady();
      return;
    }
    if (msg.kind === "report") {
      const entry = { level: msg.level === "csp" ? "csp" : "error", message: String(msg.message ?? "").slice(0, 2000), at: Date.now() };
      reports.push(entry);
      onReport(entry);
      return;
    }
    if (msg.kind === "test-results") {
      testWaiter?.(Array.isArray(msg.results) ? msg.results : []);
      testWaiter = null;
      return;
    }
    if (msg.kind !== "call") return;
    const method = String(msg.method ?? "");
    const needs = METHODS[method];
    let reply;
    if (!needs) reply = { ok: false, error: `unknown method "${method}"` };
    else if (!permissions.has(needs)) reply = { ok: false, error: `this plugin did not ask for the "${needs}" permission in plugin.json` };
    else {
      try {
        reply = { ok: true, result: await handlers[method](Array.isArray(msg.args) ? msg.args : []) };
      } catch (err) {
        reply = { ok: false, error: String(err?.message ?? err) };
      }
    }
    calls.push({ method, ok: reply.ok, error: reply.error ?? null });
    onCall({ method, ...reply });
    send({ kind: "result", id: msg.id, ...reply });
  };

  window.addEventListener("message", onMessage);
  frame.addEventListener("load", () => {
    send({ kind: "hello", id: plugin.id, permissions: [...permissions], theme: hostTheme(), verifying });
  });
  container.append(frame);

  return {
    frame,
    reports,
    calls,
    get ready() {
      return ready;
    },
    /** Run the plugin's own tests. Resolves with [{ name, ok, ms, error? }]. */
    runTests(timeoutMs = 60_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          testWaiter = null;
          reject(new Error(`the plugin's tests did not finish within ${timeoutMs / 1000} s`));
        }, timeoutMs);
        testWaiter = (results) => {
          clearTimeout(timer);
          resolve(results);
        };
        send({ kind: "run-tests" });
      });
    },
    sendTheme() {
      send({ kind: "theme", theme: hostTheme() });
    },
    destroy() {
      window.removeEventListener("message", onMessage);
      frame.remove();
    },
  };
}
