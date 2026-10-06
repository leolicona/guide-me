---

description: "Task list for Automatic Transfer Verification with Devolada"
---

# Tasks: Automatic Transfer Verification with Devolada

**Input**: Design documents from `/specs/001-devolada-transfer-verification/`. Read these before starting:
- [plan.md](./plan.md);
- [spec.md](./spec.md);
- [research.md](./research.md) — decisions D1–D20;
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
- Line references such as `handler.ts:2882` point at the code as read on 2026-10-06; re-locate them by symbol name if they have moved

## Path Conventions

- API: `api-turistear/src/`, tests in `api-turistear/test/` (Vitest in workerd, real D1)
- App: `app-turistear/src/`, tests co-located as `<Component>.test.tsx` (jsdom, MSW, axe)
- Migrations: `api-turistear/migrations/NNNN_snake_case.sql`, hand-written, mirrored by hand in `api-turistear/src/db/schema.ts`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Configuration, error vocabulary and the constitution amendment that every later task relies on.

- [ ] T001 Add the vars `DEVOLADA_API_BASE_URL`, `DEVOLADA_KEY_MODE` and `DEVOLADA_WEBHOOK_URL` to all three profiles in `api-turistear/wrangler.jsonc`. Named envs inherit no vars (lines 13-15), so repeat them in each profile:

  | Profile (lines) | `DEVOLADA_API_BASE_URL` | `DEVOLADA_KEY_MODE` | `DEVOLADA_WEBHOOK_URL` |
  |---|---|---|---|
  | local (40-50) | `https://api.devoladapago.com` | `test` | `""` |
  | dev (85-93) | `https://api.devoladapago.com` | `test` | `https://api-dev.turistearya.com/api/webhooks/devolada` |
  | production (125-133) | `https://api.devoladapago.com` | `real` | `https://api.turistearya.com/api/webhooks/devolada` |

  Add a comment citing `devolada-transfer-verification D17`.
- [ ] T002 Declare the four Devolada bindings in `api-turistear/src/bindings.d.ts`, then run `pnpm cf-typegen:api` to refresh `api-turistear/worker-configuration.d.ts`:
  - `DEVOLADA_API_BASE_URL: string`
  - `DEVOLADA_KEY_MODE: 'real' | 'test'`
  - `DEVOLADA_WEBHOOK_URL: string`
  - `DEVOLADA_CREDENTIAL_KEY: string` (secret)
- [ ] T003 [P] Document the secret `DEVOLADA_CREDENTIAL_KEY` in `api-turistear/.dev.vars.example`, and provision it before PR 1 merges:
  - 32 random bytes, base64, generated with `openssl rand -base64 32`;
  - the developer sets it in each environment — `wrangler secret put DEVOLADA_CREDENTIAL_KEY --env dev`, then `--env production` — and confirms it with `wrangler secret list`. Without it, connecting Devolada fails at runtime;
  - never shared between environments (constitution VIII);
  - local dev reads it from `.dev.vars`.
- [ ] T004 [P] Pin the Devolada bindings in the `miniflare.bindings` block of `api-turistear/vitest.config.ts` (lines 16-33):
  - `DEVOLADA_API_BASE_URL: 'https://devolada.test'`. The host cannot resolve, so an unstubbed call fails instead of reaching Devolada (D17).
  - `DEVOLADA_KEY_MODE: 'test'`
  - `DEVOLADA_WEBHOOK_URL: 'https://api.test/api/webhooks/devolada'`
  - `DEVOLADA_CREDENTIAL_KEY`: a fixed base64 string encoding 32 bytes.
- [ ] T005 [P] Add the nine new error codes to the `ErrorCode` union in `api-turistear/src/types/errors.ts` (lines 1-39), exactly as listed in contracts/turistear-api.md § Error codes:
  - `DEVOLADA_CREDENTIAL_REJECTED`, `DEVOLADA_MODE_NOT_ALLOWED`, `DEVOLADA_CHANNEL_UNAVAILABLE`
  - `DEVOLADA_BUSINESS_SUSPENDED`, `DEVOLADA_WEBHOOK_CONFLICT`, `DEVOLADA_UNAVAILABLE`
  - `DEVOLADA_PAYMENT_NOT_RESOLVABLE`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_PAYLOAD_INVALID`
- [ ] T006 Run `/speckit-constitution` to amend `.specify/memory/constitution.md` (MINOR, 1.0.0 → 1.1.0), as recorded in plan.md § Complexity Tracking:
  - add Devolada to Principle VIII's list of services we do not own: module `api-turistear/src/services/devolada.ts`; failure modes in `specs/001-devolada-transfer-verification/contracts/devolada-integration.md`;
  - add Devolada to the Integrations row of the Technology Stack table;
  - make the Runtime row's cron sentence name three sweeps: bookings expiry, departure reminders, Devolada recovery;
  - state that Principle IV's error codes are "declared in the spec" through the spec folder's `contracts/`;
  - rewrite the Sync Impact Report.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Tables, crypto, the single Devolada client, the test fake, and the per-payment verification core that every story uses.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T007 Write `api-turistear/migrations/0069_devolada_transfer_verification.sql`. Create `devolada_connections`, `devolada_links`, `devolada_payments` and `devolada_events` with exactly the columns, foreign keys and indexes of data-model.md, including:
  - `UNIQUE(organization_id)` on connections;
  - `UNIQUE(devolada_link_id)`;
  - the partial unique indexes on links: one open settlement link per sale, one open link per `folio_payment_id`;
  - `(state, expires_at)`;
  - every `(organization_id, …)` composite.

  The migration is additive only, with a prose header citing `devolada-transfer-verification D1-D9`, like the other migrations.
- [ ] T008 Mirror migration 0069 in `api-turistear/src/db/schema.ts`:
  - four `sqliteTable` definitions with their `$inferSelect`/`$inferInsert` types;
  - the TypeScript enums from data-model.md:
    - connection: status, mode;
    - link: kind, state, closed_reason;
    - payment: status, proof_door, match, awaiting, awaiting_reason, resolution;
    - event: outcome;
  - `'payment_not_received'` added to the `cancellationSource` enums of `folios` and `folio_lines` (D11).
- [ ] T009 Add `payment_link_issued`, `payment_link_closed`, `payment_verdict` and `transfer_not_received` to `FolioEventType` in `api-turistear/src/utils/folioEvents.ts` (lines 14-24) and to its Drizzle mirror in `api-turistear/src/db/schema.ts` (lines 1046-1059). Document each payload shape from data-model.md § Changes to existing types in a comment.
- [ ] T010 [P] Implement `api-turistear/src/utils/devoladaCredential.ts` (D1):
  - `encryptCredential(env, organizationId, plaintext): Promise<{ciphertext, iv}>`
  - `decryptCredential(env, organizationId, {ciphertext, iv}): Promise<string>`
  - `keyHint(apiKey): string`, returning the last four characters.

  Key handling:
  - derive the key as `HMAC-SHA256(base64-decoded DEVOLADA_CREDENTIAL_KEY, "guideme:devolada:v1:" + organizationId)` and import the 32 bytes as an `AES-GCM` key (same label pattern as `utils/qr.ts:84-107`);
  - use a fresh 12-byte IV per write, with `additionalData` = UTF-8 `organizationId`;
  - encode ciphertext and IV as base64url;
  - throw if the secret is missing.
- [ ] T011 [P] Implement `api-turistear/src/utils/devoladaSignature.ts` (D4):
  - a module-level `Map<kid, CryptoKey>` cache;
  - `verifyDevoladaSignature(env, {timestamp, keyId, signatureHeader, rawBody}): Promise<boolean>`:
    - require the `v1=` prefix;
    - base64url-decode without padding to the raw `r‖s` 64 bytes;
    - verify ECDSA P-256 / SHA-256 over `` `${timestamp}.${rawBody}` `` with the JWK whose `kid` equals `keyId`;
    - on an unknown `kid`, refetch `${DEVOLADA_API_BASE_URL}/.well-known/jwks.json` once (8 s timeout) and re-check;
    - return `false` on any malformed input;
  - throw `DevoladaUnavailableError` (exported) when the key set cannot be fetched.
- [ ] T012 [P] Implement `api-turistear/src/services/devolada.ts` (D5), the only code allowed to call Devolada. `devoladaClient(env, apiKey)` exposes:
  - `createPaymentLink(body, {idempotencyKey, fast})`
  - `closePaymentLink(id, {idempotencyKey})`
  - `getPayment(id)`
  - `listPaymentsByCustomer(customerRef)`
  - `getWebhook()`, `putWebhook(url)`
  - `listFailedDeliveries()`

  Every method:
  - sends `Authorization: Bearer <apiKey>`;
  - uses `AbortSignal.timeout(fast ? 3000 : 8000)`;
  - parses the `{success, data|error}` envelope;
  - converts instants at the boundary in both directions: callers pass and receive epoch seconds, Devolada sends and receives milliseconds, `expiresAt` included;
  - returns `{ok: true, data} | {ok: false, kind: 'refused' | 'retryable' | 'timeout', code, message, status, retryAfter?}` instead of throwing.

  Map errors per contracts/devolada-integration.md § Error mapping. Never log the API key.
- [ ] T013 Implement the stateful fake Devolada in `api-turistear/test/helpers/devolada.ts` (D18). `installFakeDevolada()` spies `globalThis.fetch` for `https://devolada.test` and passes every other URL through; call `vi.restoreAllMocks()` in `afterEach`. It emulates the v1 contract:
  - **businesses** keyed by API key: mode, channel `ok|clabe|bank`, suspended;
  - **one-time links**: `expiresAt` may be in the past; idempotent replay by key, refusals included; `PATCH close`;
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
- [ ] T014 [P] Write `api-turistear/test/devolada/credential-cipher.test.ts`, citing `devolada-transfer-verification US1`:
  - round trip;
  - two encryptions differ (fresh IV);
  - decrypting with another organization id fails (AAD binding);
  - a missing secret throws;
  - `keyHint` returns the last four characters.
