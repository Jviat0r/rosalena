/**
 * Local model folders and llama-server are found on the machine, not assumed.
 *
 * The candidate lists are pure (they take env, platform, home and drives), so they are
 * checked without touching this machine's disks; the plugin defaults are checked to make
 * sure no developer's D:\ path is baked in any more.
 *
 *   node --test
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { modelDirCandidates, serverDirCandidates } from "../src/local-paths.mjs";

test("model folders: env override first, then LM Studio and home, then every drive", () => {
  const list = modelDirCandidates({
    env: { ROSALENA_MODEL_DIRS: "E:\\Mine;F:\\Other" },
    platform: "win32",
    home: "C:\\Users\\sam",
    drives: ["C:\\", "E:\\"],
  });
  assert.deepEqual(list.slice(0, 2), ["E:\\Mine", "F:\\Other"]);
  assert.ok(list.includes(join("C:\\Users\\sam", ".lmstudio", "models")));
  assert.ok(list.includes(join("E:\\", "Models")));
  assert.ok(!list.some((dir) => dir.startsWith("D:")), "no drive that does not exist is guessed");
});

test("llama-server: common install folders and PATH, nothing machine-specific", () => {
  const list = serverDirCandidates({
    env: { LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local", PATH: "C:\\tools;C:\\bin" },
    platform: "win32",
    home: "C:\\Users\\sam",
    drives: ["C:\\"],
  });
  assert.ok(list.includes(join("C:\\Users\\sam\\AppData\\Local", "llama.cpp")));
  assert.ok(list.includes(join("C:\\", "llama.cpp")));
  assert.ok(list.includes("C:\\tools"));
  assert.ok(!list.some((dir) => dir.startsWith("D:")));
});

test("no plugin default names one developer's folders", () => {
  for (const plugin of ["rosa-local-llm", "rosa-local-model-switch", "rosa-local-model-host", "rosa-local-model-monitor"]) {
    const dir = new URL(`../plugins/${plugin}/`, import.meta.url);
    for (const file of ["plugin.json", "plugin.mjs"]) {
      const text = readFileSync(new URL(file, dir), "utf8");
      assert.doesNotMatch(text, /D:\\\\(Models|llama\.cpp)/, `${plugin}/${file} still defaults to a D:\\ path`);
    }
  }
});
