import { request } from './authService'
import type { CreateOperatorInput, Operator, OperatorAccess } from '../features/operators/types'

// ---- Manager surface (US-AF10/AF12) — /api/affiliate/operators ----

export const listOperators = async (): Promise<Operator[]> => {
  const res = await request<{ operators: Operator[] }>('/api/affiliate/operators')
  return res.operators
}

export const createOperator = async (data: CreateOperatorInput): Promise<Operator> => {
  const res = await request<{ operator: Operator }>('/api/affiliate/operators', {
    method: 'POST',
    body: JSON.stringify(data),
  })
  return res.operator
}

// US-AF12 — clear the PIN + rotate the token (old link dies); operator re-sets on next open.
export const resetOperatorPin = async (id: string): Promise<Operator> => {
  const res = await request<{ operator: Operator }>(`/api/affiliate/operators/${id}/reset-pin`, {
    method: 'POST',
  })
  return res.operator
}

// US-AF12 — soft remove: void the link + PIN, keep past attribution.
export const removeOperator = (id: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/api/affiliate/operators/${id}/remove`, { method: 'POST' })

// ---- Operator access surface (US-OP01/OP02) — /api/operator ----

export const resolveOperatorAccess = async (token: string): Promise<OperatorAccess> => {
  const res = await request<{ operator: OperatorAccess }>(`/api/operator/access/${token}`)
  return res.operator
}

export const setOperatorPin = (token: string, pin: string, confirm: string) =>
  request<{ operator: { name: string } }>(`/api/operator/access/${token}/set-pin`, {
    method: 'POST',
    body: JSON.stringify({ pin, confirm }),
  })

export const operatorLogin = (token: string, pin: string) =>
  request<{ operator: { name: string } }>(`/api/operator/access/${token}/login`, {
    method: 'POST',
    body: JSON.stringify({ pin }),
  })

export const changeOperatorPin = (current: string, next: string, confirm: string) =>
  request<{ ok: boolean }>('/api/operator/change-pin', {
    method: 'POST',
    body: JSON.stringify({ current, new: next, confirm }),
  })

export const operatorLogout = () =>
  request<{ ok: boolean }>('/api/operator/logout', { method: 'POST' })
