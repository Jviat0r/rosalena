# rosa-vpn-exit-rotator

Two VPN clients, one at a time. Turns the **Outline** or **ExpressVPN** desktop client
on or off from the harness, starts it so the harness is not its parent, and stops only
that exact image.

The reason it exists: a machine with both clients installed, where turning one on
while the other is up leaves two clients fighting over the default route. That is not
a faster VPN, it is a broken network. So the rule here is exclusivity, and every
claim it makes is checked against the process table.

    /vpn-exit-rotator status          both clients: installed? running? which is up?
    /vpn-exit-rotator outline on      stop ExpressVPN first, then start Outline
    /vpn-exit-rotator outline off     stop every Outline.exe process, one pid at a time
    /vpn-exit-rotator express on      stop Outline first, then start ExpressVPN
    /vpn-exit-rotator express off     stop every ExpressVPN.exe process
    /vpn-exit-rotator rotate          switch to the other exit, stating the plan first
    /vpn-exit-rotator doctor          every path checked, every pid, what cannot be known

Two tools are exported for an agent:

    vpn_exit_status                  {}                        read-only
    vpn_exit_toggle                  { provider, on }          changes the machine

## What "installed" means

A file check. The plugin looks for the executable at the documented locations, in
order, and stops at the first one that exists:

| provider   | paths checked, first hit wins |
| ---------- | ----------------------------- |
| Outline    | `C:\Program Files (x86)\Outline\Outline.exe`, `C:\Program Files\Outline\Outline.exe`, `%LOCALAPPDATA%\Programs\Outline\Outline.exe` |
| ExpressVPN | `C:\Program Files (x86)\ExpressVPN\expressvpn-ui\ExpressVPN.exe`, `C:\Program Files\ExpressVPN\expressvpn-ui\ExpressVPN.exe` |

"Not installed" always prints **every** path that was looked in, because "not found"
without "where I looked" is a shrug rather than an answer. A path can be added in
front of the list with config:

```json
{ "plugins": { "rosa-vpn-exit-rotator": { "config": { "installs": { "outline": "D:\\VPN\\Outline.exe" } } } } }
```

On this machine, at the time of writing (read from the filesystem, never executed):

    C:\Program Files (x86)\Outline\Outline.exe                        130,537,616 bytes
    C:\Program Files (x86)\ExpressVPN\expressvpn-ui\ExpressVPN.exe        855,400 bytes

## What "running" means

`tasklist` and nothing else:

    tasklist /FI "IMAGENAME eq Outline.exe" /FO CSV /NH

The filter is an exact image name, and the CSV is parsed field by field, so
`ExpressVPNNotificationService.exe` is never mistaken for `ExpressVPN.exe` and a
"65,988 K" memory figure does not split a row.

Three outcomes, kept apart on purpose:

* **running** - one or more rows, and every pid is reported;
* **not running** - exit code 0 and `INFO: No tasks are running which match the
  specified criteria.` (that sentence *is* the answer, not an error);
* **unknown** - tasklist failed, timed out, or the platform is not Windows.

Unknown is never shown as off. A status page that says "off" when it could not look
is worse than one that says "I could not look".

Outline is an Electron application, so `Outline.exe` is routinely **five** processes
(browser, renderers, GPU). They all carry that one image name, which is why `off`
stops every process whose image name is exactly `Outline.exe` - one `taskkill /PID`
each - and why it never uses `/IM`.

## What `on` and `off` do

`on`:

1. the client must be installed, or nothing happens at all (no stop is issued for a
   client that then cannot be started - that would be the zero-exit state);
2. the other client's state must be readable, and if it is running it is stopped
   first, one pid at a time;
3. the exact executable path is spawned **detached** (`detached: true`,
   `stdio: "ignore"`, `unref()`), so the harness is not its parent and closing the
   harness does not close the VPN;
4. the image is then polled in `tasklist` (4 tries, 700 ms apart), and the answer is
   "on" only if the process is really there.

`off`:

1. a fresh `tasklist` read gives the pids;
2. `taskkill /PID <pid> /F` for each one - no `/IM`, no `/T`, no wildcard, nothing
   that could reach a different program or another user's process;
3. the image is polled until it is gone (3 tries, 300 ms apart);
4. the answer is "off" only when `tasklist` agrees.

Both are idempotent: `outline on` while Outline is already the only exit is a no-op
that starts nothing, and `outline off` while it is already off runs no command at
all.

`rotate` keeps exactly one exit up and makes it the other one. It states the plan
before acting (`Rotating from Outline to ExpressVPN: Outline is stopped first, then
ExpressVPN is started.`). With nothing running it starts `config.rotateDefault`
(`outline`) and says that this is what it is doing. With **both** running it refuses
and names the two commands that would resolve it, because "the other one" has no
meaning when two are up.

Refusals, all with a sentence rather than an exception:

| situation | answer |
| --------- | ------ |
| executable missing | `not-installed` - lists every path checked, stops nothing |
| tasklist unreadable | `unknown` - says which client, and that unknown is not off |
| taskkill denied | `permission` - quotes "Access is denied", claims no stop |
| spawn refused | `permission` - quotes the spawn error |
| both clients running, `rotate` | `conflict` - names the two explicit commands |
| started but not in the table afterwards | `not-verified` - reports exactly that |
| the other client could not be stopped | stops there; this one is not started |

## What it will not do

