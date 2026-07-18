import { useMemo, useState } from 'react'
import {
  Box,
  Stack,
  Button,
  Typography,
  TextField,
  Chip,
  CircularProgress,
  Alert,
  Snackbar,
  Divider,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import { useSlots } from '../hooks/useSlots'
import { useSchedules } from '../hooks/useSchedules'
import { useDeactivateSlot } from '../hooks/useDeactivateSlot'
import { useReactivateSlot } from '../hooks/useReactivateSlot'
import { useDeactivateSchedule } from '../hooks/useDeactivateSchedule'
import { SlotList } from './SlotList'
import { SlotFormSheet } from './SlotFormSheet'
import { ScheduleFormSheet } from './ScheduleFormSheet'
import { ConfirmSheet } from '../../../components'
import { WEEKDAY_LABELS } from '../types'
import type { Schedule, Slot } from '../types'
import { ServiceError } from '../../../services/authService'

// Local date → 'YYYY-MM-DD' (org-local, no timezone shift).
const toISODate = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface SchedulesSectionProps {
  serviceId: string
  defaultCapacity: number
}

export function SchedulesSection({
  serviceId,
  defaultCapacity,
}: SchedulesSectionProps) {
  const today = useMemo(() => new Date(), [])
  const in30 = useMemo(() => {
    const d = new Date(today)
    d.setDate(d.getDate() + 30)
    return d
  }, [today])

  const [from, setFrom] = useState(toISODate(today))
  const [to, setTo] = useState(toISODate(in30))

  const {
    data: slots,
    isLoading: slotsLoading,
    isError: slotsError,
  } = useSlots(serviceId, { from, to, status: 'all' })
  const { data: schedules } = useSchedules(serviceId)

  const deactivateSlot = useDeactivateSlot(serviceId)
  const reactivateSlot = useReactivateSlot(serviceId)
  const deactivateSchedule = useDeactivateSchedule(serviceId)

  const [slotDialog, setSlotDialog] = useState<{ open: boolean; slot: Slot | null }>(
    { open: false, slot: null },
  )
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [scheduleToClose, setScheduleToClose] = useState<Schedule | null>(null)
  const [snack, setSnack] = useState<{ msg: string; severity: 'success' | 'error' } | null>(
    null,
  )

  const slotBusy = deactivateSlot.isPending || reactivateSlot.isPending

  const handleClose = (slot: Slot) =>
    deactivateSlot.mutate(slot.id, {
      onError: () => setSnack({ msg: 'No se pudo cerrar la fecha.', severity: 'error' }),
    })

  const handleReopen = (slot: Slot) =>
    reactivateSlot.mutate(slot.id, {
      onError: (error: unknown) => {
        const msg =
          error instanceof ServiceError && error.status === 409
            ? 'Ya existe una fecha activa en ese día y hora.'
            : 'No se pudo reabrir la fecha.'
        setSnack({ msg, severity: 'error' })
      },
    })

  const confirmCloseSchedule = () => {
    if (!scheduleToClose) return
    deactivateSchedule.mutate(scheduleToClose.id, {
      onSuccess: (result) => {
        setSnack({
          msg: `Horario desactivado · ${result.slots_closed} fecha(s) cerrada(s).`,
          severity: 'success',
        })
        setScheduleToClose(null)
      },
      onError: () => {
        setSnack({ msg: 'No se pudo desactivar el horario.', severity: 'error' })
        setScheduleToClose(null)
      },
    })
  }

  const activeSchedules = (schedules ?? []).filter((s) => s.status === 'active')

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          justifyContent: 'space-between',
          alignItems: { xs: 'stretch', sm: 'center' },
          gap: 2,
          mb: 2,
        }}
      >
        <Typography variant="h6">Horarios y fechas</Typography>
        {/* One contained primary per section (parity with "Agregar tipo" / "Agregar extra");
            the alternate add-path is a neutral text button beside it. */}
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: 'center' }}>
          <Button
            startIcon={<EventRepeatRounded />}
            onClick={() => setScheduleDialogOpen(true)}
            sx={{ color: 'text.secondary' }}
          >
            Recurrente
          </Button>
          <Button
            variant="contained"
            disableElevation
            startIcon={<AddRounded />}
            onClick={() => setSlotDialog({ open: true, slot: null })}
          >
            Agregar fecha
          </Button>
        </Stack>
      </Box>

      {/* Active recurring schedules */}
      {activeSchedules.length > 0 && (
        <Stack spacing={1} sx={{ mb: 3 }} divider={<Divider flexItem />}>
          {activeSchedules.map((s) => (
            <Box
              key={s.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
              }}
            >
              <Box sx={{ minWidth: 0 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <EventRepeatRounded fontSize="small" color="action" />
                  <Typography sx={{ fontWeight: 500 }}>
                    {s.weekdays.map((d) => WEEKDAY_LABELS[d]).join(', ')} · {s.start_time}
                  </Typography>
                  <Chip size="small" variant="outlined" label={`cap ${s.capacity}`} />
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {s.start_date} → {s.end_date}
                </Typography>
              </Box>
              {/* Neutral per-row utility — the destructive red moment lives on the
                  ConfirmSheet, not on every row (de-emphasize to emphasize). */}
              <Button
                size="small"
                startIcon={<BlockRounded />}
                onClick={() => setScheduleToClose(s)}
                sx={{ flexShrink: 0, color: 'text.secondary' }}
              >
                Desactivar
              </Button>
            </Box>
          ))}
        </Stack>
      )}

      {/* Date-range filter */}
      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField
          label="Desde"
          type="date"
          size="small"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="Hasta"
          type="date"
          size="small"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
        />
      </Stack>

      {slotsLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}
      {slotsError && <Alert severity="error">No se pudieron cargar las fechas. Inténtalo de nuevo.</Alert>}
      {slots && slots.length === 0 && (
        <Typography color="text.secondary" variant="body2">
          No hay fechas en este rango — agrega una fecha o un horario recurrente.
        </Typography>
      )}
      {slots && slots.length > 0 && (
        <SlotList
          slots={slots}
          onEdit={(slot) => setSlotDialog({ open: true, slot })}
          onClose={handleClose}
          onReopen={handleReopen}
          busy={slotBusy}
        />
      )}

      <SlotFormSheet
        serviceId={serviceId}
        defaultCapacity={defaultCapacity}
        slot={slotDialog.slot}
        open={slotDialog.open}
        onClose={() => setSlotDialog({ open: false, slot: null })}
      />
      <ScheduleFormSheet
        serviceId={serviceId}
        defaultCapacity={defaultCapacity}
        open={scheduleDialogOpen}
        onClose={() => setScheduleDialogOpen(false)}
        onCreated={(n) =>
          setSnack({ msg: `Se generaron ${n} fecha(s).`, severity: 'success' })
        }
      />

      {/* Confirm schedule deactivation (cascades to unbooked slots) */}
      <ConfirmSheet
        open={!!scheduleToClose}
        onClose={() => setScheduleToClose(null)}
        title="¿Desactivar este horario?"
        description="Las fechas sin reservas se cerrarán. Las fechas con reservas permanecerán activas para que sus boletos sigan siendo válidos."
        confirmLabel="Desactivar"
        busy={deactivateSchedule.isPending}
        onConfirm={confirmCloseSchedule}
      />

      <Snackbar
        open={!!snack}
        autoHideDuration={4000}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {snack ? (
          <Alert severity={snack.severity} onClose={() => setSnack(null)} variant="filled">
            {snack.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  )
}
