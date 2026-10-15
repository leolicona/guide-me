# Research: delivery-pipeline

Phase 0 of [plan.md](./plan.md). Every finding was measured on 2026-10-15 against this repository,
its Actions history, the Cloudflare account `liconadev`, wrangler 4.99.0 (the version the lockfile
installs) and the two reference repositories: devolada (`specs/006-production-launch`, its
workflows) and miabot (`preview.yml`, `preview-cleanup.yml`, `_deploy.yml`).

## R1 — A preview needs its own Worker profile; renaming a dev build is not enough

**Measured**: a dev build (`CLOUDFLARE_ENV=dev pnpm build`) writes a redirected deploy config that
carries dev's `routes` (`api-dev.turistearya.com`, `custom_domain: true`) and dev's cron
(`*/15 * * * *`). `wrangler deploy --name api-guideme-pr-1` on that build is accepted, so a renamed
dev build would try to attach dev's hostname to the preview Worker and run a second sweep.

A build with a new `preview` environment (`CLOUDFLARE_ENV=preview`) writes `routes: null`,
`triggers: {}`, `workers_dev: true`, dev's D1 (`guideme-db`) and the `agnostic-auth` service. On it,
`wrangler deploy --dry-run --name api-guideme-pr-999 --var …` is accepted. The same holds for the
app (`routes: null`, `workers_dev: true`, the preview API origin baked into the bundle).

wrangler splits `--var KEY:VALUE` on the first colon only (`collectKeyValues`: `split(":")`, then
`value.join(":")`), so a full `https://…` origin survives.

**Decision**: a `preview` environment in each `wrangler.jsonc`, with no routes and no triggers; the
per-pull-request name comes from `--name` and the three origins from `--var` (D2, D3).

