/**
 * The model menu. The interesting cases are all about the sources disagreeing:
 * a router that is up but says nothing, a local server that is down, a config on
 * disk that is stale. None of them may produce an empty picker or an exception.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  costLabel,
  createMenuCache,
  fromLocalModels,
  fromRouter,
  loadModelMenu,
  mergeMenu,
  readRoles,
  rolesFromRouter,
  splitTarget,
} from "../src/models.mjs";

const TMP = mkdtempSync(join(tmpdir(), "models-test-"));

const CONFIG = {
  providers: {
    local: { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", prices: { in: 0, out: 0 } },
    "opencode-free": { kind: "openai", baseUrl: "https://opencode.ai/zen/v1", prices: { in: 0, out: 0 } },
    anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", prices: { in: 3, out: 15 } },
  },
  classes: {
    orchestrate: { chain: ["local/qwen3.8-27b", "opencode-free/deepseek-v4.1-flash-free"] },
    code: { chain: ["opencode-free/deepseek-v4.1-flash-free", "anthropic/claude-sonnet-4-5"] },
    fast: { chain: ["local/qwen3.8-27b"] },
    judge: { chain: ["anthropic/claude-sonnet-4-5"] },
  },
  models: [
    { target: "local/qwen3.8-27b", label: "Qwen3.8 27B (local)", tags: ["local"], note: "on this machine" },
    { target: "opencode-free/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash (free)" },
    { target: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { target: "not-a-target" },
    { target: "made-up/model", label: "Ghost" },
  ],
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("a target splits at the first slash so nested ids survive", () => {
  assert.deepEqual(splitTarget("openrouter/anthropic/claude-sonnet-4.5"), {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.deepEqual(splitTarget("local/qwen3.8-27b"), { provider: "local", model: "qwen3.8-27b" });
  assert.equal(splitTarget("noprovider"), null);
  assert.equal(splitTarget("/leading"), null);
  assert.equal(splitTarget("trailing/"), null);
  assert.equal(splitTarget(null), null);
});

test("free is spelled free, and paid prices show both halves", () => {
  assert.equal(costLabel({ in: 0, out: 0 }), "free");
  assert.equal(costLabel({ in: 3, out: 15 }), "$3/$15 per Mtok");
  assert.equal(costLabel({}), null);
  assert.equal(costLabel(null), null);
});

test("the curated list becomes the menu, and malformed entries are dropped", () => {
  const menu = fromRouter(CONFIG);
  const ids = menu.map((m) => m.id);
  assert.deepEqual(ids, [
    "local/qwen3.8-27b",
    "opencode-free/deepseek-v4.1-flash-free",
    "anthropic/claude-sonnet-4-5",
    "made-up/model",
  ]);
  const local = menu[0];
  assert.equal(local.label, "Qwen3.8 27B (local)");
  assert.deepEqual(local.tags, ["local"]);
  assert.equal(local.cost, "free");
  assert.equal(menu[1].cost, "free");
  assert.equal(menu[2].cost, "$3/$15 per Mtok");
  assert.equal(menu[1].label, "DeepSeek V4.1 Flash (free)");
});

test("a label-less entry is labelled by its model id, never by its provider", () => {
  const menu = fromRouter({ providers: {}, models: [{ target: "x/some-model" }] });
  assert.equal(menu[0].label, "some-model");
});

test("the product's own model is spelled Rosalena even with no role preset", () => {
  // A custom class is a model, not a chain, so it belongs in the picker under its own
  // name - and that name is a proper noun, never the lower-case wire id.
  const menu = fromRouter({ providers: {}, classes: { rosalena: { systemPromptFile: "x.md", chain: [] } } }, {});
  assert.equal(menu[0].id, "rosalena");
  assert.equal(menu[0].label, "Rosalena");
  assert.deepEqual(menu[0].tags, ["custom", "free"]);
});

test("classes are reported as roles, not offered as models", () => {
  const roles = rolesFromRouter(CONFIG, { code: { title: "Code", addendum: "Be terse.", subagent: "fast", judge: true } });
  assert.deepEqual(roles.map((r) => r.id), ["orchestrate", "code", "fast", "judge"]);
  const code = roles.find((r) => r.id === "code");
  assert.equal(code.title, "Code");
  assert.equal(code.addendum, "Be terse.");
  assert.equal(code.subagent, "fast");
  assert.equal(code.judge, true);
  assert.deepEqual(code.chain, ["opencode-free/deepseek-v4.1-flash-free", "anthropic/claude-sonnet-4-5"]);
  assert.equal(roles.find((r) => r.id === "fast").judge, false, "judge defaults to off");
  assert.equal(roles.find((r) => r.id === "fast").title, "fast", "a role with no preset keeps its id as a title");
  // A role is never a model entry.
  assert.equal(fromRouter(CONFIG).some((m) => m.id === "code"), false);
});

test("llama.cpp ids merge into the same list with a local prefix", () => {
  const local = fromLocalModels([{ id: "qwen3.8-27b" }, { id: "local/second" }, { id: "" }, "plain-string"]);
  assert.deepEqual(local.map((m) => m.id), ["local/qwen3.8-27b", "local/second", "local/plain-string"]);
  assert.equal(local[0].source, "local");
  assert.equal(local[0].cost, "free");
  assert.ok(local[0].tags.includes("local"));
});

test("merge keeps the router's ordering and never duplicates a target", () => {
  const merged = mergeMenu({
    routerModels: fromRouter(CONFIG),
    localModels: fromLocalModels([{ id: "qwen3.8-27b" }, { id: "extra-7b" }]),
  });
  assert.deepEqual(merged.map((m) => m.id), [
    "local/qwen3.8-27b",
    "opencode-free/deepseek-v4.1-flash-free",
    "anthropic/claude-sonnet-4-5",
    "made-up/model",
    "local/extra-7b",
  ]);
  assert.equal(merged[0].source, "router", "the curated entry wins, because it carries the label and the note");
});

test("the live menu comes from both servers when both answer", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes("/admin/status")) {
      return jsonResponse({ providers: CONFIG.providers, classes: CONFIG.classes, models: CONFIG.models });
    }
    return jsonResponse({ object: "list", data: [{ id: "qwen3.8-27b" }, { id: "draft-7b" }] });
  };
  const menu = await loadModelMenu({ routerBase: "http://router.invalid", localBase: "http://local.invalid", fetchImpl });
  assert.deepEqual(menu.errors, []);
  assert.equal(menu.models.length, 5);
  assert.equal(menu.roles.length, 4);
  assert.ok(menu.models.some((m) => m.id === "local/draft-7b"), "a model the config does not mention but the server serves is offered");
  assert.equal(seen.length, 2);
});

test("a local target the PC does not hold is dropped, not offered", async () => {
  // The config was written on the machine that has the model, and a shipped config carries
  // its label and its note with it. On a PC where the local server is up but holds something
  // else, the curated local row is a model nobody can run, so it must not appear.
  const fetchImpl = async (url) => {
    if (String(url).includes("/admin/status")) {
      return jsonResponse({ providers: CONFIG.providers, classes: CONFIG.classes, models: CONFIG.models });
    }
    return jsonResponse({ data: [{ id: "other-7b" }] });
  };
  const menu = await loadModelMenu({ routerBase: "http://router.invalid", localBase: "http://local.invalid", fetchImpl });
  assert.equal(
    menu.models.some((m) => m.id === "local/qwen3.8-27b"),
    false,
    "the config's own local model is not offered on a PC that lacks it",
  );
  assert.equal(menu.models.some((m) => m.id === "local/other-7b"), true, "what the server does hold is offered");
  assert.match(menu.errors.join("\n"), /not installed on this PC: local\/qwen3\.8-27b/);
  assert.equal(
    menu.models.some((m) => m.id === "opencode-free/deepseek-v4.1-flash-free"),
    true,
    "a cloud target is never filtered by the local probe",
  );
});

test("a local target survives when the PC really holds it", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/admin/status")) {
      return jsonResponse({ providers: CONFIG.providers, classes: CONFIG.classes, models: CONFIG.models });
    }
    return jsonResponse({ data: [{ id: "qwen3.8-27b" }] });
  };
  const menu = await loadModelMenu({ routerBase: "http://router.invalid", localBase: "http://local.invalid", fetchImpl });
  assert.equal(menu.models.filter((m) => m.id === "local/qwen3.8-27b").length, 1, "one row, not one curated and one probed");
  assert.doesNotMatch(menu.errors.join("\n"), /not installed/);
});

test("a stopped router falls back to the config on disk and says so", async () => {
  const root = join(TMP, "fallback");
  mkdirSync(join(root, "router"), { recursive: true });
  writeFileSync(join(root, "router", "router.config.json"), JSON.stringify(CONFIG));
  const fetchImpl = async (url) => {
    if (String(url).includes("/admin/status")) throw new Error("connect ECONNREFUSED");
    return jsonResponse({ data: [{ id: "qwen3.8-27b" }] });
  };
  const menu = await loadModelMenu({ routerBase: "http://router.invalid", localBase: "http://local.invalid", root, fetchImpl });
  assert.equal(menu.models.length, 4);
  assert.equal(menu.roles.length, 4);
  assert.match(menu.errors[0], /ECONNREFUSED/);
  assert.match(menu.errors[1], /router\.config\.json/, "the user is told which file is being trusted instead");
});

test("a loopback gateway is offered while it runs, even though llama.cpp never serves its models", async () => {
  // OmniRoute sits on 127.0.0.1 like llama.cpp, but its "auto" is a routing preset, not a
  // GGUF. Judging it by the llama.cpp list hid it on every PC; a 401 still means it is up.
  const config = {
    ...CONFIG,
    providers: { ...CONFIG.providers, omniroute: { kind: "openai", baseUrl: "http://127.0.0.1:20128/v1", prices: { in: 0, out: 0 } } },
    models: [...CONFIG.models, { target: "omniroute/auto", label: "OmniRoute auto" }],
  };
  const probed = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("/admin/status")) return jsonResponse(config);
    if (String(url).startsWith("http://127.0.0.1:20128/")) return probed.push(String(url)), jsonResponse({ error: "unauthorized" }, 401);
    return jsonResponse({ data: [{ id: "qwen3.8-27b" }] });
  };
  const menu = await loadModelMenu({ routerBase: "http://router.invalid", localBase: "http://local.invalid", fetchImpl });
  assert.equal(menu.models.some((m) => m.id === "omniroute/auto"), true);
  assert.deepEqual(probed, ["http://127.0.0.1:20128/v1/models"]);
  assert.doesNotMatch(menu.errors.join("\n"), /omniroute/);
});

test("a loopback gateway that is not running is left out and named", async () => {
  const config = {
    ...CONFIG,
    providers: { ...CONFIG.providers, omniroute: { kind: "openai", baseUrl: "http://127.0.0.1:20128/v1", prices: { in: 0, out: 0 } } },
    models: [...CONFIG.models, { target: "omniroute/auto", label: "OmniRoute auto" }],
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("/admin/status")) return jsonResponse(config);
    if (String(url).startsWith("http://127.0.0.1:20128/")) throw new Error("connect ECONNREFUSED");
    return jsonResponse({ data: [{ id: "qwen3.8-27b" }] });
  };
  const menu = await loadModelMenu({ routerBase: "http://router.invalid", localBase: "http://local.invalid", fetchImpl });
  assert.equal(menu.models.some((m) => m.id === "omniroute/auto"), false);
  assert.match(menu.errors.join("\n"), /omniroute is not running on this PC/);
  assert.doesNotMatch(menu.errors.join("\n"), /not installed on this PC: .*omniroute/);
});

test("provider model objects become rows by id and label, not [object Object]", () => {
  const menu = fromRouter({ providers: { gw: { models: [{ id: "auto", label: "Auto" }, "plain", {}] } } });
  assert.deepEqual(menu.map((m) => [m.id, m.label]), [["gw/auto", "Auto"], ["gw/plain", "plain"]]);
});

test("both servers down still yields a usable, empty menu with two reasons", async () => {
  const fetchImpl = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const menu = await loadModelMenu({ routerBase: "http://r.invalid", localBase: "http://l.invalid", root: TMP, fetchImpl });
  assert.deepEqual(menu.models, []);
  assert.deepEqual(menu.roles, []);
  assert.equal(menu.errors.length, 2, "one error per source, not one per model");
  assert.ok(menu.fetchedAt);
});

test("a hung server is abandoned at the timeout instead of hanging the composer", async () => {
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  const started = Date.now();
  const menu = await loadModelMenu({ routerBase: "http://r.invalid", localBase: "http://l.invalid", root: TMP, timeoutMs: 40, fetchImpl });
  assert.ok(Date.now() - started < 2000);
  assert.equal(menu.errors.length, 2);
  assert.match(menu.errors[0], /timed out after 40ms/);
});

test("a roles file is read from data/, and a missing one is not an error", () => {
  const root = join(TMP, "roles");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "roles.json"), JSON.stringify({ roles: { code: { title: "Code" } } }));
  assert.deepEqual(readRoles(root), { code: { title: "Code" } });
  assert.deepEqual(readRoles(join(TMP, "no-roles-here")), {});
});

test("the cache serves a success for the ttl and retries a failure after a second", async () => {
  let calls = 0;
  let clock = 1_000_000;
  const cache = createMenuCache({ ttlMs: 10_000, failedTtlMs: 1000, now: () => clock });
  const good = async () => {
    calls += 1;
    return { models: [{ id: "a" }], errors: [] };
  };
  await cache.get(good);
  await cache.get(good);
  assert.equal(calls, 1, "two keystrokes inside the ttl are one round trip");
  clock += 10_001;
  await cache.get(good);
  assert.equal(calls, 2);

  const failing = async () => {
    calls += 1;
    return { models: [], errors: ["down"] };
  };
  cache.clear();
  await cache.get(failing);
  clock += 500;
  await cache.get(failing);
  assert.equal(calls, 3, "a failure is retried sooner, because the router may have just started");
  clock += 1001;
  await cache.get(failing);
  assert.equal(calls, 4);
});
