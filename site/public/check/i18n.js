/**
 * The words /check/ writes with JavaScript, in English and Spanish.
 *
 * The page language comes from <html lang>: /es/check/ (built by site/tools/build-i18n.mjs)
 * loads the same check.js, detect.js and fit.js as the English page. fit.js stays a copy of
 * the desktop app's arithmetic, English reasons included, so the Spanish reason for a row is
 * written here from the same numbers (reasonEs). Browser-safe and Node-safe: no DOM at import,
 * so site/test/i18n.test.mjs can import it and call setLang("es").
 */

import { formatGib, GIB } from "./fit.js";

function pageLang() {
  const value = typeof document !== "undefined" ? document.documentElement?.getAttribute?.("lang") ?? "" : "";
  return /^es\b/i.test(value) ? "es" : "en";
}

/** "en" or "es". A live binding: importers see setLang's change. */
export let LANG = pageLang();

/** For tests: switch every string this page writes. */
export function setLang(next) {
  LANG = next === "es" ? "es" : "en";
  return LANG;
}

/** A path on this site in the page language. */
export const sitePath = (path) => (LANG === "es" ? `/es${path}` : path);

export const TEXT = {
  en: {
    verdict: { fits: "fits", tight: "fits RAM only", tooBig: "does not fit", unknown: "unknown" },
    groups: {
      fits: {
        title: "Runs well",
        blurb: "The weights, the KV cache and the runtime overhead all fit inside your card's VRAM at the quant shown.",
      },
      tight: {
        title: "Runs, but tight",
        blurb: "Too big for VRAM, so part of it runs on the CPU. It works; it is slower, and that is the honest trade.",
      },
      tooBig: {
        title: "Will not fit",
        blurb:
          "Bigger than your card's VRAM and bigger than the RAM this browser would confirm. A machine with more RAM can still run the smallest of these with CPU offload, which is what the desktop app measures.",
      },
    },
    tone: { detected: "detected", inferred: "inferred", manual: "manual" },
    notNamed: "Not named by this browser",
    reading: "Reading…",
    notRead: "Not read",
    integratedVram: "0 GB: integrated graphics, which borrow system RAM",
    chipNoAnswer: "no answer",
    chipNoReading: "no reading",
    chipReading: "reading…",
    ramClamped: (gb) => `${gb} GiB or more (the spec caps this reading at 8)`,
    ramAbout: (gb) => `about ${gb} GiB (the browser rounds this figure)`,
    ramNone: "Not reported by this browser",
    cores: (n) => `${n} logical`,
    notReported: "Not reported",
    noWebGpu: "Not available in this browser",
    noAdapter: (error) => `No adapter: ${error}`,
    f16: (on) => (on ? "shader-f16" : "no shader-f16"),
    subgroups: (on) => (on ? "subgroups" : "no subgroups"),
    maxBuffer: (n) => `${n} GiB max buffer`,
    software: "software adapter",
    storage: (n) => `${n} GiB allowed for this site's storage`,
    theCard: "the card",
    theVram: "the VRAM",
    manualNote: (card, gb) => `${card} at ${gb} is what you chose, so the card and its VRAM were not measured by this page`,
    aboutCard: /card|VRAM|graphics/i,
    emptyCatalog: "The catalog is empty, so there is nothing to compare with your card.",
    pickBelow: "Pick your card below and this page will sort the models against it.",
    integrated: (total, name, need) =>
      `Your machine reports integrated graphics with no VRAM of its own, so none of these ${total} models can sit on the GPU; the smallest, ${name}, still needs ${need}.`,
    smallestModel: "the smallest model",
    subjectInferred: (card) => `a guessed ${card} card`,
    subjectManual: (card) => `the ${card} card you picked`,
    subjectDetected: (card) => `your ${card} card`,
    fitsNone: (subject, total, name, quant, need) => `${subject} cannot hold any of these ${total} models in VRAM; the smallest, ${name} at ${quant}, needs ${need}.`,
    fitsAll: (subject, total, name, quant) => `${subject} can hold all ${total} of these models comfortably; the biggest is ${name} at ${quant}.`,
    fitsSome: (subject, fits, total, name, quant) =>
      `${subject} can run ${fits} of these ${total} models comfortably; the biggest that fits is ${name} at ${quant}.`,
    tightMore: (n) => ` ${n === 1 ? "One more" : `${n} more`} would run with CPU offload.`,
    notAGuess: " Set your card below for an answer that is not a guess.",
    trust: {
      detected:
        "The card name came from the browser and the VRAM is the vendor's published figure for that model: a lookup, not a measurement, and the desktop app reads the real figure from the driver.",
      inferred:
        "The browser did not name a card this page knows, so the VRAM figure is guessed from the adapter's buffer limit, which is a floor rather than a measurement. Check it against the picker before trusting a row.",
      manual: "You set this VRAM figure yourself, so it is only as good as what you picked; nothing on this page measured your card.",
    },
    barLabel: (need, gb) => `Needs ${need} of the ${gb} GB on your card`,
    copyCommand: "Copy the llama.cpp command",
    copied: "Copied",
    pressCtrlC: "Press Ctrl+C to copy",
    getApp: "Get the app",
    file: (size) => `${size} file`,
    more: (n) => `More: all ${n} quant${n === 1 ? "" : "s"}, the model card and what it is for`,
    runIt: "Run it yourself: ",
    served: (license, ctx) => `${license ?? "licence not stated"} · served at ${ctx} tokens · `,
    modelCard: "model card",
    noCatalogLink: "no catalog link",
    params: (n) => `${n}B params`,
    download: (size) => `${size} download`,
    needsOf: (need, of) => `needs ${need} of ${of}`,
    vram: "VRAM",
    overInside: (over, by) => `${over ? "over" : "inside"} by ${by}`,
    fullyOn: "fully on the card",
    spills: "spills to system RAM",
    notEither: "does not fit either",
    count: (n) => (n === 1 ? "1 model" : `${n} models`),
    nothingHere: "Nothing in this catalog lands here for this card.",
    fitFailed: (message) => `The catalog could not be fitted: ${message}`,
    usingManual: (gb, name) => `Using ${gb} GB for ${name}, which you set yourself. This result is labelled manual, not detected.`,
    described: "the card you described",
    typeVram: "Type the card's VRAM in GB, for example 12.",
    dark: "Dark theme",
    light: "Light theme",
    catalogFailed: (reason) => `The model catalog could not be loaded (${reason}), so there is nothing to sort.`,
    unknownError: "unknown error",
    recognised: "That card was recognised from the browser's own description. Pick another here if it is wrong.",
    guessed: "That card was not in the table, so the VRAM figure is a guess. Pick your card here to replace it with a real one.",
    timedOut: (s) => `The GPU did not answer within ${s} seconds, so this page stopped waiting. Pick your card below and the whole table fills in.`,
    noName: "This browser would not name a graphics card, so pick yours below and the table fills in.",
    noCard: "No card was detected. Pick yours, or type its VRAM, and every row below updates.",
  },
  es: {
    verdict: { fits: "cabe", tight: "solo cabe en RAM", tooBig: "no cabe", unknown: "desconocido" },
    groups: {
      fits: {
        title: "Corre bien",
        blurb: "Los pesos, la caché KV y el overhead del runtime caben en la VRAM de tu tarjeta con la cuantización indicada.",
      },
      tight: {
        title: "Corre, pero justo",
        blurb: "Es demasiado grande para la VRAM, así que una parte corre en la CPU. Funciona; es más lento, y ese es el intercambio honesto.",
      },
      tooBig: {
        title: "No cabe",
        blurb:
          "Es más grande que la VRAM de tu tarjeta y que la RAM que este navegador pudo confirmar. Una máquina con más RAM todavía puede correr el más pequeño de estos con offload a la CPU, que es lo que mide la app de escritorio.",
      },
    },
    tone: { detected: "detectado", inferred: "inferido", manual: "manual" },
    notNamed: "Este navegador no la nombró",
    reading: "Leyendo…",
    notRead: "No se leyó",
    integratedVram: "0 GB: gráficos integrados, que usan la RAM del sistema",
    chipNoAnswer: "sin respuesta",
    chipNoReading: "sin lectura",
    chipReading: "leyendo…",
    ramClamped: (gb) => `${gb} GiB o más (la especificación limita esta lectura a 8)`,
    ramAbout: (gb) => `unos ${gb} GiB (el navegador redondea esta cifra)`,
    ramNone: "Este navegador no la reporta",
    cores: (n) => `${n} lógicos`,
    notReported: "No reportado",
    noWebGpu: "No está disponible en este navegador",
    noAdapter: (error) => `Sin adaptador: ${error}`,
    f16: (on) => (on ? "shader-f16" : "sin shader-f16"),
    subgroups: (on) => (on ? "subgroups" : "sin subgroups"),
    maxBuffer: (n) => `búfer máximo de ${n} GiB`,
    software: "adaptador por software",
    storage: (n) => `${n} GiB permitidos para el almacenamiento de este sitio`,
    theCard: "la tarjeta",
    theVram: "la VRAM",
    manualNote: (card, gb) => `${card} con ${gb} es lo que elegiste, así que esta página no midió la tarjeta ni su VRAM`,
    aboutCard: /tarjeta|VRAM|gráfic/i,
    emptyCatalog: "El catálogo está vacío, así que no hay nada que comparar con tu tarjeta.",
    pickBelow: "Elige tu tarjeta abajo y esta página va a ordenar los modelos según ella.",
    integrated: (total, name, need) =>
      `Tu máquina reporta gráficos integrados sin VRAM propia, así que ninguno de estos ${total} modelos puede ir en la GPU; el más pequeño, ${name}, igual necesita ${need}.`,
    smallestModel: "el modelo más pequeño",
    subjectInferred: (card) => `una tarjeta que se estima de ${card}`,
    subjectManual: (card) => `la tarjeta de ${card} que elegiste`,
    subjectDetected: (card) => `tu tarjeta de ${card}`,
    fitsNone: (subject, total, name, quant, need) =>
      `${subject} no puede tener en VRAM ninguno de estos ${total} modelos; el más pequeño, ${name} en ${quant}, necesita ${need}.`,
    fitsAll: (subject, total, name, quant) => `${subject} puede tener los ${total} modelos con holgura; el más grande es ${name} en ${quant}.`,
    fitsSome: (subject, fits, total, name, quant) =>
      `${subject} puede correr ${fits} de estos ${total} modelos con holgura; el más grande que cabe es ${name} en ${quant}.`,
    tightMore: (n) => (n === 1 ? " Uno más correría con offload a la CPU." : ` ${n} más correrían con offload a la CPU.`),
    notAGuess: " Elige tu tarjeta abajo para tener una respuesta que no sea una suposición.",
    trust: {
      detected:
        "El nombre de la tarjeta vino del navegador y la VRAM es la cifra que publica el fabricante para ese modelo: una búsqueda en una tabla, no una medición, y la app de escritorio lee la cifra real del driver.",
      inferred:
        "El navegador no nombró una tarjeta que esta página conozca, así que la cifra de VRAM se estima a partir del límite de búfer del adaptador, que es un piso y no una medición. Compárala con el selector antes de confiar en una fila.",
      manual: "Tú pusiste esta cifra de VRAM, así que vale lo mismo que tu elección; nada en esta página midió tu tarjeta.",
    },
    barLabel: (need, gb) => `Necesita ${need} de los ${gb} GB de tu tarjeta`,
    copyCommand: "Copiar el comando de llama.cpp",
    copied: "Copiado",
    pressCtrlC: "Presiona Ctrl+C para copiar",
    getApp: "Consigue la app",
    file: (size) => `archivo de ${size}`,
    more: (n) => `Más: ${n === 1 ? "la cuantización" : `las ${n} cuantizaciones`}, la ficha del modelo y para qué sirve`,
    runIt: "Córrelo tú: ",
    served: (license, ctx) => `${license ?? "licencia no indicada"} · servido con ${ctx} tokens de contexto · `,
    modelCard: "ficha del modelo",
    noCatalogLink: "sin enlace en el catálogo",
    params: (n) => `${n}B parámetros`,
    download: (size) => `descarga de ${size}`,
    needsOf: (need, of) => `necesita ${need} de ${of}`,
    vram: "VRAM",
    overInside: (over, by) => (over ? `se pasa por ${by}` : `sobran ${by}`),
    fullyOn: "completo en la tarjeta",
    spills: "se desborda a la RAM del sistema",
    notEither: "tampoco cabe",
    count: (n) => (n === 1 ? "1 modelo" : `${n} modelos`),
    nothingHere: "Nada de este catálogo cae aquí para esta tarjeta.",
    fitFailed: (message) => `No se pudo calcular el catálogo: ${message}`,
    usingManual: (gb, name) => `Usando ${gb} GB para ${name}, como lo pusiste tú. Este resultado se marca como manual, no como detectado.`,
    described: "la tarjeta que describiste",
    typeVram: "Escribe la VRAM de la tarjeta en GB, por ejemplo 12.",
    dark: "Tema oscuro",
    light: "Tema claro",
    catalogFailed: (reason) => `No se pudo cargar el catálogo de modelos (${reason}), así que no hay nada que ordenar.`,
    unknownError: "error desconocido",
    recognised: "Esa tarjeta se reconoció a partir de la descripción del propio navegador. Si está mal, elige otra aquí.",
    guessed: "Esa tarjeta no estaba en la tabla, así que la cifra de VRAM es una suposición. Elige tu tarjeta aquí para cambiarla por una real.",
    timedOut: (s) => `La GPU no respondió en ${s} segundos, así que esta página dejó de esperar. Elige tu tarjeta abajo y se llena toda la tabla.`,
    noName: "Este navegador no quiso nombrar una tarjeta gráfica, así que elige la tuya abajo y se llena la tabla.",
    noCard: "No se detectó ninguna tarjeta. Elige la tuya, o escribe su VRAM, y se actualizan todas las filas de abajo.",
  },
};

