import { describe, it, expect } from 'vitest'
import {
  folioAction,
  folioTimeChip,
  folioCustomerLabel,
  folioDeliveryMark,
  folioMoneyAxis,
  folioSoldAtLabel,
  folioSoldSummary,
} from './folioCardState'

// US-A82 / US-AG49 — the card's derivations.
// Spec: docs/oversight/folio-list-scanability.spec.md (Scenarios S-2…S-6).
//
// These are Tier 1 in docs/TESTING.md: pure functions, no DOM, no server. They belong here and not
// in the API suite because none of them is a business rule — the API enforces nothing about which
// colour a rail takes. What they decide is whether the row a seller scans in the sun says the same
// thing the record does, which is exactly the assertion no API test can make.
//
// Every case below is a state the redesign exists to disambiguate. Before it, rows 1 and 3 of the
// delivery table rendered two pills of the same green.

const paidFolio = {
  status: 'paid' as const,
  total: 240000,
  amount_paid: 240000,
  customer_name: 'María González',
  customer_phone: '5215512345678',
  deliverable: true,
}

describe('S-2 — identity degrades, never blanks', () => {
  it('uses the name when there is one', () => {
    expect(folioCustomerLabel({ customer_name: 'María González', customer_phone: '5215512345678' }))
      .toBe('María González')
  })

  it('falls back to the phone tail on an Express sale', () => {
    // express-sale.spec.md D17 leaves the name null BY DESIGN, and line 490 of that spec
    // prescribed exactly this fallback. Five surfaces printed "Sin nombre" instead.
    expect(folioCustomerLabel({ customer_name: null, customer_phone: '5215512345678' }))
      .toBe('Cliente ••5678')
  })

  it('treats a blank name as no name', () => {
    expect(folioCustomerLabel({ customer_name: '   ', customer_phone: '5215512345678' }))
      .toBe('Cliente ••5678')
  })

  it('falls back to the bare noun when there is nothing to identify by', () => {
    expect(folioCustomerLabel({ customer_name: null, customer_phone: null })).toBe('Cliente')
  })

  it('never renders the string "Sin nombre"', () => {
    for (const folio of [
      { customer_name: null, customer_phone: '5215512345678' },
      { customer_name: null, customer_phone: null },
      { customer_name: '', customer_phone: '' },
    ]) {
      expect(folioCustomerLabel(folio)).not.toBe('Sin nombre')
    }
  })
})

describe('S-3 — the money axis, and the rail it drives', () => {
  it('a cleared paid folio is green and reads as paid', () => {
    expect(folioMoneyAxis(paidFolio)).toEqual({
      rail: 'success',
      reading: { kind: 'paid', cents: 240000 },
    })
  })

  it('cash needs no verification and stays green', () => {
    expect(folioMoneyAxis({ ...paidFolio, payment_verification: 'not_required' }).rail)
      .toBe('success')
    expect(folioMoneyAxis({ ...paidFolio, payment_verification: 'verified' }).rail).toBe('success')
  })

  it('an UNVERIFIED transfer is amber and reads "por verificar", not green', () => {
    // The defect this replaces: status is set to 'paid' at sale and verification is tracked
    // separately (pos/handler.ts), so the card printed 🟢 Pagado for money the organization does
    // not hold — and with delivery blocked it showed no second chip either, making it
    // indistinguishable from a sale already collected AND delivered.
    const axis = folioMoneyAxis({ ...paidFolio, payment_verification: 'pending' })
    expect(axis.rail).toBe('warning')
    expect(axis.reading).toEqual({ kind: 'unverified', cents: 240000 })
  })

  it('an apartado is amber and leads with what is still owed', () => {
    const axis = folioMoneyAxis({
      status: 'booking',
      total: 240000,
      amount_paid: 80000,
      pending_balance: 160000,
    })
    expect(axis.rail).toBe('warning')
    expect(axis.reading).toEqual({ kind: 'owing', paid: 160000, total: 240000 })
  })

  it('derives the balance when the server did not send one', () => {
    expect(folioMoneyAxis({ status: 'booking', total: 240000, amount_paid: 80000 }).reading)
      .toEqual({ kind: 'owing', paid: 160000, total: 240000 })
  })
})

