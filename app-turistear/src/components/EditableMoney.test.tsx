import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider } from '@mui/material'
import { theme } from '../config/theme'
import { EditableMoney } from './EditableMoney'

// The editable twin of MoneyText (US-AG06 / US-AG57). What matters is that the SAME element reads
// as money at rest and accepts a raw number while focused, and that it can never hand its owner a
// value outside the band — every caller relies on that instead of validating again.

// EditableMoney is CONTROLLED: it reformats from the `cents` prop, so the host must feed the
// committed value back. The harness mirrors how the cart uses it (commit → store → re-render),
// which is what makes "reformats on blur" a real assertion rather than a coincidence.
function Host({
  onCommit,
  ...over
}: { onCommit: (c: number) => void } & Partial<React.ComponentProps<typeof EditableMoney>>) {
  const [cents, setCents] = useState(over.cents ?? 120_000)
  return (
    <EditableMoney
      min={91_000}
      max={130_000}
      label="Total"
      maxLabel="cotizado"
      srLabel="Total de la estancia"
      {...over}
      cents={cents}
      onCommit={(c) => {
        setCents(c)
        onCommit(c)
      }}
    />
  )
}

const setup = (over: Partial<React.ComponentProps<typeof EditableMoney>> = {}) => {
  const onCommit = vi.fn()
  render(
    <ThemeProvider theme={theme}>
      <Host onCommit={onCommit} {...over} />
    </ThemeProvider>,
  )
  return { onCommit }
}

describe('EditableMoney', () => {
  it('reads as money at rest — the figure, not a raw number', () => {
    setup()
    expect(screen.getByLabelText('Total de la estancia')).toHaveValue('$1,200.00')
  })

  it('drops to the raw major-unit number on focus, so a thumb can retype it', async () => {
    const user = userEvent.setup()
    setup()
    const field = screen.getByLabelText('Total de la estancia')
    await user.click(field)
    expect(field).toHaveValue('1200')
  })

  it('reformats on blur, so the resting state is always money', async () => {
    const user = userEvent.setup()
    const { onCommit } = setup()
    const field = screen.getByLabelText('Total de la estancia')
    await user.clear(field)
    await user.type(field, '1150')
    await user.tab()
    expect(onCommit).toHaveBeenCalledWith(115_000)
    expect(field).toHaveValue('$1,150.00')
  })

  it('names both bounds while the value is valid', () => {
    setup()
    expect(screen.getByText('Mín $910.00 · cotizado $1,300.00')).toBeInTheDocument()
  })

  it('warns below the floor WHILE typing, before anything commits', async () => {
    const user = userEvent.setup()
    const { onCommit } = setup()
    const field = screen.getByLabelText('Total de la estancia')
    await user.clear(field)
    await user.type(field, '500')
    expect(screen.getByText('Mínimo $910.00')).toBeInTheDocument()
    expect(onCommit).not.toHaveBeenCalled() // never mid-keystroke
  })

  it('commits the floor when the agent leaves a below-floor value', async () => {
    const user = userEvent.setup()
    const { onCommit } = setup()
    const field = screen.getByLabelText('Total de la estancia')
    await user.clear(field)
    await user.type(field, '500')
    await user.tab()
    expect(onCommit).toHaveBeenCalledWith(91_000)
    expect(field).toHaveValue('$910.00')
  })

  it('commits the ceiling when the agent tries to raise the price', async () => {
    const user = userEvent.setup()
    const { onCommit } = setup()
    const field = screen.getByLabelText('Total de la estancia')
    await user.clear(field)
    await user.type(field, '9999')
    await user.tab()
    expect(onCommit).toHaveBeenCalledWith(130_000)
  })

  it('keeps the current amount when the field is left empty', async () => {
    const user = userEvent.setup()
    const { onCommit } = setup()
    const field = screen.getByLabelText('Total de la estancia')
    await user.clear(field)
    await user.tab()
    expect(onCommit).toHaveBeenCalledWith(120_000)
    expect(field).toHaveValue('$1,200.00')
  })

  // D4 — the border IS the affordance. With no margin there is nothing to negotiate, so the
  // control degrades to the plain figure rather than offering an input that can only reject.
  describe('with no margin (min === max)', () => {
    it('renders the figure with no field at all', () => {
      setup({ cents: 130_000, min: 130_000, max: 130_000 })
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(screen.getByText('$1,300.00')).toBeInTheDocument()
    })

    it('reads the same amount it would have shown as a field', () => {
      setup({ cents: 200_000, min: 200_000, max: 200_000 })
      expect(screen.getByLabelText('Total de la estancia: $2,000.00')).toBeInTheDocument()
    })
  })
})
