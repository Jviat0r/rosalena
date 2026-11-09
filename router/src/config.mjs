/**
 * Config loading and validation.
 *
 * Validation is advisory on purpose: a misconfigured target should degrade into a
 * logged skip and a working fallback, not a server that refuses to boot at 2am.
 * The warnings are printed once at startup and exposed on /admin/status.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const KNOWN_KINDS = new Set(["openai", "anthropic"]);

export function loadConfig(file, { env = process.env } = {}) {
  const path = resolve(file);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cfg = {
    host: "127.0.0.1",
    port: 8077,
    logDir: "logs",
    stateFile: "state/ledger.json",
    requestTimeoutMs: 180_000,
    defaultClass: "fast",
    budgets: { monthlyUsd: {} },
    providers: {},
    classes: {},
    ...raw,
  };
  // Paths in the config are written relative to the config file, not to whatever
  // directory the process happens to be started from.
  const base = dirname(path);
  cfg.logDir = resolve(base, cfg.logDir);
  cfg.stateFile = resolve(base, cfg.stateFile);
  // Token usage lives NEXT TO the ledger, in the same state directory: that
  // directory is already resolved relative to the config file, so it survives a
  // restart and works from any working directory without a new config key. It is a
  // separate FILE on purpose - the ledger is one number per provider per month and
  // must stay small, while usage is per-call detail with a 30-day window and a byte
  // cap of its own (see src/usage.mjs). Set `usageFile` to move it.
  cfg.usageFile = cfg.usageFile ? resolve(base, cfg.usageFile) : join(dirname(cfg.stateFile), "usage.jsonl");
  // Optional secrets file, resolved next to the config. Environment variables
  // still work and still win; this exists so a desktop user can paste a key into
  // a file instead of setting one up in a terminal before launching the app.
  cfg.keyFile = cfg.keyFile ? resolve(base, cfg.keyFile) : resolve(base, "data/keys.json");
  // ---------------------------------------------------------------------------
  // ONE relocation switch for everything this process WRITES.
  //
  // A packaged install is not writable next to its own config: on macOS the app runs
  // from `<...>/Rosalena Harness.app/Contents/Resources/router`, which is read-only
  // once installed (and Gatekeeper app translocation can mount it from a random read-
  // only path), and on Windows the installer's folder is under Program Files. Resolving
  // logs/, state/ and data/ relative to the config file is right for a checkout and
  // wrong for an installed app.
  //
  // `ROSALENA_ROUTER_STATE_DIR` re-roots the four writable paths under one directory,
  // keeping the shape the defaults already use:
  //
  //   <dir>/logs                request log
  //   <dir>/state/ledger.json   spend ledger
  //   <dir>/state/usage.jsonl   token usage
  //   <dir>/data/keys.json      optional pasted provider keys
  //
  // READ paths are deliberately untouched: the config file itself and every
  // `systemPromptFile` keep resolving relative to wherever the config was shipped, so
  // the app can ship one read-only config with its prompt beside it and still start.
  // Unset (the default, and what this repository's own runs use) means the previous
  // behaviour exactly. desktop/main.mjs sets it to <userData>/router.
  const stateDir = String(env.ROSALENA_ROUTER_STATE_DIR ?? "").trim();
  if (stateDir) {
    const root = resolve(stateDir);
    cfg.logDir = join(root, "logs");
    cfg.stateFile = join(root, "state", "ledger.json");
    cfg.usageFile = join(root, "state", "usage.jsonl");
    cfg.keyFile = join(root, "data", "keys.json");
  }

  cfg.configPath = path;
  return cfg;
}

export function validateConfig(cfg, env = process.env) {
  const warnings = [];
  const providerNames = Object.keys(cfg.providers ?? {});
  if (!providerNames.length) warnings.push("no providers configured");

  const token = authToken(cfg, env);
  if (!token) {
    warnings.push(
      cfg.auth?.tokenEnv
        ? `auth.tokenEnv "${cfg.auth.tokenEnv}" is not set, so the router is unauthenticated - any process that can reach this port can spend the configured budget`
        : "no auth token configured - any process that can reach this port can spend the configured budget (set auth.tokenEnv and export it, or pass auth.token)",
    );
  } else {
    if (token.length < 16) warnings.push(`auth token is ${token.length} characters - use at least 16, it is a password`);
    if (cfg.auth?.token) warnings.push("auth.token is set inline in the config file - prefer auth.tokenEnv so the secret is not in a file you may share");
  }

  for (const [name, spec] of Object.entries(cfg.providers ?? {})) {
    if (!KNOWN_KINDS.has(spec.kind)) {
      warnings.push(`provider "${name}": unknown kind "${spec.kind}" (known: ${[...KNOWN_KINDS].join(", ")})`);
    }
    if (!spec.baseUrl) warnings.push(`provider "${name}": no baseUrl`);
    if (!spec.prices) warnings.push(`provider "${name}": no prices, so its spend will be recorded as $0`);
  }

  for (const [cls, entry] of Object.entries(cfg.classes ?? {})) {
    if (!Array.isArray(entry.chain) || !entry.chain.length) {
      warnings.push(`class "${cls}": empty chain`);
      continue;
    }
    for (const target of entry.chain) {
      const slash = String(target).indexOf("/");
      if (slash <= 0) {
        warnings.push(`class "${cls}": target "${target}" is not "provider/model"`);
        continue;
      }
      const provider = String(target).slice(0, slash);
      if (!cfg.providers?.[provider]) warnings.push(`class "${cls}": target "${target}" names unknown provider "${provider}"`);
    }
  }

  if (!Object.keys(cfg.classes ?? {}).length) warnings.push("no classes configured");
  return warnings;
}

/** Cheap preflight: does the config file even exist where we were told to look? */
export function configExists(file) {
  return existsSync(resolve(file));
}

/**
 * The router's optional shared secret.
 *
 * Off by default, because on this machine every legitimate client (the harness,
 * the UI) is a local process and the server binds loopback. It exists for the case
 * the default does NOT cover: anything else on the box - or a web page in the
 * user's browser reaching 127.0.0.1:8077 - can otherwise spend the configured
 * budget and drive the GPU. When a token is configured it is required from
 * loopback callers too; exempting them would make the gate decorative.
 *
 * `auth.tokenEnv` is preferred over `auth.token` so the secret does not have to
 * live in a checked-in JSON file.
 */
export function authToken(config, env = process.env) {
  const auth = config?.auth ?? {};
  if (auth.token) return String(auth.token).trim();
  if (auth.tokenEnv) return String(env[auth.tokenEnv] ?? "").trim();
  return "";
}
