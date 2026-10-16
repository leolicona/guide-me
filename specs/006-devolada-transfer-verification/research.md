# Research: Automatic Transfer Verification with Devolada

**Feature**: `specs/006-devolada-transfer-verification` · **Phase**: 0 of `/speckit-plan` · **Date**: 2026-10-06

Every decision below is numbered `D<n>` and carries its *why*. Code that implements one cites it in a
comment as `devolada-transfer-verification D<n>` (constitution I).

**Sources**:
- the spec;
- constitution v1.0.0 at planning, re-checked against v1.4.0 on 2026-10-15;
- Devolada's v1 contract (`contracts/devolada-collections-v1.openapi.yaml`);
- a read of the code on 2026-10-06, re-read on `main` on 2026-10-15 (§ Re-baseline below).

Paths are relative to `api-turistear/src/` unless prefixed `app:` (`app-turistear/src/`) or `test:`
(`api-turistear/test/`).

## Re-baseline against `main` (2026-10-15)

The plan was written on 2026-10-06. Before any task started, `main` absorbed the changes below, and
this folder was re-read against it:

| What changed on `main` | Effect here |
|---|---|
| Spec Kit numbering: `specs/001`–`005` are taken | This folder is `specs/006-devolada-transfer-verification`. Citations keep the slug `devolada-transfer-verification` |
| Affiliates and shift operators are retired (specs/001–003, migrations `0069`–`0070`). The roles are admin and agent, and `folio_payments.operator_id` is gone | `operator_id` leaves `devolada_links` and D8. The sellers are agents and admins |
| Better Auth replaces Agnostic Auth (specs/004-passkey-auth, migration `0071`; `0072` is reserved for the drop of the password columns). A session is a database row behind a signed HttpOnly cookie | Nothing in the design depended on the old token. The migration is `0073`, tests authenticate with `sessionCookie(email)` (D18), and `BETTER_AUTH_SECRET` joins D1's facts and alternatives |
| Delivery runs from one branch, `main` (specs/005-delivery-pipeline; constitution v1.4.0). Each pull request gets a preview on dev's D1, every push deploys dev, a `v*` tag releases production, and the API's secrets live in GitHub environments | D17 and D19 are rewritten. There are now four wrangler profiles, and every deploy plants the key. A preview gets dev's key or none, and registers no address. PRs target `main` |
| Bug `verify-send-empty-link`: an apartado's verification sends a deposit confirmation, not tickets, and marking tickets sent needs a portal token | D16: a deposit link's message never promises tickets |

Every code reference below was re-located on `main`. The decisions stand, except where this table
says otherwise.

## What the code does today — the facts the decisions rest on

| Fact | Where | Consequence |
|---|---|---|
| A transfer sale writes a `pending` ledger row **and** its allocations at confirm, so it derives `paid` at once. QR, portal token and ticket email wait for clearance | `routes/pos/handler.ts:1399-1418, 1707, 1799-1815, 1908-1948` | Full sales and deposits keep today's money model. Devolada only changes *who* clears them |
| `verifyPayment` flips **every** pending row of the sale, needs `c.get('user')` and `c.executionCtx`, and never checks `cancelled_at` | `routes/pos/handler.ts:2779-2988` (flip at 2818-2828) | A per-payment core without a request context is needed (D10) |
| `rejectPayment` is hand-written. It fully reverses the money (`buildCancellationReversal`, clawback) and releases seats for **all** lines, cancelled ones included, with no guard. It leaves `cancellation_source` NULL and the payment rows `pending` forever | `routes/pos/handler.ts:2993-3118`, `utils/folioPayments.ts:215` | The automatic cancellation must not inherit this (D11) |
| A settlement writes its row and allocations when settled. **Nothing in the code can undo a settlement**, and settling never clears the line clock | `routes/pos/handler.ts:2122-2468, 2476-2697` | An unpaid settlement can't be "withdrawn" without new ledger semantics, so it is recorded only once proven (D8) |
| Status derives from allocations whatever their verification | `utils/folioStatus.ts:16-29` | Same as above |
| Every manual cancel path refuses a sale whose transfer is unverified (`PAYMENT_UNVERIFIED`); the expiry sweep does not | `routes/folios/handler.ts:909-915, 1218-1224`; `routes/pos/handler.ts:2725-2731, 3161-3167`; `routes/pos/sweep.ts:41` | While a sale or deposit link waits, what the sale owes cannot change; the sweep needs a guard (D8, D13) |
| Public routes are routers mounted without `authMiddleware`; `/api/auth/*` hands the raw request to Better Auth. No route of ours reads the raw body, and there is no body limit | `index.tsx:60-110` | The webhook is its own router reading `c.req.text()` (D4) |
| Outbound HTTP has no timeouts. Tests stub it with `vi.spyOn(globalThis, 'fetch')` (`stubResend`, which passes every other URL through); unstubbed calls reach the real provider | `services/resend.ts`; `test:helpers/auth-flows.ts:54-69` | One Devolada module with explicit timeouts; a fake Devolada behind the same spy, on a host that cannot resolve (D5, D17, D18) |
| Two app secrets, each with a cost to rotate: `QR_SECRET`, split by HMAC labels, signs every ticket; `BETTER_AUTH_SECRET` signs the session cookie and encrypts the stored sign-in codes, so changing it signs everyone out | `utils/qr.ts:84-107`; `auth/index.ts:17-23, 175-177` | A dedicated key and AES-GCM for the credential (D1) |
| `GET /organizations/me` is readable by both roles, admin and agent | `routes/organizations/index.ts:21-24` | The credential never enters the organization payload (D1) |
| One cron trigger runs two independent `waitUntil` sweeps, in dev and production only: a pull request's preview has no trigger | `index.tsx:116-149`, `wrangler.jsonc:66-68, 91-98, 133-135` | A third independent sweep (D12); nothing a preview issues is swept by the preview itself (D17) |
| Migrations are hand-written; the highest is `0071`, and `0072` is reserved for the drop of the password columns. A pull request's migrations reach dev's D1 with its preview, before the merge | `api-turistear/migrations/`; `.specify/debt/password-material`; constitution § Additional constraints | This feature claims `0073`, and it must be harmless under the code already on dev (D19) |
| Secrets are managed in the GitHub environments `dev` and `production`; every deploy plants the API's secrets with the version it ships (`--secrets-file`, additive). A preview takes dev's values, or a throwaway when dev lacks one | `.github/workflows/deploy-dev.yml:47-62`, `deploy-prod.yml:82-97`, `preview.yml:101-124`; constitution VIII | The credential key is planted the same way, and a preview never gets a throwaway (D17) |
| An apartado's verification confirms the deposit only: tickets and the portal link wait for the settlement, the admin's «Verificar y enviar» sends a deposit confirmation instead, and marking tickets sent refuses a sale with no portal token (409) | `app:features/folios/components/VerifyAndSendButton.tsx:45-75`; `app:features/pos/delivery.ts:117-143`; `routes/pos/handler.ts:2078-2101`; bug `verify-send-empty-link` | A deposit's payment-link message never promises tickets (D16) |

## Decisions

### D1 — Credential custody

- **Decision**:
  - A new table, `devolada_connections`, holds one row per organization. Every key the organization connects is a row of `devolada_credentials`, encrypted with AES-256-GCM, and the connection points to its current one (D21).
  - The key is derived per organization as `HMAC-SHA256(DEVOLADA_CREDENTIAL_KEY, "guideme:devolada:v1:" + organizationId)`, the label pattern of `utils/qr.ts:84-107`.
  - The organization id is also bound as GCM additional data, and every write uses a fresh 96-bit IV.
  - `DEVOLADA_CREDENTIAL_KEY` is a new Worker secret, different in each environment, managed like the others (D17).
  - The API only ever returns a hint: the last four characters.
  - The organization payload carries a non-secret summary, `devolada: {status, mode}`, and never a credential column.
- **Rationale**:
  - FR-003: reading the database alone must not reveal the credential.
  - Constitution VIII: secrets are managed in the GitHub environments, planted on each Worker, and never shared across environments.
  - Constitution III: ciphertext copied into another organization's row fails to decrypt.
  - `GET /organizations/me` answers both roles, so a credential there would reach every agent.
