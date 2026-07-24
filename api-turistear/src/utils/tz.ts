// Organization time-zone helpers (docs/timezone/spec.md — US-A66). The org's single IANA zone is
// the clock all wall-clock scheduling resolves against, replacing the naive-UTC arithmetic that
// WAS BUG-007 (a slot stored "19:00" compared as 19:00 UTC). Cloudflare Workers ship
// `Intl.DateTimeFormat` with `timeZone` support, so no date library is needed.
//
// Stored slot strings ('YYYY-MM-DD' + 'HH:MM') carry no zone — they are org-local wall-clock. These
// helpers convert between that wall-clock and absolute instants using the org's tz.

// The org-local wall-clock parts of an absolute instant, in `tz`.
const partsInTz = (ms: number, tz: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') }
}

// Offset (ms east of UTC) of `tz` at the absolute instant `ms` — DST-correct for that instant.
// Formats the instant in `tz`, reinterprets those wall-clock parts as if they were UTC, and takes
// the difference.
const offsetMsAt = (ms: number, tz: string): number => {
  const { y, mo, d, h, mi, s } = partsInTz(ms, tz)
  return Date.UTC(y, mo - 1, d, h, mi, s) - ms
}

const pad = (n: number) => String(n).padStart(2, '0')

// Org-local "today" as a naive 'YYYY-MM-DD'. Replaces the old UTC `utcToday()` (which rolled the
// day over hours early for a UTC-negative org).
export const orgToday = (tz: string, now = Date.now()): string => {
  const { y, mo, d } = partsInTz(now, tz)
  return `${y}-${pad(mo)}-${pad(d)}`
}

// Org-local wall-clock of an absolute instant, as a fixed-width 'YYYY-MM-DDTHH:MM' string —
// lexicographically comparable to a slot's `date || 'T' || startTime`. Replaces the naive-UTC
// threshold string in `salesThresholdStr`.
export const orgWallClockMinute = (ms: number, tz: string): string => {
  const { y, mo, d, h, mi } = partsInTz(ms, tz)
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`
}

// The real UTC epoch (SECONDS) of a naive wall-clock `date` ('YYYY-MM-DD') + `time` ('HH:MM')
// interpreted in `tz`. Two-pass offset resolution makes it correct across DST transitions (the
// naive wall-clock is first read as if UTC, then corrected by the zone's offset at the resulting
// instant, then corrected once more). Replaces `slotEpoch`.
export const naiveEpoch = (date: string, time: string, tz: string): number => {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  const wallMs = Date.UTC(y, mo - 1, d, h, mi, 0)
  const off1 = offsetMsAt(wallMs, tz)
  const off2 = offsetMsAt(wallMs - off1, tz)
  return Math.floor((wallMs - off2) / 1000)
}
