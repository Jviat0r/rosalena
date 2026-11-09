// Functions that run INSIDE the page (Playwright serializes each one with toString and
// evaluates it in a frame), so each must be self-contained: no imports, no closures over
// module scope, every helper defined inside.
//
// State lives on a non-enumerable window property, so it disappears with the document:
// that is what makes a ref "valid until the page changes". The same element keeps its
// ref across snapshots of one document, so a diff between two snapshots means something.

/**
 * The page (one frame) as outline lines: `{ d, t, iframe? }`.
 *   interactiveOnly  elements you can act on, plus headings and dialogs as anchors
 *   full             also landmarks, images and text, indented by landmark depth
 * Each actionable element gets a ref (`e12`) stored in the page, never in the DOM.
 */
export function snapshotInPage({ interactiveOnly = true, maxLines = 700 } = {}) {
  const KEY = "__rosalenaBrowser";
  let st = window[KEY];
  if (!st) {
    st = { id: Math.random().toString(36).slice(2), n: 0, f: 0, byRef: new Map(), refOf: new WeakMap(), frameKeys: new WeakMap() };
    try {
      Object.defineProperty(window, KEY, { value: st, configurable: true, enumerable: false });
    } catch {
      window[KEY] = st;
    }
  }
  if (st.byRef.size > 4000) {
    for (const [ref, el] of st.byRef) if (!el.isConnected) st.byRef.delete(ref);
  }

  const lines = [];
  let truncated = false;
  const clean = (s, max = 80) => {
    const t = String(s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const q = (s) => JSON.stringify(s);

  const INTERACTIVE = new Set([
    "link", "button", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "slider", "spinbutton",
    "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "file", "clickable",
  ]);
  // Roles whose children are part of the control itself, so the walk stops there.
  const LEAF = new Set(["link", "button", "textbox", "searchbox", "checkbox", "radio", "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "file"]);
  const LANDMARK = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "form", "dialog", "alertdialog", "region", "search", "table", "alert", "status"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "OPTION", "OPTGROUP", "DATALIST"]);
  const CONTROL_SELECTOR = "a[href],button,input,select,textarea,iframe,frame,h1,h2,h3,h4,h5,h6,img,[role],[tabindex],[contenteditable],[onclick]";

  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0].toLowerCase();
    if (explicit && explicit !== "presentation" && explicit !== "none" && explicit !== "generic") return explicit;
    const tag = el.tagName;
    switch (tag) {
      case "A": return el.hasAttribute("href") ? "link" : "";
      case "BUTTON": case "SUMMARY": return "button";
      case "INPUT": {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "hidden") return "";
        if (["button", "submit", "reset", "image"].includes(t)) return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        if (t === "file") return "file";
        if (el.list) return "combobox";
        return "textbox";
      }
      case "TEXTAREA": return "textbox";
      case "SELECT": return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "IMG": return el.getAttribute("alt") === "" ? "" : "img";
      case "NAV": return "navigation";
      case "MAIN": return "main";
      case "HEADER": return el.closest("article,section,main") ? "" : "banner";
      case "FOOTER": return el.closest("article,section,main") ? "" : "contentinfo";
      case "ASIDE": return "complementary";
      case "FORM": return "form";
      case "DIALOG": return "dialog";
      case "TABLE": return "table";
      case "IFRAME": case "FRAME": return "iframe";
      default: break;
    }
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    // Something a script made clickable: an onclick, a tab stop, or the pointer cursor
    // where its parent has none (otherwise every child of a card would qualify).
    if (el.hasAttribute("onclick") || typeof el.onclick === "function") return "clickable";
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) >= 0) return "clickable";
    try {
      if (getComputedStyle(el).cursor === "pointer" && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer")) return "clickable";
    } catch {
      /* detached */
    }
    return "";
  };

  const labelText = (el) => {
    const labels = el.labels ? [...el.labels] : [];
    const parts = labels.map((l) => {
      const c = l.cloneNode(true);
      c.querySelectorAll("input,select,textarea,button").forEach((x) => x.remove());
      return c.textContent;
    });
    return clean(parts.join(" "));
  };

  const nameOf = (el, role) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || "").join(" "));
      if (t) return t;
    }
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const t = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["button", "submit", "reset"].includes(t)) return clean(el.value || t);
      if (tag === "INPUT" && t === "image") return clean(el.alt || el.value || "image");
      return labelText(el) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("name"), 40);
    }
    if (tag === "IMG") return clean(el.getAttribute("alt") || el.getAttribute("title"));
    if (tag === "IFRAME" || tag === "FRAME") return clean(el.title || el.name || el.getAttribute("src") || "", 60);
    const fromContent = ["button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "checkbox", "radio", "switch", "clickable", "alert", "status"];
    if (fromContent.includes(role)) {
      const text = clean(el.innerText || el.textContent, role === "clickable" ? 60 : 80);
      if (text) return text;
      const img = el.querySelector("img[alt],svg[aria-label],[aria-label]");
      if (img) return clean(img.getAttribute("alt") || img.getAttribute("aria-label"));
    }
    return clean(el.getAttribute("title"));
  };

  const stateOf = (el, role) => {
    const out = [];
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "INPUT" && type === "password") {
      out.push("(password field: never type into it, ask the user)");
    } else if (tag === "INPUT" || tag === "TEXTAREA") {
      if (type === "checkbox" || type === "radio") {
        if (el.checked) out.push("[checked]");
      } else if (type === "file") {
        out.push(el.files && el.files.length ? `files=${q([...el.files].map((f) => f.name).join(", "))}` : "(file input: use browser_upload)");
      } else if (!["button", "submit", "reset", "image"].includes(type)) {
        out.push(`value=${q(clean(el.value, 60))}`);
      }
    } else if (role === "textbox" && el.isContentEditable) {
      out.push(`value=${q(clean(el.innerText, 60))}`);
    }
    if (tag === "SELECT") {
      out.push(`value=${q([...el.selectedOptions].map((o) => clean(o.label || o.text, 30)).join(", "))}`);
      const opts = [...el.options];
      out.push(`options: ${opts.slice(0, 12).map((o) => clean(o.label || o.text, 30)).join(" | ")}${opts.length > 12 ? ` | …${opts.length - 12} more` : ""}`);
    }
    const aria = (n) => el.getAttribute(n);
    if (aria("aria-checked") === "true" && !el.checked) out.push("[checked]");
    if (aria("aria-checked") === "mixed") out.push("[mixed]");
    if (aria("aria-pressed") === "true") out.push("[pressed]");
    if (aria("aria-selected") === "true") out.push("[selected]");
    if (aria("aria-expanded") === "true") out.push("[expanded]");
    if (aria("aria-expanded") === "false") out.push("[collapsed]");
    if (el.disabled || aria("aria-disabled") === "true") out.push("[disabled]");
    if (el.required || aria("aria-required") === "true") out.push("[required]");
    if (el.readOnly && (tag === "INPUT" || tag === "TEXTAREA")) out.push("[readonly]");
    if (role === "link") {
      const raw = el.getAttribute("href") || "";
      if (raw && !/^\s*javascript:/i.test(raw)) {
        try {
          const u = new URL(el.href);
          const shown = u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : `${u.host}${u.pathname}`;
          out.push(`-> ${shown.length > 60 ? `${shown.slice(0, 59)}…` : shown}`);
        } catch {
          /* odd href */
        }
      }
    }
    return out.length ? ` ${out.join(" ")}` : "";
  };

  const refFor = (el) => {
    let ref = st.refOf.get(el);
    if (!ref) {
      ref = `e${++st.n}`;
      st.refOf.set(el, ref);
    }
    st.byRef.set(ref, el);
    return ref;
  };

  const emit = (d, t, extra) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    lines.push(extra ? { d: interactiveOnly ? 0 : d, t, ...extra } : { d: interactiveOnly ? 0 : d, t });
  };

  const walk = (el, depth) => {
    if (truncated) return;
    if (SKIP.has(el.tagName)) return;
    if (el.getAttribute("aria-hidden") === "true" || el.hidden) return;
    let style;
    try {
      if (el.checkVisibility && !el.checkVisibility()) return;
      style = getComputedStyle(el);
    } catch {
      return;
    }
    if (style.display === "none") return;
    const hiddenSelf = style.visibility !== "visible" || (style.display !== "contents" && el.getClientRects().length === 0 && el.tagName !== "BODY");
    const role = hiddenSelf ? "" : roleOf(el);

    if (role === "iframe") {
      let key = st.frameKeys.get(el);
      if (!key) {
        key = `i${++st.f}`;
        st.frameKeys.set(el, key);
      }
      emit(depth, `iframe ${q(nameOf(el, role))}`, { iframe: key });
      return;
    }
    if (role === "heading") {
      const level = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : Number(el.getAttribute("aria-level")) || 2;
      const name = nameOf(el, role);
      if (name) emit(depth, `heading ${q(name)} (h${level})`);
      return;
    }
    if (INTERACTIVE.has(role)) {
      const container = role === "clickable" && el.querySelector(CONTROL_SELECTOR);
      if (!container) {
        const name = nameOf(el, role);
        emit(depth, `[${refFor(el)}] ${role}${name ? ` ${q(name)}` : ""}${stateOf(el, role)}`);
        if (LEAF.has(role) || role === "clickable" || el.tagName === "SELECT") return;
      }
    }

    let childDepth = depth;
    if (role === "alert" || role === "status") {
      // Messages such as "Saved" or "Email is required": worth showing in both modes.
      const text = clean(el.innerText, 160);
      if (text) emit(depth, `${role} ${q(text)}`);
      if (!el.querySelector(CONTROL_SELECTOR)) return;
      childDepth = depth + 1;
    } else if (LANDMARK.has(role)) {
      if (!interactiveOnly || role === "dialog" || role === "alertdialog") {
        const name = nameOf(el, role);
        emit(depth, `${role}${name ? ` ${q(name)}` : ""}`);
        childDepth = depth + 1;
      }
    } else if (!interactiveOnly && role === "img") {
      const name = nameOf(el, role);
      if (name) emit(depth, `img ${q(name)}`);
      return;
    }

    if (!interactiveOnly && !hiddenSelf) {
      const direct = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ");
      if (clean(direct)) {
        if (!el.querySelector(CONTROL_SELECTOR)) {
          emit(childDepth, `text ${q(clean(el.innerText || el.textContent, 160))}`);
          return;
        }
        emit(childDepth, `text ${q(clean(direct, 160))}`);
      }
    }

    for (const child of el.children) walk(child, childDepth);
    if (el.shadowRoot) for (const child of el.shadowRoot.children) walk(child, childDepth);
  };

  if (document.body) walk(document.body, 0);
  return { id: st.id, title: document.title, url: location.href, lines, truncated };
}

