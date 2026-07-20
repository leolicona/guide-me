import { useState } from 'react'
import {
  Alert,
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import { FormSheet } from '../../../components'
import { ServiceError } from '../../../services/authService'
import { useZoneMutations } from '../hooks/useZones'

interface EnableZonesSheetProps {
  serviceId: string
  /** True when the service is currently Soft Cap — enabling zones clears it (warn the operator). */
  isFlexible: boolean
  open: boolean
  onClose: () => void
}

interface Draft {
  name: string
  capacity: string
}

const blank = (): Draft => ({ name: '', capacity: '' })

// US-A64 — the "Dividir en zonas" editor: define 2–6 named zones (name + seats) at once. Enabling
// clears Soft Cap (strict per-zone ceilings make the margin unreachable) — surfaced as a warning.
export function EnableZonesSheet({ serviceId, isFlexible, open, onClose }: EnableZonesSheetProps) {
  const { enable } = useZoneMutations(serviceId)
  const [rows, setRows] = useState<Draft[]>([blank(), blank()])
  const [error, setError] = useState('')

  // Reset the draft each time the sheet opens (store-previous-prop, pre-paint).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setRows([blank(), blank()])
      setError('')
    }
  }

  const setRow = (i: number, patch: Partial<Draft>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  const addRow = () => setRows((r) => (r.length < 6 ? [...r, blank()] : r))
  const removeRow = (i: number) => setRows((r) => (r.length > 2 ? r.filter((_, idx) => idx !== i) : r))

  const parsed = rows.map((r) => ({ name: r.name.trim(), capacity: Number(r.capacity) }))
  const total = parsed.reduce((sum, r) => sum + (Number.isFinite(r.capacity) ? r.capacity : 0), 0)
  const valid =
    parsed.length >= 2 &&
    parsed.length <= 6 &&
    parsed.every((r) => r.name.length > 0 && Number.isInteger(r.capacity) && r.capacity >= 1) &&
    new Set(parsed.map((r) => r.name.toLowerCase())).size === parsed.length

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid) {
      setError('Cada zona necesita un nombre único y al menos 1 asiento.')
      return
    }
    enable.mutate(
      { zones: parsed.map((r) => ({ name: r.name, capacity: r.capacity })) },
      {
        onSuccess: onClose,
        onError: (err: unknown) => {
          const e2 = err as ServiceError
          setError(
            e2?.code === 'VALIDATION_ERROR' && /assign_existing_to/.test(e2.message)
              ? 'Este servicio ya tiene ventas futuras — elige una zona para reubicarlas (aún no soportado en esta vista).'
              : 'No se pudieron crear las zonas. Revisa los datos.',
          )
        },
      },
    )
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Dividir en zonas"
      submitLabel="Activar zonas"
      busy={enable.isPending}
      disabled={!valid}
      onSubmit={submit}
      error={
        <Stack spacing={1}>
          {isFlexible && (
            <Alert severity="warning">
              Este servicio permite sobrecupo (capacidad flexible). Al usar zonas se desactivará.
            </Alert>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      }
    >
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          Divide los asientos de cada salida en zonas físicas (p. ej. Piso alto / Piso bajo). Los
          agentes venderán una zona específica.
        </Typography>
        {rows.map((row, i) => (
          <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
            <TextField
              label="Nombre"
              value={row.name}
              onChange={(e) => setRow(i, { name: e.target.value })}
              fullWidth
              slotProps={{ htmlInput: { maxLength: 40 } }}
            />
            <TextField
              label="Asientos"
              type="number"
              value={row.capacity}
              onChange={(e) => setRow(i, { capacity: e.target.value })}
              sx={{ width: 120 }}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
            <IconButton
              aria-label="Quitar zona"
              onClick={() => removeRow(i)}
              disabled={rows.length <= 2}
              sx={{ mt: 0.5, color: 'text.secondary' }}
            >
              <CloseRounded fontSize="small" />
            </IconButton>
          </Stack>
        ))}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button
            size="small"
            startIcon={<AddRounded />}
            onClick={addRow}
            disabled={rows.length >= 6}
            sx={{ color: 'text.secondary' }}
          >
            Agregar zona
          </Button>
          <Typography variant="body2" color="text.secondary" className="numeric">
            Total: {total} asientos
          </Typography>
        </Box>
      </Stack>
    </FormSheet>
  )
}
