# Feature: Organization Time Zone — One Org-Local Clock for Agents, Affiliates & Customers

**User story:** US-A66 (admin sets the organization's time zone; the whole product — catalog day,
sale-cutoff/expiry math, and audit timestamps — reflects that single org-local clock for agents,
affiliates, and customers). To register in `docs/SPEC.md`. **Phase:** 2 (Core Enhancements) ·
**admin-set · app-wide surface.**

**Depends on:** *Org Booking Policy* (US-A46/A47) — the `organizations` row and Settings panel this
extends; the departure-relative offsets (`sales_cutoff_offset_minutes`, `booking_grace_offset_minutes`)
whose "now" this fixes · *POS Catalog Availability* (US-AG30) — the rolling "today … today+2" window ·
*Signed QR Tickets* (`docs/qr/folio-qr-signing.spec.md`) — `ticketExpiry`.

> **What & why.** The product has **no concept of the operator's time zone.** Three unrelated
> mechanisms each guess "now" a different way, and they disagree:
>
> | Time class | Where | How "now"/tz is decided today | Problem |
> |---|---|---|---|
> | **Catalog "today"** | `dates.ts:todayStr()` → `?today=` | the **agent's device** clock | per-device; two agents near midnight see different catalogs |
> | **Scheduling math** (sales cutoff, same-day booking grace, booking + ticket expiry) | `pos/handler.ts` `slotEpoch`, `salesThresholdStr`, `ticketExpiry`, `bookingExpiryDate` | **naive-UTC** — a slot stored `"19:00"` is compared as 19:00 **UTC** | this is the code's own **BUG-007**: for a UTC−6 org the cutoff fires **6h off** |
> | **Absolute audit timestamps** (folio created, payment, cash drop, reminder sent) | `toLocaleString(undefined, …)` across pages | the **viewer's browser** tz | an admin abroad sees different times than the agent who made the sale |
>
> This feature gives the organization **one configured IANA time zone** and routes all three through
> it, so "the current time" means the same instant for every agent, affiliate, and customer of that
> org — and BUG-007 is closed.

---

## Context

**Stored slot times were always meant as org-local wall-clock.** Slots persist as naive
`date` (`YYYY-MM-DD`) + `startTime` (`HH:MM`) strings, compared lexicographically. They carry **no
zone** — the code just *pretended* they were UTC. Adding a real org tz **reinterprets** those same
strings correctly; **no slot data migration is needed** — only the "now" they are compared against
changes.

**Read paths already load the org.** `availability`, the monthly scan, and the matrix each already
`SELECT … FROM organizations` and call `salesThresholdStr(nowSec, cutoffOffset)`. Injecting the org
tz there is free — the row is already in hand.

**Cloudflare Workers support `Intl.DateTimeFormat` with `timeZone`.** Org-local "today" and the
org-local epoch of a naive wall-clock string are computable server-side without a date library.

**The offsets are timezone-independent deltas.** `sales_cutoff_offset_minutes` and
`booking_grace_offset_minutes` are minutes **relative to departure** (+ before / − after). They keep
their exact current meaning and UI; the tz only fixes the wall-clock instant "now" resolves to.

---

## Decisions (grilled & confirmed)

- **D1 — Granularity: org-level, no per-user override.** One `timezone` on `organizations`, admin-set.
  Everyone (agents, affiliates, walk-up customers) is physically at the tour location; per-user tz
  would reintroduce the drift being removed. A traveling admin reviewing reports sees **org-local** —
  which is what "when did this sale happen" should mean.
- **D2 — Scope: all three time classes,** delivered together (display + catalog anchor + scheduling
  math / BUG-007). One root cause; leaving any one unfixed keeps "current time" disagreeing somewhere.
- **D3 — Format: IANA identifier** (e.g. `America/Mexico_City`), stored `text`, **not** a raw offset.
  Mexico spans −6/−5/−8 and the northern border strip **still observes US DST** after the 2022
  national abolition — an IANA name handles DST + multi-zone; a fixed offset silently breaks twice a
  year on the border.
- **D4 — Default + backfill: `notNull().default('America/Mexico_City')`,** and a data migration
  backfilling every existing org to `America/Mexico_City`. The product is entirely `es-MX`; CDMX is
  the safe universal default, admins re-pick if wrong.
- **D5 — Settings picker: curated Mexican-zone `Select` (5 options),** not a 400-entry IANA list:

  | Label (es-MX) | IANA |
  |---|---|
  | Centro (CDMX, Guadalajara, Monterrey) | `America/Mexico_City` |
  | Sureste (Cancún, Quintana Roo) | `America/Cancun` |
  | Pacífico (Sonora) | `America/Hermosillo` |
  | Noroeste (Sinaloa, Baja California Sur) | `America/Mazatlan` |
  | Frontera Noroeste (Tijuana) | `America/Tijuana` |

  Covers every mainland Mexico offset in five human labels. (If non-Mexico operators ever onboard,
  swap in a grouped searchable autocomplete — out of scope now.)
