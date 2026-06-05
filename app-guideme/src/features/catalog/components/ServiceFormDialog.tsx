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
import { serviceFormSchema } from '../schemas'
import type { ServiceFormData } from '../schemas'
import { useCreateService } from '../hooks/useCreateService'
import { useUpdateService } from '../hooks/useUpdateService'
import { amountToCents, centsToAmount } from '../types'
import type { Service } from '../types'
import { ServiceError } from '../../../services/authService'

interface ServiceFormDialogProps {
  /** null → create mode; a service → edit mode (prefilled). */
  service: Service | null
  open: boolean
  onClose: () => void
}

const EMPTY: ServiceFormData = {
  name: '',
  description: '',
  base_price: 0,
  minimum_price: 0,
  default_capacity: 1,
  commission_bonus: 0,
}

export function ServiceFormDialog({
  service,
  open,
  onClose,
}: ServiceFormDialogProps) {
  const isEdit = !!service
  const createMutation = useCreateService()
  const updateMutation = useUpdateService()

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ServiceFormData>({
    resolver: zodResolver(serviceFormSchema),
    defaultValues: EMPTY,
  })

  // Prefill on open: edit → service values (cents → major); create → blank.
  useEffect(() => {
    if (!open) return
    if (service) {
      reset({
        name: service.name,
        description: service.description ?? '',
        base_price: centsToAmount(service.base_price),
        minimum_price: centsToAmount(service.minimum_price),
        default_capacity: service.default_capacity,
        commission_bonus: centsToAmount(service.commission_bonus),
      })
    } else {
      reset(EMPTY)
    }
  }, [open, service, reset])

  const onSubmit = (data: ServiceFormData) => {
    const payload = {
      name: data.name.trim(),
      description: data.description?.trim() ? data.description.trim() : null,
      base_price: amountToCents(data.base_price),
      minimum_price: amountToCents(data.minimum_price),
      default_capacity: data.default_capacity,
      commission_bonus: amountToCents(data.commission_bonus),
    }

    const onError = (error: unknown) => {
      if (error instanceof ServiceError) {
        if (error.status === 404) {
          setError('name', {
            type: 'manual',
            message: 'This service no longer exists.',
          })
        } else if (error.status === 400) {
          setError('minimum_price', {
            type: 'manual',
            message: 'Please check the values and try again.',
          })
        }
      }
    }

    if (service) {
      updateMutation.mutate(
        { id: service.id, data: payload },
        { onSuccess: onClose, onError },
      )
    } else {
      createMutation.mutate(payload, { onSuccess: onClose, onError })
    }
  }

  const isLoading = createMutation.isPending || updateMutation.isPending

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{isEdit ? 'Edit service' : 'New service'}</DialogTitle>
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
              label="Description"
              fullWidth
              multiline
              minRows={2}
              disabled={isLoading}
              error={!!errors.description}
              helperText={errors.description?.message}
              {...register('description')}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Base price"
                type="number"
                fullWidth
                disabled={isLoading}
                error={!!errors.base_price}
                helperText={errors.base_price?.message}
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">$</InputAdornment>
                    ),
                  },
                  htmlInput: { step: 0.01, min: 0 },
                }}
                {...register('base_price', { valueAsNumber: true })}
              />
              <TextField
                label="Minimum price"
                type="number"
                fullWidth
                disabled={isLoading}
                error={!!errors.minimum_price}
                helperText={
                  errors.minimum_price?.message ?? 'Must be ≤ base price'
                }
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">$</InputAdornment>
                    ),
                  },
                  htmlInput: { step: 0.01, min: 0 },
                }}
                {...register('minimum_price', { valueAsNumber: true })}
              />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Default capacity"
                type="number"
                fullWidth
                disabled={isLoading}
                error={!!errors.default_capacity}
                helperText={errors.default_capacity?.message}
                slotProps={{ htmlInput: { step: 1, min: 1 } }}
                {...register('default_capacity', { valueAsNumber: true })}
              />
              <TextField
                label="Commission bonus"
                type="number"
                fullWidth
                disabled={isLoading}
                error={!!errors.commission_bonus}
                helperText={
                  errors.commission_bonus?.message ?? "Added to the agent's % per pass sold"
                }
                slotProps={{
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">$</InputAdornment>
                    ),
                  },
                  htmlInput: { step: 0.01, min: 0 },
                }}
                {...register('commission_bonus', { valueAsNumber: true })}
              />
            </Stack>
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
