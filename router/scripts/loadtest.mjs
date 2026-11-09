#!/usr/bin/env node
/**
 * T0.1 acceptance test, as written in TASKS.md:
 *
 *   "A test goal that hammers the code class 500x in 1 min completes with zero
 *    user action despite one provider hitting a rate limit, and the logs show
 *    the fallback path."
 *
 * So this runs exactly that, against two local stub upstreams rather than real
 * providers: `local` is rate-limited on every single call, `cloud` is healthy.
 * No network, no keys, no spend - and deterministic, which matters because a
 * test that needs a real provider to misbehave is a test that never runs.
 *
 *   node scripts/loadtest.mjs
 *   TOTAL=500 CONCURRENCY=25 node scripts/loadtest.mjs
 */

import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeyPool, Ledger, ProviderBreaker } from "../src/limits.mjs";
import { createLogger } from "../src/log.mjs";
import { createRouterServer } from "../src/server.mjs";

const TOTAL = Number(process.env.TOTAL ?? 500);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 25);
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 60_000);
// The breaker is what stops the dead provider being called 500 times. The first
// BATCH is already in flight when the trip happens, hence the concurrency term.
const BREAKER = { enabled: true, threshold: 3, defaultCooldownMs: 30_000, maxCooldownMs: 900_000 };
const DEAD_PROVIDER_BUDGET = BREAKER.threshold + 2 * CONCURRENCY;

const tmp = mkdtempSync(join(tmpdir(), "router-accept-"));
const counters = { local: 0, local429: 0, cloud: 0 };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

/** The rate-limited provider: always 429, always with a Retry-After. */
const localStub = createServer((req, res) => {
  req.resume();
  counters.local += 1;
  counters.local429 += 1;
  res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
  res.end(JSON.stringify({ error: { message: "Rate limit exceeded, please retry later" } }));
});

/** The healthy provider. */
const cloudStub = createServer((req, res) => {
  req.resume();
  counters.cloud += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    }),
  );
});

const localPort = await listen(localStub);
const cloudPort = await listen(cloudStub);

process.env.ACCEPT_CLOUD_KEY = "accept-test-key";

const config = {
  host: "127.0.0.1",
  port: 0,
  logDir: join(tmp, "logs"),
  stateFile: join(tmp, "ledger.json"),
  requestTimeoutMs: 30_000,
  defaultClass: "code",
  budgets: { monthlyUsd: { local: 0, cloud: 0 } },
  breaker: BREAKER,
  providers: {
    local: { kind: "openai", baseUrl: `http://127.0.0.1:${localPort}/v1`, apiKeyEnv: null, prices: { in: 0, out: 0 } },
    cloud: {
      kind: "openai",
      baseUrl: `http://127.0.0.1:${cloudPort}/v1`,
      apiKeyEnv: "ACCEPT_CLOUD_KEY",
      prices: { in: 1, out: 2 },
    },
  },
  classes: { code: { chain: ["local/qwen3.8-27b", "cloud/big-model"] } },
};

const logger = createLogger({ logDir: config.logDir, echo: false });
const ledger = new Ledger(config.stateFile);
const keyPool = new KeyPool(process.env, config.providers);
const breaker = new ProviderBreaker(config.breaker);
const router = createRouterServer({ config, ledger, keyPool, breaker, logger });
const routerPort = await listen(router);

function fail(msg) {
  process.stdout.write(`\nFAIL: ${msg}\n`);
  process.exitCode = 1;
}

async function pool(size, total, fn) {
  let next = 0;
  const results = new Array(total);
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= total) return;
        results[i] = await fn(i);
      }
    }),
  );
  return results;
}

process.stdout.write(
  `T0.1 acceptance: ${TOTAL} requests to the "code" class, concurrency ${CONCURRENCY}\n` +
    `  chain: local (always 429) -> cloud (healthy)\n` +
    `  breaker: open after ${BREAKER.threshold} failures, so the dead provider gets at most ${DEAD_PROVIDER_BUDGET} calls\n` +
    `  router: http://127.0.0.1:${routerPort}\n\n`,
);

