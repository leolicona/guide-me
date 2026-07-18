import { Stack, Chip, Typography, Box } from '@mui/material'
import { todayStr, endOfMonth, endOfYear } from '../../dates'

interface QuickSelectChipsProps {
  weekdays: number[]
  onApplyRange: (start: string, end: string) => void
  onApplyWeekends: () => void
  /** Whether the Sat+Sun-only weekday set is currently active (for the chip highlight). */
}

// Sunday-indexed (0=Dom … 6=Sáb) to match the API. Weekend = Sat + Sun.
const WEEKEND = [0, 6]

/** US-A41 — one-tap presets that fill the recurring range / weekdays. Convenience only: they
 * mutate the fields below, which stay hand-editable. */
export function QuickSelectChips({
  weekdays,
  onApplyRange,
  onApplyWeekends,
}: QuickSelectChipsProps) {
  const isWeekendsActive =
    weekdays.length === 2 && WEEKEND.every((d) => weekdays.includes(d))

  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        Selección rápida
      </Typography>
      <Stack
        direction="row"
        spacing={1}
        sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 1 }}
      >
        <Chip
          label="Resto del mes"
          variant="outlined"
          onClick={() => onApplyRange(todayStr(), endOfMonth())}
        />
        <Chip
          label="Resto del año"
          variant="outlined"
          onClick={() => onApplyRange(todayStr(), endOfYear())}
        />
        <Chip
          label="Fines de semana"
          color={isWeekendsActive ? 'secondary' : 'default'}
          variant={isWeekendsActive ? 'filled' : 'outlined'}
          onClick={onApplyWeekends}
        />
      </Stack>
    </Box>
  )
}
