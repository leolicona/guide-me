import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { configure, getConfig } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../../../test/server'
import { renderWithProviders, screen, userEvent, waitFor } from '../../../../test/renderWithProviders'
import { ServiceWizard } from './ServiceWizard'

// US-A91 — the wizard's lodging track now asks WHERE a unit goes before anything else. The whole
// point of the feature is that a second cabin stops becoming a second property, so what these
// tests assert is what is written (or NOT written) to /api/services.

const aProperty = (over: Record<string, unknown> = {}) => ({
  id: 'prop-1',
  name: 'Cabañas Imperial',
  description: null,
  base_price: 0,
  minimum_price: 0,
  default_capacity: 1,
  commission_type: 'percent',
  commission_value: 1_000,
  is_flexible: false,
  flex_capacity_pct: 0,
  category: 'lodging',
  status: 'active',
  zones_enabled: false,
  ...over,
})

const aUnit = (over: Record<string, unknown> = {}) => ({
  id: 'unit-1',
  name: 'Cabaña Río',
  unit_type: 'cabaña',
  inventory_count: 2,
  beds: 2,
  base_occupancy: 2,
  max_capacity: 4,
  base_rate: 120_000,
  weekend_rate: null,
  extra_person_fee: 0,
  min_nights: 1,
  checkin_time: '15:00',
  checkout_time: '11:00',
  amenities: [],
  commission_type: null,
  commission_value: null,
  status: 'active',
  ...over,
})

/** Every service/unit write this render performed, in order. */
let calls: string[] = []

function seed({
  properties = [] as ReturnType<typeof aProperty>[],
  units = [] as ReturnType<typeof aUnit>[],
  unitFails = false,
} = {}) {
  calls = []
  server.use(
    http.get('/api/services', () => HttpResponse.json({ services: properties })),
    http.get('/api/services/:id/unit-types', () => HttpResponse.json({ unit_types: units })),
    http.post('/api/services', async ({ request }) => {
      calls.push('POST /services')
      const body = (await request.json()) as { name: string }
      return HttpResponse.json({ service: aProperty({ id: 'svc-new', name: body.name }) })
    }),
    http.post('/api/services/:id/unit-types', ({ params }) => {
      calls.push(`POST /services/${params.id}/unit-types`)
      return unitFails
        ? new HttpResponse(null, { status: 500 })
        : HttpResponse.json({ unit_type: aUnit({ id: `u-${calls.length}` }) })
    }),
  )
}

const renderWizard = () => {
  const onCreated = vi.fn()
  const result = renderWithProviders(
    <ServiceWizard onClose={vi.fn()} onCreated={onCreated} />,
  )
  return { ...result, onCreated }
}

/** Choose a category from the MUI select. Targets the combobox by role: once a category is
 * chosen the rendered label text appears twice (the shrunk label and the legend). */
async function pickCategory(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('combobox', { name: 'Categoría' }))
  await user.click(await screen.findByRole('option', { name: label }))
}

/** Fill the unit draft sheet's required fields and add it. */
async function addUnit(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: 'Agregar unidad' }))
  const nameField = await screen.findByLabelText('Nombre')
  await user.clear(nameField)
  await user.type(nameField, name)
  await user.type(screen.getByLabelText('Tarifa base / noche'), '1200')
  await user.click(screen.getByRole('button', { name: 'Agregar' }))
  console.log('DBG buttons:', Array.from(document.querySelectorAll('button')).map(b => b.textContent?.slice(0,24)).join(' | '))
  const g = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Guardar')!
  const chain: string[] = []
  for (let el: HTMLElement | null = g; el; el = el.parentElement) {
    if (el.getAttribute('aria-hidden')) chain.push(`${el.tagName}.${el.className.toString().slice(0,30)}=${el.getAttribute('aria-hidden')}`)
  }
  console.log('DBG hiddenChain:', JSON.stringify(chain))
}

