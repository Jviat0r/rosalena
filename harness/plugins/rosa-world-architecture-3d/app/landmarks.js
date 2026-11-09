// Procedural landmark models, built from primitives in metres (1 unit = 1 m).
//
// Everything that shares a material is merged into one mesh (Merger), so a landmark is a
// handful of draw calls even when it is made of thousands of beams and blocks. Textures are
// drawn on canvases or computed in the shader (masonry); nothing is loaded.
import * as THREE from "/plugin-lib/three/three.module.js";

export const UP = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

function makePrism() {
  const s = new THREE.Shape();
  s.moveTo(-0.5, -0.5);
  s.lineTo(0.5, -0.5);
  s.lineTo(0, 0.5);
  s.lineTo(-0.5, -0.5);
  return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
}

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1),
  cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1),
  cone: new THREE.ConeGeometry(0.5, 1, 7, 1),
  ico: new THREE.IcosahedronGeometry(0.5, 1),
  pyr: new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4),
  prism: makePrism(),
};

/** A small seeded random generator, so every build is identical. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tint = (hex, r, amt = 0.06) => new THREE.Color(hex).offsetHSL(0, 0, (r() - 0.5) * amt);

// ------------------------------------------------------------------ merging

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n3 = new THREE.Matrix3();

export class Merger {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  add(geo, matrix, color) {
    this.items.push({ geo, m: matrix.clone(), c: new THREE.Color(color) });
    return this;
  }
  put(geo, x, y, z, sx, sy, sz, color, ry = 0) {
    _q.setFromAxisAngle(UP, ry);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    return this.add(geo, _m, color);
  }
  box(x, y, z, sx, sy, sz, color, ry = 0) {
    return this.put(GEO.box, x, y, z, sx, sy, sz, color, ry);
  }
  /** A member from a to b with a square section t. */
  beam(a, b, t, color, geo = GEO.box) {
    _d.subVectors(b, a);
    const len = _d.length();
    if (len < 1e-4) return this;
    _q.setFromUnitVectors(UP, _d.divideScalar(len));
    _m.compose(_p.addVectors(a, b).multiplyScalar(0.5), _q, _s.set(t, len, t));
    return this.add(geo, _m, color);
  }
  /** A shape placed on a right-handed basis (f, u, l) with sizes along each axis. */
  basis(geo, center, f, u, l, sf, su, sl, color) {
    _m.makeBasis(f, u, l);
    _m.scale(_s.set(sf, su, sl));
    _m.setPosition(center);
    return this.add(geo, _m, color);
  }
  build() {
    let nv = 0;
    let ni = 0;
    for (const it of this.items) {
      nv += it.geo.attributes.position.count;
      ni += it.geo.index ? it.geo.index.count : it.geo.attributes.position.count;
    }
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const col = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const idx = new Uint32Array(ni);
    let vo = 0;
    let io = 0;
    for (const { geo, m, c } of this.items) {
      const P = geo.attributes.position;
      const N = geo.attributes.normal;
      const U = geo.attributes.uv;
      const e = m.elements;
      _n3.getNormalMatrix(m);
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i);
        const y = P.getY(i);
        const z = P.getZ(i);
        const o = (vo + i) * 3;
        pos[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
        pos[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        pos[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (N) {
          _v.set(N.getX(i), N.getY(i), N.getZ(i)).applyMatrix3(_n3).normalize();
          nor[o] = _v.x;
          nor[o + 1] = _v.y;
          nor[o + 2] = _v.z;
        }
        col[o] = c.r;
        col[o + 1] = c.g;
        col[o + 2] = c.b;
        if (U) {
          uv[(vo + i) * 2] = U.getX(i);
          uv[(vo + i) * 2 + 1] = U.getY(i);
        }
      }
      if (geo.index) for (let j = 0; j < geo.index.count; j++) idx[io++] = geo.index.getX(j) + vo;
      else for (let j = 0; j < P.count; j++) idx[io++] = vo + j;
      vo += P.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
  mesh(material, { cast = true, receive = true, name = "" } = {}) {
    const mesh = new THREE.Mesh(this.build(), material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    mesh.name = name;
    return mesh;
  }
}

/** Free-form triangles with flat colours (stepped seating, ellipse bands, floors). */
class Quads {
  constructor() {
    this.pos = [];
    this.col = [];
  }
  tri(a, b, c, color) {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
  }
  /** A quad a-b-c-d, wound so its face points along `facing`. */
  quad(a, b, c, d, color, facing) {
    const n = _v.subVectors(b, a).cross(_d.subVectors(c, a));
    if (n.dot(facing) < 0) {
      this.tri(a, c, b, color);
      this.tri(a, d, c, color);
    } else {
      this.tri(a, b, c, color);
      this.tri(a, c, d, color);
    }
  }
  mesh(material, { cast = true, receive = true } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    return mesh;
  }
}

// ------------------------------------------------------------------ materials and textures

/** Stone courses drawn in the shader from world position, faded out where they would alias. */
export function masonry(mat, { course = 0.6, block = 1.2, mortar = 0.05, strength = 0.3 } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMason = { value: new THREE.Vector4(course, block, mortar, strength) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vMasonPos;\nvarying vec3 vMasonNor;")
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvMasonPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvMasonNor = normalize(mat3(modelMatrix) * objectNormal);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        [
          "#include <common>",
          "varying vec3 vMasonPos;",
          "varying vec3 vMasonNor;",
          "uniform vec4 uMason;",
          "float masonHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }",
        ].join("\n"),
      )
      .replace(
        "#include <color_fragment>",
        [
          "#include <color_fragment>",
          "{",
          "  vec3 mn = abs(normalize(vMasonNor));",
          "  vec2 mc = mn.y > 0.75 ? vMasonPos.xz : vec2(mn.x > mn.z ? vMasonPos.z : vMasonPos.x, vMasonPos.y);",
          "  float rowF = mc.y / uMason.x;",
          "  float rowI = floor(rowF);",
          "  float colF = mc.x / uMason.y + 0.5 * mod(rowI, 2.0);",
          "  float colI = floor(colF);",
          "  vec2 fr = vec2(fract(colF) * uMason.y, fract(rowF) * uMason.x);",
          "  float joint = 1.0 - step(uMason.z, fr.x) * step(uMason.z, fr.y);",
          "  float fw = max(fwidth(rowF), fwidth(colF));",
          "  float fade = 1.0 - smoothstep(0.06, 0.32, fw);",
          "  float hn = masonHash(vec2(colI, rowI));",
          "  float k = 1.0 + (hn - 0.5) * uMason.w * fade;",
          "  k *= 1.0 - joint * 0.4 * fade * min(1.0, uMason.w * 2.5);",
          "  diffuseColor.rgb *= k;",
          "}",
        ].join("\n"),
      );
  };
  mat.customProgramCacheKey = () => "masonry-v1";
  return mat;
}

const std = (opts) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, ...opts });
const glowMaterial = () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

function canvasTexture(w, h, draw) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function groundPlane(size, color, material) {
  const g = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, material ?? new THREE.MeshStandardMaterial({ color, roughness: 1 }));
  mesh.receiveShadow = true;
  mesh.name = "ground";
  return mesh;
}

function countMeshes(obj) {
  let n = 0;
  obj.traverse((o) => {
    if (o.isMesh) n++;
  });
  return n;
}

function finish(id, structure, env, extra) {
  const group = new THREE.Group();
  group.name = id;
  structure.name = `${id}-structure`;
  env.name = `${id}-env`;
  group.add(structure, env);
  return { id, group, structure, env, setNight() {}, update() {}, animating: () => false, ...extra, meshCount: countMeshes(group) };
}

function trees(m, r, list, color = "#4a6a38") {
  for (const [x, z, s] of list) {
    m.put(GEO.cyl6, x, s * 0.35, z, s * 0.09, s * 0.7, s * 0.09, "#5b4a3a");
    m.put(GEO.ico, x, s * 0.95, z, s * 0.85, s * 0.9, s * 0.85, tint(color, r, 0.1));
  }
}

// ------------------------------------------------------------------ Eiffel Tower

