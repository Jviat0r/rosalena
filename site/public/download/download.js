/**
 * Download page behaviour: read releases.json, render only what actually exists.
 *
 * The one rule this file has to keep: an entry may become a link only when the manifest
 * says `available: true` AND carries an https URL. Everything else renders as text -
 * "Not built yet" - with no <a> element, so the page cannot offer a download that 404s.
 *
 * It also reads updates.json (the feed the installed app checks) and renders one short
 * notice from it. Same rule, narrower: the update feed is described, never turned into a
 * download, and its release link is shown only when it is an https URL.
 *
 * It lives in its own file because the site CSP (site/public/_headers) allows
 * `script-src 'self'` and nothing inline. Every function below that produces HTML is pure
 * string building so that site/test/download.test.mjs and site/test/updates.test.mjs can
 * exercise it in plain node without a DOM; only mount() and mountUpdates() touch the
 * document.
 */

const PLATFORM_FALLBACK = {
  windows: { label: "Windows", requirement: "Windows 10 or 11, 64-bit" },
  macos: { label: "macOS", requirement: "macOS 11 or newer, Apple silicon or Intel" },
  linux: {
    label: "Linux",
    requirement: "64-bit Linux (x86_64): the AppImage runs on most distributions, the .deb installs on Debian and Ubuntu",
    // Shown while a manifest has no Linux entry at all (releases before the Linux job existed).
    // The card fills itself in from releases.json as soon as a release lists the files.
    pendingNote: "Not built yet: the AppImage and the .deb come out of the release pipeline's Linux job, and they appear here as soon as a release includes them.",
  },
};

const KIND_LABEL = {
  installer: "Installer",
  portable: "Portable app",
  dmg: "Disk image",
  zip: "Zip archive",
  msi: "Windows installer",
  appimage: "AppImage",
  deb: "Debian package",
};

// ------------------------------------------------------------------ language
//
// The page language comes from <html lang>: the Spanish page (/es/download/, built by
// site/tools/build-i18n.mjs) loads this same file. English is the default, and in Node (the
// tests) there is no document, so it is English unless a test calls setLang("es"). Every
// English sentence below is the one the page always printed; the Spanish table mirrors it.

function pageLang() {
  const value = typeof document !== "undefined" ? document.documentElement?.getAttribute?.("lang") ?? "" : "";
  return /^es\b/i.test(value) ? "es" : "en";
}

let lang = pageLang();

/** Switch the language of every string this module writes ("en" or "es"). For tests. */
export function setLang(next) {
  lang = next === "es" ? "es" : "en";
  return lang;
}

const PLATFORM_FALLBACK_ES = {
  windows: { label: "Windows", requirement: "Windows 10 u 11, 64 bits" },
  macos: { label: "macOS", requirement: "macOS 11 o posterior, Apple silicon o Intel" },
  linux: {
    label: "Linux",
    requirement: "Linux de 64 bits (x86_64): el AppImage corre en la mayoría de las distribuciones y el .deb se instala en Debian y Ubuntu",
    pendingNote: "Aún no compilado: el AppImage y el .deb salen del job de Linux del pipeline de lanzamiento, y aparecen aquí en cuanto una versión los incluya.",
  },
};

const KIND_LABEL_ES = {
  installer: "Instalador",
  portable: "App portable",
  dmg: "Imagen de disco",
  zip: "Archivo zip",
  msi: "Instalador de Windows",
  appimage: "AppImage",
  deb: "Paquete de Debian",
};

/**
 * Sentences releases.json carries in English (written by packaging/release/manifest.mjs).
 * On the Spanish page a known sentence is shown in Spanish; one this table does not know yet
 * (a new note from a later release) is shown as the manifest wrote it, in English.
 */
