import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createAffiliate,
  deactivateAffiliate,
  getAffiliate,
  inviteAffiliate,
  listAffiliates,
  reactivateAffiliate,
  setAffiliateCommissions,
  updateAffiliate,
  type CreateAffiliateInput,
  type UpdateAffiliateInput,
} from '../../../services/affiliatesService'
import type { CommissionEntry } from '../types'

export const AFFILIATES_KEY = ['affiliates'] as const
const detailKey = (id: string) => ['affiliates', id] as const

export function useAffiliates() {
  return useQuery({ queryKey: AFFILIATES_KEY, queryFn: listAffiliates })
}

export function useAffiliate(id: string) {
  return useQuery({ queryKey: detailKey(id), queryFn: () => getAffiliate(id), enabled: !!id })
}

export function useCreateAffiliate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateAffiliateInput) => createAffiliate(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: AFFILIATES_KEY }),
  })
}

export function useUpdateAffiliate(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: UpdateAffiliateInput) => updateAffiliate(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AFFILIATES_KEY })
      qc.invalidateQueries({ queryKey: detailKey(id) })
    },
  })
}

export function useSetCommissions(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entries: CommissionEntry[]) => setAffiliateCommissions(id, entries),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: AFFILIATES_KEY })
      qc.invalidateQueries({ queryKey: detailKey(id) })
    },
  })
}

export function useInviteAffiliate(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (email: string) => inviteAffiliate(id, email),
    onSuccess: () => qc.invalidateQueries({ queryKey: detailKey(id) }),
  })
}

export function useAffiliateStatus(id: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: AFFILIATES_KEY })
    qc.invalidateQueries({ queryKey: detailKey(id) })
  }
  const deactivate = useMutation({ mutationFn: () => deactivateAffiliate(id), onSuccess: invalidate })
  const reactivate = useMutation({ mutationFn: () => reactivateAffiliate(id), onSuccess: invalidate })
  return { deactivate, reactivate }
}
