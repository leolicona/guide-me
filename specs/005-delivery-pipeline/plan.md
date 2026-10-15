# Implementation Plan: delivery-pipeline

**Branch**: `feat/delivery-pipeline` | **Date**: 2026-10-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-delivery-pipeline/spec.md`

## Summary

Bring devolada's delivery strategy to guide-me, with miabot's previews. One branch, `main`: a pull
request into it runs the gate and gets its own pair of Workers on `workers.dev`, running on dev's
data with the pull request's migrations applied to dev; a merge deploys dev after the same gate; a
`v*` tag releases production — the tag is the approval — only for a commit on `main` whose dev
deploy finished green; a manual run undoes one Worker and proves it took.

Phase 0 read the repository, its Actions history, the Cloudflare account and wrangler 4.99's own
source instead of assuming them. Four findings shaped the design:

- **A renamed dev build would steal dev's hostname.** Dev's build carries `api-dev`'s custom domain
  and the 15-minute cron, and `--name` does not drop them. Previews get their own Worker profile
  with no routes and no triggers (R1).
- **Sign-in on `workers.dev` works.** `workers.dev` is a public suffix, so a preview's app and API
  are the same site, and a host-only session cookie reaches the API from the app. The preview sets
  its three origins per pull request (R2).
- **The repository is public.** Devolada's release archives its production database as an
  artifact; here anyone signed in to GitHub could download it. The release records a D1 Time Travel
  restore point instead — a bookmark, not data (R8).
- **Production's secrets must not move.** Planting secrets from CI, as devolada does, could change
  `QR_SECRET` by a character and invalidate every live ticket. Dev and production keep their
  secrets on their Workers; previews take dev's values from the GitHub `dev` environment (R4).

No application code, copy, schema, migration or test of the apps changes. The code this feature
adds is configuration (two `preview` profiles), workflows, two composite actions and one small
script with its tests.

## Technical Context

**Language/Version**: GitHub Actions YAML; bash in steps; Node 22 for one dependency-free script
(`.github/scripts/preview-note.mjs`) and its `node:test` tests; wrangler 4.99.0 (lockfile) for
deploy, `d1 migrations`, `d1 time-travel`, `rollback`, `deployments status`; the Cloudflare REST API
for the `workers.dev` subdomain and for deleting a preview Worker; the GitHub REST API through `gh`
and `fetch` (runs, comments).

**Primary Dependencies**: `actions/checkout@v7`, `pnpm/action-setup@v6`, `actions/setup-node@v7`,
`actions/upload-artifact@v5` (already in use); GitHub environments `dev` and `production`;
Cloudflare Workers, D1 (`guideme-db`, `guideme-db-prod`) and the account's `workers.dev` subdomain;
the `agnostic-auth` Worker through its service binding.

**Storage**: none added. Previews use dev's `guideme-db`. The release reads a Time Travel bookmark
of `guideme-db-prod`; nothing is exported.

**Testing**: `node --test '.github/scripts/*.test.mjs'` for the comment script (the gate runs it). The pipeline
itself is proven by verification tasks with evidence in the pull request — this feature's implementation
pull request is the first preview, its merge the first dev deploy on `main`, the first tag the first
release, and a deliberate tag on an unproven commit the first refusal (Complexity Tracking).

**Target Platform**: GitHub Actions `ubuntu-latest`; Cloudflare Workers in account `liconadev`
(dev, production and previews side by side).

**Project Type**: pnpm monorepo (`api-turistear`, `app-turistear`); this feature is pipeline,
configuration, guidance and a runbook.

**Performance Goals**: a preview is ready within 10 minutes of a push (gate ≈ 3–4 min, then
migrate + two builds + two deploys + smoke ≈ 3–4 min); cleanup within 2 minutes of a close; a
release gate in under 30 s; a rollback verified within 5 minutes of the click.

**Constraints**: the merge gate stays credential-free and the only merge gate (constitution VI);
never deploy from a laptop; no production row in any artifact, log or summary (FR-017); dev's and
production's secrets stay on their Workers; previews never claim a `turistearya.com` hostname.

**Scale/Scope**: one developer; previews cost 2 Workers each (48 of the account's Workers in use on
2026-10-15); 7 workflows (3 new, 4 rewritten), 2 composite actions, 1 script, 2 Worker profiles.

## Decisions

Code comments cite these as `delivery-pipeline D<n>` (constitution I).

| # | Decision | Made in |
| --- | --- | --- |
| D1 | One branch, `main`. `develop` retires; pull requests target `main` and are squash-merged; worktrees start from `origin/main`. The feature ships in two pull requests — its documentation into `develop`, then its implementation into `main`; the implementation pull request is `develop`'s last trip to `main`, merged with a merge commit so `develop`'s history stays in `main` | spec Clarifications, FR-026; research R11 |
| D2 | A preview is a pair of Workers, `app-guideme-pr-<n>` and `api-guideme-pr-<n>`, on the account's `workers.dev` subdomain, built from a `preview` profile in each `wrangler.jsonc`. The name comes from `--name`; the three origins (`CORS_ORIGIN`, `APP_BASE_URL`, `API_BASE_URL`) from `--var`; the subdomain is read from the account | FR-003, FR-004; research R1, R3 |
| D3 | A preview runs on dev's database and applies the pull request's pending migrations to it with dev's own script before its API deploys. The profile has no `routes` and no `triggers`: dev's sweep already covers the shared database | spec Clarifications, FR-005, FR-006; research R1 |
| D4 | On a preview, the session cookie is host-only (`COOKIE_DOMAIN` empty) and CORS admits only the preview's app. It works because `workers.dev` is a public suffix | FR-007; research R2 |
| D5 | A preview takes `QR_SECRET` and `RESEND_API_KEY` from the GitHub `dev` environment through `--secrets-file`. A missing one is a throwaway value for that preview only, and the comment names the cost. A preview is a target of dev, not a third environment | FR-008; research R4 |
| D6 | A preview deploys only code that passed the gate: `preview.yml` runs the gate as its first job. `ci.yml` keeps `verify` as the one merge gate, never re-run on a label | FR-002; research R5 |
| D7 | One comment per pull request, found by a hidden marker that also carries the migrations the preview has put on dev. A dependency-free Node script renders and upserts it; its pure parts are tested by `node --test` in the gate. Cleanup deletes both Workers through the REST API, HTTP 404 counting as already deleted | FR-009, FR-010; research R6 |
| D8 | The gate is one composite action, `.github/actions/verify`, used by `ci.yml`, `preview.yml`, `deploy-dev.yml` and `deploy-prod.yml`, so a deploy's gate can never again be a subset of the pull request's. The required check keeps the name `verify` | FR-001, FR-012, FR-016; research R7 |
| D9 | Every push to `main` deploys dev — documentation-only commits included — after the gate: dev's migrations, the API, the app, then a smoke of `api-dev` and `app-dev`. Dev deploys queue | FR-012, FR-013; research R11 |
| D10 | The tag is the approval. Production deploys only from a `v*` tag; a `gate` job first requires a successful *Deploy Dev* run for the tagged commit (REST, `head_sha`) and that the commit is on `main`. The `production` environment admits only tags `v*` and the branch `main`. No reviewer click | spec Clarifications, FR-014, FR-015; research R11 |
| D11 | Before migrating, the release records a D1 Time Travel restore point (bookmark and UTC time) of `guideme-db-prod`, and stops if Time Travel does not answer. No database export is ever written: the repository is public | FR-016, FR-017; research R8 |
| D12 | The release keeps each deploy's output and writes, even after a failed step, a summary with the tag, the commit, the restore point and each Worker's live version id | FR-018; research R9 |
| D13 | The smoke probes both production hostnames, 10 tries 30 s apart each (the certificate race devolada measured), tries every host before failing, and a red smoke names *Rollback Prod* | FR-019 |
| D14 | *Rollback Prod* is a manual run on the `production` environment: one Worker (`api` or `app`), one version id, `wrangler rollback --name`, then `wrangler deployments status --json` must show that version at 100% or the run fails. It never touches data and shares the release's concurrency group | FR-021–FR-023; research R9 |
| D15 | The `e2e` label runs the journeys inside `preview.yml`, after the preview is ready, against its addresses. Nightly and manual runs keep dev. Every journey run shares one concurrency group, because they share dev's data | FR-024, FR-025; research R10 |
| D16 | Pull requests from forks get no preview and no credential; documentation-only pull requests (`**.md`, `.claude/**`, `.specify/**`) get no preview. Cleanup runs on every close and stays silent when there was no preview | FR-003, FR-011 |
| D17 | Dev's and production's secrets stay on their Workers; no workflow plants them. A value pasted wrong would invalidate every live ticket, and secret values cannot be compared *Superseded 2026-10-15 by the developer ("Los secrets se manejan a través de GitHub environments"; constitution v1.4.0): secrets are managed in the GitHub environments and every dev and prod deploy plants the API's on its Worker with the version it ships (`--secrets-file`, additive; specs/004-passkey-auth, PR #170).* | Scope boundary; research R4 |
| D18 | The constitution is amended to v1.3.0 through `/speckit-constitution` in the feature's documentation pull request, ahead of the code, as `specs/004-passkey-auth` did: one branch, previews, the tag as the approval, the restore point, the rollback, the gate's new step, the preview as a target of dev, and the migration-name rule | constitution Governance |
| D19 | A migration that has reached dev keeps its file name; two files sharing a number apply in name order | spec Edge Cases; research R13 |

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Planned against v1.2.1. One gate per principle, then the sections this feature rewrites.

| # | Principle | Gate | Verdict |
| --- | --- | --- | --- |
| I | Spec-Driven, Every Decision Cited | Nineteen decisions, each with where it was made. Every rule the workflows, actions, script and Worker profiles gain cites `delivery-pipeline D<n>` beside it. The spec starts from what is broken, with numbers, and its scope boundary is mechanical (no file under the apps' `src/`, `migrations/`, `test/` or `e2e/` changes; every suite passes unedited). The archive guard stays in the gate | PASS |
| II | Money Law | No amount, formatter or ledger row is touched | PASS (N/A) |
| III | Tenant Isolation | No query or route changes. A preview reads dev's data through the same scoped handlers as dev | PASS (N/A) |
| IV | The Server Decides | No rule moves. The QR is still signed by the server; on a preview, with dev's key (D5). "No two environments share a `QR_SECRET`" holds once the amendment states that a preview is a target of dev, not an environment (D18) | PASS with amendment |
| V | Capacity Is Guarded by the Database | No write path changes | PASS (N/A) |
| VI | A Rule Is Proven Where It Is Enforced | No app or API test changes. Playwright still never gates a merge and still runs nightly and on labelled pull requests — against the pull request's own preview now (D15). The new `preview-note.test.mjs` cites `delivery-pipeline US1`. The pipeline's own proof is verification tasks with evidence (Complexity Tracking) | PASS (with judgement) |
| VII | Elegant Field Minimalism | No screen, token or product copy. The preview comment is a repository artifact, in English | PASS (N/A) |
| VIII | A Service We Do Not Own Never Undoes a Sale | No provider moves. Secrets stay in Worker secrets and GitHub environments; dev's and production's are not re-planted (D17). Previews carry dev's values (D5), stated in the amendment | PASS with amendment |

**Technology Stack & Constraints**: the *Environments* row ("`dev` from `develop` … `prod` from
`main`") no longer describes the pipeline: dev comes from `main`, production from `v*` tags, and a
preview per pull request runs beside dev. The migration constraint gains D19. "Every deploy and
every remote migration is environment-scoped … deploys go through CI" holds: the preview's
migration is dev's own `db:migrate:dev`, run by CI.

**Development Workflow & Quality Gates**: this feature rewrites five bullets — worktrees from
`origin/develop`; pull requests into `develop` and release pull requests into `main`; the `verify`
list (it gains the pipeline-script tests); "a push to `develop` deploys dev"; "a push to `main`
deploys prod … after a required reviewer approves". Governance says: when a principle blocks a
feature, the plan says so and proposes the amendment. D18 is that amendment, landing with the
feature's documentation, so the law changes before the code that needs it merges.

**Post-design re-check (after Phase 1)**: PASS. The contracts describe workflows, a comment and two
environments, not an API; the data model adds no table; the runbook prescribes acts, not code. The
two amendments (IV, VIII) and the workflow rewrite are one MINOR version (expanded guidance, no
principle removed or renumbered).

## Project Structure

### Documentation (this feature)

```text
specs/005-delivery-pipeline/
├── plan.md                    # This file
├── research.md                # Phase 0 — R1–R13
├── data-model.md              # Phase 1 — preview, comment, release, restore point, rollback, environments
├── quickstart.md              # Phase 1 — THE RUNBOOK: cutover, preview, dev, release, refusal, undo, restore
├── contracts/
│   ├── pipeline.md            #   every workflow: trigger, order, refusals, outputs, concurrency, credentials
│   ├── preview-comment.md     #   the one comment: marker, fields, states
│   └── environment.md         #   what lives outside the repository, who sets it, how it is checked
├── checklists/
│   └── requirements.md
├── spec.md
└── tasks.md                   # Phase 2 (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
.github/
├── actions/
│   ├── setup/action.yml       # + pnpm 10, Node 22, frozen-lockfile install — one place
│   └── verify/action.yml      # + the gate (D8): archive guard, lint:app, test:app, test:api,
│                              #   build:api, build:app, node --test .github/scripts
├── scripts/
│   ├── preview-note.mjs       # + render and upsert the one preview comment (D7)
│   └── preview-note.test.mjs  # + node:test — delivery-pipeline US1
└── workflows/
    ├── ci.yml                 # ~ pull requests into main; `verify` through the action (D6, D8)
    ├── preview.yml            # + gate → deploy (migrate dev, API, app, smoke) → journeys (label) → note
    ├── preview-cleanup.yml    # + on close: delete both Workers, note (D7, D16)
    ├── deploy-dev.yml         # ~ push to main, no paths-ignore; gate → migrate → API → app → smoke (D9)
    ├── deploy-prod.yml        # ~ v* tag; gate (D10) → verify → restore point (D11) → migrate → API →
    │                          #   app → what landed (D12) → smoke (D13)
    ├── rollback-prod.yml      # + manual: one Worker, one version, verified (D14)
    └── e2e.yml                # ~ nightly and manual only, against dev; shared concurrency (D15)

api-turistear/wrangler.jsonc   # ~ + env.preview (D2–D4)
app-turistear/wrangler.jsonc   # ~ + env.preview (D2)
.specify/memory/constitution.md # ~ v1.3.0 through /speckit-constitution (D18)
CLAUDE.md                      # ~ the workflow section: one branch, previews, the tag (D1)

api-turistear/src, migrations, test · app-turistear/src, e2e   # unchanged (scope boundary)
```

Outside the tree, by the runbook ([contracts/environment.md](./contracts/environment.md)): the
`dev` environment admits every branch and may hold `QR_SECRET` and `RESEND_API_KEY`; the
`production` environment admits tags `v*` and `main`; `main` requires `verify`; open pull requests
move to `main`; `develop` is deleted.

**Structure Decision**: the two apps stay as they are. Everything this feature adds lives under
`.github/` (where GitHub looks for workflows and local actions) and in the two `wrangler.jsonc`
files the preview builds from.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified

| Judgement | Why | Simpler alternative rejected because |
| --- | --- | --- |
| Stories proven by verification tasks with evidence, not by cited test files (VI) | The feature's runtime is a CI run against real Workers. A test that mocks GitHub and Cloudflare would prove the mocks. Only the comment script's pure parts are unit-tested | A local `act` harness was considered: it cannot reach the account and would not prove the deploy. Instead, each story is exercised for real on this feature's implementation pull request (preview, cleanup), its merge (dev), the first tag (release), a deliberate refused tag (gate) and a rollback rehearsal (undo), with the run links recorded in the pull request |
| The gate runs twice per push to a pull request (D6) | A preview migrates the shared dev database; only code that passed the API suite — which applies every migration — may do that | Running the preview after `ci.yml` through `workflow_run` loses the pull request's label and context; putting the preview inside `ci.yml` would re-run `verify` on a label and could turn a red required check green. Public-repository minutes are free; the cost is about 4 minutes of wall time |
