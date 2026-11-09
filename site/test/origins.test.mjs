// The site moved to rosalena.dev (2026-11-09). The trial must answer the new address, its
// www, and the old rosalena.pages.dev (installed apps and old links), and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { allowedOrigins, checkOrigin } from "../functions/api/_lib/trial.mjs";

const fromToml = () => readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

test("the deployed setting allows rosalena.dev, its www and rosalena.pages.dev", () => {
  const value = fromToml().match(/^TRIAL_ORIGIN\s*=\s*"([^"]+)"/m)?.[1];
  assert.ok(value, "wrangler.toml sets TRIAL_ORIGIN");
  const env = { TRIAL_ORIGIN: value };
  assert.deepEqual(allowedOrigins(env), ["https://rosalena.dev", "https://www.rosalena.dev", "https://rosalena.pages.dev"]);
  for (const origin of ["https://rosalena.dev", "https://www.rosalena.dev", "https://rosalena.pages.dev", "https://Rosalena.dev/"]) {
    assert.doesNotThrow(() => checkOrigin(origin, env, "workers-ai"), origin);
  }
  for (const origin of ["https://evil.example", "https://rosalena.dev.evil.example", "http://rosalena.dev"]) {
    assert.throws(() => checkOrigin(origin, env, "workers-ai"), /not allowed/, origin);
  }
});

test("with no setting the same three are the default, and a single origin still works", () => {
  assert.deepEqual(allowedOrigins({}), ["https://rosalena.dev", "https://www.rosalena.dev", "https://rosalena.pages.dev"]);
  assert.deepEqual(allowedOrigins({ TRIAL_ORIGIN: "https://preview.rosalena.pages.dev/" }), ["https://preview.rosalena.pages.dev"]);
  assert.throws(() => checkOrigin(undefined, {}, "workers-ai"), /rosalena\.dev/, "the message names the main address");
});
