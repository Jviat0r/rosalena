/**
 * Read the shape of a GGUF model from its own header.
 *
 * The fit arithmetic needs four numbers the file name does not carry: how many layers
 * the model has, how wide one token's KV entry is, the context it was trained for and
 * its architecture. The catalog knows them for the models it lists; every other GGUF a
 * person drops into a models folder only has them in its header. Reading them here is
 * what makes "auto" exact for any file rather than a rule of thumb.
 *
 * Only the key/value section is parsed. The tokenizer's arrays (150k strings) sit in
 * the same section, so values are skipped without being decoded unless the key is one
 * of the few this needs, and the file is read in chunks rather than loaded.
 *
 * Never throws: a file that is not a GGUF, is truncated or is unreadable gives null.
 */

import { closeSync, openSync, readSync } from "node:fs";

const MAGIC = 0x46554747; // "GGUF" little-endian
const CHUNK = 1 << 20;
// The header of a real model is a few MB (the vocabulary). Anything past this is a
// broken file, and reading on would only waste time.
const MAX_HEADER_BYTES = 64 << 20;

// GGUF value types.
const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 };
const FIXED = { [T.U8]: 1, [T.I8]: 1, [T.U16]: 2, [T.I16]: 2, [T.U32]: 4, [T.I32]: 4, [T.F32]: 4, [T.BOOL]: 1, [T.U64]: 8, [T.I64]: 8, [T.F64]: 8 };

/** A forward-only reader over a file descriptor, refilling a buffer as it goes. */
function cursor(fd) {
  let buf = Buffer.alloc(0);
  let pos = 0; // read position inside buf
  let fileAt = 0; // file offset of buf[0] + buf.length
  const need = (n) => {
    if (pos + n <= buf.length) return;
    if (fileAt + n > MAX_HEADER_BYTES) throw new Error("header too large");
    const keep = buf.subarray(pos);
    const fresh = Buffer.alloc(Math.max(CHUNK, n));
    const got = readSync(fd, fresh, 0, fresh.length, fileAt);
    if (keep.length + got < n) throw new Error("truncated");
    fileAt += got;
    buf = Buffer.concat([keep, fresh.subarray(0, got)]);
    pos = 0;
  };
  return {
    u32() {
      need(4);
      const v = buf.readUInt32LE(pos);
      pos += 4;
      return v;
    },
    u64() {
      need(8);
      const v = buf.readBigUInt64LE(pos);
      pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("count too large");
      return Number(v);
    },
    bytes(n) {
      need(n);
      const out = buf.subarray(pos, pos + n);
      pos += n;
      return out;
    },
    skip(n) {
      // Large skips (a tokenizer array) step through in chunks so the buffer stays small.
      while (n > 0) {
        const step = Math.min(n, CHUNK);
        need(step);
        pos += step;
        n -= step;
      }
    },
  };
}

function readScalar(c, type) {
  switch (type) {
    case T.U8: return c.bytes(1).readUInt8(0);
    case T.I8: return c.bytes(1).readInt8(0);
    case T.U16: return c.bytes(2).readUInt16LE(0);
    case T.I16: return c.bytes(2).readInt16LE(0);
    case T.U32: return c.bytes(4).readUInt32LE(0);
    case T.I32: return c.bytes(4).readInt32LE(0);
    case T.F32: return c.bytes(4).readFloatLE(0);
    case T.BOOL: return c.bytes(1).readUInt8(0) !== 0;
    case T.U64: return Number(c.bytes(8).readBigUInt64LE(0));
    case T.I64: return Number(c.bytes(8).readBigInt64LE(0));
    case T.F64: return c.bytes(8).readDoubleLE(0);
    case T.STRING: return c.bytes(c.u64()).toString("utf8");
    default: throw new Error(`unknown GGUF type ${type}`);
  }
}

function skipValue(c, type) {
  if (FIXED[type]) return c.skip(FIXED[type]);
  if (type === T.STRING) return c.skip(c.u64());
  if (type === T.ARRAY) {
    const inner = c.u32();
    const count = c.u64();
    if (FIXED[inner]) return c.skip(FIXED[inner] * count);
    for (let i = 0; i < count; i += 1) skipValue(c, inner);
    return;
  }
  throw new Error(`unknown GGUF type ${type}`);
}

