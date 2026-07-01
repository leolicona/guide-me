import { useState } from 'react'
import { Box, Typography, Button, CircularProgress } from '@mui/material'
import { BottomSheet, MoneyText } from '../../../components'
import { DateRangeCalendar, type DateRangeValue, type DayStatus } from './DateRangeCalendar'
import { useUnitCalendar, useLodgingAvailability } from '../hooks'
import { usePosCart } from '../../../store/posCart'
import { todayStr, addDays } from '../dates'

interface UnitCalendarSheetProps {
  /** The unit + its parent service; null closes the sheet. */
  target: { service: { id: string; name: string }; unitId: string; unitName: string } | null
  guests: number
  onClose: () => void
  onAdded: () => void
}

// US-AG37 — unit-first: a specific unit's month availability calendar. Picking a range reuses the
// range-first availability quote (exact total incl. extra-person surcharge) and adds the same
// stay line. The server stays authoritative on confirm.
export function UnitCalendarSheet({ target, guests, onClose, onAdded }: UnitCalendarSheetProps) {
  const today = todayStr()
  const addStayLine = usePosCart((s) => s.addStayLine)
  const [range, setRange] = useState<DateRangeValue>({ check_in: null, check_out: null })

  // 90-day status window for the visible months.
  const { data: days, isLoading } = useUnitCalendar(
    target?.unitId ?? '',
    { from: today, to: addDays(today, 90) },
    !!target,
  )
  const dayStatus = new Map<string, DayStatus>((days ?? []).map((d) => [d.date, d.status]))

  // Quote the picked range for THIS unit (exact total).
  const { data: avail } = useLodgingAvailability(target?.service.id ?? '', {
    check_in: range.check_in ?? '',
    check_out: range.check_out ?? '',
    guests,
  })
  const quoted = avail?.units.find((u) => u.unit_id === target?.unitId)
  const rangeComplete = !!range.check_in && !!range.check_out

  const add = () => {
    if (!target || !quoted || !range.check_in || !range.check_out) return
    addStayLine({
      service: { id: target.service.id, name: target.service.name, base_price: 0, minimum_price: 0 },
      unit_id: target.unitId,
      unit_name: target.unitName,
      check_in: range.check_in,
      check_out: range.check_out,
      guests,
      nights: quoted.nights,
      total: quoted.total,
      per_night: quoted.per_night,
    })
    setRange({ check_in: null, check_out: null })
    onAdded()
  }

  return (
    <BottomSheet
      open={!!target}
      onClose={onClose}
      header={
        <Box sx={{ px: 2, pb: 1 }}>
          <Typography variant="h6">{target?.unitName}</Typography>
        </Box>
      }
      footer={
        <Box sx={{ p: 2 }}>
          <Button
            fullWidth
            variant="contained"
            disableElevation
            onClick={add}
            disabled={!rangeComplete || !quoted}
          >
            {rangeComplete && quoted ? (
              <>
                Agregar ·{' '}
                <MoneyText
                  cents={quoted.total}
                  variant="body1"
                  sx={{ color: 'inherit', ml: 0.5 }}
                  srLabel="Total de la estancia"
                />
              </>
            ) : rangeComplete ? (
              'No disponible para esas fechas'
            ) : (
              'Elige las fechas'
            )}
          </Button>
        </Box>
      }
    >
      <Box sx={{ px: 2, pb: 2 }}>
        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <DateRangeCalendar value={range} onChange={setRange} today={today} dayStatus={dayStatus} />
        )}
      </Box>
    </BottomSheet>
  )
}
