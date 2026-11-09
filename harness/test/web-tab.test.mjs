// The sidebar's Browser tabs (+ > Web > Browser): what the address box makes of what was
// typed, which addresses a tab may open, how saved tabs come back after a restart, and the
// rules the desktop shell forces on every <webview> (harness/ui/web-tab.mjs, used by both
// app.js and desktop/main.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BROWSER_PARTITION,
  HOME_URL,
  SEARCH_URL,
  SELECTION_MAX,
  checkWebUrl,
  cleanUserAgent,
  hardenWebview,
  isWebTabId,
  newWebTabId,
  pageToChatText,
  parseAddress,
  permissionDecision,
  sameAppOrigin,
  sanitizeWebState,
  securityOf,
  serializeWebState,
  webTabLabel,
} from "../ui/web-tab.mjs";

const APP = "http://127.0.0.1:51234";

test("the address box: full addresses, bare hosts, local servers and search words", () => {
  assert.deepEqual(parseAddress("https://example.com/a?b=1"), { url: "https://example.com/a?b=1", kind: "url" });
  assert.deepEqual(parseAddress("  example.com  "), { url: "https://example.com/", kind: "url" });
  assert.deepEqual(parseAddress("rosalena.dev/download/solbrowser/"), { url: "https://rosalena.dev/download/solbrowser/", kind: "url" });
  assert.deepEqual(parseAddress("localhost:5173"), { url: "http://localhost:5173/", kind: "url" });
  assert.deepEqual(parseAddress("localhost:5173/app#x"), { url: "http://localhost:5173/app#x", kind: "url" });
  assert.deepEqual(parseAddress("127.0.0.1:8080"), { url: "http://127.0.0.1:8080/", kind: "url" });
  assert.deepEqual(parseAddress("192.168.1.20"), { url: "http://192.168.1.20/", kind: "url" });
  assert.deepEqual(parseAddress("8.8.8.8"), { url: "https://8.8.8.8/", kind: "url" });
  assert.deepEqual(parseAddress("example.com:8443/x"), { url: "https://example.com:8443/x", kind: "url" });
  assert.deepEqual(parseAddress("HTTP://Example.COM"), { url: "http://example.com/", kind: "url" });
  assert.deepEqual(parseAddress("about:blank"), { url: "about:blank", kind: "url" });
  assert.deepEqual(parseAddress("how do webviews work"), { url: `${SEARCH_URL}how%20do%20webviews%20work`, kind: "search" });
  assert.deepEqual(parseAddress("rosalena"), { url: `${SEARCH_URL}rosalena`, kind: "search" });
  assert.deepEqual(parseAddress("node.js"), { url: "https://node.js/", kind: "url" }, "a dotted name is taken as a host");
  assert.deepEqual(parseAddress("c++ & rust?"), { url: `${SEARCH_URL}c%2B%2B%20%26%20rust%3F`, kind: "search" });
  assert.equal(parseAddress(""), null);
  assert.equal(parseAddress("   "), null);
});

test("the address box refuses what is not a web page, with a sentence", () => {
  for (const text of ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,<b>x</b>", "chrome://settings", "view-source:https://a.com"]) {
    const out = parseAddress(text);
    assert.ok(out?.error, `${text} is refused`);
    assert.match(out.error, /http and https/);
  }
});

test("a tab opens only web pages: no files, scripts, credentials or the app's own server", () => {
  assert.equal(checkWebUrl("https://example.com", { appOrigin: APP }).ok, true);
  assert.equal(checkWebUrl("http://localhost:3000/", { appOrigin: APP }).ok, true, "someone else's local server is fine");
  assert.equal(checkWebUrl("about:blank").ok, true);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "chrome://gpu", "about:config", "nonsense"]) {
    assert.equal(checkWebUrl(url, { appOrigin: APP }).ok, false, url);
  }
  assert.match(checkWebUrl("https://user:pw@example.com/").reason, /password/);
  assert.match(checkWebUrl(`${APP}/api/sessions`, { appOrigin: APP }).reason, /app's own/);
  assert.equal(checkWebUrl("http://localhost:51234/", { appOrigin: APP }).ok, false, "localhost is the same server");
  assert.equal(checkWebUrl("http://127.0.0.2:51234/", { appOrigin: APP }).ok, false, "all of 127/8 is this PC");
  assert.equal(checkWebUrl("http://127.0.0.1:51235/", { appOrigin: APP }).ok, true, "another port is another server");
  assert.equal(sameAppOrigin("https://127.0.0.1:51234/", APP), false, "another scheme is another origin");
  assert.equal(sameAppOrigin("http://x", ""), false);
});

