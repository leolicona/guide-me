import { Fragment } from 'react'
import { Box, Typography, Stack, ButtonBase } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { PosSlot } from '../types'
import { effectiveRemaining } from '../capacity'

interface SlotPickerProps {
  /** All slots in the loaded window (unfiltered by party — the matrix filters per day). */
  slots: PosSlot[]
  /** US-AG33 — the candidate day axis, in order: 3 days on the "Hoy" anchor, 1 for an explicit
   * date. A day the service doesn't operate (no slots at all) is dropped, not rendered — only
   * operating days appear (a full one reads "Agotado"). */
  days: string[]
  /** Real org-local today, for the "Hoy" relative label. */
  today: string
  /** US-AG32/AG34 — drives the per-day fit filter and the cushion (orange) warning. */
  partySize: number
  selectedId: string | null
  onSelect: (slot: PosSlot) => void
  /** US-A36 — service capacity mode, so each slot can show its flexible margin. */
  isFlexible?: boolean
  flexCapacityPct?: number
}

// US-AG33 — relative day label: "Hoy" for the real today, else a capitalized short weekday
// plus the day-of-month for disambiguation (e.g. "Sáb 14").
const dayLabel = (date: string, today: string): string => {
  if (date === today) return 'Hoy'
  const d = new Date(`${date}T00:00:00`)
  const weekday = d.toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', '')
  const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1)
  return `${cap} ${d.getDate()}`
}

// US-AG33/AG34 — the Bottom Sheet's date/time matrix. A row renders only for days the service
// actually operates (≥ 1 slot in the window): a day with no slots at all is a NON-operating day
// (the service doesn't run then) and is dropped entirely — never mislabeled "Agotado", which
// means sold out and would imply it runs. An operating day with no seats left for the group DOES
// read "Agotado" (US-AG33). Within a day, only slots that seat the whole group are shown
// (US-AG32); a slot dipping into the overbooking cushion is painted orange with "Usando X cupos
// extra" (US-AG34) — advisory, never blocking.
export function SlotPicker({
  slots,
  days,
  today,
  partySize,
  selectedId,
  onSelect,
  isFlexible = false,
  flexCapacityPct = 0,
}: SlotPickerProps) {
  return (
    <Stack spacing={2}>
      {days.map((date) => {
        // A day the service doesn't operate has no slot rows at all — drop it so the window
        // never presents a non-running day as "Agotado" (sold out). Only operating days remain.
        const daySlots = slots.filter((s) => s.date === date)
        if (daySlots.length === 0) return null

        // US-AG32 — only slots that seat the whole group survive (non-fitting stay out of the
        // DOM). An operating day with none left renders disabled as "(Agotado)" (US-AG33).
        const fitting = daySlots.filter(
          (s) => effectiveRemaining(s, isFlexible, flexCapacityPct) >= partySize,
        )
        const soldOut = fitting.length === 0

        return (
          <Fragment key={date}>
            <Box>
              <Typography
                variant="subtitle2"
                color={soldOut ? 'text.disabled' : 'text.secondary'}
                sx={{ mb: soldOut ? 0 : 1 }}
              >
                {dayLabel(date, today)}
                {soldOut && ' · (Agotado)'}
              </Typography>
              {!soldOut && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                  {fitting.map((slot) => {
                    // US-AG34 — the chosen party dips into the cushion when it passes the
                    // strict remaining but still fits the Effective Capacity. (`fitting`
                    // guarantees the upper bound, so `partySize > remaining` is enough.)
                    const usingCushion = partySize > slot.remaining
                    const extraUsed = partySize - slot.remaining
                    const selected = slot.id === selectedId
                    // Accent (selected) wins; otherwise a cushion slot reads in the warning tone.
                    const accent = selected
                      ? 'secondary.main'
                      : usingCushion
                        ? 'warning.main'
                        : 'divider'
                    return (
                      <ButtonBase
                        key={slot.id}
                        onClick={() => onSelect(slot)}
                        aria-pressed={selected}
                        sx={{
                          px: 2,
                          py: 1,
                          borderRadius: 2,
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
                          minWidth: 96,
                          transition: 'all 160ms ease',
                        }}
                      >
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {slot.start_time}
                        </Typography>
                        <Typography
                          variant="caption"
                          color={usingCushion ? 'warning.main' : 'text.secondary'}
                        >
                          {usingCushion
                            ? `Usando ${extraUsed} ${extraUsed === 1 ? 'cupo' : 'cupos'} extra`
                            : `${slot.remaining} / ${slot.capacity} disponibles`}
                        </Typography>
                      </ButtonBase>
                    )
                  })}
                </Box>
              )}
            </Box>
          </Fragment>
        )
      })}
    </Stack>
  )
}
