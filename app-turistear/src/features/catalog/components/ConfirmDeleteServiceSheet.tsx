import { Alert } from '@mui/material'
import { ConfirmSheet } from '../../../components'
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
export function ConfirmDeleteServiceSheet({ service, open, onClose }: Props) {
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
    <ConfirmSheet
      open={open}
      onClose={handleClose}
      title={`¿Eliminar ${service?.name ?? 'servicio'}?`}
      description="Esta acción es permanente y elimina el servicio junto con sus horarios, extras y comisiones de afiliados. No se puede deshacer."
      confirmLabel="Eliminar"
      busy={remove.isPending}
      onConfirm={onConfirm}
      hideConfirm={hasFolios}
      cancelLabel={hasFolios ? 'Cerrar' : 'Cancelar'}
      error={
        hasFolios ? (
          <Alert severity="warning">
            Este servicio tiene ventas registradas, por lo que no puede eliminarse (el historial
            debe conservarse). Desactívalo en su lugar.
          </Alert>
        ) : remove.isError ? (
          <Alert severity="error">No se pudo eliminar el servicio. Inténtalo de nuevo.</Alert>
        ) : undefined
      }
    />
  )
}
