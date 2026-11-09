#!/usr/bin/env node
// ui-audit - render a page at phone, tablet and desktop widths and measure what a person
// would see. Read-only. For models that cannot see images, this text IS the visual check;
// for models that can, it also saves the screenshots to look at.
//
//   node ui-audit.mjs <url> [--out <dir>] [--widths 390,768,1440] [--json]
//
// Every line is PASS / WARN / FAIL, then the area, the finding and how to fix it.
// Exit code: 0 no FAIL, 1 at least one FAIL, 2 could not run.
//
// Browser: CHROME_PATH if set, else Playwright's own Chromium if installed, else the
// Edge or Chrome already on the machine (Edge ships with every Windows 10/11).

import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const url = args.find((a) => /^(https?:|file:)/.test(a)) ?? (args[0] && existsSync(args[0]) ? `file://${resolve(args[0])}` : null);
if (!url) {
  console.log("usage: node ui-audit.mjs <url or html file> [--out <dir>] [--widths 390,768,1440] [--json]");
  process.exit(2);
}
const outDir = resolve(flag("out", ".rosalena/ui-check"));
const widths = String(flag("widths", "390,768,1440")).split(",").map(Number).filter((n) => n > 200);
const asJson = args.includes("--json");

// --------------------------------------------------------------------------- browser

async function loadPlaywright() {
  const here = createRequire(import.meta.url);
  const fromCwd = createRequire(join(process.cwd(), "noop.js"));
  for (const req of [here, fromCwd]) {
    for (const name of ["playwright-core", "playwright"]) {
      try {
        return req(name);
      } catch {
        /* next */
      }
    }
  }
  for (const name of ["playwright-core", "playwright"]) {
    try {
      return await import(name);
    } catch {
      /* next */
    }
  }
  return null;
}

function systemBrowsers() {
  const os = platform();
  if (os === "win32") {
    const pf = [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean);
    return pf.flatMap((base) => [
      join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
      join(base, "Google", "Chrome", "Application", "chrome.exe"),
      join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ]);
  }
  if (os === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
  }
  return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/opt/pw-browsers/chromium"];
}

