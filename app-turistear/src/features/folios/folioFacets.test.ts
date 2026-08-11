import { describe, it, expect } from 'vitest'
import {
  FACETS,
  facetLabels,
  facetPillLabel,
  matchesFacets,
  parseFacets,
  serializeFacets,
  type FacetKey,
} from './folioFacets'
import type { FolioListItem, Fulfillment } from './types'

// US-A84 — the facet model (D3/D4). Spec: docs/oversight/folio-lifecycle-unification.spec.md.
//
// This is the layer that decides what the unified list shows, so it is where the feature's core
// claim is provable in isolation: OR within a section, AND between sections, because a folio
// genuinely occupies several axes at once.

const folio = (over: Partial<FolioListItem> = {}): FolioListItem =>
  ({
    id: 'f1',
    agent: { id: 'a1', name: 'Ana' },
    customer_name: 'Leo',
    status: 'paid',
    total: 100_000,
    amount_paid: 100_000,
    created_at: 1_700_000_000,
    cancelled_at: null,
    payment_verification: 'not_required',
    refund_status: 'none',
    ...over,
  }) as FolioListItem

describe('S-7 — facets compose: OR within a section, AND between them', () => {
  const paidUnsent = folio({ id: 'a', status: 'paid', deliverable: true, tickets_sent_at: null })
  const paidSent = folio({ id: 'b', status: 'paid', deliverable: true, tickets_sent_at: 1 })
  const bookingUnsent = folio({ id: 'c', status: 'booking' })

  it('no facets means no filter', () => {
    expect([paidUnsent, paidSent, bookingUnsent].filter((f) => matchesFacets(f, []))).toHaveLength(3)
  })

  it('two facets in ONE section widen the result', () => {
    const keys: FacetKey[] = ['pagado', 'reserva']
    expect([paidUnsent, paidSent, bookingUnsent].filter((f) => matchesFacets(f, keys))).toHaveLength(3)
  })

  it('facets in TWO sections narrow it', () => {
    // The assertion the whole model exists for: `pagado` OR-ed within Pago, AND-ed against Entrega.
    const keys: FacetKey[] = ['pagado', 'sin_enviar']
    const kept = [paidUnsent, paidSent, bookingUnsent].filter((f) => matchesFacets(f, keys))
    expect(kept.map((f) => f.id)).toEqual(['a'])
  })

  it('a folio can satisfy two axes at once — which an exclusive filter could never express', () => {
    const owed = folio({ status: 'cancelled', refund_status: 'pending' })
    expect(matchesFacets(owed, ['cancelado'])).toBe(true)
    expect(matchesFacets(owed, ['reembolso'])).toBe(true)
    expect(matchesFacets(owed, ['cancelado', 'reembolso'])).toBe(true)
  })
})

describe('the Pendiente facets keep their former tabs’ predicates', () => {
  it('a cancelled folio is not "por verificar", even holding a stale pending flag', () => {
    // Rejecting a payment cancels the folio and leaves `payment_verification = 'pending'` behind.
    // US-A67's queue always excluded it; the facet that replaced that queue must too, or the pill
    // counts work that no longer exists.
    const rejected = folio({ status: 'cancelled', payment_verification: 'pending' })
    expect(matchesFacets(rejected, ['por_verificar'])).toBe(false)
    expect(matchesFacets(folio({ payment_verification: 'pending' }), ['por_verificar'])).toBe(true)
  })

  it('`solicitud` is the live one; `con_solicitud` is any', () => {
    const live = folio({ cancellation_request: 'pending' })
    const done = folio({ cancellation_request: 'resolved' })
    const never = folio({ cancellation_request: null })

    expect(matchesFacets(live, ['solicitud'])).toBe(true)
    expect(matchesFacets(done, ['solicitud'])).toBe(false)
    // `con_solicitud` is what survives of the absorbed tab's history (D2): a rejected request left
    // the folio untouched, so without it those folios are unreachable except one id at a time.
    expect(matchesFacets(done, ['con_solicitud'])).toBe(true)
    expect(matchesFacets(live, ['con_solicitud'])).toBe(true)
    expect(matchesFacets(never, ['con_solicitud'])).toBe(false)
  })

  it('`vencido` reads the server-derived flag, not a client clock', () => {
    // Derived from `booking_expires_at` server-side and never stored (apartado-stages S7). Deriving
    // it again here would give two answers to one question, drifting by the client's clock skew.
    expect(matchesFacets(folio({ status: 'booking', overdue: true }), ['vencido'])).toBe(true)
    expect(matchesFacets(folio({ status: 'booking', overdue: false }), ['vencido'])).toBe(false)
  })
})

