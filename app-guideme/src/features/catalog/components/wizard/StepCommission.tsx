import { useFormContext } from 'react-hook-form'
import {
  Stack,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import { StepIntro } from './StepIntro'
import type { WizardFormData } from './wizardSchema'

// Lodging Step 2 — the service-level commission ANY seller earns for this property (US-A12). One
// rate for the whole property; per-unit rates are out of scope. Mirrors the catalog form's
// commission control (percent ↔ $ per stay).
export function StepCommission() {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<WizardFormData>()
  const commissionType = watch('commission_type')

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="Comisión"
        subtitle="La comisión que gana quien venda este hospedaje. Aplica a toda la propiedad."
      />
      <Stack direction="row" spacing={2}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={commissionType}
          onChange={(_, v) => {
            if (v) setValue('commission_type', v, { shouldValidate: true })
          }}
          aria-label="Tipo de comisión"
          sx={{ alignSelf: 'flex-start', mt: 1 }}
        >
          <ToggleButton value="percent">%</ToggleButton>
          <ToggleButton value="fixed">$ por estancia</ToggleButton>
        </ToggleButtonGroup>
        <TextField
          label="Comisión"
          type="number"
          fullWidth
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
            htmlInput:
              commissionType === 'fixed'
                ? { step: 0.01, min: 0, inputMode: 'decimal' }
                : { step: 0.01, min: 0, max: 100, inputMode: 'decimal' },
          }}
          {...register('commission_value', { valueAsNumber: true })}
        />
      </Stack>
    </Stack>
  )
}
