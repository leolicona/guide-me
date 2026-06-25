import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Fade,
  Menu,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import PrintRounded from '@mui/icons-material/PrintRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import { useCommissionReport, useExportCommissionReport } from '../features/reports'
import type { CommissionReportRow, ReportSortKey } from '../features/reports'
import { formatMoney } from '../features/catalog/types'

// Today / first-of-month as YYYY-MM-DD in the UTC reporting model (matches the API).
const utcDay = (d: Date) => d.toISOString().slice(0, 10)
const firstOfMonth = () => {
  const now = new Date()
  return utcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)))
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

// net_owed > 0 → the seller owes the company (a positive cash debt, like a Caja balance);
// < 0 → the company owes the seller. Color matches the Caja convention.
function NetOwed({ value }: { value: number }) {
  if (value === 0) return <span>{formatMoney(0)}</span>
  const owesCompany = value > 0
  return (
    <Typography
      component="span"
      variant="body2"
      sx={{ fontWeight: 600, color: owesCompany ? 'secondary.main' : 'error.main' }}
    >
      {owesCompany ? '' : '−'}
      {formatMoney(Math.abs(value))}
    </Typography>
  )
}

export default function ReportsPage() {
  const [from, setFrom] = useState(firstOfMonth)
  const [to, setTo] = useState(() => utcDay(new Date()))
  const [sortKey, setSortKey] = useState<ReportSortKey>('sales_total')
  const [exportAnchor, setExportAnchor] = useState<null | HTMLElement>(null)

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

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 960, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 0.5 }}>
          Reportes
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
          Comisiones y liquidación por período. Las cifras son del rango seleccionado — distintas
          del saldo en vivo de Caja.
        </Typography>

        {/* Controls — range, sort, export. Hidden from print. */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ mb: 3, alignItems: { sm: 'flex-end' }, '@media print': { display: 'none' } }}
        >
          <TextField
            label="Desde"
            type="date"
            size="small"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <TextField
            label="Hasta"
            type="date"
            size="small"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Box sx={{ flexGrow: 1 }} />
          <ToggleButtonGroup
            size="small"
            exclusive
            value={sortKey}
            onChange={(_, v) => v && setSortKey(v)}
          >
            {SORT_OPTIONS.map((o) => (
              <ToggleButton key={o.key} value={o.key}>
                {o.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Button
            variant="outlined"
            size="medium"
            startIcon={<DownloadRounded />}
            disabled={!rangeValid || !report || report.sellers.length === 0}
            onClick={(e) => setExportAnchor(e.currentTarget)}
          >
            Exportar
          </Button>
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
        </Stack>

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

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && (
          <Alert severity="error">No se pudo cargar el reporte. Inténtalo de nuevo.</Alert>
        )}

        {report && report.sellers.length === 0 && !isLoading && (
          <Typography color="text.secondary" sx={{ py: 4 }}>
            Sin ventas en este período.
          </Typography>
        )}

        {report && sellers.length > 0 && (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Vendedor</TableCell>
                  <TableCell align="right">Folios</TableCell>
                  <TableCell align="right">Ventas</TableCell>
                  <TableCell align="right">Efectivo</TableCell>
                  <TableCell align="right">Electrónico</TableCell>
                  <TableCell align="right">Comisión</TableCell>
                  <TableCell align="right">Entregas</TableCell>
                  <TableCell align="right">Pagos</TableCell>
                  <TableCell align="right">Saldo</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sellers.map((s) => (
                  <TableRow key={s.seller_id} hover>
                    <TableCell>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
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
                            icon={<StorefrontRounded />}
                            label={s.affiliate_company}
                          />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">{s.folios_sold}</TableCell>
                    <TableCell align="right">{formatMoney(s.sales_total)}</TableCell>
                    <TableCell align="right">{formatMoney(s.cash_collected)}</TableCell>
                    <TableCell align="right">{formatMoney(s.electronic_total)}</TableCell>
                    <TableCell align="right">{formatMoney(s.commission_earned)}</TableCell>
                    <TableCell align="right">{formatMoney(s.confirmed_drops)}</TableCell>
                    <TableCell align="right">{formatMoney(s.payouts)}</TableCell>
                    <TableCell align="right">
                      <NetOwed value={s.net_owed} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {t && (
                <TableFooter>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700, color: 'text.primary' }}>Totales</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {t.folios_sold}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {formatMoney(t.sales_total)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {formatMoney(t.cash_collected)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {formatMoney(t.electronic_total)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {formatMoney(t.commission_earned)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {formatMoney(t.confirmed_drops)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {formatMoney(t.payouts)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      <NetOwed value={t.net_owed} />
                    </TableCell>
                  </TableRow>
                </TableFooter>
              )}
            </Table>
            <Divider sx={{ mt: 2 }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              Saldo = efectivo cobrado − comisión − entregas confirmadas + pagos. Positivo: el
              vendedor debe efectivo a la empresa; negativo: la empresa le debe.
            </Typography>
          </TableContainer>
        )}
      </Box>
    </Fade>
  )
}
