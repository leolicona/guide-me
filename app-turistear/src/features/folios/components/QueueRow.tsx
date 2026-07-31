import { Box, Card, CardActionArea, Stack, Typography } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded'
import { MoneyText } from '../../../components'
import { ROUTES } from '../../../config/routes'

// US-A78/A79 (docs/oversight/pending-work-queues.spec.md) — one row of a work queue. Shared by
// both tabs because they answer the same shape of question: who, how much, and FOR HOW LONG.
//
// Age is the whole reason these screens exist (spec Q5), so it is rendered as a first-class,
// icon-paired functional colour — never colour alone, never teal. The thresholds are display
// only: nothing in the engine reads them.

const HOUR = 3600
const AMBER_AFTER = 24 * HOUR
const RED_AFTER = 72 * HOUR

interface AgeTone {
  color: 'text.secondary' | 'warning.main' | 'error.main'
  icon: ReactNode
}

const ageTone = (seconds: number): AgeTone => {
  if (seconds >= RED_AFTER) return { color: 'error.main', icon: <ErrorOutlineRounded fontSize="small" /> }
  if (seconds >= AMBER_AFTER) return { color: 'warning.main', icon: <WarningAmberRounded fontSize="small" /> }
  return { color: 'text.secondary', icon: <ScheduleRounded fontSize="small" /> }
}

// "hace 3 días" / "hace 5 h" / "hace 20 min" — Spanish, coarse on purpose. An exact timestamp
// answers a question nobody asked; the admin wants to know if this is old.
const formatAge = (seconds: number): string => {
  const s = Math.max(0, seconds)
  if (s < HOUR) return `hace ${Math.max(1, Math.floor(s / 60))} min`
  if (s < 24 * HOUR) return `hace ${Math.floor(s / HOUR)} h`
  const days = Math.floor(s / (24 * HOUR))
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`
}

export interface QueueRowProps {
  folioId: string
  customerName: string | null
  agentName: string
  /** Amount owed, in minor units. Rendered as a magnitude — the direction is in the label. */
  amountCents: number
  amountLabel: string
  /** Seconds elapsed, or null while the clock is still unknown (first render). */
  ageSeconds: number | null
  /** What the age measures, e.g. "cancelado" / "venció". */
  ageLabel: string
}

export function QueueRow({
  folioId,
  customerName,
  agentName,
  amountCents,
  amountLabel,
  ageSeconds,
  ageLabel,
}: QueueRowProps) {
  const tone = ageTone(ageSeconds ?? 0)

  return (
    <Card variant="outlined">
      <CardActionArea
        component={RouterLink}
        to={ROUTES.FOLIO_DETAIL.replace(':id', folioId)}
        sx={{ p: 2.5 }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={{ xs: 1.5, sm: 2 }}
          sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
              {customerName || 'Sin nombre'}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {agentName}
            </Typography>
          </Box>

          <Stack
            direction="row"
            spacing={2}
            sx={{ alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}
          >
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: tone.color }}>
              {tone.icon}
              <Typography variant="body2" sx={{ color: 'inherit', fontWeight: 600 }}>
                {ageSeconds === null ? ageLabel : `${ageLabel} ${formatAge(ageSeconds)}`}
              </Typography>
            </Stack>

            <MoneyText
              cents={amountCents}
              absolute
              variant="h6"
              srLabel={amountLabel}
              sx={{ fontWeight: 700 }}
            />
          </Stack>
        </Stack>
      </CardActionArea>
    </Card>
  )
}
