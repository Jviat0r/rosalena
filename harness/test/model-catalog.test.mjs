// The picker's two decisions, tested where they are made.
//
// `/api/models` is a mixed list: the router's curated cloud models, whatever the local
// llama.cpp host happens to hold (embeddings, whisper, image and video renderers), and
// the roles, which are not models at all. The page has to answer "which of these can
// answer a chat, and which one should be selected before I choose?" without a DOM, so
// both answers live in ui/model-catalog.mjs - and the same block ships inside app.js.
// These tests pin the rules, the fallback order, and the fact that the two copies are
// the same code.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EFFORT_LEVELS,
  availableEfforts,
  chatModels,
  clampEffort,
  classifyModel,
  isChatModel,
  isCloudModel,
  modelEfforts,
  resolveDefaultModel,
} from "../ui/model-catalog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "ui");

// The four names in the brief, plus the shapes they actually arrive in: a router model
// carries its provider as a prefix, a local one carries "local/".
const CHAT_IDS = [
  "qwen3.8-27b",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
  "claude-sonnet-4-5",
  "local/qwen3.8-27b",
  "opencode-free/deepseek-v4.1-flash-free",
  "openai/glm-5.3-flash-free",
  "anthropic/claude-sonnet-4-5",
  "local/llama-3.2-3b-instruct",
  "gpt-4o",
  "claude-opus-4-1",
  "qwen3-coder-30b",
  "local/qwen2.5-vl-7b",
];

test("chat models are never dropped, whatever their provider prefix", () => {
  for (const id of CHAT_IDS) {
    const verdict = classifyModel(id);
    assert.equal(verdict.chat, true, `${id} must stay in the picker (said ${verdict.kind}: ${verdict.why})`);
    assert.equal(verdict.kind, "chat");
  }
  assert.deepEqual(chatModels(CHAT_IDS.map((id) => ({ id }))).map((row) => row.id), CHAT_IDS);
});

test("every non-chat family the menu can return is rejected, with the family named", () => {
  const families = {
    embedding: [
      "text-embedding-3-large",
      "openai/embedding-ada-002",
      "local/bge-m3",
      "local/nomic-embed-text",
      "openai/text-embedding-3-small",
      "local/gte-large",
      "local/e5-large-v2",
      "voyage-3-large",
      "jina-embeddings-v3",
    ],
    rerank: ["bge-reranker-v2-m3", "cohere/rerank-3", "jina-reranker-v2", "local/bce-reranker"],
    moderation: ["omni-moderation-latest", "local/llama-guard-3-8b", "openai/moderation-omni"],
    audio: [
      "whisper-large-v3",
      "local/whisper-large-v3-turbo",
      "tts-1",
      "local/tts-1",
      "gpt-4o-mini-tts",
      "gpt-4o-realtime-preview",
      "local/fish-speech-1.4",
      "suno-v3",
      "local/parakeet-tdt",
      "elevenlabs/voice-clone",
      "local/musicgen-large",
      "gpt-4o-transcribe",
      "local/dia-tts",
    ],
    image: [
      "dall-e-3",
      "gpt-image-1",
      "local/flux1-dev",
      "sdxl-turbo",
      "local/sd3-medium",
      "stable-diffusion-xl",
      "local/kolors",
      "playground-v2",
      "local/imagen-3",
      "midjourney-v6",
      "ideogram-v2",
      "recraft-v3",
    ],
    video: [
      "local/ltxv23-uncensored",
      "local/wan2.2-t2v",
      "cogvideox-5b",
      "local/svd-xt",
      "local/hunyuanvideo",
      "local/animatediff-clip",
      "local/mochi-1",
      "veo-3",
      "sora-2",
      "kling-2.1",
      "runway-gen4",
      "local/moviegen",
    ],
    completion: ["davinci-002", "text-curie-001", "babbage-002", "local/ada-002"],
    other: ["local/yolo-v8", "local/sam2-huge", "local/classifier-small", "local/clip-vit-large"],
  };
  for (const [family, ids] of Object.entries(families)) {
    for (const id of ids) {
      const verdict = classifyModel(id);
      assert.equal(verdict.chat, false, `${id} must not reach the picker`);
      assert.equal(verdict.kind, family, `${id} is a ${family} model, got "${verdict.kind}" (${verdict.why})`);
      assert.equal(isChatModel(id), false);
    }
  }
});

