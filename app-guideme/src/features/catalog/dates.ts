// Date helpers for the Service Wizard's quick-select presets (US-A41). All anchored on the
// device-local `todayStr()` (NOT toISOString — BUG-007 rolls the day over early in UTC-6),
// reusing the POS naive-calendar helper so the whole app shares one notion of "hoy".
import { todayStr } from '../pos/dates'

export { todayStr }

/** Last calendar day of `date`'s month as 'YYYY-MM-DD' (device-local arithmetic). */
export const endOfMonth = (date: string = todayStr()): string => {
  const [y, m] = date.split('-').map(Number)
  // Day 0 of the next month === last day of this month; build the string by hand so we
  // never touch UTC.
  const last = new Date(y, m, 0).getDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

/** December 31 of `date`'s year as 'YYYY-MM-DD'. */
export const endOfYear = (date: string = todayStr()): string => {
  const y = Number(date.slice(0, 4))
  return `${y}-12-31`
}
