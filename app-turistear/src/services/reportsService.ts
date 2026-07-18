import { request } from './authService'
import type { CommissionReport, CommissionReportParams } from '../features/reports/types'

// Commission & settlement report by period (admin, US-A17/A18/A20). Read-only over the
// API's folios + cash events. Spec: docs/reports/commission-report.spec.md.

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

const toQuery = (p: CommissionReportParams): string => {
  const params = new URLSearchParams()
  params.set('from', p.from)
  params.set('to', p.to)
  if (p.seller_id) params.set('seller_id', p.seller_id)
  if (p.affiliate_company_id) params.set('affiliate_company_id', p.affiliate_company_id)
  return params.toString()
}

// US-A17/A18 — the per-seller report for the range.
export const getCommissionReport = (p: CommissionReportParams): Promise<CommissionReport> =>
  request<CommissionReport>(`/api/reports/commissions?${toQuery(p)}`)

// US-A20 — download the CSV export. The shared `request` always parses JSON, so the binary
// download uses a direct fetch (cookie auth) and triggers a browser save via an anchor.
export const downloadCommissionReportCsv = async (p: CommissionReportParams): Promise<void> => {
  const res = await fetch(`${API_BASE}/api/reports/commissions/export?${toQuery(p)}&format=csv`, {
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error('No se pudo exportar el reporte')
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `comisiones_${p.from}_${p.to}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
