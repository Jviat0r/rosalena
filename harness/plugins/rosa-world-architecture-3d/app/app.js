// World Architecture 3D: four landmarks rebuilt to scale, with fact sheets and lighting presets.
import * as THREE from "/plugin-lib/three/three.module.js";
import { OrbitControls } from "/plugin-lib/three/OrbitControls.js";
import { LANDMARKS, LIGHTING, ORDER } from "./data.js";
import { buildLandmark } from "./landmarks.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byId = Object.fromEntries(LANDMARKS.map((l) => [l.id, l]));

const state = { landmark: "eiffel", lighting: "day", autoRotate: false, annotations: true };
const built = new Map();

// ------------------------------------------------------------------ theme (panel chrome)

const FALLBACK = {
  dark: { bg: "#101317", panel: "#171b20", line: "#2a3038", text: "#ece8df", dim: "#9aa1a9", accent: "#d9a441", "accent-soft": "rgba(217,164,65,0.16)" },
  light: { bg: "#f5f3ee", panel: "#ffffff", line: "#ddd8cf", text: "#1d1b17", dim: "#6a655c", accent: "#b07a1c", "accent-soft": "rgba(176,122,28,0.12)" },
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
  root.dataset.mode = mode;
}
applyTheme(null);
Rosalena.on("theme", applyTheme);

// ------------------------------------------------------------------ chrome

const ICONS = {
  eiffel: '<path d="M24 3 L22 13 L19.5 22 L14 42 M24 3 L26 13 L28.5 22 L34 42 M21 17 H27 M18 28 H30 M16.6 34 Q24 27 31.4 34 M10 42 H38 M24 1 V3" />',
  wall: '<path d="M2 38 L10 30 L17 33 L27 20 L36 26 L46 18" /><path d="M24 23 V14 H31 V22 M24 14 V12 H25.5 V14 M27 14 V12 H28.5 V14 M30 14 V12 H31" /><path d="M2 44 L12 36 L22 40 L32 30 L46 34" opacity=".5" />',
  hall: '<path d="M14 15 Q24 9 34 15 L36 16 M14 15 L12 16 M24 10.5 V8" /><path d="M9 23 Q24 17 39 23 L41 24 M9 23 L7 24" /><path d="M16 16.5 V19 H32 V16.5 M11 24 V33 M17 24 V33 M24 24 V33 M31 24 V33 M37 24 V33" /><path d="M5 33 H43 V36 H5 Z M3 36 H45 V40 H3 Z" />',
  colosseum: '<path d="M4 40 V16 Q24 8 44 14 V40" /><path d="M4 22 Q24 15 44 20 M4 29 Q24 23 44 27 M4 35 Q24 30 44 33" /><path d="M9 40 V37 M15 40 V36.5 M21 40 V36 M27 40 V36 M33 40 V36 M39 40 V36.5" /><path d="M30 14 L33 18 L36 16 L40 20 L44 18" opacity=".55" />',
};

function renderGallery() {
  const nav = $("#gallery");
  nav.innerHTML = LANDMARKS.map(
    (l) => `<button type="button" class="card" data-id="${l.id}" title="${esc(l.name)} (${l.key})">
      <svg viewBox="0 0 48 48" aria-hidden="true">${ICONS[l.id]}</svg>
      <span class="txt"><b>${esc(l.name)}</b><span>${esc(l.place)}</span><em>${esc(l.dimension)}</em></span>
      <kbd>${l.key}</kbd></button>`,
  ).join("");
  nav.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) selectLandmark(card.dataset.id);
  });
}

