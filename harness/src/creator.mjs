// Creator mode's workshop: drafts, verified installs, and rollback.
//
// A model writing plugins is only useful if what it writes cannot quietly break the app,
// so the path from "the model wrote some files" to "it is in the sidebar" has three locks:
//
//   drafts    the model writes into <home>/creator/drafts/<id>, never into an installed
//             plugin. Paths are checked (no escaping the draft, allowed file types only).
//   verify    plugin-verify.mjs runs the static rules and the page itself; a pass is
//             recorded with the fingerprint (a hash of every file) it passed.
//   publish   installs a draft only when its current fingerprint is the one that passed.
//             Edit one byte after verifying and publish refuses. The version it replaces
//             is kept in <home>/creator/history/<id>/<stamp>/ first.
//
// Rollback puts a kept version back and keeps the one it replaced, so a rollback can be
// undone the same way. Remove moves the plugin into history too: nothing Creator mode does
// deletes a version. Every action is a line in <home>/creator/ledger.jsonl.

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

import { rosalenaHome } from "./memory.mjs";
import { renamePluginKeys } from "./plugin-names.mjs";
import { fingerprint, staticCheck, verifyPlugin } from "./plugin-verify.mjs";
import { BUNDLED_PLUGINS_DIR, PLUGIN_ID_PATTERN, PLUGIN_MIME, UI_PERMISSIONS, insideFolder, knownLibs, listUiPlugins, pluginFiles, userPluginsDir } from "./ui-plugins.mjs";

const MAX_FILE = 15 * 1024 * 1024;

export function creatorPaths(home = rosalenaHome()) {
  const root = join(home, "creator");
  return {
    root,
    drafts: join(root, "drafts"),
    history: join(root, "history"),
    reports: join(root, "reports"),
    ledger: join(root, "ledger.jsonl"),
    state: join(root, "state.json"),
    installed: userPluginsDir(home),
  };
}

const stampOf = (date) => date.toISOString().replace(/[:.]/g, "-");

/** The starting files of a new draft: a page that already passes verification. */
export function templateFiles({ id, title, description, permissions = [], libs = [] }) {
  const manifest = {
    id,
    version: "1.0.0",
    description,
    ui: { title, icon: "icon.svg", page: "app/index.html", permissions, libs },
  };
  return {
    "plugin.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12h8M12 8v8"/></svg>\n`,
    "app/index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main id="app">
    <h1>${title}</h1>
    <p class="lead">${description}</p>
  </main>
  <script src="/plugin-sdk.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
`,
    "app/style.css": `:root { --bg: #0b1d26; --panel: #143039; --text: #eef6fc; --dim: #a6bacd; --accent: #6beaf6; --line: #35505f; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, "Segoe UI", sans-serif; }
#app { max-width: 880px; margin: 0 auto; padding: 48px 32px; }
h1 { margin: 0 0 8px; font-size: 28px; }
.lead { color: var(--dim); margin: 0; }
`,
    "app/app.js": `// ${title}: replace this with the plugin. Keep Rosalena.ready() after the first render
// and keep at least one Rosalena.test() that proves the feature works.
const root = document.getElementById("app");

Rosalena.on("theme", (theme) => {
  for (const [name, value] of Object.entries(theme.colors ?? {})) {
    if (value) document.documentElement.style.setProperty(\`--\${name}\`, value);
  }
});

Rosalena.test("the page drew its title", () => {
  Rosalena.assert(root.querySelector("h1")?.textContent.trim().length > 0, "no title on the page");
});

Rosalena.ready();
`,
  };
}

