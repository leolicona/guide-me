import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  TextField,
  MenuItem,
  Stack,
  Box,
  Typography,
  Collapse,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import { FormSheet } from '../../../components'
import { serviceFormSchema } from '../schemas'
import type { ServiceFormData } from '../schemas'
import { CATEGORY_OPTIONS, pricesAtServiceLevel, type ServiceCategory } from '../categories'
import { useCreateService } from '../hooks/useCreateService'
import { useUpdateService } from '../hooks/useUpdateService'
import {
  amountToCents,
  centsToAmount,
  basisPointsToPercent,
  percentToBasisPoints,
  FLEX_CAP_MAX_PCT,
} from '../types'
import type { Service } from '../types'
import { ServiceError } from '../../../services/authService'

interface ServiceFormSheetProps {
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
  // US-A37 — no category pre-selected for a new service; an empty value is invalid
  // (required), so the dropdown opens blank and must be chosen before saving.
  category: '' as ServiceCategory,
  commission_type: 'percent',
  commission_value: 0,
  // US-A36 — new services default to Hard Cap (strict, no overbooking).
  is_flexible: false,
  flex_capacity_pct: 0,
}

export function ServiceFormSheet({
  service,
  open,
  onClose,
}: ServiceFormSheetProps) {
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
  const category = watch('category')
  // Unit-based categories price and allocate per unit type, not at the service level — so the
  // service-level price / capacity / allocation fields don't apply and are hidden (parity with
  // the create Wizard's unit track). Reactive on `category` so switching it re-reveals them.
  const showServicePricing = pricesAtServiceLevel(category)
  const isFlexible = watch('is_flexible')
  const flexPct = watch('flex_capacity_pct')
  const baseCapacity = watch('default_capacity')
  // Live estimate of the extra places the flexible margin grants (floor, matching the server).
  const extraPlaces =
    isFlexible && flexPct >= 1 && baseCapacity >= 1
      ? Math.floor((baseCapacity * flexPct) / 100)
      : 0

  // Prefill on open: edit → service values (cents → major); create → blank. The commission
  // value is unit-converted by its type: percent ↔ basis points, fixed ↔ centavos.
  // (The sheet stays mounted while closed, so keying the effect on `open` is reliable.)
  useEffect(() => {
    if (!open) return
    if (service) {
      reset({
        name: service.name,
        description: service.description ?? '',
        base_price: centsToAmount(service.base_price),
        minimum_price: centsToAmount(service.minimum_price),
        default_capacity: service.default_capacity,
        // US-A37 — a legacy (null) service opens blank and must be categorized to save.
        category: service.category ?? ('' as ServiceCategory),
        commission_type: service.commission_type,
        commission_value:
          service.commission_type === 'fixed'
            ? centsToAmount(service.commission_value)
            : basisPointsToPercent(service.commission_value),
        is_flexible: service.is_flexible,
        flex_capacity_pct: service.flex_capacity_pct,
      })
    } else {
      reset(EMPTY)
    }
  }, [open, service, reset])

  const onSubmit = (data: ServiceFormData) => {
    const unitBasedSubmit = !pricesAtServiceLevel(data.category)
    const payload = {
      name: data.name.trim(),
      description: data.description?.trim() ? data.description.trim() : null,
      // US-A37 — required; the schema guarantees a valid enum value here.
      category: data.category,
      commission_type: data.commission_type,
      commission_value:
        data.commission_type === 'fixed'
          ? amountToCents(data.commission_value)
          : percentToBasisPoints(data.commission_value),
      // Unit-based categories carry canonical zeros at the service level (rates/capacity live
      // on the units) — forced here so hidden fields can never persist a stale value, keeping
      // the record consistent with the unit-based model (mirrors the Wizard's unit-track create
      // path). Service-priced categories persist the fields the form actually shows.
      ...(unitBasedSubmit
        ? {
            base_price: 0,
            minimum_price: 0,
            default_capacity: 1,
            is_flexible: false,
            flex_capacity_pct: 0,
          }
        : {
            base_price: amountToCents(data.base_price),
            minimum_price: amountToCents(data.minimum_price),
            default_capacity: data.default_capacity,
            // US-A36 — Hard Cap always persists a 0 tolerance (the server coerces it too).
            is_flexible: data.is_flexible,
            flex_capacity_pct: data.is_flexible ? data.flex_capacity_pct : 0,
          }),
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
    <FormSheet
      open={open}
      onClose={onClose}
      title={isEdit ? 'Editar servicio' : 'Nuevo servicio'}
      submitLabel="Guardar"
      busy={isLoading}
      onSubmit={handleSubmit(onSubmit)}
    >
      <Stack spacing={2}>
            <TextField
              label="Nombre"
              fullWidth
              disabled={isLoading}
              error={!!errors.name}
              helperText={errors.name?.message}
              // RHF sets the value via reset() without firing an input event, so MUI can't
              // auto-detect the pre-filled state — pin the label up so it never overlaps the
              // prefilled text on edit (empty state shows the placeholder cleanly).
              slotProps={{ inputLabel: { shrink: true } }}
              {...register('name')}
            />
            {/* US-A37 — required primary category; classifies the whole service for the POS. */}
            <TextField
              select
              label="Categoría"
              fullWidth
              required
              disabled={isLoading}
              value={category ?? ''}
              onChange={(e) =>
                setValue('category', e.target.value as ServiceCategory, {
                  shouldValidate: true,
                })
              }
              error={!!errors.category}
              helperText={
                errors.category?.message ?? 'Organiza el catálogo y los filtros del POS'
              }
            >
              {CATEGORY_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Descripción"
              fullWidth
              multiline
              minRows={2}
              disabled={isLoading}
              error={!!errors.description}
              helperText={errors.description?.message}
              // Same as Nombre — keep the label floated so a prefilled description doesn't
              // collide with it on edit.
              slotProps={{ inputLabel: { shrink: true } }}
              {...register('description')}
            />

            {!showServicePricing && (
              // A unit-based service prices and allocates per unit type, so the service-level
              // fields below don't apply — surfaced so the shorter form doesn't read as broken.
              <Typography variant="body2" color="text.secondary">
                Las tarifas y el cupo de un hospedaje se definen en cada tipo de unidad.
              </Typography>
            )}

            {showServicePricing && (
              <>
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

            {/* US-A36 — capacity mode (Hard Cap by default) + overbooking tolerance. */}
            <Box>
              <Typography
                variant="subtitle2"
                color="text.secondary"
                sx={{ mb: 1 }}
              >
                Tipo de cupo
              </Typography>
              <ToggleButtonGroup
                exclusive
                fullWidth
                size="small"
                value={isFlexible ? 'flex' : 'hard'}
                onChange={(_, v) => {
                  if (!v) return
                  const flex = v === 'flex'
                  setValue('is_flexible', flex, { shouldValidate: true })
                  // Leaving Soft Cap clears the margin so a stale value can't be saved.
                  if (!flex) setValue('flex_capacity_pct', 0, { shouldValidate: true })
                }}
                disabled={isLoading}
                aria-label="Tipo de cupo"
              >
                <ToggleButton value="hard">Estricto</ToggleButton>
                <ToggleButton value="flex">Flexible</ToggleButton>
              </ToggleButtonGroup>

              <Collapse in={isFlexible} unmountOnExit>
                <TextField
                  label="Lugares extra permitidos"
                  type="number"
                  fullWidth
                  disabled={isLoading}
                  error={!!errors.flex_capacity_pct}
                  helperText={
                    errors.flex_capacity_pct?.message ??
                    (extraPlaces > 0
                      ? `Permite sobrevender ~${extraPlaces} lugar${extraPlaces > 1 ? 'es' : ''} por horario con cupo ${baseCapacity} (se calcula sobre el cupo real de cada horario). Asegura ventas de último minuto sin sobrepasar la operación.`
                      : `Tolerancia de sobreventa, entre 1% y ${FLEX_CAP_MAX_PCT}% del cupo de cada horario.`)
                  }
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">%</InputAdornment>
                      ),
                    },
                    htmlInput: { step: 1, min: 1, max: FLEX_CAP_MAX_PCT },
                  }}
                  sx={{ mt: 2 }}
                  {...register('flex_capacity_pct', { valueAsNumber: true })}
                />
              </Collapse>
            </Box>
              </>
            )}

            {/* US-A12 (rev.) — the commission ANY seller earns for this service. The toggle group
                is pinned to the input's 48px control height (buttons fill it) and the row aligns
                at the top, so the toggle and the field's input box share the same top and bottom
                edges — one clean row. */}
            <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
              <ToggleButtonGroup
                exclusive
                value={commissionType}
                onChange={(_, v) => {
                  if (v) setValue('commission_type', v, { shouldValidate: true })
                }}
                disabled={isLoading}
                aria-label="Tipo de comisión"
                sx={{ flexShrink: 0, height: 48, '& .MuiToggleButton-root': { height: '100%' } }}
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
    </FormSheet>
  )
}
