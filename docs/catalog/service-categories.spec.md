# Feature: Service Categories & POS Catalog Filtering

## Context

Today the catalog is a flat, name-ordered list. As an org grows its offering
(lodging, tours, dining, …) both the admin catalog and the agent POS become hard
to scan. This feature gives every service one **primary category** from a closed
enum, set on the catalog form, so the POS can group the catalog and let an agent
narrow it down with a **single tap**.

The admin picks the category in the catalog service form (a required dropdown).
The value persists on `services` and is echoed by the POS catalog read. The POS
renders one filter chip per category **that actually has an available service** —
a category with no services never shows an (empty) filter.

**User Story:** **US-A37** (assign a primary category on create/edit; persisted on
`services`; surfaced in the POS catalog payload; drives the POS filter chips).

**Builds on:**
- `docs/catalog/service-catalog.spec.md` — the `services` table and the admin-only
  `POST`/`PUT /api/services` form this feature extends with one column/field.
- `docs/catalog/flexible-capacity.spec.md` — the closest precedent: an additive,
  default-safe `services` column (US-A36) surfaced through the catalog + POS reads.
  This feature mirrors its shape (migration, schema, serializer, Zod, POS payload).
- `docs/pos/pos-controlled-discount.spec.md` — the POS catalog read
  (`GET /api/pos/services`, `listPosServices`) the filter chips are derived from.

**Out of scope (own features / later):**
- Multiple categories / tags per service. MVP is **one** primary category (a single
  `text` column). A many-to-many tag system is a later feature, not this one.
- A user-managed category taxonomy. The five categories are a **closed code enum**
  (like `commission_type`), not an admin-editable table.
- Filtering the **admin** catalog list. US-A37's filter requirement is POS-only; the
  admin list keeps its current ordering (the category is shown as a chip per row).
- Server-side category filtering (`?category=` on the POS endpoint). The chip filter
  is **client-side** over the already-loaded catalog list — no new query param.

---

## Data Model

### `services` — one new column (migration `0032`)

| Column | Type | Notes |
|---|---|---|
| `category` | `text` (nullable) | One of the closed enum keys below. **Nullable** so the additive migration needs no backfill: pre-existing rows are `NULL` ("Sin categoría") until next edited. The API **requires** it on every create/edit, so all new and re-saved rows carry a value. |

```sql
-- migrations/0032_add_category_to_services.sql
ALTER TABLE `services` ADD COLUMN `category` text;
```

> Additive, backfill-free — mirrors `0031_add_flex_capacity_to_services`. No
> `NOT NULL` / `DEFAULT`, because no single category is a correct default for an
> existing service; legacy rows stay `NULL` and are surfaced honestly as
> uncategorized until an admin edits them (at which point the required field forces
> a choice).

Drizzle (`src/db/schema.ts`, `services` table) — append after `flexCapacityPct`:

```ts
// US-A37 — primary category (docs/catalog/service-categories.spec.md). A closed enum,
// nullable only to absorb pre-migration rows (NULL = uncategorized); the API requires it
// on every create/edit, so all new/re-saved rows carry a value. Drives the POS filter chips.
category: text('category', {
  enum: ['lodging', 'tours', 'dining', 'adventure', 'culture'],
}),
```

### Category enum — the closed catalog

| Stored key | Spanish label (UI) |
|---|---|
| `lodging` | Hospedaje |
| `tours` | Tours |
| `dining` | Gastronomía |
| `adventure` | Aventura |
| `culture` | Cultura |

- **Stored as stable lowercase English keys** (like `commission_type`'s
  `percent`/`fixed`), never the localized label, so the persisted value is
  locale-independent and the UI owns presentation.
- The label map lives once on the frontend (`features/catalog/categories.ts`,
  re-exported through the catalog feature) and is the single source of the Spanish
  display strings + chip ordering. The POS imports the same map.

---

## Validation rules (server-side, shared with the frontend via Zod)

On the catalog `services` schema (`src/routes/services/schema.ts`):

| Field | Rule |
|---|---|
| `category` | **Required** enum `['lodging','tours','dining','adventure','culture']`. Missing / empty / unknown value → `400 VALIDATION_ERROR` with message *"Please select a category"* (UI: *"Selecciona una categoría"*). |

```ts
export const SERVICE_CATEGORIES = ['lodging', 'tours', 'dining', 'adventure', 'culture'] as const

// in createServiceSchema (PUT reuses it — full replace):
category: z.enum(SERVICE_CATEGORIES, {
  // satisfies US-A37: the form/API both reject a save with no category chosen.
  message: 'Please select a category',
}),
```

