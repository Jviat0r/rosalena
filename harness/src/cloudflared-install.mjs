/**
 * cloudflared, fetched for the person so phone access needs nothing installed.
 *
 * Order of lookup (remote.mjs): ROSALENA_CLOUDFLARED, then PATH, then the copy this
 * module put in `<home>/remote/bin/`, and only then a download. The download is the
 * official binary from Cloudflare's GitHub releases:
 *
 *   1. Ask the GitHub API for the latest release, which lists every asset with its size
 *      and a `digest` ("sha256:<hex>") GitHub computed itself on upload.
 *   2. If the API cannot be reached (offline, rate-limited at 60 requests an hour without
 *      a login), fall back to a pinned release whose sizes and SHA-256 digests are written
 *      below, read from that same API on 2026-11-09.
 *   3. Stream the asset to a temp file, hashing as it arrives. The size and the SHA-256
 *      must both match or the file is deleted and nothing is installed: a binary that
 *      cannot be verified is never run.
 *   4. macOS ships a .tgz; the one `cloudflared` entry is read out of it here (gunzip plus
 *      a minimal tar reader), with no `tar` process.
 *   5. Rename into place (atomic), chmod 755 on POSIX, and write `cloudflared.json` next to
 *      it (version, asset, SHA-256) so the page can say which build is running.
 *
 * The only hosts touched are api.github.com and github.com (which redirects the asset to
 * its own CDN). No token, no telemetry, nothing about the person is sent.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const RELEASES_API = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

/** Asset names per platform/arch, as Cloudflare publishes them. */
export const ASSETS = Object.freeze({
  "win32-x64": { name: "cloudflared-windows-amd64.exe", archive: null },
  "win32-arm64": { name: "cloudflared-windows-amd64.exe", archive: null }, // runs under emulation
  "darwin-arm64": { name: "cloudflared-darwin-arm64.tgz", archive: "tgz" },
  "darwin-x64": { name: "cloudflared-darwin-amd64.tgz", archive: "tgz" },
  "linux-x64": { name: "cloudflared-linux-amd64", archive: null },
  "linux-arm64": { name: "cloudflared-linux-arm64", archive: null },
});

