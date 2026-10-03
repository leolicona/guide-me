---
description: "Record a technical debt as an entry under .specify/debt/<slug>/ — where it lives in the code, what it costs while unpaid, and what paying it looks like. Use when the user wants to log, register, note or track technical debt, a shortcut, a hack, a TODO or FIXME worth remembering, a 'we will fix it later', or anything deliberately left imperfect — and right after an implementation took a shortcut worth writing down. Reads code, never writes it."
argument-hint: "[description of the debt] [slug=<kebab-case>]"
---

# Log Technical Debt

Record a shortcut the codebase is now carrying — deliberate or discovered — as a single entry at
`.specify/debt/<slug>/debt.md`. An entry is only worth writing if it says three things a future reader
cannot reconstruct on their own: **where the debt physically is**, **what it costs to keep**, and
**what paying it looks like**.

`__SPECKIT_COMMAND_DEBT_REVIEW__` re-checks these entries against the code, and
`__SPECKIT_COMMAND_DEBT_PAY__` closes them.

## User Input

```text
$ARGUMENTS
```

The input is a description of the debt, optionally with a slug (`slug=n-plus-one-invoices`). It may be:

1. **A description** — what was traded away and why, in the user's own words.
2. **A pointer** — a file, a symbol, a PR or a task id whose shortcut is the debt.
3. **Empty** — in interactive mode, ask what the debt is; in automated mode, stop and say nothing was recorded.

## Slug Resolution

Each debt gets its own directory under `.specify/debt/<slug>/`. Resolve the slug in this order:

1. **User-provided**: if the user passes one (`slug=n-plus-one-invoices`, `--slug n-plus-one-invoices`,
   or an obvious slug-like token), use it verbatim after normalization (lowercase, hyphen-separated,
   digits allowed, no spaces or other punctuation). Preserve the shape the user asked for — never
   append timestamps or numbers to a slug a human chose.
2. **Interactive mode** (a human is driving): ask for one and wait. Offer a 2–4 word kebab-case
   candidate derived from the description as the default.
3. **Automated mode** (nobody to ask): generate a 2–4 word kebab-case slug from the description. It
   has to be unique: if `.specify/debt/<slug>/` exists, append the shortest disambiguating suffix
   (`-2`, `-3`, …) or a short ISO-style date (`-20260909`). Never overwrite an existing entry.

Name the debt, not the fix: `n-plus-one-invoices`, not `add-index`. The name outlives the plan.

Interactive means a human can answer in this session. A subagent, a hook or a scheduled run is
automated — and every "ask" below has an automated branch, so nothing waits on nobody.

After resolution, set `DEBT_SLUG` and `DEBT_DIR = .specify/debt/<DEBT_SLUG>`.

## Prerequisites

- Create `DEBT_DIR` (including missing parents) if it does not exist.
- If `DEBT_DIR/debt.md` already exists, this debt is already registered. In interactive mode, ask
  whether to open a **new** entry under a different slug — do not overwrite. In automated mode,
  pick a new unique slug. Amending an existing entry is `__SPECKIT_COMMAND_DEBT_REVIEW__`'s job.

## Is this actually debt?

Debt is working code that is more expensive to live with than it should be. Before writing anything,
rule out the two things it is often confused with, and redirect instead of recording:

- **Broken behavior** → that is a bug, not debt. Send the user to `__SPECKIT_COMMAND_BUG_ASSESS__`
  if the bug extension is installed, or to the project's bug workflow. Debt that *causes* a bug is
  still debt; the bug gets its own record.
- **Work that was never done** → an unbuilt feature is a backlog item, not debt. Debt requires
  something already in the tree that is carrying the cost.

If it is neither, say so plainly and record nothing.

## Execution

1. **Understand the trade**
   - What was chosen, and what was given up. If the user knows why (a deadline, an unknown, a
     dependency that was not ready yet), capture it verbatim — the reason is the part that decays
     fastest from memory.
   - Classify the kind: `deliberate` when the code or its history records the trade being taken
     knowingly — a comment, a commit message, a decision record; `inadvertent` otherwise. This is
     read from the tree, not guessed.