describe('S-5 — a cancelled folio reads as a debt, or as settled', () => {
  it('money still owed reads as the refund, in red', () => {
    const axis = folioMoneyAxis({
      status: 'cancelled',
      total: 240000,
      amount_paid: 240000,
      refund_status: 'pending',
      refund_amount: 240000,
    })
    expect(axis.rail).toBe('error')
    // The figure that reads first is the DEBT, not what was once collected: an unconfirmed refund
    // is money the company still owes a person (US-A78).
    expect(axis.reading).toEqual({ kind: 'refundOwed', cents: 240000 })
  })

  it('a settled cancellation reads as history, not as a demand', () => {
    expect(
      folioMoneyAxis({
        status: 'cancelled',
        total: 240000,
        amount_paid: 240000,
        refund_status: 'refunded',
        refund_amount: 240000,
      }).reading,
    ).toEqual({ kind: 'refundSettled', cents: 240000 })
  })
})

describe('S-4 — the message axis: two marks, never three', () => {
  it('nothing sent yet carries no mark', () => {
    expect(folioDeliveryMark({ ...paidFolio, tickets_sent_at: null, tickets_viewed_at: null }))
      .toBe('none')
  })

  it('sent carries the single check', () => {
    expect(folioDeliveryMark({ ...paidFolio, tickets_sent_at: 1000, tickets_viewed_at: null }))
      .toBe('sent')
  })

  it('viewed carries the double check and outranks sent', () => {
    expect(folioDeliveryMark({ ...paidFolio, tickets_sent_at: 1000, tickets_viewed_at: 2000 }))
      .toBe('viewed')
  })

  it('a folio off the delivery axis carries no mark at all', () => {
    // An apartado has no tickets until it settles, so it is not "undelivered" — it is not on the
    // axis at all. Rendering a mark here would invent a state. Off-axis is exactly "no portal link
    // and not deliverable", which is why the mark reads those two and never `status`.
    expect(folioDeliveryMark({ deliverable: false, portal_link: null })).toBe('none')
  })
})

describe('S-6 — exactly one action, and the two verbs never coexist', () => {
  const cases: Array<[string, Parameters<typeof folioAction>[0], boolean, string]> = [
    [
      'paid, tickets never sent → send the tickets',
      { ...paidFolio, tickets_sent_at: null, tickets_viewed_at: null },
      false,
      'tickets',
    ],
    [
      'paid, already sent → nothing is owed, so the neutral verb',
      { ...paidFolio, tickets_sent_at: 1000, tickets_viewed_at: null },
      false,
      'message',
    ],
    [
      'paid, viewed → the neutral verb',
      { ...paidFolio, tickets_sent_at: 1000, tickets_viewed_at: 2000 },
      false,
      'message',
    ],
    [
      'paid but unverified → not deliverable, so no ticket send is offered',
      { status: 'paid', deliverable: false, tickets_sent_at: null, tickets_viewed_at: null },
      false,
      'message',
    ],
    [
      'apartado with slack → the neutral verb (the reminder is not owed yet)',
      { status: 'booking', deliverable: false, booking_expires_at: 999 },
      false,
      'message',
    ],
    [
      'apartado close to expiry → remind about the balance',
      { status: 'booking', deliverable: false, booking_expires_at: 999 },
      true,
      'reminder',
    ],
    [
      'cancelled → the neutral verb; refunds are confirmed in their own tab (D12)',
      { status: 'cancelled', deliverable: false },
      false,
      'message',
    ],
  ]

  for (const [name, folio, urgent, expected] of cases) {
    it(name, () => {
      expect(folioAction(folio, { urgent })).toBe(expected)
    })
  }

  it('never offers the generic verb on a folio that still owes a ticket send', () => {
    // The load-bearing property of D7. Were both offered, a seller would paste the portal link
    // through the generic button, tickets_sent_at would never be written, and the folio would sit
    // in the undelivered queue permanently — a queue growing from correct behaviour.
    const undelivered = { ...paidFolio, tickets_sent_at: null, tickets_viewed_at: null }
    expect(folioAction(undelivered, { urgent: false })).not.toBe('message')
  })
})

