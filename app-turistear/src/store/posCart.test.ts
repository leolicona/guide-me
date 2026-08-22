import { describe, it, expect, beforeEach } from 'vitest'
import {
  usePosCart,
  lineKey,
  cartExtrasTotal,
  cartLineTotal,
  cartSubtotal,
  cartDiscountTotal,
  cartTotal,
  cartCount,
  toConfirmPayload,
  type CartService,
  type SlotCartLine,
  type StayCartLine,
} from './posCart'
import type { PosSlot, PosExtra } from '../features/pos/types'

// The cart mirrors the server's money math for live display. These tests pin the mirror: the
// server stays authoritative, but a wrong number here is a wrong number read aloud to a customer
// with cash in hand before the server ever sees it.

const service = (over: Partial<CartService> = {}): CartService => ({
  id: 'svc-1',
  name: 'Tour Isla',
  base_price: 50_000, // $500.00
  minimum_price: 40_000, // $400.00
  ...over,
})

const slot = (over: Partial<PosSlot> = {}): PosSlot => ({
  id: 'slot-1',
  date: '2026-08-01',
  start_time: '09:00',
  capacity: 20,
  booked: 0,
  remaining: 20,
  ...over,
})

const extra = (over: Partial<PosExtra> = {}): PosExtra => ({
  id: 'ex-1',
  name: 'Snorkel',
  price: 5_000,
  ...over,
})

const slotLine = (over: Partial<SlotCartLine> = {}): SlotCartLine => ({
  kind: 'slot',
  service: service(),
  slot: slot(),
  quantity: 2,
  unit_price: 50_000,
  extras: [],
  ...over,
})

const stayLine = (over: Partial<StayCartLine> = {}): StayCartLine => ({
  kind: 'stay',
  id: 'stay-1',
  service: service({ id: 'svc-lodge' }),
  unit_type_id: 'ut-1',
  unit_type_name: 'Suite',
  check_in: '2026-08-01',
  check_out: '2026-08-03',
  guests: 2,
  quantity: 1,
  nights: 2,
  total: 300_000,
  // US-AG57 — a stay line born undiscounted: the quote it came with, and a floor equal to it
  // (max_discount_pct 0), which is the state every existing unidad is in.
  quoted_total: 300_000,
  min_total: 300_000,
  per_night: [],
  ...over,
})

describe('lineKey', () => {
  it('keys a slot line by its slot', () => {
    expect(lineKey(slotLine())).toBe('slot-1')
  })

  it('keeps a split party as two lines: the zone is part of the identity (US-A64)', () => {
    const lower = slotLine({ zone: { id: 'z-lower', name: 'Abajo' } })
    const upper = slotLine({ zone: { id: 'z-upper', name: 'Arriba' } })
    expect(lineKey(lower)).toBe('slot-1:z-lower')
    expect(lineKey(upper)).toBe('slot-1:z-upper')
    expect(lineKey(lower)).not.toBe(lineKey(upper))
  })

  it('keys a stay line by its client id — a stay has no slot', () => {
    expect(lineKey(stayLine())).toBe('stay-1')
  })
})

