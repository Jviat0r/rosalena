/**
 * Remote access: the tunnel, the token gate, and the failure modes.
 *
 * No network and no cloudflared. The child process is a fake EventEmitter that prints
 * whatever a test wants and exits when told to, and `fetch` is injected, because the
 * interesting behaviour here is *refusal* and *cleanup*: a request without a token, a
 * link whose token was revoked, a binary that is not installed, and a stop that must
 * actually kill the process tree rather than leaving a tunnel open at Cloudflare's edge.
 *
 * The QR tests are structural on purpose. A scrambled QR code still looks like a QR
 * code, so "is it a real symbol" is answered by reading the modules back into codewords
 * and comparing them with the stream the encoder wrote - the same way a scanner would,
 * without a camera.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUiServer } from "../src/ui.mjs";
import {
  BIN_ENV,
  COOKIE,
  DOWNLOAD,
  createRemoteAccess,
  isLoopbackHost,
  locateCloudflared,
  mintToken,
  parseTunnelUrl,
  sameToken,
  tunnelHost,
} from "../src/remote.mjs";
import { alignmentPositions, encodeQr, formatBits, qrDataUri, qrSvg } from "../src/qr.mjs";

const UI_PORT = 8091;

/** The banner a 2024 cloudflared prints, ANSI colour and box included. */
const REAL_OUTPUT = [
  "\u001b[90m2026-10-20T09:14:02Z\u001b[0m \u001b[32mINF\u001b[0m Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment.",
  "\u001b[90m2026-10-20T09:14:02Z\u001b[0m \u001b[32mINF\u001b[0m Requesting new quick Tunnel on trycloudflare.com...",
  "\u001b[90m2026-10-20T09:14:03Z\u001b[0m \u001b[32mINF\u001b[0m +--------------------------------------------------------------------------------------------+",
  "\u001b[90m2026-10-20T09:14:03Z\u001b[0m \u001b[32mINF\u001b[0m |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
  "\u001b[90m2026-10-20T09:14:03Z\u001b[0m \u001b[32mINF\u001b[0m |  https://selective-tony-locking-hull.trycloudflare.com                                      |",
  "\u001b[90m2026-10-20T09:14:03Z\u001b[0m \u001b[32mINF\u001b[0m +--------------------------------------------------------------------------------------------+",
  "\u001b[90m2026-10-20T09:14:04Z\u001b[0m \u001b[32mINF\u001b[0m Registered tunnel connection connIndex=0 connection=8f6d event=0 ip=198.41.192.7 location=yyz04",
  "",
].join("\n");

const TUNNEL_URL = "https://selective-tony-locking-hull.trycloudflare.com/";
const TUNNEL_HOST = "selective-tony-locking-hull.trycloudflare.com";

// --------------------------------------------------------------------- doubles

class FakeChild extends EventEmitter {
  constructor({ pid = 4321 } = {}) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exited = false;
  }

  /** Whatever the child would print, on whichever stream the caller chose. */
  say(text, stream = "stderr") {
    this[stream].emit("data", Buffer.from(text));
    return this;
  }

  /** A real child emits 'exit', then 'close' once its pipes are shut. */
  exit(code = 0, signal = null) {
    if (this.exited) return this;
    this.exited = true;
    this.emit("exit", code, signal);
    setImmediate(() => this.emit("close", code, signal));
    return this;
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.exit(0, signal);
    return true;
  }
}

/**
 * A spawn double. `tunnel` is the child; `taskkill` is answered with a child that
 * reports success and takes the tunnel with it, which is what Windows actually does.
 * By default the new child prints the real banner, so a plain `enable()` goes live.
 */
function fakeSpawn({ onSpawn = (tunnel) => tunnel.say(REAL_OUTPUT) } = {}) {
  const calls = [];
  let tunnel = null;
  const spawnImpl = (cmd, args = [], options = {}) => {
    calls.push({ cmd, args, options });
    if (cmd === "taskkill") {
      const killer = new FakeChild({ pid: 999 });
      setImmediate(() => {
        tunnel?.exit(0, null);
        killer.exit(0, null);
      });
      return killer;
    }
    tunnel = new FakeChild();
    if (onSpawn) setImmediate(() => onSpawn(tunnel, calls));
    return tunnel;  };
  return {
    calls,
    spawnImpl,
    get tunnel() {
      return tunnel;
    },
    get tunnelSpawns() {
      return calls.filter((call) => call.cmd !== "taskkill");
    },
    get taskkills() {
      return calls.filter((call) => call.cmd === "taskkill");
    },
  };
}

