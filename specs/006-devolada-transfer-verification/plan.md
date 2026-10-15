# Implementation Plan: Automatic Transfer Verification with Devolada

**Branch**: `claude/flujo-pago-referencia-nlndbe` (spec folder `specs/006-devolada-transfer-verification`)
| **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-devolada-transfer-verification/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

An organization connects its own Devolada account. From then on, its transfers are cleared by
Banxico's verdict, which Devolada reports, instead of by an admin. The approach, all from
[research.md](./research.md):

- **Credential**: stored encrypted, one per organization, and never in the organization payload
  that every role reads (D1). Connecting probes the credential, learns its mode and checks the
  notification address before taking it (D2, D3).
- **Links**: each transfer gets a one-time Devolada link, issued *after* the sale's money
  write commits, with today's manual path as the fallback (D6, D7). A link that would stay open less
  than 15 minutes is not issued (D7). A settlement is a link too, and
  is recorded only once proven. This is the one place the design departs from today's flow: nothing
  in the code can undo a settlement (D8).
- **Verdicts**: they arrive two ways.
  - A signed webhook. It is verified, routed by the link's global id, then **re-read with the
    owning organization's own credential** before anything changes (D4).
  - A 15-minute recovery sweep on the existing cron (D12).
- **Applying a verdict** (D9):
  - *confirmed* → verifies one ledger row, through cores extracted from `verifyPayment` (D10).
  - Money that never arrived → cancels the sale through a guarded system cancellation, with none of
    `rejectPayment`'s defects (D11).
  - Everything else → reaches Por verificar or the seller, labelled by the server (D14, D15).
- **Por verificar holds only work for the admin**: a sale Devolada is still resolving stays out of it, and out of its count, until the admin has something to do (D14; spec clarification of 2026-10-15).
- **Closing links**: links close whenever their sale stops taking money, but never under a payment in flight while the sale lives (D13; spec clarification of 2026-10-15).

Delivery is three PRs, one per story group (D19).

**Spec amendment made while planning**: FR-016 and Story 2 scenario 4 now say an unpaid settlement
leaves the sale an apartado, rather than one "returned" to it (D8).

**Re-baselined against `main` on 2026-10-15** (research § Re-baseline): Better Auth, the retirement
of affiliates and shift operators, the one-branch delivery pipeline with previews and secrets in
GitHub environments, and bug `verify-send-empty-link`. This folder moved to `specs/006-…`, and the
migration to `0073`. D17 and D19 are rewritten, D16 gains per-kind link messages, and the decisions
otherwise stand.

## Technical Context

**Language/Version**: TypeScript (ESM), Node 22 toolchain; Cloudflare Workers runtime, `compatibility_date` 2025-08-03

**Primary Dependencies**:
- **API**: Hono ^4.12, `@hono/zod-validator` ^0.8, Zod ^4.4, Drizzle ORM ^0.45 on D1.
- **Platform crypto**: WebCrypto. ECDSA P-256 verify for webhooks, AES-256-GCM for the credential, and HMAC-SHA256 as the key-derivation function, as in `utils/qr.ts`.
- **App**: React 19, MUI 9, TanStack Query 5, React Hook Form 7 + Zod 4.
- **Auth**: Better Auth 1.7.7, unchanged by this feature. Admin routes use `authMiddleware` and `requireRole('admin')`; the webhook is the one route of ours without a session.
- **No new npm dependency.**

**Storage**:
- **Database**: Cloudflare D1 (`guideme-db` for dev and every preview, `guideme-db-prod`). Migration `0073` adds four tenant-scoped tables ([data-model.md](./data-model.md)). It reaches dev's D1 with PR 1's preview, before the merge.
- **Secrets**: new secret `DEVOLADA_CREDENTIAL_KEY`, kept in the GitHub environments `dev` and `production` and planted by every deploy. A preview gets dev's value or none, never a throwaway (D17).