describe('money selectors', () => {
  it('sums extras by price × quantity, and reads zero for a stay', () => {
    const line = slotLine({
      extras: [
        { extra: extra({ id: 'ex-1', price: 5_000 }), quantity: 2 },
        { extra: extra({ id: 'ex-2', price: 1_500 }), quantity: 1 },
      ],
    })
    expect(cartExtrasTotal(line)).toBe(11_500)
    expect(cartExtrasTotal(slotLine())).toBe(0)
    expect(cartExtrasTotal(stayLine())).toBe(0)
  })

  it('prices a slot line as unit × quantity + extras', () => {
    const line = slotLine({
      quantity: 3,
      unit_price: 45_000,
      extras: [{ extra: extra({ price: 5_000 }), quantity: 2 }],
    })
    expect(cartLineTotal(line)).toBe(45_000 * 3 + 10_000)
  })

  it('takes a stay line total verbatim — the server quoted it, the cart does not re-price it', () => {
    expect(cartLineTotal(stayLine({ total: 300_000, nights: 2, quantity: 1 }))).toBe(300_000)
  })

  it('subtotals an empty, single and mixed cart', () => {
    expect(cartSubtotal([])).toBe(0)
    expect(cartSubtotal([slotLine({ quantity: 2, unit_price: 50_000 })])).toBe(100_000)
    expect(cartSubtotal([slotLine({ quantity: 2, unit_price: 50_000 }), stayLine()])).toBe(400_000)
  })

  it('counts distinct lines, not people or rooms', () => {
    expect(cartCount([])).toBe(0)
    expect(cartCount([slotLine({ quantity: 8 }), stayLine({ quantity: 3 })])).toBe(2)
  })

  describe('cartDiscountTotal', () => {
    it('is the gap from base price, multiplied by quantity', () => {
      const discounted = slotLine({ quantity: 4, unit_price: 45_000 }) // $50 off × 4
      expect(cartDiscountTotal([discounted])).toBe(20_000)
    })

    it('is zero at base price', () => {
      expect(cartDiscountTotal([slotLine({ unit_price: 50_000 })])).toBe(0)
    })

    it('is zero for an undiscounted stay — its total still equals the quote', () => {
      expect(cartDiscountTotal([stayLine()])).toBe(0)
    })

    // Was asserted as an unconditional 0 until US-AG57 made stays discountable. The row this
    // feeds («Descuento» in the checkout summary) then disagreed with the discount_total the
    // server persists — the client simply did not look at stay lines.
    it('counts a discounted stay ONCE, not per room', () => {
      const discounted = stayLine({ quantity: 2, quoted_total: 400_000, total: 385_000 })
      expect(cartDiscountTotal([discounted])).toBe(15_000)
    })

    it('adds a tour and a stay discount together', () => {
      const tour = slotLine({ quantity: 4, unit_price: 45_000 }) // $50 off × 4
      const stay = stayLine({ quoted_total: 300_000, total: 280_000 })
      expect(cartDiscountTotal([tour, stay])).toBe(40_000)
    })
  })

  // cartTotal delegates to cartSubtotal: the discount is already baked into `unit_price`, so
  // subtracting cartDiscountTotal again would double-count it. This test exists to make that
  // deliberate — if cartTotal ever starts subtracting, this fails and someone has to explain why.
  it('cartTotal equals the subtotal: the discount is already inside unit_price', () => {
    const lines = [slotLine({ quantity: 4, unit_price: 45_000 }), stayLine()]
    expect(cartTotal(lines)).toBe(cartSubtotal(lines))
    expect(cartTotal(lines)).toBe(180_000 + 300_000)
  })
})

