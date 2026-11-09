// A small Language Server Protocol client: JSON-RPC over stdio with Content-Length
// framing, one server per (workspace root, language), kept alive across tool calls and
// shut down when idle or when the process exits.
//
// Only what the tools need: initialize, open/change documents (full sync), definition,
// references, hover, document/workspace symbols, rename, and the diagnostics the server
// pushes. Server-to-client requests are answered with harmless defaults so a server that
// asks for configuration or progress tokens does not stall.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const IS_WIN = process.platform === "win32";

export function pathToUri(abs) {
  return pathToFileURL(resolve(abs)).href;
}

/** file:// URI -> absolute path. Accepts the vscode-uri form (file:///d%3A/x) too. */
export function uriToPath(uri) {
  const u = new URL(String(uri));
  let p = decodeURIComponent(u.pathname);
  if (IS_WIN) {
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    p = p.replace(/\//g, "\\");
    if (/^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
    if (u.host) p = `\\\\${u.host}${p}`;
  }
  return resolve(p);
}

const keyOf = (abs) => (IS_WIN ? resolve(abs).toLowerCase() : resolve(abs));

export const LANGUAGE_IDS = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c", ".h": "c",
  ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp",
};

/** Which server family handles a file: typescript | python | go | rust | clangd, or null. */
export function serverFamily(abs) {
  const id = LANGUAGE_IDS[extname(abs).toLowerCase()];
  if (!id) return null;
  if (/^(typescript|javascript)/.test(id)) return "typescript";
  if (id === "c" || id === "cpp") return "clangd";
  return id;
}

export class LspClient {
  /**
   * @param {object} o
   * @param {string} o.command  @param {string[]} o.args  @param {object} [o.env]
   * @param {string} o.root     workspace root (rootUri)
   * @param {object} [o.initializationOptions]
   * @param {string} [o.name]
   */
  constructor({ command, args = [], env = {}, root, initializationOptions = {}, name = "lsp" }) {
    Object.assign(this, { command, args, env, root: resolve(root), initializationOptions, name });
    this.nextId = 1;
    this.pending = new Map();
    this.docs = new Map(); // key -> { uri, version, text, languageId }
    this.diagnostics = new Map(); // key -> { at, list }
    this.diagWaiters = new Set();
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.dead = null;
    this.capabilities = {};
  }

  async start(timeoutMs = 60_000) {
    this.child = spawn(this.command, this.args, {
      cwd: this.root,
      env: { ...process.env, ...this.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.child.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    this.child.stdin.on("error", () => {});
    const failAll = (why) => {
      this.dead = why;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${this.name} stopped: ${why}${this.stderr ? ` (${this.stderr.trim().split("\n").slice(-3).join(" | ")})` : ""}`));
      }
      this.pending.clear();
    };
    this.child.on("error", (err) => failAll(err.message));
    this.child.on("exit", (code, signal) => failAll(`exited (${signal ?? code})`));
    const init = await this.request(
      "initialize",
      {
        processId: process.pid,
        clientInfo: { name: "rosalena-code-intel", version: "0.1.0" },
        rootUri: pathToUri(this.root),
        rootPath: this.root,
        workspaceFolders: [{ uri: pathToUri(this.root), name: "workspace" }],
        initializationOptions: this.initializationOptions,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          workspace: { workspaceFolders: true, configuration: true, symbol: { dynamicRegistration: false }, workspaceEdit: { documentChanges: true } },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ["markdown", "plaintext"] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            rename: { prepareSupport: true },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
          },
          window: { workDoneProgress: false },
        },
      },
      timeoutMs,
    );
    this.capabilities = init?.capabilities ?? {};
    this.notify("initialized", {});
    return this;
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = this.buffer.subarray(0, sep).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(sep + 4); // garbage header: skip it
        continue;
      }
      const len = Number(m[1]);
      if (this.buffer.length < sep + 4 + len) return;
      const body = this.buffer.subarray(sep + 4, sep + 4 + len).toString("utf8");
      this.buffer = this.buffer.subarray(sep + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // A request from the server. Answer so it never waits on us.
      let result = null;
      if (msg.method === "workspace/configuration") result = (msg.params?.items ?? []).map(() => null);
      else if (msg.method === "workspace/workspaceFolders") result = [{ uri: pathToUri(this.root), name: "workspace" }];
      else if (msg.method === "workspace/applyEdit") result = { applied: false, failureReason: "this client applies edits itself" };
      this.#send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const abs = uriToPath(msg.params.uri);
      this.diagnostics.set(keyOf(abs), { at: Date.now(), version: msg.params.version, list: msg.params.diagnostics ?? [] });
      for (const w of [...this.diagWaiters]) w(abs);
    }
  }

  #send(obj) {
    if (this.dead) throw new Error(`${this.name} is not running: ${this.dead}`);
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Make the server see the file as it is on disk now: open it the first time, send the
   * full text again when it changed. Returns { uri, text, changed }.
   */
  sync(abs, text = readFileSync(abs, "utf8")) {
    const key = keyOf(abs);
    const uri = pathToUri(abs);
    const doc = this.docs.get(key);
    if (!doc) {
      const languageId = LANGUAGE_IDS[extname(abs).toLowerCase()] ?? "plaintext";
      this.docs.set(key, { uri, version: 1, text, languageId });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
      return { uri, text, changed: true, opened: true };
    }
    if (doc.text === text) return { uri, text, changed: false };
    doc.version += 1;
    doc.text = text;
    this.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
    return { uri, text, changed: true };
  }

  /** Re-send every open document whose file changed on disk (edits made by other tools). */
  resyncOpen() {
    let changed = 0;
    for (const doc of this.docs.values()) {
      let text;
      try {
        text = readFileSync(uriToPath(doc.uri), "utf8");
      } catch {
        continue;
      }
      if (text !== doc.text) {
        this.sync(uriToPath(doc.uri), text);
        changed += 1;
      }
    }
    return changed;
  }

  /**
   * Diagnostics for a file. Waits for a fresh push after a change (or the first open),
   * settling for `quietMs` after the last push so a server that sends an empty list first
   * and the real one a moment later is read correctly.
   */
  async diagnosticsFor(abs, { changed = true, timeoutMs = 15_000, quietMs = 600, since = Date.now() } = {}) {
    const key = keyOf(abs);
    const have = this.diagnostics.get(key);
    if (!changed && have) return have.list;
    return new Promise((resolvePromise) => {
      let quiet = null;
      const done = () => {
        this.diagWaiters.delete(onPush);
        clearTimeout(hard);
        clearTimeout(quiet);
        resolvePromise(this.diagnostics.get(key)?.list ?? []);
      };
      const onPush = (p) => {
        if (keyOf(p) !== key) return;
        const d = this.diagnostics.get(key);
        if (!d || d.at < since) return;
        clearTimeout(quiet);
        quiet = setTimeout(done, quietMs);
      };
      this.diagWaiters.add(onPush);
      const hard = setTimeout(done, timeoutMs);
      const d = this.diagnostics.get(key);
      if (d && d.at >= since) onPush(abs);
    });
  }

  async shutdown() {
    if (this.dead) return;
    try {
      await this.request("shutdown", null, 3000);
      this.notify("exit", null);
    } catch {
      /* already gone or hung: killed below */
    }
    await new Promise((r) => setTimeout(r, 200));
    this.kill();
  }

  /** Kill the server and anything it started (tsserver is a child of the language server). */
  kill() {
    const pid = this.child?.pid;
    if (!pid || this.child.exitCode !== null) return;
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
}

// --------------------------------------------------------------------------- the pool

const IDLE_MS = 10 * 60_000;
const pool = new Map(); // `${root}|${family}` -> { promise, client, timer }

function touch(entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pool.delete(entry.key);
    entry.client?.shutdown();
  }, IDLE_MS);
  entry.timer.unref?.();
}

/**
 * The running server for (root, family), starting it with `spec()` the first time.
 * `spec` resolves to { command, args, env, initializationOptions }.
 */
export async function serverFor(root, family, spec) {
  const key = `${keyOf(root)}|${family}`;
  let entry = pool.get(key);
  if (entry?.client?.dead) {
    pool.delete(key);
    entry = null;
  }
  if (!entry) {
    entry = { key, timer: null, client: null };
    entry.promise = (async () => {
      const s = await spec();
      const client = new LspClient({ ...s, root, name: s.name ?? family });
      await client.start();
      entry.client = client;
      entry.info = s;
      return client;
    })();
    pool.set(key, entry);
    entry.promise.catch(() => pool.delete(key));
  }
  const client = await entry.promise;
  touch(entry);
  return { client, info: entry.info };
}

export async function shutdownAll() {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(
    entries.map(async (e) => {
      clearTimeout(e.timer);
      try {
        const c = e.client ?? (await e.promise);
        await c.shutdown();
      } catch {
        /* never started */
      }
    }),
  );
}

export function runningServers() {
  return [...pool.values()].filter((e) => e.client && !e.client.dead).map((e) => e.key);
}

process.once("exit", () => {
  for (const e of pool.values()) e.client?.kill();
});
