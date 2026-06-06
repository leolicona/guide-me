import { useEffect } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  FormHelperText,
  CircularProgress,
} from '@mui/material'
import { scheduleFormSchema } from '../schemas'
import type { ScheduleFormData } from '../schemas'
import { useCreateSchedule } from '../hooks/useCreateSchedule'
import { WEEKDAY_LABELS } from '../types'
import { ServiceError } from '../../../services/authService'

interface ScheduleFormDialogProps {
  serviceId: string
  defaultCapacity: number
  open: boolean
  onClose: () => void
  /** Called with the number of slots materialized on success. */
  onCreated: (slotsGenerated: number) => void
}

export function ScheduleFormDialog({
  serviceId,
  defaultCapacity,
  open,
  onClose,
  onCreated,
}: ScheduleFormDialogProps) {
  const createMutation = useCreateSchedule(serviceId)

  const {
    register,
    handleSubmit,
    reset,
    control,
    setError,
    formState: { errors },
  } = useForm<ScheduleFormData>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      weekdays: [],
      start_time: '',
      capacity: defaultCapacity,
      start_date: '',
      end_date: '',
    },
  })

  useEffect(() => {
    if (open) {
      reset({
        weekdays: [],
        start_time: '',
        capacity: defaultCapacity,
        start_date: '',
        end_date: '',
      })
    }
  }, [open, defaultCapacity, reset])

  const onSubmit = (data: ScheduleFormData) => {
    createMutation.mutate(data, {
      onSuccess: (result) => {
        onCreated(result.slots_generated)
        onClose()
      },
      onError: (error: unknown) => {
        if (error instanceof ServiceError && error.status === 400) {
          setError('end_date', {
            type: 'manual',
            message: 'Revisa las fechas (el periodo no puede exceder un año).',
          })
        }
      },
    })
  }

  const isLoading = createMutation.isPending

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Nuevo horario recurrente</DialogTitle>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 0.5 }}>
            <div>
              <Typography variant="overline" color="text.secondary">
                Repetir los
              </Typography>
              <Controller
                control={control}
                name="weekdays"
                render={({ field }) => (
                  <ToggleButtonGroup
                    value={field.value}
                    onChange={(_, value: number[]) => field.onChange(value)}
                    size="small"
                    sx={{ flexWrap: 'wrap', mt: 0.5 }}
                  >
                    {WEEKDAY_LABELS.map((label, day) => (
                      <ToggleButton key={day} value={day} disabled={isLoading}>
                        {label}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                )}
              />
              {errors.weekdays && (
                <FormHelperText error>{errors.weekdays.message}</FormHelperText>
              )}
            </div>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
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

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label="Desde"
                type="date"
                fullWidth
                disabled={isLoading}
                error={!!errors.start_date}
                helperText={errors.start_date?.message}
                slotProps={{ inputLabel: { shrink: true } }}
                {...register('start_date')}
              />
              <TextField
                label="Hasta"
                type="date"
                fullWidth
                disabled={isLoading}
                error={!!errors.end_date}
                helperText={errors.end_date?.message}
                slotProps={{ inputLabel: { shrink: true } }}
                {...register('end_date')}
              />
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={isLoading}>
            Cancelar
          </Button>
          <Button type="submit" variant="contained" disableElevation disabled={isLoading}>
            {isLoading ? <CircularProgress size={22} color="inherit" /> : 'Generar fechas'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  )
}
