// Wi-Fi switcher - see the networks this machine can see, and join one.
//
// Every fact here comes from `netsh wlan`, run as an argument array with no
// shell, and every parse is a pure function of the text netsh printed. That is
// deliberate: this checkout is developed on a machine whose adapter may or may
// not exist, in a room whose neighbours may or may not broadcast, and a parser
// that needs a radio to be tested is a parser nobody can test. So the shapes
// below (`parseInterfaces`, `parseNetworks`, `parseProfiles`) take the transcript
// and return data, and `probeWifi` / `connectWifi` take an injectable `run` so a
// test can hand them those same transcripts.
//
// The four commands this module can run, in full:
//
//   netsh wlan show interfaces
//   netsh wlan show networks mode=bssid
//   netsh wlan show profiles
//   netsh wlan show profile name=<ssid>          (cost/metered state only)
//
// and the two that change something, only from connectWifi:
//
//   netsh wlan add profile filename=<temp.xml> user=current
//   netsh wlan connect name=<profile> ssid=<ssid>
//
// Two rules the rest of the file is built around:
//
// 1. **A password is never echoed, logged or returned.** A new network needs
//    Windows to hold its key, and Windows keeps Wi-Fi keys in a profile, so the
//    password is written to a temp XML file, imported, and the file is deleted in
//    a `finally`. It never reaches a command line, a message, an error string or
//    this module's return value; `redact()` scrubs it from netsh's own output as
//    a belt-and-braces measure, because netsh has been known to quote its input.
// 2. **"The command exited 0" is not a connection.** After `netsh wlan connect`
//    the interface is polled (3 tries, 1.5 s apart) and the report is the SSID the
//    driver says it is on. A driver that stayed on the old network yields
//    `ok: false` with what it actually reports, even though every command exited 0.
//
// What this cannot do, stated here rather than discovered later:
//   - it is Windows only (`netsh wlan` has no non-Windows equivalent here);
//   - a new WPA2/WPA3-Enterprise network is refused: it wants a username, a domain
//     and often a certificate, and there is nowhere on the page to type those;
//   - a new WEP network is refused rather than half-configured;
//   - a captive portal still needs a browser after the association succeeds;
//   - the band is derived from the channel number, because netsh prints no band;
//   - `netsh wlan show networks` lists only what the WLAN service last scanned, so
//     a radio that is off is reported as a radio that is off, not as "no networks";
//   - parsing matches the English field names netsh prints. On a non-English
//     Windows the commands run and every parser returns nothing, and `probeWifi`
//     says the interface could not be read rather than pretending there is none.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// netsh answers a healthy adapter in tens of milliseconds; a scan on a busy
// adapter can take a second or two. Eight seconds is "wedged", not "slow", and
// a page that polls every five seconds must never queue up behind a hung probe.
const DEFAULT_TIMEOUT_MS = 8_000;

// After `netsh wlan connect`: three samples 1.5 s apart. Association plus DHCP is
// usually under two seconds; three samples is long enough to catch it and short
// enough that the page is not left spinning.
const VERIFY_ATTEMPTS = 3;
const VERIFY_INTERVAL_MS = 1_500;

// A Wi-Fi SSID is 32 octets, not 32 characters.
const MAX_SSID_BYTES = 32;

const SHOW_INTERFACES = ["wlan", "show", "interfaces"];
const SHOW_NETWORKS = ["wlan", "show", "networks", "mode=bssid"];
const SHOW_PROFILES = ["wlan", "show", "profiles"];

const reason = (err) => (err instanceof Error ? err.message : String(err));

/** netsh writes some failures to stdout and some to stderr; take whichever spoke. */
function textOf(result) {
  const out = typeof result?.stdout === "string" ? result.stdout : "";
  if (out.trim()) return out;
  return typeof result?.stderr === "string" ? result.stderr : "";
}

/** The one line worth putting in an error, because a stack trace belongs in a log, not a page. */
function firstLine(text) {
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[=\-]{4,}$/.test(line)) continue;
    return line.length > 200 ? `${line.slice(0, 200)}...` : line;
  }
  return "";
}

/** A secret has no place in a message, even one netsh quoted back at us. */
export function redact(text, secret) {
  const out = String(text ?? "");
  const value = typeof secret === "string" && secret ? secret : "";
  return value ? out.split(value).join("***") : out;
}

/**
 * The real runner: `netsh` with an argument array, never a shell.
 *
 * `shell: false` is not a preference. A profile name is an SSID, and an SSID is
 * whatever a neighbour chose to broadcast, so a shell here would turn a network
 * name into a command. Nothing in this module ever interpolates into a string.
 *
 * It resolves and never rejects: a missing netsh, a refused spawn and a timeout
 * are all a `{ code, stdout, stderr }` the caller can report.
 */
export function defaultRun(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(String(command), Array.isArray(args) ? args.map(String) : [], {
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: `${command} could not be started: ${reason(err)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ code: -2, stdout, stderr: stderr || `${command} did not answer within ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => finish({ code: -1, stdout, stderr: String(err?.message ?? err) }));
    child.on("close", (code) => finish({ code: Number.isInteger(code) ? code : -1, stdout, stderr }));
  });
}

/** One netsh call as data: the exit code, the text, and a one-line problem when it did not work. */
async function netsh(run, args, timeoutMs) {
  const label = `netsh ${args.join(" ")}`;
  try {
    const result = await run("netsh", args, { timeoutMs });
    const text = textOf(result);
    const code = Number(result?.code ?? -1);
    return {
      code,
      text,
      error: code === 0 ? null : `${label} failed (exit ${code})${firstLine(text) ? `: ${firstLine(text)}` : ""}`,
    };
  } catch (err) {
    // An injected runner that throws is still just a failed command, not a crash
    // in whatever asked - this module has to survive a broken seam.
    return { code: -1, text: "", error: `${label} failed: ${reason(err)}` };
  }
}

