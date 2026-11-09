// A QR Code encoder, in one file, with no dependencies and no network.
//
// Why this file exists at all. Remote access hands a phone a URL that contains a
// secret, and the only way a person gets that URL onto a phone without typing 90
// characters is a QR code. The obvious shortcut - an image service, a CDN copy of
// `qrcode.js`, an `<img src="https://chart.googleapis.com/...">` - would send the
// secret (and the fact that this machine is listening) to a third party, which is
// exactly backwards for a feature whose whole job is to keep the tunnel private.
// So the encoder is here: byte mode, versions 1-10, all four error-correction
// levels, rendered straight to an SVG data URI.
//
// What it does NOT do: numeric/alphanumeric/kanji modes (byte mode carries any
// UTF-8 text, and a URL that also fits at version 10 in byte mode needs nothing
// smarter), versions above 10, structured append, or Micro QR. Version 10 byte mode
// holds 271 bytes at level L / 213 at M - a pairing URL is about 100 - and beyond
// that this throws rather than emitting a code that a scanner would misread.
//
// The implementation follows ISO/IEC 18004 the way the spec describes it: encode the
// payload, split it into Reed-Solomon blocks, interleave, zigzag it into the matrix,
// and pick the mask with the lowest penalty. The tables below are the standard ones
// (error-correction codewords per block, and blocks per version) for versions 1-10;
// everything else is computed, so there is no second table to drift from the first.
//
// This encoder is verified three ways in test/remote.test.mjs: a full read-back of
// the matrix (de-interleave, unmask, re-parse the bit stream, compare with the
// input), the Reed-Solomon syndromes of every block being zero, and the structural
// invariants a scanner relies on (finder patterns, timing rows, the dark module).

/** Error-correction level, as the format-information field numbers them. */
export const ECL = Object.freeze({ L: 0, M: 1, Q: 2, H: 3 });

/** The two bits each error-correction level puts in the format information. */
const ECL_FORMAT_BITS = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 });

/**
 * Error-correction codewords per block, indexed [level][version - 1].
 * Standard table, versions 1-10.
 */
const ECC_CODEWORDS_PER_BLOCK = Object.freeze({
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
});

/** Reed-Solomon blocks per version, indexed [level][version - 1]. Standard table. */
const NUM_BLOCKS = Object.freeze({
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
});

/** The highest version this encoder will emit. */
export const MAX_VERSION = 10;

/**
 * How many bits of data the symbol holds once every function pattern is drawn.
 * This is the spec's own count (total modules minus function modules), so no table
 * of "raw codewords" is needed and the two cannot disagree.
 */
export function rawDataModules(version) {
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw new RangeError(`QR version ${version} is outside 1-${MAX_VERSION}`);
  }
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    bits -= (25 * align - 10) * align - 55;
    if (version >= 7) bits -= 36; // the version-information block
  }
  return bits;
}

/** Data codewords available at one version and level. */
export function dataCapacity(version, ecl = "M") {
  const perBlock = ECC_CODEWORDS_PER_BLOCK[ecl][version - 1];
  const blocks = NUM_BLOCKS[ecl][version - 1];
  return Math.floor(rawDataModules(version) / 8) - perBlock * blocks;
}

/**
 * The whole symbol: `modules[y][x] === true` is a dark module. `size` is 17 + 4*version.
 *
 * @param {string} text the payload, encoded as UTF-8 bytes in byte mode
 * @param {{ ecl?: "L"|"M"|"Q"|"H", mask?: number|null }} [options]
 *   `mask` forces one of the eight masks (tests use it); by default all eight are
 *   scored and the lowest-penalty one wins, which is what the spec asks for.
 */
export function encodeQr(text, { ecl = "M", mask = null } = {}) {
  const level = String(ecl).toUpperCase();
  if (!(level in ECL)) throw new RangeError(`unknown error-correction level ${JSON.stringify(ecl)}`);
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const version = smallestVersion(bytes.length, level);
  const size = version * 4 + 17;

  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  drawFunctionPatterns(version, size, setFunction);
  const codewords = buildCodewords(bytes, version, level);
  drawCodewords(codewords, size, modules, isFunction);

  const chosen = mask === null || mask === undefined ? bestMask(version, size, modules, isFunction, level) : mask;
  if (!Number.isInteger(chosen) || chosen < 0 || chosen > 7) throw new RangeError(`QR mask ${mask} is not 0-7`);
  applyMask(chosen, size, modules, isFunction);
  drawFormatBits(level, chosen, size, setFunction);
  if (version >= 7) drawVersionBits(version, size, setFunction);

  return {
    size,
    version,
    ecl: level,
    mask: chosen,
    modules,
    /**
     * The final interleaved codeword stream, before masking. Exposed because it is the
     * honest way to check a symbol: read the matrix back and compare, without a camera
     * and without re-implementing the block tables in the test.
     */
    codewords,
    /** Dark/light with (x, y) as a human writes them, not as the matrix stores them. */
    at(x, y) {
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
      return modules[y][x];
    },
  };
}

