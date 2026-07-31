# Bug Register

Tracks confirmed bugs, root causes, and fixes. Each entry is immutable once closed — it is a historical record, not a living document.

> **Format:** bugs are numbered in reverse-discovery order (newest first). Status: ⚠️ OPEN | ✅ FIXED | 🔍 INVESTIGATING.

---

## BUG-018 — A Single Mis-Scan Makes a Ticket Permanently Non-Refundable, and Nothing Can Un-Redeem It — ⚠️ OPEN

**Discovered:** 2026-07-31
**Reporter:** Claude Code (found while specifying Express Sale / Group Redemption)
**Affected component:** `api-turistear/src/routes/tickets/handler.ts:113-124` (`scanTicket`),
`api-turistear/src/utils/cancellationPolicy.ts` (D7 — the redeemed-line rule)
**Severity:** Medium — rare, but silent, irreversible, and it costs the customer money. No error,
no log, no admin override; the refund simply stops being owed.

### Symptom

An agent scans a QR at the wrong moment — the wrong departure, a customer who then does not travel,
a stray tap while re-arming the camera. From that instant the folio line is treated as **travelled**:
if the customer later cancels, the refund quote returns **0** no matter how far from departure they
are, and no path in the product can put it back.

Reproducible: sell a tour departing in five days under a ladder whose 120-hour tier refunds 100 %,
scan one pass by accident, then request cancellation. Before the scan the quote is a full refund;
after it, nothing.

### Root Cause

Two correct decisions that combine into an unrecoverable state.

1. **`redeemed_count` is increment-only.** `scanTicket` is the only writer:

   ```ts
   .set({ redeemedCount: sql`${folioLines.redeemedCount} + 1` })
   .where(and(…, sql`${folioLines.redeemedCount} < ${folioLines.quantity}`))
   ```

   There is **no** decrement anywhere in the codebase — no un-redeem endpoint, no admin override,
   no compensating path. A grep for writes to `redeemedCount` returns this one statement, the
   schema default, and read-only selects.

2. **The ladder treats any redemption as full consumption.** `computeCancellationRefund` skips the
   tier evaluation for a line with `redeemedCount > 0` and retains its full total
   (`cancellation-policy-engine.spec.md` D7). That is right for a passenger who travelled — you do
   not refund a trip that was taken. It fires identically on `redeemedCount = 1` of 10.

So the threshold for "this line is spent" is **one** pass, and the state that crosses it is
**write-once**. The customer's refund is destroyed by an agent's slip, and the only remedy today is
the admin's `override_note` path on `POST /api/folios/:id/refund/confirm` — which records a refund
that the quote says is zero, i.e. an out-of-band correction, not a fix.

### Impact and scope

- Predates every current feature; not introduced by Express Sale or Group Redemption.
- **Group redemption (`all_passes`, US-A79) does not create this bug but sharpens it:** the ladder
  already fires at the first pass, so refundability is lost either way — but a mis-scan under
  `all_passes` also burns the whole party's boarding rights in one tap, where `per_pass` burns one.
  This is called out in `docs/scanner/group-redemption.spec.md` § Open.
- Money is only lost when the customer subsequently cancels, so the incident and the loss are
  separated in time and nobody connects them.

### Proposed fix (not yet decided)

Smallest change that closes it: an **admin-only** `POST /api/tickets/:folioLineId/unredeem` taking a
required audit note, decrementing (or zeroing) `redeemed_count`, tenant-scoped like every other
admin folio route. It needs a product decision first — **who may forgive a boarding**, and whether
the correction is visible on the folio history — so it is recorded here rather than specified.

A cheaper mitigation, if the endpoint is judged too much: a **confirmation step in the scanner** when
`quantity > 1`, which reduces the accident rate without making the state recoverable. It does not
close the bug.

---

## BUG-017 — Any Idle Gap Longer Than 15 Minutes Forces a Full Re-Login — ✅ FIXED

**Discovered:** 2026-07-30
**Fixed:** 2026-07-30
**Reporter:** Leo Licona (field report: "as admin I have to enter the password a lot of times during the day")
**Affected component:** `api-turistear/src/middleware/auth.ts:127-131`, `api-turistear/src/utils/cookies.ts:9`
**Severity:** High — the single largest source of forced logins; worst on the smartphones agents use in the field.

