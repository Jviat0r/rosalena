// Fuyu: a cozy voxel island sandbox. The world lives in world.js (pure data); this file
// draws it with three.js (one InstancedMesh per block type, only the blocks with an open
// face), runs the day and night sky, handles building, undo, saving and the HUD.

import * as THREE from "/plugin-lib/three/three.module.js";
import { OrbitControls } from "/plugin-lib/three/OrbitControls.js";
import * as W from "./world.js";
import { paintTextures, drawCubeIcon } from "./textures.js";

const $ = (id) => document.getElementById(id);
const { N, H, SEA, AIR, FLOWER } = W;
const HALF = N / 2;
const NN = N * N;

const FIRST_SEED = 20261103; // the island a first visit starts on
const SAVE_KEY = "island";
const TIME_PRESETS = { day: 0.42, dusk: 0.738, night: 0.97 };
const DAY_SECONDS = 240; // one full day when time runs on its own

const state = {
  seed: FIRST_SEED,
  name: "",
  blocks: new Uint8Array(W.VOLUME),
  builds: 0,
  placed: 0,
  slot: 0,
  t: TIME_PRESETS.dusk,
  mode: "dusk",
  auto: false,
  undo: [],
  redo: [],
  savedAt: 0,
  unsaved: false,
  shift: false,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- HUD helpers

let toastTimer = null;
function toast(text, kind = "") {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

function clockText(t) {
  const minutes = Math.floor(((t % 1) + 1) % 1 * 24 * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function partOfDay(t) {
  const h = (((t % 1) + 1) % 1) * 24;
  if (h >= 5 && h < 7.5) return "Dawn";
  if (h >= 7.5 && h < 12) return "Morning";
  if (h >= 12 && h < 16.5) return "Afternoon";
  if (h >= 16.5 && h < 19.5) return "Dusk";
  return "Night";
}

function savedText() {
  if (!state.savedAt) return state.unsaved ? "Not saved yet" : "New island";
  if (state.unsaved) return "Saving soon...";
  const s = Math.round((Date.now() - state.savedAt) / 1000);
  if (s < 10) return "Saved just now";
  if (s < 60) return `Saved ${s} s ago`;
  return `Saved ${Math.round(s / 60)} min ago`;
}

function updateHud() {
  $("islandName").textContent = state.name;
  $("seedText").textContent = String(state.seed);
  $("statBlocks").textContent = fmt(W.countBlocks(state.blocks));
  $("statPlaced").textContent = fmt(state.placed);
  $("statBuilds").textContent = fmt(state.builds);
  $("btnUndo").disabled = state.undo.length === 0;
  $("btnRedo").disabled = state.redo.length === 0;
  updateClock();
  $("saveState").textContent = savedText();
}

function updateClock() {
  $("clock").textContent = clockText(state.t);
  $("partOfDay").textContent = partOfDay(state.t);
  for (const b of document.querySelectorAll("[data-time]")) {
    const on = !state.auto && b.dataset.time === state.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  const auto = $("autoTime");
  auto.classList.toggle("on", state.auto);
  auto.setAttribute("aria-pressed", String(state.auto));
}

// ---------------------------------------------------------------- theme

const THEME_VARS = { bg: "--bg", panel: "--panel", text: "--text", dim: "--dim", accent: "--accent", line: "--line", "btn-ink": "--btn-ink", ok: "--ok", warn: "--warn", bad: "--bad" };
function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  const colours = theme.colors || {};
  for (const [key, cssVar] of Object.entries(THEME_VARS)) {
    if (typeof colours[key] === "string" && colours[key]) root.style.setProperty(cssVar, colours[key]);
  }
  if (typeof theme.sans === "string" && theme.sans) root.style.setProperty("--sans", theme.sans);
  root.dataset.mode = theme.mode === "light" ? "light" : "dark";
}

// ---------------------------------------------------------------- three.js scene

let renderer = null;
let scene;
let camera;
let controls;
let three = null; // everything the scene needs, once the renderer exists
const shadowsWanted = true;

function initRenderer() {
  const stage = $("stage");
  if (typeof WebGLRenderingContext === "undefined" && typeof WebGL2RenderingContext === "undefined") throw new Error("this browser has no WebGL");
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(stage.clientWidth || 1280, stage.clientHeight || 800);
  renderer.shadowMap.enabled = shadowsWanted;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  stage.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, (stage.clientWidth || 1280) / (stage.clientHeight || 800), 0.5, 1500);
  const target = new THREE.Vector3(0, SEA + 1, 0);
  const spherical = new THREE.Spherical(70, THREE.MathUtils.degToRad(60), THREE.MathUtils.degToRad(45));
  camera.position.setFromSpherical(spherical).add(target);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 22;
  controls.maxDistance = 150;
  controls.minPolarAngle = THREE.MathUtils.degToRad(12);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(76);
  controls.zoomSpeed = 0.8;
  controls.rotateSpeed = 0.6;
  controls.panSpeed = 0.7;
  controls.addEventListener("change", () => {
    // Keep the view on the island and the camera above the sea.
    controls.target.x = clamp(controls.target.x, -HALF + 4, HALF - 4);
    controls.target.z = clamp(controls.target.z, -HALF + 4, HALF - 4);
    controls.target.y = clamp(controls.target.y, SEA, SEA + 10);
    if (camera.position.y < SEA + 3) camera.position.y = SEA + 3;
    hoverDirty = true;
  });
  controls.update();

  const tex = paintTextures();
  const maps = {};
  for (const [k, canvas] of Object.entries(tex)) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    maps[k] = t;
  }
  const lam = (opts) => new THREE.MeshLambertMaterial(opts);
  const sides = (side, top, bottom) => {
    const s = lam({ map: side });
    return [s, s, lam({ map: top }), lam({ map: bottom }), s, s];
  };
  const lanternMat = lam({ map: maps.lantern, emissive: 0xffffff, emissiveMap: maps.lantern, emissiveIntensity: 0.3 });
  const mats = {
    [W.GRASS]: sides(maps.grassSide, maps.grassTop, maps.dirt),
    [W.DIRT]: lam({ map: maps.dirt }),
    [W.STONE]: lam({ map: maps.stone }),
    [W.SAND]: lam({ map: maps.sand }),
    [W.WOOD]: sides(maps.bark, maps.woodTop, maps.woodTop),
    [W.PLANKS]: lam({ map: maps.planks }),
    [W.LEAVES]: lam({ map: maps.leaves, alphaTest: 0.5, side: THREE.DoubleSide }),
    [W.GLASS]: lam({ map: maps.glass, transparent: true, depthWrite: false, side: THREE.DoubleSide, emissive: 0xffc06a, emissiveIntensity: 0 }),
    [W.LANTERN]: lanternMat,
    [W.ROOF]: lam({ map: maps.roof }),
    [W.SNOW]: sides(maps.snowSide, maps.snow, maps.stone),
  };
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const lanternGeo = new THREE.BoxGeometry(0.7, 0.84, 0.7);
  const stemGeo = new THREE.BoxGeometry(0.08, 0.42, 0.08).translate(0, -0.29, 0);
  const headGeo = new THREE.BoxGeometry(0.26, 0.2, 0.26).translate(0, -0.04, 0);

  const layers = [];
  for (let t = 1; t < W.TYPE_COUNT; t++) {
    if (t === FLOWER) continue;
    layers.push(new Layer(t, t === W.LANTERN ? lanternGeo : cube, mats[t], { cast: t !== W.GLASS, receive: true, order: t === W.GLASS ? 2 : 0 }));
  }
  const stems = new Layer(FLOWER, stemGeo, lam({ color: 0x4f9a45 }), { cast: false, receive: true });
  const heads = new Layer(FLOWER, headGeo, lam({ color: 0xffffff }), { cast: false, receive: true });

  // Lights.
  const hemi = new THREE.HemisphereLight(0xdff1ff, 0x7a6a4a, 1.4);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  sun.castShadow = shadowsWanted;
  sun.shadow.mapSize.set(1024, 1024);
  const sc = sun.shadow.camera;
  sc.left = -34;
  sc.right = 34;
  sc.top = 34;
  sc.bottom = -34;
  sc.near = 1;
  sc.far = 180;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);
  sun.target.position.set(0, SEA, 0);
  const moon = new THREE.DirectionalLight(0x9fb6ff, 0);
  scene.add(moon, moon.target);
  moon.target.position.set(0, SEA, 0);
  const lamps = [];
  for (let i = 0; i < 4; i++) {
    const p = new THREE.PointLight(0xffb35c, 0, 15, 1.2);
    p.position.set(0, -50, 0);
    scene.add(p);
    lamps.push(p);
  }

  // Sky: a screen-space gradient, sun and moon sprites, stars.
  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 4;
  skyCanvas.height = 256;
  const skyTex = new THREE.CanvasTexture(skyCanvas);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTex;

  const glow = (inner, outer, core) => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(core, inner);
    grad.addColorStop(core + 0.04, outer);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow("rgba(255,247,222,1)", "rgba(255,190,110,0.45)", 0.16), transparent: true, depthWrite: false, fog: false }));
  sunSprite.scale.setScalar(70);
  const moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow("rgba(240,245,255,1)", "rgba(150,175,255,0.28)", 0.13), transparent: true, depthWrite: false, fog: false }));
  moonSprite.scale.setScalar(48);
  scene.add(sunSprite, moonSprite);

  const starCount = 900;
  const starPos = new Float32Array(starCount * 3);
  const starCol = new Float32Array(starCount * 3);
  const srnd = W.mulberry32(4242);
  for (let i = 0; i < starCount; i++) {
    const u = srnd() * 2 - 1;
    const a = srnd() * Math.PI * 2;
    const y = -0.55 + (u + 1) * 0.775; // most of the sphere, a little below the horizon too
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    starPos.set([Math.cos(a) * r * 520, y * 520, Math.sin(a) * r * 520], i * 3);
    const warm = srnd();
    const b = 0.6 + srnd() * 0.4;
    starCol.set([b * (0.85 + warm * 0.15), b * 0.9, b * (1 - warm * 0.2)], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starCol, 3));
  const starMat = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -1;
  scene.add(stars);

  // Water: one animated, flat-shaded sheet; vertex colours for depth and shore foam, and
  // a soft rim so the island floats in its own little pool.
  const size = 104;
  const waterGeo = new THREE.PlaneGeometry(size, size, size, size);
  waterGeo.rotateX(-Math.PI / 2);
  const wpos = waterGeo.attributes.position;
  const waterColours = new Float32Array(wpos.count * 4);
  waterGeo.setAttribute("color", new THREE.BufferAttribute(waterColours, 4));
  const waterMat = new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, shininess: 70, specular: 0x9cc8e6, flatShading: true, depthWrite: false });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.receiveShadow = true;
  water.renderOrder = 1;
  scene.add(water);
  const waterBase = new Float32Array(wpos.count * 2);
  for (let i = 0; i < wpos.count; i++) {
    waterBase[i * 2] = wpos.getX(i);
    waterBase[i * 2 + 1] = wpos.getZ(i);
  }

  // The sea floor beyond the grid, so the deep water reads the same all the way to the rim.
  const floorGeo = new THREE.RingGeometry(0.01, 53, 72, 14);
  floorGeo.rotateX(-Math.PI / 2);
  const fpos = floorGeo.attributes.position;
  const floorCol = new Float32Array(fpos.count * 4);
  const sandDeep = new THREE.Color("#efdca4").multiplyScalar(0.97).lerp(DEEP_TINT, 0.7);
  for (let i = 0; i < fpos.count; i++) {
    const r = Math.hypot(fpos.getX(i), fpos.getZ(i));
    floorCol.set([sandDeep.r, sandDeep.g, sandDeep.b, 1 - smooth(40, 52, r)], i * 4);
  }
  floorGeo.setAttribute("color", new THREE.BufferAttribute(floorCol, 4));
  const seaFloor = new THREE.Mesh(floorGeo, lam({ vertexColors: true, transparent: true, depthWrite: false }));
  seaFloor.position.y = 1.96;
  seaFloor.receiveShadow = true;
  seaFloor.renderOrder = 0;
  scene.add(seaFloor);

  // Clouds: blocky puffs circling out by the rim. They part where the camera looks in, so
  // they frame the island instead of hiding it.
  const crnd = W.mulberry32(777);
  const clouds = [];
  let puffCount = 0;
  for (let c = 0; c < 9; c++) {
    const puffs = [];
    const n = 3 + Math.floor(crnd() * 5);
    for (let p = 0; p < n; p++) {
      puffs.push({
        x: Math.round((crnd() - 0.5) * 6),
        y: Math.round(crnd() * 2) * 0.5,
        z: Math.round((crnd() - 0.5) * 4),
        sx: 1.5 + Math.round(crnd() * 3) * 0.5,
        sy: 0.8 + Math.round(crnd()) * 0.4,
        sz: 1.5 + Math.round(crnd() * 2) * 0.5,
      });
    }
    puffCount += n;
    clouds.push({ a: (c / 9) * Math.PI * 2 + crnd() * 0.5, d: 40 + crnd() * 14, y: 13 + crnd() * 8, speed: 0.012 + crnd() * 0.01, puffs });
  }
  const cloudMesh = new THREE.InstancedMesh(cube, lam({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.12 }), puffCount);
  cloudMesh.frustumCulled = false;
  scene.add(cloudMesh);

  // Fireflies, out at night.
  const flyCount = 46;
  const flyGeo = new THREE.BufferGeometry();
  const flyPos = new Float32Array(flyCount * 3);
  flyGeo.setAttribute("position", new THREE.BufferAttribute(flyPos, 3));
  const flyMat = new THREE.PointsMaterial({ size: 0.45, color: 0xf6f58a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const flies = new THREE.Points(flyGeo, flyMat);
  flies.frustumCulled = false;
  scene.add(flies);

  // Ghost preview and a little pop when a block lands.
  const ghostFill = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1.0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false }));
  const ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }));
  const ghost = new THREE.Group();
  ghost.add(ghostFill, ghostEdges);
  ghost.visible = false;
  ghost.renderOrder = 3;
  scene.add(ghost);
  const pop = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }));
  pop.visible = false;
  scene.add(pop);

  three = { layers, stems, heads, hemi, sun, moon, lamps, lanternMat, glassMat: mats[W.GLASS], skyCanvas, skyTex, sunSprite, moonSprite, starMat, water, waterGeo, waterColours, waterBase, clouds, cloudMesh, flies, flyPos, flyMat, flyBase: new Float32Array(flyCount * 3), ghost, ghostFill, ghostEdges, pop, popAt: -1, lastSkyT: -1, shadowAt: 0, maps };

  new ResizeObserver(resize).observe(stage);
}

