import { useState } from 'react'
import {
  Box,
  Stack,
  TextField,
  Button,
  IconButton,
  Typography,
  Alert,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import { blockoutFormSchema } from '../schemas'

// A block-out row as held in the controlled value. `id` is the stable list key (tempId / server id).
export interface BlockoutRowValue {
  id: string
  start_date: string
  end_date: string
  reason?: string
}

interface BlockoutsFieldProps {
  value: BlockoutRowValue[]
  onChange: (rows: BlockoutRowValue[]) => void
  disabled?: boolean
}

const EMPTY = { start_date: '', end_date: '', reason: '' }

// Controlled list + add-row core (mode-agnostic, no network). Reused by BlockoutsEditor (mutations)
// and the wizard's UnitDraftSheet (local draft array).
export function BlockoutsField({ value, onChange, disabled }: BlockoutsFieldProps) {
  const [draft, setDraft] = useState(EMPTY)
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    const parsed = blockoutFormSchema.safeParse({
      start_date: draft.start_date,
      end_date: draft.end_date,
      reason: draft.reason.trim() || undefined,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa las fechas del bloqueo')
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
          Sin bloqueos
        </Typography>
      )}
      {value.map((b) => (
        <Box
          key={b.id}
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
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {b.start_date} → {b.end_date}
            </Typography>
            {b.reason && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {b.reason}
              </Typography>
            )}
          </Box>
          <IconButton
            size="small"
            disabled={disabled}
            aria-label="Eliminar bloqueo"
            onClick={() => onChange(value.filter((r) => r.id !== b.id))}
            sx={{ flexShrink: 0 }}
          >
            <DeleteOutlineRounded fontSize="small" />
          </IconButton>
        </Box>
      ))}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
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
          label="Motivo (opcional)"
          size="small"
          fullWidth
          disabled={disabled}
          value={draft.reason}
          onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
        />
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Button
        startIcon={<AddRounded />}
        onClick={add}
        disabled={disabled}
        sx={{ alignSelf: 'flex-start' }}
      >
        Agregar bloqueo
      </Button>
    </Stack>
  )
}
