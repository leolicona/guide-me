import { useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import {
  Box,
  Typography,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Alert,
  Collapse,
  Fade,
  Stack,
  Divider,
  Chip,
  Badge,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import PersonRounded from '@mui/icons-material/Person'
import TrendingDownRounded from '@mui/icons-material/TrendingDown'
import TrendingUpRounded from '@mui/icons-material/TrendingUp'
import {
  useBalances,
  useDrops,
  useRegisterCollection,
  useRegisterPayout,
} from '../features/cash/hooks'
import { useOrgDateFormatter } from '../features/organization'
import { METHOD_LABEL } from '../features/cash/components/paymentPresentation'
import type { BalanceListItem } from '../features/cash/types'
import { formatMoney, amountToCents, centsToAmount } from '../features/catalog/types'
import { DropCard } from '../features/cash/components/DropCard'
import { PendingConfirmations } from '../features/cash/components/PendingConfirmations'
import { ROUTES } from '../config/routes'
import { MoneyText, StatusChip, InfoPopover } from '../components'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

// D18 — «Efectivo en la calle» is the only surviving stat. «Por confirmar» and «En disputa» were
// counts sitting above the very lists that counted them; they are the blocks now.
function CashInFieldHeading({ balances }: { balances: BalanceListItem[] }) {
  const total = balances.reduce((n, r) => n + (r.balance > 0 ? r.balance : 0), 0)
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 2, flexWrap: 'wrap' }}>
      <Typography variant="h3" component="h2">
        Efectivo en la calle
      </Typography>
      <MoneyText cents={total} variant="h3" srLabel="Efectivo en la calle" />
      <Typography variant="body2" color="textSecondary">
        {balances.length === 1 ? '1 persona' : `${balances.length} personas`}
      </Typography>
    </Stack>
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
          <Box sx={{ minWidth: 0, flex: '1 1 10rem' }}>
            {/* Not `noWrap` beside the company chip: at 375px «Sofía Reyes» clipped to «So…»,
                which is not a name. The chip wraps under it instead. */}
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
            >
              <Typography variant="subtitle1">{row.agent.name}</Typography>
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
function TeamBalances() {
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
      <CashInFieldHeading balances={balances} />
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
// A contested hand-in is the other thing that needs a human, and unlike a pending one it has no
// one-tap answer — resolving a dispute is a conversation. So: named, counted, and one tap from the
// detail where it can be resolved. Renders nothing when there are none.
function OpenDisputes() {
  const { data: page } = useDrops({ status: 'all', ack: 'disputed' })
  const disputed = page?.drops
  if (!disputed || disputed.length === 0) return null

  return (
    <Stack spacing={2} sx={{ mb: 4 }}>
      <Typography variant="h3" component="h2">
        {disputed.length === 1 ? 'Una entrega en disputa' : `${disputed.length} entregas en disputa`}
      </Typography>
      {disputed.map((drop) => (
        <DropCard key={drop.id} drop={drop} />
      ))}
    </Stack>
  )
}

export default function CashBalancesPage() {
  return (
    <Fade in timeout={400}>
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        {/* US-A98 — «Caja del equipo», not «Caja». The admin's own drawer moved to /balance with
            everyone else's (D2′), which deleted the first of three stacked tab rows; the other two
            went with it. What is left is ordered by the job the admin came to do: what needs a
            human, what is contested, then who is holding company cash. No tabs at all. */}
        <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
          Caja del equipo
        </Typography>

        <PendingConfirmations />
        <OpenDisputes />
        <TeamBalances />

        <Box sx={{ mt: 4, textAlign: 'center' }}>
          {/* Confirmed and rejected hand-ins are audit, not daily work (D15). */}
          <Button
            component={RouterLink}
            to={ROUTES.CASH_DROPS}
            endIcon={<ArrowForwardRounded />}
            color="inherit"
          >
            Ver historial de entregas
          </Button>
        </Box>
      </Box>
    </Fade>
  )
}
