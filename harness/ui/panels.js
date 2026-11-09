// Rosalena Harness inspector panels: the session graph and the workspace file tree.
//
// Two independent mounts, imported as plain ES modules by the shell. No dependencies, no
// build step, nothing global: every class name is prefixed `pnl-` and every rule lives
// under `.pnl`, so the shell's own sheet cannot collide with this one. Colours come only
// from the shell's custom properties, each written with a literal fallback - that is what
// lets the preview page stand on its own without the shell's stylesheet.
//
// Why the graph is HTML boxes over one inline SVG: the node text has to be selectable,
// keyboard-focusable and readable by a screen reader, and SVG <text> is none of those
// without a lot of extra machinery. So the boxes are real buttons in a positioned layer
// and the curves are a single <svg> underneath them.
//
// The shells' contract:
//   import { panels } from "./panels.js";
//   const mounted = panels.graph.mount(el, api);
//   mounted.refresh();   // re-read and redraw
//   mounted.destroy();   // stop timers, drop listeners
// `api` is { fetchJson(path), openSession(id), toast(text, kind) } and every member is
// optional: without openSession a node is simply not clickable, without toast an error
// goes into an inline note inside the panel.

import { t } from "./i18n.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRAPH_LIMIT = 120;
const GRAPH_REFRESH_MS = 5000;
const FETCH_TIMEOUT_MS = 8000;
const COMPACT_WIDTH = 280;

// Zoom bounds. The floor is deliberately tiny: "Fit" has to be able to put every node
// inside the viewport, and a window of 120 siblings is tens of thousands of pixels wide.
// A floor of 10% would silently break that promise, so the engine is allowed to go as low
// as it must and the readout tells the truth about the percentage.
const MIN_ZOOM = 0.004;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.25;

// ------------------------------------------------------------------ small helpers

