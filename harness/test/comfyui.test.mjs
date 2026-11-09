// The ComfyUI plugin, tested against a REAL loopback server rather than a
// stubbed fetch: the plugin talks over HTTP with its own global fetch, so the
// point of the test is the HTTP conversation - the graph it posts, the history
// it polls, the bytes it downloads - not a function signature.
//
// Nothing here needs a GPU, ComfyUI, or the network: the stub answers /system_stats,
// /queue, /object_info, /prompt, /history/<id> and /view with fixed data.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import comfyui, {
  baseUrlOf,
  checkpointsFrom,
  collectOutputFiles,
  describeStats,
  fillTemplate,
  formatNodeErrors,
  leftoverPlaceholders,
  presetFor,
  statusReport,
  urlFor,
} from "../plugins/rosa-comfyui/plugin.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function closedPort(server) {
  return new Promise((resolve) => server.close(() => resolve(server.address()?.port)));
}

/**
 * A ComfyUI-shaped stub. `plan` decides what /prompt and /history answer, so one
 * server covers the happy path, a rejected graph and a render that never lands.
 */
function startComfy({ plan = "ok", historyEmpty = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://stub");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/system_stats") {
      calls.push("system_stats");
      return json(200, {
        system: { comfyui_version: "0.3.68", python_version: "3.11.9 (main, Jul 1 2024)" },
        devices: [{ name: "cuda:0 NVIDIA GeForce RTX 3090", vram_total: 24 * 1024 ** 3, vram_free: 6 * 1024 ** 3 }],
      });
    }
    if (url.pathname === "/queue") {
      calls.push("queue");
      return json(200, { queue_running: [[1]], queue_pending: [[2], [3]] });
    }
    if (url.pathname === "/object_info/CheckpointLoaderSimple") {
      calls.push("object_info");
      return json(200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["qwen-image-2.1.safetensors", "ltx-2.3.safetensors"]] } } } });
    }
    if (url.pathname === "/prompt" && req.method === "POST") {
      const body = await new Promise((resolve) => {
        let text = "";
        req.on("data", (c) => (text += c));
        req.on("end", () => resolve(text));
      });
      calls.push({ path: "prompt", body: JSON.parse(body) });
      if (plan === "reject") {
        return json(400, {
          error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
          node_errors: { "3": { class_type: "CLIPTextEncode", errors: [{ message: "Value not in list", details: "text: 'x' not in []" }] } },
        });
      }
      return json(200, { prompt_id: "abcd1234-0000-0000-0000-000000000000", number: 7, node_errors: {} });
    }
    if (url.pathname.startsWith("/history/")) {
      calls.push("history");
      if (historyEmpty) return json(200, {});
      return json(200, {
        "abcd1234-0000-0000-0000-000000000000": {
          status: { status_str: "success", completed: true, messages: [] },
          outputs: {
            "9": { images: [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }] },
            "10": { text: ["a caption the harness ignores"] },
            "11": { gifs: [{ filename: "clip_00001_.mp4", subfolder: "video", type: "output" }] },
          },
        },
      });
    }
    if (url.pathname === "/view") {
      calls.push({ path: "view", query: Object.fromEntries(url.searchParams) });
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    return json(404, { error: "no such route" });
  });
  return { server, calls };
}

const tmpRoot = () => mkdtempSync(join(tmpdir(), "harness-comfyui-"));

/** A real workflow file on disk, in the shape ComfyUI saves. */
function writeWorkflow(dir, name = "image.json") {
  const graph = {
    "3": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}", clip: ["4", 1] } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "{{negative}}", clip: ["4", 1] } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: "{{width}}", height: "{{height}}", batch_size: 1 } },
    "7": { class_type: "KSampler", inputs: { seed: 42, steps: "{{steps}}", cfg: 1, sampler_name: "euler", scheduler: "simple", model: ["4", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "ComfyUI" } },
  };
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(graph, null, 2), "utf8");
  return path;
}

const tool = (name, config, root) => {
  const plugin = comfyui.tools({ root, config })[name.startsWith("comfy_") ? (name === "comfy_status" ? 0 : 1) : 0];
  return plugin;
};

// ------------------------------------------------------------------ pure parts

test("fillTemplate substitutes deep, keeps keys and JSON types", () => {
  const graph = {
    "3": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}", note: "prefix {{prompt}} suffix" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: "{{width}}", height: "{{height}}" } },
  };
  const filled = fillTemplate(graph, { prompt: "a red door", width: 768, height: 1344 });
  assert.equal(filled["3"].inputs.text, "a red door");
  assert.equal(filled["3"].inputs.note, "prefix a red door suffix");
  assert.equal(filled["5"].inputs.width, 768, "an exact placeholder keeps the number type - ComfyUI validates types");
  assert.equal(filled["5"].inputs.height, 1344);
  assert.equal(filled["3"].class_type, "CLIPTextEncode", "keys are structure, never substituted");
  assert.equal(graph["3"].inputs.text, "{{prompt}}", "the template itself is not mutated");
});

