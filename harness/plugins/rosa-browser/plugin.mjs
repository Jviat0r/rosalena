// browser - a real Chrome/Edge the agent can open, read, click and screenshot, so it can
// check its own work the way OMP, Claude Code, Codex, Cursor and Devin do.
//
// Why a plugin and not an MCP server: mcp-manager spawns a fresh server for every call,
// so a browser MCP loses its page between calls. A plugin runs in the harness process,
// so ONE browser and ONE page persist across tool calls (and across runs in a chat),
// until browser_close, an idle timeout, or the process exits.
//
// Representation (docs/research/agentic-browsers-2026-11.md, sections 0 and 1.2): what
// costs a small model is turns x context, so
//   - snapshots are a compact outline where each actionable element carries a short ref
//     (`[e12] button "Save"`), interactive-only by default
//   - every action returns what changed (a diff of the outline, or the new page's
//     interactive outline after a navigation), so the model needs no extra look turn
//   - browser_read returns main content as markdown, not HTML
//   - screenshots are files for vision models (read_image), never inlined
//   - every output stays under ~4500 characters (the engine clips plugin output at 6000)
//
// Security (section 5): page text is untrusted, so everything that came from a page is
// fenced in nonce-tagged boundary markers; the browser runs on a DEDICATED profile under
// ROSALENA_HOME, never the person's own; downloads are off; file:// is refused outside the
// workspace; uploads only take workspace files (never secret files); the agent never
// types into password fields or types card numbers; an optional domain allowlist blocks
// every request to other hosts.
//
// Frames: same-origin and cross-origin iframes are walked (Playwright reaches every frame
// through CDP); refs inside frame N are prefixed `fN` (`[f1e3]`). Not supported: closed
// shadow roots, canvas/WebGL content (use a screenshot), PDF viewers, and iframes nested
// more than four deep.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { describeField, elementForRef, focusedField, markdownInPage, quietInPage, scrollInPage, snapshotInPage } from "./lib/inpage.mjs";
import { defaultLibDir, defaultProfileDir, ensurePlaywright, launchContext } from "./lib/runtime.mjs";
import {
  BOUNDARY_OVERHEAD,
  SECRET_FILE,
  checkNavigation,
  checkReadable,
  diffLines,
  fitLines,
  hostAllowed,
  insideWorkspace,
  looksLikeCardNumber,
  normalizeUrl,
  parseRef,
  shortError,
  untrusted,
} from "./lib/safety.mjs";

export const DEFAULTS = Object.freeze({
  headless: true,
  idleMinutes: 10,
  allowedDomains: [],
  profileDir: "",
  libDir: "",
  executablePath: "",
  autoInstall: true,
  viewport: { width: 1280, height: 800 },
  maxOutputChars: 4500,
  navTimeoutMs: 30000,
  actionTimeoutMs: 5000,
  registerWorkspaceTools: true,
});

/** Tools that only look (or close our own browser): treated like reads in workspace mode. */
export const LOOK_TOOLS = ["browser_open", "browser_snapshot", "browser_read", "browser_screenshot", "browser_console", "browser_scroll", "browser_close"];
/** Tools that act on a page (submit forms, send data): left to the permission gate. */
export const ACT_TOOLS = ["browser_click", "browser_fill", "browser_select", "browser_press", "browser_upload"];

// --------------------------------------------------------------------------- session

let settings = { ...DEFAULTS };
let ctxRef = null;
let activeRoot = null;
const workspace = () => activeRoot ?? ctxRef?.harness?.workspace ?? ctxRef?.root ?? null;
const log = (m) => {
  try {
    ctxRef?.log?.(m);
  } catch {
    /* logging never breaks a tool */
  }
};

const S = {
  context: null,
  page: null,
  headless: true,
  launching: null,
  executable: "",
  profile: "",
  notes: [], // launch notes, shown once with the next output
  events: [], // dialogs, tabs, downloads, blocked requests: since the last action
  console: [], // { kind, text, where, url }
  inflight: new Map(), // request -> start time
  navSeq: 0,
  mainDocId: null,
  frameNums: new WeakMap(),
  frameByNum: new Map(),
  frameCounter: 0,
  read: null,
  idleTimer: null,
  ownNewPage: false,
};

// One browser, one page: calls are serialized so two tool calls in one step cannot
// interleave their clicks and snapshots.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(() => fn());
  chain = next.catch(() => {});
  return next;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function touch() {
  clearTimeout(S.idleTimer);
  const minutes = Number(settings.idleMinutes);
  if (!(minutes > 0)) return;
  S.idleTimer = setTimeout(() => {
    serial(() => closeSession()).catch(() => {});
  }, minutes * 60_000);
  S.idleTimer.unref?.();
}