- **Alternatives considered**:
  - A plaintext column fails FR-003.
  - `QR_SECRET` with a new label ties the two rotations together: rotating the ticket key would make every stored credential unreadable.
  - `BETTER_AUTH_SECRET`, or Better Auth's own encryption, ties the credentials to the session secret: changing it signs everyone out by design, and would also make every stored credential unreadable.
  - A Worker secret per organization cannot be created at runtime.
  - A new KV or secrets binding adds a binding for one value per organization, with nothing gained over D1 plus AES-GCM.

### D2 — Connection probe and credential mode

- **Decision**: connecting runs three steps, in order.
  1. **Format check**: `^dk_[0-9a-f]{32}$`.
  2. **Probe link**: `POST /v1/payment-links` with a fresh `Idempotency-Key` and the body `{customerRef: "turistear-conexion", askCents: 100, mode: "one_time", expiresAt: <one minute ago>, label: "Prueba de conexión — Turistear Ya!"}`. Its answer is the check:

     | Devolada answers | Result |
     |---|---|
     | 401 | `DEVOLADA_CREDENTIAL_REJECTED` |
     | 409 `CHANNEL_UNAVAILABLE` | `DEVOLADA_CHANNEL_UNAVAILABLE`, carrying `clabe` or `bank` |
     | 409 `BUSINESS_SUSPENDED` | `DEVOLADA_BUSINESS_SUSPENDED` |
     | 201 | the link's `isTest` is the credential's mode |

  3. **Mode policy**: `DEVOLADA_KEY_MODE` is `real` in production and `test` in dev, previews and local. A credential of the other mode gets `DEVOLADA_MODE_NOT_ALLOWED`.

  A `broken` connection is probed again the same way when an admin opens it (`GET /organizations/me/devolada`), at most once every 15 minutes: the app re-reads the connection whenever its window regains focus, and each probe leaves a dead link in the business's panel. A success makes it `connected` again, so a suspension lifted or a channel configured at Devolada heals the next time the admin looks. That card is the only place the admin learns that the connection broke; sellers are told at checkout (spec clarification of 2026-10-16). *(Amended 2026-10-15 and 2026-10-16 by /speckit-analyze.)*
- **Rationale**:
  - FR-002 needs the mode and a credential Devolada accepts, and the v1 contract offers no way to inspect a credential.
  - A one-time link born expired is the only call that does three things at once: uses the credential, reports the mode, and fails exactly where a real sale would fail (a business without its CLABE configured). It relies only on promised behaviour: "`expiresAt` … may be in the past (a link born expired)".
  - It costs one dead link per connection in the business's panel, labelled as ours.
  - Production taking only real credentials is FR-002. Dev taking only test credentials keeps a developer from pointing a real business's single notification address at the dev Worker (D3).
- **Alternatives considered**:
  - `GET /v1/webhook` proves the credential but neither the mode nor the channel.
  - The test-mode route (a real credential gets `NOT_FOUND`) depends on the order Devolada validates things in, which the contract does not promise.
  - Asking the admin to declare the mode trusts input the server can check.
  - See *Requests to Devolada* for `GET /v1/me`, which would replace the probe.
  - Probing a `broken` connection on every sweep heals it without the admin, but leaves a dead link in the business's panel every 15 minutes for as long as it stays broken. The admin, who fixes the cause at Devolada, is the one who looks again.

### D3 — Who owns the notification address

- **Decision**:
  - After the probe, the server calls `GET /v1/webhook`:
    - 404 → it registers our address with `PUT`;
    - the same URL → it keeps it;
    - a different URL → it refuses with `DEVOLADA_WEBHOOK_CONFLICT` (409, whose message is the current URL). Only when the request says `replace_webhook: true` does it `PUT` ours and record the replaced address.
  - Our address is the environment's `DEVOLADA_WEBHOOK_URL` (D17), not one derived from `API_BASE_URL`: the local profile sets `API_BASE_URL` to production's URL (`wrangler.jsonc:40-53`).
  - Where `DEVOLADA_WEBHOOK_URL` is empty (local and pull-request previews), no address is registered or replaced.
    - Locally, verdicts arrive only through the sweep (D12).
    - A preview serves dev's database and runs no cron, so the business keeps dev's address. Dev's Worker, through its webhook and its sweep, applies the verdicts of the links a preview issued once dev runs this code (D17).
  - Disconnecting does **not** remove Devolada's address. Neither does switching to another Devolada business: the previous business keeps our address, so its notifications for links still pending keep arriving (D21).
- **Rationale**:
  - FR-006. Devolada keeps one address per business, shared by real and test credentials.
  - A silent `PUT` would break anything else the business integrates, or let a dev environment take production's address.
  - Keeping the address after a disconnect preserves FR-004: links already issued are followed to their verdict (D12 follows them anyway).
- **Alternatives considered**:
  - A per-organization URL (`/webhooks/devolada/:orgId`) proves nothing, because the signature covers the whole platform. Constitution III also forbids taking the organization from a path.
  - Deleting the address on disconnect would cut off verdicts for links still open.

### D4 — Trusting a webhook

- **Decision**: `POST /api/webhooks/devolada` is its own resource, `src/routes/webhooks/`, following constitution IV's layout:
  - `index.ts` is the router: no auth middleware, and one validation middleware that runs steps 1–3 below and stores the parsed event in the context, so the input is validated before the handler runs;
  - `schema.ts` holds the Zod schema of Devolada's `WebhookEvent`;
  - `handler.ts` runs steps 4–8.

  It handles each request in this order:
  1. Refuse bodies over 64 KiB, then read the raw body with `c.req.text()`.
  2. Verify `Devolada-Signature` (`v1=`, base64url, raw `r‖s`): ECDSA P-256 / SHA-256 over `` `${Devolada-Timestamp}.${raw}` `` with the JWK whose `kid` equals `Devolada-Key-Id`.
     - The JWKS is cached per isolate by `kid`. An unknown `kid` refetches the key set once, as the contract says, through `services/devolada.ts` (D5), and at most once a minute per isolate: a forged request with a random `kid` cannot make every webhook call Devolada. *(Amended 2026-10-15 by /speckit-analyze.)*
     - Failure → 401 `WEBHOOK_SIGNATURE_INVALID`.
  3. Parse the body with Zod → 400 `WEBHOOK_PAYLOAD_INVALID`.
  4. Find our link by `data.paymentLinkId`. This is a globally unique key, the one kind of lookup constitution III exempts from actor scoping. An unknown link → 200, logged, nothing stored, because there is no organization to scope a row to.
  5. Check the mode: `data.isTest` must match the link's own `mode`, copied from the credential that created it. Otherwise → 200, recorded as `mode_mismatch`.
  6. De-duplicate on `eventId` (a `devolada_events` row). An event whose earlier processing failed is processed again.
  7. Re-read `GET /v1/payments/{paymentId}` **with the link's own credential** (D21), one of the owning organization's own, and apply D9 to the re-read, never to the body. A disconnected organization's link is re-read the same way, because its credential is kept while anything about the link is unresolved (FR-004).
  8. Answer:
     - 200 when done, and when the link's credential was already erased: nothing about the link is left to read, because its payments are final or no credential can read it (D21);
     - 500 on an internal failure;
     - 503 `DEVOLADA_UNAVAILABLE` when the keys or the re-read are unreachable.

     Both failures make Devolada retry after 1, 5, 15, 60 and 240 minutes.

  No timestamp window is enforced.
- **Rationale**:
  - FR-013 and SC-005.
  - The signature proves Devolada sent the message, not which business it concerns. The `paymentLinkId` lookup plus a re-read with that organization's own credential does: another business's payment answers `NOT_FOUND`.
  - Acting on the re-read also removes ordering and duplicate problems, because the re-read is always the current state.
  - A timestamp window would add little here. A replayed event only triggers one de-duplicated re-read, and a window could reject legitimate retries if Devolada re-sends the original timestamp.
- **Alternatives considered**:
  - Trusting the body fails FR-013.
  - A five-minute window carries the retry risk above.
  - Storing unresolved events needs a row without `organization_id`, which constitution III forbids.

### D5 — One module talks to Devolada

- **Decision**:
  - `services/devolada.ts` is the only code that calls Devolada, the unauthenticated key set (`/.well-known/jwks.json`) included.
  - Every call carries an `AbortSignal.timeout`: 3 s on the checkout and settle path, 8 s everywhere else.
  - Every call parses the `{success, data|error}` envelope and returns a typed result instead of throwing.
  - `POST` and `PATCH` carry `Idempotency-Key` = our row id. After a non-retryable refusal the key gains an attempt suffix, because Devolada replays refusals for 24 hours.
  - Devolada's milliseconds become our epoch seconds at this boundary.
  - The credential is never logged.
  - Error mapping is in `contracts/devolada-integration.md`.
