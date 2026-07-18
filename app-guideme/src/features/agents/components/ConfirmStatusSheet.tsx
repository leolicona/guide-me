import { ConfirmSheet } from '../../../components'
import { useDeactivateAgent } from '../hooks/useDeactivateAgent'
import { useReactivateAgent } from '../hooks/useReactivateAgent'
import type { Agent } from '../types'

export type StatusAction = 'deactivate' | 'reactivate'

interface ConfirmStatusSheetProps {
  agent: Agent | null
  action: StatusAction
  open: boolean
  onClose: () => void
}

export function ConfirmStatusSheet({
  agent,
  action,
  open,
  onClose,
}: ConfirmStatusSheetProps) {
  const deactivate = useDeactivateAgent()
  const reactivate = useReactivateAgent()
  const mutation = action === 'deactivate' ? deactivate : reactivate

  const onConfirm = () => {
    if (!agent) return
    mutation.mutate(agent.id, { onSuccess: onClose })
  }

  const isDeactivate = action === 'deactivate'

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={
        isDeactivate
          ? `¿Suspender a ${agent?.name ?? 'agente'}?`
          : `¿Reactivar a ${agent?.name ?? 'agente'}?`
      }
      description={
        isDeactivate
          ? 'Perderá el acceso a la plataforma de inmediato, pero se conservará su historial de ventas.'
          : 'Recuperará el acceso a la plataforma.'
      }
      confirmLabel={isDeactivate ? 'Suspender' : 'Reactivar'}
      confirmColor={isDeactivate ? 'error' : 'primary'}
      busy={mutation.isPending}
      onConfirm={onConfirm}
    />
  )
}