/** One block type's InstancedMesh, grown when it runs out of room. */
class Layer {
  constructor(type, geometry, material, { cast = true, receive = true, order = 0 } = {}) {
    Object.assign(this, { type, geometry, material, cast, receive, order, mesh: null, capacity: 0 });
    this.ensure(64);
  }
  ensure(n) {
    if (n <= this.capacity) return;
    if (this.mesh) {
      scene.remove(this.mesh);
      this.mesh.dispose();
    }
    this.capacity = Math.ceil(n * 1.4) + 32;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
    mesh.castShadow = this.cast;
    mesh.receiveShadow = this.receive;
    mesh.frustumCulled = false;
    mesh.renderOrder = this.order;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.count = 0;
    scene.add(mesh);
    this.mesh = mesh;
  }
}

function resize() {
  if (!renderer) return;
  const stage = $("stage");
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderNow();
}

const FLOWER_COLOURS = ["#ff8fb1", "#ffd166", "#f7f4ff", "#c59bff", "#ff7a6b", "#8fd3ff"].map((c) => new THREE.Color(c));
const DEEP_TINT = new THREE.Color("#3b7d9e");

/** Rebuild every instance list from the grid: only blocks with an open face are drawn. */
function rebuildMeshes() {
  if (!three) return;
  const b = state.blocks;
  const op = W.OPAQUE;
  const lists = new Map();
  for (const layer of three.layers) lists.set(layer.type, []);
  const flowers = [];
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = (y * N + z) * N + x;
        const t = b[i];
        if (t === AIR) continue;
        const open =
          x === 0 || x === N - 1 || z === 0 || z === N - 1 || y === H - 1 ||
          !op[b[i - 1]] || !op[b[i + 1]] || !op[b[i - N]] || !op[b[i + N]] || !op[b[i + NN]] || (y > 0 && !op[b[i - NN]]);
        if (!open) continue;
        if (t === FLOWER) flowers.push(i);
        else lists.get(t)?.push(i);
      }
    }
  }
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const fill = (layer, cells, colourOf) => {
    layer.ensure(cells.length);
    const mesh = layer.mesh;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      const x = i % N;
      const z = Math.floor(i / N) % N;
      const y = Math.floor(i / NN);
      m.makeTranslation(x - HALF + 0.5, y + 0.5, z - HALF + 0.5);
      mesh.setMatrixAt(k, m);
      colourOf(c, x, y, z);
      mesh.setColorAt(k, c);
    }
    mesh.count = cells.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  };
  const jitter = (out, x, y, z) => {
    const j = 0.9 + W.hash3(x, y, z, 7) * 0.16;
    out.setRGB(j, j, j);
    if (y < SEA) out.lerp(DEEP_TINT, Math.min(0.75, 0.22 + (SEA - y) * 0.16));
  };
  for (const layer of three.layers) {
    const plain = layer.type === W.GLASS || layer.type === W.LANTERN;
    fill(layer, lists.get(layer.type), plain ? (out) => out.setRGB(1, 1, 1) : jitter);
  }
  fill(three.stems, flowers, (out) => out.setRGB(1, 1, 1));
  fill(three.heads, flowers, (out, x, y, z) => out.copy(FLOWER_COLOURS[Math.floor(W.hash3(x, y, z, 3) * FLOWER_COLOURS.length)]));
  placeLamps();
  renderer.shadowMap.needsUpdate = true;
}

