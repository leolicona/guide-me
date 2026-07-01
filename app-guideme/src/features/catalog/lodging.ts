// Accommodation amenities (spec §2.6). The keys equal the API enum by value (stored CSV
// server-side); this module is the single source of the Spanish labels + canonical order,
// shared by the AmenityPicker, the unit row chips, and the POS unit card.

export const AMENITY_KEYS = [
  'wifi',
  'parking',
  'kitchen',
  'ac',
  'heating',
  'pool',
  'pets',
  'breakfast',
] as const

export type AmenityKey = (typeof AMENITY_KEYS)[number]

/** Spanish UI label per amenity key. */
export const AMENITY_LABELS: Record<AmenityKey, string> = {
  wifi: 'WiFi',
  parking: 'Estacionamiento',
  kitchen: 'Cocina',
  ac: 'Aire acondicionado',
  heating: 'Calefacción',
  pool: 'Alberca',
  pets: 'Mascotas',
  breakfast: 'Desayuno incluido',
}

/** Picker / iteration order — the canonical AMENITY_KEYS order. */
export const AMENITY_OPTIONS: { value: AmenityKey; label: string }[] = AMENITY_KEYS.map(
  (value) => ({ value, label: AMENITY_LABELS[value] }),
)

/** An amenity's display label, or the raw key for an unknown (forward-compat) value. */
export const amenityLabel = (key: string): string =>
  (AMENITY_LABELS as Record<string, string>)[key] ?? key

/** "Desde $X / noche" = the lowest of base vs weekend nightly rate (minor units). */
export const fromNightlyRate = (baseRate: number, weekendRate: number | null): number =>
  weekendRate != null ? Math.min(baseRate, weekendRate) : baseRate
