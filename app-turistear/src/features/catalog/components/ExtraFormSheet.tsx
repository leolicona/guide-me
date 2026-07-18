import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { TextField, Stack, InputAdornment } from '@mui/material'
import { FormSheet } from '../../../components'
import { extraFormSchema } from '../schemas'
import type { ExtraFormData } from '../schemas'
import { useAddExtra } from '../hooks/useAddExtra'
import { useUpdateExtra } from '../hooks/useUpdateExtra'
import { amountToCents, centsToAmount } from '../types'
import type { ServiceExtra } from '../types'

interface ExtraFormSheetProps {
  serviceId: string
  /** null → create; an extra → edit (prefilled). */
  extra: ServiceExtra | null
  open: boolean
  onClose: () => void
}

// Add/edit one persisted extra in the canonical FormSheet — the detail-page counterpart of the
// wizard's ExtraDraftSheet (kept separate on purpose: that one is draft/tempId-based).
export function ExtraFormSheet({ serviceId, extra, open, onClose }: ExtraFormSheetProps) {
  const addMutation = useAddExtra(serviceId)
  const updateMutation = useUpdateExtra(serviceId)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ExtraFormData>({
    resolver: zodResolver(extraFormSchema),
    defaultValues: { name: '', price: 0 },
  })

  // Seed in render-phase on the open transition (the "store previous prop" pattern).
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      reset(
        extra
          ? { name: extra.name, price: centsToAmount(extra.price) }
          : { name: '', price: 0 },
      )
    }
  }

  const onSubmit = (data: ExtraFormData) => {
    const payload = { name: data.name.trim(), price: amountToCents(data.price) }
    if (extra) {
      updateMutation.mutate({ extraId: extra.id, data: payload }, { onSuccess: onClose })
    } else {
      addMutation.mutate(payload, { onSuccess: onClose })
    }
  }

  const isLoading = addMutation.isPending || updateMutation.isPending

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title={extra ? 'Editar extra' : 'Nuevo extra'}
      submitLabel={extra ? 'Guardar' : 'Agregar'}
      busy={isLoading}
      onSubmit={handleSubmit(onSubmit)}
    >
      <Stack spacing={2}>
        <TextField
          label="Nombre del extra"
          placeholder="p. ej. Renta de equipo"
          fullWidth
          disabled={isLoading}
          error={!!errors.name}
          helperText={errors.name?.message}
          {...register('name')}
        />
        <TextField
          label="Precio"
          type="number"
          fullWidth
          disabled={isLoading}
          error={!!errors.price}
          helperText={errors.price?.message}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
            },
            htmlInput: { step: 0.01, min: 0, inputMode: 'decimal' },
          }}
          {...register('price', { valueAsNumber: true })}
        />
      </Stack>
    </FormSheet>
  )
}