/** Read from the GitHub API on 2026-11-09 (release published 2026-10-30). */
export const PINNED = Object.freeze({
  version: "2026.10.7",
  assets: Object.freeze({
    "cloudflared-windows-amd64.exe": { size: 55390512, sha256: "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343" },
    "cloudflared-darwin-arm64.tgz": { size: 19847161, sha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd" },
    "cloudflared-darwin-amd64.tgz": { size: 21834416, sha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848" },
    "cloudflared-linux-amd64": { size: 40274445, sha256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872" },
    "cloudflared-linux-arm64": { size: 37667293, sha256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775" },
  }),
});

export function assetFor(platform = process.platform, arch = process.arch) {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

export function binDir(home) {
  return join(home, "remote", "bin");
}

export function installedPath(home, platform = process.platform) {
  return join(binDir(home), platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

/** The copy this module installed, if it is there. */
export function locateInstalled(home, platform = process.platform) {
  if (!home) return null;
  const path = installedPath(home, platform);
  try {
    if (!statSync(path).isFile()) return null;
  } catch {
    return null;
  }
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(binDir(home), "cloudflared.json"), "utf8"));
  } catch {
    meta = null;
  }
  return { path, version: meta?.version ?? null, sha256: meta?.sha256 ?? null };
}

/** The one regular file named `cloudflared` inside a tar stream. */
export function extractFromTar(tar, wanted = "cloudflared") {
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = at + 512;
    if ((type === "0" || type === "\0") && full.replace(/^\.\//, "").split("/").pop() === wanted) {
      return Buffer.from(tar.subarray(body, body + size));
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Latest release from the API; null if it cannot be read. */
async function latestRelease(fetchImpl, apiUrl, timeoutMs) {
  try {
    const res = await fetchImpl(apiUrl, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Rosalena-Harness" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Where to download from and what the file must hash to. */
export async function resolveAsset({ platform = process.platform, arch = process.arch, fetchImpl = fetch, apiUrl = RELEASES_API, timeoutMs = 10_000, pinned = PINNED } = {}) {
  const asset = assetFor(platform, arch);
  if (!asset) return { ok: false, reason: `there is no official cloudflared build for ${platform}/${arch}` };
  const release = await latestRelease(fetchImpl, apiUrl, timeoutMs);
  const listed = release?.assets?.find?.((a) => a?.name === asset.name);
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(String(listed?.digest ?? ""))?.[1]?.toLowerCase();
  if (listed?.browser_download_url && digest && Number(listed.size) > 0) {
    return { ok: true, ...asset, url: listed.browser_download_url, size: Number(listed.size), sha256: digest, version: String(release.tag_name ?? "latest"), source: "api" };
  }
  const known = pinned.assets[asset.name];
  if (!known) return { ok: false, reason: `the release list could not be read and ${asset.name} has no pinned checksum` };
  return {
    ok: true,
    ...asset,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${pinned.version}/${asset.name}`,
    size: known.size,
    sha256: known.sha256,
    version: pinned.version,
    source: "pinned",
  };
}

/** Stream a URL to a file, hashing and counting as it goes. */
async function download(url, file, { fetchImpl, timeoutMs, expectSize, onProgress }) {
  const res = await fetchImpl(url, { headers: { "user-agent": "Rosalena-Harness" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`the download answered HTTP ${res.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(file, { mode: 0o755 });
  let received = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      received += buf.length;
      if (expectSize && received > expectSize) throw new Error(`the download is larger than the ${expectSize} bytes the release lists`);
      hash.update(buf);
      if (!out.write(buf)) await new Promise((resolve) => out.once("drain", resolve));
      onProgress?.({ received, total: expectSize || null });
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  return { received, sha256: hash.digest("hex") };
}

const inflight = new Map();

/**
 * Install cloudflared into `<home>/remote/bin`. Resolves `{ ok, path, version, sha256 }`
 * or `{ ok: false, reason }`; never throws. Two callers at once share one download.
 */
export function installCloudflared(options = {}) {
  const key = options.home ?? "";
  if (inflight.has(key)) return inflight.get(key);
  const job = runInstall(options).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function runInstall({
  home,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
  apiUrl = RELEASES_API,
  pinned = PINNED,
  timeoutMs = 10 * 60_000,
  onProgress = () => {},
  log = () => {},
} = {}) {
  if (!home) return { ok: false, reason: "there is no app folder to install cloudflared into" };
  const existing = locateInstalled(home, platform);
  if (existing) return { ok: true, ...existing, installed: false };

  const asset = await resolveAsset({ platform, arch, fetchImpl, apiUrl, pinned });
  if (!asset.ok) return asset;

  const dir = binDir(home);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.download-${randomBytes(4).toString("hex")}`);
  const target = installedPath(home, platform);
  log(`remote: downloading cloudflared ${asset.version} (${asset.name}, ${(asset.size / 1e6).toFixed(1)} MB) from ${asset.url}`);
  try {
    const got = await download(asset.url, temp, { fetchImpl, timeoutMs, expectSize: asset.size, onProgress });
    if (got.received !== asset.size) throw new Error(`the download is ${got.received} bytes; the release lists ${asset.size}`);
    if (got.sha256 !== asset.sha256) throw new Error(`the download's SHA-256 is ${got.sha256}; the release lists ${asset.sha256}`);
    if (asset.archive === "tgz") {
      const binary = extractFromTar(gunzipSync(readFileSync(temp)));
      if (!binary) throw new Error(`${asset.name} does not contain a cloudflared binary`);
      writeFileSync(temp, binary, { mode: 0o755 });
    }
    if (platform !== "win32") chmodSync(temp, 0o755);
    renameSync(temp, target);
    writeFileSync(join(dir, "cloudflared.json"), `${JSON.stringify({ version: asset.version, asset: asset.name, sha256: asset.sha256, source: asset.source, installedAt: new Date().toISOString() }, null, 2)}\n`);
    log(`remote: cloudflared ${asset.version} installed at ${target} (SHA-256 checked)`);
    return { ok: true, path: target, version: asset.version, sha256: asset.sha256, installed: true };
  } catch (err) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* best effort */
    }
    return { ok: false, reason: `cloudflared could not be downloaded: ${err?.message ?? err}` };
  }
}
