// Regression checks for the 2026-11-08 folder-tab bug hunt (+ > Folder… in the sidebar):
// each one is a bug found in the running code and fixed, so it cannot quietly come back.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";

import { existingFolder, insideRoot, listFolder } from "../src/list-folder.mjs";
import { revealCommand } from "../src/reveal.mjs";
import { createUiServer } from "../src/ui.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "folder-tab-"));

test("a listing past the cap is really capped: folders first, then files, and it says so", async () => {
  const root = scratch();
  for (let i = 0; i < 4; i++) mkdirSync(join(root, `dir${i}`));
  for (let i = 0; i < 12; i++) writeFileSync(join(root, `file${i}.txt`), "x");
  const out = await listFolder(root, "", { cap: 10 });
  assert.equal(out.status, 200);
  assert.equal(out.body.truncated, true);
  assert.equal(out.body.dirs.length, 4);
  assert.equal(out.body.files.length, 6, "only cap - folders files are sent");
  assert.deepEqual(out.body.files.slice(0, 3).map((f) => f.name), ["file0.txt", "file1.txt", "file2.txt"], "numeric name order");
  const whole = await listFolder(root, "");
  assert.equal(whole.body.truncated, false);
  assert.equal(whole.body.files.length, 12);
  assert.equal(typeof whole.body.files[0].size, "number");
});

test('a folder named "..cache" is inside the root; "../x" is not', async () => {
  const root = scratch();
  mkdirSync(join(root, "..cache"));
  writeFileSync(join(root, "..cache", "a.txt"), "a");
  assert.equal(insideRoot(root, join(root, "..cache")), true);
  assert.equal(insideRoot(root, join(root, "..", "x")), false);
  assert.equal(insideRoot(root, root), true);
  const listed = await listFolder(root, "..cache");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.files.map((f) => f.name), ["a.txt"]);
  assert.equal((await listFolder(root, `..${sep}`)).status, 403);
  assert.equal((await listFolder(root, "a.txt-missing")).status, 404);
});

test("a linked folder (junction or symlink) lists as a folder, not as an unreadable file", async (t) => {
  const root = scratch();
  const target = scratch();
  writeFileSync(join(target, "inside.txt"), "hi");
  try {
    symlinkSync(target, join(root, "linked"), "junction");
  } catch (err) {
    return t.skip(`cannot make a link here: ${err.code}`);
  }
  const out = await listFolder(root, "");
  assert.deepEqual(out.body.dirs.map((d) => [d.name, d.link]), [["linked", true]]);
  assert.equal(out.body.files.length, 0);
});

test("existingFolder makes a typed path absolute and refuses what is not a folder", async () => {
  const root = scratch();
  writeFileSync(join(root, "f.txt"), "x");
  assert.equal(await existingFolder(`${root}${sep}`), root, "trailing separator dropped");
  assert.equal(await existingFolder(join(root, "f.txt")), null);
  assert.equal(await existingFolder(join(root, "nope")), null);
  assert.equal(await existingFolder("   "), null);
});

test("a folder tab's Open shows the folder itself; files are still only revealed", () => {
  assert.deepEqual(revealCommand({ path: "D:\\x", isDir: true, open: true, platform: "win32" }), { command: "explorer.exe", args: ["D:\\x"] });
  assert.deepEqual(revealCommand({ path: "/x", isDir: true, open: true, platform: "darwin" }), { command: "open", args: ["/x"] });
  assert.deepEqual(revealCommand({ path: "/x/a.txt", isDir: false, open: true, platform: "win32" }), { command: "explorer.exe", args: ["/select,/x/a.txt"] });
  assert.deepEqual(revealCommand({ path: "D:\\x", isDir: true, platform: "win32" }), { command: "explorer.exe", args: ["/select,D:\\x"] });
});

test("/api/files and /api/file read a folder tab's folder, \"..cache\" included", async () => {
  const TOKEN = "folder-tab-token-0123456789";
  const ws = scratch();
  const other = scratch();
  mkdirSync(join(other, "..cache"));
  writeFileSync(join(other, "..cache", "note.txt"), "inside");
  const ui = createUiServer({ port: 0, home: join(ws, ".home"), workspace: ws, token: TOKEN });
  const { port } = await ui.ready();
  after(() => ui.close());
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-rosalena-token": TOKEN };
  const root = encodeURIComponent(other);
  assert.equal((await fetch(`${base}/api/files?root=${root}`)).status, 403, "a folder root needs the token");
  const listed = await (await fetch(`${base}/api/files?root=${root}&path=..cache`, { headers })).json();
  assert.deepEqual(listed.files.map((f) => f.name), ["note.txt"]);
  const text = await fetch(`${base}/api/file?root=${root}&path=${encodeURIComponent(join("..cache", "note.txt"))}`, { headers });
  assert.equal(text.status, 200);
  assert.equal(await text.text(), "inside");
  const missing = await fetch(`${base}/api/files?root=${encodeURIComponent(join(other, "gone"))}`, { headers });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /^not a folder:/);
});

// The page's own path helpers, taken from app.js as written (it is a script, not a module).
function pageHelpers(sideTabs = []) {
  const source = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  const take = (name) => {
    const at = source.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `app.js has ${name}`);
    let depth = 0;
    for (let i = source.indexOf("{", at); i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) return source.slice(at, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
  };
  const context = { side: { tabs: sideTabs } };
  vm.createContext(context);
  vm.runInContext(["folderName", "parentFolder", "sameFolder", "folderLabel"].map(take).join("\n"), context);
  return context;
}

test("Up stops at the top of a drive, of / and of a network share", () => {
  const { parentFolder } = pageHelpers();
  assert.equal(parentFolder("D:\\AppDev\\Rosalena Harness"), "D:\\AppDev");
  assert.equal(parentFolder("D:\\AppDev"), "D:\\");
  assert.equal(parentFolder("D:\\"), "");
  assert.equal(parentFolder("/home/me"), "/home");
  assert.equal(parentFolder("/home"), "/");
  assert.equal(parentFolder("/"), "");
  assert.equal(parentFolder("\\\\server\\share\\docs"), "\\\\server\\share");
  assert.equal(parentFolder("\\\\server\\share"), "", "\\\\server alone is not a folder");
});

test("one folder typed two ways is one tab; two folders with one name get told apart", () => {
  const { sameFolder } = pageHelpers();
  assert.equal(sameFolder("D:\\AppDev\\Tessaly", "d:/appdev/tessaly/"), true);
  assert.equal(sameFolder("D:\\AppDev\\Tessaly", "D:\\AppDev\\Tessaly-Portfolio"), false);
  assert.equal(sameFolder("/home/Me", "/home/me"), false, "case counts off Windows");
  const tabs = ["folder:D:\\AppDev\\Rosalena Harness\\src", "folder:D:\\AppDev\\Tessaly\\src", "folder:D:\\AppDev\\Tessaly"];
  const page = pageHelpers(tabs);
  assert.equal(page.folderLabel("D:\\AppDev\\Rosalena Harness\\src"), "src (Rosalena Harness)");
  assert.equal(page.folderLabel("D:\\AppDev\\Tessaly\\src"), "src (Tessaly)");
  assert.equal(page.folderLabel("D:\\AppDev\\Tessaly"), "Tessaly");
});
