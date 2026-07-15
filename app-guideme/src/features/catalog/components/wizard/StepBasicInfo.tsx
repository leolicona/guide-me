import { useFormContext } from 'react-hook-form'
import { Stack, TextField, MenuItem } from '@mui/material'
import { CATEGORY_OPTIONS, type ServiceCategory } from '../../categories'
import type { WizardFormData } from './wizardSchema'
import { StepIntro } from './StepIntro'

/** Step 1 — Basic Information (US-A39). Name + Category gate the step; Description is optional. */
export function StepBasicInfo() {
  const {
    register,
    setValue,
    watch,
    formState: { errors },
  } = useFormContext<WizardFormData>()
  const category = watch('category')

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="¿Qué vas a vender?"
        subtitle="Dale un nombre claro y una categoría para que aparezca bien en tu catálogo y en el punto de venta."
      />

      <TextField
        label="Nombre del servicio"
        placeholder="p. ej. Tour Cañón al Amanecer"
        fullWidth
        autoFocus
        error={!!errors.name}
        // Lodging registers the PROPERTY here (its accommodations come in the next step).
        helperText={
          errors.name?.message ??
          (category === 'lodging'
            ? 'El nombre de la propiedad — p. ej. Cabañas Alcatraz, Hotel Centro'
            : undefined)
        }
        {...register('name')}
      />

      <TextField
        select
        label="Categoría"
        fullWidth
        value={category ?? ''}
        onChange={(e) =>
          setValue('category', e.target.value as ServiceCategory, {
            shouldValidate: true,
          })
        }
        error={!!errors.category}
        helperText={errors.category?.message ?? 'Organiza el catálogo y los filtros del POS'}
      >
        {CATEGORY_OPTIONS.map((opt) => (
          <MenuItem key={opt.value} value={opt.value}>
            {opt.label}
          </MenuItem>
        ))}
      </TextField>

      <TextField
        label="Descripción"
        placeholder="Opcional — qué incluye, punto de encuentro, duración…"
        fullWidth
        multiline
        minRows={3}
        error={!!errors.description}
        helperText={errors.description?.message}
        {...register('description')}
      />
    </Stack>
  )
}
