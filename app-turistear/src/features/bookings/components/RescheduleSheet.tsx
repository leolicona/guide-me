import { useState, type FormEvent } from 'react'
import { Alert, MenuItem, Stack, TextField, Typography } from '@mui/material'
import { FormSheet } from '../../../components'
import { useRescheduleFolio } from '../hooks/useBookingActions'
import type { RescheduleLine, RescheduleSlot } from '../hooks/useBookingActions'

// US-AG52 — reagendar mientras el lugar es tuyo.
// Spec: docs/bookings/booking-reschedule.spec.md (D2, D11, D16).
//
// A `FormSheet`, never a Dialog — the design system reserves Dialogs for nothing, and every entity
// edit in this product is a sheet.
//
// The copy carries D2, which is the point of the whole feature: this is a HUMAN action agreed by
// both parties, and the record will have the seller's name on it. A reschedule nobody agreed to is
// a seat taken from the pool for somebody who is not there.

export interface RescheduleSheetProps {
  open: boolean
  onClose: () => void
  folioId: string
  /** Only tour lines; a stay is nights under a per-night guard and is deferred. */
  lines: RescheduleLine[]
  /** Departures of the SAME service that still pass the guards (D11). */
  options: RescheduleSlot[]
  /** A paid folio's ticket is re-issued and the old link stops working (D16). */
  isPaid: boolean
}

export function RescheduleSheet({
  open,
  onClose,
  folioId,
  lines,
  options,
  isPaid,
}: RescheduleSheetProps) {
  const [lineId, setLineId] = useState(lines[0]?.id ?? '')
  const [slotId, setSlotId] = useState('')
  const reschedule = useRescheduleFolio()

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!lineId || !slotId) return
    reschedule.mutate(
      { folioId, moves: [{ folio_line_id: lineId, to_slot_id: slotId }] },
      { onSuccess: onClose },
    )
  }

  const current = lines.find((l) => l.id === lineId)

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
            onChange={(e) => setLineId(e.target.value)}
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

        <TextField
          select
          label="Nuevo horario"
          value={slotId}
          onChange={(e) => setSlotId(e.target.value)}
          fullWidth
          // D11 — same service only. A different one is a different sale: it needs re-quoting, and
          // the line's agreed price would no longer be the price of anything.
          helperText="Solo horarios del mismo servicio."
        >
          {options.length === 0 && (
            <MenuItem value="" disabled>
              No hay otro horario disponible
            </MenuItem>
          )}
          {options.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.date} · {s.start_time} — {s.remaining} lugares
            </MenuItem>
          ))}
        </TextField>

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
