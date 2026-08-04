import { describe, it, expect } from 'vitest'
import { matchesQuery, normalize, orgDay, rangeLabel, shiftDay } from './folioSearch'
import type { FolioListItem } from './types'

// US-A83 — the local search. Spec: docs/oversight/folio-list-search.spec.md.
//
// This layer decides what typing finds, and it has to answer identically to the server's `?q=` —
// the screen filters here first and only asks the server when this returns nothing, so a
// disagreement would give one query two answers depending on how many rows happened to be loaded.

const folio = (over: Partial<FolioListItem> = {}): FolioListItem =>
  ({
    id: 'abcdef12-0000-4000-8000-000000000001',
    agent: { id: 'a1', name: 'Carlos Méndez' },
    customer_name: 'María Fernández',
    customer_phone: '+52 998 123 4567',
    status: 'paid',
    total: 100_000,
    amount_paid: 100_000,
    created_at: 1_700_000_000,
    cancelled_at: null,
    lines: [{ service_name: 'Tour Isla Mujeres', quantity: 2 }],
    ...over,
  }) as FolioListItem

const finds = (q: string, f = folio()) => matchesQuery(f, normalize(q))

describe('S-1…S-4 — the five fields a folio gets described by', () => {
  it('S-1 — the service, which is the only handle an Express sale has', () => {
    // No name at all (express-sale D17), no operator. Findable only by what was sold.
    const express = folio({
      customer_name: null,
      lines: [{ service_name: 'Catamarán', quantity: 4 }] as FolioListItem['lines'],
    })
    expect(finds('catamaran', express)).toBe(true)
  })

  it('S-2 — accents and case, in both directions', () => {
    for (const q of ['maria', 'MARÍA', 'fernandez', 'Fernández']) {
      expect(finds(q), q).toBe(true)
    }
  })

  it('ñ folds to n — Muñoz is found by typing munoz', () => {
    expect(finds('munoz', folio({ customer_name: 'Muñoz' }))).toBe(true)
    expect(finds('muñoz', folio({ customer_name: 'Munoz' }))).toBe(true)
  })

  it('S-3 — the phone matches DIGITS, however either side is written', () => {
    expect(finds('9981234567')).toBe(true)
    expect(finds('998 123')).toBe(true)
    expect(finds('+52-998')).toBe(true)
    expect(finds('5550000')).toBe(false)
  })

  it('the folio ref — the same 8 characters the WhatsApp template renders', () => {
    expect(finds('abcdef12')).toBe(true)
  })

  it('S-4 — the seller, with its stated cost', () => {
    // D2, accepted: `carlos` matches a sale BY Carlos as surely as one TO him. Recorded here so the
    // behaviour is a decision on the record rather than a surprise in the field.
    expect(finds('carlos')).toBe(true)
    expect(finds('mendez')).toBe(true)
  })

  it('the operator is searchable too — an affiliate shift is how a sale gets described', () => {
    expect(finds('rosa', folio({ operator_name: 'Rosa Elena' }))).toBe(true)
  })

  it('S-5 — a query below the floor filters nothing', () => {
    // `%a%` would return everything, which is not a search (rule 7). It must read as "no filter",
    // not as "no matches" — otherwise the first keystroke empties the screen.
    expect(matchesQuery(folio({ customer_name: 'Zzz', lines: [] }), 'a')).toBe(true)
    expect(matchesQuery(folio({ customer_name: 'Zzz', lines: [] }), '')).toBe(true)
  })

  it('a folio matching nothing is excluded', () => {
    expect(finds('pltano')).toBe(false)
  })

  it('survives a folio with no name, no phone and no lines', () => {
    const bare = folio({ customer_name: null, customer_phone: null, lines: undefined })
    // The list holds pre-feature rows; a crash here would take the whole screen down, which is what
    // an unguarded `.slice` on a missing field did to the date presets during this build.
    expect(() => matchesQuery(bare, 'leo')).not.toThrow()
    expect(finds('leo', bare)).toBe(false)
  })
})

describe('the normalisation is the same one the server applies', () => {
  it('lowercases, strips accents, folds ñ, trims', () => {
    expect(normalize('  MARÍA Muñoz  ')).toBe('maria munoz')
  })
})

describe('org-local day arithmetic', () => {
  it('orgDay reads the ORGANIZATION’s calendar, not the viewer’s', () => {
    // 2026-08-03T02:30Z is still 2026-08-02 in Cancún (UTC−5). `[Hoy]` must mean the counter's day.
    const instant = Math.floor(Date.parse('2026-08-03T02:30:00Z') / 1000)
    expect(orgDay(instant, 'America/Cancun')).toBe('2026-08-02')
    expect(orgDay(instant, 'UTC')).toBe('2026-08-03')
  })

  it('shiftDay walks the calendar, including across a month boundary', () => {
    expect(shiftDay('2026-08-01', -1)).toBe('2026-07-31')
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('rangeLabel collapses a single day', () => {
    expect(rangeLabel('2026-08-03', '2026-08-03')).toBe('3 ago')
    expect(rangeLabel('2026-08-03', '2026-08-12')).toBe('3 ago – 12 ago')
  })
})
