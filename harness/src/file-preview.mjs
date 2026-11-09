/**
 * File previews for the sidebar's file viewer tab (2026-11-08): what kind of file a path
 * is, and for Office files (.pptx, .docx, .xlsx, which are zip archives of XML) the text of
 * each slide, page or sheet plus the pictures inside, read with a small zip reader so no
 * dependency or Office install is needed.
 */

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";

export const PREVIEW_LIMIT = 50 * 1024 * 1024;
/** The most one entry inside an Office file may unpack to. */
export const ENTRY_LIMIT = 64 * 1024 * 1024;

const KINDS = [
  ["image", /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i],
  ["pdf", /\.pdf$/i],
  ["video", /\.(mp4|webm|mov|m4v|ogv)$/i],
  ["audio", /\.(mp3|wav|ogg|m4a|flac|aac)$/i],
  ["html", /\.html?$/i],
  ["markdown", /\.(md|markdown|mdx)$/i],
  ["office", /\.(pptx|docx|xlsx)$/i],
  ["text", /\.(txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env\.example|xml|js|mjs|cjs|ts|tsx|jsx|css|scss|less|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|psm1|bat|cmd|sql|lua|swift|dart|vue|svelte|gitignore|dockerfile|gradle|r|pl|tex)$/i],
];

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".flac": "audio/flac", ".aac": "audio/aac",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
};

/** "image" | "pdf" | "video" | "audio" | "html" | "markdown" | "office" | "text" | "binary". */
export function fileKind(path, sample = null) {
  const name = String(path);
  for (const [kind, re] of KINDS) if (re.test(name)) return kind;
  // No known extension: text when the first bytes have no NUL.
  if (sample && !sample.subarray(0, 4096).includes(0)) return "text";
  return "binary";
}

export function mimeOf(path, kind) {
  return MIME[extname(String(path)).toLowerCase()] ?? (kind === "text" || kind === "markdown" ? "text/plain; charset=utf-8" : "application/octet-stream");
}

/** The entries of a zip archive: name -> () => Buffer. Stored and deflated entries only. */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // End of central directory: the last 0x06054b50 within the final 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("broken zip central directory");
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const uncompressed = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    entries.set(name, () => {
      // A zip bomb (a few hundred KB that inflates to gigabytes) is refused before and
      // during inflation: the size it declares, and a hard cap on what inflate may produce.
      if (uncompressed > ENTRY_LIMIT) throw new Error(`${name} unpacks to ${Math.round(uncompressed / 1048576)} MB; previews stop at ${ENTRY_LIMIT / 1048576} MB`);
      const localName = buf.readUInt16LE(local + 26);
      const localExtra = buf.readUInt16LE(local + 28);
      const start = local + 30 + localName + localExtra;
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: ENTRY_LIMIT });
      throw new Error(`${name}: compression method ${method} is not supported`);
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const decode = (s) =>
  String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** The text runs of one OOXML part, one string per paragraph. */
function paragraphs(xml, paraTag, textTag) {
  const out = [];
  for (const para of String(xml).split(new RegExp(`<${paraTag}[ >]`))) {
    const runs = [...para.matchAll(new RegExp(`<${textTag}(?: [^>]*)?>([^<]*)</${textTag}>`, "g"))].map((m) => decode(m[1]));
    const line = runs.join("").trim();
    if (line) out.push(line);
  }
  return out;
}

const naturalNumber = (name) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

/**
 * An Office file as something a page can draw:
 *   pptx -> { kind: "slides", slides: [{ n, lines, images }] }
 *   docx -> { kind: "document", paragraphs: [...] , images }
 *   xlsx -> { kind: "sheets", sheets: [{ name, rows: [[...]] }] }
 * `images` are entry names; the page loads them through the part route.
 */
export function officePreview(file) {
  const size = statSync(file).size;
  if (size > PREVIEW_LIMIT) throw new Error(`the file is ${Math.round(size / 1048576)} MB; previews stop at ${PREVIEW_LIMIT / 1048576} MB`);
  const zip = readZip(readFileSync(file));
  const text = (name) => (zip.has(name) ? zip.get(name)().toString("utf8") : "");
  const ext = extname(file).toLowerCase();
  if (ext === ".pptx") {
    const slides = [...zip.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => naturalNumber(a) - naturalNumber(b));
    return {
      kind: "slides",
      slides: slides.map((name) => {
        const rels = text(name.replace("slides/", "slides/_rels/").replace(/\.xml$/, ".xml.rels"));
        const images = [...rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)].map((m) => `ppt/media/${m[1]}`).filter((n) => zip.has(n));
        return { n: naturalNumber(name), lines: paragraphs(text(name), "a:p", "a:t"), images: [...new Set(images)] };
      }),
    };
  }
  if (ext === ".docx") {
    const images = [...zip.keys()].filter((n) => /^word\/media\//.test(n));
    return { kind: "document", paragraphs: paragraphs(text("word/document.xml"), "w:p", "w:t"), images };
  }
  if (ext === ".xlsx") {
    const shared = paragraphs(text("xl/sharedStrings.xml"), "si", "t");
    const sheetNames = [...text("xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decode(m[1]));
    const sheetFiles = [...zip.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => naturalNumber(a) - naturalNumber(b));
    return {
      kind: "sheets",
      sheets: sheetFiles.slice(0, 10).map((name, index) => {
        const rows = [];
        // Split, not one big regular expression: a nested lazy pattern here backtracked
        // badly (2.5 s on a two-row sheet), and a real sheet has thousands of cells.
        for (const row of text(name).split(/<row[ >]/).slice(1, 501)) {
          const cells = row
            .split(/<c\s/)
            .slice(1)
            .map((chunk) => {
              const close = chunk.indexOf(">");
              const attrs = close < 0 ? chunk : chunk.slice(0, close);
              const body = attrs.endsWith("/") || close < 0 ? "" : chunk.slice(close + 1, chunk.indexOf("</c>") < 0 ? undefined : chunk.indexOf("</c>"));
              if (/t="inlineStr"/.test(attrs)) return decode(/<t[^>]*>([^<]*)<\/t>/.exec(body)?.[1] ?? "");
              const value = /<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "";
              if (/t="s"/.test(attrs)) return shared[Number(value)] ?? "";
              return decode(value);
            });
          rows.push(cells.slice(0, 50));
        }
        return { name: sheetNames[index] ?? `Sheet ${index + 1}`, rows };
      }),
    };
  }
  throw new Error(`no preview for ${ext} files`);
}

/** One entry (a picture) out of an Office file, for the part route. */
export function officePart(file, entry) {
  const zip = readZip(readFileSync(file));
  if (!/^(ppt|word|xl)\/media\/[^/]+$/.test(String(entry)) || !zip.has(entry)) throw new Error("no such picture in this file");
  return zip.get(entry)();
}
