import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Box,
  Typography,
  CircularProgress,
  Alert,
  Fade,
  Stack,
} from '@mui/material'
import TuneRounded from '@mui/icons-material/TuneRounded'
import {
  useFolios,
  useFolioCounts,
  FolioCard,
  FolioStateSheet,
  PendingWorkBar,
  useFolioSoldAt,
  useNowSeconds,
  facetPillLabel,
  facetLabels,
  matchesFacets,
  parseFacets,
  serializeFacets,
  type FacetKey,
} from '../features/folios'
import { FilterStrip, FilterPill } from '../features/filters'
import { ROUTES } from '../config/routes'

// US-A84 (docs/oversight/folio-lifecycle-unification.spec.md) — ONE list.
//
// Five tabs used to live here. Four of them were `GET /api/folios` with a different `WHERE`
// (`handler.ts:258-293`) and the fifth read a different table whose only actionable state belongs
// on the folio it is about. Presenting them as destinations taught the user that a folio is five
// kinds of thing; a tab is a claim that its contents are a different OBJECT, and these were the
// same object at a different MOMENT — which is what a filter is for.
//
// What replaced them:
//   • a pending-work bar that APPLIES a facet instead of navigating (D5/D6)
//   • one Estado sheet with three sections, multi-select, AND between sections (D3)
//   • the URL as the state, one comma-separated `?estado=` key (D4)
//
// Filtering is client-side over the payload of one read. That is only honest because the server
// returns a UNION — all pending work at any age, plus the last N days (D8) — so a facet computed
// here answers about the organization and not merely about the rows that happened to load.

// D17 — the queues used to be reachable as `?tab=`, and `Hoy` still links that way in the wild.
const LEGACY_TABS: Record<string, FacetKey> = {
  verify: 'por_verificar',
  requests: 'solicitud',
  refunds: 'reembolso',
  overdue: 'vencido',
}

export default function FoliosListPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const soldAt = useFolioSoldAt()
  const now = useNowSeconds()
  const [sheetOpen, setSheetOpen] = useState(false)

  // The URL IS the state, derived every render — never seeded into `useState`. Q9 of
  // `pending-work-queues.spec.md` cost a release to find: React Router keeps this component MOUNTED
  // when only the query string changes, so an initializer runs once and the copy then drifts from
  // the address bar. One address, one screen.
  const active = parseFacets(searchParams.get('estado'))

  // D17 — redirect the old tab links, with `replace` so the URL self-heals instead of leaving a
  // dead parameter in history for the back button to walk through.
  const legacyTab = searchParams.get('tab')
  useEffect(() => {
    if (!legacyTab) return
    const facet = LEGACY_TABS[legacyTab]
    setSearchParams(facet ? { estado: facet } : {}, { replace: true })
  }, [legacyTab, setSearchParams])

  const setFacets = (next: FacetKey[]) => {
    const value = serializeFacets(next)
    // `replace` so toggling a filter does not stack a history entry per tap.
    setSearchParams(value ? { estado: value } : {}, { replace: true })
  }
  const toggleFacet = (key: FacetKey) =>
    setFacets(active.includes(key) ? active.filter((k) => k !== key) : [...active, key])

  const { data, isLoading, isError } = useFolios()
  const { data: counts } = useFolioCounts()

  const folios = data?.folios.filter((f) => matchesFacets(f, active))

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Ventas
        </Typography>

        <PendingWorkBar counts={counts} active={active} onToggle={toggleFacet} />

        <FilterStrip sx={{ mb: 3 }}>
          <FilterPill
            active={active.length > 0}
            onClick={() => setSheetOpen(true)}
            startIcon={<TuneRounded fontSize="small" sx={{ mr: 0.5 }} />}
          >
            {facetPillLabel(active)}
          </FilterPill>
        </FilterStrip>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && (
          <Alert severity="error">No se pudieron cargar los folios. Inténtalo de nuevo.</Alert>
        )}

        {folios && folios.length === 0 && (
          <Stack spacing={1} sx={{ py: 4 }}>
            {/* An empty list must NAME what it filtered by, or it reads as "there are no sales". */}
            <Typography color="text.secondary">
              {active.length > 0
                ? `No hay folios en ${facetLabels(active).join(' · ')}.`
                : 'No hay folios para mostrar.'}
            </Typography>
            {active.length > 0 && (
              <Typography
                component="button"
                onClick={() => setFacets([])}
                sx={{
                  border: 'none',
                  background: 'none',
                  p: 0,
                  font: 'inherit',
                  color: 'primary.main',
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: 'fit-content',
                }}
              >
                Quitar filtros
              </Typography>
            )}
          </Stack>
        )}

        {folios && folios.length > 0 && (
          <Stack spacing={2}>
            {/* US-A82 — one shared card (D13). The admin byline names the AGENT: this is the
                reconciliation the admin does. */}
            {folios.map((f) => (
              <FolioCard
                key={f.id}
                folio={f}
                to={ROUTES.FOLIO_DETAIL.replace(':id', f.id)}
                byline={f.agent.name}
                soldAt={soldAt(f.created_at)}
                nowSeconds={now}
                surface="admin"
              />
            ))}
          </Stack>
        )}

        {/* D9 — the list is a WINDOW plus all pending work, and it says so. A screen that shows a
            subset while implying completeness is how "I can't find last year's sale" becomes a bug
            report about search. */}
        {folios && folios.length > 0 && data?.window_days != null && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', textAlign: 'center', mt: 3 }}
          >
            Últimos {data.window_days} días, más todo lo que tiene trabajo pendiente.
          </Typography>
        )}

        <FolioStateSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          active={active}
          onToggle={toggleFacet}
          onClear={() => setFacets([])}
        />
      </Box>
    </Fade>
  )
}
