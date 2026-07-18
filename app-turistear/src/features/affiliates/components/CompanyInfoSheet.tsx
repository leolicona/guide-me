import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { TextField, Stack } from '@mui/material'
import { FormSheet } from '../../../components'
import { affiliateCompanySchema, type AffiliateCompanyFormData } from '../schemas'
import { useUpdateAffiliate } from '../hooks/useAffiliates'
import type { AffiliateDetail } from '../types'

interface CompanyInfoSheetProps {
  affiliate: AffiliateDetail
  open: boolean
  onClose: () => void
  /** Fires the page toast after a successful save. */
  onSaved: () => void
}

// Edit the affiliate company profile (name + optional contacts) in the canonical FormSheet.
export function CompanyInfoSheet({ affiliate, open, onClose, onSaved }: CompanyInfoSheetProps) {
  const updateMutation = useUpdateAffiliate(affiliate.id)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<AffiliateCompanyFormData>({
    resolver: zodResolver(affiliateCompanySchema),
    defaultValues: { name: '', contact_email: '', contact_phone: '' },
  })

  // Seed in render-phase on the open transition (the "store previous prop" pattern).
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      reset({
        name: affiliate.name,
        contact_email: affiliate.contact_email ?? '',
        contact_phone: affiliate.contact_phone ?? '',
      })
    }
  }

  const onSubmit = (data: AffiliateCompanyFormData) =>
    updateMutation.mutate(
      {
        name: data.name.trim(),
        contact_email: data.contact_email.trim() || null,
        contact_phone: data.contact_phone.trim() || null,
      },
      {
        onSuccess: () => {
          onSaved()
          onClose()
        },
      },
    )

  const isLoading = updateMutation.isPending

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Información de la empresa"
      submitLabel="Guardar cambios"
      busy={isLoading}
      onSubmit={handleSubmit(onSubmit)}
    >
      <Stack spacing={2}>
        <TextField
          label="Nombre de la empresa"
          required
          fullWidth
          disabled={isLoading}
          error={!!errors.name}
          helperText={errors.name?.message}
          {...register('name')}
        />
        <TextField
          label="Correo de contacto"
          type="email"
          fullWidth
          disabled={isLoading}
          error={!!errors.contact_email}
          helperText={errors.contact_email?.message}
          {...register('contact_email')}
        />
        <TextField
          label="Teléfono de contacto"
          fullWidth
          disabled={isLoading}
          error={!!errors.contact_phone}
          helperText={errors.contact_phone?.message}
          {...register('contact_phone')}
        />
      </Stack>
    </FormSheet>
  )
}
