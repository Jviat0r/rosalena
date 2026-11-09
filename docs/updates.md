# Update checks

The installed app checks whether a newer version has been published. It reads one small JSON
file, compares the version in it with its own, and says one of three things. When the answer is
"a newer version exists", the desktop app asks **Update and restart / Later / Skip this
version**, and only on a yes does it download the file for this platform, refuse it unless its
SHA-256 matches the feed, install it and reopen (section 10). It never installs without asking,
and never claims an update it cannot point at.

> Sections 1-9 below describe the check as first written; the "never downloads" wording in
> them predates section 10.

**Status today: nothing has been published.** `site/public/download/updates.json` names version
`0.1.0`, the version the app already is, with no release date, no release page and no artifact.
An installed copy therefore reports **"you are up to date at 0.1.0"** - which is true, because
nothing newer exists. That is the honest state of a repository where no release workflow has ever
run; see `release.md` for why no artifact exists.

---

## 1. The three answers

| State | When | What the person sees |
|---|---|---|
| `current` | the feed's version is equal to, or older than, the running version | "You are up to date at 0.1.0" (or "you are on 0.2.0, newer than the published 0.1.0" during a rollback or a local build) |
| `available` | the feed's version is **strictly greater** *and* the feed carries a release page | the version, its date, its notes and **one link**: the release page. Not a file. |
| `unknown` | anything else - no network, non-200, non-JSON, a feed the app refuses, a newer version with no release page, an unreadable local version | "The check could not be completed", plus the reason in a sentence |

`available` requires both halves on purpose. A newer version with an empty `url` is `unknown`, not
`available`: an update notice you cannot act on is worse than an honest failure, and "there is a
new version but I cannot show you where" is a reason, not an update.

## 2. The feed

`site/public/download/updates.json`, served as a static file. Today:

```json
{
  "schema": 1,
  "product": "Rosalena Harness",
  "channel": "stable",
  "version": "0.1.0",
  "releasedAt": null,
  "notes": "",
  "url": "",
  "artifacts": {},
  "updated": "2026-10-20"
}
```

| Field | Meaning | Rule the app enforces |
|---|---|---|
| `schema` | format version | must be `1` |
| `version` | the newest published version | valid semver (`1.2.3`, `1.2.3-rc.1`); build metadata is ignored |
| `channel` | `stable`, `prerelease`, anything short | non-empty, at most 40 characters |
| `releasedAt` | when it was published, UTC ISO, or `null` | ISO date, **not in the future**; `null` is allowed and means "no release date recorded" |
| `notes` | a short human summary | a string, truncated to 2000 characters (not refused) |
| `url` | the **release page** | `""`, or an `https` URL whose host is exactly `rosalena.pages.dev` or `github.com` |
| `artifacts` | file name -> SHA-256, as measured | a plain object whose values are strings; optional |
| anything else | ignored | unknown keys are dropped, not fatal |

`url` is a page, never a download URL. The app opens it in a browser; the person installs. That is
also why the allowlist exists: this string is rendered as a link, so `javascript:`, `data:`,
`file:`, plain `http:` and any other host are refused and the check reports itself as incomplete.

The JSON is written by hand for `0.1.0` (JSON has no comments, which is why this file exists) and
rewritten by the release pipeline afterwards.

## 3. The module

`harness/src/update.mjs` - zero dependencies, node builtins only, no side effects at import, and no
network call until you ask for one.

