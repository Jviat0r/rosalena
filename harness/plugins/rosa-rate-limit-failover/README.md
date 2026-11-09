# rosa-rate-limit-failover

Rosalena's own rate-limit plugin: it remembers which provider route
ran out of budget (or fell over), reports that record, and keeps the next call off
the route.

Two facts make the port smaller than the original, and they are the honest part
of it:

- **The router already fails over.** `src/` never calls a provider directly; the
  router on port 8077 walks each task class's chain and falls back inside a single
  call. So a cloud 429 often looks like a slow answer and nothing more. This plugin
  does not duplicate that, and it cannot make it better: a class chain is built per
  request, from the router's own config.
- **A plugin cannot intercept a request.** Rosalena's seam has no request-error
  waterfall. `llm/stream` is an observer - its return value is ignored - and
  `beforeStep` can only re-target the call that comes *next*. A step that fails
  ends its run, and nothing here can rewind that.

What is left is the thing the router has no room for: **memory**. The router's
state is per-request. It does not know that a shared free-tier budget is gone until
tomorrow, so every new run walks into the same wall and spends its retry budget
there. This plugin keeps that memory in one file, on disk, shared by every run in
every process.

## What it records

`<root>\.rate-limits.json` (or `config.stateFile`), one entry per provider route:

| field | meaning |
|---|---|
| `kind` | `usage` (a budget cap) or `server` (a 500-class outage) |
| `firstHitAt` | the first hit of the current window - it never moves while the window is open, so the estimate stays fixed |
| `windowEndsAt` | `firstHitAt` + `resetHours` (usage) or `+ cooldownMinutes` (server) |
| `hits`, `lastHitAt` | every hit inside the window |
| `models` | which models were seen failing on that route |
| `reason` | the error text, truncated - the evidence, not a summary |

Two rules keep it honest:

- **A usage cap beats a server error.** Quota wording is tested first, so a 429
  body that also says "server error" is filed as a budget cap, not as a ten-minute
  blip. And a long window is never shortened by a short one arriving mid-window.
- **The reset time is an estimate, and it says so.** No gateway in this stack
  sends a reset time; OpenCode's free tier resets daily, so `resetHours` defaults
  to 24. Every place the number appears is labelled `estimated reset`.

## How it decides a route

A call has a `target` (`provider/model`) only when something pinned it. A
class-routed call has none, so a hit is attributed as:

1. `routeOf(info.target)` when the call carried a target;
2. otherwise the first `provider/model` token in the error text, because that is
   usually where the failing gateway is named;
3. otherwise `(unknown)` - recorded, never dropped.

## What it does with the record

- `beforeStep` re-targets the next step when **this run** just lost a call to a
  limit, and appends one note. The note uses absolute times only, so it does not
  change from step to step and does not churn the provider's prompt cache.
- `pinWhenLimited: true` is the blunt mode: while any route is limited, every run
  starts on `config.fallback`. Enable it when the fallback is local and free; leave
  it off when it is a metered cloud model, because it will pin runs that would
  never have touched the limited route.
- With no `fallback` configured the plugin is **record only**: it still writes the
  file and answers the tool, and its hooks advise nothing.

## Config

```json
{
  "stateFile": "",
  "resetHours": 24,
  "cooldownMinutes": 10,
  "fallback": "",
  "pinWhenLimited": false,
  "patterns": []
}
```

`stateFile` defaults to `<root>\.rate-limits.json`. `patterns` replaces the
usage-limit list (default: `FreeUsageLimitError`, `GoUsageLimitError`,
`Rate limit exceeded`, `usage limit`, `Insufficient account funds`,
`insufficient_quota`, `quota exceeded`, `out of budget`). Override any of it under
`plugins["rosa-rate-limit-failover"].config` in `harness.config.json`.

## Surface

| kind | name | what it does |
|---|---|---|
| tool | `rate_limit_status` | the whole record as text: active windows, first hit, estimated reset, hits, models, expired routes |
| command | `rosa-rate-limit-failover:status` | the same text, without spending a model turn |
| command | `rosa-rate-limit-failover:clear` | empties the record (use it when a limit reset early) |

Both the tool and the command read the same file the hooks write, so they cannot
disagree with each other. Loading the plugin never creates the file.

## What it cannot do, stated once more

- It cannot retry the failed step on another model. DSH's version can (it re-runs
  the step after `selectModel`); Rosalena's loop has no such seam, and this plugin
  does not pretend otherwise - the run ends, the record survives, the next run
  starts informed.
- It cannot see the router's internal chain, so it cannot say which hop failed,
  only which route the failure was attributed to.
- It does not poll anything. Its numbers come from failures the loop actually
  reported.

## Tests

`test\plugins-rate-limit-failover.test.mjs` - 18 tests, all pure or on a temp
directory: classification (including a quota word inside a 500 body, and a "500"
that is really a token count), route attribution, window freezing/upgrading,
expiry, the on-disk round trip with a corrupt file, and each hook's advice in
both modes.