### Symptom

An admin or agent types their email and password several times a day, despite a 60-day sliding
refresh token. Reliably reproducible: leave the app idle for more than 15 minutes (screen lock,
backgrounded PWA, a bus ride), return, and land on `/login`.

### Root Cause

Two decisions that are each defensible alone and fatal together:

1. `ACCESS_MAX_AGE = 60 * 15` (`cookies.ts:9`) gave the `gm_access` cookie a 15-minute `Max-Age`,
   even though the JWT it carries lives 10 minutes. The browser therefore *deletes* the cookie
   during any idle gap.
2. `authMiddleware` bailed out the moment `gm_access` was absent (`auth.ts:127-131`), throwing 401
   **without ever reading `gm_refresh`** — which was sitting in the very same request, valid for
   another 60 days.

So transparent renewal only worked inside the narrow window `[T+10min, T+15min]`. Outside it the
401 was unrecoverable, and `authService.ts` turned it into `window.location.replace('/login')`.

The behaviour was codified as intentional in `docs/auth/admin-login-session.spec.md` Scenario 9
("No refresh is attempted") and pinned by a test asserting `refreshSpy` was never called. The spec
conflated "no access token" with "no session" — but possession of a valid refresh token *is* a
session. Distinct from BUG-014's rotation stampede, which is narrower and still open.

### Fix

Both cookies now carry the idle-session window (`SESSION_REFRESH_TTL_SECONDS`); the access cookie
deliberately outlives the token it holds, since the JWT's own `exp` is the real gate and
`auth.ts:136` validates it on every request — the short `Max-Age` bought no security. And
`authMiddleware` now refuses only when **both** cookies are absent; a lone `gm_refresh` falls
through to the existing renewal path. Scenario 9 was re-scoped to "no session cookie at all" and a
new Scenario 7b covers renewal from a lone refresh cookie.

---

## BUG-016 — Manual Cancellation Never Releases Zoned Seats (Zone Counter Permanently Inflated) — ✅ FIXED

**Discovered:** 2026-07-27
**Fixed:** 2026-07-27
**Reporter:** Claude Code (found while specifying the Cancellation Policy Engine)
**Affected component:** `api-turistear/src/routes/folios/handler.ts` (`applyCancellation`)
**Severity:** High — silent, permanent inventory loss on zoned services. No error, no log; the
seats simply stop existing.

### Symptom

Cancelling a folio for a **zoned** service (US-A64 — e.g. a Turibus with *Bajo* / *Alto* decks)
appears to work: the folio flips to `cancelled` and `slots.booked` drops. But the seats are never
resold. The zone shows as fuller than it is, and the next time anything reconciles the slot, the
slot total snaps back up too.

### Root Cause

For a zoned service the authoritative counter is `slot_zones.booked`; `slots.capacity` / `booked`
are **derived** from the zone sums by `reconcileSlotTotals` (`services/zones.reconcile.ts`), so
every existing availability read keeps working unchanged.

`applyCancellation` — the shared commit for the admin cancel and the tourist-request approval —
decremented `slots.booked` directly for every line and **never looked at `zone_id`**:

```ts
const statements = lines.filter((l) => l.slotId).map((line) =>
  db.update(slots).set({ booked: sql`MAX(0, ${slots.booked} - ${line.quantity})` })…)
```

So on a zoned line: the zone row kept its seats (inflated forever → unsellable), and the write to
the derived `slots.booked` was itself doomed — the next reconcile recomputed it from the still-
inflated zone sums and undid it.

Every **other** release site already branched on `zone_id` — `cancelBooking`
(`pos/handler.ts:2613`), `rejectPayment` (`:2502`), and `sweepExpiredBookings`
(`pos/sweep.ts:62`), each pairing a `slot_zones` decrement with `reconcileSlotTotals` in the same
batch. The manual cancellation path was the one that was missed when zoned capacity shipped.

### Fix

`applyCancellation` now branches per line exactly like its three siblings: a zoned line decrements
`slot_zones.booked` and composes `reconcileSlotTotals` into the **same** D1 batch; an unzoned line
keeps the old slot decrement. Both keep the `MAX(0, …)` clamp this path has always had, so a
hand-edited counter can never go negative. Both call sites now select `folio_lines.zone_id`.