/** A remote controller with a fake child, a fixed clock and no network by default. */
function harness({ spawn, env = { PATH: "/fixed/bin" }, platform = "win32", isFile = () => true, fetchImpl, now, ...rest } = {}) {
  const fake = spawn ?? fakeSpawn();
  const clock = now ?? (() => 1_700_000_000_000);
  const remote = createRemoteAccess({
    port: UI_PORT,
    env,
    platform,
    isFile,
    spawnImpl: fake.spawnImpl,
    fetchImpl: fetchImpl ?? (() => Promise.reject(new Error("no network in this test"))),
    now: clock,
    startTimeoutMs: 2_000,
    stopTimeoutMs: 200,
    restartBaseMs: 0,
    ...rest,
  });
  return { fake, remote };
}

/** Wait for a settlement, but never hang the suite if the machine is wedged. */
function deadline(promise, ms = 3_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no settlement within ${ms} ms`)), ms).unref?.()),
  ]);
}

/** A request as node:http would hand it to the gate. */
function request(overrides = {}) {
  const { url = "/", method = "GET", headers = {}, ...rest } = overrides;
  return { url, method, headers, ...rest };
}

function tunnelRequest(url = "/", extra = {}) {
  return request({ url, headers: { host: TUNNEL_HOST, "cf-ray": "8f6d-YYZ", ...extra } });
}

/** A response stand-in that records the headers the gate sets. */
function response() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
  };
}

// ------------------------------------------------------------------ URL parsing

test("remote: the quick-tunnel URL is read out of the boxed, coloured banner", () => {
  assert.equal(parseTunnelUrl(REAL_OUTPUT), TUNNEL_URL);
  assert.equal(tunnelHost(TUNNEL_URL), TUNNEL_HOST);
});

test("remote: the URL is found in an older unboxed line and in a --logformat json line", () => {
  assert.equal(
    parseTunnelUrl("2023-11-02T08:11:33Z INF |  https://plain-words-here.trycloudflare.com  |\n"),
    "https://plain-words-here.trycloudflare.com/",
  );
  assert.equal(
    parseTunnelUrl('{"level":"info","message":"Your quick Tunnel has been created! https://json-logged-words.trycloudflare.com","time":"2026-10-20T09:14:03Z"}\n'),
    "https://json-logged-words.trycloudflare.com/",
  );
});

test("remote: a URL that only looks like a tunnel is refused", () => {
  // The API host, a named tunnel on a stranger's zone, and a suffix trick.
  assert.equal(parseTunnelUrl("https://api.trycloudflare.com/client"), null);
  assert.equal(parseTunnelUrl("https://selective.trycloudflare.com.evil.example/"), null);
  // Not a quick tunnel at all: a sub-domain of the quick-tunnel zone is refused rather
  // than being truncated to the label a scanner would believe.
  assert.equal(parseTunnelUrl("https://a.b.trycloudflare.com/"), null);
  assert.equal(parseTunnelUrl("Registered tunnel connection connIndex=0"), null);
  assert.equal(parseTunnelUrl(""), null);
  assert.equal(parseTunnelUrl(null), null);
});

test("remote: a URL split across two chunks is still parsed once both halves arrive", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  const line = "INF |  https://halves-join-up-here.trycloudflare.com  |\n";
  const cut = line.indexOf("trycloudflare");
  spawn.tunnel.say(line.slice(0, cut));
  assert.equal(remote.status().state, "starting", "half a URL is not a URL");
  spawn.tunnel.say(line.slice(cut));
  const settled = await deadline(remote.settled());
  assert.equal(settled.state, "live");
  assert.equal(settled.url, "https://halves-join-up-here.trycloudflare.com/");
});

// -------------------------------------------------------------- status machine

test("remote: idle says so, and enable() is non-blocking", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  assert.equal(remote.status().state, "idle");
  assert.match(remote.status().reason, /off/);

  const started = remote.enable();
  assert.equal(started instanceof Promise, false, "enable() must not make the caller wait for a tunnel");
  assert.equal(started.state, "starting");
  assert.equal(started.hasToken, true, "the token exists before the URL does");

  const live = await deadline(remote.settled());
  assert.equal(live.state, "live");
  assert.equal(live.url, TUNNEL_URL);
  assert.equal(live.reason.includes(TUNNEL_URL), true);
  assert.equal(spawn.tunnelSpawns.length, 1);
  const [cmd, args, options] = [spawn.tunnelSpawns[0].cmd, spawn.tunnelSpawns[0].args, spawn.tunnelSpawns[0].options];
  assert.match(cmd, /cloudflared(\.exe)?$/);
  assert.deepEqual(args, ["tunnel", "--url", `http://127.0.0.1:${UI_PORT}`, "--no-autoupdate", "--protocol", "http2"]);
  assert.equal(options.windowsHide, true);
  await remote.disable();
});

