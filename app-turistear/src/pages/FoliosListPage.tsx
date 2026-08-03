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
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import {
  useFolios,
  useFolioCounts,
  useDebouncedValue,
  FolioCard,
  FolioSearchField,
  FolioStateSheet,
  PendingWorkBar,
  useFolioSoldAt,
  useNowSeconds,
  facetPillLabel,
  facetLabels,
  matchesFacets,
  parseFacets,
  serializeFacets,
  matchesQuery,
  normalize,
  orgDay,
  rangeLabel,
  shiftDay,
  MIN_QUERY_LENGTH,
  type FacetKey,
} from '../features/folios'
import { FilterStrip, FilterPill, DateRangeSheet } from '../features/filters'
import { useMyOrganization } from '../features/organization'
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

// US-A83 D9 — two presets, both resolved against the ORGANIZATION's today. Deliberately just two:
// anything longer is a range, and the calendar says it better than a chip named after it.
const DAY_PRESETS: { key: string; label: string; day: (today: string) => string }[] = [
  { key: 'today', label: 'Hoy', day: (t) => t },
  { key: 'yesterday', label: 'Ayer', day: (t) => shiftDay(t, -1) },
]

/** Only for the sentence that states the window; the number itself comes from the server. */
const DEFAULT_WINDOW_LABEL = 30

