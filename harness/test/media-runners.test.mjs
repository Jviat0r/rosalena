/**
 * What runs the image, video and voice models (src/comfy-runner.mjs, src/voice-runner.mjs)
 * and the downloads that feed them (src/model-downloads.mjs):
 *
 *   - a model with companions (text encoder, VAE) downloads all of them, and counts as
 *     downloaded only when all are there; a Whisper model brings whisper.cpp first
 *   - downloaded models with a workflow become runnable graphs, filled with their file names
 *   - ComfyUI is found by main.py plus its Python, started hidden when nothing answers,
 *     used as it is when someone else's is up, and stopped after idle only if it is ours
 *   - room on the card: our idle chat model goes first; too big even with RAM spill is refused
 *   - whisper.cpp: models best first, English-only models skip language detection, the
 *     transcript is read from stdout
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createComfyRunner, extraPathsYaml, findComfyInstall, runnableModels, setLocalRelease } from "../src/comfy-runner.mjs";
import { createModelDownloader, downloadTarget, findDownloaded } from "../src/model-downloads.mjs";
import { transcribeFile, voiceStatus, whisperArgs, whisperModels } from "../src/voice-runner.mjs";

const GIB = 1024 ** 3;
const PAYLOAD = Buffer.from("weights ".repeat(40));
const SHA = createHash("sha256").update(PAYLOAD).digest("hex");
const hub = async () => new Response(PAYLOAD, { status: 200 });
const wait = async (downloader) => {
  for (let i = 0; i < 400; i += 1) {
    const job = downloader.job();
    if (job && ["done", "failed", "cancelled"].includes(job.phase)) return job;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error("the download did not finish");
};
const file = (path, body = "x") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

const CATALOG = {
  models: [
    {
      id: "vid",
      kind: "video",
      name: "Vid",
      folder: "diffusion_models",
      needGiB: 14,
      workflow: "wan22-ti2v",
      defaults: { width: 640, height: 352, frames: 25, fps: 24, steps: 4, cfg: 5, sampler: "uni_pc", scheduler: "simple", shift: 8 },
      file: { name: "vid.safetensors", url: "https://huggingface.co/o/r/resolve/main/vid.safetensors", bytes: PAYLOAD.length, sha256: SHA },
      companions: [
        { role: "clip", folder: "text_encoders", name: "enc.safetensors", url: "https://huggingface.co/o/r/resolve/main/enc.safetensors", bytes: PAYLOAD.length, sha256: SHA },
        { role: "vae", folder: "vae", name: "vae.safetensors", url: "https://huggingface.co/o/r/resolve/main/vae.safetensors", bytes: PAYLOAD.length, sha256: SHA },
      ],
    },
    { id: "pic", kind: "image", name: "Pic", folder: "checkpoints", needGiB: 8, workflow: "checkpoint-image", defaults: { width: 512, height: 512, steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" }, file: { name: "pic.safetensors", url: "https://huggingface.co/o/r/resolve/main/pic.safetensors", bytes: PAYLOAD.length, sha256: SHA } },
    { id: "plain", kind: "image", name: "No graph", folder: "checkpoints", needGiB: 8, file: { name: "plain.safetensors", url: "https://huggingface.co/o/r/resolve/main/plain.safetensors" } },
  ],
};

test("a model with a text encoder and a VAE downloads all three, and is downloaded only with all three", async () => {
  const home = mkdtempSync(join(tmpdir(), "media-dl-"));
  const target = downloadTarget({ kind: "video", id: "vid", mediaCatalog: CATALOG, home });
  assert.equal(target.companions.length, 2);
  assert.equal(target.approxBytes, PAYLOAD.length * 3);
  const downloader = createModelDownloader({ home, fetchImpl: hub, hasServer: () => true });
  downloader.start(target);
  const job = await wait(downloader);
  assert.equal(job.phase, "done", job.error);
  assert.ok(existsSync(join(home, "models", "video", "text_encoders", "enc.safetensors")));
  assert.ok(existsSync(join(home, "models", "video", "vae", "vae.safetensors")));
  assert.equal(findDownloaded(target), target.dest);
  // One companion missing again: not downloaded, and a retry fetches only that file.
  const { rmSync } = await import("node:fs");
  rmSync(join(home, "models", "video", "vae", "vae.safetensors"));
  assert.equal(findDownloaded(target), null);
  const asked = [];
  const again = createModelDownloader({ home, fetchImpl: async (url) => (asked.push(url), new Response(PAYLOAD, { status: 200 })), hasServer: () => true });
  again.start(target);
  assert.equal((await wait(again)).phase, "done");
  assert.deepEqual(asked.map((url) => url.split("/").pop()), ["vae.safetensors"]);
});

test("a Whisper model brings the whisper.cpp runner with it when there is none", async () => {
  const home = mkdtempSync(join(tmpdir(), "media-whisper-"));
  const catalog = { models: [{ id: "w", kind: "voice", name: "W", folder: "whisper", needGiB: 1, file: { name: "ggml-base.en.bin", url: "https://huggingface.co/o/r/resolve/main/ggml-base.en.bin", bytes: PAYLOAD.length, sha256: SHA } }] };
  const target = downloadTarget({ kind: "voice", id: "w", mediaCatalog: catalog, home });
  assert.equal(target.engine, "whisper");
  const order = [];
  const downloader = createModelDownloader({
    home,
    fetchImpl: async (url) => (order.push("model"), new Response(PAYLOAD, { status: 200 })),
    hasServer: () => true,
    hasWhisper: () => false,
    installWhisper: async () => order.push("runner"),
  });
  downloader.start(target);
  assert.equal((await wait(downloader)).phase, "done");
  assert.deepEqual(order, ["runner", "model"]);
});

test("downloaded models with a workflow become graphs filled with their own file names", () => {
  const home = mkdtempSync(join(tmpdir(), "media-run-"));
  file(join(home, "models", "video", "diffusion_models", "vid.safetensors"));
  file(join(home, "models", "video", "text_encoders", "enc.safetensors"));
  file(join(home, "models", "video", "vae", "vae.safetensors"));
  file(join(home, "models", "image", "checkpoints", "pic.safetensors"));
  file(join(home, "models", "image", "checkpoints", "plain.safetensors"));
  const models = runnableModels({ home, catalog: CATALOG });
  assert.deepEqual(models.map((m) => m.id), ["pic", "vid"], "image first; no graph, not runnable");
  const vid = models.find((m) => m.id === "vid");
  assert.equal(vid.params.model, "vid.safetensors");
  assert.equal(vid.params.clip, "enc.safetensors");
  assert.equal(vid.params.vae, "vae.safetensors");
  assert.equal(vid.graph["7"].class_type, "Wan22ImageToVideoLatent");
  assert.match(extraPathsYaml("C:\\Users\\me\\.rosalena\\models"), /base_path: C:\/Users\/me\/\.rosalena\/models[\s\S]*image\/checkpoints[\s\S]*video\/vae/);
});

test("ComfyUI is found by main.py plus its own Python", () => {
  const root = mkdtempSync(join(tmpdir(), "comfy-root-"));
  assert.equal(findComfyInstall({ root }), null, "no main.py");
  file(join(root, "main.py"));
  assert.equal(findComfyInstall({ root }), null, "no Python");
  file(process.platform === "win32" ? join(root, ".venv", "Scripts", "python.exe") : join(root, ".venv", "bin", "python"));
  const found = findComfyInstall({ root });
  assert.ok(found.python.includes(".venv"));
});

/** A ComfyUI that answers once started, with a queue the test controls. */
function fakeComfy() {
  const state = { up: false, queue: 0, frees: 0, spawned: [], killed: [] };
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (!state.up) throw new Error("ECONNREFUSED");
    if (path === "/system_stats") return new Response("{}", { status: 200 });
    if (path === "/queue") return new Response(JSON.stringify({ queue_running: Array(state.queue).fill([]), queue_pending: [] }), { status: 200 });
    if (path === "/free" && init.method === "POST") {
      state.frees += 1;
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const spawnImpl = (command, args, options) => {
    state.spawned.push({ command, args, options });
    state.up = true;
    const child = new EventEmitter();
    Object.assign(child, { pid: 777, exitCode: null, killed: false });
    return child;
  };
  const killTreeImpl = async (pid) => {
    state.killed.push(pid);
    state.up = false;
  };
  return { state, fetchImpl, spawnImpl, killTreeImpl };
}

test("ComfyUI is started hidden when nothing answers, and stopped after idle because it is ours", async () => {
  const home = mkdtempSync(join(tmpdir(), "comfy-home-"));
  const fake = fakeComfy();
  let clock = 0;
  const runner = createComfyRunner({ home, ...fake, findInstall: () => ({ root: home, python: "python" }), now: () => clock });
  const out = await runner.ensure({ waitMs: 5000 });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.code, "started");
  const call = fake.state.spawned[0];
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, false, "a child of the app: it ends with it");
  assert.ok(call.args.includes("--extra-model-paths-config"));
  assert.ok(existsSync(join(home, "comfyui-extra-paths.yaml")));

  fake.state.queue = 1;
  clock = 60 * 60_000;
  assert.equal((await runner.tick(10 * 60_000)).action, "none", "rendering: never stopped");
  fake.state.queue = 0;
  clock += 5 * 60_000;
  assert.equal((await runner.tick(10 * 60_000)).action, "none");
  clock += 6 * 60_000;
  assert.equal((await runner.tick(10 * 60_000)).action, "stopped");
  assert.deepEqual(fake.state.killed, [777]);
});