export const MANIFEST_ES = {
  "Windows 10 or 11, 64-bit": "Windows 10 u 11, 64 bits",
  "macOS 11 or newer, Apple silicon or Intel": "macOS 11 o posterior, Apple silicon o Intel",
  "64-bit Linux (x86_64): the AppImage runs on most distributions, the .deb installs on Debian and Ubuntu":
    "Linux de 64 bits (x86_64): el AppImage corre en la mayoría de las distribuciones y el .deb se instala en Debian y Ubuntu",
  'Unsigned: no code-signing certificate was available when this was built, so Windows SmartScreen shows "Windows protected your PC". Choose More info, then Run anyway.':
    'Sin firmar: no había certificado de firma de código cuando se compiló, así que Windows SmartScreen muestra "Windows protegió su PC". Elige Más información y luego Ejecutar de todas formas.',
  'Unsigned and not notarized: no Apple Developer certificate was available when this was built, so macOS quarantines the download. Right-click the app, choose Open, then Open again, or run xattr -dr com.apple.quarantine "/Applications/Rosalena Harness.app" once.':
    'Sin firmar y sin notarizar: no había certificado de Apple Developer cuando se compiló, así que macOS pone la descarga en cuarentena. Haz clic derecho en la app, elige Abrir y luego Abrir otra vez, o corre una vez xattr -dr com.apple.quarantine "/Applications/Rosalena Harness.app".',
  "Not built yet: no build has produced this file. The Windows installer comes out of the release pipeline, not off a desktop.":
    "Aún no compilado: ninguna compilación produjo este archivo. El instalador de Windows sale del pipeline de lanzamiento, no de una computadora de escritorio.",
  "Not built yet: a macOS file can only come from a Mac, and no Mac has built one. No .dmg and no .zip for macOS exists today.":
    "Aún no compilado: un archivo para macOS solo puede salir de una Mac, y ninguna Mac ha compilado uno. Hoy no existe ningún .dmg ni .zip para macOS.",
  "Not built yet: no build has produced this file. The Linux AppImage and .deb come out of the release pipeline's Linux job.":
    "Aún no compilado: ninguna compilación produjo este archivo. El AppImage y el .deb de Linux salen del job de Linux del pipeline de lanzamiento.",
  "The file was built but no --base-url was given, so no download URL is published yet.":
    "El archivo se compiló, pero no se pasó --base-url, así que todavía no hay una URL de descarga publicada.",
};

/** A manifest sentence in the page language (unknown sentences stay as written). */
function manifestText(text) {
  if (lang !== "es") return text;
  const value = String(text ?? "");
  return MANIFEST_ES[value] ?? value;
}

