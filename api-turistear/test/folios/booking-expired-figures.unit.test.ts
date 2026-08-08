import { describe, it, expect } from 'vitest'
import { EVENTS, renderFigures } from '../../src/utils/notifications'

// US-T09 — the close states what became of the deposit.
// Spec: docs/bookings/booking-reschedule.spec.md — S-10, S-11, business rules 13/14.
//
// The whole point of this message is the third figure. "Pagué 900, ¿dónde quedaron?" is answered
// nowhere else in the product — the ladder's retention is shown on no screen.

const TZ = 'America/Cancun'
const render = (f: Parameters<typeof renderFigures>[1]) =>
  renderFigures(EVENTS.booking_expired.template, f, TZ)

describe('US-T09 — booking_expired states paid, retained and credit', () => {
  it('S-10 — a ladder that gives something back names all three, and the date', () => {
    const text = render({
      amountPaid: 90000,
      retainedAmount: 63000,
      creditAmount: 27000,
      creditExpiresAt: Date.UTC(2026, 10, 3, 12, 0, 0) / 1000,
    })
    expect(text).toContain('$900.00')
    expect(text).toContain('$630.00')
    expect(text).toContain('$270.00')
    // A credit the customer discovers already expired converts goodwill into a grievance (D10),
    // so the date travels with the figure rather than living on a screen they may never open.
    expect(text).toContain('3 de noviembre')
  })

  it('S-11 — a zero credit produces SILENCE, not a promise of nothing', () => {
    // The inherited default retains 100% (US-A76). Saying "te queda $0.00 a favor" would be worse
    // than saying nothing: it invites a customer to come and claim it.
    const text = render({ amountPaid: 90000, retainedAmount: 90000, creditAmount: 0 })
    expect(text).toContain('$900.00')
    expect(text).not.toContain('a favor')
    expect(text).not.toContain('$0.00')
  })

  it('the retention is stated even when it is everything', () => {
    // The harshest outcome is the one most worth stating plainly. It is also the DEFAULT outcome.
    expect(render({ amountPaid: 90000, retainedAmount: 90000 })).toContain('se retuvo $900.00')
  })

  it('a credit with no expiry still names the amount', () => {
    const text = render({ amountPaid: 90000, retainedAmount: 63000, creditAmount: 27000 })
    expect(text).toContain('$270.00 a favor')
    expect(text).not.toContain('hasta el')
  })

  it('no placeholder survives into a customer’s screen', () => {
    const text = render({ amountPaid: 90000, retainedAmount: 90000 })
    expect(text).not.toMatch(/\{(amount_paid|retained_amount|credit_amount|credit_clause)\}/)
  })

  it('the date resolves in the ORGANIZATION’s zone, not UTC', () => {
    // 04:00 UTC on the 4th is still the 3rd in Cancún. A credit that dies "on the 4th" for a
    // customer whose calendar says the 3rd is a support ticket.
    const instant = Date.UTC(2026, 10, 4, 4, 0, 0) / 1000
    const text = renderFigures(
      EVENTS.booking_expired.template,
      { amountPaid: 1, retainedAmount: 0, creditAmount: 1, creditExpiresAt: instant },
      TZ,
    )
    expect(text).toContain('3 de noviembre')
  })
})