test("a ComfyUI someone else started is used as it is: never freed or stopped", async () => {
  const fake = fakeComfy();
  fake.state.up = true;
  let clock = 0;
  const runner = createComfyRunner({ home: mkdtempSync(join(tmpdir(), "comfy-ext-")), ...fake, findInstall: () => null, now: () => clock });
  assert.equal((await runner.ensure()).code, "external");
  clock = 24 * 60 * 60_000;
  assert.equal((await runner.tick(1)).action, "none");
  assert.equal((await runner.releaseIfIdle()).code, "kept");
  assert.equal(fake.state.frees, 0);
  assert.deepEqual(fake.state.spawned, []);
});

test("no ComfyUI anywhere: a refusal that says how to get it", async () => {
  const runner = createComfyRunner({ home: mkdtempSync(join(tmpdir(), "comfy-none-")), ...fakeComfy(), findInstall: () => null });
  const out = await runner.ensure();
  assert.equal(out.ok, false);
  assert.equal(out.code, "no-comfyui");
  assert.match(out.error, /Install ComfyUI/);
});

test("room on the card: our idle chat model goes first, and a model too big even with RAM spill is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "comfy-room-"));
  let free = 6 * GIB;
  const released = [];
  setLocalRelease(async () => {
    released.push("chat");
    free = 22 * GIB;
    return { ok: true, code: "stopped", model: "qwen" };
  });
  try {
    const runner = createComfyRunner({ home, ...fakeComfy(), gpuImpl: () => ({ freeBytes: free, totalBytes: 24 * GIB }) });
    const fits = await runner.makeRoom(14 * GIB);
    assert.equal(fits.ok, true);
    assert.equal(fits.released, "qwen");
    assert.deepEqual(released, ["chat"]);

    free = 10 * GIB;
    setLocalRelease(async () => ({ ok: false, code: "in-use", holder: "qwen" }));
    const tight = await runner.makeRoom(12 * GIB);
    assert.equal(tight.code, "tight", "ComfyUI keeps part in RAM up to 1.5x");
    const refused = await runner.makeRoom(40 * GIB);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /still running/);
  } finally {
    setLocalRelease(null);
  }
});

