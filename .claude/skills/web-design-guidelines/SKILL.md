---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
  overlay: guide-me (adapted from leolicona/devolada's) - reads the vendored guidelines.md instead of fetching at runtime, and defers to the design system, the constitution and the executable gates. This SKILL.md is NOT upstream's; re-vendoring must not overwrite it (see .claude/skills/skills.lock.json, source vercel).
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

## Project context (guide-me)

**The design system first.** *Elegant Field Minimalism*: its authority is
`.design/design-system/DESIGN_TOKENS.md` (in the archive `leolicona/guide-me-docs`, same path),
implemented only in `app-turistear/src/config/theme.ts` and `app-turistear/src/styles/tokens.css`,
summarised in `CLAUDE.md` § Design System. It already fixes AA contrast (verified per token),
touch targets ≥ 48 px, a 16 px Manrope base, one teal accent reserved for the primary CTA, active
nav and selection (never state), functional colour always paired with an icon, and tokens-only
styling on MUI v9. Report a guideline finding that overlaps one of those as a **design-system
violation** (higher priority), citing the token section. Once `.specify/memory/constitution.md` is
written, it outranks this paragraph.

**Do not re-derive what a gate already measures.** If the finding belongs to one of these, say
which should have caught it instead of arguing the pixel:

| Question | Gate |
| --- | --- |
| Markup a11y per component (labels, roles, names) | `expectNoA11yViolations` in `app-turistear/src/test/axe.ts` (axe inside component tests) |
| Palette contrast | `DESIGN_TOKENS.md`, verified per token — `color-contrast` is disabled in the axe gate on purpose, because jsdom resolves no layout |
| Critical flows in a real browser | Playwright, `app-turistear/e2e/` |

**Two deliberate departures from the guidelines — never flag them:**

- **Content & Copy.** Product copy is Spanish (Mexico) in sentence case ("Guardar cambios",
  "Iniciar sesión"). Title Case, second person and the English active-voice examples are English
  conventions and do not apply. What *does* still apply: an error message names the fix, a button
  label is specific, and numerals are numerals.
- **Light only.** Dark mode is defined in `DESIGN_TOKENS.md` §10 but deliberately not built; a
  missing dark theme is not a finding.

**Where the rules bite hardest here:** the field surfaces — the POS, the cash drawer (*caja*) and
the QR scanner — are used outdoors, one-handed, with cash in hand. Legibility in sunlight, target
size and reach, and money that reads first (`MoneyText`, tabular figures) matter more there than
anywhere else in the tree.

## Usage

When a user provides a file or pattern argument:
1. Read `guidelines.md`
2. Read the specified files
3. Apply all rules, with the project context above
4. Output findings using the format specified in the guidelines

If no files are specified, ask the user which files to review.
