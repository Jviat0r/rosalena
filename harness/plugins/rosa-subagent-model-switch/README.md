# rosa-subagent-model-switch

Which model a worker of each role starts on, and the one file that decides it.

The command names here are `/subagent-model-switch show|set|reset`: Rosalena registers a
bundle's commands as `<plugin id>:<command>`, so a command name of its own cannot contain
a colon.

## What it is a port of, and where it could not be one

A sidebar version of this (DeepSeek Harness had one) opened a panel, listed the subagents running
in the session and swapped one subagent's route through that agent's own request
waterfall. Rosalena has no per-subagent request waterfall to hook: a worker's class is
chosen when it is spawned, and the harness turns a role into a model through
`data/roles.json` - the presets that also carry the role's title, its prompt addendum,
the target its workers start on and whether it may judge.

So the same intent - *change the model this kind of worker runs on* - is expressed
against the file the harness actually reads, and this plugin's job is to make that edit
safe: it validates the role, validates the target against the router, writes atomically,
and prints the previous value so the change can be undone.

## The rule this plugin exists under

> A preset that names a model the router does not have fails at request time, inside a
> run, and looks like a network problem. So nothing is written until the target is
> proven to exist.

Four consequences, each of which is a refusal in the code:

- **A role that is not in the file is refused.** This edits presets that exist; a role
  no run names would be a preset nobody reads. The refusal lists the roles it does have.
- **A target the router does not define is refused.** Legal: a router class
  (`orchestrate`, `code`, `fast`, `judge` - a failover chain, resolved at request time)
  or a curated `provider/model` from `router/router.config.json` `models[]`. `class:code`
  is accepted as an alias and stored as `code`.
- **A file that does not parse is refused, never replaced.** A half-broken file is
  reported as broken and left exactly as it is; `show` prints the shipped presets
  alongside it so the operator can see what is missing.
- **Every write is a temp file beside the target, then a rename.** A crash mid-write
  leaves the old presets intact rather than half of the new ones.

An unreadable `effort` level is the one problem that does **not** make the file
unreadable: the harness never reads that key, so the presets still list, and only the
write that would carry the value forward is refused. See "The effort level" below.

## Commands

