# Data Model: Retire affiliates and affiliate shift operators

No table or column is created, changed or dropped (D1). What changes is what the code maps (D2).

## Unmapped, still in D1

| Object | Kind | Rows in prod (2026-10-06) | Still touched by code |
| --- | --- | --- | --- |
| `affiliate_companies` | table (migration 0034) | 2 | no |
| `affiliate_commissions` | table (0034) | 5 | `DELETE … WHERE service_id = ? AND organization_id = ?` on service hard-delete, through a local two-column mapping (D7) |
| `affiliate_invitations` | table (0034) | 2 | no |
| `affiliate_operators` | table (0048) | 0 | no |
| `users.affiliate_company_id` | nullable FK column (0034) | 1 non-null | no |
| `users.position` | nullable text (0034) | — | no |
| `folios.affiliate_company_id` | nullable FK column (0034) | 1 non-null | no |
| `folios.operator_id` | nullable FK column (0048) | 0 non-null | no |
| `folio_payments.operator_id` | nullable FK column (0049) | 0 non-null | no |
| `folio_events.operator_id` | nullable FK column (0061) | 0 non-null | no |

Inserts into `users`, `folios`, `folio_payments` and `folio_events` omit the unmapped columns, which
default to `NULL`.

## Stored values the code no longer produces

- `users.role = 'affiliate'` — the TypeScript enum is `admin | agent`; the stored value survives and
  is refused at authentication (D3), counted as a cash holder (D5) and printed as-is in the
  commission report (D6).
- `affiliate_commission_pct` inside a cancellation ladder (`organizations.cancellation_policy`,
  `folios.cancellation_policy_snapshot`) — stripped on parse (D8); none stored today.

## Validation rules that change

- Invitation completion no longer accepts a `position`.
- A ladder tier is `{ min_hours, refund_pct, agent_commission_pct }`.
- The commission report query no longer accepts `affiliate_company_id`.
