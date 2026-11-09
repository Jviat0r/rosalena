---
name: aeo-ready
description: Make a website readable and citable by AI answer engines and agents (AEO/GEO): ChatGPT, Claude, Perplexity, Meta AI/Muse, Google AI Overviews. Use when building, launching or redeploying a site, or when the user says AEO, GEO, AI search, "get agents to recommend my site", llms.txt, AI crawlers or robots.txt for AI. Runs a read-only audit of what crawlers see without JavaScript and what agents see in the accessibility tree, then fixes the FAILs.
---

# AEO-ready: get AI crawlers and agents to read the site

AI answer engines can only recommend what they can read. Most AI crawlers (GPTBot, ClaudeBot,
Meta-WebIndexer) fetch raw HTML and **do not run JavaScript**: a React/Vite single-page app looks
like an empty `<div id="root">` to them. Browsing agents (Meta Muse's shopping agent, ChatGPT
agent, Claude in Chrome) read the rendered page through its accessibility tree. This skill covers
both views.

No checklist guarantees a recommendation. Engines also weigh third-party mentions (directories,
reviews, press, other sites linking to you), so the site work is necessary but not enough.

## 1. Audit first (read-only)

The scripts are in this skill's `scripts` folder (the `skill` tool prints its path). They need
Playwright once: `npm install` in that folder, then `npx playwright install chromium`.

```
node <skill folder>/scripts/aeo-audit.mjs https://<site> / /work /contact /<other key pages>
```

In Git Bash, prefix it with `MSYS_NO_PATHCONV=1` so `/work` is not rewritten into a Windows path.
The audit exits 1 if anything FAILs. It checks:
- robots.txt: AI and search bots allowed, Sitemap line on this domain
- sitemap: URLs on this domain, how fresh the newest `lastmod` is
- raw HTML (no JS): title, meta description, canonical/og:url/JSON-LD on the right domain, and
  how many words exist before JavaScript (the % crawlers see vs people)
- rendered page: images without alt, links/buttons with no accessible name, unlabeled form
  fields, clickable divs, h1 count, first h2, header/nav/main/footer landmarks
- broken internal links

Then check by hand what a script can't judge (section 3).

## 2. Fix, in priority order

1. **Words must exist in the raw HTML.** For a Vite/React SPA, pre-render at build time:
   `"build": "tsc -b && vite build && node <path>/prerender.mjs dist"`
   (`scripts/prerender.mjs` serves `dist`, opens every route from `dist/sitemap.xml` or
   `--routes`, writes the rendered HTML to `dist/<route>/index.html`, and fails loudly if a
   route errors or renders under 30 words). `/admin` is always skipped; add `--skip` for anything
   behind a login or per-visitor. Each route needs its own `document.title` and meta
   description set by the app, or every page ships the same title. For Astro or plain HTML
   sites this is already true; check with the audit.
   Then re-run the audit and confirm the "crawlers see X%" line is ~100%.
2. **One real domain everywhere.** canonical, og:url, JSON-LD `url`, sitemap `<loc>`, robots
   `Sitemap:` all on the domain the site is actually served from. A canonical pointing at an
   unregistered domain tells crawlers the real page is somewhere that doesn't exist.
3. **robots.txt.** `User-agent: *` / `Allow: /` already allows every bot. Add named groups only
   if something is blocked or to be explicit:
   ```
   User-agent: meta-webindexer
   Allow: /
   User-agent: OAI-SearchBot
   Allow: /
   User-agent: Claude-SearchBot
   Allow: /
   User-agent: PerplexityBot
   Allow: /
   ```
   Blocking training bots (GPTBot, ClaudeBot, Meta-ExternalAgent, Google-Extended) is a
   separate choice from search bots. Ask the user; don't decide for them. Keep `Disallow: /admin`.
4. **Accessibility tree.** Every icon button has `aria-label` ("Open menu"); every form field
   has a `<label>`; every meaningful image has descriptive alt text; decorative images use
   `alt=""`; real `<button>`/`<a>`/`<nav>`/`<header>`/`<main>`/`<footer>`, not clickable divs.
5. **Structured data** in the raw HTML (JSON-LD): Organization/ProfessionalService (name, url,
   areaServed, contact), Service or Product with real prices, FAQPage only for questions that
   are actually on the page. Every value must be true.
6. **Fix broken links** the audit lists (update, redirect or remove).

## 3. Content rules (check by hand)

- **Definition, not slogan,** near the top and in the meta description: what it is, who it's for,
  what it does. "Acme builds custom websites for dental practices in Ohio" beats
  "Websites that feel like the enterprise you are."
- **Answer the reader's question early.** On pages that answer a question (pricing, "X vs Y",
  "how much does a website cost"), put that question as the first h2 in plain words, then a
  short honest "it depends" answer that says who each option is best for.
- **Key facts as text, with dates:** prices, plans, counts written in HTML with "as of <month
  year>". Never only inside an image, a canvas, or text that JavaScript fills in later.
- **Testimonials as selectable text,** only real ones from real clients who gave permission
  (FTC rule on fake reviews). Never invent proof to look better to an AI.
- **Freshness:** "Published" and "Updated" dates on articles and key pages, and update
  `lastmod` in the sitemap only when the page really changed. Faking dates is the same as
  faking facts.
- **Comparison pages must be fair.** Name where a competitor is the better fit. "Trash-talking"
  a competitor with claims you can't back up is a legal risk, not a strategy.

## What's hype in the viral checklists

- "This is literally how Muse reads your site": Meta hasn't published how Muse ranks sites.
  The accessibility-tree advice is still right because browsing agents and screen readers use it.
- "Broken links lower your trust score": no published AI "trust score". Fix them anyway (crawl
  waste, bad experience).
- `llms.txt`: optional; no major engine has said it uses it. Fine to add, not a priority.
- Agencies selling "rank in Muse" demos: no one can guarantee placement.

## Facts behind this (checked 2026-10-19)

- Meta-WebIndexer is Meta's crawler for Meta AI search; Meta says allowing it "helps us cite and
  link to your content". Token `meta-webindexer`.
  https://developers.facebook.com/documentation/sharing/webmasters/web-crawlers
- Vercel + MERJ measured GPTBot and ClaudeBot fetching JavaScript files but not executing them;
  Googlebot renders. https://vercel.com/blog/the-rise-of-the-ai-crawler
- Meta's Muse assistant has a shopping mode that recommends products and can check out
  ("Buy with Muse"). https://www.pcworld.com/article/3243549/metas-muse-ai-assistant-was-born-to-shop.html

## Rules

- Audit is read-only. Fixes follow the project's normal rules: test, build, verify at runtime,
  and **don't deploy until the user says to deploy**.
- Site copy is the user's voice: plain and specific, no invented claims.
- After pre-rendering, open a few routes in a real browser and confirm no page errors and one
  h1 per page (the app replaces the static markup when it boots).