test("leftoverPlaceholders names what is still unfilled", () => {
  const graph = fillTemplate({ a: { text: "{{prompt}}" }, b: { text: "{{negative}}" } }, { prompt: "x" });
  assert.deepEqual(leftoverPlaceholders(graph), ["negative"]);
  assert.deepEqual(leftoverPlaceholders(fillTemplate({ a: "nothing" }, {})), []);
});

test("presetFor explains how to make a preset, and loads a real graph", () => {
  const root = tmpRoot();
  assert.throws(() => presetFor({ presets: {} }, root, "image"), /Save \(API format\)/);
  assert.throws(() => presetFor({ presets: { image: { workflow: "x.json" } } }, root, ""), /configured: image/);
  assert.throws(() => presetFor({ presets: { image: { workflow: "x.json" } } }, root, "video"), /unknown preset "video"/);

  const path = writeWorkflow(root);
  const preset = presetFor({ presets: { image: { workflow: "image.json", params: { width: 1024 } } } }, root, "image");
  assert.equal(preset.path, path);
  assert.equal(preset.graph["9"].class_type, "SaveImage");
  assert.equal(preset.params.width, 1024);
  assert.equal(preset.kind, "image");

  // A file that is not an API-format graph is a broken preset, not an empty queue.
  writeFileSync(join(root, "array.json"), "[1,2,3]", "utf8");
  assert.throws(() => presetFor({ presets: { bad: { workflow: "array.json" } } }, root, "bad"), /not an API-format graph/);
  assert.throws(() => presetFor({ presets: { gone: { workflow: "missing.json" } } }, root, "gone"), /cannot read the workflow/);
});

test("collectOutputFiles takes file lists only, and defaults subfolder/type", () => {
  const files = collectOutputFiles({
    outputs: {
      "9": { images: [{ filename: "a.png" }, { filename: "b.png", subfolder: "s", type: "temp" }] },
      "10": { text: ["not a file"] },
      "11": { images: [], videos: [{ filename: "c.mp4", subfolder: "v", type: "output" }] },
    },
  });
  assert.deepEqual(
    files.map((f) => [f.filename, f.subfolder, f.type, f.channel]),
    [
      ["a.png", "", "output", "images"],
      ["b.png", "s", "temp", "images"],
      ["c.mp4", "v", "output", "videos"],
    ],
  );
  assert.deepEqual(collectOutputFiles({}), []);
});

test("formatNodeErrors turns /prompt's 400 into lines a model can act on", () => {
  const lines = formatNodeErrors({
    error: { message: "Prompt outputs failed validation" },
    node_errors: { "3": { class_type: "CLIPTextEncode", errors: [{ message: "Value not in list", details: "text: 'x' not in []" }] } },
  });
  assert.deepEqual(lines, ["node 3 CLIPTextEncode: Value not in list (text: 'x' not in [])"]);
  assert.deepEqual(formatNodeErrors({ error: { message: "boom" } }), ["boom"]);
  assert.deepEqual(formatNodeErrors({}), []);
});

test("urlFor builds against the configured server only", () => {
  assert.equal(baseUrlOf({ baseUrl: "http://127.0.0.1:8188/" }), "http://127.0.0.1:8188");
  assert.equal(baseUrlOf({}), "http://127.0.0.1:8188");
  assert.equal(urlFor({ baseUrl: "http://box:8188" }, "/view", { filename: "a b.png", subfolder: "" }), "http://box:8188/view?filename=a+b.png&subfolder=");
});

