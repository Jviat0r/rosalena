/**
 * Phone access, the part that survives a restart.
 *
 * One JSON file, `<home>/remote/state.json`, written owner-only (0600) and atomically
 * (a temp file in the same folder, then a rename over the old one), so a crash in the
 * middle of a write leaves either the old file or the new one and never half of each.
 * It holds:
 *
 *   pairing   the token the QR code carries. Persistent on purpose: the same link (and
 *             the same QR) works after the app closes and opens again. "New QR code"
 *             replaces it; every link shared before then stops pairing new devices.
 *   relay     this install's stable-hostname identity: a 120-bit id (the subdomain the
 *             phone bookmarks) and a 256-bit secret that proves to the relay that a
 *             registration came from this install. The relay keeps only a hash of it.
 *   devices   one row per paired browser: an id, the SHA-256 of a 256-bit session secret
 *             (the cookie carries the secret; this file never does), a name read from
 *             the User-Agent, when it paired and when it was last seen. Each row can be
 *             revoked on its own.
 *   settings  keep phone access on at startup, use the relay, a named tunnel (token +
 *             hostname + the local port it points at), and how long a paired device
 *             stays paired without being used.
 *
 * Nothing here is sent anywhere. The pairing token and the relay secret are secrets: the
 * file is 0600 on POSIX, and on Windows it lives under the user's profile like every other
 * Rosalena file. `publicSettings()` and `devices()` are the only shapes the page sees, and
 * neither carries a secret (the named-tunnel token comes back as "set, ends in ...").
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const STORE_VERSION = 1;

/** The choices the settings page offers for how long an unused device stays paired. */
export const COOKIE_DAYS = Object.freeze([1, 7, 30, 90, 365]);

export const DEFAULT_SETTINGS = Object.freeze({
  keepOn: false,
  relay: true,
  namedToken: "",
  namedHost: "",
  namedPort: 47390,
  cookieDays: 90,
});

/** The most devices kept at once; pairing one more drops the one unused the longest. */
export const MAX_DEVICES = 25;

/** lastSeen is written to disk at most this often per device: a page load is not a write. */
const TOUCH_WRITE_MS = 60_000;

const RELAY_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const RELAY_ID_RE = /^[a-z2-7]{24}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_RE = /^[a-f0-9]{16}$/;

export function remoteStateFile(home) {
  return join(home, "remote", "state.json");
}

/** 256 bits, base64url: survives a URL, a cookie and a QR code unescaped. */
export function mintSecret() {
  return randomBytes(32).toString("base64url");
}

/**
 * 24 characters of base32 (a-z, 2-7): 120 bits, one DNS label, no uppercase for a
 * hostname to fold. Each byte is masked to 5 bits, and 256 is a multiple of 32, so every
 * character is uniform.
 */
export function mintRelayId() {
  let out = "";
  for (const byte of randomBytes(24)) out += RELAY_ALPHABET[byte & 31];
  return out;
}

export function hashSecret(secret) {
  return createHash("sha256").update(String(secret ?? ""), "utf8").digest("hex");
}

