import { useMemo, useState, type FormEvent } from 'react'
import {
  Alert,
  Box,
  ButtonBase,
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
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import { FormSheet } from '../../../components'
import { useRescheduleFolio } from '../hooks/useBookingActions'
import type { RescheduleLine } from '../hooks/useBookingActions'
import { usePosService } from '../../pos/hooks/usePosService'
import { effectiveRemaining } from '../../pos/capacity'
import { DateRangeCalendar } from '../../pos/components/DateRangeCalendar'
import { addDays } from '../../pos/dates'
import { TicketWhatsAppButton } from './TicketWhatsAppButton'

// US-AG52 — reagendar mientras el lugar es tuyo.
// Spec: docs/bookings/booking-reschedule.spec.md (D2, D11, D16, D19).
//
// A `FormSheet`, never a Dialog — the design system reserves Dialogs for nothing, and every entity
// edit in this product is a sheet.
//
// CALENDAR FIRST: the month grid the POS already taught the seller, availability-dotted, one tap
// to land on a day — and under it, that day's remaining times as chips, with ◀ ▶ stepping ONLY
// between days that can seat the group. The pager still opens on the FIRST day with room, so the
// nearest real options are on screen before anybody taps anything. A day the service does not
// operate, or whose slots cannot take the party, is disabled on the grid and absent from the axis
// (US-AG33's rule: never present a day the group cannot take).
//
// The slots come from the SELECTED line's service (D11), 60 days ahead, filtered by the same
// effective-capacity arithmetic the POS sale applies. The server re-checks everything; the sheet
// exists to never offer what the server will refuse.
//
// On a PAID folio the move does not end at the confirm: the old ticket just died (D16), so the
// sheet CHAINS the replacement — success state carries the same WhatsApp send the receipt uses,
// because "se envía uno nuevo" must be one tap away from the person who just promised it.

/** How far ahead the sheet looks. The POS default window is 3 days — right for walk-ups. */
const HORIZON_DAYS = 60

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

/** "Viernes 7 ago" — the day headline. */
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
  /** D16 — after a paid move the sheet becomes the ticket handoff instead of closing. */
  const [done, setDone] = useState(false)
  const reschedule = useRescheduleFolio()

  // Reset when the sheet reopens — render-time "store previous prop", so it lands before paint.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setLineId(lines[0]?.id ?? '')
      setDateOverride(null)
      setSlotId('')
      setDone(false)
    }
  }

  const current = lines.find((l) => l.id === lineId)

  // Only asked for while the sheet is open: a folio detail should not fetch a service's calendar
  // for a button nobody pressed. Keyed on the SELECTED line, so switching lines switches calendars.
  const range = useMemo(() => {
    const today = new Date()
    const to = new Date(today.getTime() + HORIZON_DAYS * 86_400_000)
    return { from: isoDay(today), to: isoDay(to) }
  }, [])
  const service = usePosService(open && !done ? current?.service_id : undefined, range)

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

  /** The calendar disables any day in the window without room for the group, and dots the days
   * that fit. Days beyond the fetched horizon stay tappable by the shared component's contract
   * ("the server stays authoritative"), so the jump simply ignores a day the pager has no data
   * for. */
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

  // The re-read folio the move returned — everything the WhatsApp send needs, portal link included.
  const movedFolio = (reschedule.data as { folio?: Record<string, unknown> } | undefined)?.folio

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (done) {
      onClose()
      return
    }
    if (!lineId || !slotId) return
    reschedule.mutate(
      { folioId, moves: [{ folio_line_id: lineId, to_slot_id: slotId }] },
      // A live apartado's move ends here. A PAID move just killed a ticket the customer may have
      // saved — the sheet stays, holding the replacement one tap away (D16).
      { onSuccess: () => (isPaid ? setDone(true) : onClose()) },
    )
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Reagendar"
      submitLabel={done ? 'Listo' : 'Reagendar'}
      onSubmit={submit}
      busy={reschedule.isPending}
      disabled={!done && (!lineId || !slotId)}
      error={
        !done && reschedule.isError ? (
          <Alert severity="error">
            No se pudo mover a ese horario. Puede que ya no tenga lugar para todo el grupo.
          </Alert>
        ) : null
      }
    >
      {done ? (
        // D16, second half — the handoff. The old link is dead; the replacement travels NOW, in
        // the same gesture, through the same send the receipt uses. Skipping this screen is
        // allowed (Listo): the outbox row keeps the send visible as pending work either way.
        <Stack spacing={2} sx={{ alignItems: 'stretch' }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <CheckCircleRounded color="success" />
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Fecha movida
            </Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            El boleto anterior dejó de funcionar. Envíale el nuevo al cliente ahora — si ya lo
            tenía guardado, es lo que evita el susto en el muelle.
          </Typography>
          {movedFolio && (
            <TicketWhatsAppButton
              folio={movedFolio as never}
              onSent={onClose}
            />
          )}
        </Stack>
      ) : (
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

          {/* The FROM of a from→to move. This is what keeps the wrong line from being moved:
              the seller confirms out loud "te muevo del sábado 08:00 al…" reading this line. */}
          {current && current.slot_date && (
            <Typography variant="body2" color="text.secondary">
              Ahora: <strong>{dayHeadline(current.slot_date)} · {current.slot_start_time}</strong>
            </Typography>
          )}

          {service.isLoading ? (
            <Skeleton variant="rounded" height={280} />
          ) : dates.length === 0 ? (
            <Alert severity="info">
              No hay otra fecha con lugar para el grupo en los próximos {HORIZON_DAYS} días.
            </Alert>
          ) : (
            <>
              {/* The month grid first — the map. Dotted days fit the group; one tap lands. */}
              <DateRangeCalendar
                value={{ check_in: activeDate, check_out: null }}
                onChange={(v) => {
                  const tapped = v.check_out ?? v.check_in
                  if (tapped && dates.includes(tapped)) goTo(tapped)
                }}
                today={range.from}
                dayRemaining={dayRemaining}
                requiredQuantity={quantity}
                availabilityDots
              />

              {/* Then the landed day: ◀ Viernes 7 ago ▶ and its remaining times. */}
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
            </>
          )}

          {isPaid && (
            <Alert severity="warning">
              Al mover la fecha, <strong>el boleto actual deja de funcionar</strong>. Al confirmar
              podrás enviarle el nuevo por WhatsApp.
            </Alert>
          )}

          {/* D2's enforcement, stated as the fact it is: the record carries the seller's name.
              (The earlier "Acordado con el cliente ·" prefix claimed something the UI cannot
              verify; the registered name is the half that deters.) */}
          <Typography variant="caption" color="text.secondary">
            La reagenda queda registrada a tu nombre.
          </Typography>
        </Stack>
      )}
    </FormSheet>
  )
}
