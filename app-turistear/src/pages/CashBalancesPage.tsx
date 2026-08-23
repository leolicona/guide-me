import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardActionArea,
  CardContent,
  CircularProgress,
  Alert,
  Collapse,
  Fade,
  Stack,
  Divider,
  Chip,
  Badge,
  Tabs,
  Tab,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import PersonRounded from '@mui/icons-material/Person'
import TrendingDownRounded from '@mui/icons-material/TrendingDown'
import TrendingUpRounded from '@mui/icons-material/TrendingUp'
import {
  useBalances,
  useDrops,
  usePendingDropCount,
  useRegisterCollection,
  useRegisterPayout,
} from '../features/cash/hooks'
import { AckChip } from '../features/cash/components/AckChip'
import { DropStatusChip } from '../features/cash/components/DropStatusChip'
import { BalanceScreen } from '../features/cash/components/BalanceScreen'
import { useOrgDateFormatter } from '../features/organization'
import { SOURCE_LABEL } from '../features/cash/components/ackPresentation'
import { METHOD_LABEL } from '../features/cash/components/paymentPresentation'
import type { BalanceListItem, DropStatus } from '../features/cash/types'
import { formatMoney, amountToCents, centsToAmount } from '../features/catalog/types'
import { ROUTES } from '../config/routes'
import { MoneyText, StatusChip, InfoPopover } from '../components'
import { FilterStrip } from '../features/filters'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// 'disputed' is a pseudo-filter: it queries by acknowledgment (any status) so open disputes
// — which live on already-confirmed drops — surface in one tap.
type DropFilter = DropStatus | 'all' | 'disputed'

// A tabbed region takes its name from the tab that opened it. Without this wiring the panels were
// anonymous: the KPI figures «$2,684.00», «1» and «0» were the ONLY headings on the screen, and
// once they stopped being headings (they are values, not sections) the Equipo panel had no name at
// all. `role="tabpanel"` + `aria-labelledby` is the name, and it costs no visible duplication of a
// label the tab already shows.
const tabA11y = (group: string, index: number) => ({
  id: `${group}-tab-${index}`,
  'aria-controls': `${group}-panel-${index}`,
})

const panelA11y = (group: string, index: number) => ({
  role: 'tabpanel',
  id: `${group}-panel-${index}`,
  'aria-labelledby': `${group}-tab-${index}`,
})

function KpiStat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: 'warning' | 'error'
}) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="caption" color="textSecondary" noWrap>
        {label}
      </Typography>
      {/* `component` because a KPI figure is a VALUE, not a section. The type scale used to pick
          the tag, so «$2,684.00», «1» and «0» were the only headings on this screen and the
          outline read h1 → h6 → h6 → h6 (design review, Must Fix 5). */}
      <Typography
        variant="h6"
        component="p"
        sx={{ fontWeight: 600, color: accent ? `${accent}.main` : 'text.primary' }}
      >
        {value}
      </Typography>
    </Box>
  )
}

// --- Triage header: the at-a-glance state of the company's field cash (US-A19). ---
// One compact stat strip so the admin lands on "how much is out, how much needs me" without
// scanning every card. Cash in field = Σ positive balances (money agents/affiliates hold).
function KpiHeader({ balances }: { balances: BalanceListItem[] }) {
  const { data: disputed } = useDrops({ status: 'all', ack: 'disputed' })
  const cashInField = balances.reduce((n, r) => n + (r.balance > 0 ? r.balance : 0), 0)
  const pending = balances.reduce((n, r) => n + r.pending_drops_count, 0)
  const disputes = disputed?.length ?? 0

  return (
    <Card variant="outlined" sx={{ mb: 3 }}>
      <CardContent>
        <Stack direction="row" spacing={2} divider={<Divider orientation="vertical" flexItem />}>
          <KpiStat label="Efectivo en la calle" value={formatMoney(cashInField)} />
          <KpiStat
            label="Por confirmar"
            value={String(pending)}
            accent={pending > 0 ? 'warning' : undefined}
          />
          <KpiStat
            label="En disputa"
            value={String(disputes)}
            accent={disputes > 0 ? 'error' : undefined}
          />
        </Stack>
      </CardContent>
    </Card>
  )
}

