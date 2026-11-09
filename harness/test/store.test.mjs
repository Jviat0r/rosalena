// The store: an index, version pinning, install/update, integrity and refusals.
//
// Every test works in its own temp directory, because a store that installs
// into the live plugin tree during a test run would change what the next test
// (and the next session) loads. The one exception is the end-to-end test at the
// bottom, which uses the REAL shipped index - that is the artefact a user gets,
// so it is the one worth installing from.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signWith } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadPlugins } from "../src/plugins.mjs";
import {
  artifactName,
  checkId,
  hashOf,
  install,
  listTree,
  planUpdate,
  readIndex,
  readLock,
  removeModule,
  resolveVersion,
  runStore,
  safeRel,
  stableStringify,
  storeIndexPath,
  trustIndex,
  verifyInstalled,
} from "../src/store.mjs";
import { buildIndex } from "../store/build-index.mjs";

const temp = (label) => mkdtempSync(join(tmpdir(), `rosalena-${label}-`));

// ESM caches a module by URL, so a process that has already imported a plugin
// file keeps the old copy after an update. That is why the store says a change
// "loads on the next run", and why the end-to-end test asks a fresh process what
// it sees rather than asserting it in this one.
const HARNESS = fileURLToPath(new URL("..", import.meta.url));
const PROBE = join(temp("probe"), "probe.mjs");
writeFileSync(
  PROBE,
  [
    `import { loadPlugins } from ${JSON.stringify(pathToFileURL(join(HARNESS, "src/plugins.mjs")).href)};`,
    "const dir = process.argv[2];",
    "const host = await loadPlugins({ root: dir, dir, log: () => {} });",
    "process.stdout.write(JSON.stringify(host.plugins.map((p) => ({ id: p.id, version: p.version, commands: p.commands.length, tools: p.tools.length }))));",
    "",
  ].join("\n"),
);

const writeModule = (root, id, version, files) => {
  const dir = join(root, `modules/${id}/${version}`);
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(dir, rel), text);
  return dir;
};

const PLUGIN_TEXT = `export default { id: "probe", description: "a test module", tools: () => [], commands: () => ({ ping: () => "pong" }) };\n`;
const singleFileText = (id) => `export default { id: "${id}", description: "a single-file test module", tools: () => [] };\n`;
const MANIFEST_TEXT = (id, version) => `${JSON.stringify({ id, version, description: `${id} ${version}`, config: {} }, null, 2)}\n`;

/** A store on disk: index.json plus modules/<id>/<version>/… */
function makeStore({ id = "probe", versions = ["1.0.0"], extra = {} } = {}) {
  const store = temp("store");
  const files = { "plugin.json": MANIFEST_TEXT(id, versions[0]), "plugin.mjs": PLUGIN_TEXT };
  for (const version of versions) {
    writeModule(store, id, version, {
      "plugin.json": MANIFEST_TEXT(id, version),
      "plugin.mjs": `${PLUGIN_TEXT}// ${id} ${version}\n`,
      ...extra,
    });
  }
  writeFileSync(join(store, "index.json"), `${JSON.stringify(buildIndex({ modulesDir: join(store, "modules") }), null, 2)}\n`);
  return { store, indexPath: join(store, "index.json"), modulesDir: join(store, "modules"), files };
}

// ------------------------------------------------------------------- the index

test("an index built from disk lists every version with a hash per file", () => {
  const { indexPath, store } = makeStore({ versions: ["1.0.0", "1.1.0"] });
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(index.modules.probe.versions), ["1.0.0", "1.1.0"]);
  assert.equal(index.modules.probe.latest, "1.1.0", "latest is the highest version present");
  const entry = index.modules.probe.versions["1.0.0"];
  assert.equal(entry.shape, "folder");
  assert.deepEqual(Object.keys(entry.files).sort(), ["plugin.json", "plugin.mjs"]);
  for (const [rel, hash] of Object.entries(entry.files)) {
    assert.equal(hash, hashOf(readFileSync(join(store, "modules/probe/1.0.0", rel))), `${rel} hash matches the file on disk`);
  }
});