const table = (t) => (h) => {
  if (h <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (h <= t[i][0]) {
      const k = (h - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * k;
    }
  }
  return t[t.length - 1][1];
};

function buildEiffel() {
  // Half-width of the outer profile, and the width of one leg, by height.
  const W = table([[0, 62.5], [10, 55.5], [20, 49.8], [30, 45], [40, 40.8], [50, 37.2], [57, 35], [70, 31.3], [85, 27.3], [100, 23.5], [115, 20.2], [130, 17.6], [150, 14.8], [175, 12.0], [200, 9.9], [225, 8.2], [250, 6.9], [276, 5.8]]);
  const Lraw = table([[0, 26], [20, 22], [40, 18.5], [57, 16.5], [85, 13.5], [115, 12], [135, 12.6], [150, 14.8]]);
  const L = (h) => Math.min(W(h), Lraw(h));
  const r = rng(3);
  const iron = new Merger();
  const stone = new Merger();
  const glow = new Merger();
  const CHORD = "#6a5642";
  const BRACE = "#7a6650";
  const DECK = "#85715a";
  const DARK = "#3a3028";
  const GLOW = "#ffc77a";

  // The four legs: a square lattice column each, curving in to meet above the second floor.
  const legLevels = [0, 7, 14, 21, 28, 35, 42, 49, 57, 64.5, 72, 79.5, 87, 94, 101, 108, 115, 123, 132, 141, 150];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const corner = (y, k) => {
        const o = W(y);
        const i = W(y) - L(y);
        const c = [[i, i], [o, i], [o, o], [i, o]][k & 3];
        return v3(sx * c[0], y, sz * c[1]);
      };
      for (let j = 0; j < legLevels.length - 1; j++) {
        const y0 = legLevels[j];
        const y1 = legLevels[j + 1];
        for (let k = 0; k < 4; k++) {
          const a0 = corner(y0, k);
          const b0 = corner(y0, k + 1);
          const a1 = corner(y1, k);
          const b1 = corner(y1, k + 1);
          iron.beam(a0, a1, 1.3, CHORD);
          const width = a0.distanceTo(b0);
          if (width < 0.8) continue;
          const nc = Math.max(1, Math.min(3, Math.round(width / 9)));
          for (let c = 0; c < nc; c++) {
            const p00 = a0.clone().lerp(b0, c / nc);
            const p01 = a0.clone().lerp(b0, (c + 1) / nc);
            const p10 = a1.clone().lerp(b1, c / nc);
            const p11 = a1.clone().lerp(b1, (c + 1) / nc);
            iron.beam(p00, p11, 0.42, BRACE);
            iron.beam(p01, p10, 0.42, BRACE);
            if (c > 0) iron.beam(p00, p10, 0.5, BRACE);
          }
          iron.beam(a1, b1, 0.6, BRACE);
        }
      }
      for (let k = 0; k < 4; k++) {
        const p = corner(0, k);
        stone.box(p.x, 1.1, p.z, 7, 2.2, 7, tint("#b9ad96", r, 0.05));
      }
    }
  }

  // The single shaft from 150 m to the top floor.
  for (let y = 150; y < 275.9; y += 9) {
    const y0 = y;
    const y1 = Math.min(276, y + 9);
    const cs = (yy) => {
      const w = W(yy);
      return [v3(-w, yy, -w), v3(w, yy, -w), v3(w, yy, w), v3(-w, yy, w)];
    };
    const A = cs(y0);
    const B = cs(y1);
    for (let k = 0; k < 4; k++) {
      const n = (k + 1) % 4;
      iron.beam(A[k], B[k], 1.1, CHORD);
      const width = A[k].distanceTo(A[n]);
      const nc = Math.max(1, Math.min(4, Math.round(width / 8)));
      for (let c = 0; c < nc; c++) {
        const p00 = A[k].clone().lerp(A[n], c / nc);
        const p01 = A[k].clone().lerp(A[n], (c + 1) / nc);
        const p10 = B[k].clone().lerp(B[n], c / nc);
        const p11 = B[k].clone().lerp(B[n], (c + 1) / nc);
        iron.beam(p00, p11, 0.36, BRACE);
        iron.beam(p01, p10, 0.36, BRACE);
      }
      iron.beam(B[k], B[n], 0.5, BRACE);
    }
  }

  // The decorative arches between the legs, with their spandrel lattice.
  const ys = 10;
  const ya = 39;
  const archThick = 3.4;
  const archPt = (phi, off) => {
    const s = -Math.cos(phi);
    const y = ys + off + (ya - ys) * Math.sin(phi);
    return [s * (W(y) - L(y)), y, W(y) - 1.6];
  };
  for (let side = 0; side < 4; side++) {
    const map = ([u, y, d]) => (side === 0 ? v3(u, y, d) : side === 1 ? v3(u, y, -d) : side === 2 ? v3(d, y, u) : v3(-d, y, u));
    const N = 30;
    const inner = [];
    const outer = [];
    const raw = [];
    for (let i = 0; i <= N; i++) {
      const phi = (Math.PI * i) / N;
      inner.push(map(archPt(phi, 0)));
      const o = archPt(phi, archThick);
      raw.push(o);
      outer.push(map(o));
    }
    for (let i = 0; i < N; i++) {
      iron.beam(inner[i], inner[i + 1], 0.95, CHORD);
      iron.beam(outer[i], outer[i + 1], 0.8, CHORD);
      iron.beam(inner[i], outer[i + 1], 0.32, BRACE);
      iron.beam(inner[i], outer[i], 0.32, BRACE);
    }
    const edge50 = W(50) - L(50) - 1.5;
    for (let i = 2; i <= N - 2; i += 2) {
      const [u, y, d] = raw[i];
      if (Math.abs(u) < edge50 && y < 48) iron.beam(map([u, y, d]), map([u, 50, W(50) - 1.6]), 0.42, BRACE);
    }
  }

  // Platforms.
  const ring = (m, P, y, h, depth, color) => {
    m.box(0, y, P - depth / 2, 2 * P, h, depth, color);
    m.box(0, y, -(P - depth / 2), 2 * P, h, depth, color);
    m.box(P - depth / 2, y, 0, depth, h, 2 * P - 2 * depth, color);
    m.box(-(P - depth / 2), y, 0, depth, h, 2 * P - 2 * depth, color);
  };
  const arcade = (m, P, y, h, count, color, out = 0.08) => {
    const span = 2 * (P - 1.5);
    for (let i = 0; i < count; i++) {
      const t = -span / 2 + ((i + 0.5) * span) / count;
      const w = (span / count) * 0.55;
      m.box(t, y, P + out, w, h, 0.3, color);
      m.box(t, y, -P - out, w, h, 0.3, color);
      m.box(P + out, y, t, 0.3, h, w, color);
      m.box(-P - out, y, t, 0.3, h, w, color);
    }
  };
  const P1 = W(53) + 1;
  ring(iron, P1, 53.6, 7, 2.6, DECK);
  arcade(iron, P1, 53.4, 4.2, 18, DARK);
  ring(iron, P1 + 0.7, 57.4, 0.9, 3.6, "#8e7b63");
  ring(iron, P1 - 0.3, 57.2, 0.6, 16, "#6e655a");
  for (const [x, z, sx, sz] of [[0, P1 - 9, 34, 6], [0, -(P1 - 9), 34, 6], [P1 - 9, 0, 6, 34], [-(P1 - 9), 0, 6, 34]]) iron.box(x, 59.6, z, sx, 4.2, sz, "#8fa2ab");
  ring(iron, P1 + 0.5, 58.7, 1.3, 0.25, "#4a3d31");
  ring(glow, P1 + 0.62, 58.2, 0.25, 0.1, GLOW);
  const P2 = W(113) + 0.8;
  ring(iron, P2, 112.4, 5, 2, DECK);
  arcade(iron, P2, 112.2, 3, 9, DARK);
  iron.box(0, 115.1, 0, 2 * P2 - 1, 0.8, 2 * P2 - 1, "#6e655a");
  ring(iron, P2 + 0.6, 115.6, 0.6, 2.4, "#8e7b63");
  ring(iron, P2 - 3, 117.8, 3.6, 3.5, "#5f6f78");
  ring(iron, P2 + 0.4, 116.6, 1.2, 0.25, "#4a3d31");
  ring(glow, P2 + 0.52, 116.2, 0.25, 0.1, GLOW);
  ring(glow, P2 - 1.2, 117.8, 1.6, 0.1, GLOW);

  // The top: enclosed floor, lantern, cap and antennas to 330 m.
  iron.box(0, 269.6, 0, 19, 0.8, 19, DECK);
  iron.box(0, 275, 0, 15, 10, 15, "#5d4c3b");
  for (const [x, z, sx, sz] of [[0, 7.55, 13, 0.2], [0, -7.55, 13, 0.2], [7.55, 0, 0.2, 13], [-7.55, 0, 0.2, 13]]) {
    iron.box(x, 275.5, z, sx, 3.2, sz, "#26313a");
    glow.box(x * 1.012, 275.5, z * 1.012, sx * 0.96, 2.6, sz * 0.96, GLOW);
  }
  ring(iron, 9.4, 270.6, 1.2, 0.2, "#4a3d31");
  iron.box(0, 280.6, 0, 18, 1.2, 18, DECK);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) iron.beam(v3(sx * 6.4, 281, sz * 6.4), v3(sx * 6.4, 286, sz * 6.4), 0.6, CHORD);
  ring(iron, 6.6, 283, 1.0, 0.2, "#4a3d31");
  iron.box(0, 290.5, 0, 8, 9, 8, "#5d4c3b");
  for (const [x, z, sx, sz] of [[0, 4.05, 5, 0.15], [0, -4.05, 5, 0.15], [4.05, 0, 0.15, 5], [-4.05, 0, 0.15, 5]]) {
    iron.box(x, 291, z, sx, 4.5, sz, "#26313a");
    glow.box(x * 1.02, 291, z * 1.02, sx * 0.9, 4, sz * 0.9, GLOW);
  }
  iron.put(GEO.cyl, 0, 297.5, 0, 6.5, 5, 6.5, DECK);
  iron.put(GEO.cyl, 0, 306, 0, 2.2, 12, 2.2, "#9a958c");
  iron.put(GEO.cyl, 0, 317, 0, 1.3, 10, 1.3, "#b3aea5");
  iron.put(GEO.cyl, 0, 326, 0, 0.6, 8, 0.6, "#c9c4bb");
  for (const a of [0, Math.PI / 2]) iron.box(0, 309 + a * 2, 0, 5.5, 0.4, 0.4, "#b3aea5", a);

  const ironMat = std({ roughness: 0.55, metalness: 0.25 });
  ironMat.emissive = new THREE.Color("#ff9a3c");
  ironMat.emissiveIntensity = 0;
  const stoneMat = masonry(std({ roughness: 0.9 }), { course: 0.55, block: 1.4, strength: 0.25 });
  const structure = new THREE.Group();
  structure.add(iron.mesh(ironMat, { name: "iron" }), stone.mesh(stoneMat, { name: "piers" }));
  const glowMesh = glow.mesh(glowMaterial(), { cast: false, receive: false, name: "glow" });
  glowMesh.visible = false;
  structure.add(glowMesh);

  // Beacon (night only).
  const beacon = new THREE.Group();
  beacon.position.set(0, 293, 0);
  const beamGeo = new THREE.ConeGeometry(48, 1600, 18, 1, true).translate(0, -800, 0).rotateZ(Math.PI / 2);
  const beamMat = new THREE.MeshBasicMaterial({ color: "#ffe6ad", transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false });
  for (const a of [0, Math.PI]) {
    const b = new THREE.Mesh(beamGeo, beamMat);
    b.rotation.y = a;
    b.rotation.z = -0.04;
    beacon.add(b);
  }
  beacon.visible = false;

  // Setting: Champ de Mars, the Seine, Trocadero and Paris blocks.
  const env = new THREE.Group();
  env.add(groundPlane(9000, "#8c877a"));
  const flat = new Merger();
  flat.box(0, 0.05, 0, 270, 0.1, 240, "#cbbf9f");
  for (const s of [-1, 1]) {
    flat.box(s * 60, 0.12, 540, 76, 0.12, 760, "#5e8a45");
    flat.box(s * 107, 0.08, 540, 20, 0.08, 780, "#c9bd9c");
  }
  flat.box(0, 0.08, 540, 44, 0.08, 760, "#cdbf9f");
  flat.box(0, 0.06, -150, 9000, 0.06, 26, "#5c5c5a");
  flat.box(0, 0.6, -178, 9000, 1.2, 5, "#b5ab98");
  flat.box(0, 0.6, -302, 9000, 1.2, 5, "#b5ab98");
  flat.box(0, 2.6, -240, 35, 1.6, 132, "#c2b7a2");
  for (const z of [-205, -240, -275]) flat.box(0, 1.2, z, 30, 2.4, 6, "#b3a892");
  flat.box(0, 0.08, -440, 280, 0.08, 230, "#cdbf9f");
  for (const s of [-1, 1]) flat.box(s * 80, 0.12, -420, 80, 0.12, 150, "#5e8a45");
  flat.box(0, 12, 990, 330, 24, 50, "#d6c9ae");
  flat.box(0, 26, 990, 320, 4, 44, "#5f6873");
  flat.put(GEO.cyl, 0, 32, 990, 22, 16, 22, "#5f6873");
  flat.box(0, 14, -560, 300, 28, 40, "#d9cfb9");
  const rc = rng(5);
  for (let gx = -1900; gx <= 1900; gx += 88) {
    for (let gz = -1900; gz <= 1900; gz += 88) {
      const x = gx + (rc() - 0.5) * 14;
      const z = gz + (rc() - 0.5) * 14;
      if (Math.hypot(x, z) > 1950) continue;
      if (Math.abs(x) < 190 && z > -175 && z < 1030) continue;
      if (z > -345 && z < -150) continue;
      if (Math.abs(x) < 240 && z < -150 && z > -620) continue;
      const w = 52 + rc() * 22;
      const d = 52 + rc() * 22;
      const h = 17 + rc() * 9;
      flat.box(x, h / 2, z, w, h, d, tint("#d8ccb2", rc, 0.1));
      flat.box(x, h + 2, z, w - 5, 4, d - 5, tint("#5f6873", rc, 0.06));
    }
  }
  const treeList = [];
  for (const x of [-100, -114, 100, 114]) for (let z = 140; z < 940; z += 12) treeList.push([x + (rc() - 0.5) * 2, z, 10 + rc() * 3]);
  for (let i = 0; i < 40; i++) treeList.push([(rc() - 0.5) * 240, -470 + (rc() - 0.5) * 140, 9 + rc() * 3]);
  for (const s of [-1, 1]) for (let x = -1800; x < 1800; x += 20) if (Math.abs(x) > 30) treeList.push([x, s > 0 ? -166 : -314, 9 + rc() * 2]);
  trees(flat, rc, treeList);
  env.add(flat.mesh(std({ roughness: 0.95 }), { name: "paris" }));
  const water = new Merger();
  water.box(0, 0.1, -240, 9000, 0.1, 119, "#2b4655");
  water.box(0, 0.16, -395, 50, 0.1, 110, "#2b4655");
  env.add(water.mesh(std({ roughness: 0.18, metalness: 0.1 }), { cast: false, name: "seine" }));

  const lamp = new THREE.PointLight("#ffb35c", 0, 260, 1.4);
  lamp.position.set(0, 30, 0);
  structure.add(lamp);
  env.add(beacon);

  const anchor = (x, y, z) => v3(x, y, z);
  return finish("eiffel", structure, env, {
    view: { target: v3(0, 150, 0), pos: v3(355, 100, 560), radius: 330, min: 40, max: 2600, focus: 140 },
    fog: [700, 3000],
    shadowHalf: 420,
    normalBias: 0.3,
    annotations: [
      { id: "antenna", label: "Antennas, to 330 m", pos: anchor(0, 318, 0), side: "right" },
      { id: "top", label: "Top floor, 276 m", pos: anchor(0, 275, 7.6), side: "left" },
      { id: "second", label: "Second platform, 115 m", pos: anchor(P2 * 0.4, 113, P2), side: "left" },
      { id: "first", label: "First floor, 57 m", pos: anchor(P1 * 0.55, 54, P1), side: "right" },
      { id: "arches", label: "Decorative arches", pos: anchor(0, ya + 1.5, W(ya) - 1.6), side: "left" },
      { id: "legs", label: "Lattice legs", pos: anchor(W(24) - L(24) * 0.5, 24, W(24)), side: "right" },
    ],
    setNight(k) {
      ironMat.emissiveIntensity = 0.55 * k;
      glowMesh.visible = k > 0.15;
      beacon.visible = k > 0.6;
      lamp.intensity = k * 3000;
    },
    animating: () => beacon.visible,
    update(dt) {
      if (beacon.visible) beacon.rotation.y += dt * 0.5;
    },
  });
}

