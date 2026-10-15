# API contract changes: Retire affiliates and affiliate shift operators

Every change is a removal. No endpoint, field or error code is added.

## Endpoints removed (D11 — Hono's not-found answers)

| Method | Path | Was |
| --- | --- | --- |
| GET / POST | `/api/affiliates` | list / create a company (admin) |
| GET / PUT | `/api/affiliates/:id` | read / edit a company |
| PUT | `/api/affiliates/:id/commissions` | bulk per-service rates |
| POST | `/api/affiliates/:id/invite` | invite the company's manager |
| POST | `/api/affiliates/:id/deactivate`, `/reactivate` | suspend / restore |
| GET | `/api/affiliates/:id/report` | per-company settlement |
| GET / POST | `/api/affiliate/operators` | list / create shift operators (affiliate) |
| POST | `/api/affiliate/operators/:id/reset-pin`, `/remove` | manage an operator |
| GET | `/api/operator/access/:token` | resolve a saved operator link |
| POST | `/api/operator/access/:token/set-pin`, `/login` | first PIN / start a shift |
| POST | `/api/operator/change-pin`, `/logout` | shift self-service |

## Behaviour changed

- Any authenticated request whose user's stored role is neither `admin` nor `agent` answers
  `403 { error: { code: "ACCOUNT_SUSPENDED" } }` and clears `gm_access`/`gm_refresh` (D3).
- The `gm_op` cookie is ignored (D4).
- `GET /api/auth/invite/accept` and `POST /api/auth/invite/complete` resolve only agent
  invitations; an affiliate invitation token answers `400 INVALID_TOKEN`.
- `GET /api/pos/services` and `GET /api/pos/services/:id` return the organization's full active
  catalog to every caller; `POST /api/pos/folios` snapshots service / unit-type commissions for
  every caller (FR-005).
- `GET /api/pos/folios` no longer reads `?operator=`.
- `GET /api/folios?q=` and the client search no longer match an operator's name (D10).

## Response fields removed (D9)

| Response | Field |
| --- | --- |
| `GET /api/me` | `operator`; `user.affiliateCompanyId` |
| `GET /api/auth/invite/accept` | `invitation.invitation_type`, `invitation.company_name` |
| `POST /api/pos/folios` (sale) | `folio.operator_name` |
| `GET /api/pos/folios`, `GET /api/folios` (list rows) | `operator_name` |
| `GET /api/pos/folios/:id`, `GET /api/folios/:id` (detail) | `operator_name`; `payments[].operator_name`; `events[].operator_name` (timeline) |
| `GET /api/dashboard/day` | `per_seller[].operator_name` |
| `GET /api/cash/balances` | `balances[].role`, `balances[].affiliate_company` |
| `GET /api/reports/commissions` | `sellers[].affiliate_company`; `role` is the stored value (D6) |
| `GET /api/reports/commissions/export` (CSV) | the `affiliate_company` column |

## Request fields removed

| Request | Field |
| --- | --- |
| `POST /api/auth/invite/complete` | `position` |
| `GET /api/reports/commissions[/export]` | `affiliate_company_id` |
| the organization's cancellation policy write | `tiers[].affiliate_commission_pct` (stripped if sent) |
