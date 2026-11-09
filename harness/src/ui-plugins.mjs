// UI plugins: plugins that draw a page of their own inside the app.
//
// A backend plugin (plugins.mjs) adds tools, commands and hooks to the agent. A UI plugin
// adds a page: a Poster Studio, a 3D model of a transformer, a paper reader. Both are the
// same folder with the same plugin.json; the `ui` block is what makes one a page:
//
//   {
//     "id": "rosa-poster-studio", "version": "1.0.0", "description": "...",
//     "ui": {
//       "title": "Poster Studio",          // the sidebar label
//       "icon": "icon.svg",                // optional, inside the folder
//       "page": "app/index.html",          // the page, inside the folder
//       "permissions": ["storage", "files.save"],
//       "libs": ["three"]                  // shared libraries from harness/plugin-libs
//     }
//   }
//
// A plugin page is someone else's code running next to the person's chats, so it gets as
// little as possible and the rest is enforced, not requested:
//
//   - it runs in an iframe with `sandbox="allow-scripts allow-downloads"` and no
//     allow-same-origin, so its origin is opaque: it cannot read the app's DOM, cookies or
//     storage, and the API's same-origin check refuses every request it makes
//   - every file is served with a CSP that allows its own folder, the libraries and the
//     SDK, and nothing else: no other plugin's files, no /api, no network at all
//   - what it may ask the app for goes through one postMessage bridge (plugin-host.js),
//     and the bridge refuses a call the manifest did not declare
//
// Plugins come from two places: the ones that ship with the app (harness/plugins, marked
// `"bundled": true`) and the ones Creator mode installed (<ROSALENA_HOME>/plugins). A
// user plugin may not take a bundled plugin's id: a page that replaced the paper reader
// under the same name would be a quieter attack than a new one.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renamePluginKeys } from "./plugin-names.mjs";

export const UI_PERMISSIONS = Object.freeze({
  storage: "keep its own small saved data (up to 2 MB, kept apart from every other plugin)",
  "files.save": "hand you a file to save (a poster, a video, notes)",
  "chat.compose": "put text into the chat box for you to send (it never sends on its own)",
  theme: "change the app's colours, corners and fonts (from a fixed list of settings)",
  appearance: "change the app's own look settings (light or dark, palette, accent, text size, density) and which parts of the window are shown",
});

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** What a plugin folder may contain, and the type each file is served as. */
export const PLUGIN_MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
});

export const PLUGIN_LIBS_DIR = fileURLToPath(new URL("../plugin-libs/", import.meta.url));
export const BUNDLED_PLUGINS_DIR = fileURLToPath(new URL("../plugins/", import.meta.url));
export const SDK_FILE = fileURLToPath(new URL("../ui/plugin-sdk.js", import.meta.url));

/** Where Creator mode installs plugins: <home>/plugins. */
export function userPluginsDir(home) {
  return join(home, "plugins");
}

const reasonOf = (err) => (err instanceof Error ? err.message : String(err));

/** A path inside `folder`, or null when it is absolute, empty or escapes it. */
export function insideFolder(folder, rel) {
  const text = String(rel ?? "").replace(/\\/g, "/").trim();
  // A drive letter (C:/...) is refused on every platform, not only on Windows: a plugin is
  // written once and runs anywhere, and on Linux that path would quietly mean a folder named "C:".
  if (!text || isAbsolute(text) || text.startsWith("/") || /^[a-z]:/i.test(text) || /(^|\/)\.\.(\/|$)/.test(text) || text.includes("\0")) return null;
  const full = resolve(folder, normalize(text));
  const back = relative(resolve(folder), full);
  if (!back || back.startsWith("..") || isAbsolute(back)) return null;
  return full;
}

/** The shared libraries: name -> { name, version, files }. */
export function knownLibs(dir = PLUGIN_LIBS_DIR) {
  const libs = new Map();
  if (!existsSync(dir)) return libs;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, entry.name, "lib.json"), "utf8"));
      const files = Array.isArray(meta.files) ? meta.files.map(String) : [];
      libs.set(entry.name, { name: entry.name, version: String(meta.version ?? ""), files });
    } catch {
      /* a folder without a readable lib.json is not a library */
    }
  }
  return libs;
}

/**
 * Read and check a UI plugin's manifest. Returns `{ manifest, problems }`: `manifest` is
 * null when the folder is not a UI plugin at all, and `problems` lists every rule it
 * breaks (empty means it can be listed and served).
 */
