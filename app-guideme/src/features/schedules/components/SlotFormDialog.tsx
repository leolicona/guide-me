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
import { slotFormSchema } from '../schemas'
import type { SlotFormData } from '../schemas'
import { useCreateSlot } from '../hooks/useCreateSlot'
import { useUpdateSlot } from '../hooks/useUpdateSlot'
import type { Slot } from '../types'
import { ServiceError } from '../../../services/authService'

interface SlotFormDialogProps {
  serviceId: string
  /** Capacity to pre-fill when creating a new slot. */
  defaultCapacity: number
  /** null → create mode; a slot → edit mode (prefilled). */
  slot: Slot | null
  open: boolean
  onClose: () => void
}

export function SlotFormDialog({
  serviceId,
  defaultCapacity,
  slot,
  open,
  onClose,
}: SlotFormDialogProps) {
  const isEdit = !!slot
  const createMutation = useCreateSlot(serviceId)
  const updateMutation = useUpdateSlot(serviceId)

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<SlotFormData>({
    resolver: zodResolver(slotFormSchema),
    defaultValues: { date: '', start_time: '', capacity: defaultCapacity },
  })

  useEffect(() => {
    if (!open) return
    if (slot) {
      reset({
        date: slot.date,
        start_time: slot.start_time,
        capacity: slot.capacity,
      })
    } else {
      reset({ date: '', start_time: '', capacity: defaultCapacity })
    }
  }, [open, slot, defaultCapacity, reset])

  const onSubmit = (data: SlotFormData) => {
    const onError = (error: unknown) => {
      if (!(error instanceof ServiceError)) return
      if (error.status === 409) {
        if (error.message.toLowerCase().includes('capacity')) {
          setError('capacity', {
            type: 'manual',
            message: 'La capacidad es menor a los lugares ya reservados.',
          })
        } else {
          setError('start_time', {
            type: 'manual',
            message: 'Ya existe una fecha en ese día y hora.',
          })
        }
      } else if (error.status === 404) {
        setError('date', { type: 'manual', message: 'Esta fecha ya no existe.' })
      } else if (error.status === 400) {
        setError('date', { type: 'manual', message: 'Revisa los valores e inténtalo de nuevo.' })
      }
    }

    if (slot) {
      updateMutation.mutate(
        { slotId: slot.id, data },
        { onSuccess: onClose, onError },
      )
    } else {
      createMutation.mutate(data, { onSuccess: onClose, onError })
    }
  }

  const isLoading = createMutation.isPending || updateMutation.isPending

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{isEdit ? 'Editar fecha' : 'Agregar fecha'}</DialogTitle>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <TextField
              label="Fecha"
              type="date"
              fullWidth
              disabled={isLoading}
              error={!!errors.date}
              helperText={errors.date?.message}
              slotProps={{ inputLabel: { shrink: true } }}
              {...register('date')}
            />
            <TextField
              label="Hora de inicio"
              type="time"
              fullWidth
              disabled={isLoading}
              error={!!errors.start_time}
              helperText={errors.start_time?.message}
              slotProps={{ inputLabel: { shrink: true } }}
              {...register('start_time')}
            />
            <TextField
              label="Capacidad"
              type="number"
              fullWidth
              disabled={isLoading}
              error={!!errors.capacity}
              helperText={errors.capacity?.message}
              slotProps={{ htmlInput: { step: 1, min: 1 } }}
              {...register('capacity', { valueAsNumber: true })}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={isLoading}>
            Cancelar
          </Button>
          <Button type="submit" variant="contained" disableElevation disabled={isLoading}>
            {isLoading ? <CircularProgress size={22} color="inherit" /> : 'Guardar'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
