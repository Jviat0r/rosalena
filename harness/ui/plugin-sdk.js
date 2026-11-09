// The Rosalena plugin SDK: the one script a plugin page loads from the app.
//
//   <script src="/plugin-sdk.js"></script>
//
// A plugin page runs in a sandboxed frame with an opaque origin and no network, so this is
// its only way to reach the app, and everything here is a request the app may refuse:
//
//   Rosalena.ready()                       say the page has drawn (the verifier waits for it)
//   Rosalena.test(name, async () => {})    register a self-test the verifier runs
//   Rosalena.assert(condition, message)    throw inside a test when something is wrong
//   Rosalena.storage.get/set/remove/keys   this plugin's own saved data      ("storage")
//   Rosalena.files.save(name, data, type)  hand the person a file to save   ("files.save")
//   Rosalena.chat.compose(text)            put text in the chat box         ("chat.compose")
//   Rosalena.theme.set(tokens) / reset()   repaint the app from a fixed list ("theme")
//   Rosalena.on("theme", fn)               the app's colours, now and when they change
//   Rosalena.appearance.get() / set(patch) the app's look settings and window parts ("appearance")
//   Rosalena.host                          { id, permissions, theme, verifying } after connect
//
// Errors on the page (uncaught exceptions, rejected promises, console.error, blocked
// requests) are reported to the app as they happen: the app shows them, and the verifier
// fails a plugin that produces any while it loads or while its tests run.
(function () {
  "use strict";
  if (window.Rosalena) return;

  const pending = new Map();
  const listeners = new Map();
  const tests = [];
  const queue = [];
  let seq = 0;
  let connected = false;
  let readySent = false;
  let resolveConnected;
  const whenConnected = new Promise((resolve) => (resolveConnected = resolve));

  const post = (message) => {
    const full = Object.assign({ rosalena: 1 }, message);
    if (!connected && message.kind === "call") {
      queue.push(full);
      return;
    }
    window.parent.postMessage(full, "*");
  };

  const text = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  };

  const report = (level, message) => {
    try {
      window.parent.postMessage({ rosalena: 1, kind: "report", level, message: String(message).slice(0, 2000) }, "*");
    } catch (_) {
      /* a report that cannot be sent has nowhere else to go */
    }
  };

  window.addEventListener("error", (event) => {
    report("error", event.error ? text(event.error) : `${event.message} (${event.filename}:${event.lineno})`);
  });
  window.addEventListener("unhandledrejection", (event) => report("error", `unhandled rejection: ${text(event.reason)}`));
  window.addEventListener("securitypolicyviolation", (event) => {
    report("csp", `blocked ${event.effectiveDirective}: ${event.blockedURI || "inline"} (a plugin page may only load its own files, /plugin-lib and the SDK)`);
  });
  const originalError = console.error.bind(console);
  console.error = function () {
    report("error", Array.prototype.map.call(arguments, text).join(" "));
    originalError.apply(console, arguments);
  };

  function call(method, args) {
    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ kind: "call", id, method, args: args || [] });
    });
  }

  // Every button, field and link the person can see must be the thing a click lands on. A
  // layer marked hidden whose CSS still displays it (`.box { display: grid }` beats the
  // `hidden` attribute) sits invisibly on top and swallows every click under it.
  function clickableCheck() {
    const started = performance.now();
    const problems = [];
    for (const el of document.querySelectorAll("[hidden]")) {
      if (getComputedStyle(el).display !== "none") problems.push(`${describe(el)} is marked hidden but its CSS still shows it (add [hidden] { display: none !important; })`);
    }
    const controls = document.querySelectorAll("button, input:not([type=hidden]):not([type=file]), select, textarea, a[href], [role=button], [tabindex]:not([tabindex='-1'])");
    for (const el of controls) {
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0" || style.pointerEvents === "none" || el.closest("[inert]")) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || clipped(el, x, y)) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || el.contains(hit) || hit.contains(el)) continue;
      problems.push(`${describe(el)} cannot be clicked: ${describe(hit)} is on top of it`);
      if (problems.length >= 5) break;
    }
    const ms = Math.round(performance.now() - started);
    if (!problems.length) return { name: "every visible control can be clicked", ok: true, ms };
    return { name: "every visible control can be clicked", ok: false, ms, error: problems.join("\n").slice(0, 1000) };
  }

  function clipped(el, x, y) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflow === "visible") continue;
      const r = p.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return true;
    }
    return false;
  }

  function describe(el) {
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  }

  async function runTests() {
    const results = [clickableCheck()];
    for (const t of tests) {
      const started = performance.now();
      try {
        await Promise.race([
          Promise.resolve().then(t.fn),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 10 s")), 10000)),
        ]);
        results.push({ name: t.name, ok: true, ms: Math.round(performance.now() - started) });
      } catch (err) {
        results.push({ name: t.name, ok: false, ms: Math.round(performance.now() - started), error: text(err).slice(0, 1000) });
      }
    }
    return results;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.rosalena !== 1) return;
    if (msg.kind === "hello") {
      api.host = { id: msg.id, permissions: msg.permissions || [], theme: msg.theme || null, verifying: msg.verifying === true };
      connected = true;
      for (const queued of queue.splice(0)) window.parent.postMessage(queued, "*");
      resolveConnected(api.host);
      if (msg.theme) emit("theme", msg.theme);
      return;
    }
    if (msg.kind === "result") {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error || "refused"));
      return;
    }
    if (msg.kind === "theme") {
      if (api.host) api.host.theme = msg.theme;
      emit("theme", msg.theme);
      return;
    }
    if (msg.kind === "run-tests") {
      runTests().then((results) => post({ kind: "test-results", results }));
    }
  });

  function emit(name, payload) {
    for (const fn of listeners.get(name) || []) {
      try {
        fn(payload);
      } catch (err) {
        report("error", text(err));
      }
    }
  }

  const toBase64 = (buffer) => {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };

  const api = {
    version: 1,
    host: null,
    whenConnected,
    ready() {
      if (readySent) return;
      readySent = true;
      post({ kind: "ready" });
    },
    test(name, fn) {
      if (typeof fn !== "function") throw new Error("Rosalena.test needs a function");
      tests.push({ name: String(name), fn });
    },
    assert(condition, message) {
      if (!condition) throw new Error(message || "assertion failed");
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
      if (name === "theme" && api.host && api.host.theme) fn(api.host.theme);
    },
    storage: {
      get: (key) => call("storage.get", [String(key)]),
      set: (key, value) => call("storage.set", [String(key), value]),
      remove: (key) => call("storage.remove", [String(key)]),
      keys: () => call("storage.keys", []),
    },
    files: {
      async save(name, data, type) {
        let blob = data;
        if (!(blob instanceof Blob)) blob = new Blob([data], { type: type || "application/octet-stream" });
        const dataBase64 = toBase64(await blob.arrayBuffer());
        return call("files.save", [String(name), dataBase64, type || blob.type || "application/octet-stream"]);
      },
    },
    chat: {
      compose: (value) => call("chat.compose", [String(value)]),
    },
    theme: {
      set: (tokens) => call("theme.set", [tokens || {}]),
      reset: () => call("theme.reset", []),
      get: () => call("theme.get", []),
    },
    appearance: {
      get: () => call("appearance.get", []),
      set: (patch) => call("appearance.set", [patch || {}]),
    },
  };

  window.Rosalena = api;
})();
