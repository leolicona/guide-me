import { create } from 'zustand'

// US-AG30 / US-AG35 — the POS catalog's shared date context. This is the only filter the
// story requires to be global: the catalog's Date filter writes it, and the service-detail
// view inherits it (so an agent who filtered to a date drills into that same day). The
// category selection stays local to the catalog page (it resets on navigation). In-memory
// for the session, like the cart.

// A single day (`to` omitted) or an inclusive multi-day range (`from` < `to`). Tours read
// `from` as their anchor; lodging inherits the whole span to pre-fill a stay. Kept as a
// naive YYYY-MM-DD (single-timezone MVP model).
export interface DateSelection {
  from: string
  to?: string
}

// Convenience alias for a resolved (always-bounded) range — e.g. a context pill's span.
export interface PosDateRange {
  from: string
  to: string
}

interface PosFiltersState {
  // null = no explicit pick → the catalog page falls back to the contextual default week
  // (US-AG35's first context pill). A concrete selection scopes the catalog + detail view.
  selection: DateSelection | null
  // Set an explicit day (`{ from }`) or range (`{ from, to }`), or clear to the default (null).
  setSelection: (selection: DateSelection | null) => void
}

export const usePosFilters = create<PosFiltersState>((set) => ({
  selection: null,
  setSelection: (selection) => set({ selection }),
}))
