import { Fragment } from 'react'
import { Box, Typography, Stack, Divider } from '@mui/material'
import { SlotRow } from './SlotRow'
import type { Slot } from '../types'

interface SlotListProps {
  slots: Slot[]
  onEdit: (slot: Slot) => void
  onClose: (slot: Slot) => void
  onReopen: (slot: Slot) => void
  busy: boolean
  /** US-A64 — per-zone close/reopen on a departure (zoned services). */
  onCloseZone?: (slotId: string, zoneId: string) => void
  onReopenZone?: (slotId: string, zoneId: string) => void
  zoneBusy?: boolean
}

// Format a 'YYYY-MM-DD' string as a readable local date header.
const formatDateHeading = (date: string): string => {
  const d = new Date(`${date}T00:00:00`)
  return d.toLocaleDateString('es-MX', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function SlotList({
  slots,
  onEdit,
  onClose,
  onReopen,
  busy,
  onCloseZone,
  onReopenZone,
  zoneBusy,
}: SlotListProps) {
  // Group by date (slots arrive ordered by date then time).
  const groups = slots.reduce<Record<string, Slot[]>>((acc, slot) => {
    ;(acc[slot.date] ??= []).push(slot)
    return acc
  }, {})

  const dates = Object.keys(groups)

  return (
    <Stack spacing={2.5}>
      {dates.map((date) => (
        <Fragment key={date}>
          <Box>
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              {formatDateHeading(date)}
            </Typography>
            <Stack spacing={1} divider={<Divider flexItem />}>
              {groups[date].map((slot) => (
                <SlotRow
                  key={slot.id}
                  slot={slot}
                  onEdit={onEdit}
                  onClose={onClose}
                  onReopen={onReopen}
                  busy={busy}
                  onCloseZone={onCloseZone}
                  onReopenZone={onReopenZone}
                  zoneBusy={zoneBusy}
                />
              ))}
            </Stack>
          </Box>
        </Fragment>
      ))}
    </Stack>
  )
}
