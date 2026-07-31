import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import { server } from './server'

// With `globals: false` Testing Library cannot auto-register its afterEach, so mounted trees would
// leak between tests and getByRole would match the previous test's DOM. Register it by hand.
afterEach(cleanup)

// MSW intercepts every request in every suite. Relative paths need an absolute base to match, and
// jsdom's default is http://localhost — the handlers are written relative, so they resolve there.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

beforeAll(() => {
  // jsdom implements neither of these, and MUI reaches for both: useMediaQuery calls matchMedia on
  // mount, and the Popover/Menu positioning path constructs a ResizeObserver. Without them every
  // component test throws before it can assert anything.
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }

  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      readonly root = null
      readonly rootMargin = ''
      readonly thresholds: readonly number[] = []
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): IntersectionObserverEntry[] {
        return []
      }
    } as unknown as typeof IntersectionObserver
  }
})
