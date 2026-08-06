import { useMemo, useState, type FormEvent } from 'react'
import {
  Alert,
  Box,
  ButtonBase,
  Button,
  Collapse,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import { FormSheet } from '../../../components'
import { useRescheduleFolio } from '../hooks/useBookingActions'
import type { RescheduleLine } from '../hooks/useBookingActions'
import { usePosService } from '../../pos/hooks/usePosService'
import { effectiveRemaining } from '../../pos/capacity'
import { DateRangeCalendar } from '../../pos/components/DateRangeCalendar'
import { addDays } from '../../pos/dates'

// US-AG52 — reagendar mientras el lugar es tuyo.
// Spec: docs/bookings/booking-reschedule.spec.md (D2, D11, D16, D19).
//
// A `FormSheet`, never a Dialog — the design system reserves Dialogs for nothing, and every entity
// edit in this product is a sheet.
//
// A DAY PAGER, opening on the FIRST day that has room. The counter's conversation is "¿cuándo
// puedes?" answered with the nearest real options: one day on screen, its remaining times as
// chips, and ◀ ▶ stepping ONLY between days that can seat the group — a day the service does not
// operate simply does not exist here, the same rule the POS matrix applies (US-AG33: never
// mislabel a non-operating day "Agotado"). For "¿y en dos semanas?" the seller opens the same
// calendar the POS already taught them (`DateRangeCalendar`), days without room disabled, and one
// tap jumps the pager there.
//
// The slots come from the SELECTED line's service (D11), 60 days ahead (the POS default window is
// 3 days — right for walk-ups, useless for "¿la otra semana?"), filtered by the same
// effective-capacity arithmetic the POS sale applies. The server re-checks everything; the sheet
// exists to never offer what the server will refuse.
//
// The copy carries D2, which is the point of the whole feature: this is a HUMAN action agreed by
// both parties, and the record will have the seller's name on it.

/** How far ahead the sheet looks. */
const HORIZON_DAYS = 60

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** "Viernes 7 ago" — the pager's one-day headline. */
const dayHeadline = (date: string) => {
  const d = new Date(`${date}T00:00:00`)
  const label = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'short' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export interface RescheduleSheetProps {
  open: boolean
  onClose: () => void
  folioId: string
  /** Only tour lines the server would accept; a stay is deferred, a departed line reads no-show. */
  lines: RescheduleLine[]
  /** A paid folio's ticket is re-issued and the old link stops working (D16). */
  isPaid: boolean
}

export function RescheduleSheet({ open, onClose, folioId, lines, isPaid }: RescheduleSheetProps) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? '')
  /** The day the pager shows; null = "the first day with room" once data arrives. */
  const [dateOverride, setDateOverride] = useState<string | null>(null)
  const [slotId, setSlotId] = useState('')
  const [calendarOpen, setCalendarOpen] = useState(false)
  const reschedule = useRescheduleFolio()

  const current = lines.find((l) => l.id === lineId)

  // Only asked for while the sheet is open: a folio detail should not fetch a service's calendar
  // for a button nobody pressed. Keyed on the SELECTED line, so switching lines switches calendars.
  const range = useMemo(() => {
    const today = new Date()
    const to = new Date(today.getTime() + HORIZON_DAYS * 86_400_000)
    return { from: isoDay(today), to: isoDay(to) }
  }, [])
  const service = usePosService(open ? current?.service_id : undefined, range)

  const quantity = current?.quantity ?? 1
  const fitting = useMemo(() => {
    const slots = service.data?.slots ?? []
    const isFlexible = service.data?.is_flexible ?? false
    const flexPct = service.data?.flex_capacity_pct ?? 0
    return slots
      .filter(
        (s) =>
          // Moving a line onto its own slot is not a move.
          s.id !== current?.slot_id &&
          effectiveRemaining(s, isFlexible, flexPct) >= quantity,
      )
      .map((s) => ({
        id: s.id,
        date: s.date,
        start_time: s.start_time,
        remaining: effectiveRemaining(s, isFlexible, flexPct),
      }))
  }, [service.data, current?.slot_id, quantity])

  /** The pager's axis: only days that can seat the whole group, nearest first. */
  const dates = useMemo(() => [...new Set(fitting.map((s) => s.date))].sort(), [fitting])

  const activeDate = dateOverride && dates.includes(dateOverride) ? dateOverride : dates[0] ?? ''
  const activeIndex = dates.indexOf(activeDate)
  const times = fitting
    .filter((s) => s.date === activeDate)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))

  /** The calendar disables any day in the window without room for the group. Days beyond the
   * fetched horizon stay tappable by the shared component's contract ("the server stays
   * authoritative"), so the jump simply ignores a day the pager has no data for. */
  const dayRemaining = useMemo(() => {
    const map = new Map<string, number>()
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) map.set(d, 0)
    for (const s of fitting) map.set(s.date, Math.max(map.get(s.date) ?? 0, s.remaining))
    return map
  }, [fitting, range])

  const goTo = (date: string) => {
    setDateOverride(date)
    setSlotId('')
  }

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!lineId || !slotId) return
    reschedule.mutate(
      { folioId, moves: [{ folio_line_id: lineId, to_slot_id: slotId }] },
      { onSuccess: onClose },
    )
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Reagendar"
      submitLabel="Reagendar"
      onSubmit={submit}
      busy={reschedule.isPending}
      disabled={!lineId || !slotId}
      error={
        reschedule.isError ? (
          <Alert severity="error">
            No se pudo mover a ese horario. Puede que ya no tenga lugar para todo el grupo.
          </Alert>
        ) : null
      }
    >
      <Stack spacing={2}>
        {lines.length > 1 && (
          <TextField
            select
            label="¿Cuál servicio?"
            value={lineId}
            onChange={(e) => {
              setLineId(e.target.value)
              // A different line is a different service and a different calendar (D11).
              setDateOverride(null)
              setSlotId('')
            }}
            fullWidth
          >
            {lines.map((l) => (
              <MenuItem key={l.id} value={l.id}>
                {l.service_name} · {l.slot_date} {l.slot_start_time}
              </MenuItem>
            ))}
          </TextField>
        )}

        {current && (
          <Typography variant="body2" color="text.secondary">
            Ahora: <strong>{current.slot_date} {current.slot_start_time}</strong>
          </Typography>
        )}

        {service.isLoading ? (
          <Skeleton variant="rounded" height={96} />
        ) : dates.length === 0 ? (
          <Alert severity="info">
            No hay otra fecha con lugar para el grupo en los próximos {HORIZON_DAYS} días.
          </Alert>
        ) : (
          <>
            {/* The one-day pager: ◀ Viernes 7 ago ▶, stepping only between days with room. */}
            <Box>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  mb: 1,
                }}
              >
                <IconButton
                  aria-label="Día anterior"
                  onClick={() => goTo(dates[activeIndex - 1])}
                  disabled={activeIndex <= 0}
                >
                  <ChevronLeftRounded />
                </IconButton>
                <Typography sx={{ fontWeight: 600 }}>{dayHeadline(activeDate)}</Typography>
                <IconButton
                  aria-label="Día siguiente"
                  onClick={() => goTo(dates[activeIndex + 1])}
                  disabled={activeIndex >= dates.length - 1}
                >
                  <ChevronRightRounded />
                </IconButton>
              </Box>

              {/* The day's remaining times, as the POS matrix draws them: time first, seats under. */}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {times.map((s) => {
                  const selected = s.id === slotId
                  return (
                    <ButtonBase
                      key={s.id}
                      onClick={() => setSlotId(s.id)}
                      aria-pressed={selected}
                      sx={{
                        px: 2,
                        py: 1,
                        borderRadius: 2,
                        border: '1px solid',
                        borderColor: selected ? 'primary.main' : 'divider',
                        bgcolor: (t) =>
                          selected ? alpha(t.palette.primary.main, 0.12) : 'transparent',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        minWidth: 96,
                        transition: 'all 160ms ease',
                      }}
                    >
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {s.start_time}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {s.remaining} lugares
                      </Typography>
                    </ButtonBase>
                  )
                })}
              </Box>
            </Box>

            {/* "¿Y en dos semanas?" — the calendar the POS already taught the seller, one tap to
                jump the pager. Collapsed by default: the nearest days answer most counters. */}
            <Box>
              <Button
                color="inherit"
                size="small"
                startIcon={<CalendarMonthRounded />}
                onClick={() => setCalendarOpen((v) => !v)}
              >
                {calendarOpen ? 'Ocultar calendario' : 'Elegir fecha'}
              </Button>
              <Collapse in={calendarOpen} unmountOnExit>
                <Box sx={{ mt: 1 }}>
                  <DateRangeCalendar
                    value={{ check_in: activeDate, check_out: null }}
                    onChange={(v) => {
                      const tapped = v.check_out ?? v.check_in
                      if (tapped && dates.includes(tapped)) {
                        goTo(tapped)
                        setCalendarOpen(false)
                      }
                    }}
                    today={range.from}
                    dayRemaining={dayRemaining}
                    requiredQuantity={quantity}
                    // The same dot the POS calendar makes: "this day fits the group."
                    availabilityDots
                  />
                </Box>
              </Collapse>
            </Box>
          </>
        )}

        {isPaid && (
          <Alert severity="warning">
            Al mover la fecha, <strong>el boleto actual deja de funcionar</strong>. Se envía uno
            nuevo enseguida — avísale al cliente si ya lo tenía guardado.
          </Alert>
        )}

        {/* D2 — both parties on the record. The seller is signing this. */}
        <Typography variant="caption" color="text.secondary">
          Acordado con el cliente · la reagenda queda registrada a tu nombre.
        </Typography>
      </Stack>
    </FormSheet>
  )
}
