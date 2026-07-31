# Feature: Group Redemption — one scan boards the whole party

**User stories:** **US-AG48** (one scan redeems every pass on the ticket), **US-A79** (the admin
chooses the mode). Registered in `docs/SPEC.md`. **Phase:** 2 (Core Enhancements) · **agent + admin.**

**Builds on:** *Online QR Scanner* (`docs/scanner/online-qr-scanner.spec.md`, US-AG15/AG17/AG19) —
the redemption endpoint and the result screen this feature branches · *Folio QR Signing*
(`docs/qr/folio-qr-signing.spec.md`) — `passes_total` and the per-line ticket.

**Sibling:** *Express Sale* (`docs/pos/express-sale.spec.md`) — independent, but the two together are
why a family of four is **one** QR redeemed in **one** scan.

---

## Context

A QR is a **per-line** boarding pass carrying `passes_total = quantity`. Today
`POST /api/tickets/scan` redeems exactly **one** pass per scan
(`src/routes/tickets/handler.ts:113-124`):

```ts
.set({ redeemedCount: sql`${folioLines.redeemedCount} + 1` })
.where(and(…, sql`${folioLines.redeemedCount} < ${folioLines.quantity}`))
```

That is correct for a Turibus, where passengers of one booking board at different stops. It is wrong
for a lancha, where a family of four arrives together and hands over one code.

The cost is worse than four scans, because `ScannerPage` pauses after each result and requires an
explicit **"Escanear siguiente"** tap to re-arm (a deliberate guard so one QR produces one request).
A party of four is therefore **four scans and four taps at the gate**, with the rest of the group
waiting — the operational moment where the queue is least tolerant.

There is no way for an operator to say which of these two worlds they run in.

---

## Scope boundary

1. **`per_pass` is the default and is byte-identical to today.** An organization that never opens the
   setting sees no change whatsoever — same SQL, same response shape, same result screen.
2. **Mechanically checkable:** `test/tickets/online-qr-scanner.test.ts` and
   `test/qr/folio-qr-signing.test.ts` must pass **unedited**.
3. **The atomicity guarantee is unchanged.** Both modes remain a single guarded UPDATE with the same
   `redeemed_count < quantity` race backstop. No mode introduces a read-then-write.
4. **No new redemption authority.** The scanner stays `agent | admin`, and the key is still derived
   from the **scanning** agent's organization.
5. **The scanner's re-arm behaviour is untouched.**

---

## Design decisions

| # | Decision | Why |
|---|---|---|
| **D1** | A per-organization setting `qr_redemption_mode`, enum **`per_pass` \| `all_passes`**, `NOT NULL DEFAULT 'per_pass'`. | Existing orgs are unchanged by construction, and the default is the conservative one: burning one pass by mistake is recoverable operationally, burning ten is not. |
| **D2** | **Organization scope only** — no per-service override in this phase. | Chosen by product over the org-default + per-service-override shape. Accepted cost is stated under *Known behaviour change*: an org running both a continuous-boarding Turibus and a one-shot lancha must pick the wrong mode for one of them. Deferring is safe because adding a nullable `services.qr_redemption_mode` later needs **no data migration** — the org value simply stays the fallback. |
| **D3** | The mode is read from the **scanning agent's** organization, never from the token's payload. | Consistent with `deriveOrgKey`, which already scopes redemption to the caller's org. The token says who issued the ticket; the operator at the gate decides how their gate works. |
| **D4** | `all_passes` sets `redeemed_count = quantity` in the **same** guarded UPDATE. | `SET redeemed_count = quantity WHERE redeemed_count < quantity` is exactly as atomic as the increment, in one statement, with the same race backstop and the same `ALREADY_CONSUMED` semantics on a rescan. No new concurrency surface. |
| **D5** | **Binary modes only** — no third "confirm the count" mode. | Considered and declined: a count-confirm step keeps `redeemed_count` honest when 8 of 10 arrive, but costs the extra tap that is the whole point. Operators who need an accurate boarded count keep `per_pass`. The trade is made once, by the admin, not per scan. |
| **D6** | The response shape branches: `per_pass` keeps `pass_number`; `all_passes` omits it and returns the full count. | A pass ordinal is meaningless when the party redeems as one — returning `pass_number: 4` for a single scan of a 4-pass ticket would be a lie the UI then has to render. |
| **D7** | No agent-facing toggle at the gate. | A mis-tap would irreversibly burn a whole party's passes, and **there is no un-redeem endpoint anywhere in the system** — `redeemed_count` is increment-only. The setting belongs to whoever knows how the operation boards. |
| **D8** | The Settings help text names the cost explicitly: **faster group boarding, at the price of an accurate boarded-count, with no way to un-redeem.** | The admin is trading an audit property for speed. A setting that hides its trade-off gets flipped by someone who did not know they were making it. |

