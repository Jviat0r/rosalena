# T0.1 â€” Model Router v0

An OpenAI-compatible endpoint that routes by **task class**, not by model name.

You send `{"model": "code"}`. The router picks a model, and when that model's
provider is rate-limited, out of budget, or has no key left, it moves to the next
one in the chain without telling you. Your client only ever needs to know about
`orchestrate`, `code`, `fast` and `judge`.

Zero dependencies: `node:http`, built-in `fetch`, and `node:test`. No Docker, no
build step, no install step.

```
Rosalena Harness/router/
  router.config.json     providers, classes, budgets  <- the only file you edit normally
  src/limits.mjs         budget ledger + API key pool with cooldowns
  src/usage.mjs          token usage store + the /admin/usage rollup
  src/providers.mjs      OpenAI + Anthropic wire adapters, failure classification
  src/router.mjs         chain resolution and the fallback loop
  src/server.mjs         the OpenAI-compatible HTTP surface
  src/log.mjs            JSONL attempt log + in-memory ring
  src/index.mjs          entrypoint
  test/router.test.mjs   31 tests, all stubbed, no network
  test/usage.test.mjs    23 tests: the usage store, its rollup and the API
  scripts/loadtest.mjs   the T0.1 acceptance test
```

## Run it

```powershell
cd "D:\AppDev\Rosalena Harness\router"
node src/index.mjs                      # listens on 127.0.0.1:8077
node --test                             # 105 tests
node scripts/loadtest.mjs               # the 500-request acceptance test
```

Then point anything OpenAI-shaped at it:

```powershell
$body = '{"model":"code","messages":[{"role":"user","content":"hi"}]}'
Invoke-RestMethod -Uri http://127.0.0.1:8077/v1/chat/completions -Method Post -Body $body -ContentType application/json
```

In a client: base URL `http://127.0.0.1:8077/v1`, API key = any non-empty string
(it is ignored locally), model = a class name.

## The classes

| Class | For | Chain (preference order) |
|---|---|---|
| `orchestrate` | planning, long-horizon judgment | local â†’ anthropic â†’ openrouter |
| `code` | the class the acceptance test hammers | local â†’ anthropic â†’ openai â†’ openrouter |
| `fast` | classification, extraction, summaries | local â†’ google â†’ openai |
| `judge` | acceptance and quality verdicts | anthropic â†’ local |

`judge` is cloud-first on purpose: a judge sharing the author's blind spots is
worse than no judge.

## Configuration

Everything is data in `router.config.json`. Model ids are provider-specific â€”
**verify them against the live catalogue**; a wrong id is not fatal, it just fails
over, which is the router's job. Target syntax is `provider/model`, split on the
**first** slash only, so `openrouter/anthropic/claude-sonnet-4.5` addresses
provider `openrouter` and model `anthropic/claude-sonnet-4.5`.

```jsonc
"providers": {
  "local": { "kind": "openai", "baseUrl": "http://127.0.0.1:8080/v1",
             "apiKeyEnv": null, "prices": { "in": 0, "out": 0 } }
},
"budgets": { "monthlyUsd": { "anthropic": 40, "cloud": 0 } },
"classes": { "code": { "chain": ["local/qwen3.8-27b", "anthropic/claude-sonnet-4-5"] } }
```

- `kind` is `openai` or `anthropic`. That is the whole list, on purpose: llama.cpp,
  vLLM, OpenAI, Google's OpenAI-compatible endpoint and OpenRouter all speak the
  first shape.
- `prices` is USD per **million** tokens, used to price each call into the ledger.
- A budget of `0` or `null` means **uncapped** â€” that is what `local` wants, since
  it is free and must never be skipped for budget reasons.
- `apiKeyEnv: null` means the provider needs no key (local).

### Where it writes

`logDir`, `stateFile`, `usageFile` and `keyFile` are resolved **relative to the config
file's directory**, so running from a checkout writes into that checkout. One environment
variable overrides all four at once, for callers that start the router out of a read-only
install:

```
ROSALENA_ROUTER_STATE_DIR=/some/writable/dir
```

