// Transformer 3D Lab: a real tiny transformer (model.mjs) laid out in 3D, step by step.
import * as THREE from "/plugin-lib/three/three.module.js";
import { OrbitControls } from "/plugin-lib/three/OrbitControls.js";
import { VOCAB, DIMS, DIM_HELP, NEURONS, HEADS, D, DH, FF, DEFAULT_PROMPT, run, explain, valueOf, fmt, softmax } from "./model.mjs";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const STAGES = [
  {
    key: "tokens",
    name: "Tokens",
    formula: "id = vocab.indexOf(word)",
    html: "id = vocab.indexOf(word)",
    note: "The sentence is split into words and each word becomes an id from the 16-word vocabulary. The model only ever sees these ids.",
  },
  {
    key: "embed",
    name: "Embed",
    formula: "x = E[id] + P[pos]",
    html: "x = E[id] + P[pos]",
    note: "Each id picks a row of the embedding table E: 8 numbers describing the word (det, animal, verb...). A small position signal P is added so word order is not lost.",
  },
  {
    key: "qkv",
    name: "Q · K · V",
    formula: "q = xWq,  k = xWk,  v = xWv",
    html: "q = xW<sub>Q</sub>, k = xW<sub>K</sub>, v = xW<sub>V</sub>",
    note: "Each word's vector is multiplied by three weight matrices: a query (what am I looking for?), a key (what do I offer?) and a value (what do I pass on?).",
  },
  {
    key: "attn",
    name: "Attention",
    formula: "A = softmax(qkᵀ/√d + mask)",
    html: "A = softmax(qk<sup>T</sup>/√d + mask)",
    note: "Each row is one word asking which earlier words matter. Scores q·k are divided by √4, future words are masked (dark red), and softmax makes each row sum to 1.",
  },
  {
    key: "mix",
    name: "Mix",
    formula: "x′ = x + concat(Av)Wo",
    html: "x′ = x + concat(A·v) W<sub>O</sub>",
    note: "Each word gathers the values it attended to. Both heads are joined, projected by W_O and added back onto the word's own vector (the residual connection).",
  },
  {
    key: "ffn",
    name: "FFN",
    formula: "h = ReLU(x′W1 + b1)",
    html: "h = ReLU(x′W<sub>1</sub> + b<sub>1</sub>)",
    full: "h = ReLU(x′W<sub>1</sub> + b<sub>1</sub>), x″ = x′ + hW<sub>2</sub> + b<sub>2</sub>",
    note: "A small ReLU layer runs on every word separately. Each unit is a detector, like \"a determiner right after a preposition, so a place comes next\". Units below zero switch off.",
  },
  {
    key: "logits",
    name: "Logits",
    formula: "p = softmax(x″ Eᵀ)",
    html: "p = softmax(x″<sub>last</sub> E<sup>T</sup>)",
    note: "The last word's final vector is scored against every word's embedding, and softmax turns the scores into the probability of each possible next word.",
  },
];
const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const REF_STAGE = { token: 0, embed: 1, qkv: 2, attn: 3, mix: 4, ffn: 5, logit: 6 };
const DIM_SHORT = ["det", "anim", "verb", "prep", "place", "rest", "ctx", "end"];
const NEURON_SHORT = ["→place", "→anim", "→verb", "→prep", "→det", "→end", "soft", "hard"];

// ------------------------------------------------------------------ state

const state = {
  text: DEFAULT_PROMPT,
  model: run(DEFAULT_PROMPT),
  head: 0,
  stage: 0,
  selected: null,
  token: 4,
  playing: false,
  error: "",
};

// ------------------------------------------------------------------ theme (panel chrome)

const FALLBACK = {
  dark: { bg: "#0f141c", panel: "#151c27", line: "#263041", text: "#e6ebf2", dim: "#8b97a8", accent: "#5aa9ff", "accent-soft": "rgba(90,169,255,0.16)", ok: "#3ecf8e", warn: "#f5b041", bad: "#ff6b6b" },
  light: { bg: "#f6f7f9", panel: "#ffffff", line: "#dde2ea", text: "#18202c", dim: "#5d6878", accent: "#2f7de1", "accent-soft": "rgba(47,125,225,0.12)", ok: "#1f9d63", warn: "#b7791f", bad: "#d64545" },
};
function applyTheme(theme) {
  const mode = theme && theme.mode === "light" ? "light" : "dark";
  const colors = (theme && theme.colors) || {};
  const root = document.documentElement;
  for (const [name, fallback] of Object.entries(FALLBACK[mode])) {
    const v = typeof colors[name] === "string" && colors[name].trim() ? colors[name].trim() : fallback;
    root.style.setProperty(`--${name}`, v);
  }
  if (theme && typeof theme.sans === "string" && theme.sans.trim()) root.style.setProperty("--sans", theme.sans);
  if (theme && typeof theme.mono === "string" && theme.mono.trim()) root.style.setProperty("--mono", theme.mono);
  root.dataset.mode = mode;
}
applyTheme(null);
Rosalena.on("theme", applyTheme);

// ------------------------------------------------------------------ three.js setup

const view = $("#view");
const COL = {
  bg: new THREE.Color("#0a0f18"),
  pos: new THREE.Color("#58b0ff"),
  posLow: new THREE.Color("#1d2c44"),
  neg: new THREE.Color("#ff8a3d"),
  negLow: new THREE.Color("#3e2a1c"),
  mask: new THREE.Color("#8a2433"),
  off: new THREE.Color("#343c4b"),
  gold: new THREE.Color("#ffd166"),
  token: new THREE.Color("#24304a"),
  frame: new THREE.Color("#2a3a55"),
  frameOn: new THREE.Color("#5aa9ff"),
  titleOff: new THREE.Color("#93a3ba"),
  titleOn: new THREE.Color("#ffffff"),
};
const CELL = 0.52;
const BOX = 0.4;
const ROW_PAD = 1.25;
const GAP = 1.9;
const MIN_H = 0.035;
const LOGIT_PAD = 2.05;

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let world = null;
let marker = null;
let glError = "";
const raycaster = new THREE.Raycaster();
const BOX_GEO = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const MARKER_GEO = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));

let pickables = [];
let cellMap = new Map();
let stageCells = [];
let layout = { stages: [], width: 0 };

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return Boolean(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch (_) {
    return false;
  }
}

function initThree() {
  if (!webglAvailable()) {
    glError = "This view needs WebGL, and this window does not offer it. The panel on the right still shows every number the model computes.";
    return false;
  }
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  } catch (err) {
    glError = `The 3D view could not start (${err && err.message ? err.message : err}). The panel on the right still works.`;
    renderer = null;
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(COL.bg, 1);
  view.prepend(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "3D transformer scene. Click a cube to inspect it.");

  scene = new THREE.Scene();
  scene.background = COL.bg;
  scene.fog = new THREE.Fog(COL.bg, 70, 150);
  camera = new THREE.PerspectiveCamera(40, 1.4, 0.1, 400);
  camera.position.set(0, 20, 40);

  scene.add(new THREE.HemisphereLight(0xc4d6ff, 0x0b0f16, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(-8, 22, 14);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x6f9cff, 0.55);
  rim.position.set(10, 6, -16);
  scene.add(rim);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x0b111c, roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);
  const grid = new THREE.GridHelper(160, 160, 0x18233a, 0x111a2b);
  grid.position.y = -0.01;
  scene.add(grid);

  marker = new THREE.LineSegments(MARKER_GEO, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }));
  marker.renderOrder = 20;
  marker.visible = false;
  scene.add(marker);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2.5;
  controls.maxDistance = 120;
  controls.screenSpacePanning = true;
  controls.addEventListener("start", () => {
    fly = null;
    if (state.playing) stopPlay();
  });

  resize();
  new ResizeObserver(() => resize()).observe(view);
  wirePointer();
  return true;
}

