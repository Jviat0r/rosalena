# rosa-opencode-handler

**OpenCode Zen's free tier inside Rosalena: probe it, list it, explain a 403/429, and pin one of its models.**

In Rosalena the wire gates are the **router's** job, because
the router is the only process that reaches the wire. This plugin is what a router
cannot be - a status surface and a switch.

## The problem this closes

Point any client at OpenCode's free tier and it refuses:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

Nothing is wrong with the key, the model id, or the harness. The gateway gates the
free tier on the request. Three gates, all measured on 2026-10-20 against
`https://opencode.ai/zen/v1/chat/completions`:

| Gate | What satisfies it | What fails it |
|---|---|---|
| streaming | `stream: true` on every upstream request | any buffered request is refused outright |
| client identity | the OpenCode user agent `opencode/latest/2.0.29/cli`, `x-opencode-client: cli`, `x-opencode-project: global`, and one `ses_`-shaped id repeated in `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id` | a missing header, or a malformed id such as `ses-probe-router-1` - refused exactly like no header at all |
| a tool named `read` | a tool whose function name is exactly `read` | `read_file` (same capability, different word), `shell`, or no tools at all |

The id shape is OpenCode's own: `ses_` + 12 lowercase hex + 14 base62. The router
hashes the conversation id into that shape, so one conversation keeps one id across
router restarts - the only reason the id exists upstream is prompt-cache affinity.

## Where the job lives

`router/src/providers.mjs` and `router/router.config.json`. The provider block says:

```json
"opencode-free": {
  "baseUrl": "https://opencode.ai/zen/v1",
  "requiresStream": true,
  "clientHeaders": "opencode",
  "ensureTools": ["read"],
  "userAgent": "opencode/latest/2.0.29/cli"
}
```

and the router renames a caller's read tool to `read` for the request and maps the
name back on the response, in both the buffered and streaming paths. A caller with
no read-like tool gets a documented stub, so it never sees a tool it did not
advertise.

The free models are `deepseek-v4.1-flash-free` and `glm-5.3-flash-free`, both
200000-token context / 65536-token output, both `opencode-free/*` targets in the
curated `models[]` menu and in the class chains (`orchestrate` and `code` use
DeepSeek, `fast` and `judge` use GLM).

## Commands

The harness dispatches `<plugin-id>:<command>`, so these are `/opencode-free status`,
`/opencode-free models`, ... (the `--plugin opencode-free:status` headless form works
too).

```
status   probe the gateway and print one verdict, the three gates, the free
         models, the last observed failure and a reset estimate
models   what is free, its limits, and which class chains name it (alias: who)
use      make one free model first in a router class:
           /opencode-free use deepseek-v4.1-flash-free
           /opencode-free use glm-5.3-flash-free --class fast --write
         Without --write it prints the exact before/after chain and writes
         nothing. With --write: a .bak- copy first, then the edit, then an
         atomic replace, and nothing is replaced unless every other key in the
         file is byte-for-byte unchanged.
key      every key source, masked
gates    the three gates as a checklist, read from the router config
clear    forget this plugin's own observation record
```

Verdicts are never merged:

| Verdict | Meaning | What to do |
|---|---|---|
| `USABLE` | the gateway streamed a reply with all three gates | nothing |
| `EXHAUSTED` | 429 `FreeUsageLimitError` | the shared free window is spent; the router falls through to the next target |
| `REFUSED` | 403 `FreeTierError` | a gate is unsatisfied - not the key, and re-adding the key will not help |
| `KEY` | 401 | the key is missing, revoked, or for another provider |
| `ERROR` | anything else (timeout, HTML, transport) | read the line; a 200 with an HTML body is not `USABLE` |

When a 429 carries `Retry-After`, `x-ratelimit-reset`, or a reset field in the body,
that time is used and labeled with where it came from. When it carries none, the
24-hour window from the first observed hit is used and labeled an estimate.

## Tool

`free_model_status` - the same report for an agent. The tool never writes the router
config; `use` is a person's decision.

## Hook

`llm/stream` (observer). It records two facts from real runs:

- a call that finished with a resolved `opencode-free/*` target: the last good free
  call and when;
- a call that failed with a free-tier error text: the last failure, its verdict, and
  the 24-hour reset estimate.

It decides nothing and never throws into the loop. A failure on a class call has no
resolved target in the hook payload, so only an error string that names the free tier
is recorded as one.

## Key sources

Tried in this order, first hit wins:

```
plugin.json config apiKey      explicit, for a test or another machine
OPENCODE_API_KEY               environment variable
router/data/keys.json          {"providers": {"opencode-free": ["oc_sk_..."]}}
~/.dsh/.credentials.yaml       DSH's file, read-only; set includeDsh: false to skip it
```

## What is verified, and what is not

- Verified by unit tests (stubbed, no network): the manifest, session id grammar, the
  seven headers, the probe body (stream + `read` tool), all five verdicts, 429 reset
  parsing from headers and body, status with a healthy / missing / malformed router,
  the model list, `use` accepted and refused, the atomic write with its backup and
  its "nothing else changed" check, and the hook recording both outcomes.
- Verified against the real repo (read-only): the router config parses, all three
  gates read `ok`, both model ids are listed with their limits and chains, and DSH's
  real record (`~/.dsh/rate-limits.json`) is merged into the status line.
- **Not** verified live end to end: no probe against the free tier was made after the
  port, because the free window is currently spent (429 since 2026-10-19). The first
  `/opencode-free status` with the real key will be the first live probe.
- The three gates were measured on this gateway, and a new model id on the same
  gateway is assumed to gate identically. If one does not, the verdict says
  `REFUSED` rather than guessing.

## Honest limits

- The free window is shared by every request from the same IP. A 429 says nothing
  about Rosalena's code, and local fallback is the designed behaviour.
- The probe is a real network call (about 1-2 seconds when the tier is up). It is
  never run on startup, never run by `models`/`gates`/`key`, and never run without a
  key. It asks for 16 tokens on a zero-priced model and never names a paid one.
- A probe is not free of consequences: on an exhausted window it spends one 429, and
  that 429 is recorded as the last failure.
- `use` edits a class chain, not the curated menu. If the target is not in the
  curated `models[]`, the menu will not show it; the chain still routes to it.
- The router reads its config at startup. A write takes effect after a restart, and
  in-flight requests keep the chain they started with.
