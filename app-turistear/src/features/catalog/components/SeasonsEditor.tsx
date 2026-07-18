import { useState } from 'react'
import { Box, Typography, Alert, CircularProgress } from '@mui/material'
import { BottomSheet } from '../../../components'
import { useSeasons } from '../hooks/useSeasons'
import { amountToCents, centsToAmount } from '../types'
import { ServiceError } from '../../../services/authService'
import { SeasonsField, type SeasonRowValue } from './SeasonsField'

interface SeasonsEditorProps {
  serviceId: string
  unitId: string
  unitName: string
  open: boolean
  onClose: () => void
}

// US-A60 — mutation wrapper over the controlled SeasonsField for an EXISTING unit. Seeds the
// core from the server list and translates each add/remove into the create/delete mutation; the
// server's 409 SEASON_OVERLAP is the backstop (the core also guards overlaps client-side).
export function SeasonsEditor({ serviceId, unitId, unitName, open, onClose }: SeasonsEditorProps) {
  const { query, create, remove } = useSeasons(serviceId, unitId, open)
  const [error, setError] = useState<string | null>(null)

  const rows: SeasonRowValue[] = (query.data ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    start_date: s.start_date,
    end_date: s.end_date,
    nightly_rate: centsToAmount(s.nightly_rate),
  }))

  const handleChange = (next: SeasonRowValue[]) => {
    setError(null)
    const added = next.find((r) => !rows.some((v) => v.id === r.id))
    if (added) {
      create.mutate(
        {
          name: added.name,
          start_date: added.start_date,
          end_date: added.end_date,
          nightly_rate: amountToCents(added.nightly_rate),
        },
        {
          onError: (e) =>
            setError(
              e instanceof ServiceError && e.status === 409
                ? 'Esta temporada se traslapa con otra.'
                : 'No se pudo guardar la temporada.',
            ),
        },
      )
      return
    }
    const removed = rows.find((v) => !next.some((r) => r.id === v.id))
    if (removed) {
      remove.mutate(removed.id, {
        onError: () => setError('No se pudo eliminar la temporada.'),
      })
    }
  }

  const busy = create.isPending || remove.isPending

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      header={
        <Typography variant="h6" sx={{ px: 2, pb: 1 }}>
          Temporadas · {unitName}
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
          <SeasonsField value={rows} onChange={handleChange} disabled={busy} />
        )}
      </Box>
    </BottomSheet>
  )
}
