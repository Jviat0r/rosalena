// Paper Reader: a PDF and research-paper reader for Rosalena.
//
// pdf.js (from /plugin-lib/pdfjs, its worker running on this page's thread) renders each
// page to a canvas with a selectable text layer on top. Highlights are stored in PDF
// coordinates, so they stay on their words at any zoom or rotation, and they live in
// Rosalena.storage under the SHA-256 of the file's bytes: opening the same file again
// brings them back, whatever it is called.

import { buildSamplePaper, KNOWN_SENTENCE, ABSTRACT_PHRASE, SAMPLE_NAME, SAMPLE_TITLE } from "./sample-paper.js";
import { sha256Hex, sha256HexSync } from "./sha256.js";

const COLORS = [
  { id: "yellow", label: "Yellow", css: "var(--hl-yellow)", md: "yellow" },
  { id: "green", label: "Green", css: "var(--hl-green)", md: "green" },
  { id: "blue", label: "Blue", css: "var(--hl-blue)", md: "blue" },
  { id: "pink", label: "Pink", css: "var(--hl-pink)", md: "pink" },
];
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const CACHE_LIMIT = 320 * 1024; // files this small are kept so "Recent" can reopen them
const CACHE_COUNT = 3;
const SUMMARY_LIMIT = 6000;
const QUOTE_LIMIT = 4000;
const WORDS_PER_MINUTE = 230;

// ---------------------------------------------------------------- icons

const ICONS = {
  open: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 1.7h6.2A1.5 1.5 0 0 1 17 8.2v6.3a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z"/>',
  sidebar: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 4v12"/>',
  panel: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M12 4v12"/>',
  search: '<circle cx="9" cy="9" r="5"/><path d="m13 13 3.5 3.5"/>',
  up: '<path d="m5.5 12 4.5-4.5 4.5 4.5"/>',
  down: '<path d="m5.5 8 4.5 4.5 4.5-4.5"/>',
  chev: '<path d="m6 8 4 4 4-4"/>',
  minus: '<path d="M5 10h10"/>',
  plus: '<path d="M5 10h10M10 5v10"/>',
  rotate: '<path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9"/><path d="M14.6 3.2v3.3h-3.3"/>',
  close: '<path d="m6 6 8 8M14 6l-8 8"/>',
  home: '<path d="M3.5 9 10 3.8 16.5 9v6.5a1 1 0 0 1-1 1h-3.5V12h-4v4.5H4.5a1 1 0 0 1-1-1z"/>',
  note: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3h9A1.5 1.5 0 0 1 16 4.5v7.8L12.3 16H5.5A1.5 1.5 0 0 1 4 14.5z"/><path d="M12 16v-2.5a1 1 0 0 1 1-1h3M7 7h6M7 10h4"/>',
  copy: '<rect x="7" y="7" width="9" height="9" rx="1.5"/><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7"/>',
  sparkle: '<path d="M9 3c.6 3.6 2 5 5.6 5.6-3.6.6-5 2-5.6 5.6-.6-3.6-2-5-5.6-5.6C7 8 8.4 6.6 9 3z"/><path d="M15 12.5c.25 1.4.8 2 2.2 2.2-1.4.25-2 .8-2.2 2.2-.25-1.4-.8-2-2.2-2.2 1.4-.25 2-.8 2.2-2.2z"/>',
  summary: '<path d="M4 5h12M4 8.5h12M4 12h8M4 15.5h5"/>',
  trash: '<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.3a1 1 0 0 0 1 .7h4.6a1 1 0 0 0 1-.7L14 6"/>',
  download: '<path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12"/>',
  file: '<path d="M6 3h5.5L15 6.5V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M11 3v4h4M7.5 11h5M7.5 13.5h3.5"/>',
  edit: '<path d="m12.5 4.5 3 3L8 15H5v-3z"/>',
};

