import { Box, Typography, Chip, IconButton, Stack, Tooltip } from '@mui/material'
import EditRounded from '@mui/icons-material/EditRounded'
import EventRepeatRounded from '@mui/icons-material/EventRepeatRounded'
import BlockRounded from '@mui/icons-material/BlockRounded'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import type { Slot } from '../types'
import { isRecurring } from '../types'

interface SlotRowProps {
  slot: Slot
  onEdit: (slot: Slot) => void
  onClose: (slot: Slot) => void
  onReopen: (slot: Slot) => void
  busy: boolean
}

export function SlotRow({ slot, onEdit, onClose, onReopen, busy }: SlotRowProps) {
  const inactive = slot.status === 'inactive'

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
        opacity: inactive ? 0.5 : 1,
      }}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
        <Typography sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
          {slot.start_time}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {slot.remaining} / {slot.capacity} left
        </Typography>
        {slot.booked > 0 && (
          <Chip size="small" variant="outlined" label={`${slot.booked} booked`} />
        )}
        {isRecurring(slot) && (
          <Tooltip title="From a recurring schedule">
            <EventRepeatRounded fontSize="small" color="action" />
          </Tooltip>
        )}
        {inactive && (
          <Chip size="small" variant="outlined" label="Closed" />
        )}
      </Stack>

      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
        {inactive ? (
          <IconButton
            size="small"
            color="primary"
            aria-label="Reopen slot"
            disabled={busy}
            onClick={() => onReopen(slot)}
          >
            <CheckCircleRounded fontSize="small" />
          </IconButton>
        ) : (
          <>
            <IconButton
              size="small"
              aria-label="Edit slot"
              disabled={busy}
              onClick={() => onEdit(slot)}
            >
              <EditRounded fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              color="error"
              aria-label="Close slot"
              disabled={busy}
              onClick={() => onClose(slot)}
            >
              <BlockRounded fontSize="small" />
            </IconButton>
          </>
        )}
      </Stack>
    </Box>
  )
}
