import { useCallback, useEffect, useState } from 'react'

/** Whole seconds left on a wait (passkey-auth FR-012: Better Auth's `X-Retry-After`), ticking to 0. */
export function useCountdown() {
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (remaining <= 0) return
    const tick = setTimeout(() => setRemaining((s) => s - 1), 1000)
    return () => clearTimeout(tick)
  }, [remaining])

  const start = useCallback((seconds: number) => setRemaining(Math.ceil(seconds)), [])

  return { remaining, start }
}
