import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { TicketQr } from './TicketQr'
import type { FolioLine } from '../types'

// The access ticket as RENDERED. Written for the two defects the design review found once US-A93
// put this card on the admin's screen too: it printed the one raw ISO date on the page, and its
// QR was an `<svg role="img">` with no accessible name.

const aLine = (over: Partial<FolioLine> = {}): FolioLine =>
  ({
    id: 'l1',
    line_type: 'slot',
    service_id: 's1',
    slot_id: 'sl1',
    service_name: 'Tour Isla Mujeres',
    slot_date: '2026-09-07',
    slot_start_time: '08:00',
    quantity: 2,
    base_price: 75_000,
    minimum_price: 50_000,
    unit_price: 75_000,
    line_total: 150_000,
    qr_token: 'tok',
    qr: {
      folio_id: 'f1',
      folio_line_id: 'l1',
      service_id: 's1',
      slot_id: 'sl1',
      client_identity: 'María Fernández',
      passes_total: 2,
      expires_at: 1_900_000_000,
    },
    extras: [],
    ...over,
  }) as FolioLine

describe('Design review, Should Fix 4 — the departure reads as a sentence', () => {
  it('formats the date instead of printing the ISO pair', () => {
    renderWithProviders(<TicketQr line={aLine()} />)
    // «2026-09-07 · 08:00» sat two lines under «Salida: 7 sep 2026, 8:00 a.m.» — the same fact,
    // twice, one of them in a format the reader has to decode.
    expect(screen.getByText(/7 sep 2026/)).toBeInTheDocument()
    expect(screen.queryByText(/2026-09-07/)).toBeNull()
  })

  it('a lodging line has no departure and falls back to its own meta line', () => {
    renderWithProviders(
      <TicketQr
        line={aLine({
          line_type: 'stay',
          slot_date: null,
          slot_start_time: null,
          check_in: '2026-09-07',
          check_out: '2026-09-09',
          nights: 2,
          guests: 2,
          quantity: 1,
        })}
      />,
    )
    expect(screen.getByText(/noches/)).toBeInTheDocument()
  })
})

describe('the QR is named', () => {
  it('carries an accessible label naming the service it belongs to', () => {
    renderWithProviders(<TicketQr line={aLine()} />)
    // `qrcode.react` renders `role="img"`; unnamed, axe reports it as a serious violation.
    expect(
      screen.getByRole('img', { name: /Código QR del boleto — Tour Isla Mujeres/ }),
    ).toBeInTheDocument()
  })
})