- [ ] T015 [P] Write `api-turistear/test/devolada/signature.test.ts`, citing US1 and using the fake's key pair:
  - a valid signature verifies;
  - an altered body or timestamp fails;
  - an unknown `kid` fetches the key set once, then serves from cache;
  - a malformed header returns `false`;
  - an unreachable key set throws `DevoladaUnavailableError`.
- [ ] T016 Extract the verification cores into `api-turistear/src/routes/pos/verifyCore.ts` (D10), with `deps = {db, env, waitUntil}` (precedent: `queueCancellationEmail`, `routes/folios/handler.ts:822`):
  - `verifyFolioPayment(deps, {organizationId, folioId, paymentId: string | 'all', actorId: string | null, reference?: string, at, refuseCancelled?: boolean})`:
    - flip rows with a guarded `UPDATE folio_payments SET verification='verified', verified_at, verified_by … WHERE organization_id = ? AND folio_id = ? AND verification = 'pending' [AND id = ?] RETURNING id`;
    - roll `folios.payment_verification` up to `verified` (with `payment_verified_at` / `_by`) with a guarded `UPDATE folios … WHERE payment_verification = 'pending' AND NOT EXISTS (SELECT 1 FROM folio_payments WHERE folio_id = ? AND organization_id = ? AND verification = 'pending') RETURNING id`;
    - return `{flipped, rollupVerified}`: whether this call's row flip and its rollup update matched;
    - write the `payment_verified` event;
    - with `refuseCancelled`, do nothing for a cancelled sale.
  - `releaseClearedFolio(deps, {organizationId, folioId, at})`:
    - move the paid-path side effects that are inline in `verifyPayment` (`api-turistear/src/routes/pos/handler.ts:2965-3089`) into it;
    - sign live slot lines with `signLineTickets`;
    - issue the portal token (export `issuePortalLink` from `handler.ts:855`);
    - send the ticket email through `deps.waitUntil`;
    - emit `payment_verified` and `tickets_delivered`.
  - Make `verifyPayment` (`handler.ts:2882`) call both with `paymentId: 'all'` and the admin as actor — releasing only when `flipped && rollupVerified` — keeping its behaviour identical. Its missing cancelled check is defect 1, out of scope. `payment-verification.test.ts` must pass unedited.

**Checkpoint**: Foundation ready. The API suite and the scope-boundary suites pass, and the migration applies in tests.

---

## Phase 3: User Story 1 - A transfer sale clears itself when Banxico confirms the money (Priority: P1) 🎯 MVP

**Goal**: An admin connects Devolada. A full sale by transfer gets a payment link the seller sends by WhatsApp, and a *confirmed* verdict, by webhook or sweep, releases the tickets with «Sistema» as the actor. Unconnected organizations see no change.

**Independent Test**: Connect with test credentials, sell a full sale by Transferencia, then advance the test payment to *confirmed*. The sale is verified by «Sistema», with tickets released and no admin action (spec US1; quickstart §2 steps 1-4).

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T017 [P] [US1] Write `api-turistear/test/devolada/connection.test.ts` for `PUT/GET/DELETE /api/organizations/me/devolada` (contracts/turistear-api.md § Connection):
  - **Connect**: a valid test key returns 200 with `{connection: {status: 'connected', mode: 'test', key_hint}}`, creates a born-expired probe link (`customerRef` `turistear-conexion`), and registers `DEVOLADA_WEBHOOK_URL`.
  - **Refusals**:
    - bad format → 400;
    - rejected key → 422 `DEVOLADA_CREDENTIAL_REJECTED`;
    - real key in the test environment → 422 `DEVOLADA_MODE_NOT_ALLOWED`;
    - missing CLABE → 409 `DEVOLADA_CHANNEL_UNAVAILABLE` with message `clabe`;
    - suspended business → 409 `DEVOLADA_BUSINESS_SUSPENDED`;
    - Devolada down → 502 `DEVOLADA_UNAVAILABLE`.
  - **Address conflict**: a foreign address returns 409 `DEVOLADA_WEBHOOK_CONFLICT` (message = that URL); the same request with `replace_webhook: true` returns 200 and stores `replaced_webhook_url`.
  - **Health**: GET returns live webhook health, and `health_error` when Devolada is down.
  - **Disconnect**: DELETE sets `disconnected` and is idempotent.
  - **Secrecy**: no response ever contains the key or the ciphertext. `GET /api/organizations/me` returns only `devolada: {status, mode}`, for an admin and for an agent alike.
  - **Roles**: an agent gets 403 on all three routes.
  - **Isolation** (`seedTwoOrgs`): org B's admin sees `connection: null` and cannot change org A.
- [ ] T018 [P] [US1] Write `api-turistear/test/devolada/checkout-link.test.ts` for `POST /api/pos/folios`:
  - **Connected org, full sale by transfer, no `payment_reference`**:
    - 201 with the folio paid, `payment_verification: 'pending'`, no QR;
    - `payment_link` with `kind: 'sale'`, `amount` = total, `state: 'open'`, a `url`, and `expires_at` ≤ min(now + 24 h, first service start);
    - one `payment_link_issued` event;
    - the fake received `customerRef` = folio id, `askCents` = total, `Idempotency-Key` = link id.
  - A `payment_reference` that is sent is not stored.
  - **Create times out**: `payment_link: null`, `payment_link_error: 'DEVOLADA_UNAVAILABLE'`, link `abandoned`, sale pending on the manual path.
  - **Business suspended**: link `failed`, matching error code, connection `broken`.
  - **Cash sale for a connected org**: no link.
  - **Unconnected org**: the response has no `payment_link` keys and the reference rule is unchanged (US1 scenario 5).
  - **Idempotent replay**: returns `payment_links`.
