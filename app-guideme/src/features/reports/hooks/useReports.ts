import { useMutation, useQuery } from '@tanstack/react-query'
import {
  downloadCommissionReportCsv,
  getCommissionReport,
} from '../../../services/reportsService'
import type { CommissionReportParams } from '../types'

// US-A17/A18 — the commission & settlement report for a period. Keyed by params so changing the
// range refetches. `enabled` guards against firing with an incomplete range.
export const useCommissionReport = (params: CommissionReportParams, enabled = true) =>
  useQuery({
    queryKey: ['reports', 'commissions', params],
    queryFn: () => getCommissionReport(params),
    enabled: enabled && Boolean(params.from && params.to && params.from <= params.to),
  })

// US-A20 — CSV export (a side-effecting download; modelled as a mutation for pending/error UI).
export const useExportCommissionReport = () =>
  useMutation({
    mutationFn: (params: CommissionReportParams) => downloadCommissionReportCsv(params),
  })
