# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`turistear` is a monorepo containing:
- A Cloudflare Worker API (`api-turistear/`) built with Hono and served via Vite SSR.
- A React application as a Chrome Extension (`app-turistear/`) built with React 18, TypeScript, Vite with CRXJS, and TailwindCSS.

The project uses `pnpm` workspaces. Commands can be run from the root.

## The pre-Spec-Kit corpus is archived

**The documentation corpus left this repo on 2026-10-03**, when the project moved to GitHub Spec
Kit: `docs/` (the `SPEC.md` index, `PROCESS.md`, `ARCHITECTURE.md`, `TESTING.md`, `BUGS.md`,
`TECH_DEBT.md`, every feature spec and plan), `.design/` (the design system and its reviews) and
`api-turistear/specs/`. It lives, with its history, in the read-only archive
**[`leolicona/guide-me-docs`](https://github.com/leolicona/guide-me-docs)** (private).

Comments across `api-turistear/`, `app-turistear/` and `.github/` — and this file — still cite it by
its old paths (`docs/TESTING.md D10`, `.design/design-system/DESIGN_TOKENS.md`). Those paths do not
exist here; they resolve in the archive **at the same path**. The archive is history, not law —
leave the citations intact, and re-specify anything you rebuild.

To read it, prefer the local clone, a sibling of the main `guide-me` checkout (also from a worktree):

```bash
DOCS="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/../guide-me-docs"
[ -d "$DOCS" ] || gh repo clone leolicona/guide-me-docs "$DOCS"
git -C "$DOCS" pull --ff-only
```

For a single file without a clone:
`gh api repos/leolicona/guide-me-docs/contents/docs/SPEC.md -H "Accept: application/vnd.github.raw"`.

## Commands

> **Running the app locally for the first time in a worktree: read `docs/DEVELOPMENT.md`** (in the archive).
> `pnpm dev` alone is not enough — without `.dev.vars` the login returns **200 and no session**,
> because `wrangler.jsonc` pins the cookie to `.turistearya.com` and auth lives in an external
> Worker reached by a service binding that does not exist locally. `pnpm db:migrate:local` also
> links the worktree to the clone-wide local database, so data survives switching branches.

### Workspace-level (Run from root)

```bash
pnpm dev:api       # Start local dev server for API (port 5173)
pnpm dev:app       # Start local dev server for App (port 5174 — proxies /api to 5173)
pnpm dev           # Start both dev servers in parallel
pnpm seed:local    # Seed the local D1: an admin you can log in as + sample sales
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

## Spec-driven development — GitHub Spec Kit

Work is **spec-driven** with GitHub Spec Kit 1.0.4 (`.specify/`, skills in `.claude/skills/speckit-*`),
using its core templates unmodified — the same setup as `leolicona/devolada`:

- Feature → `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`, all
  committed under `specs/NNN-slug/`. Never start at the code. Optional gates: `/speckit-clarify`
  before plan, `/speckit-checklist` after it, `/speckit-analyze` before implement, and
  `/speckit-converge` to append what is still unbuilt as tasks.
- Bug → the lite path `/speckit-bug-assess` → `-fix` → `-test` under `.specify/bugs/<slug>/`
  (`assess` and `test` never edit source).
- Deliberate shortcut → `/speckit-debt-log` under `.specify/debt/<slug>/`, closed only by
  `/speckit-debt-pay` with evidence.

`/speckit-specify` does not create a branch (the `git` extension is not installed): the spec folder
`specs/NNN-slug/` and the worktree branch `feat/<slug>` below are independent — keep both.

**[`.specify/memory/constitution.md`](.specify/memory/constitution.md) is the law of this repo**
(v1.0.0, ratified 2026-10-04): eight principles — spec-driven and cited, money law, tenant
isolation, the server decides, capacity guarded by the database, tests where the rule is enforced,
Elegant Field Minimalism, external services never undo a sale — plus the stack, the gates and how
it is amended. It supersedes every other practice document, this file included; where they
disagree, the constitution wins. Amend it with `/speckit-constitution`, never by hand. When the
design extension offers `/speckit-design-foundations`, point it at the existing design system
(below) rather than inventing one.

The pre-Spec-Kit process — `docs/PROCESS.md`, with `docs/SPEC.md` as the product index — is archived
with the corpus (above): read it for what exists and why, never write into it. The archive's
`docs/integrations/` still records the contracts of the services we do not own (Agnostic Auth,
Resend, the QR image service) and what breaks when they are down.

### Local workflow — one worktree, one PR per unit of work

Every feature, fix, enhancement or docs change gets **its own worktree and its own pull request**:

```bash
git worktree add .claude/worktrees/<name> -b feat/<slug> origin/develop
```

Branch `feat/` · `fix/` · `docs/`; commits are Conventional with the domain as scope
(`feat(cancellation):`); PRs target **`develop`** and are squash-merged, so the PR title becomes the
commit on `develop`. A release is a PR `develop → main` titled `release: … → prod`. The `verify` CI
job must pass. Two hard rules: **never bare `git stash`** (the stack is shared across worktrees), and
**squash `feature → develop`, merge-commit `release → main`** — the archived `docs/PROCESS.md`
records why.

## Multitenancy

When implementing any tenant-scoped route or migration, follow the data isolation rules in `docs/ARCHITECTURE.md` (§ Multitenancy — Data Isolation Model). Full scenarios and Definition of Done: `docs/multitenancy/multitenancy.spec.md`.

Every new tenant-scoped route MUST include cross-org isolation tests using the `seedTwoOrgs` helper in `test/helpers/tenancy.ts`.

---

## Frontend Stack & Architecture

- **Framework & Build**: React 18, TypeScript, Vite with CRXJS.
- **UI Library**: MUI (Material UI) **v9** — component library and theming. *(The version matters: v9 resolves `Typography`'s `color` prop through palette VARIANTS — `textSecondary`, `warning` — not dotted paths. `color="text.secondary"` is silently dropped; BUG-038.)*
- **Data Fetching (Network)**: TanStack Query (React Query) for efficient caching and backend calls.
- **State Management**: Zustand for lightweight global state.
- **Forms**: React Hook Form and Zod (sharing validation schemas with the backend).

### Design System — "Elegant Field Minimalism"

The UI follows **Elegant Field Minimalism**: sophisticated, restrained minimalism hardened for
outdoor, one-handed, cash-in-hand field use. A trustworthy field instrument — trust expressed as
clarity. Three laws, in priority order: **legible in sunlight · one confident accent · reach &
repetition.**

> **Canonical source of truth:** `.design/design-system/DESIGN_TOKENS.md` in the archive (every
> value AA-verified there) → implemented in `app-turistear/src/config/theme.ts` + `src/styles/tokens.css`. The full
> rationale lives in `.design/design-system/DESIGN_BRIEF.md`. *(This supersedes the old indigo
> "Luminous SaaS" system; `docs/DESING.md` is retired.)*
>
> **The section below is a summary — `DESIGN_TOKENS.md` wins any disagreement.** Only `theme.ts`
> and `tokens.css` may restate a token value; everywhere else, cite the section instead of copying
> the hex (`docs/PROCESS.md` § The design system has exactly one source).

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
- **`WizardShell`** / **`WizardPage`** — multi-step wizard chrome (shared `WizardChrome`): the Dialog host (no consumer today — `specs/001-retire-affiliates` D12) and the full-page host (service wizard at `/catalog/new`).

Feature-specific shared pieces follow the same idea (e.g. `FolioStatusChip` in `features/folios`).

#### MUI Theme Customization

Define in `src/config/theme.ts` using `createTheme({ cssVariables: true })`:
- Override `palette`, `typography`, `shape.borderRadius`, `shadows` (index 0–1 = none; overlays only at higher indices), and component defaults (`MuiButton` 48px/no-shadow, `MuiOutlinedInput` teal focus bloom, `MuiCard` border + `boxShadow:none`, `MuiChip`, etc.).
- Use `CssBaseline` for consistent resets; the `.numeric` utility provides tabular figures.
- Wrap the app with `<ThemeProvider>`. CSS variables for non-MUI/sx code live in `src/styles/tokens.css`.

### Frontend Layered Folder Structure

Organize the `app-turistear/` codebase using the following layered architecture:

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