function renderPanel(lm) {
  $("#fact-place").textContent = lm.place;
  $("#fact-title").textContent = lm.name;
  $("#fact-alias").textContent = lm.alias;
  $("#fact-stat").textContent = lm.stat;
  $("#fact-stat-label").textContent = lm.statLabel;
  $("#fact-lede").textContent = lm.lede;
  $("#fact-list").innerHTML = lm.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const model = built.get(lm.id);
  $("#notice-list").innerHTML = lm.notice
    .map((n) => {
      const a = model?.annotations.find((x) => x.id === n.anno);
      return `<li tabindex="0" data-anno="${n.anno}" title="Show it in the model"><small>${esc(a ? a.label : n.anno)}</small>${esc(n.text)}</li>`;
    })
    .join("");
  $("#visit-list").innerHTML = lm.visit.map((t) => `<li>${esc(t)}</li>`).join("");
  const max = Math.max(...LANDMARKS.map((l) => l.modelHeight));
  $("#size-strip").innerHTML = LANDMARKS.map(
    (l) => `<div class="size-col${l.id === lm.id ? " on" : ""}" data-id="${l.id}" title="${esc(l.name)}: ${l.modelHeight} m in the model">
      <b>${l.modelHeight} m</b><div class="bar" style="height:${Math.max(3, (l.modelHeight / max) * 70).toFixed(1)}px"></div><span>${esc(l.name)}</span></div>`,
  ).join("");
  for (const card of document.querySelectorAll(".card")) card.setAttribute("aria-current", String(card.dataset.id === lm.id));
  $("#panel .panel-scroll").scrollTop = 0;
}

function bindPanel() {
  const list = $("#notice-list");
  const hot = (id, on) => {
    for (const el of document.querySelectorAll(`.anno[data-id="${id}"]`)) el.classList.toggle("hot", on);
  };
  list.addEventListener("mouseover", (e) => {
    const li = e.target.closest("li");
    if (li) hot(li.dataset.anno, true);
  });
  list.addEventListener("mouseout", (e) => {
    const li = e.target.closest("li");
    if (li) hot(li.dataset.anno, false);
  });
  const go = (e) => {
    const li = e.target.closest("li");
    if (li) focusAnnotation(li.dataset.anno);
  };
  list.addEventListener("click", go);
  list.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go(e);
    }
  });
  $("#size-strip").addEventListener("click", (e) => {
    const col = e.target.closest(".size-col");
    if (col) selectLandmark(col.dataset.id);
  });
  $("#ask").addEventListener("click", () => askRosalena());
}

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 3400);
}

// ------------------------------------------------------------------ three.js

let renderer = null;
let scene;
let camera;
let controls;
let sun;
let hemi;
let uplight;
let skyDome;
let stars;
let sunGlow;
let moon;
let needsRender = true;
let tween = null;
let switchToken = 0;
let raf = 0;
let lastTime = performance.now();
let glError = null;

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return Boolean(window.WebGLRenderingContext && c.getContext("webgl2"));
  } catch (_) {
    return false;
  }
}

