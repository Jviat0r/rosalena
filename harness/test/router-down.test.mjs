/**
 * A router that is not running is reported as the router (error-explain's ROUTER-DOWN),
 * not as "the local qwen server is down": fetch's own "fetch failed" names no address, so
 * agent.mjs adds the router URL before the error is explained. Found on 2026-11-03 when a
 * CLI run on a loaded local model blamed llama-server while only the router was down.
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runAgent } from "../src/agent.mjs";

test("a router that refuses the connection is named as the router, even on a local model", async () => {
  const events = [];
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  await runAgent({ root: process.cwd(), task: "hi", cls: "local/qwen3.8-27b", routerUrl: "http://127.0.0.1:8077/v1", fetchImpl, reconnectBudgetMs: 0, onEvent: (e) => events.push(e), extraHooks: [] });
  const error = events.find((e) => e.type === "error")?.message ?? "";
  assert.match(error, /router http:\/\/127\.0\.0\.1:8077/);
  assert.match(error, /Rosalena's model router/);
  assert.doesNotMatch(error, /local qwen server/);
});
