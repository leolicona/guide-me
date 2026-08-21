# Feature: Adding a lodging unit no longer starts by creating a property

> Process: `docs/PROCESS.md`. **Status: SPEC.** Changes how US-A59's unit authoring is *entered*;
> the unit-type data model of `docs/lodging/accommodation-stays.spec.md` is untouched.
> Frontend only — no migration, no endpoint, no error code.

## Context

An admin who already owns *Cabañas Imperial* wants to add a second cabin. The catalog offers him
exactly one affordance — **«Nuevo servicio»** (`CatalogListPage.tsx:44`) — which opens
`/catalog/new`, and that wizard has no mode other than create: `useCreateLodgingFull` opens with
`POST /services` unconditionally. Step 1 asks him for a *Nombre de la propiedad*, he types
«Cabaña 2», and the org now owns two properties where it owns one building.

The correct path exists and is three navigations deep, behind a noun he is not looking for:
Catálogo → open *Cabañas Imperial* → scroll to «Tipos de unidad» → **Agregar tipo**
(`UnitsSection.tsx:40` → `UnitFormSheet`, a complete 15-field form). Nobody opens a property in
order to *add* something; they press the button labelled add.

Three things keep the mistake invisible once made:

| | |
|---|---|
| **The POS agrees with him** | The catalog is flattened — one card per unit type (US-AG37). «Cabaña 1» and «Cabaña 2» render as two correct-looking cards whether they are two units of one property or two properties of one unit each. Selling never contradicts the mistake. |
| **The dashboard does not** | «Ocupación» is slots-only (US-A90); lodging is a named deferral. Nothing aggregates *by property*, so nothing looks wrong. |
| **The word is not his** | The model is `accommodation_unit_types` + `inventory_count` (RFC `rfc-airbnb-inventory-model.md`). The UI asks him to author a *«tipo de unidad»* — an abstraction he has to construct before he can act. He owns cabins, not types of cabins. |

And the same defect exists one level down, unfixed by this feature: `migrations/0035` declares no
UNIQUE on `accommodation_unit_types.name` and `lodging.handler.ts:194` inserts without checking, so
a property can hold two units called «Cabaña Río». The wizard's only guard, `existingNames`
(`StepUnits.tsx:139`), is built from the wizard's own local drafts and cannot see what the server
already holds.

## Scope boundary

- **The slot track does not change.** Tours · Gastronomía · Aventura · Cultura keep their four
  steps, fields, validation and save path. `useCreateServiceFull.test.ts` must pass **unedited**.
- **The create-a-property branch is behaviour-identical to today** whenever the org has no active
  lodging property — same three steps, same fields, same `useCreateLodgingFull` call, same
  navigation. An org onboarding its first property cannot tell this feature shipped.
- **No migration, no schema change, no new endpoint, no new error code.** The property picker reads
  the existing `GET /api/services`; attach mode posts to the existing
  `POST /api/services/:id/units`.
- **`UnitsSection` → `UnitFormSheet` on the detail page stays** exactly as it is, and stays the
  path for editing an existing unit.