- **Rationale**:
  - Constitution VIII: one module per service we do not own, and that service's failure never undoes a sale.
  - SC-006 allows at most 5 s added at checkout.
  - `services/resend.ts` has no timeouts. That is tolerable for fire-and-forget email, but not for a call inside the seller's request.
- **Alternatives considered**:
  - Throwing `ApiError` the way `resend.ts` does: every caller here has its own fallback to choose, so a result type is clearer.
  - A client generated from the OpenAPI adds a dependency for seven calls.

### D6 — The link is issued after the sale commits

- **Decision**: when the organization is connected and the method is `transfer`, `confirmSale` first writes the sale exactly as today (pending row, allocations, commission). Then it:
  1. inserts a `devolada_links` row in state `creating`;
  2. calls `createPaymentLink` with:
     - `mode: one_time`;
     - `customerRef` = folio id;
     - `askCents` = that payment's amount;
     - `expiresAt` from D7;
     - `label` = customer name;
     - `concept` = "‹organization› · ‹first service› ‹date›", at most 200 characters;
  3. on success, stores the link and answers `{folio, payment_link}`;
  4. on a refusal, marks the row `failed`; on a timeout, marks it `abandoned`. In both cases it answers `{folio, payment_link: null, payment_link_error}` and the sale stays on today's manual path.

  The seller sends no reference. For a connected organization the handler neither requires nor stores one, so the US-A88 switch governs only the manual path.
- **Rationale**:
  - FR-007, FR-009, FR-010.
  - Constitution VIII: the sale is the fact, and the link is a call outside its batch.
  - Writing our row before calling makes an orphan link impossible. A timed-out create is replayed with the same key within 24 hours to learn whether the link exists, and is then closed (D12). So is a row whose request died before recording any outcome: after 5 minutes in `creating`, the sweep treats it as `abandoned` (D12).
- **Alternatives considered**:
  - Inside the sale's batch: impossible, since HTTP is not a statement, and against VIII.
  - After responding: the seller would have no URL to send.
  - Before the sale: we would hold a link for a sale that may still fail its capacity guard.

### D7 — How long a link lives, and whose it is

- **Decision**:
  - A link expires at the earliest of:
    - 24 hours after it is issued;
    - the start of the sale's first live service;
    - for deposits and settlements, also the earliest live line clock (`booking_expires_at`).
  - A slot line starts at `slot_date` + `slot_start_time` in the organization's time zone; a stay at the end of its check-in day.
  - **A link that would stay open less than 15 minutes is not issued** (`MIN_LINK_LIFETIME`, one constant in `routes/devolada/links.ts`). Nothing is written and Devolada is not called. The sale or the settlement takes today's manual path, as when Devolada fails (FR-010), and the response says `payment_link_error: 'PAYMENT_LINK_TOO_SHORT'`. Decided by the developer on 2026-10-15.
  - `customerRef` = folio id, so every link of a sale shares the customer's Devolada reference.
- **Rationale**:
  - The spec's Assumptions: 24 hours or the first service, never past it. Confirmed by the developer on 2026-10-15.
  - A stay has no start time, only a check-in date. The end of its check-in day lets a guest who arrives that day pay by transfer; the start of the day would make every same-day stay's link born expired. The spec's Assumptions record this exception.
  - Keeping a deposit or settlement link inside the apartado's own clock means the expiry sweep never meets an apartado whose transfer link is still open. It is also guarded (D8).
  - The organization's own settings can put a sale or a settlement after its service starts. The sales cutoff accepts sales up to 240 minutes after departure (`sales_cutoff_offset_minutes`, US-A47), and a negative booking grace keeps an apartado's clock running past departure. A link capped at the service start would then be born expired, and D11 would cancel the sale within one sweep, before the customer could pay. Fifteen minutes is a working minimum, tuned in that one constant.
- **Alternatives considered**:
  - No expiry: a link could be paid weeks later for a seat released long before.
  - The apartado clock alone: links would stay open for days, while FR-016 needs a near decision.
  - Capping the link at the organization's sales cutoff rather than the service start: a sale after departure would still get only minutes, and the spec keeps every link inside its first service.

### D8 — A settlement is recorded only once it is proven

- **Decision**: for a connected organization, settling by transfer (`POST /pos/folios/:id/settle` or `…/lines/:lineId/settle`) runs today's guards and computes the balance. It then issues a `settlement` link (D6) and answers `{folio, payment_link}` with the sale **still an apartado**: no payment row, no allocation, no commission top-up.
  - **When the verdict is *confirmed***, the system records the settlement through a settle core extracted from both handlers, with these values:

    | Field | Value |
    |---|---|
    | method | `transfer` |
    | reference | Devolada's receipt number |
    | `verification` | `verified` |
    | `verified_by` | NULL |
    | `collected_by` | the seller who issued the link |
    | date | the verdict |

    It then runs the release core (D10) if the sale is now paid and cleared.
  - **One batch, gated by a claim** (constitution V: a read is never the only guard). A settlement link records at most one settlement, so the link itself is the claim:
    1. Generate the new payment row's id (`:newId`) first.
    2. The batch's first statement is `UPDATE devolada_links SET folio_payment_id = :newId [, state = 'paid'] WHERE id = ? AND organization_id = ? AND kind = 'settlement' AND folio_payment_id IS NULL`.
    3. Every later statement carries `WHERE EXISTS (SELECT 1 FROM devolada_links WHERE id = ? AND folio_payment_id = :newId)`: the payment row (as `INSERT … SELECT`), its allocations, the commission top-up, `settled_at`/`settled_by` and the event.
    4. The release runs only if, after the batch, the link holds `:newId`.

    A second processor — the webhook and the sweep at once, a Devolada retry, an admin's double tap on *accept* (D15) — matches nothing and writes nothing.
  - **An unpaid settlement link** simply closes.
  - **One open settlement link per sale**: a repeated transfer settlement for the same scope as the open link (the same line, or the whole sale) returns that link. Any other transfer settlement answers 409 `SETTLEMENT_IN_PROGRESS`, like the writes D13 refuses while the link's payment is in flight: another line, the whole sale while one line's link is open, or one line while the whole sale's link is open. *(Amended 2026-10-15 by /speckit-analyze.)*
  - **The expiry sweep** skips a sale while it has a link being created or open. It also skips it while a deposit that a link collects is still pending, whatever happened to that link: *partial*, *invalid*, *unapplied*, expired but kept by D11, unreadable by any credential, or never created. Devolada's verdict, or the admin's Verificar or Rechazar, decides it first; otherwise defect 4 would count as collected a deposit that never arrived. And it skips it while a settlement payment awaits the admin's decision (data-model § Attention): a *partial* or *invalid* verdict nobody has decided, or a payment in flight on a link no credential can read (D21). The customer may have paid, so the apartado waits for *accept* or *dismiss* (D15). Decided by the developer on 2026-10-15 for the settlement, and on 2026-10-15 and 2026-10-16 for the deposit.
  - **One bypass**: a settlement whose payment was submitted before its link expired is still recorded after the apartado's clock ran out, by its verdict or by the admin's *accept* (D15). The `BOOKING_EXPIRED` pre-check is skipped for that case only.
- **Rationale**:
  - FR-016's settlement branch requires an unpaid settlement to leave the apartado intact.
  - Settling writes allocations that derive `paid` at once (`utils/folioStatus.ts`), and nothing in the code can undo a settlement.
  - Recording only proven money follows constitution II ("dated when it actually happens") and adds no new ledger semantics.
  - The observable outcome is the spec's: an unpaid settlement leaves an apartado with its deposit and its clocks.
- **Alternatives considered**:
  - Settle now and reverse later with offsetting rows: this needs new "money that never arrived" semantics in the cash engine and reports, and un-settling brings back a clock that may already have passed.
  - Treat an unpaid settlement like Rechazar: that cancels cleared money, which FR-016 forbids.
- **Spec amendment**: FR-016 and Story 2 scenario 4 now say the sale *stays* an apartado. Amended in place.

### D9 — Applying a verdict

