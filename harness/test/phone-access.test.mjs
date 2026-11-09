/**
 * Phone access: what survives a restart, device sessions, the relay client, the
 * cloudflared download, named tunnels, the backoff restart, the routes, and a QR code
 * read back from the image the page shows.
 *
 * No real cloudflared, no real relay and no GitHub: the child is a fake, the relay and
 * the release API are local stubs, and every file goes in a scratch folder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { createUiServer } from "../src/ui.mjs";
import { COOKIE, createRemoteAccess, pairingLink, tokenFromInput } from "../src/remote.mjs";
import { cleanSettings, createRemoteStore, deviceName, mintRelayId, remoteStateFile, RELAY_ID_RE } from "../src/remote-store.mjs";
import { createRelayClient } from "../src/relay-client.mjs";
import { extractFromTar, installCloudflared, locateInstalled, resolveAsset } from "../src/cloudflared-install.mjs";
import { decodeQrImage } from "./qr-decode.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "rosalena-phone-"));
const TUNNEL_URL = "https://selective-tony-locking-hull.trycloudflare.com/";
const TUNNEL_HOST = "selective-tony-locking-hull.trycloudflare.com";
const BANNER = `INF |  ${TUNNEL_URL.slice(0, -1)}  |\n`;

class FakeChild extends EventEmitter {
  constructor(pid = 4321) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exited = false;
  }
  say(text) {
    this.stderr.emit("data", Buffer.from(text));
  }
  exit(code = 0) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, null);
    setImmediate(() => this.emit("close", code, null));
  }
  kill() {
    this.exit(0);
    return true;
  }
}

function fakeSpawn(say = (child) => child.say(BANNER)) {
  const calls = [];
  const children = [];
  const spawnImpl = (cmd, args = [], options = {}) => {
    calls.push({ cmd, args, options });
    if (cmd === "taskkill") {
      const killer = new FakeChild(999);
      setImmediate(() => {
        for (const c of children) c.exit(0);
        killer.exit(0);
      });
      return killer;
    }
    const child = new FakeChild(4000 + children.length);
    children.push(child);
    setImmediate(() => say(child, calls));
    return child;
  };
  return { calls, children, spawnImpl, tunnels: () => calls.filter((c) => c.cmd !== "taskkill") };
}

function controller(extra = {}) {
  const spawn = extra.spawn ?? fakeSpawn();
  const remote = createRemoteAccess({
    port: 8091,
    env: { PATH: "/fixed/bin" },
    platform: "win32",
    isFile: () => true,
    spawnImpl: spawn.spawnImpl,
    fetchImpl: () => Promise.reject(new Error("no network in this test")),
    startTimeoutMs: 2000,
    stopTimeoutMs: 200,
    restartBaseMs: 0,
    healthCheckMs: 0,
    ...extra,
  });
  return { spawn, remote };
}

const settled = (remote, ms = 3000) =>
  Promise.race([remote.settled(), new Promise((_, no) => setTimeout(() => no(new Error("no settlement")), ms).unref?.())]);

function tunnelReq(url = "/", headers = {}, method = "GET") {
  return { url, method, headers: { host: TUNNEL_HOST, "cf-ray": "abc", "cf-connecting-ip": "203.0.113.9", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Mobile/15E148 Safari/604.1", ...headers } };
}

function fakeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.destroyed = false;
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.destroy = () => {
    res.destroyed = true;
    res.emit("close");
  };
  return res;
}

/** Pair through the POST route's logic, return the cookie pair "name=value". */
function pairWith(remote, code = remote.token, headers = {}) {
  const out = remote.pair(tunnelReq("/api/remote/pair", headers, "POST"), code);
  assert.equal(out.status, 303, out.error);
  return out.headers["set-cookie"].split(";")[0];
}

// ------------------------------------------------------------------- the store

