---
name: ui-check
description: Check a web page the way a person would see it - renders it at phone, tablet and desktop widths and reports overflow, text contrast, missing labels and focus styles, font sprawl and generic-AI design tells as PASS/WARN/FAIL, plus screenshots. Use after building or changing any UI, before saying it is done. Works for models that cannot see images.
---

# UI check

A page is not done because it compiles. Check what it looks like.

## 1. Run the page

Start the dev server in the background (`run_command` with `background: true`) and read its
URL from `job_output`. A plain `.html` file can be checked directly, no server needed.

## 2. Audit it

The script is in this skill's `scripts` folder (the `skill` tool prints the folder). The first
time, run `npm install` in that folder. It uses Chrome or Edge from the machine, nothing to download.

```
node <skill folder>/scripts/ui-audit.mjs http://localhost:5173/
node <skill folder>/scripts/ui-audit.mjs http://localhost:5173/pricing --widths 390,1440
node <skill folder>/scripts/ui-audit.mjs site/index.html
```

Every line is `PASS|WARN|FAIL area finding | how to fix`. The screenshots land in
`.rosalena/ui-check/ui-<width>.png`. Keep that folder out of commits.

## 3. Fix, in this order

1. **Every FAIL.** Overflow, contrast, missing labels, invisible focus and console errors are bugs.
2. **WARNs**, unless you can say in one line why the design needs it (e.g. "the brand gradient is in the logo guidelines").
3. Re-run the audit. Stop when there are no FAILs. **At most 3 rounds**; if a FAIL survives three
   rounds, say which and why in your final answer instead of looping.

## 4. Look (only if you can see images)

Open the narrowest and widest screenshots with `read_image`. Name the three things that look
most off (alignment, spacing rhythm, a heading that wraps badly, an empty stretch, something
that looks like a template) and fix those. If you cannot see images, skip this step and say the
check was measurement-only.

## 5. Report

In the final answer: the last audit's FAIL/WARN counts, what you fixed, any WARN you kept and
why, and the screenshot paths so the user can look.
