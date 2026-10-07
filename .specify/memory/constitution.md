<!--
Sync Impact Report (v1.2.0, 2026-10-07)
- Version change: 1.1.1 → 1.2.0 — MINOR. Authentication moves from Agnostic
  Auth to Better Auth used the standard way (specs/004-passkey-auth, plan D18).
  Principle IV gains a scoped exception: `/api/auth/*` follows Better Auth's
  contract, and every other route keeps the rule unchanged. No principle is
  removed, renumbered or redefined, and the server still decides, so this is
  materially expanded guidance rather than a MAJOR change.
- Modified sections (titles unchanged):
  · III. Tenant Isolation:
    - Better Auth's tenant fields are declared `input: false`.
    - Its lookups by a globally unique key, and its reads of the signed-in
      user's own rows, join the exempt reads (specs/004-passkey-auth
      /speckit-analyze, finding M2).
  · IV. The Server Decides:
    - Sessions are Better Auth's: one HttpOnly cookie per environment
      prefix. Its sign-in answers may echo the token, which the app never
      reads (this replaces "gm_access/gm_refresh … never returned in a
      body").
    - `/api/auth/*` is Better Auth's handler, with its own validation,
      `{ code, message }` and success shapes.
    - Codes the app branches on are still declared in the spec.
    - MSW mirrors Better Auth's client under the same fixture rule (finding
      M1).
  · VI. A Rule Is Proven Where It Is Enforced:
    - The `AGNOSTIC_AUTH_API` stand-in leaves, and the test config pins
      `BETTER_AUTH_SECRET`.
    - Better Auth runs for real; ceremonies come from a software
      authenticator.
  · VIII. A Service We Do Not Own Never Undoes a Sale:
    - Agnostic Auth leaves the list.
    - Resend's place on the sign-in path, and what breaks when it is down,
      are recorded.
    - The signing secrets are named.
  · Technology Stack & Constraints: the Runtime row adds `nodejs_als`, and the
    Auth row becomes Better Auth.
- Added sections: none. Removed sections: none.
- Templates: .specify/templates/plan-template.md ✅, spec-template.md ✅,
  tasks-template.md ✅, checklist-template.md ✅. None names an auth
  provider, so no template changed.
- Follow-up TODOs:
  · The code catches up in the same pull request (specs/004-passkey-auth,
    Governance: "lands in the pull request that needs it"). On this branch the
    text leads the code until the feature's tasks complete. `develop` keeps
    v1.1.1 until that PR merges.
  · TODO(PASSWORD-MATERIAL): `users.password_hash`, `users.password_salt` and
    `password_reset_tokens` stay in D1, unread, until the deploy that follows
    cutover (specs/004-passkey-auth D15). They are registered as debt at
    implementation.
  · CLAUDE.md still describes Agnostic Auth and the old local-login caveat;
    specs/004-passkey-auth T044 rewrites it.
  · Carried from v1.0.0, still open: TODO(CONTRACT-MIRROR),
    TODO(TOKEN-FALLBACKS), TODO(EMAIL-PALETTE), TODO(TEST-CITATIONS),
    TODO(DESIGN-FOUNDATIONS), and the archived TECH_DEBT.md items to
    re-register when a feature touches them (see the v1.0.0 report in git
    history, develop@33b3609).
-->

# Turistear Ya! Constitution

Turistear Ya! sells tourism — tours, transfers and stays — for Mexican
operators who sell in the field. An organization's agents sell on a phone,
often outdoors and with cash in hand. The tourist receives a signed QR ticket
by WhatsApp or email. The admin controls the catalog, the inventory, the
commissions and the cash that comes back. Every organization is isolated from
every other (Principle III). It is built by one developer working with AI
agents; that developer decides. Ask for decisions, not approvals.

## Core Principles

### I. Spec-Driven, Every Decision Cited

