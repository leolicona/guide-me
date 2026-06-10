import { createContext, useContext } from 'react'
import type { UserPayload } from './types'

// The authenticated session's single source of truth, provided by AuthGuard once
// the ['me'] query has resolved. Consuming it through context (rather than a
// separately-synced store) guarantees descendants see the exact user AuthGuard
// already authorized on — synchronously, with no one-tick lag.
const CurrentUserContext = createContext<UserPayload | null>(null)

export const CurrentUserProvider = CurrentUserContext.Provider

/** Returns the authenticated user. Throws if used outside an AuthGuard subtree. */
export function useCurrentUser(): UserPayload {
  const user = useContext(CurrentUserContext)
  if (!user) {
    throw new Error('useCurrentUser must be used within an authenticated route (AuthGuard)')
  }
  return user
}
