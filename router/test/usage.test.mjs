/**
 * Token usage: the store, the rollup the panel reads, and the recording path.
 *
 * Real temp directories and a real JSONL file throughout - no mocked fs - because
 * the things most likely to break here are the ones a mock would hide: a corrupt
 * line, a file that grows without bound, an append that throws on a read-only
 * directory, and a 30-day window that is actually fast enough to refresh a panel.
 *
 *   node --test test/usage.test.mjs
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { KeyPool, Ledger } from "../src/limits.mjs";
import { buildUpstreamRequest } from "../src/providers.mjs";
import { createRouterServer } from "../src/server.mjs";
import { route } from "../src/router.mjs";
import {
  USAGE_MAX_BYTES,
  USAGE_RETENTION_DAYS,
  UsageStore,
  parseUsageLine,
  providerLabels,
  rollupText,
  tokenFields,
  windowFor,
} from "../src/usage.mjs";

const TMP = mkdtempSync(join(tmpdir(), "router-usage-"));
const silence = { log() {}, recent: () => [], file: () => null };
const servers = [];
after(() => {
  for (const s of servers) s.close();
});

let seq = 0;
function tempFile(name) {
  seq += 1;
  return join(TMP, `${name}-${seq}.jsonl`);
}

/** The rollup time budget asserted below; the measured number is reported in README. */
const ROLLUP_BUDGET_MS = 2000;

const NOW = new Date("2026-10-20T04:45:32.000Z");

function line(fields = {}) {
  return `${JSON.stringify({
    at: "2026-10-20T04:00:00.000Z",
    provider: "local",
    model: "qwen3.8-27b",
    target: "local/qwen3.8-27b",
    tokensIn: 10,
    tokensOut: 5,
    cacheRead: null,
    cacheWrite: null,
    calls: 1,
    usd: 0,
    ok: true,
    ms: 12,
    ...fields,
  })}\n`;
}

function writeRaw(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// ------------------------------------------------------------------ wire mapping

test("tokenFields reads OpenAI's prompt_tokens_details and never invents a cache zero", () => {
  const cached = tokenFields({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 54 } }, "openai");
  assert.deepEqual(cached, { tokensIn: 100, tokensOut: 7, cacheRead: 54, cacheWrite: null });

  // No details at all: unknown, which is null - NOT 0. The panel is allowed to
  // print "0" only when a provider actually reported zero.
  const silent = tokenFields({ prompt_tokens: 100, completion_tokens: 7 }, "openai");
  assert.deepEqual(silent, { tokensIn: 100, tokensOut: 7, cacheRead: null, cacheWrite: null });

  // A measured zero is a number, and stays one.
  const measuredZero = tokenFields({ prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } }, "openai");
  assert.equal(measuredZero.cacheRead, 0);
  assert.notEqual(measuredZero.cacheRead, null);

  // Anthropic's cache_read_input_tokens is a dialect fallback on an OpenAI row.
  assert.equal(tokenFields({ prompt_tokens: 5, cache_read_input_tokens: 50 }, "openai").cacheRead, 50);
});

test("tokenFields maps Anthropic's separate cache counters into one honest prompt total", () => {
  const full = tokenFields(
    {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 50,
    },
    "anthropic",
  );
  // Anthropic's input_tokens EXCLUDES cache traffic, so the prompt the model
  // actually processed is 100 + 900 + 50. This is what makes "total = input +
  // output" true for both dialects in the panel.
  assert.deepEqual(full, { tokensIn: 1050, tokensOut: 20, cacheRead: 900, cacheWrite: 50 });

  // A first, uncached call reports no cache fields: null, null.
  const plain = tokenFields({ input_tokens: 10, output_tokens: 2 }, "anthropic");
  assert.deepEqual(plain, { tokensIn: 10, tokensOut: 2, cacheRead: null, cacheWrite: null });

  // A reported zero (a cache miss) is a measured zero, not unknown.
  assert.equal(tokenFields({ input_tokens: 1, cache_read_input_tokens: 0 }, "anthropic").cacheRead, 0);
});

