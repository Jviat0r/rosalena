// solbrowser - the person's OWN browser for the agent, through SolBrowser
// (Jviat0r/SolBrowserMCP, vendored by packaging/tools/sync-solbrowser.mjs).
//
// Rosalena has two browsers, for two different jobs:
//   browser     (plugins/rosa-browser)  a Chrome on a dedicated, empty profile, for checking
//                                  the agent's own work (localhost, screenshots)
//   solbrowser  (this plugin)      the person's real browser with their logins, through the
//                                  SolBrowser extension: reads pages a plain fetch cannot
//                                  (sign-in walls, client-rendered apps) and acts on them,
//                                  inside cross-origin iframes too
//
// The cheap path stays in-process: web_fetch already runs SolBrowser's HTTP reader and
// says when a page needs a browser. Only then does sol_read_url come in, which tries plain
// HTTP again and escalates to a background tab in the person's browser.
//
// One server process (vendor/bundle/server.mjs: one file, no node_modules), started on the
// first sol_ call, reused while calls keep coming, closed after `idleMinutes` and at exit.
// It uses SolBrowser's usual port and ~/.solbrowser state, so an extension already paired
// with a standalone SolBrowser works here unchanged (servers on one port share it as hub
// and peers). `evaluate` is not offered and is switched off in the server too
// (SOLBROWSER_ALLOW_EVAL=0), so `batch` cannot reach it either: no scripts run in the
// person's logged-in pages.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VENDOR = join(HERE, "vendor");
export const SERVER = join(VENDOR, "bundle", "server.mjs");
const PREFIX = "sol_";

// What the model is offered, and how each is gated. Look tools read only, like web_fetch,
// so workspace mode lets them run; everything that changes a page asks first.
export const LOOK = ["status", "tabs", "read_url", "snapshot"];
export const ACT = ["navigate", "click", "type", "key", "fill_form", "select_option", "scroll", "wait_for", "batch"];

const DEFAULTS = { launchBrowser: true, port: null, stateDir: "", idleMinutes: 10, timeoutMs: 60000 };
let settings = { ...DEFAULTS };
let log = () => {};