/** Versions 1-9 carry an 8-bit byte count; version 10 needs 16. */
function charCountBits(version) {
  return version <= 9 ? 8 : 16;
}

function smallestVersion(byteLength, level) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacity = dataCapacity(version, level) * 8;
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= capacity) return version;
  }
  throw new RangeError(
    `a ${byteLength}-byte payload does not fit a version-${MAX_VERSION} QR code at level ${level}; ` +
      `this encoder stops at version ${MAX_VERSION} on purpose`,
  );
}

/** Mode indicator, character count, payload, terminator, then the spec's two pad bytes. */
function buildDataBits(bytes, version) {
  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push(((value >>> i) & 1) === 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, charCountBits(version));
  for (const byte of bytes) push(byte, 8);
  return bits;
}

/** The bit stream for one version and level, byte-aligned and padded. */
function dataCodewords(bytes, version, level) {
  const capacity = dataCapacity(version, level);
  const bits = buildDataBits(bytes, version);
  if (bits.length > capacity * 8) throw new RangeError("payload overflows the chosen version");
  bits.push(...new Array(Math.min(4, capacity * 8 - bits.length)).fill(false)); // terminator
  while (bits.length % 8 !== 0) bits.push(false);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ? 1 : 0);
    out.push(byte);
  }
  // 0xEC / 0x11 alternating: the spec's padding, chosen because both patterns keep
  // the module colours alternating and so do not create a false finder-looking run.
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

// --------------------------------------------------------------- Reed-Solomon

const GF_EXP = new Array(512).fill(0);
const GF_LOG = new Array(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR field's primitive polynomial
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** The generator polynomial for `degree` error-correction codewords, highest power first. */
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

/** The `degree` remainder codewords for one block of data. */
export function rsRemainder(data, degree) {
  const divisor = rsDivisor(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

/**
 * The complete codeword sequence: data blocks and their error-correction bytes,
 * interleaved the way the spec orders them (all first bytes, then all second
 * bytes, ... so a scratch on the symbol costs a little error correction in every
 * block instead of destroying one block outright).
 */
function buildCodewords(bytes, version, level) {
  const data = dataCodewords(bytes, version, level);
  const numBlocks = NUM_BLOCKS[level][version - 1];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[level][version - 1];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const shortDataLen = shortBlockLen - eccLen;

  const dataBlocks = [];
  const eccBlocks = [];
  let at = 0;
  for (let i = 0; i < numBlocks; i++) {
    const take = shortDataLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(at, at + take);
    at += take;
    dataBlocks.push(block);
    eccBlocks.push(rsRemainder(block, eccLen));
  }
  if (at !== data.length) throw new Error("internal: block split did not consume the data codewords");

  const out = [];
  const longest = shortDataLen + 1;
  for (let i = 0; i < longest; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (let b = 0; b < numBlocks; b++) out.push(eccBlocks[b][i]);
  }
  return out;
}

// ------------------------------------------------------------------- geometry

/** Alignment-pattern centres per version, computed rather than tabulated. */
export function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.floor((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2;
  const result = new Array(numAlign).fill(6);
  for (let i = numAlign - 1, pos = size - 7; i >= 1; i--, pos -= step) result[i] = pos;
  return result;
}

function drawFunctionPatterns(version, size, setFunction) {
  // Timing patterns: the alternating row and column a scanner uses to count modules.
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Finder patterns and their separators, in three corners.
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Alignment patterns, except where a finder already sits.
  const align = alignmentPositions(version);
  const last = align.length - 1;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      const cx = align[i];
      const cy = align[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve the format areas (real bits are written after the mask is chosen) and the
  // dark module, which is always dark and gives the scanner its phase reference.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }
  // (8,6) and (6,8) look like format positions but are not: the two timing patterns run
  // straight through them, so they stay dark (8 is even) and the format bits step over.
  setFunction(8, size - 8, true);
  for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, false);
  for (let i = 0; i < 7; i++) setFunction(8, size - 7 + i, false);

  // The version-information blocks exist from version 7 on.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        setFunction(size - 11 + j, i, false);
        setFunction(i, size - 11 + j, false);
      }
    }
  }
}

/** The zigzag: two-module-wide columns, right to left, alternating up and down. */
function drawCodewords(codewords, size, modules, isFunction) {
  let i = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped entirely
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x] || i >= totalBits) continue;
        modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      throw new RangeError(`QR mask ${mask} is not 0-7`);
  }
}