- [ ] T019 [P] [US1] Write `api-turistear/test/devolada/webhook.test.ts` for `POST /api/webhooks/devolada` (research D4):
  - **Rejected deliveries**, none of which changes anything:
    - bad signature → 401;
    - malformed JSON → 400;
    - more than 64 KiB → 400;
    - unknown `paymentLinkId` → 200, no rows written;
    - `isTest` mismatching the connection → 200, event outcome `mode_mismatch`.
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
  - **Waiting statuses**:
    - *validating* → label `validating`;
    - `queued_for_credit` → the connection's `credit_paused_since` is set;
    - `awaiting` → label `needs_tracking_key`.
- [ ] T020 [P] [US1] Write `api-turistear/test/devolada/isolation.test.ts` with `seedTwoOrgs`, each organization connected to its own fake business:
  - a verdict for org A's link changes only org A;
  - org B's GET of org A's sale returns 404;
  - counts are computed per organization;
  - an event naming org A's link but signed by an unknown key returns 401.
- [ ] T021 [P] [US1] Write the recovery cases of `api-turistear/test/devolada/sweep.test.ts`. Call `sweepDevoladaPayments(env, now)` directly, because dates are frozen in tests (`test/helpers/apply-migrations.ts:28-34`):
  - a link whose notification never arrived is applied by the sweep;
  - a never-checked link is re-read on the first run;
  - a link checked under 10 minutes ago is skipped; one checked over 10 minutes ago is re-read;
  - each organization gets at most 50 Devolada calls per run;
  - `RATE_LIMITED` stops only that organization;
  - one organization failing does not stop another (fail-soft);
  - a disconnected organization's open link is still followed;
  - a disconnected organization with no unresolved link has its credential erased.
- [ ] T022 [P] [US1] Write `api-turistear/test/devolada/link-view.test.ts`:
  - `deriveLinkLabel` follows the precedence table in contracts/turistear-api.md § Labels, one case per row;
  - `loadPaymentLinkViews` picks the latest non-superseded payment and orders links newest first.

### Implementation for User Story 1

- [ ] T023 [US1] Implement `api-turistear/src/utils/devoladaLinkView.ts` (D14):
  - `deriveLinkLabel(link, currentPayment, saleCancelled): PaymentLinkLabel`, following the § Labels precedence;
  - `loadPaymentLinkViews(db, organizationId, folioIds): Promise<Map<folioId, PaymentLinkView[]>>`:
    - one query for links and one for payments, filtered by organization and `folio_id IN (…)` and backed by the `(organization_id, folio_id)` indexes;
    - current payment = latest non-`superseded` by `devolada_created_at`;
    - instants in epoch seconds;
    - the exact `PaymentLinkView` shape of the contract.
- [ ] T024 [US1] Implement `api-turistear/src/routes/devolada/connection.ts` (D1-D3), with `deps = {db, env}`:
  - `connectDevolada(deps, {organizationId, adminId, apiKey, replaceWebhook})`:
    1. check the format;
    2. probe with `createPaymentLink({customerRef: 'turistear-conexion', askCents: 100, mode: 'one_time', expiresAt: now - 60s, label: 'Prueba de conexión — Turistear Ya!'})` and a fresh UUID `Idempotency-Key`, mapping refusals to the contract's `ApiError`s;
    3. compare `isTest` with `env.DEVOLADA_KEY_MODE`;
    4. if `env.DEVOLADA_WEBHOOK_URL` is not empty: `getWebhook` → 404 means `putWebhook`; the same URL is kept; a different URL is refused with `DEVOLADA_WEBHOOK_CONFLICT` unless `replaceWebhook`, which then `putWebhook`s;
    5. encrypt the key;
    6. upsert `devolada_connections` (status `connected`, `broken_reason` NULL).
  - `disconnectDevolada(deps, {organizationId, adminId})`: idempotent; keeps the credential (FR-004).
  - `readConnectionView(deps, organizationId)`: live `getWebhook` + `listFailedDeliveries`, fail-soft to `health_error: 'DEVOLADA_UNAVAILABLE'`.
  - `loadActiveCredential(deps, organizationId)`: returns `{connection, apiKey} | null`.
  - `markConnectionBroken(db, organizationId, reason)` and `setCreditPaused(db, organizationId, paused)`.
- [ ] T025 [US1] Add the admin-only routes `GET /me/devolada`, `PUT /me/devolada` and `DELETE /me/devolada` to `api-turistear/src/routes/organizations/index.ts`, with handlers in `handler.ts` and the PUT schema `{api_key: z.string(), replace_webhook: z.boolean().optional()}` in `schema.ts`:
  - each route: `requireRole('admin')` and a `zValidator` hook like `pos/index.ts:33-37`;
  - each answers `{connection}` per the contract;
  - add `devolada: {status, mode}` to `getMyOrganization` / `serializeOrg` (`handler.ts:40-111`), with `not_connected` / `null` when no row exists. Read it with a separate query and never add a credential column to `orgColumns`.
- [ ] T026 [US1] Implement `api-turistear/src/routes/devolada/links.ts` (D6, D7):
  - `computeLinkExpiry({issuedAt, liveLines, timezone, kind})`:
    - the earliest of: issued + 24 h; the first live service start (slot `slot_date` + `slot_start_time` in the org time zone; a stay = the end of its check-in day);
    - for `deposit` and `settlement`, also the earliest live `booking_expires_at`.
  - `issuePaymentLink(deps, {organizationId, folioId, folioPaymentId, folioLineId, kind, amount, requestedBy, operatorId, customerName, concept})`:
    1. insert the link row in state `creating`;
    2. call `createPaymentLink(…, {idempotencyKey: id + (attempt > 1 ? '#' + attempt : ''), fast: true})` with `mode: 'one_time'` and `customerRef` = folio id;
    3. success → `open`, storing `devolada_link_id` and `url`;
    4. refused → `failed`, and `markConnectionBroken` for `AUTHENTICATION_ERROR`, `BUSINESS_SUSPENDED` or `CHANNEL_UNAVAILABLE`;
    5. timeout or network error → `abandoned`.

    On `open` it writes a `payment_link_issued` event with the seller as actor. It returns `{link: PaymentLinkView} | {error: code}`.
- [ ] T027 [US1] Change `confirmSale` in `api-turistear/src/routes/pos/handler.ts` (957-2121), citing D6:
  1. Load the organization's active Devolada connection next to the org row (1047-1063).
  2. When connected and the method is `transfer` **for a full sale**, skip the reference requirement (1496-1506) and store `payment_reference` NULL. A transfer deposit keeps today's manual path, reference rule included, until T058 gives deposits their link.
  3. For a full sale, after the batch and the post-commit block (2008-2058), call `issuePaymentLink` with `kind: 'sale'`, `folioPaymentId` = the inserted payment row id and `amount` = total. Deposits get their link in T058.
  4. Add `payment_link` (and `payment_link_error`) to the 201 body (2059-2120) only for connected organizations.

  Unconnected organizations must keep byte-identical behaviour.
