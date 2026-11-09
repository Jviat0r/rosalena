// Every task must fail its hidden tests before any work is done, or it measures nothing.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TASKS } from "./tasks.mjs";

let bad = 0;
for (const task of TASKS) {
  const dir = mkdtempSync(join(tmpdir(), `bench-check-${task.id}-`));
  for (const [rel, text] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  mkdirSync(join(dir, ".bench"));
  writeFileSync(join(dir, ".bench", "verify.test.mjs"), task.hidden);
  const r = spawnSync(process.execPath, ["--test", join(".bench", "verify.test.mjs")], { cwd: dir, encoding: "utf8" });
  const fails = r.status !== 0;
  if (!fails) bad += 1;
  console.log(`${fails ? "ok  " : "BAD "} ${task.id}: the untouched fixture ${fails ? "fails" : "PASSES"} its hidden tests`);
}
process.exitCode = bad ? 1 : 0;
