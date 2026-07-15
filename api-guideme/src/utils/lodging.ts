// Accommodation pricing & availability engine (docs/lodging/accommodation-stays.spec.md §3, v2 —
// unit-type inventory per docs/RFCs/rfc-airbnb-inventory-model.md).
//
// Pure, dependency-free. Imported by BOTH the POS availability serializers (display) and
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
 * NOT overlap (the check-out day is reusable, D4). Used for reservation AND block-out windows.
 */
export const rangesOverlap = (
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean => aStart < bEnd && bStart < aEnd

// --- Pricing ---

export interface UnitTypeRateInfo {
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
 * Rate for a single night, per room. Precedence (D3): a season override (the night falls inside
 * an active season's inclusive [start,end]) beats the weekend rate (the night is a weekend
 * weekday and a weekend rate is set) beats the base rate.
 */
export const nightlyRate = (
  date: string,
  type: Pick<UnitTypeRateInfo, 'baseRate' | 'weekendRate'>,
  seasons: SeasonRate[],
  weekendDays: number[],
): number => {
  const season = seasons.find((s) => date >= s.startDate && date <= s.endDate)
  if (season) return season.nightlyRate
  if (type.weekendRate != null && weekendDays.includes(weekdayOf(date))) {
    return type.weekendRate
  }
  return type.baseRate
}

/**
 * D12 — split total guests across `quantity` rooms as evenly as possible (5/2 → [3,2]).
 * Deterministic; exact for the common case (guests ≤ base_occupancy × quantity ⇒ split moot).
 */
export const splitGuests = (guests: number, quantity: number): number[] => {
  const base = Math.floor(guests / quantity)
  const remainder = guests % quantity
  return Array.from({ length: quantity }, (_, i) => base + (i < remainder ? 1 : 0))
}

export interface StayQuote {
  nights: number
  total: number
  /** Per-night rate SUMMED across the `quantity` rooms (incl. extra-person surcharges). */
  perNight: { date: string; rate: number }[]
}

/**
 * Full price of a stay line (D12): guests split evenly across `quantity` rooms; each room is
 * Σ over each night (room rate + extra-person surcharge above base occupancy); the line total is
 * the sum over rooms. All money in minor units.
 */
export const quoteStay = (
  type: UnitTypeRateInfo,
  checkIn: string,
  checkOut: string,
  guests: number,
  quantity: number,
  seasons: SeasonRate[],
  weekendDays: number[],
): StayQuote => {
  // Σ over rooms of the per-room extra-person fee — constant across nights (D3).
  const extraPerNight = splitGuests(guests, quantity).reduce(
    (sum, roomGuests) =>
      sum + Math.max(0, roomGuests - type.baseOccupancy) * type.extraPersonFee,
    0,
  )
  const perNight = eachNight(checkIn, checkOut).map((date) => ({
    date,
    rate: nightlyRate(date, type, seasons, weekendDays) * quantity + extraPerNight,
  }))
  return {
    nights: perNight.length,
    total: perNight.reduce((sum, n) => sum + n.rate, 0),
    perNight,
  }
}

// --- Availability (per-night counts, D10) ---

export interface QuantityRange {
  /** Half-open [start, end) window the quantity applies to. */
  start: string
  end: string
  quantity: number
}

/**
 * Rooms of a type still free on ONE night: inventory_count − Σ active reservation quantities
 * covering the night − Σ block-out quantities covering the night. Never below 0 (a lowered
 * inventory_count may leave past overselling; clamp for display).
 */
export const remainingOnNight = (
  inventoryCount: number,
  night: string,
  occupancies: QuantityRange[],
): number => {
  const taken = occupancies.reduce(
    (sum, o) => (o.start <= night && night < o.end ? sum + o.quantity : sum),
    0,
  )
  return Math.max(0, inventoryCount - taken)
}

/**
 * The display-side range value (spec §3.3): min over the stay's nights of remainingOnNight.
 * Powers `has_availability` (≥ 1) and the "Quedan N" low-inventory badge.
 */
export const minRemaining = (
  inventoryCount: number,
  checkIn: string,
  checkOut: string,
  occupancies: QuantityRange[],
): number =>
  eachNight(checkIn, checkOut).reduce(
    (min, night) => Math.min(min, remainingOnNight(inventoryCount, night, occupancies)),
    inventoryCount,
  )

export type Unavailable =
  | 'INVALID_RANGE'
  | 'MIN_STAY_NOT_MET'
  | 'OVER_CAPACITY'
  | 'INSUFFICIENT_INVENTORY'
  | 'INACTIVE'

/**
 * Why a unit type can't take a stay of `quantity` rooms for [check_in, check_out) with `guests`
 * total — or `null` if it can. Returns the FIRST failing rule (spec §3.3). `occupancies` are the
 * type's active reservations + block-outs as half-open quantity ranges. This is the DISPLAY-side
 * check; the ENFORCEMENT is the atomic per-night conditional INSERT in confirmSale (same math).
 */
export const checkTypeAvailable = (
  type: { status: string; inventoryCount: number } & Pick<
    UnitTypeRateInfo,
    'maxCapacity' | 'minNights'
  >,
  checkIn: string,
  checkOut: string,
  guests: number,
  quantity: number,
  occupancies: QuantityRange[],
): Unavailable | null => {
  if (type.status !== 'active') return 'INACTIVE'
  if (!(checkOut > checkIn)) return 'INVALID_RANGE'
  if (nightsBetween(checkIn, checkOut) < type.minNights) return 'MIN_STAY_NOT_MET'
  if (quantity < 1 || guests < 1 || guests > type.maxCapacity * quantity) {
    return 'OVER_CAPACITY'
  }
  if (minRemaining(type.inventoryCount, checkIn, checkOut, occupancies) < quantity) {
    return 'INSUFFICIENT_INVENTORY'
  }
  return null
}