/** The current language's table. */
export const t = () => TEXT[LANG];

/** detect.js notes and errors. */
export const NOTES = {
  en: {
    noNavigator: "there is no browser navigator here, so nothing could be read",
    ramCapped: "navigator.deviceMemory is capped at 8 by the spec, so 8 GiB means 'at least 8', not 'exactly 8'",
    ramRounded: "navigator.deviceMemory is rounded to a power of two, so the RAM figure is approximate",
    ramUnknown: "this browser does not report deviceMemory, so RAM is unknown",
    storageSilent: "navigator.storage.estimate() did not answer, so browser storage is unknown",
    storageRefused: "navigator.storage.estimate() was refused, so browser storage is unknown",
    noHints: "this browser does not expose userAgentData hints",
    hintsRefused: "userAgentData hints were refused",
    noGpuError: "no navigator.gpu",
    noGpu: "no WebGPU here (Safari, Firefox, or a browser that has it turned off), so the card has to be picked by hand",
    gpuTimeoutError: (ms) => `the GPU did not answer within ${ms} ms`,
    gpuTimeout: (s) => `WebGPU did not answer within ${s} s, so the card has to be picked by hand`,
    adapterFailed: (error) => `requestAdapter failed (${error}), which usually means the GPU is blocked for this page`,
    nullAdapterError: "requestAdapter returned null",
    nullAdapter: "WebGPU is present but handed back no adapter (a blocked or software-only GPU), so the card has to be picked by hand",
    integrated: "integrated graphics: the GPU shares the system RAM, so no model can be held in VRAM",
    inferred: "the card name was not recognised, so the VRAM figure is a guess and the picker below is the honest answer",
    unknown: "neither the card name nor the buffer limits came back, so VRAM is unknown until you pick it",
  },
  es: {
    noNavigator: "aquí no hay navigator del navegador, así que no se pudo leer nada",
    ramCapped: "la especificación limita navigator.deviceMemory a 8, así que 8 GiB significa 'al menos 8', no 'exactamente 8'",
    ramRounded: "navigator.deviceMemory se redondea a una potencia de dos, así que la cifra de RAM es aproximada",
    ramUnknown: "este navegador no reporta deviceMemory, así que la RAM es desconocida",
    storageSilent: "navigator.storage.estimate() no respondió, así que el almacenamiento del navegador es desconocido",
    storageRefused: "navigator.storage.estimate() fue rechazado, así que el almacenamiento del navegador es desconocido",
    noHints: "este navegador no expone las pistas de userAgentData",
    hintsRefused: "las pistas de userAgentData fueron rechazadas",
    noGpuError: "no hay navigator.gpu",
    noGpu: "aquí no hay WebGPU (Safari, Firefox o un navegador que lo tiene desactivado), así que la tarjeta se tiene que elegir a mano",
    gpuTimeoutError: (ms) => `la GPU no respondió en ${ms} ms`,
    gpuTimeout: (s) => `WebGPU no respondió en ${s} s, así que la tarjeta se tiene que elegir a mano`,
    adapterFailed: (error) => `requestAdapter falló (${error}), lo que suele significar que la GPU está bloqueada para esta página`,
    nullAdapterError: "requestAdapter devolvió null",
    nullAdapter: "WebGPU está presente pero no devolvió ningún adaptador (una GPU bloqueada o solo por software), así que la tarjeta se tiene que elegir a mano",
    integrated: "gráficos integrados: la GPU comparte la RAM del sistema, así que ningún modelo puede quedar en la VRAM",
    inferred: "no se reconoció el nombre de la tarjeta, así que la cifra de VRAM es una suposición y el selector de abajo es la respuesta honesta",
    unknown: "no volvió ni el nombre de la tarjeta ni los límites de búfer, así que la VRAM es desconocida hasta que la elijas",
  },
};