test("the builder refuses a module that is neither a folder nor a single file", () => {
  const store = temp("badshape");
  mkdirSync(join(store, "modules/odd/1.0.0"), { recursive: true });
  writeFileSync(join(store, "modules/odd/1.0.0/one.mjs"), "export default {};\n");
  writeFileSync(join(store, "modules/odd/1.0.0/two.mjs"), "export default {};\n");
  assert.throws(() => buildIndex({ modulesDir: join(store, "modules") }), /neither a folder module .* nor a single-file module/);

  // A manifest whose id or version disagrees with its folder is a publishing
  // mistake, so it is refused rather than shipped.
  const mismatch = temp("mismatch");
  writeModule(mismatch, "odd", "1.0.0", { "plugin.json": MANIFEST_TEXT("other", "1.0.0"), "plugin.mjs": PLUGIN_TEXT });
  assert.throws(() => buildIndex({ modulesDir: join(mismatch, "modules") }), /declares id "other"/);
  const wrongVersion = temp("wrongversion");
  writeModule(wrongVersion, "odd", "1.0.0", { "plugin.json": MANIFEST_TEXT("odd", "9.9.9"), "plugin.mjs": PLUGIN_TEXT });
  assert.throws(() => buildIndex({ modulesDir: join(wrongVersion, "modules") }), /declares version "9.9.9"/);
});

test("version resolution pins an exact version and defaults to latest", async () => {
  const { indexPath } = makeStore({ versions: ["1.0.0", "1.2.0", "1.10.0"] });
  const { index } = await readIndex(indexPath);
  assert.equal(resolveVersion(index, "probe").version, "1.10.0", "1.10.0 sorts above 1.2.0, so version order is numeric");
  assert.equal(resolveVersion(index, "probe", "1.0.0").version, "1.0.0");
  assert.equal(resolveVersion(index, "probe", "1.0.0").latest, false);
  assert.throws(() => resolveVersion(index, "probe", "2.0.0"), /no version 2\.0\.0 \(the index has 1\.0\.0, 1\.2\.0, 1\.10\.0\)/);
  assert.throws(() => resolveVersion(index, "nope"), /no module named "nope"/);
});

test("a local index may be unsigned; a remote one may not", () => {
  const local = trustIndex({ index: { modules: {} }, remote: false });
  assert.equal(local.ok, true);
  assert.match(local.reason, /unsigned/);
  const remote = trustIndex({ index: { modules: {} }, remote: true });
  assert.equal(remote.ok, false);
  assert.match(remote.reason, /remote index must be signed/);
});

test("an ed25519 signature over the index is verified, and a trusted key is enforced", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { indexPath } = makeStore({ versions: ["1.0.0"] });
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const signIndex = (body) => ({
    ...body,
    signature: { alg: "ed25519", publicKey: spki, value: signWith(null, Buffer.from(stableStringify(body), "utf8"), privateKey).toString("base64") },
  });

  const good = signIndex(index);
  assert.equal(trustIndex({ index: good, trustedKeys: [spki] }).ok, true);
  assert.match(trustIndex({ index: good, trustedKeys: [spki] }).reason, /trusted key/);
  assert.equal(trustIndex({ index: good, trustedKeys: [spki] }).trusted, true);

  // Signed by a key the user never listed: the signature is real, the author is
  // not accepted.
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const notMine = trustIndex({ index: good, trustedKeys: [other] });
  assert.equal(notMine.ok, false);
  assert.equal(notMine.verified, true);
  assert.equal(notMine.trusted, false);
  assert.match(notMine.reason, /not by any key in store\.trustedKeys/);

  // The classic attack: keep the signature, change a hash.
  const edited = { ...good, modules: { ...good.modules, sneaky: { latest: "1.0.0", versions: { "1.0.0": { shape: "file", source: "x", files: { "x.mjs": "0".repeat(64) } } } } } };
  const tampered = trustIndex({ index: edited, trustedKeys: [spki] });
  assert.equal(tampered.ok, false);
  assert.match(tampered.reason, /does not match the index/);

  const weak = trustIndex({ index: { modules: {}, signature: { alg: "rot13", publicKey: spki, value: "x" } } });
  assert.equal(weak.ok, false);
  assert.match(weak.reason, /unsupported signature algorithm/);
  const garbage = trustIndex({ index: { modules: {}, signature: { alg: "ed25519", publicKey: "not-a-key", value: "x" } } });
  assert.equal(garbage.ok, false);
  assert.match(garbage.reason, /could not be checked/);
});

