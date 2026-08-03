import { describe, it, expect } from 'vitest'
import { http, HttpResponse } from 'msw'
import { renderHook, waitFor } from '@testing-library/react'
import { server } from '../../../test/server'
import { withProviders } from '../../../test/renderWithProviders'
import { aService } from '../../../test/handlers/catalog'
import { useCreateServiceFull, type WizardSavePayload } from './useCreateServiceFull'
import { useServices } from './useServices'

// The wizard has no transactional endpoint (D1): one POST /services followed by a fan-out of child
// writes, with PARTIAL SUCCESS reported rather than rolled back. Order and failure-counting are the
// whole contract — and both are invisible to any other kind of test.

const core = {
  name: 'Tour Isla',
  base_price: 150_000,
  minimum_price: 120_000,
  default_capacity: 20,
  commission_type: 'percent',
  commission_value: 1_000,
  category: 'tours',
  is_flexible: false,
  flex_capacity_pct: 0,
} as unknown as WizardSavePayload['core']

const payload = (over: Partial<WizardSavePayload> = {}): WizardSavePayload => ({
  core,
  availability: {
    frequency: 'single',
    single_date: '2026-08-05',
    weekdays: [],
    start_date: '',
    end_date: '',
    times: ['09:00', '14:00'],
  },
  extras: [],
  ...over,
})

/** Record the order in which the orchestration hits the API. */
function recordCalls() {
  const calls: string[] = []
  server.use(
    http.post('/api/services', async () => {
      calls.push('service')
      return HttpResponse.json({ service: aService() })
    }),
    http.post('/api/services/:id/slots', async () => {
      calls.push('slot')
      return HttpResponse.json({ slot: { id: 'slot-x' } })
    }),
    http.post('/api/services/:id/schedules', async () => {
      calls.push('schedule')
      return HttpResponse.json({ schedule: { id: 'sch-x' }, created: 12 })
    }),
    http.post('/api/services/:id/zones/enable', async () => {
      calls.push('zones')
      return HttpResponse.json({ zones: [{ id: 'z-1' }, { id: 'z-2' }] })
    }),
    http.post('/api/services/:id/extras', async () => {
      calls.push('extra')
      return HttpResponse.json({ extra: { id: 'extra-x' } })
    }),
  )
  return calls
}