describe('S-14 — the URL contract', () => {
  it('round-trips in canonical order, whatever order the user tapped', () => {
    const a = parseFacets('reembolso,pagado')
    const b = parseFacets('pagado,reembolso')
    // Stable output means one selection has ONE address — shareable, and diffable in history.
    expect(serializeFacets(a)).toBe(serializeFacets(b))
    expect(serializeFacets(a)).toBe('pagado,reembolso')
  })

  it('ignores unknown values instead of rejecting the whole URL', () => {
    expect(parseFacets('reembolso,pltano,')).toEqual(['reembolso'])
    expect(parseFacets(null)).toEqual([])
    expect(parseFacets('')).toEqual([])
  })

  it('de-duplicates', () => {
    expect(parseFacets('reembolso,reembolso')).toEqual(['reembolso'])
  })
})

describe('the pill states the filter without opening the sheet', () => {
  it('names the facet when there is one, counts when there are several', () => {
    expect(facetPillLabel([])).toBe('Estado')
    expect(facetPillLabel(['reembolso'])).toBe('Reembolso')
    expect(facetPillLabel(['reembolso', 'pagado'])).toBe('Estado · 2')
  })

  it('lists the names for the empty state', () => {
    // An empty list must name what it filtered by, or it reads as "there are no sales".
    expect(facetLabels(['reembolso', 'pagado'])).toEqual(['Pagado', 'Reembolso'])
  })

  // S-1 / BUG-026 — the facet strip said "Reserva" for the same status the card called "Apartado".
  it('S-1 — the booking facet is labelled Apartado', () => {
    expect(facetLabels(['reserva'])).toEqual(['Apartado'])
    expect(facetPillLabel(['reserva'])).toBe('Apartado')
    expect(FACETS.some((f) => f.label === 'Reserva')).toBe(false)
  })
})

// --- US-A85 — the wasted seat is findable -----------------------------------------------------

describe('US-A85 — the `Sin usar` facet', () => {
  const row = (fulfillment: Fulfillment): FolioListItem =>
    ({ id: 'f1', status: 'paid', fulfillment }) as FolioListItem

  it('matches a no-show and a partial, and nothing else', () => {
    expect(matchesFacets(row('no_show'), ['sin_usar'])).toBe(true)
    expect(matchesFacets(row('partial'), ['sin_usar'])).toBe(true)
    expect(matchesFacets(row('fulfilled'), ['sin_usar'])).toBe(false)
    expect(matchesFacets(row('pending'), ['sin_usar'])).toBe(false)
  })

  it('a folio from before the axis existed is not swept in', () => {
    expect(matchesFacets({ id: 'f1', status: 'paid' } as FolioListItem, ['sin_usar'])).toBe(false)
  })

  it('is named in the empty state, like every other facet', () => {
    expect(facetLabels(['sin_usar'])).toEqual(['Sin usar'])
  })

  it('ANDs across sections — a wasted seat on a cancelled folio is not a wasted seat', () => {
    // `pendiente` and `pago` are different sections, so both must hold (US-A84 D3).
    expect(matchesFacets(row('no_show'), ['sin_usar', 'pagado'])).toBe(true)
    expect(matchesFacets(row('no_show'), ['sin_usar', 'cancelado'])).toBe(false)
  })
})

// --- US-A89 (line-autonomy D15) — Pago facets are ANY-LINE ----------------------------------------

describe('D15 — a mixed folio appears under every facet one of its lines earns', () => {
  const mixed = {
    id: 'fx',
    agent: { id: 'a', name: 'Ana' },
    customer_name: 'C',
    status: 'booking',
    total: 150000,
    amount_paid: 115000,
    created_at: 1_700_000_000,
    cancelled_at: null,
    lines: [
      { service_name: 'Isla', line_type: 'slot', slot_date: '2026-08-20', slot_start_time: '09:00', check_in: null, check_out: null, guests: null, quantity: 1, money_state: 'paid' },
      { service_name: 'Chichén', line_type: 'slot', slot_date: '2026-08-22', slot_start_time: '07:30', check_in: null, check_out: null, guests: null, quantity: 1, money_state: 'booking' },
    ],
  } as unknown as FolioListItem

  it('paid AND booking at once — the truth of the data (S-12)', () => {
    expect(matchesFacets(mixed, ['pagado'])).toBe(true)
    expect(matchesFacets(mixed, ['reserva'])).toBe(true)
    expect(matchesFacets(mixed, ['cancelado'])).toBe(false)
  })

  it('a folio whose lines carry no marks answers by its roll-up status (the legacy valve)', () => {
    const legacy = {
      ...mixed,
      id: 'legacy',
      status: 'paid',
      lines: [
        { service_name: 'Tour', line_type: 'slot', slot_date: '2026-08-20', slot_start_time: '09:00', check_in: null, check_out: null, guests: null, quantity: 1 },
      ],
    } as unknown as FolioListItem
    expect(matchesFacets(legacy, ['pagado'])).toBe(true)
    expect(matchesFacets(legacy, ['reserva'])).toBe(false)
  })
})