test("route records the cache counters the provider actually reported", async () => {
  const file = tempFile("route-openai");
  const store = new UsageStore(file);
  const config = testConfig();
  const f = mockFetch([
    [
      "stub.local",
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 120, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 96 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
  ]);
  const out = await route({ ...ctxFor(config, f, store), cls: "fast", body: { messages: [] } });
  assert.equal(out.completion.choices[0].message.content, "hi");

  const rec = readLines(file).at(-1);
  assert.equal(rec.provider, "local");
  assert.equal(rec.model, "qwen3.8-27b");
  assert.equal(rec.target, "local/qwen3.8-27b");
  assert.equal(rec.tokensIn, 120);
  assert.equal(rec.tokensOut, 8);
  assert.equal(rec.cacheRead, 96);
  assert.equal(rec.cacheWrite, null, "OpenAI has no cache-write concept, so it stays unknown");
  assert.equal(rec.calls, 1);
  assert.equal(rec.ok, true);
});

test("route records an Anthropic call's cache reads and writes", async () => {
  const file = tempFile("route-anthropic");
  const store = new UsageStore(file);
  const config = testConfig();
  const f = mockFetch([
    [
      "stub.anthropic",
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: "verdict" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 50,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
  ]);
  await route({ ...ctxFor(config, f, store), cls: "judge", body: { messages: [{ role: "user", content: "judge" }] } });

  const rec = readLines(file).at(-1);
  assert.equal(rec.provider, "anthropic");
  assert.equal(rec.cacheRead, 900);
  assert.equal(rec.cacheWrite, 50);
  assert.equal(rec.tokensIn, 1050, "prompt total includes the cache halves");
  assert.equal(rec.tokensOut, 20);
});

// ------------------------------------------------------------------- the window

test("windowFor: days=1 is UTC-midnight today, days=30 is 30 calendar days", () => {
  const day = windowFor(1, NOW);
  assert.equal(day.days, 1);
  assert.equal(day.from.toISOString(), "2026-10-20T00:00:00.000Z");
  assert.equal(day.to.toISOString(), NOW.toISOString());

  const month = windowFor(30, NOW);
  assert.equal(month.from.toISOString(), "2026-09-21T00:00:00.000Z");
  assert.equal(month.days, 30);

  // Absurd input is clamped rather than thrown: the endpoint validates first.
  assert.equal(windowFor(0, NOW).days, 1);
  assert.equal(windowFor(10_000, NOW).days, 365);
});

test("a call inside the window counts and a call outside it does not", () => {
  const file = tempFile("window");
  const store = new UsageStore(file);
  store.record({ at: "2026-10-20T04:00:00.000Z", provider: "local", model: "m", tokensIn: 10, tokensOut: 5, cacheRead: 4 });
  store.record({ at: "2026-10-18T04:00:00.000Z", provider: "local", model: "m", tokensIn: 999, tokensOut: 999 });

  const today = store.rollup({ days: 1, now: NOW });
  assert.equal(today.totals.calls, 1);
  assert.equal(today.totals.input, 10);
  assert.equal(today.totals.output, 5);
  assert.equal(today.totals.tokens, 15);

  const month = store.rollup({ days: 30, now: NOW });
  assert.equal(month.totals.calls, 2);
  assert.equal(month.totals.tokens, 15 + 1998);
});

test("the day boundary is UTC midnight, to the millisecond", () => {
  const file = tempFile("boundary");
  const store = new UsageStore(file);
  store.record({ at: "2026-10-19T23:59:59.999Z", provider: "local", model: "m", tokensIn: 500, tokensOut: 500 });
  store.record({ at: "2026-10-20T00:00:00.000Z", provider: "local", model: "m", tokensIn: 2, tokensOut: 3 });

  const today = store.rollup({ days: 1, now: NOW });
  assert.equal(today.totals.calls, 1, "the last millisecond of yesterday is yesterday");
  assert.equal(today.totals.tokens, 5);
  assert.equal(today.window.from, "2026-10-20T00:00:00.000Z");
});

// ------------------------------------------------------------------ the rollup

test("totals equal the sum of the providers, and each provider equals the sum of its models", () => {
  const file = tempFile("sums");
  const store = new UsageStore(file);
  const rows = [
    { at: "2026-10-20T01:00:00.000Z", provider: "local", model: "a", tokensIn: 100, tokensOut: 10, cacheRead: 40, calls: 1 },
    { at: "2026-10-20T02:00:00.000Z", provider: "local", model: "b", tokensIn: 200, tokensOut: 20, cacheRead: 60, calls: 1 },
    { at: "2026-10-20T03:00:00.000Z", provider: "cloudish", model: "c", tokensIn: 300, tokensOut: 30, calls: 1 },
    { at: "2026-10-20T04:00:00.000Z", provider: "cloudish", model: "c", tokensIn: 400, tokensOut: 40, calls: 1 },
  ];
  for (const row of rows) store.record(row);

  const report = store.rollup({ days: 1, now: NOW });
  const sum = (key) => report.providers.reduce((acc, p) => acc + p[key], 0);
  for (const key of ["tokens", "input", "output", "calls"]) {
    assert.equal(report.totals[key], sum(key), `totals.${key} is the sum over providers`);
  }
  assert.equal(report.totals.tokens, 100 + 10 + 200 + 20 + 300 + 30 + 400 + 40);
  assert.equal(report.totals.calls, 4);
  assert.equal(report.totals.cacheRead, 100);

  for (const p of report.providers) {
    assert.equal(p.tokens, p.models.reduce((acc, m) => acc + m.tokens, 0), `${p.provider} totals its models`);
    assert.equal(p.calls, p.models.reduce((acc, m) => acc + m.calls, 0));
    assert.equal(p.input, p.models.reduce((acc, m) => acc + m.input, 0));
  }
  // local 330 tokens, cloudish 770: sorted by tokens descending.
  assert.deepEqual(report.providers.map((p) => p.provider), ["cloudish", "local"]);
  assert.deepEqual(report.providers[0].models.map((m) => m.model), ["c"]);
  assert.equal(report.providers[1].models[0].model, "b", "models are sorted by tokens descending too");
});

test("a provider with no cache fields reports null, and a measured zero stays zero", () => {
  const file = tempFile("cache-null");
  const store = new UsageStore(file);
  store.record({ at: "2026-10-20T01:00:00.000Z", provider: "nofields", model: "m", tokensIn: 5, tokensOut: 5 });
  store.record({ at: "2026-10-20T02:00:00.000Z", provider: "zeroes", model: "m", tokensIn: 5, tokensOut: 5, cacheRead: 0, cacheWrite: 0 });

  const report = store.rollup({ days: 1, now: NOW });
  const nofields = report.providers.find((p) => p.provider === "nofields");
  const zeroes = report.providers.find((p) => p.provider === "zeroes");
  assert.equal(nofields.cacheRead, null);
  assert.equal(nofields.cacheWrite, null);
  assert.equal(nofields.models[0].cacheRead, null);
  assert.equal(zeroes.cacheRead, 0, "a provider that reported zero is not null");
  assert.equal(zeroes.cacheWrite, 0);
  // One provider reported numbers, so the window total is a number, not null.
  assert.equal(report.totals.cacheRead, 0);
  assert.equal(report.totals.cacheWrite, 0);

  const onlySilent = new UsageStore(tempFile("cache-null-2"));
  onlySilent.record({ at: "2026-10-20T01:00:00.000Z", provider: "nofields", model: "m", tokensIn: 5 });
  assert.equal(onlySilent.rollup({ days: 1, now: NOW }).totals.cacheRead, null, "nothing reported = unknown, not zero");
});

test("a corrupt line is skipped and every other line still parses", () => {
  const file = tempFile("corrupt");
  writeRaw(
    file,
    [
      line({ tokensIn: 100, tokensOut: 10 }).trimEnd(),
      "{ this is not json",
      "",
      '{"at":"2026-10-20T02:00:00.000Z","provider":"local","model":"m"', // half a line, as a crash would leave it
      line({ at: "2026-10-20T03:00:00.000Z", provider: "other", model: "x", tokensIn: 7, tokensOut: 3 }).trimEnd(),
      "null",
      "[1,2,3]",
      line({ at: "not-a-date", tokensIn: 999 }).trimEnd(),
    ].join("\n"),
  );
  const store = new UsageStore(file);
  const report = store.rollup({ days: 1, now: NOW });
  assert.equal(report.totals.calls, 2, "two good lines survive seven bad ones");
  assert.equal(report.totals.tokens, 110 + 10);
  assert.equal(parseUsageLine("{oops"), null);
  assert.equal(parseUsageLine('{"at":"x","provider":"p","model":"m"}'), null, "an unparseable timestamp is corrupt");
});

test("the most recent call in the window is the current model - and null when nothing ran", () => {
  const file = tempFile("current");
  const store = new UsageStore(file);
  store.record({ at: "2026-10-20T01:00:00.000Z", provider: "opencode-free", model: "glm-5.3-flash-free", tokensIn: 900 });
  store.record({ at: "2026-10-20T03:30:00.000Z", provider: "opencode-free", model: "deepseek-v4.1-flash-free", tokensIn: 5 });

  assert.deepEqual(store.rollup({ days: 1, now: NOW }).current, {
    provider: "opencode-free",
    model: "deepseek-v4.1-flash-free",
  });
  assert.equal(new UsageStore(tempFile("current-empty")).rollup({ days: 1, now: NOW }).current, null);
});

test("provider labels come from the config, then the model menu, then the id", () => {
  const labels = providerLabels({
    providers: {
      local: { label: "Local (this PC)" },
      "opencode-free": {},
      lonely: {},
    },
    models: [
      { target: "opencode-free/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free" },
      { target: "lonely/x", label: "Lonely Cloud" },
    ],
  });
  assert.equal(labels.local, "Local (this PC)");
  assert.equal(labels["opencode-free"], "DeepSeek V4.1 Flash Free");
  assert.equal(labels.lonely, "Lonely Cloud");

  const file = tempFile("labels");
  const store = new UsageStore(file);
  store.record({ at: "2026-10-20T01:00:00.000Z", provider: "local", model: "qwen3.8-27b", tokensIn: 4 });
  store.record({ at: "2026-10-20T02:00:00.000Z", provider: "unmapped", model: "m", tokensIn: 2 });
  const report = store.rollup({ days: 1, now: NOW, labels });
  assert.equal(report.providers.find((p) => p.provider === "local").label, "Local (this PC)");
  assert.equal(report.providers.find((p) => p.provider === "unmapped").label, "unmapped", "the id is the honest fallback");
});

test("the rollup JSON carries exactly the contract's keys", () => {
  const file = tempFile("shape");
  const store = new UsageStore(file);
  store.record({ at: "2026-10-20T01:00:00.000Z", provider: "local", model: "m", tokensIn: 4, tokensOut: 2, cacheRead: 3 });
  const report = store.rollup({ days: 1, now: NOW });
  assert.deepEqual(Object.keys(report).sort(), ["current", "providers", "totals", "updatedAt", "window"]);
  assert.deepEqual(Object.keys(report.window).sort(), ["days", "from", "to"]);
  assert.deepEqual(Object.keys(report.totals).sort(), ["cacheRead", "cacheWrite", "calls", "input", "output", "tokens"]);
  assert.deepEqual(Object.keys(report.providers[0]).sort(), [
    "cacheRead",
    "cacheWrite",
    "calls",
    "input",
    "label",
    "models",
    "output",
    "provider",
    "tokens",
  ]);
  assert.deepEqual(Object.keys(report.providers[0].models[0]).sort(), [
    "cacheRead",
    "cacheWrite",
    "calls",
    "input",
    "model",
    "output",
    "tokens",
  ]);
  assert.deepEqual(Object.keys(report.current).sort(), ["model", "provider"]);
  assert.equal(report.updatedAt, NOW.toISOString());
});

// ------------------------------------------------------------- failures & bounds

test("a failed route records nothing", async () => {
  const file = tempFile("failed");
  const store = new UsageStore(file);
  const config = testConfig();
  const f = mockFetch([["stub.local", () => status(500, "boom")]]);
  await assert.rejects(() => route({ ...ctxFor(config, f, store), cls: "fast", body: { messages: [] } }));
  assert.equal(store.rollup({ days: 1, now: NOW }).totals.calls, 0);
  assert.deepEqual(readLines(file), [], "a failed call writes no usage line");
});

test("a usage write that throws does not break the response", async () => {
  const config = testConfig();
  const f = mockFetch([["stub.local", () => ok("still answered")]]);

  // (a) the store's file cannot be written: the path is a directory.
  const dir = join(TMP, "usage-as-a-directory");
  mkdirSync(dir, { recursive: true });
  const broken = new UsageStore(dir);
  assert.equal(broken.record({ provider: "local", model: "m", tokensIn: 1 }), null, "record() reports the failure instead of throwing");

  const first = await route({ ...ctxFor(config, f, broken), cls: "fast", body: { messages: [] } });
  assert.equal(first.completion.choices[0].message.content, "still answered");

  // (b) even a store whose record() throws outright cannot fail the request.
  const hostile = {
    record() {
      throw new Error("disk on fire");
    },
  };
  const second = await route({ ...ctxFor(config, f, hostile), cls: "fast", body: { messages: [] } });
  assert.equal(second.completion.choices[0].message.content, "still answered");
});

test("the JSONL file stays bounded under heavy load and keeps the newest calls", () => {
  const file = tempFile("bounded");
  const maxBytes = 256 * 1024;
  const store = new UsageStore(file, { maxBytes });
  const started = Date.now();

  // 5,000 calls as fast as they can be written - the shape of a 500-request/minute
  // burst. Retention alone would keep every one of them for 30 days.
  for (let i = 0; i < 5000; i += 1) {
    store.record({
      at: new Date(Date.parse("2026-10-20T00:00:00.000Z") + i * 1000).toISOString(),
      provider: i % 2 ? "local" : "opencode-free",
      model: i % 3 ? "qwen3.8-27b" : "deepseek-v4.1-flash-free",
      tokensIn: 100,
      tokensOut: 20,
      cacheRead: 30,
    });
  }

  const bytes = statSync(file).size;
  assert.ok(bytes <= maxBytes, `file is ${bytes} bytes, cap is ${maxBytes}`);
  assert.ok(bytes > 0, "the newest calls are still there");
  assert.ok(store.info().compactions > 0, "compaction actually ran");
  const report = store.rollup({ days: 1, now: NOW });
  assert.ok(report.totals.calls > 0);
  // The newest record is the last one written, so it must have survived the trim.
  const newest = readLines(file).at(-1);
  assert.equal(newest.tokensIn, 100);
  assert.ok(Date.parse(newest.at) >= Date.parse("2026-10-20T00:00:00.000Z") + 4000 * 1000);
  assert.ok(Date.now() - started < 30_000, "bounding must not turn 5,000 writes into a crawl");
});

test("compaction drops calls older than the retention window and keeps the rest", () => {
  const file = tempFile("retention");
  const store = new UsageStore(file, { retentionDays: 2, now: () => NOW });
  store.record({ at: "2026-09-01T00:00:00.000Z", provider: "local", model: "ancient", tokensIn: 1 }); // 49 days old
  store.record({ at: "2026-10-19T12:00:00.000Z", provider: "local", model: "yesterday", tokensIn: 2 });
  store.record({ at: "2026-10-20T04:00:00.000Z", provider: "local", model: "now", tokensIn: 3 });

  const result = store.compact();
  assert.equal(result.failed, false);
  assert.equal(result.dropped, 1);
  const models = readLines(file).map((r) => r.model);
  assert.deepEqual(models, ["yesterday", "now"]);
  assert.ok(statSync(file).size < 1024);
});

// ---------------------------------------------------------------- the 100k lines

test(`30 days of 100k lines rolls up in under ${ROLLUP_BUDGET_MS}ms`, () => {
  const file = tempFile("perf");
  const lines = [];
  const base = NOW.getTime();
  const DAY = 86_400_000;
  for (let i = 0; i < 100_000; i += 1) {
    const at = new Date(base - (i % 30) * DAY - (i % 1000) * 1000).toISOString();
    lines.push(
      JSON.stringify({
        at,
        provider: i % 2 ? "local" : "opencode-free",
        model: i % 3 ? "qwen3.8-27b" : "deepseek-v4.1-flash-free",
        target: i % 2 ? "local/qwen3.8-27b" : "opencode-free/deepseek-v4.1-flash-free",
        tokensIn: 1000,
        tokensOut: 100,
        cacheRead: i % 2 ? 800 : null,
        cacheWrite: null,
        calls: 1,
        usd: 0,
        ok: true,
        ms: 20,
      }),
    );
  }
  // Lines far outside the window prove the filter runs in the same pass.
  for (let i = 0; i < 1000; i += 1) {
    lines.push(
      JSON.stringify({
        at: new Date(base - 400 * DAY).toISOString(),
        provider: "local",
        model: "ancient",
        tokensIn: 999_999,
        tokensOut: 999_999,
        calls: 1,
        usd: 0,
        ok: true,
        ms: 1,
      }),
    );
  }
  writeRaw(file, `${lines.join("\n")}\n`);
  assert.equal(readFileSync(file, "utf8").split("\n").length, 101_001);

  const store = new UsageStore(file);
  const started = process.hrtime.bigint();
  const report = store.rollup({ days: 30, now: NOW });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(report.totals.calls, 100_000, "the 1,000 ancient lines are outside the window");
  assert.equal(report.totals.input, 100_000 * 1000);
  assert.equal(report.totals.output, 100_000 * 100);
  assert.equal(report.totals.tokens, 100_000 * 1100);
  // opencode-free never reported a cache, so its window share is counted only for
  // the provider that did: 50,000 local calls x 800.
  assert.equal(report.totals.cacheRead, 50_000 * 800);
  assert.ok(ms < ROLLUP_BUDGET_MS, `rollup took ${ms.toFixed(1)}ms, budget is ${ROLLUP_BUDGET_MS}ms`);
  process.stdout.write(`\n    [measured] 100k-line / 30-day rollup: ${ms.toFixed(1)}ms\n`);
});

// --------------------------------------------------------------------- the API

function testConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    logDir: TMP,
    stateFile: join(TMP, `ledger-${Math.random().toString(36).slice(2)}.json`),
    requestTimeoutMs: 5_000,
    defaultClass: "fast",
    budgets: { monthlyUsd: {} },
    providers: {
      local: {
        kind: "openai",
        label: "Local (this PC)",
        baseUrl: "http://stub.local/v1",
        apiKeyEnv: null,
        prices: { in: 0, out: 0 },
        streamUsage: true,
      },
      "opencode-free": {
        kind: "openai",
        label: "OpenCode Zen Free",
        baseUrl: "http://stub.free/v1",
        apiKeyEnv: "FREE_KEY",
        prices: { in: 0, out: 0 },
      },
      anthropic: { kind: "anthropic", label: "Anthropic", baseUrl: "http://stub.anthropic/v1", apiKeyEnv: "ANTHROPIC_KEY", prices: { in: 3, out: 15 } },
    },
    classes: {
      fast: { chain: ["local/qwen3.8-27b"] },
      judge: { chain: ["anthropic/claude-sonnet-4-5"] },
    },
    models: [{ target: "local/qwen3.8-27b", label: "Qwen3.8 27B (this PC)" }],
    ...overrides,
  };
}