export const note = () => NOTES[LANG];

// ---------------------------------------------------------------------------
// The catalog (catalog.json is generated from the app's catalog, in English)
// ---------------------------------------------------------------------------

export const USE_ES = { reasoning: "razonamiento", code: "código", chat: "chat", vision: "visión", embedding: "embeddings" };

/**
 * Spanish notes for each catalog model, with the English they were translated from. When the
 * catalog's English changes, that row shows the new English until this table catches up, and
 * site/test/i18n.test.mjs fails so the table does catch up.
 */
export const CATALOG_ES = {
  "qwen3.8-27b": {
    en: "The model this harness's router already points at (local/qwen3.8-27b), and the GGUF on this box is exactly the UD-Q4_K_M below; it is text-only unless you add its 0.93 GB mmproj projector, which is not counted in the sizes here.",
    es: "El modelo al que ya apunta el router de este harness (local/qwen3.8-27b), y el GGUF de esta máquina es exactamente el UD-Q4_K_M de abajo; es solo texto a menos que le agregues su proyector mmproj de 0.93 GB, que no se cuenta en estos tamaños.",
  },
  "qwen3-32b": {
    en: "Q4_K_M at 8k context is the only fully-on-card setting here; Q5_K_M already spills to the CPU, and Q8_0's 34.8 GB cannot load in 24 GB at any context.",
    es: "Q4_K_M con 8k de contexto es la única configuración que cabe completa en la tarjeta; Q5_K_M ya se desborda a la CPU, y los 34.8 GB de Q8_0 no caben en 24 GB con ningún contexto.",
  },
  "qwen3-coder-30b-a3b": {
    en: "A 30B mixture with 3.3B active per token, so it decodes near 8B speed while carrying 30B-class code knowledge; Q8_0 at 32.5 GB does not fit 24 GB at any context worth using.",
    es: "Una mezcla de 30B con 3.3B activos por token, así que decodifica a una velocidad cercana a la de un 8B y trae el conocimiento de código de un modelo de 30B; Q8_0, con 32.5 GB, no cabe en 24 GB con ningún contexto que valga la pena.",
  },
  "qwen3-30b-a3b": {
    en: "The best all-round fit for 24 GB: Q4_K_M plus 32k of KV cache is about 20.8 GiB, and the 3.3B-active mixture keeps decoding fast on a 3090.",
    es: "El mejor equilibrio general para 24 GB: Q4_K_M más 32k de caché KV ocupan unos 20.8 GiB, y la mezcla con 3.3B activos mantiene la decodificación rápida en una 3090.",
  },
  "qwen3-14b": {
    en: "Dense 14B at Q8_0 with 32k of context is about 20.1 GiB, which makes it the densest near-lossless model this GPU holds without offload.",
    es: "Un 14B denso en Q8_0 con 32k de contexto ocupa unos 20.1 GiB, lo que lo vuelve el modelo denso casi sin pérdida más grande que esta GPU aguanta sin offload.",
  },
  "qwen3-8b": {
    en: "The fast model: Q8_0 at 32k context is about 13.1 GiB, so it leaves room for a second process or a bigger KV budget, and it is the right draft/summary worker.",
    es: "El modelo rápido: Q8_0 con 32k de contexto ocupa unos 13.1 GiB, así que deja lugar para un segundo proceso o un presupuesto de KV más grande, y es el indicado para borradores y resúmenes.",
  },
  "qwen3-4b": {
    en: "Small enough to run at Q8_0 next to a render job, and the honest pick for classification, routing and short extraction where a 27B is wasted.",
    es: "Lo bastante pequeño para correr en Q8_0 junto a un trabajo de render, y la opción honesta para clasificar, enrutar y extracciones cortas, donde un 27B se desperdicia.",
  },
  "qwen3-vl-8b": {
    en: "The vision-language pick; it needs its mmproj projector loaded alongside (0.75 GB for the Q8_0 one), and Q8_0 plus that plus 32k of KV is about 13.8 GiB, still inside the card.",
    es: "La opción de visión y lenguaje; necesita su proyector mmproj cargado al lado (0.75 GB el de Q8_0), y Q8_0 más eso más 32k de KV ocupan unos 13.8 GiB, todavía dentro de la tarjeta.",
  },
  "qwen3-embedding-0.6b": {
    en: "1024-dimension embeddings at 0.64 GB for the Q8_0 file, small enough to stay resident next to a 24 GB text model without costing it a layer.",
    es: "Embeddings de 1024 dimensiones con 0.64 GB para el archivo Q8_0, lo bastante pequeño para quedarse cargado junto a un modelo de texto de 24 GB sin quitarle una capa.",
  },
  "llama-3.1-8b": {
    en: "The starter model for a PC with a real GPU or 16 GB of RAM: good enough for basic coding and math, and Q4_K_M plus 16k of KV is about 7.1 GiB, so it runs on the CPU too, slowly.",
    es: "El modelo para empezar en una PC con una GPU de verdad o 16 GB de RAM: alcanza para programación y matemáticas básicas, y Q4_K_M más 16k de KV ocupan unos 7.1 GiB, así que también corre en la CPU, lento.",
  },
  "llama-3.2-3b": {
    en: "The starter model for a modest PC (8 GB of RAM, no real GPU): about twice as fast as the 8B on a CPU and still fine for short coding and math questions.",
    es: "El modelo para empezar en una PC modesta (8 GB de RAM, sin una GPU de verdad): más o menos el doble de rápido que el 8B en una CPU y todavía sirve para preguntas cortas de programación y matemáticas.",
  },
  "llama-3.3-70b": {
    en: "Deliberately too big and kept as the honest no: 42.5 GB at Q4_K_M exceeds 24 GB of VRAM and does not fit in 32-64 GB of RAM either, and Q8_0 is two files totalling 75 GB, so the url points at the first part.",
    es: "Demasiado grande a propósito, y se queda como el no honesto: 42.5 GB en Q4_K_M superan los 24 GB de VRAM y tampoco caben en 32-64 GB de RAM, y Q8_0 son dos archivos que suman 75 GB, así que la URL apunta a la primera parte.",
  },
  "qwen2.5-72b": {
    en: "A second honest no beside Llama 3.3 70B: 47.4 GB at Q4_K_M (one file, size read from Hugging Face on 2026-11-03) is twice a 24 GB card, and only runs split across the card and 64 GB or more of RAM, at a word or two a second.",
    es: "Un segundo no honesto junto a Llama 3.3 70B: 47.4 GB en Q4_K_M (un solo archivo, tamaño leído de Hugging Face el 2026-11-03) son el doble de una tarjeta de 24 GB, y solo corre repartido entre la tarjeta y 64 GB o más de RAM, a una o dos palabras por segundo.",
  },
};