test("phone store: the pairing code, the relay id and the devices survive a restart", () => {
  const home = scratch();
  const file = remoteStateFile(home);
  const first = createRemoteStore({ file });
  const token = first.pairingToken();
  const { id, secret } = first.relayIdentity();
  const added = first.addDevice({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/141.0 Mobile Safari/537.36" });
  first.updateSettings({ keepOn: true, cookieDays: 30 });

  const second = createRemoteStore({ file });
  assert.equal(second.pairingToken(), token);
  assert.deepEqual(second.relayIdentity(), { id, secret });
  assert.equal(second.devices().length, 1);
  assert.equal(second.devices()[0].name, "Android phone · Chrome");
  assert.ok(second.verifyDevice(added.cookie), "the device cookie is still good after a restart");
  assert.equal(second.settings().keepOn, true);
  assert.equal(second.settings().cookieDays, 30);

  const raw = readFileSync(file, "utf8");
  assert.equal(raw.includes(added.cookie.split(".")[1]), false, "the device secret is never written, only its hash");
  assert.deepEqual(readdirSync(join(home, "remote")).filter((n) => n.endsWith(".tmp")), [], "no temp file is left behind");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("phone store: a file that does not parse is moved aside, not overwritten", () => {
  const home = scratch();
  const file = remoteStateFile(home);
  createRemoteStore({ file }).pairingToken();
  writeFileSync(file, "{ not json");
  const logs = [];
  const store = createRemoteStore({ file, log: (m) => logs.push(m) });
  assert.match(store.pairingToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(readdirSync(join(home, "remote")).some((n) => n.startsWith("state.json.corrupt-")));
  assert.match(logs.join("\n"), /could not be read/);
});

test("phone store: an unused device expires on the server, and settings are checked", () => {
  let clock = 1_000_000;
  const store = createRemoteStore({ now: () => clock });
  const { cookie } = store.addDevice({});
  assert.ok(store.verifyDevice(cookie, { maxIdleMs: 1000 }));
  clock += 5000;
  assert.equal(store.verifyDevice(cookie, { maxIdleMs: 1000 }), null);
  assert.equal(store.devices().length, 0, "the stale row is gone");
  assert.equal(store.verifyDevice("0123456789abcdef.nope"), null);

  assert.throws(() => cleanSettings({ cookieDays: 3 }), /cookieDays/);
  assert.throws(() => cleanSettings({ namedHost: "not a host" }), /hostname/);
  assert.throws(() => cleanSettings({ surprise: 1 }), /unknown/);
  assert.equal(cleanSettings({ namedHost: "https://Phone.Example.com/x" }).namedHost, "phone.example.com");
  store.updateSettings({ namedToken: "A".repeat(80) });
  const shown = store.publicSettings();
  assert.equal(shown.namedToken, undefined, "the tunnel token never goes to the page");
  assert.equal(shown.hasNamedToken, true);
  assert.equal(shown.namedTokenHint, "ends in AAAA");
});

test("phone store: relay ids are 120-bit base32 labels and device names stay short", () => {
  const ids = new Set(Array.from({ length: 200 }, mintRelayId));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, RELAY_ID_RE);
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
  assert.equal(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36 Edg/141.0"), "Windows · Edge");
});

// --------------------------------------------------------------- device sessions

test("phone: the QR link carries the code in the fragment, and pasting the whole link works", () => {
  assert.equal(pairingLink("https://abc.rosalena.dev", "tok"), "https://abc.rosalena.dev/#pair=tok");
  assert.equal(tokenFromInput("https://abc.rosalena.dev/#pair=tok_123"), "tok_123");
  assert.equal(tokenFromInput("https://x.trycloudflare.com/?t=tok%2D1"), "tok-1");
  assert.equal(tokenFromInput("  bare-token  "), "bare-token");
});

test("phone: pairing makes a device session; unpairing it ends its requests and its open streams", async () => {
  const { remote } = controller();
  remote.enable();
  await settled(remote);
  const cookie = pairWith(remote);
  assert.match(cookie, new RegExp(`^${COOKIE}=[a-f0-9]{16}\\.`));
  const devices = remote.status({ revealSecret: true }).devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "iPhone · Safari");

  const stream = fakeRes();
  const streamReq = tunnelReq("/api/stream?id=x", { cookie });
  assert.equal(remote.gate(streamReq, stream), null);
  assert.equal(streamReq.rosalenaDevice.id, devices[0].id);

  const out = remote.removeDevice(devices[0].id);
  assert.equal(out.ok, true);
  assert.equal(stream.destroyed, true, "the open SSE response of that device is closed");
  const after = remote.gate(tunnelReq("/", { cookie }), fakeRes());
  assert.equal(after.status, 401);
  assert.match(after.html, /This device was unpaired/);
  assert.match(String(after.headers["set-cookie"]), /Max-Age=0/, "the dead cookie is cleared");
  await remote.disable();
});

test("phone: a paired device still works after New QR code; Unpair all ends everything", async () => {
  const relayCalls = [];
  const relay = {
    status: () => ({ state: "linked", url: "https://aaaa.rosalena.dev/" }),
    announce: async (a) => (relayCalls.push(["announce", a.id]), "https://aaaa.rosalena.dev/"),
    unregister: async (a) => (relayCalls.push(["unregister", a.id]), true),
    stop: () => relayCalls.push(["stop"]),
  };
  const { remote } = controller({ relay });
  remote.enable();
  await settled(remote);
  const cookie = pairWith(remote);
  const oldCode = remote.token;
  const oldRelay = remote.store.relayIdentity().id;

  remote.revoke();
  assert.notEqual(remote.token, oldCode);
  assert.equal(remote.gate(tunnelReq("/", { cookie }), fakeRes()), null, "New QR code leaves paired devices alone");
  assert.equal(remote.pair(tunnelReq("/api/remote/pair", {}, "POST"), oldCode).status, 403, "the old code no longer pairs");

  const out = await remote.unpairAll();
  assert.equal(out.removed, 1);
  assert.equal(remote.gate(tunnelReq("/", { cookie }), fakeRes()).status, 401);
  assert.notEqual(remote.store.relayIdentity().id, oldRelay, "a new stable link");
  assert.deepEqual(relayCalls.find((c) => c[0] === "unregister"), ["unregister", oldRelay], "the old link is released at the relay");
  assert.equal(relayCalls.filter((c) => c[0] === "announce").at(-1)[1], remote.store.relayIdentity().id);
  await remote.disable();
});

test("phone: wrong codes are rate limited per client and the page says so", async () => {
  const { remote } = controller({ pairLimit: { perKey: 3, global: 100, windowMs: 60_000 } });
  remote.enable();
  await settled(remote);
  for (let i = 0; i < 3; i++) assert.equal(remote.pair(tunnelReq("/api/remote/pair", {}, "POST"), `wrong-${i}`).status, 403);
  const limited = remote.pair(tunnelReq("/api/remote/pair", {}, "POST"), remote.token);
  assert.equal(limited.status, 429, "even the right code waits once the limit is hit");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  // Another client is not punished for the first one's guesses.
  assert.equal(remote.pair(tunnelReq("/api/remote/pair", { "cf-connecting-ip": "198.51.100.1" }, "POST"), remote.token).status, 303);
  await remote.disable();
});

// -------------------------------------------------------- restart, named, relay

test("phone: while the switch is on, a cloudflared that dies is started again with backoff", async () => {
  const { spawn, remote } = controller({ restartBaseMs: 20, restartMaxMs: 40 });
  remote.enable();
  await settled(remote);
  spawn.children[0].say("ERR lost the edge\n");
  spawn.children[0].exit(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(remote.status().state, "failed");
  assert.match(remote.status().reason, /Trying again in/);
  await new Promise((r) => setTimeout(r, 80));
  await settled(remote);
  assert.equal(remote.status().state, "live", "back up on its own");
  assert.equal(spawn.tunnels().length, 2);

  await remote.disable();
  assert.equal(remote.wanted, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(spawn.tunnels().length, 2, "off means nothing restarts it");
});

test("phone: keep-on starts at launch only when it is set", async () => {
  const off = controller();
  assert.equal(off.remote.autoStart(), null);
  assert.equal(off.spawn.calls.length, 0);
  const store = createRemoteStore();
  store.updateSettings({ keepOn: true });
  const on = controller({ store });
  assert.equal(on.remote.autoStart().state, "starting");
  await settled(on.remote);
  assert.equal(on.remote.status().state, "live");
  await on.remote.shutdown();
  assert.equal(on.remote.status().state, "idle");
  assert.equal(on.remote.wanted, true, "closing the server does not flip the switch");
});

test("phone: a named tunnel runs with its token in the environment, never on the command line", async () => {
  const upstream = createServer((req, res) => res.end(`upstream saw ${req.headers.host}`));
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const namedPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const token = "eyJ" + "a".repeat(120);
  const store = createRemoteStore();
  store.updateSettings({ namedToken: token, namedHost: "phone.example.com", namedPort });
  const spawn = fakeSpawn((child) => child.say("INF Registered tunnel connection connIndex=0 location=iad07 protocol=http2\n"));
  const configFile = join(scratch(), "empty.yml");
  const { remote } = controller({ spawn, store, port: () => upstream.address().port, configFile });
  remote.enable();
  await settled(remote);
  const s = remote.status({ revealSecret: true });
  assert.equal(s.state, "live");
  assert.equal(s.mode, "named");
  assert.equal(s.publicUrl, "https://phone.example.com/");
  assert.equal(s.link, `https://phone.example.com/#pair=${remote.token}`);
  const call = spawn.tunnels()[0];
  assert.deepEqual(call.args, ["tunnel", "--config", configFile, "--no-autoupdate", "--protocol", "http2", "run"]);
  assert.equal(call.args.join(" ").includes(token), false);
  assert.equal(call.options.env.TUNNEL_TOKEN, token);
  assert.ok(existsSync(configFile), "Rosalena's own empty config, so ~/.cloudflared/config.yml is not read");

  // The fixed local port forwards to whatever port the app has this launch.
  const body = await new Promise((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port: namedPort, path: "/", headers: { host: "phone.example.com" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve(text));
    })
      .on("error", reject)
      .end();
  });
  assert.equal(body, "upstream saw phone.example.com");
  await remote.disable();
  upstream.close();
});

test("phone: the quick tunnel is told to use Rosalena's empty config", async () => {
  const configFile = join(scratch(), "nested", "empty.yml");
  const { spawn, remote } = controller({ configFile });
  remote.enable();
  await settled(remote);
  assert.deepEqual(spawn.tunnels()[0].args.slice(0, 4), ["tunnel", "--config", configFile, "--url"]);
  await remote.disable();
});

test("phone: the relay's stable URL is the one in the QR code once it is linked", async () => {
  let linked = false;
  const relay = {
    status: () => (linked ? { state: "linked", url: "https://abcdefghijklmnopqrstuvwx.rosalena.dev/" } : { state: "registering" }),
    announce: async ({ target }) => {
      assert.equal(target, TUNNEL_URL);
      linked = true;
      return "https://abcdefghijklmnopqrstuvwx.rosalena.dev/";
    },
    unregister: async () => true,
    stop: () => {},
  };
  const { remote } = controller({ relay });
  remote.enable();
  await settled(remote);
  await new Promise((r) => setImmediate(r));
  const s = remote.status({ revealSecret: true });
  assert.equal(s.publicUrl, "https://abcdefghijklmnopqrstuvwx.rosalena.dev/");
  assert.equal(s.relay.state, "linked");
  assert.equal(decodeQrImage(s.qr).text, s.link, "the QR image reads back as the stable link");

  await remote.updateSettings({ relay: false });
  assert.equal(remote.status().publicUrl, TUNNEL_URL, "relay off: the raw tunnel link");
  await remote.disable();
});

test("relay client: links on success, retries with backoff on failure, and refuses a bad answer", async () => {
  let calls = 0;
  const seen = [];
  const client = createRelayClient({
    base: "https://relay.test",
    baseDelayMs: 10,
    maxDelayMs: 20,
    fetchImpl: async (url, init) => {
      calls += 1;
      seen.push({ url, body: JSON.parse(init.body) });
      if (calls === 1) throw new Error("getaddrinfo ENOTFOUND relay.test");
      if (calls === 2) return { ok: true, status: 200, json: async () => ({ ok: true, url: "javascript:alert(1)" }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, url: "https://aaaaaaaaaaaaaaaaaaaaaaaa.rosalena.dev/" }) };
    },
  });
  const out = await client.announce({ id: "aaaaaaaaaaaaaaaaaaaaaaaa", secret: "s", target: TUNNEL_URL });
  assert.equal(out, null);
  assert.equal(client.status().state, "failed");
  assert.match(client.status().error, /ENOTFOUND/);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(client.status().state, "linked");
  assert.equal(client.status().url, "https://aaaaaaaaaaaaaaaaaaaaaaaa.rosalena.dev/");
  assert.equal(calls, 3, "the second answer (not an https URL) was refused and retried");
  assert.equal(seen[0].url, "https://relay.test/api/register");
  assert.deepEqual(Object.keys(seen[0].body).sort(), ["id", "secret", "target"]);
  client.stop();
  assert.equal(client.status().state, "off");
});

// ----------------------------------------------------------- the cloudflared download

function tarOf(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000755\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return Buffer.concat([header, body, pad, Buffer.alloc(1024)]);
}

async function releaseServer(files) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    if (req.url === "/api") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(files.api(server.address().port)));
    }
    const body = files[req.url];
    if (!body) {
      res.statusCode = 404;
      return res.end();
    }
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}` };
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

test("cloudflared download: the release's size and SHA-256 must match, and a second call downloads nothing", async () => {
  const binary = Buffer.from("MZ fake cloudflared ".repeat(500));
  const rel = await releaseServer({
    api: (port) => ({
      tag_name: "2099.1.1",
      assets: [{ name: "cloudflared-windows-amd64.exe", size: binary.length, digest: `sha256:${sha(binary)}`, browser_download_url: `http://127.0.0.1:${port}/bin` }],
    }),
    "/bin": binary,
  });
  const home = scratch();
  const progress = [];
  const out = await installCloudflared({ home, platform: "win32", arch: "x64", apiUrl: `${rel.base}/api`, onProgress: (p) => progress.push(p.received) });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.version, "2099.1.1");
  assert.deepEqual(readFileSync(out.path), binary);
  assert.ok(progress.at(-1) === binary.length);
  assert.equal(locateInstalled(home, "win32").version, "2099.1.1");
  const again = await installCloudflared({ home, platform: "win32", arch: "x64", apiUrl: `${rel.base}/api` });
  assert.equal(again.installed, false);
  assert.equal(rel.hits.filter((h) => h === "/bin").length, 1);
  rel.server.close();
});

