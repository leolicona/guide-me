# Feature: Finding one sale among a hundred

> Process: `docs/PROCESS.md`. Story **US-A83** (the admin *Ventas* list).
> Builds directly on `docs/oversight/folio-lifecycle-unification.spec.md` (US-A84), which already
> shipped the pill chassis, the `?estado=` URL contract and the load window this feature has to
> reach past. **Extends** its **D18** (a pending-work pill carries no date filter) and closes the
> promise made by its **D9** (*"`[Rango ▾]` reaches anything older"*), which nothing yet delivered.

## Context

The *Ventas* list has no search. An admin looking for *"the Isla Mujeres sale from the lady who
called"* scrolls, counting dates, through every folio the organization has made in the last 30 days.

That is the whole defect, and it is worse than it sounds for two reasons the data makes unavoidable:

**1. Names collide and names are absent.** Dev alone holds `Leo`, `leo` and `Leo Licona`. Express
sales carry **no name at all by design** (`express-sale.spec.md` **D17**) and render as
`Cliente ••1234`. Scanning by customer therefore fails exactly where the volume is highest — a busy
counter produces a run of near-identical rows.

**2. Since US-A84 the list is a window.** It loads the last 30 org-local days plus everything with
pending work. That was the right trade for honest facets, and it means an older sale is now
**unreachable by scrolling at all** — the rows simply are not there. US-A84 D9 promised
`[Rango ▾]` would reach them and left the promise unbuilt. Until this feature, "I can't find it" has
two indistinguishable causes: it is not on screen, or it is not loaded.

The screen already states the window (*"Últimos 30 días, más todo lo que tiene trabajo pendiente"*),
so the gap is visible and unactionable — which is the worst of the three possible states.

**What the server offers today:** one filter, `?date=YYYY-MM-DD` (`handler.ts:323-327`), matching a
**UTC** calendar day:

```sql
strftime('%Y-%m-%d', folios.created_at, 'unixepoch') = ?
```

US-A84 made the *window* org-local (rule 2) and left this one behind. For an organization in
`America/Cancun` (UTC−5) every sale after **19:00 local** falls on the next UTC day, so a naive
`[Hoy]` pill built on it would show the wrong day during the busiest hours of a beach counter.

## Scope boundary

- **The facet model is untouched.** `folioFacets.ts` gains nothing; search and date are separate
  axes that compose with it. `?estado=` keeps its exact meaning and encoding.
- **The union stays the union.** Pending work at any age is still loaded whenever no explicit date
  or query narrows the read (US-A84 rule 1). This feature only adds ways to *replace* the window,
  never to shrink set (a) silently.
- `test/folios/folio-lifecycle-unification.test.ts` must pass **unedited** — in particular S-1…S-4,
  which pin that the window cannot hide pending work, and **S-2b**, which derives its target day in
  UTC. D10 changes what `?date=` means, so S-2b looked like a casualty; it is not, because
  `seedTwoOrgs`/`seedUser` seed every test organization with `timezone = 'UTC'`
  (`test/helpers/tenancy.ts:47`), where the two calendars are the same one. **A test that seeds a
  UTC org can therefore never demonstrate D10** — S-9 below sets a real zone explicitly, and any
  future timezone assertion must do the same or it proves nothing.
- **The seller's list is out of scope.** `GET /api/pos/folios` gains nothing. A seller's own history
  is bounded by their own sales; the collision problem is an org-scale one.
