/**
 * `withNoTools` - the guard that stops a persona class answering with a tool call it cannot run.
 *
 * Why this exists at all: measured against the live free tier, a request carrying NO `tools`
 * array came back with a `read` tool call and empty content (finish_reason "tool_calls"). The
 * provider's own harness tools leak into the completion, so a caller that brought no
 * executable tool got a blank answer instead of a sentence. `tool_choice: "none"` turned the
 * same request into a full honest refusal with finish_reason "stop".
 *
 * The unit tests below lock the SHAPE of that rule in both directions: it must set the field
 * when nothing is callable, and it must stay out of the way when the caller really did bring
 * tools (a caller's own tool loop must keep working).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { withNoTools, withSystemPersona } from "../src/persona.mjs";

const PROMPT = "You are Rosalena.";

test("a persona request with no tools gets tool_choice none", () => {
  const body = withNoTools(withSystemPersona({ messages: [{ role: "user", content: "hi" }] }, PROMPT));
  assert.equal(body.tool_choice, "none");
  assert.equal(body.messages[0].content, PROMPT, "the persona is still messages[0]");
});

test("an empty tools array counts as no tools", () => {
  assert.equal(withNoTools({ messages: [], tools: [] }).tool_choice, "none");
  assert.equal(withNoTools({ messages: [] }).tool_choice, "none");
});

test("a caller that brought tools keeps them and keeps its own tool_choice", () => {
  const tools = [{ type: "function", function: { name: "read", parameters: {} } }];
  const body = withNoTools({ messages: [], tools });
  assert.equal(body.tool_choice, undefined, "tool_choice must not be forced when tools exist");
  assert.equal(body.tools, tools, "the tools array is passed through untouched");

  const explicit = withNoTools({ messages: [], tools: [{ type: "function" }], tool_choice: "auto" });
  assert.equal(explicit.tool_choice, "auto");
});

test("it is idempotent and never mutates the caller's body", () => {
  const original = { messages: [], temperature: 0.2 };
  const once = withNoTools(original);
  const twice = withNoTools(once);
  assert.equal(once.tool_choice, "none");
  assert.equal(twice, once, "an already-guarded body is returned as-is");
  assert.equal(original.tool_choice, undefined, "the caller's object is not changed");
  assert.equal(once.temperature, 0.2, "every other field survives");
});

test("withSystemPersona still never mutates and still orders the client's system message second", () => {
  const client = { messages: [{ role: "system", content: "Answer in French." }, { role: "user", content: "hi" }] };
  const body = withSystemPersona(client, PROMPT);
  assert.deepEqual(
    body.messages.map((m) => m.content),
    [PROMPT, "Answer in French.", "hi"],
  );
  assert.equal(client.messages.length, 2, "the caller's array is untouched");
});