test("cloudflared download: a wrong checksum installs nothing", async () => {
  const binary = Buffer.from("tampered");
  const rel = await releaseServer({
    api: (port) => ({ tag_name: "x", assets: [{ name: "cloudflared-linux-amd64", size: binary.length, digest: `sha256:${"0".repeat(64)}`, browser_download_url: `http://127.0.0.1:${port}/bin` }] }),
    "/bin": binary,
  });
  const home = scratch();
  const out = await installCloudflared({ home, platform: "linux", arch: "x64", apiUrl: `${rel.base}/api` });
  assert.equal(out.ok, false);
  assert.match(out.reason, /SHA-256/);
  assert.equal(locateInstalled(home, "linux"), null);
  assert.deepEqual(readdirSync(join(home, "remote", "bin")), [], "the temp file is removed");
  rel.server.close();
});

test("cloudflared download: macOS gets the binary out of the .tgz", async () => {
  const binary = Buffer.from("\xcf\xfa\xed\xfe fake mach-o", "latin1");
  const tgz = gzipSync(tarOf("cloudflared", binary));
  const rel = await releaseServer({
    api: (port) => ({ tag_name: "y", assets: [{ name: "cloudflared-darwin-arm64.tgz", size: tgz.length, digest: `sha256:${sha(tgz)}`, browser_download_url: `http://127.0.0.1:${port}/tgz` }] }),
    "/tgz": tgz,
  });
  const home = scratch();
  const out = await installCloudflared({ home, platform: "darwin", arch: "arm64", apiUrl: `${rel.base}/api` });
  assert.equal(out.ok, true, out.reason);
  assert.deepEqual(readFileSync(out.path), binary);
  assert.equal(extractFromTar(tarOf("other", binary)), null);
  rel.server.close();
});