test("describeStats and checkpointsFrom read the shapes ComfyUI really returns", () => {
  const line = describeStats({
    system: { comfyui_version: "0.3.68", python_version: "3.11.9 (main)" },
    devices: [{ name: "cuda:0 RTX 3090", vram_total: 24 * 1024 ** 3, vram_free: 6 * 1024 ** 3 }],
  });
  assert.match(line, /comfyui 0\.3\.68/);
  assert.match(line, /python 3\.11\.9/);
  assert.match(line, /24\.0 GB total \/ 6\.0 GB free/);
  assert.deepEqual(checkpointsFrom({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors", 7]] } } } }), ["a.safetensors"]);
  assert.deepEqual(checkpointsFrom({}), []);
});

// --------------------------------------------------------------- over real HTTP

test("comfy_status reports reachability, queue and installed checkpoints", async () => {
  const { server } = startComfy();
  const port = await listen(server);
  try {
    const report = await statusReport({ baseUrl: `http://127.0.0.1:${port}` });
    assert.match(report, /is up - comfyui 0\.3\.68/);
    assert.match(report, /queue 1 running, 2 pending/);
    assert.match(report, /checkpoints 2: qwen-image-2\.1\.safetensors, ltx-2\.3\.safetensors/);
  } finally {
    await closedPort(server);
  }
});

test("comfy_status on a dead port says so, and says what starts it", async () => {
  const { server } = startComfy();
  const port = await listen(server);
  await closedPort(server); // now nothing is listening there
  const report = await statusReport({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5000 });
  assert.match(report, /is not answering/);
  assert.match(report, /Start it first|starts it/);
  assert.match(report, /downloaded models/);
});

test("comfy_generate posts the filled graph, waits, and saves the files", async () => {
  const root = tmpRoot();
  writeWorkflow(root);
  const { server, calls } = startComfy();
  const port = await listen(server);
  try {
    const config = {
      baseUrl: `http://127.0.0.1:${port}`,
      allowGenerate: true,
      outputDir: "renders",
      pollMs: 10,
      timeoutMs: 5000,
      presets: { image: { workflow: "image.json", label: "Image test", params: { width: 1024, height: 1024, steps: 20, negative: "" } } },
    };
    const result = await comfyui.tools({ root, config })[1].run({ preset: "image", prompt: "a red door in fog", negative: "blurry" });

    const posted = calls.find((c) => c.path === "prompt").body.prompt;
    assert.equal(posted["3"].inputs.text, "a red door in fog");
    assert.equal(posted["6"].inputs.text, "blurry", "the tool's negative beats the preset default");
    assert.equal(posted["7"].inputs.steps, 20);
    assert.equal(typeof posted["7"].inputs.steps, "number");

    assert.match(result, /Image test done in \d+s/);
    const first = join(root, "renders", "abcd1234-ComfyUI_00001_.png");
    const second = join(root, "renders", "abcd1234-clip_00001_.mp4");
    assert.ok(existsSync(first), `expected ${first}`);
    assert.ok(existsSync(second), `expected ${second}`);
    assert.deepEqual(readFileSync(first), PNG, "the downloaded bytes are the file's bytes");
    assert.match(result, /renders/);

    const view = calls.find((c) => c.path === "view");
    assert.equal(view.query.subfolder, "");
    assert.equal(view.query.type, "output");
  } finally {
    await closedPort(server);
  }
});

test("comfy_generate surfaces a rejected graph instead of hanging", async () => {
  const root = tmpRoot();
  writeWorkflow(root);
  const { server } = startComfy({ plan: "reject" });
  const port = await listen(server);
  try {
    const config = { baseUrl: `http://127.0.0.1:${port}`, allowGenerate: true, pollMs: 10, timeoutMs: 5000, presets: { image: { workflow: "image.json" } } };
    await assert.rejects(
      () => comfyui.tools({ root, config })[1].run({ preset: "image", prompt: "x", params: { negative: "", width: 1, height: 1, steps: 1 } }),
      /rejected the graph \(400\):[\s\S]*CLIPTextEncode: Value not in list/,
    );
  } finally {
    await closedPort(server);
  }
});

test("comfy_generate gives up when nothing lands, and names the prompt", async () => {
  const root = tmpRoot();
  writeWorkflow(root);
  const { server } = startComfy({ historyEmpty: true });
  const port = await listen(server);
  try {
    const config = { baseUrl: `http://127.0.0.1:${port}`, allowGenerate: true, pollMs: 5, timeoutMs: 200, presets: { image: { workflow: "image.json" } } };
    await assert.rejects(
      () => comfyui.tools({ root, config })[1].run({ preset: "image", prompt: "x", params: { negative: "", width: 1, height: 1, steps: 1 } }),
      /did not finish within 0s|did not finish within/,
    );
  } finally {
    await closedPort(server);
  }
});

test("generation is off until the config says otherwise, and unfilled slots are named", async () => {
  const root = tmpRoot();
  writeWorkflow(root);
  const denied = await comfyui.tools({ root, config: { allowGenerate: false, presets: { image: { workflow: "image.json" } } } })[1].run({ preset: "image", prompt: "x" });
  assert.match(denied, /allowGenerate=true/);

  // The graph wants {{width}} and the preset supplies nothing, so the call must
  // stop before it queues a graph ComfyUI would reject.
  const missing = comfyui.tools({ root, config: { allowGenerate: true, presets: { image: { workflow: "image.json" } } } })[1].run({ preset: "image", prompt: "x" });
  await assert.rejects(() => missing, /unfilled placeholders: width, height, negative, steps/);
});

test("the plugin declares two tools, two commands and an honest status line", () => {
  const ctx = { root: tmpRoot(), config: { baseUrl: "http://127.0.0.1:9999", allowGenerate: false } };
  assert.equal(comfyui.id, "rosa-comfyui");
  assert.deepEqual(comfyui.tools(ctx).map((t) => t.name), ["comfy_status", "comfy_generate"]);
  assert.deepEqual(Object.keys(comfyui.commands(ctx)), ["status", "presets"]);
  assert.match(comfyui.status(ctx), /report-only on http:\/\/127\.0\.0\.1:9999/);
  assert.match(comfyui.status({ ...ctx, config: { ...ctx.config, allowGenerate: true } }), /generates on/);
});