test("remote: enable() is idempotent while starting and while live", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  const again = remote.enable();
  assert.equal(again.state, "starting");
  await deadline(remote.settled());
  const third = remote.enable();
  assert.equal(third.state, "live");
  assert.equal(spawn.tunnelSpawns.length, 1, "a second enable must not spawn a second tunnel");
  await remote.disable();
});

test("remote: the child exiting on its own turns live into failed, with its last words", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());
  spawn.tunnel.say("ERR failed to run the datagram handler: read udp: connection refused\n");
  spawn.tunnel.exit(1, null);
  const settled = await deadline(remote.settled());
  assert.equal(settled.state, "failed");
  assert.match(settled.reason, /exited \(code 1\) while the tunnel was live/);
  assert.match(settled.reason, /connection refused/);
  assert.equal(settled.url, null, "a failed tunnel must not keep advertising a URL");
  assert.equal(remote.status({ revealSecret: true }).link, null, "a failed tunnel has no link to hand out");
  await remote.disable();
});

test("remote: exiting before the URL arrives is its own sentence", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  spawn.tunnel.say("ERR flag provided but not defined: -no-autoupdate\n");
  spawn.tunnel.exit(1, null);
  const settled = await deadline(remote.settled());
  assert.equal(settled.state, "failed");
  assert.match(settled.reason, /before the tunnel was up/);
  assert.match(settled.reason, /not defined/);
});

test("remote: silence for the whole deadline is a failure, and the child is killed", async () => {
  const spawn = fakeSpawn({ onSpawn: () => {} }); // a cloudflared that never says anything
  const { remote } = harness({ spawn, startTimeoutMs: 30 });
  remote.enable();
  const settled = await deadline(remote.settled());
  assert.equal(settled.state, "failed");
  assert.match(settled.reason, /without the tunnel coming up/);
  await deadline(remote.disable());
  assert.equal(spawn.taskkills.length, 1, "a half-started child must not be left running");
});

test("remote: stop kills the whole tree on Windows and returns to idle", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());
  const stopped = await deadline(remote.disable());

  assert.equal(stopped.state, "idle");
  assert.match(stopped.reason, /off/);
  assert.equal(stopped.url, null);
  assert.equal(stopped.pid, null);
  assert.equal(stopped.wanted, false, "off means the switch is off: nothing restarts it");
  assert.equal(spawn.taskkills.length, 1);
  assert.deepEqual(spawn.taskkills[0].args, ["/pid", "4321", "/T", "/F"], "cloudflared's children must die with it");
  assert.equal(spawn.tunnel.exited, true);
});

test("remote: a stop of something already idle is a no-op, not an error", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  const stopped = await remote.disable();
  assert.equal(stopped.state, "idle");
  assert.equal(spawn.calls.length, 0);
});

test("remote: enable after disable works, and the pairing link survives it (the QR stays valid)", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());
  const first = remote.status({ revealSecret: true }).link;
  await remote.disable();
  remote.enable();
  await deadline(remote.settled());
  const second = remote.status({ revealSecret: true }).link;
  assert.equal(first, second, "the pairing code is persistent; only New QR code replaces it");
  assert.equal(spawn.tunnelSpawns.length, 2);
  await remote.disable();
});

// --------------------------------------------------------------- the executable

test("remote: a missing binary is reported with the download URL and nothing is spawned", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn, env: { PATH: "" }, isFile: () => false });
  const started = remote.enable();
  assert.equal(started.state, "failed");
  assert.match(started.reason, /cloudflared was not found on PATH/);
  assert.equal(started.reason.includes(DOWNLOAD.releases), true);
  assert.equal(started.reason.includes(DOWNLOAD.docs), true);
  assert.match(started.reason, /will not pretend/);
  assert.equal(started.url, null);
  assert.equal(started.link, null, "no link is handed out when there is no tunnel");
  assert.equal(spawn.calls.length, 0);
  assert.equal(spawn.tunnelSpawns.length, 0);
});

