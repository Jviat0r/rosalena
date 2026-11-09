# rosa-local-model-monitor

A live, read-only view of the local llama.cpp server (`http://127.0.0.1:8080`)
inside the harness: is it up, which model, how much context, which slot is busy
and for how long, prompt/output tokens per busy slot, how many requests are
waiting, how the last few requests ended - plus the harness's own model calls,
with their exact duration, time to first token and the provider's token usage,
because the loop reports those instead of a sampler guessing at them.

It does two jobs: it watches the server, and the harness reports its own model
calls to it through `llm/stream`. The two are shown side by side and never
blended - the slot rows are sampled, the harness rows are exact.

Nothing here leaves the machine, and nothing here can start, stop or restart
anything.

## The rule this plugin exists under: read-only, one GPU

**One RTX 3090 holds one big model at a time.** That is the user's rule, and the
plugin follows it literally:

- it never starts, stops, restarts, swaps or interrupts llama-server;
- every request it makes is a `GET` (the test suite asserts this);
- it never sends a completion, so asking about the server never loads or warms
  anything.

Which model should be resident - the writer here, or ComfyUI on the same card -
is a machine-wide decision owned by whatever owns the GPU (ContentFarm's
`gpu-switch.ps1`), not by a tool a model can call mid-run. When the server is
down, the report says so and says who is in charge of bringing it back.

## What the model gets

Two tools:

- **`local_model_monitor`** - one call that answers everything above. Example
  from this box (real output, server idle at the time):

  ```
  local llama.cpp at http://127.0.0.1:8080
    status    up - qwen3.8-27b (Q4_K - Medium)
    weights   D:\models\qwen3.8-27b\Qwen3.8-27B-UD-Q4_K_M.gguf
    context   131072 tokens per slot, 1 slot
    slots     0 of 1 slot busy
              no slot is processing a request
    queued    not reported - /slots and /props expose no queue length, and GET /metrics answered HTTP 501 (metrics is off unless llama-server runs with --metrics)
    ended     none observed yet - a task is visible only while a /slots sample catches it busy
  ```

- **`local_model_requests`** - the bounded ledger of requests this plugin has
  observed, newest first, each with elapsed time, state (`running`, `unknown`,
  `ended`) and how it ended.

Plus a status helper: `/local-model-monitor status` in the CLI prints the same
report without asking a model, and the plugin's `status` hook supplies the one
line that `/plugins` and `--check` show.

## What the UI gets

`probeLocalModel({ baseUrl, timeoutMs })` is exported as a plain function so the
browser window and the tests can ask the server directly:

```js
import { probeLocalModel } from "./plugins/rosa-local-model-monitor/plugin.mjs";

const p = await probeLocalModel({ baseUrl: "http://127.0.0.1:8080", timeoutMs: 1500 });
// {
//   up, model, ctx, slots, busy, queued, lastEnded, error,          <- the contract
//   at, modelPath, modelFtype, totalSlots, queuedSource, queuedNote,
//   requests, lastEnded, slotsAvailable, slotsError, propsError,
//   loading, healthStatus, baseUrl                                 <- for rendering
// }
```

It never throws. `up` says whether the server answered at all; `error` names the
first endpoint that could not be read, so it can be set while `up` is true (a
build without `/slots`). `busy` and `queued` are `null` - not `0` - whenever the
number behind them could not be measured. `harnessCalls` is the harness's own
ledger (see below); it is empty until a run makes a model call in this process.

## The harness's own calls: the `llm/stream` hook

`/slots` is a sample of the server's state. It cannot see a request that started
and finished between two probes, and it has no start time even for the ones it
does see. The loop knows both, so the plugin registers one observer hook and the
harness reports every model call it makes, twice:

```js
// what the loop sends, in src/agent.mjs (start, then end)
{ phase: "start", run, step, attempt, cls, target, stream, routerUrl, maxTokens, task, root, tools, depth }
{ phase: "end",   ok, ms, ttftMs, usage, finishReason, error, reason, ...same fields }
```

The hook records the row and returns nothing: it can never advise, stop or retry
a call, and it does no I/O - it runs inside the loop's own call path, where the
only acceptable cost is a `Map` write. Each row keeps what the harness measured:
the real duration, time to first token, the provider's `usage`, the router
`target`, and `ok`/`error` with the loop's own reason (`step_timeout`,
`stream_truncated`, `call_failed`). An end that arrives without its start is
still recorded, with no measured start, because half an observation is not worth
throwing away.

Two honest limits, both visible in the output:

1. The hook fires for **every router target**, so a call sent to a cloud provider
   is listed too. `target` says which; nothing claims those rows reached the
   local server.
2. The ledger belongs to **this process**. A chat in the browser and a run in the
   terminal keep separate ledgers, and the page shows the ones the UI server made.

Rows from the two sources are labelled `harness` or `slot` and are never merged:
the same request can legitimately appear as both, and a shared request id does
not exist to join them.

## The monitor page

```
node src\cli.mjs --ui            # then open http://127.0.0.1:8090/monitor
```

There is also a "Local model monitor" link at the bottom of the sidebar. The page
polls `/api/local-model` every two seconds (paused while the tab is hidden), and
the UI server answers it by importing this plugin's module and calling
`probeLocalModel` - the same function the tools call, so the page cannot show a
different truth than `local_model_monitor` does. The routes live in the UI
server, so an instance that was already running before this plugin existed must be
restarted to serve them.

