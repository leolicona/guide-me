# Research: Automatic Transfer Verification with Devolada

**Feature**: `specs/001-devolada-transfer-verification` · **Phase**: 0 of `/speckit-plan` · **Date**: 2026-10-06

Every decision below is numbered `D<n>` and carries its *why*. Code that implements one cites it in a
comment as `devolada-transfer-verification D<n>` (constitution I).

**Sources**:
- the spec;
- constitution v1.0.0;
- Devolada's v1 contract (`contracts/devolada-collections-v1.openapi.yaml`);
- a read of the code on 2026-10-06.

Paths are relative to `api-turistear/src/` unless prefixed `app:` (`app-turistear/src/`) or `test:`
(`api-turistear/test/`).

## What the code does today — the facts the decisions rest on

| Fact | Where | Consequence |
|---|---|---|
| A transfer sale writes a `pending` ledger row **and** its allocations at confirm, so it derives `paid` at once. QR, portal token and ticket email wait for clearance | `routes/pos/handler.ts:1491-1510, 1803, 1895-1912, 2008-2048` | Full sales and deposits keep today's money model. Devolada only changes *who* clears them |
| `verifyPayment` flips **every** pending row of the sale, needs `c.get('user')` and `c.executionCtx`, and never checks `cancelled_at` | `routes/pos/handler.ts:2882-3091` (flip at 2921-2931) | A per-payment core without a request context is needed (D10) |
| `rejectPayment` is hand-written. It fully reverses the money (`buildCancellationReversal`, clawback) and releases seats for **all** lines, cancelled ones included, with no guard. It leaves `cancellation_source` NULL and the payment rows `pending` forever | `routes/pos/handler.ts:3096-3221`, `utils/folioPayments.ts:217` | The automatic cancellation must not inherit this (D11) |
| A settlement writes its row and allocations when settled. **Nothing in the code can undo a settlement**, and settling never clears the line clock | `routes/pos/handler.ts:2220-2569, 2577-2800` | An unpaid settlement can't be "withdrawn" without new ledger semantics, so it is recorded only once proven (D8) |
| Status derives from allocations whatever their verification | `utils/folioStatus.ts:16-29` | Same as above |
| Every manual cancel path refuses a sale whose transfer is unverified (`PAYMENT_UNVERIFIED`); the expiry sweep does not | `routes/folios/handler.ts:912-918, 1221-1227`; `routes/pos/handler.ts:2828-2834, 3264-3270`; `routes/pos/sweep.ts:41` | While a sale or deposit link waits, what the sale owes cannot change; the sweep needs a guard (D8, D13) |
| Public routes are routers that never `use(authMiddleware)`. No route reads the raw body, and there is no body limit | `index.tsx:43-77`, `routes/auth/index.ts:25` | The webhook is its own router reading `c.req.text()` (D4) |
| Outbound HTTP has no timeouts. Tests stub it with `vi.spyOn(globalThis, 'fetch')`; unstubbed calls reach the real provider | `services/resend.ts`; `test:auth/admin-registration.test.ts:13-40` | One Devolada module with explicit timeouts; a fake Devolada behind the same spy, on a host that cannot resolve (D5, D17, D18) |
| `QR_SECRET` is the one app secret, split by HMAC labels. Nothing is encrypted at rest | `utils/qr.ts:84-107`, `utils/operatorSession.ts:41-57` | A dedicated key and AES-GCM for the credential (D1) |
| `GET /organizations/me` is readable by every role, shift operators included | `routes/organizations/index.ts:21-31` | The credential never enters the organization payload (D1) |
| One cron trigger runs two independent `waitUntil` sweeps | `index.tsx:83-116`, `wrangler.jsonc:63-65, 106-108` | A third independent sweep (D12) |
| Migrations are hand-written; the highest is `0068` | `api-turistear/migrations/` | This feature claims `0069` |

## Decisions

### D1 — Credential custody

- **Decision**:
  - A new table, `devolada_connections`, holds one row per organization. The credential is stored there encrypted with AES-256-GCM.
  - The key is derived per organization as `HMAC-SHA256(DEVOLADA_CREDENTIAL_KEY, "guideme:devolada:v1:" + organizationId)`, the label pattern of `utils/qr.ts:84-107`.
  - The organization id is also bound as GCM additional data, and every write uses a fresh 96-bit IV.
  - `DEVOLADA_CREDENTIAL_KEY` is a new Worker secret, different in each environment.
  - The API only ever returns a hint: the last four characters.
  - The organization payload carries a non-secret summary, `devolada: {status, mode}`, and never a credential column.
