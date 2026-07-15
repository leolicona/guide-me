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

// Lodging Step 2 (v2) — the unit-types repeater (mirrors the times/extras local-array pattern).
// ≥1 type is required to advance. Each type captures its full field set (incl. inventory count)
// + (optional) seasons/blockouts in the UnitDraftSheet. "Duplicar" clones a draft for the common
// near-identical-type case ("Sencilla" → "Sencilla vista mar").
export function StepUnits({ units, onChange, showUnitsError }: StepUnitsProps) {
  const [editing, setEditing] = useState<UnitDraft | null>(null)
  const [mode, setMode] = useState<'add' | 'edit' | 'duplicate'>('add')
  const [open, setOpen] = useState(false)

  const openAdd = () => {
    setEditing(null)
    setMode('add')
    setOpen(true)
  }
  const openEdit = (draft: UnitDraft) => {
    setEditing(draft)
    setMode('edit')
    setOpen(true)
  }

  const save = (draft: UnitDraft) => {
    const exists = units.some((u) => u.tempId === draft.tempId)
    onChange(exists ? units.map((u) => (u.tempId === draft.tempId ? draft : u)) : [...units, draft])
  }

  // Deep-copy a draft (fresh tempIds throughout) and open it in the sheet WITHOUT appending —
  // save() adds unknown tempIds, so the copy only joins the list when the user confirms, and
  // closing the sheet discards it (no stray "(copia)" rows).
  const duplicate = (u: UnitDraft) => {
    const copy: UnitDraft = {
      ...u,
      tempId: crypto.randomUUID(),
      name: `${u.name} (copia)`,
      seasons: u.seasons.map((s) => ({ ...s, tempId: crypto.randomUUID() })),
      blockouts: u.blockouts.map((b) => ({ ...b, tempId: crypto.randomUUID() })),
    }
    setEditing(copy)
    setMode('duplicate')
    setOpen(true)
  }

  return (
    <Stack spacing={2.5}>
      <StepIntro
        title="Tipos de unidad"
        subtitle="Agrega los alojamientos de esta propiedad — una cabaña única o un tipo de habitación con varias idénticas. Cada uno tendrá su propia tarjeta en el punto de venta."
      />

      <Button
        variant="contained"
        disableElevation
        startIcon={<AddRounded />}
        onClick={openAdd}
        sx={{ alignSelf: 'flex-start' }}
      >
        Agregar tipo
      </Button>

      {showUnitsError && units.length === 0 && (
        <Alert severity="error">Agrega al menos un tipo para continuar.</Alert>
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
            Aún no hay tipos — agrega al menos uno para poder vender.
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
                inventory_count: u.inventory_count,
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
                  <Button size="small" onClick={() => duplicate(u)}>
                    Duplicar
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
        mode={mode}
        onSave={save}
        // Duplicate-name guard: distinct names are what tell the type cards apart in the POS.
        existingNames={units
          .filter((u) => u.tempId !== editing?.tempId)
          .map((u) => u.name)}
      />
    </Stack>
  )
}