- **D6 — Catalog "today" anchors to org tz (retiring the device-clock guess).** The client keeps
  computing `today` locally for an instant UI, but from the **org's tz** (via `Intl` + the tz it
  already gets from `useMyOrganization`) instead of the device clock. The server's `utcToday()`
  fallback **also** becomes org-local, so both agree even if `?today=` is omitted.
- **D7 — One branch, one PR** (`feat/organization-timezone`), like the WhatsApp feature — the three
  logical parts (schema+Settings+display · catalog anchor · scheduling math) ship together.
- **D8 — Out of scope this pass:** the offsets' meaning/UI are untouched; the **customer portal
  display stays as-is** (it renders already-org-local wall-clock strings with `timeZone:'UTC'`, which
  is visually correct) — it only needs the tz if we later show a live "sold at / expires at" clock.

---

## Data model

`organizations` gains:

```ts
// IANA time-zone identifier (e.g. 'America/Mexico_City'). The single org-local clock all three
// time classes resolve against: catalog "today", sale-cutoff/grace/expiry math (closes BUG-007),
// and audit-timestamp display. Stored strings for slots stay naive wall-clock — this only fixes
// the "now" they compare against. Curated Mexican-zone picker in Settings (D5).
timezone: text('timezone').notNull().default('America/Mexico_City'),
```

**Migration** (folder-scan `readD1Migrations`, no journal): `ADD COLUMN timezone TEXT NOT NULL
DEFAULT 'America/Mexico_City'` — the default backfills every existing row in place (D4).

---

## Server changes (`api-turistear/`)

A small tz utility (`utils/tz.ts`) replaces the naive-UTC helpers:

- `orgToday(tz): 'YYYY-MM-DD'` — org-local calendar date via
  `Intl.DateTimeFormat('en-CA', { timeZone: tz })` (ISO-shaped output). Replaces `utcToday()`.
- `naiveEpoch(date, time, tz): number` — the real UTC epoch (seconds) of a wall-clock `date`+`time`
  **in `tz`**, resolving the zone's offset for that instant (handles Cancún −5 vs CDMX −6, and DST on
  the border). Replaces `slotEpoch` and the `Date.parse(...Z)` in `salesThresholdStr` / `ticketExpiry`.
- `salesThresholdStr` / `sellableSlotSql` — the lexicographic SQL predicate is preserved, but the
  threshold string is now the org-tz wall-clock of `now + offset` (so it compares against the naive
  `date||'T'||time` correctly), instead of a UTC instant.

Touch points (org row already loaded at each): `availability`, monthly scan, matrix, `confirmSale`
sellability guard, `reactivate`, `bookingExpiryDate`, `ticketExpiry`. `organizations` schema + handler
+ Zod: accept/serialize `timezone` (validate against the D5 allow-list).

## Client changes (`app-turistear/`)

- `organizationsService.ts` — `timezone` on `MyOrganization` + `UpdateOrganizationInput`.
- `features/pos/dates.ts:todayStr()` — takes the org tz and computes org-local today via `Intl`
  (falls back to device only if tz missing); its callers already have the org via `useMyOrganization`.
- **Audit-timestamp display** — the shared `toLocaleString(undefined, …)` formatters
  (`FoliosListPage`, `FolioHistory*`, `Cash*`, `Balance`, `CancellationRequestsTab`,
  `TuCajaSection`, reminder-sent time) pass `timeZone: <org tz>` so every viewer sees org-local time.
- `SettingsPage.tsx` — a `Select` (D5 options) inside the existing booking-policy `SectionCard`;
  add `timezone` to the dirty-signature string and the save payload.

---

## Acceptance criteria (US-A66)

1. **Admin sets tz.** Settings shows a Zona horaria dropdown (5 curated options), defaulting to the
   org's current value; saving persists it and the panel reflects the new value on reload.
2. **Catalog day is org-anchored.** Two agents on devices in different zones see the **same** "hoy"
   catalog for the org; near local midnight the day rolls at the **org's** midnight, not the device's.
3. **BUG-007 closed.** For a non-UTC org (e.g. `America/Cancun`, −5), a slot's sale-cutoff and
   same-day booking-grace fire at the **org wall-clock instant**, not 5h off. Covered by cutoff/grace
   tests seeded at a non-UTC offset.
4. **Ticket/booking expiry** are computed from the org-local slot instant.
5. **Audit timestamps** (folio created, payment, cash drop, reminder sent) render in **org-local**
   time regardless of the viewer's browser zone.
6. **No slot data migration**; existing slots keep their stored strings and simply resolve against the
   org tz. Existing orgs backfill to `America/Mexico_City`.
7. **Cross-org isolation** unaffected — `timezone` is org-scoped; one org's tz never leaks into
   another's reads (existing `seedTwoOrgs` isolation test extended).

## Definition of Done

- Migration applied local + remote; `cf-typegen` clean.
- `utils/tz.ts` unit-tested (org-local today across a day boundary; `naiveEpoch` at −5/−6/−8 and a
  border-DST date).
- Cutoff/grace/expiry tests re-seeded at a non-UTC org tz prove the wall-clock fix.
- `pnpm build:app` + `pnpm lint:app` clean; Settings dropdown verified end-to-end.
- Registered in `docs/SPEC.md` (US-A66 + feature-list entry).