- **Rationale**:
  - FR-003: reading the database alone must not reveal the credential.
  - Constitution VIII: secrets live in Worker secrets and are never shared across environments.
  - Constitution III: ciphertext copied into another organization's row fails to decrypt.
  - `GET /organizations/me` answers every role, so a credential there would reach agents and operators.
- **Alternatives considered**:
  - A plaintext column fails FR-003.
  - `QR_SECRET` with a new label ties the two rotations together: rotating the ticket key would make every stored credential unreadable.
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

  3. **Mode policy**: `DEVOLADA_KEY_MODE` is `real` in production and `test` in dev and local. A credential of the other mode gets `DEVOLADA_MODE_NOT_ALLOWED`.
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

### D3 — Who owns the notification address

- **Decision**:
  - After the probe, the server calls `GET /v1/webhook`:
    - 404 → it registers our address with `PUT`;
    - the same URL → it keeps it;
    - a different URL → it refuses with `DEVOLADA_WEBHOOK_CONFLICT` (409, whose message is the current URL). Only when the request says `replace_webhook: true` does it `PUT` ours and record the replaced address.
  - Our address is the environment's `DEVOLADA_WEBHOOK_URL` (D17), not one derived from `API_BASE_URL`: the local profile sets `API_BASE_URL` to production's URL (`wrangler.jsonc:40-50`).
  - Where `DEVOLADA_WEBHOOK_URL` is empty (local), no address is registered and verdicts arrive only through the sweep (D12).
  - Disconnecting does **not** remove Devolada's address.
- **Rationale**:
  - FR-006. Devolada keeps one address per business, shared by real and test credentials.
  - A silent `PUT` would break anything else the business integrates, or let a dev environment take production's address.
  - Keeping the address after a disconnect preserves FR-004: links already issued are followed to their verdict (D12 follows them anyway).
- **Alternatives considered**:
  - A per-organization URL (`/webhooks/devolada/:orgId`) proves nothing, because the signature covers the whole platform. Constitution III also forbids taking the organization from a path.
  - Deleting the address on disconnect would cut off verdicts for links still open.

### D4 — Trusting a webhook

- **Decision**: `POST /api/webhooks/devolada` is a router with no auth middleware. It handles each request in this order:
  1. Refuse bodies over 64 KiB, then read the raw body with `c.req.text()`.
  2. Verify `Devolada-Signature` (`v1=`, base64url, raw `r‖s`): ECDSA P-256 / SHA-256 over `` `${Devolada-Timestamp}.${raw}` `` with the JWK whose `kid` equals `Devolada-Key-Id`.
     - The JWKS is cached per isolate by `kid`; an unknown `kid` refetches once, as the contract says.
     - Failure → 401 `WEBHOOK_SIGNATURE_INVALID`.
  3. Parse the body with Zod → 400 `WEBHOOK_PAYLOAD_INVALID`.
  4. Find our link by `data.paymentLinkId`. This is a globally unique key, the one kind of lookup constitution III exempts from actor scoping. An unknown link → 200, logged, nothing stored, because there is no organization to scope a row to.
  5. Check the mode: `data.isTest` must match the connection's mode. Otherwise → 200, recorded as `mode_mismatch`.
  6. De-duplicate on `eventId` (a `devolada_events` row). An event whose earlier processing failed is processed again.
  7. Re-read `GET /v1/payments/{paymentId}` **with the owning organization's credential**, and apply D9 to the re-read, never to the body.
  8. Answer:
     - 200 when done;
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
  - `services/devolada.ts` is the only code that calls Devolada.
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
  - Writing our row before calling makes an orphan link impossible. A timed-out create is replayed with the same key within 24 hours to learn whether the link exists, and is then closed (D12).
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
  - `customerRef` = folio id, so every link of a sale shares the customer's Devolada reference.
- **Rationale**:
  - The spec's Assumptions: 24 hours or the first service, never past it.
  - Keeping a deposit or settlement link inside the apartado's own clock means the expiry sweep never meets an apartado whose transfer link is still open. It is also guarded (D8).