async function launch(pw) {
  const tries = [];
  if (process.env.CHROME_PATH) tries.push({ executablePath: process.env.CHROME_PATH });
  tries.push({});
  for (const exe of systemBrowsers()) if (existsSync(exe)) tries.push({ executablePath: exe });
  let last;
  for (const opts of tries) {
    try {
      return await pw.chromium.launch({ headless: true, ...opts });
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new Error("no browser found");
}

// --------------------------------------------------------------------------- in-page measurement

/** Runs inside the page. Returns raw measurements; judging happens in Node. */
function measure() {
  const vw = window.innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    else if (el.classList.length) s += `.${[...el.classList].slice(0, 2).join(".")}`;
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return text ? `${s} "${text}"` : s;
  };
  const parseColor = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a),
    g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a),
    a: 1,
  });
  /** The solid color behind an element, or null when an image or gradient is behind it. */
  const backgroundOf = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let color = { r: 255, g: 255, b: 255, a: 1 };
    for (const layer of layers.reverse()) color = blend(layer, color);
    return color;
  };

  const out = { vw, docWidth: document.documentElement.scrollWidth, overflowers: [], contrast: [], unknownBg: 0, families: {}, sizes: {}, tiny: [], h1: [], headlines: [], targets: [], images: [], unlabeled: [], nameless: [], gradients: [], eyebrows: [], transitionAll: [], blur: [], animated: 0 };

  const all = [...document.body.querySelectorAll("*")];
  for (const el of all) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.right > vw + 1 && s.position !== "fixed" && out.overflowers.length < 8) {
      // Only the outermost offender: its children overflow because it does.
      if (!out.overflowers.some((o) => o.el.contains(el))) out.overflowers.push({ el, d: describe(el), right: Math.round(r.right) });
    }
    if (s.transitionProperty.split(",").some((p) => p.trim() === "all") && s.transitionDuration !== "0s") out.transitionAll.push(describe(el));
    if (/blur\(/.test(s.backdropFilter || s.webkitBackdropFilter || "")) out.blur.push(describe(el));
    if (/gradient\(/.test(s.backgroundImage) && r.width * r.height > 20000 && !el.querySelector("img,video")) out.gradients.push(describe(el));
    if (s.animationName !== "none" || (s.transitionDuration !== "0s" && s.transitionProperty !== "none")) out.animated += 1;

    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (ownText) {
      const size = parseFloat(s.fontSize);
      const family = s.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      out.families[family] = (out.families[family] ?? 0) + 1;
      out.sizes[Math.round(size)] = (out.sizes[Math.round(size)] ?? 0) + 1;
      if (size < 12) out.tiny.push(`${describe(el)} ${size}px`);
      const fg = parseColor(s.color);
      const bg = backgroundOf(el);
      if (fg && bg) {
        const c = blend(fg, bg);
        const [l1, l2] = [lum(c), lum(bg)].sort((a, b) => b - a);
        const ratio = (l1 + 0.05) / (l2 + 0.05);
        const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
        const need = large ? 3 : 4.5;
        if (ratio < need) out.contrast.push({ d: describe(el), ratio: Math.round(ratio * 100) / 100, need });
      } else if (fg) out.unknownBg += 1;
      const tracking = parseFloat(s.letterSpacing) / size;
      if (s.textTransform === "uppercase" && size <= 14 && tracking >= 0.05) {
        const next = el.nextElementSibling;
        if (next && /^H[1-3]$/.test(next.tagName)) out.eyebrows.push(describe(el));
      }
    }
  }

  for (const h of document.querySelectorAll("h1")) {
    if (!visible(h)) continue;
    const s = getComputedStyle(h);
    const lh = s.lineHeight === "normal" ? parseFloat(s.fontSize) * 1.2 : parseFloat(s.lineHeight);
    out.h1.push(describe(h));
    out.headlines.push({ d: describe(h), lines: Math.round(h.getBoundingClientRect().height / lh) });
  }

  for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [tabindex]:not([tabindex='-1'])")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const inline = el.tagName === "A" && getComputedStyle(el).display === "inline" && el.closest("p, li");
    if (!inline && (r.width < 44 || r.height < 44)) out.targets.push(`${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    const name = (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title") || el.innerText || el.value || el.getAttribute("alt") || "").trim();
    if ((el.tagName === "BUTTON" || el.tagName === "A") && !name && !el.querySelector("img[alt]:not([alt=''])")) out.nameless.push(describe(el));
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !["submit", "button", "reset", "image"].includes(el.type)) {
      const labelled = el.labels?.length || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.closest("label");
      if (!labelled) out.unlabeled.push(describe(el));
    }
  }

  for (const img of document.querySelectorAll("img")) {
    if (!visible(img)) continue;
    if (!img.hasAttribute("alt")) out.images.push({ d: describe(img), problem: "no alt attribute" });
    else if (!img.getAttribute("width") && !img.getAttribute("height") && getComputedStyle(img).aspectRatio === "auto") out.images.push({ d: describe(img), problem: "no width/height or aspect-ratio (layout shift)" });
  }

  out.overflowers = out.overflowers.map(({ d, right }) => `${d} reaches ${right}px`);
  return out;
}

/** Tab through the first focusable elements and see whether focus is visible at all. */
async function focusCheck(page) {
  return page.evaluate(async () => {
    const els = [...document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])")].slice(0, 8);
    const look = (el) => {
      const s = getComputedStyle(el);
      return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor, s.textDecorationLine].join("|");
    };
    const invisible = [];
    for (const el of els) {
      const before = look(el);
      el.focus({ focusVisible: true });
      const s = getComputedStyle(el);
      const after = look(el);
      const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
      if (!outline && before === after) invisible.push(el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ""));
      el.blur();
    }
    return { checked: els.length, invisible };
  });
}

// --------------------------------------------------------------------------- run

const results = [];
const add = (level, area, message, fix = "") => results.push({ level, area, message, fix });

const pw = await loadPlaywright();
if (!pw) {
  console.log("FAIL setup playwright-core is not installed | run: npm install (in this script's folder), or npm i -D playwright-core in the project");
  process.exit(2);
}
let browser;
try {
  browser = await launch(pw);
} catch (err) {
  console.log(`FAIL setup no Chromium-based browser could start (${String(err?.message ?? err).split("\n")[0]}) | install Chrome or Edge, or set CHROME_PATH`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const shots = [];
const consoleErrors = new Set();

for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && consoleErrors.add(m.text().slice(0, 160)));
  page.on("pageerror", (e) => consoleErrors.add(String(e.message).slice(0, 160)));
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  } catch (err) {
    add("FAIL", "load", `${url} did not load at ${width}px: ${String(err.message).split("\n")[0]}`, "start the dev server (background job) and pass its URL");
    await context.close();
    continue;
  }
  await page.waitForTimeout(300);
  const m = await page.evaluate(measure);
  const at = `@${width}`;

  if (m.docWidth > width + 1) add("FAIL", `overflow${at}`, `page is ${m.docWidth}px wide in a ${width}px window: ${m.overflowers.slice(0, 3).join("; ")}`, "find the fixed width or long unbroken content; use max-width:100%, min-width:0 on flex/grid children, overflow-wrap:anywhere");
  else add("PASS", `overflow${at}`, "no horizontal scroll");

  for (const c of m.contrast.slice(0, 6)) add("FAIL", `contrast${at}`, `${c.d} is ${c.ratio}:1, needs ${c.need}:1`, "darken the text or change the background; body text in full ink");
  if (m.contrast.length > 6) add("FAIL", `contrast${at}`, `${m.contrast.length - 6} more low-contrast text elements`);
  if (!m.contrast.length) add("PASS", `contrast${at}`, "all measurable text meets 4.5:1 (3:1 large)");
  if (m.unknownBg) add("WARN", `contrast${at}`, `${m.unknownBg} text element(s) sit on an image or gradient, so contrast was not measured`, "check them in the screenshot; add a solid or scrim layer behind text");

  for (const h of m.headlines) if (h.lines > 2 && width < 800) add("WARN", `type${at}`, `${h.d} wraps to ${h.lines} lines`, "shorten it or lower the display size at this width (clamp())");
  if (width === widths[0]) {
    if (m.h1.length !== 1) add("WARN", "structure", `${m.h1.length} visible <h1> elements`, "one <h1> per page");
    const families = Object.keys(m.families);
    if (families.length > 2) add("WARN", "type", `${families.length} font families in use: ${families.join(", ")}`, "use 1-2 families");
    const sizes = Object.keys(m.sizes).map(Number).sort((a, b) => a - b);
    if (sizes.length > 6) add("WARN", "type", `${sizes.length} font sizes in use: ${sizes.join(", ")}px`, "collapse to a scale of about 5 sizes");
    for (const t of m.tiny.slice(0, 3)) add("WARN", "type", `tiny text: ${t}`, "12px minimum, 16px for body");
    for (const t of m.targets.slice(0, 5)) add("WARN", `targets${at}`, `small touch target: ${t}`, "at least 44x44px on touch (padding, not font size)");
    for (const n of m.nameless.slice(0, 5)) add("FAIL", "a11y", `${n} has no accessible name`, "add aria-label to icon-only buttons and links");
    for (const u of m.unlabeled.slice(0, 5)) add("FAIL", "a11y", `${u} has no label`, "wrap in <label> or add aria-label");
    for (const i of m.images.slice(0, 5)) add(i.problem.startsWith("no alt") ? "FAIL" : "WARN", "images", `${i.d}: ${i.problem}`, i.problem.startsWith("no alt") ? 'add alt="" for decoration, a description otherwise' : "set width and height attributes");
    for (const g of m.gradients.slice(0, 2)) add("WARN", "taste", `decorative gradient on ${g}`, "use a solid surface unless the brand asks for gradients");
    for (const e of m.eyebrows.slice(0, 2)) add("WARN", "taste", `small tracked ALL-CAPS label above a heading: ${e}`, "remove the eyebrow; let the heading stand alone");
    for (const b of m.blur.slice(0, 2)) add("WARN", "taste", `backdrop blur on ${b}`, "use a solid surface");
    for (const t of m.transitionAll.slice(0, 2)) add("WARN", "motion", `transition: all on ${t}`, "transition only transform and opacity");

    const focus = await focusCheck(page);
    if (focus.invisible.length) add("FAIL", "a11y", `no visible focus style on ${focus.invisible.length} of ${focus.checked} focusable elements (${focus.invisible.slice(0, 4).join(", ")})`, "add :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }");
    else if (focus.checked) add("PASS", "a11y", `focus is visible on the first ${focus.checked} focusable elements`);
  }

  const file = join(outDir, `ui-${width}.png`);
  await page.screenshot({ path: file, fullPage: true, clip: undefined, timeout: 15_000 }).catch(() => page.screenshot({ path: file }));
  shots.push(file);
  await context.close();
}

// Reduced motion: anything still animating when the person asked for less motion.
try {
  const context = await browser.newContext({ viewport: { width: widths.at(-1) ?? 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && (a.effect?.getTiming?.().duration ?? 0) > 50).length);
  if (running) add("WARN", "motion", `${running} animation(s) still run with prefers-reduced-motion: reduce`, "wrap motion in @media (prefers-reduced-motion: no-preference) or turn it off under reduce");
  await context.close();
} catch {
  /* reported by the load check above */
}

for (const e of [...consoleErrors].slice(0, 5)) add("FAIL", "console", e, "fix the error; a broken script often hides content");
await browser.close();

const fails = results.filter((r) => r.level === "FAIL").length;
const warns = results.filter((r) => r.level === "WARN").length;
if (asJson) {
  console.log(JSON.stringify({ url, widths, results, screenshots: shots, fails, warns }, null, 2));
} else {
  for (const r of results.sort((a, b) => ["FAIL", "WARN", "PASS"].indexOf(a.level) - ["FAIL", "WARN", "PASS"].indexOf(b.level))) {
    console.log(`${r.level} ${r.area} ${r.message}${r.fix ? ` | ${r.fix}` : ""}`);
  }
  console.log(`\n${fails} FAIL, ${warns} WARN. Screenshots: ${shots.join(", ")}`);
}
writeFileSync(join(outDir, "report.json"), JSON.stringify({ url, widths, results, screenshots: shots }, null, 2));
process.exit(fails ? 1 : 0);
