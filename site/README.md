# Rosalena site

The public page for Rosalena Harness: https://rosalena.pages.dev (Cloudflare Pages project `rosalena`, direct
upload, no Git). Plain HTML and CSS in `public/`, no build step. Words are in the raw HTML so AI crawlers can
read them without running JavaScript.

- `/` landing: what it is, the in-browser demo, the free models the router lists, what it does.
- `/download/` early preview status. The desktop app isn't packaged for other people yet (no installer, not
  code-signed, needs Node), so the button is disabled. When there's a real build, link it here. Pages files max
  out at 25 MiB, so the installer itself belongs in GitHub Releases or R2, not in `public/`.
- `try.js` the demo: WebLLM 0.2.85 from jsDelivr runs a small open model on the visitor's own GPU through
  WebGPU. Weights come from Hugging Face; nothing the visitor types is sent anywhere. `_headers` CSP allows
  exactly those hosts. Model ids must exist in that WebLLM version's prebuilt list.

Colours (`styles.css` `:root`): cyan / turquoise primary, platinum blonde, powder-blue frills, silver.

Deploy (only when Jayden says so):

```
npx wrangler pages deploy public --project-name rosalena --branch main --commit-dirty=true
```

Every fact on the page has to stay true: free models come from `router/router.config.json` `models`, the
status list from the root `README.md`. When the harness changes, update both pages and the sitemap `lastmod`.

## Spanish (`/es/`)

English is the source. The Spanish pages under `public/es/` and `public/sitemap.xml` are generated, so never
edit them by hand: run `node tools/build-i18n.mjs` (from `site/`) after any change to an English page, to
`i18n/es.json`, or to a sitemap `lastmod`, and commit what it writes. There is no build step at deploy time.

- Words in the HTML: `i18n/es.json` maps the English text of each paragraph, list item, cell, button or
  attribute (inline tags kept, whitespace collapsed) to its Spanish. `node tools/build-i18n.mjs --missing`
  prints every English string with no entry, ready to paste in and translate. Version numbers are written
  `{v1}`, `{v2}`, so a release bump needs a rebuild, not a translation. A value equal to its key means
  "the same in Spanish".
- Words that JavaScript writes: each script's own table (`TEXT` in `download/download.js`, `try/app.js`,
  `try.js`, `preview/preview.js`; `STRINGS_ES` and `SAY_ES` in `harness/harness.js`; `check/i18n.js` for
  `/check/`, including the catalog notes; the labels in `theme.js`). They pick the language from `<html lang>`.
- `test/i18n.test.mjs` fails when the committed Spanish is stale, a string is untranslated, an entry is
  unused, or a script's Spanish table drifts from its English one.
- The EN/ES switch is a plain link; `lang.js` only remembers the choice (`rosalena-lang`) and offers a
  dismissible "Ver esta página en español" note. It never redirects.
