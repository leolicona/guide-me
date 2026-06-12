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
