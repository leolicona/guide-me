import { Fragment } from 'react'
import { Box, Typography, Stack, ButtonBase } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { PosSlot } from '../types'
import { effectiveRemaining, isFlexZone } from '../capacity'

interface SlotPickerProps {
  slots: PosSlot[]
  selectedId: string | null
  onSelect: (slot: PosSlot) => void
  /** US-A36 — service capacity mode, so each slot can show its flexible margin. */
  isFlexible?: boolean
  flexCapacityPct?: number
}

const formatDateHeading = (date: string): string =>
  new Date(`${date}T00:00:00`).toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

// Slots arrive ordered by date then time; group them by date for the picker.
export function SlotPicker({
  slots,
  selectedId,
  onSelect,
  isFlexible = false,
  flexCapacityPct = 0,
}: SlotPickerProps) {
  if (slots.length === 0) {
    return (
      <Typography color="text.secondary">
        No hay horarios próximos disponibles para este servicio.
      </Typography>
    )
  }

  const groups = slots.reduce<Record<string, PosSlot[]>>((acc, slot) => {
    ;(acc[slot.date] ??= []).push(slot)
    return acc
  }, {})

  return (
    <Stack spacing={2}>
      {Object.keys(groups).map((date) => (
        <Fragment key={date}>
          <Box>
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              {formatDateHeading(date)}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 1,
              }}
            >
              {groups[date].map((slot) => {
                // US-A36 — a Soft Cap slot stays sellable into its flexible margin.
                const effRemaining = effectiveRemaining(slot, isFlexible, flexCapacityPct)
                const full = effRemaining <= 0
                const flexOnly = isFlexZone(slot, isFlexible, flexCapacityPct)
                const selected = slot.id === selectedId
                // Accent (selected) wins; otherwise a flex-only slot reads in the warning tone.
                const accent = selected
                  ? 'secondary.main'
                  : flexOnly
                    ? 'warning.main'
                    : 'divider'
                return (
                  <ButtonBase
                    key={slot.id}
                    disabled={full}
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
                          : flexOnly
                            ? alpha(t.palette.warning.main, 0.08)
                            : 'transparent',
                      opacity: full ? 0.45 : 1,
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
                      color={flexOnly ? 'warning.main' : 'text.secondary'}
                    >
                      {full
                        ? 'Agotado'
                        : flexOnly
                          ? `Cupo flexible · ${effRemaining} extra`
                          : `${slot.remaining} / ${slot.capacity} disponibles`}
                    </Typography>
                  </ButtonBase>
                )
              })}
            </Box>
          </Box>
        </Fragment>
      ))}
    </Stack>
  )
}
