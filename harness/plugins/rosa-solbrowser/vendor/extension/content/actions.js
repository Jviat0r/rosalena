// Action ops (track B): resolve a ref to a clickable top-level point, prepare
// form fields, select options, mark file inputs. Input itself is NEVER
// synthesized here: the server dispatches trusted CDP input (D-001, D-009) at
// the point we return. The exceptions are the ones a real user cannot type
// into: <select> values and date/time/color/range inputs (set + input/change,
// like Playwright's selectOption/fill), and requestSubmit when a form has no
// submit button.
//
//   resolve {ref, doc?, scroll=true, hit=true, enabled=true, focus=false, timeoutMs=2000, position?}
//     -> {x, y, known, rect:{x,y,w,h}, scrolled, desc}   x/y/rect in TOP-level viewport CSS px
//        (frame offset applied, D-004/D-005; known:false = the offset chain failed)
//   fillMany {items:[{ref, value}], doc?, timeoutMs?, verify?:{ref, expect}, submitRef?}
//     Works through items in order. select / date-like fields are set here; it
//     stops at the first field that needs trusted input and returns it prepared:
//     -> {done:[{ref, kind, value}], pending?:{ref, kind:"text", focused, x, y, known, value}
//                                            | {ref, kind:"check", x, y, known}, verified?, submit?}
//   focusField {ref, doc?, clear?, timeoutMs?} -> {kind, focused, x, y, known}   (type {ref})
//   selectAll {ref, clear?} -> {focused}    after a trusted click when focus() did not take
//   selectOption {ref, doc?, values:[...]} -> {selected:[labels], value}
//   markFile {ref, doc?, token} -> {multiple, accept}; unmarkFile {token}
//   scrollTo {ref?, doc?, direction?, amount?, to?, x?, y?} -> {target, moved, x, y, maxX, maxY}
//   submitTarget {ref, doc?} -> {ref} of the form's submit button, or {submitted:true}
//   readValues {refs:[...]} -> {values:{ref: value}}
//   revealChild {ref (an <iframe>), rect} -> {moved, local, frameRef?}   parent side of revealing a child-frame element
//
// Must stay a block so a second injection never redeclares bindings (P-006).

