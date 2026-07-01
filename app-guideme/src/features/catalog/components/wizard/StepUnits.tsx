import { useState } from 'react'
import { Stack, Button, Box, Typography, Alert } from '@mui/material'
import AddRounded from '@mui/icons-material/AddRounded'
import { StepIntro } from './StepIntro'
import { UnitRow } from '../UnitRow'
import { fromNightlyRate } from '../../lodging'
import { UnitDraftSheet } from './UnitDraftSheet'
import { amountToCents } from '../../types'
import type { UnitDraft } from '../../hooks/useCreateLodgingFull'

interface StepUnitsProps {
  units: UnitDraft[]
  onChange: (units: UnitDraft[]) => void
  /** True when the user tried to finish with zero units (the ≥1 gate). */
  showUnitsError: boolean
}

// Lodging Step 3 — the units repeater (mirrors the times/extras local-array pattern). ≥1 unit is
// required to finish. Each unit captures its full field set + (optional) seasons/blockouts in the
// UnitDraftSheet.
export function StepUnits({ units, onChange, showUnitsError }: StepUnitsProps) {
  const [editing, setEditing] = useState<UnitDraft | null>(null)
  const [open, setOpen] = useState(false)

  const openAdd = () => {
    setEditing(null)
    setOpen(true)
  }
  const openEdit = (draft: UnitDraft) => {
    setEditing(draft)
    setOpen(true)
  }

  const save = (draft: UnitDraft) => {
    const exists = units.some((u) => u.tempId === draft.tempId)
    onChange(exists ? units.map((u) => (u.tempId === draft.tempId ? draft : u)) : [...units, draft])
  }

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="Unidades"
        subtitle="Agrega cada habitación o cabaña que se puede reservar. Necesitas al menos una para poder vender."
      />

      <Button
        variant="contained"
        disableElevation
        startIcon={<AddRounded />}
        onClick={openAdd}
        sx={{ alignSelf: 'flex-start' }}
      >
        Agregar unidad
      </Button>

      {showUnitsError && units.length === 0 && (
        <Alert severity="error">Agrega al menos una unidad para continuar.</Alert>
      )}

      {units.length === 0 ? (
        <Box
          sx={{
            textAlign: 'center',
            py: 4,
            color: 'text.secondary',
            border: '1px dashed',
            borderColor: 'divider',
            borderRadius: 2,
          }}
        >
          <Typography variant="body2">
            Aún no hay unidades — agrega al menos una para poder vender.
          </Typography>
        </Box>
      ) : (
        <Stack spacing={1.5}>
          {units.map((u) => (
            <UnitRow
              key={u.tempId}
              unit={{
                name: u.name,
                unit_type: u.unit_type,
                beds: u.beds,
                base_occupancy: u.base_occupancy,
                max_capacity: u.max_capacity,
                from_rate: fromNightlyRate(
                  amountToCents(u.base_rate),
                  u.weekend_rate == null ? null : amountToCents(u.weekend_rate),
                ),
                amenities: u.amenities,
              }}
              actions={
                <>
                  <Button size="small" onClick={() => openEdit(u)}>
                    Editar
                  </Button>
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => onChange(units.filter((x) => x.tempId !== u.tempId))}
                  >
                    Eliminar
                  </Button>
                </>
              }
            />
          ))}
        </Stack>
      )}

      <UnitDraftSheet
        open={open}
        onClose={() => setOpen(false)}
        initial={editing}
        onSave={save}
      />
    </Stack>
  )
}
