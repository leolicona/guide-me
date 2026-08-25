import { useState } from 'react'
import {
  Box,
  Typography,
  Button,
  CircularProgress,
  Alert,
  Stack,
  Divider,
  IconButton,
  TextField,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import BoltRounded from '@mui/icons-material/Bolt'
import {
  useMyBalance,
  useAddExpense,
  useDeleteExpense,
  useCreateDrop,
  useCancelDrop,
  useRegisterPayout,
} from '../hooks'
import { PendingAcknowledgments } from './PendingAcknowledgments'
import { TeamCajaDoor } from './TeamCajaDoor'
import { useOrgDateFormatter } from '../../organization'
import { AckChip } from './AckChip'
import { DropStatusChip } from './DropStatusChip'
import { CashBoxCard } from './CashBoxCard'
import { SalesSummaryCard } from './SalesSummaryCard'
import { CommissionsCard } from './CommissionsCard'
import {
  SectionCard,
  MoneyText,
  StatusChip,
  InfoPopover,
  FormSheet,
  ConfirmSheet,
} from '../../../components'

import { ServiceError } from '../../../services/authService'
import { formatMoney, amountToCents, centsToAmount } from '../../catalog/types'
import { useCurrentUser } from '../../auth/CurrentUserContext'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

/**
 * Which audience is reading their own caja. NOT `seller | admin` (the folio surfaces' split):
 * what distinguishes these two is not who sells but **who authorizes their own money moves**
 * (`caja-surface-parity.spec.md` D3).
 */
export type CajaSurface = 'self' | 'admin'

/**
 * One caja screen, three roles. `GET /api/cash/me` was always one payload; it was rendered by two
 * hand-written screens that drifted — an admin could file a hand-in and never see it again, their
 * negative-balance card carried a poorer breakdown than the seller's, and their reconciliation
 * offered a `Gastos` row for a capability the API answers 403 to.
 *
 * `surface` decides FOUR things and nothing else (D4, extended once by D17): which verbs render,
 * whether a move is self-authorized, whether expenses exist, and whether the TEAM's pending work is
 * surfaced. **Never which of your own numbers are shown** — that rule is what the two screens
 * broke, and the parity test asserts the difference set is exactly this list.
 *
 * The fourth item was added deliberately and written down. A rule you quietly extend is a rule you
 * have stopped enforcing.
 */
export function BalanceScreen({ surface }: { surface: CajaSurface }) {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps
  const user = useCurrentUser()
  const isAdmin = surface === 'admin'
  // D6 — the ONLY place a role is named in this file, and it mirrors the API guard exactly:
  // `/me/expenses` is `agentOrAdmin`, so an affiliate gets 403 and nobody else does (US-A99).
  // A second role test anywhere below is precisely the bug that left the admin reading a
  // `Gastos −$0.00` row for a capability the server was denying them.
  const canExpense = user.role !== 'affiliate'
  const { data: balance, isLoading, isError } = useMyBalance()
  const addExpense = useAddExpense()
  const deleteExpense = useDeleteExpense()
  const createDrop = useCreateDrop()
  const cancelDrop = useCancelDrop()
  const payout = useRegisterPayout()

  const [description, setDescription] = useState('')
  const [expenseAmount, setExpenseAmount] = useState('')
  const [dropOpen, setDropOpen] = useState(false)
  const [dropAmount, setDropAmount] = useState('')
  const [dropNote, setDropNote] = useState('')
  const [payoutOpen, setPayoutOpen] = useState(false)

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

  // US-A34 — the admin clears their own negative balance, self-confirmed. Admin-guarded endpoint,
  // so it is never reachable from `surface="self"` (D13), where it would 403.
  const handlePayout = () => {
    if (!balance) return
    payout.mutate(
      { agent_id: user.userId, amount: Math.abs(balance.balance) },
      { onSuccess: () => setPayoutOpen(false) },
    )
  }

  return (
    <>
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
                in view so it can't be missed, but never a modal. An admin owes no signature:
                their own moves are self-authorized, so the endpoint never mints one for them. */}
            {!isAdmin && <PendingAcknowledgments items={balance.pending_acknowledgments} />}

            {/* D17 — once «Caja» means MY caja for the admin too, their oversight work needs a
                door, and their own screen is where they already are. UNCONDITIONAL: gating it on
                pending work left the team's caja unreachable whenever nothing was pending, which
                is the normal state (BUG-041). `TeamCajaDoor` changes its tone, never its
                presence. */}
            {isAdmin && <TeamCajaDoor />}

            {/* D5 — self-authorization is STATED, not implied. A screen that looks identical to
                the seller's while behaving differently is worse than two screens; this badge is
                what makes one screen honest for both. */}
            {isAdmin && (
              <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                <StatusChip
                  tone="neutral"
                  icon={<BoltRounded />}
                  label="Auto-confirmado"
                  sx={{ height: 22 }}
                />
                <InfoPopover label="Cómo se confirman tus movimientos de caja">
                  Como administrador, tus entregas y pagos se confirman de inmediato y se descuentan
                  de tu caja al instante — sin estado pendiente ni firma.
                </InfoPopover>
              </Stack>
            )}

            {/* US-AG29 — three blocks sharing one shift timeline: the physical cash box
                (the actionable accent), the sales split, and the earned commissions. */}
            <Box>
              <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 1 }}>
                {balance.last_drop
                  ? `Desde tu última entrega · ${formatDate(balance.last_drop.created_at)}`
                  : 'Toda tu actividad'}
              </Typography>
              <Stack spacing={3}>
                <CashBoxCard
                  balance={balance}
                  showExpenses={canExpense}
                  onRegisterDrop={openDrop}
                  onRegisterPayout={isAdmin ? () => setPayoutOpen(true) : undefined}
                />
                <SalesSummaryCard sales={balance.sales} />
                <CommissionsCard commissions={balance.commissions} />
              </Stack>
            </Box>

            {/* Expenses (US-AG13, US-A99) — an agent or an admin, out of their own caja. An
                affiliate may not: `/me/expenses` answers them 403 (affiliate-portal D4). */}
            {canExpense && (
            <SectionCard title="Gastos">
                {/* Full-size fields, not `size="small"`: this is the one form a seller fills
                    standing up in the sun, and every other input in the product is 48px. The
                    amount and its verb share a row so the description gets the full width. */}
                <Stack spacing={1.5} sx={{ mb: 2 }}>
                  <TextField
                    label="Descripción"
                    fullWidth
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                    <TextField
                      label="Monto"
                      type="number"
                      sx={{ flex: 1 }}
                      value={expenseAmount}
                      onChange={(e) => setExpenseAmount(e.target.value)}
                    />
                    {/* Was a bare `+` icon button, 34px and wordless. The verb is the label. */}
                    <Button
                      variant="outlined"
                      startIcon={<AddRounded />}
                      onClick={handleAddExpense}
                      disabled={addExpense.isPending || !description.trim() || !expenseAmount}
                      sx={{ flexShrink: 0 }}
                    >
                      Agregar
                    </Button>
                  </Stack>
                </Stack>

                {addExpense.isError && (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    No se pudo agregar ese gasto. Revisa el monto e inténtalo de nuevo.
                  </Alert>
                )}

                {balance.expenses.length === 0 ? (
                  <Typography color="textSecondary" variant="body2">
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
                          {/* Not `noWrap`: the amount beside it is now a full MoneyText, and a
                              clipped «Estacionamiento en el mue…» is worse than a second line. */}
                          <Typography variant="body2">{ex.description}</Typography>
                          <Typography variant="caption" color="textSecondary">
                            {formatDate(ex.created_at)}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
                          <MoneyText cents={ex.amount} variant="body1" srLabel={ex.description} />
                          <IconButton
                            aria-label={`Eliminar gasto: ${ex.description}`}
                            onClick={() => deleteExpense.mutate(ex.id)}
                            disabled={deleteExpense.isPending}
                            // 48px, like every other target in the product — this one measured 30.
                            sx={{ width: 48, height: 48 }}
                          >
                            <DeleteOutlineRounded />
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
            </SectionCard>
            )}

            {/* Recent hand-ins (US-AG14) */}
            <SectionCard title="Entregas">
                {balance.drops.length === 0 ? (
                  <Typography color="textSecondary" variant="body2">
                    Aún no hay entregas de efectivo.
                  </Typography>
                ) : (
                  <Stack divider={<Divider flexItem />}>
                    {balance.drops.map((drop) => (
                      <Stack
                        key={drop.id}
                        direction="row"
                        sx={{
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          // An icon-paired chip is wider than the bare colour pill it replaces, and
                          // two of them beside a note squeezed the left column into three wrapped
                          // lines at 375px. Let the chip group drop to its own line instead of
                          // shredding the text it describes.
                          flexWrap: 'wrap',
                          rowGap: 1,
                          py: 1,
                        }}
                      >
                        <Box sx={{ minWidth: 0, flex: '1 1 12rem' }}>
                          <Typography variant="body2" component="div">
                            <MoneyText
                              cents={drop.amount}
                              variant="body1"
                              srLabel={drop.source === 'admin' ? 'Cobro directo' : 'Entrega'}
                            />
                            {drop.source === 'admin' ? ' · Cobro directo' : ''}
                          </Typography>
                          <Typography variant="caption" color="textSecondary">
                            {formatDate(drop.created_at)}
                            {drop.note ? ` · ${drop.note}` : ''}
                          </Typography>
                          {drop.amount_requested != null && (
                            <Typography variant="caption" color="textSecondary" sx={{ display: 'block' }}>
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
                            <Typography variant="caption" color="textSecondary" sx={{ display: 'block' }}>
                              {drop.review_note}
                            </Typography>
                          )}
                        </Box>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <AckChip state={drop.acknowledgment} />
                          <DropStatusChip status={drop.status} />
                          {/* An admin's own drop is born `confirmed` (self-authorized), so there
                              is never a pending one to cancel — and the endpoint is
                              `agentOrAffiliate` anyway. */}
                          {!isAdmin && drop.status === 'pending' && (
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
                {/* D12′ — this list is capped at 50. Say so: a silent truncation reads as
                    «everything is here» when it is not. */}
                {balance.drops_truncated && (
                  <Typography variant="body2" color="textSecondary" sx={{ mt: 2 }}>
                    Mostrando tus 50 entregas más recientes.
                  </Typography>
                )}
            </SectionCard>
          </Stack>
        )}

        {/* US-UX08 — a FormSheet, not a centred Dialog. The design system says so in as many
            words, and «reach & repetition» is why: at 375px the dialog floated 311×436 in
            mid-screen while the sheet anchors its submit where a thumb already is. */}
        <FormSheet
          open={dropOpen}
          onClose={() => setDropOpen(false)}
          title="Entregar efectivo"
          submitLabel={createDrop.isPending ? 'Enviando…' : 'Entregar'}
          onSubmit={(e) => {
            e.preventDefault()
            handleCreateDrop()
          }}
          busy={createDrop.isPending}
          disabled={dropInvalid}
          error={
            createDrop.isError ? (
              <Alert severity="error">
                {createDrop.error instanceof ServiceError &&
                createDrop.error.code === 'DROP_EXCEEDS_BALANCE'
                  ? 'La entrega supera el efectivo disponible. Ajusta el monto.'
                  : 'No se pudo registrar la entrega. Inténtalo de nuevo.'}
              </Alert>
            ) : undefined
          }
        >
            {/* The one place the two surfaces MAY read differently, because they behave
                differently (US-A34): an admin's hand-in is self-authorized and lands confirmed. */}
            {isAdmin ? (
              <Box sx={{ mb: 2 }}>
                <StatusChip tone="neutral" icon={<BoltRounded />} label="Se confirma al instante" />
              </Box>
            ) : (
              <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
                Registra el efectivo que vas a entregar al administrador. Permanecerá pendiente hasta que confirmen de recibido — solo entonces se descontará de tu saldo.
              </Typography>
            )}
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
        </FormSheet>

        {/* Payout — clears the admin's own negative balance, confirmed immediately (US-A34).
            `surface="self"` never opens it: the endpoint is admin-guarded (D13). */}
        {isAdmin && balance && (
          <ConfirmSheet
            open={payoutOpen}
            onClose={() => setPayoutOpen(false)}
            title="¿Registrar el pago?"
            description="La empresa te paga este saldo. Se confirma al instante y tu caja queda en cero — no hay estado pendiente ni firma."
            detail={
              <Stack spacing={1.5}>
                <MoneyText
                  cents={balance.balance}
                  absolute
                  semantic="negative"
                  variant="h2"
                  srLabel="La empresa te debe"
                />
                <StatusChip
                  tone="neutral"
                  icon={<BoltRounded />}
                  label="Se confirma al instante"
                  sx={{ alignSelf: 'flex-start' }}
                />
              </Stack>
            }
            confirmLabel="Registrar pago"
            confirmColor="primary"
            onConfirm={handlePayout}
            busy={payout.isPending}
            error={
              payout.isError ? (
                <Alert severity="error">No se pudo registrar el pago. Inténtalo de nuevo.</Alert>
              ) : undefined
            }
          />
        )}
    </>
  )
}
