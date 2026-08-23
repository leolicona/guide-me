import { useState } from 'react'
import { Button, Collapse, Divider, Stack, Typography } from '@mui/material'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import type { AgentBalance } from '../types'
import { formatMoney } from '../../catalog/types'
import { SectionCard, MoneyText } from '../../../components'

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

/**
 * US-AG29 block 1 — "Mi caja física": the physical cash the agent must hand in (the page's
 * single accent and its actionable number). The reconciliation breakdown is folded behind a
 * "¿Cómo se calcula?" disclosure so the headline reads clean.
 */
export function CashBoxCard({
  balance,
  onRegisterDrop,
  onRegisterPayout,
  showExpenses = true,
}: {
  balance: AgentBalance
  onRegisterDrop: () => void
  // US-A34 — only a self-authorizing caller (the admin) can clear their own negative balance, and
  // the endpoint is admin-guarded. Absent ⇒ no payout verb, which is every other surface.
  // Passing it is what used to require a whole second card (caja-surface-parity D8).
  onRegisterPayout?: () => void
  // Neither an affiliate nor an admin may record an expense — `/me/expenses` is `agent`-only, so
  // both get 403. Callers derive this from ONE flag (D6); defaulting it true is what left the
  // admin reading a `Gastos −$0.00` row for a capability the API denies them.
  showExpenses?: boolean
}) {
  const [open, setOpen] = useState(false)
  const negative = balance.balance < 0
  // What can actually be handed in right now: cash held minus what is already pledged to a drop
  // awaiting confirmation. Mirrors the caller's own cap and the API's.
  const available = balance.balance - balance.pending_drops_total

  return (
    <SectionCard>
        {/* A real heading, still shaped like an overline: this card is the page's most important
            region and contributed nothing to the heading outline (design review, Must Fix 5). */}
        <Typography variant="overline" component="h2" color="textSecondary">
          {negative ? 'La empresa te debe' : 'Efectivo por entregar'}
        </Typography>
        {/* Money reads first — the dominant figure. Neutral ink when it's cash the seller owes;
            error red only when the company owes them. NEVER teal (teal marks the action below). */}
        <MoneyText
          cents={balance.balance}
          absolute
          semantic={negative ? 'negative' : 'neutral'}
          variant="h1"
          srLabel={negative ? 'La empresa te debe' : 'Efectivo por entregar'}
          sx={{ display: 'block', mt: 0.5 }}
        />
        {balance.pending_drops_total > 0 && (
          <Typography variant="body2" color="warning" sx={{ mt: 0.5 }}>
            {formatMoney(balance.pending_drops_total)} entregado, pendiente de confirmación
          </Typography>
        )}

        <Button
          size="small"
          color="inherit"
          onClick={() => setOpen((v) => !v)}
          endIcon={
            <ExpandMoreRounded
              sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
            />
          }
          sx={{ mt: 1, color: 'text.secondary' }}
        >
          ¿Cómo se calcula?
        </Button>
        <Collapse in={open}>
          <Divider sx={{ my: 1.5 }} />
          <Stack spacing={1}>
            {balance.carry_forward !== 0 && (
              <BreakdownRow
                label="Saldo anterior"
                value={Math.abs(balance.carry_forward)}
                sign={balance.carry_forward < 0 ? '−' : '+'}
              />
            )}
            <BreakdownRow label="Efectivo cobrado" value={balance.cash_collected} sign="+" />
            <BreakdownRow label="Comisión ganada" value={balance.commission_total} sign="−" />
            {showExpenses && (
              <BreakdownRow label="Gastos" value={balance.expense_total} sign="−" />
            )}
            {balance.payouts_total > 0 && (
              <BreakdownRow label="Pagos recibidos" value={balance.payouts_total} sign="+" />
            )}
          </Stack>
        </Collapse>

        {/* The page's single teal accent must not lead to a dead end. With nothing available to
            hand in — a zero balance, or every peso already pledged to a pending drop — the CTA
            opened a dialog whose «Todo» and «Entregar» were both disabled and whose helper read
            «Disponible para entregar: $0.00» (design review, Should Fix 9). The admin's own caja
            reuses this card and sat in exactly that state. */}
        {negative && onRegisterPayout ? (
          <Button
            variant="contained"
            size="large"
            fullWidth
            disableElevation
            onClick={onRegisterPayout}
            sx={{ mt: 2 }}
          >
            Registrar pago
          </Button>
        ) : available > 0 ? (
          <Button
            variant="contained"
            size="large"
            fullWidth
            disableElevation
            onClick={onRegisterDrop}
            sx={{ mt: 2 }}
          >
            Entregar efectivo
          </Button>
        ) : (
          <Typography variant="body2" color="textSecondary" sx={{ mt: 2 }}>
            Nada por entregar por ahora.
          </Typography>
        )}
    </SectionCard>
  )
}