const started = Date.now();
const results = await pool(CONCURRENCY, TOTAL, async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "code", messages: [{ role: "user", content: "write a function" }] }),
    });
    return { status: res.status, target: res.headers.get("x-router-target") };
  } catch (err) {
    return { status: 0, error: String(err?.message ?? err) };
  }
});
const wallMs = Date.now() - started;

const ok = results.filter((r) => r.status === 200);
const failed = results.filter((r) => r.status !== 200);
const viaCloud = ok.filter((r) => r.target === "cloud/big-model").length;

// Read the real log file, not an in-memory shortcut: "the logs show the fallback
// path" is the criterion, so the logs are what gets asserted.
const logDir = config.logDir;
const logFile = readdirSync(logDir).find((f) => f.startsWith("router-") && f.endsWith(".jsonl"));
const events = readFileSync(join(logDir, logFile), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const attemptEvents = events.filter((e) => e.event === "attempt");
const fallbackEvents = events.filter((e) => e.event === "fallback");
const rateLimitedAttempts = attemptEvents.filter((e) => e.ok === false && e.reason === "rate_limit");
const circuitOpenSkips = attemptEvents.filter((e) => e.reason === "circuit_open");
const cloudSuccesses = attemptEvents.filter((e) => e.ok === true);
const spend = ledger.snapshot().providers.cloud ?? { usd: 0, calls: 0 };

process.stdout.write(
  [
    `  requests OK          ${ok.length}/${TOTAL}`,
    `  served by cloud      ${viaCloud}`,
    `  wall clock           ${(wallMs / 1000).toFixed(2)}s (budget ${(BUDGET_MS / 1000).toFixed(0)}s)`,
    "",
    `  local stub calls     ${counters.local}  (all 429)  <- the number the breaker exists to shrink`,
    `  cloud stub calls     ${counters.cloud}  (all 200)`,
    "",
    `  logged attempts      ${attemptEvents.length}`,
    `  logged rate_limits   ${rateLimitedAttempts.length}`,
    `  logged circuit_open  ${circuitOpenSkips.length}  (skipped without a round trip)`,
    `  logged fallbacks     ${fallbackEvents.length}`,
    `  logged successes     ${cloudSuccesses.length}`,
    `  ledger               cloud $${spend.usd} over ${spend.calls} calls`,
    `  log file             ${join(logDir, logFile)}`,
    "",
    "  sample fallback log lines:",
    ...fallbackEvents.slice(0, 2).map((e) => `    ${JSON.stringify(e)}`),
    ...circuitOpenSkips.slice(0, 1).map((e) => `    ${JSON.stringify(e)}`),
    "",
  ].join("\n"),
);

if (failed.length) fail(`${failed.length} request(s) did not return 200; first: ${JSON.stringify(failed[0])}`);
else if (ok.length !== TOTAL) fail(`expected ${TOTAL} successes, got ${ok.length}`);
else if (viaCloud !== TOTAL) fail(`expected all ${TOTAL} to be served by the fallback target, got ${viaCloud}`);
else if (fallbackEvents.length < TOTAL) fail(`expected at least ${TOTAL} fallback log lines, got ${fallbackEvents.length}`);
else if (circuitOpenSkips.length === 0)
  fail("the breaker never opened, so the dead provider was called on every request - the T0.1 gap is back");
else if (rateLimitedAttempts.length < BREAKER.threshold)
  fail(`expected at least ${BREAKER.threshold} rate limits logged before the trip, got ${rateLimitedAttempts.length}`);
else if (counters.local > DEAD_PROVIDER_BUDGET)
  fail(
    `the breaker did not stop the hammering: the dead provider took ${counters.local} calls, expected at most ${DEAD_PROVIDER_BUDGET} ` +
      `(${BREAKER.threshold} to trip + ${CONCURRENCY} already in flight, doubled for slack)`,
  );
else if (wallMs > BUDGET_MS) fail(`took ${wallMs}ms, over the ${BUDGET_MS}ms budget`);
else {
  process.stdout.write(
    `PASS: ${TOTAL}/${TOTAL} completed with no user action while one provider was rate-limited,\n` +
      `      ${fallbackEvents.length} fallback paths are recorded in the log, and the breaker cut the\n` +
      `      dead provider's calls from ${TOTAL} to ${counters.local} (${circuitOpenSkips.length} skips, no round trip).\n`,
  );
}

router.close();
localStub.close();
cloudStub.close();