test("remote: ROSALENA_CLOUDFLARED overrides PATH, and a bad override says which path is wrong", () => {
  const ok = locateCloudflared({
    env: { [BIN_ENV]: "D:\\tools\\cloudflared.exe", PATH: "" },
    platform: "win32",
    isFile: (path) => path === "D:\\tools\\cloudflared.exe",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.path, "D:\\tools\\cloudflared.exe");
  assert.equal(ok.source, BIN_ENV);

  const bad = locateCloudflared({
    env: { [BIN_ENV]: "D:\\nope\\cloudflared.exe", PATH: "" },
    platform: "win32",
    isFile: () => false,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /ROSALENA_CLOUDFLARED is set to/);
  assert.match(bad.reason, /D:\\nope\\cloudflared\.exe/);
});

test("remote: PATH is searched in order, with the platform's executable names", () => {
  const seen = [];
  const found = locateCloudflared({
    env: { PATH: "C:\\one;C:\\two" },
    platform: "win32",
    isFile: (path) => {
      seen.push(path);
      return path === "C:\\two\\cloudflared.exe";
    },
  });
  assert.equal(found.ok, true);
  assert.equal(found.path, "C:\\two\\cloudflared.exe");
  assert.equal(found.source, "PATH");
  // Every PATH entry in order, and inside each one the names Windows actually uses. The
  // `.cmd`/`.bat`/bare probes cost four `stat` calls per directory and buy the case where
  // someone installed a shim rather than the executable.
  assert.deepEqual(seen, [
    "C:\\one\\cloudflared.exe",
    "C:\\one\\cloudflared.cmd",
    "C:\\one\\cloudflared.bat",
    "C:\\one\\cloudflared",
    "C:\\two\\cloudflared.exe",
  ]);
});

test("remote: a spawn that throws is a failure, not a crash", () => {
  const { remote } = harness({
    spawn: { calls: [], spawnImpl: () => { throw new Error("EPERM: access denied"); }, get tunnel() { return null; }, get tunnelSpawns() { return []; }, get taskkills() { return []; } },
  });
  const started = remote.enable();
  assert.equal(started.state, "failed");
  assert.match(started.reason, /could not be started/);
  assert.match(started.reason, /EPERM/);
});

// ------------------------------------------------------------------ the gate

test("remote: a request through the tunnel without a token is refused", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());

  const missing = remote.gate(tunnelRequest("/"));
  assert.equal(missing.status, 401);
  assert.match(missing.error, /until this device is paired/);
  assert.match(missing.html, /Pair this device first/, "a phone gets a page, not raw JSON");
  assert.match(missing.html, /<form method="post" action="\/api\/remote\/pair"/, "with a box to paste the code into");
  // One script, allowed by nonce only: it moves a #pair= code from the QR link into the form.
  const nonce = /<script nonce="([^"]+)">/.exec(missing.html)?.[1];
  assert.ok(nonce, "the script carries a nonce");
  assert.equal((missing.html.match(/<script/g) ?? []).length, 1);
  assert.match(missing.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(missing.headers["content-security-policy"].includes(`'nonce-${nonce}'`), true);
  assert.notEqual(remote.gate(tunnelRequest("/")).headers["content-security-policy"], missing.headers["content-security-policy"], "a fresh nonce per page");
  assert.equal(missing.html.includes(remote.token), false);

  const wrong = remote.gate(tunnelRequest("/?t=not-the-token"));
  assert.equal(wrong.status, 403);
  assert.match(wrong.error, /replaced|mistyped/);
  await remote.disable();
});

test("remote: the right token in the query becomes a cookie and leaves the address bar", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());
  const token = remote.token;

  const res = response();
  const redirect = remote.gate(tunnelRequest(`/?t=${encodeURIComponent(token)}`), res);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.location, "/");
  const cookie = redirect.headers["set-cookie"];
  assert.match(cookie, new RegExp(`^${COOKIE}=[a-f0-9]{16}\\.`), "the cookie is a device session, not the pairing code");
  assert.equal(cookie.includes(token), false, "the pairing code itself never becomes a cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=7776000/, "90 days by default");
  assert.match(cookie, /Secure/, "the tunnel is https, so the cookie must not travel over http");
  const value = cookie.split(";")[0].split("=")[1];

  // The next request - an asset, an API call - carries only the cookie.
  assert.equal(remote.gate(tunnelRequest("/app.js", { cookie: `${COOKIE}=${value}` })), null);
  assert.equal(remote.gate(tunnelRequest("/api/sessions", { cookie: `${COOKIE}=${value}` })), null);
  assert.equal(remote.status({ revealSecret: true }).devices.length, 1, "one paired device, listed");
  // The pairing code in the old cookie name is not a credential any more.
  assert.equal(remote.gate(tunnelRequest("/", { cookie: `rosalena_remote=${token}` })).status, 401);
  await remote.disable();
});

test("remote: the token is accepted as a header and as a bearer credential too", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());
  const token = remote.token;
  assert.equal(remote.gate(tunnelRequest("/api/health", { "x-rosalena-remote": token })), null);
  assert.equal(remote.gate(tunnelRequest("/api/health", { "x-rosalena-pair": token })), null);
  assert.equal(remote.gate(tunnelRequest("/api/health", { authorization: `Bearer ${token}` })), null);
  assert.equal(remote.gate(tunnelRequest("/api/health", { "x-rosalena-remote": `${token}x` })).status, 403);
  await remote.disable();
});