function resetState() {
  S.context = null;
  S.page = null;
  S.events = [];
  S.inflight.clear();
  S.mainDocId = null;
  S.frameNums = new WeakMap();
  S.frameByNum = new Map();
  S.frameCounter = 0;
  S.read = null;
}

async function closeSession() {
  clearTimeout(S.idleTimer);
  const context = S.context;
  resetState();
  if (context) await context.close().catch(() => {});
  return Boolean(context);
}

const MAX_CONSOLE = 100;
function pushConsole(entry) {
  S.console.push(entry);
  if (S.console.length > MAX_CONSOLE) S.console.splice(0, S.console.length - MAX_CONSOLE);
}

function wire(page) {
  if (page.__rosalenaWired) return;
  page.__rosalenaWired = true;
  const where = (loc) => (loc?.url ? `${loc.url}${loc.lineNumber != null ? `:${loc.lineNumber + 1}` : ""}` : "");
  page.on("console", (m) => {
    const type = m.type();
    if (type !== "error" && type !== "warning") return;
    // Chrome's own "Failed to load resource" line repeats the http/request entry below.
    if (/^Failed to load resource\b/.test(m.text())) return;
    pushConsole({ kind: type, text: m.text(), where: where(m.location()), url: page.url() });
  });
  page.on("pageerror", (e) => {
    const stack = String(e?.stack ?? "").split("\n").find((l) => /^\s+at /.test(l))?.trim().replace(/^at\s+/, "") ?? "";
    pushConsole({ kind: "exception", text: String(e?.message ?? e), where: stack, url: page.url() });
  });
  page.on("request", (r) => {
    if (!["eventsource", "websocket", "media"].includes(r.resourceType())) S.inflight.set(r, Date.now());
  });
  page.on("requestfinished", (r) => S.inflight.delete(r));
  page.on("requestfailed", (r) => {
    S.inflight.delete(r);
    const failure = r.failure()?.errorText ?? "failed";
    if (/ERR_ABORTED/.test(failure) && r.resourceType() !== "document") return; // cancelled by the page itself
    pushConsole({ kind: "request failed", text: `${r.method()} ${r.url()} (${failure})`, where: "", url: page.url() });
  });
  page.on("response", (res) => {
    if (res.status() < 400 || /\/favicon\.ico(\?|$)/.test(res.url())) return;
    pushConsole({ kind: `http ${res.status()}`, text: `${res.request().method()} ${res.url()}`, where: "", url: page.url() });
  });
  page.on("dialog", (d) => {
    const type = d.type();
    S.events.push(`a ${type} dialog said ${JSON.stringify(String(d.message()).slice(0, 200))}; it was ${type === "beforeunload" ? "accepted" : "dismissed"}`);
    (type === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {});
  });
  page.on("download", (d) => {
    S.events.push(`a download (${d.suggestedFilename()}) was blocked: downloads are off in this browser`);
    d.cancel().catch(() => {});
  });
  page.on("filechooser", () => {
    S.events.push("a file picker opened: attach files with browser_upload {ref, paths} (workspace files only)");
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    S.navSeq += 1;
    const url = frame.url();
    if (/^file:/i.test(url) && !checkReadable(url, { workspace: workspace() }).ok) {
      S.events.push("refused: the page went to a local file outside the workspace, so the browser went back to a blank page");
      page.goto("about:blank").catch(() => {});
    }
  });
  page.on("close", () => {
    if (S.page !== page) return;
    const open = S.context?.pages().filter((p) => !p.isClosed()) ?? [];
    S.page = open.at(-1) ?? null;
    if (S.page) S.events.push(`the tab closed itself; now on ${S.page.url()}`);
  });
}

