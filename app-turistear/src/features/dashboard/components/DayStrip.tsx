import { useState } from 'react'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import { FilterPill, FilterStrip } from '../../filters'
import { PosDatePickerSheet } from '../../pos/components/PosDatePickerSheet'
import { addDays } from '../../pos/dates'

// D5 — the shipped quick-day strip (US-AG35 vocabulary): HOY + the next two days + a calendar
// sheet. Local state only — never the POS filter store, which would silently re-filter the
// agent-facing catalog (D12: the strip scopes the occupancy list alone).

const dayLabel = (date: string): string => {
  const text = new Date(`${date}T12:00:00Z`).toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
  return text.charAt(0).toUpperCase() + text.slice(1)
}

interface DayStripProps {
  today: string
  selected: string | null // null = today
  onSelect: (day: string | null) => void
}

export function DayStrip({ today, selected, onSelect }: DayStripProps) {
  const [calendarOpen, setCalendarOpen] = useState(false)
  const nextDays = [addDays(today, 1), addDays(today, 2)]
  const pinned = selected !== null && !nextDays.includes(selected)

  return (
    <>
      <FilterStrip sx={{ mb: 2 }}>
        <FilterPill variant="date" active={selected === null} onClick={() => onSelect(null)}>
          Hoy
        </FilterPill>
        {nextDays.map((d) => (
          <FilterPill
            key={d}
            variant="date"
            active={selected === d}
            onClick={() => onSelect(selected === d ? null : d)}
          >
            {dayLabel(d)}
          </FilterPill>
        ))}
        <FilterPill
          variant="date"
          active={pinned}
          onClick={() => setCalendarOpen(true)}
          startIcon={<CalendarMonthRounded fontSize="small" />}
          aria-label="Elegir día en el calendario"
        >
          {pinned ? dayLabel(selected) : null}
        </FilterPill>
      </FilterStrip>
      <PosDatePickerSheet
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        selectedDate={selected}
        dateRange={null}
        today={today}
        categories={[]}
        onPickDay={(d) => {
          onSelect(d === today ? null : d)
          setCalendarOpen(false)
        }}
        onPickRange={(r) => {
          onSelect(r.from === today ? null : r.from)
          setCalendarOpen(false)
        }}
      />
    </>
  )
}
