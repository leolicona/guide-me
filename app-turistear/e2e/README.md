# E2E journeys

Playwright drives a real browser against a **deployed** environment (defaults to `app-dev`). These
journeys cross the browser/API boundary in ways the Vitest tiers structurally cannot — cookies,
redirects, SPA navigation, the camera path. Everything else belongs one tier down; see
[`docs/TESTING.md`](../../docs/TESTING.md).

**Not a merge gate.** `verify` runs `test:app` (Vitest) on every PR in seconds. This suite runs
nightly, on demand, and on any PR labelled `e2e` — `.github/workflows/e2e.yml`.

## The suite seeds its own data

```
auth ──▶ seed ──▶ chromium ──▶ cleanup
```

| Project | File | What it does |
|---|---|---|
| `auth` | `setup/auth.setup.ts` | Signs the agent and the admin in **through the API** and saves cookies to `.auth/*.json`. Works across origins because the API sets its session cookies on `.turistearya.com` (`COOKIE_DOMAIN`), so a session minted at `api-dev` is sent to `app-dev`. |
| `seed` | `setup/seed.setup.ts` | Picks the cheapest bookable tour with a departure **at least 2 days out** and creates an **apartado with a cash deposit**, writing `.auth/fixture.json`. It then asserts the folio's `booking_expires_at` is still ahead — see *A fixture the journey can actually settle* below. |
| `chromium` | `*.spec.ts` | The journeys, already signed in as the agent. |
| `cleanup` | `teardown/cleanup.teardown.ts` | Cancels the seeded folio. Never fails the run — a stale folio in dev is untidy, not a regression. |

Nothing skips. If credentials are missing the run **fails loudly**: a suite that silently skips
reports green while testing nothing, which is how the previous version of this spec managed never
to catch anything.

`workers: 1` — the seeded apartado is shared mutable state (one balance, settled once).

### A fixture the journey can actually settle

A booking's settle-by instant comes from the **departure** (`bookingExpiryDate` in the API:
departure − the org's pre-departure buffer), not from when it was sold. The catalog still lists
today's already-departed times, so "first slot with seats left" can hand back this morning's — and
the resulting folio is *born expired*: `status: booking`, a real balance, and a settle that answers
409 `BOOKING_EXPIRED`. That is what the suite's first real run hit, and why the seed now requires a
departure two days out and asserts the release timestamp is in the future before writing the
fixture. The API-side gap that lets such a folio be created at all is BUG-024.

## What you provide

Credentials come from the environment and are never committed; only cookies are persisted.

| Var | Meaning |
|---|---|
| `E2E_AGENT_EMAIL` / `E2E_AGENT_PASSWORD` | the agent/operator who owns the seeded booking |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | an admin (verifies the transfer, runs teardown) |
| `E2E_BASE_URL` | optional; defaults to `https://app-dev.turistearya.com` |
| `E2E_API_BASE` | optional; defaults to `https://api-dev.turistearya.com` |
| `E2E_FOLIO_ID` | optional **escape hatch** — reproduce against a specific existing apartado instead of seeding. Teardown leaves a caller-supplied folio alone. |

In CI these come from the `dev` GitHub environment's secrets.

## Run

```bash
# from app-turistear/
E2E_AGENT_EMAIL=... E2E_AGENT_PASSWORD=... \
E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... \
pnpm test:e2e            # headless — seeds, runs, cleans up
# pnpm test:e2e:headed   # watch it drive the browser
# pnpm test:e2e:report   # open the HTML report (trace/video on failure)
```

First time only: `pnpm exec playwright install chromium`.

Run the whole suite, not a single spec in isolation — a spec run alone has no seeded fixture and
`seededFixture()` will say so.

## The journeys

| Spec | Covers |
|---|---|
| `settle-breakdown.spec.ts` | US-LG03 / US-LG08 — an agent settles a balance **by transfer** (a different method than the cash deposit), an admin verifies the electronic payment, and the folio reads as **Mixto** with a per-payment **Desglose de pagos**. |

Four more are planned — login → POS sale → settle, cancellation with refund, QR scan → redeem, and
cash drop → admin verify (`docs/TESTING.md` § Playwright), one PR each.

## When a selector breaks

The labels these journeys query (`Cobrar y liquidar`, `Referencia de la transferencia`, …) are also
asserted by `src/features/bookings/components/SettleSheet.test.tsx`. A rename should turn that test
red first — in milliseconds, against no deployed environment. If a journey fails on a selector but
the component test is green, the label is fine and the page is not.

## History

This suite used to be a single spec that `test.skip`ped unless a human created an apartado by hand
and passed `E2E_FOLIO_ID`, and pointed at an environment that did not yet have the paid-ledger
stack. It verified the US-LG03 fix once and then gated nothing. The `auth`/`seed`/`cleanup`
projects above are the old `save-auth.mjs`, `create-apartado.mjs` and `refresh.mjs` folded into the
run itself — one path instead of two.
