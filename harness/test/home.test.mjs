/**
 * The suite's data directory.
 *
 * Every home-based path (memory, the process ledger, the MCP registry and state,
 * the proxy pool) has to follow `ROSALENA_HOME`, because the launcher points that
 * variable inside the product folder. That is not a preference: an .exe inside a
 * sandboxed workspace runs at Low integrity and can read %USERPROFILE%\.rosalena
 * but never write there (EPERM), so a plugin that hardcodes the home directory
 * silently loses its state whenever the product is started through the launcher.
 *
 * `DEFAULT_MEMORY_FILE` is the one value computed at import time, so it is
 * checked in a child process - the only honest way to test an import-time value.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { rosalenaHome as memoryHome } from "../src/memory.mjs";
import { ledgerPath, rosalenaHome as trackerHome } from "../plugins/rosa-process-tracker/plugin.mjs";
import { registryPath, rosalenaHome as mcpHome, statePath } from "../plugins/rosa-mcp-manager/plugin.mjs";

const DEFAULT = join(homedir(), ".rosalena");

/** Run `fn` with ROSALENA_HOME set to `value` (or unset when undefined). */
function withHome(value, fn) {
  const prior = process.env.ROSALENA_HOME;
  if (value === undefined) delete process.env.ROSALENA_HOME;
  else process.env.ROSALENA_HOME = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.ROSALENA_HOME;
    else process.env.ROSALENA_HOME = prior;
  }
}

test("every module agrees on the default data directory", () => {
  withHome(undefined, () => {
    for (const home of [memoryHome, trackerHome, mcpHome]) {
      assert.equal(home(), DEFAULT);
    }
    assert.equal(ledgerPath(), join(DEFAULT, "process-ledger.json"));
    assert.equal(registryPath(), join(DEFAULT, "mcp-servers.json"));
    assert.equal(statePath(), join(DEFAULT, "mcp-state.json"));
  });
});

test("ROSALENA_HOME relocates every home-based path, in every module", () => {
  const dir = mkdtempSync(join(tmpdir(), "rosalena-home-"));
  withHome(dir, () => {
    for (const home of [memoryHome, trackerHome, mcpHome]) {
      assert.equal(home(), dir, "a module ignored ROSALENA_HOME");
    }
    assert.equal(ledgerPath(), join(dir, "process-ledger.json"));
    assert.equal(registryPath(), join(dir, "mcp-servers.json"));
    assert.equal(statePath(), join(dir, "mcp-state.json"));
  });
});

test("an explicit config path still beats ROSALENA_HOME", () => {
  const dir = mkdtempSync(join(tmpdir(), "rosalena-home-"));
  withHome(dir, () => {
    const ctx = { config: { registryFile: "R.json", stateFile: "S.json" } };
    assert.equal(registryPath(ctx), "R.json");
    assert.equal(statePath(ctx), "S.json");
  });
});

test("an empty ROSALENA_HOME falls back to the default rather than the cwd", () => {
  withHome("", () => {
    assert.equal(memoryHome(), DEFAULT);
    assert.equal(ledgerPath(), join(DEFAULT, "process-ledger.json"));
  });
});

test("DEFAULT_MEMORY_FILE follows ROSALENA_HOME at import time", () => {
  const dir = mkdtempSync(join(tmpdir(), "rosalena-home-"));
  const probe = join(dir, "probe.mjs");
  const target = new URL("../src/memory.mjs", import.meta.url).href;
  writeFileSync(probe, `import { DEFAULT_MEMORY_FILE } from ${JSON.stringify(target)};\nconsole.log(DEFAULT_MEMORY_FILE);\n`, "utf8");

  const read = (env) =>
    execFileSync(process.execPath, [probe], { encoding: "utf8", env }).trim();

  assert.equal(read({ ...process.env, ROSALENA_HOME: dir }), join(dir, "memory.jsonl"));
  const bare = { ...process.env };
  delete bare.ROSALENA_HOME;
  assert.equal(read(bare), join(DEFAULT, "memory.jsonl"));
});
