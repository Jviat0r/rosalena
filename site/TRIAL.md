# The public trial endpoint

A tiny anonymous demo on https://rosalena.pages.dev: a visitor sends a few chat messages and watches a real
model answer, so they can judge the harness's conversation quality without installing anything. It is built
so that the public cannot spend real money, cannot use it as a general-purpose free API, and cannot find a key
in the browser.

```
site/functions/api/_lib/trial.mjs   the whole testable core
site/functions/api/trial.js         POST /api/trial
site/functions/api/quota.js         GET  /api/quota
site/migrations/0001_trial.sql      the counters
site/migrations/0002_usage.sql      the token budgets and the trial log
site/test/trial.test.mjs            30 tests, node --test, no network
```

**Nothing a visitor writes is stored, as shipped.** The endpoint writes counter rows
`(day, scope, used, stamp)`, token rows `(day, scope, tokens_in, tokens_out, requests, stamp)`, and one log row
per attempt whose prompt and answer columns are **null** while `TRIAL_LOG_MESSAGES` is at its default, `meta`.
Flipping that var to `full` stores the prompt and answer as well, and the page's "keeps nothing" sentence is
then untrue until the var is flipped back. See *The trial log* below.

## The contract the page is coded against

`GET /api/quota` → `200 application/json`:

```json
{ "ok": true,
  "anonymous": { "used": 2, "limit": 5, "resetAt": "2026-10-21T00:00:00.000Z" },
  "address": { "used": 2, "limit": 15 },
  "tokens": {
    "used": 1200,
    "limit": 40000,
    "address": { "used": 3000, "limit": 120000 },
    "global": { "used": 210000, "limit": 1000000 },
    "resetAt": "2026-10-21T00:00:00.000Z"
  },
  "account": null,
  "signInUrl": "/api/auth/start",
  "turnstileRequired": false,
  "model": { "label": "Llama 3.1 8B", "note": "a small model, running on Cloudflare, for the demo only" } }
```

`anonymous` is the *browser*: the counter the `rosalena_sid` cookie names (see *The session cookie*).
`address` is the same visitor's counter keyed on the salted IP. The token slices mirror the three message
scopes, and the top-level `tokens` slice is the browser's. A GET that carries no cookie gets one minted in the
response's `Set-Cookie`, so the next read counts the same browser.

`resetAt` is the next UTC midnight as an ISO string, so it is the same instant for every visitor; the page
formats it in local time rather than assuming a fixed offset. Read-only: a page reload never spends a message.

`POST /api/trial` body `{ message, history: [{role, content}], turnstileToken }` → `200 text/event-stream`:

Optional request header `x-trial-user-key: <key>`: the visitor's own provider key, if they pasted one.
It is only meaningful in `opencode-free` mode (see "Bring your own key" below) and is ignored otherwise.

```
data: {"delta":"Hello"}

data: {"delta":" there"}

data: {"done":true,"usage":{"input":123,"output":45},"quota":{"used":3,"limit":5,"resetAt":"...","address":{"used":3,"limit":15},"tokens":{"used":0,"limit":40000,"global":{"used":210000,"limit":1000000}}}}

data: [DONE]

```

The done frame's `tokens.used` is the browser's spend read *before* this answer was sent; the spend of the
answer that just streamed lands on the counters after the stream ends, so the next `/api/quota` read is the one
that shows it.

`usage` is a token *estimate* (characters ÷ 4) unless the provider reports real usage in the stream; the page
prints it as approximate. Every refusal is a non-200 JSON body, `{"error": "<sentence>", "kind": "<taxonomy>"}`:

| kind | status | when |
| --- | --- | --- |
| `quota` | 429 | this browser used its messages or tokens for the UTC day, this address used its messages or tokens, or the free provider's window is spent |
| `capacity` | 503 | the global daily breaker, a message already in flight from this IP, or a missing binding |
| `turnstile` | 403 | the human check is configured and did not pass |
| `bad_request` | 400 | bad JSON, a cap exceeded, a `system` role, or a foreign/missing Origin |
| `provider` | 502 | the model was asked and failed, timed out, or is not configured |

`quota` and `capacity` also send `Retry-After` in seconds until the counter resets.

Why `capacity` is 503 and not 429: a 429 says "you are sending too fast, slow down", and every client answers
that by retrying in seconds. A full global day or an unconfigured deployment does not clear in seconds, so 503
is the honest status. The page switches on `kind`; the status is for the network.

