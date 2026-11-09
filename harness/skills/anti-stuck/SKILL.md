---
name: anti-stuck
description: 'Loop and hang guard for long-running work. Use when a command waits on something external (builds, servers, network, polling), when any step has failed twice in a row, or when work starts repeating itself (same call, same error, re-reading without acting). Enforces the 2-minute no-progress rule: verify real state, then wait, change approach, skip-with-note, or ask - never repeat an identical failing command a third time.'
---

# Anti-Get-Stuck

Goal: no silent loops, no repeated identical failures, no waiting on a command that can never succeed.

## The 2-minute rule

Stop and run a stuck-check (below) instead of continuing to wait or retry when ANY of these is true:

1. A single command has produced no new output/state for ~2 minutes.
2. The same command (same step, same parameters) has failed 2 times in a row.
3. A polling loop has returned the same state 5+ times (~2 minutes of wall time).

## Stuck-check (do all four, keep it fast)

1. **State** - what actually changed since the last check? Exit code, file mtime, process list, port listening, log tail. If nothing changed, it is stuck by definition.
2. **Cause** - one-line diagnosis: hung process, missing binary on PATH, bad path, missing credential, network black-hole, or a legitimately long operation (electron-builder packaging takes 5-10 min with quiet output).
3. **Decision - pick exactly one:**
   - **WAIT** - normal long operation: run it with `run_command` `background: true` and poll `job_output` with `wait_ms`, or one bounded wait (max ~10 min); state what is being waited for.
   - **FIX** - change the command (different path, flag, or tool). Never re-run the identical command a third time.
   - **SKIP** - step is non-critical: record "skipped, reason" in the state file or report and continue.
   - **ASK** - needs a credential or destructive confirmation: surface to the user and stop there.
4. **Record** - one line: what was stuck, cause, decision. This is what a fresh session (post-compaction) reads to avoid re-entering the loop.

## Loop detection

A loop is work that repeats without changing anything. Check for these before every retry:

1. **Same call, same input.** The same tool with the same arguments for the 3rd time (a re-read of an unchanged file, the same command, the same search).
2. **Same error twice.** The error text is the same as last time, so the last fix did not touch the cause.
3. **Ping-pong.** The state flips back and forth (edit A, revert A; fails on X, fix X, fails on Y, fix Y, fails on X again).
4. **Reading without acting.** 5+ steps of reading, listing or searching since the last change, with the todo list unchanged.
5. **Polling the same answer.** A status check returns identical output 5+ times.

When one fires:

- **Name it** in one line: "Loop: <what repeats>, <since when>."
- **Change exactly one thing** that the loop has not tried yet: a different tool, a narrower path, reading the whole error instead of its first line, or checking an assumption that has never been verified (right folder? right file? right process? is the server you are testing the one you rebuilt?).
- **Second loop on the same problem: stop.** Use ask_user with what you tried, what each attempt showed, and the one question that would unblock you. Do not try a third variation.

The harness has its own guard (it stops a run that repeats an identical call, and nudges a run that only reads), but treat that as the last line, not the plan.

## Environment tripwires (Windows)

- Binaries may not be on PATH in a fresh session (`tailscale`, `gh`): call the full path (`& "C:\Program Files\Tailscale\tailscale.exe" status`) instead of hunting.
- Never scan whole user profiles - no recursive search or `Get-ChildItem -Recurse` over the home folder. Scoped searches only (specific dirs/files). Profile-wide scans hang and get aborted.
- Every network call gets an explicit timeout (`-m`/`--max-time` for curl, `timeoutMs` on run_command).
- Long builds: start them with `background: true` and read them with `job_output` (electron-builder ~10 min). Zero output for 3-5 min is NORMAL, not stuck.
- "Tool execution aborted" = the call hung. Do NOT re-issue it as-is; narrow the scope and retry at most once.
- Before re-running any failing command, diff it against the previous attempt. If identical, the 2-minute rule already fired - use a different approach or skip.