- **The POS selling flow is untouched** — two Spanish strings change (D9), no behaviour.

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | The choice lives **inside wizard Step 1**, rendered when `inventoryModel(category) === 'units'` — not on a screen before the wizard and not behind a second entry button. | A pre-wizard sheet would ask for the category twice and leave an escape hatch: pick *Tours* in the sheet, switch to *Hospedaje* inside the wizard, and you are back in the create-only flow. Bound to the category field, the control cannot be outrun. |
| **D2** | **One control**, not a mode radio plus a property field: a single-select list of the org's active lodging properties whose last row is **⊕ Crear una propiedad nueva**. Choosing ⊕ reveals the name + description fields inline. | Two controls make the user answer a question about the *system's* structure («¿existente o nueva?») before answering one about their *business* («¿cuál?»). One list asks only the second. |
| **D3** | Rows, **not chips**. Each row is the property name over a summary line — «3 unidades · 8 en total». | A chip carries a label only. With «Cabañas Imperial», «Villas del Mar», «Hotel Centro» side by side, the summary is what makes the right one recognisable; without it the user is recalling, not choosing. Selected state reuses the `AmenityPicker` grammar (`teal-50` surface, `teal-700` border, check icon) so no new visual language appears. |
| **D4** | Scaling is by count: **0** → the control is not rendered · **1–6** → all rows visible · **7+** → a search field above a list scrolled to ~4 rows, in the catalog's own order (`GET /api/services` sorts by name; there is no usage signal to sort by, and inventing one is a separate feature). | A wrap of 15 rows buries the action. Search appears only where it earns its space. |
| **D5** | **⊕ never enters the scroll region and never enters the search filter** — it is anchored below the list. | Inside the list, an org with 15 properties must scroll to the bottom to create one; worse, typing «Cabaña» to search would filter ⊕ away at the exact moment the user wants it. |
| **D6** | Preselection: when the org has **exactly one** active lodging property, that row is preselected. With **two or more**, nothing is preselected and Step 1 does not advance until a row (or ⊕) is chosen. | With one property, preselection is unambiguous and free. With several, preselecting the alphabetically-first row invites blow-through into the *wrong* property — a misattribution quieter than the bug being fixed, since a unit filed under the wrong building looks correct everywhere. |
| **D7** | Attaching to an existing property makes the wizard **two steps** (Información → Unidades). The **Comisión step is not shown**. | `StepCommission` writes `commission_type`/`commission_value` **on the service**. Running it against an existing property would silently rewrite the commission governing every unit already under it — a bug that moves sellers' money, strictly worse than the one this feature fixes. Nothing is lost: each unit carries its own **Heredar / % / $** control (`UnitFields.tsx:166`), defaulted to `inherit`. |
| **D8** | The step indicator changes from «PASO 1 DE 3» to «PASO 1 DE 2» live as the choice is made. | It is true, and it reads as reward: the chosen path is shorter. Freezing it at 3 would be a lie about what remains. |
| **D9** | If the user typed a property name under ⊕ and then selects an existing property, the typed text is **kept and prefilled as the unit's name** in Step 2. | Someone who typed «Cabaña 2» named the thing they actually wanted to create; they were only at the wrong level of the hierarchy. Carrying the text forward turns the correction into help instead of a scolding, and removes the cost of changing one's mind. |
| **D10** | The admin-facing noun becomes **«Unidad»**, not «tipo de unidad». `inventory_count` is asked as **«¿Cuántas iguales tienes?»** (helper: *1 si es única*), and the free-text `unit_type` field is relabelled **«¿Qué es? (opcional)»** (*Cabaña, habitación, suite…*). | The owner owns cabins. «Tipo de unidad» asks him to build the abstraction before he can act, and that abstraction is exactly what he is failing to build. Asking the count as a plain question keeps the same data with none of the modelling. The rename is partly a consistency fix: `UnitDraftSheet.tsx:184` already says «Nueva unidad» while the button that opens it says «Agregar tipo». |
| **D11** | The duplicate-name guard in attach mode is fed from **`useUnits(propertyId)`** — the property's server-side units — merged with the wizard's local drafts. | Otherwise attach mode ships the same class of duplicate one level down, and the POS would render two identical cards. Same query key as `LodgingSummary`, so the cache is already warm; no extra request. |
| **D12** | Only **active** properties are listed. An org whose lodging properties are all inactive is treated as an org with none. | A unit filed under a deactivated property cannot be sold; offering the destination would be offering a dead end. |
| **D13** | A nudge fires only in the ⊕ branch and only on a **prefix match** against an existing property name («Cabañas Imp…» → *«¿Te refieres a Cabañas Imperial?»*), never blocking submission. | The trailing-number heuristic (`/\s\d+$/`) is withdrawn: with the picker visible above, a user who still chooses ⊕ and types «Cabaña 2» likely means it, and «Villas 3 Marías» is a legitimate name the heuristic would insult. |
| **D14** | Both entry points to unit creation stay: the wizard's attach mode and `UnitsSection` on the detail page. | They serve different moments — «voy a agregar algo» versus «estoy viendo esta propiedad». Both mount `UnitFields`, so they cannot drift apart. |
| **D15** | On save in attach mode the wizard routes to **`/catalog/:id`** with `state:{scrollTo:'units'}` and a snackbar naming the property: **«2 unidades agregadas a Cabañas Imperial»**. | The user lands looking at the property with its units inside it — the hierarchy drawn rather than described — and the confirmation names the container one last time. |