describe('S-11 — the sale time compresses, in the org’s zone', () => {
  const TZ = 'America/Cancun' // UTC−5 year round, no DST
  // 2026-08-01 18:00Z = 13:00 in Cancún.
  const NOW = Math.floor(Date.parse('2026-08-01T18:00:00Z') / 1000)

  it('today reads "hoy" plus the org-local time', () => {
    const at = Math.floor(Date.parse('2026-08-01T19:32:00Z') / 1000) // 14:32 in Cancún
    expect(folioSoldAtLabel(at, NOW, TZ)).toBe('hoy 14:32')
  })

  it('yesterday reads "ayer"', () => {
    const at = Math.floor(Date.parse('2026-07-31T19:32:00Z') / 1000)
    expect(folioSoldAtLabel(at, NOW, TZ)).toBe('ayer 14:32')
  })

  it('older collapses to a date, with no time', () => {
    const at = Math.floor(Date.parse('2026-07-28T19:32:00Z') / 1000)
    expect(folioSoldAtLabel(at, NOW, TZ)).toMatch(/^28 jul/)
    expect(folioSoldAtLabel(at, NOW, TZ)).not.toContain(':')
  })

  it('another year keeps the year', () => {
    const at = Math.floor(Date.parse('2025-07-28T19:32:00Z') / 1000)
    expect(folioSoldAtLabel(at, NOW, TZ)).toContain('2025')
  })

  it('uses the ORG zone, not the viewer’s — a late sale is still today at the counter', () => {
    // 03:30Z on Aug 2 is 22:30 on Aug 1 in Cancún. A UTC viewer would call this "tomorrow";
    // the counter that rang it up is still on the same shift (US-A66).
    const at = Math.floor(Date.parse('2026-08-02T03:30:00Z') / 1000)
    expect(folioSoldAtLabel(at, NOW, TZ)).toBe('hoy 22:30')
    expect(folioSoldAtLabel(at, NOW, 'UTC')).not.toContain('hoy')
  })

  it('crosses a month boundary without arithmetic drift', () => {
    const firstOfMonth = Math.floor(Date.parse('2026-08-01T18:00:00Z') / 1000)
    const lastOfPrev = Math.floor(Date.parse('2026-07-31T20:00:00Z') / 1000)
    expect(folioSoldAtLabel(lastOfPrev, firstOfMonth, TZ)).toBe('ayer 15:00')
  })

  it('falls back to the absolute date while the clock is still unknown', () => {
    // useNowSeconds resolves in an effect, so the first render has no "now". Guessing "hoy" there
    // would print a claim that is wrong for every row older than today.
    const at = Math.floor(Date.parse('2026-08-01T19:32:00Z') / 1000)
    expect(folioSoldAtLabel(at, null, TZ)).not.toContain('hoy')
    expect(folioSoldAtLabel(at, null, TZ)).toContain('2026')
  })
})

describe('S-1 — the title says what was sold', () => {
  it('names the first line and counts the rest', () => {
    const sold = folioSoldSummary([
      {
        service_name: 'Tour Isla Mujeres',
        line_type: 'slot',
        slot_date: '2026-08-08',
        slot_start_time: '09:00',
        check_in: null,
        check_out: null,
        guests: null,
        quantity: 2,
      },
      {
        service_name: 'Snorkel',
        line_type: 'slot',
        slot_date: '2026-08-09',
        slot_start_time: '14:00',
        check_in: null,
        check_out: null,
        guests: null,
        quantity: 1,
      },
    ])
    expect(sold.name).toBe('Tour Isla Mujeres')
    expect(sold.when).toBe('Sáb 8, 09:00') // 2026-08-08 is a Saturday
    expect(sold.more).toBe(1)
  })

  it('reads a lodging stay as its date range', () => {
    const sold = folioSoldSummary([
      {
        service_name: 'Casa Azul',
        line_type: 'stay',
        slot_date: null,
        slot_start_time: null,
        check_in: '2026-08-07',
        check_out: '2026-08-09',
        guests: 2,
        quantity: 1,
      },
    ])
    expect(sold.name).toBe('Casa Azul')
    expect(sold.when).toBe('Vie 7 → Dom 9')
    expect(sold.more).toBe(0)
  })

  it('degrades on a folio with no lines instead of throwing', () => {
    // Pre-feature rows and any folio whose lines failed to load. The card shows a placeholder
    // title rather than crashing the whole list.
    expect(folioSoldSummary(undefined)).toEqual({ name: null, when: '', more: 0 })
    expect(folioSoldSummary([])).toEqual({ name: null, when: '', more: 0 })
  })
})

// --- US-A84 -------------------------------------------------------------------------------------