export function readUiManifest(folder, { libs = knownLibs() } = {}) {
  const problems = [];
  const file = join(folder, "plugin.json");
  if (!existsSync(file)) return { manifest: null, problems: ["plugin.json is missing"] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { manifest: null, problems: [`plugin.json is not valid JSON: ${reasonOf(err)}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { manifest: null, problems: ["plugin.json must be a JSON object"] };
  }
  if (!parsed.ui) return { manifest: null, problems: [] };
  const ui = parsed.ui;
  if (typeof ui !== "object" || Array.isArray(ui)) return { manifest: null, problems: ['"ui" must be an object'] };

  const id = String(parsed.id ?? "").trim();
  if (!PLUGIN_ID_PATTERN.test(id)) problems.push(`id "${id}" must be 2-41 characters of a-z, 0-9 and "-", starting with a letter or digit`);
  const version = String(parsed.version ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`version "${version}" must look like 1.0.0`);
  const title = String(ui.title ?? "").trim();
  if (!title || title.length > 40) problems.push("ui.title is required and at most 40 characters");
  const page = String(ui.page ?? "index.html");
  const pagePath = insideFolder(folder, page);
  if (!pagePath) problems.push(`ui.page "${page}" must be a path inside the plugin folder`);
  else if (!existsSync(pagePath)) problems.push(`ui.page "${page}" does not exist`);
  else if (extname(pagePath).toLowerCase() !== ".html") problems.push(`ui.page "${page}" must be an .html file`);
  let icon = ui.icon == null ? null : String(ui.icon);
  if (icon) {
    const iconPath = insideFolder(folder, icon);
    if (!iconPath || !existsSync(iconPath) || ![".svg", ".png"].includes(extname(iconPath).toLowerCase())) {
      problems.push(`ui.icon "${icon}" must be an .svg or .png inside the plugin folder`);
      icon = null;
    }
  }
  const permissions = Array.isArray(ui.permissions) ? ui.permissions.map(String) : [];
  for (const p of permissions) if (!(p in UI_PERMISSIONS)) problems.push(`unknown permission "${p}" (known: ${Object.keys(UI_PERMISSIONS).join(", ")})`);
  const wanted = Array.isArray(ui.libs) ? ui.libs.map(String) : [];
  for (const lib of wanted) if (!libs.has(lib)) problems.push(`unknown library "${lib}" (known: ${[...libs.keys()].join(", ") || "none"})`);

  return {
    manifest: {
      id,
      version,
      description: String(parsed.description ?? ""),
      bundled: parsed.bundled === true,
      enabled: parsed.enabled !== false,
      title,
      page: page.replace(/\\/g, "/"),
      icon: icon ? icon.replace(/\\/g, "/") : null,
      permissions: [...new Set(permissions)].filter((p) => p in UI_PERMISSIONS),
      libs: [...new Set(wanted)],
      folder,
      hasBackend: existsSync(join(folder, String(parsed.entry ?? "plugin.mjs"))),
    },
    problems,
  };
}

function scanDir(dir, source, libs) {
  const found = [];
  if (!dir || !existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folder = join(dir, entry.name);
    if (!existsSync(join(folder, "plugin.json"))) continue;
    const { manifest, problems } = readUiManifest(folder, { libs });
    if (!manifest) continue;
    found.push({ ...manifest, source, problems });
  }
  return found;
}

/**
 * Every UI plugin, bundled first, then the person's own. `state` is Creator mode's
 * on/off record (creator.mjs), so a plugin switched off there is listed as disabled
 * rather than vanishing - the switch has to be findable to be undone.
 */
export function listUiPlugins({ bundledDir = BUNDLED_PLUGINS_DIR, userDir = null, state = {}, config = {}, libs = knownLibs() } = {}) {
  const bundled = scanDir(bundledDir, "bundled", libs);
  const ids = new Set(bundled.map((p) => p.id));
  const user = scanDir(userDir, "user", libs).map((p) =>
    ids.has(p.id) ? { ...p, problems: [...p.problems, `the id "${p.id}" belongs to a plugin that ships with the app`] } : p,
  );
  // Switches and config saved under a plugin's name from before the rosa- rename still count.
  const configured = renamePluginKeys(config?.plugins ?? {});
  const switches = renamePluginKeys(state ?? {});
  return [...bundled, ...user].map((p) => {
    const override = configured?.[p.id]?.enabled;
    const switched = switches?.[p.id]?.enabled;
    const enabled = p.enabled && override !== false && switched !== false;
    return { ...p, enabled, ok: p.problems.length === 0 };
  });
}

/** What the page is told about one plugin: no folder paths. */
export function publicView(plugin) {
  const base = `/plugin-app/${plugin.id}/`;
  return {
    id: plugin.id,
    version: plugin.version,
    title: plugin.title,
    description: plugin.description,
    source: plugin.source,
    enabled: plugin.enabled,
    ok: plugin.ok,
    problems: plugin.problems,
    permissions: plugin.permissions,
    permissionText: plugin.permissions.map((p) => UI_PERMISSIONS[p]),
    libs: plugin.libs,
    url: base + plugin.page,
    icon: plugin.icon ? base + plugin.icon : null,
  };
}

/**
 * The Content-Security-Policy a plugin page runs under. `origin` is the server's own
 * origin as the frame sees it; every allowed source is a path on it, so a plugin can load
 * its own files, the libraries and the SDK, and nothing else - including /api.
 */
export function pluginCsp(origin, id) {
  const own = `${origin}/plugin-app/${id}/`;
  const libs = `${origin}/plugin-lib/`;
  const sdk = `${origin}/plugin-sdk.js`;
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${own} ${libs} ${sdk} blob:`,
    `style-src 'unsafe-inline' ${own}`,
    `img-src ${own} data: blob:`,
    `media-src ${own} data: blob:`,
    `font-src ${own} data:`,
    `connect-src ${own} ${libs} data: blob:`,
    "worker-src blob:",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Serve plugin files, library files and the SDK. Returns true when it handled the
 * request. `plugins` is the current listUiPlugins() result; a disabled or broken plugin
 * is not served at all, so switching one off takes effect on the next load.
 *
 * Every response allows any origin to read it: a sandboxed frame's origin is opaque, and
 * the browser makes a CORS request for its module scripts. These are static plugin files
 * with nothing private in them; the API routes keep their own same-origin check.
 */
export async function servePluginRequest(req, res, path, { plugins = [], libsDir = PLUGIN_LIBS_DIR, sdkFile = SDK_FILE, libs = knownLibs(libsDir) } = {}) {
  const send = (status, body, headers = {}) => {
    res.writeHead(status, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
      ...headers,
    });
    res.end(body);
    return true;
  };
  const notFound = (why) => send(404, `${why}\n`, { "content-type": "text/plain; charset=utf-8" });

  if (path === "/plugin-sdk.js") {
    return send(200, await readFile(sdkFile), { "content-type": PLUGIN_MIME[".js"] });
  }

  if (path.startsWith("/plugin-lib/")) {
    const [name, ...rest] = path.slice("/plugin-lib/".length).split("/");
    const lib = libs.get(decodeURIComponent(name ?? ""));
    const file = decodeURIComponent(rest.join("/"));
    if (!lib || !lib.files.includes(file)) return notFound("no such library file");
    const full = insideFolder(join(libsDir, lib.name), file);
    if (!full || !existsSync(full)) return notFound("no such library file");
    return send(200, await readFile(full), { "content-type": PLUGIN_MIME[extname(full).toLowerCase()] ?? "application/octet-stream" });
  }

  if (path.startsWith("/plugin-app/")) {
    const [rawId, ...rest] = path.slice("/plugin-app/".length).split("/");
    const id = decodeURIComponent(rawId ?? "");
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) return notFound("no such plugin");
    if (!plugin.ok) return notFound(`plugin ${id} is broken: ${plugin.problems.join("; ")}`);
    if (!plugin.enabled) return notFound(`plugin ${id} is switched off`);
    const rel = decodeURIComponent(rest.join("/")) || plugin.page;
    const full = insideFolder(plugin.folder, rel);
    const type = full ? PLUGIN_MIME[extname(full).toLowerCase()] : null;
    // plugin.json and backend code are not page assets: the page has no business reading
    // its own manifest, and a backend module is not something a browser should be handed.
    const base = rel.replace(/\\/g, "/").split("/").pop();
    if (!full || !type || base === "plugin.json" || base === "plugin.mjs") return notFound("not a servable plugin file");
    if (!existsSync(full) || !statSync(full).isFile()) return notFound("no such file");
    const host = String(req.headers.host ?? "127.0.0.1");
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    return send(200, await readFile(full), {
      "content-type": type,
      "content-security-policy": pluginCsp(`${proto}://${host}`, id),
    });
  }

  return false;
}

/** Files of a plugin folder, relative and with forward slashes, for checks and hashing. */
export function pluginFiles(folder) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(folder, full).split(sep).join("/"));
    }
  };
  if (existsSync(folder)) walk(folder);
  return out.sort();
}
