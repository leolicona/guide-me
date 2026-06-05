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
  TextField,
  IconButton,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from '@mui/material'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import AddRounded from '@mui/icons-material/AddRounded'
import {
  useMyDrawer,
  useAddExpense,
  useDeleteExpense,
  useCloseDrawer,
} from '../features/cash-drawer/hooks'
import type { DrawerStatus } from '../features/cash-drawer/types'
import { amountToCents, formatMoney } from '../features/catalog/types'

const STATUS_CHIP: Record<DrawerStatus, { label: string; color: 'default' | 'info' | 'success' | 'error' }> = {
  open: { label: 'Open', color: 'default' },
  submitted: { label: 'Submitted', color: 'info' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Rejected', color: 'error' },
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography color="text.secondary" variant={strong ? 'h6' : 'body1'}>
        {label}
      </Typography>
      <Typography variant={strong ? 'h6' : 'body1'}>{value}</Typography>
    </Stack>
  )
}

export default function CashDrawerPage() {
  const { data: drawer, isLoading, isError } = useMyDrawer()
  const addExpense = useAddExpense()
  const deleteExpense = useDeleteExpense()
  const closeDrawer = useCloseDrawer()

  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  const isOpen = drawer?.status === 'open'
  const amountInvalid = amount === '' || Number(amount) <= 0
  const canAdd = description.trim() !== '' && !amountInvalid

  const handleAdd = () => {
    if (!canAdd) return
    addExpense.mutate(
      { description: description.trim(), amount: amountToCents(Number(amount)) },
      {
        onSuccess: () => {
          setDescription('')
          setAmount('')
        },
      },
    )
  }

  const handleClose = () => {
    closeDrawer.mutate(undefined, { onSuccess: () => setConfirmOpen(false) })
  }

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
          <Typography variant="h4" component="h1">
            Cash drawer
          </Typography>
          {drawer && <Chip size="small" {...STATUS_CHIP[drawer.status]} />}
        </Stack>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">Couldn't load your cash drawer. Please try again.</Alert>}

        {drawer && (
          <Stack spacing={3}>
            {drawer.status === 'rejected' && drawer.review_note && (
              <Alert severity="error">Rejected by admin: {drawer.review_note}</Alert>
            )}
            {drawer.status === 'approved' && (
              <Alert severity="success">This closure was approved by your admin.</Alert>
            )}

            <Card>
              <CardContent>
                <Typography variant="overline" color="text.secondary">
                  {drawer.business_date}
                </Typography>
                <Stack spacing={1.5} sx={{ mt: 1 }}>
                  <SummaryRow label="Folios" value={String(drawer.income.folio_count)} />
                  <SummaryRow label="Cash collected" value={formatMoney(drawer.income.total_collected)} />
                  {drawer.income.pending_balance > 0 && (
                    <SummaryRow label="Pending bookings" value={formatMoney(drawer.income.pending_balance)} />
                  )}
                  <SummaryRow label="Expenses" value={`−${formatMoney(drawer.expense_total)}`} />
                  <Divider />
                  <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                    <Typography variant="h6">Net balance</Typography>
                    <Typography
                      variant="h6"
                      color={drawer.net_balance < 0 ? 'error.main' : 'text.primary'}
                    >
                      {formatMoney(drawer.net_balance)}
                    </Typography>
                  </Stack>
                </Stack>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>
                  Operating expenses
                </Typography>

                {isOpen && (
                  <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'flex-start' }}>
                    <TextField
                      label="Description"
                      size="small"
                      fullWidth
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                    />
                    <TextField
                      label="Amount"
                      size="small"
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      slotProps={{ htmlInput: { min: 0, step: 0.01 } }}
                      sx={{ width: 140 }}
                    />
                    <IconButton
                      aria-label="Add expense"
                      color="primary"
                      onClick={handleAdd}
                      disabled={!canAdd || addExpense.isPending}
                      sx={{ mt: 0.5 }}
                    >
                      <AddRounded />
                    </IconButton>
                  </Stack>
                )}

                {drawer.expenses.length === 0 ? (
                  <Typography color="text.secondary" variant="body2">
                    No expenses recorded.
                  </Typography>
                ) : (
                  <Stack spacing={1} divider={<Divider flexItem />}>
                    {drawer.expenses.map((e) => (
                      <Stack
                        key={e.id}
                        direction="row"
                        sx={{ justifyContent: 'space-between', alignItems: 'center' }}
                      >
                        <Typography variant="body2">{e.description}</Typography>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Typography variant="body2">{formatMoney(e.amount)}</Typography>
                          {isOpen && (
                            <IconButton
                              size="small"
                              aria-label={`Delete ${e.description}`}
                              onClick={() => deleteExpense.mutate(e.id)}
                            >
                              <DeleteOutlineRounded fontSize="small" />
                            </IconButton>
                          )}
                        </Stack>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>

            {isOpen && (
              <Button
                variant="contained"
                size="large"
                disableElevation
                onClick={() => setConfirmOpen(true)}
              >
                Close day
              </Button>
            )}
          </Stack>
        )}

        <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
          <DialogTitle>Submit today's closure?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              This submits today's cash closure to your admin for review. Once submitted it
              can't be edited.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="contained" disableElevation onClick={handleClose} disabled={closeDrawer.isPending}>
              {closeDrawer.isPending ? 'Submitting…' : 'Submit closure'}
            </Button>
          </DialogActions>
        </Dialog>
      </Box>
    </Fade>
  )
}