test("the menu's own verdict beats a name guess in both directions", () => {
  assert.equal(classifyModel({ id: "local/mystery-7b", chat: false }).chat, false);
  assert.equal(classifyModel({ id: "local/mystery-7b", kind: "image" }).chat, false);
  assert.equal(classifyModel({ id: "local/mystery-7b", kind: "chat" }).chat, true);
  // An entry the server explicitly calls a chat model stays chosen even when a name
  // rule would have guessed otherwise: the server knows its own host.
  assert.equal(classifyModel({ id: "local/ldm-chat-3b", chat: true }).chat, true);
  assert.match(classifyModel({ id: "local/whisper-large" }).why, /whisper/);
});

test("a cloud model is the default, whichever order the menu lists it in", () => {
  const rows = [
    { id: "local/qwen3.8-27b", provider: "local", source: "local" },
    { id: "opencode-free/deepseek-v4.1-flash-free", provider: "opencode-free" },
    { id: "local/whisper-large-v3", provider: "local", source: "local", chat: false },
  ];
  const resolved = resolveDefaultModel({ rows });
  assert.equal(resolved.tier, "cloud");
  assert.equal(resolved.id, "opencode-free/deepseek-v4.1-flash-free");
  assert.equal(resolved.storedDropped, false);
  assert.match(resolved.reason, /cloud/);
  assert.equal(isCloudModel(resolved.row), true);
});

