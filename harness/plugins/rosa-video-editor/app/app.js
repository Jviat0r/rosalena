// Video Editor: a browser-only non-linear editor for Rosalena.
//
//   media bin   files come in through <input type=file> or drag-and-drop, live as object
//               URLs for this session only, and get a thumbnail, a filmstrip or a waveform
//   timeline    T1 titles, V1 video (magnetic: clips play back to back in order), A1 audio
//               (free placement). Trim handles, split, delete, reorder, snapping, zoom
//   preview     one canvas; each clip has its own <video>/<audio> element, the next clip is
//               pre-rolled, and the last good frame is held while a clip seeks, so cuts never
//               flash black. Titles draw on top with a fade
//   export      the same canvas through captureStream() + MediaRecorder (WebM VP9/VP8), the
//               sound mixed through WebAudio, saved with Rosalena.files.save
//   project     the edit decision list is saved to Rosalena.storage as you work. Media blobs
//               are not stored, so a reopened project shows "relink media" placeholders

// ------------------------------------------------------------------ constants and helpers

const FPS = 30;
const FRAME = 1 / FPS;
const MIN_DUR = 0.1;
const IMAGE_SECONDS = 4;
const TITLE_SECONDS = 3;
const ZOOM_MIN = 8;
const ZOOM_MAX = 480;
const SNAP_PX = 8;
const STORAGE_KEY = "project";
const TRACKS = ["text", "video", "audio"];
const ASPECTS = {
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "1:1": { w: 1080, h: 1080 },
};
const TITLE_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SWATCHES = ["#ffffff", "#ffe066", "#6beaf6", "#ff8fab", "#7cf29c", "#111418"];
const POSITIONS = [
  { label: "Top", y: 14 },
  { label: "Middle", y: 50 },
  { label: "Lower third", y: 76 },
  { label: "Bottom", y: 88 },
];
const STYLES = [
  { id: "shadow", label: "Shadow" },
  { id: "box", label: "Box" },
  { id: "outline", label: "Outline" },
  { id: "plain", label: "Plain" },
];
const DARK = { bg: "#0b1d26", panel: "#143039", line: "#35505f", text: "#eef6fc", dim: "#a6bacd", accent: "#6beaf6", "accent-soft": "#123741", ok: "#56e39f", warn: "#f3c969", bad: "#ff8a8a" };
const LIGHT = { bg: "#f4f2ec", panel: "#fbfaf6", line: "#cbc4b2", text: "#0b262b", dim: "#40606a", accent: "#0a6f79", "accent-soft": "#dceff0", ok: "#0f6b46", warn: "#7a5606", bad: "#a3282f" };

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let uidSeq = 0;
const uid = (prefix) => `${prefix}${Date.now().toString(36)}${(uidSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const messageOf = (err) => (err && err.message) || String(err);

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} took longer than ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]);
}

/** Resolve on one of `events`, reject on "error" or after `ms`. */
function waitFor(el, events, ms, label) {
  const list = [].concat(events);
  return new Promise((resolve, reject) => {
    let timer = 0;
    const finish = (fn, value) => {
      clearTimeout(timer);
      for (const name of list) el.removeEventListener(name, ok);
      el.removeEventListener("error", bad);
      fn(value);
    };
    const ok = () => finish(resolve);
    const bad = () => finish(reject, new Error(`${label}: the file could not be read${el.error?.message ? ` (${el.error.message})` : ""}`));
    timer = setTimeout(() => finish(reject, new Error(`${label}: timed out`)), ms);
    for (const name of list) el.addEventListener(name, ok);
    el.addEventListener("error", bad);
  });
}

function formatTime(t, frames = true) {
  const safe = Math.max(0, Number.isFinite(t) ? t : 0);
  const totalFrames = Math.round(safe * FPS);
  const f = totalFrames % FPS;
  const s = Math.floor(totalFrames / FPS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  // With frames it is broadcast timecode, HH:MM:SS:FF; without, a short MM:SS label.
  if (frames) return `${two(h)}:${two(m)}:${two(sec)}:${two(f)}`;
  return `${h ? `${h}:` : ""}${two(m)}:${two(sec)}`;
}
const seconds = (t) => `${(Math.round(t * 10) / 10).toFixed(1)} s`;
const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const slug = (s) => String(s || "edit").trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").slice(0, 60) || "edit";

// ------------------------------------------------------------------ timeline maths

/**
 * Pure time <-> pixel maths. timeToPx/pxToTime convert lengths; xOf/tOf convert positions
 * in the timeline's content box, where time 0 sits GUTTER pixels in from the left edge.
 */
const GUTTER = 14;
const TL = {
  timeToPx: (t, pps) => t * pps,
  pxToTime: (px, pps) => px / pps,
  xOf: (t, pps) => GUTTER + t * pps,
  tOf: (x, pps) => (x - GUTTER) / pps,
  clampZoom: (pps) => clamp(pps, ZOOM_MIN, ZOOM_MAX),
  /** Slider position 0..100 <-> pixels per second, on a log scale. */
  zoomFromSlider: (v) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, clamp(v, 0, 100) / 100),
  sliderFromZoom: (pps) => (100 * Math.log(TL.clampZoom(pps) / ZOOM_MIN)) / Math.log(ZOOM_MAX / ZOOM_MIN),
  /** The scrollLeft that keeps `anchorTime` under the same screen x after a zoom. */
  scrollForAnchor: (anchorTime, newPps, anchorScreenX) => Math.max(0, TL.xOf(anchorTime, newPps) - anchorScreenX),
  /** Ruler ticks: labelled major ticks at least 80 px apart, and minor subdivisions. */
  ticks(pps) {
    const steps = [FRAME * 5, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const major = steps.find((s) => s * pps >= 80) ?? 3600;
    const div = major === 2 ? 4 : major === 15 || major === 30 ? 3 : 5;
    return { major, minor: major / div };
  },
  /** Snap `t` to the nearest point within `px` screen pixels. */
  snap(t, points, pps, px = SNAP_PX) {
    let best = null;
    for (const p of points) {
      const d = Math.abs(p - t) * pps;
      if (d <= px && (!best || d < best.d)) best = { p, d };
    }
    return best ? { t: best.p, snapped: true } : { t, snapped: false };
  },
  frame: (t) => Math.round(t * FPS) / FPS,
};

function rulerLabel(t, major) {
  if (major < 1) {
    const s = Math.floor(t);
    const f = Math.round((t - s) * FPS);
    return f === 0 ? formatTime(t, false) : `${f}f`;
  }
  return formatTime(t, false);
}

// ------------------------------------------------------------------ state

const state = {
  name: "Untitled edit",
  aspect: "16:9",
  media: [], // { id, name, size, type, kind, duration, width, height, hasAudio, thumb, wave, strip, missing }
  text: [], // { id, track, start, in, out, text, size, color, x, y, style, fade }
  video: [], // { id, track, mediaId, start, in, out, volume } - start follows the order
  audio: [], // { id, track, mediaId, start, in, out, volume }
  pps: 64,
  playhead: 0,
  snapping: true,
  muted: { video: false, audio: false },
  selected: null,
  selectedMedia: null,
};
const files = new Map(); // mediaId -> { file, url, image }
const removedMedia = new Map(); // mediaId -> metadata, so an undo can bring clips back
const history = { undo: [], redo: [] };

const dur = (c) => c.out - c.in;
const end = (c) => c.start + dur(c);
const allClips = () => [...state.text, ...state.video, ...state.audio];
const findClip = (id) => (id ? allClips().find((c) => c.id === id) ?? null : null);
const mediaById = (id) => state.media.find((m) => m.id === id) ?? null;
const trackEnd = (track) => state[track].reduce((m, c) => Math.max(m, end(c)), 0);
const totalDuration = () => Math.max(trackEnd("video"), trackEnd("audio"), trackEnd("text"));
const isOffline = (c) => Boolean(c.mediaId) && !files.has(c.mediaId);
const sourceless = (c) => c.track === "text" || mediaById(c.mediaId)?.kind === "image";
const contains = (c, t) => t >= c.start - 1e-9 && t < end(c) - 1e-9;
const clipAt = (track, t) => state[track].find((c) => contains(c, t)) ?? null;
const sortTrack = (track) => state[track].sort((a, b) => a.start - b.start);

function layoutVideo() {
  let t = 0;
  for (const c of state.video) {
    c.start = t;
    t += dur(c);
  }
}

function sourceLimits(c) {
  if (sourceless(c)) return { min: -Infinity, max: Infinity };
  const m = mediaById(c.mediaId);
  return { min: 0, max: m?.duration > 0 ? m.duration : Math.max(c.out, MIN_DUR) };
}

/** Images and titles have no source time: keep their in point at 0. */
function normalize(c) {
  if (!sourceless(c)) return;
  c.out -= c.in;
  c.in = 0;
}

// ------------------------------------------------------------------ history

let editDepth = 0;
let gesture = null; // a pointer drag in progress
let live = null; // a run of inspector edits merged into one undo step

const snapshot = () => JSON.stringify({ text: state.text, video: state.video, audio: state.audio, aspect: state.aspect });

function restoreSnapshot(text) {
  const d = JSON.parse(text);
  state.text = d.text;
  state.video = d.video;
  state.audio = d.audio;
  if (d.aspect !== state.aspect) {
    state.aspect = d.aspect;
    applyAspect();
  }
  for (const c of [...state.video, ...state.audio]) {
    if (!mediaById(c.mediaId) && removedMedia.has(c.mediaId)) state.media.push(removedMedia.get(c.mediaId));
  }
  layoutVideo();
  if (!findClip(state.selected)) state.selected = null;
}

function pushUndo(before) {
  history.undo.push(before);
  if (history.undo.length > 120) history.undo.shift();
  history.redo.length = 0;
}

function commitIfChanged(before) {
  layoutVideo();
  if (snapshot() !== before) pushUndo(before);
  changed();
}

/** Run one edit as one undo step. Nested edits join the outer one. */
function edit(fn) {
  if (engine.exporting) {
    toast("Wait for the export to finish, or cancel it");
    return null;
  }
  if (editDepth > 0 || gesture) return fn();
  endLive();
  const before = snapshot();
  editDepth++;
  let out;
  try {
    out = fn();
  } finally {
    editDepth--;
  }
  commitIfChanged(before);
  return out;
}

function liveEdit(fn) {
  if (engine.exporting) return;
  if (!live) live = { before: snapshot(), timer: 0 };
  fn();
  layoutVideo();
  clearTimeout(live.timer);
  live.timer = setTimeout(endLive, 800);
  changed({ inspector: false });
}

function endLive() {
  if (!live) return;
  const { before, timer } = live;
  clearTimeout(timer);
  live = null;
  commitIfChanged(before);
}

function undo() {
  endLive();
  if (!history.undo.length || engine.exporting) return;
  history.redo.push(snapshot());
  restoreSnapshot(history.undo.pop());
  changed();
  toast("Undone");
}

function redo() {
  endLive();
  if (!history.redo.length || engine.exporting) return;
  history.undo.push(snapshot());
  restoreSnapshot(history.redo.pop());
  changed();
  toast("Redone");
}

// ------------------------------------------------------------------ edit operations

function select(id) {
  state.selected = id;
  if (id) state.selectedMedia = null;
  renderAll();
}

function selectMedia(id) {
  state.selectedMedia = id;
  state.selected = null;
  renderAll();
}

function addClipFromMedia(mediaId, { index = null, start = null } = {}) {
  const m = mediaById(mediaId);
  if (!m) return null;
  return edit(() => {
    if (m.kind === "audio") {
      const c = { id: uid("a"), track: "audio", mediaId, start: Math.max(0, start ?? trackEnd("audio")), in: 0, out: m.duration, volume: 1 };
      state.audio.push(c);
      sortTrack("audio");
      state.selected = c.id;
      return c;
    }
    const c = { id: uid("v"), track: "video", mediaId, start: 0, in: 0, out: m.kind === "image" ? IMAGE_SECONDS : m.duration, volume: 1 };
    const i = index == null ? state.video.length : clamp(index, 0, state.video.length);
    state.video.splice(i, 0, c);
    layoutVideo();
    state.selected = c.id;
    state.selectedMedia = null;
    return c;
  });
}

function addTitle(opts = {}) {
  return edit(() => {
    const c = {
      id: uid("t"),
      track: "text",
      start: Math.max(0, opts.start ?? state.playhead),
      in: 0,
      out: opts.duration ?? TITLE_SECONDS,
      text: opts.text ?? "Your title here",
      size: opts.size ?? 72,
      color: opts.color ?? "#ffffff",
      x: opts.x ?? 50,
      y: opts.y ?? 76,
      style: opts.style ?? "shadow",
      fade: opts.fade ?? 0.4,
    };
    state.text.push(c);
    sortTrack("text");
    state.selected = c.id;
    state.selectedMedia = null;
    return c;
  });
}

function splitInner(c, t) {
  const local = t - c.start;
  if (local < MIN_DUR - 1e-6 || dur(c) - local < MIN_DUR - 1e-6) return null;
  const cut = c.in + local;
  const right = { ...c, id: uid(c.track[0]), in: cut, start: c.start + local };
  c.out = cut;
  normalize(c);
  normalize(right);
  const arr = state[c.track];
  arr.splice(arr.indexOf(c) + 1, 0, right);
  layoutVideo();
  return right;
}

/** Split one clip at timeline time t. Returns [leftId, rightId] or null. */
function splitClip(id, t) {
  const c = findClip(id);
  if (!c) return null;
  const right = edit(() => splitInner(c, t));
  return right ? [c.id, right.id] : null;
}

/** S: split the selected clip under the playhead, or every clip under it. */
function splitAtPlayhead() {
  const t = state.playhead;
  const sel = findClip(state.selected);
  const targets = sel && contains(sel, t) ? [sel] : allClips().filter((c) => contains(c, t));
  if (!targets.length) {
    toast("Move the playhead over a clip to split it");
    return 0;
  }
  let made = 0;
  edit(() => {
    for (const c of targets) if (splitInner(c, t)) made++;
  });
  if (!made) toast("Too close to the edge of the clip to split");
  return made;
}

function applyTrim(c, orig, edge, delta) {
  const lim = sourceLimits(c);
  if (edge === "end") {
    c.out = clamp(orig.out + delta, orig.in + MIN_DUR, lim.max);
    return;
  }
  let nin = clamp(orig.in + delta, lim.min, orig.out - MIN_DUR);
  if (c.track !== "video") {
    const ns = orig.start + (nin - orig.in);
    if (ns < 0) nin -= ns;
    c.start = orig.start + (nin - orig.in);
  }
  c.in = nin;
}

/** Move one edge of a clip by delta seconds (negative = left). Returns the new duration. */
function trimClip(id, edge, delta) {
  const c = findClip(id);
  if (!c) return null;
  return edit(() => {
    applyTrim(c, { ...c }, edge, delta);
    normalize(c);
    layoutVideo();
    return dur(c);
  });
}

function moveVideoClip(id, toIndex) {
  const i = state.video.findIndex((c) => c.id === id);
  if (i < 0) return false;
  return edit(() => {
    const [c] = state.video.splice(i, 1);
    state.video.splice(clamp(toIndex, 0, state.video.length), 0, c);
    layoutVideo();
    return true;
  });
}

function moveClip(id, start) {
  const c = findClip(id);
  if (!c || c.track === "video") return false;
  return edit(() => {
    c.start = Math.max(0, start);
    sortTrack(c.track);
    return true;
  });
}

function deleteClip(id) {
  const c = findClip(id);
  if (!c) return false;
  edit(() => {
    state[c.track] = state[c.track].filter((x) => x.id !== id);
    if (state.selected === id) state.selected = null;
    layoutVideo();
  });
  return true;
}

async function deleteSelected() {
  if (state.selected) return deleteClip(state.selected);
  if (state.selectedMedia) return removeMedia(state.selectedMedia);
  toast("Select a clip first");
  return false;
}

async function removeMedia(id, { ask = true } = {}) {
  const m = mediaById(id);
  if (!m) return false;
  const used = [...state.video, ...state.audio].filter((c) => c.mediaId === id).length;
  if (ask && used) {
    const ok = await confirmDialog("Remove from project?", `<p><b>${esc(m.name)}</b> is used by ${used} clip${used === 1 ? "" : "s"} on the timeline. Removing it removes those clips too. Undo brings them back.</p>`, "Remove", true);
    if (!ok) return false;
  }
  edit(() => {
    removedMedia.set(id, m);
    state.video = state.video.filter((c) => c.mediaId !== id);
    state.audio = state.audio.filter((c) => c.mediaId !== id);
    state.media = state.media.filter((x) => x.id !== id);
    if (state.selectedMedia === id) state.selectedMedia = null;
    if (!findClip(state.selected)) state.selected = null;
  });
  return true;
}

function setAspect(aspect) {
  if (!ASPECTS[aspect] || aspect === state.aspect) return;
  edit(() => {
    state.aspect = aspect;
    applyAspect();
  });
}

// ------------------------------------------------------------------ media import

function kindOf(file) {
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  const ext = String(file.name || "").split(".").pop().toLowerCase();
  if (["mp4", "webm", "mov", "m4v", "mkv", "ogv"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"].includes(ext)) return "audio";
  return null;
}

/** MediaRecorder WebM files report an Infinity duration until the end has been seen. */
async function realDuration(el) {
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  await new Promise((resolve) => {
    let timer = 0;
    const check = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) finish();
    };
    const finish = () => {
      clearTimeout(timer);
      for (const name of ["durationchange", "timeupdate", "seeked"]) el.removeEventListener(name, check);
      resolve();
    };
    timer = setTimeout(finish, 4000);
    for (const name of ["durationchange", "timeupdate", "seeked"]) el.addEventListener(name, check);
    try {
      el.currentTime = 1e7;
    } catch {
      finish();
    }
  });
  let d = el.duration;
  if (!Number.isFinite(d) || d <= 0) {
    try {
      d = el.seekable.length ? el.seekable.end(el.seekable.length - 1) : 0;
    } catch {
      d = 0;
    }
  }
  return Number.isFinite(d) && d > 0 ? d : 0;
}

async function seekTo(el, t, ms = 4000) {
  if (!el.seeking && Math.abs(el.currentTime - t) < 0.001 && el.readyState >= 2) return;
  const wait = waitFor(el, "seeked", ms, "seek");
  el.currentTime = t;
  await wait;
}

function drawCover(g, src, sw, sh, x, y, w, h) {
  if (!sw || !sh) return;
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  g.restore();
}

function thumbOf(src, sw, sh) {
  const c = document.createElement("canvas");
  c.width = 192;
  c.height = 108;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  drawCover(g, src, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.72);
}

async function decodePeaks(file) {
  if (file.size > 150 * 1024 * 1024) return null;
  const OAC = window.OfflineAudioContext;
  if (!OAC) return null;
  try {
    const ctx = new OAC(1, 2, 44100);
    const buffer = await withTimeout(ctx.decodeAudioData(await file.arrayBuffer()), 10000, "decoding audio");
    const n = 600;
    const peaks = new Float32Array(n);
    const len = buffer.length;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch);
      const step = Math.max(1, Math.floor(len / n / 64));
      for (let i = 0; i < n; i++) {
        const a = Math.floor((i / n) * len);
        const b = Math.floor(((i + 1) / n) * len);
        let max = peaks[i];
        for (let j = a; j < b; j += step) {
          const v = Math.abs(data[j]);
          if (v > max) max = v;
        }
        peaks[i] = max;
      }
    }
    return peaks;
  } catch {
    return null;
  }
}

function waveImage(peaks) {
  const c = document.createElement("canvas");
  c.width = peaks.length;
  c.height = 40;
  const g = c.getContext("2d");
  let max = 0.0001;
  for (const p of peaks) max = Math.max(max, p);
  g.fillStyle = "rgba(255,255,255,0.78)";
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, (peaks[i] / max) * 38);
    g.fillRect(i, (40 - h) / 2, 1, h);
  }
  return c.toDataURL("image/png");
}

async function probe(file, kind) {
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await withTimeout(img.decode(), 10000, file.name);
      return { url, image: img, duration: IMAGE_SECONDS, width: img.naturalWidth, height: img.naturalHeight, thumb: thumbOf(img, img.naturalWidth, img.naturalHeight), wave: null, hasAudio: false };
    }
    const el = document.createElement(kind === "video" ? "video" : "audio");
    el.preload = "auto";
    el.muted = true;
    el.src = url;
    await waitFor(el, "loadedmetadata", 10000, file.name);
    const duration = await realDuration(el);
    if (!(duration > 0)) throw new Error("it has no playable length");
    let thumb = null;
    let width = 0;
    let height = 0;
    if (kind === "video") {
      width = el.videoWidth;
      height = el.videoHeight;
      await seekTo(el, Math.min(duration * 0.15, 1)).catch(() => {});
      if (el.readyState >= 2 && width) thumb = thumbOf(el, width, height);
    }
    const peaks = await decodePeaks(file);
    el.removeAttribute("src");
    el.load();
    return { url, image: null, duration, width, height, thumb, wave: peaks ? waveImage(peaks) : null, hasAudio: Boolean(peaks) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/** A filmstrip of the whole clip, drawn after import (it seeks, so it is not awaited). */
async function buildStrip(id) {
  const f = files.get(id);
  const m = mediaById(id);
  if (!f || !m || m.kind !== "video" || !m.width) return;
  const el = document.createElement("video");
  el.muted = true;
  el.preload = "auto";
  el.src = f.url;
  try {
    await waitFor(el, "loadedmetadata", 8000, "filmstrip");
    if (!Number.isFinite(el.duration)) await realDuration(el);
    const n = clamp(Math.round(m.duration / 1.2), 3, 10);
    const fw = 112;
    const fh = 63;
    const c = document.createElement("canvas");
    c.width = n * fw;
    c.height = fh;
    const g = c.getContext("2d");
    for (let i = 0; i < n; i++) {
      await seekTo(el, ((i + 0.5) / n) * m.duration);
      if (files.get(id) !== f) return;
      drawCover(g, el, el.videoWidth, el.videoHeight, i * fw, 0, fw, fh);
    }
    m.strip = c.toDataURL("image/jpeg", 0.66);
    renderTimeline();
  } catch {
    /* a missing filmstrip falls back to the thumbnail */
  } finally {
    el.removeAttribute("src");
    el.load();
  }
}

let importing = 0;
function setBusy(delta, label) {
  importing = Math.max(0, importing + delta);
  $("binBusy").hidden = importing === 0;
  if (label) $("binBusyText").textContent = label;
}

/** Import files into the bin. A file whose name and size match an offline item relinks it. */
async function importFiles(list, { relinkId = null } = {}) {
  const added = [];
  for (const file of [...list]) {
    const kind = kindOf(file);
    if (!kind) {
      toast(`${file.name} is not a video, image or audio file`, true);
      continue;
    }
    let target = relinkId ? mediaById(relinkId) : state.media.find((m) => m.missing && m.name === file.name && m.size === file.size);
    if (target && target.kind !== kind) {
      toast(`${file.name} is ${kind === "audio" ? "an" : "a"} ${kind} file; the offline item needs ${target.kind === "audio" ? "an" : "a"} ${target.kind} file`, true);
      if (relinkId) continue;
      target = null;
    }
    setBusy(1, `Importing ${file.name}`);
    try {
      const info = await probe(file, kind);
      const id = target ? target.id : uid("m");
      const old = files.get(id);
      if (old) URL.revokeObjectURL(old.url);
      files.set(id, { file, url: info.url, image: info.image });
      const meta = { id, name: file.name, size: file.size, type: file.type, kind, duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, thumb: info.thumb, wave: info.wave, strip: null, missing: false };
      if (target) {
        Object.assign(target, meta);
        for (const c of [...state.video, ...state.audio]) {
          if (c.mediaId !== id || kind === "image") continue;
          c.out = Math.min(c.out, info.duration);
          c.in = Math.min(c.in, Math.max(0, c.out - MIN_DUR));
        }
        layoutVideo();
        toast(`Relinked ${file.name}`);
      } else {
        state.media.push(meta);
      }
      added.push(id);
      if (kind === "video") buildStrip(id);
    } catch (err) {
      toast(`Could not import ${file.name}: ${messageOf(err)}`, true);
    } finally {
      setBusy(-1);
    }
  }
  changed();
  return added;
}

let relinkTarget = null;
function openRelink(mediaId) {
  relinkTarget = mediaId;
  $("relinkInput").value = "";
  $("relinkInput").click();
}

// ------------------------------------------------------------------ preview engine

const engine = {
  canvas: null,
  ctx: null,
  frame: null,
  fctx: null,
  els: new Map(), // clipId -> { el, url, gain, prepared, pendingSeek, clipId }
  playing: false,
  rate: 1,
  raf: 0,
  timer: 0,
  lastTick: 0,
  lastDraw: 0,
  dirty: true,
  stalled: false,
  waitingSince: 0,
  peek: null, // a time to show instead of the playhead (the edge being trimmed)
  exporting: null,
};
const audio = { ctx: null, master: null, failed: false };

function audioCtx() {
  if (audio.ctx || audio.failed) return audio.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) {
    audio.failed = true;
    return null;
  }
  try {
    audio.ctx = new AC();
    audio.master = audio.ctx.createGain();
    audio.master.connect(audio.ctx.destination);
  } catch {
    audio.failed = true;
    audio.ctx = null;
  }
  return audio.ctx;
}

function elFor(clip) {
  const f = files.get(clip.mediaId);
  const m = mediaById(clip.mediaId);
  if (!f || !m || m.kind === "image") return null;
  let rec = engine.els.get(clip.id);
  if (rec && rec.url === f.url) return rec;
  if (rec) dropEl(clip.id);
  const el = document.createElement(m.kind === "audio" ? "audio" : "video");
  el.preload = "auto";
  el.playsInline = true;
  el.src = f.url;
  rec = { el, url: f.url, gain: null, prepared: false, pendingSeek: null, clipId: clip.id, failed: false };
  el.addEventListener("seeked", () => {
    if (rec.pendingSeek != null) {
      const t = rec.pendingSeek;
      rec.pendingSeek = null;
      seekEl(rec, t);
    }
    invalidate();
  });
  el.addEventListener("loadeddata", invalidate);
  el.addEventListener("canplay", invalidate);
  el.addEventListener("error", () => {
    rec.failed = true;
    invalidate();
  });
  el.addEventListener(
    "loadedmetadata",
    async () => {
      if (!Number.isFinite(el.duration)) await realDuration(el);
      rec.prepared = true;
      const t = rec.pendingSeek;
      rec.pendingSeek = null;
      if (t != null) seekEl(rec, t);
      invalidate();
    },
    { once: true },
  );
  const ctx = audioCtx();
  if (ctx) {
    try {
      const src = ctx.createMediaElementSource(el);
      rec.gain = ctx.createGain();
      src.connect(rec.gain).connect(audio.master);
    } catch {
      rec.gain = null;
    }
  }
  engine.els.set(clip.id, rec);
  return rec;
}

function dropEl(id) {
  const rec = engine.els.get(id);
  if (!rec) return;
  engine.els.delete(id);
  try {
    rec.el.pause();
    rec.el.removeAttribute("src");
    rec.el.load();
    rec.gain?.disconnect();
  } catch {
    /* already gone */
  }
}

function seekEl(rec, t) {
  const el = rec.el;
  if (!rec.prepared || el.seeking) {
    rec.pendingSeek = t;
    return;
  }
  if (Math.abs(el.currentTime - t) > 0.0005) el.currentTime = t;
}

const elReady = (rec) => rec && rec.prepared && !rec.failed && !rec.el.seeking && rec.pendingSeek == null && rec.el.readyState >= 2;

function safePlay(el) {
  const p = el.play();
  if (p && p.catch) {
    p.catch((err) => {
      engine.playError = `${err?.name}: ${err?.message}`;
      if (err && err.name === "NotAllowedError" && !el.muted) {
        el.muted = true;
        el.play().catch(() => {});
        toast("The app blocked sound until you click inside the editor");
      }
    });
  }
}

function setVolume(rec, clip) {
  const muted = clip.track === "video" ? state.muted.video : state.muted.audio;
  const v = muted ? 0 : clamp(clip.volume ?? 1, 0, 2);
  if (rec.gain) {
    if (Math.abs(rec.gain.gain.value - v) > 0.001) rec.gain.gain.value = v;
  } else {
    rec.el.volume = clamp(v, 0, 1);
  }
}

function drive(rec, clip, target, playing) {
  const el = rec.el;
  setVolume(rec, clip);
  const rate = playing ? clamp(engine.rate, 0.25, 4) : 1;
  if (el.playbackRate !== rate) el.playbackRate = rate;
  if (playing) {
    if (el.paused) {
      if (Math.abs(el.currentTime - target) > 0.08) seekEl(rec, target);
      safePlay(el);
    } else if (Math.abs(el.currentTime - target) > 0.3 && !el.seeking) {
      seekEl(rec, target);
    }
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > 0.5 / FPS || rec.pendingSeek != null) seekEl(rec, target);
  }
}

const viewTime = () => (engine.peek != null ? engine.peek : state.playhead);

/** Put every media element where time t needs it: playing, paused, or pre-rolled. */
function syncMedia(t) {
  const forward = engine.playing && engine.rate > 0 && engine.peek == null;
  const active = new Set();
  const v = clipAt("video", t);
  if (v && !isOffline(v)) {
    const rec = elFor(v);
    if (rec) {
      active.add(v.id);
      drive(rec, v, v.in + (t - v.start), forward);
    }
  }
  // Pre-roll the next video clip so the cut lands on a decoded frame.
  const nextIndex = v ? state.video.indexOf(v) + 1 : state.video.findIndex((c) => c.start > t);
  const next = nextIndex > 0 || (!v && nextIndex === 0) ? state.video[nextIndex] : null;
  if (next && next !== v && next.start - t < 2 && !isOffline(next)) {
    const rec = elFor(next);
    if (rec) {
      active.add(next.id);
      if (!rec.el.paused) rec.el.pause();
      if (Math.abs(rec.el.currentTime - next.in) > 0.02 || rec.pendingSeek != null) seekEl(rec, next.in);
    }
  }
  for (const a of state.audio) {
    if (isOffline(a)) continue;
    if (contains(a, t)) {
      const rec = elFor(a);
      if (rec) {
        active.add(a.id);
        drive(rec, a, a.in + (t - a.start), forward && !engine.stalled);
      }
    } else if (forward && a.start > t && a.start - t < 1.5) {
      const rec = elFor(a);
      if (rec) {
        active.add(a.id);
        if (!rec.el.paused) rec.el.pause();
        if (Math.abs(rec.el.currentTime - a.in) > 0.02) seekEl(rec, a.in);
      }
    }
  }
  for (const [id, rec] of engine.els) if (!active.has(id) && !rec.el.paused) rec.el.pause();
}

function drawContain(g, src, sw, sh, W, H) {
  g.fillStyle = "#000";
  g.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s;
  const dh = sh * s;
  g.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawOffline(g, W, H, name) {
  g.fillStyle = "#1a0d10";
  g.fillRect(0, 0, W, H);
  g.save();
  g.strokeStyle = "rgba(255,120,130,0.10)";
  g.lineWidth = Math.max(6, W / 80);
  for (let x = -H; x < W; x += W / 16) {
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x + H, 0);
    g.stroke();
  }
  g.restore();
  const u = Math.min(W, H) / 720;
  g.fillStyle = "#ff8a8a";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${Math.round(44 * u)}px ${TITLE_FONT}`;
  g.fillText("Media offline", W / 2, H / 2 - 30 * u);
  g.fillStyle = "rgba(255,230,232,0.75)";
  g.font = `500 ${Math.round(24 * u)}px ${TITLE_FONT}`;
  g.fillText(name ? `Relink ${name} in the media bin` : "Relink the file in the media bin", W / 2, H / 2 + 26 * u);
}

