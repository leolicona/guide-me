import { useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  Collapse,
  Divider,
  Fade,
  Menu,
  MenuItem,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import { FilterPill, FilterStrip, DateRangeSheet } from '../features/filters'
import { useCommissionReport, useExportCommissionReport } from '../features/reports'
import type { CommissionReport, CommissionReportRow, ReportSortKey } from '../features/reports'
import { formatMoney } from '../features/catalog/types'

// YYYY-MM-DD in the UTC reporting model (matches the API).
const utcDay = (d: Date) => d.toISOString().slice(0, 10)

const MONTHS_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const fmtDay = (date: string) => {
  const [, m, day] = date.split('-').map(Number)
  return `${day} ${MONTHS_ABBR[m - 1]}`
}
const rangeLabel = (from: string, to: string) => `${fmtDay(from)} – ${fmtDay(to)}`

// Quick-range presets, computed against the UTC "today". "Este mes" runs from the 1st to today;
// "Mes pasado" spans the whole previous calendar month.
type Preset = { key: string; label: string; from: string; to: string }
function buildPresets(today: string): Preset[] {
  const [y, m] = today.split('-').map(Number)
  return [
    { key: 'this_month', label: 'Este mes', from: utcDay(new Date(Date.UTC(y, m - 1, 1))), to: today },
    {
      key: 'last_month',
      label: 'Mes pasado',
      from: utcDay(new Date(Date.UTC(y, m - 2, 1))),
      to: utcDay(new Date(Date.UTC(y, m - 1, 0))),
    },
  ]
}

const ROLE_LABEL: Record<CommissionReportRow['role'], string> = {
  admin: 'Administrador',
  agent: 'Agente',
  affiliate: 'Afiliado',
}

const SORT_OPTIONS: { key: ReportSortKey; label: string }[] = [
  { key: 'sales_total', label: 'Ventas' },
  { key: 'folios_sold', label: 'Folios' },
  { key: 'commission_earned', label: 'Comisión' },
]

// Settlement direction — the one place color carries meaning. Mirrors the Caja BalanceRow:
// net_owed > 0 → the seller holds the company's cash (neutral ink — the normal state); < 0 →
// the company owes the seller (error red — a liability). Money is never teal (teal = action).
// One shared source so the header and the rows never disagree.
function settlementColor(net: number) {
  if (net === 0) return 'text.secondary'
  return net > 0 ? 'text.primary' : 'error.main'
}
function settlementStatement(net: number) {
  if (net === 0) return 'Cuentas saldadas en el período'
  return net > 0
    ? 'Los vendedores deben efectivo a la empresa'
    : 'La empresa debe a los vendedores'
}

// A signed money figure colored by settlement direction. The leading minus is a real − glyph,
// so the magnitude stays the focal mass and the sign reads as a modifier, not a digit.
function NetMoney({
  value,
  variant = 'body2',
  weight = 700,
}: {
  value: number
  variant?: 'body2' | 'h6' | 'h4'
  weight?: number
}) {
  return (
    <Typography
      component="span"
      variant={variant}
      sx={{
        fontWeight: value === 0 ? 500 : weight,
        color: settlementColor(value),
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: variant === 'h4' ? '-0.02em' : undefined,
      }}
    >
      {value < 0 ? '−' : ''}
      {formatMoney(Math.abs(value))}
    </Typography>
  )
}

// One supporting stat under the hero — tracked label over a tabular value.
function MiniStat({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        variant="caption"
        noWrap
        sx={{
          display: 'block',
          color: 'text.secondary',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 600,
        }}
      >
        {label}
      </Typography>
      <Typography variant="h6" sx={{ mt: 0.25, fontVariantNumeric: 'tabular-nums' }} noWrap>
        {value}
      </Typography>
      {caption && (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
          {caption}
        </Typography>
      )}
    </Box>
  )
}

// US-A17 focal answer — the org rollup with ONE focal point: the net Saldo as a hero, told as a
// sentence, with sales/commission demoted to a supporting pair. Reads identically on phone and
// desktop (it's vertical by nature); the lone colored figure is where the eye lands.
function SettlementHeader({ totals }: { totals: CommissionReport['totals'] }) {
  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Typography
          variant="caption"
          sx={{
            display: 'block',
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontWeight: 600,
          }}
        >
          Saldo del período
        </Typography>
        <Box sx={{ mt: 0.5 }}>
          <NetMoney value={totals.net_owed} variant="h4" />
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {settlementStatement(totals.net_owed)}
        </Typography>

        <Divider sx={{ my: 2 }} />

        <Stack direction="row" spacing={2} divider={<Divider orientation="vertical" flexItem />}>
          <MiniStat
            label="Ventas"
            value={formatMoney(totals.sales_total)}
            caption={`${totals.folios_sold} ${totals.folios_sold === 1 ? 'folio' : 'folios'}`}
          />
          <MiniStat label="Comisión" value={formatMoney(totals.commission_earned)} />
        </Stack>
      </CardContent>
    </Card>
  )
}