async function ensure({ headed } = {}) {
  touch();
  const wantHeadless = headed === undefined ? (S.context ? S.headless : settings.headless !== false) : !headed;
  if (S.context && S.headless !== wantHeadless) {
    await closeSession();
    S.notes.push(wantHeadless ? "restarted the browser without a window" : "restarted the browser with a window (same profile, so cookies carry over)");
  }
  if (!S.context) {
    const { pw, note } = await ensurePlaywright({ libDir: settings.libDir || defaultLibDir(), autoInstall: settings.autoInstall !== false });
    if (note) S.notes.push(note);
    const launched = await launchContext(pw, {
      profileDir: settings.profileDir || defaultProfileDir(),
      headless: wantHeadless,
      executablePath: settings.executablePath,
      viewport: settings.viewport,
      log,
    });
    S.context = launched.context;
    S.headless = wantHeadless;
    S.executable = launched.executable;
    S.profile = launched.profile;
    S.notes.push(...launched.notes);
    log(`started ${launched.executable} (${wantHeadless ? "headless" : "headed"}) on ${launched.profile}`);
    const context = launched.context;
    context.setDefaultTimeout(Number(settings.actionTimeoutMs) || 5000);
    context.setDefaultNavigationTimeout(Number(settings.navTimeoutMs) || 30000);
    context.on("page", (p) => {
      wire(p);
      if (S.ownNewPage) return;
      S.page = p;
      S.events.push(`a new tab opened (${p.url() || "loading"}); the browser tools now act on it`);
    });
    context.on("close", () => {
      if (S.context === context) resetState();
    });
    const allowed = Array.isArray(settings.allowedDomains) ? settings.allowedDomains.filter(Boolean) : [];
    if (allowed.length) {
      await context.route("**/*", (route) => {
        const url = route.request().url();
        let host = "";
        try {
          const u = new URL(url);
          if (!/^https?:$/.test(u.protocol)) return route.continue();
          host = u.hostname;
        } catch {
          return route.continue();
        }
        if (hostAllowed(host, allowed)) return route.continue();
        if (route.request().isNavigationRequest()) S.events.push(`blocked a page load from ${host}: not in allowedDomains`);
        return route.abort("blockedbyclient");
      });
    }
    for (const p of context.pages()) wire(p);
    S.page = context.pages()[0] ?? null;
  }
  if (!S.page || S.page.isClosed()) {
    S.ownNewPage = true;
    try {
      S.page = await S.context.newPage();
    } finally {
      S.ownNewPage = false;
    }
    wire(S.page);
  }
  return S;
}

/** The page the tools act on, or a clear error when nothing was opened yet. */
function requirePage() {
  touch();
  if (!S.context || !S.page || S.page.isClosed()) throw new Error("no page is open: call browser_open {url} first");
  return S.page;
}

/** Wait for the page to settle after an action: the load, the network, then the DOM. */
async function settle({ maxMs = 3000 } = {}) {
  const started = Date.now();
  await sleep(60);
  const page = S.page;
  if (!page || page.isClosed()) return;
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  let quietSince = Date.now();
  while (Date.now() - started < maxMs) {
    const now = Date.now();
    let busy = 0;
    for (const [req, at] of S.inflight) {
      if (now - at > 10_000) S.inflight.delete(req); // a long poll is not "loading"
      else busy += 1;
    }
    if (busy) quietSince = now;
    else if (now - quietSince >= 250) break;
    await sleep(50);
  }
  for (let i = 0; i < 2; i++) {
    try {
      await page.mainFrame().evaluate(quietInPage, { quietMs: 200, maxMs: 1500 });
      break;
    } catch {
      await sleep(150);
      await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    }
  }
}

// --------------------------------------------------------------------------- outline

async function outline({ interactiveOnly }) {
  const page = S.page;
  const ws = workspace();
  const lines = [];
  const byRef = new Map();
  let truncated = false;
  let docId = null;
  let title = "";

  const visit = async (frame, prefix, base, depth) => {
    const ok = checkReadable(frame.url(), { workspace: ws });
    if (!ok.ok) {
      lines.push({ d: base, t: `(not shown: ${ok.reason})` });
      return;
    }
    let res;
    try {
      res = await frame.evaluate(snapshotInPage, { interactiveOnly, maxLines: 700 });
    } catch (err) {
      lines.push({ d: base, t: `(could not read this frame: ${shortError(err)})` });
      return;
    }
    if (!prefix) {
      docId = res.id;
      title = res.title;
      if (S.mainDocId !== res.id) {
        // A new document: frame numbers start again, like the refs inside it.
        S.mainDocId = res.id;
        S.frameNums = new WeakMap();
        S.frameByNum = new Map();
        S.frameCounter = 0;
      }
    }
    truncated ||= res.truncated;
    const children = new Map();
    if (res.lines.some((l) => l.iframe)) {
      for (const child of frame.childFrames()) {
        if (child.isDetached()) continue;
        try {
          const handle = await child.frameElement();
          const key = await handle.evaluate((el) => window.__rosalenaBrowser?.frameKeys.get(el) ?? null);
          await handle.dispose();
          if (key) children.set(key, child);
        } catch {
          /* a frame that went away mid-walk */
        }
      }
    }
    for (const line of res.lines) {
      const t = prefix ? line.t.replace(/^\[(e\d+)\]/, `[${prefix}$1]`) : line.t;
      const ref = /^\[((?:f\d+)?e\d+)\]/.exec(t);
      if (ref) byRef.set(ref[1], t);
      lines.push({ d: base + line.d, t });
      if (!line.iframe) continue;
      const child = children.get(line.iframe);
      if (!child) {
        lines.push({ d: base + line.d + 1, t: "(frame not loaded yet)" });
        continue;
      }
      if (depth >= 4) {
        lines.push({ d: base + line.d + 1, t: "(frame nested too deep to show)" });
        continue;
      }
      let n = S.frameNums.get(child);
      if (!n) {
        n = ++S.frameCounter;
        S.frameNums.set(child, n);
      }
      S.frameByNum.set(n, child);
      await visit(child, `f${n}`, base + line.d + 1, depth + 1);
    }
  };

  await visit(page.mainFrame(), "", 0, 0);
  return { lines: lines.map((l) => `${"  ".repeat(l.d)}${l.t}`), byRef, docId, title, url: page.url(), truncated };
}

