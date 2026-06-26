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
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2">
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
  showExpenses = true,
}: {
  balance: AgentBalance
  onRegisterDrop: () => void
  // Affiliates have no expenses (affiliate-portal D4) — drop the always-zero line for them.
  showExpenses?: boolean
}) {
  const [open, setOpen] = useState(false)
  const negative = balance.balance < 0

  return (
    <SectionCard>
        <Typography variant="overline" color="text.secondary">
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
          <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
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
    </SectionCard>
  )
}