if (globalThis.__sol && !globalThis.__sol.loaded.has("actions")) {
  globalThis.__sol.loaded.add("actions");
  const sol = globalThis.__sol;
  const { register, CsError, tagOf, parentOf, refs, frameOffset } = sol;

  const DEFAULT_TIMEOUT_MS = 2000;
  const MAX_TIMEOUT_MS = 30_000;
  const now = () => performance.now();

  // ------------------------------------------------------------- lookups

  function getEl(ref, doc) {
    if (doc && sol.docKey && doc !== sol.docKey) {
      throw new CsError("STALE_REF", `Ref ${ref} belongs to a page this frame has since navigated away from. Take a new snapshot.`);
    }
    const el = refs.get(ref);
    if (!el) throw new CsError("STALE_REF", `Ref ${ref} no longer exists in this frame.`);
    return el;
  }

  const clip = (s, n = 40) => {
    const t = String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };

  const IMPLICIT = {
    A: (el) => (el.hasAttribute("href") ? "link" : null),
    BUTTON: () => "button",
    SELECT: (el) => (el.multiple || el.size > 1 ? "listbox" : "combobox"),
    TEXTAREA: () => "textbox",
    OPTION: () => "option",
    SUMMARY: () => "button",
    IMG: () => "img",
    IFRAME: () => "iframe",
    INPUT: (el) => {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "file") return "file";
      return "textbox";
    },
  };

  function roleOf(el) {
    const explicit = el.getAttribute?.("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = tagOf(el);
    if (/^H[1-6]$/.test(tag)) return "heading";
    const f = IMPLICIT[tag];
    const r = f ? f(el) : null;
    if (r) return r;
    if (el.isContentEditable) return "textbox";
    return tag.toLowerCase();
  }

  function nameOf(el) {
    const aria = el.getAttribute?.("aria-label");
    if (aria) return aria;
    const lb = el.getAttribute?.("aria-labelledby");
    if (lb) {
      const t = lb
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent || "")
        .join(" ");
      if (t.trim()) return t;
    }
    if (el.labels?.length) return el.labels[0].textContent;
    const tag = tagOf(el);
    if (tag === "INPUT" && ["button", "submit", "reset"].includes((el.type || "").toLowerCase())) return el.value;
    if (tag === "IMG") return el.alt;
    const text = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ? "" : el.innerText || el.textContent;
    return text || el.title || el.placeholder || "";
  }

  function describe(el) {
    if (!el) return "nothing";
    const name = clip(nameOf(el));
    return `${roleOf(el)}${name ? ` "${name}"` : ""}`;
  }

  /** Short identity for "covered by …" messages. */
  function sketch(el) {
    if (!el) return "nothing";
    const tag = tagOf(el).toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    const text = clip(el.innerText || el.textContent, 30);
    return `<${tag}${id}${cls}>${text ? ` "${text}"` : ""}`;
  }

  // ------------------------------------------------------- actionability

  function rectOf(el) {
    let r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      // A wrapped inline element: aim at its first box, not the union.
      const rects = el.getClientRects();
      if (rects.length > 1 && rects[0].width > 0 && rects[0].height > 0) r = rects[0];
      return r;
    }
    // display:contents has no box of its own: use its children's union.
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const c of el.children || []) {
      const cr = c.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) continue;
      left = Math.min(left, cr.left);
      top = Math.min(top, cr.top);
      right = Math.max(right, cr.right);
      bottom = Math.max(bottom, cr.bottom);
    }
    if (left === Infinity) return r;
    return new DOMRect(left, top, right - left, bottom - top);
  }

  function isVisible(el, r) {
    if (!el.isConnected) return false;
    if (!(r.width > 0 && r.height > 0)) return false;
    try {
      // opacity:0 counts as visible: custom checkboxes hide the real input that way.
      if (el.checkVisibility && getComputedStyle(el).display !== "contents" && !el.checkVisibility({ visibilityProperty: true })) return false;
    } catch {}
    return true;
  }

  function isDisabled(el) {
    try {
      if (el.matches(":disabled")) return true;
    } catch {}
    for (let n = el; n; n = parentOf(n)) {
      if (n.getAttribute?.("aria-disabled") === "true") return true;
    }
    return false;
  }

  const vw = () => document.documentElement.clientWidth || innerWidth;
  const vh = () => document.documentElement.clientHeight || innerHeight;

  /** The element's visible part (intersected with this frame's viewport), or null. */
  function visiblePart(r) {
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(vw(), r.right);
    const bottom = Math.min(vh(), r.bottom);
    if (right - left < 1 || bottom - top < 1) return null;
    return { left, top, right, bottom };
  }

  /** Needs scrolling unless the element's centre is inside the viewport. */
  function needsScroll(r) {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx < 0 || cy < 0 || cx > vw() || cy > vh();
  }

  function pointIn(r, position) {
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      return { x: r.left + position.x, y: r.top + position.y };
    }
    const v = visiblePart(r) || { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    return { x: (v.left + v.right) / 2, y: (v.top + v.bottom) / 2 };
  }

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; el && el.shadowRoot && i < 32; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function contains(ancestor, node) {
    for (let n = node; n; n = n.assignedSlot || parentOf(n)) if (n === ancestor) return true;
    return false;
  }

  /** null when a click at (x,y) reaches el (or its label/descendant); else why not. */
  function hitBlocker(el, x, y) {
    const hit = deepElementFromPoint(x, y);
    if (!hit) return { blocker: null, why: "outside the frame's viewport" };
    if (contains(el, hit)) return null;
    // A label (or a descendant of one) forwards the click to its control.
    if (el.labels) for (const l of el.labels) if (contains(l, hit)) return null;
    return { blocker: hit, why: `covered by ${sketch(hit)}` };
  }

  /** Is anything animating el or one of its ancestors right now? */
  function animating(el) {
    let list;
    try {
      list = document.getAnimations();
    } catch {
      return false;
    }
    for (const a of list) {
      if (a.playState !== "running") continue;
      const t = a.effect?.target;
      if (t && (t === el || contains(t, el))) return true;
    }
    return false;
  }

  function nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(fire);
      setTimeout(fire, 50); // hidden documents get no rAF
    });
  }

  const sameRect = (a, b) =>
    a && b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

  /**
   * Wait until el is visible, enabled (opt), stable and receives a click at its
   * point (opt), scrolling it into view if its centre is off screen. One
   * synchronous check first (no frame wait when nothing animates el), then one
   * check per animation frame until timeoutMs. -> {r, pt, scrolled} frame-local.
   */
  async function actionable(el, { scroll = true, hit = true, enabled = true, editable = false, timeoutMs = DEFAULT_TIMEOUT_MS, position } = {}) {
    const t0 = now();
    const deadline = t0 + Math.min(MAX_TIMEOUT_MS, Math.max(0, timeoutMs));
    let scrolled = false;
    let prev = null;
    for (;;) {
      if (!el.isConnected) throw new CsError("STALE_REF", "The element was removed from the page while waiting for it. Take a new snapshot.");
      let why = null;
      let r = rectOf(el);
      let pt = null;
      if (!isVisible(el, r)) why = "not visible";
      else if (enabled && isDisabled(el)) why = "disabled";
      else if (editable && !isEditable(el)) why = "read-only";
      else {
        if (scroll && needsScroll(r)) {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          scrolled = true;
          r = rectOf(el);
        }
        if (animating(el) && !sameRect(prev, r)) {
          prev = r;
          why = "still moving (animation)";
        } else {
          pt = pointIn(r, position);
          if (pt.x < 0 || pt.y < 0 || pt.x > vw() || pt.y > vh()) why = "outside the viewport";
          else if (hit) {
            const b = hitBlocker(el, pt.x, pt.y);
            if (b) why = b.why;
          }
        }
      }
      if (!why) return { r, pt, scrolled, waited: Math.round(now() - t0) };
      if (now() >= deadline) {
        throw new CsError("NOT_ACTIONABLE", `${describe(el)} is ${why} (waited ${Math.round(now() - t0)} ms).`);
      }
      await nextFrame();
    }
  }

  /** Frame-local rect/point -> top-level viewport (D-005: composed fresh, never cached). */
  async function toTop(r, pt) {
    const off = window === window.top ? { x: 0, y: 0, sx: 1, sy: 1, known: true } : await frameOffset();
    // sx/sy: a scaled or zoomed ancestor of our <iframe> (P-050).
    const sx = off.sx ?? 1;
    const sy = off.sy ?? 1;
    return {
      x: Math.round((off.x + sx * pt.x) * 100) / 100,
      y: Math.round((off.y + sy * pt.y) * 100) / 100,
      known: !!off.known,
      rect: { x: Math.round(off.x + sx * r.left), y: Math.round(off.y + sy * r.top), w: Math.round(r.width * sx), h: Math.round(r.height * sy) },
      // For revealChild: where it is in this frame, and our <iframe>'s ref in the parent.
      local: { x: r.left, y: r.top, w: r.width, h: r.height },
      // The point in this frame: topPoint re-maps it after an ancestor scrolled.
      lp: { x: pt.x, y: pt.y },
      ...(Number.isInteger(off.ref) ? { frameRef: off.ref } : {}),
    };
  }

  // ---------------------------------------------------------------- fields

  const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
  const SET_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"]);

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isEditable(el) {
    const tag = tagOf(el);
    if (tag === "INPUT" || tag === "TEXTAREA") return !el.readOnly && !el.disabled;
    return el.isContentEditable;
  }

  /** text | check | select | set | file | other */
  function kindOf(el) {
    const tag = tagOf(el);
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA") return "text";
    if (tag === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return "check";
      if (t === "file") return "file";
      if (SET_TYPES.has(t)) return "set";
      if (TEXT_TYPES.has(t)) return "text";
      return "other";
    }
    if (el.isContentEditable) return "text";
    const role = el.getAttribute?.("role");
    if (role === "checkbox" || role === "switch" || role === "radio" || role === "menuitemcheckbox") return "check";
    return "other";
  }

  /** A label or custom wrapper standing in for a control: act on the control. */
  function fieldFor(el) {
    if (tagOf(el) === "LABEL" && el.control) return el.control;
    if (kindOf(el) !== "other") return el;
    const inner = el.querySelector?.("input:not([type=hidden]),textarea,select,[contenteditable=''],[contenteditable=true]");
    return inner || el;
  }

  function isChecked(el) {
    if (tagOf(el) === "INPUT") return !!el.checked;
    return el.getAttribute("aria-checked") === "true";
  }

  const truthy = (v) => v === true || /^(true|on|yes|1|checked|y)$/i.test(String(v).trim());

  /** Native setter, so frameworks that override the instance property (React) see the change. */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, ...types) {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true, composed: true }));
  }

  const optionLabel = (o) => (o.label || o.textContent || "").replace(/\s+/g, " ").trim();

  function selectValues(el, wanted) {
    const opts = [...el.options];
    const picked = [];
    for (const w of wanted) {
      const s = String(w);
      const low = s.trim().toLowerCase();
      const o =
        opts.find((x) => x.value === s) ||
        opts.find((x) => optionLabel(x) === s.trim()) ||
        opts.find((x) => optionLabel(x).toLowerCase() === low) ||
        opts.find((x) => x.value.toLowerCase() === low) ||
        (low ? opts.find((x) => optionLabel(x).toLowerCase().includes(low)) : null);
      if (!o) {
        const list = opts
          .slice(0, 25)
          .map((x) => JSON.stringify(optionLabel(x)))
          .join(", ");
        throw new CsError("BAD_ARGS", `No option ${JSON.stringify(s)} in ${describe(el)}. Options: ${list}${opts.length > 25 ? `, … (${opts.length})` : ""}.`);
      }
      if (o.disabled) throw new CsError("NOT_ACTIONABLE", `Option ${JSON.stringify(optionLabel(o))} is disabled.`);
      picked.push(o);
    }
    if (!el.multiple && picked.length > 1) throw new CsError("BAD_ARGS", `${describe(el)} takes one value, got ${picked.length}.`);
    if (el.multiple) for (const o of opts) o.selected = picked.includes(o);
    else setNativeValue(el, picked[0].value);
    // Frameworks listen for both; React's onChange for <select> is "change".
    fire(el, "input", "change");
    return { selected: picked.map(optionLabel), value: el.multiple ? picked.map((o) => o.value) : el.value };
  }

  function setOther(el, value) {
    const v = String(value);
    setNativeValue(el, v);
    fire(el, "input", "change");
    if (el.value !== v && v !== "" && (el.type || "") !== "range") {
      throw new CsError("BAD_ARGS", `${describe(el)} rejected the value ${JSON.stringify(v)} (it holds ${JSON.stringify(el.value)}).`);
    }
    return el.value;
  }

  /** Focus el and select its content (clear) or put the caret at the end. -> focused */
  function focusAndSelect(el, clear) {
    try {
      el.focus({ preventScroll: true });
    } catch {}
    selectContent(el, clear);
    return deepActive() === el && document.hasFocus();
  }

  function selectContent(el, clear) {
    const tag = tagOf(el);
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (clear) {
        try {
          el.select();
        } catch {}
      } else {
        try {
          const n = el.value.length;
          el.setSelectionRange(n, n);
        } catch {}
      }
      return;
    }
    const sel = getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!clear) range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function currentValue(el) {
    const k = kindOf(el);
    if (k === "check") return isChecked(el);
    if (k === "select") return el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value;
    if (tagOf(el) === "INPUT" || tagOf(el) === "TEXTAREA") return el.value;
    return (el.innerText ?? el.textContent ?? "").replace(/\n$/, "");
  }

  /** Prepare a text field for trusted typing: actionable, scrolled, focused, selected. */
  async function prepText(ref, el, { clear = true, timeoutMs } = {}) {
    const { r, pt, scrolled } = await actionable(el, { hit: false, editable: true, timeoutMs });
    const focused = focusAndSelect(el, clear);
    const top = await toTop(r, pt);
    return { ref, kind: "text", focused, clear, scrolled, ...top, desc: describe(el), multiline: tagOf(el) !== "INPUT" };
  }

  // -------------------------------------------------------------------- ops

  /**
   * Resolve once the TOP-level viewport shows el, as this frame learns it: in a
   * cross-origin frame the implicit IntersectionObserver root is the top
   * viewport, and its geometry arrives from the parent through the browser,
   * the same path input routing uses. After an ancestor scrolled, this is when
   * a click at the new point reaches us (P-031). -> true | false at timeoutMs
   */
  function visibleInTop(el, timeoutMs = 500) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        io.disconnect();
        clearTimeout(timer);
        resolve(v);
      };
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0)) finish(true);
      });
      io.observe(el);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  register("resolve", async (args = {}) => {
    const el = getEl(args.ref, args.doc);
    if (args.awaitTopVisible && window !== window.top) {
      await visibleInTop(el);
      await nextFrame();
    }
    const { r, pt, scrolled, waited } = await actionable(el, {
      scroll: args.scroll !== false,
      hit: args.hit !== false,
      enabled: args.enabled !== false,
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      position: args.position,
    });
    let focused;
    if (args.focus) {
      try {
        el.focus({ preventScroll: true });
      } catch {}
      focused = deepActive() === el && document.hasFocus();
    }
    const top = await toTop(r, pt);
    return { ...top, scrolled, waited, desc: describe(el), tag: tagOf(el).toLowerCase(), ...(args.focus ? { focused } : {}) };
  });

  /**
   * A frame-local point (lp, from an earlier toTop) -> top viewport again,
   * after the server scrolled our ancestors to reveal it (fill_form's check
   * clicks; P-034: wait until the top viewport shows the element first).
   */
  register("topPoint", async (args = {}) => {
    const el = getEl(args.ref, args.doc);
    if (window !== window.top) {
      await visibleInTop(el);
      await nextFrame();
    }
    const lp = args.lp || { x: 0, y: 0 };
    return toTop(new DOMRect(lp.x, lp.y, 0, 0), lp);
  });

  register("focusField", async (args = {}) => {
    const el = fieldFor(getEl(args.ref, args.doc));
    const kind = kindOf(el);
    if (kind !== "text") {
      throw new CsError(
        "BAD_ARGS",
        `${describe(el)} is not a text field (${kind}). Use select_option or fill_form for selects, checkboxes and dates; click for buttons.`,
      );
    }
    return prepText(args.ref, el, { clear: !!args.clear, timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  });

  register("selectAll", (args = {}) => {
    const el = fieldFor(getEl(args.ref, args.doc));
    selectContent(el, args.clear !== false);
    return { focused: deepActive() === el && document.hasFocus() };
  });

  register("fillMany", async (args = {}) => {
    const items = Array.isArray(args.items) ? args.items : [];
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const out = { done: [] };
    if (args.verify) {
      try {
        const v = currentValue(fieldFor(getEl(args.verify.ref, args.doc)));
        out.verified = { ref: args.verify.ref, value: v, ok: String(v) === String(args.verify.expect) };
      } catch (e) {
        out.verified = { ref: args.verify.ref, ok: false, error: String(e?.message || e) };
      }
    }
    for (let i = 0; i < items.length; i++) {
      const { ref, value } = items[i];
      const el = fieldFor(getEl(ref, args.doc));
      const kind = kindOf(el);
      if (kind === "select") {
        await actionable(el, { hit: false, scroll: false, timeoutMs });
        const res = selectValues(el, Array.isArray(value) ? value : [value]);
        out.done.push({ ref, kind, value: res.selected.join(", ") });
        continue;
      }
      if (kind === "set") {
        await actionable(el, { hit: false, scroll: false, editable: true, timeoutMs });
        out.done.push({ ref, kind, value: setOther(el, value) });
        continue;
      }
      if (kind === "check") {
        const want = truthy(value);
        if (isChecked(el) === want) {
          out.done.push({ ref, kind, value: want, unchanged: true });
          continue;
        }
        if (tagOf(el) === "INPUT" && el.type === "radio" && !want) {
          throw new CsError("BAD_ARGS", `Radio ${describe(el)} cannot be unchecked directly; check another option of its group.`);
        }
        const a = await actionable(el, { timeoutMs, hit: false });
        // The click goes where a user's would: the control, or its visible label
        // when the input itself is hidden or covered (custom checkboxes).
        let target = a;
        if (tagOf(el) === "INPUT" && hitBlocker(el, a.pt.x, a.pt.y)) {
          const label = [...(el.labels || [])].find((l) => isVisible(l, rectOf(l)));
          if (label) target = await actionable(label, { timeoutMs });
        }
        out.pending = { ref, kind, want, ...(await toTop(target.r, target.pt)), desc: describe(el), rest: items.length - i - 1 };
        return out;
      }
      if (kind === "text") {
        out.pending = { ...(await prepText(ref, el, { clear: true, timeoutMs })), value: String(value ?? ""), rest: items.length - i - 1 };
        return out;
      }
      if (kind === "file") throw new CsError("BAD_ARGS", `${describe(el)} is a file input: use upload_file.`);
      throw new CsError("BAD_ARGS", `${describe(el)} is not a form field. Use click for buttons and links.`);
    }
    if (args.submitRef != null) {
      // A checkbox/radio that did not take blocks the submit (C5).
      if (args.noSubmit || (args.verify?.strict && out.verified && !out.verified.ok)) out.submitSkipped = true;
      else out.submit = submitTarget(args.submitRef, args.doc);
    }
    return out;
  });

  register("readValues", (args = {}) => {
    const values = {};
    for (const ref of args.refs || []) {
      try {
        values[ref] = currentValue(fieldFor(getEl(ref, args.doc)));
      } catch (e) {
        values[ref] = { error: String(e?.message || e) };
      }
    }
    return { values };
  });

  register("selectOption", async (args = {}) => {
    const el = fieldFor(getEl(args.ref, args.doc));
    if (tagOf(el) !== "SELECT") {
      throw new CsError("BAD_ARGS", `${describe(el)} is not a <select>. For a custom dropdown, click it, then click the option.`);
    }
    await actionable(el, { hit: false, scroll: false, timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    const wanted = Array.isArray(args.values) ? args.values : [args.values];
    return { ...selectValues(el, wanted), desc: describe(el) };
  });

  // ------------------------------------------------------------ submit

  function isSubmitButton(b) {
    const tag = tagOf(b);
    if (tag === "BUTTON") return (b.getAttribute("type") || "submit").toLowerCase() === "submit";
    if (tag === "INPUT") return ["submit", "image"].includes((b.type || "").toLowerCase());
    return false;
  }

  /** The control a user would press to submit el's form: {ref, desc}, or {submitted:true}. */
  function submitTarget(ref, doc) {
    const el = getEl(ref, doc);
    const form = el.form || el.closest?.("form");
    if (!form) throw new CsError("BAD_ARGS", `${describe(el)} is not inside a form; pass submit as the ref of the button to click.`);
    const outside = form.id ? [...document.querySelectorAll(`[form="${CSS.escape(form.id)}"]`)] : [];
    const btn = [...form.elements, ...outside].filter(isSubmitButton).find((b) => !b.disabled && isVisible(b, rectOf(b)));
    if (btn) return { ref: refs.idFor(btn), desc: describe(btn) };
    // No visible button: what pressing Enter would do.
    form.requestSubmit();
    return { submitted: true };
  }

  register("submitTarget", (args = {}) => submitTarget(args.ref, args.doc));

  // ------------------------------------------------------------- upload

  register("markFile", (args = {}) => {
    const el = getEl(args.ref, args.doc);
    const input = tagOf(el) === "LABEL" && el.control ? el.control : el;
    if (tagOf(input) !== "INPUT" || (input.type || "").toLowerCase() !== "file") {
      throw new CsError("BAD_ARGS", `${describe(el)} is not a file input.`);
    }
    if (input.disabled) throw new CsError("NOT_ACTIONABLE", `${describe(input)} is disabled.`);
    input.setAttribute("data-sol-upload", String(args.token));
    return { multiple: !!input.multiple, accept: input.accept || "", desc: describe(input) };
  });

  register("unmarkFile", (args = {}) => {
    let n = 0;
    for (const el of document.querySelectorAll(`[data-sol-upload="${CSS.escape(String(args.token))}"]`)) {
      el.removeAttribute("data-sol-upload");
      n++;
    }
    return { removed: n };
  });

  // ------------------------------------------------------------- scroll

  function canScroll(el, axis) {
    if (!el || el.nodeType !== 1) return false;
    const se = document.scrollingElement || document.documentElement;
    const max = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (max <= 1) return false;
    if (el === se) return true;
    if (el === document.body || el === document.documentElement) return false;
    const ov = getComputedStyle(el)[axis === "y" ? "overflowY" : "overflowX"];
    return ov === "auto" || ov === "scroll" || ov === "overlay";
  }

  function scrollableFrom(start, axis) {
    for (let n = start; n; n = n.assignedSlot || parentOf(n)) if (canScroll(n, axis)) return n;
    const se = document.scrollingElement || document.documentElement;
    if (canScroll(se, axis)) return se;
    // The page itself does not scroll (an app shell): the largest visible scroller.
    let best = null;
    let area = 0;
    for (const el of document.querySelectorAll("*")) {
      if (!canScroll(el, axis)) continue;
      const r = el.getBoundingClientRect();
      const a = visiblePart(r) ? r.width * r.height : 0;
      if (a > area) {
        area = a;
        best = el;
      }
    }
    return best || se;
  }

  /**
   * Parent side of revealing an element of a child frame that is off the top
   * viewport (the child can only scroll its own document): scroll so that rect
   * (child viewport coords) of the <iframe> ref is centred in view.
   * -> {moved, local:{x,y,w,h} the rect in THIS frame's viewport, frameRef?}
   */
  register("revealChild", async (args = {}) => {
    const f = getEl(args.ref, args.doc);
    const rect = args.rect || { x: 0, y: 0, w: 0, h: 0 };
    const target = () => {
      // The child viewport starts inside border AND padding, scaled by any transform/zoom (P-004, P-050).
      const b = sol.frameBox(f);
      return { left: b.x + rect.x * b.sx, top: b.y + rect.y * b.sy, width: rect.w * b.sx, height: rect.h * b.sy };
    };
    let moved = 0;
    const before = target();
    if (needsScroll(new DOMRect(before.left, before.top, before.width, before.height))) {
      // The iframe's own scroll containers first, then centre the rect in the page.
      f.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      let t = target();
      const cy = t.top + t.height / 2;
      const cx = t.left + t.width / 2;
      const se = document.scrollingElement || document.documentElement;
      if (cy < 0 || cy > vh() || cx < 0 || cx > vw()) se.scrollBy({ top: cy - vh() / 2, left: cx < 0 || cx > vw() ? cx - vw() / 2 : 0, behavior: "instant" });
      t = target();
      moved = Math.round(Math.abs(t.top - before.top) + Math.abs(t.left - before.left));
      if (moved) await nextFrame();
    }
    const t = target();
    const off = window === window.top ? null : await frameOffset();
    return { moved, local: { x: t.left, y: t.top, w: t.width, h: t.height }, ...(Number.isInteger(off?.ref) ? { frameRef: off.ref } : {}) };
  });

  register("scrollTo", (args = {}) => {
    const dir = args.direction;
    const el = args.ref != null ? getEl(args.ref, args.doc) : null;
    if (el && !dir && !args.to) {
      const r = rectOf(el);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const after = rectOf(el);
      return { target: describe(el), intoView: true, moved: Math.round(Math.abs(after.top - r.top) + Math.abs(after.left - r.left)) };
    }
    const axis = dir === "left" || dir === "right" || args.to === "left" || args.to === "right" ? "x" : "y";
    let start = el;
    if (!start && Number.isFinite(args.x) && Number.isFinite(args.y)) start = deepElementFromPoint(args.x, args.y);
    const sc = scrollableFrom(start, axis);
    const page = sc === (document.scrollingElement || document.documentElement);
    const before = { left: sc.scrollLeft, top: sc.scrollTop };
    const viewport = axis === "y" ? (page ? vh() : sc.clientHeight) : page ? vw() : sc.clientWidth;
    if (args.to) {
      const to = String(args.to);
      const opt = { behavior: "instant" };
      if (to === "top") opt.top = 0;
      else if (to === "bottom") opt.top = sc.scrollHeight;
      else if (to === "left") opt.left = 0;
      else if (to === "right") opt.left = sc.scrollWidth;
      else throw new CsError("BAD_ARGS", `to must be top, bottom, left or right (got ${JSON.stringify(to)}).`);
      sc.scrollTo(opt);
    } else {
      const sign = dir === "up" || dir === "left" ? -1 : 1;
      // amount: wheel notches of 100 px (the browser tool's unit), or "page".
      const amt = args.amount === "page" ? Math.max(1, Math.round(viewport * 0.9)) : Math.max(0, Number(args.amount ?? 3)) * 100;
      sc.scrollBy({ [axis === "y" ? "top" : "left"]: sign * amt, behavior: "instant" });
    }
    const moved = Math.round(Math.abs(sc.scrollTop - before.top) + Math.abs(sc.scrollLeft - before.left));
    return {
      target: page ? "page" : describe(sc),
      moved,
      x: Math.round(sc.scrollLeft),
      y: Math.round(sc.scrollTop),
      maxX: Math.max(0, Math.round(sc.scrollWidth - sc.clientWidth)),
      maxY: Math.max(0, Math.round(sc.scrollHeight - sc.clientHeight)),
    };
  });
}