**Testing**:
- **API**: Vitest 4 with `@cloudflare/vitest-pool-workers` 0.16, in workerd against a real D1. Requests authenticate with Better Auth fixture sessions (`sessionCookie(email)`). A stateful fake Devolada sits behind `vi.spyOn(globalThis, 'fetch')` on an unresolvable host, and composes with `stubResend`.
- **App**: jsdom, Testing Library, MSW 2 and axe.

**Target Platform**:
- **Workers**: `api-guideme` (production, from `v*` tags) and `api-guideme-dev` (every push to `main`), both with the cron `*/15 * * * *`. Each pull request also gets `api-guideme-pr-<n>` on `workers.dev`, on dev's D1, with no cron and no Devolada notification address.
- **Devolada**: collections API v1 at `https://api.devoladapago.com`. Real credentials in production; test credentials in dev, previews and local.

**Project Type**: web service + web app (pnpm monorepo: `api-turistear`, `app-turistear`)

**Performance Goals**:

| Goal | How it is met |
|---|---|
| SC-002: tickets released ≤ 2 min after the verdict (QR signed, email sent, WhatsApp unlocked) | The webhook path is one re-read plus the release, a few seconds |
| SC-006: checkout gains ≤ 5 s | Link creation has a 3 s timeout, then fallback |
| SC-003: a lost verdict is applied ≤ 30 min later | The sweep runs every 15 min, re-checks a link after 10 min, and takes the oldest first; it holds up to 50 due links per organization per run (D12) |
| SC-009: seats back on sale ≤ 30 min after expiry, while Devolada answers | Same sweep; during an outage nothing is cancelled (D9) |

**Constraints**:
- **Devolada rate limit**: 120 requests/min per business, shared by real and test traffic. The sweep spends at most 50 per organization per run.
- **Webhook deadline**: the webhook must answer within 10 s.
- **D1 has no interactive transactions** (constitution V): guarded single statements, then `db.batch`.
- **D1 reads are metered**: indexed correlated reads only (BUG-042).
- **Mode policy per environment**: production real, elsewhere test.
- **External calls stay outside money writes** (constitution VIII).

