import { useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  CircularProgress,
  Alert,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import { unitFormSchema, type UnitFormData } from '../schemas'
import { centsToAmount, unitCommissionToApi, unitCommissionFromApi } from '../types'
import type { AccommodationUnit } from '../types'
import { useUnitMutations } from '../hooks/useUnitMutations'
import { ServiceError } from '../../../services/authService'
import { UnitFields } from './UnitFields'

interface UnitFormDialogProps {
  serviceId: string
  /** null → create; a unit → edit (prefilled). */
  unit: AccommodationUnit | null
  open: boolean
  onClose: () => void
}

const EMPTY: UnitFormData = {
  name: '',
  unit_type: '',
  beds: 1,
  base_occupancy: 2,
  max_capacity: 4,
  base_rate: 0,
  weekend_rate: null,
  extra_person_fee: 0,
  min_nights: 1,
  checkin_time: '15:00',
  checkout_time: '11:00',
  amenities: [],
  commission_type: 'inherit',
  commission_value: null,
}

const toInput = (data: UnitFormData) => ({
  name: data.name.trim(),
  unit_type: data.unit_type?.trim() ? data.unit_type.trim() : null,
  beds: data.beds,
  base_occupancy: data.base_occupancy,
  max_capacity: data.max_capacity,
  base_rate: Math.round(data.base_rate * 100),
  weekend_rate: data.weekend_rate == null ? null : Math.round(data.weekend_rate * 100),
  extra_person_fee: Math.round(data.extra_person_fee * 100),
  min_nights: data.min_nights,
  checkin_time: data.checkin_time,
  checkout_time: data.checkout_time,
  amenities: data.amenities,
  ...unitCommissionToApi(data.commission_type, data.commission_value),
})

export function UnitFormDialog({ serviceId, unit, open, onClose }: UnitFormDialogProps) {
  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))
  const { create, update } = useUnitMutations(serviceId)
  const [apiError, setApiError] = useState<string | null>(null)

  const methods = useForm<UnitFormData>({
    resolver: zodResolver(unitFormSchema),
    defaultValues: EMPTY,
  })

  // Seed in render-phase on the open transition (the "store previous prop" pattern used across the
  // app), so the reset lands before paint with no cascading-render effect.
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setApiError(null)
      if (unit) {
        methods.reset({
          name: unit.name,
          unit_type: unit.unit_type ?? '',
          beds: unit.beds,
          base_occupancy: unit.base_occupancy,
          max_capacity: unit.max_capacity,
          base_rate: centsToAmount(unit.base_rate),
          weekend_rate: unit.weekend_rate == null ? null : centsToAmount(unit.weekend_rate),
          extra_person_fee: centsToAmount(unit.extra_person_fee),
          min_nights: unit.min_nights,
          checkin_time: unit.checkin_time,
          checkout_time: unit.checkout_time,
          amenities: unit.amenities,
          ...unitCommissionFromApi(unit.commission_type, unit.commission_value),
        })
      } else {
        methods.reset(EMPTY)
      }
    }
  }

  const onSubmit = (data: UnitFormData) => {
    setApiError(null)
    const payload = toInput(data)
    const onError = (error: unknown) => {
      if (error instanceof ServiceError && error.status === 409) {
        setApiError('No se pudo guardar — revisa que no haya conflictos.')
      } else {
        setApiError('Revisa los valores e inténtalo de nuevo.')
      }
    }
    if (unit) {
      update.mutate({ unitId: unit.id, data: payload }, { onSuccess: onClose, onError })
    } else {
      create.mutate(payload, { onSuccess: onClose, onError })
    }
  }

  const isLoading = create.isPending || update.isPending

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen}>
      <DialogTitle>{unit ? 'Editar unidad' : 'Nueva unidad'}</DialogTitle>
      <FormProvider {...methods}>
        <form onSubmit={methods.handleSubmit(onSubmit)} noValidate>
          <DialogContent>
            {apiError && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {apiError}
              </Alert>
            )}
            <UnitFields disabled={isLoading} />
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
      </FormProvider>
    </Dialog>
  )
}
