// Snapshot op (track A): this frame as compact role/name lines.
//
// One call per frame (ext.frameCallAll). The server merges frames, nesting
// each child frame under its <iframe> line, rewrites refs to e12 / f3e12,
// diffs against the session's last snapshot and applies maxChars.
//
//   op "snapshot" {mode: interactive|all, viewportOnly, root?, doc?, since?}
//     root: a ref id, snapshot only that subtree. doc: the docKey the ref was
//     issued under; a different document answers STALE_REF.
//     -> {docKey, rev, url, isTop, title?, parentRef?, lines, iframes:[{ref, line, src}], truncated, ms}
//     -> {unchanged:true, docKey, rev}   when since[docKey] === rev: nothing was walked
//
// Line grammar (2 spaces per depth):  - role "name" <ref> props: inline text
//   Refs are \u0001<id>\u0002 placeholders; the server rewrites them to [e12] / [f3e12].
//   Only actionable elements (and iframes, as nesting anchors) get a ref.
//
// Distillation (after Playwright's ai mode): generic wrappers never get a line,
// adjacent text collapses into one line, a text child that repeats its parent's
// name is dropped, nameless images are dropped, and refs go only to elements
// with a visible box.
//
// Must stay a block so a second injection never redeclares bindings (P-006).

if (globalThis.__sol && !globalThis.__sol.loaded?.has("snapshot")) {
  globalThis.__sol.loaded?.add("snapshot");
  const sol = globalThis.__sol;
  const { register, CsError, tagOf, refs, whenBody } = sol;

  const NAME_MAX = 100;
  const TEXT_MAX = 500;
  const VALUE_MAX = 80;
  const OPTIONS_MAX = 200;
  const ROW_NAME_MAX = 40;
  const FRAME_CAP = 400_000; // chars per frame; the server applies maxChars to the merged page
  const PRUNE_AT = 5000;

  const PH = (id) => `\u0001${id}\u0002`;
  // Identity of this document's ref namespace (ids restart at 1 per document).
  // Shared so ref-resolving ops in other files can answer STALE_REF for a ref
  // issued before a navigation (the server sends the expected key as `doc`).
  const docKey = (sol.docKey ||= Math.random().toString(36).slice(2, 10));

  // ------------------------------------------------------------ revision
  // sol.rev (core) counts DOM mutations. valRev adds what a document
  // MutationObserver cannot see: input values and checked state (properties,
  // not attributes), mutations inside shadow roots, and loads/transitions that
  // move layout. A value fingerprint catches scripts that set .value silently.

  let valRev = 0;
  const bump = () => {
    valRev++;
  };
  for (const type of ["input", "change", "reset", "click", "keyup", "toggle", "transitionend", "animationend", "load"]) {
    addEventListener(type, bump, { capture: true, passive: true });
  }
  const shadowObserver = new MutationObserver(bump);
  const observedRoots = new WeakSet();
  function observeShadow(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    try {
      shadowObserver.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {}
  }

  function valueFingerprint() {
    let h = 0;
    const list = document.querySelectorAll("input,textarea,select");
    for (const el of list) {
      const v = tagOf(el) === "SELECT" ? String(el.selectedIndex) : String(el.value ?? "");
      h = (h * 31 + v.length) | 0;
      for (let i = 0; i < v.length && i < 64; i++) h = (h * 31 + v.charCodeAt(i)) | 0;
      if (el.checked) h = (h * 31 + 7) | 0;
    }
    return `${(h >>> 0).toString(36)}${list.length}`;
  }

  const revOf = (vp) => `${sol.rev}.${valRev}.${valueFingerprint()}.${innerWidth}x${innerHeight}${vp ? `.${sol.viewRev}.${Math.round(scrollX)},${Math.round(scrollY)}.${Math.round(visualViewport?.offsetLeft || 0)},${Math.round(visualViewport?.offsetTop || 0)}` : ""}`;

  // -------------------------------------------------------------- tables

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE", "DATALIST", "PARAM", "SOURCE", "TRACK", "AREA", "MAP"]);
  // Elements whose children never become lines.
  const LEAF_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "IMG", "SVG", "CANVAS", "IFRAME", "FRAME", "HR", "PROGRESS", "METER", "VIDEO", "AUDIO", "OBJECT", "EMBED"]);
  // Text across these stays on one line ("Cart: <span>0</span> items").
  const INLINE_TAGS = new Set([
    "SPAN", "A", "B", "I", "EM", "STRONG", "CODE", "SMALL", "SUB", "SUP", "MARK", "ABBR", "TIME", "LABEL", "U", "S", "FONT",
    "BDI", "BDO", "Q", "CITE", "DFN", "KBD", "SAMP", "VAR", "DATA", "DEL", "INS", "WBR", "IMG", "BUTTON", "INPUT", "SELECT", "TEXTAREA",
  ]);
  const NO_TEXT_TAGS = new Set(["SCRIPT", "STYLE", "OPTION", "SELECT", "TEXTAREA", "TEMPLATE", "NOSCRIPT"]);
  const FORM_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "FIELDSET", "OPTGROUP", "OPTION"]);

  const ACTIONABLE = new Set([
    "button", "link", "checkbox", "radio", "switch", "textbox", "searchbox", "combobox", "listbox", "option", "slider",
    "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem", "file",
  ]);
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "checkbox",
    "radio", "switch", "cell", "gridcell", "columnheader", "rowheader", "tooltip", "clickable",
  ]);
  // Roles a pointer-cursor / onclick element may have and still become a click target.
  const CLICKABLE_ROLES = new Set([null, "img", "listitem", "cell", "gridcell", "row", "article", "paragraph", "figure", "heading", "rowheader", "columnheader"]);
  // Kept as context in interactive mode when they contain a kept line.
  const STRUCT = new Set([
    "banner", "main", "navigation", "contentinfo", "complementary", "search", "form", "region", "dialog", "alertdialog",
    "group", "radiogroup", "tablist", "menu", "menubar", "listbox", "tree", "treegrid", "grid", "toolbar", "row", "tabpanel",
  ]);
  const ALWAYS_KEEP = new Set(["dialog", "alertdialog"]);
  const LIVE = new Set(["alert", "status", "log", "marquee", "timer"]);
  // Dropped unless named (they say nothing without one).
  const NAMED_ONLY = new Set(["form", "region", "group"]);
  // Shown in "all" mode even with no content.
  const KEEP_EMPTY = new Set(["img", "separator", "progressbar", "meter"]);

  const INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button",
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", file: "file", color: "button",
  };
  const DATE_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);
  const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  const VALUED = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);

  // ------------------------------------------------------------- helpers

  const norm = (s) => String(s ?? "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const q = (s) => JSON.stringify(clip(s, NAME_MAX));
  const attr = (el, name) => norm(el.getAttribute?.(name) || "");

  function sectioned(el) {
    try {
      return !!el.parentElement?.closest("article,aside,main,nav,section");
    } catch {
      return false;
    }
  }

  function inputRole(el) {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "hidden") return null;
    if (INPUT_ROLES[t]) return INPUT_ROLES[t];
    if (el.hasAttribute("list")) return "combobox";
    return "textbox";
  }

  function implicitRole(el, tag) {
    switch (tag) {
      case "A":
        return el.hasAttribute("href") ? "link" : null;
      case "BUTTON":
      case "SUMMARY":
        return "button";
      case "INPUT":
        return inputRole(el);
      case "SELECT":
        return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "TEXTAREA":
        return "textbox";
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        return "heading";
      case "IMG":
        return el.getAttribute("alt") === "" ? null : "img";
      case "SVG":
      case "CANVAS":
        return "img";
      case "NAV":
        return "navigation";
      case "MAIN":
        return "main";
      case "ASIDE":
        return "complementary";
      case "HEADER":
        return sectioned(el) ? null : "banner";
      case "FOOTER":
        return sectioned(el) ? null : "contentinfo";
      case "FORM":
        return "form";
      case "SECTION":
        return "region";
      case "SEARCH":
        return "search";
      case "ARTICLE":
        return "article";
      case "DIALOG":
        return "dialog";
      case "DETAILS":
      case "FIELDSET":
        return "group";
      case "UL":
      case "OL":
      case "MENU":
        return "list";
      case "LI":
        return "listitem";
      case "TABLE":
        return "table";
      case "TR":
        return "row";
      case "TD":
        return "cell";
      case "TH":
        return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
      case "P":
        return "paragraph";
      case "BLOCKQUOTE":
        return "blockquote";
      case "HR":
        return "separator";
      case "PROGRESS":
        return "progressbar";
      case "METER":
        return "meter";
      case "OUTPUT":
        return "status";
      case "IFRAME":
      case "FRAME":
        return "iframe";
      case "FIGURE":
        return "figure";
      case "OPTION":
        return "option";
      default:
        return null;
    }
  }

  function roleOf(el, tag) {
    const explicit = el.getAttribute("role");
    if (explicit) {
      const r = explicit.trim().split(/\s+/)[0].toLowerCase();
      if (r === "presentation" || r === "none") return null;
      if (r) return r;
    }
    return implicitRole(el, tag);
  }

  /** Text of `root` (textContent semantics), skipping option lists and the like. */
  function plainText(root, limit = 300) {
    let s = "";
    let w;
    try {
      w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    } catch {
      return "";
    }
    for (let n = w.nextNode(); n && s.length < limit; n = w.nextNode()) {
      const p = n.parentElement;
      if (p && NO_TEXT_TAGS.has(tagOf(p))) continue;
      s += n.data;
    }
    return s;
  }

  function labelledBy(el) {
    const ids = el.getAttribute("aria-labelledby");
    if (!ids) return "";
    const root = el.getRootNode?.();
    let s = "";
    for (const id of ids.split(/\s+/)) {
      if (!id) continue;
      const t = root?.getElementById?.(id) || document.getElementById(id);
      if (!t) continue;
      s += ` ${t.getAttribute("aria-label") || (tagOf(t) === "INPUT" ? t.value : plainText(t))}`;
    }
    return norm(s);
  }

  // el.labels is a live list Chrome rebuilds by scanning the whole tree scope,
  // and any childList mutation invalidates it: 1000 unlabelled <select>s cost
  // ~600 ms per walk on a 15k-node page. One control->labels map per tree
  // scope per walk instead (label.control is cheap: an id lookup or a walk of
  // the label's own subtree).
  function labelMapFor(ctx, root) {
    let m = ctx.labelMaps.get(root);
    if (m) return m;
    m = new Map();
    let list = [];
    try {
      list = root.querySelectorAll("label");
    } catch {}
    for (const l of list) {
      const c = l.control;
      if (!c) continue;
      if (!m.has(c)) m.set(c, []);
      m.get(c).push(l);
    }
    ctx.labelMaps.set(root, m);
    return m;
  }

  function labelsText(el, ctx) {
    const root = el.getRootNode?.() || document;
    const labels = labelMapFor(ctx, root).get(el);
    if (!labels) return "";
    let s = "";
    for (const l of labels) s += ` ${plainText(l)}`;
    return norm(s);
  }

  function hasArea(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function hasBox(el) {
    try {
      return el.checkVisibility({ visibilityProperty: true }) && hasArea(el);
    } catch {
      return false;
    }
  }

  function childNodesOf(el, tag) {
    let sr = el.shadowRoot;
    if (!sr && el.localName?.includes("-")) {
      // Closed roots too: content scripts may open them (Chrome 88+).
      try {
        sr = chrome.dom?.openOrClosedShadowRoot?.(el) || null;
      } catch {}
    }
    if (sr) {
      observeShadow(sr);
      return sr.childNodes;
    }
    if (tag === "SLOT") {
      try {
        const a = el.assignedNodes({ flatten: true });
        if (a.length) return a;
      } catch {}
    }
    return el.childNodes;
  }

  // --------------------------------------------------------------- build
  // Node: {el, tag, role, name, lab, fc, act, frame, clickable, props, kids, level, suppress, proxy, src}
  //   kids hold Nodes, DOM Text nodes and the BR sentinel.
  //   lab: the name is author-supplied (aria-label, alt, ...), so it stands in
  //        for the element's content inside an ancestor's name-from-content.
  //   fc:  the name was computed from content (and fcFull: without clipping).

  const BR = { br: true };
  const NO_KIDS = [];

  function buildKids(el, tag, ctx, inAct, parentPtr) {
    const out = [];
    for (const n of childNodesOf(el, tag)) {
      if (n.nodeType === 3) {
        if (/\S/.test(n.data)) out.push(n);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const r = buildEl(n, ctx, inAct, parentPtr);
      if (!r) continue;
      if (Array.isArray(r)) {
        for (const x of r) out.push(x);
      } else out.push(r);
    }
    return out;
  }

  function buildEl(el, ctx, inAct, parentPtr) {
    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag)) return null;
    if (tag === "BR") return BR;
    const hasAttrs = el.hasAttributes();
    if (hasAttrs && !ctx.keepHidden && (el.getAttribute("aria-hidden") === "true" || el.inert)) {
      ctx.ariaHidden++;
      return null;
    }
    // The legend/caption is the group's/table's name; never a line of its own.
    if ((tag === "LEGEND" && tagOf(el.parentElement) === "FIELDSET") || tag === "CAPTION") return null;

    let visible;
    try {
      visible = el.checkVisibility({ visibilityProperty: true });
    } catch {
      visible = true;
    }
    if (!visible) {
      const cs = getComputedStyle(el);
      // display:contents has no box of its own, but its children do.
      if (cs.display === "contents") return buildKids(el, tag, ctx, inAct, parentPtr);
      if (cs.display === "none" || cs.visibility === "visible") return null;
      // visibility:hidden: the element is invisible, a child may opt back in.
      return buildKids(el, tag, ctx, inAct, parentPtr).filter((k) => k.nodeType !== 3);
    }

    let role = hasAttrs ? roleOf(el, tag) : implicitRole(el, tag);
    if (role == null && hasAttrs) {
      const ce = el.getAttribute("contenteditable");
      if (ce != null && ce !== "false" && !el.parentElement?.isContentEditable) role = "textbox";
    }
    const node = { el, tag, role, name: "", lab: false, fc: false, act: false, frame: false, props: null, kids: NO_KIDS };

    let name = hasAttrs ? labelledBy(el) || attr(el, "aria-label") : "";
    if (name) node.lab = true;
    const props = [];
    let value = null;

    switch (tag) {
      case "INPUT": {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (role === "button" && INPUT_ROLES[type]) {
          if (!name) name = type === "image" ? attr(el, "alt") || "Submit" : norm(el.value) || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
        } else if (!name) name = labelsText(el, ctx);
        if (type === "file") {
          const files = [...(el.files || [])].map((f) => f.name);
          if (files.length) props.push(`value=${JSON.stringify(clip(files.join(", "), VALUE_MAX))}`);
        } else if (CHECKABLE.has(role)) {
          if (el.indeterminate) props.push("mixed");
          else if (el.checked) props.push("checked");
        } else if (role !== "button") {
          value = type === "password" ? (el.value ? "••••" : "") : el.value;
          if (DATE_TYPES.has(type)) props.push(`type=${type}`);
        }
        break;
      }
      case "TEXTAREA":
        if (!name) name = labelsText(el, ctx);
        value = el.value;
        break;
      case "SELECT": {
        if (!name) name = labelsText(el, ctx);
        const sel = [];
        const opts = [];
        let len = 0;
        let more = 0;
        for (const o of el.options) {
          const label = norm(o.label || o.text);
          if (o.selected) sel.push(label);
          if (len < OPTIONS_MAX) {
            opts.push(label);
            len += label.length + 3;
          } else more++;
        }
        if (more) opts.push(`…+${more}`);
        node.selectValue = el.multiple ? JSON.stringify(sel.map((s) => clip(s, VALUE_MAX))) : sel.length ? JSON.stringify(clip(sel[0], VALUE_MAX)) : null;
        node.options = opts;
        break;
      }
      case "IMG":
        if (!name) {
          name = attr(el, "alt");
          if (name) node.lab = true;
        }
        break;
      case "SVG":
        if (!name) {
          const t = el.querySelector?.(":scope > title");
          name = t ? norm(t.textContent) : "";
          if (name) node.lab = true;
        }
        break;
      case "FIELDSET":
        if (!name) {
          const lg = el.querySelector?.(":scope > legend");
          if (lg) name = norm(plainText(lg));
        }
        break;
      case "TABLE":
        if (!name && el.caption) name = norm(plainText(el.caption));
        break;
      case "IFRAME":
      case "FRAME":
        if (!hasArea(el)) return null; // 0x0 trackers
        if (!name) name = attr(el, "title") || attr(el, "name");
        node.frame = true;
        node.src = el.src || "";
        break;
      case "SUMMARY": {
        const d = el.parentElement;
        if (tagOf(d) === "DETAILS") props.push(d.open ? "expanded" : "collapsed");
        break;
      }
      case "LABEL": {
        const c = el.control;
        if (c && c !== el) {
          if (hasBox(c)) node.suppress = true; // the control's own line carries this text
          else {
            // Custom toggle: the real input is hidden and the label is what a user clicks.
            const cr = roleOf(c, tagOf(c));
            if (cr && ACTIONABLE.has(cr)) {
              node.proxy = c;
              role = node.role = cr;
              if (CHECKABLE.has(cr)) {
                if (c.indeterminate) props.push("mixed");
                else if (c.checked) props.push("checked");
              }
              if (c.disabled) props.push("disabled");
            }
          }
        }
        break;
      }
      default:
        break;
    }

    if (role === "textbox" && value == null && !LEAF_TAGS.has(tag)) value = plainText(el, VALUE_MAX + 1); // contenteditable / role=textbox
    if (role === "heading") node.level = /^H[1-6]$/.test(tag) ? Number(tag[1]) : Number(el.getAttribute("aria-level")) || 2;

    // ARIA state.
    if (hasAttrs || FORM_TAGS.has(tag)) {
      if (!node.proxy && ((FORM_TAGS.has(tag) && el.matches(":disabled")) || el.getAttribute("aria-disabled") === "true")) props.push("disabled");
      if (CHECKABLE.has(role) && tag !== "INPUT" && !node.proxy) {
        const c = el.getAttribute("aria-checked");
        if (c === "true") props.push("checked");
        else if (c === "mixed") props.push("mixed");
      }
      const exp = el.getAttribute("aria-expanded");
      if (exp === "true") props.push("expanded");
      else if (exp === "false") props.push("collapsed");
      if (el.getAttribute("aria-selected") === "true") props.push("selected");
      const pressed = el.getAttribute("aria-pressed");
      if (pressed === "true") props.push("pressed");
      else if (pressed === "mixed") props.push("pressed=mixed");
    }

    node.act = ACTIONABLE.has(role);
    if (node.act) ctx.actCount++;

    const leaf = LEAF_TAGS.has(tag) || role === "textbox" || role === "searchbox";
    const insideAct = inAct || node.act;
    // A pointer-cursor root outside any control is something a user would
    // click (React onClick divs, clickable rows and icons). cursor inherits,
    // so only the topmost pointer element counts.
    let ptr = false;
    if (!insideAct) {
      try {
        ptr = getComputedStyle(el).cursor === "pointer";
      } catch {}
    }
    const c0 = ctx.actCount;
    if (!leaf) node.kids = buildKids(el, tag, ctx, insideAct, ptr);
    if (
      !insideAct &&
      CLICKABLE_ROLES.has(role) &&
      ((ptr && !parentPtr) || (hasAttrs && el.hasAttribute("onclick"))) &&
      ctx.actCount === c0 &&
      !node.suppress &&
      !(tag === "LABEL" && el.control)
    ) {
      if (role == null) role = node.role = "clickable";
      node.act = true;
      node.clickable = true;
      ctx.actCount++;
    }

    if (!name && (NAME_FROM_CONTENT.has(role) || node.clickable)) {
      name = contentText(node);
      node.fc = !!name;
      node.fcFull = name.length < NAME_MAX;
    }
    if (!name && hasAttrs) name = attr(el, "title");
    if (!name && VALUED.has(role) && hasAttrs) name = attr(el, "placeholder") || attr(el, "aria-placeholder");
    if (NAMED_ONLY.has(role) && !name) node.role = role = null;
    if (role === "img" && !name && !node.act) return null; // decorative
    node.name = norm(name);

    if (value != null && VALUED.has(role)) {
      const v = norm(value);
      if (v) props.push(`value=${JSON.stringify(clip(v, VALUE_MAX))}`);
    }
    if (node.selectValue) props.push(`value=${node.selectValue}`);
    if (node.options?.length) props.push(`options=${JSON.stringify(node.options)}`);
    if (props.length) node.props = props;
    return node;
  }

  /** Accessible name from content: visible text, with labelled children contributing their label. */
  function contentText(node, max = NAME_MAX * 2) {
    let s = "";
    const walk = (kids) => {
      for (const k of kids) {
        if (s.length > max) return;
        if (k.nodeType === 3) s += k.data;
        else if (k.br) s += " ";
        else if (k.lab) s += ` ${k.name} `;
        else {
          const block = !INLINE_TAGS.has(k.tag);
          if (block) s += " ";
          if (k.kids.length) walk(k.kids);
          if (block) s += " ";
        }
      }
    };
    walk(node.kids);
    return clip(norm(s), max === NAME_MAX * 2 ? NAME_MAX : max);
  }

  /** interactive-mode row context: the first cell's text. */
  function rowName(node) {
    const find = (kids) => {
      for (const k of kids) {
        if (!k.kids) continue;
        if (k.role === "cell" || k.role === "gridcell" || k.role === "rowheader" || k.role === "columnheader") return k;
        if (k.role == null) {
          const hit = find(k.kids);
          if (hit) return hit;
        }
      }
      return null;
    };
    const cell = find(node.kids);
    return cell ? clip(cell.name || contentText(cell), ROW_NAME_MAX) : "";
  }

  // -------------------------------------------------------------- render

  function makeRenderer(ctx) {
    const out = [];
    const iframes = [];
    let chars = 0;
    let truncated = false;
    let lastText = -1; // index of the last text line, for inlining
    const all = ctx.mode === "all";
    const vp = ctx.vp;
    const vw = innerWidth;
    const vh = innerHeight;
    let range = null;

    const inRect = (r) => r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && (r.width > 0 || r.height > 0);
    const elInView = (el) => inRect(el.getBoundingClientRect());
    function textInView(t) {
      if (!vp) return true;
      try {
        range ||= document.createRange();
        range.selectNodeContents(t);
        return inRect(range.getBoundingClientRect());
      } catch {
        return true;
      }
    }

    function push(depth, s) {
      if (truncated) return false;
      const line = "  ".repeat(depth) + s;
      if (chars + line.length + 1 > ctx.cap) {
        truncated = true;
        return false;
      }
      out.push(line);
      chars += line.length + 1;
      return true;
    }

    function lineFor(node, inline) {
      let s = `- ${node.role === "heading" ? `h${node.level}` : node.role}`;
      if (node.name) s += ` ${q(node.name)}`;
      if (node.act || node.frame) s += ` ${PH(refs.idFor(node.el))}`;
      if (node.props) s += ` ${node.props.join(" ")}`;
      if (inline) s += `: ${inline}`;
      return s;
    }

    function emitNode(node, depth) {
      const at = out.length;
      if (!push(depth, lineFor(node))) return false;
      if (node.frame) iframes.push({ ref: refs.idFor(node.el), line: at, src: node.src });
      return true;
    }

    function emitText(depth, raw) {
      const t = clip(norm(raw), TEXT_MAX);
      if (!t) return;
      if (push(depth, `- text: ${t}`)) lastText = out.length - 1;
    }

    function rollback(mark, charsAt) {
      while (iframes.length && iframes[iframes.length - 1].line >= mark) iframes.pop();
      out.length = mark;
      chars = charsAt;
    }

    /** Render a kids list at `depth`. textOn: render text. refsOnly: only lines that carry refs. */
    function renderKids(kids, depth, textOn, refsOnly) {
      let buf = "";
      const flush = () => {
        if (buf) {
          if (/\S/.test(buf)) emitText(depth, buf);
          buf = "";
        }
      };
      const walk = (list, text) => {
        for (const k of list) {
          if (truncated) return;
          if (k.nodeType === 3) {
            if (text && textInView(k)) buf += k.data;
            continue;
          }
          if (k.br) {
            buf += " ";
            continue;
          }
          if (k.role == null && !k.act) {
            // Generic wrapper: no line; its content flows into ours.
            const block = !INLINE_TAGS.has(k.tag);
            if (block) buf += " ";
            walk(k.kids, text && !k.suppress);
            if (block) buf += " ";
            continue;
          }
          flush();
          renderNode(k, depth, refsOnly);
        }
      };
      walk(kids, textOn && !refsOnly);
      flush();
    }

    function renderNode(node, depth, refsOnly) {
      const role = node.role;
      const lineish = node.act || node.frame;

      // Refs only on boxes a user could hit; off-screen ones skipped in viewportOnly.
      if (node.frame) {
        if (vp && !elInView(node.el)) return;
      } else if (lineish && (!hasArea(node.el) || (vp && !elInView(node.el)))) {
        renderKids(node.kids, depth, false, true);
        return;
      }
      if (refsOnly && !lineish) {
        renderKids(node.kids, depth, false, true);
        return;
      }

      if (!all) {
        // ---- interactive: controls, headings, live text; landmarks as context
        if (lineish) {
          emitNode(node, depth);
          if (node.kids.length) renderKids(node.kids, depth + 1, false, true);
          return;
        }
        if (role === "heading") {
          if (node.name && (!vp || elInView(node.el))) emitNode(node, depth);
          renderKids(node.kids, depth, false, true);
          return;
        }
        if (LIVE.has(role)) {
          const t = contentText(node, TEXT_MAX);
          if (t && (!vp || elInView(node.el))) push(depth, `- ${role}${node.lab && node.name ? ` ${q(node.name)}` : ""}: ${t}`);
          renderKids(node.kids, depth, false, true);
          return;
        }
        if (STRUCT.has(role)) {
          const mark = out.length;
          const charsAt = chars;
          const shown = role === "row" && !node.name ? { ...node, name: rowName(node) } : node;
          if (!emitNode(shown, depth)) return;
          renderKids(node.kids, depth + 1, false, false);
          if (out.length === mark + 1 && !ALWAYS_KEEP.has(role)) rollback(mark, charsAt);
          return;
        }
        renderKids(node.kids, depth, false, false);
        return;
      }

      // ---- all: every role gets a line; text collapses; empty containers drop
      if (vp && !node.kids.length && !lineish && !elInView(node.el)) return;
      // A node whose name is its whole content (headings) has no text children
      // to carry the view check: check it here, or viewportOnly listed every
      // heading of the page (C7). Nested controls still get their own check.
      if (vp && node.fc && node.fcFull && !elInView(node.el)) {
        renderKids(node.kids, depth, false, true);
        return;
      }
      const mark = out.length;
      const charsAt = chars;
      if (!emitNode(node, depth)) return;
      if (node.fc && node.fcFull) {
        // The name already is the content: show only nested controls.
        renderKids(node.kids, depth + 1, false, true);
        return;
      }
      lastText = -1;
      renderKids(node.kids, depth + 1, !node.suppress, false);
      const added = out.length - mark - 1;
      if (added === 1 && lastText === mark + 1) {
        // A single text child: inline it, or drop it when it repeats the name.
        const t = out[mark + 1].slice(out[mark + 1].indexOf("- text: ") + 8);
        out.length = mark + 1;
        if (t !== node.name) out[mark] = "  ".repeat(depth) + lineFor(node, t);
        chars = charsAt + out[mark].length + 1;
        lastText = -1;
        return;
      }
      if (added === 0 && !lineish && (!node.name || vp) && !KEEP_EMPTY.has(role) && !ALWAYS_KEEP.has(role)) rollback(mark, charsAt);
    }

    return {
      renderKids,
      renderNode,
      result: () => ({ lines: out, iframes, truncated }),
    };
  }

  // ------------------------------------------------------------------ op

  async function snapshotOp({ mode = "interactive", viewportOnly = false, root, since, doc } = {}) {
    if (mode !== "interactive" && mode !== "all") throw new CsError("BAD_ARGS", `mode must be "interactive" or "all"`);
    // Ref ids restart in every document: a ref issued before a navigation must
    // not resolve to whatever got the same number here.
    if (root != null && doc && doc !== docKey) throw new CsError("STALE_REF", `Ref ${root} belongs to a document this frame has since navigated away from.`);
    await whenBody();
    const vp = !!viewportOnly;
    const isTop = window === window.top;
    const rev = revOf(vp);
    if (root == null && since && since[docKey] === rev) return { unchanged: true, docKey, rev };

    // The child half of the iframe handshake overlaps the walk.
    const parentRefP = isTop ? null : sol.parentIframeRef().catch(() => ({ ref: null }));
    const t0 = performance.now();
    let rootEl = null;
    if (root != null) {
      rootEl = refs.get(root);
      if (!rootEl) throw new CsError("STALE_REF", `Ref ${root} no longer exists in this frame.`);
    }
    const walk = (keepHidden) => {
      const ctx = { mode, vp, cap: FRAME_CAP, actCount: 0, labelMaps: new Map(), ariaHidden: 0, keepHidden };
      const r = makeRenderer(ctx);
      if (rootEl) {
        const built = buildEl(rootEl, ctx, false, false);
        // A generic root has no line of its own: its content is the subtree.
        if (built) r.renderKids(Array.isArray(built) ? built : [built], 0, mode === "all", false);
      } else {
        const body = document.body || document.documentElement;
        r.renderKids(buildKids(body, tagOf(body), ctx, false, false), 0, mode === "all", false);
      }
      return { ...r.result(), ariaHidden: ctx.ariaHidden, actCount: ctx.actCount };
    };
    let out = walk(false);
    // A page that left aria-hidden/inert on its whole app root (a modal
    // library bug) would offer nothing to act on: show what is on screen
    // instead. A real modal keeps its own controls, so it never gets here.
    if (out.actCount === 0 && out.ariaHidden) out = walk(true);

    const { lines, iframes, truncated } = out;
    if (refs.size > PRUNE_AT) refs.prune();
    const res = { docKey, rev, url: location.href, isTop, lines, iframes, truncated, ms: Math.round((performance.now() - t0) * 10) / 10 };
    if (isTop) res.title = document.title;
    if (parentRefP) res.parentRef = (await parentRefP)?.ref ?? null;
    return res;
  }

  register("snapshot", snapshotOp);
}