- **Decision**:
  - The webhook and the sweep share one function, `applyDevoladaPayment(link, payment)`.
  - Applying it twice changes nothing, and a final status never goes back. `applied_status` lets a repeat skip early, but that read is an optimization, never the guarantee: the guarantee is the guarded write each branch makes (D8, D10, D11).
  - `applied_status` is set only when a branch acted. A status or link kind that a PR only snapshots, because a later PR handles it, stays unmarked, so the PR that handles it applies it (D19). *(Amended 2026-10-15 by /speckit-analyze.)*
  - It never cancels on the clock alone. The unpaid branch requires a successful re-read, with the link's credential (D21), showing no payment at all, or an *expired* one. A payment in flight keeps the link open, and any other final verdict stays with the admin (FR-016). *(Amended 2026-10-15 by /speckit-analyze: a payment that ended invalid no longer cancels its sale when the link expires.)*

  | Devolada status | Sale or deposit link | Settlement link |
  |---|---|---|
  | `validating` | snapshot; the sale shows «Verificando pago» | same |
  | `queued_for_credit` | snapshot; the sale shows «Verificación en pausa» in Por verificar, and so does the connection health | same |
  | `validating` + `awaiting: payer_tracking_key` | snapshot; seller and admin see «Pide al cliente su clave de rastreo»; no expiry while it waits | same |
  | `confirmed` | verify that payment row (D10), which matches nothing if an admin already verified it by hand, so nothing is released twice; the receipt number becomes its reference; link `paid` | record the settlement (D8). If the admin already recorded it (D15), the claim matches nothing and nothing is recorded twice. Either way the link ends `paid` |
  | `partial`, `invalid` | snapshot; the sale stays pending, so it shows in Por verificar with asked and received amounts and its label; the admin uses Verificar or Rechazar as today (FR-018). For a deposit, the apartado does not expire until then (D8) | link closed; an attention item the admin *accepts* (records the settlement as the admin) or *dismisses* (the apartado continues) (D15). The apartado does not expire until then (D8) |
  | `expired`, or the link expired with no payment | FR-016 system cancellation (D11) | link `expired`; the apartado continues |
  | the link expired after a `partial`, `invalid` or `unapplied` verdict | link `expired`; nothing else: the admin decides (FR-016) | the link is already closed |
  | `unapplied` | attention item «Dinero recibido sin venta»; the admin marks it *returned* (D15) | same |
  | `superseded` | recorded and ignored; the correction arrives as a new payment | same |
  | `confirmed`, but the sale is already cancelled (a close that never reached Devolada) | treated as `unapplied`: a cancelled sale is never verified | same |

- **Rationale**:
  - FR-014 to FR-017 and Story 2.
  - Settlement exceptions cannot use today's sale-level Verificar or Rechazar: under D8 they have no pending row to flip. *Accept* and *dismiss* are their equivalents (FR-018).
  - Requiring a successful re-read before an unpaid cancellation means a Devolada outage can never cancel a sale.

### D10 — Verifying one payment at a time

- **Decision**:
  - Two cores are extracted from `verifyPayment`, neither tied to a request:
    - `verifyFolioPayment(deps, {organizationId, folioId, paymentId | 'all', actorId | null, reference?, at})`;
    - `releaseClearedFolio(deps, {organizationId, folioId, at})`, which signs the live slot lines, issues the portal token, sends the ticket email, and emits the `payment_verified` and `tickets_delivered` notifications.
  - Devolada verifies **one** row: its link's `folio_payment_id`, with a single guarded `UPDATE … WHERE verification = 'pending' RETURNING`.
  - The sale's `payment_verification` becomes `verified` through a guarded `UPDATE folios … WHERE payment_verification = 'pending' AND NOT EXISTS (<a pending payment row of the sale>) RETURNING`.
  - `verifyFolioPayment` returns `{flipped, rollupVerified}`. The release runs only in the call that got **both** — its row flip and the rollup update matched — and only when the sale is paid and not cancelled. A second processor can therefore never sign the tickets again (which would invalidate QR codes already delivered) or send the email twice.
  - The admin endpoint calls the same cores with `'all'`, so its behaviour does not change.
  - `deps` = `{db, env, waitUntil}`, following the precedent of `queueCancellationEmail({env, executionCtx})` (`routes/folios/handler.ts:819`).
- **Rationale**:
  - Story 3 scenario 4: a pending deposit and a confirmed settlement are separate facts.
  - The webhook has no request context.
  - Flipping every row is right for an admin who verifies a sale, and wrong for a provider that proves one transfer.
- **Alternatives considered**:
  - A second copy of the release code: two paths that drift.
  - Calling the HTTP endpoint as a system user: there is no system user, and `verified_by` must stay NULL («Sistema»).

### D11 — Cancelling when the money never arrived

- **Decision**: `cancelForUnreceivedTransfer(deps, {organizationId, folioId, linkId, at})` runs four steps:
  1. **Claim the link**: `UPDATE devolada_links SET state = 'expired' WHERE id = ? AND organization_id = ? AND state = 'open' RETURNING`. One worker wins.
  2. **Check the sale**: go on only if all of these hold. Otherwise the result is `'kept'`: the link stays `expired` and the sale is left as it is. A sale still pending stays in Por verificar through `verification`, labelled `not_received`, and nothing else is stored.
     - The sale is not cancelled.
     - The link's own row is still pending. An admin may have verified it by hand while its payment was in flight (D13), and a sale an admin verified is never cancelled automatically.
     - No other link of the sale has an undecided payment in flight, as when an apartado's deposit link expires while its settlement is being verified. A payment the admin already accepted or dismissed (D15) does not count, even if its last snapshot still reads in flight because no credential can read its link (D21).
     - The link's row is the sale's only positive money. A sale holding any other money is never cancelled automatically.
  3. **One `db.batch`, every statement gated on the batch's own transition** (constitution V: the read in step 2 is never the only guard):
     - first, the sale is cancelled `WHERE cancelled_at IS NULL`, stamping `cancelled_at = :at`, `cancellation_source = 'payment_not_received'` (new value) and the reason «No se recibió la transferencia»;
     - every later statement carries `WHERE EXISTS (SELECT 1 FROM folios WHERE id = ? AND organization_id = ? AND cancelled_at = :at AND cancellation_source = 'payment_not_received')`, inserts written as `INSERT … SELECT … WHERE EXISTS`:
       - its live lines cancelled (`WHERE cancelled_at IS NULL`);
       - the reversal from `buildCancellationReversal`, with clawback;
       - seats and reservations released **for live lines only**;
       - the sale's other open links marked `closing`, with `closed_reason` `cancelled` (D13);
       - the event `transfer_not_received`, with a NULL actor.

     If anything cancelled the sale between step 2 and the batch, the first statement matches nothing and so does every other: nothing is reversed or released twice.
  4. **After the batch**: the `payment_rejected` notification, then the claimed link and the sale's other closing links are closed at Devolada (D13).

  It returns `'cancelled'`, `'kept'`, or `'noop'` when step 1's claim matched nothing. *(Amended 2026-10-15 by /speckit-analyze: step 2's conditions, the other links, and `'kept'` in place of an undefined attention item.)*

  The seat and reservation release statements are extracted from `rejectPayment` into a builder both use. The admin's Rechazar is otherwise untouched.
- **Rationale**:
  - FR-016 says "the way Rechazar cancels", but without Rechazar's defects: it releases seats for lines already cancelled, has no not-cancelled guard, and would erase a cleared deposit (`routes/pos/handler.ts:2993-3118`).
  - A separate `cancellation_source` keeps these out of the expired-apartado counts (`system_expiry`).
  - A concurrent manual Rechazar cannot make this path write twice: whichever cancels first wins, and the gated batch above writes nothing if it was Rechazar. Rechazar itself still has no guard of its own when it runs second; that is defect 3 below.
- **Alternatives considered**:
  - `cancelFolioPriced` prices by the cancellation policy, which is wrong for money that never arrived (the BUG-030 reasoning, `routes/folios/handler.ts:905-908`).
  - Calling `rejectPayment` as it is inherits its defects.

### D12 — The recovery and expiry sweep

