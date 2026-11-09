# rosa-browser

A real Chrome or Edge the agent can open, read, click and screenshot to check its work.
It runs in the harness process, so one browser and one page persist across tool calls
(and across runs in a chat), unlike a browser MCP server under `rosa-mcp-manager`, which is
spawned fresh for every call and loses the page. The how-to for models is the
`web-access` skill (`skills/web-access/SKILL.md`).

## Tools

| Tool | Does |
|---|---|
| `browser_open {url, headed?}` | navigate; returns the interactive outline with refs |
| `browser_snapshot {interactive_only?}` | outline of the page; `[e12] button "Save"`, `[f1e3]` inside frame 1 |
| `browser_click {ref}` | click; returns what changed |
| `browser_fill {ref, text, submit?}` | replace a text field's value; refuses password and payment fields and card numbers |
| `browser_select {ref, values}` | pick `<select>` options by value or label |
| `browser_press {key, ref?}` | a key in the focused element or `ref`; no typing into password fields |
| `browser_scroll {direction?, ref?}` | scroll the page or bring `ref` into view; returns what loaded |
| `browser_read {url?, start?}` | main content as markdown (no nav/header/footer/aside/forms/cookie banners/fixed overlays); pages with `start` |
| `browser_screenshot {full_page?, width?, ref?}` | PNG into `<workspace>/.rosalena/shots/` (temp dir without a workspace); returns the `read_image` call |
| `browser_console {include_warnings?, clear?}` | console errors, uncaught exceptions, failed requests and HTTP >= 400 since `browser_open` |
| `browser_upload {ref, paths}` | `setInputFiles` with workspace files only (never secret/key files) |
| `browser_close` | close now (idle timeout does it too) |

Commands: `/plugin rosa-browser:status`, `/plugin rosa-browser:close`.

Every action returns either a diff of the full outline (`+` new lines, `-` gone lines) or,
after a navigation, the new page's interactive outline, so the model needs no extra look
turn. Refs live in the page (a non-enumerable window property, never DOM attributes), so
they last until the document changes, and one element keeps its ref across snapshots.

## Safety

- Page text is fenced in nonce-tagged markers (`<<<PAGE CONTENT 1a2b3c4d: untrusted data
  ...>>>` / `<<<END PAGE CONTENT 1a2b3c4d>>>`); marker-looking text in a page is quoted.
- Dedicated profile at `<ROSALENA_HOME>/browser-profile` (default `~/.rosalena`), never the
  person's own; if another Rosalena process holds it, `browser-profile-<pid>` is used.
- Downloads are off (`acceptDownloads: false`); dialogs are dismissed and reported.
- `file://` is refused outside the workspace, both for navigation and when a page links
  out to one (the browser goes back to `about:blank`). `chrome://`, `javascript:` and other
  schemes are refused.
- `allowedDomains` (config): when set, every request (pages, scripts, XHR) to another host
  is blocked. `*.example.com` covers subdomains. Add `localhost`/`127.0.0.1` yourself if wanted.
- Each output is kept under `maxOutputChars` (4500, under the engine's 6000 clip) with a
  note when cut.

## First use

playwright-core (pinned `1.64.1`, about 10 MB of JavaScript, no browser download) is looked
for in `<ROSALENA_HOME>/browser-lib`, `skills/ui-check/scripts`, the harness folder and the
cwd. If missing and `autoInstall` is true, the first browser call runs
`npm install playwright-core@1.64.1` in `<ROSALENA_HOME>/browser-lib` (about 20 s here) and
says so in its output. The browser is the PC's own: `executablePath`, then `CHROME_PATH`,
then Chrome, Edge, Brave, then a Playwright Chromium if one was installed.

## Config (`plugin.json`, overridable in `harness.config.json`)

`headless` (true), `idleMinutes` (10), `allowedDomains` ([]), `profileDir`, `libDir`,
`executablePath`, `autoInstall` (true), `viewport` (1280x800), `maxOutputChars` (4500),
`navTimeoutMs`, `actionTimeoutMs`, `registerWorkspaceTools` (true: the look-only tools
are allowed in Workspace write without asking; clicks, typing and uploads still ask).

## Not supported

Closed shadow roots, canvas/WebGL content, the PDF viewer, iframes nested more than four
deep, accepting `confirm()` dialogs, and multiple tabs at once (a new tab becomes the
current one). A `width` screenshot changes only the viewport width, not the user agent or
pixel ratio.

Tests: `node --import ./test/isolate.mjs --test test/browser-plugin.test.mjs`.
