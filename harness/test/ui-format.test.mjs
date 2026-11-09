// The renderer is the part of the UI that can fail silently in a way nobody notices:
// a model emits one stray fence and the rest of the answer becomes a code block. These
// tests import the exact file the browser loads, so a regression here is a regression
// on the page.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ago,
  clip,
  escapeHtml,
  formatArgs,
  humanBytes,
  humanMs,
  humanTokens,
  inlineHtml,
  keyStatusNote,
  modelGroupLabel,
  renderMarkdown,
  safeHref,
  statusChip,
  toolSummary,
} from "../ui/format.mjs";

test("escaping is the gate: no raw angle bracket survives", () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  const html = renderMarkdown("A <script>alert(1)</script> and <b>bold</b>.");
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;script&gt;/);
});

test("only http, mailto and same-origin links become anchors", () => {
  assert.equal(safeHref("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHref("mailto:me@example.com"), "mailto:me@example.com");
  assert.equal(safeHref("/runs"), "/runs");
  assert.equal(safeHref("javascript:alert(1)"), null);
  assert.equal(safeHref("data:text/html,<script>"), null);
  const html = renderMarkdown("[x](javascript:alert(1))");
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /\[x\]\(javascript:alert\(1\)\)/);
});

test("bold, italic and inline code render, and code wins over emphasis", () => {
  assert.equal(inlineHtml("**loud**"), "<strong>loud</strong>");
  assert.equal(inlineHtml("*soft*"), "<em>soft</em>");
  assert.equal(inlineHtml("run `npm test` now"), "run <code>npm test</code> now");
  assert.equal(inlineHtml("`**not bold**`"), "<code>**not bold**</code>");
  // Underscores stay literal: file names and ids are the common case here.
  assert.equal(inlineHtml("ui_format_mjs"), "ui_format_mjs");
});

test("a fenced block becomes copyable code with its language", () => {
  const html = renderMarkdown("Here:\n```js\nconst a = 1 < 2;\n```\ndone");
  assert.match(html, /<span class="code-lang">js<\/span>/);
  assert.match(html, /<button class="code-copy"/);
  assert.match(html, /const a = 1 &lt; 2;/);
  assert.match(html, /<p>Here:<\/p>/);
  assert.match(html, /<p>done<\/p>/);
  assert.equal((html.match(/<pre class="code">/g) ?? []).length, 1);
});

test("an unterminated fence renders the rest as code instead of swallowing the page", () => {
  const html = renderMarkdown("Answer:\n```\nline one\nline two");
  assert.match(html, /<pre class="code"><code>line one\nline two<\/code><\/pre>/);
  assert.equal((html.match(/<div class="code-wrap">/g) ?? []).length, 1);
});

test("four-backtick fences survive code that itself contains three", () => {
  const html = renderMarkdown("````md\n```js\nx\n```\n````");
  assert.equal((html.match(/<div class="code-wrap">/g) ?? []).length, 1);
  assert.match(html, /&lt;\!--|```js/);
});

test("headings, lists, quotes and rules keep their structure", () => {
  const html = renderMarkdown("## Plan\n- one\n- two\n\n1. first\n2. second\n\n> noted\n\n---");
  assert.match(html, /<h4>Plan<\/h4>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote>noted<\/blockquote>/);
  assert.match(html, /<hr>/);
});

test("line breaks inside a paragraph survive", () => {
  assert.match(renderMarkdown("one\ntwo"), /<p>one<br>two<\/p>/);
});

test("plain text with no markdown is one paragraph", () => {
  assert.equal(renderMarkdown("just a sentence"), "<p>just a sentence</p>");
  assert.equal(renderMarkdown(""), "");
});

test("tool summaries name the target, not just the tool", () => {
  assert.equal(toolSummary("read_file", { path: "src/ui/app.js" }), "src/ui/app.js");
  assert.equal(toolSummary("read_file", { path: "a.txt", from: 10, to: 20 }), "a.txt · lines 10-20");
  assert.equal(toolSummary("write_file", { path: "a.txt", content: "12345" }), "a.txt · 5 B");
  assert.equal(toolSummary("run_command", { command: "node --test" }), "node --test");
  assert.equal(toolSummary("todo_write", { todos: [1, 2, 3] }), "3 items");
  assert.equal(toolSummary("mystery", { alpha: "x" }), "alpha: x");
  assert.equal(toolSummary("mystery", {}), "");
  assert.equal(toolSummary("search", { pattern: "token", path: "harness" }), '"token" in harness');
});

test("args are pretty JSON, clipped when a single argument is huge", () => {
  assert.equal(formatArgs(undefined), "");
  assert.equal(formatArgs({}), "");
  assert.equal(formatArgs({ path: "a" }), '{\n  "path": "a"\n}');
  const big = formatArgs({ content: "x".repeat(5000) }, 100);
  assert.match(big, /more characters\)$/);
  assert.ok(big.length < 200);
});

test("durations read like a person wrote them", () => {
  assert.equal(humanMs(240), "240ms");
  assert.equal(humanMs(1500), "1.5s");
  assert.equal(humanMs(45_000), "45s");
  assert.equal(humanMs(125_000), "2m 5s");
  assert.equal(humanMs(null), "");
  assert.equal(humanTokens(900), "900 tok");
  assert.equal(humanTokens(12_400), "12k tok");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(64 * 1024), "64 KB");
  assert.equal(humanBytes(0), "0 B");
});

test("relative times and clipping stay honest at the edges", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(ago("2026-10-20T11:59:30Z", now), "30s ago");
  assert.equal(ago("2026-10-20T11:30:00Z", now), "30m ago");
  assert.equal(ago("2026-10-20T08:00:00Z", now), "4h ago");
  assert.equal(ago("2026-10-19T12:00:00Z", now), "yesterday");
  assert.equal(ago(null, now), "");
  assert.equal(clip("abc", 2), "a…");
  assert.equal(clip("a\n b", 10), "a b");
  assert.deepEqual(statusChip("ok"), { label: "done", tone: "ok" });
  assert.deepEqual(statusChip("running"), { label: "running", tone: "live" });
  assert.deepEqual(statusChip("weird"), { label: "weird", tone: "muted" });
});

test("the free cloud window and the assistant share one menu heading", () => {
  // The provider id is a wire detail. A person choosing a model sees the product surface:
  // opencode-free is the free cloud window, rosalena is the assistant built on it.
  assert.equal(modelGroupLabel("opencode-free"), "Rosalena Cloud Models · free");
  assert.equal(modelGroupLabel("rosalena"), "Rosalena Cloud Models · free");
  assert.equal(modelGroupLabel("local"), "Local models · this PC, free");
  assert.equal(modelGroupLabel("omniroute"), "OmniRoute · free, this PC");
  // A provider nobody taught this file about is still legible, not lower case.
  assert.equal(modelGroupLabel("someprovider"), "Someprovider");
  assert.equal(modelGroupLabel(""), "Router");
  assert.equal(modelGroupLabel(undefined), "Router");
});

test("every heading says what a pick spends: free, an API key, or the Claude plan", () => {
  assert.equal(modelGroupLabel("anthropic"), "Anthropic · your API key");
  assert.equal(modelGroupLabel("openrouter"), "OpenRouter · your API key");
  assert.equal(modelGroupLabel("claude-code"), "Claude Code · your Claude plan");
  assert.match(keyStatusNote("anthropic", true), /^Key saved/);
  assert.match(keyStatusNote("anthropic", false), /Settings > API keys/);
  assert.equal(keyStatusNote("anthropic", null), "", "nothing is claimed when the router did not say");
  assert.match(keyStatusNote("claude-code", null), /not on API credits/);
  assert.equal(modelGroupLabel("codex"), "Codex · your ChatGPT plan");
  assert.match(keyStatusNote("codex", null), /ChatGPT plan/);
  assert.equal(keyStatusNote("local", true), "");
});
