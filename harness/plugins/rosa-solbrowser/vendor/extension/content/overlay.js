// Set-of-Marks overlay and ref geometry (track E).
//
//   op "overlay" {action:"show", labels:[[id, "e12"], ...], top?:{w,h}, doc?}
//       Draws a box and a label for each ref'd element that is on screen, then
//       resolves once the frame has painted (two rAFs, capped for hidden tabs).
//       top: the top-level viewport size; elements whose box lands outside it
//       (after this frame's offset) get no label, so the legend matches the image.
//       -> {drawn:[{id, x, y, w, h}], offset:{x, y, known}, stale:[ids], offscreen:n}
//          x/y are top-viewport CSS px when offset.known, else frame-local.
//   op "overlay" {action:"clear"}  removes everything drawn. -> {cleared}
//   op "refRect" {id, doc?, scroll?:true}  the element's box in top-viewport CSS px.
//       scroll: bring it into view first when it is not fully visible.
//       -> {x, y, w, h, known, scrolled}
//
// The overlay is one host element on <html> (outside <body>, so the snapshot
// walk never sees it), aria-hidden, with a CLOSED shadow root and inline styles
// so page CSS cannot restyle it. It is shown as a manual popover so it sits in
// the top layer, above the page's modal <dialog>s. It exists only between show
// and clear: nothing is left in the page.
//
// Must stay a block so a second injection never redeclares bindings (P-006).

if (globalThis.__sol && !globalThis.__sol.loaded?.has("overlay")) {
  globalThis.__sol.loaded?.add("overlay");
  const sol = globalThis.__sol;
  const { register, CsError, refs, whenBody } = sol;

  const PAINT_CAP_MS = 120;
  const LABEL_H = 14;
  // High-contrast backgrounds for white text; cycled so neighbours differ.
  const COLORS = ["#d6005c", "#0050d0", "#007a3d", "#b35900", "#7a00cc", "#00737a", "#c40000", "#4d5c00"];

  let host = null;

  function checkDoc(doc) {
    if (doc && sol.docKey && doc !== sol.docKey) {
      throw new CsError("STALE_REF", "That ref belongs to a document this frame has since navigated away from. Take a new snapshot.");
    }
  }

  function clear() {
    const had = !!host;
    if (host) {
      try {
        if (host.matches(":popover-open")) host.hidePopover();
      } catch {}
      host.remove();
      host = null;
    }
    return { cleared: had };
  }

  function makeHost() {
    clear();
    const h = document.createElement("solbrowser-marks");
    h.setAttribute("aria-hidden", "true");
    h.setAttribute("popover", "manual");
    h.style.cssText =
      "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;" +
      "background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;display:block;";
    const root = h.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
      ".b{position:fixed;box-sizing:border-box;border:2px solid var(--c);border-radius:2px;pointer-events:none}" +
      `.l{position:fixed;box-sizing:border-box;height:${LABEL_H}px;padding:0 3px;background:var(--c);color:#fff;` +
      `font:bold 11px/${LABEL_H}px ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;border-radius:2px;pointer-events:none}`;
    root.appendChild(style);
    (document.documentElement || document).appendChild(h);
    // Top layer: above the page's modal dialogs and popovers.
    try {
      h.showPopover();
    } catch {}
    host = h;
    return root;
  }

  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /** Label spot near the box's top-left that does not cover an earlier label. */
  function placeLabel(r, w, placed, vw, vh) {
    const cands = [
      { x: r.left, y: r.top - LABEL_H }, // above, left-aligned
      { x: r.left, y: r.top }, // inside top-left
      { x: r.right - w, y: r.top - LABEL_H }, // above, right-aligned
      { x: r.left, y: r.bottom }, // below
      { x: r.right - w, y: r.top }, // inside top-right
    ];
    const fit = (c) => ({ x: Math.max(0, Math.min(c.x, vw - w)), y: Math.max(0, Math.min(c.y, vh - LABEL_H)), w, h: LABEL_H });
    for (const c of cands) {
      const box = fit(c);
      if (!placed.some((p) => overlaps(p, box))) return box;
    }
    return fit(cands[0]);
  }

  /** Resolve after the frame has painted; hidden tabs get no rAF, so cap it. */
  const painted = () =>
    new Promise((resolve) => {
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(once));
      setTimeout(once, PAINT_CAP_MS);
    });

  async function show({ labels = [], top, doc } = {}) {
    checkDoc(doc);
    await whenBody();
    const offset = top && window !== window.top ? await sol.frameOffset() : { x: 0, y: 0, known: true };
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    const items = [];
    const stale = [];
    let offscreen = 0;
    for (const [id, text] of labels) {
      const el = refs.get(id);
      if (!el) {
        stale.push(id);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) {
        offscreen++;
        continue;
      }
      if (top && offset.known) {
        const t = sol.toTopXY(offset, r.left, r.top);
        if (t.x + r.width * (offset.sx ?? 1) <= 0 || t.y + r.height * (offset.sy ?? 1) <= 0 || t.x >= top.w || t.y >= top.h) {
          offscreen++;
          continue;
        }
      }
      items.push({ id, text: String(text), r });
    }
    if (!items.length) {
      clear();
      return { drawn: [], offset, stale, offscreen };
    }
    const root = makeHost();
    const frag = document.createDocumentFragment();
    const placed = [];
    const drawn = [];
    // Frame-local -> top viewport, including a scaled/zoomed ancestor (P-050).
    const k = offset.known ? offset : { x: 0, y: 0, sx: 1, sy: 1 };
    const sx = k.sx ?? 1;
    const sy = k.sy ?? 1;
    items.forEach(({ id, text, r }, i) => {
      const color = COLORS[i % COLORS.length];
      const box = document.createElement("div");
      box.className = "b";
      box.style.cssText = `--c:${color};left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      const w = 8 + text.length * 7;
      const spot = placeLabel(r, w, placed, vw, vh);
      placed.push(spot);
      const lab = document.createElement("div");
      lab.className = "l";
      lab.style.cssText = `--c:${color};left:${spot.x}px;top:${spot.y}px;min-width:${w}px`;
      lab.textContent = text;
      frag.append(box, lab);
      drawn.push({ id, x: Math.round(k.x + sx * r.left), y: Math.round(k.y + sy * r.top), w: Math.round(r.width * sx), h: Math.round(r.height * sy), lx: Math.round(k.x + sx * spot.x), ly: Math.round(k.y + sy * spot.y) });
    });
    root.appendChild(frag);
    await painted();
    return { drawn, offset, stale, offscreen };
  }

  register("overlay", (args = {}) => {
    if (args.action === "clear") return clear();
    if (args.action === "show") return show(args);
    throw new CsError("BAD_ARGS", 'overlay action must be "show" or "clear"');
  });

  register("refRect", async ({ id, doc, scroll = true } = {}) => {
    checkDoc(doc);
    const el = refs.get(id);
    if (!el) throw new CsError("STALE_REF", `Ref ${id} no longer exists in this frame. Take a new snapshot.`);
    let r = el.getBoundingClientRect();
    let scrolled = false;
    const inView = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    if (scroll && !inView && r.width > 0 && r.height > 0) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
      scrolled = true;
    }
    if (r.width <= 0 || r.height <= 0) throw new CsError("NOT_ACTIONABLE", `Ref ${id} has no visible box.`);
    const off = await sol.frameOffset();
    const t = sol.toTopXY(off, r.left, r.top);
    return { x: t.x, y: t.y, w: r.width * (off.sx ?? 1), h: r.height * (off.sy ?? 1), known: off.known, scrolled };
  });
}
