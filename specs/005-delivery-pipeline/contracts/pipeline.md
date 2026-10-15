# Contract: the pipeline

What each workflow accepts, does in order, refuses, prints and leaves. Every job runs on
`ubuntu-latest`; every install is a frozen-lockfile install through `.github/actions/setup`.

## Composite actions

### `.github/actions/setup`

pnpm 10, Node 22 with the pnpm cache, `pnpm install --frozen-lockfile`. No inputs, no credentials.

### `.github/actions/verify` — the gate (D8)

Runs `setup`, then, in this order: the archive guard (fails if `docs/` or `.design/` exists),
`pnpm lint:app`, `pnpm test:app`, `pnpm test:api`, `node --test '.github/scripts/*.test.mjs'`,
`pnpm build:api`, `pnpm build:app`. No credentials. Any failure fails the job.

## `ci.yml` — CI

| | |
| --- | --- |
| Trigger | `pull_request` into `main`: opened, synchronize, reopened |
| Jobs | `verify` (the action) |
| Credentials | none; runs the same for forks (FR-001) |
| Concurrency | `ci-<ref>`, a newer push cancels the older run |
| Merge gate | the `verify` check is the one required check (FR-002) |

## `preview.yml` — Preview

| | |
| --- | --- |
| Trigger | `pull_request` into `main`: opened, synchronize, reopened, labeled; `paths-ignore`: `**.md`, `.claude/**`, `.specify/**` (D16) |
| Runs when | the head repository is this repository (D16), and the event is not a label other than `e2e` |
| Concurrency | `preview-<number>`, a newer run cancels the older (FR-004) |
| Permissions | `contents: read`, `pull-requests: write`, `issues: write` |

Jobs, in order:

1. **`gate`** — the verify action (D6).
2. **`deploy`** — needs `gate`; environment `dev`.
   1. Read the account's `workers.dev` subdomain (`GET /accounts/{id}/workers/subdomain`); stop with
      a message naming the fix if it is missing (D2, R3).
   2. Derive the two Worker names and origins (data-model, Preview).
   3. List dev's pending migrations (`wrangler d1 migrations list guideme-db --remote --env dev`),
      then apply them with `pnpm db:migrate:dev` (D3). Output: the files applied.
   4. Write the secrets file: `QR_SECRET` and `RESEND_API_KEY` from the environment, a throwaway
      value for each one missing (D5). Output: the throwaway names. The file lives in
      `$RUNNER_TEMP` and is never printed.
   5. Build the API with `CLOUDFLARE_ENV=preview`; `wrangler deploy --name api-guideme-pr-<n>
      --var CORS_ORIGIN:<app> --var APP_BASE_URL:<app> --var API_BASE_URL:<api> --secrets-file …`.
   6. Build the app with `CLOUDFLARE_ENV=preview` and `VITE_API_BASE_URL=<api>`; `wrangler deploy
      --name app-guideme-pr-<n>`.
   7. Smoke: `<api>/` and `<app>/` answer 2xx, 10 tries 15 s apart each.
3. **`journeys`** — needs `deploy`; only when the pull request carries the `e2e` label (D15);
   environment `dev`; concurrency group `e2e-dev-data`, never cancelled. Runs `pnpm --filter
   app-turistear test:e2e` with `E2E_BASE_URL=<app>`, `E2E_API_BASE=<api>`; uploads the report
   whatever the result.
4. **`note`** — needs all three and runs whatever their result, unless the run was cancelled: a
   newer push cancels this run and writes its own note, so two runs never race to create the
   comment (SC-002). Upserts the comment ([preview-comment.md](./preview-comment.md)).

Refuses: a fork (no job runs), a documentation-only pull request (the workflow does not start).

## `preview-cleanup.yml` — Preview cleanup

| | |
| --- | --- |
| Trigger | `pull_request` into `main`: closed |
| Runs when | the head repository is this repository |
| Environment | `dev` |
| Concurrency | `preview-<number>`, not cancelled — it waits for a deploy in flight |

