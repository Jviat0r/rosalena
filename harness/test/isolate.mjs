// Test-process isolation.
//
// Every `runAgent` call records itself to disk, which is the point of the run store -
// but it also means an unmodified test suite writes a few hundred fake runs into the
// user's real store, where they would drown the runs that actually matter. `node --test`
// starts one process per test file, so setting the override here gives each file its own
// throwaway directory and keeps `list_runs` honest.
//
// Loaded with `node --import ./test/isolate.mjs --test` (see package.json).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.ROSALENA_RUNS_KEEP) {
  process.env.ROSALENA_RUNS = mkdtempSync(join(tmpdir(), "rosalena-test-runs-"));
}