// ------------------------------------------------------------------ Great Wall

function buildGreatWall() {
  const r = rng(7);
  const ridgeZ = (x) => 70 * Math.sin(x / 190 + 0.4) + 26 * Math.sin(x / 71 + 1.3);
  const ridgeH = (x) => 92 + 40 * Math.sin(x / 230 + 0.9) + 20 * Math.sin(x / 97 + 2.1) + 8 * Math.sin(x / 41 + 0.3);
  const spread = (x) => 125 + 35 * Math.sin(x / 310 + 2);
  const H = (x, z) => {
    const d = Math.abs(z - ridgeZ(x)) / spread(x);
    let h = ridgeH(x) * Math.exp(-Math.pow(d, 1.35));
    const d2 = (z - (-340 + 50 * Math.sin(x / 260))) / 150;
    h += 75 * Math.exp(-d2 * d2) * (0.75 + 0.25 * Math.sin(x / 150 + 1));
    const d3 = (z - (380 + 60 * Math.cos(x / 240))) / 170;
    h += 60 * Math.exp(-d3 * d3) * (0.7 + 0.3 * Math.cos(x / 180));
    h += 3.2 * Math.sin(x / 23 + z / 31) + 2.4 * Math.sin(x / 13 - z / 17) + 6 * Math.sin(x / 57) * Math.cos(z / 43);
    return h;
  };
  const forest = (x, z) => Math.sin(x / 37) * Math.cos(z / 29) + Math.sin((x + z) / 53) + 0.4 * Math.sin(x / 11 + z / 7);

  // Terrain heightfield.
  const tg = new THREE.PlaneGeometry(2400, 1800, 200, 150).rotateX(-Math.PI / 2);
  const P = tg.attributes.position;
  for (let i = 0; i < P.count; i++) P.setY(i, H(P.getX(i), P.getZ(i)));
  tg.computeVertexNormals();
  const N = tg.attributes.normal;
  const cols = new Float32Array(P.count * 3);
  const cLow = new THREE.Color("#6d7a45");
  const cHigh = new THREE.Color("#8a8a58");
  const cForest = new THREE.Color("#405a2e");
  const cRock = new THREE.Color("#8a7f6c");
  const c = new THREE.Color();
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i);
    const y = P.getY(i);
    const z = P.getZ(i);
    c.copy(cLow).lerp(cHigh, Math.min(1, Math.max(0, y / 150)));
    const f = forest(x, z);
    if (f > 0.5) c.lerp(cForest, Math.min(1, (f - 0.5) * 1.6));
    const slope = 1 - N.getY(i);
    if (slope > 0.16) c.lerp(cRock, Math.min(0.8, (slope - 0.16) * 3));
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  tg.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  const terrain = new THREE.Mesh(tg, std({ roughness: 0.97 }));
  terrain.receiveShadow = true;
  terrain.castShadow = true;
  terrain.name = "terrain";

  const env = new THREE.Group();
  env.add(terrain);
  const far = groundPlane(12000, "#59633f");
  far.position.y = -2;
  env.add(far);
  const treeM = new Merger();
  for (let i = 0; i < 1500; i++) {
    const x = (r() - 0.5) * 2200;
    const z = (r() - 0.5) * 1650;
    if (Math.abs(z - ridgeZ(x)) < 16) continue;
    const f = forest(x, z);
    if (f < 0.3 && r() > 0.15) continue;
    const s = 3.5 + r() * 3.5;
    treeM.put(GEO.cone, x, H(x, z) + s * 0.9, z, s * 1.2, s * 2.2, s * 1.2, tint("#38532a", r, 0.1));
  }
  env.add(treeM.mesh(std({ roughness: 0.95 }), { name: "trees" }));

  // The wall follows the ridge crest.
  const pts = [];
  for (let x = -720; x <= 720; x += 4) {
    const z = ridgeZ(x);
    pts.push(v3(x, H(x, z), z));
  }
  for (let i = 1; i < pts.length - 1; i++) pts[i].y = (pts[i - 1].y + 2 * pts[i].y + pts[i + 1].y) / 4;
  const WH = 7.2;
  const brick = new Merger();
  const pave = new Merger();
  const glow = new Merger();
  const WALL = "#a59c8b";
  const TOWER = "#ada391";
  const DARK = "#2c2824";
  const frames = [];
  let walked = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i].clone();
    a.y += WH;
    const b = pts[i + 1].clone();
    b.y += WH;
    const f = b.clone().sub(a);
    const len = f.length();
    f.divideScalar(len);
    const l = new THREE.Vector3().crossVectors(f, UP).normalize();
    const u = new THREE.Vector3().crossVectors(l, f).normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const at = (along, up, side) => mid.clone().addScaledVector(f, along).addScaledVector(u, up).addScaledVector(l, side);
    frames.push({ mid, f, u, l, at });
    brick.basis(GEO.box, at(0, -6.6, 0), f, u, l, len + 0.35, 13.2, 6.6, tint(WALL, r, 0.05));
    pave.basis(GEO.box, at(0, 0.12, 0), f, u, l, len + 0.3, 0.3, 5.3, tint("#a8a192", r, 0.04));
    brick.basis(GEO.box, at(0, 0.7, -2.95), f, u, l, len + 0.3, 1.4, 0.7, WALL);
    brick.basis(GEO.box, at(0, 0.5, 2.9), f, u, l, len + 0.3, 1.0, 0.55, WALL);
    const start = walked;
    walked += len;
    for (let m = Math.ceil(start / 2.3) * 2.3; m < walked; m += 2.3) {
      brick.basis(GEO.box, at(m - start - len / 2, 1.95, -2.95), f, u, l, 1.4, 1.1, 0.7, tint(WALL, r, 0.04));
    }
  }

  // Watchtowers on local high points.
  const towers = [];
  for (let i = 18; i < pts.length - 18; i += 36) {
    let best = i;
    for (let j = i - 8; j <= i + 8; j++) if (pts[j].y > pts[best].y) best = j;
    towers.push(best);
  }
  const towerTop = [];
  towers.forEach((ti, n) => {
    const p = pts[ti];
    const p0 = v3(p.x, p.y + WH, p.z);
    const fh = pts[ti + 1].clone().sub(pts[ti - 1]);
    fh.y = 0;
    fh.normalize();
    const lh = new THREE.Vector3().crossVectors(fh, UP).normalize();
    const tb = (along, up, side, sx, sy, sz, color, m = brick) =>
      m.basis(GEO.box, p0.clone().addScaledVector(fh, along).addScaledVector(UP, up).addScaledVector(lh, side), fh, UP, lh, sx, sy, sz, color);
    tb(0, -3.75, 0, 11, 24.5, 11, tint(TOWER, r, 0.04));
    for (const s of [-1, 1]) {
      for (const a of [-3.2, 0, 3.2]) {
        tb(a, 3.4, s * 5.56, 1.3, 2.3, 0.14, DARK);
        tb(a, 3.4, s * 5.64, 1.0, 1.9, 0.08, "#ffbf6a", glow);
      }
      tb(s * 5.56, 1.5, 0, 0.14, 3.0, 2.0, DARK);
      for (const a of [-3.2, 3.2]) {
        tb(s * 5.56, 3.4, a, 0.14, 2.3, 1.3, DARK);
        tb(s * 5.64, 3.4, a, 0.08, 1.9, 1.0, "#ffbf6a", glow);
      }
    }
    tb(0, 8.75, 0, 11.9, 0.5, 11.9, "#a39886");
    for (const s of [-1, 1]) {
      tb(0, 9.55, s * 5.65, 11.9, 1.1, 0.6, TOWER);
      tb(s * 5.65, 9.55, 0, 0.6, 1.1, 10.7, TOWER);
      for (const a of [-4.6, -2.3, 0, 2.3, 4.6]) {
        tb(a, 10.6, s * 5.65, 1.2, 1.0, 0.6, TOWER);
        tb(s * 5.65, 10.6, a, 0.6, 1.0, 1.2, TOWER);
      }
    }
    if (n % 2 === 0) {
      tb(0, 10.6, 0, 5.2, 3.2, 4.4, "#8b7f70");
      brick.basis(GEO.pyr, p0.clone().addScaledVector(UP, 13.3), fh, UP, lh, 6.6, 2.2, 5.6, "#5b5650");
    }
    towerTop.push({ p0, fh, lh });
  });

  const wallMat = masonry(std({ roughness: 0.92 }), { course: 0.5, block: 1.0, strength: 0.3 });
  const paveMat = masonry(std({ roughness: 0.9 }), { course: 0.8, block: 0.8, strength: 0.2 });
  const structure = new THREE.Group();
  structure.add(brick.mesh(wallMat, { name: "wall" }), pave.mesh(paveMat, { name: "walkway" }));
  const glowMesh = glow.mesh(glowMaterial(), { cast: false, receive: false, name: "glow" });
  glowMesh.visible = false;
  structure.add(glowMesh);

  // Annotations and camera around the tower nearest the middle.
  let mt = 0;
  towers.forEach((ti, k) => {
    if (Math.abs(pts[ti].x) < Math.abs(pts[towers[mt]].x)) mt = k;
  });
  const ti = towers[mt];
  const T = towerTop[mt];
  const fr = (i) => frames[Math.max(0, Math.min(frames.length - 1, i))];
  const target = T.p0.clone().add(v3(40, -6, 0));
  const camAt = fr(ti - 52).mid;
  const camPos = v3(camAt.x - 20, Math.max(camAt.y, T.p0.y) + 62, camAt.z - 95);
  return finish("wall", structure, env, {
    view: { target, pos: camPos, radius: 160, min: 15, max: 1600, focus: 55 },
    fog: [380, 1900],
    shadowHalf: 380,
    normalBias: 0.35,
    annotations: [
      { id: "tower", label: "Watchtower", pos: T.p0.clone().addScaledVector(UP, 11.5), side: "right" },
      { id: "crenels", label: "Crenellations", pos: fr(ti - 21).at(0, 2.1, -3.3), side: "left" },
      { id: "walkway", label: "Ridge walkway", pos: fr(ti - 11).at(0, 0.4, 0), side: "right" },
      { id: "inner", label: "Low inner parapet", pos: fr(ti + 12).at(0, 1.0, 3.0), side: "right" },
      { id: "ridge", label: "Following the ridge line", pos: fr(ti + 70).at(0, 3, 0), side: "left" },
    ],
    setNight(k) {
      glowMesh.visible = k > 0.15;
    },
  });
}

