import { useFormContext } from 'react-hook-form'
import {
  Stack,
  TextField,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Box,
  Typography,
} from '@mui/material'
import type { WizardFormData } from './wizardSchema'
import { StepIntro } from './StepIntro'

/** Step 2 — Pricing & Commissions (US-A40). Numeric keypad on mobile (inputMode), live
 * min ≤ base check, and a segmented %/$ toggle that flips the commission adornment. */
export function StepPricing() {
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
        title="Precio y comisión"
        subtitle="El precio mínimo es el piso al que un vendedor puede llegar con descuento. La comisión es lo que gana quien venda este servicio."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField
          label="Precio base"
          type="number"
          fullWidth
          error={!!errors.base_price}
          helperText={errors.base_price?.message}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
            },
            htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
          }}
          {...register('base_price', { valueAsNumber: true })}
        />
        <TextField
          label="Precio mínimo"
          type="number"
          fullWidth
          error={!!errors.minimum_price}
          helperText={errors.minimum_price?.message ?? 'Debe ser ≤ al precio base'}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
            },
            htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
          }}
          {...register('minimum_price', { valueAsNumber: true })}
        />
      </Stack>

      <Box>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          Comisión del vendedor
        </Typography>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start' }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={commissionType}
            onChange={(_, v) => {
              if (v) setValue('commission_type', v, { shouldValidate: true })
            }}
            aria-label="Tipo de comisión"
            sx={{ flexShrink: 0, mt: 0.5 }}
          >
            <ToggleButton value="percent">%</ToggleButton>
            <ToggleButton value="fixed">$ por lugar</ToggleButton>
          </ToggleButtonGroup>
          <TextField
            label="Comisión"
            type="number"
            fullWidth
            error={!!errors.commission_value}
            helperText={
              errors.commission_value?.message ??
              (commissionType === 'fixed'
                ? 'Monto fijo por lugar vendido — no puede exceder el precio mínimo'
                : 'Porcentaje del precio vendido')
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
                  ? { step: 0.01, min: 0, inputMode: 'decimal' }
                  : { step: 0.01, min: 0, max: 100, inputMode: 'decimal' },
            }}
            {...register('commission_value', { valueAsNumber: true })}
          />
        </Stack>
      </Box>
    </Stack>
  )
}
