import { request } from './authService'

// The caller's organization, including the booking policy (US-A46). The deposit chip in the
// adaptive checkout (US-AG07.2) reads `booking_min_down_payment_pct` from here.
export interface MyOrganization {
  id: string
  name: string
  booking_min_down_payment_pct: number
  booking_hold_days: number
  same_day_buffer_minutes: number
}

export const getMyOrganization = async (): Promise<MyOrganization> => {
  const res = await request<{ organization: MyOrganization }>('/api/organizations/me')
  return res.organization
}

export interface UpdateOrganizationInput {
  booking_min_down_payment_pct?: number
  booking_hold_days?: number
  same_day_buffer_minutes?: number
}

// US-A46 — admin updates the org booking policy.
export const updateMyOrganization = async (
  data: UpdateOrganizationInput,
): Promise<MyOrganization> => {
  const res = await request<{ organization: MyOrganization }>('/api/organizations/me', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
  return res.organization
}