## Deploy

The `rosalena` project is live at `rosalena.pages.dev` and the `rosalena-trial` database id is in
`wrangler.toml`. For a fresh account the steps are below, in order; the order is the point.

1. Create the database and keep the id:

   ```
   npx wrangler d1 create rosalena-trial
   ```

   Paste the printed `database_id` into `wrangler.toml`. Deploy refuses until you do: Pages will not publish a
   binding it cannot resolve, and a trial that cannot count messages must not go live.

2. Apply the schema:

   ```
   npx wrangler d1 migrations apply rosalena-trial --remote
   ```

3. Set the two secrets that matter:

   ```
   npx wrangler pages secret put TRIAL_SALT --project-name rosalena
   npx wrangler pages secret put TRIAL_TURNSTILE_SECRET --project-name rosalena   # optional, see below
   ```

   A missing `TRIAL_SALT` still works but logs a warning: the IP hash then uses a constant salt and is a lookup
   table for the whole IPv4 space. Set it.

4. Deploy with the command already in `README.md`:

   ```
   npx wrangler pages deploy public --project-name rosalena --branch main --commit-dirty=true
   ```

   `wrangler.toml` sets `pages_build_output_dir = "public"`, so `functions/` is picked up as the Functions tree
   and `functions/api/trial.js` becomes `POST /api/trial`.

5. Add the platform firewall rule (next section). It cannot be created from code, and it is the only limit in
   this design that is not spent from your own quota.

6. Verify by hand: `GET /api/quota` returns the shape above and sets the `rosalena_sid` cookie, one
   `POST /api/trial` streams frames, a reload does not change `used`, and a sixth message from the same browser
   in the same UTC day returns `kind: "quota"` - clearing the cookie starts the browser wall over but not the
   address one.

The `_headers` CSP already carries `connect-src 'self'`, so the page can call these endpoints and no CSP change
was needed.

## The platform firewall rule (20 requests/minute/IP)

Create it in the dashboard, not here:

Cloudflare dashboard → the `rosalena` Pages project → **Security** → **WAF** → **Rate limiting rules** → Create:

- Rule name: `trial endpoint per-IP rate`
- If incoming requests match: `http.request.uri.path eq "/api/trial"`
- Rate: **20 requests per 1 minute**, counting by **IP address**
- Action: **Block**, with a 60-second timeout

Add a second rule with the same shape for `"/api/quota"` at 60/minute if the trial page's polling ever gets
noisy. The application caps (5 messages per browser per day, 15 per address per day, 1,000 for the day across
everyone, one in flight) are the money guard; this rule is the load guard, and it is what keeps a burst from
turning into a thousand D1 writes.

## Limits, and what each one is for

| Limit | Default | Why |
| --- | --- | --- |
| Browser messages | 5 per `rosalena_sid` cookie per UTC day | enough to judge the conversation, small enough to be worthless as an API |
| Address messages | 15 per salted IP per UTC day | clearing the cookie does not reset the address, so a determined visitor gets three browsers, not a new day |
| Browser tokens | 40,000 per cookie per UTC day | a long conversation costs more than five short ones; the counter is checked before the call and tallied after |
| Address tokens | 120,000 per salted IP per UTC day | the same anti-cookie-clearing logic, in cost units |
| Global token breaker | 1,000,000 per UTC day | the only thing between a front page and a bill, in cost units |
| One message in flight | per IP hash, ~2 s window | a double-submit or a burst cannot hold two upstream calls at once |
| Message length | 1,200 characters | a demo question, not a document |
| History | 12 turns | the page sends its own short conversation and nothing else |
| One history turn | 4,000 characters | bounds one turn before it can dominate the prompt |
| Whole prompt | 12,000 characters | bounds the input cost of every single request |
| Output | 700 `max_tokens`, temperature 0.7 | a short answer, and a hard ceiling on what one message can cost |
| Tools | none | the trial cannot touch a file or run anything |
| Global daily breaker | 1,000 messages per UTC day | the last message-scope wall, after the browser and the address |
| Per-request timeout | 30 s, upstream aborted | a hung provider cannot hold a worker open |
| Platform firewall | 20 requests/minute/IP | load, not money; created in the dashboard |