export function createCreator({ home = rosalenaHome(), bundledDir = BUNDLED_PLUGINS_DIR, verify = verifyPlugin, now = () => new Date() } = {}) {
  const paths = creatorPaths(home);

  const readState = () => {
    try {
      const s = JSON.parse(readFileSync(paths.state, "utf8"));
      // A switch saved under a plugin's pre-rosa name keeps applying (and is written back
      // under the new name the next time anything is switched).
      return { switches: renamePluginKeys(s.switches ?? {}), passes: s.passes ?? {} };
    } catch {
      return { switches: {}, passes: {} };
    }
  };
  const writeState = (state) => {
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.state, JSON.stringify(state, null, 2));
  };
  const record = (entry) => {
    mkdirSync(paths.root, { recursive: true });
    appendFileSync(paths.ledger, `${JSON.stringify({ at: now().toISOString(), ...entry })}\n`);
  };

  const bundledIds = () => new Set(listUiPlugins({ bundledDir, userDir: null }).map((p) => p.id));
  const checkId = (id) => {
    const clean = String(id ?? "").trim();
    if (!PLUGIN_ID_PATTERN.test(clean)) throw new Error(`"${clean}" is not a plugin id: use 2-41 characters of a-z, 0-9 and "-"`);
    return clean;
  };
  const draftDir = (id) => join(paths.drafts, checkId(id));
  const needDraft = (id) => {
    const dir = draftDir(id);
    if (!existsSync(join(dir, "plugin.json"))) throw new Error(`there is no draft called "${id}"; start one with creator_new`);
    return dir;
  };
  const installedDir = (id) => join(paths.installed, checkId(id));
  const readVersion = (folder) => {
    try {
      return String(JSON.parse(readFileSync(join(folder, "plugin.json"), "utf8")).version ?? "0.0.0");
    } catch {
      return "0.0.0";
    }
  };

  /** Move an installed folder into history; returns the history entry. */
  const keep = (id, reason) => {
    const from = installedDir(id);
    if (!existsSync(from)) return null;
    const version = readVersion(from);
    const stamp = `${stampOf(now())}__v${version}`;
    const to = join(paths.history, id, stamp);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    writeFileSync(join(paths.history, id, `${stamp}.json`), JSON.stringify({ id, version, stamp, keptAt: now().toISOString(), reason }, null, 2));
    return { stamp, version, path: to };
  };

  /** Copy a folder into the installed place through a staging folder, so a failure leaves nothing half-written. */
  const install = (id, from) => {
    mkdirSync(paths.installed, { recursive: true });
    const staging = join(paths.installed, `.staging-${id}-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    cpSync(from, staging, { recursive: true, filter: (src) => !src.split(/[\\/]/).pop().startsWith(".verify") });
    renameSync(staging, installedDir(id));
  };

  const api = {
    paths,

    /** Start a draft from the template, or from an existing plugin (`from`: an installed or bundled id). */
    newDraft({ id, title, description = "", permissions = [], libs = [], from = null, replace = false } = {}) {
      const clean = checkId(id);
      if (bundledIds().has(clean)) throw new Error(`"${clean}" is a plugin that ships with the app; pick a new id (you can start from it with from: "${clean}")`);
      const name = String(title ?? "").trim();
      if (!name || name.length > 40) throw new Error("a title is required, at most 40 characters");
      const perms = (Array.isArray(permissions) ? permissions : []).map(String);
      for (const p of perms) if (!(p in UI_PERMISSIONS)) throw new Error(`unknown permission "${p}" (known: ${Object.keys(UI_PERMISSIONS).join(", ")})`);
      const wanted = (Array.isArray(libs) ? libs : []).map(String);
      const available = knownLibs();
      for (const l of wanted) if (!available.has(l)) throw new Error(`unknown library "${l}" (known: ${[...available.keys()].join(", ")})`);
      const dir = draftDir(clean);
      if (existsSync(dir)) {
        if (!replace) throw new Error(`a draft called "${clean}" already exists; edit it with creator_write, or pass replace: true to start over`);
        rmSync(dir, { recursive: true, force: true });
      }
      if (from) {
        const source = [join(bundledDir, String(from)), installedDir(String(from))].find((d) => existsSync(join(d, "plugin.json")));
        if (!source) throw new Error(`no plugin called "${from}" to start from`);
        cpSync(source, dir, { recursive: true });
        const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
        manifest.id = clean;
        manifest.version = "1.0.0";
        delete manifest.bundled;
        manifest.ui = { ...(manifest.ui ?? {}), title: name };
        if (description) manifest.description = description;
        writeFileSync(join(dir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      } else {
        for (const [rel, body] of Object.entries(templateFiles({ id: clean, title: name, description: String(description), permissions: perms, libs: wanted }))) {
          const full = join(dir, rel);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, body);
        }
      }
      record({ action: "new", id: clean, from });
      return { id: clean, path: dir, files: pluginFiles(dir) };
    },

    /**
     * A plugin the person made elsewhere, brought in as a draft: same rules as one built
     * here (a page only, allowed file types, no dot files, 15 MB a file), copied byte for
     * byte so images survive. It still has to pass verify() before publish() installs it.
     */
    importFolder(folder, { replace = false } = {}) {
      const source = String(folder ?? "").trim().replace(/^"(.*)"$/, "$1");
      if (!source || !existsSync(join(source, "plugin.json"))) throw new Error("that folder has no plugin.json; pick the folder that holds the plugin's plugin.json");
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));
      } catch (err) {
        throw new Error(`plugin.json is not valid JSON: ${err?.message ?? err}`);
      }
      if (!manifest?.ui || typeof manifest.ui !== "object") throw new Error('plugin.json has no "ui" block, so it is not a sidebar page (a tool plugin is added as one)');
      const clean = checkId(manifest.id);
      if (bundledIds().has(clean)) throw new Error(`"${clean}" is the id of a plugin that ships with the app; change the id in plugin.json`);
      const files = pluginFiles(source);
      for (const rel of files) {
        const base = rel.split(/[\\/]/).pop();
        if (base.startsWith(".")) throw new Error(`${rel}: file names may not start with a dot`);
        if (base === "plugin.mjs") throw new Error("a sidebar page may not carry plugin.mjs (agent code); add it as a tool plugin instead");
        if (!PLUGIN_MIME[extname(rel).toLowerCase()] && base !== "plugin.json") throw new Error(`${rel}: "${extname(rel) || base}" files are not allowed in a plugin`);
        if (statSync(join(source, rel)).size > MAX_FILE) throw new Error(`${rel} is over 15 MB`);
      }
      const dir = draftDir(clean);
      if (existsSync(dir)) {
        if (!replace) throw new Error(`a draft called "${clean}" already exists`);
        rmSync(dir, { recursive: true, force: true });
      }
      for (const rel of files) {
        const full = join(dir, rel);
        mkdirSync(dirname(full), { recursive: true });
        cpSync(join(source, rel), full);
      }
      record({ action: "import", id: clean, from: source });
      return { id: clean, path: dir, files: pluginFiles(dir) };
    },

    writeFile(id, rel, content) {
      const dir = needDraft(id);
      const full = insideFolder(dir, rel);
      if (!full) throw new Error(`"${rel}" is not a path inside the draft`);
      const base = full.split(/[\\/]/).pop();
      if (base.startsWith(".")) throw new Error("file names may not start with a dot");
      if (!PLUGIN_MIME[extname(full).toLowerCase()] && base !== "plugin.json") throw new Error(`"${extname(full) || base}" files are not allowed in a plugin`);
      if (base === "plugin.mjs") throw new Error("a Creator plugin is a page only: plugin.mjs (agent code) is not allowed");
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      if (Buffer.byteLength(text) > MAX_FILE) throw new Error("a file may be at most 15 MB");
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
      return { path: rel, bytes: Buffer.byteLength(text) };
    },

    readFile(id, rel) {
      const dir = needDraft(id);
      const full = insideFolder(dir, rel);
      if (!full || !existsSync(full)) throw new Error(`no file "${rel}" in the draft`);
      return readFileSync(full, "utf8");
    },

    deleteFile(id, rel) {
      const dir = needDraft(id);
      const full = insideFolder(dir, rel);
      if (!full || !existsSync(full)) throw new Error(`no file "${rel}" in the draft`);
      if (rel === "plugin.json") throw new Error("plugin.json cannot be deleted");
      rmSync(full);
      return true;
    },

    files(id) {
      const dir = needDraft(id);
      return pluginFiles(dir).map((rel) => ({ path: rel, bytes: statSync(join(dir, rel)).size }));
    },

    /** Verify the draft, and remember the pass by fingerprint. */
    async verify(id, { runtime = true } = {}) {
      const dir = needDraft(id);
      const report = await verify(dir, { runtime, reportDir: paths.reports });
      const state = readState();
      if (report.ok) state.passes[id] = { fingerprint: report.fingerprint, version: report.version, at: report.at };
      else delete state.passes[id];
      writeState(state);
      record({ action: "verify", id, ok: report.ok, version: report.version, fingerprint: report.fingerprint });
      return report;
    },

    /** Install the draft. Refused unless the draft's files are exactly the ones that passed. */
    publish(id) {
      const dir = needDraft(id);
      const state = readState();
      const pass = state.passes[id];
      if (!pass) throw new Error(`"${id}" has not passed verification; run creator_verify and fix every FAIL first`);
      const now = fingerprint(dir);
      if (now !== pass.fingerprint) throw new Error(`"${id}" changed after it was verified; run creator_verify again before publishing`);
      const stat = staticCheck(dir);
      if (!stat.ok) throw new Error(`"${id}" no longer passes the static checks`);
      if (bundledIds().has(id)) throw new Error(`"${id}" belongs to a plugin that ships with the app`);
      const kept = keep(id, "replaced by publish");
      install(id, dir);
      delete state.switches[id];
      writeState(state);
      record({ action: "publish", id, version: pass.version, fingerprint: now, replaced: kept?.stamp ?? null });
      return { id, version: pass.version, installed: installedDir(id), replaced: kept };
    },

    /** Every kept version of a plugin, newest first. */
    history(id) {
      const dir = join(paths.history, checkId(id));
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          let meta = {};
          try {
            meta = JSON.parse(readFileSync(join(dir, `${e.name}.json`), "utf8"));
          } catch {
            meta = {};
          }
          return { stamp: e.name, version: meta.version ?? readVersion(join(dir, e.name)), keptAt: meta.keptAt ?? null, reason: meta.reason ?? null, path: join(dir, e.name) };
        })
        .sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
    },

    /** Put a kept version back (the newest by default) and keep the one it replaces. */
    rollback(id, { to = null } = {}) {
      const clean = checkId(id);
      const entries = api.history(clean);
      if (!entries.length) throw new Error(`"${clean}" has no earlier version to roll back to`);
      const target = to ? entries.find((e) => e.stamp === to || e.version === to) : entries[0];
      if (!target) throw new Error(`no kept version "${to}" of "${clean}" (have: ${entries.map((e) => e.stamp).join(", ")})`);
      const stat = staticCheck(target.path);
      if (!stat.ok) throw new Error(`the kept version ${target.stamp} does not pass the static checks any more: ${stat.checks.filter((c) => !c.ok).map((c) => c.name).join(", ")}`);
      const kept = keep(clean, `replaced by rollback to ${target.stamp}`);
      mkdirSync(paths.installed, { recursive: true });
      renameSync(target.path, installedDir(clean));
      rmSync(join(paths.history, clean, `${target.stamp}.json`), { force: true });
      const state = readState();
      delete state.switches[clean];
      writeState(state);
      record({ action: "rollback", id: clean, to: target.stamp, version: target.version, replaced: kept?.stamp ?? null });
      return { id: clean, restored: target.version, from: target.stamp, kept };
    },

    /** Take an installed plugin out of the sidebar. It goes to history, so it can be rolled back in. */
    remove(id) {
      const clean = checkId(id);
      const kept = keep(clean, "removed");
      if (!kept) throw new Error(`"${clean}" is not installed by Creator mode`);
      record({ action: "remove", id: clean, kept: kept.stamp });
      return kept;
    },

    /** The off switch: the plugin stays installed but is not listed or served. */
    setEnabled(id, enabled) {
      const clean = checkId(id);
      const state = readState();
      if (enabled) delete state.switches[clean];
      else state.switches[clean] = { enabled: false, at: now().toISOString() };
      writeState(state);
      record({ action: enabled ? "enable" : "disable", id: clean });
      return { id: clean, enabled: Boolean(enabled) };
    },

    switches() {
      return readState().switches;
    },

    listDrafts() {
      if (!existsSync(paths.drafts)) return [];
      const state = readState();
      return readdirSync(paths.drafts, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(paths.drafts, e.name, "plugin.json")))
        .map((e) => {
          const dir = join(paths.drafts, e.name);
          const pass = state.passes[e.name];
          return { id: e.name, version: readVersion(dir), verified: Boolean(pass && pass.fingerprint === fingerprint(dir)), lastPass: pass?.at ?? null };
        });
    },

    /** Installed plugins (bundled and Creator's) with their switches and kept versions. */
    overview() {
      const state = readState();
      const plugins = listUiPlugins({ bundledDir, userDir: paths.installed, state: state.switches }).map((p) => ({
        id: p.id,
        title: p.title,
        version: p.version,
        source: p.source,
        enabled: p.enabled,
        ok: p.ok,
        problems: p.problems,
        history: p.source === "user" ? api.history(p.id).map((h) => ({ stamp: h.stamp, version: h.version })) : [],
      }));
      return { plugins, drafts: api.listDrafts() };
    },

    ledger(limit = 50) {
      if (!existsSync(paths.ledger)) return [];
      return readFileSync(paths.ledger, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    },
  };
  return api;
}