// The seller's comparison metrics as a compact inline line. The segment matching the active sort
// key lifts to primary ink, so the control you tapped is reflected in what you scan (US-A18).
function MetricsLine({ s, sortKey }: { s: CommissionReportRow; sortKey: ReportSortKey }) {
  const segments: { key: ReportSortKey; text: string }[] = [
    { key: 'sales_total', text: `Ventas ${formatMoney(s.sales_total)}` },
    { key: 'folios_sold', text: `${s.folios_sold} folios` },
    { key: 'commission_earned', text: `Comisión ${formatMoney(s.commission_earned)}` },
  ]
  return (
    <Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>
      {segments.map((seg, i) => (
        <Box
          key={seg.key}
          component="span"
          sx={{
            color: seg.key === sortKey ? 'text.primary' : 'text.secondary',
            fontWeight: seg.key === sortKey ? 600 : 400,
          }}
        >
          {i > 0 && <Box component="span" sx={{ color: 'text.disabled', mx: 0.5 }}>·</Box>}
          {seg.text}
        </Box>
      ))}
    </Typography>
  )
}

// One labelled line in the disclosure — mirrors the Caja BalanceRow breakdown (label left,
// signed value right) so the settlement arithmetic reads the same wherever it appears.
function BreakdownRow({ label, value, sign }: { label: string; value: number; sign?: '+' | '−' }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {sign && value > 0 ? sign : ''}
        {formatMoney(value)}
      </Typography>
    </Stack>
  )
}

// The full settlement formula for one seller — the SINGLE disclosure shared by the mobile card
// and the desktop expandable row, so "how this Saldo is computed" reads identically everywhere.
// Width-capped so it sits as a tidy block in a full-width table cell, not stretched across it.
function SellerBreakdown({ s }: { s: CommissionReportRow }) {
  return (
    <Box sx={{ maxWidth: 420 }}>
      <Stack spacing={0.75}>
        <BreakdownRow label="Efectivo cobrado" value={s.cash_collected} sign="+" />
        <BreakdownRow label="Electrónico" value={s.electronic_total} />
        <BreakdownRow label="Comisión" value={s.commission_earned} sign="−" />
        <BreakdownRow label="Entregas confirmadas" value={s.confirmed_drops} sign="−" />
        {s.payouts > 0 && <BreakdownRow label="Pagos" value={s.payouts} sign="+" />}
      </Stack>
      <Divider sx={{ my: 1.25 }} />
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Saldo del período
        </Typography>
        <NetMoney value={s.net_owed} />
      </Stack>
    </Box>
  )
}

