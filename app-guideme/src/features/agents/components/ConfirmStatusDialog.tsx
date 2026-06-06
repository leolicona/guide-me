import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  CircularProgress,
} from '@mui/material'
import { useDeactivateAgent } from '../hooks/useDeactivateAgent'
import { useReactivateAgent } from '../hooks/useReactivateAgent'
import type { Agent } from '../types'

export type StatusAction = 'deactivate' | 'reactivate'

interface ConfirmStatusDialogProps {
  agent: Agent | null
  action: StatusAction
  open: boolean
  onClose: () => void
}

export function ConfirmStatusDialog({
  agent,
  action,
  open,
  onClose,
}: ConfirmStatusDialogProps) {
  const deactivate = useDeactivateAgent()
  const reactivate = useReactivateAgent()
  const mutation = action === 'deactivate' ? deactivate : reactivate

  const onConfirm = () => {
    if (!agent) return
    mutation.mutate(agent.id, { onSuccess: onClose })
  }

  const isDeactivate = action === 'deactivate'

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {isDeactivate
          ? `¿Suspender a ${agent?.name ?? 'agente'}?`
          : `¿Reactivar a ${agent?.name ?? 'agente'}?`}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {isDeactivate
            ? 'Perderá el acceso a la plataforma de inmediato, pero se conservará su historial de ventas.'
            : 'Recuperará el acceso a la plataforma.'}
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
            'Suspender'
          ) : (
            'Reactivar'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