test("remote: revoke kills the old links and keeps the tunnel up", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());
  const before = remote.token;
  const beforeLink = remote.status({ revealSecret: true }).link;
  assert.equal(beforeLink, `${TUNNEL_URL}#pair=${before}`, "the code rides in the fragment, which no server ever sees");
  // A device paired with the old code keeps working after the code is replaced.
  const paired = remote.gate(tunnelRequest(`/?t=${before}`)).headers["set-cookie"].split(";")[0];

  const out = remote.revoke();
  assert.equal(out.ok, true);
  assert.equal(out.state, "live", "revoking must not stop the tunnel");
  const after = remote.token;
  assert.notEqual(before, after);
  assert.equal(out.link.includes(after), true);

  assert.equal(remote.gate(tunnelRequest(`/?t=${before}`)).status, 403, "the old link is dead");
  assert.equal(remote.gate(tunnelRequest(`/?t=${after}`, { cookie: undefined })).status, 302);
  assert.equal(remote.gate(tunnelRequest("/", { cookie: paired })), null, "devices already paired stay paired");
  await remote.disable();
});

test("remote: a new QR code can be made while phone access is off, and it hands out no link", () => {
  const { remote } = harness({ env: { PATH: "" }, isFile: () => false });
  const before = remote.token;
  const out = remote.revoke();
  assert.equal(out.ok, true);
  assert.notEqual(remote.token, before);
  assert.equal(out.link, null, "no tunnel, so no link and no QR");
  assert.equal(out.qr, null);
});

test("remote: the local page is never gated while a tunnel is up", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());
  // The desktop browser, still on loopback, must keep working with the app's own token.
  assert.equal(remote.gate(request({ headers: { host: `127.0.0.1:${UI_PORT}` } })), null);
  assert.equal(remote.gate(request({ headers: { host: `localhost:${UI_PORT}` } })), null);
  // Cloudflare's headers alone are enough to treat a request as remote.
  assert.equal(remote.gate(request({ headers: { host: "127.0.0.1:8091", "cf-ray": "abc" } })).status, 401);
  await remote.disable();
});

test("remote: nothing is gated when remote access was never enabled", () => {
  const { remote } = harness();
  assert.equal(remote.gate(request({ headers: { host: TUNNEL_HOST } })), null);
  assert.equal(remote.tunnelRequest(request({ headers: { host: TUNNEL_HOST } })), false);
});

// ------------------------------------------------------------------ the shape

test("remote: loopback test and token comparison", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost(TUNNEL_HOST), false);
  assert.equal(isLoopbackHost(""), false);

  assert.equal(sameToken("abc", "abc"), true);
  assert.equal(sameToken("abc", "abd"), false);
  assert.equal(sameToken("abc", "abcd"), false, "a length mismatch is a refusal, not a throw");
  assert.equal(sameToken("", ""), false);
  assert.equal(sameToken(null, "abc"), false);
});

test("remote: tokens are 256 bits of base64url, and never repeat", () => {
  const tokens = new Set();
  for (let i = 0; i < 200; i++) {
    const token = mintToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    tokens.add(token);
  }
  assert.equal(tokens.size, 200);
});

test("remote: the local view gets the link and the QR; the phone view gets neither", async () => {
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn });
  remote.enable();
  await deadline(remote.settled());

  const local = remote.statusFor(request({ headers: { host: `127.0.0.1:${UI_PORT}` } }));
  assert.equal(local.view, "local");
  assert.equal(local.canControl, true);
  assert.equal(local.canReveal, true);
  assert.equal(local.link.startsWith(TUNNEL_URL), true);
  assert.equal(local.qr.startsWith("data:image/svg+xml;base64,"), true);

  const phone = remote.statusFor(request({ headers: { host: TUNNEL_HOST, "cf-ray": "abc" } }));
  assert.equal(phone.view, "remote");
  assert.equal(phone.canControl, false, "a phone may not start, stop or re-key the tunnel");
  assert.equal(phone.link, undefined);
  assert.equal(phone.qr, undefined);
  assert.equal(phone.hasToken, true);
  await remote.disable();
});

// ------------------------------------------------------------- the link check

test("remote: check() proves the public URL answers, through an injected fetch", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return {
      status: 200,
      text: async () => JSON.stringify({ remote: { state: "live" } }),
    };
  };
  const spawn = fakeSpawn();
  const { remote } = harness({ spawn, fetchImpl });
  remote.enable();
  await deadline(remote.settled());

  const out = await remote.check();
  assert.equal(out.ok, true);
  assert.equal(out.status, 200);
  assert.match(out.note, /answered this app/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://selective-tony-locking-hull.trycloudflare.com/api/remote/status");
  assert.equal(seen[0].url.includes(remote.token), false, "the code rides in a header, not in a URL the edge logs");
  assert.equal(seen[0].init.headers["x-rosalena-pair"], remote.token);
  await remote.disable();
});

