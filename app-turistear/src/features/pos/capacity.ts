// US-A36 — client-side Effective Capacity math for the POS.
//
// The POS payload carries the raw capacity-mode fields (`is_flexible`, `flex_capacity_pct`)
// and each slot's raw `capacity` / `booked` / `remaining`. The client derives the effective
// ceiling here so it can drive UI states (e.g. highlighting a slot once the agent dips into
// the flexible margin). The server enforces the identical ceiling atomically at confirm —
// these helpers are for display and input bounds only. `floor` matches the server's rounding.

import type { PosSlot } from './types'

/** Extra spots the flexible margin grants for a given raw capacity (0 for Hard Cap). */
export const flexMargin = (
  capacity: number,
  isFlexible: boolean,
  flexCapacityPct: number,
): number =>
  isFlexible && flexCapacityPct > 0
    ? Math.floor((capacity * flexCapacityPct) / 100)
    : 0

/** The real ceiling the POS may sell a slot up to: capacity + flex margin. */
export const effectiveCapacity = (
  slot: Pick<PosSlot, 'capacity'>,
  isFlexible: boolean,
  flexCapacityPct: number,
): number => slot.capacity + flexMargin(slot.capacity, isFlexible, flexCapacityPct)

/** Sellable spots left, including the flexible margin (≥ the raw `remaining`). */
export const effectiveRemaining = (
  slot: Pick<PosSlot, 'capacity' | 'booked'>,
  isFlexible: boolean,
  flexCapacityPct: number,
): number =>
  effectiveCapacity(slot, isFlexible, flexCapacityPct) - slot.booked

/**
 * True when a slot has no strict spots left but the flexible margin still does — i.e. any
 * sale here dips into overbooking. Used to highlight the slot / counter.
 */
export const isFlexZone = (
  slot: Pick<PosSlot, 'capacity' | 'booked' | 'remaining'>,
  isFlexible: boolean,
  flexCapacityPct: number,
): boolean =>
  isFlexible &&
  slot.remaining <= 0 &&
  effectiveRemaining(slot, isFlexible, flexCapacityPct) > 0