function radialTexture(stops) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [at, col] of stops) grad.addColorStop(at, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function setupScene() {
  const host = $("#canvas-host");
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "3D model. Drag to orbit, scroll to zoom, double-click to reset.");
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#d3dfe8", 1000, 5000);
  // A sky dome whose horizon colour is the fog colour, so distant ground fades into it.
  skyDome = new THREE.Mesh(
    new THREE.SphereGeometry(9500, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() } },
      vertexShader: "varying vec3 vDir;\nvoid main() {\n  vDir = normalize(position);\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}",
      fragmentShader: [
        "uniform vec3 uTop;",
        "uniform vec3 uMid;",
        "uniform vec3 uHorizon;",
        "varying vec3 vDir;",
        "void main() {",
        "  float h = normalize(vDir).y;",
        "  vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.2, h));",
        "  c = mix(c, uTop, smoothstep(0.2, 0.75, h));",
        "  gl_FragColor = vec4(c, 1.0);",
        "  #include <tonemapping_fragment>",
        "  #include <colorspace_fragment>",
        "}",
      ].join("\n"),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  skyDome.renderOrder = -1;
  skyDome.frustumCulled = false;
  scene.add(skyDome);
  scene.background = new THREE.Color("#000000");

  camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.autoRotateSpeed = 0.7;
  controls.addEventListener("change", () => (needsRender = true));
  controls.addEventListener("start", () => (tween = null));
  renderer.domElement.addEventListener("dblclick", () => resetView());

  hemi = new THREE.HemisphereLight("#cfe2ff", "#7a6a52", 1.2);
  scene.add(hemi);
  sun = new THREE.DirectionalLight("#fff2dc", 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);
  uplight = new THREE.DirectionalLight("#ffb366", 0);
  scene.add(uplight, uplight.target);

  const starPos = [];
  const sr = (() => {
    let a = 99;
    return () => ((a = (a * 16807) % 2147483647) / 2147483647);
  })();
  for (let i = 0; i < 1600; i++) {
    const th = sr() * Math.PI * 2;
    const y = 0.08 + sr() * 0.92;
    const rr = Math.sqrt(1 - y * y);
    starPos.push(Math.cos(th) * rr * 9000, y * 9000, Math.sin(th) * rr * 9000);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute("position", new THREE.Float32BufferAttribute(starPos, 3));
  stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: "#ffffff", size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  stars.frustumCulled = false;
  stars.visible = false;
  scene.add(stars);
  sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture([[0, "rgba(255,255,255,1)"], [0.12, "rgba(255,240,210,0.9)"], [0.35, "rgba(255,200,140,0.25)"], [1, "rgba(255,180,120,0)"]]), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
  moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture([[0, "rgba(245,245,255,1)"], [0.42, "rgba(230,235,255,1)"], [0.48, "rgba(200,210,255,0.35)"], [1, "rgba(160,180,255,0)"]]), depthWrite: false, fog: false, transparent: true }));
  scene.add(sunGlow, moon);

  const ro = new ResizeObserver(() => resize());
  ro.observe($("#stage"));
  resize();
}

