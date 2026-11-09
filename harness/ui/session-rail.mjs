// The session rail: a per-chat info panel beside the chat (Docked) or sliding over it
// from the right (Overlay), like the right-hand panel of Claude Code's desktop app.
//
//   Environment         the chat's folder (a gear opens its settings), the path, the git
//                       branch, and the folder's Access and Commits choices
//   Context             how full the model's window is, from the same reading the
//                       composer's gauge paints (ui/context events, /api/context)
//   Connectors          the MCP servers this chat's folder can call, and how many need you
//   Outputs             files the chat wrote, newest first; a click opens the file viewer
//   Changes             lines added and removed, from the undo journals (/api/session-rail)
//   Background tasks    subagents, background shells and goal rounds, with elapsed time
//
// Nothing here polls. The rail is fed the run events app.js already receives (the live
// stream and a replayed chat both pass through `event`), the meter app.js paints, the MCP
// list it loads and the /api/activity answer the stream already triggers. The one request
// of its own, /api/session-rail, is made when an event says a file changed.
//
// The top half is pure and imported by the tests (test/session-rail.test.mjs); the DOM half
// only runs inside createSessionRail, so importing this file in Node touches no document.

import { t } from "./i18n.mjs";

// ------------------------------------------------------------------ pure parts

export const RAIL_KEY = "rosalena-session-rail";
export const RAIL_MODES = ["docked", "overlay"];
/** Docked needs this much room beside it; a narrower chat gets the overlay instead. */
export const RAIL_WIDTH = 300;
export const RAIL_CHAT_MIN = 340;
export const OUTPUTS_SHOWN = 5;

/** The saved placement: { mode, shown, folded }. Anything unreadable is the default. */
export function readRailPrefs(raw) {
  let saved = {};
  try {
    saved = typeof raw === "string" && raw ? JSON.parse(raw) : raw && typeof raw === "object" ? raw : {};
  } catch {
    saved = {};
  }
  const folded = {};
  for (const [key, value] of Object.entries(saved?.folded ?? {})) if (value === true && /^[a-z]{2,20}$/.test(key)) folded[key] = true;
  return {
    mode: RAIL_MODES.includes(saved?.mode) ? saved.mode : "docked",
    shown: saved?.shown !== false,
    folded,
  };
}

/** Claude Code's rows run in their own window: 200K, or the 1M variant past 200K (claude-engine.mjs). */
export function idleWindow({ row = null, menuWindow = 0 } = {}) {
  const max = Number(row?.contextMax) || 0;
  if (row?.source === "claude-code" || String(row?.id ?? "").startsWith("claude-code/")) {
    if (!max) return 0;
    return Number(menuWindow) > 200_000 ? max : Math.min(max, 200_000);
  }
  const win = Number(menuWindow) || 0;
  return max && win ? Math.min(max, win) : win || max;
}

/**
 * One context reading for the rail. `meter` is what the composer gauge paints (a
 * `ui/context` event or /api/context); with none, the window the next message gets is shown
 * at 0% and marked unmeasured. Null when neither is known: the section then says so.
 */
export function contextReading(meter, fallbackWindow = 0) {
  if (!meter || !(Number(meter.window) > 0)) {
    const win = Number(fallbackWindow) || 0;
    return win > 0 ? { measured: false, used: 0, window: win, percent: 0, fraction: 0, tone: "", threshold: null } : null;
  }
  const used = Math.max(0, Number(meter.used) || 0);
  const win = Number(meter.window);
  const fraction = Math.min(1, used / win);
  const percent = Number.isFinite(Number(meter.percent)) ? Math.max(0, Math.round(Number(meter.percent))) : Math.round((used / win) * 100);
  const threshold = Number(meter.threshold) > 0 ? Number(meter.threshold) : null;
  // The same colours the gauge uses: near the compaction point, then past it. Without a
  // threshold, the last tenth of the window is what is worth noticing.
  const tone = threshold ? (used > threshold ? "bad" : used > threshold * 0.85 ? "warn" : "") : percent >= 90 ? "bad" : percent >= 75 ? "warn" : "";
  return { measured: true, used, window: win, percent, fraction, tone, threshold, source: meter.source ?? null };
}

/** The /api/session-rail `changes` answer, totalled: files whose lines could not be counted are listed apart. */
export function changesTotals(changes) {
  const files = Array.isArray(changes?.files) ? changes.files : [];
  let added = 0;
  let removed = 0;
  let uncounted = 0;
  for (const f of files) {
    if (Number.isFinite(f?.added) && Number.isFinite(f?.removed)) {
      added += f.added;
      removed += f.removed;
    } else uncounted += 1;
  }
  return { added, removed, files: files.length, uncounted };
}

const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