- Features are specified with Spec Kit under `specs/NNN-slug/` before they are
  built: `/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
  `/speckit-implement`. A bug takes the lite path (`/speckit-bug-assess` →
  `-fix` → `-test`, under `.specify/bugs/<slug>/`); a deliberate shortcut is
  registered with `/speckit-debt-log` under `.specify/debt/<slug>/`. Nobody
  starts at the code.
- A spec starts from what is broken, with numbers, and states its scope
  boundary as a mechanical test: a feature that touches an existing path names
  the suites that MUST pass unedited.
- Every decision in a plan is numbered and carries its *why*. Every
  non-obvious rule in code cites the decision that made it, in a comment:
  `<feature-slug> D<n>` for Spec Kit work, `bug: <slug>` for a lite-path fix.
  A comment explains *why*; when the reason was measured, it says when.
- A spec is amended in place, never forked. When the build teaches something,
  the spec records what changed and why: a decision withdrawn, a decision
  added in build, a scenario rewritten because it would have passed with the
  bug still present.
- The pre-Spec-Kit corpus is a read-only archive in `leolicona/guide-me-docs`.
  Citations to it (`docs/TESTING.md D10`, `US-A66`, `BUG-042`,
  `TECH_DEBT #21`) resolve there at the same path and stay intact. Nothing new
  is written there; anything rebuilt is specified again with Spec Kit. CI
  fails if `docs/` or `.design/` reappears in this repo.

Rationale: the codebase reads as a trail of decisions. A rule without its
decision is one nobody dares change and nobody can verify, and a spec that is
never amended becomes a wish list.

### II. Money Law

- Money is integer minor units (centavos) end to end: D1 columns are
  `integer`, API payloads carry minor units, and the frontend converts only at
  the edge of an input or a display (`app-turistear/src/components/money.ts`).
  A float never holds an amount.
- A percentage is integer basis points (`1000` = 10%), applied as
  `round(total × bp / 10000)` — the divisor BUG-001 got wrong by a factor of
  100.
- Money is displayed by one formatter, `Intl.NumberFormat("es-MX", {
  currency: "MXN" })` in `components/money.ts`, through `MoneyText` with
  tabular figures. A second formatter is drift.
- A sale freezes its terms. Unit prices, discounts, commission and the
  cancellation policy are snapshotted on the folio and its lines when it is
  sold; editing the catalog, a commission or the organization's policy never
  re-prices a sold folio.
- The ledger is the money truth. Every movement — payment, refund,
  commission, commission reversal — is a signed row in `folio_payments`,
  allocated to the lines it funds and dated when it actually happens, so a
  refund or a clawback lands on the shift where it occurs. Totals on `folios`
  are roll-ups derived from those rows; a new money state is derived from
  recorded movements, never stored beside them as an independent fact.
