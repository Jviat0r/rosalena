# PINNED: the OpenCode endpoints and fingerprint

**Status: do not change these without Jayden's explicit, in-session approval.**

This file exists because they were changed once, on 2026-10-21, by an agent that
read the current OpenCode docs instead of measuring the gateway. The result was
two days of `429 FreeUsageLimitError`, `500/503 Upstream request failed` and
`400 reasoning_content` errors on a route that had been working. The URLs below
are not "the documented current endpoints" — they are **the measured ones**.

---

## The table

| Route | Base URL | Status |
|---|---|---|
| `opencode-free` (Rosalena router) | `https://opencode.ai/zen/v1` | **PINNED — works** |
| OpenCode Go (not configured) | `https://opencode.ai/inference/go/openai/v1` | reference only |
| `https://opencode.ai/inference/openai/v1` | — | **DO NOT USE for the free tier** |

User-Agent: `opencode/latest/2.0.29/cli`.

| Where | File | Field |
|---|---|---|
| Rosalena router | `router/router.config.json` | `providers["opencode-free"].baseUrl` / `.userAgent` |

DeepSeek Harness used the same gateway and identity; it is a separate project with its own
notes (`~/.dsh/profiles/desktop/ENDPOINTS-PINNED.md`) since 2026-11-08.

---

## Why `/zen/v1`, in evidence

- **Measured on 2026-10-20** against `https://opencode.ai/zen/v1/chat/completions`
  — that is the endpoint every gate in `router/src/providers.mjs` and
  `docs/FREE-TIER.md` was established on.
- **The router kept working on it** through the 2026-10-21 change, which was made to
  another client's config.
- **Re-verified 2026-10-22** during the revert: 5/5 requests on `/zen/v1` and
  5/5 on `/inference/openai/v1`, with UA 2.0.29 and 2.0.32 — so the newer
  gateway is not *dead*, which is exactly why the regression was invisible to a
  single probe and only showed up as sustained failures under real use.

## Why the change on 2026-10-21 was wrong

The reasoning was: the docs list the free models at `/inference/openai/v1`, and
the 2.0.32 CLI binary contains no `zen/v1` string. Both statements are true.
Neither is a measurement of the free tier through a third-party client. The
gateway is tolerant enough that a small probe passes on either URL, so the
reasoning survived review; what broke was sustained traffic — 190 rate-limit
rejections, 154 upstream 5xx and 34 quota errors accumulated on the moved route
before the revert.

**Documentation is not evidence here. A probe is.**

---

## What the router sends

| Parameter | Router | Source |
|---|---|---|
| Endpoint | `zen/v1` | `router.config.json` |
| User-Agent | `2.0.29/cli` | `router.config.json` |
| Context window | 200000 | model rows |
| Output cap | 65536 | model rows |
| Thinking mode | `requiresReasoningContent` | model rows |
| Session fingerprint | 4 `ses_` headers + client/project | `src/providers.mjs` |
| `read` tool gate | the router injects a stub if absent | `src/providers.mjs` |
| API key | optional | the key is sent and ignored upstream |

Retries, pinning and failover are the router's own (`src/router.mjs`, `src/limits.mjs`).

## If you believe the endpoint must change

Do not edit a config and walk away. In order:

1. Reproduce the failure on `/zen/v1` with a real request (see the probe scripts
   in `router/data/`).
2. Run the same request against the candidate endpoint.
3. Compare **sustained** behaviour, not one call: at least 10 sequential and 6
   concurrent requests per endpoint, recording status and latency.
4. Only then propose the change, with both result sets, to Jayden.

## Guards

- `router/test/endpoints-pinned.test.mjs` fails if `router.config.json` stops
  pointing at `/zen/v1`, if any `/inference/openai` URL appears in it, or if the
  User-Agent drifts from 2.0.29.

## The three gates on the free tier (unchanged, measured)

1. `stream: true` — a buffered request is refused.
2. The OpenCode fingerprint: four session headers carrying a `ses_…` token that
   matches `^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`, plus `x-opencode-client: cli`
   and `x-opencode-project: global`.
3. A tool named exactly `read` must be present.

The router satisfies all three; changing the URL is not a way around them, and
removing the fingerprint is a hard `403 FreeTierError`.