---

## Data Model

### Migration `0057_express_sale.sql` (shared)

```sql
-- US-A79 (D1) — how a scan consumes a ticket's passes. Existing orgs keep today's behaviour.
ALTER TABLE `organizations` ADD COLUMN `qr_redemption_mode` text NOT NULL DEFAULT 'per_pass';
```

Drizzle (`src/db/schema.ts`, `organizations`):

```ts
qrRedemptionMode: text('qr_redemption_mode', { enum: ['per_pass', 'all_passes'] })
  .notNull()
  .default('per_pass'),
```

> Shares migration `0057` with `docs/pos/express-sale.spec.md` because the two ship together. If
> they are split, this column moves to its own numbered migration.

---

## Business rules (enforced server-side)

1. `POST /api/tickets/scan` resolves the mode from **`c.var.user.organizationId`** (D3), never from
   the token payload.
2. Redemption remains **one guarded UPDATE**, branching only in its SET expression:
   ```
   per_pass:    redeemed_count = redeemed_count + 1
   all_passes:  redeemed_count = quantity
   WHERE  … AND redeemed_count < quantity        ← identical in both modes
   ```
3. A scan of a ticket with **no** passes left returns `ALREADY_CONSUMED` in both modes, unchanged.
4. In `all_passes`, a ticket **partially** redeemed under `per_pass` (say 2 of 5) is completed by one
   scan: `redeemed_count` becomes 5. The guard permits it because `2 < 5`.
5. Every other gate is unchanged and evaluated in the same order: signature → line/folio lookup
   (org-scoped) → folio status → payload expiry → redeem.
6. The mode is writable only through the organization settings endpoint, `admin` role, validated
   against the enum.

---

## Authorization — who may do this

| Action | Who |
|---|---|
| Scan / redeem | `agent`, `admin` — unchanged (`/api/tickets` router). |
| Read `qr_redemption_mode` | Any authenticated member of the org, via `GET /api/organizations/me` — the scanner needs it. |
| Write `qr_redemption_mode` | **`admin` only**, via the existing organization settings write. |

**Cross-org:** the scanning org's key derivation is unchanged, so a foreign ticket fails at
`INVALID_SIGNATURE` before the mode is ever consulted. A settings write for another organization
returns **`404`**.

---

## API surface

### `POST /api/tickets/scan` — response branches

```jsonc
// per_pass (unchanged)
{ "result": "valid",
  "ticket": { …, "passes_total": 5, "redeemed_count": 3, "pass_number": 3 } }

// all_passes
{ "result": "valid",
  "ticket": { …, "passes_total": 5, "redeemed_count": 5, "redeemed_now": 5 } }
```

### `PATCH /api/organizations/me` — one added field

`qr_redemption_mode: 'per_pass' | 'all_passes'`. Rejected with `422 VALIDATION_ERROR` otherwise.

### Error responses

No new error codes. `ALREADY_CONSUMED`, `INVALID_SIGNATURE`, `EXPIRED`, `CANCELLED`, `NOT_PAID`,
`NOT_FOUND` are unchanged in both modes.

---

## Frontend

Design system: `.design/design-system/DESIGN_TOKENS.md`.

**`ScanResult`** (`src/features/scanner/components/ScanResult.tsx`) — the success copy branches:

| Mode | Copy |
|---|---|
| `per_pass` | *"Pase 3 de 5 utilizado"* (unchanged) |
| `all_passes` | *"5 pases utilizados · grupo completo"* |

Same ✓ card, same functional colour, same icon pairing — only the sentence changes.

**`SettingsPage`** (admin) — a two-option control beside the other org knobs, with the D8 help text
spelling out the trade. Reuses `SectionCard` and the existing settings form patterns; no new
primitive.

**`ScannerPage`** — unchanged, including the re-arm tap.

---

## Scenarios

### US-AG48 — one scan boards the whole party

**S-1 — A four-pass ticket clears in one scan**
Given an org set to `all_passes` and a paid line with `quantity = 4`, `redeemed_count = 0`
When the agent scans it once
Then the response is `valid` with `redeemed_count = 4`, and the stored `redeemed_count` is 4.

**S-2 — A rescan is refused**
Given the ticket from S-1
When it is scanned again
Then `ALREADY_CONSUMED` and `redeemed_count` stays 4.

**S-3 — A partially redeemed ticket completes**
Given a line with `quantity = 5`, `redeemed_count = 2` (redeemed earlier under `per_pass`)
When the org is switched to `all_passes` and the ticket is scanned
Then `redeemed_count` becomes 5 in a single scan.

