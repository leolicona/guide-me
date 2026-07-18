import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { TextField, Stack } from '@mui/material'
import { FormSheet } from '../../../components'
import { editAgentSchema } from '../schemas'
import type { EditAgentFormData } from '../schemas'
import { useUpdateAgent } from '../hooks/useUpdateAgent'
import type { Agent } from '../types'
import { ServiceError } from '../../../services/authService'

interface EditAgentSheetProps {
  agent: Agent | null
  open: boolean
  onClose: () => void
}

export function EditAgentSheet({ agent, open, onClose }: EditAgentSheetProps) {
  const updateMutation = useUpdateAgent()

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<EditAgentFormData>({
    resolver: zodResolver(editAgentSchema),
    defaultValues: { name: '', phone: '' },
  })

  // Prefill whenever a new agent is selected. (No commission here — it is service-based,
  // edited in the catalog: docs/commissions/service-based-commission.spec.md.)
  useEffect(() => {
    if (agent) {
      reset({
        name: agent.name,
        phone: agent.phone ?? '',
      })
    }
  }, [agent, reset])

  const onSubmit = (data: EditAgentFormData) => {
    if (!agent) return
    const phone = data.phone?.trim() ? data.phone.trim() : null
    updateMutation.mutate(
      {
        id: agent.id,
        data: {
          name: data.name.trim(),
          phone,
        },
      },
      {
        onSuccess: onClose,
        onError: (error) => {
          if (error instanceof ServiceError) {
            if (error.status === 404) {
              setError('name', {
                type: 'manual',
                message: 'Este agente ya no existe.',
              })
            } else if (error.status === 400) {
              setError('name', {
                type: 'manual',
                message: 'Revisa los valores e inténtalo de nuevo.',
              })
            }
          }
        },
      },
    )
  }

  const isLoading = updateMutation.isPending

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Editar agente"
      submitLabel="Guardar"
      busy={isLoading}
      onSubmit={handleSubmit(onSubmit)}
    >
      <Stack spacing={2}>
        <TextField
          label="Nombre"
          fullWidth
          disabled={isLoading}
          error={!!errors.name}
          helperText={errors.name?.message}
          {...register('name')}
        />
        <TextField
          label="Teléfono"
          fullWidth
          disabled={isLoading}
          error={!!errors.phone}
          helperText={errors.phone?.message}
          {...register('phone')}
        />
      </Stack>
    </FormSheet>
  )
}