// ------------------------------------------------------------------- guarding

test("an id or a file path that could escape the plugins directory is refused", () => {
  for (const id of ["../evil", "a/b", "", ".", "..", "x\u0000y", "with space"]) {
    assert.throws(() => checkId(id), /is not a usable module id/, `${JSON.stringify(id)} must be refused`);
  }
  for (const id of ["clock", "my-module", "a.b_c", "X9"]) assert.equal(checkId(id), id);

  for (const rel of ["../outside.mjs", "a/../../b.mjs", "/etc/passwd", "C:/Windows/x.mjs", "\\\\server\\share\\x.mjs", ""]) {
    assert.throws(() => safeRel(rel), /(steps outside|absolute path|anchored at the filesystem root|empty file path)/, `${JSON.stringify(rel)} must be refused`);
  }
  assert.equal(safeRel("lib\\deep\\thing.mjs"), "lib/deep/thing.mjs", "a safe path is normalised to forward slashes");
});

test("an index that tries to write outside the module is refused before anything is written", async () => {
  const { store, indexPath } = makeStore({ versions: ["1.0.0"] });
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const pluginsDir = temp("plugins");
  const entry = index.modules.probe.versions["1.0.0"];
  index.modules.probe.versions["1.0.0"] = { ...entry, files: { ...entry.files, "../escape.mjs": hashOf(Buffer.from("x")) } };
  await assert.rejects(
    () => install({ id: "probe", index, source: { kind: "local", base: store, label: "test" }, pluginsDir }),
    /steps outside the module/,
  );
  assert.equal(existsSync(join(pluginsDir, "probe")), false);
  assert.equal(existsSync(join(pluginsDir, "..", "escape.mjs")), false);
});

// ----------------------------------------------------------------- installing

test("a hash that does not match the index stops the install and leaves nothing behind", async () => {
  const { store, indexPath } = makeStore({ versions: ["1.0.0"] });
  const { index, source } = await readIndex(indexPath);
  const pluginsDir = temp("plugins");
  // The file on disk is edited after the index was built - the exact case the
  // hashes exist for.
  writeFileSync(join(store, "modules/probe/1.0.0/plugin.mjs"), `${PLUGIN_TEXT}// edited after publishing\n`);
  await assert.rejects(
    () => install({ id: "probe", index, source, pluginsDir }),
    /does not match the index:[\s\S]*index says [0-9a-f]{64}[\s\S]*the file is [0-9a-f]{64}/,
  );
  assert.equal(existsSync(join(pluginsDir, "probe")), false, "no plugin directory");
  assert.equal(existsSync(join(pluginsDir, "store.lock.json")), false, "no lock entry");
  assert.deepEqual(listTree(pluginsDir), [], "and no staging directory left over");
});

