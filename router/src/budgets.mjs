/**
 * Monthly spend caps the person changes from the app (Settings > Spend limits), on top of
 * router.config.json's `budgets.monthlyUsd` (2026-11-08). A change applies to the very next
 * request - every check reads `config.budgets.monthlyUsd` live - and is kept in
 * `budgets.json` next to the ledger, so a restart or an app update that ships a new
 * router.config.json does not put the old cap back.
 *
 * A cap is dollars per calendar month (UTC); 0 means uncapped, the same rule as the config.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the person's caps live: beside the ledger (state/budgets.json). */
export function budgetsFile(config) {
  return config?.stateFile ? join(dirname(config.stateFile), "budgets.json") : null;
}

function readOverrides(file) {
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed?.monthlyUsd && typeof parsed.monthlyUsd === "object" ? parsed.monthlyUsd : {};
  } catch {
    return {};
  }
}

/** Startup: the person's caps win over the shipped ones. Returns what was applied. */
export function applyBudgetOverrides(config) {
  const overrides = readOverrides(budgetsFile(config));
  config.budgets ??= {};
  config.budgets.monthlyUsd ??= {};
  const applied = {};
  for (const [provider, usd] of Object.entries(overrides)) {
    const value = Number(usd);
    if (!Number.isFinite(value) || value < 0) continue;
    config.budgets.monthlyUsd[provider] = value;
    applied[provider] = value;
  }
  return applied;
}

/**
 * Set one provider's cap, live and on disk. Throws (with `status`) on a provider the
 * router does not have or a value that is not a number of dollars.
 */
export function setBudget(config, provider, monthlyUsd) {
  const name = String(provider ?? "").trim();
  if (!name || !config?.providers?.[name]) throw Object.assign(new Error(`no provider "${name}"`), { status: 404 });
  // Only a real number (or a numeric string): null, "", false and [] all became 0 through
  // Number(), and 0 means NO limit, so a malformed update wiped the cap (bug hunt 2026-11-08).
  const numeric = typeof monthlyUsd === "number" || (typeof monthlyUsd === "string" && monthlyUsd.trim() !== "" && !Number.isNaN(Number(monthlyUsd)));
  const value = numeric ? Number(monthlyUsd) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 100_000) {
    throw Object.assign(new Error("monthlyUsd must be a number of dollars from 0 (no limit) to 100000"), { status: 400 });
  }
  const rounded = Math.round(value * 100) / 100;
  if (value > 0 && rounded === 0) throw Object.assign(new Error("monthlyUsd under one cent would be read as no limit; use 0.01 or more"), { status: 400 });
  config.budgets ??= {};
  config.budgets.monthlyUsd ??= {};
  config.budgets.monthlyUsd[name] = rounded;
  const file = budgetsFile(config);
  if (file) {
    const all = { ...readOverrides(file), [name]: rounded };
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, monthlyUsd: all }, null, 2)}\n`);
    renameSync(tmp, file);
  }
  return rounded;
}
