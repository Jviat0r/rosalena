/**
 * The window's own saved look, kept by the server so it survives a relaunch.
 *
 * The page keeps its look in localStorage: the UI style, the theme button, the panel
 * layout and widths, the tab order, the theme a plugin like Style Lab applied, and each
 * sidebar plugin's own saved data. The desktop app serves the page on a new port every
 * launch, and a new port is a new origin with an empty localStorage, so all of it was gone
 * on every reopen. This keeps a copy in <home>/ui-state.json:
 *
 *   - the server puts the saved copy into index.html (`injectUiState`), and ui/persist.js
 *     writes it back into localStorage before any of the page's own code reads it
 *   - persist.js sends every later change of a `rosalena-` or `rosalena.` key here
 *
 * Only those keys are kept, values are strings, and the whole file is capped, so a
 * runaway plugin cannot grow it without bound.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const UI_STATE_KEY = /^rosalena[-.][\w.:-]{1,120}$/;
export const UI_STATE_MAX_BYTES = 8 * 1024 * 1024;

export const uiStateFile = (home) => join(home, "ui-state.json");

export function readUiState(home) {
  try {
    const doc = JSON.parse(readFileSync(uiStateFile(home), "utf8"));
    const items = {};
    for (const [key, value] of Object.entries(doc?.items ?? {})) if (UI_STATE_KEY.test(key) && typeof value === "string") items[key] = value;
    return { items, at: doc?.at ?? null };
  } catch {
    return { items: {}, at: null };
  }
}

/**
 * Apply one batch from the page: `set` is { key: string }, `remove` is [key]. Keys outside
 * the app's own prefixes are refused; a batch that would push the file past the cap is
 * refused whole, so what is saved is always a state the page actually had.
 */
export function writeUiState(home, { set = {}, remove = [] } = {}) {
  const now = readUiState(home);
  const items = { ...now.items };
  for (const key of Array.isArray(remove) ? remove : []) if (UI_STATE_KEY.test(String(key))) delete items[key];
  for (const [key, value] of Object.entries(set && typeof set === "object" ? set : {})) {
    if (!UI_STATE_KEY.test(key)) throw new Error(`"${key}" is not a key the window saves`);
    if (typeof value !== "string") throw new Error(`the value for ${key} must be text`);
    items[key] = value;
  }
  const text = JSON.stringify({ v: 1, at: new Date().toISOString(), items });
  if (Buffer.byteLength(text) > UI_STATE_MAX_BYTES) throw new Error(`the saved window state would be over ${UI_STATE_MAX_BYTES / 1024 / 1024} MB`);
  const file = uiStateFile(home);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return { count: Object.keys(items).length };
}

/**
 * The saved state as a JSON block for index.html, placed where the page's
 * `<!--ROSALENA_UI_STATE-->` marker is. `<` is escaped so no value can close the script.
 */
export function injectUiState(html, home) {
  const json = JSON.stringify(readUiState(home)).replace(/</g, "\\u003c");
  return html.replace("<!--ROSALENA_UI_STATE-->", `<script id="rosalena-ui-state" type="application/json">${json}</script>`);
}
