# Feature Specification: One branch, a preview per pull request, a tag for production

**Feature Branch**: `feat/delivery-pipeline`

**Created**: 2026-10-15

**Status**: Planned — this documentation goes into `develop`; the implementation follows in its own pull request into `main`

**Input**: the developer: *"Implementa la misma estrategia de CI/CD que tiene devolada, con los
preview de miabot, para este repo, guide me. Utiliza los comandos de speckit para planear esta
feature."* Devolada's strategy is its `specs/006-production-launch` and the workflows it runs
today; miabot's previews are its `preview.yml` / `preview-cleanup.yml` (one pair of Workers per pull
request, deleted when the pull request closes).

## Clarifications

### Session 2026-10-15

- Q: How does code reach dev and production? → A: **One branch, as in devolada.** `develop`
  retires. Pull requests target `main`; a merge to `main` updates dev; a `vX.Y.Z` tag releases
  production. The feature ships in two pull requests: this documentation into `develop`, then
  the implementation into `main`, which is `develop`'s last trip there.
- Q: What act of the developer approves a production release? → A: **The tag alone.** Pushing
  `vX.Y.Z` is the deliberate act. Before production is touched, the release checks that the commit
  is on `main` and that its dev deploy finished green, and refuses otherwise. No reviewer click,
  although this public repository could have one.
- Q: When a pull request carries a migration, what does its preview do? → A: **It applies the
  migration to dev's database when the preview deploys**, as devolada and miabot do, so the preview
  works in full. The cost is accepted: the migration reaches dev before the merge, and an abandoned
  or renamed migration stays on dev and is fixed forward. The preview note names what it applied.

## What is broken, with numbers

Measured on 2026-10-15 against the repository, its Actions history and the Cloudflare account.

1. **Nobody can open a change before it merges.** 205 CI runs have proven that pull requests
   compile and pass their tests; none of them produced an address. To see a screen, the reviewer
   runs the stack locally — where, without `.dev.vars`, sign-in answers 200 and no session
   (CLAUDE.md) — or merges into `develop`, where the change becomes dev for everyone.
2. **The `e2e` label tests dev, not the pull request.** `e2e.yml` points the journeys at
   `app-dev.turistearya.com` whatever the labelled pull request contains, so a labelled run proves
   code that is already merged.