*Withdrawn during design, recorded so they are one decision away rather than a redesign:*
**a pre-wizard `BottomSheet`** (D1 supersedes: duplicated the category question and left the escape
hatch); **chips for property selection** (D3: no room for the summary that makes a property
recognisable); **an empty picker shown to orgs with zero properties** «to teach the hierarchy»
(D4: there is no container to teach yet, and a disabled row is noise — the Step 1 helper already
carries the lesson).

## Rules

These are **frontend rules**. The server enforces none of them today; the gap that matters is
recorded under *Deferred*.

1. The property control renders **iff** `inventoryModel(category) === 'units'` **and** the org has
   ≥ 1 active lodging service.
2. Step 1 cannot be advanced while the picker is on screen and nothing is chosen; in create mode
   the existing `name` + `category` gate is unchanged. `stepFields()` becomes aware of the mode, and
   the choice itself is gated in `goNext()` alongside the other wizard-local arrays.
3. Attach mode never sends `POST /services`. It calls `POST /services/:id/units` per unit, then
   that unit's seasons and block-outs — the existing per-unit fan-out of `useCreateLodgingFull`.
4. Attach mode never sends service-level `commission_type` / `commission_value`.
5. A unit name that collides — case-insensitively, trimmed — with an **active** unit of the target
   property, or with another draft in the same wizard run, blocks the draft sheet's save.
