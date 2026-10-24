---

description: "Task list for Automatic Transfer Verification with Devolada"
---

# Tasks: Automatic Transfer Verification with Devolada

**Input**: Design documents from `/specs/006-devolada-transfer-verification/`. Read these before starting:
- [plan.md](./plan.md);
- [spec.md](./spec.md);
- [research.md](./research.md) — decisions D1–D21;
- [data-model.md](./data-model.md);
- [contracts/turistear-api.md](./contracts/turistear-api.md);
- [contracts/devolada-integration.md](./contracts/devolada-integration.md);
- [quickstart.md](./quickstart.md).

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ — all present.

**Tests are included and mandatory here.** The template makes them optional, but this repository does not:
- constitution VI requires every story to have a cited test at the layer that enforces it;
- `CLAUDE.md` and constitution III require `seedTwoOrgs` cross-org tests for every new tenant-scoped route;
- research D18 names the suites.

Write each story's tests first and watch them fail.

**Citations (constitution I and VI)**:
- Every new test file opens with a comment citing `devolada-transfer-verification US<n>`.
- Every non-obvious rule in code cites `devolada-transfer-verification D<n>`.

**Scope boundary (spec Context)** — these must pass **unedited** after every task:
- `api-turistear/test/pos/payment-verification.test.ts`
- `api-turistear/test/pos/optional-payment-reference.test.ts`
- `api-turistear/test/paid-ledger/settle-method.test.ts`

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Line references such as `handler.ts:2779` point at the code on `main` as re-read on 2026-10-15 (research § Re-baseline); re-locate them by symbol name if they have moved

## Path Conventions

- API: `api-turistear/src/`, tests in `api-turistear/test/` (Vitest in workerd, real D1)
- App: `app-turistear/src/`, tests co-located as `<Component>.test.tsx` (jsdom, MSW, axe)
- Migrations: `api-turistear/migrations/NNNN_snake_case.sql`, hand-written, mirrored by hand in `api-turistear/src/db/schema.ts`. This feature's is `0073` (data-model.md)
- API test requests authenticate with `headers: { Cookie: sessionCookie(email) }` (`api-turistear/test/helpers/session.ts`); `seedTwoOrgs` returns each admin's `adminEmail` for it

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Configuration, error vocabulary and the constitution amendment that every later task relies on.

- [X] T001 Add the vars `DEVOLADA_API_BASE_URL`, `DEVOLADA_KEY_MODE` and `DEVOLADA_WEBHOOK_URL` to all four profiles in `api-turistear/wrangler.jsonc`. Named envs inherit no vars (lines 14-16), so repeat them in each profile:

  | Profile (`vars` lines) | `DEVOLADA_API_BASE_URL` | `DEVOLADA_KEY_MODE` | `DEVOLADA_WEBHOOK_URL` |
  |---|---|---|---|
  | local (40-53) | `https://api.dev.devoladapago.com` | `test` | `""` |
  | dev (80-87) | `https://api.dev.devoladapago.com` | `test` | `https://api-dev.turistearya.com/api/webhooks/devolada` |
  | preview (110-120) | `https://api.dev.devoladapago.com` | `test` | `""` |
  | production (146-153) | `https://api.devoladapago.com` | `real` | `https://api.turistearya.com/api/webhooks/devolada` |

  A preview registers no notification address. It serves dev's database, so the business keeps dev's address, and it runs no cron (D17). Add a comment citing `devolada-transfer-verification D17`.
- [X] T002 Declare the four Devolada bindings in `api-turistear/src/bindings.d.ts`, then run `pnpm cf-typegen:api` to refresh `api-turistear/worker-configuration.d.ts`:
  - `DEVOLADA_API_BASE_URL: string`
  - `DEVOLADA_KEY_MODE: 'real' | 'test'`
  - `DEVOLADA_WEBHOOK_URL: string`
  - `DEVOLADA_CREDENTIAL_KEY: string` (secret)
