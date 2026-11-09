// The Rosalena store — an index, version pinning, install/update, and integrity.
//
// The plugin host can already load a directory; what it could not do is tell you
// where that directory came from, whether it arrived intact, or how to move it
// to a newer version. That is all this is.
//
// An index is one JSON document:
//
//   {
//     "version": 1,
//     "name": "rosalena-store",
//     "modules": {
//       "clock": {
//         "description": "…",
//         "latest": "1.1.0",
//         "versions": {
//           "1.1.0": {
//             "shape": "folder",                  // or "file" for a bare .mjs
//             "source": "modules/clock/1.1.0",    // relative to the index
//             "files": { "plugin.json": "<sha256>", "plugin.mjs": "<sha256>" }
//           }
//         }
//       }
//     }
//   }
//
// `files` is not decoration — it is the point. Installing verifies every byte
// against it, so an install either lands exactly what the index described or
// lands nothing at all.
//
// Two different guarantees, and it matters which is which:
//
//   sha256 in `files`  INTEGRITY. The bytes you got are the bytes the index
//                      described. It cannot prove the index itself is honest:
//                      whoever can edit the index can edit the hashes.
//   `signature`        AUTHORSHIP. The index is signed with an ed25519 key, and
//                      `store.trustedKeys` in harness.config.json names the keys
//                      you accept. An index nobody signed proves nothing.
//
// So the rule is: a LOCAL index (a file you put there yourself) may be
// unsigned. A REMOTE index must be signed by a key you listed, or it is
// refused. A signature that does not verify is refused in both cases — an
// edited index is exactly what signing is for.
//
// Safety rules, all enforced rather than documented:
//   - an id or a file path that could escape the plugins directory is refused
//   - a file whose hash does not match is refused, and nothing is written
//   - a bundled plugin is never overwritten or removed without --force
//   - an install is staged and only then moved into place, so a failure leaves
//     no half-installed module behind
//   - installing never imports the module; nothing from the store runs at
//     install time, only when the host loads it on the next run

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginRoot } from "./plugins.mjs";

export const INDEX_VERSION = 1;

export const storeIndexPath = () => fileURLToPath(new URL("../store/index.json", import.meta.url));
export const storeLockPath = (pluginsDir) => join(pluginsDir, "store.lock.json");

const fail = (message) => {
  throw new Error(message);
};

// ------------------------------------------------------------------ the index

/**
 * A deterministic serialisation, so a signature over the index does not depend
 * on key order. `JSON.stringify` follows insertion order, which means the same
 * index re-saved by another tool would not verify.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function signedPayload(index) {
  const { signature, ...rest } = index ?? {};
  return Buffer.from(stableStringify(rest), "utf8");
}

/**
 * Verify an index's signature against the keys the user trusts.
 *
 * `ok: false` means "do not install from this index". An unsigned LOCAL index is
 * allowed, because you put it there; an unsigned remote index is not, because
 * anyone on the wire could have.
 */
