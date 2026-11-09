// SolBrowser content-script core — runs in EVERY frame (all_frames), at
// document_start, in the extension's isolated world. A content script has full
// DOM access to its own frame whatever the origin, which is what makes
// cross-origin iframes readable (D-002).
//
// Defines globalThis.__sol, shared by every content/*.js file:
//   register(op, fn)      add a content-script op (fn(args) -> result | Promise)
//   CsError(code, msg)    error with a code the server maps
//   tagOf(el)             uppercased tag name (P-025)
//   parentOf(el)          parent element, crossing shadow boundaries
//   collectRoots()        document + every OPEN shadow root (P-013)
//   frameOffset()         this frame's offset in the top viewport (D-005)
//   iframeRefFor(win)     parent side: ref of the <iframe> whose contentWindow is win
//   parentIframeRef()     child side: ask the parent for our <iframe>'s ref
//   refs.idFor/get/prune  per-frame element refs (WeakMap + WeakRef)
//   rev / viewRev         DOM-mutation and scroll/resize revision counters
//   whenBody()            resolves once document.body exists
//   loaded                Set other files can use as an install-once guard
//
// Every file is wrapped in a block so a second injection (manifest +
// programmatic, P-006) never redeclares top-level bindings.

if (!globalThis.__sol?.alive?.()) {
  const OFFSET_TIMEOUT_MS = 500;
  const MAX_ROOTS = 500;

  const ops = new Map();

  class CsError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  // tagName is only uppercase for HTML elements in HTML documents: lowercase in
  // <svg>, and everything is lowercase in XHTML. Compare through this (P-025).
  const tagOf = (el) => (el?.tagName || "").toUpperCase();

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode?.();
    return root && root.host ? root.host : null;
  }

  // ------------------------------------------------------------- revisions
  // rev bumps on any DOM mutation, viewRev on scroll/resize, so "unchanged
  // since rev N" is O(1). Mutations inside shadow roots do not reach a
  // document observer, so collectRoots() also observes each open root it finds.

  const sol = {
    rev: 0,
    viewRev: 0,
  };
  const observer = new MutationObserver(() => {
    sol.rev++;
  });
  const OBSERVE = { subtree: true, childList: true, attributes: true, characterData: true };
  const observedRoots = new WeakSet();
  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    try {
      observer.observe(root, OBSERVE);
    } catch {}
  }
  observeRoot(document);
  const bumpView = () => {
    sol.viewRev++;
  };
  addEventListener("scroll", bumpView, { capture: true, passive: true });
  addEventListener("resize", bumpView, { passive: true });

  // ------------------------------------------------------------------- roots

  function collectRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length && roots.length < MAX_ROOTS; i++) {
      let els;
      try {
        els = roots[i].querySelectorAll("*");
      } catch {
        continue;
      }
      for (const el of els) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          observeRoot(el.shadowRoot);
        }
        if (roots.length >= MAX_ROOTS) break;
      }
    }
    return roots;
  }

  // -------------------------------------------------------------------- refs
  // Stable, increasing per-frame integers. The WeakMap keeps no element alive;
  // the WeakRef lets a ref resolve while its element exists. A ref whose
  // element is gone or detached resolves to null (the server says STALE_REF).

  let nextRef = 1;
  const idOf = new WeakMap();
  const byId = new Map();

  const refs = {
    /**
     * Continue numbering after the highest ref a previous document of this
     * frame handed out (the worker sends it with every op), so an old page's
     * ref can never name an element of the new page (P-051).
     */
    floor(n) {
      if (Number.isInteger(n) && n >= nextRef) nextRef = n + 1;
    },
    get max() {
      return nextRef - 1;
    },
    idFor(el) {
      let id = idOf.get(el);
      if (id) return id;
      id = nextRef++;
      idOf.set(el, id);
      byId.set(id, new WeakRef(el));
      return id;
    },
    get(id) {
      const n = Number(id);
      const el = byId.get(n)?.deref();
      if (!el) {
        byId.delete(n);
        return null;
      }
      return el.isConnected ? el : null;
    },
    /** Drop refs whose element was collected or is no longer in the document. */
    prune() {
      let removed = 0;
      for (const [id, ref] of byId) {
        const el = ref.deref();
        if (!el || !el.isConnected) {
          byId.delete(id);
          if (el) idOf.delete(el);
          removed++;
        }
      }
      return removed;
    },
    get size() {
      return byId.size;
    },
  };

  // --------------------------------------------------------------- whenBody
  // Scripts run at document_start, before <body> exists. Ops that need the DOM
  // await this themselves.

  let bodyPromise = null;
  function whenBody() {
    if (document.body) return Promise.resolve(document.body);
    if (!bodyPromise) {
      bodyPromise = new Promise((resolve) => {
        const check = () => {
          if (!document.body) return false;
          mo.disconnect();
          document.removeEventListener("DOMContentLoaded", check);
          resolve(document.body);
          return true;
        };
        const mo = new MutationObserver(check);
        mo.observe(document, { childList: true, subtree: true });
        document.addEventListener("DOMContentLoaded", check);
        check();
      });
    }
    return bodyPromise;
  }

  // ------------------------------------------------------------ frame offset
  // D-005: a cross-origin child cannot read window.frameElement, but it CAN
  // postMessage its parent, and the parent (we are injected there too) finds
  // which of its iframes asked by comparing contentWindow identity. Composes
  // recursively; never cached, because scrolling invalidates it (P-004).

  let nonceCounter = 0;
  const newNonce = () => `sb-${Date.now()}-${nonceCounter++}-${Math.random().toString(36).slice(2)}`;

  /** Post `type` to the parent and await the reply `replyType` with the same nonce. */
  function askParent(type, replyType, extra, budget, fallback) {
    return new Promise((resolve) => {
      const nonce = newNonce();
      const done = (value) => {
        clearTimeout(timer);
        removeEventListener("message", onMessage);
        resolve(value);
      };
      const timer = setTimeout(() => done(fallback), budget);
      function onMessage(ev) {
        // Only our parent may answer. postMessage also reaches the parent's
        // MAIN world, so the page can read the nonce (P-026).
        if (ev.source !== window.parent) return;
        const d = ev.data;
        if (!d || d.type !== replyType || d.nonce !== nonce) return;
        done(d);
      }
      addEventListener("message", onMessage);
      try {
        window.parent.postMessage({ type, nonce, ...extra }, "*");
      } catch {
        done(fallback);
      }
    });
  }

  /**
   * @param {number} [deadline] absolute ms timestamp shared by the whole chain,
   *   so a 3-deep nest does not time out at the bottom as its parent answers.
   * @returns {Promise<{x:number, y:number, known:boolean, ref?:number}>}
   *   ref is the parent's ref for our <iframe> element, when known.
   */
  async function frameOffset(deadline) {
    if (window === window.top) return { x: 0, y: 0, sx: 1, sy: 1, known: true };
    const budget = Math.max(50, (deadline ?? Date.now() + OFFSET_TIMEOUT_MS) - Date.now());
    const fallback = { x: 0, y: 0, sx: 1, sy: 1, known: false };
    const d = await askParent("solbridge:whereami", "solbridge:youare", { deadline: Date.now() + budget }, budget, fallback);
    if (d === fallback) return fallback;
    const scale = (v) => (Number.isFinite(v) && v > 0 ? v : 1);
    const out = { x: d.x, y: d.y, sx: scale(d.sx), sy: scale(d.sy), known: !!d.known };
    if (Number.isInteger(d.ref)) out.ref = d.ref;
    return out;
  }

  /**
   * Where an <iframe>'s viewport starts in THIS frame's viewport, and how many
   * of our CSS px one of its CSS px covers (P-050). The child viewport is the
   * content box: inside the border (clientLeft) AND the padding (P-004).
   * getBoundingClientRect is transformed / zoomed while offsetWidth, clientLeft
   * and the computed padding are not, so their ratio is the ancestors' scale
   * (transform: scale, CSS zoom). Rotation is not modelled.
   */
  function frameBox(frameEl) {
    const r = frameEl.getBoundingClientRect();
    const ratio = (a, b) => {
      const v = a > 0 && b > 0 ? a / b : 1;
      return Math.abs(v - 1) < 0.002 ? 1 : v;
    };
    const sx = ratio(r.width, frameEl.offsetWidth);
    const sy = ratio(r.height, frameEl.offsetHeight);
    const cs = getComputedStyle(frameEl);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    return { x: r.left + (frameEl.clientLeft + padL) * sx, y: r.top + (frameEl.clientTop + padT) * sy, sx, sy };
  }

  /** A frame-local point -> top viewport, through a frameOffset() result. */
  const toTopXY = (off, x, y) => ({ x: off.x + (off.sx ?? 1) * x, y: off.y + (off.sy ?? 1) * y });

  /** Child side: which ref does our <iframe> element have in the parent frame? */
  async function parentIframeRef() {
    if (window === window.top) return { ref: null, isTop: true };
    const d = await askParent("solbridge:whichref", "solbridge:yourref", {}, OFFSET_TIMEOUT_MS, null);
    return { ref: Number.isInteger(d?.ref) ? d.ref : null, isTop: false };
  }

  function matchIframe(list, sourceWindow) {
    for (const f of list) {
      // Reference equality on a cross-origin window is permitted; reading
      // anything else off it is not.
      if (f.contentWindow === sourceWindow) return f;
    }
    return null;
  }

  function iframeFor(sourceWindow) {
    // Fast path: almost every iframe is in the light DOM.
    const quick = matchIframe(document.querySelectorAll("iframe,frame"), sourceWindow);
    if (quick) return quick;
    for (const root of collectRoots()) {
      let list;
      try {
        list = root.querySelectorAll("iframe,frame");
      } catch {
        continue;
      }
      const hit = matchIframe(list, sourceWindow);
      if (hit) return hit;
    }
    return null;
  }

  /** Parent side of the handshake: the ref of the <iframe> hosting `sourceWindow`, or null. */
  function iframeRefFor(sourceWindow) {
    const el = iframeFor(sourceWindow);
    return el ? refs.idFor(el) : null;
  }

  addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || !ev.source || typeof d.type !== "string") return;
    if (d.type !== "solbridge:whereami" && d.type !== "solbridge:whichref") return;
    if (!alive()) return; // orphaned by an extension reload: let the fresh copy answer

    const reply = (type, payload) => {
      try {
        ev.source.postMessage({ type, nonce: d.nonce, ...payload }, "*");
      } catch {}
    };

    const frameEl = iframeFor(ev.source);
    if (d.type === "solbridge:whichref") {
      return reply("solbridge:yourref", { ref: frameEl ? refs.idFor(frameEl) : null });
    }

    if (!frameEl) return reply("solbridge:youare", { x: 0, y: 0, known: false });
    const ref = refs.idFor(frameEl);
    const own = await frameOffset(d.deadline);
    // known:false means "rects stay frame-local" and the server repairs with an
    // ABSOLUTE offset; a partial offset here would double-count (P-004).
    if (!own.known) return reply("solbridge:youare", { x: 0, y: 0, known: false, ref });
    // Removed while we awaited: a detached element's rect is all zeros.
    if (!frameEl.isConnected) return reply("solbridge:youare", { x: 0, y: 0, known: false, ref });
    // Child viewport origin and scale in our viewport (border + padding,
    // transform/zoom: P-004, P-050), composed with our own offset in the top.
    const b = frameBox(frameEl);
    const osx = own.sx ?? 1;
    const osy = own.sy ?? 1;
    reply("solbridge:youare", {
      x: own.x + osx * b.x,
      y: own.y + osy * b.y,
      sx: osx * b.sx,
      sy: osy * b.sy,
      known: true,
      ref,
    });
  });

  // ------------------------------------------------------------------ router

  function register(op, fn) {
    if (typeof op !== "string" || typeof fn !== "function") throw new TypeError("register(op, fn)");
    ops.set(op, fn);
  }

  register("ping", () => ({
    pong: true,
    url: location.href,
    isTop: window === window.top,
    readyState: document.readyState,
    rev: sol.rev,
    viewRev: sol.viewRev,
    ops: [...ops.keys()],
  }));
  register("offset", () => frameOffset());
  register("iframeRef", () => parentIframeRef());

  // Captured at install: after an extension reload this script is orphaned and
  // chrome.runtime.id goes undefined, letting a fresh injection replace us.
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.op !== "string" || msg.target || msg.cs) return false;
    const fn = ops.get(msg.op);
    refs.floor(msg.refBase);
    Promise.resolve()
      .then(() => {
        if (!fn) throw new CsError("BAD_ARGS", `Unknown content-script op "${msg.op}"`);
        return fn(msg.args || {});
      })
      // maxRef: the worker remembers it per frame and hands it to the next document (P-051).
      .then((result) => sendResponse({ ok: true, result, maxRef: refs.max }))
      .catch((e) => sendResponse({ ok: false, error: { code: e?.code || "EXTENSION_ERROR", message: String(e?.message || e) }, maxRef: refs.max }));
    return true; // async: offsets round-trip to the parent
  });

  globalThis.__sol = Object.assign(sol, {
    register,
    CsError,
    tagOf,
    parentOf,
    collectRoots,
    frameOffset,
    frameBox,
    toTopXY,
    iframeRefFor,
    parentIframeRef,
    refs,
    whenBody,
    alive,
    loaded: new Set(),
  });

  // Feed the worker's frame registry (frameId/documentId come from the sender),
  // so ext.frames needs no pings. Orphaned contexts throw synchronously.
  try {
    chrome.runtime.sendMessage({ cs: "hello", isTop: window === window.top, url: location.href }).catch(() => {});
  } catch {}
}