/** Every sentence this module writes, per language. Functions take the escaped values. */
export const TEXT = {
  en: {
    available: "Available",
    partly: "Partly available",
    notBuilt: "Not built yet",
    checksumPending: "checksum pending",
    hashNotBuilt: "not built yet",
    unknownArch: "unknown",
    bytes: "bytes",
    size: "Size",
    version: "Version",
    download: (size) => `Download ${size}`,
    noFileForPlatform: "No file listed for this platform in this release yet.",
    noArtifacts: "The manifest lists no artifacts.",
    downloadLinux: "Download for Linux",
    linuxMeta: (kind, size) => `${kind} · ${size} · 64-bit Linux`,
    linuxAlt: (url) => `Debian or Ubuntu? <a href="${url}" rel="noopener noreferrer">Get the .deb</a>`,
    windowsMeta: (size) => `Installer · ${size} · Windows 10 or 11, 64-bit`,
    macMeta: (arch, size) => `Disk image · ${arch} · ${size}`,
    macAlt: (other, url) => `${other} Mac? <a href="${url}" rel="noopener noreferrer">Get the ${other} version</a>`,
    unknownChannel: "unknown",
    feedNoVersion:
      "The update feed names no version, so an installed app would report that the check could not be completed.",
    released: (when) => `, released <span class="num">${when}</span>`,
    published: (version, channel, when) =>
      `Now published: version <span class="num">${version}</span> on the <code>${channel}</code> channel${when}.`,
    publishedHow: (url) =>
      `An installed copy older than that offers <strong>Update and restart</strong>, and installs it only after you say yes and its SHA-256 matches. The notes and every file are on <a href="${url}" rel="noopener noreferrer">the release page</a>.`,
    noReleasePage: (version, when) =>
      `The feed names version <span class="num">${version}</span> (released ${when}) but carries no release page, so an installed app reports that the check could not be completed rather than offering an update.`,
    nothingPublished: (version, channel) =>
      `Nothing is published yet: the feed names version <span class="num">${version}</span> on the <code>${channel}</code> channel, with no release date and no release page. An installed copy of ${version} therefore reports <strong>you are up to date at ${version}</strong>, because nothing newer exists.`,
    feedError: (message) =>
      `The update feed could not be read from this page (${message}). The download list above is unaffected; the app's own check reports its own failures, and it never guesses at an update.`,
    errorBadge: "unknown",
    errorCard: "No build is listed, because the manifest could not be read. Nothing is offered for download.",
    unknownDate: "unknown",
    stamp: (product, version, updated, available, total) =>
      `Manifest for ${product} ${version}, updated ${updated}: ${available} of ${total} files available.`,
    footer: (updated) => `Download list read from releases.json (updated ${updated}).`,
    rowsError: "Could not read releases.json.",
    stampError: "The build manifest could not be read, so no download is offered.",
    footerError: "Download manifest unavailable.",
    manifestError: (message) => `Could not read the build manifest (releases.json): ${message}. No download is offered without it.`,
  },
  es: {
    available: "Disponible",
    partly: "Disponible en parte",
    notBuilt: "Aún no compilado",
    checksumPending: "checksum pendiente",
    hashNotBuilt: "aún no compilado",
    unknownArch: "desconocida",
    bytes: "bytes",
    size: "Tamaño",
    version: "Versión",
    download: (size) => `Descargar ${size}`,
    noFileForPlatform: "Esta versión todavía no lista ningún archivo para esta plataforma.",
    noArtifacts: "La lista no incluye ningún archivo.",
    downloadLinux: "Descargar para Linux",
    linuxMeta: (kind, size) => `${kind} · ${size} · Linux de 64 bits`,
    linuxAlt: (url) => `¿Debian o Ubuntu? <a href="${url}" rel="noopener noreferrer">Descarga el .deb</a>`,
    windowsMeta: (size) => `Instalador · ${size} · Windows 10 u 11, 64 bits`,
    macMeta: (arch, size) => `Imagen de disco · ${arch} · ${size}`,
    macAlt: (other, url) => `¿Mac con ${other}? <a href="${url}" rel="noopener noreferrer">Descarga la versión para ${other}</a>`,
    unknownChannel: "desconocido",
    feedNoVersion:
      "El feed de actualizaciones no indica ninguna versión, así que una app instalada reportaría que no se pudo completar la revisión.",
    released: (when) => `, lanzada el <span class="num">${when}</span>`,
    published: (version, channel, when) =>
      `Publicada ahora: versión <span class="num">${version}</span> en el canal <code>${channel}</code>${when}.`,
    publishedHow: (url) =>
      `Una copia instalada anterior a esa ofrece <strong>Update and restart</strong> (actualizar y reiniciar), y la instala solo después de que digas que sí y de que su SHA-256 coincida. Las notas y todos los archivos están en <a href="${url}" rel="noopener noreferrer">la página de la versión</a>.`,
    noReleasePage: (version, when) =>
      `El feed indica la versión <span class="num">${version}</span> (lanzada el ${when}) pero no trae página de la versión, así que una app instalada reporta que no se pudo completar la revisión en lugar de ofrecer una actualización.`,
    nothingPublished: (version, channel) =>
      `Todavía no hay nada publicado: el feed indica la versión <span class="num">${version}</span> en el canal <code>${channel}</code>, sin fecha de lanzamiento y sin página de la versión. Por eso una copia instalada de la ${version} reporta <strong>que está al día en la ${version}</strong>, porque no existe nada más nuevo.`,
    feedError: (message) =>
      `No se pudo leer el feed de actualizaciones desde esta página (${message}). La lista de descargas de arriba no se ve afectada; la revisión de la app reporta sus propias fallas y nunca adivina una actualización.`,
    errorBadge: "desconocido",
    errorCard: "No se lista ninguna compilación porque no se pudo leer la lista. No se ofrece nada para descargar.",
    unknownDate: "desconocida",
    stamp: (product, version, updated, available, total) =>
      `Lista de compilaciones de ${product} ${version}, actualizada el ${updated}: ${available} de ${total} archivos disponibles.`,
    footer: (updated) => `Lista de descargas leída de releases.json (actualizada el ${updated}).`,
    rowsError: "No se pudo leer releases.json.",
    stampError: "No se pudo leer la lista de compilaciones, así que no se ofrece ninguna descarga.",
    footerError: "La lista de descargas no está disponible.",
    manifestError: (message) => `No se pudo leer la lista de compilaciones (releases.json): ${message}. Sin ella no se ofrece ninguna descarga.`,
  },
};

const t = () => TEXT[lang];
const fallback = () => (lang === "es" ? PLATFORM_FALLBACK_ES : PLATFORM_FALLBACK);
const numberLocale = () => (lang === "es" ? "es-419" : "en-US");