```js
import {
  UPDATE_FEED_URL,        // "https://rosalena.pages.dev/download/updates.json"
  CHECK_INTERVAL_MS,      // 6 hours
  TIMEOUT_MS,             // 5000
  MAX_BODY_BYTES,         // 256 KiB
  MAX_NOTES_CHARS,        // 2000
  ALLOWED_URL_HOSTS,      // ["rosalena.pages.dev", "github.com"]
  parseVersion,           // (text) -> { major, minor, patch, prerelease: string[] } | null
  formatVersion,          // (parsed) -> "1.2.3" | "1.2.3-rc.1"
  compareVersions,        // (a, b) -> -1 | 0 | 1   (throws TypeError on garbage)
  readVersionFromPackage, // (parsed or text package.json) -> "0.1.0" | null
  validateUpdateManifest, // (value, { now }) -> { ok: true, manifest } | { ok: false, reason }
  decideUpdate,           // ({ current, manifest, now }) -> { state, current, latest, url, notes, releasedAt, reason }
  shouldCheck,            // ({ lastCheckedAt, now, minIntervalMs }) -> boolean
  fetchUpdateManifest,    // ({ url, fetchImpl, timeoutMs }) -> { ok: true, manifest } | { ok: false, reason }
} from "./update.mjs";
```

`decideUpdate` always returns the same seven fields, so a caller can render it without branching:
`{ state: "current" | "available" | "unknown", current, latest, url, notes, releasedAt, reason }`.

Semver precedence is the real thing: `1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0`,
`10.0.0 > 9.9.9`, numeric identifiers sort below alphanumeric ones, a longer prerelease with an
equal prefix sorts higher, and `+build.7` never changes an order.

`shouldCheck` returns `true` for a missing, empty or unreadable `lastCheckedAt`, and also for one
in the future (a clock that moved backwards must not suppress updates for as long as the skew
lasts). The interval is a floor, not a schedule: 6 hours at most, plus whatever the person asks
for.

## 4. What the request carries

One header - `Accept: application/json` - and one URL, used byte-for-byte. No account, no install
id, no machine name, no platform, no version, no query string, no cache buster. The module cannot
tell the server who asked because it does not send anything that could answer that.

The check is a `GET` for a static file, so the site cannot even distinguish it from an ordinary
page view beyond the path.

## 5. The limits, and why they are there

| Limit | Value | Why |
|---|---|---|
| request timeout | 5 s | a check that has not answered is a failed check, not a slow one |
| body size | 256 KiB | a feed is a few hundred bytes; a large response is a red flag |
| notes | 2000 chars | notes are shown in the app, not archived in it |
| date | not in the future | a release dated tomorrow cannot be verified, so it is refused |
| URL scheme | `https` only | the string becomes a clickable link in a desktop app |
| URL host | allowlist | the same reason |

The timeout is an `AbortController` *and* a race against a timer, so a fetch implementation that
ignores its signal still cannot hang the check. `fetchUpdateManifest` does not throw for any
failure - network error, abort, non-200, non-JSON, oversized body, failed validation - it returns
`{ ok: false, reason }` with a sentence.

## 6. Publishing an update

The release job writes the feed from the artifacts that actually arrived, right after it writes
`releases.json`:

```bash
node packaging/release/manifest.mjs --updates \
  --dir artifacts \
  --version "$RELEASE_VERSION" \
  --release-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/releases/tag/$RELEASE_TAG" \
  --notes "$RUNNER_TEMP/updates-notes.md" \
  --out artifacts/updates.json
```

It then prints the exact command a human runs to commit `site/public/download/updates.json` in the
run summary, next to the `releases.json` one - the two files have to be committed together, or the
app and the page disagree.

`--updates` mode refuses three things, and each refusal is a non-zero exit:

1. **No measured file in `--dir`.** A feed that names a release page while nothing was measured
   would be the pipeline claiming a release it cannot show.
2. **No release page.** `--release-url`, or a `--base-url` that ends in `/releases/download/<tag>`
   (the page is derived from it). An update the app cannot point at is not an update.
3. **A manifest the app would reject.** The finished object is run through
   `validateUpdateManifest` from `harness/src/update.mjs` before a byte is written, so the
   pipeline cannot publish a feed that installed apps would report as "the check could not be
   completed".