function drawTitle(g, c, alpha, W, H) {
  const u = Math.min(W, H) / 720;
  const size = Math.max(6, c.size * u);
  const lines = String(c.text || "").split("\n");
  const lineH = size * 1.18;
  const x = (c.x / 100) * W;
  const y0 = (c.y / 100) * H - ((lines.length - 1) * lineH) / 2;
  g.save();
  g.globalAlpha = alpha;
  g.font = `700 ${size}px ${TITLE_FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (c.style === "box") {
    const w = Math.max(...lines.map((l) => g.measureText(l).width));
    const padX = size * 0.45;
    const padY = size * 0.28;
    const h = lines.length * lineH;
    g.fillStyle = "rgba(0,0,0,0.58)";
    g.beginPath();
    if (g.roundRect) g.roundRect(x - w / 2 - padX, y0 - lineH / 2 - padY, w + padX * 2, h + padY * 2, size * 0.2);
    else g.rect(x - w / 2 - padX, y0 - lineH / 2 - padY, w + padX * 2, h + padY * 2);
    g.fill();
  }
  if (c.style === "shadow") {
    g.shadowColor = "rgba(0,0,0,0.65)";
    g.shadowBlur = size * 0.28;
    g.shadowOffsetY = size * 0.05;
  }
  lines.forEach((line, i) => {
    const y = y0 + i * lineH;
    if (c.style === "outline") {
      g.lineJoin = "round";
      g.lineWidth = Math.max(2, size * 0.09);
      g.strokeStyle = "rgba(0,0,0,0.85)";
      g.strokeText(line, x, y);
    }
    g.fillStyle = c.color || "#ffffff";
    g.fillText(line, x, y);
  });
  g.restore();
}

function titleAlpha(c, t) {
  const local = t - c.start;
  const d = dur(c);
  const fade = Math.min(Math.max(0, c.fade ?? 0), d / 2);
  if (fade <= 0) return 1;
  return clamp(Math.min(local / fade, (d - local) / fade), 0, 1);
}

/** Draw the sequence at time t. Returns true when the frame is final (nothing still loading). */
function drawAt(t) {
  const { ctx, frame, fctx } = engine;
  const W = frame.width;
  const H = frame.height;
  let complete = true;
  const v = clipAt("video", t);
  if (!v) {
    fctx.fillStyle = "#000";
    fctx.fillRect(0, 0, W, H);
  } else if (isOffline(v)) {
    drawOffline(fctx, W, H, mediaById(v.mediaId)?.name);
  } else {
    const m = mediaById(v.mediaId);
    if (m.kind === "image") {
      const img = files.get(v.mediaId).image;
      if (img && img.complete && img.naturalWidth) drawContain(fctx, img, img.naturalWidth, img.naturalHeight, W, H);
      else complete = false;
    } else {
      const rec = elFor(v);
      if (elReady(rec)) drawContain(fctx, rec.el, rec.el.videoWidth, rec.el.videoHeight, W, H);
      else if (rec && rec.failed) drawOffline(fctx, W, H, m.name);
      else complete = false; // keep the last good frame on screen instead of black
    }
  }
  ctx.drawImage(frame, 0, 0);
  for (const c of state.text) if (contains(c, t)) drawTitle(ctx, c, titleAlpha(c, t), W, H);
  return complete;
}

function invalidate() {
  engine.dirty = true;
  schedule();
}

function schedule() {
  if (engine.raf || engine.timer) return;
  if (engine.exporting && document.hidden) engine.timer = setTimeout(() => tick(performance.now()), 16);
  else engine.raf = requestAnimationFrame(tick);
}

function advance(dt) {
  const total = totalDuration();
  let t = state.playhead;
  const rate = engine.rate;
  if (rate > 0) {
    const v = clipAt("video", t);
    const rec = v && !isOffline(v) ? elFor(v) : null;
    if (rec && !rec.failed) {
      const el = rec.el;
      if (!elReady(rec) || (el.paused && !el.ended)) {
        // The clip has not started yet (a cut, a seek): hold the clock, keep the frame.
        engine.stalled = true;
        if (!engine.waitingSince) engine.waitingSince = performance.now();
        if (performance.now() - engine.waitingSince < 2500) return;
        t += dt * rate; // give up waiting on a clip that will not play
      } else {
        engine.stalled = false;
        engine.waitingSince = 0;
        const et = v.start + (el.currentTime - v.in);
        t = el.ended ? t + dt * rate : Math.max(t, Math.min(et, t + dt * rate * 1.6 + 0.05));
      }
    } else {
      engine.stalled = false;
      engine.waitingSince = 0;
      t += dt * rate;
    }
    if (t >= total - 1e-4) {
      state.playhead = total;
      finishPlayback();
      return;
    }
  } else {
    t = Math.max(0, t + dt * rate);
    if (t <= 0) {
      state.playhead = 0;
      pause();
      return;
    }
  }
  state.playhead = t;
}

function tick(now) {
  engine.raf = 0;
  engine.timer = 0;
  const dt = engine.lastTick ? Math.min(0.25, (now - engine.lastTick) / 1000) : 0;
  engine.lastTick = now;
  if (engine.playing) advance(dt);
  const t = viewTime();
  syncMedia(t);
  if (engine.playing || engine.dirty) {
    if (now - engine.lastDraw > 12 || !engine.playing) {
      const complete = drawAt(t);
      engine.lastDraw = now;
      if (complete) engine.incompleteSince = 0;
      else if (!engine.incompleteSince) engine.incompleteSince = now;
      // Keep redrawing while a frame decodes, but not forever: media events wake it again.
      engine.dirty = !complete && now - engine.incompleteSince < 3000;
    }
  }
  if (engine.exporting) exportTick();
  updatePlayheadUI(engine.playing);
  if (engine.playing || engine.dirty || engine.exporting) schedule();
}

function play() {
  if (engine.exporting) return;
  const total = totalDuration();
  if (total <= 0) {
    toast("Add clips to the timeline first");
    return;
  }
  audioCtx()?.resume().catch(() => {});
  if (engine.rate > 0 && state.playhead >= total - 1e-3) state.playhead = 0;
  engine.playing = true;
  engine.lastTick = 0;
  engine.waitingSince = 0;
  schedule();
  renderTransport();
}

function pause() {
  const was = engine.playing;
  engine.playing = false;
  engine.rate = 1;
  engine.stalled = false;
  for (const rec of engine.els.values()) if (!rec.el.paused) rec.el.pause();
  invalidate();
  renderTransport();
  if (was) scheduleSave();
}

function togglePlay() {
  if (engine.playing) pause();
  else {
    engine.rate = 1;
    play();
  }
}

function shuttle(dir) {
  if (dir === 0) return pause();
  if (engine.playing && Math.sign(engine.rate) === dir) engine.rate = clamp(engine.rate * 2, -4, 4);
  else engine.rate = dir;
  play();
  renderTransport();
}

function finishPlayback() {
  engine.playing = false;
  engine.rate = 1;
  for (const rec of engine.els.values()) if (!rec.el.paused) rec.el.pause();
  engine.dirty = true;
  renderTransport();
  if (engine.exporting) finishExport(false);
}

function seek(t, { snap = false } = {}) {
  let target = clamp(t, 0, totalDuration());
  if (snap && state.snapping) target = TL.snap(target, snapPoints(null, false), state.pps).t;
  state.playhead = engine.playing ? target : TL.frame(target);
  if (engine.playing) engine.waitingSince = 0;
  invalidate();
  updatePlayheadUI(false);
}

function nudge(frames) {
  if (engine.playing) pause();
  seek(TL.frame(state.playhead) + frames * FRAME);
}

/** Draw time t until every clip under it has a decoded frame (or ms passes). */
async function primeFrame(t, ms = 4000) {
  const until = performance.now() + ms;
  for (;;) {
    syncMedia(t);
    const complete = drawAt(t);
    if (complete) return true;
    if (performance.now() > until) return false;
    await sleep(25);
  }
}

// ------------------------------------------------------------------ export

function pickRecorderMime(withAudio) {
  if (typeof MediaRecorder === "undefined") return null;
  const list = withAudio ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"] : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

function sequenceHasAudio() {
  return state.audio.some((c) => !isOffline(c)) || state.video.some((c) => !isOffline(c) && mediaById(c.mediaId)?.hasAudio);
}

/**
 * Render the sequence in real time to WebM and save it. Resolves to { blob, result } when
 * it is saved, or null when it was cancelled or could not run.
 */
async function exportVideo({ askOffline = true } = {}) {
  if (engine.exporting) return null;
  endLive();
  const total = totalDuration();
  if (total <= 0) {
    toast("Add something to the timeline before exporting");
    return null;
  }
  const offline = allClips().filter(isOffline).length;
  if (offline && askOffline) {
    const ok = await confirmDialog("Some media is offline", `<p>${offline} clip${offline === 1 ? " is" : "s are"} offline and will export as a "Media offline" frame. Relink the files in the media bin first to export them properly.</p>`, "Export anyway");
    if (!ok) return null;
  }
  const ctx = audioCtx();
  const withAudio = Boolean(ctx) && sequenceHasAudio();
  const mime = pickRecorderMime(withAudio);
  if (!mime || !engine.canvas.captureStream) {
    await messageDialog("Export is not available", "<p>This window cannot record video (MediaRecorder with WebM is missing).</p>");
    return null;
  }
  pause();
  if (ctx) await ctx.resume().catch(() => {});

  const stream = engine.canvas.captureStream(FPS);
  let dest = null;
  if (withAudio) {
    dest = ctx.createMediaStreamDestination();
    audio.master.connect(dest);
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  }
  const pixels = engine.canvas.width * engine.canvas.height;
  // The app saves files of up to 200 MB: long sequences get a lower bitrate so they fit.
  const fitBits = (180 * 1024 * 1024 * 8) / total - 160_000;
  const videoBits = Math.round(clamp(fitBits, 600_000, pixels > 1e6 ? 9_000_000 : 6_000_000));
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBits, audioBitsPerSecond: 160_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  let resolveJob;
  const finished = new Promise((resolve) => {
    resolveJob = resolve;
  });
  const job = { recorder, chunks, stopped, stream, dest, total, mime, resolve: resolveJob, startedAt: performance.now(), ending: false };
  engine.exporting = job;
  document.getElementById("app").classList.add("is-exporting");
  showExportModal(job);

  state.playhead = 0;
  updatePlayheadUI(false);
  await primeFrame(0, 4000);
  if (engine.exporting !== job) return finished;
  recorder.start(250);
  engine.rate = 1;
  engine.playing = true;
  engine.lastTick = 0;
  engine.waitingSince = 0;
  schedule();
  return finished;
}

function exportTick() {
  const job = engine.exporting;
  if (!job || job.ending) return;
  // A clip that is still seeking would freeze the picture in the file: pause the recorder.
  if (engine.stalled && job.recorder.state === "recording") job.recorder.pause();
  else if (!engine.stalled && job.recorder.state === "paused") job.recorder.resume();
  updateExportModal(job);
}

async function finishExport(cancelled) {
  const job = engine.exporting;
  if (!job || job.ending) return;
  job.ending = true;
  engine.playing = false;
  if (!cancelled) {
    drawAt(Math.max(0, job.total - 1e-3));
    await sleep(120);
  }
  for (const rec of engine.els.values()) if (!rec.el.paused) rec.el.pause();
  if (job.recorder.state !== "inactive") {
    job.recorder.stop();
    await withTimeout(job.stopped, 5000, "finishing the recording").catch(() => {});
  }
  if (job.dest) {
    try {
      audio.master.disconnect(job.dest);
    } catch {
      /* already disconnected */
    }
  }
  for (const track of job.stream.getTracks()) track.stop();
  engine.exporting = null;
  document.getElementById("app").classList.remove("is-exporting");
  renderTransport();
  invalidate();
  if (cancelled) {
    closeModal();
    toast("Export cancelled");
    job.resolve(null);
    return;
  }
  const blob = new Blob(job.chunks, { type: "video/webm" });
  const name = `${slug(state.name)}.webm`;
  setExportStatus("Saving", 1);
  try {
    const result = await Rosalena.files.save(name, blob, "video/webm");
    showExportDone(name, blob, result);
    job.resolve({ blob, result, name });
  } catch (err) {
    showExportDone(name, blob, null, messageOf(err));
    job.resolve({ blob, result: null, name, error: messageOf(err) });
  }
}

function cancelExport() {
  if (engine.exporting) finishExport(true);
}

async function exportFrame() {
  endLive();
  if (engine.exporting) return null;
  if (engine.playing) pause();
  if (totalDuration() <= 0) {
    toast("Add something to the timeline first");
    return null;
  }
  await primeFrame(state.playhead, 3000);
  const blob = await new Promise((resolve) => engine.canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    toast("Could not capture the frame", true);
    return null;
  }
  const name = `${slug(state.name)}-${formatTime(state.playhead).replace(/:/g, "-")}.png`;
  try {
    const result = await Rosalena.files.save(name, blob, "image/png");
    toast(result && result.verifying ? `Frame ready: ${name}` : `Saved ${name}`);
    return { blob, result, name };
  } catch (err) {
    toast(`Could not save the frame: ${messageOf(err)}`, true);
    return { blob, result: null, name };
  }
}

// ------------------------------------------------------------------ project storage

let saveTimer = 0;
function setSaveState(kind, text) {
  const el = $("saveState");
  el.className = `save-state ${kind}`;
  el.textContent = text;
}

function projectData() {
  return {
    v: 1,
    name: state.name,
    aspect: state.aspect,
    media: state.media.map((m) => ({
      id: m.id,
      name: m.name,
      size: m.size,
      type: m.type,
      kind: m.kind,
      duration: m.duration,
      width: m.width,
      height: m.height,
      hasAudio: m.hasAudio,
      thumb: m.thumb && m.thumb.length < 24000 ? m.thumb : null,
      wave: m.wave && m.wave.length < 30000 ? m.wave : null,
    })),
    text: state.text,
    video: state.video,
    audio: state.audio,
    playhead: state.playhead,
    pps: state.pps,
    snapping: state.snapping,
    muted: state.muted,
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState("saving", "Saving");
  saveTimer = setTimeout(() => {
    saveProject().catch(() => {});
  }, 700);
}

async function saveProject() {
  clearTimeout(saveTimer);
  try {
    await Rosalena.storage.set(STORAGE_KEY, projectData());
    setSaveState("saved", "Saved");
    return true;
  } catch (err) {
    setSaveState("error", "Not saved");
    toast(`Could not save the project: ${messageOf(err)}`, true);
    return false;
  }
}

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function cleanClip(c, track) {
  if (!c || typeof c !== "object") return null;
  const base = { id: String(c.id || uid(track[0])), track, start: Math.max(0, num(c.start)), in: num(c.in), out: num(c.out) };
  if (base.out - base.in < MIN_DUR) base.out = base.in + MIN_DUR;
  if (track === "text") {
    return { ...base, text: String(c.text ?? "Title"), size: clamp(num(c.size, 72), 8, 300), color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : "#ffffff", x: clamp(num(c.x, 50), 0, 100), y: clamp(num(c.y, 76), 0, 100), style: STYLES.some((s) => s.id === c.style) ? c.style : "shadow", fade: clamp(num(c.fade, 0.4), 0, 3) };
  }
  if (!c.mediaId) return null;
  return { ...base, mediaId: String(c.mediaId), volume: clamp(num(c.volume, 1), 0, 2) };
}

/** Load a saved project. Media whose files are not loaded in this session become offline. */
async function loadProject(data) {
  const d = data === undefined ? await Rosalena.storage.get(STORAGE_KEY) : data;
  if (!d || typeof d !== "object" || !Array.isArray(d.media)) return false;
  pause();
  state.name = String(d.name || "Untitled edit").slice(0, 80);
  state.aspect = ASPECTS[d.aspect] ? d.aspect : "16:9";
  state.media = d.media
    .filter((m) => m && m.id && ["video", "image", "audio"].includes(m.kind))
    .map((m) => ({
      id: String(m.id),
      name: String(m.name || "media"),
      size: num(m.size),
      type: String(m.type || ""),
      kind: m.kind,
      duration: num(m.duration, m.kind === "image" ? IMAGE_SECONDS : 0),
      width: num(m.width),
      height: num(m.height),
      hasAudio: Boolean(m.hasAudio),
      thumb: typeof m.thumb === "string" && m.thumb.startsWith("data:image/") ? m.thumb : null,
      wave: typeof m.wave === "string" && m.wave.startsWith("data:image/") ? m.wave : null,
      strip: null,
      missing: !files.has(String(m.id)),
    }));
  const known = new Set(state.media.map((m) => m.id));
  state.text = (Array.isArray(d.text) ? d.text : []).map((c) => cleanClip(c, "text")).filter(Boolean);
  state.video = (Array.isArray(d.video) ? d.video : []).map((c) => cleanClip(c, "video")).filter((c) => c && known.has(c.mediaId));
  state.audio = (Array.isArray(d.audio) ? d.audio : []).map((c) => cleanClip(c, "audio")).filter((c) => c && known.has(c.mediaId));
  sortTrack("text");
  sortTrack("audio");
  layoutVideo();
  state.pps = TL.clampZoom(num(d.pps, 64));
  state.snapping = d.snapping !== false;
  state.muted = { video: Boolean(d.muted?.video), audio: Boolean(d.muted?.audio) };
  state.playhead = clamp(num(d.playhead), 0, totalDuration());
  state.selected = null;
  state.selectedMedia = null;
  history.undo.length = 0;
  history.redo.length = 0;
  applyAspect();
  changed({ save: false });
  setSaveState("saved", "Saved");
  return true;
}

/** Forget every loaded file: what a reopened session looks like. */
function forgetFiles() {
  for (const id of [...engine.els.keys()]) dropEl(id);
  for (const f of files.values()) URL.revokeObjectURL(f.url);
  files.clear();
  for (const m of state.media) {
    m.missing = true;
    m.strip = null;
  }
}

function clearProject() {
  if (engine.exporting) finishExport(true);
  pause();
  endLive();
  forgetFiles();
  removedMedia.clear();
  Object.assign(state, { name: "Untitled edit", aspect: "16:9", media: [], text: [], video: [], audio: [], playhead: 0, selected: null, selectedMedia: null, pps: 64, snapping: true, muted: { video: false, audio: false } });
  history.undo.length = 0;
  history.redo.length = 0;
  applyAspect();
  closeModal();
  changed({ save: false });
}

async function newProject() {
  if (allClips().length || state.media.length) {
    const ok = await confirmDialog("Start a new project?", "<p>This clears the timeline and the media bin. The current project is not kept.</p>", "Start new", true);
    if (!ok) return;
  }
  clearProject();
  await saveProject();
}

// ------------------------------------------------------------------ generated media (sample project and self-tests)

function paintSynthetic(g, w, h, t, total, hue, label) {
  const p = clamp(t / total, 0, 1);
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue + p * 30}, 65%, 16%)`);
  grad.addColorStop(1, `hsl(${hue + 50 + p * 30}, 72%, 46%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 7; i++) {
    const a = i * 1.7 + t * 0.8;
    const x = w * (0.5 + 0.4 * Math.cos(a));
    const y = h * (0.5 + 0.34 * Math.sin(a * 1.3));
    const r = h * (0.07 + 0.045 * (i % 3));
    g.fillStyle = `hsla(${hue + 26 * i}, 90%, 72%, 0.22)`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "rgba(255,255,255,0.18)";
  g.fillRect(w * 0.07, h * 0.8, w * 0.86, h * 0.012);
  g.fillStyle = "#fff";
  g.fillRect(w * 0.07, h * 0.8, w * 0.86 * p, h * 0.012);
  g.textAlign = "left";
  g.textBaseline = "alphabetic";
  g.fillStyle = "#fff";
  g.font = `700 ${Math.round(h * 0.13)}px ${TITLE_FONT}`;
  g.fillText(label, w * 0.07, h * 0.32);
  g.fillStyle = "rgba(255,255,255,0.78)";
  g.font = `600 ${Math.round(h * 0.06)}px ui-monospace, Consolas, monospace`;
  g.fillText(`${t.toFixed(2)} s`, w * 0.07, h * 0.43);
}

/** Record an animated canvas to a WebM file (real time: `seconds` long to make). */
async function makeSyntheticClip({ seconds: length = 1.5, width = 640, height = 360, hue = 200, label = "Clip", name = null } = {}) {
  const mime = pickRecorderMime(false);
  if (!mime) throw new Error("MediaRecorder cannot record WebM here");
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d");
  const stream = c.captureStream(FPS);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
  const chunks = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => {
    rec.onstop = resolve;
  });
  paintSynthetic(g, width, height, 0, length, hue, label);
  rec.start(100);
  const t0 = performance.now();
  for (;;) {
    const t = (performance.now() - t0) / 1000;
    if (t >= length) break;
    paintSynthetic(g, width, height, t, length, hue, label);
    await sleep(1000 / FPS);
  }
  paintSynthetic(g, width, height, length, length, hue, label);
  await sleep(50);
  rec.stop();
  await withTimeout(stopped, 4000, "recording the sample clip");
  for (const track of stream.getTracks()) track.stop();
  return new File([new Blob(chunks, { type: "video/webm" })], name || `${label}.webm`, { type: "video/webm" });
}

async function makeCardImage({ width = 1280, height = 720, title = "Title card", subtitle = "", hue = 210, name = "card.png" } = {}) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(width * 0.3, height * 0.2, 10, width * 0.5, height * 0.5, width * 0.8);
  grad.addColorStop(0, `hsl(${hue}, 70%, 36%)`);
  grad.addColorStop(1, `hsl(${hue + 40}, 60%, 9%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, width, height);
  g.strokeStyle = "rgba(255,255,255,0.08)";
  g.lineWidth = 2;
  for (let x = 0; x < width; x += 48) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, height);
    g.stroke();
  }
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.font = `800 ${Math.round(height * 0.12)}px ${TITLE_FONT}`;
  g.fillText(title, width / 2, height * 0.5);
  if (subtitle) {
    g.fillStyle = "rgba(255,255,255,0.7)";
    g.font = `500 ${Math.round(height * 0.045)}px ${TITLE_FONT}`;
    g.fillText(subtitle, width / 2, height * 0.6);
  }
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
  return new File([blob], name, { type: "image/png" });
}