const EXTENSION = {
  installer: ".exe",
  portable: ".exe",
  dmg: ".dmg",
  zip: ".zip",
  msi: ".msi",
  appimage: ".AppImage",
  deb: ".deb",
};

/**
 * The cards to draw: every platform the manifest lists, then a "Not built yet" card for any
 * platform the page knows about that the manifest leaves out, so Linux has a place on the page
 * before its first build and needs no HTML change once releases.json lists it.
 */
export function platformsFor(manifest) {
  const listed = Array.isArray(manifest?.platforms) ? manifest.platforms : [];
  const ids = new Set(listed.map((platform) => platform?.id));
  const missing = Object.entries(fallback())
    .filter(([id]) => !ids.has(id))
    .map(([id, meta]) => ({ id, status: "not-built-yet", note: meta.pendingNote ?? "" }));
  return [...listed, ...missing];
}

/** HTML-escape a value for use in text or an attribute. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 1234567 -> "1.2 MB". Binary units, because that is what the release page reports. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
  return `${rounded} ${units[unit]}`;
}

/** "Apple silicon (arm64)" reads better than "arm64" on a macOS card. */
export function archLabel(platform, arch) {
  const value = String(arch ?? "");
  if (platform === "macos" && value === "arm64") return "Apple silicon (arm64)";
  if (platform === "macos" && value === "x64") return "Intel (x64)";
  if (value === "x64") return "x64";
  if (value === "arm64") return "arm64";
  return value || t().unknownArch;
}

export function kindLabel(kind) {
  const label = (lang === "es" ? KIND_LABEL_ES : KIND_LABEL)[kind] ?? String(kind ?? "file");
  const ext = EXTENSION[kind];
  return ext ? `${label} (${ext})` : label;
}

/** Empty checksum is a real state: the file exists but was not hashed. Say so. */
export function checksumText(entry) {
  const hash = String(entry?.sha256 ?? "").trim();
  if (hash !== "") return hash;
  // An empty hash means two different things. For a file that was never built, "pending"
  // would suggest a build is on its way; say the plain truth instead. For a file that
  // exists but has not been hashed yet, "checksum pending" is exactly right.
  return entry?.available === true ? t().checksumPending : t().hashNotBuilt;
}