/** Point lights follow up to four lanterns, spread out. */
function placeLamps() {
  const b = state.blocks;
  const found = [];
  for (let i = 0; i < b.length; i++) if (b[i] === W.LANTERN) found.push(W.coords(i));
  const chosen = [];
  for (const p of found) {
    if (chosen.length >= three.lamps.length) break;
    if (chosen.every((q) => Math.abs(q[0] - p[0]) + Math.abs(q[2] - p[2]) + Math.abs(q[1] - p[1]) > 4)) chosen.push(p);
  }
  three.lamps.forEach((lamp, k) => {
    const p = chosen[k];
    if (p) lamp.position.set(p[0] - HALF + 0.5, p[1] + 0.5, p[2] - HALF + 0.5);
    else lamp.position.set(0, -60, 0);
    lamp.userData.used = Boolean(p);
  });
  applyLighting();
}

/** Water colour per vertex: deep blue far out, turquoise over sand, white foam at the shore. */
function computeWaterColours() {
  if (!three) return;
  const tops = new Int16Array(NN);
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) tops[z * N + x] = W.topSolid(state.blocks, x, z);
  const deep = new THREE.Color("#1d6f9c");
  const shallow = new THREE.Color("#43c4c9");
  const foam = new THREE.Color("#eefcff");
  const col = new THREE.Color();
  const pos = three.waterGeo.attributes.position;
  const out = three.waterColours;
  for (let v = 0; v < pos.count; v++) {
    const vx = three.waterBase[v * 2];
    const vz = three.waterBase[v * 2 + 1];
    const gx = Math.round(vx + HALF);
    const gz = Math.round(vz + HALF);
    let depthSum = 0;
    let cells = 0;
    let shore = 9;
    for (let dz = -4; dz <= 3; dz++) {
      for (let dx = -4; dx <= 3; dx++) {
        const cx = gx + dx;
        const cz = gz + dz;
        if (cx < 0 || cz < 0 || cx >= N || cz >= N) continue;
        const top = tops[cz * N + cx];
        if (dx >= -1 && dx <= 0 && dz >= -1 && dz <= 0) {
          depthSum += Math.max(0, SEA - (top + 1));
          cells++;
        }
        if (top >= SEA) {
          const ddx = Math.max(cx - gx, 0, gx - (cx + 1));
          const ddz = Math.max(cz - gz, 0, gz - (cz + 1));
          shore = Math.min(shore, Math.hypot(ddx, ddz));
        }
      }
    }
    const depth = cells ? depthSum / cells : SEA - 2;
    const s = clamp(1 - depth / 3.2, 0, 1);
    col.copy(deep).lerp(shallow, s * s);
    const f = 1 - smooth(0, 1.7, shore);
    col.lerp(foam, f * 0.8);
    let alpha = 0.9 - s * 0.3 + f * 0.25;
    const r = Math.hypot(vx, vz);
    alpha *= 1 - smooth(40, 51, r);
    out[v * 4] = col.r;
    out[v * 4 + 1] = col.g;
    out[v * 4 + 2] = col.b;
    out[v * 4 + 3] = clamp(alpha, 0, 1);
  }
  three.waterGeo.attributes.color.needsUpdate = true;

  // Fireflies hover over grass.
  const rnd = W.mulberry32(state.seed + 99);
  const grassCells = [];
  for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) if (tops[z * N + x] >= SEA + 1 && state.blocks[W.index(x, tops[z * N + x], z)] === W.GRASS) grassCells.push([x, z, tops[z * N + x]]);
  for (let k = 0; k < three.flyBase.length / 3; k++) {
    const cell = grassCells.length ? grassCells[Math.floor(rnd() * grassCells.length)] : [HALF, HALF, SEA];
    three.flyBase.set([cell[0] - HALF + rnd(), cell[2] + 1.6 + rnd() * 2.2, cell[1] - HALF + rnd()], k * 3);
  }
}