/** A soft chord progression as a 16-bit mono WAV. */
function makeToneWav({ seconds: length = 2, rate = 22050, name = "tone.wav", chords = [[220, 277.18, 329.63]], gain = 0.16 } = {}) {
  const n = Math.round(length * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  dv.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, "data");
  dv.setUint32(40, n * 2, true);
  const seg = length / chords.length;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const k = Math.min(chords.length - 1, Math.floor(t / seg));
    const local = t - k * seg;
    const env = Math.min(1, local / 0.25, (seg - local) / 0.35) * Math.min(1, t / 0.4, (length - t) / 0.6);
    let s = 0;
    for (const f of chords[k]) s += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t);
    s = (s / chords[k].length) * gain * clamp(env, 0, 1);
    dv.setInt16(44 + i * 2, clamp(Math.round(s * 32767), -32768, 32767), true);
  }
  return new File([buf], name, { type: "audio/wav" });
}

let sampleBusy = false;
async function loadSample() {
  if (sampleBusy || engine.exporting) return;
  sampleBusy = true;
  setBusy(1, "Recording sample clips (about 3 s)");
  try {
    const [a, b, card] = await Promise.all([
      makeSyntheticClip({ seconds: 3, width: 960, height: 540, hue: 190, label: "Harbour", name: "harbour.webm" }),
      makeSyntheticClip({ seconds: 3, width: 960, height: 540, hue: 320, label: "Sunset", name: "sunset.webm" }),
      makeCardImage({ title: "A short film", subtitle: "Made in Rosalena", hue: 205, name: "title-card.png" }),
    ]);
    const music = makeToneWav({ seconds: 8, name: "soft-chords.wav", chords: [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]] });
    const ids = await importFiles([card, a, b, music]);
    const byName = (n) => ids.map(mediaById).find((m) => m && m.name === n);
    edit(() => {
      const cardMedia = byName("title-card.png");
      if (cardMedia) addClipFromMedia(cardMedia.id);
      const v1 = byName("harbour.webm");
      const v2 = byName("sunset.webm");
      if (v1) addClipFromMedia(v1.id);
      if (v2) addClipFromMedia(v2.id);
      const first = state.video[0];
      if (first && mediaById(first.mediaId)?.kind === "image") first.out = 2;
      layoutVideo();
      const mus = byName("soft-chords.wav");
      if (mus) addClipFromMedia(mus.id, { start: 0 });
      addTitle({ text: "Harbour, early morning", start: 2.3, duration: 2.4, size: 54, y: 82, style: "shadow" });
      addTitle({ text: "Thanks for watching", start: 5.6, duration: 2.2, size: 64, y: 50, style: "box", color: "#ffe066" });
      state.selected = null;
    });
    if (state.name === "Untitled edit") state.name = "Sample edit";
    state.playhead = 2.6;
    fitZoom();
    changed();
    toast("Sample project ready. Press Space to play");
  } catch (err) {
    toast(`Could not build the sample: ${messageOf(err)}`, true);
  } finally {
    setBusy(-1);
    sampleBusy = false;
  }
}