- **Decision**:
  - `sweepDevoladaPayments(env, now)` lives in `routes/devolada/sweep.ts` and runs as a third independent `ctx.waitUntil` in `scheduled()`, with `now = new Date(controller.scheduledTime)`.
  - Each run covers every unresolved link (data-model), whatever its organization's status, and checks it with the link's credential (D21). It is fail-soft per organization (loading each credential included) and per sale, and does four things:
    1. Sales get `GET /v1/payments?customerRef=<folioId>`, one call per credential of the links below, and D9 for each payment, when they have a link that is either:
       - `open`, and unchecked for 10 minutes or past `expires_at`;
       - `closed` while its current payment is still in flight, and unchecked for 10 minutes. A cancellation or Rechazar closed it under that payment (D13), whose verdict, usually *unapplied*, is money to return (FR-012).

       A retired credential Devolada rejects takes D21's fallback. A rejected or suspended current credential marks the connection `broken`, and the links that use it wait until the admin fixes it. A retired credential's suspended business is retried at the next run.
    2. A link past expiry whose current payment is absent or *expired* takes D9's unpaid branch. One whose payment is in flight stays open. Any other final verdict (*partial*, *invalid*, *unapplied*) moves the link to `expired` and leaves the sale to the admin (FR-016), so the sweep stops re-reading it.
    3. Links in the remaining states are retried:
       - `creating` for more than 5 minutes: the request that wrote it died before recording an outcome, so the link becomes `abandoned` (D6);
       - `abandoned`: replay the create with the same key; if the link exists, close it;
       - `closing`: send `PATCH {close: true}` until Devolada acknowledges. A link a cancellation marked `closing` while its create was still running, and whose create never recorded Devolada's id, is first replayed with the same key to learn it.
    4. A retired credential with no unresolved link is erased (D21). Disconnecting retires the current one, so a disconnected organization's key goes once its last link resolves and every payment of its links has its verdict. *(Amended 2026-10-15 by /speckit-analyze: closed links whose payment is in flight, and links left in `creating`. Amended 2026-10-16: the current credential's rejection, and `closing` links without Devolada's id.)*
  - Budget: at most 50 Devolada calls per organization per run (the limit is 120 a minute, shared with live traffic). `RATE_LIMITED` stops that organization until the next run.
  - Order, so the budget never starves a sale: links past `expires_at` first, then never-checked links, then the oldest `last_checked_at`. Every notification applied also stamps `last_checked_at`, so the sweep spends its budget only on links nothing has reported on for 10 minutes.
  - Scale: SC-003 and SC-009 hold while an organization has at most 50 such links per run. Production today has 5 transfers in 75 days. Past that, each extra 50 links adds one run (15 minutes) to a lost verdict's delay; raising the budget toward Devolada's limit is the lever. *(Amended 2026-10-15 by /speckit-analyze.)*
- **Rationale**:
  - FR-012; SC-003 (at most 15 minutes to the next run plus 10 to the recheck stays under 30); SC-009; FR-004.
  - It mirrors `sweepExpiredBookings` (`routes/pos/sweep.ts:41`): it needs only `env`, is fail-soft, and is tested by calling it with an explicit `now` (dates are frozen in tests, `test:helpers/apply-migrations.ts:39-45`).
  - Taking `now` from `scheduledTime` lets local validation advance the clock with the `?time=` parameter of `/cdn-cgi/local/scheduled`.
- **Alternatives considered**:
  - Devolada's `GET /v1/transfers` lists only money that arrived, not waits or expiries.
  - A Queue or Durable Object alarm per link adds new bindings for a guarantee the 15-minute cron already gives.

### D13 — Closing links

- **Decision**:
  - Every write that stops a sale from taking a payment marks that sale's open links `closing` **in the same batch**:
    - `cancelFolioPriced` and `cancelFolioLinesPriced`, which cover admin, agent and tourist cancellations, line cancellations and the expiry sweep;
    - `rejectPayment`;
    - the admin's manual Verificar, for the links that collect the rows it verified;
    - D11, for the sale's other links;
    - a cash settlement of what an open settlement link collects: its line, or the whole sale.

    The reason is recorded in `closed_reason`: `cancelled` when the sale, or the link's own line, is cancelled; `amount_changed` when a line cancellation leaves the sale alive with a new balance for a whole-sale link; `rejected`; `verified_by_admin`; `settled_otherwise`; and `abandoned` when the sweep finds that a timed-out create did exist. D11's own link ends `expired`, with no reason. *(Amended 2026-10-15 by /speckit-analyze.)*
  - **A settlement link closes only when the write touches what it collects.** A whole-sale link (no `folio_line_id`) closes on any line cancellation or cash settlement, since its amount no longer matches the balance. One line's link closes only when that line is cancelled or settled. It stays open when another line is cancelled or settled in cash, since its line still owes what the link asks. *(Amended 2026-10-15 by /speckit-analyze.)*
  - **While the sale stays alive, a link is never closed under a payment in flight** (*validating*, awaiting a tracking key, or `queued_for_credit`). Decided by the developer on 2026-10-15:
    - the admin's manual Verificar leaves that link open. Its verdict is recorded and releases nothing a second time (D10), and the link is closed once that verdict is final;
    - while a settlement link's payment is in flight, a line cancellation or a cash settlement that would close that link answers 409 `SETTLEMENT_IN_PROGRESS`, and the seller waits for the verdict;
    - cancelling the sale, and Rechazar, still close it: the sale is gone, so money that arrives after is rightly *unapplied* (D9). The sweep follows that payment until its verdict (D12).
  - After the write, the handler closes them at Devolada (`PATCH {close: true}`) under `waitUntil`. The sweep retries until Devolada acknowledges. A `closing` link whose retired credential Devolada rejects takes D21's fallback; while the current credential is rejected, the link stays `closing` until the admin fixes the key.
  - When a line cancellation closes a whole-sale settlement link and the sale still owes, a replacement settlement link (D6) for the new balance is issued and returned. A line's own link closes without a replacement when its line is cancelled.
- **Rationale**:
  - FR-011 and Story 4.
  - Marking inside the batch keeps the link's state consistent with the money; the HTTP close stays outside it (VIII).
  - Closing a link under a payment in flight turns that payment *unapplied* at Devolada: "validated money that settled nothing (the link had closed)". The admin would then be told to return money that paid a live sale. That happens in the spec's edge case of a manual verification during validation, and when a balance changes under a transfer already made.
  - Verifying a deposit by hand does not stop the sale from taking its settlement, so the settlement link stays open.
  - Only settlement links ever need a replacement. A sale or deposit with a pending transfer cannot change what it owes, because every manual cancel path refuses it with `PAYMENT_UNVERIFIED`.
- **Alternatives considered**:
  - Closing synchronously inside the cancellation: a Devolada outage would block cancellations, against VIII.
  - Not closing: a customer could pay a cancelled sale. That money surfaces as `unapplied` (D9), but preventing it is cheaper.
  - Closing anyway, and labelling the resulting *unapplied* as money of a verified sale: one status with two meanings. Rejected by the developer on 2026-10-15.

### D14 — Read model, queue and counts