function svgIcon(name, size = 18) {
  return `<svg class="ico" viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

// ---------------------------------------------------------------- state

const state = {
  pdfjs: null,
  doc: null,
  generation: 0,
  hash: null,
  name: "",
  size: 0,
  isSample: false,
  bytes: null,
  pages: [],
  texts: [],
  scale: 1,
  zoomMode: "fit-width",
  rotation: 0,
  current: 1,
  navTarget: null,
  outline: [],
  card: { title: "", author: "", words: null, minutes: null, abstract: "" },
  cardReady: Promise.resolve(),
  outlineReady: Promise.resolve(),
  highlights: [],
  search: { query: "", matches: [], index: -1 },
  recent: [],
  pendingSel: null,
  popFor: null,
};

const el = {};
const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : document.createTextNode(String(c)));
  return node;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;
const fmtInt = (n) => Number(n).toLocaleString("en-US");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const docKey = (hash) => `doc:${hash}`;
const fileKey = (hash) => `file:${hash}`;
const colorCss = (id) => (COLORS.find((c) => c.id === id) ?? COLORS[0]).css;

// ---------------------------------------------------------------- pdf.js

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // A sandboxed frame cannot start a Worker from the server, so the worker runs here.
      const worker = await import("/plugin-lib/pdfjs/pdf.worker.min.mjs");
      globalThis.pdfjsWorker = worker;
      const pdfjs = await import("/plugin-lib/pdfjs/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "/plugin-lib/pdfjs/pdf.worker.min.mjs";
      state.pdfjs = pdfjs;
      return pdfjs;
    })();
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

function viewportFor(p, scale) {
  return p.pdfPage.getViewport({ scale, rotation: (p.pdfPage.rotate + state.rotation) % 360 });
}

// ---------------------------------------------------------------- page text

/** Does a space belong between text item a and the next item b? */
function needsSeparator(a, b) {
  if (a.hasEOL) return true;
  if (!b) return false;
  const ta = a.transform;
  const tb = b.transform;
  if (!ta || !tb) return true;
  const size = Math.hypot(ta[2], ta[3]) || Math.hypot(ta[0], ta[1]) || 10;
  if (Math.abs(ta[5] - tb[5]) > size * 0.5) return true;
  const gap = tb[4] - (ta[4] + (a.width || 0));
  return gap > size * 0.12 || gap < -size;
}

function lowerSameLength(s) {
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/**
 * One page's text as a single string with whitespace collapsed, plus the map from each
 * character back to (text item, offset): search, selection and highlights all go through
 * it, so they agree on what a position means.
 */
function buildPageText(items) {
  let text = "";
  const map = [];
  const pos = [];
  for (let i = 0; i < items.length; i++) {
    const s = items[i].str ?? "";
    const p = new Int32Array(s.length + 1);
    for (let k = 0; k < s.length; k++) {
      p[k] = text.length;
      const ch = s[k];
      if (/\s/.test(ch)) {
        if (!text.length || text[text.length - 1] === " ") continue;
        text += " ";
      } else text += ch;
      map.push(i, k);
    }
    p[s.length] = text.length;
    pos.push(p);
    if (text.length && text[text.length - 1] !== " " && needsSeparator(items[i], items[i + 1])) {
      text += " ";
      map.push(-1, -1);
    }
  }
  return { text, map: Int32Array.from(map), pos, lower: lowerSameLength(text) };
}

function getPageText(n) {
  const p = state.pages[n - 1];
  if (!p) return Promise.reject(new Error(`there is no page ${n}`));
  if (!state.texts[n - 1]) {
    state.texts[n - 1] = p.pdfPage.getTextContent().then((content) => ({ content, ...buildPageText(content.items) }));
  }
  return state.texts[n - 1];
}

const countWords = (s) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

// ---------------------------------------------------------------- opening and closing

async function openBytes(bytes, { name = "document.pdf", isSample = false } = {}) {
  const gen = ++state.generation;
  hideFloating();
  showLoading(`Opening ${name}`);
  try {
    const pdfjs = await loadPdfjs();
    const hash = await sha256Hex(bytes);
    if (gen !== state.generation) return null;
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0, useSystemFonts: true, enableXfa: false });
    task.onPassword = (update, reason) => {
      const wrong = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
      askPassword(name, wrong).then((pw) => {
        if (pw == null) task.destroy();
        else update(pw);
      });
    };
    const doc = await task.promise;
    if (gen !== state.generation) {
      doc.destroy();
      return null;
    }
    const pdfPages = [];
    for (let i = 1; i <= doc.numPages; i++) pdfPages.push(await doc.getPage(i));
    if (gen !== state.generation) {
      doc.destroy();
      return null;
    }

    await teardownDocument();
    Object.assign(state, {
      doc,
      hash,
      name,
      size: bytes.length,
      isSample,
      bytes: !isSample && bytes.length <= CACHE_LIMIT ? bytes : null,
      texts: [],
      highlights: [],
      outline: [],
      rotation: 0,
      current: 1,
      navTarget: null,
      search: { query: "", matches: [], index: -1 },
      card: { title: "", author: "", words: null, minutes: null, abstract: "" },
    });
    const saved = await loadAnnotations();
    state.rotation = [0, 90, 180, 270].includes(saved?.rotation) ? saved.rotation : 0;
    buildPages(pdfPages);
    setView("doc");
    const mode = ["fit-width", "fit-page", "custom"].includes(saved?.zoomMode) ? saved.zoomMode : "fit-width";
    applyZoom(mode, Number(saved?.scale) || 1, { anchor: false });
    drawAllHighlights();
    renderNotes();
    buildThumbs();
    updateTitle();
    renderCard();
    goToPage(clamp(Number(saved?.lastPage) || 1, 1, doc.numPages));
    scheduleRender();
    state.outlineReady = loadOutline(gen);
    state.cardReady = buildCard(gen);
    rememberRecent().catch((err) => toast(`Could not update the recent list: ${err.message}`, { bad: true }));
    hideLoading();
    el.viewer.focus({ preventScroll: true });
    return doc;
  } catch (err) {
    if (gen !== state.generation) return null;
    hideLoading();
    const name_ = err?.name ?? "";
    const msg =
      name_ === "InvalidPDFException"
        ? `${name} is not a readable PDF.`
        : name_ === "PasswordException"
          ? `${name} needs its password to open.`
          : /destroyed|aborted/i.test(String(err?.message))
            ? "Opening was cancelled."
            : `Could not open ${name}: ${err?.message ?? err}`;
    toast(msg, { bad: true });
    return null;
  }
}

async function openSample() {
  const sample = buildSamplePaper();
  return openBytes(sample.bytes, { name: SAMPLE_NAME, isSample: true });
}

async function openFile(file) {
  if (!file) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  if (!head.includes("%PDF") && !/\.pdf$/i.test(file.name)) {
    toast(`${file.name} does not look like a PDF.`, { bad: true });
    return null;
  }
  return openBytes(bytes, { name: file.name });
}

async function teardownDocument() {
  await flushSave().catch(() => {});
  for (const p of state.pages) {
    try {
      p.task?.cancel();
    } catch (_) {
      /* already finished */
    }
  }
  thumbObserver?.disconnect();
  const old = state.doc;
  state.doc = null;
  state.pages = [];
  state.texts = [];
  el.pages.replaceChildren();
  el.thumbs.replaceChildren();
  el.outline.replaceChildren();
  if (old) await old.destroy().catch(() => {});
}

async function closeDocument() {
  state.generation++;
  hideFloating();
  closeSearch();
  await teardownDocument();
  state.hash = null;
  state.highlights = [];
  setView("empty");
  updateTitle();
  renderRecent();
}

// ---------------------------------------------------------------- page layout

function buildPages(pdfPages) {
  el.pages.replaceChildren();
  state.pages = pdfPages.map((pdfPage, i) => {
    const div = h("div", { class: "page", "data-page": i + 1, "aria-label": `Page ${i + 1}` });
    const canvasBox = h("div", { class: "page-canvas" });
    const hlLayer = h("div", { class: "hl-layer" });
    const hitLayer = h("div", { class: "hit-layer" });
    const textLayerDiv = h("div", { class: "textLayer" });
    const pinLayer = h("div", { class: "pin-layer" });
    div.append(canvasBox, hlLayer, hitLayer, textLayerDiv, pinLayer);
    el.pages.append(div);
    return { num: i + 1, pdfPage, div, canvasBox, hlLayer, hitLayer, pinLayer, textLayerDiv, canvas: null, textDivs: null, spanIndex: null, pageText: null, renderedKey: null, renderingKey: null, task: null, textRotation: null };
  });
}

function layoutPages() {
  for (const p of state.pages) {
    const vp = viewportFor(p, state.scale);
    p.div.style.width = `${Math.floor(vp.width)}px`;
    p.div.style.height = `${Math.floor(vp.height)}px`;
    p.div.style.setProperty("--scale-factor", String(state.scale));
  }
}

const pageTop = (p) => p.div.offsetTop + el.pages.offsetTop;

function fitScale(mode) {
  if (!state.pages.length) return 1;
  const availW = el.viewer.clientWidth - 48;
  const availH = el.viewer.clientHeight - 40;
  if (mode === "fit-width") {
    const widest = Math.max(...state.pages.map((p) => viewportFor(p, 1).width));
    return clamp(availW / widest, MIN_SCALE, MAX_SCALE);
  }
  const vp = viewportFor(state.pages[state.current - 1] ?? state.pages[0], 1);
  return clamp(Math.min(availW / vp.width, availH / vp.height), MIN_SCALE, MAX_SCALE);
}

function captureAnchor() {
  const p = state.pages[state.current - 1];
  if (!p) return null;
  const height = p.div.offsetHeight || 1;
  return { p, frac: (el.viewer.scrollTop - pageTop(p)) / height, x: (el.viewer.scrollLeft + el.viewer.clientWidth / 2) / (el.pages.scrollWidth || 1) };
}

function restoreAnchor(a) {
  if (!a) return;
  el.viewer.scrollTop = pageTop(a.p) + a.frac * a.p.div.offsetHeight;
  el.viewer.scrollLeft = a.x * el.pages.scrollWidth - el.viewer.clientWidth / 2;
}

/** Set the zoom: "fit-width", "fit-page" or "custom" with a scale. */
function applyZoom(mode, scale = state.scale, { anchor = true } = {}) {
  const a = anchor ? captureAnchor() : null;
  state.zoomMode = mode;
  state.scale = mode === "custom" ? clamp(scale, MIN_SCALE, MAX_SCALE) : fitScale(mode);
  layoutPages();
  restoreAnchor(a);
  updateZoomUi();
  scheduleRender();
  repositionSelTools();
  saveSoon();
}

async function setZoom(mode, scale) {
  applyZoom(mode, scale);
  await renderVisible();
}

function zoomStep(dir) {
  const s = state.scale;
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > s + 0.001) ?? MAX_SCALE : [...ZOOM_STEPS].reverse().find((z) => z < s - 0.001) ?? MIN_SCALE;
  applyZoom("custom", next);
}

async function rotate(delta = 90) {
  const a = captureAnchor();
  state.rotation = (((state.rotation + delta) % 360) + 360) % 360;
  for (const p of state.pages) {
    p.renderedKey = null;
    p.textRotation = null;
  }
  if (state.zoomMode !== "custom") state.scale = fitScale(state.zoomMode);
  layoutPages();
  restoreAnchor(a);
  drawAllHighlights();
  buildThumbs();
  updateZoomUi();
  saveSoon();
  await renderVisible();
}

// ---------------------------------------------------------------- rendering

const renderKey = () => `${state.scale.toFixed(4)}|${state.rotation}`;

async function renderPage(p) {
  const key = renderKey();
  if (p.renderedKey === key) return;
  if (p.renderingKey === key && p.renderPromise) return p.renderPromise;
  try {
    p.task?.cancel();
  } catch (_) {
    /* nothing to cancel */
  }
  p.renderingKey = key;
  const gen = state.generation;
  const run = (async () => {
    const vp = viewportFor(p, state.scale);
    const dpr = window.devicePixelRatio || 1;
    let out = dpr;
    const maxArea = 16_000_000;
    if (vp.width * vp.height * out * out > maxArea) out = Math.sqrt(maxArea / (vp.width * vp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(vp.width * out));
    canvas.height = Math.max(1, Math.floor(vp.height * out));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = p.pdfPage.render({ canvasContext: ctx, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined });
    p.task = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name === "RenderingCancelledException") return;
      throw err;
    } finally {
      if (p.task === task) p.task = null;
    }
    if (gen !== state.generation || p.renderingKey !== key) return;
    p.canvasBox.replaceChildren(canvas);
    p.canvas = canvas;
    p.renderedKey = key;
    p.div.classList.add("rendered");
    await ensureTextLayer(p);
    if (gen !== state.generation) return;
    drawHighlights(p);
    drawHits(p);
  })();
  p.renderPromise = run;
  try {
    await run;
  } finally {
    if (p.renderPromise === run) p.renderPromise = null;
  }
}

async function ensureTextLayer(p) {
  if (p.textDivs && p.textRotation === state.rotation) return;
  const pt = await getPageText(p.num);
  const div = h("div", { class: "textLayer" });
  const layer = new state.pdfjs.TextLayer({ textContentSource: pt.content, container: div, viewport: viewportFor(p, state.scale) });
  await layer.render();
  div.append(h("div", { class: "endOfContent" }));
  div.addEventListener("mousedown", () => div.classList.add("selecting"));
  p.textLayerDiv.replaceWith(div);
  p.textLayerDiv = div;
  p.textDivs = layer.textDivs;
  p.spanIndex = new Map(p.textDivs.map((d, i) => [d, i]));
  p.pageText = pt;
  p.textRotation = state.rotation;
}

function visiblePages(margin = 400) {
  const top = el.viewer.scrollTop - margin;
  const bottom = el.viewer.scrollTop + el.viewer.clientHeight + margin;
  return state.pages.filter((p) => {
    const t = pageTop(p);
    return t < bottom && t + p.div.offsetHeight > top;
  });
}

let renderTimer = null;
let pumping = null;
let pumpAgain = false;

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderVisible().catch((err) => toast(`A page did not render: ${err.message}`, { bad: true }));
  }, 16);
}

/** Render the pages in view (nearest first) and free the far ones. */
async function renderVisible() {
  if (pumping) {
    pumpAgain = true;
    return pumping;
  }
  pumping = (async () => {
    do {
      pumpAgain = false;
      const vis = visiblePages()
        .sort((a, b) => Math.abs(a.num - state.current) - Math.abs(b.num - state.current))
        .slice(0, 6);
      // In parallel: pdf.js paints in animation frames, so pages drawn together share them.
      await Promise.all(vis.map((p) => renderPage(p)));
    } while (pumpAgain);
    for (const p of state.pages) {
      if (p.canvas && Math.abs(p.num - state.current) > 6) {
        p.canvasBox.replaceChildren();
        p.canvas = null;
        p.renderedKey = null;
        p.div.classList.remove("rendered");
      }
    }
  })();
  try {
    await pumping;
  } finally {
    pumping = null;
  }
}

// ---------------------------------------------------------------- navigation

function updateCurrentFromScroll() {
  if (!state.pages.length) return;
  const top = el.viewer.scrollTop;
  const bottom = top + el.viewer.clientHeight;
  let best = state.current;
  let bestVisible = -1;
  for (const p of state.pages) {
    const t = pageTop(p);
    const b = t + p.div.offsetHeight;
    if (b < top) continue;
    if (t > bottom) break;
    const visible = Math.min(b, bottom) - Math.max(t, top);
    if (visible > bestVisible + 1) {
      bestVisible = visible;
      best = p.num;
    }
  }
  if (state.navTarget) {
    const target = state.pages[state.navTarget - 1];
    const t = pageTop(target);
    if (t < bottom && t + target.div.offsetHeight > top) best = state.navTarget;
    else state.navTarget = null;
  }
  if (best !== state.current) {
    state.current = best;
    updatePageUi();
    saveSoon();
  }
}

/** Scroll to page n; `pdfY` (PDF units, from an outline entry) scrolls to that spot on it. */
function goToPage(n, { pdfY = null, smooth = false } = {}) {
  const p = state.pages[clamp(Math.round(n) || 1, 1, state.pages.length) - 1];
  if (!p) return;
  let top = pageTop(p) - 12;
  if (pdfY != null) {
    const [, vy] = viewportFor(p, state.scale).convertToViewportPoint(0, pdfY);
    top = pageTop(p) + vy - 16;
  }
  state.current = p.num;
  state.navTarget = p.num;
  el.viewer.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
  updatePageUi();
  scheduleRender();
  saveSoon();
}

async function goToDest(dest) {
  let d = dest;
  if (typeof d === "string") d = await state.doc.getDestination(d);
  if (!Array.isArray(d) || !d.length) return;
  const ref = d[0];
  let index = 0;
  if (ref && typeof ref === "object") index = await state.doc.getPageIndex(ref);
  else if (Number.isInteger(ref)) index = ref;
  let pdfY = null;
  const kind = d[1]?.name;
  if (kind === "XYZ" && typeof d[3] === "number") pdfY = d[3];
  else if ((kind === "FitH" || kind === "FitBH") && typeof d[2] === "number") pdfY = d[2];
  goToPage(index + 1, { pdfY });
}

// ---------------------------------------------------------------- toolbar state

function setView(view) {
  el.app.dataset.view = view;
  if (view === "doc") {
    if (!ui.chosen) {
      // Until the person toggles them, show the side panels when there is room.
      const width = el.app.clientWidth || window.innerWidth || 1280;
      ui.sidebar = width >= 760;
      ui.panel = width >= 900;
    }
    el.btnSidebar.classList.toggle("on", ui.sidebar);
    el.btnPanel.classList.toggle("on", ui.panel);
    el.app.classList.toggle("no-sidebar", !ui.sidebar);
    el.app.classList.toggle("no-panel", !ui.panel);
  }
}

const ui = { sidebar: true, panel: true, tab: "pages", chosen: false };

function updatePageUi() {
  const n = state.pages.length;
  if (document.activeElement !== el.pageInput) el.pageInput.value = String(state.current);
  el.pageTotal.textContent = `/ ${n}`;
  el.btnPrev.disabled = state.current <= 1;
  el.btnNext.disabled = state.current >= n;
  el.btnSummarize.textContent = "";
  el.btnSummarize.insertAdjacentHTML("afterbegin", svgIcon("summary", 15));
  el.btnSummarize.append(`Summarize page ${state.current}`);
  for (const t of el.thumbs.querySelectorAll(".thumb")) {
    const on = Number(t.dataset.page) === state.current;
    if (t.classList.contains("active") !== on) {
      t.classList.toggle("active", on);
      if (on) t.scrollIntoView({ block: "nearest" });
    }
  }
}

function updateZoomUi() {
  const sel = el.zoomSelect;
  sel.querySelector("option[data-custom]")?.remove();
  if (state.zoomMode === "custom") {
    const v = String(round2(state.scale));
    const match = [...sel.options].find((o) => o.value === v);
    if (match) sel.value = v;
    else {
      const opt = h("option", { value: v, "data-custom": true }, `${Math.round(state.scale * 100)}%`);
      sel.prepend(opt);
      sel.value = v;
    }
  } else sel.value = state.zoomMode;
  el.btnZoomOut.disabled = state.scale <= MIN_SCALE + 0.001;
  el.btnZoomIn.disabled = state.scale >= MAX_SCALE - 0.001;
}

function updateTitle() {
  if (!state.doc) {
    el.docName.textContent = "Paper Reader";
    el.docSub.textContent = "PDF and research-paper reader";
    return;
  }
  const title = state.card.title || state.name;
  el.docName.textContent = title;
  el.docName.title = title;
  const sizeText = state.size >= 1048576 ? `${(state.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(state.size / 1024))} KB`;
  el.docSub.textContent = `${state.name}  ·  ${state.pages.length} page${state.pages.length === 1 ? "" : "s"}  ·  ${sizeText}`;
}

// ---------------------------------------------------------------- thumbnails and outline

let thumbObserver = null;
let thumbQueue = Promise.resolve();

function buildThumbs() {
  thumbObserver?.disconnect();
  el.thumbs.replaceChildren();
  const grid = h("div", { class: "thumbs-grid" });
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        const p = state.pages[Number(e.target.dataset.page) - 1];
        const gen = state.generation;
        thumbQueue = thumbQueue.then(() => (gen === state.generation ? renderThumb(p, e.target) : null)).catch(() => {});
      }
    },
    { root: el.thumbs, rootMargin: "200px" },
  );
  for (const p of state.pages) {
    const vp = viewportFor(p, 1);
    const width = 118;
    const height = Math.round((vp.height / vp.width) * width);
    const box = h("div", { class: "tp", style: `width:${width}px;height:${height}px` });
    const btn = h(
      "button",
      { class: `thumb${p.num === state.current ? " active" : ""}`, "data-page": p.num, title: `Page ${p.num}`, "aria-label": `Go to page ${p.num}`, onclick: () => goToPage(p.num) },
      box,
      h("span", { class: "thumb-num" }, p.num),
    );
    grid.append(btn);
    thumbObserver.observe(btn);
  }
  el.thumbs.append(grid);
  updateThumbBadges();
}

async function renderThumb(p, btn) {
  if (!p || !btn.isConnected) return;
  const box = btn.querySelector(".tp");
  const vp1 = viewportFor(p, 1);
  const dpr = window.devicePixelRatio || 1;
  const vp = viewportFor(p, (118 * dpr) / vp1.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
  box.querySelector("canvas")?.remove();
  box.prepend(canvas);
}

function updateThumbBadges() {
  const counts = new Map();
  for (const hl of state.highlights) counts.set(hl.page, (counts.get(hl.page) ?? 0) + 1);
  for (const t of el.thumbs.querySelectorAll(".thumb")) {
    const box = t.querySelector(".tp");
    box.querySelector(".tdot")?.remove();
    const c = counts.get(Number(t.dataset.page));
    if (c) box.append(h("span", { class: "tdot", title: `${c} highlight${c === 1 ? "" : "s"}` }, c));
  }
}

async function loadOutline(gen) {
  let items = [];
  try {
    items = (await state.doc.getOutline()) ?? [];
  } catch (_) {
    items = [];
  }
  if (gen !== state.generation) return;
  state.outline = items;
  el.tabOutline.hidden = !items.length;
  if (!items.length && ui.tab === "outline") selectTab("pages");
  el.outline.replaceChildren();
  if (!items.length) return;
  const pageOf = async (dest) => {
    try {
      let d = dest;
      if (typeof d === "string") d = await state.doc.getDestination(d);
      if (!Array.isArray(d)) return null;
      if (d[0] && typeof d[0] === "object") return (await state.doc.getPageIndex(d[0])) + 1;
      return Number.isInteger(d[0]) ? d[0] + 1 : null;
    } catch (_) {
      return null;
    }
  };
  const build = async (list, depth) => {
    const ul = h("ul");
    for (const item of list) {
      const kids = item.items ?? [];
      const page = item.dest ? await pageOf(item.dest) : null;
      const li = h("li");
      const toggle = kids.length
        ? h("button", { class: "ol-toggle", "aria-label": "Expand or collapse", html: svgIcon("chev", 14), onclick: () => { li.classList.toggle("collapsed"); toggle.classList.toggle("closed"); } })
        : h("span", { class: "ol-spacer" });
      const btn = h("button", { class: "ol-item", title: item.title, disabled: !item.dest, onclick: () => goToDest(item.dest).catch((err) => toast(`That outline entry has no target: ${err.message}`, { bad: true })) }, item.title || "(untitled)");
      li.append(h("div", { class: "ol-row" }, toggle, btn, page ? h("span", { class: "ol-page" }, page) : null));
      if (kids.length) {
        li.append(await build(kids, depth + 1));
        if (depth > 0) {
          li.classList.add("collapsed");
          toggle.classList.add("closed");
        }
      }
      ul.append(li);
    }
    return ul;
  };
  const tree = await build(items, 0);
  if (gen === state.generation) el.outline.append(tree);
}

function selectTab(tab) {
  ui.tab = tab;
  el.tabPages.classList.toggle("on", tab === "pages");
  el.tabOutline.classList.toggle("on", tab === "outline");
  el.tabPages.setAttribute("aria-selected", String(tab === "pages"));
  el.tabOutline.setAttribute("aria-selected", String(tab === "outline"));
  el.thumbs.hidden = tab !== "pages";
  el.outline.hidden = tab !== "outline";
}

// ---------------------------------------------------------------- paper card

function cleanMeta(v) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s || s.length < 3) return "";
  if (/^(untitled|document\d*|microsoft word.*|title)$/i.test(s) || /\.(pdf|docx?|tex|dvi|indd|ps)$/i.test(s)) return "";
  return s;
}

async function titleFromFirstPage() {
  const pt = await getPageText(1);
  const vp = viewportFor(state.pages[0], 1);
  const items = pt.content.items.filter((it) => it.str && it.str.trim() && it.transform);
  if (!items.length) return "";
  const sizeOf = (it) => Math.hypot(it.transform[2], it.transform[3]);
  const upper = items.filter((it) => it.transform[5] > vp.viewBox[3] * 0.45);
  const pool = upper.length ? upper : items;
  const max = Math.max(...pool.map(sizeOf));
  const title = pool.filter((it) => sizeOf(it) >= max - 0.5).map((it) => it.str.trim()).join(" ").replace(/\s+/g, " ").trim();
  return title.length >= 4 && title.length <= 220 ? title : "";
}

function findAbstract(text) {
  const m = /\babstract\b[\s.:—-]*/i.exec(text);
  if (!m) return "";
  let rest = text.slice(m.index + m[0].length);
  const stop = rest.search(/\b(1\.?\s+Introduction|Introduction|Keywords|Index Terms)\b/);
  if (stop > 80) rest = rest.slice(0, stop);
  rest = rest.trim();
  if (rest.length > 900) rest = `${rest.slice(0, rest.lastIndexOf(" ", 900))}…`;
  return rest;
}

async function buildCard(gen) {
  const doc = state.doc;
  let info = {};
  let metadata = null;
  try {
    ({ info = {}, metadata = null } = await doc.getMetadata());
  } catch (_) {
    /* no metadata */
  }
  if (gen !== state.generation) return;
  let title = cleanMeta(metadata?.get?.("dc:title")) || cleanMeta(info.Title);
  if (!title) title = (await titleFromFirstPage().catch(() => "")) || state.name.replace(/\.pdf$/i, "");
  const creators = metadata?.get?.("dc:creator");
  const author = cleanMeta(Array.isArray(creators) ? creators.join(", ") : creators) || cleanMeta(info.Author);
  if (gen !== state.generation) return;
  Object.assign(state.card, { title, author });
  updateTitle();
  renderCard();

  let words = 0;
  for (let i = 1; i <= state.pages.length; i++) {
    const pt = await getPageText(i);
    if (gen !== state.generation) return;
    words += countWords(pt.text);
    if (i === 1) state.card.abstract = findAbstract(pt.text);
    if (i % 8 === 0 || i === state.pages.length) {
      state.card.words = words;
      state.card.partial = i < state.pages.length;
      renderCard();
      await wait(0);
    }
  }
  state.card.words = words;
  state.card.minutes = words / WORDS_PER_MINUTE;
  state.card.partial = false;
  renderCard();
}

function renderCard() {
  const c = state.card;
  el.cardTitle.textContent = c.title || state.name || "Untitled";
  el.cardAuthors.hidden = !c.author;
  el.cardAuthors.textContent = c.author || "";
  el.statPages.textContent = fmtInt(state.pages.length);
  el.statWords.textContent = c.words == null ? "…" : `${fmtInt(c.words)}${c.partial ? "+" : ""}`;
  el.statRead.textContent = c.minutes == null ? "…" : c.minutes < 1 ? "< 1 min" : c.minutes < 90 ? `${Math.ceil(c.minutes)} min` : `${(c.minutes / 60).toFixed(1)} h`;
  el.cardAbstract.hidden = !c.abstract;
  el.cardAbstractText.textContent = c.abstract || "";
}

// ---------------------------------------------------------------- search

let searchToken = 0;

function normalizeQuery(q) {
  return String(q ?? "").replace(/\s+/g, " ").trim();
}

/** Find every match of `query` (case-insensitive). Resolves to the number of matches. */
async function runSearch(query) {
  const token = ++searchToken;
  const q = normalizeQuery(query);
  state.search = { query: q, matches: [], index: -1 };
  clearHits();
  if (!q || !state.doc) {
    updateFindUi();
    return 0;
  }
  const needle = lowerSameLength(q);
  const matches = [];
  for (let n = 1; n <= state.pages.length; n++) {
    const pt = await getPageText(n);
    if (token !== searchToken) return state.search.matches.length;
    let at = pt.lower.indexOf(needle);
    while (at !== -1) {
      matches.push({ page: n, start: at, end: at + needle.length });
      at = pt.lower.indexOf(needle, at + needle.length);
    }
    if (n % 25 === 0) {
      state.search.matches = matches.slice();
      updateFindUi(true);
      await wait(0);
    }
  }
  if (token !== searchToken) return state.search.matches.length;
  state.search.matches = matches;
  const first = matches.findIndex((m) => m.page >= state.current);
  state.search.index = matches.length ? (first === -1 ? 0 : first) : -1;
  updateFindUi();
  for (const p of state.pages) drawHits(p);
  if (matches.length) await showMatch(state.search.index);
  return matches.length;
}

async function searchStep(dir) {
  const { matches } = state.search;
  if (!matches.length) return;
  const next = (state.search.index + dir + matches.length) % matches.length;
  await showMatch(next);
}

async function showMatch(i) {
  const m = state.search.matches[i];
  if (!m) return;
  state.search.index = i;
  updateFindUi();
  const p = state.pages[m.page - 1];
  goToPage(m.page);
  await renderPage(p);
  for (const q of state.pages) if (q.hitLayer.childElementCount) drawHits(q);
  const cur = p.hitLayer.querySelector(".hit.current");
  if (cur) {
    const t = pageTop(p) + cur.offsetTop - el.viewer.clientHeight * 0.35;
    el.viewer.scrollTop = Math.max(0, t);
    const l = cur.offsetLeft + p.div.offsetLeft - el.viewer.clientWidth / 2;
    if (p.div.offsetWidth > el.viewer.clientWidth) el.viewer.scrollLeft = Math.max(0, l);
  }
  await renderVisible();
}

function clearHits() {
  for (const p of state.pages) p.hitLayer.replaceChildren();
}

function drawHits(p) {
  p.hitLayer.replaceChildren();
  if (!p.textDivs || !state.search.matches.length) return;
  const cur = state.search.matches[state.search.index];
  const pw = p.div.offsetWidth || 1;
  const ph = p.div.offsetHeight || 1;
  for (const m of state.search.matches) {
    if (m.page !== p.num) continue;
    const isCur = m === cur;
    for (const r of rectsForChars(p, p.pageText, m.start, m.end)) {
      p.hitLayer.append(
        h("div", {
          class: `hit${isCur ? " current" : ""}`,
          style: `left:${(r.l / pw) * 100}%;top:${(r.t / ph) * 100}%;width:${((r.r - r.l) / pw) * 100}%;height:${((r.b - r.t) / ph) * 100}%`,
        }),
      );
    }
  }
}

function openSearch() {
  if (!state.doc) return;
  el.findbar.hidden = false;
  el.btnSearch.classList.add("on");
  const sel = window.getSelection()?.toString().replace(/\s+/g, " ").trim();
  if (sel && sel.length < 80) el.findInput.value = sel;
  el.findInput.focus();
  el.findInput.select();
  if (el.findInput.value && el.findInput.value !== state.search.query) runSearch(el.findInput.value);
}

function closeSearch() {
  searchToken++;
  el.findbar.hidden = true;
  el.btnSearch.classList.remove("on");
  state.search = { query: "", matches: [], index: -1 };
  clearHits();
}

function updateFindUi(partial = false) {
  const { query, matches, index } = state.search;
  el.findCount.classList.toggle("none", Boolean(query) && !matches.length && !partial);
  el.findCount.textContent = !query ? "" : matches.length ? `${index >= 0 ? index + 1 : "–"} of ${fmtInt(matches.length)}${partial ? "+" : ""}` : partial ? "Searching…" : "No matches";
  el.findPrev.disabled = matches.length < 2;
  el.findNext.disabled = matches.length < 2;
}

// ---------------------------------------------------------------- geometry

/** A DOM Range over page characters [s, e) of the page text. */
function rangeForChars(p, pt, s, e) {
  let startItem = -1;
  let startOff = 0;
  let endItem = -1;
  let endOff = 0;
  for (let k = s; k < e; k++) {
    const it = pt.map[2 * k];
    if (it < 0) continue;
    if (startItem < 0) {
      startItem = it;
      startOff = pt.map[2 * k + 1];
    }
    endItem = it;
    endOff = pt.map[2 * k + 1] + 1;
  }
  const a = p.textDivs?.[startItem]?.firstChild;
  const b = p.textDivs?.[endItem]?.firstChild;
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a, startOff);
  r.setEnd(b, Math.min(endOff, b.length));
  return r;
}

/** Page characters covered by a DOM range, clipped to this page: [s, e] or null. */
function rangeToChars(p, pt, r) {
  let s = null;
  let e = null;
  for (let i = 0; i < p.textDivs.length; i++) {
    const span = p.textDivs[i];
    if (!r.intersectsNode(span)) continue;
    const tn = span.firstChild;
    const len = span.textContent.length;
    let a = 0;
    let b = len;
    if (tn && r.startContainer === tn) a = r.startOffset;
    else if (r.startContainer === span) a = r.startOffset > 0 ? len : 0;
    if (tn && r.endContainer === tn) b = r.endOffset;
    else if (r.endContainer === span) b = r.endOffset > 0 ? len : 0;
    if (a >= b) continue;
    const ps = pt.pos[i][a];
    const pe = pt.pos[i][b];
    if (s === null) s = ps;
    e = pe;
  }
  return s === null || e <= s ? null : [s, e];
}

/** Client rects of page characters [s, e), relative to the page box and merged by line. */
function rectsForChars(p, pt, s, e) {
  const groups = new Map();
  for (let k = s; k < e; k++) {
    const it = pt.map[2 * k];
    if (it < 0) continue;
    const off = pt.map[2 * k + 1];
    const g = groups.get(it);
    if (g) {
      g.a = Math.min(g.a, off);
      g.b = Math.max(g.b, off + 1);
    } else groups.set(it, { a: off, b: off + 1 });
  }
  const base = p.div.getBoundingClientRect();
  const out = [];
  for (const [it, g] of groups) {
    const node = p.textDivs[it]?.firstChild;
    if (!node) continue;
    const r = document.createRange();
    r.setStart(node, Math.min(g.a, node.length));
    r.setEnd(node, Math.min(g.b, node.length));
    for (const cr of r.getClientRects()) out.push({ l: cr.left - base.left, t: cr.top - base.top, r: cr.right - base.left, b: cr.bottom - base.top });
  }
  return mergeRects(out, state.rotation % 180 !== 0);
}

function mergeRects(rects, vertical = false) {
  const flip = (r) => ({ l: r.t, t: r.l, r: r.b, b: r.r });
  let list = rects.filter((r) => r.r - r.l > 0.5 && r.b - r.t > 0.5);
  if (vertical) list = list.map(flip);
  list.sort((a, b) => a.t - b.t || a.l - b.l);
  const out = [];
  for (const r of list) {
    const hgt = r.b - r.t;
    const same = out.find((o) => {
      const overlap = Math.min(o.b, r.b) - Math.max(o.t, r.t);
      const minH = Math.min(o.b - o.t, hgt);
      return overlap > minH * 0.5 && r.l <= o.r + minH * 0.6 && r.r >= o.l - minH * 0.6;
    });
    if (same) {
      same.l = Math.min(same.l, r.l);
      same.r = Math.max(same.r, r.r);
      same.t = Math.min(same.t, r.t);
      same.b = Math.max(same.b, r.b);
    } else out.push({ ...r });
  }
  return vertical ? out.map(flip) : out;
}

/** Turn a DOM range into { page, text, rects (PDF space) } for the first page it touches. */
function selectionInfo(range) {
  for (const p of state.pages) {
    if (!p.textDivs || !range.intersectsNode(p.textLayerDiv)) continue;
    const pt = p.pageText;
    const chars = rangeToChars(p, pt, range);
    if (!chars) continue;
    let [s, e] = chars;
    while (s < e && pt.text[s] === " ") s++;
    while (e > s && pt.text[e - 1] === " ") e--;
    if (e <= s) continue;
    const vp = viewportFor(p, state.scale);
    const rects = rectsForChars(p, pt, s, e).map((r) => {
      const [x1, y1] = vp.convertToPdfPoint(r.l, r.t);
      const [x2, y2] = vp.convertToPdfPoint(r.r, r.b);
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map(round2);
    });
    if (!rects.length) continue;
    return { page: p.num, text: pt.text.slice(s, e), rects };
  }
  return null;
}

/** Highlight rect (PDF space) as percentages of the page box at the current rotation. */
function rectToBox(p, rect) {
  const vp = viewportFor(p, 1);
  const [a, b, c, d] = vp.convertToViewportRectangle(rect);
  return {
    l: (Math.min(a, c) / vp.width) * 100,
    t: (Math.min(b, d) / vp.height) * 100,
    w: (Math.abs(c - a) / vp.width) * 100,
    h: (Math.abs(d - b) / vp.height) * 100,
  };
}

function highlightAt(p, clientX, clientY) {
  const base = p.div.getBoundingClientRect();
  const [x, y] = viewportFor(p, state.scale).convertToPdfPoint(clientX - base.left, clientY - base.top);
  const pad = 1;
  for (let i = state.highlights.length - 1; i >= 0; i--) {
    const hl = state.highlights[i];
    if (hl.page !== p.num) continue;
    if (hl.rects.some(([x1, y1, x2, y2]) => x >= x1 - pad && x <= x2 + pad && y >= y1 - pad && y <= y2 + pad)) return hl;
  }
  return null;
}

// ---------------------------------------------------------------- highlights

function sortHighlights() {
  state.highlights.sort((a, b) => a.page - b.page || (b.rects[0]?.[3] ?? 0) - (a.rects[0]?.[3] ?? 0) || (a.rects[0]?.[0] ?? 0) - (b.rects[0]?.[0] ?? 0));
}

function makeId() {
  return `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function createHighlight(info, color = "yellow", note = "") {
  const hl = { id: makeId(), page: info.page, color, text: info.text, note, rects: info.rects, created: Date.now() };
  state.highlights.push(hl);
  sortHighlights();
  afterHighlightsChanged(hl.page);
  return hl;
}

function updateHighlight(id, patch) {
  const hl = state.highlights.find((x) => x.id === id);
  if (!hl) return null;
  Object.assign(hl, patch);
  afterHighlightsChanged(hl.page);
  return hl;
}

function deleteHighlight(id) {
  const i = state.highlights.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [gone] = state.highlights.splice(i, 1);
  afterHighlightsChanged(gone.page);
  toast("Highlight removed.", {
    action: "Undo",
    onAction: () => {
      state.highlights.push(gone);
      sortHighlights();
      afterHighlightsChanged(gone.page);
    },
  });
}

function afterHighlightsChanged(page) {
  const p = state.pages[page - 1];
  if (p) drawHighlights(p);
  renderNotes();
  updateThumbBadges();
  saveSoon();
}

function drawHighlights(p) {
  p.hlLayer.replaceChildren();
  p.pinLayer.replaceChildren();
  for (const hl of state.highlights) {
    if (hl.page !== p.num) continue;
    hl.rects.forEach((rect, i) => {
      const b = rectToBox(p, rect);
      p.hlLayer.append(h("div", { class: "hl", "data-id": hl.id, style: `--c:${colorCss(hl.color)};left:${b.l}%;top:${b.t}%;width:${b.w}%;height:${b.h}%` }));
      if (i === 0 && hl.note) p.pinLayer.append(h("div", { class: "hl-pin", title: hl.note, style: `left:${b.l + b.w}%;top:${b.t}%` }));
    });
  }
}

function drawAllHighlights() {
  for (const p of state.pages) drawHighlights(p);
}

function flashHighlight(id) {
  for (const node of el.pages.querySelectorAll(`.hl[data-id="${id}"]`)) {
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  }
}

function jumpToHighlight(hl) {
  const p = state.pages[hl.page - 1];
  if (!p) return;
  const top = hl.rects.reduce((m, r) => Math.max(m, r[3]), -Infinity);
  goToPage(hl.page, { pdfY: top + 40 });
  renderVisible().then(() => flashHighlight(hl.id));
}

// ---------------------------------------------------------------- notes panel

function renderNotes() {
  const list = el.notesList;
  list.replaceChildren();
  el.notesCount.textContent = String(state.highlights.length);
  el.btnExport.disabled = !state.highlights.length;
  if (!state.highlights.length) {
    list.append(
      h(
        "div",
        { class: "notes-empty" },
        h("b", {}, "No highlights yet."),
        h("br"),
        "Select text on a page to highlight it, add a note, or ask Rosalena about it.",
      ),
    );
    return;
  }
  let page = -1;
  let group = null;
  for (const hl of state.highlights) {
    if (hl.page !== page) {
      page = hl.page;
      const count = state.highlights.filter((x) => x.page === page).length;
      group = h("div", { class: "note-group", "data-page": page }, h("div", { class: "group-head" }, h("span", {}, `Page ${page}`), h("span", {}, `${count}`)));
      list.append(group);
    }
    const actions = h(
      "div",
      { class: "note-actions" },
      iconButton("edit", hl.note ? "Edit the note" : "Add a note", (e) => {
        e.stopPropagation();
        editNote(hl.id);
      }),
      iconButton("sparkle", "Ask Rosalena to explain this passage", (e) => {
        e.stopPropagation();
        askRosalena(hl.text, hl.page);
      }),
      iconButton("trash", "Remove the highlight", (e) => {
        e.stopPropagation();
        deleteHighlight(hl.id);
      }),
    );
    const item = h(
      "article",
      {
        class: "note-item",
        tabindex: 0,
        "data-id": hl.id,
        style: `--c:${colorCss(hl.color)}`,
        title: `Go to page ${hl.page}`,
        onclick: () => jumpToHighlight(hl),
        onkeydown: (e) => {
          if (e.key === "Enter") jumpToHighlight(hl);
        },
      },
      h("p", { class: "note-quote" }, hl.text),
      hl.note ? h("p", { class: "note-text" }, hl.note) : null,
      actions,
    );
    group.append(item);
  }
}

function iconButton(icon, title, onclick) {
  return h("button", { class: "icon-btn", title, "aria-label": title, html: svgIcon(icon, 15), onclick });
}

async function editNote(id) {
  const hl = state.highlights.find((x) => x.id === id);
  if (!hl) return;
  const value = await openDialog({ title: `Note on page ${hl.page}`, quote: hl.text, value: hl.note, placeholder: "What do you want to remember about this passage?", ok: "Save note" });
  if (value == null) return;
  updateHighlight(id, { note: value.trim() });
  toast(value.trim() ? "Note saved." : "Note cleared.");
}

function notesMarkdown() {
  const title = state.card.title || state.name || "Document";
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`# Notes: ${title}`, ""];
  const meta = [state.name, `${state.pages.length} pages`, `exported ${date}`];
  if (state.card.author) lines.push(`**Authors:** ${state.card.author}`, "");
  lines.push(`*${meta.join(" - ")}*`, "");
  if (!state.highlights.length) {
    lines.push("_No highlights yet._", "");
    return lines.join("\n");
  }
  let page = -1;
  for (const hl of state.highlights) {
    if (hl.page !== page) {
      page = hl.page;
      lines.push(`## Page ${page}`, "");
    }
    for (const line of hl.text.split(/\n/)) lines.push(`> ${line}`);
    lines.push("");
    if (hl.note) {
      const [first, ...rest] = hl.note.split(/\n/);
      lines.push(`**Note:** ${first}`, ...rest, "");
    }
    lines.push(`<sub>${hl.color} highlight</sub>`, "");
  }
  return lines.join("\n");
}

