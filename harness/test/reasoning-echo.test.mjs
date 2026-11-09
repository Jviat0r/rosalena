/**
 * Handing a thinking model its own reasoning back.
 *
 * DeepSeek's thinking mode (reached through `opencode-free` and through any OpenAI-
 * compatible DeepSeek endpoint) answers a second turn with HTTP 400 unless the assistant
 * message from the first turn still carries its `reasoning_content`:
 *
 *   "The `reasoning_content` in the thinking mode must be passed back to the API."
 *
 * Measured on this box 2026-10-20, on the second step of a two-step run - i.e. every
 * multi-step run on that route died, not just reasoning-heavy ones. The contract these
 * tests pin, in both directions:
 *
 *   - a provider that sends reasoning gets it back on the next request
 *   - a provider that sends none never sees the field appear
 *   - the answer itself never contains the reasoning
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readStreamedCompletion } from "../src/stream.mjs";

/** An SSE response body made of the given deltas, terminated the way providers do. */
function sse(deltas) {
  const frames = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
  frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

test("streamed reasoning rides on the message so it can be sent back", async () => {
  const out = await readStreamedCompletion(
    sse([{ role: "assistant", reasoning_content: "weighing " }, { reasoning_content: "options" }, { content: "42" }]),
  );
  assert.equal(out.message.content, "42");
  assert.equal(out.reasoning, "weighing options");
  assert.equal(out.message.reasoning_content, "weighing options");
});

test("a reply with no reasoning gains no reasoning field", async () => {
  const out = await readStreamedCompletion(sse([{ role: "assistant", content: "plain answer" }]));
  assert.equal(out.message.content, "plain answer");
  // Not `""` and not `null`: an absent field must stay absent, or a provider that rejects
  // the field would start rejecting every ordinary call.
  assert.equal("reasoning_content" in out.message, false);
});

test("a tool call step keeps both the call and the reasoning", async () => {
  const out = await readStreamedCompletion(
    sse([
      { reasoning_content: "need to read the file" },
      { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
    ]),
  );
  assert.equal(out.message.tool_calls[0].function.name, "read_file");
  assert.equal(out.message.reasoning_content, "need to read the file");
  assert.equal(out.message.content, "");
});
