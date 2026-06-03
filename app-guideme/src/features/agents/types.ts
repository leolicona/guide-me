export type AgentStatus = 'active' | 'suspended'

export interface Agent {
  id: string
  name: string
  email: string
  phone: string | null
  status: AgentStatus
  /** Base commission in basis points (0–10000; 1050 = 10.50%). */
  base_commission: number
}

// The API stores commission as integer basis points; the UI shows/edits percent.
// Keep both conversions here so the round-trip never drifts.

/** percent (e.g. 10.5) → basis points (1050). */
export const percentToBasisPoints = (percent: number): number =>
  Math.round(percent * 100)

/** basis points (1050) → percent (10.5). */
export const basisPointsToPercent = (basisPoints: number): number =>
  basisPoints / 100