function resize() {
  if (!renderer) return;
  const stage = $("#stage");
  const w = Math.max(1, stage.clientWidth);
  const h = Math.max(1, stage.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  needsRender = true;
}

function paintSky(p) {
  const u = skyDome.material.uniforms;
  u.uTop.value.set(p.skyTop);
  u.uMid.value.set(p.skyMid);
  u.uHorizon.value.set(p.fog);
}

function lightDir(p, lm) {
  const v = lm.view;
  const viewAz = Math.atan2(v.pos.x - v.target.x, v.pos.z - v.target.z);
  const az = viewAz + (p.az * Math.PI) / 180;
  const el = (p.elev * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

function positionLights() {
  const lm = built.get(state.landmark);
  if (!lm) return;
  const p = LIGHTING[state.lighting];
  const dir = lightDir(p, lm);
  const half = lm.shadowHalf;
  const t = lm.view.target;
  sun.target.position.copy(t);
  sun.position.copy(t).addScaledVector(dir, half * 3);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -half;
  cam.right = cam.top = half;
  cam.near = 1;
  cam.far = half * 6;
  cam.updateProjectionMatrix();
  sun.shadow.normalBias = lm.normalBias;
  sun.shadow.needsUpdate = true;
  const v = lm.view;
  const viewAz = Math.atan2(v.pos.x - v.target.x, v.pos.z - v.target.z) + 0.5;
  uplight.target.position.copy(t);
  uplight.position.copy(t).add(new THREE.Vector3(Math.sin(viewAz), 0.12, Math.cos(viewAz)).multiplyScalar(500));
}

function applyLighting(name, { save = true } = {}) {
  const p = LIGHTING[name];
  if (!p) return false;
  state.lighting = name;
  if (renderer) {
    sun.color.set(p.sunColor);
    sun.intensity = p.sunInt;
    hemi.color.set(p.hemiSky);
    hemi.groundColor.set(p.hemiGround);
    hemi.intensity = p.hemiInt;
    uplight.intensity = p.night * 1.0;
    renderer.toneMappingExposure = p.exposure;
    paintSky(p);
    scene.fog.color.set(p.fog);
    stars.material.opacity = p.stars;
    stars.visible = p.stars > 0;
    sunGlow.visible = Boolean(p.glow);
    moon.visible = !p.glow;
    if (p.glow) sunGlow.material.color.set(p.glow.color);
    for (const lm of built.values()) lm.setNight(p.night);
    positionLights();
    needsRender = true;
  }
  for (const b of document.querySelectorAll("[data-light]")) b.setAttribute("aria-pressed", String(b.dataset.light === name));
  if (save) scheduleSave();
  return true;
}

function ensureBuilt(id) {
  let lm = built.get(id);
  if (lm) return lm;
  lm = buildLandmark(id);
  lm.group.visible = false;
  built.set(id, lm);
  if (scene) scene.add(lm.group);
  lm.setNight(LIGHTING[state.lighting].night);
  return lm;
}

function showLandmark(id) {
  const lm = ensureBuilt(id);
  state.landmark = id;
  for (const other of built.values()) other.group.visible = other.id === id;
  if (renderer) {
    scene.fog.near = lm.fog[0];
    scene.fog.far = lm.fog[1];
    controls.minDistance = lm.view.min;
    controls.maxDistance = lm.view.max;
    positionLights();
  }
  renderPanel(byId[id]);
  renderAnnotations(lm);
  needsRender = true;
  return lm;
}

function placeCamera(view) {
  tween = null;
  camera.position.copy(view.pos);
  controls.target.copy(view.target);
  controls.update();
  needsRender = true;
}

function flyTo(to, duration = 1400) {
  tween = { from: { pos: camera.position.clone(), target: controls.target.clone() }, to: { pos: to.pos.clone(), target: to.target.clone() }, t0: performance.now(), duration };
  needsRender = true;
}

async function selectLandmark(id, { instant = false } = {}) {
  if (!byId[id]) return false;
  const token = ++switchToken;
  if (id === state.landmark && built.has(id) && !instant) {
    resetView();
    return true;
  }
  if (!instant && renderer) {
    $("#veil").classList.add("on");
    await wait(260);
    if (token !== switchToken) return false;
  }
  const lm = showLandmark(id);
  if (renderer) {
    if (instant) placeCamera(lm.view);
    else {
      const { pos, target, radius } = lm.view;
      const away = pos.clone().sub(target).multiplyScalar(1.5).add(new THREE.Vector3(0, radius * 0.35, 0));
      placeCamera({ pos: target.clone().add(away), target: target.clone().add(new THREE.Vector3(0, radius * 0.12, 0)) });
      flyTo(lm.view, 1700);
    }
  }
  $("#veil").classList.remove("on");
  scheduleSave();
  return true;
}

function resetView() {
  const lm = built.get(state.landmark);
  if (lm && renderer) flyTo(lm.view, 1100);
}

function focusAnnotation(annoId) {
  const lm = built.get(state.landmark);
  const a = lm?.annotations.find((x) => x.id === annoId);
  if (!a || !renderer) return false;
  const dir = camera.position.clone().sub(controls.target).normalize();
  flyTo({ pos: a.pos.clone().addScaledVector(dir, lm.view.focus), target: a.pos.clone() }, 1200);
  for (const el of document.querySelectorAll(".anno")) el.classList.toggle("hot", el.dataset.id === annoId);
  setTimeout(() => {
    for (const el of document.querySelectorAll(`.anno[data-id="${annoId}"]`)) el.classList.remove("hot");
  }, 2600);
  return true;
}

function setAutoRotate(on, { save = true } = {}) {
  state.autoRotate = Boolean(on);
  if (controls) controls.autoRotate = state.autoRotate;
  $("#btn-rotate").setAttribute("aria-pressed", String(state.autoRotate));
  needsRender = true;
  if (save) scheduleSave();
}

function setAnnotations(on, { save = true } = {}) {
  state.annotations = Boolean(on);
  $("#btn-labels").setAttribute("aria-pressed", String(state.annotations));
  $("#labels").hidden = !state.annotations;
  needsRender = true;
  if (save) scheduleSave();
}

// ------------------------------------------------------------------ overlays

let labelEls = [];
function renderAnnotations(lm) {
  const host = $("#labels");
  const numbered = new Map(byId[lm.id].notice.map((n, i) => [n.anno, i + 1]));
  host.innerHTML = lm.annotations
    .map((a) => {
      const n = numbered.get(a.id);
      return `<div class="anno ${a.side === "left" ? "left" : "right"} off" data-id="${a.id}"><i class="dot"></i><i class="lead"></i><span class="tag">${n ? `<b>${n}</b>` : ""}${esc(a.label)}</span></div>`;
    })
    .join("");
  labelEls = lm.annotations.map((a) => ({ a, el: host.querySelector(`[data-id="${a.id}"]`) }));
}

const _proj = new THREE.Vector3();
function projectAnnotations() {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  let shown = 0;
  for (const { a, el } of labelEls) {
    _proj.copy(a.pos).project(camera);
    const x = ((_proj.x + 1) / 2) * w;
    const y = ((1 - _proj.y) / 2) * h;
    const visible = _proj.z < 1 && _proj.z > -1 && x > 8 && x < w - 8 && y > 60 && y < h - 104;
    el.classList.toggle("off", !visible);
    // Keep the tag on the stage: flip it to the other side of its dot near an edge.
    const room = (a.width ??= el.querySelector(".tag").offsetWidth || 160) + 52;
    const side = a.side === "left" ? (x < room ? "right" : "left") : x > w - room ? "left" : "right";
    el.classList.toggle("left", side === "left");
    el.classList.toggle("right", side === "right");
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    a.screen = { x, y, visible };
    if (visible) shown++;
  }
  return shown;
}

function updateScaleBar() {
  const dist = camera.position.distanceTo(controls.target);
  const h = renderer.domElement.clientHeight;
  const ppm = h / 2 / (dist * Math.tan((camera.fov * Math.PI) / 360));
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  let pick = nice[0];
  for (const m of nice) if (m * ppm <= 150) pick = m;
  $("#scalebar .bar").style.width = `${Math.max(12, pick * ppm).toFixed(0)}px`;
  $("#scalebar span").textContent = `${pick} m`;
  return { metres: pick, px: pick * ppm };
}

// ------------------------------------------------------------------ loop

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

function renderNow() {
  const p = LIGHTING[state.lighting];
  const lm = built.get(state.landmark);
  const dir = lm ? lightDir(p, lm) : new THREE.Vector3(0, 1, 0);
  stars.position.copy(camera.position);
  skyDome.position.copy(camera.position);
  sunGlow.position.copy(camera.position).addScaledVector(dir, 6000);
  moon.position.copy(sunGlow.position);
  const s = p.glow ? p.glow.size * 6000 : 300;
  sunGlow.scale.set(s, s, 1);
  moon.scale.set(300, 300, 1);
  renderer.render(scene, camera);
  if (state.annotations) projectAnnotations();
  updateScaleBar();
  needsRender = false;
}

function tick(now) {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (tween) {
    const k = Math.min(1, (now - tween.t0) / tween.duration);
    const e = ease(k);
    camera.position.lerpVectors(tween.from.pos, tween.to.pos, e);
    controls.target.lerpVectors(tween.from.target, tween.to.target, e);
    if (k >= 1) tween = null;
    needsRender = true;
  }
  if (controls.update(dt)) needsRender = true;
  const lm = built.get(state.landmark);
  if (lm && lm.animating()) {
    lm.update(dt);
    needsRender = true;
  }
  if (state.autoRotate) needsRender = true;
  if (needsRender) renderNow();
}

function loop(now) {
  raf = requestAnimationFrame(loop);
  tick(now);
}

function startLoop() {
  if (raf || !renderer) return;
  lastTime = performance.now();
  raf = requestAnimationFrame(loop);
}

function stopLoop() {
  cancelAnimationFrame(raf);
  raf = 0;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLoop();
  else {
    needsRender = true;
    startLoop();
  }
});

// ------------------------------------------------------------------ storage and chat

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveState().catch(() => {});
  }, 500);
}

