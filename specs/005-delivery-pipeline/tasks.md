# Tasks: delivery-pipeline

**Input**: Design documents from `/specs/005-delivery-pipeline/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: one unit-test file, for the comment script's pure parts (plan, Testing). Every story is
otherwise proven by a verification task whose evidence — a run link — is recorded in the pull
request (plan, Complexity Tracking).

**Organization**: tasks are grouped by user story. The feature ships in two pull requests: this
documentation, with the constitution amendment (T003), into `develop`; then every other task in
**one implementation pull request into `main`** — the cutover needs the old "deploy on push to
`main`" workflow gone in the same merge that brings the tag release (D1, quickstart §0).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: the user story the task serves (US1–US5)
- Every rule a file gains cites `delivery-pipeline D<n>` in a comment beside it (constitution I)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: the two composite actions every workflow uses.

- [ ] T001 Create `.github/actions/setup/action.yml`: a composite action running `pnpm/action-setup@v6` (version 10), `actions/setup-node@v7` (Node 22, pnpm cache) and `pnpm install --frozen-lockfile` — contracts/pipeline.md "setup"
- [ ] T002 Create `.github/actions/verify/action.yml`: a composite action that uses `./.github/actions/setup`, then the archive guard (moved from `ci.yml`, its comment kept), `pnpm lint:app`, `pnpm test:app`, `pnpm test:api`, `node --test '.github/scripts/*.test.mjs'`, `pnpm build:api`, `pnpm build:app`, citing D8 — contracts/pipeline.md "verify"

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the law, the merge gate and the preview profiles every story leans on.

**⚠️ CRITICAL**: no story is done until this phase is.

- [X] T003 Amend `.specify/memory/constitution.md` to v1.3.0 through `/speckit-constitution` (D18): Development Workflow & Quality Gates (one branch `main`, worktrees from `origin/main`, squash merges, no release pull requests; the gate gains `node --test '.github/scripts/*.test.mjs'`; a push to `main` deploys dev after the gate; a `v*` tag releases production and is the approval, refused unless the commit is on `main` with a green dev deploy; a Time Travel restore point before migrating; *Rollback Prod*; a preview per pull request on dev's data, applying its migrations to dev, never a merge gate); the Environments row; principle IV's and VIII's signing-secret rule (a preview is a target of dev); principle VI's Playwright bullet (labelled runs use the pull request's preview); the migration constraint (D19); and the Sync Impact Report
- [ ] T004 Rewrite `.github/workflows/ci.yml`: `pull_request` into `main` only (opened, synchronize, reopened), job `verify` = checkout + `./.github/actions/verify`, no credentials, citing D6 and D8 — contracts/pipeline.md "ci.yml"
- [ ] T005 [P] Add the `preview` environment to `api-turistear/wrangler.jsonc`: `workers_dev: true`, no `routes`, no `triggers`, dev's `guideme-db`, the `agnostic-auth` service, `COOKIE_DOMAIN` empty and the three origins empty (filled by `--var`), with the header line and comments citing D2–D4 — research R1, R2
- [ ] T006 [P] Add the `preview` environment to `app-turistear/wrangler.jsonc`: `workers_dev: true`, no `routes`, with the header comment citing D2 — research R1

**Checkpoint**: `CLOUDFLARE_ENV=preview` builds of both apps produce configs with no routes and no triggers; `wrangler deploy --dry-run --name <app>-guideme-pr-999` accepts both.

---

## Phase 3: User Story 1 — Every pull request has its own preview (Priority: P1) 🎯 MVP

**Goal**: a pull request into `main` gets one comment with its own app and API addresses, on dev's data; closing it deletes both Workers.

**Independent Test**: the implementation pull request shows the comment; a dev account signs in on its app address; after the merge both Workers are gone.

### Tests for User Story 1

- [ ] T007 [P] [US1] Write `.github/scripts/preview-note.test.mjs` with `node:test`, citing `delivery-pipeline US1`: parsing the marker; merging migration lists (union, name order, no duplicates, never shrinking); rendering `ready`, `failed`, `deleted` and `not deleted`; the stays-on-dev line only for an unmerged close with migrations; the throwaway-secrets section only when names are given — contracts/preview-comment.md

### Implementation for User Story 1

- [ ] T008 [US1] Write `.github/scripts/preview-note.mjs` (Node 22, no dependencies): pure `parseMarker`, `mergeMigrations`, `render`; and a CLI that reads its inputs from the environment, finds the comment by marker through the GitHub REST API, and creates or edits it (never creates one on `cleanup`), citing D7 — contracts/preview-comment.md
- [ ] T009 [US1] Create `.github/workflows/preview.yml` with jobs `gate` (the verify action, D6), `deploy` (environment `dev`: subdomain from the account, names and origins, pending migrations listed then applied with `pnpm db:migrate:dev`, the secrets file from `QR_SECRET`/`RESEND_API_KEY` or throwaway values, API build and deploy with `--name`/`--var`/`--secrets-file`, app build with the API origin and deploy with `--name`, smoke) and `note` (whatever the result, unless cancelled), the fork and label conditions, `paths-ignore` and concurrency per pull request — contracts/pipeline.md "preview.yml", D2–D7, D16
- [ ] T010 [US1] Create `.github/workflows/preview-cleanup.yml`: on `closed`, same-repository only, environment `dev`, concurrency shared with the preview, delete both Workers through the REST API (404 = absent), then the note in `cleanup` mode — contracts/pipeline.md "preview-cleanup.yml", D7
- [ ] T011 [US1] Verify on the implementation pull request (quickstart §1): one comment, both addresses answer, a dev account signs in on the app address, a second push edits the same comment. Record the run links in the pull request
- [ ] T012 [US1] Verify after the merge (quickstart §1): the implementation pull request's comment says `deleted` and `api-guideme-pr-<n>` / `app-guideme-pr-<n>` are absent from the account. Record the run link

**Checkpoint**: User Story 1 works on its own — every later pull request gets a preview.

---

## Phase 4: User Story 2 — A merge to `main` updates dev, after the same gate (Priority: P1)

**Goal**: one branch; every push to `main` runs the gate, then deploys dev and smokes it.

**Independent Test**: the merge commit of the implementation pull request has a green *Deploy Dev* run with gate, migrations, API, app and smoke in that order.

- [ ] T013 [US2] Rewrite `.github/workflows/deploy-dev.yml`: `push` to `main` with no `paths-ignore`, concurrency `deploy-dev` queued; job `verify` (the action), then `deploy` (environment `dev`): `pnpm db:migrate:dev`, `pnpm deploy:api:dev`, `pnpm deploy:app:dev`, smoke of `api-dev` and `app-dev` (10 tries, 30 s apart, every host tried), citing D8 and D9 — contracts/pipeline.md "deploy-dev.yml"
- [ ] T014 [P] [US2] Update `CLAUDE.md` "Local workflow": worktrees from `origin/main`, pull requests into `main`, squash merges, no release pull requests; a release is a `v*` tag (the tag is the approval); each pull request gets a preview on dev's data; never rename a migration that reached dev; the runbook is `specs/005-delivery-pipeline/quickstart.md` (D1)
- [ ] T015 [P] [US2] Replace every remaining live instruction that names `develop` as the branch to work from or deploy from — `README.md` (§ Environments and the PR flow), comments in `.github/` — leaving archive citations and specs' history intact (FR-026); and update `app-turistear/e2e/README.md` (the one file under `e2e/` the scope boundary admits) to say labelled runs now use the pull request's preview from `preview.yml`, where a host-only cookie on the preview's API works because `workers.dev` is a public suffix (D4, D15)
- [ ] T016 [US2] Verify the cutover (quickstart §0): the developer sets E1–E7; the merge commit's *Deploy Dev* is green; `develop` is gone. Record the run link

**Checkpoint**: Stories 1 and 2 both work; nothing reaches production yet.

---

## Phase 5: User Story 3 — A tag releases production, and only a proven commit (Priority: P1)

**Goal**: a `v*` tag on a commit proven on dev releases production with a restore point, a record of what landed and a smoke.

**Independent Test**: a tag on an unproven commit is refused at `gate`; `v1.0.0` on the green merge commit releases and its summary lists the restore point and both version ids.

- [ ] T017 [US3] Rewrite `.github/workflows/deploy-prod.yml`: `push` of `v*` tags, concurrency `deploy-prod` queued; `gate` (green *Deploy Dev* for `head_sha` via `gh api`, ancestor of `origin/main`), `verify` (the action), `deploy` (environment `production`: Time Travel bookmark of `guideme-db-prod` and UTC time — stop without one; `pnpm db:migrate:prod`; `pnpm deploy:api:prod` and `pnpm deploy:app:prod` with their output kept; *What landed* summary on `always()`; smoke of `api` and `app` naming *Rollback Prod*), with no export and no secret printed, citing D10–D13 — contracts/pipeline.md "deploy-prod.yml"
- [ ] T018 [US3] Verify (quickstart §3, §4): the refused tag stops at `gate` with "No green Deploy Dev run" and is deleted; `v1.0.0` on the merge commit releases; its *What landed* lists a bookmark and both version ids, and the smoke is green. Record both run links

**Checkpoint**: production is released only by a tag, only on a proven commit.

---

## Phase 6: User Story 4 — One Worker can be undone from CI (Priority: P2)

**Goal**: a manual run returns one production Worker to one version and proves it.

**Independent Test**: roll `app-guideme` back to its previous version and forward to the current one, each run green with the live version read back.

- [ ] T019 [P] [US4] Create `.github/workflows/rollback-prod.yml`: `workflow_dispatch` with `worker` (`api` | `app`) and `version_id`, environment `production`, concurrency `deploy-prod`; `wrangler rollback <id> --name <worker> -y -m …`, then `wrangler deployments status --name <worker> --json` must show `version_id` at 100%, else fail "Nothing moved"; summary naming the restore point as the only way back for data, citing D14 — contracts/pipeline.md "rollback-prod.yml"
- [ ] T020 [US4] Verify (quickstart §5) after the first release: roll the app back to the version before `v1.0.0`, then forward to `v1.0.0`'s; both runs green. Record the run links

---

## Phase 7: User Story 5 — The journeys run against the pull request's own preview, on request (Priority: P3)

**Goal**: the `e2e` label runs the journeys against that pull request's preview; nightly keeps dev.

**Independent Test**: on a labelled pull request, the `journeys` log shows the preview's addresses as `E2E_BASE_URL` and `E2E_API_BASE`.

- [ ] T021 [US5] Add the `journeys` job to `.github/workflows/preview.yml`: needs `deploy`, runs only with the `e2e` label, environment `dev`, concurrency `e2e-dev-data` never cancelled, Chromium install, `pnpm --filter app-turistear test:e2e` with the preview's origins and the `E2E_*` secrets, the report uploaded always; the note reports its result, citing D15 — contracts/pipeline.md "preview.yml"
- [ ] T022 [P] [US5] Edit `.github/workflows/e2e.yml`: drop the `pull_request` trigger and its job condition, set concurrency `e2e-dev-data`, and update its header comment (labelled runs now live in `preview.yml`), citing D15
- [ ] T023 [US5] Verify (quickstart §7): label a pull request `e2e`; the `journeys` log shows the preview's origins and the comment shows the result (red is expected until the journeys' own bug is fixed — spec Scope boundary). Record the run link

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T024 Lint every workflow and action with `actionlint` (and its `shellcheck` pass) and fix what it reports
- [ ] T025 Run the gate locally — archive guard, `pnpm lint:app`, `pnpm test:app`, `pnpm test:api`, `node --test '.github/scripts/*.test.mjs'`, `pnpm build:api`, `pnpm build:app` — and the preview dry runs from the Phase 2 checkpoint
- [ ] T026 Prove the scope boundary: `git diff --stat origin/develop -- api-turistear/src api-turistear/migrations api-turistear/test app-turistear/src app-turistear/e2e ':!app-turistear/e2e/README.md'` prints nothing
- [ ] T027 Run `/speckit-analyze`; no CRITICAL finding remains
- [ ] T028 After T011–T023, set the spec's **Status** to Implemented and amend spec, plan, research or the runbook (`quickstart.md`, FR-027) with anything the build taught (constitution I)

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)** → **Foundational (Phase 2)** → the stories.
- T002 needs T001, and its `node --test` step needs T007 to exist before the gate can pass.
- **US1** needs Phase 2 (profiles, gate). It is the MVP, and the implementation pull request's own preview proves it.
- **US2** needs Phase 1. Its verification (T016) is the cutover, after the merge.
- **US3** needs US2: the release gate reads *Deploy Dev* runs on `main`.
- **US4** needs US3 for its rehearsal (a release to roll back from); its workflow (T019) can be written any time.
- **US5** needs US1 (`preview.yml`).
- **Polish** runs before the pull request is opened (T024–T027) and after the verifications (T028).

### Within stories

- T007 before T008 (the tests describe the script).
- T009 before T021 (same file).
- Verification tasks run in this order on the real repository: T011 (pull request open) → merge → T012, T016 → T018 → T020; T023 whenever a labelled pull request runs.

### Parallel opportunities

- T005 and T006 (two files).
- T007 alongside T004–T006.
- T013, T017, T019 and T022 touch different files and can be written side by side once Phase 1 exists.
- T014 and T015 are documentation, parallel to everything.

## Parallel Example: User Story 1

```text
T007  .github/scripts/preview-note.test.mjs     (tests first)
T008  .github/scripts/preview-note.mjs          (after T007)
T009  .github/workflows/preview.yml             (after T008 for the note step)
T010  .github/workflows/preview-cleanup.yml     (parallel to T009)
```

## Implementation Strategy

### MVP first

Phases 1–3: the gate as one action, the preview profiles and the preview with its cleanup. Pointing
the implementation pull request at `main` is the MVP's own test (T011).

### Then, in the same implementation pull request

Phases 4–7 complete the cutover; none of them can ship alone, because merging any part without
the rest would leave `main` deploying production on push (today's `deploy-prod.yml`) beside a new
dev deploy on the same push.

### After the merge

The verification tasks T012, T016, T018, T020 and T023 run on the real repository in the order
above, each with its run link added to the pull request, then T028 closes the spec.
