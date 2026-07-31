# Feature: <name — what it does, not what it is called internally>

> Process: `docs/PROCESS.md`. Copy this file to `docs/<domain>/<feature>.spec.md` and delete
> every instruction in italics as you fill it in. A section that does not apply is **removed**,
> not left empty — an empty heading reads as an oversight.
>
> *(On a spec that supersedes another, this header carries it:
> `> **Status: BUILT.** Changes <spec> US-Xnn and supersedes <spec> D21.`)*

## Context

*What is broken today, with numbers. Not background — the argument for the feature. If a table,
a boundary case, or a real folio shows the defect, put it here. A reader who disagrees with this
section should disagree with the whole feature.*

## Scope boundary

*What this feature must NOT change, stated so a machine can check it. The strongest form is a
named test file that must pass unedited. Second strongest: a behaviour that is byte-identical
when a setting is absent. This is the section that lets the feature be reverted safely.*

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | | |
| **D2** | | |

*One row per resolved branch of the design tree. The Why column is not optional — it is what a
later spec cites when it supersedes the decision. Withdrawn decisions stay in the table, marked
`D6 (withdrawn)`, with the reason.*

## Data Model

### Migration `NNNN_<name>.sql`

```sql
-- the real SQL, additive where possible
```

*Then the Drizzle columns and any derived/cached fields, with a note on what stays authoritative
and what is reconciled from it.*

## Business rules (enforced server-side)

1. *Numbered, imperative, each independently testable. Mark anything the frontend only mirrors.*
2.

## Authorization — who may do this

*Role, tenancy, and any bound (a shift window, an ownership check). State what a cross-org
attempt returns — in this codebase, `404`.*

## API surface

### `METHOD /api/...`

*Request shape, response shape, and which fields are server-derived and therefore refused from
the body (`organization_id`, `status`, anything money).*

### Error responses

| Code | HTTP | When |
|---|---|---|
| `SOME_ERROR` | 422 | |

## Frontend

*Screens touched, which shared primitives are reused (`MoneyText`, `SectionCard`, `StatusChip`,
`BottomSheet`, `FormSheet`, `ConfirmSheet`), and any new state. Design system:
`.design/design-system/DESIGN_TOKENS.md`.*

## Scenarios

*Given/When/Then, grouped by story. Assert the thing that would be wrong if the feature were
broken — not a side effect that would also hold with the bug present.*

### US-Xnn — <story>

**S-1 — <one line naming the behaviour>**
Given …
When …
Then …

### Multitenancy isolation (required)

**S-n — Another org's record is invisible**
Given two organizations seeded with `seedTwoOrgs`
When org A requests org B's record
Then `404` — never `403`, which would confirm it exists.

## Definition of Done

- [ ] *Migration + schema*
- [ ] *Endpoints + validation*
- [ ] *Scenarios covered, in `<test file>`*
- [ ] *Cross-org isolation tests*
- [ ] *Frontend*
- [ ] *`SPEC.md`: stories, Features by Phase line, glossary*

*(Phased feature: one DoD block per phase, each a deployable state.)*

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|

## Known behaviour change

*Anything an existing organization will notice. Numbers that move in production belong here, in
plain language, even when the change is a fix.*

## Open

*Questions this spec does not answer, and the smallest change that would answer each. Recording
an alternative here keeps it one decision away rather than a redesign.*