// ------------------------------------------------------------------ rendering: shell

const icons = {
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M5 6h14M12 6v13"/></svg>',
  project: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M3 20h18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  split: '<svg viewBox="0 0 24 24"><circle cx="6" cy="7" r="2.6"/><circle cx="6" cy="17" r="2.6"/><path d="M8.2 8.4 19 17M8.2 15.6 19 7"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
};

let toastTimer = 0;
function toast(text, bad = false) {
  const el = $("toast");
  el.textContent = text;
  el.classList.toggle("bad", bad);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), bad ? 4200 : 2600);
}

let modalResolve = null;
function openModal(title, body, actions) {
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = body;
  const bar = $("modalActions");
  bar.innerHTML = "";
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = `btn ${a.kind || ""}`;
    b.textContent = a.label;
    if (a.id) b.id = a.id;
    b.addEventListener("click", a.onClick);
    bar.appendChild(b);
  }
  $("modal").hidden = false;
  const focus = bar.querySelector(".primary, .danger") || bar.lastElementChild;
  focus?.focus();
}

function closeModal(value = false) {
  if ($("modal").hidden) return;
  $("modal").hidden = true;
  const r = modalResolve;
  modalResolve = null;
  r?.(value);
}

function confirmDialog(title, body, okLabel, danger = false) {
  closeModal(false);
  return new Promise((resolve) => {
    modalResolve = resolve;
    openModal(title, body, [
      { label: "Cancel", kind: "ghost", onClick: () => closeModal(false) },
      { label: okLabel, kind: danger ? "danger" : "primary", onClick: () => closeModal(true) },
    ]);
  });
}

function messageDialog(title, body) {
  closeModal(false);
  return new Promise((resolve) => {
    modalResolve = resolve;
    openModal(title, body, [{ label: "OK", kind: "primary", onClick: () => closeModal(true) }]);
  });
}

function showExportModal(job) {
  closeModal(false);
  openModal(
    "Exporting video",
    `<p>Rendering <b>${esc(state.name)}</b> in real time (${seconds(job.total)}, ${engine.canvas.width} x ${engine.canvas.height}). Keep this window open.</p>
     <div class="progress"><div id="exportBar"></div></div>
     <div class="progress-meta"><span id="exportStatus">Preparing</span><span id="exportTime">00:00 / ${formatTime(job.total, false)}</span></div>`,
    [{ label: "Cancel", kind: "ghost", id: "exportCancel", onClick: cancelExport }],
  );
}

function setExportStatus(text, pct) {
  const status = $("exportStatus");
  if (status) status.textContent = text;
  const bar = $("exportBar");
  if (bar && pct != null) bar.style.width = `${Math.round(clamp(pct, 0, 1) * 100)}%`;
}

function updateExportModal(job) {
  const pct = job.total ? state.playhead / job.total : 0;
  setExportStatus(engine.stalled ? "Waiting for a clip" : `Recording ${Math.round(pct * 100)}%`, pct);
  const time = $("exportTime");
  if (time) time.textContent = `${formatTime(state.playhead, false)} / ${formatTime(job.total, false)}`;
}

function showExportDone(name, blob, result, error = null) {
  closeModal(false);
  const where = error ? `<p>The video was rendered (${bytes(blob.size)}) but could not be saved: ${esc(error)}</p>` : result && result.verifying ? `<p><b>${esc(name)}</b> is ready (${bytes(blob.size)}).</p>` : `<p>Saved <b>${esc(name)}</b> (${bytes(blob.size)}).</p>`;
  openModal(error ? "Export not saved" : "Export finished", where, [{ label: "Done", kind: "primary", onClick: () => closeModal(true) }]);
}

