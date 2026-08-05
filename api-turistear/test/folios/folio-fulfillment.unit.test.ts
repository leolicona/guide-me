import { describe, it, expect } from 'vitest'
import {
  lineFulfillment,
  folioFulfillment,
  fulfillmentResolution,
  type FulfillmentLine,
} from '../../src/utils/folioFulfillment'

// US-A85 — the fulfilment axis, as pure arithmetic.
// Spec: docs/folios/folio-state-machine.spec.md — S-4 … S-8, plus D7's ordering.
//
// No database and no clock: `nowEpoch` and the margin are arguments, which is what lets every
// boundary be asserted exactly rather than approximately.

const CANCUN = 'America/Cancun' // UTC−5, no DST — arithmetic stays legible
const HOUR = 3600

/** 2026-08-20 09:00 in Cancún = 14:00 UTC. */
const DEPARTS = Date.UTC(2026, 7, 20, 14, 0, 0) / 1000

const aLine = (over: Partial<FulfillmentLine> = {}): FulfillmentLine => ({
  lineId: 'l1',
  lineType: 'slot',
  slotDate: '2026-08-20',
  slotStartTime: '09:00',
  checkIn: null,
  lineTotal: 240000,
  quantity: 4,
  redeemedCount: 0,
  ...over,
})

describe('US-A85 — a line reads its own fulfilment', () => {
  it('S-4 — nobody boarded and the departure has passed', () => {
    expect(lineFulfillment(aLine(), CANCUN, 0, DEPARTS + 3 * HOUR)).toBe('no_show')
  })

  it('S-4 — the same line before its departure is merely pending', () => {
    expect(lineFulfillment(aLine(), CANCUN, 0, DEPARTS - HOUR)).toBe('pending')
  })

  it('S-4c — margin 0 means the departure instant, to the second', () => {
    expect(lineFulfillment(aLine(), CANCUN, 0, DEPARTS)).toBe('pending')
    expect(lineFulfillment(aLine(), CANCUN, 0, DEPARTS + 1)).toBe('no_show')
  })

  it('S-4c — a NEGATIVE margin is an hour of courtesy after departure', () => {
    // −60 = "sixty minutes AFTER departure", the Después direction of the /settings control.
    expect(lineFulfillment(aLine(), CANCUN, -60, DEPARTS + 59 * 60)).toBe('pending')
    expect(lineFulfillment(aLine(), CANCUN, -60, DEPARTS + 61 * 60)).toBe('no_show')
  })

  it('a POSITIVE margin declares the seat lost before the boat leaves', () => {
    // Unusual but coherent, and the signed control allows it: the org's call, not ours.
    expect(lineFulfillment(aLine(), CANCUN, 30, DEPARTS - 29 * 60)).toBe('no_show')
  })

  it('S-5 — two of four boarded, before and after departure alike', () => {
    const half = aLine({ redeemedCount: 2 })
    expect(lineFulfillment(half, CANCUN, 0, DEPARTS - HOUR)).toBe('partial')
    expect(lineFulfillment(half, CANCUN, 0, DEPARTS + 3 * HOUR)).toBe('partial')
  })

  it('S-6 — the late arrival is scanned and stops being a no-show', () => {
    const line = aLine()
    const late = DEPARTS + 3 * HOUR
    expect(lineFulfillment(line, CANCUN, 0, late)).toBe('no_show')
    // The ONLY thing that changed is the count the scanner writes. No reversal, no second column.
    expect(lineFulfillment({ ...line, redeemedCount: 4 }, CANCUN, 0, late)).toBe('fulfilled')
  })

  it('S-8 — a line with no readable departure is never accused', () => {
    expect(lineFulfillment(aLine({ slotDate: null }), CANCUN, 0, DEPARTS + 3 * HOUR)).toBe('pending')
  })

  it('S-9 — the departure resolves in the ORG zone, not UTC', () => {
    // ONE instant, two organizations, opposite readings. The line's '2026-08-20 09:00' is naive
    // wall-clock, so the only thing that decides whether it has departed is whose clock is asked.
    const instant = Date.UTC(2026, 7, 20, 12, 0, 0) / 1000
    // 12:00 UTC is 07:00 in Cancún — two hours before a 09:00 departure.
    expect(lineFulfillment(aLine(), CANCUN, 0, instant)).toBe('pending')
    // The same instant is 21:00 in Tokyo — twelve hours after it.
    expect(lineFulfillment(aLine(), 'Asia/Tokyo', 0, instant)).toBe('no_show')
    // Reading '09:00' as UTC would answer `no_show` for both, which is the bug this guards.
  })

  it('a stay line departs at check-in, 00:00 org-local', () => {
    const stay = aLine({ lineType: 'stay', slotDate: null, slotStartTime: null, checkIn: '2026-08-20' })
    const midnight = Date.UTC(2026, 7, 20, 5, 0, 0) / 1000 // 00:00 Cancún
    expect(lineFulfillment(stay, CANCUN, 0, midnight - 1)).toBe('pending')
    expect(lineFulfillment(stay, CANCUN, 0, midnight + 1)).toBe('no_show')
  })

  it('redeemed beyond quantity still reads fulfilled, never overflows into something else', () => {
    expect(lineFulfillment(aLine({ redeemedCount: 9 }), CANCUN, 0, DEPARTS - HOUR)).toBe('fulfilled')
  })
})

describe('D7 — the folio rolls up to the worst of its lines', () => {
  it('S-7 — `fulfilled` never masks a tour that has not departed', () => {
    expect(folioFulfillment(['fulfilled', 'pending'])).toBe('pending')
  })

  it('S-7 — a no-show line makes the whole folio read no_show', () => {
    expect(folioFulfillment(['fulfilled', 'no_show'])).toBe('no_show')
    expect(folioFulfillment(['pending', 'no_show'])).toBe('no_show')
    expect(folioFulfillment(['partial', 'no_show'])).toBe('no_show')
  })

  it('partial outranks pending, and pending outranks fulfilled', () => {
    expect(folioFulfillment(['partial', 'pending'])).toBe('partial')
    expect(folioFulfillment(['pending', 'fulfilled'])).toBe('pending')
  })

  it('only an all-fulfilled folio reads fulfilled', () => {
    expect(folioFulfillment(['fulfilled', 'fulfilled'])).toBe('fulfilled')
  })

  it('the roll-up does not depend on the order the lines arrive in', () => {
    expect(folioFulfillment(['no_show', 'fulfilled'])).toBe(
      folioFulfillment(['fulfilled', 'no_show']),
    )
    expect(folioFulfillment(['pending', 'partial'])).toBe(folioFulfillment(['partial', 'pending']))
  })
})

describe('D24 — what the count can distinguish depends on the gate', () => {
  it('per_pass counts seats; all_passes can only count parties', () => {
    expect(fulfillmentResolution('per_pass')).toBe('per_seat')
    expect(fulfillmentResolution('all_passes')).toBe('per_party')
  })
})
