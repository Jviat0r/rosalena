// find + extract ops, moved from v1 content.js with behaviour unchanged;
// matches now also carry `ref` (this frame's ref id, see core.js refs).

if (globalThis.__sol) {
  const { register, CsError, tagOf, parentOf, collectRoots, frameOffset, refs } = globalThis.__sol;

  const MAX_TEXT = 200;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TITLE", "TEMPLATE", "HEAD", "META", "LINK"]);

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // -------------------------------------------------------------------- find

  function valueOf(el) {
    const tag = tagOf(el);
    if (tag === "INPUT") {
      if ((el.getAttribute("type") || "").toLowerCase() === "password") return null; // never surface secrets
      return el.value;
    }
    if (tag === "TEXTAREA") return el.value;
    if (tag === "SELECT") return el.selectedOptions?.[0]?.textContent;
    return null;
  }

  function haystacks(el, ownText) {
    return [
      ownText,
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("title"),
      valueOf(el),
    ].filter(Boolean);
  }

  const hit = (hay, q, exact) => (exact ? norm(hay) === q : norm(hay).includes(q));

  const IMPLICIT_ROLES = {
    BUTTON: "button",
    A: "link",
    TEXTAREA: "textbox",
    SELECT: "combobox",
    OPTION: "option",
    H1: "heading",
    H2: "heading",
    H3: "heading",
    H4: "heading",
    H5: "heading",
    H6: "heading",
    SUMMARY: "button",
  };

  function roleOf(el) {
    const explicit = el.getAttribute?.("role");
    if (explicit) return explicit.trim().toLowerCase();
    const tag = tagOf(el);
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      return "textbox";
    }
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    return IMPLICIT_ROLES[tag] || null;
  }

  const satisfiesRole = (el, want) => roleOf(el) === want.trim().toLowerCase();

  function textFor(el, ownText) {
    const candidates = [
      ownText,
      clean(el.textContent),
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("value"),
      valueOf(el),
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("title"),
    ];
    for (const c of candidates) {
      const t = clean(c);
      if (t) return t.slice(0, MAX_TEXT);
    }
    return "";
  }

  async function findOp({ query, role, exact = false, limit = 10 }) {
    if (!query) throw new CsError("BAD_ARGS", "query is required");
    const q = norm(query);

    // Start the offset round-trip NOW so it overlaps the DOM work. Awaiting it
    // afterwards would let up to 500ms of scrolling happen between measuring
    // the rects and shifting them.
    const offsetPromise = frameOffset();

    const roots = collectRoots();
    const ownTexts = new Map(); // Element -> concatenated own text nodes
    let candidates = new Set();

    // Pass 1 — text. Walking TEXT nodes and grouping by parent is O(text) and
    // handles text split across several nodes inside one element. Walking every
    // element and reading textContent instead would be O(n^2) on a big app.
    for (const root of roots) {
      let walker;
      try {
        walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      } catch {
        continue;
      }
      let node;
      while ((node = walker.nextNode())) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.has(tagOf(p))) continue;
        ownTexts.set(p, (ownTexts.get(p) || "") + node.data);
      }
    }
    for (const [el, text] of ownTexts) {
      if (hit(text, q, exact)) candidates.add(el);
    }

    // Pass 2 — attributes and input values, over a small selector set.
    for (const root of roots) {
      let els;
      try {
        els = root.querySelectorAll("[aria-label],[placeholder],[title],[role],input,textarea,select");
      } catch {
        continue;
      }
      for (const el of els) {
        if (SKIP_TAGS.has(tagOf(el))) continue;
        if (haystacks(el, ownTexts.get(el)).some((h) => hit(h, q, exact))) candidates.add(el);
      }
    }

    // Pass 3 — slow, only when the fast passes found nothing: catches text
    // split across child elements ("<b>Outer</b> button").
    if (candidates.size === 0) {
      for (const root of roots) {
        let els;
        try {
          els = root.querySelectorAll("*");
        } catch {
          continue;
        }
        for (const el of els) {
          if (SKIP_TAGS.has(tagOf(el))) continue;
          const t = el.textContent;
          if (!t || t.length > 300) continue;
          if (hit(t, q, exact)) candidates.add(el);
        }
      }
    }

    // Role filter, with a short climb: Fluent-style buttons keep their label in
    // a child span, so the text match is the span but the button is the target.
    if (role) {
      const resolved = new Set();
      for (const el of candidates) {
        let cur = el;
        for (let depth = 0; cur && depth <= 4; depth++) {
          if (satisfiesRole(cur, role)) {
            resolved.add(cur);
            break;
          }
          cur = parentOf(cur);
        }
      }
      candidates = resolved;
    }

    // Visibility, then rects.
    const visible = [];
    for (const el of candidates) {
      let rect;
      try {
        if (!el.getClientRects || el.getClientRects().length === 0) continue;
        rect = el.getBoundingClientRect();
      } catch {
        continue;
      }
      if (rect.width <= 0 || rect.height <= 0) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      visible.push({ el, rect });
    }

    // Leaf preference: if a descendant also matched, keep the descendant.
    // Walking each match's ancestors is O(n x depth); the obvious
    // contains()-against-every-other version is O(n^2) DOM calls, which stalls
    // on a broad query, and it also cannot see across shadow boundaries.
    const matchedEls = new Set(visible.map((v) => v.el));
    const hasMatchedDescendant = new Set();
    for (const { el } of visible) {
      for (let cur = parentOf(el); cur; cur = parentOf(cur)) {
        if (matchedEls.has(cur)) hasMatchedDescendant.add(cur);
      }
    }
    const leaves = visible.filter((v) => !hasMatchedDescendant.has(v.el));

    const resolved = await offsetPromise;
    // known:false means "rects stay frame-local" — the server repairs them with
    // an absolute offset from CDP, so adding anything here would double-count.
    const offset = resolved.known ? resolved : { x: 0, y: 0, known: false };

    const matches = leaves
      .map(({ el, rect }) => {
        const ownText = ownTexts.get(el);
        return {
          ref: refs.idFor(el),
          tag: el.tagName.toLowerCase(),
          role: roleOf(el),
          text: textFor(el, ownText),
          exactMatch: haystacks(el, ownText).some((h) => norm(h) === q),
          // sx/sy: a scaled or zoomed ancestor of our <iframe> (P-050).
          rect: {
            x: Math.round((offset.x + (offset.sx ?? 1) * rect.left) * 100) / 100,
            y: Math.round((offset.y + (offset.sy ?? 1) * rect.top) * 100) / 100,
            w: Math.round(rect.width * (offset.sx ?? 1) * 100) / 100,
            h: Math.round(rect.height * (offset.sy ?? 1) * 100) / 100,
          },
          attrs: {
            ...(el.id ? { id: el.id } : {}),
            ...(el.getAttribute?.("aria-label") ? { ariaLabel: el.getAttribute("aria-label") } : {}),
            ...(el.getAttribute?.("placeholder") ? { placeholder: el.getAttribute("placeholder") } : {}),
            ...(el.getAttribute?.("title") ? { title: el.getAttribute("title") } : {}),
          },
        };
      })
      .sort((a, b) => {
        if (a.exactMatch !== b.exactMatch) return a.exactMatch ? -1 : 1;
        return a.rect.w * a.rect.h - b.rect.w * b.rect.h;
      });

    return {
      matches: matches.slice(0, limit),
      total: matches.length,
      frameOffsetKnown: offset.known,
      url: location.href,
    };
  }

  // ----------------------------------------------------------------- extract

  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };

  /**
   * mainContent: the element holding the page's prose, without nav, sidebars,
   * cookie banners and footers. <main>/<article>/[role=main] when present (the
   * most text-heavy one), else the block whose <p> children carry the most
   * text (a paragraph scores its parent fully and its grandparent half).
   */
  function mainRoot() {
    const cands = [...document.querySelectorAll("article, main, [role=main]")].filter(shown);
    const len = (el) => (el.innerText || "").length;
    if (cands.length) {
      cands.sort((a, b) => len(b) - len(a));
      const best = cands[0];
      // An <article> inside the chosen <main> that holds most of its text is tighter.
      const inner = cands.find((c) => c !== best && best.contains(c) && len(c) >= 0.6 * len(best));
      return inner || best;
    }
    const score = new Map();
    for (const p of document.querySelectorAll("p")) {
      const n = (p.innerText || "").trim().length;
      if (n < 40) continue;
      const a = p.parentElement;
      if (a) score.set(a, (score.get(a) || 0) + n);
      const b = a?.parentElement;
      if (b) score.set(b, (score.get(b) || 0) + n / 2);
    }
    let best = null;
    let top = 0;
    for (const [el, v] of score) if (v > top && shown(el)) (best = el), (top = v);
    return best || document.body || document.documentElement;
  }

  function extractOp({ selector, maxChars = 16000, offset = 0, mainContent = false }) {
    let el;
    if (selector) {
      try {
        el = document.querySelector(selector);
      } catch {
        throw new CsError("BAD_ARGS", `"${selector}" is not a valid CSS selector.`);
      }
      if (!el) throw new CsError("BAD_ARGS", `No element matches selector "${selector}" in this frame.`);
    } else {
      el = mainContent ? mainRoot() : document.body || document.documentElement;
    }
    const raw = (el.innerText || el.textContent || "").replace(/\n{3,}/g, "\n\n");
    const start = Math.max(0, Math.min(offset, raw.length));
    const text = raw.slice(start, start + maxChars);
    return {
      text,
      truncated: start + text.length < raw.length,
      totalChars: raw.length,
      ...(start ? { offset: start } : {}),
      url: location.href,
      title: document.title,
      ...(mainContent && !selector ? { root: tagOf(el).toLowerCase() + (el.id ? `#${el.id}` : "") } : {}),
    };
  }

  register("find", findOp);
  register("extract", extractOp);
}
