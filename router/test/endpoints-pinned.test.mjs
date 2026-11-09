/**
 * The endpoints are PINNED. This test is the guard.
 *
 * On 2026-10-21 an agent moved the free tier from `https://opencode.ai/zen/v1`
 * to `https://opencode.ai/inference/openai/v1` because the documentation listed
 * it there and the newer CLI binary no longer contains the `zen/v1` string. A
 * single probe passed on both URLs, so the change looked safe; sustained use
 * then produced two days of 429 FreeUsageLimitError, 500/503 upstream failures
 * and 400 reasoning errors on a route that had been working. It was reverted on
 * 2026-10-22.
 *
 * The point of this test is that the next agent to read the docs cannot make
 * that change quietly: it fails, and the failure names the file to read.
 *
 * See docs/ENDPOINTS-PINNED.md.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL("../", import.meta.url));
const PINNED_BASE = "https://opencode.ai/zen/v1";
const PINNED_UA = "opencode/latest/2.0.29/cli";

const config = JSON.parse(readFileSync(join(HERE, "router.config.json"), "utf8"));

test("the free route still points at the measured gateway", () => {
  assert.equal(
    config.providers["opencode-free"].baseUrl,
    PINNED_BASE,
    "opencode-free.baseUrl is pinned to the measured gateway — see docs/ENDPOINTS-PINNED.md before changing it",
  );
});

test("the fingerprint User-Agent is the measured one", () => {
  assert.equal(
    config.providers["opencode-free"].userAgent,
    PINNED_UA,
    "the free-tier fingerprint is pinned; the router and dsh-opencode-freeaccess must agree",
  );
});

test("the newer gateway is not referenced anywhere in the router config", () => {
  const raw = JSON.stringify(config);
  assert.equal(
    raw.includes("/inference/openai"),
    false,
    "the free tier must not be routed through /inference/openai — that path was tried on 2026-10-21 and reverted (docs/ENDPOINTS-PINNED.md)",
  );
});

test("the free route keeps the three measured gates", () => {
  const free = config.providers["opencode-free"];
  assert.equal(free.requiresStream, true, "gate 1: stream:true");
  assert.equal(free.clientHeaders, "opencode", "gate 2: client fingerprint + ses_ headers");
  assert.deepEqual(free.ensureTools, ["read"], "gate 3: a tool named exactly `read`");
});

test("every class that names the free route resolves to a declared provider", () => {
  for (const [cls, spec] of Object.entries(config.classes ?? {})) {
    for (const target of spec.chain ?? []) {
      const [provider] = target.split("/");
      assert.ok(config.providers[provider], `class "${cls}" names ${target}, whose provider "${provider}" is not declared`);
    }
  }
});

// Rosalena checks only its own router here. DeepSeek Harness and its plugins are a separate
// project (D:\AppDev\dsh-plugins since 2026-11-08) and carry their own checks.
