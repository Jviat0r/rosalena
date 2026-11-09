# Bench 2026-11-04T06-17-46-099Z

Model: Huihui-Qwen3-Coder-30B-A3B-Instruct-abliterated on llama.cpp (one RTX 3090), 6 min per task, every run counted.

| Harness | Passed | Median time |
|---|---|---|
| opencode | 0 / 8 | 1 s |

| Task | opencode |
|---|---|
| fix-off-by-one | fail 11s |
| add-slugify | fail 1s |
| rename-across-files | fail 1s |
| missing-await | fail 1s |
| cli-flag | fail 1s |
| extract-validator | fail 1s |
| csv-to-json | fail 1s |
| write-tests | fail 2s |