`releasedAt` is the run's clock, `artifacts` is the measured SHA-256 of every `.exe`/`.dmg`/`.zip`
in `--dir`, and `--notes` is optional: empty notes are honest, invented notes are not.

## 7. Verifying it

The committed feed, the validator and the decision, in one command:

```powershell
node --input-type=module -e "import { readFileSync } from 'node:fs'; import { validateUpdateManifest, decideUpdate, readVersionFromPackage } from './harness/src/update.mjs'; const feed = JSON.parse(readFileSync('site/public/download/updates.json','utf8')); const app = readVersionFromPackage(readFileSync('desktop/package.json','utf8')); const checked = validateUpdateManifest(feed); console.log('valid:', checked.ok, checked.ok ? '' : checked.reason); console.log(decideUpdate({ current: app, manifest: feed }));"
```

The tests are `harness/test/update.test.mjs` (33 tests: the semver table in both directions, every
refusal reason, the three states, the interval, and a stubbed fetch for each failure mode including
a request that never resolves) and `site/test/updates.test.mjs` (19 tests: the committed file, the
page's claims, and the fact that the two manifests agree about what exists).

## 8. Wiring it into the window

The engine module is done and tested; the browser window is a separate, small change in
`harness/src/ui.mjs` and `harness/ui/app.js`, which this folder does not own. These are the two
snippets, exactly as they belong.

**Route** - in `harness/src/ui.mjs`, next to the other read-only routes (`/api/health` is the
model: no token needed, because nothing is changed):

```js
// The update check costs one small HTTP request to the site, so it runs at most every six
// hours and remembers the last answer for the life of this server process. `?fresh=1` is the
// "Check for updates" button: it skips the floor, because a person asking is not a timer.
let lastUpdateCheck = { at: null, verdict: null };

if (path === "/api/update") {
  const forced = url.searchParams.get("fresh") === "1";
  const cached = lastUpdateCheck.verdict;
  if (!forced && cached && !shouldCheck({ lastCheckedAt: lastUpdateCheck.at, now: Date.now() })) {
    return json(res, 200, { ...cached, cached: true, checkedAt: lastUpdateCheck.at });
  }
  const current = appVersion();      // readVersionFromPackage(<app package.json>, see below)
  const fetched = await fetchUpdateManifest({});
  const verdict = fetched.ok
    ? decideUpdate({ current, manifest: fetched.manifest })
    : { state: "unknown", current, latest: null, url: "", notes: "", releasedAt: null, reason: fetched.reason };
  lastUpdateCheck = { at: Date.now(), verdict };
  return json(res, 200, { ...verdict, cached: false, checkedAt: lastUpdateCheck.at });
}
```

with the two imports at the top of `ui.mjs` (both come from files that already ship):

```js
import { decideUpdate, fetchUpdateManifest, readVersionFromPackage, shouldCheck } from "./update.mjs";
```

and the version itself, read once from the same `package.json` electron-builder stamps:

```js
// HERE is dirname(fileURLToPath(import.meta.url)) = <app>/harness/src. The staged app's
// package.json is two levels up; in the repo, harness/package.json is one level up.
const appVersion = () =>
  readVersionFromPackage(JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8"))) ??
  readVersionFromPackage(JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8")));
```

**Button** - in `harness/ui/app.js`, using the `api()` and `toast()` helpers that are already
there. It belongs in whatever settings/about panel that file grows:

```js
async function checkForUpdates() {
  setStatus("Checking for updates...");
  try {
    const verdict = await api("/api/update?fresh=1");
    if (verdict.state === "available") {
      // A link, opened by the person. The app never downloads or installs anything.
      toast(`${verdict.latest} is available - open the release page to install it`, "ok");
      window.open(verdict.url, "_blank", "noopener,noreferrer");
    } else if (verdict.state === "current") {
      toast(verdict.reason || `Up to date at ${verdict.current}`, "ok");
    } else {
      toast(`Could not check for updates: ${verdict.reason}`, "bad");
    }
  } catch (error) {
    toast(`Could not check for updates: ${error.message}`, "bad");
  }
}

document.getElementById("check-updates")?.addEventListener("click", checkForUpdates);
```

```html
<button class="btn" id="check-updates" type="button">Check for updates</button>
```

Three notes for whoever lands it: the route is read-only, so it must not require the token; the
verdict is cached for six hours *in the server process*, which is enough because the floor is a
ceiling on how often the site is asked, not a record of what the person saw; and the button must
never turn the link into a download - `verdict.url` is a page.

## 9. What is not real yet

- **The route is wired as of this pass.** `GET /api/update` lives in `harness/src/ui.mjs`, next to
  `/api/health`, outside the token check. It reads the running version from `desktop/package.json`
  (falling back to `harness/package.json`), fetches the feed, caches the answer in-process, and
  reports `cached: true` on a repeat call inside the six-hour floor. `?fresh=1` skips the floor.
  Measured against the real site before deploy: `{"state":"unknown","current":"0.1.0",
  "reason":"the update feed answered HTTP 404"}` - the honest answer, because the feed is not
  published yet. Measured against a locally served copy of `site/public`:
  `{"state":"current","current":"0.1.0","latest":"0.1.0","reason":"you are up to date at 0.1.0"}`,
  and the second call reported `cached: true`. `ROSALENA_UPDATE_FEED` overrides only *where the
  feed is read from*, which is how that second measurement was made; the comparison logic is the
  same code either way.
- The "Check for updates" button in the window is `#check-updates` in the More drawer, and it
  simply calls `/api/update?fresh=1` and speaks the verdict.
- Nothing is persisted between launches: `lastCheckedAt` lives in the server process, so a restart
  can check once more. Wiring it to a file under `~/.rosalena` would make the floor survive a
  restart; it is not necessary for honesty, only for politeness to the site.
- No release exists, so no installed app can ever have seen `available`. The code path is covered
  by tests only, and this document says so rather than showing a screenshot of a state that has
  never happened.

## 10. Update and restart (desktop/updater.mjs)

| Install | File it downloads | How it installs |
|---|---|---|
| Windows, Setup installer | `Rosalena-Harness-Setup-<v>-x64.exe` | runs it with `--updated /S --force-run` (silent, same folder, reopens the app) and quits |
| Windows, portable | `Rosalena-Harness-<v>-x64-portable.exe` | a cmd script waits for the old exe to be released, moves the new one over it, starts it |
| macOS | `Rosalena-Harness-<v>-<arm64 or x64>.zip` | unpacks with `ditto`; a sh script waits for the app to exit, swaps the `.app`, clears quarantine, opens it |

- `pickUpdateAsset` in `harness/src/update.mjs` names the file and turns the release page
  (`.../releases/tag/<tag>`) into its download address (`.../releases/download/<tag>/<file>`).
  A feed with no SHA-256 for this platform's file is not installable; the app offers the release
  page instead.
- A file the app downloads itself carries no Mark of the Web (Windows) and no quarantine flag
  (macOS), so SmartScreen and Gatekeeper do not stop the update. That is why the checksum check
  is not optional.
- Background checks run ~15 s after launch, then every 6 hours. The last check time and any
  skipped version live in `<userData>/update-state.json`. `ROSALENA_NO_UPDATE_CHECK=1` turns them
  off. Help > Check for updates (the app menu on macOS) and the More drawer button always ask.
- A checkout (`npm start`) never replaces itself; it offers the release page.
- Testing: `ROSALENA_UPDATE_FEED` reads the feed from another URL, and `ROSALENA_UPDATE_FILES`
  reads the file from another folder URL. The SHA-256 is enforced either way.
- 0.1.0 shipped before the updater, so 0.1.0 users install the next version by hand once.
- The macOS path has not run on a Mac yet. It fails cleanly (and offers the release page) when
  the app runs from a translocated location or the Applications folder is not writable.