async function saveState() {
  clearTimeout(saveTimer);
  const value = { landmark: state.landmark, lighting: state.lighting, autoRotate: state.autoRotate, annotations: state.annotations };
  try {
    await Rosalena.storage.set("exhibit", value);
    return true;
  } catch (err) {
    toast(`Could not save your place: ${err.message}`);
    return false;
  }
}

function applySaved(saved, { instant = true } = {}) {
  if (!saved || typeof saved !== "object") return false;
  if (typeof saved.lighting === "string" && LIGHTING[saved.lighting]) applyLighting(saved.lighting, { save: false });
  if (typeof saved.autoRotate === "boolean") setAutoRotate(saved.autoRotate, { save: false });
  if (typeof saved.annotations === "boolean") setAnnotations(saved.annotations, { save: false });
  if (typeof saved.landmark === "string" && byId[saved.landmark]) {
    const lm = showLandmark(saved.landmark);
    if (renderer && instant) placeCamera(lm.view);
  }
  return true;
}

async function loadState() {
  try {
    const saved = await Rosalena.storage.get("exhibit");
    return applySaved(saved) ? saved : null;
  } catch (err) {
    toast(`Could not load your last visit: ${err.message}`);
    return null;
  }
}

function questionText() {
  const lm = byId[state.landmark];
  const light = LIGHTING[state.lighting].label.toLowerCase();
  return `I'm looking at a 3D model of the ${lm.name} (${lm.place}) in World Architecture 3D, lit for ${light}. ${lm.question}`;
}

