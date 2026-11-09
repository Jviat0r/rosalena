/**
 * The update check: is a newer version published than the one running here?
 *
 * The app knows its own version from `package.json`, asks one small JSON manifest on
 * the site what the newest published version is, and compares the two. That is the
 * whole feature. Three answers exist and no fourth:
 *
 *   "current"    you are up to date (or newer than what is published)
 *   "available"  a newer version exists, and the manifest names a release page
 *   "unknown"    the check could not be completed, and here is why
 *
 * Installing is not this module's job. The desktop shell (desktop/updater.mjs) asks the
 * person first, then uses `pickUpdateAsset` below to name the one file for this platform,
 * downloads it, refuses it unless its SHA-256 matches the feed's `artifacts` entry, and
 * only then installs it and reopens the app. This module stays pure: it decides, it never
 * downloads or touches the disk.
 *
 * What this module never does, on purpose:
 *
 *   - it never claims an update it cannot point at. A manifest whose version is newer
 *     but whose `url` is "" is `unknown`, not `available` - "there is a new version but
 *     I cannot show you where" is a reason, not an update.
 *   - it never sends anything that could identify a person or an install. The request
 *     carries exactly one header, `accept: application/json`, and the feed URL is used
 *     byte-for-byte as given: the module appends no query string, no cache buster, no
 *     install id, no platform, no version. The server sees a URL and a header any
 *     anonymous visitor would send. (A caller may pass a URL that already has a query;
 *     the default `UPDATE_FEED_URL` has none.)
 *
 * Zero dependencies, node builtins only, no work at import time. Every function that
 * decides something is pure and takes `now`/`fetchImpl` as an option, so the tests never
 * touch the network and never depend on the clock.
 */

import { Buffer } from "node:buffer";

/** Where the published manifest lives. Pass `url` to override it; nothing reads env vars. */
export const UPDATE_FEED_URL = "https://rosalena.pages.dev/download/updates.json";

/** At most one check per six hours unless the person asks for one. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A check that has not answered in five seconds is a failed check, not a slow one. */
export const TIMEOUT_MS = 5000;

/** A manifest is a few hundred bytes; 256 KiB is already a red flag. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Notes are shown in the app; a wall of text is not notes. */
export const MAX_NOTES_CHARS = 2000;

/**
 * Hosts a release link may point at. The manifest's `url` is rendered as a link in the
 * app, so it is checked against this list rather than trusted: `javascript:`, `data:`,
 * `file:` and plain `http:` are refused outright, and so is any https host not here.
 */
export const ALLOWED_URL_HOSTS = Object.freeze(["rosalena.pages.dev", "github.com"]);

// ---------------------------------------------------------------------------- versions

/**
 * MAJOR.MINOR.PATCH, an optional `v` prefix, an optional prerelease and optional build
 * metadata. Each prerelease/build part is dot-separated identifiers of [0-9A-Za-z-].
 */
const VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const NUMERIC_ID = /^\d+$/;

/**
 * "1.2.3", "v1.2.3", "1.2.3-beta.2", "1.2.3+build.7" -> parts; anything else -> null.
 *
 * Build metadata is accepted and then dropped: semver says it does not participate in
 * precedence, and a comparator that quietly used it would order two builds of the same
 * version as different versions.
 *
 * @param {unknown} text
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] } | null}
 */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = VERSION_RE.exec(text.trim());
  if (!match) return null;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  // Semver forbids leading zeros: "01.2.3" is a different string, not version 1.2.3.
  for (const part of [major, minor, patch]) {
    if (part.length > 1 && part[0] === "0") return null;
  }
  const prerelease = match[4] ? match[4].split(".") : [];
  for (const identifier of prerelease) {
    if (NUMERIC_ID.test(identifier) && identifier.length > 1 && identifier[0] === "0") return null;
  }
  return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

/** The canonical spelling of a parsed version, without build metadata. */
export function formatVersion(parsed) {
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease?.length ? `${base}-${parsed.prerelease.join(".")}` : base;
}

