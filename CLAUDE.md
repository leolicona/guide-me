# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`guide-me` is a monorepo containing:
- A Cloudflare Worker API (`api-guideme/`) built with Hono and served via Vite SSR.
- A React application as a Chrome Extension (`app-guideme/`) built with React 18, TypeScript, Vite with CRXJS, and TailwindCSS.

The project uses `pnpm` workspaces. Commands can be run from the root.

## Commands

### Workspace-level (Run from root)

```bash
pnpm dev:api       # Start local dev server for API
pnpm dev:app       # Start local dev server for App
pnpm dev           # Start both dev servers in parallel
pnpm build:api     # Build API for production
pnpm build:app     # Build App for production
pnpm deploy:api    # Deploy API to Cloudflare Workers
pnpm deploy:app    # Deploy App to Cloudflare Workers
pnpm cf-typegen:api # Regenerate CloudflareBindings for API
pnpm cf-typegen:app # Regenerate CloudflareBindings for App
pnpm lint:app      # Run linting for App
```

## Architecture

The Worker entry point is `src/index.tsx` — `.tsx` because Hono uses its own JSX runtime (`hono/jsx`, not React). The `jsxImportSource` in `tsconfig.json` is set to `hono/jsx`.

**Rendering pipeline**: `renderer.tsx` wraps every response in an HTML shell using `jsxRenderer` from Hono. `ViteClient` and `Link` from `vite-ssr-components/hono` inject HMR and CSS in dev; in production they resolve to static assets.

**Cloudflare bindings**: Run `pnpm cf-typegen` after modifying `wrangler.jsonc` to keep the `CloudflareBindings` interface in sync. Pass it as a generic when instantiating Hono:
```ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

## Backend Folder Structure Rules (from `project_rules.md`)

When expanding into a RESTful API, organize by resource under `src/routes/<resource>/`:

| File | Purpose |
|---|---|
| `index.ts` | Hono router — maps HTTP methods to handlers |
| `handler.ts` | Business logic (e.g., `auth.handler.ts`) |
| `schema.ts` | Zod validation schemas (e.g., `auth.schema.ts`) |

Additional directories:
- `src/middleware/` — reusable Hono middleware (auth, logger, error handler)
- `src/utils/` — utilities like `jwt.ts`, `db.ts`
- `src/types/` — TypeScript interfaces for data models
- `src/bindings.d.ts` — Cloudflare env binding type declarations

## Multitenancy

When implementing any tenant-scoped route or migration, follow the data isolation rules in `docs/ARCHITECTURE.md` (§ Multitenancy — Data Isolation Model). Full scenarios and Definition of Done: `docs/multitenancy/multitenancy.spec.md`.

Every new tenant-scoped route MUST include cross-org isolation tests using the `seedTwoOrgs` helper in `test/helpers/tenancy.ts`.

---

## Frontend Stack & Architecture

- **Framework & Build**: React 18, TypeScript, Vite with CRXJS.
- **UI Library**: MUI (Material UI) v6 — component library and theming.
- **Data Fetching (Network)**: TanStack Query (React Query) for efficient caching and backend calls.
- **State Management**: Zustand for lightweight global state.
- **Forms**: React Hook Form and Zod (sharing validation schemas with the backend).

### Design System — "Elegant Field Minimalism"

The UI follows **Elegant Field Minimalism**: sophisticated, restrained minimalism hardened for
outdoor, one-handed, cash-in-hand field use. A trustworthy field instrument — trust expressed as
clarity. Three laws, in priority order: **legible in sunlight · one confident accent · reach &
repetition.**

> **Canonical source of truth:** `.design/design-system/DESIGN_TOKENS.md` (every value AA-verified
> there) → implemented in `app-guideme/src/config/theme.ts` + `src/styles/tokens.css`. The full
> rationale lives in `.design/design-system/DESIGN_BRIEF.md`. *(This supersedes the old indigo
> "Luminous SaaS" system; `docs/DESING.md` is retired.)*

#### Theme Principles

| Principle | Guideline |
|---|---|
| **Color** | Neutral-first: cool-slate ink (`#0F172A`) on off-white (`#F8FAFC`). A single confident **teal** accent (`#0F766E`) — used *reserved & intentionally* for the primary CTA, active nav, and selected/interactive states **only**. Teal never carries state meaning. |
| **Functional color** | Meaning only, muted, never teal, **always icon-paired** (state is never color-alone): green `#15803D` = availability/ok/paid · amber `#B45309` = warning · red `#B91C1C` = urgency/error. |
| **Money** | Financial figures **read first** — large tabular Manrope (the `MoneyText` primitive). Money color is semantic (neutral ink / success green / error red), **never teal**. |
| **Typography** | **Manrope** (loaded in `index.html`). Hierarchy via weight (400 body / 600 emphasis / 700–800 headings & numbers), not drastic size jumps. Base 16px — deliberately large for outdoor legibility. Tabular lining figures (`.numeric`) for all money/counts. |
| **Spacing** | 8px base. Ample padding — cards pad 24px; touch targets ≥48px. We spend whitespace rather than cram density. |
| **Elevation** | **Structure-first.** Resting surfaces have a hairline border + surface tint and **no shadow** (reads in sunlight). Real shadow is reserved for true overlays only — menus, dialogs, bottom sheets. No glassmorphism. |
| **Borders** | Thin (`1px`): card/divider edges `grey.200`, resting control edges `grey.300`. The teal focus ring (border + 3px glow) carries the high-contrast control boundary. |
| **Shape** | 12px controls (buttons, inputs) · 16px containers (cards, dialogs) · 20px bottom-sheet tops · pill (9999) for chips/avatars. *(`shape.borderRadius` base stays 8 so ad-hoc `sx` radii keep scale; 12/16 are pinned in component overrides.)* |
| **Animations** | Subtle, purposeful: fade-in on transitions, gentle sheet slide. No bounce. Honors `prefers-reduced-motion`. |
| **Icons** | Material Symbols / MUI Rounded icons — clean, consistent weight. |
| **Dark mode** | Defined in `DESIGN_TOKENS.md §10` but **not built** — light-only ships for now. |