async function askRosalena() {
  const text = questionText();
  try {
    await Rosalena.chat.compose(text);
    toast("Question placed in the chat box. Edit it or press Enter to send.");
  } catch (err) {
    toast(`Could not reach the chat box: ${err.message}`);
  }
  return text;
}

// ------------------------------------------------------------------ keyboard and buttons

function bindControls() {
  for (const b of document.querySelectorAll("[data-light]")) b.addEventListener("click", () => applyLighting(b.dataset.light));
  $("#btn-rotate").addEventListener("click", () => setAutoRotate(!state.autoRotate));
  $("#btn-labels").addEventListener("click", () => setAnnotations(!state.annotations));
  $("#btn-reset").addEventListener("click", () => resetView());
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLElement && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    const lm = LANDMARKS.find((l) => l.key === e.key);
    if (lm) selectLandmark(lm.id);
    else if (k === "r") resetView();
    else if (k === "a") setAutoRotate(!state.autoRotate);
    else if (k === "l") setAnnotations(!state.annotations);
    else if (k === "d") applyLighting("day");
    else if (k === "k") applyLighting("dusk");
    else if (k === "n") applyLighting("night");
    else return;
    e.preventDefault();
  });
}

// ------------------------------------------------------------------ start

async function init() {
  renderGallery();
  bindPanel();
  bindControls();
  if (!webglAvailable()) {
    glError = "This exhibit needs WebGL 2, and this window does not offer it. The fact sheets on the right still work.";
  } else {
    try {
      setupScene();
    } catch (err) {
      renderer = null;
      glError = `The 3D view could not start (${err.message}). The fact sheets on the right still work.`;
    }
  }
  if (glError) {
    const fb = $("#fallback");
    fb.hidden = false;
    fb.textContent = glError;
  }
  let saved = null;
  try {
    saved = await Promise.race([Rosalena.storage.get("exhibit"), wait(1500).then(() => null)]);
  } catch (_) {
    saved = null;
  }
  if (saved && typeof saved === "object") {
    if (byId[saved.landmark]) state.landmark = saved.landmark;
    if (LIGHTING[saved.lighting]) state.lighting = saved.lighting;
  }
  const lm = showLandmark(state.landmark);
  applyLighting(state.lighting, { save: false });
  setAutoRotate(saved?.autoRotate === true, { save: false });
  setAnnotations(saved?.annotations !== false, { save: false });
  if (renderer) {
    placeCamera(lm.view);
    renderNow();
    startLoop();
  }
  $("#loading").classList.add("done");
  Rosalena.ready();
  // Build the other landmarks in the background so switching is instant.
  for (const id of ORDER) {
    if (built.has(id)) continue;
    await wait(150);
    ensureBuilt(id);
  }
}

