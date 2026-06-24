import type { CommissionType } from '../catalog/types'

export type { CommissionType }

export type AffiliateStatus = 'active' | 'suspended'

// List row (GET /api/affiliates).
export interface AffiliateListItem {
  id: string
  name: string
  contact_email: string | null
  contact_phone: string | null
  status: AffiliateStatus
  service_count: number
  user_count: number
}

// One enabled service + its rate (the allow-list, D1). `commission_value` is basis points for
// `percent` (1500 = 15%) | minor units per spot for `fixed`.
export interface AffiliateCommission {
  service_id: string
  service_name: string
  service_status: 'active' | 'inactive'
  commission_type: CommissionType
  commission_value: number
}

export interface AffiliateUser {
  id: string
  name: string
  email: string
  position: string | null
  status: 'unverified' | 'active' | 'suspended'
}

export interface AffiliatePendingInvite {
  id: string
  identity: string
  created_at: number
}

// Detail (GET /api/affiliates/:id).
export interface AffiliateDetail {
  id: string
  name: string
  contact_email: string | null
  contact_phone: string | null
  status: AffiliateStatus
  commissions: AffiliateCommission[]
  users: AffiliateUser[]
  pending_invites: AffiliatePendingInvite[]
}

// One commission entry as sent to the API (storage units).
export interface CommissionEntry {
  service_id: string
  commission_type: CommissionType
  commission_value: number
}