test("whisper.cpp: the best model first, English-only models skip detection, text from stdout", async () => {
  const home = mkdtempSync(join(tmpdir(), "voice-home-"));
  assert.equal(voiceStatus(home).code, "no-model");
  file(join(home, "models", "voice", "whisper", "ggml-base.en.bin"));
  file(join(home, "models", "voice", "whisper", "ggml-large-v3-turbo.bin"));
  assert.deepEqual(whisperModels(home).map((m) => m.name), ["ggml-large-v3-turbo.bin", "ggml-base.en.bin"]);
  assert.equal(voiceStatus(home).code, process.platform === "win32" || process.platform === "linux" ? "no-runner" : "unsupported");

  const en = whisperArgs({ model: { path: "m.bin", english: true }, wavPath: "a.wav", threads: 2 });
  assert.deepEqual(en.slice(en.indexOf("-l"), en.indexOf("-l") + 2), ["-l", "en"]);
  assert.ok(whisperArgs({ model: { path: "m.bin", english: false }, wavPath: "a.wav" }).includes("auto"));

  file(join(home, "whisper.cpp", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"));
  const spawnImpl = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", " Add a JSON flag\n[BLANK_AUDIO]\n to the build script.\n");
      child.emit("close", 0);
    });
    child.args = args;
    return child;
  };
  const out = await transcribeFile({ wavPath: "a.wav", home, spawnImpl });
  assert.equal(out.text, "Add a JSON flag to the build script.");
  assert.equal(out.model, "ggml-large-v3-turbo.bin");
});
