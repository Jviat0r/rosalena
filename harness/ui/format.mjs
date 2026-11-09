// Pure formatting for the transcript. No DOM, no framework, no build step - and
// importable from Node, which is the point: the renderer is the one piece of the UI
// that can be wrong in a way nobody notices until a model emits a ``` and the rest of
// the answer turns into a runaway code block. So it lives here, is unit-tested in
// test/ui-format.test.mjs, and the browser imports the very same file.
//
// Everything returns HTML *strings*, so the first rule is that no user or model text
// may reach the page unescaped. `escapeHtml` runs on raw text first; every transform
// below then operates on already-escaped text and only ever emits fixed tags.

import { t } from "./i18n.mjs";

/** Escape text for HTML. The single gate every other function goes through. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A href we are willing to put in the page. Anything else becomes plain text. */
export function safeHref(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  if (/^(https?:\/\/|mailto:)/i.test(raw)) return raw;
  if (/^(\/|#|\.\.?\/)/.test(raw)) return raw; // same-origin links and anchors
  return null;
}

/**
 * Inline formatting inside one block of prose.
 *
 * The input is already escaped, so the only things being matched are literal
 * characters the model typed. Code spans are handled first and their contents are
 * protected by splitting, which is why `**` inside a code span stays literal instead
 * of becoming bold.
 */
export function inlineHtml(escaped) {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>"']+)/g;
  let out = "";
  let last = 0;
  for (const match of escaped.matchAll(pattern)) {
    out += escaped.slice(last, match.index);
    const [whole, code, bold, italic, link, bare] = match;
    if (code) {
      out += `<code>${code.slice(1, -1)}</code>`;
    } else if (bold) {
      out += `<strong>${bold.slice(2, -2)}</strong>`;
    } else if (italic) {
      out += `<em>${italic.slice(1, -1)}</em>`;
    } else if (link) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link) ?? [];
      const safe = safeHref(href);
      out += safe
        ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener">${label}</a>`
        : link;
    } else if (bare) {
      // Trailing punctuation belongs to the sentence, not the URL.
      const trimmed = bare.replace(/[.,;:!?]+$/, "");
      out += `<a href="${escapeHtml(trimmed)}" target="_blank" rel="noreferrer noopener">${trimmed}</a>${bare.slice(trimmed.length)}`;
    }
    last = match.index + whole.length;
  }
  return out + escaped.slice(last);
}

/**
 * One prose block: paragraphs, lists, headings, quotes and rules. Line breaks inside a
 * paragraph are kept as <br>, because chat text uses them and collapsing them makes two
 * separate thoughts read as one.
 */