describe('useCreateServiceFull', () => {
  it('creates one slot per departure time on a single-date service', async () => {
    const calls = recordCalls()
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

    result.current.mutate(payload())

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ serviceId: 'svc-1', failures: 0 })
    expect(calls).toEqual(['service', 'slot', 'slot'])
  })

  it('creates one schedule per departure time on a recurring service', async () => {
    const calls = recordCalls()
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

    result.current.mutate(
      payload({
        availability: {
          frequency: 'recurring',
          single_date: '',
          weekdays: [1, 3, 5],
          start_date: '2026-08-01',
          end_date: '2026-08-31',
          times: ['09:00'],
        },
      }),
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(calls).toEqual(['service', 'schedule'])
  })

  it('sends the weekdays and range on each schedule, not just the time', async () => {
    let body: Record<string, unknown> = {}
    server.use(
      http.post('/api/services/:id/schedules', async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>
        return HttpResponse.json({ schedule: { id: 'sch-x' }, created: 12 })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

    result.current.mutate(
      payload({
        availability: {
          frequency: 'recurring',
          single_date: '',
          weekdays: [1, 3, 5],
          start_date: '2026-08-01',
          end_date: '2026-08-31',
          times: ['09:00'],
        },
      }),
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(body).toEqual({
      weekdays: [1, 3, 5],
      start_time: '09:00',
      start_date: '2026-08-01',
      end_date: '2026-08-31',
    })
  })

  // US-A64 — enabling zones eager-creates a slot_zones row per future slot, so the departures must
  // already exist. Getting this order wrong produces a zoned service with unzoned slots.
  it('enables zones AFTER the departures exist', async () => {
    const calls = recordCalls()
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

    result.current.mutate(
      payload({ zones: [{ name: 'Abajo' }, { name: 'Arriba' }] as WizardSavePayload['zones'] }),
    )

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(calls.indexOf('zones')).toBeGreaterThan(calls.lastIndexOf('slot'))
  })

  it('skips the zone call for fewer than two zones — one zone is not a split', async () => {
    const calls = recordCalls()
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

    result.current.mutate(payload({ zones: [{ name: 'Única' }] as WizardSavePayload['zones'] }))

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(calls).not.toContain('zones')
  })

  it('never touches a child endpoint when the service itself fails — a clean fail', async () => {
    const calls = recordCalls()
    server.use(
      http.post('/api/services', () =>
        HttpResponse.json(
          { error: { code: 'DUPLICATE_NAME', message: 'Ya existe' } },
          { status: 409 },
        ),
      ),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

    result.current.mutate(payload({ extras: [{ name: 'Snorkel', price: 25_000 }] }))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toMatchObject({ code: 'DUPLICATE_NAME' })
    expect(calls).toEqual([])
  })

  describe('partial success is reported, not rolled back (D1)', () => {
    it('counts a failed departure without losing the service', async () => {
      let slotHits = 0
      server.use(
        http.post('/api/services/:id/slots', () => {
          slotHits += 1
          return slotHits === 1
            ? HttpResponse.json({ slot: { id: 'slot-1' } })
            : HttpResponse.json({ error: { code: 'SLOT_CONFLICT' } }, { status: 409 })
        }),
      )
      const { wrapper } = withProviders()
      const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

      result.current.mutate(payload())

      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      // The wizard still lands on a real service — the operator finishes on the detail page.
      expect(result.current.data).toEqual({ serviceId: 'svc-1', failures: 1 })
    })

    it('counts a failed zone enable', async () => {
      server.use(
        http.post('/api/services/:id/zones/enable', () =>
          HttpResponse.json({ error: { code: 'ZONES_INVALID' } }, { status: 400 }),
        ),
      )
      const { wrapper } = withProviders()
      const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

      result.current.mutate(
        payload({ zones: [{ name: 'Abajo' }, { name: 'Arriba' }] as WizardSavePayload['zones'] }),
      )

      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(result.current.data?.failures).toBe(1)
    })

    it('counts a failed extra', async () => {
      server.use(
        http.post('/api/services/:id/extras', () =>
          HttpResponse.json({ error: { code: 'INVALID' } }, { status: 400 }),
        ),
      )
      const { wrapper } = withProviders()
      const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

      result.current.mutate(payload({ extras: [{ name: 'Snorkel', price: 25_000 }] }))

      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(result.current.data?.failures).toBe(1)
    })

    it('sums failures across every stage', async () => {
      server.use(
        http.post('/api/services/:id/slots', () => HttpResponse.json({}, { status: 500 })),
        http.post('/api/services/:id/extras', () => HttpResponse.json({}, { status: 500 })),
      )
      const { wrapper } = withProviders()
      const { result } = renderHook(() => useCreateServiceFull(), { wrapper })

      result.current.mutate(payload({ extras: [{ name: 'Snorkel', price: 25_000 }] }))

      await waitFor(() => expect(result.current.isSuccess).toBe(true))
      expect(result.current.data?.failures).toBe(3) // 2 slots + 1 extra
    })
  })

  // A mounted list must show the new service without a manual reload. Asserted through the real
  // useServices hook rather than a hand-primed cache entry: invalidateQueries only refetches
  // queries that have an observer, so priming the cache directly would pass on a WRONG key.
  it('refreshes a mounted services list on success', async () => {
    let hits = 0
    server.use(
      http.get('/api/services', () => {
        hits += 1
        return HttpResponse.json({ services: hits === 1 ? [] : [aService()] })
      }),
    )
    const { wrapper } = withProviders()
    const { result } = renderHook(
      () => ({ list: useServices(), create: useCreateServiceFull() }),
      { wrapper },
    )
    await waitFor(() => expect(result.current.list.data).toEqual([]))

    result.current.create.mutate(payload())

    await waitFor(() => expect(result.current.list.data).toHaveLength(1))
    expect(hits).toBe(2)
  })
})
