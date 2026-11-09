/**
 * The model catalog: what counts as a chat model, and which one a picker should point
 * at before a person has chosen.
 *
 * Two questions, both answered with no DOM and no I/O, so the test suite can import
 * this exact file:
 *
 *   1. Which entries from `/api/models` can answer a chat? A local llama.cpp host
 *      advertises everything it holds - embeddings, whisper, image and video
 *      renderers - and the router's curated list can carry the same families. One
 *      named rule per family keeps a wrong answer to a one-line test failure instead
 *      of a mystery in a dropdown, and the rules are substring/boundary based, never
 *      a guess about what a name "looks like".
 *
 *   2. When nothing is stored, which model is selected? Cloud first, because a cloud
 *      model answers without loading anything on this machine; then a local one; then
 *      nothing at all. "Nothing" is a real state: the picker shows no model and sends
 *      an empty id, which the server already reads as "follow the role". That is the
 *      only honest answer when no listed model can answer.
 *
 * ui/app.js carries a byte-identical copy of the block below, because the UI server
 * serves a fixed list of static files and this one is not on that list. The drift test
 * in test/model-catalog.test.mjs fails the day the copies differ, so the rules the page
 * runs are the rules this file documents and tests.
 */

// ==== model-catalog block: begin ====
// How hard a model should think. The router's vocabulary, in the order a person reads it.
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Ordered: first match wins. Every family the picker must never offer, with the
// boundary discipline that keeps a real chat model from being caught by accident.
// `qwen3.8-27b`, `deepseek-v4.1-flash-free`, `glm-5.3-flash-free` and
// `claude-sonnet-4-5` are the four names the test pins: none of them may match.
const NON_CHAT_RULES = [
  ["rerank", /rerank|re-rank|(?:^|[-_/])ranker(?:[-_/]|$)/i],
  ["embedding", /embed|(?:^|[-_/])(?:bge|gte|e5|bce|voyage)(?:[-_/]|$)|jina[-_](?:embed|clip)/i],
  ["moderation", /moderat|guardrail|(?:^|[-_/])guard(?:ian)?(?:[-_/]|$)|nsfw/i],
  ["audio", /whisper|audio|voice|speech|music|suno|vocoder|realtime|transcribe|(?:^|[-_/])(?:tts|stt|asr|rvc|orpheus|parakeet|dia[-_]?tts|fish[-_]?speech)(?:[-_/]|$)/i],
  ["image", /image|dall[-_]?e|(?:^|[-_/])flux|sdxl|(?:^|[-_/])sd[-_]?3|stable[-_]?diffusion|kolors|playground|(?:^|[-_/])imagen|diffusion|midjourney|ideogram|recraft|img[-_]?2img/i],
  ["video", /(?:^|[-_/])ltx|ltx[-_]?v|video|movie|(?:^|[-_/])wan[-_]?\d|hunyuan[-_]?video|cogvideo|(?:^|[-_/])svd(?:[-_/]|$)|animatediff|(?:^|[-_/])mochi|(?:^|[-_/])veo\d?|(?:^|[-_/])sora|kling|runway|pika|seedance|hailuo/i],
  ["completion", /(?:^|[-_/])(?:davinci|babbage|curie|ada|codex[-_]?davinci)(?:[-_/]|$)/i],
  ["other", /(?:^|[-_/])(?:yolo|sam2|tokenizer|classifier|clip)(?:[-_/]|$)/i],
];

/**
 * What one entry is. Accepts the id alone or the row the menu returns.
 *
 * The menu's own word beats a name guess in both directions: an entry it marks
 * `chat: false` is out whatever it is called, and an entry it marks `chat: true` is a
 * chat model even when a rule would have called it something else.
 */
function classifyModel(row) {
  const entry = typeof row === "string" ? { id: row } : row ?? {};
  const id = String(entry.id ?? entry.name ?? "");
  const hint = String(entry.kind ?? "").trim().toLowerCase();
  if (entry.chat === false) {
    return { id, kind: hint && hint !== "chat" ? hint : "other", chat: false, why: "the menu marks it as not a chat model" };
  }
  if (hint && hint !== "chat") {
    return { id, kind: hint, chat: false, why: `the menu lists it as ${hint}, not chat` };
  }
  const name = `${id} ${String(entry.model ?? "")}`.trim();
  for (const [kind, re] of NON_CHAT_RULES) {
    const found = re.exec(name);
    if (found) return { id, kind, chat: false, why: `"${found[0]}" reads as a ${kind} model` };
  }
  if (entry.chat === true) return { id, kind: "chat", chat: true, why: "the menu marks it as a chat model" };
  return { id, kind: "chat", chat: true, why: "nothing in the name says otherwise" };
}

/** The one question the picker asks: can this entry answer a chat? */
function isChatModel(row) {
  return classifyModel(row).chat;
}

