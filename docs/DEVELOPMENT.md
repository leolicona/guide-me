# Running the app locally

Three commands from a worktree root, then log in and click. This document exists because two of the
three would otherwise fail in ways that look like something else entirely.

```bash
cp api-turistear/.dev.vars.example api-turistear/.dev.vars   # once per worktree
pnpm --filter api-turistear db:migrate:local                  # once per worktree
pnpm --filter api-turistear seed:local                        # creates the admin + sample data
pnpm dev                                                      # both servers
```

| | |
|---|---|
| App | **http://localhost:5174** |
| API | http://localhost:5173 *(the app proxies `/api` here — you never open it directly)* |
| Email | `admin@local.test` |
| Password | `Local1234!` |

`pnpm dev` runs both workspaces in parallel with **pinned, strict ports** (BUG-008): whichever
started first used to grab 5173, and the app's proxy could loop `/api` back into its own stub
worker, which answered every path with a fake 200 — login "succeeded" with any password at all.

---

## Why `.dev.vars` is not optional

Two of its lines are the difference between a working login and one that silently does nothing.

**`COOKIE_DOMAIN=` (empty).** `wrangler.jsonc` sets `.turistearya.com`, and a browser refuses a
cookie whose `Domain` does not match the host that sent it. Locally the login call returns **200**
with a real JWT, the browser drops both cookies on the floor, and the next request is a 401. It
presents as "wrong password" and it is not. Empty makes the cookie host-only
(`c.env.COOKIE_DOMAIN || undefined`, `utils/cookies.ts`).

**`DEV_AUTH_SERVICE_URL`.** Password hashing, password verification and JWT minting all live in the
**`agnostic-auth`** Worker, reached in production through a Cloudflare *service binding*. A service
binding does not exist locally, so `services/agnosticAuth.ts` checks this URL first — the escape
hatch was already in the code, just undocumented.

The remaining values are local origins (so a QR minted locally does not resolve to the live site), a
throwaway `QR_SECRET`, and a deliberately invalid `RESEND_API_KEY`.

---

## Why there is a seed script instead of "just register"

`POST /api/auth/register` writes the user and **then** emails a magic link through Resend. With no
Resend key the call 502s *after* the row is inserted, leaving the account `unverified` — which login
refuses. The verification token lives in agnostic-auth's KV and reaches a human only by email, so
there is nothing to paste.

`seed:local` sidesteps all of it: it asks agnostic-auth for a password **hash** — a stateless call
that creates no account anywhere — and writes an already-`active` admin. That is exactly equivalent,
because `POST /api/auth/verify` does nothing else to the user row but set `status = 'active'`.

```bash
pnpm --filter api-turistear seed:local                        # admin@local.test / Local1234!
pnpm --filter api-turistear seed:local yo@test.com MiClave1!  # or your own
```

It is **idempotent** — it deletes its own organization and everything under it first, so re-running
is how you get back to a clean board.

### What it seeds, and why each row is there

An organization in `America/Cancun` (deliberately **not** UTC — several bugs in this codebase were
day-boundary bugs that a UTC org cannot reveal), an admin, an agent, four services, and five sales:

| Sale | What it exercises |
|---|---|
| Paid, tickets never sent | the `Enviar boletos` verb, the *Sin entregar* pill |
| Express transfer, no name | `Cliente ••4444`, the amber rail, `Verificar y enviar`, `Ref. SPEI 4471` |
| Apartado past its deadline | the red `Venció hace 2 d` chip, the *Vencidos* pill |
| Cancelled, refund unpaid | `Debe hace 8 d`, `Confirmar reembolso`, the *Reembolsos* pill |
| **Paid 200 days ago** | **outside the 30-day load window** — reachable *only* through search or a date range, which is what US-A83 exists for |

That last row has a customer and a service that appear **nowhere else**. The first version of this
seed reused an existing service there, so searching for it matched a row that was already loaded and
the server fallback never fired — the one behaviour the row exists to demonstrate.

---

## Things that are supposed to fail locally

Not misconfiguration — the intended signal:

- **Anything that sends email** (register, invites, cancellation notices) returns a 502 from Resend.
- **The scheduled worker** (booking expiry) does not run; `vite dev` has no cron triggers.
- **QR scanning** works, but a QR minted locally is signed with the throwaway `QR_SECRET` and is
  meaningless anywhere else.

---

## One local database per worktree

`.wrangler/` lives inside `api-turistear/` and is git-ignored, so **every worktree has its own
SQLite replica**. Migrating and seeding is per-worktree; nothing you do in one leaks into another,
and a fresh worktree starts empty. That is usually what you want when validating a branch — but it
does mean the two commands above are per-worktree, not per-machine.
