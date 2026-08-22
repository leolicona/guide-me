# Feature: One sales screen, two audiences — the seller's surface catches up

> Process: `docs/PROCESS.md`. Stories **US-AG58**, **US-AG59** (seller), **US-A93** (admin),
> **US-UX07** (shell vocabulary). Closes **BUG-034**.
> **Extends** `docs/oversight/folio-lifecycle-unification.spec.md` (US-A84/US-AG50),
> `docs/oversight/folio-list-search.spec.md` (US-A83) and `docs/oversight/folio-list-scanability.spec.md`
> (US-A82/US-AG49) by applying their decisions to the surface that was left behind.
> **Supersedes** `folio-list-search.spec.md`'s scope boundary *"the seller's list is out of scope"*.
> **Does not supersede US-AG50** — its *no pending-work bar* clause is honoured, and D3 explains why.

## Context

Three shipped specs and one server comment all state the same rule:

> *"The seller reads the same fulfilment as the admin. Same derivation, same clock, same margin:
> **the line between the two audiences is capability, never information**."*
> — `api-turistear/src/routes/pos/handler.ts:3866`

The backend obeys it. The seller's two screens do not, and the gap is no longer cosmetic.

**1. The seller's detail states something false about money.** A cancelled folio with money paid
renders `Pagado $3,000` and then nothing. The admin's detail carries the outcome — *Se devuelve al
cliente* / *La empresa retiene* / *Saldo a favor* — because `GET /api/folios/:id` returns
`refund_status`, `refund_amount`, `credit_amount`, `credit_expires_at`, `refund_note` and
`cancellation_reason`; `GET /api/pos/folios/:id` returns none of them. The seller is the person
standing in front of the customer when that number is disputed (BUG-034). This is the same defect
`folio-state-machine.spec.md` fixed on the admin side under the name *"the `(reembolsado)` bug"* —
it survived on the surface nobody re-read.

**2. Two shipped promises are already broken in code.** `FolioTimeline.tsx:210` documents its own
violation — *"the POS detail does not carry it, so the seller's marker ships date-only"* — against
US-AG53, which promised the seller *"the same timeline the admin reads… identical by design"*. The
seller's timeline also renders no rejected petitions, because the page passes no `requests`.

**3. The seller's list is a generation behind.** `FolioHistoryPage.tsx` (102 lines) filters with an
**exclusive `ToggleButtonGroup`** — the precise construct US-A84 **D3** retired on the admin list,
having argued that exclusivity asserts a mutual exclusion the data never had. Its state lives in
`useState`, not the URL, so it is lost on every return from a detail. It has **no search**: US-A83
excluded the seller on the grounds that *"a seller's own history is bounded by their own sales"* —
true of collisions, false of scrolling, and the seller is the one the customer telephones. Its empty
state says *"Aún no tienes ventas registradas"* **even when a filter emptied it** — a sentence that
is simply untrue, and the exact failure US-A83 D15 fixed one screen over.

| | `/history` (seller) | `/folios` (admin) |
|---|---|---|
| Filter | exclusive `ToggleButtonGroup`, 5 tabs | `FilterPill` + multi-select `FolioStateSheet` |
| State | `useState` (lost on back) | the URL (`?estado=&q=&desde=&hasta=`) |
| Search | none | `FolioSearchField` + whole-history fallback |
| Empty state | *"Aún no tienes ventas"* — regardless of filters | names every active filter + *Quitar filtros* |
| Detail H1 | the literal word **"Folio"** | the customer's name |
| Pending work | a hand-rolled *Entregar boletos* `SectionCard` | the `FolioWorkActions` ladder |
| Money on a cancelled folio | silence | refunded · retained · credit |

**4. The object has three names.** The nav says **Ventas** for both roles; both list titles say
*Ventas*; the seller's back button says *Historial*; the admin's says *Folios*, as does its empty
state. Two of those names label a screen that does not exist under that name anywhere else.