export function trustIndex({ index, trustedKeys = [], remote = false } = {}) {
  const signature = index?.signature;
  if (!signature) {
    return remote
      ? { signed: false, verified: false, trusted: false, ok: false, reason: "a remote index must be signed, and this one is not" }
      : { signed: false, verified: false, trusted: false, ok: true, reason: "unsigned (a local file you supply yourself)" };
  }
  if (signature.alg !== "ed25519") {
    return { signed: true, verified: false, trusted: false, ok: false, reason: `unsupported signature algorithm "${signature.alg}" - only ed25519 is read` };
  }
  let verified = false;
  try {
    const key = createPublicKey({ key: Buffer.from(String(signature.publicKey ?? ""), "base64"), format: "der", type: "spki" });
    verified = verifySignature(null, signedPayload(index), key, Buffer.from(String(signature.value ?? ""), "base64"));
  } catch (err) {
    return { signed: true, verified: false, trusted: false, ok: false, reason: `the signature could not be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!verified) {
    return { signed: true, verified: false, trusted: false, ok: false, reason: "the signature does not match the index - it changed after signing, or another key signed it" };
  }
  const trusted = trustedKeys.includes(String(signature.publicKey));
  if (trustedKeys.length && !trusted) {
    return { signed: true, verified: true, trusted: false, ok: false, reason: "the index is signed, but not by any key in store.trustedKeys" };
  }
  return {
    signed: true,
    verified: true,
    trusted,
    ok: true,
    reason: trusted ? "signed by a trusted key" : "signed, but store.trustedKeys is empty - authorship is unverified",
  };
}

/** Read an index from a local path or an http(s) URL. */
export async function readIndex(target, { fetchImpl = fetch } = {}) {
  const source = String(target ?? "").trim();
  if (!source) fail("no store index to read");
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchImpl(source).catch((err) => fail(`the index could not be fetched: ${err instanceof Error ? err.message : String(err)}`));
    if (!res.ok) fail(`the index could not be fetched: HTTP ${res.status}`);
    const text = await res.text();
    let index;
    try {
      index = JSON.parse(text);
    } catch (err) {
      fail(`the index at ${source} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!index || typeof index !== "object" || !index.modules || typeof index.modules !== "object") fail(`the index at ${source} has no "modules" object`);
    return { index, source: { kind: "remote", base: source.slice(0, source.lastIndexOf("/") + 1), label: source } };
  }
  if (!existsSync(source)) fail(`no store index at ${source}`);
  let index;
  try {
    index = JSON.parse(readFileSync(source, "utf8"));
  } catch (err) {
    fail(`the index at ${source} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!index || typeof index !== "object" || !index.modules || typeof index.modules !== "object") {
    fail(`the index at ${source} has no "modules" object`);
  }
  return { index, source: { kind: "local", base: dirname(resolve(source)), label: resolve(source) } };
}

/** The version to install, and what the index says about it. */
export function resolveVersion(index, id, want = null) {
  const module = index?.modules?.[id];
  if (!module) fail(`no module named "${id}" in the store index`);
  const versions = Object.keys(module.versions ?? {});
  if (!versions.length) fail(`"${id}" has no versions in the store index`);
  const version = want ? String(want) : String(module.latest ?? versions[versions.length - 1]);
  const entry = module.versions?.[version];
  if (!entry) fail(`"${id}" has no version ${version} (the index has ${versions.join(", ")})`);
  return {
    id,
    version,
    description: String(module.description ?? ""),
    shape: entry.shape === "file" ? "file" : "folder",
    source: String(entry.source ?? `modules/${id}/${version}`),
    files: entry.files && typeof entry.files === "object" ? entry.files : {},
    latest: version === String(module.latest ?? version),
  };
}

// -------------------------------------------------------------------- pieces

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An id becomes a path, so it has to be a plain name and nothing else. */
export function checkId(id) {
  const name = String(id ?? "");
  if (!ID_SHAPE.test(name)) fail(`"${name}" is not a usable module id - letters, digits, dot, dash and underscore only`);
  return name;
}

/** A module-relative path is refused if it could land outside the module. */
export function safeRel(rel) {
  const raw = String(rel ?? "").replace(/\\/g, "/");
  if (!raw) fail("an empty file path in the index");
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) fail(`"${rel}" is an absolute path; a module may only carry relative files`);
  if (raw.split("/").includes("..")) fail(`"${rel}" steps outside the module with ".."`);
  if (raw.startsWith("/")) fail(`"${rel}" is anchored at the filesystem root`);
  return raw;
}

export const hashOf = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const hashFile = (path) => hashOf(readFileSync(path));

/** Every file under `dir`, as index-style relative paths with forward slashes. */
export function listTree(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

export const artifactName = (id, shape) => (shape === "file" ? `${id}.mjs` : id);

/** Is the thing already at that path a first-party bundled plugin? */
export function isBundled(target, shape) {
  if (shape === "file") return false;
  try {
    return JSON.parse(readFileSync(join(target, "plugin.json"), "utf8"))?.bundled === true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the lock

export function readLock(pluginsDir) {
  const file = storeLockPath(pluginsDir);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { version: INDEX_VERSION, installedAt: parsed.installedAt ?? null, modules: parsed.modules ?? {} };
  } catch {
    return { version: INDEX_VERSION, installedAt: null, modules: {} };
  }
}

export function writeLock(pluginsDir, lock) {
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(storeLockPath(pluginsDir), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

// ----------------------------------------------------------------- installing

async function payloadBytes(source, rel, fetchImpl) {
  if (source.kind === "local") {
    const path = join(source.base, rel);
    if (!existsSync(path)) fail(`the index lists ${rel}, but it is not in ${source.base}`);
    return readFileSync(path);
  }
  const url = new URL(rel, source.base).href;
  const res = await fetchImpl(url).catch((err) => fail(`could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`));
  if (!res.ok) fail(`could not fetch ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Install one module version. Verifies every byte before anything is moved into
 * place, so a failure cannot leave a half-written plugin behind.
 */
export async function install({
  id,
  version = null,
  index,
  source,
  pluginsDir = pluginRoot(),
  force = false,
  fetchImpl = fetch,
} = {}) {
  const name = checkId(id);
  const entry = resolveVersion(index, name, version);
  const artifact = artifactName(name, entry.shape);
  const target = join(pluginsDir, artifact);

  const files = Object.entries(entry.files);
  if (!files.length) fail(`"${name}" ${entry.version} lists no files, so there is nothing to install`);
  if (entry.shape === "folder" && !entry.files["plugin.json"]) {
    fail(`"${name}" ${entry.version} is a folder module with no plugin.json - the host would never see it`);
  }
  for (const [rel] of files) safeRel(rel);

  const lock = readLock(pluginsDir);
  const already = lock.modules?.[name] ?? null;
  const had = existsSync(target);
  if (had) {
    if (!force && isBundled(target, entry.shape)) fail(`"${name}" is a bundled plugin - refusing to overwrite it with a store module (--force to do it anyway)`);
    if (!force) {
      fail(
        already
          ? `"${name}" ${already.version} is already installed; use --force to replace it, or /store update`
          : `"${artifact}" already exists in ${pluginsDir} and was not installed by the store; --force to replace it`,
      );
    }
  }

  const staging = join(pluginsDir, `.staging-${name}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const written = {};
  try {
    for (const [rel, want] of files) {
      const bytes = await payloadBytes(source, `${entry.source}/${rel}`, fetchImpl);
      const got = hashOf(bytes);
      if (got !== want) fail(`${entry.source}/${rel} does not match the index:\n  index says ${want}\n  the file is ${got}`);
      const dest = join(staging, safeRel(rel));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
      // Lock keys are relative to the plugins directory, so a single-file module
      // is tracked as "scratchpad.mjs" and a folder module as "clock/plugin.mjs".
      written[entry.shape === "file" ? artifact : `${artifact}/${safeRel(rel)}`] = got;
    }
    // Everything verified, so this is the only step that touches the real tree.
    rmSync(target, { recursive: true, force: true });
    if (entry.shape === "file") {
      mkdirSync(pluginsDir, { recursive: true });
      renameSync(join(staging, safeRel(files[0][0])), target);
    } else {
      renameSync(staging, target);
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  rmSync(staging, { recursive: true, force: true });

  lock.modules = lock.modules ?? {};
  lock.modules[name] = {
    version: entry.version,
    shape: entry.shape,
    source: entry.source,
    files: written,
    index: source?.label ?? null,
    installedAt: new Date().toISOString(),
  };
  lock.installedAt = lock.modules[name].installedAt;
  writeLock(pluginsDir, lock);
  return { id: name, version: entry.version, shape: entry.shape, target, files: Object.keys(written), replaced: had };
}

/** Remove a store-installed module. Bundled plugins and unknown ids are refused. */
export function removeModule(id, { pluginsDir = pluginRoot(), force = false } = {}) {
  const name = checkId(id);
  const lock = readLock(pluginsDir);
  const entry = lock.modules?.[name];
  const shape = entry?.shape ?? (existsSync(join(pluginsDir, `${name}.mjs`)) ? "file" : "folder");
  const target = join(pluginsDir, artifactName(name, shape));
  if (!existsSync(target)) fail(`"${name}" is not installed in ${pluginsDir}`);
  // The bundled check comes first on purpose: a bundled plugin IS installed, it
  // was just installed by the harness, so "not installed by the store" would be
  // a confusing thing to say about mcp-manager.
  if (!force && isBundled(target, shape)) fail(`"${name}" is a bundled plugin - refusing to remove it (--force to do it anyway)`);
  if (!force && !entry) fail(`"${name}" was not installed by the store, so it will not remove it (--force to delete it anyway)`);
  rmSync(target, { recursive: true, force: true });
  if (entry) {
    delete lock.modules[name];
    writeLock(pluginsDir, lock);
  }
  return { id: name, target, wasVersion: entry?.version ?? null };
}

/** Compare what is on disk with what the lock recorded. */
export function verifyInstalled(id, { pluginsDir = pluginRoot(), lock = null, hash = hashFile } = {}) {
  const name = checkId(id);
  const state = lock ?? readLock(pluginsDir);
  const entry = state.modules?.[name];
  if (!entry) return { id: name, known: false, ok: false, reason: "not installed by the store, so there is nothing to verify against" };
  const missing = [];
  const changed = [];
  for (const [rel, want] of Object.entries(entry.files ?? {})) {
    const path = join(pluginsDir, rel);
    if (!existsSync(path)) {
      missing.push(rel);
      continue;
    }
    if (hash(path) !== want) changed.push(rel);
  }
  const tracked = new Set(Object.keys(entry.files ?? {}));
  const artifact = artifactName(name, entry.shape);
  const onDisk = entry.shape === "file" ? [artifact] : existsSync(join(pluginsDir, artifact)) ? listTree(join(pluginsDir, artifact)).map((rel) => `${artifact}/${rel}`) : [];
  const untracked = onDisk.filter((rel) => !tracked.has(rel));
  const ok = !missing.length && !changed.length && !untracked.length;
  return { id: name, known: true, ok, version: entry.version, missing, changed, untracked, files: tracked.size, reason: ok ? "every file matches what was installed" : "what is on disk is not what was installed" };
}

/** What an update would do, for every store-installed module (or just one). */
export function planUpdate({ index, pluginsDir = pluginRoot(), lock = null, id = null } = {}) {
  const state = lock ?? readLock(pluginsDir);
  const wanted = id ? [checkId(id)] : Object.keys(state.modules ?? {});
  const actions = [];
  for (const name of wanted) {
    const entry = state.modules?.[name];
    if (!entry) {
      actions.push({ id: name, action: "unknown", from: null, to: null, reason: "not installed by the store" });
      continue;
    }
    const module = index?.modules?.[name];
    if (!module) {
      actions.push({ id: name, action: "gone", from: entry.version, to: null, reason: "the index no longer lists this module" });
      continue;
    }
    const latest = String(module.latest ?? "");
    if (!latest) {
      actions.push({ id: name, action: "unknown", from: entry.version, to: null, reason: "the index lists no latest version" });
      continue;
    }
    if (latest === entry.version) {
      actions.push({ id: name, action: "current", from: entry.version, to: latest, reason: "already at the newest version" });
      continue;
    }
    actions.push({ id: name, action: "update", from: entry.version, to: latest, reason: `${entry.version} -> ${latest}` });
  }
  return actions;
}

// ----------------------------------------------------------------- reporting

export function formatIndexList({ index, lock, source, trust }) {
  const names = Object.keys(index?.modules ?? {}).sort();
  const lines = [`store ${index?.name ?? "(unnamed)"} - ${names.length} module(s)`, `  index  ${source?.label ?? "?"}${source?.kind === "remote" ? " (remote)" : ""}`];
  lines.push(`  trust  ${trust?.reason ?? "unknown"}`);
  if (!names.length) {
    lines.push("  (the index lists no modules)");
    return lines.join("\n");
  }
  const width = Math.max(...names.map((n) => n.length), 6);
  for (const name of names) {
    const module = index.modules[name];
    const versions = Object.keys(module.versions ?? {});
    const installed = lock?.modules?.[name];
    const state = installed ? `installed ${installed.version}${installed.version === String(module.latest) ? "" : ` (latest ${module.latest})`}` : "not installed";
    lines.push(`  ${name.padEnd(width)}  ${String(module.latest ?? "?").padEnd(8)}  ${state}`);
    if (module.description) lines.push(`  ${" ".repeat(width)}  ${module.description}`);
    lines.push(`  ${" ".repeat(width)}  versions: ${versions.length ? versions.join(", ") : "(none)"}`);
  }
  return lines.join("\n");
}

export function formatVerify(result) {
  if (!result.known) return `${result.id}: ${result.reason}`;
  const head = `${result.id} ${result.version}: ${result.ok ? "intact" : "NOT what was installed"} (${result.files} file(s))`;
  const lines = [head];
  for (const rel of result.missing) lines.push(`  missing   ${rel}`);
  for (const rel of result.changed) lines.push(`  changed   ${rel}`);
  for (const rel of result.untracked) lines.push(`  untracked ${rel}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ the CLI

/**
 * One entry point for every store action, so the surface a user types and the
 * surface the tests drive are the same code.
 */
export async function runStore(sub = "list", argv = [], { pluginsDir = pluginRoot(), indexPath = storeIndexPath(), config = {}, fetchImpl = fetch } = {}) {
  const trustedKeys = Array.isArray(config?.trustedKeys) ? config.trustedKeys.map(String) : [];
  const force = argv.includes("--force");
  const args = argv.filter((a) => !a.startsWith("--"));
  const [first, second] = args;

  if (sub === "list" || sub === "index") {
    const { index, source } = await readIndex(indexPath, { fetchImpl });
    const trust = trustIndex({ index, trustedKeys, remote: source.kind === "remote" });
    if (sub === "index") {
      return [`index   ${source.label}`, `kind    ${source.kind}`, `trust   ${trust.reason}`, `keys    ${trustedKeys.length ? trustedKeys.length : "none configured (store.trustedKeys)"}`].join("\n");
    }
    return formatIndexList({ index, lock: readLock(pluginsDir), source, trust });
  }

  if (sub === "info") {
    if (!first) fail("usage: --store \"info <module> [version]\"");
    const { index, source } = await readIndex(indexPath, { fetchImpl });
    const trust = trustIndex({ index, trustedKeys, remote: source.kind === "remote" });
    if (!trust.ok) fail(`refusing to read this index: ${trust.reason}`);
    const entry = resolveVersion(index, first, second ?? null);
    const lock = readLock(pluginsDir);
    const installed = lock.modules?.[entry.id];
    return [
      `${entry.id} ${entry.version}${entry.latest ? " (latest)" : ""}`,
      `  ${entry.description || "(no description)"}`,
      `  shape    ${entry.shape}${entry.shape === "file" ? " (a single .mjs)" : " (a folder with plugin.json)"}`,
      `  source   ${source.kind === "local" ? join(source.base, entry.source) : new URL(entry.source + "/", source.base).href}`,
      `  files    ${Object.keys(entry.files).length}`,
      ...Object.keys(entry.files).map((rel) => `    ${rel}  ${entry.files[rel].slice(0, 12)}...`),
      `  state    ${installed ? `installed ${installed.version}` : "not installed"}`,
      `  install  --store "install ${entry.id}${entry.latest ? "" : `@${entry.version}`}"`,
    ].join("\n");
  }

  if (sub === "install") {
    if (!first) fail("usage: --store \"install <module>[@version] [--force]\"");
    const [id, version] = String(first).split("@");
    const { index, source } = await readIndex(indexPath, { fetchImpl });
    const trust = trustIndex({ index, trustedKeys, remote: source.kind === "remote" });
    if (!trust.ok) fail(`refusing to install from this index: ${trust.reason}`);
    const result = await install({ id, version: version ?? null, index, source, pluginsDir, force, fetchImpl });
    return [
      `installed ${result.id} ${result.version} (${result.shape}, ${result.files.length} file(s))`,
      `  ${result.target}`,
      ...(result.shape === "file" ? [`  a single-file module carries no manifest, so /plugins shows it as v0.0.0 - the store's lock holds ${result.version}`] : []),
      `  index trust: ${trust.reason}`,
      `  it loads on the next run - this process loaded its plugins before the install`,
    ].join("\n");
  }

  if (sub === "remove") {
    if (!first) fail("usage: --store \"remove <module> [--force]\"");
    const result = removeModule(first, { pluginsDir, force });
    return `removed ${result.id}${result.wasVersion ? ` ${result.wasVersion}` : ""}\n  ${result.target}`;
  }

  if (sub === "verify") {
    const lock = readLock(pluginsDir);
    const names = first ? [checkId(first)] : Object.keys(lock.modules ?? {});
    if (!names.length) return "nothing installed by the store, so there is nothing to verify";
    const results = names.map((name) => verifyInstalled(name, { pluginsDir, lock }));
    const known = results.filter((r) => r.known);
    const summary = !known.length ? "nothing installed by the store matches that name" : known.every((r) => r.ok) ? "all store modules intact" : "at least one module does not match what was installed";
    return [results.map(formatVerify).join("\n"), summary].join("\n");
  }

  if (sub === "update") {
    const { index, source } = await readIndex(indexPath, { fetchImpl });
    const trust = trustIndex({ index, trustedKeys, remote: source.kind === "remote" });
    if (!trust.ok) fail(`refusing to update from this index: ${trust.reason}`);
    const actions = planUpdate({ index, pluginsDir, id: first ?? null });
    if (!actions.length) return "nothing installed by the store, so there is nothing to update";
    const done = [];
    for (const action of actions) {
      if (action.action !== "update") {
        done.push(`  ${action.id}: ${action.reason}`);
        continue;
      }
      const result = await install({ id: action.id, version: action.to, index, source, pluginsDir, force: true, fetchImpl });
      done.push(`  ${result.id}: ${action.from} -> ${result.version}`);
    }
    return [`update from ${source.label}`, ...done, "changed modules load on the next run"].join("\n");
  }

  fail(`unknown store command "${sub}" - try list, info, install, remove, verify, update`);
}