- **Decision**:
  - **Sale reads**: `readFolioDetail` gains `payment_links[]`, and list rows gain `payment_link` (contracts/turistear-api.md § PaymentLinkView). Each carries the kind, state, amount, URL, expiry, the latest payment's facts, and a `label` code decided by the server. The client only maps codes to copy.
  - **Por verificar holds only work for the admin** (spec clarification of 2026-10-15). Two flags on every list row and on the detail, both decided by the server:
    - `verification_auto`: the sale is pending verification with a live line, and Devolada is handling it with nothing for the admin to do. Every pending payment row is collected by an `open` link that either waits for its first payment before `expires_at`, or whose current payment is *validating* without `awaiting`. A payment still *validating* past `expires_at` keeps the flag: the customer paid in time and Banxico has not answered yet. The sale also has no unresolved attention item.
    - `devolada_attention`: the sale has an unresolved attention item (data-model § Attention).

    The «Por verificar» facet lists the sales pending verification that are not `verification_auto`, plus every `devolada_attention` sale. A `verification_auto` sale offers no «Verificar y enviar» on its card, and the admin can still verify it from the sale (FR-018). It returns to the queue by itself as soon as its link expires with no payment, its credit pauses, the customer owes a tracking key, an exception arrives, or no credential can read its link any more (D21).

    The words follow the flag. On a `verification_auto` sale, the detail's header shows the link's chip instead of «Por verificar», and the receipt's pending payment rows read «En verificación»: «Por verificar» names the admin's work (`app:features/folios/components/FolioStateSheet.tsx:57-58`).

    The flag and the counts share one SQL predicate. Its attention clause arrives with the attention items, in PR 2. *(Amended 2026-10-15 by /speckit-analyze: a payment validating past the link's expiry, the words, and the order of the attention clause.)*
  - **Pending work**: the pending-work set (`utils/folioPendingWork.ts`) gains the Devolada attention items, so the «Por verificar» facet lists them whatever their age.
  - **Counts**: `GET /api/folios/counts` gains two counts, and each sale counts once:
    - `verification_auto`: the sales whose row flag is set;
    - `devolada_attention`: the `devolada_attention` sales that `verification` does not already count, because they are cancelled or their payment verification is not pending.

    The «Por verificar» number is `verification − verification_auto + devolada_attention`, the same in the admin badge, the Ventas pending-work bar and Hoy. The badge adds `folio_requests`.
  - **Organization**: `GET /api/organizations/me` gains `devolada: {status, mode}`.
  - **Indexes**: every correlated read is backed by an index led by `(organization_id, folio_id)`.
- **Rationale**:
  - FR-015, SC-004, and constitution IV: the server decides the label and the flags; the client mirrors them.
  - The spec says a sale Devolada clears never enters Por verificar (Story 1, scenario 3). The code already ruled that a queue which grows from correct behaviour is the failure: US-A82 D7, cited in `VerifyAndSendButton.tsx`.
  - Listing every sale in flight with «Verificar y enviar» would invite releasing tickets before the money is proven, and would blur SC-001.
  - The expiry clause matters before PR 2: until the automatic cancellation exists, an unpaid link that expired must come back to the admin rather than hide, which is the 66-day case of the spec's Context.
  - Counting each sale once keeps the badge, the bar and the list in agreement. A tracking-key wait on a sale link is pending, so `verification` already counts it.
  - BUG-042: `EXPLAIN QUERY PLAN` must show no `SCAN` inside a correlated subquery.
- **Alternatives considered**:
  - Labels or flags derived in the client: a second source of truth.
  - Dropping Devolada sales from `verification`: changes the meaning of an existing count under existing tests.
  - Keeping every sale in flight in Por verificar and only out of the badge: the list and the badge disagree, and every card invites a manual verification. Rejected by the developer on 2026-10-15.

*(Amended 2026-10-15 by /speckit-analyze: the two flags, the facet and the once-per-sale counts.)*

### D15 — The admin resolves Devolada exceptions

- **Decision**: `POST /api/devolada/payments/:id/resolve` (admin) takes an `action`:

  | Action | For | Effect |
  |---|---|---|
  | `accept` | a settlement exception, or a settlement payment Devolada is still verifying (*validating*, awaiting a tracking key, `queued_for_credit`) | records the settlement as the admin; `verified_by` = admin. It is recorded past the apartado's clock too, when the payment was submitted before its link expired (D8's bypass). For a payment still in flight, the link stays open until the verdict, which records nothing more and ends the link as D9 says (`paid` when confirmed). An apartado already settled another way answers 409, and the admin dismisses the payment instead |
  | `dismiss` | a settlement exception, or a settlement payment in flight on a link no credential can read (D21) | closes the link, when a credential can still reach it; the apartado continues. Money that arrived, as with a *partial* payment, is returned outside the system, like *unapplied* money |
  | `returned` | an `unapplied` payment | the admin returned the money outside the system |

  Every action is claimed by a guarded write before it acts:
  - `accept` records the settlement through D8's claimed batch, which also sets the payment's `resolution`;
  - `dismiss` and `returned` set `resolution … WHERE resolution IS NULL RETURNING`.

  A double tap answers 409 `DEVOLADA_PAYMENT_NOT_RESOLVABLE` the second time and writes nothing.

  In the UI, *accept* is «Verificar», the verb the admin already uses to clear a transfer (constitution VII: one verb per action). *Dismiss* is «Descartar», because it does not cancel the sale, while today's «Rechazar pago» does. *Returned* is «Ya lo devolví». The copy is in contracts/turistear-api.md § Action copy.

  Sale and deposit exceptions keep using today's Verificar and Rechazar. When those are used, the link is closed (D13).
- **Rationale**:
  - FR-015 and FR-018: the admin can always decide by hand. A settlement has no pending row until it is proven (D8), so without `accept` on a payment in flight, a stalled validation (paused credit, a tracking key the customer never gives) would leave a paid apartado with no way to release its tickets. Decided by the developer on 2026-10-15.
  - A stalled validation is exactly when the apartado's clock runs out, so `accept` takes D8's bypass, and the apartado waits for the admin's decision instead of expiring under it (D8). Decided by the developer on 2026-10-15.
  - `dismiss` stays limited to exceptions: closing a link under a payment in flight would turn that payment *unapplied* (D13). A link no credential can read cannot be closed anyway, so its payment can be dismissed.
  - Under D8 a settlement exception has no pending row for Verificar to flip.
- **Alternatives considered**:
  - Reusing `/verify` and `/reject` for settlement exceptions: they act on pending rows that don't exist here, and Rechazar cancels the sale, against FR-016's principle.

### D16 — Frontend surfaces and copy

- **Decision**:
  - **Ajustes**: a card «Cobro con Devolada» after «Punto de venta» (`app:pages/SettingsPage.tsx:668-728`).
    - It shows the status chip, mode, key hint and health.
    - The credential is the «Clave de API de Devolada», and its hint reads «Clave …abcd». «Llave» already names the passkeys, the «llave de acceso», across the app since specs/004-passkey-auth.
    - Connecting or replacing the key happens in a `FormSheet`; replacing the address and disconnecting use `ConfirmSheet`.
    - While connected, the reference switch says it applies only without Devolada.
  - **Checkout and SettleSheet**: when `devolada.status` is `connected`, the Referencia field is not offered and the consequence line announces the link.
    - The transfer fields move into `features/pos/components/TransferPaymentFields.tsx` so they can be tested. Constitution VI does not allow tests of `pages/`.
  - **Receipt, sale detail and BookingActions**: a `PaymentLinkCard`, titled «Enlace de pago», with:
    - the amount, a status chip and, while the link is open, «Vence hoy a las HH:MM» or «Vence mañana a las HH:MM» (a link lives at most 24 h, D7);
    - the primary action «Cobrar por WhatsApp» (`paymentLinkWhatsAppUrl` in `features/pos/delivery.ts`, with a shipped default text per link kind);
    - polling every 15 s while the link waits.

    The receipt shows «Pago en verificación» instead of «Venta confirmada» and «Pagado» while the money is unverified. That rule lives in a component under `features/pos/components/`, not in the page, so it can be tested (constitution VI).
  - **BookingActions**: in PR 2, while a settlement link is open, «Liquidar saldo» and «Liquidar todo» give way to the chip «Liquidación en verificación». From PR 3 the buttons stay while the link waits for its first payment, and the chip shows only while its payment is in flight (D13, D19).
  - **One word per concept, one verb per action** (constitution VII):
    - the state of money being checked keeps the word the UI already uses, **verificación**: «Verificando pago», «Pago en verificación», «Verificación en pausa». «Validar» never appears in the UI, even though Devolada calls its own check a validation;
    - sending the link is collecting the payment, so its action uses the canonical verb **Cobrar**: «Cobrar por WhatsApp»;
    - a URL the customer opens is an **enlace**: «Enlace de pago», «con este enlace». The customer's ticket message already says «guarda el enlace», and the timeline already calls the `link` payment method «enlace». «Liga» and «link» never appear in new copy. Decided by the developer on 2026-10-15. The hidden `link` method's own label, «Link de pago», is defect 12.
  - **Por verificar**: FolioCard and FolioWorkActions show the labels and amounts. The timeline adds the new event types to its three exhaustive records, and AppLayout uses the new badge sum.
  - **Copy**: `contracts/turistear-api.md` § Labels and § Action copy. Tasks cite it rather than restate it.
  - **The link's message depends on its kind** (contracts § WhatsApp message). A deposit's message never promises tickets, because an apartado's tickets wait for its settlement. Bug `verify-send-empty-link`, fixed on `main` on 2026-10-06, removed exactly that promise from the admin's «Verificar y enviar».
- **Rationale**:
  - FR-008 and FR-022.
  - Constitution VII: primitives first, «Venta» never "folio", every state paired with an icon and text.

### D17 — Environments and configuration

