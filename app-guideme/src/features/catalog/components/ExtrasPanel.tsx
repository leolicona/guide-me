import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  Box,
  Stack,
  TextField,
  Button,
  Typography,
  IconButton,
  Chip,
  InputAdornment,
  CircularProgress,
  Alert,
  Divider,
} from '@mui/material'
import EditRounded from '@mui/icons-material/EditRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import { extraFormSchema } from '../schemas'
import type { ExtraFormData } from '../schemas'
import { useService } from '../hooks/useService'
import { useAddExtra } from '../hooks/useAddExtra'
import { useUpdateExtra } from '../hooks/useUpdateExtra'
import { useRemoveExtra } from '../hooks/useRemoveExtra'
import { amountToCents, centsToAmount, formatMoney } from '../types'
import type { ServiceExtra } from '../types'

// Inline name + price form, reused for both add and edit.
function ExtraForm({
  defaultValues,
  submitLabel,
  isLoading,
  onSubmit,
  onCancel,
}: {
  defaultValues: ExtraFormData
  submitLabel: string
  isLoading: boolean
  onSubmit: (data: ExtraFormData) => void
  onCancel?: () => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ExtraFormData>({
    resolver: zodResolver(extraFormSchema),
    defaultValues,
  })

  return (
    <Box
      component="form"
      onSubmit={handleSubmit(onSubmit)}
      noValidate
      sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 1.5, alignItems: 'flex-start' }}
    >
      <TextField
        label="Name"
        size="small"
        fullWidth
        disabled={isLoading}
        error={!!errors.name}
        helperText={errors.name?.message}
        {...register('name')}
      />
      <TextField
        label="Price"
        type="number"
        size="small"
        disabled={isLoading}
        error={!!errors.price}
        helperText={errors.price?.message}
        slotProps={{
          input: {
            startAdornment: <InputAdornment position="start">$</InputAdornment>,
          },
          htmlInput: { step: 0.01, min: 0 },
        }}
        {...register('price', { valueAsNumber: true })}
      />
      <Stack direction="row" spacing={1} sx={{ pt: 0.5 }}>
        <Button type="submit" variant="contained" disableElevation size="small" disabled={isLoading}>
          {isLoading ? <CircularProgress size={18} color="inherit" /> : submitLabel}
        </Button>
        {onCancel && (
          <Button size="small" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
        )}
      </Stack>
    </Box>
  )
}

interface ExtrasPanelProps {
  serviceId: string
}

export function ExtrasPanel({ serviceId }: ExtrasPanelProps) {
  const { data: service, isLoading, isError } = useService(serviceId)
  const addMutation = useAddExtra(serviceId)
  const updateMutation = useUpdateExtra(serviceId)
  const removeMutation = useRemoveExtra(serviceId)
  const [editingId, setEditingId] = useState<string | null>(null)
  // Bumped on a successful add so the add form remounts blank.
  const [addResetKey, setAddResetKey] = useState(0)

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (isError || !service) {
    return <Alert severity="error">Couldn't load extras. Please try again.</Alert>
  }

  const extras = service.extras ?? []

  const renderRow = (extra: ServiceExtra) => {
    const inactive = extra.status === 'inactive'

    if (editingId === extra.id) {
      return (
        <ExtraForm
          key={extra.id}
          defaultValues={{ name: extra.name, price: centsToAmount(extra.price) }}
          submitLabel="Save"
          isLoading={updateMutation.isPending}
          onCancel={() => setEditingId(null)}
          onSubmit={(data) =>
            updateMutation.mutate(
              {
                extraId: extra.id,
                data: { name: data.name.trim(), price: amountToCents(data.price) },
              },
              { onSuccess: () => setEditingId(null) },
            )
          }
        />
      )
    }

    return (
      <Box
        key={extra.id}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          opacity: inactive ? 0.5 : 1,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 500 }} noWrap>
            {extra.name}
            {inactive && (
              <Chip size="small" variant="outlined" label="Removed" sx={{ ml: 1 }} />
            )}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {formatMoney(extra.price)}
          </Typography>
        </Box>
        {!inactive && (
          <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
            <IconButton
              size="small"
              aria-label={`Edit ${extra.name}`}
              onClick={() => setEditingId(extra.id)}
            >
              <EditRounded fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              color="error"
              aria-label={`Remove ${extra.name}`}
              disabled={removeMutation.isPending}
              onClick={() => removeMutation.mutate(extra.id)}
            >
              <DeleteOutlineRounded fontSize="small" />
            </IconButton>
          </Stack>
        )}
      </Box>
    )
  }

  return (
    <Stack spacing={2} divider={<Divider flexItem />}>
      {extras.length === 0 ? (
        <Typography color="text.secondary" variant="body2">
          No extras yet.
        </Typography>
      ) : (
        <Stack spacing={1.5} divider={<Divider flexItem />}>
          {extras.map(renderRow)}
        </Stack>
      )}

      <Box>
        <Typography variant="overline" color="text.secondary">
          Add extra
        </Typography>
        <ExtraForm
          key={addResetKey}
          defaultValues={{ name: '', price: 0 }}
          submitLabel="Add"
          isLoading={addMutation.isPending}
          onSubmit={(data) =>
            addMutation.mutate(
              { name: data.name.trim(), price: amountToCents(data.price) },
              { onSuccess: () => setAddResetKey((k) => k + 1) },
            )
          }
        />
      </Box>
    </Stack>
  )
}