> The field is **required even though the column is nullable**: the column's
> nullability exists solely to absorb pre-migration rows. Every write path goes
> through this schema, so no new or edited service can be saved category-less.

The frontend mirror (`features/catalog/schemas.ts`, `serviceFormSchema`) uses the
same enum with the Spanish message *"Selecciona una categoría"*.

---

## API surface

### Admin catalog (extends `docs/catalog/service-catalog.spec.md`)

`POST /api/services` and `PUT /api/services/:id` accept and require `category`. Per
Multitenancy Rule 1, `organization_id` is still never read from the body.

```json
{
  "name": "Canyon Sunrise Tour",
  "base_price": 150000,
  "minimum_price": 120000,
  "default_capacity": 12,
  "category": "tours"
}
```

`GET /api/services` and `GET /api/services/:id` echo `category` (string key, or
`null` for a legacy row) on the service object so the form re-hydrates the dropdown
on edit and the list/row can show a category chip.

### POS catalog (extends `listPosServices`)

`GET /api/pos/services` adds `category` to each item in the rollup, so the agent UI
can group/filter the catalog. No new query param — the filtering is client-side.

```json
{
  "services": [
    { "id": "svc_1", "name": "Canyon Sunrise Tour", "category": "tours",
      "available_spots": 12, "next_slot_date": "2026-06-20", "...": "..." }
  ]
}
```

`GET /api/pos/services/:id` (`getPosService`) **may** also echo `category` for
parity, but the detail screen does not currently need it; including it is optional
and harmless. (Default: include it, for a consistent service shape.)

---

## Frontend

### Catalog service form (`features/catalog/components/ServiceFormDialog.tsx`)

- A **required** *Categoría* single-select dropdown (MUI `TextField select` /
  `Select`), options drawn from the shared label map (Spanish labels, English keys
  as values). Placed near the top of the form (it classifies the whole service),
  e.g. just under *Nombre*.
- New service → no option pre-selected (empty); submitting empty shows the inline
  error *"Selecciona una categoría"* (the Zod refine drives it, consistent with the
  other fields). Edit → pre-selected from `service.category`; a legacy `null`
  service opens with the dropdown empty and must be set before re-saving.
- `ServiceFormData` gains `category` (the enum, no default — an unselected value is
  invalid, matching the required rule).

### Admin catalog row (`features/catalog/components/ServiceRow.tsx`)

- Show a small neutral (outlined, default color) chip with the category's Spanish
  label, alongside the existing Activo/Inactivo and Flexible chips. A legacy `null`
  category renders no chip (not an empty one).

### POS catalog filter (`pages/PosCatalogPage.tsx`)

- Derive the present categories from the loaded `services` list: the **distinct,
  non-null** set of `service.category`, ordered by the shared map's canonical order.
- Render a horizontal row of filter chips: **"Todos"** (always, when ≥ 1 category is
  present) + one chip per present category (Spanish label). **If no service carries a
  category** (e.g. all legacy `null`), render **no filter bar at all** — satisfying
  *"only display filters if there is at least one service with that category."*
- Single-select: tapping a chip filters the grid to that category; tapping "Todos"
  (or the active chip again) clears it. Selection is **local component state**
  (`useState`), not global — it resets on navigation, which is the desired POS
  behaviour.
- `PosServiceSummary` (`features/pos/types.ts`) gains `category: ServiceCategory | null`.

---

## Scenarios

### US-A37 — Admin assigns a category

#### Scenario 1 — Category persists on create
**Given** an authenticated `admin`
**When** `POST /api/services` is called with `category: "tours"`
**Then** Status `201`; the row has `category = 'tours'`; the response echoes it.

#### Scenario 2 — Category is required
**Given** an admin
**When** `POST /api/services` is called with `category` omitted, `null`, or `""`
**Then** Status `400 VALIDATION_ERROR` (message *"Please select a category"*); no row
is written.

#### Scenario 3 — Unknown category is rejected
**Given** an admin
**When** `POST /api/services` is called with `category: "spa"` (not in the enum)
**Then** Status `400 VALIDATION_ERROR`; no row is written.

#### Scenario 4 — Category round-trips through detail & edit
**Given** a service created with `category: "dining"`
**When** `GET /api/services/:id` is called, then `PUT /api/services/:id` changes it
to `"culture"`
**Then** the GET response carries `category = 'dining'`; after the PUT,
`GET` carries `category = 'culture'` (full-replace edit).