- **Alternatives considered**:
  - No expiry: a link could be paid weeks later for a seat released long before.
  - The apartado clock alone: links would stay open for days, while FR-016 needs a near decision.

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
    | `operator_id` | as recorded on the link |
    | date | the verdict |

    It then runs the release core (D10) if the sale is now paid and cleared.
  - **An unpaid settlement link** simply closes.
  - **The expiry sweep** skips a sale with an open link or a payment in flight.
  - **One bypass**: a settlement whose payment was in flight when the apartado's clock ran out is still recorded. The `BOOKING_EXPIRED` pre-check is skipped for that case only.
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
  - It is keyed on `(devolada_payment_id, status)`, so applying it twice changes nothing and a final status never goes back.
  - It never cancels on the clock alone. The unpaid branch requires a successful re-read showing no payment in flight.

  | Devolada status | Sale or deposit link | Settlement link |
  |---|---|---|
  | `validating` | snapshot; the sale shows «Validando pago» | same |
  | `queued_for_credit` | snapshot; connection health shows «Validaciones en pausa» | same |
  | `validating` + `awaiting: payer_tracking_key` | snapshot; seller and admin see «Pide al cliente su clave de rastreo»; no expiry while it waits | same |
  | `confirmed` | verify that payment row (D10); the receipt number becomes its reference; link `paid` | record the settlement (D8); link `paid` |
  | `partial`, `invalid` | snapshot; the sale stays pending, so it shows in Por verificar with asked and received amounts and its label; the admin uses Verificar or Rechazar as today (FR-018) | link closed; an attention item the admin *accepts* (records the settlement as the admin) or *dismisses* (the apartado continues) (D15) |
  | `expired`, or the link expired with nothing in flight | FR-016 system cancellation (D11) | link `expired`; the apartado continues |
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
  - The sale's `payment_verification` becomes `verified` only when no pending row remains.
  - Release runs when the sale is paid, cleared and not cancelled.
  - The admin endpoint calls the same cores with `'all'`, so its behaviour does not change.
  - `deps` = `{db, env, waitUntil}`, following the precedent of `queueCancellationEmail({env, executionCtx})` (`routes/folios/handler.ts:822`).
- **Rationale**:
  - Story 3 scenario 4: a pending deposit and a confirmed settlement are separate facts.
  - The webhook has no request context.
  - Flipping every row is right for an admin who verifies a sale, and wrong for a provider that proves one transfer.
- **Alternatives considered**:
  - A second copy of the release code: two paths that drift.
  - Calling the HTTP endpoint as a system user: there is no system user, and `verified_by` must stay NULL («Sistema»).

### D11 — Cancelling when the money never arrived

- **Decision**: `cancelForUnreceivedTransfer(deps, {organizationId, folioId, linkId, at})` runs four steps:
  1. **Claim the link**: `UPDATE devolada_links SET state = 'expired' WHERE id = ? AND state = 'open' RETURNING`. One worker wins.
  2. **Check the sale**: go on only if the sale is not cancelled **and** the link's row is its only positive money. Otherwise raise an attention item. A sale holding any other money is never cancelled automatically.
  3. **One `db.batch`**:
     - the sale and its live lines are cancelled (`WHERE cancelled_at IS NULL`), with `cancellation_source = 'payment_not_received'` (new value) and the reason «No se recibió la transferencia»;
     - the reversal from `buildCancellationReversal`, with clawback;
     - seats and reservations released **for live lines only**;
     - the event `transfer_not_received`, with a NULL actor.
  4. **After the batch**: the `payment_rejected` notification, then the link is closed at Devolada (D13).

  The seat and reservation release statements are extracted from `rejectPayment` into a builder both use. The admin's Rechazar is otherwise untouched.
- **Rationale**:
  - FR-016 says "the way Rechazar cancels", but without Rechazar's defects: it releases seats for lines already cancelled, has no not-cancelled guard, and would erase a cleared deposit (`routes/pos/handler.ts:3096-3221`).
  - A separate `cancellation_source` keeps these out of the expired-apartado counts (`system_expiry`).
  - A concurrent manual Rechazar within the same instant remains a small race. That path has no guard of its own, and its fix is defect 3 below.
- **Alternatives considered**:
  - `cancelFolioPriced` prices by the cancellation policy, which is wrong for money that never arrived (the BUG-030 reasoning, `routes/folios/handler.ts:908-911`).
  - Calling `rejectPayment` as it is inherits its defects.

### D12 — The recovery and expiry sweep

