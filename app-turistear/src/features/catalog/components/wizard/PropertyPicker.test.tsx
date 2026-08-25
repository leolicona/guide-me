import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../../../test/server'
import { renderWithProviders, screen, userEvent } from '../../../../test/renderWithProviders'
import { PropertyPicker, NEW_PROPERTY } from './PropertyPicker'
import type { Service } from '../../types'

// US-A91 — the picker is the whole feature in one control: choosing where a unit goes, with the
// escape to a new property always reachable. What is asserted here is the scaling behaviour that
// makes it usable at 1 property and at 20.

const aProperty = (id: string, name: string): Service =>
  ({
    id,
    name,
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
  }) as Service

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => aProperty(`p-${i}`, `Propiedad ${i}`))

function render(properties: Service[], value: string | typeof NEW_PROPERTY | null = null) {
  server.use(
    http.get('/api/services/:id/unit-types', () =>
      HttpResponse.json({
        unit_types: [
          { id: 'u1', name: 'Cabaña Río', inventory_count: 2, status: 'active' },
          { id: 'u2', name: 'Suite', inventory_count: 3, status: 'active' },
        ],
      }),
    ),
  )
  const onChange = vi.fn()
  renderWithProviders(
    <PropertyPicker properties={properties} value={value} onChange={onChange} />,
  )
  return { onChange }
}

describe('PropertyPicker (US-A91)', () => {
  it('names each property by what it holds, so one is recognisable among several', async () => {
    render([aProperty('p-1', 'Cabañas Imperial')])
    // 2 units of 2 + 3 rooms = "2 unidades · 5 en total" — the figure a chip could not carry.
    expect(await screen.findByText('2 unidades · 5 en total')).toBeInTheDocument()
  })

  it('offers the escape to a new property', async () => {
    const user = userEvent.setup({ delay: null })
    const { onChange } = render([aProperty('p-1', 'Cabañas Imperial')])

    await user.click(screen.getByText('Crear una propiedad nueva'))

    expect(onChange).toHaveBeenCalledWith(NEW_PROPERTY)
  })

  it('stays a plain list at six properties and gains search at seven', async () => {
    const { unmount } = renderWithProviders(
      <PropertyPicker properties={many(6)} value={null} onChange={vi.fn()} />,
    )
    expect(screen.queryByPlaceholderText('Buscar propiedad')).not.toBeInTheDocument()
    unmount()

    renderWithProviders(
      <PropertyPicker properties={many(7)} value={null} onChange={vi.fn()} />,
    )
    expect(screen.getByPlaceholderText('Buscar propiedad')).toBeInTheDocument()
  })

  it('D5 — search filters the properties but never hides the ⊕ escape', async () => {
    const user = userEvent.setup({ delay: null })
    const properties = [...many(6), aProperty('p-x', 'Cabañas Imperial')]
    renderWithProviders(
      <PropertyPicker properties={properties} value={null} onChange={vi.fn()} />,
    )

    await user.type(screen.getByPlaceholderText('Buscar propiedad'), 'Cabañas')

    expect(screen.getByText('Cabañas Imperial')).toBeInTheDocument()
    expect(screen.queryByText('Propiedad 0')).not.toBeInTheDocument()
    // The one row that must survive every filter — otherwise creating a property becomes
    // unreachable at the exact moment the user is searching for something that isn't there.
    expect(screen.getByText('Crear una propiedad nueva')).toBeInTheDocument()
  })
})
