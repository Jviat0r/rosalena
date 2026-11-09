/**
 * The page: read the hardware, sort the catalog, draw the rows.
 *
 * Three deliberate rules shape this file:
 *
 *   1. The arithmetic is not here. Every verdict comes from `fit.js`, which is the
 *      desktop app's own code, so the page cannot form an opinion the app would
 *      not share.
 *   2. Every screen says where its VRAM figure came from (detected, inferred or
 *      manual). A number with no provenance is the one thing this page must never
 *      show, because a browser cannot measure VRAM.
 *   3. Nothing is hard-coded about which model fits: the summary, the groups and
 *      the "biggest that fits" line are all derived from the catalog and the
 *      reading, so the page stays true when the catalog changes.
 */

import { ADAPTER_TIMEOUT_MS, detectHardware } from "./detect.js";
import { gpuById, manualOptions } from "./gpus.js";
import { GIB, hardwareReading, llamaCommand, recommend } from "./fit.js";
// Every sentence this page writes is in i18n.js, in English and Spanish (<html lang> picks).
import { catalogNotes, catalogUse, rowReason, sitePath, t } from "./i18n.js";

const $ = (id) => document.getElementById(id);

const state = {
  catalog: null,
  detection: null,
  reading: null,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const gib = (bytes) => `${(Number(bytes) / GIB).toFixed(1)} GiB`;
const fileGb = (gb) => `${Number(gb).toFixed(2)} GB`;
const gbOf = (bytes) => Math.round(bytes / GIB);

/** A node builder that never takes HTML, so catalog text cannot become markup. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "style") node.setAttribute("style", value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const VERDICT_WORD = t().verdict;

/** The three groups, in the order a person wants to read them. */
const GROUPS = ["fits", "tight", "tooBig"].map((key) => ({ key, ...t().groups[key] }));

/**
 * Clipboard write with a fallback for browsers that refuse the async API on an
 * insecure origin. Returns whether the text made it, so the button can say so.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the old path: a refused promise is not a reason to fail.
  }
  try {
    const area = el("textarea", { readonly: "", style: "position:fixed;top:-1000px;left:-1000px" });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The hardware panel
// ---------------------------------------------------------------------------

const TONE = t().tone;

function renderHardware() {
  const detection = state.detection;
  const reading = state.reading;
  const chip = $("vram-chip");
  const source = reading?.vramSource ?? null;

  // The GPU and VRAM lines follow the reading in use, which is what the rows are
  // fitted against. The rest of the panel is whatever the browser reported.
  let name = reading?.gpu?.name ?? detection?.adapter?.name ?? detection?.vram?.name ?? null;
  // An unrecognised card often comes back as a bare architecture token ("gen-9"),
  // which says nothing on its own, so the vendor is put in front of it.
  const vendor = detection?.adapter?.vendor;
  if (name && source === "inferred" && vendor && !String(name).toLowerCase().includes(String(vendor).toLowerCase())) {
    const label = String(vendor).charAt(0).toUpperCase() + String(vendor).slice(1);
    name = `${label} ${name}`;
  }
  $("hw-gpu").textContent = name ?? (detection ? t().notNamed : t().reading);

  const bytes = reading?.gpu?.vramTotalBytes ?? null;
  $("hw-vram").textContent =
    bytes === null
      ? detection?.webgpu?.available
        ? t().notRead
        : t().reading
      : bytes === 0
        ? t().integratedVram
        : `${gbOf(bytes)} GB`;

  chip.textContent = source ? TONE[source] : detection?.webgpu?.timedOut ? t().chipNoAnswer : detection ? t().chipNoReading : t().chipReading;
  chip.dataset.source = source ?? "none";

  if (!detection) {
    $("hw-ram").textContent = t().reading;
    $("hw-cores").textContent = t().reading;
    $("hw-webgpu").textContent = t().reading;
    $("hw-storage").textContent = t().reading;
    $("hw-notes").replaceChildren();
    return;
  }

  $("hw-ram").textContent = detection.ram.gb
    ? detection.ram.clamped
      ? t().ramClamped(detection.ram.gb)
      : t().ramAbout(detection.ram.gb)
    : t().ramNone;

  $("hw-cores").textContent = detection.cpu.logicalCores ? t().cores(detection.cpu.logicalCores) : t().notReported;

  const webgpu = detection.webgpu;
  if (!webgpu.available) {
    $("hw-webgpu").textContent = t().noWebGpu;
  } else if (webgpu.error) {
    $("hw-webgpu").textContent = t().noAdapter(webgpu.error);
  } else {
    const adapter = detection.adapter;
    const parts = [
      t().f16(adapter.shaderF16),
      t().subgroups(adapter.subgroups),
    ];
    if (adapter.limits.maxBufferSize) parts.push(t().maxBuffer((adapter.limits.maxBufferSize / GIB).toFixed(0)));
    if (adapter.isFallback) parts.push(t().software);
    $("hw-webgpu").textContent = parts.join(" · ");
  }

  $("hw-storage").textContent = detection.storage.quotaBytes
    ? t().storage((detection.storage.quotaBytes / GIB).toFixed(0))
    : t().notReported;

  const notes = $("hw-notes");
  notes.replaceChildren();
  if (source === "manual") {
    // The panel now shows the visitor's own pick, so notes that explain how the
    // browser failed to name a card would contradict the line above them. Keep
    // only the notes about things still measured (RAM, storage), and say plainly
    // that the card itself was not.
    const card = reading?.gpu?.name ?? t().theCard;
    const gb = reading?.gpu?.vramTotalBytes ? `${gbOf(reading.gpu.vramTotalBytes)} GB` : t().theVram;
    notes.append(el("li", { text: t().manualNote(card, gb) }));
    for (const note of detection.notes.filter((line) => !t().aboutCard.test(line)).slice(0, 3)) {
      notes.append(el("li", { text: note }));
    }
    return;
  }
  for (const note of detection.notes.slice(0, 4)) notes.append(el("li", { text: note }));
}

// ---------------------------------------------------------------------------
// The results
// ---------------------------------------------------------------------------

function summaryText(result, reading) {
  const total = result.rows.length;
  if (total === 0) return t().emptyCatalog;
  const fits = result.fits.length;
  const tight = result.tight.length;
  const vram = reading.gpu.vramTotalBytes;
  const source = reading.vramSource;

  if (vram === null) {
    return t().pickBelow;
  }
  if (vram === 0) {
    return t().integrated(total, result.rows[0]?.entry.name ?? t().smallestModel, gib(result.rows[0]?.needBytes ?? 0));
  }

  // A subject that reads as a sentence for each of the three tiers: the page must
  // not say "your card" about a card the visitor typed in, nor about a guess.
  const card = `${gbOf(vram)} GB`;
  const subject =
    source === "inferred"
      ? t().subjectInferred(card)
      : source === "manual"
        ? t().subjectManual(card)
        : t().subjectDetected(card);
  const biggest = result.fits[0] ?? null;
  const tiny = result.rows.reduce((smallest, row) => (row.needBytes < smallest.needBytes ? row : smallest), result.rows[0]);
  let sentence;
  if (fits === 0) {
    sentence = t().fitsNone(subject, total, tiny.entry.name, tiny.quant, gib(tiny.needBytes));
  } else if (fits === total) {
    sentence = t().fitsAll(subject, total, biggest.entry.name, biggest.quant);
  } else {
    sentence = t().fitsSome(subject, fits, total, biggest.entry.name, biggest.quant);
  }
  sentence = sentence[0].toUpperCase() + sentence.slice(1);
  if (tight > 0) {
    sentence += t().tightMore(tight);
  }
  if (source === "inferred") {
    sentence += t().notAGuess;
  }
  return sentence;
}

const TRUST = t().trust;

function renderRow(row, reading) {
  const vramBytes = reading.gpu.vramTotalBytes ?? 0;
  const pct = vramBytes > 0 ? Math.min(100, (row.needBytes / vramBytes) * 100) : 100;
  const over = row.needBytes > vramBytes;

  const bar = el(
    "div",
    { class: "bar", role: "img", "aria-label": t().barLabel(gib(row.needBytes), gbOf(vramBytes)) },
    el("i", { style: `width:${pct.toFixed(1)}%` }),
  );

  const actions = el("div", { class: "row-side" });
  // Rows that fit, and rows that fit only with offload, get the command to run
  // the model; it is also printed in the disclosure so the visitor can read what
  // the button copies before pressing it.
  const command = row.verdict === "fits" || row.verdict === "tight" ? llamaCommand(row) : null;

  // A row that does not fit still gets the app link: the app measures the card
  // properly and can run the model on the CPU, which this page cannot promise.
  if (command) {
    const copy = el("button", { class: "btn btn-quiet", type: "button" }, t().copyCommand);
    copy.addEventListener("click", async () => {
      const ok = await copyText(command);
      copy.textContent = ok ? t().copied : t().pressCtrlC;
      if (!ok && !copy.dataset.manualShown) {
        // Give the visitor something to copy by hand rather than a dead button.
        copy.dataset.manualShown = "1";
        const shown = el("code", { class: "pill", style: "margin-top:8px;white-space:pre-wrap;word-break:break-all" }, command);
        copy.after(shown);
      }
      setTimeout(() => {
        copy.textContent = t().copyCommand;
      }, 2000);
    });
    actions.append(copy);
  }
  actions.append(el("a", { class: "btn btn-primary", href: sitePath("/download/") }, t().getApp));

  const quants = [...row.quants]
    .sort((a, b) => a.needBytes - b.needBytes)
    .map((quant) =>
      el(
        "li",
        {},
        el("span", { class: "q" }, quant.quant),
        el("span", {}, t().file(fileGb(quant.file))),
        el("span", { class: `v v-${quant.verdict}` }, `${gib(quant.needBytes)} · ${VERDICT_WORD[quant.verdict]}`),
      ),
    );

  const details = el(
    "details",
    { class: "row-more" },
    el("summary", {}, t().more(row.quants.length)),
    el("ul", {}, quants.map((li) => li)),
    command ? el("p", { class: "note cmd-note" }, t().runIt, el("code", { class: "cmd" }, command)) : null,
    row.entry.notes ? el("p", { class: "note" }, catalogNotes(row.entry)) : null,
    el(
      "p",
      { class: "note" },
      t().served(row.entry.license, Number(row.context).toLocaleString("en-US")),
      row.entry.url ? el("a", { href: row.entry.url, rel: "noopener" }, t().modelCard) : t().noCatalogLink,
    ),
  );

  return el(
    "article",
    { class: "row", "data-verdict": row.verdict },
    el(
      "div",
      { class: "row-main" },
      el(
        "div",
        { class: "row-title" },
        el("h4", {}, row.entry.name),
        el("span", { class: "badge" }, t().params(Number(row.entry.params).toFixed(2))),
        row.entry.use ? el("span", { class: "badge" }, catalogUse(row.entry)) : null,
      ),
      el(
        "p",
        { class: "row-meta" },
        el("span", { class: "pill" }, row.quant),
        el("span", {}, t().download(fileGb(row.quantSpec.file))),
        el("span", {}, "·"),
        el("span", {}, t().needsOf(gib(row.needBytes), vramBytes ? `${gbOf(vramBytes)} GB` : t().vram)),
      ),
      bar,
      el(
        "p",
        { class: "bar-legend" },
        el("span", {}, t().overInside(over, gib(Math.abs(row.needBytes - vramBytes)))),
        el("span", {}, row.verdict === "fits" ? t().fullyOn : row.verdict === "tight" ? t().spills : t().notEither),
      ),
      el("p", { class: "why" }, rowReason(row, reading)),
    ),
    actions,
    details,
  );
}

function renderGroup(group, rows, reading) {
  const section = el(
    "section",
    { class: "group", "data-verdict": group.key, "aria-labelledby": `g-${group.key}-h` },
    el(
      "div",
      { class: "group-head" },
      el("h3", { id: `g-${group.key}-h` }, group.title),
      el("span", { class: "count" }, t().count(rows.length)),
      el("p", {}, group.blurb),
    ),
  );
  if (rows.length === 0) {
    section.append(el("p", { class: "empty" }, t().nothingHere));
  } else {
    for (const row of rows) section.append(renderRow(row, reading));
  }
  return section;
}

function renderResults(result, reading) {
  $("summary").textContent = summaryText(result, reading);
  $("trust").textContent = TRUST[reading.vramSource] ?? "";

  const groups = $("groups");
  groups.replaceChildren();
  for (const group of GROUPS) groups.append(renderGroup(group, result[group.key] ?? [], reading));
}

function renderWaiting(message) {
  $("summary").textContent = message;
  $("trust").textContent = "";
  $("groups").replaceChildren();
}

// ---------------------------------------------------------------------------
// Applying a reading: detection or a manual pick
// ---------------------------------------------------------------------------

function applyReading(reading) {
  state.reading = reading;
  renderHardware();
  if (!state.catalog) return;
  try {
    renderResults(recommend({ hardware: reading, catalog: state.catalog }), reading);
  } catch (err) {
    renderWaiting(t().fitFailed(err?.message ?? err));
  }
}

/** The detection result as the reading `fit.js` consumes. */
function readingFromDetection(detection) {
  return hardwareReading({
    name: detection.vram.name ?? detection.adapter?.name ?? null,
    vendor: detection.adapter?.vendor ?? null,
    vramGb: detection.vram.gb,
    vramSource: detection.vram.source,
    ramGb: detection.ram.gb,
    ramSource: detection.ram.source,
    webgpu: detection.webgpu,
    notes: detection.notes,
  });
}

function applyManual({ name, vramGb }) {
  const detection = state.detection ?? {};
  const reading = hardwareReading({
    name,
    vendor: null,
    vramGb,
    vramSource: "manual",
    ramGb: detection.ram?.gb ?? null,
    ramSource: detection.ram?.source ?? null,
    webgpu: detection.webgpu ?? null,
    notes: [],
  });
  applyReading(reading);
  $("picker-note").textContent = t().usingManual(vramGb, name);
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

function fillPicker() {
  const select = $("gpu-select");
  for (const group of manualOptions()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const option of group.options) {
      const node = document.createElement("option");
      node.value = option.id;
      node.textContent = option.label;
      optgroup.append(node);
    }
    select.append(optgroup);
  }
}

function wirePicker() {
  const form = $("picker");
  const select = $("gpu-select");
  const input = $("vram-input");

  const useEntry = (entry) => {
    if (!entry) return;
    input.value = String(entry.vramGb);
    applyManual({ name: entry.name, vramGb: entry.vramGb });
  };

  select.addEventListener("change", () => {
    const entry = gpuById(select.value);
    if (entry) useEntry(entry);
  });

  input.addEventListener("change", () => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 0 || value > 256) return;
    const entry = gpuById(select.value);
    applyManual({ name: entry?.name ?? t().described, vramGb: value });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = gpuById(select.value);
    const value = entry ? entry.vramGb : Number(input.value);
    if (!Number.isFinite(value) || value < 0 || value > 256) {
      $("picker-note").textContent = t().typeVram;
      return;
    }
    if (entry) applyManual({ name: entry.name, vramGb: entry.vramGb });
    else applyManual({ name: t().described, vramGb: value });
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

// The whole site's key: /theme.js applies it before first paint, so the choice carries across pages.
const THEME_KEY = "rosalena-theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = $("theme-toggle");
  toggle.textContent = theme === "light" ? t().dark : t().light;
  toggle.setAttribute("aria-pressed", String(theme === "light"));
}

function wireTheme() {
  // /theme.js already applied the saved (or ?theme=) choice; dark is the site's default.
  applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  $("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Same as above: a forgotten preference is not a broken page.
    }
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadCatalog() {
  const response = await fetch(new URL("./catalog.json", import.meta.url), { cache: "no-cache" });
  if (!response.ok) throw new Error(`catalog.json: HTTP ${response.status}`);
  return response.json();
}

async function boot() {
  wireTheme();
  fillPicker();
  wirePicker();
  renderHardware();

  // Both reads are independent: a browser that will not give up a GPU must not
  // cost us the catalog, and a missing catalog must not hide the hardware panel.
  const [catalogResult, detectionResult] = await Promise.allSettled([
    loadCatalog(),
    detectHardware({ timeoutMs: ADAPTER_TIMEOUT_MS }),
  ]);

  state.catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
  state.detection = detectionResult.status === "fulfilled" ? detectionResult.value : null;
  renderHardware();

  if (!state.catalog) {
    const reason = catalogResult.status === "rejected" ? catalogResult.reason?.message ?? catalogResult.reason : t().unknownError;
    renderWaiting(t().catalogFailed(reason));
    return;
  }

  const vramGb = state.detection?.vram?.gb;
  if (typeof vramGb === "number" && state.detection.vram.source) {
    applyReading(readingFromDetection(state.detection));
    $("picker-note").textContent =
      state.detection.vram.source === "detected"
        ? t().recognised
        : t().guessed;
    return;
  }

  // No WebGPU, no adapter, or no answer within the cap: the picker is the page.
  renderWaiting(
    state.detection?.webgpu?.timedOut
      ? t().timedOut(Math.round(ADAPTER_TIMEOUT_MS / 1000))
      : t().noName,
  );
  $("picker-note").textContent = t().noCard;
}

boot();