async function exportNotes() {
  const md = notesMarkdown();
  const base = (state.name || "document").replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 80) || "document";
  try {
    const res = await Rosalena.files.save(`${base}-notes.md`, md, "text/markdown");
    toast(`Saved ${base}-notes.md`);
    return res;
  } catch (err) {
    toast(`Could not save the notes: ${err.message}`, { bad: true });
    return null;
  }
}

// ---------------------------------------------------------------- chat

function paperLabel() {
  return state.card.title || state.name || "this document";
}

function truncateSensibly(text, limit) {
  if (text.length <= limit) return { text, cut: false };
  let cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  cut = end > limit * 0.6 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : limit);
  return { text: `${cut} […]`, cut: true };
}

function askText(passage, page) {
  const { text } = truncateSensibly(passage.replace(/\s+/g, " ").trim(), QUOTE_LIMIT);
  return `From "${paperLabel()}" (page ${page} of ${state.pages.length}):\n\n> ${text}\n\nPlease explain this passage.`;
}

async function askRosalena(passage, page) {
  try {
    await Rosalena.chat.compose(askText(passage, page));
    toast("The passage is in the chat box. Add anything you like and send it.");
    return true;
  } catch (err) {
    toast(`Could not reach the chat box: ${err.message}`, { bad: true });
    return false;
  }
}