Deliberately not changed: the race-safe two-step order (guarded folio flip first, seats only for
the winner — BUG-013) is untouched.

### Test Coverage

`test/folios/folio-cancellation.test.ts` → `describe('Zoned cancellation releases zone seats
(regression)')` — 5 cases: the zone counter is released; the release **survives a later
reconcile** (the part that made the loss permanent); an unzoned line still works; a mixed
zoned + unzoned folio releases both; the zone counter clamps at zero. All 4 zoned cases were
verified to **fail** against the pre-fix handler and pass after.

---

## BUG-015 — Blank Page After Login Until Manual Refresh (Failed Lazy Chunk + No ErrorBoundary) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Leo Licona (symptom) / Claude Code (root-cause analysis)
**Affected component:** `app-turistear/src/App.tsx`, `app-turistear/src/main.tsx`, `app-turistear/wrangler.jsonc`
**Severity:** High — login intermittently appears broken; only a manual refresh recovers.

### Symptom

Sometimes, after submitting the login form, the page goes **completely blank** (white). Refreshing
loads the app correctly and the session is already active.

### Root Cause (primary hypothesis)

Every page is `lazy()`-loaded (`App.tsx:10-32`) and the app has **no ErrorBoundary anywhere**
(verified by grep). The post-login landing page (`PosCatalogPage` / `DashboardPage`) is a separate
hashed chunk fetched **at the moment of navigation after login**:

1. The user opens `/login`; the browser holds an `index.html` referencing that deploy's chunk hashes.
2. The app is **redeployed** (or the dev server restarts) while the login page sits open.
3. Login POST succeeds → session cookies are set. `navigate('/pos')` triggers
   `import('./pages/PosCatalogPage')` → the old chunk hash no longer exists. With
   `not_found_handling: "single-page-application"` the asset request resolves to `index.html`
   (or 404), so the dynamic import rejects.
4. `<Suspense>` only handles *pending*, not *rejected*; with no ErrorBoundary, React unmounts the
   **entire root** → permanent white page.
5. F5 loads the fresh `index.html`; the cookies from step 3 are already set → "session appears active".

This matches all three observations: *sometimes* (only across a redeploy/restart), *blank* (root
unmounted), *refresh fixes it and the user is logged in*. Confirm by checking the browser console
for `Failed to fetch dynamically imported module` when it reproduces.

### Fix

`src/layout/AppErrorBoundary.tsx` (new), wired around `<App />` in `main.tsx`:
- Any uncaught render error now shows a "Algo salió mal / Recargar" screen instead of a
  blank page.
- A chunk-load error (matched by message: `Failed to fetch dynamically imported module`,
  `Importing a module script failed`, …) triggers an automatic `window.location.reload()`,
  rate-limited via a sessionStorage timestamp (≥ 10 s between auto-reloads) so a genuinely
  broken deploy can't reload-loop. The reload self-heals the stale-chunk case: the fresh
  `index.html` carries the new hashes and the session cookie survives.

Root-cause confirmation pending a real-world repro (check the console for the chunk-load
message next time) — but the boundary fixes the blank-page failure mode for ANY render error.

---

## BUG-014 — Concurrent Token Refresh Stampede Can Destroy a Valid Session — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/middleware/auth.ts:78-111`
**Severity:** High — intermittent forced logouts after ~15 min of idle.

### Symptom

After the 15-minute access token expires while the app is open, returning to the tab sometimes
bounces the user to `/login` even though the refresh token was valid.

### Root Cause

On window focus, React Query refires several queries **in parallel** (AppLayout badge counts at
`AppLayout.tsx:75-83` plus the page query). Each request hits `authMiddleware`, sees the expired
`gm_access`, and independently calls `refreshTokens()` with the **same** `gm_refresh` cookie. If the
auth service rotates refresh tokens (single-use), one request wins and sets the new cookie pair while
the losers throw and call `clearSessionCookies()` (`auth.ts:88-89`). Whichever response reaches the
browser **last** wins the cookie jar — a loser arriving after the winner wipes the brand-new valid
cookies. Client-side, the losers' 401s also trigger `handleUnauthorized` → hard redirect to `/login`.

