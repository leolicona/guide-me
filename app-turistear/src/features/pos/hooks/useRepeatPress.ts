import { useEffect, useLayoutEffect, useRef } from 'react'

/** Press-and-hold acceleration for stepper buttons. A single tap fires once; holding the
 * button repeats the step, speeding up the longer it's held — so adding a large party no
 * longer means tapping `+` dozens of times.
 *
 * `step` performs one increment/decrement and returns `true` if the value actually changed.
 * Returning `false` (a bound was reached) stops the repeat early. Spread the returned
 * handlers onto the button; keep the button's own logic out of `onClick` to avoid a double
 * step — the keyboard path is handled here too. */
export function useRepeatPress(step: () => boolean) {
  // Kept current via an effect (writing a ref during render is disallowed); handlers only
  // read it later, in event callbacks, so the latest closure is always seen.
  const stepRef = useRef(step)
  useLayoutEffect(() => {
    stepRef.current = step
  })

  // True between pointerdown and the trailing synthetic click, so the click is swallowed
  // (the press already stepped). A keyboard-driven click leaves this false and steps once.
  const viaPointer = useRef(false)
  const timer = useRef<number | undefined>(undefined)

  const stop = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
    }
  }

  // Each tick re-arms with a shorter delay (400ms hold → repeats from 300ms down to 60ms).
  const schedule = (delay: number) => {
    timer.current = window.setTimeout(() => {
      if (!stepRef.current()) {
        stop()
        return
      }
      schedule(Math.max(60, delay - 35))
    }, delay)
  }

  const onPointerDown = () => {
    viaPointer.current = true
    if (stepRef.current()) schedule(400)
  }

  const onClick = () => {
    if (viaPointer.current) {
      viaPointer.current = false
      return
    }
    stepRef.current()
  }

  useEffect(() => stop, [])

  return {
    onPointerDown,
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onClick,
  }
}