test("install, pin, verify, force-replace and remove, with a lock that records what came from where", async () => {
  const { store, indexPath } = makeStore({ versions: ["1.0.0", "1.1.0"] });
  const { index, source } = await readIndex(indexPath);
  const pluginsDir = temp("plugins");

  const first = await install({ id: "probe", index, source, pluginsDir });
  assert.equal(first.version, "1.1.0", "installing with no version pins latest");
  assert.equal(first.replaced, false);
  assert.deepEqual(first.files.sort(), ["probe/plugin.json", "probe/plugin.mjs"]);
  assert.equal(readLock(pluginsDir).modules.probe.version, "1.1.0");
  assert.equal(readLock(pluginsDir).modules.probe.index, source.label);

  // Pinning an older version is how you go back.
  const pinned = await install({ id: "probe", version: "1.0.0", index, source, pluginsDir, force: true });
  assert.equal(pinned.version, "1.0.0");
  assert.equal(pinned.replaced, true);
  assert.match(readFileSync(join(pluginsDir, "probe/plugin.mjs"), "utf8"), /probe 1\.0\.0/, "the pinned version is the one on disk");
  assert.equal(readLock(pluginsDir).modules.probe.version, "1.0.0");

  // Replacing without --force is refused, and says which version is there.
  await assert.rejects(() => install({ id: "probe", index, source, pluginsDir }), /"probe" 1\.0\.0 is already installed; use --force/);

  const intact = verifyInstalled("probe", { pluginsDir });
  assert.equal(intact.ok, true);
  assert.equal(intact.files, 2);

  // A hand edit after install is exactly what verify is for.
  writeFileSync(join(pluginsDir, "probe/plugin.mjs"), `${PLUGIN_TEXT}// tampered\n`);
  const tampered = verifyInstalled("probe", { pluginsDir });
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.changed, ["probe/plugin.mjs"]);
  assert.deepEqual(tampered.missing, []);

  // An extra file nobody installed is drift too.
  writeFileSync(join(pluginsDir, "probe/extra.mjs"), "export default {};\n");
  assert.deepEqual(verifyInstalled("probe", { pluginsDir }).untracked, ["probe/extra.mjs"]);

  // A forced reinstall replaces the whole directory, so the tampered file comes
  // back and the extra one goes. That is what --force means, and it is also how
  // drift is cleaned up.
  await install({ id: "probe", version: "1.0.0", index, source, pluginsDir, force: true });
  const restored = verifyInstalled("probe", { pluginsDir });
  assert.equal(restored.ok, true);
  assert.deepEqual(listTree(join(pluginsDir, "probe")), ["plugin.json", "plugin.mjs"]);

  const removed = removeModule("probe", { pluginsDir });
  assert.equal(removed.wasVersion, "1.0.0");
  assert.equal(existsSync(join(pluginsDir, "probe")), false);
  assert.deepEqual(readLock(pluginsDir).modules, {}, "the lock forgets it too");
  assert.throws(() => removeModule("probe", { pluginsDir }), /is not installed/);
});

test("a module has to declare a manifest to be installed as a folder", async () => {
  const store = temp("nomanifest");
  writeModule(store, "naked", "1.0.0", { "naked.mjs": singleFileText("naked") });
  writeFileSync(join(store, "index.json"), `${JSON.stringify(buildIndex({ modulesDir: join(store, "modules") }), null, 2)}\n`);
  const { index, source } = await readIndex(join(store, "index.json"));
  assert.equal(index.modules.naked.versions["1.0.0"].shape, "file", "one .mjs named after the module is the single-file shape");
  const pluginsDir = temp("plugins");
  const result = await install({ id: "naked", index, source, pluginsDir });
  assert.equal(result.shape, "file");
  assert.equal(result.files.length, 1);
  assert.equal(existsSync(join(pluginsDir, "naked.mjs")), true, "a single-file module lands as <id>.mjs");
  assert.equal(verifyInstalled("naked", { pluginsDir }).ok, true);
});

test("a bundled plugin is never overwritten or removed without --force", async () => {
  const pluginsDir = temp("plugins");
  mkdirSync(join(pluginsDir, "first-party"));
  writeFileSync(join(pluginsDir, "first-party/plugin.json"), `${JSON.stringify({ id: "first-party", version: "1.0.0", bundled: true }, null, 2)}\n`);
  const { indexPath } = makeStore({ id: "first-party", versions: ["2.0.0"] });
  const { index, source } = await readIndex(indexPath);
  assert.equal(source.kind, "local");

  await assert.rejects(
    () => install({ id: "first-party", index, source, pluginsDir, force: false }),
    /is a bundled plugin - refusing to overwrite/,
  );
  assert.match(readFileSync(join(pluginsDir, "first-party/plugin.json"), "utf8"), /"version": "1\.0\.0"/, "the bundled plugin is untouched");
  assert.throws(() => removeModule("first-party", { pluginsDir }), /is a bundled plugin - refusing to remove/);
  assert.equal(existsSync(join(pluginsDir, "first-party")), true);

  // With --force it does overwrite, because the user asked for exactly that.
  const result = await install({ id: "first-party", index, source, pluginsDir, force: true });
  assert.equal(result.version, "2.0.0");
  assert.equal(readLock(pluginsDir).modules["first-party"].version, "2.0.0");
});