describe('S-8/S-9 — the button ladder, blocking-first', () => {
  const base = {
    status: 'paid' as const,
    deliverable: true,
    portal_link: 'https://x/portal/t',
    tickets_sent_at: null,
    tickets_viewed_at: null,
  }

  // Each row adds ONE higher-priority job to a folio that already has a lower one, so a ladder
  // built in the wrong order fails on the row that introduces the inversion — not on all of them.
  const cases: Array<[string, Parameters<typeof folioAction>[0], string]> = [
    ['nothing pending → the resting verb', { ...base, tickets_sent_at: 1, tickets_viewed_at: 1 }, 'message'],
    ['undelivered → tickets', base, 'tickets'],
    [
      'S-9 — unverified payment outranks delivery',
      { ...base, deliverable: false, payment_verification: 'pending' },
      'verify',
    ],
    [
      'a refund owed outranks nothing else on a cancelled folio',
      { status: 'cancelled', refund_status: 'pending' },
      'refund',
    ],
    [
      'a live request outranks an unverified payment',
      { ...base, payment_verification: 'pending', cancellation_request: 'pending' },
      'request',
    ],
    [
      'S-8 — a live request outranks an overdue hold',
      { status: 'booking', booking_expires_at: 1, cancellation_request: 'pending' },
      'request',
    ],
  ]

  it.each(cases)('%s', (_label, folio, expected) => {
    expect(folioAction(folio, { urgent: true })).toBe(expected)
  })

  // D15 — the line between the two audiences is CAPABILITY, not information. The seller sees the
  // state on their card (the rail, the chip); they are never offered a verb they cannot press.
  it('S-16 — a seller is never offered an admin verb', () => {
    // An unverified transfer has NO portal link: `issuePortalLink` is gated on the money clearing
    // (`pos/handler.ts:1833`), so the folio is off the delivery axis entirely. Seeding one WITH a
    // link would test a state the system cannot produce.
    const stuck = {
      status: 'paid' as const,
      deliverable: false,
      portal_link: null,
      payment_verification: 'pending' as const,
    }
    expect(folioAction(stuck, { urgent: false, surface: 'admin' })).toBe('verify')
    expect(folioAction(stuck, { urgent: false, surface: 'seller' })).toBe('message')

    const owed = { status: 'cancelled' as const, refund_status: 'pending' as const }
    expect(folioAction(owed, { urgent: false, surface: 'seller' })).toBe('message')

    const asked = { ...base, cancellation_request: 'pending' as const }
    // The seller still SEES the state (rail, chip) — they are simply not handed the decision.
    expect(folioAction(asked, { urgent: false, surface: 'seller' })).not.toBe('request')
  })

  // A rejected payment leaves its stale 'pending' flag on a cancelled folio (US-A67). Offering
  // `Verificar y enviar` there would verify a sale that no longer exists.
  it('a cancelled folio is never offered verification', () => {
    const rejected = { status: 'cancelled' as const, payment_verification: 'pending' as const }
    expect(folioAction(rejected, { urgent: false })).toBe('message')
  })
})

describe('S-10 — the time chip states which clock is running', () => {
  const now = 1_000_000

  it('a passed deadline says how long ago, in error tone', () => {
    const chip = folioTimeChip(
      { status: 'booking', booking_expires_at: now - 50 * 3600 },
      now,
    )
    // It used to read the static word `Vencido`, in amber. A passed deadline is not a warning about
    // the future; it is a fact about the past.
    expect(chip).toEqual({ label: 'Venció hace 2 d', tone: 'error' })
  })

  it('a live hold counts down, amber only inside 24 h', () => {
    expect(folioTimeChip({ status: 'booking', booking_expires_at: now + 3 * 3600 }, now)).toEqual({
      label: 'Vence en 3 h',
      tone: 'warning',
    })
    expect(folioTimeChip({ status: 'booking', booking_expires_at: now + 96 * 3600 }, now)).toEqual({
      label: 'Vence en 4 d',
      tone: 'default',
    })
  })

  it('an owed refund shows the age of the DEBT, not of the hold', () => {
    // D10 — this is where Q5's signal went when the queues lost their own sort order. If this
    // stopped rendering, the refund queue's whole reason to exist would become invisible again.
    expect(
      folioTimeChip(
        { status: 'cancelled', refund_status: 'pending', cancelled_at: now - 8 * 86400 },
        now,
      ),
    ).toEqual({ label: 'Debe hace 8 d', tone: 'error' })
  })

  it('D19 — an unresolved clock states the fact without inventing an age', () => {
    // `useNowSeconds` returns null on first render. Printing "hace 0 min" there would be a wrong
    // screen, not a cosmetic one (Q8).
    expect(folioTimeChip({ status: 'booking', booking_expires_at: now }, null)).toEqual({
      label: 'Apartado',
      tone: 'default',
    })
    expect(
      folioTimeChip({ status: 'cancelled', refund_status: 'pending', cancelled_at: now }, null),
    ).toEqual({ label: 'Reembolso pendiente', tone: 'error' })
  })

  it('a settled sale has no time chip at all', () => {
    expect(folioTimeChip({ status: 'paid' }, now)).toBeNull()
  })
})
