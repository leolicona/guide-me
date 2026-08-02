import { ButtonBase, Stack } from '@mui/material'
import { FilterStrip, filterChipSx } from '../../filters'
import type { FolioCounts } from '../../../services/foliosService'
import type { FacetKey } from '../folioFacets'

// US-A84 (D5/D6) — the pending-work bar: one pill per kind of work that actually exists.
//
// It APPLIES a facet rather than navigating (D6). That is the difference between this and the five
// tabs it replaces: tapping a count used to take you to a different screen whose relationship to
// the one you left was invisible, and now it turns on a filter in place — visible in the strip,
// visible here, reversible with one more tap, and leaving the search and date range intact.
//
// Only counts > 0 render, so a quiet day costs zero vertical space (D5). Rendering the zeroes would
// be the empty tabs in a new costume: a permanent row saying "nothing to do".
//
// The counts come from `GET /api/folios/counts` — real `COUNT(*)` over the WHOLE organization, not
// over the loaded window. That is what lets a pill promise a number the filtered list delivers.

interface PendingWorkItem {
  facet: FacetKey
  count: number
  /** Singular / plural — a pill reading "1 Reembolsos" is a small lie that reads as sloppiness. */
  label: (n: number) => string
}

interface PendingWorkBarProps {
  counts: FolioCounts | undefined
  active: FacetKey[]
  onToggle: (key: FacetKey) => void
}

export function PendingWorkBar({ counts, active, onToggle }: PendingWorkBarProps) {
  if (!counts) return null

  const items: PendingWorkItem[] = ([
    // Order matters and matches the button ladder (D12): the work that blocks other work first.
    { facet: 'por_verificar', count: counts.verification, label: () => 'Por verificar' },
    {
      facet: 'solicitud',
      count: counts.cancellation_requests,
      label: (n: number) => (n === 1 ? 'Solicitud' : 'Solicitudes'),
    },
    {
      facet: 'reembolso',
      count: counts.refunds,
      label: (n: number) => (n === 1 ? 'Reembolso' : 'Reembolsos'),
    },
    {
      facet: 'vencido',
      count: counts.overdue,
      label: (n: number) => (n === 1 ? 'Vencido' : 'Vencidos'),
    },
    { facet: 'sin_enviar', count: counts.undelivered, label: () => 'Sin entregar' },
  ] as PendingWorkItem[]).filter((i) => i.count > 0)

  if (items.length === 0) return null

  return (
    <FilterStrip sx={{ mb: 2 }}>
      <Stack direction="row" spacing={1} role="group" aria-label="Trabajo pendiente">
        {items.map((item) => (
          <ButtonBase
            key={item.facet}
            onClick={() => onToggle(item.facet)}
            aria-pressed={active.includes(item.facet)}
            sx={filterChipSx(active.includes(item.facet))}
          >
            {item.count} {item.label(item.count)}
          </ButtonBase>
        ))}
      </Stack>
    </FilterStrip>
  )
}
