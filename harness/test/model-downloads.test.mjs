/**
 * Downloads from the Models page.
 *
 *   - the size and sha256 come from Hugging Face's headers, through its rename redirects
 *   - a file is kept only when both match; a gated or missing file is a clear refusal
 *   - a chat model goes to ~/.rosalena/models, a media model to models/<kind>/<folder>
 *   - split files are refused, one job runs at a time, cancel stops it
 *   - the media catalog loads and scores into fits / tight / tooBig with references on a 24 GB card
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadCatalog } from "../src/catalog.mjs";
import { GIB } from "../src/hardware.mjs";
import { createModelDownloader, downloadTarget, findDownloaded, isSplitFile, loadMediaCatalog, resolveRemote, scoreMedia } from "../src/model-downloads.mjs";

const PAYLOAD = Buffer.from("pretend these are model weights ".repeat(64));
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");

/** A tiny Hugging Face: a renamed repo (307), then the 302 that carries the x-linked headers. */
function fakeHub({ gated = false, wrongHash = false, slow = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const headers = new Headers();
    if (url.includes("/old-name/")) {
      headers.set("location", url.replace("https://huggingface.co", "").replace("/old-name/", "/new-name/"));
      return new Response(null, { status: 307, headers });
    }
    if (gated) return new Response(null, { status: 401 });
    if (init.method === "HEAD") {
      headers.set("x-linked-size", String(PAYLOAD.length));
      headers.set("x-linked-etag", `"${wrongHash ? "0".repeat(64) : SHA}"`);
      headers.set("location", "https://cdn.example/blob");
      return new Response(null, { status: 302, headers });
    }
    if (slow) {
      let sent = 0;
      const body = new ReadableStream({
        async pull(controller) {
          await new Promise((done) => setTimeout(done, 30));
          if (sent >= PAYLOAD.length) return controller.close();
          controller.enqueue(PAYLOAD.subarray(sent, sent + 64));
          sent += 64;
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response(PAYLOAD, { status: 200 });
  };
  return { fetchImpl, calls };
}

const wait = async (downloader, phases = ["done", "failed", "cancelled"]) => {
  for (let i = 0; i < 400; i += 1) {
    const job = downloader.job();
    if (job && phases.includes(job.phase)) return job;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(`no ${phases.join("/")} in time: ${JSON.stringify(downloader.job())}`);
};

test("Hugging Face's headers give the size and checksum, through a renamed repo", async () => {
  const { fetchImpl } = fakeHub();
  const remote = await resolveRemote("https://huggingface.co/org/old-name/resolve/main/m.gguf", { fetchImpl });
  assert.equal(remote.bytes, PAYLOAD.length);
  assert.equal(remote.sha256, SHA);
  assert.match(remote.url, /new-name/);
  await assert.rejects(resolveRemote("https://huggingface.co/org/x/resolve/main/m.gguf", { fetchImpl: fakeHub({ gated: true }).fetchImpl }), /gated/);
});

test("a media model downloads into its kind and ComfyUI folder, checked", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-dl-"));
  const mediaCatalog = { models: [{ id: "pic", kind: "image", name: "Pic", folder: "checkpoints", needGiB: 4, file: { name: "pic.safetensors", url: "https://huggingface.co/org/old-name/resolve/main/pic.safetensors" } }] };
  const target = downloadTarget({ kind: "image", id: "pic", mediaCatalog, home });
  assert.equal(target.dest, join(home, "models", "image", "checkpoints", "pic.safetensors"));
  assert.equal(findDownloaded(target), null);

  const downloader = createModelDownloader({ home, fetchImpl: fakeHub().fetchImpl, hasServer: () => true });
  assert.equal(downloader.start(target).ok, true);
  const job = await wait(downloader);
  assert.equal(job.phase, "done", job.error);
  assert.deepEqual(readFileSync(target.dest), PAYLOAD);
  assert.equal(findDownloaded(target), target.dest);
});

test("a file whose checksum does not match is deleted, not kept", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-dl-bad-"));
  const mediaCatalog = { models: [{ id: "v", kind: "voice", name: "V", folder: "whisper", needGiB: 1, file: { name: "v.bin", url: "https://huggingface.co/org/r/resolve/main/v.bin" } }] };
  const target = downloadTarget({ kind: "voice", id: "v", mediaCatalog, home });
  const downloader = createModelDownloader({ home, fetchImpl: fakeHub({ wrongHash: true }).fetchImpl, hasServer: () => true, hasWhisper: () => true });
  downloader.start(target);
  const job = await wait(downloader);
  assert.equal(job.phase, "failed");
  assert.match(job.error, /checksum/);
  assert.equal(existsSync(target.dest), false);
  assert.equal(existsSync(`${target.dest}.part`), false);
});

test("chat models go to the shelf folder; split files and a second job are refused; cancel stops", async () => {
  const home = mkdtempSync(join(tmpdir(), "harness-dl-chat-"));
  const chatCatalog = {
    models: [
      { id: "tiny", name: "Tiny", quants: [{ quant: "Q4_K_M", file: 0.002, url: "https://huggingface.co/org/r/resolve/main/Tiny-Q4_K_M.gguf" }, { quant: "Q8_0", file: 1, url: "https://huggingface.co/org/r/resolve/main/Q8/Tiny-Q8_0-00001-of-00002.gguf" }] },
    ],
  };
  const target = downloadTarget({ kind: "chat", id: "tiny", quant: "Q4_K_M", chatCatalog, home });
  assert.equal(target.dest, join(home, "models", "Tiny-Q4_K_M.gguf"));
  const split = downloadTarget({ kind: "chat", id: "tiny", quant: "Q8_0", chatCatalog, home });
  assert.equal(split.split, true);
  assert.equal(isSplitFile(split.url), true);

  const downloader = createModelDownloader({ home, fetchImpl: fakeHub({ slow: true }).fetchImpl, hasServer: () => true });
  assert.equal(downloader.start(split).code, "split");
  assert.equal(downloader.start(null).code, "unknown");
  assert.equal(downloader.start(target).ok, true);
  assert.equal(downloader.start(target).code, "busy");
  await wait(downloader, ["model"]);
  downloader.cancel();
  const job = await wait(downloader);
  assert.equal(job.phase, "cancelled");
  assert.equal(existsSync(target.dest), false, "a cancelled download is not installed");
});

test("the shipped catalogs load, every media file is pinned, and a 24 GB card gets references", () => {
  const media = loadMediaCatalog();
  const kinds = new Set(media.models.map((m) => m.kind));
  assert.deepEqual([...kinds].sort(), ["image", "video", "voice"]);
  for (const m of media.models) {
    assert.match(m.file.url, /^https:\/\/huggingface\.co\/.+\/resolve\/main\//, m.id);
    assert.ok(m.file.bytes > 1e6, `${m.id} has a size`);
    assert.match(m.file.sha256, /^[0-9a-f]{64}$/, `${m.id} has a sha256`);
  }
  const card = { gpu: { vramTotalBytes: 24 * GIB, vramFreeBytes: 24 * GIB }, ram: { totalBytes: 64 * GIB, freeBytes: 40 * GIB } };
  const scored = scoreMedia({ hardware: card, catalog: media });
  for (const kind of ["image", "video"]) {
    assert.ok(scored[kind].fits.length >= 1, `${kind}: something fits`);
    assert.ok(scored[kind].tight.length + scored[kind].tooBig.length >= 2, `${kind}: at least two reference rows that do not fit comfortably`);
  }
  assert.ok(scored.voice.fits.length >= 3);
  // No graphics card: image and video say so; the CPU-friendly voice models still fit.
  const laptop = scoreMedia({ hardware: { gpu: null, ram: { freeBytes: 8 * GIB } }, catalog: media });
  assert.equal(laptop.image.fits.length, 0);
  assert.match(laptop.image.tooBig[0].reason, /graphics card/);
  assert.ok(laptop.voice.fits.some((r) => r.id === "whisper-large-v3-turbo" && r.device === "cpu"));

  // The chat catalog keeps two honest "does not fit" rows for a 24 GB card.
  const chat = loadCatalog();
  assert.ok(chat.models.some((m) => m.id === "qwen2.5-72b"));
});
