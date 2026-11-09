# `/check/`: can this computer run it?

A public page that reads whatever hardware the browser will expose, then sorts the app's model catalog into
what runs comfortably, what runs with CPU offload, and what does not fit.

- `index.html`, `check.css`, `check.js` the page. One centred column, dark by default with a light theme on
  `[data-theme="light"]`, no build step, no framework.
- `fit.js` the fit arithmetic, ported byte for byte from the desktop app (`harness/src/hardware.mjs` and the
  quant choice in `harness/src/catalog.mjs`). Browser-safe and Node-safe: the page imports it and
  `site/test/fit.test.mjs` imports the same file, so the site and the app cannot disagree about "fits".
- `detect.js` what the browser will say: the WebGPU adapter, `deviceMemory`, cores, storage quota, UA hints.
  It reads the adapter and releases it, and never creates a device or a canvas context.
- `gpus.js` a table of common cards with the VRAM their vendor publishes, the ANGLE string parser that turns
  `ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Direct3D11 ...)` into a card name, and the tier-2 guess.
- `catalog.json` **generated**. Do not edit it.

## The three VRAM tiers

A browser cannot read VRAM, so every result says where its figure came from:

| Chip | Meaning |
| --- | --- |
| `detected` | the browser named a card in the table; the figure is the vendor's published VRAM, a lookup not a measurement |
| `inferred` | the card was not recognised; the figure is guessed from the adapter's buffer limit, which is a floor |
| `manual` | the visitor picked the card or typed the number; nothing measured it |

No WebGPU (Safari, Firefox, a blocked GPU) or no answer within 3 s falls back to the picker, and a result built
on a pick is labelled `manual`, never `detected`.

## Regenerate the catalog

`catalog.json` is a projection of the desktop app's catalog. When the app's catalog changes, run:

```
cd 'D:\AppDev\Rosalena Harness\site'
node tools/export-catalog.mjs
```

`site/test/fit.test.mjs` re-runs the same projection and fails if the two files differ, so a forgotten export is
a test failure rather than a stale page.

## Tests

```
cd 'D:\AppDev\Rosalena Harness\site'
node --test test\fit.test.mjs
```

The golden byte values in that test were produced by the app's own code. If the formula changes in the app, the
test fails until the port and the goldens are updated together.

## What this page deliberately does not do

No tokens per second, no FPS, no "runs 2× faster". The page has not loaded the model, so it cannot measure
speed, and a fabricated number would be worse than none.

The page also loads no web fonts and makes no third-party request, because it tells the visitor that nothing
about their machine is sent anywhere. It uses the system UI font stack instead.