// ------------------------------------------------------------------ parsing
//
// Everything below is a pure function of the text it is handed. netsh's fields
// are `    Key                   : value`, and its section headers are either a
// `Key : value` line at one space of indent (`Interface name : Wi-Fi`) or a bare
// sentence. The parsers read the field lines and ignore the sentences, which is
// also why the header/footer lines that merely look like entries do not survive.

/** `    Name                   : Wi-Fi` -> ["Name", "Wi-Fi"]. Values may contain colons. */
const FIELD_LINE = /^\s+([^:\r\n]+?)\s*:\s?(.*)$/;

/** 2.4 GHz channels are 1-14; 5 GHz channels start at 32. 6 GHz reuses 1-233, so it is not guessed. */
export function bandOf(channel) {
  const value = Number(channel);
  if (!Number.isFinite(value)) return "";
  if (value >= 1 && value <= 14) return "2.4 GHz";
  if (value >= 32 && value <= 196) return "5 GHz";
  return "";
}

/** "91% " -> 91, and anything else -> null. A missing reading is not a zero. */
export function percentOf(text) {
  const match = /(\d{1,3})\s*%/.exec(String(text ?? ""));
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
}

/**
 * netsh's Authentication/Encryption pair as the word this module uses.
 *
 * The page needs one of these to decide between a password field and no password
 * field, so the mapping is exhaustive on purpose: anything the driver calls
 * "Enterprise" needs credentials no page here can collect, WEP is "a password"
 * and nothing else, and a WPA3-Personal (SAE) network is not a WPA2 one.
 */
export function securityOf(authText, cipherText = "") {
  const auth = String(authText ?? "").trim().toLowerCase();
  if (!auth) return "unknown";
  if (auth === "open" || auth.startsWith("open ")) return "open";
  if (auth.includes("wpa3") && auth.includes("enterprise")) return "wpa3-enterprise";
  if (auth.includes("wpa2") && auth.includes("enterprise")) return "wpa2-enterprise";
  if (auth.includes("wpa") && auth.includes("enterprise")) return "wpa-enterprise";
  if (auth.includes("wpa3")) return "wpa3";
  if (auth.includes("wpa2")) return "wpa2";
  if (auth.includes("wpa")) return "wpa";
  if (auth.includes("wep") || String(cipherText ?? "").toLowerCase().includes("wep")) return "wep";
  return "unknown";
}

/** Whether joining asks for a password. "unknown" says yes: a password it did not need is refused by Windows, an unexplained failure on an open network is worse. */
export function needsPasswordOf(security) {
  return security !== "open";
}

/** The human label for a security word, used by the page and the reports. */
export function securityLabel(security) {
  return (
    {
      open: "open",
      wep: "WEP",
      wpa: "WPA",
      wpa2: "WPA2",
      wpa3: "WPA3",
      "wpa-enterprise": "WPA-Enterprise",
      "wpa2-enterprise": "WPA2-Enterprise",
      "wpa3-enterprise": "WPA3-Enterprise",
    }[security] ?? "not reported"
  );
}

/**
 * `netsh wlan show interfaces`, as interfaces plus the primary one's fields.
 *
 * A disconnected adapter still has a Name, a State and a GUID; the SSID, BSSID,
 * authentication, cipher, channel and rates only exist while it is associated,
 * which is why every one of those is null rather than empty when it is missing.
 * The scalar keys beside `interfaces` describe the primary entry (the first one)
 * so a caller that only wants "the adapter" does not have to reach into an array.
 */
export function parseInterfaces(text) {
  const interfaces = [];
  let current = null;
  const begin = () => {
    current = {
      name: "",
      description: "",
      guid: "",
      mac: "",
      state: "",
      ssid: "",
      bssid: "",
      profile: "",
      auth: "",
      cipher: "",
      channel: null,
      band: "",
      signal: "",
      signalPercent: null,
      rxKbps: null,
      txKbps: null,
      radio: null,
      hostedNetwork: "",
      wireless: true,
    };
    interfaces.push(current);
    return current;
  };

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const field = FIELD_LINE.exec(raw);
    if (!field) continue;
    const key = field[1].trim();
    const value = field[2].trim();
    if (!key) continue;

    // `Name` is the first field netsh prints for a block and is what starts the
    // next one: two adapters print two Name lines, in order.
    if (/^name$/i.test(key)) {
      if (!current || current.name) begin();
      current.name = value;
      continue;
    }
    if (!current) {
      // A field with no Name before it is not an interface field; netsh prints
      // `Interface name : Wi-Fi` that way in other verbs.
      if (!/^interface name$/i.test(key)) continue;
      begin();
      current.name = value;
      continue;
    }

    if (/^description$/i.test(key)) current.description = value;
    else if (/^guid$/i.test(key)) current.guid = value;
    else if (/^physical address$/i.test(key)) current.mac = value;
    else if (/^state$/i.test(key)) current.state = value.toLowerCase();
    else if (/^ssid$/i.test(key)) current.ssid = value;
    else if (/^bssid$/i.test(key)) current.bssid = value;
    else if (/^profile$/i.test(key)) current.profile = value;
    else if (/^authentication$/i.test(key)) current.auth = value;
    else if (/^cipher$/i.test(key)) current.cipher = value;
    else if (/^channel$/i.test(key)) {
      const channel = Number.parseInt(value, 10);
      current.channel = Number.isFinite(channel) ? channel : null;
      current.band = bandOf(current.channel);
    } else if (/^signal$/i.test(key)) {
      current.signalPercent = percentOf(value);
      current.signal = current.signalPercent === null ? "" : `${current.signalPercent}%`;
    } else if (/^receive rate \(mbps\)$/i.test(key)) {
      const mbps = Number.parseFloat(value);
      current.rxKbps = Number.isFinite(mbps) ? Math.round(mbps * 1000) : null;
    } else if (/^transmit rate \(mbps\)$/i.test(key)) {
      const mbps = Number.parseFloat(value);
      current.txKbps = Number.isFinite(mbps) ? Math.round(mbps * 1000) : null;
    } else if (/^radio status$/i.test(key)) {
      current.radio = /off/i.test(value) ? "off" : /on/i.test(value) ? "on" : null;
    } else if (/^hosted network status$/i.test(key)) current.hostedNetwork = value;
  }

  const primary = interfaces[0] ?? null;
  return {
    count: interfaces.length,
    interfaces,
    name: primary?.name ?? "",
    description: primary?.description ?? "",
    state: primary?.state ?? "not reported",
    ssid: primary?.ssid ?? "",
    bssid: primary?.bssid ?? "",
    auth: primary?.auth ?? "",
    cipher: primary?.cipher ?? "",
    channel: primary?.channel ?? null,
    band: primary?.band ?? "",
    signal: primary?.signal ?? "",
    signalPercent: primary?.signalPercent ?? null,
    rxKbps: primary?.rxKbps ?? null,
    txKbps: primary?.txKbps ?? null,
    // null means netsh did not print a radio status at all, which is most builds.
    radio: interfaces.some((entry) => entry.radio === "off")
      ? "off"
      : interfaces.some((entry) => entry.radio === "on")
        ? "on"
        : null,
  };
}

