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
          ? `Suspend ${agent?.name ?? 'agent'}?`
          : `Reactivate ${agent?.name ?? 'agent'}?`}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {isDeactivate
            ? 'They lose access to the platform immediately, but their sales history is kept.'
            : 'They regain access to the platform.'}
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
            'Suspend'
          ) : (
            'Reactivate'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