// ------------------------------------------------------------------ rendering: panels

function changed({ inspector = true, save = true } = {}) {
  layoutVideo();
  for (const id of [...engine.els.keys()]) if (!findClip(id)) dropEl(id);
  if (state.playhead > totalDuration()) state.playhead = totalDuration();
  if (save) scheduleSave();
  renderAll({ inspector });
  invalidate();
}

function renderAll({ inspector = true } = {}) {
  renderBin();
  renderTimeline();
  if (inspector) renderInspector();
  renderTransport();
  renderStage();
  $("undoBtn").disabled = !history.undo.length;
  $("redoBtn").disabled = !history.redo.length;
  if (document.activeElement !== $("projectName")) $("projectName").value = state.name;
}

let binKey = "";
function renderBin() {
  const key = JSON.stringify(state.media.map((m) => [m.id, m.missing, Boolean(m.thumb), Boolean(m.wave), m.duration, m.name])) + state.selectedMedia;
  $("binEmpty").hidden = state.media.length > 0;
  $("binCount").textContent = state.media.length ? String(state.media.length) : "";
  if (key === binKey) return;
  binKey = key;
  $("binGrid").innerHTML = state.media
    .map((m) => {
      const bg = m.kind === "audio" ? (m.wave ? `background-image:url(${m.wave}), linear-gradient(160deg, color-mix(in srgb, var(--c-audio) 30%, #071016), #071016)` : "") : m.thumb ? `background-image:url(${m.thumb})` : "";
      const sub = m.kind === "image" ? `Image${m.width ? ` · ${m.width}x${m.height}` : ""}` : m.kind === "video" ? `Video${m.width ? ` · ${m.width}x${m.height}` : ""}` : `Audio · ${bytes(m.size)}`;
      return `<div class="media-card${m.missing ? " missing" : ""}${state.selectedMedia === m.id ? " selected" : ""}" data-id="${esc(m.id)}" draggable="${m.missing ? "false" : "true"}" tabindex="0" title="${esc(m.name)}">
        <div class="thumb ${m.kind}${m.wave ? " has-wave" : ""}" style="${bg}">
          ${m.thumb || m.wave ? "" : icons[m.kind]}
          <span class="kind">${icons[m.kind]}</span>
          ${m.missing ? `<div class="offline"><span>Offline</span><button data-relink="${esc(m.id)}" title="Find this file again">Relink</button></div>` : `<span class="badge">${m.kind === "image" ? "Still" : formatTime(m.duration, false)}</span>`}
        </div>
        ${m.missing ? "" : `<button class="add" data-add="${esc(m.id)}" title="Add to the timeline" aria-label="Add ${esc(m.name)} to the timeline">${icons.plus}</button>`}
        <div class="meta"><span class="name">${esc(m.name)}</span><span class="sub">${esc(sub)}</span></div>
      </div>`;
    })
    .join("");
}

function renderStage() {
  const clips = allClips().length;
  const stage = $("stage");
  stage.classList.toggle("empty", clips === 0);
  $("stageEmpty").hidden = clips > 0;
  if (!clips) {
    const hasMedia = state.media.length > 0;
    $("stageTitle").textContent = hasMedia ? "Now build the sequence" : "Start your edit";
    $("stageText").textContent = hasMedia
      ? "Drag clips from the media bin onto the timeline below, or hover a clip and press +. Press T for a title."
      : "Import video, images and music, then drag them onto the timeline. Everything stays on this computer.";
    $("stageActions").hidden = hasMedia;
  }
  const badge = $("stageBadge");
  const offline = clips ? allClips().filter(isOffline).length : 0;
  if (engine.exporting) {
    badge.hidden = false;
    badge.textContent = "REC";
  } else if (offline) {
    badge.hidden = false;
    badge.textContent = `${offline} clip${offline === 1 ? "" : "s"} offline`;
  } else badge.hidden = true;
}

function renderTransport() {
  $("tPlay").classList.toggle("playing", engine.playing);
  $("tPlay").setAttribute("aria-label", engine.playing ? "Pause" : "Play");
  $("tcTotal").textContent = formatTime(totalDuration());
  $("tcNow").textContent = formatTime(state.playhead);
  const rate = $("rate");
  rate.hidden = !engine.playing || engine.rate === 1;
  rate.textContent = `${engine.rate > 0 ? "" : "-"}${Math.abs(engine.rate)}x`;
  $("canvasSize").textContent = `${engine.canvas.width} x ${engine.canvas.height}`;
  $("snapBtn").setAttribute("aria-pressed", String(state.snapping));
  $("muteVideo").setAttribute("aria-pressed", String(state.muted.video));
  $("muteAudio").setAttribute("aria-pressed", String(state.muted.audio));
  $("aspect").value = state.aspect;
  const sel = findClip(state.selected);
  $("deleteBtn").disabled = !sel && !state.selectedMedia;
  $("splitBtn").disabled = !allClips().some((c) => contains(c, state.playhead));
  $("exportBtn").disabled = Boolean(engine.exporting);
  const total = totalDuration();
  $("tlInfo").textContent = total ? `${allClips().length} clip${allClips().length === 1 ? "" : "s"} · ${seconds(total)}` : "";
}

// ------------------------------------------------------------------ rendering: inspector

let inspKey = "";
function renderInspector() {
  const c = findClip(state.selected);
  const m = !c && state.selectedMedia ? mediaById(state.selectedMedia) : null;
  const key = c ? `clip:${c.id}` : m ? `media:${m.id}:${m.missing}` : "project";
  const box = $("inspector");
  if (key !== inspKey) {
    inspKey = key;
    box.innerHTML = c ? clipInspector(c) : m ? mediaInspector(m) : projectInspector();
  }
  syncInspector(c, m);
}

function header(kind, title, sub) {
  return `<div class="insp-head"><span class="chip ${kind}">${icons[kind === "video" ? "video" : kind]}</span><div><h3 id="iTitle">${esc(title)}</h3><p id="iSub">${esc(sub)}</p></div></div>`;
}

function projectInspector() {
  return `<div class="panel-head"><h2>Inspector</h2></div><div class="scroll">
    ${header("project", "Project", "Nothing selected")}
    <div class="stats">
      <div class="stat"><b id="sDur">0:00</b><span>Length</span></div>
      <div class="stat"><b id="sClips">0</b><span>Clips</span></div>
      <div class="stat"><b id="sMedia">0</b><span>Media files</span></div>
      <div class="stat"><b id="sSize">1280x720</b><span>Canvas</span></div>
    </div>
    <p class="tip">Select a clip to trim it, change its volume or edit a title. Drag a clip's edges to trim, drag the middle to move it.</p>
    <div class="section-label">Shortcuts</div>
    <ul class="keys">
      <li><span>Play / pause</span><span><kbd>Space</kbd></span></li>
      <li><span>Shuttle back, stop, forward</span><span><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd></span></li>
      <li><span>Step a frame (Shift: 1 s)</span><span><kbd>&larr;</kbd><kbd>&rarr;</kbd></span></li>
      <li><span>Split at playhead</span><span><kbd>S</kbd></span></li>
      <li><span>Delete clip</span><span><kbd>Del</kbd></span></li>
      <li><span>Add title</span><span><kbd>T</kbd></span></li>
      <li><span>Zoom timeline</span><span><kbd>+</kbd><kbd>-</kbd><kbd>\\</kbd></span></li>
      <li><span>Undo / redo</span><span><kbd>Ctrl</kbd><kbd>Z</kbd> <kbd>Y</kbd></span></li>
    </ul>
  </div>`;
}

function mediaInspector(m) {
  const used = [...state.video, ...state.audio].filter((c) => c.mediaId === m.id).length;
  return `<div class="panel-head"><h2>Inspector</h2></div><div class="scroll">
    ${header(m.kind === "image" ? "video" : m.kind, m.name, m.kind === "image" ? "Image" : `${m.kind === "video" ? "Video" : "Audio"} · ${formatTime(m.duration, false)}`)}
    ${m.thumb ? `<div class="insp-thumb" style="background-image:url(${m.thumb})"></div>` : ""}
    ${m.missing ? `<div class="warn-box">This file is not loaded in this session. Relink it to use it again: pick the same file, or drop it on the window.</div>` : ""}
    <dl class="kv">
      <dt>Type</dt><dd>${esc(m.type || m.kind)}</dd>
      ${m.width ? `<dt>Size</dt><dd>${m.width} x ${m.height}</dd>` : ""}
      ${m.kind !== "image" ? `<dt>Length</dt><dd>${formatTime(m.duration)}</dd>` : ""}
      <dt>File</dt><dd>${bytes(m.size)}</dd>
      ${m.kind === "video" ? `<dt>Sound</dt><dd>${m.hasAudio ? "Yes" : "None found"}</dd>` : ""}
      <dt>On timeline</dt><dd>${used} clip${used === 1 ? "" : "s"}</dd>
    </dl>
    <div class="insp-actions">
      ${m.missing ? `<button class="btn primary small" data-relink="${esc(m.id)}">Relink file</button>` : `<button class="btn primary small" id="iAdd">${icons.plus} Add to timeline</button>`}
      <button class="btn danger small" id="iRemove">${icons.trash} Remove</button>
    </div>
  </div>`;
}

function clipInspector(c) {
  if (c.track === "text") {
    return `<div class="panel-head"><h2>Inspector</h2></div><div class="scroll">
      ${header("text", "Title", "")}
      <label class="field"><span>Text</span><textarea id="fText" rows="3" spellcheck="false"></textarea></label>
      <div class="field"><span>Size <output id="oSize"></output></span><input type="range" id="fSize" min="16" max="200" step="1" /></div>
      <div class="field"><span>Colour</span><div class="swatches">${SWATCHES.map((s) => `<button data-color="${s}" style="background:${s}" title="${s}" aria-label="Colour ${s}"></button>`).join("")}<input type="color" id="fColor" aria-label="Custom colour" /></div></div>
      <div class="field"><span>Position</span><div class="seg" id="fPos">${POSITIONS.map((p) => `<button data-y="${p.y}">${p.label}</button>`).join("")}</div></div>
      <div class="field two"><label><span>Across <output id="oX"></output></span><input type="range" id="fX" min="0" max="100" step="1" /></label><label><span>Down <output id="oY"></output></span><input type="range" id="fY" min="0" max="100" step="1" /></label></div>
      <div class="field"><span>Style</span><div class="seg" id="fStyle">${STYLES.map((s) => `<button data-style="${s.id}">${s.label}</button>`).join("")}</div></div>
      <div class="field two"><label><span>Fade <output id="oFade"></output></span><input type="range" id="fFade" min="0" max="1.5" step="0.05" /></label><label><span>Length (s)</span><input type="number" id="fLen" min="0.1" step="0.1" /></label></div>
      <div class="insp-actions"><button class="btn small" id="iSplit">${icons.split} Split</button><button class="btn danger small" id="iDelete">${icons.trash} Delete</button></div>
    </div>`;
  }
  const m = mediaById(c.mediaId);
  const kind = m?.kind ?? "video";
  return `<div class="panel-head"><h2>Inspector</h2></div><div class="scroll">
    ${header(c.track === "audio" ? "audio" : "video", m?.name ?? "Missing media", "")}
    ${isOffline(c) ? `<div class="warn-box">The file for this clip is offline. <button class="btn small" data-relink="${esc(c.mediaId)}">Relink</button></div>` : ""}
    ${kind === "image" ? "" : `<div class="field two"><label><span>In (s)</span><input type="number" id="fIn" min="0" step="0.1" /></label><label><span>Out (s)</span><input type="number" id="fOut" min="0" step="0.1" /></label></div>`}
    ${kind === "image" ? `<label class="field"><span>Length (s)</span><input type="number" id="fLen" min="0.1" step="0.1" /></label>` : ""}
    <dl class="kv">
      <dt>Starts at</dt><dd id="kStart"></dd>
      <dt>Length</dt><dd id="kLen"></dd>
      ${kind === "image" ? "" : `<dt>Source length</dt><dd>${formatTime(m?.duration ?? 0)}</dd>`}
    </dl>
    ${kind === "image" || (kind === "video" && m && !m.hasAudio) ? "" : `<div class="field"><span>Volume <output id="oVol"></output></span><input type="range" id="fVol" min="0" max="2" step="0.05" /></div>`}
    <div class="insp-actions"><button class="btn small" id="iSplit">${icons.split} Split</button><button class="btn danger small" id="iDelete">${icons.trash} Delete</button></div>
  </div>`;
}

function setVal(id, value) {
  const el = $(id);
  if (el && document.activeElement !== el) el.value = value;
}
function setOut(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function syncInspector(c, m) {
  if (!c && !m) {
    setOut("sDur", formatTime(totalDuration(), false));
    setOut("sClips", String(allClips().length));
    setOut("sMedia", String(state.media.length));
    setOut("sSize", `${engine.canvas.width}x${engine.canvas.height}`);
    return;
  }
  if (!c) return;
  setOut("iSub", `${formatTime(c.start)} · ${seconds(dur(c))}`);
  if (c.track === "text") {
    setOut("iTitle", c.text.split("\n")[0] || "Title");
    setVal("fText", c.text);
    setVal("fSize", c.size);
    setOut("oSize", `${Math.round(c.size)} px`);
    setVal("fColor", c.color);
    setVal("fX", c.x);
    setVal("fY", c.y);
    setOut("oX", `${Math.round(c.x)}%`);
    setOut("oY", `${Math.round(c.y)}%`);
    setVal("fFade", c.fade);
    setOut("oFade", `${(+c.fade).toFixed(2)} s`);
    setVal("fLen", (Math.round(dur(c) * 100) / 100).toString());
    for (const b of document.querySelectorAll("#inspector [data-color]")) b.classList.toggle("on", b.dataset.color.toLowerCase() === c.color.toLowerCase());
    for (const b of document.querySelectorAll("#fPos [data-y]")) b.classList.toggle("on", Math.abs(Number(b.dataset.y) - c.y) < 0.5);
    for (const b of document.querySelectorAll("#fStyle [data-style]")) b.classList.toggle("on", b.dataset.style === c.style);
    return;
  }
  setVal("fIn", (Math.round(c.in * 100) / 100).toString());
  setVal("fOut", (Math.round(c.out * 100) / 100).toString());
  setVal("fLen", (Math.round(dur(c) * 100) / 100).toString());
  setOut("kStart", formatTime(c.start));
  setOut("kLen", formatTime(dur(c)));
  setVal("fVol", c.volume ?? 1);
  setOut("oVol", `${Math.round((c.volume ?? 1) * 100)}%`);
}

function onInspectorInput(e) {
  const c = findClip(state.selected);
  if (!c) return;
  const t = e.target;
  const v = Number(t.value);
  switch (t.id) {
    case "fText":
      liveEdit(() => (c.text = t.value));
      break;
    case "fSize":
      liveEdit(() => (c.size = clamp(v, 8, 300)));
      break;
    case "fColor":
      liveEdit(() => (c.color = t.value));
      break;
    case "fX":
      liveEdit(() => (c.x = clamp(v, 0, 100)));
      break;
    case "fY":
      liveEdit(() => (c.y = clamp(v, 0, 100)));
      break;
    case "fFade":
      liveEdit(() => (c.fade = clamp(v, 0, 3)));
      break;
    case "fVol":
      liveEdit(() => (c.volume = clamp(v, 0, 2)));
      break;
    default:
      return;
  }
  syncInspector(c, null);
}

function onInspectorChange(e) {
  const c = findClip(state.selected);
  const t = e.target;
  const v = Number(t.value);
  if (!c || !Number.isFinite(v)) return;
  if (t.id === "fLen") trimClip(c.id, "end", Math.max(MIN_DUR, v) - dur(c));
  else if (t.id === "fIn") trimClip(c.id, "start", v - c.in);
  else if (t.id === "fOut") trimClip(c.id, "end", v - c.out);
  else return;
  t.blur();
  syncInspector(findClip(state.selected), null);
}

function onInspectorClick(e) {
  const relink = e.target.closest("[data-relink]");
  if (relink) return openRelink(relink.dataset.relink);
  const c = findClip(state.selected);
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.id === "iAdd" && state.selectedMedia) return addClipFromMedia(state.selectedMedia);
  if (btn.id === "iRemove" && state.selectedMedia) return removeMedia(state.selectedMedia);
  if (!c) return;
  if (btn.id === "iDelete") return deleteClip(c.id);
  if (btn.id === "iSplit") {
    if (!contains(c, state.playhead)) return toast("Move the playhead over this clip to split it");
    return splitClip(c.id, state.playhead) || toast("Too close to the edge of the clip to split");
  }
  if (btn.dataset.color) return liveEdit(() => (c.color = btn.dataset.color)), syncInspector(c, null);
  if (btn.dataset.y) return liveEdit(() => (c.y = Number(btn.dataset.y))), syncInspector(c, null);
  if (btn.dataset.style) return liveEdit(() => (c.style = btn.dataset.style)), syncInspector(c, null);
}