/**
 * `netsh wlan show networks mode=bssid`, merged the way Windows shows it.
 *
 * One SSID can be broadcast by several access points, and netsh prints each
 * BSSID as its own block with its own signal and channel. That is one network to
 * a person, so the blocks are merged by SSID name and the row keeps the strongest
 * BSSID's numbers plus a count of the radios behind it.
 *
 * A hidden network prints as `SSID 1 :` with nothing after the colon. It cannot be
 * listed usefully (there is no name to click) and its BSSID is not the network's
 * identity, so it is skipped rather than shown as a blank row.
 */
export function parseNetworks(text) {
  const networks = [];
  let network = null;
  let bssid = null;

  const finish = () => {
    if (!network || !network.ssid) {
      network = null;
      bssid = null;
      return;
    }
    const radios = network.radios;
    // Strongest first: the row a person picks should be the one they can reach.
    radios.sort((a, b) => (b.signalPercent ?? -1) - (a.signalPercent ?? -1));
    const best = radios[0] ?? null;
    networks.push({
      ssid: network.ssid,
      auth: network.auth,
      cipher: network.cipher,
      security: securityOf(network.auth, network.cipher),
      needsPassword: needsPasswordOf(securityOf(network.auth, network.cipher)),
      signal: best?.signal ?? "",
      signalPercent: best?.signalPercent ?? null,
      channel: best?.channel ?? null,
      band: best?.band ?? "",
      radioType: best?.radioType ?? "",
      // How many access points broadcast this name, i.e. how real the signal is.
      bssids: radios.length,
    });
    network = null;
    bssid = null;
  };

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const ssidLine = /^SSID\s+\d+\s*:\s*(.*)$/.exec(raw);
    if (ssidLine) {
      finish();
      network = { ssid: ssidLine[1].trim(), auth: "", cipher: "", radios: [] };
      bssid = null;
      continue;
    }
    if (!network) continue;

    const bssidLine = /^\s*BSSID\s+\d+\s*:\s*(.*)$/.exec(raw);
    if (bssidLine) {
      bssid = {
        bssid: bssidLine[1].trim(),
        signal: "",
        signalPercent: null,
        channel: null,
        band: "",
        radioType: "",
      };
      network.radios.push(bssid);
      continue;
    }

    const field = FIELD_LINE.exec(raw);
    if (!field) continue;
    const key = field[1].trim();
    const value = field[2].trim();

    if (!bssid) {
      // Per-SSID fields, printed before the first BSSID.
      if (/^authentication$/i.test(key)) network.auth = value;
      else if (/^encryption$/i.test(key)) network.cipher = value;
      continue;
    }

    if (/^signal$/i.test(key)) {
      bssid.signalPercent = percentOf(value);
      bssid.signal = bssid.signalPercent === null ? "" : `${bssid.signalPercent}%`;
    } else if (/^channel$/i.test(key)) {
      const channel = Number.parseInt(value, 10);
      bssid.channel = Number.isFinite(channel) ? channel : null;
      bssid.band = bandOf(bssid.channel);
    } else if (/^radio type$/i.test(key)) {
      bssid.radioType = value;
    }
  }
  finish();
  return networks;
}

/**
 * `netsh wlan show profiles`, as profile names.
 *
 * Three things in that transcript look like entries and are not: the
 * `Profiles on interface Wi-Fi:` header, the `----` rules under each section
 * title, and the `<None>` a group-policy section prints where a name would go.
 * Only `All User Profile     : <name>` (and the shaped-like-it read-only variant)
 * is a profile, so only that is read - which is also why the header and footer
 * cannot leak in as network names.
 */
export function parseProfiles(text) {
  const names = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const field = FIELD_LINE.exec(raw);
    if (!field) continue;
    const key = field[1].trim();
    if (!/^(?:all user |group policy |user )?profile$/i.test(key)) continue;
    const value = field[2].trim();
    if (!value || /^<none>$/i.test(value) || /^-+$/.test(value)) continue;
    // Profile names are case-insensitive to Windows, so they are deduplicated the
    // same way: two spellings of one name are one profile.
    const folded = value.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    names.push(value);
  }
  return names;
}

