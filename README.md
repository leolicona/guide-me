# Turistear Ya!

Multitenant point-of-sale and booking platform for tours, activities, and lodging, running
entirely on Cloudflare. A `pnpm` monorepo with two deployables:

| Workspace | What it is | Runtime |
|---|---|---|
| [`api-turistear`](./api-turistear) | REST API (Hono) + Vite SSR | Cloudflare Worker · D1 (SQLite) via Drizzle |
| [`app-turistear`](./app-turistear) | React 18 + MUI single-page app | Cloudflare Worker (serves the SPA) |

> **Architecture, folder rules, and the design system** live in [`CLAUDE.md`](./CLAUDE.md).
> **CI/CD, environments, and deploys** live in [`docs/ci-cd.md`](./docs/ci-cd.md).

---

## Prerequisites

- **Node.js 22+** (CI runs on 22)
- **pnpm 10** (`corepack enable` or `npm i -g pnpm`)
- A **Cloudflare** account with `wrangler` access, only if you deploy or run migrations against
  remote D1. `wrangler` ships as a dev dependency — always invoke it as `pnpm exec wrangler …`.

## First-time setup

```bash
pnpm install
```

**Local API secrets** — create `api-turistear/.dev.vars` (git-ignored). Get the values from a
teammate / the Cloudflare dashboard:

```ini
RESEND_API_KEY=...
QR_SECRET=...
PORTAL_BASE_URL=http://localhost:5174/portal
DEV_AUTH_SERVICE_URL=...      # local auth bypass (skips real sign-in in dev)
COOKIE_DOMAIN=localhost
APP_BASE_URL=http://localhost:5174
```

**Seed a local database** (a local SQLite replica of D1):

```bash
pnpm db:migrate:local
```

## Local development

```bash
pnpm dev          # runs BOTH servers in parallel
# or, individually:
pnpm dev:api      # API → http://localhost:5173
pnpm dev:app      # App → http://localhost:5174
```

Open **http://localhost:5174**. The app dev server proxies `/api` → the API on `:5173`, so both
must run. Ports are pinned/strict on purpose (BUG-008) — a collision fails loudly instead of
silently mis-proxying auth.

## Quality checks

```bash
pnpm test:api     # API test suite (vitest, Cloudflare Workers pool)
pnpm lint:app     # ESLint (frontend)
pnpm build:api    # type-check + build the API
pnpm build:app    # type-check + build the app
```

These four are exactly what the CI gate runs on every pull request.

## Database (D1 + Drizzle)

Schema is code-first in [`api-turistear/src/db/schema.ts`](./api-turistear/src/db/schema.ts).

```bash
pnpm db:generate        # generate a migration from schema changes (drizzle-kit)
pnpm db:migrate:local   # apply to the local replica
pnpm db:migrate:dev     # apply to remote Dev   (normally done by CI)
pnpm db:migrate:prod    # apply to remote Prod  (normally done by CI)
```

Keep every migration **additive and backward-compatible** — D1 has no cross-statement
transaction, so a half-applied deploy must still be safe. After changing bindings in a
`wrangler.jsonc`, regenerate types with `pnpm cf-typegen:api` / `pnpm cf-typegen:app`.

## Environments & the release flow

Deploys run in **GitHub Actions** — you normally never deploy from your laptop. Full detail in
[`docs/ci-cd.md`](./docs/ci-cd.md).

| Env | Branch | Workers | Domains | Database |
|---|---|---|---|---|
| **Dev** | `develop` → auto | `api-guideme-dev` · `app-guideme-dev` | `*-dev.turistearya.com` | `guideme-db` |
| **Prod** | `main` → approval-gated | `api-guideme` · `app-guideme` | `api`/`app`.turistearya.com | `guideme-db-prod` |

**Working on a change:**

1. Branch off `develop` → open a PR into `develop`. The **CI** gate (lint + test + build) must pass.
2. Merge → **Dev** deploys automatically. Verify on `*-dev.turistearya.com`.
3. Open a PR `develop → main`, merge → the **Prod** deploy pauses for a manual approval in the
   **Actions** tab, then ships.

The environment is selected at build time via `CLOUDFLARE_ENV` (handled by the deploy scripts);
the frontend's API origin is baked in via `VITE_API_BASE_URL`. Manual deploys exist for
emergencies (`pnpm deploy:{api,app}:{dev,prod}`) and require your own `wrangler` auth.

## Repository layout

```
api-turistear/
  src/
    routes/<resource>/   index.ts (router) · handler.ts (logic) · schema.ts (zod)
    db/                  schema.ts (Drizzle), client
    middleware/ utils/ types/
  migrations/            D1 SQL migrations
app-turistear/
  src/
    pages/               route assembly
    layout/              app shell
    components/          shared design-system primitives
    features/<name>/     feature modules (components · hooks · types)
    store/ services/ config/ styles/
docs/                    ci-cd.md, ARCHITECTURE.md, SPEC.md, …
.design/design-system/   design tokens & brief
```

## Further reading

- [`CLAUDE.md`](./CLAUDE.md) — architecture, backend/frontend folder rules, design system.
- [`docs/ci-cd.md`](./docs/ci-cd.md) — pipeline, environments, one-time setup runbook.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — multitenancy & data-isolation model.
- [`docs/SPEC.md`](./docs/SPEC.md) — product spec and user stories.
