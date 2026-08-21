import { useMemo, useState } from 'react'
import { Box, Typography, Stack, ButtonBase, IconButton, Skeleton } from '@mui/material'
import { alpha } from '@mui/material/styles'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import { DateRangeCalendar } from './DateRangeCalendar'
import { useServiceMonth } from '../hooks'
import {
  buildDayState,
  sellableDayAxis,
  nextSellableDay,
  prevSellableDay,
} from '../dayState'
import { effectiveRemaining } from '../capacity'
import { monthOf, addMonths } from '../dates'
import type { PosSlot } from '../types'

// US-AG57 — the sale sheet's departure picker: a month grid with availability marks, then that
// day's times as chips. It REPLACES `SlotPicker`'s fixed three-day list (D1, D11) — two ways to
// pick a date in one product was the defect, so this does not sit beside it.
//
// The grid COLLAPSES once a day is picked (D6): the sheet caps at 85vh, and grid + pager + chips
// + zone + extras + footer does not fit. The one control that must never scroll away is
// «Agregar al carrito».

const MONTHS_ES = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
]
const WEEKDAYS_ES = [
  'Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado',
]

/** "Sábado 22 de ago" — the expanded day headline over the time chips. */
const dayHeadline = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS_ES[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]}`
}

/** "Sáb 22 de ago" — the collapsed line. */
const dayChipLabel = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`)
  const wd = WEEKDAYS_ES[d.getUTCDay()].slice(0, 3)
  return `${wd} ${d.getUTCDate()} de ${MONTHS_ES[d.getUTCMonth()]}`
}

interface DeparturePickerProps {
  serviceId: string
  /** The day whose times are shown. Owned by the sheet, because it also scopes the slot fetch. */
  selectedDate: string
  onSelectDate: (date: string) => void
  /** Slots for `selectedDate` only (the sheet fetches one day at a time — D2). */
  slots: PosSlot[]
  slotsLoading: boolean
  /** Org-local today: the calendar's floor and the month query's anchor. */
  today: string
  /** US-AG32 — the group being sold; the server classifies days against it (D4/D12). */
  partySize: number
  selectedSlotId: string | null
  onSelectSlot: (slot: PosSlot) => void
  isFlexible: boolean
  flexCapacityPct: number
}

