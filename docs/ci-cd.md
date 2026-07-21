# CI/CD — Dev & Prod environments (Cloudflare Workers)

Two isolated environments, deployed by GitHub Actions. Nothing deploys from a laptop.

| | Branch | API worker | App worker | API domain | App domain | D1 database |
|---|---|---|---|---|---|---|
| **Dev** | `develop` | `api-guideme-dev` | `app-guideme-dev` | `api-dev.turistearya.com` | `app-dev.turistearya.com` | `guideme-db` (the pre-split dev/test data) |
| **Prod** | `main` | `api-guideme` | `app-guideme` | `api.turistearya.com` | `app.turistearya.com` | `guideme-db-prod` (fresh, empty) |

> **DB split:** the original `guideme-db` (dev/test data) became the **Dev** database; **Prod**
> launches empty on the new `guideme-db-prod`. Both share the schema (all 44 migrations). The
> live prod worker keeps serving `guideme-db` until the next prod deploy rebinds it to the empty
> `guideme-db-prod`.

## Flow

```
PR ─────────────▶ ci.yml            lint + test:api + build (merge gate, no deploy)
push develop ───▶ deploy-dev.yml    test → migrate dev D1 → deploy api-dev → deploy app-dev   (auto)
push main ──────▶ deploy-prod.yml   ⏸ approval → test → migrate prod D1 → deploy api → deploy app
```

- **Migrations run before code** each deploy, so new schema is live when new code lands.
  Keep every migration additive / backward-compatible — D1 has no cross-statement
  transaction, so a half-applied deploy must still be safe.
- **The environment is selected at BUILD time** via `CLOUDFLARE_ENV` (the deploy scripts
  set it). `@cloudflare/vite-plugin` bakes the chosen env's name/routes/D1/vars into the
  build output; a plain `wrangler deploy` then ships it (`wrangler deploy --env …` is
  *ignored* for these plugin-built workers). Only **D1 migrations** use `--env` directly,
  because they bypass vite.
- **The frontend's API origin is a build-time constant** (`VITE_API_BASE_URL`). The
  workflows inject the per-env value; the app worker itself carries no API var.
- **Shared auth**: dev binds the same `agnostic-auth` service + app id `guide-me`. The
  `.turistearya.com` cookie domain spans `app-dev` and `app`, so sessions work on both.

## Local commands (unchanged workflow, new script names)

```bash
pnpm dev                 # local dev servers (unchanged)
pnpm db:migrate:local    # apply migrations to the local D1 replica

# Deploys normally go through CI. To deploy by hand you need wrangler auth
# (wrangler login, or CLOUDFLARE_API_TOKEN in your shell). The deploy:* scripts set
# CLOUDFLARE_ENV themselves; the app additionally needs VITE_API_BASE_URL at build:
pnpm db:migrate:dev  &&  pnpm deploy:api:dev  &&  VITE_API_BASE_URL=https://api-dev.turistearya.com pnpm deploy:app:dev
pnpm db:migrate:prod &&  pnpm deploy:api:prod &&  VITE_API_BASE_URL=https://api.turistearya.com     pnpm deploy:app:prod
```

> ⚠ There is intentionally **no bare `deploy` / `db:migrate` script**. Every deploy is
> `--env`-scoped so it can never target the wrong environment by omission.

---

## One-time setup (do this once, in order)

Prereqs: the `turistearya.com` zone is already on Cloudflare (it is), and the production
worker names are unchanged, so prod keeps its existing domain, secrets, and D1 with no
migration.

> `wrangler` is a project devDependency, not a global — always invoke it as
> `pnpm exec wrangler …` (or `npx wrangler …`) from the relevant workspace.

### 1. Databases — ✅ already provisioned

- **Dev** reuses the original `guideme-db` (`15cd8f75-…`) — its data is the dev dataset.
- **Prod** is the new, empty `guideme-db-prod` (`4f7e6b53-…`) with all 44 migrations applied.

Both ids are already wired into `api-turistear/wrangler.jsonc`. Nothing to do here unless you
provision a new environment (`pnpm exec wrangler d1 create <name>` → paste its id → `pnpm
db:migrate:<env>`).

### 2. First deploy provisions the Dev custom domains

The first Dev deploy of each worker (`pnpm deploy:api:dev` / `pnpm deploy:app:dev`, or
just push `develop`) registers the `api-dev` / `app-dev` custom domains and Cloudflare
creates the DNS records automatically (same zone).

### 3. Per-environment Cloudflare secrets

Secrets are **not** in `wrangler.jsonc`. Set them per worker/env (prod values already
exist on `api-guideme`; you only need to add the dev set — use a **different**
`QR_SECRET` so a dev-signed QR can't validate in prod):

```bash
cd api-turistear
# Dev
pnpm exec wrangler secret put RESEND_API_KEY  --env dev
pnpm exec wrangler secret put QR_SECRET       --env dev     # NEW random value, not prod's
pnpm exec wrangler secret put PORTAL_BASE_URL --env dev     # e.g. https://app-dev.turistearya.com/portal
# Prod (only if you ever need to rotate — already set on the live worker)
# pnpm exec wrangler secret put RESEND_API_KEY  --env production
```

(Whatever else lives in `.dev.vars` as a secret gets the same treatment.)

### 4. GitHub repository secrets

`Settings → Secrets and variables → Actions`:

| Secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id |
| `CLOUDFLARE_API_TOKEN` | scoped token (see below) |

Create the token at Cloudflare → My Profile → API Tokens → Create Token. Start from the
**"Edit Cloudflare Workers"** template (it bundles Workers Scripts edit, Workers Routes
edit, and the zone/DNS reads that custom-domain provisioning needs), then **add one
permission**: **Account · D1 · Edit** (for `d1 migrations apply`). Scope it to your
account and the `turistearya.com` zone.

### 5. GitHub Environments (the approval gate)

`Settings → Environments`:
- Create **`dev`** — no rules.
- Create **`production`** — add **Required reviewers** (yourself). Optionally restrict
  its deployment branches to `main`. This is what pauses `deploy-prod.yml` for approval.

### 6. Branches & protection

```bash
git checkout main && git pull
git checkout -b develop && git push -u origin develop
```

`Settings → Branches` → protect **`main`** and **`develop`**: require PRs and require the
**CI / verify** check to pass before merge.

---

## Day-to-day

1. Branch off `develop`, open a PR into `develop` → **CI** runs.
2. Merge → **Deploy Dev** ships to `*-dev.turistearya.com` automatically. Verify there.
3. Open a PR `develop → main`, merge → **Deploy Prod** waits for your approval, then
   migrates + ships to production.

### Rollback

- **Code**: revert the commit on the branch (re-runs the deploy), or in the Cloudflare
  dashboard roll the worker back to a previous version/deployment.
- **Schema**: D1 has no down-migrations here — forward-fix with a new additive migration.
  This is why migrations must stay backward-compatible with the previously deployed code.
