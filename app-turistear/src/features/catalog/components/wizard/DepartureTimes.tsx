import { useState } from 'react'
import { Box, Stack, TextField, Button, Chip, Typography } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import ScheduleRounded from '@mui/icons-material/ScheduleRounded'
import type { DepartureTime } from './wizardTypes'

interface DepartureTimesProps {
  times: DepartureTime[]
  onChange: (times: DepartureTime[]) => void
}

/** US-A42 — add multiple departure times. Add is disabled while empty; duplicates are
 * rejected; each time is a removable pill. Sorted for a tidy, predictable list. */
export function DepartureTimes({ times, onChange }: DepartureTimesProps) {
  const [draft, setDraft] = useState('')

  const add = () => {
    if (!draft || times.includes(draft)) return
    onChange([...times, draft].sort())
    setDraft('')
  }

  const remove = (t: DepartureTime) => onChange(times.filter((x) => x !== t))

  const isDuplicate = !!draft && times.includes(draft)

  return (
    <Box>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
        Horarios de salida
      </Typography>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <TextField
          label="Hora"
          type="time"
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          error={isDuplicate}
          helperText={isDuplicate ? 'Ese horario ya está agregado' : ' '}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ width: 150 }}
        />
        <Button
          onClick={add}
          disabled={!draft || isDuplicate}
          startIcon={<AddRounded />}
          variant="outlined"
          color="secondary"
          sx={{ mt: 0.25, flexShrink: 0 }}
        >
          Agregar
        </Button>
      </Stack>

      {times.length > 0 ? (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
          {times.map((t) => (
            <Chip
              key={t}
              icon={<ScheduleRounded sx={{ fontSize: 18 }} />}
              label={t}
              onDelete={() => remove(t)}
              color="secondary"
              variant="outlined"
            />
          ))}
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Agrega al menos un horario (p. ej. 09:00 y 12:00).
        </Typography>
      )}
    </Box>
  )
}