// ------------------------------------------------------------------ self-tests

// The state the tests leave behind, so the verifier's screenshot shows the opening view.
const SHOT = { landmark: "eiffel", lighting: "day" };

Rosalena.test("all four landmarks build with meshes", () => {
  for (const id of ORDER) {
    const lm = ensureBuilt(id);
    Rosalena.assert(lm.meshCount > 0, `${id} has no meshes`);
    let tris = 0;
    lm.group.traverse((o) => {
      if (o.isMesh) {
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        const box = g.boundingBox ?? (g.computeBoundingBox(), g.boundingBox);
        Rosalena.assert(Number.isFinite(box.min.x) && Number.isFinite(box.max.y), `${id}/${o.name || "mesh"} has a broken bounding box`);
      }
    });
    Rosalena.assert(tris > 1000, `${id} has only ${tris} triangles`);
    Rosalena.assert(lm.annotations.length >= 3, `${id} needs at least 3 annotations`);
    for (const n of byId[id].notice) Rosalena.assert(lm.annotations.some((a) => a.id === n.anno), `${id}: "What to notice" points at missing annotation ${n.anno}`);
  }
});

Rosalena.test("switching landmark updates the fact panel title", async () => {
  for (const id of ORDER) {
    await selectLandmark(id, { instant: true });
    Rosalena.assert(state.landmark === id, `state.landmark is ${state.landmark}, expected ${id}`);
    Rosalena.assert($("#fact-title").textContent === byId[id].name, `panel title is "${$("#fact-title").textContent}" for ${id}`);
    Rosalena.assert(document.querySelector(`.card[data-id="${id}"]`).getAttribute("aria-current") === "true", `the ${id} card is not marked current`);
    Rosalena.assert(built.get(id).group.visible, `${id} is not visible after switching`);
    for (const other of ORDER) if (other !== id) Rosalena.assert(!built.get(other).group.visible, `${other} is still visible`);
  }
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
  await wait(700);
  Rosalena.assert(state.landmark === "wall" && $("#fact-title").textContent === "Great Wall", "pressing 2 should switch to the Great Wall");
});

Rosalena.test("lighting presets change the sun's intensity and colour", () => {
  Rosalena.assert(renderer, "no renderer");
  const seen = {};
  for (const name of ["day", "dusk", "night"]) {
    applyLighting(name, { save: false });
    seen[name] = { i: sun.intensity, c: sun.color.getHexString(), sky: hemi.color.getHexString(), up: uplight.intensity };
    Rosalena.assert(document.querySelector(`[data-light="${name}"]`).getAttribute("aria-pressed") === "true", `${name} button is not pressed`);
  }
  Rosalena.assert(seen.day.i > seen.dusk.i && seen.dusk.i > seen.night.i, `sun intensity should fall day > dusk > night: ${JSON.stringify(seen)}`);
  Rosalena.assert(new Set([seen.day.c, seen.dusk.c, seen.night.c]).size === 3, "each preset should colour the sun differently");
  Rosalena.assert(seen.night.up > seen.day.up, "night should switch the warm floodlights on");
  Rosalena.assert(stars.visible && moon.visible, "night should show the stars and the moon");
  applyLighting("day", { save: false });
  Rosalena.assert(!stars.visible && sunGlow.visible, "day should hide the stars");
});