- **Decision**:
  - `sweepDevoladaPayments(env, now)` lives in `routes/devolada/sweep.ts` and runs as a third independent `ctx.waitUntil` in `scheduled()`, with `now = new Date(controller.scheduledTime)`.
  - Each run covers every connected organization, plus every disconnected one that still has open links. It is fail-soft per sale and does four things:
    1. Sales with a link that is `open` and either unchecked for 10 minutes or past `expires_at` get `GET /v1/payments?customerRef=<folioId>`, one call covering all the sale's links, and D9 for each payment.
    2. Links past expiry with no payment in flight or confirmed take D9's unpaid branch.
    3. Links in the remaining states are retried:
       - `abandoned`: replay the create with the same key; if the link exists, close it;
       - `closing`: send `PATCH {close: true}` until Devolada acknowledges.
    4. A disconnected organization with no unresolved link has its credential erased.
  - Budget: at most 50 Devolada calls per organization per run (the limit is 120 a minute, shared with live traffic). `RATE_LIMITED` stops that organization until the next run.
- **Rationale**:
  - FR-012; SC-003 (at most 15 minutes to the next run plus 10 to the recheck stays under 30); SC-009; FR-004.
  - It mirrors `sweepExpiredBookings` (`routes/pos/sweep.ts:41`): it needs only `env`, is fail-soft, and is tested by calling it with an explicit `now` (dates are frozen in tests, `test:helpers/apply-migrations.ts:28-34`).
  - Taking `now` from `scheduledTime` lets local validation advance the clock with the `?time=` parameter of `/cdn-cgi/local/scheduled`.
- **Alternatives considered**:
  - Devolada's `GET /v1/transfers` lists only money that arrived, not waits or expiries.
  - A Queue or Durable Object alarm per link adds new bindings for a guarantee the 15-minute cron already gives.

### D13 — Closing links

- **Decision**:
  - Every write that stops a sale from taking a payment marks that sale's open links `closing` **in the same batch**:
    - `cancelFolioPriced` and `cancelFolioLinesPriced`, which cover admin, agent and tourist cancellations, line cancellations and the expiry sweep;
    - `rejectPayment`;
    - D11;
    - a cash settlement while a settlement link is open.
  - After the write, the handler closes them at Devolada (`PATCH {close: true}`) under `waitUntil`. The sweep retries until Devolada acknowledges.
  - When a line cancellation changes an apartado's balance while its settlement link is open, a replacement settlement link (D6) is issued and returned.
- **Rationale**:
  - FR-011 and Story 4.
  - Marking inside the batch keeps the link's state consistent with the money; the HTTP close stays outside it (VIII).
  - Only settlement links ever need a replacement. A sale or deposit with a pending transfer cannot change what it owes, because every manual cancel path refuses it with `PAYMENT_UNVERIFIED`.
- **Alternatives considered**:
  - Closing synchronously inside the cancellation: a Devolada outage would block cancellations, against VIII.
  - Not closing: a customer could pay a cancelled sale. That money surfaces as `unapplied` (D9), but preventing it is cheaper.

### D14 — Read model, queue and counts

- **Decision**:
  - **Sale reads**: `readFolioDetail` gains `payment_links[]`, and list rows gain `payment_link` (contracts/turistear-api.md § PaymentLinkView). Each carries the kind, state, amount, URL, expiry, the latest payment's facts, and a `label` code decided by the server. The client only maps codes to copy.
  - **Pending work**: the pending-work set (`utils/folioPendingWork.ts`) gains the Devolada attention items, so the «Por verificar» facet lists them whatever their age.
  - **Counts**: `GET /api/folios/counts` gains:
    - `verification_auto`: pending sales whose open Devolada link needs no action;
    - `devolada_attention`: actionable Devolada items.

    The admin badge becomes `verification − verification_auto + devolada_attention + folio_requests`.
  - **Organization**: `GET /api/organizations/me` gains `devolada: {status, mode}`.
  - **Indexes**: every correlated read is backed by an index led by `(organization_id, folio_id)`.
- **Rationale**:
  - FR-015, SC-004, and constitution IV: the server decides the label, the client mirrors it.
  - SC-001 needs the badge to stop counting sales Devolada is handling.
  - BUG-042: `EXPLAIN QUERY PLAN` must show no `SCAN` inside a correlated subquery.
- **Alternatives considered**:
  - Labels derived in the client: a second source of truth.
  - Dropping Devolada sales from `verification`: changes the meaning of an existing count under existing tests.

### D15 — The admin resolves Devolada exceptions