function animateWater(time) {
  const pos = three.waterGeo.attributes.position;
  const arr = pos.array;
  const base = three.waterBase;
  const y0 = SEA - 0.2;
  for (let v = 0, n = pos.count; v < n; v++) {
    const x = base[v * 2];
    const z = base[v * 2 + 1];
    arr[v * 3 + 1] = y0 + 0.07 * (Math.sin(x * 0.55 + time * 1.25) + 0.8 * Math.sin(z * 0.7 - time * 0.95) + 0.35 * Math.sin((x - z) * 1.1 + time * 2.1));
  }
  pos.needsUpdate = true;
}

function animateClouds(time, dt) {
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  let k = 0;
  const camAz = Math.atan2(camera.position.z - controls.target.z, camera.position.x - controls.target.x);
  for (const c of three.clouds) {
    c.a = (c.a + c.speed * dt) % (Math.PI * 2);
    let diff = Math.abs(c.a - camAz) % (Math.PI * 2);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    const part = smooth(0.55, 1.15, diff);
    const cx = Math.cos(c.a) * c.d;
    const cz = Math.sin(c.a) * c.d;
    const bob = Math.sin(time * 0.3 + c.d) * 0.3;
    for (const puff of c.puffs) {
      p.set(cx + puff.x, c.y + puff.y + bob, cz + puff.z);
      s.set(puff.sx * part + 1e-4, puff.sy * part + 1e-4, puff.sz * part + 1e-4);
      m.compose(p, q, s);
      three.cloudMesh.setMatrixAt(k++, m);
    }
  }
  three.cloudMesh.instanceMatrix.needsUpdate = true;
}

function animateFlies(time) {
  if (three.flyMat.opacity <= 0.01) return;
  const b = three.flyBase;
  const out = three.flyPos;
  for (let k = 0; k < b.length; k += 3) {
    const ph = k * 1.7;
    out[k] = b[k] + Math.sin(time * 0.7 + ph) * 0.8;
    out[k + 1] = b[k + 1] + Math.sin(time * 1.3 + ph * 0.5) * 0.35;
    out[k + 2] = b[k + 2] + Math.cos(time * 0.6 + ph) * 0.8;
  }
  three.flies.geometry.attributes.position.needsUpdate = true;
  three.flyMat.size = 0.38 + 0.12 * Math.sin(time * 3);
}

// ---------------------------------------------------------------- day and night

const C = (hex) => new THREE.Color(hex);
const SKY = {
  top: { day: C("#5aaee6"), dusk: C("#4b4f93"), night: C("#08102b") },
  horizon: { day: C("#d4edf9"), dusk: C("#ffae7c"), night: C("#22315f") },
  hemiSky: { day: C("#e2f2ff"), dusk: C("#ffc49a"), night: C("#4a5d9a") },
  hemiGround: { day: C("#836f4c"), dusk: C("#6d4a5c"), night: C("#1c2440") },
};
const blend = (set, f, out) => out.copy(set.night).lerp(set.day, f.day).lerp(set.dusk, f.dusk * 0.85);

function timeFactors(t) {
  const ang = (t - 0.25) * Math.PI * 2;
  const e = Math.sin(ang);
  return {
    ang,
    e,
    day: smooth(-0.12, 0.35, e),
    dusk: Math.exp(-((e / 0.17) ** 2)),
    night: 1 - smooth(-0.28, 0.02, e),
  };
}

function hexOf(c) {
  return `#${c.getHexString()}`;
}

/** Light, sky, lanterns and stars for the current time of day. */
function applyLighting() {
  if (!three) return;
  const f = timeFactors(state.t);
  const sunAz = THREE.MathUtils.degToRad(35) + f.ang;
  const elev = f.e * THREE.MathUtils.degToRad(62);
  const dir = new THREE.Vector3(Math.cos(sunAz) * Math.cos(elev), Math.sin(elev), Math.sin(sunAz) * Math.cos(elev));
  const centre = new THREE.Vector3(0, SEA, 0);
  three.sun.position.copy(centre).addScaledVector(dir, 90);
  three.sun.intensity = 2.5 * smooth(-0.03, 0.22, f.e);
  three.sun.color.set("#ffc890").lerp(C("#fff6e8"), smooth(0.05, 0.5, f.e));
  three.moon.position.copy(centre).add(new THREE.Vector3(-dir.x, Math.max(0.5, -dir.y), -dir.z).normalize().multiplyScalar(90));
  three.moon.intensity = 1.05 * f.night;
  three.hemi.intensity = 0.75 + 0.75 * f.day + 0.2 * f.dusk;
  blend(SKY.hemiSky, f, three.hemi.color);
  blend(SKY.hemiGround, f, three.hemi.groundColor);

  const glowing = Math.max(f.night, f.dusk * 0.75);
  three.lanternMat.emissiveIntensity = 0.28 + 1.9 * glowing;
  for (const lamp of three.lamps) lamp.intensity = lamp.userData.used ? 26 * glowing : 0;
  three.glassMat.emissiveIntensity = 0.9 * glowing;
  three.starMat.opacity = f.night ** 1.5;
  three.flyMat.opacity = f.night * 0.95;

  // The sun and moon sprites sit just under the rim of the sky the camera can see.
  const spriteDir = (az, e) => new THREE.Vector3(Math.cos(az) * Math.cos(e), Math.sin(e), Math.sin(az) * Math.cos(e));
  three.sunSprite.position.copy(spriteDir(sunAz, f.e * 0.7 - 0.2)).multiplyScalar(560);
  three.sunSprite.material.opacity = smooth(-0.15, 0.05, f.e);
  three.moonSprite.position.copy(spriteDir(THREE.MathUtils.degToRad(212), -0.09)).multiplyScalar(560);
  three.moonSprite.material.opacity = f.night;

  if (Math.abs(three.lastSkyT - state.t) > 0.0015) {
    three.lastSkyT = state.t;
    const top = blend(SKY.top, f, new THREE.Color());
    const hor = blend(SKY.horizon, f, new THREE.Color());
    const g = three.skyCanvas.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, hexOf(top));
    grad.addColorStop(0.42, hexOf(hor));
    grad.addColorStop(1, hexOf(hor.clone().lerp(top, 0.25)));
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    three.skyTex.needsUpdate = true;
    document.documentElement.style.setProperty("--sky", hexOf(hor));
  }
  renderer.shadowMap.needsUpdate = true;
}

function setTimeMode(mode) {
  if (!(mode in TIME_PRESETS)) return;
  state.mode = mode;
  state.auto = false;
  state.t = TIME_PRESETS[mode];
  applyLighting();
  updateClock();
  scheduleSave();
  renderNow();
}

function setAutoTime(on) {
  state.auto = Boolean(on);
  updateClock();
  scheduleSave();
}

function lightingSnapshot() {
  if (!three) return null;
  return { sun: three.sun.intensity, moon: three.moon.intensity, hemi: three.hemi.intensity, lantern: three.lanternMat.emissiveIntensity, stars: three.starMat.opacity, lamp: Math.max(...three.lamps.map((l) => l.intensity)) };
}

// ---------------------------------------------------------------- editing and history

function worldChanged({ water = false } = {}) {
  rebuildMeshes();
  if (water) computeWaterColours();
  updateHud();
  hoverDirty = true;
  scheduleSave();
  renderNow();
}