test("cloudflared download: without the release API, the pinned checksums are used", async () => {
  const asset = await resolveAsset({ platform: "win32", arch: "x64", fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(asset.source, "pinned");
  assert.match(asset.url, /^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/[\d.]+\/cloudflared-windows-amd64\.exe$/);
  assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await resolveAsset({ platform: "sunos", arch: "x64" })).ok, false);
});

test("phone: the first enable downloads cloudflared when it is nowhere, then starts it", async () => {
  const spawn = fakeSpawn();
  let installs = 0;
  const { remote } = controller({
    spawn,
    env: { PATH: "" },
    isFile: () => false,
    install: async ({ onProgress }) => {
      installs += 1;
      onProgress({ received: 5, total: 10 });
      return { ok: true, path: "/home/remote/bin/cloudflared.exe", version: "2099.1.1" };
    },
  });
  const started = remote.enable();
  assert.equal(started.state, "starting");
  assert.equal(started.install.state, "downloading");
  await settled(remote);
  assert.equal(remote.status().state, "live");
  assert.equal(installs, 1);
  assert.equal(spawn.tunnels()[0].cmd, "/home/remote/bin/cloudflared.exe");
  assert.equal(remote.status().binarySource, "downloaded by Rosalena");
  await remote.disable();
});

// ------------------------------------------------------------------ the routes

