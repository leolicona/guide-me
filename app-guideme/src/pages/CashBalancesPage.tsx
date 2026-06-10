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
import {
  useBalances,
  useDrops,
  useRegisterCollection,
  useRegisterPayout,
} from '../features/cash/hooks'
import { AckChip } from '../features/cash/components/AckChip'
import { SOURCE_LABEL } from '../features/cash/components/ackPresentation'
import { METHOD_LABEL } from '../features/cash/components/paymentPresentation'
import type { BalanceListItem, DropStatus } from '../features/cash/types'
import { formatMoney, amountToCents, centsToAmount } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const DROP_COLOR: Record<DropStatus, 'warning' | 'success' | 'error'> = {
  pending: 'warning',
  confirmed: 'success',
  rejected: 'error',
}

const DROP_LABEL: Record<DropStatus, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmado',
  rejected: 'Rechazado',
}

const formatDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// 'disputed' is a pseudo-filter: it queries by acknowledgment (any status) so open disputes
// — which live on already-confirmed drops — surface in one tap.
type DropFilter = DropStatus | 'all' | 'disputed'

// --- Balances tab: company cash exposure per agent (US-A19) + payouts (US-A25)
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
    return <Typography color="text.secondary">No hay agentes para mostrar.</Typography>
  }

  return (
    <>
      <Stack spacing={2}>
        {balances.map((row) => {
          const negative = row.balance < 0
          return (
            <Card key={row.agent.id} variant="outlined">
              <CardContent>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" noWrap>
                      {row.agent.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {negative ? 'La empresa debe al agente' : 'Tiene efectivo de la empresa'}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                    {row.pending_drops_count > 0 && (
                      <Badge badgeContent={row.pending_drops_count} color="warning">
                        <Chip size="small" variant="outlined" label="pendiente" />
                      </Badge>
                    )}
                    <Typography
                      variant="h6"
                      sx={{ color: negative ? 'error.main' : 'secondary.main' }}
                    >
                      {formatMoney(Math.abs(row.balance))}
                    </Typography>
                  </Stack>
                </Stack>

                <Divider sx={{ my: 1.5 }} />
                {/* Shift-scoped breakdown (US-A19) — mirrors the agent's own /me view: a
                    carry-forward line plus the components since their last confirmed drop. */}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
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
                  <BreakdownRow label="Gastos" value={row.expense_total} sign="−" />
                  {row.payouts_total > 0 && (
                    <BreakdownRow label="Pagado" value={row.payouts_total} sign="+" />
                  )}
                </Stack>

                {/* US-AG29 (D5) — the same cash-vs-electronic split the agent sees on /me. */}
                <Divider sx={{ my: 1.5 }} />
                <Stack spacing={0.5}>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="body2" color="text.secondary">
                      Ventas del turno · {row.sales.cash_count + row.sales.electronic_count}
                    </Typography>
                    <Typography variant="body2">{formatMoney(row.sales.total)}</Typography>
                  </Stack>
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary">
                      Efectivo {formatMoney(row.sales.cash)} · Electrónico{' '}
                      {formatMoney(row.sales.electronic)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
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

                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  {/* US-A27 — face-to-face collection: reduces the agent's balance NOW and
                      sends them a signature request (non-blocking). */}
                  <Button size="small" onClick={() => openCollection(row)}>
                    Registrar cobro directo
                  </Button>
                  {negative && (
                    <Button size="small" onClick={() => openPayout(row)}>
                      Registrar pago
                    </Button>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )
        })}
      </Stack>

      {/* US-A27 — direct collection dialog */}
      <Dialog open={!!collectTarget} onClose={() => setCollectTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>Registrar cobro directo</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Registra el efectivo que recibiste de {collectTarget?.agent.name} en persona. Su
            saldo se reduce de inmediato y se le pedirá firmar de conformidad (si no firma,
            se confirma automáticamente).
          </Typography>
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
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Págale a {target?.agent.name} lo que la empresa le debe. Esto aumentará su saldo hacia cero.
          </Typography>
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
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2">
        {sign === '−' && value > 0 ? '−' : ''}
        {sign === '+' && value > 0 ? '+' : ''}
        {formatMoney(value)}
      </Typography>
    </Stack>
  )
}

// --- Drops tab: the review queue (US-A19) + open disputes (US-A27/A28) ---
function DropsTab() {
  const [filter, setFilter] = useState<DropFilter>('pending')
  const { data: drops, isLoading, isError } = useDrops(
    filter === 'disputed' ? { status: 'all', ack: 'disputed' } : { status: filter },
  )

  return (
    <Box>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={filter}
        onChange={(_, v) => v && setFilter(v)}
        sx={{ mb: 3 }}
      >
        <ToggleButton value="pending">Pendientes</ToggleButton>
        <ToggleButton value="confirmed">Confirmadas</ToggleButton>
        <ToggleButton value="rejected">Rechazadas</ToggleButton>
        <ToggleButton value="disputed">En disputa</ToggleButton>
        <ToggleButton value="all">Todas</ToggleButton>
      </ToggleButtonGroup>

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}
      {isError && <Alert severity="error">No se pudieron cargar las entregas. Inténtalo de nuevo.</Alert>}

      {drops && drops.length === 0 && (
        <Typography color="text.secondary">No hay entregas para mostrar.</Typography>
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
                  <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle1">{formatMoney(drop.amount)}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {drop.agent?.name} · {SOURCE_LABEL[drop.source]} · {formatDate(drop.created_at)}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <AckChip state={drop.acknowledgment} />
                      <Chip size="small" color={DROP_COLOR[drop.status]} label={DROP_LABEL[drop.status]} />
                    </Stack>
                  </Stack>
                  {drop.note && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
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
  const [tab, setTab] = useState(0)

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 2 }}>
          Cash
        </Typography>

        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 3 }}>
          <Tab label="Saldos" />
          <Tab label="Entregas" />
        </Tabs>

        {tab === 0 ? <BalancesTab /> : <DropsTab />}
      </Box>
    </Fade>
  )
}