async function summaryText(page) {
  const pt = await getPageText(page);
  const body = pt.text.trim();
  if (!body) return null;
  const { text, cut } = truncateSensibly(body, SUMMARY_LIMIT);
  return `Please summarize page ${page} of "${paperLabel()}" (${state.pages.length} pages). Here is the text of that page${cut ? " (cut short to fit; the page is longer)" : ""}:\n\n"""\n${text}\n"""`;
}

async function summarizePage(page = state.current) {
  const text = await summaryText(page);
  if (!text) {
    toast(`Page ${page} has no text to summarize (it may be a scanned image).`, { bad: true });
    return false;
  }
  try {
    await Rosalena.chat.compose(text);
    toast(`Page ${page} is in the chat box with a request to summarize it.`);
    return true;
  } catch (err) {
    toast(`Could not reach the chat box: ${err.message}`, { bad: true });
    return false;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    /* the frame may not allow it; fall back below */
  }
  const ta = h("textarea", { style: "position:fixed;left:-9999px;top:0;opacity:0" });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {
    ok = false;
  }
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------- selection tools

function hideFloating() {
  el.seltools.hidden = true;
  el.hlpop.hidden = true;
  state.pendingSel = null;
  state.popFor = null;
}

function placeFloating(node, rect) {
  node.hidden = false;
  const w = node.offsetWidth;
  const hgt = node.offsetHeight;
  const header = el.toolbar.getBoundingClientRect().bottom;
  let left = rect.left + rect.width / 2 - w / 2;
  left = clamp(left, 8, window.innerWidth - w - 8);
  let top = rect.top - hgt - 10;
  if (top < header + 6) top = rect.bottom + 10;
  top = clamp(top, header + 6, window.innerHeight - hgt - 8);
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function checkSelection(event) {
  const sel = window.getSelection();
  for (const p of state.pages) p.textLayerDiv.classList.remove("selecting");
  if (!state.doc) return;
  if (!sel || !sel.rangeCount || sel.isCollapsed) {
    el.seltools.hidden = true;
    state.pendingSel = null;
    const pageDiv = event?.target?.closest?.(".page");
    if (pageDiv) {
      const p = state.pages[Number(pageDiv.dataset.page) - 1];
      const hl = p && highlightAt(p, event.clientX, event.clientY);
      if (hl) return openHighlightPop(hl, { left: event.clientX, top: event.clientY, width: 0, height: 0, bottom: event.clientY });
    }
    el.hlpop.hidden = true;
    return;
  }
  const range = sel.getRangeAt(0);
  const info = selectionInfo(range);
  if (!info) {
    el.seltools.hidden = true;
    return;
  }
  info.fullText = sel.toString().replace(/\s+/g, " ").trim() || info.text;
  state.pendingSel = info;
  el.hlpop.hidden = true;
  placeFloating(el.seltools, range.getBoundingClientRect());
}

function repositionSelTools() {
  if (el.seltools.hidden) return;
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) {
    el.seltools.hidden = true;
    return;
  }
  placeFloating(el.seltools, sel.getRangeAt(0).getBoundingClientRect());
}

function openHighlightPop(hl, rect) {
  state.popFor = hl.id;
  for (const s of el.popSwatches.children) s.classList.toggle("on", s.dataset.color === hl.color);
  placeFloating(el.hlpop, rect);
}

async function selAction(act, color) {
  const info = state.pendingSel;
  if (!info) return;
  if (act === "highlight") {
    createHighlight(info, color);
    window.getSelection()?.removeAllRanges();
    hideFloating();
    return;
  }
  if (act === "note") {
    window.getSelection()?.removeAllRanges();
    hideFloating();
    const value = await openDialog({ title: `Note on page ${info.page}`, quote: info.text, placeholder: "What do you want to remember about this passage?", ok: "Save note" });
    if (value == null) return;
    createHighlight(info, "yellow", value.trim());
    toast("Highlight and note saved.");
    return;
  }
  if (act === "copy") {
    const ok = await copyText(info.fullText || info.text);
    toast(ok ? "Copied." : "Copying is not allowed here; press Ctrl+C instead.", { bad: !ok });
    return;
  }
  if (act === "ask") {
    hideFloating();
    await askRosalena(info.text, info.page);
    return;
  }
  if (act === "summary") {
    hideFloating();
    await summarizePage(info.page);
  }
}

async function popAction(act, color) {
  const hl = state.highlights.find((x) => x.id === state.popFor);
  if (!hl) return hideFloating();
  if (act === "color") {
    updateHighlight(hl.id, { color });
    for (const s of el.popSwatches.children) s.classList.toggle("on", s.dataset.color === color);
    return;
  }
  hideFloating();
  if (act === "note") return editNote(hl.id);
  if (act === "copy") {
    const ok = await copyText(hl.text);
    return toast(ok ? "Copied." : "Copying is not allowed here.", { bad: !ok });
  }
  if (act === "ask") return askRosalena(hl.text, hl.page);
  if (act === "delete") return deleteHighlight(hl.id);
}

// ---------------------------------------------------------------- storage

let saveTimer = null;

function saveSoon() {
  if (!state.hash) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushSave().catch((err) => toast(`Could not save your notes: ${err.message}`, { bad: true }));
  }, 500);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.hash || !state.doc) return;
  const record = {
    v: 1,
    name: state.name,
    title: state.card.title || "",
    pages: state.pages.length,
    highlights: state.highlights,
    lastPage: state.current,
    zoomMode: state.zoomMode,
    scale: round2(state.scale),
    rotation: state.rotation,
    updated: Date.now(),
  };
  await Rosalena.storage.set(docKey(state.hash), record);
  const entry = state.recent.find((r) => r.hash === state.hash);
  if (entry && (entry.notes !== state.highlights.length || entry.title !== record.title)) {
    entry.notes = state.highlights.length;
    entry.title = record.title;
    await Rosalena.storage.set("recent", state.recent);
  }
}

