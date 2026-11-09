import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cleanKey, createOmniRoute, keyRows, saveProviderKey } from "../src/cloud-setup.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "cloud-setup-"));

test("key rows come from the router's masked keys and never carry a key", () => {
  const rows = keyRows({
    providers: {
      anthropic: { keys: [{ key: "…abcd", coolingMs: 0 }] },
      openrouter: { keys: [] },
      "opencode-free": { keys: [{ key: "…zzzz" }] },
    },
  });
  assert.deepEqual(rows.map((r) => [r.id, r.set, r.masked]), [["openrouter", false, []], ["anthropic", true, ["…abcd"]]]);
});

test("a key is one token of sane length", () => {
  assert.equal(cleanKey("  sk-or-v1-0123456789  "), "sk-or-v1-0123456789");
  assert.equal(cleanKey("short"), null);
  assert.equal(cleanKey("two words here"), null);
});

test("saving a key keeps the other providers and comments; removing takes only that one", () => {
  const dir = tmp();
  const file = join(dir, "data", "keys.json");
  mkdirSync(join(dir, "data"));
  writeFileSync(file, JSON.stringify({ $comment: "hand note", providers: { anthropic: ["sk-ant-keep"] } }));
  saveProviderKey({ keyFile: file, provider: "openrouter", key: "sk-or-new-key" });
  let doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.$comment, "hand note");
  assert.deepEqual(doc.providers, { anthropic: ["sk-ant-keep"], openrouter: ["sk-or-new-key"] });
  saveProviderKey({ keyFile: file, provider: "anthropic", key: null });
  doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.providers, { openrouter: ["sk-or-new-key"] });
  assert.throws(() => saveProviderKey({ keyFile: file, provider: "made-up", key: "x".repeat(20) }), /no key setting/);
});

test("a flat key file is moved under providers, and a missing one is created", () => {
  const dir = tmp();
  const flat = join(dir, "flat.json");
  writeFileSync(flat, JSON.stringify({ anthropic: "sk-ant-flat" }));
  saveProviderKey({ keyFile: flat, provider: "openai", key: "sk-openai-123" });
  assert.deepEqual(JSON.parse(readFileSync(flat, "utf8")).providers, { anthropic: "sk-ant-flat", openai: ["sk-openai-123"] });
  const fresh = join(dir, "new", "keys.json");
  saveProviderKey({ keyFile: fresh, provider: "google", key: "AIza-something-long" });
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")).providers, { google: ["AIza-something-long"] });
});

test("OmniRoute without Node and with no Node download for this PC says so instead of trying npm", async () => {
  const omni = createOmniRoute({ home: tmp(), nodeDir: join(tmp(), "node"), npm: () => null, canFetchNode: () => false, fetchImpl: async () => { throw new Error("down"); } });
  const result = omni.install();
  assert.equal(result.code, "no-node");
  assert.match(result.error, /nodejs\.org/);
  const status = await omni.status();
  assert.equal(status.running, false);
  assert.equal(status.installed, false);
  assert.equal(status.node, null);
});

test("OmniRoute without Node fetches Rosalena's own Node first, then runs npm through it", async () => {
  const root = tmp();
  const nodeDir = join(root, "node");
  const home = join(root, "omniroute");
  const spawned = [];
  // The fetched Node, laid out the way the official archive unpacks on this platform.
  const fetchNode = async () => {
    const windows = process.platform === "win32";
    const npmBin = windows ? join(nodeDir, "node_modules", "npm", "bin") : join(nodeDir, "lib", "node_modules", "npm", "bin");
    mkdirSync(npmBin, { recursive: true });
    mkdirSync(windows ? nodeDir : join(nodeDir, "bin"), { recursive: true });
    writeFileSync(windows ? join(nodeDir, "node.exe") : join(nodeDir, "bin", "node"), "");
    writeFileSync(join(npmBin, "npm-cli.js"), "");
  };
  const spawnImpl = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    return { pid: 1, stdout: null, stderr: null, on(event, cb) { if (event === "exit") setTimeout(() => cb(1), 5); } };
  };
  const omni = createOmniRoute({ home, nodeDir, npm: () => null, canFetchNode: () => true, fetchNode, spawnImpl, chrome: () => "chrome", fetchImpl: async () => { throw new Error("down"); } });
  assert.equal((await omni.status()).node, "download", "the page can say Node comes with the install");
  assert.equal(omni.install().ok, true);
  for (let i = 0; i < 50 && !spawned.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].cmd, /node(\.exe)?$/, "npm runs on Rosalena's node, not a PATH lookup");
  assert.match(spawned[0].args[0], /npm-cli\.js$/);
  assert.deepEqual(spawned[0].args.slice(1), ["install", "--no-fund", "--no-audit"]);
  assert.equal(spawned[0].opts.shell, false, "no shell, so a user folder with a space needs no quoting");
  const pathValue = spawned[0].opts.env.PATH ?? spawned[0].opts.env.Path;
  assert.ok(pathValue.startsWith(dirname(spawned[0].cmd)), "install scripts that call `node` find Rosalena's");
});

test("OmniRoute starts on loopback port 20128, detached, and waits until it answers", async () => {
  const home = tmp();
  mkdirSync(join(home, "node_modules", "omniroute", "bin"), { recursive: true });
  writeFileSync(join(home, "node_modules", "omniroute", "bin", "omniroute.mjs"), "");
  let up = false;
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    setTimeout(() => (up = true), 50);
    return { pid: 4242, unref() {}, on() {} };
  };
  const fetchImpl = async () => {
    if (!up) throw new Error("ECONNREFUSED");
    return new Response("{}", { status: 401 });
  };
  const omni = createOmniRoute({ home, spawnImpl, fetchImpl });
  const result = await omni.start({ waitMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(spawned[0].cmd, "node");
  assert.equal(spawned[0].opts.env.PORT, "20128");
  assert.equal(spawned[0].opts.env.HOSTNAME, "127.0.0.1", "never 0.0.0.0");
  assert.equal(spawned[0].opts.detached, true);
  assert.ok(spawned[0].args.includes("--no-open"), "never opens its dashboard in the browser");
});
