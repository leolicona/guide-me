import { request } from './authService'
import type { ServiceZone } from '../features/catalog/types'

// US-A64 — admin zone management for a slot-based service. All money-free: a zone is a name + seat
// count. Spec: docs/catalog/zoned-capacity.spec.md.

export interface ZoneInput {
  name: string
  capacity: number
  sort_order?: number
}

export interface EnableZonesInput {
  zones: ZoneInput[]
  /** Index into `zones` that absorbs seats already sold on future departures (required when any
   * exist — the API enforces the conditional requirement). */
  assign_existing_to?: number
}

export const listZones = async (serviceId: string): Promise<ServiceZone[]> => {
  const res = await request<{ zones: ServiceZone[] }>(`/api/services/${serviceId}/zones?status=all`)
  return res.zones
}

export const enableZones = (serviceId: string, data: EnableZonesInput) =>
  request<{ zones_enabled: boolean; zones: ServiceZone[] }>(
    `/api/services/${serviceId}/zones/enable`,
    { method: 'POST', body: JSON.stringify(data) },
  )

export const disableZones = (serviceId: string) =>
  request<{ zones_enabled: boolean }>(`/api/services/${serviceId}/zones/disable`, {
    method: 'POST',
    body: JSON.stringify({}),
  })

export const createZone = (serviceId: string, data: ZoneInput) =>
  request<{ zone: ServiceZone }>(`/api/services/${serviceId}/zones`, {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updateZone = (serviceId: string, zoneId: string, data: ZoneInput) =>
  request<{ zone: ServiceZone }>(`/api/services/${serviceId}/zones/${zoneId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })

export const deleteZone = (serviceId: string, zoneId: string) =>
  request<{ deleted: boolean }>(`/api/services/${serviceId}/zones/${zoneId}`, { method: 'DELETE' })

export const deactivateZone = (serviceId: string, zoneId: string) =>
  request<{ zone: ServiceZone }>(`/api/services/${serviceId}/zones/${zoneId}/deactivate`, {
    method: 'POST',
  })

export const reactivateZone = (serviceId: string, zoneId: string) =>
  request<{ zone: ServiceZone }>(`/api/services/${serviceId}/zones/${zoneId}/reactivate`, {
    method: 'POST',
  })

// Per-departure closure (the rain case).
export const closeSlotZone = (serviceId: string, slotId: string, zoneId: string) =>
  request(`/api/services/${serviceId}/slots/${slotId}/zones/${zoneId}/close`, { method: 'POST' })

export const reopenSlotZone = (serviceId: string, slotId: string, zoneId: string) =>
  request(`/api/services/${serviceId}/slots/${slotId}/zones/${zoneId}/reopen`, { method: 'POST' })