```
<dir>/logs/router-YYYY-MM-DD.jsonl   request log (one file per day)
<dir>/state/ledger.json              monthly spend ledger
<dir>/state/usage.jsonl              per-call token usage
<dir>/data/keys.json                 provider keys saved by the harness
```

Read paths are deliberately untouched: the config file itself and `systemPromptFile` still
resolve where they were installed. The desktop app sets this variable to `<userData>/router`
(`desktop/router-supervisor.mjs`) because a macOS `.app` bundle is read-only for a
quarantined or translocated app, and because a user's ledger does not belong inside an
application bundle. `packaging/release/check-router-spawn.mjs` asserts it by reading the
paths the running router prints at start-up.

### Keys

Three environment shapes are read per provider:

```
ANTHROPIC_API_KEY              one key
ANTHROPIC_API_KEYS             comma- or space-separated list
ANTHROPIC_API_KEY_2 â€¦ _9       additional keys
```

Same for `OPENAI_`, `GOOGLE_` and `OPENROUTER_`. A key that returns 429 or 401 is
put on cooldown (honouring `Retry-After`) and the router tries the next key on
**the same provider** before it fails over. If every key is cooling, the provider
is unusable and the chain moves on. Keys are never logged in full â€” the log only
carries the last four characters.

### Who may call it: the token gate

By default the router is **open on loopback** — any process on this machine can spend
the configured budget and drive the GPU. That is the right default for a single-user dev
box (the harness, the UI and a curl all work with no setup), and the wrong default the
moment anything else can reach the port: another application, a script you did not write,
or a web page in your browser aiming at `127.0.0.1:8077`.

Set a shared secret and every money-touching route requires it:

```powershell
# router side: the config already says auth.tokenEnv = ROSALENA_ROUTER_TOKEN
$env:ROSALENA_ROUTER_TOKEN = "a-long-random-string-at-least-16-chars"
node src/index.mjs
```

Clients then send `Authorization: Bearer <token>` (or `x-router-token: <token>`, or
`x-rosalena-token: <token>` - the name the harness UI already uses). The
harness does this automatically: set the same variable for its process and `--check`,
every model call and the UI's health probe present it. Mismatch messages say so:

```
  spend     unavailable (401 - the router has a token; export ROSALENA_ROUTER_TOKEN)
```

Gated routes are `/v1/*`, `/admin/status` and `/admin/usage`. `/health` stays open on purpose — a probe
has to be able to ask "is it up" without holding the secret, and it reveals nothing but
the class names. When a token is configured it is required **from loopback callers too**;
exempting them would make the gate decorative. The startup line and `/admin/status` warn
when the variable named by `auth.tokenEnv` is unset, so an unprotected router says so
instead of looking protected. Comparison is constant-time, and the token is never logged.

### The circuit breaker
The key pool protects the **key**. It does nothing for the **provider**, and that
asymmetry is not academic â€” it was measured: the T0.1 acceptance run sent the
rate-limited provider all 500 calls, so every caller paid a doomed round trip
before failing over.

`breaker` in `router.config.json` closes that half:

```json
"breaker": { "enabled": true, "threshold": 3, "defaultCooldownMs": 30000, "maxCooldownMs": 900000 }
```

It counts only failures the router could not escape by trying another key â€”
provider-suspect ones (5xx, timeout, network, 402) or a key failure with no other
key left. A rate limit that a second key absorbs is **not** a provider failure and
never trips it; that distinction is the whole design, and there is a test for it.
After `threshold` such failures the provider is skipped without a network call
(logged as `circuit_open`), then **one** probe call decides whether it comes back.
Each successive failed probe doubles the cooldown, capped at `maxCooldownMs`.

Two details that are easy to get wrong and were:

- **Concurrency does not escalate.** 25 requests failing simultaneously are one
  outage, not 25. Without that rule the honest 30-second first trip became the
  15-minute cap, because every in-flight failure re-tripped and doubled it.
- **It is in-memory on purpose.** A provider that is down for this process is not
  necessarily down for the next one, and a persisted "open" flag would blacklist a
  provider that has since recovered.

## Failure handling

The distinction the whole design turns on:

| Upstream | Meaning | Action |
|---|---|---|
| 429 | this key is throttled | cool this key, try the next key, then next target |
| 401 / 403 | this key is bad | same |
| 402 | account out of funds | skip the whole provider |
| 404 / "model not found" | wrong model id | next target |
| 408 / 409 / 5xx / network | provider unhealthy | next target |
| 400 / 422 | **the request is malformed** | stop, return the 400, spend nothing |

That last row is a deliberate choice: a malformed request fails identically
everywhere, so walking the chain would only add latency and bill for it.

### A client that walks away

The client can disappear mid-stream, and the harness's step watchdog does exactly
that on purpose: it aborts a call that overran its timeout. Three rules keep that
from taking the router down with it, all three learned the hard way (the router
exited 1 on 2026-10-19 when the harness aborted a slow streamed step):

1. **Headers are written once.** Once a streamed 200 is on the wire there is no
   HTTP error left to send, so `sendJson` refuses to `writeHead` after
   `headersSent` â€” it closes the response instead. Trying anyway threw
   `ERR_HTTP_HEADERS_SENT` *from inside the error handler*.
2. **A mid-stream failure is reported as `stream_failed`**, not as a JSON error:
   the status line is already sent, and the usual cause is the caller leaving.
   `request_failed` is reserved for failures that happened before any body byte.
3. **Every async handler is `await`ed.** The last-resort `catch` in
   `createRouterServer` only sees a rejection that was awaited; `return
   handleChat(...)` without `await` turned the throw into an unhandled rejection
   and bypassed the very guard written to keep the process alive.

A disconnect also aborts the upstream call (`res`'s `close`, not `req`'s), so no
provider keeps generating tokens for a client that has gone.

## Observability