- [ ] T028 [US1] Implement `api-turistear/src/routes/devolada/apply.ts` (D9, the Story 1 subset). `applyDevoladaPayment(deps, {link, payment})`:
  - Upsert `devolada_payments` by `devolada_payment_id`; never overwrite a final status with a non-final one. Return early when `applied_status === status` — an optimization only: the guarantee against applying twice is each branch's guarded write (D9).
  - *validating*, `queued_for_credit`, or `awaiting`: snapshot only. `setCreditPaused(true)` on `queued_for_credit`, `false` on a later *validating*.
  - *confirmed* on a `sale` link with the sale not cancelled:
    1. `verifyFolioPayment({paymentId: link.folio_payment_id, actorId: null, reference: receipt_number, refuseCancelled: true})`;
    2. `releaseClearedFolio` only when step 1 returned `flipped && rollupVerified` and the sale is paid (D10);
    3. set `folios.payment_reference` = receipt number;
    4. link → `paid`;
    5. update the connection's `last_verdict_at`.
  - Every other status: snapshot only. Stories 2 and 3 complete them.
  - Always set `applied_status`, `applied_at` and `link.last_checked_at`.
- [ ] T029 [US1] Implement the public webhook as its own resource `api-turistear/src/routes/webhooks/` (D4, constitution IV) and mount it with `app.route('/api/webhooks', webhooks)` in `api-turistear/src/index.tsx` (43-56):
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
    - `loadActiveCredential`, then `getPayment` (8 s) → `applyDevoladaPayment`;
    - `DevoladaUnavailableError` or an unreachable re-read → 503 `DEVOLADA_UNAVAILABLE`, outcome `failed`;
    - an `AUTHENTICATION_ERROR` or `BUSINESS_SUSPENDED` re-read → `markConnectionBroken`, outcome `failed`, 503 (Devolada retries; the sweep catches up once the admin fixes the key).
  - **Answer** 200 `{received: true}`.
- [ ] T030 [US1] Add the read model in `api-turistear/src/utils/folioDetail.ts` and `api-turistear/src/utils/folioListRows.ts`:
  - `payment_links: PaymentLinkView[]` in `readFolioDetail` (`api-turistear/src/utils/folioDetail.ts`);
  - `payment_link` (latest unresolved, else latest, else null) on list rows in `api-turistear/src/utils/folioListRows.ts`.

  Both use `loadPaymentLinkViews` with one batched call per response and no per-row correlated subquery.
- [ ] T031 [US1] Add `verification_auto` to `GET /api/folios/counts` in `api-turistear/src/routes/folios/handler.ts` (289-320). It counts pending, not-cancelled sales whose open link has no payment, or a current payment that is *validating* without `awaiting` or is `queued_for_credit` (D14). Back it with the `(organization_id, folio_id)` indexes.
- [ ] T032 [US1] Implement `sweepDevoladaPayments(env, now)` in `api-turistear/src/routes/devolada/sweep.ts` (D12, recovery):
  - **Selection**: links `open` with `last_checked_at` NULL or older than now − 10 min, grouped by organization, then by folio.
  - **Per organization** (connected, broken, or disconnected with unresolved links):
    - load the credential;
    - for each folio, `listPaymentsByCustomer(folioId)` → `applyDevoladaPayment` for every payment whose `paymentLinkId` is one of our links;
    - update `last_checked_at`;
    - stop after 50 calls, or on `RATE_LIMITED`;
    - on `AUTHENTICATION_ERROR` or `BUSINESS_SUSPENDED`, call `markConnectionBroken` and stop that organization for this run.
  - **Fail-soft**: try/catch per folio, counting `failed`.
  - **Cleanup**: erase the `credential_ciphertext` and `credential_iv` of disconnected organizations with no unresolved link.
  - **Returns** `{checked, applied, failed}`.
  - **Wiring**: a third independent `ctx.waitUntil` in `scheduled()` in `api-turistear/src/index.tsx` (83-116), with `now = new Date(controller.scheduledTime)`, logging `[devolada] …`.
- [ ] T033 [P] [US1] Mirror the contract types in the app, starting with the new `app-turistear/src/features/devolada/types.ts`:
  - `PaymentLinkView`, `PaymentLinkLabel`, `DevoladaConnectionView` and `OrganizationDevoladaSummary` in `app-turistear/src/features/devolada/types.ts`;
  - `payment_links` on `FolioDetail` (`app-turistear/src/features/folios/types.ts:129-187`);
  - `payment_link` on `FolioListItem` (`folios/types.ts:29-73`) and on `FolioHistoryItem` (`app-turistear/src/features/pos/types.ts:248-281`);
  - `devolada` on `MyOrganization` (`app-turistear/src/services/organizationsService.ts:6-48`);
  - `verification_auto` on `FolioCounts` (`app-turistear/src/services/foliosService.ts:61-70`);
  - the confirm response `{folio, payment_link?, payment_link_error?}` (`app-turistear/src/services/posService.ts:134-140`).
- [ ] T034 [P] [US1] Implement `app-turistear/src/services/devoladaService.ts` (`getDevoladaConnection`, `connectDevolada`, `disconnectDevolada`, using the shared `request`) and the hooks `useDevoladaConnection`, `useConnectDevolada` and `useDisconnectDevolada` in `app-turistear/src/features/devolada/hooks/`. Mutations invalidate `['organization','me']` and the connection key.
- [ ] T035 [P] [US1] Add MSW handlers and fixtures to `app-turistear/src/test/handlers/devolada.ts`:
  - handlers for `GET/PUT/DELETE /api/organizations/me/devolada`;
  - fixtures `aConnection()` and `aPaymentLink(overrides)`, copying shapes asserted by T017-T019 (constitution IV);
  - register them in `app-turistear/src/test/server.ts`.
- [ ] T036 [US1] Build the Ajustes surface in `app-turistear/src/features/devolada/components/`:
  - **`DevoladaConnectionCard`**: `SectionCard` with a `StatusChip` + text for the status, the mode («Real» / «Prueba»), «Llave …abcd», health («Avisos funcionando» / «Avisos con fallas» / «Verificación en pausa»), and «Último veredicto: …» from `last_verdict_at` (FR-005).
  - **`ConnectDevoladaSheet`**: `FormSheet` with a «Llave de API» field and the submit «Conectar».
    - `DEVOLADA_WEBHOOK_CONFLICT` opens a `ConfirmSheet` «¿Reemplazar la dirección de avisos?» showing the current URL, then resends with `replace_webhook: true`.
    - Every error code maps to es-MX copy.
  - **Disconnect**: a `ConfirmSheet`.

  Mount the card in `app-turistear/src/pages/SettingsPage.tsx` right after «Punto de venta» (after line 728). While connected, the «Referencia obligatoria en transferencias» switch (700-726) gets the helper «Con Devolada conectado, las transferencias se cobran con liga de pago».
- [ ] T037 [US1] Extract `app-turistear/src/features/pos/components/TransferPaymentFields.tsx` from `app-turistear/src/pages/PosCheckoutPage.tsx` (the reference field 400-419 and the consequence line 421-440):
  - **Connected** (`org.devolada.status === 'connected'`) **on a full sale**: no reference field, and the line «Se generará una liga de pago para cobrar por WhatsApp». An apartado deposit keeps today's field until T058.
  - **Otherwise**: today's field and US-A88 rules, unchanged.

  `PosCheckoutPage` renders the component and omits `payment_reference` for a connected full sale.
- [ ] T038 [US1] Add `paymentLinkWhatsAppUrl(link, folio, org)` and `DEFAULT_PAYMENT_LINK_TEMPLATE` to `app-turistear/src/features/pos/delivery.ts`. The text comes from contracts/turistear-api.md § WhatsApp message; reuse `normalizePhone` and `fillTemplate` (101-121), and format the amount with `app-turistear/src/components/money.ts`.
- [ ] T039 [US1] Build `PaymentLinkStatusChip` and `PaymentLinkCard` in `app-turistear/src/features/devolada/components/` and export them from `app-turistear/src/features/devolada/index.ts`:
  - **`PaymentLinkStatusChip`**: one chip per label code, each with icon + text per § Labels.
  - **`PaymentLinkCard`**:
    - `MoneyText` amount and «Vence a las HH:MM» in the organization's time zone;
    - the chip, and a primary «Cobrar por WhatsApp» that opens `paymentLinkWhatsAppUrl` (the canonical verb, constitution VII);
    - for `link_failed`, an `AlertCard` «No se pudo crear la liga de pago; un administrador verificará la transferencia».