**Scale/Scope**:
- **Production today** (read 2026-10-06): 2 organizations; 5 transfers in 75 days, 0.5% of payments.
- **Design target**: ≤ 200 links per organization per day.
- **Work**: 4 new tables, 5 new endpoints (4 admin, 1 public webhook), 3 cores extracted from existing handlers, 1 new sweep, 1 new frontend feature module, about 20 frontend files touched.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Before research | After design | Evidence |
|---|---|---|---|---|
| I. Spec-Driven, Every Decision Cited | Spec, plan and numbered decisions with a why; a mechanical scope boundary; amended in place | PASS | PASS | Decisions D1–D20 ([research.md](./research.md)). Code cites `devolada-transfer-verification D<n>`; tests cite `US<n>`. The scope boundary is three named suites, unedited (spec Context; [quickstart.md](./quickstart.md) §1). FR-016 amended in place (D8) |
| II. Money Law | Integer minor units; the ledger is the truth; no stored money state beside movements | PASS | PASS | Devolada's fee and received amount never touch the ledger (FR-020). Settlements are recorded when proven (D8). Attention is derived, never stored (data-model) |
| III. Tenant Isolation (NON-NEGOTIABLE) | Org-scoped tables and indexes; the organization only from the actor, except globally unique keys; `seedTwoOrgs` on every new route | PASS | PASS | All four tables carry `organization_id` with a leading index. The public webhook resolves the organization by `paymentLinkId`, a globally unique key, then re-reads with that organization's own credential (D4). III enumerates its exempt keys, so the amendment (T006) adds this one, as v1.2.0 added Better Auth's, and names the actor-less sweeps that already select across organizations. Isolation suites: `test/devolada/isolation.test.ts` and each route's file |
| IV. The Server Decides | Rules server-side; routes in `src/routes/<resource>/`; error codes declared first; mirrors held | PASS | PASS | The server decides link issuance, mode policy, labels and resolution rules. The public webhook is its own resource, `src/routes/webhooks/` (`index.ts` with the signature-and-schema middleware, `handler.ts`, `schema.ts`), so its input is validated before the handler runs (D4). Error codes are declared in the spec (FR-023) and detailed in [contracts/turistear-api.md](./contracts/turistear-api.md). Responses use named keys (`{connection}`, `{folio, payment_link}`). Types and MSW mirror the contracts |
| V. Capacity Is Guarded by the Database | Guarded single statements; a request gives back what it took | PASS | PASS | No new capacity consumption. No read is ever the only guard: the system cancellation claims the link, then writes one batch whose every statement is gated on that batch's own guarded transition, releasing seats only for live lines (D11). A settlement or an admin *accept* is one batch gated on a single-row claim of the link (D8, D15). A verification releases tickets only in the call whose guarded flip matched (D10). Rechazar's own missing guard stays defect 3 |
| VI. A Rule Is Proven Where It Is Enforced | API suites for rules and isolation; app tests for presentation only; axe; citations | PASS | PASS | D18. Transfer fields and the receipt's status rule move out of `pages/` so they can be tested |
| VII. Elegant Field Minimalism (NON-NEGOTIABLE) | Primitives, tokens, state icon-paired, «Venta» never "folio", es-MX copy, one word per concept and one verb per action | PASS | PASS | FormSheet, ConfirmSheet, StatusChip, AlertCard and MoneyText. Labels and action copy live in the contracts: *verificación* is the only word for money being checked, *accept* is «Verificar», the credential is a «clave», since «llave» names the passkeys, and the link is an «enlace», the word the customer's ticket message already uses (D15, D16). The receipt's «Pagado» on unverified money is fixed (D16). Defect 11's «tu folio» goes through the lite path before PR 2 |
| VIII. A Service We Do Not Own Never Undoes a Sale | One module; outside money writes; failure modes recorded; secrets per environment | PASS* | PASS* | Only `services/devolada.ts` calls Devolada, the key set included, with timeouts and fallbacks (D5, D6). Failure modes: [contracts/devolada-integration.md](./contracts/devolada-integration.md). The key is managed in the GitHub environments and planted by every deploy. A preview gets dev's key or none, an exception to VIII's throwaway rule, and without a key the API fails closed (D17). *Devolada must be added to the list of services we do not own: see Complexity Tracking |
| Technology Stack & Constraints | Stack fixed unless justified; migrations additive and safe under the code already deployed; bounded reads | JUSTIFIED | JUSTIFIED | New integration, new secret, third sweep on the existing trigger (Complexity Tracking). Migration `0073` is additive, and nothing on `main` reads its tables when the preview applies it to dev. New reads are bounded and indexed |
| Workflow & Quality Gates | One worktree and one PR per unit, off and into `main`; `verify` green; a preview per PR; dev on merge, production on a `v*` tag; `/speckit-analyze` before implement | PASS | PASS | Three PRs to `main` (D19), each validated on its preview and on dev before a `v*` release. The constitution amendment rides PR 1 |

**Result**: the gates pass. Four points need the constitution to name them, all justified below
and resolved by one MINOR amendment through `/speckit-constitution` (T006):
- Devolada among the services we do not own, and the third sweep on the cron;
- VIII's rules for a key that encrypts rows in dev's database: a preview gets dev's value or none, and
  a malformed value stops the deploy;
- Devolada's link id among III's exempt lookups;
- the actor-less sweeps, which III does not name yet.

## Project Structure

### Documentation (this feature)