### Fix

`authMiddleware` no longer emits delete-cookie headers when `refreshTokens()` fails — a loser
of the rotation race can no longer wipe the winner's freshly set session. A genuinely dead
refresh token grants nothing and keeps 401ing, so leaving it in place is safe; the conclusive
paths (user no longer exists, suspended) still clear. Test
`admin-login-session.test.ts` Scenario 8 updated to assert NO Set-Cookie headers on a failed
refresh. (Serializing refresh per user — lock/DO — remains a possible hardening if the auth
service's rotation proves strict single-use under heavy parallelism.)

---

## BUG-013 — Concurrent Folio Cancellation Releases Seats Twice — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/folios/handler.ts` (`buildCancellationBatch`, `cancelFolio`, `approveCancellationRequest`)
**Severity:** Medium — inventory integrity: `booked` undercount → oversell.

### Symptom

Two near-simultaneous cancellations of the same folio (double-click, or direct admin cancel racing a
tourist-request approval) decrement `slots.booked` twice per line.

### Root Cause

The batch built by `buildCancellationBatch` (`handler.ts:239-269`) runs the per-line slot releases
**unconditionally**; the `ne(folios.status, 'cancelled')` guard sits only on the folio UPDATE. A
0-row guarded UPDATE does **not** abort a D1 batch, so the loser's batch still applies its slot
decrements (`MAX(0, booked − qty)` only prevents going negative, not double release). The pre-check
(`cancelFolio:334`) reads `status` before either batch commits, so both pass it.

### Fix

`buildCancellationBatch` replaced by `applyCancellation`: the guarded folio UPDATE
(`status != 'cancelled'`, with `.returning()`) runs FIRST; only the winner then releases the
seats in one batch. A racing loser releases nothing and both entrances (`cancelFolio`,
`approveCancellationRequest`) surface it as the existing 409 "already cancelled". The refund
fields ride the guarded flip, so they can never apply to a folio someone else cancelled.
Residual (accepted, conservative): a crash between flip and release leaves seats booked on a
cancelled folio — no oversell, same compensate-style trade-off as POS confirm.

---

## BUG-012 — `createSchedule` Bulk Insert Exceeds D1's 100-Bound-Parameter Limit — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/services/slots.handler.ts:87,407-409`
**Severity:** Medium — recurring schedules that materialize ≥ 12 slots fail.

### Symptom

Creating a weekly schedule over a window producing 12+ slot dates throws a D1 error
(`too many SQL variables` / bound-parameter limit), after the `schedules` row was already inserted —
leaving a schedule with partial (or zero) materialized slots.

### Root Cause

```ts
// slots.handler.ts:85-87 — the comment's column count is stale
// "Each materialized slot row binds 7 columns, so keep bulk inserts well under the limit."
const INSERT_CHUNK = 12
```

Each row now binds **9** values (`id, organizationId, serviceId, scheduleId, date, startTime,
capacity, booked, status` — `createdAt`/`updatedAt` use SQL defaults). 12 × 9 = **108 > 100**
(D1's documented per-query bound-parameter cap). The chunk size was computed for a 7-column row
that has since grown.

### Fix

`INSERT_CHUNK` is now DERIVED — `Math.floor(100 / 9) = 11` rows → 99 parameters — so a future
column addition shrinks the chunk instead of overflowing the cap. The chunked inserts also run
in a single `db.batch`, so a mid-way failure can no longer strand a half-materialized schedule.
Regression test added: a Mon–Fri schedule over 4 weeks (20 slots) materializes successfully
(`test/catalog/schedules-slots.test.ts`).

---

## BUG-011 — `inviteAgent` Expires Pending Invitations Across ALL Organizations — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/agents/handler.ts:36-44`
**Severity:** Medium — multitenancy isolation violation (Rule: every tenant-scoped write must be org-filtered).

### Symptom

Org A's admin invites `bob@x.com`; Org B's still-pending invitation for the same email is silently
flipped to `expired` — Org B's invite link stops working with no notice to anyone.

### Root Cause

The "supersede previous invites" UPDATE filters only by `identity` and `status`:

```ts
.where(and(eq(invitations.identity, input.identity), eq(invitations.status, 'pending')))
// ← missing eq(invitations.organizationId, admin.organizationId)
```

### Fix

Added `eq(invitations.organizationId, admin.organizationId)` to the supersede UPDATE, plus a
cross-org regression test (`test/auth/agent-invitation.test.ts`): org B inviting the same
identity leaves org A's pending invitation untouched while creating its own.

---

## BUG-010 — Email Verification Is a State-Changing GET Behind `useQuery` (Single-Use Token Burns) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/auth/index.ts:33` (+ `handler.ts:95-129`), `app-turistear/src/features/auth/hooks/useVerify.ts`
**Severity:** Medium — users see "Verificación fallida" for accounts that verified fine.

### Symptom

A user opens the verification link, sees success — then switches tabs and back (or the page
refetches for any reason) and the screen flips to "El enlace es inválido o ha expirado". Worse:
corporate/AV email link-scanners that prefetch GETs can consume the token **before the user ever
clicks**.

### Root Cause

`GET /api/auth/verify` consumes a single-use magic-link token (state-changing GET). The client wraps
it in `useQuery` with `retry: false` but default `refetchOnWindowFocus`/`refetchOnMount`, so any
refetch re-submits the already-consumed token and the query flips from success to error, which the
page renders as failure.

### Fix

- Server: added `POST /api/auth/verify` (zod-validated body, same handler); the GET route
  stays for legacy deep-links only.
- Client: `verifyEmail` now POSTs, and `useVerify` runs exactly once — `staleTime/gcTime:
  Infinity`, `refetchOnMount/WindowFocus/Reconnect: false`, `retry: false` — so a delivered
  success can never be overwritten by a refetch of a consumed token.
  (Note: the email's magic link points at the APP page, not the API, so non-JS scanner
  prefetches never consumed the token; the practical trigger was tab-focus refetch.)

---

## BUG-009 — Signed QR Access Tokens Sent to a Third-Party QR Image Service — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12 (portal; see residual note for the email)
**Reporter:** Claude Code (static analysis)
**Affected component:** `api-turistear/src/routes/portal/handler.tsx:26-27` (and the confirmation email per its comment)
**Severity:** Medium (security/privacy) — the entry credential leaves the trust boundary.

### Symptom / Risk

The portal page (and ticket email) render QR images via
`https://api.qrserver.com/v1/create-qr-code/?...&data=<signed ticket token>`. The signed token **is**
the access credential the scanner redeems. A third party (plus any intermediary caches/logs) receives
every customer's valid entry tokens.

### Fix

The portal now renders QRs locally as inline SVG via `uqr` (tiny, zero-dep encoder) — the
signed token never leaves our origin; tests assert `<svg` present and `qrserver.com` absent.

**Residual:** the confirmation EMAIL still embeds `qrserver.com` images (`services/resend.ts`)
because mail clients only render hosted `<img>` URLs and refuse `data:` URIs. Closing it needs
a self-hosted QR-image endpoint (e.g. a PNG render served from the API origin) — tracked as
follow-up, not done here.

---

## BUG-008 — Dev Port Roulette: App Can Proxy `/api` to Its Own Stub Worker (Fake Login Success) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/vite.config.ts` (proxy target `http://localhost:5173`), `app-turistear/worker/index.ts`
**Severity:** Medium (dev only) — intermittent, very confusing auth behavior in local dev.

### Symptom

In local dev, login sometimes "succeeds" with any credentials and then immediately bounces back to
`/login`; API data never loads.

### Root Cause

Both workspaces run plain Vite; whichever starts first claims port 5173. The app's proxy targets
`http://localhost:5173` assuming that's the API. When the **app** wins the port (e.g. `dev:app` alone,
or `pnpm dev` startup-order race), `/api/*` loops back into the app's own stub worker, which returns
`Response.json({ name: "Cloudflare" })` with **200 for every `/api/` path** — so `POST /api/auth/login`
"succeeds", then `getMe` resolves `res.user === undefined` and TanStack v5 errors with
"query data cannot be undefined" → bounce to `/login`.

### Fix

Ports pinned with `strictPort: true` — API on 5173, app on 5174 (a collision now fails loudly
instead of silently shifting). The app's stub worker answers `/api/*` with a 404 + explanatory
error body instead of the fake `{ name: "Cloudflare" }` 200.

---

## BUG-007 — "Org-Local Today" Is Actually UTC: POS Day Windows Shift After ~18:00 (UTC-6) — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/features/pos/dates.ts:6`, `src/pages/PosCatalogPage.tsx:40`, `api-turistear/src/routes/pos/handler.ts:38`
**Severity:** Medium — every evening, "Hoy" silently becomes tomorrow.

### Symptom

For a Mexico-based org (UTC-6), from ~6 pm local time onward: the default "Hoy" 3-day window anchors
on **tomorrow**, today's remaining slots vanish from the default catalog view, the date picker's
`min` forbids selecting the actual current day, and `SlotPicker`'s "Hoy" label lands on the wrong row
(`dayLabel` parses with *local* midnight while `todayStr()` is UTC — mixed bases).

### Root Cause

`new Date().toISOString().slice(0, 10)` yields the **UTC** calendar date. The comments document a
"single-timezone MVP model (org-local)", but the implemented timezone is UTC, not the org's.

### Fix

`features/pos/dates.ts#todayStr` now builds the date from the DEVICE's local calendar
(`getFullYear/getMonth/getDate`), not `toISOString()` — staff devices run in the org's
timezone (single-timezone MVP). `PosCatalogPage`'s duplicate local copy was removed in favor
of the shared helper, so catalog, sheet, and detail all agree, and `SlotPicker.dayLabel`'s
local-midnight parsing is now consistent with the anchor. The client pins the value to the
API via the existing `?today=` / `?from=` params.

**Residual (accepted):** the server's `utcToday()` fallback still applies when a client omits
the pin, and an `org.timezone` column would be needed for true org-local server-side dates —
deferred with the single-timezone MVP model.

---

## BUG-006 — Logout Is Fire-and-Forget: A Failed Logout POST Leaves the Session Alive — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/features/auth/hooks/useLogout.ts:17-18`
**Severity:** Low/Medium (security) — same shared-machine class as BUG-003's residual note.

### Symptom

User clicks "Cerrar sesión", lands on `/login`, closes the laptop. If the logout POST failed
(offline, server hiccup), the httpOnly cookies were never cleared and the refresh token was never
revoked — the next visit is silently authenticated again.

### Root Cause

`handleLogout` navigates first and fires `mutation.mutate()` with the result ignored; the client
cannot clear httpOnly cookies itself, so the POST is the only thing that ends the session, and its
failure is invisible.

### Fix

`useLogout` now AWAITS the logout POST before evicting `['me']` and navigating (the confirm
dialog already shows `isPending`, so the UX cost is one spinner). On failure it stays put and
exposes `isError`, which `AccountMenu`'s dialog renders as "No se pudo cerrar la sesión…" with
the button available for retry. This also closes BUG-003's residual sub-second race (back-press
before the cookies cleared server-side), which had been deferred.