## Where every number comes from

| Number | Endpoint | When it is missing |
| --- | --- | --- |
| up / loading | `GET /health` (`200 {"status":"ok"}`, `503` while loading) | a build with no `/health` falls back to `/props` answering, and the report names the fallback |
| model id | `GET /props` -> `model_alias`, else the weights file name | `null`, reported as "model not reported" |
| context per slot | `GET /props` -> `default_generation_settings.n_ctx` | `null`, reported as "not reported" |
| slot count | `GET /props` -> `total_slots`, else the length of `/slots` | `null` without either |
| busy, prompt/output tokens, `n_remain` | `GET /slots` -> `is_processing`, `id_task`, `n_prompt_tokens`, `n_prompt_tokens_processed`, `n_prompt_tokens_cache`, `next_token[0].n_decoded` / `n_remain` | `unavailable` with the endpoint's own error; no count is printed |
| busy duration | two `/slots` samples of the same `id_task` | `null` for an idle slot |
| queued | `GET /metrics` -> `llamacpp:requests_deferred` | `null` with the reason: metrics is off unless llama-server runs with `--metrics`, and `/slots` has no queue field |
| how a request ended | two `/slots` samples | see below |
| the harness's own calls, their duration, ttft and token usage | the `llm/stream` hook (no endpoint at all) | `harnessCalls` is empty until a run calls a model in this process |

Measured on this box: llama-server `0.1.2-dev`, build 10517, commit `dc72703fc`,
with `--slots` enabled (the default) and `--metrics` off (also the default, and
the reason `queued` is reported as missing here rather than as `0`).

## What is deliberately not invented

llama.cpp does not report these, so the plugin says so instead of producing a
number that looks measured:

1. **The queue, without `--metrics`.** `/slots` lists slots and `/props` lists
   settings; neither has a waiting count. Prompt-engineered guessing is not
   reporting, so `queued` is `null` and the line explains why.
2. **When a task started.** `/slots` has no timestamp. Durations are measured
   from the first sample that saw the task busy, and the report says exactly
   that - a task already in flight when the plugin first looks shows a shorter
   duration than the truth, never a made-up start.
3. **Why a task ended.** `completed`, `eos`, token limit and "the client went
   away" are indistinguishable from outside. A task that is busy in one sample
   and gone from its slot in the next is recorded as ended, with the reason "the
   slot went idle; llama.cpp reports no stop reason". If another task took the
   slot before a probe saw it idle, the record says `replaced` instead.
4. **Requests from anything other than this harness that started and finished
   between two probes.** The plugin sees tasks, not requests: a short request from
   another client between calls never enters the sampled ledger, and the tool says
   so rather than presenting a partial list as complete. The harness's own calls
   are the exception - the loop reports those exactly, at both ends.
5. **Which server a harness call went to.** The `llm/stream` hook fires for every
   router target, so a row can name a cloud model. The plugin prints the target
   and claims nothing more: there is no request id shared between llama.cpp and
   the harness, so a `harness` row and a `slot` row are never joined into one.
6. **A build without `/slots`.** `busy` is `null`, the slot list is empty, and
   the report prints the endpoint's own 501 message. No busy/total counts appear.

The ledger lives in memory: restarting the harness forgets what it had seen.

## Configuration

`plugin.json` carries the defaults:

```json
{
  "baseUrl": "http://127.0.0.1:8080",
  "timeoutMs": 1500,
  "recentLimit": 12
}
```

- `baseUrl` - the server. Config only; a model cannot point this elsewhere.
- `timeoutMs` - every request's deadline (default 1500 ms, floored at 50). A slow
  or hung server becomes "timed out after 1500ms", never a stalled run.
- `recentLimit` - how many finished observations are kept per server (default
  12). `local_model_requests` returns at most 25 rows regardless.

`harness.config.json` overrides any of these the same way it does for every
other module; the plugin needs no entry there to work.

## Tests

```
node --test test/plugins-local-model-monitor.test.mjs
```

19 tests, all against real `node:http` servers on port 0 - no mocked `fetch`:

- the happy path, parsed field by field from `/health`, `/props` and `/slots`,
  plus a check that every request the stub received was a `GET`;
- a task leaving its slot: recorded as ended, span measured, and the last
  numbers measured while busy kept (an idle slot resets `n_decoded` to 0);
- a task replaced without an idle sample, and a task left unconfirmed when
  `/slots` stops answering mid-flight;
- connection refused, a timed-out server, and a server answering 500 everywhere;
- a build with no `/slots`, and a server that is up but still loading its model;
- the Prometheus queue gauge, and a build without it;
- the two tools, the bounded newest-first list, and duration formatting;
- the `llm/stream` hook, driven exactly the way the loop drives it: a start and
  its end become one exact row, a failure keeps the loop's own reason, an end
  with no start is still a row, the ledger is bounded, the hook survives junk it
  did not expect, and the report and the list label `harness` and `slot` rows
  separately.

`node src/cli.mjs --check` proves the module loads beside the rest of the suite
(no `FAILED` line, and `rosa-local-model-monitor` appears in `--plugins`).