/** Apply [[index, type]] as one undoable step. Returns how many cells changed. */
function commit(changes, counters = {}) {
  const cells = [];
  let low = false;
  for (const [i, after] of changes) {
    const before = state.blocks[i];
    if (before === after) continue;
    cells.push(i, before, after);
    state.blocks[i] = after;
    if (i < NN * (SEA + 1)) low = true;
  }
  if (!cells.length) return 0;
  state.undo.push({ cells, counters });
  if (state.undo.length > 300) state.undo.shift();
  state.redo.length = 0;
  bumpCounters(counters, 1);
  worldChanged({ water: low });
  return cells.length / 3;
}

function bumpCounters(counters, sign) {
  state.placed = Math.max(0, state.placed + sign * (counters.placed || 0));
  state.builds = Math.max(0, state.builds + sign * (counters.builds || 0));
}

function undo() {
  const step = state.undo.pop();
  if (!step) return false;
  let low = false;
  for (let k = step.cells.length - 3; k >= 0; k -= 3) {
    state.blocks[step.cells[k]] = step.cells[k + 1];
    if (step.cells[k] < NN * (SEA + 1)) low = true;
  }
  state.redo.push(step);
  bumpCounters(step.counters, -1);
  worldChanged({ water: low });
  return true;
}

function redo() {
  const step = state.redo.pop();
  if (!step) return false;
  let low = false;
  for (let k = 0; k < step.cells.length; k += 3) {
    state.blocks[step.cells[k]] = step.cells[k + 2];
    if (step.cells[k] < NN * (SEA + 1)) low = true;
  }
  state.undo.push(step);
  bumpCounters(step.counters, 1);
  worldChanged({ water: low });
  return true;
}

const raycaster = new THREE.Raycaster();
function pickAt(ndcX, ndcY) {
  if (!camera) return null;
  raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const o = raycaster.ray.origin;
  const d = raycaster.ray.direction;
  return W.raycast(state.blocks, o.x, o.y, o.z, d.x, d.y, d.z);
}

const selectedType = () => W.HOTBAR[state.slot];

/** What a click at this screen point would do: { kind: "place" | "remove", x, y, z } or null. */
function intentAt(ndcX, ndcY, remove) {
  const hit = pickAt(ndcX, ndcY);
  if (!hit) return null;
  if (remove) return { kind: "remove", x: hit.x, y: hit.y, z: hit.z, type: hit.type };
  const x = hit.x + hit.nx;
  const y = hit.y + hit.ny;
  const z = hit.z + hit.nz;
  if (!hit.nx && !hit.ny && !hit.nz) return null;
  if (!W.inBounds(x, y, z)) return { kind: "blocked", reason: y >= H ? "That's as high as Fuyu builds." : "That's the edge of the world." };
  const cur = state.blocks[W.index(x, y, z)];
  if (cur !== AIR) return { kind: "blocked", reason: "Something is already there." };
  return { kind: "place", x, y, z, type: selectedType() };
}

/** The click handler: place on the hovered face, or remove the hovered block. */
function clickAt(ndcX, ndcY, remove) {
  const intent = intentAt(ndcX, ndcY, remove);
  if (!intent) return { ok: false };
  if (intent.kind === "blocked") {
    toast(intent.reason);
    return { ok: false };
  }
  const i = W.index(intent.x, intent.y, intent.z);
  if (intent.kind === "remove") {
    if (intent.y === 0) {
      toast("That's the sea floor; it stays.");
      return { ok: false };
    }
    commit([[i, AIR]], {});
  } else {
    commit([[i, intent.type]], { placed: 1 });
  }
  popAt(intent.x, intent.y, intent.z, intent.kind === "remove");
  return { ok: true, ...intent };
}

function popAt(x, y, z, removed) {
  if (!three) return;
  three.pop.position.set(x - HALF + 0.5, y + 0.5, z - HALF + 0.5);
  three.pop.material.color.set(removed ? "#ffb4a8" : "#ffffff");
  three.pop.visible = true;
  three.popAt = performance.now();
}

function autoBuild({ quiet = false } = {}) {
  const kind = state.builds % 3 === 1 ? "pavilion" : "cottage";
  const plan = W.planAnyBuild(state.blocks, { kind, seed: state.seed * 31 + state.builds * 7919 + 1 });
  if (!plan.ok) {
    if (!quiet) toast(plan.reason, "warn");
    return plan;
  }
  commit(plan.changes, { builds: 1 });
  if (three) {
    const cx = plan.x0 + plan.W / 2 - HALF;
    const cz = plan.z0 + plan.D / 2 - HALF;
    focusOn(cx, plan.base + 3, cz);
  }
  if (!quiet) toast({ pavilion: "A little pavilion went up.", hut: "A tiny hut went up.", cottage: "A cottage went up. Cozy." }[plan.kind]);
  return plan;
}

let focus = null;
function focusOn(x, y, z) {
  focus = { to: new THREE.Vector3(clamp(x, -HALF + 4, HALF - 4), clamp(y, SEA, SEA + 10), clamp(z, -HALF + 4, HALF - 4)), until: performance.now() + 900 };
}

function setWorld({ seed, name, blocks }, { history = [], builds = 0, placed = 0 } = {}) {
  state.seed = seed >>> 0;
  state.name = name || W.islandName(state.seed);
  state.blocks = blocks;
  state.undo = history;
  state.redo = [];
  state.builds = builds;
  state.placed = placed;
  rebuildMeshes();
  computeWaterColours();
  updateHud();
  hoverDirty = true;
  renderNow();
}

function newIsland(seed = 1 + Math.floor(Math.random() * 999998)) {
  const world = W.generateWorld(seed);
  setWorld(world);
  state.unsaved = true;
  scheduleSave();
  toast(`Welcome to ${world.name}.`);
  return world;
}

// ---------------------------------------------------------------- saving

let saveTimer = null;
function serialize() {
  return { v: 1, grid: [N, H], seed: state.seed, name: state.name, builds: state.builds, placed: state.placed, t: state.t, mode: state.mode, auto: state.auto, slot: state.slot, data: W.encodeWorld(state.blocks) };
}

function scheduleSave() {
  state.unsaved = true;
  $("saveState").textContent = savedText();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow({ quiet: true }), 1200);
}

async function saveNow({ quiet = false } = {}) {
  clearTimeout(saveTimer);
  const data = serialize();
  try {
    await Rosalena.storage.set(SAVE_KEY, data);
    state.savedAt = Date.now();
    state.unsaved = false;
    if (!quiet) toast(`Saved ${state.name} (${Math.ceil(JSON.stringify(data).length / 1024)} KB).`);
    $("saveState").textContent = savedText();
    return true;
  } catch (err) {
    toast(`Couldn't save the island: ${err.message || err}`, "warn");
    return false;
  }
}