const validRect = (r) => Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(v));

async function loadAnnotations() {
  if (!state.hash) return null;
  const record = await Rosalena.storage.get(docKey(state.hash));
  const list = Array.isArray(record?.highlights) ? record.highlights : [];
  state.highlights = list
    .filter((x) => x && typeof x.id === "string" && Number.isInteger(x.page) && Array.isArray(x.rects) && x.rects.every(validRect))
    .map((x) => ({ id: x.id, page: x.page, color: COLORS.some((c) => c.id === x.color) ? x.color : "yellow", text: String(x.text ?? ""), note: String(x.note ?? ""), rects: x.rects, created: Number(x.created) || 0 }));
  sortHighlights();
  return record;
}

const toBase64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function rememberRecent() {
  const list = ((await Rosalena.storage.get("recent")) ?? []).filter((r) => r && r.hash && r.hash !== state.hash);
  const entry = { hash: state.hash, name: state.name, title: state.card.title || "", pages: state.pages.length, notes: state.highlights.length, opened: Date.now(), sample: state.isSample, cached: false };
  if (state.bytes) {
    try {
      await Rosalena.storage.set(fileKey(state.hash), toBase64(state.bytes));
      entry.cached = true;
    } catch (_) {
      entry.cached = false;
    }
  }
  list.unshift(entry);
  let cachedSeen = 0;
  for (const r of list) {
    if (!r.cached) continue;
    cachedSeen++;
    if (cachedSeen > CACHE_COUNT) {
      r.cached = false;
      await Rosalena.storage.remove(fileKey(r.hash));
    }
  }
  state.recent = list.slice(0, 12);
  for (const r of list.slice(12)) if (r.cached) await Rosalena.storage.remove(fileKey(r.hash));
  await Rosalena.storage.set("recent", state.recent);
}

