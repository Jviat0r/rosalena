// Style Lab's pure logic: the token rules (a mirror of THEME_TOKENS in the app's
// plugin-host.js), colour parsing, WCAG contrast, and reading a skin file. Nothing here
// touches the page, so the self-tests and a plain Node check can use it as is.

import { DEFAULT_DARK, DEFAULT_LIGHT } from "./skins.js";

// The same three patterns the app checks a theme against. A value that passes these is a
// value theme.set will accept.
export const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/-]+\))$/i;
export const LENGTH = /^\d{1,2}(\.\d+)?px$/;
export const FONT = /^[\w\s"',.-]{1,200}$/;

export const COLOR_TOKENS = ["bg", "panel", "line", "line-soft", "text", "dim", "accent", "accent-soft", "ok", "warn", "bad", "live", "btn-ink"];
export const LENGTH_TOKENS = ["radius", "radius-sm", "radius-xs"];
export const FONT_TOKENS = ["sans", "mono"];
export const ALL_TOKENS = [...COLOR_TOKENS, ...LENGTH_TOKENS, ...FONT_TOKENS];

export const THEME_TOKENS = Object.freeze({
  ...Object.fromEntries(COLOR_TOKENS.map((t) => [t, COLOR])),
  ...Object.fromEntries(LENGTH_TOKENS.map((t) => [t, LENGTH])),
  ...Object.fromEntries(FONT_TOKENS.map((t) => [t, FONT])),
});

export const TOKEN_LABELS = {
  bg: "Background",
  panel: "Panels",
  line: "Borders",
  "line-soft": "Soft borders",
  text: "Text",
  dim: "Muted text",
  accent: "Accent",
  "accent-soft": "Accent wash",
  ok: "Success",
  warn: "Warning",
  bad: "Error",
  live: "Live",
  "btn-ink": "Button ink",
};

const HINT = {
  color: "a colour like #1a2b3c, rgb(26, 43, 60) or hsl(210, 40%, 17%)",
  length: "a length from 0px to 99px",
  font: "a font list of letters, spaces, quotes and commas",
};
const hintFor = (name) => (LENGTH_TOKENS.includes(name) ? HINT.length : FONT_TOKENS.includes(name) ? HINT.font : HINT.color);

// ------------------------------------------------------------------ colour maths

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Parse a hex, rgb() or hsl() colour. Returns { r, g, b, a } (0-255, alpha 0-1) or null. */
export function parseColor(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h) || ![3, 4, 6, 8].includes(h.length)) return null;
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    const n = (i) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const m = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (!m) return null;
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const num = (p) => {
    const v = parseFloat(p);
    return Number.isFinite(v) ? v : NaN;
  };
  const alpha = parts[3] == null ? 1 : parts[3].endsWith("%") ? num(parts[3]) / 100 : num(parts[3]);
  if (!Number.isFinite(alpha)) return null;
  if (m[1].startsWith("rgb")) {
    const ch = parts.slice(0, 3).map((p) => (p.endsWith("%") ? num(p) * 2.55 : num(p)));
    if (ch.some((v) => !Number.isFinite(v))) return null;
    return { r: clamp(Math.round(ch[0]), 0, 255), g: clamp(Math.round(ch[1]), 0, 255), b: clamp(Math.round(ch[2]), 0, 255), a: clamp(alpha, 0, 1) };
  }
  const h = (((num(parts[0]) % 360) + 360) % 360) / 360;
  const sat = clamp(num(parts[1]) / 100, 0, 1);
  const lig = clamp(num(parts[2]) / 100, 0, 1);
  if (![h, sat, lig].every(Number.isFinite)) return null;
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const hue = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: Math.round(hue(h + 1 / 3) * 255), g: Math.round(hue(h) * 255), b: Math.round(hue(h - 1 / 3) * 255), a: clamp(alpha, 0, 1) };
}

