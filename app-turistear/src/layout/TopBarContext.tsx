import { createContext, useContext, useEffect } from 'react'
import type { DependencyList, ReactNode } from 'react'

// Lets a page inject action elements (e.g. the POS cart) into the layout-owned TopBar.
// The bar is rendered once by AppLayout and never unmounts across navigation, so the avatar
// it contains stays put — this is what removes the route-change "jump" the floating chip had.
export const TopBarActionsSetterContext = createContext<(actions: ReactNode) => void>(
  () => {},
)

/**
 * Inject `actions` into the TopBar for as long as the calling page is mounted (cleared on
 * unmount). Pass `deps` like `useMemo` so dynamic actions re-sync — e.g. a cart badge count.
 * The `actions` node itself is intentionally NOT a dependency: its JSX identity changes every
 * render, which would loop; `deps` is the single source of truth for when to re-sync.
 */
export function useTopBarActions(actions: ReactNode, deps: DependencyList): void {
  const setActions = useContext(TopBarActionsSetterContext)
  useEffect(() => {
    setActions(actions)
    return () => setActions(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setActions, ...deps])
}
