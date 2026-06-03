import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
} from '@mui/material'
import { ExtrasPanel } from './ExtrasPanel'
import type { Service } from '../types'

interface ExtrasManagerProps {
  service: Service | null
  open: boolean
  onClose: () => void
}

// Dialog wrapper around ExtrasPanel — opened from a service row.
export function ExtrasManager({ service, open, onClose }: ExtrasManagerProps) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Extras — {service?.name ?? ''}</DialogTitle>
      <DialogContent>{service && <ExtrasPanel serviceId={service.id} />}</DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  )
}
