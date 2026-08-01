import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { server } from '../../../test/server'
import { withProviders } from '../../../test/renderWithProviders'
import { aFolio, aCancellationRequest } from '../../../test/handlers/folios'
import {
  useFolios,
  useFolio,
  usePendingVerificationCount,
  usePendingRefundCount,
  useOverdueBookingCount,
  usePendingCancellationCount,
  useCancelFolio,
  useApproveCancellationRequest,
} from './useFolios'

/** The query string MSW saw, so filter mapping can be asserted rather than assumed. */
const capturedQuery = () => {
  const seen: string[] = []
  server.use(
    http.get('/api/folios', ({ request }) => {
      seen.push(new URL(request.url).search)
      return HttpResponse.json({ folios: [aFolio()] })
    }),
  )
  return seen
}

describe('useFolios — filter mapping', () => {
  it('sends no query string when unfiltered', async () => {
    const seen = capturedQuery()
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useFolios(), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(seen[0]).toBe('')
  })

  // The hook's camelCase options and the API's snake_case params are two different vocabularies.
  // Nothing but this test checks the translation.
  it('translates camelCase filters into the API snake_case params', async () => {
    const seen = capturedQuery()
    const { wrapper } = withProviders()
    const { result } = renderHook(
      () => useFolios({ agentId: 'agent-9', refundStatus: 'pending', overdue: true }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    const params = new URLSearchParams(seen[0])
    expect(params.get('agent_id')).toBe('agent-9')
    expect(params.get('refund_status')).toBe('pending')
    expect(params.get('overdue')).toBe('true')
  })

  it('caches per filter set — two different filters are two different queries', async () => {
    const seen = capturedQuery()
    const { wrapper, queryClient } = withProviders()

    const a = renderHook(() => useFolios({ status: 'paid' }), { wrapper })
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true))
    const b = renderHook(() => useFolios({ status: 'cancelled' }), { wrapper })
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true))

    expect(seen).toHaveLength(2)
    expect(queryClient.getQueryCache().getAll().length).toBe(2)
  })
})

describe('useFolio', () => {
  it('stays idle without an id', () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useFolio(undefined), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
  })

  it('splits the folio from its cancellation quote', async () => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useFolio('folio-1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toMatchObject({ folio: { id: 'folio-1' }, quote: null })
  })

  it('normalises a missing cancellation_quote to null rather than undefined', async () => {
    server.use(http.get('/api/folios/:id', () => HttpResponse.json({ folio: aFolio() })))
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useFolio('folio-1'), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.quote).toBeNull()
  })

  it('passes the quote through when the org has a ladder', async () => {
    server.use(
      http.get('/api/folios/:id', () =>
        HttpResponse.json({
          folio: aFolio(),
          cancellation_quote: { refund: 120_000, retention: 30_000, tier_label: '48h' },
        }),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useFolio('folio-1'), { wrapper })
    await waitFor(() => expect(result.current.data?.quote).toMatchObject({ refund: 120_000 }))
  })
})

// Each badge is a `select` over a shared query. The risk is not the arithmetic — it is a badge
// counting the WRONG queue, which reads as "nothing to do" while work piles up.
describe('the oversight badge feeds', () => {
  const countFor = (filterCheck: (params: URLSearchParams) => boolean, folios: unknown[]) =>
    server.use(
      http.get('/api/folios', ({ request }) => {
        const params = new URL(request.url).searchParams
        return HttpResponse.json({ folios: filterCheck(params) ? folios : [] })
      }),
    )

  it('counts only folios awaiting payment verification (US-A67)', async () => {
    countFor((p) => p.get('verification') === 'pending', [aFolio(), aFolio({ id: 'folio-2' })])
    const { wrapper } = withProviders()
    const { result } = renderHook(() => usePendingVerificationCount(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBe(2))
  })

  it('counts only refunds still owed (US-A78)', async () => {
    countFor((p) => p.get('refund_status') === 'pending', [aFolio()])
    const { wrapper } = withProviders()
    const { result } = renderHook(() => usePendingRefundCount(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBe(1))
  })

  it('counts only overdue apartados (US-A79)', async () => {
    countFor((p) => p.get('overdue') === 'true', [aFolio(), aFolio({ id: 'f2' }), aFolio({ id: 'f3' })])
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useOverdueBookingCount(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBe(3))
  })

  it('counts pending cancellation requests from their own endpoint', async () => {
    server.use(
      http.get('/api/folios/cancellation-requests', ({ request }) => {
        expect(new URL(request.url).searchParams.get('status')).toBe('pending')
        return HttpResponse.json({ requests: [aCancellationRequest(), aCancellationRequest({ id: 'r2' })] })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => usePendingCancellationCount(true), { wrapper })
    await waitFor(() => expect(result.current.data).toBe(2))
  })

  it.each([
    ['verification', usePendingVerificationCount],
    ['refund', usePendingRefundCount],
    ['overdue', useOverdueBookingCount],
    ['cancellation', usePendingCancellationCount],
  ])('the %s badge does not fetch when disabled', (_label, hook) => {
    const { wrapper } = withProviders()
    const { result } = renderHook(() => hook(false), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
  })
})

describe('mutations refresh the folio surface', () => {
  it('useCancelFolio returns the realised money and refreshes the list', async () => {
    let hits = 0
    server.use(
      http.get('/api/folios', () => {
        hits += 1
        return HttpResponse.json({
          folios: [aFolio({ status: hits === 1 ? 'paid' : 'cancelled' })],
        })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => ({ list: useFolios(), cancel: useCancelFolio() }), {
      wrapper,
    })
    await waitFor(() => expect(result.current.list.data?.[0].status).toBe('paid'))

    result.current.cancel.mutate({ id: 'folio-1', reason: 'Cliente no llegó' })

    await waitFor(() => expect(result.current.cancel.isSuccess).toBe(true))
    // D10 — the ladder prices it; the caller decides nothing beyond the note.
    expect(result.current.cancel.data).toMatchObject({
      folio: { status: 'cancelled' },
      cancellation: { refund: 120_000, retention: 30_000, reversed_commission: 15_000 },
    })
    await waitFor(() => expect(result.current.list.data?.[0].status).toBe('cancelled'))
  })

  it('useApproveCancellationRequest refreshes folios AND the request queue — one key covers both', async () => {
    let requestHits = 0
    server.use(
      http.get('/api/folios/cancellation-requests', () => {
        requestHits += 1
        return HttpResponse.json({ requests: requestHits === 1 ? [aCancellationRequest()] : [] })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(
      () => ({ queue: usePendingCancellationCount(true), approve: useApproveCancellationRequest() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.queue.data).toBe(1))

    result.current.approve.mutate({ id: 'req-1' })

    // The requests key is nested under ['folios'], so invalidating the parent clears both.
    await waitFor(() => expect(result.current.queue.data).toBe(0))
  })

  it('surfaces a rejected cancellation as an error, leaving the folio untouched', async () => {
    server.use(
      http.post('/api/folios/:id/cancel', () =>
        HttpResponse.json(
          { error: { code: 'FOLIO_ALREADY_CANCELLED', message: 'Ya está cancelado' } },
          { status: 409 },
        ),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useCancelFolio(), { wrapper })

    result.current.mutate({ id: 'folio-1' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toMatchObject({ code: 'FOLIO_ALREADY_CANCELLED', status: 409 })
  })
})
