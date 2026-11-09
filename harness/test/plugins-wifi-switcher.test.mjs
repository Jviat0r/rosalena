// The wifi-switcher plugin, tested without a radio.
//
// Nothing here runs netsh, and nothing here needs a network: `probeWifi` and
// `connectWifi` take an injectable runner, so the interesting cases are the ones
// a real adapter cannot be made to do on demand - no adapter at all, a radio that
// is off, a network the machine has never joined, a driver that accepts the
// connect command and stays on the old network anyway.
//
// The transcripts in the constants are not invented. INTERFACES_CONNECTED and
// NETWORKS_ONE are the output of this machine's Intel AX210, pasted as printed
// (trailing spaces included, because netsh prints them). The disconnected
// variant, the multi-network transcript and the radio-off transcript follow the
// shapes netsh prints for those states; the test says which is which where it
// matters. The multi-network one merges three BSSIDs of one SSID, which is the
// case a real scan produces and this room's single access point does not.
//
// A password appears in exactly one place in these assertions: the temp profile
// file Windows needs, read at the moment of import, and proven deleted afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

import wifiSwitcher, {
  bandOf,
  connectWifi,
  formatWifiReport,
  parseCost,
  parseInterfaces,
  parseNetworks,
  parseProfiles,
  profileXml,
  probeWifi,
  securityOf,
} from "../plugins/rosa-wifi-switcher/plugin.mjs";

// Captured from this machine: an Intel(R) Wi-Fi 6E AX210, associated to an open
// public network. This is netsh's output verbatim.
const INTERFACES_CONNECTED = `
There is 1 interface on the system: 

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX210 160MHz
    GUID                   : c191a154-1628-4165-9702-c9c5fc3b749f
    Physical address       : 4c:77:cb:9e:3d:7e
    State                  : connected
    SSID                   : WhiteSky-PublicWiFi
    BSSID                  : a8:3a:79:23:1c:02
    Network type           : Infrastructure
    Radio type             : 802.11ax
    Authentication         : Open
    Cipher                 : None
    Connection mode        : Profile
    Channel                : 116
    Receive rate (Mbps)    : 344
    Transmit rate (Mbps)   : 574
    Signal                 : 91% 
    Profile                : WhiteSky-PublicWiFi 

    Hosted network status  : Not available
`;

// The same adapter, not associated. netsh omits SSID, BSSID, authentication,
// cipher, channel and the rates in this state - which is why a parser that
// defaulted them to "" instead of null would lie about a connection.
const INTERFACES_DISCONNECTED = `
There is 1 interface on the system: 

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX210 160MHz
    GUID                   : c191a154-1628-4165-9702-c9c5fc3b749f
    Physical address       : 4c:77:cb:9e:3d:7e
    State                  : disconnected

    Hosted network status  : Not available
`;

// A radio that is switched off. Some drivers print this line in `show interfaces`
// and some only say "powered down" in `show networks`; both are covered.
const INTERFACES_RADIO_OFF = `
There is 1 interface on the system: 

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX210 160MHz
    GUID                   : c191a154-1628-4165-9702-c9c5fc3b749f
    Physical address       : 4c:77:cb:9e:3d:7e
    State                  : disconnected
    Radio status           : Hardware Off

    Hosted network status  : Not available
`;

// netsh's answer on a machine with no WLAN adapter at all.
const INTERFACES_NONE = `
There is no wireless interface on the system.
`;

// Captured from this machine, verbatim: one network, one BSSID.
const NETWORKS_ONE = `
Interface name : Wi-Fi 
There are 1 networks currently visible. 

SSID 1 : WhiteSky-PublicWiFi
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None 
    BSSID 1                 : a8:3a:79:23:1c:02
         Signal             : 91%  
         Radio type         : 802.11ax
         Channel            : 116 
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54
`;

