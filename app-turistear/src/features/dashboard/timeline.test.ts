import { describe, it, expect } from 'vitest'
import { hasDeparted, timelineItems, type TimelineItem } from './timeline'
import type { DashboardDay } from '../../services/dashboardService'

// US-A14/A90 — the departures timeline's two derivations.
// Spec: docs/dashboard/occupancy-dashboard.spec.md (D17, D18; scenarios S-11, S-13).
//
// Tier 1 per docs/TESTING.md: pure functions, no DOM, no server. They belong here rather than in
// the API suite because the API has no opinion on either — it hands back two arrays and a
// classification that is up to 60 s old. What these decide is whether the card the admin reads at
// 14:31 agrees with the clock printed on it, which is an assertion no API test can make.

const occupancyRow = (start_time: string, over: Partial<DashboardDay['occupancy'][0]> = {}) => ({
  slot_id: `slot-${start_time}`,
  service_id: 'svc-1',
  service_name: 'Ruta de Montaña Sagrada',
  start_time,
  capacity: 20,
  booked: 14,
  remaining: 6,
  vendidos: 12,
  apartados: 2,
  is_flexible: false,
  flex_extra: 0,
  ...over,
})

const departedRow = (start_time: string, over: Partial<DashboardDay['departed'][0]> = {}) => ({
  slot_id: `slot-${start_time}`,
  service_name: 'Tour Amanecer Cañón',
  start_time,
  vendidos: 18,
  abordaron: 16,
  sin_usar: 2,
  ...over,
})

const day = (over: Partial<DashboardDay> = {}): DashboardDay => ({
  date: '2026-08-14',
  occupancy: [],
  departed: [],
  sales: { collected_cents: 0, folios_created: 0, per_seller: [] },
  ...over,
})

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
  slot_id: 's',
  service_name: 'Servicio',
  start_time: '14:30',
  boarding: null,
  seats: null,
  ...over,
})

describe('timelineItems — D17, the free merge', () => {
  it('restores chronological order by concatenation alone', () => {
    // The server pushes into `departed` and `occupancy` from ONE ordered pass, so departed rows
    // are always chronologically first. If this ever breaks, the merge needs a sort — and D17's
    // "no endpoint change" argument needs re-arguing.
    const merged = timelineItems(
      day({
        departed: [departedRow('07:00'), departedRow('09:30')],
        occupancy: [occupancyRow('14:00'), occupancyRow('17:30')],
      }),
    )
    expect(merged.map((i) => i.start_time)).toEqual(['07:00', '09:30', '14:00', '17:30'])
  })

  it('carries boarding XOR seats, never both', () => {
    const [past, upcoming] = timelineItems(
      day({ departed: [departedRow('07:00')], occupancy: [occupancyRow('14:00')] }),
    )
    expect(past.boarding).toEqual({ vendidos: 18, abordaron: 16, sin_usar: 2 })
    expect(past.seats).toBeNull()
    expect(upcoming.boarding).toBeNull()
    expect(upcoming.seats?.remaining).toBe(6)
  })

  it('survives an undefined payload (first render, before the query resolves)', () => {
    expect(timelineItems(undefined)).toEqual([])
  })
})

describe('hasDeparted — D18, one clock owns the split', () => {
  it('keeps a server-classified departure above the marker', () => {
    expect(hasDeparted(item({ start_time: '07:00', boarding: { vendidos: 1, abordaron: 1, sin_usar: 0 } }), '09:30', true)).toBe(true)
  })

  it('S-13 — moves a row that departed between polls, before its boarding data arrives', () => {
    // The whole reason the client owns this: the server still has it in `occupancy[]`.
    const justLeft = item({ start_time: '14:30', seats: { capacity: 20, booked: 14, remaining: 6, vendidos: 12, apartados: 2, flex_extra: 0 } })
    expect(hasDeparted(justLeft, '14:31', true)).toBe(true)
  })

  it('treats the boundary minute as departed, exactly as the server does', () => {
    // The server uses `naiveEpoch(...) <= nowMs`; `<` here would disagree for 60 s.
    expect(hasDeparted(item({ start_time: '14:30' }), '14:30', true)).toBe(true)
    expect(hasDeparted(item({ start_time: '14:30' }), '14:29', true)).toBe(false)
  })

  it('S-11 — nothing has departed on a future day, even at times already past today', () => {
    // The regression this guards: "09:00" <= "23:00" is TRUE as a string compare. Without the
    // isToday gate, an admin peeking at tomorrow at 23:00 would see its morning departures greyed
    // out above an «Ahora» marker for a day that has not started.
    expect(hasDeparted(item({ start_time: '09:00' }), '23:00', false)).toBe(false)
  })

  it('never lets a slot un-depart when the device clock lags the server', () => {
    const boarded = item({ start_time: '14:30', boarding: { vendidos: 5, abordaron: 5, sin_usar: 0 } })
    expect(hasDeparted(boarded, '14:29', true)).toBe(true)
  })
})
