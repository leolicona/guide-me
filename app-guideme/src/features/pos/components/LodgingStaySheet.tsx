import { useState } from 'react'
import {
  Box,
  Typography,
  Stack,
  IconButton,
  CircularProgress,
  Chip,
  Button,
  Divider,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import RemoveRounded from '@mui/icons-material/RemoveRounded'
import { BottomSheet, MoneyText, SectionCard } from '../../../components'
import { DateRangeCalendar, type DateRangeValue } from './DateRangeCalendar'
import { UnitCalendarSheet } from './UnitCalendarSheet'
import { useLodgingAvailability } from '../hooks'
import { usePosCart } from '../../../store/posCart'
import { amenityLabel } from '../../catalog/lodging'
import { todayStr } from '../dates'

interface LodgingStaySheetProps {
  /** The lodging service to sell; null closes the sheet. */
  service: { id: string; name: string } | null
  onClose: () => void
  onAdded: () => void
  /** Lodging-only date range picked in the catalog Date filter — pre-loads the stay range. */
  initialRange?: DateRangeValue | null
}

// US-AG36 — range-first: pick a check-in/check-out range + guests, see the units available for the
// whole range with their computed totals (total reads first), tap one to add a stay line. When the
// agent picked a date range in the catalog Date filter it flows in as `initialRange` (lodging-only).
export function LodgingStaySheet({
  service,
  onClose,
  onAdded,
  initialRange,
}: LodgingStaySheetProps) {
  const today = todayStr()
  const addStayLine = usePosCart((s) => s.addStayLine)
  const emptyRange: DateRangeValue = { check_in: null, check_out: null }
  const [range, setRange] = useState<DateRangeValue>(() => initialRange ?? emptyRange)
  const [guests, setGuests] = useState(2)
  const [calendarUnit, setCalendarUnit] = useState<{ unitId: string; unitName: string } | null>(null)

  // Reset the range each time the sheet opens (service goes truthy), pre-loading any range the
  // agent picked in the catalog filter. "Store previous prop" pattern — reset lands before paint.
  const [wasOpen, setWasOpen] = useState(!!service)
  if (!!service !== wasOpen) {
    setWasOpen(!!service)
    if (service) setRange(initialRange ?? emptyRange)
  }

  const { data, isLoading, isError } = useLodgingAvailability(service?.id ?? '', {
    check_in: range.check_in ?? '',
    check_out: range.check_out ?? '',
    guests,
  })

  const rangeComplete = !!range.check_in && !!range.check_out
  const units = data?.units ?? []

  const handlePick = (unit: (typeof units)[number]) => {
    if (!service || !range.check_in || !range.check_out) return
    addStayLine({
      service: { id: service.id, name: service.name, base_price: 0, minimum_price: 0 },
      unit_id: unit.unit_id,
      unit_name: unit.name,
      check_in: range.check_in,
      check_out: range.check_out,
      guests,
      nights: unit.nights,
      total: unit.total,
      per_night: unit.per_night,
    })
    setRange({ check_in: null, check_out: null })
    onAdded()
  }

  return (
    <BottomSheet
      open={!!service}
      onClose={onClose}
      header={
        <Box sx={{ px: 2, pb: 1 }}>
          <Typography variant="h6">{service?.name}</Typography>
        </Box>
      }
    >
      <Box sx={{ px: 2, pb: 2 }}>
        <DateRangeCalendar value={range} onChange={setRange} today={today} />

        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mt: 2 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Huéspedes
          </Typography>
          <Stack
            direction="row"
            sx={{ alignItems: 'center', border: '1px solid', borderColor: 'divider', borderRadius: 999, px: 0.5 }}
          >
            <IconButton
              size="small"
              aria-label="Menos huéspedes"
              disabled={guests <= 1}
              onClick={() => setGuests((g) => Math.max(1, g - 1))}
            >
              <RemoveRounded fontSize="small" />
            </IconButton>
            <Typography sx={{ minWidth: 36, textAlign: 'center', fontWeight: 600 }} className="numeric">
              {guests}
            </Typography>
            <IconButton
              size="small"
              aria-label="Más huéspedes"
              color="secondary"
              onClick={() => setGuests((g) => g + 1)}
            >
              <AddRounded fontSize="small" />
            </IconButton>
          </Stack>
        </Stack>

        <Divider sx={{ my: 2 }} />

        {!rangeComplete ? (
          <Typography color="text.secondary" variant="body2">
            Elige las fechas de entrada y salida para ver las unidades disponibles.
          </Typography>
        ) : isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : isError ? (
          <Typography color="error" variant="body2">
            No se pudo cargar la disponibilidad. Inténtalo de nuevo.
          </Typography>
        ) : units.length === 0 ? (
          <Typography color="text.secondary" variant="body2">
            No hay unidades disponibles para esas fechas.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {units.map((unit) => (
              <SectionCard key={unit.unit_id} padded sx={{ p: 2 }}>
                <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography sx={{ fontWeight: 600 }}>{unit.name}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {unit.nights} {unit.nights === 1 ? 'noche' : 'noches'} · hasta{' '}
                      {unit.max_capacity} personas
                    </Typography>
                  </Box>
                  <MoneyText cents={unit.total} variant="subtitle1" srLabel="Total de la estancia" />
                </Stack>
                {unit.amenities.length > 0 && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                    {unit.amenities.slice(0, 3).map((a) => (
                      <Chip key={a} size="small" label={amenityLabel(a)} sx={{ borderRadius: 'var(--radius-full, 9999px)' }} />
                    ))}
                  </Box>
                )}
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  <Button
                    variant="contained"
                    color="secondary"
                    disableElevation
                    startIcon={<AddRounded />}
                    onClick={() => handlePick(unit)}
                  >
                    Agregar
                  </Button>
                  <Button onClick={() => setCalendarUnit({ unitId: unit.unit_id, unitName: unit.name })}>
                    Ver calendario
                  </Button>
                </Stack>
              </SectionCard>
            ))}
          </Stack>
        )}
      </Box>

      {/* US-AG37 — unit-first calendar, opened from a unit's "Ver calendario". */}
      {service && (
        <UnitCalendarSheet
          target={
            calendarUnit
              ? { service, unitId: calendarUnit.unitId, unitName: calendarUnit.unitName }
              : null
          }
          guests={guests}
          onClose={() => setCalendarUnit(null)}
          onAdded={() => {
            setCalendarUnit(null)
            onAdded()
          }}
        />
      )}
    </BottomSheet>
  )
}
