import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cancelFolio, getFolio, listFolios } from '../../../services/foliosService'
import type { FolioFilters } from '../types'

const FOLIOS_KEY = ['folios'] as const

// US-A21 — admin folio list (find one to cancel).
export const useFolios = (filters: FolioFilters = {}) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, filters],
    queryFn: () => listFolios(filters),
  })

// US-A21 — one folio's detail.
export const useFolio = (id: string | undefined) =>
  useQuery({
    queryKey: [...FOLIOS_KEY, id],
    queryFn: () => getFolio(id as string),
    enabled: !!id,
  })

// US-A21 — cancel the whole folio; refresh both the list and the open detail.
export const useCancelFolio = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) => cancelFolio(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: FOLIOS_KEY }),
  })
}