/** A link is only safe when it is an absolute https URL and nothing else. */
export function isSafeUrl(url) {
  if (typeof url !== "string") return false;
  if (!/^https:\/\/[^\s<>"']+$/i.test(url)) return false;
  return !/[\u0000-\u001f]/.test(url);
}

/** The single gate between manifest data and an <a href>. */
export function isDownloadable(entry) {
  return Boolean(entry) && entry.available === true && isSafeUrl(entry.url) && typeof entry.fileName === "string" && entry.fileName !== "";
}

function statusOf(entry) {
  return isDownloadable(entry) ? { key: "available", label: t().available } : { key: "not-built-yet", label: t().notBuilt };
}

/**
 * One artifact row.
 * @returns {string} HTML for a <li>
 */
export function renderArtifact(entry) {
  const downloadable = isDownloadable(entry);
  const status = statusOf(entry);
  const size = downloadable ? `${formatBytes(entry.size)} (${Number(entry.size).toLocaleString(numberLocale())} ${t().bytes})` : "-";
  const hash = escapeHtml(checksumText(entry));
  const note = typeof entry.note === "string" ? manifestText(entry.note.trim()) : "";

  const action = downloadable
    ? `<div class="artifact-actions"><a class="btn btn-primary" href="${escapeHtml(entry.url)}" rel="noopener noreferrer">${escapeHtml(t().download(formatBytes(entry.size)))}</a></div>`
    : "";

  return [
    `<li class="artifact" data-available="${downloadable ? "true" : "false"}" data-artifact-id="${escapeHtml(entry.id)}">`,
    `  <div class="artifact-head">`,
    `    <span class="artifact-kind">${escapeHtml(kindLabel(entry.kind, entry.fileName))}</span>`,
    `    <span class="badge" data-status="${status.key}">${escapeHtml(status.label)}</span>`,
    `  </div>`,
    `  <div class="artifact-file">${escapeHtml(entry.fileName)}</div>`,
    `  <dl class="artifact-meta">`,
    `    <dt>${t().size}</dt><dd>${escapeHtml(size)}</dd>`,
    `    <dt>${t().version}</dt><dd>${escapeHtml(entry.version ?? "")}</dd>`,
    `    <dt>SHA-256</dt><dd><span class="hash">${hash}</span></dd>`,
    `  </dl>`,
    note ? `  <p class="note">${escapeHtml(note)}</p>` : "",
    action ? `  ${action}` : "",
    `</li>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** One platform card. */
export function renderPlatform(platform, artifacts) {
  const meta = fallback()[platform.id] ?? { label: platform.id, requirement: "" };
  const label = platform.label ? manifestText(platform.label) : meta.label;
  const requirement = platform.requirement ? manifestText(platform.requirement) : meta.requirement;
  const status = platform.status ?? (artifacts.some(isDownloadable) ? "available" : "not-built-yet");
  const statusText =
    status === "available" ? t().available : status === "partial" ? t().partly : t().notBuilt;
  const own = artifacts.filter((entry) => entry.platform === platform.id);
  const list =
    own.length > 0
      ? own.map(renderArtifact).join("\n")
      : `<li class="artifact-empty">${t().noFileForPlatform}</li>`;
  // A platform-level note says something about every file on the card at once - today, that
  // the build is unsigned, so the note says what the first launch looks like - so it is
  // rendered once, above the rows, and not repeated under each of them.
  const platformNote = typeof platform.note === "string" ? manifestText(platform.note.trim()) : "";

  return [
    `<div class="card" data-platform="${escapeHtml(platform.id)}">`,
    `  <h3>${escapeHtml(label)} <span class="badge" data-status="${escapeHtml(status)}">${escapeHtml(statusText)}</span></h3>`,
    `  <p>${escapeHtml(requirement)}</p>`,
    platformNote ? `  <p class="note platform-note">${escapeHtml(platformNote)}</p>` : "",
    `  <ul class="artifacts">`,
    list,
    `  </ul>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The flat table: every artifact, with its checksum, one row each. */
export function renderRows(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return `<tr><td colspan="7" class="none">${t().noArtifacts}</td></tr>`;
  }
  return artifacts
    .map((entry) => {
      const downloadable = isDownloadable(entry);
      const platform = fallback()[entry.platform]?.label ?? entry.platform ?? "";
      const file = downloadable
        ? `<a href="${escapeHtml(entry.url)}" rel="noopener noreferrer">${escapeHtml(entry.fileName)}</a>`
        : `<span class="hash">${escapeHtml(entry.fileName)}</span>`;
      const size = downloadable
        ? `${escapeHtml(formatBytes(entry.size))}<br><small>${Number(entry.size).toLocaleString(numberLocale())} ${t().bytes}</small>`
        : `<span class="none">-</span>`;
      const hash = `<span class="${downloadable ? "hash" : "none"}">${escapeHtml(checksumText(entry))}</span>`;
      const status = downloadable
        ? `<span class="badge" data-status="available">${t().available}</span>`
        : `<span class="badge" data-status="not-built-yet">${t().notBuilt}</span>`;
      return [
        `<tr data-available="${downloadable ? "true" : "false"}">`,
        `<td>${escapeHtml(platform)}</td>`,
        `<td>${escapeHtml(archLabel(entry.platform, entry.arch))}</td>`,
        `<td>${file}</td>`,
        `<td>${size}</td>`,
        `<td>${escapeHtml(entry.version ?? "")}</td>`,
        `<td>${hash}</td>`,
        `<td>${status}</td>`,
        `</tr>`,
      ].join("");
    })
    .join("\n");
}

// ------------------------------------------------------------ the one-click buttons
//
// Two buttons in the hero, one per platform, each pointing at the easiest file to install:
// the Setup installer on Windows (installs once, Start menu entry, updates itself; the
// portable .exe cannot run an installer-based update), and the disk image on macOS for the
// visitor's kind of Mac. Same gate as every other link: only an entry isDownloadable()
// accepts becomes an href. Until then the buttons point at #downloads.

/**
 * Which file each hero button gets.
 * @param {object[]} artifacts
 * @param {{ macArch?: "arm64" | "x64" }} [options]
 */
export function quickPick(artifacts, { macArch = "arm64" } = {}) {
  const list = Array.isArray(artifacts) ? artifacts.filter(isDownloadable) : [];
  const find = (test) => list.find(test) ?? null;
  const arch = macArch === "x64" ? "x64" : "arm64";
  const otherArch = arch === "x64" ? "arm64" : "x64";
  const dmg = (want) => find((entry) => entry.platform === "macos" && entry.kind === "dmg" && entry.arch === want);
  // Linux: the AppImage first (any distribution, and it updates itself from inside the app),
  // with the .deb offered under it for Debian and Ubuntu.
  const appImage = find((entry) => entry.platform === "linux" && entry.kind === "appimage");
  const deb = find((entry) => entry.platform === "linux" && entry.kind === "deb");
  return {
    windows: find((entry) => entry.platform === "windows" && entry.kind === "installer") ?? find((entry) => entry.platform === "windows"),
    mac: dmg(arch) ?? dmg(otherArch),
    macOther: dmg(arch) ? dmg(otherArch) : null,
    linux: appImage ?? deb,
    linuxOther: appImage ? deb : null,
  };
}

/** "windows" | "macos" | "linux" | "other", from the browser's own report. */
export function detectOs(nav = globalThis.navigator) {
  const platform = String(nav?.userAgentData?.platform ?? nav?.platform ?? "");
  const ua = String(nav?.userAgent ?? "");
  // iPhones and iPads say "Mac" in some fields, Android says "Linux", and a Chromebook says
  // "Linux" too; none of them can run these builds.
  if (/iPhone|iPad|iPod|Android|CrOS/i.test(ua) || /Android|Chrome OS/i.test(platform)) return "other";
  if (/^Win/i.test(platform) || /Windows NT/i.test(ua)) return "windows";
  if (/^Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux/i.test(platform) || /Linux|X11/i.test(ua)) return "linux";
  return "other";
}

/** A GPU name -> "arm64" | "x64" | null. "Apple M1".."Apple M5" is Apple silicon. */
export function macArchFromRenderer(renderer) {
  const name = String(renderer ?? "");
  if (/Apple M\d/i.test(name)) return "arm64";
  if (/Intel|AMD|Radeon|NVIDIA|GeForce/i.test(name)) return "x64";
  return null;
}

/**
 * Which Mac this is, as well as the browser will say. Chrome and Edge answer directly;
 * Firefox usually names the GPU; Safari hides both, so it falls back to Apple silicon,
 * which is what every Mac sold since 2020 has. The other build is always one link away.
 */
async function detectMacArch(nav = globalThis.navigator, doc = globalThis.document) {
  try {
    const values = await nav?.userAgentData?.getHighEntropyValues?.(["architecture"]);
    if (values?.architecture === "arm") return "arm64";
    if (values?.architecture === "x86") return "x64";
  } catch {
    /* not offered: try the GPU name */
  }
  try {
    const gl = doc?.createElement?.("canvas")?.getContext?.("webgl");
    const info = gl?.getExtension?.("WEBGL_debug_renderer_info");
    const fromGpu = info ? macArchFromRenderer(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
    if (fromGpu) return fromGpu;
  } catch {
    /* no WebGL */
  }
  return "arm64";
}

const MAC_ARCH_NAME = { arm64: "Apple silicon", x64: "Intel" };

/** Point the hero buttons at real files. Browser only; leaves #downloads in place on any failure. */
export async function mountQuick(manifest, doc = document, nav = globalThis.navigator) {
  const os = detectOs(nav);
  const macArch = os === "macos" ? await detectMacArch(nav, doc) : "arm64";
  const pick = quickPick(manifest?.artifacts, { macArch });

  const winButton = doc.getElementById("quick-windows");
  const macButton = doc.getElementById("quick-mac");
  const linuxButton = doc.getElementById("quick-linux");
  // The visitor's own platform is the bright button and comes first; Windows when it is none
  // of them, and also on Linux until a Linux file exists (a bright "not built yet" helps nobody).
  const own = os === "macos" ? macButton : os === "linux" && pick.linux ? linuxButton : winButton;
  for (const button of [winButton, macButton, linuxButton]) {
    if (!button) continue;
    button.classList.toggle("btn-primary", button === own);
    button.classList.toggle("btn-secondary", button !== own);
  }
  const ownBlock = own === winButton ? null : own?.closest(".quick");
  if (ownBlock) doc.getElementById("quick-downloads")?.prepend(ownBlock);

  if (pick.linux && linuxButton) {
    linuxButton.href = pick.linux.url;
    linuxButton.rel = "noopener noreferrer";
    linuxButton.textContent = t().downloadLinux;
    linuxButton.removeAttribute("data-pending");
    const meta = doc.getElementById("quick-linux-meta");
    const kind = (lang === "es" ? KIND_LABEL_ES : KIND_LABEL)[pick.linux.kind === "deb" ? "deb" : "appimage"];
    if (meta) meta.textContent = t().linuxMeta(kind, formatBytes(pick.linux.size));
    const alt = doc.getElementById("quick-linux-alt");
    if (alt && pick.linuxOther) {
      alt.innerHTML = t().linuxAlt(escapeHtml(pick.linuxOther.url));
    }
  }

  if (pick.windows && winButton) {
    winButton.href = pick.windows.url;
    winButton.rel = "noopener noreferrer";
    const meta = doc.getElementById("quick-windows-meta");
    if (meta) meta.textContent = t().windowsMeta(formatBytes(pick.windows.size));
  }
  if (pick.mac && macButton) {
    macButton.href = pick.mac.url;
    macButton.rel = "noopener noreferrer";
    const meta = doc.getElementById("quick-mac-meta");
    if (meta) meta.textContent = t().macMeta(MAC_ARCH_NAME[pick.mac.arch] ?? pick.mac.arch, formatBytes(pick.mac.size));
    const alt = doc.getElementById("quick-mac-alt");
    if (alt && pick.macOther) {
      const other = MAC_ARCH_NAME[pick.macOther.arch] ?? pick.macOther.arch;
      alt.innerHTML = t().macAlt(escapeHtml(other), escapeHtml(pick.macOther.url));
    }
  }
  return pick;
}

/** Shape checks. Returns human-readable problems; empty array means usable. */
export function validateManifest(manifest) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") {
    problems.push("releases.json is not an object");
    return problems;
  }
  if (!Array.isArray(manifest.artifacts)) problems.push("releases.json has no artifacts array");
  if (!Array.isArray(manifest.platforms)) problems.push("releases.json has no platforms array");
  if (Array.isArray(manifest.artifacts)) {
    for (const entry of manifest.artifacts) {
      if (typeof entry?.id !== "string" || typeof entry?.fileName !== "string") {
        problems.push("an artifact is missing id or fileName");
        continue;
      }
      if (entry.available === true && !isDownloadable(entry)) {
        problems.push(`${entry.id} is marked available but has no safe https url`);
      }
      if (entry.available !== true && entry.url) {
        problems.push(`${entry.id} is not available but carries a url`);
      }
      const hash = String(entry.sha256 ?? "");
      if (hash !== "" && !/^[0-9a-f]{64}$/.test(hash)) {
        problems.push(`${entry.id} has a malformed sha256`);
      }
    }
  }
  return problems;
}

/** Fetch and parse the manifest that sits next to this module. */
export async function loadManifest(fetchImpl = globalThis.fetch, url = new URL("releases.json", import.meta.url)) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch available");
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`releases.json returned HTTP ${response.status}`);
  const manifest = await response.json();
  const problems = validateManifest(manifest);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return manifest;
}