// BUG-032 — MUI leaves the wizard's container `aria-hidden` after a BottomSheet (SwipeableDrawer,
// keepMounted) closes, so the chrome's footer drops out of the accessibility tree. Pre-existing:
// it reproduces on the untouched create path too. These queries opt into hidden nodes rather than
// assert the bug is absent — drop `{ hidden: true }` when BUG-032 is fixed.
const chromeButton = (name: RegExp) => screen.getByRole('button', { name, hidden: true })

// Mounting the whole wizard — MUI theme, two keepMounted drawers, RHF + zodResolver — is the only
// way to assert what does NOT get written to /api/services, but it is expensive: under a loaded
// parallel run these mounts routinely exceed the 5s default. Testing Library's config is global
// to the WORKER, not the file, so the widened timeout is restored on the way out — leaving it
// raised turns a sibling file's fast negative assertion into a slow test-timeout failure.
// Only the three assertions about what reaches (and does not reach) the API mount the whole
// wizard — everything else about the picker and the step machinery is covered by
// PropertyPicker.test.tsx and wizardTypes.test.ts, which cost a fraction of this.
describe('ServiceWizard — what reaches the API (US-A91)', { timeout: 30_000 }, () => {
  const previousTimeout = getConfig().asyncUtilTimeout
  beforeAll(() => configure({ asyncUtilTimeout: 10_000 }))
  afterAll(() => configure({ asyncUtilTimeout: previousTimeout }))
  beforeEach(() => seed())

  it('S-4 — attaching drops the commission step and writes NOTHING on the service', async () => {
    seed({ properties: [aProperty()], units: [] })
    const user = userEvent.setup({ delay: null })
    const { onCreated } = renderWizard()

    await pickCategory(user, 'Hospedaje')
    // One property ⇒ preselected (D6); the step count drops to 2 immediately.
    expect(await screen.findByText(/PASO 1 DE 2/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Siguiente/i }))
    await addUnit(user, 'Cabaña Pino')
    await user.click(chromeButton(/Guardar/i))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    // The whole contract: the property is never written to, so its commission cannot move.
    expect(calls).toEqual(['POST /services/prop-1/unit-types'])
    expect(onCreated.mock.calls[0][2]).toEqual({
      propertyName: 'Cabañas Imperial',
      unitCount: 1,
    })
  })

  it('S-9 — a failed unit leaves the property alone and reports the shortfall', async () => {
    seed({ properties: [aProperty()], unitFails: true })
    const user = userEvent.setup({ delay: null })
    const { onCreated } = renderWizard()

    await pickCategory(user, 'Hospedaje')
    await user.click(await screen.findByRole('button', { name: /Siguiente/i }))
    await addUnit(user, 'Cabaña Pino')
    await user.click(chromeButton(/Guardar/i))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(calls).toEqual(['POST /services/prop-1/unit-types'])
    // serviceId is the EXISTING property, failures counts the unit, and no service was created.
    expect(onCreated.mock.calls[0].slice(0, 2)).toEqual(['prop-1', 1])
  })

  it('S-10 — the create branch still POSTs the service first', async () => {
    seed({ properties: [aProperty()] })
    const user = userEvent.setup({ delay: null })
    const { onCreated } = renderWizard()

    await pickCategory(user, 'Hospedaje')
    await user.click(await screen.findByText('Crear una propiedad nueva'))
    await user.type(screen.getByLabelText('Nombre de la propiedad nueva'), 'Villas del Mar')
    expect(screen.getByText(/PASO 1 DE 3/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Siguiente/i }))
    await addUnit(user, 'Villa Norte')
    await user.click(chromeButton(/Siguiente/i))
    await user.type(screen.getByLabelText('Comisión', { selector: 'input' }), '10')
    await user.click(chromeButton(/Guardar/i))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(calls).toEqual(['POST /services', 'POST /services/svc-new/unit-types'])
    // No `attached` payload: this created a property, so the list toast applies, not the detail one.
    expect(onCreated.mock.calls[0][2]).toBeUndefined()
  })

})