// One labelled line in the shift breakdown. `sign` renders the +/− that ties each component to
// the running-balance formula (mirrors the agent's BalancePage).
function BreakdownRow({
  label,
  value,
  sign,
}: {
  label: string
  value: number
  sign?: '+' | '−'
}) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography variant="body2" color="textSecondary">
        {label}
      </Typography>
      {/* A signed figure cannot be a bare MoneyText, so it takes the `.numeric` utility — the
          design system's other route to tabular figures — and the column still aligns. */}
      <Typography variant="body2" className="numeric">
        {sign === '−' && value > 0 ? '−' : ''}
        {sign === '+' && value > 0 ? '+' : ''}
        {formatMoney(value)}
      </Typography>
    </Stack>
  )
}

// One cash-holder row (US-A19). The headline (name, role, balance, pending badge) and the
// actions stay visible; the reconciliation breakdown + sales split fold behind a disclosure
// so a roster of many agents reads as a clean list — parity with the agent's own CashBoxCard.
function BalanceRow({
  row,
  onCollect,
  onPayout,
}: {
  row: BalanceListItem
  onCollect: (row: BalanceListItem) => void
  onPayout: (row: BalanceListItem) => void
}) {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const [open, setOpen] = useState(false)
  const negative = row.balance < 0
  const isAffiliate = row.role === 'affiliate'

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="subtitle1" noWrap>
                {row.agent.name}
              </Typography>
              {isAffiliate && (
                <Chip
                  size="small"
                  variant="outlined"
                  color="primary"
                  icon={<StorefrontRounded sx={{ fontSize: 16 }} />}
                  label={row.affiliate_company ?? 'Afiliado'}
                />
              )}
            </Stack>
            <Typography variant="caption" color="textSecondary">
              {negative
                ? `La empresa debe ${isAffiliate ? 'al afiliado' : 'al agente'}`
                : 'Tiene efectivo de la empresa'}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            {row.pending_drops_count > 0 && (
              <Badge badgeContent={row.pending_drops_count} color="warning">
                <Chip size="small" variant="outlined" label="pendiente" />
              </Badge>
            )}
            {/* Money is neutral ink (or error red when the company owes them) — never teal. */}
            <MoneyText
              cents={row.balance}
              absolute
              semantic={negative ? 'negative' : 'neutral'}
              variant="h3"
              srLabel={row.agent.name}
            />
          </Stack>
        </Stack>

        <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: 'center' }}>
          {/* US-A27 — face-to-face collection: reduces the balance NOW and sends a signature
              request (non-blocking). */}
          <Button size="small" onClick={() => onCollect(row)}>
            Registrar cobro directo
          </Button>
          {negative && (
            <Button size="small" onClick={() => onPayout(row)}>
              Registrar pago
            </Button>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button
            size="small"
            color="inherit"
            onClick={() => setOpen((v) => !v)}
            endIcon={
              <ExpandMoreRounded
                sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
              />
            }
            sx={{ color: 'text.secondary' }}
          >
            Detalle
          </Button>
        </Stack>

        <Collapse in={open}>
          <Divider sx={{ my: 1.5 }} />
          {/* Shift-scoped breakdown (US-A19) — mirrors the agent's own /me view: a
              carry-forward line plus the components since their last confirmed drop. */}
          <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 1 }}>
            {row.last_drop
              ? `Desde la última entrega · ${formatDate(row.last_drop.created_at)}`
              : 'Toda la actividad'}
          </Typography>
          <Stack spacing={0.5}>
            {row.carry_forward !== 0 && (
              <BreakdownRow
                label="Saldo anterior"
                value={Math.abs(row.carry_forward)}
                sign={row.carry_forward < 0 ? '−' : '+'}
              />
            )}
            <BreakdownRow label="Cobrado" value={row.cash_collected} sign="+" />
            <BreakdownRow label="Comisión" value={row.commission_total} sign="−" />
            {/* Affiliates have no expenses (affiliate-portal D4) — the line is always zero. */}
            {!isAffiliate && (
              <BreakdownRow label="Gastos" value={row.expense_total} sign="−" />
            )}
            {row.payouts_total > 0 && (
              <BreakdownRow label="Pagado" value={row.payouts_total} sign="+" />
            )}
          </Stack>

          {/* US-AG29 (D5) — the same cash-vs-electronic split the agent sees on /me. */}
          <Divider sx={{ my: 1.5 }} />
          <Stack spacing={0.5}>
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography variant="body2" color="textSecondary">
                Ventas del turno · {row.sales.cash_count + row.sales.electronic_count}
              </Typography>
              <Typography variant="body2">{formatMoney(row.sales.total)}</Typography>
            </Stack>
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography variant="caption" color="textSecondary">
                Efectivo {formatMoney(row.sales.cash)} · Electrónico{' '}
                {formatMoney(row.sales.electronic)}
              </Typography>
              <Typography variant="caption" color="textSecondary">
                Comisiones {formatMoney(row.commissions.total)}
                {row.commissions.electronic > 0
                  ? ` (electrónicas ${formatMoney(row.commissions.electronic)})`
                  : ''}
              </Typography>
            </Stack>
            {row.sales.electronic > 0 && (
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                {(['card', 'transfer', 'link'] as const)
                  .filter((m) => row.sales.by_method[m] > 0)
                  .map((m) => (
                    <Chip
                      key={m}
                      size="small"
                      variant="outlined"
                      label={`${METHOD_LABEL[m]} · ${formatMoney(row.sales.by_method[m])}`}
                    />
                  ))}
              </Stack>
            )}
          </Stack>
        </Collapse>
      </CardContent>
    </Card>
  )
}

