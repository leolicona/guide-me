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
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import { serviceFormSchema } from '../schemas'
import type { ServiceFormData } from '../schemas'
import { useCreateService } from '../hooks/useCreateService'
import { useUpdateService } from '../hooks/useUpdateService'
import {
  amountToCents,
  centsToAmount,
  basisPointsToPercent,
  percentToBasisPoints,
} from '../types'
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
  commission_type: 'percent',
  commission_value: 0,
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
    setValue,
    watch,
    formState: { errors },
  } = useForm<ServiceFormData>({
    resolver: zodResolver(serviceFormSchema),
    defaultValues: EMPTY,
  })
  const commissionType = watch('commission_type')

  // Prefill on open: edit → service values (cents → major); create → blank. The commission
  // value is unit-converted by its type: percent ↔ basis points, fixed ↔ centavos.
  useEffect(() => {
    if (!open) return
    if (service) {
      reset({
        name: service.name,
        description: service.description ?? '',
        base_price: centsToAmount(service.base_price),
        minimum_price: centsToAmount(service.minimum_price),
        default_capacity: service.default_capacity,
        commission_type: service.commission_type,
        commission_value:
          service.commission_type === 'fixed'
            ? centsToAmount(service.commission_value)
            : basisPointsToPercent(service.commission_value),
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
      commission_type: data.commission_type,
      commission_value:
        data.commission_type === 'fixed'
          ? amountToCents(data.commission_value)
          : percentToBasisPoints(data.commission_value),
    }

    const onError = (error: unknown) => {
      if (error instanceof ServiceError) {
        if (error.status === 404) {
          setError('name', {
            type: 'manual',
            message: 'Este servicio ya no existe.',
          })
        } else if (error.status === 400) {
          setError('minimum_price', {
            type: 'manual',
            message: 'Revisa los valores e inténtalo de nuevo.',
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
      <DialogTitle>{isEdit ? 'Editar servicio' : 'Nuevo servicio'}</DialogTitle>
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
              label="Descripción"
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
                label="Precio base"
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
                label="Precio mínimo"
                type="number"
                fullWidth
                disabled={isLoading}
                error={!!errors.minimum_price}
                helperText={
                  errors.minimum_price?.message ?? 'Debe ser ≤ al precio base'
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
                label="Capacidad por defecto"
                type="number"
                fullWidth
                disabled={isLoading}
                error={!!errors.default_capacity}
                helperText={errors.default_capacity?.message}
                slotProps={{ htmlInput: { step: 1, min: 1 } }}
                {...register('default_capacity', { valueAsNumber: true })}
              />
            </Stack>
            {/* US-A12 (rev.) — the commission ANY seller earns for this service. */}
            <Stack direction="row" spacing={2}>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={commissionType}
                onChange={(_, v) => {
                  if (v) setValue('commission_type', v, { shouldValidate: true })
                }}
                disabled={isLoading}
                aria-label="Tipo de comisión"
                sx={{ alignSelf: 'flex-start', mt: 1 }}
              >
                <ToggleButton value="percent">%</ToggleButton>
                <ToggleButton value="fixed">$ por lugar</ToggleButton>
              </ToggleButtonGroup>
              <TextField
                label="Comisión"
                type="number"
                fullWidth
                disabled={isLoading}
                error={!!errors.commission_value}
                helperText={
                  errors.commission_value?.message ??
                  (commissionType === 'fixed'
                    ? 'Monto fijo por lugar vendido — no puede exceder el precio mínimo'
                    : 'Porcentaje del precio vendido — lo gana quien venda este servicio')
                }
                slotProps={{
                  input:
                    commissionType === 'fixed'
                      ? {
                          startAdornment: (
                            <InputAdornment position="start">$</InputAdornment>
                          ),
                        }
                      : {
                          endAdornment: (
                            <InputAdornment position="end">%</InputAdornment>
                          ),
                        },
                  htmlInput:
                    commissionType === 'fixed'
                      ? { step: 0.01, min: 0 }
                      : { step: 0.01, min: 0, max: 100 },
                }}
                {...register('commission_value', { valueAsNumber: true })}
              />
            </Stack>
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
