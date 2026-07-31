# External integrations

Contracts for services **we do not own**. An integration doc is not a spec: there is no Definition
of Done, no scenarios, no story ID — we do not decide what these services do, we only record what
they promise and how we call them. That is why they live here and not under a domain folder.

`docs/SPEC.md` § External Integrations is the one-line index; this folder is the detail.

| Service | Used for | How we call it | Contract |
|---|---|---|---|
| **Agnostic Auth** | JWT issuance, magic-link initiate/verify, password hashing | Cloudflare **service binding** `AGNOSTIC_AUTH_API` (falls back to an HTTPS URL — `src/bindings.d.ts`) | [`agnostic-auth.md`](./agnostic-auth.md) |
| **Resend** | Transactional email: verification, invitations, password reset, ticket + apartado delivery, apartado reminder | `POST https://api.resend.com/emails` from `api-turistear/src/services/resend.ts` | No dedicated doc — the templates and call sites are the record; delivery behaviour is specified per feature (`docs/email/client-ticket-delivery.spec.md`) |
| **api.qrserver.com** | Rendering the QR **image** inside ticket emails (the signature itself is ours, HMAC — `docs/qr/folio-qr-signing.spec.md`) | `GET https://api.qrserver.com/v1/create-qr-code/` embedded as an `<img>` | No contract doc — third-party, unversioned, no SLA. Accepted trade-off: `docs/TECH_DEBT.md` #15 |
| **Cloudflare D1 / Workers / Cron** | Database, runtime, the apartado sweep | Platform bindings (`wrangler.jsonc`) | `docs/ARCHITECTURE.md`, `docs/ci-cd.md` |

## Adding one

Create `docs/integrations/<service>.md` recording: what we use it for, how it is reached (binding
vs URL, which secret), the endpoints and payloads we depend on, its error codes, and **what happens
to the product when it is unavailable**. Then add a row above and to `SPEC.md` § External
Integrations.

The last item is the one that gets skipped and matters most: a Worker on a cron cannot open
WhatsApp, and an unavailable auth service means nobody can register — those failure modes belong in
writing before they are discovered at 7am.
