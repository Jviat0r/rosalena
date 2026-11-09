// Poster Studio: a poster designer with a live fluid background.
//
// One renderer (renderPoster) draws the poster in poster units (1080 wide) onto any canvas
// at any scale: the preview calls it every frame at screen size, the exporter calls it once
// at the format's real pixel size with the background frozen at the current frame.

const Rosalena = window.Rosalena;
const TAU = Math.PI * 2;
const KEY = "design";

// ------------------------------------------------------------------ data

const FORMATS = [
  { id: "4x5", label: "4:5", name: "Portrait", w: 1080, h: 1350 },
  { id: "1x1", label: "1:1", name: "Square", w: 1080, h: 1080 },
  { id: "3x4", label: "3:4", name: "Classic", w: 1080, h: 1440 },
  { id: "9x16", label: "9:16", name: "Story", w: 1080, h: 1920 },
];

// stops run dark to light through the flow; ink is the text, accent the eyebrow and line 2,
// shade the colour laid under the text so it stays readable.
const PALETTES = [
  { id: "midnight", name: "Midnight", stops: ["#05060f", "#10173a", "#2a2877", "#6248e6", "#cf74f2"], ink: "#f6f3ff", accent: "#b9a9ff", shade: "#05060f" },
  { id: "cobalt", name: "Cobalt", stops: ["#010923", "#06279b", "#1d5bff", "#6aa8ff", "#e1eeff"], ink: "#ffffff", accent: "#bfe0ff", shade: "#010a26" },
  { id: "ember", name: "Ember", stops: ["#130402", "#561004", "#c3320b", "#ff7a2e", "#ffd28c"], ink: "#fff5ea", accent: "#ffc56f", shade: "#140402" },
  { id: "paper", name: "Paper", stops: ["#f4eee2", "#e8dcc6", "#d6c09c", "#e3a27a", "#f8f4ec"], ink: "#1c1a16", accent: "#c2410c", shade: "#f4eee2", light: true },
  { id: "forest", name: "Forest", stops: ["#03110b", "#0a2f20", "#1c6344", "#62a97e", "#d6ecca"], ink: "#eff8ea", accent: "#b6e5a2", shade: "#03110b" },
  { id: "dusk", name: "Dusk", stops: ["#150a27", "#421a57", "#a53a6e", "#ea8466", "#ffd39f"], ink: "#fff4ea", accent: "#ffc79c", shade: "#150a27" },
  { id: "glacier", name: "Glacier", stops: ["#edf3f6", "#cfe1e9", "#93bbcd", "#4f84a1", "#f5f9fb"], ink: "#0e1c25", accent: "#1d6c96", shade: "#edf3f6", light: true },
  { id: "acid", name: "Acid", stops: ["#060706", "#121611", "#243312", "#7cbc1d", "#dcff5e"], ink: "#f4ffe2", accent: "#d6ff5a", shade: "#060706" },
];

const DEFAULT_COPY = {
  eyebrow: "ROSALENA HARNESS",
  title1: "Everything",
  title2: "is a plugin",
  subtitle: "A desktop coding agent you can reshape.",
  description: "Tools, pages, games and themes live in the sidebar. Each one is verified before it installs, runs sandboxed with no network, and rolls back in one click.",
  footerLeft: "rosalena.pages.dev",
  footerRight: "No. 01 / 2026",
};

const defaults = () => ({
  copy: { ...DEFAULT_COPY },
  format: "4x5",
  align: "left",
  palette: "midnight",
  shapes: true,
  grain: true,
  speed: 40,
  seed: 2741,
});

const SANS = '"Segoe UI Variable Display", "Segoe UI", "SF Pro Display", -apple-system, "Helvetica Neue", Arial, sans-serif';
const MONO = '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace';
const TITLE_WEIGHT = 800;
const TITLE_LS = -0.03; // em

const formatOf = (id) => FORMATS.find((f) => f.id === id) || FORMATS[0];
const paletteOf = (id) => PALETTES.find((p) => p.id === id) || PALETTES[0];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let state = defaults();

function normalize(raw) {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  const copy = raw.copy && typeof raw.copy === "object" ? raw.copy : {};
  const limits = { description: 600, title1: 160, title2: 160, subtitle: 200 };
  for (const key of Object.keys(d.copy)) {
    if (typeof copy[key] === "string") d.copy[key] = copy[key].slice(0, limits[key] || 80);
  }
  if (FORMATS.some((f) => f.id === raw.format)) d.format = raw.format;
  if (raw.align === "left" || raw.align === "center") d.align = raw.align;
  if (PALETTES.some((p) => p.id === raw.palette)) d.palette = raw.palette;
  if (typeof raw.shapes === "boolean") d.shapes = raw.shapes;
  if (typeof raw.grain === "boolean") d.grain = raw.grain;
  if (Number.isFinite(raw.speed)) d.speed = Math.round(clamp(raw.speed, 0, 100));
  if (Number.isFinite(raw.seed)) d.seed = Math.round(clamp(raw.seed, 1, 99999));
  return d;
}

const serialize = () => ({ v: 1, ...JSON.parse(JSON.stringify(state)) });

// ------------------------------------------------------------------ random and noise

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Ken Perlin's improved 3D noise with a seeded permutation; z is time.
function makePerlin(seed) {
  const rnd = mulberry32(seed * 2654435761);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y, z) => {
    h &= 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  };
  return function noise(x, y, z) {
    let X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    X &= 255; Y &= 255; Z &= 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    const x1 = x - 1, y1 = y - 1, z1 = z - 1;
    const l1 = grad(perm[AA], x, y, z) + u * (grad(perm[BA], x1, y, z) - grad(perm[AA], x, y, z));
    const l2 = grad(perm[AB], x, y1, z) + u * (grad(perm[BB], x1, y1, z) - grad(perm[AB], x, y1, z));
    const l3 = grad(perm[AA + 1], x, y, z1) + u * (grad(perm[BA + 1], x1, y, z1) - grad(perm[AA + 1], x, y, z1));
    const l4 = grad(perm[AB + 1], x, y1, z1) + u * (grad(perm[BB + 1], x1, y1, z1) - grad(perm[AB + 1], x, y1, z1));
    const m1 = l1 + v * (l2 - l1);
    const m2 = l3 + v * (l4 - l3);
    return m1 + w * (m2 - m1);
  };
}

// ------------------------------------------------------------------ colour

function hexRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