```text
specs/006-devolada-transfer-verification/
├── spec.md                 # /speckit-specify (+ clarifications 2026-10-06 and 2026-10-15; FR-016 amended by D8)
├── plan.md                 # This file
├── research.md             # Phase 0: D1–D20, defects found, requests to Devolada
├── data-model.md           # Phase 1: four tables, states, validation rules
├── quickstart.md           # Phase 1: automated and manual validation
├── contracts/
│   ├── devolada-collections-v1.openapi.yaml   # Devolada's contract, verbatim
│   ├── devolada-integration.md                # what we call, error mapping, failure modes
│   └── turistear-api.md                       # our endpoints, shapes, labels, error codes
├── checklists/requirements.md                 # /speckit-specify quality checklist
└── tasks.md                # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
api-turistear/
├── migrations/0073_devolada_transfer_verification.sql      NEW  four tables (data-model)
├── src/
│   ├── bindings.d.ts                                        + DEVOLADA_* bindings (D17)
│   ├── index.tsx                                            mount /api/webhooks and /api/devolada; third waitUntil sweep
│   ├── db/schema.ts                                         + four tables; enum values (event types, cancellation source)
│   ├── types/errors.ts                                      + eleven new error codes (spec FR-023), and the undeclared FOLIO_CANCELLED
│   ├── services/devolada.ts                                 NEW  the only Devolada client (D5)
│   ├── utils/
│   │   ├── devoladaCredential.ts                            NEW  AES-GCM encrypt/decrypt, per-org key (D1)
│   │   ├── devoladaSignature.ts                             NEW  JWKS cache + ES256 verify (D4)
│   │   ├── devoladaLinkView.ts                              NEW  label precedence and PaymentLinkView reads (D14)
│   │   ├── folioDetail.ts, folioListRows.ts                 + payment_links / payment_link (D14)
│   │   ├── folioPendingWork.ts                              + Devolada attention in pending work and counts (D14)
│   │   └── folioEvents.ts                                   + four event types
│   └── routes/
│       ├── devolada/
│       │   ├── index.ts, handler.ts, schema.ts              NEW  admin: POST /payments/:id/resolve (D15)
│       │   ├── connection.ts                                NEW  connect/disconnect/health logic (D1–D3)
│       │   ├── links.ts                                     NEW  issue, close, replace links (D6, D7, D13)
│       │   ├── apply.ts                                     NEW  applyDevoladaPayment state machine (D9)
│       │   └── sweep.ts                                     NEW  sweepDevoladaPayments(env, now) (D12)
│       ├── webhooks/
│       │   ├── index.ts                                     NEW  public router + signature/schema middleware (D4)
│       │   ├── handler.ts                                   NEW  link lookup, mode check, de-dup, re-read, apply (D4)
│       │   └── schema.ts                                    NEW  Zod schema of Devolada's WebhookEvent
│       ├── organizations/index.ts, handler.ts, schema.ts    + /me/devolada (admin); `devolada` summary on /me
│       ├── pos/
│       │   ├── handler.ts                                   confirm/settle issue links; verify/reject call the cores
│       │   ├── verifyCore.ts                                NEW  verifyFolioPayment + releaseClearedFolio (D10)
│       │   ├── settleCore.ts                                NEW  settlement core shared by both settle handlers and D8
│       │   ├── unreceivedTransfer.ts                        NEW  cancelForUnreceivedTransfer + shared release builder (D11)
│       │   └── sweep.ts                                     guard: skip sales with an open link or a payment in flight (D8)
│       └── folios/handler.ts                                cancel cores mark links `closing` in their batch (D13)
├── test/
│   ├── helpers/devolada.ts                                  NEW  fake Devolada, key pair/JWKS, signed-webhook builder
│   └── devolada/*.test.ts                                   NEW  connection, checkout-link, webhook, verdicts, apartados,
│                                                                 link-closing, sweep, isolation, credential-cipher, signature,
│                                                                 link-view, query-plans
├── vitest.config.ts                                         pin DEVOLADA_* bindings (D17)
├── wrangler.jsonc                                           DEVOLADA_* vars in local, dev, preview and production
└── .dev.vars.example                                        document DEVOLADA_CREDENTIAL_KEY

.github/
├── workflows/deploy-dev.yml, deploy-prod.yml                plant DEVOLADA_CREDENTIAL_KEY; a malformed one stops the deploy (D17)
├── workflows/preview.yml                                    dev's DEVOLADA_CREDENTIAL_KEY or none, never a throwaway (D17)
└── scripts/preview-note.mjs                                 the note says when Devolada is off on a preview

app-turistear/src/
├── features/devolada/                                       NEW  components/{DevoladaConnectionCard, ConnectDevoladaSheet,
│                                                                 PaymentLinkCard, PaymentLinkStatusChip}, hooks/, types.ts, index.ts
├── features/pos/components/TransferPaymentFields.tsx        NEW  reference field vs link notice, testable outside pages/
├── features/pos/components/ReceiptPaymentStatus.tsx         NEW  «Pago en verificación» on the receipt, testable outside pages/
├── features/pos/delivery.ts                                 + paymentLinkWhatsAppUrl + one shipped text per link kind
├── features/pos/types.ts, features/folios/types.ts          + PaymentLinkView mirrors; `payment_not_received`; event types
├── features/bookings/components/SettleSheet.tsx, BookingActions.tsx    connected mode; settlement link card
├── features/folios/components/FolioCard.tsx, FolioWorkActions.tsx,
│   FolioTimeline.tsx, FolioDetailScreen.tsx                 labels, amounts, resolve actions, timeline entries
├── features/folios/folioCardState.ts, folioFacets.ts        «Por verificar»: out while Devolada resolves; attention in; porVerificarCount
├── features/folios/components/PendingWorkBar.tsx            the same «Por verificar» number as the badge
├── features/pos/components/PaymentBreakdown.tsx             label for a payment Devolada is handling
├── pages/SettingsPage.tsx                                   «Cobro con Devolada» card after «Punto de venta»
├── pages/PosCheckoutPage.tsx                                uses TransferPaymentFields
├── pages/FolioReceiptPage.tsx                               PaymentLinkCard; no «Pagado» on unverified money
├── layout/AppLayout.tsx                                     badge = porVerificarCount + requests
├── services/devoladaService.ts                              NEW  connection + resolve
├── services/posService.ts, bookingsService.ts, foliosService.ts, organizationsService.ts   response mirrors
└── test/handlers/devolada.ts                                NEW  MSW handlers and fixtures
```