test("a plugin the store did not install is not deleted by remove", () => {
  const pluginsDir = temp("plugins");
  mkdirSync(join(pluginsDir, "handmade"));
  writeFileSync(join(pluginsDir, "handmade/plugin.json"), `${JSON.stringify({ id: "handmade" }, null, 2)}\n`);
  assert.throws(() => removeModule("handmade", { pluginsDir }), /was not installed by the store/);
  assert.equal(existsSync(join(pluginsDir, "handmade")), true);
  assert.equal(removeModule("handmade", { pluginsDir, force: true }).wasVersion, null);
  assert.equal(existsSync(join(pluginsDir, "handmade")), false);
});

test("update moves an old install to the index's latest and reports what it skipped", async () => {
  const { store, indexPath } = makeStore({ versions: ["1.0.0", "1.1.0"] });
  const { index, source } = await readIndex(indexPath);
  const pluginsDir = temp("plugins");
  await install({ id: "probe", version: "1.0.0", index, source, pluginsDir });

  assert.deepEqual(
    planUpdate({ index, pluginsDir }).map((a) => [a.id, a.action, a.from, a.to]),
    [["probe", "update", "1.0.0", "1.1.0"]],
  );
  const output = await runStore("update", [], { pluginsDir, indexPath });
  assert.match(output, /probe: 1\.0\.0 -> 1\.1\.0/);
  assert.equal(readLock(pluginsDir).modules.probe.version, "1.1.0");
  assert.deepEqual(planUpdate({ index, pluginsDir }).map((a) => a.action), ["current"]);
  assert.match(await runStore("update", [], { pluginsDir, indexPath }), /probe: already at the newest version/);
  assert.match(await runStore("update", ["gone"], { pluginsDir, indexPath }), /gone: not installed by the store/);

  // A module the index has dropped is reported, never silently removed.
  const emptyish = { modules: {} };
  assert.deepEqual(planUpdate({ index: emptyish, pluginsDir }).map((a) => a.action), ["gone"]);
});

// -------------------------------------------------------------- remote indexes

