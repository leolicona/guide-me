import type { ReactNode } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Card, CardActionArea, CardContent, Stack, Typography } from '@mui/material'
import { AckChip } from './AckChip'
import { DropStatusChip } from './DropStatusChip'
import { SOURCE_LABEL } from './ackPresentation'
import { useOrgDateFormatter } from '../../organization'
import { MoneyText } from '../../../components'
import { ROUTES } from '../../../config/routes'
import type { CashDrop } from '../types'

const DATE_FMT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

/**
 * One hand-in, as the admin reads it. Shared by «Necesitan tu confirmación» on the team's caja and
 * by the history at `/cash/entregas` — the same card was written twice before, which is the defect
 * this whole epic is about.
 *
 * `actions` is the difference between the two: the pending block puts Confirmar / Revisar in it,
 * the history has none and makes the whole card a link to the detail instead.
 */
export function DropCard({ drop, actions }: { drop: CashDrop; actions?: ReactNode }) {
  const formatDate = useOrgDateFormatter(DATE_FMT) // US-A66 — org-local audit timestamps

  const body = (
    <CardContent>
      <Stack
        direction="row"
        // An icon-paired chip is wider than the bare colour pill it replaced, so the chip group
        // wraps to its own line rather than shredding the agent's name at 375px.
        sx={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}
      >
        <Box sx={{ minWidth: 0, flex: '1 1 12rem' }}>
          <MoneyText cents={drop.amount} variant="h3" srLabel={drop.agent?.name ?? 'Entrega'} />
          <Typography variant="caption" color="textSecondary" sx={{ display: 'block' }}>
            {drop.agent?.name} · {SOURCE_LABEL[drop.source]} · {formatDate(drop.created_at)}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <AckChip state={drop.acknowledgment} />
          <DropStatusChip status={drop.status} />
        </Stack>
      </Stack>

      {drop.note && (
        <Typography variant="body2" color="textSecondary" sx={{ mt: 1 }}>
          {drop.note}
        </Typography>
      )}
      {drop.acknowledgment === 'disputed' && drop.ack_note && (
        <Typography variant="body2" color="error" sx={{ mt: 1 }}>
          Disputa del agente: {drop.ack_note}
        </Typography>
      )}
      {actions && (
        <Stack direction="row" spacing={1} sx={{ mt: 2, flexWrap: 'wrap', rowGap: 1 }}>
          {actions}
        </Stack>
      )}
    </CardContent>
  )

  // With actions the card holds real buttons, so it must NOT also be one big link — a button
  // inside an anchor is invalid, and the tap target would be ambiguous besides.
  return (
    <Card variant="outlined">
      {actions ? (
        body
      ) : (
        <CardActionArea
          component={RouterLink}
          to={ROUTES.CASH_DROP_DETAIL.replace(':id', drop.id)}
        >
          {body}
        </CardActionArea>
      )}
    </Card>
  )
}
