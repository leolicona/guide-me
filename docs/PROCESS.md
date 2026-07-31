# How a feature gets built here — the spec-driven process

This repository has been spec-driven since the MVP; the process was simply never written down.
This file states it, so a new feature lands the same way the last twelve did.

**The rule everything else follows:** `docs/SPEC.md` is the index of the product. If a capability
exists in the code and not in `SPEC.md`, the index is wrong — and an index nobody trusts stops
being consulted, which is how the same folio ended up with three different cancellation prices.

---

## The four layers

| Layer | File | Answers |
|---|---|---|
| **Product** | `docs/SPEC.md` | *What does this product do?* Vision, roles, numbered user stories, Features by Phase, key business rules, glossary |
| **Feature** | `docs/<domain>/<feature>.spec.md` | *What exactly does this feature do, and what may it not break?* The contract |
| **Execution** | `docs/<domain>/<feature>.plan.md` | *In what order do I type it?* Phases → tasks with file paths |
| **Cross-cutting** | `ARCHITECTURE.md` · `TECH_DEBT.md` · `BUGS.md` · `RFCs/` | Facts that outlive any one feature |

`ARCHITECTURE.md` holds decisions that bind every feature (the multitenancy isolation model).
`TECH_DEBT.md` holds what was knowingly deferred. `BUGS.md` holds defects found in shipped code.
An `RFC` is for a change of *model* that needs approval before a spec is worth writing
(`RFCs/rfc-airbnb-inventory-model.md` is the example).

---

## Naming, IDs, numbers

| Thing | Rule |
|---|---|
| Spec file | `docs/<domain>/<feature>.spec.md`. When the folder already names the feature, repeat it: `docs/timezone/timezone.spec.md`. Never a bare `spec.md` — most domains grow a second spec. |
| Plan file | `docs/<domain>/<feature>.plan.md`. *(Older plans are named `implementation-plan.md`; they are historical and stay as they are.)* |
| Story ID | Next free in its series — `US-A*` admin · `US-AG*` agent · `US-AF*` affiliate · `US-OP*` operator · `US-T*` tourist · `US-UX*` shell · `US-L*` localization · `US-LG*` ledger. **Never renumber**; a superseded story is struck through and annotated, not reused. |
| Migration | Next integer, four digits, `NNNN_snake_case.sql`. Additive whenever possible. One migration per phase of a phased feature. |
| Error code | `SCREAMING_SNAKE`, declared in the spec's *Error responses* table before it exists in code. |

---

## The seven steps

**1 — Interview before writing.** Walk the design tree until every branch is resolved. The
`D1…Dn` table in the spec is the *output* of that interview; if you cannot fill the *Why* column,
the decision is not made yet.

**2 — Reserve the IDs.** One ID per **observable capability**, not per technical task. "The ledger
exists" is a story because you can check it; "add an index" is not.

**3 — Write `docs/<domain>/<feature>.spec.md`** from `docs/_templates/feature.spec.md`.

**4 — Register in `SPEC.md`, in both places** — the stories under their role, *and* one line in
**Features by Phase** with a checkbox, the story IDs, a one-paragraph abstract, and the spec path.
Add any new vocabulary to the **Glossary**. This step ships **in the feature's own PR**, not later.

**5 — Phase it if it is large.** A phase = one migration + one PR + one deployable state, each with
its own Definition of Done inside the same spec. `cancellation-policy-engine.spec.md` runs three.

**6 — Build, and amend the spec as the build teaches you things** (see below).

**7 — Close.** Tick the DoD, tick the `SPEC.md` box, move anything deferred into `TECH_DEBT.md`,
and mark superseded decisions in the specs they came from.

---

## What makes a spec here different

**Start from what is broken, with numbers.** *Context* is not background — it is the argument for
the feature. `apartado-stages.spec.md` opens with a table showing two minutes of difference in sale
time changing the hold by a factor of 1400. That table is why the feature exists.

**State the scope boundary as a mechanical test.** The cancellation engine survived a rewrite of the
money path because its acceptance criterion was checkable by a machine: *`folio-cancellation.test.ts`
and `agent-balance-cash-drops.test.ts` must pass unedited*. Write that sentence before writing code.

**Number every decision, and give each a *Why*.** `D1…Dn`, `S1…Sn` — so a later spec can say
"supersedes D21" and everyone knows exactly what changed.

**Rules are marked *enforced server-side*.** A rule the frontend enforces alone is not a rule; the
form may mirror it for fast feedback.

**Scenarios are Given/When/Then, grouped by story, and include cross-org isolation.** Every
tenant-scoped feature carries `seedTwoOrgs` scenarios — this is a hard requirement from `CLAUDE.md`,
not a nicety.

**The Definition of Done is checkboxes, and it is honest.** It is the thing that gets ticked at
close; if an item cannot be ticked, say why in the same line.

**Say what you deferred *and why deferring is safe*.** "Deferred" alone reads as forgotten.

---

## Amending a spec — the part that keeps the corpus coherent

A spec is **amended in place, never forked**. There is exactly one document per feature, and it
tells the truth about today plus how it got here.

- Superseding another spec's decision → say so in the header of the new one
  (`> **Status: BUILT.** … supersedes <spec> D21`) **and** annotate the old decision.
- Superseding a story → strike it through in `SPEC.md` and point at what replaced it
  (`~~US-A26~~ **SUPERSEDED by US-A70/US-A75**`). Never delete a story; the ID is a permanent handle.
- **Record what the build changed.** `apartado-stages.spec.md` carries `S6 (withdrawn)`,
  `S8 (added in build)`, and a note that scenario S-4 was rewritten because the original assertion
  would have passed while the bug was present. This is the highest-value habit in the corpus:
  it is what separates a living spec from a wish list.

---

## Checklists

**Opening a feature**
- [ ] Design tree resolved; every `D*` has a *Why*
- [ ] Story IDs reserved; migration number claimed
- [ ] Spec written from the template, scope boundary stated as a mechanical test
- [ ] `SPEC.md`: stories + Features by Phase line + glossary terms
- [ ] Cross-org scenarios listed (`seedTwoOrgs`)

**Closing a feature**
- [ ] Every DoD box ticked, or annotated with why it is not
- [ ] `SPEC.md` checkbox ticked — the box means **merged**, so tick it when it merges, not before
- [ ] Deferred items in `TECH_DEBT.md`; defects found on the way in `BUGS.md`
- [ ] Superseded decisions annotated in the specs they came from
- [ ] No dangling `docs/…md` link: a path in `SPEC.md` means the file exists. A feature with no
      spec yet reads **"spec not written yet"**

---

## Accepted variances

- **Plan files** predating this document keep their `implementation-plan.md` name. They are
  execution records of finished work; renaming them would churn history for no reader's benefit.
- **`api-turistear/specs/`** holds superseded Spanish drafts of the auth specs and is not a spec
  location — see the README there and the reconciliation item in `TECH_DEBT.md`.
- **`docs/DESING.md`** is a deliberate tombstone: the design system moved to
  `.design/design-system/`, and old code comments still point at the file, so it redirects.