async function loadSaved({ quiet = false } = {}) {
  let data;
  try {
    data = await Rosalena.storage.get(SAVE_KEY);
  } catch (err) {
    if (!quiet) toast(`Couldn't read the saved island: ${err.message || err}`, "warn");
    return false;
  }
  if (!data || typeof data !== "object" || !data.data) {
    if (!quiet) toast("Nothing saved yet. Build a little and it saves itself.");
    return false;
  }
  try {
    if (!Array.isArray(data.grid) || data.grid[0] !== N || data.grid[1] !== H) throw new Error("it was made for a different world size");
    const blocks = W.decodeWorld(data.data);
    clearTimeout(saveTimer);
    setWorld({ seed: data.seed, name: data.name, blocks }, { builds: Number(data.builds) || 0, placed: Number(data.placed) || 0 });
    state.t = typeof data.t === "number" ? data.t : TIME_PRESETS.day;
    state.mode = data.mode in TIME_PRESETS ? data.mode : "day";
    state.auto = data.auto === true;
    selectSlot(Number(data.slot) || 0);
    applyLighting();
    state.savedAt = Date.now();
    state.unsaved = false;
    updateHud();
    renderNow();
    if (!quiet) toast(`Loaded ${state.name}.`);
    return true;
  } catch (err) {
    toast(`The saved island couldn't be opened: ${err.message || err}`, "warn");
    return false;
  }
}

// ---------------------------------------------------------------- export

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "island";

async function exportPng() {
  if (!renderer) {
    toast("There's no 3D view to capture on this machine.", "warn");
    return null;
  }
  const ghostWas = three.ghost.visible;
  three.ghost.visible = false;
  renderNow();
  const blob = await new Promise((resolve) => renderer.domElement.toBlob(resolve, "image/png"));
  three.ghost.visible = ghostWas;
  renderNow();
  if (!blob) {
    toast("Couldn't capture the view.", "warn");
    return null;
  }
  const name = `${slug(state.name)}-${clockText(state.t).replace(":", "")}.png`;
  try {
    const result = await Rosalena.files.save(name, blob, "image/png");
    toast(result && result.verifying ? `Captured ${name}` : `Saved ${name}`);
    return { blob, name, result };
  } catch (err) {
    toast(`Couldn't save the picture: ${err.message || err}`, "warn");
    return { blob, name, error: err };
  }
}

// ---------------------------------------------------------------- rendering

let hoverDirty = false;
let pointer = null; // { x, y } in NDC while over the canvas
let lastTime = performance.now();
let running = false;

function updateGhost() {
  if (!three) return;
  hoverDirty = false;
  const g = three.ghost;
  if (!pointer) {
    g.visible = false;
    return;
  }
  const intent = intentAt(pointer.x, pointer.y, state.shift);
  if (!intent || intent.kind === "blocked" || (intent.kind === "remove" && intent.y === 0)) {
    g.visible = false;
    renderer.domElement.style.cursor = "grab";
    return;
  }
  renderer.domElement.style.cursor = "crosshair";
  g.visible = true;
  g.position.set(intent.x - HALF + 0.5, intent.y + 0.5, intent.z - HALF + 0.5);
  if (intent.kind === "remove") {
    g.scale.setScalar(1.04);
    three.ghostFill.material.color.set("#ff6b6b");
    three.ghostFill.material.opacity = 0.2;
    three.ghostEdges.material.color.set("#ff8a80");
  } else {
    g.scale.setScalar(1);
    three.ghostFill.material.color.set(BLOCK_COLOURS[intent.type] || "#ffffff");
    three.ghostFill.material.opacity = 0.42;
    three.ghostEdges.material.color.set("#ffffff");
  }
}

function tick(dt, time) {
  if (state.auto) {
    state.t = (state.t + dt / DAY_SECONDS) % 1;
    const f = timeFactors(state.t);
    state.mode = f.night > 0.6 ? "night" : f.dusk > 0.5 ? "dusk" : "day";
    applyLighting();
    if (time - (tick.lastClock || 0) > 0.5) {
      tick.lastClock = time;
      updateClock();
    }
  }
  if (focus) {
    const k = 1 - Math.pow(0.002, dt);
    controls.target.lerp(focus.to, k);
    if (performance.now() > focus.until) focus = null;
  }
  controls.update();
  animateWater(time);
  animateClouds(time, dt);
  animateFlies(time);
  if (hoverDirty) updateGhost();
  if (three.pop.visible) {
    const p = (performance.now() - three.popAt) / 320;
    if (p >= 1) three.pop.visible = false;
    else {
      three.pop.scale.setScalar(1 + p * 0.35);
      three.pop.material.opacity = 0.9 * (1 - p);
    }
  }
}

function renderNow() {
  if (!renderer) return;
  if (!running) {
    animateWater(performance.now() / 1000);
    animateClouds(performance.now() / 1000, 0);
  }
  renderer.render(scene, camera);
}

function frame(now) {
  if (!running) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  tick(dt, now / 1000);
  renderer.render(scene, camera);
}

function startLoop() {
  if (running || !renderer || document.hidden) return;
  running = true;
  lastTime = performance.now();
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) running = false;
  else startLoop();
});

// ---------------------------------------------------------------- input and UI

const BLOCK_COLOURS = {
  [W.GRASS]: "#7cc35a",
  [W.DIRT]: "#9b6b43",
  [W.STONE]: "#a0a6ad",
  [W.SAND]: "#efdca4",
  [W.WOOD]: "#7a5232",
  [W.PLANKS]: "#c8955b",
  [W.LEAVES]: "#4f9a45",
  [W.GLASS]: "#cdecff",
  [W.LANTERN]: "#ffcf73",
  [W.ROOF]: "#c8573e",
};

function selectSlot(n) {
  state.slot = clamp(n | 0, 0, W.HOTBAR.length - 1);
  for (const [k, el] of [...$("hotbar").children].entries()) {
    el.classList.toggle("on", k === state.slot);
    el.setAttribute("aria-pressed", String(k === state.slot));
  }
  $("hotLabel").textContent = W.BLOCK_NAMES[selectedType()];
  hoverDirty = true;
}

function buildHotbar() {
  const tex = paintTextures();
  const faces = {
    [W.GRASS]: [tex.grassTop, tex.grassSide],
    [W.DIRT]: [tex.dirt, tex.dirt],
    [W.STONE]: [tex.stone, tex.stone],
    [W.SAND]: [tex.sand, tex.sand],
    [W.WOOD]: [tex.woodTop, tex.bark],
    [W.PLANKS]: [tex.planks, tex.planks],
    [W.LEAVES]: [tex.leaves, tex.leaves],
    [W.GLASS]: [tex.glass, tex.glass],
    [W.LANTERN]: [tex.lantern, tex.lantern],
    [W.ROOF]: [tex.roof, tex.roof],
  };
  const bar = $("hotbar");
  W.HOTBAR.forEach((type, k) => {
    const btn = document.createElement("button");
    btn.className = "slot";
    btn.type = "button";
    const key = k === 9 ? "0" : String(k + 1);
    btn.title = `${W.BLOCK_NAMES[type]} (${key})`;
    btn.setAttribute("aria-label", `${W.BLOCK_NAMES[type]}, key ${key}`);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const [top, side] = faces[type];
    drawCubeIcon(canvas, top, side, side);
    const badge = document.createElement("span");
    badge.className = "key";
    badge.textContent = key;
    btn.append(canvas, badge);
    btn.addEventListener("click", () => selectSlot(k));
    bar.appendChild(btn);
  });
  selectSlot(0);
}

