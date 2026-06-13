# Guided Service Creation Wizard — Feature Spec

**Stories:** US-A38 … US-A44 · **Phase:** 2 (Core Enhancements) · **Surface:** `app-guideme` (admin)
**Refines:** US-A09 (service), US-A10 (schedules/slots), US-A11 (extras), US-A12 (commission),
US-A36 (Hard/Soft Cap), US-A37 (category). **Pattern sibling:** US-AG31 (POS Bottom Sheet — a
re-homing of existing logic into a new shell).

---

## 1. Summary & Intent

Today an admin creates a sellable service in **three disjoint actions across two screens**:

1. `CatalogListPage` → **"Nuevo servicio"** opens `ServiceFormDialog` (a `maxWidth="sm"` dialog)
   → `POST /api/services` creates the **core** (name, category, description, prices, capacity,
   capacity mode, commission).
2. The admin lands on `CatalogDetailPage` and adds **extras** one-by-one (`ExtrasPanel` →
   `POST /api/services/:id/extras`).
3. …and adds **availability**: a recurring weekly schedule (`ScheduleFormDialog` →
   `POST /api/services/:id/schedules`, which materializes slots) and/or single-date slots
   (`SlotFormDialog` → `POST /api/services/:id/slots`).

A field operator on a phone faces a dense form, then has to *discover* that the service isn't
sellable until they scroll a detail page and add schedules. The Wizard collapses this into **one
guided 4-step modal** that produces a complete, immediately-sellable service.

**This feature adds no new service field and no migration (default path).** It reorganizes and
orchestrates endpoints that already exist and are tested. The novel parts are purely frontend:
the wizard shell, per-step gating, the quick-select date presets, and the multi-time departure
builder.

### Out of scope
- **Editing** an existing service. The Wizard is **create-only**. Edit keeps `ServiceFormDialog`
  (core) plus the rich `SchedulesSection` / `ExtrasPanel` on the detail page — those already
  handle the hard "which slots are already booked/materialized" cases the Wizard shouldn't reopen.
- Per-schedule capacity overrides. The Wizard collects **one** capacity (the service
  `default_capacity`); the API still accepts per-schedule overrides for power users on the detail
  page.
- Meeting points / itinerary metadata (not modeled yet).

---

## 2. Decisions (defaults chosen — see §9 Open Questions)

| # | Decision | Default | Why |
|---|---|---|---|
| **D1** | **Persistence: one transactional endpoint vs. frontend orchestration** | **Frontend orchestration** (create service, then fan out schedules/slots + extras) | Zero backend/migration; reuses 4 battle-tested endpoints; a service with not-yet-added slots is *already* the normal state between today's steps, so a partial failure is not a new failure mode. Hardening to a composite atomic endpoint is the Open-Question follow-up. |
| **D2** | **Edit support** | **Create-only** | Editing schedules/extras post-hoc already has dedicated, safer UI; cramming it into the Wizard reopens materialized-slot/booked-slot complexity. |
| **D3** | **Departure-time → inventory mapping** | Each distinct time = **one** schedule (recurrence) or **one** slot (single date) | Existing `createSchedule`/`createSlot` take a single `start_time`; N times ⇒ N calls. |
| **D4** | **Quick-select presets** | Frontend-only computation of `weekdays` + `start_date`/`end_date` | No backend concept needed; bounded by the existing `MAX_HORIZON_DAYS`. |
| **D5** | **"Today" anchor for presets & calendar `min`** | Device-local `todayStr()` (`features/pos/dates.ts`) | BUG-007: `toISOString()` rolls over early in UTC-6. Reuse the fixed helper. |

---

## 3. The Wizard Shell (US-A38)

A single modal component `ServiceWizard` replacing `ServiceFormDialog` as the **create** entry
point from `CatalogListPage`.

**Layout**
- **Mobile** (`< sm`): `fullScreen`, height `90vh`, **rounded top corners** (`borderRadius:
  '16px 16px 0 0'`), bottom-anchored — a sheet, not a centered card. **Desktop**: centered,
  `maxWidth="sm"`, full rounded corners, capped height with internal scroll.
- **Fixed header** (does not scroll): title **"Nuevo servicio"**, a close **X** (right), and a
  step indicator **"PASO {n} DE 4"**. Directly below, a **`LinearProgress`** with
  `value = (step / 4) * 100`.
- **Scrollable body**: the active step's fields only.
- **Fixed footer** (does not scroll): left **Anterior** (`disabled` on Step 1), right
  **Siguiente** — which becomes **Guardar** on Step 4. The footer button is the step's submit.

**Navigation rules**
- **Anterior** disabled on Step 1; otherwise decrements the step (never validates — going back is
  always free and preserves entered data).
- **Siguiente** validates *only the current step's fields* (RHF `trigger(stepFields)`); on
  failure it surfaces inline errors and does not advance.
- **X** / backdrop / Esc: if any field is dirty, confirm discard ("¿Descartar este servicio?");
  otherwise close immediately. Closing resets all wizard state.

