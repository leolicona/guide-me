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
  useRegisterPayout,
} from '../features/cash/hooks'
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

type DropFilter = DropStatus | 'all'

// --- Balances tab: company cash exposure per agent (US-A19) + payouts (US-A25) ---
function BalancesTab() {
  const { data: balances, isLoading, isError } = useBalances()
  const payout = useRegisterPayout()
  const [target, setTarget] = useState<BalanceListItem | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')

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
                <Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap' }}>
                  <Metric label="Cobrado" value={row.cash_collected} />
                  <Metric label="Comisión" value={row.commission_total} />
                  <Metric label="Gastos" value={row.expense_total} />
                  <Metric label="Entregado" value={row.confirmed_drops_total} />
                  {row.payouts_total > 0 && <Metric label="Pagado" value={row.payouts_total} />}
                </Stack>

                {negative && (
                  <Button size="small" sx={{ mt: 1.5 }} onClick={() => openPayout(row)}>
                    Registrar pago
                  </Button>
                )}
              </CardContent>
            </Card>
          )
        })}
      </Stack>

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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2">{formatMoney(value)}</Typography>
    </Box>
  )
}

// --- Drops tab: the review queue (US-A19) ---
function DropsTab() {
  const [filter, setFilter] = useState<DropFilter>('pending')
  const { data: drops, isLoading, isError } = useDrops({ status: filter })

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
                        {drop.agent?.name} · {formatDate(drop.created_at)}
                      </Typography>
                    </Box>
                    <Chip size="small" color={DROP_COLOR[drop.status]} label={DROP_LABEL[drop.status]} />
                  </Stack>
                  {drop.note && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      {drop.note}
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
