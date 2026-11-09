---
name: ship
description: Verify, commit and (only with approval) deploy the change just made in the current repo. Runs tests and build, browser QA at desktop and phone widths, and a scoped commit, then asks before deploying and checks the live URL. Use when the user says "ship this", "commit and deploy" or "push it live" about a change in progress.
---

# Ship the current change

Run these steps in order and stop at the first failure. If you skip a step, say so in the final report.

## 1. Know the project
Before running anything, read the repo's AGENTS.md, CLAUDE.md and README for its test, build and deploy commands. Projects differ (Vercel, Cloudflare Pages, Cloudflare Workers, desktop builds). Use what the project documents, not a guess.

## 2. Tests and build
Run the project's test, typecheck and build scripts (check `package.json` scripts). If one fails, stop and either fix the cause or report it. Never mark a failing step as passed, and never route around a test that enforces an invariant.

## 3. See it working
- Web: start the preview (`run_command` with `background: true`), then check each changed page: `web_fetch` it for the raw HTML, and ask the user to look at it in a browser at desktop and phone widths if you cannot. Check for errors in the server output with `job_output`.
- Desktop app or exe: rebuild it (not just the dev server), launch the build and reproduce the original user action.

## 4. Commit
Run `git status`, then stage only this task's files by name (no `git add -A`, `.`, `-u` or `commit -a`). Commit with a conventional message. List any unrelated pending changes and leave them unstaged.

## 5. Ask before deploying
State exactly what will deploy where: the project, the target (preview or production) and the command, or the fact that the push triggers the deploy. Ask with `ask_user` and wait for a clear yes. Invoking this skill is not permission to deploy.

Once approved, deploy the way the project documents. If a Git integration deploys on push, the push is the deploy, so don't also run a manual deploy. Then load the live URL, check the changed behaviour, and confirm the console is clean.

## 6. Report
- What was verified, with evidence (test output, screenshots)
- The commit SHA
- The live URL, or that nothing was deployed and why
- Anything that was not verified
