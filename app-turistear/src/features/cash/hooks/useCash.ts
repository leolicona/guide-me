import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  acknowledgeDrop,
  addExpense,
  cancelDrop,
  createDrop,
  deleteExpense,
  disputeDrop,
  getDrop,
  getMyBalance,
  listBalances,
  listDrops,
  registerCollection,
  registerPayout,
  resolveDispute,
  reviewDrop,
} from '../../../services/cashService'
import type {
  AddExpenseInput,
  CreateDropInput,
  CreatePayoutInput,
  DisputeInput,
  DropFilters,
  RegisterCollectionInput,
  ResolveDisputeInput,
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

// US-AG27/AG28 — sign a pending admin money-move; refresh my balance (the item leaves the
// pending-signatures list; the balance itself never changes).
export const useAcknowledgeDrop = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => acknowledgeDrop(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

// US-AG27/AG28 — dispute a pending admin money-move (required reason).
export const useDisputeDrop = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DisputeInput }) =>
      disputeDrop(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  })
}

// Badge feed for the nav (agents only — pass `enabled: role === 'agent'`). Shares the
// ['cash','me'] cache with BalancePage, so it adds no extra request when both are mounted.
export const usePendingAckCount = (enabled: boolean) =>
  useQuery({
    queryKey: ME_KEY,
    queryFn: getMyBalance,
    enabled,
    select: (b) => b.pending_acknowledgments_count,
  })

// --- Admin surface ---

// US-A19 — outstanding balances per agent (company cash exposure).
export const useBalances = () =>
  useQuery({ queryKey: BALANCES_KEY, queryFn: listBalances })

// US-UX06 — badge feed for the admin nav (admins only — pass `enabled: role === 'admin'`).
// The count of cash drops awaiting the admin's confirmation, summed across the org's agents.
// Shares the ['cash','balances'] cache with CashBalancesPage, so it adds no extra request when
// both are mounted. The admin's OWN drops are self-authorized (born confirmed) and never
// pending, so they never inflate this badge.
export const usePendingDropCount = (enabled: boolean) =>
  useQuery({
    queryKey: BALANCES_KEY,
    queryFn: listBalances,
    enabled,
    select: (rows) => rows.reduce((n, r) => n + r.pending_drops_count, 0),
  })

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

// US-A27 — direct collection from an agent; refresh the whole cash surface.
export const useRegisterCollection = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: RegisterCollectionInput) => registerCollection(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: CASH_KEY }),
  })
}

// US-A27/A28 (D5) — resolve an agent's dispute; refresh the queue + detail.
export const useResolveDispute = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ResolveDisputeInput }) =>
      resolveDispute(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: CASH_KEY }),
  })
}
