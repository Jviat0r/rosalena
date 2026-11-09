/**
 * The update check, proven without a network and without a clock.
 *
 * Three things are being protected here, and they are the three ways this feature could
 * hurt somebody:
 *
 *   1. Semver precedence is the one the spec defines, in both directions. A comparator
 *      that gets `1.0.0-alpha < 1.0.0` wrong tells a user on a beta that they are up to
 *      date, or nags a user on a stable release forever.
 *   2. A manifest cannot point the app at a `javascript:` URL, a plain-http URL, an
 *      unlisted host, or a release date in the future. The URL becomes a link in the app,
 *      so it is checked against an allowlist rather than trusted.
 *   3. The fetch never throws and never hangs. Every failure is `{ ok: false, reason }`,
 *      which is what lets the app say "the check could not be completed, and why" instead
 *      of showing an empty box.
 *
 * The last test in this file replaces `globalThis.fetch` with a function that throws. It
 * is not decoration: a test that forgets to pass `fetchImpl` gets caught by it instead of
 * making a real request from a test runner.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_URL_HOSTS,
  CHECK_INTERVAL_MS,
  MAX_BODY_BYTES,
  MAX_NOTES_CHARS,
  TIMEOUT_MS,
  UPDATE_FEED_URL,
  compareVersions,
  decideUpdate,
  fetchUpdateManifest,
  formatVersion,
  parseVersion,
  readVersionFromPackage,
  shouldCheck,
  validateUpdateManifest,
} from "../src/update.mjs";

// --------------------------------------------------------------------------- fixtures

const NOW = Date.parse("2026-10-20T12:00:00.000Z");

/** A manifest that is valid in every field, so each test can break exactly one field. */
const manifest = (overrides = {}) => ({
  schema: 1,
  channel: "stable",
  version: "0.2.0",
  releasedAt: "2026-10-01T09:30:00.000Z",
  notes: "Faster cold starts.\nThe model picker keeps its selection.",
  url: "https://github.com/rosalena/harness/releases/tag/v0.2.0",
  artifacts: { "Rosalena-Harness-Setup-0.2.0-x64.exe": "a".repeat(64) },
  ...overrides,
});

const body = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });

// The wire is closed for this whole file. The sentinel is asserted, not swallowed.
let networkAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = () => {
  networkAttempts += 1;
  throw new Error("TEST_NETWORK_FORBIDDEN: this file must never reach the real network");
};
after(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------- versions

test("parseVersion reads the four documented spellings and nothing else", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("1.2.3-beta.2"), { major: 1, minor: 2, patch: 3, prerelease: ["beta", "2"] });
  // Build metadata is accepted and then dropped: semver says it has no precedence.
  assert.deepEqual(parseVersion("1.2.3+build.7"), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion("1.2.3-rc.1+build.7"), { major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"] });

  for (const bad of ["1.2", "1.2.3.4", "1.2.x", "abc", "", "1.2.3-", "-1.2.3", "01.2.3", "1.0.0-01", null, undefined, 42, {}]) {
    assert.equal(parseVersion(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test("formatVersion is the string the app prints, build metadata excluded", () => {
  assert.equal(formatVersion(parseVersion("v1.2.3+build.7")), "1.2.3");
  assert.equal(formatVersion(parseVersion("1.2.3-rc.1")), "1.2.3-rc.1");
});

test("semver precedence, in both directions, for the cases that actually get used", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
    "9.9.9",
    "10.0.0",
  ];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const lower = ordered[index];
    const higher = ordered[index + 1];
    assert.equal(compareVersions(lower, higher), -1, `${lower} < ${higher}`);
    assert.equal(compareVersions(higher, lower), 1, `${higher} > ${lower}`);
  }
});

test("equal versions compare equal, and build metadata does not break the tie", () => {
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3+build.7", "1.2.3+build.9"), 0);
  assert.equal(compareVersions("1.2.3-beta", "1.2.3-beta"), 0);
  // Accepts already-parsed versions too, which is what decideUpdate passes down.
  assert.equal(compareVersions(parseVersion("2.0.0"), "1.9.9"), 1);
});

test("a release sorts above its own prerelease, and a longer prerelease sorts higher", () => {
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha.1", "1.0.0-alpha"), 1);
  // Numeric identifiers sort below alphanumeric ones.
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-1"), 1);
  // 10 > 9 numerically, even though "10" < "9" as text.
  assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.9"), 1);
});

test("comparing garbage throws instead of pretending two versions are equal", () => {
  assert.throws(() => compareVersions("not-a-version", "1.0.0"), TypeError);
  assert.throws(() => compareVersions("1.0.0", ""), TypeError);
});

test("readVersionFromPackage returns a normalized version, or null", () => {
  assert.equal(readVersionFromPackage({ name: "x", version: "0.1.0" }), "0.1.0");
  assert.equal(readVersionFromPackage({ version: "v1.2.3+build.7" }), "1.2.3");
  assert.equal(readVersionFromPackage('{"version":"2.0.0-rc.1"}'), "2.0.0-rc.1");
  assert.equal(readVersionFromPackage({ version: "not semver" }), null);
  assert.equal(readVersionFromPackage({ name: "no version" }), null);
  assert.equal(readVersionFromPackage({ version: 1 }), null);
  assert.equal(readVersionFromPackage("{not json"), null);
  assert.equal(readVersionFromPackage(null), null);
});

// ---------------------------------------------------------------------------- manifest

test("a valid manifest is accepted and comes back in its cleaned shape", () => {
  const checked = validateUpdateManifest(manifest(), { now: NOW });
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.manifest, {
    schema: 1,
    channel: "stable",
    version: "0.2.0",
    releasedAt: "2026-10-01T09:30:00.000Z",
    notes: manifest().notes,
    url: "https://github.com/rosalena/harness/releases/tag/v0.2.0",
    artifacts: { "Rosalena-Harness-Setup-0.2.0-x64.exe": "a".repeat(64) },
  });
  assert.deepEqual(ALLOWED_URL_HOSTS, ["rosalena.pages.dev", "github.com"]);
});

test("the committed shape - no release yet - is valid", () => {
  // This is the shape site/public/download/updates.json ships with today.
  const checked = validateUpdateManifest(
    { schema: 1, product: "Rosalena Harness", channel: "stable", version: "0.1.0", releasedAt: null, notes: "", url: "", artifacts: {}, note: "an unknown key is ignored" },
    { now: NOW },
  );
  assert.equal(checked.ok, true);
  assert.equal(checked.manifest.releasedAt, null);
  assert.equal(checked.manifest.url, "");
});

test("validateUpdateManifest names the reason for every refusal", () => {
  const cases = [
    { label: "not an object", value: "nope", reason: /not a JSON object/ },
    { label: "an array", value: [], reason: /not a JSON object/ },
    { label: "bad schema", value: manifest({ schema: 2 }), reason: /schema is 2, expected 1/ },
    { label: "missing schema", value: manifest({ schema: undefined }), reason: /expected 1/ },
    { label: "bad version", value: manifest({ version: "0.2" }), reason: /not a valid version/ },
    { label: "missing version", value: manifest({ version: undefined }), reason: /not a valid version/ },
    { label: "empty channel", value: manifest({ channel: "" }), reason: /channel "" is not a short non-empty name/ },
    { label: "channel is a number", value: manifest({ channel: 7 }), reason: /not a short non-empty name/ },
    { label: "channel too long", value: manifest({ channel: "x".repeat(41) }), reason: /not a short non-empty name/ },
    { label: "releasedAt is a number", value: manifest({ releasedAt: 1 }), reason: /releasedAt must be null or an ISO date string/ },
    { label: "releasedAt is not ISO", value: manifest({ releasedAt: "last tuesday" }), reason: /is not an ISO date string/ },
    {
      label: "releasedAt in the future",
      value: manifest({ releasedAt: "2027-01-01T00:00:00.000Z" }),
      reason: /releasedAt 2027-01-01T00:00:00.000Z is in the future/,
    },
    { label: "notes is a number", value: manifest({ notes: 12 }), reason: /notes must be a string/ },
    { label: "url is a number", value: manifest({ url: 12 }), reason: /url must be a string/ },
    { label: "plain http", value: manifest({ url: "http://github.com/rosalena/harness" }), reason: /is not https/ },
    { label: "javascript url", value: manifest({ url: "javascript:alert(1)" }), reason: /is not https/ },
    { label: "data url", value: manifest({ url: "data:text/html,<script>alert(1)</script>" }), reason: /is not https/ },
    { label: "file url", value: manifest({ url: "file:///C:/Windows/System32/calc.exe" }), reason: /is not https/ },
    { label: "unlisted host", value: manifest({ url: "https://example.test/download" }), reason: /is not one of/ },
    { label: "lookalike host", value: manifest({ url: "https://github.com.evil.test/x" }), reason: /is not one of/ },
    { label: "credentials in url", value: manifest({ url: "https://user:pass@github.com/x" }), reason: /carries credentials/ },
    { label: "control characters", value: manifest({ url: "https://github.com/\u0007x" }), reason: /control characters/ },
    { label: "artifacts is an array", value: manifest({ artifacts: [] }), reason: /artifacts must be a plain object/ },
    { label: "artifacts is a string", value: manifest({ artifacts: "a.exe" }), reason: /artifacts must be a plain object/ },
    { label: "artifact value is a number", value: manifest({ artifacts: { "a.exe": 1 } }), reason: /artifacts\["a\.exe"\] is not a string/ },
  ];
  for (const entry of cases) {
    const checked = validateUpdateManifest(entry.value, { now: NOW });
    assert.equal(checked.ok, false, `${entry.label} was accepted`);
    assert.match(checked.reason, entry.reason, `${entry.label}: ${checked.reason}`);
  }
});

test("a date exactly now is not the future, and a missing releasedAt is null", () => {
  assert.equal(validateUpdateManifest(manifest({ releasedAt: new Date(NOW).toISOString() }), { now: NOW }).ok, true);
  const checked = validateUpdateManifest(manifest({ releasedAt: undefined }), { now: NOW });
  assert.equal(checked.ok, true);
  assert.equal(checked.manifest.releasedAt, null);
});

test("notes are truncated, not refused, at the documented limit", () => {
  const long = "n".repeat(MAX_NOTES_CHARS + 500);
  const checked = validateUpdateManifest(manifest({ notes: long }), { now: NOW });
  assert.equal(checked.ok, true);
  assert.equal(checked.manifest.notes.length, MAX_NOTES_CHARS);
  assert.equal(MAX_NOTES_CHARS, 2000);
});

test("an allowlisted https page on rosalena.pages.dev is accepted", () => {
  const checked = validateUpdateManifest(manifest({ url: "https://rosalena.pages.dev/releases/0.2.0" }), { now: NOW });
  assert.equal(checked.ok, true);
  assert.equal(checked.manifest.url, "https://rosalena.pages.dev/releases/0.2.0");
});

// ------------------------------------------------------------------------------ decide

test("decideUpdate says available only for a newer version with a release page", () => {
  const verdict = decideUpdate({ current: "0.1.0", manifest: manifest(), now: NOW });
  assert.equal(verdict.state, "available");
  assert.equal(verdict.current, "0.1.0");
  assert.equal(verdict.latest, "0.2.0");
  assert.equal(verdict.url, "https://github.com/rosalena/harness/releases/tag/v0.2.0");
  assert.match(verdict.notes, /Faster cold starts/);
  assert.equal(verdict.releasedAt, "2026-10-01T09:30:00.000Z");
  assert.match(verdict.reason, /0\.2\.0 is available/);
});

test("decideUpdate says current when the versions match, including today's 0.1.0 and no release", () => {
  const verdict = decideUpdate({
    current: "0.1.0",
    manifest: { schema: 1, channel: "stable", version: "0.1.0", releasedAt: null, notes: "", url: "", artifacts: {} },
    now: NOW,
  });
  assert.equal(verdict.state, "current");
  assert.equal(verdict.latest, "0.1.0");
  assert.equal(verdict.reason, "you are up to date at 0.1.0");
});

test("decideUpdate says current when the app is newer than the published one", () => {
  const verdict = decideUpdate({ current: "0.3.0", manifest: manifest({ version: "0.2.0" }), now: NOW });
  assert.equal(verdict.state, "current");
  assert.match(verdict.reason, /you are on 0\.3\.0, newer than the published 0\.2\.0/);
});

test("a newer version with no url is unknown, never available", () => {
  const verdict = decideUpdate({ current: "0.1.0", manifest: manifest({ url: "" }), now: NOW });
  assert.equal(verdict.state, "unknown");
  assert.notEqual(verdict.state, "available");
  assert.equal(verdict.url, "");
  assert.equal(verdict.latest, "0.2.0");
  assert.match(verdict.reason, /0\.2\.0 is published but the manifest carries no release page/);
});

test("an unusable manifest is unknown, and the reason is the validator's", () => {
  const verdict = decideUpdate({ current: "0.1.0", manifest: { schema: 1, version: "0.2.0" }, now: NOW });
  assert.equal(verdict.state, "unknown");
  assert.match(verdict.reason, /cannot be used/);

  const missing = decideUpdate({ current: "0.1.0", now: NOW });
  assert.equal(missing.state, "unknown");
  assert.match(missing.reason, /not a JSON object/);
});

test("an unreadable current version is unknown rather than 'up to date'", () => {
  const verdict = decideUpdate({ current: "who knows", manifest: manifest(), now: NOW });
  assert.equal(verdict.state, "unknown");
  assert.equal(verdict.current, null);
  assert.match(verdict.reason, /is not a version/);
});

test("decideUpdate always returns the same seven fields", () => {
  const shapes = [
    decideUpdate({ current: "0.1.0", manifest: manifest(), now: NOW }),
    decideUpdate({ current: "0.1.0", manifest: manifest({ version: "0.1.0" }), now: NOW }),
    decideUpdate({ current: "nope", manifest: manifest(), now: NOW }),
  ];
  for (const verdict of shapes) {
    assert.deepEqual(Object.keys(verdict).sort(), ["current", "latest", "notes", "reason", "releasedAt", "state", "url"]);
  }
});

// ------------------------------------------------------------------------------ timing

test("shouldCheck honours the six-hour floor", () => {
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(shouldCheck({ lastCheckedAt: new Date(NOW - 1000).toISOString(), now: NOW }), false);
  assert.equal(shouldCheck({ lastCheckedAt: new Date(NOW - CHECK_INTERVAL_MS).toISOString(), now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: NOW - CHECK_INTERVAL_MS + 1, now: NOW }), false);
  assert.equal(shouldCheck({ lastCheckedAt: NOW - CHECK_INTERVAL_MS - 1, now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: new Date(NOW - 7 * 60 * 60 * 1000), now: NOW }), true);
});

test("shouldCheck checks now when the timestamp is missing or unreadable", () => {
  assert.equal(shouldCheck({ lastCheckedAt: null, now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: undefined, now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: "", now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: "not a date", now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: {}, now: NOW }), true);
  assert.equal(shouldCheck({ lastCheckedAt: NaN, now: NOW }), true);
  assert.equal(shouldCheck({ now: NOW }), true);
});

test("a timestamp in the future is not trusted to suppress a check", () => {
  assert.equal(shouldCheck({ lastCheckedAt: NOW + 9 * 60 * 1000, now: NOW }), true);
});

test("shouldCheck accepts an explicit interval and a zero interval", () => {
  assert.equal(shouldCheck({ lastCheckedAt: NOW - 1000, now: NOW, minIntervalMs: 500 }), true);
  assert.equal(shouldCheck({ lastCheckedAt: NOW, now: NOW, minIntervalMs: 0 }), true);
  assert.equal(shouldCheck({ lastCheckedAt: new Date(NOW - 1000), now: NOW, minIntervalMs: 60_000 }), false);
});

// ------------------------------------------------------------------------------- fetch

test("fetchUpdateManifest reads a valid manifest and sends only Accept", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return body(manifest());
  };
  const result = await fetchUpdateManifest({ url: UPDATE_FEED_URL, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.version, "0.2.0");
  assert.equal(result.manifest.channel, "stable");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://rosalena.pages.dev/download/updates.json");
  // The one header: no user agent, no install id, no version, and no query string.
  assert.deepEqual(Object.keys(calls[0].options.headers), ["accept"]);
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.equal(new URL(calls[0].url).search, "");
  assert.equal(TIMEOUT_MS, 5000);
});

test("fetchUpdateManifest reports a non-200 answer", async () => {
  const result = await fetchUpdateManifest({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => "not found" }) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 404/);

  const noStatus = await fetchUpdateManifest({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(noStatus.ok, false);
  assert.match(noStatus.reason, /HTTP unknown/);
});

test("fetchUpdateManifest reports a body that is not JSON", async () => {
  const result = await fetchUpdateManifest({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>hello</html>" }) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not answer with JSON/);
});

test("fetchUpdateManifest refuses a body over the byte limit, three ways", async () => {
  const huge = "x".repeat(MAX_BODY_BYTES + 1);

  const fromText = await fetchUpdateManifest({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => huge }) });
  assert.equal(fromText.ok, false);
  assert.match(fromText.reason, new RegExp(`more than ${MAX_BODY_BYTES} bytes`));

  const declared = await fetchUpdateManifest({
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => String(MAX_BODY_BYTES + 1) }, text: async () => "{}" }),
  });
  assert.equal(declared.ok, false);
  assert.match(declared.reason, new RegExp(`sent ${MAX_BODY_BYTES + 1} bytes`));

  async function* stream() {
    yield Buffer.from("{");
    yield Buffer.from(huge);
  }
  const streamed = await fetchUpdateManifest({ fetchImpl: async () => ({ ok: true, status: 200, body: stream() }) });
  assert.equal(streamed.ok, false);
  assert.match(streamed.reason, /was not read/);
});

