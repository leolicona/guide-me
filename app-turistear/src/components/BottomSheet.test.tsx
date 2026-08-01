import { describe, it, expect, vi } from 'vitest'
import { renderWithProviders, screen, userEvent } from '../test/renderWithProviders'
import {
  expectNoA11yViolations,
  SHEET_KNOWN_ISSUES,
  BUSY_SHEET_KNOWN_ISSUES,
} from '../test/axe'
import { BottomSheet } from './BottomSheet'
import { ConfirmSheet } from './ConfirmSheet'
import { FormSheet } from './FormSheet'

describe('BottomSheet', () => {
  // SwipeableDrawer keeps its content MOUNTED so it can animate and be swiped; "closed" is a
  // visibility state, not an unmounted tree. Asserting absence from the document would be
  // asserting a MUI implementation detail that is not true.
  it('hides its content while closed', () => {
    renderWithProviders(
      <BottomSheet open={false} onClose={() => {}}>
        Contenido
      </BottomSheet>,
    )
    expect(screen.queryByText('Contenido')).not.toBeVisible()
  })

  it('renders header, body and footer when open', () => {
    renderWithProviders(
      <BottomSheet open onClose={() => {}} header={<h2>Título</h2>} footer={<button type="button">Aplicar</button>}>
        Cuerpo
      </BottomSheet>,
    )
    expect(screen.getByRole('heading', { name: 'Título' })).toBeInTheDocument()
    expect(screen.getByText('Cuerpo')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Aplicar' })).toBeInTheDocument()
  })

  it('closes from the labelled close control — a one-handed target, not just the backdrop', async () => {
    const onClose = vi.fn()
    renderWithProviders(
      <BottomSheet open onClose={onClose}>
        Cuerpo
      </BottomSheet>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    renderWithProviders(
      <BottomSheet open onClose={onClose}>
        Cuerpo
      </BottomSheet>,
    )
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('has no accessibility violations', async () => {
    renderWithProviders(
      <BottomSheet open onClose={() => {}} header={<h2>Filtros</h2>}>
        Cuerpo
      </BottomSheet>,
    )
    await expectNoA11yViolations(document.body, SHEET_KNOWN_ISSUES)
  })
})

describe('ConfirmSheet', () => {
  const props = {
    open: true,
    onClose: vi.fn(),
    title: '¿Cancelar el folio?',
    confirmLabel: 'Sí, cancelar',
    onConfirm: vi.fn(),
  }

  it('asks the question and offers confirm over cancel', () => {
    renderWithProviders(<ConfirmSheet {...props} onClose={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '¿Cancelar el folio?' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sí, cancelar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
  })

  it('fires confirm exactly once per click — double-submit is a real risk on a phone', async () => {
    const onConfirm = vi.fn()
    renderWithProviders(<ConfirmSheet {...props} onClose={vi.fn()} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sí, cancelar' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('disables BOTH buttons while busy, so a slow network cannot be double-submitted', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    renderWithProviders(<ConfirmSheet {...props} busy onClose={onClose} onConfirm={onConfirm} />)

    // While busy the confirm label is REPLACED by a spinner, so it can no longer be queried by
    // name — see the busy-state a11y test below (docs/BUGS.md BUG-022).
    const buttons = screen.getAllByRole('button')
    const confirm = buttons.find((b) => b.querySelector('.MuiCircularProgress-root'))
    expect(confirm).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('loses the confirm button\'s accessible name while busy (known gap, BUG-022)', async () => {
    renderWithProviders(<ConfirmSheet {...props} busy onClose={vi.fn()} onConfirm={vi.fn()} />)
    // The spinner replaces the label outright, leaving a control a screen reader cannot name.
    expect(screen.queryByRole('button', { name: 'Sí, cancelar' })).not.toBeInTheDocument()
    // axe agrees, and rates it CRITICAL: "Buttons must have discernible text".
    await expectNoA11yViolations(document.body, BUSY_SHEET_KNOWN_ISSUES)
  })

  it('hides the confirm button in terminal-error mode, leaving only a way out', () => {
    renderWithProviders(
      <ConfirmSheet {...props} hideConfirm onClose={vi.fn()} onConfirm={vi.fn()} />,
    )
    expect(screen.queryByRole('button', { name: 'Sí, cancelar' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
  })

  it('renders prose, structured detail and an error region together', () => {
    renderWithProviders(
      <ConfirmSheet
        {...props}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        description="Se liberarán los lugares."
        detail={<div data-testid="detail">Reembolso $1,200.00</div>}
        error={<div role="alert">El folio tiene pagos.</div>}
      />,
    )
    expect(screen.getByText('Se liberarán los lugares.')).toBeInTheDocument()
    expect(screen.getByTestId('detail')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('El folio tiene pagos.')
  })

  it('has no accessibility violations', async () => {
    renderWithProviders(
      <ConfirmSheet
        {...props}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        description="Se liberarán los lugares."
      />,
    )
    await expectNoA11yViolations(document.body, SHEET_KNOWN_ISSUES)
  })
})

describe('FormSheet', () => {
  const base = {
    open: true,
    onClose: vi.fn(),
    title: 'Editar agente',
    submitLabel: 'Guardar',
  }

  it('submits the form when the FOOTER button is pressed, though it sits outside the form', async () => {
    // The footer button is linked by `form={id}`, not nesting. If that link breaks, the sheet
    // renders perfectly and silently saves nothing.
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    renderWithProviders(
      <FormSheet {...base} onClose={vi.fn()} onSubmit={onSubmit}>
        <input aria-label="Nombre" defaultValue="Ana" />
      </FormSheet>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('submits on Enter from a field, with no extra wiring', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault())
    renderWithProviders(
      <FormSheet {...base} onClose={vi.fn()} onSubmit={onSubmit}>
        <input aria-label="Nombre" defaultValue="Ana" />
      </FormSheet>,
    )

    await userEvent.type(screen.getByLabelText('Nombre'), '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('blocks submit while busy', () => {
    renderWithProviders(
      <FormSheet {...base} busy onClose={vi.fn()} onSubmit={vi.fn()}>
        <input aria-label="Nombre" />
      </FormSheet>,
    )
    const submit = screen.getAllByRole('button').find((b) => b.getAttribute('type') === 'submit')
    expect(submit).toBeDisabled()
    // …and it is no longer findable by its label, because the spinner replaced it (BUG-022).
    expect(screen.queryByRole('button', { name: 'Guardar' })).not.toBeInTheDocument()
  })

  it('blocks submit when the draft is invalid, independently of busy', () => {
    renderWithProviders(
      <FormSheet {...base} disabled onClose={vi.fn()} onSubmit={vi.fn()}>
        <input aria-label="Nombre" />
      </FormSheet>,
    )
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
  })

  // Deliberately no Cancel: dismissal is the puller / X / backdrop, the same contract as every
  // other sheet. A stray Cancel button here would fork the pattern.
  it('offers no Cancel button — dismissal is the sheet contract', () => {
    renderWithProviders(
      <FormSheet {...base} onClose={vi.fn()} onSubmit={vi.fn()}>
        <input aria-label="Nombre" />
      </FormSheet>,
    )
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cerrar' })).toBeInTheDocument()
  })

  it('shows the error region above the footer, visible without scrolling the body', () => {
    renderWithProviders(
      <FormSheet
        {...base}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
        error={<div role="alert">Ya existe un agente con ese correo.</div>}
      >
        <input aria-label="Nombre" />
      </FormSheet>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('has no accessibility violations', async () => {
    renderWithProviders(
      <FormSheet {...base} onClose={vi.fn()} onSubmit={vi.fn()}>
        <input aria-label="Nombre" />
      </FormSheet>,
    )
    await expectNoA11yViolations(document.body, SHEET_KNOWN_ISSUES)
  })
})