**Alternatives**: a generated config per pull request (miabot's `preview-config.mts`) — more code,
and the shape would live outside the file a reviewer reads. Cloudflare's own Worker Previews
(changelog 2026-09-22, preview URLs and preview custom domains) — one URL per *version* of the
existing Worker, so a preview would share dev's bindings, vars and secrets and could not carry its
own `APP_BASE_URL` or CORS origin; rejected for the same reason devolada's version uploads cannot
sign in (devolada `ci.yml`: "a preview renders but cannot sign in").

## R2 — Sign-in works on `workers.dev` with a host-only cookie

**Measured**: the Public Suffix List lists `workers.dev` (Cloudflare section), not
`*.workers.dev`. So `<subdomain>.workers.dev` is the registrable domain, and
`app-guideme-pr-<n>.<subdomain>.workers.dev` and `api-guideme-pr-<n>.<subdomain>.workers.dev` are
**the same site**. A `SameSite=Lax` cookie set by the preview's API is sent on the app's
credentialed `fetch` to it.

`utils/cookies.ts` sets `domain: c.env.COOKIE_DOMAIN || undefined`, so an empty `COOKIE_DOMAIN`
gives a host-only cookie on the preview's API. CORS (`src/index.tsx`) admits exactly the origins in
`CORS_ORIGIN`. The `agnostic-auth` client (`services/agnosticAuth.ts`) reaches its Worker through
the service binding and sends no origin, so it behaves the same from a preview.

**Decision**: `COOKIE_DOMAIN` empty in the preview profile; `CORS_ORIGIN` and `APP_BASE_URL` set
to the preview's own app origin, `API_BASE_URL` to its API origin (D4).

**Consequence for 004-passkey-auth**: Better Auth derives `rpID` and `trustedOrigins` from
`APP_BASE_URL` (004 plan), so the same `--var` serves it; 004 adds `AUTH_COOKIE_PREFIX` and
`BETTER_AUTH_SECRET` to the preview profile and the preview's secret list.

## R3 — The `workers.dev` subdomain is read from the account

**Measured**: the origins must be known before either Worker is built (the app bakes the API origin;
the API needs the app origin for CORS). Miabot reads
`GET /accounts/{account_id}/workers/subdomain` with the deploy token, or a repository variable.

**Decision**: read it from the account with the token the job already holds; on failure, stop with
a message naming the fix (enable the subdomain, or give the token Workers Scripts Read). No
repository variable to keep in step (D2).

## R4 — Secrets: previews take dev's values; dev and production keep theirs

*Superseded in part on 2026-10-15 (constitution v1.4.0): dev and production no longer keep their
secrets only on their Workers — every deploy plants the API's from its GitHub environment,
additively (`--secrets-file`). Previews are unchanged.*

**Measured**: the API reads two secrets, `QR_SECRET` and `RESEND_API_KEY` (`bindings.d.ts`). Neither
deploy workflow plants secrets today; dev's and production's values were set on their Workers by
hand. `wrangler deploy --secrets-file` uploads each entry as `secret_text` with the version and
"applies additively" (wrangler source; help text), so a brand-new preview Worker gets its secrets
in the same call that creates it.

A preview serves dev's data. With dev's `QR_SECRET`, a ticket sold on dev validates on the preview
and the other way round. With a different value, neither does. A missing `RESEND_API_KEY` means no
email leaves the preview.

Planting secrets on dev and production from CI (devolada's "Sync worker secrets") was weighed and
rejected here: production already holds live, signed tickets. If a value pasted into GitHub
differed by one character from the one on the Worker, the next release would invalidate the QR of
every ticket sold — and secret values are write-only, so nothing could compare them first.

**Decision**: previews read `QR_SECRET` and `RESEND_API_KEY` from the GitHub `dev` environment; a
missing one becomes a throwaway value for that preview only, and the comment names the cost (D5).
Dev and production keep their secrets on their Workers (D17). Constitution VIII is clarified: a
preview is a target of dev, not a third environment, so sharing dev's signing secret is not two
environments sharing one.

## R5 — A preview migrates dev only after the gate passed

**Measured**: the creator chose that previews apply the pull request's migrations to dev
(Clarifications). The API suite applies every migration to a real local D1 before its tests run
(constitution VI), so a migration that breaks the suite is caught there. If the preview ran in
parallel with the gate, a migration the suite rejects could still reach dev.

GitHub Actions minutes are free for public repositories on standard runners, so running the gate
twice (once in `ci.yml`, once before the preview) costs time, not money: about 3–4 minutes
(measured: CI runs #202–#205 took 2 min 58 s to 4 min 12 s).

The gate cannot live in the preview workflow alone: the merge gate must stay credential-free and
must not re-run on a `labeled` event, or a label added after a red run would replace the red
`verify` check with a skipped one, which GitHub counts as passing.

**Decision**: `ci.yml` keeps `verify` as the merge gate. `preview.yml` runs the same gate as its
first job and deploys only after it passes (D6). One composite action holds the gate (D8).

## R6 — One comment per pull request, and deletion that counts "already gone"

**Measured**: miabot finds its comment by an HTML marker and updates it in place, and deletes both
Workers on close, counting an absent Worker as deleted. `wrangler delete --name X` in CI confirms
by itself ("Using fallback value in non-interactive context: yes") but has no way to say "absent"
other than an error, so the cleanup calls the REST API
(`DELETE /accounts/{id}/workers/services/{name}`) and treats HTTP 404 as already deleted.

Migrations reach dev once: a second run of the same pull request finds nothing pending. To say on
close which migrations a pull request put on dev, the comment keeps the running list in its hidden
marker and each run adds to it.

**Decision**: a small Node script (`.github/scripts/preview-note.mjs`, no dependencies) renders and
upserts the comment; its pure parts carry `node:test` tests in the gate (D7).

## R7 — A deploy's gate was a subset of the pull-request gate

**Measured**: `deploy-dev.yml` and `deploy-prod.yml` run only `test:api` before deploying; the
pull-request gate also runs the archive guard, `lint:app`, `test:app`, `build:api` and `build:app`.
Devolada had the same drift and fixed it by copying lines (its D2), which can drift again.

**Decision**: the gate is one composite action (`.github/actions/verify`), used by `ci.yml`,
`preview.yml`, `deploy-dev.yml` and `deploy-prod.yml`. The required check keeps the name `verify`
(D8).

## R8 — The release cannot archive the database; Time Travel gives a restore point

**Measured**: the repository is public (`visibility: public`). Devolada's release uploads
`wrangler d1 export` of its production database as an artifact; on a public repository any signed-in
GitHub user can download a run's artifacts. `guideme-db-prod` held 6.5 MB on 2026-10-15 — sales,
payments, tourists' names, emails and phones.

D1 Time Travel is built in: `wrangler d1 time-travel info <db> --json` returns the bookmark for
now (`{ "bookmark": … }`, wrangler source), and `wrangler d1 time-travel restore <db>
--bookmark … | --timestamp …` restores to it, "within the last 30 days" (wrangler 4.99 help). A
bookmark is a position, not data: it is safe in a public log, and using it needs the account's
token.

**Decision**: before migrating, the release records the bookmark and the UTC time; it stops if
Time Travel does not answer — no restore point, no migration. No export is ever written (D11).

## R9 — Version ids, and a rollback that can decline silently

**Measured**: wrangler prints `Current Version ID: <uuid>` after each deploy (wrangler source;
devolada reads it the same way). `wrangler rollback [version-id] --name <worker> -y -m <message>`
exists, and `getScriptName` takes `--name` before the config's name, so the API directory's local
profile (`api-guideme-local`) can never be the target. Devolada measured that a rollback can
decline without a non-zero exit (secrets changed since that version) and verifies the live
deployment afterwards. wrangler 4.99 has `wrangler deployments status --name <worker> --json`,
which returns the live deployment with `versions[].version_id` and `percentage`.

**Decision**: the release keeps each deploy's output and writes the version ids into its summary
(D12). *Rollback Prod* rolls one Worker back, then reads `deployments status` and fails unless the
version at 100% is the one asked for (D14).

## R10 — The `e2e` label pointed at dev

**Measured**: `e2e.yml` runs on any pull request labelled `e2e`, with
`E2E_BASE_URL=https://app-dev.turistearya.com`. The journeys sign in through the API and save its
cookies (`e2e/setup/auth.setup.ts`); with the preview's host-only cookie on the API host, the saved
state is sent to the same host, so the setup works unchanged against a preview. The last four
nightly runs (2026-10-11 to 2026-10-14) failed 3 of 7 journeys on dev (strict-mode clashes, for
example "Saldo por cobrar" resolving to two elements) — a bug outside this feature.

**Decision**: the label runs the journeys inside `preview.yml`, after that pull request's preview is
ready, against its addresses. The nightly and manual runs keep dev. All journey runs share one
concurrency group because they share dev's data (D15).

## R11 — Two branches, and a release gate that asks for proof

**Measured**: see spec, broken #3 and #4. Devolada's release gate asks the REST API for a
successful *Deploy Dev* run with `head_sha` equal to the tagged commit, and checks that the commit
is an ancestor of `main`. Its `production` environment admits only tags `v*` and `main`.

The repository is public, so GitHub would allow a required reviewer here (devolada could not have
one); the creator chose the tag alone (Clarifications).

`deploy-dev.yml` and `deploy-prod.yml` ignore `**.md` pushes. With a release gate that needs a
green dev run for the tagged commit, a documentation-only commit at the tip of `main` could never
be released.

**Decision**: one branch (D1); dev deploys on every push to `main`, documentation included (D9);
production only from a `v*` tag on a commit the gate proves (D10).

## R12 — Capacity of the account

**Measured**: `liconadev` held 48 Workers and 10 D1 databases on 2026-10-15. A database per pull
request is ruled out twice: 10 is the Workers Free cap, and the creator chose dev's database
(Clarifications). Each open preview adds 2 Workers; under a 100-Worker cap that is about 26
previews open at once. Nothing is reserved; a deploy past the cap fails with the platform's message,
which the comment shows.

## R13 — Migrations that collide

**Measured**: migrations are hand-written SQL files in `api-turistear/migrations/` (no drizzle
journal). `wrangler d1 migrations apply` applies every file whose name is not recorded in dev's
`d1_migrations`, in name order. Two pull requests can each add `0071_*` and both previews apply
their file. If the second one were then renamed to `0072_*`, dev would see a new name, re-run its
statements and fail (for example `duplicate column name`).

**Decision**: a migration that has reached dev keeps its name; two files sharing a number apply in
name order (D19). The constitution's "next four-digit number" rule gains that sentence.