// ------------------------------------------------------------------ Hall of Supreme Harmony

/**
 * A curved Chinese roof band from an outer eave rectangle to an inner one (or a ridge when
 * inner.hz is 0): concave profile, corners lifted and flared.
 */
function roofBand({ outer, inner, rings = 12, perSide = 26, lift = 1.2, flare = 1.0, tileW = 0.9, tileH = 1.4 }) {
  const prof = (t) => 0.3 * t + 0.7 * t * t;
  const cols = perSide * 4 + 1;
  const pos = [];
  const uv = [];
  const corners = [[], [], [], []];
  const slant = Math.hypot(outer.hz - inner.hz, inner.y - outer.y);
  const before = [0, 2 * outer.hx, 2 * outer.hx + 2 * outer.hz, 4 * outer.hx + 2 * outer.hz];
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    const hx = outer.hx + (inner.hx - outer.hx) * t;
    const hz = outer.hz + (inner.hz - outer.hz) * t;
    const y = outer.y + (inner.y - outer.y) * prof(t);
    const cs = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];
    for (let ci = 0; ci < cols; ci++) {
      const side = Math.min(3, Math.floor(ci / perSide));
      const s = (ci - side * perSide) / perSide;
      const a = cs[side];
      const b = cs[(side + 1) % 4];
      let x = a[0] + (b[0] - a[0]) * s;
      let z = a[1] + (b[1] - a[1]) * s;
      const q = Math.min(s, 1 - s) * 2;
      const cw = Math.pow(Math.max(0, 1 - q / 0.5), 2);
      const fall = (1 - t) * (1 - t);
      const len = Math.hypot(x, z) || 1;
      x += (x / len) * flare * cw * fall;
      z += (z / len) * flare * cw * fall;
      const yy = y + lift * cw * fall;
      pos.push(x, yy, z);
      const sideLen = side % 2 === 0 ? 2 * outer.hx : 2 * outer.hz;
      uv.push((before[side] + s * sideLen) / tileW, (t * slant) / tileH);
      if (ci - side * perSide === 0 && ci < cols - 1) corners[side].push(v3(x, yy, z));
    }
  }
  let idx = [];
  for (let ri = 0; ri < rings; ri++) {
    for (let ci = 0; ci < cols - 1; ci++) {
      const a = ri * cols + ci;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const probe = Math.floor(perSide / 2) + cols;
  if (g.attributes.normal.getY(probe) < 0) {
    const flipped = [];
    for (let i = 0; i < idx.length; i += 3) flipped.push(idx[i], idx[i + 2], idx[i + 1]);
    idx = flipped;
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return { geometry: g, corners };
}

function buildHall() {
  const r = rng(11);
  const MARBLE = "#d6d1c6";
  const MARBLE_HI = "#e2ded5";
  const COL_RED = "#a3271d";
  const WALL_RED = "#93281e";
  const TEAL = "#2c5c63";
  const RIDGE = "#c48a1f";

  const marble = new Merger();
  const red = new Merger();
  const doors = new Merger();
  const brackets = new Merger();
  const deco = new Merger();
  const roofs = [];

  // Three-tier terrace with balustrades, spouts and stairs.
  const tiers = [
    { y0: 0, y1: 2.7, hx: 66, zN: -78, zS: 50 },
    { y0: 2.7, y1: 5.4, hx: 60, zN: -72, zS: 44 },
    { y0: 5.4, y1: 8.1, hx: 54, zN: -66, zS: 38 },
  ];
  const openings = [[-7.6, 7.6], [22.4, 29.6], [-29.6, -22.4]];
  for (const t of tiers) {
    const cz = (t.zN + t.zS) / 2;
    const dz = t.zS - t.zN;
    marble.box(0, (t.y0 + t.y1) / 2, cz, 2 * t.hx - 0.8, t.y1 - t.y0 - 0.8, dz - 0.8, MARBLE);
    marble.box(0, t.y1 - 0.2, cz, 2 * t.hx + 0.2, 0.4, dz + 0.2, MARBLE_HI);
    marble.box(0, t.y0 + 0.2, cz, 2 * t.hx + 0.2, 0.4, dz + 0.2, MARBLE);
    const ex = t.hx - 0.3;
    const edges = [
      { a: v3(-ex, 0, t.zS - 0.3), b: v3(ex, 0, t.zS - 0.3), n: v3(0, 0, 1), south: true },
      { a: v3(ex, 0, t.zN + 0.3), b: v3(-ex, 0, t.zN + 0.3), n: v3(0, 0, -1) },
      { a: v3(ex, 0, t.zS - 0.3), b: v3(ex, 0, t.zN + 0.3), n: v3(1, 0, 0) },
      { a: v3(-ex, 0, t.zN + 0.3), b: v3(-ex, 0, t.zS - 0.3), n: v3(-1, 0, 0) },
    ];
    for (const e of edges) {
      const len = e.a.distanceTo(e.b);
      const n = Math.round(len / 1.6);
      const along = e.b.clone().sub(e.a).normalize();
      const alongX = Math.abs(along.x) > 0.5;
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const p = e.a.clone().lerp(e.b, i / n);
        if (e.south && openings.some(([x0, x1]) => p.x > x0 - 0.4 && p.x < x1 + 0.4)) {
          prev = null;
          continue;
        }
        marble.box(p.x, t.y1 + 0.62, p.z, 0.26, 1.24, 0.26, MARBLE_HI);
        marble.box(p.x, t.y1 + 1.36, p.z, 0.36, 0.3, 0.36, MARBLE_HI);
        marble.box(p.x + e.n.x * 0.75, t.y1 - 0.3, p.z + e.n.z * 0.75, alongX ? 0.3 : 1.0, 0.3, alongX ? 1.0 : 0.3, MARBLE);
        if (prev) {
          const m = prev.clone().add(p).multiplyScalar(0.5);
          marble.box(m.x, t.y1 + 0.55, m.z, alongX ? len / n - 0.26 : 0.13, 0.72, alongX ? 0.13 : len / n - 0.26, MARBLE);
        }
        prev = p;
      }
    }
    // Stairs down the south face of the tier.
    const steps = 14;
    const rise = (t.y1 - t.y0) / steps;
    const run = 4.6 / steps;
    const flight = (x0, x1) => {
      for (let j = 1; j < steps; j++) {
        const top = t.y1 - j * rise;
        marble.box((x0 + x1) / 2, (t.y0 + top) / 2, t.zS + (j * run) / 2, x1 - x0, top - t.y0, j * run, tint(MARBLE, r, 0.03));
      }
    };
    const slab = (xc, width, thick, color) => {
      const a = v3(xc, t.y1, t.zS);
      const b = v3(xc, t.y0, t.zS + 4.6);
      const s = b.clone().sub(a);
      const slen = s.length();
      s.divideScalar(slen);
      const X = v3(1, 0, 0);
      const Y = new THREE.Vector3().crossVectors(s, X);
      marble.basis(GEO.box, a.clone().add(b).multiplyScalar(0.5).addScaledVector(Y, thick / 2 - 0.25), X, Y, s, width, thick, slen + 0.3, color);
    };
    flight(-7.2, -2.3);
    flight(2.3, 7.2);
    slab(0, 4.4, 0.7, "#ddd6c6");
    for (const x of [-7.45, -2.15, 2.15, 7.45]) slab(x, 0.5, 1.4, MARBLE_HI);
    for (const s of [-1, 1]) {
      flight(s > 0 ? 22.8 : -29.2, s > 0 ? 29.2 : -22.8);
      for (const x of [22.55, 29.45]) slab(s * x, 0.5, 1.4, MARBLE_HI);
    }
  }

  // The hall.
  const T = 8.1;
  const hz0 = -14;
  const T2 = T + 1.4;
  marble.box(0, T + 0.7, hz0, 64, 1.4, 37, MARBLE);
  marble.box(0, T2 - 0.12, hz0, 64.4, 0.24, 37.4, MARBLE_HI);
  const baysX = [4.5, 5, 5.2, 5.4, 5.6, 7.4, 5.6, 5.4, 5.2, 5, 4.5];
  const baysZ = [5.6, 6.6, 6.6, 6.6, 5.6];
  const xs = [-29.4];
  for (const b of baysX) xs.push(xs[xs.length - 1] + b);
  const zs = [hz0 - 15.5];
  for (const b of baysZ) zs.push(zs[zs.length - 1] + b);
  const colH = 9.3;
  for (const x of xs) {
    for (const z of zs) {
      red.put(GEO.cyl, x, T2 + colH / 2, z, 1.06, colH, 1.06, tint(COL_RED, r, 0.03));
      marble.box(x, T2 + 0.15, z, 1.6, 0.3, 1.6, MARBLE_HI);
    }
  }
  const wallH = colH - 0.3;
  red.box(0, T2 + wallH / 2, zs[0], 58.8, wallH, 1.2, WALL_RED);
  for (const s of [-1, 1]) red.box(s * 29.4, T2 + wallH / 2, (zs[0] + zs[4]) / 2, 1.2, wallH, zs[4] - zs[0], WALL_RED);
  for (let i = 0; i < baysX.length; i++) {
    const xm = (xs[i] + xs[i + 1]) / 2;
    const w = baysX[i];
    if (i === 0 || i === baysX.length - 1) {
      red.box(xm, T2 + wallH / 2, zs[4], w, wallH, 1.0, WALL_RED);
      doors.box(xm, T2 + 5.6, zs[4] + 0.52, w - 1.4, 3.2, 0.1, "#ffffff");
    } else {
      doors.box(xm, T2 + 4.5, zs[4], w - 1.1, 9.0, 0.35, "#ffffff");
    }
  }
  // Painted beams and bracket sets under the lower eaves.
  const lintelY = T2 + colH + 0.3;
  red.box(0, lintelY, zs[5], 60, 0.6, 0.9, TEAL);
  red.box(0, lintelY, zs[0], 60, 0.6, 0.9, TEAL);
  for (const s of [-1, 1]) red.box(s * 29.4, lintelY, hz0, 0.9, 0.6, 31.9, TEAL);
  const bY = lintelY + 0.9;
  for (let i = 0; i < baysX.length; i++) {
    const xm = (xs[i] + xs[i + 1]) / 2;
    brackets.box(xm, bY, zs[5] + 0.35, baysX[i], 1.2, 1.4, "#ffffff");
    brackets.box(xm, bY, zs[0] - 0.35, baysX[i], 1.2, 1.4, "#ffffff");
  }
  for (let i = 0; i < baysZ.length; i++) {
    const zm = (zs[i] + zs[i + 1]) / 2;
    for (const s of [-1, 1]) brackets.box(s * 29.75, bY, zm, 1.4, 1.2, baysZ[i], "#ffffff");
  }

  // Lower eaves (a skirt round the hall), the upper storey and the upper hip roof.
  const lowOuter = { hx: 33.4, hz: 19.4, y: T2 + colH + 0.9 };
  const upHx = 24.9;
  const upHz = 9.9;
  const lowInner = { hx: upHx, hz: upHz, y: T2 + colH + 3.6 };
  roofs.push(roofBand({ outer: lowOuter, inner: lowInner, rings: 8, perSide: 26, lift: 1.1, flare: 0.9 }));
  const ubBase = lowInner.y - 0.5;
  const ubTop = ubBase + 2.6;
  red.box(0, (ubBase + ubTop) / 2, hz0 + upHz, 2 * upHx, ubTop - ubBase, 0.8, WALL_RED);
  red.box(0, (ubBase + ubTop) / 2, hz0 - upHz, 2 * upHx, ubTop - ubBase, 0.8, WALL_RED);
  for (const s of [-1, 1]) red.box(s * upHx, (ubBase + ubTop) / 2, hz0, 0.8, ubTop - ubBase, 2 * upHz, WALL_RED);
  red.box(0, ubTop + 0.25, hz0 + upHz + 0.1, 2 * upHx + 0.6, 0.5, 0.9, TEAL);
  red.box(0, ubTop + 0.25, hz0 - upHz - 0.1, 2 * upHx + 0.6, 0.5, 0.9, TEAL);
  for (const s of [-1, 1]) red.box(s * (upHx + 0.1), ubTop + 0.25, hz0, 0.9, 0.5, 2 * upHz + 0.6, TEAL);
  const ubY = ubTop + 1.05;
  for (let i = 0; i < 10; i++) {
    const xm = -upHx + (i + 0.5) * (2 * upHx) / 10;
    brackets.box(xm, ubY, hz0 + upHz + 0.4, (2 * upHx) / 10, 1.1, 1.3, "#ffffff");
    brackets.box(xm, ubY, hz0 - upHz - 0.4, (2 * upHx) / 10, 1.1, 1.3, "#ffffff");
  }
  for (let i = 0; i < 4; i++) {
    const zm = hz0 - upHz + (i + 0.5) * (2 * upHz) / 4;
    for (const s of [-1, 1]) brackets.box(s * (upHx + 0.4), ubY, zm, 1.3, 1.1, (2 * upHz) / 4, "#ffffff");
  }
  const upOuter = { hx: upHx + 4.0, hz: upHz + 4.0, y: ubY + 0.2 };
  const ridgeY = 32.0;
  const upInner = { hx: upOuter.hx - upOuter.hz, hz: 0, y: ridgeY };
  roofs.push(roofBand({ outer: upOuter, inner: upInner, rings: 14, perSide: 30, lift: 1.5, flare: 1.2 }));

  // Ridges, roof figures and the ridge-end ornaments.
  const lifted = (p, dy) => v3(p.x, p.y + dy, p.z + hz0);
  for (const roof of roofs) {
    for (const line of roof.corners) {
      for (let i = 0; i < line.length - 1; i++) deco.beam(lifted(line[i], 0.3), lifted(line[i + 1], 0.3), 0.7, RIDGE);
      let walked = 0;
      let next = 1.0;
      let placed = 0;
      for (let i = 0; i < line.length - 1 && placed < 10; i++) {
        const seg = line[i].distanceTo(line[i + 1]);
        while (walked + seg >= next && placed < 10) {
          const p = line[i].clone().lerp(line[i + 1], (next - walked) / seg);
          deco.box(p.x, p.y + 0.9, p.z + hz0, 0.34, 0.55, 0.34, "#d8a63a");
          placed++;
          next += 0.55;
        }
        walked += seg;
      }
    }
  }
  deco.box(0, ridgeY + 0.55, hz0, 2 * upInner.hx + 0.4, 1.1, 0.9, RIDGE);
  for (const s of [-1, 1]) {
    deco.box(s * (upInner.hx + 0.1), ridgeY + 1.9, hz0, 0.9, 2.2, 2.0, RIDGE);
    deco.box(s * (upInner.hx - 0.35), ridgeY + 2.75, hz0, 0.7, 0.55, 1.4, RIDGE);
  }
  deco.box(0, lowInner.y + 0.25, hz0 + upHz + 0.5, 2 * upHx + 1, 0.5, 0.7, RIDGE);
  deco.box(0, lowInner.y + 0.25, hz0 - upHz - 0.5, 2 * upHx + 1, 0.5, 0.7, RIDGE);
  for (const s of [-1, 1]) deco.box(s * (upHx + 0.5), lowInner.y + 0.25, hz0, 0.7, 0.5, 2 * upHz + 1, RIDGE);

  // Textures drawn on canvases.
  const tileTex = canvasTexture(64, 64, (g, w, h) => {
    g.fillStyle = "#d9a12a";
    g.fillRect(0, 0, w, h);
    const grad = g.createLinearGradient(6, 0, w, 0);
    grad.addColorStop(0, "#f2c65e");
    grad.addColorStop(0.5, "#e6ad35");
    grad.addColorStop(1, "#c48a1f");
    g.fillStyle = grad;
    g.fillRect(8, 0, w - 8, h);
    g.fillStyle = "#8a5c12";
    g.fillRect(0, 0, 7, h);
    g.fillStyle = "rgba(120,80,10,0.45)";
    for (let y = 0; y < h; y += 16) g.fillRect(8, y, w - 8, 2);
  });
  const doorTex = canvasTexture(128, 256, (g, w, h) => {
    g.fillStyle = "#8c2a1b";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#d4a645";
    g.lineWidth = 2;
    for (let leaf = 0; leaf < 4; leaf++) {
      const x0 = (leaf * w) / 4 + 4;
      const lw = w / 4 - 8;
      g.strokeRect(x0, 8, lw, h * 0.56);
      g.save();
      g.beginPath();
      g.rect(x0, 8, lw, h * 0.56);
      g.clip();
      g.lineWidth = 1.5;
      for (let d = -h; d < h; d += 9) {
        g.beginPath();
        g.moveTo(x0 + d, 8);
        g.lineTo(x0 + d + h, 8 + h);
        g.moveTo(x0 + d + lw, 8);
        g.lineTo(x0 + d + lw - h, 8 + h);
        g.stroke();
      }
      g.restore();
      g.strokeRect(x0, h * 0.62, lw, h * 0.14);
      g.strokeRect(x0, h * 0.8, lw, h * 0.16);
    }
  });
  const bracketTex = canvasTexture(256, 64, (g, w, h) => {
    g.fillStyle = "#1d434b";
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) {
      const cx = (i + 0.5) * (w / 4);
      g.fillStyle = "#2f6f95";
      g.fillRect(cx - 8, h - 20, 16, 14);
      g.fillStyle = "#3d8a5a";
      g.fillRect(cx - 26, h - 34, 52, 10);
      g.fillStyle = "#2f6f95";
      g.fillRect(cx - 16, h - 48, 32, 10);
      g.fillStyle = "#3d8a5a";
      g.fillRect(cx - 30, h - 60, 60, 9);
      g.strokeStyle = "#d8b45a";
      g.lineWidth = 1.5;
      g.strokeRect(cx - 26, h - 34, 52, 10);
      g.strokeRect(cx - 30, h - 60, 60, 9);
    }
    g.fillStyle = "#264f58";
    g.fillRect(0, h - 6, w, 6);
  });

  const marbleMat = masonry(std({ roughness: 0.7 }), { course: 0.9, block: 1.8, strength: 0.12 });
  const redMat = std({ roughness: 0.6 });
  const doorMat = std({ map: doorTex, roughness: 0.6, emissiveMap: doorTex, emissive: new THREE.Color("#000000") });
  const bracketMat = std({ map: bracketTex, roughness: 0.7 });
  const roofMat = new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.42, metalness: 0.08 });
  const soffitMat = new THREE.MeshStandardMaterial({ color: "#36534d", roughness: 0.85, side: THREE.BackSide });
  const decoMat = std({ roughness: 0.45 });

  const structure = new THREE.Group();
  structure.add(
    marble.mesh(marbleMat, { name: "terrace" }),
    red.mesh(redMat, { name: "timber" }),
    doors.mesh(doorMat, { name: "doors" }),
    brackets.mesh(bracketMat, { name: "brackets" }),
    deco.mesh(decoMat, { name: "ridges" }),
  );
  for (const roof of roofs) {
    const top = new THREE.Mesh(roof.geometry, roofMat);
    const under = new THREE.Mesh(roof.geometry, soffitMat);
    for (const m of [top, under]) {
      m.position.z = hz0;
      m.castShadow = true;
      m.receiveShadow = true;
      structure.add(m);
    }
  }

  // Setting: the paved courtyard, the side galleries and the gate to the south.
  const env = new THREE.Group();
  const groundMat = masonry(new THREE.MeshStandardMaterial({ color: "#a59e92", roughness: 0.95 }), { course: 1.1, block: 1.1, mortar: 0.05, strength: 0.18 });
  env.add(groundPlane(6000, null, groundMat));
  const ctx = new Merger();
  ctx.box(0, 0.06, 160, 9, 0.12, 230, "#c9c3b6");
  for (const s of [-1, 1]) {
    ctx.box(s * 152, 1, 70, 18, 2, 330, MARBLE);
    ctx.box(s * 152, 5.5, 70, 13, 7, 324, WALL_RED);
    ctx.put(GEO.prism, s * 152, 10.6, 70, 17, 3.2, 328, "#d6a032");
    ctx.box(s * 152, 9.2, 70, 16, 0.5, 327, TEAL);
  }
  ctx.box(0, 1.5, 270, 70, 3, 28, MARBLE);
  ctx.box(0, 9, 270, 54, 12, 18, WALL_RED);
  ctx.box(0, 15.4, 270, 56, 0.8, 20, TEAL);
  ctx.box(0, 6, -170, 300, 12, 14, WALL_RED);
  ctx.put(GEO.prism, 0, 13.6, -170, 18, 3.4, 302, "#d6a032", Math.PI / 2);
  const gateRoof = roofBand({ outer: { hx: 31, hz: 13, y: 16 }, inner: { hx: 18, hz: 0, y: 22 }, rings: 8, perSide: 16, lift: 0.9, flare: 0.8 });
  const gate = new THREE.Mesh(gateRoof.geometry, roofMat);
  gate.position.z = 270;
  gate.castShadow = true;
  const gateUnder = new THREE.Mesh(gateRoof.geometry, soffitMat);
  gateUnder.position.z = 270;
  env.add(ctx.mesh(std({ roughness: 0.8 }), { name: "courtyard" }), gate, gateUnder);

  const lamps = [];
  for (const [x, z] of [[-30, 30], [30, 30], [0, 70]]) {
    const l = new THREE.PointLight("#ffb065", 0, 140, 1.6);
    l.position.set(x, 20, z);
    lamps.push(l);
    structure.add(l);
  }

  return finish("hall", structure, env, {
    view: { target: v3(-2, 15, -4), pos: v3(-66, 30, 92), radius: 70, min: 12, max: 900, focus: 40 },
    fog: [500, 2200],
    shadowHalf: 110,
    normalBias: 0.08,
    annotations: [
      { id: "roof", label: "Double-eaved hip roof", pos: v3(-6, 29.4, hz0 + 8.4), side: "right" },
      { id: "guardians", label: "Ten roof guardians", pos: v3(-upOuter.hx + 1.6, upOuter.y + 2.1, hz0 + upOuter.hz - 1.2), side: "left" },
      { id: "brackets", label: "Bracket sets (dougong)", pos: v3(14, bY, zs[5] + 1.1), side: "right" },
      { id: "columns", label: "Red columns, 11 bays", pos: v3(-21, T2 + 5, zs[5] + 0.6), side: "left" },
      { id: "terrace", label: "Three-tier marble terrace", pos: v3(-60, 4.6, 44), side: "left" },
      { id: "ramp", label: "Carved imperial ramp", pos: v3(0, 2.0, 52), side: "right" },
    ],
    setNight(k) {
      doorMat.emissive.set(k > 0 ? "#ffa64d" : "#000000");
      doorMat.emissiveIntensity = 0.9 * k;
      for (const l of lamps) l.intensity = 260 * k;
    },
  });
}

