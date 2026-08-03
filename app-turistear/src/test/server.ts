import { setupServer } from 'msw/node'
import { cashHandlers } from './handlers/cash'
import { folioHandlers } from './handlers/folios'
import { catalogHandlers, bookingHandlers } from './handlers/catalog'

// One mock layer for every hook test. `onUnhandledRequest: 'error'` (wired in setup.ts) is
// deliberate: an unhandled request means the test is asserting against nothing, and a warning
// scrolls past where a failure does not.
export const server = setupServer(
  ...cashHandlers,
  ...folioHandlers,
  ...catalogHandlers,
  ...bookingHandlers,
)
