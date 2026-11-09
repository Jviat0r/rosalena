# rosa-commit-cadence

Commits small finished pieces itself and saves big ones for one question at the end.

## The problem

Long runs stall on "shall I commit this?". The person answers yes every time, but each
question parks the run until they come back. Leaving it entirely to the model fails the
other way: harnesses that tell the model "only commit when asked" get bug reports about
agents committing anyway. The model's own sense of how big a change is turns out to be the
weak link, and on small local models it is weaker still.

## The design

- **The model says "this piece is done"** by calling `checkpoint`.
- **The harness decides what that means.** It reads the diff from git and puts it in one of three tiers:

| Tier | Signals (any one is enough) | `ask` | `loose` | `autonomous` |
| --- | --- | --- | --- | --- |
| **small** | none of the below | held | **committed** | committed |
| **large** | >300 lines; >12 files; deletes a file that existed before the run; lockfile; migration or schema; CI, deploy or infra config; auth or security paths; git hooks, `.mcp.json`, devcontainer; dependency added or bumped in a manifest; non-image binary; symlink; new executable bit; the person's own uncommitted edits in the same file; run total over 1000 lines or 30 files | held | **held** | committed (flagged in summary) |
| **blocked** | `.env*`, keys, `.npmrc`/`.netrc`/`.envrc`, service-account JSON; an AWS, GitHub, Slack, Stripe, OpenAI/Anthropic or Google key in an added line; a file over 5 MB | stop | stop | stop |

`off` turns the tool into "don't commit, don't ask".

**Held** means:

- The files stay in the working tree, uncommitted.
- The change is queued in `.git/rosalena/commit-cadence.json`, so it can never be committed by accident.
- Later small commits leave those files out.
- If later work touches a held file, that work joins the held change.

**At the end** the model calls `checkpoint {action:"review"}`, then `ask_user` once. Nothing
is approved by the model. The plugin reads the person's reply at the start of the next run
and treats only a clear yes as approval ("Commit them", "yes", "go ahead"). Anything with
"not", "wait", "don't" or similar is a no. Typing `/plugin rosa-commit-cadence:approve` also
approves.

**Never, in any mode:**

- It never pushes, amends, rebases or resets.
- It never bypasses hooks (`--no-verify`).
- It never commits the person's pre-existing uncommitted work without approval.
- It never disturbs what the person staged: commits use `git commit --only -- <paths>`.

Every commit carries a `Rosalena-Checkpoint: auto` trailer, so they can be found and squashed later.

## Doing the big task last

Three layers handle this, from what the model should do to what the harness makes happen:

1. **Planning.** The `rosa-commit-cadence` skill tells the model to mark todo items `[small]` or `[big]`
   and order independent small items first and big items last. skill-autoload loads it at step 1
   for a change request (not a question), so it is in front of the model before the plan is written.
2. **Running.** If a piece turns out big anyway, it is held back and the model is told to "carry on
   with the remaining tasks". The approval question is always last, whatever the plan predicted.
3. **The harness, when the model forgets.** A live run on a local 30B coder (2026-11-03) ignored the
   skill: it did the dependency item first, made every change, and never called `checkpoint`. So:
   - **After a passing check** (a `run_command` like `npm test`, `tsc`, `pytest` that exits 0) with
     uncheckpointed run changes, the next step opens with "Checks just passed ... call checkpoint now".
     Once per set of files.
   - **A mixed checkpoint is split.** In `loose`, a checkpoint holding a risky file (dependency,
     migration, CI, auth, deletion...) and ordinary ones is not held whole: the tool answers with the
     two `files` lists to call it with. A file importing a dependency the checkpoint adds goes with
     the manifest, so no commit is left broken. Asked once per set; the same set again is held whole.
   - **Before finishing**, run changes that were never checkpointed send the answer back once, and
     `review` will not say "nothing is waiting" while they exist.

   The order the model *works* in stops mattering: small pieces are committed and big ones wait
   either way, and the one question still comes at the end.

## Toggling it

```
/plugin rosa-commit-cadence:mode              show the mode for this workspace
/plugin rosa-commit-cadence:mode loose        this workspace
/plugin rosa-commit-cadence:mode loose default every workspace without its own setting
/plugin rosa-commit-cadence:status            mode and what is held back
/plugin rosa-commit-cadence:approve           commit everything held back, now
```

Modes are stored in `~/.rosalena/commit-cadence.json`. In the desktop app the **Commits** menu in
the composer, next to Access, sets the same per-workspace mode (`GET/PUT /api/commit-mode`):
"Ask once at the end" (`ask`), "Small: commit · Big: ask" (`loose`, the set-it-and-leave-it
setting), "Commit everything" (`autonomous`) and "Don't commit" (`off`). It is disabled outside a
git repo, and a dot on its label means work is held back. The default ships as `ask`, which
already turns many questions into one.

## Tests

```bash
node --test test/commit-cadence.test.mjs     # from harness/
```

The suite covers the pure classifier, modes, parsers and approval wording; four runs end to
end through the engine's real `loadPlugins()` against temporary git repos (loose, a "Not now"
reply, a secret in autonomous mode, and off); and the engine's `beforeFinish` round through the
real `runAgent()` with a scripted model (a premature "All done." is sent back once, never twice).

## Engine support (built in since 2026-11-03)

- **`beforeFinish`** (`src/plugins.mjs` HOOK_NAMES, `src/agent.mjs`): a plugin can send a final
  answer back for one more round, once per run. This plugin uses it to make the model review held
  changes before it stops. An engine without it still works; the reminder then comes from the
  tool's replies and the skill.
- **`registerWorkspaceTool`** (`src/permissions.mjs`): `checkpoint` is registered as a workspace
  tool from `setup()`, so Workspace write runs it without asking. Read only and plan mode still
  refuse it.
