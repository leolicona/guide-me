# Changelog

All notable changes to this extension are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-09

### Added

- `speckit.debt.log` — records a shortcut as an entry at `.specify/debt/<slug>/debt.md`, requiring at
  least one code anchor, an observable statement of interest, and a trigger. Never overwrites an
  existing entry.
- `speckit.debt.review` — re-checks open entries against the current tree and writes a snapshot to
  `.specify/debt/review.md`, classifying each as `still-open`, `drifted`, `likely-paid`, `grown` or
  `malformed`. Reports drift; changes nothing.
- `speckit.debt.pay` — verifies the entry's own exit condition against the code, records the evidence
  in `payment.md` with a verdict of `verified`, `partial`, `unpaid` or `not-run`, and closes the entry
  only on `verified`.

### Notes

- No command writes source. Paying a debt goes through the project's normal flow; the register
  records it.
- No hooks ship enabled. The README documents the opt-in `after_implement` hook for projects that
  want one.
