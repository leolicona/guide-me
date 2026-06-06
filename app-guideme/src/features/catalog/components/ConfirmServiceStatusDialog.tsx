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
          ? `¿Desactivar ${service?.name ?? 'servicio'}?`
          : `¿Reactivar ${service?.name ?? 'servicio'}?`}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {isDeactivate
            ? 'Quedará oculto para nuevas reservas, pero se conservarán sus extras e historial.'
            : 'Volverá a estar disponible para nuevas reservas.'}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={mutation.isPending}>
          Cancelar
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
            'Desactivar'
          ) : (
            'Reactivar'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
