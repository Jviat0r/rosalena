# rosa-local-model-switch

Which local GGUF models are installed, which one llama.cpp is serving right now,
which of them the card can actually hold, and **the exact `llama-server` command
that would switch to another one** - printed, never run.

It answers the question a person has in front of a box with one
GPU: "what do I have, what is loaded, what would fit, and what do I type?"

## The rule this plugin exists under: it does not switch

**One RTX 3090 serves either the writer (`:8080`) or the renderer (`:8188`),
never both.** So a model that is resident right now may be in the middle of an
answer somebody is waiting for. Stopping it to make room would throw that answer
away, and starting a second server would not fit. The plugin follows the rule
literally:

- it never starts, stops, restarts, swaps or kills a process;
- every request it makes is a `GET` (the test suite asserts this);
- it never sends a completion, so asking about the server never loads anything;
- "switch" means **the command to paste**, plus the evidence that pasting it is
  a good idea.

The person who owns the GPU runs it. When a slot is generating, the plan refuses
and says why - the command is still shown, under the refusal, because the answer
to "how do I switch" does not change just because the moment is wrong.

## What it prints

### `rosa-local-model-switch:list` - the shelf and the resident model

```
local models - NVIDIA GeForce RTX 3090, 24.0 GiB VRAM, 0.9 GiB free
  server  up at http://127.0.0.1:8080 - serving qwen3.8-27b
  context 131072 tokens per slot, 1 slot - the live server's own figure
  quant   Q4_K - Medium (reported by the server)
  busy    slot 0 is processing - task 245603, 8024 tokens decoded, 168 to go, 67781 prompt tokens
  weights D:\models\qwen3.8-27b\Qwen3.8-27B-UD-Q4_K_M.gguf

installed - D:\Models, 13 model file(s) of 20 .gguf, 173.6 GiB on disk
  now   idle       need       size  quant       params   file
  idle  yes     19.8 GiB  15.3 GiB  Q4_K_M      27B      qwen3.8-27b\Qwen3.8-27B-UD-Q4_K_M.gguf  <- resident
  idle  yes     20.2 GiB  15.7 GiB  Q4_K_M      27B      Qwen3.8-K_M_Abl\Qwen3.8-27B-OBLITERATED-Q4_K_M.gguf
  ...
  'now' answers 'does it fit the VRAM that is free this second'; 'idle' answers 'does it fit the card at all'.

catalog: 10 entries, 8 not installed (qwen3-32b, qwen3-30b-a3b, qwen3-14b, ...)
  `plan <name>` works for those too: it names the quant worth downloading and refuses if the card cannot hold it.

nothing here starts, stops or kills a server. `plan <name>` prints the command to run yourself.
```

(Real output from this box. The two verdict columns are the whole point: with the
writer resident, the free-VRAM answer is `no` for everything, and the card-level
answer is `yes` - saying only the first would say no to every model on the disk.)

### `rosa-local-model-switch:now` - what is serving, and how it is doing

```
local model server - now
  server  up at http://127.0.0.1:8080 - serving qwen3.8-27b
  model   qwen3.8-27b (Q4_K - Medium)
  weights D:\models\qwen3.8-27b\Qwen3.8-27B-UD-Q4_K_M.gguf
  context 131072 tokens per slot, 1 slot (the server's own report)
  busy    slot 0 is processing - task 248838, 707 tokens decoded, 7485 to go, 60464 prompt tokens
  card    NVIDIA GeForce RTX 3090 - 0.9 GiB free of 24.0 GiB, 7.7 GiB RAM free
  fits    fits when idle - 19.8 GiB does not fit the 0.9 GiB that are free, but it fits the card's whole 24.0 GiB - it needs whatever holds the card now to stop
          the 19.8 GiB figure is for 16384 tokens (the catalog's serveContext); the server runs 131072,
          whose KV cache is larger and is not included in that number
```

The resident server's own `n_ctx` and the catalog's `serveContext` are reported
side by side and never blended: one is what is running, the other is what the KV
arithmetic was computed for.

### `rosa-local-model-switch:plan <name> [context]` - the command, or the refusal