#### Scenario 5 — Legacy service reads as null and is forced to choose on edit
**Given** a pre-migration service with `category = NULL`
**When** `GET /api/services/:id` is called
**Then** the response carries `category = null`; a subsequent `PUT` **without** a
category is rejected `400` (the required rule applies to every write).

### US-A37 — POS payload & filtering

#### Scenario 6 — POS catalog exposes category
**Given** an active service with `category: "tours"` and an available future slot
**When** `GET /api/pos/services` is called
**Then** the service item includes `category: "tours"`.

#### Scenario 7 — Filter chips reflect only present categories *(frontend)*
**Given** the POS catalog returns services in `tours` and `dining` only
**When** the catalog page renders
**Then** filter chips show **Todos · Tours · Gastronomía** — no chip for `lodging`,
`adventure`, or `culture`.

#### Scenario 8 — No categories → no filter bar *(frontend)*
**Given** every returned service has `category = null` (all legacy)
**When** the catalog page renders
**Then** **no filter bar is shown**; the full catalog renders as today.

#### Scenario 9 — Single-tap filter narrows the grid *(frontend)*
**Given** chips **Todos · Tours · Gastronomía** with Todos active
**When** the agent taps **Tours**
**Then** only `tours` services remain in the grid; tapping **Todos** restores all.

### Multitenancy isolation (required — Scenarios B1 / B4)

#### Scenario 10 — B1: Injected `organizationId` stripped; category persists
**Given** an `org_a` admin
**When** a create body includes `"organizationId": "org_b"` and `category: "tours"`
**Then** the org field is stripped (Rule 1); the row's `organization_id` stays
`org_a`; `category` persists as `tours`.

#### Scenario 11 — B4: POS catalog category is org-scoped
**Given** `org_a` has a `tours` service and `org_b` has a `dining` service
**When** an `org_a` agent calls `GET /api/pos/services`
**Then** only `org_a`'s service (and its `tours` category) is returned; `org_b`'s
`dining` service never appears (so it can never seed a filter chip for `org_a`).

---

## Definition of Done

- [x] Migration `0032_add_category_to_services.sql` adds nullable `category` to
      `services` (additive, backfill-free).
- [x] Drizzle schema gains `category` (closed enum); inferred types flow.
- [x] Catalog `services` Zod schema **requires** `category` (enum); missing/unknown →
      `400` (*"Please select a category"*). PUT reuses it.
- [x] `createService` / `updateService` handlers persist & serialize `category`;
      `GET /api/services` + `GET /api/services/:id` echo it (null for legacy).
- [x] `listPosServices` adds `category` to each catalog item; `getPosService` echoes
      it too (parity).
- [x] Shared `features/catalog/categories.ts` label/order map; imported by the form,
      the admin row chip, and the POS filter.
- [x] Catalog form: required *Categoría* dropdown with the *"Selecciona una
      categoría"* error; pre-hydrates on edit.
- [x] Admin `ServiceRow` shows a category chip (none for legacy null).
- [x] POS `PosCatalogPage`: client-derived single-select filter chips; **no bar when
      no category is present**; "Todos" resets.
- [x] Scenarios 1–6, 10–11 covered in `test/catalog/service-categories.test.ts`
      (B1/B4 via `seedTwoOrgs`). Scenarios 7–9 are frontend behaviours.
- [x] SPEC.md updated (US-A37, Phase-2 entry, glossary) — done.
- [x] `pnpm --filter api-turistear test` green (310); `pnpm build:app` clean (`tsc -b` + vite).

---

## Open decisions (defaults chosen — confirm or override)

1. **Legacy rows / column nullability** — *default:* nullable column, no backfill;
   `category` required only on the API write path (so legacy rows read `null` and
   must be set on next edit). *Alternative:* `NOT NULL DEFAULT 'tours'` with a
   backfill — rejected because it silently mislabels existing services.
2. **Stored value** — *default:* lowercase English enum keys + a frontend Spanish
   label map. *Alternative:* store Spanish labels directly (rejected: couples the DB
   to a locale, unlike every other enum in the schema).
3. **Filter selection model** — *default:* single-select (matches the "single tap"
   AC), local component state. *Alternative:* multi-select chips.
4. **Spanish labels** — *default:* Hospedaje / Tours / Gastronomía / Aventura /
   Cultura. Confirm wording (esp. Dining → *Gastronomía* vs *Comida*).
