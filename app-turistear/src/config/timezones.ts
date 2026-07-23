// US-A66 (docs/timezone/spec.md — D5) — the curated set of IANA zones an admin may pick, one human
// label per mainland-Mexico offset. Mirrors the API allow-list (`ORG_TIMEZONES` in
// api-turistear/src/routes/organizations/schema.ts) — keep the two in sync. IANA (not a raw offset)
// so DST + multi-zone resolve automatically, incl. the northern border strip that still observes
// US DST. The FIRST entry is the app-wide default.

export interface OrgTimezoneOption {
  value: string
  label: string
}

export const ORG_TIMEZONE_OPTIONS: readonly OrgTimezoneOption[] = [
  { value: 'America/Mexico_City', label: 'Centro (CDMX, Guadalajara, Monterrey)' },
  { value: 'America/Cancun', label: 'Sureste (Cancún, Quintana Roo)' },
  { value: 'America/Hermosillo', label: 'Pacífico (Sonora)' },
  { value: 'America/Mazatlan', label: 'Noroeste (Sinaloa, Baja California Sur)' },
  { value: 'America/Tijuana', label: 'Frontera Noroeste (Tijuana)' },
] as const

export const DEFAULT_ORG_TIMEZONE = ORG_TIMEZONE_OPTIONS[0].value

// The human label for a stored zone (falls back to the raw value for an unknown zone).
export const orgTimezoneLabel = (value: string): string =>
  ORG_TIMEZONE_OPTIONS.find((o) => o.value === value)?.label ?? value