/** Header (ours) + fenced page text, cut to the output budget. */
function compose(head, bodyLines, { source, hint = "", tail = [] } = {}) {
  const max = Math.max(1500, Number(settings.maxOutputChars) || 4500);
  const notes = S.notes.splice(0);
  const top = [...notes.map((n) => `note: ${n}`), ...head.filter(Boolean)].join("\n");
  const after = tail.filter(Boolean).join("\n");
  if (!bodyLines?.length) return clampText([top, after].filter(Boolean).join("\n"), max);
  const budget = max - BOUNDARY_OVERHEAD - top.length - after.length - 40;
  const fitted = fitLines(bodyLines, Math.max(400, budget), hint);
  return clampText([top, untrusted(fitted.text, source), after].filter(Boolean).join("\n"), max);
}

function clampText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 60)}\n… (cut at ${max} characters)`;
}

const sourceOf = (page) => {
  try {
    return page.url();
  } catch {
    return "the page";
  }
};

function renderOutline(o, interactiveOnly) {
  if (o.lines.length) return [`title: ${JSON.stringify(o.title)}`, ...o.lines];
  return [`title: ${JSON.stringify(o.title)}`, interactiveOnly ? "(nothing to act on here: try browser_snapshot {\"interactive_only\": false} or browser_read)" : "(the page is empty)"];
}

// --------------------------------------------------------------------------- refs and actions

async function resolveRef(raw) {
  const page = requirePage();
  const p = parseRef(raw);
  if (!p) throw new Error(`"${raw}" is not a ref. Refs look like e12 or f1e3: take one from browser_snapshot`);
  let frame = page.mainFrame();
  if (p.frame !== null) {
    frame = S.frameByNum.get(p.frame);
    if (!frame || frame.isDetached()) throw new Error(`frame f${p.frame} is gone (the page changed). Call browser_snapshot and use a ref from it`);
  }
  const ok = checkReadable(frame.url(), { workspace: workspace() });
  if (!ok.ok) throw new Error(`refused: that element is in ${ok.reason}`);
  const handle = await frame.evaluateHandle(elementForRef, p.ref);
  const el = handle.asElement();
  if (!el) {
    await handle.dispose();
    throw new Error(`ref ${p.label} is stale or unknown (the page changed). Call browser_snapshot and use a ref from it`);
  }
  return { el, frame, label: p.label };
}

/**
 * Do one page action and report what changed: the new page's interactive outline after
 * a navigation, otherwise a diff of the full outline.
 */
async function act(verb, refArg, perform) {
  const page = requirePage();
  const before = await outline({ interactiveOnly: false });
  const target = refArg !== undefined ? await resolveRef(refArg) : null;
  const what = target ? (before.byRef.get(target.label) ?? `[${target.label}]`) : "";
  const consoleBefore = S.console.length;
  const beforeUrl = page.url();
  S.events = [];
  let extra = "";
  try {
    extra = (await perform(target)) ?? "";
  } finally {
    await target?.el.dispose().catch(() => {});
  }
  await settle();
  const now = S.page;
  if (!now || now.isClosed()) return compose([`${verb}: the page closed and no tab is left. Call browser_open {url}`], null);

  const head = [];
  const events = S.events.splice(0);
  const newErrors = S.console.slice(consoleBefore).filter((c) => c.kind !== "warning").length;
  const after = await outline({ interactiveOnly: false });
  const newDoc = now !== page || after.docId !== before.docId;
  let body;
  if (newDoc) {
    head.push(`${verb} ${what}`.trim(), now !== page ? `now in a new tab: ${now.url()}` : `the page changed to ${now.url()}; old refs are gone, use these:`);
    const inter = await outline({ interactiveOnly: true });
    body = renderOutline(inter, true);
  } else {
    head.push(`${verb} ${what}`.trim());
    if (now.url() !== beforeUrl) head.push(`url is now ${now.url()}`);
    const { added, removed } = diffLines(before.lines, after.lines);
    if (!added.length && !removed.length) {
      head.push("no change in the page outline");
      body = [];
    } else {
      body = ["changes (+ new, - gone):", ...added.map((l) => `+ ${l}`), ...removed.map((l) => `- ${l}`)];
    }
  }
  if (extra) head.push(extra);
  if (newErrors) head.push(`${newErrors} new console error(s) or failed request(s): browser_console lists them`);
  if (events.length) body = [...(body ?? []), "events:", ...events.map((e) => `- ${e}`)];
  return compose(head, body, { source: sourceOf(now), hint: "call browser_snapshot to see the whole page" });
}

const CONTROL_KEY = /^(Enter|Tab|Shift\+Tab|Escape|Esc|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/i;

function workspaceFile(path) {
  const ws = workspace();
  if (!ws) throw new Error("refused: uploads need a workspace, and this run has none");
  const abs = isAbsolute(String(path)) ? resolve(String(path)) : resolve(ws, String(path));
  if (!insideWorkspace(ws, abs)) throw new Error(`refused: ${path} is outside the workspace. Only workspace files can be uploaded`);
  if (SECRET_FILE.test(abs)) throw new Error(`refused: ${path} looks like a secrets or key file`);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${path} is not a file`);
  return abs;
}