function resize() {
  if (!renderer) return;
  const w = Math.max(view.clientWidth, 50);
  const h = Math.max(view.clientHeight, 50);
  renderer.setSize(w, h, true);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderNow();
}

// ------------------------------------------------------------------ labels

function makeLabel(text, { height = 0.4, color = "#e8eefc", weight = 600, mono = false, align = "center", onTop = false, bg = null } = {}) {
  const fontPx = 64;
  const family = mono ? "Consolas, 'Cascadia Mono', monospace" : "'Segoe UI', system-ui, -apple-system, sans-serif";
  const font = `${weight} ${fontPx}px ${family}`;
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  g.font = font;
  const textW = Math.ceil(g.measureText(text).width);
  const padX = bg ? Math.round(fontPx * 0.45) : Math.round(fontPx * 0.12);
  canvas.width = textW + padX * 2;
  canvas.height = Math.round(fontPx * 1.4);
  g.font = font;
  g.textBaseline = "middle";
  g.textAlign = "center";
  if (bg) {
    const r = canvas.height * 0.3;
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(1, 1, canvas.width - 2, canvas.height - 2, r);
    g.fill();
  }
  g.fillStyle = color;
  g.fillText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.04);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !onTop, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  if (align === "right") sprite.center.set(1, 0.5);
  if (align === "left") sprite.center.set(0, 0.5);
  if (onTop) sprite.renderOrder = 10;
  return sprite;
}

/** Text printed flat on a stage plate, readable from the front. */
function makeFlat(text, { height = 0.26, color = "#b9c6d9", weight = 500, mono = false, align = "center" } = {}) {
  const fontPx = 64;
  const family = mono ? "Consolas, 'Cascadia Mono', monospace" : "'Segoe UI', system-ui, -apple-system, sans-serif";
  const font = `${weight} ${fontPx}px ${family}`;
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  g.font = font;
  const padX = Math.round(fontPx * 0.08);
  canvas.width = Math.ceil(g.measureText(text).width) + padX * 2;
  canvas.height = Math.round(fontPx * 1.3);
  g.font = font;
  g.textBaseline = "middle";
  g.textAlign = "center";
  g.fillStyle = color;
  g.fillText(text, canvas.width / 2, canvas.height / 2 + fontPx * 0.04);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const w = (height * canvas.width) / canvas.height;
  const geo = new THREE.PlaneGeometry(w, height);
  if (align === "right") geo.translate(-w / 2, 0, 0);
  if (align === "left") geo.translate(w / 2, 0, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  return mesh;
}

// ------------------------------------------------------------------ scene build

const refKey = (r) => [r.stage, r.head, r.kind, r.t, r.i, r.j, r.d, r.n, r.w, r.raw ? "raw" : ""].map((v) => (v === undefined ? "" : v)).join("|");

function valueColor(v, scale) {
  const t = Math.pow(Math.min(1, Math.abs(v) / scale), 0.65);
  const c = new THREE.Color();
  return v >= 0 ? c.copy(COL.posLow).lerp(COL.pos, t) : c.copy(COL.negLow).lerp(COL.neg, t);
}

function addCell(group, ref, v, { hs, cs, x, z, size = BOX, kind = "value" }) {
  const flat = kind === "masked" || kind === "off";
  const h = flat ? MIN_H : Math.max(Math.abs(v) * hs, MIN_H);
  const color = kind === "masked" ? COL.mask : kind === "off" ? COL.off : kind === "top" ? COL.gold : valueColor(v, cs);
  const glow = kind === "top" ? 0.35 : flat ? 0.05 : 0.2;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.06, emissive: color, emissiveIntensity: glow });
  const mesh = new THREE.Mesh(BOX_GEO, mat);
  mesh.position.set(x, 0.005, z);
  mesh.scale.set(size, h, size);
  mesh.userData = { ref, h, glow };
  group.add(mesh);
  pickables.push(mesh);
  cellMap.set(refKey(ref), mesh);
  stageCells[REF_STAGE[ref.stage]].push(mesh);
  return mesh;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && o.geometry !== BOX_GEO && o.geometry !== MARKER_GEO) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}

function stageWidths(T) {
  return [
    3.2,
    ROW_PAD + D * CELL + 0.35,
    ROW_PAD + 3 * DH * CELL + 2 * 0.5 + 0.35,
    Math.max(ROW_PAD + T * CELL + 0.35, 4.2),
    ROW_PAD + D * CELL + 0.35,
    ROW_PAD + FF * CELL + 0.35,
    LOGIT_PAD + VOCAB.length * 0.64 + 0.35,
  ];
}

