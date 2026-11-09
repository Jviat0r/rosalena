# Bench summary 2026-11-04: Claude Code next to Rosalena

The same 8 tasks and hidden tests as `summary-2026-11-04.md`, one run each, 6 min per task.
This is NOT one model in two harnesses: Claude Code runs Anthropic's Opus 5.5 in the cloud on
the owner's Max login; Rosalena and OpenCode run the free Qwen3-Coder 30B-A3B (Q4_K_S) on one
RTX 3090. It answers "what would I actually use", not "which harness is better on one model".

| Harness and model | Passed | Median time | Cost |
|---|---|---|---|
| Claude Code 2.1.309, Opus 5.5 (cloud) | **8 / 8** | **34 s** | ~$0.29 a task at list price (est. by Claude Code; a subscription is not billed per task) |
| Rosalena, Qwen3-Coder 30B (this PC) | **8 / 8** | 67 s | $0 (local) |
| OpenCode 2.0.32, Qwen3-Coder 30B (this PC) | 6 / 8 | 101 s | $0 (local) |

| Task | Claude Code (Opus 5.5) | Rosalena (local) | OpenCode (local) |
|---|---|---|---|
| fix-off-by-one | pass 19 s, 6 turns | pass 63 s | pass 361 s (time limit) |
| add-slugify | pass 21 s, 5 turns | pass 74 s | pass 360 s (time limit) |
| rename-across-files | pass 52 s, 12 turns | pass 85 s | pass 58 s |
| missing-await | pass 19 s, 4 turns | pass 67 s | pass 39 s |
| cli-flag | pass 39 s, 4 turns | pass 58 s | pass 26 s |
| extract-validator | pass 69 s, 10 turns | pass 105 s | pass 68 s |
| csv-to-json | pass 32 s, 9 turns | pass 45 s | fail 233 s |
| write-tests | pass 35 s, 6 turns | pass 67 s | fail 134 s |

Notes
- Claude Code's own API time was 6-36 s per task; the rest of each run (up to ~30 s on cli-flag)
  is outside the model: starting Claude Code, loading the owner's CLAUDE.md files and running
  his hooks on every Bash call. That is Claude Code as he uses it, so it is counted.
- Claude Code ran with edits accepted, only `node`/`npm` commands allowed, no MCP servers, and
  ANTHROPIC_* removed from its environment so it used the claude.ai login.
- Rosalena's times are from before the 2026-11-04 hook speedup (process-tracker, vpn probe,
  commit-cadence), which took ~7-11 s off the start of every run; a rerun on 0.1.7 should be faster.

Run files: Claude Code `run-2026-11-04T08-39-06-284Z` (fix-off-by-one) and
`run-2026-11-04T08-39-34-582Z` (the other 7); Rosalena and OpenCode as listed in
`summary-2026-11-04.md`.
