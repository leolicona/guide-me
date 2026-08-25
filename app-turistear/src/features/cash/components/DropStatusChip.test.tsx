import { describe, it, expect } from 'vitest'
import { renderWithProviders, screen } from '../../../test/renderWithProviders'
import { DropStatusChip } from './DropStatusChip'
import { AckChip } from './AckChip'
import type { AckState, DropStatus } from '../types'

// The caja's two state pills. Both went through a raw MUI `Chip color=…` — a coloured pill with no
// glyph — so a drop's state reached a colour-blind cashier as a word on a tinted background whose
// tint said nothing. That is the rule the design system calls non-negotiable, and the same defect
// BUG-035 was: the presentation, not the data.
//
// The maps behind them also lived in three byte-identical copies (BalancePage, CashBalancesPage,
// CashDropDetailPage). This file is what keeps the single copy honest.

const DROP_STATUSES: DropStatus[] = ['pending', 'confirmed', 'rejected']
const ACK_STATES: Exclude<AckState, 'not_required'>[] = [
  'pending',
  'signed',
  'auto_signed',
  'disputed',
  'resolved',
]

describe('DropStatusChip', () => {
  it.each(DROP_STATUSES)('pairs %s with an icon, never colour alone', (status) => {
    const { container } = renderWithProviders(<DropStatusChip status={status} />)
    expect(container.querySelector('.MuiChip-icon')).toBeInTheDocument()
  })

  it.each([
    ['pending', 'Pendiente'],
    ['confirmed', 'Confirmado'],
    ['rejected', 'Rechazado'],
  ] as const)('labels %s in Spanish as «%s»', (status, label) => {
    renderWithProviders(<DropStatusChip status={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

describe('AckChip', () => {
  it.each(ACK_STATES)('pairs %s with an icon, never colour alone', (state) => {
    const { container } = renderWithProviders(<AckChip state={state} />)
    expect(container.querySelector('.MuiChip-icon')).toBeInTheDocument()
  })

  // Most drops owe nobody a signature. Rendering «no aplica» for them would be noise on every row.
  it('renders nothing when no signature is owed', () => {
    const { container } = renderWithProviders(<AckChip state="not_required" />)
    expect(container.querySelector('.MuiChip-root')).not.toBeInTheDocument()
  })

  // The obligation shouts once — in the AlertCard at the top of the page, where the Firmar and
  // Disputar buttons are. A second amber pill on the row, beside the drop's own green «Confirmado»,
  // made one row state two things at once. The row keeps the fact; the alarm stays upstairs.
  it('keeps the outstanding signature quiet, so it cannot argue with the drop’s own state', () => {
    const { container } = renderWithProviders(<AckChip state="pending" />)
    expect(container.querySelector('.MuiChip-root')).toHaveStyle({
      color: 'var(--color-text-secondary, #475569)',
    })
    expect(screen.getByText('Por firmar')).toBeInTheDocument()
  })

  // A contested drop is the one acknowledgment state that IS an alarm, and it has no competing
  // pill of its own to argue with.
  it('still colours a dispute', () => {
    const { container } = renderWithProviders(<AckChip state="disputed" />)
    expect(container.querySelector('.MuiChip-root')).toHaveStyle({
      color: 'var(--color-error-fg, #991B1B)',
    })
  })
})