// The shape a scan with neighbours produces: three access points broadcasting
// one name (merged into one row), an open cafe on 2.4 GHz, a hidden network with
// no name, and a WPA3 network on channel 6.
const NETWORKS_MULTI = `
Interface name : Wi-Fi 
There are 5 networks currently visible. 

SSID 1 : MyNet
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP 
    BSSID 1                 : a8:3a:79:23:1c:02
         Signal             : 88%  
         Radio type         : 802.11ax
         Channel            : 44 
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54
    BSSID 2                 : a8:3a:79:23:1c:03
         Signal             : 62%  
         Radio type         : 802.11ax
         Channel            : 44 
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54
    BSSID 3                 : a8:3a:79:23:1c:04
         Signal             : 74%  
         Radio type         : 802.11ax
         Channel            : 44 
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54

SSID 2 : Cafe
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None 
    BSSID 1                 : 00:11:22:33:44:55
         Signal             : 40%  
         Radio type         : 802.11n
         Channel            : 6 
         Basic rates (Mbps) : 1 2 5.5 11
         Other rates (Mbps) : 6 9 12 18 24 36 48 54

SSID 3 : 
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP 
    BSSID 1                 : 0a:0b:0c:0d:0e:0f
         Signal             : 55%  
         Radio type         : 802.11ax
         Channel            : 6 
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54

SSID 4 : Office5G
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP 
    BSSID 1                 : 11:22:33:44:55:66
         Signal             : 28%  
         Radio type         : 802.11ax
         Channel            : 6 
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54
`;

// What Windows says when the radio is off: a sentence, not an empty list.
const NETWORKS_POWERED_DOWN = `
The wireless local area network interface is powered down and doesn't support the requested operation.
`;

// Captured from this machine, cut to three names: the group-policy section and
// its <None>, the "User profiles" title, and the rule lines under each heading.
const PROFILES = `
Profiles on interface Wi-Fi:

Group policy profiles (read only)
---------------------------------
    All User Profile     : <None>

User profiles
-------------
    All User Profile     : WhiteSky-PublicWiFi
    All User Profile     : The Varsity Guest
    All User Profile     : MyNet

`;

/** The cost block of `netsh wlan show profile name=<ssid>`, as Windows prints it. */
const PROFILE_COST = `
Profile WhiteSky-PublicWiFi on interface Wi-Fi: 
======================================================================= 

Applied: All User Profile    

Profile information 
------------------- 
    Version                : 1
    Type                   : Wireless LAN
    Name                   : WhiteSky-PublicWiFi

Security settings 
----------------- 
    Authentication         : Open
    Cipher                 : None
    Security key           : Absent

Cost settings 
------------- 
    Cost                   : Unrestricted
    Congested              : No
    Approaching Data Limit : No
    Over Data Limit        : No
    Roaming                : No
    Cost Source            : Default
`;

/**
 * A `show interfaces` transcript for an associated adapter, in the exact layout
 * the captured one uses. Used for the states the captured transcript cannot be
 * put in on demand (a different SSID after a connect, a different signal).
 */
function interfaceTranscript({ ssid, auth = "WPA2-Personal", signal = 88, channel = 44, rx = 344, tx = 574 } = {}) {
  return `
There is 1 interface on the system: 

    Name                   : Wi-Fi
    Description            : Intel(R) Wi-Fi 6E AX210 160MHz
    GUID                   : c191a154-1628-4165-9702-c9c5fc3b749f
    Physical address       : 4c:77:cb:9e:3d:7e
    State                  : connected
    SSID                   : ${ssid}
    BSSID                  : a8:3a:79:23:1c:02
    Network type           : Infrastructure
    Radio type             : 802.11ax
    Authentication         : ${auth}
    Cipher                 : CCMP 
    Connection mode        : Profile
    Channel                : ${channel}
    Receive rate (Mbps)    : ${rx}
    Transmit rate (Mbps)   : ${tx}
    Signal                 : ${signal}% 
    Profile                : ${ssid} 

    Hosted network status  : Not available
`;
}

/**
 * A netsh that answers from a script instead of from a radio.
 *
 * `interfaceAfterConnect` is what `show interfaces` says once `wlan connect` has
 * been called - the whole point of the verification tests, because a stub that
 * jumped straight to the new network would prove nothing about polling.
 */
