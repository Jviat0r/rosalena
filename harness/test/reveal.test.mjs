// "Show in File Explorer" is a route that starts a process on the user's desktop, so it
// is tested by stubbing the launcher: no test in this file may open a window. What is
// checked is the decision (refuse or allow), the exact argv per platform, and that a
// launcher that throws comes back as a returned error instead of an exception.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkRevealPath, revealCommand, revealInFileManager } from "../src/reveal.mjs";

/** A workspace with one real file, plus a sibling folder that must stay unreachable. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "rosalena-reveal-"));
  const workspace = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const file = join(workspace, "note.txt");
  writeFileSync(file, "hello\n");
  const folder = join(workspace, "sub");
  mkdirSync(folder);
  const secret = join(outside, "secret.txt");
  writeFileSync(secret, "nope\n");
  return { base, workspace, file, folder, secret, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A spawn stub that records calls and reports the process as created. */
function stubSpawn(events = ["spawn"]) {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    // Emitted on the next turn, the way a real ChildProcess announces itself - the
    // launcher has to be listening before the event arrives.
    setImmediate(() => {
      for (const name of events) {
        child.emit(name, name === "error" ? Object.assign(new Error("spawn explorer.exe ENOENT"), { code: "ENOENT" }) : undefined);
      }
    });
    return child;
  };
  impl.calls = calls;
  return impl;
}

test("a path outside the workspace is refused before anything is spawned", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn();
    const result = await revealInFileManager({ path: f.secret, workspace: f.workspace, platform: "win32", spawnImpl: spawn });
    assert.equal(result.ok, false);
    assert.match(result.error, /outside the workspace/);
    assert.equal(spawn.calls.length, 0, "no process may be started for a refused path");
    assert.equal(checkRevealPath({ path: f.secret, workspace: f.workspace }).ok, false);
  } finally {
    f.cleanup();
  }
});

test("a sibling folder whose name starts with the workspace name is not inside it", async () => {
  const f = fixture();
  try {
    // `…\ws-evil` shares the prefix "ws" but is not a child; a string prefix check
    // would let it through, `relative()` does not.
    const sibling = `${f.workspace}-evil`;
    mkdirSync(sibling);
    try {
      const check = checkRevealPath({ path: join(sibling, "x.txt"), workspace: f.workspace, platform: "win32" });
      assert.equal(check.ok, false);
      assert.match(check.error, /outside the workspace/);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
  }
});

test("a path that does not exist is refused, not opened at the nearest folder that does", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn();
    const result = await revealInFileManager({
      path: join(f.workspace, "never-written.txt"),
      workspace: f.workspace,
      platform: "win32",
      spawnImpl: spawn,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /does not exist/);
    assert.equal(spawn.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test("an empty path is refused rather than revealing the workspace by accident", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn();
    for (const value of ["", "   ", null, undefined]) {
      const result = await revealInFileManager({ path: value, workspace: f.workspace, platform: "win32", spawnImpl: spawn });
      assert.equal(result.ok, false);
      assert.match(result.error, /no path/);
    }
    assert.equal(spawn.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test("a workspace-relative path resolves to the real file and is accepted", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn();
    const result = await revealInFileManager({ path: "note.txt", workspace: f.workspace, platform: "win32", spawnImpl: spawn });
    assert.equal(result.ok, true);
    assert.equal(result.path, f.file);
    assert.equal(spawn.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("win32 spawns explorer.exe with /select,<path> and an argument array", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn();
    await revealInFileManager({ path: f.file, workspace: f.workspace, platform: "win32", spawnImpl: spawn });
    assert.equal(spawn.calls.length, 1);
    const [call] = spawn.calls;
    assert.equal(call.command, "explorer.exe");
    assert.deepEqual(call.args, [`/select,${f.file}`]);
    // Detached and silent: the window outlives the request and nothing is piped back.
    assert.equal(call.options.detached, true);
    assert.equal(call.options.stdio, "ignore");
  } finally {
    f.cleanup();
  }
});

test("darwin spawns open -R on the exact path", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn();
    await revealInFileManager({ path: f.file, workspace: f.workspace, platform: "darwin", spawnImpl: spawn });
    const [call] = spawn.calls;
    assert.equal(call.command, "open");
    assert.deepEqual(call.args, ["-R", f.file]);
  } finally {
    f.cleanup();
  }
});

test("linux spawns xdg-open on the containing folder for a file, and on the folder itself", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn();
    await revealInFileManager({ path: f.file, workspace: f.workspace, platform: "linux", spawnImpl: spawn });
    assert.equal(spawn.calls[0].command, "xdg-open");
    assert.deepEqual(spawn.calls[0].args, [dirname(f.file)]);

    await revealInFileManager({ path: f.folder, workspace: f.workspace, platform: "linux", spawnImpl: spawn });
    assert.deepEqual(spawn.calls[1].args, [f.folder]);
  } finally {
    f.cleanup();
  }
});

test("the command for each platform is data, not a shell string", () => {
  const odd = 'C:\\ws\\a "quoted" & name.txt';
  assert.deepEqual(revealCommand({ path: odd, platform: "win32" }), { command: "explorer.exe", args: [`/select,${odd}`] });
  assert.deepEqual(revealCommand({ path: odd, platform: "darwin" }), { command: "open", args: ["-R", odd] });
  assert.deepEqual(revealCommand({ path: odd, isDir: true, platform: "linux" }), { command: "xdg-open", args: [odd] });
});

test("a launcher that throws synchronously returns an error instead of throwing", async () => {
  const f = fixture();
  try {
    const spawn = () => {
      throw new Error("EPERM: spawn blocked");
    };
    const result = await revealInFileManager({ path: f.file, workspace: f.workspace, platform: "win32", spawnImpl: spawn });
    assert.equal(result.ok, false);
    assert.match(result.error, /could not be started/);
    assert.match(result.error, /EPERM/);
  } finally {
    f.cleanup();
  }
});

test("a launcher that reports an error event returns that error", async () => {
  const f = fixture();
  try {
    const spawn = stubSpawn(["error"]);
    const result = await revealInFileManager({ path: f.file, workspace: f.workspace, platform: "win32", spawnImpl: spawn });
    assert.equal(result.ok, false);
    assert.match(result.error, /explorer\.exe could not be started/);
    assert.match(result.error, /ENOENT/);
  } finally {
    f.cleanup();
  }
});
