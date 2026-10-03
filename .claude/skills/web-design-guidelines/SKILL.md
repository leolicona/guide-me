---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
  overlay: devolada - reads the vendored guidelines.md instead of fetching at runtime, and defers to the constitution and the executable gates. This SKILL.md is NOT upstream's; re-vendoring must not overwrite it (see .claude/skills/skills.lock.json, source vercel).
---

# Web Interface Guidelines

Review files for compliance with Vercel's Web Interface Guidelines.

## How It Works

1. Read the guidelines from `guidelines.md` in this skill folder (a vendored copy of
   https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md,
   refreshed by hand — this project vendors skills manually; the sync date is in
   `.claude/skills/skills.lock.json` under source `vercel`).
2. If the vendored copy is older than 90 days and network access is available, also fetch
   the URL above and prefer the fresher rules; otherwise use the vendored copy silently.
3. Read the specified files (or prompt the user for files or a pattern).
4. Check against every rule in the guidelines, with the project rules below applied.
5. Output findings in the terse `file:line` format the guidelines specify.

## Project context (devolada)

**Constitution first.** Principle VI (Visual Foundations, NON-NEGOTIABLE) already fixes
WCAG 2.2 AA, 48 px touch targets (64 px for the decisive action), 16 px body text, a dark
mode that is its own palette rather than an inversion, honoured `prefers-reduced-motion`,
and tokens-only styling — no raw colour, size or spacing values in components. Report a
guideline finding that overlaps one of those as a **constitution violation** (higher
priority), naming the principle.

**Do not re-derive what a gate already measures.** These run in CI and are the source of
truth for their question; if the finding belongs to one of them, say which gate should have
caught it instead of arguing the pixel:

| Question | Gate |
| --- | --- |
| Palette contrast, light and dark | `scripts/contrast-lint.mjs` (reads `packages/ui/src/styles/tokens.css`) |
| Real rendered contrast and target size | `tests/e2e/contrast.spec.ts` (axe in a browser, both themes) |
| Tab order and a *measured* visible focus indicator | `tests/e2e/keyboard.spec.ts` |
| Touch targets, horizontal scroll at 360/768/1280 | `tests/e2e/responsive.spec.ts` |
| Markup a11y per screen (labels, roles, names) | `apps/admin/test/a11y.ts` (axe; contrast and target-size disabled there on purpose) |

**Two deliberate departures from the guidelines — never flag them:**

- **Content & Copy.** Product copy is es-MX and uses sentence case ("Cerrar sesión", "Ya
  hice mi transferencia"). Chicago Title Case, second person and the English active-voice
  examples are English conventions and do not apply. What *does* still apply: an error
  message names the fix, a button label is specific, and numerals are numerals. The
  customer's page says "pago", never "cobro".
- **`outline: none` in the base stylesheet.** `packages/ui/src/styles/index.css` removes the
  outline on `:focus-visible` and replaces it with `--shadow-focus`. That is the required
  replacement, not the anti-pattern.

**Where the rules bite hardest here:** the payment page (`apps/pago`) is a public,
phone-first screen where a customer proofreads a CLABE and an amount against their bank app
— long-content handling, copy buttons with accessible names, `inputmode`, never blocking
paste, and empty/edge states matter more there than anywhere else in the tree.

## Usage

When a user provides a file or pattern argument:
1. Read `guidelines.md`
2. Read the specified files
3. Apply all rules, with the project context above
4. Output findings using the format specified in the guidelines

If no files are specified, ask the user which files to review.