describe('usePosCart', () => {
  beforeEach(() => {
    usePosCart.getState().clear()
  })

  it('starts empty and collecting cash', () => {
    const s = usePosCart.getState()
    expect(s.lines).toEqual([])
    expect(s.paymentMethod).toBe('cash')
  })

  describe('addLine', () => {
    it('defaults the unit price to base and the quantity to one', () => {
      usePosCart.getState().addLine({ service: service(), slot: slot() })
      const [line] = usePosCart.getState().lines as SlotCartLine[]
      expect(line.unit_price).toBe(50_000)
      expect(line.quantity).toBe(1)
    })

    it('clamps a below-floor price up to the service minimum', () => {
      usePosCart.getState().addLine({ service: service(), slot: slot(), unit_price: 1_000 })
      expect((usePosCart.getState().lines[0] as SlotCartLine).unit_price).toBe(40_000)
    })

    it('clamps an above-base price down to base — an agent cannot upcharge', () => {
      usePosCart.getState().addLine({ service: service(), slot: slot(), unit_price: 99_999 })
      expect((usePosCart.getState().lines[0] as SlotCartLine).unit_price).toBe(50_000)
    })

    it('caps the quantity at the slot remaining', () => {
      usePosCart.getState().addLine({ service: service(), slot: slot({ remaining: 3 }), quantity: 10 })
      expect((usePosCart.getState().lines[0] as SlotCartLine).quantity).toBe(3)
    })

    it('merges quantities when the same slot is added twice', () => {
      const cart = usePosCart.getState()
      cart.addLine({ service: service(), slot: slot(), quantity: 2 })
      cart.addLine({ service: service(), slot: slot(), quantity: 3 })
      expect(usePosCart.getState().lines).toHaveLength(1)
      expect((usePosCart.getState().lines[0] as SlotCartLine).quantity).toBe(5)
    })

    it('keeps the same slot in two zones as two lines (US-A64)', () => {
      const cart = usePosCart.getState()
      cart.addLine({ service: service(), slot: slot(), zone: { id: 'z-1', name: 'Abajo' }, quantity: 2 })
      cart.addLine({ service: service(), slot: slot(), zone: { id: 'z-2', name: 'Arriba' }, quantity: 1 })
      expect(usePosCart.getState().lines).toHaveLength(2)
    })
  })

  describe('updateQuantity', () => {
    beforeEach(() => {
      usePosCart.getState().addLine({ service: service(), slot: slot({ remaining: 5 }), quantity: 2 })
    })

    it('clamps to at least one — a zero-quantity line is removed, never sold', () => {
      usePosCart.getState().updateQuantity('slot-1', 0)
      expect((usePosCart.getState().lines[0] as SlotCartLine).quantity).toBe(1)
    })

    it('clamps to the slot remaining', () => {
      usePosCart.getState().updateQuantity('slot-1', 99)
      expect((usePosCart.getState().lines[0] as SlotCartLine).quantity).toBe(5)
    })

    it('rounds a fractional quantity — you cannot sell half a seat', () => {
      usePosCart.getState().updateQuantity('slot-1', 2.6)
      expect((usePosCart.getState().lines[0] as SlotCartLine).quantity).toBe(3)
    })

    it('ignores a key that matches no line', () => {
      usePosCart.getState().updateQuantity('slot-nope', 4)
      expect((usePosCart.getState().lines[0] as SlotCartLine).quantity).toBe(2)
    })
  })

  describe('setUnitPrice', () => {
    beforeEach(() => {
      usePosCart.getState().addLine({ service: service(), slot: slot() })
    })

    it('holds the discount floor', () => {
      usePosCart.getState().setUnitPrice('slot-1', 0)
      expect((usePosCart.getState().lines[0] as SlotCartLine).unit_price).toBe(40_000)
    })

    it('holds the base-price ceiling', () => {
      usePosCart.getState().setUnitPrice('slot-1', 60_000)
      expect((usePosCart.getState().lines[0] as SlotCartLine).unit_price).toBe(50_000)
    })

    it('accepts a price inside the band, rounded to whole minor units', () => {
      usePosCart.getState().setUnitPrice('slot-1', 45_000.4)
      expect((usePosCart.getState().lines[0] as SlotCartLine).unit_price).toBe(45_000)
    })
  })

  // US-AG57 — the stay equivalent of setUnitPrice, bounded by the SERVER's floor rather than by a
  // percent recomputed in the client (D6).
  describe('setStayTotal', () => {
    const DISCOUNTABLE = { total: 200_000, quoted_total: 200_000, min_total: 180_000 }

    beforeEach(() => {
      usePosCart.setState({ lines: [stayLine(DISCOUNTABLE)] })
    })

    it('holds the server-resolved floor', () => {
      usePosCart.getState().setStayTotal('stay-1', 100_000)
      expect((usePosCart.getState().lines[0] as StayCartLine).total).toBe(180_000)
    })

    it('holds the quote as the ceiling — a discount may not raise the price', () => {
      usePosCart.getState().setStayTotal('stay-1', 250_000)
      expect((usePosCart.getState().lines[0] as StayCartLine).total).toBe(200_000)
    })

    it('accepts a total inside the band and leaves the quote alone', () => {
      usePosCart.getState().setStayTotal('stay-1', 185_000)
      const line = usePosCart.getState().lines[0] as StayCartLine
      expect(line.total).toBe(185_000)
      expect(line.quoted_total).toBe(200_000) // what it was worth, still readable
    })

    it('a 0 % unidad cannot move at all — min_total === quoted_total', () => {
      usePosCart.setState({ lines: [stayLine()] }) // floor === quote === 300_000
      usePosCart.getState().setStayTotal('stay-1', 1)
      expect((usePosCart.getState().lines[0] as StayCartLine).total).toBe(300_000)
    })
  })

  // The scope boundary, mechanically: an undiscounted stay puts the same bytes on the wire as it
  // did before this feature — no `unit_price` key at all.
  describe('the confirm payload carries a stay price only when discounted', () => {
    it('omits unit_price when the total still equals the quote', () => {
      usePosCart.setState({ lines: [stayLine()] })
      expect(toConfirmPayload(usePosCart.getState()).lines[0]).not.toHaveProperty('unit_price')
    })

    it('sends the whole-line total once the agent discounts it', () => {
      usePosCart.setState({
        lines: [stayLine({ total: 185_000, quoted_total: 200_000, min_total: 180_000 })],
      })
      expect(toConfirmPayload(usePosCart.getState()).lines[0]).toMatchObject({
        unit_price: 185_000,
      })
    })
  })

  describe('extras', () => {
    beforeEach(() => {
      usePosCart.getState().addLine({ service: service(), slot: slot() })
    })

    it('adds an extra at quantity one, and increments on re-add', () => {
      usePosCart.getState().addExtra('slot-1', extra())
      usePosCart.getState().addExtra('slot-1', extra())
      const line = usePosCart.getState().lines[0] as SlotCartLine
      expect(line.extras).toHaveLength(1)
      expect(line.extras[0].quantity).toBe(2)
    })

    it('drops an extra when its quantity reaches zero', () => {
      usePosCart.getState().addExtra('slot-1', extra())
      usePosCart.getState().updateExtraQuantity('slot-1', 'ex-1', 0)
      expect((usePosCart.getState().lines[0] as SlotCartLine).extras).toHaveLength(0)
    })

    it('never lets an extra go negative', () => {
      usePosCart.getState().addExtra('slot-1', extra())
      usePosCart.getState().updateExtraQuantity('slot-1', 'ex-1', -3)
      expect((usePosCart.getState().lines[0] as SlotCartLine).extras).toHaveLength(0)
    })

    it('removes an extra outright', () => {
      usePosCart.getState().addExtra('slot-1', extra())
      usePosCart.getState().removeExtra('slot-1', 'ex-1')
      expect((usePosCart.getState().lines[0] as SlotCartLine).extras).toHaveLength(0)
    })
  })

  it('removes a line by key and clears everything back to defaults', () => {
    const cart = usePosCart.getState()
    cart.addLine({ service: service(), slot: slot() })
    cart.setCustomer({ name: 'Ana', email: 'ana@example.com', phone: '9981234567' })
    cart.setPaymentMethod('transfer')

    usePosCart.getState().removeLine('slot-1')
    expect(usePosCart.getState().lines).toHaveLength(0)
    // removeLine is not a reset — the customer survives so the agent can re-add a line.
    expect(usePosCart.getState().customerName).toBe('Ana')

    usePosCart.getState().clear()
    const s = usePosCart.getState()
    expect(s.customerName).toBe('')
    expect(s.customerEmail).toBe('')
    expect(s.customerPhone).toBe('')
    expect(s.paymentMethod).toBe('cash')
  })

  it('patches only the customer fields it is given', () => {
    usePosCart.getState().setCustomer({ name: 'Ana', phone: '9981234567' })
    usePosCart.getState().setCustomer({ email: 'ana@example.com' })
    const s = usePosCart.getState()
    expect(s.customerName).toBe('Ana')
    expect(s.customerPhone).toBe('9981234567')
    expect(s.customerEmail).toBe('ana@example.com')
  })
})

