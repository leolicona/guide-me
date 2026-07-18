import { useFormContext } from 'react-hook-form'
import { Stack, TextField, MenuItem } from '@mui/material'
import { CATEGORY_OPTIONS, type ServiceCategory } from '../../categories'
import type { WizardFormData } from './wizardSchema'
import { StepIntro } from './StepIntro'

// Category-aware guidance for the Name field — the category is picked first precisely so the
// name input can speak the operator's language (a lodging "service" is a property, a dining one
// is an experience…). Helper copy is a nudge, not a rule; errors always take precedence.
const NAME_GUIDANCE: Record<ServiceCategory, { label: string; placeholder: string; helper?: string }> = {
  // Lodging registers the PROPERTY here (its accommodations come in the next step).
  lodging: {
    label: 'Nombre de la propiedad',
    placeholder: 'p. ej. Cabañas Alcatraz, Hotel Centro',
    helper: 'Los tipos de unidad (habitaciones, cabañas…) se agregan en el siguiente paso.',
  },
  tours: {
    label: 'Nombre del tour',
    placeholder: 'p. ej. Tour Cañón al Amanecer',
  },
  dining: {
    label: 'Nombre de la experiencia',
    placeholder: 'p. ej. Cena de mariscos frente al mar',
  },
  adventure: {
    label: 'Nombre de la actividad',
    placeholder: 'p. ej. Descenso en kayak Río Antiguo',
  },
  culture: {
    label: 'Nombre de la experiencia',
    placeholder: 'p. ej. Recorrido por el Centro Histórico',
  },
}

// Before a category is chosen the name field stays usable with neutral copy.
const DEFAULT_NAME_GUIDANCE = {
  label: 'Nombre del servicio',
  placeholder: 'p. ej. Tour Cañón al Amanecer',
  helper: undefined,
}

/** Step 1 — Basic Information (US-A39). Category first so it contextualizes the Name field;
 * Name + Category gate the step; Description is optional. */
export function StepBasicInfo() {
  const {
    register,
    setValue,
    watch,
    formState: { errors },
  } = useFormContext<WizardFormData>()
  const category = watch('category')
  const nameGuidance = category ? NAME_GUIDANCE[category] : DEFAULT_NAME_GUIDANCE

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="¿Qué vas a vender?"
        subtitle="Elige una categoría y dale un nombre claro para que aparezca bien en tu catálogo y en el punto de venta."
      />

      <TextField
        select
        label="Categoría"
        fullWidth
        autoFocus
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
        label={nameGuidance.label}
        placeholder={nameGuidance.placeholder}
        fullWidth
        error={!!errors.name}
        helperText={errors.name?.message ?? nameGuidance.helper}
        slotProps={{ inputLabel: { shrink: true } }}
        {...register('name')}
      />

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