Steps: for each of `api-guideme-pr-<n>` and `app-guideme-pr-<n>`, `DELETE
/accounts/{id}/workers/services/<name>`; 200 = deleted, 404 = already absent, anything else =
failed (D7). Then the note: `deleted` or `not deleted`, plus the stays-on-dev line for an
unmerged pull request whose marker lists migrations. No comment is created when none exists.

## `deploy-dev.yml` — Deploy Dev

| | |
| --- | --- |
| Trigger | `push` to `main`; no `paths-ignore` (D9) |
| Concurrency | `deploy-dev`, queued, never cancelled (FR-013) |

Jobs: **`verify`** (the action) → **`deploy`** (environment `dev`): `pnpm db:migrate:dev`,
`pnpm deploy:api:dev`, `pnpm deploy:app:dev`, then the smoke of `https://api-dev.turistearya.com/`
and `https://app-dev.turistearya.com/` (10 tries, 30 s apart, every host tried before failing).

The run's conclusion is what the release gate reads: `success` only when every step passed.

## `deploy-prod.yml` — Deploy Prod

| | |
| --- | --- |
| Trigger | `push` of a tag `v*` (D10) |
| Concurrency | `deploy-prod`, queued, never cancelled (FR-020) |

Jobs, in order:

1. **`gate`** — `permissions: actions: read, contents: read`.
   - `GET /repos/{repo}/actions/workflows/deploy-dev.yml/runs?head_sha=<sha>`: at least one run
     with `conclusion == success`, or stop: *"No green Deploy Dev run for <sha>. Tag a main commit
     whose dev deploy finished green (delivery-pipeline D10)."*
   - `git merge-base --is-ancestor <sha> origin/main`, or stop: *"<sha> is not on main."*
2. **`verify`** — needs `gate`; the action (D8).
3. **`deploy`** — needs `verify`; environment `production`.
   1. Restore point: `wrangler d1 time-travel info guideme-db-prod --env production --json` →
      bookmark; plus the UTC time. No bookmark → stop before migrating (D11).
   2. `pnpm db:migrate:prod`.
   3. `pnpm deploy:api:prod`, output kept.
   4. `pnpm deploy:app:prod`, output kept.
   5. **What landed** — runs even after a failed step: tag, commit, restore point, the version id of
      `api-guideme` and `app-guideme` (or "not deployed in this run"), and how to undo (D12).
   6. Smoke: `https://api.turistearya.com/` and `https://app.turistearya.com/`, 10 tries 30 s apart,
      every host tried; a red smoke names *Rollback Prod* (D13).

Never writes: a database export, a row, a secret value (FR-017).

## `rollback-prod.yml` — Rollback Prod

| | |
| --- | --- |
| Trigger | `workflow_dispatch`: `worker` (choice `api` \| `app`), `version_id` (string) |
| Environment | `production` (admits only `main` and `v*`: a dispatch from another branch is refused by GitHub) |
| Concurrency | `deploy-prod`, queued (FR-023) |

Steps: map `worker` to `api-guideme` / `app-guideme`; `wrangler rollback <version_id> --name
<worker> -y -m "<actor> · <run url>"`; `wrangler deployments status --name <worker> --json`; pass
only if the version at 100% is `version_id`, else fail: *"Rollback did not take: live is <id>,
asked for <version_id>. Nothing moved."* (D14). Summary: the Worker, the version, and that data is
recovered only from a release's restore point, as a separate act (FR-022).

## `e2e.yml` — E2E

| | |
| --- | --- |
| Trigger | `schedule` (08:00 UTC) and `workflow_dispatch` (`base_url`, default dev) |
| Environment | `dev` |
| Concurrency | `e2e-dev-data`, never cancelled (D15) |

Unchanged otherwise. The `pull_request` trigger leaves: the label now runs inside `preview.yml`.