function wire(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("server: pairing, the paired page, the phone-only refusals and the settings routes", async () => {
  const root = scratch();
  const token = "phone-route-test-token-0123456789";
  const ui = createUiServer({
    port: 0,
    home: join(root, "home"),
    workspace: root,
    routerUrl: "http://127.0.0.1:1/v1",
    token,
    remoteOptions: { install: null, relay: null, env: { PATH: "/fixed/bin" }, platform: "win32", isFile: () => true, spawnImpl: fakeSpawn().spawnImpl, restartBaseMs: 0, healthCheckMs: 0 },
  });
  const { port } = await ui.ready();
  const local = { host: `127.0.0.1:${port}` };
  const phone = { host: TUNNEL_HOST, "cf-ray": "abc", "cf-connecting-ip": "203.0.113.7", "sec-fetch-site": "same-origin" };
  try {
    const on = await wire(port, "/api/remote/enable", { method: "POST", headers: { ...local, "x-rosalena-token": token, "content-length": 0 } });
    assert.equal(on.status, 200);
    await settled(ui.remote);
    const status = JSON.parse((await wire(port, "/api/remote/status", { headers: local })).body).remote;
    assert.equal(status.state, "live");
    assert.equal(decodeQrImage(status.qr).text, status.link);
    assert.ok(existsSync(remoteStateFile(join(root, "home"))));

    const blocked = await wire(port, "/", { headers: phone });
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.includes(token), false, "an unpaired device never sees the write token");
    assert.match(blocked.headers["content-security-policy"], /script-src 'nonce-/);

    const code = status.link.split("#pair=")[1];
    const paired = await wire(port, "/api/remote/pair", {
      method: "POST",
      headers: { ...phone, "content-type": "application/x-www-form-urlencoded" },
      body: `code=${encodeURIComponent(status.link)}`,
    });
    assert.equal(paired.status, 303);
    assert.equal(paired.headers.location, "/");
    const cookie = String(paired.headers["set-cookie"]).split(";")[0];
    assert.equal(cookie.includes(code), false);

    const page = await wire(port, "/", { headers: { ...phone, cookie } });
    assert.equal(page.status, 200);
    assert.match(page.body, /<html data-remote="1"/);
    assert.ok(page.body.includes(`content="${token}"`), "a paired device is an operator: it gets the write token");

    for (const asset of ["/phone.js", "/phone.css"]) assert.equal((await wire(port, asset, { headers: { ...phone, cookie } })).status, 200);
    assert.equal((await wire(port, "/api/sessions", { headers: { ...phone, cookie } })).status, 200);
    const sibling = await wire(port, "/api/sessions", { headers: { ...phone, cookie, "sec-fetch-site": "same-site" } });
    assert.equal(sibling.status, 403, "another *.rosalena.dev page cannot call this app's API");
    for (const action of ["enable", "disable", "revoke", "unpair-all", "settings"]) {
      const r = await wire(port, `/api/remote/${action}`, { method: "POST", headers: { ...phone, cookie, "x-rosalena-token": token, "content-length": 0 } });
      assert.equal(r.status, 403, `${action} is for this computer only`);
    }
    assert.equal((await wire(port, "/api/terminal", { headers: { ...phone, cookie, "x-rosalena-token": token } })).status, 403);
    const me = JSON.parse((await wire(port, "/api/remote/status", { headers: { ...phone, cookie } })).body).remote;
    assert.equal(me.view, "remote");
    assert.equal(me.devices, undefined, "a phone does not see the device list");
    assert.equal(me.device.name, "Browser");

    const bad = await wire(port, "/api/remote/settings", { method: "POST", headers: { ...local, "x-rosalena-token": token, "content-type": "application/json" }, body: JSON.stringify({ cookieDays: 2 }) });
    assert.equal(bad.status, 400);
    const good = await wire(port, "/api/remote/settings", { method: "POST", headers: { ...local, "x-rosalena-token": token, "content-type": "application/json" }, body: JSON.stringify({ keepOn: true, cookieDays: 7 }) });
    assert.equal(JSON.parse(good.body).remote.settings.cookieDays, 7);

    const listed = JSON.parse((await wire(port, "/api/remote/status", { headers: local })).body).remote.devices;
    assert.equal(listed.length, 1);
    const removed = await wire(port, "/api/remote/devices/remove", { method: "POST", headers: { ...local, "x-rosalena-token": token, "content-type": "application/json" }, body: JSON.stringify({ id: listed[0].id }) });
    assert.equal(removed.status, 200);
    assert.equal((await wire(port, "/api/sessions", { headers: { ...phone, cookie } })).status, 401);

    const all = await wire(port, "/api/remote/unpair-all", { method: "POST", headers: { ...local, "x-rosalena-token": token, "content-length": 0 } });
    assert.equal(JSON.parse(all.body).ok, true);
    assert.notEqual(JSON.parse(all.body).remote.link, status.link);
  } finally {
    await ui.close();
  }
});
