# rosa-wifi-switcher

A Rosalena plugin that lists the Wi-Fi networks this machine can see and joins one
of them — including a network it has never joined before, which needs its password
typed once.

The plugin runs on Windows and only talks to `netsh wlan`. There is no dependency,
no background service and no stored key of its own: the Windows profile is where a
Wi-Fi password goes, because that is where Windows keeps it.

## What you get

| Surface | What it does |
| --- | --- |
| `ui/network.html` | Reads the adapter every five seconds, lists what is visible, joins a saved network in one click, and asks for a password inline for a new one |
| `GET /api/wifi` | The same reading as JSON, for the page |
| `POST /api/wifi/connect` | Joins a network; the page sends `{ ssid, password }` |
| `/wifi-switcher:status` | A text report of the adapter, its saved profiles and what is visible |
| `/wifi-switcher:scan` | The visible networks, one per line |
| `/wifi-switcher:join <ssid>` | Reconnects a **saved** profile. Refuses a password on the command line |
| tool `wifi_status` | The report, for the model |
| tool `wifi_networks` | The visible networks, for the model |

Both tools are deliberately read-only. A model that switched this machine's Wi-Fi
in the middle of a run would drop its own connection and, on a bad day, the run;
and a password is a thing only a person should type. The model can read the state
and then say what it sees.

## The commands it runs

Every call is `netsh` with an argument array and `shell: false`, so an SSID can
never be reinterpreted by a shell as a flag or a second command.

| Purpose | Command (arguments, verbatim) |
| --- | --- |
| The adapter, its state and the network it is on | `wlan show interfaces` |
| What the WLAN service last scanned | `wlan show networks mode=bssid` |
| The profiles Windows already holds | `wlan show profiles` |
| The cost setting of the current network | `wlan show profile name=<ssid>` (only while connected) |
| Join a saved profile | `wlan connect name=<ssid> ssid=<ssid>` |
| Join a new network | `wlan add profile filename=<temp.xml> user=current`, then `wlan connect name=<ssid> ssid=<ssid>` |

## Why a new network needs a profile file

`netsh wlan connect` can only connect to a profile that already exists. Windows
gives a program two ways to create one for a network it has never joined:

- `netsh wlan set profileparameter` — edits a profile that already exists, so it
  cannot create the first one.
- `netsh wlan add profile filename=<file>` — imports a profile from an XML file.

So for a network this machine has never joined, the plugin writes the small XML
profile Windows expects into `%TEMP%`, imports it, connects, and deletes the file
in a `finally` block — on success, on refusal and on a throw alike. The file is
created with mode `0600` and its name is a random UUID, so two joins cannot collide.
The password exists in three places for a moment: the form field, the POST body,
and that file. It is never logged, never echoed, never in an error message, never in
the returned object (those go through a redaction pass that replaces the exact
password with `***`), and never in the command line — the command line only ever
carries the file's path.

A saved profile needs none of this: Windows already has the key, so the plugin
just runs `wlan connect`.

## What "connected" means here

`netsh wlan connect` exiting 0 does not mean the machine joined the network. It
means the request was queued. The plugin therefore polls `wlan show interfaces`
up to three times, 1.5 seconds apart, and reports `ok: true` only when the adapter
says `State : connected` **and** the SSID it reports is the one that was asked for.
Otherwise it says which network the adapter actually reports — the honest answer
when a driver silently ignores a request, which is exactly the case an exit code
cannot see.

## What the page shows with no adapter

Nothing pretends to work. A machine without a wireless card, or a Windows whose
WLAN service is off, gets a panel that says so in one sentence, the note the probe
produced, and the raw error line if netsh failed. The network table is not drawn at
all. The footer keeps the two working links, so the page reads as a deliberate
"this machine has no Wi-Fi" rather than a broken page.

The page's states, in order:

- **Windows only** — the platform is not Windows. No command was run.
- **No adapter** — `wlan show interfaces` found no wireless interface.
- **Radio off** / **service stopped** — the interface exists but cannot scan. The
  note says which, because "no networks" and "the radio is off" look identical in
  an empty list otherwise.
- **Not connected** — an adapter, a radio on, no association.
- **Connected to `<ssid>`** — with the security, signal, band and channel, and a
  `metered` fact when Windows reports the link as metered.

## Metered connections

The plugin reports what Windows reports (`Cost : Unrestricted | Fixed | Unknown`)
and will not refuse to move you to another network because the link you are on is
metered — moving is often the fix. It refuses one narrow case: a request to
reconnect to the network you are *already* on, when the cost is `fixed` or
`unknown`, because that request can only make things worse and gains nothing.