function buildScene() {
  if (!renderer) return;
  const m = state.model;
  if (world) {
    scene.remove(world);
    disposeTree(world);
  }
  world = new THREE.Group();
  scene.add(world);
  pickables = [];
  cellMap = new Map();
  stageCells = STAGES.map(() => []);

  const T = m.T;
  const zRow = (t) => (t - (T - 1) / 2) * CELL;
  const zBack = Math.min(zRow(0) - CELL / 2 - 0.55, -1.75);
  const zFront = Math.max(zRow(T - 1) + CELL / 2 + 0.95, 2.05);
  const widths = stageWidths(T);
  const total = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
  let cursor = -total / 2;
  layout = { stages: [], width: total, zBack, zFront };

  const rowLabels = (group, x) => {
    for (let t = 0; t < T; t++) {
      const s = makeFlat(m.words[t], { height: 0.26, color: "#b9c6d9", weight: 500, mono: true, align: "right" });
      s.position.set(x, 0.012, zRow(t));
      group.add(s);
    }
  };
  const colLabels = (group, x0, names, z = zFront - 0.42) => {
    names.forEach((name, c) => {
      const s = makeFlat(name, { height: 0.18, color: "#8fa1ba", weight: 500 });
      s.position.set(x0 + (c + 0.5) * CELL, 0.012, z);
      group.add(s);
    });
  };

  STAGES.forEach((stage, si) => {
    const w = widths[si];
    const x0 = cursor;
    cursor += w + GAP;
    const g = new THREE.Group();
    g.position.x = x0;
    world.add(g);

    // frame: a base plate, an outline, a title
    const base = new THREE.Mesh(new THREE.PlaneGeometry(w, zFront - zBack), new THREE.MeshStandardMaterial({ color: 0x101a2a, roughness: 0.9 }));
    base.rotation.x = -Math.PI / 2;
    base.position.set(w / 2, 0.0, (zBack + zFront) / 2);
    g.add(base);
    const corners = [new THREE.Vector3(0, 0.01, zBack), new THREE.Vector3(w, 0.01, zBack), new THREE.Vector3(w, 0.01, zFront), new THREE.Vector3(0, 0.01, zFront)];
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(corners), new THREE.LineBasicMaterial({ color: COL.frame.clone() }));
    g.add(outline);
    const title = makeLabel(`${si + 1}  ${stage.name}`, { height: 0.78, color: "#ffffff", weight: 650, onTop: true });
    title.position.set(w / 2, 3.4, zBack);
    g.add(title);
    const sub = makeLabel(stage.formula, { height: 0.3, color: "#9cc8ff", weight: 400, mono: true, onTop: true });
    sub.position.set(w / 2, 2.82, zBack);
    g.add(sub);
    title.userData = { baseW: title.scale.x, baseH: title.scale.y, baseY: 3.4, lift: 0.75 };
    sub.userData = { baseW: sub.scale.x, baseH: sub.scale.y, baseY: 2.82, lift: 0.15 };
    layout.stages.push({ x0, x1: x0 + w, base, outline, title, sub });

    if (stage.key === "tokens") {
      for (let t = 0; t < T; t++) {
        const tile = addCell(g, { stage: "token", t }, 1, { hs: 0.14, cs: 1, x: w / 2, z: zRow(t), size: 1 });
        tile.scale.set(2.2, 0.14, 0.42);
        tile.userData.h = 0.14;
        tile.material.color.copy(COL.token);
        tile.material.emissive.copy(COL.token);
        const lab = makeFlat(m.words[t], { height: 0.3, color: "#ffffff", weight: 600, mono: true, align: "right" });
        lab.position.set(w / 2 + 0.3, 0.15, zRow(t));
        g.add(lab);
        const id = makeFlat(`id ${m.ids[t]}`, { height: 0.22, color: "#8cc4ff", weight: 500, mono: true, align: "left" });
        id.position.set(w / 2 + 0.42, 0.15, zRow(t));
        g.add(id);
        const p = makeFlat(`${t}`, { height: 0.2, color: "#6f819b", weight: 500, mono: true, align: "right" });
        p.position.set(w / 2 - 1.2, 0.012, zRow(t));
        g.add(p);
      }
      const pos = makeFlat("pos   word   vocab id", { height: 0.17, color: "#7f90a8", weight: 400 });
      pos.position.set(w / 2 - 0.1, 0.012, zFront - 0.42);
      g.add(pos);
    }

    if (stage.key === "embed" || stage.key === "mix") {
      const src = stage.key === "embed" ? m.x0 : m.x1;
      rowLabels(g, ROW_PAD - 0.15);
      for (let t = 0; t < T; t++)
        for (let d = 0; d < D; d++) addCell(g, stage.key === "embed" ? { stage: "embed", t, d } : { stage: "mix", t, d }, src[t][d], { hs: 1.05, cs: 1.1, x: ROW_PAD + (d + 0.5) * CELL, z: zRow(t) });
      colLabels(g, ROW_PAD, DIM_SHORT);
    }

    if (stage.key === "qkv") {
      rowLabels(g, ROW_PAD - 0.15);
      const hd = m.heads[state.head];
      ["q", "k", "v"].forEach((kind, b) => {
        const bx = ROW_PAD + b * (DH * CELL + 0.5);
        for (let t = 0; t < T; t++) for (let j = 0; j < DH; j++) addCell(g, { stage: "qkv", head: state.head, kind, t, j }, hd[kind][t][j], { hs: 0.62, cs: 2.2, x: bx + (j + 0.5) * CELL, z: zRow(t) });
        const lab = makeFlat(`${kind.toUpperCase()}  (${{ q: "query", k: "key", v: "value" }[kind]})`, { height: 0.24, color: "#c9d6ea", weight: 600 });
        lab.position.set(bx + (DH * CELL) / 2, 0.012, zFront - 0.42);
        g.add(lab);
      });
      const hl = makeLabel(`${HEADS[state.head].name}: ${HEADS[state.head].role}`, { height: 0.24, color: "#8cc4ff", weight: 500, onTop: true });
      hl.position.set(w / 2, 2.45, zBack);
      g.add(hl);
    }

    if (stage.key === "attn") {
      const hd = m.heads[state.head];
      rowLabels(g, ROW_PAD - 0.15);
      for (let i = 0; i < T; i++)
        for (let j = 0; j < T; j++) {
          const masked = j > i;
          addCell(g, { stage: "attn", head: state.head, i, j }, hd.A[i][j], { hs: 2.1, cs: 0.9, x: ROW_PAD + (j + 0.5) * CELL, z: zRow(i), kind: masked ? "masked" : "value" });
        }
      for (let j = 0; j < T; j++) {
        const s = makeFlat(m.words[j], { height: 0.19, color: "#8fa1ba", weight: 500, mono: true });
        s.position.set(ROW_PAD + (j + 0.5) * CELL, 0.012, zRow(T - 1) + CELL / 2 + 0.22);
        g.add(s);
      }
      const cap = makeFlat("rows: query word   columns: key word", { height: 0.17, color: "#7f90a8", weight: 400 });
      cap.position.set(w / 2, 0.012, zFront - 0.22);
      g.add(cap);
      const hl = makeLabel(`${HEADS[state.head].name}: ${HEADS[state.head].role}`, { height: 0.24, color: "#8cc4ff", weight: 500, onTop: true });
      hl.position.set(w / 2, 2.45, zBack);
      g.add(hl);
    }

    if (stage.key === "ffn") {
      rowLabels(g, ROW_PAD - 0.15);
      for (let t = 0; t < T; t++)
        for (let n = 0; n < FF; n++) {
          const v = m.hidden[t][n];
          addCell(g, { stage: "ffn", t, n }, v, { hs: 1.25, cs: 1.0, x: ROW_PAD + (n + 0.5) * CELL, z: zRow(t), kind: v > 0 ? "value" : "off" });
        }
      colLabels(g, ROW_PAD, NEURON_SHORT);
    }

    if (stage.key === "logits") {
      // back row: raw scores (signed); front row: softmax probabilities
      const zr = zBack + 0.75;
      const zp = zFront - 1.05;
      const spacing = 0.64;
      const xOf = (wi) => LOGIT_PAD + (wi + 0.5) * spacing;
      for (let wi = 0; wi < VOCAB.length; wi++) {
        const x = xOf(wi);
        const isTop = wi === m.top;
        addCell(g, { stage: "logit", w: wi, raw: true }, m.logits[wi], { hs: 0.3, cs: 5, x, z: zr, size: 0.42 });
        const p = m.probs[wi];
        const tower = addCell(g, { stage: "logit", w: wi }, p, { hs: 4.2, cs: 0.4, x, z: zp, size: 0.48, kind: isTop ? "top" : "value" });
        if (!isTop) {
          const c = new THREE.Color().copy(COL.posLow).lerp(COL.pos, Math.pow(Math.min(1, p / 0.4), 0.5));
          tower.material.color.copy(c);
          tower.material.emissive.copy(c);
        }
        const lab = makeFlat(VOCAB[wi], { height: 0.2, color: isTop ? "#ffd166" : "#a9b8cc", weight: isTop ? 700 : 500, mono: true });
        lab.position.set(x, 0.012, zp + 0.5);
        g.add(lab);
      }
      m.ranked.slice(0, 2).forEach((r, k) => {
        const s = makeLabel(`${r.word} ${(r.p * 100).toFixed(1)}%`, { height: k === 0 ? 0.36 : 0.27, color: k === 0 ? "#ffd166" : "#c9d6ea", weight: 650, bg: "rgba(10,15,24,0.78)", onTop: true });
        s.position.set(xOf(r.w), Math.max(r.p * 4.2, MIN_H) + 0.42, zp);
        g.add(s);
      });
      const back = makeFlat("score (logit)", { height: 0.26, color: "#b9c6d9", weight: 500, align: "right" });
      back.position.set(LOGIT_PAD - 0.15, 0.012, zr);
      g.add(back);
      const mid = makeFlat("softmax ↓", { height: 0.22, color: "#8cc4ff", weight: 500, mono: true, align: "right" });
      mid.position.set(LOGIT_PAD - 0.15, 0.012, (zr + zp) / 2);
      g.add(mid);
      const front = makeFlat("probability", { height: 0.26, color: "#b9c6d9", weight: 500, align: "right" });
      front.position.set(LOGIT_PAD - 0.15, 0.012, zp);
      g.add(front);
      const cap = makeFlat(`what comes after "${m.words[T - 1]}"? (read from the last word's final vector)`, { height: 0.18, color: "#7f90a8", weight: 400, align: "left" });
      cap.position.set(LOGIT_PAD, 0.012, zFront - 0.18);
      g.add(cap);
    }
  });

  // connectors between stages
  for (let si = 0; si < STAGES.length - 1; si++) {
    const a = layout.stages[si].x1 + 0.2;
    const b = layout.stages[si + 1].x0 - 0.25;
    const mat = new THREE.MeshBasicMaterial({ color: 0x34476a });
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(b - a - 0.3, 0.03, 0.06), mat);
    shaft.position.set((a + b - 0.3) / 2, 0.03, 0);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 16), mat.clone());
    head.rotation.z = -Math.PI / 2;
    head.position.set(b - 0.18, 0.05, 0);
    world.add(shaft, head);
    layout.stages[si].arrow = [shaft, head];
  }

  highlightStage();
  placeMarker();
}