```
local model switch plan - qwen3.8-27b
  file     D:\Models\qwen3.8-27b\Qwen3.8-27B-UD-Q4_K_M.gguf, 15.3 GiB on disk
  needs    19.8 GiB resident at 16384 tokens - 15.3 GiB weights + 4.0 GiB KV (64 layers, kvDim 1024 from the catalog) + 0.5 GiB runtime
  card     NVIDIA GeForce RTX 3090 - 0.9 GiB free of 24.0 GiB
  verdict  fits when idle - 19.8 GiB does not fit the 0.9 GiB that are free, but it fits the card's whole 24.0 GiB - it needs whatever holds the card now to stop
  server   up at http://127.0.0.1:8080 - serving qwen3.8-27b
  busy     slot 0 is processing - task 248687, 0 tokens decoded, 24576 to go, 83144 prompt tokens

  qwen3.8-27b is already the resident model and it is answering right now. There is nothing to switch to.
  Stopping and restarting it to switch to itself would only throw the loaded weights away.
```

```
local model switch plan - qwen3-coder-30b-a3b
  file     D:\Models\Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated\...i1-Q4_K_S.gguf, 16.3 GiB on disk
  needs    19.8 GiB resident at 32768 tokens - 16.3 GiB weights + 3.0 GiB KV (48 layers, kvDim 512 from the catalog) + 0.5 GiB runtime
  card     NVIDIA GeForce RTX 3090 - 0.9 GiB free of 24.0 GiB
  verdict  fits when idle - 19.8 GiB does not fit the 0.9 GiB that are free, but it fits the card's whole 24.0 GiB - it needs whatever holds the card now to stop
  server   up at http://127.0.0.1:8080 - serving qwen3.8-27b
  busy     slot 0 is processing - task 248838, 707 tokens decoded, 7485 to go, 60464 prompt tokens

  REFUSED - the server is busy processing a request.
  A switch means stopping the resident model mid-answer and losing it, which this plugin will not
  do and nobody should: wait for the slot to go idle, then run the command below.

  command  (copy this; the plugin does not run it)
  D:\llama.cpp\llama-server.exe -m D:\Models\Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated\...i1-Q4_K_S.gguf -c 32768 -ngl 48 --alias qwen3-coder-30b-a3b --host 127.0.0.1 --port 8080 -fa on --parallel 1 --jinja

  nothing was started, stopped or killed. One card, one resident model: whatever holds the GPU now has
  to finish and be stopped by whoever owns it before this command can take effect.
```

A name that matches nothing is never rounded to the nearest model:

```
local model switch plan - no model matches "qwen9-900b"

  closest names:
    qwen3.8-27b (installed: 5 file(s))
    qwen3-32b (in the catalog, not on disk - e.g. Q4_K_M)
    ...

  nothing was guessed: a plan for the wrong model is worse than no plan.
```

And a name that matches two is a question, not a decision:

```
local model switch plan - "ltxv23-uncensored" matches more than one model

  candidates:
    ltxv23_uncensored_v1.4_Q6_K.gguf (in ltxv23-uncensored)
    gemma-3-12b-it-ablit-norms-biproj-Q4_K_M.gguf (in ltxv23-uncensored)

  type more of the name (the folder or the file) so the choice is unambiguous.
```

## The four verdicts, and when each is allowed

| verdict | meaning | needs |
| --- | --- | --- |
| `fits now` | fits the VRAM that is free this second | free VRAM from `nvidia-smi` |
| `fits when idle` | does not fit what is free, fits the card | the card's total VRAM |
| `will not fit` | does not fit the card, so no command is printed | total VRAM; RAM is mentioned only to say that CPU offload is a different decision |
| `unknown` | nobody measured VRAM | nothing - and the plan **refuses** rather than guessing |

`will not fit` never degrades into a partial-offload `-ngl`: suggesting a model
that does not fit by suggesting a smaller GPU layer count is how somebody ends up
with a 27B model at two tokens per second. `unknown` is for a machine whose
`nvidia-smi` did not answer - "does not fit" and "nobody measured" are different
answers and the plugin does not merge them.

## Where every number comes from

| number | source | when it is missing |
| --- | --- | --- |
| VRAM free / total, RAM free, drive | `src/hardware.mjs` `probeHardware()` (nvidia-smi, WMI) | plan refuses; `list` says `?` |
| installed models, quant, params, size | `src/catalog.mjs` `scanLocalModels()` on `modelDirs` | `list` says the folders are empty |
| weights size, layers, kvDim, serveContext, quants | `data/model-catalog.json` via `loadCatalog()` | disk file size is used; KV falls back to the rule of thumb; no param count means no estimate |
| resident model, weights path, quant, `n_ctx`, busy slot | `GET /props`, `GET /v1/models`, `GET /slots` | that line says it could not be read |