/** Every entry that can answer a chat, in the order the menu gave them. */
function chatModels(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => isChatModel(row));
}

/**
 * A cloud model is one served somewhere other than this machine's llama.cpp host.
 * The menu says so with provider/source; the id prefix is the fallback for a row that
 * carries neither.
 */
function isCloudModel(row) {
  const entry = typeof row === "string" ? { id: row } : row ?? {};
  const id = String(entry.id ?? "");
  const slash = id.indexOf("/");
  const provider = String(entry.provider ?? (slash > 0 ? id.slice(0, slash) : ""));
  return entry.source !== "local" && provider !== "local" && !id.startsWith("local/");
}

/**
 * Which model a picker should point at.
 *
 * Order, and the reason a person is told:
 *   1. the stored choice, when it still exists and can chat (never overridden silently);
 *   2. the first cloud chat model the menu offers and does not mark unavailable;
 *   3. a local chat model, preferring one that is already resident;
 *   4. nothing - with the reason, so the picker can say why it is empty.
 *
 * `errors` is the menu's own `errors` array; a string starting "router" means the
 * router did not answer, one starting "local" means the llama.cpp host did not.
 */
function resolveDefaultModel({ rows = [], stored = "", errors = [] } = {}) {
  const chat = chatModels(rows);
  const messages = (Array.isArray(errors) ? errors : []).map((value) => String(value ?? ""));
  const routerDown = messages.some((text) => /^router\b/i.test(text));
  const localDown = messages.some((text) => /^local\b/i.test(text));
  const want = String(stored ?? "").trim();
  const chosen = want ? chat.find((row) => String(row?.id ?? row) === want) ?? null : null;
  if (chosen) {
    return { id: want, tier: "stored", row: chosen, storedDropped: false, reason: "kept from your last choice" };
  }
  const cloud = routerDown ? [] : chat.filter((row) => isCloudModel(row) && row?.available !== false);
  if (cloud.length) {
    const first = cloud[0];
    return {
      id: String(first.id ?? first),
      tier: "cloud",
      row: first,
      storedDropped: Boolean(want),
      reason: "defaulted to a cloud model, so an answer never waits for a local load",
    };
  }
  if (!localDown) {
    const locals = chat.filter((row) => !isCloudModel(row) && row?.available !== false);
    const loaded = locals.find((row) => row?.loaded === true) ?? null;
    const first = loaded ?? locals[0] ?? null;
    if (first) {
      return {
        id: String(first.id ?? first),
        tier: "local",
        row: first,
        storedDropped: Boolean(want),
        reason: loaded ? "no cloud model is reachable, so the loaded local model is the default" : "no cloud model is reachable, so the default is a local model",
      };
    }
  }
  const why = routerDown && localDown
    ? "no model is selected: neither the router nor the local model server answered"
    : routerDown
      ? "no model is selected: the router did not answer and no local chat model is listed"
      : localDown
        ? "no model is selected: no cloud model is configured and the local model server did not answer"
        : "no model is selected: the menu listed no chat model";
  return { id: "", tier: "none", row: null, storedDropped: Boolean(want), reason: why };
}

/** The levels one model declares, in the vocabulary order. */
function modelEfforts(row) {
  const entry = typeof row === "string" ? { id: row } : row ?? {};
  const list = Array.isArray(entry.efforts) ? entry.efforts.map((value) => String(value)) : [];
  return EFFORT_LEVELS.filter((level) => list.includes(level));
}

/**
 * The levels the effort submenu may offer. A pinned model that declares its own levels
 * gets exactly those; anything else - no model pinned, a model the menu never described,
 * or a cloud row that declares nothing - gets everything the listed chat models declare
 * between them, because that model leaves the decision to the router, which drops the
 * field for a provider that cannot honour it.
 */
function availableEfforts(rows = [], selectedId = "") {
  const list = Array.isArray(rows) ? rows : [];
  const chosen = list.find((row) => String(row?.id ?? row) === String(selectedId ?? "")) ?? null;
  const own = chosen ? modelEfforts(chosen) : [];
  if (own.length) return own;
  const union = new Set();
  for (const row of chatModels(list)) for (const level of modelEfforts(row)) union.add(level);
  return EFFORT_LEVELS.filter((level) => union.has(level));
}

/** A stored level the selected model cannot honour is not sent: "" means "Default". */
function clampEffort(level, efforts) {
  const text = String(level ?? "");
  return (Array.isArray(efforts) ? efforts : []).includes(text) ? text : "";
}
// ==== model-catalog block: end ====

export {
  EFFORT_LEVELS,
  NON_CHAT_RULES,
  availableEfforts,
  chatModels,
  clampEffort,
  classifyModel,
  isChatModel,
  isCloudModel,
  modelEfforts,
  resolveDefaultModel,
};