- [ ] T040 [US1] Update `app-turistear/src/pages/FolioReceiptPage.tsx`:
  - render `PaymentLinkCard` for the sale's latest link (or the `payment_link_error` alert);
  - give `useFolio` (`app-turistear/src/features/pos/hooks/useFolio.ts`) `refetchInterval: 15000` while the label is `awaiting_payment`, `validating`, `needs_tracking_key` or `credit_paused`;
  - while `payment_verification` is `pending`, show «Pago en verificación» instead of «Venta confirmada» (74-82) and the «Pagado» chip (143-148);
  - drop «Folio {id}» (85) (constitution VII).
- [ ] T041 [US1] Show the link status and fix the badge in `app-turistear/src/features/folios/components/FolioCard.tsx`, `FolioDetailScreen.tsx` and `app-turistear/src/layout/AppLayout.tsx`:
  - `PaymentLinkStatusChip` on sale rows in `app-turistear/src/features/folios/components/FolioCard.tsx`;
  - the same chip in the header chips (342-363) of `FolioDetailScreen.tsx`;
  - the admin badge in `app-turistear/src/layout/AppLayout.tsx` (90-124) becomes `folio_requests + verification − verification_auto`.
- [ ] T042 [US1] Add the four new event types and the automatic `payment_verified` to `app-turistear/src/features/folios/components/FolioTimeline.tsx`, in `eventPrimary` (72-156), `EVENT_TONE` (28-39) and `EVENT_ICON` (41-52). Add them to the event union (`app-turistear/src/features/folios/types.ts:211-221`).

  | Event | Copy |
  |---|---|
  | `payment_link_issued` | «Liga de pago creada» |
  | `payment_link_closed` | «Liga de pago cerrada» |
  | `payment_verdict` | per status, from § Labels |
  | `transfer_not_received` | «No se recibió la transferencia — venta cancelada» |
  | `payment_verified` with `payload.source === 'devolada'` | «Transferencia verificada por Devolada · Comprobante {receipt_number}» |
- [ ] T043 [P] [US1] Write the app tests under `app-turistear/src/features/devolada/components/` and `app-turistear/src/features/pos/components/`, each citing `devolada-transfer-verification US1` and running `expectNoA11yViolations`:
  - `app-turistear/src/features/devolada/components/DevoladaConnectionCard.test.tsx`: connect; conflict → replace confirm; disconnect; error copy.
  - `app-turistear/src/features/devolada/components/PaymentLinkCard.test.tsx`: every label renders copy + icon; the WhatsApp URL contains the link and the formatted amount; the failed alert.
  - `app-turistear/src/features/pos/components/TransferPaymentFields.test.tsx`: connected hides the reference; unconnected keeps the US-A88 rules.
  - Extend `FolioTimeline.test.tsx` with the new event copy.

**Checkpoint**: Story 1 works end to end (quickstart §1 for US1, §2 steps 1-4, 12, 13). This is PR 1 (D19). Exceptions still wait in Por verificar for the admin, exactly as today, and transfer deposits and settlements keep today's manual path, reference included, until PR 2.

---

## Phase 4: User Story 2 - Anything short of a clean confirmation reaches the right person, with the reason (Priority: P2)

**Goal**:
- *partial* and *invalid* are labelled in Por verificar, with the admin's Verificar and Rechazar unchanged.
- Money that never arrived cancels the sale automatically, through a guarded system cancellation.
- *unapplied* money is flagged until the admin marks it returned.
- Tracking-key waits and paused credit are visible.

**Independent Test**: With test credentials, move payments to *partial*, *invalid* and *unapplied*: each shows in Por verificar with its label and amounts. Then let a full sale's link expire unpaid: «Sistema» cancels it and its seats return (spec US2; quickstart §2 steps 5-7, 11).

### Tests for User Story 2 ⚠️

- [ ] T044 [P] [US2] Write `api-turistear/test/devolada/verdicts.test.ts`:
  - **partial**: the sale stays pending; its row's `payment_link.label` is `partial`, with asked and received amounts; the existing admin `POST /api/pos/folios/:id/verify` still verifies with the admin as actor, and `/reject` still cancels (FR-018).
  - **invalid**: label `invalid`.
  - **expired** on a full sale:
    - the folio and its live lines are cancelled with `cancellation_source: 'payment_not_received'` and reason «No se recibió la transferencia»;
    - seats and reservations are released exactly once;
    - `refund` and `commission_reversal` rows are written;
    - a `transfer_not_received` event with a NULL actor;
    - a `payment_rejected` notification;
    - the link becomes `expired`.
  - **expired** when the sale holds other positive money: no cancellation, and an attention item.
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
  - **counts**: `devolada_attention` counts unapplied items and tracking-key waits; `verification_auto` excludes partial and invalid sales.
- [ ] T045 [P] [US2] Extend `api-turistear/test/devolada/sweep.test.ts` with expiry, passing a `now` past `expires_at`:
  - an unpaid link is cancelled through D11 only after a successful `listPaymentsByCustomer` re-read;
  - a failing re-read cancels nothing;
  - a payment *validating* at the expiry prevents cancellation;
  - the seats are back on sale after one run (SC-009).

### Implementation for User Story 2

- [ ] T046 [US2] Extract the seat and reservation release statements of `rejectPayment` (`api-turistear/src/routes/pos/handler.ts:3118-3192`) into `buildInventoryReleaseStatements(db, organizationId, lines)`, exported from the new `api-turistear/src/routes/pos/unreceivedTransfer.ts`. `rejectPayment` keeps passing all its lines, so its behaviour is unchanged (`payment-verification.test.ts` unedited).
- [ ] T047 [US2] Implement `cancelForUnreceivedTransfer(deps, {organizationId, folioId, linkId, at})` in `api-turistear/src/routes/pos/unreceivedTransfer.ts` (D11):
  1. **Claim the link**: `UPDATE devolada_links SET state='expired' … WHERE id = ? AND organization_id = ? AND state = 'open' RETURNING id`; nothing returned → `'noop'`.
  2. **Check the sale**: if it is cancelled, or holds any positive payment row besides `link.folio_payment_id`, return `'attention'`.
  3. **One `db.batch`, every statement gated on its own transition** (constitution V — the read in step 2 is never the only guard):
     - first, the folio cancelled `WHERE cancelled_at IS NULL`, stamping `cancelled_at = :at`, `cancellation_source 'payment_not_received'` and reason «No se recibió la transferencia»;
     - every later statement carries `WHERE EXISTS (SELECT 1 FROM folios WHERE id = ? AND organization_id = ? AND cancelled_at = :at AND cancellation_source = 'payment_not_received')`, inserts written as `INSERT … SELECT … WHERE EXISTS`:
       - its live lines cancelled `WHERE cancelled_at IS NULL`;
       - the `buildCancellationReversal({clawback: true})` rows (`api-turistear/src/utils/folioPayments.ts:217`);
       - `buildInventoryReleaseStatements` for live lines only;
       - a `transfer_not_received` event with a NULL actor.

     Test it: when the sale is cancelled between step 2 and the batch, the batch writes nothing.
  4. **After the batch**: `emitNotification(…, 'payment_rejected')`, then the new helper `closePaymentLinkRemote(deps, link)` in `api-turistear/src/routes/devolada/links.ts`. The helper is fail-soft, sends `PATCH close` with `Idempotency-Key 'close:' + id`, and treats `LINK_CLOSED` as closed.