Every wall is checked **before** the provider call: the token walls are read (a refusal there costs nothing),
then the three message scopes are reserved in one D1 batch, so an over-limit request never reaches the model.

## Quota storage

`env.TRIAL_DB` is D1; three tables (see `migrations/0001_trial.sql` and `0002_usage.sql`).

- `trial_usage` counts messages. One row per UTC day per scope: `sid:<16 hex>`, `ip:<16 hex of SHA-256(salt +
  ip)>` and `global`.
- `trial_tokens` counts cost. One row per UTC day per scope, `tokens_in` + `tokens_out` + `requests`; the
  same three scopes.
- `trial_log` records one row per attempt, successful or refused (see *The trial log*).

Reserve then refund, on the message scopes:

```sql
INSERT INTO trial_usage (day, scope, used, stamp) VALUES (?, ?, 1, ?)
ON CONFLICT(day, scope) DO UPDATE SET used = used + 1, stamp = excluded.stamp
RETURNING used, stamp
```

The `sid` row, the `ip` row and the `global` row go in one `db.batch`, which D1 runs as one transaction. If
any comes back over its limit, the rows this call took are all decremented before the refusal is written, so
**a refused request consumes nothing**. The test suite proves that for each of the three caps.

Tokens are different by design: they are read before the call (that is the wall) and tallied into the three
scopes after the answer lands, from the provider's usage when it reports it and from a character estimate when
it does not. A refusal at the token wall spends zero; a refusal or a failure *after* the call is not refunded,
for the same reason as the message slots.

A failure *after* the reservation (provider throw, timeout, a 429 from the free tier) does **not** refund: the
slot was spent when the request went upstream, and refunding failures would let a visitor climb past the daily
cap by sending prompts the model rejects. Five failed messages cost five of five. That asymmetry is deliberate
and is asserted in tests 13 and 14.

## The session cookie

The first wall is a browser, not an address. The endpoint keeps one:

- **Name and value.** `rosalena_sid`, set with `HttpOnly; Secure; SameSite=Lax; Path=/` and a 180-day
  `Max-Age`. The value is `<16-hex id>.<32-hex MAC>`, where the MAC is HMAC-SHA256 of the id under
  `rosalena-sid:${TRIAL_SALT}` (falling back to `rosalena-sid:MISSING_SALT` when the secret is unset, which
  warns). A forged or edited value fails the MAC in constant time and the cookie is discarded, so the id can
  only come from this endpoint.
- **Minting.** The first `GET /api/quota` or `POST /api/trial` without a valid cookie mints one and sends it in
  `Set-Cookie`; every later call re-sends the same value, which is what refreshes the 180 days. The SSE
  response of a streamed answer carries the same `Set-Cookie` header, so an answer and its counter always
  agree on the browser.
