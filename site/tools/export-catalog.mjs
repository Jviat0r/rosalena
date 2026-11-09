/**
 * Regenerate `public/check/catalog.json` from the desktop app's catalog.
 *
 * The site must not invent model sizes: `harness/data/model-catalog.json` is the
 * one source of truth, and the desktop app's own fit arithmetic reads it. This
 * script copies the fields the page needs and nothing else, so the page cannot
 * show a number the app does not have.
 *
 *   cd 'D:\AppDev\Rosalena Harness\site'
 *   node tools/export-catalog.mjs
 *
 * `site/test/fit.test.mjs` re-runs the projection and compares it with the file,
 * so a catalog edit that is not followed by this command fails the test.
 *
 * The output carries no timestamp on purpose: a generated-at field would make
 * every run differ and turn the drift check into noise.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = resolve(HERE, "..");
export const APP_REPO_DIR = resolve(SITE_DIR, "..");
export const APP_CATALOG_PATH = resolve(APP_REPO_DIR, "harness", "data", "model-catalog.json");
export const SITE_CATALOG_PATH = resolve(SITE_DIR, "public", "check", "catalog.json");

/** Fields of a model the page actually renders or needs to compute a fit. */
export const MODEL_FIELDS = Object.freeze([
  "id",
  "name",
  "params",
  "context",
  "serveContext",
  "layers",
  "kvDim",
  "license",
  "use",
  "notes",
  "url",
]);

/**
 * The catalog as the page should see it.
 *
 * `extraGb` is kept when the app has it: it is a vision model's projector, which
 * has to be resident next to the weights, and dropping it would make the page's
 * answer for that model smaller than the app's. It is the only field outside the
 * list above, and only one entry in the app's catalog uses it.
 */
export function projectCatalog(doc) {
  const models = doc?.models;
  if (!Array.isArray(models) || models.length === 0) throw new Error(`${APP_CATALOG_PATH}: no "models" array`);

  return {
    $about:
      "Generated from harness/data/model-catalog.json by site/tools/export-catalog.mjs. Do not edit: change the app's catalog and run the exporter.",
    $source: relative(SITE_DIR, APP_CATALOG_PATH).replace(/\\/g, "/"),
    $units:
      "`file` is the GGUF download size for that quant in decimal gigabytes (1e9 bytes); `params` is billions of parameters; `context` and `serveContext` are tokens.",
    $fit:
      "`serveContext` is the context the KV-cache arithmetic uses; `context` is what the model was trained for. `layers` and `kvDim` turn a context length into KV bytes.",
    catalogVersion: doc.version ?? null,
    catalogUpdated: doc.updated ?? null,
    models: models.map((entry) => {
      if (!entry?.id) throw new Error(`${APP_CATALOG_PATH}: an entry has no id`);
      if (!(Number(entry.params) > 0)) throw new Error(`${APP_CATALOG_PATH}: ${entry.id} has no params`);
      if (!Array.isArray(entry.quants) || entry.quants.length === 0) throw new Error(`${APP_CATALOG_PATH}: ${entry.id} has no quants`);

      const model = {};
      for (const field of MODEL_FIELDS) model[field] = entry[field] ?? null;
      if (entry.extraGb !== undefined) model.extraGb = entry.extraGb;
      model.quants = entry.quants.map((quant) => {
        if (!quant?.quant) throw new Error(`${APP_CATALOG_PATH}: ${entry.id} has a quant with no label`);
        if (!(Number(quant.file) > 0)) throw new Error(`${APP_CATALOG_PATH}: ${entry.id} ${quant.quant} has no file size`);
        return { quant: quant.quant, file: quant.file, url: quant.url ?? null };
      });
      return model;
    }),
  };
}

/** The exact bytes the file should contain. */
export function serializeCatalog(projected) {
  return `${JSON.stringify(projected, null, 2)}\n`;
}

function main() {
  const source = JSON.parse(readFileSync(APP_CATALOG_PATH, "utf8"));
  const projected = projectCatalog(source);
  const text = serializeCatalog(projected);
  writeFileSync(SITE_CATALOG_PATH, text);
  const quants = projected.models.reduce((sum, model) => sum + model.quants.length, 0);
  console.log(
    `wrote ${relative(APP_REPO_DIR, SITE_CATALOG_PATH)}: ${projected.models.length} models, ${quants} quants, ${text.length} bytes`,
  );
}

// Only write when run directly: the test imports `projectCatalog` from here and
// must not touch the file it is checking.
const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(`export-catalog: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
