// US-A37 — service categories (docs/catalog/service-categories.spec.md).
// A closed enum of stable lowercase keys (mirrors the backend services schema's
// SERVICE_CATEGORIES); this module is the single source of the Spanish display labels
// and the canonical chip order, shared by the catalog form, the admin row chip, and
// the POS filter. Keep the keys in sync with the API enum until/unless it moves to a
// user-managed taxonomy.

export const SERVICE_CATEGORIES = [
  'lodging',
  'tours',
  'dining',
  'adventure',
  'culture',
] as const

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]

/** Spanish UI label per category key. */
export const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  lodging: 'Hospedaje',
  tours: 'Tours',
  dining: 'Gastronomía',
  adventure: 'Aventura',
  culture: 'Cultura',
}

/** A category's display label, or a neutral fallback for a legacy (null) value. */
export const categoryLabel = (category: ServiceCategory | null | undefined): string =>
  category ? CATEGORY_LABELS[category] : 'Sin categoría'

/** Form dropdown / iteration order — the canonical SERVICE_CATEGORIES order. */
export const CATEGORY_OPTIONS: { value: ServiceCategory; label: string }[] =
  SERVICE_CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }))

// ─── Operational model ───────────────────────────────────────────────────────
// The ONE axis on which categories diverge operationally: how inventory is sold.
//   'slots' — service-level price/capacity, sold per departure slot (tours, dining, …).
//   'units' — priced & allocated per unit type (lodging); the service record carries
//             canonical zeros for price/capacity.
// UI and validation consume this through the named predicates below — never through
// `category === 'lodging'` literals — so the rule lives in exactly one place and a new
// category won't compile until its model is declared here. Add an independent capability
// flag only when a real category diverges from its model on a single behavior.

export type InventoryModel = 'slots' | 'units'

const CATEGORY_INVENTORY: Record<ServiceCategory, InventoryModel> = {
  lodging: 'units',
  tours: 'slots',
  dining: 'slots',
  adventure: 'slots',
  culture: 'slots',
}

/** A category's inventory model. Total over the pre-selection empty state ('' while the
 *  admin hasn't chosen yet) — defaults to the common 'slots' model. */
export const inventoryModel = (
  category: ServiceCategory | '' | null | undefined,
): InventoryModel => (category ? CATEGORY_INVENTORY[category] : 'slots')

/** Service-level base/minimum price + default capacity apply (units price per night instead). */
export const pricesAtServiceLevel = (
  category: ServiceCategory | '' | null | undefined,
): boolean => inventoryModel(category) === 'slots'

/** The Hard/Soft-Cap allocation mode applies (unit-based capacity is per unit type). */
export const hasFlexibleCapacity = (
  category: ServiceCategory | '' | null | undefined,
): boolean => inventoryModel(category) === 'slots'