| Command | What it does |
| --- | --- |
| `subagent-model-switch show` | The file it will read, the presets table (including each role's effort level), each role's addendum, and any target or effort value that cannot be used. |
| `subagent-model-switch set <role> <target>` | Points that role's **workers** at a router class or a curated `provider/model`, writes the file, prints the previous value. |
| `subagent-model-switch reset <role>` | Restores that role's shipped preset (title, addendum, subagent, judge) - which also clears any effort level, because the shipped preset carries none. Refused for a role the plugin does not ship. |

`set` writes `subagent` - the target a *delegated worker* of that role starts on. The
role's own route is its id (a router class); the composer's model dropdown overrides
that for one run and is not this plugin's business.

From the CLI:

```
node src\cli.mjs --plugin rosa-subagent-model-switch:show
node src\cli.mjs --plugin rosa-subagent-model-switch:set code google/gemini-2.5-flash
node src\cli.mjs --plugin rosa-subagent-model-switch:reset code
```

Interactive: `/subagent-model-switch show`, or `--plugin rosa-subagent-model-switch:show`.

## Tools

The model gets two, so it can answer "which model do my code workers run on" and can
make the change when it is asked to:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `subagent_model_show` | none | The same report as `show`. |
| `subagent_model_set` | `role`, `target` | The result of a `set`, including the refusal text when the target is not real. |

## What a real run prints

The file as it ships on this machine, `data/roles.json` beside the harness root:

```json
{
  "roles": {
    "orchestrate": {
      "title": "Orchestrator",
      "addendum": "Split the request into steps before touching anything, and say which file each step changes. ...",
      "subagent": "code",
      "judge": false
    },
    "code": { "title": "Code", "addendum": "Make the smallest change that satisfies the request ...", "subagent": "code", "judge": false },
    "fast": { "title": "Fast", "addendum": "Answer in at most one short paragraph ...", "subagent": "fast", "judge": false },
    "judge": { "title": "Judge", "addendum": "Judge only what is in front of you ...", "subagent": "code", "judge": true }
  }
}
```

`show`, run against this machine:

```
subagent models - D:\AppDev\Rosalena Harness\data\roles.json
  source   the harness root
  router   D:\AppDev\Rosalena Harness\router\router.config.json

  role         title         subagent  judge  effort
  orchestrate  Orchestrator  code      -      -
  code         Code          code      -      -
  fast         Fast          fast      -      -
  judge        Judge         code      yes    -

  effort   preferred reasoning effort: low | medium | high; "-" means the role has no opinion

  addenda - the paragraph each role adds to its prompt:
    orchestrate  Split the request into steps before touching anything, and say which file each step changes. Do a step yourself only when it is a single edit; hand every multi-step or repetitive job to a worker with an explicit brief, then check the result against the plan instead of trusting its summary. When two steps disagree, or the choice is the user's to make, stop and ask rather than choosing for them.
    code         Make the smallest change that satisfies the request and keep the file's existing style, even where you would write it differently. Before reporting, run the test or command that proves the change and paste its real output; if you could not run it, say which check is missing instead of implying it passed. Never widen a fix to code the request did not name.
    fast         Answer in at most one short paragraph, with no preamble, no restatement of the question and no closing summary. Prefer a direct answer or one command over an explanation, and say plainly when you do not know instead of hedging. Do not start tool work unless the request needs it.
    judge        Judge only what is in front of you: quote the command output, test result or line of code that settles each claim before accepting it. Separate what you verified from what you took on trust, and refuse - naming the missing evidence - rather than approving work you did not see run.

  set <role> <target>   what this role's workers start on (writes the file)
  reset <role>          restores that role's shipped preset
  the role id is the router class it routes through; the composer's model dropdown overrides it
```

A `set`, then the same role put back:

```
set code.subagent -> google/gemini-2.5-flash
  file     D:\AppDev\Rosalena Harness\data\roles.json (2518 bytes, temp file then rename)
  previous code
  role     title "Code", judge no

  takes effect the next time the harness reads its roles: a run that is already going keeps the model it started on.

reset code
  file     D:\AppDev\Rosalena Harness\data\roles.json (2499 bytes, temp file then rename)
  previous google/gemini-2.5-flash -> code
  restored title "Code", subagent code, addendum and judge flag
```

A target the router does not curate - the case this plugin exists for:

```
REFUSED - "nope/nope" looks like a provider/model target, but the router does not curate it

  add it to router/router.config.json models[] first, or pick one of these

  classes the router defines (failover chains):
    orchestrate  ->  local/qwen3.8-27b -> opencode-free/deepseek-v4.1-flash-free -> anthropic/claude-sonnet-4-5 -> openrouter/anthropic/claude-sonnet-4.5
    code  ->  local/qwen3.8-27b -> opencode-free/deepseek-v4.1-flash-free -> anthropic/claude-sonnet-4-5 -> openai/gpt-5.1 -> openrouter/deepseek/deepseek-chat
    fast  ->  local/qwen3.8-27b -> opencode-free/glm-5.3-flash-free -> google/gemini-2.5-flash -> openai/gpt-5-mini
    judge  ->  anthropic/claude-sonnet-4-5 -> local/qwen3.8-27b -> opencode-free/glm-5.3-flash-free
  curated targets (router/router.config.json models[]):
    local/qwen3.8-27b
    opencode-free/deepseek-v4.1-flash-free
    opencode-free/glm-5.3-flash-free
    anthropic/claude-sonnet-4-5
    openai/gpt-5.1
    google/gemini-2.5-flash

  nothing was written. D:\AppDev\Rosalena Harness\data\roles.json is unchanged.
```

And a role the file does not have:

```
REFUSED - there is no role "nope".

  roles in D:\AppDev\Rosalena Harness\data\roles.json: orchestrate, code, fast, judge
  classes the router defines: orchestrate, code, fast, judge

  This edits a preset that exists; a role no run names would be a preset nobody reads.
  To add one, copy an entry in the file by hand - `title` and `addendum` are the parts
  the harness cannot guess.
```

## The file, and why it is safe to edit by hand

`data/roles.json` next to the harness root - the same file `src/models.mjs`
`readRoles(root)` reads. This plugin resolves it in that order and writes to the file it
resolved, so a change made here is a change the next run sees:

1. `config.rolesFile`, when set in `harness.config.json` `plugins["rosa-subagent-model-switch"].config`
2. `<root>/data/roles.json`
3. `<root>/../data/roles.json`
4. `<root>/data/roles.json`, created on the first write

Each entry is:

| Key | Meaning |
| --- | --- |
| `title` | What the role is called in the picker. `label` and `name` are read as aliases; this plugin writes `title`. |
| `addendum` | The paragraph appended to that role's system prompt. This is the substance of the role. |
| `subagent` | The target that role's delegated workers start on. Omit it to use the harness default class. |
| `judge` | `true` turns the review pass on for that role. |
| `effort` | Optional: `"low"`, `"medium"` or `"high"`. Absent or `null` means the role has no opinion, which is why none of the shipped presets carries it. |

The role id is the router class the role routes through, so `orchestrate`/`code`/`fast`/
`judge` resolve the moment the file exists. Extra keys are preserved: this plugin edits
`subagent`, writes back the rest of the object untouched, and never drops a key it does
not understand - `effort` included.

## The effort level

`effort` is a preference a submenu can offer, not a route: the harness reader
(`src/models.mjs`) ignores it, this plugin never sends it in a request, and nothing here
invents per-model capability data. What this plugin does is keep the value honest:

- **Three levels, or nothing.** `"low"`, `"medium"`, `"high"`, trimmed. Anything else -
  `"max"`, `"HIGH"`, a number, a boolean, `""` - is refused by name, with the legal
  values in the message.
- **A bad level does not break the file.** The presets still list, `status` still works,
  and the value is shown in the table exactly as the file has it, so the mistake is
  visible instead of silently dropped.
- **A write refuses to carry it forward.** `set` will not rewrite a file whose effort
  level the submenu cannot read, because that would keep a preference that does nothing.
  `reset <role>` is the repair: it restores the shipped preset, which has no effort key.

Real output, with two roles carrying an effort level (a temporary root, as in the tests):

```
  role         title         subagent  judge  effort
  orchestrate  Orchestrator  code      -      -
  code         Code          code      -      high
  fast         Fast          fast      -      -
  judge        Judge         code      yes    low

  effort   preferred reasoning effort: low | medium | high; "-" means the role has no opinion
```

`set` keeps a value it does not own, and prints it:

```
set code.subagent -> fast
  file     ...\data\roles.json (1848 bytes, temp file then rename)
  previous code
  role     title "Code", judge no, effort high
  chain    local/qwen3.8-27b
```

A level that is not one of the three, as `show` reports it:

```
  role         title         subagent  judge  effort
  code         Code          code      -      high
  fast         Fast          fast      -      max

  effort levels this file asks for that are not low | medium | high:
    roles.fast.effort is "max" - use "low", "medium", "high", or remove the key for no opinion
  The composer's effort submenu cannot read those, and this plugin will not rewrite the file
  until one of the three level names is there - or the key is gone.
```

And the write that would carry it forward, refused:

```
REFUSED - refusing to write a file the composer cannot read: roles.fast.effort is "max" - use "low", "medium", "high", or remove the key for no opinion - set one of the three levels, remove the key, or run `reset <role>` to restore the shipped preset
```

## Config

`harness.config.json`:

```json
{ "plugins": { "rosa-subagent-model-switch": { "config": { "rolesFile": null, "routerFile": null } } } }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `rolesFile` | `null` | Absolute or root-relative path. `null` uses the resolution order above. |
| `routerFile` | `null` | Absolute or root-relative path to `router.config.json`. `null` tries `<root>/router`, `<root>/../router`, then the copy beside the harness. |

`enabled: false` disables the plugin, which leaves the file editable by hand with no
validation at all - the plugin is the only thing standing between a typo and a run that
fails halfway.

## Exports

`plugin.mjs` exports the plugin as its default, and these for the tests:

`ROLE_KEYS`, `EFFORT_LEVELS`, `DEFAULT_ROLES`, `defaultRoles()`, `isPlainObject()`,
`checkRole()`, `checkEffort()`, `checkDoc()`, `parseRoles()`, `resolveRolesFile()`,
`resolveRouterFile()`, `routerFacts()`, `targetCheck()`, `rolesReport()`, `formatShow()`,
`writeRolesFile()`, `createSubagentSwitch(deps)`.

`createSubagentSwitch` takes `{ readFile, exists, writeFile, rename, mkdir, unlink, harnessDir }`
so a test can drive a temporary root - and prove that a write under a temporary root
never lands in the real presets.

## Tests

`harness/test/plugins-subagent-model-switch.test.mjs` - 37 tests, all passing:

- `show` reports the presets, the addenda, and the file it resolved
- `set` writes the temp root, keeps unknown keys, prints the previous value, leaves no `.tmp`
- `set` refuses an unknown role, an empty target, a class the router does not define, and an uncurated `provider/model`
- `set` accepts a bare class name and `class:<name>`, storing the bare name
- `reset` restores a shipped preset and refuses a hand-added role
- a corrupt file is reported, refused for writing, and left byte-identical
- `effort` is optional: the shipped presets carry none, and a file without the key keeps working
- `checkEffort` accepts the three levels, `null` and absent, and refuses the rest by name
- a bad effort is reported separately, so the file still parses, lists and can be repaired
- `show` prints the level each role asks for, and flags one the submenu cannot read
- `set` preserves an effort it does not own; it refuses to write a file carrying a bad one
- `reset` clears a bad level, because the shipped preset has no effort key
- the shipped `data/roles.json` is read by the reader that ships (`src/models.mjs`
  `readRoles` + `rolesFromRouter`): four roles, their titles, subagents, judge flag and
  addenda - the module boundary the rest of this file cannot see
- an effort level, legal or illegal, changes nothing that reader returns, so a hand-edited
  level can never take the role menu down
- a write under a temporary root does not touch `data/roles.json` beside the harness
- `status()` is file-only and reports the worker target

No network, no router process, no model call: every test drives a temporary directory.
