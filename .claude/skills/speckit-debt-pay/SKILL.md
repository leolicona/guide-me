---
name: speckit-debt-pay
description: Close a technical debt entry under .specify/debt/<slug>/ only after verifying against the code that its exit condition is met, recording the evidence in payment.md with a verdict of verified, partial, unpaid or not-run. Use when the user says a debt was paid, fixed, resolved, cleaned up or removed and wants the register updated, asks whether a debt is still there, or after a refactor or cleanup PR lands. Does not write the fix itself — that goes through the normal spec or lite-path flow.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: debt:commands/speckit.debt.pay.md
---

# Pay a Technical Debt

Close a debt entry — but only against evidence. This command **does not write the fix**: paying a
debt is an ordinary change and goes through the project's normal flow (a spec, a task, a PR).
What this command does is check that the exit condition in the entry is genuinely satisfied by the
code as it stands, and then record how that was established.

A register that closes entries because someone said the work was done is a register that lies
within a quarter.

## User Input

```text
$ARGUMENTS
```

Expect `slug=<slug>` (or a bare slug-like token) naming the entry to close. Optionally a note about
what paid it — a PR number, a spec directory, a commit.

If no slug is given:

- **Interactive mode** (a human can answer in this session): list the open entries and ask which
  one. Wait for the answer.
- **Automated mode** (a subagent, a hook, a scheduled run): stop. Do not guess which debt was paid.

Set `DEBT_SLUG` and `DEBT_DIR = .specify/debt/<DEBT_SLUG>`.

## Prerequisites

- `DEBT_DIR/debt.md` must exist. If it does not, say so and list the slugs that do — do not create one.
- If its front matter already says `status: paid`, report that it is already closed, show the
  existing `DEBT_DIR/payment.md`, and stop.
- Read the entry in full: the anchors under *Where it lives*, and the exit condition and trigger
  under *Paying it*. Those are the criteria. Do not substitute your own. If the exit condition itself
  carries a `[NEEDS CLARIFICATION]` marker, the verdict cannot reach `verified`: check what can be
  checked and record `not-run` for the rest, naming the marker.

## Execution

1. **Check each anchor**
   - Look for every anchor listed in the entry. Record each as `gone`, `present`, `moved` (with the
     new location), or `unverifiable`.
   - An anchor that merely `moved` has not been paid — the debt travelled.

2. **Check the exit condition**
   - Re-read *Paying it* and check each thing it asks for against the tree: the change described,
     the files it said would be touched, and the confirmation it named.
   - Where the entry named a test as the confirmation, **run it** using the project's own test
     command and record the result verbatim; where it named a command, a grep or a script, run exactly
     that. Where it named something not runnable here — a query plan, a production metric, a load
     profile — say so rather than substituting a proxy. Where the confirmation can only be shown by
     editing source — breaking an input on purpose, stripping a citation — do not: record `not-run`
     and name the edit a human would make to see it.

3. **Reach a verdict.** Choose the weakest one the evidence supports:
   - `verified` — every anchor is gone and the exit condition was checked and holds. If the entry
     named a test, that test was actually run and passed.
   - `partial` — some anchors are gone, or the exit condition holds only in part. Name exactly what
     remains, with anchors.
   - `unpaid` — the exit condition was checked and does not hold, and no anchor is gone. The claim
     was wrong or the change has not landed; say which if the tree shows it.
   - `not-run` — the exit condition could not be checked here (no runnable test, needs production
     data, needs a human). Name the datum or step required.

   **A verdict is never over-claimed.** A test that was not executed is `not-run`, never `verified`,
   no matter how obviously it would pass. If the evidence is mixed, the verdict is the weaker one.

4. **Write the payment record**

   Write `DEBT_DIR/payment.md` (replacing the record of an earlier attempt that did not reach `verified` — a payment record describes the latest attempt, and the verdict says how far it got):

   ```markdown
   # Debt Payment: <short title>

   - **Slug**: <DEBT_SLUG>
   - **Checked**: <ISO 8601 date>
   - **Verdict**: verified | partial | unpaid | not-run
   - **Paid by**: <PR, spec directory, commit, or "unknown" — "not paid" on an unpaid verdict>

   ## Anchors

   - `path/to/file.ts:42` — gone
   - `path/to/other.ts::fn` — moved to `path/to/new.ts::fn`

   ## Exit condition

   <Quote the exit condition from the entry, then say what was checked and what was found.>

   ## Evidence

   <Commands run and their output, verbatim and trimmed to what matters. Name the test file and the
   assertion that covers the debt. If nothing was run, say so and why.>

   ## What remains

   <For every verdict but `verified`: exactly what is still outstanding, with anchors.>
   ```

5. **Close the entry — only on `verified`**
   - Set `status: paid` and add `paid: <ISO 8601 date>` to the front matter of `DEBT_DIR/debt.md`.
     **Those two fields are the only permitted edit to `debt.md`** — the body is the historical
     record of the trade and stays as written.
   - On any other verdict, leave `status: open` untouched. The payment record stands as the
     account of the attempt.

6. **Report back**
   - The verdict on its own line.
   - The path `.specify/debt/<DEBT_SLUG>/payment.md`.
   - Whether the entry was closed, and if not, precisely what is still outstanding and who or what
     can pay it.

## Guardrails

- **Never write source code.** This command reads the tree, may run the project's tests, and writes
  only inside `.specify/debt/<slug>/`. If the debt is still there, the fix goes through the project's
  normal flow — start it at `/speckit-specify` when it needs a design, or at the project's
  lite path when it does not.
- **Never close an entry on anything but `verified`.**
- **Never rewrite the body of `debt.md`.** Only `status` and `paid` may change, and only here.
- **Never substitute a proxy for the confirmation the entry named.** If the entry asked for a
  benchmark and no benchmark exists, that is `not-run` — not a `verified` backed by a reading of
  the code.
- **Never invent the payer.** If it is not clear what paid the debt, write `unknown`.