function applyMask(mask, size, modules, isFunction) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

/** Try all eight masks on a copy and keep the one the spec's penalty score likes best. */
function bestMask(version, size, modules, isFunction, level) {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const trial = modules.map((row) => row.slice());
    applyMask(mask, size, trial, isFunction);
    // The format bits take part in the score, so they have to be present; drawing
    // them on the trial copy only is enough, the winner is redrawn for real later.
    drawTrialBits(version, level, mask, size, trial);
    const score = penalty(trial, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }
  return best;
}

function penalty(modules, size) {
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules, in rows and in columns.
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === modules[y][x - 1]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === modules[y - 1][x]) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }

  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }

  // Rule 3: the finder-like 1:1:3:1:1 sequence with four light modules beside it.
  const pattern = [true, false, true, true, true, false, true];
  const matchesAt = (get) => {
    for (let i = 0; i < 7; i++) if (get(i) !== pattern[i]) return false;
    return true;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x + 7 <= size) {
        if (matchesAt((i) => modules[y][x + i])) {
          const before = x - 4 >= 0 ? [0, 1, 2, 3].every((i) => modules[y][x - 1 - i] === false) : false;
          const after = x + 11 <= size ? [0, 1, 2, 3].every((i) => modules[y][x + 7 + i] === false) : false;
          if (before || after) score += 40;
        }
      }
      if (y + 7 <= size) {
        if (matchesAt((i) => modules[y + i][x])) {
          const before = y - 4 >= 0 ? [0, 1, 2, 3].every((i) => modules[y - 1 - i][x] === false) : false;
          const after = y + 11 <= size ? [0, 1, 2, 3].every((i) => modules[y + 7 + i][x] === false) : false;
          if (before || after) score += 40;
        }
      }
    }
  }

  // Rule 4: how far the dark share is from 50%, in 5% steps.
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const total = size * size;
  const percent = (dark * 100) / total;
  const step = Math.floor(Math.abs(percent - 50) / 5);
  score += step * 10;

  return score;
}

// ----------------------------------------------------- format and version bits

/** 15 bits: 5 data bits, 10 BCH bits, XORed with the spec's mask pattern. */
export function formatBits(level, mask) {
  const data = (ECL_FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/** 18 bits: the version number, then 12 BCH bits. Only versions 7 and up carry it. */
export function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

function drawFormatBits(level, mask, size, setFunction) {
  const bits = formatBits(level, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFunction(8, i, bit(i));
  setFunction(8, 7, bit(6));
  setFunction(8, 8, bit(7));
  setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(i));
  setFunction(8, size - 8, true); // the always-dark module
}

function drawVersionBits(version, size, setFunction) {
  const bits = versionBits(version);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(a, b, bit(i));
    setFunction(b, a, bit(i));
  }
}

// The scoring pass needs the same two drawings on a plain matrix, without touching
// the function map: the format and version areas are already marked as function
// modules by then, so only the colours need writing.
function drawTrialBits(version, level, mask, size, modules) {
  const paint = (x, y, dark) => {
    modules[y][x] = dark;
  };
  drawFormatBits(level, mask, size, paint);
  if (version >= 7) drawVersionBits(version, size, paint);
}

// ------------------------------------------------------------------ rendering

/**
 * An SVG of the symbol. Vector, so it stays sharp at any size, and small: one `<path>`
 * instead of 400 `<rect>` elements, which keeps the data URI under 2 KB.
 */
export function qrSvg(matrix, { scale = 8, margin = 4, dark = "#000000", light = "#ffffff" } = {}) {
  const { size, modules } = matrix;
  const extent = (size + margin * 2) * scale;
  const parts = [];
  for (let y = 0; y < size; y++) {
    let runStart = -1;
    for (let x = 0; x <= size; x++) {
      const darkHere = x < size && modules[y][x];
      if (darkHere && runStart < 0) runStart = x;
      if (!darkHere && runStart >= 0) {
        const width = x - runStart;
        parts.push(`M${(runStart + margin) * scale} ${(y + margin) * scale}h${width * scale}v${scale}h${-width * scale}z`);
        runStart = -1;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${extent}" height="${extent}" fill="${light}"/>` +
    `<path d="${parts.join("")}" fill="${dark}"/>` +
    `</svg>`
  );
}

/**
 * A `data:` URI, so the page can put it straight in an `<img src>` with no request,
 * no blob URL and no CDN. Base64 keeps the markup from needing percent-encoding.
 */
export function qrDataUri(text, options = {}) {
  const { scale, margin, dark, light, ecl, mask } = options;
  const matrix = encodeQr(text, { ecl, mask });
  const svg = qrSvg(matrix, { scale, margin, dark, light });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
