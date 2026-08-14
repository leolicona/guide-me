import type { DashboardDay } from '../../services/dashboardService'

/**
 * One departure on the day's timeline (D9 amended — «Por partir» and «Ya partieron» are one axis,
 * not two cards). `boarding` and `seats` are mutually exclusive and reflect how the SERVER
 * classified the slot at the last poll: it computes boarding only for slots it saw as departed
 * (today only) and the seat split only for the ones it saw as still upcoming.
 */
export interface TimelineItem {
  slot_id: string
  service_name: string
  start_time: string
  boarding: { vendidos: number; abordaron: number; sin_usar: number } | null
  seats: {
    capacity: number
    booked: number
    remaining: number
    vendidos: number
    apartados: number
    flex_extra: number
  } | null
}

/**
 * D17 — the merge is component-side and free. The server built `departed[]` and `occupancy[]` by
 * walking ONE `ORDER BY start_time` pass (api-turistear/src/routes/dashboard/handler.ts), pushing
 * each row into one array or the other, so concatenating them in that order restores the original
 * chronology exactly. No endpoint change, no re-sort, no test edit.
 */
export const timelineItems = (day?: DashboardDay): TimelineItem[] => [
  ...(day?.departed ?? []).map((r) => ({
    slot_id: r.slot_id,
    service_name: r.service_name,
    start_time: r.start_time,
    boarding: { vendidos: r.vendidos, abordaron: r.abordaron, sin_usar: r.sin_usar },
    seats: null,
  })),
  ...(day?.occupancy ?? []).map((r) => ({
    slot_id: r.slot_id,
    service_name: r.service_name,
    start_time: r.start_time,
    boarding: null,
    seats: {
      capacity: r.capacity,
      booked: r.booked,
      remaining: r.remaining,
      vendidos: r.vendidos,
      apartados: r.apartados,
      flex_extra: r.flex_extra,
    },
  })),
]

/**
 * D18 — has this departure already left, as of the client's org-local clock?
 *
 * This is the single predicate that decides which side of the «Ahora» marker a row lands on. It
 * must agree with the marker's own label, which comes from the same `now` string (useOrgClock), or
 * the card contradicts itself between polls.
 *
 * Inputs:
 *   `item.start_time`  — 'HH:MM', zero-padded 24h; orders lexicographically.
 *   `item.boarding`    — non-null when the SERVER already classified this slot as departed.
 *   `now`              — 'HH:MM' org-local, same shape, ticking each minute.
 *   `isToday`          — false when the day strip is peeking at a future date.
 */
export const hasDeparted = (item: TimelineItem, now: string, isToday: boolean): boolean => {
  // A future day is checked FIRST and explicitly, because the clock comparison alone would get it
  // backwards: at 23:00 today, tomorrow's 09:00 departure satisfies `"09:00" <= "23:00"` and would
  // render as already gone. Times only order within a day — comparing across days is meaningless.
  if (!isToday) return false

  // Either clock may move a row into the past, and neither may move one back out:
  //  · the server's classification is epoch-exact in the org's zone but up to 60 s old;
  //  · the client's is current to the minute but rides a device clock that can be wrong.
  // OR-ing them means a row crosses the marker at the earlier of the two and then stays there —
  // a slot cannot un-depart, and a row flickering back below the marker would be worse than late.
  // `<=` (not `<`) matches the server's own `naiveEpoch(...) <= nowMs`, so the two agree on the
  // boundary minute instead of disagreeing for exactly the 60 s that matter most.
  return item.boarding !== null || item.start_time <= now
}
