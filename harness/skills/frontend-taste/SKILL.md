---
name: frontend-taste
description: Default design rules for any UI work - web pages, landing pages, dashboards, components, CSS, Tailwind, restyles. Use whenever you create or change something a person will look at. Plan tokens first, avoid the generic AI look, meet the accessibility floor, then check the result with the ui-check skill.
---

# Frontend taste

You are making the design decisions. Make them on purpose, before writing markup.

## 1. Decide before you code

Write this plan in your reply (5-10 lines), then build to it:

- **Kind of surface:** marketing (persuade), app or dashboard (operate), docs (read). Apps and docs are quiet: color goes on data and the primary action, not decoration.
- **Colors (5-6 named hex values):** background, surface, ink, muted ink, accent, danger. One accent.
- **Type:** 1-2 families with roles (display, body). At most 5 sizes. Body 16-18px.
- **Spacing:** a 4px or 8px scale. Radius: pick one policy (square, small, or pill), not 12px on everything.
- **Layout idea:** one sentence on what makes this page fit its subject, not a template.

If the project already has tokens, a component library, a brand or a CSS file with variables, **use those instead** and say so. Match the codebase; don't invent new values next to existing ones.

## 2. Do not ship the generic AI look

Unless the user or the brand asks for it:

- NEVER purple, indigo or violet gradients. No gradient backgrounds, buttons or text (a dark scrim on a photo is fine).
- NEVER small ALL-CAPS tracked labels above headings ("eyebrows"), or a "New ·" pill above the hero.
- NEVER one highlighted word in a headline (colored, italic or gradient span).
- NEVER a row of identical icon + title + text cards as the page's main structure. Never cards inside cards.
- NEVER 01 / 02 / 03 numbering unless the content really is a sequence.
- NEVER emoji as icons. One icon set, one stroke width.
- NEVER glassmorphism blur, glow shadows, hard offset shadows, or a thick colored left border on cards.
- NEVER lorem ipsum, fake testimonials, fake logos or made-up stats. Use real or plausible content.
- Don't center everything: left-align by default, center at most one moment.
- Avoid defaulting to Inter/Roboto/Arial for marketing pages. For apps, `system-ui` is fine. Only use web fonts the project can load (self-hosted or already linked).

## 3. Type and spacing

- Body line-height 1.45-1.6, line length 45-75 characters (`max-width: 65ch`).
- Headlines: at most 2 lines at phone width, tight leading (1.0-1.15), `text-wrap: balance`.
- Big contrast between display and body sizes; keep weights clearly different (e.g. 400 vs 700).
- More space above a heading than below it. Gaps inside a group are smaller than gaps between groups.
- `font-variant-numeric: tabular-nums` for numbers in tables and stats.
- Colors and sizes as CSS variables (or the project's tokens). Dark mode redefines the variables and sets `color-scheme: dark`.

## 4. The floor (never below this)

- Text contrast at least 4.5:1 (3:1 for large text and icons), placeholders included. Body text in full ink, not light gray.
- Every interactive element has a visible `:focus-visible` style. Use `<button>` for actions, `<a>` for navigation, a `<label>` for every input, `aria-label` on icon-only buttons, one `<h1>`.
- Touch targets at least 44px on mobile. Inputs at least 16px font on mobile. Never disable zoom.
- Works at 390px, 768px and 1440px wide: no horizontal scroll, nothing clipped. Use `dvh`, not `vh`, for full-height sections.
- Images have `width`/`height` (or `aspect-ratio`) and `alt`.
- Don't use color alone to show state; add text or an icon.

## 5. States and copy

- Every list or data view has: loading (a skeleton shaped like the result), empty (one sentence + one clear action), error (what happened and what to do; no apologies), and long content (long names, many items).
- Buttons say what they do: "Save changes", not "Submit". Keep the same verb through the flow (Publish, then "Published").
- Destructive actions get a confirm step or an Undo.
- Sentence case for buttons and headings.

## 6. Motion

- No motion unless it helps. One deliberate moment beats fading in every section.
- Animate only `transform` and `opacity`. Never `transition: all`.
- 120-250ms for UI feedback, ease-out for things appearing. Never animate from `scale(0)`; use `scale(0.95)` with opacity.
- Always add `@media (prefers-reduced-motion: reduce)` that turns the motion off.

## 7. Check it

When the page runs, use the **ui-check** skill: it renders the page at three widths and reports contrast, overflow, fonts and focus problems as PASS/WARN/FAIL. Fix every FAIL. Then, if you can see images, look at the screenshots and fix the three things that look most off. At most three rounds.

---
Rules distilled from public guidance, rewritten for small models: Anthropic `frontend-design` skill (Apache-2.0), Anthropic cookbook frontend-aesthetics prompt (MIT), Vercel Web Interface Guidelines (MIT), Impeccable (Apache-2.0), Taste Skill (MIT), ibelick ui-skills (MIT), Emil Kowalski skills (MIT), OpenAI GPT-5 frontend cookbook (MIT). See `SOURCES.md`.
