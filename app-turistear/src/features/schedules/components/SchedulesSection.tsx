import { useMemo, useState } from 'react'
import {
  Box,
  Stack,
  Button,
  Typography,
  CircularProgress,
  Alert,
  Snackbar,
  Divider,
  Collapse,
  Skeleton,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded'
import EventBusyRounded from '@mui/icons-material/EventBusyRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import ExpandLessRounded from '@mui/icons-material/ExpandLessRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import { FilterPill, FilterStrip, DateRangeSheet } from '../../filters'
import { useSlots } from '../hooks/useSlots'
import { useSchedules } from '../hooks/useSchedules'
import { useDeactivateSlot } from '../hooks/useDeactivateSlot'
import { useReactivateSlot } from '../hooks/useReactivateSlot'
import { useDeactivateSchedule } from '../hooks/useDeactivateSchedule'
import { SlotList } from './SlotList'
import { SlotFormSheet } from './SlotFormSheet'
import { ScheduleFormSheet } from './ScheduleFormSheet'
import { ConfirmSheet } from '../../../components'
import { WEEKDAY_FULL_LABELS, isRecurring } from '../types'
import type { Schedule, Slot } from '../types'
import { ServiceError } from '../../../services/authService'

// Local date → 'YYYY-MM-DD' (org-local, no timezone shift).
const toISODate = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 'YYYY-MM-DD' → readable local date (parse as local midnight to avoid TZ shift).
const formatDate = (iso: string): string =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

// Weekday numbers → prose ("Viernes y Sábado", "Lunes, Miércoles y Viernes").
const weekdayLister = new Intl.ListFormat('es-MX', { style: 'long', type: 'conjunction' })
const formatWeekdays = (weekdays: number[]): string =>
  weekdayLister.format([...weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_FULL_LABELS[d]))

// Zone label — parallel structure for "Horarios recurrentes" / "Fechas únicas".
const ZoneLabel = ({ children }: { children: React.ReactNode }) => (
  <Typography
    variant="overline"
    color="text.secondary"
    sx={{ letterSpacing: 0.6, display: 'block', mb: 1 }}
  >
    {children}
  </Typography>
)

// Short "12 jun – 30 jun" label for the calendar pill (mirrors ReportsPage).
const MONTHS_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const fmtDay = (date: string): string => {
  const [, m, day] = date.split('-').map(Number)
  return `${day} ${MONTHS_ABBR[m - 1]}`
}
const rangeLabel = (from: string, to: string): string => `${fmtDay(from)} – ${fmtDay(to)}`

interface ChunkedSlotListProps {
  slots: Slot[]
  onEdit: (slot: Slot) => void
  onClose: (slot: Slot) => void
  onReopen: (slot: Slot) => void
  busy: boolean
  /** Date-groups revealed per page. */
  pageSize?: number
}

// SlotList with progressive reveal: the first `pageSize` date-groups render, the rest wait
// behind "Mostrar más fechas" (key the component by range to reset the reveal on filter change).
function ChunkedSlotList({ slots, pageSize = 7, ...handlers }: ChunkedSlotListProps) {
  const [visible, setVisible] = useState(pageSize)
  // Slots arrive ordered by date, so the distinct-date list is ordered too.
  const dates = useMemo(() => [...new Set(slots.map((s) => s.date))], [slots])
  const visibleDates = new Set(dates.slice(0, visible))
  const shown = slots.filter((s) => visibleDates.has(s.date))
  const remaining = dates.length - visibleDates.size

  return (
    <>
      <SlotList slots={shown} {...handlers} />
      {remaining > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button
            size="small"
            startIcon={<ExpandMoreRounded />}
            onClick={() => setVisible((v) => v + pageSize)}
            sx={{ color: 'text.secondary' }}
          >
            Mostrar más fechas ({remaining})
          </Button>
        </Box>
      )}
    </>
  )
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
  const todayISO = toISODate(today)
  const plusDays = (n: number): string => {
    const d = new Date(today)
    d.setDate(d.getDate() + n)
    return toISODate(d)
  }
  const maxDate = plusDays(365)

  // Quick-range presets (POS/Reports filter-pill pattern), forward-looking from today.
  const presets = [
    { key: '7d', label: '7 días', from: todayISO, to: plusDays(7) },
    { key: '30d', label: '30 días', from: todayISO, to: plusDays(30) },
    { key: '90d', label: '90 días', from: todayISO, to: plusDays(90) },
  ]

  const [from, setFrom] = useState(todayISO)
  const [to, setTo] = useState(() => plusDays(30))
  const [rangeSheetOpen, setRangeSheetOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  // Highlighted preset pill, or null when the range is custom — which lights the calendar pill.
  const activePreset = presets.find((p) => p.from === from && p.to === to)?.key ?? null

  // Recurring dates are represented by their rule line, so the default view only needs the
  // one-off slots — fetched over a year-long window so none hide beyond a short horizon.
  const {
    data: yearSlots,
    isLoading: oneOffsLoading,
    isError: oneOffsError,
  } = useSlots(serviceId, { from: todayISO, to: maxDate, status: 'all' })
  const oneOffs = useMemo(() => (yearSlots ?? []).filter((s) => !isRecurring(s)), [yearSlots])

  // The full date-by-date enumeration lives behind the "Ver todas las fechas" disclosure;
  // its windowed query only runs once expanded (the hook's `enabled` gates on serviceId).
  const {
    data: slots,
    isLoading: slotsLoading,
    isError: slotsError,
  } = useSlots(showAll ? serviceId : undefined, { from, to, status: 'all' })
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

      {/* Active recurring schedules — the rule line IS the representation of its dates;
          the generated slots are not enumerated here (they live behind the disclosure). */}
      {activeSchedules.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <ZoneLabel>Horarios recurrentes</ZoneLabel>
          <Stack spacing={1.5} divider={<Divider flexItem />}>
            {activeSchedules.map((s) => {
              const ended = s.end_date < todayISO
              return (
                <Box
                  key={s.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 2,
                  }}
                >
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
                    {/* Structural anchor for the row — tinted well, no shadow. */}
                    <Box
                      sx={{
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        bgcolor: 'grey.100',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <EventRepeatRounded fontSize="small" color="action" />
                    </Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography sx={{ fontWeight: 600 }}>
                        {formatWeekdays(s.weekdays)} ·{' '}
                        <Box component="span" className="numeric">
                          {s.start_time}
                        </Box>
                      </Typography>
                      {ended ? (
                        // Icon-paired functional amber — an "active" rule whose window
                        // already ended generates nothing and deserves attention.
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ alignItems: 'center', color: 'warning.main' }}
                        >
                          <EventBusyRounded sx={{ fontSize: 16 }} />
                          <Typography variant="body2">
                            Terminó el {formatDate(s.end_date)}
                          </Typography>
                        </Stack>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          {s.capacity === 1 ? '1 lugar' : `${s.capacity} lugares`} por fecha ·{' '}
                          {s.start_date > todayISO
                            ? `del ${formatDate(s.start_date)} al ${formatDate(s.end_date)}`
                            : `hasta el ${formatDate(s.end_date)}`}
                        </Typography>
                      )}
                    </Box>
                  </Stack>
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
              )
            })}
          </Stack>
        </Box>
      )}

      {/* One-off dates (schedule_id = null) — the only individually-created dates, so the
          only ones worth listing by default. */}
      {oneOffsLoading && <Skeleton width={220} sx={{ mb: 2 }} />}
      {oneOffsError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          No se pudieron cargar las fechas. Inténtalo de nuevo.
        </Alert>
      )}
      {oneOffs.length > 0 && (
        <Box sx={{ mb: 3 }}>
          <ZoneLabel>Fechas únicas</ZoneLabel>
          <ChunkedSlotList
            slots={oneOffs}
            onEdit={(slot) => setSlotDialog({ open: true, slot })}
            onClose={handleClose}
            onReopen={handleReopen}
            busy={slotBusy}
          />
        </Box>
      )}

      {!oneOffsLoading && activeSchedules.length === 0 && oneOffs.length === 0 && (
        <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
          No hay fechas — agrega una fecha o un horario recurrente.
        </Typography>
      )}

      {/* Full date-by-date enumeration on demand — still the path to edit or close one
          specific generated date (e.g. cerrar Navidad). */}
      <Divider sx={{ mb: 1 }} />
      <Button
        size="small"
        startIcon={showAll ? <ExpandLessRounded /> : <ExpandMoreRounded />}
        onClick={() => setShowAll((v) => !v)}
        sx={{ color: 'text.secondary', ml: -1 }}
      >
        {showAll ? 'Ocultar todas las fechas' : 'Ver todas las fechas'}
      </Button>
      <Collapse in={showAll}>
        <Box sx={{ pt: 2 }}>
          {/* Date-range filter — the POS/Reports pill strip: quick presets + a calendar pill
              that opens the shared range sheet (custom ranges light the calendar pill). */}
          <FilterStrip sx={{ mb: 2 }}>
            {presets.map((p) => (
              <FilterPill
                key={p.key}
                variant="date"
                active={activePreset === p.key}
                onClick={() => {
                  setFrom(p.from)
                  setTo(p.to)
                }}
              >
                {p.label}
              </FilterPill>
            ))}
            <FilterPill
              variant="date"
              active={activePreset === null}
              startIcon={<CalendarMonthRounded sx={{ fontSize: 20 }} />}
              onClick={() => setRangeSheetOpen(true)}
              aria-label="Elegir rango de fechas"
            >
              {rangeLabel(from, to)}
            </FilterPill>
          </FilterStrip>

          {slotsLoading && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          )}
          {slotsError && (
            <Alert severity="error">No se pudieron cargar las fechas. Inténtalo de nuevo.</Alert>
          )}
          {slots && slots.length === 0 && (
            <Typography color="text.secondary" variant="body2">
              No hay fechas en este rango — agrega una fecha o un horario recurrente.
            </Typography>
          )}
          {slots && slots.length > 0 && (
            <ChunkedSlotList
              key={`${from}:${to}`}
              slots={slots}
              onEdit={(slot) => setSlotDialog({ open: true, slot })}
              onClose={handleClose}
              onReopen={handleReopen}
              busy={slotBusy}
            />
          )}
        </Box>
      </Collapse>

      <DateRangeSheet
        open={rangeSheetOpen}
        onClose={() => setRangeSheetOpen(false)}
        from={from}
        to={to}
        maxDate={maxDate}
        onApply={(f, t) => {
          setFrom(f)
          setTo(t)
          setRangeSheetOpen(false)
        }}
      />

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