// ------------------------------------------------------------------ rendering: timeline

const ui = { scroll: null, content: null, ruler: null, rctx: null, tracks: {}, playhead: null, snap: null, insert: null, ghost: null, clipEls: new Map(), colors: {} };

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (n) => css.getPropertyValue(`--${n}`).trim();
  ui.colors = { line: get("line"), dim: get("dim"), text: get("text"), panel: get("panel") };
}

function trackTop(track) {
  return ui.tracks[track].offsetTop;
}

function renderTimeline() {
  const pps = state.pps;
  const viewW = ui.scroll.clientWidth || 800;
  const total = totalDuration();
  const contentW = Math.max(viewW, Math.ceil(TL.xOf(total + Math.max(8, (viewW / pps) * 0.4), pps)));
  ui.content.style.width = `${contentW}px`;
  const seen = new Set();
  for (const track of TRACKS) {
    const host = ui.tracks[track];
    host.querySelector(".tl-hint").hidden = state[track].length > 0;
    for (const c of state[track]) {
      seen.add(c.id);
      let el = ui.clipEls.get(c.id);
      if (!el) {
        el = document.createElement("div");
        el.dataset.id = c.id;
        el.innerHTML = `<div class="bg"></div><div class="label"><span class="name"></span><span class="d"></span></div><div class="handle l" data-edge="start" title="Drag to trim the start"></div><div class="handle r" data-edge="end" title="Drag to trim the end"></div>`;
        ui.clipEls.set(c.id, el);
      }
      if (el.parentNode !== host) host.appendChild(el);
      updateClipEl(el, c);
    }
  }
  for (const [id, el] of ui.clipEls) {
    if (!seen.has(id)) {
      el.remove();
      ui.clipEls.delete(id);
    }
  }
  $("zoomRange").value = String(TL.sliderFromZoom(pps));
  drawRuler();
  updatePlayheadUI(false);
}

function updateClipEl(el, c) {
  const pps = state.pps;
  const m = c.mediaId ? mediaById(c.mediaId) : null;
  const w = Math.max(3, TL.timeToPx(dur(c), pps));
  const offline = isOffline(c);
  if (!(gesture && gesture.clip === c && gesture.type === "move" && c.track === "video")) {
    el.style.left = `${TL.xOf(c.start, pps)}px`;
    el.style.transform = "";
  }
  el.style.width = `${w}px`;
  const cls = ["clip", `clip-${c.track}`, `kind-${m?.kind ?? "text"}`];
  if (state.selected === c.id) cls.push("selected");
  if (offline) cls.push("missing");
  if (w < 70) cls.push("narrow");
  if (m?.strip) cls.push("has-strip");
  if (gesture && gesture.clip === c && gesture.moved && gesture.type === "move") cls.push("dragging");
  el.className = cls.join(" ");
  const name = c.track === "text" ? c.text.split("\n")[0] || "Title" : m?.name ?? "Missing media";
  const nameEl = el.querySelector(".name");
  if (nameEl.textContent !== name) nameEl.textContent = name;
  el.querySelector(".d").textContent = seconds(dur(c));
  el.title = `${name} · ${seconds(dur(c))}`;
  const bg = el.querySelector(".bg");
  let image = "";
  let size = "";
  let pos = "";
  if (!offline && m) {
    if (m.kind === "video" && m.strip) {
      image = `url(${m.strip})`;
      size = `${TL.timeToPx(m.duration, pps)}px 100%`;
      pos = `${-TL.timeToPx(c.in, pps)}px 0`;
    } else if (m.kind === "video" || m.kind === "image") {
      image = m.thumb ? `url(${m.thumb})` : "";
      size = "auto 100%";
      pos = "0 0";
    } else if (m.kind === "audio" && m.wave) {
      image = `url(${m.wave})`;
      size = `${TL.timeToPx(m.duration, pps)}px 100%`;
      pos = `${-TL.timeToPx(c.in, pps)}px 0`;
    }
  }
  // The waveform is a mask filled with a theme colour, so it reads in dark and light mode.
  const masked = c.track === "audio";
  if (bg.dataset.image !== image) {
    bg.style.backgroundImage = masked ? "" : image;
    bg.style.webkitMaskImage = masked ? image : "";
    bg.style.maskImage = masked ? image : "";
    bg.classList.toggle("wave", masked && Boolean(image));
    bg.dataset.image = image;
  }
  if (masked) {
    bg.style.webkitMaskSize = size;
    bg.style.maskSize = size;
    bg.style.webkitMaskPosition = pos;
    bg.style.maskPosition = pos;
  } else {
    bg.style.backgroundSize = size;
    bg.style.backgroundPosition = pos;
  }
  let relink = el.querySelector(".relink");
  if (offline && !relink && w > 60) {
    relink = document.createElement("button");
    relink.className = "relink";
    relink.textContent = "Relink media";
    relink.dataset.relink = c.mediaId;
    relink.title = "Find this clip's file again";
    el.appendChild(relink);
  } else if (relink && (!offline || w <= 60)) relink.remove();
}

function drawRuler() {
  const canvas = ui.ruler;
  const viewW = ui.scroll.clientWidth || 800;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(viewW * dpr) || canvas.height !== Math.round(26 * dpr)) {
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(26 * dpr);
    canvas.style.width = `${viewW}px`;
  }
  const g = ui.rctx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, viewW, 26);
  const pps = state.pps;
  const scroll = ui.scroll.scrollLeft;
  const { major, minor } = TL.ticks(pps);
  const t0 = Math.max(0, Math.floor(TL.tOf(scroll, pps) / minor) * minor);
  const t1 = TL.tOf(scroll + viewW, pps);
  g.font = `500 10.5px ${getComputedStyle(document.body).getPropertyValue("--mono") || "monospace"}`;
  g.textBaseline = "top";
  const total = totalDuration();
  if (total > 0) {
    g.fillStyle = "rgba(127,127,127,0.10)";
    g.fillRect(GUTTER - scroll, 0, TL.timeToPx(total, pps), 26);
  }
  for (let i = 0, t = t0; t <= t1 + minor && i < 4000; i++, t = t0 + i * minor) {
    const x = Math.round(TL.xOf(t, pps) - scroll) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    g.strokeStyle = isMajor ? ui.colors.dim : ui.colors.line;
    g.globalAlpha = isMajor ? 0.8 : 0.7;
    g.beginPath();
    g.moveTo(x, isMajor ? 12 : 19);
    g.lineTo(x, 26);
    g.stroke();
    if (isMajor) {
      g.globalAlpha = 1;
      g.fillStyle = ui.colors.dim;
      g.fillText(rulerLabel(t, major), x + 8, 3);
    }
  }
  g.globalAlpha = 1;
}

function updatePlayheadUI(follow) {
  const x = TL.xOf(state.playhead, state.pps);
  ui.playhead.style.transform = `translateX(${x}px)`;
  $("tcNow").textContent = formatTime(state.playhead);
  if (follow) {
    const viewW = ui.scroll.clientWidth;
    const left = ui.scroll.scrollLeft;
    if (x > left + viewW * 0.88 || x < left) ui.scroll.scrollLeft = Math.max(0, x - viewW * 0.12);
  }
  if (!engine.exporting) $("splitBtn").disabled = !allClips().some((c) => contains(c, state.playhead));
}

function setZoom(pps, anchorTime = null, anchorX = null) {
  const next = TL.clampZoom(pps);
  const viewW = ui.scroll.clientWidth || 800;
  const aT = anchorTime ?? state.playhead;
  const aX = anchorX ?? clamp(TL.xOf(aT, state.pps) - ui.scroll.scrollLeft, 0, viewW);
  state.pps = next;
  renderTimeline();
  ui.scroll.scrollLeft = TL.scrollForAnchor(aT, next, aX);
  drawRuler();
  scheduleSave();
}

function fitZoom() {
  const viewW = ui.scroll.clientWidth || 800;
  const total = Math.max(totalDuration(), 2);
  state.pps = TL.clampZoom((viewW - 48) / total);
  renderTimeline();
  ui.scroll.scrollLeft = 0;
  drawRuler();
}

function showSnap(t) {
  if (t == null) {
    ui.snap.hidden = true;
    return;
  }
  ui.snap.hidden = false;
  ui.snap.style.transform = `translateX(${TL.xOf(t, state.pps)}px)`;
}

function snapPoints(excludeId, includePlayhead = true) {
  const pts = [0];
  if (includePlayhead) pts.push(state.playhead);
  for (const c of allClips()) {
    if (c.id === excludeId) continue;
    pts.push(c.start, end(c));
  }
  return pts;
}

const contentX = (e) => e.clientX - ui.content.getBoundingClientRect().left;

function videoInsertIndex(t, excludeId) {
  const others = state.video.filter((c) => c.id !== excludeId);
  let acc = 0;
  for (let i = 0; i < others.length; i++) {
    const d = dur(others[i]);
    if (t < acc + d / 2) return { index: i, at: acc };
    acc += d;
  }
  return { index: others.length, at: acc };
}

function showInsert(at) {
  if (at == null) {
    ui.insert.hidden = true;
    return;
  }
  const top = trackTop("video");
  ui.insert.hidden = false;
  ui.insert.style.top = `${top + 2}px`;
  ui.insert.style.height = `${ui.tracks.video.offsetHeight - 4}px`;
  ui.insert.style.transform = `translateX(${TL.xOf(at, state.pps)}px)`;
}

function showGhost(track, start, length) {
  if (track == null) {
    ui.ghost.hidden = true;
    return;
  }
  ui.ghost.hidden = false;
  ui.ghost.style.top = `${trackTop(track) + 5}px`;
  ui.ghost.style.height = `${ui.tracks[track].offsetHeight - 10}px`;
  ui.ghost.style.left = `${TL.xOf(start, state.pps)}px`;
  ui.ghost.style.width = `${Math.max(4, TL.timeToPx(length, state.pps))}px`;
}

function onTimelinePointerDown(e) {
  if (e.button !== 0 || engine.exporting) return;
  const relink = e.target.closest("[data-relink]");
  if (relink) {
    openRelink(relink.dataset.relink);
    return;
  }
  endLive();
  const clipEl = e.target.closest(".clip");
  const x = contentX(e);
  ui.content.setPointerCapture(e.pointerId);
  if (clipEl) {
    const c = findClip(clipEl.dataset.id);
    if (!c) return;
    if (engine.playing) pause();
    select(c.id);
    const handle = e.target.closest(".handle");
    gesture = { type: handle ? "trim" : "move", edge: handle?.dataset.edge, clip: c, el: clipEl, x0: x, cx0: e.clientX, orig: { ...c }, before: snapshot(), moved: false, points: snapPoints(c.id), index: null };
    e.preventDefault();
    return;
  }
  if (e.target.closest(".tl-track") && (state.selected || state.selectedMedia)) {
    state.selected = null;
    state.selectedMedia = null;
    renderAll();
  }
  gesture = { type: "scrub", x0: x, cx0: e.clientX, moved: false };
  seek(TL.tOf(x, state.pps), { snap: !e.altKey });
  e.preventDefault();
}

function onTimelinePointerMove(e) {
  if (!gesture) return;
  const x = contentX(e);
  const pps = state.pps;
  if (gesture.type === "scrub") {
    seek(TL.tOf(x, pps), { snap: !e.altKey });
    return;
  }
  if (!gesture.moved && Math.abs(e.clientX - gesture.cx0) < 4) return;
  gesture.moved = true;
  const c = gesture.clip;
  const o = gesture.orig;
  let delta = TL.pxToTime(x - gesture.x0, pps);
  const snapOn = state.snapping && !e.altKey;
  let snapAt = null;
  if (gesture.type === "trim") {
    if (gesture.edge === "end") {
      const edgeT = o.start + (o.out + delta - o.in);
      const s = snapOn ? TL.snap(edgeT, gesture.points, pps) : { snapped: false };
      if (s.snapped) {
        delta += s.t - edgeT;
        snapAt = s.t;
      }
    } else if (c.track !== "video") {
      const edgeT = o.start + delta;
      const s = snapOn ? TL.snap(edgeT, gesture.points, pps) : { snapped: false };
      if (s.snapped) {
        delta += s.t - edgeT;
        snapAt = s.t;
      }
    }
    Object.assign(c, o);
    applyTrim(c, o, gesture.edge, delta);
    layoutVideo();
    engine.peek = gesture.edge === "end" ? Math.max(c.start, end(c) - FRAME) : c.start;
    renderTimeline();
    syncInspector(c, null);
    invalidate();
  } else if (c.track === "video") {
    gesture.el.classList.add("dragging");
    gesture.el.style.transform = `translateX(${x - gesture.x0}px)`;
    const { index, at } = videoInsertIndex(TL.tOf(x, pps), c.id);
    gesture.index = index;
    showInsert(at);
  } else {
    let start = Math.max(0, o.start + delta);
    if (snapOn) {
      const a = TL.snap(start, gesture.points, pps);
      const b = TL.snap(start + dur(o), gesture.points, pps);
      if (a.snapped && (!b.snapped || Math.abs(a.t - start) <= Math.abs(b.t - start - dur(o)))) {
        start = a.t;
        snapAt = a.t;
      } else if (b.snapped) {
        start = b.t - dur(o);
        snapAt = b.t;
      }
    }
    c.start = Math.max(0, start);
    renderTimeline();
    syncInspector(c, null);
    invalidate();
  }
  showSnap(snapAt);
}