## Honest limits

- **Windows only.** The plugin is `netsh` and nothing else. On macOS or Linux
  `probeWifi` reports `supported: false` and names the platform; nothing is run.
- **WPA3-Enterprise, WPA2-Enterprise and WPA-Enterprise cannot be joined from a
  password.** They need a username, a domain and often a certificate, and the
  profile XML has to say which. The plugin refuses them by name instead of writing
  a profile that would fail halfway.
- **WEP is refused.** It is a broken cipher and a password typed into a modern UI
  is not the key WEP wants.
- **A captive portal still needs a browser.** Joining an open network gets you on
  the link; the "sign in to continue" page behind it is not something this can do.
- **Only what Windows scanned.** `wlan show networks` lists the WLAN service's last
  scan. A network that is not in the list cannot be joined by SSID; the plugin says
  so rather than writing a profile for a network that is not there.
- **One SSID is not one network.** The same name can exist on several BSSIDs at
  different bands. The page shows the strongest one and how many the scan saw.
- **English Windows only.** The parsers read the English field names netsh prints.
  A non-English Windows is reported as unreadable, not as "no adapter".
- **6 GHz** is reported as an unknown band: netsh prints a channel, not a band, and
  guessing from the channel number would be a lie.
- **The password field masks by default** and shows on request, because a password
  you cannot see is a password you cannot check.

## Verified, and not verified

Verified against this machine's real adapter (Intel Wi-Fi 6E AX210):

- `wlan show interfaces` for a connected adapter — name, description, state, SSID,
  BSSID, signal, authentication, cipher, channel, receive and transmit rates;
- `wlan show networks mode=bssid` with a real multi-BSSID scan;
- `wlan show profiles` with the group-policy rows and the `<None>` rows;
- `wlan show profile name=<ssid>` including the `Cost settings` block;
- a real `wlan connect` to a saved profile: the plugin issued the command, polled
  the interface twice, and reported `ok: true` only after the driver reported the
  requested SSID.

Not verified against a real adapter, and therefore only tested against recorded
transcripts: a disconnected adapter, a radio switched off, a machine with no
wireless card, duplicate BSSIDs, a hidden SSID, and every path that writes and
imports a profile for a **new** network. No password was ever used on real `netsh`
by the author of this plugin. The test file pins the exact `netsh` command lines
for both connect paths, so the shape of those calls is checked even though the
network never changed.

## Configuration

`plugin.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `8000` | Per `netsh` call. A hung WLAN service becomes a reported failure, not a hung page |
| `verifyAttempts` | `3` | How many `show interfaces` samples after a connect |
| `verifyIntervalMs` | `1500` | The gap between them (~4.5 s worst case) |

## Files

- `plugin.json` — the manifest the harness reads.
- `plugin.mjs` — the plugin, the parsers, `probeWifi`, `connectWifi`, and the report
  formatters. `parseInterfaces`, `parseNetworks`, `parseProfiles`, `profileXml`,
  `bandOf`, `securityOf`, `parseCost` and `redact` are exported pure functions, so
  every Windows transcript can be pinned in a test without a wireless card.
- `test/plugins-wifi-switcher.test.mjs` — offline tests for all of it.

Run the tests from `harness/`:

```
node --test test\plugins-wifi-switcher.test.mjs
```

They never run `netsh`: the runner is a stub that answers from recorded transcript
text and records the command lines it was given.

## Wiring this into the UI server

The plugin and the page are self-contained; the routes that serve them live in
`src/ui.mjs`, which is owned by the harness UI work. Three additions are needed
there:

1. `GET /api/wifi` — import `probeWifi` from `../plugins/rosa-wifi-switcher/plugin.mjs`
   and answer with `json(res, 200, await probeWifi())`. Read-only, so it sits with
   `/api/local-model` and needs no token, like the existing read routes.
2. `POST /api/wifi/connect` — read `await readBody(req)`, pass `{ ssid, password }`
   to `connectWifi`, and answer with its result (HTTP 200; `ok: false` is the
   plugin's answer, not a transport error). This one is behind the token check:
   `x-rosalena-token` must equal the UI token, which the page already sends.
   Note that `connectWifi` can take up to ~5 seconds while it verifies, so the
   route should not have a shorter client timeout than that.
3. `GET /network` — serve `ui/network.html` with `__ROSALENA_TOKEN__` replaced, the
   same substitution `/` uses for `index.html`. Without the substitution the page
   loads and reads fine, but its POST is refused with a plain sentence.

A sidebar or footer link in `ui/index.html` (`&#9673; Wi-Fi networks` → `/network`)
is the only other change the page needs.