function div(cls, text) {
  const node = document.createElement("div");
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function span(cls, text) {
  const node = document.createElement("span");
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function button(cls, text, label) {
  const node = document.createElement("button");
  node.type = "button";
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  if (label) node.setAttribute("aria-label", label);
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, String(value));
  return node;
}

/** The api object is allowed to be partial or missing entirely; normalise it once. */
function apiOf(api) {
  const src = api && typeof api === "object" ? api : {};
  const bind = (name) => (typeof src[name] === "function" ? src[name].bind(src) : null);
  return {
    fetchJson: bind("fetchJson"),
    openSession: bind("openSession"),
    toast: bind("toast"),
    rootTag: typeof src.rootTag === "string" ? src.rootTag : null,
  };
}

function reasonOf(err) {
  return String(err?.message ?? err ?? t("unknown error"));
}

/**
 * A fetch that never leaves the panel waiting forever. Without this, one hung request
 * would hold the in-flight flag and silently stop every later refresh.
 */
function withTimeout(promise, label) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(t("{what} did not answer within {s}s", { what: label, s: Math.round(FETCH_TIMEOUT_MS / 1000) }))), FETCH_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isNum(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// The run states the graph shows, in the window's language; any other value is shown as sent.
const STATUS_WORDS = {
  running: t("running"),
  failed: t("failed"),
  stopped: t("stopped"),
  stale: t("stale"),
  unknown: t("unknown"),
};

function statusWord(status) {
  const key = String(status ?? "unknown");
  return Object.prototype.hasOwnProperty.call(STATUS_WORDS, key) ? STATUS_WORDS[key] : key;
}

/** 812 B, 1.2 MB - short because it sits in a dense row, never a fake precision. */
function fmtSize(bytes) {
  if (!isNum(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** 3m ago - relative, because an inspector row is scanned, not read for exact times. */
function fmtAgo(iso, now) {
  const at = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(at)) return "";
  const delta = Math.max(0, now - at);
  if (delta < 45_000) return t("just now");
  if (delta < 3_600_000) return t("{n}m ago", { n: Math.max(1, Math.round(delta / 60_000)) });
  if (delta < 86_400_000) return t("{n}h ago", { n: Math.round(delta / 3_600_000) });
  if (delta < 30 * 86_400_000) return t("{n}d ago", { n: Math.round(delta / 86_400_000) });
  return t("{n}mo ago", { n: Math.round(delta / (30 * 86_400_000)) });
}

/** 5ms, 25.2s, 1m 30s - derived from the run's own elapsed milliseconds only. */
function fmtDuration(ms) {
  if (!isNum(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes - hours * 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// ================================================================== session graph

function mountGraph(host, api) {
  const port = apiOf(api);
  const root = div("pnl pnl-graph");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", t("Session graph"));

  // ---- header -----------------------------------------------------------------
  const head = div("pnl-head");
  const title = span("pnl-title", t("Sessions"));
  const countsEl = span("pnl-counts", "");
  const spacer = span("pnl-spacer", "");
  const zoomBox = div("pnl-zoom");
  zoomBox.setAttribute("role", "group");
  zoomBox.setAttribute("aria-label", t("Graph zoom"));
  const zoomOut = button("pnl-zbtn", "\u2212", t("Zoom out"));
  const zoomReset = button("pnl-zbtn pnl-zreset", "100%", t("Reset zoom to 100%"));
  const zoomIn = button("pnl-zbtn", "+", t("Zoom in"));
  const zoomFit = button("pnl-zbtn", t("Fit"), t("Fit the whole graph in the viewport"));
  const zoomNow = span("pnl-znow", "");
  zoomNow.hidden = true;
  zoomBox.append(zoomOut, zoomReset, zoomIn, zoomFit, zoomNow);
  head.append(title, countsEl, spacer, zoomBox);

  const note = div("pnl-note", "");
  note.hidden = true;
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");

  // ---- viewport ---------------------------------------------------------------
  const viewport = div("pnl-gviewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "group");
  viewport.setAttribute("aria-label", t("Session tree, scrollable"));
  const sizer = div("pnl-gsizer");
  const stage = div("pnl-gstage");
  const links = svgEl("svg", { class: "pnl-glinks", "aria-hidden": "true", focusable: "false" });
  const nodesBox = div("pnl-gnodes");
  stage.append(links, nodesBox);
  sizer.append(stage);
  viewport.append(sizer);

  const emptyBox = div("pnl-empty");
  const emptyLine = div("pnl-empty-line", t("No sessions yet."));
  emptyBox.append(emptyLine);
  // Nothing is drawn yet, so the panel opens on its empty state rather than on a blank
  // bordered rectangle; a first read that fails replaces the sentence with the reason.
  viewport.hidden = true;
  zoomBox.hidden = true;

  const foot = div("pnl-foot", "");
  foot.hidden = true;

  root.append(head, note, viewport, emptyBox, foot);
  host.replaceChildren(root);

  // ---- state ------------------------------------------------------------------
  const state = {
    data: null,
    layout: null,
    zoom: 1,
    compact: false,
    fingerprint: "",
    fullHash: "",
    hoverId: null,
    inFlight: false,
    queued: false,
    needsFit: false,
    // Fit is a mode, not a one-off: once the person asks for it, a resize should keep the
    // whole tree in view. A manual zoom leaves the mode, so a chosen scale is never stolen.
    autoFit: false,
    destroyed: false,
    parentOf: new Map(),
    nodeEls: new Map(),
    edgeEls: new Map(),
  };

  let timer = 0;
  let raf = 0;
  let lastWidth = 0;
  let lastToast = "";
  let pan = null;

  // ---- layout -----------------------------------------------------------------
  // Two row heights only. Compact is not a scaled-down wide row: the chip and the metadata
  // line are dropped, so a 34px row can hold a dot and a clipped task without pretending the
  // rest is there. `indent` is the width of one level of the outline.
  const WIDE = { h: 46, gap: 8, indent: 18, min: 150 };
  const COMPACT = { h: 34, gap: 6, indent: 14, min: 120 };
  const box = () => (state.compact ? COMPACT : WIDE);

  const stampOf = (node) => {
    const at = Date.parse(String(node?.at ?? ""));
    return Number.isFinite(at) ? at : 0;
  };

  /**
   * A vertical task tree: one row per run, stacked top to bottom in start order, each child
   * indented one step under the parent that spawned it. A task list is an outline, so depth
   * down the page and indentation across it is the shape that reads; the previous layout
   * spread siblings across a canvas and put depth along the x axis, which on a 340px
   * inspector meant every tree wider than the panel and nothing readable without panning
   * sideways.
   *
   * Rows fill the panel: the row width is the viewport minus the deepest indent, so a deep
   * tree narrows its rows instead of scrolling them off the right edge. Cycle-safe, because
   * a corrupt run store must not be able to blank the panel.
   */
  function layoutTree(nodes) {
    const { h, gap, indent, min } = box();
    const byId = new Map();
    for (const node of nodes) byId.set(node.id, node);

    const kids = new Map();
    for (const node of nodes) {
      const parent = node.parent;
      if (!parent || parent === node.id || !byId.has(parent)) continue;
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(node);
    }
    for (const list of kids.values()) list.sort((a, b) => stampOf(a) - stampOf(b));

    // A node whose parent chain loops back on itself is drawn as a root: leaving it out
    // would hide real work, and inventing a parent is the one thing a graph must not do.
    const cyclic = new Set();
    for (const node of nodes) {
      const seen = new Set([node.id]);
      let cursor = node.parent;
      while (cursor && byId.has(cursor)) {
        if (seen.has(cursor)) {
          cyclic.add(node.id);
          break;
        }
        seen.add(cursor);
        cursor = byId.get(cursor).parent;
      }
    }

    const roots = nodes
      .filter((node) => !node.parent || !byId.has(node.parent) || node.parent === node.id || cyclic.has(node.id))
      .sort((a, b) => stampOf(a) - stampOf(b));

    // Depth first, so a parent is always the row directly above its first child. That is what
    // lets the indent be read as a tree rather than as a list sorted by time.
    const order = [];
    const visiting = new Set();
    const placedParent = new Map();
    const walk = (node, depth) => {
      visiting.add(node.id);
      order.push({ id: node.id, depth });
      for (const child of kids.get(node.id) ?? []) {
        if (visiting.has(child.id)) continue;
        placedParent.set(child.id, node.id);
        walk(child, depth + 1);
      }
      visiting.delete(node.id);
    };
    for (const node of roots) if (!visiting.has(node.id)) walk(node, 0);
    // Anything a cycle kept out of the forest is still a row: a run that exists must be
    // visible, so it becomes its own root at the bottom of the outline.
    for (const node of nodes) if (!visiting.has(node.id)) walk(node, 0);

    const deepest = order.reduce((max, entry) => Math.max(max, entry.depth), 0);
    // The viewport is the width budget. It is 0 while the panel is hidden (the first render
    // happens before it is shown), so a sane default stands in for that one pass.
    const avail = Math.max(0, (viewport.clientWidth || 320) - 24);
    const w = Math.max(min, avail - deepest * indent);
    const pos = new Map();
    order.forEach((entry, row) => {
      pos.set(entry.id, { x: entry.depth * indent, y: row * (h + gap) });
    });

    const width = w + deepest * indent;
    const height = order.length ? order.length * (h + gap) - gap : 0;
    const edges = [...placedParent.entries()]
      .filter(([child, parent]) => pos.has(child) && pos.has(parent))
      .map(([child, parent]) => ({ from: parent, to: child }));

    return { pos, edges, width, height, w, h, indent };
  }

  // ---- rendering --------------------------------------------------------------
  function statusClass(status) {
    const value = String(status ?? "").toLowerCase();
    if (value === "ok" || value === "running" || value === "failed" || value === "stopped" || value === "stale") return `st-${value}`;
    return "st-other";
  }

  /** One metadata line, built only from fields the payload actually carries. */
  function metaText(node) {
    const parts = [];
    if (isNum(node.steps)) parts.push(t("{n} steps", { n: node.steps }));
    if (isNum(node.ms)) parts.push(fmtDuration(node.ms));
    if (node.model) parts.push(String(node.model));
    return parts.join(" \u00b7 ");
  }

  function buildNode(node, layout) {
    const { w, h } = layout;
    const where = layout.pos.get(node.id);
    const cls = statusClass(node.status);
    const orphan = node.parent && !layout.pos.has(node.parent);
    const el = port.openSession ? document.createElement("button") : document.createElement("div");
    if (el.tagName === "BUTTON") el.type = "button";
    el.className = `pnl-gnode ${cls}${orphan ? " is-orphan" : ""}`;
    el.dataset.id = node.id;
    // `x` is the row's left edge, not its centre: an outline is left-aligned at every depth.
    el.style.left = `${Math.round(where.x)}px`;
    el.style.top = `${Math.round(where.y)}px`;
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${h}px`;

    const label = String(node.label ?? t("(no label)"));
    const status = statusWord(node.status);
    if (port.openSession) {
      el.setAttribute("aria-label", t("Open session {id}: {label} ({status})", { id: node.id, label, status }));
    } else {
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", `${label} (${status})`);
    }
    el.title = `${label}\n${node.id}\n${status}${metaText(node) ? `\n${metaText(node)}` : ""}`;

    const dot = span("pnl-gdot", "");
    dot.setAttribute("aria-hidden", "true");
    const titleEl = span("pnl-gtitle", label);
    const chip = span(`pnl-chip ${cls}`, status);
    const meta = span("pnl-gmeta", metaText(node));
    const footRow = div("pnl-gfoot");
    footRow.append(chip, meta);
    el.append(dot, titleEl, footRow);

    if (orphan) {
      // Marked, not re-parented: the payload says whose child it is, and we cannot see
      // that parent, so the box says so instead of pretending to be a real root.
      const mark = span("pnl-orphan", t("orphan"));
      mark.title = t("Parent {id} is outside the {limit}-session window", { id: node.parent, limit: GRAPH_LIMIT });
      el.append(mark);
    }
    return el;
  }

  function drawEdges(layout) {
    links.setAttribute("viewBox", `0 0 ${Math.max(1, layout.width)} ${Math.max(1, layout.height)}`);
    links.setAttribute("width", String(Math.max(1, layout.width)));
    links.setAttribute("height", String(Math.max(1, layout.height)));
    const frag = document.createDocumentFragment();
    state.edgeEls.clear();
    for (const edge of layout.edges) {
      const from = layout.pos.get(edge.from);
      const to = layout.pos.get(edge.to);
      if (!from || !to) continue;
      // An outline elbow: down the gutter under the parent's dot, then across into the
      // child's row. Both ends sit in the indent column, which is why it reads as a tree
      // rather than as a connector between two floating boxes.
      const gutter = Math.max(5, Math.round(layout.indent / 2));
      const x1 = from.x + gutter;
      const y1 = from.y + layout.h;
      const x2 = to.x;
      const y2 = to.y + layout.h / 2;
      const path = svgEl("path", {
        d: `M ${x1} ${y1} V ${y2} H ${x2}`,
        class: "pnl-edge",
        "data-from": edge.from,
        "data-to": edge.to,
        fill: "none",
      });
      frag.append(path);
      state.edgeEls.set(`${edge.from}|${edge.to}`, path);
    }
    links.replaceChildren(frag);
  }

  function applyZoom() {
    if (!state.layout) return;
    stage.style.transform = `scale(${state.zoom})`;
    sizer.style.width = `${Math.max(1, state.layout.width * state.zoom)}px`;
    sizer.style.height = `${Math.max(1, state.layout.height * state.zoom)}px`;
    const percent = Math.max(1, Math.round(state.zoom * 100));
    zoomNow.textContent = `${percent}%`;
    zoomNow.hidden = Math.abs(state.zoom - 1) < 0.005;
    zoomReset.setAttribute("aria-pressed", String(Math.abs(state.zoom - 1) < 0.005));
  }

  function setZoom(next, anchor) {
    const before = state.zoom;
    const clamped = clamp(next, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(clamped - before) < 1e-6) return;
    const rect = viewport.getBoundingClientRect();
    const px = anchor ? anchor.x - rect.left : rect.width / 2;
    const py = anchor ? anchor.y - rect.top : rect.height / 2;
    // Keep the point under the pointer (or the centre) on the same graph coordinate.
    const gx = (viewport.scrollLeft + px) / before;
    const gy = (viewport.scrollTop + py) / before;
    state.zoom = clamped;
    state.needsFit = false;
    state.autoFit = false;
    applyZoom();
    void viewport.scrollWidth;
    viewport.scrollLeft = gx * clamped - px;
    viewport.scrollTop = gy * clamped - py;
  }

  /** Fit guarantees every row is inside the viewport's width, padding included. */
  function doFit() {
    if (!state.layout || state.destroyed) return;
    const rect = viewport.getBoundingClientRect();
    const { width } = state.layout;
    if (rect.width < 8 || rect.height < 8 || width <= 0) {
      state.needsFit = true;
      return;
    }
    // Read the inset instead of carrying a constant: the viewport's padding is the ring the
    // outline has to fit inside, and it has to be re-read when a resize changes it.
    const style = getComputedStyle(viewport);
    const padX = Math.max(parseFloat(style.paddingLeft) || 0, parseFloat(style.paddingRight) || 0);
    const usableW = Math.max(1, viewport.clientWidth - padX * 2);
    // Width only. Fitting a sixty-row outline into the height as well would shrink every row
    // to a thumbnail to satisfy the short axis; the outline's height is what scrolls.
    state.zoom = clamp(usableW / width, MIN_ZOOM, 1);
    state.needsFit = false;
    state.autoFit = true;
    applyZoom();
    void viewport.scrollWidth;
    viewport.scrollLeft = 0;
    // Fit starts at the top of the outline, where the roots are, rather than at its middle.
    viewport.scrollTop = 0;
  }

  function highlight(id) {
    if (state.hoverId === id) return;
    clearHighlight();
    if (!id || !state.nodeEls.has(id)) return;
    state.hoverId = id;
    state.nodeEls.get(id)?.classList.add("is-hover");
    const guard = new Set();
    let cursor = id;
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      state.nodeEls.get(cursor)?.classList.add("is-path");
      const parent = state.parentOf.get(cursor);
      if (!parent) break;
      state.edgeEls.get(`${parent}|${cursor}`)?.classList.add("is-path");
      cursor = parent;
    }
  }

  function clearHighlight() {
    if (!state.hoverId) return;
    state.hoverId = null;
    for (const el of root.querySelectorAll(".is-path, .is-hover")) el.classList.remove("is-path", "is-hover");
  }

  function render(options = {}) {
    const data = state.data;
    const nodes = Array.isArray(data?.nodes) ? data.nodes.filter((node) => node && node.id != null) : [];
    const layout = layoutTree(nodes);
    const scroll = options.keepScroll === false ? null : { left: viewport.scrollLeft, top: viewport.scrollTop };
    const sameSet = state.fingerprint === layoutFingerprint(nodes);
    const active = document.activeElement;
    const focusedId = active && active.classList?.contains("pnl-gnode") ? active.dataset.id ?? null : null;
    const hovered = state.hoverId;

    clearHighlight();
    state.layout = layout;
    state.fingerprint = layoutFingerprint(nodes);
    state.parentOf = new Map(layout.edges.map((edge) => [edge.to, edge.from]));

    nodesBox.replaceChildren();
    state.nodeEls.clear();
    const frag = document.createDocumentFragment();
    for (const node of nodes) {
      if (!layout.pos.has(node.id)) continue;
      const el = buildNode(node, layout);
      frag.append(el);
      state.nodeEls.set(node.id, el);
    }
    nodesBox.append(frag);
    drawEdges(layout);
    stage.style.width = `${layout.width}px`;
    stage.style.height = `${layout.height}px`;
    // Visibility first: a hidden viewport reports a zero client width, which would make
    // the initial scroll and any fit meaningless.
    const empty = nodes.length === 0;
    viewport.hidden = empty;
    emptyBox.hidden = !empty;
    zoomBox.hidden = empty;
    applyZoom();
    void viewport.scrollWidth;
    if (scroll && sameSet) {
      viewport.scrollLeft = scroll.left;
      viewport.scrollTop = scroll.top;
    } else if (nodes.length) {
      // A vertical outline starts at its own top. A new shape means the old scroll offset
      // points at nothing, and scrolling to one particular row would only hide the roots
      // that give the rest of the outline its meaning. The zoom is left exactly as the
      // person set it either way.
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    }

    if (empty) {
      const failed = isNum(data?.counts?.failed) ? data.counts.failed : 0;
      const kids = [emptyLine];
      if (failed > 0) {
        kids.push(div("pnl-empty-line is-warn", t("{n} runs in this window failed.", { n: failed })));
      }
      emptyBox.replaceChildren(...kids);
    }

    const total = isNum(data?.counts?.total) ? data.counts.total : nodes.length;
    const bits = [t("{n} sessions", { n: total })];
    if (isNum(data?.counts?.running) && data.counts.running > 0) bits.push(t("{n} running", { n: data.counts.running }));
    if (isNum(data?.counts?.failed) && data.counts.failed > 0) bits.push(t("{n} failed", { n: data.counts.failed }));
    if (isNum(data?.counts?.deepest) && data.counts.deepest > 0) bits.push(t("depth {n}", { n: data.counts.deepest }));
    countsEl.textContent = nodes.length || isNum(data?.counts?.total) ? bits.join(" \u00b7 ") : "";

    // The truncation line is not an error: the payload is complete for its window, and the
    // panel says what the window was rather than implying the store ended there.
    if (data?.truncated) {
      foot.hidden = false;
      foot.textContent = t("Newest {n} sessions drawn; older runs are outside this window.", { n: nodes.length });
    } else {
      foot.hidden = true;
      foot.textContent = "";
    }

    if (focusedId && state.nodeEls.has(focusedId)) state.nodeEls.get(focusedId)?.focus({ preventScroll: true });
    // A redraw under the pointer must not make the path highlight disappear until the
    // person moves the mouse again.
    if (hovered && state.nodeEls.has(hovered)) highlight(hovered);

    // No automatic Fit. At 100% a node is readable and the panel opens where a graph
    // browser opens; fitting 120 siblings automatically would scale it to a hairline and
    // look like an empty box. Fit stays one click away, and it is exact when asked.
    if (state.needsFit) doFit();
  }

  function layoutFingerprint(nodes) {
    // Only the shape matters here: same ids in the same positions means the viewport the
    // user scrolled to is still meaningful. The metric mode is part of the shape: switching
    // to compact moves every node, so the old offset points at nothing.
    return `${state.compact ? "c" : "w"}|${nodes.map((node) => `${node.id}>${node.parent ?? ""}`).join("|")}`;
  }

  // ---- data -------------------------------------------------------------------
  function notify(text, kind) {
    note.textContent = text || "";
    note.hidden = !text;
    note.dataset.kind = text ? kind ?? "error" : "";
    // A failure before the first payload would otherwise leave the panel on a blank
    // viewport with a thin note above it, so the reason takes the empty state's place.
    if (!state.data) {
      emptyBox.replaceChildren(div("pnl-empty-line", text ? t("Sessions could not be read: {error}", { error: text }) : t("No sessions yet.")));
      emptyBox.hidden = false;
      viewport.hidden = true;
      zoomBox.hidden = true;
    }
    if (text && port.toast && text !== lastToast) {
      lastToast = text;
      port.toast(text, kind ?? "error");
    }
    if (!text) lastToast = "";
  }

  async function refresh() {
    if (state.destroyed) return;
    if (state.inFlight) {
      // Never overlap a redraw with a read: one request in flight, one queued at most.
      state.queued = true;
      return;
    }
    state.inFlight = true;
    try {
      if (!port.fetchJson) throw new Error(t("this page did not provide a way to read the graph"));
      const data = await withTimeout(port.fetchJson(`/api/graph?limit=${GRAPH_LIMIT}`), t("the session graph"));
      if (!data || !Array.isArray(data.nodes)) throw new Error(t("the session graph answered with something that is not a graph"));
      const nextHash = JSON.stringify([data.nodes, data.counts ?? null, data.truncated ?? false]);
      const unchanged = nextHash === state.fullHash;
      state.data = data;
      state.fullHash = nextHash;
      notify("");
      if (unchanged && state.layout) {
        // Nothing moved, so nothing is redrawn: a 5s poll must not disturb a hover, a
        // focus ring or a drag.
        if (state.needsFit) doFit();
        return;
      }
      render();
    } catch (err) {
      notify(t("Could not read the session graph: {error}", { error: reasonOf(err) }));
    } finally {
      state.inFlight = false;
      if (state.queued) {
        state.queued = false;
        void refresh();
      }
    }
  }

  // ---- interaction ------------------------------------------------------------
  zoomOut.addEventListener("click", () => setZoom(state.zoom / ZOOM_STEP));
  zoomIn.addEventListener("click", () => setZoom(state.zoom * ZOOM_STEP));
  zoomReset.addEventListener("click", () => setZoom(1));
  zoomFit.addEventListener("click", () => doFit());

  nodesBox.addEventListener("click", (event) => {
    const el = event.target.closest?.(".pnl-gnode");
    if (!el || !port.openSession) return;
    port.openSession(el.dataset.id);
  });

  nodesBox.addEventListener("pointerover", (event) => {
    const el = event.target.closest?.(".pnl-gnode");
    if (el) highlight(el.dataset.id);
  });
  nodesBox.addEventListener("pointerout", (event) => {
    const el = event.target.closest?.(".pnl-gnode");
    if (!el) return;
    if (event.relatedTarget?.closest?.(".pnl-gnode")) return;
    clearHighlight();
  });
  nodesBox.addEventListener("focusin", (event) => {
    const el = event.target.closest?.(".pnl-gnode");
    if (el) highlight(el.dataset.id);
  });
  nodesBox.addEventListener("focusout", () => clearHighlight());

  // Panning starts only on the empty surface, so a drag can never be mistaken for a click
  // on a node; the threshold keeps a stray 2px twitch from suppressing the click.
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest?.(".pnl-gnode")) return;
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
    // Capture is an optimisation, not a requirement: a released or synthetic pointer must
    // not throw in the middle of starting a drag.
    try {
      viewport.setPointerCapture?.(event.pointerId);
    } catch {
      // No active pointer to capture; the move/up listeners still do the work.
    }
    viewport.classList.add("is-panning");
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!pan || event.pointerId !== pan.id) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    viewport.scrollLeft = pan.left - dx;
    viewport.scrollTop = pan.top - dy;
  });
  const endPan = (event) => {
    if (!pan || (event && event.pointerId !== pan.id)) return;
    const wasPan = pan;
    pan = null;
    try {
      viewport.releasePointerCapture?.(wasPan.id);
    } catch {
      // Already released by the browser; nothing to undo.
    }
    viewport.classList.remove("is-panning");
  };
  viewport.addEventListener("pointerup", endPan);
  viewport.addEventListener("pointercancel", endPan);

  // Plain wheel is left to the browser so trackpad inertia keeps working; only Ctrl+wheel
  // becomes zoom, and it zooms about the pointer rather than the panel centre.
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0016);
      setZoom(state.zoom * factor, { x: event.clientX, y: event.clientY });
    },
    { passive: false },
  );

  // ---- sizing and visibility --------------------------------------------------
  function syncCompact() {
    // Measured on the viewport, not on the panel: a docked panel can be 320px wide and still
    // leave 275px for the cards once its padding is taken out, and it is the cards that have
    // to stay readable. While the tree is hidden the viewport reports 0, so the panel width
    // stands in until it has a real size.
    const width = viewport.clientWidth || root.clientWidth;
    const compact = width > 0 && width < COMPACT_WIDTH;
    if (compact === state.compact) return false;
    state.compact = compact;
    root.classList.toggle("pnl-compact", compact);
    return true;
  }

  const observer = new ResizeObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (state.destroyed || !root.isConnected) return;
      // Read the width here rather than in the observer callback: the callback can fire
      // before the layout the resize produced.
      if (syncCompact()) {
        if (state.data) render();
        return;
      }
      // Row width is measured against the viewport, so a resize re-lays the outline instead
      // of only rescaling it: rows that kept their old width would either clip their text or
      // stop short of the right edge, which is what a widened panel used to show.
      const width = viewport.clientWidth;
      if (width && width !== lastWidth) {
        lastWidth = width;
        if (state.data) render();
      }
      if (state.needsFit || state.autoFit) doFit();
    });
  });
  observer.observe(root);
  // The tree can be squeezed by a resize that never touches the panel itself (a docked
  // neighbour widening), so the viewport is watched too.
  observer.observe(viewport);

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  }
  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, GRAPH_REFRESH_MS);
  }
  const onVisibility = () => {
    if (state.destroyed) return;
    if (document.visibilityState === "visible") {
      startTimer();
      void refresh();
    } else {
      stopTimer();
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  startTimer();
  // Pick the metric mode before the first paint: the observer would otherwise re-render a
  // panel that already drew itself at the wrong width.
  syncCompact();
  void refresh();

  return {
    label: t("Sessions"),
    element: root,
    refresh: () => refresh(),
    destroy() {
      state.destroyed = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (pan) viewport.releasePointerCapture?.(pan.id);
      host.replaceChildren();
    },
  };
}

// ================================================================== file tree

function mountFiles(host, api) {
  const port = apiOf(api);
  const root = div("pnl pnl-files");
  root.setAttribute("role", "region");
  // A folder tab (+ > Folder…) is any folder on the PC, not the workspace: its words say so.
  const place = port.rootTag === "folder" ? "folder" : "workspace";
  root.setAttribute("aria-label", place === "folder" ? t("Folder files") : t("Workspace files"));
  // The root row's name until the first read gives the real one (compared below, so one value).
  const WORKSPACE = t("workspace");

  const head = div("pnl-head");
  const title = span("pnl-title", t("Files"));
  const spacer = span("pnl-spacer", "");
  const refreshBtn = button("pnl-btn", "\u21bb", t("Re-read the open folders"));
  head.append(title, spacer, refreshBtn);

  const crumbs = div("pnl-crumbs");
  crumbs.setAttribute("aria-label", t("Current folder"));

  const filterRow = div("pnl-filter-row");
  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "pnl-filter";
  filter.placeholder = t("Filter loaded folders  (f)");
  filter.autocomplete = "off";
  filter.spellcheck = false;
  filter.setAttribute("aria-label", t("Filter loaded folders"));
  const filterNote = div("pnl-filter-note", "");
  filterNote.hidden = true;
  filterRow.append(filter, filterNote);

  const note = div("pnl-note", "");
  note.hidden = true;
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");

  const body = div("pnl-tree");
  body.setAttribute("role", "tree");
  body.setAttribute("aria-label", place === "folder" ? t("Folders and files") : t("Workspace folders and files"));

  const foot = div("pnl-foot", "");
  foot.hidden = true;

  root.append(head, crumbs, filterRow, note, body, foot);
  host.replaceChildren(root);

  const state = {
    sep: "/",
    rootLabel: WORKSPACE,
    rootPath: "",
    rootFull: "",
    current: "",
    expanded: new Set([""]),
    dirs: new Map(),
    selected: null,
    rows: [],
    focusKey: "",
    filter: "",
    rootTried: false,
    destroyed: false,
    now: Date.now(),
    inFlight: false,
    queued: false,
  };

  let lastToast = "";
  let observer = null;

  // A failing read that only reaches the footer is easy to miss, so the same sentence also
  // goes into the live region above the tree, once per distinct message. `quiet` hides that
  // strip when the body already holds the sentence; `toast` is off for the first paint,
  // where the user has not asked for anything yet.
  function notify(text, kind, { quiet = false, toast = true } = {}) {
    note.textContent = text || "";
    note.hidden = !text || quiet;
    note.dataset.kind = text ? kind ?? "error" : "";
    if (text && toast && text !== lastToast) {
      lastToast = text;
      if (port.toast) port.toast(text, kind ?? "error");
    }
    if (!text) lastToast = "";
  }

  // ---- path helpers -----------------------------------------------------------
  // The API speaks the platform's separator (`path.relative` on Windows yields `a\b`),
  // so joining has to follow the root rather than assume a slash.
  const joinRel = (dir, name) => (dir ? `${dir}${state.sep}${name}` : name);
  const baseName = (rel) => {
    const parts = String(rel ?? "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };

  // ---- data -------------------------------------------------------------------
  function classify(err) {
    const status = err?.status ?? err?.statusCode ?? null;
    const text = reasonOf(err);
    if (/bad token/i.test(text)) return t("The app refused this read (its page token is stale). Reload the window.");
    if (/^not a folder:/i.test(text)) return t("That folder is not there any more (moved, deleted, or a drive that is not plugged in).");
    if (status === 403 || /outside the workspace/i.test(text)) {
      return t("That folder is outside the workspace, so it was not listed.");
    }
    if (status === 404 || /cannot list|ENOENT|no such file/i.test(text)) {
      return t("That folder could not be read; it may have moved or been deleted.");
    }
    return t("That folder could not be read: {error}", { error: text });
  }

  async function readDir(rel) {
    if (!port.fetchJson) throw new Error(t("this page did not provide a way to read files"));
    const payload = await withTimeout(port.fetchJson(`/api/files?path=${encodeURIComponent(rel)}`), t("listing {path}", { path: rel || "." }));
    if (!payload || !Array.isArray(payload.dirs) || !Array.isArray(payload.files)) {
      const err = new Error(payload?.error ? String(payload.error) : t("the listing answer was not a listing"));
      if (/outside the workspace/i.test(err.message)) err.status = 403;
      throw err;
    }
    return payload;
  }

  function applyListing(rel, payload) {
    state.dirs.set(rel, {
      entries: { dirs: payload.dirs, files: payload.files, truncated: payload.truncated === true },
      error: null,
      loading: false,
    });
    if (rel === "") {
      state.rootPath = String(payload.path ?? "");
      state.rootFull = String(payload.root ?? "");
      state.sep = state.rootFull.includes("\\") ? "\\" : "/";
      state.rootLabel = baseName(state.rootFull) || WORKSPACE;
      state.current = state.rootPath;
    }
  }

  async function loadDir(rel, { force = false } = {}) {
    const known = state.dirs.get(rel);
    // One read per folder at a time: mount starts the root read and a refresh asked for in
    // the same tick would otherwise launch a second copy and report the same failure twice.
    if (known?.loading) return known;
    if (known && !force && !known.error) return known;
    state.dirs.set(rel, { entries: known?.entries ?? null, error: null, loading: true });
    render();
    try {
      const payload = await readDir(rel);
      applyListing(rel, payload);
      notify("");
    } catch (err) {
      const message = classify(err);
      state.dirs.set(rel, { entries: known?.entries ?? null, error: message, loading: false });
      const firstRootTry = rel === "" && !state.rootTried;
      if (rel === "") state.rootTried = true;
      // The first failed root read is answered in the body; a retry or a deeper folder is a
      // result the user asked for, so it earns a toast, and rows on screen need the strip.
      notify(message, "error", { quiet: rel === "" && !known?.entries, toast: !firstRootTry });
    } finally {
      render();
    }
    return state.dirs.get(rel);
  }

  // ---- filtering --------------------------------------------------------------
  // Filtering a lazy tree can only see what has been opened. The note under the box says
  // exactly that, because a filter that quietly misses unopened folders would be a lie.
  function visibleRows() {
    const all = state.rows;
    const query = state.filter.trim().toLowerCase();
    if (!query) return all;
    const byRel = new Map();
    for (const row of all) if (row.rel) byRel.set(row.rel, row);
    const match = new Set(all.filter((row) => row.name && row.name.toLowerCase().includes(query)).map((row) => row.rel));
    const keep = new Set(match);
    for (const rel of match) {
      let parent = byRel.get(rel)?.parentRel ?? null;
      while (parent != null && !keep.has(parent)) {
        keep.add(parent);
        parent = byRel.get(parent)?.parentRel ?? null;
      }
    }
    for (const row of all) {
      if (!row.rel || keep.has(row.rel)) continue;
      let parent = row.parentRel ?? null;
      while (parent != null) {
        if (match.has(parent)) {
          keep.add(row.rel);
          break;
        }
        parent = byRel.get(parent)?.parentRel ?? null;
      }
    }
    return all.filter((row) => (row.rel ? keep.has(row.rel) : popNoteKept(row, keep)));
  }

  function popNoteKept(row, keep) {
    // Notes ("empty folder", "capped", an error) belong to a directory: they stay only if
    // that directory is still in the filtered view.
    if (row.parentRel == null) return true;
    return keep.has(row.parentRel);
  }

  // ---- rendering --------------------------------------------------------------
  function buildRows() {
    const out = [];
    const push = (row) => out.push(row);
    const walk = (rel, depth) => {
      const entry = state.dirs.get(rel);
      // A re-read keeps the rows it already has on screen: blanking a folder while its
      // listing is refreshed is a flicker, not a loading state.
      if (!entry || !entry.entries) {
        if (entry?.error && rel !== "") push({ kind: "note", parentRel: rel, depth, text: entry.error });
        return;
      }
      for (const dir of entry.entries.dirs) {
        const childRel = joinRel(rel, dir.name);
        const open = state.expanded.has(childRel);
        push({ kind: "dir", rel: childRel, parentRel: rel, name: dir.name, depth, at: dir.at, link: !!dir.link, open });
        if (open) walk(childRel, depth + 1);
      }
      for (const file of entry.entries.files) {
        push({ kind: "file", rel: joinRel(rel, file.name), parentRel: rel, name: file.name, depth, size: file.size, at: file.at, link: !!file.link });
      }
      if (!entry.entries.dirs.length && !entry.entries.files.length) {
        push({ kind: "note", parentRel: rel, depth, text: t("empty folder") });
      }
      if (entry.entries.truncated) {
        push({ kind: "note", parentRel: rel, depth, text: t("the listing was capped; some entries are not shown") });
      }
    };

    // The workspace root is a row of its own, so the tree has exactly one top-level item
    // and every level below it can be reached by keyboard from that one place.
    push({ kind: "root", rel: "", parentRel: null, name: state.rootLabel, depth: 0, open: state.expanded.has("") });
    if (state.expanded.has("")) walk("", 1);

    state.rows = out;
    return out;
  }

  function rowKey(row) {
    // Keyed by path, never by position: a row keeps its identity across expansion,
    // filtering and a re-read, which is what lets focus survive a redraw.
    if (row.kind === "root") return "root";
    if (row.rel) return `${row.kind}:${row.rel}`;
    return `note:${row.parentRel ?? ""}:${row.text ?? ""}`;
  }

  function render() {
    state.now = Date.now();
    buildRows();
    const rows = visibleRows();
    const byRel = new Map();
    for (const row of state.rows) if (row.rel) byRel.set(row.rel, row);
    for (const row of state.rows) row.byRel = byRel;

    const focusedKey = body.contains(document.activeElement) ? document.activeElement.dataset?.key ?? null : null;

    const frag = document.createDocumentFragment();
    let index = 0;
    for (const row of rows) {
      row.index = index;
      index += 1;
      frag.append(buildRow(row));
    }

    const rootEntry = state.dirs.get("");
    if (!rootEntry?.entries) {
      // A folder that was never read has nothing to list, so the reason goes where the
      // rows would have been - a 403 is a sentence, never an empty tree.
      if (rootEntry?.error) {
        const block = div("pnl-empty");
        block.append(div("pnl-empty-line", rootEntry.error));
        const retry = button("pnl-btn pnl-empty-btn", t("Retry"), place === "folder" ? t("Read the folder again") : t("Read the workspace again"));
        retry.addEventListener("click", () => void loadDir("", { force: true }));
        block.append(retry);
        frag.append(block);
      } else {
        frag.append(div("pnl-fnote", place === "folder" ? t("reading the folder\u2026") : t("reading the workspace\u2026")));
      }
    }

    if (rows.length && !rows.some((row) => row.kind !== "root") && state.filter.trim()) {
      const none = div("pnl-fnote", t("No loaded name contains \u201c{query}\u201d.", { query: state.filter.trim() }));
      none.setAttribute("role", "status");
      frag.append(none);
    }

    body.replaceChildren(frag);
    renderCrumbs();
    renderFoot();

    const focusRow = rows.find((row) => rowKey(row) === state.focusKey);
    const fallback = rows[0];
    const target = focusRow ?? fallback;
    for (const el of body.querySelectorAll(".pnl-frow")) el.tabIndex = -1;
    if (target) {
      target.index = target.index ?? 0;
      state.focusKey = rowKey(target);
      const el = body.querySelector(`[data-key="${cssEscape(state.focusKey)}"]`);
      if (el) el.tabIndex = 0;
    }
    if (focusedKey) {
      const back = body.querySelector(`[data-key="${cssEscape(focusedKey)}"]`);
      if (back) back.focus({ preventScroll: true });
    }
    filterNote.hidden = !state.filter.trim();
    if (state.filter.trim()) {
      filterNote.textContent = t("filtering loaded folders \u2014 unopened folders are not searched");
    }
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function renderCrumbs() {
    const sep = state.sep;
    const base = state.rootPath;
    let rest = state.current;
    if (base && rest.toLowerCase().startsWith(base.toLowerCase())) rest = rest.slice(base.length).replace(/^[\\/]/, "");
    const parts = rest.split(/[\\/]/).filter(Boolean);
    const frag = document.createDocumentFragment();
    const makeCrumb = (label, path, isLast) => {
      const el = button(`pnl-crumb${isLast ? " is-current" : ""}`, label);
      el.title = path ? path : state.rootFull || state.rootPath;
      if (isLast) el.setAttribute("aria-current", "location");
      el.addEventListener("click", () => void goTo(path));
      return el;
    };
    frag.append(makeCrumb(state.rootLabel, state.rootPath || "", parts.length === 0));
    let cursor = state.rootPath;
    parts.forEach((part, i) => {
      frag.append(span("pnl-crumb-sep", "\u203a"));
      cursor = joinRel(cursor, part);
      frag.append(makeCrumb(part, cursor, i === parts.length - 1));
    });
    crumbs.replaceChildren(frag);
  }

  function renderFoot() {
    const rootEntry = state.dirs.get("");
    const lines = [];
    if (rootEntry?.entries?.truncated) lines.push(t("This folder was capped at 2000 entries; the rest were not listed."));
    if (state.selected) lines.push(t("Selected: {path}", { path: state.selected }));
    foot.hidden = lines.length === 0;
    foot.textContent = lines.join(" \u00b7 ");
  }

  function buildRow(row) {
    if (row.kind === "note") {
      const el = div("pnl-fnote", row.text);
      el.style.paddingLeft = `${8 + row.depth * 14}px`;
      return el;
    }

    const isDir = row.kind === "dir" || row.kind === "root";
    const el = div(`pnl-frow is-${row.kind}`, "");
    el.setAttribute("role", "treeitem");
    el.setAttribute("aria-level", String(row.depth + 1));
    el.dataset.key = rowKey(row);
    el.dataset.rel = row.rel ?? "";
    el.tabIndex = -1;
    el.style.paddingLeft = `${8 + row.depth * 14}px`;
    if (isDir) el.setAttribute("aria-expanded", String(!!row.open));
    if (row.kind === "file") {
      el.setAttribute("aria-selected", String(state.selected === row.rel));
      if (state.selected === row.rel) el.classList.add("is-selected");
    }
    if (row.link) el.classList.add("is-link");

    const chev = span("pnl-fchev", isDir ? (row.open ? "\u25be" : "\u25b8") : "");
    if (!isDir) chev.setAttribute("aria-hidden", "true");
    const name = span("pnl-fname", row.name ?? "");
    if (state.filter.trim()) markHit(name, row.name ?? "", state.filter.trim());

    el.append(chev, name);
    if (row.link) {
      const mark = span("pnl-flink", t("link"));
      mark.title = t("Symbolic link; it is shown but never followed automatically");
      el.append(mark);
    }
    if (row.kind === "root") {
      // The badge says what the row is; it is dropped when the name already says it (a
      // failed first read leaves no real path, so the row is just "workspace" once).
      // A folder tab (+ > Folder…) is not the workspace, so it says "folder".
      const tag = span("pnl-fmeta", port.rootTag === "folder" ? t("folder") : port.rootTag ?? WORKSPACE);
      if (row.name !== WORKSPACE) el.append(tag);
    }
    const meta = span("pnl-fmeta");
    if (row.kind === "file") {
      meta.append(span("pnl-fsize", fmtSize(row.size)), span("pnl-ftime", fmtAgo(row.at, state.now)));
    } else if (row.kind === "dir") {
      meta.append(span("pnl-ftime", fmtAgo(row.at, state.now)));
    }
    el.append(meta);

    if (row.kind === "dir" && state.expanded.has(row.rel) && state.dirs.get(row.rel)?.loading) {
      el.classList.add("is-busy");
      el.setAttribute("aria-busy", "true");
    }

    el.addEventListener("click", () => activate(row));
    el.addEventListener("focus", () => {
      state.focusKey = rowKey(row);
      for (const other of body.querySelectorAll(".pnl-frow")) other.tabIndex = -1;
      el.tabIndex = 0;
      if (row.rel != null) {
        // The breadcrumb follows the row you are on, so a deep folder shows its real path
        // even while its siblings stay open.
        state.current = isDir ? row.rel : row.parentRel ?? "";
        renderCrumbs();
      }
    });
    return el;
  }

  function markHit(target, text, query) {
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return;
    target.textContent = "";
    if (at > 0) target.append(document.createTextNode(text.slice(0, at)));
    const mark = document.createElement("mark");
    mark.className = "pnl-hit";
    mark.textContent = text.slice(at, at + query.length);
    target.append(mark);
    if (at + query.length < text.length) target.append(document.createTextNode(text.slice(at + query.length)));
  }

  // ---- actions ----------------------------------------------------------------
  function toggle(row) {
    if (state.expanded.has(row.rel)) {
      state.expanded.delete(row.rel);
      render();
      focusKey(rowKey(row));
      return;
    }
    state.expanded.add(row.rel);
    if (!state.dirs.get(row.rel)?.entries) {
      state.focusKey = rowKey(row);
      void loadDir(row.rel);
    } else {
      render();
      focusKey(rowKey(row));
    }
  }

  function selectFile(row) {
    state.selected = row.rel;
    state.current = row.parentRel ?? "";
    render();
    focusKey(rowKey(row));
    const handle = apiHandle;
    if (handle && typeof handle.onSelect === "function") {
      const entry = state.dirs.get(row.parentRel ?? "")?.entries;
      const found = (entry?.files ?? []).find((file) => file.name === row.name);
      handle.onSelect(row.rel, { name: row.name, size: found?.size ?? null, at: found?.at ?? null, link: !!found?.link });
    }
  }

  function activate(row) {
    if (row.kind === "file") return selectFile(row);
    if (row.rel == null) return;
    return toggle(row);
  }

  function focusKey(key) {
    state.focusKey = key;
    const el = body.querySelector(`[data-key="${cssEscape(key)}"]`);
    if (!el) return;
    for (const other of body.querySelectorAll(".pnl-frow")) other.tabIndex = -1;
    el.tabIndex = 0;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }

  async function goTo(path) {
    const target = path ?? "";
    // Open the chain from the root down to the target, so its row exists to be focused.
    const parts = String(target).split(/[\\/]/).filter(Boolean);
    let cursor = "";
    state.expanded.add("");
    for (const part of parts) {
      cursor = joinRel(cursor, part);
      state.expanded.add(cursor);
      if (!state.dirs.get(cursor)?.entries) await loadDir(cursor);
    }
    state.current = target;
    render();
    focusKey(target === "" ? "root" : `dir:${target}`);
  }

  function onTreeKey(event) {
    const focusEl = event.target.closest?.(".pnl-frow");
    if (!focusEl) return;
    const rows = [...body.querySelectorAll(".pnl-frow")];
    const at = rows.indexOf(focusEl);
    const row = state.rows.find((candidate) => rowKey(candidate) === focusEl.dataset.key);
    if (!row) return;
    const move = (next) => {
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    };
    switch (event.key) {
      case "ArrowDown":
        move(rows[at + 1]);
        break;
      case "ArrowUp":
        move(rows[at - 1]);
        break;
      case "Home":
        move(rows[0]);
        break;
      case "End":
        move(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (row.kind === "dir" || row.kind === "root") {
          event.preventDefault();
          if (!state.expanded.has(row.rel)) toggle(row);
          else {
            const next = state.rows[state.rows.findIndex((candidate) => rowKey(candidate) === rowKey(row)) + 1];
            if (next && next.parentRel === row.rel) {
              const childEl = body.querySelector(`[data-key="${cssEscape(rowKey(next))}"]`);
              if (childEl) {
                childEl.focus();
                childEl.scrollIntoView({ block: "nearest" });
              }
            }
          }
        }
        break;
      case "ArrowLeft":
        if (row.kind === "file") {
          event.preventDefault();
          const parentEl = body.querySelector(`[data-key="${cssEscape(`dir:${row.parentRel ?? ""}`)}"]`);
          if (parentEl) parentEl.focus();
          break;
        }
        event.preventDefault();
        if (state.expanded.has(row.rel) && row.rel !== "") toggle(row);
        else if (row.parentRel != null) {
          const parentEl = body.querySelector(`[data-key="${cssEscape(row.parentRel === "" ? "root" : `dir:${row.parentRel}`)}"]`);
          if (parentEl) parentEl.focus();
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(row);
        break;
      default:
        break;
    }
  }

  // ---- refresh ----------------------------------------------------------------
  async function refresh() {
    if (state.destroyed || state.inFlight) {
      if (state.inFlight) state.queued = true;
      return;
    }
    state.inFlight = true;
    try {
      await loadDir("", { force: true });
      // Only folders the person opened are re-read: a refresh must not walk the tree, and
      // a symlinked folder stays unread until someone expands it by hand.
      for (const rel of [...state.expanded]) {
        if (rel === "" || state.dirs.get(rel)?.error) continue;
        await loadDir(rel, { force: true });
      }
    } finally {
      state.inFlight = false;
      if (state.queued) {
        state.queued = false;
        void refresh();
      }
    }
  }

  // ---- wiring -----------------------------------------------------------------
  refreshBtn.addEventListener("click", () => void refresh());

  let filterTimer = 0;
  filter.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      state.filter = filter.value;
      render();
    }, 80);
  });
  filter.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      filter.value = "";
      state.filter = "";
      render();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const first = body.querySelector(".pnl-frow");
      first?.focus();
    }
  });

  body.addEventListener("keydown", onTreeKey);

  root.addEventListener("keydown", (event) => {
    // `f` focuses the filter unless the person is already typing somewhere.
    const tag = document.activeElement?.tagName;
    if (event.key === "f" && tag !== "INPUT" && tag !== "TEXTAREA") {
      event.preventDefault();
      filter.focus();
      filter.select();
    }
  });

  observer = new ResizeObserver(() => {
    // Row density is pure CSS; the only thing that needs measuring is nothing at all.
    // The observer exists so a future compact rule has a hook and so the panel re-renders
    // its relative times when it becomes visible again after a long hidden stretch.
    if (state.destroyed || !root.isConnected) return;
    if (document.visibilityState === "visible" && Date.now() - state.now > 20_000) render();
  });
  observer.observe(root);

  const onVisibility = () => {
    if (state.destroyed) return;
    if (document.visibilityState === "visible" && Date.now() - state.now > 20_000) render();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const apiHandle = {
    label: t("Files"),
    element: root,
    // The shell assigns this to receive the relative path of the file a person selects.
    onSelect: null,
    refresh: () => refresh(),
    destroy() {
      state.destroyed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
      clearTimeout(filterTimer);
      host.replaceChildren();
    },
  };

  void loadDir("");
  return apiHandle;
}

export const panels = {
  graph: { label: t("Sessions"), mount: mountGraph },
  files: { label: t("Files"), mount: mountFiles },
};

export default panels;