/** A parsed version object, a version string, or null. */
function asParsed(value) {
  if (
    value &&
    typeof value === "object" &&
    Number.isInteger(value.major) &&
    Number.isInteger(value.minor) &&
    Number.isInteger(value.patch)
  ) {
    return {
      major: value.major,
      minor: value.minor,
      patch: value.patch,
      prerelease: Array.isArray(value.prerelease) ? value.prerelease.map(String) : [],
    };
  }
  if (typeof value === "string") return parseVersion(value);
  return null;
}

/**
 * Semver precedence: -1 when `a` sorts below `b`, 1 when it sorts above, 0 when equal.
 *
 * A release sorts above its own prereleases (`1.0.0 > 1.0.0-beta`), a numeric identifier
 * sorts below an alphanumeric one, and a longer prerelease sharing a prefix sorts higher
 * (`1.0.0-alpha < 1.0.0-alpha.1`). Build metadata is ignored.
 *
 * Throws a TypeError for a value that is not a version, because a caller that compares
 * garbage is asking a question with no answer - and silently answering 0 would let a
 * broken version string look "up to date".
 *
 * @param {string | { major: number, minor: number, patch: number, prerelease?: string[] }} a
 * @param {string | { major: number, minor: number, patch: number, prerelease?: string[] }} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const left = asParsed(a);
  const right = asParsed(b);
  if (!left) throw new TypeError(`compareVersions: ${JSON.stringify(a)} is not a version`);
  if (!right) throw new TypeError(`compareVersions: ${JSON.stringify(b)} is not a version`);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function comparePrerelease(a, b) {
  // No prerelease means this *is* the release, which sorts above every prerelease.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareIdentifier(a[index], b[index]);
    if (order !== 0) return order;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

function compareIdentifier(a, b) {
  const aNumeric = NUMERIC_ID.test(a);
  const bNumeric = NUMERIC_ID.test(b);
  if (aNumeric && bNumeric) {
    // Longer digit strings are bigger numbers; comparing the strings avoids losing
    // precision on an identifier longer than a double can hold exactly.
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The version out of a parsed package.json (or its text), normalized, or null.
 *
 * Normalized means the same spelling `decideUpdate` reports: `v1.2.3+build.7` becomes
 * `1.2.3`, so the version this app prints and the version it compares are one string.
 *
 * @param {unknown} json
 * @returns {string | null}
 */
export function readVersionFromPackage(json) {
  let pkg = json;
  if (typeof pkg === "string") {
    try {
      pkg = JSON.parse(pkg);
    } catch {
      return null;
    }
  }
  if (!pkg || typeof pkg !== "object") return null;
  const parsed = parseVersion(pkg.version);
  return parsed ? formatVersion(parsed) : null;
}

// ---------------------------------------------------------------------------- manifest

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Why this release URL would not be safe to render as a link, or null when it is fine.
 * @returns {string | null}
 */
function releaseUrlProblem(url) {
  if (/[\u0000-\u001f\u007f]/.test(url)) return `url ${JSON.stringify(url)} carries control characters`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `url ${JSON.stringify(url)} is not a URL`;
  }
  if (parsed.protocol !== "https:") {
    return `url ${JSON.stringify(url)} is not https, so it would never be rendered as a link`;
  }
  if (parsed.username || parsed.password) return `url ${JSON.stringify(url)} carries credentials`;
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_URL_HOSTS.includes(host)) {
    return `url host ${JSON.stringify(host)} is not one of ${ALLOWED_URL_HOSTS.join(", ")}`;
  }
  return null;
}

/**
 * Check one published manifest and hand back the cleaned shape, or say why not.
 *
 * Rules, in the order they are enforced: schema must be 1; version must be semver;
 * channel must be a short non-empty name; releasedAt must be null or an ISO date that is
 * not in the future; notes must be a string and are truncated to 2000 characters; url
 * must be "" or an allowlisted https URL; artifacts, when present, must be a plain
 * object whose values are strings. Unknown keys are ignored rather than fatal, so the
 * manifest can grow a field without breaking every installed copy of the app.
 *
 * @param {unknown} value
 * @param {{ now?: number }} [options]
 * @returns {{ ok: true, manifest: { schema: 1, channel: string, version: string, releasedAt: string | null, notes: string, url: string, artifacts: Record<string, string> } } | { ok: false, reason: string }}
 */