/** What a catalog row says it is for, in the page language. */
export function catalogUse(entry) {
  const use = entry?.use ?? "";
  return LANG === "es" ? (USE_ES[use] ?? use) : use;
}

/** A catalog row's notes in the page language; English when the translation is stale. */
export function catalogNotes(entry) {
  const notes = entry?.notes ?? "";
  if (LANG !== "es") return notes;
  const row = CATALOG_ES[entry?.id];
  return row && row.en === notes ? row.es : notes;
}

/**
 * fit.js's reasonFor() in Spanish, from the same numbers. Kept here, not in fit.js, because
 * fit.js is a copy of the app's code and is pinned to it by site/test/fit.test.mjs.
 */
export function reasonEs(row, hardware) {
  const vram = hardware?.gpu?.vramTotalBytes;
  const ram = hardware?.ram?.totalBytes;
  const card = vram === null || vram === undefined ? null : `${Math.round(vram / GIB)} GB`;
  const known = (value) => value !== null && value !== undefined;
  if (row.verdict === "fits") {
    return `Cabe en tu tarjeta de ${card} y sobran ${formatGib(row.gpuHeadroomBytes)}.`;
  }
  if (row.verdict === "tight") {
    const inside = known(ram) ? `en los ${formatGib(ram)} de RAM` : "en la RAM que reportó tu navegador";
    return `Necesita ${formatGib(row.needBytes)}, más que tus ${card} de VRAM, pero cabe ${inside}, así que corre con offload a la CPU.`;
  }
  if (row.verdict === "tooBig") {
    const over = row.gpuHeadroomBytes === null ? "" : `, ${formatGib(-row.gpuHeadroomBytes)} más que tu tarjeta`;
    const ramNote = known(ram)
      ? `, y más que los ${formatGib(ram)} de RAM que este navegador pudo confirmar`
      : ", y el navegador tampoco reportó RAM suficiente para contenerlo";
    return `Necesita ${formatGib(row.needBytes)}${over}${ramNote}.`;
  }
  return `Necesita ${formatGib(row.needBytes)}, pero no volvió ninguna cifra de VRAM, así que no hay con qué compararlo.`;
}

/** The reason a row shows: fit.js's own in English, reasonEs in Spanish. */
export function rowReason(row, hardware) {
  return LANG === "es" ? reasonEs(row, hardware) : row.reason;
}
