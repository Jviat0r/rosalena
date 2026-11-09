/**
 * Images in a conversation: reading one into a message, and handling messages whose
 * content is an array of parts (OpenAI's vision shape) everywhere the harness used to
 * assume a string.
 *
 *   { role: "user", content: [ { type: "text", text }, { type: "image_url", image_url: { url: "data:image/png;base64,..." } } ] }
 *
 * Ported from DSH's read_image. The image travels as a data URL in a user message
 * (a tool result cannot carry one on most providers), right after the tool results of
 * the step that asked for it.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export const IMAGE_TYPES = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});

/** Providers commonly cap one image at ~5 MB; past that the request is refused outright. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * What one image costs in the context estimate. Providers tile images (a 1024x1024
 * picture is ~765-1,600 tokens depending on the model); a fixed, slightly high figure
 * keeps the gauge honest without decoding anything.
 */
export const IMAGE_TOKENS = 1200;

export const isImagePath = (path) => Boolean(IMAGE_TYPES[extname(String(path)).toLowerCase()]);

/** Width and height for PNG, GIF and JPEG, read from the header; null when unknown. */
export function imageDimensions(buffer, mime) {
  try {
    if (mime === "image/png" && buffer.length > 24) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    if (mime === "image/gif" && buffer.length > 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) return null;
        const marker = buffer[i + 1];
        const length = buffer.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        }
        i += 2 + length;
      }
    }
  } catch {
    /* a truncated header is just "unknown" */
  }
  return null;
}

/**
 * Read an image file into a message part, or throw a sentence the model can act on.
 * @returns {{ part: object, mime: string, bytes: number, dims: { width: number, height: number } | null, name: string }}
 */
export function loadImage(abs) {
  const mime = IMAGE_TYPES[extname(abs).toLowerCase()];
  if (!mime) {
    throw new Error(`${basename(abs)} is not an image this tool reads (png, jpg, jpeg, gif, webp)`);
  }
  const bytes = statSync(abs).size;
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`${basename(abs)} is ${(bytes / 1048576).toFixed(1)} MB; images over 5 MB are refused by the providers. Make a smaller copy first (resize or re-save as JPEG) and read that.`);
  }
  const buffer = readFileSync(abs);
  return {
    part: { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}` } },
    mime,
    bytes,
    dims: imageDimensions(buffer, mime),
    name: basename(abs),
  };
}

const isImagePart = (part) => part && typeof part === "object" && (part.type === "image_url" || part.type === "image");

/** The text of a message's content, with "[image]" where a picture was. Works for strings too. */
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === null || content === undefined ? "" : String(content);
  return content
    .map((part) => (typeof part === "string" ? part : isImagePart(part) ? "[image]" : String(part?.text ?? "")))
    .join("\n");
}

export function countImages(content) {
  return Array.isArray(content) ? content.filter(isImagePart).length : 0;
}

export function hasImages(messages) {
  return Array.isArray(messages) && messages.some((m) => countImages(m?.content) > 0);
}

/**
 * The same messages with every image replaced by a sentence, for a model that cannot
 * read images. A message left with only text goes back to being a plain string.
 */
export function stripImages(messages, note = "[an image was here, but the model in use cannot read images]") {
  return messages.map((m) => {
    if (!countImages(m?.content)) return m;
    const parts = m.content.map((part) => (isImagePart(part) ? { type: "text", text: note } : part));
    return { ...m, content: parts.every((p) => typeof p === "string" || p?.type === "text") ? contentText(parts) : parts };
  });
}

/** A user message that shows one or more images, with a line saying what they are. */
export function imageMessage(images, intro) {
  return {
    role: "user",
    content: [{ type: "text", text: intro }, ...images.map((image) => image.part)],
  };
}

/** Did a provider refuse the request because of an image? */
export function looksLikeImageRefusal(message) {
  return /image|vision|multimodal|multi-modal|image_url|content.*(array|list|part)|unsupported content|does not support (this )?(input|content)/i.test(String(message ?? ""));
}