function highlightStage() {
  if (!renderer) return;
  layout.stages.forEach((s, i) => {
    const on = i === state.stage;
    s.outline.material.color.copy(on ? COL.frameOn : COL.frame);
    s.base.material.color.set(on ? 0x14243b : 0x101a2a);
    s.title.material.color.copy(on ? COL.titleOn : COL.titleOff);
    s.sub.material.opacity = on ? 1 : 0.55;
    if (s.arrow) for (const part of s.arrow) part.material.color.set(on ? 0x5aa9ff : 0x34476a);
  });
}

function placeMarker() {
  if (!marker) return;
  const mesh = state.selected ? cellMap.get(refKey(state.selected)) : null;
  if (!mesh) {
    marker.visible = false;
    return;
  }
  const wp = new THREE.Vector3();
  mesh.getWorldPosition(wp);
  marker.position.copy(wp);
  marker.position.y -= 0.01;
  marker.scale.set(mesh.scale.x + 0.1, mesh.userData.h + 0.08, mesh.scale.z + 0.1);
  marker.visible = true;
}

// ------------------------------------------------------------------ camera

let fly = null;
let looping = false;

// The part of the screen the scene should fill, in normalised device coordinates: below the
// toolbar, above the step note and the hint bar.
function freeRegion() {
  const h = Math.max(view.clientHeight, 50);
  const w = Math.max(view.clientWidth, 50);
  const top = 58 / h;
  const note = $("#stage-note");
  const bottom = ((note && note.offsetHeight ? note.offsetHeight + 54 : 44) + 6) / h;
  const side = 18 / w;
  return { x0: -1 + side * 2, x1: 1 - side * 2, y0: -1 + bottom * 2, y1: 1 - top * 2 };
}

/** Camera placement that frames `box` from direction `dir`, filling the free region. */
function fitView(box, dir) {
  const region = freeRegion();
  const cam = camera.clone();
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  const target = box.getCenter(new THREE.Vector3());
  const v = new THREE.Vector3();
  const project = (dist) => {
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let behind = false;
    for (const c of corners) {
      v.copy(c).applyMatrix4(cam.matrixWorldInverse);
      if (v.z > -cam.near * 4) behind = true;
      v.copy(c).project(cam);
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
      minY = Math.min(minY, v.y);
      maxY = Math.max(maxY, v.y);
    }
    return { minX, maxX, minY, maxY, behind };
  };
  const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
  const tanH = tanV * cam.aspect;
  let dist = 20;
  for (let round = 0; round < 4; round++) {
    let lo = 1, hi = 400;
    for (let k = 0; k < 32; k++) {
      const mid = (lo + hi) / 2;
      const b = project(mid);
      if (!b.behind && b.maxX - b.minX <= region.x1 - region.x0 && b.maxY - b.minY <= region.y1 - region.y0) hi = mid;
      else lo = mid;
    }
    dist = hi;
    const b = project(dist);
    const dx = (b.minX + b.maxX) / 2 - (region.x0 + region.x1) / 2;
    const dy = (b.minY + b.maxY) / 2 - (region.y0 + region.y1) / 2;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    target.addScaledVector(right, dx * dist * tanH).addScaledVector(up, dy * dist * tanV);
  }
  return { target, pos: target.clone().addScaledVector(dir, dist) };
}

const STAGE_DIR = new THREE.Vector3(-0.22, 0.78, 1).normalize();
const OVERVIEW_DIR = new THREE.Vector3(-0.62, 0.92, 1).normalize();

function stageBox(s) {
  return new THREE.Box3(new THREE.Vector3(s.x0 - 0.3, 0, layout.zBack - 0.2), new THREE.Vector3(s.x1 + 0.3, 3.75, layout.zFront + 0.1));
}

function stageView(i) {
  return fitView(stageBox(layout.stages[i]), STAGE_DIR);
}

function overview() {
  const first = layout.stages[0];
  const last = layout.stages[layout.stages.length - 1];
  return fitView(new THREE.Box3(new THREE.Vector3(first.x0 - 1.6, 0, layout.zBack), new THREE.Vector3(last.x1 + 0.6, 5.2, layout.zFront)), OVERVIEW_DIR);
}

