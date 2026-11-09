/**
 * Image reading: the read_image tool, attached pictures, the fallback for a model that
 * cannot see images, and the places that used to assume message content is a string.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runAgent } from "../src/agent.mjs";
import { estimateMessageTokens } from "../src/context.mjs";
import { contentText, imageDimensions, loadImage, stripImages } from "../src/images.mjs";
import { toAnthropicMessages } from "../../router/src/providers.mjs";

const WS = mkdtempSync(join(tmpdir(), "harness-images-"));
// A real 2x3 PNG header (the pixels do not matter to anything here).
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000020000000308060000009d74cbd50000001049444154789c63f8cfc0f01f0c0c0c0018f601fe8d2d5b4f0000000049454e44ae426082",
  "hex",
);
writeFileSync(join(WS, "shot.png"), PNG);
writeFileSync(join(WS, "notes.txt"), "not a picture");

const reply = (message) => new Response(JSON.stringify({ choices: [{ message }], usage: {} }), { status: 200, headers: { "content-type": "application/json" } });
const toolCall = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: `c${Math.random()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });

test("an image is read into a data-URL part, with its size; other files and huge ones are refused", () => {
  const image = loadImage(join(WS, "shot.png"));
  assert.equal(image.part.type, "image_url");
  assert.match(image.part.image_url.url, /^data:image\/png;base64,iVBOR/);
  assert.deepEqual(image.dims, { width: 2, height: 3 });
  assert.deepEqual(imageDimensions(PNG, "image/png"), { width: 2, height: 3 });
  assert.throws(() => loadImage(join(WS, "notes.txt")), /not an image/);
});

test("read_image shows the picture to the model right after that step", async () => {
  const bodies = [];
  const script = [toolCall("read_image", { path: "shot.png" }), { role: "assistant", content: "It is a tiny picture." }];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return reply(script[Math.min(bodies.length - 1, script.length - 1)]);
  };
  const result = await runAgent({ root: WS, task: "what is in shot.png?", fetchImpl, memory: false });
  assert.equal(result.answer, "It is a tiny picture.");
  const second = bodies[1].messages;
  const shown = second.at(-1);
  assert.equal(shown.role, "user", "the picture follows the tool result");
  assert.ok(shown.content.some((p) => p.type === "image_url"));
  assert.equal(second.at(-2).role, "tool", "every tool result comes first");
  assert.match(second.at(-2).content, /loaded shot\.png \(2x3/);
});

test("attached pictures are in the task message from the first step", async () => {
  let first = null;
  const fetchImpl = async (_url, init) => {
    first ??= JSON.parse(init.body).messages;
    return reply({ role: "assistant", content: "seen" });
  };
  await runAgent({ root: WS, task: "describe the attachment", images: [join(WS, "shot.png")], fetchImpl, memory: false });
  const task = first.at(-1);
  assert.equal(task.content[0].text, "describe the attachment");
  assert.equal(task.content[1].type, "image_url");
});

test("a model that refuses images gets them removed and the step retried, once", async () => {
  const bodies = [];
  const events = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const hasImage = body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
    if (hasImage) return new Response(JSON.stringify({ error: { message: "this model does not support image input" } }), { status: 400 });
    return reply({ role: "assistant", content: "answered without the picture" });
  };
  const result = await runAgent({ root: WS, task: "look", images: [join(WS, "shot.png")], fetchImpl, memory: false, onEvent: (e) => events.push(e) });
  assert.equal(result.answer, "answered without the picture");
  assert.ok(events.some((e) => e.type === "notice" && /cannot read images/.test(e.text)));
  const last = bodies.at(-1).messages.at(-1);
  assert.equal(typeof last.content, "string", "only text is left");
  assert.match(last.content, /cannot read images/);
});

test("content arrays: text for summaries, a fixed cost per image, stripping keeps the words", () => {
  const message = { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] };
  assert.equal(contentText(message.content), "look at this\n[image]");
  assert.ok(estimateMessageTokens(message) > 1000, "an image is not free");
  assert.ok(estimateMessageTokens({ role: "user", content: "look at this" }) < 20);
  const [plain] = stripImages([message]);
  assert.match(plain.content, /^look at this\n\[an image was here/);
});

test("the router hands Anthropic real image blocks", () => {
  const { messages } = toAnthropicMessages([
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
  ]);
  assert.deepEqual(messages[0].content, [
    { type: "text", text: "what is this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
  ]);
});
