import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Alert, Box, Button, InputAdornment, Stack, TextField, Typography } from '@mui/material'
import { BottomSheet } from '../../../../components'
import type { ExtraDraft } from './wizardTypes'

// Sheet-local form schema — extras are just a name + price (major units, ≥ 0).
const extraFormSchema = z.object({
  name: z.string().trim().min(1, 'Ingresa el nombre del extra'),
  price: z
    .number({ message: 'Ingresa un precio válido' })
    .min(0, 'El precio no puede ser negativo'),
})

type ExtraFormData = z.infer<typeof extraFormSchema>

const EMPTY: ExtraFormData = { name: '', price: 0 }

interface ExtraDraftSheetProps {
  open: boolean
  onClose: () => void
  /** null → add; a draft → edit. */
  initial: ExtraDraft | null
  onSave: (draft: ExtraDraft) => void
  /** Names of the OTHER extra drafts — powers the non-blocking duplicate-name warning
   * (the API doesn't enforce uniqueness, so this is a nudge, not a gate). */
  existingNames?: string[]
}

// US-A43 (v2) — add/edit one extra inside the wizard via the canonical BottomSheet, mirroring
// UnitDraftSheet: own RHF form, seeded on the open transition, upserted into the parent
// `extras` array on save.
export function ExtraDraftSheet({
  open,
  onClose,
  initial,
  onSave,
  existingNames = [],
}: ExtraDraftSheetProps) {
  const { register, reset, watch, handleSubmit, formState } = useForm<ExtraFormData>({
    resolver: zodResolver(extraFormSchema),
    defaultValues: EMPTY,
  })
  const { errors } = formState

  // Non-blocking duplicate-name nudge (case-insensitive, trimmed).
  const draftName = watch('name')
  const isDuplicateName =
    !!draftName?.trim() &&
    existingNames.some((n) => n.trim().toLowerCase() === draftName.trim().toLowerCase())

  // Seed in render-phase on the open transition (the "store previous prop" pattern used across
  // the app — UnitDraftSheet/PosDatePickerSheet — so the reset lands before paint).
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) reset(initial ? { name: initial.name, price: initial.price } : EMPTY)
  }

  const submit = handleSubmit((form) => {
    onSave({
      tempId: initial?.tempId ?? crypto.randomUUID(),
      name: form.name.trim(),
      price: form.price,
    })
    onClose()
  })

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      header={
        <Typography variant="h6" sx={{ px: 2, pb: 1 }}>
          {initial ? 'Editar extra' : 'Nuevo extra'}
        </Typography>
      }
      footer={
        <Box sx={{ p: 2 }}>
          <Button fullWidth variant="contained" disableElevation onClick={submit}>
            {initial ? 'Guardar' : 'Agregar'}
          </Button>
        </Box>
      }
    >
      <Box sx={{ px: 2, pb: 2 }}>
        {isDuplicateName && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            Ya existe un extra con este nombre — usa nombres distintos para diferenciarlos en el
            punto de venta.
          </Alert>
        )}
        <Stack spacing={2}>
          <TextField
            label="Nombre del extra"
            placeholder="p. ej. Renta de equipo"
            fullWidth
            error={!!errors.name}
            helperText={errors.name?.message}
            {...register('name')}
          />
          <TextField
            label="Precio"
            type="number"
            fullWidth
            error={!!errors.price}
            helperText={errors.price?.message}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submit()
              }
            }}
            slotProps={{
              input: {
                startAdornment: <InputAdornment position="start">$</InputAdornment>,
              },
              htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
            }}
            {...register('price', { valueAsNumber: true })}
          />
        </Stack>
      </Box>
    </BottomSheet>
  )
}
