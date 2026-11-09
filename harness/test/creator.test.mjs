// UI plugins, the verifier and Creator mode's draft -> verify -> publish -> rollback path.
//
// The promise Creator mode makes is that nothing a model writes reaches the sidebar
// unverified, and nothing installed is ever lost. So these tests try to break it: unsafe
// manifests and code, a page that reaches for the API or the network, a draft edited after
// it passed, a path that escapes the draft, a rollback, a rollback of the rollback.
//
// The runtime half needs the checkout's Electron (desktop/node_modules). Without it those
// tests are skipped and say so; the static and filesystem tests still run.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCreator, templateFiles } from "../src/creator.mjs";
import { findElectron, fingerprint, staticCheck, verifyPlugin } from "../src/plugin-verify.mjs";
import { loadPlugins } from "../src/plugins.mjs";
import { insideFolder, listUiPlugins, pluginCsp, readUiManifest, servePluginRequest } from "../src/ui-plugins.mjs";

const electron = findElectron();
const needsElectron = electron ? {} : { skip: "no Electron in desktop/node_modules (ROSALENA_ELECTRON not set)" };

function tempDir(prefix = "rosalena-creator-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A plugin folder from a map of files. */
function makePlugin(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

function templatePlugin(dir, overrides = {}) {
  return makePlugin(dir, { ...templateFiles({ id: "sample", title: "Sample", description: "a test plugin" }), ...overrides });
}

// ------------------------------------------------------------------ manifests and paths

test("insideFolder refuses every way out of a plugin folder", () => {
  const base = tempDir();
  assert.equal(insideFolder(base, "../x"), null);
  assert.equal(insideFolder(base, "a/../../x"), null);
  assert.equal(insideFolder(base, "/etc/passwd"), null);
  assert.equal(insideFolder(base, "C:/Windows/win.ini"), null);
  assert.equal(insideFolder(base, ""), null);
  assert.ok(insideFolder(base, "app/index.html"));
});

test("a UI manifest is checked: id, version, title, page, permissions and libraries", () => {
  const dir = makePlugin(tempDir(), {
    "plugin.json": { id: "Bad Id", version: "1", ui: { title: "", page: "../outside.html", permissions: ["network"], libs: ["jquery"] } },
  });
  const { manifest, problems } = readUiManifest(dir);
  assert.ok(manifest);
  const text = problems.join("\n");
  for (const fragment of ["id \"Bad Id\"", "version", "ui.title", "inside the plugin folder", 'unknown permission "network"', 'unknown library "jquery"']) {
    assert.ok(text.includes(fragment), `expected a problem mentioning ${fragment}:\n${text}`);
  }
});

test("a plugin without a ui block is not a UI plugin, and the template is a valid one", () => {
  const plain = makePlugin(tempDir(), { "plugin.json": { id: "backend-only", version: "1.0.0" } });
  assert.equal(readUiManifest(plain).manifest, null);
  const good = templatePlugin(tempDir());
  const { manifest, problems } = readUiManifest(good);
  assert.deepEqual(problems, []);
  assert.equal(manifest.page, "app/index.html");
});

test("a user plugin may not take the id of a bundled one", () => {
  const bundled = tempDir();
  const user = tempDir();
  templatePlugin(join(bundled, "sample"));
  templatePlugin(join(user, "sample"));
  const list = listUiPlugins({ bundledDir: bundled, userDir: user });
  const mine = list.find((p) => p.source === "user");
  assert.equal(mine.ok, false);
  assert.match(mine.problems.join(" "), /ships with the app/);
});

test("a page-only plugin loads in the backend host as a listed page, not a failure", async () => {
  const dir = tempDir();
  templatePlugin(join(dir, "sample"));
  const host = await loadPlugins({ dir });
  assert.deepEqual(host.errors, []);
  assert.equal(host.plugins[0].status, "a page in the sidebar");
});

// ------------------------------------------------------------------ serving

async function serve(plugins) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (!(await servePluginRequest(req, res, path, { plugins }))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("plugin files are served with a CSP that allows only the plugin, the libraries and the SDK", async () => {
  const bundled = tempDir();
  templatePlugin(join(bundled, "sample"));
  const plugins = listUiPlugins({ bundledDir: bundled });
  const { server, base } = await serve(plugins);
  try {
    const page = await fetch(`${base}/plugin-app/sample/app/index.html`);
    assert.equal(page.status, 200);
    const csp = page.headers.get("content-security-policy");
    assert.equal(csp, pluginCsp(base, "sample"));
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src \S+\/plugin-app\/sample\/ /);
    assert.doesNotMatch(csp, /\/api/);
    assert.equal(page.headers.get("access-control-allow-origin"), "*");

    assert.equal((await fetch(`${base}/plugin-app/sample/plugin.json`)).status, 404, "the manifest is not a page asset");
    assert.equal((await fetch(`${base}/plugin-app/sample/..%2F..%2Fpackage.json`)).status, 404, "an encoded traversal is refused");
    assert.equal((await fetch(`${base}/plugin-app/other/app/index.html`)).status, 404);
    assert.equal((await fetch(`${base}/plugin-lib/three/not-listed.js`)).status, 404, "a library file must be named in lib.json");
    assert.equal((await fetch(`${base}/plugin-lib/three/three.module.js`)).status, 200);
    assert.equal((await fetch(`${base}/plugin-sdk.js`)).status, 200);
  } finally {
    server.close();
  }
});

test("a switched-off plugin is not served", async () => {
  const bundled = tempDir();
  templatePlugin(join(bundled, "sample"));
  const plugins = listUiPlugins({ bundledDir: bundled, state: { sample: { enabled: false } } });
  assert.equal(plugins[0].enabled, false);
  const { server, base } = await serve(plugins);
  try {
    assert.equal((await fetch(`${base}/plugin-app/sample/app/index.html`)).status, 404);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ static verification

test("the template passes every static check", () => {
  const report = staticCheck(templatePlugin(tempDir()));
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
});

test("static checks fail remote URLs, unsafe code, undeclared permissions and libraries, and a missing SDK", () => {
  const dir = templatePlugin(tempDir(), {
    "app/index.html": `<!doctype html><html><body><script src="https://cdn.example.com/x.js"></script><script type="module" src="app.js"></script></body></html>`,
    "app/app.js": `eval("1"); window.top.location = "x"; await Rosalena.storage.set("a", 1); import("/plugin-lib/three/three.module.js");`,
  });
  const report = staticCheck(dir);
  const failed = Object.fromEntries(report.checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
  assert.ok(failed["loads the SDK"] !== undefined);
  assert.match(failed["no remote URLs"], /cdn\.example\.com/);
  assert.match(failed["no unsafe code"], /eval/);
  assert.match(failed["no unsafe code"], /app's window/);
  assert.match(failed["permissions declared"], /storage/);
  assert.match(failed["libraries declared"], /three/);
  assert.match(failed["signals ready"], /Rosalena\.ready/);
  assert.match(failed["has self-tests"], /Rosalena\.test/);
});

test("the fingerprint changes when any byte changes", () => {
  const dir = templatePlugin(tempDir());
  const before = fingerprint(dir);
  writeFileSync(join(dir, "app/style.css"), `${readFileSync(join(dir, "app/style.css"), "utf8")} `);
  assert.notEqual(fingerprint(dir), before);
});

// ------------------------------------------------------------------ runtime verification

test("runtime: the template plugin passes in a real sandboxed page", needsElectron, async () => {
  const report = await verifyPlugin(templatePlugin(tempDir()), { reportDir: tempDir("rosalena-reports-") });
  assert.equal(report.ok, true, JSON.stringify(report.runtime, null, 2));
  assert.equal(report.runtime.ready, true);
  // The SDK's own "every visible control can be clicked" check, then the template's test.
  assert.equal(report.runtime.tests.length, 2);
  assert.equal(report.runtime.tests[0].name, "every visible control can be clicked");
  assert.equal(report.runtime.blank, false);
  assert.ok(existsSync(report.runtime.screenshot));
});

test("runtime: a page that reaches for the API, the network or the app window is caught", needsElectron, async () => {
  // Static checks would refuse this code outright, so the runtime half is called directly:
  // it is the second lock, and it has to hold on its own.
  const { runtimeCheck } = await import("../src/plugin-verify.mjs");
  const dir = templatePlugin(tempDir(), {
    "app/app.js": `
      Rosalena.test("the sandbox holds", async () => {
        let api = "reachable";
        try { const r = await fetch("/api/health"); api = "status " + r.status; } catch (e) { api = "blocked"; }
        let web = "reachable";
        try { await fetch("https://example.com/"); } catch (e) { web = "blocked"; }
        let parentDom = "reachable";
        try { void window.parent.document.title; } catch (e) { parentDom = "blocked"; }
        let storage = "reachable";
        try { window.localStorage.setItem("x", "1"); } catch (e) { storage = "blocked"; }
        Rosalena.assert(api === "blocked" && web === "blocked" && parentDom === "blocked" && storage === "blocked",
          JSON.stringify({ api, web, parentDom, storage }));
      });
      Rosalena.ready();
    `,
  });
  const run = await runtimeCheck(dir);
  const own = run.tests.filter((t) => t.name !== "every visible control can be clicked");
  assert.equal(own.length, 1);
  assert.equal(own[0].ok, true, own[0].error);
  // Every one of those attempts was reported as a CSP block, so the plugin fails anyway.
  assert.equal(run.ok, false);
  assert.ok(run.reports.some((r) => r.level === "csp"), JSON.stringify(run.reports));
});

test("runtime: a hidden layer that still covers the buttons is caught", needsElectron, async () => {
  // The Transformer 3D bug: `.cover { display: grid }` beat the `hidden` attribute, so an
  // invisible full-size box sat over every control and swallowed the clicks.
  const report = await verifyPlugin(
    templatePlugin(tempDir(), {
      "app/app.js": `
        document.body.insertAdjacentHTML("beforeend",
          '<button id="go" style="position:fixed;top:20px;left:20px">Go</button>' +
          '<div id="cover" hidden style="position:fixed;inset:0;display:grid"></div>');
        Rosalena.test("t", () => {});
        Rosalena.ready();`,
    }),
  );
  assert.equal(report.ok, false);
  const check = report.runtime.tests.find((t) => t.name === "every visible control can be clicked");
  assert.equal(check.ok, false);
  assert.match(check.error, /#cover.*marked hidden/);
  assert.match(check.error, /<button#go> cannot be clicked: <div#cover> is on top of it/);
});

test("runtime: a page that draws nothing is caught by the screenshot", needsElectron, async () => {
  const report = await verifyPlugin(
    templatePlugin(tempDir(), { "app/app.js": `document.body.innerHTML = ""; Rosalena.test("t", () => {}); Rosalena.ready();` }),
  );
  assert.equal(report.runtime.blank, true);
  assert.equal(report.ok, false);
  assert.match(report.runtime.problems.join(" "), /blank/);
});

test("runtime: a failing self-test, a thrown error and a missing ready() all fail", needsElectron, async () => {
  const failing = await verifyPlugin(
    templatePlugin(tempDir(), { "app/app.js": `Rosalena.test("broken", () => { Rosalena.assert(false, "it is broken"); }); Rosalena.ready();` }),
  );
  assert.equal(failing.ok, false);
  assert.match(failing.runtime.problems.join(" "), /it is broken/);

  const throwing = await verifyPlugin(
    templatePlugin(tempDir(), { "app/app.js": `Rosalena.test("t", () => {}); Rosalena.ready(); setTimeout(() => { throw new Error("late crash"); }, 10);` }),
  );
  assert.equal(throwing.ok, false);
  assert.match(throwing.runtime.problems.join(" "), /late crash/);

  const silent = await verifyPlugin(templatePlugin(tempDir(), { "app/app.js": `Rosalena.test("t", () => {}); if (false) Rosalena.ready();` }), { timeoutMs: 60_000 });
  assert.equal(silent.ok, false);
  assert.match(silent.runtime.problems.join(" "), /never called Rosalena\.ready/);
});

// ------------------------------------------------------------------ permissions

test("permissions: draft tools work in Workspace write, installing asks, Read only blocks writes", async () => {
  const { decide } = await import("../src/permissions.mjs");
  const call = (name, args = {}) => ({ function: { name, arguments: JSON.stringify(args) } });
  for (const name of ["creator_new", "creator_write", "creator_files", "creator_verify"]) {
    assert.equal(decide({ call: call(name, { id: "x" }), mode: "workspace", root: tmpdir() }).action, "allow", name);
    assert.equal(decide({ call: call(name, { id: "x" }), mode: "read", root: tmpdir() }).action, "deny", `${name} in read only`);
  }
  for (const name of ["creator_read", "creator_status"]) {
    assert.equal(decide({ call: call(name, { id: "x" }), mode: "read", root: tmpdir() }).action, "allow", name);
  }
  for (const name of ["creator_publish", "creator_rollback"]) {
    assert.equal(decide({ call: call(name, { id: "x" }), mode: "workspace", root: tmpdir() }).action, "ask", name);
  }
});

// ------------------------------------------------------------------ Creator: drafts, publish, rollback

function creatorIn(home) {
  return createCreator({ home, bundledDir: tempDir() });
}

test("creator: drafts refuse paths outside the draft, dotfiles, other file types and backend code", () => {
  const creator = creatorIn(tempDir());
  creator.newDraft({ id: "notes", title: "Notes", description: "notes" });
  assert.throws(() => creator.writeFile("notes", "../escape.js", "x"), /inside the draft/);
  assert.throws(() => creator.writeFile("notes", ".env", "x"), /dot/);
  assert.throws(() => creator.writeFile("notes", "run.exe", "x"), /not allowed/);
  assert.throws(() => creator.writeFile("notes", "plugin.mjs", "x"), /page only/);
  assert.throws(() => creator.newDraft({ id: "notes", title: "Again" }), /already exists/);
  assert.throws(() => creator.newDraft({ id: "x", title: "Too short id" }), /not a plugin id/);
  assert.throws(() => creator.newDraft({ id: "ok-id", title: "T", permissions: ["shell"] }), /unknown permission/);
});

test("creator: publish refuses an unverified draft", () => {
  const creator = creatorIn(tempDir());
  creator.newDraft({ id: "notes", title: "Notes", description: "notes" });
  assert.throws(() => creator.publish("notes"), /has not passed verification/);
});

test("creator: verify -> publish, edit refused until re-verified, rollback and rollback again", async () => {
  const home = tempDir();
  // A fake verifier that passes whatever it is given, so this test is about the
  // fingerprint and the filesystem, not about Electron (the runtime tests cover that).
  const verify = async (folder) => ({ ok: true, fingerprint: fingerprint(folder), version: JSON.parse(readFileSync(join(folder, "plugin.json"), "utf8")).version, at: new Date().toISOString(), static: { checks: [], warnings: [] }, runtime: { ok: true, tests: [] } });
  const creator = createCreator({ home, bundledDir: tempDir(), verify });
  creator.newDraft({ id: "notes", title: "Notes", description: "v1" });
  await creator.verify("notes");
  const first = creator.publish("notes");
  assert.equal(first.version, "1.0.0");
  assert.equal(first.replaced, null);
  const installed = join(home, "plugins", "notes");
  assert.ok(existsSync(join(installed, "plugin.json")));

  // Edit after verifying: refused.
  const manifest = JSON.parse(creator.readFile("notes", "plugin.json"));
  manifest.version = "1.1.0";
  creator.writeFile("notes", "plugin.json", JSON.stringify(manifest, null, 2));
  assert.throws(() => creator.publish("notes"), /changed after it was verified/);

  await creator.verify("notes");
  const second = creator.publish("notes");
  assert.equal(second.version, "1.1.0");
  assert.equal(second.replaced.version, "1.0.0");
  assert.equal(creator.history("notes").length, 1);

  const back = creator.rollback("notes");
  assert.equal(back.restored, "1.0.0");
  assert.equal(JSON.parse(readFileSync(join(installed, "plugin.json"), "utf8")).version, "1.0.0");
  // The rolled-over 1.1.0 was kept, so the rollback itself can be undone.
  assert.deepEqual(creator.history("notes").map((h) => h.version), ["1.1.0"]);
  const forward = creator.rollback("notes");
  assert.equal(forward.restored, "1.1.0");

  // Remove keeps it too, and it can be rolled back in.
  creator.remove("notes");
  assert.equal(existsSync(installed), false);
  creator.rollback("notes", { to: "1.1.0" });
  assert.ok(existsSync(installed));

  const actions = creator.ledger().map((e) => e.action);
  for (const a of ["new", "verify", "publish", "rollback", "remove"]) assert.ok(actions.includes(a), `ledger has ${a}`);
});

test("creator: the off switch hides a plugin from the list without deleting it", async () => {
  const home = tempDir();
  const verify = async (folder) => ({ ok: true, fingerprint: fingerprint(folder), version: "1.0.0", at: "now", static: { checks: [], warnings: [] }, runtime: { ok: true } });
  const creator = createCreator({ home, bundledDir: tempDir(), verify });
  creator.newDraft({ id: "notes", title: "Notes", description: "x" });
  await creator.verify("notes");
  creator.publish("notes");
  creator.setEnabled("notes", false);
  const listed = creator.overview().plugins.find((p) => p.id === "notes");
  assert.equal(listed.enabled, false);
  creator.setEnabled("notes", true);
  assert.equal(creator.overview().plugins.find((p) => p.id === "notes").enabled, true);
});

test("creator: the real verifier gates a real draft end to end", needsElectron, async () => {
  const creator = creatorIn(tempDir());
  creator.newDraft({ id: "counter", title: "Counter", description: "counts", permissions: ["storage"] });
  creator.writeFile(
    "counter",
    "app/app.js",
    `const out = document.createElement("p"); out.id = "n"; document.getElementById("app").append(out);
     let n = (await Rosalena.storage.get("n")) ?? 0; out.textContent = String(n);
     export async function bump() { n += 1; out.textContent = String(n); await Rosalena.storage.set("n", n); }
     Rosalena.test("bump counts and saves", async () => { await bump(); Rosalena.assert(out.textContent === "1", out.textContent); Rosalena.assert((await Rosalena.storage.get("n")) === 1); });
     Rosalena.ready();`,
  );
  const report = await creator.verify("counter");
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  const out = creator.publish("counter");
  assert.equal(out.version, "1.0.0");
});
