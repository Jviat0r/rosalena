// A one-shot Node.js debugger: run a script under `node --inspect-brk=0`, attach over the
// inspector WebSocket (Chrome DevTools Protocol), set breakpoints, and at each hit record
// the call stack, the local variables and the values of the asked-for expressions. Then
// kill the process. The model gets what a person would read off the debugger panel,
// without having to drive an interactive session.

import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const IS_WIN = process.platform === "win32";

/** A CDP urlRegex for one file: case-insensitive on Windows, either slash, file:// or not. */
export function fileUrlRegex(abs) {
  const href = pathToFileURL(resolve(abs)).href.replace(/^file:\/\/\//, "");
  const esc = (ch) => (/[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch);
  // V8 reports file URLs percent-encoded (a space is %20); match the raw character too.
  const body = [...decodeURIComponent(href)]
    .map((ch) => {
      if (ch === "/") return "[\\\\/]";
      if (IS_WIN && /[a-z]/i.test(ch)) return `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
      const enc = ch === ":" ? ch : encodeURIComponent(ch);
      if (enc !== ch) return `(?:${esc(ch)}|${enc.replace(/[a-f]/gi, (h) => `[${h.toLowerCase()}${h.toUpperCase()}]`)})`;
      return esc(ch);
    })
    .join("");
  return `^(?:file:\\/\\/\\/?)?${body}$`;
}

/** "src/a.js:12" or "src/a.js:12:5" -> { file, line } (line 1-based). */
export function parseBreakpoint(spec) {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(String(spec ?? "").trim());
  if (!m || !m[1]) throw new Error(`breakpoint "${spec}" is not in the form file.js:LINE`);
  return { file: m[1], line: Number(m[2]) };
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }
  open(timeoutMs = 10_000) {
    return new Promise((resolvePromise, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error("could not connect to the inspector")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`inspector connection failed: ${e?.message ?? "error"}`));
      });
      ws.addEventListener("message", (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
          else p.resolve(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg);
        }
      });
      ws.addEventListener("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("the inspector connection closed"));
        this.pending.clear();
        for (const l of this.listeners) l({ method: "__closed" });
      });
    });
  }
  send(method, params = {}, timeoutMs = 10_000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* closed */
    }
  }
}

/** One RemoteObject as short text. */
export function describeValue(obj) {
  if (!obj) return "undefined";
  if (obj.type === "undefined") return "undefined";
  if (obj.subtype === "null") return "null";
  if (obj.type === "string") return JSON.stringify(obj.value).slice(0, 300);
  if (obj.unserializableValue) return obj.unserializableValue;
  if (["number", "boolean"].includes(obj.type)) return String(obj.value);
  if (obj.type === "bigint") return `${obj.unserializableValue ?? obj.description}`;
  if (obj.type === "function") return `[function ${obj.description?.match(/^(?:async\s+)?(?:function\s*\*?\s*)?([\w$]*)/)?.[1] || "anonymous"}]`;
  if (obj.preview) {
    const p = obj.preview;
    const items = (p.properties ?? []).map((x) => (p.subtype === "array" ? x.value : `${x.name}: ${x.type === "string" ? JSON.stringify(x.value) : x.value}`));
    const entries = (p.entries ?? []).map((e) => `${e.key?.description ?? ""}${e.key ? " => " : ""}${e.value?.description ?? ""}`);
    const inner = [...items, ...entries].join(", ") + (p.overflow ? ", …" : "");
    if (p.subtype === "array") return `${obj.description ?? "Array"} [${inner}]`;
    const name = obj.className && obj.className !== "Object" ? `${obj.className} ` : "";
    return `${name}{${inner}}`.slice(0, 400);
  }
  return String(obj.description ?? obj.type).slice(0, 300);
}

/**
 * Run `script` under the inspector and collect what each breakpoint hit shows.
 *
 * @returns {Promise<{ hits: object[], exitCode: number|null, output: string, timedOut: boolean, unbound: string[] }>}
 */
export async function debugNode({
  node,
  nodeEnv = {},
  script,
  args = [],
  cwd,
  breakpoints = [],
  expressions = [],
  maxHits = 5,
  timeoutMs = 20_000,
  pauseOnExceptions = true,
  isProjectFile = () => true,
}) {
  const child = spawn(node, ["--inspect-brk=127.0.0.1:0", script, ...args.map(String)], {
    cwd,
    env: { ...process.env, ...nodeEnv },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderrBuf = "";
  const keep = (s) => {
    output = (output + s).slice(-8000);
  };
  child.stdout.on("data", (d) => keep(String(d)));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  let exitCode = null;
  exited.then((c) => (exitCode = c));

  const wsUrl = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`node did not start its inspector: ${stderrBuf.trim().slice(0, 400)}`)), 10_000);
    child.stderr.on("data", (d) => {
      const s = String(d);
      stderrBuf += s;
      const m = /Debugger listening on (ws:\/\/\S+)/.exec(stderrBuf);
      if (m) {
        clearTimeout(timer);
        resolvePromise(m[1]);
      }
      // The inspector's own chatter is not the script's output.
      const own = s
        .split(/\r?\n/)
        .filter((l) => l && !/^(Debugger listening on|For help, see: https:\/\/nodejs\.org|Debugger attached\.|Waiting for the debugger to disconnect)/.test(l))
        .join("\n");
      if (own) keep(`${own}\n`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error(`node exited before the debugger attached: ${stderrBuf.trim().slice(0, 400)}`));
    });
  });

  const cdp = new Cdp(wsUrl);
  const hits = [];
  const unbound = [];
  let timedOut = false;
  const kill = () => {
    if (child.exitCode !== null) return;
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill("SIGKILL");
  };

  try {
    await cdp.open();
    const scripts = new Map(); // scriptId -> url
    let finish;
    const finished = new Promise((r) => (finish = r));
    const queue = [];
    let wake = null;
    cdp.on((msg) => {
      if (msg.method === "Debugger.scriptParsed") scripts.set(msg.params.scriptId, msg.params.url);
      if (msg.method === "Debugger.paused" || msg.method === "__closed" || msg.method === "Runtime.executionContextDestroyed") {
        queue.push(msg);
        wake?.();
      }
    });
    exited.then(() => {
      queue.push({ method: "__exited" });
      wake?.();
    });
    const next = () =>
      new Promise((r) => {
        if (queue.length) return r(queue.shift());
        wake = () => {
          wake = null;
          r(queue.shift());
        };
      });

    await cdp.send("Runtime.enable");
    await cdp.send("Debugger.enable");
    if (pauseOnExceptions) await cdp.send("Debugger.setPauseOnExceptions", { state: "uncaught" });
    const ids = new Map();
    for (const bp of breakpoints) {
      const res = await cdp.send("Debugger.setBreakpointByUrl", { urlRegex: fileUrlRegex(bp.abs), lineNumber: bp.line - 1, columnNumber: 0 });
      ids.set(res.breakpointId, bp.label);
    }
    await cdp.send("Runtime.runIfWaitingForDebugger");

    const timer = setTimeout(() => {
      timedOut = true;
      queue.push({ method: "__timeout" });
      wake?.();
    }, timeoutMs);

    const where = (url) => {
      try {
        return url.startsWith("file:") ? new URL(url) : null;
      } catch {
        return null;
      }
    };

    let sawStart = false;
    for (;;) {
      const msg = await next();
      if (!msg || msg.method !== "Debugger.paused") break;
      const p = msg.params;
      if (!sawStart && p.reason === "Break on start") {
        sawStart = true;
        await cdp.send("Debugger.resume");
        continue;
      }
      // With --inspect-brk, the first pause can also be reported as "other" without a hit.
      if (!sawStart && !(p.hitBreakpoints ?? []).length && p.reason !== "exception" && p.reason !== "promiseRejection") {
        sawStart = true;
        await cdp.send("Debugger.resume");
        continue;
      }
      sawStart = true;
      const top = p.callFrames[0];
      const hit = {
        reason: p.reason === "exception" || p.reason === "promiseRejection" ? `uncaught exception: ${describeValue(p.data)}` : (p.hitBreakpoints ?? []).map((id) => ids.get(id) ?? id).join(", ") || p.reason,
        stack: p.callFrames.slice(0, 12).map((f) => {
          const url = f.url || scripts.get(f.location.scriptId) || "";
          const u = where(url);
          const file = u ? decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, "$1") : url;
          return { fn: f.functionName || "(anonymous)", file, line: f.location.lineNumber + 1, column: f.location.columnNumber + 1, project: u ? isProjectFile(file) : false };
        }),
        locals: [],
        expressions: [],
      };
      for (const scope of top.scopeChain) {
        if (!["local", "block", "closure", "catch"].includes(scope.type)) continue;
        if (scope.type === "closure" && hit.locals.length > 20) continue;
        try {
          const props = await cdp.send("Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true, generatePreview: true });
          for (const prop of props.result ?? []) {
            if (hit.locals.length >= 40) break;
            if (scope.type === "closure" && typeof prop.value?.type === "string" && prop.value.type === "function") continue;
            hit.locals.push({ scope: scope.type, name: prop.name, value: describeValue(prop.value) });
          }
        } catch {
          /* a scope that cannot be read: skip it */
        }
      }
      for (const expression of expressions) {
        try {
          const r = await cdp.send("Debugger.evaluateOnCallFrame", { callFrameId: top.callFrameId, expression: String(expression), generatePreview: true, silent: true, throwOnSideEffect: false });
          hit.expressions.push({ expression, value: r.exceptionDetails ? `threw: ${describeValue(r.exceptionDetails.exception) || r.exceptionDetails.text}` : describeValue(r.result) });
        } catch (err) {
          hit.expressions.push({ expression, value: `error: ${err.message}` });
        }
      }
      hits.push(hit);
      if (hits.length >= maxHits || hit.reason.startsWith("uncaught exception")) break;
      await cdp.send("Debugger.resume");
    }
    clearTimeout(timer);
    finish();
    void finished;
    // Breakpoints that never bound to any loaded script: usually a wrong path or a line
    // with no code on it.
    for (const [id, label] of ids) {
      if (!hits.some((h) => h.reason.includes(label))) {
        try {
          const loaded = [...scripts.values()].some((u) => new RegExp(fileUrlRegex(breakpoints.find((b) => b.label === label).abs)).test(u));
          if (!loaded) unbound.push(label);
        } catch {
          /* ignore */
        }
      }
      void id;
    }
  } finally {
    cdp.close();
    kill();
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  return { hits, exitCode, output: output.trim(), timedOut, unbound };
}
