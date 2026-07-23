import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import BoltRounded from '@mui/icons-material/Bolt'
import { useCurrentUser } from '../../auth/CurrentUserContext'
import { useMyBalance, useCreateDrop, useRegisterPayout } from '../hooks'
import { CashBoxCard } from './CashBoxCard'
import { SalesSummaryCard } from './SalesSummaryCard'
import { CommissionsCard } from './CommissionsCard'
import { formatMoney, amountToCents, centsToAmount } from '../../catalog/types'
import { SectionCard, MoneyText, StatusChip, InfoPopover } from '../../../components'
import { useOrgDateFormatter } from '../../organization'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// US-A35 — "Tu caja": the admin's own drawer, pinned above the team ("Equipo") on the Caja
// screen. It reuses the agent's CashBoxCard for the common (non-negative) case, but every
// money move here is SELF-AUTHORIZED (US-A34): a hand-in is born confirmed and a payout clears
// a negative balance immediately — there is no pending state and no signature. The copy says
// so, and the agent's "pendiente de confirmación" hint never shows (admin drops are never
// pending).
export function TuCajaSection() {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
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
  const available = balance.balance - balance.pending_drops_total

  const openDrop = () => {
    setDropAmount(available > 0 ? String(centsToAmount(available)) : '')
    setDropOpen(true)
  }

  const dropCents = amountToCents(Number(dropAmount))
  const dropExceeds = Number.isFinite(dropCents) && dropCents > available
  const dropInvalid = !dropAmount || !Number.isFinite(dropCents) || dropCents <= 0 || dropExceeds

  const handleDrop = () => {
    if (dropInvalid) return
    createDrop.mutate(
      { amount: dropCents },
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
      {/* The "Mi caja" tab already names this section. Lead with the auto-confirmed status —
          the "se confirman de inmediato" rule shown as a badge, with the full "why" one tap away. */}
      <Stack direction="row" sx={{ alignItems: 'center', gap: 1, mb: 0.5 }}>
        <StatusChip tone="neutral" icon={<BoltRounded />} label="Auto-confirmado" sx={{ height: 22 }} />
        <InfoPopover label="Cómo se confirman tus movimientos de caja">
          Como administrador, tus entregas y pagos se confirman de inmediato y se descuentan de tu
          caja al instante — sin estado pendiente ni firma.
        </InfoPopover>
      </Stack>
      {/* One shift timeline for all three blocks, mirroring the agent's Caja. */}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {balance.last_drop
          ? `Desde tu última entrega · ${formatDate(balance.last_drop.created_at)}`
          : 'Toda tu actividad'}
      </Typography>

      {negative ? (
        // The company owes the admin — offer a self-confirmed payout instead of a hand-in.
        <SectionCard>
            <Typography variant="overline" color="text.secondary">
              La empresa te debe
            </Typography>
            <MoneyText
              cents={balance.balance}
              absolute
              semantic="negative"
              variant="h1"
              srLabel="La empresa te debe"
              sx={{ display: 'block', mt: 0.5 }}
            />
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
        </SectionCard>
      ) : (
        <CashBoxCard balance={balance} onRegisterDrop={openDrop} />
      )}

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
          <Box sx={{ mb: 2 }}>
            <StatusChip tone="neutral" icon={<BoltRounded />} label="Se confirma al instante" />
          </Box>
          <TextField
            label="Monto"
            type="number"
            fullWidth
            autoFocus
            value={dropAmount}
            onChange={(e) => setDropAmount(e.target.value)}
            error={dropExceeds}
            helperText={
              dropExceeds
                ? `No puedes entregar más de ${formatMoney(available)} disponibles.`
                : `Disponible para entregar: ${formatMoney(available)}`
            }
            slotProps={{
              input: {
                endAdornment: (
                  <Button
                    size="small"
                    onClick={() => setDropAmount(String(centsToAmount(available)))}
                    disabled={available <= 0}
                  >
                    Todo
                  </Button>
                ),
              },
            }}
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
            disabled={createDrop.isPending || dropInvalid}
          >
            {createDrop.isPending ? 'Enviando…' : 'Entregar'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Payout dialog — clears the admin's own negative balance, confirmed immediately. */}
      <Dialog open={payoutOpen} onClose={() => setPayoutOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>Registrar pago</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5}>
            <Stack
              direction="row"
              sx={{ justifyContent: 'space-between', alignItems: 'baseline' }}
            >
              <Typography variant="body2" color="text.secondary">
                La empresa te debe
              </Typography>
              <MoneyText
                cents={balance.balance}
                absolute
                semantic="negative"
                variant="h6"
                srLabel="La empresa te debe"
              />
            </Stack>
            <StatusChip
              tone="neutral"
              icon={<BoltRounded />}
              label="Se confirma al instante"
              sx={{ alignSelf: 'flex-start' }}
            />
          </Stack>
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
