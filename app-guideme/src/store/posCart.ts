import { create } from 'zustand'
import type { PosExtra, PosSlot } from '../features/pos/types'
import type { ConfirmSaleInput } from '../services/posService'

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

export interface CartLine {
  service: CartService
  slot: PosSlot
  /** Number of people; >= 1, soft-capped at the slot's remaining. */
  quantity: number
  /** Discounted unit price (minor units), clamped to [minimum_price, base_price]. */
  unit_price: number
  extras: CartExtra[]
}

interface PosCartState {
  lines: CartLine[]
  customerName: string
  customerEmail: string
  customerPhone: string

  /** Add a service/slot. If the slot is already in the cart, quantities merge. */
  addLine: (input: {
    service: CartService
    slot: PosSlot
    quantity?: number
    unit_price?: number
    extras?: CartExtra[]
  }) => void
  updateQuantity: (slotId: string, quantity: number) => void
  setUnitPrice: (slotId: string, unitPrice: number) => void
  addExtra: (slotId: string, extra: PosExtra) => void
  updateExtraQuantity: (slotId: string, extraId: string, quantity: number) => void
  removeExtra: (slotId: string, extraId: string) => void
  removeLine: (slotId: string) => void
  setCustomer: (fields: Partial<{ name: string; email: string; phone: string }>) => void
  clear: () => void
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

export const usePosCart = create<PosCartState>((set) => ({
  lines: [],
  customerName: '',
  customerEmail: '',
  customerPhone: '',

  addLine: ({ service, slot, quantity = 1, unit_price, extras = [] }) =>
    set((state) => {
      const price = clamp(
        unit_price ?? service.base_price,
        service.minimum_price,
        service.base_price,
      )
      const existing = state.lines.find((l) => l.slot.id === slot.id)
      if (existing) {
        // Merge quantities (distinct-slot rule), soft-capped at remaining.
        const merged = Math.min(existing.quantity + quantity, slot.remaining || quantity)
        return {
          lines: state.lines.map((l) =>
            l.slot.id === slot.id ? { ...l, quantity: Math.max(merged, 1) } : l,
          ),
        }
      }
      const capped = slot.remaining ? Math.min(quantity, slot.remaining) : quantity
      return {
        lines: [
          ...state.lines,
          { service, slot, quantity: Math.max(capped, 1), unit_price: price, extras },
        ],
      }
    }),

  updateQuantity: (slotId, quantity) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.slot.id === slotId
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

  setUnitPrice: (slotId, unitPrice) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.slot.id === slotId
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

  addExtra: (slotId, extra) =>
    set((state) => ({
      lines: state.lines.map((l) => {
        if (l.slot.id !== slotId) return l
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

  updateExtraQuantity: (slotId, extraId, quantity) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.slot.id === slotId
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

  removeExtra: (slotId, extraId) =>
    set((state) => ({
      lines: state.lines.map((l) =>
        l.slot.id === slotId
          ? { ...l, extras: l.extras.filter((e) => e.extra.id !== extraId) }
          : l,
      ),
    })),

  removeLine: (slotId) =>
    set((state) => ({ lines: state.lines.filter((l) => l.slot.id !== slotId) })),

  setCustomer: (fields) =>
    set((state) => ({
      customerName: fields.name ?? state.customerName,
      customerEmail: fields.email ?? state.customerEmail,
      customerPhone: fields.phone ?? state.customerPhone,
    })),

  clear: () =>
    set({ lines: [], customerName: '', customerEmail: '', customerPhone: '' }),
}))

// --- Pure money/selectors (mirror the server math; server remains authoritative) ---

export const cartExtrasTotal = (line: CartLine): number =>
  line.extras.reduce((sum, e) => sum + e.extra.price * e.quantity, 0)

export const cartLineTotal = (line: CartLine): number =>
  line.unit_price * line.quantity + cartExtrasTotal(line)

export const cartSubtotal = (lines: CartLine[]): number =>
  lines.reduce((sum, l) => sum + cartLineTotal(l), 0)

export const cartDiscountTotal = (lines: CartLine[]): number =>
  lines.reduce(
    (sum, l) => sum + (l.service.base_price - l.unit_price) * l.quantity,
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
  lines: state.lines.map((l) => ({
    slot_id: l.slot.id,
    quantity: l.quantity,
    unit_price: l.unit_price,
    extras: l.extras.map((e) => ({ extra_id: e.extra.id, quantity: e.quantity })),
  })),
})