**Structure Decision**:
- **API layout**: the existing monorepo layout. The new Devolada resource lives in `api-turistear/src/routes/devolada/`, and the public webhook is its own resource in `api-turistear/src/routes/webhooks/`, both following constitution IV, with its non-route modules beside it as `routes/pos/sweep.ts` and `reminders.ts` already do. The provider client lives in `src/services/`, as `resend.ts` does.
- **Extracted cores**: the cores pulled out of the POS handlers live next to them in `routes/pos/`, so `verifyPayment`, `settleBooking`, `settleFolioLine` and `rejectPayment` call the same code the webhook and sweep call.
- **Frontend**: the work is a new `features/devolada/` module plus edits to the existing POS, bookings and folios features. `pages/` only assembles.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **Departure from the fixed stack.** A new external service (Devolada), a new secret (`DEVOLADA_CREDENTIAL_KEY`) and a third sweep on the API's one cron trigger. The constitution's *Technology Stack* table and Principle VIII list the services we do not own, and the Runtime row describes the cron as running the bookings sweep. VIII also lets a preview take a throwaway value for any secret dev lacks. III enumerates the globally unique keys a read may use without the actor's organization, and does not name the actor-less sweeps, which select due rows across organizations as `sweepExpiredBookings` already does | The feature *is* the integration: Banxico's verdict reaches us only through Devolada. The secret is the only way to meet FR-003. The sweep is FR-012's recovery path. A throwaway key would encrypt rows in dev's database that dev could never read. A webhook has no actor: Devolada's link id is the only way it can learn whose sale it is, and the re-read with that organization's own credential proves it. The sweep has no actor either: like the bookings sweep, it finds due links across organizations and acts on each with that link's own organization | No alternative verifies a transfer without the provider. Resolved by a **MINOR** amendment (1.4.0 → 1.5.0) through `/speckit-constitution` in PR 1 (T006). Devolada joins the Integrations row and VIII's list, with its module and failure modes. The Runtime row names the three sweeps. VIII's secrets paragraph names the key, says what changing it costs, gives a preview dev's value or none, and stops a deploy whose value is malformed. III's list gains `devolada_links.devolada_link_id`, and III names the actor-less sweeps |