export function toHex(c) {
  const x = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${x(c.r)}${x(c.g)}${x(c.b)}`;
}

/** Any valid colour as #rrggbb (for an <input type="color">), or the fallback. */
export function hexOf(value, fallback = "#000000") {
  const c = parseColor(value);
  return c ? toHex(c) : fallback;
}

const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

/** WCAG 2 contrast of fg drawn on bg. A translucent fg is blended over bg first. */
export function contrast(fg, bg) {
  const b = typeof bg === "string" ? parseColor(bg) : bg;
  let f = typeof fg === "string" ? parseColor(fg) : fg;
  if (!f || !b) return 1;
  if (f.a < 1) f = { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 };
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The pairs the app actually draws, and the WCAG minimum each needs. */
export const CONTRAST_PAIRS = [
  { fg: "text", bg: "bg", label: "Text on background", min: 4.5 },
  { fg: "text", bg: "panel", label: "Text on panels", min: 4.5 },
  { fg: "dim", bg: "bg", label: "Muted text on background", min: 4.5 },
  { fg: "dim", bg: "panel", label: "Muted text on panels", min: 4.5 },
  { fg: "btn-ink", bg: "accent", label: "Button ink on accent", min: 4.5 },
  { fg: "accent", bg: "bg", label: "Accent on background", min: 3 },
];

export function contrastReport(tokens) {
  const pairs = CONTRAST_PAIRS.map((p) => {
    const ratio = contrast(tokens[p.fg], tokens[p.bg]);
    return { ...p, ratio, pass: ratio >= p.min };
  });
  const textMin = Math.min(pairs[0].ratio, pairs[1].ratio);
  return { pairs, textMin, allPass: pairs.every((p) => p.pass) };
}

export function grade(ratio) {
  if (ratio >= 7) return "AAA";
  if (ratio >= 4.5) return "AA";
  return "Low";
}

export const isLight = (tokens) => luminance(parseColor(tokens.bg) ?? { r: 0, g: 0, b: 0 }) > 0.4;

/** Black or white, whichever reads better on the given colour. */
export function inkFor(color) {
  return contrast("#000000", color) >= contrast("#ffffff", color) ? "#000000" : "#ffffff";
}

// ---------------------------------------------------------------- token checks

/**
 * Check a token object against the app's rules. Returns { ok, tokens, errors }: tokens is
 * the trimmed copy that theme.set would store, errors are sentences for a person.
 */
export function checkTokens(input, { requireAll = false } = {}) {
  const errors = [];
  const tokens = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, tokens, errors: ["the tokens must be an object like { \"bg\": \"#101010\" }"] };
  for (const [name, value] of Object.entries(input)) {
    const rule = THEME_TOKENS[name];
    if (!rule) {
      errors.push(`"${name}" is not a token the app knows (it knows ${ALL_TOKENS.join(", ")})`);
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`"${name}" must be text, ${hintFor(name)}`);
      continue;
    }
    const text = value.trim();
    if (!rule.test(text)) {
      errors.push(`"${name}" must be ${hintFor(name)}; got "${text.slice(0, 60)}"`);
      continue;
    }
    if (rule === COLOR && !parseColor(text)) {
      errors.push(`"${name}" passes the pattern but is not a colour that can be drawn: "${text.slice(0, 60)}"`);
      continue;
    }
    tokens[name] = text;
  }
  if (requireAll) {
    const missing = ALL_TOKENS.filter((t) => !(t in tokens) && !(t in input));
    if (missing.length) errors.push(`missing ${missing.join(", ")}`);
  }
  return { ok: errors.length === 0, tokens, errors };
}

export function cleanName(value, fallback = "Untitled skin") {
  const s = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return s || fallback;
}

export function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "skin"
  );
}

export const FILE_LIMIT = 64 * 1024;

/** The JSON a skin exports as. Every token is written, so it re-imports exactly. */
export function skinToJson(skin) {
  const tokens = {};
  for (const t of ALL_TOKENS) if (skin.tokens[t] != null) tokens[t] = skin.tokens[t];
  return JSON.stringify({ rosalenaSkin: 1, name: skin.name, tokens }, null, 2) + "\n";
}

/**
 * Read a skin file. Returns { ok: true, skin, filled, warnings } or { ok: false, error }.
 * Accepts { name, tokens: {...} } (what Style Lab exports) or a bare token object.
 * bg, panel, text and accent are required; any other missing token is filled from the
 * app's default look (dark or light, by the skin's background) so the skin is complete.
 */
export function parseSkinFile(text, { fileName = "" } = {}) {
  const raw = String(text ?? "");
  if (!raw.trim()) return { ok: false, error: "That file is empty." };
  if (raw.length > FILE_LIMIT) return { ok: false, error: `That file is ${Math.round(raw.length / 1024)} KB; a skin file is a few hundred bytes (the limit is 64 KB).` };
  let data;
  try {
    data = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    return { ok: false, error: `That file is not valid JSON (${String(err.message || err).slice(0, 120)}).` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: 'A skin file is a JSON object with a "tokens" object inside it.' };
  const source = data.tokens && typeof data.tokens === "object" ? data.tokens : "bg" in data ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== "name" && k !== "rosalenaSkin")) : null;
  if (!source || Array.isArray(source)) return { ok: false, error: 'A skin file needs a "tokens" object, for example { "name": "Mine", "tokens": { "bg": "#101010", ... } }.' };
  const checked = checkTokens(source);
  if (!checked.ok) {
    const more = checked.errors.length > 1 ? ` (and ${checked.errors.length - 1} more)` : "";
    return { ok: false, error: `This skin breaks the app's token rules: ${checked.errors[0]}${more}.` };
  }
  const required = ["bg", "panel", "text", "accent"];
  const missingRequired = required.filter((t) => !(t in checked.tokens));
  if (missingRequired.length) return { ok: false, error: `A skin needs at least bg, panel, text and accent; this one is missing ${missingRequired.join(", ")}.` };
  const base = isLight(checked.tokens) ? DEFAULT_LIGHT : DEFAULT_DARK;
  const filled = ALL_TOKENS.filter((t) => !(t in checked.tokens));
  const tokens = {};
  for (const t of ALL_TOKENS) tokens[t] = checked.tokens[t] ?? base[t];
  const fromFile = fileName.replace(/\.(rosalena-skin\.)?json$/i, "").replace(/[-_]+/g, " ");
  const name = cleanName(typeof data.name === "string" ? data.name : fromFile, "Imported skin");
  const report = contrastReport(tokens);
  const warnings = report.pairs.filter((p) => !p.pass).map((p) => `${p.label.toLowerCase()} is ${p.ratio.toFixed(1)}:1 (aim for ${p.min}:1)`);
  return { ok: true, skin: { name, tokens }, filled, warnings };
}