**5. One asymmetry runs the other way.** The seller's detail renders the access QRs; the admin's
does not — so the admin taking the *"my QR doesn't scan"* call cannot see what the customer holds.

## Scope boundary

- **Authorization is untouched.** `foliosRouter.use('*', authMiddleware, requireRole('admin'))`
  (`routes/folios/index.ts:38`) stands, and `listAgentFolios` stays caller-scoped by
  `eq(folios.agentId, agent.userId)` — never from the request. No role gains a route.
- **No migration, no new column, no new mutation endpoint.** Every field this feature sends to the
  seller already exists and is already read by the admin. Nothing to backfill in the live org.
- `test/folios/folio-lifecycle-unification.test.ts`, `test/folios/folio-cancellation.test.ts` and
  `test/cash-drops/agent-balance-cash-drops.test.ts` must pass **unedited**.
- **The card and the timeline are not redesigned.** `FolioCard` and `FolioTimeline` already serve
  both surfaces; they gain data, not anatomy.
- **The admin list keeps every behaviour it has**, including its window + pending-work union, its
  server fallback search and its scope footer. Parity does not mean the seller's simpler read is
  imposed on the admin (D4).

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **One component per screen, parameterized by `surface`; two routes, two endpoints.** Not one route with a role-scoped read. | It is the move this codebase already made twice — `FolioCard` (US-A82 D13) and `FolioTimeline` (US-A24 D6) — and both times it was the fork, not the route, that caused the drift. Merging the routes would mean removing `requireRole('admin')` from a whole router and writing cross-org isolation tests for three roles, for **zero user-visible gain**: the routes are already disjoint by role. |
| **D2** | The shared screens live in **`features/folios/components/`**; `FoliosListPage` and `FolioHistoryPage` become wrappers that pass `surface` and nothing else. | `CLAUDE.md` — `pages/` is route assembly only. Keeping two thin pages also keeps both routes visible in `routes.ts`, which is where a reader looks to learn the product has two audiences. |
| **D3** | The seller inherits **search, URL-as-state and the facet sheet — and NOT the pending-work bar.** | US-AG50 already ruled *"no pending-work bar and no verb I am not allowed to press"*, and it was right for a reason that is now arithmetic: the seller can act on exactly one kind of pending work (undelivered tickets), which the facet sheet already carries as *Sin enviar* and the card already carries as its single button. A bar with one pill is not a bar. The other three rungs — verify, refund, approve — are capabilities the seller does not have. |
| **D4** | **The seller's list stays unbounded**, so its search is **local only**: no `q` on the server, no fallback query, no *"resultados de todo el historial"* banner, no scope footer. | `listAgentFolios` has no `LIMIT` and no window (`pos/handler.ts:3834-3841`) — the payload already **is** the seller's whole history, so a client-side facet computed over it answers about everything, which is exactly the honesty test US-A84 applied to the admin's union. The admin needed three mechanisms because its read is a window; importing them here would be ceremony around a question already answered. |
| **D5** | **A safety `LIMIT` of 500 rows on the seller's list, newest first, with the truncation stated in the payload and on screen.** | D4's honesty depends on the payload being complete; an unbounded read is a promise that expires quietly the day a seller passes a few thousand sales. 500 is a working number, not a measured one — see *Open*. A silent cap would be the lie the union was built to prevent, so `truncated: true` renders the same way the admin's fallback cap does. |
| **D6** | **One folio detail payload.** `GET /api/pos/folios/:id` returns the same shape as `GET /api/folios/:id`, built by **one shared serializer** both handlers call. `commission_amount` included. | Parity by convention drifts — that is the whole history in this file. Parity by shared function cannot. Commission is included because it is the seller's own earning, already visible aggregated in `/balance`; withholding the per-sale figure would be the single exception everyone has to remember, and exceptions are what this spec exists to delete. |
| **D7** | **Detail anatomy is identical; only the verbs differ.** H1 = the customer's name on both; `FolioWorkActions` gains `surface` (it hardcodes `"admin"` at line 220) and renders only rungs the surface may press — for a seller, delivery. The hand-rolled *Entregar boletos* `SectionCard` is deleted. | Two anatomies for *"what does this folio need from me"* is two things to keep in step, and the seller's copy was already the one that fell behind. `H1 = "Folio"` names the class, not the instance; the admin's header answers *whose sale is this*, which is the question both audiences open the screen with. |
| **D8** | **The access QR is information, not capability: the admin gets the same section, collapsed by default.** | *"My QR doesn't work"* reaches the admin, and today they cannot see what the customer is holding. The admin payload already carries the lines; collapsing it keeps the admin's daily reading — money and pending work — undisturbed. |
| **D9** | **The UI says «Venta» everywhere** — nav, both titles, both back buttons, both empty states. **«Folio» stays** the domain term, the printed ID and the glossary entry. Routes (`/folios`, `/history`) are unchanged. | *Ventas* is already the nav label for both roles and the title of both lists; the two dissenting strings are back buttons. A URL is not copy, and renaming routes would break links already in the wild (US-A84 D17 is still redirecting the last set). |
| **D10** | **Tests are parameterized by surface** (`describe.each(['admin','seller'])`) over what must be identical; what differs by capability gets its own assertions. | The invariant belongs in the file that would break it. This is the mechanism that makes the next divergence fail CI instead of surviving three releases. |
| **D11** | **`?date=` on the seller endpoint is replaced by `from`/`to`** — the admin endpoint's own parameter names, through the same `dateRangeFilter` helper — with no deprecation window. *(The URL the user sees keeps its Spanish `?desde=&hasta=`; that is the app's address bar, not the API.)* | It has **no call sites** — `MyFolioFilters.date` is dead code (`services/posService.ts:189`). Keeping a parameter alive out of habit is how a second date semantics survives; this one also matches UTC days, the defect US-A83 D9 named. |
| **D12** | **The seller's list query and the delivery-badge count share one cache key.** | `usePendingDeliveryCount` keys on `{status:'paid'}` while the list keys on `{}`; once the list reads unfiltered, they are the same read and the badge stops firing a second request. Consistency comes free with correctness here. |
| **D13** | **What stays different is named, and only three things are on the list:** the **verbs** (capability), the **byline** (audience — agent vs shift operator, US-A82 D13), and the **nav badge** (the work each role can do). | A parity spec that does not enumerate the permitted differences invites the next reader to erase them. |
| **D15** | **The list ROW is serialized once too** — `serializeFolioListRow` in `utils/folioListRows.ts`, called by both list handlers — and the two rows are byte-identical, `agent` included. | Found while building PR-2: the seller's row omitted `refund_status`, `refund_amount`, `credit_amount` and `payment_reference`, which the **shared `FolioCard` reads to choose its money reading**. So a cancelled sale on the seller's list rendered a degraded figure for exactly the reason its detail rendered `Pagado $3,000` — one payload, written twice. Sending `agent` to a surface that does not display it is the cheaper half of the trade: identical rows cannot drift, and which name is *shown* is already a client decision (D13). |
| **D14** | **The affiliate manager rides the seller surface unchanged**; the server's `?operator=` filter stays unexposed. | Out of scope, and it is a fourth axis the admin does not have — a facet section of its own, deserving its own story rather than a rider on this one (`TECH_DEBT.md`). |

