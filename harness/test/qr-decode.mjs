/**
 * A small QR reader for tests: from the SVG image the app draws back to the text.
 *
 * It reads the picture, not the encoder's state. The SVG's path is rasterised into a
 * module grid (one cell per module, from the path's own coordinates), the level and mask
 * are read out of the format bits drawn next to the top-left finder, the data modules are
 * unmasked and collected in the zigzag order the standard defines, the interleaved blocks
 * are pulled apart using the standard's block table (written out here, not imported), each
 * block's Reed-Solomon check bytes are verified, and the byte-mode segment is decoded as
 * UTF-8. A symbol that scrambles any of that fails here, the way a phone camera would fail.
 */

import { alignmentPositions, formatBits, rawDataModules, rsRemainder } from "../src/qr.mjs";

/** Reed-Solomon blocks per version 1-10, from ISO/IEC 18004 table 9. */
const BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const ECC_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The SVG (or its data URI) as a grid of booleans, one per module, quiet zone removed. */
export function rasterise(svgOrUri) {
  const svg = String(svgOrUri).startsWith("data:")
    ? Buffer.from(String(svgOrUri).split(",")[1], "base64").toString("utf8")
    : String(svgOrUri);
  const extent = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)?.[1]);
  const path = /<path d="([^"]+)"/.exec(svg)?.[1] ?? "";
  const runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-?\d+z/g)].map((m) => m.slice(1).map(Number));
  if (!runs.length) throw new Error("no modules in the image");
  const scale = runs[0][3];
  // The quiet zone is whatever the first dark module of the top-left finder leaves.
  const margin = Math.min(...runs.map((r) => r[0])) / scale;
  const size = extent / scale - margin * 2;
  const grid = Array.from({ length: size }, () => new Array(size).fill(false));
  for (const [x, y, w] of runs) {
    for (let i = 0; i < w / scale; i++) grid[y / scale - margin][x / scale - margin + i] = true;
  }
  return grid;
}

function functionMap(version, size) {
  const map = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(align[i] + dx, align[j] + dy);
    }
  }
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 0; i < 8; i++) mark(8, size - 1 - i);
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mark(size - 11 + j, i);
        mark(i, size - 11 + j);
      }
    }
  }
  return map;
}

/** Text out of the grid. Throws with the reason a scanner would give up. */
export function decodeGrid(grid) {
  const size = grid.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) throw new Error(`a ${size}-module symbol is not version 1-10`);

  // Format information, copy 1 (around the top-left finder).
  let read = 0;
  const at = (x, y) => (grid[y][x] ? 1 : 0);
  for (let i = 0; i <= 5; i++) read |= at(8, i) << i;
  read |= at(8, 7) << 6;
  read |= at(8, 8) << 7;
  read |= at(7, 8) << 8;
  for (let i = 9; i < 15; i++) read |= at(14 - i, 8) << i;
  let level = null;
  let mask = null;
  for (const l of ["L", "M", "Q", "H"]) {
    for (let m = 0; m < 8; m++) if (formatBits(l, m) === read) [level, mask] = [l, m];
  }
  if (level === null) throw new Error("the format information does not read as any level and mask");

  // Data modules, zigzag, unmasked.
  const map = functionMap(version, size);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (map[y][x]) continue;
        bits.push(grid[y][x] !== MASKS[mask](x, y) ? 1 : 0);
      }
    }
  }
  const total = Math.floor(rawDataModules(version) / 8);
  const stream = [];
  for (let i = 0; i < total; i++) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i * 8 + j];
    stream.push(byte);
  }

  // De-interleave: short blocks first, long blocks have one more data byte.
  const nBlocks = BLOCKS[level][version - 1];
  const ecc = ECC_PER_BLOCK[level][version - 1];
  const shortLen = Math.floor(total / nBlocks);
  const nShort = nBlocks - (total % nBlocks);
  const dataLens = Array.from({ length: nBlocks }, (_, i) => shortLen - ecc + (i < nShort ? 0 : 1));
  const blocks = dataLens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...dataLens); i++) for (let b = 0; b < nBlocks; b++) if (i < dataLens[b]) blocks[b].push(stream[k++]);
  const checks = dataLens.map(() => []);
  for (let i = 0; i < ecc; i++) for (let b = 0; b < nBlocks; b++) checks[b].push(stream[k++]);
  for (let b = 0; b < nBlocks; b++) {
    const want = rsRemainder(blocks[b], ecc);
    if (want.some((v, i) => v !== checks[b][i])) throw new Error(`block ${b} fails its Reed-Solomon check`);
  }
  const data = blocks.flat();

  // Byte mode: 0100, then an 8-bit (v1-9) or 16-bit (v10+) count.
  const dbits = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (byte >>> s) & 1));
  let p = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | dbits[p++];
    return v;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`mode ${mode.toString(2)} is not byte mode`);
  const count = take(version < 10 ? 8 : 16);
  const bytes = Buffer.alloc(count);
  for (let i = 0; i < count; i++) bytes[i] = take(8);
  return { text: bytes.toString("utf8"), version, level, mask };
}

export function decodeQrImage(svgOrUri) {
  return decodeGrid(rasterise(svgOrUri));
}
