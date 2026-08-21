import { daysInMonth } from './dates'

/** US-AG57 (D8/D9) — what the calendar paints for one day of the month.
 *
 * `available` — the service runs and can seat the group: tappable, availability dot.
 * `sold_out`  — the service runs that day but cannot take the group: tinted, inert.
 * `non_operating` — the service does not run at all: flat, inert, no tint.
 *
 * The third state is the whole point. US-AG33 refused to label a non-operating day «Agotado»
 * because agotado means sold out, which implies it runs — and «ese día no sale» is a different
 * answer to give a customer than «ese día ya se llenó».
 */
export type DayState = 'available' | 'sold_out' | 'non_operating'

/** The server's two arrays for one month (`GET /api/pos/availability/days?service_id=…`). */
export interface ServiceMonth {
  days: string[]
  sold_out: string[]
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Turns the server's two arrays into the map the calendar paints from — ONE ENTRY PER DAY of
 * `month`, so the grid never has to reason about absence.
 *
 * Seeding the whole month first is what makes the third state real. The server sends only the
 * days that operate, and `DateRangeCalendar`'s existing `dayRemaining` contract reads an absent
 * day as "the server decides" (i.e. tappable). Mapping only what arrived would therefore leave
 * every non-operating day live, and the calendar would offer dates the sale then refuses —
 * exactly the class of defect BUG-031 was.
 *
 * Days before `today` are `non_operating` for a different reason than a day the service skips:
 * the server floors its window at `today` and never reports them, so they are unknown rather
 * than known-empty. They land in the same bucket because the seller can do the same thing with
 * both — nothing — and inventing a fourth "past" paint would add a legend row that answers a
 * question nobody asks while looking at a month they cannot sell.
 *
 * While `data` is `undefined` (first load, or a month being paged to) the whole month reads
 * `non_operating`: inert until the answer arrives. The alternative — defaulting to available —
 * would flash tappable days that then die under the thumb, which is worse than a grid that
 * stays quiet for one request.
 */
export const buildDayState = (
  month: string,
  data: ServiceMonth | undefined,
  today: string,
): Map<string, DayState> => {
  const state = new Map<string, DayState>()
  for (let d = 1; d <= daysInMonth(month); d += 1) {
    state.set(`${month}-${pad2(d)}`, 'non_operating')
  }
  if (!data) return state

  // Only days the server actually reported can leave the floor, and never a past one: a stale
  // cached month must not resurrect yesterday when the clock rolls over.
  for (const d of data.sold_out) {
    if (d >= today && state.has(d)) state.set(d, 'sold_out')
  }
  for (const d of data.days) {
    if (d >= today && state.has(d)) state.set(d, 'available')
  }
  return state
}
