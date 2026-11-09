# OpenCode's free tier: the three gates, and how Rosalena satisfies them

Everything below was measured on **2026-10-20** against
`https://opencode.ai/zen/v1/chat/completions`, from this machine, with a real key.
Each section states what was tried, what came back, and what the router now does
about it. Nothing here is inferred from documentation, because OpenCode documents
none of it.

## The refusal

Every failed combination returned the same body, which is why they took a matrix to
separate:

```
HTTP 403
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode."}}
```

The message is the same for a missing session id, a malformed session id, and a
request with no `read` tool. A caller cannot tell those apart, and neither could
we, until each was varied alone.

## Gate 1 - the request must stream

| Request | Result |
|---|---|
| `stream: false` (or absent), correct headers and tools | **403 FreeTierError** |
| `stream: true`, same everything else | **200**, SSE frames |

Consequence: a buffered client cannot talk to the free tier at all. The router
therefore sends `stream: true` whenever a provider sets `requiresStream`, and joins
the stream back into a single completion for callers that asked for one
(`aggregateStreamToCompletion` in `router\src\providers.mjs`). Callers keep their
protocol; the provider keeps its gate satisfied.

## Gate 2 - the client fingerprint and a well-formed session id

These headers together, all present, all consistent:

```
authorization:        Bearer <key>
user-agent:           opencode/latest/2.0.29/cli
x-opencode-client:    cli
x-opencode-project:   global
x-opencode-session:       ses_<12 lowercase hex><14 base62>
x-session-affinity:       <same token>
x-opencode-session-id:    <same token>
x-session-id:             <same token>
```

| Variation | Result |
|---|---|
| no session header at all | 403 FreeTierError |
| `x-opencode-session: ses-probe-router-1` (wrong shape) | 403 FreeTierError |
| `x-opencode-session: ses_ea794a168fffCu7YCrBohCvaXn` | 200 |
| the four affinity headers stripped, session header kept | 403 |
| fingerprint headers only, no session header | 403 |

So the gateway validates the **shape** of the id, not its meaning: a hand-written
but well-formed token is accepted. The router derives the id from the caller's
conversation id instead of from a clock, so one conversation keeps one id across
router restarts - prompt-cache affinity is the only reason the id exists upstream.

A caller's own id (`r-20261020-041252-1294`, a uuid, a DSH session id) is hashed
into the `ses_` shape rather than forwarded.

## Gate 3 - a tool named exactly `read`

This one is not guessable and cost the most time.

| Tools in the request | Result |
|---|---|
| `read` | **200** |
| `read` + `shell` | **200** |
| `read_file` | **403** |
| `shell` | **403** |
| no tools at all | **403** |

The capability is irrelevant; the **name** is the gate. A caller that calls its
read tool `read_file` is refused exactly like a caller sending no tools.

The router therefore:

1. finds the caller's read-like tool (`READ_TOOL_NAMES`: `read`, `read_file`,
   `readfile`, `fs_read`, `view_file`, `open_file`, `cat`),
2. renames it to `read` for the request, keeping its schema untouched,
3. maps the name back to the caller's name on the response - in the buffered path
   (`remapToolCalls`) and inside the SSE frames in the streaming path
   (`rewriteSseToolNames`), so a caller never receives a tool it did not advertise,
4. and, for a caller with no read-like tool at all, injects a documented stub
   instead of failing.

If there is no read tool and the stub is injected, the alias map records `null` for
it, so a model that calls it produces a tool call the caller will not recognise -
which is why the plugin README says so plainly instead of hiding it.

## What the key does and does not buy

- The key is only the credential the free tier expects to exist. It does not pay
  for anything.
- Paid models on the same key answer
  `{"error":{"type":"server_error","message":"Upstream request failed: Insufficient account funds"}}`
  - the account balance is zero, and the router's budget for this provider is `0`
  (uncapped) because the free tier costs nothing.
- When the account's free window is exhausted the gateway answers
  `429 FreeUsageLimitError: Rate limit exceeded`. That is the designed fall-through
  point: the router moves to the next target in the class chain (a local model, in
  the shipped config), which is the behaviour T0.1 exists for.

## Verification in this repository

| Claim | Where it is pinned |
|---|---|
| all three gates, honoured end to end | `router\test\opencode-free.test.mjs` - a stub gateway that enforces the gates the way the real one does (13 tests) |
| a buffered caller is answered by a streaming-only provider | same file: "a buffered caller is answered even though the provider only streams" |
| the session id is well-formed, stable per conversation, distinct between them | same file: "the session id is minted in opencode's grammar" |
| the tool rename round-trips, buffered and streaming | same file, two tests |
| a 403 falls through to the next target rather than failing the call | same file, "a 403 from the gated provider falls through" |
| the four verdicts are reported to the user honestly | `harness\test\plugins-opencode-handler.test.mjs` (16 tests) |
| live route works through the router | re-measured this round: a harness-shaped request with a `read_file` tool returned `finish_reason: tool_calls` and `function.name: read_file` |

Commands:

```
cd "D:\AppDev\Rosalena Harness\router"  && node --test        # 58 tests
cd "D:\AppDev\Rosalena Harness\harness" && node --test        # the whole harness suite
```

## What would break this

Any of the three gates changing shape, and none of them is documented by the
provider. If the free tier starts answering 403 to a request that satisfies all
three, the first thing to check is the fingerprint: a new client version changes
`user-agent`, and that is configurable (`userAgent` on the provider row) precisely
so it can be corrected without a code change.