The plugin never re-scans the disk itself and never re-implements the hardware
probe: two scanners would eventually disagree, and the disagreement would be
about VRAM, which is the one number that must not be wrong.

## Commands and tools

| what | how |
| --- | --- |
| the shelf + resident model | `node src/cli.mjs --plugin rosa-local-model-switch:list` (or `/local-model-switch list` in the CLI, `/plugin rosa-local-model-switch:list` in a session) |
| what is serving now | `... rosa-local-model-switch:now` |
| plan a switch | `... rosa-local-model-switch:plan qwen3-32b` |
| plan at a chosen context | `... rosa-local-model-switch:plan qwen3-32b 32768` |
| the same plan for a model | tool `local_model_switch_plan({ model, context? })` |

The ported plugin asked for `local-switch:list` and friends. Rosalena registers
commands as `<plugin id>:<command>`, so the ID is `rosa-local-model-switch` and the
commands are `list`, `now`, `plan`. The two names that were asked for map like
this: `local-switch:list` -> `rosa-local-model-switch:list`, `local-switch:now` ->
`rosa-local-model-switch:now`, `local-switch:plan <name>` ->
`rosa-local-model-switch:plan <name>`. A colon inside a command key cannot be
dispatched by the host (`runPluginCommand` splits on `:`), so a command literally
named `local-switch:list` cannot exist; the mapping is the closest honest form.

## Config

`plugins["rosa-local-model-switch"].config` in `harness.config.json` (the manifest's
defaults are these same values):

| key | default | what it does |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8080` | the server to ask; its host and port are also what the printed command uses |
| `serverBinary` | `D:\llama.cpp\llama-server.exe` | the binary the printed command starts |
| `modelDirs` | `["D:\\Models"]` | where the shelf is |
| `planContext` | `16384` | tokens to plan for when the catalog has no `serveContext` for the model |
| `timeoutMs` | `1500` | per-request timeout; a loopback server answers in milliseconds, so 1.5s means wedged, not slow |
| `extraFlags` | `["-fa","on","--parallel","1","--jinja"]` | appended to the printed command, taken from the launcher that works on this box |

The launcher that works on this machine (`start-qwen.ps1`) also passes
`--cache-type-k q8_0 --cache-type-v q8_0`, which halves the KV cache, and the
sampling flags (`--temp 1.0 --top-p 0.95 --top-k 20 --min-p 0.0`), and
`--spec-type draft-mtp` for this model's draft head. None of those are added
automatically: the KV arithmetic assumes f16, so leaving the q8_0 flags out makes
the plan **overestimate** - which is the safe direction for a verdict that says
"does not fit". Add them to `extraFlags` if you want the command to be the exact
one you run.

## Exports (for tests and the UI)

```js
import createLocalSwitch, {
  createLocalSwitch, configOf, probeServer, norm, gib, quoteArg, formatCommand,
  fileMatchesEntry, modelUnits, pickModel, needsFor, fitVerdict, commandFor,
} from "./plugins/rosa-local-model-switch/plugin.mjs";
```

`createLocalSwitch({ fetchImpl, probe, scan, catalog })` exists so the tests can
drive a busy server, a card with no VRAM and a temp folder of GGUFs without a
GPU, a network or a real model. The default export is `createLocalSwitch()`, which
uses the real ones. Everything the plugin sends is a `GET`.

## Tests

`test/plugins-local-model-switch.test.mjs` - real temp directories, an injected
`fetch` that records method and URL, an injected `probe`/`scan`/`catalog`:

- the GET-only rule, asserted on every request the plugin makes;
- a busy slot refuses, and the refusal still carries the command;
- the resident model gets "no switch needed" instead of a command;
- a model bigger than the card gets `will not fit` and **no** command;
- no VRAM means `unknown` and a refusal, never a verdict;
- a file whose name carries no parameter count is estimated as a floor and says so;
- unknown and ambiguous names get candidates and nothing else;
- the printed command's flags, `-ngl` and `-c` come from the catalog, not from a guess;
- `status()` does no I/O (no fetch, no probe) when the plugin is listed.
