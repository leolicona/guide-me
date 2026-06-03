import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  CircularProgress,
} from '@mui/material'
import { useDeactivateService } from '../hooks/useDeactivateService'
import { useReactivateService } from '../hooks/useReactivateService'
import type { Service } from '../types'

export type ServiceStatusAction = 'deactivate' | 'reactivate'

interface ConfirmServiceStatusDialogProps {
  service: Service | null
  action: ServiceStatusAction
  open: boolean
  onClose: () => void
}

export function ConfirmServiceStatusDialog({
  service,
  action,
  open,
  onClose,
}: ConfirmServiceStatusDialogProps) {
  const deactivate = useDeactivateService()
  const reactivate = useReactivateService()
  const mutation = action === 'deactivate' ? deactivate : reactivate

  const onConfirm = () => {
    if (!service) return
    mutation.mutate(service.id, { onSuccess: onClose })
  }

  const isDeactivate = action === 'deactivate'

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {isDeactivate
          ? `Deactivate ${service?.name ?? 'service'}?`
          : `Reactivate ${service?.name ?? 'service'}?`}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {isDeactivate
            ? 'It is hidden from new bookings, but its extras and history are kept.'
            : 'It becomes available for new bookings again.'}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disableElevation
          color={isDeactivate ? 'error' : 'primary'}
          onClick={onConfirm}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? (
            <CircularProgress size={22} color="inherit" />
          ) : isDeactivate ? (
            'Deactivate'
          ) : (
            'Reactivate'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
