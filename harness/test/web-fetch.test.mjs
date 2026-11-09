/**
 * web_fetch reads the content, not the page around it (tools-extra.mjs mainContent):
 *
 *   - <main> or the largest <article> when there is one
 *   - otherwise nav, header, footer, aside, forms and cookie/newsletter banners are cut,
 *     nested divs included, before the result is clipped
 *   - it asks for markdown first and passes a site's markdown through untouched
 *   - an app shell with no real content still returns the whole text
 *
 *   node --test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

import { htmlToText, mainContent } from "../src/tools-extra.mjs";
import { createTools } from "../src/tools.mjs";

const ARTICLE = "The actual article text. ".repeat(20);
const PAGE = `<!doctype html><html><head><title>Docs page</title></head><body>
<a class="skip-link" href="#c">Skip</a>
<header><nav><ul><li>Home</li><li>Pricing</li><li>Blog</li></ul></nav></header>
<div class="cookie-banner"><div><p>We use cookies.</p><div><button>Accept all</button></div></div></div>
<div class="layout"><aside class="sidebar">Sidebar links</aside>
<div id="content"><h1>Install</h1><p>${ARTICLE}</p><div class="note"><p>Nested note stays.</p></div></div></div>
<div class="newsletter"><form><input placeholder="email"><button>Subscribe</button></form></div>
<footer>Copyright and twenty links</footer></body></html>`;

test("furniture is cut, nested content stays", () => {
  const text = htmlToText(mainContent(PAGE));
  assert.match(text, /# Install/);
  assert.match(text, /The actual article text/);
  assert.match(text, /Nested note stays/);
  for (const gone of ["We use cookies", "Accept all", "Pricing", "Sidebar links", "Subscribe", "Copyright", "Skip"]) assert.doesNotMatch(text, new RegExp(gone), gone);
});

test("<main> wins when the page has one", () => {
  const html = `<body><div class="promo">Buy now</div><main><p>${ARTICLE}</p><nav>in-page nav</nav></main><footer>f</footer></body>`;
  const text = htmlToText(mainContent(html));
  assert.match(text, /actual article text/);
  assert.doesNotMatch(text, /Buy now|in-page nav/);
});

test("through the tool: markdown first, main content otherwise, and an app shell is read whole", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.accept);
    if (req.url === "/md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end("# Already markdown\n\n<nav>kept as written</nav>");
      return;
    }
    if (req.url === "/shell") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><header>App</header><div id=root>Loading…</div><footer>(c)</footer></body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tools = createTools({ root: tmpdir() });
    const page = await tools.byName.web_fetch.run({ url: `${base}/page` });
    assert.match(page, /# Docs page/);
    assert.match(page, /The actual article text/);
    assert.doesNotMatch(page, /We use cookies|Copyright/);
    const whole = await tools.byName.web_fetch.run({ url: `${base}/page`, whole: true });
    assert.match(whole, /We use cookies/);
    const md = await tools.byName.web_fetch.run({ url: `${base}/md` });
    assert.match(md, /markdown from the site/);
    assert.match(md, /<nav>kept as written<\/nav>/);
    const shell = await tools.byName.web_fetch.run({ url: `${base}/shell` });
    assert.match(shell, /Loading…/);
    assert.match(seen[0], /^text\/markdown/);
  } finally {
    server.close();
  }
});