function bindUi() {
  for (const b of document.querySelectorAll("[data-time]")) b.addEventListener("click", () => setTimeMode(b.dataset.time));
  $("autoTime").addEventListener("click", () => setAutoTime(!state.auto));
  $("btnBuild").addEventListener("click", () => autoBuild());
  $("btnNew").addEventListener("click", () => newIsland());
  $("btnUndo").addEventListener("click", () => undo() || toast("Nothing to undo."));
  $("btnRedo").addEventListener("click", () => redo() || toast("Nothing to redo."));
  $("btnSave").addEventListener("click", () => saveNow());
  $("btnLoad").addEventListener("click", () => loadSaved());
  $("btnShot").addEventListener("click", () => exportPng());
  $("helpClose").addEventListener("click", () => setHelp(false));
  $("helpOpen").addEventListener("click", () => setHelp(true));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") {
      state.shift = true;
      hoverDirty = true;
    }
    if (e.target instanceof HTMLInputElement) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    } else if (ctrl && k === "s") {
      e.preventDefault();
      saveNow();
    } else if (!ctrl && /^[0-9]$/.test(e.key)) {
      selectSlot(e.key === "0" ? 9 : Number(e.key) - 1);
    } else if (!ctrl && k === "q") selectSlot((state.slot + W.HOTBAR.length - 1) % W.HOTBAR.length);
    else if (!ctrl && k === "e") selectSlot((state.slot + 1) % W.HOTBAR.length);
    else if (!ctrl && k === "b") autoBuild();
    else if (!ctrl && k === "t") {
      const order = ["day", "dusk", "night"];
      setTimeMode(order[(order.indexOf(state.mode) + 1) % 3]);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") {
      state.shift = false;
      hoverDirty = true;
    }
  });
  window.addEventListener("blur", () => {
    state.shift = false;
    hoverDirty = true;
  });

  if (!renderer) return;
  const el = renderer.domElement;
  let down = null;
  const toNdc = (e) => {
    const r = el.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  };
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY, at: performance.now(), button: e.button };
    el.style.cursor = "grabbing";
  });
  el.addEventListener("pointermove", (e) => {
    pointer = toNdc(e);
    if (e.shiftKey !== state.shift) state.shift = e.shiftKey;
    hoverDirty = true;
  });
  el.addEventListener("pointerleave", () => {
    pointer = null;
    hoverDirty = true;
  });
  el.addEventListener("pointerup", (e) => {
    const d = down;
    down = null;
    hoverDirty = true;
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved > 5 || performance.now() - d.at > 600) return;
    const p = toNdc(e);
    if (d.button === 0) clickAt(p.x, p.y, e.shiftKey);
    else if (d.button === 2) clickAt(p.x, p.y, true);
  });
  setInterval(() => ($("saveState").textContent = savedText()), 10000);
}

let helpOpen = true;
function setHelp(open) {
  helpOpen = open;
  $("help").hidden = !open;
  $("helpOpen").hidden = open;
  Rosalena.storage.set("prefs", { help: open }).catch(() => {});
}

// ---------------------------------------------------------------- start

Rosalena.on("theme", applyTheme);

let booted;
function start() {
  try {
    initRenderer();
  } catch (err) {
    renderer = null;
    three = null;
    const box = $("fallback");
    box.hidden = false;
    $("fallbackWhy").textContent = String(err && err.message ? err.message : err);
  }
  buildHotbar();
  bindUi();

  // A first visit lands on a curated island with a little cottage already standing.
  const world = W.generateWorld(FIRST_SEED);
  setWorld(world);
  const plan = W.planBuild(state.blocks, { kind: "cottage", seed: FIRST_SEED });
  if (plan.ok) {
    for (const [i, t] of plan.changes) state.blocks[i] = t;
    state.builds = 1;
    rebuildMeshes();
    updateHud();
  }
  applyLighting();
  renderNow();
  Rosalena.ready();
  startLoop();

  booted = (async () => {
    await Rosalena.whenConnected;
    const prefs = await Rosalena.storage.get("prefs").catch(() => null);
    if (prefs && prefs.help === false) setHelp(false);
    const found = await loadSaved({ quiet: true });
    if (!found) await saveNow({ quiet: true });
  })();
}

// ---------------------------------------------------------------- self-tests

function snapshot() {
  return { blocks: new Uint8Array(state.blocks), seed: state.seed, name: state.name, builds: state.builds, placed: state.placed, undo: [...state.undo], redo: [...state.redo], t: state.t, mode: state.mode, auto: state.auto, slot: state.slot };
}

function restore(s) {
  setWorld({ seed: s.seed, name: s.name, blocks: new Uint8Array(s.blocks) }, { history: [...s.undo], builds: s.builds, placed: s.placed });
  state.redo = [...s.redo];
  state.t = s.t;
  state.mode = s.mode;
  state.auto = s.auto;
  selectSlot(s.slot);
  applyLighting();
  updateHud();
  renderNow();
}

const ready = () => booted || Promise.resolve();

Rosalena.test("world generation is deterministic for a seed", async () => {
  const a = W.generateWorld(424242);
  const b = W.generateWorld(424242);
  const c = W.generateWorld(424243);
  Rosalena.assert(W.countBlocks(a.blocks) === W.countBlocks(b.blocks), "same seed, different block counts");
  Rosalena.assert(W.worldHash(a.blocks) === W.worldHash(b.blocks), "same seed, different worlds");
  Rosalena.assert(a.name === b.name && a.name.length > 3, "the island name should follow the seed");
  Rosalena.assert(W.worldHash(a.blocks) !== W.worldHash(c.blocks), "a different seed should make a different island");
  const land = [...Array(N * N).keys()].filter((k) => W.topSolid(a.blocks, k % N, Math.floor(k / N)) >= SEA).length;
  Rosalena.assert(land > 300 && land < N * N * 0.7, `the island should be an island (${land} dry columns)`);
});

Rosalena.test("placing a block adds one and removing it restores the world", async () => {
  await ready();
  Rosalena.assert(renderer, "needs the 3D view");
  const snap = snapshot();
  try {
    const count = W.countBlocks(state.blocks);
    const hash = W.worldHash(state.blocks);
    selectSlot(W.HOTBAR.indexOf(W.PLANKS));
    const placed = clickAt(0, 0, false);
    Rosalena.assert(placed.ok && placed.kind === "place", "clicking the middle of the island should place a block");
    Rosalena.assert(state.blocks[W.index(placed.x, placed.y, placed.z)] === W.PLANKS, "the placed block should be planks");
    Rosalena.assert(W.countBlocks(state.blocks) === count + 1, "block count should go up by one");
    Rosalena.assert(state.placed === snap.placed + 1, "the placed counter should go up");
    const removed = clickAt(0, 0, true);
    Rosalena.assert(removed.ok && removed.x === placed.x && removed.y === placed.y && removed.z === placed.z, "removing should take away the block just placed");
    Rosalena.assert(W.countBlocks(state.blocks) === count, "block count should be back where it was");
    Rosalena.assert(W.worldHash(state.blocks) === hash, "the world should be exactly as before");
  } finally {
    restore(snap);
  }
});

