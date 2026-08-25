import { useFormContext } from 'react-hook-form'
import { Stack, TextField, MenuItem, Alert, Button } from '@mui/material'
import { CATEGORY_OPTIONS, inventoryModel, type ServiceCategory } from '../../categories'
import type { Service } from '../../types'
import type { WizardFormData } from './wizardSchema'
import { StepIntro } from './StepIntro'
import { PropertyPicker, NEW_PROPERTY, type PropertyChoice } from './PropertyPicker'

// Category-aware guidance for the Name field — the category is picked first precisely so the
// name input can speak the operator's language (a lodging "service" is a property, a dining one
// is an experience…). Helper copy is a nudge, not a rule; errors always take precedence.
const NAME_GUIDANCE: Record<ServiceCategory, { label: string; placeholder: string; helper?: string }> = {
  // Lodging registers the PROPERTY here (its units come in the next step). US-A91 — the copy
  // names the mistake before it happens: the field is the building, not one rentable space.
  lodging: {
    label: 'Nombre de la propiedad',
    placeholder: 'p. ej. Cabañas Imperial, Hotel Centro',
    helper: 'Es el lugar completo, no una cabaña suelta. En el siguiente paso agregas las que rentas.',
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

interface StepBasicInfoProps {
  /** The org's ACTIVE lodging properties (US-A91 D12). Empty ⇒ no picker is rendered. */
  properties: Service[]
  choice: PropertyChoice
  onChoiceChange: (choice: PropertyChoice) => void
  /** True once the user tried to advance without choosing. */
  showChoiceError: boolean
}

/** Step 1 — Basic Information (US-A39). Category first so it contextualizes everything below;
 * for a unit-based category with properties on file, the PropertyPicker (US-A91) decides whether
 * the rest of the wizard creates a property or attaches a unit to one. Name + Category gate the
 * step in create mode; in attach mode the chosen property does. Description is optional. */
export function StepBasicInfo({
  properties,
  choice,
  onChoiceChange,
  showChoiceError,
}: StepBasicInfoProps) {
  const {
    register,
    setValue,
    watch,
    formState: { errors },
  } = useFormContext<WizardFormData>()
  const category = watch('category')
  const nameGuidance = category ? NAME_GUIDANCE[category] : DEFAULT_NAME_GUIDANCE

  // The picker only exists where there is a container to choose (D1/D12): a unit-based category
  // AND at least one active property. An org registering its first property sees today's step.
  const showPicker = inventoryModel(category) === 'units' && properties.length > 0
  // Identity fields belong to a property being CREATED — hidden once an existing one is chosen.
  const showIdentity = !showPicker || choice === NEW_PROPERTY
  const chosen = properties.find((p) => p.id === choice) ?? null

  // D13 — a soft nudge, never a gate: a new-property name that prefixes an existing one is
  // usually someone who meant to add to that property. The trailing-number heuristic is
  // deliberately absent ("Villas 3 Marías" is a legitimate name).
  const typed = (watch('name') ?? '').trim().toLowerCase()
  const prefixMatch =
    showPicker && choice === NEW_PROPERTY && typed.length >= 3
      ? properties.find(
          (p) => p.name.toLowerCase().startsWith(typed) && p.name.toLowerCase() !== typed,
        )
      : undefined

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

      {showPicker && (
        <PropertyPicker
          properties={properties}
          value={choice}
          onChange={onChoiceChange}
          error={showChoiceError}
        />
      )}

      {showIdentity && (
        <>
          {prefixMatch && (
            <Alert
              severity="info"
              action={
                <Button
                  size="small"
                  color="inherit"
                  onClick={() => onChoiceChange(prefixMatch.id)}
                >
                  Agregar ahí
                </Button>
              }
            >
              ¿Te refieres a «{prefixMatch.name}»? Ya está en tu catálogo.
            </Alert>
          )}
          <TextField
            label={showPicker ? 'Nombre de la propiedad nueva' : nameGuidance.label}
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
        </>
      )}

      {chosen && (
        <Alert severity="success" icon={false}>
          La unidad se agregará a <strong>{chosen.name}</strong>.
        </Alert>
      )}
    </Stack>
  )
}
