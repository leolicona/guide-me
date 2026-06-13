# Guided Service Creation Wizard — Implementation Plan

Companion to `docs/catalog/service-wizard.spec.md` (US-A38…A44). Default path = **frontend-only
orchestration** (Decision D1). Each phase is independently shippable/reviewable and leaves the app
green (`tsc -b` + eslint).

> If the team chooses the composite atomic endpoint (Open Question 1), insert **Phase 0b** before
> Phase 3 — see the last section.

---

## Phase 0 — Scaffolding & shared helpers
**Goal:** the pieces every step reuses, with no UI wired yet.

1. `features/catalog/dates.ts` — `endOfMonth(today)`, `endOfYear(today)` returning `YYYY-MM-DD`,
   built on the device-local `todayStr()` (import from `features/pos/dates.ts`; do **not** use
   `toISOString()` — BUG-007). Pure functions.
2. `features/catalog/components/wizard/wizardTypes.ts` — `Frequency = 'single' | 'recurring'`,
   `DepartureTime = string`, `ExtraDraft = { name: string; price: number }`, `WizardStep = 1|2|3|4`.
3. `features/catalog/components/wizard/wizardSchema.ts` —
   - Reuse `serviceFormSchema` (core: steps 1–2 + capacity/quota).
   - Add `availabilitySchema` (frequency + single date *or* {weekdays, start_date, end_date}, ≥1
     departure time) mirroring `createScheduleSchema`'s `start ≤ end` + horizon refines.
   - Export `STEP_FIELDS: Record<WizardStep, (keyof ...)[]>` for `trigger()` gating.
4. **Unit tests** (vitest, app side if configured; else assert via the orchestration hook later)
   for `endOfMonth`/`endOfYear` around month/year boundaries and a UTC-6 evening clock.

**Done when:** helpers compile and are unit-checked; nothing rendered yet.

---

## Phase 1 — Wizard shell (US-A38)
**Goal:** a navigable empty 4-step modal.

1. `components/wizard/ServiceWizard.tsx`:
   - Props `{ open, onClose, onCreated(serviceId, failures) }`.
   - One `useForm` (resolver = combined wizard schema, `mode: 'onTouched'`), `defaultValues`
     mirroring `EMPTY` from `ServiceFormDialog` + `{ frequency: 'recurring', weekdays: [],
     start_date: '', end_date: '', single_date: '' }`. Local state: `step`, `times: string[]`,
     `extras: ExtraDraft[]`.
   - `Dialog` with responsive `fullScreen` (`useMediaQuery(theme.breakpoints.down('sm'))`),
     `PaperProps.sx` → mobile `{ height: '90vh', borderRadius: '16px 16px 0 0', m: 0,
     position: 'fixed', bottom: 0 }`; desktop `maxWidth="sm"`.
   - **Header** (sticky): "Nuevo servicio", `IconButton` X, "PASO {step} DE 4", `LinearProgress
     value={step/4*100}` (color secondary).
   - **Body**: `switch(step)` placeholder panels.
   - **Footer** (sticky, `borderTop: 1px divider`): **Anterior** (`disabled={step===1}`,
     `onClick` → `step-1`), **Siguiente/Guardar** (`step<4 ? next : save`).
   - `next()` = `await trigger(STEP_FIELDS[step])` then advance on success.
   - Close guard: if `formState.isDirty || times.length || extras.length` → confirm discard.
2. Wire `CatalogListPage`: replace the create-mode `ServiceFormDialog` with `ServiceWizard`
   (keep `ServiceFormDialog` import for edit on the detail page).

**Done when:** the modal opens from "Nuevo servicio", steps advance/retreat (empty bodies),
progress + indicator update, Anterior disabled on 1, footer flips to Guardar on 4.

---

## Phase 2 — Steps 1 & 2 (US-A39, US-A40)
1. `StepBasicInfo.tsx` — Nombre, Categoría (`CATEGORY_OPTIONS`), Descripción. Wire to the shared
   form via `register`/`setValue` (lift the category `setValue` pattern from `ServiceFormDialog`).
2. `StepPricing.tsx` — Precio base / Precio mínimo (`type="number"` + **`inputMode="decimal"`**,
   `$` adornment); commission `ToggleButtonGroup` (%/$) + Comisión field with the flipping
   adornment. Lift wholesale from `ServiceFormDialog` (lines ~212–366), adding `inputMode`.
3. Confirm `STEP_FIELDS[1] = ['name','category']`, `STEP_FIELDS[2] = ['base_price',
   'minimum_price','commission_type','commission_value']` and that the cross-field refines
   (min≤base, commission caps) surface on the offending field when blocking Siguiente.

**Done when:** Steps 1–2 validate and gate correctly; keypad opens on mobile; adornment flips.

---

