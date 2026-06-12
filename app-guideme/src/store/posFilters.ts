import { create } from 'zustand'

// US-AG30 — the POS catalog's shared day context. This is the only filter the story
// requires to be global: the catalog's Date filter writes it, and the service-detail
// view inherits it (so an agent who filtered to a date drills into that same day).
// The "Ocultar agotados" toggle and the category chip selection stay local to the
// catalog page (they reset on navigation). In-memory for the session, like the cart.
interface PosFiltersState {
  // null = the default "Hoy" anchor → the catalog uses the rolling 3-day window and the
  // detail view shows "today onward". A concrete YYYY-MM-DD = an explicit pick → the
  // catalog evaluates only that day and the detail view scopes to that day.
  selectedDate: string | null
  setSelectedDate: (date: string | null) => void
}

export const usePosFilters = create<PosFiltersState>((set) => ({
  selectedDate: null,
  setSelectedDate: (date) => set({ selectedDate: date }),
}))