Rosalena.test("undo and redo replay edits", async () => {
  await ready();
  const snap = snapshot();
  try {
    const start = W.worldHash(state.blocks);
    const cells = [];
    for (let x = 2; x < N && cells.length < 3; x++) {
      const t = W.topSolid(state.blocks, x, 30);
      if (t + 1 < H && state.blocks[W.index(x, t + 1, 30)] === AIR) cells.push(W.index(x, t + 1, 30));
    }
    Rosalena.assert(cells.length === 3, "found three spots to build on");
    cells.forEach((i, k) => commit([[i, W.HOTBAR[k]]], { placed: 1 }));
    const after = W.worldHash(state.blocks);
    Rosalena.assert(after !== start, "the edits changed the world");
    Rosalena.assert(undo() && undo() && undo(), "three undos");
    Rosalena.assert(W.worldHash(state.blocks) === start, "undo should get back to the start");
    restore(snap);
    cells.forEach((i, k) => commit([[i, W.HOTBAR[k]]], { placed: 1 }));
    undo();
    undo();
    undo();
    Rosalena.assert(redo() && redo() && redo(), "three redos");
    Rosalena.assert(W.worldHash(state.blocks) === after, "redo should replay the edits exactly");
    Rosalena.assert(state.placed === snap.placed + 3, "counters follow redo");
  } finally {
    restore(snap);
  }
});

Rosalena.test("auto build stands on dry, level ground and gets a roof", async () => {
  await ready();
  const snap = snapshot();
  try {
    const before = new Uint8Array(state.blocks);
    const count = W.countBlocks(before);
    const plan = autoBuild({ quiet: true });
    Rosalena.assert(plan.ok, `auto build should find a spot: ${plan.reason || ""}`);
    Rosalena.assert(plan.base >= SEA, "the building should stand above the sea");
    for (const [i] of plan.changes) Rosalena.assert(before[i] === AIR || before[i] === FLOWER, "auto build only fills empty space");
    for (let z = plan.z0; z < plan.z0 + plan.D; z++) {
      for (let x = plan.x0; x < plan.x0 + plan.W; x++) {
        const ground = W.topSolid(before, x, z);
        Rosalena.assert(ground >= SEA && W.isGround(before[W.index(x, ground, z)]), "every footprint cell rests on dry ground");
        for (let y = ground + 1; y <= plan.base + 1; y++) Rosalena.assert(state.blocks[W.index(x, y, z)] !== AIR, "no gaps between the ground and the floor");
      }
    }
    const types = plan.changes.map(([, t]) => t);
    const roofs = plan.changes.filter(([, t]) => t === W.ROOF).map(([i]) => W.coords(i)[1]);
    Rosalena.assert(roofs.length >= 12, "it should have a roof");
    const highestWall = Math.max(...plan.changes.filter(([, t]) => t === W.PLANKS || t === W.GLASS).map(([i]) => W.coords(i)[1]));
    Rosalena.assert(Math.max(...roofs) > highestWall, "the roof sits above the walls");
    Rosalena.assert(types.includes(W.LANTERN), "it should have lanterns");
    Rosalena.assert(W.countBlocks(state.blocks) > count + 40, "a building is more than a few blocks");
    Rosalena.assert(state.builds === snap.builds + 1, "the build counter should go up");
    Rosalena.assert(undo() && W.worldHash(state.blocks) === W.worldHash(before), "one undo takes the whole building away");
  } finally {
    restore(snap);
  }
});

Rosalena.test("save and load round-trip the island", async () => {
  await ready();
  const snap = snapshot();
  try {
    const hash = W.worldHash(state.blocks);
    Rosalena.assert(await saveNow({ quiet: true }), "save should succeed");
    const stored = await Rosalena.storage.get(SAVE_KEY);
    Rosalena.assert(stored && stored.data && JSON.stringify(stored).length < 200000, "the save should be compact");
    const i = W.index(HALF, H - 2, HALF);
    commit([[i, W.GLASS]], { placed: 1 });
    Rosalena.assert(W.worldHash(state.blocks) !== hash, "the edit changed the world");
    clearTimeout(saveTimer);
    Rosalena.assert(await loadSaved({ quiet: true }), "load should succeed");
    Rosalena.assert(W.worldHash(state.blocks) === hash, "loading should bring back the saved world exactly");
    Rosalena.assert(state.name === snap.name && state.seed === snap.seed, "name and seed come back too");
  } finally {
    restore(snap);
    await saveNow({ quiet: true });
  }
});

Rosalena.test("night dims the sun and lights the lanterns", async () => {
  await ready();
  Rosalena.assert(three, "needs the 3D view");
  const snap = snapshot();
  try {
    setTimeMode("day");
    const day = lightingSnapshot();
    setTimeMode("night");
    const night = lightingSnapshot();
    Rosalena.assert(day.sun > 1 && night.sun < day.sun * 0.1, `the sun should set (${day.sun} -> ${night.sun})`);
    Rosalena.assert(night.moon > day.moon, "the moon should come up");
    Rosalena.assert(night.lantern > day.lantern * 3, "lanterns should glow at night");
    Rosalena.assert(night.stars > 0.6 && day.stars < 0.05, "stars come out at night only");
    setTimeMode("dusk");
    const dusk = lightingSnapshot();
    Rosalena.assert(dusk.sun < day.sun && dusk.lantern > day.lantern, "dusk sits between day and night");
  } finally {
    restore(snap);
  }
});

Rosalena.test("the renderer draws a real frame", async () => {
  await ready();
  Rosalena.assert(renderer, "needs the 3D view");
  renderNow();
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(4);
  const colours = new Set();
  for (let y = 1; y < 10; y++) {
    for (let x = 1; x < 12; x++) {
      gl.readPixels(Math.floor((x / 12) * w), Math.floor((y / 10) * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      colours.add(`${px[0] >> 3},${px[1] >> 3},${px[2] >> 3}`);
    }
  }
  Rosalena.assert(colours.size >= 10, `the frame should have island, water and sky in it (${colours.size} colours)`);
  const counts = three.layers.map((l) => l.mesh.count);
  Rosalena.assert(counts.reduce((a, b) => a + b, 0) > 1500, "instances should be on screen");
  Rosalena.assert(three.layers.length + 2 <= 16, "one draw call per block type");
});

Rosalena.test("PNG export makes a real picture", async () => {
  await ready();
  Rosalena.assert(renderer, "needs the 3D view");
  const out = await exportPng();
  Rosalena.assert(out && out.blob && !out.error, "export should hand over a file");
  Rosalena.assert(out.blob.size > 5000, `the PNG is too small (${out.blob.size} bytes)`);
  const head = new Uint8Array(await out.blob.slice(0, 4).arrayBuffer());
  Rosalena.assert(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47, "it should be a PNG");
  const bmp = await createImageBitmap(out.blob);
  Rosalena.assert(bmp.width === renderer.domElement.width && bmp.height === renderer.domElement.height, "the PNG is the size of the view");
  Rosalena.assert(/\.png$/.test(out.name), "file name ends in .png");
});

Rosalena.test("theme colours reach the HUD", async () => {
  const root = document.documentElement;
  const before = root.getAttribute("style") || "";
  const mode = root.dataset.mode;
  try {
    applyTheme({ mode: "light", colors: { panel: "#fafafa", text: "#111111", accent: "#3366ff" } });
    const css = getComputedStyle(root);
    Rosalena.assert(css.getPropertyValue("--accent").trim() === "#3366ff", "accent should come from the app");
    Rosalena.assert(root.dataset.mode === "light", "light mode should be picked up");
    const card = getComputedStyle($("card"));
    Rosalena.assert(card.color === "rgb(17, 17, 17)", `the card text should follow the theme (${card.color})`);
  } finally {
    root.setAttribute("style", before);
    if (mode) root.dataset.mode = mode;
    else delete root.dataset.mode;
    if (Rosalena.host && Rosalena.host.theme) applyTheme(Rosalena.host.theme);
  }
});

start();
