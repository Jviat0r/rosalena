// Fuyu's world: the voxel grid, seeded island generation, the compact save encoding and
// the auto-build planner. Pure functions over a Uint8Array, with no DOM and no three.js,
// so the self-tests can check them directly and the renderer only ever reads the result.

export const N = 48; // the grid is N x N columns
export const H = 28; // and H blocks tall
export const SEA = 4; // blocks with y < SEA are under water
export const VOLUME = N * N * H;
const NN = N * N;

export const AIR = 0;
export const GRASS = 1;
export const DIRT = 2;
export const STONE = 3;
export const SAND = 4;
export const WOOD = 5;
export const PLANKS = 6;
export const LEAVES = 7;
export const GLASS = 8;
export const LANTERN = 9;
export const ROOF = 10;
export const SNOW = 11;
export const FLOWER = 12;
export const TYPE_COUNT = 13;

export const BLOCK_NAMES = ["Air", "Grass", "Dirt", "Stone", "Sand", "Wood", "Planks", "Leaves", "Glass", "Lantern", "Roof tile", "Snow", "Flower"];
export const HOTBAR = [GRASS, DIRT, STONE, SAND, WOOD, PLANKS, LEAVES, GLASS, LANTERN, ROOF];

// Blocks that hide the faces of their neighbours. Leaves have holes, glass is clear, and
// lanterns and flowers are smaller than a cell, so none of those hide anything.
export const OPAQUE = new Uint8Array(TYPE_COUNT);
for (const t of [GRASS, DIRT, STONE, SAND, WOOD, PLANKS, ROOF, SNOW]) OPAQUE[t] = 1;

const GROUND = new Uint8Array(TYPE_COUNT);
for (const t of [GRASS, DIRT, STONE, SAND, SNOW]) GROUND[t] = 1;
export const isGround = (t) => GROUND[t] === 1;