/** The element a ref names in this frame, or null when the ref is unknown or gone. */
export function elementForRef(ref) {
  const st = window.__rosalenaBrowser;
  const el = st && st.byRef.get(ref);
  return el && el.isConnected ? el : null;
}

/** What kind of field an element is, for the password and upload guards. */
export function describeField(el) {
  const tag = el.tagName;
  const type = (el.getAttribute("type") || "").toLowerCase();
  const attrs = [el.getAttribute("autocomplete"), el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder")].filter(Boolean).join(" ");
  return {
    tag,
    type,
    password: tag === "INPUT" && type === "password",
    secretHint: /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|\bpassw(or)?d\b|\bpwd\b|\bcvv\b|\bcvc\b|card.?number/i.test(attrs),
    editable: (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color", "hidden"].includes(type)) || tag === "TEXTAREA" || el.isContentEditable,
    file: tag === "INPUT" && type === "file",
    select: tag === "SELECT",
  };
}

/** The focused element's field description (for browser_press without a ref). */
export function focusedField() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body) return null;
  const type = (el.getAttribute("type") || "").toLowerCase();
  return { password: el.tagName === "INPUT" && type === "password" };
}

/** Resolve once the DOM has stopped changing for `quietMs`, or after `maxMs`. */
export function quietInPage({ quietMs = 250, maxMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let timer;
    let hard;
    const done = () => {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(hard);
      resolve(true);
    };
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    obs.observe(document, { subtree: true, childList: true, characterData: true });
    timer = setTimeout(done, quietMs);
    hard = setTimeout(done, maxMs);
  });
}