- [X] T003 [P] Provision the secret `DEVOLADA_CREDENTIAL_KEY` in `.github/workflows/deploy-dev.yml`, `deploy-prod.yml`, `preview.yml`, `.github/scripts/preview-note.mjs` and `api-turistear/.dev.vars.example`, the way constitution VIII manages every API secret (D17; the preview exception is T006's):
  - **Value**: 32 random bytes, base64 (`openssl rand -base64 32`), generated once per environment, a different value in `dev` and in `production`. It is never pasted again: a changed value makes every stored credential unreadable, and every connected organization would have to connect again.
  - **GitHub environments**: the developer adds it as a secret of the `dev` and `production` environments: in `dev` before PR 1's preview is used to validate, and in `production` before PR 1 is released with a `v*` tag.
  - **`.github/workflows/deploy-dev.yml` (47-62) and `deploy-prod.yml` (82-97)**, step «Secrets for the API»:
    - add it to the step's `env`, and to the list of keys the `node` one-liner writes into `$RUNNER_TEMP/api-secrets.json`, so every deploy plants it with the version it ships;
    - when it is present, check that it decodes to exactly 32 bytes; otherwise stop before migrating, as for a short `BETTER_AUTH_SECRET`;
    - when it is absent, name it in the step's `::notice::` loop; the Worker keeps its current value.
  - **`.github/workflows/preview.yml` (101-124)**, step «Secrets for the preview»:
    - pass the `dev` environment's value when it holds one;
    - otherwise leave it out of `preview-secrets.json` with a `::notice::`, and keep it out of the throwaway loop and its `throwaway` output;
    - when it is left out, add one line to the pull request's note saying Devolada is off on that preview (`.github/scripts/preview-note.mjs`, with a case in `preview-note.test.mjs`).

    Never a throwaway: a preview writes into dev's D1, and a credential encrypted under a throwaway key cannot be read by dev's Worker, nor by the preview's next deploy. Without the key, that preview's API fails closed (D17).
  - **Local**: document it in `api-turistear/.dev.vars.example` next to `BETTER_AUTH_SECRET`; `.dev.vars` holds it.
- [X] T004 [P] Pin the Devolada bindings in the `miniflare.bindings` block of `api-turistear/vitest.config.ts` (lines 21-31):
  - `DEVOLADA_API_BASE_URL: 'https://devolada.test'`. The host cannot resolve, so an unstubbed call fails instead of reaching Devolada (D17).
  - `DEVOLADA_KEY_MODE: 'test'`
  - `DEVOLADA_WEBHOOK_URL: 'https://api.test/api/webhooks/devolada'`
  - `DEVOLADA_CREDENTIAL_KEY`: a fixed base64 string encoding 32 bytes.
- [X] T005 [P] Add the eleven new error codes to the `ErrorCode` union in `api-turistear/src/types/errors.ts` (lines 1-36), exactly as spec FR-023 declares them and contracts/turistear-api.md § Error codes details them, together with `FOLIO_CANCELLED`, which the resolve endpoint raises and which is in use today without being declared (research defect 9):
  - `DEVOLADA_CREDENTIAL_REJECTED`, `DEVOLADA_MODE_NOT_ALLOWED`, `DEVOLADA_CHANNEL_UNAVAILABLE`
  - `DEVOLADA_BUSINESS_SUSPENDED`, `DEVOLADA_WEBHOOK_CONFLICT`, `DEVOLADA_UNAVAILABLE`
  - `DEVOLADA_PAYMENT_NOT_RESOLVABLE`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_PAYLOAD_INVALID`
  - `SETTLEMENT_IN_PROGRESS`, and `PAYMENT_LINK_TOO_SHORT`, which only ever travels as `payment_link_error`
- [X] T006 Run `/speckit-constitution` to amend `.specify/memory/constitution.md` (MINOR, 1.4.0 → 1.5.0, or the next MINOR if another amendment lands first), as recorded in plan.md § Complexity Tracking:
  - add Devolada to Principle VIII's list of services we do not own: module `api-turistear/src/services/devolada.ts`; failure modes in `specs/006-devolada-transfer-verification/contracts/devolada-integration.md`;
  - in Principle VIII's secrets paragraph:
    - name `DEVOLADA_CREDENTIAL_KEY` among the secrets no two environments share;
    - say what a changed value costs: every stored Devolada credential becomes unreadable;
    - make it the one secret a preview never gets as a throwaway: dev's value or none, because a preview writes into dev's database, and the pull request's note says so (research D17);
    - a value present but malformed stops the deploy before it migrates, as a missing `BETTER_AUTH_SECRET` does;
  - add `devolada_links.devolada_link_id`, Devolada's globally unique `paymentLinkId`, to Principle III's exempt lookups, as v1.2.0 did for Better Auth's keys. The webhook resolves the organization through it, then re-reads with that organization's own credential (research D4);
  - name in Principle III the actor-less sweeps: they select due rows across organizations, then act on each with that row's own `organization_id`, as `sweepExpiredBookings` already does (research D12);
  - add Devolada to the Integrations row of the Technology Stack table;
  - make the Runtime row's cron sentence name the three sweeps it runs in dev and production: bookings expiry, departure reminders, Devolada recovery;
  - rewrite the Sync Impact Report.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Tables, crypto, the single Devolada client, the test fake, and the per-payment verification core that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T007 Write `api-turistear/migrations/0073_devolada_transfer_verification.sql` (or the next free number, data-model.md). Create `devolada_connections`, `devolada_credentials`, `devolada_links`, `devolada_payments` and `devolada_events` with exactly the columns, foreign keys and indexes of data-model.md, including:
  - `UNIQUE(organization_id)` on connections;
  - `devolada_links.credential_id` NOT NULL → `devolada_credentials`, and the `(organization_id, retired_at)` index on credentials (D21);
  - `UNIQUE(devolada_link_id)`;
  - the partial unique indexes on links: one open settlement link per sale, one open link per `folio_payment_id`;
  - `(state, expires_at)`;
  - every `(organization_id, …)` composite.

  The migration is additive only, with a prose header citing `devolada-transfer-verification D1-D9, D21`, like the other migrations.
- [X] T008 Mirror migration 0073 in `api-turistear/src/db/schema.ts`:
  - five `sqliteTable` definitions with their `$inferSelect`/`$inferInsert` types;
  - the TypeScript enums from data-model.md:
    - connection: status;
    - credential: mode;
    - link: kind, state, closed_reason;
    - payment: status, proof_door, match, awaiting, awaiting_reason, resolution;
    - event: outcome;
  - `'payment_not_received'` added to the `cancellationSource` enums of `folios` and `folio_lines` (D11).
- [X] T009 Add `payment_link_issued`, `payment_link_closed`, `payment_verdict` and `transfer_not_received` to `FolioEventType` in `api-turistear/src/utils/folioEvents.ts` (lines 14-24) and to its Drizzle mirror in `api-turistear/src/db/schema.ts` (lines 998-1011). Document each payload shape from data-model.md § Changes to existing types in a comment.
- [X] T010 [P] Implement `api-turistear/src/utils/devoladaCredential.ts` (D1):
  - `encryptCredential(env, organizationId, plaintext): Promise<{ciphertext, iv}>`
  - `decryptCredential(env, organizationId, {ciphertext, iv}): Promise<string>`
  - `keyHint(apiKey): string`, returning the last four characters.

  Key handling:
  - derive the key as `HMAC-SHA256(base64-decoded DEVOLADA_CREDENTIAL_KEY, "guideme:devolada:v1:" + organizationId)` and import the 32 bytes as an `AES-GCM` key (same label pattern as `utils/qr.ts:84-107`);
  - use a fresh 12-byte IV per write, with `additionalData` = UTF-8 `organizationId`;
  - encode ciphertext and IV as base64url;
  - throw if the secret is missing.
- [X] T011 Implement `api-turistear/src/utils/devoladaSignature.ts` (D4), after T012:
  - a module-level `Map<kid, CryptoKey>` cache;
  - `verifyDevoladaSignature(env, {timestamp, keyId, signatureHeader, rawBody}): Promise<boolean>`:
    - require the `v1=` prefix;
    - base64url-decode without padding to the raw `r‖s` 64 bytes;
    - verify ECDSA P-256 / SHA-256 over `` `${timestamp}.${rawBody}` `` with the JWK whose `kid` equals `keyId`;
    - on an unknown `kid`, refetch the key set once through `getSigningKeys` (T012) and re-check. Refetch at most once a minute per isolate, so forged requests with random `kid`s cannot multiply calls to Devolada;
    - return `false` on any malformed input;
  - throw `DevoladaUnavailableError` (exported) when the key set cannot be fetched.
- [X] T012 [P] Implement `api-turistear/src/services/devolada.ts` (D5), the only code allowed to call Devolada. `devoladaClient(env, apiKey)` exposes:
  - `createPaymentLink(body, {idempotencyKey, fast})`
  - `closePaymentLink(id, {idempotencyKey})`
  - `getPayment(id)`
  - `getPaymentLink(id)`, which D21 uses to learn whether the current credential can read a link
  - `listPaymentsByCustomer(customerRef)`
  - `getWebhook()`, `putWebhook(url)`
  - `listFailedDeliveries()`
  - and, without a credential, `getSigningKeys(env)` for `/.well-known/jwks.json` (8 s, honouring `Cache-Control`), which `devoladaSignature.ts` uses (D4, D5).

  Every method:
  - sends `Authorization: Bearer <apiKey>`;
  - uses `AbortSignal.timeout(fast ? 3000 : 8000)`;
  - parses the `{success, data|error}` envelope;
  - converts instants at the boundary in both directions: callers pass and receive epoch seconds, Devolada sends and receives milliseconds, `expiresAt` included;
  - returns `{ok: true, data} | {ok: false, kind: 'refused' | 'retryable' | 'timeout', code, message, status, retryAfter?}` instead of throwing.

  Map errors per contracts/devolada-integration.md § Error mapping. Never log the API key.
- [X] T013 [P] Implement the stateful fake Devolada in `api-turistear/test/helpers/devolada.ts` (D18). `installFakeDevolada()` spies `globalThis.fetch` for `https://devolada.test` and passes every other URL through; call `vi.restoreAllMocks()` in `afterEach`. It chains to the spy's current implementation (`getMockImplementation()`) instead of replacing it, so a test that called `stubResend()` (`api-turistear/test/helpers/auth-flows.ts:54-69`) first still captures the ticket emails. It emulates the v1 contract:
  - **businesses** keyed by API key: mode, channel `ok|clabe|bank`, suspended, and a key that can be revoked or rotated, so one business may hold several keys;
  - **one-time links**: `expiresAt` may be in the past; idempotent replay by key, refusals included; `PATCH close`; `GET /v1/payment-links/{id}`, which answers `NOT_FOUND` across businesses;
  - **payments**:
    - `submitProof(devoladaLinkId, {claimedCents})` creates a `validating` payment;
    - `advance(paymentId, to, receivedCents?)` follows the test-mode rules;
    - `GET /v1/payments/{id}` answers `NOT_FOUND` across businesses and modes;
    - payments can be listed by `customerRef`;
  - **webhook**: `GET/PUT/DELETE /v1/webhook` and failed deliveries;
  - **JWKS** from a P-256 key pair generated with `crypto.subtle.generateKey`.

  Test controls:
  - `failNext(route, 'timeout' | '500' | 'rate_limited' | 'unreachable')`;
  - a `calls` log for assertions;
  - `signedEvent(devoladaPaymentId, {eventId?, keyId?, tamperBody?, wrongKey?})`, which returns a `Request` for `SELF.fetch('http://api.local/api/webhooks/devolada')` with valid `Devolada-*` headers.
- [X] T014 [P] Write `api-turistear/test/devolada/credential-cipher.test.ts`, citing `devolada-transfer-verification US1`:
  - round trip;
  - two encryptions differ (fresh IV);
  - decrypting with another organization id fails (AAD binding);
  - a missing secret throws;
  - `keyHint` returns the last four characters.
- [X] T015 [P] Write `api-turistear/test/devolada/signature.test.ts`, citing `devolada-transfer-verification US1` and using the fake's key pair:
  - a valid signature verifies;
  - an altered body or timestamp fails;
  - an unknown `kid` fetches the key set once, then serves from cache;
  - a burst of requests with unknown `kid`s refetches the key set at most once a minute;
  - a malformed header returns `false`;
  - an unreachable key set throws `DevoladaUnavailableError`.
- [X] T016 Extract the verification cores into `api-turistear/src/routes/pos/verifyCore.ts` (D10), with `deps = {db, env, waitUntil}` (precedent: `queueCancellationEmail`, `routes/folios/handler.ts:819`):
  - `verifyFolioPayment(deps, {organizationId, folioId, paymentId: string | 'all', actorId: string | null, reference?: string, at, refuseCancelled?: boolean})`:
    - flip rows with a guarded `UPDATE folio_payments SET verification='verified', verified_at, verified_by … WHERE organization_id = ? AND folio_id = ? AND verification = 'pending' [AND id = ?] RETURNING id`;
    - roll `folios.payment_verification` up to `verified` (with `payment_verified_at` / `_by`) with a guarded `UPDATE folios … WHERE payment_verification = 'pending' AND NOT EXISTS (SELECT 1 FROM folio_payments WHERE folio_id = ? AND organization_id = ? AND verification = 'pending') RETURNING id`;
    - return `{flipped, rollupVerified}`: whether this call's row flip and its rollup update matched;
    - write the `payment_verified` event;
    - with `refuseCancelled`, do nothing for a cancelled sale.
  - `releaseClearedFolio(deps, {organizationId, folioId, at})`:
    - move the paid-path side effects that are inline in `verifyPayment` (`api-turistear/src/routes/pos/handler.ts:2862-2986`) into it;
    - sign live slot lines with `signLineTickets`;
    - issue the portal token (export `issuePortalLink` from `handler.ts:820`);
    - send the ticket email through `deps.waitUntil`;
    - emit `payment_verified` and `tickets_delivered`.
  - Make `verifyPayment` (`handler.ts:2779`) call both with `paymentId: 'all'` and the admin as actor — releasing only when `flipped && rollupVerified` — keeping its behaviour identical. Its missing cancelled check is defect 1, out of scope. `payment-verification.test.ts` must pass unedited.

**Checkpoint**: Foundation ready. The API suite and the scope-boundary suites pass, and the migration applies in tests.

---

## Phase 3: User Story 1 - A transfer sale clears itself when Banxico confirms the money (Priority: P1) 🎯 MVP

**Goal**: An admin connects Devolada. A full sale by transfer gets a payment link the seller sends by WhatsApp, and a *confirmed* verdict, by webhook or sweep, releases the tickets with «Sistema» as the actor. Unconnected organizations see no change.

**Independent Test**: Connect with test credentials, sell a full sale by Transferencia, then advance the test payment to *confirmed*. The sale is verified by «Sistema», with tickets released and no admin action (spec US1; quickstart §2 steps 1-4).

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [X] T017 [P] [US1] Write `api-turistear/test/devolada/connection.test.ts` for `PUT/GET/DELETE /api/organizations/me/devolada` (contracts/turistear-api.md § Connection):
  - **Connect**: a valid test key returns 200 with `{connection: {status: 'connected', mode: 'test', key_hint}}`, creates a born-expired probe link (`customerRef` `turistear-conexion`), and registers `DEVOLADA_WEBHOOK_URL`.
  - **Refusals**:
    - bad format → 400;
    - rejected key → 422 `DEVOLADA_CREDENTIAL_REJECTED`;
    - real key in the test environment → 422 `DEVOLADA_MODE_NOT_ALLOWED`;
    - missing CLABE → 409 `DEVOLADA_CHANNEL_UNAVAILABLE` with message `clabe`;
    - suspended business → 409 `DEVOLADA_BUSINESS_SUSPENDED`;
    - Devolada down → 502 `DEVOLADA_UNAVAILABLE`.
  - **Address conflict**: a foreign address returns 409 `DEVOLADA_WEBHOOK_CONFLICT` (message = that URL); the same request with `replace_webhook: true` returns 200 and stores `replaced_webhook_url`.
  - **Health**: GET returns live webhook health, and `health_error` when Devolada is down. A `broken` connection whose probe now passes reads `connected` again; one whose probe still fails stays `broken`, and a second read within 15 minutes does not probe again (D2).
  - **Disconnect**: DELETE sets `disconnected`, retires the current credential, and is idempotent. The view then has `mode`, `key_hint`, `webhook` and `health_error` null, and nothing is read from Devolada.
  - **Replacing the key** (D21): a PUT with another key, of the same business or of another one, creates a new current credential and retires the previous one, which stays readable while a link that uses it is unresolved. The view shows the new `key_hint` and `mode`, and lists the previous key in `previous_keys` with its `pending_links` while it has unresolved links, a `closed` link whose payment is in flight included; once they resolve, `previous_keys` is `[]`. A disconnected organization's view keeps the list.
  - **No address in this environment** (`env.DEVOLADA_WEBHOOK_URL = ''`, as locally and on previews): connecting neither reads nor writes Devolada's address, and the health's `webhook.is_ours` is `null`.
  - **Unreadable key** (`env.DEVOLADA_CREDENTIAL_KEY` missing): connecting answers 500 `INTERNAL_ERROR`, and the fake records no call.
  - **Secrecy**: no response ever contains the key or the ciphertext. `GET /api/organizations/me` returns only `devolada: {status, mode}`, for an admin and for an agent alike.
  - **Roles**: an agent gets 403 on all three routes.
  - **Isolation** (`seedTwoOrgs`): org B's admin sees `connection: null` and cannot change org A.
- [X] T018 [P] [US1] Write `api-turistear/test/devolada/checkout-link.test.ts` for `POST /api/pos/folios`:
  - **Connected org, full sale by transfer, no `payment_reference`**:
    - 201 with the folio paid, `payment_verification: 'pending'`, no QR;
    - `payment_link` with `kind: 'sale'`, `amount` = total, `state: 'open'`, a `url`, and `expires_at` ≤ min(now + 24 h, first service start);
    - one `payment_link_issued` event;
    - the fake received `customerRef` = folio id, `askCents` = total, `Idempotency-Key` = link id.
  - A `payment_reference` that is sent is not stored.
  - **Create times out**: `payment_link: null`, `payment_link_error: 'DEVOLADA_UNAVAILABLE'`, link `abandoned`, sale pending on the manual path.
  - **Business suspended**: link `failed`, matching error code, connection `broken`.
  - **Connection already `broken`**: 201, `payment_link: null`, `payment_link_error` = its `broken_reason`, a link row written `failed` with no call to Devolada, today's reference rule, the sale pending on the manual path (D6).
  - **Credential unreadable** (stored under another `DEVOLADA_CREDENTIAL_KEY`): 201, `payment_link: null`, `payment_link_error: 'DEVOLADA_UNAVAILABLE'`, a link row written `failed` with no call to Devolada, the sale pending on the manual path (D6, D17).
  - **Too little time** (D7): a sale whose first service starts in less than 15 minutes, or has started within the organization's sales grace (`sales_cutoff_offset_minutes` below 0): 201, `payment_link: null`, `payment_link_error: 'PAYMENT_LINK_TOO_SHORT'`, a link row written `failed` with no call to Devolada, the sale pending on the manual path.
  - In each of the four cases above, the sale's row carries `payment_link.label` `link_failed` and is not `verification_auto`.
  - **Right after checkout** the row's `verification_auto` is true, and `GET /api/folios/counts` counts the sale in `verification_auto` (D14).
  - **Cash sale for a connected org**: no link.
  - **Unconnected org**: the response has no `payment_link` keys and the reference rule is unchanged (US1 scenario 5).
  - **Idempotent replay**: returns `payment_links`.
- [X] T019 [P] [US1] Write `api-turistear/test/devolada/webhook.test.ts` for `POST /api/webhooks/devolada` (research D4):
  - **Rejected deliveries**, none of which changes anything:
    - bad signature → 401;
    - malformed JSON → 400;
    - more than 64 KiB → 400;
    - unknown `paymentLinkId` → 200, no rows written;
    - `isTest` mismatching the link's `mode` → 200, event outcome `mode_mismatch`.
  - **A confirmed verdict**:
    - the link's payment row becomes `verified` with `verified_by` NULL, and the folio becomes `verified`;
    - live slot lines get a QR and a portal token is issued;
    - `payment_verified` and `tickets_delivered` notifications are written;
    - the receipt number lands in `folio_payments.reference` and `folios.payment_reference`;
    - the link becomes `paid`;
    - a `payment_verified` event with a NULL actor and `payload.source = 'devolada'`.
  - **The re-read decides**:
    - a duplicate `eventId` is not applied twice;
    - a body that says *confirmed* while the re-read says *validating* yields only a snapshot;
    - a re-read answering `NOT_FOUND` changes nothing;
    - an unreachable re-read returns 503, and a retry later applies the verdict.
  - **The link's own key** (D21):
    - after the admin replaced the key with another business's, a verdict for a link the previous key created is re-read with that key and applied;
    - a disconnected organization's link is applied the same way, while its credential is kept (FR-004).
  - **Waiting statuses**:
    - *validating* → label `validating`;
    - `queued_for_credit` → the connection's `credit_paused_at` is set (`credit_paused_since` in its view). A later re-read that shows *confirmed* directly, with no *validating* in between, clears it; a `queued_for_credit` payment on a retired credential's link leaves it unset (D21);
    - `awaiting` → label `needs_tracking_key`.
  - **`verification_auto` follows the payment** (D14): true while the link awaits its first payment before `expires_at`, and while the payment is *validating*, even past `expires_at`; false with `queued_for_credit`, with `awaiting`, once a link with no payment is past `expires_at` (before any sweep), and for a sale on the manual path. It is false too while the connection is `broken` and the link uses its current credential, and true again once the connection is `connected`; a link on a retired credential keeps it.
  - **Spec edge cases**:
    - the admin verifies the sale by hand, then *confirmed* arrives: the verdict is recorded, and nothing is signed or emailed a second time;
    - a *validating* payment applied over a stored *confirmed* one keeps *confirmed* and changes nothing.
- [X] T020 [P] [US1] Write `api-turistear/test/devolada/isolation.test.ts` with `seedTwoOrgs`, each organization connected to its own fake business:
  - a verdict for org A's link changes only org A;
  - org B's GET of org A's sale returns 404;
  - counts are computed per organization;
  - an event naming org A's link but signed by an unknown key returns 401.
- [X] T021 [P] [US1] Write the recovery cases of `api-turistear/test/devolada/sweep.test.ts`. Call `sweepDevoladaPayments(env, now)` directly, because dates are frozen in tests (`test/helpers/apply-migrations.ts:39-45`):
  - a link whose notification never arrived is applied by the sweep;
  - a never-checked link is re-read on the first run;
  - a link checked under 10 minutes ago is skipped; one checked over 10 minutes ago is re-read;
  - each organization gets at most 50 Devolada calls per run;
  - `RATE_LIMITED` stops only that organization;
  - one organization failing does not stop another (fail-soft), including one whose credential cannot be decrypted, which is skipped and logged;
  - with 60 links due, a run checks 50 (past `expires_at` first, then never checked, then the oldest `last_checked_at`) and the next run the other 10;
  - a disconnected organization's open link is still followed;
  - a link is checked with the credential that created it, after the admin replaced the key with another business's too (D21);
  - a retired credential with no unresolved link is erased, a disconnected organization's included. One with an unresolved link is kept, a `closed` link whose payment is still in flight included (seeded directly, since nothing closes links before PR 2);
  - a link whose retired credential Devolada rejects moves to the current credential when that one can read it; otherwise it becomes `failed`, goes to the admin, and is never cancelled;
  - a rejected current credential marks the connection `broken` and changes no link: its links are not checked again in that run, and the links of a retired credential, of another business, are still checked in the same run (D21);
  - a retired credential's `BUSINESS_SUSPENDED` changes nothing: its links are retried at the next run, and the connection stays `connected` (D21);
  - a link left in `creating` for more than 5 minutes becomes `abandoned`, and a younger one is left alone (D12);
  - until PR 2 (D19): after a successful re-read, an unpaid link past `expires_at` (no payment, or an *expired* one) moves to `expired`, nothing is cancelled, and the next run does not re-read it; a failing re-read changes nothing. T045 replaces this case.
- [X] T022 [P] [US1] Write `api-turistear/test/devolada/link-view.test.ts`:
  - `deriveLinkLabel` follows the precedence table in contracts/turistear-api.md § Labels, one case per row, a link in `creating` included;
  - `loadPaymentLinkViews` picks the latest non-superseded payment and orders links newest first.

### Implementation for User Story 1

- [X] T023 [US1] Implement `api-turistear/src/utils/devoladaLinkView.ts` (D14):
  - `deriveLinkLabel(link, currentPayment, saleCancelled): PaymentLinkLabel`, following the § Labels precedence;
  - `loadPaymentLinkViews(db, organizationId, folioIds): Promise<Map<folioId, PaymentLinkView[]>>`:
    - one query for links and one for payments, filtered by organization and `folio_id IN (…)` and backed by the `(organization_id, folio_id)` indexes;
    - current payment = latest non-`superseded` by `devolada_created_at`;
    - instants in epoch seconds;
    - the exact `PaymentLinkView` shape of the contract.
- [X] T024 [US1] Implement `api-turistear/src/routes/devolada/connection.ts` (D1-D3, D21), with `deps = {db, env}`:
  - `connectDevolada(deps, {organizationId, adminId, apiKey, replaceWebhook})`:
    0. check that this environment can encrypt the key (`DEVOLADA_CREDENTIAL_KEY` present, 32 bytes); otherwise 500 `INTERNAL_ERROR` before any call to Devolada (D17);
    1. check the format;
    2. probe with `createPaymentLink({customerRef: 'turistear-conexion', askCents: 100, mode: 'one_time', expiresAt: now - 60s, label: 'Prueba de conexión — Turistear Ya!'})` and a fresh UUID `Idempotency-Key`, mapping refusals to the contract's `ApiError`s;
    3. compare `isTest` with `env.DEVOLADA_KEY_MODE`;
    4. if `env.DEVOLADA_WEBHOOK_URL` is not empty: `getWebhook` → 404 means `putWebhook`; the same URL is kept; a different URL is refused with `DEVOLADA_WEBHOOK_CONFLICT` unless `replaceWebhook`, which then `putWebhook`s;
    5. in one `db.batch` (constitution V): insert the encrypted key as a new `devolada_credentials` row, with the probe's mode and the key hint; upsert `devolada_connections` (status `connected`, `broken_reason` NULL, `current_credential_id` = the new row); and set `retired_at` on the previous current credential, if any.
  - `disconnectDevolada(deps, {organizationId, adminId})`: idempotent; retires the current credential and clears `current_credential_id`. The retired key stays readable while a link that uses it is unresolved (FR-004, D21).
  - `readConnectionView(deps, organizationId)`: `mode` and `key_hint` from the current credential; `previous_keys`, each retired credential not yet erased that still has unresolved links, with its `key_hint` and their count (`pending_links`), read through the `(credential_id, state)` index (D21); live `getWebhook` + `listFailedDeliveries`, fail-soft to `health_error: 'DEVOLADA_UNAVAILABLE'`. While `broken`, and at most once every 15 minutes (`probed_at`, stamped before the call), it first repeats step 2's probe with the current credential, and a pass returns the connection to `connected` with a guarded `UPDATE … WHERE status = 'broken'` (D2). While disconnected, it calls nothing, and `webhook` and `health_error` are null.
  - `loadCurrentCredential(deps, organizationId)`: `{connection, credentialId, mode, apiKey} | null`, for a connection that has a current credential (`connected` or `broken`); `apiKey` is null when it cannot be decrypted here (D17). New links use it, and only a `connected` connection with a readable key issues them (T026).
  - `loadLinkCredential(deps, link)`: `{credentialId, apiKey} | null`, the link's key (the one that created it, unless the fallback moved it), while its ciphertext exists, whatever the connection's status. Every call about a link uses it (D21).
  - `fallBackLinkCredential(deps, link)`: for a link whose retired credential Devolada rejected with `AUTHENTICATION_ERROR`, on a re-read, a close or a replay. If the current credential can read it (`getPaymentLink`), move the link to it; otherwise mark the link `failed`, and its payment keeps its last state for the admin to decide (D21). It never runs for the current credential: Devolada rejecting that one calls `markConnectionBroken`, and its links wait for the admin's new key. A retired credential's `BUSINESS_SUSPENDED` never calls it either: those links wait for the next run.
  - `markConnectionBroken(db, organizationId, reason)` and `setCreditPaused(db, organizationId, paused)`.
- [X] T025 [US1] Add the admin-only routes `GET /me/devolada`, `PUT /me/devolada` and `DELETE /me/devolada` to `api-turistear/src/routes/organizations/index.ts`, with handlers in `handler.ts` and the PUT schema `{api_key: z.string(), replace_webhook: z.boolean().optional()}` in `schema.ts`:
  - each route: `requireRole('admin')` and a `zValidator` hook like `pos/index.ts:33-37`;
  - each answers `{connection}` per the contract;
  - add `devolada: {status, mode}` to `getMyOrganization` / `serializeOrg` (`handler.ts:40-111`), with the mode of the current credential, and `not_connected` / `null` when no row exists. Read it with a separate query and never add a credential column to `orgColumns`.
- [X] T026 [US1] Implement `api-turistear/src/routes/devolada/links.ts` (D6, D7):
  - `computeLinkExpiry({issuedAt, lines, timezone, kind})`, where `lines` are the live lines the link collects for: every live line of the sale, except for a settlement of one line, which passes that line alone (D7):
    - the earliest of: issued + 24 h; the first start among `lines` (slot `slot_date` + `slot_start_time` in the org time zone; a stay = the end of its check-in day);
    - for `deposit` and `settlement`, also the earliest `booking_expires_at` among `lines`.
  - `MIN_LINK_LIFETIME` = 15 minutes, one constant citing D7.
  - `issuePaymentLink(deps, {organizationId, folioId, folioPaymentId, folioLineId, kind, amount, requestedBy, customerName, concept})`, called for an organization whose connection has a current credential, `connected` or `broken`. When no call can succeed (steps 0 and 1), it inserts the row straight as `failed`, with that `credential_id` and its `mode`, and calls nothing at Devolada: the sale then shows `link_failed`, and a deposit keeps its apartado waiting for the admin (D6, D8):
    0. compute the expiry; if it is less than `MIN_LINK_LIFETIME` away, record `failed` and return `{error: 'PAYMENT_LINK_TOO_SHORT'}`, so the payment takes the manual path (D7);
    1. read the current credential (`loadCurrentCredential`). If the connection is `broken`, record `failed` and return `{error: <its broken_reason>}`. If the key cannot be decrypted (D17: no key, or not the key it was encrypted with), record `failed` and return `{error: 'DEVOLADA_UNAVAILABLE'}`, logging it without the key. Either way the sale stays on the manual path and never answers 500 after it committed;
    2. insert the link row in state `creating`, with that `credential_id` and its `mode` (D21);
    3. call `createPaymentLink(…, {idempotencyKey: id + (attempt > 1 ? '#' + attempt : ''), fast: true})` with `mode: 'one_time'` and `customerRef` = folio id;
    4. success → `open`, storing `devolada_link_id` and `url`. A cancellation may already have marked the row `closing` (D13): the id and the URL are stored whatever the state, and only a row still `creating` becomes `open`, so the close can reach Devolada;
    5. refused → `failed`, and `markConnectionBroken` for `AUTHENTICATION_ERROR`, `BUSINESS_SUSPENDED` or `CHANNEL_UNAVAILABLE`;
    6. timeout, network error or another retryable answer → `abandoned`, through a guarded update `WHERE state = 'creating'`: a row a cancellation already marked `closing` stays `closing`, and the sweep replays its create to learn Devolada's id (D12 step 3).

    On `open` it writes a `payment_link_issued` event with the seller as actor. It returns `{link: PaymentLinkView} | {error: code}`.
- [X] T027 [US1] Change `confirmSale` in `api-turistear/src/routes/pos/handler.ts` (922-2019), citing D6:
  1. Load the organization's Devolada connection next to the org row (982-998).
  2. When connected and the method is `transfer` **for a full sale**, skip the reference requirement (1404-1414) and store `payment_reference` NULL. A `broken` connection keeps today's reference rule, since its seller sees the field (T037). A transfer deposit keeps today's manual path, reference rule included, until T058 gives deposits their link.
  3. For a full sale of an organization whose connection is `connected` or `broken`, after the batch and the post-commit block (1908-1958), call `issuePaymentLink` with `kind: 'sale'`, `folioPaymentId` = the inserted payment row id and `amount` = total. A `broken` connection only records the `failed` link (T026). Deposits get their link in T058.
  4. Add `payment_link` (and `payment_link_error`) to the 201 body (1959-2018) only for those organizations.

  Unconnected organizations must keep byte-identical behaviour.
- [X] T028 [US1] Implement `api-turistear/src/routes/devolada/apply.ts` (D9, the Story 1 subset). `applyDevoladaPayment(deps, {link, payment})`:
  - Upsert `devolada_payments` by `devolada_payment_id`; never overwrite a final status with a non-final one. Return early when `applied_status === status` — an optimization only: the guarantee against applying twice is each branch's guarded write (D9).
  - *validating*, `queued_for_credit`, or `awaiting`: snapshot only. `setCreditPaused(true)` on `queued_for_credit` for a link on the current credential, and `false` whenever a payment stored as `queued_for_credit` moves to any other status, a final verdict included: a re-read may never show the *validating* in between (data-model § devolada_connections).
  - *confirmed* on a `sale` link with the sale not cancelled:
    1. `verifyFolioPayment({paymentId: link.folio_payment_id, actorId: null, reference: receipt_number, refuseCancelled: true})`;
    2. `releaseClearedFolio` only when step 1 returned `flipped && rollupVerified` and the sale is paid (D10);
    3. set `folios.payment_reference` = receipt number;
    4. link → `paid`;
    5. update the connection's `last_verdict_at`.
  - Every other status: snapshot only. Stories 2 and 3 complete them.
  - *confirmed* on a `deposit` or `settlement` link: snapshot only, and the sale is not touched. PR 2 brings those kinds, and its preview writes them into dev's database while dev still runs PR 1 (research D19).
  - Set `applied_status` and `applied_at` only when a branch acted: *validating*, `queued_for_credit` and awaiting, whose snapshot is their whole action, and *confirmed* on a `sale` link whose sale is not cancelled. The statuses and kinds this PR only snapshots stay unmarked, so PR 2 applies them (research D9, D19). Always set `link.last_checked_at`.
- [X] T029 [US1] Implement the public webhook as its own resource `api-turistear/src/routes/webhooks/` (D4, constitution IV) and mount it with `app.route('/api/webhooks', webhooks)` in `api-turistear/src/index.tsx` (77-91), next to the other `/api` routers:
  - `index.ts`: the router (`POST /devolada`, no `authMiddleware`) with one validation middleware that runs the *before parsing* and *parse* steps below and stores the parsed event in the context;
  - `schema.ts`: the Zod schema of Devolada's `WebhookEvent`;
  - `handler.ts`: the *route* and *re-read* steps.

  It follows research D4 steps 1-8:
  - **Before parsing**:
    - check `content-length` and the raw text against 64 KiB → 400 `WEBHOOK_PAYLOAD_INVALID`;
    - verify with `verifyDevoladaSignature` → 401 `WEBHOOK_SIGNATURE_INVALID`.
  - **Parse and route**:
    - Zod-validate `WebhookEvent` → 400;
    - find the link by `devolada_link_id`; unknown → `console.log('[devolada] unknown link')` and 200;
    - mode mismatch → event outcome `mode_mismatch`, 200;
    - insert into `devolada_events`, or bump `attempts` when the stored outcome is `failed`; skip when it is `applied` or `no_change`.
  - **Act on the re-read**:
    - `loadLinkCredential` (the link's key, whatever the connection's status; D21), then `getPayment` (8 s) → `applyDevoladaPayment`. A credential already erased means nothing about the link is left to read (its payments are final, or no credential can read it, D21): 200, outcome `no_change`, logged;
    - a credential that cannot be decrypted → 503 `DEVOLADA_UNAVAILABLE`, outcome `failed` (D17);
    - `DevoladaUnavailableError` or an unreachable re-read → 503 `DEVOLADA_UNAVAILABLE`, outcome `failed`;
    - an `AUTHENTICATION_ERROR` or `BUSINESS_SUSPENDED` re-read → outcome `failed`, 503 (Devolada retries). With the current credential, `markConnectionBroken` too, and the sweep catches up once the admin fixes the key. With a retired one the connection is untouched: the sweep applies D21's fallback to an `AUTHENTICATION_ERROR`, and retries a `BUSINESS_SUSPENDED` at its next run.
  - **Answer** 200 `{received: true}`.
- [X] T030 [US1] Add the read model in `api-turistear/src/utils/folioDetail.ts` and `api-turistear/src/utils/folioListRows.ts`:
  - `payment_links: PaymentLinkView[]` in `readFolioDetail` (`api-turistear/src/utils/folioDetail.ts`);
  - `payment_link` (latest unresolved, else latest, else null) on list rows in `api-turistear/src/utils/folioListRows.ts`;
  - `verification_auto` (D14; data-model § Flags and counts) on list rows and the detail, from one SQL predicate that T031's count reuses. The predicate excludes a link on the current credential of a `broken` connection, so its sale waits in Por verificar until the key works again (spec clarification of 2026-10-16).

  Both use `loadPaymentLinkViews` with one batched call per response and no per-row correlated subquery.
- [X] T031 [US1] Add `verification_auto` to `GET /api/folios/counts` in `api-turistear/src/routes/folios/handler.ts` (286-317). It counts the sales whose `verification_auto` flag holds (T030; data-model § Flags and counts): pending with a live line, and every pending payment row collected by an `open` link that either has no payment yet and is not past `expires_at`, or whose current payment is *validating* without `awaiting`, even past `expires_at`, and that does not use the current credential of a `broken` connection. PR 1 has no attention item yet; T050 adds that clause to the same predicate. Back it with the `(organization_id, folio_id)` indexes (D14).
- [X] T032 [US1] Implement `sweepDevoladaPayments(env, now)` in `api-turistear/src/routes/devolada/sweep.ts` (D12, recovery):
  - **Selection**: links `open` with `last_checked_at` NULL or older than now − 10 min, grouped by organization, then by folio, in this order: past `expires_at` first, then never checked, then the oldest `last_checked_at` (D12).
  - **Per organization**, whatever its connection's status, checking each link with the link's credential (`loadLinkCredential`, D21):
    - for each folio, `listPaymentsByCustomer(folioId)` once per credential of the links being checked → `applyDevoladaPayment` for every payment whose `paymentLinkId` is one of our links;
    - update `last_checked_at`;
    - stop after 50 calls, or on `RATE_LIMITED`;
    - on `AUTHENTICATION_ERROR` or `BUSINESS_SUSPENDED` from the current credential, call `markConnectionBroken` and skip that credential's links for this run, changing none of them; the links of other credentials go on. From a retired credential, an `AUTHENTICATION_ERROR` runs `fallBackLinkCredential` for its links, and a `BUSINESS_SUSPENDED` leaves them for the next run (D21).
  - **Unpaid expiry, until PR 2** (D19): after a successful re-read, a link past `expires_at` whose current payment is absent or *expired* moves to `expired` through a guarded update, and nothing is cancelled: its sale is already back in Por verificar (D14). T049 replaces this step with D9's unpaid branch.
  - **Links left in `creating`**: a link in `creating` for more than 5 minutes moves to `abandoned` through a guarded update, because the request that wrote it died (D12 step 3); T071 replays it.
  - **Fail-soft**: try/catch per organization, loading each credential included, and per folio, counting `failed`. An unreadable credential skips its links and is logged (D17).
  - **Cleanup**: erase the `ciphertext` and `iv` of every retired credential with no unresolved link (`creating`, `open`, `closing` or `abandoned`, or `closed` with a payment still in flight; data-model), found through the `(credential_id, state)` index, setting `erased_at`.
  - **Returns** `{checked, applied, failed}`.
  - **Wiring**: a third independent `ctx.waitUntil` in `scheduled()` in `api-turistear/src/index.tsx` (116-149), with `now = new Date(controller.scheduledTime)`, logging `[devolada] …`.
- [X] T033 [P] [US1] Mirror the contract types in the app, starting with the new `app-turistear/src/features/devolada/types.ts`:
  - `PaymentLinkView`, `PaymentLinkLabel`, `DevoladaConnectionView` (with `previous_keys`) and `OrganizationDevoladaSummary` in `app-turistear/src/features/devolada/types.ts`;
  - `payment_links` and `verification_auto` on `FolioDetail` (`app-turistear/src/features/folios/types.ts:127-183`);
  - `payment_link` and `verification_auto` on `FolioListItem` (`folios/types.ts:29-71`), and `payment_link` on `FolioHistoryItem` (`app-turistear/src/features/pos/types.ts:247-278`);
  - `devolada` on `MyOrganization` (`app-turistear/src/services/organizationsService.ts:6-48`);
  - `verification_auto` on `FolioCounts` (`app-turistear/src/services/foliosService.ts:61-70`);
  - the confirm response `{folio, payment_link?, payment_link_error?}` (`app-turistear/src/services/posService.ts:134-140`);
  - the same fields in the MSW fixtures `aFolio` and `aFolioCounts` (`app-turistear/src/test/handlers/folios.ts:6-35`), with an unconnected organization's values (constitution IV).
- [X] T034 [P] [US1] Implement `app-turistear/src/services/devoladaService.ts` (`getDevoladaConnection`, `connectDevolada`, `disconnectDevolada`, using the shared `request`) and the hooks `useDevoladaConnection`, `useConnectDevolada` and `useDisconnectDevolada` in `app-turistear/src/features/devolada/hooks/`. Mutations invalidate `['organization','me']` and the connection key.
- [X] T035 [P] [US1] Add MSW handlers and fixtures to `app-turistear/src/test/handlers/devolada.ts`:
  - handlers for `GET/PUT/DELETE /api/organizations/me/devolada`;
  - fixtures `aConnection()`, with `previous_keys: []`, and `aPaymentLink(overrides)`, copying shapes asserted by T017-T019 (constitution IV);
  - register them in `app-turistear/src/test/server.ts`.
- [X] T036 [US1] Build the Ajustes surface in `app-turistear/src/features/devolada/components/`:
  - **`DevoladaConnectionCard`**: `SectionCard` with a `StatusChip` + text for the status («Conectada» / «Con fallas» / «Sin conectar»), the mode («Real» / «Prueba»), «Clave …abcd», health («Avisos funcionando» / «Avisos con fallas» / «Verificación en pausa», and «Avisos: solo revisión periódica» when `webhook.is_ours` is `null`), and «Último veredicto: …» from `last_verdict_at` (FR-005). For each entry of `previous_keys`, one line «La clave anterior …abcd todavía tiene N enlaces pendientes. No la revoques en Devolada hasta que terminen.», singular for one (FR-005; D21). Copy from contracts/turistear-api.md § Action copy; «llave» already names the passkeys.
  - **`ConnectDevoladaSheet`**: `FormSheet` with a «Clave de API de Devolada» field and the submit «Conectar».
    - `DEVOLADA_WEBHOOK_CONFLICT` opens a `ConfirmSheet` «¿Reemplazar la dirección de avisos?» showing the current URL, then resends with `replace_webhook: true`.
    - Every error code maps to its copy in contracts § Action copy, and a broken connection shows its reason with the same copy.
  - **Disconnect**: a `ConfirmSheet`.

  Mount the card in `app-turistear/src/pages/SettingsPage.tsx` right after «Punto de venta» (after line 728). While connected, the «Referencia obligatoria en transferencias» switch (700-726) gets the helper «Con Devolada conectado, las transferencias se cobran con enlace de pago».
- [X] T037 [US1] Extract `app-turistear/src/features/pos/components/TransferPaymentFields.tsx` from `app-turistear/src/pages/PosCheckoutPage.tsx` (the reference field 400-419 and the consequence line 421-440):
  - **Connected** (`org.devolada.status === 'connected'`) **on a full sale**: no reference field, and the line «Se generará un enlace de pago para cobrar por WhatsApp». An apartado deposit keeps today's field until T058.
  - **Connection `broken`**: today's field and US-A88 rules, plus the line «El cobro con Devolada tiene fallas; un administrador verificará la transferencia» (FR-010; contracts § Action copy).
  - **Otherwise**: today's field and US-A88 rules, unchanged.

  `PosCheckoutPage` renders the component and omits `payment_reference` for a connected full sale.
- [X] T038 [US1] Add `paymentLinkWhatsAppUrl(link, ctx)` and the three shipped default texts (`PAYMENT_LINK_TEMPLATES`, keyed by link kind) to `app-turistear/src/features/pos/delivery.ts`, as `depositVerifiedWhatsAppUrl` does (bug `verify-send-empty-link`):
  - fill the link's own tokens (`{link_amount}`, `{payment_link}`, `{link_expires}`), then `fillTemplate` (101-115) for the shared ones;
  - return through the private `whatsAppUrl` (117-121), so an unusable phone gives `null`;
  - take the texts and tokens from contracts/turistear-api.md § WhatsApp message, and format the amount with `app-turistear/src/components/money.ts`;
  - extend `app-turistear/src/features/pos/delivery.test.ts`: one case per kind, a deposit's text that never promises tickets, and `null` for an unusable phone.
- [X] T039 [US1] Build `PaymentLinkStatusChip` and `PaymentLinkCard` in `app-turistear/src/features/devolada/components/` and export them from `app-turistear/src/features/devolada/index.ts`:
  - **`PaymentLinkStatusChip`**: one chip per label code, each with icon + text per § Labels.
  - **`PaymentLinkCard`**, titled «Enlace de pago»:
    - `MoneyText` amount and, while the link is open, «Vence hoy a las HH:MM» or «Vence mañana a las HH:MM» in the organization's time zone (the same rule as `{link_expires}`);
    - the chip and, while the link is open, a primary «Cobrar por WhatsApp» that opens `paymentLinkWhatsAppUrl` (the canonical verb, constitution VII);
    - for `link_failed`, and for a `payment_link_error`, an `AlertCard` with that case's copy from contracts § Action copy: «No se pudo crear el enlace de pago…», or «Ya no hay tiempo para cobrar con enlace…» for `PAYMENT_LINK_TOO_SHORT`.
- [X] T040 [US1] Update the receipt in `app-turistear/src/pages/FolioReceiptPage.tsx`, a new `app-turistear/src/features/pos/components/ReceiptPaymentStatus.tsx` and `app-turistear/src/features/pos/components/PaymentBreakdown.tsx`:
  - render the `payment_link_error` alert when the checkout answered one, so «Ya no hay tiempo para cobrar con enlace…» shows for `PAYMENT_LINK_TOO_SHORT`; otherwise `PaymentLinkCard` for the sale's latest link, a `failed` one included;
  - give `useFolio` (`app-turistear/src/features/pos/hooks/useFolio.ts`) `refetchInterval: 15000` while the label is `awaiting_payment`, `validating`, `needs_tracking_key` or `credit_paused`;
  - move the receipt's status line and chip into `ReceiptPaymentStatus`, which shows «Pago en verificación» while `payment_verification` is `pending`, instead of «Venta confirmada» (74-82) and the «Pagado» chip (143-148). The rule then lives outside `pages/`, where it can be tested (constitution VI; research D16);
  - pass the sale's `verification_auto` to `PaymentBreakdown`, whose pending rows then read «En verificación» instead of «Por verificar» (62-64), because «Por verificar» names the admin's work (D14);
  - drop «Folio {id}» (85) (constitution VII).
- [X] T041 [US1] Keep the sales Devolada is resolving out of Por verificar, and show their status, in `app-turistear/src/features/folios/folioFacets.ts`, `folioCardState.ts`, `components/PendingWorkBar.tsx`, `components/FolioCard.tsx`, `components/FolioDetailScreen.tsx` and `app-turistear/src/layout/AppLayout.tsx` (D14; spec clarification of 2026-10-15):
  - the `por_verificar` facet (`folioFacets.ts:69-76`) leaves out rows with `verification_auto`, and `folioAction` (`folioCardState.ts:166-229`) gives them no `verify`;
  - one helper beside the facet in `folioFacets.ts`, `porVerificarCount(counts)` = `verification − verification_auto`, feeds `PendingWorkBar` (37) and the admin badge in `AppLayout.tsx` (90-127), so the badge, the Ventas bar and Hoy show the same number; the badge adds `folio_requests`;
  - `PaymentLinkStatusChip` on sale rows in `FolioCard.tsx`;
  - in `FolioDetailScreen.tsx`, the chip in the header chips (342-363), where on a `verification_auto` sale it replaces the «Por verificar» chip (345), and the `PaymentLinkCard`, so an admin can send the link too (contracts: `url` goes to the seller and to admins).
- [X] T042 [US1] Add the four new event types and the automatic `payment_verified` to `app-turistear/src/features/folios/components/FolioTimeline.tsx`, in `eventPrimary` (72-156), `EVENT_TONE` (28-39) and `EVENT_ICON` (41-52). Add them to the event union (`app-turistear/src/features/folios/types.ts:207-217`).

  | Event | Copy |
  |---|---|
  | `payment_link_issued` | «Enlace de pago creado» |
  | `payment_link_closed` | «Enlace de pago cerrado» |
  | `payment_verdict` | per status, from § Labels |
  | `transfer_not_received` | «No se recibió la transferencia — venta cancelada» |
  | `payment_verified` with `payload.source === 'devolada'` | «Transferencia verificada por Devolada · Comprobante {receipt_number}» |
- [X] T043 [P] [US1] Write the app tests under `app-turistear/src/features/devolada/components/`, `app-turistear/src/features/pos/components/` and `app-turistear/src/features/folios/`, each citing `devolada-transfer-verification US1`, and each component test running `expectNoA11yViolations`:
  - `app-turistear/src/features/devolada/components/DevoladaConnectionCard.test.tsx`: connect; conflict → replace confirm; disconnect; error copy; one line per previous key still in use, singular for one enlace, and none when `previous_keys` is empty.
  - `app-turistear/src/features/devolada/components/PaymentLinkCard.test.tsx`: every label renders copy + icon; the WhatsApp URL contains the link and the formatted amount; no expiry line and no WhatsApp action once the link is not open; the failed and too-short alerts.
  - `app-turistear/src/features/pos/components/TransferPaymentFields.test.tsx`: connected hides the reference; broken keeps it and shows the failure line; unconnected keeps the US-A88 rules.
  - `app-turistear/src/features/pos/components/ReceiptPaymentStatus.test.tsx`: «Pago en verificación» and no «Pagado» while pending; «Venta confirmada» once verified.
  - `app-turistear/src/features/pos/components/PaymentBreakdown.test.tsx` (new): a pending row reads «En verificación» when the sale is `verification_auto`, «Por verificar» otherwise.
  - `app-turistear/src/features/folios/components/PendingWorkBar.test.tsx` (new): «Por verificar» shows `porVerificarCount`, the number the badge and Hoy show.
  - Extend `app-turistear/src/features/folios/components/FolioDetailScreen.test.tsx`: on a `verification_auto` sale the header shows the link's chip, not «Por verificar».
  - `app-turistear/src/features/folios/folioFacets.test.ts`, `folioCardState.test.ts` and `FolioCard.test.tsx`: a row with `verification_auto` is not in Por verificar and its card offers no «Verificar y enviar»; the same row without the flag is back; `porVerificarCount` subtracts it.
  - Extend `FolioTimeline.test.tsx` with the new event copy.

**Checkpoint**: Story 1 works end to end (quickstart §1 for US1, §2 steps 1-4 and 12-14). This is PR 1 (D19). Exceptions still wait in Por verificar for the admin, exactly as today, and transfer deposits and settlements keep today's manual path, reference included, until PR 2.

---

## Phase 4: User Story 2 - Anything short of a clean confirmation reaches the right person, with the reason (Priority: P2)

**Goal**:
- *partial* and *invalid* are labelled in Por verificar, with the admin's Verificar and Rechazar unchanged.
- Money that never arrived cancels the sale automatically, through a guarded system cancellation.
- *unapplied* money is flagged until the admin marks it returned.
- Tracking-key waits and paused credit are visible.

**Independent Test**: With test credentials, move payments to *partial*, *invalid* and *unapplied*: each shows in Por verificar with its label and amounts. Then let a full sale's link expire unpaid: «Sistema» cancels it and its seats return (spec US2; quickstart §2 steps 5-7, 11).

### Tests for User Story 2 ⚠️

- [X] T044 [P] [US2] Write `api-turistear/test/devolada/verdicts.test.ts`:
  - **partial**: the sale stays pending; its row's `payment_link.label` is `partial`, with asked and received amounts; the existing admin `POST /api/pos/folios/:id/verify` still verifies with the admin as actor, and `/reject` still cancels (FR-018).
  - **invalid**: label `invalid`.
  - **expired** on a full sale:
    - the folio and its live lines are cancelled with `cancellation_source: 'payment_not_received'` and reason «No se recibió la transferencia»;
    - seats and reservations are released exactly once;
    - `refund` and `commission_reversal` rows are written;
    - a `transfer_not_received` event with a NULL actor;
    - a `payment_rejected` notification;
    - the link becomes `expired`.
  - **expired** when the sale holds other positive money: no cancellation; the link is `expired`, and the sale stays pending in Por verificar, labelled `not_received` (D11's `'kept'`).
  - **expired** on a sale an admin verified by hand while its payment was in flight: no cancellation (D11).
  - **expired** on an already-cancelled sale: no second release.
  - **unapplied**:
    - label `unapplied` and an attention item;
    - `POST /api/devolada/payments/:id/resolve {action: 'returned'}` clears it;
    - org B gets 404 on the same id (`seedTwoOrgs`);
    - `accept` on an unapplied payment returns 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE`.
  - **confirmed on a cancelled sale**: treated as unapplied and not verified.
  - **superseded**: ignored, and its correction is applied.
  - **over** (received above the ask, e.g. Devolada's fee): confirmed; the ledger and the sale total keep the sale's amount, and `received_amount` holds what arrived (FR-020).
  - **tracking key**: `GET /api/pos/folios/:id` shows label `needs_tracking_key` to the seller.
  - **counts**: each sale counts once in `verification − verification_auto + devolada_attention`. A tracking-key wait on a sale link is counted by `verification` only. Unapplied money on a cancelled sale, and a settlement exception, are counted by `devolada_attention` only. A sale with *partial* or *invalid* is never `verification_auto`. A payment `queued_for_credit` on a settlement link is counted by `devolada_attention` only. A pending sale whose deposit link is *validating* while its settlement link has an exception counts once, and is not `verification_auto`.
- [X] T045 [P] [US2] Extend `api-turistear/test/devolada/sweep.test.ts` with expiry, passing a `now` past `expires_at`:
  - an unpaid link is cancelled through D11 only after a successful `listPaymentsByCustomer` re-read, replacing T021's PR 1 case, which only moved it to `expired`;
  - a failing re-read cancels nothing;
  - a payment *validating* at the expiry prevents cancellation;
  - a payment that ended *partial* or *invalid* cancels nothing at the expiry: the link becomes `expired`, the sale stays in Por verificar, and the next run does not re-read it (FR-016);
  - the seats are back on sale after one run (SC-009);
  - a link left `closing` because Devolada was down is closed by a later run, and `LINK_CLOSED` counts as closed; a `closing` link whose retired credential Devolada rejects takes D21's fallback, and one whose current credential is rejected stays `closing`, with the connection `broken` (T049);
  - a link that D11 marked `closing` while its create was still running is closed at Devolada once the create's outcome stored its id; one whose create never recorded an id is first replayed with the same key (T049, D12).

### Implementation for User Story 2

- [X] T046 [US2] Extract the seat and reservation release statements of `rejectPayment` (`api-turistear/src/routes/pos/handler.ts:3015-3089`) into `buildInventoryReleaseStatements(db, organizationId, lines)`, exported from the new `api-turistear/src/routes/pos/unreceivedTransfer.ts`. `rejectPayment` keeps passing all its lines, so its behaviour is unchanged (`payment-verification.test.ts` unedited). *(Built: each counter clamped at zero, like every other release; research D11.)*
- [X] T047 [US2] Implement `cancelForUnreceivedTransfer(deps, {organizationId, folioId, linkId, at})` in `api-turistear/src/routes/pos/unreceivedTransfer.ts` (D11):
  1. **Claim the link**: `UPDATE devolada_links SET state='expired' … WHERE id = ? AND organization_id = ? AND state = 'open' RETURNING id`; nothing returned → `'noop'`.
  2. **Check the sale**: return `'kept'`, writing nothing more, if the sale is cancelled, if the row of `link.folio_payment_id` is no longer pending (an admin verified it by hand), if another link of the sale has an undecided payment in flight (*validating*, awaiting or `queued_for_credit`; one the admin accepted or dismissed does not count, whatever its last snapshot says, D21), or if the sale holds any positive payment row besides that one.
  3. **One `db.batch`, every statement gated on its own transition** (constitution V — the read in step 2 is never the only guard):
     - first, the folio cancelled `WHERE cancelled_at IS NULL`, stamping `cancelled_at = :at`, `cancellation_source 'payment_not_received'` and reason «No se recibió la transferencia»;
     - every later statement carries `WHERE EXISTS (SELECT 1 FROM folios WHERE id = ? AND organization_id = ? AND cancelled_at = :at AND cancellation_source = 'payment_not_received')`, inserts written as `INSERT … SELECT … WHERE EXISTS`:
       - its live lines cancelled `WHERE cancelled_at IS NULL`;
       - the `buildCancellationReversal({clawback: true})` rows (`api-turistear/src/utils/folioPayments.ts:215`);
       - `buildInventoryReleaseStatements` for live lines only;
       - the sale's other `creating` or `open` links marked `closing`, with `closed_reason 'cancelled'` (D13);
       - a `transfer_not_received` event with a NULL actor.

     Test it: when the sale is cancelled between step 2 and the batch, the batch writes nothing.
  4. **After the batch**: `emitNotification(…, 'payment_rejected')`, whose «tu folio» copy is fixed by defect 11's lite path before PR 2 (T077), then the new helper `closePaymentLinkRemote(deps, link)` in `api-turistear/src/routes/devolada/links.ts`, for the claimed link and for each link the batch marked `closing`. The helper uses the link's own credential (D21), is fail-soft, sends `PATCH close` with `Idempotency-Key 'close:' + id`, and treats `LINK_CLOSED` as closed. A refusal or an outage leaves the link `closing` for the sweep (T049); a rejected current credential also calls `markConnectionBroken`.

  It returns `'cancelled'`, `'kept'` or `'noop'`.
- [X] T048 [US2] Complete `applyDevoladaPayment` in `api-turistear/src/routes/devolada/apply.ts` (D9 table, sale and deposit columns):
  - *partial* / *invalid*: snapshot plus a `payment_verdict` event (NULL actor).
  - *expired*: `cancelForUnreceivedTransfer`; a `'kept'` result keeps the snapshot.
  - *unapplied*, or *confirmed* on a cancelled sale: snapshot plus a `payment_verdict` event.
  - *superseded*: snapshot only.
  - Set the connection's `last_verdict_at` on every final status.
- [X] T049 [US2] Add the unpaid-expiry branch to `api-turistear/src/routes/devolada/sweep.ts` (D12 step 2). Select `open` links past `expires_at` through the `(state, expires_at)` index. Only after a successful `listPaymentsByCustomer` re-read, act by the link's current payment:
  - none, or *expired*: `cancelForUnreceivedTransfer` for `sale` and `deposit` links;
  - in flight (*validating*, awaiting or `queued_for_credit`): nothing, and the link stays open;
  - *confirmed*: `applyDevoladaPayment` applies it, and nothing is cancelled;
  - *partial*, *invalid* or *unapplied*: the link moves to `expired` through a guarded update, and nothing else happens; the admin decides (FR-016).

  This replaces T032's PR 1 unpaid-expiry step. Settlement links come in T060. Add D12 step 3's `closing` retry here too, since PR 2 already closes links (T047, T060, T062): `closePaymentLinkRemote` until Devolada acknowledges, with D21's fallback when the link's retired credential is rejected; while its current credential is rejected the link stays `closing` (research D19, D21). A `closing` link whose create never recorded Devolada's id is first replayed with the same key, as T071 does for an abandoned one (D12 step 3).
- [X] T050 [US2] Add Devolada attention to the pending work and the counts in `api-turistear/src/utils/folioPendingWork.ts` and `api-turistear/src/routes/folios/handler.ts`:
  - add `devoladaAttentionFilter` (derived per data-model.md § Attention, the clause for a link no credential can read included) to `api-turistear/src/utils/folioPendingWork.ts`;
  - include it in the pending-work set (103-110), so `GET /api/folios` lists attention sales whatever their age, cancelled ones with unapplied money included;
  - add the `devolada_attention` flag to list rows and the detail, and its count to `GET /api/folios/counts` (`api-turistear/src/routes/folios/handler.ts:286-317`). The count includes only sales that `verification` does not already count (data-model § Flags and counts);
  - add `devoladaAttentionFilter` to the shared `verification_auto` predicate (T030, T031), so a pending sale with an attention item on another link is counted as well as listed.
- [X] T051 [US2] Create the admin router `api-turistear/src/routes/devolada/index.ts`, with `handler.ts` and `schema.ts`:
  - **Route**: `POST /payments/:id/resolve` behind `authMiddleware` and `requireRole('admin')`, validated with `zValidator`: `{action: 'accept' | 'dismiss' | 'returned', note?: string ≤ 500}`.
  - **Mount**: `app.route('/api/devolada', devolada)` in `api-turistear/src/index.tsx`.
  - **`returned`**: for an unresolved *unapplied* payment, or a *confirmed* one on a cancelled sale; sets `resolution`, `resolved_by` and `resolved_at` with `… WHERE id = ? AND organization_id = ? AND resolution IS NULL RETURNING` — no row returned (a double tap) → 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE` (D15).
  - **Errors**: 404 for another organization's payment; 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE` for a wrong status or kind, or one already resolved.
  - **`accept` / `dismiss`**: answer 409 until T062.
  - **Response**: `{folio}`, the `readFolioDetail` shape.
- [X] T052 [P] [US2] Mirror the Story 2 additions in the app (`app-turistear/src/features/folios/types.ts`, `app-turistear/src/services/devoladaService.ts`):
  - `payment_not_received` in the cancellation-source unions (`app-turistear/src/features/folios/types.ts`);
  - `devolada_attention` on `FolioListItem` and `FolioDetail` (`app-turistear/src/features/folios/types.ts`) and on `FolioCounts` (`app-turistear/src/services/foliosService.ts`), and in the fixtures `aFolio` and `aFolioCounts` (`app-turistear/src/test/handlers/folios.ts`);
  - `resolveDevoladaPayment` in `app-turistear/src/services/devoladaService.ts`, plus `useResolveDevoladaPayment` in `app-turistear/src/features/devolada/hooks/`, invalidating `['folios']` and `['pos']`;
  - an MSW handler for resolve in `app-turistear/src/test/handlers/devolada.ts`.
- [X] T053 [US2] Bring Devolada attention into Por verificar (`app-turistear/src/features/folios/`):
  - **Facet**: the `por_verificar` facet (`app-turistear/src/features/folios/folioFacets.ts:69-76`) also lists rows with `devolada_attention`, cancelled sales with unapplied money among them, and `folioAction` / `folioAttention` (`app-turistear/src/features/folios/folioCardState.ts:166-229`) give them their action.
  - **`FolioCard.tsx`**: shows the label and the asked, claimed and received amounts with `MoneyText` (FR-015).
  - **`FolioWorkActions.tsx`**: a sale or deposit exception shows its label, «Comprobante Devolada {receipt}» and the amounts inside today's «Pago por verificar» rung. Every other attention item gets a Devolada rung, ranked right after «Pago por verificar» and before the refund (`FolioWorkActions.tsx:99-107`), so one rung shows at a time: its label and amounts, plus «Ya lo devolví» (resolve `returned`) for unapplied money.
  - **Count**: `porVerificarCount` (T041) adds `devolada_attention`, for the badge, the Ventas bar and Hoy alike.
- [X] T054 [US2] Label money that never arrived in `app-turistear/src/features/pos/components/PaymentBreakdown.tsx`:
  - `app-turistear/src/features/pos/components/PaymentBreakdown.tsx` (62-64) shows «No recibido» instead of «Por verificar» for a pending row of a sale cancelled with `cancellation_source: 'payment_not_received'`;
  - wherever cancellation sources are labelled, `payment_not_received` reads «No se recibió la transferencia».
- [X] T055 [P] [US2] Extend the app tests in `app-turistear/src/features/folios/components/`, each citing `devolada-transfer-verification US2` and running axe:
  - `app-turistear/src/features/folios/components/FolioCard.test.tsx`: the `partial`, `invalid`, `unapplied`, `needs_tracking_key`, `credit_paused` and `not_received` labels;
  - `FolioWorkActions.test.tsx`: «Ya lo devolví» calls resolve `returned`.

**Checkpoint**: Stories 1 and 2 both work independently (quickstart §2 steps 5-7, 11).

---

## Phase 5: User Story 3 - Apartados: the deposit and the settlement each get their own link (Priority: P2)

**Goal**: A transfer deposit gets its own link and verifies only its own row. A settlement by transfer is a link request that is recorded only when *confirmed* (D8). An unpaid settlement leaves the apartado intact.

**Independent Test**: Create an apartado with a transfer deposit and confirm it: no tickets. Settle by transfer: a link appears and the sale is still an apartado. Confirm it: tickets (spec US3; quickstart §2 steps 8-9).

### Tests for User Story 3 ⚠️

- [X] T056 [P] [US3] Write `api-turistear/test/devolada/apartados.test.ts`:
  - **Deposit link at confirm**: `kind: 'deposit'`, `amount` = `down_payment`, `expires_at` ≤ the earliest live line clock.
  - **Deposit confirmed**: only the deposit row is verified; the sale is still a booking, with no QR.
  - **Settle by transfer** (`POST /api/pos/folios/:id/settle`, connected org):
    - 200 with the folio still a booking and `payment_link {kind: 'settlement', amount: balance}`;
    - no new `folio_payments`, allocation or commission rows;
    - a repeated settle returns the same link.
  - **Settlement confirmed**:
    - a payment row with `method 'transfer'`, `verified`, `verified_by` NULL, `collected_by = link.requested_by`, and `created_at` = the verdict;
    - allocations and the commission top-up;
    - `settled_at` / `settled_by`;
    - tickets signed.
  - **Deposit still pending when the settlement is confirmed**: no tickets until the deposit's link is confirmed (US3 scenario 4).
  - **Per-line settlement** (`/lines/:lineId/settle`): the link carries `folio_line_id`, and confirmation settles that line. Its `expires_at` is bounded by that line's own start and clock, not by an earlier line's: with an earlier line already past its clock, the later line still gets its link (D7).
  - **Settlement link expires unpaid** (sweep): link `expired`, the apartado unchanged.
  - **Settlement exceptions**: *partial* or *invalid* → link closed plus an attention item.
    - resolve `accept` records the settlement with `verified_by` = the admin;
    - resolve `dismiss` keeps the apartado;
    - once the apartado was settled in cash meanwhile, `accept` answers 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE`, and `dismiss` clears the item.
  - **Settlement verified by hand while in flight** (D15): resolve `accept` on a settlement payment that is *validating*, awaiting a tracking key or `queued_for_credit` records the settlement with `verified_by` = the admin and releases the tickets when the sale is paid. The link stays open; a later *confirmed* verdict records nothing more and ends the link `paid`. `dismiss` on a payment in flight answers 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE`. After the apartado's clock ran out, `accept` still records a payment submitted before its link expired (D8's bypass; US3 scenario 6).
  - **Apartado sweep guard** (D8, US3 scenarios 6-8). `sweepExpiredBookings` reads the time itself, so seed each line with a departure and a `booking_expires_at` that put the frozen test time past its release time (departure − `booking_grace_offset_minutes`), not only past its clock. Each case first shows that the same apartado without the hold is released at that time, so the test cannot pass without the guard:
    - it holds an apartado while it has a link in `creating` or `open`, or a settlement payment awaiting the admin's decision: *partial* or *invalid* and unresolved, or in flight on a link no credential can read. Once the admin accepts or dismisses it, the apartado expires as usual, and a stale *validating* snapshot never blocks the sweep;
    - it holds it while a transfer deposit that a link collects is still pending, whatever the link's state: *partial*, *invalid*, *unapplied*, expired but kept by D11 because the sale holds other money, a link no credential can read, or a link whose creation failed, one written `failed` without a call included (too little time, a `broken` connection, an unreadable key; D6). Once Devolada confirms it, or the admin verifies or rejects it, the apartado expires as usual (US3 scenario 7);
    - a held apartado gets no grace notice (`booking_grace_entered`) either, while the time is between its clock and its release time;
    - per line (US3 scenario 8): while one line's own settlement link is open, or its payment awaits the admin, another line past its release time is released, and the held line keeps its hold and its link. A whole-sale settlement link, a sale or deposit link, or a pending deposit holds every line;
    - a settlement confirmed after the clock, but submitted in time, is still recorded.
  - **Settlement link no credential can read** (D21): the link becomes `failed`. With a payment last seen in flight, the sale shows in Por verificar with «Sin enlace de pago — verificar a mano»; `accept` records the settlement, and `dismiss` keeps the apartado without calling Devolada.
  - **Link creation fails at settle**: today's manual settlement is recorded, together with `payment_link_error`.
  - **Settlement after departure** (a negative `booking_grace_offset_minutes`, so the link would stay open less than 15 minutes): today's manual settlement is recorded, with `payment_link_error: 'PAYMENT_LINK_TOO_SHORT'` (D7).
  - **Settlement in progress** (D8, D19): with a settlement link open, a line cancellation, a cash settlement and a transfer settlement for another scope (another line; the whole sale against one line's link; one line against the whole sale's link) answer 409 `SETTLEMENT_IN_PROGRESS` and change nothing; a transfer settlement for the same scope returns the link.
  - **Deposit link expires unpaid while the settlement link is open** (D11): with the settlement payment *validating*, nothing is cancelled; with no settlement payment, the sale is cancelled and its settlement link closed with `closed_reason 'cancelled'`.
  - **Isolation**: `seedTwoOrgs`.

### Implementation for User Story 3

- [X] T057 [US3] Extract `applySettlement(deps, {organizationId, folioId, folioLineId, method, reference, verification, verifiedBy, verifiedAt, collectedBy, settledBy, at, bypassExpiry?})` into `api-turistear/src/routes/pos/settleCore.ts`, from `settleBooking` (`api-turistear/src/routes/pos/handler.ts:2122-2468`) and `settleFolioLine` (2476-2697). It covers:
  - balance computation;
  - the payment row and allocations;
  - the commission top-up;
  - `settled_at` / `settled_by`;
  - the `payment` event (kind `settlement`);
  - the cleared branch through `releaseClearedFolio`.

  It takes an optional `claim` for Devolada callers (D8): a fresh payment-row id plus the settlement link to claim. The batch then opens with `UPDATE devolada_links SET folio_payment_id = :newId[, state = 'paid'] WHERE id = ? AND organization_id = ? AND kind = 'settlement' AND folio_payment_id IS NULL`, every later statement carries `WHERE EXISTS (SELECT 1 FROM devolada_links WHERE id = ? AND folio_payment_id = :newId)`, and it returns whether the claim matched. Release runs only if it did.

  Both handlers then call it without a claim, with behaviour unchanged: `settle-method.test.ts` and `payment-verification.test.ts` pass unedited. *(Built: the cleared branch keeps the seller's own release — the QR in the batch — rather than `releaseClearedFolio`, which would re-sign a line settled earlier; a proven settlement adds D10's notifications. The claimed batch writes the payment row before the claim, since D1 checks a foreign key at each statement. Research D8.)*
- [X] T058 [US3] Issue and apply deposit links in `api-turistear/src/routes/pos/handler.ts`, `api-turistear/src/routes/devolada/links.ts` and `api-turistear/src/routes/devolada/apply.ts`:
  - in `confirmSale` (`api-turistear/src/routes/pos/handler.ts`), call `issuePaymentLink` with `kind: 'deposit'`, `folioPaymentId` = the deposit row and `amount` = `down_payment` when the organization's connection is `connected` or `broken` and the deposit is a transfer. A `broken` connection only records the `failed` link, which still holds the apartado (T061);
  - extend T027's skip of the reference requirement to transfer deposits, and T037's `TransferPaymentFields` to hide the field for an apartado deposit when connected;
  - make sure `computeLinkExpiry` in `api-turistear/src/routes/devolada/links.ts` bounds a `deposit` link by every live line, and a `settlement` link by the lines it collects, the whole sale's or one line's own, with their earliest `booking_expires_at` (D7);
  - in `applyDevoladaPayment` (`api-turistear/src/routes/devolada/apply.ts`), apply *confirmed* on a `deposit` link as on a `sale` link (T028), which PR 1 only snapshots: verify the deposit row, set the reference, link `paid`. `releaseClearedFolio` runs only once the sale is paid and cleared, so a confirmed deposit releases nothing (US3 scenario 2).
- [X] T059 [US3] Settle by link in `settleBooking` and `settleFolioLine` (`api-turistear/src/routes/pos/handler.ts`), citing D8, when the organization's connection is `connected` or `broken` and the method is `transfer`:
  1. run today's guards;
  2. compute the balance (or the line balance);
  3. if a settlement link is already open: for the same scope (the same line, or the whole sale), return it; for any other scope, answer 409 `SETTLEMENT_IN_PROGRESS`. Otherwise `issuePaymentLink` with `kind: 'settlement'`, `folioLineId`, `amount` = balance and `requestedBy` = the user. Its expiry counts the whole sale's live lines for `settleBooking`, and that line alone for `settleFolioLine` (D7);
  4. answer `{folio: readFolioDetail, payment_link}` without recording any settlement;
  5. if no link is created, `PAYMENT_LINK_TOO_SHORT` and a `broken` connection included, fall back to today's manual transfer settlement and add `payment_link_error`. No reference is required while connected; a `broken` connection keeps today's reference rule. The `failed` or `abandoned` link stays as the record (T026).

  Until PR 3 closes and replaces settlement links, guard the writes that would leave one stale (research D19). While the sale has an open settlement link, a cash settlement in these two handlers, and a line cancellation in `cancelBookingLine` (`api-turistear/src/routes/pos/handler.ts:2702`) and `cancelFolioLine` (`api-turistear/src/routes/folios/handler.ts:1193`), answer 409 `SETTLEMENT_IN_PROGRESS`, next to today's `PAYMENT_UNVERIFIED` guard. T068 and T069 narrow it to a link whose payment is in flight.
- [X] T060 [US3] Add the settlement branches to `api-turistear/src/routes/devolada/apply.ts` and `sweep.ts` (D8, D9):
  - ***confirmed* on a `settlement` link**:
    1. `applySettlement` with the link `claim` (state → `paid`), method `transfer`, reference = receipt number, `verification 'verified'`, `verifiedBy` null, `collectedBy` and `settledBy` = `link.requested_by`, and `bypassExpiry` when the payment's `devolada_created_at` < `link.expires_at`;
    2. the claim itself records the new row id in `link.folio_payment_id` and moves the link to `paid`. A claim that does not match means the settlement is already recorded, by another processor or by the admin's *accept* (D15): record nothing more, and move the link to `paid` if it is still `open` (`UPDATE … SET state = 'paid' WHERE id = ? AND organization_id = ? AND state = 'open'`). Either way the branch acted, so `applied_status` is set.
  - ***partial* / *invalid***: `closePaymentLinkRemote`, link `closing` → `closed`, plus a `payment_verdict` event. This makes an attention item, and the apartado waits for the admin's decision (T061).
  - ***expired*, or an unpaid expiry in the sweep**: link `expired`, nothing else.
- [X] T061 [US3] Guard the apartado expiry sweep in `api-turistear/src/routes/pos/sweep.ts`, citing D8. A held line is neither released nor counted for the grace notice (`booking_grace_entered`).
  - **Every line is held**, so skip the folio in the due-folio query (49-67), while it has:
    - a `sale` or `deposit` link, or a whole-sale settlement link (no `folio_line_id`), in `creating` or `open`;
    - a whole-sale settlement payment awaiting the admin's decision (data-model § Attention): *partial* or *invalid* and unresolved, or in flight on a link no credential can read (`failed`), while nobody has decided it by hand;
    - a pending deposit row that a `deposit` link collects (`devolada_links.folio_payment_id`), whatever the link's state, a row written `failed` without a call included: Devolada's verdict, or the admin's Verificar or Rechazar, decides it first (US3 scenario 7; research defect 4).
  - **Only its line is held** while a settlement link of one line is in `creating` or `open`, or its payment awaits the admin's decision: leave that line out of the due-folio query's line clause and out of `lineFacts` and `dueLines` (122-134), so the other lines follow their own clocks (US3 scenario 8; US-AG54 D5).

  For the settlement clauses, never skip on a payment's stored status alone: a link no credential can read keeps its last snapshot for good. Correlate each subquery on `organization_id` and `folio_id`, and on `folio_line_id` for the per-line one, so the `(organization_id, folio_id)` indexes serve it (T074). `test/pos/pos-bookings-sweep.test.ts` must still pass.
- [X] T062 [US3] Implement resolve `accept` and `dismiss` in `api-turistear/src/routes/devolada/handler.ts`:
  - **`accept`**: allowed for a `settlement` link whose payment is *partial*, *invalid*, or still in flight (*validating*, awaiting a tracking key, `queued_for_credit`), and unresolved (D15). On a sale that is not cancelled, call `applySettlement` with the link `claim`, `verifiedBy` = the admin, `collectedBy` = `link.requested_by`, and `bypassExpiry` when the payment's `devolada_created_at` < `link.expires_at`, as T060 does (D8); the same claimed batch sets the payment's `resolution 'accepted'`. A claim that does not match (a double tap) → 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE`. On a cancelled sale → 409 `FOLIO_CANCELLED`. On an apartado that no longer owes, because it was settled another way while the payment waited → 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE`; `dismiss` is the way out. For a payment in flight the link is not closed: its verdict later finds the claim taken, records nothing more and ends the link (T060).
  - **`dismiss`**: for *partial* or *invalid*, and for a payment in flight on a link no credential can read (`failed`, D21). Any other payment in flight answers 409, since closing its link would make it *unapplied* (D13). Set `resolution 'dismissed'` with `… WHERE resolution IS NULL RETURNING` (no row → 409), then `closePaymentLinkRemote` (fail-soft), except for a `failed` link, which no credential can reach.
  - **Both**: set `resolved_by` / `resolved_at` and answer `{folio}`.
- [X] T063 [US3] Settle by link in the app (`app-turistear/src/features/bookings/components/SettleSheet.tsx`):
  - `app-turistear/src/features/bookings/components/SettleSheet.tsx` renders `TransferPaymentFields`;
  - for a connected transfer, submitting shows the returned `PaymentLinkCard` instead of closing as settled. On `payment_link_error` the settlement was recorded on the manual path, so the sheet closes as settled and shows the alert;
  - type the settle responses `{folio, payment_link?, payment_link_error?}` in `app-turistear/src/services/bookingsService.ts:24-44`.
- [X] T064 [US3] Show the settlement link and its exceptions (`app-turistear/src/features/bookings/components/BookingActions.tsx`, `app-turistear/src/features/folios/components/FolioWorkActions.tsx`, `app-turistear/src/features/folios/components/FolioDetailScreen.tsx`):
  - **`BookingActions.tsx`**: while a settlement link is open, show its `PaymentLinkCard` and replace «Liquidar saldo» / «Liquidar todo» with the chip «Liquidación en verificación».
  - **Refusals**: `SETTLEMENT_IN_PROGRESS`, which T059 raises from this PR, shows its copy from contracts § Action copy wherever a line cancellation or a settlement is refused: `BookingActions.tsx` and `SettleSheet.tsx` for the seller, `FolioDetailScreen.tsx` for the admin's line cancellation.
  - **`FolioWorkActions.tsx`**: in T053's Devolada rung, settlement exceptions, and a settlement payment of a link no credential can read (D21), get «Verificar» (resolve `accept`) and «Descartar» (resolve `dismiss`) `ConfirmSheet`s, using `useResolveDevoladaPayment`. A settlement payment still in flight gets that rung on the sale's detail with «Verificar» only, whether or not the sale is in Por verificar (D15). Copy from contracts/turistear-api.md § Action copy: one verb per action (constitution VII, research D15).
- [X] T065 [P] [US3] Extend the app tests in `app-turistear/src/features/bookings/components/SettleSheet.test.tsx` and `FolioWorkActions.test.tsx`, citing `devolada-transfer-verification US3` and running axe:
  - `app-turistear/src/features/bookings/components/SettleSheet.test.tsx`, connected mode: no reference field; the link card after submit; on the fallback, the sheet closes as settled and shows its alert; the `SETTLEMENT_IN_PROGRESS` copy.
  - `FolioWorkActions.test.tsx`: accept and dismiss for an exception and for a settlement whose link no credential can read, and «Verificar» alone for a settlement still in flight.

**Checkpoint**: Stories 1, 2 and 3 work (quickstart §2 steps 8-9). This is PR 2 together with Story 2 (D19).

---

## Phase 6: User Story 4 - A sale that stops taking money closes its link (Priority: P3)

**Goal**: Every write that stops a sale taking a payment closes its open links: inside the batch locally, then at Devolada. A line cancellation that changes an apartado's balance replaces its settlement link.

**Independent Test**: Cancel a sale with an open link and see the link closed. Advance a late payment to *unapplied* and see the admin alert (spec US4; quickstart §2 step 10).

### Tests for User Story 4 ⚠️

- [X] T066 [P] [US4] Write `api-turistear/test/devolada/link-closing.test.ts`:
  - **Cancellations close the link**: an apartado with an open settlement link cancelled by an admin, an agent, or a tourist request approval. The link is marked `closing` with `closed_reason 'cancelled'` in the same batch, a `PATCH close` follows, and it ends `closed`.
  - **Line cancel**: a whole-sale settlement link closes and the response carries a replacement link for the new balance, or none when the sale no longer owes. A line's own link closes with `closed_reason 'cancelled'` and no replacement when that line is cancelled, and stays open when another line is cancelled.
  - **Other writes that close**, with the reason recorded:

    | Write | `closed_reason` |
    |---|---|
    | admin reject | `rejected` |
    | admin manual verify, for the links of the rows it verified | `verified_by_admin` |
    | cash settlement of what an open settlement link collects (any for a whole-sale link; that line or the whole sale for a line's link). Another line's cash settlement leaves a line's link open | `settled_otherwise` |
    | line cancellation that leaves the sale alive, for a whole-sale link | `amount_changed` |
    | D11 cancellation | its own link ends `expired`; the sale's other links `cancelled` |

    The apartado expiry sweep never closes an open link: a link expires by the apartado's clock, before its release time, and one whose payment is in flight holds the apartado (D7, D8; its guard is tested in T056).

  - **Never under a payment in flight while the sale lives** (D13):
    - a manual verification while the link's payment is *validating* leaves the link open. Its *confirmed* verdict is recorded, releases nothing a second time and ends the link `paid`; an *invalid* verdict closes it as `verified_by_admin`; an *expired* one cancels nothing;
    - verifying a deposit by hand leaves the sale's settlement link open;
    - while a settlement link's payment is in flight, a line cancellation and a cash settlement that would close it answer 409 `SETTLEMENT_IN_PROGRESS` and change nothing; one that leaves it open, for another line, goes ahead. Without a payment in flight they close the link, and the line cancellation replaces a whole-sale link;
    - cancelling or rejecting the sale closes the link even with a payment in flight, and that payment later arrives as *unapplied*: by notification, and by the sweep when the notification is lost, with the link's credential kept until then, a retired one included (FR-012, D12). A `closed` link that no key can read any more becomes `failed`, and its retired credential is then erased (D21).
  - **Devolada down during close**: the link stays `closing` and a later sweep closes it; a `LINK_CLOSED` answer counts as closed.
  - **Abandoned links**: the sweep replays the create with the same key and closes the link if it exists, with `closed_reason 'abandoned'`, or marks it `failed` if refused, a link T032 moved from `creating` included.
  - **Isolation**: `seedTwoOrgs`.

  *(Built: the abandoned links and the follow-up of closed ones are in `test/devolada/sweep.test.ts`, beside the sweep's other cases. Added: a confirmed payment on a link a cash settlement or a line cancellation closed first is money to return, and a cancellation keeps a link whose money the sale already holds open under its payment — research D9, D13.)*

### Implementation for User Story 4

- [X] T067 [US4] Add to `api-turistear/src/routes/devolada/links.ts` (D13):
  - `markLinksClosingStatement(db, organizationId, folioId, reason, {kinds?, folioPaymentIds?, forLine?, keepInFlight?})`, returning an un-awaited `UPDATE devolada_links SET state='closing', closed_reason=? WHERE organization_id=? AND folio_id=? AND state IN ('creating','open')` for `db.batch`. `forLine` limits settlement links to the whole-sale ones and that line's own, and `keepInFlight` leaves out a link whose current payment is in flight (D13);
  - `closeOpenLinksAfterWrite(deps, organizationId, folioId)`, which calls `closePaymentLinkRemote` for every `closing` link of the sale. *(Built: the in-flight exclusion is one rule for every write, narrower than `keepInFlight`: a link whose money already reached the sale is never closed while its payment is in flight, a cancellation included (research D13). `forLines` takes several lines, since the expiry sweep cancels several at once; `rowsVerified` scopes Verificar's links to the rows its own batch flipped. The statement returns the links it marked, and `closesLinkInFlight` is the refusals' read of the same scope. Each closing also writes the timeline's `payment_link_closed` (data-model § New `folio_events` types) in the same batch: once per link, by whoever stopped the sale.)*
- [X] T068 [US4] Close links on every cancellation in `api-turistear/src/routes/folios/handler.ts` and `api-turistear/src/routes/pos/handler.ts`:
  - add `markLinksClosingStatement(…, 'cancelled')` to the batches of `cancelFolioPriced` / `applyCancellation` (`api-turistear/src/routes/folios/handler.ts:445, 775`), and to `cancelFolioLinesPriced` (964) with `forLine`: a whole-sale settlement link with `'amount_changed'` when the sale keeps a live line, `'cancelled'` when it does not, and the cancelled line's own link with `'cancelled'` (D13);
  - after the write, call `closeOpenLinksAfterWrite` through `c.executionCtx.waitUntil` from `cancelFolio` (881), `cancelFolioLine` (1193), `approveCancellationRequest` (1483), `cancelBooking` (`api-turistear/src/routes/pos/handler.ts:3141`) and `cancelBookingLine` (2702);
  - the expiry sweep leaves remote closing to `sweepDevoladaPayments`;
  - narrow T059's guard in `cancelFolioLine` and `cancelBookingLine`: 409 `SETTLEMENT_IN_PROGRESS` only when the cancellation would close a settlement link whose payment is in flight. Otherwise the cancellation goes ahead, closing the link only when it touches what the link collects (D13). *(Built: the cancellation cores return the links they marked, and a handler closes them at Devolada only when there are some.)*
- [X] T069 [US4] Close links on the other writes in `api-turistear/src/routes/pos/handler.ts` and `api-turistear/src/routes/devolada/apply.ts`, closing remotely after each write via `waitUntil` (D13):
  - `rejectPayment` (2993) adds `markLinksClosingStatement(…, 'rejected')` to its batch;
  - `verifyPayment`'s admin path marks `verified_by_admin` only the links that collect the rows it verified, and only those with no payment in flight (`keepInFlight`). `applyDevoladaPayment` closes a link it left open once that link's payment is final: *confirmed* → `paid`; *partial* or *invalid* → `closing` with `verified_by_admin`;
  - a cash settlement in `settleBooking` / `settleFolioLine` closes an open settlement link (`settled_otherwise`) when it settles part of what the link collects: `settleBooking` any open settlement link, and `settleFolioLine` a whole-sale link or that line's own. While that link's payment is in flight it still answers 409 `SETTLEMENT_IN_PROGRESS`. A cash settlement of another line goes ahead and leaves that line's link open. This narrows T059's guard. *(Built: `verifyFolioPayment({closeVerifiedLinks})` marks them inside Verificar's own batch. A confirmed settlement on a link a write closed records nothing and is money to return: the claim refuses a link whose `closed_reason` is set, and the label, the attention filter and «Ya lo devolví» read one predicate, `confirmedToReturnSql` — research D9, D13.)*
- [X] T070 [US4] Replace the settlement link on line cancellation in `cancelBookingLine` (`api-turistear/src/routes/pos/handler.ts:2702`) and `cancelFolioLine` (`api-turistear/src/routes/folios/handler.ts:1193`). When the cancellation closed a whole-sale settlement link and the sale still owes, issue a replacement for the new balance after the write (`issuePaymentLink`, kind `settlement`), and add `payment_link` / `payment_link_error` to the response. A line's own link is never replaced, and a sale that no longer owes, such as one whose settlement the admin already recorded (D15), gets none. A link whose payment is in flight never gets here: T068 refuses that cancellation. *(Built: issued by the first link's seller, who collects the settlement; research D13.)*
- [X] T071 [US4] Add the abandoned branch and the follow-up of closed links to `api-turistear/src/routes/devolada/sweep.ts` (D12 steps 1 and 3; the `closing` retry is T049's):
  - `abandoned` → replay `createPaymentLink`, with the link's credential (D21) and the same `Idempotency-Key`. If it exists, store `devolada_link_id`, close it and record `closed_reason 'abandoned'`. If refused, mark it `failed`. An `AUTHENTICATION_ERROR` on a retired credential takes D21's fallback first; on the current one, the link stays `abandoned` and the connection is `broken`.
  - a `closed` link whose current payment is still in flight, unchecked for 10 minutes → the same per-sale `listPaymentsByCustomer` re-read with the link's credential, then `applyDevoladaPayment`, until that payment's verdict (FR-012). Select them across organizations through `devolada_payments (status, link_id)`. A rejected retired credential takes D21's fallback: the link moves to the current credential, or becomes `failed` when no key can read it, and its cancelled sale has nothing left to follow (spec clarification of 2026-10-16). *(Built: an abandoned link is replayed once its create is 5 minutes old, like the `closing` replay. The selection of closed links starts from devolada_payments (status, link_id); a unary `+` keeps the planner off (state, expires_at), since closed links only grow.)*
- [X] T072 [US4] When a cancel response carries `payment_link`, show «El enlace de pago cambió — vuelve a enviarlo» with the new `PaymentLinkCard` in `app-turistear/src/features/bookings/components/BookingActions.tsx`. Type those cancel responses in `app-turistear/src/services/bookingsService.ts` and `app-turistear/src/services/foliosService.ts`. Now that a cash settlement closes the link, «Liquidar saldo» comes back while the settlement link waits for its first payment; the chip «Liquidación en verificación» stays only while its payment is in flight (research D16). *(Built: one more copy row, for a replacement that could not be created — contracts § Action copy.)*
- [X] T073 [P] [US4] Extend `app-turistear/src/features/bookings/components/BookingActions.test.tsx`, citing `devolada-transfer-verification US4` and running axe: the replacement-link notice after a line cancellation; «Liquidar saldo» while the settlement link waits for its first payment, and the chip while its payment is in flight.

**Checkpoint**: All four stories work independently. This is PR 3 (D19).

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Verification and record-keeping across stories. Each PR runs the items that apply to it.

- [X] T074 [P] Write `api-turistear/test/devolada/query-plans.test.ts`. Run `EXPLAIN QUERY PLAN` through `env.DB` on the new correlated reads:
  - `loadPaymentLinkViews`;
  - the attention filter in `folioPendingWork.ts`;
  - the `verification_auto` and `devolada_attention` counts;
  - the apartado expiry guard of T061, its folio clauses and its per-line clause;
  - the `previous_keys` count of `readConnectionView` (T024);
  - the sweep's credential cleanup (T032) and its selection of closed links whose payment is in flight (T071).

  Assert that no `SCAN` happens inside a correlated subquery (BUG-042, constitution § Additional constraints). *(PR 3: the sweep's closed links whose payment is in flight, and the writes' closing statement.)*
- [ ] T075 [P] Run `/security-review` over `api-turistear/src/routes/webhooks/`, `api-turistear/src/utils/devoladaSignature.ts`, `api-turistear/src/utils/devoladaCredential.ts` and `api-turistear/src/services/devolada.ts`. Confirm:
  - no key or ciphertext in any log or response;
  - the signature is verified before parsing;
  - the organization is resolved only through `devolada_link_id`;
  - every call about a link uses the link's credential, one of the owning organization's own (D21), and a retired credential is erased once nothing it serves is unresolved;
  - no file but `api-turistear/src/services/devolada.ts` names Devolada's host or paths, the key set included (constitution VIII; grep);
  - the 64 KiB limit is enforced;
  - the production mode policy holds.
- [ ] T076 Run `specs/006-devolada-transfer-verification/quickstart.md`:
  - §1, including the scope-boundary `git diff --exit-code` check;
  - §2 steps 1-14 against Devolada test businesses;
  - §3, on the pull request's preview and, after the merge, on dev.
- [ ] T077 [P] Register the thirteen defects of research.md § Defects found through `/speckit-bug-assess`, one entry each under `.specify/bugs/<slug>/`, without fixing them in this feature. Defect 11 is the exception: take it through the whole lite path (`-assess`, `-fix`, `-test`) before PR 2 ships, because D11 newly sends that message.
- [ ] T078 [P] Audit the citations. Every file in `api-turistear/test/devolada/` and every new app test cites `devolada-transfer-verification US<n>`. Every non-obvious rule under `api-turistear/src/routes/devolada/` and `api-turistear/src/routes/pos/{verifyCore,settleCore,unreceivedTransfer}.ts` cites `D<n>`. Each new route's suite has `seedTwoOrgs` cases.
- [ ] T079 Amend `specs/006-devolada-transfer-verification/spec.md` and `research.md` in place with whatever the build changed: decisions added or withdrawn in build, scenarios rewritten (constitution I). Set the spec's Status to `Implemented` once PR 3 merges.
- [ ] T080 [P] Add a §4 «Measuring the outcomes» to `specs/006-devolada-transfer-verification/quickstart.md`. Give the read-only aggregate SQL that measures, per organization and without customer data:
  - SC-001: confirmed payments released with no admin action;
  - SC-002: minutes from the verdict to the tickets;
  - SC-004: payments waiting more than 24 h without a label;
  - SC-008: transfer share of payments, 60 days after connecting.

  The sources are `folio_payments`, `devolada_payments` and `devolada_links`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion; they then build on each other (below)
- **Polish (Final Phase)**: T074-T075 and T078 apply to every PR; T076, T077, T079 and T080 run once all stories are complete, except T077's defect 11, whose lite path comes before PR 2

### User Story Dependencies

These stories are not independent in code, by design. They share the link, verdict and sweep machinery that Story 1 introduces.

- **User Story 1 (P1)**: Starts after Foundational. It is the MVP, with no dependency on other stories.
- **User Story 2 (P2)**: Depends on US1 (links, `applyDevoladaPayment`, webhook, sweep). It is independently testable, because sale exceptions need nothing from US3.
- **User Story 3 (P2)**: Depends on US1, and on US2 for `closePaymentLinkRemote` (T047) and the resolve router (T051). Ship it in the same PR as US2 (D19).
- **User Story 4 (P3)**: Depends on US1, and on US3 for settlement links, which are what a line cancellation replaces.

### Within Each User Story

- Tests are written first and must FAIL before implementation
- API before app: the contract mirrors (T033, T052) follow the API shapes their tests assert
- Extracted cores (T016, T046, T057) keep their callers' behaviour identical; run the scope-boundary suites right after each
- Story complete, and its checkpoint validated, before moving to the next priority

### Parallel Opportunities

- **Setup**: T003, T004 and T005 run in parallel; T006 is independent of code.
- **Foundational**:
  - T010, T012 and T013 run in parallel (separate new files); T011 follows T012, whose `getSigningKeys` it calls;
  - T014 and T015 follow their subjects;
  - T007 → T008 → T009 run in sequence, since they share `schema.ts`.
- **US1**:
  - the six test files T017-T022 run in parallel;
  - the app tasks T033, T034 and T035 run in parallel with each other and with the API implementation;
  - T036-T042 come after T033.
- **US2**:
  - T044 and T045 run in parallel;
  - T052 runs in parallel with T046-T051.
- **US3 and US4**: their test files run in parallel with their app tasks.

---

## Parallel Example: User Story 1

```bash
# Tests first, in parallel (different files):
Task: "T017 connection.test.ts — PUT/GET/DELETE /api/organizations/me/devolada"
Task: "T018 checkout-link.test.ts — POST /api/pos/folios with a connected org"
Task: "T019 webhook.test.ts — POST /api/webhooks/devolada"
Task: "T020 isolation.test.ts — seedTwoOrgs"
Task: "T021 sweep.test.ts — recovery"
Task: "T022 link-view.test.ts — labels"

# App mirrors and plumbing, in parallel with the API implementation:
Task: "T033 types in app-turistear/src/features/devolada/types.ts and the existing mirrors"
Task: "T034 app-turistear/src/services/devoladaService.ts + hooks"
Task: "T035 app-turistear/src/test/handlers/devolada.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T044 verdicts.test.ts"
Task: "T045 sweep.test.ts — expiry cases"
Task: "T052 app mirrors + resolve service/hook + MSW handler"
```

## Parallel Example: User Story 3

```bash
Task: "T056 apartados.test.ts"
Task: "T065 SettleSheet.test.tsx and FolioWorkActions.test.tsx — connected mode, accept/dismiss"
```

## Parallel Example: User Story 4

```bash
Task: "T066 link-closing.test.ts"
Task: "T073 BookingActions.test.tsx — replacement-link notice"
```

---

## Implementation Strategy

Run `/speckit-analyze` before `/speckit-implement`. The constitution's Workflow & Quality Gates require it to report no CRITICAL finding. Each PR is its own worktree off `origin/main` and targets `main` (constitution § Development Workflow). Its preview applies its migrations to dev's D1 before the merge; the merge deploys dev; a `v*` tag releases production.

### MVP First (User Story 1 Only) — PR 1

1. Complete Phase 1: Setup (T001-T006), including the constitution amendment
2. Complete Phase 2: Foundational (T007-T016)
3. Complete Phase 3: User Story 1 (T017-T043)
4. **STOP and VALIDATE**: quickstart §1 and §2 steps 1-4 and 12-14; scope-boundary suites unedited
5. Check the preview (quickstart §3), merge, and validate §3 on dev with real notifications. Then tag a `v*` release for production, once `DEVOLADA_CREDENTIAL_KEY` is in the `production` environment (T003). Connected organizations get automatic verification; every exception still waits for the admin, as today

### Incremental Delivery

| PR | Contents | Stories | Validate with |
|---|---|---|---|
| 1 | T001-T043 | US1 | quickstart §1, §2 steps 1-4 and 12-14 |
| 2 | T044-T065, after defect 11's lite path (T077) | US2 + US3 | quickstart §2 steps 5-9, 11 |
| 3 | T066-T073 | US4 | quickstart §2 step 10 |
| each | T074, T075, T078 | — | — |
| once all stories are done | T076, T077, T079, T080 | — | — |

Each PR leaves `main` deployable. Migration 0073 lands in PR 1, and reaches dev's D1 with PR 1's preview, before the merge; its unused tables are harmless until PR 2.

### Parallel Team Strategy

With a second implementer once Foundational is done:
- one takes the API side of the current story;
- the other takes its app side (types, services, MSW, components), working from the contracts.

They merge at the story's checkpoint.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- Never edit the three scope-boundary suites. A failure there means the change broke today's flow; fix the change, not the test
- Never call Devolada outside `api-turistear/src/services/devolada.ts`, and never inside a `db.batch` (constitution VIII)
- Every new tenant-scoped query filters by `organization_id`. The only exceptions are the webhook's lookup by `devolada_link_id`, a globally unique key, and the sweep's selection, across organizations, of due links and of payments in flight on closed links, which then acts on each with that link's own organization (constitution III as T006 amends it; research D4, D12)
- Commit after each task or logical group, with Conventional Commits scoped by domain (`feat(payment-verification): …`)
- Stop at any checkpoint to validate the story independently