export const index = (x, y, z) => (y * N + z) * N + x;
export const inBounds = (x, y, z) => x >= 0 && x < N && z >= 0 && z < N && y >= 0 && y < H;
export function coords(i) {
  const x = i % N;
  const z = Math.floor(i / N) % N;
  const y = Math.floor(i / NN);
  return [x, y, z];
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 0..1 hash of a cell, for colour jitter and scattering. */
export function hash3(x, y, z, s = 0) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1442695041) + Math.imul(s | 0, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(seed) {
  const r = mulberry32(seed ^ 0x9e3779b9);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = r();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const lat = (x, z) => vals[perm[perm[x & 255] + (z & 255)]];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, z) => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const u = fade(x - xi);
    const v = fade(z - zi);
    const a = lat(xi, zi);
    const b = lat(xi + 1, zi);
    const c = lat(xi, zi + 1);
    const d = lat(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

const fbm = (noise, x, z) => noise(x, z) * 0.55 + noise(x * 2.03 + 17.1, z * 2.03 - 9.4) * 0.3 + noise(x * 4.1 - 3.3, z * 4.1 + 5.7) * 0.15;

const NAME_A = [
  "Berry", "Maple", "Pebble", "Mochi", "Clover", "Juniper", "Fern", "Honey", "Plum", "Willow",
  "Hazel", "Saffron", "Thistle", "Yuzu", "Coral", "Moss", "Bramble", "Tansy", "Sorrel", "Marigold",
  "Kumquat", "Driftwood", "Sesame", "Persimmon", "Biscuit", "Teacup", "Puffin", "Otter", "Acorn", "Camellia",
];
const NAME_B = ["Cay", "Isle", "Key", "Holm", "Atoll", "Rock", "Haven", "Shoal", "Islet", "Reach", "Skerry", "Nook"];

export function islandName(seed) {
  const r = mulberry32((seed >>> 0) ^ 0x5bd1e995);
  const a = NAME_A[Math.floor(r() * NAME_A.length)];
  const b = NAME_B[Math.floor(r() * NAME_B.length)];
  return `${a} ${b}`;
}

/** Highest non-air, non-flower block in a column, or -1. */
export function topSolid(blocks, x, z) {
  for (let y = H - 1; y >= 0; y--) {
    const t = blocks[index(x, y, z)];
    if (t !== AIR && t !== FLOWER) return y;
  }
  return -1;
}

/** Generate the island for a seed. The same seed always gives the same blocks. */
export function generateWorld(seed) {
  seed = seed >>> 0;
  const blocks = new Uint8Array(VOLUME);
  const rnd = mulberry32(seed);
  const noise = valueNoise(seed);
  const noise2 = valueNoise(seed + 101);
  const c = N / 2;

  const blobs = [{ x: c + (rnd() - 0.5) * 4, z: c + (rnd() - 0.5) * 4, r: 12.5 + rnd() * 3, w: 1 }];
  const lobes = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < lobes; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 6 + rnd() * 5;
    blobs.push({ x: blobs[0].x + Math.cos(a) * d, z: blobs[0].z + Math.sin(a) * d, r: 5.5 + rnd() * 4, w: 0.75 + rnd() * 0.2 });
  }
  const peak = { x: blobs[0].x + (rnd() - 0.5) * 9, z: blobs[0].z + (rnd() - 0.5) * 9, r: 4.5 + rnd() * 3, h: 3 + rnd() * 4 };

  let heights = new Int16Array(NN);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      let m = -1;
      for (const b of blobs) {
        const dx = (x + 0.5 - b.x) / b.r;
        const dz = (z + 0.5 - b.z) / b.r;
        m = Math.max(m, (1 - (dx * dx + dz * dz)) * b.w);
      }
      const n = fbm(noise, x * 0.11, z * 0.11);
      m += (n - 0.5) * 0.5;
      const edge = Math.min(x, z, N - 1 - x, N - 1 - z);
      if (edge < 5) m = Math.min(m, -0.25 + edge * 0.04);
      let h;
      if (m <= 0) {
        h = SEA - 2 + Math.round(m * 3 + (fbm(noise2, x * 0.2, z * 0.2) - 0.5) * 1.6);
      } else {
        // A quick rise from the beach to a broad meadow, gentle slopes inland, one hill.
        let raw = SEA - 1 + smoothstep(0.02, 0.2, m) * 3.3 + smoothstep(0.55, 1.1, m) * 3.4;
        const pd = Math.hypot(x + 0.5 - peak.x, z + 0.5 - peak.z) / peak.r;
        if (pd < 1) raw += smoothstep(0, 1, 1 - pd) * peak.h;
        h = Math.floor(raw + 0.15);
      }
      heights[z * N + x] = clamp(h, 1, H - 10);
    }
  }

  // A median pass over the land turns noisy bumps into small plateaus: flat ground to build on.
  const smoothed = new Int16Array(heights);
  const around = [];
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      if (heights[z * N + x] < SEA) continue;
      around.length = 0;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) around.push(heights[(z + dz) * N + x + dx]);
      around.sort((a, b) => a - b);
      smoothed[z * N + x] = Math.max(around[4], SEA - 1);
    }
  }
  heights = smoothed;

  const tops = new Uint8Array(NN);
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const h = heights[z * N + x];
      const n = fbm(noise2, x * 0.3, z * 0.3);
      let top;
      if (h < SEA) top = n > 0.7 ? STONE : SAND;
      else if (h <= SEA + 1 && (h === SEA || n < 0.8)) top = SAND;
      else if (h >= SEA + 9) top = SNOW;
      else if (h >= SEA + 7 && n > 0.35) top = STONE;
      else top = GRASS;
      tops[z * N + x] = top;
      for (let y = 0; y <= h; y++) {
        let t;
        if (y === h) t = top;
        else if (y >= h - 2) t = top === GRASS ? DIRT : top === SNOW ? STONE : top;
        else t = STONE;
        blocks[index(x, y, z)] = t;
      }
    }
  }

  const free = (x, y, z) => inBounds(x, y, z) && blocks[index(x, y, z)] === AIR;
  const set = (x, y, z, t) => {
    if (free(x, y, z)) blocks[index(x, y, z)] = t;
  };

  // A little pier: a beach cell at sea level that looks out over open water.
  const piers = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let z = 6; z < N - 6; z++) {
    for (let x = 6; x < N - 6; x++) {
      if (heights[z * N + x] !== SEA || tops[z * N + x] !== SAND) continue;
      for (const [dx, dz] of dirs) {
        let ok = true;
        for (let k = 1; k <= 6 && ok; k++) {
          const px = x + dx * k;
          const pz = z + dz * k;
          if (px < 2 || pz < 2 || px >= N - 2 || pz >= N - 2 || heights[pz * N + px] >= SEA) ok = false;
        }
        if (ok) piers.push([x, z, dx, dz]);
      }
    }
  }
  if (piers.length) {
    const [x, z, dx, dz] = piers[Math.floor(rnd() * piers.length)];
    for (let k = 1; k <= 5; k++) set(x + dx * k, SEA, z + dz * k, PLANKS);
    for (const k of [2, 5]) {
      const px = x + dx * k;
      const pz = z + dz * k;
      for (let y = heights[pz * N + px] + 1; y < SEA; y++) set(px, y, pz, WOOD);
    }
    set(x + dx * 5, SEA + 1, z + dz * 5, WOOD);
    set(x + dx * 5, SEA + 2, z + dz * 5, LANTERN);
  }

  // Trees: round ones and a few pines, spaced apart on grass.
  let grass = 0;
  for (let i = 0; i < NN; i++) if (tops[i] === GRASS) grass++;
  const target = clamp(Math.round(grass / 75), 4, 10);
  const trees = [];
  for (let tries = 0; trees.length < target && tries < 600; tries++) {
    const x = 3 + Math.floor(rnd() * (N - 6));
    const z = 3 + Math.floor(rnd() * (N - 6));
    const h = heights[z * N + x];
    if (tops[z * N + x] !== GRASS || h > SEA + 8 || !free(x, h + 1, z)) continue;
    if (trees.some(([tx, tz]) => Math.abs(tx - x) + Math.abs(tz - z) < 5)) continue;
    trees.push([x, z]);
    const pine = rnd() < 0.3;
    const trunk = 3 + Math.floor(rnd() * 2) + (pine ? 1 : 0);
    for (let y = h + 1; y <= h + trunk; y++) set(x, y, z, WOOD);
    const top = h + trunk;
    if (pine) {
      for (let y = top + 1; y >= h + 2; y--) {
        const depth = top + 1 - y;
        const r = depth === 0 ? 0.4 : Math.min(2.2, 0.7 + depth * 0.45) - (depth % 2 === 0 ? 0.5 : 0);
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dz * dz <= r * r + 0.01) set(x + dx, y, z + dz, LEAVES);
      }
      set(x, top + 2, z, LEAVES);
    } else {
      const radii = [2.3, 2.4, 1.8, 1.0];
      for (let dy = -1; dy <= 2; dy++) {
        const r = radii[dy + 1];
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            const d2 = dx * dx + dz * dz;
            if (d2 > r * r) continue;
            if (d2 >= 4 && rnd() < 0.45) continue;
            set(x + dx, top + dy, z + dz, LEAVES);
          }
        }
      }
    }
  }

  // Rocks: small stone clusters on grass and sand.
  const rocks = 3 + Math.floor(rnd() * 4);
  for (let k = 0, tries = 0; k < rocks && tries < 200; tries++) {
    const x = 3 + Math.floor(rnd() * (N - 6));
    const z = 3 + Math.floor(rnd() * (N - 6));
    const h = heights[z * N + x];
    const top = tops[z * N + x];
    if ((top !== GRASS && top !== SAND) || h < SEA || !free(x, h + 1, z)) continue;
    k++;
    set(x, h + 1, z, STONE);
    if (rnd() < 0.4) set(x, h + 2, z, STONE);
    const [dx, dz] = dirs[Math.floor(rnd() * 4)];
    if (heights[(z + dz) * N + x + dx] === h && rnd() < 0.7) set(x + dx, h + 1, z + dz, STONE);
  }

  // Flowers on open grass.
  for (let z = 1; z < N - 1; z++) {
    for (let x = 1; x < N - 1; x++) {
      const h = heights[z * N + x];
      if (tops[z * N + x] !== GRASS || !free(x, h + 1, z)) continue;
      if (hash3(x, h, z, seed) < 0.055) blocks[index(x, h + 1, z)] = FLOWER;
    }
  }

  return { seed, name: islandName(seed), blocks };
}

