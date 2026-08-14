import { useEffect, useState } from 'react'
import { nowHM } from '../../pos/dates'

/**
 * D18 — the org-local wall clock, re-rendering on each minute boundary.
 *
 * The «Ahora» marker's label AND the past/upcoming split both read this one value, which is why
 * they can never contradict each other. Deriving the split from the 60 s poll instead would let a
 * 14:30 departure sit below a marker reading 14:31 until the next refetch: the same fact computed
 * on two clocks always drifts, so the finer-grained clock owns it.
 *
 * The time is **computed during render**, never mirrored into state — the effect only schedules
 * re-renders. That is what makes a late-arriving `tz` (the org loads async) correct for free: the
 * render that delivers it already formats in the new zone, with no resync pass.
 *
 * Ticks on the wall-clock minute rather than 60 s after mount, so the displayed minute is never
 * stale — every IANA offset is a whole number of minutes, so the epoch modulo lands on the local
 * boundary too.
 */
export function useOrgClock(tz?: string): string {
  const [, setTick] = useState(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      // +50 ms so a timer firing a hair early still reads the new minute.
      timer = setTimeout(
        () => {
          setTick((n) => n + 1)
          schedule()
        },
        60_000 - (Date.now() % 60_000) + 50,
      )
    }
    schedule()
    return () => clearTimeout(timer)
  }, [])

  return nowHM(tz)
}