test("a remote index is fetched, must be signed by a trusted key, and installs over http", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const { store } = makeStore({ versions: ["1.0.0"] });
  const indexPath = join(store, "index.json");
  const base = JSON.parse(readFileSync(indexPath, "utf8"));
  const signed = { ...base, signature: { alg: "ed25519", publicKey: spki, value: signWith(null, Buffer.from(stableStringify(base), "utf8"), privateKey).toString("base64") } };
  writeFileSync(indexPath, `${JSON.stringify(signed, null, 2)}\n`);

  // One tiny server stands in for a registry: the index and the module files.
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.replace(/^\/+/, ""));
    const file = join(store, rel);
    if (!existsSync(file) || rel.includes("..")) {
      res.writeHead(404).end("no");
      return;
    }
    res.writeHead(200).end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/index.json`;
  try {
    const pluginsDir = temp("plugins");
    // No trusted keys configured: a signed index is accepted, authorship is not.
    const unverified = await runStore("install", ["probe"], { pluginsDir, indexPath: url, config: {} });
    assert.match(unverified, /installed probe 1\.0\.0/);
    assert.match(unverified, /unsigned|signed, but store\.trustedKeys is empty/);
    assert.equal(existsSync(join(pluginsDir, "probe/plugin.mjs")), true);

    // A key that is not the signer is refused outright.
    await assert.rejects(
      () => runStore("install", ["probe", "--force"], { pluginsDir, indexPath: url, config: { trustedKeys: ["not-the-signer"] } }),
      /refusing to install from this index: the index is signed, but not by any key in store\.trustedKeys/,
    );
    // The right key installs.
    const trusted = await runStore("install", ["probe", "--force"], { pluginsDir, indexPath: url, config: { trustedKeys: [spki] } });
    assert.match(trusted, /index trust: signed by a trusted key/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test("a remote index that is not signed is refused before a single byte is trusted", async () => {
  const { store } = makeStore({ versions: ["1.0.0"] });
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(join(store, "index.json"))));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/index.json`;
  try {
    const pluginsDir = temp("plugins");
    await assert.rejects(() => runStore("install", ["probe"], { pluginsDir, indexPath: url }), /refusing to install from this index: a remote index must be signed/);
    assert.equal(existsSync(join(pluginsDir, "probe")), false);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

// ------------------------------------------------------------ the CLI surface

test("the store surfaces report the index, the catalogue and the trust verdict", async () => {
  const { store, indexPath } = makeStore({ versions: ["1.0.0", "1.1.0"] });
  const pluginsDir = temp("plugins");

  const list = await runStore("list", [], { pluginsDir, indexPath });
  assert.match(list, /store rosalena-store - 1 module\(s\)/);
  assert.match(list, /probe\s+1\.1\.0\s+not installed/);
  assert.match(list, /versions: 1\.0\.0, 1\.1\.0/);
  assert.match(list, /trust\s+unsigned \(a local file you supply yourself\)/);

  const indexInfo = await runStore("index", [], { pluginsDir, indexPath });
  assert.match(indexInfo, /kind\s+local/);
  assert.match(indexInfo, /keys\s+none configured \(store\.trustedKeys\)/);

  const info = await runStore("info", ["probe"], { pluginsDir, indexPath });
  assert.match(info, /probe 1\.1\.0 \(latest\)/);
  assert.match(info, /shape\s+folder \(a folder with plugin\.json\)/);
  assert.match(info, /state\s+not installed/);
  assert.match(info, /install\s+--store "install probe"/);

  const pinnedInfo = await runStore("info", ["probe", "1.0.0"], { pluginsDir, indexPath });
  assert.match(pinnedInfo, /probe 1\.0\.0\n/);
  assert.match(pinnedInfo, /state\s+not installed/);

  const installed = await runStore("install", ["probe"], { pluginsDir, indexPath });
  assert.match(installed, /installed probe 1\.1\.0 \(folder, 2 file\(s\)\)/);
  assert.match(installed, /it loads on the next run/);
  assert.match(await runStore("list", [], { pluginsDir, indexPath }), /probe\s+1\.1\.0\s+installed 1\.1\.0/);
  assert.match(await runStore("verify", [], { pluginsDir, indexPath }), /probe 1\.1\.0: intact[\s\S]*all store modules intact/);
  assert.match(await runStore("verify", ["nobody"], { pluginsDir, indexPath }), /not installed by the store/);
  assert.match(await runStore("remove", ["probe"], { pluginsDir, indexPath }), /removed probe 1\.1\.0/);
  assert.match(await runStore("verify", [], { pluginsDir, indexPath }), /nothing installed by the store/);

  await assert.rejects(() => runStore("list", [], { pluginsDir, indexPath: join(store, "nope.json") }), /no store index at/);
  await assert.rejects(() => runStore("nonsense", [], { pluginsDir, indexPath }), /unknown store command "nonsense"/);
  await assert.rejects(() => runStore("install", [], { pluginsDir, indexPath }), /usage: --store "install <module>/);
  await assert.rejects(() => runStore("install", ["probe@9.9.9"], { pluginsDir, indexPath }), /has no version 9\.9\.9/);
});

test("a broken index is reported as a broken index, not as a crash", async () => {
  const dir = temp("broken");
  const indexPath = join(dir, "index.json");
  writeFileSync(indexPath, "{ this is not json");
  await assert.rejects(() => runStore("list", [], { indexPath }), /is not readable JSON/);
  writeFileSync(indexPath, JSON.stringify({ name: "empty" }));
  await assert.rejects(() => runStore("list", [], { indexPath }), /has no "modules" object/);
  writeFileSync(indexPath, JSON.stringify({ version: 1, name: "x", modules: { probe: { description: "no versions" } } }));
  await assert.rejects(() => runStore("install", ["probe"], { indexPath }), /"probe" has no versions/);
});

// ------------------------------------------------- the real index, end to end

test("the shipped index installs a module the host then loads, and removes it again", async () => {
  // This is the only test that touches the live plugin directory, and it puts
  // it back exactly as it found it.
  const pluginsDir = temp("live");
  const indexPath = storeIndexPath();
  assert.ok(existsSync(indexPath), "the harness ships a store index");

  const before = (await loadPlugins({ root: pluginsDir, dir: pluginsDir, log: () => {} })).plugins.map((p) => p.id);
  assert.deepEqual(before, [], "an empty plugins directory loads nothing");

  const listed = await runStore("list", [], { pluginsDir, indexPath });
  assert.match(listed, /clock/);
  assert.match(listed, /scratchpad/);

  const folder = await runStore("install", ["clock@1.0.0"], { pluginsDir, indexPath });
  assert.match(folder, /installed clock 1\.0\.0 \(folder, 2 file\(s\)\)/);
  const single = await runStore("install", ["scratchpad"], { pluginsDir, indexPath });
  assert.match(single, /installed scratchpad 1\.0\.0 \(file, 1 file\(s\)\)/);
  assert.match(single, /carries no manifest, so \/plugins shows it as v0\.0\.0/);

  // The host is the real judge: it must find both, and run what they export.
  const host = await loadPlugins({ root: pluginsDir, dir: pluginsDir, log: () => {} });
  assert.deepEqual(host.plugins.map((p) => p.id).sort(), ["clock", "scratchpad"]);
  const clock = host.plugins.find((p) => p.id === "clock");
  assert.equal(clock.version, "1.0.0");
  assert.equal(clock.bundled, false, "an installed module is not a bundled one");
  assert.equal(clock.commands.length, 1, "clock 1.0.0 has one command");
  const scratchpad = host.plugins.find((p) => p.id === "scratchpad");
  assert.equal(scratchpad.tools.length, 2);

  // Update pins the new version. This process cannot show the new surface - it
  // already imported the 1.0.0 file - so a fresh process is the proof that the
  // change is real and not just a lock entry.
  assert.match(await runStore("update", [], { pluginsDir, indexPath }), /clock: 1\.0\.0 -> 1\.1\.0/);
  assert.match(readFileSync(join(pluginsDir, "clock/plugin.json"), "utf8"), /"version": "1\.1\.0"/);
  const observed = JSON.parse(execFileSync(process.execPath, [PROBE, pluginsDir], { encoding: "utf8" }));
  assert.deepEqual(observed.find((p) => p.id === "clock"), { id: "clock", version: "1.1.0", commands: 2, tools: 1 }, "clock 1.1.0 added /clock zones");

  assert.match(await runStore("verify", [], { pluginsDir, indexPath }), /all store modules intact/);
  assert.match(await runStore("remove", ["clock"], { pluginsDir, indexPath }), /removed clock 1\.1\.0/);
  assert.match(await runStore("remove", ["scratchpad"], { pluginsDir, indexPath }), /removed scratchpad/);
  assert.deepEqual((await loadPlugins({ root: pluginsDir, dir: pluginsDir, log: () => {} })).plugins, []);
  rmSync(pluginsDir, { recursive: true, force: true });
});

test("the installed artefact name is the one the host discovers", () => {
  assert.equal(artifactName("clock", "folder"), "clock");
  assert.equal(artifactName("clock", "file"), "clock.mjs");
  assert.equal(hashOf(Buffer.from("abc")), createHash("sha256").update("abc").digest("hex"));
});
