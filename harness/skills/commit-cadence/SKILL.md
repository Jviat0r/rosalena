---
name: commit-cadence
description: How to order and commit work on a long task so the user is asked at most once, at the end. Use on any multi-step change in a git repo, and whenever the checkpoint tool is available. Plan small independent pieces first and predicted-big pieces last, commit each finished piece with checkpoint, and never ask "should I commit?" mid-task.
---

# Commit cadence for long tasks

The user wants to start the task and come back when it is finished. Every question in the
middle stops the run until they return. So:

- **Never ask whether to commit.** Never run `git commit` yourself. Call `checkpoint`; the harness reads the diff and decides.
- **Never push, amend, rebase, reset or force anything** unless the user asked in this chat.

## 1. Plan the order before you start

When you write the task list, mark each item `[small]` or `[big]`. An item is `[big]` if it is likely to:

- change more than ~300 lines or more than ~12 files
- add, remove or upgrade a dependency (package.json, lockfiles, requirements)
- add a database migration or change a schema
- change CI, deploy, Docker or infrastructure files
- touch auth, permissions or security code
- delete files, or rename/move many files

Then **order the list: independent `[small]` items first, `[big]` items last.** A `[big]` item that
other items depend on goes as late as possible, but before the items that need it.

Example:

```
[ ] [small] fix the nav menu not closing on route change
[ ] [small] add empty state to the projects list
[ ] [small] tighten spacing on the settings page
[ ] [big]   move auth to the new session library (dependency + auth code)
```

## 2. Work one item at a time

For each item: make the change, run the project's checks (tests, typecheck, build or the page
itself), then call:

```
checkpoint { "message": "fix(nav): close the menu on route change" }
```

Use a conventional commit message that says what changed and why, in under 72 characters.
Only call `checkpoint` when that piece works. Broken work does not get committed.

What the answer means:

| checkpoint says | do this |
| --- | --- |
| `committed <sha>` | Next item. |
| `HELD BACK for approval` | Leave those files alone. Go on with the remaining items. Don't ask. |
| `these files belong to a change that is already held back` | Fine: the work joins that change. Next item. |
| `NOT COMMITTED - this needs the user` | Stop. Tell the user which file and why (usually a secret). Don't delete or move the value. |
| `commits are turned off` | Don't commit and don't ask about commits at all. |
| `not a git repository` | Carry on without commits. Don't `git init` unless asked. |

## 3. Finish with one question, at most

When every item is done:

1. Call `checkpoint { "action": "review" }`.
2. If anything was held back, call `ask_user` **once** with a short summary and the options
   `["Commit them", "Not now"]`.
3. If nothing was held back, give your final answer. No question.

Your final answer lists: the commits made (sha + message), anything held back and why, and what
was verified.
