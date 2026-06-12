import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Stack,
  CircularProgress,
} from '@mui/material'
import { editAgentSchema } from '../schemas'
import type { EditAgentFormData } from '../schemas'
import { useUpdateAgent } from '../hooks/useUpdateAgent'
import type { Agent } from '../types'
import { ServiceError } from '../../../services/authService'

interface EditAgentDialogProps {
  agent: Agent | null
  open: boolean
  onClose: () => void
}

export function EditAgentDialog({ agent, open, onClose }: EditAgentDialogProps) {
  const updateMutation = useUpdateAgent()

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<EditAgentFormData>({
    resolver: zodResolver(editAgentSchema),
    defaultValues: { name: '', phone: '' },
  })

  // Prefill whenever a new agent is selected. (No commission here — it is service-based,
  // edited in the catalog: docs/commissions/service-based-commission.spec.md.)
  useEffect(() => {
    if (agent) {
      reset({
        name: agent.name,
        phone: agent.phone ?? '',
      })
    }
  }, [agent, reset])

  const onSubmit = (data: EditAgentFormData) => {
    if (!agent) return
    const phone = data.phone?.trim() ? data.phone.trim() : null
    updateMutation.mutate(
      {
        id: agent.id,
        data: {
          name: data.name.trim(),
          phone,
        },
      },
      {
        onSuccess: onClose,
        onError: (error) => {
          if (error instanceof ServiceError) {
            if (error.status === 404) {
              setError('name', {
                type: 'manual',
                message: 'Este agente ya no existe.',
              })
            } else if (error.status === 400) {
              setError('name', {
                type: 'manual',
                message: 'Revisa los valores e inténtalo de nuevo.',
              })
            }
          }
        },
      },
    )
  }

  const isLoading = updateMutation.isPending

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Editar agente</DialogTitle>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              label="Nombre"
              fullWidth
              disabled={isLoading}
              error={!!errors.name}
              helperText={errors.name?.message}
              {...register('name')}
            />
            <TextField
              label="Teléfono"
              fullWidth
              disabled={isLoading}
              error={!!errors.phone}
              helperText={errors.phone?.message}
              {...register('phone')}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={isLoading}>
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="contained"
            disableElevation
            disabled={isLoading}
          >
            {isLoading ? <CircularProgress size={22} color="inherit" /> : 'Guardar'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
