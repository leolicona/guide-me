import { useMemo, useState, type FormEvent } from 'react'
import { Alert, MenuItem, Skeleton, Stack, TextField, Typography } from '@mui/material'
import { FormSheet } from '../../../components'
import { useRescheduleFolio } from '../hooks/useBookingActions'
import type { RescheduleLine } from '../hooks/useBookingActions'
import { usePosService } from '../../pos/hooks/usePosService'
import { effectiveRemaining } from '../../pos/capacity'

// US-AG52 — reagendar mientras el lugar es tuyo.
// Spec: docs/bookings/booking-reschedule.spec.md (D2, D11, D16).
//
// A `FormSheet`, never a Dialog — the design system reserves Dialogs for nothing, and every entity
// edit in this product is a sheet.
//
// DATE FIRST, then the times of that date. The seller's conversation at the counter is
// "¿puedo el domingo?" — a day, answered with the hours that day still has. A flat list of every
// slot in the window makes the seller do that grouping in their head; two selects make the
// answer the shape of the question.
//
// The slots come from the SELECTED line's service (D11) — not the first line's, which offered a
// two-service folio the wrong calendar — and only slots that seat the whole party survive, using
// the same effective-capacity arithmetic the POS sale applies. The server re-checks everything;
// this filter exists so the sheet does not offer what the server will refuse.
//
// The copy carries D2, which is the point of the whole feature: this is a HUMAN action agreed by
// both parties, and the record will have the seller's name on it. A reschedule nobody agreed to is
// a seat taken from the pool for somebody who is not there.

/** How far ahead the sheet looks. The POS detail defaults to a 3-day availability window, which is
 * right for walk-up sales and useless for "¿puedo la otra semana?". */
const HORIZON_DAYS = 60

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

const dateLabel = (date: string) => {
  const d = new Date(`${date}T00:00:00`)
  const label = d.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export interface RescheduleSheetProps {
  open: boolean
  onClose: () => void
  folioId: string
  /** Only tour lines; a stay is nights under a per-night guard and is deferred. */
  lines: RescheduleLine[]
  /** A paid folio's ticket is re-issued and the old link stops working (D16). */
  isPaid: boolean
}

export function RescheduleSheet({ open, onClose, folioId, lines, isPaid }: RescheduleSheetProps) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? '')
  const [date, setDate] = useState('')
  const [slotId, setSlotId] = useState('')
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

  const dates = useMemo(() => [...new Set(fitting.map((s) => s.date))].sort(), [fitting])
  const times = fitting
    .filter((s) => s.date === date)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))

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
      submitLabel="Confirmar cambio"
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
              setDate('')
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
          <Skeleton variant="rounded" height={56} />
        ) : (
          <TextField
            select
            label="Nueva fecha"
            value={date}
            onChange={(e) => {
              setDate(e.target.value)
              setSlotId('')
            }}
            fullWidth
            // D11 — same service only. A different one is a different sale: it needs re-quoting,
            // and the line's agreed price would no longer be the price of anything.
            helperText={
              dates.length === 0
                ? 'No hay otra fecha con lugar para el grupo en los próximos 60 días.'
                : 'Solo fechas del mismo servicio con lugar para todo el grupo.'
            }
          >
            {dates.map((d) => (
              <MenuItem key={d} value={d}>
                {dateLabel(d)}
              </MenuItem>
            ))}
          </TextField>
        )}

        {date && (
          <TextField
            select
            label="Horario"
            value={slotId}
            onChange={(e) => setSlotId(e.target.value)}
            fullWidth
          >
            {times.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.start_time} — {s.remaining} lugares
              </MenuItem>
            ))}
          </TextField>
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