- [ ] T048 [US2] Complete `applyDevoladaPayment` in `api-turistear/src/routes/devolada/apply.ts` (D9 table, sale and deposit columns):
  - *partial* / *invalid*: snapshot plus a `payment_verdict` event (NULL actor).
  - *expired*: `cancelForUnreceivedTransfer`; an `'attention'` result keeps the snapshot.
  - *unapplied*, or *confirmed* on a cancelled sale: snapshot plus a `payment_verdict` event.
  - *superseded*: snapshot only.
  - Set the connection's `last_verdict_at` on every final status.
- [ ] T049 [US2] Add the unpaid-expiry branch to `api-turistear/src/routes/devolada/sweep.ts` (D12 step 2). Select `open` links past `expires_at` through the `(state, expires_at)` index. Only when the `listPaymentsByCustomer` re-read succeeds and the link has no payment *validating*, `queued_for_credit`, awaiting, *confirmed*, *partial* or *unapplied*, run `cancelForUnreceivedTransfer` for `sale` and `deposit` links. Settlement links come in T060.
- [ ] T050 [US2] Add Devolada attention to the pending work and the counts in `api-turistear/src/utils/folioPendingWork.ts` and `api-turistear/src/routes/folios/handler.ts`:
  - add `devoladaAttentionFilter` (derived per data-model.md § Attention) to `api-turistear/src/utils/folioPendingWork.ts`;
  - include it in the pending-work set (103-110), so `GET /api/folios` lists attention sales whatever their age, cancelled ones with unapplied money included;
  - add `devolada_attention` to `GET /api/folios/counts` (`api-turistear/src/routes/folios/handler.ts:289-320`).
- [ ] T051 [US2] Create the admin router `api-turistear/src/routes/devolada/index.ts`, with `handler.ts` and `schema.ts`:
  - **Route**: `POST /payments/:id/resolve` behind `authMiddleware` and `requireRole('admin')`, validated with `zValidator`: `{action: 'accept' | 'dismiss' | 'returned', note?: string ≤ 500}`.
  - **Mount**: `app.route('/api/devolada', devolada)` in `api-turistear/src/index.tsx`.
  - **`returned`**: for an unresolved *unapplied* payment, or a *confirmed* one on a cancelled sale; sets `resolution`, `resolved_by` and `resolved_at` with `… WHERE id = ? AND organization_id = ? AND resolution IS NULL RETURNING` — no row returned (a double tap) → 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE` (D15).
  - **Errors**: 404 for another organization's payment; 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE` for a wrong status or kind, or one already resolved.
  - **`accept` / `dismiss`**: answer 409 until T062.
  - **Response**: `{folio}`, the `readFolioDetail` shape.
- [ ] T052 [P] [US2] Mirror the Story 2 additions in the app (`app-turistear/src/features/folios/types.ts`, `app-turistear/src/services/devoladaService.ts`):
  - `payment_not_received` in the cancellation-source unions (`app-turistear/src/features/folios/types.ts`);
  - `devolada_attention` on `FolioCounts` (`app-turistear/src/services/foliosService.ts`);
  - `resolveDevoladaPayment` in `app-turistear/src/services/devoladaService.ts`, plus `useResolveDevoladaPayment` in `app-turistear/src/features/devolada/hooks/`, invalidating `['folios']` and `['pos']`;
  - an MSW handler for resolve in `app-turistear/src/test/handlers/devolada.ts`.
- [ ] T053 [US2] Bring Devolada attention into Por verificar (`app-turistear/src/features/folios/`):
  - **Facet**: include attention items, cancelled sales with unapplied money among them, in the `por_verificar` facet (`app-turistear/src/features/folios/folioFacets.ts:69-76`) and in `folioAction` / `folioAttention` (`app-turistear/src/features/folios/folioCardState.ts:166-229`).
  - **`FolioCard.tsx`**: shows the label and the asked, claimed and received amounts with `MoneyText` (FR-015).
  - **`FolioWorkActions.tsx`**: adds a Devolada rung with the label, «Comprobante Devolada {receipt}» and the amounts, plus «Ya lo devolví» (resolve `returned`) for unapplied money.
  - **Badge**: `app-turistear/src/layout/AppLayout.tsx` adds `devolada_attention`.
- [ ] T054 [US2] Label money that never arrived in `app-turistear/src/features/pos/components/PaymentBreakdown.tsx`:
  - `app-turistear/src/features/pos/components/PaymentBreakdown.tsx` (63-65) shows «No recibido» instead of «Por verificar» for a pending row of a sale cancelled with `cancellation_source: 'payment_not_received'`;
  - wherever cancellation sources are labelled, `payment_not_received` reads «No se recibió la transferencia».
- [ ] T055 [P] [US2] Extend the app tests in `app-turistear/src/features/folios/components/`, each citing US2 and running axe:
  - `app-turistear/src/features/folios/components/FolioCard.test.tsx`: the `partial`, `invalid`, `unapplied`, `needs_tracking_key` and `not_received` labels;
  - `FolioWorkActions.test.tsx`: «Ya lo devolví» calls resolve `returned`.

**Checkpoint**: Stories 1 and 2 both work independently (quickstart §2 steps 5-7, 11).

---

## Phase 5: User Story 3 - Apartados: the deposit and the settlement each get their own link (Priority: P2)

**Goal**: A transfer deposit gets its own link and verifies only its own row. A settlement by transfer is a link request that is recorded only when *confirmed* (D8). An unpaid settlement leaves the apartado intact.

**Independent Test**: Create an apartado with a transfer deposit and confirm it: no tickets. Settle by transfer: a link appears and the sale is still an apartado. Confirm it: tickets (spec US3; quickstart §2 steps 8-9).

### Tests for User Story 3 ⚠️

- [ ] T056 [P] [US3] Write `api-turistear/test/devolada/apartados.test.ts`:
  - **Deposit link at confirm**: `kind: 'deposit'`, `amount` = `down_payment`, `expires_at` ≤ the earliest live line clock.
  - **Deposit confirmed**: only the deposit row is verified; the sale is still a booking, with no QR.
  - **Settle by transfer** (`POST /api/pos/folios/:id/settle`, connected org):
    - 200 with the folio still a booking and `payment_link {kind: 'settlement', amount: balance}`;
    - no new `folio_payments`, allocation or commission rows;
    - a repeated settle returns the same link.
  - **Settlement confirmed**:
    - a payment row with `method 'transfer'`, `verified`, `verified_by` NULL, `collected_by = link.requested_by`, `operator_id` from the link, and `created_at` = the verdict;
    - allocations and the commission top-up;
    - `settled_at` / `settled_by`;
    - tickets signed.
  - **Deposit still pending when the settlement is confirmed**: no tickets until the deposit's link is confirmed (US3 scenario 4).
  - **Per-line settlement** (`/lines/:lineId/settle`): the link carries `folio_line_id`, and confirmation settles that line.
  - **Settlement link expires unpaid** (sweep): link `expired`, the apartado unchanged.
  - **Settlement exceptions**: *partial* or *invalid* → link closed plus an attention item.
    - resolve `accept` records the settlement with `verified_by` = the admin;
    - resolve `dismiss` keeps the apartado.
  - **Apartado sweep guard**: `sweepExpiredBookings` skips an apartado whose clock passed while it has an open link or a *validating* payment. A settlement confirmed after the clock, but submitted in time, is still recorded.
  - **Link creation fails at settle**: today's manual settlement is recorded, together with `payment_link_error`.
  - **Isolation**: `seedTwoOrgs`.

