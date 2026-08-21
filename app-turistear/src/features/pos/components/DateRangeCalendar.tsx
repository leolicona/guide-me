import { useState } from 'react'
import { Box, Typography, IconButton, Stack } from '@mui/material'
import { alpha } from '@mui/material/styles'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import { monthOf, addMonths, addDays, daysInMonth, firstWeekdayMondayBased } from '../dates'

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]
const WEEKDAY_HEADERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']
const pad2 = (n: number): string => String(n).padStart(2, '0')
const monthLabel = (month: string): string => {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS_ES[m - 1]} ${y}`
}

export interface DateRangeValue {
  check_in: string | null
  check_out: string | null
}

interface DateRangeCalendarProps {
  value: DateRangeValue
  onChange: (v: DateRangeValue) => void
  /** Floor — earlier days are disabled. */
  today: string
  /** v2 (type-first calendar) — rooms REMAINING per night. A night with fewer rooms free than
   * `requiredQuantity` is disabled + tinted. Days absent from the map count as available
   * (outside the fetched window the server stays authoritative at confirm). */
  dayRemaining?: Map<string, number>
  /** Rooms the agent wants (D12); a night needs `remaining ≥ requiredQuantity`. Default 1. */
  requiredQuantity?: number
  /** US-AG52 — mark days that fit the group with the same availability dot the POS calendar
   * (`PosDatePickerSheet`) already taught the seller. Opt-in: only days PRESENT in `dayRemaining`
   * can earn one (absent days merely count as "server decides", which is not a promise). */
  availabilityDots?: boolean
  /** US-AG57 (D7) — `'single'` picks ONE day: every tap reports it as `check_in` with a null
   * `check_out`, and nothing ever fills as a range. Default `'range'`, so the lodging stay sheet
   * is untouched. This replaces the `{check_in: d, check_out: null}` + `v.check_out ?? v.check_in`
   * workaround `RescheduleSheet` was carrying, before the POS became its second copy. */
  mode?: 'range' | 'single'
  /** US-AG57 (D8/D9) — the THREE-state paint. When supplied it supersedes `dayRemaining`, and
   * the contract inverts: a day absent from this map is one the service **does not operate**
   * (flat, inert), not one the server will decide on. `sold_out` days tint — the service runs,
   * it is simply full — because «no sale ese día» and «ya se llenó» are different answers to
   * give a customer (US-AG33's distinction, carried onto the grid). */
  dayState?: Map<string, 'available' | 'sold_out' | 'non_operating'>
  /** US-AG57 — tighter geometry for the sale sheet, which hosts the grid inside a Bottom Sheet
   * capped at 85vh alongside a header, a day pager, time chips, zones, extras and a pinned
   * footer. Square cells and 8px gaps cost ~90px the sheet does not have; the full-page and
   * lodging hosts keep the roomier default. */
  compact?: boolean
  /** US-AG57 — the visible month changed (`YYYY-MM`). The month grid owns its own paging, but
   * a caller fetching per-month availability needs to know which one to ask for. */
  onVisibleMonthChange?: (month: string) => void
}

// US-AG36/AG37 — the US-AG35 day grid extended to RANGE selection: first tap = check-in, second =
// check-out (an earlier second tap restarts). The inclusive range fills teal; nights without
// enough remaining rooms render disabled with a legend. Checkout-day reuse means a stay's last
// night frees the checkout.
export function DateRangeCalendar({
  value,
  onChange,
  today,
  dayRemaining,
  requiredQuantity = 1,
  availabilityDots = false,
  mode = 'range',
  dayState,
  compact = false,
  onVisibleMonthChange,
}: DateRangeCalendarProps) {
  const currentMonth = monthOf(today)
  const [visibleMonth, setVisibleMonth] = useState(() => monthOf(value.check_in ?? today))
  const goToMonth = (next: string) => {
    setVisibleMonth(next)
    onVisibleMonthChange?.(next)
  }

  // Every night in [from, to) has enough remaining rooms. Nights missing from the map count as
  // available (outside the fetched window the server stays authoritative at confirm).
  const spanAvailable = (from: string, to: string): boolean => {
    if (!dayRemaining) return true
    for (let d = from; d < to; d = addDays(d, 1)) {
      const remaining = dayRemaining.get(d)
      if (remaining !== undefined && remaining < requiredQuantity) return false
    }
    return true
  }

  const handleTap = (date: string) => {
    // D7 — a single-day picker has no second tap and no span to validate.
    if (mode === 'single') {
      onChange({ check_in: date, check_out: null })
      return
    }
    // No range yet, or a complete range exists → start fresh at this date.
    if (!value.check_in || (value.check_in && value.check_out)) {
      onChange({ check_in: date, check_out: null })
      return
    }
    // Second tap after the check-in → close the range, but ONLY if no night inside it lacks
    // inventory — a span across a full night can never be sold, so the tap restarts there
    // instead (the Airbnb pattern; prevents dead-end "not available" quotes). On/before the
    // check-in → restart.
    if (date > value.check_in && spanAvailable(value.check_in, date)) {
      onChange({ check_in: value.check_in, check_out: date })
    } else {
      onChange({ check_in: date, check_out: null })
    }
  }

  const inRange = (date: string): boolean =>
    !!value.check_in && !!value.check_out && date >= value.check_in && date <= value.check_out

  const atCurrentMonth = visibleMonth <= currentMonth
  const leadingBlanks = firstWeekdayMondayBased(visibleMonth)
  const total = daysInMonth(visibleMonth)
  const days = Array.from({ length: total }, (_, i) => i + 1)

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <IconButton
          aria-label="Mes anterior"
          onClick={() => goToMonth(addMonths(visibleMonth, -1))}
          disabled={atCurrentMonth}
        >
          <ChevronLeftRounded />
        </IconButton>
        <Typography sx={{ fontWeight: 600, fontSize: 17 }}>{monthLabel(visibleMonth)}</Typography>
        <IconButton aria-label="Mes siguiente" onClick={() => goToMonth(addMonths(visibleMonth, 1))}>
          <ChevronRightRounded />
        </IconButton>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: compact ? 0.5 : 1, mb: compact ? 0.5 : 1 }}>
        {WEEKDAY_HEADERS.map((w, i) => (
          <Typography key={i} variant="caption" sx={{ textAlign: 'center', color: 'text.secondary', fontWeight: 600 }}>
            {w}
          </Typography>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: compact ? 0.5 : 1 }}>
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <Box key={`blank-${i}`} />
        ))}
        {days.map((day) => {
          const date = `${visibleMonth}-${pad2(day)}`
          const isPast = date < today
          const remaining = dayRemaining?.get(date)
          // D9 — with `dayState` the client knows the whole truth for this month, so "absent"
          // stops meaning "unknown" and starts meaning "the service does not run".
          const state = dayState?.get(date) ?? (dayState ? 'non_operating' : undefined)
          // Only a day that OPERATES and is full tints; a non-operating day stays flat, so the
          // two never read as the same fact (D8).
          const unavailable = state
            ? state === 'sold_out'
            : remaining !== undefined && remaining < requiredQuantity
          const inert = state ? state !== 'available' : false
          const disabled = isPast || unavailable || inert
          const isEndpoint = date === value.check_in || date === value.check_out
          const isInRange = inRange(date)
          // The dot promises "this day fits the group", so only a day the map KNOWS earns one —
          // and never on an endpoint, where the fill already says it (PosDatePickerSheet's rule).
          const hasDot =
            availabilityDots &&
            !isPast &&
            !isEndpoint &&
            (state
              ? state === 'available'
              : remaining !== undefined && remaining >= requiredQuantity)

          return (
            <Box
              key={date}
              component="button"
              type="button"
              disabled={disabled}
              onClick={() => handleTap(date)}
              aria-label={date}
              aria-pressed={isEndpoint}
              sx={{
                appearance: 'none',
                border: 'none',
                font: 'inherit',
                p: 0,
                // Compact trades the square cell for a fixed 40px row: still above the 40px
                // minimum for a thumb inside a grid of peers, and ~90px shorter over six rows.
                ...(compact ? { height: 40 } : { aspectRatio: '1 / 1' }),
                borderRadius: 2,
                display: 'flex',
                flexDirection: availabilityDots ? 'column' : 'row',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: disabled ? 'default' : 'pointer',
                fontSize: 15,
                fontWeight: isEndpoint ? 700 : 500,
                fontVariantNumeric: 'tabular-nums',
                color: isEndpoint
                  ? 'primary.contrastText'
                  : disabled
                    ? 'text.disabled'
                    : isInRange
                      ? 'var(--teal-700, #0F766E)'
                      : 'text.primary',
                bgcolor: isEndpoint
                  ? 'primary.main'
                  : isInRange
                    ? 'var(--teal-50, #F0FDFA)'
                    : unavailable
                      ? 'var(--slate-100, #F1F5F9)'
                      : 'transparent',
                '&:hover': {
                  bgcolor: (t) =>
                    disabled
                      ? isEndpoint
                        ? t.palette.primary.main
                        : unavailable
                          ? 'var(--slate-100, #F1F5F9)'
                          : 'transparent'
                      : alpha(t.palette.primary.main, 0.1),
                },
              }}
            >
              {day}
              {/* Availability dot — the same 5px promise the POS calendar makes. Rendered for
                  every cell (transparent when absent) so the numbers stay vertically aligned. */}
              {availabilityDots && (
                <Box
                  data-testid={hasDot ? 'availability-dot' : undefined}
                  sx={{
                    width: 5,
                    height: 5,
                    mt: 0.25,
                    borderRadius: '50%',
                    bgcolor: hasDot ? 'primary.main' : 'transparent',
                  }}
                />
              )}
            </Box>
          )
        })}
      </Box>

      {/* D8 — with three states the legend must name the tinted one specifically: a flat cell
          and a tinted cell now mean different things, and "Sin disponibilidad" covered both. */}
      {dayState ? (
        <Stack direction="row" spacing={2} sx={{ mt: 1.5, justifyContent: 'center' }}>
          <Legend color="var(--slate-300, #CBD5E1)" label="Agotado" square />
          <Legend color="var(--teal-700, #0F766E)" label="Con lugares" />
        </Stack>
      ) : (
        dayRemaining && (
          <Stack direction="row" spacing={2} sx={{ mt: 1.5, justifyContent: 'center' }}>
            <Legend color="var(--slate-300, #CBD5E1)" label="Sin disponibilidad" />
          </Stack>
        )
      )}
    </Box>
  )
}

function Legend({ color, label, square = false }: { color: string; label: string; square?: boolean }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      {/* The swatch mirrors the cell it explains: a filled square for the tinted sold-out day,
          a dot for the availability mark. Shape carries the difference, not colour alone. */}
      <Box sx={{ width: 8, height: 8, borderRadius: square ? 0.5 : '50%', bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  )
}
