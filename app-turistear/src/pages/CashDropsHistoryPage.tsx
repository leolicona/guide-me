import { useMemo, useState } from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import { Alert, Box, Button, CircularProgress, Fade, Stack, Typography } from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import TuneRounded from '@mui/icons-material/TuneRounded'
import { useDrops } from '../features/cash/hooks'
import { DropCard } from '../features/cash/components/DropCard'
import { FilterStrip, FilterPill, BottomSheet } from '../features/filters'
import { ROUTES } from '../config/routes'
import type { CashDrop } from '../features/cash/types'
import { StatusChip } from '../components'

// US-A98 (docs/cash-drops/caja-surface-parity.spec.md D15) — the drop HISTORY.
//
// This was the *Entregas* tab, the third of three stacked tab rows on /cash, filtered by an
// EXCLUSIVE five-value `ToggleButtonGroup` whose fourth value clipped at 375px and whose state
// lived in `useState`, so it was lost on every return from a drop detail. Confirmed and rejected
// hand-ins are AUDIT, not daily work — what needs a human is now the top of the team's caja — so
// this is a route of its own, with the facet grammar the folio list already uses: a pill, a sheet,
// multi-select, state in the URL.
//
// The multi-select is resolved CLIENT-SIDE over `status: 'all'`. `GET /api/cash/drops` takes one
// status, and this epic's scope boundary forbids touching the server; the read is bounded by the
// `LIMIT 500` D12′ puts on it, which is the same reason the seller's folio list searches locally.

type Facet = 'pending' | 'confirmed' | 'rejected' | 'disputed'

const FACETS: { value: Facet; label: string }[] = [
  { value: 'pending', label: 'Pendientes' },
  { value: 'confirmed', label: 'Confirmadas' },
  { value: 'rejected', label: 'Rechazadas' },
  { value: 'disputed', label: 'En disputa' },
]

const LABEL: Record<Facet, string> = Object.fromEntries(
  FACETS.map((f) => [f.value, f.label]),
) as Record<Facet, string>

// `disputed` is not a status — it is an acknowledgment that lives ON an already-confirmed drop, so
// it has to be matched separately or a confirmed dispute would answer to two facets at once.
const matches = (drop: CashDrop, facet: Facet) =>
  facet === 'disputed' ? drop.acknowledgment === 'disputed' : drop.status === facet

const pillLabel = (active: Facet[]) => {
  if (active.length === 0) return 'Todas las entregas'
  if (active.length === 1) return LABEL[active[0]]
  return `${active.length} estados`
}

export default function CashDropsHistoryPage() {
  const [params, setParams] = useSearchParams()
  const [sheetOpen, setSheetOpen] = useState(false)

  // The URL is the state, so a round-trip through a drop detail comes back to the same view.
  const active = useMemo(
    () => (params.get('estado') ?? '').split(',').filter(Boolean) as Facet[],
    [params],
  )

  const setActive = (next: Facet[]) => {
    const p = new URLSearchParams(params)
    if (next.length) p.set('estado', next.join(','))
    else p.delete('estado')
    setParams(p, { replace: true })
  }

  const toggle = (facet: Facet) =>
    setActive(active.includes(facet) ? active.filter((f) => f !== facet) : [...active, facet])

  const { data: page, isLoading, isError } = useDrops({ status: 'all' })
  const drops = page?.drops

  const shown = useMemo(
    () => (drops ?? []).filter((d) => active.length === 0 || active.some((f) => matches(d, f))),
    [drops, active],
  )

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Button
          component={RouterLink}
          to={ROUTES.CASH}
          startIcon={<ArrowBackRounded />}
          sx={{ mb: 1, ml: -1 }}
          color="inherit"
        >
          Caja del equipo
        </Button>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Entregas
        </Typography>

        <FilterStrip sx={{ mb: 3 }}>
          <FilterPill
            active={active.length > 0}
            onClick={() => setSheetOpen(true)}
            startIcon={<TuneRounded fontSize="small" sx={{ mr: 0.5 }} />}
          >
            {pillLabel(active)}
          </FilterPill>
        </FilterStrip>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && (
          <Alert severity="error">No se pudieron cargar las entregas. Inténtalo de nuevo.</Alert>
        )}

        {drops && shown.length === 0 && (
          <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
            {/* Name what emptied the list. «No hay entregas» when a filter is the reason is the
                sentence US-A83 D15 retired one screen over. */}
            <Typography color="textSecondary">
              {active.length > 0
                ? `Ninguna entrega está en ${active.map((f) => LABEL[f].toLowerCase()).join(' o ')}.`
                : 'Todavía no hay entregas registradas.'}
            </Typography>
            {active.length > 0 && (
              <Button size="small" onClick={() => setActive([])}>
                Quitar filtros
              </Button>
            )}
          </Stack>
        )}

        {shown.length > 0 && (
          <Stack spacing={2}>
            {shown.map((drop) => (
              <DropCard key={drop.id} drop={drop} />
            ))}
            {/* D12′ — say it, rather than imply a whole. The read is capped at 500. */}
            {page?.truncated && (
              <Typography variant="body2" color="textSecondary" sx={{ textAlign: 'center' }}>
                Mostrando las 500 entregas más recientes.
              </Typography>
            )}
          </Stack>
        )}

        <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Estado">
          <Stack spacing={1} sx={{ pb: 2 }}>
            {FACETS.map((f) => (
              <Button
                key={f.value}
                onClick={() => toggle(f.value)}
                aria-pressed={active.includes(f.value)}
                sx={{ justifyContent: 'space-between' }}
                color="inherit"
              >
                {f.label}
                {active.includes(f.value) && <StatusChip tone="success" label="Activo" />}
              </Button>
            ))}
            {active.length > 0 && (
              <Button onClick={() => setActive([])} color="inherit">
                Quitar filtros
              </Button>
            )}
          </Stack>
        </BottomSheet>
      </Box>
    </Fade>
  )
}