export function validateUpdateManifest(value, { now = Date.now() } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isPlainObject(value)) return fail("the update manifest is not a JSON object");

  if (value.schema !== 1) {
    return fail(`schema is ${JSON.stringify(value.schema)}, expected 1`);
  }

  const parsed = parseVersion(value.version);
  if (!parsed) {
    return fail(`version ${JSON.stringify(value.version)} is not a valid version (expected MAJOR.MINOR.PATCH)`);
  }

  const channel = typeof value.channel === "string" ? value.channel.trim() : "";
  if (channel === "" || channel.length > 40) {
    return fail(`channel ${JSON.stringify(value.channel)} is not a short non-empty name`);
  }

  const releasedAt = value.releasedAt ?? null;
  if (releasedAt !== null) {
    if (typeof releasedAt !== "string") return fail("releasedAt must be null or an ISO date string");
    if (!ISO_DATE_RE.test(releasedAt)) return fail(`releasedAt ${JSON.stringify(releasedAt)} is not an ISO date string`);
    const when = Date.parse(releasedAt);
    if (!Number.isFinite(when)) return fail(`releasedAt ${JSON.stringify(releasedAt)} is not a date I can read`);
    if (when > now) return fail(`releasedAt ${releasedAt} is in the future, so this manifest cannot be trusted`);
  }

  const rawNotes = value.notes ?? "";
  if (typeof rawNotes !== "string") return fail("notes must be a string");
  const notes = rawNotes.slice(0, MAX_NOTES_CHARS);

  const rawUrl = value.url ?? "";
  if (typeof rawUrl !== "string") return fail("url must be a string");
  const url = rawUrl.trim();
  if (url !== "") {
    const problem = releaseUrlProblem(url);
    if (problem) return fail(problem);
  }

  let artifacts = {};
  if (value.artifacts !== undefined && value.artifacts !== null) {
    if (!isPlainObject(value.artifacts)) return fail("artifacts must be a plain object of file name to string");
    for (const [name, entry] of Object.entries(value.artifacts)) {
      if (typeof entry !== "string") return fail(`artifacts[${JSON.stringify(name)}] is not a string`);
    }
    artifacts = { ...value.artifacts };
  }

  return {
    ok: true,
    manifest: { schema: 1, channel, version: formatVersion(parsed), releasedAt, notes, url, artifacts },
  };
}

// ------------------------------------------------------------------------------ decide

/**
 * The three-state answer the app shows.
 *
 * "available" requires both halves: a strictly newer manifest version *and* a release
 * page to open. A newer version with an empty url is "unknown" with a reason, because an
 * update notice the user cannot act on is worse than an honest failure. A manifest older
 * than the running version is "current": you are ahead of the published one, which is a
 * real state during a rollback or a local build.
 *
 * @param {{ current?: unknown, manifest?: unknown, now?: number }} [input]
 * @returns {{ state: "current" | "available" | "unknown", current: string | null, latest: string | null, url: string, notes: string, releasedAt: string | null, reason: string }}
 */
export function decideUpdate({ current, manifest, now = Date.now() } = {}) {
  const empty = { current: null, latest: null, url: "", notes: "", releasedAt: null };

  const parsedCurrent = asParsed(current);
  if (!parsedCurrent) {
    return {
      state: "unknown",
      ...empty,
      reason: `this app's own version ${JSON.stringify(current ?? null)} is not a version, so there is nothing to compare`,
    };
  }
  const currentText = formatVersion(parsedCurrent);

  const checked = validateUpdateManifest(manifest, { now });
  if (!checked.ok) {
    return { state: "unknown", ...empty, current: currentText, reason: `the update manifest cannot be used: ${checked.reason}` };
  }

  const latest = checked.manifest;
  const fields = {
    current: currentText,
    latest: latest.version,
    url: latest.url,
    notes: latest.notes,
    releasedAt: latest.releasedAt,
  };

  const order = compareVersions(parsedCurrent, latest.version);
  if (order > 0) {
    return { state: "current", ...fields, reason: `you are on ${currentText}, newer than the published ${latest.version}` };
  }
  if (order === 0) {
    return { state: "current", ...fields, reason: `you are up to date at ${currentText}` };
  }
  if (latest.url === "") {
    return {
      state: "unknown",
      ...fields,
      reason: `${latest.version} is published but the manifest carries no release page, so there is nothing to open`,
    };
  }
  return { state: "available", ...fields, reason: `${latest.version} is available (released ${latest.releasedAt ?? "at an unrecorded time"})` };
}