async function navigate(url, headed) {
  const target = normalizeUrl(url);
  const verdict = checkNavigation(target, { workspace: workspace(), allowedDomains: Array.isArray(settings.allowedDomains) ? settings.allowedDomains.filter(Boolean) : [] });
  if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
  await ensure({ headed: headed === undefined || headed === null ? undefined : Boolean(headed) });
  S.console = [];
  S.events = [];
  let status = null;
  try {
    const res = await S.page.goto(verdict.url, { waitUntil: "domcontentloaded" });
    status = res?.status() ?? null;
  } catch (err) {
    throw new Error(`could not open ${verdict.url}: ${shortError(err)}`);
  }
  await settle();
  return status;
}

function pngSize(file) {
  try {
    const b = readFileSync(file);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    /* unreadable */
  }
  return null;
}

// --------------------------------------------------------------------------- the plugin

const str = (description) => ({ type: "string", description });
const bool = (description) => ({ type: "boolean", description });
const refParam = str('A ref from browser_snapshot, such as "e12" (or "f1e3" inside a frame).');

const plugin = {
  id: "rosa-browser",
  description: "A real Chrome/Edge the agent can open, read, click and screenshot to check its work; one page persists across calls",

  async setup(ctx) {
    ctxRef = ctx;
    settings = { ...DEFAULTS, ...(ctx.config ?? {}) };
    if (settings.registerWorkspaceTools === false) return;
    // Opening and reading a page is a look, like web_fetch: without this, workspace mode
    // (the default) asks before every snapshot. Clicks, typing and uploads still ask.
    try {
      const permissions = await import(new URL("../../src/permissions.mjs", import.meta.url).href);
      if (typeof permissions.registerWorkspaceTool === "function") for (const name of LOOK_TOOLS) permissions.registerWorkspaceTool(name);
    } catch {
      /* an engine without it: every browser tool asks once per chat until "Always allow" */
    }
  },

  tools(ctx) {
    ctxRef = ctx;
    settings = { ...DEFAULTS, ...(ctx.config ?? {}) };
    return [
      {
        name: "browser_open",
        description: "Open a URL in a real browser that keeps the page between calls. Returns the title and the elements you can act on, each with a ref like [e5].",
        parameters: {
          type: "object",
          properties: { url: str("http(s) URL, e.g. http://localhost:5173 or https://example.com"), headed: bool("true shows the browser window (e.g. so the user can log in themselves)") },
          required: ["url"],
        },
        run: (args = {}) =>
          serial(async () => {
            const status = await navigate(args.url, args.headed);
            const o = await outline({ interactiveOnly: true });
            const refs = o.byRef.size;
            return compose([`opened ${S.page.url()}${status && status >= 400 ? ` (HTTP ${status})` : ""} - ${refs} ref${refs === 1 ? "" : "s"}`], renderOutline(o, true), {
              source: S.page.url(),
              hint: "call browser_read for the text, or act on a ref above",
            });
          }),
      },
      {
        name: "browser_snapshot",
        description: "List the current page as an outline. Each element you can act on has a ref like [e12] for browser_click/fill/select. Refs stay valid until the page navigates.",
        parameters: { type: "object", properties: { interactive_only: bool("default true: only actionable elements and headings. false adds text, landmarks and images") } },
        run: (args = {}) =>
          serial(async () => {
            requirePage();
            const interactiveOnly = args.interactive_only !== false;
            const o = await outline({ interactiveOnly });
            return compose([`url: ${o.url} - ${o.byRef.size} ref(s)${o.truncated ? " (long page: outline cut)" : ""}`], renderOutline(o, interactiveOnly), {
              source: o.url,
              hint: interactiveOnly ? "use browser_read for text" : 'use {"interactive_only": true}, or browser_read for text',
            });
          }),
      },
      {
        name: "browser_click",
        description: "Click the element with this ref. Returns what changed on the page.",
        parameters: { type: "object", properties: { ref: refParam }, required: ["ref"] },
        run: (args = {}) =>
          serial(() =>
            act("clicked", args.ref, async (t) => {
              await t.el.click();
            }),
          ),
      },
      {
        name: "browser_fill",
        description: "Replace the text in a text box (ref). submit:true presses Enter after. Never for passwords or card numbers: ask the user to type those.",
        parameters: {
          type: "object",
          properties: { ref: refParam, text: str("The text to put in the field"), submit: bool("press Enter after filling") },
          required: ["ref", "text"],
        },
        run: (args = {}) =>
          serial(() =>
            act(args.submit ? "filled and submitted" : "filled", args.ref, async (t) => {
              const field = await t.el.evaluate(describeField);
              if (field.password || field.secretHint) {
                throw new Error("refused: this is a password or payment field. Never type passwords or card details: ask the user to type it themselves (browser_open with headed:true shows them the window)");
              }
              if (looksLikeCardNumber(args.text)) throw new Error("refused: that text looks like a payment card number. Ask the user to enter it themselves");
              if (field.select) throw new Error("that is a dropdown: use browser_select {ref, values}");
              if (field.file) throw new Error("that is a file input: use browser_upload {ref, paths}");
              if (!field.editable) throw new Error(`that element is not a text field (${field.tag.toLowerCase()}${field.type ? ` type=${field.type}` : ""}). Use browser_click, or pick a textbox ref`);
              await t.el.fill(String(args.text ?? ""));
              if (args.submit) await t.el.press("Enter");
            }),
          ),
      },
      {
        name: "browser_select",
        description: "Choose option(s) in a dropdown (ref) by value or visible text. For a custom dropdown, click it and then click the option.",
        parameters: {
          type: "object",
          properties: { ref: refParam, values: { type: "array", items: { type: "string" }, description: 'Option text or values, e.g. ["Green"]' } },
          required: ["ref", "values"],
        },
        run: (args = {}) =>
          serial(() =>
            act("selected", args.ref, async (t) => {
              const values = (Array.isArray(args.values) ? args.values : [args.values]).filter((v) => v !== undefined && v !== null).map(String);
              if (!values.length) throw new Error("values is empty: name at least one option");
              const field = await t.el.evaluate(describeField);
              if (!field.select) throw new Error("that is not a <select>: for a custom dropdown, browser_click it, then browser_click the option");
              const picked = await t.el.selectOption(values);
              if (!picked.length) throw new Error(`no option matches ${JSON.stringify(values)}: the snapshot line lists the options`);
              return `selected value(s): ${picked.join(", ")}`;
            }),
          ),
      },
      {
        name: "browser_press",
        description: "Press a key such as Enter, Tab, Escape, ArrowDown or Control+A, in the focused element or in ref if given.",
        parameters: { type: "object", properties: { key: str("Key name, e.g. Enter, Tab, Escape, ArrowDown, Control+A"), ref: refParam }, required: ["key"] },
        run: (args = {}) =>
          serial(async () => {
            const key = String(args.key ?? "").trim();
            if (!key) throw new Error("key is required, e.g. Enter");
            return act(`pressed ${key}${args.ref ? " in" : ""}`, args.ref ? args.ref : undefined, async (t) => {
              const field = t ? await t.el.evaluate(describeField) : await S.page.evaluate(focusedField);
              if (field?.password && !CONTROL_KEY.test(key)) throw new Error("refused: the focus is in a password field. Never type passwords: ask the user");
              if (t) await t.el.press(key);
              else await S.page.keyboard.press(key);
            });
          }),
      },
      {
        name: "browser_scroll",
        description: "Scroll the page (direction down, up, top or bottom; default down) or bring ref into view. Use it to load more on infinite-scroll pages.",
        parameters: { type: "object", properties: { direction: { type: "string", enum: ["down", "up", "top", "bottom"] }, ref: refParam } },
        run: (args = {}) =>
          serial(() =>
            act(args.ref ? "scrolled to" : `scrolled ${args.direction ?? "down"}`, args.ref ? args.ref : undefined, async (t) => {
              if (t) {
                await t.el.scrollIntoViewIfNeeded();
                return "";
              }
              const pos = await S.page.evaluate(scrollInPage, { direction: ["down", "up", "top", "bottom"].includes(args.direction) ? args.direction : "down" });
              return `position ${pos.y}-${pos.y + pos.view} of ${pos.height} px`;
            }),
          ),
      },
      {
        name: "browser_read",
        description: "Read the page's main content as markdown, without menus, headers, footers or cookie banners. Give url to open it first; for long pages pass start to read further.",
        parameters: { type: "object", properties: { url: str("optional: open this URL first"), start: { type: "number", description: "character offset to continue from (given at the end of the last read)" } } },
        run: (args = {}) =>
          serial(async () => {
            if (args.url) await navigate(args.url);
            const page = requirePage();
            const ok = checkReadable(page.url(), { workspace: workspace() });
            if (!ok.ok) throw new Error(`refused: the page is ${ok.reason}`);
            const key = `${S.navSeq}|${page.url()}`;
            if (!S.read || S.read.key !== key || !(Number(args.start) > 0)) {
              const res = await page.evaluate(markdownInPage);
              S.read = { key, title: res.title, markdown: res.markdown };
            }
            const md = S.read.markdown;
            const start = Math.max(0, Math.min(md.length, Math.floor(Number(args.start) || 0)));
            const max = Math.max(1500, Number(settings.maxOutputChars) || 4500);
            const room = max - BOUNDARY_OVERHEAD - 260;
            let end = Math.min(md.length, start + room);
            if (end < md.length) {
              const cut = md.lastIndexOf("\n", end);
              if (cut > start + room / 2) end = cut;
            }
            const head = `read ${page.url()} - characters ${start}-${end} of ${md.length}`;
            const tail = end < md.length ? `more: browser_read {"start": ${end}}` : "";
            const text = `${start === 0 ? `# ${S.read.title}\n\n` : ""}${md.slice(start, end) || "(no main text found: try browser_snapshot {\"interactive_only\": false})"}`;
            return compose([head], text.split("\n"), { source: page.url(), tail: [tail] });
          }),
      },
      {
        name: "browser_screenshot",
        description: "Save a PNG of the page in .rosalena/shots and return its path; look at it with read_image. full_page:true for the whole page, width:390 for a phone-sized view.",
        parameters: {
          type: "object",
          properties: { full_page: bool("capture the whole scrollable page"), width: { type: "number", description: "viewport width in px for this shot, e.g. 390 (phone)" }, ref: refParam },
        },
        run: (args = {}) =>
          serial(async () => {
            const page = requirePage();
            const ok = checkReadable(page.url(), { workspace: workspace() });
            if (!ok.ok) throw new Error(`refused: the page is ${ok.reason}`);
            const ws = workspace();
            const dir = ws ? join(ws, ".rosalena", "shots") : join(tmpdir(), "rosalena-shots");
            mkdirSync(dir, { recursive: true });
            // The harness's own folder in a project is never project content: git (and so
            // commit-cadence) leaves everything in it alone.
            if (ws) {
              const ignore = join(ws, ".rosalena", ".gitignore");
              if (!existsSync(ignore)) writeFileSync(ignore, "# Rosalena's working files (screenshots and the like)\n*\n");
            }
            let host = "page";
            try {
              host = new URL(page.url()).hostname || "file";
            } catch {
              /* keep "page" */
            }
            const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
            const file = join(dir, `${host.replace(/[^\w.-]+/g, "_")}-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`);
            const restore = page.viewportSize();
            const width = Number(args.width);
            if (width > 0) {
              await page.setViewportSize({ width: Math.round(Math.min(3840, Math.max(240, width))), height: restore?.height ?? 800 });
              await sleep(250);
            }
            try {
              if (args.ref) {
                const t = await resolveRef(args.ref);
                try {
                  await t.el.screenshot({ path: file });
                } finally {
                  await t.el.dispose().catch(() => {});
                }
              } else {
                await page.screenshot({ path: file, fullPage: Boolean(args.full_page) });
              }
            } finally {
              if (width > 0 && restore) await page.setViewportSize(restore).catch(() => {});
            }
            const size = pngSize(file);
            const shown = ws ? relative(ws, file).replace(/\\/g, "/") : file;
            return compose([
              `saved ${shown} (${size ? `${size.width}x${size.height} px` : "png"}${args.full_page ? ", full page" : ""}${width > 0 ? `, ${Math.round(width)} px wide` : ""}) of ${page.url()}`,
              `To look at it: read_image {"path": ${JSON.stringify(shown)}} (only works when the model can see images).`,
            ]);
          }),
      },
      {
        name: "browser_console",
        description: "Recent console errors, uncaught exceptions and failed requests on the page since browser_open. Use it to check your own web app.",
        parameters: { type: "object", properties: { include_warnings: bool("also list console warnings"), clear: bool("empty the list after reading") } },
        run: (args = {}) =>
          serial(async () => {
            requirePage();
            const list = S.console.filter((c) => args.include_warnings || c.kind !== "warning");
            const warnings = S.console.filter((c) => c.kind === "warning").length;
            if (args.clear) S.console = [];
            if (!list.length) {
              return compose([`no console errors, exceptions or failed requests since the page was opened${!args.include_warnings && warnings ? ` (${warnings} warning(s): include_warnings:true lists them)` : ""}`]);
            }
            const shown = list.slice(-30);
            const lines = shown.map((c) => `${c.kind}: ${String(c.text).replace(/\s+/g, " ").slice(0, 300)}${c.where ? ` (at ${c.where})` : ""}${c.url && c.url !== S.page.url() ? ` [on ${c.url}]` : ""}`);
            return compose([`${list.length} problem(s)${list.length > shown.length ? `, newest ${shown.length} shown` : ""}${!args.include_warnings && warnings ? `, plus ${warnings} warning(s)` : ""}:`], lines, { source: "the page's console" });
          }),
      },
      {
        name: "browser_upload",
        description: "Attach files from the workspace to a file input (ref). Files outside the workspace are refused.",
        parameters: {
          type: "object",
          properties: { ref: refParam, paths: { type: "array", items: { type: "string" }, description: "Workspace-relative file paths" } },
          required: ["ref", "paths"],
        },
        run: (args = {}) =>
          serial(async () => {
            const files = (Array.isArray(args.paths) ? args.paths : [args.paths]).filter(Boolean).map(workspaceFile);
            if (!files.length) throw new Error("paths is empty: name at least one workspace file");
            return act("attached", args.ref, async (t) => {
              const field = await t.el.evaluate(describeField);
              if (!field.file) throw new Error("that is not a file input (input type=file)");
              await t.el.setInputFiles(files);
              return `${files.length} file(s): ${files.map((f) => relative(workspace(), f).replace(/\\/g, "/")).join(", ")}`;
            });
          }),
      },
      {
        name: "browser_close",
        description: "Close the browser. It also closes by itself after a few idle minutes.",
        parameters: { type: "object", properties: {} },
        run: () =>
          serial(async () => {
            const was = await closeSession();
            return was ? `browser closed (its profile, with cookies, stays in ${S.profile || defaultProfileDir()})` : "the browser was not open";
          }),
      },
    ];
  },

  hooks() {
    return {
      async onRunStart({ root }) {
        if (root) activeRoot = root;
      },
    };
  },

  commands() {
    return {
      status: async () => describeState(),
      close: async () => ((await serial(() => closeSession())) ? "browser closed" : "the browser was not open"),
    };
  },

  status() {
    return describeState();
  },
};

function describeState() {
  if (!S.context) return `not started (starts on the first browser_* call; profile ${settings.profileDir || defaultProfileDir()})`;
  let url = "";
  try {
    url = S.page?.url() ?? "";
  } catch {
    /* closed */
  }
  return `open${url ? ` on ${url}` : ""} (${S.headless ? "headless" : "with a window"}, ${S.executable})`;
}

/** For tests: the live session's page, so a test can check it persisted. */
export function _session() {
  return S;
}

export default plugin;
