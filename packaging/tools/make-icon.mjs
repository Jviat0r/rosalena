// Packs the Rosalena Harness icons:
//
//   packaging\assets\rosalena.ico    Windows (electron-builder win.yml `icon`, /win32icon)
//   packaging\assets\rosalena.icns   macOS   (electron-builder mac.yml `icon`)
//
// The mark is the crowned rose in packaging\assets\icon\rosalena-icon.svg (since
// 2026-11-09; it replaced the geometric R this script used to draw itself). The SVG is
// the source. packaging\tools\render-icon.py draws it to PNG at every size below and those
// PNGs are committed; this script only packs them, so it needs no browser, no Python and
// no dependencies, and the C# launcher build never needs Node.
//
//   python packaging\tools\render-icon.py             after changing the SVG: new PNGs
//   node packaging\tools\make-icon.mjs                 pack both containers
//   node packaging\tools\make-icon.mjs --check         parse both back and verify them
//
// Output is byte-reproducible: same PNGs, same bytes, no timestamps in either format.
//
// .ico sizes: 16, 24, 32, 48, 64, 128, 256. Entries up to 64 px are 32-bit BMP (the format
// every Windows shell path and every icon loader understands); 128 and 256 are the PNG
// files as they are, which is what Windows 10 expects for large icons.
//
// .icns sizes: 16, 32, 64, 128, 256, 512, 1024, all PNG. Every type macOS resolves an app
// icon through is covered (see ICNS_ENTRIES), including the 512 and 1024 the Dock and
// Finder use on a Retina display - which is why the .icns cannot be built from the .ico
// (that stops at 256, and macOS would then draw a blurry upscaled icon).

import { inflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_FROM = 128; // 128 and 256 are PNG, the rest are BMP

// The ICNS type for each size, and why that one:
//
//   icp4  16x16        the only type that means 16 px
//   ic11  16x16@2x     a 32 px raster
//   ic12  32x32@2x     a 64 px raster
//   ic07  128x128
//   ic08  256x256
//   ic09  512x512
//   ic10  512x512@2x   a 1024 px raster
const ICNS_ENTRIES = [
  { type: "icp4", size: 16 },
  { type: "ic11", size: 32 },
  { type: "ic12", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic08", size: 256 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
];

const here = dirname(fileURLToPath(import.meta.url));
const assetDir = join(here, "..", "assets");
const pngDir = join(assetDir, "icon");
const icoPath = join(assetDir, "rosalena.ico");
const icnsPath = join(assetDir, "rosalena.icns");
const pngPath = (size) => join(pngDir, `rosalena-${size}.png`);

// ------------------------------------------------------------------ PNG reading
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Parse a PNG file into { width, height, rgba }. Handles what Pillow writes: 8-bit RGBA
// (colour type 6), not interlaced, any of the five row filters. Throws on anything else,
// so a wrong file stops the build instead of producing a broken icon.
function decodePng(data, label) {
  if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${label}: not a PNG`);
  let cursor = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (cursor + 12 <= data.length) {
    const len = data.readUInt32BE(cursor);
    const type = data.subarray(cursor + 4, cursor + 8).toString("ascii");
    const body = data.subarray(cursor + 8, cursor + 8 + len);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), body])) !== data.readUInt32BE(cursor + 8 + len)) {
      throw new Error(`${label}: bad CRC in ${type}`);
    }
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`${label}: expected 8-bit RGBA, not interlaced (depth ${depth}, colour ${colour}, interlace ${interlace})`);
      }
    }
    if (type === "IDAT") idat.push(body);
    if (type === "IEND") break;
    cursor += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error(`${label}: pixel data is ${raw.length} bytes, expected ${(stride + 1) * height}`);
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    const prev = y > 0 ? out - stride : -1;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[out + x - 4] : 0;
      const b = prev >= 0 ? rgba[prev + x] : 0;
      const c = x >= 4 && prev >= 0 ? rgba[prev + x - 4] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`${label}: unknown row filter ${filter}`);
      rgba[out + x] = value & 0xff;
    }
  }
  return { width, height, rgba };
}

function loadPng(size) {
  const path = pngPath(size);
  if (!existsSync(path)) throw new Error(`${path} is missing; run python packaging/tools/render-icon.py`);
  const bytes = readFileSync(path);
  const image = decodePng(bytes, path);
  if (image.width !== size || image.height !== size) throw new Error(`${path} is ${image.width}x${image.height}, expected ${size}x${size}`);
  return { size, bytes, rgba: image.rgba };
}

// ------------------------------------------------------------------ BMP entry
//
// A 32-bit BI_RGB DIB: BITMAPINFOHEADER with biHeight = 2 * h (XOR image then AND
// mask), BGRA rows bottom-up, and an all-zero AND mask because the alpha channel is
// authoritative. This is the classic ICO bitmap payload.
function bmpEntry({ size, rgba }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR + AND
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20); // biSizeImage
  const xor = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    const src = (size - 1 - row) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (row * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRow = Math.ceil(size / 32) * 4; // 1 bit per pixel, padded to 4 bytes
  const mask = Buffer.alloc(maskRow * size); // zeros: use alpha
  return Buffer.concat([header, xor, mask]);
}

// ------------------------------------------------------------------ containers
function buildIco() {
  const images = SIZES.map((size) => {
    const png = loadPng(size);
    return { size, payload: size >= PNG_FROM ? png.bytes : bmpEntry(png) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, payload }, index) => {
    const at = index * 16;
    directory[at] = size >= 256 ? 0 : size; // 0 means 256 in the ICO directory
    directory[at + 1] = size >= 256 ? 0 : size;
    directory[at + 2] = 0; // palette colours
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(payload.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += payload.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.payload)]);
}

// The Apple Icon Image format, written by hand because `iconutil` only exists on macOS:
//
//   'icns' | total length (big endian) | chunk*
//   chunk: type (4 ascii) | chunk length incl. these 8 bytes (big endian) | payload
//
// Each payload is a complete PNG file, which is what macOS expects for these types.
function buildIcns() {
  const chunks = ICNS_ENTRIES.map(({ type, size }) => {
    const png = loadPng(size).bytes;
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------------ checking
//
// Reads the written files back the way a shell would and checks every entry is the
// rose: transparent rounded corners, the dark tile, and the pink bloom in the middle.

// Pink: clearly more red than green. The bloom's middle is pink at every size.
const isPink = ([r, g, b]) => r > 150 && r - g > 50 && b > 60;
const isTile = ([r, g, b]) => r < 40 && g < 70 && b < 80 && b >= r;

function assertPixels(rgba, size, problems, label) {
  const at = (fx, fy) => {
    const x = Math.min(size - 1, Math.round(size * fx));
    const y = Math.min(size - 1, Math.round(size * fy));
    const i = (y * size + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
  };
  const corner = rgba[3];
  if (corner > 96) problems.push(`${label}: the corner is not cut (alpha ${corner})`);
  if (size >= 32) {
    const tile = at(0.12, 0.85);
    if (tile[3] < 200 || !isTile(tile)) problems.push(`${label}: tile pixel ${tile} is not the dark tile`);
  }
  // The middle of the bloom, a little left of the swirl.
  const bloom = at(0.4, 0.55);
  if (bloom[3] < 200 || !isPink(bloom)) problems.push(`${label}: bloom pixel ${bloom} is not pink`);
}

function check(path) {
  const buffer = readFileSync(path);
  const problems = [];
  const count = buffer.readUInt16LE(4);
  if (buffer.readUInt16LE(2) !== 1) problems.push("not an icon container");
  if (count !== SIZES.length) problems.push(`expected ${SIZES.length} images, found ${count}`);
  const seen = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16;
    const width = buffer[at] === 0 ? 256 : buffer[at];
    const height = buffer[at + 1] === 0 ? 256 : buffer[at + 1];
    const bpp = buffer.readUInt16LE(at + 6);
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    if (offset + length > buffer.length) problems.push(`entry ${width}: runs past the end of the file`);
    if (bpp !== 32) problems.push(`entry ${width}: ${bpp} bits per pixel, expected 32`);
    if (width !== height) problems.push(`entry ${width}: not square`);
    seen.push(width);
    const data = buffer.subarray(offset, offset + length);
    try {
      if (width >= PNG_FROM) {
        const image = decodePng(data, `entry ${width}`);
        if (image.width !== width) problems.push(`entry ${width}: PNG is ${image.width} px`);
        else assertPixels(image.rgba, width, problems, `entry ${width}`);
      } else {
        if (data.readUInt32LE(0) !== 40) problems.push(`entry ${width}: BMP header is not 40 bytes`);
        if (data.readInt32LE(8) !== width * 2) problems.push(`entry ${width}: BMP height is not 2x width`);
        const expected = 40 + width * width * 4 + Math.ceil(width / 32) * 4 * width;
        if (data.length !== expected) problems.push(`entry ${width}: BMP is ${data.length} bytes, expected ${expected}`);
        assertPixels(decodeBmp(data, width), width, problems, `entry ${width}`);
      }
    } catch (err) {
      problems.push(String(err.message ?? err));
    }
  }
  if (seen.join(",") !== SIZES.join(",")) problems.push(`sizes are ${seen.join(",")}, expected ${SIZES.join(",")}`);
  console.log(`icon: ${path}`);
  console.log(`  ${buffer.length.toLocaleString("en-US")} bytes, ${count} images: ${seen.join(", ")} px`);
  if (problems.length) {
    for (const problem of problems) console.error(`  FAIL ${problem}`);
    return false;
  }
  console.log("  OK every entry parses, has the right size, and shows the rose");
  return true;
}

function checkIcns(path) {
  const buffer = readFileSync(path);
  const problems = [];
  const rows = [];
  if (buffer.length < 8 || buffer.subarray(0, 4).toString("ascii") !== "icns") {
    problems.push("not an ICNS container (the first four bytes are not 'icns')");
  } else {
    if (buffer.readUInt32BE(4) !== buffer.length) problems.push(`the header says ${buffer.readUInt32BE(4)} bytes, the file is ${buffer.length}`);
    let cursor = 8;
    while (cursor + 8 <= buffer.length) {
      const type = buffer.subarray(cursor, cursor + 4).toString("ascii");
      const length = buffer.readUInt32BE(cursor + 4);
      if (length < 8 || cursor + length > buffer.length) {
        problems.push(`chunk ${type}: length ${length} runs past the end of the file`);
        break;
      }
      const expected = ICNS_ENTRIES.find((entry) => entry.type === type);
      if (!expected) problems.push(`chunk ${type}: unexpected type for this icon`);
      try {
        const image = decodePng(buffer.subarray(cursor + 8, cursor + length), `chunk ${type}`);
        if (expected && image.width !== expected.size) problems.push(`chunk ${type}: PNG is ${image.width} px, expected ${expected.size}`);
        else assertPixels(image.rgba, image.width, problems, `chunk ${type}`);
        rows.push(`${type} ${String(image.width).padStart(4)} px  ${String(length - 8).padStart(7)} bytes`);
      } catch (err) {
        problems.push(String(err.message ?? err));
      }
      cursor += length;
    }
    if (cursor !== buffer.length) problems.push(`${buffer.length - cursor} trailing bytes after the last chunk`);
    const found = rows.map((row) => row.split(" ")[0]);
    const wanted = ICNS_ENTRIES.map((entry) => entry.type);
    if (found.join(",") !== wanted.join(",")) problems.push(`types are ${found.join(",")}, expected ${wanted.join(",")}`);
  }
  console.log(`icon: ${path}`);
  console.log(`  ${buffer.length.toLocaleString("en-US")} bytes, ${rows.length} images`);
  for (const row of rows) console.log(`    ${row}`);
  if (problems.length) {
    for (const problem of problems) console.error(`  FAIL ${problem}`);
    return false;
  }
  console.log("  OK the container parses, every entry is the size macOS asks for, and each shows the rose");
  return true;
}

// A 32-bit BI_RGB ICO bitmap back to top-down RGBA.
function decodeBmp(data, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    const src = 40 + (size - 1 - row) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (row * size + x) * 4;
      out[d] = data[s + 2];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s];
      out[d + 3] = data[s + 3];
    }
  }
  return out;
}

// ------------------------------------------------------------------ main
const argv = process.argv.slice(2);

if (argv.includes("--check")) {
  // Both, always: a build shipping one and not the other produces an app with an icon on
  // one platform and Electron's atom on the other, which is the failure this catches.
  const okIco = check(icoPath);
  const okIcns = checkIcns(icnsPath);
  process.exit(okIco && okIcns ? 0 : 1);
}

mkdirSync(assetDir, { recursive: true });
const ico = buildIco();
writeFileSync(icoPath, ico);
console.log(`wrote ${icoPath} (${ico.length.toLocaleString("en-US")} bytes, ${SIZES.length} images)`);

const icns = buildIcns();
writeFileSync(icnsPath, icns);
console.log(`wrote ${icnsPath} (${icns.length.toLocaleString("en-US")} bytes, ${ICNS_ENTRIES.length} images)`);