## Data Model

**No migration.** Every field D6 adds to the seller payload already exists on `folios` and is
already read by `routes/folios/handler.ts:280-330`.

## Business rules (enforced server-side)

1. `GET /api/pos/folios` and `GET /api/pos/folios/:id` stay **caller-scoped** — `agent_id` is read
   from the session, never from the request. A seller cannot read another seller's folio.
2. The seller's list returns at most **500** rows, ordered `created_at DESC`, and sets
   `truncated: true` when it capped.
3. Both detail endpoints serialize through **one function**; a field added to it reaches both
   audiences or neither.
4. `commission_amount` on the seller's detail is **that folio's** commission — the same snapshot
   `/balance` aggregates. No new computation.
5. A cross-org read of either detail returns **404**, never 403.

## API surface

### `GET /api/pos/folios` — the seller's own sales

`?status=` (unchanged) · `?from=&to=` (**replaces** `?date=`; an inclusive **org-local** range, the
admin endpoint's parameters and helper) · `?operator=` (unchanged, still unexposed by the UI).
Response gains `truncated: boolean`, and every row is now `serializeFolioListRow`'s (D15).

### `GET /api/pos/folios/:id` — the seller's own folio

Gains, at folio level: `refund_status`, `refund_amount`, `refund_note`, `refunded_at`,
`credit_amount`, `credit_expires_at`, `cancellation_reason`, `cancelled_by`, `fulfillment`,
`folio_requests`, `commission_amount`. Line-level fields are already identical.

**No new error codes.**

## Frontend

`features/folios/components/FolioListScreen.tsx` and `FolioDetailScreen.tsx` (both new, both taking
`surface: 'admin' | 'seller'`); `pages/FoliosListPage.tsx` and `pages/FolioHistoryPage.tsx` reduce to
wrappers. `FolioWorkActions` gains `surface`. Deleted: the seller's `ToggleButtonGroup`, its
hand-rolled delivery card, and the duplicated loading/error/empty blocks.

Primitives per `CLAUDE.md`: `SectionCard` replaces the raw `<Card>` on both detail pages,
`MoneyText` keeps every figure, `FolioStatusChip`/`StatusChip` keep the chip row's fixed order
(money · clearance · debt · time). Design tokens: `.design/design-system/DESIGN_TOKENS.md`.

## Scenarios

### US-AG59 / BUG-034 — the seller's detail states the money outcome

**S-1 — A cancelled folio says where the money went**
Given a folio the seller sold, paid $3,000, cancelled under a 50% ladder
When the seller opens `/history/:id`
Then it reads *Se devuelve al cliente $1,500* and *La empresa retiene $1,500* — not `Pagado $3,000` alone.

**S-2 — A closed apartado states its credit and its expiry**
Given an apartado closed by the sweep leaving a credit valid to a date
When the seller opens its detail
Then the credit and *Vigente hasta …* render, in the same row the admin's detail uses.

**S-3 — The seller's timeline is the admin's timeline**
Given a folio with a rejected petition and a departed line
When both surfaces render `FolioTimeline`
Then the seller's shows the rejected petition row and the fulfilment-aware **Salida** marker — the
same rows, in the same order, as the admin's (closing the `FolioTimeline.tsx:210` gap).

### US-AG58 — the seller's list is the same list

**S-4 — Filters compose instead of excluding**
Given the seller has a cancelled folio with a refund still owed
When they select *Cancelado* and *Reembolso* in the state sheet
Then the folio appears — under the old exclusive toggle the question was unaskable.

**S-5 — The filter survives the detail**
Given a filtered list at `/history?estado=cancelado`
When the seller opens a folio and presses back
Then the same filter is still applied, because the URL carried it.

**S-6 — The empty state names what emptied it**
Given a query matching nothing
Then the screen names the active filters and offers *Quitar filtros* — never *"Aún no tienes ventas registradas"*, which stays reserved for a seller with no sales at all.

**S-7 — Search finds a sale from any time**
Given a sale from eight months ago
When the seller types the customer's name
Then it appears with no second request — the payload is their whole history (D4).

**S-8 — A capped list says so**
Given a seller with more than 500 folios
Then the list renders 500 and states that it is showing the most recent ones.

**S-14 — The two list rows are the same row**
Given one folio
When the seller's list and the admin's list are read
Then its row is **deep-equal** on both — `agent` included — because one function serializes it.

**S-9 — The seller still cannot act beyond their capability**
Given a folio awaiting payment verification
Then the seller's screen offers no *Verificar*, no *Confirmar reembolso*, no *Revisar solicitud* —
and no pending-work bar (D3).

### US-A93 — the admin can see the customer's tickets

**S-10 — The QR section exists on the admin detail, collapsed**
Given a paid folio with tickets
When the admin opens `/folios/:id`
Then *Boletos de acceso* is present and collapsed, and expands to the same `TicketQr` per line the seller sees.

### US-UX07 — one word

**S-11 — «Venta» everywhere**
Then no user-visible string reads *Historial* or *Folios* as the name of a screen; the printed folio
ID and the glossary keep the word *folio*.

### Multitenancy isolation (required)

**S-12 — Another org's folio is invisible to a seller**
Given two organizations seeded with `seedTwoOrgs`
When a seller of org A requests org B's folio via `GET /api/pos/folios/:id`
Then `404` — never `403`, which would confirm it exists.

**S-13 — Another seller's folio is invisible**
Given two sellers in the same org
When seller A requests seller B's folio
Then `404`, and seller B's sales never appear in A's list.

## Definition of Done

**PR-1 — the payload and the money (US-AG59, BUG-034)** ✅
- [x] Shared detail serializer; both handlers call it (`utils/folioDetail.ts`)
- [x] Seller detail renders refund outcome, credit, fulfilment, petitions, commission
- [x] S-1…S-3, S-12, S-13 covered (`test/folios/folio-surface-parity.test.ts`)
- [x] `BUGS.md` BUG-034 closed

**PR-2 — the shared list (US-AG58)** ✅
- [x] `FolioListScreen` + two wrappers; `ToggleButtonGroup` deleted
- [x] `?from=&to=` replaces `?date=`; `truncated` + `LIMIT 500`
- [x] One row serializer, both lists (D15)
- [x] S-4…S-9, S-14 covered; `FolioListScreen.test.tsx` parameterized by surface (D10)

**PR-3 — the shared detail (US-A93)**
- [ ] `FolioDetailScreen` + `FolioWorkActions surface`; hand-rolled delivery card deleted
- [ ] `SectionCard` on both; QR section on the admin, collapsed
- [ ] S-10 covered

**PR-4 — the vocabulary (US-UX07)**
- [ ] S-11; glossary updated

**All PRs:** `pnpm --filter api-turistear test` green · scope-boundary files unedited ·
frontend PRs additionally `tsc -b`, `pnpm lint:app`, `pnpm build:app`.

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| The affiliate's **operator** facet (`?operator=` exists server-side, unexposed) | It is a fourth axis, wanted by one role, and nothing regresses by leaving dead server capability dead one more release. |
| Merging the two routes behind one role-scoped read | D1 — no user-visible gain, and it would reopen an auth boundary this feature deliberately leaves alone. |
| Server-side search on the seller endpoint | D4 — the payload is already the whole history. It becomes necessary only when D5's cap starts biting. |

## Known behaviour change

- A seller opening a **cancelled** sale now sees what happened to the money. Nothing recalculates —
  the numbers were always there, on the admin's screen.
- A seller with **more than 500 sales** now sees their 500 most recent, stated. Before this they
  loaded all of them, which is why the cap is a change worth naming.
- The seller's filter now lives in the URL, so a shared or bookmarked link carries it.

## Open

- **Is 500 the right cap?** It is a working number chosen without production data. The smallest thing
  that would answer it: `SELECT agent_id, COUNT(*) FROM folios GROUP BY 1 ORDER BY 2 DESC LIMIT 5`
  against the live org. If the top seller is near it, D4's local-search premise expires and the
  fallback the admin already has becomes the answer.
- **Does the affiliate manager read this list as a seller or as an admin?** Today they get the
  seller's surface with an operator byline. If they turn out to reconcile rather than sell, the
  operator facet (D14) is not an enhancement but a missing half.
