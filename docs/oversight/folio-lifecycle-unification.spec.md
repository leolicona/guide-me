# Feature: The folio is one object, not five screens

> Process: `docs/PROCESS.md`. Stories **US-A84** (the admin *Ventas* screen) and **US-AG50** (the
> seller's own *Ventas* list). **Supersedes** `docs/oversight/pending-work-queues.spec.md` **Q3**
> (*"the list lives as a tab in Ventas"*) and **Q9** (the `?tab=` contract), and absorbs the
> *Por verificar* tab of `docs/payment-verification/payment-verification.spec.md` (US-A67) and the
> *Solicitudes* tab of `docs/tourist-portal/tourist-self-service-portal.spec.md` (US-T04).
> Reuses the one-channel-per-axis rule of `docs/oversight/folio-list-scanability.spec.md` (**D1**)
> **without changing it** — this feature extends the channels, it does not add any.

## Context

The *Ventas* screen has five tabs. **Four of them are the same query.**

| Tab | What it actually is | Where |
|---|---|---|
| Folios | `GET /api/folios` | — |
| Por verificar | `GET /api/folios?verification=pending` | `handler.ts:262-271` |
| Reembolsos | `GET /api/folios?refund_status=pending` | `handler.ts:281-284` |
| Vencidos | `GET /api/folios?overdue=true` | `handler.ts:286-293` |
| Solicitudes | `GET /api/folios/cancellation-requests` — **a different table** | `handler.ts:856-905` |

One business object, fragmented across five destinations according to where in its life it happens
to be. The fragmentation is not free:

**1. The folio never shows the state that put it in another tab.** A folio with a cancellation
request in flight looks, in the Folios tab, exactly like a folio with none. A pending refund is
invisible on the row that owes it. The admin who wants the whole picture of one sale has to know to
look in four places, and there is nothing on the row to tell them which.

**2. The counts are not counts.** Every badge fetches the entire filtered list and calls `.length`
in the browser (`useFolios.ts:35-77`, `112-118`):

```ts
usePendingRefundCount = () => useQuery({
  queryFn: () => listFolios({ refundStatus: 'pending' }),   // ← the whole list
  select: (folios) => folios.length,                        // ← counted in the browser
})
```

`usePendingDeliveryCount` downloads **every paid folio with its `lines[]` and `portal_link`** to
produce one integer. Measured per page load:

| Screen | Full `folios` reads | Also |
|---|---|---|
| `/folios` | **4** (visible list · verification · refund · overdue) | 1 read of `cancellation_requests` |
| `/dashboard` (*Hoy*) | **3** (refund · overdue · all-paid) | 1 read of `cancellation_requests` |

None of those reads is bounded: `listFolios` has **no `LIMIT`** (`handler.ts:303-338`), and since
US-A82 each row carries its service lines and portal link through two further unbounded queries.

**3. Two of the five *Hoy* cards are broken promises.** `Cancelaciones` and `Boletos` link to a bare
`/folios` (`DashboardPage.tsx:108,143`). Tapping *"5 boletos sin entregar"* lands the admin on the
unfiltered list of every folio in the organization, to re-filter by hand — a count that navigates
nowhere useful.

**4. Most of the work is already done, in the wrong place.** `venceLabel()` already returns
`Vencido` once the deadline passes (`bookingUrgency.ts:21`), and the card already renders it. The
*Vencidos* tab has been redundant with a chip that already existed — the chip just never said *how
long ago*, and it is drawn amber where a passed deadline is red. US-A82 already put the payment
reference on an unverified card (**D19**), and the money rail already distinguishes an apartado from
a settled sale better than the `Apartado (anticipo)` chip in the verification queue does.

**5. Tabs, as a container, actively hid work.** Fixed in BUG-023 (PR #53): five tabs measure 569px
against a 358px scroller, so *Reembolsos* and *Vencidos* were unreachable on a phone from the day
they shipped. The fix made them reachable. It did not make five destinations the right shape for
one object.

## Scope boundary

**No migration. No new column. No new mutation endpoint.** Reverting this feature changes not one
row of data.

Mechanically:

- The `folios` and `cancellation_requests` **tables are untouched**. Every state this feature
  surfaces is already a column or already derived from the clock.
- **Every mutation stays exactly where it is.** `POST /folios/:id/payment/verify`, `/payment/reject`,
  `/cancellation-requests/:id/approve`, `/reject`, and `/folios/:id/refund` are unchanged in route,
  payload, authorization and effect. Only the **screen that invokes them** moves.
- `test/folios/*.test.ts`, `test/payment-verification/*.test.ts` and
  `test/tourist-portal/*.test.ts` must pass **unedited**, with exactly **two** named exceptions:
  the new union/window assertions on `listFolios`, and **`pending-queues.test.ts` S-4**, which
  asserted the oldest-debt-first sort that D10 removes. That test is rewritten in place, not
  deleted: it now pins the new order **and** that `cancelled_at` still reaches the client, because
  losing that field is what would genuinely break Q5 and an order-only assertion would not catch it.
  No other assertion in those files may be touched — an edited test is how a scope boundary rots.
- On the frontend, **`FoliosListPage.test.tsx` is rewritten**, because the page it tests is. Its two
  tab assertions go with the tabs. **BUG-023's guard survives and grows**: the defect was never
  tab-specific — *a control row wider than the viewport with nothing owning the overflow* — and this
  screen now has **two** control rows, so both are asserted to sit inside `FilterStrip`. The new
  pending-work bar is the more likely of the two to be built without the wrapper, which is why it
  gets its own case.
- The **delivery axis vocabulary is untouched**: `Pendiente de enviar → Enviado → Visto`
  (US-AG40). The pending `Visto → Entregado` glossary migration is *not* in this feature.
- The **channel rule of US-A82 is untouched**: `rail = money · checkmark = message · chip = time ·
  button = pending work`. This feature adds **no fourth channel and no new badge**.
- The **seller's screen gains no admin capability.** `FolioHistoryPage` renders the extended card;
  it gets no banner, no facet section for work it cannot perform, and no admin verb.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **The five tabs collapse into one list.** `Tabs` is deleted from `FoliosListPage`, along with `PaymentVerificationTab`, `CancellationRequestsTab`, `PendingRefundsTab`, `OverdueBookingsTab` and `QueueRow`. | Four of them were one query with a different `WHERE`; presenting them as destinations taught the user that a folio is five kinds of thing. A tab is a claim that its contents are a different **object**. Here they are the same object at a different **moment**, which is what a filter is for. |
| **D2** | **`Solicitudes` is absorbed entirely** — the pending ones surface as a folio state, the full request history moves to the folio detail, and a `Con solicitud` facet keeps the involved folios findable. | It is the only tab that is genuinely a different table, and the honest options were "keep one tab" or "absorb and lose the org-wide history". Absorbing wins because the *pending* request is the only actionable state, and it belongs on the folio it is about. The loss is real and named in **Known behaviour change** — it is not hidden among the improvements. |
| **D3** | **Facets, not one exclusive filter.** Three sections — **Pago** (`folios.status`) · **Entrega** (the delivery axis) · **Pendiente** (work) — multi-select within a section, `AND` between sections. | The states are not one axis. A folio is *cancelled* **and** *refund pending* at the same time; *booking* **and** *overdue* at the same time. An exclusive toggle would make the UI assert a mutual exclusion the data does not have, and would make *"cancelled folios I have already paid back"* unaskable. Each section is one real axis of the data — no section mixes money with messaging. |
| **D4** | **The URL is the state**: a single `?estado=` key, comma-separated, with the section **deduced** from each value (`?estado=pagado,sin_enviar`). Written with `replace`. | Facet keys are globally unique, so encoding the section would be redundant data that can disagree with itself. `replace` keeps the back button from having to walk out of every toggle. This is Q9 of `pending-work-queues.spec.md` restated: a stored copy of something the URL already says **will** drift from it — that bug cost one release to find. |
| **D5** | **The banner is a row of actionable pills** in `FilterStrip`, rendered **only for counts > 0**. | It reuses `filterChipSx` and the `/pos` filter language rather than inventing a surface. Rendering zero-count pills would spend permanent vertical space on a phone to say "nothing to do" — the empty tabs, in a new costume. When there is no work, the row does not exist. |
| **D6** | **The banner applies a facet; it does not navigate.** Tapping `[2 Reembolsos]` turns on the `reembolso` facet in place, and the pill reads as active in both the banner and the Estado sheet. | The admin never ends up looking at a filtered list without knowing it — which is precisely what arriving at a tab did. Filtering in place also keeps the search field (US-A83) and any date range intact. |
| **D7** | **`GET /api/folios/counts` — one aggregate, real `COUNT(*)`.** All five badges plus *Hoy*'s cards read it. | Replaces up to four full list reads per screen with one row of integers. It also makes the two surfaces **structurally incapable of disagreeing**, which five independent queries with five cache keys were not. |
| **D8** | **The load is a union, not a page**: *every folio with pending work, regardless of age* ∪ *the last N days of everything else*. | Client-side facets over a partial set is the one combination that must never ship: a facet computed over 50 of 5,000 rows presents the answer about 50 as the answer about 5,000. A filter that lies silently is worse than no filter — it is the exact failure this feature exists to end. The union makes the pending-work facets **complete by construction**, so `Hoy` promising 2 refunds and the destination showing 2 is a guarantee, not a coincidence. |
| **D9** | **N = 30 days, declared in the UI and configurable in code — a parameter, not a constant.** | 30 covers the reported use case (*"the sale from two weeks ago"*) with margin, and `[Rango ▾]` reaches anything older. The right N comes from measuring folios/day in production; a number nobody measured should not be written as though it were law. |
| **D10** | **One sort: most recent sale first.** The age signal moves onto the card's time chip — `Debe hace 8 d`, `Venció hace 2 d`. | Today the sort silently changes with the filter (`handler.ts:297-301`), which was correct when each queue was its own screen and is unreadable when facets combine. Q5 of `pending-work-queues.spec.md` said the **age is the signal** — it did not say the signal must be a sort order. Printing it on the row satisfies Q5 without a list whose order the admin cannot predict. |
| **D11** | **No new badge on the card.** Every new state lands in a channel that already exists. | Adding a status pill per state is exactly what US-A82 removed nine days ago: two adjacent pills from one palette that force the row to be read instead of scanned. Seven states would not fit a phone's width anyway. |
| **D12** | **The single button's verb is decided by a five-rung ladder, blocking-first:** `Revisar solicitud` → `Verificar y enviar` → `Confirmar reembolso` → `Recordar saldo` / `Enviar boletos` → `Enviar mensaje`. | Extends US-A82 **D7** (*one button, the first pending job*) now that two jobs can coexist. Blocking-first, because reviewing a cancellation request can make everything below it moot, and an unverified payment makes delivery impossible (`deliverable` is false). Ordering by age instead would make the same card change its button on its own, which no admin can plan around. |
| **D13** | **`Verificar y enviar` is the card's verb — not bare `Verificar`.** | It verifies, opens WhatsApp with the freshly-minted portal link and stamps `tickets_sent_at` in one tap. Bare `Verificar` would drop the folio straight from the verification queue into the undelivered queue — a queue growing from correct behaviour, which is the failure US-A82 **D7** was written against. |
| **D14** | **Destructive actions live on the folio detail, in `ConfirmSheet`.** `Rechazar pago` (cancels the sale + commission clawback) and `Rechazar solicitud` (a note the customer reads) move there. | Q6 of `pending-work-queues.spec.md` already established it for the refund: *a money action one tap from a list is how the wrong folio gets confirmed*. The same reasoning covers cancelling a sale. `ConfirmSheet`, not `Dialog` — the tabs being deleted used MUI `Dialog`, which `CLAUDE.md` forbids for confirmations; moving them is the occasion to comply. |
| **D15** | **The seller gets the card, not the banner.** | The new states are about **their own sales** and affect them (their apartado expired; their sale is stuck in verification), so hiding them would be paternalistic. But a work queue they cannot action is noise. Their verbs stay `Recordar saldo` · `Enviar boletos` · `Enviar mensaje`. |
| **D16** | **`/folios` with no parameters opens unfiltered**, most recent first. | The same URL must always show the same screen. Opening onto pending work when it exists would make `/folios` mean different things on different days — implicit state, which is the Q9 bug wearing different clothes. The banner already makes the work impossible to miss. |
| **D17** | **`?tab=refunds` / `?tab=overdue` redirect** to `?estado=reembolso` / `?estado=vencido`, with `replace`. | There are live links in `Hoy` and, plausibly, bookmarks. `replace` makes the URL self-heal rather than leaving a dead parameter in history. |
| **D18** | **A facet link carries no date filter.** No date parameter means no date filter, always. | Otherwise a range inherited from a previous visit could make a banner count and its destination disagree — the exact failure D8 exists to prevent, reintroduced through the URL. |
| **D19** | **The card's age labels read the clock from `useNowSeconds`, never `Date.now()` in render.** | `hoursUntilExpiry()` calls `Date.now()` in a render body (`bookingUrgency.ts:11`). It is cosmetic today because `Vencido` does not change. `Venció hace 2 días` **does** age, and a booth tablet left open all morning would print a dead number. Q8 of `pending-work-queues.spec.md` already ruled on this: the age is the signal, so a stale age is a wrong screen, not a cosmetic one. |
| **D20** | **`Hoy` keeps its cards.** Both surfaces read `GET /api/folios/counts`. | Different moments, different verbs: *Hoy* answers *"what is waiting for me"* before work starts (and carries Caja, which is not a folio at all); the banner is a work bar **inside** the screen where the work is executed. Sharing the endpoint is what makes the duplication safe. |

## Data Model

**No migration.** Every state this feature surfaces already exists:

| State | Source | Stored? |
|---|---|---|
| Pagado · Reserva · Cancelado | `folios.status` | yes |
| Por verificar | `folios.payment_verification = 'pending'` | yes |
| Reembolso pendiente | `folios.refund_status = 'pending'` | yes |
| Vencido | `status='booking'` ∧ `booking_expires_at < now` | **derived at query time** (`apartado-stages` S7) |
| Solicitud pendiente / Con solicitud | `cancellation_requests` grouped by `folio_id` | yes, in its own table |
| Sin enviar · Enviado · Visto | `tickets_sent_at` / `tickets_viewed_at` | yes |

`Vencido` stays derived. A stored stage needs a writer, and a cron that writes state drifts from the
clock that defines it; a `WHERE` clause cannot drift.

**One existing constraint is load-bearing here.** `uq_cancellation_requests_open` (migration `0028`)
is a **partial** unique index — `(folio_id) WHERE status = 'pending'`. A folio can therefore hold at
most **one live request** but any number of resolved ones. Two consequences the implementation
depends on: rule 6's `'pending'` must win over `'resolved'` when both exist on one folio (they can),
and the pending-request **count is over folios, not request rows** — counting rows would print
*"3 Solicitudes"* above a single card whose history happens to be long.

The two new response fields on a list row are **derived, never persisted**:

- `cancellation_request: 'pending' | 'resolved' | null` — computed by one grouped query that
  re-applies the caller's `filters` through a join, exactly the pattern `folioListRows.ts` already
  uses for `lines` and `portal_link`. **Not** a per-row `JOIN`: D1 caps bound parameters per query,
  which is why that pattern exists.
- `overdue: boolean` — the same predicate the `?overdue=true` filter already applies, surfaced per
  row so the card can render it without re-deriving the deadline client-side.

## Business rules (enforced server-side)

1. `GET /api/folios` returns the **union** of (a) every folio in the caller's organization with
   pending work — `payment_verification='pending'` ∧ `status≠'cancelled'`, or
   `refund_status='pending'`, or an overdue booking, or a pending cancellation request — **regardless
   of age**, and (b) every folio created within the last `N` days (default 30).
2. The window `N` is applied to `folios.created_at` **in the organization's timezone**, not UTC.
3. Rule 1's set (a) is **not** subject to `N`. A pending refund from a year ago is returned.
4. `GET /api/folios/counts` returns integers from `COUNT(*)` over the caller's organization, with
   **no window applied** — the counts describe the whole organization, always.
5. The five counts are `verification` · `cancellation_requests` · `refunds` · `overdue` ·
   `undelivered`, each defined by the identical predicate its former tab used.
6. A folio's `cancellation_request` field is `'pending'` when it has at least one request in
   `pending`, `'resolved'` when it has requests but none pending, and `null` when it has none.
7. `GET /api/folios/:id` returns `cancellation_requests[]` — the full history for that folio,
   newest first, each with its status, reason, resolution note and resolver.
8. Filtering remains **client-side** over the payload of rule 1 (this feature does not add facet
   query parameters). Unknown values in `?estado=` are **ignored, not rejected** — matching the
   existing `status`/`verification` behaviour on this route.
9. Sort is `created_at DESC` for every request. The former filter-dependent ordering
   (`handler.ts:297-301`) is removed.
10. *(Frontend mirror)* The card's action verb follows D12's ladder. This is presentation only —
    nothing server-side reads it.

## Authorization — who may do this

Unchanged. `GET /api/folios`, `/counts` and `/:id` stay behind `authMiddleware` +
`requireRole('admin')` (`routes/folios/index.ts`). The seller's list remains the agent-scoped
`GET /api/pos/folios`, which gains the same two derived fields and **no** admin data.

A cross-org read returns **`404`**, never `403` — which would confirm the record exists.

## API surface

### `GET /api/folios` — changed

Response is **additive** plus one bound:

```jsonc
{
  "folios": [
    {
      // …every existing field, unchanged…
      "cancellation_request": "pending",   // NEW: 'pending' | 'resolved' | null
      "overdue": false                     // NEW: derived from booking_expires_at
    }
  ],
  "window_days": 30                        // NEW: what the list covers, so the UI can say so
}
```

The `verification`, `refund_status`, `overdue`, `status`, `date` and `agent_id` query parameters are
**kept** — the counts endpoint and existing tests use them, and removing them would break the scope
boundary for no gain.

### `GET /api/folios/counts` — new

```jsonc
{
  "verification": 3,
  "cancellation_requests": 1,
  "refunds": 2,
  "overdue": 0,
  "undelivered": 5
}
```

### `GET /api/folios/:id` — changed

Gains `cancellation_requests[]` (newest first). Additive.

### Error responses

None new. Invalid `?estado=` values fall through to "no facet applied" (rule 8).

## Frontend

**`pages/FoliosListPage.tsx`** — `Tabs` and the four tab bodies are deleted. The page becomes:
banner row → filter strip → list. `?tab=` is read once for the D17 redirect and then never again.

**`features/folios/components/FolioStateSheet.tsx`** *(new)* — the three-section facet sheet, built
on `BottomSheet` + `filterChipSx`, in the shape `PosCategorySheet` already established.

**`features/folios/components/PendingWorkBar.tsx`** *(new)* — the banner: pills for counts > 0,
inside `FilterStrip`, each toggling its facet.

**`features/folios/folioCardState.ts`** — `folioAction()` grows from three verbs to D12's five-rung
ladder; a new `folioTimeChip()` owns the time channel (`Vence en 3 h` · `Venció hace 2 d` ·
`Debe hace 8 d`) and takes `nowSeconds` as an argument (D19).

**`features/folios/components/FolioCard.tsx`** — renders the new verbs and the extended chip. No new
element.

**`pages/FolioDetailPage.tsx`** — gains `Rechazar pago`, `Aprobar` / `Rechazar solicitud` and the
request history, all in `ConfirmSheet` (D14).

**`pages/FolioHistoryPage.tsx`** — the extended card only (D15).

**`pages/DashboardPage.tsx`** — the five `QueueCard`s read `/counts`; `Cancelaciones` and `Boletos`
gain the facet links they never had; `?tab=` becomes `?estado=`.

**Deleted:** `PaymentVerificationTab.tsx`, `CancellationRequestsTab.tsx`, `PendingRefundsTab.tsx`,
`OverdueBookingsTab.tsx`, `QueueRow.tsx`.

## Scenarios

### US-A84 — one list, every state

**S-1 — A folio with pending work older than the window is still returned**
Given a folio cancelled 8 months ago with `refund_status='pending'`, and `N = 30`
When the admin loads `GET /api/folios`
Then that folio is in the payload — the window does not apply to pending work (rule 3).

**S-2 — A folio with no pending work older than the window is not returned**
Given a settled, delivered folio created 200 days ago, and `N = 30`
When the admin loads `GET /api/folios`
Then it is absent, and `window_days` is `30`.

**S-3 — The counts describe the organization, not the window**
Given the folio of S-1 is the organization's only pending refund
When the admin loads `GET /api/folios/counts`
Then `refunds` is `1` — the count ignores the window entirely (rule 4).

**S-4 — Banner count and destination agree**
Given `counts.refunds = 2`, one of the two cancelled 8 months ago
When the admin taps `[2 Reembolsos]`
Then the list shows **2** folios. *(This is the assertion D8 exists for; it fails the moment the
union is replaced by a plain window.)*

**S-5 — A folio with a pending request is marked**
Given a folio with one `pending` cancellation request
When the admin loads the list
Then that row carries `cancellation_request: 'pending'` and its button reads `Revisar solicitud`.

**S-6 — A folio whose request was rejected is `'resolved'`, not `'pending'`**
Given a folio with exactly one `rejected` request
Then its row carries `cancellation_request: 'resolved'`, it does **not** appear under the
`solicitud` facet, and it **does** appear under `con_solicitud`.

**S-7 — Facets compose across sections**
Given folios in every combination of status and delivery state
When `?estado=pagado,sin_enviar` is applied
Then only paid folios that are also undelivered are listed — `AND` between sections, `OR` within.

**S-8 — The blocking verb wins**
Given a folio that is `booking`, overdue, **and** has a pending cancellation request
Then its button reads `Revisar solicitud`, not `Recordar saldo` (D12).

**S-9 — An unverified payment blocks the delivery verb**
Given a `paid` folio with `payment_verification='pending'` and tickets never sent
Then its button reads `Verificar y enviar` — never `Enviar boletos`, which `deliverable=false`
makes impossible.

**S-10 — The overdue chip states the age and reads red**
Given a booking whose `booking_expires_at` passed 50 hours ago
Then the chip reads `Venció hace 2 d` in the error tone, and the value is computed from
`useNowSeconds`, not `Date.now()` (D19).

**S-11 — The sort no longer depends on the filter**
Given a mix of pending refunds and recent sales
When any combination of facets is applied
Then the order is always `created_at DESC` (rule 9).

**S-12 — An old tab link redirects**
Given a bookmark to `/folios?tab=refunds`
When it is opened
Then the URL becomes `/folios?estado=reembolso` via `replace`, and the refund facet is active.

**S-13 — A facet link carries no date filter**
Given the admin arrives from *Hoy* at `?estado=reembolso`
Then no date range is applied, whatever was applied on a previous visit (D18).

**S-14 — Unknown facet values are ignored**
Given `?estado=reembolso,pltano`
Then the refund facet applies and the unknown value is silently dropped (rule 8).

### US-AG50 — the seller sees the state of their own sale

**S-15 — The seller's card shows the new states**
Given the seller's own sale is `paid` with `payment_verification='pending'`
When they open their *Ventas*
Then the rail is amber and the card names the verification state.

**S-16 — The seller gets no admin verb and no banner**
Given the same sale
Then the button is **not** `Verificar y enviar`, and no pending-work bar is rendered on
`FolioHistoryPage` (D15).

### Multitenancy isolation (required)

**S-17 — Another org's pending work is invisible in the counts**
Given two organizations seeded with `seedTwoOrgs`, org B holding 3 pending refunds and org A none
When org A's admin reads `GET /api/folios/counts`
Then `refunds` is `0`.

**S-18 — The mark lands on the folio the request is about, and no other**
Given **one** organization holding two folios, exactly one with a pending request
When the admin lists folios
Then only that folio carries `cancellation_request: 'pending'`.

*This is same-org attribution, and it is the only form of the assertion with teeth. The cross-org
form was written first and **mutation-tested during the build**: removing the organization scope
from `readListCancellationRequests` left it green — and so did removing the join and the filters
**entirely**. The reason is structural, and it is US-A82's S-8 exactly: the response reads
`requestByFolio.get(r.id)` for ids it already owns, so a foreign row sits unused in the map. That
decoration cannot leak across orgs however it is scoped, and a test claiming credit for preventing
it would be decoration. **What actually enforces isolation on this route is
`eq(folios.organizationId, org)` in the main query's `filters`**, carried into every decoration
through the join; the second scope inside the decoration is defence in depth, matching
`readListLines`/`readListPortalLinks`. S-18 as written above **does** fail when the grouping key is
mis-keyed — verified by mutating it to the request id, which failed six tests including this one.*

**S-18b — Org A sees only org A's folios**
Given `seedTwoOrgs`, each org holding one folio, org B's with a pending request
When each admin lists folios
Then each sees exactly their own. *(This guards the main query's org scope — the predicate that
does the work. It says nothing about the decorations.)*

**S-19 — Another org's folio detail is 404**
Given `seedTwoOrgs`
When org A requests org B's folio detail
Then `404`, never `403`.

## Definition of Done

**Backend** *(one commit, reviewable alone)*
- [ ] `listFolios` — the union of rule 1, the org-timezone window of rule 2, `window_days` in the response
- [ ] `cancellation_request` + `overdue` on the list row, via the `folioListRows.ts` grouped-query pattern
- [ ] `GET /api/folios/counts` — five real `COUNT(*)`, no window
- [ ] `cancellation_requests[]` on the folio detail
- [ ] The filter-dependent `orderBy` removed (rule 9)
- [ ] Same two fields on the agent-scoped `GET /api/pos/folios`
- [x] S-1 … S-6, S-11 and S-17 … S-19 in `test/folios/folio-lifecycle-unification.test.ts`
      *(S-7 … S-10 and S-12 … S-16 are frontend and belong to the app's suites)*
- [x] **Mutation-verified**, both ways round: replacing the union with a plain window fails S-1,
      S-1b and S-4; mis-keying the request grouping fails six tests including S-18. Recorded in
      S-18's note: the cross-org form of that assertion had **no** teeth and was replaced, not kept.
- [x] `test/payment-verification/*` and `test/tourist-portal/*` pass **unedited** (736 tests, 56 files)

**Frontend**
- [x] `folioFacets.ts` — the facet model, the `?estado=` contract, the matcher
- [x] `FolioStateSheet` (three sections) + `PendingWorkBar`, on `FilterStrip` / `filterChipSx`
- [x] `folioAction()` → D12's ladder; `folioTimeChip()` with `nowSeconds` injected (D19)
- [x] `FoliosListPage` — tabs deleted, facets, banner, `?estado=` as state, `?tab=` redirect
- [x] `FolioWorkActions` on the detail — reject payment, approve/reject request, request history,
      in `ConfirmSheet`/`FormSheet` (ending four MUI `Dialog`s the design system forbids)
- [x] `VerifyAndSendButton` — the card's verb, lifted out of the deleted tab
- [x] `FolioHistoryPage` — extended card, no banner
- [x] `DashboardPage` + `AppLayout` — `/counts`, and facet links on all four folio cards
- [x] Five components deleted (`PaymentVerificationTab`, `CancellationRequestsTab`,
      `PendingRefundsTab`, `OverdueBookingsTab`, `QueueRow`)
- [x] Unit tests for the ladder, the chip and the facet model; page tests for the bar and the URL
      (415 tests, 23 files; `tsc -b` clean)
- [x] **Verified visually at 320 / 390 / 1280px** — US-A82 shipped four defects no test could see,
      and jsdom has no layout engine to find them in. Measured in Chromium against the real
      components and the real theme:

      | Width | Document overflow | `window.scrollX` | Console errors |
      |---|---|---|---|
      | 320 | 0 | 0 | 0 |
      | 390 | 0 | 0 | 0 |
      | 1280 | 0 | 0 | 0 |

      The pending-work bar measures **597px** with all five queues non-empty — wider than a phone,
      which is the shape of BUG-023. The difference is that it **scrolls inside itself**: at 320px
      the last pill comes fully into view at `scrollLeft 277` while the document overflow and the
      page's own `scrollX` both stay at **0**. That is precisely what `variant="standard"` tabs
      could not do, and why the row is contained rather than clipped.

      **One defect found and fixed:** a live cancellation request rendered TWICE on the detail —
      once as work, once as the first row of the history, with the same reason under each. Fixed by
      making the history strictly the RESOLVED requests, and pinned by
      `FolioWorkActions.test.tsx`, verified to fail against the pre-fix component.

      **One defect found and deliberately not fixed here:** `useOrgDateFormatter` follows the
      *browser's* locale, so on an English device the detail prints `Aug 2, 10:52 AM` inside Spanish
      copy. It is not a regression — the deleted tab formatted identically — and pinning it in one
      new component would have made the split three-way. Recorded as **TECH_DEBT #24**.

**Documentation**
- [ ] `SPEC.md`: US-A84 + US-AG50, the *Features by Phase* line, and the glossary terms
      *Faceta*, *Trabajo pendiente*, *Ventana de carga*
- [ ] `pending-work-queues.spec.md` header marked: Q3 and Q9 superseded here
- [ ] TECH_DEBT #23 (pagination) updated — bounded, not closed

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **US-A83 — the search field and `[Hoy]` / `[Rango ▾]` pills** | This feature builds the pill chassis, so US-A83 shrinks to the search input plus the date pills. Sequenced second **by the user's decision**, against the recommendation recorded in the grill — the consequence is that the reported pain (*no buscador*) waits one more PR. |
| **Server-side faceting** | Rule 8 keeps filtering client-side over a bounded union. If an organization's pending-work set ever grows large enough to matter, that is a business problem before it is a query problem. |
| **Measuring `N`** | 30 is a starting value (D9). Nothing breaks if it is wrong — the pending-work facets are complete regardless, and `[Rango ▾]` reaches older sales. |
| **`Visto` → `Entregado` glossary migration** | Already booked separately, with its download instrumentation and detail timestamps. Touching the vocabulary here would put two changes in one revert. |

## Known behaviour change

**The org-wide history of cancellation requests stops being browsable.** Today *Solicitudes* offers
`Aprobadas` / `Rechazadas` / `Todas` across every folio. After this feature, a resolved request is
read on **its own folio's detail**, and the `Con solicitud` facet lists the folios involved. The
question *"show me every request rejected this month"* has **no direct answer** — it becomes: filter
to `Con solicitud`, then open the folios in range.

This is a loss, chosen deliberately over keeping one tab. A folio whose request was rejected never
changed state, so there is nothing on it to represent that history; carrying it would have meant
keeping the tab.

**Two counts start linking somewhere useful.** `Cancelaciones` and `Boletos` on *Hoy* have always
landed on the unfiltered list. They now land on their facet. Admins who learned to re-filter by hand
will find the screen already filtered.

**The list stops showing everything.** By default it covers the last 30 days plus all pending work.
Older sales are reached through `[Rango ▾]`. The screen states the window rather than implying
completeness — which is what it implied, falsely, whenever the browser gave up on the payload.

## Open

| Question | The smallest change that answers it |
|---|---|
| Is 30 days right? | Measure folios/day per org and set `N` from the p95. One constant. |
| Should `Con solicitud` be a facet at all, or is it speculation? | Ship it; if the analytics never show it used, delete the facet and keep the field. |
| Should the banner be sticky while scrolling? | One `position: sticky` on `PendingWorkBar`. Left off for now — a 400-row list with a pinned bar costs a phone's vertical space every scroll. |
| Does the seller need a pending-work bar of their own (their overdue apartados, their undelivered tickets)? | Their own counts endpoint, agent-scoped. Deliberately out of scope: D15 draws the line at capability, and this would be a new capability, not a relocation. |
