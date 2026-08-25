import { Link as RouterLink } from 'react-router-dom'
import { Button, Stack, Typography } from '@mui/material'
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded'
import { useBalances } from '../hooks'
import { SectionCard, MoneyText, AlertCard } from '../../../components'
import { ROUTES } from '../../../config/routes'

/**
 * The admin's way into «Caja del equipo» — BUG-041.
 *
 * US-A98 moved the admin's own caja to `/balance` and collapsed the nav's two «Caja» entries into
 * one pointing there, which was right: the word meant two things. What it got wrong is that the
 * replacement door was an AlertCard gated on `teamPending > 0`. With nothing pending — the normal
 * state — the team's balances, «Registrar cobro directo», «Registrar pago» and the whole hand-in
 * history became reachable ONLY by typing the URL.
 *
 * So the door is unconditional now, and only its TONE follows the work: an alert when hand-ins are
 * waiting, a quiet card otherwise. The quiet card is not a placeholder — it carries the figure an
 * admin opens this section for anyway («¿cuánto de mi efectivo trae la calle?»), and it costs no
 * request: `useBalances` shares the `['cash','balances']` cache the nav badge already fills.
 */
export function TeamCajaDoor() {
  const { data: balances } = useBalances()

  const pending = (balances ?? []).reduce((n, r) => n + r.pending_drops_count, 0)
  const cashInField = (balances ?? []).reduce((n, r) => n + (r.balance > 0 ? r.balance : 0), 0)
  const holders = (balances ?? []).length

  if (pending > 0) {
    return (
      <AlertCard
        tone="warning"
        title={
          pending === 1
            ? 'Una entrega del equipo espera tu confirmación'
            : `${pending} entregas del equipo esperan tu confirmación`
        }
        actions={
          <Button component={RouterLink} to={ROUTES.CASH} size="small" variant="contained">
            Ver caja del equipo
          </Button>
        }
      />
    )
  }

  return (
    <SectionCard>
      <Stack
        direction="row"
        sx={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}
      >
        <div>
          <Typography variant="overline" component="h2" color="textSecondary">
            Caja del equipo
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
            <MoneyText cents={cashInField} variant="h3" srLabel="Efectivo en la calle" />
            <Typography variant="body2" color="textSecondary">
              en la calle · {holders === 1 ? '1 persona' : `${holders} personas`}
            </Typography>
          </Stack>
        </div>
        <Button
          component={RouterLink}
          to={ROUTES.CASH}
          endIcon={<ArrowForwardRounded />}
          color="inherit"
        >
          Abrir
        </Button>
      </Stack>
    </SectionCard>
  )
}
