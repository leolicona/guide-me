import { useState } from 'react'
import { Box, Typography, Button, IconButton } from '@mui/material'
import { alpha } from '@mui/material/styles'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import { BottomSheet } from './BottomSheet'
import { monthOf, addMonths, daysInMonth, firstWeekdayMondayBased } from '../../pos/dates'

interface DateRangeSheetProps {
  open: boolean
  onClose: () => void
  /** The applied range (`YYYY-MM-DD`) the sheet opens onto. */
  from: string
  to: string
  /** Latest selectable day (`YYYY-MM-DD`); later days are disabled (no future settlement). */
  maxDate: string
  /** Commit a new range — the owner sets state and closes. */
  onApply: (from: string, to: string) => void
}

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]
const MONTHS_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
// Monday-first weekday headers (es-MX). Keys positional, labels intentionally terse.
const WEEKDAY_HEADERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

const pad2 = (n: number): string => String(n).padStart(2, '0')
const monthLabel = (month: string): string => {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS_ES[m - 1]} ${y}`
}
const dayLabel = (date: string): string => {
  const [, m, day] = date.split('-').map(Number)
  return `${day} ${MONTHS_ABBR[m - 1]}`
}

// A month-grid date-range picker in the shared glass sheet. Tap a start day, then an end day; the
// span between highlights and the endpoints fill. Re-tapping (or picking earlier than the anchor)
// restarts the selection. Reuses the POS calendar's pure date helpers and cell aesthetic.
export function DateRangeSheet({ open, onClose, from, to, maxDate, onApply }: DateRangeSheetProps) {
  // Pending selection while the sheet is open. `end === null` means "awaiting the end day".
  const [start, setStart] = useState(from)
  const [end, setEnd] = useState<string | null>(to)
  const [visibleMonth, setVisibleMonth] = useState(() => monthOf(to))
  // Reset to the applied range each time the sheet opens (store-previous-prop, pre-paint).
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setStart(from)
      setEnd(to)
      setVisibleMonth(monthOf(to))
    }
  }

  const pickDay = (date: string) => {
    if (end !== null || date < start) {
      // A complete range exists, or the tap precedes the anchor → start a fresh selection.
      setStart(date)
      setEnd(null)
    } else {
      setEnd(date)
    }
  }

  const maxMonth = monthOf(maxDate)
  const leadingBlanks = firstWeekdayMondayBased(visibleMonth)
  const days = Array.from({ length: daysInMonth(visibleMonth) }, (_, i) => i + 1)

  const header = (
    <Box
      sx={{
        px: 3,
        pt: 1,
        pb: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <IconButton
        aria-label="Mes anterior"
        onClick={() => setVisibleMonth((m) => addMonths(m, -1))}
      >
        <ChevronLeftRounded />
      </IconButton>
      <Typography sx={{ fontWeight: 600, fontSize: 17 }}>{monthLabel(visibleMonth)}</Typography>
      <IconButton
        aria-label="Mes siguiente"
        onClick={() => setVisibleMonth((m) => addMonths(m, 1))}
        disabled={visibleMonth >= maxMonth}
      >
        <ChevronRightRounded />
      </IconButton>
    </Box>
  )

  const footer = (
    <Box sx={{ px: 3, py: 2 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', textAlign: 'center', mb: 1 }}
      >
        {end === null
          ? 'Selecciona la fecha de fin'
          : `${dayLabel(start)} – ${dayLabel(end)}`}
      </Typography>
      <Button
        fullWidth
        variant="contained"
        disableElevation
        disabled={end === null}
        onClick={() => end !== null && onApply(start, end)}
      >
        Aplicar
      </Button>
    </Box>
  )

  return (
    <BottomSheet open={open} onClose={onClose} header={header} footer={footer}>
      <Box sx={{ px: 3, pb: 1 }}>
        {/* Weekday header. */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, mb: 1 }}>
          {WEEKDAY_HEADERS.map((w, i) => (
            <Typography
              key={i}
              variant="caption"
              sx={{ textAlign: 'center', color: 'text.secondary', fontWeight: 600 }}
            >
              {w}
            </Typography>
          ))}
        </Box>

        {/* Day cells (square). */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <Box key={`blank-${i}`} />
          ))}
          {days.map((day) => {
            const date = `${visibleMonth}-${pad2(day)}`
            const isFuture = date > maxDate
            const isToday = date === maxDate
            const isEdge = date === start || (end !== null && date === end)
            const inRange = end !== null && date > start && date < end

            return (
              <Box
                key={date}
                component="button"
                type="button"
                disabled={isFuture}
                onClick={() => pickDay(date)}
                aria-label={date}
                aria-pressed={isEdge || inRange}
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
                  cursor: isFuture ? 'default' : 'pointer',
                  fontSize: 15,
                  fontWeight: isEdge ? 700 : 500,
                  fontVariantNumeric: 'tabular-nums',
                  transition: 'background-color 140ms ease, color 140ms ease',
                  color: isEdge
                    ? 'primary.contrastText'
                    : isFuture
                      ? 'text.disabled'
                      : 'text.primary',
                  bgcolor: (t) =>
                    isEdge
                      ? t.palette.primary.main
                      : inRange
                        ? alpha(t.palette.primary.main, 0.12)
                        : 'transparent',
                  boxShadow: (t) =>
                    isToday && !isEdge
                      ? `inset 0 0 0 1px ${alpha(t.palette.primary.main, 0.4)}`
                      : 'none',
                  '&:hover': {
                    bgcolor: (t) =>
                      isFuture
                        ? 'transparent'
                        : isEdge
                          ? t.palette.primary.main
                          : alpha(t.palette.primary.main, 0.16),
                  },
                }}
              >
                {day}
              </Box>
            )
          })}
        </Box>
      </Box>
    </BottomSheet>
  )
}