test("remote: check() reports a refused token and an unreachable edge as different failures", async () => {
  const refused = harness({ fetchImpl: async () => ({ status: 403, text: async () => "no" }) });
  refused.remote.enable();
  await deadline(refused.remote.settled());
  const denied = await refused.remote.check();
  assert.equal(denied.ok, false);
  assert.match(denied.error, /refused the pairing code/);
  await refused.remote.disable();

  const broken = harness({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND selective-tony-locking-hull.trycloudflare.com");
    },
  });
  broken.remote.enable();
  await deadline(broken.remote.settled());
  const dead = await broken.remote.check({ attempts: 2, gapMs: 0 });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /did not answer after 2 attempts/);
  assert.match(dead.error, /ENOTFOUND/);
  await broken.remote.disable();
});

test("remote: check() retries a network failure, because the edge is not ready the instant the URL appears", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error("fetch failed");
    return { status: 200, text: async () => JSON.stringify({ remote: { state: "live" } }) };
  };
  const { remote } = harness({ fetchImpl });
  remote.enable();
  await deadline(remote.settled());
  const out = await remote.check({ attempts: 3, gapMs: 0 });
  assert.equal(out.ok, true);
  assert.equal(out.attempt, 3);
  assert.equal(calls, 3);
  await remote.disable();
});

test("remote: check() before a tunnel exists refuses to pretend", async () => {
  const { remote } = harness();
  const out = await remote.check();
  assert.equal(out.ok, false);
  assert.match(out.error, /not live/);
});

// ------------------------------------------------------ the public-URL watchdog

/**
 * A tunnel that is up is not the same thing as a tunnel that works. cloudflared can keep
 * its process alive after it loses its edge registration, and then Cloudflare answers
 * 1033 at the edge while this app reports "live" forever. The watchdog is what closes
 * that gap, so these tests drive its ticks directly instead of waiting a minute.
 */
test("remote: the watchdog keeps a tunnel that answers, and reads a 401 as alive", async () => {
  const answers = [];
  const { remote } = harness({
    healthCheckMs: 0,
    fetchImpl: async (url) => {
      answers.push(url);
      // Its own gate refusing an unauthenticated probe is proof the app is reachable.
      return { status: 401, text: async () => '{"error":"not paired"}' };
    },
  });
  remote.enable();
  await deadline(remote.settled());

  assert.equal(await remote.healthTick(), true);
  assert.equal(await remote.healthTick(), true);
  assert.equal(remote.status().state, "live");
  assert.equal(remote.status().hasToken, true);
  // The probe deliberately carries no token: a link in a log would be a leak.
  assert.equal(answers[0].includes("?"), false);
  assert.match(answers[0], /\/api\/remote\/status$/);
  await remote.disable();
});

test("remote: two dead probes in a row stop the tunnel and kill the process", async () => {
  let dead = false;
  const { fake, remote } = harness({
    healthCheckMs: 0,
    fetchImpl: async () => {
      if (!dead) return { status: 200, text: async () => "{}" };
      throw new Error("getaddrinfo ENOTFOUND weekend-thrown-handbags-girls.trycloudflare.com");
    },
  });
  remote.enable();
  await deadline(remote.settled());

  assert.equal(await remote.healthTick(), true);
  dead = true;
  assert.equal(await remote.healthTick(), true, "one miss is not a death");
  assert.equal(remote.status().state, "live");

  assert.equal(await remote.healthTick(), false);
  const status = remote.status();
  assert.equal(status.state, "failed");
  assert.match(status.reason, /stopped answering on its public URL/);
  assert.match(status.reason, /2 probes in a row/);
  assert.equal(remote.status({ revealSecret: true }).link, null, "a failed tunnel hands out no link");
  assert.equal(fake.taskkills.length, 1, "the process is stopped, not merely relabelled");
  assert.match(fake.taskkills[0].args.join(" "), /\/T \/F$/);
});

test("remote: the watchdog does nothing when the tunnel is off", async () => {
  const { remote } = harness({ healthCheckMs: 0 });
  assert.equal(await remote.healthTick(), null);
  assert.equal(remote.status().state, "idle");
});

// ----------------------------------------------------------------- the QR code

/** The function map as the spec describes it: what a scanner treats as not-data. */
function functionMap(version, size) {
  const map = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) mark(cx + dx, cy + dy);
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(align[i] + dx, align[j] + dy);
    }
  }
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      mark(8, i);
      mark(i, 8);
    }
  }
  mark(8, 6);
  mark(6, 8);
  mark(8, size - 8);
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 0; i < 7; i++) mark(8, size - 7 + i);
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mark(size - 11 + j, i);
        mark(i, size - 11 + j);
      }
    }
  }
  return map;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Read the symbol the way a scanner does: skip function modules, unmask, collect bits. */
function readCodewords(matrix) {
  const { size, version, mask, modules } = matrix;
  const map = functionMap(version, size);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (map[y][x]) continue;
        bits.push(modules[y][x] !== MASKS[mask](x, y) ? 1 : 0);
      }
    }
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  return out;
}

