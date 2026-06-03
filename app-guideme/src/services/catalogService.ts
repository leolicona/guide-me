import { request } from './authService'
import type { Service, ServiceExtra, ServiceStatus } from '../features/catalog/types'

// All money fields below are in minor units (centavos) — the caller converts
// from major-unit form values with amountToCents (features/catalog/types).

export interface ServiceInput {
  name: string
  description: string | null
  base_price: number
  minimum_price: number
  default_capacity: number
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
