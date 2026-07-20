import { useFormContext } from 'react-hook-form'
import {
  Stack,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Box,
  Typography,
  Collapse,
  Divider,
  FormHelperText,
  IconButton,
  Button,
  Alert,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import CloseRounded from '@mui/icons-material/CloseRounded'
import { FLEX_CAP_MAX_PCT } from '../../types'
import { todayStr } from '../../dates'
import type { WizardFormData } from './wizardSchema'
import { StepIntro } from './StepIntro'
import { QuickSelectChips } from './QuickSelectChips'
import { DepartureTimes } from './DepartureTimes'
import type { DepartureTime, ZoneDraft } from './wizardTypes'

// Mon-first visual order with single-letter initials, while preserving the API's
// Sunday-indexed (0=Dom … 6=Sáb) values.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const WEEKDAY_INITIAL: Record<number, string> = {
  1: 'L',
  2: 'M',
  3: 'M',
  4: 'J',
  5: 'V',
  6: 'S',
  0: 'D',
}
const WEEKEND = [0, 6]

interface StepAvailabilityProps {
  times: DepartureTime[]
  onTimesChange: (times: DepartureTime[]) => void
  /** True once the operator has tried to advance, so we can show the "≥1 time" guard. */
  showTimesError: boolean
  /** US-A64 — wizard-local zone drafts (empty = unzoned). */
  zones: ZoneDraft[]
  onZonesChange: (zones: ZoneDraft[]) => void
  /** True once the operator tried to advance, so we can flag an incomplete zone set. */
  showZonesError: boolean
}

const blankZone = (): ZoneDraft => ({ tempId: crypto.randomUUID(), name: '', capacity: 0 })