3. **Two long-lived branches drift.** On 2026-10-15 `main` held 6 commits `develop` did not (five
   release merge commits and #162, a spec pull request that targeted `main` by mistake), and
   `develop` held one that `main` did not (#163, the same spec, amended). The squashed releases #84
   and #99 cost #108 eleven phantom conflicts (constitution, Development Workflow). Each of the 17
   production releases needed its own release pull request.
4. **Production trusts any push to `main`.** `deploy-prod.yml` deploys on every push to `main`,
   and its only check is `test:api` — a subset of the pull-request gate (no lint, no app tests, no
   build). Nothing asks whether the commit ran green on dev first.
5. **A bad release has no undo.** No run records which Worker version went live, nor where the
   production database stood before its migrations — and on 2026-10-06 migration 0069 dropped four
   tables there. An undo means finding a version id by hand and running wrangler from a laptop,
   which the constitution forbids ("deploys go through CI").
6. **The repository is public.** Devolada's release archives its production database as a
   workflow artifact. Here any signed-in GitHub user could download that artifact: the tourists'
   names, emails and phones, and every organization's sales and cash. Devolada's archive cannot be
   copied as it is.

## Scope boundary

In scope: the GitHub workflows (pull-request gate, preview and its cleanup, dev deploy, production
release, rollback, nightly journeys); a `preview` profile in each app's Worker configuration;
the constitution amendment the new workflow needs (through `/speckit-constitution`); CLAUDE.md's
workflow section; and the runbook for the cutover, a release and an undo.

Out of scope:

- Application code, copy, schema and migrations. Nothing a tourist, an agent or an admin sees
  changes.
- The nightly journeys' own failures. Since at least 2026-10-11, 3 of the 7 journeys fail on dev
  (for example a strict-mode clash on "Saldo por cobrar" in `settle-breakdown.spec.ts`). That is a
  bug for the lite path; until it is fixed, a labelled run on a preview is red for the same
  reasons.
- Passkey sign-in (`specs/004-passkey-auth`). It is specified and not built; this feature leaves
  the preview profile ready for its variables and its secret, and 004 fills them.
- Moving dev's or production's secrets. They stay on their Workers as today.
- Previews on `turistearya.com` hostnames.

The mechanical test: every API suite and every app suite passes **unedited**, and no file under
`api-turistear/src/`, `api-turistear/migrations/`, `api-turistear/test/`, `app-turistear/src/` or
`app-turistear/e2e/` changes — except `app-turistear/e2e/README.md`, a document, which is
updated to say where labelled runs now happen.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every pull request has its own preview (Priority: P1)

The developer opens a pull request and, a few minutes later, finds one comment on it with two
addresses: the app and the API, built from exactly the pull request's latest commit. They open the
app on a phone, sign in with a dev account, and sell, collect or cancel on dev's data as if the
change were already merged. Every push updates the same comment. When the pull request closes,
merged or not, the two Workers are deleted and the comment says so.

**Why this priority**: it is the request, and it is the one thing the pipeline cannot do today
(broken #1). Every later review of a screen — passkeys first — is faster with it.

**Independent Test**: open a pull request that changes the app, wait for the comment, sign in on
its app address, then close the pull request and check that both Workers are gone.

**Acceptance Scenarios**:

1. **Given** a pull request into `main` from a branch of this repository that changes code,
   **When** it opens or receives a push, **Then** within 10 minutes one comment shows the app
   address, the API address and the commit they serve.
2. **Given** that preview, **When** a dev user signs in on its app address, **Then** the session
   sticks, and the app reads and writes dev's data through the preview's own API.
3. **Given** a second push, **When** its preview is ready, **Then** the same comment shows the new
   commit, and the pull request still has exactly one preview comment.
4. **Given** a pull request that adds a migration, **When** its preview deploys, **Then** the
   migration is applied to dev's database before the preview's API starts, and the comment names
   every migration that run applied.
5. **Given** an open preview, **When** the pull request closes, **Then** within 10 minutes both of
   its Workers are deleted and the comment says so. If the pull request was not merged and its
   preview applied a migration, the note says that the migration stays on dev.
6. **Given** a pull request from a fork, **When** it opens, **Then** no preview is built and no
   credential is used; the gate still runs.
7. **Given** a pull request that changes only documentation, **When** it opens, **Then** no
   preview is built.
8. **Given** a preview whose deploy fails, **When** the run ends, **Then** the comment says it
   failed and links the run, and the pull request's gate result is unaffected.

---

### User Story 2 - A merge to `main` updates dev, after the same gate (Priority: P1)

There is one long-lived branch. The developer merges a pull request into `main`; the pipeline runs
the full pull-request gate again, then migrates dev's database, deploys the API, deploys the app,
and proves that both dev hostnames answer. `develop` no longer exists, so nothing deploys from it
and no release pull request is ever written again.

**Why this priority**: the preview and the release both lean on it — a preview runs on dev's data,
and a release may only take a commit that this deploy turned green.

**Independent Test**: merge a pull request into `main` and read the run: gate, migrations, API, app,
smoke, in that order.

**Acceptance Scenarios**:

1. **Given** a merge into `main`, **When** its run starts, **Then** it runs the same checks as the
   pull-request gate before any deploy step, then dev's migrations, the API, the app, and a smoke
   that proves `api-dev` and `app-dev` answer.
2. **Given** a commit on `main` that fails the gate, **When** its run ends, **Then** nothing was
   deployed to dev.
3. **Given** two merges seconds apart, **When** both runs start, **Then** they queue and never
   deploy at the same time.
4. **Given** a merge that changes only documentation, **When** it lands, **Then** dev is deployed
   anyway, so that every commit on `main` can be released.
5. **Given** the cutover is done, **When** anyone looks for `develop`, **Then** it no longer
   deploys anything, open pull requests target `main`, and CLAUDE.md and the constitution describe
   one branch.

---

### User Story 3 - A tag releases production, and only a proven commit (Priority: P1)

When dev looks right, the developer tags the commit `vX.Y.Z` and pushes the tag. The release first
checks that the commit is on `main` and that its dev deploy finished green; it refuses otherwise,
before touching anything. Then it runs the gate again, records a restore point of the production
database, applies the migrations, deploys the API and then the app, writes down which version of
each Worker went live, and proves that both production hostnames answer.

**Why this priority**: production is where agents sell with cash in hand. Today any push to
`main` reaches it unproven (broken #4), and nothing records where it stood before (broken #5).

**Independent Test**: push a tag on a commit with no green dev deploy and see it refused; push a tag
on a green one and read the release summary.

**Acceptance Scenarios**:

1. **Given** a commit on `main` whose dev deploy finished green, **When** the developer pushes
   `vX.Y.Z` on it, **Then** the release runs the gate, records the restore point, migrates, deploys
   the API then the app, and smokes `api.turistearya.com` and `app.turistearya.com`.
2. **Given** a tag on a commit that is not on `main`, or whose dev deploy failed, is still running
   or never ran, **When** the release starts, **Then** it stops before any production step and
   says which condition failed.
3. **Given** a merge into `main`, **When** it lands, **Then** production is not touched.
4. **Given** any release, **When** it ends — even after a failed step — **Then** its summary states
   the tag, the restore point taken before migrating, and the version id of each Worker that went
   live (or that a Worker was not deployed).
5. **Given** any release or rollback, **When** its logs and artifacts are read, **Then** they hold
   no row of the production database.
6. **Given** a release whose smoke fails, **When** the run ends, **Then** it is red and its message
   points at the undo (User Story 4).

---

### User Story 4 - One Worker can be undone from CI (Priority: P2)

A release went live and something is wrong. The developer opens Actions, runs *Rollback Prod*,
picks the Worker (API or app) and pastes the version id from the release summary. That Worker
serves that version within minutes, and the run is green only if the live version is the one asked
for. The database is never touched; the run says how to restore it from the restore point, which
stays a deliberate act.

**Why this priority**: it turns broken #5 into a click, but it is only needed after a bad release,
which User Story 3 already makes less likely.

**Independent Test**: roll the production app back to its previous version and forward again,
reading the verdict each time.

**Acceptance Scenarios**:

1. **Given** a version id of the production API or app, **When** the developer runs the rollback
   with it, **Then** that Worker serves that version, and the run is green only after reading the
   live deployment and finding that version.
2. **Given** a rollback the platform declines without an error, **When** the run reads the live
   deployment, **Then** the run is red and says that nothing moved.
3. **Given** any rollback, **When** it ends, **Then** the database, the secrets and the other
   Worker are unchanged, and the summary names the restore point as the way to recover data.
4. **Given** a release in flight, **When** a rollback starts, **Then** it waits for the release to
   finish instead of racing it.

---

### User Story 5 - The journeys run against the pull request's own preview, on request (Priority: P3)

The developer adds the `e2e` label to a pull request. Once its preview is up, the Playwright
journeys run against the preview's addresses — the pull request's code, not dev's — and the report
is kept. Without the label they do not run; they never block a merge. The nightly run keeps
testing dev.

**Why this priority**: it fixes broken #2, but the journeys are red on dev today (Scope boundary),
so its value arrives with that fix.

**Independent Test**: label a pull request `e2e` and read which addresses the journeys used.

**Acceptance Scenarios**:

1. **Given** a pull request labelled `e2e`, **When** its preview is ready, **Then** the journeys run
   against the preview's app and API addresses and their report is kept as an artifact.
2. **Given** a pull request without the label, **When** its preview deploys, **Then** the journeys
   do not run, and the merge never waits for them.
3. **Given** the nightly schedule, **When** it fires, **Then** the journeys run against dev.
4. **Given** two journey runs (nightly, labelled or by hand), **When** they start together,
   **Then** the second waits: they share dev's data.

### Edge Cases

- **Two pull requests add migrations with the same number.** Both previews apply their file to dev.
  The second to merge keeps its file name: a migration that has reached dev is never renamed,
  because a renamed file looks new to dev and fails there. Two files that share a number apply in
  name order.
- **A pull request closes unmerged after its preview applied a migration.** The schema change stays
  on dev and is fixed forward by a later migration; the closing note says so.
- **A destructive migration** (a drop) reaches dev with the preview, before the merge. The
  constitution already requires every migration to be compatible with the code already deployed,
  so a drop is only written after dev's code stopped reading what it drops.
- **The preview shares dev's data.** What is sold on a preview stays in dev. A ticket sold on a
  preview encodes the preview's API address, so its QR stops resolving when the preview is deleted.
- **The scheduled sweep** (bookings auto-expiry, every 15 minutes) does not run on previews; dev's
  sweep already covers the shared database.
- **Secrets missing for previews.** A preview uses dev's secret values when the dev GitHub
  environment holds them. When one is missing, the preview gets a throwaway value and the comment
  names what it costs (for example, tickets signed on that preview do not validate on dev).
- **Worker capacity.** Each open preview costs 2 Workers. The account held 48 Workers on
  2026-10-15; if its plan caps them at 100, about 26 previews can be open at once, and a deploy
  past the cap fails with the platform's message in the comment.
- **The account's `workers.dev` subdomain is unknown or disabled**, or the token cannot read it.
  The preview fails with a message that names the fix.
- **A tag on a commit whose dev deploy is still running** is refused. Once dev turns green, the
  developer re-runs the refused release; it is the same commit and the same tag.
- **The restore point is only kept for 30 days.** A data restore older than that is impossible; the
  runbook says so.
- **A rollback to a version older than a migration** is safe: migrations are backward-compatible
  with the code already deployed, so an older Worker keeps working on a newer schema.
- **A pull request reopened** after closing gets a fresh preview.

## Requirements *(mandatory)*

### Functional Requirements

**The pull-request gate**

- **FR-001**: Every pull request into `main` MUST run the gate the constitution names: the archive
  guard, a frozen-lockfile install, app lint, app tests, API tests, the pipeline scripts' tests,
  API build and app build. It MUST NOT need any credential, so it runs the same for forks.
- **FR-002**: The gate MUST stay the only merge gate; neither the preview nor the journeys may
  block a merge.

**Previews**

- **FR-003**: Every pull request into `main` from a branch of this repository that changes more
  than documentation MUST get its own pair of Workers — an app and an API — named after the pull
  request number and reachable on the account's `workers.dev` addresses.
- **FR-004**: A preview MUST serve exactly the pull request's latest commit; a new push replaces it,
  and a run for an older commit that is still in flight MUST be cancelled.
- **FR-005**: A preview's API MUST use dev's database. Before it starts, every migration of the
  pull request not yet applied to dev MUST be applied to dev (Clarifications, 2026-10-15).
- **FR-006**: A preview MUST NOT claim dev's or production's hostnames, and MUST NOT run the
  scheduled sweep.
- **FR-007**: A dev user MUST be able to sign in on a preview's app address and stay signed in, the
  preview's API accepting requests only from its own app address.
- **FR-008**: A preview MUST use dev's secret values when the dev environment holds them. A missing
  one MUST be replaced by a throwaway value for that preview only, and the comment MUST name the
  consequence.
- **FR-009**: Each pull request MUST carry exactly one preview comment, updated in place. It states
  the app and API addresses, the commit served, the migrations the run applied to dev, and the
  result of the deploy (and of the journeys, when they ran), with a link to the run.
- **FR-010**: When a pull request closes, merged or not, both of its Workers MUST be deleted. The
  deletion MUST be idempotent (a Worker already gone counts as deleted), and the comment MUST say
  what was deleted and, for an unmerged pull request whose preview applied a migration, that the
  migration stays on dev.
- **FR-011**: A pull request from a fork MUST get no preview and no credential.

**Dev**

- **FR-012**: Every push to `main` MUST run the same checks as the gate, then dev's migrations,
  then the API, then the app, then a smoke that proves both dev hostnames answer. A failed gate
  deploys nothing.
- **FR-013**: Dev deploys MUST queue, never race, and MUST run for documentation-only commits too.

**Production**

- **FR-014**: Production MUST be released only by pushing a `v*` tag; the tag is the approval
  (Clarifications, 2026-10-15). A push to `main` MUST NOT touch production.
- **FR-015**: Before any production step, the release MUST refuse a commit that is not on `main` or
  whose dev deploy did not finish green, naming the failed condition.
- **FR-016**: The release MUST run the gate's checks again, then record a restore point of the
  production database, then apply its migrations, then deploy the API, then the app.
- **FR-017**: The restore point MUST stay inside Cloudflare. No release, rollback or other run may
  write a row of the production database to an artifact, a log or a summary.
- **FR-018**: The release summary MUST state the tag, the commit, the restore point and the version
  id of each Worker that went live — written even when a later step fails.
- **FR-019**: The release MUST smoke both production hostnames, each with its own wait for a
  certificate race, and a red smoke MUST point at the rollback.
- **FR-020**: Releases MUST queue, never race.

**Undo**

- **FR-021**: A manual *Rollback Prod* run MUST take one Worker (API or app) and one version id,
  make that version live, and pass only after reading the live deployment and finding that
  version.
- **FR-022**: A rollback MUST NOT touch the database, the secrets or the other Worker, and MUST say
  that recovering data is a separate act on the restore point.
- **FR-023**: A rollback MUST wait for a release in flight, and a release for a rollback.

**Journeys**

- **FR-024**: The `e2e` label on a pull request MUST run the journeys against that pull request's
  preview addresses once the preview is ready, and keep their report.
- **FR-025**: The nightly and manual journey runs MUST keep targeting dev, and no two journey runs
  may overlap.

**The cutover and the law**

- **FR-026**: After the cutover, `develop` MUST deploy nothing, and every rule that names it — the
  constitution, CLAUDE.md, the workflows — MUST describe one branch, `main`.
- **FR-027**: A runbook MUST tell the developer, step by step, how to finish the cutover (the
  settings that live outside the repository), how to release, how to read a release, how to undo a
  Worker and how to restore data from a restore point.

### Key Entities

- **Preview**: one per open pull request. Its pull request number, its two Workers and their
  addresses, the commit served, the migrations it applied to dev, and its state (deploying, ready,
  failed, deleted).
- **Preview comment**: the single note on the pull request that states the preview's current
  state; updated in place, never duplicated.
- **Release**: one per `v*` tag. Its commit, the gate's verdict, the restore point, the version of
  each Worker that went live, and the smoke's verdict.
- **Restore point**: where the production database stood immediately before a release migrated it;
  usable for 30 days; never leaves Cloudflare.
- **Rollback**: one Worker, one version id, and the verdict read back from the live deployment.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer can open a pull request's change in a browser, signed in, within 10 minutes
  of the push, without running anything locally.
- **SC-002**: Every code pull request from this repository carries exactly one preview comment; no
  pull request carries two.
- **SC-003**: 10 minutes after a pull request closes, its preview leaves 0 Workers behind.
- **SC-004**: 0 releases reach production from a commit that was not green on dev — shown by at
  least one refused tag on record.
- **SC-005**: A bad Worker is back on its previous version within 5 minutes of the click, with a
  verdict that says so.
- **SC-006**: 0 rows of production data appear in any artifact, log or summary of this repository.
- **SC-007**: After the cutover, 0 release pull requests are written; a release is one tag push.
- **SC-008**: Every release states which version of each Worker went live and which restore point
  was taken.

## Assumptions

- The GitHub environments `dev` and `production` exist and hold `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`, as the current deploys use them; the token can deploy, delete and roll
  back Workers, read the account's `workers.dev` subdomain, and apply D1 migrations.
- Dev and production live in the same Cloudflare account (`liconadev`, measured 2026-10-15), and the
  preview Workers live there too, beside dev.
- The `agnostic-auth` Worker is reachable from a preview's API exactly as from dev's, through the
  same service binding.
- `workers.dev` is a public suffix, so a preview's app and API addresses on the account's subdomain
  are the same site, and a session cookie set by the preview's API reaches it from the preview's
  app (checked against the Public Suffix List on 2026-10-15).
- D1 restore points can be taken and used for the last 30 days (wrangler 4.99 help text).
- One developer works the repository with AI agents; that developer makes the settings changes
  outside the repository (deployment policy, branch settings, secrets) that the runbook lists.
