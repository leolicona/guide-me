import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createOperator,
  listOperators,
  removeOperator,
  resetOperatorPin,
} from '../../../services/operatorsService'
import type { CreateOperatorInput } from '../types'

export const OPERATORS_KEY = ['operators'] as const

export function useOperators() {
  return useQuery({ queryKey: OPERATORS_KEY, queryFn: listOperators })
}

export function useCreateOperator() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateOperatorInput) => createOperator(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: OPERATORS_KEY }),
  })
}

export function useResetOperatorPin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => resetOperatorPin(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: OPERATORS_KEY }),
  })
}

export function useRemoveOperator() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => removeOperator(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: OPERATORS_KEY }),
  })
}