/**
 * The `Cost settings` block of `netsh wlan show profile name=<ssid>`.
 *
 * Windows decides whether a link is metered and sets that per profile; netsh can
 * report it but the setting belongs to the person (Settings > Network > Wi-Fi >
 * Metered connection), which is why the page shows it and never pretends to
 * change it.
 */
export function parseCost(text) {
  const cost = { cost: null, congested: null, approachingDataLimit: null, overDataLimit: null, roaming: null, source: null };
  const bool = (value) => (/^yes$/i.test(String(value).trim()) ? true : /^no$/i.test(String(value).trim()) ? false : null);
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const field = FIELD_LINE.exec(raw);
    if (!field) continue;
    const key = field[1].trim();
    const value = field[2].trim();
    if (/^cost$/i.test(key)) {
      const word = value.toLowerCase();
      cost.cost = word.includes("unrestricted") ? "unrestricted" : word.includes("fixed") ? "fixed" : word.includes("unknown") ? "unknown" : null;
    } else if (/^congested$/i.test(key)) cost.congested = bool(value);
    else if (/^approaching data limit$/i.test(key)) cost.approachingDataLimit = bool(value);
    else if (/^over data limit$/i.test(key)) cost.overDataLimit = bool(value);
    else if (/^roaming$/i.test(key)) cost.roaming = bool(value);
    else if (/^cost source$/i.test(key)) cost.source = value;
  }
  return cost;
}

/** XML text escaping, for the three characters that would otherwise end the element. */
export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The Windows wireless profile for one network, as XML.
 *
 * A new network cannot be joined by `netsh wlan connect` alone: connect takes a
 * *profile* name, and Windows has no profile until one is added. So joining a
 * network the machine has never seen means writing this document and importing
 * it - which is also the only place the password lands, because that is how
 * Windows itself stores a Wi-Fi key.
 *
 * `auth` picks the key management: `open` (no key at all), `wpa2` (WPA2PSK/AES),
 * `wpa3` (WPA3SAE/AES) or `wpa` (WPAPSK/AES+TKIP). It defaults from whether a
 * password was given, so a caller that only has a password still gets a profile
 * Windows accepts.
 */
