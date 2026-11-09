/**
 * The GGUF header reader (src/gguf.mjs): the four numbers the fit arithmetic needs, read
 * from files built here byte by byte - a plain transformer, a hybrid with a KV cache on
 * every 4th layer, a big vocabulary array that has to be skipped, and files that are not
 * GGUF at all.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ggufShape, readGgufHeader } from "../src/gguf.mjs";

const dir = mkdtempSync(join(tmpdir(), "gguf-test-"));

/** A GGUF v3 header with these key/values and no tensors. */
function gguf(entries) {
  const parts = [];
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    parts.push(b);
  };
  const u64 = (n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    parts.push(b);
  };
  const str = (s) => {
    const b = Buffer.from(s, "utf8");
    u64(b.length);
    parts.push(b);
  };
  u32(0x46554747);
  u32(3);
  u64(0);
  u64(entries.length);
  for (const [key, type, value] of entries) {
    str(key);
    u32(type);
    if (type === 4) u32(value);
    else if (type === 8) str(value);
    else if (type === 9) {
      const [inner, values] = value;
      u32(inner);
      u64(values.length);
      for (const v of values) inner === 8 ? str(v) : u32(v);
    }
  }
  return Buffer.concat(parts);
}

const file = (name, bytes) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

test("a plain transformer: layers, trained context and the f16 KV bytes per token", () => {
  // Llama 3.1 8B's shape: 32 layers, 8 KV heads of 128 -> 32 * 8 * 256 * 2 = 128 KiB per token.
  const path = file(
    "llama.gguf",
    gguf([
      ["general.architecture", 8, "llama"],
      ["general.name", 8, "Test Llama"],
      // A vocabulary the reader must step over without decoding it into memory.
      ["tokenizer.ggml.tokens", 9, [8, Array.from({ length: 5000 }, (_, i) => `tok${i}`)]],
      ["llama.block_count", 4, 32],
      ["llama.context_length", 4, 131072],
      ["llama.embedding_length", 4, 4096],
      ["llama.attention.head_count", 4, 32],
      ["llama.attention.head_count_kv", 4, 8],
    ]),
  );
  const shape = ggufShape(path);
  assert.equal(shape.arch, "llama");
  assert.equal(shape.name, "Test Llama");
  assert.equal(shape.layers, 32);
  assert.equal(shape.trainContext, 131072);
  assert.equal(shape.kvBytesPerToken, 131072);
  assert.equal(readGgufHeader(path).kv["tokenizer.ggml.tokens"], undefined, "the vocabulary is skipped, not kept");
});

test("a hybrid stack counts only the layers that keep a KV cache", () => {
  // Qwen3.5-style: 64 layers, full attention on every 4th, explicit key/value lengths.
  const path = file(
    "hybrid.gguf",
    gguf([
      ["general.architecture", 8, "qwen35"],
      ["qwen35.block_count", 4, 64],
      ["qwen35.context_length", 4, 262144],
      ["qwen35.embedding_length", 4, 5120],
      ["qwen35.attention.head_count", 4, 24],
      ["qwen35.attention.head_count_kv", 4, 4],
      ["qwen35.attention.key_length", 4, 256],
      ["qwen35.attention.value_length", 4, 256],
      ["qwen35.full_attention_interval", 4, 4],
    ]),
  );
  const shape = ggufShape(path);
  assert.equal(shape.kvLayers, 16);
  assert.equal(shape.kvBytesPerToken, 16 * 4 * 512 * 2);
});

test("per-layer KV head counts are summed", () => {
  const path = file(
    "perlayer.gguf",
    gguf([
      ["general.architecture", 8, "mixed"],
      ["mixed.block_count", 4, 4],
      ["mixed.embedding_length", 4, 1024],
      ["mixed.attention.head_count", 4, 8],
      ["mixed.attention.head_count_kv", 9, [4, [2, 0, 2, 0]]],
    ]),
  );
  // head dim 1024 / 8 = 128; (2 + 2) heads * (128 + 128) * 2 bytes.
  assert.equal(ggufShape(path).kvBytesPerToken, 4 * 256 * 2);
});

test("anything that is not a readable GGUF gives null, never a throw", () => {
  assert.equal(ggufShape(file("text.gguf", Buffer.from("not a model at all"))), null);
  assert.equal(ggufShape(join(dir, "missing.gguf")), null);
  const whole = gguf([["general.architecture", 8, "llama"], ["llama.block_count", 4, 32]]);
  assert.equal(ggufShape(file("cut.gguf", whole.subarray(0, whole.length - 3))), null, "a truncated header");
});