#### Shared primitive layer (`src/components/`)

Prefer these over ad-hoc `Card`/`Paper`/`Chip` usage:
- **`MoneyText`** — tabular money, semantic color, SR label (the signature element).
- **`SectionCard`** — white surface, hairline border, 16px radius, 24px padding, no resting shadow.
- **`StatusChip`** — functional-color pill, icon-paired (presets: paid/booking/cancelled/active/suspended/…).
- **`AlertCard`** — top-of-screen attention card (warning/error semantics).
- **`BottomSheet`** — the canonical overlay (solid white, real upward shadow; centered ≤640px on desktop).
- **`FormSheet`** / **`ConfirmSheet`** — the BottomSheet hosts for ALL entity editing and confirmations (no MUI Dialogs for these): FormSheet = title + form scroll region + fixed submit footer; ConfirmSheet = question + stacked confirm/cancel.
- **`WizardShell`** / **`WizardPage`** — multi-step wizard chrome (shared `WizardChrome`): the Dialog host (affiliate wizard) and the full-page host (service wizard at `/catalog/new`).

Feature-specific shared pieces follow the same idea (e.g. `FolioStatusChip` in `features/folios`).

#### MUI Theme Customization

Define in `src/config/theme.ts` using `createTheme({ cssVariables: true })`:
- Override `palette`, `typography`, `shape.borderRadius`, `shadows` (index 0–1 = none; overlays only at higher indices), and component defaults (`MuiButton` 48px/no-shadow, `MuiOutlinedInput` teal focus bloom, `MuiCard` border + `boxShadow:none`, `MuiChip`, etc.).
- Use `CssBaseline` for consistent resets; the `.numeric` utility provides tabular figures.
- Wrap the app with `<ThemeProvider>`. CSS variables for non-MUI/sx code live in `src/styles/tokens.css`.

### Frontend Layered Folder Structure

Organize the `app-guideme/` codebase using the following layered architecture:

- `pages/` — Route assembly only, no business logic.
- `layout/` — App shell components (AppLayout, AuthLayout, BottomNav/rail, account surface).
- `components/` — **Shared design-system primitives** (cross-feature, feature-agnostic): `MoneyText`, `SectionCard`, `StatusChip`, `AlertCard`, `BottomSheet`, `WizardShell`. Exported via `components/index.ts`.
- `features/<Name>/` — Feature-based modules:
  - `components/` — Presentational UI components.
  - `hooks/` — Logic, local state, and API/Query hooks.
  - `types.ts` — Type definitions local to the feature.
  - `index.ts` — Public API / exports for the feature.
- `store/` — Zustand store (cross-feature global state).
- `services/` — Pure API fetch clients (e.g., `http.ts`, `authService.ts`).
- `styles/` — Global CSS, incl. `tokens.css` (design-token CSS variables).
- `config/` — Theme (`theme.ts`), routes (`routes.ts`), and general configuration.
