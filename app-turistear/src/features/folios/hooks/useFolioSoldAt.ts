import { useMyOrganization } from '../../organization'
import { folioSoldAtLabel } from '../folioCardState'
import { useNowSeconds } from './useNowSeconds'

// US-A82 (D6) — the card's compressed sale time, bound to the ORG's zone (US-A66) so "hoy" means
// the counter's today rather than the viewer's.
//
// The wall clock comes from `useNowSeconds`, never from `Date.now()` in a render body: the lint
// rules reject that, and a list left open on a booth tablet overnight would otherwise keep calling
// yesterday's sales "hoy". Refreshing once a minute is enough — the label changes at most once a day.
export function useFolioSoldAt(): (unixSeconds: number) => string {
  const { data: org } = useMyOrganization()
  const now = useNowSeconds()
  return (unixSeconds: number) => folioSoldAtLabel(unixSeconds, now, org?.timezone)
}