6. At least one unit is required to finish, in both modes (today's `showUnitsError` gate).
7. A partial failure leaves the property untouched in attach mode; the user lands on the property
   detail with a count of what did not save.

## Authorization — who may do this

Unchanged: `/catalog/new` is behind `RoleGuard role="admin"` (`App.tsx:275`). The picker reads
`GET /api/services`, already org-scoped, and posts to `POST /api/services/:id/units`, whose
cross-org behaviour (404, never 403) is covered by the existing lodging suite. This feature adds no
route and therefore no new isolation surface.

## Frontend

| Surface | Change |
|---|---|
| `pages/CatalogListPage.tsx` | Button label «Nuevo servicio» → **«Agregar al catálogo»**. |
| `features/catalog/components/wizard/StepBasicInfo.tsx` | Renders `PropertyPicker` when the category is unit-based; name/description reveal only under ⊕. New helper copy. |
| `features/catalog/components/wizard/PropertyPicker.tsx` *(new)* | The single-select list + anchored ⊕ + search above 6 rows. Selection styling mirrors `AmenityPicker`. |
| `features/catalog/components/wizard/wizardTypes.ts` | `totalSteps()` / `stepTitle()` take the mode: attach → 2 steps, no «Comisión». |
| `features/catalog/components/wizard/wizardSchema.ts` | `stepFields()` mode-aware: `['category']` when attaching vs `['category','name']` when creating. The chosen property is **wizard-local state**, not an RHF field — it is a routing decision, and putting it in `WizardFormData` would place it in the service payload type it must never reach. |
| `features/catalog/components/wizard/ServiceWizard.tsx` | Mode state; `saveLodging()` branches to attach; dynamic page title («Agregar unidad» / «Nuevo servicio»). |
| `features/catalog/components/wizard/StepUnits.tsx` | Subtitle names the target property; `existingNames` merges server units (D11); name prefill from D9. |
| `features/catalog/hooks/useCreateLodgingFull.ts` | Attach variant that skips `createService` and fans out units against a given `serviceId`. |
| Rename sweep (D10) | `wizardTypes.ts:46` · `StepUnits.tsx:62,73,77,92` · `UnitsSection.tsx:32,40,100` · `ServiceRow.tsx:38,48` · `UnitFields.tsx:104,116,123` · `UnitDraftSheet.tsx:201` · `StepCommission.tsx:24,25,90` · `StepBasicInfo.tsx:15` · `LodgingStaySheet.tsx:273,284`. |

**Copy.** `ServiceRow.tsx:48` becomes **«3 unidades · 8 en total»** — «3 unidades · 8 habitaciones»
would read as a contradiction once «unidad» is the noun for the row itself. Step 1's helper for a
first property becomes **«Es el lugar completo, no una cabaña suelta. En el siguiente paso agregas
las que rentas.»** — it names the mistake before it happens and promises the next step, where the
current string («Los tipos de unidad… se agregan en el siguiente paso») leans on vocabulary the
reader does not have yet. The picker is titled **«¿En qué lugar se renta?»** over *«Elige la
propiedad a la que pertenece, o crea una nueva.»*

Primitives reused: `WizardPage`/`WizardChrome`, `FormSheet` (`UnitDraftSheet`), `SectionCard`,
`ConfirmSheet` (discard). No new primitive. Tokens per `.design/design-system/DESIGN_TOKENS.md`;
selection is the one sanctioned teal use.

## Scenarios

### US-A91 — add a unit without creating a property

**S-1 — The picker appears only for lodging**
Given an org with one active lodging property
When the admin opens `/catalog/new` and selects *Tours*
Then no property control is rendered and the wizard shows «PASO 1 DE 4».

**S-2 — Switching category mid-step reveals the picker**
Given the admin has selected *Tours* in Step 1
When he changes the category to *Hospedaje*
Then the property control appears without leaving the step — there is no route by which
`category = 'lodging'` is reached with the control absent.

**S-3 — First property: the flow is today's flow**
Given an org with **zero** active lodging properties
When the admin selects *Hospedaje*
Then no property control renders, the name field is labelled «Nombre de la propiedad», and the
wizard is three steps ending in «Comisión».

**S-4 — Attaching drops the commission step**
Given an org with *Cabañas Imperial* (commission 10 %)
When the admin selects it and finishes the wizard with one unit
Then the wizard was two steps, and `PATCH`/`POST` on the **service** was never called — *Cabañas
Imperial* still reads 10 %.

**S-5 — Two or more properties require a deliberate choice**
Given an org with two active lodging properties
When the admin selects *Hospedaje* and presses «Siguiente» without choosing
Then the step does not advance and the control shows a validation message.

**S-6 — The typed name survives the correction**
Given the admin chose ⊕ and typed «Cabaña 2»
When he then selects *Cabañas Imperial*
Then the property name field is gone and Step 2's unit name field is prefilled with «Cabaña 2».

**S-7 — A duplicate unit name is refused against the server's units**
Given *Cabañas Imperial* already holds an active unit «Cabaña Río»
When the admin, in attach mode, saves a draft named «cabaña río»
Then the draft sheet blocks the save and names the collision — no second card can reach the POS.

**S-8 — Landing names the container**
Given the admin saved two units into *Cabañas Imperial*
When the wizard finishes
Then the app is at `/catalog/<id>` scrolled to «Unidades», showing four units, with the snackbar
«2 unidades agregadas a Cabañas Imperial».

**S-9 — Partial failure leaves the property alone**
Given one of three units fails to persist
When the wizard finishes
Then the admin is on the property detail with «1 de 3 unidades no se guardó», the property's other
units are intact, and no service was created.

**S-10 — The slot track is untouched**
Given any non-lodging category
When a service is created end to end
Then the payload and navigation are byte-identical to the pre-feature flow
(`useCreateServiceFull.test.ts`, unedited).

## Definition of Done

- [x] `PropertyPicker` + Step 1 integration, with the 0 / 1–6 / 7+ scaling of D4
- [x] Mode-aware `totalSteps` / `stepTitle` / `stepFields`; attach path (`useAttachLodgingUnits`)
- [x] Duplicate-name guard fed from `useUnits(propertyId)` (D11), blocking per rule 5
- [x] Rename sweep (D10) across the strings listed above, POS included
- [x] Catalog button relabelled; wizard title dynamic; snackbar + navigation per D15
- [x] Scenarios covered across three files, by cost: `wizardTypes.test.ts` (step machinery),
      `PropertyPicker.test.tsx` (scaling + the ⊕ escape), `ServiceWizard.test.tsx` (what reaches
      the API — the only assertions that justify mounting the whole wizard)
- [x] `pnpm build:app` clean (bare `tsc --noEmit` checks nothing here — solution-style tsconfig)
- [x] `SPEC.md`: US-A91, Features by Phase line, glossary rows for *Propiedad* and *Unidad*

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **A UNIQUE constraint on `accommodation_unit_types (service_id, lower(name))` + a `409 DUPLICATE_UNIT_NAME`** | D11 closes both frontend doors (wizard and detail sheet share `UnitFields`), so the reachable paths are covered. The server guard needs a migration, a backfill decision for any duplicates already in production, and an error contract — that is its own spec, not a rider on a frontend PR. Recorded in `TECH_DEBT.md`. |
| **Merging or reparenting existing duplicate properties** | No org can be un-messed by this feature; it only stops the mess growing. Reparenting a unit means moving sold folio history between services — a data-integrity feature with its own risk profile. Today's mitigation is deactivation, which already works. |
| **Category-driven wording («Cabaña» everywhere once `unit_type` = cabaña)** | D10 gets most of the benefit for a fraction of the surface. Dynamic nouns would touch every string in the lodging surface and make copy untestable by grep. |
| **Property-level aggregation in «Ocupación»** | Lodging is already a named deferral of US-A90. It would have made the duplicate visible, but it is not what stops it being created. |

## Known behaviour change

- The catalog's primary button reads **«Agregar al catálogo»**, not «Nuevo servicio».
- For an org that already owns a lodging property, the lodging wizard can now be **two steps**. The
  «Comisión» step is not skipped silently — it is absent because the property already answered it.
- Everywhere an admin read **«tipo de unidad»** he now reads **«unidad»**, in the catalog and in the
  POS. No stored value changes; `accommodation_unit_types` and its API are untouched.
- **Existing duplicate properties are not cleaned up, merged, or flagged.** An org that already
  created «Cabaña 1» and «Cabaña 2» as properties still sees them as properties.

## Open

| Question | Smallest change that answers it |
|---|---|
| Does a closed `BottomSheet` really strand the page outside the accessibility tree in a real browser, as it does in jsdom (**BUG-033**, found writing these tests)? | Open the unit sheet in Chrome with VoiceOver, close it, and try to reach the wizard footer. If it reproduces, the fix is in `BottomSheet`, not here — every sheet host in the app inherits it. |
| Does the picker need a *«Vi mal, quiero crear una propiedad»* affordance in Step 2, after the choice is committed? | Today the answer is the Back button. If usage shows people finishing wizards against the wrong property, add the property name in Step 2 as a chip with «Cambiar» that returns to Step 1 with drafts intact. |
| Should ⊕ stay visible once an org has, say, 20 properties — or does it become the rarer act that deserves demotion? | A count threshold on the ⊕ row's prominence. One constant; not worth guessing before there is an org with 20. |
| Is «en total» the right second figure on the catalog row, or should it be a money anchor («desde $1,200/noche», already computed)? | One string in `ServiceRow.tsx:48`; both values are in hand. |
