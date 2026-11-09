/**
 * Settings > Spend limits (2026-11-08): a monthly cap changed from the app applies to the
 * next request and survives a restart, over the shipped router.config.json.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyBudgetOverrides, budgetsFile, setBudget } from "../src/budgets.mjs";
import { createRouterServer } from "../src/server.mjs";

const fresh = (cap = 40) => {
  const dir = mkdtempSync(join(tmpdir(), "router-budgets-"));
  return {
    stateFile: join(dir, "ledger.json"),
    budgets: { monthlyUsd: { anthropic: cap, local: 0 } },
    providers: { anthropic: { kind: "anthropic", baseUrl: "http://x/v1" }, local: { kind: "openai", baseUrl: "http://y/v1" } },
    classes: {},
  };
};

test("a cap set from the app is live at once and comes back after a restart", () => {
  const config = fresh(40);
  assert.equal(setBudget(config, "anthropic", 80), 80);
  assert.equal(config.budgets.monthlyUsd.anthropic, 80, "the object every check reads");
  assert.deepEqual(JSON.parse(readFileSync(budgetsFile(config), "utf8")).monthlyUsd, { anthropic: 80 });
  const restarted = { ...fresh(40), stateFile: config.stateFile };
  assert.deepEqual(applyBudgetOverrides(restarted), { anthropic: 80 });
  assert.equal(restarted.budgets.monthlyUsd.anthropic, 80, "the shipped 40 does not come back");
  assert.throws(() => setBudget(config, "nope", 5), /no provider/);
  assert.throws(() => setBudget(config, "anthropic", -1), /from 0/);
});

test("a malformed cap is refused instead of turning into 'no limit'", () => {
  const config = fresh(40);
  // Number(null), Number(""), Number(false) and Number([]) are all 0, and 0 means no limit.
  for (const bad of [null, "", "  ", false, [], {}, "abc", undefined]) {
    assert.throws(() => setBudget(config, "anthropic", bad), /number of dollars/, JSON.stringify(bad));
  }
  assert.throws(() => setBudget(config, "anthropic", 0.001), /under one cent/);
  assert.equal(config.budgets.monthlyUsd.anthropic, 40, "the cap is untouched after every refusal");
  assert.equal(setBudget(config, "anthropic", "75.5"), 75.5, "a numeric string still works");
  assert.equal(setBudget(config, "anthropic", 0), 0, "0 on purpose is still no limit");
});

test("PUT /admin/budgets changes the cap /admin/status reports, behind the router token", async () => {
  const config = fresh(40);
  config.auth = { token: "t0k" };
  const server = createRouterServer({ config, warnings: [] });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/admin/budgets`, { method: "PUT", body: JSON.stringify({ provider: "anthropic", monthlyUsd: 80 }) });
    assert.equal(denied.status, 401);
    const headers = { authorization: "Bearer t0k", "content-type": "application/json" };
    const put = await fetch(`${base}/admin/budgets`, { method: "PUT", headers, body: JSON.stringify({ provider: "anthropic", monthlyUsd: 80 }) });
    assert.equal(put.status, 200, await put.clone().text());
    assert.equal((await put.json()).capUsd, 80);
    const status = await (await fetch(`${base}/admin/status`, { headers })).json();
    assert.equal(status.providers.anthropic.capUsd, 80);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