export function profileXml({ ssid, password = null, auth = null } = {}) {
  const name = String(ssid ?? "").trim();
  if (!name) throw new Error("profileXml needs an SSID");
  const secret = typeof password === "string" ? password : "";

  const kind = String(auth ?? (secret ? "wpa2" : "open")).trim().toLowerCase();
  const scheme =
    kind === "open"
      ? { authentication: "OPEN", encryption: "NONE", key: false }
      : kind === "wpa3"
        ? { authentication: "WPA3SAE", encryption: "AES", key: true }
        : kind === "wpa"
          ? { authentication: "WPAPSK", encryption: "AES", key: true }
          : { authentication: "WPA2PSK", encryption: "AES", key: true };
  if (scheme.key && !secret) throw new Error(`a ${kind} profile needs a password`);

  const escapedName = xmlEscape(name);
  const security = [
    "      <security>",
    "        <authEncryption>",
    `          <authentication>${scheme.authentication}</authentication>`,
    `          <encryption>${scheme.encryption}</encryption>`,
    "          <useOneX>false</useOneX>",
    "        </authEncryption>",
  ]
    .concat(
      scheme.key
        ? [
            "        <sharedKey>",
            "          <keyType>passPhrase</keyType>",
            "          <protected>false</protected>",
            `          <keyMaterial>${xmlEscape(secret)}</keyMaterial>`,
            "        </sharedKey>",
          ]
        : [],
    )
    .concat(["      </security>"]);

  return [
    '<?xml version="1.0"?>',
    '<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">',
    `  <name>${escapedName}</name>`,
    "  <SSIDConfig>",
    "    <SSID>",
    `      <name>${escapedName}</name>`,
    "    </SSID>",
    "  </SSIDConfig>",
    "  <connectionType>ESS</connectionType>",
    "  <connectionMode>auto</connectionMode>",
    "  <MSM>",
    ...security,
    "  </MSM>",
    "</WLANProfile>",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------- probing

/** Why an adapter would list nothing at all, in the words Windows uses for it. */
const RADIO_OFF_RE = /powered down|radio (?:is )?(?:off|turned off|disabled)|turn on (?:the )?(?:wi-?fi|wireless)|wireless is (?:off|disabled)/i;
const SERVICE_OFF_RE = /Wireless AutoConfig Service|WLAN AutoConfig Service|wlansvc/i;
const NO_INTERFACE_RE = /no wireless interface/i;

const STATE_CONNECTED = "connected";
// States in which Windows is already trying: a connect request sent now lands in
// the middle of a handshake and its answer means nothing.
const BUSY_STATES = new Set(["authenticating", "associating"]);

function emptyState(at, platform) {
  return {
    at,
    platform,
    supported: false,
    available: false,
    note: "",
    interface: null,
    networks: [],
    saved: [],
    errors: [],
    radio: null,
    interfaces: 0,
    metered: null,
  };
}

/**
 * One read-only look at the Wi-Fi adapter, as data.
 *
 * This is what the page polls and what the tools report, so it returns a
 * structure and never throws: a missing adapter, a stopped WLAN service and a
 * radio that is off are states the page has to draw honestly, not failures.
 *
 * `supported` answers "can this platform switch Wi-Fi at all"; `available`
 * answers "does this machine have an adapter to switch with". Both are needed,
 * because a Windows box with no wireless card is a different page than a Linux
 * box, and the panel says which one it is.
 */
export async function probeWifi({ run = defaultRun, platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS, includeCost = true } = {}) {
  const at = Date.now();
  const state = emptyState(at, platform);

  if (platform !== "win32") {
    state.supported = false;
    state.note = `Wi-Fi switching is Windows only: it uses netsh wlan, which does not exist on ${platform}. Nothing was probed and nothing can be joined from here.`;
    return state;
  }

  state.supported = true;

  try {
    const interfaces = await netsh(run, SHOW_INTERFACES, timeoutMs);
    if (interfaces.error) state.errors.push(interfaces.error);

    const iface = parseInterfaces(interfaces.text);
    state.interfaces = iface.count;

    if (!iface.count) {
      state.available = false;
      state.note = NO_INTERFACE_RE.test(interfaces.text)
        ? "This machine has no wireless interface: netsh wlan show interfaces reports none. There is nothing to scan and nothing to join."
        : "netsh wlan show interfaces listed no wireless interface on this machine, so there is nothing to scan or join.";
      return state;
    }

    state.available = true;
    state.interface = {
      name: iface.name,
      description: iface.description,
      state: iface.state || "not reported",
      ssid: iface.ssid,
      bssid: iface.bssid,
      signal: iface.signal,
      signalPercent: iface.signalPercent,
      auth: iface.auth,
      cipher: iface.cipher,
      channel: iface.channel,
      band: iface.band,
      rxKbps: iface.rxKbps,
      txKbps: iface.txKbps,
      profile: iface.profile,
      radio: iface.radio,
    };

    // The two lists are independent, so they go out together: a page that polls
    // every five seconds cannot afford two scan latencies in series.
    const [networks, profiles] = await Promise.all([
      netsh(run, SHOW_NETWORKS, timeoutMs),
      netsh(run, SHOW_PROFILES, timeoutMs),
    ]);

    // The quirk worth handling: `show networks` lists what the WLAN service last
    // scanned, so a radio that is off produces an empty list that is not an empty
    // room. Windows says "powered down" in words, and that is what is reported.
    const radioOff = SERVICE_OFF_RE.test(networks.text)
      ? "service"
      : RADIO_OFF_RE.test(networks.text) || iface.radio === "off"
        ? "off"
        : null;
    state.radio = iface.radio;
    if (radioOff === "service") {
      state.radio = "service";
      state.note = "The WLAN AutoConfig service is not running, so Windows will not scan or connect. Start it in Services, then refresh.";
    } else if (radioOff === "off") {
      state.radio = "off";
      state.note = "The Wi-Fi radio is off, so Windows has no networks to list. Turn it on (Settings > Network > Wi-Fi, or the hardware switch), then refresh.";
    }

    if (networks.error) state.errors.push(networks.error);
    state.networks = radioOff ? [] : parseNetworks(networks.text);

    if (profiles.error) state.errors.push(profiles.error);
    state.saved = parseProfiles(profiles.text);

    const connectedSsid = iface.state === STATE_CONNECTED ? iface.ssid : "";
    const saved = new Set(state.saved.map((name) => name.toLowerCase()));
    const connectedKey = connectedSsid.toLowerCase();
    state.networks = state.networks.map((network) => ({
      ...network,
      saved: saved.has(network.ssid.toLowerCase()),
      connected: Boolean(connectedKey) && network.ssid.toLowerCase() === connectedKey,
    }));

    // Cost (metered) is per profile and only readable for the network the adapter
    // is actually on. It is one extra netsh call, and only while connected.
    if (includeCost && connectedSsid) {
      const profile = await netsh(run, ["wlan", "show", "profile", `name=${connectedSsid}`], timeoutMs);
      if (profile.code === 0) {
        const cost = parseCost(profile.text);
        const metered = cost.cost === "fixed" || cost.cost === "unknown";
        state.metered = {
          metered,
          cost: cost.cost,
          congested: cost.congested,
          approachingDataLimit: cost.approachingDataLimit,
          overDataLimit: cost.overDataLimit,
          source: cost.source,
          note: metered
            ? `Windows marks this link as ${cost.cost}; the metered setting belongs to the profile, so this plugin reports it and does not change it.`
            : null,
        };
      } else {
        state.errors.push(profile.error ?? "netsh wlan show profile failed");
      }
    }

    return state;
  } catch (err) {
    // Last line of defence: the page polls this, so it must never take the page
    // down with it.
    state.available = false;
    state.note = `The Wi-Fi probe failed before it could read the adapter: ${reason(err)}`;
    state.errors.push(state.note);
    return state;
  }
}

// ----------------------------------------------------------------- connecting

function sameSsid(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/** The profile scheme to write for a network the scan reported. */
function authFor(security) {
  if (security === "open") return "open";
  if (security === "wpa3") return "wpa3";
  if (security === "wpa") return "wpa";
  return "wpa2";
}

/** Everything connectWifi returns is built here, so a secret cannot reach it by accident. */
function result({ ok, requested, reported = null, message, tries = 0, state = null, metered = null, transport = null }) {
  return {
    ok: Boolean(ok),
    // What the driver says it is on when there is an answer, otherwise the request.
    ssid: reported ?? requested,
    requested,
    reported: reported || null,
    message: String(message ?? ""),
    tries,
    verified: Boolean(ok),
    state,
    metered,
    // The stack the request took: "saved-profile" or "new-profile". Reported so a
    // caller can tell a reconnect from an import without guessing.
    transport,
  };
}

/**
 * Join one network, and prove it joined.
 *
 * Two paths, decided by `netsh wlan show profiles`:
 *
 *   saved  `netsh wlan connect name=<profile> ssid=<ssid>` - no password exists
 *          to this module at all; Windows already holds the key.
 *   new    the network needs a profile before connect can name it, so
 *          `profileXml()` is written to a temp file, imported with
 *          `netsh wlan add profile filename=<file> user=current`, connected, and
 *          the file is deleted in a `finally` whether the attempt worked or not.
 *
 * Then the driver is asked. `netsh wlan connect` exiting 0 means "the request was
 * accepted", not "the machine is on that network" - a wrong key, a network that
 * went away and a driver that ignored the request all exit 0 - so the interface
 * is sampled up to three times, 1.5 s apart, and only an adapter that reports the
 * requested SSID is `ok: true`.
 *
 * The returned object never carries the password. `attempts` and `intervalMs` are
 * injectable so a test can sample without waiting 4.5 seconds.
 */
export async function connectWifi({
  ssid,
  password = null,
  run = defaultRun,
  platform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = VERIFY_ATTEMPTS,
  intervalMs = VERIFY_INTERVAL_MS,
} = {}) {
  const requested = String(ssid ?? "").trim();
  const secret = typeof password === "string" && password ? password : null;
  const fail = (message, extra = {}) => result({ ok: false, requested, message: redact(message, secret), ...extra });

  if (platform !== "win32") return fail(`Wi-Fi switching is Windows only: netsh wlan does not exist on ${platform}.`);
  if (!requested) return fail("An SSID is required: there is nothing to connect to.");
  if (requested.includes("\u0000")) return fail("That SSID contains a null character, which no Windows network can have.");

  const bytes = Buffer.byteLength(requested, "utf8");
  if (bytes > MAX_SSID_BYTES) {
    return fail(`"${requested}" is ${bytes} bytes long; a Wi-Fi SSID is at most ${MAX_SSID_BYTES} bytes, so no adapter can be on that network.`);
  }

  // ---- the adapter, before anything is attempted -------------------------
  const interfaces = await netsh(run, SHOW_INTERFACES, timeoutMs);
  const iface = parseInterfaces(interfaces.text);
  if (!iface.count) {
    return fail(
      NO_INTERFACE_RE.test(interfaces.text)
        ? "This machine has no wireless interface, so there is nothing to connect. Nothing was attempted."
        : `This machine has no wireless interface to connect with (${interfaces.error ?? "netsh listed no interface"}). Nothing was attempted.`,
    );
  }

  const current = iface;
  if (current.radio === "off") {
    return fail("The Wi-Fi radio is off, and this plugin cannot switch a radio on. Turn it on in Windows, then try again.");
  }
  if (BUSY_STATES.has(current.state)) {
    return fail(
      `The adapter is currently "${current.state}", which is a state this plugin cannot change while Windows is already trying. Wait a moment, then try again.`,
    );
  }

  // ---- is it a network this machine already knows? -----------------------
  // A profile list that could not be read is a refusal, not a guess: treating a
  // saved network as new would import a second profile over the one Windows
  // already holds, with whatever security the scan guessed at.
  const profiles = await netsh(run, SHOW_PROFILES, timeoutMs);
  if (profiles.code !== 0) {
    return fail(`The saved Wi-Fi profiles could not be read, so a saved network cannot be told from a new one: ${firstLine(profiles.text) || "netsh wlan show profiles returned nothing"}. Nothing was attempted.`);
  }
  const saved = parseProfiles(profiles.text);
  const isSaved = saved.some((name) => sameSsid(name, requested));

  // Already there: the only state left to change would be the metered flag, which
  // belongs to the profile and to the person, not to this plugin.
  if (current.state === STATE_CONNECTED && sameSsid(current.ssid, requested)) {
    const cost = await netsh(run, ["wlan", "show", "profile", `name=${requested}`], timeoutMs);
    const parsed = cost.code === 0 ? parseCost(cost.text) : { cost: null };
    const metered = parsed.cost === "fixed" || parsed.cost === "unknown";
    if (metered) {
      return fail(
        `Already connected to "${current.ssid}", and Windows marks that link as ${parsed.cost} (metered). That setting belongs to the profile and this plugin cannot change it; change it in Windows Settings if that is what you meant.`,
        { reported: current.ssid, metered: { ...parsed, metered: true } },
      );
    }
    return result({
      ok: true,
      requested,
      reported: current.ssid,
      message: `Already connected to "${current.ssid}" - the adapter reports it, so nothing was sent.`,
      tries: 0,
      state: current.state,
      transport: "already-connected",
    });
  }

  // ---- a new network needs to say what kind of security it has -----------
  let auth = null;
  if (!isSaved) {
    const scan = await netsh(run, SHOW_NETWORKS, timeoutMs);
    const visible = parseNetworks(scan.text).find((network) => sameSsid(network.ssid, requested));
    if (!visible) {
      return fail(
        `"${requested}" is not in the scan Windows last made and it is not a saved network. Refresh the page and pick it from the list - a network the machine has never seen needs its name exactly as Windows prints it.`,
      );
    }
    if (visible.security === "wpa2-enterprise" || visible.security === "wpa3-enterprise" || visible.security === "wpa-enterprise") {
      return fail(
        `"${requested}" is ${securityLabel(visible.security)}: it needs a username, a domain and often a certificate, and this page has nowhere to type those. Join it once from Windows' Wi-Fi list, then it becomes a saved profile this page can reconnect.`,
      );
    }
    if (visible.security === "wep") {
      return fail(
        `"${requested}" uses WEP, which is broken and not supported here. Join it once from Windows' own Wi-Fi list if you must, and this page can reconnect to the saved profile afterwards.`,
      );
    }
    auth = authFor(visible.security);
    if (auth !== "open" && !secret) {
      return fail(
        `"${requested}" is not a saved network, so it needs its password before Windows can be asked to join it. Open it from the list and type the password.`,
      );
    }
    if (secret && auth !== "open" && secret.length < 8) {
      return fail(`A WPA password must be at least 8 characters; the one for "${requested}" is ${secret.length}.`);
    }
  }

  // ---- attempt -----------------------------------------------------------
  let transport = "saved-profile";
  let attemptError = null;

  if (isSaved) {
    const connected = await netsh(run, ["wlan", "connect", `name=${requested}`, `ssid=${requested}`], timeoutMs);
    if (connected.code !== 0) attemptError = connected.error;
  } else {
    transport = "new-profile";
    const file = join(tmpdir(), `rosalena-wifi-${randomUUID()}.xml`);
    try {
      writeFileSync(file, profileXml({ ssid: requested, password: secret, auth }), { encoding: "utf8", mode: 0o600 });
      const added = await netsh(run, ["wlan", "add", "profile", `filename=${file}`, "user=current"], timeoutMs);
      if (added.code !== 0) {
        attemptError = added.error;
      } else {
        const connected = await netsh(run, ["wlan", "connect", `name=${requested}`, `ssid=${requested}`], timeoutMs);
        if (connected.code !== 0) attemptError = connected.error;
      }
    } finally {
      // The one place the password ever landed. It goes away even when the import
      // failed, and the failure above is reported without the file's contents.
      try {
        unlinkSync(file);
      } catch {
        /* already gone, or Windows is holding it; either way nothing is reported about it */
      }
    }
  }

  // ---- verify: ask the driver, not the exit code -------------------------
  let reported = null;
  let tries = 0;
  const limit = Math.max(1, Math.min(10, Number(attempts) || VERIFY_ATTEMPTS));
  const gap = Math.max(0, Number(intervalMs) || 0);
  for (let i = 0; i < limit; i += 1) {
    if (i > 0 && gap) await sleep(gap);
    tries += 1;
    const sample = await netsh(run, SHOW_INTERFACES, timeoutMs);
    const now = parseInterfaces(sample.text);
    reported = now.state === STATE_CONNECTED ? now.ssid : "";
    if (reported && sameSsid(reported, requested)) {
      return result({
        ok: true,
        requested,
        reported,
        message: `Connected to "${reported}" - the adapter reports that network.${transport === "new-profile" ? " The profile Windows now holds was imported from a temporary file, which has been deleted." : ""}`,
        tries,
        state: now.state,
        transport,
      });
    }
  }

  // One last read so the message can say what the machine is actually on.
  const last = await netsh(run, SHOW_INTERFACES, timeoutMs);
  const after = parseInterfaces(last.text);
  const onSomething = after.state === STATE_CONNECTED ? after.ssid : null;
  const detail = onSomething
    ? `the adapter still reports "${onSomething}"`
    : after.state
      ? `the adapter is "${after.state}" with no network`
      : "the adapter reported no state at all";

  return fail(
    `Windows accepted the request for "${requested}"${attemptError ? ` (${attemptError})` : ""}, but after ${tries} check${tries === 1 ? "" : "s"} ${detail}, so this is not reported as connected. The password may be wrong, the network may have gone out of range, or the driver may have refused the association.`,
    { reported: onSomething, tries, state: after.state, transport },
  );
}

// ------------------------------------------------------------------- reports

const FIELD = 10;
const row = (label, text) => `  ${String(label).padEnd(FIELD)}${text}`;

/** A kbit/s reading as a person reads it: 344 Mbps, not 344000. */
export function formatRate(kbps) {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return "not reported";
  if (kbps >= 1_000_000) return `${(kbps / 1_000_000).toFixed(1)} Gbps`;
  if (kbps >= 1000) return `${Math.round(kbps / 1000)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

/**
 * The status command's answer: one screen, and an honest empty state.
 *
 * The three not-available states are written out separately because they lead to
 * different actions: a non-Windows machine is the wrong tool, a machine with no
 * adapter is the wrong machine, and a radio that is off is the right machine with
 * a switch to find.
 */
export function formatWifiReport(state) {
  const lines = ["wi-fi on this machine - netsh wlan (Windows)"];
  if (!state.supported) {
    lines.push(`  ${state.note}`);
    lines.push("            Nothing was scanned, nothing was attempted.");
    return lines.join("\n");
  }
  if (!state.available) {
    lines.push(`  unavailable - ${state.note}`);
    for (const error of state.errors) lines.push(`            ${error}`);
    lines.push("            Nothing can be joined from here, and nothing was attempted.");
    return lines.join("\n");
  }

  const iface = state.interface ?? {};
  const on = iface.state === STATE_CONNECTED && iface.ssid;
  lines.push(row("status", on ? `connected to "${iface.ssid}"` : `not connected (adapter "${iface.state || "state not reported"}")`));
  lines.push(row("adapter", `${iface.name || "not reported"}${iface.description ? ` (${iface.description})` : ""}`));
  if (on) {
    const auth = iface.auth || "authentication not reported";
    lines.push(row("security", `${auth}${iface.cipher ? `, cipher ${iface.cipher}` : ""}`));
    if (iface.signal) lines.push(row("signal", iface.signal));
    if (iface.channel !== null && iface.channel !== undefined) {
      lines.push(row("channel", `${iface.channel}${iface.band ? ` (${iface.band})` : " (band not derivable)"}`));
    }
    lines.push(row("rates", `${formatRate(iface.rxKbps)} down, ${formatRate(iface.txKbps)} up`));
  }
  if (state.radio === "off") lines.push(row("radio", "off - Windows will not scan until it is on"));
  if (state.radio === "service") lines.push(row("radio", "WLAN AutoConfig service is not running"));
  if (state.metered) {
    lines.push(row("metered", `${state.metered.cost ?? "not reported"}${state.metered.metered ? " - Windows marks this link as metered, and this plugin cannot change that setting" : ""}`));
  }

  lines.push(row("saved", state.saved.length ? `${state.saved.length} profile(s): ${state.saved.slice(0, 6).join(", ")}${state.saved.length > 6 ? ", ..." : ""}` : "no saved profiles on this machine"));

  const networks = state.networks ?? [];
  const connectedCount = networks.filter((network) => network.connected).length;
  lines.push(row("visible", `${networks.length} network(s)${networks.length ? `, ${connectedCount} connected, ${networks.filter((n) => n.saved).length} saved` : ""}`));
  if (!networks.length) {
    lines.push("            no network is listed. Windows shows only what its WLAN service last scanned, so an empty");
    lines.push("            list can be a radio that is off, a service that is stopped, or simply nothing in range.");
  }
  for (const network of networks) {
    const marks = [network.connected ? "connected" : null, network.saved ? "saved" : "new"].filter(Boolean).join(", ");
    lines.push(
      `            ${String(network.ssid).padEnd(28)} ${String(network.signal || "-").padStart(4)}  ${(network.band || "-").padEnd(8)} ${String(network.channel ?? "-").padStart(3)}  ${securityLabel(network.security).padEnd(14)} ${marks}`,
    );
  }

  for (const error of state.errors) lines.push(row("error", error));
  return lines.join("\n");
}

/** The scan command's answer: the list alone, for a caller that does not want the adapter. */
export function formatNetworks(state) {
  if (!state.supported || !state.available) return `no networks to list - ${state.note}`;
  const networks = state.networks ?? [];
  if (!networks.length) {
    return `no networks listed${state.note ? ` - ${state.note}` : ". Windows shows only what its WLAN service last scanned."}`;
  }
  return networks
    .map((network) => `${network.ssid} - ${network.signal || "signal not reported"}${network.band ? `, ${network.band}` : ""}, channel ${network.channel ?? "?"}, ${securityLabel(network.security)}, ${network.saved ? "saved" : "new"}${network.connected ? ", connected" : ""}`)
    .join("\n");
}

// --------------------------------------------------------------------- module

/**
 * The plugin object.
 *
 * Both tools are read-only, and that is a decision rather than a shortcut: a Wi-Fi
 * switch drops the machine off the network mid-run, and a password is something a
 * person types, not something a model supplies. So the model can see the adapter
 * and the networks, and joining is a human action - the page's button, or
 * `/wifi-switcher join <ssid>` for a profile Windows already holds.
 */
export default {
  id: "rosa-wifi-switcher",
  description: "See the Wi-Fi networks this machine can see and connect to one - a saved profile, or a new network with a password typed on the page.",

  commands(ctx) {
    const config = () => ctx?.config ?? {};
    const run = ctx?.run ?? defaultRun;
    const probe = () =>
      probeWifi({
        run,
        platform: config().platform,
        timeoutMs: config().timeoutMs,
        includeCost: config().includeCost !== false,
      });
    return {
      // What `/plugins` cannot answer: which network this machine is on, and what
      // else is reachable.
      status: async () => formatWifiReport(await probe()),
      scan: async () => formatNetworks(await probe()),
      /*
       * `join <ssid>` deliberately takes no password. A password on a command line
       * is a password in shell history and in the harness's command log, and there
       * is no way to hand it over that is not a file or an argument - so a new
       * network is joined from the page, and this command only reconnects a profile
       * Windows already holds.
       */
      join: async (argv = []) => {
        const ssid = String(argv[0] ?? "").trim();
        if (!ssid) return "usage: join <ssid> - reconnects a network Windows already has a profile for. A new network is joined from the network page, where the password can be typed.";
        if (argv.length > 1) return "a password is never taken on a command line, and this command does not want one: `join <ssid>` reconnects a saved profile only. A new network is joined from the network page.";
        const outcome = await connectWifi({ ssid, run, platform: config().platform, timeoutMs: config().timeoutMs, attempts: config().verifyAttempts, intervalMs: config().verifyIntervalMs });
        return outcome.message;
      },
    };
  },

  tools(ctx) {
    const config = () => ctx?.config ?? {};
    const run = ctx?.run ?? defaultRun;
    const probe = () => probeWifi({ run, platform: config().platform, timeoutMs: config().timeoutMs, includeCost: config().includeCost !== false });
    return [
      {
        name: "wifi_status",
        description:
          "One read-only look at this machine's Wi-Fi: which adapter, whether it is connected and to what (signal, security, channel, band, rates), whether the link is metered, the saved profiles, and the networks Windows last saw. Use it to answer 'what network is this?' without opening a shell. It never connects, disconnects or changes a setting.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async run() {
          try {
            return formatWifiReport(await probe());
          } catch (err) {
            return `wifi_status could not read the adapter: ${reason(err)}`;
          }
        },
      },
      {
        name: "wifi_networks",
        description:
          "The Wi-Fi networks Windows last scanned, one line each: name, signal, band, channel, security, and whether a saved profile exists. Read-only, and empty when the radio is off or the WLAN service is stopped.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async run() {
          try {
            return formatNetworks(await probe());
          } catch (err) {
            return `wifi_networks could not read the adapter: ${reason(err)}`;
          }
        },
      },
    ];
  },

  /*
   * Static on purpose, in the same spirit as local-model-monitor: loading the
   * harness, or printing the plugin list, must not depend on an adapter existing,
   * a radio being on, or netsh answering inside a timeout.
   */
  status: (ctx) => {
    const platform = ctx?.config?.platform ?? process.platform;
    if (platform !== "win32") return `wifi switching: Windows only (this is ${platform}); nothing is probed at load`;
    return "wifi switching: netsh wlan - saved profiles reconnect, new networks need a password typed on /network";
  },
};