/** Scroll the page or an element's nearest scroller; report where it ended up. */
export function scrollInPage({ direction = "down", amount = 0.8 } = {}) {
  const el = document.scrollingElement || document.documentElement;
  const dy = Math.round(window.innerHeight * amount) * (direction === "up" ? -1 : 1);
  if (direction === "top") el.scrollTop = 0;
  else if (direction === "bottom") el.scrollTop = el.scrollHeight;
  else window.scrollBy(0, dy);
  return { y: Math.round(el.scrollTop), height: Math.round(el.scrollHeight), view: window.innerHeight };
}

/**
 * The page's main content as markdown: no nav, header, footer, aside, forms, fixed
 * overlays or cookie/consent banners. Picks <main>, then the largest <article>, then body.
 */
export function markdownInPage() {
  const COOKIE = /cookie|consent|gdpr|onetrust|cookiebot|cc-banner|cmp-|didomi|truste|usercentrics/i;
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "NAV", "ASIDE", "FORM", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "FRAME", "OBJECT", "EMBED", "DIALOG", "VIDEO", "AUDIO", "MAP"]);
  const SKIP_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "dialog", "alertdialog", "menu", "menubar", "toolbar", "tablist"]);
  const BLOCK = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "P", "HEADER", "FOOTER", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "DL", "DT", "DD", "ADDRESS", "LI", "FIELDSET", "CENTER", "HGROUP"]);
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const textLen = (el) => (el ? clean(el.innerText).length : 0);

  const main = document.querySelector("main,[role=main]");
  const articles = [...document.querySelectorAll("article")].sort((a, b) => textLen(b) - textLen(a));
  let root = document.body;
  if (main && textLen(main) > 200) root = main;
  else if (articles[0] && textLen(articles[0]) > 200) root = articles[0];
  if (!root) return { title: document.title, url: location.href, markdown: "" };

  const skip = (el) => {
    if (el === root) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (SKIP_ROLES.has(role)) return true;
    // A page-level header or footer is chrome; an article's own header holds its title.
    if ((el.tagName === "HEADER" || el.tagName === "FOOTER") && !el.parentElement?.closest("article,main,[role=main]")) return true;
    const marker = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("aria-label") || ""}`;
    if (COOKIE.test(marker)) return true;
    try {
      if (el.checkVisibility && !el.checkVisibility()) return true;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return true;
      if (s.position === "fixed" || s.position === "sticky") return true;
    } catch {
      return true;
    }
    return false;
  };

  const convert = (container) => {
    const out = [];
    let buf = "";
    const flush = () => {
      const t = buf.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) out.push(t);
      buf = "";
    };
    const inline = (el) => clean(el.innerText || el.textContent);
    const visit = (node) => {
      if (node.nodeType === 3) {
        buf += node.nodeValue.replace(/\s+/g, " ");
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (skip(el)) return;
      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        flush();
        const t = inline(el);
        if (t) out.push(`${"#".repeat(Number(tag[1]))} ${t}`);
        return;
      }
      switch (tag) {
        case "BR": buf += "\n"; return;
        case "HR": flush(); out.push("---"); return;
        case "PRE": flush(); out.push(`\`\`\`\n${(el.innerText || el.textContent).replace(/\n+$/, "")}\n\`\`\``); return;
        case "UL":
        case "OL": {
          flush();
          let i = 0;
          const items = [];
          for (const li of el.children) {
            if (li.tagName !== "LI" || skip(li)) continue;
            i += 1;
            const body = convert(li).join("\n");
            if (!body) continue;
            const mark = tag === "OL" ? `${i}. ` : "- ";
            items.push(mark + body.split("\n").join("\n   "));
          }
          if (items.length) out.push(items.join("\n"));
          return;
        }
        case "TABLE": {
          flush();
          const rows = [...el.rows].map((r) => [...r.cells].map((c) => inline(c).replace(/\|/g, "\\|")));
          if (rows.length) {
            const width = Math.max(...rows.map((r) => r.length));
            const line = (r) => `| ${[...r, ...Array(width - r.length).fill("")].join(" | ")} |`;
            out.push([line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n"));
          }
          return;
        }
        case "BLOCKQUOTE": flush(); out.push(convert(el).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n")); return;
        case "A": {
          const t = inline(el);
          const href = el.href;
          buf += t && href && /^https?:/i.test(href) ? ` [${t}](${href}) ` : ` ${t} `;
          return;
        }
        case "IMG": {
          const alt = clean(el.getAttribute("alt"));
          if (alt) buf += ` [image: ${alt}] `;
          return;
        }
        case "STRONG": case "B": { const t = inline(el); if (t) buf += ` **${t}** `; return; }
        case "EM": case "I": { const t = inline(el); if (t) buf += ` *${t}* `; return; }
        case "CODE": { const t = el.textContent; if (t) buf += ` \`${t}\` `; return; }
        default: break;
      }
      let block = BLOCK.has(tag);
      if (!block && tag.includes("-")) {
        try {
          block = /^(block|flex|grid|list-item|table)$/.test(getComputedStyle(el).display);
        } catch {
          /* inline */
        }
      }
      if (block) flush();
      for (const child of el.childNodes) visit(child);
      if (el.shadowRoot) for (const child of el.shadowRoot.childNodes) visit(child);
      if (block) flush();
    };
    for (const child of container.childNodes) visit(child);
    if (container.shadowRoot) for (const child of container.shadowRoot.childNodes) visit(child);
    flush();
    return out;
  };

  const blocks = convert(root).map((b) => b.replace(/ +([.,;:!?)])/g, "$1").replace(/\( +/g, "("));
  return { title: document.title, url: location.href, markdown: blocks.join("\n\n") };
}
