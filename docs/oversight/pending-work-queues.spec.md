# Feature: Pending work queues — money owed back, and money still owed

> Process: `docs/PROCESS.md`. Stories **US-A78** (refunds pending hand-back) and **US-A79**
> (apartados past their settle deadline).
>
> **Q3 and Q9 are superseded by `docs/oversight/folio-lifecycle-unification.spec.md` (US-A84).**
> The two queues stop being tabs and become facets of one folio list; `?tab=` becomes `?estado=`.
> Everything else here still holds — in particular **Q5** (the age is the signal, now printed on
> the card's time chip rather than carried by the sort order), **Q6** (confirming a refund needs
> the customer's PIN and stays on the folio detail) and **Q8** (the clock is read in an effect,
> never in a render body).

## Context

Two facts the system already knows, and shows nobody.

**1. A cancelled folio that owes cash.** `refund_status = 'pending'` means exactly *"cancelled,
money owed to the customer, nobody has confirmed it was handed back"*. The column has existed since
US-A23. There is **no list, no count, no badge** — an admin can only learn it by opening one folio
at a time, and there are 101 folios in dev alone.

That gap is not cosmetic. On cancellation the ledger writes the negative `refund` row immediately
(`buildCancellationReversal` → `refundRow`, `utils/folioPayments.ts`), so the collecting agent's
balance drops **at once**. Confirming the PIN later only flips a flag (`confirmRefund` writes no
ledger row). The books therefore record the money as handed back **before anyone proves it was**:

| Step | Agent's balance |
|---|---|
| Customer pays $3,000 cash | owes 3,000 |
| Agent cancels the folio | **owes 0** |
| Customer confirms with the PIN | owes 0 — unchanged |

If step 3 never happens, nothing anywhere says so. A refund pending for a week looks identical to
one confirmed five minutes ago.

**2. An apartado past its settle deadline.** Since `apartado-stages.spec.md` the deadline no longer
cancels — the folio advances to a grace stage and waits. That is the right behaviour, and it means
a folio can sit for days holding seats with money still owed, visible only as a `booking` row among
every other `booking`.

Both are **work waiting for a human**, and this app already has a shape for that: the *Verificación
de pagos* and *Solicitudes de cancelación* tabs in Ventas, each with a count badge, each fronted by
a `QueueCard` on Hoy.

## Scope boundary

**No migration, no new column, no state machine change.** Both queues are `WHERE` clauses over
columns that already exist. If this feature were reverted, not one row would differ.

Mechanically: `test/folios/*.test.ts` and `test/pos/pos-bookings-sweep.test.ts` must pass
**unedited**. The only server change is two new *optional* query filters on an existing read.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **Q1** | **Two filters on `GET /api/folios`, not two new endpoints.** | The route already whitelists `status`, `verification` and `agent` the same way. A third and fourth filter cost four lines; two endpoints cost two routers, two schemas and two test files to say the same thing. |
| **Q2** | **"Overdue" is DERIVED at query time (`status='booking' AND booking_expires_at < now`), never stored.** | `apartado-stages.spec.md` **S7** settled this: a stored stage needs a writer, and a cron that writes state drifts from the clock that defines it. A `WHERE` clause cannot drift. |
| **Q3** | **The list lives as a tab in Ventas; Hoy gets a `QueueCard` that links to it.** | Both components already exist and already carry counts. A queue that lives only on the dashboard is a number nobody can act on; a queue that lives only in Ventas is one nobody finds. |
| **Q4** | **Count comes from `select: (folios) => folios.length` on the same query.** | Exactly how `usePendingVerificationCount` already works. A dedicated count endpoint would be a second source of truth for one integer. |
| **Q5** | **The refunds queue shows the AGE of the debt, and sorts oldest first.** | The number alone is not the signal — a refund pending three days is a question, one pending three minutes is Tuesday. Age is the whole reason the screen exists. |
| **Q6** | **Read-only. No "confirm refund" action on the list.** | Confirming a refund needs the customer's PIN, which needs the customer present. The list's job is to make the debt findable; `FolioDetailPage` already owns the confirm flow (US-A23). Putting a money action one tap from a list is how the wrong folio gets confirmed. |
| **Q7** | **Cancelled folios are excluded from the overdue queue** (`status = 'booking'` already does this), and **`refund_status='pending'` folios are shown whoever cancelled them** — admin, agent, tourist or the sweep. | The debt is the same debt regardless of who created it. Filtering by `cancellation_source` would hide exactly the case this queue exists to catch. |
| **Q9** *(fixed in build)* | **The `?tab=` param IS the tab state — derived every render, written back on click.** | The first cut seeded `useState` from the URL once. React Router keeps this component **mounted** when only the query string changes (the path `/folios` is unchanged), so the initializer never ran again and the copy drifted: arriving from the Hoy card and then tapping *Ventas* left the URL saying `/folios` while the page still showed Reembolsos — and reloading that same URL showed Folios. One address, three screens, decided by history. This is Q2's rule one layer up: a stored copy of something the URL already states will disagree with it. Deriving it also makes a tab shareable and reload-stable. |
| **Q8** *(added in build)* | **The current time is read in an effect, never in render** — `useNowSeconds`, refreshing every 60 s. | The lint rules reject `Date.now()` in a render body as impure, and they are right for a reason that matters here: a queue left open on a booth tablet would otherwise keep claiming *"hace 1 min"* an hour later. The age is the signal (Q5), so a stale age is a wrong screen, not a cosmetic one. The hook returns `null` on first render so "time unknown" has to be handled rather than silently rendering an age of zero. |