function flyTo(v, { instant = false } = {}) {
  if (!renderer) return;
  if (instant || !looping) {
    fly = null;
    camera.position.copy(v.pos);
    controls.target.copy(v.target);
    camera.lookAt(v.target);
    controls.update();
    renderNow();
    return;
  }
  fly = { fromPos: camera.position.clone(), fromTarget: controls.target.clone(), to: v, start: performance.now(), ms: 950 };
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function updateFly(now) {
  if (!fly) return;
  const k = Math.min(1, (now - fly.start) / fly.ms);
  const e = ease(k);
  camera.position.lerpVectors(fly.fromPos, fly.to.pos, e);
  controls.target.lerpVectors(fly.fromTarget, fly.to.target, e);
  if (k >= 1) fly = null;
}

let grow = null;
function updateGrow(now) {
  if (!grow) return;
  const k = Math.min(1, (now - grow.start) / 650);
  const e = 1 - Math.pow(1 - k, 3);
  for (const mesh of stageCells[grow.stage] || []) mesh.scale.y = Math.max(mesh.userData.h * e, 0.001);
  if (k >= 1) grow = null;
}
function finishGrow() {
  if (!grow) return;
  for (const mesh of stageCells[grow.stage] || []) mesh.scale.y = mesh.userData.h;
  grow = null;
}

// Stage titles grow with distance so they stay readable from the overview.
const tmpV = new THREE.Vector3();
function scaleTitles() {
  for (const s of layout.stages) {
    for (const sprite of [s.title, s.sub]) {
      sprite.getWorldPosition(tmpV);
      const k = Math.min(2.6, Math.max(1, camera.position.distanceTo(tmpV) / 16));
      sprite.scale.set(sprite.userData.baseW * k, sprite.userData.baseH * k, 1);
      sprite.position.y = sprite.userData.baseY + (k - 1) * sprite.userData.lift;
    }
  }
}

function renderNow() {
  if (!renderer) return;
  scaleTitles();
  renderer.render(scene, camera);
}

function loop(now) {
  if (!looping) return;
  requestAnimationFrame(loop);
  updateFly(now);
  updateGrow(now);
  controls.update();
  renderNow();
}
function startLoop() {
  if (!renderer || looping || document.hidden) return;
  looping = true;
  requestAnimationFrame(loop);
}
function stopLoop() {
  looping = false;
}
document.addEventListener("visibilitychange", () => (document.hidden ? stopLoop() : startLoop()));

// ------------------------------------------------------------------ picking

function pickAt(clientX, clientY) {
  if (!renderer) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  return hit ? hit.object : null;
}

/** What a click on a scene object does. Tests call this same function. */
function inspectObject(obj) {
  if (!obj || !obj.userData || !obj.userData.ref) return null;
  const detail = select(obj.userData.ref);
  revealInspector();
  return detail;
}

function revealInspector() {
  const card = document.querySelector(".inspector");
  const panel = document.querySelector(".panel");
  if (!card || !panel) return;
  const c = card.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  if (c.top < p.top || c.bottom > p.bottom) card.scrollIntoView({ block: "nearest" });
}

let hovered = null;
function setHover(obj) {
  if (hovered === obj) return;
  if (hovered) hovered.material.emissiveIntensity = hovered.userData.glow;
  hovered = obj;
  if (hovered) hovered.material.emissiveIntensity = hovered.userData.glow + 0.45;
  view.classList.toggle("picking", Boolean(obj));
  renderNow();
}

function wirePointer() {
  const el = renderer.domElement;
  const tip = $("#tooltip");
  let down = null;
  el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  el.addEventListener("pointerup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5 || e.button !== 0) return;
    const obj = pickAt(e.clientX, e.clientY);
    if (obj) inspectObject(obj);
  });
  el.addEventListener("pointermove", (e) => {
    if (e.buttons) {
      tip.hidden = true;
      return;
    }
    const obj = pickAt(e.clientX, e.clientY);
    setHover(obj);
    if (!obj) {
      tip.hidden = true;
      return;
    }
    const d = explain(state.model, obj.userData.ref);
    tip.innerHTML = `${esc(d.title)}<br><b>${esc(d.valueText)}</b>`;
    const r = view.getBoundingClientRect();
    tip.hidden = false;
    const x = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8);
    const y = Math.max(e.clientY - r.top - tip.offsetHeight - 12, 50);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  el.addEventListener("pointerleave", () => {
    tip.hidden = true;
    setHover(null);
  });
}

// ------------------------------------------------------------------ actions

function select(ref) {
  if (refKey(ref) !== (state.selected ? refKey(state.selected) : "")) {
    const status = $("#ask-status");
    status.textContent = "";
    status.classList.remove("err");
  }
  state.selected = ref;
  const d = explain(state.model, ref);
  const t = ref.t !== undefined ? ref.t : ref.i;
  if (t !== undefined) state.token = t;
  renderInspector();
  renderTokenVec();
  placeMarker();
  renderNow();
  return d;
}

function setStage(i, { instant = false, animate = false } = {}) {
  const next = Math.max(0, Math.min(STAGES.length - 1, i));
  state.stage = next;
  highlightStage();
  renderHud();
  renderPipeline();
  if (renderer) {
    if (animate && looping) {
      finishGrow();
      grow = { stage: next, start: performance.now() + 250 };
      for (const mesh of stageCells[next]) mesh.scale.y = 0.001;
    }
    flyTo(stageView(next), { instant });
  }
  scheduleSave();
  return state.stage;
}
const nextStage = () => setStage(state.stage + 1);
const prevStage = () => setStage(state.stage - 1);

function resetView({ instant = false } = {}) {
  if (state.playing) stopPlay();
  flyTo(overview(), { instant });
}

/** The opening state: step 1 lit, the whole pipeline in view, the top guess selected. */
function home() {
  if (state.playing) stopPlay();
  state.stage = 0;
  highlightStage();
  renderHud();
  renderPipeline();
  select({ stage: "logit", w: state.model.top });
  state.token = state.model.T - 1;
  renderTokenVec();
  $(".panel").scrollTo({ top: 0, behavior: "instant" });
  if (renderer) flyTo(overview(), { instant: true });
}

function setHead(h) {
  state.head = h === 1 ? 1 : 0;
  if (state.selected && state.selected.head !== undefined) state.selected = { ...state.selected, head: state.head };
  buildScene();
  renderHud();
  renderInspector();
  renderNow();
  scheduleSave();
  return state.head;
}

function refFits(ref, m) {
  if (!ref) return false;
  const inT = (v) => v === undefined || (v >= 0 && v < m.T);
  return inT(ref.t) && inT(ref.i) && (ref.stage !== "attn" || inT(ref.j));
}

/** Run the model on a new sentence. Returns { ok, error? }. */
function setPrompt(text) {
  const result = run(text);
  const input = $("#prompt-input");
  if (!result.ok) {
    state.error = result.error;
    renderError();
    input.classList.add("invalid");
    return { ok: false, error: result.error };
  }
  state.text = result.words.join(" ");
  state.model = result;
  state.error = "";
  input.value = state.text;
  input.classList.remove("invalid");
  renderError();
  if (!refFits(state.selected, result)) state.selected = { stage: "logit", w: result.top };
  if (state.token >= result.T) state.token = result.T - 1;
  buildScene();
  renderAll();
  scheduleSave();
  return { ok: true };
}

// ------------------------------------------------------------------ play

let playTimer = 0;
function play() {
  if (state.playing) return stopPlay();
  state.playing = true;
  renderHud();
  let i = 0;
  const step = () => {
    if (!state.playing) return;
    setStage(i, { animate: true });
    i += 1;
    if (i < STAGES.length) playTimer = setTimeout(step, 2700);
    else
      playTimer = setTimeout(() => {
        state.playing = false;
        renderHud();
      }, 1200);
  };
  step();
}
function stopPlay() {
  clearTimeout(playTimer);
  state.playing = false;
  finishGrow();
  renderHud();
  renderNow();
}

// ------------------------------------------------------------------ ask Rosalena

function questionText() {
  const m = state.model;
  const d = explain(m, state.selected || { stage: "logit", w: m.top });
  const terms = d.terms.map(([k, v]) => `${k} = ${typeof v === "number" ? fmt(v, 4) : v}`).join("; ");
  return [
    `I'm exploring the Transformer 3D Lab: a tiny decoder-only transformer (16-word vocabulary, d_model 8, 2 attention heads of size 4, one block, causal mask, residual connections, a ReLU feed-forward layer with 8 units, tied embeddings).`,
    `Prompt: "${m.words.join(" ")}". The model predicts "${VOCAB[m.top]}" next with ${(m.probs[m.top] * 100).toFixed(1)}%.`,
    `I selected: ${d.title} = ${d.valueText}.`,
    `It was computed as: ${d.formula}. Inputs: ${terms}.`,
    `Explain in plain words what this number means, why it came out this way, and how it feeds into the next-word prediction.`,
  ].join("\n");
}

async function askRosalena() {
  const status = $("#ask-status");
  const text = questionText();
  try {
    await Rosalena.chat.compose(text);
    status.textContent = "Question is in the chat box. Edit it, then send.";
    status.classList.remove("err");
  } catch (err) {
    status.textContent = `Could not reach the chat box: ${err && err.message ? err.message : err}`;
    status.classList.add("err");
  }
  return text;
}

// ------------------------------------------------------------------ storage

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}
async function saveNow() {
  clearTimeout(saveTimer);
  const value = { text: state.text, head: state.head, stage: state.stage };
  try {
    await Rosalena.storage.set("lab", value);
  } catch (_) {
    /* saving is a convenience; the lab works without it */
  }
  return value;
}
async function loadSaved() {
  try {
    const saved = await Rosalena.storage.get("lab");
    if (!saved || typeof saved !== "object") return;
    if (typeof saved.text === "string" && saved.text !== state.text) {
      const r = run(saved.text);
      if (r.ok) {
        state.text = r.words.join(" ");
        state.model = r;
        state.selected = { stage: "logit", w: r.top };
        state.token = r.T - 1;
      }
    }
    if (saved.head === 1) state.head = 1;
    if (Number.isInteger(saved.stage)) state.stage = Math.max(0, Math.min(STAGES.length - 1, saved.stage));
    $("#prompt-input").value = state.text;
    buildScene();
    renderAll();
  } catch (_) {
    /* nothing saved yet */
  }
}