### Implementation for User Story 3

- [ ] T057 [US3] Extract `applySettlement(deps, {organizationId, folioId, folioLineId, method, reference, verification, verifiedBy, verifiedAt, collectedBy, operatorId, settledBy, at, bypassExpiry?})` into `api-turistear/src/routes/pos/settleCore.ts`, from `settleBooking` (`api-turistear/src/routes/pos/handler.ts:2220-2569`) and `settleFolioLine` (2577-2800). It covers:
  - balance computation;
  - the payment row and allocations;
  - the commission top-up;
  - `settled_at` / `settled_by`;
  - the `payment` event (kind `settlement`);
  - the cleared branch through `releaseClearedFolio`.

  It takes an optional `claim` for Devolada callers (D8): a fresh payment-row id plus the settlement link to claim. The batch then opens with `UPDATE devolada_links SET folio_payment_id = :newId[, state = 'paid'] WHERE id = ? AND organization_id = ? AND kind = 'settlement' AND folio_payment_id IS NULL`, every later statement carries `WHERE EXISTS (SELECT 1 FROM devolada_links WHERE id = ? AND folio_payment_id = :newId)`, and it returns whether the claim matched. Release runs only if it did.

  Both handlers then call it without a claim, with behaviour unchanged: `settle-method.test.ts` and `payment-verification.test.ts` pass unedited.
- [ ] T058 [US3] Issue deposit links at checkout in `api-turistear/src/routes/pos/handler.ts` and `api-turistear/src/routes/devolada/links.ts`:
  - in `confirmSale` (`api-turistear/src/routes/pos/handler.ts`), call `issuePaymentLink` with `kind: 'deposit'`, `folioPaymentId` = the deposit row and `amount` = `down_payment` when the organization is connected and the deposit is a transfer;
  - extend T027's skip of the reference requirement to transfer deposits, and T037's `TransferPaymentFields` to hide the field for an apartado deposit when connected;
  - make sure `computeLinkExpiry` in `api-turistear/src/routes/devolada/links.ts` caps `deposit` and `settlement` links at the earliest live `booking_expires_at`.
- [ ] T059 [US3] Settle by link in `settleBooking` and `settleFolioLine` (`api-turistear/src/routes/pos/handler.ts`), citing D8, when the organization is connected and the method is `transfer`:
  1. run today's guards;
  2. compute the balance (or the line balance);
  3. if a settlement link is already open, return it; otherwise `issuePaymentLink` with `kind: 'settlement'`, `folioLineId`, `amount` = balance, `requestedBy` = the user and `operatorId` = the operator;
  4. answer `{folio: readFolioDetail, payment_link}` without recording any settlement;
  5. if the link fails, fall back to today's manual transfer settlement, with no reference required, and add `payment_link_error`.
- [ ] T060 [US3] Add the settlement branches to `api-turistear/src/routes/devolada/apply.ts` and `sweep.ts` (D8, D9):
  - ***confirmed* on a `settlement` link**:
    1. `applySettlement` with the link `claim` (state → `paid`), method `transfer`, reference = receipt number, `verification 'verified'`, `verifiedBy` null, `collectedBy` and `settledBy` = `link.requested_by`, `operatorId` = `link.operator_id`, and `bypassExpiry` when the payment's `devolada_created_at` < `link.expires_at`;
    2. the claim itself records the new row id in `link.folio_payment_id` and moves the link to `paid`; a claim that does not match means another processor already recorded it — do nothing more.
  - ***partial* / *invalid***: `closePaymentLinkRemote`, link `closing` → `closed`, plus a `payment_verdict` event. This makes an attention item.
  - ***expired*, or an unpaid expiry in the sweep**: link `expired`, nothing else.
- [ ] T061 [US3] Guard the apartado expiry sweep in `api-turistear/src/routes/pos/sweep.ts`. In the due-folio query (49-67), skip folios that have a `devolada_links` row in `creating` or `open`, or a `devolada_payments` row that is *validating* (awaiting included) or `queued_for_credit`. Cite D8. `test/pos/pos-bookings-sweep.test.ts` must still pass.
- [ ] T062 [US3] Implement resolve `accept` and `dismiss` in `api-turistear/src/routes/devolada/handler.ts`:
  - **`accept`**: allowed for a `settlement` link whose payment is *partial* or *invalid* and unresolved. On a sale that is not cancelled, call `applySettlement` with the link `claim`, `verifiedBy` = the admin and `collectedBy` = `link.requested_by`; the same claimed batch sets the payment's `resolution 'accepted'`. A claim that does not match (a double tap) → 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE`. On a cancelled sale → 409 `FOLIO_CANCELLED`.
  - **`dismiss`**: set `resolution 'dismissed'` with `… WHERE resolution IS NULL RETURNING` (no row → 409), then `closePaymentLinkRemote` (fail-soft).
  - **Both**: set `resolved_by` / `resolved_at` and answer `{folio}`.
- [ ] T063 [US3] Settle by link in the app (`app-turistear/src/features/bookings/components/SettleSheet.tsx`):
  - `app-turistear/src/features/bookings/components/SettleSheet.tsx` renders `TransferPaymentFields`;
  - for a connected transfer, submitting shows the returned `PaymentLinkCard`, or the alert on `payment_link_error`, instead of closing as settled;
  - type the settle responses `{folio, payment_link?, payment_link_error?}` in `app-turistear/src/services/bookingsService.ts:24-44`.
- [ ] T064 [US3] Show the settlement link and its exceptions (`app-turistear/src/features/bookings/components/BookingActions.tsx`, `app-turistear/src/features/folios/components/FolioWorkActions.tsx`):
  - **`BookingActions.tsx`**: while a settlement link is open, show its `PaymentLinkCard` and replace «Liquidar» with the chip «Liquidación en validación».
  - **`FolioWorkActions.tsx`**: settlement exceptions get «Aceptar pago» and «Descartar» `ConfirmSheet`s, using `useResolveDevoladaPayment`.
- [ ] T065 [P] [US3] Extend the app tests in `app-turistear/src/features/bookings/components/SettleSheet.test.tsx` and `FolioWorkActions.test.tsx`, citing US3 and running axe:
  - `app-turistear/src/features/bookings/components/SettleSheet.test.tsx`, connected mode: no reference field; the link card after submit; the fallback alert.
  - `FolioWorkActions.test.tsx`: accept and dismiss.

**Checkpoint**: Stories 1, 2 and 3 work (quickstart §2 steps 8-9). This is PR 2 together with Story 2 (D19).

---

## Phase 6: User Story 4 - A sale that stops taking money closes its link (Priority: P3)

**Goal**: Every write that stops a sale taking a payment closes its open links: inside the batch locally, then at Devolada. A line cancellation that changes an apartado's balance replaces its settlement link.

**Independent Test**: Cancel a sale with an open link and see the link closed. Advance a late payment to *unapplied* and see the admin alert (spec US4; quickstart §2 step 10).

### Tests for User Story 4 ⚠️

- [ ] T066 [P] [US4] Write `api-turistear/test/devolada/link-closing.test.ts`:
  - **Cancellations close the link**: an apartado with an open settlement link cancelled by an admin, an agent, or a tourist request approval. The link is marked `closing` in the same batch, a `PATCH close` follows, and it ends `closed`.
  - **Line cancel**: the link closes and the response carries a replacement link for the new balance.
  - **Other writes that close**, with the reason recorded:

    | Write | `closed_reason` |
    |---|---|
    | admin reject | `rejected` |
    | admin manual verify | `verified_by_admin` |
    | cash settlement while a settlement link is open | `settled_otherwise` |
    | D11 cancellation | — |
    | expiry-sweep cancellation | — |

  - **Devolada down during close**: the link stays `closing` and a later sweep closes it; a `LINK_CLOSED` answer counts as closed.
  - **Abandoned links**: the sweep replays the create with the same key and closes the link if it exists, or marks it `failed` if refused.
  - **Isolation**: `seedTwoOrgs`.