test("the lock: https secure, http insecure unless it is on this PC or the network", () => {
  assert.equal(securityOf("https://example.com/"), "secure");
  assert.equal(securityOf("http://example.com/"), "insecure");
  assert.equal(securityOf("http://localhost:5173/"), "local");
  assert.equal(securityOf("http://10.1.2.3/"), "local");
  assert.equal(securityOf("http://172.20.0.1/"), "local");
  assert.equal(securityOf("http://172.40.0.1/"), "insecure");
  assert.equal(securityOf("about:blank"), "blank");
  assert.equal(securityOf(""), "blank");
});

test("tab ids and labels", () => {
  const id = newWebTabId(["web:aaaaaa"], () => 0.5);
  assert.ok(isWebTabId(id), id);
  assert.notEqual(newWebTabId([id], () => 0.5), id, "an id that is taken is not handed out again");
  assert.equal(isWebTabId("web:"), false);
  assert.equal(isWebTabId("web:../x"), false);
  assert.equal(isWebTabId("folder:web:abc"), false);
  assert.equal(webTabLabel({ url: "https://www.example.com/x", title: "" }), "example.com");
  assert.equal(webTabLabel({ url: "https://example.com/", title: "Example Domain" }), "Example Domain");
  assert.equal(webTabLabel({ title: "A".repeat(40) }).length, 28);
  assert.equal(webTabLabel(undefined), "Browser");
});

test("saved tabs come back cleaned: unknown, closed and unsafe entries do not survive a restart", () => {
  const saved = JSON.stringify({
    v: 1,
    tabs: {
      "web:aaa111": { url: "https://example.com/page", title: "Example" },
      "web:bbb222": { url: "file:///C:/secret.txt", title: "x" },
      "web:ccc333": { url: `${APP}/`, title: "the app" },
      "web:closed1": { url: "https://gone.example/", title: "closed" },
      "web:ddd444": { url: 42, title: { no: 1 } },
    },
  });
  const open = ["files", "web:aaa111", "web:bbb222", "web:ccc333", "web:ddd444", "web:new555", "folder:D:\\x"];
  const out = sanitizeWebState(saved, open, { appOrigin: APP });
  assert.deepEqual(Object.keys(out).sort(), ["web:aaa111", "web:bbb222", "web:ccc333", "web:ddd444", "web:new555"]);
  assert.deepEqual(out["web:aaa111"], { url: "https://example.com/page", title: "Example" });
  assert.equal(out["web:bbb222"].url, HOME_URL, "a file: address is reset to the home page");
  assert.equal(out["web:ccc333"].url, HOME_URL, "the app's own page is reset to the home page");
  assert.deepEqual(out["web:ddd444"], { url: HOME_URL, title: "" });
  assert.deepEqual(out["web:new555"], { url: HOME_URL, title: "" }, "a tab with no saved state opens the home page");
  // An older bare map, junk and nothing at all.
  assert.equal(sanitizeWebState({ "web:aaa111": { url: "https://a.example/" } }, ["web:aaa111"])["web:aaa111"].url, "https://a.example/");
  assert.deepEqual(sanitizeWebState("{not json", ["web:aaa111"]), { "web:aaa111": { url: HOME_URL, title: "" } });
  assert.deepEqual(sanitizeWebState(null, []), {});
  // Round trip, and an empty state saves as nothing.
  const back = sanitizeWebState(serializeWebState(out), open, { appOrigin: APP });
  assert.deepEqual(back, out);
  assert.equal(serializeWebState({}), "");
  assert.equal(serializeWebState({ "not-a-tab": { url: "https://x.example/" } }), "");
  assert.ok(!serializeWebState({ "web:aaa111": { url: "https://x.example/", title: "t", icon: "https://x.example/f.ico" } }).includes("icon"), "the favicon is not kept");
});

