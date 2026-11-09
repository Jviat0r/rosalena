# Plugin libraries

Libraries a UI plugin may load, served at `/plugin-lib/<name>/<file>`. A plugin page has no
network (its CSP allows only its own folder, these libraries and the SDK), so anything it
needs from outside has to be here, pinned and vendored, rather than fetched from a CDN.

A plugin declares what it uses in `plugin.json` (`"ui": { "libs": ["three"] }`); the verifier
refuses a library that is not listed here, and the server refuses a file that is not named in
the library's `lib.json`.

| Library | Version | Files | Source |
|---|---|---|---|
| `three` | 0.187.0 | `three.module.js`, `three.core.js`, `OrbitControls.js` | npm `three@0.187.0` (`build/`, `examples/jsm/controls/OrbitControls.js` with its `'three'` import pointed at `./three.module.js`) |
| `pdfjs` | 4.10.38 | `pdf.min.mjs`, `pdf.worker.min.mjs` | npm `pdfjs-dist@4.10.38` (`build/`) |

pdf.js runs its worker on the page's own thread inside a plugin: a sandboxed frame has an
opaque origin, so it cannot start a Worker from this server. Import `pdf.worker.min.mjs` and
set `globalThis.pdfjsWorker` to it before calling `getDocument` (the paper reader does this).

Each folder keeps the library's own LICENSE file.