**State model:** one `react-hook-form` form holds the whole wizard (so back/next preserves data
and final compile is trivial). Local component state holds the **departure-times array** and the
**extras draft array** (these are list builders, not single fields). `step` is `useState<1|2|3|4>`.

---

## 4. Step specs

### Step 1 — Basic Information (US-A39)
Fields: **Nombre** (text, required), **Categoría** (`CATEGORY_OPTIONS` dropdown, required —
the US-A37 closed enum, starts blank), **Descripción** (multiline, optional).
**Gate:** *Siguiente* blocked until `name` non-empty **and** `category` is a valid enum value.

### Step 2 — Pricing & Commissions (US-A40)
Fields: **Precio base** and **Precio mínimo** — `type="number"` **plus `inputMode="decimal"`**
(opens the numeric keypad on mobile; the existing form omits `inputMode`), `$` start adornment.
Commission: a **segmented `ToggleButtonGroup`** *Porcentaje (%)* / *Monto fijo ($)* bound to
`commission_type`; the **Comisión** field's adornment flips — `%` end-adornment for percent,
`$` start-adornment for fixed (reuse the existing adornment-swap from `ServiceFormDialog`).
**Validation (step-advance + live):** `minimum_price ≤ base_price`; percent ≤ 100; fixed ≤
`minimum_price` (mirrors the backend `createServiceSchema` refines — reuse `serviceFormSchema`).

### Step 3 — Availability & Departure Times (US-A41, US-A42)
**Capacity & quota**
- **Capacidad** (`type="number"`, `inputMode="numeric"`, min 1) → `default_capacity`.
- **Tipo de cupo**: `ToggleButtonGroup` *Estricto* / *Flexible* → `is_flexible`. Selecting
  *Flexible* reveals **Lugares extra permitidos** (`flex_capacity_pct`, 1–`FLEX_CAP_MAX_PCT`),
  with the existing live "~N lugares" helper and the save-block when empty/0 (US-A36). Reuse the
  exact controls from `ServiceFormDialog`.

**Frequency**
- **`Frecuencia`**: `ToggleButtonGroup` *Fecha única* / *Recurrente*.
- **Fecha única** → a single **date picker** (`type="date"`, `min = todayStr()`). Departure times
  attach to *this* date.
