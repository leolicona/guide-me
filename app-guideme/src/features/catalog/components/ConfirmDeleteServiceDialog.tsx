import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material'
import { useDeleteService } from '../hooks/useDeleteService'
import { ServiceError } from '../../../services/authService'
import type { Service } from '../types'

interface Props {
  service: Service | null
  open: boolean
  onClose: () => void
}

// US-A58 — permanent delete. The backend rejects with 409 SERVICE_HAS_FOLIOS when the service has
// sales history; we surface that as a steer toward deactivation rather than a raw error.
export function ConfirmDeleteServiceDialog({ service, open, onClose }: Props) {
  const remove = useDeleteService()

  const hasFolios =
    remove.error instanceof ServiceError && remove.error.code === 'SERVICE_HAS_FOLIOS'

  const handleClose = () => {
    remove.reset()
    onClose()
  }

  const onConfirm = () => {
    if (!service) return
    remove.mutate(service.id, { onSuccess: handleClose })
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="xs" fullWidth>
      <DialogTitle>¿Eliminar {service?.name ?? 'servicio'}?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Esta acción es permanente y elimina el servicio junto con sus horarios, extras y
          comisiones de afiliados. No se puede deshacer.
        </DialogContentText>
        {hasFolios && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            Este servicio tiene ventas registradas, por lo que no puede eliminarse (el historial
            debe conservarse). Desactívalo en su lugar.
          </Alert>
        )}
        {remove.isError && !hasFolios && (
          <Alert severity="error" sx={{ mt: 2 }}>
            No se pudo eliminar el servicio. Inténtalo de nuevo.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={remove.isPending}>
          {hasFolios ? 'Cerrar' : 'Cancelar'}
        </Button>
        {!hasFolios && (
          <Button
            variant="contained"
            color="error"
            disableElevation
            onClick={onConfirm}
            disabled={remove.isPending}
          >
            {remove.isPending ? <CircularProgress size={22} color="inherit" /> : 'Eliminar'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
