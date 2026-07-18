import { useState } from 'react'
import {
  Box,
  Stack,
  Button,
  Typography,
  IconButton,
  Chip,
  CircularProgress,
  Alert,
  Divider,
} from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import EditRounded from '@mui/icons-material/EditRounded'
import DeleteOutlineRounded from '@mui/icons-material/DeleteOutlineRounded'
import { useService } from '../hooks/useService'
import { useRemoveExtra } from '../hooks/useRemoveExtra'
import { formatMoney } from '../types'
import type { ServiceExtra } from '../types'
import { ExtraFormSheet } from './ExtraFormSheet'

interface ExtrasPanelProps {
  serviceId: string
}

// The detail-page extras list (unified sheet pattern): rows are read-only with edit/delete
// actions; add/edit happen in the ExtraFormSheet. Delete stays a direct mutation — it's a
// soft-delete (the row remains visible with the "Eliminado" chip).
export function ExtrasPanel({ serviceId }: ExtrasPanelProps) {
  const { data: service, isLoading, isError } = useService(serviceId)
  const removeMutation = useRemoveExtra(serviceId)
  const [sheet, setSheet] = useState<{ open: boolean; extra: ServiceExtra | null }>({
    open: false,
    extra: null,
  })

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (isError || !service) {
    return <Alert severity="error">No se pudieron cargar los extras. Inténtalo de nuevo.</Alert>
  }

  const extras = service.extras ?? []

  const renderRow = (extra: ServiceExtra) => {
    const inactive = extra.status === 'inactive'

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
              <Chip size="small" variant="outlined" label="Eliminado" sx={{ ml: 1 }} />
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
              aria-label={`Editar ${extra.name}`}
              onClick={() => setSheet({ open: true, extra })}
            >
              <EditRounded fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              color="error"
              aria-label={`Eliminar ${extra.name}`}
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
    <>
      <Stack spacing={2} divider={<Divider flexItem />}>
        {extras.length === 0 ? (
          <Typography color="text.secondary" variant="body2">
            Aún no hay extras.
          </Typography>
        ) : (
          <Stack spacing={1.5} divider={<Divider flexItem />}>
            {extras.map(renderRow)}
          </Stack>
        )}

        <Box>
          <Button
            variant="contained"
            disableElevation
            startIcon={<AddRounded />}
            onClick={() => setSheet({ open: true, extra: null })}
          >
            Agregar extra
          </Button>
        </Box>
      </Stack>

      <ExtraFormSheet
        serviceId={serviceId}
        extra={sheet.extra}
        open={sheet.open}
        onClose={() => setSheet({ open: false, extra: null })}
      />
    </>
  )
}
