// Wait ops (track C), event-driven: MutationObserver plus deadline timers, no
// polling loops (the one rAF is a bounded "let layout land" step in settle).
//
//   waitFor {text? | selector? | ref?, gone?, timeoutMs?, token?}
//     -> {found:true, ms, ref?, tag?} once the condition holds in THIS frame
//        (gone: once it no longer holds), {found:false, timedOut:true, ms} at the
//        deadline, {found:false, cancelled:true} after waitCancel.
//        text: case-insensitive, whitespace-normalized substring of the frame's
//        rendered text (innerText, so <script> source and display:none never match).
//        selector: a VISIBLE match in the document or an open shadow root.
//        ref: this frame's ref id (core.js refs); appear = visible, gone = removed/hidden.
//   waitCancel {token} -> {cancelled:n}   the server's "another frame already matched"
//   settle {quietMs=100, maxMs=1500} -> {settled, ms, mutations}
//        resolves after quietMs without DOM mutations (or at maxMs), then one
//        animation frame (capped at 50 ms) so layout has landed.

if (globalThis.__sol && !globalThis.__sol.loaded.has("wait")) {
  globalThis.__sol.loaded.add("wait");
  const { register, CsError, collectRoots, refs, tagOf } = globalThis.__sol;

  const OBSERVE = { subtree: true, childList: true, attributes: true, characterData: true };
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK"]);
  const MAX_TIMEOUT_MS = 120_000;

  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const now = () => performance.now();
  /** token -> Set of cancel functions (one per waitFor sharing the token) */
  const active = new Map();

  function visible(el) {
    if (!el || !el.isConnected) return false;
    try {
      if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } catch {}
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ------------------------------------------------------------ observing

  /**
   * Run check() now and after every DOM mutation batch (document + open shadow
   * roots, including roots added later), until it returns a truthy result or
   * the deadline passes. Expensive checks are spaced by 4x their own cost so a
   * page that mutates every frame cannot pin the CPU; the trailing check makes
   * sure the last mutation is always looked at.
   */
  function observeUntil(check, { timeoutMs, token }) {
    return new Promise((resolve, reject) => {
      const t0 = now();
      let done = false;
      let trailing = null;
      let lastRun = -Infinity;
      let gap = 0;
      const roots = new Set();
      const mo = new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) addShadowRoots(n);
        run();
      });
      function addRoot(root) {
        if (roots.has(root)) return;
        roots.add(root);
        try {
          mo.observe(root, OBSERVE);
        } catch {}
      }
      function addShadowRoots(el) {
        if (el.shadowRoot) addRoot(el.shadowRoot);
        if (!el.firstElementChild) return;
        for (const d of el.querySelectorAll("*")) if (d.shadowRoot) addRoot(d.shadowRoot);
      }
      for (const root of collectRoots()) addRoot(root);
      // CSS-driven visibility changes mutate nothing; their end events do fire.
      const onAnim = () => run();
      addEventListener("transitionend", onAnim, true);
      addEventListener("animationend", onAnim, true);

      const cancels = token ? active.get(token) || new Set() : null;
      const cancel = () => finish({ found: false, cancelled: true });
      if (cancels) {
        cancels.add(cancel);
        active.set(token, cancels);
      }
      const deadline = setTimeout(() => finish({ found: false, timedOut: true }), Math.max(0, timeoutMs));

      function cleanup() {
        done = true;
        mo.disconnect();
        clearTimeout(deadline);
        clearTimeout(trailing);
        removeEventListener("transitionend", onAnim, true);
        removeEventListener("animationend", onAnim, true);
        if (cancels) {
          cancels.delete(cancel);
          if (!cancels.size) active.delete(token);
        }
      }
      function finish(result) {
        if (done) return;
        cleanup();
        resolve({ ...result, ms: Math.round(now() - t0) });
      }
      function run() {
        if (done) return;
        const wait = lastRun + gap - now();
        if (wait > 0) {
          if (!trailing) {
            trailing = setTimeout(() => {
              trailing = null;
              run();
            }, wait);
          }
          return;
        }
        const s = now();
        lastRun = s;
        let hit;
        try {
          hit = check();
        } catch (e) {
          cleanup();
          reject(e);
          return;
        }
        gap = Math.min(250, 4 * (now() - s));
        if (hit) finish({ found: true, ...hit });
      }
      run();
    });
  }

  // ------------------------------------------------------------ conditions

  /** Rendered text of the frame, open shadow roots included (innerText stops at them). */
  function frameText() {
    const parts = [];
    const top = document.body || document.documentElement;
    if (top) parts.push(top.innerText || "");
    const roots = collectRoots();
    for (let i = 1; i < roots.length; i++) {
      for (const el of roots[i].children) if (!SKIP.has(tagOf(el))) parts.push(el.innerText || "");
    }
    return norm(parts.join("\n"));
  }

  /** Deepest rendered element whose text contains q (for the ref in the result). */
  function locateText(q) {
    let el = document.body || document.documentElement;
    if (!el) return null;
    outer: for (let depth = 0; depth < 200; depth++) {
      for (const c of el.children) {
        if (SKIP.has(tagOf(c))) continue;
        // innerText of an element that is not rendered is its raw textContent.
        if (c.checkVisibility && !c.checkVisibility()) continue;
        if (norm(c.innerText).includes(q)) {
          el = c;
          continue outer;
        }
      }
      break;
    }
    return el === document.body || el === document.documentElement ? null : el;
  }

  function firstVisible(selector) {
    for (const root of collectRoots()) {
      for (const el of root.querySelectorAll(selector)) if (visible(el)) return el;
    }
    return null;
  }

  const hitFor = (el) => (el ? { ref: refs.idFor(el), tag: tagOf(el).toLowerCase() } : {});
  /** A text hit also carries the matched element's own text (clipped), so the
   * caller sees what matched without another read (T5 of the A14 benchmark). */
  const textHitFor = (el) => {
    if (!el) return {};
    const t = String(el.innerText ?? "").replace(/\s+/g, " ").trim();
    return { ...hitFor(el), text: t.length > 160 ? `${t.slice(0, 159)}…` : t };
  };

  register("waitFor", async (args = {}) => {
    const { text, selector, ref, gone = false } = args;
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(0, Number(args.timeoutMs ?? 5000)));
    const opts = { timeoutMs, token: args.token };

    if (text != null && text !== "") {
      const q = norm(text);
      return observeUntil(() => {
        const present = frameText().includes(q);
        if (gone) return present ? null : { gone: true };
        return present ? textHitFor(locateText(q)) : null;
      }, opts);
    }

    if (selector) {
      try {
        document.querySelector(selector);
      } catch {
        throw new CsError("BAD_ARGS", `invalid CSS selector: ${selector}`);
      }
      return observeUntil(() => {
        const el = firstVisible(selector);
        if (gone) return el ? null : { gone: true };
        return el ? hitFor(el) : null;
      }, opts);
    }

    if (ref != null) {
      const el = refs.get(ref);
      if (!el) {
        if (gone) return { found: true, gone: true, ms: 0 };
        throw new CsError("STALE_REF", `ref ${ref} no longer exists in this frame; take a new snapshot`);
      }
      return observeUntil(() => {
        if (gone) return visible(el) ? null : { gone: true };
        if (!el.isConnected) throw new CsError("STALE_REF", `ref ${ref} was removed from the page; take a new snapshot`);
        return visible(el) ? hitFor(el) : null;
      }, opts);
    }

    throw new CsError("BAD_ARGS", "waitFor needs text, selector or ref");
  });

  register("waitCancel", ({ token } = {}) => {
    const set = active.get(token);
    const n = set ? set.size : 0;
    if (set) for (const cancel of [...set]) cancel();
    return { cancelled: n };
  });

  // ---------------------------------------------------------------- settle

  register("settle", ({ quietMs = 100, maxMs = 1500 } = {}) => {
    const t0 = now();
    return new Promise((resolve) => {
      let mutations = 0;
      let done = false;
      let quiet = null;
      const mo = new MutationObserver((records) => {
        mutations += records.length;
        arm();
      });
      for (const root of collectRoots()) {
        try {
          mo.observe(root, OBSERVE);
        } catch {}
      }
      const cap = setTimeout(() => finish(false), Math.max(0, maxMs));
      function arm() {
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(true), Math.max(0, quietMs));
      }
      function finish(settled) {
        if (done) return;
        done = true;
        mo.disconnect();
        clearTimeout(quiet);
        clearTimeout(cap);
        const out = () => resolve({ settled, ms: Math.round(now() - t0), mutations });
        if (!settled) return out();
        // One frame so layout has landed; hidden tabs get no rAF, so cap it.
        let fired = false;
        const once = () => {
          if (fired) return;
          fired = true;
          out();
        };
        requestAnimationFrame(once);
        setTimeout(once, 50);
      }
      arm();
    });
  });
}
