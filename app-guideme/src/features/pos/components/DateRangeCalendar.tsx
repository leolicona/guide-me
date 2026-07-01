import { useState } from 'react'
import { Box, Typography, IconButton, Stack } from '@mui/material'
import { alpha } from '@mui/material/styles'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import { monthOf, addMonths, daysInMonth, firstWeekdayMondayBased } from '../dates'

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

export type DayStatus = 'available' | 'blocked' | 'booked'

interface DateRangeCalendarProps {
  value: DateRangeValue
  onChange: (v: DateRangeValue) => void
  /** Floor — earlier days are disabled. */
  today: string
  /** Optional per-day status (unit-first calendar). Non-available days are disabled + tinted. */
  dayStatus?: Map<string, DayStatus>
}

// US-AG36/AG37 — the US-AG35 day grid extended to RANGE selection: first tap = check-in, second =
// check-out (an earlier second tap restarts). The inclusive range fills teal; blocked/booked days
// render disabled with a legend. Checkout-day reuse means a stay's last night frees the checkout.
export function DateRangeCalendar({ value, onChange, today, dayStatus }: DateRangeCalendarProps) {
  const currentMonth = monthOf(today)
  const [visibleMonth, setVisibleMonth] = useState(() => monthOf(value.check_in ?? today))

  const handleTap = (date: string) => {
    // No range yet, or a complete range exists → start fresh at this date.
    if (!value.check_in || (value.check_in && value.check_out)) {
      onChange({ check_in: date, check_out: null })
      return
    }
    // Second tap: after the check-in → close the range; on/before → restart.
    if (date > value.check_in) onChange({ check_in: value.check_in, check_out: date })
    else onChange({ check_in: date, check_out: null })
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
          onClick={() => setVisibleMonth((m) => addMonths(m, -1))}
          disabled={atCurrentMonth}
        >
          <ChevronLeftRounded />
        </IconButton>
        <Typography sx={{ fontWeight: 600, fontSize: 17 }}>{monthLabel(visibleMonth)}</Typography>
        <IconButton aria-label="Mes siguiente" onClick={() => setVisibleMonth((m) => addMonths(m, 1))}>
          <ChevronRightRounded />
        </IconButton>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, mb: 1 }}>
        {WEEKDAY_HEADERS.map((w, i) => (
          <Typography key={i} variant="caption" sx={{ textAlign: 'center', color: 'text.secondary', fontWeight: 600 }}>
            {w}
          </Typography>
        ))}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {Array.from({ length: leadingBlanks }, (_, i) => (
          <Box key={`blank-${i}`} />
        ))}
        {days.map((day) => {
          const date = `${visibleMonth}-${pad2(day)}`
          const isPast = date < today
          const status = dayStatus?.get(date)
          const unavailable = !!dayStatus && status !== undefined && status !== 'available'
          const disabled = isPast || unavailable
          const isEndpoint = date === value.check_in || date === value.check_out
          const isInRange = inRange(date)

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
                aspectRatio: '1 / 1',
                borderRadius: 2,
                display: 'flex',
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
                    : status === 'blocked' || status === 'booked'
                      ? 'var(--slate-100, #F1F5F9)'
                      : 'transparent',
                '&:hover': {
                  bgcolor: (t) =>
                    disabled
                      ? isEndpoint
                        ? t.palette.primary.main
                        : status === 'blocked' || status === 'booked'
                          ? 'var(--slate-100, #F1F5F9)'
                          : 'transparent'
                      : alpha(t.palette.primary.main, 0.1),
                },
              }}
            >
              {day}
            </Box>
          )
        })}
      </Box>

      {dayStatus && (
        <Stack direction="row" spacing={2} sx={{ mt: 1.5, justifyContent: 'center' }}>
          <Legend color="var(--slate-300, #CBD5E1)" label="No disponible" />
          <Legend color="var(--amber-600, #B45309)" label="Ocupado" />
        </Stack>
      )}
    </Box>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color }} />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Stack>
  )
}