`GET /health`, `GET /v1/models`, `GET /admin/status` (budgets, spend, key pool
state, and the last 40 events), `GET /admin/usage` (token counts per model - see
[Token usage](#token-usage)). Every attempt is also appended to
`logs/router-YYYY-MM-DD.jsonl`. The events that matter:

```json
{"event":"attempt","cls":"code","target":"local/qwen3.8-27b","ok":false,"reason":"rate_limit","key":"â€¦abcd"}
{"event":"attempt","cls":"code","target":"local/qwen3.8-27b","ok":false,"reason":"circuit_open","skipped":true,"retryInMs":29868}
{"event":"key_rotate","target":"cloud/big-model","from":"â€¦k1","to":"â€¦k2"}
{"event":"fallback","from":"local/qwen3.8-27b","to":"cloud/big-model","reason":"rate_limit"}
{"event":"chain_exhausted","cls":"code","attempts":["local:rate_limit","cloud:over_budget"]}
{"event":"stream_failed","cls":"orchestrate","target":"local/qwen3.8-27b","message":"this operation was aborted"}
```

Skipped targets are logged too, with `skipped: true` and a reason â€” a log of
successes alone cannot show a fallback.

When nothing in the chain answers, the 503 carries a `hint` in
`error.router.hint` - one sentence naming the cause when every attempt shares one.
Three exist, each written from a failure that was reported as the wrong thing:

| hint | written when | what it says |
|---|---|---|
| free window | a `sharedQuota` provider is rate limited and OmniRoute could not answer | the free daily allowance is used up, and when it comes back |
| `budgetHint` | every target was skipped `over_budget` | the monthly cap and the spend against it (`$40.15 of $40.00`), and where to raise it |
| `localModelHint` | a local 5xx and `/props` names a different model than the one asked for | which model :8080 actually has loaded |

`localModelHint` costs one `GET /props` (1 s cap) on an error path only. A local
model that was never loaded is the common way to see `upstream_500` in
89 ms, and "the provider had a server error, retry later" is the wrong answer to it.

## Token usage

The ledger answers "may I spend more this month" and keeps one number per provider
per month. Token usage answers a different question - **how many tokens did each
model actually generate** - so it is a separate store with its own file, its own
retention and its own endpoint.

```
state/usage.jsonl          one line per completed call (next to ledger.json)
GET /admin/usage?days=1    today (from 00:00:00 UTC)
GET /admin/usage?days=30   the last 30 calendar days including today
```

The endpoint is behind the same token gate as `/admin/status`.

### What one line looks like

```json
{"at":"2026-10-20T08:45:31.412Z","provider":"local","model":"qwen3.8-27b","target":"local/qwen3.8-27b","tokensIn":58,"tokensOut":32,"cacheRead":54,"cacheWrite":null,"calls":1,"usd":0,"ok":true,"ms":683}
```

- `tokensIn` is the **prompt the model processed**. For an OpenAI-compatible
  provider `prompt_tokens` already includes cached tokens; Anthropic reports
  `input_tokens` *excluding* cache traffic, so its cache halves are added in. That
  is what makes `tokens = input + output` true for every provider.
- `cacheRead` / `cacheWrite` are `null` when the provider said nothing, and a
  number (including `0`) only when it did. An unknown cache number is not a zero;
  the panel prints "0" only for a measured zero.
- `usd` is the same number the ledger recorded, carried for auditing.
- Extra fields appear only when they apply: `"stream": true` for a streamed call,
  and `"measured": false` when the provider reported no usage at all (the call is
  counted, its tokens are not invented).

### Where a line comes from

| Path | Recorded by | Tokens |
|---|---|---|
| buffered reply (incl. providers that must stream, like OpenCode's free tier) | `route()` in `src/router.mjs` | the provider's real `usage` |
| streamed reply | `relayStream()` in `src/server.mjs`, once the stream ends | the provider's own usage chunk, or `measured: false` |

A failed call records nothing: a failed attempt consumed no meaningful tokens, and
the attempt log already carries the failure. A stream the client walked away from
mid-flight is a failed call too. Recording never throws into the request path - a
full disk or an unwritable state directory loses the line, not the answer.

Streamed OpenAI-compatible replies only carry usage if the request asks for it, so a
provider can opt in with `"streamUsage": true` (set for `local`, measured against
llama.cpp on 2026-10-20: it then sends a final chunk with `choices: []` and a real
`usage` object). Anthropic streams always report usage and need no flag.

### Retention and the size bound

- **30 days** of detail (`USAGE_RETENTION_DAYS`), because the panel asks for a
  30-day window and a month is the longest range anyone reads per model.
- **32 MiB hard cap** (`USAGE_MAX_BYTES`, ~180k calls). Retention alone cannot bound
  a hot loop - 500 requests/minute for a month is hundreds of megabytes - so the
  file is compacted whenever it crosses the cap: lines older than the window go
  first, and if a busy window still does not fit, the oldest lines are dropped until
  the rest fits. Compaction rewrites to 75% of the cap (tmp file + rename, like the
  ledger), so it runs roughly once per 8 MiB written rather than on every append.
- A crash can leave a half-written line. The reader skips it and keeps the rest, so
  the cost of a crash is one call of history, not the file.

Measured on this box: rolling up a generated **100,000-line, 30-day** file (one pass,
no cache, no index) takes **~220 ms**, which is the budget the test asserts against
(2000 ms) - a UI refresh is not a problem at that size.

### The exact JSON contract

```json
{
  "window": { "days": 1, "from": "2026-10-20T00:00:00.000Z", "to": "2026-10-20T08:50:00.000Z" },
  "updatedAt": "2026-10-20T08:45:32.000Z",
  "totals": { "tokens": 144130000, "input": 143000000, "output": 1130000, "cacheRead": 134000000, "cacheWrite": null, "calls": 1691 },
  "providers": [
    {
      "provider": "opencode-free",
      "label": "OpenCode Zen Free",
      "tokens": 136000000,
      "calls": 1568,
      "input": 135000000,
      "output": 1000000,
      "cacheRead": 130000000,
      "cacheWrite": null,
      "models": [
        { "model": "deepseek-v4.1-flash-free", "tokens": 135000000, "calls": 1500, "input": 134000000, "output": 1000000, "cacheRead": 130000000, "cacheWrite": null },
        { "model": "glm-5.3-flash-free", "tokens": 1000000, "calls": 68, "input": 1000000, "output": 0, "cacheRead": 0, "cacheWrite": null }
      ]
    },
    {
      "provider": "local",
      "label": "Local (this PC)",
      "tokens": 8130000,
      "calls": 123,
      "input": 8000000,
      "output": 130000,
      "cacheRead": 4000000,
      "cacheWrite": null,
      "models": [
        { "model": "qwen3.8-27b", "tokens": 8130000, "calls": 123, "input": 8000000, "output": 130000, "cacheRead": 4000000, "cacheWrite": null }
      ]
    }
  ],
  "current": { "provider": "local", "model": "qwen3.8-27b" }
}
```

- `providers` is sorted by `tokens` descending; `models` likewise. Ties break on
  `calls`, then on the id.
- `label` is the provider's `label` from `router.config.json`, else the first
  `models[]` entry for that provider, else the provider id.
- `current` is the provider/model of the **most recent recorded call in the
  window**, or `null` when nothing ran. It is derived, never guessed.
- `cacheRead` / `cacheWrite` are `number | null` at every level. A window total is
  `null` only when no provider in it reported that number.
- `totals` is the sum of `providers`, and each provider is the sum of its `models`.

## Acceptance evidence (T0.1)

`node scripts/loadtest.mjs` runs the criterion from `TASKS.md` literally: 500
requests to the `code` class, with the first provider rate-limited on **every**
call and the second healthy.

```
requests OK          500/500
served by cloud      500
wall clock           1.80s (budget 60s)
local stub calls     25   (all 429)   <- was 500 before the breaker
cloud stub calls     500  (all 200)
logged rate_limits   25
logged circuit_open  475  (skipped without a round trip)
logged fallbacks     500
ledger               cloud $0.01 over 500 calls
PASS: 500/500 completed with no user action while one provider was rate-limited,
      500 fallback paths are recorded in the log, and the breaker cut the
      dead provider's calls from 500 to 25 (475 skips, no round trip).
```

**The numbers worth reading twice.** 500 calls became 25 â€” and 25 is exactly the
concurrency, not the threshold: the first batch was already in flight when the
third failure tripped the breaker, so those 25 could not be spared. In production
that means a dead provider costs one burst, after which it is free. The 475 skips
never opened a socket. The wall clock also dropped (2.02s â†’ 1.80s) for the same
reason: 475 fewer doomed round trips.

The acceptance test now *asserts* this. Its assertion before was the bug written
down as a requirement â€” it demanded 500 `rate_limit` attempts, and would have gone
on passing while the provider was called 500 times.

## Known limits

- **Streaming falls back only before the first byte.** Once chunks are flowing, a
  mid-stream failure cannot be retried without sending the reply twice, so a
  truncated stream stays truncated. Buffered requests always get the full chain.
- **No auth on the endpoint.** It binds `127.0.0.1` and holds API keys. Do not
  expose it to a LAN or the internet before adding a token check.
- **Prices are per provider, not per model.** Fine while a chain is roughly
  one-model-per-provider; move to a per-model price table when that stops being true.
- **The circuit breaker is per process and in memory.** Two router processes do
  not share it (the same is already true of the ledger).
- **The ledger is a JSON file**, so two router processes would race it. One
  process, or move the ledger to Postgres (`:5432`, already running).
- **Anthropic tool calls are translated but not round-tripped**: `tools` pass
  through and `tool_use` blocks come back in OpenAI shape, but a full multi-turn
  tool conversation has not been exercised yet.

## On LiteLLM

The v2 plan recommends LiteLLM or OpenRouter here and calls this "an afternoon,
not a week" (`v2-claude-2026-10-18/MASTER-PLAN.md:87`). That is a fair call â€” this
is the same tradeoff, and building it was a deliberate decision, not an oversight.
What building it buys on **this** box: no Python dependency, no Docker, no proxy
process to babysit in front of the local llama.cpp, a budget ledger whose rules we
can read, and key rotation that matches how the free tiers here actually behave.
What it costs: LiteLLM has far more providers and is maintained by other people.
Revisit if the provider list grows past five.

## Next

1. Load keys from `~/.dsh/.credentials.yaml` or a local `.env` instead of the shell.
2. Per-model price table; ledger into Postgres.
3. A token check before this leaves `127.0.0.1`.
4. The harness that sits in front of it â€” `HARNESS.md`.
