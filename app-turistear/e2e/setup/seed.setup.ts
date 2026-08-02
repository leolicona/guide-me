import { test as setup, expect, request as pwRequest } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { AGENT_STATE, FIXTURE_FILE, API_BASE } from '../paths'
import type { SeededFixture } from '../fixture'

// Create the suite's own apartado, so no human has to make one by hand and paste an id. This
// replaces the old e2e/create-apartado.mjs — same approach, now part of the run rather than beside
// it, which is the difference between a gate and a script.
//
// An E2E_FOLIO_ID in the environment still wins: it is the escape hatch for reproducing a specific
// folio, not the normal path.

setup('seed an apartado with a cash deposit', async () => {
  if (process.env.E2E_FOLIO_ID) {
    const fixture: SeededFixture = { folioId: process.env.E2E_FOLIO_ID, seeded: false }
    writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2))
    setup.info().annotations.push({
      type: 'fixture',
      description: `using the caller-supplied folio ${fixture.folioId} (not seeded)`,
    })
    return
  }

  const ctx = await pwRequest.newContext({ baseURL: API_BASE, storageState: AGENT_STATE })

  // Cheapest tour with availability — cheapest so a failed run leaves the smallest mess in dev.
  const catalog = await ctx.get('/api/pos/services')
  expect(catalog.ok(), `catalog fetch failed: ${catalog.status()}`).toBeTruthy()
  const services: { id: string; item_type?: string; has_availability?: boolean; base_price: number }[] =
    (await catalog.json()).services ?? []

  const candidate = services
    .filter((s) => s.has_availability && s.item_type === 'tour')
    .sort((a, b) => a.base_price - b.base_price)[0]
  expect(candidate, 'no bookable tour with availability in this environment').toBeTruthy()

  const detailRes = await ctx.get(`/api/pos/services/${candidate.id}`)
  expect(detailRes.ok(), `service detail failed: ${detailRes.status()}`).toBeTruthy()
  const detail = (await detailRes.json()).service

  // The slot must be comfortably in the FUTURE, not merely "has seats left".
  //
  // A booking's release timestamp is derived from the DEPARTURE, not from when it was sold
  // (`bookingExpiryDate` in api pos/handler.ts: departure − the org's pre-departure buffer). The
  // catalog still lists today's already-departed times, so the old `find(s => s.remaining > 0)`
  // happily picked this morning's 14:00 and produced a folio that was born expired — `status:
  // booking` with a real balance, but every settle answering 409 BOOKING_EXPIRED. Nothing in the
  // seed noticed, because an expired apartado still looks like an apartado.
  //
  // Two days of margin rather than one: the buffer is subtracted from the departure, slots come
  // back naive (`date` + `start_time`) in the ORG's time zone, and we do not know that zone here —
  // so a single day of headroom can be eaten by the buffer and the zone together.
  const MARGIN_DAYS = 2
  const earliestDate = new Date(Date.now() + MARGIN_DAYS * 86_400_000).toISOString().slice(0, 10)
  const slot = (detail.slots ?? []).find(
    (s: { remaining: number; date: string }) => s.remaining > 0 && s.date >= earliestDate,
  )
  expect(
    slot,
    `no slot on ${detail.name} with seats left departing on or after ${earliestDate} — ` +
      `dev needs future availability seeded for the E2E suite to have anything to settle`,
  ).toBeTruthy()

  const total: number = detail.base_price

  // A partial payment is what makes it an apartado rather than a paid sale. Start at 50%; if the
  // org's minimum down-payment policy rejects that, retry at 70% (the old script's fallback).
  const body = (downPayment: number) => ({
    customer_name: 'E2E Apartado Cliente',
    customer_phone: '5512349999',
    payment_method: 'cash',
    down_payment: downPayment,
    lines: [{ slot_id: slot.id, quantity: 1, unit_price: total }],
  })

  let res = await ctx.post('/api/pos/folios', { data: body(Math.round(total * 0.5)) })
  if (!res.ok()) {
    res = await ctx.post('/api/pos/folios', { data: body(Math.round(total * 0.7)) })
  }
  expect(res.ok(), `could not seed an apartado: ${res.status()} ${await res.text()}`).toBeTruthy()

  const created = await res.json()
  const folio = created.folio ?? created

  expect(folio.status, 'the seeded folio is not a live apartado').toBe('booking')
  expect(folio.total - folio.amount_paid, 'the seeded apartado has no balance to settle').toBeGreaterThan(0)

  // `status: booking` and a balance are NOT enough to prove the fixture is usable — an expired
  // apartado has both, and only says so when settle answers 409. Assert the release timestamp is
  // still ahead of us, so a bad slot choice (or an org buffer wider than MARGIN_DAYS) fails HERE,
  // naming the cause, instead of surfacing later as a journey that cannot find "Por verificar".
  const expiresAt = folio.booking_expires_at ? folio.booking_expires_at * 1000 : null
  expect(expiresAt, 'the seeded apartado has no release timestamp').toBeTruthy()
  expect(
    expiresAt! - Date.now(),
    `the seeded apartado is already expired (settle-by ${new Date(expiresAt!).toISOString()}) — ` +
      `it was seeded onto ${slot.date} ${slot.start_time}, too close to or past departure`,
  ).toBeGreaterThan(0)

  const fixture: SeededFixture = {
    folioId: folio.id,
    seeded: true,
    serviceName: detail.name,
    departsAt: `${slot.date} ${slot.start_time}`,
    total: folio.total,
    amountPaid: folio.amount_paid,
    balance: folio.total - folio.amount_paid,
  }
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2))

  await ctx.dispose()
})
