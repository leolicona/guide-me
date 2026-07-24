import { useState } from 'react'
import { Typography, Stack, IconButton, Button, Menu, MenuItem, ListItemIcon } from '@mui/material'
import WhatsAppIcon from '@mui/icons-material/WhatsApp'
import MoreVertRounded from '@mui/icons-material/MoreVertRounded'
import RestartAltRounded from '@mui/icons-material/RestartAltRounded'
import PersonRemoveRounded from '@mui/icons-material/PersonRemoveRounded'
import LockRounded from '@mui/icons-material/LockRounded'
import { ListRow, StatusChip } from '../../../components'
import { normalizePhone } from '../../pos/phone'
import type { Operator } from '../types'

interface OperatorRowProps {
  operator: Operator
  onReset: (o: Operator) => void
  onRemove: (o: Operator) => void
}

// Build the manager's WhatsApp deep link: opens THEIR WhatsApp with the operator's number +
// a pre-written message carrying the access link (US-AF11). Null if either piece is missing.
const buildWhatsAppUrl = (operator: Operator): string | null => {
  if (!operator.access_url) return null
  const { e164, valid } = normalizePhone(operator.phone)
  if (!valid) return null
  const msg =
    `Hola ${operator.name}, este es tu acceso a la caja. ` +
    `Ábrelo en tu teléfono y crea tu PIN de 4 dígitos:\n${operator.access_url}`
  return `https://wa.me/${e164}?text=${encodeURIComponent(msg)}`
}

// US-AF10/AF11/AF12 — one operator row: name + phone, a status chip (locked / PIN pending /
// removed), a prominent "Enviar acceso" WhatsApp button, and an overflow menu (reset / remove).
export function OperatorRow({ operator, onReset, onRemove }: OperatorRowProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const removed = operator.status === 'removed'
  const waUrl = buildWhatsAppUrl(operator)

  const chip = removed ? (
    <StatusChip status="suspended" label="Retirado" />
  ) : operator.locked ? (
    <StatusChip tone="error" icon={<LockRounded />} label="Bloqueado" />
  ) : operator.pin_set ? (
    <StatusChip status="active" />
  ) : (
    <StatusChip status="pending" label="PIN pendiente" />
  )

  return (
    <ListRow
      title={operator.name}
      inactive={removed}
      meta={
        <Stack direction="row" spacing={1.5} sx={{ mt: 0.5, alignItems: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {operator.phone}
          </Typography>
          {chip}
        </Stack>
      }
      cornerAction={
        !removed ? (
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
            {waUrl && (
              <Button
                size="small"
                variant="contained"
                color="secondary"
                disableElevation
                startIcon={<WhatsAppIcon />}
                component="a"
                href={waUrl}
                target="_blank"
                rel="noopener"
                sx={{ whiteSpace: 'nowrap' }}
              >
                Enviar acceso
              </Button>
            )}
            <IconButton aria-label="Más acciones" onClick={(e) => setAnchor(e.currentTarget)}>
              <MoreVertRounded fontSize="small" />
            </IconButton>
            <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
              <MenuItem
                onClick={() => {
                  setAnchor(null)
                  onReset(operator)
                }}
              >
                <ListItemIcon>
                  <RestartAltRounded fontSize="small" />
                </ListItemIcon>
                Restablecer PIN
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setAnchor(null)
                  onRemove(operator)
                }}
                sx={{ color: 'error.main' }}
              >
                <ListItemIcon sx={{ color: 'error.main' }}>
                  <PersonRemoveRounded fontSize="small" />
                </ListItemIcon>
                Quitar
              </MenuItem>
            </Menu>
          </Stack>
        ) : undefined
      }
    />
  )
}