// ------------------------------------------------------------------ the update feed
//
// The same rule as the download list, for the same reason: the page may describe what the
// installed app will do, and it may describe the published version, but it may not turn
// the update feed into a download. updates.json names a version and a release *page*;
// nothing here links to a file, and nothing here offers to install anything.

/** Fetch and parse the update feed that sits next to this module. */
export async function loadUpdates(fetchImpl = globalThis.fetch, url = new URL("updates.json", import.meta.url)) {
  if (typeof fetchImpl !== "function") throw new Error("no fetch available");
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`updates.json returned HTTP ${response.status}`);
  const manifest = await response.json();
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("updates.json is not an object");
  }
  if (manifest.schema !== 1) throw new Error(`updates.json schema is ${manifest.schema}, expected 1`);
  return manifest;
}

/**
 * One short block describing what the feed says today, as HTML.
 *
 * Pure string building, so site/test/updates.test.mjs can check every branch without a
 * DOM. The link to the release page is validated with the same `isSafeUrl` the download
 * list uses: an update notice is only allowed to point at an https page, and the feed's
 * url is only ever shown as a link - never fetched, never installed.
 */
export function renderUpdatesNotice(manifest) {
  const version = typeof manifest?.version === "string" ? manifest.version.trim() : "";
  const channel = typeof manifest?.channel === "string" && manifest.channel.trim() !== "" ? manifest.channel.trim() : t().unknownChannel;
  const releasedAt = typeof manifest?.releasedAt === "string" ? manifest.releasedAt.trim() : "";
  const url = isSafeUrl(manifest?.url) ? String(manifest.url) : "";

  if (version === "") {
    return `<p class="updates-status" data-updates-state="unreadable">${t().feedNoVersion}</p>`;
  }
  if (url !== "") {
    const when = releasedAt === "" ? "" : t().released(escapeHtml(releasedAt));
    return [
      `<p class="updates-status" data-updates-state="available">${t().published(escapeHtml(version), escapeHtml(channel), when)}</p>`,
      `<p>${t().publishedHow(escapeHtml(url))}</p>`,
    ].join("\n");
  }
  if (releasedAt !== "") {
    return `<p class="updates-status" data-updates-state="unknown">${t().noReleasePage(escapeHtml(version), escapeHtml(releasedAt))}</p>`;
  }
  return `<p class="updates-status" data-updates-state="none">${t().nothingPublished(escapeHtml(version), escapeHtml(channel))}</p>`;
}