// ------------------------------------------------------------------ panel rendering

function renderError() {
  const el = $("#prompt-error");
  el.hidden = !state.error;
  el.textContent = state.error;
}

function renderHud() {
  const s = STAGES[state.stage];
  $("#step-label").innerHTML = `<b>${state.stage + 1}</b> / ${STAGES.length} &nbsp;${esc(s.name)}`;
  $("#step-prev").disabled = state.stage === 0;
  $("#step-next").disabled = state.stage === STAGES.length - 1;
  $("#mode-explore").classList.toggle("on", !state.playing);
  $("#mode-play").classList.toggle("on", state.playing);
  $("#mode-play").innerHTML = state.playing ? "&#10074;&#10074; Pause" : "&#9654; Play";
  $("#head-0").classList.toggle("on", state.head === 0);
  $("#head-1").classList.toggle("on", state.head === 1);
  let note = s.note;
  if (s.key === "qkv" || s.key === "attn") note += ` Showing ${HEADS[state.head].name}, the ${HEADS[state.head].role}: ${HEADS[state.head].help}`;
  $("#stage-note").innerHTML = `<span class="t">Step ${state.stage + 1} · ${esc(s.name)}<span class="f">${s.full || s.html}</span></span>${esc(note)}`;
}

function renderPipeline() {
  const ol = $("#pipeline");
  ol.innerHTML = STAGES.map(
    (s, i) => `<li data-i="${i}" tabindex="0" class="${i === state.stage ? "active" : ""}" title="Fly to step ${i + 1}"><span class="n">${i + 1}</span><span class="name">${esc(s.name)}</span><span class="f">${s.html}</span></li>`,
  ).join("");
}

function renderPrediction() {
  const m = state.model;
  const top = m.ranked[0];
  $("#predict-context").textContent = `after "${m.words.join(" ")}"`;
  $("#predict-top").innerHTML = `<span class="word">${esc(top.word)}</span><span class="pct">${(top.p * 100).toFixed(1)}%</span>`;
  $("#predict-list").innerHTML = m.ranked
    .slice(0, 5)
    .map(
      (r, k) =>
        `<div class="predict-row${k === 0 ? " top" : ""}" data-w="${r.w}" tabindex="0" role="button" title="Inspect the logit for &quot;${esc(r.word)}&quot;"><span class="w">${esc(r.word)}</span><span class="bar"><i style="width:${(r.p * 100).toFixed(1)}%"></i></span><span class="p">${(r.p * 100).toFixed(1)}%</span></div>`,
    )
    .join("");
}

