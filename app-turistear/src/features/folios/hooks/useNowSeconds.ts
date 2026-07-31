import { useEffect, useState } from 'react'

// The wall clock is external mutable state, not a value a render may read: calling `Date.now()`
// in a render body is impure and the lint rules reject it. Reading it in an effect also buys a
// real feature — the work queues (US-A78/A79) show the AGE of a debt, and a page left open on a
// booth tablet should not keep claiming "hace 1 min" an hour later.
//
// Returns null on the very first render (before the effect runs), so callers must treat "unknown
// time" explicitly rather than silently rendering an age of zero.
export const useNowSeconds = (refreshMs = 60_000): number | null => {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000))
    tick()
    const id = setInterval(tick, refreshMs)
    return () => clearInterval(id)
  }, [refreshMs])

  return now
}
