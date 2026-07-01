import { Controller, useFormContext } from 'react-hook-form'
import {
  Stack,
  TextField,
  InputAdornment,
  Typography,
  Box,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import type { UnitFormData } from '../schemas'
import { AmenityPicker } from './AmenityPicker'

// Cluster overline header — visually separates the field groups (Identidad / Capacidad / …).
function GroupLabel({ children }: { children: string }) {
  return (
    <Typography
      variant="overline"
      color="text.secondary"
      sx={{ letterSpacing: '0.06em', fontWeight: 700, display: 'block', mt: 1 }}
    >
      {children}
    </Typography>
  )
}

interface UnitFieldsProps {
  disabled?: boolean
  /** Shown under the "Heredar" option, e.g. "Hereda la comisión del servicio (10%)". */
  inheritedCommissionLabel?: string
}

// The shared unit field group (bound to unitFormSchema). Uses the surrounding RHF context, so it
// drops into BOTH the detail-page UnitFormDialog and the wizard's UnitDraftSheet — one definition,
// no drift. Money fields are entered as major-unit decimals; the parent converts on submit.
export function UnitFields({ disabled, inheritedCommissionLabel }: UnitFieldsProps) {
  const {
    register,
    control,
    watch,
    formState: { errors },
  } = useFormContext<UnitFormData>()
  const commissionType = watch('commission_type')

  // `nullable` money fields (weekend_rate) coerce an empty field to null; required ones to a number
  // (NaN when empty, which the schema rejects with a clear message).
  const money = (
    name: keyof UnitFormData,
    label: string,
    helper?: string,
    nullable = false,
  ) => (
    <TextField
      label={label}
      type="number"
      fullWidth
      disabled={disabled}
      error={!!errors[name]}
      helperText={errors[name]?.message ?? helper}
      slotProps={{
        input: { startAdornment: <InputAdornment position="start">$</InputAdornment> },
        htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
      }}
      {...register(
        name,
        nullable
          ? {
              setValueAs: (v) => {
                if (v === '' || v === null || v === undefined) return null
                const n = Number(v)
                return Number.isNaN(n) ? null : n
              },
            }
          : { valueAsNumber: true },
      )}
    />
  )

  const count = (name: keyof UnitFormData, label: string) => (
    <TextField
      label={label}
      type="number"
      fullWidth
      disabled={disabled}
      error={!!errors[name]}
      helperText={errors[name]?.message}
      slotProps={{ htmlInput: { step: 1, min: 1, inputMode: 'numeric' } }}
      {...register(name, { valueAsNumber: true })}
    />
  )

  return (
    <Stack spacing={2}>
      <GroupLabel>Identidad</GroupLabel>
      <TextField
        label="Nombre"
        fullWidth
        disabled={disabled}
        error={!!errors.name}
        helperText={errors.name?.message ?? 'Ej. "Cabaña 1", "Suite Vista"'}
        {...register('name')}
      />
      <TextField
        label="Tipo (opcional)"
        fullWidth
        disabled={disabled}
        error={!!errors.unit_type}
        helperText={errors.unit_type?.message ?? 'Ej. cabaña, suite, habitación'}
        {...register('unit_type')}
      />

      <GroupLabel>Capacidad</GroupLabel>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {count('beds', 'Camas')}
        {count('base_occupancy', 'Ocupación base')}
        {count('max_capacity', 'Capacidad máxima')}
      </Stack>

      <GroupLabel>Tarifas</GroupLabel>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {money('base_rate', 'Tarifa base / noche')}
        {money('weekend_rate', 'Tarifa fin de semana', 'Opcional — usa la base si se deja vacía', true)}
      </Stack>
      {money('extra_person_fee', 'Costo por persona extra / noche', 'Por persona arriba de la ocupación base')}

      <GroupLabel>Reglas</GroupLabel>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {count('min_nights', 'Estancia mínima (noches)')}
        <TextField
          label="Check-in"
          type="time"
          fullWidth
          disabled={disabled}
          error={!!errors.checkin_time}
          helperText={errors.checkin_time?.message}
          {...register('checkin_time')}
        />
        <TextField
          label="Check-out"
          type="time"
          fullWidth
          disabled={disabled}
          error={!!errors.checkout_time}
          helperText={errors.checkout_time?.message}
          {...register('checkout_time')}
        />
      </Stack>

      <GroupLabel>Comisión</GroupLabel>
      <Controller
        name="commission_type"
        control={control}
        render={({ field }) => (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={field.value}
            onChange={(_, v) => {
              if (v) field.onChange(v)
            }}
            disabled={disabled}
            aria-label="Tipo de comisión de la unidad"
            sx={{ alignSelf: 'flex-start' }}
          >
            <ToggleButton value="inherit">Heredar</ToggleButton>
            <ToggleButton value="percent">%</ToggleButton>
            <ToggleButton value="fixed">$ fijo</ToggleButton>
          </ToggleButtonGroup>
        )}
      />
      {commissionType === 'inherit' ? (
        <Typography variant="caption" color="text.secondary">
          {inheritedCommissionLabel ?? 'Usa la comisión del servicio (la regla general).'}
        </Typography>
      ) : (
        <TextField
          label={commissionType === 'fixed' ? 'Comisión por estancia' : 'Comisión'}
          type="number"
          fullWidth
          disabled={disabled}
          error={!!errors.commission_value}
          helperText={
            errors.commission_value?.message ??
            (commissionType === 'fixed'
              ? 'Monto fijo por estancia vendida'
              : 'Porcentaje del total de la estancia')
          }
          slotProps={{
            input:
              commissionType === 'fixed'
                ? { startAdornment: <InputAdornment position="start">$</InputAdornment> }
                : { endAdornment: <InputAdornment position="end">%</InputAdornment> },
            htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
          }}
          {...register('commission_value', {
            setValueAs: (v) => {
              if (v === '' || v === null || v === undefined) return null
              const n = Number(v)
              return Number.isNaN(n) ? null : n
            },
          })}
        />
      )}

      <Box>
        <GroupLabel>Amenidades</GroupLabel>
        <Controller
          name="amenities"
          control={control}
          render={({ field }) => (
            <AmenityPicker
              value={field.value ?? []}
              onChange={field.onChange}
              disabled={disabled}
            />
          )}
        />
      </Box>
    </Stack>
  )
}
