import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addExpense,
  closeDrawer,
  deleteExpense,
  getDrawer,
  getMyDrawer,
  listDrawers,
  reviewDrawer,
  type DrawerFilters,
} from '../../../services/cashDrawerService'
import type { ReviewDecision } from '../types'

const ME_KEY = ['cash-drawer', 'me'] as const
const ADMIN_KEY = ['cash-drawers'] as const

// --- Agent surface (US-AG12 / AG13 / AG14) ---

export const useMyDrawer = (date?: string) =>
  useQuery({
    queryKey: [...ME_KEY, date ?? 'today'],
    queryFn: () => getMyDrawer(date),
  })

export const useAddExpense = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: addExpense,
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

export const useDeleteExpense = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteExpense,
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

export const useCloseDrawer = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (date?: string) => closeDrawer(date),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cash-drawer'] }),
  })
}

// --- Admin surface (US-A19) ---

export const useDrawers = (filters: DrawerFilters = {}) =>
  useQuery({
    queryKey: [...ADMIN_KEY, filters],
    queryFn: () => listDrawers(filters),
  })

export const useDrawer = (id: string | undefined) =>
  useQuery({
    queryKey: [...ADMIN_KEY, id],
    queryFn: () => getDrawer(id as string),
    enabled: !!id,
  })

export const useReviewDrawer = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: ReviewDecision; note?: string }) =>
      reviewDrawer(id, decision, note),
    onSuccess: () => qc.invalidateQueries({ queryKey: ADMIN_KEY }),
  })
}
