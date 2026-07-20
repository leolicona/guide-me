import { Box, Typography, Chip, IconButton, Stack, Tooltip, Button } from '@mui/material'
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
  /** US-A64 — close/reopen a single zone on this departure (zoned services only). */
  onCloseZone?: (slotId: string, zoneId: string) => void
  onReopenZone?: (slotId: string, zoneId: string) => void
  zoneBusy?: boolean
}

export function SlotRow({
  slot,
  onEdit,
  onClose,
  onReopen,
  busy,
  onCloseZone,
  onReopenZone,
  zoneBusy = false,
}: SlotRowProps) {
  const inactive = slot.status === 'inactive'
  const zones = slot.zones ?? []

  return (
    <Box sx={{ opacity: inactive ? 0.5 : 1 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
        }}
      >
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
          <Typography sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
            {slot.start_time}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {slot.remaining} / {slot.capacity} disponibles
          </Typography>
          {slot.booked > 0 && (
            <Chip size="small" variant="outlined" label={`${slot.booked} reservados`} />
          )}
          {isRecurring(slot) && (
            <Tooltip title="De un horario recurrente">
              <EventRepeatRounded fontSize="small" color="action" />
            </Tooltip>
          )}
          {inactive && <Chip size="small" variant="outlined" label="Cerrado" />}
        </Stack>

        <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
          {inactive ? (
            <IconButton
              size="small"
              color="primary"
              aria-label="Reabrir fecha"
              disabled={busy}
              onClick={() => onReopen(slot)}
            >
              <CheckCircleRounded fontSize="small" />
            </IconButton>
          ) : (
            <>
              <IconButton
                size="small"
                aria-label="Editar fecha"
                disabled={busy}
                onClick={() => onEdit(slot)}
              >
                <EditRounded fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                color="error"
                aria-label="Cerrar fecha"
                disabled={busy}
                onClick={() => onClose(slot)}
              >
                <BlockRounded fontSize="small" />
              </IconButton>
            </>
          )}
        </Stack>
      </Box>

      {/* US-A64 — per-zone availability on this departure, each closable/reopenable (the rain
          case). A closed zone stops new sales but keeps its sold seats; the neutral text buttons
          keep teal reserved (the destructive moment is small and immediate here, no confirm). */}
      {!inactive && zones.length > 0 && onCloseZone && onReopenZone && (
        <Stack spacing={0.5} sx={{ mt: 1, pl: 0.5 }}>
          {zones.map((z) => {
            const closed = z.status === 'inactive'
            return (
              <Box
                key={z.zone_id}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 1,
                }}
              >
                <Typography
                  variant="body2"
                  color={closed ? 'warning.main' : 'text.secondary'}
                  sx={{ minWidth: 0 }}
                >
                  {z.name} · {closed ? 'cerrada' : `${z.remaining} / ${z.capacity}`}
                  {closed && z.booked > 0 ? ` · ${z.booked} vendidos` : ''}
                </Typography>
                {closed ? (
                  <Button
                    size="small"
                    disabled={zoneBusy}
                    onClick={() => onReopenZone(slot.id, z.zone_id)}
                    sx={{ flexShrink: 0 }}
                  >
                    Reabrir
                  </Button>
                ) : (
                  <Button
                    size="small"
                    disabled={zoneBusy}
                    onClick={() => onCloseZone(slot.id, z.zone_id)}
                    sx={{ flexShrink: 0, color: 'text.secondary' }}
                  >
                    Cerrar
                  </Button>
                )}
              </Box>
            )
          })}
        </Stack>
      )}
    </Box>
  )
}