- **Scope.** The counter scope is `sid:` plus 16 hex of SHA-256(salt + `"sid:" + id)`; the id itself never
  enters a counter, a log row or a response.
- **What it buys.** Clearing the cookie (or using a second browser on the same machine) starts the 5-message
  browser wall over, but not the 15-message address wall, which is keyed on the salted IP as before. The two
  walls together are what "the cookie is a convenience, the address is the brake" means in code.
- **Rotation.** Changing `TRIAL_SALT` invalidates every issued cookie at once: every browser mints a fresh id
  and starts a fresh 5-message allowance, while the address counters are untouched. That is the intended blast
  radius of a salt rotation, and it is the only way to reset the browser wall fleet-wide without a code change.

The cookie is a **session of the counter, not a session of the visitor**: it holds no identity, no history and
nothing that could be joined to another system. It exists so that "clear cookies and start over" costs the
visitor one address allowance instead of being free.

## The trial log

One row in `trial_log` per attempt, successful or refused, so the day can be audited without a packet capture:

| column | what it holds |
| --- | --- |
| `id` | a random 16-hex primary key |
| `day`, `stamp` | the UTC day and the attempt instant |
| `sid` | the session scope `sid:<16 hex>` when a valid cookie was present, else null; the same salted value the counter uses, so a log row joins to a counter row without the cookie id ever appearing |
| `ip` | the same 16-hex salted hash the counters use; never the raw address |
| `provider`, `model` | which provider actually answered (after any fallback), and the model id in force |
| `status` | `ok`, `refused` or `failed` |
| `kind` | the refusal taxonomy: `quota`, `capacity`, `provider`, `turnstile`, `bad_request` |
| `ms` | wall time in milliseconds, or null when nothing ran |
| `chars_in` | the character length of the message that was sent (history not counted) |
| `chars_out` | the character length of the answer that streamed, or 0 when there was none |
| `tokens_in`, `tokens_out` | the spend the tallies wrote, for cross-checking `trial_tokens` |
| `prompt`, `answer` | **null in `meta` mode; the first 4,000 characters of each in `full`** |
| `error` | **null in `meta` mode; in `full`, the provider's own failure message for a `failed` row** (secrets redacted, 4,000 characters) |

`error` was added in `migrations/0003_log_error.sql`. A `failed` row before that migration has only its
`status` and `kind`; a row after it also says what broke, which is the difference between "the demo is flaky"
and "the upstream reset the connection after 1 token".

The switch is `TRIAL_LOG_MESSAGES`, read per request:

- `meta`, the default as shipped: the words are never written. The row says who hit what, how it ended and
  what it cost. This is the mode that keeps the page's "this page keeps nothing" sentence true, because the
  only durable traces of a conversation are its shape, not its contents.
- `full`: prompt, answer and the provider's error are written, truncated to 4,000 characters each. Use it for
  a short window while reviewing abuse or chasing a bug report, and flip it back to `meta` as soon as the review
  is done; while it is on, the "keeps nothing" sentence on the public pages is untrue, and that should be a
  conscious state, not an accident. **As of this writing the live deployment is deliberately on `full`** for the
  first outside testers: see the comment on `TRIAL_LOG_MESSAGES` in `wrangler.toml`.
- `error` follows the same gate as `prompt`/`answer`, because a provider message can quote the request back:
  `meta` keeps `status` and `kind` only, `full` keeps the message.
- `off`: no row at all.

A log write that fails warns and is dropped; it never fails the answer. Refusals are logged too, with their
kind, so "why did this address stop getting answers" is a query, not an archaeology project.

The query an operator will actually run:

```sql
SELECT day, ip, sid, status, kind, tokens_in, tokens_out, ms
FROM trial_log
WHERE day = '2026-10-21'
ORDER BY stamp
LIMIT 100;
```

and, when `full` was on and the review needs the words:

```sql
SELECT stamp, ip, sid, status, kind, prompt, answer
FROM trial_log
WHERE day = '2026-10-21' AND status = 'refused'
ORDER BY stamp;
```

The bug-report query, which is why `error` exists at all:

```sql
SELECT stamp, provider, model, chars_out, error, prompt, answer
FROM trial_log
WHERE day = '2026-10-21' AND status <> 'ok'
ORDER BY stamp;
```

A tester's report ("it just stopped", "the answer was blank") is then three rows, not a guess. Two shapes are
worth knowing before reading that output:

- `status = 'failed'` with `error` set: the provider failed. `answer` holds whatever streamed before the
  failure, so an empty `answer` means it failed before the first token.
- `status = 'ok'` with `chars_out = 0`: the provider returned successfully and said nothing. That is a model
  problem, not a transport one, and it is invisible in the counters - the demo page has its own empty-answer
  prompt to retry it, but the row is what proves it happened.

Delete or export rows before flipping back to `meta` if a review is meant to leave no transcript behind:

```bash
npx wrangler d1 execute rosalena-trial --remote --command \
  "DELETE FROM trial_log WHERE day = '2026-10-21'"
npx wrangler d1 execute rosalena-trial --remote --json --command \
  "SELECT * FROM trial_log WHERE day = '2026-10-21'" > trial-log-2026-10-21.json
```

## Env

Vars live in `wrangler.toml`; secrets are set with `wrangler pages secret put`.

| Var | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `TRIAL_DB` | D1 binding | — | counters; the endpoint refuses (provider/502) without it |
| `AI` | Workers AI binding | — | the model for the default provider |
| `TRIAL_SALT` | secret | unset (warns) | salt for the IP hash; never the raw IP |
| `TRIAL_ORIGIN` | var | `https://rosalena.pages.dev` | the only allowed `Origin` |
| `TRIAL_PROVIDER` | var | **empty — off** | a chain, in order: `opencode-free`, `omniroute`, `workers-ai`, `stub`. Empty or whitespace means **no hosted provider at all**; see *Why a fresh deployment ships with the hosted path off* below. The live `rosalena` deployment sets `opencode-free,omniroute,workers-ai` |
| `OMNIROUTE_URL` | secret | unset (skipped) | the public `/v1` address of OmniRoute on the owner's PC, behind `node site/tools/omniroute-tunnel.mjs --set-secret` (a quick tunnel: a new address every start, so redeploy after it) |
| `OMNIROUTE_API_KEY` | secret | unset (skipped) | the OmniRoute key; the tunnel's gate also checks it, because OmniRoute trusts loopback callers without one |
| `OMNIROUTE_MODEL` | var | `auto` | the OmniRoute model; the live site uses `auto/fast` |
| `OMNIROUTE_FIRST_BYTE_MS` | var | `20000` | how long OmniRoute gets to start answering before the chain moves on |
| `TRIAL_MODEL` | var | `@cf/meta/llama-3.1-8b-instruct-fp8` | the Workers AI model id (the plain `-instruct` id was retired 2026-05-30) |
| `TRIAL_MODEL_LABEL` | var | empty | the label `/api/quota` prints; only read when a hosted provider is configured |
| `TRIAL_MODEL_NOTE` | var | empty | the note under it; only read when a hosted provider is configured |
| `TRIAL_SESSION_DAILY_LIMIT` | var | `5` | messages per browser (the `rosalena_sid` cookie) per UTC day |
| `TRIAL_IP_DAILY_LIMIT` | var | `15` | messages per salted IP per UTC day |
| `TRIAL_GLOBAL_DAILY_LIMIT` | var | `1000` | messages across everyone per UTC day |
| `TRIAL_SESSION_DAILY_TOKENS` | var | `40000` | tokens per browser per UTC day |
| `TRIAL_IP_DAILY_TOKENS` | var | `120000` | tokens per salted IP per UTC day |
| `TRIAL_GLOBAL_DAILY_TOKENS` | var | `1000000` | tokens across everyone per UTC day |
| `TRIAL_LOG_MESSAGES` | var | `meta` | the trial log switch: `off`, `meta`, or `full`; unknown values read as `meta`. See *The trial log* |
| `TRIAL_MAX_MESSAGE_CHARS` | var | `1200` | one message |
| `TRIAL_HISTORY_TURNS` | var | `12` | history entries |
| `TRIAL_HISTORY_TURN_CHARS` | var | `4000` | one history entry |
| `TRIAL_PROMPT_CHARS` | var | `12000` | message + all history |
| `TRIAL_MAX_TOKENS` | var | `700` | output ceiling |
| `TRIAL_TEMPERATURE` | var | `0.7` | sampling |
| `TRIAL_TIMEOUT_MS` | var | `30000` | answer deadline, clamped to 50 ms–120 s; starts over at the answering model's first token |
| `TRIAL_SEARCH` | var | on | `off` takes web search out of the free window |
| `TRIAL_INFLIGHT_MS` | var | `2000` | how long one IP counts as busy |
| `OPENCODE_API_KEY` | secret | unset | the fallback bearer key in `opencode-free` mode, used only when the visitor sends no `x-trial-user-key` |
| `TRIAL_TURNSTILE_SECRET` | secret | unset | enables Turnstile; `turnstileRequired` follows it |
| `TRIAL_SESSION_SEED` | secret/var | `rosalena-public-trial` | seed for the `ses_` id in `opencode-free` mode |

All limits are read per request, so changing a var needs a deploy but no code change. A value that is not a
number is ignored rather than treated as zero, because a zero limit would look like an outage.

## Providers, and the chain

`TRIAL_PROVIDER` takes **one name or a comma-separated chain**, tried in order.

### Why a fresh deployment ships with the hosted path off

```
TRIAL_PROVIDER = ""
```

An unset var falls back to `workers-ai`; a **set-but-empty** var means no hosted provider exists. That difference
is deliberate, so a hand-edited `wrangler.toml` cannot switch the endpoint back on by dropping a line. With an empty
chain every `POST /api/trial` is refused with `502` and `kind: "provider"` **before a single D1 slot is reserved**,
and `GET /api/quota` reports `model.hosted: false`, `model.provider: null`, `model.label: "your own machine"`.

The reason is the measurement in *What the free tier keys on, measured*, further down: a Worker's requests leave
from one datacenter address, the free tier judges addresses rather than counters, and a public page behind it
would spend a shared window that also belongs to the desktop app on the same network. So a fresh deployment keeps
the hosted path off.

The live `rosalena` deployment is the one deliberate exception: it pins `TRIAL_PROVIDER = "opencode-free"` on
its own, with the page probing the visitor's desktop app first and the caps above as the brake. That is an
operator choice recorded in `wrangler.toml`, not the default.

### Where the demo answers from instead

| Path | Whose compute | Whose address | Shipped |
| --- | --- | --- | --- |
| Desktop app on loopback (`/try/` -> `127.0.0.1:8765`) | the visitor's machine, via their router and their free window | the visitor's | yes, primary |
| WebGPU in the tab (home page `#try`) | the visitor's graphics card | nobody's; no network call | yes, secondary |
| Hosted chain (`opencode-free`, `workers-ai`) | this project's account | one shared egress | off by default; **on** in the live deployment, pinned to `opencode-free` |

The desktop bridge is documented in `harness\HARNESS.md` under *The bridge*: it binds `127.0.0.1`, allows three
origins, requires a 32-character pairing token that travels in the URL **fragment**, and re-frames the router's
stream for the page when asked with `?format=trial`. Chrome's Private Network Access check is answered with
`access-control-allow-private-network: true`; without it a public `https://` page cannot reach loopback at all.

A page on its own can never do this. Measured against `https://opencode.ai/zen/v1/chat/completions`: the preflight
`OPTIONS` returns `404` with **no** `access-control-allow-origin`, and a direct `POST` carrying
`Origin: https://rosalena.pages.dev` returns `403`, also with no CORS headers. A browser therefore cannot read a
free-tier answer directly, which is why the visitor's-IP path needs the desktop app and not just a web page.

### Turning a hosted chain back on

If a chain is ever wanted again, put one back explicitly:

```
TRIAL_PROVIDER = "opencode-free,workers-ai"
```

which reads: the free tier answers, and if its window is spent a small Workers AI model answers instead of the
visitor getting a refusal. That is the same move the desktop router makes when a free model is busy, and it is the
reason the demo can borrow a free tier without being at its mercy. Set `TRIAL_MODEL_LABEL` and `TRIAL_MODEL_NOTE`
alongside it, or the page will name the model with the generic fallback.

The `done` frame carries `provider`, `degraded` and `fellBackFrom`, and `GET /api/quota` carries `provider` and
`fallback`, so the page can say which model answered. A silent substitution would quietly falsify every other
number on the page.

Fallback happens **only before the first delta**. Once text has streamed, a failure is reported as an error frame
instead of continuing in a second model's voice: splicing two models together mid-sentence reads as corruption.

### What the free tier keys on, measured

Four keyless requests, 16 output tokens each, three with fresh `ses_` ids and one repeating the first, all from
one address: `200, 200, 200, 200`, about a second each. The gateway advertises **no** rate-limit headers - no
remaining count, no reset - so there is no way to read the window and pace against it. Our own quota is therefore
the only brake we will ever have.

Hours later the same address was refused with:

> FreeTierError: OpenCode's free models aren't available from your current network because we've detected
> abusive traffic from this IP address. This isn't related to your account.

That sentence answers the design question. The window is keyed on the **address**, and it carries a judgement
rather than only a counter. The flag landed on this machine's own IP after a day of retries, which is exactly what
a public endpoint would do to the Worker's shared Cloudflare egress, only faster - every visitor arrives through
one or a handful of datacenter addresses instead of thousands of homes. That is why `workers-ai` sits behind the
free tier in the chain, and why it is the one provider whose cost, terms and credentials all live inside the
account that owns the site.

**`opencode-free` is therefore first in the chain because its answers are better, not because it is dependable.**
Two further facts about it stand:

- under real traffic it is rate-limited quickly, and while it is limited the shared window is closed to everyone
  using it, including the desktop app on the same address;
- the request shape impersonates their CLI (client fingerprint, `ses_` session id, a tool named `read` the gateway
  demands), so a public endpoint pointed at it is a decision about somebody else's terms, not a technical one.

**`stub`** streams three fixed deltas with no network at all. It is what the tests and local development use, and
it is the only mode that accepts a request with no `Origin` header.

Setting `TRIAL_PROVIDER = "workers-ai"` restores a single-provider chain with no code change. Setting it to `""`
(or leaving it out of a hand-written file as an empty string) turns the hosted path off again.

### Bring your own key

The per-browser and per-address quotas protect **this site's counters, not somebody else's service.** A visitor
who brings their own key gets their own upstream window; a visitor without one shares whatever window the
Worker's egress address has, which under any real traffic is exhausted quickly - so `opencode-free` without a
per-visitor key is for a demo the owner is watching, not for general traffic.

How it works: the page keeps the visitor's key in `sessionStorage` (never a URL, never `localStorage`) and sends
it as the `x-trial-user-key` header on `POST /api/trial`. The Worker trims it, checks that it is printable
ASCII of 8 to 400 characters, and puts it in exactly one place - the `authorization: Bearer` header of the upstream
request - instead of `env.OPENCODE_API_KEY`. It is never stored, never logged, never echoed back, and never
compared with anything: a bad key is simply refused by the provider, and that refusal reaches the page as
`kind: "provider"` with a sentence saying the key was refused. The quota still applies, because the counters are
per browser and per address and not per key, so pasting a fresh key does not reset the slice. The eight-character floor is
not a format check: it is there so the key is always long enough for the log scrubber to erase, which is why a
shorter value is refused instead of forwarded.

With no header the old behaviour stands: the deployment's own `OPENCODE_API_KEY` if that secret exists, and no
`authorization` header at all if it does not. The header is ignored by `workers-ai` and `stub`, which have no
accounts to authenticate to.

## Security and privacy, and what is *not* protected

Kept:

- The API key is put in an upstream header only. It is in no response body, no SSE frame and no log line; log
  lines run through `redact()`. Test 17 asserts this with a provider that echoes the key back.
- A visitor's own key is treated the same way and one step harder: it is in the redaction list from the moment
  the header is read, and in `opencode-free` mode the upstream error body is not logged at all while a visitor's
  key is in play, because an error body is the most likely place a provider echoes a credential back. Tests 18
  and 19 assert that the key is in exactly one upstream header and in no frame, no response header, no error
  message and no log line - including on the 401 path.
- `Origin` must be `TRIAL_ORIGIN`. A foreign origin is `bad_request`; a missing origin is allowed only in
  `stub` mode.
- History roles are only `user` and `assistant`. A `system` role is refused, so a visitor cannot inject
  instructions into the system position.
- The session cookie is signed, so the browser id cannot be forged or swapped; it holds no identity and no
  history, and only its salted 16-hex scope ever reaches a counter or a log row.
- No prompt or completion is stored **while `TRIAL_LOG_MESSAGES` is at its default, `meta`**: D1 holds the
  counters, the token tallies, and one metadata row per attempt whose `prompt` and `answer` columns are null.
  In `full` mode the words are stored, truncated to 4,000 characters each; see *The trial log*.
- No raw IP is stored, logged or sent: only the salted 16-hex-char hash.
- No tools. The trial cannot read a file or run anything. The single `read` tool in `opencode-free` mode is a
  gateway gate; it has no implementation, and the stream reader keeps only `delta.content`, so a tool call is
  dropped rather than executed.

Not protected, honestly:

- **The address quota is address-keyed.** A VPN, a phone hotspot or a proxy farm resets it, and a whole office
  shares it. The browser cookie stops a casual visitor from resetting it by clearing cookies, and it does
  nothing against a script that never keeps one. Together the two walls really buy a ceiling on a single
  casual visitor; the 1,000-message and 1,000,000-token global breakers are the real bill guards, and their
  point is that they are small enough to be affordable if they are ever fully spent.
- **D1 is the count, but a Worker is not a single process.** The in-flight guard is a Map in one isolate, so two
  requests from one IP can land in two isolates and both run. It is a cheap guard against the double-submit it
  was built for, not a lock. The daily counters do not have this problem: they are one batch in D1.
- **The 30 s deadline stops the answer, not the invoice.** A provider that has already generated tokens bills
  for them even when the visitor closes the tab.
- **`signInUrl` points at `/api/auth/start`, which does not exist yet.** The page only links to it, and
  `account` is always `null`; there is no sign-in flow behind it in this deployment.
- **Turnstile is wired but optional.** With `TRIAL_TURNSTILE_SECRET` set, a request without a valid token is
  refused before a counter moves. Without it, nothing proves a human is on the other end, and the 5-per-browser
  and 15-per-address caps are all that stand between a script that keeps no cookies and its 15 messages.
- **Cost is bounded, not zero.** 1,000 messages of at most ~12k input characters and 700 output tokens is the
  worst case by message count, and the global token breaker caps the day at 1,000,000 tokens whichever way you
  count. Whether that fits the free allocation in use depends on the day's pricing; check the current numbers
  rather than trusting a figure in this file.
- **Deployed and verified live.** The `rosalena` project is live at `rosalena.pages.dev`, deployed with
  `wrangler pages deploy public` and checked against the real endpoints after each change. The verification
  behind this file is the 30 unit tests for the trial core (154 across the site suite), `node --check` on
  each function, and a local smoke run of the two handlers with a fake env.
- **The page does not send the key.** `public/try/app.js` probes the desktop bridge on `127.0.0.1:8765` first
  and posts to `/api/trial` only when the app is not there, so `x-trial-user-key` is unused until a page grows
  the field again.
- **`opencode-free` is somebody else's free tier, whatever this site's caps do.** The request is still shaped
  like their CLI and can still be revoked at their discretion, and the shared window can close on abusive-IP
  judgement (measured, above). The live deployment keeps it pinned to the single keyless provider for that
  reason, with the per-browser, per-address and global caps as the brake, and a refusal that says so when the
  window is spent.

## The system prompt, in full

One function (`systemPrompt(search)` in `_lib/trial.mjs`) so the page and this doc cannot drift. Every
state starts the same:

> You are the demo assistant on the public trial page of Rosalena Harness, a desktop app that runs local and
> free-cloud models behind one router.
>
> This is a demo: you cannot read files, run commands, open links or remember anything across page reloads, and
> you have no access to the visitor's computer.
>
> When a visitor asks for real work - editing a file, running something, remembering a previous visit - say
> plainly that this page can only talk, and that the desktop app is where that work happens.

then one line for the search state, then the length rule:

- `on` (the default): one web search per message. The model asks for it in text, as one line
  `[[search: terms]]`, so every provider in the chain can use it, including ones that take no `tools`. A plain
  marker on purpose: through OmniRoute the `<tool_call>` form made GLM say it had no search at all. Calls
  written in any model's own tool-call format are read too.
- `done`: the second round, after the search ran: answer from the results in the last message and cite them by
  number.
- `off` (`TRIAL_SEARCH=off`): no search; never write tool-call markup, answer from memory and say it may be out
  of date.

> Answer in under about 200 words, skip preamble and restating the question, and never invent a result you could
> not have seen. If you do not know, say so.

## Web search

The free window's one tool (`_lib/search.mjs`). When an answer starts with a tool call, the stream cuts there,
the server reads the query out of whatever spelling the model used, runs one search (Brave with
`BRAVE_API_KEY`, Tavily with `TAVILY_API_KEY`, otherwise DuckDuckGo's keyless HTML page, run from the owner's
PC through the OmniRoute gate's `POST /v1/search` because DuckDuckGo answers Cloudflare's addresses with a bot
check, and directly only when the PC is off; 8 s, 5 results) and
asks the model again, preferring the one that asked, with the numbered results. The page gets
`{tool: {name, query, status: "running"}}`, then `status: "done"` or `"failed"` with `results: [{title, url}]`,
and the answer ends with a `Sources:` list. A search that fails still gets an answer from memory. A call for
any other tool is cut, never run, and the visitor reads a one-line note instead. Only search results are read;
no result page is ever fetched. The log row's answer records `[searched: query, N results]` between the rounds.

Some models never get their call through: GLM behind OmniRoute writes "I will search for ..." and stops,
because the host serving it strips the call (with or without `tools` in the request), and Llama 3.1 8B
answers "I couldn't find any information about ...". A first answer under 500 characters that only announces
a search or only says the model does not know (`wantsSearch`) gets the search anyway, on the visitor's own
message, and the searched answer follows it.

The time limit (`TRIAL_TIMEOUT_MS`, 30 s) starts with the request and starts over at the answering model's first
token and again when the searched round begins, so providers that fell through, and the search itself, never
leave the model that answers a few seconds to finish in.

## Run the tests

```
cd 'D:\AppDev\Rosalena Harness\site'
node --test test\trial.test.mjs
```

No dependencies, no network, no Cloudflare: an in-memory D1 double, a fake `AI` binding, a fake `fetch` and a
fake clock. 30 tests in `trial.test.mjs`, green. The whole site suite is `node --test test\*.test.mjs` and
comes back 154 green.
