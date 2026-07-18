import { ConfirmSheet } from '../../../components'
import { useAffiliateStatus } from '../hooks/useAffiliates'

export type AffiliateStatusAction = 'deactivate' | 'reactivate'

interface ConfirmAffiliateStatusSheetProps {
  affiliateId: string
  affiliateName: string
  action: AffiliateStatusAction
  open: boolean
  onClose: () => void
}

// Suspend/reactivate confirmation, shared by the detail-page header and the list-row switch.
// `useAffiliateStatus` invalidates both the list and detail queries, so it works from either host.
export function ConfirmAffiliateStatusSheet({
  affiliateId,
  affiliateName,
  action,
  open,
  onClose,
}: ConfirmAffiliateStatusSheetProps) {
  const { deactivate, reactivate } = useAffiliateStatus(affiliateId)
  const mutation = action === 'deactivate' ? deactivate : reactivate
  const isDeactivate = action === 'deactivate'

  return (
    <ConfirmSheet
      open={open}
      onClose={onClose}
      title={
        isDeactivate ? `¿Suspender a ${affiliateName}?` : `¿Reactivar a ${affiliateName}?`
      }
      description={
        isDeactivate
          ? 'Sus usuarios perderán el acceso al portal de inmediato, pero se conservará su historial de ventas y comisiones.'
          : 'Sus usuarios recuperarán el acceso al portal.'
      }
      confirmLabel={isDeactivate ? 'Suspender' : 'Reactivar'}
      confirmColor={isDeactivate ? 'error' : 'primary'}
      busy={mutation.isPending}
      onConfirm={() => mutation.mutate(undefined, { onSuccess: onClose })}
    />
  )
}