test("Send page to chat: title, address and the selection, quoted and clipped", () => {
  assert.equal(pageToChatText({ url: "https://example.com/", title: "Example Domain" }), "Page: Example Domain\nURL: https://example.com/");
  assert.equal(pageToChatText({ url: "https://example.com/" }), "Page: https://example.com/\nURL: https://example.com/");
  assert.equal(
    pageToChatText({ url: "https://a.example/", title: "A", selection: "  line one\r\nline two  " }),
    "Page: A\nURL: https://a.example/\n\nSelected text:\n> line one\n> line two",
  );
  const long = pageToChatText({ url: "https://a.example/", title: "A", selection: "x".repeat(SELECTION_MAX + 50) });
  assert.ok(long.endsWith("…"));
  assert.ok(long.length < SELECTION_MAX + 80);
});

test("every webview is locked down by the shell, whatever the page asked for", () => {
  const prefs = { preload: "C:/evil.js", preloadURL: "file:///evil.js", nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false, enableBlinkFeatures: "X", webviewTag: true };
  const params = { src: "https://example.com/", partition: BROWSER_PARTITION, preload: "file:///evil.js" };
  assert.deepEqual(hardenWebview(prefs, params, { appOrigin: APP }), { ok: true });
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.preloadURL, undefined);
  assert.equal(params.preload, undefined);
  assert.equal(prefs.enableBlinkFeatures, undefined);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.partition, BROWSER_PARTITION);
  assert.equal(hardenWebview({}, { src: "", partition: BROWSER_PARTITION }).ok, true, "a webview with no page yet");
  assert.equal(hardenWebview({}, { src: "https://a.example/" }).ok, false, "the default session is refused");
  assert.equal(hardenWebview({}, { src: "https://a.example/", partition: "persist:other" }).ok, false);
  assert.equal(hardenWebview({}, { src: "file:///C:/x", partition: BROWSER_PARTITION }).ok, false);
  assert.equal(hardenWebview({}, { src: `${APP}/`, partition: BROWSER_PARTITION }, { appOrigin: APP }).ok, false);
  assert.ok(BROWSER_PARTITION.startsWith("persist:"), "logins survive a restart");
});

test("site permissions: harmless ones allowed, private ones asked, the rest refused", () => {
  assert.equal(permissionDecision("fullscreen").decision, "allow");
  assert.equal(permissionDecision("clipboard-sanitized-write").decision, "allow");
  for (const p of ["media", "geolocation", "notifications", "clipboard-read"]) {
    const out = permissionDecision(p);
    assert.equal(out.decision, "ask", p);
    assert.ok(out.what.length > 5);
  }
  for (const p of ["openExternal", "midiSysex", "hid", "serial", "usb", "pointerLock", "display-capture", "unknown-thing"]) assert.equal(permissionDecision(p).decision, "deny", p);
});

test("the browser session's user agent does not say Electron or the app's name", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) rosalena-desktop/0.1.13 Chrome/140.0.0.0 Electron/44.9.1 Safari/537.36";
  assert.equal(cleanUserAgent(ua, ["rosalena-desktop", "Rosalena Harness"]), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
  assert.equal(cleanUserAgent("A Rosalena Harness/0.1.13 Chrome/1 Electron/2", ["Rosalena Harness"]), "A Chrome/1");
  // What Electron 44 really sends: the product name with its space taken out.
  assert.equal(cleanUserAgent("A (KHTML, like Gecko) RosalenaHarness/0.1.13 Chrome/152.0.7977.167 Safari/537.36", ["Rosalena Harness"]), "A (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36");
});

// The pieces app.js and the shell must keep in place for the tab to work at all.
test("the wiring: the page can load web-tab.mjs, the shell turns webviews on and checks each one", () => {
  const ui = readFileSync(new URL("../src/ui.mjs", import.meta.url), "utf8");
  assert.match(ui, /path === "\/web-tab\.mjs"/, "the server serves the module app.js imports");
  const main = readFileSync(new URL("../../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /webviewTag: true/);
  assert.match(main, /"will-attach-webview"[\s\S]{0,200}hardenWebview\(/);
  assert.match(main, /"did-attach-webview"/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\) => \{\s*if \(url && url !== "about:blank" && allowed\(url\)\) contents\.loadURL/, "new windows open in the same tab");
  const preload = readFileSync(new URL("../../desktop/preload.mjs", import.meta.url), "utf8");
  assert.match(preload, /canBrowse: true/);
  const app = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /from "\.\/web-tab\.mjs"/);
  assert.match(app, /isWebTabId\(id\)\)\)/, "saved web: tabs are read back");
  assert.match(app, /setAttribute\("partition", BROWSER_PARTITION\)/);
});
