// Accommodation pricing & availability engine (docs/lodging/accommodation-stays.spec.md §3).
//
// Pure, dependency-free. Imported by BOTH the POS availability serializer (display) and
// confirmSale (enforcement) so the quote shown can never drift from the quote charged — the same
// single-source discipline as effectiveCapacity(). All dates are naive org-local 'YYYY-MM-DD';
// a stay occupies the half-open night range [check_in, check_out) (standard hotel turnover, D4).

const MS_PER_DAY = 24 * 60 * 60 * 1000

const toUtcMs = (date: string): number => Date.parse(`${date}T00:00:00Z`)
const fromUtcMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Number of nights in a stay = check_out − check_in (e.g. 10th→13th = 3). */
export const nightsBetween = (checkIn: string, checkOut: string): number =>
  Math.round((toUtcMs(checkOut) - toUtcMs(checkIn)) / MS_PER_DAY)

/** Each night occupied by a stay: the dates [check_in, check_out) in ascending order. */
export const eachNight = (checkIn: string, checkOut: string): string[] => {
  const endMs = toUtcMs(checkOut)
  const out: string[] = []
  for (let ms = toUtcMs(checkIn); ms < endMs; ms += MS_PER_DAY) {
    out.push(fromUtcMs(ms))
  }
  return out
}

/** ISO weekday (0=Sun … 6=Sat) for a 'YYYY-MM-DD' (UTC, to match the calendar-day model). */
export const weekdayOf = (date: string): number => new Date(toUtcMs(date)).getUTCDay()

/** Parse a CSV of ints ("5,6") → number[]; tolerant of empty/whitespace. */
export const parseCsvInts = (csv: string): number[] =>
  csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)

/**
 * Do two half-open date ranges [aStart, aEnd) and [bStart, bEnd) overlap on any day?
 * `aStart < bEnd && bStart < aEnd` — so a stay ending on day X and another starting on day X do
 * NOT overlap (the check-out day is reusable, D4). Used for reservation AND block-out conflicts.
 */
export const rangesOverlap = (
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean => aStart < bEnd && bStart < aEnd

// --- Pricing ---

export interface UnitRateInfo {
  baseRate: number
  weekendRate: number | null
  extraPersonFee: number
  baseOccupancy: number
  maxCapacity: number
  minNights: number
}

export interface SeasonRate {
  startDate: string
  endDate: string
  nightlyRate: number
}

/**
 * Rate for a single night. Precedence (D3): a season override (the night falls inside an active
 * season's inclusive [start,end]) beats the weekend rate (the night is a weekend weekday and a
 * weekend rate is set) beats the base rate.
 */
export const nightlyRate = (
  date: string,
  unit: Pick<UnitRateInfo, 'baseRate' | 'weekendRate'>,
  seasons: SeasonRate[],
  weekendDays: number[],
): number => {
  const season = seasons.find((s) => date >= s.startDate && date <= s.endDate)
  if (season) return season.nightlyRate
  if (unit.weekendRate != null && weekendDays.includes(weekdayOf(date))) {
    return unit.weekendRate
  }
  return unit.baseRate
}

export interface StayQuote {
  nights: number
  total: number
  perNight: { date: string; rate: number }[]
}

/**
 * Full price of a stay: Σ over each night (room rate + extra-person surcharge). The extra-person
 * fee is a flat per-extra-guest, per-night amount above the unit's base occupancy (D3). All money
 * in minor units.
 */
export const quoteStay = (
  unit: UnitRateInfo,
  checkIn: string,
  checkOut: string,
  guests: number,
  seasons: SeasonRate[],
  weekendDays: number[],
): StayQuote => {
  const extraGuests = Math.max(0, guests - unit.baseOccupancy)
  const extraPerNight = extraGuests * unit.extraPersonFee
  const perNight = eachNight(checkIn, checkOut).map((date) => ({
    date,
    rate: nightlyRate(date, unit, seasons, weekendDays) + extraPerNight,
  }))
  return {
    nights: perNight.length,
    total: perNight.reduce((sum, n) => sum + n.rate, 0),
    perNight,
  }
}

// --- Availability ---

export type Unavailable =
  | 'INVALID_RANGE'
  | 'MIN_STAY_NOT_MET'
  | 'OVER_CAPACITY'
  | 'BLOCKED'
  | 'OVERLAP'
  | 'INACTIVE'

export interface DateRangeRow {
  startDate: string
  endDate: string
}

export interface ReservationRange {
  checkIn: string
  checkOut: string
}

/**
 * Why a unit can't take a stay for [check_in, check_out) with `guests` — or `null` if it can.
 * Returns the FIRST failing rule (spec §3.3). Blockouts are half-open [start, end); reservations
 * compare on [check_in, check_out). Callers pass only ACTIVE units + ACTIVE reservations.
 */
export const checkUnitAvailable = (
  unit: { status: string } & Pick<UnitRateInfo, 'maxCapacity' | 'minNights'>,
  checkIn: string,
  checkOut: string,
  guests: number,
  blockouts: DateRangeRow[],
  reservations: ReservationRange[],
): Unavailable | null => {
  if (unit.status !== 'active') return 'INACTIVE'
  if (!(checkOut > checkIn)) return 'INVALID_RANGE'
  if (nightsBetween(checkIn, checkOut) < unit.minNights) return 'MIN_STAY_NOT_MET'
  if (guests < 1 || guests > unit.maxCapacity) return 'OVER_CAPACITY'
  if (blockouts.some((b) => rangesOverlap(checkIn, checkOut, b.startDate, b.endDate))) {
    return 'BLOCKED'
  }
  if (reservations.some((r) => rangesOverlap(checkIn, checkOut, r.checkIn, r.checkOut))) {
    return 'OVERLAP'
  }
  return null
}