---

## BUG-005 — Post-Login `fetchQuery(['me'])` Silently Retries a Failing `/api/me` 3 Times — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/features/auth/components/LoginForm.tsx:48-52`
**Severity:** Low — ~7 s frozen login button when `/api/me` genuinely fails after login.

### Root Cause

`useMe` sets `retry: false`, but that is an **observer** option; `queryClient.fetchQuery` here doesn't
inherit it and uses the client default (`retry: 3` with backoff). Each retried 401 also re-runs the
global `handleUnauthorized` interceptor (harmless on `/login`, but noisy).

### Fix

`retry: false` passed to the post-login `fetchQuery`, and `AuthGuard`'s comment updated — it
still described the old invalidate-based flow this `fetchQuery` replaced.

---

## BUG-004 — Authenticated Users Get the Login Form on `/` and Unknown Paths — ✅ FIXED

**Discovered:** 2026-06-12
**Fixed:** 2026-06-12
**Reporter:** Claude Code (static analysis)
**Affected component:** `app-turistear/src/App.tsx:183`, `app-turistear/src/pages/LoginPage.tsx`
**Severity:** Low (UX) — reads as "my session was lost".

### Symptom

Opening the bare domain (`app.turistearya.com/`) or any unknown path with a live session shows the
login form instead of the app.