// --- Balances tab: company cash exposure per agent/affiliate (US-A19) + payouts (US-A25)
//     + direct collections (US-A27) ---
function BalancesTab() {
  const { data: balances, isLoading, isError } = useBalances()
  const payout = useRegisterPayout()
  const collection = useRegisterCollection()
  const [target, setTarget] = useState<BalanceListItem | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [collectTarget, setCollectTarget] = useState<BalanceListItem | null>(null)
  const [collectAmount, setCollectAmount] = useState('')
  const [collectNote, setCollectNote] = useState('')

  // A negative balance means the company owes the agent — offer to pay it back to zero.
  const openPayout = (row: BalanceListItem) => {
    setTarget(row)
    setAmount(String(centsToAmount(Math.abs(row.balance))))
    setNote('')
  }

  const submitPayout = () => {
    const cents = amountToCents(Number(amount))
    if (!target || !Number.isFinite(cents) || cents <= 0) return
    payout.mutate(
      { agent_id: target.agent.id, amount: cents, note: note.trim() || null },
      { onSuccess: () => setTarget(null) },
    )
  }

  // US-A27 — record cash taken from the agent face-to-face. Defaults to their full balance
  // (the common case: settling them to zero on the spot).
  const openCollection = (row: BalanceListItem) => {
    setCollectTarget(row)
    setCollectAmount(row.balance > 0 ? String(centsToAmount(row.balance)) : '')
    setCollectNote('')
  }

  const submitCollection = () => {
    const cents = amountToCents(Number(collectAmount))
    if (!collectTarget || !Number.isFinite(cents) || cents <= 0) return
    collection.mutate(
      { agent_id: collectTarget.agent.id, amount: cents, note: collectNote.trim() || null },
      { onSuccess: () => setCollectTarget(null) },
    )
  }

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    )
  }
  if (isError) {
    return <Alert severity="error">No se pudieron cargar los saldos. Inténtalo de nuevo.</Alert>
  }
  if (!balances || balances.length === 0) {
    return <Typography color="textSecondary">No hay agentes ni afiliados para mostrar.</Typography>
  }

  return (
    <>
      <KpiHeader balances={balances} />
      <Stack spacing={2}>
        {balances.map((row) => (
          <BalanceRow
            key={row.agent.id}
            row={row}
            onCollect={openCollection}
            onPayout={openPayout}
          />
        ))}
      </Stack>

      {/* US-A27 — direct collection dialog */}
      <Dialog open={!!collectTarget} onClose={() => setCollectTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Registrar cobro directo</DialogTitle>
        <DialogContent>
          {/* Structured context: who + effect as icon-paired chips; the signature nuance
              (rarely needed at the moment of collecting) sits one tap away in the popover. */}
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}
          >
            <StatusChip
              tone="neutral"
              icon={<PersonRounded />}
              label={collectTarget?.agent.name ?? ''}
            />
            <StatusChip
              tone="neutral"
              icon={<TrendingDownRounded />}
              label="Reduce su saldo al instante"
            />
            <InfoPopover label="Sobre la firma de conformidad">
              Se le pedirá al agente firmar de conformidad. Si no firma, el cobro se confirma
              automáticamente.
            </InfoPopover>
          </Stack>
          <Stack spacing={2}>
            <TextField
              label="Monto recibido"
              type="number"
              fullWidth
              autoFocus
              value={collectAmount}
              onChange={(e) => setCollectAmount(e.target.value)}
            />
            <TextField
              label="Nota (opcional)"
              fullWidth
              multiline
              minRows={2}
              value={collectNote}
              onChange={(e) => setCollectNote(e.target.value)}
            />
          </Stack>
          {collection.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo registrar el cobro. Inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCollectTarget(null)}>Cancelar</Button>
          <Button
            variant="contained"
            disableElevation
            onClick={submitCollection}
            disabled={collection.isPending || !collectAmount}
          >
            {collection.isPending ? 'Registrando…' : 'Registrar cobro'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!target} onClose={() => setTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Registrar pago</DialogTitle>
        <DialogContent>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 2 }}
          >
            <StatusChip
              tone="neutral"
              icon={<PersonRounded />}
              label={target?.agent.name ?? ''}
            />
            <StatusChip
              tone="neutral"
              icon={<TrendingUpRounded />}
              label="Sube su saldo hacia cero"
            />
          </Stack>
          <Stack spacing={2}>
            <TextField
              label="Monto"
              type="number"
              fullWidth
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <TextField
              label="Nota (opcional)"
              fullWidth
              multiline
              minRows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Stack>
          {payout.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo registrar ese pago. Inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTarget(null)}>Cancelar</Button>
          <Button
            variant="contained"
            disableElevation
            onClick={submitPayout}
            disabled={payout.isPending || !amount}
          >
            {payout.isPending ? 'Registrando…' : 'Registrar pago'}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

