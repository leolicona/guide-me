import { useMyOrganization } from './useMyOrganization'

// US-A66 (docs/timezone/timezone.spec.md) — a date/time formatter bound to the ORG's time zone, so audit
// timestamps (folio created, payment, cash move, reminder sent) read the same for every viewer
// regardless of their device zone. Returns a `(unixSeconds) => string` with `opts` baked in, a
// drop-in for the per-page module-level `formatDate` helpers it replaces.
//
// Until the org query resolves, `tz` is undefined and formatting falls back to the device zone
// (staff at the location share it anyway) — never a crash, just the pre-load value.
//
// TECH_DEBT #24 (closed) — the LOCALE is pinned to 'es-MX', matching `folioSoldAtLabel` (US-A82
// D16): the app's copy is Spanish, so its dates are too, regardless of the browser's language.
// Leaving it `undefined` printed "Aug 2, 10:52 AM" inside Spanish sentences on English devices.
export function useOrgDateFormatter(
  opts: Intl.DateTimeFormatOptions,
): (unixSeconds: number) => string {
  const { data: org } = useMyOrganization()
  const tz = org?.timezone
  return (unixSeconds: number) =>
    new Date(unixSeconds * 1000).toLocaleString('es-MX', { timeZone: tz, ...opts })
}