test("fetchUpdateManifest catches a network throw instead of throwing", async () => {
  const result = await fetchUpdateManifest({
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND rosalena.pages.dev");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be reached: getaddrinfo ENOTFOUND/);
});

test("fetchUpdateManifest refuses a manifest the app could not trust", async () => {
  const result = await fetchUpdateManifest({ fetchImpl: async () => body(manifest({ url: "javascript:alert(1)" })) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /manifest is unusable/);
  assert.match(result.reason, /is not https/);
});

test("fetchUpdateManifest refuses a bad feed address without calling fetch", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return body(manifest());
  };
  assert.equal((await fetchUpdateManifest({ url: "javascript:alert(1)", fetchImpl })).ok, false);
  assert.equal((await fetchUpdateManifest({ url: "not a url", fetchImpl })).ok, false);
  assert.equal((await fetchUpdateManifest({ fetchImpl: undefined, url: UPDATE_FEED_URL })).ok, false);
  assert.equal(called, false);
});

test("a request that never resolves settles as a timeout instead of hanging", async () => {
  const ignoredSignal = await fetchUpdateManifest({
    fetchImpl: () => new Promise(() => {}),
    timeoutMs: 25,
  });
  assert.equal(ignoredSignal.ok, false);
  assert.match(ignoredSignal.reason, /timed out after 25ms/);

  // The same deadline, through a fetch that honours the abort signal it was given.
  const aborted = await fetchUpdateManifest({
    timeoutMs: 25,
    fetchImpl: (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  assert.equal(aborted.ok, false);
  assert.match(aborted.reason, /timed out after 25ms/);
});

test("the default fetch implementation is globalThis.fetch, and this file's is a trap", async () => {
  // No fetchImpl on purpose: if the default were not globalThis.fetch, or if this file
  // had leaked a real implementation in, the assertion below would be a live request.
  const result = await fetchUpdateManifest({ url: UPDATE_FEED_URL, timeoutMs: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /TEST_NETWORK_FORBIDDEN/);
  assert.ok(networkAttempts >= 1);
  assert.equal(typeof globalThis.fetch, "function");
});
