// Desktop control: off unless asked for, looking is a read, acting asks or is refused.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { keyCodes } from "../src/desktop-actions.mjs";
import { DESKTOP_TOOLS } from "../src/desktop.mjs";
import { decide } from "../src/permissions.mjs";
import { createTools } from "../src/tools.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "ros-desktop-"));
const call = (name, args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });
const names = (tools) => Object.keys(tools.byName ?? tools.handlers ?? tools).filter((n) => n.startsWith("desktop_"));

test("the desktop tools exist only when desktop control is on", () => {
  const off = createTools({ root: ROOT });
  const on = createTools({ root: ROOT, desktop: true });
  const list = (t) => (Array.isArray(t.schemas) ? t.schemas.map((s) => s.function?.name ?? s.name) : names(t)).filter((n) => String(n).startsWith("desktop_"));
  assert.deepEqual(list(off), []);
  assert.deepEqual(list(on).sort(), [...DESKTOP_TOOLS].sort());
});

test("looking at the screen is a read; acting asks in Workspace write", () => {
  for (const name of ["desktop_screenshot", "desktop_zoom", "desktop_windows", "desktop_wait"]) {
    assert.equal(decide({ call: call(name), mode: "workspace", root: ROOT }).action, "allow", name);
    assert.equal(decide({ call: call(name), mode: "read", root: ROOT }).action, "allow", `${name} in read only`);
  }
  for (const name of ["desktop_move", "desktop_click", "desktop_drag", "desktop_scroll", "desktop_type", "desktop_key"]) {
    assert.equal(decide({ call: call(name, { x: 1, y: 1 }), mode: "workspace", root: ROOT }).action, "ask", name);
    assert.equal(decide({ call: call(name, { x: 1, y: 1 }), mode: "read", root: ROOT }).action, "deny", `${name} in read only`);
    assert.equal(decide({ call: call(name, { x: 1, y: 1 }), mode: "full", root: ROOT }).action, "allow", `${name} in full access`);
  }
});

test("shortcut names become virtual-key codes, and a typo is refused", () => {
  assert.deepEqual(keyCodes("ctrl+shift+s"), [0x11, 0x10, 0x53]);
  assert.deepEqual(keyCodes("F5"), [0x74]);
  assert.deepEqual(keyCodes("alt + f4"), [0x12, 0x73]);
  assert.throws(() => keyCodes("ctrl+banana"), /unknown key/);
  assert.throws(() => keyCodes(""), /empty/);
});
