import { useState } from 'react'
import { Box, Typography, Alert, CircularProgress } from '@mui/material'
import { BottomSheet } from '../../../components'
import { useBlockouts } from '../hooks/useBlockouts'
import { BlockoutsField, type BlockoutRowValue } from './BlockoutsField'

interface BlockoutsEditorProps {
  serviceId: string
  unitId: string
  unitName: string
  open: boolean
  onClose: () => void
}

// US-A61 — mutation wrapper over the controlled BlockoutsField for an EXISTING unit.
export function BlockoutsEditor({ serviceId, unitId, unitName, open, onClose }: BlockoutsEditorProps) {
  const { query, create, remove } = useBlockouts(serviceId, unitId, open)
  const [error, setError] = useState<string | null>(null)

  const rows: BlockoutRowValue[] = (query.data ?? []).map((b) => ({
    id: b.id,
    start_date: b.start_date,
    end_date: b.end_date,
    reason: b.reason ?? undefined,
  }))

  const handleChange = (next: BlockoutRowValue[]) => {
    setError(null)
    const added = next.find((r) => !rows.some((v) => v.id === r.id))
    if (added) {
      create.mutate(
        { start_date: added.start_date, end_date: added.end_date, reason: added.reason ?? null },
        { onError: () => setError('No se pudo guardar el bloqueo.') },
      )
      return
    }
    const removed = rows.find((v) => !next.some((r) => r.id === v.id))
    if (removed) {
      remove.mutate(removed.id, { onError: () => setError('No se pudo eliminar el bloqueo.') })
    }
  }

  const busy = create.isPending || remove.isPending

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      header={
        <Typography variant="h6" sx={{ px: 2, pb: 1 }}>
          Bloqueos · {unitName}
        </Typography>
      }
    >
      <Box sx={{ px: 2, pb: 2 }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {query.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <BlockoutsField value={rows} onChange={handleChange} disabled={busy} />
        )}
      </Box>
    </BottomSheet>
  )
}