- **Decision**: `POST /api/devolada/payments/:id/resolve` (admin) takes an `action`:

  | Action | For | Effect |
  |---|---|---|
  | `accept` | a settlement exception | records the settlement as the admin; `verified_by` = admin |
  | `dismiss` | a settlement exception | closes it; the apartado continues |
  | `returned` | an `unapplied` payment | the admin returned the money outside the system |

  Sale and deposit exceptions keep using today's Verificar and Rechazar. When those are used, the link is closed (D13).
- **Rationale**:
  - FR-015 and FR-018: the admin can always decide by hand.
  - Under D8 a settlement exception has no pending row for Verificar to flip.
- **Alternatives considered**:
  - Reusing `/verify` and `/reject` for settlement exceptions: they act on pending rows that don't exist here, and Rechazar cancels the sale, against FR-016's principle.

### D16 — Frontend surfaces and copy

- **Decision**:
  - **Ajustes**: a card «Cobro con Devolada» after «Punto de venta» (`app:pages/SettingsPage.tsx:668-728`).
    - It shows the status chip, mode, key hint and health.
    - Connecting or replacing the key happens in a `FormSheet`; replacing the address and disconnecting use `ConfirmSheet`.
    - While connected, the reference switch says it applies only without Devolada.
  - **Checkout and SettleSheet**: when `devolada.status` is `connected`, the Referencia field is not offered and the consequence line announces the link.
    - The transfer fields move into `features/pos/components/TransferPaymentFields.tsx` so they can be tested. Constitution VI does not allow tests of `pages/`.
  - **Receipt, sale detail and BookingActions**: a `PaymentLinkCard` with:
    - the amount, «Vence a las HH:MM» and a status chip;
    - the primary action «Enviar liga por WhatsApp» (`paymentLinkWhatsAppUrl` in `features/pos/delivery.ts`, with a default template);
    - polling every 15 s while the link waits.

    The receipt stops saying «Venta confirmada» and «Pagado» while the money is unverified.
  - **Por verificar**: FolioCard and FolioWorkActions show the labels and amounts. The timeline adds the new event types to its three exhaustive records, and AppLayout uses the new badge sum.
  - **Copy**: the table in `contracts/turistear-api.md` § Labels.
- **Rationale**:
  - FR-008 and FR-022.
  - Constitution VII: primitives first, «Venta» never "folio", every state paired with an icon and text.

### D17 — Environments and configuration

- **Decision**:
  - **Vars**, repeated in every wrangler profile because named environments inherit none (`wrangler.jsonc:13-15`):
    - `DEVOLADA_API_BASE_URL` = `https://api.devoladapago.com` in every profile. Dev uses Devolada's production API with test credentials, which is the contract's test mode.
    - `DEVOLADA_KEY_MODE` = `real` in production, `test` in dev and local.
    - `DEVOLADA_WEBHOOK_URL` = `https://api.turistearya.com/api/webhooks/devolada` in production, `https://api-dev.turistearya.com/api/webhooks/devolada` in dev, empty in local. Devolada cannot reach a laptop, and local `API_BASE_URL` points at production (D3).
  - **Secret** `DEVOLADA_CREDENTIAL_KEY`: 32 random bytes, base64, set per environment with `wrangler secret put`. Locally it lives in `.dev.vars`, documented in `.dev.vars.example`.
  - **Tests** pin all four in `vitest.config.ts`: `DEVOLADA_API_BASE_URL = https://devolada.test`, so an unstubbed call fails instead of reaching Devolada, and `DEVOLADA_WEBHOOK_URL = https://api.test/api/webhooks/devolada`.
  - **Bindings** go in `src/bindings.d.ts`, followed by `pnpm cf-typegen:api`.
- **Rationale**:
  - Constitution VIII: no shared secrets, and none in the repository.
  - The test pin closes the gap the infrastructure read found: unstubbed calls reach the real provider.
- **Alternatives considered**: Devolada's shared dev environment is Devolada's own playground; test mode on its production API is what the contract offers integrators. The var keeps either one open.

### D18 — Tests

- **Decision**:
  - **API** (workerd, real D1):
    - A stateful fake Devolada in `test:helpers/devolada.ts`, behind `vi.spyOn(globalThis, 'fetch')` for `https://devolada.test`. It covers links, payments, the test-mode advance, the notification address, a generated P-256 key pair served as JWKS, and a builder for signed webhook requests.
    - Suites in `test:devolada/`: connection, checkout-link, webhook, verdicts, apartados, link-closing, sweep, isolation, credential-cipher and signature.
    - Each file cites `devolada-transfer-verification US<n>`, and every new route has `seedTwoOrgs` cases.
  - **App**: tests for DevoladaConnectionCard, PaymentLinkCard, TransferPaymentFields, the SettleSheet connected mode and the FolioCard labels, each with `expectNoA11yViolations`. MSW handlers live in `app:test/handlers/devolada.ts`.
  - **Scope boundary**: `test:pos/payment-verification.test.ts`, `test:pos/optional-payment-reference.test.ts` and `test:paid-ledger/settle-method.test.ts` pass unedited.
