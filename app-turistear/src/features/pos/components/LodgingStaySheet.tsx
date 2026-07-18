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
import { BottomSheet, MoneyText } from '../../../components'
import { DateRangeCalendar, type DateRangeValue } from './DateRangeCalendar'
import { useLodgingAvailability, useUnitTypeCalendar } from '../hooks'
import { usePosCart } from '../../../store/posCart'
import { amenityLabel } from '../../catalog/lodging'
import { todayStr, addDays } from '../dates'

/** The unit-type card the agent tapped (v2 flattened catalog — a card IS a type). */
export interface LodgingStayTarget {
  serviceId: string
  typeId: string
  name: string
  /** Parent property, shown as context under the type name. */
  propertyName?: string
  /** Per-room guest cap from the catalog card — pre-caps the guests stepper before any quote. */
  maxCapacity?: number
}

interface LodgingStaySheetProps {
  /** The unit type to sell; null closes the sheet. */
  target: LodgingStayTarget | null
  onClose: () => void
  onAdded: () => void
  /** Lodging-only date range picked in the catalog Date filter — pre-loads the stay range. */
  initialRange?: DateRangeValue | null
}

// A 48px stepper row (label + − n +), shared by Huéspedes and Habitaciones. Mirrors the guests
// control shipped in v1 so the sheet keeps its look. `max` caps the + (undefined = unbounded);
// `hint` is a quiet cap explainer shown under the label when the cap is reached.
function StepperRow({
  label,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max?: number
  hint?: string
  onChange: (v: number) => void
}) {
  const atMax = max !== undefined && value >= max
  return (
    <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        {atMax && hint && (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        )}
      </Box>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', border: '1px solid', borderColor: 'divider', borderRadius: 999, px: 0.5 }}
      >
        <IconButton
          size="small"
          aria-label={`Menos ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - 1))}
        >
          <RemoveRounded fontSize="small" />
        </IconButton>
        <Typography sx={{ minWidth: 36, textAlign: 'center', fontWeight: 600 }} className="numeric">
          {value}
        </Typography>
        <IconButton
          size="small"
          aria-label={`Más ${label.toLowerCase()}`}
          color="secondary"
          disabled={atMax}
          onClick={() => onChange(max !== undefined ? Math.min(max, value + 1) : value + 1)}
        >
          <AddRounded fontSize="small" />
        </IconButton>
      </Stack>
    </Stack>
  )
}

// US-AG36/AG37 (v2 — unit-type inventory): the type-centric stay sheet. The agent tapped a TYPE
// card, so the sheet is that type's remaining-count calendar + a check-in/check-out range +
// guests and ROOMS steppers (D12); the quote comes live from the range-first availability read
// (filtered to this type) and adding puts one stay line (`quantity` rooms) in the cart. The
// server re-quotes and enforces the per-night count guard at confirm (409 INSUFFICIENT_INVENTORY).
export function LodgingStaySheet({
  target,
  onClose,
  onAdded,
  initialRange,
}: LodgingStaySheetProps) {
  const today = todayStr()
  const addStayLine = usePosCart((s) => s.addStayLine)
  const emptyRange: DateRangeValue = { check_in: null, check_out: null }
  const [range, setRange] = useState<DateRangeValue>(() => initialRange ?? emptyRange)
  const [guests, setGuests] = useState(2)
  const [rooms, setRooms] = useState(1)

  // The per-room capacity — caps the guests stepper so the agent can't walk into a silent
  // "no quote" dead-end. Seeded from the catalog card (known before any quote); the live quote
  // re-confirms it.
  const [perRoomCapacity, setPerRoomCapacity] = useState<number | null>(
    target?.maxCapacity ?? null,
  )

  // Reset each time the sheet opens (target goes truthy), pre-loading any range the agent
  // picked in the catalog filter. "Store previous prop" pattern — reset lands before paint.
  const [wasOpen, setWasOpen] = useState(!!target)
  if (!!target !== wasOpen) {
    setWasOpen(!!target)
    if (target) {
      setRange(initialRange ?? emptyRange)
      setGuests(2)
      setRooms(1)
      setPerRoomCapacity(target.maxCapacity ?? null)
    }
  }

  // The type's 90-day remaining-count window → disables nights with fewer free rooms than
  // requested, directly on the range picker (the v1 separate unit calendar is absorbed here).
  // The same read carries the type's total inventory — the rooms-stepper ceiling.
  const { data: calendar, isLoading: calendarLoading } = useUnitTypeCalendar(
    target?.typeId ?? '',
    { from: today, to: addDays(today, 90) },
    !!target,
  )
  const dayRemaining = new Map((calendar?.days ?? []).map((d) => [d.date, d.remaining]))
  const maxRooms = calendar?.inventory_count

  // Live quote for the picked range × rooms — the same read the range-first flow uses, scoped
  // to this type. No quote row ⇒ the type can't take the request (inventory/min-stay/capacity).
  const { data: avail, isFetching: quoteLoading } = useLodgingAvailability(
    target?.serviceId ?? '',
    {
      check_in: range.check_in ?? '',
      check_out: range.check_out ?? '',
      guests,
      quantity: rooms,
    },
  )
  const quoted = avail?.unit_types.find((t) => t.unit_type_id === target?.typeId)
  const rangeComplete = !!range.check_in && !!range.check_out

  // Learn the per-room capacity from any successful quote → guests cap = capacity × rooms.
  // (Derived-state-in-render pattern: conditional and converging, same as the open reset.)
  if (quoted && quoted.max_capacity !== perRoomCapacity) {
    setPerRoomCapacity(quoted.max_capacity)
  }
  const maxGuests = perRoomCapacity != null ? perRoomCapacity * rooms : undefined

  // Reducing rooms may strand guests above the new cap — clamp them together.
  const changeRooms = (next: number) => {
    setRooms(next)
    if (perRoomCapacity != null) {
      setGuests((g) => Math.min(g, perRoomCapacity * next))
    }
  }

  const add = () => {
    if (!target || !quoted || !range.check_in || !range.check_out) return
    addStayLine({
      service: {
        id: target.serviceId,
        name: target.propertyName ?? target.name,
        base_price: 0,
        minimum_price: 0,
      },
      unit_type_id: target.typeId,
      unit_type_name: target.name,
      check_in: range.check_in,
      check_out: range.check_out,
      guests,
      quantity: rooms,
      nights: quoted.nights,
      total: quoted.total,
      per_night: quoted.per_night,
    })
    setRange(emptyRange)
    onAdded()
  }

  return (
    <BottomSheet
      open={!!target}
      onClose={onClose}
      header={
        <Box sx={{ px: 2, pb: 1 }}>
          <Typography variant="h6">{target?.name}</Typography>
          {target?.propertyName && (
            <Typography variant="body2" color="text.secondary">
              {target.propertyName}
            </Typography>
          )}
        </Box>
      }
      footer={
        <Box sx={{ p: 2 }}>
          <Button
            fullWidth
            variant="contained"
            disableElevation
            onClick={add}
            disabled={!rangeComplete || !quoted || quoteLoading}
          >
            {!rangeComplete ? (
              'Elige las fechas'
            ) : quoteLoading ? (
              <CircularProgress size={22} color="inherit" />
            ) : quoted ? (
              <>
                Agregar ·{' '}
                <MoneyText
                  cents={quoted.total}
                  variant="body1"
                  sx={{ color: 'inherit', ml: 0.5 }}
                  srLabel="Total de la estancia"
                />
              </>
            ) : (
              'No disponible para esas fechas'
            )}
          </Button>
        </Box>
      }
    >
      <Box sx={{ px: 2, pb: 2 }}>
        {calendarLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <DateRangeCalendar
            value={range}
            onChange={setRange}
            today={today}
            dayRemaining={dayRemaining}
            requiredQuantity={rooms}
          />
        )}

        <Stack spacing={1.5} sx={{ mt: 2 }}>
          <StepperRow
            label="Huéspedes"
            value={guests}
            min={1}
            max={maxGuests}
            hint={
              maxRooms !== undefined && rooms < maxRooms
                ? 'Capacidad máxima — agrega otra habitación'
                : 'Capacidad máxima de este tipo'
            }
            onChange={setGuests}
          />
          {/* D12 — the room-quantity stepper (replaces the v1 physical-unit list), capped at
              the type's inventory so an impossible request can never be formed. */}
          <StepperRow
            label="Habitaciones"
            value={rooms}
            min={1}
            max={maxRooms}
            hint={maxRooms !== undefined ? `Este tipo tiene ${maxRooms} en total` : undefined}
            onChange={changeRooms}
          />
        </Stack>

        {/* Quote context: capacity + low-inventory hint + amenities, once a range is quoted. */}
        {quoted && (
          <>
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="caption" color="text.secondary">
                {quoted.nights} {quoted.nights === 1 ? 'noche' : 'noches'} · hasta{' '}
                {quoted.max_capacity * rooms} personas
              </Typography>
              {quoted.min_remaining <= 2 && (
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  label={`Quedan ${quoted.min_remaining}`}
                  sx={{ borderRadius: 'var(--radius-full, 9999px)' }}
                />
              )}
            </Stack>
            {quoted.amenities.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                {quoted.amenities.slice(0, 4).map((a) => (
                  <Chip
                    key={a}
                    size="small"
                    label={amenityLabel(a)}
                    sx={{ borderRadius: 'var(--radius-full, 9999px)' }}
                  />
                ))}
              </Box>
            )}
          </>
        )}
        {rangeComplete && !quoted && !quoteLoading && (
          <Typography color="text.secondary" variant="body2" sx={{ mt: 2 }}>
            No hay disponibilidad para esa combinación. Ajusta las fechas, el número de
            huéspedes o las habitaciones.
          </Typography>
        )}
      </Box>
    </BottomSheet>
  )
}