function fakeNetsh({
  interfaces = INTERFACES_DISCONNECTED,
  networks = NETWORKS_MULTI,
  profiles = PROFILES,
  profileInfo = PROFILE_COST,
  interfaceAfterConnect = null,
  connect = { code: 0, stdout: "", stderr: "" },
  add = { code: 0, stdout: "", stderr: "" },
  interfacesCode = 0,
  onCall = null,
} = {}) {
  const calls = [];
  let connected = false;
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const line = [command, ...args].join(" ");
    if (onCall) onCall({ command, args, line });
    if (line === "netsh wlan show interfaces") {
      const text = connected && interfaceAfterConnect !== null ? interfaceAfterConnect : interfaces;
      return { code: interfacesCode, stdout: text, stderr: "" };
    }
    if (line === "netsh wlan show networks mode=bssid") return { code: 0, stdout: networks, stderr: "" };
    if (line === "netsh wlan show profiles") return { code: 0, stdout: profiles, stderr: "" };
    if (line.startsWith("netsh wlan show profile name=")) return { code: 0, stdout: profileInfo, stderr: "" };
    if (line.startsWith("netsh wlan add profile")) return add;
    if (line.startsWith("netsh wlan connect")) {
      connected = true;
      return connect;
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${line}` };
  };
  return {
    run,
    calls,
    lines: () => calls.map((entry) => entry.join(" ")),
  };
}

/** A run that must never be called, for the refusals that happen before any netsh. */
function forbiddenRun() {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    throw new Error(`the plugin should not have run: ${[command, ...args].join(" ")}`);
  };
  return { run, calls };
}

// ------------------------------------------------------------------ parsers

test("parseInterfaces reads the captured connected transcript", () => {
  const parsed = parseInterfaces(INTERFACES_CONNECTED);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.name, "Wi-Fi");
  assert.equal(parsed.state, "connected");
  assert.equal(parsed.ssid, "WhiteSky-PublicWiFi");
  assert.equal(parsed.bssid, "a8:3a:79:23:1c:02");
  assert.equal(parsed.signal, "91%");
  assert.equal(parsed.signalPercent, 91);
  assert.equal(parsed.auth, "Open");
  assert.equal(parsed.cipher, "None");
  assert.equal(parsed.channel, 116);
  assert.equal(parsed.band, "5 GHz");
  assert.equal(parsed.rxKbps, 344_000);
  assert.equal(parsed.txKbps, 574_000);
  assert.match(parsed.description, /Intel\(R\) Wi-Fi 6E AX210/);
  // No Radio status line in this build: unknown is null, never "on".
  assert.equal(parsed.radio, null);
});

test("parseInterfaces reads a disconnected transcript without inventing a connection", () => {
  const parsed = parseInterfaces(INTERFACES_DISCONNECTED);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.state, "disconnected");
  assert.equal(parsed.ssid, "");
  assert.equal(parsed.auth, "");
  assert.equal(parsed.channel, null);
  assert.equal(parsed.band, "");
  assert.equal(parsed.signal, "");
  assert.equal(parsed.signalPercent, null);
  // A missing rate is null, not zero: zero is a measurement.
  assert.equal(parsed.rxKbps, null);
  assert.equal(parsed.txKbps, null);
});

test("parseInterfaces returns nothing for a machine with no adapter", () => {
  const parsed = parseInterfaces(INTERFACES_NONE);
  assert.equal(parsed.count, 0);
  assert.deepEqual(parsed.interfaces, []);
  assert.equal(parsed.name, "");
  assert.equal(parsed.state, "not reported");
});

test("parseInterfaces reads a radio that is off", () => {
  const parsed = parseInterfaces(INTERFACES_RADIO_OFF);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.radio, "off");
  assert.equal(parsed.state, "disconnected");
});

test("parseNetworks merges BSSIDs, skips the hidden SSID and derives the band", () => {
  const networks = parseNetworks(NETWORKS_MULTI);
  // Four SSID lines, one of them hidden: three networks remain.
  assert.deepEqual(
    networks.map((network) => network.ssid),
    ["MyNet", "Cafe", "Office5G"],
  );

  const mine = networks.find((network) => network.ssid === "MyNet");
  assert.equal(mine.bssids, 3, "three access points broadcasting one name are one network");
  assert.equal(mine.signal, "88%", "the merged row keeps the strongest BSSID");
  assert.equal(mine.signalPercent, 88);
  assert.equal(mine.channel, 44);
  assert.equal(mine.band, "5 GHz");
  assert.equal(mine.auth, "WPA2-Personal");
  assert.equal(mine.security, "wpa2");
  assert.equal(mine.needsPassword, true);

  const cafe = networks.find((network) => network.ssid === "Cafe");
  assert.equal(cafe.band, "2.4 GHz");
  assert.equal(cafe.channel, 6);
  assert.equal(cafe.security, "open");
  assert.equal(cafe.needsPassword, false);

  const office = networks.find((network) => network.ssid === "Office5G");
  assert.equal(office.security, "wpa3");
  assert.equal(office.needsPassword, true);

  assert.ok(!networks.some((network) => network.ssid === ""), "a hidden SSID has no name to click and is skipped");
});

test("parseNetworks reads the captured single-network transcript", () => {
  const networks = parseNetworks(NETWORKS_ONE);
  assert.equal(networks.length, 1);
  assert.deepEqual(networks[0].ssid, "WhiteSky-PublicWiFi");
  assert.equal(networks[0].signal, "91%");
  assert.equal(networks[0].channel, 116);
  assert.equal(networks[0].band, "5 GHz");
  assert.equal(networks[0].security, "open");
  assert.equal(networks[0].bssids, 1);
});

test("parseNetworks returns nothing for a radio that is powered down", () => {
  assert.deepEqual(parseNetworks(NETWORKS_POWERED_DOWN), []);
  assert.deepEqual(parseNetworks(""), []);
});

test("bandOf derives a band from the channel and refuses to guess at 6 GHz", () => {
  assert.equal(bandOf(1), "2.4 GHz");
  assert.equal(bandOf(14), "2.4 GHz");
  assert.equal(bandOf(36), "5 GHz");
  assert.equal(bandOf(116), "5 GHz");
  assert.equal(bandOf(177), "5 GHz");
  // 6 GHz channels reuse 1-233, and netsh prints no band, so a channel above the
  // 5 GHz plan is reported as unknown rather than as a guess.
  assert.equal(bandOf(233), "");
  assert.equal(bandOf(null), "");
});

test("parseProfiles reads names and ignores the header, the rules and <None>", () => {
  const names = parseProfiles(PROFILES);
  assert.deepEqual(names, ["WhiteSky-PublicWiFi", "The Varsity Guest", "MyNet"]);
  assert.ok(!names.includes("<None>"));
  assert.ok(!names.some((name) => /^-+$/.test(name)));
  assert.ok(!names.some((name) => /profile/i.test(name)), "no header line survives as a network name");
  assert.deepEqual(parseProfiles(""), []);
  assert.deepEqual(parseProfiles("Profiles on interface Wi-Fi:\n\nUser profiles\n-------------"), []);
});

test("parseCost reads the metered state Windows reports", () => {
  const cost = parseCost(PROFILE_COST);
  assert.equal(cost.cost, "unrestricted");
  assert.equal(cost.congested, false);
  assert.equal(cost.overDataLimit, false);
  assert.equal(cost.source, "Default");

  const metered = parseCost("    Cost                   : Fixed\n    Over Data Limit        : Yes\n");
  assert.equal(metered.cost, "fixed");
  assert.equal(metered.overDataLimit, true);
});

test("securityOf maps the pairs netsh prints", () => {
  assert.equal(securityOf("Open", "None"), "open");
  assert.equal(securityOf("WPA2-Personal", "CCMP"), "wpa2");
  assert.equal(securityOf("WPA3-Personal", "CCMP"), "wpa3");
  assert.equal(securityOf("WPA2-Enterprise", "CCMP"), "wpa2-enterprise");
  assert.equal(securityOf("WPA3-Enterprise 192 bits", "GCMP"), "wpa3-enterprise");
  assert.equal(securityOf("WEP", "WEP"), "wep");
  assert.equal(securityOf("", ""), "unknown");
});

// ----------------------------------------------------------------- XML

/** Assert the document is well formed: tags balance, and no text carries raw markup. */
function assertWellFormed(xml) {
  const body = String(xml).replace(/^<\?xml[^>]*\?>\s*/, "");
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  const stack = [];
  let consumed = 0;
  let match;
  while ((match = tag.exec(body))) {
    const between = body.slice(consumed, match.index);
    const withoutEntities = between.replace(/&(amp|lt|gt|quot|apos);/g, "");
    assert.ok(!/[<>&]/.test(withoutEntities), `raw markup or a bare ampersand in text: ${JSON.stringify(between)}`);
    consumed = tag.lastIndex;
    const [, closing, name, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) assert.equal(stack.pop(), name, `mismatched </${name}>`);
    else stack.push(name);
  }
  assert.deepEqual(stack, [], "every element is closed");
  assert.equal(body.slice(consumed).trim(), "", "nothing follows the root element");
}

test("profileXml escapes an SSID containing & and <, and writes WPA2 key material", () => {
  const xml = profileXml({ ssid: "Cafe & <Bar>", password: "hunter2-cafe", auth: "wpa2" });
  assertWellFormed(xml);
  assert.match(xml, /<name>Cafe &amp; &lt;Bar&gt;<\/name>/);
  assert.ok(!xml.includes("Cafe & <Bar>"), "the raw SSID is never written unescaped");
  assert.match(xml, /<authentication>WPA2PSK<\/authentication>/);
  assert.match(xml, /<encryption>AES<\/encryption>/);
  assert.match(xml, /<keyMaterial>hunter2-cafe<\/keyMaterial>/);
  assert.match(xml, /<keyType>passPhrase<\/keyType>/);
  assert.match(xml, /<protected>false<\/protected>/);
  assert.match(xml, /<connectionType>ESS<\/connectionType>/);
  assert.match(xml, /xmlns="http:\/\/www\.microsoft\.com\/networking\/WLAN\/profile\/v1"/);
});

test("profileXml writes an open profile with no key, and WPA3 when asked", () => {
  const open = profileXml({ ssid: "Cafe", password: null, auth: "open" });
  assertWellFormed(open);
  assert.match(open, /<authentication>OPEN<\/authentication>/);
  assert.match(open, /<encryption>NONE<\/encryption>/);
  assert.ok(!open.includes("<sharedKey>"), "an open network has no key material at all");
  assert.ok(!/keyMaterial/.test(open));

  const wpa3 = profileXml({ ssid: "Office5G", password: "hunter2-cafe", auth: "wpa3" });
  assertWellFormed(wpa3);
  assert.match(wpa3, /<authentication>WPA3SAE<\/authentication>/);

  // The default follows the password: with one it is WPA2, without one it is open.
  assert.match(profileXml({ ssid: "MyNet", password: "hunter2-cafe" }), /WPA2PSK/);
  assert.match(profileXml({ ssid: "Cafe" }), /<authentication>OPEN<\/authentication>/);
  assert.throws(() => profileXml({ ssid: "MyNet", password: null, auth: "wpa2" }), /needs a password/);
  assert.throws(() => profileXml({ ssid: "  " }), /needs an SSID/);
});

// ----------------------------------------------------------------- probes

test("probeWifi reports available:false with a note when there is no adapter", async () => {
  // netsh exits 1 on a machine with no WLAN adapter, which is exactly what the
  // plugin has to turn into a deliberate page rather than a crash.
  const machine = fakeNetsh({ interfaces: INTERFACES_NONE, interfacesCode: 1 });
  const state = await probeWifi({ run: machine.run, platform: "win32" });

  assert.equal(state.supported, true, "Windows is supported even when the machine has no radio");
  assert.equal(state.available, false);
  assert.equal(state.interface, null);
  assert.match(state.note, /no wireless interface/i);
  assert.deepEqual(state.networks, []);
  assert.deepEqual(state.saved, []);
  assert.ok(state.errors.length >= 1, "the failed command is reported as one line");
  assert.ok(state.errors.every((line) => typeof line === "string" && !line.includes("\n")), "one line per failed command, never a stack");
  assert.equal(state.errors[0].includes("    at "), false);
  assert.equal(typeof state.at, "number");
  assert.equal(state.platform, "win32");
});

test("probeWifi on a non-Windows platform is unsupported, with the reason", async () => {
  const forbidden = forbiddenRun();
  const state = await probeWifi({ run: forbidden.run, platform: "linux" });
  assert.equal(state.supported, false);
  assert.equal(state.available, false);
  assert.match(state.note, /Windows only/);
  assert.match(state.note, /linux/);
  assert.equal(state.interface, null);
  assert.deepEqual(state.networks, []);
  assert.deepEqual(state.errors, []);
  assert.deepEqual(forbidden.calls, [], "an unsupported platform runs no command at all");
});

test("probeWifi reports the connection, the saved profiles and the cost", async () => {
  const machine = fakeNetsh({
    interfaces: INTERFACES_CONNECTED,
    networks: NETWORKS_ONE,
    profiles: PROFILES,
    profileInfo: PROFILE_COST,
  });
  const state = await probeWifi({ run: machine.run, platform: "win32" });

  assert.equal(state.available, true);
  assert.equal(state.interface.name, "Wi-Fi");
  assert.equal(state.interface.state, "connected");
  assert.equal(state.interface.ssid, "WhiteSky-PublicWiFi");
  assert.equal(state.interface.signal, "91%");
  assert.equal(state.interface.auth, "Open");
  assert.equal(state.interface.rxKbps, 344_000);
  assert.equal(state.interface.txKbps, 574_000);

  assert.equal(state.networks.length, 1);
  assert.equal(state.networks[0].connected, true);
  assert.equal(state.networks[0].saved, true);
  assert.deepEqual(state.saved, ["WhiteSky-PublicWiFi", "The Varsity Guest", "MyNet"]);
  assert.deepEqual(state.errors, []);
  assert.equal(state.metered.metered, false);
  assert.equal(state.metered.cost, "unrestricted");
  assert.equal(state.radio, null);

  // Four reads, no writes.
  assert.deepEqual(machine.lines(), [
    "netsh wlan show interfaces",
    "netsh wlan show networks mode=bssid",
    "netsh wlan show profiles",
    "netsh wlan show profile name=WhiteSky-PublicWiFi",
  ]);
});

test("probeWifi reports a radio that is off instead of an empty room", async () => {
  const machine = fakeNetsh({
    interfaces: INTERFACES_RADIO_OFF,
    networks: NETWORKS_POWERED_DOWN,
    profiles: PROFILES,
  });
  const state = await probeWifi({ run: machine.run, platform: "win32" });

  assert.equal(state.available, true, "the adapter exists; it is the radio that is off");
  assert.equal(state.radio, "off");
  assert.match(state.note, /radio is off/i);
  assert.deepEqual(state.networks, [], "a powered-down radio yields no networks, and the note says why");
  assert.deepEqual(state.errors, [], "a radio that is off is a state, not a failed command");
});

test("probeWifi survives a runner that throws, and a failed scan is one error line", async () => {
  const state = await probeWifi({
    run: async () => {
      throw new Error("spawn netsh ENOENT");
    },
    platform: "win32",
  });
  assert.equal(state.available, false);
  assert.match(state.note, /no wireless interface/i);
  assert.ok(state.errors.some((line) => /ENOENT/.test(line)));
});

// ------------------------------------------------------------- connecting

test("connectWifi refuses a new network with no password, without adding a profile", async () => {
  // Office5G is visible in the scan, is not in the saved profiles, and is WPA3:
  // the one case where the plugin must stop and ask rather than guess.
  const machine = fakeNetsh({
    interfaces: INTERFACES_CONNECTED,
    networks: NETWORKS_MULTI,
    profiles: PROFILES,
  });
  const outcome = await connectWifi({ ssid: "Office5G", run: machine.run, platform: "win32" });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reported, null);
  assert.match(outcome.message, /not a saved network/i);
  assert.match(outcome.message, /password/i);
  assert.ok(!machine.lines().some((line) => line.includes("add profile")), "no profile was written for a password-less request");
  assert.ok(!machine.lines().some((line) => line.includes("wlan connect")), "nothing was connected either");
});

test("connectWifi reconnects a saved profile, and is ok only once the adapter reports it", async () => {
  const machine = fakeNetsh({
    // The adapter starts on something else; the connect command is what moves it.
    interfaces: interfaceTranscript({ ssid: "OldNet" }),
    networks: NETWORKS_MULTI,
    profiles: PROFILES,
    interfaceAfterConnect: interfaceTranscript({ ssid: "MyNet" }),
  });
  const outcome = await connectWifi({ ssid: "MyNet", run: machine.run, platform: "win32", intervalMs: 0 });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.reported, "MyNet");
  assert.equal(outcome.ssid, "MyNet");
  assert.equal(outcome.transport, "saved-profile");
  assert.equal(outcome.tries, 1);
  assert.match(outcome.message, /Connected to "MyNet"/);
  // No password was supplied and none is needed for a saved profile.
  assert.ok(!machine.lines().some((line) => line.includes("add profile")));

  // Exactly: read, decide, connect, verify.
  assert.deepEqual(machine.lines(), [
    "netsh wlan show interfaces",
    "netsh wlan show profiles",
    "netsh wlan connect name=MyNet ssid=MyNet",
    "netsh wlan show interfaces",
  ]);
});

test("connectWifi is not ok when the adapter stays on another network", async () => {
  const machine = fakeNetsh({
    interfaces: interfaceTranscript({ ssid: "OldNet" }),
    networks: NETWORKS_MULTI,
    profiles: PROFILES,
    // The driver accepts the command and does not move: this is the case the exit
    // code cannot see, and the reason the interface is polled.
    interfaceAfterConnect: interfaceTranscript({ ssid: "OldNet" }),
    connect: { code: 0, stdout: "Connection request was completed successfully.\r\n", stderr: "" },
  });
  const outcome = await connectWifi({ ssid: "MyNet", run: machine.run, platform: "win32", intervalMs: 0 });

  assert.equal(outcome.ok, false, "exit 0 and an unchanged adapter is not a connection");
  assert.equal(outcome.verified, false);
  assert.equal(outcome.reported, "OldNet");
  assert.equal(outcome.tries, 3, "three samples, as many as the page has patience for");
  assert.match(outcome.message, /still reports "OldNet"/);
  assert.ok(
    machine.lines().filter((line) => line === "netsh wlan show interfaces").length >= 4,
    "the adapter was read again after each sample, plus once for the message",
  );
});

test("connectWifi joins a new network from a temp profile and deletes it", async () => {
  const ssid = "Cafe & <Bar>";
  const password = "hunter2-cafe";
  let imported = null;

  const machine = fakeNetsh({
    interfaces: interfaceTranscript({ ssid: "OldNet" }),
    // The cafe's block, renamed and turned into the WPA2 network this test joins.
    // Only the cafe is Open in NETWORKS_MULTI, so these two replacements are its
    // security lines and nobody else's.
    networks: NETWORKS_MULTI.replace("SSID 2 : Cafe", `SSID 2 : ${ssid}`)
      .replace("Authentication          : Open", "Authentication          : WPA2-Personal")
      .replace("Encryption              : None ", "Encryption              : CCMP "),
    profiles: PROFILES,
    interfaceAfterConnect: interfaceTranscript({ ssid }),
    onCall: ({ args }) => {
      if (args[1] !== "add") return;
      const filename = args.find((arg) => String(arg).startsWith("filename=")).slice("filename=".length);
      // Read it at the moment netsh would have: this is the profile Windows gets.
      imported = { path: filename, body: readFileSync(filename, "utf8") };
    },
  });

  const outcome = await connectWifi({ ssid, password, run: machine.run, platform: "win32", intervalMs: 0 });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.reported, ssid);
  assert.equal(outcome.transport, "new-profile");
  assert.match(outcome.message, /temporary file, which has been deleted/);

  assert.ok(imported, "the profile file existed when netsh imported it");
  assert.equal(dirname(imported.path), tmpdir());
  assert.match(basename(imported.path), /^rosalena-wifi-[\w-]+\.xml$/);
  assert.ok(!imported.path.includes(password), "the file name carries no secret");
  assertWellFormed(imported.body);
  assert.match(imported.body, /<name>Cafe &amp; &lt;Bar&gt;<\/name>/);
  assert.match(imported.body, /<keyMaterial>hunter2-cafe<\/keyMaterial>/);
  assert.match(imported.body, /WPA2PSK/);

  assert.equal(existsSync(imported.path), false, "the temp profile is deleted, in a finally, even on success");

  // The password is in that file and nowhere else: not in the result, not in a
  // message, not on a command line.
  assert.ok(!JSON.stringify(outcome).includes(password));
  assert.ok(!outcome.message.includes(password));
  assert.ok(!machine.lines().some((line) => line.includes(password)), "never on a command line");

  assert.deepEqual(machine.lines(), [
    "netsh wlan show interfaces",
    "netsh wlan show profiles",
    "netsh wlan show networks mode=bssid",
    `netsh wlan add profile filename=${imported.path} user=current`,
    `netsh wlan connect name=${ssid} ssid=${ssid}`,
    "netsh wlan show interfaces",
  ]);
});

test("connectWifi deletes the temp profile even when the import fails", async () => {
  const password = "hunter2-cafe";
  let path = null;
  const machine = fakeNetsh({
    interfaces: interfaceTranscript({ ssid: "OldNet" }),
    networks: NETWORKS_MULTI.replace("SSID 2 : Cafe", "SSID 2 : NewNet"),
    add: { code: 1, stdout: "", stderr: "The profile was not added." },
    onCall: ({ args }) => {
      if (args[1] !== "add") return;
      path = args.find((arg) => String(arg).startsWith("filename=")).slice("filename=".length);
    },
  });
  const outcome = await connectWifi({ ssid: "NewNet", password, run: machine.run, platform: "win32", intervalMs: 0 });

  assert.equal(outcome.ok, false);
  assert.ok(path);
  assert.equal(existsSync(path), false, "a failed import still removes the file");
  assert.ok(!JSON.stringify(outcome).includes(password));
});

test("connectWifi refuses an SSID longer than 32 bytes, before touching the adapter", async () => {
  const forbidden = forbiddenRun();
  const outcome = await connectWifi({ ssid: "a".repeat(33), run: forbidden.run, platform: "win32", intervalMs: 0 });

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /33 bytes/);
  assert.match(outcome.message, /at most 32/);
  assert.deepEqual(forbidden.calls, [], "no netsh ran for a name Windows cannot have");
});

test("connectWifi refuses when there is no wireless interface", async () => {
  const machine = fakeNetsh({ interfaces: INTERFACES_NONE });
  const outcome = await connectWifi({ ssid: "MyNet", run: machine.run, platform: "win32", intervalMs: 0 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /no wireless interface/i);
  assert.ok(!machine.lines().some((line) => line.includes("wlan connect")));
});

test("connectWifi refuses a new enterprise network, which needs credentials", async () => {
  const machine = fakeNetsh({
    interfaces: interfaceTranscript({ ssid: "OldNet" }),
    // Office5G, made enterprise: visible, unsaved, and unjoinable from a password field.
    networks: NETWORKS_MULTI.replace("Authentication          : WPA3-Personal", "Authentication          : WPA3-Enterprise"),
  });
  const outcome = await connectWifi({ ssid: "Office5G", password: "hunter2-cafe", run: machine.run, platform: "win32", intervalMs: 0 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /WPA3-Enterprise/);
  assert.ok(!machine.lines().some((line) => line.includes("add profile")));
});

test("connectWifi says so plainly on a non-Windows platform", async () => {
  const forbidden = forbiddenRun();
  const outcome = await connectWifi({ ssid: "MyNet", run: forbidden.run, platform: "darwin" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Windows only/);
  assert.deepEqual(forbidden.calls, []);
});

// --------------------------------------------------------------- the plugin

test("the default export lists its commands and tools, and its status line survives a broken runner", async () => {
  // Pinned to Windows: the report is written for ctx.config.platform, so the "broken
  // runner" path stays covered on the Linux runner that gates the release.
  const broken = {
    root: process.cwd(),
    config: { platform: "win32" },
    log: () => {},
    run: async () => {
      throw new Error("the runner is a stub that fails");
    },
  };

  const commands = wifiSwitcher.commands(broken);
  assert.deepEqual(Object.keys(commands).sort(), ["join", "scan", "status"]);
  const report = await commands.status();
  assert.equal(typeof report, "string");
  assert.match(report, /wi-fi on this machine/);
  assert.match(report, /unavailable/, "a failing runner is reported, not thrown");
  assert.match(report, /no wireless interface/i);

  const tools = wifiSwitcher.tools(broken);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["wifi_networks", "wifi_status"]);
  for (const tool of tools) {
    const text = await tool.run();
    assert.equal(typeof text, "string");
    assert.ok(text.length > 0);
  }

  // The load-time status line is static: it must not touch netsh, because loading
  // the harness must not depend on an adapter answering.
  assert.equal(typeof wifiSwitcher.status(broken), "string");
  assert.match(wifiSwitcher.status({ config: { platform: "win32" } }), /netsh wlan/i);
  assert.match(wifiSwitcher.status({ config: { platform: "linux" } }), /Windows only/);
  assert.equal(typeof wifiSwitcher.description, "string");
  assert.equal(wifiSwitcher.id, "rosa-wifi-switcher");
});

test("formatWifiReport draws the three not-available states differently", () => {
  const unsupported = formatWifiReport({
    at: 0,
    platform: "linux",
    supported: false,
    available: false,
    note: "Wi-Fi switching is Windows only.",
    interface: null,
    networks: [],
    saved: [],
    errors: [],
  });
  assert.match(unsupported, /Windows only/);

  const noAdapter = formatWifiReport({
    at: 0,
    platform: "win32",
    supported: true,
    available: false,
    note: "This machine has no wireless interface.",
    interface: null,
    networks: [],
    saved: [],
    errors: [],
  });
  assert.match(noAdapter, /unavailable/);
  assert.match(noAdapter, /Nothing can be joined/);

  const connected = formatWifiReport({
    at: 0,
    platform: "win32",
    supported: true,
    available: true,
    note: "",
    interface: { name: "Wi-Fi", state: "connected", ssid: "MyNet", auth: "WPA2-Personal", cipher: "CCMP", signal: "88%", channel: 44, band: "5 GHz", rxKbps: 344_000, txKbps: 574_000 },
    networks: [{ ssid: "MyNet", signal: "88%", band: "5 GHz", channel: 44, security: "wpa2", connected: true, saved: true }],
    saved: ["MyNet"],
    errors: [],
    radio: null,
    metered: { metered: false, cost: "unrestricted" },
  });
  assert.match(connected, /connected to "MyNet"/);
  assert.match(connected, /WPA2-Personal/);
  assert.match(connected, /344 Mbps down/);
  assert.match(connected, /1 network\(s\), 1 connected, 1 saved/);
});