function ok(text = "hello", usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function status(code, body = "nope") {
  return new Response(JSON.stringify({ error: body }), { status: code, headers: { "content-type": "application/json" } });
}

/** Records every upstream call and answers by URL match. */
function mockFetch(table) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [needle, respond] of table) {
      if (String(url).includes(needle)) return respond(String(url), init, calls.length);
    }
    return status(500, "no stub matched");
  };
  fn.calls = calls;
  return fn;
}

function ctxFor(config, fetchImpl, usage) {
  return {
    config,
    ledger: new Ledger(config.stateFile),
    keyPool: new KeyPool({ FREE_KEY: "k", ANTHROPIC_KEY: "sk-ant" }, config.providers),
    logger: silence,
    fetchImpl,
    usage,
  };
}

function readLines(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function startServer(ctx) {
  const server = createRouterServer(ctx);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("GET /admin/usage answers the panel's contract, behind the token", async () => {
  const file = tempFile("api");
  const store = new UsageStore(file);
  // The server rolls up against the real clock, so the records sit at the start of today
  // (UTC): fixed dates passed the days=1 window only on the day they were written.
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const todayAt = (ms) => new Date(midnight.getTime() + ms).toISOString();
  store.record({ at: todayAt(0), provider: "opencode-free", model: "deepseek-v4.1-flash-free", tokensIn: 1000, tokensOut: 100, cacheRead: 800 });
  store.record({ at: todayAt(500), provider: "local", model: "qwen3.8-27b", tokensIn: 2000, tokensOut: 200, cacheRead: 1500 });

  const config = testConfig({ auth: { tokenEnv: "ROUTER_TOKEN" } });
  const base = await startServer({ ...ctxFor(config, mockFetch([]), store), env: { ROUTER_TOKEN: "correct-horse-battery" } });

  // Behind the same gate as /admin/status.
  assert.equal((await fetch(`${base}/admin/usage?days=1`)).status, 401);
  const wrong = await fetch(`${base}/admin/usage?days=1`, { headers: { authorization: "Bearer nope-correct-horse-battery" } });
  assert.equal(wrong.status, 401);

  for (const headers of [
    { authorization: "Bearer correct-horse-battery" },
    { "x-router-token": "correct-horse-battery" },
    { "x-rosalena-token": "correct-horse-battery" },
  ]) {
    const res = await fetch(`${base}/admin/usage?days=1`, { headers });
    assert.equal(res.status, 200, `accepted with ${Object.keys(headers)[0]}`);
    const report = await res.json();
    assert.equal(report.window.days, 1);
    assert.equal(report.totals.tokens, 1100 + 2200);
    assert.equal(report.totals.input, 3000);
    assert.equal(report.totals.output, 300);
    assert.equal(report.totals.cacheRead, 2300);
    assert.equal(report.totals.cacheWrite, null);
    assert.equal(report.totals.calls, 2);
    assert.deepEqual(report.providers.map((p) => p.provider), ["local", "opencode-free"], "sorted by tokens, descending");
    assert.equal(report.providers[0].label, "Local (this PC)");
    assert.equal(report.providers[1].label, "OpenCode Zen Free");
    assert.deepEqual(report.providers[1].models, [
      { model: "deepseek-v4.1-flash-free", tokens: 1100, calls: 1, input: 1000, output: 100, cacheRead: 800, cacheWrite: null },
    ]);
    assert.deepEqual(report.current, { provider: "local", model: "qwen3.8-27b" });
  }

  const bad = await fetch(`${base}/admin/usage?days=0`, { headers: { authorization: "Bearer correct-horse-battery" } });
  assert.equal(bad.status, 400);
  const nan = await fetch(`${base}/admin/usage?days=lots`, { headers: { authorization: "Bearer correct-horse-battery" } });
  assert.equal(nan.status, 400);

  // No store in the context is an empty window, not a 500.
  const bare = await startServer({ ...ctxFor(config, mockFetch([])), env: { ROUTER_TOKEN: "correct-horse-battery" } });
  const empty = await (await fetch(`${bare}/admin/usage?days=30`, { headers: { authorization: "Bearer correct-horse-battery" } })).json();
  assert.deepEqual(empty.providers, []);
  assert.equal(empty.totals.tokens, 0);
  assert.equal(empty.totals.cacheRead, null);
  assert.equal(empty.current, null);
});

test("a real request through the server lands in /admin/usage", async () => {
  const file = tempFile("api-live");
  const store = new UsageStore(file);
  const config = testConfig();
  const f = mockFetch([
    [
      "stub.local",
      () => ok("served", { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 1000 } }),
    ],
  ]);
  const base = await startServer(ctxFor(config, f, store));

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);

  const report = await (await fetch(`${base}/admin/usage?days=1`)).json();
  assert.equal(report.totals.tokens, 1500);
  assert.equal(report.totals.cacheRead, 1000);
  assert.equal(report.totals.calls, 1);
  assert.equal(report.providers[0].models[0].model, "qwen3.8-27b");
  assert.deepEqual(report.current, { provider: "local", model: "qwen3.8-27b" });
});