function renderInspector() {
  const body = $("#inspector-body");
  const ask = $("#ask");
  if (!state.selected) {
    body.innerHTML = `<div class="empty">Click any cube, cell or tower in the scene to see its exact value and the numbers that produced it.</div>`;
    $("#inspector-kind").textContent = "";
    ask.disabled = true;
    return;
  }
  const d = explain(state.model, state.selected);
  ask.disabled = false;
  $("#inspector-kind").textContent = `step ${REF_STAGE[state.selected.stage] + 1}: ${STAGES[REF_STAGE[state.selected.stage]].name}`;
  const sign = typeof d.value === "number" && state.selected.stage !== "token" ? (d.value < 0 ? "neg" : "pos") : "";
  const rows = d.terms.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === "number" ? fmt(v, 4) : v)}</td></tr>`).join("");
  body.innerHTML = `<div class="title">${esc(d.title)}</div><div class="value ${sign}" id="inspector-value">${esc(d.valueText)}</div><div class="formula">${esc(d.formula)}</div><table class="terms"><tbody>${rows}</tbody></table><p class="note">${esc(d.note)}</p>`;
}

function renderTokenVec() {
  const m = state.model;
  const t = Math.min(state.token, m.T - 1);
  $("#token-chips").innerHTML = m.words.map((w, i) => `<button type="button" data-t="${i}" class="${i === t ? "on" : ""}" title="Show the vectors for word ${i + 1}">${esc(w)}</button>`).join("");
  const rows = [
    ["x", m.x0[t], "embed", "Embed: E[id] + P[pos]"],
    ["x′", m.x1[t], "mix", "after attention (Mix)"],
    ["x″", m.x2[t], null, "after the FFN"],
  ];
  let html = `<span></span>${DIM_SHORT.map((n, d) => `<span class="dimh" title="dim ${d}: ${esc(DIM_HELP[d])}">${n}</span>`).join("")}`;
  for (const [label, vec, stage, help] of rows) {
    html += `<span class="lab" title="${esc(help)}">${label}</span>`;
    vec.forEach((v, d) => {
      const h = Math.min(100, (Math.abs(v) / 3.5) * 100);
      const col = v >= 0 ? "var(--pos)" : "var(--neg)";
      const inner = `<i style="height:${Math.max(h, 3).toFixed(0)}%;background:${col}"></i><span>${fmt(v, 2)}</span>`;
      const tip = `${label}[${DIMS[d]}] = ${fmt(v, 4)}`;
      html += stage ? `<button type="button" class="vec-cell" data-stage="${stage}" data-d="${d}" title="${esc(tip)}">${inner}</button>` : `<span class="vec-cell" title="${esc(tip)}">${inner}</span>`;
    });
  }
  html += `<span class="vec-note">"${esc(m.words[t])}" at position ${t}. Watch the ${t === m.T - 1 ? "place and rest dims grow: that final vector is what picks the next word" : "vector change as each layer adds to it"}.</span>`;
  $("#token-vec").innerHTML = html;
}

function renderLegend() {
  $("#dim-list").innerHTML = DIMS.map((n, d) => `<dt>${d} ${esc(n)}</dt><dd>${esc(DIM_HELP[d])}</dd>`).join("");
}

function renderVocab() {
  $("#vocab-chips").innerHTML = VOCAB.map((w) => `<button type="button" class="chip" data-word="${esc(w)}" title="Add &quot;${esc(w)}&quot; to the sentence">${esc(w)}</button>`).join("");
}

function renderAll() {
  renderHud();
  renderPipeline();
  renderPrediction();
  renderInspector();
  renderTokenVec();
}

// ------------------------------------------------------------------ wiring

function wireUi() {
  const input = $("#prompt-input");
  input.value = state.text;
  $("#prompt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    setPrompt(input.value);
  });
  input.addEventListener("input", () => input.classList.remove("invalid"));
  $("#prompt-reset").addEventListener("click", () => setPrompt(DEFAULT_PROMPT));
  $("#prompt-back").addEventListener("click", () => {
    const words = state.text.split(" ");
    if (words.length > 1) setPrompt(words.slice(0, -1).join(" "));
  });
  $("#vocab-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-word]");
    if (!b) return;
    const base = state.error ? state.text : input.value.trim() || state.text;
    const r = setPrompt(`${base} ${b.dataset.word}`);
    if (!r.ok) input.value = `${base} ${b.dataset.word}`;
  });
  $("#mode-explore").addEventListener("click", () => {
    if (state.playing) stopPlay();
  });
  $("#mode-play").addEventListener("click", () => play());
  $("#step-prev").addEventListener("click", () => {
    if (state.playing) stopPlay();
    prevStage();
  });
  $("#step-next").addEventListener("click", () => {
    if (state.playing) stopPlay();
    nextStage();
  });
  $("#head-0").addEventListener("click", () => setHead(0));
  $("#head-1").addEventListener("click", () => setHead(1));
  $("#reset-view").addEventListener("click", () => resetView());
  $("#ask").addEventListener("click", () => askRosalena());

  const activate = (el, fn) => {
    el.addEventListener("click", fn);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn(e);
      }
    });
  };
  activate($("#pipeline"), (e) => {
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    if (state.playing) stopPlay();
    setStage(Number(li.dataset.i));
  });
  activate($("#predict-list"), (e) => {
    const row = e.target.closest("[data-w]");
    if (!row) return;
    select({ stage: "logit", w: Number(row.dataset.w) });
  });
  $("#token-chips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-t]");
    if (!b) return;
    state.token = Number(b.dataset.t);
    renderTokenVec();
  });
  $("#token-vec").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-stage]");
    if (!b) return;
    select({ stage: b.dataset.stage, t: state.token, d: Number(b.dataset.d) });
  });

  window.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (state.playing) stopPlay();
      nextStage();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (state.playing) stopPlay();
      prevStage();
    } else if (e.key === "r" || e.key === "R") {
      resetView();
    } else if (e.key === " " && tag !== "BUTTON") {
      e.preventDefault();
      play();
    } else if (e.key === "1" || e.key === "2") {
      setHead(e.key === "2" ? 1 : 0);
    }
  });
}

// ------------------------------------------------------------------ self-tests

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

Rosalena.test("softmax rows sum to 1", () => {
  const m = state.model;
  for (const hd of m.heads)
    for (const row of hd.A) {
      const s = row.reduce((a, b) => a + b, 0);
      Rosalena.assert(close(s, 1, 1e-9), `an attention row sums to ${s}`);
      Rosalena.assert(row.every((v) => v >= 0 && v <= 1), "attention weights must be in [0, 1]");
    }
  const ps = m.probs.reduce((a, b) => a + b, 0);
  Rosalena.assert(close(ps, 1, 1e-9), `next-word probabilities sum to ${ps}`);
  const s2 = softmax([1, 2, 3, -Infinity]);
  Rosalena.assert(close(s2.reduce((a, b) => a + b, 0), 1) && s2[3] === 0, "softmax of a small vector is wrong");
  Rosalena.assert(close(s2[2] / s2[1], Math.E, 1e-9), "softmax ratio should be e for logits one apart");
});

Rosalena.test("causal mask zeroes future positions", () => {
  const m = state.model;
  for (const hd of m.heads)
    for (let i = 0; i < m.T; i++)
      for (let j = 0; j < m.T; j++) {
        if (j > i) {
          Rosalena.assert(hd.scores[i][j] === -Infinity, `score [${i}][${j}] should be masked`);
          Rosalena.assert(hd.A[i][j] === 0, `future weight A[${i}][${j}] is ${hd.A[i][j]}, not 0`);
        } else Rosalena.assert(hd.A[i][j] > 0, `past weight A[${i}][${j}] should be positive`);
      }
  Rosalena.assert(close(m.heads[0].A[0][0], 1), "the first word can only attend to itself");
  if (renderer) {
    const cell = cellMap.get(refKey({ stage: "attn", head: state.head, i: 0, j: 1 }));
    Rosalena.assert(cell && cell.material.color.equals(COL.mask), "masked cells should be drawn dark red");
  }
});

Rosalena.test('default prompt predicts "mat"', () => {
  const r = run(DEFAULT_PROMPT);
  Rosalena.assert(r.ok, "the default prompt should tokenize");
  Rosalena.assert(VOCAB[r.top] === "mat", `top prediction is "${VOCAB[r.top]}"`);
  Rosalena.assert(r.ranked[0].p > 0.4 && r.ranked[0].p < 0.95, `"mat" should be likely but not certain (${r.ranked[0].p})`);
  Rosalena.assert(["sofa", "floor"].includes(r.ranked[1].word), `runner-up should be another resting place, got "${r.ranked[1].word}"`);
  Rosalena.assert(VOCAB[state.model.top] === "mat", "the lab should open on the default prompt");
  Rosalena.assert($("#predict-top .word").textContent === "mat", "the prediction card should show mat");
});

Rosalena.test("changing the input changes the logits", () => {
  const before = state.model.logits.slice();
  const r = setPrompt("the dog ran under the");
  Rosalena.assert(r.ok, `setPrompt failed: ${r.error}`);
  const after = state.model.logits;
  const diff = Math.max(...after.map((v, i) => Math.abs(v - before[i])));
  Rosalena.assert(diff > 0.5, `logits barely changed (max diff ${diff})`);
  Rosalena.assert(VOCAB[state.model.top] === "table", `"the dog ran under the" should predict table, got ${VOCAB[state.model.top]}`);
  Rosalena.assert(!renderer || cellMap.has(refKey({ stage: "logit", w: state.model.top })), "the scene should be rebuilt for the new prompt");
  setPrompt(DEFAULT_PROMPT);
  Rosalena.assert(state.model.logits.every((v, i) => close(v, before[i], 1e-12)), "going back should give the same logits (the model is deterministic)");
});

Rosalena.test("unknown words are rejected with a message", () => {
  const r = setPrompt("the cat sat on the hat");
  Rosalena.assert(!r.ok, "an unknown word should be rejected");
  const msg = $("#prompt-error");
  Rosalena.assert(!msg.hidden && /"hat"/.test(msg.textContent), `the error message should name the word: ${msg.textContent}`);
  Rosalena.assert(state.model.words.join(" ") === DEFAULT_PROMPT, "a rejected sentence must not replace the model's input");
  Rosalena.assert(!setPrompt("the the the the the the the the the").ok, "more than 8 words should be rejected");
  Rosalena.assert(setPrompt(DEFAULT_PROMPT).ok && msg.hidden, "a valid sentence should clear the message");
});

Rosalena.test("stepping moves the active stage", () => {
  setStage(0, { instant: true });
  Rosalena.assert(nextStage() === 1, "next should go to stage 2");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  Rosalena.assert(state.stage === 2, `ArrowRight should step forward (stage ${state.stage})`);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
  Rosalena.assert(state.stage === 1, "ArrowLeft should step back");
  Rosalena.assert(prevStage() === 0 && prevStage() === 0, "stepping back from the first stage stays there");
  setStage(99, { instant: true });
  Rosalena.assert(state.stage === STAGES.length - 1, "stepping clamps to the last stage");
  Rosalena.assert($("#pipeline li.active").dataset.i === String(STAGES.length - 1), "the pipeline list should mark the active step");
  if (renderer) Rosalena.assert(layout.stages[state.stage].outline.material.color.equals(COL.frameOn), "the active stage frame should light up");
});

Rosalena.test("inspecting a cell returns the computed number", () => {
  const m = state.model;
  setHead(0);
  setStage(STAGE_INDEX.attn, { instant: true });
  const ref = { stage: "attn", head: 0, i: 4, j: 3 };
  const expected = m.heads[0].A[4][3];
  Rosalena.assert(expected > 0.5, `head 1 should attend from the last "the" to "on" (${expected})`);
  if (renderer) {
    const mesh = cellMap.get(refKey(ref));
    Rosalena.assert(mesh, "the attention cell for (the, on) should exist");
    const d = inspectObject(mesh);
    Rosalena.assert(d.value === expected, `inspector says ${d.value}, the model says ${expected}`);
    Rosalena.assert($("#inspector-value").textContent.startsWith(fmt(expected, 4)), "the inspector panel should show the value");
    // Click through the real raycaster: project the cell's middle to the screen and pick there.
    renderNow();
    const p = new THREE.Vector3();
    mesh.getWorldPosition(p);
    p.y += mesh.userData.h / 2;
    p.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    const hit = pickAt(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
    Rosalena.assert(hit, "a ray through the cell should hit something");
    const dh = inspectObject(hit);
    Rosalena.assert(dh.value === valueOf(m, hit.userData.ref), "a picked cell should report its own model value");
    Rosalena.assert(hit === mesh, `the ray should hit the (the, on) cell, hit ${refKey(hit.userData.ref)}`);
  } else {
    Rosalena.assert(select(ref).value === expected, "select should report the model value");
  }
  const e = select({ stage: "embed", t: 1, d: 1 });
  Rosalena.assert(close(e.value, m.emb[1][1] + m.pos[1][1]), "an embedding cell should equal E[id] + P[pos]");
  const f = select({ stage: "ffn", t: 4, n: 0 });
  Rosalena.assert(close(f.value, Math.max(0, m.pre[4][0])) && f.value > 0, "the next:place unit should fire on the last word");
  const l = select({ stage: "logit", w: m.top });
  Rosalena.assert(l.value === m.probs[m.top], "the top tower should report its probability");
  const raw = select({ stage: "logit", w: m.top, raw: true });
  Rosalena.assert(raw.value === m.logits[m.top] && raw.value === Math.max(...m.logits), "the top word should have the biggest raw score");
  if (renderer) Rosalena.assert(cellMap.has(refKey({ stage: "logit", w: m.top, raw: true })), "the raw score row should be drawn");
});

Rosalena.test("head selector switches the attention pattern", () => {
  const m = state.model;
  Rosalena.assert(setHead(1) === 1, "should switch to head 2");
  if (renderer) {
    const mesh = cellMap.get(refKey({ stage: "attn", head: 1, i: 4, j: 2 }));
    Rosalena.assert(mesh && valueOf(m, mesh.userData.ref) === m.heads[1].A[4][2], "head 2 cells should be drawn");
    Rosalena.assert(!cellMap.has(refKey({ stage: "attn", head: 0, i: 4, j: 2 })), "head 1 cells should be gone");
  }
  Rosalena.assert(m.heads[1].A[4][2] > 0.5, 'head 2 (verb finder) should look at "sat"');
  Rosalena.assert(setHead(0) === 0, "should switch back to head 1");
});

Rosalena.test("Ask Rosalena composes a question about the selection", async () => {
  select({ stage: "attn", head: 0, i: 4, j: 3 });
  const text = await askRosalena();
  Rosalena.assert(text.includes(fmt(state.model.heads[0].A[4][3], 4)), "the question should quote the value");
  Rosalena.assert(text.includes("the cat sat on the"), "the question should quote the prompt");
  Rosalena.assert(!$("#ask-status").classList.contains("err"), $("#ask-status").textContent);
});

Rosalena.test("settings survive a reload", async () => {
  const saved = await saveNow();
  const back = await Rosalena.storage.get("lab");
  Rosalena.assert(back && back.text === saved.text && back.head === saved.head && back.stage === saved.stage, `storage round trip failed: ${JSON.stringify(back)}`);
});

Rosalena.test("renderer produced a non-empty frame", () => {
  Rosalena.assert(renderer, glError || "no renderer");
  renderNow();
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  renderer.setRenderTarget(null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const hex = COL.bg.getHex(THREE.SRGBColorSpace);
  const bgRgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  let lit = 0;
  let sampled = 0;
  const colours = new Set();
  for (let i = 0; i < px.length; i += 4 * 7) {
    sampled++;
    if (Math.abs(px[i] - bgRgb[0]) + Math.abs(px[i + 1] - bgRgb[1]) + Math.abs(px[i + 2] - bgRgb[2]) > 40) lit++;
    colours.add((px[i] >> 4) * 256 + (px[i + 1] >> 4) * 16 + (px[i + 2] >> 4));
  }
  const share = lit / sampled;
  Rosalena.assert(share > 0.02, `only ${(share * 100).toFixed(2)}% of the frame differs from the background`);
  Rosalena.assert(colours.size > 25, `the frame has only ${colours.size} colours`);
});

Rosalena.test("Play walks the pipeline and Pause stops it", () => {
  play();
  Rosalena.assert(state.playing && state.stage === 0, "Play should start at step 1");
  Rosalena.assert($("#mode-play").classList.contains("on"), "the Play button should show it is playing");
  stopPlay();
  Rosalena.assert(!state.playing && !$("#mode-play").classList.contains("on"), "Pause should stop the walkthrough");
  for (const mesh of stageCells[0]) Rosalena.assert(mesh.scale.y === mesh.userData.h, "stopping should leave every cell at full height");
});

Rosalena.test("reset returns to the overview", async () => {
  setStage(STAGE_INDEX.attn, { instant: true });
  if (renderer) {
    resetView({ instant: true });
    const v = overview();
    Rosalena.assert(camera.position.distanceTo(v.pos) < 1e-6 && controls.target.distanceTo(v.target) < 1e-6, "the camera should be at the overview");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }));
    Rosalena.assert(camera.position.distanceTo(v.pos) < 0.5, "R should reset the camera");
    home();
    Rosalena.assert(state.stage === 0 && camera.position.distanceTo(overview().pos) < 1e-6, "home should show step 1 from the overview");
    // let the compositor take the new frame (a hidden window may otherwise keep an old one)
    const w = view.clientWidth;
    const h = view.clientHeight;
    renderer.setSize(w - 1, h, true);
    renderer.setSize(w, h, true);
    renderNow();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    renderNow();
  }
});

// ------------------------------------------------------------------ start

renderVocab();
renderLegend();
wireUi();
if (!initThree()) {
  const fb = $("#gl-fallback");
  fb.hidden = false;
  fb.textContent = glError;
}
state.selected = { stage: "logit", w: state.model.top };
state.token = state.model.T - 1;
buildScene();
renderAll();
if (renderer) {
  flyTo(overview(), { instant: true });
  startLoop();
}
Rosalena.ready();
loadSaved();