// toConfirmPayload is the seam: the last thing the frontend decides before the API decides
// everything else. Assert the SHAPE, not just the totals.
describe('toConfirmPayload', () => {
  beforeEach(() => {
    usePosCart.getState().clear()
  })

  it('builds the slot-line body, omitting zone_id on an unzoned service', () => {
    const cart = usePosCart.getState()
    cart.addLine({ service: service(), slot: slot(), quantity: 2, unit_price: 45_000 })
    usePosCart.getState().addExtra('slot-1', extra())
    cart.setCustomer({ name: 'Ana', email: 'ana@example.com', phone: '9981234567' })

    const payload = toConfirmPayload(usePosCart.getState())
    expect(payload).toEqual({
      customer_name: 'Ana',
      customer_email: 'ana@example.com',
      customer_phone: '9981234567',
      payment_method: 'cash',
      lines: [
        {
          slot_id: 'slot-1',
          quantity: 2,
          unit_price: 45_000,
          extras: [{ extra_id: 'ex-1', quantity: 1 }],
        },
      ],
    })
    expect(payload.lines[0]).not.toHaveProperty('zone_id')
  })

  it('includes zone_id on a zoned line', () => {
    usePosCart
      .getState()
      .addLine({ service: service(), slot: slot(), zone: { id: 'z-1', name: 'Abajo' } })
    expect(toConfirmPayload(usePosCart.getState()).lines[0]).toMatchObject({ zone_id: 'z-1' })
  })

  it('sends a stay line as a date range, never as a slot', () => {
    usePosCart.getState().addStayLine({
      service: service({ id: 'svc-lodge' }),
      unit_type_id: 'ut-1',
      unit_type_name: 'Suite',
      check_in: '2026-08-01',
      check_out: '2026-08-03',
      guests: 2,
      quantity: 1,
      nights: 2,
      total: 300_000,
      min_total: 300_000,
      per_night: [],
    })
    const [line] = toConfirmPayload(usePosCart.getState()).lines
    expect(line).toEqual({
      unit_type_id: 'ut-1',
      check_in: '2026-08-01',
      check_out: '2026-08-03',
      guests: 2,
      quantity: 1,
    })
    expect(line).not.toHaveProperty('slot_id')
    // The cart never quotes lodging money to the server — it re-quotes and snapshots (US-AG38 D12).
    expect(line).not.toHaveProperty('total')
  })

  it('sends null, not empty string, for a customer the agent left blank', () => {
    usePosCart.getState().addLine({ service: service(), slot: slot() })
    usePosCart.getState().setCustomer({ name: '   ', email: '', phone: '  ' })
    const payload = toConfirmPayload(usePosCart.getState())
    expect(payload.customer_name).toBeNull()
    expect(payload.customer_email).toBeNull()
    expect(payload.customer_phone).toBeNull()
  })

  it('carries the collection channel (US-AG25)', () => {
    usePosCart.getState().addLine({ service: service(), slot: slot() })
    usePosCart.getState().setPaymentMethod('transfer')
    expect(toConfirmPayload(usePosCart.getState()).payment_method).toBe('transfer')
  })
})