export function countBlocks(blocks) {
  let c = 0;
  for (let i = 0; i < blocks.length; i++) if (blocks[i] !== AIR) c++;
  return c;
}

/** FNV-1a over every cell: two worlds with the same hash are (for our purposes) the same. */
export function worldHash(blocks) {
  let h = 0x811c9dc5;
  for (let i = 0; i < blocks.length; i++) {
    h ^= blocks[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Run-length pairs (count, type) in base64: a whole island is a few kilobytes. */
export function encodeWorld(blocks) {
  const out = new Uint8Array(blocks.length * 2);
  let n = 0;
  for (let i = 0; i < blocks.length; ) {
    const v = blocks[i];
    let run = 1;
    while (i + run < blocks.length && blocks[i + run] === v && run < 255) run++;
    out[n++] = run;
    out[n++] = v;
    i += run;
  }
  return toBase64(out.subarray(0, n));
}

export function decodeWorld(text) {
  const bytes = fromBase64(String(text));
  if (bytes.length % 2) throw new Error("the saved island is damaged (odd length)");
  const blocks = new Uint8Array(VOLUME);
  let p = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const run = bytes[i];
    const v = bytes[i + 1];
    if (!run || v >= TYPE_COUNT || p + run > VOLUME) throw new Error("the saved island is damaged");
    blocks.fill(v, p, p + run);
    p += run;
  }
  if (p !== VOLUME) throw new Error("the saved island is the wrong size");
  return blocks;
}

/**
 * Voxel ray march (Amanatides and Woo) in world units, where the grid spans
 * x, z in [-N/2, N/2] and y in [0, H]. Returns the first non-air cell and the face it was
 * entered through, or null.
 */
export function raycast(blocks, ox, oy, oz, dx, dy, dz, maxSteps = 400) {
  ox += N / 2;
  oz += N / 2;
  let tmin = 0;
  let tmax = 1e5;
  let enter = -1;
  const slab = (o, d, lo, hi, axis) => {
    if (Math.abs(d) < 1e-12) return o >= lo && o <= hi;
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) {
      tmin = t1;
      enter = axis;
    }
    if (t2 < tmax) tmax = t2;
    return tmin <= tmax;
  };
  if (!slab(ox, dx, 0, N, 0) || !slab(oy, dy, 0, H, 1) || !slab(oz, dz, 0, N, 2)) return null;
  const t0 = tmin + 1e-6;
  let x = clamp(Math.floor(ox + dx * t0), 0, N - 1);
  let y = clamp(Math.floor(oy + dy * t0), 0, H - 1);
  let z = clamp(Math.floor(oz + dz * t0), 0, N - 1);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tnx = dx !== 0 ? ((sx > 0 ? x + 1 : x) - ox) / dx : Infinity;
  let tny = dy !== 0 ? ((sy > 0 ? y + 1 : y) - oy) / dy : Infinity;
  let tnz = dz !== 0 ? ((sz > 0 ? z + 1 : z) - oz) / dz : Infinity;
  let nx = enter === 0 ? -sx : 0;
  let ny = enter === 1 ? -sy : 0;
  let nz = enter === 2 ? -sz : 0;
  for (let step = 0; step < maxSteps; step++) {
    if (x < 0 || x >= N || y < 0 || y >= H || z < 0 || z >= N) return null;
    const v = blocks[index(x, y, z)];
    if (v !== AIR) return { x, y, z, nx, ny, nz, type: v };
    let t;
    if (tnx < tny && tnx < tnz) {
      x += sx;
      t = tnx;
      tnx += tdx;
      nx = -sx;
      ny = 0;
      nz = 0;
    } else if (tny < tnz) {
      y += sy;
      t = tny;
      tny += tdy;
      nx = 0;
      ny = -sy;
      nz = 0;
    } else {
      z += sz;
      t = tnz;
      tnz += tdz;
      nx = 0;
      ny = 0;
      nz = -sz;
    }
    if (t > tmax + 1e-6) return null;
  }
  return null;
}

// ---------------------------------------------------------------- auto build

const SPECS = {
  cottage: { W: 7, D: 5, top: 8 },
  pavilion: { W: 5, D: 5, top: 8 },
  hut: { W: 5, D: 4, top: 8 },
};

/**
 * Can a building of this size stand with its footprint at (x0, z0)? The footprint must be
 * dry ground (no tree, no earlier build) within one block of level, and the space it and
 * its roof overhang need must be empty (flowers may be covered).
 */
function evaluateSite(blocks, x0, z0, spec) {
  let min = Infinity;
  let max = -Infinity;
  let foundation = 0;
  let grass = 0;
  for (let z = z0; z < z0 + spec.D; z++) {
    for (let x = x0; x < x0 + spec.W; x++) {
      const t = topSolid(blocks, x, z);
      if (t < SEA) return null;
      const type = blocks[index(x, t, z)];
      if (!isGround(type)) return null;
      if (type === GRASS) grass++;
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  if (max - min > 3) return null;
  const base = max;
  if (base + spec.top >= H) return null;
  for (let z = z0 - 1; z <= z0 + spec.D; z++) {
    for (let x = x0 - 1; x <= x0 + spec.W; x++) {
      const inside = x >= x0 && x < x0 + spec.W && z >= z0 && z < z0 + spec.D;
      const t = topSolid(blocks, x, z);
      if (!inside && t > base + 1) return null; // a bank no higher than the floor is fine
      if (inside) foundation += base - t;
      for (let y = t + 1; y <= base + spec.top; y++) {
        const v = blocks[index(x, y, z)];
        if (v !== AIR && v !== FLOWER) return null;
      }
    }
  }
  return { base, spread: max - min, foundation, grass };
}

/** Try the preferred kind first, then the others, smallest last. */
export function planAnyBuild(blocks, { kind = "cottage", seed = 1 } = {}) {
  const order = [kind, ...["cottage", "pavilion", "hut"].filter((k) => k !== kind)];
  let plan = null;
  for (const k of order) {
    plan = planBuild(blocks, { kind: k, seed });
    if (plan.ok) return plan;
  }
  return plan;
}

/**
 * Plan a small building on open flat ground. Returns { ok, kind, changes: [[index, type]],
 * x0, z0, base, W, D } or { ok: false, reason }. Nothing is changed: the caller applies the
 * changes (so they can be undone as one step).
 */
export function planBuild(blocks, { kind = "cottage", seed = 1 } = {}) {
  const spec = SPECS[kind] ?? SPECS.cottage;
  const rnd = mulberry32(seed);
  let best = null;
  for (let z0 = 2; z0 + spec.D + 2 <= N; z0++) {
    for (let x0 = 2; x0 + spec.W + 2 <= N; x0++) {
      const site = evaluateSite(blocks, x0, z0, spec);
      if (!site) continue;
      const centre = Math.hypot(x0 + spec.W / 2 - N / 2, z0 + spec.D / 2 - N / 2);
      const score = site.spread * 3 + site.foundation * 0.5 + centre * 0.12 - site.grass * 0.04 + rnd() * 2.5;
      if (!best || score < best.score) best = { ...site, x0, z0, score };
    }
  }
  if (!best) return { ok: false, reason: "No open, level ground is left for a building. Clear a spot or try a new island." };

  const { x0, z0, base: b } = best;
  const { W, D } = spec;
  const changes = new Map();
  const put = (x, y, z, t) => {
    if (!inBounds(x, y, z)) return;
    const i = index(x, y, z);
    if (changes.has(i)) return;
    const cur = blocks[i];
    if (cur !== AIR && cur !== FLOWER) return;
    changes.set(i, t);
  };
  const inside = (x, z) => x >= x0 && x < x0 + W && z >= z0 && z < z0 + D;

  // Foundation up to the highest ground, then a plank floor.
  for (let z = z0; z < z0 + D; z++) {
    for (let x = x0; x < x0 + W; x++) {
      for (let y = topSolid(blocks, x, z) + 1; y <= b; y++) put(x, y, z, STONE);
      put(x, b + 1, z, PLANKS);
    }
  }

  const lanternPost = (x, z) => {
    if (inside(x, z) || !inBounds(x, 0, z)) return;
    const t = topSolid(blocks, x, z);
    if (t < SEA || t < b - 2 || !isGround(blocks[index(x, t, z)])) return;
    for (let y = t + 1; y <= b + 1; y++) put(x, y, z, WOOD);
    put(x, b + 2, z, LANTERN);
  };

  if (kind === "pavilion") {
    for (const [x, z] of [[x0, z0], [x0 + W - 1, z0], [x0, z0 + D - 1], [x0 + W - 1, z0 + D - 1]]) {
      for (let y = b + 2; y <= b + 4; y++) put(x, y, z, WOOD);
    }
    for (let z = z0; z < z0 + D; z++) for (let x = x0; x < x0 + W; x++) if (!(x > x0 && x < x0 + W - 1 && z > z0 && z < z0 + D - 1)) put(x, b + 5, z, PLANKS);
    const ring = (lo, hi, y, fill) => {
      for (let z = z0 + lo; z <= z0 + hi; z++) {
        for (let x = x0 + lo; x <= x0 + hi; x++) {
          const edge = x === x0 + lo || x === x0 + hi || z === z0 + lo || z === z0 + hi;
          if (fill || edge) put(x, y, z, ROOF);
        }
      }
    };
    ring(-1, W, b + 5, false);
    ring(0, W - 1, b + 6, false);
    ring(1, W - 2, b + 7, true);
    put(x0 + 2, b + 8, z0 + 2, LANTERN);
    put(x0 + 2, b + 2, z0 + 2, LANTERN);
    lanternPost(x0 + 1, z0 + D);
    lanternPost(x0 + W - 2, z0 + D);
  } else {
    const door = x0 + Math.floor(W / 2);
    const front = z0 + D - 1;
    for (let y = b + 2; y <= b + 4; y++) {
      for (let z = z0; z < z0 + D; z++) {
        for (let x = x0; x < x0 + W; x++) {
          const edgeX = x === x0 || x === x0 + W - 1;
          const edgeZ = z === z0 || z === front;
          if (!edgeX && !edgeZ) continue;
          if (x === door && z === front && y <= b + 3) continue;
          let t = edgeX && edgeZ ? WOOD : PLANKS;
          if (y === b + 3 && !(edgeX && edgeZ)) {
            if (edgeX && z === z0 + Math.floor(D / 2)) t = GLASS;
            if (edgeZ && (x === x0 + 1 || x === x0 + W - 2)) t = GLASS;
          }
          put(x, y, z, t);
        }
      }
    }
    // A stepped gable roof along x, overhanging one block all round.
    for (let k = 0; ; k++) {
      const zmin = z0 - 1 + k;
      const zmax = z0 + D - k;
      if (zmin > zmax) break;
      const y = b + 4 + k;
      for (let x = x0 - 1; x <= x0 + W; x++) {
        if (zmax - zmin <= 1) for (let z = zmin; z <= zmax; z++) put(x, y, z, ROOF);
        else {
          put(x, y, zmin, ROOF);
          put(x, y, zmax, ROOF);
        }
      }
      if (k >= 1) {
        for (let z = zmin + 1; z <= zmax - 1; z++) {
          put(x0, y, z, PLANKS);
          put(x0 + W - 1, y, z, PLANKS);
        }
      }
    }
    for (let y = b + 5; y <= b + 8; y++) put(x0 + W - 2, y, z0 + 1, STONE); // chimney
    put(x0 + 1, b + 2, z0 + 1, LANTERN); // a lamp inside, seen through the windows
    lanternPost(door - 1, z0 + D);
    lanternPost(door + 1, z0 + D);
    // A step up to the door.
    const st = topSolid(blocks, door, z0 + D);
    if (st >= SEA && b + 1 - st <= 2) for (let y = st + 1; y <= b + 1; y++) put(door, y, z0 + D, PLANKS);
  }

  return { ok: true, kind, x0, z0, base: b, W, D, changes: [...changes.entries()] };
}
