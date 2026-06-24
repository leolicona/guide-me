import {
  amountToCents,
  centsToAmount,
  percentToBasisPoints,
  basisPointsToPercent,
} from '../catalog/types'
import type { AffiliateCommission, CommissionEntry, CommissionType } from './types'

// A per-service commission row as edited in the UI. `value` is in DISPLAY units: whole percent
// (e.g. 15) for `percent`, major-unit money (e.g. 100.00) for `fixed`. `enabled` doubles as the
// allow-list flag — only enabled rows become CommissionEntry rows on save (D1).
export interface CommissionDraft {
  enabled: boolean
  commission_type: CommissionType
  value: number | ''
}

export type CommissionDraftMap = Record<string, CommissionDraft>

export const defaultDraft = (): CommissionDraft => ({
  enabled: false,
  commission_type: 'percent',
  value: '',
})

// Seed the editor from saved commissions: enabled with the display value; everything else off.
export const draftFromCommissions = (commissions: AffiliateCommission[]): CommissionDraftMap => {
  const map: CommissionDraftMap = {}
  for (const c of commissions) {
    map[c.service_id] = {
      enabled: true,
      commission_type: c.commission_type,
      value:
        c.commission_type === 'fixed'
          ? centsToAmount(c.commission_value)
          : basisPointsToPercent(c.commission_value),
    }
  }
  return map
}

// Every enabled row must carry a value > 0 (D2 — enable requires a rate).
export const draftsValid = (map: CommissionDraftMap): boolean =>
  Object.values(map).every(
    (d) => !d.enabled || (typeof d.value === 'number' && d.value > 0),
  )

export const enabledCount = (map: CommissionDraftMap): number =>
  Object.values(map).filter((d) => d.enabled).length

// Convert the enabled drafts to API entries (display units → storage units).
export const draftToEntries = (map: CommissionDraftMap): CommissionEntry[] =>
  Object.entries(map)
    .filter(([, d]) => d.enabled && typeof d.value === 'number' && d.value > 0)
    .map(([service_id, d]) => ({
      service_id,
      commission_type: d.commission_type,
      commission_value:
        d.commission_type === 'fixed'
          ? amountToCents(d.value as number)
          : percentToBasisPoints(d.value as number),
    }))