function sameHex(a, b) {
  const x = Buffer.from(String(a ?? ""), "hex");
  const y = Buffer.from(String(b ?? ""), "hex");
  if (x.length === 0 || x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * A short, human name for a device, from its User-Agent: "iPhone · Safari",
 * "Android · Chrome", "Windows · Edge". The raw User-Agent is never stored or shown.
 */
export function deviceName(userAgent) {
  const ua = String(userAgent ?? "");
  let os = "Browser";
  if (/iPhone/i.test(ua)) os = "iPhone";
  else if (/iPad/i.test(ua)) os = "iPad";
  else if (/Android/i.test(ua)) os = /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  else if (/Windows/i.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "Mac";
  else if (/CrOS/i.test(ua)) os = "Chromebook";
  else if (/Linux/i.test(ua)) os = "Linux";
  let browser = "";
  if (/EdgA?\/|Edg\//i.test(ua)) browser = "Edge";
  else if (/SamsungBrowser/i.test(ua)) browser = "Samsung Internet";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Firefox|FxiOS/i.test(ua)) browser = "Firefox";
  else if (/CriOS|Chrome\//i.test(ua)) browser = "Chrome";
  else if (/Safari\//i.test(ua)) browser = "Safari";
  return browser ? `${os} · ${browser}` : os;
}

function cleanHost(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!text) return "";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(text)) {
    throw new RangeError(`"${value}" is not a hostname (example: rosalena.example.com)`);
  }
  return text;
}

/** Validate one settings patch. Unknown keys are refused, not ignored. */
export function cleanSettings(patch = {}, current = DEFAULT_SETTINGS) {
  const next = { ...DEFAULT_SETTINGS, ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    switch (key) {
      case "keepOn":
      case "relay":
        if (typeof value !== "boolean") throw new TypeError(`${key} must be true or false`);
        next[key] = value;
        break;
      case "namedToken": {
        const token = String(value ?? "").trim();
        // A Cloudflare tunnel token is a long base64 string; refuse obvious junk.
        if (token && !/^[A-Za-z0-9+/=_-]{40,4096}$/.test(token)) {
          throw new RangeError("that does not look like a Cloudflare tunnel token (copy it from the tunnel's install command)");
        }
        next.namedToken = token;
        break;
      }
      case "namedHost":
        next.namedHost = cleanHost(value);
        break;
      case "namedPort": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError("the local port must be 1024-65535");
        next.namedPort = port;
        break;
      }
      case "cookieDays": {
        const days = Number(value);
        if (!COOKIE_DAYS.includes(days)) throw new RangeError(`cookieDays must be one of ${COOKIE_DAYS.join(", ")}`);
        next.cookieDays = days;
        break;
      }
      default:
        throw new RangeError(`unknown phone access setting "${key}"`);
    }
  }
  return next;
}

function freshData(now) {
  return {
    version: STORE_VERSION,
    pairing: { token: mintSecret(), mintedAt: now },
    relay: { id: mintRelayId(), secret: mintSecret(), mintedAt: now, url: null },
    devices: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Bring a parsed file back to the shape this version writes; anything unusable is reminted. */
function normalise(raw, now) {
  const base = freshData(now);
  if (!raw || typeof raw !== "object") return base;
  const out = { ...base };
  if (raw.pairing && SECRET_RE.test(String(raw.pairing.token ?? ""))) out.pairing = { token: raw.pairing.token, mintedAt: Number(raw.pairing.mintedAt) || now };
  if (raw.relay && RELAY_ID_RE.test(String(raw.relay.id ?? "")) && SECRET_RE.test(String(raw.relay.secret ?? ""))) {
    out.relay = {
      id: raw.relay.id,
      secret: raw.relay.secret,
      mintedAt: Number(raw.relay.mintedAt) || now,
      url: typeof raw.relay.url === "string" && /^https:\/\//.test(raw.relay.url) ? raw.relay.url : null,
    };
  }
  if (Array.isArray(raw.devices)) {
    out.devices = raw.devices
      .filter((d) => d && DEVICE_ID_RE.test(String(d.id ?? "")) && /^[a-f0-9]{64}$/.test(String(d.hash ?? "")))
      .map((d) => ({
        id: d.id,
        hash: d.hash,
        name: String(d.name ?? "Browser").slice(0, 80),
        createdAt: Number(d.createdAt) || now,
        lastSeen: Number(d.lastSeen) || Number(d.createdAt) || now,
      }))
      .slice(-MAX_DEVICES);
  }
  try {
    out.settings = cleanSettings(raw.settings ?? {}, DEFAULT_SETTINGS);
  } catch {
    // One bad value must not cost the person their pairing: keep the defaults for settings only.
    out.settings = { ...DEFAULT_SETTINGS };
  }
  return out;
}

/** Write owner-only and atomically: temp file next to the target, then rename over it. */
export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file is already gone */
    }
    throw err;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: permissions come from the folder's ACL */
  }
}

/**
 * The store. `file: null` keeps everything in memory (tests, and embedders with no home).
 */
export function createRemoteStore({ file = null, now = () => Date.now(), log = () => {} } = {}) {
  let data = null;

  function load() {
    if (!file || !existsSync(file)) return freshData(now());
    try {
      return normalise(JSON.parse(readFileSync(file, "utf8")), now());
    } catch (err) {
      // A file that does not parse is moved aside, not overwritten: the person may want it.
      const aside = `${file}.corrupt-${now()}`;
      try {
        renameSync(file, aside);
      } catch {
        /* leave it */
      }
      log(`remote: ${file} could not be read (${err?.message ?? err}); starting over, the old file is ${aside}`);
      return freshData(now());
    }
  }

  function ensure() {
    if (!data) {
      const existed = Boolean(file && existsSync(file));
      data = load();
      if (!existed) save();
    }
    return data;
  }

  function save() {
    if (!file || !data) return;
    writeAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
  }

  function publicDevice(d) {
    return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen };
  }

  return {
    file,

    pairingToken() {
      return ensure().pairing.token;
    },
    pairingMintedAt() {
      return ensure().pairing.mintedAt;
    },
    /** New QR code: the old link stops pairing new devices. Paired devices stay paired. */
    rotatePairing() {
      ensure().pairing = { token: mintSecret(), mintedAt: now() };
      save();
      return data.pairing.token;
    },

    relayIdentity() {
      const { id, secret } = ensure().relay;
      return { id, secret };
    },
    relayUrl() {
      return ensure().relay.url;
    },
    setRelayUrl(url) {
      const next = typeof url === "string" && /^https:\/\//.test(url) ? url : null;
      if (ensure().relay.url === next) return;
      data.relay.url = next;
      save();
    },
    /** A new stable hostname. Returns the old identity so the caller can unregister it. */
    rotateRelay() {
      const old = this.relayIdentity();
      ensure().relay = { id: mintRelayId(), secret: mintSecret(), mintedAt: now(), url: null };
      save();
      return old;
    },

    settings() {
      return { ...ensure().settings };
    },
    /** What the page may see: the tunnel token never leaves this file in full. */
    publicSettings() {
      const s = ensure().settings;
      const { namedToken, ...rest } = s;
      return { ...rest, hasNamedToken: Boolean(namedToken), namedTokenHint: namedToken ? `ends in ${namedToken.slice(-4)}` : "" };
    },
    updateSettings(patch) {
      const next = cleanSettings(patch, ensure().settings);
      data.settings = next;
      save();
      return this.publicSettings();
    },

    devices() {
      return ensure().devices.map(publicDevice).sort((a, b) => b.lastSeen - a.lastSeen);
    },
    /** A new paired device. The returned cookie value is the only copy of its secret. */
    addDevice({ userAgent = "" } = {}) {
      const d = ensure();
      const secret = mintSecret();
      const device = { id: randomBytes(8).toString("hex"), hash: hashSecret(secret), name: deviceName(userAgent), createdAt: now(), lastSeen: now() };
      d.devices.push(device);
      if (d.devices.length > MAX_DEVICES) {
        d.devices.sort((a, b) => a.lastSeen - b.lastSeen);
        d.devices.splice(0, d.devices.length - MAX_DEVICES);
      }
      save();
      return { device: publicDevice(device), cookie: `${device.id}.${secret}` };
    },
    /**
     * The device a cookie value belongs to, or null. A device unused for longer than
     * `maxIdleMs` is dropped here, so "how long a device stays paired" is enforced by the
     * server and not only by the cookie's Max-Age.
     */
    verifyDevice(cookieValue, { maxIdleMs = Infinity } = {}) {
      const match = /^([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/.exec(String(cookieValue ?? ""));
      if (!match) return null;
      const d = ensure();
      const device = d.devices.find((row) => row.id === match[1]);
      if (!device || !sameHex(hashSecret(match[2]), device.hash)) return null;
      const at = now();
      if (at - device.lastSeen > maxIdleMs) {
        d.devices = d.devices.filter((row) => row !== device);
        save();
        return null;
      }
      const due = at - device.lastSeen > TOUCH_WRITE_MS;
      device.lastSeen = at;
      if (due) save();
      return publicDevice(device);
    },
    removeDevice(id) {
      const d = ensure();
      const before = d.devices.length;
      d.devices = d.devices.filter((row) => row.id !== id);
      if (d.devices.length === before) return false;
      save();
      return true;
    },
    removeAllDevices() {
      const d = ensure();
      const count = d.devices.length;
      d.devices = [];
      save();
      return count;
    },
  };
}
