// devolada-transfer-verification US2, US3 — the admin's decision on a Devolada payment reaches
// `POST /api/devolada/payments/:id/resolve` as the contract states it (contracts/turistear-api.md
// § Resolving Devolada exceptions), and refreshes every screen the decision changes: the admin's
// sales, their counts and detail (`['folios']`), and the seller's (`['pos']`) — research D15.
import { describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { server } from '../../../test/server'
import { withProviders } from '../../../test/renderWithProviders'
import { aFolio } from '../../../test/handlers/folios'
import { useFolios } from '../../folios/hooks/useFolios'
import { useFolioDetailRead } from '../../pos/hooks/useFolio'
import { useResolveDevoladaPayment } from './useResolveDevoladaPayment'

/** Every resolve the hook sends, as the API received it. */
const captureResolves = (status = 200) => {
  const sent: { id: string; body: unknown }[] = []
  server.use(
    http.post('/api/devolada/payments/:id/resolve', async ({ params, request }) => {
      sent.push({ id: String(params.id), body: await request.json() })
      return status === 200
        ? HttpResponse.json({ folio: aFolio() })
        : HttpResponse.json(
            { error: { code: 'DEVOLADA_PAYMENT_NOT_RESOLVABLE', message: 'x' } },
            { status },
          )
    }),
  )
  return sent
}

/** The admin's sales list and the seller's detail, each counting how often it was read. */
const mountReads = () => {
  const reads = { folios: 0, pos: 0 }
  server.use(
    http.get('/api/folios', () => {
      reads.folios += 1
      return HttpResponse.json({ folios: [aFolio()], window_days: 30 })
    }),
    http.get('/api/pos/folios/:id', () => {
      reads.pos += 1
      return HttpResponse.json({ folio: aFolio(), cancellation_quote: null, events: [] })
    }),
  )
  const { wrapper } = withProviders()
  const { result } = renderHook(
    () => ({
      list: useFolios(),
      detail: useFolioDetailRead('folio-1'),
      resolve: useResolveDevoladaPayment(),
    }),
    { wrapper },
  )
  return { reads, result }
}

describe('devolada-transfer-verification US2, US3 — useResolveDevoladaPayment', () => {
  it('sends the action, and the note only when there is one', async () => {
    const sent = captureResolves()
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useResolveDevoladaPayment(), { wrapper })

    await result.current.mutateAsync({ paymentId: 'dpay-1', action: 'returned' })
    await result.current.mutateAsync({
      paymentId: 'dpay-2',
      action: 'dismiss',
      note: 'El cliente pagó el resto en efectivo',
    })

    expect(sent).toEqual([
      { id: 'dpay-1', body: { action: 'returned' } },
      { id: 'dpay-2', body: { action: 'dismiss', note: 'El cliente pagó el resto en efectivo' } },
    ])
  })

  it('a decision refreshes the admin’s sales and the seller’s detail', async () => {
    captureResolves()
    const { reads, result } = mountReads()
    await waitFor(() => expect(reads).toEqual({ folios: 1, pos: 1 }))

    result.current.resolve.mutate({ paymentId: 'dpay-1', action: 'accept' })

    await waitFor(() => expect(reads).toEqual({ folios: 2, pos: 2 }))
  })

  it('a 409 refreshes them too: the screen that offered the decision was stale', async () => {
    const sent = captureResolves(409)
    const { reads, result } = mountReads()
    await waitFor(() => expect(reads).toEqual({ folios: 1, pos: 1 }))

    result.current.resolve.mutate({ paymentId: 'dpay-1', action: 'accept' })

    await waitFor(() => expect(result.current.resolve.isError).toBe(true))
    await waitFor(() => expect(reads).toEqual({ folios: 2, pos: 2 }))
    expect(sent).toHaveLength(1)
  })
})