## Data Model

**None.** No migration. Columns used, all existing:

| Column | Table | Used for |
|---|---|---|
| `refund_status` | `folios` | `'pending'` = owed and unconfirmed |
| `refund_amount` | `folios` | How much is owed |
| `cancelled_at` | `folios` | The age of the debt (Q5) |
| `cancellation_source` | `folios` | Displayed, not filtered (Q7) |
| `status` | `folios` | `'booking'` for the overdue queue |
| `booking_expires_at` | `folios` | Compared to `now` (Q2) |
| `agent_id` | `folios` | Who is holding the cash |

## Business rules (enforced server-side)

1. **`refund_status=pending`** returns folios where `refund_status = 'pending'`, org-scoped, ordered
   by `cancelled_at` **ascending** (oldest debt first — Q5).
2. **`overdue=true`** returns folios where `status = 'booking'` AND `booking_expires_at IS NOT NULL`
   AND `booking_expires_at < now`, org-scoped, ordered by `booking_expires_at` ascending.
   `booking_expires_at` is a real timestamp, so this needs **no time-zone maths** — unlike the
   catalog day, which does (`utils/tz.ts`).
3. **Unknown filter values are ignored, not rejected** — matching the existing `status` /
   `verification` behaviour on this route exactly. A filter route that 400s on a typo would be a
   different contract from the one beside it.
4. **Both filters compose** with `status` and `agent`. `agent` + `refund_status=pending` answers
   *"what does this agent still owe customers?"*, which is the question a cash review actually asks.
5. **Admin-only.** The route is mounted under `/api/folios/*`, which is admin-guarded. No agent-facing
   variant in this feature.
6. **Org-scoped like every other read.** `organization_id` from context, never from the query.

## API surface

### `GET /api/folios` — two new optional filters

```
GET /api/folios?refund_status=pending
GET /api/folios?overdue=true
GET /api/folios?refund_status=pending&agent=<userId>
```

**Corrected in build.** The spec originally claimed the response shape was unchanged. It was
wrong: the lean list row carries neither `refund_status` nor `refund_amount`, so the refunds queue
could not show **what is owed** without a second read per folio. Both are added to the row —
additive, nullable in the client type, and every existing caller ignores them.

### Error responses

None new. Invalid values fall through to "no filter applied" (Rule 3).

## Frontend

### Ventas (`pages/FoliosListPage.tsx`) — two new tabs

Alongside *Folios* · *Verificación de pagos* · *Solicitudes de cancelación*:

| Tab | Query | Badge |
|---|---|---|
| **Reembolsos pendientes** | `{ refund_status: 'pending' }` | count, `warning` |
| **Apartados vencidos** | `{ overdue: true }` | count, `warning` |

New components in `features/folios/components/`, mirroring `PaymentVerificationTab`:
`PendingRefundsTab.tsx`, `OverdueBookingsTab.tsx`.

Each row: customer name · `MoneyText` for the amount owed · **age** (*"hace 3 días"*, via
`useOrgDateFormatter`) · the selling agent · a `StatusChip`. The whole row links to
`FolioDetailPage`, where the existing confirm-refund / settle actions live (Q6).

Age uses functional colour, icon-paired, never teal: neutral under 24 h, **amber** over 24 h,
**red** over 72 h. The thresholds are display-only — nothing in the engine reads them.

### Hoy (`pages/DashboardPage.tsx`) — two new `QueueCard`s

Reuses the component unchanged. Icons: `PaymentsRounded` (refunds), `EventBusyRounded` is taken, so
`HourglassBottomRounded` (overdue).

```
title="Reembolsos"        pendingHint="{n} por entregar"       to={ROUTES.FOLIOS}
title="Apartados vencidos" pendingHint="{n} sin liquidar"       to={ROUTES.FOLIOS}
```

Both deep-link to Ventas. Since Ventas opens on tab 0, the link carries the target tab
(`?tab=refunds` / `?tab=overdue`) and `FoliosListPage` reads it once on mount — otherwise the card
drops the admin on a list that is not the one they tapped.

Four cards now sit on Hoy. On mobile they stack; the existing `Stack` already wraps.

### Hooks (`features/folios/hooks/useFolios.ts`)

`usePendingRefunds` / `usePendingRefundCount`, `useOverdueBookings` / `useOverdueBookingCount` —
copies of the `usePendingVerification*` pair, same `select: (folios) => folios.length` (Q4).

## Scenarios

