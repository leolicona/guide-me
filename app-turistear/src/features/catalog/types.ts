import type { ServiceCategory } from './categories'
import type { AmenityKey } from './lodging'

export type ServiceStatus = 'active' | 'inactive'

export interface ServiceExtra {
  id: string
  name: string
  /** Price in minor units (centavos). */
  price: number
  status: ServiceStatus
}

export type CommissionType = 'percent' | 'fixed'

export interface Service {
  id: string
  name: string
  description: string | null
  /** All money fields are in minor units (centavos). */
  base_price: number
  minimum_price: number
  default_capacity: number
  /** US-A12 (rev.) — the service's commission, earned identically by any seller
   * (docs/commissions/service-based-commission.spec.md). `percent` → commission_value is
   * basis points (1000 = 10%); `fixed` → minor units per spot, capped at minimum_price. */
  commission_type: CommissionType
  commission_value: number
  /** US-A36 — capacity mode. false → Hard Cap (strict); true → Soft Cap (controlled
   * overbooking up to `flex_capacity_pct`% extra spots per slot). */
  is_flexible: boolean
  /** Overbooking tolerance as a whole-number percent; 0 (and ignored) for Hard Cap. */
  flex_capacity_pct: number
  /** US-A37 — primary category. null only for pre-migration (legacy) services. */
  category: ServiceCategory | null
  status: ServiceStatus
  /** US-A64 — when true, the slot seats are partitioned across `zones` (mutually exclusive with
   * is_flexible). false = a single undifferentiated pool (today's behaviour). */
  zones_enabled: boolean
  /** Present on detail (GET /:id), absent on the list. */
  extras?: ServiceExtra[]
  /** US-A64 — active zone definitions, embedded on detail when zones_enabled. */
  zones?: ServiceZone[]
}

/** US-A64 — a physical zone inside a slot-based service (e.g. a Turibus deck). A pure inventory
 * partition: a name + seat count, no price/commission of its own. */
export interface ServiceZone {
  id: string
  service_id: string
  name: string
  capacity: number
  sort_order: number
  status: ServiceStatus
}

/** US-A36 — largest overbooking tolerance (%) a Soft Cap service may set. Mirrors the
 * backend's services/schema.ts FLEX_CAP_MAX_PCT; keep both in sync until it becomes an
 * org setting (see that file's TODO). */
export const FLEX_CAP_MAX_PCT = 30

// The API stores money as integer minor units; the UI shows/edits a major
// decimal. Keep both conversions here so the round-trip never drifts.

/** minor units (150000) → major decimal (1500). */
export const centsToAmount = (cents: number): number => cents / 100

/** major decimal (1500) → minor units (150000). */
export const amountToCents = (amount: number): number => Math.round(amount * 100)

const currencyFmt = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
})

/** minor units (150000) → display string ("$1,500.00"). */
export const formatMoney = (cents: number): string =>
  currencyFmt.format(centsToAmount(cents))

// A percent commission_value is stored as integer basis points; the UI shows/edits percent.
// (A fixed commission_value is money — use the cents conversions above instead.)

/** percent (e.g. 5) → basis points (500). */
export const percentToBasisPoints = (percent: number): number =>
  Math.round(percent * 100)

/** basis points (500) → percent (5). */
export const basisPointsToPercent = (basisPoints: number): number =>
  basisPoints / 100

// Unit commission override (waterfall) ↔ API mapping — the single source of truth used by BOTH the
// wizard (useCreateLodgingFull) and the detail editor (UnitFormSheet), so the two can't drift.
// Form: 'inherit' | 'percent' | 'fixed' + a major-unit value (percent entered 0–100). API: nullable
// commission_type + commission_value (basis points for percent, minor units for fixed).
export const unitCommissionToApi = (
  type: 'inherit' | 'percent' | 'fixed',
  value: number | null,
): { commission_type: 'percent' | 'fixed' | null; commission_value: number | null } =>
  type === 'inherit' || value == null
    ? { commission_type: null, commission_value: null }
    : type === 'fixed'
      ? { commission_type: 'fixed', commission_value: amountToCents(value) }
      : { commission_type: 'percent', commission_value: percentToBasisPoints(value) }

export const unitCommissionFromApi = (
  type: 'percent' | 'fixed' | null,
  value: number | null,
): { commission_type: 'inherit' | 'percent' | 'fixed'; commission_value: number | null } =>
  type == null || value == null
    ? { commission_type: 'inherit', commission_value: null }
    : type === 'fixed'
      ? { commission_type: 'fixed', commission_value: centsToAmount(value) }
      : { commission_type: 'percent', commission_value: basisPointsToPercent(value) }

// --- Accommodation / lodging (docs/lodging/accommodation-stays.spec.md, v2) ---
// A lodging service owns UNIT TYPES (Airbnb/OTA model): each type has an inventory count,
// nightly rates, seasonal overrides, and quantity block-outs. All money fields are minor
// units (centavos) like the rest of the catalog.

export interface AccommodationUnitType {
  id: string
  service_id: string
  name: string
  unit_type: string | null
  /** How many interchangeable rooms of this type exist (1 = boutique). */
  inventory_count: number
  beds: number
  base_occupancy: number
  max_capacity: number
  /** Base nightly rate (minor units). */
  base_rate: number
  /** Optional weekend nightly rate (minor units); null falls back to base. */
  weekend_rate: number | null
  /** Per-extra-person-per-night surcharge above base occupancy (minor units). */
  extra_person_fee: number
  min_nights: number
  /** 'HH:MM'. */
  checkin_time: string
  /** 'HH:MM'. */
  checkout_time: string
  amenities: AmenityKey[]
  /** Commission override (waterfall): null ⇒ inherits the service's base commission. When set,
   * `commission_value` is basis points (percent) or minor units (fixed). */
  commission_type: CommissionType | null
  commission_value: number | null
  status: ServiceStatus
}

export interface Season {
  id: string
  unit_type_id: string
  name: string
  /** 'YYYY-MM-DD'. */
  start_date: string
  end_date: string
  /** Nightly rate during the season (minor units). */
  nightly_rate: number
  status: ServiceStatus
}

export interface Blockout {
  id: string
  unit_type_id: string
  /** v2 (D11) — rooms of the type removed from inventory; overlapping block-outs sum. */
  quantity: number
  /** 'YYYY-MM-DD'. Half-open [start_date, end_date) like the reservation model. */
  start_date: string
  end_date: string
  reason: string | null
}
