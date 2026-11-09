/**
 * A push always asks (permissions.mjs DEFAULT_RULES). It is never a local change, so
 * Workspace write used to let `git push` through without a question - and on a repo
 * whose host deploys on push, that is a deploy nobody approved. Found 2026-11-03.
 *
 *   - plain, -C and force pushes ask, in Workspace write, Full access and Auto
 *   - ordinary git commands, including ones that merely mention "push", do not
 *   - read only refuses a push outright
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { decide } from "../src/permissions.mjs";

const shell = (command) => ({ function: { name: "run_command", arguments: JSON.stringify({ command }) } });
const verdict = (command, mode) => decide({ call: shell(command), mode, root: process.cwd() });

test("every push asks, whatever the access mode lets through", () => {
  for (const command of ["git push", "git push origin main", "git push -u origin feature", "git -C ../other push", "git add . && git commit -m x && git push"]) {
    for (const mode of ["workspace", "full"]) {
      const v = verdict(command, mode);
      assert.equal(v.action, "ask", `${mode}: ${command}`);
      assert.match(v.reason, /publishes commits to the remote/);
    }
  }
  assert.match(verdict("git push --force", "workspace").reason, /rewrites the remote's history/);
});

test("ordinary git commands still run without asking", () => {
  for (const command of ["git status", "git commit -m wip", "git log --grep push", "git diff HEAD~1"]) {
    assert.equal(verdict(command, "workspace").action, "allow", command);
  }
});

test("read only refuses a push", () => {
  assert.equal(verdict("git push", "read").action, "deny");
});
