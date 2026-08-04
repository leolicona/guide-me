import { useEffect, useState } from 'react'

/**
 * US-A83 (D4) — hold a value still for `delay` ms.
 *
 * Used for the SERVER fallback only. The local pass runs in memory over a payload that is already
 * loaded, so it filters on every keystroke with nothing to wait for; this one crosses the network,
 * and firing it per character would send a request for `l`, `le` and `leo` to answer one question.
 *
 * The caller compares the debounced value against the live one to know whether it has settled,
 * which is what keeps a stale result from being rendered as though it answered the current query.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])

  return settled
}