export function DeparturePicker({
  serviceId,
  selectedDate,
  onSelectDate,
  slots,
  slotsLoading,
  today,
  partySize,
  selectedSlotId,
  onSelectSlot,
  isFlexible,
  flexCapacityPct,
}: DeparturePickerProps) {
  // D6, revised twice. The grid is VISIBLE on open, as it is in the lodging sheet and Reagendar.
  // The previous pass collapsed it to stop the sheet overflowing 85vh, but that treated the
  // symptom: the height was going to a header carrying the service description, the price line
  // and the Personas stepper ABOVE the calendar. D18 removes all three and moves Personas below,
  // which buys back ~150px and lets the calendar lead the sheet the way it leads everywhere else.
  //
  // It still collapses once a day is picked: zones and extras appear below it for the services
  // that have them, and «Agregar al carrito» must never scroll away.
  const [expanded, setExpanded] = useState(true)
  const [visibleMonth, setVisibleMonth] = useState(() => monthOf(selectedDate))

  // D2 — ~1 KB of date strings per month, not 60 days of slots. Party-scoped server-side, so a
  // day the group cannot take is never offered (D4).
  // D17 — the ◀ ▶ pager steps to the next day that CAN BE SOLD, never to the calendar's next
  // day. A service running Fri/Sat/Sun makes the naive stepper four taps of "no sale ese día" to
  // cross a week, which is the flat-list problem this feature exists to end, re-created inside
  // the sheet. `RescheduleSheet` never had it because its axis was only ever days with room.
  //
  // Skipping needs to KNOW which days have room, so the selected day's month is always fetched
  // (~1 KB) — this narrows D15's deferral: the *grid's* month is still deferred when the seller
  // pages to a different one, but the pager's month is load-bearing.
  const pagerMonth = monthOf(selectedDate)
  const pager = useServiceMonth(serviceId, pagerMonth, partySize, today)

  // The grid's month, deferred until it is open (D15). Usually the same key as `pager`, in which
  // case TanStack serves it from cache and no second request happens.
  const grid = useServiceMonth(serviceId, visibleMonth, partySize, today, expanded)
  const dayState = buildDayState(visibleMonth, grid.data ?? pager.data, today)
  const monthLoading = grid.isLoading

  // A month boundary must not read as "no more departures": a service whose next run is the 2nd
  // has nothing left in `pagerMonth`, and disabling ▶ there would hide real inventory. The
  // neighbours load ONLY when the current month cannot answer, so the common case stays at one
  // request and stepping across a boundary costs one more.
  const inMonth = pager.data?.days ?? []
  const hasLater = inMonth.some((d) => d > selectedDate)
  const hasEarlier = inMonth.some((d) => d < selectedDate && d >= today)
  const nextMonth = addMonths(pagerMonth, 1)
  const prevMonth = addMonths(pagerMonth, -1)
  const ahead = useServiceMonth(serviceId, nextMonth, partySize, today, !!pager.data && !hasLater)
  const behind = useServiceMonth(
    serviceId,
    prevMonth,
    partySize,
    today,
    // Never look back past the month containing today — the server floors its window there
    // anyway, so the request could only ever come back empty.
    !!pager.data && !hasEarlier && prevMonth >= monthOf(today),
  )

  // Every sellable day we currently know about, ascending. Past days cannot be sold, so they are
  // never step targets even if a stale cache still carries them.
  const sellableDays = useMemo(
    () => sellableDayAxis([behind.data, pager.data, ahead.data], today),
    [behind.data, pager.data, ahead.data, today],
  )
  const nextDay = nextSellableDay(sellableDays, selectedDate)
  const prevDay = prevSellableDay(sellableDays, selectedDate)

  // US-AG32 — only departures that seat the whole group; the rest never reach the DOM.
  const fitting = slots
    .filter((s) => effectiveRemaining(s, isFlexible, flexCapacityPct) >= partySize)
    .sort((a, b) => a.start_time.localeCompare(b.start_time))

  const pick = (date: string) => {
    onSelectDate(date)
    setExpanded(false)
  }

  return (
    <Box>
      {expanded ? (
        <>
          <DateRangeCalendar
            mode="single"
            value={{ check_in: selectedDate, check_out: null }}
            onChange={(v) => v.check_in && pick(v.check_in)}
            today={today}
            dayState={dayState}
            availabilityDots
            compact
            onVisibleMonthChange={setVisibleMonth}
          />
          {monthLoading && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 1 }}>
              Cargando disponibilidad…
            </Typography>
          )}
        </>
      ) : (
        // D6 — the collapsed grid. Still a button: «Cambiar» is the way back, and the whole row
        // is the target so it clears the 48px reach rule without a second control.
        <ButtonBase
          onClick={() => setExpanded(true)}
          sx={{
            width: '100%',
            minHeight: 48,
            px: 2,
            py: 1,
            gap: 1,
            justifyContent: 'space-between',
            border: '1px solid',
            borderColor: 'grey.300',
            borderRadius: 3,
          }}
          aria-label={`Cambiar fecha — ${dayHeadline(selectedDate)}`}
        >
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
            <CalendarMonthRounded sx={{ fontSize: 20, color: 'text.secondary' }} />
            <Typography sx={{ fontWeight: 600 }}>{dayChipLabel(selectedDate)}</Typography>
          </Stack>
          <Typography variant="body2" color="primary.main" sx={{ fontWeight: 600 }}>
            Cambiar
          </Typography>
        </ButtonBase>
      )}

      {/* The landed day and its departures. The ◀ ▶ step one calendar day at a time — a day the
          service skips simply reads "no sale", which is the honest answer and the one the grid
          already gave (D8). */}
      <Box sx={{ mt: 2 }}>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          {/* D17 — the arrows name what they do: the NEXT day with room, not tomorrow. Disabled
              only when nothing further is known, which the neighbour-month reads make rare. */}
          <IconButton
            aria-label="Día disponible anterior"
            onClick={() => prevDay && onSelectDate(prevDay)}
            disabled={!prevDay}
          >
            <ChevronLeftRounded />
          </IconButton>
          <Typography sx={{ fontWeight: 600 }}>{dayHeadline(selectedDate)}</Typography>
          <IconButton
            aria-label="Día disponible siguiente"
            onClick={() => nextDay && onSelectDate(nextDay)}
            disabled={!nextDay}
          >
            <ChevronRightRounded />
          </IconButton>
        </Stack>

        {slotsLoading ? (
          <Stack direction="row" spacing={1}>
            <Skeleton variant="rounded" width={110} height={56} />
            <Skeleton variant="rounded" width={110} height={56} />
          </Stack>
        ) : fitting.length === 0 ? (
          <Typography color="text.secondary" variant="body2">
            {slots.length === 0
              ? 'Este servicio no sale ese día.'
              : `Sin lugares para ${partySize} ${partySize === 1 ? 'persona' : 'personas'} ese día.`}
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {fitting.map((slot) => {
              // US-AG34 — the party dips into the Soft Cap cushion. `fitting` already bounds the
              // upper end, so passing the strict remaining is enough to know.
              const usingCushion = partySize > slot.remaining
              const extraUsed = partySize - slot.remaining
              const selected = slot.id === selectedSlotId
              const accent = selected
                ? 'secondary.main'
                : usingCushion
                  ? 'warning.main'
                  : 'grey.300'
              return (
                <ButtonBase
                  key={slot.id}
                  onClick={() => onSelectSlot(slot)}
                  aria-pressed={selected}
                  sx={{
                    px: 2,
                    py: 1,
                    minHeight: 56,
                    borderRadius: 3,
                    border: '1px solid',
                    borderColor: accent,
                    bgcolor: (t) =>
                      selected
                        ? alpha(t.palette.secondary.main, 0.12)
                        : usingCushion
                          ? alpha(t.palette.warning.main, 0.08)
                          : 'transparent',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    minWidth: 104,
                    transition: 'all 160ms ease',
                  }}
                >
                  <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {slot.start_time}
                  </Typography>
                  {/* D10 — «29 lugares» is how a seller says it. The cushion warning survives
                      the shortening, icon-paired because state is never colour-alone. */}
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    {usingCushion && (
                      <WarningAmberRounded sx={{ fontSize: 14, color: 'warning.main' }} />
                    )}
                    <Typography
                      variant="caption"
                      color={usingCushion ? 'warning.main' : 'text.secondary'}
                    >
                      {usingCushion
                        ? `${extraUsed} ${extraUsed === 1 ? 'cupo' : 'cupos'} extra`
                        : `${slot.remaining} lugares`}
                    </Typography>
                  </Stack>
                </ButtonBase>
              )
            })}
          </Box>
        )}
      </Box>
    </Box>
  )
}
