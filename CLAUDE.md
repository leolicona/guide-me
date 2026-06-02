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

---

## Frontend Stack & Architecture

- **Framework & Build**: React 18, TypeScript, Vite with CRXJS.
- **UI Library**: MUI (Material UI) v6 — component library and theming.
- **Data Fetching (Network)**: TanStack Query (React Query) for efficient caching and backend calls.
- **State Management**: Zustand for lightweight global state.
- **Forms**: React Hook Form and Zod (sharing validation schemas with the backend).

### Design System — Elegant Minimalist

The UI follows an **elegant minimalist** style: generous whitespace, restrained color palette, clean typography, and subtle interactions.

#### Theme Principles

| Principle | Guideline |
|---|---|
| **Color** | Neutral-first palette. Primary: deep charcoal/slate. Accent: a single refined color (e.g., indigo or teal) used sparingly for CTAs and active states. Avoid bright or saturated tones. |
| **Typography** | `Inter` or `Plus Jakarta Sans` via Google Fonts. Light font weights (300–400) for body, medium (500) for emphasis, semibold (600) for headings. Generous line-height. |
| **Spacing** | Ample padding and margins. Cards and forms should breathe. Avoid cramped layouts. |
| **Elevation** | Minimal shadows. Prefer `elevation={0}` with subtle borders (`1px solid divider`) over heavy drop shadows. |
| **Borders** | Thin (`1px`), light color (`grey.200` in light mode). Rounded corners: `8px–12px` for cards, `8px` for inputs and buttons. |
| **Animations** | Subtle and purposeful. Fade-in on page transitions, gentle hover lift on cards. No bouncy or flashy animations. |
| **Icons** | Material Symbols (Outlined) — clean, consistent weight. |
| **Backgrounds** | Light mode: off-white (`#FAFAFA` or `grey.50`). Dark mode: deep grey (`#121212`). No pure white or pure black. |

#### MUI Theme Customization

Define in `src/config/theme.ts` using `createTheme()`:
- Override `palette`, `typography`, `shape.borderRadius`, `shadows`, and component defaults (`MuiButton`, `MuiTextField`, `MuiCard`, etc.).
- Use `CssBaseline` for consistent resets.
- Wrap the app with `<ThemeProvider>`.

### Frontend Layered Folder Structure

Organize the `app-guideme/` codebase using the following layered architecture:

- `pages/` — Route assembly only, no business logic.
- `layout/` — Shared layout components (Header, Sidebar, BottomNav, PageWrapper).
- `features/<Name>/` — Feature-based modules:
  - `components/` — Presentational UI components.
  - `hooks/` — Logic, local state, and API/Query hooks.
  - `types.ts` — Type definitions local to the feature.
  - `index.ts` — Public API / exports for the feature.
- `store/` — Zustand store (cross-feature global state).
- `services/` — Pure API fetch clients (e.g., `http.ts`, `authService.ts`).
- `config/` — Theme (`theme.ts`), routes (`routes.ts`), and general configuration.