### Root Cause

The `*` catch-all navigates to `/login`, and `LoginPage` never checks for an existing session.

### Fix

The `*` catch-all now renders a session-aware `RootRedirect` (in `App.tsx`): it consults
`useMe()` (spinner while resolving) and forwards an authenticated user to their role landing
(admin → `/dashboard`, agent → `/pos`, mirroring US-UX01); logged out still → `/login`.
Visiting `/login` directly with a live session still shows the form — deliberate, to keep the
login/logout flows simple.

---

## BUG-003 — Back Button After Logout Restores the App from Stale React Query Cache — ✅ FIXED

**Discovered:** 2026-06-09
**Fixed:** 2026-06-09
**Reporter:** Leo Licona (manual QA)
**Affected component:** `app-turistear/src/features/auth/hooks/useLogout.ts`
**Severity:** Security — a borrowed/shared machine remains fully accessible after a "logout".

### Symptom

Clicking **Log out** correctly redirects to `/login`. But pressing the browser **back button**
returns the user to `/dashboard` (or any prior protected route) with the session apparently
active — the entire app is navigable without re-authenticating.

### Root Cause

`useLogout` cleared the Zustand store and navigated to `/login`, but **never evicted the
`['me']` React Query cache**:

```ts
// WRONG — cache survives; back-nav re-renders AuthGuard from it
const handleLogout = () => {
  clear()                                  // Zustand only
  navigate(ROUTES.LOGIN, { replace: true })
  mutation.mutate()                        // logout API fires async
}
```

