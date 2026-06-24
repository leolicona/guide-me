import { request } from './authService'
import type {
  AffiliateDetail,
  AffiliateListItem,
  CommissionEntry,
} from '../features/affiliates/types'

export interface CreateAffiliateInput {
  company: { name: string; contact_email?: string | null; contact_phone?: string | null }
  commissions: CommissionEntry[]
  invites: string[]
}

export interface CreateAffiliateResponse {
  affiliate: { id: string; name: string; service_count: number; pending_invite_count: number }
}

// US-A54–A57 — wizard finalize (atomic).
export const createAffiliate = (data: CreateAffiliateInput) =>
  request<CreateAffiliateResponse>('/api/affiliates', {
    method: 'POST',
    body: JSON.stringify(data),
  })

// US-A48 — list affiliate companies.
export const listAffiliates = async (): Promise<AffiliateListItem[]> => {
  const res = await request<{ affiliates: AffiliateListItem[] }>('/api/affiliates')
  return res.affiliates
}

// US-A48 — one affiliate (company + commissions + users + pending invites).
export const getAffiliate = async (id: string): Promise<AffiliateDetail> => {
  const res = await request<{ affiliate: AffiliateDetail }>(`/api/affiliates/${id}`)
  return res.affiliate
}

export interface UpdateAffiliateInput {
  name: string
  contact_email?: string | null
  contact_phone?: string | null
}

// US-A48 — edit company profile (D11).
export const updateAffiliate = (id: string, data: UpdateAffiliateInput) =>
  request<{ ok: boolean }>(`/api/affiliates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

// US-A50 — bulk upsert the allow-list (absent service ⇒ disabled).
export const setAffiliateCommissions = (id: string, entries: CommissionEntry[]) =>
  request<{ ok: boolean; service_count: number }>(`/api/affiliates/${id}/commissions`, {
    method: 'PUT',
    body: JSON.stringify(entries),
  })

// US-A49 — invite a login.
export const inviteAffiliate = (id: string, email: string) =>
  request<{ message: string }>(`/api/affiliates/${id}/invite`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  })

// US-A52 — suspend / reactivate.
export const deactivateAffiliate = (id: string) =>
  request<{ ok: boolean; status: string }>(`/api/affiliates/${id}/deactivate`, { method: 'POST' })

export const reactivateAffiliate = (id: string) =>
  request<{ ok: boolean; status: string }>(`/api/affiliates/${id}/reactivate`, { method: 'POST' })