/** Read the update feed and fill the notice. Browser only; a failure is written down, not thrown. */
export async function mountUpdates(doc = document, fetchImpl = globalThis.fetch) {
  const noticeEl = doc.getElementById("updates-status");
  if (!noticeEl) return null;
  try {
    const manifest = await loadUpdates(fetchImpl);
    noticeEl.innerHTML = renderUpdatesNotice(manifest);
    return manifest;
  } catch (error) {
    noticeEl.innerHTML = `<p class="updates-status" data-updates-state="error">${t().feedError(escapeHtml(error.message))}</p>`;
    return null;
  }
}

function errorCards() {
  return Object.entries(fallback())
    .map(
      ([id, meta]) =>
        `<div class="card" data-platform="${id}"><h3>${escapeHtml(meta.label)} <span class="badge" data-status="loading">${t().errorBadge}</span></h3><p>${t().errorCard}</p></div>`,
    )
    .join("\n");
}

/** Read the manifest and fill the page. Browser only. */
export async function mount(doc = document, fetchImpl = globalThis.fetch) {
  const platformsEl = doc.getElementById("platforms");
  const rowsEl = doc.getElementById("artifact-rows");
  const stampEl = doc.getElementById("manifest-stamp");
  const footerEl = doc.getElementById("footer-stamp");
  const errorEl = doc.getElementById("manifest-error");

  try {
    const manifest = await loadManifest(fetchImpl);
    const platforms = platformsFor(manifest);

    if (platformsEl) {
      platformsEl.dataset.state = "ready";
      platformsEl.innerHTML = platforms.map((platform) => renderPlatform(platform, manifest.artifacts)).join("\n");
    }
    if (rowsEl) rowsEl.innerHTML = renderRows(manifest.artifacts);
    if (stampEl) {
      const available = manifest.artifacts.filter(isDownloadable).length;
      stampEl.textContent = t().stamp(manifest.product ?? "Rosalena Harness", manifest.version ?? "", manifest.updated ?? t().unknownDate, available, manifest.artifacts.length);
    }
    if (footerEl) footerEl.textContent = t().footer(manifest.updated ?? t().unknownDate);
    if (errorEl) errorEl.hidden = true;
    // The hero buttons are a convenience on top of the list: if this fails they keep
    // pointing at #downloads, and the list above is already rendered.
    await mountQuick(manifest, doc).catch((error) => console.error("download page could not set the quick buttons", error));
    return manifest;
  } catch (error) {
    if (platformsEl) {
      platformsEl.dataset.state = "error";
      platformsEl.innerHTML = errorCards();
    }
    if (rowsEl) rowsEl.innerHTML = `<tr><td colspan="7" class="none">${t().rowsError}</td></tr>`;
    if (stampEl) stampEl.textContent = t().stampError;
    if (footerEl) footerEl.textContent = t().footerError;
    if (errorEl) {
      errorEl.hidden = false;
      errorEl.textContent = t().manifestError(error.message);
    }
    return null;
  }
}

if (typeof document !== "undefined") {
  const start = () => {
    mount().catch((error) => {
      console.error("download page failed to mount", error);
    });
    // A separate call on purpose: an unreadable update feed must not be able to take the
    // download list down with it, and the download list is the reason this page exists.
    mountUpdates().catch((error) => {
      console.error("download page could not read the update feed", error);
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
