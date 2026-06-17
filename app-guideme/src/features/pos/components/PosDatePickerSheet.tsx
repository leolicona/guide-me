import { useState } from 'react'
import {
  SwipeableDrawer,
  Box,
  Typography,
  Button,
  IconButton,
  CircularProgress,
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import CloseRounded from '@mui/icons-material/CloseRounded'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import { usePosAvailableDays } from '../hooks'
import {
  monthOf,
  addMonths,
  daysInMonth,
  firstWeekdayMondayBased,
} from '../dates'

interface PosDatePickerSheetProps {
  open: boolean
  onClose: () => void
  /** The currently filtered day (`null` = the "Hoy" anchor). */
  selectedDate: string | null
  /** Org-local today (`YYYY-MM-DD`) — the floor; earlier days are disabled. */
  today: string
  /** Commit a concrete day (the owner sets `selectedDate` and closes the sheet). */
  onPick: (date: string) => void
  /** The "Hoy" shortcut — clears back to the default anchor. */
  onClearToToday: () => void
}

const MONTHS_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]
// Monday-first weekday headers (es-MX). Keys are positional, labels intentionally terse.
const WEEKDAY_HEADERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']

const monthLabel = (month: string): string => {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS_ES[m - 1]} ${y}`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

// US-AG35 — the calendar Bottom Sheet: a month grid of square day chips marking the
// sellable days (from GET /api/pos/availability/days), with month navigation. Reuses the
// US-AG31 sheet pattern (glass paper, puller). Past/unavailable days are disabled; picking
// an available day commits it and closes.
export function PosDatePickerSheet({
  open,
  onClose,
  selectedDate,
  today,
  onPick,
  onClearToToday,
}: PosDatePickerSheetProps) {
  const currentMonth = monthOf(today)
  // The visible month resets to the selection's month (or today's) each time the sheet opens.
  // Done in render (not an effect) via the "store previous prop" pattern, so the reset lands
  // before paint with no cascading-render effect.
  const [visibleMonth, setVisibleMonth] = useState(() => monthOf(selectedDate ?? today))
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setVisibleMonth(monthOf(selectedDate ?? today))
  }

  // Only fetch while the sheet is open; refetches as the visible month changes.
  const { data: availableDays, isLoading } = usePosAvailableDays(
    visibleMonth,
    today,
    open,
  )
  const available = new Set(availableDays ?? [])

  const atCurrentMonth = visibleMonth <= currentMonth
  const leadingBlanks = firstWeekdayMondayBased(visibleMonth)
  const total = daysInMonth(visibleMonth)
  const days = Array.from({ length: total }, (_, i) => i + 1)

  return (
    <SwipeableDrawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      onOpen={() => {}}
      disableSwipeToOpen
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            backgroundColor: 'rgba(255,255,255,0.9)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
          },
        },
      }}
    >
      {/* Puller + close — fixed. */}
      <Box sx={{ position: 'relative', pt: 1.5, pb: 0.5, flexShrink: 0 }}>
        <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider', mx: 'auto' }} />
        <IconButton
          size="small"
          aria-label="Cerrar"
          onClick={onClose}
          sx={{ position: 'absolute', top: 4, right: 8 }}
        >
          <CloseRounded fontSize="small" />
        </IconButton>
      </Box>

      {/* Month navigation. */}
      <Box
        sx={{
          px: 3,
          pt: 1,
          pb: 2,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <IconButton
          aria-label="Mes anterior"
          onClick={() => setVisibleMonth((m) => addMonths(m, -1))}
          disabled={atCurrentMonth}
        >
          <ChevronLeftRounded />
        </IconButton>
        <Typography sx={{ fontWeight: 600, fontSize: 17 }}>
          {monthLabel(visibleMonth)}
        </Typography>
        <IconButton
          aria-label="Mes siguiente"
          onClick={() => setVisibleMonth((m) => addMonths(m, 1))}
        >
          <ChevronRightRounded />
        </IconButton>
      </Box>

      {/* Scrollable grid (the only overflow region). */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, pb: 1 }}>
        {/* Weekday header. */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 1,
            mb: 1,
          }}
        >
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
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 1,
            position: 'relative',
          }}
        >
          {isLoading && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1,
              }}
            >
              <CircularProgress size={24} />
            </Box>
          )}
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <Box key={`blank-${i}`} />
          ))}
          {days.map((day) => {
            const date = `${visibleMonth}-${pad2(day)}`
            const isPast = date < today
            const isToday = date === today
            const isSelected = date === selectedDate
            const isAvailable = available.has(date)
            // While availability is loading, today-onward days stay neutral & inert.
            const disabled = isPast || isLoading || !isAvailable

            return (
              <Box
                key={date}
                component="button"
                type="button"
                disabled={disabled}
                onClick={() => onPick(date)}
                aria-label={date}
                aria-pressed={isSelected}
                sx={{
                  appearance: 'none',
                  border: 'none',
                  font: 'inherit',
                  p: 0,
                  aspectRatio: '1 / 1',
                  borderRadius: 2,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  cursor: disabled ? 'default' : 'pointer',
                  fontSize: 15,
                  fontWeight: isSelected ? 700 : 500,
                  fontVariantNumeric: 'tabular-nums',
                  transition: 'background-color 140ms ease, color 140ms ease',
                  color: isSelected
                    ? 'primary.contrastText'
                    : isPast || (!isAvailable && !isLoading)
                      ? 'text.disabled'
                      : 'text.primary',
                  bgcolor: isSelected ? 'primary.main' : 'transparent',
                  boxShadow:
                    isToday && !isSelected
                      ? (t) => `inset 0 0 0 1px ${alpha(t.palette.primary.main, 0.4)}`
                      : 'none',
                  '&:hover': {
                    bgcolor: (t) =>
                      disabled
                        ? isSelected
                          ? t.palette.primary.main
                          : 'transparent'
                        : alpha(t.palette.primary.main, 0.1),
                  },
                }}
              >
                {day}
                {/* Availability dot — hidden when the day is selected (the fill says it). */}
                <Box
                  sx={{
                    width: 5,
                    height: 5,
                    mt: 0.25,
                    borderRadius: '50%',
                    bgcolor:
                      isAvailable && !isSelected ? 'primary.main' : 'transparent',
                  }}
                />
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* Footer: "Hoy" shortcut — fixed. */}
      <Box sx={{ px: 3, py: 2, flexShrink: 0 }}>
        <Button fullWidth variant="outlined" onClick={onClearToToday}>
          Hoy
        </Button>
      </Box>
    </SwipeableDrawer>
  )
}