const lutCache = new Map();
function paletteLut(pal) {
  if (lutCache.has(pal.id)) return lutCache.get(pal.id);
  const pos = [0, 0.3, 0.55, 0.8, 1];
  const cols = pal.stops.map(hexRgb);
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < pos.length - 2 && t > pos[s + 1]) s++;
    let f = (t - pos[s]) / (pos[s + 1] - pos[s]);
    f = f * f * (3 - 2 * f);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = cols[s][c] + (cols[s + 1][c] - cols[s][c]) * f;
  }
  lutCache.set(pal.id, lut);
  return lut;
}

// ------------------------------------------------------------------ the fluid field

// Domain-warped fractal noise: the warp is what makes it read as fluid flowing rather
// than clouds. The field is sampled in units of the poster width, so a low-resolution
// preview and a full-resolution export show the same picture.
class Fluid {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.img = null;
    this.seed = -1;
    this.noise = null;
  }

  render(bw, bh, seed, t, lut) {
    if (this.canvas.width !== bw || this.canvas.height !== bh || !this.img) {
      this.canvas.width = bw;
      this.canvas.height = bh;
      this.img = this.ctx.createImageData(bw, bh);
    }
    if (this.seed !== seed) {
      this.noise = makePerlin(seed);
      this.seed = seed;
    }
    const n = this.noise;
    const d = this.img.data;
    const S = 1.7 / bw;
    const drift = t * 0.11;
    const t1 = t, t2 = t * 1.3 + 7.1, t3 = t * 0.7 + 3.3;
    let o = 0;
    for (let j = 0; j < bh; j++) {
      const y = (j + 0.5) * S - drift * 0.4;
      for (let i = 0; i < bw; i++) {
        const x = (i + 0.5) * S + drift;
        const qx = n(x, y, t1) * 0.6 + n(x * 2.03 + 17.3, y * 2.03 + 5.1, t1) * 0.3;
        const qy = n(x + 5.2, y + 1.3, t1) * 0.6 + n(x * 2.03 + 3.7, y * 2.03 + 29.4, t1) * 0.3;
        const rx = n(x + 2.6 * qx + 1.7, y + 2.6 * qy + 9.2, t2) * 0.6 + n((x + 2.6 * qx) * 2.01 + 8.8, (y + 2.6 * qy) * 2.01 + 1.4, t2) * 0.3;
        const ry = n(x + 2.6 * qx + 8.3, y + 2.6 * qy + 2.8, t2) * 0.6 + n((x + 2.6 * qx) * 2.01 + 4.1, (y + 2.6 * qy) * 2.01 + 13.6, t2) * 0.3;
        const fx = x + 2.2 * rx, fy = y + 2.2 * ry;
        const v = n(fx, fy, t3) * 0.6 + n(fx * 2.02 + 11.1, fy * 2.02 + 7.7, t3) * 0.28 + n(fx * 4.03 + 2.9, fy * 4.03 + 19.3, t3) * 0.12;
        let c = 0.5 + v * 1.55 + rx * 0.65;
        c = c < 0 ? 0 : c > 1 ? 1 : c;
        const li = ((c * 255) | 0) * 3;
        d[o] = lut[li];
        d[o + 1] = lut[li + 1];
        d[o + 2] = lut[li + 2];
        d[o + 3] = 255;
        o += 4;
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}

const previewFluid = new Fluid();
const exportFluid = new Fluid();

// ------------------------------------------------------------------ text measuring and layout

const mctx = document.createElement("canvas").getContext("2d");
const HAS_LS = "letterSpacing" in mctx;
let LS_IN_MEASURE = false;
if (HAS_LS) {
  mctx.font = "20px sans-serif";
  mctx.letterSpacing = "0px";
  const a = mctx.measureText("abcd").width;
  mctx.letterSpacing = "10px";
  const b = mctx.measureText("abcd").width;
  LS_IN_MEASURE = b - a > 20;
  mctx.letterSpacing = "0px";
}
let lastFont = "";
let lastLs = "";

const fontString = (weight, size, family) => `${weight} ${size}px ${family}`;

function measure(text, weight, family, size, lsEm = 0) {
  const font = fontString(weight, size, family);
  if (font !== lastFont) {
    mctx.font = font;
    lastFont = font;
  }
  const ls = lsEm * size;
  if (HAS_LS) {
    const lsText = `${ls}px`;
    if (lsText !== lastLs) {
      mctx.letterSpacing = lsText;
      lastLs = lsText;
    }
  }
  let w = mctx.measureText(text).width;
  if (HAS_LS && !LS_IN_MEASURE) w += ls * [...text].length;
  return w;
}

function ellipsize(text, weight, family, size, ls, maxW) {
  if (measure(text, weight, family, size, ls) <= maxW) return text;
  const chars = [...text];
  while (chars.length > 1 && measure(chars.join("").trimEnd() + "…", weight, family, size, ls) > maxW) chars.pop();
  return chars.join("").trimEnd() + "…";
}

function breakWord(word, weight, family, size, ls, maxW) {
  if (measure(word, weight, family, size, ls) <= maxW) return [word];
  const out = [];
  let cur = "";
  for (const ch of word) {
    if (cur && measure(cur + ch, weight, family, size, ls) > maxW) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function wrap(text, weight, family, size, ls, maxW) {
  const lines = [];
  for (const para of String(text).split(/\n/)) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    let line = "";
    for (const w0 of words) {
      for (const w of breakWord(w0, weight, family, size, ls, maxW)) {
        const cand = line ? `${line} ${w}` : w;
        if (!line || measure(cand, weight, family, size, ls) <= maxW) line = cand;
        else {
          lines.push(line);
          line = w;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// Everything about where text goes, in poster units. The title shrinks first, then the
// subtitle and description, until the whole stack fits between the eyebrow and the footer;
// a description that still does not fit is cut with an ellipsis.
function computeLayout(s) {
  const f = formatOf(s.format);
  const W = f.w, H = f.h, u = W / 1080, m = 80 * u;
  const maxW = W - 2 * m;
  const descW = Math.min(maxW, 820 * u);
  const center = s.align === "center";
  const c = s.copy;
  const items = [];
  const xFor = (w) => (center ? (W - w) / 2 : m);

  // eyebrow
  let eyebrowBottom = m;
  const eTxt = c.eyebrow.trim();
  if (eTxt) {
    let size = 24 * u;
    const dot = 10 * u, gap = 18 * u, room = maxW - dot - gap;
    let w = measure(eTxt, 600, MONO, size, 0.26);
    if (w > room) {
      size = Math.max(11 * u, (size * room) / w);
      w = measure(eTxt, 600, MONO, size, 0.26);
    }
    const text = ellipsize(eTxt, 600, MONO, size, 0.26, room);
    w = measure(text, 600, MONO, size, 0.26);
    const x0 = center ? (W - (dot + gap + w)) / 2 : m;
    const y = m + size / 2;
    items.push({ kind: "dot", x: x0 + dot / 2, y, r: dot / 2, color: "accent" });
    items.push({ kind: "text", role: "eyebrow", text, x: x0 + dot + gap, y, w, size, weight: 600, family: MONO, ls: 0.26, color: "accent", alpha: 1 });
    eyebrowBottom = m + size;
  }

  // footer
  const fl = c.footerLeft.trim(), fr = c.footerRight.trim();
  let rule = null;
  let bottomLimit = H - m;
  if (fl || fr) {
    let size = 20 * u;
    const gap = fl && fr ? 40 * u : 0;
    const wl = fl ? measure(fl, 500, MONO, size, 0.12) : 0;
    const wr = fr ? measure(fr, 500, MONO, size, 0.12) : 0;
    if (wl + wr + gap > maxW) size = Math.max(10 * u, (size * (maxW - gap)) / (wl + wr));
    const half = fl && fr ? (maxW - gap) / 2 : maxW;
    let tl = fl ? measure(fl, 500, MONO, size, 0.12) : 0;
    let tr = fr ? measure(fr, 500, MONO, size, 0.12) : 0;
    let left = fl, right = fr;
    if (tl + tr + gap > maxW) {
      left = fl ? ellipsize(fl, 500, MONO, size, 0.12, half) : "";
      right = fr ? ellipsize(fr, 500, MONO, size, 0.12, half) : "";
      tl = left ? measure(left, 500, MONO, size, 0.12) : 0;
      tr = right ? measure(right, 500, MONO, size, 0.12) : 0;
    }
    const y = H - m - size / 2;
    if (left) items.push({ kind: "text", role: "footer", text: left, x: m, y, w: tl, size, weight: 500, family: MONO, ls: 0.12, color: "ink", alpha: 0.72 });
    if (right) items.push({ kind: "text", role: "footer", text: right, x: W - m - tr, y, w: tr, size, weight: 500, family: MONO, ls: 0.12, color: "ink", alpha: 0.72 });
    const ruleY = H - m - size - 28 * u;
    rule = { x1: m, x2: W - m, y: ruleY, w: 1.5 * u };
    bottomLimit = ruleY - 56 * u;
  }

  const stackMax = bottomLimit - (eyebrowBottom + 56 * u + 0.08 * H);
  const t1 = c.title1.trim(), t2 = c.title2.trim(), sub = c.subtitle.trim(), desc = c.description.trim();
  const words = `${t1} ${t2}`.split(/\s+/).filter(Boolean);
  const widest100 = Math.max(1, ...words.map((w) => measure(w, TITLE_WEIGHT, SANS, 100, TITLE_LS)));

  let k = 1;
  let fit = null;
  for (let i = 0; i < 70; i++) {
    const tSize = Math.max(18 * u, Math.min(156 * u * k, ((100 * maxW) / widest100) * 0.985));
    const tl1 = t1 ? wrap(t1, TITLE_WEIGHT, SANS, tSize, TITLE_LS, maxW) : [];
    const tl2 = t2 ? wrap(t2, TITLE_WEIGHT, SANS, tSize, TITLE_LS, maxW) : [];
    const ks = clamp(Math.sqrt(k), 0.38, 1);
    const sSize = 40 * u * ks;
    const dSize = 29 * u * ks;
    const sl = sub ? wrap(sub, 500, SANS, sSize, -0.005, maxW) : [];
    const dl = desc ? wrap(desc, 400, SANS, dSize, 0, descW) : [];
    const tLH = tSize * 1.0, sLH = sSize * 1.28, dLH = dSize * 1.5;
    const tH = (tl1.length + tl2.length) * tLH;
    const sH = sl.length * sLH;
    const g1 = tH && (sl.length || dl.length) ? 40 * u * ks : 0;
    const g2 = sl.length && dl.length ? 22 * u * ks : 0;
    fit = { tSize, sSize, dSize, tl1, tl2, sl, dl, tLH, sLH, dLH, g1, g2, tH, sH };
    if (tH + g1 + sH + g2 + dl.length * dLH <= stackMax) break;
    k *= 0.94;
  }
  // last resort: cut the description down to what fits
  const fixed = fit.tH + fit.g1 + fit.sH + fit.g2;
  if (fit.dl.length && fixed + fit.dl.length * fit.dLH > stackMax) {
    const keep = Math.max(0, Math.floor((stackMax - fixed) / fit.dLH));
    if (keep < fit.dl.length) {
      fit.dl = fit.dl.slice(0, keep);
      if (keep) fit.dl[keep - 1] = ellipsize(`${fit.dl[keep - 1]}…`, 400, SANS, fit.dSize, 0, descW);
      if (!keep) fit.g2 = 0;
    }
  }
  const total = fit.tH + fit.g1 + fit.sH + fit.g2 + fit.dl.length * fit.dLH;
  let y = bottomLimit - total;
  const stackTop = y;
  const push = (text, role, size, lh, weight, ls, color, alpha) => {
    const w = measure(text, weight, SANS, size, ls);
    items.push({ kind: "text", role, text, x: xFor(w), y: y + lh / 2, w, size, weight, family: SANS, ls, color, alpha });
    y += lh;
  };
  for (const line of fit.tl1) push(line, "title", fit.tSize, fit.tLH, TITLE_WEIGHT, TITLE_LS, "ink", 1);
  for (const line of fit.tl2) push(line, "title", fit.tSize, fit.tLH, TITLE_WEIGHT, TITLE_LS, "accent", 1);
  y += fit.g1;
  for (const line of fit.sl) push(line, "subtitle", fit.sSize, fit.sLH, 500, -0.005, "ink", 0.96);
  y += fit.g2;
  for (const line of fit.dl) push(line, "description", fit.dSize, fit.dLH, 400, 0, "ink", 0.74);

  return {
    W, H, u, m, maxW, descW, items, rule,
    titleSize: fit.tSize,
    eyebrowBottom,
    stackTop,
    stackBottom: y,
    bottomLimit,
    artTop: eyebrowBottom + 48 * u,
    artBottom: stackTop - 52 * u,
  };
}

let layoutCache = { key: "", L: null };
function getLayout(s) {
  const key = JSON.stringify([s.copy, s.format, s.align]);
  if (layoutCache.key !== key) layoutCache = { key, L: computeLayout(s) };
  return layoutCache.L;
}

// ------------------------------------------------------------------ drawing

let grainTile = null;
const grainPatterns = new WeakMap();
function grainPattern(ctx) {
  if (!grainTile) {
    grainTile = document.createElement("canvas");
    grainTile.width = grainTile.height = 192;
    const g = grainTile.getContext("2d");
    const img = g.createImageData(192, 192);
    const rnd = mulberry32(7);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (128 + (rnd() + rnd() - 1) * 150) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  if (!grainPatterns.has(ctx)) grainPatterns.set(ctx, ctx.createPattern(grainTile, "repeat"));
  return grainPatterns.get(ctx);
}

function drawBackground(ctx, dw, dh, s, t, pal, samples, fluid) {
  const f = formatOf(s.format);
  const bw = Math.max(8, Math.round(Math.sqrt((samples * f.w) / f.h)));
  const bh = Math.max(8, Math.round((bw * f.h) / f.w));
  const src = fluid.render(bw, bh, s.seed, t, paletteLut(pal));
  ctx.fillStyle = pal.stops[1];
  ctx.fillRect(0, 0, dw, dh);
  const blur = (dw / bw) * 0.8;
  const pad = Math.ceil(blur * 3) + 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = blur > 0.6 ? `blur(${blur.toFixed(2)}px)` : "none";
  ctx.drawImage(src, -pad, -pad, dw + 2 * pad, dh + 2 * pad);
  ctx.filter = "none";
}

function drawShapes(ctx, L, s, pal) {
  const { W, u, m, maxW } = L;
  const rnd = mulberry32(s.seed * 7919 + 13);
  const ink = pal.ink, accent = pal.accent;
  const gridBottom = L.rule ? L.rule.y : L.H - m;
  ctx.save();
  ctx.lineCap = "round";

  // the module: four big cells across when there is room, else six or eight smaller ones,
  // and never more than three rows so the motif stays an accent, not wallpaper
  const space = L.artBottom - L.artTop;
  let cols = 4;
  for (const c of [4, 6, 8]) {
    cols = c;
    if (space >= maxW / c) break;
  }
  const cell = maxW / cols;
  const rows = Math.min(3, Math.floor(space / cell));

  // the modular grid lines, on the same columns as the cells
  ctx.strokeStyle = rgba(ink, pal.light ? 0.09 : 0.07);
  ctx.lineWidth = 1.2 * u;
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    const x = m + (i * maxW) / cols;
    ctx.moveTo(x, m * 0.5);
    ctx.lineTo(x, gridBottom);
  }
  ctx.stroke();

  if (rows >= 1) {
    const gy = L.artBottom - rows * cell;
    ctx.beginPath();
    for (let r = 0; r <= rows; r++) {
      ctx.moveTo(m, gy + r * cell);
      ctx.lineTo(W - m, gy + r * cell);
    }
    ctx.stroke();

    const kinds = [
      ["empty", 0.26], ["quarter", 0.17], ["ring", 0.12], ["arcs", 0.12],
      ["stripes", 0.1], ["dot", 0.09], ["block", 0.08], ["half", 0.06],
    ];
    const pick = () => {
      let r = rnd();
      for (const [k, w] of kinds) {
        if ((r -= w) <= 0) return k;
      }
      return "empty";
    };
    let accents = 0;
    const accentMax = Math.max(2, Math.round((rows * cols) / 5));
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const x = m + col * cell, y = gy + r * cell;
        let kind = pick();
        if ((kind === "quarter" || kind === "half") && accents >= accentMax) kind = "ring";
        const corner = Math.floor(rnd() * 4);
        const cx = corner === 1 || corner === 2 ? x + cell : x;
        const cy = corner >= 2 ? y + cell : y;
        const start = [0, 0.5, 1, 1.5][corner] * Math.PI;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cell, cell);
        ctx.clip();
        if (kind === "quarter") {
          accents++;
          ctx.fillStyle = rgba(accent, 0.9);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, cell, start, start + Math.PI / 2);
          ctx.closePath();
          ctx.fill();
        } else if (kind === "half") {
          accents++;
          ctx.fillStyle = rgba(ink, 0.88);
          ctx.beginPath();
          const side = corner;
          const hx = side === 0 ? x + cell / 2 : side === 1 ? x + cell : side === 2 ? x + cell / 2 : x;
          const hy = side === 0 ? y : side === 1 ? y + cell / 2 : side === 2 ? y + cell : y + cell / 2;
          ctx.arc(hx, hy, cell / 2, 0, TAU);
          ctx.fill();
        } else if (kind === "ring") {
          ctx.strokeStyle = rgba(ink, 0.55);
          ctx.lineWidth = 2 * u;
          ctx.beginPath();
          ctx.arc(x + cell / 2, y + cell / 2, cell * 0.38, 0, TAU);
          ctx.stroke();
        } else if (kind === "arcs") {
          ctx.strokeStyle = rgba(ink, 0.45);
          ctx.lineWidth = 2 * u;
          for (const rr of [0.34, 0.67, 1]) {
            ctx.beginPath();
            ctx.arc(cx, cy, cell * rr, start, start + Math.PI / 2);
            ctx.stroke();
          }
        } else if (kind === "stripes") {
          ctx.strokeStyle = rgba(ink, 0.24);
          ctx.lineWidth = 2 * u;
          ctx.beginPath();
          const step = cell / 9;
          for (let o = -cell; o < cell * 2; o += step) {
            ctx.moveTo(x + o, y);
            ctx.lineTo(x + o - cell, y + cell);
          }
          ctx.stroke();
        } else if (kind === "dot") {
          ctx.fillStyle = rgba(ink, 0.8);
          ctx.beginPath();
          ctx.arc(x + cell / 2, y + cell / 2, cell * 0.075, 0, TAU);
          ctx.fill();
        } else if (kind === "block") {
          // halftone: a 6x6 dot grid
          ctx.fillStyle = rgba(ink, 0.42);
          const step = cell / 6;
          ctx.beginPath();
          for (let a = 0; a < 6; a++) {
            for (let b = 0; b < 6; b++) {
              const px = x + step * (a + 0.5), py = y + step * (b + 0.5);
              ctx.moveTo(px + step * 0.12, py);
              ctx.arc(px, py, step * 0.12, 0, TAU);
            }
          }
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // one large ring tying the grid together
    if (rows >= 2) {
      const ix = 1 + Math.floor(rnd() * (cols - 1));
      const iy = 1 + Math.floor(rnd() * (rows - 1));
      ctx.strokeStyle = rgba(ink, 0.3);
      ctx.lineWidth = 1.5 * u;
      ctx.beginPath();
      ctx.arc(m + ix * cell, gy + iy * cell, cell * 0.96, 0, TAU);
      ctx.stroke();
    }

    // registration marks on the grid's intersections
    ctx.strokeStyle = rgba(ink, 0.5);
    ctx.lineWidth = 1.5 * u;
    const arm = 7 * u;
    ctx.beginPath();
    for (let r = 0; r <= rows; r++) {
      for (let col = 0; col <= cols; col++) {
        const px = m + col * cell, py = gy + r * cell;
        ctx.moveTo(px - arm, py);
        ctx.lineTo(px + arm, py);
        ctx.moveTo(px, py - arm);
        ctx.lineTo(px, py + arm);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawShade(ctx, L, pal) {
  const { W, H } = L;
  const top = Math.max(0, L.stackTop - 0.24 * H);
  const g = ctx.createLinearGradient(0, top, 0, H);
  g.addColorStop(0, rgba(pal.shade, 0));
  g.addColorStop(0.45, rgba(pal.shade, pal.light ? 0.35 : 0.42));
  g.addColorStop(1, rgba(pal.shade, pal.light ? 0.62 : 0.78));
  ctx.fillStyle = g;
  ctx.fillRect(0, top, W, H - top);
  const tg = ctx.createLinearGradient(0, 0, 0, L.eyebrowBottom + 0.1 * H);
  tg.addColorStop(0, rgba(pal.shade, pal.light ? 0.3 : 0.4));
  tg.addColorStop(1, rgba(pal.shade, 0));
  ctx.fillStyle = tg;
  ctx.fillRect(0, 0, W, L.eyebrowBottom + 0.1 * H);
}

function drawText(ctx, L, pal, k) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  if (L.rule) {
    ctx.strokeStyle = rgba(pal.ink, 0.28);
    ctx.lineWidth = Math.max(1, L.rule.w * k);
    ctx.beginPath();
    ctx.moveTo(L.rule.x1 * k, L.rule.y * k);
    ctx.lineTo(L.rule.x2 * k, L.rule.y * k);
    ctx.stroke();
  }
  for (const it of L.items) {
    const col = it.color === "accent" ? pal.accent : pal.ink;
    ctx.globalAlpha = it.alpha ?? 1;
    ctx.fillStyle = col;
    if (it.kind === "dot") {
      ctx.beginPath();
      ctx.arc(it.x * k, it.y * k, it.r * k, 0, TAU);
      ctx.fill();
      continue;
    }
    ctx.font = fontString(it.weight, it.size * k, it.family);
    if (HAS_LS) ctx.letterSpacing = `${it.ls * it.size * k}px`;
    if (it.role === "title" && !pal.light) {
      ctx.shadowColor = rgba(pal.shade, 0.45);
      ctx.shadowBlur = 40 * L.u * k;
    } else {
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
    }
    ctx.fillText(it.text, it.x * k, it.y * k);
  }
  ctx.restore();
}

/**
 * Draw the poster for design `s` at background time `t` onto `canvas`, which is the
 * poster's size times `k`. `o` turns layers off (the self-tests use that to look at one
 * layer at a time) and sets how many background samples to compute.
 */
function renderPoster(canvas, k, s, t, o = {}) {
  const ctx = canvas.getContext("2d");
  const pal = paletteOf(s.palette);
  const L = getLayout(s);
  const dw = canvas.width, dh = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, dw, dh);
  if (o.background !== false) drawBackground(ctx, dw, dh, s, t, pal, o.samples || 9000, o.fluid || previewFluid);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  if (o.shapes !== false && s.shapes) drawShapes(ctx, L, s, pal);
  if (o.shade !== false) drawShade(ctx, L, pal);
  if (o.text !== false) drawText(ctx, L, pal, k);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (o.grain !== false && s.grain && o.background !== false) {
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = pal.light ? 0.16 : 0.12;
    ctx.fillStyle = grainPattern(ctx);
    ctx.fillRect(0, 0, dw, dh);
    ctx.restore();
  }
  return L;
}

// ------------------------------------------------------------------ preview

const $ = (sel) => document.querySelector(sel);
const stage = $("#stage");
const frame = $("#frame");
const preview = $("#preview");
const clock = { t: 14.2 };
let previewK = 0.4;
let dirty = true;

function fitPreview() {
  const f = formatOf(state.format);
  const rect = stage.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return;
  const pad = Math.max(36, Math.min(64, rect.width * 0.06));
  const scale = Math.min((rect.width - 2 * pad) / f.w, (rect.height - 2 * pad) / f.h);
  const cssW = Math.max(60, Math.floor(f.w * scale));
  const cssH = Math.max(60, Math.floor(f.h * scale));
  frame.style.width = `${cssW}px`;
  frame.style.height = `${cssH}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(cssW * dpr);
  previewK = pw / f.w;
  const ph = Math.round(f.h * previewK);
  if (preview.width !== pw || preview.height !== ph) {
    preview.width = pw;
    preview.height = ph;
  }
  dirty = true;
  drawPreview();
}

function drawPreview(tOverride) {
  renderPoster(preview, previewK, state, tOverride ?? clock.t, { samples: 9000, fluid: previewFluid });
  dirty = false;
}

let raf = 0;
let lastNow = 0;
function tick(now) {
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
  lastNow = now;
  if (state.speed > 0) {
    clock.t += dt * (state.speed / 100) * 0.55;
    dirty = true;
  }
  if (dirty) drawPreview();
  raf = requestAnimationFrame(tick);
}
function startLoop() {
  if (raf) return;
  lastNow = 0;
  raf = requestAnimationFrame(tick);
}
function stopLoop() {
  cancelAnimationFrame(raf);
  raf = 0;
}
document.addEventListener("visibilitychange", () => (document.hidden ? stopLoop() : startLoop()));

// ------------------------------------------------------------------ export

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "poster";

/** Render at the format's real pixel size, with the background frozen at this frame. */
async function exportImage(kind = "png") {
  const f = formatOf(state.format);
  const canvas = document.createElement("canvas");
  canvas.width = f.w;
  canvas.height = f.h;
  renderPoster(canvas, 1, state, clock.t, { samples: Math.round((f.w * f.h) / 14), fluid: exportFluid });
  const type = kind === "jpeg" || kind === "jpg" ? "image/jpeg" : "image/png";
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the browser could not encode the image"))), type, 0.93);
  });
  const ext = type === "image/png" ? "png" : "jpg";
  const name = `${slug(`${state.copy.title1} ${state.copy.title2}`)}-${f.label.replace(":", "x")}-${f.w}x${f.h}.${ext}`;
  const result = await Rosalena.files.save(name, blob, type);
  canvas.width = canvas.height = 0;
  return { blob, name, type, width: f.w, height: f.h, result };
}

let exporting = false;
async function onExport(kind) {
  if (exporting) return;
  exporting = true;
  const btn = kind === "png" ? $("#export-png") : $("#export-jpg");
  const before = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="spin"></i>${kind === "png" ? "Exporting" : "JPG"}`;
  try {
    const out = await exportImage(kind);
    const mb = (out.blob.size / 1048576).toFixed(1);
    const saved = out.result && out.result.saved ? out.result.saved : out.name;
    toast(`${out.result && out.result.verifying ? "Rendered" : "Saved"} ${saved} · ${out.width} × ${out.height} · ${mb} MB`);
  } catch (err) {
    toast(`Export failed: ${err && err.message ? err.message : err}`, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = before;
    exporting = false;
  }
}

let toastTimer = 0;
function toast(text, isError = false) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.toggle("err", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 3200);
}

// ------------------------------------------------------------------ storage

let loaded = false;
let saveTimer = 0;
function setSaveState(kind, text) {
  const el = $("#save-state");
  el.className = `save-state ${kind}`;
  el.querySelector("span").textContent = text;
}
function scheduleSave() {
  if (!loaded) return;
  setSaveState("saving", "Saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow().catch(() => {}), 450);
}
async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try {
    await Rosalena.storage.set(KEY, serialize());
    setSaveState("saved", "Saved");
  } catch (err) {
    setSaveState("error", `Not saved: ${err && err.message ? err.message : err}`);
    throw err;
  }
}
async function loadDesign() {
  const saved = await Rosalena.storage.get(KEY);
  if (saved) applyDesign(saved);
  return Boolean(saved);
}
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]);

// ------------------------------------------------------------------ controls

const inputs = [...document.querySelectorAll("[data-key]")];

function buildControls() {
  const formats = $("#formats");
  for (const f of FORMATS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt fmt";
    b.dataset.format = f.id;
    b.title = `${f.name}, ${f.w} × ${f.h}`;
    const gh = 26, gw = (gh * f.w) / f.h;
    b.innerHTML = `<span class="glyph"><i style="width:${gw.toFixed(1)}px;height:${gh}px"></i></span><b>${f.label}</b><small>${f.w}×${f.h}</small>`;
    b.addEventListener("click", () => setFormat(f.id));
    formats.append(b);
  }

  const palettes = $("#palettes");
  for (const p of PALETTES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt pal";
    b.dataset.palette = p.id;
    b.title = `${p.name} palette`;
    const [s0, s1, s2, s3, s4] = p.stops;
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = `radial-gradient(90% 80% at 85% 15%, ${s4} 0%, transparent 55%), radial-gradient(110% 90% at 10% 100%, ${s3} 0%, transparent 60%), linear-gradient(160deg, ${s0} 0%, ${s1} 45%, ${s2} 100%)`;
    sw.style.color = p.ink;
    sw.innerHTML = `<span>Aa</span><i style="background:${p.accent}"></i>`;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = p.name;
    b.append(sw, n);
    b.addEventListener("click", () => setPalette(p.id));
    palettes.append(b);
  }

  for (const input of inputs) {
    input.addEventListener("input", () => {
      state.copy[input.dataset.key] = input.value;
      if (input.dataset.key === "description") updateCount();
      dirty = true;
      scheduleSave();
    });
  }
  const accentNote = document.querySelector('[data-key="title2"]').previousElementSibling.querySelector("em");
  if (accentNote) accentNote.classList.add("accent-note");

  for (const b of document.querySelectorAll("#align button")) b.addEventListener("click", () => setAlign(b.dataset.align));
  $("#shapes").addEventListener("click", () => setToggle("shapes", !state.shapes));
  $("#grain").addEventListener("click", () => setToggle("grain", !state.grain));
  $("#speed").addEventListener("input", (e) => {
    state.speed = Number(e.target.value);
    syncSpeed();
    scheduleSave();
  });
  $("#shuffle").addEventListener("click", shuffle);
  $("#export-png").addEventListener("click", () => onExport("png"));
  $("#export-jpg").addEventListener("click", () => onExport("jpeg"));

  let armed = 0;
  const reset = $("#reset");
  reset.addEventListener("click", () => {
    if (!armed) {
      reset.textContent = "Reset everything?";
      reset.classList.add("danger");
      armed = setTimeout(() => {
        armed = 0;
        reset.textContent = "Reset";
        reset.classList.remove("danger");
      }, 3200);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    reset.textContent = "Reset";
    reset.classList.remove("danger");
    applyDesign(defaults());
    scheduleSave();
    toast("Design reset to the defaults");
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      onExport(e.shiftKey ? "jpeg" : "png");
    } else if (e.altKey && !mod && e.code === "KeyS") {
      e.preventDefault();
      shuffle();
    }
  });

  new ResizeObserver(() => fitPreview()).observe(stage);
}

function setFormat(id) {
  state.format = formatOf(id).id;
  syncControls();
  fitPreview();
  scheduleSave();
}
function setPalette(id) {
  state.palette = paletteOf(id).id;
  syncControls();
  dirty = true;
  scheduleSave();
}
function setAlign(align) {
  state.align = align === "center" ? "center" : "left";
  syncControls();
  dirty = true;
  scheduleSave();
}
function setToggle(name, on) {
  state[name] = Boolean(on);
  syncControls();
  dirty = true;
  scheduleSave();
}
function shuffle() {
  let next = state.seed;
  while (next === state.seed) next = 1 + Math.floor(Math.random() * 99999);
  state.seed = next;
  syncControls();
  dirty = true;
  scheduleSave();
}

function updateCount() {
  const n = state.copy.description.length;
  $("#desc-count").textContent = n ? `${n} / 600` : "";
}

function syncSpeed() {
  const el = $("#speed");
  el.value = String(state.speed);
  el.style.setProperty("--val", `${state.speed}%`);
  $("#speed-val").textContent = state.speed === 0 ? "Still" : `${state.speed}%`;
  const live = $("#live");
  live.classList.toggle("paused", state.speed === 0);
  live.title = state.speed === 0 ? "The preview redraws as you type; the background is holding still" : "The preview redraws as you type and the background flows";
}

function syncControls() {
  for (const input of inputs) {
    const v = state.copy[input.dataset.key];
    if (input.value !== v) input.value = v;
  }
  updateCount();
  const f = formatOf(state.format);
  for (const b of document.querySelectorAll("#formats button")) b.setAttribute("aria-pressed", String(b.dataset.format === f.id));
  for (const b of document.querySelectorAll("#palettes button")) b.setAttribute("aria-pressed", String(b.dataset.palette === state.palette));
  for (const b of document.querySelectorAll("#align button")) b.setAttribute("aria-pressed", String(b.dataset.align === state.align));
  $("#shapes").setAttribute("aria-checked", String(state.shapes));
  $("#grain").setAttribute("aria-checked", String(state.grain));
  $("#palette-name").textContent = paletteOf(state.palette).name;
  $("#seed-val").textContent = `#${String(state.seed).padStart(5, "0")}`;
  $("#size-chip").textContent = `${f.w} × ${f.h} px`;
  $("#format-chip").textContent = `${f.label} ${f.name}`;
  syncSpeed();
}

/** Replace the whole design (load, reset, tests). Does not save by itself. */
function applyDesign(raw) {
  const prevFormat = state.format;
  state = normalize(raw);
  syncControls();
  if (state.format !== prevFormat) fitPreview();
  dirty = true;
}

// ------------------------------------------------------------------ theme

const colorProbe = document.createElement("canvas").getContext("2d");
function luminance(color) {
  colorProbe.fillStyle = "#000";
  colorProbe.fillStyle = color;
  const v = colorProbe.fillStyle;
  let rgb = [0, 0, 0];
  if (v.startsWith("#")) rgb = hexRgb(v);
  else {
    const m = v.match(/[\d.]+/g);
    if (m) rgb = m.slice(0, 3).map(Number);
  }
  const lin = rgb.map((c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function applyHostTheme(theme) {
  const root = document.documentElement;
  root.dataset.mode = theme && theme.mode === "light" ? "light" : "dark";
  const colors = (theme && theme.colors) || {};
  for (const name of ["bg", "panel", "line", "text", "dim", "accent"]) {
    const v = typeof colors[name] === "string" ? colors[name].trim() : "";
    if (v) root.style.setProperty(`--${name}`, v);
    else root.style.removeProperty(`--${name}`);
  }
  for (const name of ["sans", "mono"]) {
    const v = theme && typeof theme[name] === "string" ? theme[name].trim() : "";
    if (v) root.style.setProperty(`--${name}`, v);
    else root.style.removeProperty(`--${name}`);
  }
  const accent = getComputedStyle(root).getPropertyValue("--accent").trim() || "#8aa2ff";
  root.style.setProperty("--on-accent", luminance(accent) > 0.42 ? "#0b0d12" : "#ffffff");
}

Rosalena.on("theme", applyHostTheme);

// ------------------------------------------------------------------ self-tests

let bootResolve;
const booted = new Promise((resolve) => (bootResolve = resolve));

const pixelsOf = (canvas) => canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
function changedPixels(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
  }
  return n;
}
function scratch(k) {
  const f = formatOf(state.format);
  const c = document.createElement("canvas");
  c.width = Math.round(f.w * k);
  c.height = Math.round(f.h * k);
  return c;
}
function typeInto(key, value) {
  const input = document.querySelector(`[data-key="${key}"]`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function isolated(fn) {
  await booted;
  const snap = serialize();
  const t = clock.t;
  try {
    return await fn();
  } finally {
    applyDesign(snap);
    clock.t = t;
    drawPreview();
  }
}

Rosalena.test("typing a title changes the rendered poster", () =>
  isolated(async () => {
    const T = 21.5;
    drawPreview(T);
    const before = pixelsOf(preview);
    typeInto("title1", "Hello, poster");
    Rosalena.assert(state.copy.title1 === "Hello, poster", "the title field did not reach the design");
    drawPreview(T);
    const after = pixelsOf(preview);
    const changed = changedPixels(before, after);
    Rosalena.assert(changed > 400, `only ${changed} preview pixels changed after typing a title`);
    typeInto("title1", DEFAULT_COPY.title1);
    drawPreview(T);
    const back = changedPixels(before, pixelsOf(preview));
    Rosalena.assert(back < changed / 10, `putting the title back left ${back} pixels different`);
    let spread = 0;
    for (let i = 0; i < after.length; i += 4 * 97) spread = Math.max(spread, Math.abs(after[i] - after[0]) + Math.abs(after[i + 1] - after[1]));
    Rosalena.assert(spread > 30, "the preview looks like a flat colour");
  }));

for (const f of FORMATS) {
  Rosalena.test(`exports ${f.label} as a ${f.w}x${f.h} PNG`, () =>
    isolated(async () => {
      document.querySelector(`#formats [data-format="${f.id}"]`).click();
      Rosalena.assert(state.format === f.id, "the format button did not change the format");
      const out = await exportImage("png");
      Rosalena.assert(out.result, "files.save returned nothing");
      const head = new Uint8Array(await out.blob.slice(0, 8).arrayBuffer());
      Rosalena.assert(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47, "the export is not a PNG");
      const bmp = await createImageBitmap(out.blob);
      Rosalena.assert(bmp.width === f.w && bmp.height === f.h, `the PNG decodes as ${bmp.width}x${bmp.height}, expected ${f.w}x${f.h}`);
      bmp.close();
      Rosalena.assert(out.blob.size > 50000, `the PNG is only ${out.blob.size} bytes`);
    }));
}

Rosalena.test("exports a full-size JPG", () =>
  isolated(async () => {
    const out = await exportImage("jpeg");
    const head = new Uint8Array(await out.blob.slice(0, 3).arrayBuffer());
    Rosalena.assert(head[0] === 0xff && head[1] === 0xd8, "the export is not a JPEG");
    const bmp = await createImageBitmap(out.blob);
    const f = formatOf(state.format);
    Rosalena.assert(bmp.width === f.w && bmp.height === f.h, `the JPG decodes as ${bmp.width}x${bmp.height}`);
    bmp.close();
  }));

Rosalena.test("changing the palette changes the background colours", () =>
  isolated(async () => {
    const T = 9.3;
    const mean = (id) => {
      document.querySelector(`#palettes [data-palette="${id}"]`).click();
      Rosalena.assert(state.palette === id, `the ${id} swatch did not select its palette`);
      const c = scratch(0.2);
      renderPoster(c, 0.2, state, T, { shapes: false, shade: false, text: false, grain: false });
      const d = pixelsOf(c);
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) {
        sum[0] += d[i];
        sum[1] += d[i + 1];
        sum[2] += d[i + 2];
      }
      const n = d.length / 4;
      return sum.map((v) => v / n);
    };
    const cobalt = mean("cobalt");
    const ember = mean("ember");
    const paper = mean("paper");
    const dist = Math.hypot(cobalt[0] - ember[0], cobalt[1] - ember[1], cobalt[2] - ember[2]);
    Rosalena.assert(dist > 50, `cobalt and ember backgrounds are too close (${dist.toFixed(1)})`);
    Rosalena.assert(cobalt[2] > cobalt[0] + 20, `cobalt is not blue: ${cobalt.map(Math.round)}`);
    Rosalena.assert(ember[0] > ember[2] + 20, `ember is not warm: ${ember.map(Math.round)}`);
    Rosalena.assert(paper[0] + paper[1] + paper[2] > 3 * 170, `paper is not light: ${paper.map(Math.round)}`);
  }));

Rosalena.test("alignment moves the text", () =>
  isolated(async () => {
    const k = 0.5;
    const titleInk = () => {
      const c = scratch(k);
      const L = renderPoster(c, k, state, clock.t, { background: false, shapes: false, shade: false, grain: false });
      const title = L.items.filter((it) => it.role === "title");
      const top = Math.floor(Math.min(...title.map((it) => it.y - it.size * 0.5)) * k);
      const bottom = Math.ceil(Math.max(...title.map((it) => it.y + it.size * 0.5)) * k);
      const d = c.getContext("2d").getImageData(0, top, c.width, bottom - top).data;
      let minX = Infinity, maxX = -1;
      for (let y = 0; y < bottom - top; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 80) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      return { minX, maxX, width: c.width, L };
    };
    document.querySelector('#align [data-align="left"]').click();
    Rosalena.assert(state.align === "left", "the left button did not align left");
    const left = titleInk();
    document.querySelector('#align [data-align="center"]').click();
    Rosalena.assert(state.align === "center", "the center button did not centre");
    const centre = titleInk();
    Rosalena.assert(left.maxX > 0 && centre.maxX > 0, "the title drew no pixels");
    const margin = left.L.m * k;
    Rosalena.assert(Math.abs(left.minX - margin) < left.L.titleSize * k * 0.14 + 4, `left-aligned title starts at ${left.minX}px, the margin is ${margin}px`);
    Rosalena.assert(centre.minX > left.minX + 20, `centring moved the title from ${left.minX}px to ${centre.minX}px`);
    const mid = (centre.minX + centre.maxX) / 2;
    Rosalena.assert(Math.abs(mid - centre.width / 2) < 12, `the centred title's middle is ${mid}px, the poster's is ${centre.width / 2}px`);
  }));

Rosalena.test("long copy wraps and stays inside the poster", () =>
  isolated(async () => {
    for (const f of FORMATS) {
      applyDesign({
        ...serialize(),
        format: f.id,
        copy: {
          ...DEFAULT_COPY,
          title1: "Supercalifragilisticexpialidocious plugins for absolutely everything you can imagine",
          title2: "and a second line that also goes on far longer than any poster title should",
          subtitle: "A subtitle with plenty of words in it so that it has to wrap onto more than one line",
          description: "Lorem ipsum dolor sit amet ".repeat(22),
          footerLeft: "a very long footer left label that keeps going",
          footerRight: "and an equally long footer right label",
        },
      });
      const L = getLayout(state);
      for (const it of L.items) {
        if (it.kind !== "text") continue;
        Rosalena.assert(it.x >= L.m - 0.5 && it.x + it.w <= L.W - L.m + 0.5, `${f.label}: "${it.text.slice(0, 24)}" (${it.role}) runs outside the margins`);
      }
      Rosalena.assert(L.stackTop >= L.eyebrowBottom, `${f.label}: the text stack runs into the eyebrow`);
      Rosalena.assert(L.stackBottom <= L.bottomLimit + 0.5, `${f.label}: the text stack runs into the footer`);
      Rosalena.assert(L.items.filter((it) => it.role === "title").length >= 2, `${f.label}: the title did not wrap`);
    }
  }));

Rosalena.test("storage round trip restores the design", () =>
  isolated(async () => {
    // a real design, every field different from the defaults
    const design = normalize({
      copy: {
        eyebrow: "CREATOR MODE",
        title1: "Describe it.",
        title2: "Ship it.",
        subtitle: "Plugins built and verified from the chat.",
        description: "Ask for a tool, a game or a viewer. Rosalena writes it, runs its self-tests in a sandbox and only installs what passes.",
        footerLeft: "Rosalena Harness",
        footerRight: "Vol. 02",
      },
      format: "3x4",
      align: "center",
      palette: "dusk",
      shapes: true,
      grain: false,
      speed: 25,
      seed: 5150,
    });
    applyDesign(design);
    await saveNow();
    applyDesign(defaults());
    Rosalena.assert(state.copy.title1 === DEFAULT_COPY.title1, "the reset did not take");
    const raw = await Rosalena.storage.get(KEY);
    Rosalena.assert(raw && raw.copy && raw.copy.title1 === design.copy.title1, "storage did not keep the design");
    const found = await loadDesign();
    Rosalena.assert(found, "loadDesign found nothing saved");
    Rosalena.assert(JSON.stringify(state) === JSON.stringify(design), `restored ${JSON.stringify(state).slice(0, 160)}`);
    Rosalena.assert(document.querySelector('[data-key="title1"]').value === design.copy.title1, "the title field was not restored");
    Rosalena.assert($("#formats [data-format='3x4']").getAttribute("aria-pressed") === "true", "the format buttons were not restored");
    Rosalena.assert($("#palettes [data-palette='dusk']").getAttribute("aria-pressed") === "true", "the palette buttons were not restored");
  }).then(() => saveNow()));

// ------------------------------------------------------------------ start

buildControls();
applyHostTheme(Rosalena.host && Rosalena.host.theme);
syncControls();
fitPreview();
startLoop();
Rosalena.ready();

(async () => {
  try {
    await withTimeout(Rosalena.whenConnected, 5000);
    const found = await withTimeout(loadDesign(), 5000);
    if (found === undefined) setSaveState("error", "Storage did not answer; changes are not saved");
    else setSaveState("saved", found ? "Restored your design" : "Saved");
    loaded = found !== undefined;
  } catch (err) {
    setSaveState("error", `Could not load: ${err && err.message ? err.message : err}`);
    loaded = true;
  } finally {
    bootResolve();
  }
})();