function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function renderRecent() {
  el.recentList.replaceChildren();
  el.recentWrap.hidden = !state.recent.length;
  for (const r of state.recent.slice(0, 8)) {
    const meta = [`${r.pages} page${r.pages === 1 ? "" : "s"}`, `${r.notes || 0} highlight${r.notes === 1 ? "" : "s"}`, timeAgo(r.opened)];
    const open = h(
      "button",
      { class: "recent-open", title: r.cached || r.sample ? `Open ${r.name}` : `Choose ${r.name} again to reopen it`, onclick: () => openRecent(r) },
      h("span", { html: svgIcon("file", 20) }),
      h(
        "span",
        { class: "recent-text" },
        h("span", { class: "recent-name" }, h("span", { class: "rn" }, r.title || r.name), r.sample ? h("span", { class: "chip" }, "Sample") : null),
        h("span", { class: "recent-meta" }, r.title ? `${r.name} · ${meta.join(" · ")}` : meta.join(" · ")),
      ),
    );
    const remove = iconButton("close", "Remove from the list (your notes are kept)", async () => {
      state.recent = state.recent.filter((x) => x.hash !== r.hash);
      if (r.cached) await Rosalena.storage.remove(fileKey(r.hash)).catch(() => {});
      await Rosalena.storage.set("recent", state.recent).catch(() => {});
      renderRecent();
    });
    remove.classList.add("recent-x");
    el.recentList.append(h("li", {}, open, remove));
  }
}

async function openRecent(r) {
  if (r.sample) return openSample();
  if (!r.cached) {
    el.fileInput.click();
    toast(`Choose ${r.name} again. Its highlights and notes come back as soon as it opens.`);
    return null;
  }
  try {
    const b64 = await Rosalena.storage.get(fileKey(r.hash));
    if (!b64) throw new Error("the saved copy is gone");
    return openBytes(fromBase64(b64), { name: r.name });
  } catch (err) {
    el.fileInput.click();
    toast(`Choose ${r.name} again (${err.message}).`, { bad: true });
    return null;
  }
}

// ---------------------------------------------------------------- dialog, toast, loading

let dialogDone = null;

function openDialog({ title, quote = "", value = "", placeholder = "", type = "textarea", ok = "Save", message = "" }) {
  if (dialogDone) dialogDone(null);
  return new Promise((resolve) => {
    const area = type === "textarea";
    const input = area ? el.dlgText : el.dlgInput;
    el.dlgTitle.textContent = title;
    el.dlgQuote.hidden = !quote;
    el.dlgQuote.textContent = quote;
    el.dlgText.hidden = !area;
    el.dlgInput.hidden = area;
    el.dlgInput.type = type === "password" ? "password" : "text";
    el.dlgMsg.hidden = !message;
    el.dlgMsg.textContent = message;
    el.dlgHint.textContent = area ? "Ctrl+Enter to save" : "Enter to continue";
    el.dlgOk.textContent = ok;
    input.value = value;
    input.placeholder = placeholder;
    el.dialog.hidden = false;
    setTimeout(() => input.focus(), 0);
    dialogDone = (result) => {
      dialogDone = null;
      el.dialog.hidden = true;
      resolve(result);
    };
  });
}

function askPassword(name, wrong) {
  return openDialog({ title: `${name} is protected`, type: "password", placeholder: "Password", ok: "Open", message: wrong ? "That password did not work. Try again." : "" });
}

let toastTimer = null;
function toast(message, { bad = false, action = null, onAction = null } = {}) {
  clearTimeout(toastTimer);
  el.toast.replaceChildren(h("span", {}, message));
  if (action) {
    el.toast.append(
      h("button", {
        onclick: () => {
          el.toast.hidden = true;
          onAction?.();
        },
      }, action),
    );
  }
  el.toast.classList.toggle("bad", bad);
  el.toast.hidden = false;
  toastTimer = setTimeout(() => (el.toast.hidden = true), action ? 6000 : 3400);
}

function showLoading(text) {
  el.loadingText.textContent = text;
  el.loading.hidden = false;
}
function hideLoading() {
  el.loading.hidden = true;
}

// ---------------------------------------------------------------- theme

function applyTheme(t) {
  const root = document.documentElement;
  root.dataset.mode = t?.mode === "light" ? "light" : "dark";
  for (const k of ["bg", "panel", "line", "text", "dim", "accent", "accent-soft", "ok", "warn", "bad"]) {
    const v = String(t?.colors?.[k] ?? "").trim();
    if (v) root.style.setProperty(`--${k}`, v);
    else root.style.removeProperty(`--${k}`);
  }
  if (t?.sans) root.style.setProperty("--sans", t.sans);
  if (t?.mono) root.style.setProperty("--mono", t.mono);
}

// ---------------------------------------------------------------- wiring

function wire() {
  for (const node of document.querySelectorAll("[data-icon]")) node.insertAdjacentHTML("afterbegin", svgIcon(node.dataset.icon, node.classList.contains("drop-inner") ? 40 : 18));
  for (const [box, act] of [
    [el.selSwatches, "highlight"],
    [el.popSwatches, "color"],
  ]) {
    for (const c of COLORS) {
      box.append(
        h("button", {
          class: "swatch",
          "data-color": c.id,
          style: `--c:${c.css}`,
          title: act === "highlight" ? `Highlight in ${c.label.toLowerCase()}` : `Make it ${c.label.toLowerCase()}`,
          "aria-label": `${c.label} highlight`,
        }),
      );
    }
    box.addEventListener("click", (e) => {
      const b = e.target.closest(".swatch");
      if (!b) return;
      if (act === "highlight") selAction("highlight", b.dataset.color);
      else popAction("color", b.dataset.color);
    });
  }
  // Keep the text selection alive while the toolbar's buttons are pressed.
  el.seltools.addEventListener("mousedown", (e) => e.preventDefault());
  el.seltools.addEventListener("click", (e) => {
    const b = e.target.closest(".tool");
    if (b) selAction(b.dataset.act);
  });
  el.hlpop.addEventListener("click", (e) => {
    const b = e.target.closest(".tool");
    if (b) popAction(b.dataset.act);
  });

  const pick = () => el.fileInput.click();
  el.btnOpen.addEventListener("click", pick);
  el.emptyOpen.addEventListener("click", pick);
  el.emptySample.addEventListener("click", () => openSample());
  el.fileInput.addEventListener("change", () => {
    const file = el.fileInput.files?.[0];
    el.fileInput.value = "";
    if (file) openFile(file).catch((err) => toast(`Could not open the file: ${err.message}`, { bad: true }));
  });
  el.btnHome.addEventListener("click", () => closeDocument());
  el.btnSidebar.addEventListener("click", () => {
    ui.sidebar = !ui.sidebar;
    ui.chosen = true;
    setView("doc");
    el.btnSidebar.classList.toggle("on", ui.sidebar);
    afterResize();
  });
  el.btnPanel.addEventListener("click", () => {
    ui.panel = !ui.panel;
    ui.chosen = true;
    setView("doc");
    el.btnPanel.classList.toggle("on", ui.panel);
    afterResize();
  });
  el.tabPages.addEventListener("click", () => selectTab("pages"));
  el.tabOutline.addEventListener("click", () => selectTab("outline"));

  el.btnPrev.addEventListener("click", () => goToPage(state.current - 1));
  el.btnNext.addEventListener("click", () => goToPage(state.current + 1));
  el.pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      goToPage(Number(el.pageInput.value));
      el.viewer.focus({ preventScroll: true });
    }
  });
  el.pageInput.addEventListener("blur", () => (el.pageInput.value = String(state.current)));
  el.pageInput.addEventListener("focus", () => el.pageInput.select());

  el.btnZoomIn.addEventListener("click", () => zoomStep(1));
  el.btnZoomOut.addEventListener("click", () => zoomStep(-1));
  el.zoomSelect.addEventListener("change", () => {
    const v = el.zoomSelect.value;
    if (v === "fit-width" || v === "fit-page") applyZoom(v);
    else applyZoom("custom", Number(v));
  });
  el.btnRotate.addEventListener("click", () => rotate(90));

  el.btnSearch.addEventListener("click", () => (el.findbar.hidden ? openSearch() : closeSearch()));
  let findTimer = null;
  el.findInput.addEventListener("input", () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runSearch(el.findInput.value), 220);
  });
  el.findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(findTimer);
      if (normalizeQuery(el.findInput.value) !== state.search.query) runSearch(el.findInput.value);
      else searchStep(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      closeSearch();
      el.viewer.focus({ preventScroll: true });
    }
  });
  el.findPrev.addEventListener("click", () => searchStep(-1));
  el.findNext.addEventListener("click", () => searchStep(1));
  el.findClose.addEventListener("click", () => closeSearch());

  el.btnSummarize.addEventListener("click", () => summarizePage(state.current));
  el.btnExport.addEventListener("click", () => exportNotes());
  el.cardAbstractText.addEventListener("click", () => el.cardAbstract.classList.toggle("open"));

  el.dlgOk.addEventListener("click", () => dialogDone?.(el.dlgText.hidden ? el.dlgInput.value : el.dlgText.value));
  el.dlgCancel.addEventListener("click", () => dialogDone?.(null));
  el.dialog.addEventListener("mousedown", (e) => {
    if (e.target === el.dialog) dialogDone?.(null);
  });
  el.dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      dialogDone?.(null);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.target === el.dlgInput)) {
      e.preventDefault();
      dialogDone?.(el.dlgText.hidden ? el.dlgInput.value : el.dlgText.value);
    }
  });

  // viewer
  el.viewer.addEventListener("scroll", () => {
    updateCurrentFromScroll();
    scheduleRender();
    if (!el.seltools.hidden) repositionSelTools();
    if (!el.hlpop.hidden) el.hlpop.hidden = true;
  });
  for (const type of ["wheel", "pointerdown", "keydown"]) el.viewer.addEventListener(type, () => (state.navTarget = null), { passive: true });
  el.viewer.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !state.doc) return;
      e.preventDefault();
      applyZoom("custom", state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  );
  // Document-wide, so a drag that ends outside the page still offers the tools.
  document.addEventListener("mouseup", (e) => {
    if (e.target?.closest?.(".floating, .scrim, .findbar, .toolbar, .panel, .sidebar") && !window.getSelection()?.toString()) return;
    if (e.target?.closest?.(".floating, .scrim")) return;
    setTimeout(() => checkSelection(e), 0);
  });
  let hoverFrame = 0;
  el.pages.addEventListener("mousemove", (e) => {
    if (hoverFrame || !state.highlights.length) return;
    hoverFrame = setTimeout(() => {
      hoverFrame = 0;
      const pageDiv = e.target.closest?.(".page");
      for (const d of el.pages.querySelectorAll(".page.over-hl")) if (d !== pageDiv) d.classList.remove("over-hl");
      if (!pageDiv) return;
      const p = state.pages[Number(pageDiv.dataset.page) - 1];
      pageDiv.classList.toggle("over-hl", Boolean(p && highlightAt(p, e.clientX, e.clientY)));
    }, 60);
  });
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection();
    if ((!sel || sel.isCollapsed) && !el.seltools.hidden) {
      el.seltools.hidden = true;
      state.pendingSel = null;
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (!el.hlpop.hidden && !el.hlpop.contains(e.target)) el.hlpop.hidden = true;
  });

  // files in
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    el.dropzone.hidden = false;
  });
  document.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.dropzone.hidden = true;
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.hidden = true;
    const files = [...(e.dataTransfer.files ?? [])];
    const file = files.find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name)) ?? files[0];
    if (file) openFile(file).catch((err) => toast(`Could not open the file: ${err.message}`, { bad: true }));
  });

  document.addEventListener("keydown", onKey);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave().catch(() => {});
  });

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(afterResize, 60);
  }).observe(el.viewer);
}

