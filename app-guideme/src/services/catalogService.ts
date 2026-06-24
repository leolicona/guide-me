import { request } from './authService'
import type {
  CommissionType,
  Service,
  ServiceExtra,
  ServiceStatus,
} from '../features/catalog/types'
import type { ServiceCategory } from '../features/catalog/categories'

// All money fields below are in minor units (centavos) — the caller converts
// from major-unit form values with amountToCents (features/catalog/types).

export interface ServiceInput {
  name: string
  description: string | null
  base_price: number
  minimum_price: number
  default_capacity: number
  /** US-A36 — capacity mode + overbooking tolerance (%). Hard Cap sends false / 0. */
  is_flexible?: boolean
  flex_capacity_pct?: number
  /** US-A37 — required primary category. */
  category: ServiceCategory
  /** US-A12 — service commission. `percent` → basis points; `fixed` → centavos per spot.
   * Optional: the API defaults to percent/0 (a service that pays no commission). */
  commission_type?: CommissionType
  commission_value?: number
}

export interface ExtraInput {
  name: string
  price: number
}

// US-A09 / list — services in the caller's organization, optionally filtered.
export const listServices = async (
  status?: ServiceStatus,
): Promise<Service[]> => {
  const query = status ? `?status=${status}` : ''
  const res = await request<{ services: Service[] }>(`/api/services${query}`)
  return res.services
}

// US-A13 — service detail (includes `extras`).
export const getService = async (id: string): Promise<Service> => {
  const res = await request<{ service: Service }>(`/api/services/${id}`)
  return res.service
}

export const createService = async (data: ServiceInput): Promise<Service> => {
  const res = await request<{ service: Service }>('/api/services', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.service
}

export const updateService = async (
  id: string,
  data: ServiceInput,
): Promise<Service> => {
  const res = await request<{ service: Service }>(`/api/services/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
  return res.service
}

interface ServiceStatusResponse {
  service: { id: string; name: string; status: ServiceStatus }
}

export const deactivateService = (id: string) =>
  request<ServiceStatusResponse>(`/api/services/${id}/deactivate`, {
    method: 'POST',
  })

export const reactivateService = (id: string) =>
  request<ServiceStatusResponse>(`/api/services/${id}/reactivate`, {
    method: 'POST',
  })

// US-A58 — guarded hard-delete. Throws ServiceError('SERVICE_HAS_FOLIOS', 409) when the service
// has sales history (the caller steers the admin to deactivate instead).
export const deleteService = (id: string) =>
  request<{ ok: boolean; deleted: string }>(`/api/services/${id}`, {
    method: 'DELETE',
  })

// US-A11 — nested extras CRUD.
export const addExtra = async (
  id: string,
  data: ExtraInput,
): Promise<ServiceExtra> => {
  const res = await request<{ extra: ServiceExtra }>(`/api/services/${id}/extras`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.extra
}

export const updateExtra = async (
  id: string,
  extraId: string,
  data: ExtraInput,
): Promise<ServiceExtra> => {
  const res = await request<{ extra: ServiceExtra }>(
    `/api/services/${id}/extras/${extraId}`,
    { method: 'PUT', body: JSON.stringify(data) },
  )
  return res.extra
}

// Soft delete — the row stays, status flips to inactive.
export const removeExtra = async (
  id: string,
  extraId: string,
): Promise<ServiceExtra> => {
  const res = await request<{ extra: ServiceExtra }>(
    `/api/services/${id}/extras/${extraId}`,
    { method: 'DELETE' },
  )
  return res.extra
}
