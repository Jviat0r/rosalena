import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin, {
  DEFAULT_PATTERNS,
  activeLimits,
  classifyFailure,
  emptyRecord,
  formatLeft,
  formatStatus,
  readState,
  recordHit,
  routeOf,
  statePathOf,
  targetFromText,
  writeState,
} from "../plugins/rosa-rate-limit-failover/plugin.mjs";

const AT = Date.UTC(2026, 9, 20, 15, 49, 0);
const HOUR = 3_600_000;

/** A workspace to write the record into, and a context shaped like the host's. */
function bench(config = {}) {
  const root = mkdtempSync(join(tmpdir(), "rlf-"));
  const ctx = { root, config: { resetHours: 24, cooldownMinutes: 10, ...config }, log: () => {}, harness: {}, builtinTools: [], createTools: () => ({}) };
  return { ctx, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A run's per-plugin state window, the shape createHookRunner hands a hook. */
function runState(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    has: (k) => map.has(k),
    delete: (k) => map.delete(k),
  };
}

test("a usage-limit failure is recognised by its wording, whatever its case", () => {
  for (const text of [
    "FreeUsageLimitError: Rate limit exceeded. Please try again later.",
    "GoUsageLimitError",
    "429 rate limit exceeded",
    "you hit the USAGE LIMIT for today",
    "Insufficient account funds",
    "insufficient_quota: check your plan",
    "quota exceeded",
    "out of budget",
  ]) {
    const result = classifyFailure(text);
    assert.equal(result?.kind, "usage", text);
  }
  assert.equal(classifyFailure("FreeUsageLimitError").matched, "FreeUsageLimitError");
  assert.equal(classifyFailure("RATE LIMIT EXCEEDED").kind, "usage");
});

test("a quota word inside a 500 body still counts as a quota, not as an outage", () => {
  // The order in classifyFailure is the behaviour: a budget does not clear in ten
  // minutes, so it must never be filed under the short cooldown.
  const both = classifyFailure("429: 500 status code (no body) - FreeUsageLimitError");
  assert.equal(both.kind, "usage");
  assert.equal(classifyFailure("429: 500 status code (no body)").kind, "server");
});

test("server-class failures get their own kind, and numbers are matched with boundaries", () => {
  for (const text of ["500 status code (no body)", "502 Bad Gateway", "upstream 503", "TIMEOUT after 30000ms", "TRANSPORT error", "server_error"]) {
    assert.equal(classifyFailure(text)?.kind, "server", text);
  }
  // A duration is not an HTTP status: without the boundary this would be a "500".
  assert.equal(classifyFailure("step took 1500ms and returned 2500 tokens"), null);
  assert.equal(classifyFailure("Context size has been exceeded."), null);
  assert.equal(classifyFailure(""), null);
  assert.equal(classifyFailure(undefined), null);
});

test("custom patterns replace the default list rather than adding to it", () => {
  assert.equal(classifyFailure("FreeUsageLimitError", ["quota gone"]), null);
  assert.equal(classifyFailure("Quota Gone", ["quota gone"])?.kind, "usage");
  assert.deepEqual(DEFAULT_PATTERNS.slice(0, 2), ["FreeUsageLimitError", "GoUsageLimitError"]);
});

test("a route is the provider half of a target, and a target can be recovered from an error", () => {
  assert.equal(routeOf("local/qwen3.8-27b"), "local");
  assert.equal(routeOf("opencode-free/glm-5.3-flash-free"), "opencode-free");
  assert.equal(routeOf("qwen3.8-27b"), null);
  assert.equal(routeOf(""), null);
  assert.equal(routeOf(undefined), null);
  assert.equal(targetFromText("opencode-free/deepseek-v4.1-flash-free: FreeUsageLimitError"), "opencode-free/deepseek-v4.1-flash-free");
  assert.equal(targetFromText("no target here"), null);
});

test("the first hit of a window is frozen, so the reset estimate does not slide", () => {
  let record = emptyRecord();
  record = recordHit(record, { at: AT, route: "opencode-free", model: "glm-5.3-flash-free", kind: "usage", reason: "FreeUsageLimitError" });
  record = recordHit(record, { at: AT + 5 * 60_000, route: "opencode-free", model: "deepseek-v4.1-flash-free", kind: "usage" });
  const entry = record.routes["opencode-free"];
  assert.equal(entry.firstHitAt, AT);
  assert.equal(entry.windowEndsAt, AT + 24 * HOUR);
  assert.equal(entry.hits, 2);
  assert.deepEqual(entry.models, ["glm-5.3-flash-free", "deepseek-v4.1-flash-free"]);
  assert.equal(entry.reason, "FreeUsageLimitError");
});

test("a short server window never shortens a usage window, and a usage cap upgrades one", () => {
  let record = recordHit(emptyRecord(), { at: AT, route: "opencode-free", kind: "server", cooldownMinutes: 10 });
  assert.equal(record.routes["opencode-free"].windowEndsAt, AT + 10 * 60_000);
  // Inside the cooldown: still a server entry, still the same window.
  record = recordHit(record, { at: AT + 60_000, route: "opencode-free", kind: "server" });
  assert.equal(record.routes["opencode-free"].windowEndsAt, AT + 10 * 60_000);
  assert.equal(record.routes["opencode-free"].hits, 2);

  // A budget cap arriving during the cooldown replaces the window with the long one.
  record = recordHit(record, { at: AT + 2 * 60_000, route: "opencode-free", kind: "usage" });
  assert.equal(record.routes["opencode-free"].kind, "usage");
  assert.equal(record.routes["opencode-free"].firstHitAt, AT + 2 * 60_000);
  assert.equal(record.routes["opencode-free"].windowEndsAt, AT + 2 * 60_000 + 24 * HOUR);

  // The reverse direction is refused: a 10-minute outage cannot cut a 24h cap short.
  record = recordHit(record, { at: AT + 3 * 60_000, route: "opencode-free", kind: "server" });
  assert.equal(record.routes["opencode-free"].kind, "usage");
  assert.equal(record.routes["opencode-free"].windowEndsAt, AT + 2 * 60_000 + 24 * HOUR);
});

test("an expired window starts over, and a hit without a route changes nothing", () => {
  let record = recordHit(emptyRecord(), { at: AT, route: "local", kind: "usage" });
  assert.equal(record.routes.local.hits, 1);
  record = recordHit(record, { at: AT + 25 * HOUR, route: "local", kind: "usage" });
  assert.equal(record.routes.local.hits, 1);
  assert.equal(record.routes.local.firstHitAt, AT + 25 * HOUR);

  const before = JSON.stringify(record);
  assert.equal(JSON.stringify(recordHit(record, { at: AT, route: "", kind: "usage" })), before);
  assert.equal(JSON.stringify(recordHit(record, { at: AT, kind: "usage" })), before);
  // A record that arrived as junk is replaced, not crashed on.
  assert.deepEqual(recordHit(null, { at: AT, route: "x", kind: "usage" }).routes.x.hits, 1);
  assert.deepEqual(recordHit({ routes: "nope" }, { at: AT, route: "x", kind: "usage" }).routes.x.hits, 1);
});

test("only open windows are active, and the report says what is left in them", () => {
  let record = recordHit(emptyRecord(), { at: AT, route: "opencode-free", kind: "usage", model: "glm-5.3-flash-free" });
  record = recordHit(record, { at: AT, route: "local", kind: "server", cooldownMinutes: 10 });
  assert.deepEqual(activeLimits(record, AT + HOUR).map((e) => e.route), ["opencode-free"]);
  assert.equal(activeLimits(record, AT + 25 * HOUR).length, 0);
  assert.equal(formatLeft(23 * HOUR + 12 * 60_000), "23h 12m");
  assert.equal(formatLeft(4 * 60_000), "4m");
  assert.equal(formatLeft(-5), "0m");

  const text = formatStatus(record, AT + HOUR, { stateFile: "C:\\ws\\.rate-limits.json", fallback: "local/qwen3.8-27b" });
  assert.match(text, /1 provider route limited right now/);
  assert.match(text, /sent to local\/qwen3\.8-27b/);
  assert.match(text, /opencode-free {4}usage limit {2}1 hit, models glm-5\.3-flash-free/);
  assert.match(text, /first hit 2026-10-20T15:49Z, estimated reset 2026-10-21T15:49Z \(23h 0m left\)/);
  assert.match(text, /local {12}expired at 2026-10-20T15:59Z \(server class\)/);

  const idle = formatStatus(emptyRecord(), AT);
  assert.match(idle, /no provider route is limited right now/);
  assert.match(idle, /nothing recorded yet/);
});

test("the record survives a round trip, and a broken file is an empty record", () => {
  const bed = bench();
  try {
    const record = recordHit(emptyRecord(), { at: AT, route: "opencode-free", model: "glm-5.3-flash-free", kind: "usage" });
    assert.equal(writeState(statePathOf(bed.ctx), record), true);
    const back = readState(statePathOf(bed.ctx));
    assert.equal(back.routes["opencode-free"].hits, 1);
    assert.equal(back.routes["opencode-free"].windowEndsAt, AT + 24 * HOUR);

    writeFileSync(statePathOf(bed.ctx), "{not json", "utf8");
    assert.deepEqual(readState(statePathOf(bed.ctx)), emptyRecord());
    writeFileSync(statePathOf(bed.ctx), '{"version":1,"routes":[]}', "utf8");
    assert.deepEqual(readState(statePathOf(bed.ctx)), emptyRecord());

    assert.deepEqual(readState(join(bed.root, "missing.json")), emptyRecord());
    assert.equal(writeState("", record), false);
  } finally {
    bed.cleanup();
  }
});

test("loading the plugin reads the record and never creates it", async () => {
  const bed = bench();
  try {
    const path = statePathOf(bed.ctx);
    assert.equal(existsSync(path), false);
    await plugin.setup(bed.ctx);
    assert.equal(existsSync(path), false);
    assert.match(plugin.status(bed.ctx), /no route limited/);
    assert.match(plugin.status(bed.ctx), /record only$/);
    assert.equal(existsSync(path), false);
  } finally {
    bed.cleanup();
  }
});

test("a failed call writes one attributed hit, and never changes the call it saw", async () => {
  const bed = bench();
  try {
    const hooks = plugin.hooks(bed.ctx);
    const state = runState();
    const info = {
      phase: "end",
      ok: false,
      target: null,
      reason: "call_failed",
      error: "opencode-free/glm-5.3-flash-free: FreeUsageLimitError: Rate limit exceeded",
      run: { id: "r1", started: AT, depth: 0, state },
    };
    // Observer semantics: the return value is undefined, so the loop is untouched.
    assert.equal(await hooks["llm/stream"](info), undefined);

    const record = readState(statePathOf(bed.ctx));
    assert.equal(record.routes["opencode-free"].kind, "usage");
    assert.equal(record.routes["opencode-free"].models[0], "glm-5.3-flash-free");
    assert.match(record.routes["opencode-free"].reason, /FreeUsageLimitError/);
    // The run remembers it too, so the next step can act before the router does.
    assert.equal(state.get("lost").route, "opencode-free");
    assert.equal(state.get("lost").until, record.routes["opencode-free"].windowEndsAt);
  } finally {
    bed.cleanup();
  }
});

test("a hit with no target of any kind is still recorded, under (unknown)", async () => {
  const bed = bench();
  try {
    await plugin.hooks(bed.ctx)["llm/stream"]({ phase: "end", ok: false, reason: "call_failed", error: "quota exceeded", run: { state: runState() } });
    const record = readState(statePathOf(bed.ctx));
    assert.equal(record.routes["(unknown)"].kind, "usage");
  } finally {
    bed.cleanup();
  }
});

test("starts, successes and non-limit failures write nothing", async () => {
  const bed = bench();
  try {
    const hooks = plugin.hooks(bed.ctx);
    const state = runState();
    const base = { target: "local/qwen3.8-27b", run: { state } };
    await hooks["llm/stream"]({ ...base, phase: "start" });
    await hooks["llm/stream"]({ ...base, phase: "end", ok: true, ms: 1200 });
    await hooks["llm/stream"]({ ...base, phase: "end", ok: false, reason: "stream_truncated", error: "stream ended mid-flight" });
    assert.equal(existsSync(statePathOf(bed.ctx)), false);
    assert.equal(state.get("lost"), undefined);
  } finally {
    bed.cleanup();
  }
});

test("the next step is re-targeted at the fallback, with a note that never counts down", async () => {
  const bed = bench({ fallback: "local/qwen3.8-27b" });
  try {
    const hooks = plugin.hooks(bed.ctx);
    const state = runState({ lost: { route: "opencode-free", until: AT + 24 * HOUR, kind: "usage" } });
    const advice = await hooks.beforeStep({ step: 2, target: null, run: { state } });
    assert.equal(advice.model, "local/qwen3.8-27b");
    assert.match(advice.note, /opencode-free is out of budget \(estimated reset\) at 2026-10-21T15:49Z/);
    assert.match(advice.note, /runs on local\/qwen3\.8-27b/);
    // Absolute time only: two readings of the same record print the same note.
    assert.equal(advice.note, (await plugin.hooks(bed.ctx).beforeStep({ step: 3, run: { state: runState({ lost: { route: "opencode-free", until: AT + 24 * HOUR, kind: "usage" } }) } })).note);
    // The flag is spent, so the note is not repeated on every step of the run.
    assert.equal(state.get("lost"), undefined);
    assert.equal(await hooks.beforeStep({ step: 3, target: "local/qwen3.8-27b", run: { state } }), undefined);
  } finally {
    bed.cleanup();
  }
});

test("no fallback configured means record only: the hooks advise nothing", async () => {
  const bed = bench();
  try {
    const hooks = plugin.hooks(bed.ctx);
    const state = runState({ lost: { route: "x", until: AT + HOUR, kind: "usage" } });
    assert.equal(await hooks.beforeStep({ step: 2, run: { state } }), undefined);
    // ...and the flag was not consumed by a mode that cannot use it.
    assert.ok(state.get("lost"));
  } finally {
    bed.cleanup();
  }
});

test("pinWhenLimited keeps every run off a limited route, once asked to", async () => {
  const bed = bench({ fallback: "local/qwen3.8-27b", pinWhenLimited: true });
  try {
    const hooks = plugin.hooks(bed.ctx);
    // Nothing limited yet: no advice.
    assert.equal(await hooks.beforeStep({ step: 1, run: { state: runState() } }), undefined);
    // A hit lands (in this process), so the next run starts on the fallback.
    await hooks["llm/stream"]({ phase: "end", ok: false, target: "opencode-free/glm-5.3-flash-free", error: "FreeUsageLimitError", run: { state: runState() } });
    assert.deepEqual(await hooks.beforeStep({ step: 1, run: { state: runState() } }), { model: "local/qwen3.8-27b" });
    // Once the fallback itself is the limited route, pinning to it would be absurd.
    await hooks["llm/stream"]({ phase: "end", ok: false, target: "local/qwen3.8-27b", error: "quota exceeded", run: { state: runState() } });
    assert.equal(await hooks.beforeStep({ step: 1, run: { state: runState() } }), undefined);
  } finally {
    bed.cleanup();
  }
});

test("the tool and both commands report and clear the same record", async () => {
  const bed = bench({ fallback: "local/qwen3.8-27b" });
  try {
    const ctx = bed.ctx;
    const hooks = plugin.hooks(ctx);
    await hooks["llm/stream"]({ phase: "end", ok: false, target: "opencode-free/glm-5.3-flash-free", error: "FreeUsageLimitError", run: { state: runState() } });

    const [tool] = plugin.tools(ctx);
    assert.equal(tool.name, "rate_limit_status");
    assert.match(tool.run({}), /opencode-free +usage limit/);
    assert.match(tool.run({}), /estimated reset/);

    const commands = plugin.commands(ctx);
    assert.deepEqual(Object.keys(commands), ["status", "clear"]);
    assert.match(await commands.status([]), /limited right now/);
    assert.match(await commands.clear([]), /record cleared: /);
    assert.match(await commands.status([]), /no provider route is limited right now/);
    assert.deepEqual(readState(statePathOf(ctx)), emptyRecord());
  } finally {
    bed.cleanup();
  }
});
