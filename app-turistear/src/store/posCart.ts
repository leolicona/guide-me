import { create } from 'zustand'
import type { PosExtra, PosSlot, StayNight } from '../features/pos/types'
import type { ConfirmSaleInput, PaymentMethod } from '../services/posService'

// The cart is client-only state — the server only sees the final cart on confirm
// (POST /api/pos/folios) and remains the single source of truth for all totals.
// These selectors mirror the server math purely for live display.

/** The service fields a cart line needs to price + enforce the discount floor. */
export interface CartService {
  id: string
  name: string
  base_price: number
  minimum_price: number
}

export interface CartExtra {
  extra: PosExtra
  quantity: number
}

/** A tour/activity line — a slot + quantity + discountable unit price. */
export interface SlotCartLine {
  kind: 'slot'
  service: CartService
  slot: PosSlot
  /** US-A64 — the physical zone this line sells into (undefined on an unzoned service). A split
   * party is one line per zone on the same slot, so the line's identity is slot + zone. */
  zone?: { id: string; name: string }
  /** Number of people; >= 1, soft-capped at the zone's (or slot's) remaining. */
  quantity: number
  /** Discounted unit price (minor units), clamped to [minimum_price, base_price]. */
  unit_price: number
  extras: CartExtra[]
}

/** US-AG38 (v2) — a lodging stay line: `quantity` rooms of a unit type + date range + total
 * guests (D12). No per-night discounting; the server re-quotes + snapshots the total on confirm
 * (cart `total` mirrors it for display). */
export interface StayCartLine {
  kind: 'stay'
  /** Stable client key (a stay has no slot id). */
  id: string
  service: CartService
  unit_type_id: string
  unit_type_name: string
  check_in: string
  check_out: string
  guests: number
  /** Rooms reserved (≥ 1). */
  quantity: number
  nights: number
  /** Stay total in minor units (server is authoritative). */
  total: number
  /**
   * US-AG57 — the quote this line was born with, kept so the cart can show what was given away
   * (`quoted_total − total`) after the agent edits the total. Never changes: a stay line cannot be
   * edited in place (D5), so a re-quote is a different line with a different `id`.
   */
  quoted_total: number
  /** The lowest total the confirm will accept, from the server (D6). `=== quoted_total` ⇒ no
   * discount is allowed, and the line renders as text (D7). */
  min_total: number
  /** Per-night rate breakdown, summed across rooms (display only). */
  per_night: StayNight[]
}

export type CartLine = SlotCartLine | StayCartLine

/** A line's stable key — slot id (+ zone id on a zoned service) for a tour line, the client id for
 * a stay line. The zone is part of the identity so a split party keeps two distinct lines. */
export const lineKey = (line: CartLine): string =>
  line.kind === 'slot' ? `${line.slot.id}${line.zone ? `:${line.zone.id}` : ''}` : line.id

/** Input for adding a stay line (US-AG38, v2). */
export interface AddStayInput {
  service: CartService
  unit_type_id: string
  unit_type_name: string
  check_in: string
  check_out: string
  guests: number
  /** Rooms reserved (≥ 1). */
  quantity: number
  nights: number
  total: number
  /** The floor the server resolved for this quote (US-AG57 D6). `=== total` ⇒ no discount. */
  min_total: number
  per_night: StayNight[]
}

interface PosCartState {
  lines: CartLine[]
  customerName: string
  customerEmail: string
  customerPhone: string
  /** How the agent collected payment (US-AG25). Defaults to 'cash'. */
  paymentMethod: PaymentMethod

