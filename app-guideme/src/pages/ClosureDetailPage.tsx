import { useState } from 'react'
import { useParams, Link as RouterLink } from 'react-router-dom'
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
  TextField,
} from '@mui/material'
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded'
import { useDrawer, useReviewDrawer } from '../features/cash-drawer/hooks'
import type { DrawerStatus } from '../features/cash-drawer/types'
import { formatMoney } from '../features/catalog/types'
import { ROUTES } from '../config/routes'

const STATUS_COLOR: Record<DrawerStatus, 'default' | 'info' | 'success' | 'error'> = {
  open: 'default',
  submitted: 'info',
  approved: 'success',
  rejected: 'error',
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography color="text.secondary" variant={strong ? 'h6' : 'body1'}>{label}</Typography>
      <Typography variant={strong ? 'h6' : 'body1'}>{value}</Typography>
    </Stack>
  )
}

export default function ClosureDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: drawer, isLoading, isError } = useDrawer(id)
  const review = useReviewDrawer()
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')

  const canReview = drawer?.status === 'submitted'

  const approve = () => review.mutate({ id: id as string, decision: 'approved' })
  const reject = () =>
    review.mutate(
      { id: id as string, decision: 'rejected', note: note.trim() || undefined },
      { onSuccess: () => setRejecting(false) },
    )

  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 640, mx: 'auto' }}>
        <Button component={RouterLink} to={ROUTES.CLOSURES} startIcon={<ArrowBackRounded />} sx={{ mb: 2 }}>
          Closures
        </Button>

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}
        {isError && <Alert severity="error">Couldn't load this closure. Please try again.</Alert>}

        {drawer && (
          <Stack spacing={3}>
            <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography variant="h5" component="h1">
                  {drawer.agent?.name ?? 'Closure'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {drawer.business_date}
                </Typography>
              </Box>
              <Chip size="small" color={STATUS_COLOR[drawer.status]} label={drawer.status} />
            </Stack>

            {drawer.status === 'rejected' && drawer.review_note && (
              <Alert severity="error">Rejected: {drawer.review_note}</Alert>
            )}

            <Card>
              <CardContent>
                <Stack spacing={1.5}>
                  <Row label="Folios" value={String(drawer.income.folio_count)} />
                  <Row label="Cash collected" value={formatMoney(drawer.income.total_collected)} />
                  {drawer.income.pending_balance > 0 && (
                    <Row label="Pending bookings" value={formatMoney(drawer.income.pending_balance)} />
                  )}
                  <Row label="Expenses" value={`−${formatMoney(drawer.expense_total)}`} />
                  <Divider />
                  <Row label="Net balance" value={formatMoney(drawer.net_balance)} strong />
                </Stack>
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h6" sx={{ mb: 2 }}>Operating expenses</Typography>
                {drawer.expenses.length === 0 ? (
                  <Typography color="text.secondary" variant="body2">No expenses recorded.</Typography>
                ) : (
                  <Stack spacing={1} divider={<Divider flexItem />}>
                    {drawer.expenses.map((e) => (
                      <Stack key={e.id} direction="row" sx={{ justifyContent: 'space-between' }}>
                        <Typography variant="body2">{e.description}</Typography>
                        <Typography variant="body2">{formatMoney(e.amount)}</Typography>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>

            {review.isError && <Alert severity="error">Couldn't submit your review. Please try again.</Alert>}

            {canReview && !rejecting && (
              <Stack direction="row" spacing={2}>
                <Button
                  variant="contained"
                  color="success"
                  disableElevation
                  fullWidth
                  onClick={approve}
                  disabled={review.isPending}
                >
                  Approve
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  fullWidth
                  onClick={() => setRejecting(true)}
                  disabled={review.isPending}
                >
                  Reject
                </Button>
              </Stack>
            )}

            {canReview && rejecting && (
              <Card variant="outlined">
                <CardContent>
                  <Stack spacing={2}>
                    <TextField
                      label="Reason (optional)"
                      size="small"
                      fullWidth
                      multiline
                      minRows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <Stack direction="row" spacing={2}>
                      <Button onClick={() => setRejecting(false)} fullWidth>
                        Cancel
                      </Button>
                      <Button
                        variant="contained"
                        color="error"
                        disableElevation
                        fullWidth
                        onClick={reject}
                        disabled={review.isPending}
                      >
                        Confirm reject
                      </Button>
                    </Stack>
                  </Stack>
                </CardContent>
              </Card>
            )}
          </Stack>
        )}
      </Box>
    </Fade>
  )
}