## Phase 3 — Step 3 availability + departure times (US-A41, US-A42)
1. `StepAvailability.tsx`:
   - Capacity (`inputMode="numeric"`) + quota `ToggleButtonGroup` + Collapse flex-pct (reuse
     `ServiceFormDialog` capacity block incl. the live "~N lugares" helper).
   - Frequency `ToggleButtonGroup`. `single` → one date input (`min={todayStr()}`); `recurring`
     → `QuickSelectChips` + weekday `ToggleButtonGroup` (`WEEKDAY_LABELS`) + Desde/Hasta.
2. `QuickSelectChips.tsx` — three `Chip`s; tap sets `selected` + calls `setValue` for the
   range/weekdays per spec §4; visually highlight the active preset(s).
3. `DepartureTimes.tsx` — `type="time"` input + **Agregar** (`disabled` when empty); dedup-push to
   `times`; render removable `Chip` pills with `onDelete`. Controlled by the parent's `times`
   state (passed down with an `onChange`).
4. Gating: `STEP_FIELDS[3]` validates capacity/quota + the active frequency branch; **plus** a
   manual guard `times.length >= 1` (array state isn't an RHF field) — block Siguiente and show a
   helper ("Agrega al menos un horario de salida") when zero.

**Done when:** switching frequency swaps the controls; presets mutate fields; weekday multi-select
works; times dedup and remove; Step 3 blocks without a time.

---

## Phase 4 — Step 4 extras (US-A43)
1. `StepExtras.tsx` — empty state "Aún no hay extras"; inline Nombre+Precio (`inputMode="decimal"`)
   + **Agregar** (`disabled` until both non-empty); on add prepend to `extras`, render price in
   `success.main`, clear inputs; trash `IconButton` removes. Validate price via `extraFormSchema`.

**Done when:** add/clear/prepend/green-price/remove all behave; Step 4 saveable empty.

---

## Phase 5 — Save & compile (US-A44)
1. `hooks/useCreateServiceFull.ts` — a `useMutation` whose `mutationFn(payload)`:
   - `createService(core)` → `serviceId` (throws bubble up = clean fail, nothing else attempted).
   - `Promise.allSettled` of: per-time `createSchedule`/`createSlot`, per-extra `addExtra`.
   - returns `{ serviceId, failures: number }`. `onSuccess` invalidates `['services']`.
2. `ServiceWizard.save()` — build `core` (centavos via `amountToCents`, bps via
   `percentToBasisPoints`, Hard-Cap → `flex_capacity_pct: 0`), call the hook with a disabled
   footer + spinner. Route the result to `onCreated(serviceId, failures)`.
3. `CatalogListPage` — on `onCreated`: `failures === 0` → close + success Snackbar; else
   `navigate(CATALOG_DETAIL)` + warning Snackbar/Alert.

**Done when:** happy path creates a fully-sellable service end-to-end; forced child failure lands
on the detail page with a warning; service creation failure keeps the wizard open with the error.

---

## Phase 6 — Polish & verification
- Fade between steps; back preserves all entered data (verify times/extras survive step changes).
- Close-discard confirmation when dirty.
- `pnpm --filter app-guideme exec tsc -b` clean; `pnpm lint:app` clean.
- Manual mobile pass (DevTools device): 90vh sheet, rounded top, keypad types, sticky header/footer
  over a scrolling body.

---

## Verification gates (per CLAUDE.md / memory)
- **App:** `tsc -b` is the gate (exit 0) + `pnpm lint:app` (0 errors).
- **API:** untouched on the default path → no new API tests. **If Phase 0b is taken**, vitest is
  the gate and **cross-org isolation tests with `seedTwoOrgs` are mandatory** for the new route.
- Do **not** commit; leave the user's staged WIP (`AccountAvatarChip.tsx`, `AppLayout.tsx`,
  `PosCatalogPage.tsx`) untouched.

---

## Phase 0b — (only if Open Question 1 → composite endpoint)
Insert before Phase 3's save wiring; replaces Phase 5's orchestration with a single call.
1. `api-guideme/src/routes/services/schema.ts` — `createServiceFullSchema = { service:
   createServiceSchema, availability: { frequency, single_date? | {weekdays,start,end}, times[] },
   extras: createExtraSchema[] }` with the same refines.
2. `handler.ts` — `createServiceFull`: build the service row + materialized slots (extract the
   slot-materialization from `slots.handler.createSchedule` into a shared pure helper to avoid
   divergence) + extra rows, write in **one `db.batch`** (respect the 100-bound-param cap →
   reuse the derived `INSERT_CHUNK` chunking; BUG-012). All `organizationId` from context (Rule 1).
3. `index.ts` — `services.post('/full', zValidator(...), createServiceFull)`.
4. **Tests (`test/catalog/...`)** — happy path; **`seedTwoOrgs` cross-org isolation**; rollback on
   a bad slot (whole batch aborts, no orphan service); ≥12-time regression for the chunk cap.
5. Frontend: `useCreateServiceFull` calls the one endpoint; partial-failure UX in Phase 5 collapses
   to a single try/catch (atomic — no "navigate to detail with warning" branch).