// ------------------------------------------------------------------ Colosseum

function archPanel(w, h, ow, spring, depth) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(-ow / 2, 0);
  s.lineTo(-ow / 2, spring);
  s.absarc(0, spring, ow / 2, Math.PI, 0, true);
  s.lineTo(ow / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h);
  s.lineTo(-w / 2, h);
  s.lineTo(-w / 2, 0);
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 10 }).translate(0, 0, -depth);
}

function atticPanel(w, h, depth, win) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2, h);
  s.lineTo(-w / 2, h);
  s.lineTo(-w / 2, 0);
  if (win) {
    const p = new THREE.Path();
    p.moveTo(-0.7, 4.3);
    p.lineTo(0.7, 4.3);
    p.lineTo(0.7, 6.3);
    p.lineTo(-0.7, 6.3);
    p.lineTo(-0.7, 4.3);
    s.holes.push(p);
  }
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false }).translate(0, 0, -depth);
}

function buildColosseum() {
  const r = rng(19);
  const A = 94.5;
  const B = 78;
  const NB = 80;
  const TW = 6.8;
  const E = (th, off = 0, y = 0) => v3((A + off) * Math.cos(th), y, -(B + off) * Math.sin(th));
  // 80 bays of equal length round the outer ellipse.
  const M = 2048;
  const cum = new Float64Array(M + 1);
  {
    let p = E(0);
    for (let i = 1; i <= M; i++) {
      const q = E((i / M) * TAU);
      cum[i] = cum[i - 1] + p.distanceTo(q);
      p = q;
    }
  }
  const thetas = [];
  for (let b = 0; b <= NB; b++) {
    const goal = (cum[M] * b) / NB;
    let lo = 0;
    let hi = M;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < goal) lo = mid;
      else hi = mid;
    }
    const k = (goal - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
    thetas.push(((lo + k) / M) * TAU);
  }
  const deg = (th) => ((th * 180) / Math.PI + 360) % 360;
  const bayOf = (th) => {
    const t = ((th % TAU) + TAU) % TAU;
    for (let b = 0; b < NB; b++) if (t >= thetas[b] && t < thetas[b + 1]) return b;
    return NB - 1;
  };
  const frame = (b, off) => {
    const p0 = E(thetas[b], off);
    const p1 = E(thetas[b + 1], off);
    const c = p1.clone().sub(p0);
    const w = c.length();
    c.divideScalar(w);
    const n = new THREE.Vector3().crossVectors(c, UP).normalize();
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    return { c, n, w, mid };
  };
  const center = (fr, radial, y) => v3(fr.mid.x + fr.n.x * radial, y, fr.mid.z + fr.n.z * radial);

  const trav = new Merger();
  const brick = new Merger();
  const glow = new Merger();
  const TRAV = "#d5c6a7";
  const TRAV_D = "#bcae90";
  const BRICK = "#9a6a4e";
  const TUFF = "#a48e74";
  const GLOW = "#ffb866";

  const state = [];
  for (let b = 0; b < NB; b++) {
    const dc = deg((thetas[b] + thetas[b + 1]) / 2);
    state.push(dc >= 12 && dc <= 172 ? "full" : "stub");
  }
  for (let b = 0; b < NB; b++) {
    if (state[b] !== "stub") continue;
    if (state[(b + 1) % NB] === "full" || state[(b + NB - 1) % NB] === "full") state[b] = "partial";
  }

  // Outer ring: three arcaded storeys and the attic.
  const L1 = archPanel(TW, 10.5, 4.2, 5.3, 2.4);
  const L2 = archPanel(TW, 10.3, 4.2, 4.4, 2.4);
  const L3 = archPanel(TW, 10.3, 4.2, 4.1, 2.4);
  const ATW = atticPanel(TW, 12.4, 2.4, true);
  const AT = atticPanel(TW, 12.4, 2.4, false);
  const band = (fr, y0, y1, proud, color, m = trav) => m.basis(GEO.box, center(fr, proud - 1.45, (y0 + y1) / 2), fr.c, UP, fr.n, fr.w + 0.02, y1 - y0, 2.9, color);
  const panel = (geo, fr, y, color, m = trav, depth = 1) => m.basis(geo, center(fr, 0, y), fr.c, UP, fr.n, fr.w / TW, 1, depth, color);
  const tangentAt = (th, off) => {
    const t = E(th + 0.002, off).sub(E(th - 0.002, off)).normalize();
    return { t, n: new THREE.Vector3().crossVectors(t, UP).normalize() };
  };
  for (let b = 0; b < NB; b++) {
    const fr = frame(b, 0);
    const st = state[b];
    if (st === "stub") {
      const th = thetas[b];
      const { t, n } = tangentAt(th, 0);
      const p = E(th, -1.2);
      const h = 0.8 + r() * 2.6;
      trav.basis(GEO.box, v3(p.x, h / 2, p.z), t, UP, n, 2.6, h, 2.4, tint(TRAV_D, r, 0.06));
      continue;
    }
    const col = tint(TRAV, r, 0.05);
    panel(L1, fr, 0, tint(TRAV_D, r, 0.04));
    band(fr, 9.0, 10.5, 0.5, col);
    glow.basis(GEO.box, center(fr, -3.6, 4), fr.c, UP, fr.n, fr.w * 0.8, 7, 0.1, GLOW);
    if (st === "full") {
      band(fr, 10.5, 12.0, 0.3, col);
      panel(L2, fr, 12.0, col);
      band(fr, 20.6, 22.3, 0.5, col);
      band(fr, 22.3, 23.7, 0.3, col);
      panel(L3, fr, 23.7, col);
      band(fr, 32.4, 34.0, 0.5, col);
      panel(b % 2 ? ATW : AT, fr, 34.0, col);
      band(fr, 46.4, 48.0, 0.8, tint(TRAV, r, 0.04));
      trav.basis(GEO.box, center(fr, 0.4, 44.6), fr.c, UP, fr.n, 0.6, 0.9, 0.8, col);
      glow.basis(GEO.box, center(fr, -3.6, 15.5), fr.c, UP, fr.n, fr.w * 0.8, 6.5, 0.1, GLOW);
      glow.basis(GEO.box, center(fr, -3.6, 27), fr.c, UP, fr.n, fr.w * 0.8, 6.5, 0.1, GLOW);
      for (const y of [10.5, 22.3, 34]) trav.basis(GEO.box, center(fr, -2.8, y - 0.4), fr.c, UP, fr.n, fr.w + 0.1, 0.8, 5.6, TRAV_D);
    }
  }
  // Half-columns and pilasters on the bay boundaries of the standing wall.
  for (let b = 0; b < NB; b++) {
    const left = state[(b + NB - 1) % NB];
    const right = state[b];
    if (left === "stub" && right === "stub") continue;
    const full = left === "full" && right === "full";
    const th = thetas[b];
    const p = E(th, 0.1);
    const { t, n } = tangentAt(th, 0);
    const col = tint(TRAV, r, 0.04);
    trav.put(GEO.cyl, p.x, 4.5, p.z, 1.1, 9.0, 1.1, col);
    trav.basis(GEO.box, v3(p.x, 0.2, p.z), t, UP, n, 1.4, 0.4, 1.4, col);
    trav.basis(GEO.box, v3(p.x, 8.75, p.z), t, UP, n, 1.4, 0.5, 1.4, col);
    if (!full) continue;
    for (const [y0, y1] of [[12.0, 20.6], [23.7, 32.4]]) {
      trav.put(GEO.cyl, p.x, (y0 + y1) / 2, p.z, 1.0, y1 - y0, 1.0, col);
      trav.basis(GEO.box, v3(p.x, y1 - 0.3, p.z), t, UP, n, 1.4, 0.6, 1.4, col);
    }
    const pp = E(th, 0.15);
    trav.basis(GEO.box, v3(pp.x, 40.2, pp.z), t, UP, n, 0.9, 12.4, 0.5, col);
  }
  // Brick buttresses at both ends of the standing outer wall.
  const buttressShape = new THREE.Shape();
  buttressShape.moveTo(0, 0);
  buttressShape.lineTo(12, 0);
  buttressShape.lineTo(3, 44);
  buttressShape.lineTo(0, 44);
  buttressShape.lineTo(0, 0);
  const buttressGeo = new THREE.ExtrudeGeometry(buttressShape, { depth: 6, bevelEnabled: false }).translate(0, 0, -3);
  const buttressAt = [];
  for (let b = 0; b < NB; b++) {
    const here = state[b] === "full";
    const prev = state[(b + NB - 1) % NB] === "full";
    if (here === prev) continue;
    const th = thetas[b];
    const dir = here ? -1 : 1;
    const t = E(th + dir * 0.01, -2.5).sub(E(th, -2.5)).normalize();
    const n = new THREE.Vector3().crossVectors(t, UP).normalize();
    const p = E(th, -2.5);
    brick.basis(buttressGeo, p, t, UP, n, 1, 1, 1, BRICK);
    buttressAt.push(E(th + dir * 0.03, 1, 22));
  }

  // Second ring (exposed on the south side) and the solid third ring.
  const R2 = -5.5;
  const R2L1 = archPanel(TW, 10.5, 4.0, 5.2, 2.0);
  const R2L2 = archPanel(TW, 11.8, 4.0, 5.6, 2.0);
  const R2L3 = archPanel(TW, 11.7, 4.0, 5.4, 2.0);
  const ring2Top = [];
  for (let b = 0; b < NB; b++) {
    const fr = frame(b, R2);
    const dc = deg((thetas[b] + thetas[b + 1]) / 2);
    const covered = dc >= 8 && dc <= 176;
    const col = tint(TRAV_D, r, 0.07);
    panel(R2L1, fr, 0, col);
    panel(R2L2, fr, 10.5, col);
    let top = 22.3;
    if (covered) {
      panel(R2L3, fr, 22.3, col);
      top = 34;
    } else {
      trav.basis(GEO.box, center(fr, 0.8, 10.2), fr.c, UP, fr.n, fr.w * 0.97, 0.7, 1.6, col);
      trav.basis(GEO.box, center(fr, 0.8, 22.0), fr.c, UP, fr.n, fr.w * 0.97, 0.7, 1.6, col);
      if (r() < 0.35) {
        const h = 1 + r() * 3;
        trav.basis(GEO.box, center(fr, -1, 22.3 + h / 2), fr.c, UP, fr.n, fr.w, h, 2.0, col);
        top = 22.3 + h;
      }
      glow.basis(GEO.box, center(fr, -3.2, 4), fr.c, UP, fr.n, fr.w * 0.8, 7, 0.1, GLOW);
      glow.basis(GEO.box, center(fr, -3.2, 15), fr.c, UP, fr.n, fr.w * 0.8, 6.5, 0.1, GLOW);
    }
    ring2Top.push(top);
  }

  // Arena, podium and the stepped cavea.
  const a0 = 43.5;
  const b0 = 27.5;
  const NS = 160;
  const P = (th, d, y) => v3((a0 + d) * Math.cos(th), y, -(b0 + d) * Math.sin(th));
  const seats = new Quads();
  const c1 = new THREE.Color(TRAV_D);
  const c2 = new THREE.Color(BRICK);
  const cpod = new THREE.Color("#d2c9b8");
  const steps = [];
  {
    let d = 2;
    let y = 4;
    for (let k = 0; k < 22; k++) {
      const wide = k === 7 || k === 14;
      const run = wide ? 3.2 : 1.555;
      const rise = wide ? 2.6 : 1.12;
      steps.push({ d0: d, d1: d + run, y0: y, y1: y + rise });
      d += run;
      y += rise;
    }
  }
  const cavTop = steps[steps.length - 1].y1;
  const dEnd = steps[steps.length - 1].d1;
  const inward = (th) => v3(-Math.cos(th) / (a0 + 20), 0, Math.sin(th) / (b0 + 20)).normalize();
  for (let j = 0; j < NS; j++) {
    const t0 = (j / NS) * TAU;
    const t1 = ((j + 1) / NS) * TAU;
    const tm = (t0 + t1) / 2;
    const inw = inward(tm);
    steps.forEach((s, k) => {
      const hsh = Math.abs(Math.sin(Math.floor(j / 3) * 12.9898 + Math.floor(k / 2) * 78.233) * 43758.5453) % 1;
      const cc = c1.clone().lerp(c2, hsh < 0.3 ? 0.75 : hsh < 0.5 ? 0.35 : 0.05).offsetHSL(0, 0, (r() - 0.5) * 0.05);
      seats.quad(P(t0, s.d0, s.y0), P(t1, s.d0, s.y0), P(t1, s.d0, s.y1), P(t0, s.d0, s.y1), cc.clone().multiplyScalar(0.85), inw);
      seats.quad(P(t0, s.d0, s.y1), P(t1, s.d0, s.y1), P(t1, s.d1, s.y1), P(t0, s.d1, s.y1), cc, UP);
    });
    // Podium wall and the open pit edge.
    seats.quad(P(t0, 0, -6), P(t1, 0, -6), P(t1, 0, 4), P(t0, 0, 4), cpod, inw);
    seats.quad(P(t0, 0, 4), P(t1, 0, 4), P(t1, 2, 4), P(t0, 2, 4), cpod, UP);
    // Upper seating between the third ring and the second ring.
    const b = bayOf(tm);
    const dc = deg(tm);
    const outerY = dc >= 8 && dc <= 176 ? 34 : ring2Top[b];
    const d2 = Math.min(A + R2 - a0, B + R2 - b0) - 1.2;
    const cc = c2.clone().offsetHSL(0, 0, (r() - 0.5) * 0.08);
    seats.quad(P(t0, dEnd, cavTop), P(t1, dEnd, cavTop), P(t1, d2, outerY), P(t0, d2, outerY), cc, UP);
  }
  for (let b = 0; b < NB; b += 4) {
    const th = thetas[b];
    brick.beam(P(th, 2.5, 5.2), P(th, dEnd - 0.5, cavTop + 1.0), 1.1, tint(BRICK, r, 0.06));
  }
  for (let b = 0; b < NB; b++) {
    const fr = frame(b, -11.5);
    brick.basis(GEO.box, center(fr, -1.1, cavTop / 2), fr.c, UP, fr.n, fr.w + 0.1, cavTop, 2.2, tint(TUFF, r, 0.06));
  }
  // Hypogeum walls and the rebuilt section of floor.
  const pitShape = new THREE.Shape();
  pitShape.absellipse(0, 0, a0, b0, 0, TAU, false, 0);
  const pit = new THREE.Mesh(new THREE.ShapeGeometry(pitShape, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#7a624f", roughness: 1 }));
  pit.position.y = -6;
  pit.receiveShadow = true;
  for (let k = -7; k <= 7; k++) {
    if (k === 0) continue;
    const z = k * 3.4;
    const xe = a0 * Math.sqrt(Math.max(0, 1 - (z / b0) ** 2)) - 0.8;
    let x = -xe;
    while (x < xe - 1) {
      const seg = Math.min(xe - x, 5 + r() * 8);
      brick.box(x + seg / 2, -3.2, z, seg, 5.6, 0.9, tint(BRICK, r, 0.08));
      x += seg + 1.6;
    }
  }
  for (let x = -36; x <= 36; x += 9) brick.box(x, -3.2, 0, 0.9, 5.6, 2 * b0 * Math.sqrt(Math.max(0, 1 - (x / a0) ** 2)) - 3, tint(BRICK, r, 0.08));
  const floorShape = new THREE.Shape();
  const phi0 = Math.acos(16 / a0);
  for (let i = 0; i <= 32; i++) {
    const phi = -phi0 + (2 * phi0 * i) / 32;
    const x = a0 * Math.cos(phi) - 0.3;
    const y = b0 * Math.sin(phi) * 0.985;
    if (i === 0) floorShape.moveTo(x, y);
    else floorShape.lineTo(x, y);
  }
  floorShape.lineTo(16, b0 * Math.sin(-phi0) * 0.985);
  const floorGeo = new THREE.ExtrudeGeometry(floorShape, { depth: 0.6, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, -0.6, 0);
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ color: "#a17852", roughness: 0.85 }));
  floor.castShadow = true;
  floor.receiveShadow = true;

  const travMat = masonry(std({ roughness: 0.9 }), { course: 0.65, block: 1.5, strength: 0.28 });
  const brickMat = masonry(std({ roughness: 0.95 }), { course: 0.35, block: 0.8, strength: 0.25 });
  const seatMat = std({ roughness: 0.95 });
  const structure = new THREE.Group();
  structure.add(trav.mesh(travMat, { name: "travertine" }), brick.mesh(brickMat, { name: "brick" }), seats.mesh(seatMat), pit, floor);
  const glowMesh = glow.mesh(glowMaterial(), { cast: false, receive: false, name: "glow" });
  glowMesh.visible = false;
  structure.add(glowMesh);

  // Setting: paving, the ring road, a park and Roman blocks.
  const env = new THREE.Group();
  env.add(groundPlane(9000, "#9a9284"));
  const flat = new Quads();
  const cPave = new THREE.Color("#c4b8a2");
  const cRoad = new THREE.Color("#5d5c59");
  for (let j = 0; j < 120; j++) {
    const t0 = (j / 120) * TAU;
    const t1 = ((j + 1) / 120) * TAU;
    flat.quad(E(t0, 1, 0.04), E(t1, 1, 0.04), E(t1, 40, 0.04), E(t0, 40, 0.04), cPave, UP);
    flat.quad(E(t0, 40, 0.05), E(t1, 40, 0.05), E(t1, 58, 0.05), E(t0, 58, 0.05), cRoad, UP);
  }
  for (let j = 0; j < 160; j++) {
    const t0 = (j / 160) * TAU;
    const t1 = ((j + 1) / 160) * TAU;
    flat.quad(E(t0, -12, 0.03), E(t1, -12, 0.03), E(t1, 1, 0.03), E(t0, 1, 0.03), cPave.clone().multiplyScalar(0.92), UP);
  }
  env.add(flat.mesh(std({ roughness: 0.95 }), { cast: false }));
  const ctx = new Merger();
  ctx.box(300, 0.1, -290, 360, 0.1, 280, "#5f8645");
  const rc = rng(23);
  const pines = [];
  for (let i = 0; i < 70; i++) pines.push([140 + rc() * 320, -150 - rc() * 280, 11 + rc() * 4]);
  for (let i = 0; i < 26; i++) {
    const th = rc() * TAU;
    const p = E(th, 66 + rc() * 10);
    pines.push([p.x, p.z, 10 + rc() * 3]);
  }
  for (const [x, z, s] of pines) {
    ctx.put(GEO.cyl6, x, s * 0.4, z, 0.7, s * 0.8, 0.7, "#5b4a3a");
    ctx.put(GEO.ico, x, s * 0.85, z, s * 1.05, s * 0.4, s * 1.05, tint("#3f5b31", rc, 0.1));
  }
  const roman = ["#c98f55", "#b5653e", "#d8c39a", "#c7a06a", "#a9583a"];
  for (let i = 0; i < 520; i++) {
    const th = rc() * TAU;
    const rad = 340 + rc() * 1300;
    const x = Math.cos(th) * rad * 1.1;
    const z = Math.sin(th) * rad;
    if (x > 110 && x < 490 && z < -130 && z > -460) continue;
    const w = 26 + rc() * 30;
    const d = 26 + rc() * 30;
    const h = 12 + rc() * 10;
    const ry = rc() * Math.PI;
    ctx.box(x, h / 2, z, w, h, d, tint(roman[i % roman.length], rc, 0.08), ry);
    ctx.box(x, h + 1, z, w - 3, 2, d - 3, tint("#9c4b2e", rc, 0.06), ry);
  }
  env.add(ctx.mesh(std({ roughness: 0.95 }), { name: "rome" }));

  const fp = (th, off, y) => E((th * Math.PI) / 180, off, y);
  return finish("colosseum", structure, env, {
    view: { target: v3(0, 4, 12), pos: v3(132, 205, -178), radius: 120, min: 20, max: 1500, focus: 70 },
    fog: [700, 2600],
    shadowHalf: 150,
    normalBias: 0.15,
    annotations: [
      { id: "orders", label: "Tuscan, Ionic, Corinthian", pos: fp(52, 1.2, 16), side: "left" },
      { id: "attic", label: "Attic with mast corbels", pos: fp(76, 1.2, 44.6), side: "right" },
      { id: "buttress", label: "19th-century buttress", pos: buttressAt[0] ?? fp(12, 1, 22), side: "right" },
      { id: "inner", label: "Inner ring, exposed in 1349", pos: fp(262, R2 + 0.4, 18), side: "right" },
      { id: "hypogeum", label: "Hypogeum", pos: v3(-14, -2, 6), side: "left" },
      { id: "floor", label: "Rebuilt arena floor", pos: v3(30, 0.4, 2), side: "right" },
    ],
    setNight(k) {
      glowMesh.visible = k > 0.15;
    },
  });
}

const BUILDERS = { eiffel: buildEiffel, wall: buildGreatWall, hall: buildHall, colosseum: buildColosseum };

export function buildLandmark(id) {
  const fn = BUILDERS[id];
  if (!fn) throw new Error(`unknown landmark "${id}"`);
  return fn();
}