  /** Add a service/slot. If the same slot (and zone, US-A64) is already in the cart, quantities
   * merge; a different zone on the same slot is a distinct line. */
  addLine: (input: {
    service: CartService
    slot: PosSlot
    zone?: { id: string; name: string }
    quantity?: number
    unit_price?: number
    extras?: CartExtra[]
  }) => void
  /** US-AG38 — add a lodging stay line. */
  addStayLine: (input: AddStayInput) => void
  // All slot-line mutations key on `lineKey(line)` (slot id, + zone id on a zoned service).
  updateQuantity: (key: string, quantity: number) => void
  setUnitPrice: (key: string, unitPrice: number) => void
  /** US-AG57 — the agent's discounted total for a stay line, clamped to [min_total, quoted_total]. */
  setStayTotal: (id: string, total: number) => void
  addExtra: (key: string, extra: PosExtra) => void
  updateExtraQuantity: (key: string, extraId: string, quantity: number) => void
  removeExtra: (key: string, extraId: string) => void
  removeLine: (key: string) => void
  setCustomer: (fields: Partial<{ name: string; email: string; phone: string }>) => void
  setPaymentMethod: (method: PaymentMethod) => void
  clear: () => void
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

export const usePosCart = create<PosCartState>((set) => ({
  lines: [],
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  paymentMethod: 'cash',

  addLine: ({ service, slot, zone, quantity = 1, unit_price, extras = [] }) =>
    set((state) => {
      const price = clamp(
        unit_price ?? service.base_price,
        service.minimum_price,
        service.base_price,
      )
      // Identity is slot + zone (US-A64): the same slot in a different zone is a distinct line.
      const sameLine = (l: CartLine): l is SlotCartLine =>
        l.kind === 'slot' && l.slot.id === slot.id && l.zone?.id === zone?.id
      const existing = state.lines.find(sameLine)
      if (existing) {
        // Merge quantities (distinct slot+zone rule), soft-capped at remaining.
        const merged = Math.min(existing.quantity + quantity, slot.remaining || quantity)
        return {
          lines: state.lines.map((l) =>
            sameLine(l) ? { ...l, quantity: Math.max(merged, 1) } : l,
          ),
        }
      }
      const capped = slot.remaining ? Math.min(quantity, slot.remaining) : quantity
      return {
        lines: [
          ...state.lines,
          { kind: 'slot', service, slot, zone, quantity: Math.max(capped, 1), unit_price: price, extras },
        ],
      }
    }),

  addStayLine: (input) =>
    set((state) => ({
      lines: [
        // `quoted_total` is seeded from the quote and never moves; `total` is what the agent may
        // then take down to `min_total`.
        ...state.lines,
        { kind: 'stay', id: crypto.randomUUID(), ...input, quoted_total: input.total },
      ],
    })),

  updateQuantity: (key, quantity) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.kind === 'slot' && lineKey(l) === key
          ? {
              ...l,
              quantity: clamp(
                Math.round(quantity),
                1,
                l.slot.remaining || Math.round(quantity),
              ),
            }
          : l,
      ),
    })),

  setUnitPrice: (key, unitPrice) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.kind === 'slot' && lineKey(l) === key
          ? {
              ...l,
              unit_price: clamp(
                Math.round(unitPrice),
                l.service.minimum_price,
                l.service.base_price,
              ),
            }
          : l,
      ),
    })),

  // US-AG57 — the stay equivalent, bounded by the server's own floor rather than by a percent
  // recomputed here. Nothing invalidates it: `updateQuantity` skips stay lines and there is no
  // `updateStay`, so changing dates, guests or rooms means removing the line and re-adding it
  // from LodgingStaySheet — a new `id`, a fresh quote, no stale override to carry (D5).
  setStayTotal: (id, total) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.kind === 'stay' && l.id === id
          ? { ...l, total: clamp(Math.round(total), l.min_total, l.quoted_total) }
          : l,
      ),
    })),

  addExtra: (key, extra) =>
    set((state) => ({
      lines: state.lines.map((l) => {
        if (l.kind !== 'slot' || lineKey(l) !== key) return l
        const found = l.extras.find((e) => e.extra.id === extra.id)
        return {
          ...l,
          extras: found
            ? l.extras.map((e) =>
                e.extra.id === extra.id ? { ...e, quantity: e.quantity + 1 } : e,
              )
            : [...l.extras, { extra, quantity: 1 }],
        }
      }),
    })),

  updateExtraQuantity: (key, extraId, quantity) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.kind === 'slot' && lineKey(l) === key
          ? {
              ...l,
              extras: l.extras
                .map((e) =>
                  e.extra.id === extraId
                    ? { ...e, quantity: Math.max(Math.round(quantity), 0) }
                    : e,
                )
                .filter((e) => e.quantity > 0),
            }
          : l,
      ),
    })),

  removeExtra: (key, extraId) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.kind === 'slot' && lineKey(l) === key
          ? { ...l, extras: l.extras.filter((e) => e.extra.id !== extraId) }
          : l,
      ),
    })),

  removeLine: (key) =>
    set((state) => ({ lines: state.lines.filter((l) => lineKey(l) !== key) })),

  setCustomer: (fields) =>
    set((state) => ({
      customerName: fields.name ?? state.customerName,
      customerEmail: fields.email ?? state.customerEmail,
      customerPhone: fields.phone ?? state.customerPhone,
    })),

  setPaymentMethod: (method) => set({ paymentMethod: method }),

  clear: () =>
    set({
      lines: [],
      customerName: '',
      customerEmail: '',
      customerPhone: '',
      paymentMethod: 'cash',
    }),
}))

// --- Pure money/selectors (mirror the server math; server remains authoritative) ---

export const cartExtrasTotal = (line: CartLine): number =>
  line.kind === 'slot'
    ? line.extras.reduce((sum, e) => sum + e.extra.price * e.quantity, 0)
    : 0

export const cartLineTotal = (line: CartLine): number =>
  line.kind === 'slot'
    ? line.unit_price * line.quantity + cartExtrasTotal(line)
    : line.total

export const cartSubtotal = (lines: CartLine[]): number =>
  lines.reduce((sum, l) => sum + cartLineTotal(l), 0)

export const cartDiscountTotal = (lines: CartLine[]): number =>
  lines.reduce(
    (sum, l) =>
      sum + (l.kind === 'slot' ? (l.service.base_price - l.unit_price) * l.quantity : 0),
    0,
  )

export const cartTotal = (lines: CartLine[]): number => cartSubtotal(lines)

/** Number of distinct cart lines (for the nav cart badge). */
export const cartCount = (lines: CartLine[]): number => lines.length

/** Build the POST /api/pos/folios request body from the cart state. */
export const toConfirmPayload = (state: PosCartState): ConfirmSaleInput => ({
  customer_name: state.customerName.trim() || null,
  customer_email: state.customerEmail.trim() || null,
  customer_phone: state.customerPhone.trim() || null,
  payment_method: state.paymentMethod,
  lines: state.lines.map((l) =>
    l.kind === 'slot'
      ? {
          slot_id: l.slot.id,
          ...(l.zone ? { zone_id: l.zone.id } : {}),
          quantity: l.quantity,
          unit_price: l.unit_price,
          extras: l.extras.map((e) => ({ extra_id: e.extra.id, quantity: e.quantity })),
        }
      : {
          unit_type_id: l.unit_type_id,
          check_in: l.check_in,
          check_out: l.check_out,
          guests: l.guests,
          quantity: l.quantity,
          // Sent only when discounted, so an ordinary stay sale is byte-identical on the wire.
          ...(l.total !== l.quoted_total ? { unit_price: l.total } : {}),
        },
  ),
})
