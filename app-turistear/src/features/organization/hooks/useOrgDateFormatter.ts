import { useMyOrganization } from './useMyOrganization'

// US-A66 (docs/timezone/spec.md) — a date/time formatter bound to the ORG's time zone, so audit
// timestamps (folio created, payment, cash move, reminder sent) read the same for every viewer
// regardless of their device zone. Returns a `(unixSeconds) => string` with `opts` baked in, a
// drop-in for the per-page module-level `formatDate` helpers it replaces.
//
// Until the org query resolves, `tz` is undefined and formatting falls back to the device zone
// (staff at the location share it anyway) — never a crash, just the pre-load value.
export function useOrgDateFormatter(
  opts: Intl.DateTimeFormatOptions,
): (unixSeconds: number) => string {
  const { data: org } = useMyOrganization()
  const tz = org?.timezone
  return (unixSeconds: number) =>
    new Date(unixSeconds * 1000).toLocaleString(undefined, { timeZone: tz, ...opts })
}
