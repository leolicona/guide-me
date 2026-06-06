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
import type { DropStatus } from '../features/cash/types'
import { formatMoney, amountToCents } from '../features/catalog/types'

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

// One labelled line in the balance breakdown. `sign` renders the +/− that ties each
// component to the running-balance formula.
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
      <Typography color="text.secondary">{label}</Typography>
      <Typography>
        {sign === '−' && value > 0 ? '−' : ''}
        {sign === '+' && value > 0 ? '+' : ''}
        {formatMoney(value)}
      </Typography>
    </Stack>
  )
}

export default function BalancePage() {
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

  const handleCreateDrop = () => {
    const amount = amountToCents(Number(dropAmount))
    if (!Number.isFinite(amount) || amount <= 0) return
    createDrop.mutate(
      { amount, note: dropNote.trim() || null },
      {
        onSuccess: () => {
          setDropOpen(false)
          setDropAmount('')
          setDropNote('')
        },
      },
    )
  }

  const negative = (balance?.balance ?? 0) < 0

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 680, mx: 'auto' }}>
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Mi saldo
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
            {/* Headline: the cash the agent is holding (the single accent). */}
            <Card variant="outlined">
              <CardContent>
                <Typography variant="overline" color="text.secondary">
                  {negative ? 'La empresa te debe' : 'Efectivo que tienes'}
                </Typography>
                <Typography
                  variant="h3"
                  sx={{ fontWeight: 600, color: negative ? 'error.main' : 'secondary.main' }}
                >
                  {formatMoney(Math.abs(balance.balance))}
                </Typography>
                {balance.pending_drops_total > 0 && (
                  <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
                    {formatMoney(balance.pending_drops_total)} entregado, pendiente de confirmación
                  </Typography>
                )}

                <Divider sx={{ my: 2 }} />
                <Stack spacing={1}>
                  <BreakdownRow label="Efectivo cobrado" value={balance.cash_collected} sign="+" />
                  <BreakdownRow label="Comisión ganada" value={balance.commission_total} sign="−" />
                  <BreakdownRow label="Gastos" value={balance.expense_total} sign="−" />
                  <BreakdownRow label="Entregado (confirmado)" value={balance.confirmed_drops_total} sign="−" />
                  {balance.payouts_total > 0 && (
                    <BreakdownRow label="Pagos recibidos" value={balance.payouts_total} sign="+" />
                  )}
                </Stack>
              </CardContent>
            </Card>

            {/* Hand in cash (US-AG14) */}
            <Button
              variant="contained"
              size="large"
              disableElevation
              onClick={() => setDropOpen(true)}
            >
              Entregar efectivo
            </Button>

            {/* Expenses (US-AG13) */}
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
              </CardContent>
            </Card>

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
                          <Typography variant="body2">{formatMoney(drop.amount)}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {formatDate(drop.created_at)}
                            {drop.note ? ` · ${drop.note}` : ''}
                          </Typography>
                          {drop.status === 'rejected' && drop.review_note && (
                            <Typography variant="caption" color="error" sx={{ display: 'block' }}>
                              Rechazado: {drop.review_note}
                            </Typography>
                          )}
                        </Box>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
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
                No se pudo registrar la entrega. Inténtalo de nuevo.
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setDropOpen(false)}>Cancelar</Button>
            <Button
              variant="contained"
              disableElevation
              onClick={handleCreateDrop}
              disabled={createDrop.isPending || !dropAmount}
            >
              {createDrop.isPending ? 'Enviando…' : 'Entregar'}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Fade>
  )
}
