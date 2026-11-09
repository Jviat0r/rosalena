---
name: plugin-builder
description: Build a Rosalena UI plugin (a page in the app's sidebar - a tool, a game, a viewer, a theme) that passes verification. Load this first in Creator mode, or whenever someone asks to make, fix or extend a Rosalena plugin.
---

# Building a Rosalena plugin

A UI plugin is a small web app that lives in Rosalena's sidebar. It runs in a sandboxed
frame with **no network** and talks to the app only through the SDK. Nothing is installed
until it passes verification, and every install can be rolled back. Build it so it passes
the first time: read this whole file before writing anything.

## The workflow (Creator mode)

1. `creator_new` with an `id` (a-z, 0-9, `-`), a `title`, a one-line `description`, and the
   `permissions` and `libs` it needs. This makes a draft from the template.
2. `creator_write` each file (`app/index.html`, `app/app.js`, `app/style.css`, `icon.svg`,
   ...). Write whole files. Keep the plan small: one page, one script, one stylesheet is
   usually right.
3. `creator_verify`. Read every FAIL line, fix the cause, verify again. Do not stop at a
   failing report and do not weaken a test to make it pass.
4. `creator_publish` once the report says PASS. It refuses files that changed since the
   last passing verify, so verify again after any edit.
5. Tell the person it is in the sidebar, what it does, and that `creator_rollback` (or the
   Versions menu on the plugin's page) puts the previous version back.

Outside Creator mode (building a plugin that ships with the app), the same rules apply:
put the folder in `harness/plugins/<id>/` with `"bundled": true` and run
`node src/plugin-verify.mjs plugins/<id>` from `harness/` until it prints PASS.

## Folder layout

```
<id>/
  plugin.json        the manifest (below)
  icon.svg           24x24 viewBox, single colour via currentColor, no text
  app/index.html     the page
  app/app.js         its script (an ES module is fine: <script type="module" src="app.js">)
  app/style.css      its styles
```

Allowed file types: html, js, mjs, css, json, svg, png, jpg, webp, gif, woff2/woff/ttf,
mp3/wav/ogg, mp4/webm, txt, md, glb/gltf/bin, wasm, pdf. At most 15 MB a file, 40 MB and
300 files in all.

## plugin.json

```json
{
  "id": "rosa-poster-studio",
  "version": "1.0.0",
  "description": "Design posters with live backgrounds and export them as PNG.",
  "ui": {
    "title": "Poster Studio",
    "icon": "icon.svg",
    "page": "app/index.html",
    "permissions": ["storage", "files.save"],
    "libs": []
  }
}
```

Ask only for what the code uses; the verifier fails a permission the code uses but did not
declare, and warns about one it declared but never uses.

| Permission | What it allows |
|---|---|
| `storage` | `Rosalena.storage.*`: this plugin's own saved data, 2 MB, JSON values |
| `files.save` | `Rosalena.files.save(name, data, type)`: hands the person a file to save |
| `chat.compose` | `Rosalena.chat.compose(text)`: puts text in the chat box (never sends it) |
| `theme` | `Rosalena.theme.set/reset/get`: repaints the app from a fixed list of tokens |

## The page

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main id="app"></main>
  <script src="/plugin-sdk.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

`<script src="/plugin-sdk.js">` must come before your own scripts. Relative URLs resolve
inside your folder (`/plugin-app/<id>/app/...`).

## The SDK (`window.Rosalena`)

```js
Rosalena.ready();                         // call once the first screen has drawn
Rosalena.test("name", async () => { ... });  // a self-test the verifier runs
Rosalena.assert(condition, "message");    // throw inside a test

await Rosalena.storage.set("key", value); // JSON-serialisable values
await Rosalena.storage.get("key");        // null when missing
await Rosalena.storage.remove("key");
await Rosalena.storage.keys();

await Rosalena.files.save("poster.png", blob, "image/png");  // Blob, string or ArrayBuffer
await Rosalena.chat.compose("Explain this passage: ...");

await Rosalena.theme.set({ bg: "#101010", panel: "#1a1a1a", text: "#e8e8e8", accent: "#39ff88", radius: "0px", mono: "Consolas, monospace" });
await Rosalena.theme.reset();
await Rosalena.theme.get();               // { mode, colors, sans, mono, pluginTheme }

Rosalena.on("theme", (t) => { /* t.mode is "dark" or "light", t.colors.bg/panel/text/dim/accent/line... */ });
Rosalena.host;                            // { id, permissions, theme, verifying } once connected
await Rosalena.whenConnected;
```

Every SDK call returns a promise and can be refused (a missing permission, a bad value):
`try`/`catch` it and show the person a sentence, never a dead button.

Theme tokens a plugin may set: `bg panel line line-soft text dim accent accent-soft ok warn
bad live btn-ink` (colours: `#hex`, `rgb()`, `hsl()`), `radius radius-sm radius-xs`
(`0px`-`99px`), `sans mono` (font family lists, letters, spaces, quotes, commas).

## What the sandbox means for your code

- **No network.** No CDN, no fonts.googleapis, no fetch to anywhere but your own folder and
  `/plugin-lib/`. The verifier fails any `http(s)://` URL in html/js/css. Bundle what you
  need, draw icons as inline SVG, use system fonts.
- **No `localStorage`, `sessionStorage`, `indexedDB`, cookies.** They throw in a sandboxed
  frame. Use `Rosalena.storage`.
- **No `alert`, `confirm`, `prompt`.** Modals are blocked and return immediately. Draw your
  own dialog.
- **No `eval` or `new Function`**, and no `window.top`, `parent.location` or
  `window.opener`. The verifier fails them.
- **Files in:** an `<input type="file">` and drag-and-drop work normally (read them with
  `File.arrayBuffer()`, `URL.createObjectURL`, `FileReader`).
- **Files out:** `Rosalena.files.save`. A plain `<a download>` also works, but the SDK call
  is the one the person can trust and the verifier can see.
- **Popups and new windows** are blocked. Links to the web do nothing; do not add them.

## Shared libraries (`/plugin-lib/`)

Declare each one in `ui.libs`. Nothing else is available.

**three** (three.js 0.187, with OrbitControls):

```js
import * as THREE from "/plugin-lib/three/three.module.js";
import { OrbitControls } from "/plugin-lib/three/OrbitControls.js";
```

Create the renderer with `{ antialias: true, preserveDrawingBuffer: true }` so screenshots
and exports see the frame. Size it from the container and handle `resize`. Stop the
animation loop on `visibilitychange` when hidden. If `WebGLRenderingContext` is missing or
`renderer` construction throws, draw a readable message instead of throwing.

**pdfjs** (pdf.js 4.10). A sandboxed frame cannot start a Worker from this server, so run
the worker on the page's own thread:

```js
const worker = await import("/plugin-lib/pdfjs/pdf.worker.min.mjs");
globalThis.pdfjsWorker = worker;
const pdfjs = await import("/plugin-lib/pdfjs/pdf.min.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = "/plugin-lib/pdfjs/pdf.worker.min.mjs";
const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
```

## Self-tests: how the verifier knows it works

Register tests with `Rosalena.test` at the top level of your script (before `ready()`), so
they exist when the verifier asks. The verifier loads the page in a hidden Chromium window,
waits for `ready()`, runs every test (10 s each), and fails the plugin when:

- `ready()` never comes (20 s),
- any test throws,
- the page reports anything: an uncaught error, a rejected promise, `console.error`, a
  request the CSP blocked,
- the screenshot is blank,
- a visible button, field or link is covered by something else, or an element marked
  `hidden` is still displayed (the SDK checks this itself, before your tests). Put
  `[hidden] { display: none !important; }` in every stylesheet: a rule like
  `.overlay { display: grid }` beats the `hidden` attribute and leaves an invisible layer
  over the page that swallows every click.

Write tests that prove the feature works, through the same functions the buttons call:

- Poster Studio: set the title text, render, read the canvas pixels to confirm something
  was drawn; export and check the PNG blob's size and dimensions.
- A game: place a block through the game's API, confirm the world count changed; run the
  update loop a few ticks and confirm the state is valid.
- A viewer: load a small built-in sample (generate it in code), confirm it rendered N items.
- Storage: save, reload from storage, confirm the round trip.

In a verify run `Rosalena.host.verifying` is true: storage is in memory, `files.save`
returns `{ verifying: true }` without a download, `chat.compose` does nothing, and
`theme.set` validates without repainting. Your code should not care.

Do not make tests depend on timing luck: await the work, then assert.

## Quality bar

- It looks finished: a real layout, spacing, hover and focus states, empty states that say
  what to do, readable at 900 px and at 1600 px wide.
- It matches the app: read `Rosalena.on("theme")` and use its colours as CSS variables
  (`--bg`, `--panel`, `--text`, `--dim`, `--accent`, `--line`), dark and light.
- It does something real. A form that saves nothing, or a 3D scene with nothing to do, is
  not done.
- It never loses work silently: save to `Rosalena.storage` as the person works (debounced),
  load it back on start.
- Keyboard works for the main actions; buttons have labels or titles.
- `ready()` is called after the first render, not after slow work; show progress for slow
  work instead.

## Rolling back

Every publish keeps the version it replaced. `creator_rollback { id }` restores the
previous one (and keeps the current one, so a rollback can itself be undone);
`creator_rollback { id, to: "<version-stamp>" }` picks one from `creator_list`. The plugin's
page in the app has the same Versions menu, and a plugin that reports errors while someone
is using it shows a banner with a Roll back button.

## Plugins made outside Creator mode

A person can also build a plugin in their own editor and add it on the Plugins page
(`/plugins`, "Add your own"): paste the folder that holds `plugin.json`. A sidebar page goes
through exactly this verifier and is installed only on a pass. A folder with a `plugin.mjs`
is a tool plugin (agent tools, hooks, commands): it is not sandboxed, so the page asks the
person to confirm they trust it before loading it. Every plugin, shipped or added, can be
switched off on that page.
