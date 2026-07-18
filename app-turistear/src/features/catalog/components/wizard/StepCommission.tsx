import { useFormContext } from 'react-hook-form'
import {
  Stack,
  TextField,
  Typography,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
} from '@mui/material'
import { StepIntro } from './StepIntro'
import { amountToCents, formatMoney } from '../../types'
import type { UnitDraft } from '../../hooks/useCreateLodgingFull'
import type { WizardFormData } from './wizardSchema'

// The nightly-rate context line derived from the type drafts (major-unit values). The commission
// step CLOSES the lodging track precisely so this anchor exists — a fixed $-per-stay commission
// set blind is how nonsense values happen (lodging has no backend cap, unlike tours).
const rateContext = (units: UnitDraft[]): string | null => {
  const rates = units.map((u) => u.base_rate).filter((r) => r > 0)
  if (rates.length === 0) return null
  const min = Math.min(...rates)
  const max = Math.max(...rates)
  return min === max
    ? `Tus tipos cuestan ${formatMoney(amountToCents(min))} por noche.`
    : `Tus tipos van de ${formatMoney(amountToCents(min))} a ${formatMoney(amountToCents(max))} por noche.`
}

// Lodging Step 3 — the service-level commission ANY seller earns for this property (US-A12),
// decided WITH the nightly rates from Step 2 in view. One base rate for the whole property; each
// type can override it individually (the Heredar/%/$ control on the type form).
export function StepCommission({ units }: { units: UnitDraft[] }) {
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = useFormContext<WizardFormData>()
  const commissionType = watch('commission_type')
  const context = rateContext(units)

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="Comisión"
        subtitle={
          context
            ? `${context} Define lo que gana quien venda este hospedaje.`
            : 'La comisión que gana quien venda este hospedaje. Aplica a toda la propiedad.'
        }
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
      <Typography variant="caption" color="text.secondary">
        Es la comisión base de la propiedad — puedes ajustar la de cada tipo al editarlo.
      </Typography>
    </Stack>
  )
}
