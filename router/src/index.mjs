#!/usr/bin/env node
/**
 * Entrypoint. Zero dependencies on purpose: this must be startable on a box with
 * no Docker, no build step and no package install, because it is the thing every
 * other service is supposed to route through.
 *
 *   node src/index.mjs
 *   node src/index.mjs --config ./router.config.json --port 8077
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig, validateConfig } from "./config.mjs";
import { KeyPool, Ledger, POOL_KEY_ENV_HELP, ProviderBreaker } from "./limits.mjs";
import { createLogger } from "./log.mjs";
import { loadClassPersonas } from "./persona.mjs";
import { createRouterServer } from "./server.mjs";
import { applyBudgetOverrides } from "./budgets.mjs";
import { UsageStore } from "./usage.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const configPath = arg("config", process.env.ROUTER_CONFIG ?? "router.config.json");
if (!existsSync(resolve(configPath))) {
  process.stderr.write(`router: no config at ${resolve(configPath)}\n`);
  process.exit(2);
}

const config = loadConfig(configPath);
if (arg("port")) config.port = Number(arg("port"));
// Spend limits changed in the app (Settings > Spend limits) win over the shipped config.
applyBudgetOverrides(config);
const warnings = validateConfig(config);

// Class-owned system prompts (the `rosalena` identity and anything else that declares
// `systemPromptFile`). Read ONCE here, before the port is opened, and fatal if absent or
// empty: a router that starts without the prompt would answer under the class's name
// with a different assistant's rules, and no caller could tell. Failing at boot is the
// only place this can be made visible to whoever started it.
let personas;
try {
  personas = loadClassPersonas(config);
} catch (err) {
  process.stderr.write(`router: ${err.message}\n`);
  process.exit(2);
}

const logger = createLogger({ logDir: config.logDir, echo: process.env.ROUTER_QUIET !== "1" });
const ledger = new Ledger(config.stateFile);
const keyPool = new KeyPool(process.env, config.providers, { keyFile: config.keyFile });
// The breaker is stateful and in-memory on purpose: a provider that is down for
// this process is not necessarily down for the next one, and a stale "open" flag
// surviving a restart would blacklist a provider that has since recovered.
const breaker = new ProviderBreaker(config.breaker ?? {});
// Per-call token usage, in its own append-only file next to the ledger. Unlike the
// breaker this IS persisted: "how many tokens did each model generate" has to
// survive the restart, and the whole point of the panel is a 30-day view.
const usage = new UsageStore(config.usageFile, {
  retentionDays: config.usageRetentionDays,
  maxBytes: config.usageMaxBytes,
});

const server = createRouterServer({ config, ledger, keyPool, breaker, logger, warnings, usage, personas });

server.listen(config.port, config.host, () => {
  const classes = Object.keys(config.classes ?? {});
  const b = config.breaker ?? {};
  process.stdout.write(
    [
      `rosalena-router listening on http://${config.host}:${config.port}`,
      `  classes   ${classes.join(", ")}`,
      `  providers ${Object.keys(config.providers ?? {}).join(", ")}`,
      `  ledger    ${config.stateFile}`,
      `  usage     ${config.usageFile} (${usage.info().retentionDays}d window, ${Math.round(usage.info().maxBytes / 1048576)} MiB cap)`,
      `  logs      ${config.logDir}`,
      // File names only: the prompt TEXT is never printed, only where it was read from.
      personas.size ? `  personas  ${[...personas].map(([cls, p]) => `${cls} <- ${p.file}`).join(", ")}` : null,
      `  circuit   ${b.enabled === false ? "off" : `open after ${b.threshold ?? 3} failure(s), cooldown ${Math.round((b.defaultCooldownMs ?? 30000) / 1000)}s, max ${Math.round((b.maxCooldownMs ?? 900000) / 1000)}s`}`,
      warnings.length ? `  warnings  ${warnings.length} (see /admin/status)` : "  warnings  none",
    ]
      .filter((line) => line !== null)
      .join("\n") + "\n",
  );
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
  const keyless = Object.entries(config.providers ?? {})
    // keyPool.all() takes the PROVIDER name, not the env var name. A provider whose key is
    // optional is not a warning: it answers without one, so listing it here would train the
    // reader to ignore a line that has to stay loud for the providers that genuinely cannot
    // be reached without a key.
    .filter(([name, spec]) => spec.apiKeyEnv && !spec.apiKeyOptional && !keyPool.all(name).length)
    .map(([name]) => name);
  if (keyless.length) {
    process.stdout.write(`  ! no key loaded for: ${keyless.join(", ")} - those targets will be skipped\n`);
    if (process.env.ROUTER_VERBOSE === "1") process.stdout.write(`${POOL_KEY_ENV_HELP}\n`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    process.stdout.write(`\nrosalena-router: ${sig}, closing\n`);
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
