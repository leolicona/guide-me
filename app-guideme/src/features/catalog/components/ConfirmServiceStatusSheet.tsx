import { ConfirmSheet } from '../../../components'
import { useDeactivateService } from '../hooks/useDeactivateService'
import { useReactivateService } from '../hooks/useReactivateService'
import type { Service } from '../types'

export type ServiceStatusAction = 'deactivate' | 'reactivate'

interface ConfirmServiceStatusSheetProps {
  service: Service | null
  action: ServiceStatusAction
  open: boolean
  onClose: () => void
}

export function ConfirmServiceStatusSheet({
  service,
  action,
  open,
  onClose,
}: ConfirmServiceStatusSheetProps) {
  const deactivate = useDeactivateService()
  const reactivate = useReactivateService()
  const mutation = action === 'deactivate' ? deactivate : reactivate

  const onConfirm = () => {
    if (!service) return
    mutation.mutate(service.id, { onSuccess: onClose })
  }

  const isDeactivate = action === 'deactivate'

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={
        isDeactivate
          ? `¿Desactivar ${service?.name ?? 'servicio'}?`
          : `¿Reactivar ${service?.name ?? 'servicio'}?`
      }
      description={
        isDeactivate
          ? 'Quedará oculto para nuevas reservas, pero se conservarán sus extras e historial.'
          : 'Volverá a estar disponible para nuevas reservas.'
      }
      confirmLabel={isDeactivate ? 'Desactivar' : 'Reactivar'}
      confirmColor={isDeactivate ? 'error' : 'primary'}
      busy={mutation.isPending}
      onConfirm={onConfirm}
    />
  )
}