- **Rationale**: constitution VI. Rules are proven in the API, and stand-ins sit at the provider's boundary.

### D19 — Delivery

- **Decision**: three PRs to `develop`, each deployable.

  | PR | Stories | Contents |
  |---|---|---|
  | 1 | Story 1 | migration 0069 (all four tables); D1–D7; D9 for `validating` and `confirmed`; D10; D12 recovery; D14; D16 for Ajustes, checkout and receipt; D17; the constitution amendment |
  | 2 | Stories 2 and 3 | the rest of D9; D8; D11; D15; the sweep guard; queue labels and counts |
  | 3 | Story 4 | D13 |

  Between PR 1 and PR 2, an exception or an unpaid link leaves the sale in Por verificar for the admin, exactly as today.
- **Rationale**:
  - The spec makes each story independently testable.
  - The migration is additive, so tables created in PR 1 sit harmlessly unused until PR 2 uses them.

### D20 — What we deliberately leave out, and why that is safe

| Left out | Why it is safe |
|---|---|
| An organization-specific WhatsApp template for the link | The default message covers the need, and Ajustes already hosts templates when one is wanted |
| Re-issuing a link after a fallback | The sale is on today's manual path, which works |
| Automatic refunds of `unapplied` or overpaid money | The admin is alerted with the amounts (D9, D15), and transfers are 0.5% of payments |
| Day-by-day reconciliation with `GET /v1/transfers` | D6 makes an orphan link impossible, and D12 follows every link we issued |
| A QR of the link on the seller's screen | Dropped by the 2026-10-06 clarification. If it comes back, the Express "Mostrar QR" overlay (`app:features/pos/components/ExpressTicketOverlay.tsx:26`) is the pattern |

## Requests to Devolada

Devolada is our own product (`leolicona/devolada`), so these are cheaper to add there than to work around here:

1. `GET /v1/me` → `{businessId, mode, channelReady}`. Replaces the D2 probe.
2. `businessId` in webhook events. Routing without a lookup.
3. More than one notification address per business, or a callback per link. Removes the D3 conflict.
4. Link lifecycle events (`link.expired`, `link.closed`). D12 currently infers expiry from our own clock.

## Defects found on the way (not fixed by this feature)

Each should go through the lite path (`/speckit-bug-assess`). This feature guards its own paths against them.

1. `verifyPayment` succeeds on a rejected or swept sale (no `cancelled_at` check). `routes/pos/handler.ts:2882-2906`.
2. `rejectPayment` erases a cash or verified deposit with no refund owed. `routes/pos/handler.ts:3207-3215`.
3. `rejectPayment` releases seats for lines already cancelled and has no not-cancelled guard. `routes/pos/handler.ts:3118-3192`.
4. `sweepExpiredBookings` cancels apartados whose transfer deposit is still pending, and credits money that was never received. `routes/pos/sweep.ts:146-158`; asserted as current behaviour at `test:folios/cancel-unverified-guard.test.ts:184-209`.
5. A rejected or swept transfer stays `pending` forever, like the production payment of 2026-07-31. `routes/pos/handler.ts:3128-3216`.
6. A pending full transfer sale enqueues a `tickets_delivered` WhatsApp row at checkout. `routes/pos/handler.ts:2053-2058`.
7. `FolioReceiptPage` shows «Venta confirmada», «Pagado» and «Folio {id}» for an unverified transfer. `app:pages/FolioReceiptPage.tsx:74-85, 143-148`. Fixed here only on the surfaces this feature touches (D16).
8. `wa_reminder_template` is edited in Ajustes but never read. `app:features/bookings/components/BookingWhatsAppButton.tsx:39-51`.
9. Nothing type-checks the API (no `tsc` in CI), and 27 error codes in use are missing from `ErrorCode`. `src/types/errors.ts:1-39`.
10. Unstubbed outbound calls in API tests reach the real provider (Resend). For example, `test:pos/payment-verification.test.ts` has no stubs.