/** Step 3 — Availability & Departure Times (US-A41, US-A42) + optional zones (US-A64). */
export function StepAvailability({
  times,
  onTimesChange,
  showTimesError,
  zones,
  onZonesChange,
  showZonesError,
}: StepAvailabilityProps) {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<WizardFormData>()

  const today = todayStr()
  const isFlexible = watch('is_flexible')
  const flexPct = watch('flex_capacity_pct')
  const baseCapacity = watch('default_capacity')
  const frequency = watch('frequency')
  const weekdays = watch('weekdays')

  const extraPlaces =
    isFlexible && flexPct >= 1 && baseCapacity >= 1
      ? Math.floor((baseCapacity * flexPct) / 100)
      : 0

  // US-A64 — capacity model is a single 3-way choice: a strict single pool, a flexible single pool
  // (Soft Cap, US-A36), or physical zones. The three are mutually exclusive by construction (zones
  // are always strict), so one segmented control replaces the old cap-mode toggle + zones checkbox.
  const zonesEnabled = zones.length > 0
  const zonesTotal = zones.reduce((sum, z) => sum + (z.capacity || 0), 0)
  const capMode: 'hard' | 'flex' | 'zones' = zonesEnabled ? 'zones' : isFlexible ? 'flex' : 'hard'
  const setCapMode = (mode: 'hard' | 'flex' | 'zones') => {
    if (mode === 'zones') {
      setValue('is_flexible', false, { shouldValidate: true })
      setValue('flex_capacity_pct', 0, { shouldValidate: true })
      if (zones.length === 0) onZonesChange([blankZone(), blankZone()])
    } else {
      onZonesChange([]) // leaving zone mode clears the drafts
      const flex = mode === 'flex'
      setValue('is_flexible', flex, { shouldValidate: true })
      if (!flex) setValue('flex_capacity_pct', 0, { shouldValidate: true })
    }
  }
  const setZone = (tempId: string, patch: Partial<ZoneDraft>) =>
    onZonesChange(zones.map((z) => (z.tempId === tempId ? { ...z, ...patch } : z)))
  const addZone = () => zones.length < 6 && onZonesChange([...zones, blankZone()])
  const removeZone = (tempId: string) =>
    zones.length > 2 && onZonesChange(zones.filter((z) => z.tempId !== tempId))
  const toggleWeekday = (next: number[]) =>
    setValue('weekdays', next, { shouldValidate: true })

  const applyWeekends = () => {
    const isActive =
      weekdays.length === 2 && WEEKEND.every((d) => weekdays.includes(d))
    setValue('weekdays', isActive ? [] : [...WEEKEND], { shouldValidate: true })
  }

  const applyRange = (start: string, end: string) => {
    setValue('start_date', start, { shouldValidate: true })
    setValue('end_date', end, { shouldValidate: true })
  }

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="¿Cuándo opera?"
        subtitle="Define el cupo, el tipo de fecha y los horarios de salida. Así controlas el inventario y evitas sobreventa."
      />

      {/* Capacity model (US-A36 + US-A64): the single decision of how seats are counted —
          a strict pool, a flexible pool, or physical zones. */}
      <Box>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Tipo de cupo
        </Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={capMode}
          onChange={(_, v: 'hard' | 'flex' | 'zones' | null) => v && setCapMode(v)}
          aria-label="Tipo de cupo"
        >
          <ToggleButton value="hard">Estricto</ToggleButton>
          <ToggleButton value="flex">Flexible</ToggleButton>
          <ToggleButton value="zones">Por zonas</ToggleButton>
        </ToggleButtonGroup>

        {/* Single-pool modes: a capacity number (+ overbooking margin when flexible). */}
        {capMode !== 'zones' && (
          <>
            <TextField
              label="Capacidad por horario"
              type="number"
              fullWidth
              error={!!errors.default_capacity}
              helperText={errors.default_capacity?.message ?? 'Lugares disponibles en cada salida'}
              slotProps={{ htmlInput: { step: 1, min: 1, inputMode: 'numeric' } }}
              sx={{ mt: 2 }}
              {...register('default_capacity', { valueAsNumber: true })}
            />
            <Collapse in={capMode === 'flex'} unmountOnExit>
              <TextField
                label="Lugares extra permitidos"
                type="number"
                fullWidth
                error={!!errors.flex_capacity_pct}
                helperText={
                  errors.flex_capacity_pct?.message ??
                  (extraPlaces > 0
                    ? `Permite sobrevender ~${extraPlaces} lugar${extraPlaces > 1 ? 'es' : ''} por horario con cupo ${baseCapacity}. Asegura ventas de último minuto sin sobrepasar la operación.`
                    : `Tolerancia de sobreventa, entre 1% y ${FLEX_CAP_MAX_PCT}% del cupo.`)
                }
                slotProps={{
                  input: {
                    endAdornment: <InputAdornment position="end">%</InputAdornment>,
                  },
                  htmlInput: { step: 1, min: 1, max: FLEX_CAP_MAX_PCT, inputMode: 'numeric' },
                }}
                sx={{ mt: 2 }}
                {...register('flex_capacity_pct', { valueAsNumber: true })}
              />
            </Collapse>
          </>
        )}

        {/* Zones: the capacity number is replaced by the per-zone seat editor (2–6 zones). */}
        {capMode === 'zones' && (
          <Stack spacing={2} sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Divide los asientos de cada salida en zonas físicas (p. ej. Piso alto / Piso bajo)
              para venderlas por separado. El cupo total es la suma de las zonas.
            </Typography>
            {zones.map((zone) => (
              <Stack key={zone.tempId} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                <TextField
                  label="Nombre"
                  value={zone.name}
                  onChange={(e) => setZone(zone.tempId, { name: e.target.value })}
                  fullWidth
                  slotProps={{ htmlInput: { maxLength: 40 } }}
                />
                <TextField
                  label="Asientos"
                  type="number"
                  value={zone.capacity || ''}
                  onChange={(e) => setZone(zone.tempId, { capacity: Number(e.target.value) })}
                  sx={{ width: 120 }}
                  slotProps={{ htmlInput: { min: 1, step: 1, inputMode: 'numeric' } }}
                />
                <IconButton
                  aria-label="Quitar zona"
                  onClick={() => removeZone(zone.tempId)}
                  disabled={zones.length <= 2}
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
                onClick={addZone}
                disabled={zones.length >= 6}
                sx={{ color: 'text.secondary' }}
              >
                Agregar zona
              </Button>
              <Typography variant="body2" color="text.secondary" className="numeric">
                Total: {zonesTotal} asientos
              </Typography>
            </Box>
            {showZonesError && (
              <Alert severity="error">
                Cada zona necesita un nombre único y al menos 1 asiento (2–6 zonas).
              </Alert>
            )}
          </Stack>
        )}
      </Box>

      <Divider />

      {/* Frequency (US-A41) */}
      <Box>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Frecuencia
        </Typography>
        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={frequency}
          onChange={(_, v) => {
            if (v) setValue('frequency', v, { shouldValidate: true })
          }}
          aria-label="Frecuencia"
        >
          <ToggleButton value="single">Fecha única</ToggleButton>
          <ToggleButton value="recurring">Recurrente</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* Single date */}
      <Collapse in={frequency === 'single'} unmountOnExit>
        <TextField
          label="Fecha"
          type="date"
          fullWidth
          error={!!errors.single_date}
          helperText={errors.single_date?.message}
          slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: today } }}
          {...register('single_date')}
        />
      </Collapse>

      {/* Recurring */}
      <Collapse in={frequency === 'recurring'} unmountOnExit>
        <Stack spacing={2.5}>
          <QuickSelectChips
            weekdays={weekdays}
            onApplyRange={applyRange}
            onApplyWeekends={applyWeekends}
          />

          <Box>
            <Typography variant="caption" color="text.secondary">
              Días de operación
            </Typography>
            <ToggleButtonGroup
              value={weekdays}
              onChange={(_, value: number[]) => toggleWeekday(value)}
              size="small"
              sx={{ display: 'flex', mt: 0.75 }}
            >
              {WEEKDAY_ORDER.map((day) => (
                <ToggleButton
                  key={day}
                  value={day}
                  aria-label={`día ${day}`}
                  sx={{ flex: 1, fontWeight: 600 }}
                >
                  {WEEKDAY_INITIAL[day]}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            {errors.weekdays && (
              <FormHelperText error>{errors.weekdays.message}</FormHelperText>
            )}
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Desde"
              type="date"
              fullWidth
              error={!!errors.start_date}
              helperText={errors.start_date?.message}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: today } }}
              {...register('start_date')}
            />
            <TextField
              label="Hasta"
              type="date"
              fullWidth
              error={!!errors.end_date}
              helperText={errors.end_date?.message}
              slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: today } }}
              {...register('end_date')}
            />
          </Stack>
        </Stack>
      </Collapse>

      <Divider />

      {/* Departure times (US-A42) */}
      <Box>
        <DepartureTimes times={times} onChange={onTimesChange} />
        {showTimesError && times.length === 0 && (
          <FormHelperText error sx={{ mt: 0.5 }}>
            Agrega al menos un horario de salida
          </FormHelperText>
        )}
      </Box>
    </Stack>
  )
}