// Mobile-first seller row (US-A18). Headline always shows identity + the focal Saldo; the
// settlement breakdown folds behind a tap, exactly like the admin's Caja roster. The whole
// headline is the toggle — a full-width 44px+ target.
function SellerCard({ s, sortKey }: { s: CommissionReportRow; sortKey: ReportSortKey }) {
  const [open, setOpen] = useState(false)
  return (
    <Card variant="outlined" sx={{ overflow: 'hidden' }}>
      <CardActionArea onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <CardContent>
          <Stack
            direction="row"
            spacing={1.5}
            sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle1" noWrap sx={{ fontWeight: 600 }}>
                  {s.name}
                </Typography>
                {s.affiliate_company && (
                  <Chip
                    size="small"
                    variant="outlined"
                    color="primary"
                    icon={<StorefrontRounded sx={{ fontSize: 16 }} />}
                    label={s.affiliate_company}
                  />
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {ROLE_LABEL[s.role]}
              </Typography>
              <MetricsLine s={s} sortKey={sortKey} />
            </Box>
            <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center', flexShrink: 0 }}>
              <Box sx={{ textAlign: 'right' }}>
                <Typography
                  variant="caption"
                  sx={{
                    display: 'block',
                    color: 'text.secondary',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    fontWeight: 600,
                  }}
                >
                  Saldo
                </Typography>
                <NetMoney value={s.net_owed} variant="h6" />
              </Box>
              <ExpandMoreRounded
                sx={{
                  color: 'text.disabled',
                  mt: 0.25,
                  transform: open ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.2s ease',
                }}
              />
            </Stack>
          </Stack>
        </CardContent>
      </CardActionArea>
      <Collapse in={open}>
        <Divider />
        <CardContent sx={{ bgcolor: 'action.hover' }}>
          <SellerBreakdown s={s} />
        </CardContent>
      </Collapse>
    </Card>
  )
}

// Right-aligned numeric table cell (desktop). Tier sets weight/color so Ventas leads as the rank
// metric and Folios/Comisión recede; Saldo (its own colored cell) is the settlement answer.
function NumCell({
  children,
  tier = 'muted',
  strong = false,
}: {
  children: ReactNode
  tier?: 'muted' | 'primary'
  strong?: boolean
}) {
  return (
    <TableCell
      align="right"
      sx={{ color: tier === 'primary' ? 'text.primary' : 'text.secondary', fontWeight: strong ? 600 : 400 }}
    >
      {children}
    </TableCell>
  )
}

const TABLE_COLSPAN = 5

// One expandable desktop row — the essential columns scan-aligned; the same SellerBreakdown the
// mobile card uses drops open below on click/Enter/Space. Keyboard-operable (role=button).
function SellerRow({ s }: { s: CommissionReportRow }) {
  const [open, setOpen] = useState(false)
  const toggle = () => setOpen((v) => !v)
  return (
    <>
      <TableRow
        hover
        onClick={toggle}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
        sx={{ cursor: 'pointer', '& > .MuiTableCell-root': { borderBottom: 'unset' } }}
      >
        <TableCell>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <ExpandMoreRounded
              sx={{
                fontSize: 20,
                color: 'text.disabled',
                transform: open ? 'rotate(180deg)' : 'none',
                transition: 'transform 0.2s ease',
              }}
            />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                {s.name}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {ROLE_LABEL[s.role]}
              </Typography>
            </Box>
            {s.affiliate_company && (
              <Chip
                size="small"
                variant="outlined"
                color="primary"
                icon={<StorefrontRounded sx={{ fontSize: 16 }} />}
                label={s.affiliate_company}
              />
            )}
          </Stack>
        </TableCell>
        <NumCell>{s.folios_sold}</NumCell>
        <NumCell tier="primary" strong>
          {formatMoney(s.sales_total)}
        </NumCell>
        <NumCell>{formatMoney(s.commission_earned)}</NumCell>
        <TableCell align="right">
          <NetMoney value={s.net_owed} />
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={TABLE_COLSPAN} sx={{ py: 0 }}>
          <Collapse in={open} unmountOnExit>
            <Box sx={{ bgcolor: 'action.hover', borderRadius: 2, p: 2, my: 1.5 }}>
              <SellerBreakdown s={s} />
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  )
}

// Desktop comparison table (md+). Five essential columns scan cleanly at 960px; the
// cash/electronic/drops/payouts detail lives behind each row's disclosure (US-A18).
function SellerTable({
  sellers,
  totals,
}: {
  sellers: CommissionReportRow[]
  totals: CommissionReport['totals']
}) {
  return (
    <Card variant="outlined" sx={{ overflow: 'hidden' }}>
      <TableContainer>
        <Table
          sx={{
            '& .MuiTableCell-root': { fontVariantNumeric: 'tabular-nums' },
            '& thead .MuiTableCell-root': {
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'text.secondary',
            },
          }}
        >
          <TableHead>
            <TableRow>
              <TableCell>Vendedor</TableCell>
              <TableCell align="right">Folios</TableCell>
              <TableCell align="right">Ventas</TableCell>
              <TableCell align="right">Comisión</TableCell>
              <TableCell align="right">Saldo</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sellers.map((s) => (
              <SellerRow key={s.seller_id} s={s} />
            ))}
          </TableBody>
          <TableFooter>
            <TableRow
              sx={{
                '& .MuiTableCell-root': {
                  color: 'text.primary',
                  fontWeight: 700,
                  fontSize: 13,
                  borderTop: '1px solid',
                  borderColor: 'divider',
                  borderBottom: 'none',
                },
              }}
            >
              <TableCell>Totales</TableCell>
              <TableCell align="right">{totals.folios_sold}</TableCell>
              <TableCell align="right">{formatMoney(totals.sales_total)}</TableCell>
              <TableCell align="right">{formatMoney(totals.commission_earned)}</TableCell>
              <TableCell align="right">
                <NetMoney value={totals.net_owed} />
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </TableContainer>
      <Box sx={{ px: 3, py: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
        <Typography variant="caption" color="text.secondary">
          Abre una fila para ver el desglose. Saldo = efectivo cobrado − comisión − entregas
          confirmadas + pagos. Positivo: el vendedor debe efectivo a la empresa; negativo: la
          empresa le debe.
        </Typography>
      </Box>
    </Card>
  )
}

// Layout-shaped loading placeholder (settlement strip + a few rows), replacing a bare spinner so
// the page keeps its silhouette while the report resolves.
function ReportSkeleton() {
  return (
    <>
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Skeleton variant="text" width={120} sx={{ fontSize: 12 }} />
          <Skeleton variant="text" width={180} sx={{ fontSize: 34 }} />
          <Skeleton variant="text" width={240} sx={{ fontSize: 14 }} />
          <Divider sx={{ my: 2 }} />
          <Stack direction="row" spacing={2}>
            <Skeleton variant="rounded" width="45%" height={40} />
            <Skeleton variant="rounded" width="45%" height={40} />
          </Stack>
        </CardContent>
      </Card>
      <Stack spacing={2}>
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={2} sx={{ justifyContent: 'space-between' }}>
                <Box sx={{ flexGrow: 1 }}>
                  <Skeleton variant="text" width="45%" sx={{ fontSize: 18 }} />
                  <Skeleton variant="text" width="65%" sx={{ fontSize: 12 }} />
                </Box>
                <Skeleton variant="rounded" width={88} height={28} />
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </>
  )
}

export default function ReportsPage() {
  const theme = useTheme()
  // Five essential columns fit comfortably from md up, so tablets get the aligned comparison
  // table; phones get the card list. Both share the same per-seller disclosure.
  const showTable = useMediaQuery(theme.breakpoints.up('md'))
  const today = utcDay(new Date())
  const presets = useMemo(() => buildPresets(today), [today])
  const [from, setFrom] = useState(presets[0].from)
  const [to, setTo] = useState(today)
  const [sortKey, setSortKey] = useState<ReportSortKey>('sales_total')
  const [exportAnchor, setExportAnchor] = useState<null | HTMLElement>(null)
  const [rangeSheetOpen, setRangeSheetOpen] = useState(false)

  // The active preset (highlighted chip), or null when the range is custom — which lights the
  // calendar pill instead, mirroring the POS "off-strip selection" behaviour.
  const activePreset = presets.find((p) => p.from === from && p.to === to)?.key ?? null

  const params = useMemo(() => ({ from, to }), [from, to])
  const rangeValid = Boolean(from && to && from <= to)
  const { data: report, isLoading, isError } = useCommissionReport(params, rangeValid)
  const exportCsv = useExportCommissionReport()

  // US-A18 — client-side ranking. The server returns sales-desc; re-sort on the chosen key.
  const sellers = useMemo(() => {
    if (!report) return []
    return [...report.sellers].sort((a, b) => b[sortKey] - a[sortKey])
  }, [report, sortKey])

  const t = report?.totals
  const hasRows = Boolean(report && sellers.length > 0)

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 960, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 0.5 }}>
          Reportes
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: 3, maxWidth: 560, textWrap: 'pretty' }}
        >
          Comisiones y liquidación por período. Las cifras son del rango seleccionado — distintas
          del saldo en vivo de Caja.
        </Typography>

        {/* Filters — POS-style pills: a date-range strip (presets + a calendar pill that opens
            the range sheet) above a sort-chip row with the export action. Hidden from print. */}
        <Box sx={{ mb: 3, '@media print': { display: 'none' } }}>
          <FilterStrip>
            {presets.map((p) => (
              <FilterPill
                key={p.key}
                variant="date"
                active={activePreset === p.key}
                onClick={() => {
                  setFrom(p.from)
                  setTo(p.to)
                }}
              >
                {p.label}
              </FilterPill>
            ))}
            <FilterPill
              variant="date"
              active={activePreset === null}
              startIcon={<CalendarMonthRounded sx={{ fontSize: 20 }} />}
              onClick={() => setRangeSheetOpen(true)}
              aria-label="Elegir rango de fechas"
            >
              {rangeLabel(from, to)}
            </FilterPill>
          </FilterStrip>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, flexGrow: 1 }}>
              {SORT_OPTIONS.map((o) => (
                <FilterPill
                  key={o.key}
                  variant="chip"
                  active={sortKey === o.key}
                  onClick={() => setSortKey(o.key)}
                >
                  {o.label}
                </FilterPill>
              ))}
            </Box>
            {/* Label collapses to an icon-only 44px target on phones; reappears at sm+. */}
            <Button
              variant="outlined"
              startIcon={<DownloadRounded />}
              disabled={!hasRows}
              onClick={(e) => setExportAnchor(e.currentTarget)}
              aria-label="Exportar"
              sx={{
                flexShrink: 0,
                minWidth: { xs: 44, sm: 'auto' },
                px: { xs: 0, sm: 2 },
                '& .MuiButton-startIcon': {
                  mr: { xs: 0, sm: 1 },
                  ml: { xs: 0, sm: -0.5 },
                },
              }}
            >
              <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                Exportar
              </Box>
            </Button>
          </Box>
        </Box>

        <Menu
          anchorEl={exportAnchor}
          open={Boolean(exportAnchor)}
          onClose={() => setExportAnchor(null)}
        >
          <MenuItem
            onClick={() => {
              setExportAnchor(null)
              exportCsv.mutate(params)
            }}
          >
            <DownloadRounded fontSize="small" sx={{ mr: 1.5, color: 'text.secondary' }} />
            CSV
          </MenuItem>
          <MenuItem
            onClick={() => {
              setExportAnchor(null)
              window.print()
            }}
          >
            <PrintRounded fontSize="small" sx={{ mr: 1.5, color: 'text.secondary' }} />
            Imprimir / PDF
          </MenuItem>
        </Menu>

        {!rangeValid && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            La fecha «Desde» debe ser anterior o igual a «Hasta».
          </Alert>
        )}
        {exportCsv.isError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            No se pudo exportar el reporte. Inténtalo de nuevo.
          </Alert>
        )}

        {isLoading && <ReportSkeleton />}
        {isError && (
          <Alert severity="error">No se pudo cargar el reporte. Inténtalo de nuevo.</Alert>
        )}

        {report && sellers.length === 0 && !isLoading && (
          <Card variant="outlined">
            <CardContent sx={{ py: 6, textAlign: 'center' }}>
              <Typography color="text.secondary">Sin ventas en este período.</Typography>
            </CardContent>
          </Card>
        )}

        {hasRows && t && (
          <>
            <SettlementHeader totals={t} />
            {showTable ? (
              <SellerTable sellers={sellers} totals={t} />
            ) : (
              <Stack spacing={2}>
                {sellers.map((s) => (
                  <SellerCard key={s.seller_id} s={s} sortKey={sortKey} />
                ))}
              </Stack>
            )}
          </>
        )}

        <DateRangeSheet
          open={rangeSheetOpen}
          onClose={() => setRangeSheetOpen(false)}
          from={from}
          to={to}
          maxDate={today}
          onApply={(f, t) => {
            setFrom(f)
            setTo(t)
            setRangeSheetOpen(false)
          }}
        />
      </Box>
    </Fade>
  )
}