// -------------------------------------------------------- streamed calls & usage

test("a streamed call records the usage chunk the provider sends", async () => {
  const file = tempFile("stream");
  const store = new UsageStore(file);
  const enc = new TextEncoder();
  const config = testConfig({ classes: { fast: { chain: ["local/qwen3.8-27b"] } } });
  const f = mockFetch([
    [
      "stub.local",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n\n'));
              c.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":58,"completion_tokens":32,"prompt_tokens_details":{"cached_tokens":54}}}\n\n'));
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ],
  ]);
  const base = await startServer(ctxFor(config, f, store));
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fast", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text(); // consume it, so the server reaches res.end()
  assert.match(text, /data: \[DONE\]/);

  const rec = readLines(file).at(-1);
  assert.equal(rec.tokensIn, 58);
  assert.equal(rec.tokensOut, 32);
  assert.equal(rec.cacheRead, 54);
  assert.equal(rec.stream, true);
  assert.equal(rec.measured, undefined, "the provider measured this call");

  const report = await (await fetch(`${base}/admin/usage?days=1`)).json();
  assert.equal(report.totals.cacheRead, 54, "cache numbers survive the streamed path");

  // The router asked for the usage chunk, because this provider opts in.
  const sent = JSON.parse(f.calls[0].init.body);
  assert.deepEqual(sent.stream_options, { include_usage: true });
});

