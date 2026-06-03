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
  InputAdornment,
  CircularProgress,
} from '@mui/material'
import { editAgentSchema } from '../schemas'
import type { EditAgentFormData } from '../schemas'
import { useUpdateAgent } from '../hooks/useUpdateAgent'
import { basisPointsToPercent, percentToBasisPoints } from '../types'
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
    defaultValues: { name: '', phone: '', commission: 0 },
  })

  // Prefill whenever a new agent is selected (basis points → percent).
  useEffect(() => {
    if (agent) {
      reset({
        name: agent.name,
        phone: agent.phone ?? '',
        commission: basisPointsToPercent(agent.base_commission),
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
          base_commission: percentToBasisPoints(data.commission),
        },
      },
      {
        onSuccess: onClose,
        onError: (error) => {
          if (error instanceof ServiceError) {
            if (error.status === 404) {
              setError('name', {
                type: 'manual',
                message: 'This agent no longer exists.',
              })
            } else if (error.status === 400) {
              setError('commission', {
                type: 'manual',
                message: 'Please check the values and try again.',
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
      <DialogTitle>Edit agent</DialogTitle>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              label="Name"
              fullWidth
              disabled={isLoading}
              error={!!errors.name}
              helperText={errors.name?.message}
              {...register('name')}
            />
            <TextField
              label="Phone"
              fullWidth
              disabled={isLoading}
              error={!!errors.phone}
              helperText={errors.phone?.message}
              {...register('phone')}
            />
            <TextField
              label="Base commission"
              type="number"
              fullWidth
              disabled={isLoading}
              error={!!errors.commission}
              helperText={errors.commission?.message ?? '0–100'}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">%</InputAdornment>
                  ),
                },
                htmlInput: { step: 0.01, min: 0, max: 100 },
              }}
              {...register('commission', { valueAsNumber: true })}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="contained"
            disableElevation
            disabled={isLoading}
          >
            {isLoading ? <CircularProgress size={22} color="inherit" /> : 'Save'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