/** A tool's path argument as an absolute path, against the folder the run worked in. */
export function resolvePath(root, path) {
  const p = String(path ?? "").trim();
  if (!p) return "";
  const sep = String(root ?? "").includes("\\") || /^[a-zA-Z]:/.test(String(root ?? "")) ? "\\" : "/";
  const swap = (s) => (sep === "\\" ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/"));
  if (ABSOLUTE.test(p) || !root) return swap(p);
  const parts = [];
  for (const piece of swap(p).split(sep)) {
    if (!piece || piece === ".") continue;
    if (piece === "..") parts.pop();
    else parts.push(piece);
  }
  return `${String(root).replace(/[\\/]+$/, "")}${sep}${parts.join(sep)}`;
}

const pathKey = (abs) => String(abs).replace(/\\/g, "/").toLowerCase();

/** An empty per-chat model; `foldEvent` fills it, one event at a time. */
export function emptyRailModel() {
  return {
    runIds: [],
    root: "",
    subRoot: "",
    seq: 0,
    outputs: new Map(), // path key -> { abs, op, seq }
    subs: new Map(), // subagent run id -> { id, task, parent, seenAt, ended }
    jobs: new Map(), // background job id -> { id, pid, command, seenAt, ended }
    rounds: new Map(), // goal round -> of
    goal: false,
    ended: false,
  };
}

const FILE_TOOLS = new Set(["write_file", "edit_file", "move_file", "delete_file"]);
/** Events after which the lines and files on disk may have changed. */
export function changesFiles(event) {
  if (!event) return false;
  if (event.type === "ui/end" || (event.type === "run_end" && !event.sub)) return true;
  if (event.type !== "tool" || event.ok === false) return false;
  return FILE_TOOLS.has(event.name) || event.name === "run_command" || event.name === "Write" || event.name === "Edit" || event.name === "MultiEdit" || event.name === "Bash";
}

/**
 * Fold one run event into the model. Idempotent per event: a stream that replays what the
 * page already drew (a rejoin, a reconnect) leaves the same model behind.
 */
export function foldEvent(model, event, now = Date.now()) {
  if (!event || typeof event !== "object") return model;
  const seenAt = Number.isFinite(Date.parse(event.at ?? "")) ? Date.parse(event.at) : now;
  const touch = (abs, op) => {
    if (!abs) return;
    model.seq += 1;
    model.outputs.set(pathKey(abs), { abs, op, seq: model.seq });
  };
  const root = event.sub ? model.subRoot || model.root : model.root;
  switch (event.type) {
    case "run":
      if (event.sub) {
        if (event.id) {
          const was = model.subs.get(event.id);
          model.subs.set(event.id, { id: event.id, task: event.task ?? was?.task ?? "", parent: event.parent ?? was?.parent ?? null, seenAt: was?.seenAt ?? seenAt, ended: was?.ended ?? false });
        }
        if (event.root) model.subRoot = event.root;
      } else {
        if (event.id && !model.runIds.includes(event.id)) model.runIds.push(event.id);
        if (event.root) model.root = event.root;
        model.ended = false;
      }
      break;
    case "run_end":
      if (event.sub && event.run) {
        const was = model.subs.get(event.run);
        model.subs.set(event.run, { id: event.run, task: was?.task ?? "", parent: was?.parent ?? null, seenAt: was?.seenAt ?? seenAt, ended: true });
      }
      break;
    case "ui/end":
      model.ended = true;
      break;
    case "present":
      touch(resolvePath(root, event.path), "present");
      break;
    case "mission_round":
      model.goal = true;
      if (Number(event.round) > 0) model.rounds.set(Number(event.round), Number(event.of) || null);
      break;
    case "goal":
    case "goal_written":
    case "goal_continue":
      model.goal = true;
      break;
    case "tool": {
      if (event.ok === false) break;
      const args = event.args && typeof event.args === "object" ? event.args : {};
      const name = event.name;
      if (name === "write_file" || name === "edit_file" || name === "Write" || name === "Edit" || name === "MultiEdit") {
        touch(resolvePath(root, args.path ?? args.file_path), name === "write_file" || name === "Write" ? "write" : "edit");
      } else if (name === "move_file") {
        model.outputs.delete(pathKey(resolvePath(root, args.from)));
        touch(resolvePath(root, args.to), "move");
      } else if (name === "delete_file") {
        model.outputs.delete(pathKey(resolvePath(root, args.path)));
      } else if (name === "run_command" && args.background === true) {
        const m = /started\s+(\S+)\s+\(pid\s+(\d+)\)/.exec(String(event.preview ?? ""));
        if (m && !model.jobs.has(m[1])) model.jobs.set(m[1], { id: m[1], pid: Number(m[2]), command: String(args.command ?? ""), seenAt, ended: false });
      } else if (name === "job_kill") {
        const job = model.jobs.get(String(args.job_id ?? ""));
        if (job) job.ended = true;
      }
      break;
    }
    default:
      break;
  }
  return model;
}

/**
 * Files the chat wrote, newest first. `changes` (the server's list) says which ones are
 * new; a file deleted again, or moved away, is not listed.
 */
export function outputsList(model, changes = null) {
  const created = new Set();
  for (const f of changes?.files ?? []) if (f?.status === "A" && f.path) created.add(pathKey(f.path));
  const root = String(model?.root ?? "");
  const rootKey = pathKey(root).replace(/\/+$/, "");
  return [...(model?.outputs?.values() ?? [])]
    .sort((a, b) => b.seq - a.seq)
    .map((o) => {
      const key = pathKey(o.abs);
      const parts = String(o.abs).split(/[\\/]/);
      const name = parts.pop() || o.abs;
      const dirAbs = parts.join(o.abs.includes("\\") ? "\\" : "/");
      const dirKey = pathKey(dirAbs);
      const dir = rootKey && (dirKey === rootKey || dirKey.startsWith(`${rootKey}/`)) ? dirAbs.slice(root.replace(/[\\/]+$/, "").length).replace(/^[\\/]/, "") : dirAbs;
      return { abs: o.abs, name, dir, op: o.op, created: created.has(key) };
    });
}

/** Elapsed time the way the run strip says it: 12s, 3m 04s, 1h 02m. */
export function elapsedText(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const when = (value) => {
  const ms = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
};

/**
 * What is running for this chat right now, and how much already finished.
 *
 * `activity` is the /api/activity answer (live runs, subagents, ledger processes); the
 * model adds what the stream said (a subagent that started or ended, a background job,
 * the goal's rounds). Without an activity answer, the stream's word stands on its own.
 */
export function backgroundTasks(model, activity = null, { thread = null, busy = false, now = Date.now(), activityAt = 0 } = {}) {
  const running = [];
  let finished = 0;
  if (!model) return { running, finished };
  const ours = new Set([...model.runIds, ...model.subs.keys()]);
  if (thread) ours.add(thread);

  // Subagents: the activity list (it knows what is alive), widened to nested ones.
  const live = new Map();
  const subagents = Array.isArray(activity?.subagents) ? activity.subagents : [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const run of subagents) {
      if (!run?.id || live.has(run.id) || !ours.has(run.parent)) continue;
      live.set(run.id, run);
      ours.add(run.id);
      grew = true;
    }
  }
  for (const [id, run] of live) {
    const seen = model.subs.get(id);
    running.push({ kind: "subagent", id, title: run.task || seen?.task || t("Subagent"), startedAt: when(run.startedAt) ?? seen?.seenAt ?? null, detail: run.lastTool ? t("last: {tool}", { tool: run.lastTool }) : null });
  }
  for (const sub of model.subs.values()) {
    if (live.has(sub.id)) continue;
    if (sub.ended) finished += 1;
    // Seen starting and not yet in an activity answer read after it: still starting up.
    else if (busy && (!activity || activityAt <= sub.seenAt)) running.push({ kind: "subagent", id: sub.id, title: sub.task || t("Subagent"), startedAt: sub.seenAt, detail: null });
    else finished += 1;
  }

  // Background shells: the process ledger, and the jobs the stream saw start.
  const processes = Array.isArray(activity?.processes) ? activity.processes : [];
  const mine = processes.filter((p) => (p?.runId && ours.has(p.runId)) || (thread && p?.chat?.id === thread));
  const pids = new Set(mine.map((p) => Number(p.pid)).filter(Boolean));
  for (const p of mine) {
    const job = [...model.jobs.values()].find((j) => j.pid === Number(p.pid));
    running.push({ kind: "shell", id: `pid-${p.pid}`, title: job?.command || p.cmd || p.name || t("process {pid}", { pid: p.pid }), startedAt: when(p.firstSeen) ?? job?.seenAt ?? null, detail: p.pid ? `pid ${p.pid}` : null });
  }
  for (const job of model.jobs.values()) {
    if (pids.has(job.pid)) continue;
    if (job.ended || (activity && activityAt > job.seenAt)) finished += 1;
    else running.push({ kind: "shell", id: job.id, title: job.command || job.id, startedAt: job.seenAt, detail: `pid ${job.pid}` });
  }

  // Goal mode: the chat's own run is the goal run while it goes; earlier rounds are done.
  if (model.goal) {
    const rounds = [...model.rounds.keys()];
    const current = rounds.length ? Math.max(...rounds) : 0;
    const of = current ? model.rounds.get(current) : null;
    const goingNow = busy && !model.ended;
    if (goingNow) {
      const runs = Array.isArray(activity?.runs) ? activity.runs : [];
      const run = runs.find((r) => ours.has(r.id));
      running.push({ kind: "goal", id: "goal", title: current ? (of ? t("Goal · round {round} of {of}", { round: current, of }) : t("Goal · round {round}", { round: current })) : t("Goal run"), startedAt: when(run?.startedAt), detail: null });
      finished += Math.max(0, current - 1);
    } else finished += rounds.length;
  }
  running.sort((a, b) => (a.startedAt ?? now) - (b.startedAt ?? now));
  return { running, finished };
}

/** The MCP list for the rail: which servers, and which ones need the person. */
export function mcpSummary(data) {
  const servers = (Array.isArray(data?.servers) ? data.servers : []).map((s) => {
    const attention = s.invalid ? t("broken entry: {problem}", { problem: s.invalid }) : s.enabled && s.probe?.ok === false ? t("did not answer: {error}", { error: s.probe.error ?? t("no reply") }) : null;
    return { name: String(s.name ?? ""), enabled: Boolean(s.enabled), attention, tools: s.probe?.ok === true ? Number(s.probe.tools) || 0 : null };
  });
  const pluginOff = data?.available === false;
  return {
    servers,
    on: servers.filter((s) => s.enabled).length,
    attention: servers.filter((s) => s.attention).length + (pluginOff && servers.some((s) => s.enabled) ? 1 : 0),
    pluginOff,
    error: data?.error ?? null,
  };
}

// ------------------------------------------------------------------ the DOM half

const SECTIONS = [
  ["env", t("Environment")],
  ["context", t("Context")],
  ["connectors", t("Connectors")],
  ["outputs", t("Outputs")],
  ["changes", t("Changes")],
  ["tasks", t("Background tasks")],
];

const tokensText = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(v);
};