export function proseHtml(raw) {
  const lines = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null; // "ul" | "ol"
  let listItems = [];
  let quote = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map((line) => inlineHtml(escapeHtml(line))).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list}>${listItems.join("")}</${list}>`);
    list = null;
    listItems = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push(`<blockquote>${quote.map((line) => inlineHtml(escapeHtml(line))).join("<br>")}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quoted = /^>\s?(.*)$/.exec(line);
    const rule = /^\s*([-*_])\1{2,}\s*$/.test(line);

    if (rule) {
      flushAll();
      out.push("<hr>");
      continue;
    }
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 2, 6); // # -> h3: the page owns h1/h2
      out.push(`<h${level}>${inlineHtml(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const kind = bullet ? "ul" : "ol";
      if (list && list !== kind) flushList();
      list = kind;
      listItems.push(`<li>${inlineHtml(escapeHtml((bullet ?? numbered)[1]))}</li>`);
      continue;
    }
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line);
  }
  flushAll();
  return out.join("");
}

function codeBlockHtml(text, lang) {
  const label = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : `<span class="code-lang">code</span>`;
  return (
    `<div class="code-wrap"><div class="code-head">${label}` +
    `<button class="code-copy" type="button" data-copy="1" title="${escapeHtml(t("Copy this block"))}">${escapeHtml(t("Copy"))}</button></div>` +
    `<pre class="code"><code>${escapeHtml(text)}</code></pre></div>`
  );
}

/**
 * Markdown, at the level a chat needs: fenced code, headings, lists, quotes, rules,
 * bold/italic, inline code, links. Everything else stays literal, which is the right
 * failure mode - showing `_x_` as `_x_` is better than guessing.
 */
export function renderMarkdown(text) {
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  const out = [];
  // Three or more backticks open a block (models emit four when the code contains
  // three), and any fence at least as long closes it. A fence alone on a line is what
  // counts; ``` inside a sentence stays literal.
  const fence = /^(`{3,})[ \t]*([\w+#.-]*)[ \t]*$/gm;
  let cursor = 0;
  let open = null;
  for (let m = fence.exec(source); m; m = fence.exec(source)) {
    const body = source.slice(cursor, m.index);
    if (open) {
      // A shorter fence inside a longer one is code, not a terminator: that is the
      // whole reason a four-backtick block exists.
      if (m[1].length < open.ticks) continue;
      // The closing fence: the body since the opener is the code.
      out.push(codeBlockHtml(body.replace(/\n$/, ""), open.lang));
      open = null;
    } else {
      out.push(proseHtml(body));
      open = { lang: m[2], ticks: m[1].length };
    }
    cursor = m.index + m[0].length;
    // A fence at the very end of the text opens a block that never closes; the tail is
    // emitted as code, because that is what the model meant.
  }
  const tail = source.slice(cursor);
  if (open) out.push(codeBlockHtml(tail.replace(/^\n/, ""), open.lang));
  else out.push(proseHtml(tail));
  return out.join("");
}

// --------------------------------------------------------------------- small helpers

export function clip(text, max = 120) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function humanMs(ms) {
  if (ms === null || ms === undefined || ms === "") return "";
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function humanBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function humanTokens(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1000) return `${Math.round(value)} tok`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k tok`;
}

/**
 * A context figure: `~96K`, `~2.1K`, `~1.2M`.
 *
 * The tilde is not decoration. Every number in the meter is either an estimate or a
 * provider count of a slightly different request (the provider counted what it was
 * sent, the gauge shows what is about to be sent), so a bare "96,000" would claim a
 * precision this does not have. One letter suffix, no space: the gauge has one line
 * for two of these and they have to fit.
 */
export function contextTokens(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return "~0";
  if (value < 1000) return `~${Math.round(value)}`;
  if (value < 1_000_000) {
    const k = value / 1000;
    // One decimal only while it adds information: 2.1K, but 96K and 200K, which is
    // the shape the reference meter uses and the shape the eye reads fastest.
    return k < 100 ? `~${k.toFixed(1).replace(/\.0$/, "")}K` : `~${Math.round(k)}K`;
  }
  return `~${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function ago(iso, now = Date.now()) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(1, Math.round((now - then) / 1000));
  if (s < 60) return t("{s}s ago", { s });
  const m = Math.round(s / 60);
  if (m < 60) return t("{m}m ago", { m });
  const h = Math.round(m / 60);
  if (h < 24) return t("{h}h ago", { h });
  const d = Math.round(h / 24);
  return d === 1 ? t("yesterday") : t("{d}d ago", { d });
}

/** Pretty JSON for a tool card, clipped so one huge argument cannot own the pane. */
export function formatArgs(args, max = 2000) {
  if (args === undefined || args === null) return "";
  let text;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = String(args);
  }
  if (text === "{}") return "";
  return text.length > max ? `${text.slice(0, max)}\n${t("… ({more} more characters)", { more: text.length - max })}` : text;
}

/**
 * A one-line reason to open a tool card: what the tool was pointed at. This is what
 * makes a transcript scannable - six `read_file` rows all saying "read_file" tell the
 * reader nothing.
 */
export function toolSummary(name, args) {
  const a = args ?? {};
  const str = (v) => (typeof v === "string" ? v : "");
  switch (name) {
    case "read_file":
      return [str(a.path), a.from || a.to ? t("lines {from}-{to}", { from: a.from ?? 1, to: a.to ?? t("end") }) : ""].filter(Boolean).join(" · ");
    case "write_file":
      return [str(a.path), typeof a.content === "string" ? humanBytes(a.content.length) : ""].filter(Boolean).join(" · ");
    case "list_dir":
      return str(a.path) || ".";
    case "search": {
      const pattern = str(a.pattern) ? `"${clip(a.pattern, 60)}"` : "";
      const path = str(a.path);
      return pattern && path ? t("{pattern} in {path}", { pattern, path }) : pattern || path;
    }
    case "run_command":
      return clip(a.command, 90);
    case "delegate":
      return clip(a.task, 90);
    case "todo_write":
      return Array.isArray(a.todos) ? t("{n} items", { n: a.todos.length }) : "";
    case "todo_read":
      return "";
    default: {
      const first = Object.entries(a).find(([, v]) => typeof v === "string");
      if (first) return clip(`${first[0]}: ${first[1]}`, 90);
      const keys = Object.keys(a);
      return keys.length ? clip(keys.join(", "), 90) : "";
    }
  }
}

const STATUS_TONES = {
  ok: { label: t("done"), tone: "ok" },
  running: { label: t("running"), tone: "live" },
  failed: { label: t("failed"), tone: "bad" },
  stopped: { label: t("stopped"), tone: "warn" },
  stale: { label: t("stale"), tone: "warn" },
  cancelled: { label: t("cancelled"), tone: "warn" },
};

export function statusChip(status) {
  return STATUS_TONES[status] ?? { label: String(status ?? "unknown"), tone: "muted" };
}

/**
 * The heading a model row belongs under in the picker.
 *
 * The provider-qualified id is how the router addresses a model, not how a person thinks
 * about it. `opencode-free` is the free cloud window and `rosalena` is the assistant built
 * on top of it, so they are one product surface and get one heading; the model rows inside
 * keep saying which of them is which. `local` is the other distinction that matters when
 * choosing, and it is named as one. A provider this file does not know keeps its own name,
 * capitalised, so a new one is legible without an edit here.
 */
const CLOUD_MODEL_PROVIDERS = new Set(["opencode-free", "rosalena"]);
// Every heading also says what a pick spends, because that is the question a person has
// when the same model family sits under two headings: free, this PC, the person's own API
// key (billed to their account, which is where Max/Ultra/Team plans' monthly API credits
// go), or their Claude plan (Claude Code runs on the plan's usage, never on API credits).
const PROVIDER_NAMES = {
  omniroute: t("OmniRoute · free, this PC"),
  "claude-code": t("Claude Code · your Claude plan"),
  codex: t("Codex · your ChatGPT plan"),
  anthropic: t("{name} · your API key", { name: "Anthropic" }),
  openai: t("{name} · your API key", { name: "OpenAI" }),
  google: t("{name} · your API key", { name: "Google Gemini" }),
  openrouter: t("{name} · your API key", { name: "OpenRouter" }),
  deepseek: t("{name} · your API key", { name: "DeepSeek" }),
  zai: t("{name} · your API key", { name: "Z.AI (GLM)" }),
  kimi: t("{name} · your API key", { name: "Kimi (Moonshot)" }),
};

/** The providers whose models run on a key the person saved (Settings > API keys). */
export const API_KEY_PROVIDERS = Object.freeze(["anthropic", "openai", "google", "openrouter", "deepseek", "zai", "kimi"]);

export function modelGroupLabel(provider) {
  const key = String(provider ?? "").trim();
  if (CLOUD_MODEL_PROVIDERS.has(key)) return t("Rosalena Cloud Models · free");
  if (key === "local") return t("Local models · this PC, free");
  if (PROVIDER_NAMES[key]) return PROVIDER_NAMES[key];
  if (!key) return "Router";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * The line under an API-key heading: whether a key is saved. `saved` is true, false, or
 * null when the router did not say (then nothing is claimed either way).
 */
export function keyStatusNote(provider, saved) {
  if (provider === "claude-code") return t("Runs your own Claude Code on your Claude plan's usage limits, not on API credits.");
  if (provider === "codex") return t("Runs your own Codex CLI on your ChatGPT plan's Codex usage limits (or the API key Codex is signed in with).");
  if (!API_KEY_PROVIDERS.includes(String(provider ?? ""))) return "";
  if (saved === true) return t("Key saved. Uses are billed to your account (API credits first).");
  if (saved === false) return t("No key yet: add one in Settings > API keys to use these.");
  return "";
}
