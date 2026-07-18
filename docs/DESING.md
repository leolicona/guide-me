# Design System — RETIRED (see below)

> ⚠️ **This file is retired.** It previously held the **"Luminous SaaS"** indigo token export
> (Electric Violet `#5850EC` primary, soft ambient shadows, glassmorphism). That system has been
> **replaced** by **"Elegant Field Minimalism"** — a teal-accented, structure-first design system
> tuned for outdoor, one-handed field use.

## Canonical sources

| What | Where |
|---|---|
| **Design tokens** (colors, type, spacing, radius, elevation, motion — AA-verified, + deferred dark mode) | `.design/design-system/DESIGN_TOKENS.md` |
| **Implementation** | `app-turistear/src/config/theme.ts` + `app-turistear/src/styles/tokens.css` |
| **Shared primitives** | `app-turistear/src/components/` (`MoneyText`, `SectionCard`, `StatusChip`, `AlertCard`, `BottomSheet`, `WizardShell`) |
| **Philosophy / rationale** | `.design/design-system/DESIGN_BRIEF.md` |
| **Quick reference** | `CLAUDE.md` → "Design System — Elegant Field Minimalism" |

## What changed (old → new)

| Concern | Luminous SaaS (old, this file) | Elegant Field Minimalism (new) |
|---|---|---|
| Primary | Electric Violet / Indigo `#5850EC` | **Teal `#0F766E`** (reserved for action/active only) |
| Ink / body | `#111827` / `#6B7280` | `#0F172A` / `#475569` |
| Background | `#F9FAFB` | `#F8FAFC` |
| Success / Error | `#1E9E6A` / `#BA1A1A` | `#15803D` / `#B91C1C` + amber warning `#B45309` |
| Elevation | tonal layering + ambient shadows everywhere; **glassmorphism** on overlays | **structure-first**: hairline borders; real shadow only on overlays; **no glass** |
| Money | inline, sometimes accent-colored | **`MoneyText` — reads first, semantic color, never teal** |
| Type | Manrope | Manrope (kept) + explicit numeric/tabular treatment |

Older code comments that reference "DESING.md § …" point here; follow the canonical sources above.