export default function FoliosListPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const soldAt = useFolioSoldAt()
  const now = useNowSeconds()
  const { data: org } = useMyOrganization()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [rangeOpen, setRangeOpen] = useState(false)

  // The URL IS the state, derived every render — never seeded into `useState`. Q9 of
  // `pending-work-queues.spec.md` cost a release to find: React Router keeps this component MOUNTED
  // when only the query string changes, so an initializer runs once and the copy then drifts from
  // the address bar. One address, one screen. US-A83 D14 puts `q`/`desde`/`hasta` under the same
  // rule rather than inventing a second one.
  const active = parseFacets(searchParams.get('estado'))
  const query = searchParams.get('q') ?? ''
  const from = searchParams.get('desde') ?? ''
  const to = searchParams.get('hasta') ?? ''
  const normalized = normalize(query)
  const hasQuery = normalized.length >= MIN_QUERY_LENGTH
  const hasRange = !!(from && to)
  // `useNowSeconds` resolves in an EFFECT, so on the first render there is no "today" at all.
  // Falling back to the viewer's clock would make `[Hoy]` mean two different days in one session —
  // so the presets simply do not render until the org's clock is known. Guarding this is not
  // theoretical: computing `shiftDay('')` crashed the whole page on first paint.
  const today = now !== null ? orgDay(now, org?.timezone) : null
  const presetDays = today ? DAY_PRESETS.map((p) => ({ ...p, value: p.day(today) })) : []
  const isPresetRange = hasRange && from === to && presetDays.some((p) => p.value === from)

  // D17 — redirect the old tab links, with `replace` so the URL self-heals instead of leaving a
  // dead parameter in history for the back button to walk through.
  const legacyTab = searchParams.get('tab')
  useEffect(() => {
    if (!legacyTab) return
    const facet = LEGACY_TABS[legacyTab]
    setSearchParams(facet ? { estado: facet } : {}, { replace: true })
  }, [legacyTab, setSearchParams])

  // One writer for the whole URL, so a partial update can never drop a filter it did not mean to.
  const setUrl = (next: { estado?: FacetKey[]; q?: string; desde?: string; hasta?: string }) => {
    const estado = serializeFacets(next.estado ?? active)
    const params: Record<string, string> = {}
    if (estado) params.estado = estado
    const q = next.q ?? query
    if (q) params.q = q
    const desde = next.desde ?? from
    const hasta = next.hasta ?? to
    if (desde && hasta) {
      params.desde = desde
      params.hasta = hasta
    }
    // `replace` so toggling a filter does not stack a history entry per tap.
    setSearchParams(params, { replace: true })
  }

  const toggleFacet = (key: FacetKey) =>
    setUrl({
      estado: active.includes(key) ? active.filter((k) => k !== key) : [...active, key],
    })

  // D13 — a pending-work pill CLEARS the query and the range. The banner's one promise is that its
  // count equals what its pill shows (US-A84 S-4); intersecting it with a leftover query would
  // break that silently, and "2 Reembolsos" leading to one row is worse than no banner.
  const toggleWorkFacet = (key: FacetKey) =>
    setUrl({
      estado: active.includes(key) ? active.filter((k) => k !== key) : [...active, key],
      q: '',
      desde: '',
      hasta: '',
    })

  const { data, isLoading, isError } = useFolios(
    hasRange ? { from, to } : {},
  )
  const { data: counts } = useFolioCounts()

  const local = data?.folios.filter(
    (f) => matchesFacets(f, active) && matchesQuery(f, normalized),
  )

  // D4 — when the local pass finds nothing, ask the server over the WHOLE history. The window
  // bounds the default read; it must not bound what is findable. Debounced because this one
  // crosses the network — the local pass, which does not, is deliberately not.
  const debounced = useDebouncedValue(normalized, 350)
  const fallbackEnabled = hasQuery && local?.length === 0 && debounced === normalized
  const { data: fallback, isFetching: fallbackLoading } = useFolios(
    { q: debounced, ...(hasRange ? { from, to } : {}) },
    fallbackEnabled,
  )

  const usingFallback = fallbackEnabled && !!fallback
  const folios = usingFallback
    ? fallback.folios.filter((f) => matchesFacets(f, active))
    : local

  // D15 — every filter that could have emptied the list, named. The facets alone were enough while
  // they were the only filter; with three axes, naming one and hiding two makes the user remove the
  // wrong one.
  const activeFilterLabels = [
    ...(hasQuery ? [`«${query.trim()}»`] : []),
    ...facetLabels(active),
    ...(hasRange ? [rangeLabel(from, to)] : []),
  ]

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Ventas
        </Typography>

        <PendingWorkBar counts={counts} active={active} onToggle={toggleWorkFacet} />

        {/* D1 — fixed, never behind a magnifier tap. It is the reported pain. */}
        <FolioSearchField value={query} onChange={(q) => setUrl({ q })} />

        <FilterStrip sx={{ mb: 3 }}>
          <FilterPill
            active={active.length > 0}
            onClick={() => setSheetOpen(true)}
            startIcon={<TuneRounded fontSize="small" sx={{ mr: 0.5 }} />}
          >
            {facetPillLabel(active)}
          </FilterPill>
          {/* D9 — resolved in the ORGANIZATION's zone. Reportes computes its presets against the
              UTC day, which is the same defect as the old `?date=`; this screen does not inherit
              it, because "hoy" has to mean the counter's today. */}
          {presetDays.map((preset) => {
            const on = from === preset.value && to === preset.value
            return (
              <FilterPill
                key={preset.key}
                variant="date"
                active={on}
                // Tapping the active preset turns it OFF. A date filter with no way back to "all"
                // except opening a calendar is a filter users leave on by accident.
                onClick={() =>
                  setUrl(on ? { desde: '', hasta: '' } : { desde: preset.value, hasta: preset.value })
                }
              >
                {preset.label}
              </FilterPill>
            )
          })}
          <FilterPill
            variant="date"
            active={hasRange && !isPresetRange}
            startIcon={<CalendarMonthRounded sx={{ fontSize: 20, mr: 0.5 }} />}
            onClick={() => setRangeOpen(true)}
            aria-label="Elegir rango de fechas"
          >
            {hasRange && !isPresetRange ? rangeLabel(from, to) : 'Rango'}
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

        {/* D4 — the fallback is in flight: the local pass found nothing and the server is being
            asked over the whole history. Saying so beats an empty list that looks like an answer. */}
        {fallbackLoading && folios?.length === 0 && (
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', py: 4 }}>
            <CircularProgress size={20} />
            <Typography color="text.secondary">Buscando en todo el historial…</Typography>
          </Stack>
        )}

        {/* D5 — results from beyond the window say so. Without this the same screen would show
            "everything recent" and "everything ever" with no way to tell which. */}
        {usingFallback && folios && folios.length > 0 && (
          <Alert severity="info" icon={false} sx={{ mb: 2 }}>
            Resultados de todo el historial, no solo de los últimos {DEFAULT_WINDOW_LABEL} días.
            {fallback?.truncated ? ' Se muestran los 50 más recientes.' : ''}
          </Alert>
        )}

        {folios && folios.length === 0 && !fallbackLoading && (
          <Stack spacing={1} sx={{ py: 4 }}>
            {/* D15 — an empty list must NAME every filter that emptied it, or the user removes the
                wrong one, and a list emptied by a stale query reads as "there are no sales". */}
            <Typography color="text.secondary">
              {activeFilterLabels.length > 0
                ? `Sin resultados para ${activeFilterLabels.join(' · ')}.`
                : 'No hay folios para mostrar.'}
            </Typography>
            {activeFilterLabels.length > 0 && (
              <Typography
                component="button"
                onClick={() => setUrl({ estado: [], q: '', desde: '', hasta: '' })}
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
        {/* …and it must STOP saying it once the list left the window. Reading `data.window_days`
            alone described the base read, not the rows on screen: with the fallback showing history
            the footer still claimed "últimos 30 días" directly under a banner saying the opposite —
            two statements about scope, contradicting each other on one screen. Found by looking. */}
        {folios && folios.length > 0 && !usingFallback && !hasRange && data?.window_days != null && (
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
          onClear={() => setUrl({ estado: [] })}
        />

        {/* D8 — the same range picker Reportes and the schedules strip already use. A third date UI
            would be a third thing to keep consistent. */}
        {today && (
          <DateRangeSheet
            open={rangeOpen}
            onClose={() => setRangeOpen(false)}
            from={from || today}
            to={to || today}
            maxDate={today}
            onApply={(f, t) => {
              setUrl({ desde: f, hasta: t })
              setRangeOpen(false)
            }}
          />
        )}
      </Box>
    </Fade>
  )
}