test("QR: what the matrix says is what the encoder wrote (single block)", () => {
  const text = `https://selective-tony-locking-hull.trycloudflare.com/?t=${"A".repeat(43)}`;
  const matrix = encodeQr(text, { ecl: "M" });
  assert.equal(matrix.version, 6, "100 bytes at level M land on version 6");
  assert.equal(matrix.size, 41);
  const read = readCodewords(matrix);
  assert.deepEqual(read.slice(0, matrix.codewords.length), Array.from(matrix.codewords));
});

test("QR: the interleaved blocks survive a read-back at a multi-block version", () => {
  const text = `https://selective-tony-locking-hull.trycloudflare.com/?t=${"B".repeat(43)}`;
  const matrix = encodeQr(text, { ecl: "Q" }); // version 8 at Q: several blocks, interleaved
  assert.ok(matrix.version >= 7, "this case must exercise the version-information block");
  assert.deepEqual(readCodewords(matrix).slice(0, matrix.codewords.length), Array.from(matrix.codewords));
});

test("QR: the three finder patterns, the timing rows and the dark module are where a scanner looks", () => {
  const matrix = encodeQr("https://example.trycloudflare.com/?t=x", { ecl: "M" });
  const { size } = matrix;
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        const want = ring === 3 || ring <= 1;
        assert.equal(matrix.at(cx + dx, cy + dy), want, `finder at ${cx},${cy} offset ${dx},${dy}`);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(matrix.at(i, 6), i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(matrix.at(6, i), i % 2 === 0, `vertical timing at ${i}`);
  }
  assert.equal(matrix.at(8, size - 8), true, "the always-dark module");
});

test("QR: the same text always produces the same symbol, and a different one once it changes", () => {
  const a = encodeQr("https://one.trycloudflare.com/?t=abc", { ecl: "M" });
  const b = encodeQr("https://one.trycloudflare.com/?t=abc", { ecl: "M" });
  const c = encodeQr("https://one.trycloudflare.com/?t=abd", { ecl: "M" });
  assert.deepEqual(a.modules, b.modules);
  assert.notDeepEqual(a.modules, c.modules);
  assert.equal(a.mask, b.mask);
});

test("QR: the format information matches the standard's constants", () => {
  // From ISO/IEC 18004: level M with mask pattern 0 is 101010000010010.
  assert.equal(formatBits("M", 0), 0b101010000010010);
  assert.equal(formatBits("L", 0).toString(2).padStart(15, "0"), "111011111000100");
});

