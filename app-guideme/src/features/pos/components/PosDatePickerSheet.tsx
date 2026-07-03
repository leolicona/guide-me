import { useState } from 'react'
import { Box, Typography, Button, IconButton, CircularProgress } from '@mui/material'
import { alpha } from '@mui/material/styles'
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'
import { BottomSheet } from '../../../components'
import { usePosAvailableDays } from '../hooks'
import type { ServiceCategory } from '../../catalog/categories'
import type { PosDateRange } from '../../../store/posFilters'
import {
  monthOf,
  addMonths,
  daysInMonth,
  firstWeekdayMondayBased,
} from '../dates'

interface PosDatePickerSheetProps {
  open: boolean
  onClose: () => void
  /** The currently filtered day (`null` = the "Hoy" anchor / range start). */
  selectedDate: string | null
  /** The active multi-day range, if any — pre-loads the draft when the sheet opens. */
  dateRange: PosDateRange | null
  /** Org-local today (`YYYY-MM-DD`) — the floor; earlier days are disabled. */
  today: string
  /** US-A37 — scopes the availability dots to the agent's category filter (empty = all). */
  categories: ServiceCategory[]
  /** Commit a single day (the owner sets the day and closes the sheet). */
  onPickDay: (date: string) => void
  /** Commit a multi-day range (lodging-only; tours anchor on `from`). */
  onPickRange: (range: PosDateRange) => void
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

// Inclusive whole-day span between two YYYY-MM-DD strings (UTC midnight arithmetic).
const spanDays = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  ) + 1

interface Draft {
  from: string | null
  to: string | null
}

// The draft the sheet opens with: an active range, else the single selected day, else empty.
const initialDraft = (dateRange: PosDateRange | null, selectedDate: string | null): Draft =>
  dateRange
    ? { from: dateRange.from, to: dateRange.to }
    : { from: selectedDate, to: null }

// US-AG35 — the calendar Bottom Sheet: a month grid of square day chips marking the sellable
// days (from GET /api/pos/availability/days), with month navigation. Smart tap-tap: one tap +
// Aplicar commits a single day; a second, later tap forms a range (an earlier second tap
// restarts). Past/unavailable days are disabled; the dots scope to the selected categories.
export function PosDatePickerSheet({
  open,
  onClose,
  selectedDate,
  dateRange,
  today,
  categories,
  onPickDay,
  onPickRange,
}: PosDatePickerSheetProps) {
  const currentMonth = monthOf(today)
  // The visible month + the draft selection reset each time the sheet opens. Done in render
  // (not an effect) via the "store previous prop" pattern, so the reset lands before paint.
  const [visibleMonth, setVisibleMonth] = useState(() =>
    monthOf(dateRange?.from ?? selectedDate ?? today),
  )
  const [draft, setDraft] = useState<Draft>(() => initialDraft(dateRange, selectedDate))
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setVisibleMonth(monthOf(dateRange?.from ?? selectedDate ?? today))
      setDraft(initialDraft(dateRange, selectedDate))
    }
  }

  // Only fetch while the sheet is open; refetches as the visible month / category set changes.
  const { data: availableDays, isLoading } = usePosAvailableDays(
    visibleMonth,
    today,
    open,
    categories,
  )
  const available = new Set(availableDays ?? [])

  // Lodging has no slots, so it never lights an availability dot. When the agent has scoped the
  // filter to lodging, dot-gating would leave the whole calendar unselectable — so in that case
  // any non-past day is pickable (the real per-unit availability is resolved in the stay sheet),
  // with the dots staying advisory. Tours-only / default filters keep the strict dot-gating.
  const lodgingInScope = categories.includes('lodging')

  // Tap-tap: no start (or a complete range) → start fresh; else close the range if the tap is
  // later than the start, otherwise restart at the tap. Only enabled (pickable) days reach here.
  const handleTap = (date: string) => {
    if (!draft.from || (draft.from && draft.to)) {
      setDraft({ from: date, to: null })
      return
    }
    if (date > draft.from) setDraft({ from: draft.from, to: date })
    else setDraft({ from: date, to: null })
  }

  const inDraftRange = (date: string): boolean =>
    !!draft.from && !!draft.to && date >= draft.from && date <= draft.to

  const apply = () => {
    if (!draft.from) return
    if (draft.to && draft.to !== draft.from) {
      onPickRange({ from: draft.from, to: draft.to })
    } else {
      onPickDay(draft.from)
    }
  }

  const atCurrentMonth = visibleMonth <= currentMonth
  const leadingBlanks = firstWeekdayMondayBased(visibleMonth)
  const total = daysInMonth(visibleMonth)
  const days = Array.from({ length: total }, (_, i) => i + 1)

  const applyLabel =
    draft.from && draft.to && draft.to !== draft.from
      ? `Aplicar · ${spanDays(draft.from, draft.to)} días`
      : 'Aplicar'

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
  )

  const footer = (
    <Box sx={{ px: 3, py: 2 }}>
      <Button fullWidth variant="contained" onClick={apply} disabled={!draft.from}>
        {applyLabel}
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
        <Box
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, position: 'relative' }}
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
            const isEndpoint = date === draft.from || date === draft.to
            const isInRange = inDraftRange(date)
            const isAvailable = available.has(date)
            // While availability is loading, today-onward days stay neutral & inert. A day is
            // pickable when it has a dot, or unconditionally (non-past) when lodging is in scope.
            const disabled = isPast || isLoading || (!isAvailable && !lodgingInScope)

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
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  cursor: disabled ? 'default' : 'pointer',
                  fontSize: 15,
                  fontWeight: isEndpoint ? 700 : 500,
                  fontVariantNumeric: 'tabular-nums',
                  transition: 'background-color 140ms ease, color 140ms ease',
                  color: isEndpoint
                    ? 'primary.contrastText'
                    : isInRange
                      ? 'var(--teal-700, #0F766E)'
                      : isPast || (!isAvailable && !isLoading && !lodgingInScope)
                        ? 'text.disabled'
                        : 'text.primary',
                  bgcolor: isEndpoint
                    ? 'primary.main'
                    : isInRange
                      ? 'var(--teal-50, #F0FDFA)'
                      : 'transparent',
                  boxShadow:
                    isToday && !isEndpoint
                      ? (t) => `inset 0 0 0 1px ${alpha(t.palette.primary.main, 0.4)}`
                      : 'none',
                  '&:hover': {
                    bgcolor: (t) =>
                      disabled
                        ? isEndpoint
                          ? t.palette.primary.main
                          : isInRange
                            ? 'var(--teal-50, #F0FDFA)'
                            : 'transparent'
                        : alpha(t.palette.primary.main, 0.1),
                  },
                }}
              >
                {day}
                {/* Availability dot — hidden on endpoints (the fill says it). */}
                <Box
                  sx={{
                    width: 5,
                    height: 5,
                    mt: 0.25,
                    borderRadius: '50%',
                    bgcolor: isAvailable && !isEndpoint ? 'primary.main' : 'transparent',
                  }}
                />
              </Box>
            )
          })}
        </Box>
      </Box>
    </BottomSheet>
  )
}
