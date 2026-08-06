import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { server } from '../../../test/server'
import { withProviders } from '../../../test/renderWithProviders'
import { aFolio } from '../../../test/handlers/folios'
import {
  useSettleBooking,
  useCancelBooking,
  useClaimReminder,
  useVerifyPayment,
  useRejectPayment,
  useMarkTicketsSent,
} from './useBookingActions'
import { useFolios } from '../../folios/hooks/useFolios'

// A booking action moves money AND inventory, so it invalidates TWO namespaces by their literal
// root keys — ['pos'] and ['folios'] — precisely so this feature never imports from either. That
// indirection is what makes it fragile: a typo'd root key still compiles, still runs, and simply
// stops refreshing the screen the agent is looking at.

/**
 * Mount a folio list alongside `useAction`, fire the action, and assert the list refetched.
 * Each action carries different variables, so the caller does the firing — typed, no `any`.
 */
async function expectsFolioListRefresh(useAction: () => { fire: () => void }) {
  let hits = 0
  server.use(
    http.get('/api/folios', () => {
      hits += 1
      return HttpResponse.json({ folios: [aFolio({ status: hits === 1 ? 'booking' : 'paid' })] })
    }),
  )
  const { wrapper } = withProviders()
  const { result } = renderHook(() => ({ list: useFolios(), action: useAction() }), { wrapper })
  await waitFor(() => expect(result.current.list.data?.folios[0].status).toBe('booking'))

  result.current.action.fire()

  await waitFor(() => expect(result.current.list.data?.folios[0].status).toBe('paid'))
}

describe('booking actions invalidate the admin folio namespace', () => {
  it('settle refreshes a mounted folio list', async () => {
    await expectsFolioListRefresh(() => {
      const m = useSettleBooking()
      return { fire: () => m.mutate({ id: 'folio-1' }) }
    })
  })

  it('cancel refreshes a mounted folio list', async () => {
    await expectsFolioListRefresh(() => {
      const m = useCancelBooking()
      return { fire: () => m.mutate({ id: 'folio-1', reason: 'no llegó' }) }
    })
  })

  it('verify refreshes a mounted folio list', async () => {
    await expectsFolioListRefresh(() => {
      const m = useVerifyPayment()
      return { fire: () => m.mutate('folio-1') }
    })
  })
})

describe('each action hits its own endpoint', () => {
  const capture = (path: string) => {
    const seen: { body: unknown }[] = []
    server.use(
      http.post(path, async ({ request }) => {
        // Some of these actions post no body at all; a failed parse is a legitimate `null`.
        const body = await request.json().catch(() => null)
        seen.push({ body })
        return HttpResponse.json({ folio: { id: 'folio-1' } })
      }),
    )
    return seen
  }

  it('settles through the POS surface (US-AG07/US-LG03), carrying the method and reference', async () => {
    const seen = capture('/api/pos/folios/:id/settle')
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useSettleBooking(), { wrapper })

    result.current.mutate({
      id: 'folio-1',
      payload: { method: 'transfer', payment_reference: 'REF-123' },
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(seen[0].body).toMatchObject({ method: 'transfer', payment_reference: 'REF-123' })
  })

  // `useReactivateBooking` is RETIRED with its endpoint (booking-reschedule.spec.md D3), so its
  // test goes with it rather than being pointed at something else.

  it('claims the reminder atomically before WhatsApp opens (US-AG07.3)', async () => {
    const seen = capture('/api/pos/folios/:id/reminder')
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useClaimReminder(), { wrapper })

    result.current.mutate({ id: 'folio-1', force: true })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(seen).toHaveLength(1)
  })

  it('rejects an electronic payment through the admin surface (US-A67)', async () => {
    const seen = capture('/api/pos/folios/:id/reject')
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useRejectPayment(), { wrapper })

    result.current.mutate({ id: 'folio-1', reason: 'Comprobante no coincide' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(seen[0].body).toMatchObject({ reason: 'Comprobante no coincide' })
  })

  // The seller and the admin mark delivery on DIFFERENT endpoints; the surface argument is the
  // only thing choosing between them, and picking wrong is a 403 in the field.
  it('marks tickets sent on the seller endpoint by default', async () => {
    const seller = capture('/api/pos/folios/:id/ticket-delivery')
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useMarkTicketsSent(), { wrapper })

    result.current.mutate('folio-1')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(seller).toHaveLength(1)
  })

  it('marks tickets sent on the admin endpoint when the surface says admin', async () => {
    const admin = capture('/api/folios/:id/ticket-delivery')
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useMarkTicketsSent('admin'), { wrapper })

    result.current.mutate('folio-1')
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(admin).toHaveLength(1)
  })
})

describe('failures', () => {
  it('surfaces a settle rejection without refreshing anything', async () => {
    let listHits = 0
    server.use(
      http.get('/api/folios', () => {
        listHits += 1
        return HttpResponse.json({ folios: [aFolio({ status: 'booking' })] })
      }),
      http.post('/api/pos/folios/:id/settle', () =>
        HttpResponse.json(
          { error: { code: 'BOOKING_EXPIRED', message: 'El apartado venció' } },
          { status: 409 },
        ),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => ({ list: useFolios(), settle: useSettleBooking() }), {
      wrapper,
    })
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true))
    const hitsBefore = listHits

    result.current.settle.mutate({ id: 'folio-1' })

    await waitFor(() => expect(result.current.settle.isError).toBe(true))
    expect(result.current.settle.error).toMatchObject({ code: 'BOOKING_EXPIRED', status: 409 })
    expect(listHits).toBe(hitsBefore)
  })
})