function readValue(c, type) {
  if (type !== T.ARRAY) return readScalar(c, type);
  const inner = c.u32();
  const count = c.u64();
  // Only short numeric arrays are worth keeping (per-layer head counts); anything
  // else this reader does not need is skipped.
  if (!FIXED[inner] || count > 4096) {
    if (FIXED[inner]) c.skip(FIXED[inner] * count);
    else for (let i = 0; i < count; i += 1) skipValue(c, inner);
    return null;
  }
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(readScalar(c, inner));
  return out;
}

/** The keys this module reads. Everything else in the header is skipped. */
const WANTED = /^(general\.(architecture|name|file_type|size_label|parameter_count)|[\w.]+\.(block_count|context_length|embedding_length|full_attention_interval|attention\.(head_count|head_count_kv|key_length|value_length|sliding_window|sliding_window_pattern)|expert_count|expert_used_count|ssm\.\w+))$/;

/** Every wanted key/value of a GGUF header, or null when it is not a readable GGUF. */
export function readGgufHeader(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const c = cursor(fd);
    if (c.u32() !== MAGIC) return null;
    const version = c.u32();
    if (version < 2 || version > 3) return null;
    const tensors = c.u64();
    const count = c.u64();
    const kv = {};
    for (let i = 0; i < count; i += 1) {
      const key = c.bytes(c.u64()).toString("utf8");
      const type = c.u32();
      if (WANTED.test(key)) kv[key] = readValue(c, type);
      else skipValue(c, type);
    }
    return { version, tensors, kv };
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
/** A per-layer array (some models vary head counts by layer) as its total, else the scalar times layers. */
const perLayerTotal = (v, layers) => {
  if (Array.isArray(v)) return v.reduce((sum, x) => sum + (positive(x) ?? 0), 0) || null;
  return positive(v) && layers ? v * layers : null;
};

/**
 * The model's shape for the fit arithmetic.
 *
 * `kvBytesPerToken` is the f16 KV cache for one token across all layers:
 * sum over layers of head_count_kv * (key_length + value_length) * 2 bytes. A model
 * with a sliding window or a hybrid attention stack needs less than this; the figure
 * is the safe upper bound, which is the right side to err on for a VRAM guard.
 */
export function ggufShape(path) {
  const header = readGgufHeader(path);
  if (!header) return null;
  const { kv } = header;
  const arch = typeof kv["general.architecture"] === "string" ? kv["general.architecture"] : null;
  if (!arch) return null;
  const get = (name) => kv[`${arch}.${name}`];
  const layers = positive(get("block_count"));
  const embd = positive(get("embedding_length"));
  const heads = Array.isArray(get("attention.head_count")) ? Math.max(...get("attention.head_count")) : positive(get("attention.head_count"));
  const headDim = heads && embd ? embd / heads : null;
  const keyLen = positive(get("attention.key_length")) ?? headDim;
  const valLen = positive(get("attention.value_length")) ?? headDim;
  // A hybrid stack (Qwen3.5-style linear attention, Mamba blocks) keeps a KV cache on
  // every Nth layer only; the others hold a small fixed state. Counting every layer
  // would put the 27B Qwen at four times its real KV and refuse a context it runs at.
  const interval = positive(get("full_attention_interval"));
  const kvLayers = layers && interval ? Math.ceil(layers / interval) : layers;
  const kvHeadsTotal = perLayerTotal(get("attention.head_count_kv") ?? heads, kvLayers);
  const kvBytesPerToken = kvHeadsTotal && keyLen && valLen ? Math.round(kvHeadsTotal * (keyLen + valLen) * 2) : null;
  return {
    arch,
    name: typeof kv["general.name"] === "string" ? kv["general.name"] : null,
    layers,
    kvLayers,
    trainContext: positive(get("context_length")),
    embedding: embd,
    kvBytesPerToken,
    experts: positive(get("expert_count")),
    slidingWindow: positive(get("attention.sliding_window")),
    params: positive(kv["general.parameter_count"]),
  };
}