- The organization's single IANA time zone (`organizations.timezone`, default
  `America/Mexico_City`) owns "today", a departure and every day boundary —
  never the browser, never UTC. Instants are stored as epoch integers;
  calendar days (a slot's date, a check-in) as org-local `YYYY-MM-DD`.

Rationale: an agent reads a number aloud and takes cash for it. The law
removes whole classes of error — a float, a stale price, a balance nobody can
reconstruct — instead of testing for each one.

### III. Tenant Isolation (NON-NEGOTIABLE)

- One D1 database, one schema, row-level scoping. Every tenant-scoped table
  carries `organization_id TEXT NOT NULL REFERENCES organizations(id)` and
  indexes it, alone or as the leading column of a composite. A table scoped
  transitively (through `user_id`, say) says so in its migration.
- `organization_id` comes only from the authenticated actor
  (`c.var.user.organizationId`, set by `authMiddleware`) — never from a body,
  a query parameter or a path. A Zod request schema MUST NOT declare it. On
  Better Auth's routes (`/api/auth/*`) the user's `organization_id`, `role` and
  `status` are declared `input: false`, so no request can set them.
- Every SELECT filters by the actor's organization; every INSERT sets it from
  context; every UPDATE and DELETE carries the organization filter beside the
  id, so another organization's row matches nothing and the handler answers
  `404`. The only exempt reads are lookups by a globally unique key
  (`users.email`, `invitations.token`, and Better Auth's own: a session token,
  a passkey credential id, a verification identifier) and Better Auth's reads
  of the signed-in user's own rows by `user_id`, which is narrower than the
  organization.
- Every new tenant-scoped route ships cross-org isolation tests built on
  `seedTwoOrgs` (`api-turistear/test/helpers/tenancy.ts`). Isolation is
  proven in the API; a frontend test never satisfies this rule.
- Authorization is enforced in the API, by `requireRole(...)` and by the
  scope of each query. An `agent` sees and sells only its organization's
  services. The product has two roles, `admin` and `agent`. Hiding a button
  is presentation, never authorization.

Rationale: in a shared schema a missing filter leaks another business's sales
and cash silently — nothing errors. One way to scope and one helper to prove
it keep isolation auditable with grep.

### IV. The Server Decides

- Business rules are enforced server-side: capacity, minimum and net prices,
  discounts, commissions, the cancellation ladder, apartado expiry, payment
  verification. The frontend may mirror a rule for fast feedback; a rule only
  the frontend enforces is not a rule.
- The UI talks only to `api-turistear` and never holds a credential.
  - The session is a Better Auth session issued by the API.
  - It lives in one HttpOnly, Secure cookie on `.turistearya.com`:
    `__Secure-<AUTH_COOKIE_PREFIX>.session_token`, with a prefix per
    environment.
  - Every request is sent with `credentials: 'include'`.
  - Better Auth's sign-in answers may echo the session token in their body.
    The app never reads, stores or sends it; the cookie alone
    authenticates.
- Every route lives in `src/routes/<resource>/`: `index.ts` is the router
  (middleware, `zValidator`, wiring, nothing else), `handler.ts` holds the
  logic, `schema.ts` holds the Zod schemas. Input is validated before a
  handler runs.
- The one exception is `/api/auth/*`: Better Auth's handler, mounted in
  `src/index.tsx` and configured in `src/auth/`. It validates its own input.
  Whatever Better Auth does not know — an organization, an invitation — is a
  route of ours under the rule above (`/api/onboarding/*`).
- A failure answers `{ error: { code, message } }` through `ApiError` and the
  error handler, with a `SCREAMING_SNAKE` code declared in the spec before it
  exists in code. Clients branch on `code`, never on `message`. A success
  answers the resource under a named key (`{ folio }`, `{ services }`).
- On `/api/auth/*`, failures (`{ code, message }`) and success shapes are
  Better Auth's. The spec still declares every Better Auth code the app
  branches on, and clients still branch on `code`.
- Until a shared contracts package exists (TODO(CONTRACT-MIRROR)), the
  frontend's mirror of a response (`features/*/types.ts`) is held by
  discipline: MSW handlers mirror `services/<resource>Service.ts` one to one,
  and their fixtures copy shapes an API test asserts.
- For `/api/auth/*` the app calls Better Auth's client
  (`services/authClient.ts`). MSW mirrors exactly the endpoints it calls,
  under the same fixture rule. A fixture no API test would produce is a
  fiction.
- QR tickets are signed by the server (HMAC-SHA256, with a per-organization
  key derived from `QR_SECRET`) and validated online against it. No two
  environments share a `QR_SECRET`.

Rationale: the frontend runs on a phone in someone else's hands. Whatever it
decides alone, a modified client can decide differently — and a mirror nobody
checks drifts into fiction.

### V. Capacity Is Guarded by the Database

- D1 has no interactive transactions, and a conditional `UPDATE` that matches
  zero rows is not an error. Every write that consumes capacity — a slot's
  seats, a zone's seats, a stay's nights — is therefore a single-statement
  guarded update (`… SET booked = booked + n WHERE … AND capacity - booked >=
  n RETURNING id`).
- When any guard in a request matches nothing, the request gives back what it
  already took and answers `409` with a specific code (`SLOT_UNAVAILABLE`,
  `ZONE_UNAVAILABLE`, `INSUFFICIENT_INVENTORY`). No folio row is written.
- Rows that must exist together are written in one `db.batch`, after the
  guards succeed. A read-then-write check is never the only guard.
- Availability shown to a seller is advisory; the guard at confirmation is the
  authority.

Rationale: two agents on two docks can sell the last seat in the same
millisecond. Only the database can arbitrate, and D1 arbitrates one statement
at a time.

### VI. A Rule Is Proven Where It Is Enforced

- API tests run in workerd (`@cloudflare/vitest-pool-workers`) against a real
  local D1, with every migration applied and storage isolated per test — no
  database mocks. Services we do not own are stood in for at their boundary
  (Resend's origin), and the test config pins their keys and
  `BETTER_AUTH_SECRET` so `.dev.vars` can never leak into a suite. Better Auth
  runs for real; a passkey ceremony comes from a software authenticator, never
  from stubbing its verifier. Business rules and cross-org isolation are
  proven here.
- App tests are co-located (`<module>.test.ts`, `<Component>.test.tsx`), run
  on jsdom with Testing Library and MSW (`onUnhandledRequest: 'error'`),
  render through `renderWithProviders`, and query by role and accessible
  name — never by test id or class. They prove the mirror and the
  presentation (the cart total is the number the API will charge; state is
  never colour alone), and never assert a rule the API owns.
- A new component test asserts `expectNoA11yViolations`
  (`app-turistear/src/test/axe.ts`) on what it mounts; a test written before
  v1.0.0 gains the assertion when its component changes. A tolerated rule
  names the bug that tracks it; a fresh finding is never quieted.
- Playwright (`app-turistear/e2e/`) covers only journeys that cross a real
  browser and a real API, seeds and tears down its own data, and runs nightly
  and on pull requests labelled `e2e` — never as a merge gate. A test that
  skips by default has never gated anything.
- Every new test file cites what it proves: `<feature-slug> US<n>` for a
  Spec Kit story, `bug: <slug>` for a lite-path fix, or the archived
  `US-XNN` / `BUG-0NN` it extends. A bare `US1` is not a citation.
- There is no coverage threshold, no whole-tree snapshot, and no test of MUI
  internals or of `pages/` (route assembly holds no logic).

Rationale: each layer answers only the questions it can. A frontend test
asserting a cancellation tier creates a second source of truth for it, and a
snapshot that churns with every token change gets approved without being
read.

### VII. Elegant Field Minimalism (NON-NEGOTIABLE)

- The UI is a field instrument, used one-handed, outdoors, with cash in hand.
  Its three laws, in priority order: **legible in sunlight · one confident
  accent · reach & repetition.**
- Token values are written in exactly two files:
  `app-turistear/src/config/theme.ts` (MUI `createTheme({ cssVariables: true
  })`) and `app-turistear/src/styles/tokens.css`. Components consume the theme
  or the variables, with no raw colour, size, radius or shadow; any other
  document cites the token instead of copying its value. A token changes only
  through a spec that re-verifies its contrast. The archived
  `.design/design-system/DESIGN_TOKENS.md` records why each value is what it
  is.
- Teal (`primary`) is reserved for the primary action, the active navigation
  item and selected or interactive states, and never carries state. State is
  functional colour — green for ok or paid, amber for warning, red for
  urgency or error — always paired with an icon and text, never colour alone.
- Money reads first: a financial figure renders through `MoneyText`, in
  tabular figures and semantic colour (ink, success, error), never teal.
- Structure, not shadow: resting surfaces have a hairline border and no
  shadow; real shadow belongs to overlays (menus, dialogs, sheets).
- Accessibility: WCAG AA contrast, verified at the token; touch targets of at
  least 48px; 16px base text; a visible keyboard focus (`--shadow-focus` on
  non-text controls, a tint on inputs); `prefers-reduced-motion` honoured.
- The shared primitives in `app-turistear/src/components/` come before
  anything ad hoc. Every entity edit and every confirmation is a `FormSheet`
  or `ConfirmSheet` on `BottomSheet`, never a centred MUI `Dialog`;
  multi-step creation uses `WizardShell` or `WizardPage`.
- Mobile-first: one column at phone width, sheets capped at 640px on
  desktop, the admin's two-column shell capped at 1200px.
- Light only. The dark palette is defined in the archive but not built;
  building it is a feature with its own spec.
- Copy is es-MX product copy in sentence case, with one word per concept and
  one verb per action across every screen: **Venta**, never "folio", in the
  UI; **Cobrar · Entregar · Confirmar · Cancelar venta**. Identifiers and
  comments are English.

Rationale: an agent on a dock at noon must glance, trust the number and tap
once. Every rule here prevents one way that glance goes wrong.

### VIII. A Service We Do Not Own Never Undoes a Sale

- Each service we do not own is reached through one module or binding:
  Resend (email, `services/resend.ts`), api.qrserver.com (the QR image only;
  the signature is ours) and WhatsApp (an agent-sent `wa.me` link). A spec
  that adds one records its contract and what breaks when it is down.
- Resend also carries the email sign-in code, sent in the background. When it
  is down, a user with a passkey or a live session is unaffected, and a code
  does not arrive (specs/004-passkey-auth).
- A notification never sits inside a money write. It is sent after the write
  succeeds, under `waitUntil`, with its failure caught, so a provider outage
  never rolls back a sale, a payment or a cancellation.
- Secrets live in each environment's Worker secrets and in GitHub
  environments, never in the repo (`.dev.vars` is ignored), and no two
  environments share a signing secret (`QR_SECRET`, `BETTER_AUTH_SECRET`).

Rationale: the sale is the fact and the receipt is a courtesy. A ticket can be
sent again; a sale that vanished because an email bounced cannot be sold
again.

## Technology Stack & Constraints

The stack is fixed; a plan that departs from it justifies the departure in
Complexity Tracking.

| Layer | Convention |
| --- | --- |
| Runtime | Cloudflare Workers, `compatibility_date` 2025-08-03, compatibility flag `nodejs_als` (Better Auth's request context). The API's one cron trigger (`*/15 * * * *`) runs the bookings auto-expiry sweep |
| API | `api-turistear`: Hono 4 + `@hono/zod-validator` (Zod 4), JSX through `hono/jsx`, built and served by Vite 6 with `@cloudflare/vite-plugin` and `vite-ssr-components`. Middleware in `src/middleware/`, helpers in `src/utils/`, providers in `src/services/` |
| Data | Cloudflare D1 through Drizzle ORM (`sqlite`); migrations `NNNN_snake_case.sql` in `api-turistear/migrations/`, applied with `wrangler d1 migrations` |
| Auth | Better Auth 1.7.7 inside the API Worker; its handler owns `/api/auth/*`. Passkeys (WebAuthn/FIDO2, `@better-auth/passkey`) are the primary sign-in and a 6-digit email code (`emailOTP`) is the backup. Database sessions in D1 (7 days, renewed by use); one HttpOnly session cookie on `.turistearya.com` |
| Frontend | `app-turistear`: React 19, Vite 8, MUI 9 (`cssVariables: true`), TanStack Query 5, Zustand 5, React Hook Form 7 + Zod 4, React Router 7; served as a Worker. Layers: `pages/` (route assembly only) · `layout/` · `components/` (shared primitives) · `features/<Name>/{components,hooks,types.ts,index.ts}` · `store/` · `services/` · `styles/` · `config/` |
| Language | TypeScript, ESM; Node 22; pnpm workspace (pnpm 10 in CI) |
| Tests | Vitest 4 — `@cloudflare/vitest-pool-workers` for the API; jsdom, Testing Library, MSW 2 and axe-core for the app; Playwright 1.62 for journeys |
| Environments | `dev` from `develop` (`api-dev` / `app-dev.turistearya.com`, D1 `guideme-db`) and `prod` from `main` (`api` / `app.turistearya.com`, D1 `guideme-db-prod`) |
| Integrations | Resend (transactional email), api.qrserver.com (QR images), WhatsApp through agent-sent links — Principle VIII |

Additional constraints:

- The app's API origin is a build-time constant (`VITE_API_BASE_URL`). In
  local development the app (port 5174) proxies `/api` to the API (port
  5173); both ports are fixed.
- Migrations take the next four-digit number and are additive and
  backward-compatible with the code already deployed: they run before the
  code on every deploy, and there are no down-migrations, so a mistake is
  fixed forward.
- D1 reads are metered (archived TECH_DEBT #31). A list endpoint is bounded,
  and a correlated subquery keyed by a child column has an index led by that
  key: `EXPLAIN QUERY PLAN` shows no `SCAN` inside a correlated subquery
  (BUG-042).
- Every deploy and every remote migration is environment-scoped: no bare
  `deploy` or `db:migrate` script exists, and deploys go through CI.

## Development Workflow & Quality Gates

- One unit of work gets one worktree and one pull request:
  `git worktree add .claude/worktrees/<name> -b <type>/<slug> origin/develop`,
  with branches `feat/`, `fix/` or `docs/` and Conventional Commits scoped by
  domain (`feat(cancellation):`). Never a bare `git stash`: the stash stack is
  shared by every worktree.
- Pull requests target `develop` and are squash-merged, so the PR title
  becomes the commit on `develop`. A release is a PR `develop → main`, titled
  `release: … → prod` and merged with a merge commit, never squashed: the
  squashed releases #84 and #99 cost #108 eleven phantom conflicts.
- Every PR runs `verify`: the archive guard, a frozen-lockfile install,
  `lint:app`, `test:app`, `test:api`, `build:api`, `build:app`. All MUST pass;
  none is skipped, disabled or quarantined to get green.
- A push to `develop` deploys dev: tests, then the dev D1 migrations, then
  the API, then the app. A push to `main` deploys prod the same way, after a
  required reviewer approves the `production` environment.
- A feature is done when each story of its spec has a cited test at the
  layer that can answer it (Principle VI), every tenant-scoped route has its
  `seedTwoOrgs` tests, its plan's Constitution Check passes, and
  `/speckit-analyze` reports no CRITICAL finding.
- A shortcut taken on purpose is registered the same day with
  `/speckit-debt-log` and closed only by `/speckit-debt-pay` with evidence.
  An item still open in the archived `TECH_DEBT.md` is re-registered the
  first time a feature touches it.

## Governance

- This constitution supersedes every other practice document, CLAUDE.md
  included: CLAUDE.md is runtime guidance for agents and yields wherever they
  disagree. Where the code and the constitution disagree, one of them is
  amended or the gap is registered as debt; it is never silently tolerated.
- Amendments go through `/speckit-constitution` and bump the version: MAJOR
  for removing or redefining a principle, MINOR for adding one or materially
  expanding guidance, PATCH for wording. Each amendment rewrites the Sync
  Impact Report and the `Last Amended` date, and lands in the pull request
  that needs it.
- Compliance is checked at three points. `/speckit-plan` fills its
  Constitution Check with one gate per principle and records any justified
  violation in Complexity Tracking; `/speckit-analyze` treats a conflict as
  CRITICAL; CI runs the executable part (`verify` and its archive guard).
- Principle numbers are stable: code and plans cite them (`constitution
  III`). Renumbering is a MAJOR change and updates every citation in the tree.
- The developer decides. When a principle blocks a feature, the plan says so
  and proposes the amendment; it does not route around it.

**Version**: 1.2.0 | **Ratified**: 2026-10-04 | **Last Amended**: 2026-10-07