function onTimelinePointerUp() {
  const g = gesture;
  if (!g) return;
  gesture = null;
  showSnap(null);
  showInsert(null);
  engine.peek = null;
  if (g.type === "scrub") {
    scheduleSave();
    return;
  }
  const c = g.clip;
  if (g.moved) {
    if (g.type === "move" && c.track === "video") {
      g.el.classList.remove("dragging");
      g.el.style.transform = "";
      if (g.index != null) {
        const others = state.video.filter((x) => x.id !== c.id);
        others.splice(g.index, 0, c);
        state.video = others;
      }
    } else if (g.type === "move") sortTrack(c.track);
    else normalize(c);
    commitIfChanged(g.before);
  } else {
    renderAll();
  }
  invalidate();
}

function onTimelineWheel(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const x = contentX(e);
    const t = TL.tOf(x, state.pps);
    setZoom(state.pps * Math.pow(1.0018, -e.deltaY), t, x - ui.scroll.scrollLeft);
  } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    ui.scroll.scrollLeft += e.deltaY;
  }
}

// ------------------------------------------------------------------ drag and drop

let dragMedia = null;
let dragDepth = 0;

function dropTarget(e) {
  const m = mediaById(dragMedia);
  if (!m) return null;
  const t = Math.max(0, TL.tOf(contentX(e), state.pps));
  if (m.kind === "audio") {
    const s = state.snapping ? TL.snap(t, snapPoints(null), state.pps) : { t };
    return { kind: "audio", start: s.t, length: m.duration };
  }
  return { kind: "video", ...videoInsertIndex(t, null) };
}

function wireDragAndDrop() {
  const grid = $("binGrid");
  grid.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".media-card");
    if (!card || card.classList.contains("missing")) return e.preventDefault();
    dragMedia = card.dataset.id;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("application/x-video-editor-media", dragMedia);
  });
  grid.addEventListener("dragend", () => {
    dragMedia = null;
    showInsert(null);
    showGhost(null);
  });
  ui.content.addEventListener("dragover", (e) => {
    if (!dragMedia) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const target = dropTarget(e);
    if (!target) return;
    if (target.kind === "audio") {
      showInsert(null);
      showGhost("audio", target.start, target.length);
    } else {
      showGhost(null);
      showInsert(target.at);
    }
  });
  ui.content.addEventListener("dragleave", (e) => {
    if (!ui.content.contains(e.relatedTarget)) {
      showInsert(null);
      showGhost(null);
    }
  });
  ui.content.addEventListener("drop", (e) => {
    if (!dragMedia) return;
    e.preventDefault();
    e.stopPropagation();
    const target = dropTarget(e);
    const id = dragMedia;
    dragMedia = null;
    showInsert(null);
    showGhost(null);
    if (!target) return;
    if (target.kind === "audio") addClipFromMedia(id, { start: target.start });
    else addClipFromMedia(id, { index: target.index });
  });

  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $("dropOverlay").hidden = false;
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $("dropOverlay").hidden = true;
  });
  document.addEventListener("dragover", (e) => {
    if (hasFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  document.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    if (engine.exporting) return toast("Wait for the export to finish");
    const overTimeline = ui.content.contains(e.target);
    const t = overTimeline ? Math.max(0, TL.tOf(contentX(e), state.pps)) : null;
    const ids = await importFiles(e.dataTransfer.files);
    if (overTimeline && ids.length) {
      edit(() => {
        let { index } = videoInsertIndex(t, null);
        let at = t;
        for (const id of ids) {
          const m = mediaById(id);
          // A file that relinked an offline item is already on the timeline.
          if (!m || [...state.video, ...state.audio].some((c) => c.mediaId === id)) continue;
          if (m.kind === "audio") {
            addClipFromMedia(id, { start: at });
            at += m.duration;
          } else addClipFromMedia(id, { index: index++ });
        }
      });
    }
  });
}

// ------------------------------------------------------------------ keyboard

function onKey(e) {
  if (!$("modal").hidden) {
    if (e.key === "Escape") {
      if (engine.exporting) cancelExport();
      else closeModal(false);
    }
    return;
  }
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  let handled = true;
  if (mod && k === "z") e.shiftKey ? redo() : undo();
  else if (mod && k === "y") redo();
  else if (mod && k === "s") saveProject().then((ok) => ok && toast("Project saved"));
  else if (mod && k === "e") exportVideo();
  else if (mod) handled = false;
  else if (k === " ") togglePlay();
  else if (k === "k") pause();
  else if (k === "l") shuttle(1);
  else if (k === "j") shuttle(-1);
  else if (k === "ArrowLeft") e.shiftKey ? (pause(), seek(state.playhead - 1)) : nudge(-1);
  else if (k === "ArrowRight") e.shiftKey ? (pause(), seek(state.playhead + 1)) : nudge(1);
  else if (k === "Home") seek(0);
  else if (k === "End") seek(totalDuration());
  else if (k === "s") splitAtPlayhead();
  else if (k === "Delete" || k === "Backspace") deleteSelected();
  else if (k === "t") addTitle();
  else if (k === "n") toggleSnap();
  else if (k === "+" || k === "=") setZoom(state.pps * 1.4);
  else if (k === "-" || k === "_") setZoom(state.pps / 1.4);
  else if (k === "\\") fitZoom();
  else if (k === "Escape") {
    state.selected = null;
    state.selectedMedia = null;
    renderAll();
  } else handled = false;
  if (handled) e.preventDefault();
}

function toggleSnap() {
  state.snapping = !state.snapping;
  renderTransport();
  scheduleSave();
  toast(state.snapping ? "Snapping on" : "Snapping off");
}

// ------------------------------------------------------------------ theme and layout