* **It is not a tunnel.** A client is not a tunnel. Outline keeps
  `OutlineService.exe` running and ExpressVPN keeps `ExpressVPN.VpnService.exe` and
  friends; those hold the connection after the window closes, need elevation to
  touch, and are a machine-wide change nobody asked this plugin for. `off` closes
  the client and the message says the service may still be holding the tunnel.
* **No credentials, ever.** No access key, no password, no server address, no
  profile. Outline is a client for a server the person configured themselves; this
  plugin does not configure it, sign in to it, or choose a location for either
  vendor. `on` gets you a client window, and the client decides the rest.
* **It does not drive `ExpressVPN.CLI.exe`.** That is the honest way to change the
  tunnel state without a window, and it is a different job: it needs a subscription
  session and it changes the tunnel rather than the client. Out of scope here, said
  out loud in `doctor`.
* **It cannot test permission without acting.** Whether the harness may stop a
  process owned by another account is only knowable from taskkill's answer, so that
  refusal is reported when it happens instead of being predicted.
* **It is Windows only.** `tasklist`, `taskkill` and a detached Windows spawn have no
  equivalent in this shape on another platform, so elsewhere it reports
  `supported: false` and checks nothing.

## The OS calls it makes, in full

    tasklist /FI "IMAGENAME eq Outline.exe" /FO CSV /NH       is it running, which pids
    tasklist /FI "IMAGENAME eq ExpressVPN.exe" /FO CSV /NH
    tasklist /FO CSV /NH                                      doctor only, one full list
    <exe path>                                               detached spawn, no arguments
    taskkill /PID <pid> /F                                   one process, by pid

No service is started, stopped or queried. No registry key is read or written. No
shell is involved: every call is `spawn(command, args, { shell: false })`, so an
install path can never be reinterpreted as a command.

`GET /api/exits` uses the two filtered calls, in parallel: about **190 ms** on this
machine, against about **370 ms** for the single full list of roughly 475 processes.
It starts and stops nothing - the only calls a probe makes are file checks and
process listings - which is what makes it safe to call every time a sidebar renders.

## The two seams

Everything that touches the machine goes through one injected runner, and everything
that reads the filesystem through one injected stat, so the whole plugin can be
tested without a VPN installed and without starting anything:

```js
probeExits({ run, stat, platform, env, config })
toggleExit({ provider, on, run, stat, platform, env, config })
```

`run(command, args, { timeoutMs, detached })` resolves (never rejects) to
`{ code, pid, stdout, stderr }`. `stat(path)` returns
`{ exists, size, mtime, directory }` and never throws. `defaultRun` and `defaultStat`
are the real ones, and both are exported so a caller can wrap them.

The pure parts are exported too, and are what the tests pin down: `parseTaskList`,
`parseStartResult`, `parseStopResult`, `parseExitState` (via `probeExits`),
`planFor` (the decision, with no side effects), `formatExitReport`, `formatDoctor`.

## Config

| key | default | meaning |
| --- | ------- | ------- |
| `timeoutMs` | `8000` | per command; a start that has not spawned in this long is a failure |
| `startAttempts` | `4` | tasklist samples after a start |
| `startIntervalMs` | `700` | between those samples |
| `stopAttempts` | `3` | tasklist samples after a stop |
| `stopIntervalMs` | `300` | between those samples |
| `rotateDefault` | `outline` | which exit `rotate` starts when none is running |
| `allowToggle` | `true` | `false` makes `vpn_exit_toggle` read-only |
| `reportAtRunStart` | `true` | one note at the start of a run when an exit is up |
| `serviceCaveat` | `true` | append the "the service may still hold the tunnel" sentence on `off` |
| `installs` | `{}` | extra executable paths, tried before the defaults |

## The run-start hook

When a run starts, and only if a client is actually running, the plugin adds one
note naming the exit and its pids - traffic leaving through a different country
changes what a model should expect from a geo-restricted site, and a note is cheaper
than finding out from a timeout. It fires once per run, says nothing when no exit is
up (`depth > 0` workers are left alone), never acts, and a failed probe is silence
rather than a failed run.

## Testing it yourself

    cd harness
    node --test test\plugins-vpn-exit-rotator.test.mjs

Every case runs against a stub process table: five Outline pids, a missing install,
a throwing runner, "Access is denied", a client that exits at once, a client that
takes two samples to appear. Nothing in the suite starts, stops or lists a real
process on the machine running it, and no test needs either VPN installed.

The interesting cases, in the order the file covers them: the manifest, both
`tasklist` transcripts, installed-and-running, installed-and-stopped,
not-installed, unreadable (unknown, not off), start-when-stopped, start-when-running
(no second start), stop-only-that-image, stop-when-already-off, rotation order
(stop before start), rotate-from, rotate-with-nothing-running, rotate-conflict,
refusal-when-missing, refusal-when-unknown, off-still-allowed, denied taskkill,
"cannot stop the other so do not start this one", refused spawn, start-unverified,
two-sample verification, malformed request, non-Windows, and the report/doctor/hook
shapes.

## Where the UI lives

`harness\ui\exits.html`, served at `/exits`, plus `GET /api/exits` (cheap, read-only)
and `POST /api/exits/toggle` (token-gated, like `/api/wifi/connect`). The page shows
one card per client with the exact path checked, the state as `running`, `not
running` or `unknown`, a switch, and a "Rotate to the other exit" button. It never
claims a success it did not verify - the state it draws after a toggle is the state
the plugin reported, not the state that was requested.