test("the first cloud chat model in the menu's own order wins, not the first row", () => {
  const rows = [
    { id: "local/bge-m3", provider: "local", source: "local", chat: false },
    { id: "opencode-free/glm-5.3-flash-free", provider: "opencode-free" },
    { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
  ];
  assert.equal(resolveDefaultModel({ rows }).id, "opencode-free/glm-5.3-flash-free");
});

test("a router that did not answer is not a cloud default: it falls to local", () => {
  const rows = [
    { id: "opencode-free/deepseek-v4.1-flash-free", provider: "opencode-free" },
    { id: "local/qwen3.8-27b", provider: "local", source: "local" },
  ];
  const resolved = resolveDefaultModel({ rows, errors: ["router http://127.0.0.1:8077: timed out after 1500ms"] });
  assert.equal(resolved.tier, "local");
  assert.equal(resolved.id, "local/qwen3.8-27b");
  assert.match(resolved.reason, /no cloud model is reachable/);
});

test("a local default prefers the model that is already resident", () => {
  const rows = [
    { id: "local/llama-3.2-3b-instruct", provider: "local", source: "local", loaded: false },
    { id: "local/qwen3.8-27b", provider: "local", source: "local", loaded: true },
  ];
  const resolved = resolveDefaultModel({ rows, errors: ["router http://127.0.0.1:8077: HTTP 503"] });
  assert.equal(resolved.id, "local/qwen3.8-27b");
  assert.match(resolved.reason, /loaded local model/);
});

test("nothing is selected when no listed model can answer, and the reason says why", () => {
  const rows = [
    { id: "local/whisper-large-v3", provider: "local", source: "local", chat: false },
    { id: "local/flux1-dev", provider: "local", source: "local", chat: false },
  ];
  for (const errors of [
    [],
    ["router http://127.0.0.1:8077: timed out"],
    ["router http://127.0.0.1:8077: timed out", "local http://127.0.0.1:8080: timed out"],
  ]) {
    const resolved = resolveDefaultModel({ rows, errors });
    assert.equal(resolved.tier, "none");
    assert.equal(resolved.id, "", "an empty id is the page's 'follow the role', not a model called \"\"");
    assert.match(resolved.reason, /no model is selected/);
  }
});

test("a cloud row the menu marks unavailable is skipped, not chosen", () => {
  const rows = [
    { id: "opencode-free/deepseek-v4.1-flash-free", provider: "opencode-free", available: false },
    { id: "anthropic/claude-sonnet-4-5", provider: "anthropic", available: true },
  ];
  const resolved = resolveDefaultModel({ rows });
  assert.equal(resolved.tier, "cloud");
  assert.equal(resolved.id, "anthropic/claude-sonnet-4-5", "the first usable cloud row, not the first row");
});

test("both servers down is named as both, not as one", () => {
  const resolved = resolveDefaultModel({
    rows: [{ id: "opencode-free/deepseek-v4.1-flash-free", provider: "opencode-free" }],
    errors: ["router http://127.0.0.1:8077: timed out", "local http://127.0.0.1:8080: timed out"],
  });
  assert.equal(resolved.tier, "none");
  assert.match(resolved.reason, /neither the router nor the local model server/);
});

test("a stored chat model is kept, so a reload does not change the answer", () => {
  const rows = [
    { id: "opencode-free/deepseek-v4.1-flash-free", provider: "opencode-free" },
    { id: "anthropic/claude-sonnet-4-5", provider: "anthropic" },
  ];
  const resolved = resolveDefaultModel({ rows, stored: "anthropic/claude-sonnet-4-5" });
  assert.equal(resolved.tier, "stored");
  assert.equal(resolved.id, "anthropic/claude-sonnet-4-5");
  assert.equal(resolved.storedDropped, false);
});

test("a stored non-chat model is dropped quietly and the default takes over", () => {
  const rows = [
    { id: "local/whisper-large-v3", provider: "local", source: "local", chat: false },
    { id: "opencode-free/deepseek-v4.1-flash-free", provider: "opencode-free" },
  ];
  const resolved = resolveDefaultModel({ rows, stored: "local/whisper-large-v3" });
  assert.equal(resolved.storedDropped, true, "the caller must clear the key, in silence");
  assert.equal(resolved.tier, "cloud");
  assert.equal(resolved.id, "opencode-free/deepseek-v4.1-flash-free");
  assert.notEqual(resolved.id, "local/whisper-large-v3");
});

test("a stored model that vanished from the menu is dropped the same quiet way", () => {
  const rows = [{ id: "local/qwen3.8-27b", provider: "local", source: "local" }];
  const resolved = resolveDefaultModel({ rows, stored: "openai/gpt-4o" });
  assert.equal(resolved.storedDropped, true);
  assert.equal(resolved.id, "local/qwen3.8-27b");
  assert.equal(resolved.tier, "local");
});

test("effort levels follow the pinned model, and the union when it declares none", () => {
  const rows = [
    { id: "opencode-free/deepseek-v4.1-flash-free", provider: "opencode-free", efforts: ["low", "high"] },
    { id: "local/qwen3.8-27b", provider: "local", source: "local", efforts: ["medium"] },
  ];
  assert.deepEqual(availableEfforts(rows, "opencode-free/deepseek-v4.1-flash-free"), ["low", "high"]);
  assert.deepEqual(availableEfforts(rows, "local/qwen3.8-27b"), ["medium"]);
  // A pinned row that declares nothing must still offer the levels the menu honours: the
  // router drops the field where it cannot be honoured, so the submenu stays usable.
  assert.deepEqual(availableEfforts([{ id: "openai/gpt-5.1", provider: "openai" }, ...rows], "openai/gpt-5.1"), ["low", "medium", "high"]);
  assert.deepEqual(availableEfforts(rows, ""), ["low", "medium", "high"]);
  assert.deepEqual(availableEfforts(rows, "missing/model"), ["low", "medium", "high"]);
  assert.deepEqual(modelEfforts({ efforts: ["max", "high", "low", "turbo"] }), ["low", "high", "max"]);
  assert.deepEqual(EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
});

test("a stored effort the selected model cannot honour is not sent", () => {
  const efforts = ["low", "high"];
  assert.equal(clampEffort("high", efforts), "high");
  assert.equal(clampEffort("medium", efforts), "", "a level the model does not declare becomes Default");
  assert.equal(clampEffort("", efforts), "");
  assert.equal(clampEffort("high", []), "");
});

test("the block app.js runs is byte-identical to the block this test imports", () => {
  const read = (file) => readFileSync(join(UI, file), "utf8").replace(/\r\n/g, "\n");
  const block = (text, file) => {
    const begin = "// ==== model-catalog block: begin ====";
    const end = "// ==== model-catalog block: end ====";
    const from = text.indexOf(begin);
    const to = text.indexOf(end);
    assert.ok(from >= 0 && to > from, `${file} is missing the model-catalog block markers`);
    return text.slice(from, to + end.length);
  };
  const module = block(read("model-catalog.mjs"), "ui/model-catalog.mjs");
  const page = block(read("app.js"), "ui/app.js");
  assert.equal(page, module, "ui/app.js has drifted from ui/model-catalog.mjs; copy the block across");
});

// The rest is structural: this project has no DOM in its tests, so the only executable
// claims left are about the code the page runs. Each one names the exact line it pins.

const app = () => readFileSync(join(UI, "app.js"), "utf8").replace(/\r\n/g, "\n");
const pageHtml = () => readFileSync(join(UI, "index.html"), "utf8").replace(/\r\n/g, "\n");

test("the standalone effort dropdown is removed at load, and nothing can re-show it", () => {
  const source = app();
  assert.match(source, /el\("effort-pick"\)\?\.remove\(\);/, "app.js must remove the old effort control");
  assert.doesNotMatch(source, /effortPick/, "no reference to the removed control may survive");
  assert.doesNotMatch(source, /effortSel/, "the old effort select must not be read or written");
  // The call is optional on purpose: the markup is another surface's file, so this holds
  // whether or not index.html still declares the control when the page loads.
});

test("effort renders as a row inside the model menu, not as a second control", () => {
  const source = app();
  const menu = source.slice(source.indexOf("function renderModelMenu"), source.indexOf("function renderEffortMenu"));
  assert.match(menu, /root\.append\(separatorNode\(\), buildEffortRow\(\), buildContextRow\(\), buildDownloadRow\(\)\)/, "the effort row, the context window, and the way to more models must be inside the model menu");
  const row = source.slice(source.indexOf("function buildEffortRow"), source.indexOf("function renderEffortMenu"));
  assert.match(row, /row\.setAttribute\("role", "menuitem"\)/);
  assert.match(row, /row\.setAttribute\("aria-haspopup", "menu"\)/);
  assert.match(row, /row\.setAttribute\("aria-controls", "model-effort-menu"\)/);
  // The submenu is a real menu of radio items, which is what a screen reader needs.
  assert.match(source, /effort\.setAttribute\("role", "menu"\)/);
  assert.match(source, /item\.setAttribute\("role", "menuitemradio"\)/);
});

test("the picker offers chat models only, and the request carries the clamped effort", () => {
  const source = app();
  // The synthetic row is gone from the DOM, so nothing can select it: no option is ever
  // created with an empty value and the label that used to sit on it.
  assert.doesNotMatch(source, /textContent = "Role default"/, "the synthetic role-default row must be gone");
  assert.match(source, /const rows = chatModels\(state\.models\);/, "the visible list must come from chatModels");
  assert.match(source, /effort: effectiveEffort\(\)/, "the payload reads the clamped level, not a DOM control");
  // The owner asked for the redundant top-bar Role and Model selects to be gone, not hidden:
  // a shadow `<select id="model">` kept alive as a value store is still the duplicate that was
  // complained about. The composer's own picker is the single control, and the role is the
  // server default, so neither select may come back.
  assert.doesNotMatch(pageHtml(), /<select id="model"/, "the top-bar model select must be gone");
  assert.doesNotMatch(pageHtml(), /<select id="role"/, "the top-bar role select must be gone");
  assert.doesNotMatch(source, /getElementById\("model"\)|querySelector\("#model"\)/, "nothing may read a #model element");
  assert.doesNotMatch(source, /getElementById\("role"\)|querySelector\("#role"\)/, "nothing may read a #role element");
  assert.match(pageHtml(), /<select id="quick-model">/, "the composer picker stays");
});

test("the trigger says which model is selected and why, in the title and the label", () => {
  const source = app();
  const triggers = source.slice(source.indexOf("function renderModelTriggers"), source.indexOf("function openModelMenu"));
  assert.match(triggers, /state\.pick\?\.reason/, "the reason must come from the default resolution");
  assert.match(triggers, /trigger\.title = title/);
  assert.match(triggers, /trigger\.setAttribute\("aria-label", title\)/);
});
