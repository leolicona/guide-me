import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  closeSlotZone,
  createZone,
  deactivateZone,
  deleteZone,
  disableZones,
  enableZones,
  listZones,
  reactivateZone,
  reopenSlotZone,
  updateZone,
  type EnableZonesInput,
  type ZoneInput,
} from '../../../services/zonesService'
import { SERVICES_QUERY_KEY } from './useServices'
import { SLOTS_QUERY_KEY } from '../../schedules/hooks/useSlots'

// US-A64 — zone list + mutations for a slot-based service. Every write invalidates the service
// detail (its embedded `zones` + `zones_enabled`), the catalog list (availability derives from the
// reconciled slot totals), and the slot list (per-slot `zones` + reconciled capacity/booked).
export const zonesQueryKey = (serviceId: string) => ['service-zones', serviceId] as const

export function useZones(serviceId: string, enabled = true) {
  return useQuery({
    queryKey: zonesQueryKey(serviceId),
    queryFn: () => listZones(serviceId),
    enabled: enabled && !!serviceId,
  })
}

export function useZoneMutations(serviceId: string) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: zonesQueryKey(serviceId) })
    queryClient.invalidateQueries({ queryKey: SERVICES_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: SLOTS_QUERY_KEY })
  }

  const enable = useMutation({
    mutationFn: (data: EnableZonesInput) => enableZones(serviceId, data),
    onSuccess: invalidate,
  })
  const disable = useMutation({
    mutationFn: () => disableZones(serviceId),
    onSuccess: invalidate,
  })
  const create = useMutation({
    mutationFn: (data: ZoneInput) => createZone(serviceId, data),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: ({ zoneId, data }: { zoneId: string; data: ZoneInput }) =>
      updateZone(serviceId, zoneId, data),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (zoneId: string) => deleteZone(serviceId, zoneId),
    onSuccess: invalidate,
  })
  const deactivate = useMutation({
    mutationFn: (zoneId: string) => deactivateZone(serviceId, zoneId),
    onSuccess: invalidate,
  })
  const reactivate = useMutation({
    mutationFn: (zoneId: string) => reactivateZone(serviceId, zoneId),
    onSuccess: invalidate,
  })
  const close = useMutation({
    mutationFn: ({ slotId, zoneId }: { slotId: string; zoneId: string }) =>
      closeSlotZone(serviceId, slotId, zoneId),
    onSuccess: invalidate,
  })
  const reopen = useMutation({
    mutationFn: ({ slotId, zoneId }: { slotId: string; zoneId: string }) =>
      reopenSlotZone(serviceId, slotId, zoneId),
    onSuccess: invalidate,
  })

  return { enable, disable, create, update, remove, deactivate, reactivate, close, reopen }
}