- **Decision**:
  - **Vars**, repeated in every wrangler profile because named environments inherit none (`wrangler.jsonc:14-16`):

    | Profile | `DEVOLADA_API_BASE_URL` | `DEVOLADA_KEY_MODE` | `DEVOLADA_WEBHOOK_URL` |
    |---|---|---|---|
    | local | `https://api.devoladapago.com` | `test` | empty |
    | dev | `https://api.devoladapago.com` | `test` | `https://api-dev.turistearya.com/api/webhooks/devolada` |
    | preview (one per pull request) | `https://api.devoladapago.com` | `test` | empty |
    | production | `https://api.devoladapago.com` | `real` | `https://api.turistearya.com/api/webhooks/devolada` |

    - Dev and previews use Devolada's production API with test credentials, which is the contract's test mode.
    - The address is empty where Devolada cannot or must not deliver:
      - a laptop, whose `API_BASE_URL` points at production (D3);
      - a preview, which shares dev's database; its own address would take the business's one address away from dev (D3).
    - Previews have no cron (`wrangler.jsonc:91-98`). A link issued on a preview lives in dev's database, so dev's webhook and sweep follow it once dev runs this code. Until PR 1 merges, verdicts are validated locally (quickstart §2).
  - **Secret** `DEVOLADA_CREDENTIAL_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`), generated once per environment and never shared between environments. It is managed the way constitution VIII manages every API secret:
    - it lives in the GitHub environments `dev` and `production`, and every deploy plants it with the version it ships (`deploy-dev.yml` and `deploy-prod.yml`, `--secrets-file`, additive);
    - if the value is present but does not decode to 32 bytes, the deploy stops before it migrates;
    - if the value is absent, the Worker keeps its current one, as for `QR_SECRET`;
    - it is never pasted again: a different value makes every stored credential unreadable, and every organization would have to connect again;
    - a preview takes the `dev` environment's value, or **none, never a throwaway**. A preview writes into dev's D1, so a credential encrypted under a throwaway key could be read neither by dev's Worker nor by the preview's own next deploy. Without it, the pull request's note says that Devolada is off on that preview;
    - it is in the `dev` environment before PR 1's preview is used to validate, and in `production` before PR 1 is released;
    - locally it lives in `.dev.vars`, documented in `.dev.vars.example`.
  - **Without a readable key**, the API fails closed. That covers a key that was never planted, and one that is not the key a credential was encrypted with:
    - connecting answers 500 `INTERNAL_ERROR`;
    - a sale issues no link and stays on the manual path (FR-010), never answering 500 after it committed;
    - the webhook answers 503, and the sweep skips the links of that credential.

    Every case is logged without the key.
  - **Tests** pin all four in `vitest.config.ts`: `DEVOLADA_API_BASE_URL = https://devolada.test`, so an unstubbed call fails instead of reaching Devolada, and `DEVOLADA_WEBHOOK_URL = https://api.test/api/webhooks/devolada`.
  - **Bindings** go in `src/bindings.d.ts`, followed by `pnpm cf-typegen:api`.
- **Rationale**:
  - Constitution VIII (v1.4.0): secrets live in the GitHub environments, every deploy plants them, no two environments share one, and none is in the repository. Its rule that a preview may get a throwaway value does not fit a key that encrypts rows in dev's database; the amendment (T006) records the exception.
  - The test pin closes the gap the infrastructure read found: unstubbed calls reach the real provider.
  - Failing closed keeps constitution VIII's promise: a missing key never blocks or undoes a sale.
- **Alternatives considered**:
  - Devolada's shared dev environment is Devolada's own playground; test mode on its production API is what the contract offers integrators. The var keeps either one open.
  - `wrangler secret put` per environment, the plan of 2026-10-06. Constitution v1.4.0 superseded it by managing every API secret in the GitHub environments.
  - A preview with its own address (`--var DEVOLADA_WEBHOOK_URL:<preview origin>/api/webhooks/devolada`). It would take the test business's one address from dev, and leave it pointing at a deleted Worker once the pull request closes.

### D18 — Tests

- **Decision**:
  - **API** (workerd, real D1):
    - A stateful fake Devolada in `test:helpers/devolada.ts`, behind `vi.spyOn(globalThis, 'fetch')` for `https://devolada.test`. It covers links, payments, the test-mode advance, the notification address, a generated P-256 key pair served as JWKS, and a builder for signed webhook requests.
    - Suites in `test:devolada/`: connection, checkout-link, webhook, verdicts, apartados, link-closing, sweep, isolation, credential-cipher, signature, link-view (the label precedence) and query-plans (BUG-042).
    - Each file cites `devolada-transfer-verification US<n>`, and every new route has `seedTwoOrgs` cases.
    - Requests authenticate the way production does: `headers: { Cookie: sessionCookie(email) }` (`test:helpers/session.ts`), a real Better Auth session row behind a signed cookie. `seedTwoOrgs` returns each admin's email for it.
    - The fake composes with `stubResend` (`test:helpers/auth-flows.ts:54-69`). A test that needs both calls `stubResend()` first, and `installFakeDevolada()` chains to the spy's current implementation instead of replacing it, so ticket emails still reach the Resend stand-in.
  - **App**: tests for DevoladaConnectionCard, PaymentLinkCard, TransferPaymentFields, ReceiptPaymentStatus, PaymentBreakdown, PendingWorkBar, the «Por verificar» facet and card state, the SettleSheet connected mode and the FolioCard labels, each component test with `expectNoA11yViolations`. MSW handlers live in `app:test/handlers/devolada.ts`.
  - **Scope boundary**: `test:pos/payment-verification.test.ts`, `test:pos/optional-payment-reference.test.ts` and `test:paid-ledger/settle-method.test.ts` pass unedited.
- **Rationale**: constitution VI. Rules are proven in the API, and stand-ins sit at the provider's boundary.

### D19 — Delivery

- **Decision**: three PRs to `main`, each deployable.

  | PR | Stories | Contents |
  |---|---|---|
  | 1 | Story 1 | migration 0073 (all five tables); D1–D7; D21; D9 for `validating` and `confirmed`; D10; D12 recovery, with links left in `creating` marked `abandoned`; D14; D16 for Ajustes, checkout and receipt; D17; the constitution amendment |
  | 2 | Stories 2 and 3 | the rest of D9; D8; D11; D15; the sweep guard; the sweep's retry of `closing` links; queue labels and counts |
  | 3 | Story 4 | D13; the replay of `abandoned` links and the follow-up of payments on closed links (D12) |

  Between PR 1 and PR 2, an exception or an unpaid link leaves the sale in Por verificar for the admin, exactly as today. In PR 1 the sweep moves an unpaid link past its expiry to `expired` once a successful re-read shows no payment, or an *expired* one, and cancels nothing. Its sale is already back in Por verificar (D14), and the sweep stops re-reading it. PR 2 replaces that step with D9's unpaid branch. *(Amended 2026-10-15 by /speckit-analyze.)*

  How each PR ships (constitution § Development Workflow):
  - each PR is its own worktree off `origin/main` and targets `main`;
  - its preview applies its pending migrations to dev's D1 **before** the merge, so PR 1's `0073` reaches dev while dev still runs `main`'s code;
  - the merge deploys dev, and a `v*` tag releases production;
  - PR 1 is released to production only after `DEVOLADA_CREDENTIAL_KEY` is in the `production` environment (D17, T003);
  - a later PR's preview writes rows into dev's database that dev's earlier code does not handle yet: a deposit or settlement link while dev runs PR 1. PR 1's code keeps any verdict on a kind or status it does not handle as a snapshot, without marking it applied (T028), so dev applies it once it runs PR 2. These are test-mode rows on dev;
  - until PR 3, Rechazar does not close the link. A customer who pays a rejected sale before the link expires is recorded as a snapshot, and only surfaces once PR 2 brings `unapplied`. This is accepted: it is today's risk, since a rejected customer can transfer anyway, and the link expires within 24 hours;
  - until PR 3, no cancellation, Rechazar, line cancellation or cash settlement closes or replaces a settlement link. In PR 2 only D11 and the settlement exceptions close links (D9, D15), and the sweep already retries those closes. So in PR 2, while a sale has an open settlement link, a line cancellation, a cash settlement and any other transfer settlement answer 409 `SETTLEMENT_IN_PROGRESS`, and the settle buttons stay hidden. PR 3 narrows the refusal to a write that would close a link whose payment is in flight (D13). *(Amended 2026-10-15 by /speckit-analyze.)*