### Implementation for User Story 4

- [ ] T067 [US4] Add to `api-turistear/src/routes/devolada/links.ts` (D13):
  - `markLinksClosingStatement(db, organizationId, folioId, reason, {kinds?})`, returning an un-awaited `UPDATE devolada_links SET state='closing', closed_reason=? WHERE organization_id=? AND folio_id=? AND state IN ('creating','open')` for `db.batch`;
  - `closeOpenLinksAfterWrite(deps, organizationId, folioId)`, which calls `closePaymentLinkRemote` for every `closing` link of the sale.
- [ ] T068 [US4] Close links on every cancellation in `api-turistear/src/routes/folios/handler.ts` and `api-turistear/src/routes/pos/handler.ts`:
  - add `markLinksClosingStatement(…, 'cancelled')` to the batches of `cancelFolioPriced` / `applyCancellation` (`api-turistear/src/routes/folios/handler.ts:442, 778`) and `cancelFolioLinesPriced` (967);
  - after the write, call `closeOpenLinksAfterWrite` through `c.executionCtx.waitUntil` from `cancelFolio` (884), `cancelFolioLine` (1196), `approveCancellationRequest` (1486), `cancelBooking` (`api-turistear/src/routes/pos/handler.ts:3244`) and `cancelBookingLine` (2805);
  - the expiry sweep leaves remote closing to `sweepDevoladaPayments`.
- [ ] T069 [US4] Close links on the other writes in `api-turistear/src/routes/pos/handler.ts`, closing remotely after each write via `waitUntil`:
  - `rejectPayment` (3096) adds `markLinksClosingStatement(…, 'rejected')` to its batch;
  - `verifyPayment`'s admin path closes the verified sale's open links (`verified_by_admin`);
  - a cash settlement in `settleBooking` / `settleFolioLine` closes an open settlement link (`settled_otherwise`).
- [ ] T070 [US4] Replace the settlement link on line cancellation in `cancelBookingLine` (`api-turistear/src/routes/pos/handler.ts:2805`) and `cancelFolioLine` (`api-turistear/src/routes/folios/handler.ts:1196`). When the apartado had an open settlement link, issue a replacement for the new balance after the write (`issuePaymentLink`, kind `settlement`), and add `payment_link` / `payment_link_error` to the response.
- [ ] T071 [US4] Add the closing and abandoned branches to `api-turistear/src/routes/devolada/sweep.ts` (D12 step 3):
  - `closing` → `closePaymentLinkRemote` until `closed`;
  - `abandoned` → replay `createPaymentLink` with the same `Idempotency-Key`. If it exists, store `devolada_link_id` and close it. If refused, mark it `failed`.
- [ ] T072 [US4] When a cancel response carries `payment_link`, show «La liga de pago cambió — vuelve a enviarla» with the new `PaymentLinkCard` in `app-turistear/src/features/bookings/components/BookingActions.tsx`. Type those cancel responses in `app-turistear/src/services/bookingsService.ts` and `app-turistear/src/services/foliosService.ts`.
- [ ] T073 [P] [US4] Extend `app-turistear/src/features/bookings/components/BookingActions.test.tsx` with the replacement-link notice after a line cancellation, citing US4 and running axe.

**Checkpoint**: All four stories work independently. This is PR 3 (D19).

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Verification and record-keeping across stories. Each PR runs the items that apply to it.

- [ ] T074 [P] Write `api-turistear/test/devolada/query-plans.test.ts`. Run `EXPLAIN QUERY PLAN` through `env.DB` on the new correlated reads:
  - `loadPaymentLinkViews`;
  - the attention filter in `folioPendingWork.ts`;
  - the `verification_auto` and `devolada_attention` counts.

  Assert that no `SCAN` happens inside a correlated subquery (BUG-042, constitution § Additional constraints).
- [ ] T075 [P] Run `/security-review` over `api-turistear/src/routes/webhooks/`, `api-turistear/src/utils/devoladaSignature.ts`, `api-turistear/src/utils/devoladaCredential.ts` and `api-turistear/src/services/devolada.ts`. Confirm:
  - no key or ciphertext in any log or response;
  - the signature is verified before parsing;
  - the organization is resolved only through `devolada_link_id`;
  - every re-read uses the owning organization's credential;
  - the 64 KiB limit is enforced;
  - the production mode policy holds.
- [ ] T076 Run `specs/001-devolada-transfer-verification/quickstart.md`:
  - §1, including the scope-boundary `git diff --exit-code` check;
  - §2 steps 1-13 against a Devolada test business;
  - after deploying to dev, §3.
- [ ] T077 [P] Register the eleven defects of research.md § Defects found through `/speckit-bug-assess`, one entry each under `.specify/bugs/<slug>/`, without fixing them in this feature.
- [ ] T078 [P] Audit the citations. Every file in `api-turistear/test/devolada/` and every new app test cites `devolada-transfer-verification US<n>`. Every non-obvious rule under `api-turistear/src/routes/devolada/` and `api-turistear/src/routes/pos/{verifyCore,settleCore,unreceivedTransfer}.ts` cites `D<n>`. Each new route's suite has `seedTwoOrgs` cases.
- [ ] T079 Amend `specs/001-devolada-transfer-verification/spec.md` and `research.md` in place with whatever the build changed: decisions added or withdrawn in build, scenarios rewritten (constitution I). Set the spec's Status to `Implemented` once PR 3 merges.
- [ ] T080 [P] Add a §4 «Measuring the outcomes» to `specs/001-devolada-transfer-verification/quickstart.md`. Give the read-only aggregate SQL that measures, per organization and without customer data:
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
- **Polish (Final Phase)**: T074-T075 and T078 apply to every PR; T076, T077, T079 and T080 run once all stories are complete

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
  - T010, T011, T012 and T013 run in parallel (separate new files);
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

Run `/speckit-analyze` before `/speckit-implement`. The constitution's Workflow & Quality Gates require it to report no CRITICAL finding. Each PR is its own worktree off `origin/develop` and targets `develop` (constitution § Workflow).

### MVP First (User Story 1 Only) — PR 1

1. Complete Phase 1: Setup (T001-T006), including the constitution amendment
2. Complete Phase 2: Foundational (T007-T016)
3. Complete Phase 3: User Story 1 (T017-T043)
4. **STOP and VALIDATE**: quickstart §1 and §2 steps 1-4, 12, 13; scope-boundary suites unedited
5. Deploy to dev and validate §3 (real notifications), then release to production. Connected organizations get automatic verification; every exception still waits for the admin, as today

### Incremental Delivery

| PR | Contents | Stories | Validate with |
|---|---|---|---|
| 1 | T001-T043 | US1 | quickstart §1, §2 steps 1-4, 12, 13 |
| 2 | T044-T065 | US2 + US3 | quickstart §2 steps 5-9, 11 |
| 3 | T066-T073 | US4 | quickstart §2 step 10 |
| each | T074, T075, T078 | — | — |
| once all stories are done | T076, T077, T079, T080 | — | — |

Each PR leaves `develop` deployable: migration 0069 lands in PR 1, and its unused tables are harmless until PR 2.

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
- Every new tenant-scoped query filters by `organization_id`. The only exception is the webhook's lookup by `devolada_link_id`, a globally unique key (constitution III, research D4)
- Commit after each task or logical group, with Conventional Commits scoped by domain (`feat(payment-verification): …`)
- Stop at any checkpoint to validate the story independently
