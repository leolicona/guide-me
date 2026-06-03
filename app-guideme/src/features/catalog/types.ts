export type ServiceStatus = 'active' | 'inactive'

export interface ServiceExtra {
  id: string
  name: string
  /** Price in minor units (centavos). */
  price: number
  status: ServiceStatus
}

export interface Service {
  id: string
  name: string
  description: string | null
  /** All money fields are in minor units (centavos). */
  base_price: number
  minimum_price: number
  default_capacity: number
  status: ServiceStatus
  /** Present on detail (GET /:id), absent on the list. */
  extras?: ServiceExtra[]
}

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