function afterResize() {
  if (!state.doc) return;
  if (state.zoomMode !== "custom") applyZoom(state.zoomMode);
  else scheduleRender();
}

function onKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  const typing = e.target?.closest?.("input, textarea, select, [contenteditable]");
  if (!el.dialog.hidden) return;
  if (mod && key.toLowerCase() === "f") {
    e.preventDefault();
    openSearch();
    return;
  }
  if (mod && key.toLowerCase() === "o") {
    e.preventDefault();
    el.fileInput.click();
    return;
  }
  if (mod && key.toLowerCase() === "p") {
    e.preventDefault();
    toast("Printing is turned off in Paper Reader. Export your notes as Markdown instead.");
    return;
  }
  if (key === "Escape") {
    if (!el.seltools.hidden || !el.hlpop.hidden) hideFloating();
    else if (!el.findbar.hidden) closeSearch();
    return;
  }
  if (key === "F3" && state.search.matches.length) {
    e.preventDefault();
    searchStep(e.shiftKey ? -1 : 1);
    return;
  }
  if (typing || !state.doc) return;
  if (mod && (key === "=" || key === "+")) {
    e.preventDefault();
    zoomStep(1);
    return;
  }
  if (mod && key === "-") {
    e.preventDefault();
    zoomStep(-1);
    return;
  }
  if (mod && key === "0") {
    e.preventDefault();
    applyZoom("fit-width");
    return;
  }
  if (mod || e.altKey) return;
  const actions = {
    ArrowRight: () => goToPage(state.current + 1),
    ArrowLeft: () => goToPage(state.current - 1),
    PageDown: () => goToPage(state.current + 1),
    PageUp: () => goToPage(state.current - 1),
    Home: () => goToPage(1),
    End: () => goToPage(state.pages.length),
    ArrowDown: () => el.viewer.scrollBy({ top: 70 }),
    ArrowUp: () => el.viewer.scrollBy({ top: -70 }),
    "+": () => zoomStep(1),
    "=": () => zoomStep(1),
    "-": () => zoomStep(-1),
    r: () => rotate(90),
    R: () => rotate(-90),
  };
  const fn = actions[key];
  if (fn) {
    e.preventDefault();
    fn();
  }
}

async function init() {
  for (const [key, id] of Object.entries({
    app: "app",
    toolbar: "app",
    btnSidebar: "btn-sidebar",
    btnHome: "btn-home",
    btnOpen: "btn-open",
    docName: "doc-name",
    docSub: "doc-sub",
    btnPrev: "btn-prev",
    btnNext: "btn-next",
    pageInput: "page-input",
    pageTotal: "page-total",
    btnZoomOut: "btn-zoom-out",
    btnZoomIn: "btn-zoom-in",
    zoomSelect: "zoom-select",
    btnRotate: "btn-rotate",
    btnSearch: "btn-search",
    btnPanel: "btn-panel",
    sidebar: "sidebar",
    tabPages: "tab-pages",
    tabOutline: "tab-outline",
    thumbs: "thumbs",
    outline: "outline",
    viewer: "viewer",
    pages: "pages",
    empty: "empty",
    emptyOpen: "empty-open",
    emptySample: "empty-sample",
    recentWrap: "recent-wrap",
    recentList: "recent-list",
    loading: "loading",
    loadingText: "loading-text",
    panel: "panel",
    cardTitle: "card-title",
    cardAuthors: "card-authors",
    statPages: "stat-pages",
    statWords: "stat-words",
    statRead: "stat-read",
    cardAbstract: "card-abstract",
    cardAbstractText: "card-abstract-text",
    btnSummarize: "btn-summarize",
    notesCount: "notes-count",
    btnExport: "btn-export",
    notesList: "notes-list",
    findbar: "findbar",
    findInput: "find-input",
    findCount: "find-count",
    findPrev: "find-prev",
    findNext: "find-next",
    findClose: "find-close",
    seltools: "seltools",
    selSwatches: "sel-swatches",
    hlpop: "hlpop",
    popSwatches: "pop-swatches",
    dialog: "dialog",
    dlgTitle: "dlg-title",
    dlgQuote: "dlg-quote",
    dlgText: "dlg-text",
    dlgInput: "dlg-input",
    dlgMsg: "dlg-msg",
    dlgHint: "dlg-hint",
    dlgCancel: "dlg-cancel",
    dlgOk: "dlg-ok",
    dropzone: "dropzone",
    toast: "toast",
    fileInput: "file-input",
  })) {
    el[key] = $(id);
  }
  el.toolbar = document.querySelector(".toolbar");
  wire();
  Rosalena.on("theme", applyTheme);
  renderNotes();
  Rosalena.ready();

  loadPdfjs().catch((err) => toast(`The PDF engine did not load: ${err.message}`, { bad: true }));
  try {
    state.recent = ((await Rosalena.storage.get("recent")) ?? []).filter((r) => r && r.hash);
  } catch (_) {
    state.recent = [];
  }
  if (!state.doc) renderRecent();
}

// ---------------------------------------------------------------- self-tests

function countOccurrences(haystack, needle) {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

function overlapRatio(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const hh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || hh <= 0) return 0;
  return (w * hh) / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
}

/** Highlight the first occurrence of `phrase` on `page`, the way a mouse selection would. */
async function highlightPhrase(page, phrase, color) {
  const p = state.pages[page - 1];
  goToPage(page);
  await renderVisible();
  await renderPage(p);
  const pt = await getPageText(page);
  const s = pt.text.indexOf(phrase);
  Rosalena.assert(s >= 0, `"${phrase}" is not in the text of page ${page}`);
  const range = rangeForChars(p, pt, s, s + phrase.length);
  Rosalena.assert(range, "could not build a range over the phrase");
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const info = selectionInfo(sel.getRangeAt(0));
  sel.removeAllRanges();
  Rosalena.assert(info, "the selection did not turn into a highlight");
  Rosalena.assert(info.page === page, `the selection landed on page ${info.page}`);
  Rosalena.assert(info.text === phrase, `selected text was "${info.text}"`);
  return { hl: createHighlight(info, color), range, p };
}

/** How well the drawn highlight covers the text it was made from (0-1). */
function coverage(p, hl, range) {
  const boxes = [...p.hlLayer.querySelectorAll(`.hl[data-id="${hl.id}"]`)].map((n) => n.getBoundingClientRect());
  const texts = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
  if (!boxes.length || !texts.length) return 0;
  let covered = 0;
  for (const t of texts) covered += Math.max(...boxes.map((b) => overlapRatio(t, b)));
  return covered / texts.length;
}

Rosalena.test("the sample paper opens with the expected page count", async () => {
  const sample = buildSamplePaper();
  Rosalena.assert(sample.pageCount === 4, `the sample should be 4 pages, it built ${sample.pageCount}`);
  const doc = await openSample();
  Rosalena.assert(doc, "the sample paper did not open");
  Rosalena.assert(state.doc.numPages === sample.pageCount, `pdf.js sees ${state.doc.numPages} pages, the sample has ${sample.pageCount}`);
  Rosalena.assert(el.pages.querySelectorAll(".page").length === sample.pageCount, "not every page has a slot in the viewer");
  await renderVisible();
  const p1 = state.pages[0];
  await renderPage(p1);
  Rosalena.assert(p1.canvas && p1.canvas.width > 200, "page 1 was not drawn");
  const data = p1.canvas.getContext("2d").getImageData(0, 0, p1.canvas.width, Math.floor(p1.canvas.height / 3)).data;
  let ink = 0;
  for (let i = 0; i < data.length; i += 16) if (data[i] < 110) ink++;
  Rosalena.assert(ink > 200, `page 1 looks empty (${ink} dark samples)`);
  Rosalena.assert(p1.textDivs?.length > 20, "page 1 has no text layer");
  await state.outlineReady;
  Rosalena.assert(state.outline.length >= 6 && !el.tabOutline.hidden, `the outline has ${state.outline.length} entries`);
  Rosalena.assert(el.outline.textContent.includes("2.1  Benchmark") || el.outline.textContent.includes("2.1 Benchmark"), "the nested outline entry is missing");
  Rosalena.assert(el.thumbs.querySelectorAll(".thumb").length === sample.pageCount, "thumbnails are missing");
});

Rosalena.test("text extraction finds the known sentence on page 2 and fills the paper card", async () => {
  const p2 = await getPageText(2);
  Rosalena.assert(p2.text.includes(KNOWN_SENTENCE), `page 2 text does not contain the sentence: ${p2.text.slice(0, 200)}`);
  const p1 = await getPageText(1);
  Rosalena.assert(!p1.text.includes(KNOWN_SENTENCE), "the page 2 sentence showed up on page 1");
  await state.cardReady;
  Rosalena.assert(state.card.title === SAMPLE_TITLE, `card title is "${state.card.title}"`);
  Rosalena.assert(state.card.author.includes("Okafor"), `card authors are "${state.card.author}"`);
  Rosalena.assert(state.card.words > 1000 && state.card.words < 2500, `word count is ${state.card.words}`);
  Rosalena.assert(Math.ceil(state.card.minutes) === Math.ceil(state.card.words / WORDS_PER_MINUTE), "reading time does not follow the word count");
  Rosalena.assert(state.card.abstract.startsWith("Coding agents are usually"), `abstract is "${state.card.abstract.slice(0, 60)}"`);
  Rosalena.assert(el.statPages.textContent === "4" && el.cardTitle.textContent === SAMPLE_TITLE, "the card on screen is out of date");
});