// --- Drops tab: the review queue (US-A19) + open disputes (US-A27/A28) ---
function DropsTab() {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const [filter, setFilter] = useState<DropFilter>('pending')
  const { data: drops, isLoading, isError } = useDrops(
    filter === 'disputed' ? { status: 'all', ack: 'disputed' } : { status: filter },
  )

  return (
    <Box>
        {/* BUG-023 — the filter row is wider than a phone. Contained here so the scroll stays
            inside the row instead of dragging the whole page sideways. */}
      <FilterStrip sx={{ mb: 3 }}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={filter}
        onChange={(_, v) => v && setFilter(v)}
      >
        <ToggleButton value="pending">Pendientes</ToggleButton>
        <ToggleButton value="confirmed">Confirmadas</ToggleButton>
        <ToggleButton value="rejected">Rechazadas</ToggleButton>
        <ToggleButton value="disputed">En disputa</ToggleButton>
        <ToggleButton value="all">Todas</ToggleButton>
      </ToggleButtonGroup>
      </FilterStrip>

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}
      {isError && <Alert severity="error">No se pudieron cargar las entregas. Inténtalo de nuevo.</Alert>}

      {drops && drops.length === 0 && (
        <Typography color="textSecondary">No hay entregas para mostrar.</Typography>
      )}

      {drops && drops.length > 0 && (
        <Stack spacing={2}>
          {drops.map((drop) => (
            <Card key={drop.id} variant="outlined">
              <CardActionArea
                component={RouterLink}
                to={ROUTES.CASH_DROP_DETAIL.replace(':id', drop.id)}
              >
                <CardContent>
                  <Stack
                    direction="row"
                    // Same reason as the seller's Entregas row: an icon-paired chip is wider than
                    // the bare colour pill it replaces, so the chip group wraps to its own line
                    // rather than shredding the agent's name at 375px.
                    sx={{
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      rowGap: 1,
                    }}
                  >
                    <Box sx={{ minWidth: 0, flex: '1 1 12rem' }}>
                      <Typography variant="subtitle1">{formatMoney(drop.amount)}</Typography>
                      <Typography variant="caption" color="textSecondary">
                        {drop.agent?.name} · {SOURCE_LABEL[drop.source]} · {formatDate(drop.created_at)}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <AckChip state={drop.acknowledgment} />
                      <DropStatusChip status={drop.status} />
                    </Stack>
                  </Stack>
                  {drop.note && (
                    <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
                      {drop.note}
                    </Typography>
                  )}
                  {drop.acknowledgment === 'disputed' && drop.ack_note && (
                    <Typography variant="body2" color="error" sx={{ mt: 1 }}>
                      Disputa del agente: {drop.ack_note}
                    </Typography>
                  )}
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      )}
    </Box>
  )
}

export default function CashBalancesPage() {
  // Top-level split: the admin's own drawer ("Mi caja") vs. the team ("Equipo"). Mi caja is the
  // default landing — it's the admin's own actionable cash.
  const [section, setSection] = useState(0)
  // Within Equipo: the balances list vs. the drops review queue.
  const [tab, setTab] = useState(0)
  // Pending hand-ins awaiting confirmation — surfaced as a badge on BOTH the top-level Equipo tab
  // (so the admin sees review work while on Mi caja) and the Entregas sub-tab. Shares the cache.
  const { data: pendingCount } = usePendingDropCount(true)
  const pendingBadgeSx = { '& .MuiBadge-badge': { right: -14, top: 2 } }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Caja
        </Typography>

        <Tabs value={section} onChange={(_, v) => setSection(v)} sx={{ mb: 3 }}>
          <Tab label="Mi caja" {...tabA11y('caja', 0)} />
          <Tab
            {...tabA11y('caja', 1)}
            label={
              <Badge color="warning" badgeContent={pendingCount ?? 0} sx={pendingBadgeSx}>
                Equipo
              </Badge>
            }
          />
        </Tabs>

        {section === 0 ? (
          // US-A35 — the admin's own drawer, self-authorized moves. The SAME component the agent
          // and the affiliate read at /balance: `surface="admin"` gates the verbs, never the
          // numbers (caja-surface-parity D1/D4). `TuCajaSection` is gone — once the badge and the
          // shift caption moved into BalanceScreen (D5), it had no content left to hold.
          <Box {...panelA11y('caja', 0)} sx={{ mb: 4 }}>
            <BalanceScreen surface="admin" />
          </Box>
        ) : (
          <Box {...panelA11y('caja', 1)}>
            <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
              <Tab label="Saldos" {...tabA11y('equipo', 0)} />
              <Tab
                {...tabA11y('equipo', 1)}
                label={
                  <Badge color="warning" badgeContent={pendingCount ?? 0} sx={pendingBadgeSx}>
                    Entregas
                  </Badge>
                }
              />
            </Tabs>

            <Box {...panelA11y('equipo', tab)}>
              {tab === 0 ? <BalancesTab /> : <DropsTab />}
            </Box>
          </Box>
        )}
      </Box>
    </Fade>
  )
}