test("a stream with no usage chunk still counts the call, without inventing tokens", async () => {
  const file = tempFile("stream-unmeasured");
  const store = new UsageStore(file);
  const enc = new TextEncoder();
  const config = testConfig({ classes: { fast: { chain: ["local/qwen3.8-27b"] } } });
  const f = mockFetch([
    [
      "stub.local",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
              c.enqueue(enc.encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ],
  ]);
  const base = await startServer(ctxFor(config, f, store));
  await (await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "fast", stream: true, messages: [] }),
  })).text();

  const rec = readLines(file).at(-1);
  assert.equal(rec.calls, 1, "the call happened and is counted");
  assert.equal(rec.tokensIn, 0);
  assert.equal(rec.tokensOut, 0);
  assert.equal(rec.cacheRead, null);
  assert.equal(rec.measured, false, "and it is marked as unmeasured rather than pretending to be zero");
});

test("stream_options.include_usage is opt-in per provider, never sent on a buffered call", () => {
  const spec = { kind: "openai", baseUrl: "http://stub.local/v1", prices: { in: 0, out: 0 }, streamUsage: true };
  const streamed = JSON.parse(buildUpstreamRequest({ spec, model: "m", stream: true, body: {} }).init.body);
  assert.deepEqual(streamed.stream_options, { include_usage: true }, "a streamed call asks for the usage chunk");

  const buffered = JSON.parse(buildUpstreamRequest({ spec, model: "m", stream: false, body: {} }).init.body);
  assert.equal(buffered.stream_options, undefined, "a buffered reply already reports usage");

  const plain = { kind: "openai", baseUrl: "http://stub.free/v1", prices: { in: 0, out: 0 } };
  const other = JSON.parse(buildUpstreamRequest({ spec: plain, model: "m", stream: true, body: {} }).init.body);
  assert.equal(other.stream_options, undefined, "a provider that did not opt in is never sent it");

  // A caller that asked for its own stream_options keeps them.
  const caller = JSON.parse(
    buildUpstreamRequest({ spec, model: "m", stream: true, body: { stream_options: { include_usage: false } } }).init.body,
  );
  assert.deepEqual(caller.stream_options, { include_usage: false });
});