Rosalena.test("search finds every match and steps through them", async () => {
  const sample = buildSamplePaper();
  const expected = countOccurrences(sample.text.toLowerCase(), "agent");
  Rosalena.assert(expected >= 10, `the sample only has ${expected} uses of "agent"`);
  el.findbar.hidden = false;
  const n = await runSearch("Agent");
  Rosalena.assert(n === expected, `search found ${n} matches, the sample has ${expected}`);
  Rosalena.assert(el.findCount.textContent.includes(`of ${expected}`), `the count reads "${el.findCount.textContent}"`);
  const first = state.search.index;
  await searchStep(1);
  Rosalena.assert(state.search.index === (first + 1) % n, "next did not move to the next match");
  await searchStep(-1);
  Rosalena.assert(state.search.index === first, "previous did not move back");
  const m = state.search.matches[state.search.index];
  const p = state.pages[m.page - 1];
  Rosalena.assert(p.hitLayer.querySelectorAll(".hit").length >= 1 && p.hitLayer.querySelector(".hit.current"), "matches are not highlighted on the page");
  const across = await runSearch(KNOWN_SENTENCE.toUpperCase());
  Rosalena.assert(across === 1, `a sentence that wraps across lines matched ${across} times`);
  Rosalena.assert(state.search.matches[0].page === 2, "the sentence match is not on page 2");
  Rosalena.assert((await runSearch("zebra crossing")) === 0 && el.findCount.textContent === "No matches", "a missing phrase should report no matches");
  closeSearch();
  Rosalena.assert(!el.pages.querySelector(".hit"), "closing search left match boxes behind");
});

Rosalena.test("a highlight lines up with its text and round-trips through storage", async () => {
  const { hl, range, p } = await highlightPhrase(2, KNOWN_SENTENCE, "green");
  const cov = coverage(p, hl, range);
  Rosalena.assert(cov > 0.8, `the highlight covers ${Math.round(cov * 100)}% of its text`);
  const first = await highlightPhrase(1, ABSTRACT_PHRASE, "yellow");
  Rosalena.assert(coverage(first.p, first.hl, first.range) > 0.8, "the page 1 highlight is off its text");
  await flushSave();
  const stored = await Rosalena.storage.get(docKey(state.hash));
  Rosalena.assert(stored?.highlights?.some((x) => x.id === hl.id), "the highlight was not saved");
  const before = JSON.stringify(state.highlights);
  state.highlights = [];
  drawAllHighlights();
  renderNotes();
  Rosalena.assert(!el.pages.querySelector(".hl"), "clearing did not clear");
  await loadAnnotations();
  drawAllHighlights();
  renderNotes();
  Rosalena.assert(JSON.stringify(state.highlights) === before, "the highlights that came back differ from the ones saved");
  Rosalena.assert(p.hlLayer.querySelector(`.hl[data-id="${hl.id}"]`), "the restored highlight is not drawn");
  Rosalena.assert(el.notesList.textContent.includes("single strongest predictor"), "the notes panel does not list the highlight");
  Rosalena.assert(highlightAt(p, ...centerOf(p.hlLayer.querySelector(`.hl[data-id="${hl.id}"]`))) === state.highlights.find((x) => x.id === hl.id), "clicking the highlight does not find it");
});

function centerOf(node) {
  const r = node.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

Rosalena.test("notes export as Markdown with the highlight and its note", async () => {
  const hl = state.highlights.find((x) => x.text === KNOWN_SENTENCE);
  Rosalena.assert(hl, "the page 2 highlight is missing");
  updateHighlight(hl.id, { note: "Window size matters more than which ranker fills it." });
  const md = notesMarkdown();
  Rosalena.assert(md.startsWith(`# Notes: ${SAMPLE_TITLE}`), "the Markdown has no title");
  Rosalena.assert(md.includes("## Page 1") && md.includes("## Page 2") && md.indexOf("## Page 1") < md.indexOf("## Page 2"), "pages are not grouped in order");
  Rosalena.assert(md.includes(`> ${KNOWN_SENTENCE}`), "the highlight is not quoted");
  Rosalena.assert(md.includes("**Note:** Window size matters"), "the note is missing");
  const res = await exportNotes();
  Rosalena.assert(res && (res.verifying || res.saved), `files.save answered ${JSON.stringify(res)}`);
  Rosalena.assert(el.notesList.querySelector(".note-text")?.textContent.includes("Window size"), "the note does not show in the panel");
  Rosalena.assert(el.pages.querySelector(".hl-pin"), "the note pin is not drawn on the page");
});

Rosalena.test("Ask Rosalena and Summarize page compose the right text", async () => {
  const sent = [];
  const original = Rosalena.chat.compose;
  Rosalena.chat.compose = async (text) => {
    sent.push(text);
    return original.call(Rosalena.chat, text);
  };
  try {
    Rosalena.assert((await askRosalena(KNOWN_SENTENCE, 2)) === true, "asking failed");
    Rosalena.assert((await summarizePage(2)) === true, "summarizing failed");
  } finally {
    Rosalena.chat.compose = original;
  }
  Rosalena.assert(sent.length === 2, `compose was called ${sent.length} times`);
  Rosalena.assert(sent[0].includes(`> ${KNOWN_SENTENCE}`), "the quoted passage is missing");
  Rosalena.assert(sent[0].includes(SAMPLE_TITLE) && sent[0].includes("page 2"), "the paper title or page is missing");
  Rosalena.assert(sent[0].trim().endsWith("Please explain this passage."), "the request is missing");
  Rosalena.assert(sent[1].includes("summarize page 2") && sent[1].includes(KNOWN_SENTENCE), "the summary request lacks the page text");
  const long = truncateSensibly("Word. ".repeat(3000), SUMMARY_LIMIT);
  Rosalena.assert(long.cut && long.text.length <= SUMMARY_LIMIT + 4 && long.text.endsWith("[…]"), "long pages are not cut at a sentence");
});

Rosalena.test("zoom changes the rendered canvas width", async () => {
  const p1 = state.pages[0];
  goToPage(1);
  applyZoom("custom", 1);
  await renderPage(p1);
  const w1 = p1.canvas.width;
  const css1 = p1.div.offsetWidth;
  applyZoom("custom", 1.5);
  await renderPage(p1);
  const w2 = p1.canvas.width;
  Rosalena.assert(Math.abs(w2 / w1 - 1.5) < 0.02, `canvas went from ${w1} to ${w2} px`);
  Rosalena.assert(Math.abs(p1.div.offsetWidth / css1 - 1.5) < 0.02, "the page box did not grow");
  Rosalena.assert(el.zoomSelect.value === "1.5", `the zoom menu shows ${el.zoomSelect.value}`);
  zoomStep(1);
  Rosalena.assert(state.scale > 1.5, "zoom in did not step up");
  zoomStep(-1);
  zoomStep(-1);
  Rosalena.assert(state.scale < 1.5, "zoom out did not step down");
  applyZoom("fit-width");
  Rosalena.assert(p1.div.offsetWidth <= el.viewer.clientWidth && p1.div.offsetWidth > el.viewer.clientWidth - 80, "fit width does not fit the width");
  applyZoom("fit-page");
  Rosalena.assert(p1.div.offsetHeight <= el.viewer.clientHeight, "fit page does not fit the page");
  // The text layer scales with the page through --scale-factor, so the highlight must
  // still sit on its words before any repaint.
  const hl = state.highlights.find((x) => x.page === 1);
  const pt = await getPageText(1);
  const s = pt.text.indexOf(ABSTRACT_PHRASE);
  Rosalena.assert(coverage(p1, hl, rangeForChars(p1, pt, s, s + ABSTRACT_PHRASE.length)) > 0.8, "the highlight drifted off its text after zooming");
});

Rosalena.test("rotation turns the pages and keeps highlights on their text", async () => {
  applyZoom("custom", 1);
  const p1 = state.pages[0];
  const w = p1.div.offsetWidth;
  const hgt = p1.div.offsetHeight;
  await rotate(90);
  goToPage(1);
  await renderPage(p1);
  Rosalena.assert(Math.abs(p1.div.offsetWidth - hgt) <= 1 && Math.abs(p1.div.offsetHeight - w) <= 1, "the page box did not turn");
  const hl = state.highlights.find((x) => x.page === 1);
  const pt = await getPageText(1);
  const s = pt.text.indexOf(ABSTRACT_PHRASE);
  const cov = coverage(p1, hl, rangeForChars(p1, pt, s, s + ABSTRACT_PHRASE.length));
  Rosalena.assert(cov > 0.75, `after rotating, the highlight covers ${Math.round(cov * 100)}% of its text`);
  await rotate(-90);
  Rosalena.assert(state.rotation === 0 && Math.abs(p1.div.offsetWidth - w) <= 1, "rotating back did not restore the page");
});

Rosalena.test("keyboard moves between pages and zooms", async () => {
  el.viewer.focus();
  const press = (key, extra = {}) => el.viewer.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  press("End");
  Rosalena.assert(state.current === 4, `End went to page ${state.current}`);
  press("Home");
  Rosalena.assert(state.current === 1, `Home went to page ${state.current}`);
  press("ArrowRight");
  Rosalena.assert(state.current === 2, `ArrowRight went to page ${state.current}`);
  press("PageDown");
  Rosalena.assert(state.current === 3, `PageDown went to page ${state.current}`);
  press("PageUp");
  press("ArrowLeft");
  Rosalena.assert(state.current === 1, `back keys ended on page ${state.current}`);
  const s = state.scale;
  press("+");
  Rosalena.assert(state.scale > s, "+ did not zoom in");
  press("-");
  Rosalena.assert(Math.abs(state.scale - s) < 0.2, "- did not zoom back out");
  press("f", { ctrlKey: true });
  Rosalena.assert(!el.findbar.hidden && document.activeElement === el.findInput, "Ctrl+F did not open find");
  el.findInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  Rosalena.assert(el.findbar.hidden, "Escape did not close find");
});

Rosalena.test("the document hash is stable and reopening restores the notes", async () => {
  const a = buildSamplePaper().bytes;
  const b = buildSamplePaper().bytes;
  const ha = await sha256Hex(a);
  Rosalena.assert(ha === (await sha256Hex(b)), "two builds of the sample hash differently");
  Rosalena.assert(ha === state.hash, "the open document's hash differs from its bytes' hash");
  Rosalena.assert(sha256HexSync(a) === ha, "the JS and WebCrypto hashes disagree");
  Rosalena.assert(sha256HexSync(new TextEncoder().encode("abc")) === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256 of abc is wrong");
  const c = a.slice();
  c[c.length - 3] ^= 1;
  Rosalena.assert((await sha256Hex(c)) !== ha, "a changed byte did not change the hash");
  const count = state.highlights.length;
  Rosalena.assert(count === 2, `expected 2 highlights before reopening, have ${count}`);
  await openSample();
  Rosalena.assert(state.highlights.length === count, `reopening restored ${state.highlights.length} of ${count} highlights`);
  Rosalena.assert(state.highlights.some((x) => x.note.startsWith("Window size")), "the note did not come back");
  const recent = await Rosalena.storage.get("recent");
  Rosalena.assert(recent?.[0]?.hash === ha && recent[0].sample === true, "the sample is not first in the recent list");
});

Rosalena.test("clicking a note jumps to its page", async () => {
  const item = el.notesList.querySelector(".note-group[data-page='2'] .note-item");
  Rosalena.assert(item, "no note item for page 2");
  goToPage(1);
  item.click();
  Rosalena.assert(state.current === 2, `the note jumped to page ${state.current}`);
  // Leave the reader on page 1 at fit width for the screenshot.
  applyZoom("fit-width");
  goToPage(1);
  await renderVisible();
  Rosalena.assert(state.pages[0].canvas && state.current === 1, "page 1 is not drawn");
  el.toast.hidden = true;
});

init().catch((err) => {
  Rosalena.ready();
  toast(`Paper Reader did not start: ${err.message}`, { bad: true });
});