function luminance(color) {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [128, 128, 128];
  probe.remove();
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function applyTheme(t) {
  const root = document.documentElement;
  const mode = t && t.mode === "light" ? "light" : "dark";
  const defaults = mode === "light" ? LIGHT : DARK;
  root.dataset.mode = mode;
  for (const name of Object.keys(DARK)) {
    const value = String(t?.colors?.[name] ?? "").trim();
    root.style.setProperty(`--${name}`, value || defaults[name]);
  }
  if (t?.sans) root.style.setProperty("--sans", t.sans);
  if (t?.mono) root.style.setProperty("--mono", t.mono);
  const accent = getComputedStyle(root).getPropertyValue("--accent").trim() || defaults.accent;
  root.style.setProperty("--btn-ink", luminance(accent) > 0.4 ? "#06222a" : "#ffffff");
  readColors();
  if (ui.ruler) drawRuler();
}

function applyAspect() {
  const { w, h } = ASPECTS[state.aspect];
  if (engine.canvas.width !== w || engine.canvas.height !== h) {
    engine.canvas.width = w;
    engine.canvas.height = h;
    engine.frame.width = w;
    engine.frame.height = h;
    engine.fctx.fillStyle = "#000";
    engine.fctx.fillRect(0, 0, w, h);
  }
  fitStage();
  invalidate();
}

function fitStage() {
  const stage = $("stage");
  const pad = 20;
  const sw = Math.max(50, stage.clientWidth - pad * 2);
  const sh = Math.max(50, stage.clientHeight - pad * 2);
  const { width: cw, height: ch } = engine.canvas;
  const s = Math.min(sw / cw, sh / ch);
  engine.canvas.style.width = `${Math.floor(cw * s)}px`;
  engine.canvas.style.height = `${Math.floor(ch * s)}px`;
}

// ------------------------------------------------------------------ wiring

function wire() {
  engine.canvas = $("preview");
  engine.ctx = engine.canvas.getContext("2d");
  engine.frame = document.createElement("canvas");
  engine.frame.width = engine.canvas.width;
  engine.frame.height = engine.canvas.height;
  engine.fctx = engine.frame.getContext("2d");
  ui.scroll = $("tlScroll");
  ui.content = $("tlContent");
  ui.ruler = $("tlRuler");
  ui.rctx = ui.ruler.getContext("2d");
  ui.playhead = $("tlPlayhead");
  ui.snap = $("tlSnap");
  ui.insert = $("tlInsert");
  ui.ghost = $("tlGhost");
  for (const el of document.querySelectorAll(".tl-track")) ui.tracks[el.dataset.track] = el;

  const pick = () => {
    $("fileInput").value = "";
    $("fileInput").click();
  };
  for (const id of ["importBtn", "binImport", "stageImport"]) $(id).addEventListener("click", pick);
  for (const id of ["binSample", "stageSample"]) $(id).addEventListener("click", loadSample);
  $("fileInput").addEventListener("change", (e) => importFiles(e.target.files));
  $("relinkInput").addEventListener("change", (e) => {
    const id = relinkTarget;
    relinkTarget = null;
    if (id && e.target.files.length) importFiles([e.target.files[0]], { relinkId: id });
  });

  $("binGrid").addEventListener("click", (e) => {
    const relink = e.target.closest("[data-relink]");
    if (relink) return openRelink(relink.dataset.relink);
    const add = e.target.closest("[data-add]");
    if (add) return addClipFromMedia(add.dataset.add);
    const card = e.target.closest(".media-card");
    if (card) selectMedia(card.dataset.id);
  });
  $("binGrid").addEventListener("dblclick", (e) => {
    const card = e.target.closest(".media-card");
    if (card && !card.classList.contains("missing")) addClipFromMedia(card.dataset.id);
  });
  $("binGrid").addEventListener("keydown", (e) => {
    const card = e.target.closest(".media-card");
    if (card && e.key === "Enter" && !card.classList.contains("missing")) {
      e.stopPropagation();
      addClipFromMedia(card.dataset.id);
    }
  });

  $("tPlay").addEventListener("click", togglePlay);
  $("tStart").addEventListener("click", () => seek(0));
  $("tEnd").addEventListener("click", () => seek(totalDuration()));
  $("tBack").addEventListener("click", () => nudge(-1));
  $("tFwd").addEventListener("click", () => nudge(1));
  $("addTitleBtn").addEventListener("click", () => addTitle());
  $("splitBtn").addEventListener("click", splitAtPlayhead);
  $("deleteBtn").addEventListener("click", deleteSelected);
  $("snapBtn").addEventListener("click", toggleSnap);
  $("zoomIn").addEventListener("click", () => setZoom(state.pps * 1.4));
  $("zoomOut").addEventListener("click", () => setZoom(state.pps / 1.4));
  $("zoomFit").addEventListener("click", fitZoom);
  $("zoomRange").addEventListener("input", (e) => setZoom(TL.zoomFromSlider(Number(e.target.value))));
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("newBtn").addEventListener("click", newProject);
  $("exportBtn").addEventListener("click", () => exportVideo());
  $("frameBtn").addEventListener("click", exportFrame);
  $("aspect").addEventListener("change", (e) => setAspect(e.target.value));
  $("muteVideo").addEventListener("click", () => {
    state.muted.video = !state.muted.video;
    renderTransport();
    scheduleSave();
  });
  $("muteAudio").addEventListener("click", () => {
    state.muted.audio = !state.muted.audio;
    renderTransport();
    scheduleSave();
  });
  $("projectName").addEventListener("input", (e) => {
    state.name = e.target.value.slice(0, 80) || "Untitled edit";
    scheduleSave();
  });
  $("projectName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });

  const insp = $("inspector");
  insp.addEventListener("input", onInspectorInput);
  insp.addEventListener("change", onInspectorChange);
  insp.addEventListener("click", onInspectorClick);
  insp.addEventListener("focusout", () => setTimeout(endLive, 0));

  ui.content.addEventListener("pointerdown", onTimelinePointerDown);
  ui.content.addEventListener("pointermove", onTimelinePointerMove);
  ui.content.addEventListener("pointerup", onTimelinePointerUp);
  ui.content.addEventListener("pointercancel", onTimelinePointerUp);
  ui.scroll.addEventListener("wheel", onTimelineWheel, { passive: false });
  ui.scroll.addEventListener("scroll", drawRuler, { passive: true });
  wireDragAndDrop();

  $("modal").addEventListener("click", (e) => {
    if (e.target === $("modal") && !engine.exporting) closeModal(false);
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", () => audio.ctx?.state === "suspended" && audio.ctx.resume().catch(() => {}), true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && engine.playing && !engine.exporting) pause();
    if (engine.exporting) {
      cancelAnimationFrame(engine.raf);
      engine.raf = 0;
      schedule();
    }
  });
  const ro = new ResizeObserver(() => {
    fitStage();
    renderTimeline();
  });
  ro.observe($("stage"));
  ro.observe(ui.scroll);
}

// ------------------------------------------------------------------ self-tests

let booted = null;
let testClip = null;
const getTestClip = () => (testClip ??= makeSyntheticClip({ seconds: 1.5, width: 320, height: 180, hue: 200, label: "Test", name: "test-clip.webm" }));
const near = (a, b, eps) => Math.abs(a - b) <= eps;

async function isolated(fn) {
  await booted;
  clearProject();
  try {
    return await fn();
  } finally {
    clearProject();
    await saveProject();
    clearTimeout(toastTimer);
    $("toast").classList.remove("show");
  }
}

async function importTestClip() {
  const file = await getTestClip();
  const [id] = await importFiles([file]);
  Rosalena.assert(id, "the generated clip did not import");
  return { id, file, media: mediaById(id) };
}

Rosalena.test("timeline maths: time and pixels agree at every zoom level", async () => {
  await isolated(async () => {
    for (const pps of [ZOOM_MIN, 12.5, 37.5, 64, 150, 333.3, ZOOM_MAX]) {
      for (const t of [0, FRAME, 0.5, 1.234, 59.9, 3600]) {
        Rosalena.assert(near(TL.pxToTime(TL.timeToPx(t, pps), pps), t, 1e-9), `round trip failed at ${pps} px/s, ${t} s`);
        Rosalena.assert(near(TL.tOf(TL.xOf(t, pps), pps), t, 1e-9), `position round trip failed at ${pps} px/s, ${t} s`);
        Rosalena.assert(near(TL.xOf(t + 1, pps) - TL.xOf(t, pps), TL.timeToPx(1, pps), 1e-6), "positions and lengths disagree");
      }
      Rosalena.assert(TL.xOf(0, pps) === GUTTER, "time 0 is not at the gutter");
      Rosalena.assert(near(TL.timeToPx(3, pps), 3 * TL.timeToPx(1, pps), 1e-9), "time to pixels is not linear");
      Rosalena.assert(near(TL.zoomFromSlider(TL.sliderFromZoom(pps)), pps, 1e-6), `zoom slider round trip failed at ${pps}`);
      const { major, minor } = TL.ticks(pps);
      Rosalena.assert(major * pps >= 80 || major === 3600, `ruler labels too close at ${pps} px/s`);
      Rosalena.assert(minor > 0 && minor <= major, "minor ticks must subdivide major ticks");
      const anchorT = 7.25;
      const scroll = TL.scrollForAnchor(anchorT, pps, 300);
      Rosalena.assert(scroll === 0 || near(TL.xOf(anchorT, pps) - scroll, 300, 1e-6), "zoom does not keep the anchor under the pointer");
    }
    Rosalena.assert(TL.snap(2.03, [2], 100).snapped && TL.snap(2.03, [2], 100).t === 2, "a point 3 px away should snap");
    Rosalena.assert(!TL.snap(2.2, [2], 100).snapped, "a point 20 px away should not snap");
    Rosalena.assert(TL.clampZoom(1) === ZOOM_MIN && TL.clampZoom(1e6) === ZOOM_MAX, "zoom is not clamped");
    // The DOM uses the same maths: a 2.5 s title is 2.5 * pps wide at any zoom.
    const c = addTitle({ start: 1, duration: 2.5 });
    for (const pps of [20, 64, 200]) {
      setZoom(pps);
      const el = ui.clipEls.get(c.id);
      Rosalena.assert(el, "the title has no element on the timeline");
      Rosalena.assert(near(parseFloat(el.style.width), 2.5 * pps, 0.5), `clip width ${el.style.width} is not ${2.5 * pps}px at ${pps} px/s`);
      Rosalena.assert(near(parseFloat(el.style.left), TL.xOf(1, pps), 0.5), `clip left ${el.style.left} is not ${TL.xOf(1, pps)}px`);
      Rosalena.assert(near(el.getBoundingClientRect().width, 2.5 * pps, 1), "the rendered clip width does not match the maths");
      seek(2);
      const tx = Number(/translateX\(([-\d.]+)px\)/.exec(ui.playhead.style.transform)?.[1]);
      Rosalena.assert(near(tx, TL.xOf(state.playhead, pps), 0.5), "the playhead is drawn at the wrong place");
    }
  });
});

Rosalena.test("imports a generated clip into the bin with a duration and thumbnail", async () => {
  await isolated(async () => {
    const { media, file } = await importTestClip();
    Rosalena.assert(file.size > 1000, `the generated clip is only ${file.size} bytes`);
    Rosalena.assert(media.kind === "video", `kind is ${media.kind}`);
    Rosalena.assert(near(media.duration, 1.5, 0.35), `duration is ${media.duration}, expected about 1.5 s`);
    Rosalena.assert(media.width === 320 && media.height === 180, `size is ${media.width}x${media.height}`);
    Rosalena.assert(media.thumb && media.thumb.startsWith("data:image/"), "no thumbnail");
    const card = document.querySelector(`.media-card[data-id="${media.id}"]`);
    Rosalena.assert(card, "the clip is not shown in the bin");
    Rosalena.assert(/00:01|00:02/.test(card.querySelector(".badge").textContent), `the bin shows ${card.querySelector(".badge").textContent}`);
    const img = await makeCardImage({ width: 320, height: 180, name: "still.png" });
    const wav = makeToneWav({ seconds: 1, name: "beep.wav" });
    const ids = await importFiles([img, wav]);
    Rosalena.assert(ids.length === 2, "the image and the WAV did not both import");
    Rosalena.assert(mediaById(ids[0]).kind === "image" && mediaById(ids[1]).kind === "audio", "wrong kinds for the image and the WAV");
    Rosalena.assert(near(mediaById(ids[1]).duration, 1, 0.05), `the WAV is ${mediaById(ids[1]).duration} s`);
    Rosalena.assert(mediaById(ids[1]).wave, "the WAV has no waveform");
    Rosalena.assert($("binEmpty").hidden, "the empty bin message is still showing");
  });
});

Rosalena.test("adds a clip to the timeline and draws its frames on the preview", async () => {
  await isolated(async () => {
    const { id, media } = await importTestClip();
    const c = addClipFromMedia(id);
    Rosalena.assert(c && state.video.length === 1, "the clip is not on the video track");
    Rosalena.assert(near(dur(c), media.duration, 1e-9), "the clip length does not match the media");
    Rosalena.assert(ui.clipEls.get(c.id)?.isConnected, "the clip has no element on the timeline");
    Rosalena.assert(near(totalDuration(), media.duration, 1e-9), "the sequence length is wrong");
    addTitle({ text: "HELLO", start: 0, duration: 1.5, fade: 0, size: 120, color: "#ff0000", y: 50, style: "plain" });
    seek(0.5);
    Rosalena.assert(await primeFrame(0.5, 4000), "the frame at 0.5 s never decoded");
    const g = engine.ctx;
    const corner = g.getImageData(8, 8, 1, 1).data;
    Rosalena.assert(corner[0] + corner[1] + corner[2] > 30, `the preview is black where the clip should be (${corner.join(",")})`);
    const cx = Math.round(engine.canvas.width / 2);
    const cy = Math.round(engine.canvas.height / 2);
    let red = 0;
    const px = g.getImageData(cx - 200, cy - 40, 400, 80).data;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 200 && px[i + 1] < 60 && px[i + 2] < 60) red++;
    Rosalena.assert(red > 200, `the red title was not drawn over the video (${red} red pixels)`);
    Rosalena.assert($("stageEmpty").hidden, "the empty-state message still covers the preview");
  });
});

Rosalena.test("split at 0.5 s gives two clips that add up to the original, and undo restores it", async () => {
  await isolated(async () => {
    const { id } = await importTestClip();
    const c = addClipFromMedia(id);
    const original = dur(c);
    const parts = splitClip(c.id, 0.5);
    Rosalena.assert(parts && state.video.length === 2, "split did not make two clips");
    const [a, b] = state.video;
    Rosalena.assert(near(dur(a), 0.5, 1e-9), `the first part is ${dur(a)} s`);
    Rosalena.assert(near(dur(a) + dur(b), original, 1e-9), "the parts do not add up to the original");
    Rosalena.assert(near(b.in, 0.5, 1e-9) && near(b.start, 0.5, 1e-9), "the second part does not continue the source");
    undo();
    Rosalena.assert(state.video.length === 1 && near(dur(state.video[0]), original, 1e-9), "undo did not restore the clip");
    redo();
    Rosalena.assert(state.video.length === 2, "redo did not split again");
    // The S key goes through the same path.
    undo();
    seek(1.0);
    state.selected = null;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    Rosalena.assert(state.video.length === 2 && near(dur(state.video[0]), 1.0, 0.02), "the S key did not split at the playhead");
    state.selected = state.video[1].id;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    Rosalena.assert(state.video.length === 1, "the Delete key did not delete the selected clip");
  });
});

Rosalena.test("trimming changes the duration and stays inside the source", async () => {
  await isolated(async () => {
    const { id, media } = await importTestClip();
    const c = addClipFromMedia(id);
    const d0 = dur(c);
    trimClip(c.id, "end", -0.4);
    Rosalena.assert(near(dur(c), d0 - 0.4, 1e-9), `end trim gave ${dur(c)} s`);
    trimClip(c.id, "start", 0.3);
    Rosalena.assert(near(c.in, 0.3, 1e-9) && near(dur(c), d0 - 0.7, 1e-9), "start trim did not move the in point");
    Rosalena.assert(c.start === 0, "a video clip must stay packed at the start of the track");
    trimClip(c.id, "end", 99);
    Rosalena.assert(near(c.out, media.duration, 1e-9), "end trim went past the end of the source");
    trimClip(c.id, "start", -99);
    Rosalena.assert(c.in === 0, "start trim went before the start of the source");
    trimClip(c.id, "end", -99);
    Rosalena.assert(near(dur(c), MIN_DUR, 1e-9), "a clip can be trimmed shorter than the minimum");
    const t = addTitle({ start: 2, duration: 3 });
    trimClip(t.id, "start", 1);
    Rosalena.assert(near(t.start, 3, 1e-9) && near(dur(t), 2, 1e-9) && t.in === 0, "trimming a title's start did not move it");
    const el = ui.clipEls.get(t.id);
    Rosalena.assert(near(parseFloat(el.style.width), 2 * state.pps, 0.5), "the timeline did not redraw the trimmed title");
  });
});

Rosalena.test("reordering clips changes the playback order", async () => {
  await isolated(async () => {
    const { id } = await importTestClip();
    const [imgId] = await importFiles([await makeCardImage({ width: 320, height: 180, name: "card.png" })]);
    const v = addClipFromMedia(id);
    const i = addClipFromMedia(imgId);
    Rosalena.assert(state.video[0] === v && state.video[1] === i, "clips were not added in order");
    trimClip(i.id, "end", 0.5 - dur(i));
    Rosalena.assert(near(i.start, dur(v), 1e-9), "the image does not start where the video ends");
    moveVideoClip(i.id, 0);
    Rosalena.assert(state.video[0] === i && state.video[1] === v, "reorder did not move the image first");
    Rosalena.assert(i.start === 0 && near(v.start, dur(i), 1e-9), "starts were not recomputed after the reorder");
    Rosalena.assert(clipAt("video", 0.1) === i, "the image is not the clip at 0.1 s");
    const els = [...ui.tracks.video.querySelectorAll(".clip")].sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
    Rosalena.assert(els[0].dataset.id === i.id, "the timeline did not redraw the new order");
    // Playback runs across the cut from the image into the video.
    seek(0);
    play();
    const started = performance.now();
    const until = started + 6000;
    while (state.playhead < dur(i) + 0.3 && engine.playing && performance.now() < until) await sleep(50);
    const reached = state.playhead;
    const took = performance.now() - started;
    const rec = engine.els.get(v.id);
    const diag = rec ? `el paused=${rec.el.paused} ready=${rec.el.readyState} t=${rec.el.currentTime.toFixed(2)} prepared=${rec.prepared} pending=${rec.pendingSeek} seeking=${rec.el.seeking} muted=${rec.el.muted} ctx=${audio.ctx?.state} err=${engine.playError}` : "no element";
    pause();
    Rosalena.assert(reached > dur(i) + 0.2, `playback stopped at ${reached.toFixed(2)} s, before getting past the cut (${diag})`);
    Rosalena.assert(took < 2500, `0.8 s of sequence took ${Math.round(took)} ms to play: it stalled at the cut (${diag})`);
  });
});

Rosalena.test("project saves and restores, with relink placeholders for unloaded media", async () => {
  await isolated(async () => {
    const { id, file } = await importTestClip();
    const v = addClipFromMedia(id);
    splitClip(v.id, 0.6);
    const [wavId] = await importFiles([makeToneWav({ seconds: 1.2, name: "bed.wav" })]);
    addClipFromMedia(wavId, { start: 0.2 });
    addTitle({ text: "Round trip", start: 0.3, duration: 1, color: "#ffe066", y: 20, style: "box" });
    state.name = "Round trip test";
    setAspect("9:16");
    Rosalena.assert(await saveProject(), "saving to Rosalena.storage failed");
    const canon = () => JSON.stringify(TRACKS.map((tr) => state[tr].map((c) => JSON.stringify(c, Object.keys(c).sort()))));
    const before = canon();
    // A reopened session: the clips are remembered but the files are not loaded.
    forgetFiles();
    Object.assign(state, { media: [], text: [], video: [], audio: [] });
    Rosalena.assert(await loadProject(), "nothing was loaded from storage");
    Rosalena.assert(before === canon(), "the restored clips differ from the saved ones");
    Rosalena.assert(state.video.length === 2 && state.audio.length === 1 && state.text.length === 1, "clips are missing after the restore");
    setZoom(200);
    Rosalena.assert(state.name === "Round trip test" && state.aspect === "9:16" && engine.canvas.width === 720, "the name or canvas shape was not restored");
    Rosalena.assert(state.media.length === 2 && state.media.every((m) => m.missing), "restored media should be offline");
    Rosalena.assert(document.querySelectorAll(".clip.missing .relink").length >= 2, "offline clips have no Relink button");
    Rosalena.assert(document.querySelectorAll(".media-card.missing [data-relink]").length === 2, "the bin has no Relink buttons");
    await primeFrame(0.1, 500);
    // Dropping the same file again relinks it by name and size.
    await importFiles([file]);
    const m = mediaById(id);
    Rosalena.assert(m && !m.missing && state.media.length === 2, "the file did not relink to its offline item");
    Rosalena.assert(state.video.every((c) => !isOffline(c)), "video clips are still offline after relinking");
    Rosalena.assert(state.audio.every(isOffline), "the WAV should still be offline");
  });
});

Rosalena.test("export renders a short sequence to a non-empty WebM and a PNG frame", async () => {
  await isolated(async () => {
    const { id } = await importTestClip();
    const c = addClipFromMedia(id);
    trimClip(c.id, "end", -(dur(c) - 0.9));
    const [wavId] = await importFiles([makeToneWav({ seconds: 1, name: "mix.wav" })]);
    addClipFromMedia(wavId, { start: 0 });
    addTitle({ text: "Export", start: 0.1, duration: 0.7 });
    Rosalena.assert(near(totalDuration(), 1, 0.01), `the sequence is ${totalDuration()} s`);
    const out = await exportVideo({ askOffline: false });
    Rosalena.assert(out && out.blob, "export returned nothing");
    Rosalena.assert(out.blob.size > 2000, `the WebM is only ${out.blob.size} bytes`);
    const head = new Uint8Array(await out.blob.slice(0, 4).arrayBuffer());
    Rosalena.assert(head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3, "the export is not a WebM (no EBML header)");
    Rosalena.assert(out.result && (out.result.verifying === true || out.result.saved), `files.save answered ${JSON.stringify(out.result)}`);
    Rosalena.assert(!engine.exporting && !$("app").classList.contains("is-exporting"), "the editor is still locked after the export");
    closeModal(true);
    seek(0.4);
    const frame = await exportFrame();
    Rosalena.assert(frame && frame.blob && frame.blob.type === "image/png" && frame.blob.size > 500, "the PNG frame is empty");
    const png = new Uint8Array(await frame.blob.slice(0, 4).arrayBuffer());
    Rosalena.assert(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, "the frame is not a PNG");
    // Cancel stops a running export and unlocks the editor.
    const pending = exportVideo({ askOffline: false });
    await sleep(300);
    cancelExport();
    Rosalena.assert((await pending) === null, "a cancelled export still returned a file");
    Rosalena.assert(!engine.exporting, "cancel did not stop the export");
  });
});

Rosalena.test("follows the app theme", async () => {
  await booted;
  applyTheme({ mode: "light", colors: { bg: "#f4f2ec", panel: "#fbfaf6", text: "#0b262b", accent: "#0a6f79" } });
  const css = getComputedStyle(document.documentElement);
  Rosalena.assert(css.getPropertyValue("--bg").trim() === "#f4f2ec" && document.documentElement.dataset.mode === "light", "light theme not applied");
  Rosalena.assert(css.getPropertyValue("--btn-ink").trim() === "#ffffff", "button ink should be white on a dark accent");
  applyTheme(Rosalena.host?.theme ?? null);
  Rosalena.assert(document.documentElement.dataset.mode === (Rosalena.host?.theme?.mode === "light" ? "light" : "dark"), "the host theme was not put back");
});

// ------------------------------------------------------------------ start

applyTheme(null);
wire();
Rosalena.on("theme", applyTheme);
renderAll();
fitStage();
invalidate();
setSaveState("", "");
Rosalena.ready();
booted = loadProject()
  .then((loaded) => {
    if (loaded && state.media.some((m) => m.missing)) toast("Project restored. Relink the offline media to keep editing it");
  })
  .catch((err) => toast(`Could not open the saved project: ${messageOf(err)}`, true));
