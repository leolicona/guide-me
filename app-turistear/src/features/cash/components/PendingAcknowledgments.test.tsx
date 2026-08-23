import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../test/server'
import { renderWithProviders, screen, userEvent, within } from '../../../test/renderWithProviders'
import { PendingAcknowledgments } from './PendingAcknowledgments'

// US-UX08 / D10 — the dispute is entity editing, so it is a FormSheet rather than a centred
// Dialog. Sheets PORTAL to document.body: an assertion written against `container` finds nothing
// and passes without proving anything.

beforeEach(() => {
  server.use(
    http.get('/api/organizations/me', () =>
      HttpResponse.json({
        organization: { id: 'o1', name: 'Turistear Ya!', timezone: 'America/Cancun' },
      }),
    ),
  )
})

const anAck = () => ({
  id: 'drop-9',
  source: 'admin' as const,
  amount: 15_000,
  amount_requested: null,
  balance_before: 100_000,
  note: 'Cobro directo en recepción',
  reviewed_at: 1_800_000_000,
  ack_due_at: 1_900_000_000,
})

describe('PendingAcknowledgments — disputing', () => {
  it('renders nothing when nothing is owed', () => {
    const { container } = renderWithProviders(<PendingAcknowledgments items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('opens a sheet, not a Dialog', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<PendingAcknowledgments items={[anAck()]} />)

    await user.click(screen.getByRole('button', { name: 'Disputar' }))

    expect(document.querySelector('.MuiDrawer-root')).toBeInTheDocument()
    expect(document.querySelector('.MuiDialog-root')).not.toBeInTheDocument()
  })

  // S-9 — an unexplained dispute is a flag the admin cannot act on, so the reason is required and
  // the footer stays disabled until there is one.
  it('refuses to submit without a reason, and accepts one', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithProviders(<PendingAcknowledgments items={[anAck()]} />)
    await user.click(screen.getByRole('button', { name: 'Disputar' }))

    const sheet = within(document.querySelector('.MuiDrawer-root') as HTMLElement)
    const submit = sheet.getByRole('button', { name: 'Disputar' })
    expect(submit).toBeDisabled()

    await user.type(sheet.getByLabelText(/Razón/), 'Faltaban $200')
    expect(submit).toBeEnabled()
  })
})
