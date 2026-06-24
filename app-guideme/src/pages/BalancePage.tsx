import { useState } from 'react'
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Fade,
  Stack,
  Divider,
  Chip,
  IconButton,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import {
  useMyBalance,
  useAddExpense,
  useDeleteExpense,
  useCreateDrop,
  useCancelDrop,
} from '../features/cash/hooks'
import { PendingAcknowledgments } from '../features/cash/components/PendingAcknowledgments'
import { AckChip } from '../features/cash/components/AckChip'
import { CashBoxCard } from '../features/cash/components/CashBoxCard'
import { SalesSummaryCard } from '../features/cash/components/SalesSummaryCard'
import { CommissionsCard } from '../features/cash/components/CommissionsCard'
import type { DropStatus } from '../features/cash/types'
import { ServiceError } from '../services/authService'
import { formatMoney, amountToCents, centsToAmount } from '../features/catalog/types'
import { useCurrentUser } from '../features/auth/CurrentUserContext'

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

export default function BalancePage() {
  // Affiliate-portal D4/D5: an affiliate carries the same running balance + cash-drop flow as an
  // agent, but has NO expenses — hide the Gastos card for that role (the API also denies it 403).
  const user = useCurrentUser()
  const isAffiliate = user.role === 'affiliate'
  const { data: balance, isLoading, isError } = useMyBalance()
  const addExpense = useAddExpense()
  const deleteExpense = useDeleteExpense()
  const createDrop = useCreateDrop()
  const cancelDrop = useCancelDrop()

  const [description, setDescription] = useState('')
  const [expenseAmount, setExpenseAmount] = useState('')
  const [dropOpen, setDropOpen] = useState(false)
  const [dropAmount, setDropAmount] = useState('')
  const [dropNote, setDropNote] = useState('')

  const handleAddExpense = () => {
    const amount = amountToCents(Number(expenseAmount))
    if (!description.trim() || !Number.isFinite(amount) || amount <= 0) return
    addExpense.mutate(
      { description: description.trim(), amount },
      {
        onSuccess: () => {
          setDescription('')
          setExpenseAmount('')
        },
      },
    )
  }

  // What the caller can actually hand in: the cash they hold minus drops already pending
  // confirmation (that cash is already pledged). The backend enforces this same cap.
  const available = balance ? balance.balance - balance.pending_drops_total : 0

  const openDrop = () => {
    // Prefill the full available amount — the common "hand in everything" case — so the
    // number the caller is staring at doesn't have to be retyped.
    setDropAmount(available > 0 ? String(centsToAmount(available)) : '')
    setDropNote('')
    setDropOpen(true)
  }

  const dropCents = amountToCents(Number(dropAmount))
  const dropExceeds = Number.isFinite(dropCents) && dropCents > available
  const dropInvalid = !dropAmount || !Number.isFinite(dropCents) || dropCents <= 0 || dropExceeds

  const handleCreateDrop = () => {
    if (dropInvalid) return
    createDrop.mutate(
      { amount: dropCents, note: dropNote.trim() || null },
      {
        onSuccess: () => {
          setDropOpen(false)
          setDropAmount('')
          setDropNote('')
        },
      },
    )
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 680, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Caja
        </Typography>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && (
          <Alert severity="error">No se pudo cargar tu saldo. Inténtalo de nuevo.</Alert>
        )}

        {balance && (
          <Stack spacing={3}>
            {/* Admin money-moves awaiting my signature (US-AG27/AG28) — non-blocking, first
                in view so it can't be missed, but never a modal. */}
            <PendingAcknowledgments items={balance.pending_acknowledgments} />

            {/* US-AG29 — three blocks sharing one shift timeline: the physical cash box
                (the actionable accent), the sales split, and the earned commissions. */}
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                {balance.last_drop
                  ? `Desde tu última entrega · ${formatDate(balance.last_drop.created_at)}`
                  : 'Toda tu actividad'}
              </Typography>
              <Stack spacing={3}>
                <CashBoxCard
                  balance={balance}
                  showExpenses={!isAffiliate}
                  onRegisterDrop={openDrop}
                />
                <SalesSummaryCard sales={balance.sales} />
                <CommissionsCard commissions={balance.commissions} />
              </Stack>
            </Box>

            {/* Expenses (US-AG13) — agents only; an affiliate has no expenses (D4). */}
            {!isAffiliate && (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Gastos
                </Typography>

                <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
                  <TextField
                    label="Descripción"
                    size="small"
                    fullWidth
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                  <TextField
                    label="Monto"
                    size="small"
                    type="number"
                    sx={{ width: 130 }}
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                  />
                  <IconButton
                    color="primary"
                    aria-label="Agregar gasto"
                    onClick={handleAddExpense}
                    disabled={addExpense.isPending || !description.trim() || !expenseAmount}
                  >
                    <AddRounded />
                  </IconButton>
                </Stack>

                {addExpense.isError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    No se pudo agregar ese gasto. Revisa el monto e inténtalo de nuevo.
                  </Alert>
                )}

                {balance.expenses.length === 0 ? (
                  <Typography color="text.secondary" variant="body2">
                    No hay gastos registrados.
                  </Typography>
                ) : (
                  <Stack divider={<Divider flexItem />}>
                    {balance.expenses.map((ex) => (
                      <Stack
                        key={ex.id}
                        direction="row"
                        sx={{ justifyContent: 'space-between', alignItems: 'center', py: 1 }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" noWrap>
                            {ex.description}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {formatDate(ex.created_at)}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Typography variant="body2">{formatMoney(ex.amount)}</Typography>
                          <IconButton
                            size="small"
                            aria-label="Eliminar gasto"
                            onClick={() => deleteExpense.mutate(ex.id)}
                            disabled={deleteExpense.isPending}
                          >
                            <DeleteOutlineRounded fontSize="small" />
                          </IconButton>
                        </Stack>
                      </Stack>
                    ))}
                  </Stack>
                )}

                {deleteExpense.isError && (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    {deleteExpense.error instanceof ServiceError &&
                    deleteExpense.error.code === 'CONFLICT'
                      ? 'Este gasto ya fue liquidado en una entrega confirmada y no se puede eliminar.'
                      : 'No se pudo eliminar el gasto. Inténtalo de nuevo.'}
                  </Alert>
                )}
              </CardContent>
            </Card>
            )}

            {/* Recent hand-ins (US-AG14) */}
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Entregas
                </Typography>
                {balance.drops.length === 0 ? (
                  <Typography color="text.secondary" variant="body2">
                    Aún no hay entregas de efectivo.
                  </Typography>
                ) : (
                  <Stack divider={<Divider flexItem />}>
                    {balance.drops.map((drop) => (
                      <Stack
                        key={drop.id}
                        direction="row"
                        sx={{ justifyContent: 'space-between', alignItems: 'center', py: 1 }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2">
                            {formatMoney(drop.amount)}
                            {drop.source === 'admin' ? ' · Cobro directo' : ''}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {formatDate(drop.created_at)}
                            {drop.note ? ` · ${drop.note}` : ''}
                          </Typography>
                          {drop.amount_requested != null && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              Reportaste {formatMoney(drop.amount_requested)} · registrado{' '}
                              {formatMoney(drop.amount)}
                            </Typography>
                          )}
                          {drop.status === 'rejected' && drop.review_note && (
                            <Typography variant="caption" color="error" sx={{ display: 'block' }}>
                              Rechazado: {drop.review_note}
                            </Typography>
                          )}
                          {drop.acknowledgment === 'disputed' && drop.ack_note && (
                            <Typography variant="caption" color="error" sx={{ display: 'block' }}>
                              Tu disputa: {drop.ack_note}
                            </Typography>
                          )}
                          {drop.acknowledgment === 'resolved' && drop.review_note && (
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              {drop.review_note}
                            </Typography>
                          )}
                        </Box>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <AckChip state={drop.acknowledgment} />
                          <Chip size="small" color={DROP_COLOR[drop.status]} label={DROP_LABEL[drop.status]} />
                          {drop.status === 'pending' && (
                            <Button
                              size="small"
                              color="inherit"
                              onClick={() => cancelDrop.mutate(drop.id)}
                              disabled={cancelDrop.isPending}
                            >
                              Cancelar
                            </Button>
                          )}
                        </Stack>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>
          </Stack>
        )}

        {/* Hand-in dialog */}
        <Dialog open={dropOpen} onClose={() => setDropOpen(false)} fullWidth maxWidth="xs">
          <DialogTitle>Entregar efectivo</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Registra el efectivo que vas a entregar al administrador. Permanecerá pendiente hasta que confirmen de recibido — solo entonces se descontará de tu saldo.
            </Typography>
            <Stack spacing={2}>
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
              <TextField
                label="Nota (opcional)"
                fullWidth
                multiline
                minRows={2}
                value={dropNote}
                onChange={(e) => setDropNote(e.target.value)}
              />
            </Stack>
            {createDrop.isError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {createDrop.error instanceof ServiceError &&
                createDrop.error.code === 'DROP_EXCEEDS_BALANCE'
                  ? 'La entrega supera el efectivo disponible. Ajusta el monto.'
                  : 'No se pudo registrar la entrega. Inténtalo de nuevo.'}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDropOpen(false)}>Cancelar</Button>
            <Button
              variant="contained"
              disableElevation
              onClick={handleCreateDrop}
              disabled={createDrop.isPending || dropInvalid}
            >
              {createDrop.isPending ? 'Enviando…' : 'Entregar'}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Fade>
  )
}
