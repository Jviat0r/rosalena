/**
 * The router's 503 when the free window is spent must read as that, not as a server error:
 * "retry later" is the one thing that never helps with a spent daily quota.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { explain } from "../src/error-explain.mjs";

const HINT =
  "The free tier's daily limit is used up. It is shared by everything on your internet connection and comes back about a day after it started refusing. OmniRoute, the free fallback, is not running on this PC: open the OmniRoute tab in Rosalena to install or start it. A local model or your own API key works meanwhile.";

test("a spent free tier with OmniRoute off points at the OmniRoute tab, not at retrying", () => {
  const e = explain({ message: `router returned 503 for class "rosalena": ${HINT} {"error":{"message":"every target in the chain failed"}}` }, "rosalena");
  assert.equal(e.key, "FREE-LIMIT");
  assert.equal(e.retryHelps, false);
  assert.match(e.action, /OmniRoute tab/);
});

test("a spent free tier with OmniRoute also failing says when it comes back", () => {
  const hint = HINT.replace(/OmniRoute, the free fallback, is not running.*?start it\./, "OmniRoute, the free fallback, could not answer either (upstream_502).");
  const e = explain({ message: `router returned 503 for class "rosalena": ${hint}` }, "rosalena");
  assert.equal(e.key, "FREE-LIMIT");
  assert.match(e.action, /about a day/);
});