- **Rationale**:
  - The spec makes each story independently testable.
  - The migration is additive, so tables created in PR 1 sit harmlessly unused until PR 2 uses them. That holds on dev too, where `0073` lands before any code reads it.

### D20 — What we deliberately leave out, and why that is safe

| Left out | Why it is safe |
|---|---|
| An organization-specific WhatsApp template for the link | The default message covers the need, and Ajustes already hosts templates when one is wanted |
| Re-issuing a link after a fallback | The sale is on today's manual path, which works |
| Automatic refunds of `unapplied` or overpaid money | The admin is alerted with the amounts (D9, D15), and transfers are 0.5% of payments |
| Day-by-day reconciliation with `GET /v1/transfers` | D6 makes an orphan link impossible, and D12 follows every link we issued |
| A deposit confirmation sent to the customer after Devolada confirms a deposit | The seller sees «Pago confirmado» on the sale, and Turistear sends no WhatsApp by itself (FR-008). `depositVerifiedWhatsAppUrl` (bug `verify-send-empty-link`) is ready if a send is wanted |
| A QR of the link on the seller's screen | Dropped by the 2026-10-06 clarification. If it comes back, the Express "Mostrar QR" overlay (`app:features/pos/components/ExpressTicketOverlay.tsx:26`) is the pattern |

### D21 — Each link is followed with the key that created it

- **Decision**:
  - Every API key the organization connects is a row of `devolada_credentials`, encrypted as D1 says. The connection points to its current credential, the one new links use. Each link records its credential (`devolada_links.credential_id`): the one that created it, until the fallback below moves the link to the current one.
  - Every call about a link uses that link's credential: the webhook's re-read (D4), the sweep's checks (D12), closing it (D13) and replaying an abandoned create. Only new links use the current credential.
  - Replacing the key, for the same business or another one, retires the previous credential. So does disconnecting. A retired credential is kept while a link that uses it is unresolved, a closed link whose payment is still in flight included (data-model), and the sweep erases it after (D12). Decided by the developer on 2026-10-15: the admin may switch Devolada accounts at any time, and every payment is followed to its verdict.
  - **When a link's retired credential is rejected** (`AUTHENTICATION_ERROR`, a revoked key) on any call about the link (a re-read, a close or a replay), the system asks the current credential for that link with `GET /v1/payment-links/{id}`:
    - if it can read it, as after a rotation within the same business, the link moves to the current credential;
    - if no credential can read it, the link becomes `failed`, and its payment keeps its last known state.
      - A sale or deposit link leaves its payment row pending, so the sale waits in Por verificar, «Sin enlace de pago — verificar a mano». A deposit keeps its apartado alive until the admin decides (D8).
      - A settlement link whose payment was in flight becomes an attention item the admin *accepts* or *dismisses* (D15), and the apartado waits for that decision (D8).
      - A `closing` or `closed` link becomes `failed` too: its sale had already stopped taking that money, and a payment still in flight on it can no longer be followed. So the previous account's key stays valid at Devolada until its links finish; if it is revoked anyway, a cancelled sale has nothing left to follow (spec clarification of 2026-10-16).

      D11 never cancels a sale over a link that no credential can read.
  - **A suspended business is not a rejected key.** `BUSINESS_SUSPENDED` on a retired credential's call changes nothing: a suspension may be lifted, so those links are retried at the next run, and the connection, which belongs to the current key, is untouched. *(Amended 2026-10-15 by /speckit-analyze.)*
  - **The current credential never takes the fallback.** When Devolada rejects it, the connection becomes `broken` (FR-005), and every link that uses it waits as it is: asking the current credential again would only fail again, and would mark `failed` links the admin's next key can still read. Once the admin replaces the key, the old one is retired, and the fallback can move those links to the new one. *(Amended 2026-10-16 by /speckit-analyze.)*
  - The webhook's mode check compares the event with the link's own `mode`, copied from its credential (D4).
- **Rationale**:
  - Devolada v1 does not say which business a key belongs to (Requests to Devolada, 1), so the system cannot tell a key rotation from a switch to another business.
  - A link read with another business's key answers `NOT_FOUND`, and a list by `customerRef` answers empty. With one key per organization, a switch would leave every pending verdict unapplied, and D9 would read an unpaid link and cancel a sale the customer had paid.
  - Following each link with its own key makes a switch safe at any time. It also lets a disconnected organization's links keep clearing by notification, not only by the sweep (FR-004).
- **Alternatives considered**:
  - Refusing a switch while the previous business has unresolved links: simpler, but the admin waits up to 24 hours. Rejected by the developer on 2026-10-15.
  - Handing the previous business's links to the admin to verify by hand: nothing blocks, but every pending sale costs manual work. Rejected by the developer on 2026-10-15; it remains the fallback when no key can read a link.
  - One credential per Devolada business, keyed by its id: needs `GET /v1/me` (Requests to Devolada, 1).

## Requests to Devolada

Devolada is our own product (`leolicona/devolada`), so these are cheaper to add there than to work around here:

1. `GET /v1/me` → `{businessId, mode, channelReady}`. Replaces the D2 probe, and lets D21 tell a key rotation from a switch to another business.
2. `businessId` in webhook events. Routing without a lookup.
3. More than one notification address per business, or a callback per link. Removes the D3 conflict.
4. Link lifecycle events (`link.expired`, `link.closed`). D12 currently infers expiry from our own clock.

## Defects found on the way (not fixed by this feature)

Each should go through the lite path (`/speckit-bug-assess`). This feature guards its own paths against them.

1. `verifyPayment` succeeds on a rejected or swept sale (no `cancelled_at` check). `routes/pos/handler.ts:2779-2803`.
2. `rejectPayment` erases a cash or verified deposit with no refund owed. `routes/pos/handler.ts:3104-3112`.
3. `rejectPayment` releases seats for lines already cancelled and has no not-cancelled guard. `routes/pos/handler.ts:3015-3089`.
4. `sweepExpiredBookings` cancels apartados whose transfer deposit is still pending, and credits money that was never received. `routes/pos/sweep.ts:146-158`; asserted as current behaviour at `test:folios/cancel-unverified-guard.test.ts:184-209`. This feature keeps the sweep away from every deposit a link collects: it skips an apartado whose deposit, collected by a link, is not verified yet, whatever happened to the link (D8).
5. A rejected or swept transfer stays `pending` forever, like the production payment of 2026-07-31. `routes/pos/handler.ts:3025-3113`.
6. A pending full transfer sale enqueues a `tickets_delivered` WhatsApp row at checkout. `routes/pos/handler.ts:1953-1958`.
7. `FolioReceiptPage` shows «Venta confirmada», «Pagado» and «Folio {id}» for an unverified transfer. `app:pages/FolioReceiptPage.tsx:74-85, 143-148`. Fixed here only on the surfaces this feature touches (D16).
8. `wa_reminder_template` is edited in Ajustes but never read. `app:features/bookings/components/BookingWhatsAppButton.tsx:39-51`.
9. Nothing type-checks the API (no `tsc` in CI), and 20 error codes in use are missing from `ErrorCode` (27 on 2026-10-06; the retired affiliate and operator codes left with their routes). `src/types/errors.ts:1-36`.
10. Unstubbed outbound calls in API tests reach the real provider (Resend), with the test key `vitest.config.ts` pins, so nothing is delivered. For example, `test:pos/payment-verification.test.ts` does not call `stubResend`.
11. The `payment_rejected` customer message, which D11 reuses, says «tu folio…» where constitution VII says «Venta»; so does the approved-cancellation message just above it. `src/utils/notifications.ts:74-81`. Because D11 newly sends `payment_rejected`, this one goes through the lite path **before PR 2** ships, not after the feature (T077).
12. The `link` payment method, hidden at checkout (US-AG41 D1), reads «Link de pago» in its labels and «enlace» in the timeline: two words for one concept, and «link» is a word this feature never uses (D16, constitution VII). `app:features/cash/components/paymentPresentation.ts:4-8`, `app:pages/FolioReceiptPage.tsx:39`, `app:features/pos/components/PaymentBreakdown.tsx:16`, `app:features/folios/components/FolioTimeline.tsx:58`. Its fix names the method; that name must not be «Enlace de pago», which this feature gives the Devolada enlace.
