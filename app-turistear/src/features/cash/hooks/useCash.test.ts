import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { server } from '../../../test/server'
import { withProviders } from '../../../test/renderWithProviders'
import { anAgentBalance, aBalanceRow } from '../../../test/handlers/cash'
import {
  useMyBalance,
  usePendingAckCount,
  useBalances,
  usePendingDropCount,
  useDrop,
  useAddExpense,
  useCreateDrop,
  useReviewDrop,
} from './useCash'

// Tier 2: the seam between the app and the API contract. The service client unwraps an envelope
// ({ balance: … }) that only exists on the wire, so these tests are the only place that unwrapping
// is checked at all.

describe('useMyBalance', () => {
  it('unwraps the { balance } envelope the API sends', async () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useMyBalance(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // Not `{ balance: {...} }` — the envelope is the transport, not the model.
    expect(result.current.data).toMatchObject({ balance: 215_000, cash_collected: 250_000 })
  })

  it('surfaces a server error as an error state, not a thrown render', async () => {
    server.use(
      http.get('/api/cash/me', () =>
        HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Sin permiso' } }, { status: 403 }),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useMyBalance(), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })
})

describe('the nav badge feeds', () => {
  it('selects only the pending-signature count, sharing the balance cache', async () => {
    server.use(
      http.get('/api/cash/me', () =>
        HttpResponse.json({ balance: anAgentBalance({ pending_acknowledgments_count: 3 }) }),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => usePendingAckCount(true), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBe(3)
  })

  it('does not fetch at all when disabled — a non-agent must not poll the agent surface', async () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => usePendingAckCount(false), { wrapper })

    // With onUnhandledRequest:'error' a stray call would fail loudly; assert the idle state too.
    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.data).toBeUndefined()
  })

  it('sums pending drops across every agent for the admin badge (US-UX06)', async () => {
    server.use(
      http.get('/api/cash/balances', () =>
        HttpResponse.json({
          balances: [
            aBalanceRow({ pending_drops_count: 2 }),
            aBalanceRow({ agent: { id: 'agent-2', name: 'Beto' }, pending_drops_count: 3 }),
          ],
        }),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => usePendingDropCount(true), { wrapper })

    await waitFor(() => expect(result.current.data).toBe(5))
  })

  it('reads zero, not undefined, when nothing is pending', async () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => usePendingDropCount(true), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBe(0)
  })
})

describe('useBalances', () => {
  it('unwraps the roster', async () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useBalances(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
    expect(result.current.data?.[0]).toMatchObject({ role: 'agent', balance: 225_000 })
  })
})

describe('useDrop', () => {
  it('stays idle without an id rather than requesting /api/cash/drops/undefined', async () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useDrop(undefined), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('fetches once an id arrives', async () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useDrop('drop-1'), { wrapper })
    await waitFor(() => expect(result.current.data).toMatchObject({ id: 'drop-1' }))
  })
})

// The point of these is the REFETCH, not the invalidateQueries call. Asserting the call would pass
// even if the key were wrong; asserting the refetched value is what catches a mistyped key.
describe('mutations refresh what they invalidate', () => {
  it('useAddExpense refreshes the balance', async () => {
    let hits = 0
    server.use(
      http.get('/api/cash/me', () => {
        hits += 1
        return HttpResponse.json({ balance: anAgentBalance({ balance: hits === 1 ? 215_000 : 210_000 }) })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(
      () => ({ balance: useMyBalance(), addExpense: useAddExpense() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.balance.data?.balance).toBe(215_000))

    result.current.addExpense.mutate({ amount: 5_000, description: 'Gasolina' })

    await waitFor(() => expect(result.current.balance.data?.balance).toBe(210_000))
  })

  it('useCreateDrop refreshes the balance', async () => {
    let hits = 0
    server.use(
      http.get('/api/cash/me', () => {
        hits += 1
        return HttpResponse.json({ balance: anAgentBalance({ pending_drops_total: hits === 1 ? 0 : 100_000 }) })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => ({ balance: useMyBalance(), drop: useCreateDrop() }), {
      wrapper,
    })
    await waitFor(() => expect(result.current.balance.data?.pending_drops_total).toBe(0))

    result.current.drop.mutate({ amount: 100_000 })

    await waitFor(() => expect(result.current.balance.data?.pending_drops_total).toBe(100_000))
  })

  // useReviewDrop invalidates the WHOLE ['cash'] key, not just the queue — confirming a drop moves
  // money, so the balances roster must move with it.
  it('useReviewDrop refreshes the balances roster too', async () => {
    let hits = 0
    server.use(
      http.get('/api/cash/balances', () => {
        hits += 1
        return HttpResponse.json({ balances: [aBalanceRow({ balance: hits === 1 ? 225_000 : 125_000 })] })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => ({ balances: useBalances(), review: useReviewDrop() }), {
      wrapper,
    })
    await waitFor(() => expect(result.current.balances.data?.[0].balance).toBe(225_000))

    result.current.review.mutate({ id: 'drop-1', input: { decision: 'confirmed' } })

    await waitFor(() => expect(result.current.balances.data?.[0].balance).toBe(125_000))
  })

  it('leaves the cache alone when the mutation fails', async () => {
    server.use(
      http.post('/api/cash/me/expenses', () =>
        HttpResponse.json(
          { error: { code: 'AMOUNT_EXCEEDS_BALANCE', message: 'Monto mayor al saldo' } },
          { status: 400 },
        ),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(
      () => ({ balance: useMyBalance(), addExpense: useAddExpense() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.balance.isSuccess).toBe(true))

    result.current.addExpense.mutate({ amount: 999_999_999, description: 'Imposible' })

    await waitFor(() => expect(result.current.addExpense.isError).toBe(true))
    expect(result.current.addExpense.error).toMatchObject({ code: 'AMOUNT_EXCEEDS_BALANCE' })
    // The optimistic-free design means a failed expense must not have moved the displayed balance.
    expect(result.current.balance.data?.balance).toBe(215_000)
  })
})
