import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useCurrentUser } from '../../auth/CurrentUserContext'
import { useMyBalance, useCreateDrop, useRegisterPayout } from '../hooks'
import { CashBoxCard } from './CashBoxCard'
import { SalesSummaryCard } from './SalesSummaryCard'
import { CommissionsCard } from './CommissionsCard'
import { formatMoney, amountToCents } from '../../catalog/types'

const formatDate = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

// US-A35 — "Tu caja": the admin's own drawer, pinned above the team ("Equipo") on the Caja
// screen. It reuses the agent's CashBoxCard for the common (non-negative) case, but every
// money move here is SELF-AUTHORIZED (US-A34): a hand-in is born confirmed and a payout clears
// a negative balance immediately — there is no pending state and no signature. The copy says
// so, and the agent's "pendiente de confirmación" hint never shows (admin drops are never
// pending).
export function TuCajaSection() {
  const user = useCurrentUser()
  const { data: balance, isLoading, isError } = useMyBalance()
  const createDrop = useCreateDrop()
  const payout = useRegisterPayout()

  const [dropOpen, setDropOpen] = useState(false)
  const [dropAmount, setDropAmount] = useState('')
  const [payoutOpen, setPayoutOpen] = useState(false)

  // The drawer mirrors the team list below it; if it can't load, stay quiet rather than
  // blocking the page (the Equipo section renders its own loading/error state).
  if (isLoading || isError || !balance) return null

  const negative = balance.balance < 0

  const handleDrop = () => {
    const amount = amountToCents(Number(dropAmount))
    if (!Number.isFinite(amount) || amount <= 0) return
    createDrop.mutate(
      { amount },
      {
        onSuccess: () => {
          setDropOpen(false)
          setDropAmount('')
        },
      },
    )
  }

  const handlePayout = () => {
    payout.mutate(
      { agent_id: user.userId, amount: Math.abs(balance.balance) },
      { onSuccess: () => setPayoutOpen(false) },
    )
  }

  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Tu caja
      </Typography>
      {/* One shift timeline for all three blocks, mirroring the agent's Caja. */}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {balance.last_drop
          ? `Desde tu última entrega · ${formatDate(balance.last_drop.created_at)}`
          : 'Toda tu actividad'}
      </Typography>

      {negative ? (
        // The company owes the admin — offer a self-confirmed payout instead of a hand-in.
        <Card variant="outlined">
          <CardContent>
            <Typography variant="overline" color="text.secondary">
              La empresa te debe
            </Typography>
            <Typography variant="h3" sx={{ fontWeight: 600, color: 'error.main' }}>
              {formatMoney(Math.abs(balance.balance))}
            </Typography>
            <Stack spacing={1} sx={{ mt: 1.5 }}>
              <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                <Typography variant="body2" color="text.secondary">
                  Efectivo cobrado
                </Typography>
                <Typography variant="body2">{formatMoney(balance.cash_collected)}</Typography>
              </Stack>
              <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                <Typography variant="body2" color="text.secondary">
                  Comisión ganada
                </Typography>
                <Typography variant="body2">−{formatMoney(balance.commission_total)}</Typography>
              </Stack>
            </Stack>
            <Button
              variant="contained"
              size="large"
              fullWidth
              disableElevation
              onClick={() => setPayoutOpen(true)}
              sx={{ mt: 2 }}
            >
              Registrar pago
            </Button>
          </CardContent>
        </Card>
      ) : (
        <CashBoxCard balance={balance} onRegisterDrop={() => setDropOpen(true)} />
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Tus entregas y pagos se confirman de inmediato (auto-confirmados).
      </Typography>

      {/* US-AG29 reuse — the admin sees their own sales & earned commission like an agent
          does, so "did I earn commission on my sale?" is answered on sight, not buried in
          the collapsed breakdown. Rendered only when there is shift activity to show. */}
      {(balance.sales.total !== 0 || balance.commissions.total !== 0) && (
        <Stack spacing={2} sx={{ mt: 2 }}>
          <SalesSummaryCard sales={balance.sales} />
          <CommissionsCard commissions={balance.commissions} />
        </Stack>
      )}

      {/* Hand-in dialog — self-confirmed copy (no pending state). */}
      <Dialog open={dropOpen} onClose={() => setDropOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Entregar efectivo</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Registra el efectivo que vas a entregar. Como administrador, la entrega se confirma
            de inmediato y se descuenta de tu caja al instante.
          </Typography>
          <TextField
            label="Monto"
            type="number"
            fullWidth
            autoFocus
            value={dropAmount}
            onChange={(e) => setDropAmount(e.target.value)}
          />
          {createDrop.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo registrar la entrega. Inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDropOpen(false)}>Cancelar</Button>
          <Button
            variant="contained"
            disableElevation
            onClick={handleDrop}
            disabled={createDrop.isPending || !dropAmount}
          >
            {createDrop.isPending ? 'Enviando…' : 'Entregar'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Payout dialog — clears the admin's own negative balance, confirmed immediately. */}
      <Dialog open={payoutOpen} onClose={() => setPayoutOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Registrar pago</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            La empresa te debe {formatMoney(Math.abs(balance.balance))}. Registra el pago para
            dejar tu caja en cero; se confirma de inmediato.
          </Typography>
          {payout.isError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              No se pudo registrar el pago. Inténtalo de nuevo.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPayoutOpen(false)}>Cancelar</Button>
          <Button
            variant="contained"
            disableElevation
            onClick={handlePayout}
            disabled={payout.isPending}
          >
            {payout.isPending ? 'Enviando…' : 'Registrar pago'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