2. **Anchor it in the code**
   - Search the codebase for the files, functions, symbols or patterns the description points at.
   - Record concrete anchors as `path/to/file.ts:42` or `path/to/file.ts::functionName`, each with a
     one-line reason. An entry with no anchor can never be reviewed, so every entry carries at least
     one. If nothing can be located, stop rather than write a vague one: ask where it lives in
     interactive mode; in automated mode, report that no anchor was found and record nothing.
   - Prefer symbol anchors over line numbers where a symbol exists: lines move, names mostly do not.
     Where there is no symbol — a top-level statement, a config line — quote the line verbatim next
     to the number, so the anchor can be found again after it moves.
   - When the description and the code disagree — a file it names does not say what it claims — the
     code wins for anchors, and the discrepancy goes in *Notes*: recorded as found, not as described.

3. **Price the interest**
   - What does this cost while it stays unpaid? Be specific and observable: "every new payment
     provider needs the same 40-line copy", "the query is O(n) per row and the table grows monthly",
     "a change here requires editing three files that nothing links together".
   - Assign a severity (`critical`, `high`, `medium`, `low`) from that cost, not from how ugly the
     code looks. Severity is about the bill, not the aesthetics.

4. **Define the exit condition**
   - What does "paid" mean, concretely enough that someone else could verify it? Name the change,
     the files it would touch, and how a reader would confirm afterwards that the debt is gone
     (a test, a query plan, the absence of a pattern). The confirmation has to be checkable on the
     tree as it is — a command, a grep, a test that exists — because `__SPECKIT_COMMAND_DEBT_PAY__`
     will run it and may not edit source to do so. If proving it needs a deliberately broken input,
     point at a fixture or a test that supplies one.
   - Give a **trigger**: the condition that turns this from tolerable into urgent — a scale, a
     feature that would have to build on it, a date, a dependency upgrade. A debt with no trigger
     is never scheduled by anyone.
   - Estimate the effort coarsely (`hours`, `days`, `weeks`). A false-precision estimate is worse
     than a coarse one; do not produce a number the evidence does not support.

5. **Write the entry**

   Write `DEBT_DIR/debt.md` with this structure:

   ```markdown
   ---
   slug: <DEBT_SLUG>
   status: open
   kind: deliberate | inadvertent
   severity: critical | high | medium | low
   effort: hours | days | weeks
   opened: <ISO 8601 date>
   ---

   # Technical Debt: <short title>

   ## What was traded

   <One or two sentences: what was chosen, what was given up, and why. Quote the user's stated
   reason if they gave one.>

   ## Where it lives

   - `path/to/file.ts:42` — <why this is an anchor>
   - `path/to/other.ts::functionName` — <why>

   ## Interest

   <What it costs while unpaid. Observable consequences, not adjectives.>

   ## Paying it

   <What the change would be. Files it would touch. How a reader confirms afterwards that the
   debt is gone.>

   **Trigger**: <the condition that makes this urgent>

   ## Notes

   <Anything a future reader needs: related entries, prior attempts, decisions that depend on this,
   links to specs or issues. Omit the section if there is nothing to say.>
   ```

   Fill every field. Where a fact is genuinely unknown, write `[NEEDS CLARIFICATION: …]` rather than
   inventing one — an invented anchor makes the whole register untrustworthy.

6. **Report back**
   - The slug on its own line (`Slug: <DEBT_SLUG>`) so a later command in the same session can reuse it.
   - The path `.specify/debt/<DEBT_SLUG>/debt.md`.
   - Severity, effort and the trigger, in one line.
   - Any `[NEEDS CLARIFICATION]` markers left in the entry.

## Guardrails

- **Never modify source files.** This command only reads the codebase and writes inside
  `.specify/debt/<slug>/`. Recording a debt and paying it are separate acts, on purpose.
- **Never overwrite an existing entry.** The register is append-only; entries are closed, not erased.
- **Never invent an anchor, a cost or a trigger.** Everything written must trace to the user's
  description or to something found in the code.
- **Never widen the entry into a plan.** If paying the debt turns out to need a design, that is a
  spec, and it starts at `__SPECKIT_COMMAND_SPECIFY__`. The entry records the debt, not the project.