// ------------------------------------------------------------------------------ assets

const SHA256_RE = /^[0-9a-f]{64}$/;
const RELEASE_TAG_RE = /^\/([^/]+)\/([^/]+)\/releases\/tag\/([^/]+)\/?$/;

/**
 * The direct download URL for one file of a GitHub release, from the release page URL.
 *
 * `https://github.com/<owner>/<repo>/releases/tag/<tag>` becomes
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`. Anything that is not
 * a github.com release page gives null: the feed carries a page, and only a page this
 * function recognises can be turned into a file address.
 *
 * @param {string} releaseUrl
 * @param {string} fileName
 * @returns {string | null}
 */
export function releaseDownloadUrl(releaseUrl, fileName) {
  if (typeof releaseUrl !== "string" || typeof fileName !== "string" || fileName === "") return null;
  if (/[\\/]/.test(fileName) || fileName.startsWith(".")) return null;
  let parsed;
  try {
    parsed = new URL(releaseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  const match = RELEASE_TAG_RE.exec(parsed.pathname);
  if (!match) return null;
  const [, owner, repo, tag] = match;
  return `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(fileName)}`;
}

/**
 * The file name the release pipeline gives each platform's update, for one version.
 * These are the `artifactName` patterns in packaging/release/electron-builder.*.yml.
 *
 *   Windows, installed  Rosalena-Harness-Setup-<v>-x64.exe   (the NSIS installer, run silently)
 *   Windows, portable   Rosalena-Harness-<v>-x64-portable.exe (swapped in place of the old file)
 *   macOS               Rosalena-Harness-<v>-<arm64|x64>.zip  (the .app inside replaces the old one)
 *   Linux, AppImage     Rosalena-Harness-<v>-x86_64.AppImage  (swapped in place of the running file)
 *   Linux, .deb         Rosalena-Harness-<v>-amd64.deb        (not self-installed: see selfInstallable)
 *
 * `appImage` is true when this copy runs from an AppImage (the AppImage runtime sets
 * $APPIMAGE); any other packaged Linux copy came from the .deb.
 *
 * @returns {{ fileName: string, kind: "nsis" | "portable" | "mac-zip" | "appimage" | "deb" } | null}
 */
export function updateFileName({ version, platform, arch, portable = false, appImage = false }) {
  if (typeof version !== "string" || !parseVersion(version)) return null;
  if (platform === "win32") {
    if (arch !== "x64") return null;
    return portable
      ? { fileName: `Rosalena-Harness-${version}-x64-portable.exe`, kind: "portable" }
      : { fileName: `Rosalena-Harness-Setup-${version}-x64.exe`, kind: "nsis" };
  }
  if (platform === "darwin") {
    if (arch !== "arm64" && arch !== "x64") return null;
    return { fileName: `Rosalena-Harness-${version}-${arch}.zip`, kind: "mac-zip" };
  }
  if (platform === "linux") {
    if (arch !== "x64") return null;
    return appImage
      ? { fileName: `Rosalena-Harness-${version}-x86_64.AppImage`, kind: "appimage" }
      : { fileName: `Rosalena-Harness-${version}-amd64.deb`, kind: "deb" };
  }
  return null;
}

/** The site's download page: where a copy that cannot replace itself sends the person. */
export const DOWNLOAD_PAGE_URL = "https://rosalena.pages.dev/download/";

/**
 * Whether the app can install this kind of update by itself.
 *
 * A .deb lives in /opt, owned by root and by the package manager: replacing it from inside
 * the app would need root and would leave dpkg describing files that are no longer there.
 * So a .deb copy is told where the next .deb is, and the person installs it with apt.
 *
 * @param {string} kind
 * @returns {boolean}
 */
export function selfInstallable(kind) {
  return kind === "nsis" || kind === "portable" || kind === "mac-zip" || kind === "appimage";
}

/**
 * What the update dialog says to a copy that cannot install `kind` by itself, or "" when it can.
 *
 * @param {string} kind
 * @param {string} [fileName]
 * @returns {string}
 */
export function manualUpdateReason(kind, fileName = "") {
  if (kind === "deb") {
    const file = fileName ? `./${fileName}` : "./<the .deb file>";
    return `This copy was installed from a .deb package, so the package manager updates it, not the app. Download the new .deb from the download page and install it with: sudo apt install ${file}`;
  }
  return "";
}

/**
 * The script that puts a downloaded AppImage in place of the running one and restarts it.
 *
 * Linux lets a running file be replaced (the old inode stays mapped until this process
 * exits), but the single-instance lock does not let the new copy start until this one has
 * quit, so the script waits for this process first. The copy goes to "<target>.new" beside
 * the target and is renamed over it: a rename inside one folder is atomic, so a crash
 * halfway leaves the old AppImage intact rather than half a file. The download sits in the
 * temp folder, which is often a different filesystem, which is why it is copied, not moved.
 *
 * Every path travels in an environment variable (RU_PID, RU_SOURCE, RU_TARGET), never in
 * the script text, so a folder name cannot change what the script does. The AppImage
 * runtime's own variables are cleared before the relaunch: they name the old copy's mount,
 * which is gone by then, and the new copy's runtime sets them afresh.
 *
 * @returns {string}
 */
export function appImageSwapScript() {
  return [
    "#!/bin/sh",
    'while kill -0 "$RU_PID" 2>/dev/null; do sleep 0.5; done',
    'if cp -f "$RU_SOURCE" "$RU_TARGET.new" && chmod 755 "$RU_TARGET.new" && mv -f "$RU_TARGET.new" "$RU_TARGET"; then',
    '  rm -f "$RU_SOURCE"',
    "else",
    '  rm -f "$RU_TARGET.new"',
    "fi",
    "unset APPIMAGE APPDIR ARGV0 OWD",
    'nohup "$RU_TARGET" >/dev/null 2>&1 &',
    "",
  ].join("\n");
}

/**
 * Which file this copy of the app should download to update itself, or why there is none.
 *
 * The answer always carries the SHA-256 the feed published for that file: the caller must
 * refuse the download unless the bytes it received hash to exactly this value. A feed that
 * names a release but carries no checksum for this platform's file is not an installable
 * update, and says so.
 *
 * @param {{ manifest: object, platform: string, arch: string, portable?: boolean, appImage?: boolean }} input
 * @returns {{ ok: true, fileName: string, kind: string, url: string, sha256: string } | { ok: false, reason: string }}
 */
export function pickUpdateAsset({ manifest, platform, arch, portable = false, appImage = false } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  const checked = validateUpdateManifest(manifest);
  if (!checked.ok) return fail(checked.reason);
  const { version, url, artifacts } = checked.manifest;
  const named = updateFileName({ version, platform, arch, portable, appImage });
  if (!named) return fail(`there is no ${platform}/${arch} build to update to`);
  const sha256 = String(artifacts[named.fileName] ?? "").trim().toLowerCase();
  if (!SHA256_RE.test(sha256)) return fail(`the feed carries no checksum for ${named.fileName}, so it cannot be verified`);
  const download = releaseDownloadUrl(url, named.fileName);
  if (!download) return fail(`the release page ${JSON.stringify(url)} is not a GitHub release, so there is no file address`);
  return { ok: true, fileName: named.fileName, kind: named.kind, url: download, sha256 };
}

// ------------------------------------------------------------------------------ timing

/** An epoch-ms number, a Date, or a parseable date string -> epoch ms; anything else -> null. */
function toTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const at = value.getTime();
    return Number.isFinite(at) ? at : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

/**
 * Should a check run now?
 *
 * Missing or unreadable timestamps return true: a check is cheap, and refusing to check
 * because a state file is corrupt is how an app stays silently out of date. A timestamp
 * in the future is not trusted either (a clock that moved backwards would otherwise
 * suppress updates for as long as the skew lasts), so it also returns true.
 *
 * @param {{ lastCheckedAt?: unknown, now?: number, minIntervalMs?: number }} [input]
 * @returns {boolean}
 */
export function shouldCheck({ lastCheckedAt = null, now = Date.now(), minIntervalMs = CHECK_INTERVAL_MS } = {}) {
  const at = toTime(lastCheckedAt);
  if (at === null) return true;
  if (at > now) return true;
  const interval = Number(minIntervalMs);
  const floor = Number.isFinite(interval) && interval >= 0 ? interval : CHECK_INTERVAL_MS;
  return now - at >= floor;
}

// ------------------------------------------------------------------------------- fetch

const BODY_TOO_LARGE = Symbol("body too large");
const TIMED_OUT = Symbol("timed out");

/**
 * The body as text, with a hard byte cap, from whichever of the three shapes a response
 * offers. `body` is an async iterable (a real Response), `text()` is the common stub, and
 * `json()` is what a hand-written fake in a test tends to provide.
 *
 * @returns {Promise<string | symbol>}
 */
async function readBody(response) {
  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return BODY_TOO_LARGE;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof response.text === "function") {
    const text = String(await response.text());
    return Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES ? BODY_TOO_LARGE : text;
  }
  if (typeof response.json === "function") {
    const text = JSON.stringify(await response.json());
    return Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES ? BODY_TOO_LARGE : text;
  }
  throw new Error("the response carried no body");
}

/**
 * Read and validate the published manifest. Never throws, for any failure.
 *
 * The timeout is both an AbortController (so a well-behaved fetch stops on the wire) and
 * a race against a timer (so a fetch implementation that ignores its signal still cannot
 * hang the check). Every failure comes back as `{ ok: false, reason }` where the reason is
 * a sentence a person can read in the app.
 *
 * The request sends exactly one header, `accept: application/json`, and no query string:
 * the URL is the one passed in, unmodified. See the file header - this check must not be
 * able to say who asked.
 *
 * @param {{ url?: string, fetchImpl?: Function, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, manifest: object } | { ok: false, reason: string }>}
 */
export async function fetchUpdateManifest({ url = UPDATE_FEED_URL, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const fail = (reason) => ({ ok: false, reason });

  let target;
  try {
    target = new URL(String(url));
  } catch {
    return fail(`the update feed address ${JSON.stringify(url)} is not a URL`);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return fail(`the update feed address ${JSON.stringify(url)} is not an http(s) URL`);
  }
  if (typeof fetchImpl !== "function") {
    return fail("no fetch implementation is available, so the update check cannot run");
  }

  const numeric = Number(timeoutMs);
  const limit = Number.isFinite(numeric) && numeric > 0 ? numeric : TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;

  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        /* an already-aborted controller is not an error */
      }
      resolve(TIMED_OUT);
    }, limit);
  });

  const attempt = async () => {
    try {
      const response = await fetchImpl(target.href, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response || typeof response !== "object") return fail("the update feed returned no response");

      const status = Number(response.status ?? 0);
      const ok = typeof response.ok === "boolean" ? response.ok : status >= 200 && status < 300;
      if (!ok) return fail(`the update feed answered HTTP ${status || "unknown"}`);

      const declared = Number(response.headers?.get?.("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return fail(`the update feed sent ${declared} bytes, more than the ${MAX_BODY_BYTES}-byte limit`);
      }

      const text = await readBody(response);
      if (text === BODY_TOO_LARGE) {
        return fail(`the update feed sent more than ${MAX_BODY_BYTES} bytes, so it was not read`);
      }

      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return fail("the update feed did not answer with JSON");
      }

      const checked = validateUpdateManifest(value);
      if (!checked.ok) return fail(`the update manifest is unusable: ${checked.reason}`);
      return { ok: true, manifest: checked.manifest };
    } catch (error) {
      if (timedOut || controller.signal.aborted) return fail(`the update check timed out after ${limit}ms`);
      return fail(`the update feed could not be reached: ${String(error?.message ?? error)}`);
    }
  };

  try {
    const outcome = await Promise.race([attempt(), deadline]);
    if (outcome === TIMED_OUT) return fail(`the update check timed out after ${limit}ms`);
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