The chain that produced the bug:

1. `useMe` (`useMe.ts:13`) caches the user with `staleTime: 5 * 60 * 1000` — fresh for 5 min.
2. `BrowserRouter` (History API) handles the back button as a client-side `popstate`, **not** a
   full page reload, so the in-memory React Query cache survives logout.
3. On back-nav, `AuthGuard` (`AuthGuard.tsx:11`) calls `useMe()`, gets a **cache hit** (still
   fresh), and returns the cached user with **no network request** → `isError: false`,
   `user != null` → it renders the protected page.
4. The `401` interceptor in `authService.ts` (`handleUnauthorized`) that would have redirected
   only runs when a request is actually made — the stale cache means `/api/me` is never called,
   so the safety net is bypassed.

The API side was innocent: `logout()` correctly clears both cookies (`gm_access`,
`gm_refresh`) via `clearSessionCookies()`. `navigate(..., { replace: true })` was **not** a
factor either — the back button reaches earlier protected history entries regardless of
push-vs-replace. The sole cause was the un-evicted `['me']` cache.

### Fix

Evict the `['me']` query in `handleLogout`, before navigating, so the next `useMe()` mount has
no cache → shows the spinner → hits `/api/me` → gets `401` (cookie already cleared) → `AuthGuard`
redirects to `/login`:

```ts
// CORRECT
const queryClient = useQueryClient()

const handleLogout = () => {
  clear()
  queryClient.removeQueries({ queryKey: ['me'] }) // kill cache before nav
  navigate(ROUTES.LOGIN, { replace: true })
  mutation.mutate()
}
```

`removeQueries` (not `invalidateQueries`) is deliberate: removing the entry forces
`isLoading: true` and a real refetch on the next mount, rather than serving stale data while a
background refetch resolves.

### Residual note

A sub-second race remains: if the user presses back **before** the async logout request clears
the cookies server-side, `/api/me` could still return `200`. The reported scenario (human
reaction time between clicking logout and pressing back) is fully resolved by the cache
eviction; closing the race entirely would require awaiting `mutation` before navigating, at the
cost of logout snappiness — deferred as not worth the UX trade for the MVP.

### Related changes

- `app-turistear/src/features/auth/hooks/useLogout.ts` — `removeQueries(['me'])` before navigate

---

## BUG-002 — `commission_bonus` Applied as Flat Centavos per Pass Instead of % of Line Total — ✅ FIXED

**Discovered:** 2026-06-08
**Fixed:** 2026-06-08 (deployed `2619f2d2`)
**Reporter:** Leo Licona (manual verification)
**Affected component:** `api-turistear/src/routes/pos/handler.ts`

### Symptom