Rosalena.test("landmarks are built to scale", () => {
  const size = (id) => new THREE.Box3().setFromObject(ensureBuilt(id).structure).getSize(new THREE.Vector3());
  const eiffel = size("eiffel");
  Rosalena.assert(Math.abs(eiffel.y - 330) / 330 < 0.05, `Eiffel Tower is ${eiffel.y.toFixed(1)} m tall, expected about 330`);
  Rosalena.assert(eiffel.x > 120 && eiffel.x < 135, `Eiffel Tower base is ${eiffel.x.toFixed(1)} m, expected about 125`);
  const col = size("colosseum");
  Rosalena.assert(Math.abs(col.x - 189) / 189 < 0.05, `Colosseum is ${col.x.toFixed(1)} m long, expected about 189`);
  Rosalena.assert(Math.abs(col.z - 156) / 156 < 0.05, `Colosseum is ${col.z.toFixed(1)} m wide, expected about 156`);
  const hall = size("hall");
  const hallBox = new THREE.Box3().setFromObject(ensureBuilt("hall").structure);
  Rosalena.assert(hallBox.max.y > 33 && hallBox.max.y < 37, `Hall of Supreme Harmony rises ${hallBox.max.y.toFixed(1)} m, expected about 35`);
  Rosalena.assert(hall.x > 120, "the hall's terrace should be wider than 120 m");
});

Rosalena.test("storage round trip restores the last landmark and lighting", async () => {
  await selectLandmark("hall", { instant: true });
  applyLighting("dusk", { save: false });
  Rosalena.assert(await saveState(), "saving failed");
  await selectLandmark("colosseum", { instant: true });
  applyLighting("night", { save: false });
  clearTimeout(saveTimer);
  const restored = await loadState();
  Rosalena.assert(restored && restored.landmark === "hall", `storage returned ${JSON.stringify(restored)}`);
  Rosalena.assert(state.landmark === "hall" && $("#fact-title").textContent === "Hall of Supreme Harmony", `restoring should bring back the hall, got ${state.landmark}`);
  Rosalena.assert(state.lighting === "dusk", `restoring should bring back dusk, got ${state.lighting}`);
});

Rosalena.test("annotations are pinned on screen and tied to the notes", async () => {
  setAnnotations(true, { save: false });
  for (const id of ORDER) {
    await selectLandmark(id, { instant: true });
    renderNow();
    const shown = projectAnnotations();
    Rosalena.assert(shown >= 3, `${id}: only ${shown} annotations are on screen`);
    Rosalena.assert(document.querySelectorAll("#notice-list li").length === 3, `${id}: expected 3 "What to notice" points`);
  }
  const first = $("#notice-list li").dataset.anno;
  Rosalena.assert(focusAnnotation(first), "clicking a note should fly to its annotation");
  tween = null;
  setAnnotations(false, { save: false });
  Rosalena.assert($("#labels").hidden, "turning annotations off should hide the labels");
  setAnnotations(true, { save: false });
});

Rosalena.test("Ask Rosalena composes a question about the current landmark", async () => {
  await selectLandmark("colosseum", { instant: true });
  const text = await askRosalena();
  Rosalena.assert(/Colosseum/.test(text) && /Rome/.test(text), `question does not name the landmark: ${text}`);
  Rosalena.assert(text.length > 80, "question is too short to be useful");
  Rosalena.assert($("#toast").classList.contains("on"), "the person should be told where the question went");
  clearTimeout(toastTimer);
  $("#toast").classList.remove("on");
});

Rosalena.test("renderer produced a non-empty frame", async () => {
  Rosalena.assert(renderer, glError || "no renderer");
  await selectLandmark(SHOT.landmark, { instant: true });
  applyLighting(SHOT.lighting, { save: false });
  setAutoRotate(false, { save: false });
  renderNow();
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const colours = new Set();
  for (let i = 0; i < px.length; i += 4 * 211) colours.add(((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3));
  Rosalena.assert(colours.size > 40, `the frame has only ${colours.size} distinct colours`);
  Rosalena.assert(renderer.info.render.triangles > 1000, `only ${renderer.info.render.triangles} triangles drawn`);
  const bar = updateScaleBar();
  Rosalena.assert(bar.px > 10 && bar.metres > 0, "the scale bar should show a length");
});

init().catch((err) => {
  console.error(`World Architecture 3D failed to start: ${err && err.stack ? err.stack : err}`);
});
