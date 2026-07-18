import { useState } from 'react'
import {
  Box,
  Stack,
  TextField,
  Button,
  IconButton,
  Typography,
  InputAdornment,
  Alert,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import { MoneyText } from '../../../components'
import { amountToCents } from '../types'
import { seasonFormSchema, seasonOverlaps } from '../schemas'

// A season row as held in the controlled value — money as a major-unit decimal. `id` is the
// stable list key (a client tempId in the wizard, the server id in the editor).
export interface SeasonRowValue {
  id: string
  name: string
  start_date: string
  end_date: string
  nightly_rate: number
}

interface SeasonsFieldProps {
  value: SeasonRowValue[]
  onChange: (rows: SeasonRowValue[]) => void
  disabled?: boolean
}

const EMPTY = { name: '', start_date: '', end_date: '', nightly_rate: '' }

// Controlled list + add-row core (mode-agnostic, no network). Runs the client-side overlap guard
// inline; the API's 409 SEASON_OVERLAP stays the backstop. Reused by SeasonsEditor (mutations)
// and the wizard's UnitDraftSheet (local draft array).
export function SeasonsField({ value, onChange, disabled }: SeasonsFieldProps) {
  const [draft, setDraft] = useState(EMPTY)
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    const parsed = seasonFormSchema.safeParse({
      name: draft.name.trim(),
      start_date: draft.start_date,
      end_date: draft.end_date,
      nightly_rate: Number(draft.nightly_rate),
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos de la temporada')
      return
    }
    if (seasonOverlaps(parsed.data, value)) {
      setError('Esta temporada se traslapa con otra.')
      return
    }
    onChange([...value, { id: crypto.randomUUID(), ...parsed.data }])
    setDraft(EMPTY)
    setError(null)
  }

  return (
    <Stack spacing={1.5}>
      {value.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Sin temporadas
        </Typography>
      )}
      {value.map((s) => (
        <Box
          key={s.id}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            border: '1px solid var(--slate-200, #E2E8F0)',
            borderRadius: 'var(--radius-md, 12px)',
            px: 1.5,
            py: 1,
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
              {s.name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {s.start_date} → {s.end_date}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
            <MoneyText cents={amountToCents(s.nightly_rate)} variant="body2" />
            <IconButton
              size="small"
              disabled={disabled}
              aria-label={`Eliminar temporada ${s.name}`}
              onClick={() => onChange(value.filter((r) => r.id !== s.id))}
            >
              <DeleteOutlineRounded fontSize="small" />
            </IconButton>
          </Stack>
        </Box>
      ))}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField
          label="Nombre"
          size="small"
          fullWidth
          disabled={disabled}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <TextField
          label="Desde"
          type="date"
          size="small"
          fullWidth
          disabled={disabled}
          value={draft.start_date}
          onChange={(e) => setDraft({ ...draft, start_date: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="Hasta"
          type="date"
          size="small"
          fullWidth
          disabled={disabled}
          value={draft.end_date}
          onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="Tarifa"
          type="number"
          size="small"
          fullWidth
          disabled={disabled}
          value={draft.nightly_rate}
          onChange={(e) => setDraft({ ...draft, nightly_rate: e.target.value })}
          slotProps={{
            input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
            htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
          }}
        />
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Button
        startIcon={<AddRounded />}
        onClick={add}
        disabled={disabled}
        sx={{ alignSelf: 'flex-start' }}
      >
        Agregar temporada
      </Button>
    </Stack>
  )
}