function node(tag, className = "", text = "") {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}

/**
 * Mount the rail. `host` is app.js's side of the bargain: what the chat on screen is, and
 * the actions the rail borrows (the file viewer, the folder's menu, the MCP panel).
 */
export function createSessionRail(host) {
  const rail = document.getElementById("session-rail");
  const body = document.getElementById("rail-body");
  const toggle = document.getElementById("rail-toggle");
  const modeBtn = document.getElementById("rail-mode");
  const closeBtn = document.getElementById("rail-close");
  const main = rail?.closest(".app-row")?.querySelector("main.main") ?? document.querySelector("main.main");
  if (!rail || !body || !main) return null;

  let prefs = readRailPrefs(host.readPref?.(RAIL_KEY) ?? "");
  const view = {
    model: emptyRailModel(),
    meter: null,
    server: null, // the last /api/session-rail answer for this chat
    serverFor: null,
    mcp: null,
    mcpFor: null,
    showAllOutputs: false,
    overlayOpen: false,
    narrow: false,
    seq: 0,
    timer: 0,
    frame: 0,
    tick: 0,
  };

  const save = () => host.writePref?.(RAIL_KEY, JSON.stringify(prefs));
  const chat = () => host.current?.() ?? {};
  const effectiveMode = () => (prefs.mode === "docked" && !view.narrow ? "docked" : "overlay");
  const visible = () => (effectiveMode() === "docked" ? prefs.shown : view.overlayOpen);

  // ---------------------------------------------------------------- placement

  function place() {
    const mode = effectiveMode();
    // An overlay left open does not pop back up after the window gets narrow again later.
    if (mode === "docked") view.overlayOpen = false;
    // Overlay lives inside the chat column, so "from the right" is the chat's right edge
    // whatever the inspector beside it is doing; Docked is a column of its own after it.
    if (mode === "overlay" && rail.parentElement !== main) main.append(rail);
    if (mode === "docked" && rail.previousElementSibling !== main) main.after(rail);
    rail.dataset.mode = mode;
    rail.hidden = !visible();
    rail.classList.toggle("open", mode === "overlay" && view.overlayOpen);
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(visible()));
      toggle.setAttribute("aria-expanded", String(visible()));
      const where = mode === "docked" ? t("docked beside the chat") : t("over the chat");
      const note = view.narrow && prefs.mode === "docked" ? ` ${t("(the window is too narrow to dock it)")}` : "";
      toggle.title = visible() ? t("Hide the session rail (Ctrl+.) · {where}{note}", { where, note }) : t("Show the session rail (Ctrl+.) · {where}{note}", { where, note });
    }
    if (modeBtn) {
      modeBtn.textContent = mode === "docked" ? "⧉" : "▥";
      modeBtn.title = prefs.mode === "docked" ? t("Switch to Overlay: slide over the chat (Ctrl+Shift+.)") : t("Switch to Docked: a column beside the chat (Ctrl+Shift+.)");
    }
    paintSettings();
    if (visible()) schedule();
    syncTicker();
  }

  function measureNarrow() {
    const railW = rail.parentElement !== main && !rail.hidden ? rail.offsetWidth : 0;
    const room = main.clientWidth + railW;
    const narrow = room > 0 && room < RAIL_WIDTH + RAIL_CHAT_MIN;
    if (narrow !== view.narrow) {
      view.narrow = narrow;
      place();
    }
  }

  function setShown(on) {
    if (effectiveMode() === "docked") {
      prefs.shown = on;
      save();
    } else view.overlayOpen = on;
    place();
    if (on) void refreshAll();
  }

  function setMode(mode) {
    if (!RAIL_MODES.includes(mode)) return;
    prefs.mode = mode;
    // Switching is asking to see it in the new place (an overlay, if the window is too
    // narrow to dock it right now).
    if (mode === "docked") prefs.shown = true;
    view.overlayOpen = true;
    save();
    place();
    void refreshAll();
  }

  const toggleShown = () => setShown(!visible());
  const switchMode = () => setMode(prefs.mode === "docked" ? "overlay" : "docked");

  // ---------------------------------------------------------------- settings row

  function paintSettings() {
    const seg = document.getElementById("rail-placement");
    if (seg) {
      seg.replaceChildren(
        ...RAIL_MODES.map((mode) => {
          const b = node("button", "seg-btn acct-seg-btn", mode === "docked" ? t("Docked") : t("Overlay"));
          b.type = "button";
          b.setAttribute("aria-pressed", String(prefs.mode === mode));
          b.onclick = () => setMode(mode);
          return b;
        }),
      );
    }
    const shown = document.getElementById("rail-shown");
    if (shown) shown.checked = visible();
    const value = document.getElementById("rail-settings-value");
    if (value) {
      const docked = prefs.mode === "docked";
      value.textContent = visible() ? (docked ? t("docked") : t("overlay")) : docked ? t("docked, hidden") : t("overlay, hidden");
    }
  }
  document.getElementById("rail-shown")?.addEventListener("change", (e) => setShown(e.currentTarget.checked));

  // ---------------------------------------------------------------- data

  async function loadServer(force = false) {
    const c = chat();
    const ws = host.workspace?.() ?? "";
    const key = `${c.thread ?? ""}|${ws}`;
    if (!force && view.pendingKey === key) return; // already on its way
    if (!host.token) {
      // A view-only phone link carries no token, and the route names files on this disk.
      view.server = { error: t("not available on a view-only phone link") };
      view.serverFor = key;
      schedule();
      return;
    }
    view.pendingKey = key;
    const seq = (view.seq += 1);
    try {
      const q = new URLSearchParams();
      if (c.thread) q.set("id", c.thread);
      if (ws) q.set("workspace", ws);
      const answer = await host.api(`/api/session-rail?${q}`, { headers: { "x-rosalena-token": host.token } });
      if (seq !== view.seq) return; // a newer read is on its way
      view.server = answer;
      view.serverFor = key;
    } catch (err) {
      if (seq !== view.seq) return;
      view.server = { error: err.message };
      view.serverFor = key;
    }
    view.pendingKey = null;
    schedule();
  }

  async function loadMcp() {
    const ws = host.workspace?.() ?? "";
    if (view.mcpPending === ws) return;
    view.mcpPending = ws;
    try {
      view.mcp = await host.api(`/api/mcp${ws ? `?workspace=${encodeURIComponent(ws)}` : ""}`);
    } catch (err) {
      view.mcp = { error: err.message, servers: [] };
    }
    view.mcpFor = ws;
    view.mcpPending = null;
    schedule();
  }

  /** Re-read the rail's own route, a moment after the last file change in a burst. */
  function refreshServer(delay = 700) {
    clearTimeout(view.timer);
    view.timer = setTimeout(() => {
      view.timer = 0;
      if (visible()) void loadServer(true);
      else view.serverFor = null; // read when it is next shown
    }, delay);
  }

  async function refreshAll() {
    if (!visible()) return;
    const ws = host.workspace?.() ?? "";
    const key = `${chat().thread ?? ""}|${ws}`;
    if (view.serverFor !== key) void loadServer();
    if (view.mcpFor !== ws) void loadMcp();
    if (chat().busy) host.refreshActivity?.();
  }

  // ---------------------------------------------------------------- render

  function schedule() {
    if (view.frame || !visible()) return;
    // A short timer, not requestAnimationFrame: a burst of events still paints once, and a
    // window that is hidden or minimised (no frames) still has a current rail when shown.
    view.frame = setTimeout(() => {
      view.frame = 0;
      render();
    }, 40);
  }

  function section(id, title, { count = "", tone = "" } = {}) {
    const d = node("details", "side-disclosure rail-sec");
    d.dataset.sec = id;
    d.open = !prefs.folded[id];
    const s = node("summary", "group-label");
    s.append(node("span", "", title));
    if (count) s.append(node("span", `count rail-count${tone ? ` ${tone}` : ""}`, count));
    d.append(s);
    d.addEventListener("toggle", () => {
      if (d.open) delete prefs.folded[id];
      else prefs.folded[id] = true;
      save();
    });
    const inner = node("div", "rail-sec-body");
    d.append(inner);
    return { d, inner };
  }

  const row = (label, value, { kind = "", title = "", mono = false } = {}) => {
    const r = node("div", `rail-row${kind ? ` ${kind}` : ""}`);
    r.append(node("span", "rail-key", label));
    const v = typeof value === "string" ? node("span", `rail-val${mono ? " mono" : ""}`, value) : value;
    if (typeof value !== "string") v.classList.add("rail-val");
    if (title) v.title = title;
    r.append(v);
    return r;
  };
  const empty = (text) => node("p", "rail-empty", text);

  function mirrorSelect(id, label, hiddenBy = null) {
    const real = document.getElementById(id);
    // Shown only where the composer shows it (Commits hides while its plugin is off).
    if (!real || (hiddenBy && document.getElementById(hiddenBy)?.hidden)) return null;
    const sel = document.createElement("select");
    sel.className = "rail-select";
    sel.setAttribute("aria-label", label);
    for (const opt of real.options) sel.append(new Option(opt.textContent, opt.value, false, opt.value === real.value));
    sel.value = real.value;
    // The composer's select is the real control: setting it and firing its change runs the
    // same save and toast a choice there would.
    sel.onchange = () => {
      real.value = sel.value;
      real.dispatchEvent(new Event("change", { bubbles: true }));
    };
    return row(label, sel);
  }

  function renderEnv(inner) {
    const ws = view.server?.workspace || host.workspace?.() || "";
    if (!ws) {
      inner.append(empty(t("The server has not named a folder yet.")));
    } else {
      const isDefault = host.isDefaultWorkspace?.(ws);
      const folder = node("span", "rail-folder");
      const name = node("span", "rail-folder-name", isDefault ? t("No project folder") : ws.split(/[\\/]/).filter(Boolean).pop() || ws);
      folder.append(name);
      if (isDefault) {
        const pick = node("button", "mini-btn", t("Choose…"));
        pick.type = "button";
        pick.title = t("Pick the folder this chat works in");
        pick.onclick = () => host.chooseWorkspace?.();
        folder.append(pick);
      }
      const gear = node("button", "panel-btn rail-gear", "⚙");
      gear.type = "button";
      gear.title = t("This folder's settings: Access, Commits and MCP servers");
      gear.setAttribute("aria-label", t("Folder settings"));
      gear.onclick = (e) => {
        e.stopPropagation();
        setTimeout(() => host.openFolderSettings?.(), 0);
      };
      folder.append(gear);
      inner.append(row(t("Folder"), folder));
      const path = node("button", "rail-path", ws);
      path.type = "button";
      path.title = `${ws}\n${t("Show it in File Explorer")}`;
      path.onclick = () => host.reveal?.(ws);
      inner.append(row(t("Path"), path));
      const b = view.server?.branch;
      if (b?.branch) inner.append(row(t("Branch"), b.branch, { mono: true }));
      else if (b?.detached) inner.append(row(t("Branch"), t("detached at {ref}", { ref: b.detached }), { mono: true }));
    }
    const access = mirrorSelect("access-mode", t("Access"));
    if (access) inner.append(access);
    const commits = mirrorSelect("commit-mode", t("Commits"), "commit-pick");
    if (commits) inner.append(commits);
  }

  function renderContext(inner) {
    const reading = contextReading(view.meter, host.idleWindow?.() ?? 0);
    if (!reading) {
      inner.append(empty(t("This model does not say how big its window is, so there is nothing to measure against.")));
      return "";
    }
    const head = node("button", `rail-ctx${reading.tone ? ` ${reading.tone}` : ""}`);
    head.type = "button";
    head.title = t("Open the full breakdown under the message box");
    head.onclick = (e) => {
      e.stopPropagation();
      setTimeout(() => host.openContext?.(), 0);
    };
    const line = node("span", "rail-ctx-line");
    line.append(node("span", "rail-ctx-pct", `${reading.percent}%`), node("span", "rail-ctx-used", t("{used} of {window} tokens", { used: tokensText(reading.used), window: tokensText(reading.window) })));
    const bar = node("span", "rail-bar");
    const fill = node("span", "rail-bar-fill");
    fill.style.width = `${Math.min(100, reading.fraction * 100)}%`;
    bar.append(fill);
    if (reading.threshold) {
      const mark = node("i", "rail-bar-mark");
      mark.style.left = `${Math.min(100, (reading.threshold / reading.window) * 100)}%`;
      mark.title = t("compacts at {size}", { size: tokensText(reading.threshold) });
      bar.append(mark);
    }
    head.append(line, bar);
    inner.append(head);
    const notes = [];
    if (!reading.measured) notes.push(t("No reading yet: this is the window the next message gets."));
    else if (reading.threshold) notes.push(t("Compacts at {size}.", { size: tokensText(reading.threshold) }));
    if (reading.source === "estimate") notes.push(t("Projected from the request about to be sent."));
    if (notes.length) inner.append(node("p", "rail-note", notes.join(" ")));
    return `${reading.percent}%`;
  }

  function renderConnectors(inner, sum) {
    if (sum.error) inner.append(node("p", "rail-note bad", t("Could not read the MCP list: {error}", { error: sum.error })));
    if (sum.pluginOff) inner.append(node("p", "rail-note warn", t("The MCP plugin is switched off, so no server here can be reached.")));
    if (!sum.servers.length && !sum.error) inner.append(empty(t("No MCP servers for this folder.")));
    for (const s of sum.servers) {
      const r = node("button", `rail-item rail-mcp${s.attention ? " attention" : ""}`);
      r.type = "button";
      r.title = s.attention
        ? t("{name}: {problem}. Open the MCP list", { name: s.name, problem: s.attention })
        : s.enabled
          ? t("{name} is on. Open the MCP list", { name: s.name })
          : t("{name} is off. Open the MCP list", { name: s.name });
      const dot = node("span", `rail-dot ${s.attention ? "bad" : s.enabled ? "ok" : "off"}`);
      dot.setAttribute("aria-hidden", "true");
      r.append(dot, node("span", "rail-item-name", s.name), node("span", "rail-item-meta", s.attention ? t("needs attention") : s.enabled ? (s.tools != null ? t("{n} tools", { n: s.tools }) : t("on")) : t("off")));
      r.onclick = (e) => {
        e.stopPropagation();
        setTimeout(() => host.openMcp?.(), 0);
      };
      inner.append(r);
    }
  }

  function renderOutputs(inner, list) {
    if (!list.length) {
      inner.append(empty(chat().thread ? t("Nothing written yet. Files the agent creates or changes show up here.") : t("Files this chat writes show up here.")));
      return;
    }
    const shown = view.showAllOutputs ? list : list.slice(0, OUTPUTS_SHOWN);
    for (const o of shown) {
      const r = node("button", "rail-item rail-file");
      r.type = "button";
      r.title = `${o.abs}\n${t("Open in the file viewer")}`;
      r.append(node("span", "rail-item-name", o.name));
      if (o.dir) r.append(node("span", "rail-item-meta rail-dir", o.dir));
      if (o.created) r.append(node("span", "rail-badge", t("new")));
      r.onclick = () => host.openFile?.(o.abs);
      inner.append(r);
    }
    if (list.length > OUTPUTS_SHOWN) {
      const more = node("button", "mini-btn rail-more", view.showAllOutputs ? t("Show fewer") : t("Show {count} more", { count: list.length - OUTPUTS_SHOWN }));
      more.type = "button";
      more.onclick = () => {
        view.showAllOutputs = !view.showAllOutputs;
        schedule();
      };
      inner.append(more);
    }
  }

  function renderChanges(inner, totals) {
    const s = view.server;
    if (s?.error) {
      inner.append(node("p", "rail-note bad", t("Could not count the changes: {error}", { error: s.error })));
      return;
    }
    if (!s) {
      inner.append(empty(t("Counting…")));
      return;
    }
    if (!totals.files) {
      inner.append(empty(chat().thread ? t("No file changed in this chat.") : t("Changes appear once the chat edits a file.")));
      return;
    }
    const big = node("div", "rail-delta");
    big.append(node("span", "rail-add", `+${totals.added.toLocaleString()}`), node("span", "rail-del", `−${totals.removed.toLocaleString()}`), node("span", "rail-item-meta", t("{n} files", { n: totals.files })));
    inner.append(big);
    for (const f of (s.changes?.files ?? []).slice(0, OUTPUTS_SHOWN)) {
      const r = node("button", "rail-item rail-file");
      r.type = "button";
      r.title = `${f.path}\n${f.status === "D" ? t("Deleted") : t("Open in the file viewer")}`;
      r.disabled = f.status === "D";
      r.append(node("span", "rail-item-name", String(f.path).split(/[\\/]/).pop()));
      const meta = node("span", "rail-item-meta rail-nums");
      if (f.binary) meta.textContent = t("binary");
      else if (f.large) meta.textContent = t("large");
      else if (!Number.isFinite(f.added)) meta.textContent = t("changed");
      else meta.append(node("span", "rail-add", `+${f.added}`), node("span", "rail-del", `−${f.removed}`));
      r.append(meta);
      if (f.status === "A") r.append(node("span", "rail-badge", t("new")));
      if (f.status === "D") r.append(node("span", "rail-badge del", t("deleted")));
      r.onclick = () => host.openFile?.(f.path);
      inner.append(r);
    }
    const rest = totals.files - Math.min(totals.files, OUTPUTS_SHOWN);
    const bits = [];
    if (rest > 0) bits.push(t("and {n} more files", { n: rest }));
    if (totals.uncounted) bits.push(t("{count} not counted (binary, large or no saved copy)", { count: totals.uncounted }));
    bits.push(t("Counted against each file as it was before this chat first changed it."));
    inner.append(node("p", "rail-note", bits.join(" · ")));
  }

  function renderTasks(inner, tasks) {
    if (!tasks.running.length) {
      inner.append(empty(tasks.finished ? t("Nothing running now · {n} finished.", { n: tasks.finished }) : t("No subagents, background shells or goal rounds in this chat.")));
      return;
    }
    const now = Date.now();
    for (const task of tasks.running) {
      const r = node("div", "rail-item rail-task");
      const mark = node("span", "rail-dot live");
      mark.setAttribute("aria-hidden", "true");
      const kind = task.kind === "subagent" ? t("Subagent") : task.kind === "shell" ? "Shell" : t("Goal");
      const name = node("span", "rail-item-name", task.title);
      name.title = `${kind}: ${task.title}${task.detail ? ` (${task.detail})` : ""}`;
      const time = node("span", "rail-item-meta rail-elapsed", task.startedAt ? elapsedText(now - task.startedAt) : kind.toLowerCase());
      if (task.startedAt) time.dataset.since = String(task.startedAt);
      r.append(mark, node("span", "rail-kind", kind), name, time);
      inner.append(r);
    }
    if (tasks.finished) inner.append(node("p", "rail-note", t("{n} finished", { n: tasks.finished })));
  }

  function render() {
    const c = chat();
    const ws = host.workspace?.() ?? "";
    if (view.serverFor !== `${c.thread ?? ""}|${ws}`) void loadServer();
    if (view.mcpFor !== ws) void loadMcp();
    const sum = mcpSummary(view.mcp);
    const totals = changesTotals(view.server?.changes);
    const outputs = outputsList(view.model, view.server?.changes);
    const act = host.activity?.() ?? null;
    const tasks = backgroundTasks(view.model, act, { thread: c.thread, busy: Boolean(c.busy), activityAt: host.activityAt?.() ?? 0 });
    const reading = contextReading(view.meter, host.idleWindow?.() ?? 0);

    const parts = [];
    const add = (id, title, opts, fill) => {
      const { d, inner } = section(id, title, opts);
      fill(inner);
      parts.push(d);
    };
    const scroll = body.scrollTop;
    if (c.external) {
      body.replaceChildren(empty(t("This session is from another harness: the rail covers Rosalena chats only.")));
      return;
    }
    add("env", t("Environment"), {}, renderEnv);
    add("context", t("Context"), reading ? { count: `${reading.percent}%`, tone: reading.tone } : {}, renderContext);
    add("connectors", t("Connectors"), sum.servers.length ? { count: sum.attention ? t("{n} need attention", { n: sum.attention }) : t("{on}/{total} on", { on: sum.on, total: sum.servers.length }), tone: sum.attention ? "warn" : "" } : {}, (inner) => renderConnectors(inner, sum));
    add("outputs", t("Outputs"), outputs.length ? { count: String(outputs.length) } : {}, (inner) => renderOutputs(inner, outputs));
    add("changes", t("Changes"), totals.files ? { count: `+${totals.added} −${totals.removed}` } : {}, (inner) => renderChanges(inner, totals));
    add("tasks", t("Background tasks"), tasks.running.length ? { count: t("{count} running", { count: tasks.running.length }), tone: "live" } : tasks.finished ? { count: t("{n} finished", { n: tasks.finished }) } : {}, (inner) => renderTasks(inner, tasks));
    body.replaceChildren(...parts);
    body.scrollTop = scroll;
    view.hasRunning = tasks.running.length > 0;
    syncTicker();
  }

  // Elapsed times move once a second while something runs and the rail is on screen. This
  // repaints text already drawn; it asks the server for nothing.
  function syncTicker() {
    const want = visible() && view.hasRunning;
    if (want && !view.tick) {
      view.tick = setInterval(() => {
        const now = Date.now();
        for (const span of body.querySelectorAll(".rail-elapsed[data-since]")) span.textContent = elapsedText(now - Number(span.dataset.since));
      }, 1000);
    } else if (!want && view.tick) {
      clearInterval(view.tick);
      view.tick = 0;
    }
  }

  // ---------------------------------------------------------------- wiring

  toggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleShown();
  });
  modeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    switchMode();
  });
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    setShown(false);
  });
  // Overlay: a click outside closes it. Pointerdown, so the click that lands elsewhere
  // still does its own job; the toggle is outside the rail and handles itself.
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (effectiveMode() !== "overlay" || !view.overlayOpen) return;
      if (rail.contains(e.target) || toggle?.contains(e.target)) return;
      view.overlayOpen = false;
      place();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && effectiveMode() === "overlay" && view.overlayOpen) {
      view.overlayOpen = false;
      place();
      toggle?.focus();
      return;
    }
    // The physical key, so Shift (which turns "." into ">") still matches on any layout.
    const period = e.code === "Period" || e.key === "." || e.key === ">";
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !period) return;
    e.preventDefault();
    if (e.shiftKey) switchMode();
    else toggleShown();
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => measureNarrow()).observe(main);
  window.addEventListener("resize", measureNarrow);

  measureNarrow();
  place();

  return {
    /** Every run event the page draws, live or replayed. */
    event(e) {
      foldEvent(view.model, e);
      if (changesFiles(e)) refreshServer(e.type === "ui/end" || e.type === "run_end" ? 150 : 700);
      if (e.type === "tool" || e.type === "run" || e.type === "run_end" || e.type === "ui/end" || e.type === "present" || e.type === "mission_round") schedule();
    },
    /** A different chat is on screen (or a new one): start its model from nothing. */
    reset() {
      view.model = emptyRailModel();
      view.meter = null;
      view.server = null;
      view.serverFor = null;
      view.showAllOutputs = false;
      clearTimeout(view.timer);
      schedule();
    },
    /** The chat finished loading, or its folder changed: read what depends on them. */
    chatChanged() {
      view.serverFor = null;
      void refreshAll();
      schedule();
    },
    context(meter) {
      view.meter = meter ?? null;
      schedule();
    },
    mcp(data) {
      view.mcp = data;
      // The composer loads its list for the folder on screen, which is this rail's folder.
      view.mcpFor = host.workspace?.() ?? view.mcpFor;
      schedule();
    },
    activity() {
      schedule();
    },
    /** Something outside the stream changed files (an undo). */
    filesChanged() {
      refreshServer(0);
    },
    repaint: schedule,
    overlayOpen: () => effectiveMode() === "overlay" && view.overlayOpen,
    commands: () => [
      { title: visible() ? t("Session rail: hide") : t("Session rail: show"), hint: "Ctrl+.", run: toggleShown },
      { title: prefs.mode === "docked" ? t("Session rail: switch to Overlay") : t("Session rail: switch to Docked"), hint: "Ctrl+Shift+.", run: switchMode },
    ],
  };
}
