# Where these rules come from

`SKILL.md` is original text. No source file is copied into it. The rules it states recur
across the projects below, and it was written after reading them. Licenses were checked
against each repository's LICENSE file on 2026-11-03.

| Source | License | Used for |
| --- | --- | --- |
| [anthropics/skills `frontend-design`](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md) | Apache-2.0 | Plan tokens before code; named "AI default" clusters to avoid; copy rules (verb CTAs, error text) |
| [Anthropic cookbook: prompting for frontend aesthetics](https://github.com/anthropics/claude-cookbooks/blob/main/coding/prompting_for_frontend_aesthetics.ipynb) | MIT | Keep the prompt short; type contrast; CSS variables |
| [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) | MIT | Focus, hit targets, inputs, motion, states, forms |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Apache-2.0 | Surface modes (persuade / operate / read); the refuse list; deterministic detection before judgment |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | MIT | Three-width render gate; headline line count; fix-the-top-3, max-3-rounds loop |
| [ibelick/ui-skills `baseline-ui`](https://github.com/ibelick/ui-skills) | MIT | MUST/NEVER bullet format for small models |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | MIT | Durations, easing, no `scale(0)` |
| [OpenAI cookbook: GPT-5 frontend](https://github.com/openai/openai-cookbook/blob/main/examples/gpt-5/gpt-5_frontend.ipynb) | MIT | 4-5 sizes, one neutral plus accents, 4px spacing, match existing tokens |

Deliberately **not** used:

- **Leaked v0 and Lovable system prompts.** Their provenance and copyright are unclear.
- **bolt.diy's design block.** It asks for gradients, glows and hover-scale everywhere, the patterns the other sources ban.
- **Impeccable's engine binary.** It fetches from the network and has telemetry, which doesn't fit an offline-first app.

If Rosalena ever bundles a source file verbatim (for example Anthropic's `frontend-design`
as an optional "full" skill), ship its LICENSE and NOTICE alongside it.