An agent with `base_commission = 1000` (10%) selling a service with `commission_bonus = 500` (5%) on a $1,000 sale received **$125** instead of **$150**. The system was consistently underpaying agents by the full service-bonus portion.

### Root Cause

The `bonusTotal` reduction in `confirmSale` used:

```ts
// WRONG — treats 500 as a flat centavo amount per pass
(sum, l) => sum + l.commissionBonus * l.quantity
```

`commission_bonus = 500` (basis points = 5%) was multiplied by `quantity` (e.g., 5 passes → `500 × 5 = 2,500` centavos = $25 bonus), rather than applied as a percentage of the line total (`5% × $1,000 = $50`). The bug caused the bonus to scale with pass count rather than sale value, and the discrepancy worsened as price per pass increased.

### Fix

Changed to percentage-of-line-total (consistent with `base_commission` treatment):

```ts
// CORRECT — 500 bp = 5% of line_total
(sum, l) => sum + Math.round((l.lineTotal * l.commissionBonus) / 10000)
```

### Data corrections (production)

Three production folios were under-credited and corrected:

| Folio | Was | Should Be | Delta |
|---|---|---|---|
| `2c3cab17` ($1,000 sale) | $125 | **$150** | +$25 |
| `2590a959` ($3,000 sale) | $400 | **$450** | +$50 |
| `999362eb` ($900 sale) | $115 | **$135** | +$20 |

Agent's balance adjusted: $875 → **$780** (the $95 difference credited).

### Related changes

- `api-turistear/src/routes/pos/handler.ts` — formula fix
- `api-turistear/src/routes/services/schema.ts` — `commission_bonus` validation: int 0–10000 (bp), replaces money validator
- `api-turistear/src/db/schema.ts` — column comment updated to clarify basis points
- `app-turistear/src/features/catalog/types.ts` — `percentToBasisPoints` / `basisPointsToPercent` helpers; field changed from `$` to `%`
- `app-turistear/src/features/catalog/schemas.ts` — validation 0–100 (percent in UI)
- `app-turistear/src/features/catalog/components/ServiceFormDialog.tsx` — conversion on prefill + submit
- `app-turistear/src/pages/CatalogDetailPage.tsx` — display as `X%` not money
- `docs/commissions/commissions.spec.md` — formula, data model, scenarios updated
- Tests: `pos-controlled-discount.test.ts` + `service-catalog.test.ts` corrected

---

## BUG-001 — Commission Formula Divisor `/100` Instead of `/10000` (1000× Overcharge) — ✅ FIXED

**Discovered:** 2026-06-07
**Fixed:** 2026-06-07
**Reporter:** Leo Licona (CURL validation)
**Affected component:** `api-turistear/src/routes/pos/handler.ts`

### Symptom

Two production folios had astronomical `commission_amount` values:

| Folio | Total | `commission_amount` | Effective rate |
|---|---|---|---|
| `062fe361` | $900 | $9,000 | **1000%** |
| `eabda6ba` | $1,390 | $35,550 | **2557%** |

### Root Cause

`agents/schema.ts` defined `base_commission` in **basis points** (`1000 = 10%`), but `pos/handler.ts` divided by `100`:

```ts
// WRONG — treats basis points as if they were simple integer percents
const baseCommission = Math.round((total * basePct) / 100)
// basePct = 1000 (10% in bp) → divides by 100 → 10× overcharge
```

A 10% agent (`base_commission = 1000`) produced a 1000% commission.

### Fix

```ts
// CORRECT — 10000 is the basis-point denominator (1000 bp = 10%)
const baseCommission = Math.round((total * basePct) / 10000)
```

### Data corrections (production)

| Folio | Was | Should Be |
|---|---|---|
| `062fe361` | $9,000 | **$900** |
| `eabda6ba` | $35,550 | **$427.50** |

A `820,000` centavo cash drop that had been confirmed against the inflated balance was reviewed and left as-is (arithmetically correct given all recorded transactions at that moment — user chose Option A).

### Related changes

- `api-turistear/src/routes/pos/handler.ts` — divisor `/100` → `/10000`
- Production D1 rows patched via `wrangler d1 execute`

---

*See also `docs/TECH_DEBT.md` for known limitations and accepted trade-offs that are not bugs.*