test("QR: the data URI is self-contained SVG, with no request and no external link", () => {
  const uri = qrDataUri("https://example.trycloudflare.com/?t=abc", { ecl: "M" });
  assert.equal(uri.startsWith("data:image/svg+xml;base64,"), true);
  const svg = Buffer.from(uri.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(svg), false, "no URL may be embedded in the image");
  assert.match(svg, /<path d="M/);
  assert.equal((svg.match(/<path/g) ?? []).length, 1, "one path, not four hundred rects");
  assert.equal(svg.includes("abc"), false, "the token must not be spelled out in the image");
});

test("QR: the symbol scales without redrawing anything", () => {
  const matrix = encodeQr("https://example.trycloudflare.com", { ecl: "L" });
  const small = qrSvg(matrix, { scale: 2, margin: 2 });
  const large = qrSvg(matrix, { scale: 8, margin: 4 });
  assert.match(small, new RegExp(`width="${(matrix.size + 4) * 2}"`));
  assert.match(large, new RegExp(`width="${(matrix.size + 8) * 8}"`));
  assert.equal(small.includes('fill="#000000"'), true);
  assert.equal(qrSvg(matrix, { dark: "#04161c" }).includes('fill="#04161c"'), true);
});

test("QR: a payload too large for version 10 fails loudly instead of emitting a bad code", () => {
  assert.throws(() => encodeQr("x".repeat(400), { ecl: "H" }), /does not fit a version-10 QR code/);
});

test("QR: every error-correction level encodes the same text to its own size", () => {
  const text = "https://example.trycloudflare.com/?t=abc";
  const versions = ["L", "M", "Q", "H"].map((ecl) => encodeQr(text, { ecl }).version);
  for (let i = 1; i < versions.length; i++) {
    assert.ok(versions[i] >= versions[i - 1], `level ${["L", "M", "Q", "H"][i]} needs at least the version before it`);
  }
});

// ------------------------------------------------------- the routes on a server

/**
 * The wiring, through a real socket. Nothing here turns a tunnel on: the one route that
 * could is pointed at a binary that does not exist, so it must fail with a sentence
 * instead of spawning anything.
 *
 * `host` is spoofed on purpose. A request that says it wants the tunnel's hostname is
 * the only way to see - without Cloudflare in the middle - that the page served to a
 * phone does not carry the app's write token.
 */
const SERVER = { root: mkdtempSync(join(tmpdir(), "harness-remote-")), token: "remote-test-token-0123456789" };
let ui = null;
let port = 0;

function wire(path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("server: /remote is served on loopback with the write token, and to a phone without it", async () => {
  ui = createUiServer({
    port: 0,
    home: join(SERVER.root, "home"),
    workspace: SERVER.root,
    routerUrl: "http://127.0.0.1:1/v1",
    token: SERVER.token,
    // Never download cloudflared or reach the relay from a test.
    remoteOptions: { install: null, relay: null },
  });
  const state = await ui.ready();
  port = state.port;

  const local = await wire("/remote", { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(local.status, 200);
  assert.match(local.body, /<title>Remote access/);
  assert.match(local.body, new RegExp(`window\\.ROSALENA_TOKEN = "${SERVER.token}"`));
  assert.match(local.body, /href="\/remote\.css"/);
  assert.match(local.body, /src="\/remote\.js"/);

  // The same page as a phone would ask for it. This is the property that matters: the
  // app's own write token must never travel to a device that only holds a pairing token.
  const phone = await wire("/remote", { headers: { host: TUNNEL_HOST } });
  assert.equal(phone.status, 200);
  assert.equal(phone.body.includes(SERVER.token), false);
  assert.match(phone.body, /window\.ROSALENA_TOKEN = ""/);

  const status = await wire("/api/remote/status", { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(status.status, 200);
  const parsed = JSON.parse(status.body).remote;
  assert.equal(parsed.state, "idle");
  assert.equal(parsed.view, "local");
  assert.equal(parsed.canControl, true);

  const fromPhone = JSON.parse((await wire("/api/remote/status", { headers: { host: TUNNEL_HOST } })).body).remote;
  assert.equal(fromPhone.view, "remote");
  assert.equal(fromPhone.canControl, false);
  assert.equal(fromPhone.link, undefined);

  for (const asset of ["/remote.js", "/remote.css"]) {
    const served = await wire(asset, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(served.status, 200, `${asset} must be on the static whitelist`);
    assert.equal(served.headers["content-type"].startsWith(asset.endsWith(".js") ? "text/javascript" : "text/css"), true);
  }
});

test("server: the controls answer only this machine, and only with the write token", async () => {
  const asPhone = await wire("/api/remote/enable", {
    method: "POST",
    headers: { host: TUNNEL_HOST, "x-rosalena-token": SERVER.token, "content-length": 0 },
  });
  assert.equal(asPhone.status, 403);
  assert.match(JSON.parse(asPhone.body).error, /paired phone may not/);

  const noToken = await wire("/api/remote/enable", {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "content-length": 0 },
  });
  assert.equal(noToken.status, 403);
  assert.match(JSON.parse(noToken.body).error, /bad token/);

  // Not a route, and not a way to reach one: with the token it is a plain 404 rather
  // than a control the page could forget to hide.
  const nowhere = await wire("/api/remote/destroy", {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "x-rosalena-token": SERVER.token },
  });
  assert.equal(nowhere.status, 404);

  const unpair = await wire("/api/remote/unpair", { method: "POST", headers: { host: TUNNEL_HOST } });
  assert.equal(unpair.status, 200);
  assert.match(String(unpair.headers["set-cookie"]), new RegExp(`^${COOKIE}=;`));
  assert.match(String(unpair.headers["set-cookie"]), /Max-Age=0/);
});

test("server: enable with no cloudflared fails in the response, and disable clears it", async () => {
  const previous = process.env[BIN_ENV];
  process.env[BIN_ENV] = join(SERVER.root, "definitely-not-here", "cloudflared.exe");
  try {
    const enabled = await wire("/api/remote/enable", {
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, "x-rosalena-token": SERVER.token, "content-length": 0 },
    });
    assert.equal(enabled.status, 200);
    const body = JSON.parse(enabled.body);
    assert.equal(body.ok, false);
    assert.equal(body.remote.state, "failed");
    assert.match(body.remote.reason, /ROSALENA_CLOUDFLARED is set to/);
    assert.equal(body.remote.link ?? null, null, "a failed enable must not hand out a link");
  } finally {
    if (previous === undefined) delete process.env[BIN_ENV];
    else process.env[BIN_ENV] = previous;
  }

  const cleared = await wire("/api/remote/disable", {
    method: "POST",
    headers: { host: `127.0.0.1:${port}`, "x-rosalena-token": SERVER.token, "content-length": 0 },
  });
  assert.equal(cleared.status, 200);
  const after = JSON.parse(cleared.body).remote;
  assert.equal(after.state, "idle");
  await ui?.close();
  ui = null;
});