**S-4 — `per_pass` is untouched**
Given an org left on the default
When a `quantity = 4` ticket is scanned four times
Then the responses carry `pass_number` 1, 2, 3, 4 and the fifth scan is `ALREADY_CONSUMED` — exactly
as `test/tickets/online-qr-scanner.test.ts` asserts today.

**S-5 — The mode comes from the scanner's org, not the ticket**
Given a ticket issued while the org was on `per_pass`
When it is scanned after the org switched to `all_passes`
Then it redeems all passes — the setting is read live, not snapshotted onto the ticket.

**S-6 — Concurrency**
Given `all_passes` and two agents scanning the same 4-pass ticket simultaneously
When both requests execute
Then exactly one returns `valid` with `redeemed_count = 4` and the other returns
`ALREADY_CONSUMED`; `redeemed_count` never exceeds `quantity`.

### US-A79 — the admin chooses the mode

**S-7 — An admin flips the mode**
Given an admin on `/settings`
When they select *Todos los pases a la vez* and save
Then `organizations.qr_redemption_mode = 'all_passes'`, and the next scan in that org uses it.

**S-8 — A non-admin cannot**
Given an agent
When they attempt the settings write
Then `403` — the existing organization-settings role gate, unchanged.

### Multitenancy isolation (required)

**S-9 — The mode does not cross organizations**
Given two organizations seeded with `seedTwoOrgs`, org A on `all_passes` and org B on `per_pass`
When org B's agent scans one of org B's 4-pass tickets
Then exactly **one** pass is redeemed — org A's setting has no effect.

**S-10 — A foreign settings write is invisible**
Given org A's admin
When they attempt to set org B's `qr_redemption_mode`
Then `404` — never `403`, which would confirm it exists.

---

## Definition of Done

- [ ] Migration `0057` adds `organizations.qr_redemption_mode`; Drizzle schema updated
- [ ] `scanTicket` branches its SET expression only; the guarded UPDATE and gate order are unchanged
- [ ] Response branches per D6; `GET /api/organizations/me` exposes the mode
- [ ] Organization settings schema accepts and validates the enum, `admin` only
- [ ] S-1 … S-8 covered in `test/tickets/group-redemption.test.ts`
- [ ] Cross-org S-9/S-10 using `seedTwoOrgs`
- [ ] `test/tickets/online-qr-scanner.test.ts` and `test/qr/folio-qr-signing.test.ts` pass **unedited**
- [ ] `ScanResult` copy branch; `SettingsPage` control with the D8 help text
- [ ] `pnpm build:app` and `pnpm lint:app` clean; `verify` green
- [ ] `SPEC.md`: US-AG48, US-A79; one Features-by-Phase line; glossary — *Group redemption*

---

## Deferred — and why each is safe to defer

| What | Why it can wait |
|---|---|
| **Per-service override** (D2) | Adding a nullable `services.qr_redemption_mode` later needs no data migration — the org value remains the fallback. Until an operator actually runs a Turibus and a lancha in one org and complains, the extra column is a knob nobody set. |
| **A confirm-the-count mode** (D5) | Strictly additive: a third enum value with its own UI step. Nothing about the binary shipped here forecloses it. |
| **Scanner re-arm ergonomics** | `all_passes` removes most of the repeated scans anyway, so the remaining tap stops being the bottleneck. Changing a working race guard deserves its own device testing at a real gate. |

---

## Known behaviour change

1. **In `all_passes`, `redeemed_count` stops being a boarded-headcount.** When 8 of 10 arrive, the
   scan records 10. Today nothing downstream depends on it beyond `ALREADY_CONSUMED` and the result
   screen, so nothing breaks — but a future boarding manifest built on this column would be wrong for
   `all_passes` orgs, and must read the mode.
2. **An org running both boarding styles must pick one** (D2). The mode is org-wide, so a Turibus
   with zoned decks (US-A64) and a single-departure lancha in the same organization cannot both be
   served correctly. Accepted; the upgrade path is a per-service override with no data migration.

---

## Open

| Question | Smallest change that answers it |
|---|---|
| **`redeemed_count` is increment-only and there is no un-redeem endpoint** — one mis-scan is permanent, and `utils/cancellationPolicy.ts` **D7** makes any line with `redeemedCount > 0` retain 100 % and refund nothing. `all_passes` does not worsen this (the ladder already fires at the first pass), but it makes a mis-scan cost the whole party's boarding rights rather than one pass. | Out of scope here — registered as **BUG-018** (`docs/BUGS.md`), which predates this feature. The smallest fix is an admin-only `POST /api/tickets/:folioLineId/unredeem` with a required audit note; it needs a product decision about **who may forgive a boarding** before it can be specified. |
| Should the result screen show *which* mode redeemed the ticket? | One line of copy. Deliberately omitted — the agent did not choose it and cannot change it, so the information has no action attached. |