- **No new screen, no new route.** Everything lands on `/folios`.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | **A fixed search field above the pill strip**, filtering on every keystroke. | It is the reported pain and it must not cost a tap to reveal. Filtering is in memory over a payload that is already loaded, so there is nothing to wait for — a debounce here would add latency to an operation that has none. |
| **D2** | **Five fields match: customer · phone · service · folio ref · seller/operator.** | Each is a real way a folio gets described out loud. The seller/operator field was requested explicitly, with its cost accepted: searching `Ana` returns both *customer* Ana and every sale *by* Ana. Stated once here so the behaviour is a decision on the record rather than a surprise. |
| **D3** | **Normalise both sides: lowercase, accents stripped, phone reduced to digits.** | `maria` must find `María`, and `9981234567` must find `+52 998 123 4567`. A search that is defeated by an accent is a search a Spanish-speaking user cannot trust. |
| **D4** | **When the local search finds nothing, ask the server** — `GET /api/folios?q=`, debounced, searching the whole history. | Chosen over an empty state that merely offers to widen the range. The window exists to bound the *default* read, not to bound what is findable; making the user first realise the sale is old, then open a calendar, then guess a range, is three steps to answer a question they already asked. The fallback fires only where the cheap path failed, so the common case stays instant. |
| **D5** | **Results from the fallback are LABELLED as coming from outside the window.** | Otherwise the list silently changes meaning: the same screen would show "everything recent" and "everything ever" with no way to tell which. The label is what keeps the window honest once it can be crossed. |
| **D6** | **The fallback is capped at 50 rows, and says when it capped.** | It is an unindexed `LIKE` scan over the whole table (TECH_DEBT #23 is bounded, not closed). A silent cap would report "these are the matches" when it means "these are the first 50" — the same lie the union was built to prevent, one layer down. |
| **D7** | **Accent-stripping on the server is done by an explicit `replace()` chain over the seven Spanish forms** (`á é í ó ú ü ñ`). | D1/SQLite has no `unaccent` and no ICU collation. The alternatives were a normalised column (a migration, and a second copy of every name that can drift) or accepting an accent-sensitive fallback (which would make the server disagree with the client — worse than ugly SQL, because the same query would give two answers). `ñ → n` is deliberate: `Muñoz` should find `Munoz`. |
| **D8** | **Date pills reuse the Reportes/POS language exactly**: preset pills plus a calendar pill that opens the shared `DateRangeSheet`. | The component, the sheet and the `FilterPill variant="date"` all exist and are already the app's filter vocabulary. Building a third date UI would be a third thing to keep consistent. |
| **D9** | **The presets are `Hoy` and `Ayer`, resolved in the ORGANIZATION's zone.** | Reportes computes its presets against the **UTC** day (`buildPresets`, `ReportsPage.tsx:48-62`) — the same defect as `?date=`, in a second place. This feature does not inherit it: `[Hoy]` means the counter's today. *(Reportes is not fixed here; recorded as debt.)* |
| **D10** | **The server gains `?from=`/`?to=`, resolved org-local; `?date=` becomes an alias for a one-day range and its UTC arithmetic is deleted.** | Two date filters with two time zones is how the wrong one gets used. Keeping `date` as an alias preserves every existing caller and test while leaving exactly one implementation of "which day is this". |
| **D11** | **A date range REPLACES the load window**, exactly as `?date=` already does (US-A84 rule 1). | The user has named the days they want. Applying both would let a range reach into the past and return nothing, which is how a working filter looks broken. |
| **D12** | **`?q=` also replaces the window**, and applies the caller's other filters. | A search that only searched the last 30 days would be a search with a hidden date filter — precisely what D4 exists to remove. |
| **D13** | **A pending-work pill CLEARS the search and the date range.** | Extends US-A84 **D18**. The banner's one promise is that its count equals what its pill shows (S-4); intersecting it with a leftover query or range breaks that promise silently. Tapping pending work means *"show me that work"*, not *"intersect it with whatever I had"*. |
| **D14** | **State in the URL: `?q=`, `?desde=`, `?hasta=`, written with `replace`.** | Same contract as `?estado=` (US-A84 D4) — derived every render, never seeded into state. A filtered list must be shareable and reload-stable, and a stored copy of something the URL already says will drift from it. |
| **D15** | **The empty state names every active filter**, not just the facets. | US-A84 already names the facets. A list emptied by a query, a range and a facet at once must say all three, or the user removes the wrong one. |

## Data Model

**No migration. No new column.** Every field searched already exists:

| Field | Source |
|---|---|
| Customer | `folios.customer_name` |
| Phone | `folios.customer_phone` (digits only, both sides) |
| Service | `folio_lines.service_name` — via `EXISTS`, so a folio with three lines matches once |
| Folio ref | `folios.id` prefix — the same 8 characters `{folio_ref}` renders (`delivery.ts:102`) |
| Seller / operator | `users.name` / `affiliate_operators.name` |

## Business rules (enforced server-side)

1. `?from=`/`?to=` (`YYYY-MM-DD`) filter `folios.created_at` by **org-local calendar day**,
   inclusive at both ends. Either may be given alone: `from` alone is open-ended forward, `to` alone
   open-ended back.
2. `?date=D` is exactly `?from=D&to=D`. Its former UTC comparison is removed.
3. A date filter **replaces** the load window; `window_days` is `null` in that response.
4. `?q=` matches, case- and accent-insensitively, any of: customer name, customer phone (digits
   compared to digits), a folio-line service name, the folio id prefix, the agent's name, the
   operator's name.
5. `?q=` **replaces** the load window and composes with `status`, `from`/`to`, `agent_id` and the
   rest — a query is a filter, not a different endpoint.
6. `?q=` returns at most **50** rows, newest first, and the response states `truncated: true` when
   more matched.
7. A `q` shorter than **2** characters after normalisation is ignored (no filter), because a
   one-character `LIKE %a%` scans the table to return everything.
8. *(Frontend mirror)* Local filtering uses the same five fields and the same normalisation. The
   server is asked only when the local pass yields zero.

## Authorization — who may do this

Unchanged: `authMiddleware` + `requireRole('admin')` on the whole router. `?q=` is scoped by the
same `eq(folios.organizationId, org)` every other read uses — a search that could reach another
organization's folios would be the worst possible place to lose tenancy, so **S-9** asserts it.

## API surface

### `GET /api/folios` — three new optional filters

| Param | Meaning |
|---|---|
| `from` | `YYYY-MM-DD`, org-local, inclusive |
| `to` | `YYYY-MM-DD`, org-local, inclusive |
| `q` | free text, ≥2 chars after normalisation |

Response gains one field:

```jsonc
{ "folios": [...], "window_days": null, "truncated": false }
```

### Error responses

None new. Malformed dates and short queries fall through to "no filter applied", matching every
other filter on this route.

## Frontend

**`features/folios/folioSearch.ts`** *(new)* — `normalize()` and `matchesQuery()`, the pure pair the
list and its tests share. Same five fields as the server, same normalisation.

**`features/folios/components/FolioSearchField.tsx`** *(new)* — the fixed field, with a clear
button.

**`pages/FoliosListPage.tsx`** — the field above the strip; `[Hoy] [Ayer] [📅 rango]` pills beside
the existing `[Estado]`; `?q=`/`?desde=`/`?hasta=` in the URL; the fallback query and its label; the
empty state naming all active filters.

**Reused unchanged:** `FilterStrip`, `FilterPill`, `DateRangeSheet`, `filterChipSx`.

## Scenarios

### US-A83 — finding one sale

**S-1 — The service name finds the sale**
Given a folio whose only line is *"Tour Isla Mujeres"*
When the admin types `isla`
Then that folio is listed — the customer's name was never typed.

**S-2 — Accents and case do not defeat it**
Given a folio for `María Fernández`
When the admin types `maria fernandez`
Then it matches (D3), and so does `MARIA`.

**S-3 — The phone matches by digits, however it is written**
Given `customer_phone = '+52 998 123 4567'`
When the admin types `9981234567`
Then it matches; and typing `998-123` also matches.

**S-4 — The seller is searchable, with its stated cost**
Given a sale to customer `Ana` and another sold by agent `Ana Ramírez`
When the admin types `ana`
Then **both** are listed. *(D2: accepted, not a defect.)*

**S-5 — A query below the floor is not a filter**
Given any list
When the admin types `a`
Then nothing is filtered and no request is made (rule 7).

**S-6 — Beyond the window, the server answers, and the screen says so**
Given a folio created 200 days ago for `Leo`, outside the 30-day window
When the admin types `leo` and the local pass returns nothing
Then the server is asked, the folio appears, and the list is labelled as reaching outside the
window (D5).

**S-7 — A capped fallback says it capped**
Given 80 folios match `tour` server-side
Then 50 are returned with `truncated: true`, and the screen says so rather than implying 50 is all
of them (D6).

**S-8 — A date range reaches past the window and replaces it**
Given a folio created 200 days ago with no pending work
When the admin picks a range containing that day
Then it is listed and `window_days` is `null` (D11).

**S-9 — `[Hoy]` means the organization's today**
Given an org in `America/Cancun` and a sale at `23:30` local (`04:30` UTC the next day)
When the admin taps `[Hoy]`
Then the sale is listed. *(Under the old UTC comparison it would not be — D9.)*

**S-10 — A pending-work pill clears the query and the range**
Given `?q=leo&desde=2026-01-01&hasta=2026-01-31` is active
When the admin taps `[2 Reembolsos]`
Then the URL carries only `estado=reembolso`, and the list shows both refunds — the banner's count
and its destination still agree (D13, US-A84 S-4).

**S-11 — The empty state names every filter**
Given a query, a range and a facet are all active and nothing matches
Then the message names all three and offers to clear them.

### Multitenancy isolation (required)

**S-12 — A query never reaches another organization**
Given `seedTwoOrgs`, **each** org holding a folio for a customer named `Leo`
When org A's admin searches `leo`
Then exactly org A's own folio comes back — same-org attribution, so a dropped scope returns two
rows and fails this. A foreign-row-*absence* assertion alone would not, for the reason
`folio-lifecycle-unification.spec.md` S-18 records.

*Measured during the build, and stated because the opposite is easy to assume: the org scope inside
the service-name `EXISTS` subquery is **redundant**. Removing it leaves the suite green, because the
subquery keys on `folio_lines.folio_id = folios.id` and `folios` is already scoped by the outer
`filters` — a foreign line can only attach to a folio the outer query has already excluded. It is
kept as defence in depth, matching the decorations, and **isolation on this route rests on
`eq(folios.organizationId, org)`** in the main query, as it always has.*

## Definition of Done

**Backend**
- [ ] `from`/`to` org-local; `date` re-expressed as their alias, UTC arithmetic deleted
- [ ] `q` — the five fields, the `replace()` accent chain (D7), the 2-char floor, the 50 cap
- [ ] `truncated` in the response; `window_days` null whenever a date or query narrows
- [ ] S-1…S-9 in `test/folios/folio-list-search.test.ts`
- [ ] S-12 with `seedTwoOrgs`, mutation-verified
- [ ] `folio-lifecycle-unification.test.ts` passes **unedited**

**Frontend**
- [ ] `folioSearch.ts` + tests (the five fields, the normalisation, the floor)
- [ ] `FolioSearchField`, the date pills, the fallback and its label
- [ ] URL contract `?q=`/`?desde=`/`?hasta=`; pending-work pill clears them (D13)
- [ ] Empty state names every active filter
- [ ] **Verified visually at 320 / 390 / 1280px** — the strip now carries four pills plus a field

**Documentation**
- [ ] `SPEC.md`: US-A83, the *Features by Phase* line, glossary
- [ ] TECH_DEBT: the Reportes UTC presets (D9), and the unindexed search scan (D6)

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Seller-side search** | Their list is their own sales; the collision problem is org-scale. |
| **An index for `q`** | The fallback is capped and deliberate. An index over five columns and a joined table is a schema decision that wants real query logs first. |
| **Fixing Reportes' UTC presets** | Same defect, different screen; fixing it here would put two unrelated changes in one revert. |

## Known behaviour change

**`?date=` changes meaning at the day boundary.** It becomes the organization's calendar day rather
than UTC's. For an org in `America/Cancun`, a sale made at 20:00 on the 5th was previously returned
by `?date=` for the **6th**; it now answers for the **5th**, which is the day the seller would name.
No stored data changes — only which rows a query returns.

## Open

| Question | The smallest change that would answer it |
|---|---|
| Should the fallback fire on a slow connection, or wait? | It is debounced; if it proves noisy, raise the debounce. One constant. |
| Is 50 the right cap? | Raise it. It exists to bound an unindexed scan, not because 50 is meaningful. |
| Should `q` search cancelled folios' resolution notes? | Add one `OR` to the predicate. Left out because nobody has asked to find a sale by its rejection note. |
