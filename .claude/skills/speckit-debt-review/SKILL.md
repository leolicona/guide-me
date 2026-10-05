---
name: speckit-debt-review
description: Re-check every open technical debt entry under .specify/debt/ against the current codebase and write a snapshot to .specify/debt/review.md — which debts are still there, moved, already gone, or have spread. Use when the user asks what technical debt exists, how much there is, whether the debt register is still accurate or stale, what to pay first, or before planning a cleanup, refactor or maintenance sprint. Reads code only; changes no entry.
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: debt:commands/speckit.debt.review.md
---

# Review the Debt Register

A debt register rots faster than the code it describes: entries get paid by accident during unrelated
work, anchors move, and the cost written down a year ago is no longer the cost today. This command
re-reads every open entry under `.specify/debt/` against the current tree and reports what is still
true, so the register can be trusted enough to plan from.

It is **read-only over source** and writes exactly one file: `.specify/debt/review.md`.

## User Input

```text
$ARGUMENTS
```

Optional. Interpret as:

- **`slug=<slug>`** (or a bare slug-like token) — review only that entry.
- **`--severity <level>`** or a bare severity word — review only entries at that severity or above.
- **Empty** — review every entry whose `status` is `open`.

## Prerequisites

- If `.specify/debt/` does not exist or contains no entries, report that the register is empty and
  stop. Do not create it and do not write a review file.
- Read each `.specify/debt/*/debt.md` and parse its front matter (`slug`, `status`, `kind`,
  `severity`, `effort`, `opened`). Skip entries whose `status` is `paid` unless a slug names one
  explicitly. An entry whose front matter cannot be parsed is reported as `malformed` and skipped —
  never rewritten.
- Note two things per entry that the front matter does not carry: a `[NEEDS CLARIFICATION]` marker
  anywhere in the body, and a `payment.md` beside an open entry — an earlier attempt to pay it that
  did not reach `verified`, with its verdict and date. Both go in the summary's Note column.

## Execution

For each entry under review:

1. **Re-locate every anchor**
   - Look for each anchor listed under *Where it lives*. Match by symbol first, then by the
     surrounding code, then by path. A line number that no longer matches is not evidence of
     anything on its own — files move.
   - Classify each anchor:
     - `present` — the code described is still there.
     - `moved` — found elsewhere; record the new location.
     - `gone` — the code, the pattern, or the file no longer exists.
     - `unverifiable` — the anchor is too vague to check. Say so; do not guess.

2. **Judge the entry as a whole**
   - `still-open` — the debt is intact and the entry describes it correctly.
   - `drifted` — the debt is intact but the entry is now wrong (anchors moved, the interest changed,
     the trigger already fired). Name precisely which part is stale.
   - `likely-paid` — every anchor is gone and the exit condition in *Paying it* appears satisfied.
     This is a **recommendation, not a closure**: only `/speckit-debt-pay` closes an entry,
     because closing it requires verifying the exit condition rather than merely noticing the code moved.
   - `grown` — the pattern the entry describes now appears in more places than the entry lists.
     Record how many and where; this is the single most useful thing a review produces. For a debt
     that is a practice rather than a code pattern — a gate that only warns, a manual step — `grown`
     means more places now follow the practice.
   - `malformed` — front matter unreadable.

3. **Check the trigger**
   - Read *Trigger* and decide whether it has fired, using only what the repository can show
     (code, tests, configuration, migrations, dependency versions, dates). If the trigger depends on
     production facts this command cannot see — traffic, table size, customer count — report it as
     `unknown: needs production data` and name the datum required. Never assume a trigger fired.

4. **Write the review**

   Write `.specify/debt/review.md`, replacing any previous one. It is a snapshot of now, not a log:

   ```markdown
   # Debt Register Review

   - **Reviewed**: <ISO 8601 date>
   - **Scope**: all open entries | slug=<slug> | severity >= <level>
   - **Entries reviewed**: <n>

   ## Summary

   | Slug | Severity | Verdict | Trigger | Note |
   | --- | --- | --- | --- | --- |
   | <slug> | high | still-open | not fired | — |
   | <slug> | medium | grown | fired | now in 6 files, entry lists 2 |
   | <slug> | low | likely-paid | n/a | anchors gone; confirm with `/speckit-debt-pay` |

   ## Details

   ### <slug> — <verdict>

   **Anchors**

   - `path/to/file.ts:42` — present
   - `path/to/other.ts::fn` — moved to `path/to/new.ts::fn`

   **Trigger**: <fired | not fired | unknown: needs production data — <what is needed>>

   **Spread**: <unchanged | the same pattern in <n> more places: <where>>

   **What changed since `opened`**: <one or two sentences, or "nothing".>

   **Recommended action**: <confirm with `/speckit-debt-pay` | amend the entry: … | leave as is>

   ## Recommended next steps

   1. <the highest-value action, with the command to run>
   2. …
   ```

   Order the summary table by severity (critical first), then by verdict (`grown` before
   `still-open`, `likely-paid` last).

5. **Report back**
   - The path `.specify/debt/review.md`.
   - Counts per verdict in one line.
   - The entries that need action, with the command for each — `/speckit-debt-pay slug=<slug>`
     for a `likely-paid`, and for a `drifted` or `grown` entry, which part of `debt.md` a human
     should amend.

## Guardrails

- **Never modify source files.** This command reads the codebase and writes only
  `.specify/debt/review.md`.
- **Never edit an entry.** `debt.md` is written by `/speckit-debt-log` and closed by
  `/speckit-debt-pay`. A review reports drift; a human decides what to do about it. If a
  human asks in the same session to amend an entry, edit only the sections they name.
- **Never close an entry.** `likely-paid` is a finding, not a status change.
- **Never over-claim a verdict.** An anchor that could not be checked is `unverifiable`, and a
  trigger that depends on data outside the repository is `unknown` — neither is `gone` or `fired`.