export function source() {
  try {
    return JSON.parse(readFileSync(join(VENDOR, "SOURCE.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Where the extension is copied for Load unpacked: a stable path that survives app updates. */
export const extensionHome = (home = process.env.ROSALENA_HOME || join(homedir(), ".rosalena")) => join(home, "solbrowser", "extension");

/**
 * Copy the shipped extension to `extensionHome()` and say how to load it. Re-run after an
 * update to refresh it; the browser picks the new files up on its next start (or Reload on
 * the extensions page). Returns the folder and the steps.
 */
export function prepareExtension({ home } = {}) {
  const target = extensionHome(home);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(VENDOR, "extension"), target, { recursive: true });
  copyFileSync(join(VENDOR, "SOURCE.json"), join(dirname(target), "SOURCE.json"));
  return {
    folder: target,
    version: source()?.version ?? null,
    steps: [
      "Open your browser's extensions page (brave://extensions, chrome://extensions or edge://extensions).",
      "Turn on Developer mode.",
      `Click Load unpacked and choose ${target}.`,
      "The SolBrowser icon connects by itself the next time the agent uses your browser.",
    ],
  };
}

function loadSchemas() {
  try {
    return JSON.parse(readFileSync(join(VENDOR, "tools.json"), "utf8"));
  } catch {
    return [];
  }
}

// The live server: { client, timer } or null.
let live = null;
let starting = null;

async function client() {
  if (live && !live.client.isClosed()) return live.client;
  if (starting) return starting;
  starting = (async () => {
    const { createStdioClient } = await import(pathToFileURL(join(HERE, "..", "rosa-mcp-manager", "plugin.mjs")).href);
    const env = {
      // The packaged app has no separate node: its own binary runs the server as Node.
      ELECTRON_RUN_AS_NODE: "1",
      SOLBROWSER_ALLOW_EVAL: "0",
      SOLBROWSER_LAUNCH_BROWSER: settings.launchBrowser === false ? "0" : "1",
      ...(settings.port ? { SOLBROWSER_PORT: String(settings.port) } : {}),
      ...(settings.stateDir ? { SOLBROWSER_STATE_DIR: settings.stateDir } : {}),
    };
    const c = createStdioClient({ command: process.execPath, args: [SERVER], env, timeoutMs: Number(settings.timeoutMs) || 60000, log });
    await c.initialize();
    live = { client: c, timer: null };
    log(`started SolBrowser ${source()?.version ?? ""} (${SERVER})`);
    return c;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

function touch() {
  if (!live) return;
  clearTimeout(live.timer);
  live.timer = setTimeout(close, (Number(settings.idleMinutes) || 10) * 60_000);
  live.timer.unref?.();
}

export function close() {
  if (!live) return;
  clearTimeout(live.timer);
  live.client.close();
  live = null;
}
process.once("exit", close);

export const NOT_CONNECTED = "[SolBrowser: your browser is not connected]";

const SETUP_HINT =
  "Your browser is not connected to Rosalena yet. Set it up once: Settings > Your browser > Set up, then load the folder it shows as an unpacked extension. Until then, use web_fetch to read public pages, or browser_open for Rosalena's own browser.";

/** Call one SolBrowser tool; the text the model reads. */
export async function call(name, args = {}) {
  let c;
  try {
    c = await client();
  } catch (err) {
    return `error: SolBrowser did not start: ${err?.message ?? err}`;
  }
  touch();
  try {
    const result = await c.callTool(name, args);
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts.map((p) => (p?.type === "text" ? p.text : p?.type ? `[${p.type} content not shown]` : "")).filter(Boolean).join("\n") || "(no output)";
    const body = result?.isError ? `error: ${text}` : text;
    // NOT_CONNECTED leads: the window sees only the first 300 characters of a tool result,
    // and it shows the person a Set up card when a sol_ result starts with it.
    return /NO_EXTENSION|extension is not connected/i.test(body) ? `${NOT_CONNECTED}\n${body}\n\n${SETUP_HINT}` : body;
  } catch (err) {
    if (c.isClosed()) live = null;
    return `error: ${err?.message ?? err}`;
  }
}

const DESCRIBE = {
  status: "Is your own browser connected to Rosalena (SolBrowser), and which tab is current.",
  read_url:
    "Read a page in YOUR OWN browser with your logins (SolBrowser): tries plain HTTP first, then a background tab, so sign-in walls and client-rendered apps work. Use it when web_fetch says the page needs a browser; for public pages web_fetch is faster.",
};

const plugin = {
  id: "rosa-solbrowser",
  description: "Your own browser for the agent (SolBrowser): read pages with your logins and act on them, inside iframes too",

  async setup(ctx) {
    settings = { ...DEFAULTS, ...(ctx.config ?? {}) };
    log = typeof ctx.log === "function" ? ctx.log : () => {};
    try {
      const permissions = await import(new URL("../../src/permissions.mjs", import.meta.url).href);
      if (typeof permissions.registerWorkspaceTool === "function") for (const name of LOOK) permissions.registerWorkspaceTool(PREFIX + name);
    } catch {
      /* an engine without it: every sol_ tool asks once per chat */
    }
  },

  tools(ctx) {
    settings = { ...DEFAULTS, ...(ctx.config ?? {}) };
    if (!existsSync(SERVER)) return [];
    const byName = new Map(loadSchemas().map((t) => [t.name, t]));
    return [...LOOK, ...ACT]
      .filter((name) => byName.has(name))
      .map((name) => {
        const t = byName.get(name);
        const description = DESCRIBE[name] ?? `In your own browser (SolBrowser, your logins and tabs): ${t.description}`;
        return { name: PREFIX + name, description, parameters: t.inputSchema, run: (args = {}) => call(name, args) };
      });
  },

  hooks() {
    return { onRunEnd: () => touch() };
  },

  status() {
    const s = source();
    return `${live ? "running" : "not started (starts on the first sol_ call)"}; SolBrowser ${s?.version ?? "?"} @ ${String(s?.commit ?? "").slice(0, 7)}; extension folder ${extensionHome()}`;
  },
};

export default plugin;