- **Recurrente** →
  - **Quick-select chips** (horizontal, scrollable): **Resto del año**, **Resto del mes**,
    **Fines de semana**. Tapping highlights the chip (`color="secondary" variant="filled"`) and
    applies its effect:
    - *Resto del mes*: `start_date = hoy`, `end_date =` last day of the current month.
    - *Resto del año*: `start_date = hoy`, `end_date = ` Dec 31 of the current year (≤ horizon cap).
    - *Fines de semana*: toggles weekdays Sat+Sun **on** (does not touch the date range).
    Chips are conveniences that mutate the fields below; the operator can still hand-edit after.
  - **Días de operación**: weekday initials **L M M J V S D** as a multi-select
    `ToggleButtonGroup` (reuse `WEEKDAY_LABELS` / the `ScheduleFormDialog` weekday control).
    *(Note: `WEEKDAY_LABELS` is Sunday-indexed 0–6 to match the API; the row renders in the
    locale's Mon-first visual order while preserving the 0–6 values.)*
  - **Desde** / **Hasta** date inputs (`type="date"`). `Desde ≤ Hasta`, window ≤
    `MAX_HORIZON_DAYS` (mirror `createScheduleSchema`).

**Departure times (US-A42)** — shared by both frequencies:
- A **`type="time"`** input + **Agregar** button (`disabled` while the input is empty).
- On add: push to the `times: string[]` array as a removable **`Chip`** pill; **reject
  duplicates** (no-op if already present). Each pill has an **X** (`onDelete`) to remove it.
- **Gate:** *Siguiente* requires **≥ 1 departure time** and a valid date context (single date set,
  or recurrence with ≥ 1 weekday + valid range). A service with no time is not sellable.

### Step 4 — Extras (US-A43)
- Empty state text **"Aún no hay extras"** when the draft list is empty.
- Inline **Add Extra** form: **Nombre** (text) + **Precio** (`type="number"`, `inputMode=
  "decimal"`, `$`). **Agregar** is `disabled` until **both** fields have content.
- On add: **prepend** the extra to the list (newest on top), render name + **price in green**
  (`color="success.main"`), and **clear both inputs**. (Reuse `extraFormSchema` for price parsing.)
- Each listed extra has a **trash** `IconButton` to remove it from the draft.
- Extras are optional — Step 4 can be saved empty.

---

## 5. Save & compile (US-A44)

Footer button reads **Guardar** on Step 4. On tap (with a global "saving" spinner + disabled
footer):

**Orchestration (D1 — frontend):**
1. `POST /api/services` with the compiled **core** (name, description, base/min price in centavos,
   `default_capacity`, `category`, `commission_type`, `commission_value`, `is_flexible`,
   `flex_capacity_pct`) — exactly today's `ServiceInput`. → obtain `service.id`.
   - On failure: stay on Step 4, surface the error, **nothing persisted**. (Clean rollback —
     no child writes attempted yet.)
2. With `service.id`, fan out (`Promise.allSettled`):
   - **Availability:** for each departure **time** →
     - *Recurrente*: `POST /:id/schedules` `{ weekdays, start_time: time, start_date, end_date }`.
     - *Fecha única*: `POST /:id/slots` `{ date, start_time: time }`.
   - **Extras:** for each draft → `POST /:id/extras` `{ name, price }`.
3. **Outcome:**
   - All fulfilled → close wizard, invalidate `['services']`, **success Snackbar** on the catalog
     ("Servicio creado").
   - Service created but ≥ 1 child rejected → close wizard, navigate to the new service's
     **detail page**, show a **warning** ("Servicio creado — revisa horarios/extras") so the
     operator finishes the few that failed with the existing detail-page tools. The service is
     never left invisible; it's editable in place.

> **Atomicity note (D1):** this is *not* all-or-nothing. The partial state (service without some
> slots) is identical to the current steady state between today's manual steps, and is fully
> recoverable on the detail page. §9 tracks the composite-endpoint hardening if true atomicity is
> required.

---

## 6. Affected files (default / frontend-only path)

**New** (`app-guideme/src/features/catalog/`)
- `components/wizard/ServiceWizard.tsx` — shell (header, progress, body switch, footer, save).
- `components/wizard/StepBasicInfo.tsx`, `StepPricing.tsx`, `StepAvailability.tsx`,
  `StepExtras.tsx`.
- `components/wizard/DepartureTimes.tsx` — time input + dedup pill list.
- `components/wizard/QuickSelectChips.tsx` — presets → field mutations.
- `wizard/wizardSchema.ts` — per-step Zod slices + the combined wizard schema; `wizardTypes.ts`.
- `hooks/useCreateServiceFull.ts` — the orchestration mutation (wraps the 4 calls, returns
  `{ serviceId, failures }`).
- `features/catalog/dates.ts` *(or reuse `features/pos/dates.ts`)* — `endOfMonth`, `endOfYear`
  preset helpers on top of `todayStr`.

**Changed**
- `pages/CatalogListPage.tsx` — "Nuevo servicio" opens `ServiceWizard` (not `ServiceFormDialog`);
  add the success/warning Snackbar.
- `features/catalog/index.ts` — export the wizard.

**Reused unchanged:** `serviceFormSchema`/`extraFormSchema`, `amountToCents`/`centsToAmount`/
`percentToBasisPoints`, `CATEGORY_OPTIONS`, `WEEKDAY_LABELS`, `FLEX_CAP_MAX_PCT`,
`catalogService.createService/addExtra`, `createSchedule`/`createSlot` service clients,
`todayStr()`. **No API, schema, or DB change** on this path.

---

## 7. Design-system conformance
Elegant-minimalist: `elevation={0}` surfaces, 1px divider on the fixed header/footer, 8–12px
radii, `LinearProgress` in the accent (`secondary`) color, subtle Fade between steps, segmented
`ToggleButtonGroup` for the binary choices (quota, frequency, commission type), `Chip` pills for
times and presets. Spanish-MX copy throughout (matches the codebase; i18n is a separate SHOULD).

---

## 8. Definition of Done
- [ ] Wizard is the create entry point; full-screen 90vh rounded on mobile, centered on desktop.
- [ ] Header (title/X/"PASO n DE 4") and footer (Anterior/Siguiente→Guardar) are fixed; progress
      bar tracks the step; Anterior disabled on Step 1.
- [ ] Per-step gating: Step 1 needs name+category; Step 2 enforces min≤base & commission caps;
      Step 3 needs ≥1 time + valid date context; Step 4 optional.
- [ ] Prices/capacity open the mobile numeric keypad (`inputMode`); commission adornment flips $/%.
- [ ] Quick-select chips highlight and set weekdays/date range; operating-day initials multi-select;
      single-date hides the recurrence controls.
- [ ] Departure times: Add disabled when empty, dedup, removable pills; ≥1 required.
- [ ] Extras: empty state, Add disabled until both filled, prepend with green price, inputs clear,
      trash removes.
- [ ] Guardar compiles & persists; success → close + Snackbar; partial failure → detail page +
      warning. Catalog list reflects the new service.
- [ ] `tsc -b` clean, eslint clean. (Frontend-only path adds no API tests; if D1→composite is
      chosen, cross-org isolation tests via `seedTwoOrgs` are **required**.)

---

## 9. Decisions confirmed (2026-06-13) + remaining question
1. **Atomicity (D1) — CONFIRMED: frontend orchestration.** Create service, then fan out
   schedules/slots + extras; partial failure → detail page + warning. No backend/migration; Phase
   0b (composite `POST /services/full`) is **not** taken unless revisited.
2. **Edit (D2) — CONFIRMED: create-only.** The detail page + `ServiceFormDialog` remain the home
   for iteration.
3. **Capacity (scope) — CONFIRMED: one service-level capacity** (`default_capacity`) for all
   times/days. Per-schedule overrides stay available on the detail page only.
4. **"Fines de semana" semantics (open, minor).** Default = toggles Sat+Sun weekdays only (leaves
   the date range alone). Can adjust during build if it feels incomplete in testing.
