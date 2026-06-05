import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addExpense,
  cancelDrop,
  createDrop,
  deleteExpense,
  getDrop,
  getMyBalance,
  listBalances,
  listDrops,
  registerPayout,
  reviewDrop,
} from '../../../services/cashService'
import type {
  AddExpenseInput,
  CreateDropInput,
  CreatePayoutInput,
  DropFilters,
  ReviewDropInput,
} from '../types'

const CASH_KEY = ['cash'] as const
const ME_KEY = [...CASH_KEY, 'me'] as const
const BALANCES_KEY = [...CASH_KEY, 'balances'] as const
const DROPS_KEY = [...CASH_KEY, 'drops'] as const

// --- Agent surface ---

// US-AG12 — my running balance + breakdown.
export const useMyBalance = () =>
  useQuery({ queryKey: ME_KEY, queryFn: getMyBalance })

// US-AG13 — add/remove an operating expense; refresh my balance.
export const useAddExpense = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AddExpenseInput) => addExpense(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

export const useDeleteExpense = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteExpense(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

// US-AG14 — register / cancel a cash drop; refresh my balance.
export const useCreateDrop = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateDropInput) => createDrop(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

export const useCancelDrop = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => cancelDrop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

// --- Admin surface ---

// US-A19 — outstanding balances per agent (company cash exposure).
export const useBalances = () =>
  useQuery({ queryKey: BALANCES_KEY, queryFn: listBalances })

// US-A19 — the drops review queue (defaults to pending).
export const useDrops = (filters: DropFilters = {}) =>
  useQuery({
    queryKey: [...DROPS_KEY, filters],
    queryFn: () => listDrops(filters),
  })

// US-A19 — one drop's detail.
export const useDrop = (id: string | undefined) =>
  useQuery({
    queryKey: [...DROPS_KEY, id],
    queryFn: () => getDrop(id as string),
    enabled: !!id,
  })

// US-A19 — confirm/reject a drop; refresh the whole cash surface (queue + balances).
export const useReviewDrop = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReviewDropInput }) =>
      reviewDrop(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: CASH_KEY }),
  })
}

// US-A25 — register a payout to an agent; refresh balances.
export const useRegisterPayout = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreatePayoutInput) => registerPayout(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: CASH_KEY }),
  })
}