### US-A78 — refunds pending hand-back

**S-1 — A cancelled folio owing money appears**
Given a folio cancelled with `refund_amount = 100000` and `refund_status = 'pending'`
When the admin requests `GET /api/folios?refund_status=pending`
Then the folio is returned, with its `refund_amount` and `cancelled_at`.

**S-2 — Confirming the refund removes it from the queue**
Given that folio, and the customer gives the correct PIN
When the admin confirms the refund
Then `refund_status = 'refunded'` and the folio **no longer appears** in the queue.

**S-3 — A cancellation that owed nothing never enters the queue**
Given a folio cancelled in a terminal tier (`refund = 0`, so `refund_status = 'none'` by Rule 3 of
the cancellation engine)
When the queue is read
Then the folio is absent — there is no debt, so there is no work.

**S-4 — Oldest first**
Given three pending refunds cancelled on different days
When the queue is read
Then they come back ordered by `cancelled_at` ascending.

**S-5 — Whoever cancelled it, the debt is listed** *(Q7)*
Given one folio cancelled by an admin and one by the expiry sweep, both owing money
When the queue is read
Then **both** appear. `cancellation_source` is shown, never filtered on.

### US-A79 — apartados past the settle deadline

**S-6 — An expired hold appears**
Given a folio `status='booking'` whose `booking_expires_at` is in the past
When the admin requests `GET /api/folios?overdue=true`
Then it is returned.

**S-7 — A hold still inside its window does not**
Given a `booking` whose `booking_expires_at` is in the future
When the queue is read
Then it is absent.

**S-8 — Settling removes it**
Given an overdue booking
When the agent settles the balance (`booking → paid`)
Then it leaves the queue, because the filter requires `status='booking'`.

**S-9 — A cancelled apartado is not overdue work**
Given an apartado the sweep cancelled at the grace instant
When the queue is read
Then it is absent from *Apartados vencidos* — and present in *Reembolsos pendientes* only if the
ladder left something to hand back.

### Composition

**S-10 — One agent's outstanding debt**
Given two agents each with a pending refund
When the admin requests `?refund_status=pending&agent=<A>`
Then only agent A's folio returns.

### Multitenancy isolation (required)

**S-11 — Another org's pending refund is invisible**
Given two organizations seeded with `seedTwoOrgs`, each with a pending refund
When org A reads either queue
Then only org A's folio is returned — org B's is absent, not `403`.

## Definition of Done

- [x] `refund_status` and `overdue` filters on `listFolios`, whitelisted like `status` /
      `verification`, with the two orderings (Rules 1–2) — plus `refund_status` / `refund_amount`
      on the row, which the spec had wrongly assumed were already there
- [x] Scenarios S-1…S-10 in `test/folios/pending-queues.test.ts` (15 cases — the build added
      **S-7b** a booking with no expiry is never overdue, an ordering case per queue, and an
      unknown-filter-value case, because "ignored, not rejected" is a contract worth pinning)
- [x] S-11 cross-org isolation via `seedTwoOrgs`, for **both** queues
- [x] `PendingRefundsTab` + `OverdueBookingsTab` in Ventas, with count badges
- [x] Two `QueueCard`s on Hoy, deep-linking to the right tab (`?tab=`), with the tab **derived**
      from the URL rather than copied into state (Q9)
- [x] Age display with the 24 h / 72 h functional-colour thresholds, icon-paired, via the shared
      `QueueRow` — both queues ask the same question (who, how much, for how long)
- [x] `SPEC.md`: US-A78 + US-A79 under Administrator → Cancellations, a Features-by-Phase line,
      and glossary entries for **Reembolso pendiente** and **Apartado vencido**
- [x] Full suite green: 678 API tests across 51 files, app `tsc -b` and `eslint` clean

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Moving the ledger reversal to PIN-confirm time** | It would close the fraud window completely rather than just make it visible — but it changes when money moves for **every** cancellation path, including admin ones already in production. That is a money-behaviour change and deserves its own spec and its own revert. This feature makes the problem *visible*, which is the prerequisite for measuring it. |
| **Notifying the admin** (email / push on an aging refund) | A badge an admin sees on every login is enough at three organizations. Notification thresholds are a guess until we have the data this feature produces. |
| **An agent-facing view of their own pending refunds** | The admin is the reconciler. Adding it for agents is a second authorization surface for no new decision. |
| **Auto-expiring a pending refund** | There is no correct automatic answer to *"did the customer get their money?"*. Only a human knows. |

## Known behaviour change

None for existing data. Two filters that nothing currently sends, and two tabs that nothing
currently links to. The first time an admin opens *Reembolsos pendientes* they may find old
unconfirmed refunds — those are pre-existing facts becoming visible, not new events.

## Open

**Should the badge count age-weighted rather than raw?** A count of 12 where all are minutes old
reads the same as 12 where three are a week old. The smallest fix is to badge only the ones past
24 h, with the raw count in the tab. Left as-is for now because we have no data on the real
distribution — which is precisely what this feature will produce.
